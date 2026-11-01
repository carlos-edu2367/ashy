/**
 * Phase 10.5 — `CascadeSession`: the classic Live Mode pipeline (spec §5.3, §8.5).
 *
 *   CallEngine (VAD → WAV → host STT) → submitTranscribedTurn
 *     → host `call:cascadeTurn` (turn orchestrator: ANY text LLM with Ashy's full persona, memory,
 *       affect and tools; nothing persisted there)
 *     → streamed `call:cascade` deltas → boosted phrase chunker → host TTS per phrase
 *       (`call:synthesize`, routed host-side to llama.cpp /tts | Kokoro | OpenAI | ElevenLabs)
 *     → bounded-parallel synthesis, audio emitted strictly in phrase order.
 *
 * For the CallEngine it is just another `VoiceSession` (same events as the hybrid session).
 * `response_started` is emitted on the first host event of the turn (never synchronously inside
 * `submitTranscribedTurn`, so the engine installs its ledger first). `cancelResponse` (barge-in /
 * new turn) aborts the host LLM turn and drops every queued or in-flight phrase; late deltas and late
 * audio of a cancelled turn are ignored. Persistence stays with the engine's `call:recordTurn`
 * (only what was actually heard), so a cascade turn is never stored twice.
 *
 * Tools run INSIDE the host turn (orchestrator tool loop through the agency gatekeeper), so the
 * engine's two-step tool flow is not used: `caps.toolCalls` is false and `toolChoice` is only
 * forwarded as the host's tool policy.
 */
import type { CallCascadeEvent, CallSynthesizeResult } from '@ashy/shared'
import { cleanSpeakableMarkdown } from '../markdown-segmenter'
import { createTtsChunker, type TtsChunker } from '../tts-chunker'
import { speakableStreamText } from './llamacpp-hybrid-session'
import { base64ToInt16 } from './pcm-utils'
import {
  createDefaultCallTimers,
  createEmitter,
  type CallTimers,
  type VoiceSession,
  type VoiceSessionCancelReason,
  type VoiceSessionCapabilities,
  type VoiceSessionEventMap,
  type VoiceSessionInit,
  type VoiceSubmitOptions,
  type VoiceToolChoice,
  type VoiceToolResult,
  type VoiceTranscribedTurn,
} from './types'

export interface CascadeTurnRequest {
  turnId: string
  text: string
  context?: string
  toolChoice?: VoiceToolChoice
  injectReason?: 'approval' | 'initiative'
}

export type CascadeHostEvent = { turnId: string } & CallCascadeEvent

export interface CascadeSessionOptions {
  /** Starts the host LLM turn (`call:cascadeTurn`). Rejection = the turn failed. */
  startTurn(request: CascadeTurnRequest): Promise<unknown>
  /** Aborts the host LLM turn (`call:cascadeAbort`). Best effort. */
  abortTurn(turnId: string): Promise<unknown> | void
  /** Host TTS of one phrase (`call:synthesize`). */
  synthesize(text: string): Promise<CallSynthesizeResult>
  /** Subscribes to the host's `call:cascade` events of this call. Returns the unsubscribe. */
  subscribe(listener: (event: CascadeHostEvent) => void): () => void
  /** Optional warm-up at connect (e.g. start the managed llama-server for /tts). Errors fail connect. */
  prepare?(): Promise<void>
  /** Prefix of the generated turn ids (default 'cascade'). */
  turnIdPrefix?: string
  /** Max TTS requests in flight (default 2, clamped 1–4). */
  maxParallelTts?: number
  /** No host event for this long after the turn started → the turn fails (default 45 s). */
  turnTimeoutMs?: number
  timers?: CallTimers
  chunker?: { boostChunks?: number; minBoostWords?: number; maxBoostWords?: number; maxChunkChars?: number }
  /** Reported in caps (llama.cpp /tts with a reference voice). */
  speakerReference?: boolean
}

export interface CascadeSession extends VoiceSession {
  submitTranscribedTurn(turn: VoiceTranscribedTurn): void
  submitUserText(text: string, contextOrOptions?: string | VoiceSubmitOptions, options?: VoiceSubmitOptions): void
  speakText(text: string): void
  readonly connected: boolean
  /** Turn id of the response in progress (null when idle). */
  readonly activeTurnId: string | null
}

const DEFAULT_OUTPUT_RATE = 24000
const DEFAULT_TURN_TIMEOUT_MS = 45_000
const ACT_MARKER_RE = /<\|ACT[\s\S]*?(?:\|>|\}>)/g
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu

function speakablePhrase(chunk: string): string {
  return cleanSpeakableMarkdown(chunk.replace(EMOJI_RE, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\s+([!?.,;:…])/g, '$1')
    .trim()
}

interface PhraseJob {
  index: number
  text: string
  /** ACT markers seen before this phrase (re-emitted with it, so the engine fires them in sync). */
  prefix: string
  state: 'queued' | 'inflight' | 'ready' | 'failed'
  pcm: Int16Array | null
  sampleRate: number
}

interface CascadeResponse {
  turnId: string
  /** Host turn (false for `speakText`). */
  remote: boolean
  started: boolean
  /** Raw streamed text (markers included). */
  text: string
  /**
   * What was actually handed to playback: phrases whose audio was emitted (+ their markers). This —
   * not the streamed text, which runs ahead of the audio — is what the engine sees as the response
   * text, so the ledger's spoken/interrupted slice is truthful and a phrase whose TTS failed is
   * never recorded as heard.
   */
  spoken: string
  pendingMarkers: string
  markersSeen: number
  fedChars: number
  chunker: TtsChunker
  jobs: PhraseJob[]
  nextEmit: number
  inflight: number
  audioMs: number
  textDone: boolean
  finished: boolean
  timer: unknown
}

export function createCascadeSession(options: CascadeSessionOptions): CascadeSession {
  const maxParallel = Math.max(1, Math.min(4, Math.round(options.maxParallelTts ?? 2)))
  const timers = options.timers ?? createDefaultCallTimers()
  const turnTimeoutMs = Math.max(1000, options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS)
  const prefix = (options.turnIdPrefix ?? 'cascade').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60) || 'cascade'
  const emitter = createEmitter<VoiceSessionEventMap>()
  let outputRate = DEFAULT_OUTPUT_RATE
  const caps: VoiceSessionCapabilities = {
    serverTurnDetection: false,
    messageTruncation: false,
    mutableInstructions: false,
    contextInjection: 'input_text_item',
    userTranscription: false,
    toolCalls: false,
    imageInput: false,
    speakerReference: options.speakerReference === true,
    voices: [],
    inputSampleRate: 16000,
    // The host orchestrator keeps the history (persisted voice rows): never rotate this session.
    managesContext: true,
    get outputSampleRate() {
      return outputRate
    },
  }

  let connected = false
  let closed = false
  let seq = 0
  let current: CascadeResponse | null = null
  const byId = new Map<string, CascadeResponse>()
  let unsubscribe: (() => void) | null = null

  function newResponse(turnId: string, remote: boolean): CascadeResponse {
    return {
      turnId,
      remote,
      started: false,
      text: '',
      spoken: '',
      pendingMarkers: '',
      markersSeen: 0,
      fedChars: 0,
      chunker: createTtsChunker(options.chunker ?? {}),
      jobs: [],
      nextEmit: 0,
      inflight: 0,
      audioMs: 0,
      textDone: false,
      finished: false,
      timer: null,
    }
  }

  function clearTimer(r: CascadeResponse): void {
    if (r.timer !== null) {
      timers.clearTimeout(r.timer)
      r.timer = null
    }
  }

  function armTimer(r: CascadeResponse): void {
    clearTimer(r)
    if (!r.remote || r.textDone) return
    r.timer = timers.setTimeout(() => {
      r.timer = null
      if (r.finished || r.textDone) return
      try {
        void Promise.resolve(options.abortTurn(r.turnId)).catch(() => {})
      } catch {
        // ignore
      }
      onTurnError(r, `cascade turn timed out (${turnTimeoutMs} ms without output)`)
    }, turnTimeoutMs)
  }

  function ensureStarted(r: CascadeResponse): void {
    if (r.started) return
    r.started = true
    emitter.emit('response_started', { responseId: r.turnId })
  }

  function finish(r: CascadeResponse, cancelled: boolean, reason?: VoiceSessionCancelReason, detail?: string): void {
    if (r.finished) return
    r.finished = true
    clearTimer(r)
    byId.delete(r.turnId)
    if (current === r) current = null
    // A turn cancelled before it produced anything never surfaced: nothing to tell the engine.
    if (!r.started) return
    emitter.emit('response_done', {
      responseId: r.turnId,
      text: r.spoken,
      audioMs: r.audioMs,
      cancelled,
      ...(cancelled && reason ? { cancelReason: reason } : {}),
      ...(detail ? { detail } : {}),
    })
  }

  function maybeFinish(r: CascadeResponse): void {
    if (!r.finished && r.textDone && r.nextEmit >= r.jobs.length && r.inflight === 0) finish(r, false)
  }

  function drainOrdered(r: CascadeResponse): void {
    while (!r.finished && r.nextEmit < r.jobs.length) {
      const job = r.jobs[r.nextEmit]!
      if (job.state === 'ready') {
        const pcm = job.pcm
        job.pcm = null
        r.nextEmit += 1
        if (pcm && pcm.length > 0) {
          const piece = `${job.prefix}${job.text}`
          const delta = r.spoken ? ` ${piece}` : piece
          r.spoken += delta
          emitter.emit('response_text', { responseId: r.turnId, delta, text: r.spoken })
          outputRate = job.sampleRate
          r.audioMs += (pcm.length / job.sampleRate) * 1000
          emitter.emit('response_audio', { responseId: r.turnId, pcm, sampleRate: job.sampleRate })
        }
      } else if (job.state === 'failed') {
        r.nextEmit += 1
      } else {
        break
      }
    }
    maybeFinish(r)
  }

  function pump(r: CascadeResponse): void {
    for (const job of r.jobs) {
      if (r.finished || closed || r.inflight >= maxParallel) return
      if (job.state !== 'queued') continue
      job.state = 'inflight'
      r.inflight += 1
      let promise: Promise<CallSynthesizeResult>
      try {
        promise = Promise.resolve(options.synthesize(job.text))
      } catch (err) {
        promise = Promise.reject(err)
      }
      promise.then(
        (res) => {
          r.inflight -= 1
          if (r.finished || closed) return // cancelled meanwhile: drop late audio
          job.pcm = res && typeof res.pcmBase64 === 'string' ? base64ToInt16(res.pcmBase64) : new Int16Array(0)
          job.sampleRate = res && res.sampleRate > 0 ? res.sampleRate : DEFAULT_OUTPUT_RATE
          job.state = 'ready'
          drainOrdered(r)
          pump(r)
        },
        (err: unknown) => {
          r.inflight -= 1
          if (r.finished || closed) return
          job.state = 'failed'
          emitter.emit('error', {
            message: `tts failed for phrase ${job.index}: ${err instanceof Error ? err.message : String(err)}`,
            code: 'tts_failed',
            fatal: false,
          })
          drainOrdered(r)
          pump(r)
        },
      )
    }
  }

  function enqueuePhrases(r: CascadeResponse, chunks: string[]): void {
    for (const chunk of chunks) {
      const text = speakablePhrase(chunk)
      if (!/[\p{L}\p{N}]/u.test(text)) continue
      r.jobs.push({ index: r.jobs.length, text, prefix: r.pendingMarkers, state: 'queued', pcm: null, sampleRate: DEFAULT_OUTPUT_RATE })
      r.pendingMarkers = ''
    }
    pump(r)
  }

  function feedText(r: CascadeResponse): void {
    const markers = r.text.match(ACT_MARKER_RE) ?? []
    for (let i = r.markersSeen; i < markers.length; i++) r.pendingMarkers += markers[i]
    r.markersSeen = markers.length
    const speakable = speakableStreamText(r.text)
    if (speakable.length <= r.fedChars) return
    const fresh = speakable.slice(r.fedChars)
    r.fedChars = speakable.length
    enqueuePhrases(r, r.chunker.write(fresh))
  }

  function completeText(r: CascadeResponse): void {
    if (r.textDone || r.finished) return
    feedText(r)
    r.textDone = true
    clearTimer(r)
    enqueuePhrases(r, r.chunker.flush())
    drainOrdered(r)
  }

  function onTurnError(r: CascadeResponse, message: string): void {
    if (r.finished) return
    emitter.emit('error', { message, code: 'cascade_turn_failed', fatal: false })
    ensureStarted(r)
    // Whatever text already arrived is still spoken; with none the engine sees an empty response.
    completeText(r)
  }

  function onHostEvent(ev: CascadeHostEvent): void {
    if (closed || !ev || typeof ev.turnId !== 'string') return
    const r = byId.get(ev.turnId)
    if (!r || r.finished || !r.remote) return
    switch (ev.kind) {
      case 'delta': {
        if (r.textDone || typeof ev.delta !== 'string' || ev.delta.length === 0) return
        ensureStarted(r)
        armTimer(r)
        r.text += ev.delta
        feedText(r)
        return
      }
      case 'tool': {
        ensureStarted(r)
        armTimer(r)
        return
      }
      case 'done': {
        ensureStarted(r)
        if (!r.text && typeof ev.text === 'string' && ev.text.trim()) {
          // The host produced text without streaming it (non-streaming adapter): speak it now.
          r.text = ev.text
        }
        completeText(r)
        return
      }
      case 'error': {
        onTurnError(r, typeof ev.message === 'string' ? ev.message : 'cascade turn failed')
        return
      }
      case 'aborted': {
        // Aborted host-side (another chat turn on the session, kernel restart…).
        if (r.textDone) return
        ensureStarted(r)
        finish(r, true, 'server', 'host turn aborted')
        return
      }
      default:
        return
    }
  }

  /** Cancels our current response (host LLM turn and pending TTS). */
  function cancelOwn(reason: VoiceSessionCancelReason): void {
    const r = current
    if (!r || r.finished) return
    if (r.remote && !r.textDone) {
      try {
        void Promise.resolve(options.abortTurn(r.turnId)).catch(() => {})
      } catch {
        // ignore
      }
    }
    finish(r, true, reason)
  }

  function startRemote(request: Omit<CascadeTurnRequest, 'turnId'>): void {
    cancelOwn('client')
    if (closed) return
    seq += 1
    const turnId = `${prefix}-${seq}`
    const r = newResponse(turnId, true)
    byId.set(turnId, r)
    current = r
    armTimer(r)
    let promise: Promise<unknown>
    try {
      promise = Promise.resolve(options.startTurn({ turnId, ...request }))
    } catch (err) {
      promise = Promise.reject(err)
    }
    promise.catch((err: unknown) => {
      if (r.finished || closed) return
      onTurnError(r, `cascade turn failed to start: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const session: CascadeSession = {
    get caps() {
      return caps
    },
    get connected() {
      return connected
    },
    get activeTurnId() {
      return current && !current.finished ? current.turnId : null
    },
    async connect(_init: VoiceSessionInit) {
      closed = false
      if (!unsubscribe) unsubscribe = options.subscribe(onHostEvent)
      if (options.prepare) await options.prepare()
      connected = true
    },
    pushAudio() {
      // transcribed mode only: the engine sends the WAV to the host STT itself.
    },
    commitUserTurn() {
      // no server-side buffer
    },
    respond(opts?: { contextText?: string } & VoiceSubmitOptions) {
      // Proactive turn (approval result / initiative): no user speech, only context.
      const context = (opts?.contextText ?? '').trim()
      startRemote({ text: '', ...(context ? { context } : {}) })
    },
    submitTranscribedTurn(turn: VoiceTranscribedTurn) {
      const context = (turn.context ?? '').trim()
      startRemote({
        text: turn.text,
        ...(context ? { context } : {}),
        ...(turn.toolChoice && !turn.approvalHandled ? { toolChoice: turn.toolChoice } : {}),
      })
    },
    submitUserText(text: string, contextOrOptions?: string | VoiceSubmitOptions, options2?: VoiceSubmitOptions) {
      const context = typeof contextOrOptions === 'string' ? contextOrOptions.trim() : ''
      const opts = typeof contextOrOptions === 'object' && contextOrOptions ? contextOrOptions : options2
      startRemote({
        text,
        ...(context ? { context } : {}),
        ...(opts?.toolChoice ? { toolChoice: opts.toolChoice } : {}),
      })
    },
    submitToolResults(_results: VoiceToolResult[]) {
      // Tools run inside the host turn; the engine never drives a tool round on this session.
    },
    speakText(text: string) {
      cancelOwn('client')
      if (closed) return
      seq += 1
      const r = newResponse(`${prefix}-speak-${seq}`, false)
      byId.set(r.turnId, r)
      current = r
      ensureStarted(r)
      r.text = text
      completeText(r)
    },
    cancelResponse(reason: VoiceSessionCancelReason = 'client') {
      cancelOwn(reason)
    },
    async injectContext() {
      // Context rides with each turn (`call:cascadeTurn.context`).
    },
    sendToolResult() {
      // see submitToolResults
    },
    async close() {
      if (closed) return
      cancelOwn('client')
      closed = true
      connected = false
      for (const r of [...byId.values()]) {
        r.finished = true
        clearTimer(r)
      }
      byId.clear()
      current = null
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      emitter.emit('closed', { expected: true })
    },
    on(event, cb) {
      return emitter.on(event, cb)
    },
  }
  return session
}
