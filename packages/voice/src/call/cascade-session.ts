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
 * Latency (2026-11-01 run): `warmup` loads the cascade LLM at connect without blocking it (a failure
 * is only logged); while it runs, a turn gets a longer no-output timeout and the caption "carregando o
 * modelo…". With `synthesizeStream` + `subscribeTtsChunks` each phrase is synthesized in streaming
 * mode (llama.cpp `/tts` `stream:true`): PCM pieces of the phrase at the head of the queue are played
 * as they arrive (after a small pre-buffer), later phrases buffer theirs and still play strictly in
 * order. A stream that fails before any audio falls back to `synthesize` once.
 *
 * Tools run INSIDE the host turn (orchestrator tool loop through the agency gatekeeper), so the
 * engine's two-step tool flow is not used: `caps.toolCalls` is false and `toolChoice` is only
 * forwarded as the host's tool policy.
 */
import type { CallCascadeEvent, CallSynthesizeResult, CallSynthesizeStreamResult, CallTtsChunk } from '@ashy/shared'
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
  /**
   * Optional background warm-up started at connect, in parallel with `prepare` and NOT awaited (e.g.
   * load the cascade LLM). A rejection is reported as a non-fatal `warmup_failed` error only.
   */
  warmup?(): Promise<unknown>
  /** No-output timeout of a turn that starts while `warmup` is still running (default 90 s). */
  warmupTurnTimeoutMs?: number
  /** Caption shown while such a turn waits (default "carregando o modelo…"; '' = none). */
  warmupCaption?: string
  /**
   * Streamed host TTS of one phrase (`call:synthesizeStream`): PCM arrives through
   * `subscribeTtsChunks` (same `streamId`, `seq` 0..n-1); resolves with the chunk count.
   */
  synthesizeStream?(request: { streamId: string; text: string }): Promise<CallSynthesizeStreamResult>
  /** Subscribes to the host's `call:ttsChunk` events of this call. Returns the unsubscribe. */
  subscribeTtsChunks?(listener: (chunk: CallTtsChunk) => void): () => void
  /** Aborts a streamed synthesis (`call:synthesizeAbort`). Best effort. */
  abortSynthesis?(streamId: string): Promise<unknown> | void
  /** Which phrases use the streamed path when available (default 'all'). */
  streamPhrases?: 'all' | 'first'
  /** Audio a streamed head phrase buffers before it starts playing (default 200 ms). */
  streamPrebufferMs?: number
  /** After the stream resolved, how long to wait for chunks still in transit (default 2 s). */
  streamGraceMs?: number
  /** Wall clock (ms) for the adaptive stream jitter buffer (default `Date.now`). */
  now?: () => number
  /** Prefix of the generated turn ids (default 'cascade'). */
  turnIdPrefix?: string
  /** Max TTS requests in flight (default 2, clamped 1–4). */
  maxParallelTts?: number
  /** No host event for this long after the turn started → the turn fails (default 45 s). */
  turnTimeoutMs?: number
  timers?: CallTimers
  /** Phrase chunker (default: boosted, first phrase ≤ 7 words). */
  chunker?: {
    boostChunks?: number
    minBoostWords?: number
    maxBoostWords?: number
    maxChunkChars?: number
    firstChunkMaxWords?: number
  }
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
const DEFAULT_WARMUP_TURN_TIMEOUT_MS = 90_000
export const CASCADE_WARMUP_CAPTION = 'carregando o modelo…'
/** First phrase cap: the first audio waits for fewer LLM words and a shorter TTS job. */
export const CASCADE_FIRST_CHUNK_MAX_WORDS = 7
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
  /** The streamed path was already tried for this phrase (a failed stream falls back once). */
  streamTried?: boolean
  pcm: Int16Array | null
  sampleRate: number
  /** Streamed synthesis of this phrase (null = whole-phrase `synthesize`). */
  stream: PhraseStream | null
}

interface PhraseStream {
  id: string
  /** Out-of-order chunks waiting for their predecessors. */
  pending: Map<number, CallTtsChunk>
  /** Next expected seq. */
  nextSeq: number
  /** In-order PCM not yet handed to playback. */
  queue: Int16Array[]
  queuedSamples: number
  sampleRate: number
  /** Something of this phrase was already handed to playback. */
  emitted: boolean
  /** Chunk count once the host resolved (null while streaming). */
  total: number | null
  graceTimer: unknown
  /** Wall-clock start of the request and audio received so far (production-rate estimate). */
  startedAt: number
  receivedMs: number
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
  const warmupTurnTimeoutMs = Math.max(turnTimeoutMs, options.warmupTurnTimeoutMs ?? DEFAULT_WARMUP_TURN_TIMEOUT_MS)
  const warmupCaption = options.warmupCaption ?? CASCADE_WARMUP_CAPTION
  const canStream = typeof options.synthesizeStream === 'function' && typeof options.subscribeTtsChunks === 'function'
  const streamPhrases = options.streamPhrases ?? 'all'
  const streamPrebufferMs = Math.max(0, options.streamPrebufferMs ?? 200)
  const streamGraceMs = Math.max(0, options.streamGraceMs ?? 2000)
  const nowMs = options.now ?? (() => Date.now())
  /**
   * Adaptive jitter buffer. With a shared GPU the TTS can produce SLOWER than real time (2026-11-01:
   * ~0.5×), so a streamed phrase played as soon as its first piece arrives would stutter mid-word.
   * We estimate the production rate (audio ms per wall ms; EMA over finished streams, the live
   * stream's own rate once it has some audio) and the phrase duration from its text, and start a
   * phrase only when buffered + already-queued audio covers the projected shortfall:
   *   buffered + queuedAhead ≥ (duration − buffered) × (1/rate − 1)
   */
  let rateEma = 1
  /** Wall-clock time at which the audio handed to playback so far ends (≈ player queue end). */
  let playEndAt = 0
  const MS_PER_CHAR = 60
  const chunkerOptions = { firstChunkMaxWords: CASCADE_FIRST_CHUNK_MAX_WORDS, ...(options.chunker ?? {}) }
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
  let unsubscribeChunks: (() => void) | null = null
  /** Streamed phrases in flight, by stream id. */
  const streams = new Map<string, { r: CascadeResponse; job: PhraseJob }>()
  let warmupPending = false

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
      chunker: createTtsChunker(chunkerOptions),
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
    // The LLM may still be loading (warm-up running): be patient with this turn.
    const ms = warmupPending ? warmupTurnTimeoutMs : turnTimeoutMs
    r.timer = timers.setTimeout(() => {
      r.timer = null
      if (r.finished || r.textDone) return
      try {
        void Promise.resolve(options.abortTurn(r.turnId)).catch(() => {})
      } catch {
        // ignore
      }
      onTurnError(r, `cascade turn timed out (${ms} ms without output)`)
    }, ms)
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
    releaseStreams(r)
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
      if (job.stream) {
        const st = job.stream
        const complete = job.state === 'failed' || (st.total !== null && st.nextSeq >= st.total)
        if (st.queuedSamples > 0 && (st.emitted || complete || readyToStart(job, st))) {
          emitPhraseAudio(r, job, takeQueued(st), st.sampleRate, !st.emitted)
          st.emitted = true
        }
        if (!complete) break
        if (st.graceTimer !== null) {
          timers.clearTimeout(st.graceTimer)
          st.graceTimer = null
        }
        streams.delete(st.id)
        r.nextEmit += 1
        continue
      }
      if (job.state === 'ready') {
        const pcm = job.pcm
        job.pcm = null
        r.nextEmit += 1
        if (pcm && pcm.length > 0) emitPhraseAudio(r, job, pcm, job.sampleRate, true)
      } else if (job.state === 'failed') {
        r.nextEmit += 1
      } else {
        break
      }
    }
    maybeFinish(r)
  }

  /** Hands audio of `job` to playback; the phrase text joins the spoken text with its first audio. */
  function readyToStart(job: PhraseJob, st: PhraseStream): boolean {
    const buffered = (st.queuedSamples / st.sampleRate) * 1000
    if (buffered < streamPrebufferMs) return false
    const elapsed = Math.max(1, nowMs() - st.startedAt)
    const rate = Math.max(0.05, st.receivedMs >= 400 ? Math.min(rateEma, st.receivedMs / elapsed) : rateEma)
    if (rate >= 1) return true
    const duration = Math.max(buffered, job.text.length * MS_PER_CHAR)
    const queuedAhead = Math.max(0, playEndAt - nowMs())
    return buffered + queuedAhead >= (duration - buffered) * (1 / rate - 1)
  }

  function noteStreamRate(st: PhraseStream, reportedMs: number): void {
    const elapsed = nowMs() - st.startedAt
    const audioMs = Math.max(st.receivedMs, Number.isFinite(reportedMs) ? reportedMs : 0)
    if (audioMs < 300 || elapsed <= 0) return
    rateEma = 0.5 * rateEma + 0.5 * Math.min(2, audioMs / elapsed)
  }

  function emitPhraseAudio(r: CascadeResponse, job: PhraseJob, pcm: Int16Array, sampleRate: number, first: boolean): void {
    if (first) {
      const piece = `${job.prefix}${job.text}`
      const delta = r.spoken ? ` ${piece}` : piece
      r.spoken += delta
      emitter.emit('response_text', { responseId: r.turnId, delta, text: r.spoken })
    }
    outputRate = sampleRate
    const ms = (pcm.length / sampleRate) * 1000
    r.audioMs += ms
    playEndAt = Math.max(nowMs(), playEndAt) + ms
    emitter.emit('response_audio', { responseId: r.turnId, pcm, sampleRate })
  }

  function takeQueued(st: PhraseStream): Int16Array {
    const out = new Int16Array(st.queuedSamples)
    let off = 0
    for (const piece of st.queue) {
      out.set(piece, off)
      off += piece.length
    }
    st.queue = []
    st.queuedSamples = 0
    return out
  }

  /** Cancelled / finished turn: abort its live streams and forget them (late chunks are ignored). */
  function releaseStreams(r: CascadeResponse): void {
    for (const job of r.jobs) {
      const st = job.stream
      if (!st) continue
      if (st.graceTimer !== null) {
        timers.clearTimeout(st.graceTimer)
        st.graceTimer = null
      }
      const live = streams.get(st.id)
      if (!live) continue
      streams.delete(st.id)
      if (st.total === null && job.state === 'inflight' && options.abortSynthesis) {
        try {
          void Promise.resolve(options.abortSynthesis(st.id)).catch(() => {})
        } catch {
          // ignore
        }
      }
    }
  }

  function onTtsChunk(chunk: CallTtsChunk): void {
    if (closed || !chunk || typeof chunk.streamId !== 'string') return
    const live = streams.get(chunk.streamId)
    if (!live) return
    const { r, job } = live
    const st = job.stream
    if (!st || r.finished || job.state === 'failed' || !Number.isInteger(chunk.seq) || chunk.seq < st.nextSeq) return
    st.pending.set(chunk.seq, chunk)
    let advanced = false
    for (let next = st.pending.get(st.nextSeq); next; next = st.pending.get(st.nextSeq)) {
      st.pending.delete(st.nextSeq)
      st.nextSeq += 1
      const pcm = typeof next.pcmBase64 === 'string' ? base64ToInt16(next.pcmBase64) : new Int16Array(0)
      if (pcm.length === 0) continue
      if (next.sampleRate > 0 && next.sampleRate !== st.sampleRate) {
        if (st.queuedSamples > 0 && st.emitted) emitPhraseAudio(r, job, takeQueued(st), st.sampleRate, false)
        st.sampleRate = next.sampleRate
      }
      st.receivedMs += (pcm.length / st.sampleRate) * 1000
      st.queue.push(pcm)
      st.queuedSamples += pcm.length
      advanced = true
    }
    if (!advanced) return
    if (st.total !== null && st.nextSeq >= st.total) job.state = 'ready'
    drainOrdered(r)
  }

  function startStream(r: CascadeResponse, job: PhraseJob): void {
    const st: PhraseStream = {
      id: `${r.turnId}-p${job.index}`,
      pending: new Map(),
      nextSeq: 0,
      queue: [],
      queuedSamples: 0,
      sampleRate: DEFAULT_OUTPUT_RATE,
      emitted: false,
      total: null,
      graceTimer: null,
      startedAt: nowMs(),
      receivedMs: 0,
    }
    job.stream = st
    streams.set(st.id, { r, job })
    let promise: Promise<CallSynthesizeStreamResult>
    try {
      promise = Promise.resolve(options.synthesizeStream!({ streamId: st.id, text: job.text }))
    } catch (err) {
      promise = Promise.reject(err)
    }
    promise.then(
      (res) => {
        r.inflight -= 1
        if (r.finished || closed || job.stream !== st) return
        if (!res?.aborted) noteStreamRate(st, Number(res?.durationMs))
        if (res?.aborted) {
          // Aborted host-side without us asking: play what arrived, drop the rest.
          st.total = st.nextSeq
        } else {
          st.total = Math.max(0, Math.floor(Number(res?.chunks) || 0))
        }
        if (st.nextSeq >= st.total) {
          job.state = 'ready'
        } else {
          // Chunk events may still be in transit (separate IPC channel): wait a little.
          st.graceTimer = timers.setTimeout(() => {
            st.graceTimer = null
            if (r.finished || job.stream !== st) return
            st.total = st.nextSeq
            job.state = 'ready'
            drainOrdered(r)
            pump(r)
          }, streamGraceMs)
        }
        drainOrdered(r)
        pump(r)
      },
      (err: unknown) => {
        r.inflight -= 1
        if (r.finished || closed || job.stream !== st) return
        if (st.nextSeq === 0 && st.queuedSamples === 0 && !st.emitted) {
          // Nothing arrived: retry the phrase once through the whole-phrase path.
          streams.delete(st.id)
          job.stream = null
          job.state = 'queued'
          emitter.emit('error', {
            message: `streamed tts failed for phrase ${job.index}, retrying without streaming: ${err instanceof Error ? err.message : String(err)}`,
            code: 'tts_stream_failed',
            fatal: false,
          })
          pump(r)
          return
        }
        // Partial audio: play what arrived and move on.
        st.total = st.nextSeq
        job.state = 'failed'
        emitter.emit('error', {
          message: `streamed tts failed mid-phrase ${job.index}: ${err instanceof Error ? err.message : String(err)}`,
          code: 'tts_failed',
          fatal: false,
        })
        drainOrdered(r)
        pump(r)
      },
    )
  }

  function pump(r: CascadeResponse): void {
    for (const job of r.jobs) {
      if (r.finished || closed || r.inflight >= maxParallel) return
      if (job.state !== 'queued') continue
      job.state = 'inflight'
      r.inflight += 1
      if (canStream && job.streamTried !== true && (streamPhrases === 'all' || job.index === 0)) {
        job.streamTried = true
        startStream(r, job)
        continue
      }
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
      r.jobs.push({
        index: r.jobs.length,
        text,
        prefix: r.pendingMarkers,
        state: 'queued',
        pcm: null,
        sampleRate: DEFAULT_OUTPUT_RATE,
        stream: null,
      })
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
    if (warmupPending && warmupCaption) {
      // After submitTranscribedTurn returned (the engine installs its ledger first).
      void Promise.resolve().then(() => {
        if (current === r && !r.finished && !r.text && warmupPending) {
          emitter.emit('response_status', { responseId: r.turnId, text: warmupCaption })
        }
      })
    }
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
      if (canStream && !unsubscribeChunks) unsubscribeChunks = options.subscribeTtsChunks!(onTtsChunk)
      if (options.warmup && !warmupPending) {
        warmupPending = true
        let warm: Promise<unknown>
        try {
          warm = Promise.resolve(options.warmup())
        } catch (err) {
          warm = Promise.reject(err)
        }
        warm.then(
          () => {
            warmupPending = false
          },
          (err: unknown) => {
            warmupPending = false
            if (closed) return
            emitter.emit('error', {
              message: `llm warm-up failed: ${err instanceof Error ? err.message : String(err)}`,
              code: 'warmup_failed',
              fatal: false,
            })
          },
        )
      }
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
      if (unsubscribeChunks) {
        unsubscribeChunks()
        unsubscribeChunks = null
      }
      streams.clear()
      emitter.emit('closed', { expected: true })
    },
    on(event, cb) {
      return emitter.on(event, cb)
    },
  }
  return session
}
