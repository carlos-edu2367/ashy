/**
 * Phase 10.2 — `LlamaCppHybridSession` (spec §7.9, §8.3): llama-server `/v1/realtime` answers in TEXT
 * only (`output_modalities:["text"]`), the text is cut into phrases by the boosted TTS chunker and every
 * phrase is spoken by the host (`call:synthesize` → llama-server `/tts`, optionally cloning the user's
 * reference voice). Up to `maxParallelTts` phrases are synthesized at once; audio is always emitted in
 * phrase order.
 *
 * For the CallEngine it is transparent: same `VoiceSession` surface + `submitUserText`, same events as
 * the realtime session (`response_started`, `response_text`, `response_audio {pcm, sampleRate}`,
 * `response_done`). `response_done` comes only after the last phrase's audio was emitted.
 *
 * It reuses the realtime session's protocol handling (handshake, cancel settle, degenerate-text
 * watchdog: with no audio deltas only the text checks can fire) and rewrites its `session.update`
 * to text-only on the wire. `cancelResponse` cancels the realtime response, drops every pending /tts and
 * ignores late results.
 *
 * Phase 10.3: tools pass through to the realtime session (tool steps, `submitToolResults`); every
 * per-response `output_modalities` override is forced to text on the wire. `speakText` speaks a ready
 * text (a tool step that called nothing) through the same phrase TTS, without a new generation.
 *
 * 2026-11-01 conversation guard (small-model quality, default on): the reply to a user turn is held until
 * its first sentence is complete (~100–200 ms of text generation). A first sentence that repeats the
 * user's utterance is dropped before TTS (LFM3-2B echo habit); a reply that is NOTHING but the echo is
 * regenerated once with a private nudge. Ashy addressing herself by name ("Oi, Ashy!" mirrored from the
 * user) is removed from what is spoken and reported.
 */
import type { CallSynthesizeResult } from '@ashy/shared'
import { cleanSpeakableMarkdown } from '../markdown-segmenter'
import { createTtsChunker, type TtsChunker } from '../tts-chunker'
import { createLlamaCppRealtimeSession, type LlamaCppRealtimeSession } from './llamacpp-realtime-session'
import { echoedOpening, removeSelfVocative, userUtteranceOfTurnItem } from './call-quality'
import { base64ToInt16 } from './pcm-utils'
import type { RunawayWatchdogOptions } from './runaway-watchdog'
import {
  createDefaultWebSocketFactory,
  createEmitter,
  type CallTimers,
  type VoiceSession,
  type VoiceSessionCancelReason,
  type VoiceSessionCapabilities,
  type VoiceSessionEventMap,
  type VoiceSessionInit,
  type VoiceSubmitOptions,
  type VoiceToolCall,
  type VoiceToolResult,
  type WebSocketFactory,
  type WebSocketLike,
} from './types'

export interface LlamaCppHybridSessionOptions {
  /** llama-server base URL (http://127.0.0.1:<port>) or a ws(s):// URL. */
  baseUrl: string
  modelId?: string
  maxOutputTokens?: number
  /** Host TTS of one phrase (`call:synthesize`). */
  synthesize: (text: string) => Promise<CallSynthesizeResult>
  /** Max /tts requests in flight (default 2, clamped 1–4). */
  maxParallelTts?: number
  webSocketFactory?: WebSocketFactory
  timers?: CallTimers
  handshakeTimeoutMs?: number
  cancelSettleMs?: number
  watchdog?: Partial<RunawayWatchdogOptions>
  /** Chunker tuning (defaults: boost of 2 short phrases, then sentences). */
  chunker?: { boostChunks?: number; minBoostWords?: number; maxBoostWords?: number; maxChunkChars?: number }
  /** 2026-11-01 echo / self-vocative guard (default true). */
  conversationGuard?: boolean
}

/** Private nudge of the one regeneration after a reply that only repeated the user. */
export const HYBRID_ECHO_RETRY_CONTEXT =
  '[Contexto] Você só repetiu a fala do usuário. Responda a ela agora com algo novo, sem repeti-la.'

export interface LlamaCppHybridSession extends VoiceSession {
  submitUserText(text: string, contextOrOptions?: string | VoiceSubmitOptions, options?: VoiceSubmitOptions): void
  submitToolResults(results: VoiceToolResult[], options?: VoiceSubmitOptions): void
  /** Phase 10.3 — speaks a ready text through the phrase TTS (no generation), with the regular events. */
  speakText(text: string): void
  readonly connected: boolean
  readonly url: string
}

const DEFAULT_OUTPUT_RATE = 24000
/** `<|ACT {json}|>` / `<|ACT {json}}>` style markers (never spoken). */
const COMPLETE_MARKER_RE = /<\|[\s\S]*?(?:\|>|\}>)/g
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu

/**
 * Speakable prefix of a streamed answer: complete markers removed, and everything from an
 * still-open `<|` held back (so the result only ever grows as more text arrives).
 */
export function speakableStreamText(full: string): string {
  const withoutComplete = full.replace(COMPLETE_MARKER_RE, ' ')
  const open = withoutComplete.indexOf('<|')
  const stable = open >= 0 ? withoutComplete.slice(0, open) : withoutComplete
  // A lone trailing '<' may become '<|'.
  return stable.endsWith('<') ? stable.slice(0, -1) : stable
}

function speakablePhrase(chunk: string): string {
  return cleanSpeakableMarkdown(chunk.replace(EMOJI_RE, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\s+([!?.,;:…])/g, '$1')
    .trim()
}

/** Wraps a socket so the realtime session's `session.update` asks for text-only output. */
function textOnlySocket(real: WebSocketLike): WebSocketLike {
  return {
    get readyState() {
      return real.readyState
    },
    send(data: string) {
      let out = data
      try {
        const msg = JSON.parse(data) as { type?: unknown; session?: Record<string, unknown> }
        if (msg && msg.type === 'session.update' && msg.session && typeof msg.session === 'object') {
          msg.session.output_modalities = ['text']
          out = JSON.stringify(msg)
        } else if (msg && msg.type === 'response.create') {
          // Phase 10.3 per-response overrides: never ask the server for audio.
          const response = (msg as { response?: Record<string, unknown> }).response
          if (response && typeof response === 'object' && 'output_modalities' in response) {
            response.output_modalities = ['text']
            out = JSON.stringify(msg)
          }
        }
      } catch {
        // not JSON: pass through
      }
      real.send(out)
    },
    close(code?: number, reason?: string) {
      real.close(code, reason)
    },
    get onopen() {
      return real.onopen
    },
    set onopen(fn) {
      real.onopen = fn
    },
    get onmessage() {
      return real.onmessage
    },
    set onmessage(fn) {
      real.onmessage = fn
    },
    get onerror() {
      return real.onerror
    },
    set onerror(fn) {
      real.onerror = fn
    },
    get onclose() {
      return real.onclose
    },
    set onclose(fn) {
      real.onclose = fn
    },
  }
}

interface PhraseJob {
  index: number
  text: string
  state: 'queued' | 'inflight' | 'ready' | 'failed'
  pcm: Int16Array | null
  sampleRate: number
}

interface HybridResponse {
  responseId: string
  text: string
  /** Length of the speakable text already fed to the chunker. */
  fedChars: number
  chunker: TtsChunker
  jobs: PhraseJob[]
  nextEmit: number
  inflight: number
  audioMs: number
  textDone: boolean
  finished: boolean
  /** Phase 10.3 — function calls of the realtime response (passed on with response_done). */
  toolCalls?: VoiceToolCall[]
  /** Conversation guard: the user's words this reply answers (null = no echo check). */
  utterance: string | null
  /** Held: nothing emitted / spoken until the first sentence is judged. */
  held: boolean
  startedEmitted: boolean
  /** Raw-text offset where the spoken answer starts (an echoed opening is cut). */
  cut: number
  retried: boolean
}

export function createLlamaCppHybridSession(options: LlamaCppHybridSessionOptions): LlamaCppHybridSession {
  const maxParallel = Math.max(1, Math.min(4, Math.round(options.maxParallelTts ?? 2)))
  const baseFactory = options.webSocketFactory ?? createDefaultWebSocketFactory()
  const inner: LlamaCppRealtimeSession = createLlamaCppRealtimeSession({
    baseUrl: options.baseUrl,
    ...(options.modelId ? { modelId: options.modelId } : {}),
    inputMode: 'transcribed',
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    webSocketFactory: (url) => textOnlySocket(baseFactory(url)),
    outputModalities: ['text'],
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: options.handshakeTimeoutMs } : {}),
    ...(options.cancelSettleMs !== undefined ? { cancelSettleMs: options.cancelSettleMs } : {}),
    ...(options.watchdog ? { watchdog: options.watchdog } : {}),
  })
  const emitter = createEmitter<VoiceSessionEventMap>()
  let outputRate = DEFAULT_OUTPUT_RATE
  const caps: VoiceSessionCapabilities = {
    serverTurnDetection: false,
    messageTruncation: false,
    mutableInstructions: false,
    contextInjection: 'input_text_item',
    userTranscription: false,
    toolCalls: true,
    imageInput: false,
    speakerReference: true,
    voices: ['female', 'male'],
    get inputSampleRate() {
      return inner.caps.inputSampleRate
    },
    get outputSampleRate() {
      return outputRate
    },
  }

  const guard = options.conversationGuard !== false
  /** User words of the last submitted turn, consumed by the next response. */
  let pendingUtterance: string | null = null
  /** Set while the one echo regeneration is in flight. */
  let pendingRetry: { utterance: string } | null = null
  let current: HybridResponse | null = null
  const byId = new Map<string, HybridResponse>()
  let closed = false
  let speakSeq = 0

  function newResponse(responseId: string, utterance: string | null = null, retried = false): HybridResponse {
    return {
      utterance,
      held: guard && utterance !== null && utterance.length > 0,
      startedEmitted: false,
      cut: 0,
      retried,
      responseId,
      text: '',
      fedChars: 0,
      chunker: createTtsChunker(options.chunker ?? {}),
      jobs: [],
      nextEmit: 0,
      inflight: 0,
      audioMs: 0,
      textDone: false,
      finished: false,
    }
  }

  function finish(r: HybridResponse, cancelled: boolean, reason?: VoiceSessionCancelReason, detail?: string): void {
    if (r.finished) return
    r.finished = true
    byId.delete(r.responseId)
    if (current === r) current = null
    if (!r.startedEmitted) {
      r.startedEmitted = true
      emitter.emit('response_started', { responseId: r.responseId })
    }
    emitter.emit('response_done', {
      responseId: r.responseId,
      text: outText(r),
      audioMs: r.audioMs,
      cancelled,
      ...(cancelled && reason ? { cancelReason: reason } : {}),
      ...(detail ? { detail } : {}),
      ...(!cancelled && r.toolCalls && r.toolCalls.length > 0 ? { toolCalls: r.toolCalls } : {}),
    })
  }

  function maybeFinish(r: HybridResponse): void {
    if (!r.finished && r.textDone && r.nextEmit >= r.jobs.length) finish(r, false)
  }

  function drainOrdered(r: HybridResponse): void {
    while (!r.finished && r.nextEmit < r.jobs.length) {
      const job = r.jobs[r.nextEmit]!
      if (job.state === 'ready') {
        const pcm = job.pcm
        job.pcm = null
        r.nextEmit += 1
        if (pcm && pcm.length > 0) {
          outputRate = job.sampleRate
          r.audioMs += (pcm.length / job.sampleRate) * 1000
          emitter.emit('response_audio', { responseId: r.responseId, pcm, sampleRate: job.sampleRate })
        }
      } else if (job.state === 'failed') {
        r.nextEmit += 1
      } else {
        break
      }
    }
    maybeFinish(r)
  }

  function pump(r: HybridResponse): void {
    for (const job of r.jobs) {
      if (r.finished || r.inflight >= maxParallel) return
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
          const pcm = res && typeof res.pcmBase64 === 'string' ? base64ToInt16(res.pcmBase64) : new Int16Array(0)
          job.pcm = pcm
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

  function enqueuePhrases(r: HybridResponse, chunks: string[]): void {
    for (const chunk of chunks) {
      const text = guard ? speakablePhrase(removeSelfVocative(chunk)) : speakablePhrase(chunk)
      if (!/[\p{L}\p{N}]/u.test(text)) continue
      r.jobs.push({ index: r.jobs.length, text, state: 'queued', pcm: null, sampleRate: DEFAULT_OUTPUT_RATE })
    }
    pump(r)
  }

  /** What Ashy actually says: the raw text minus a cut echo, without self-vocatives. */
  function outText(r: HybridResponse): string {
    const raw = r.cut > 0 ? r.text.slice(r.cut) : r.text
    return guard ? removeSelfVocative(raw) : raw
  }

  function feedText(r: HybridResponse): void {
    if (r.held) return
    const speakable = speakableStreamText(r.cut > 0 ? r.text.slice(r.cut) : r.text)
    if (speakable.length <= r.fedChars) return
    const fresh = speakable.slice(r.fedChars)
    r.fedChars = speakable.length
    enqueuePhrases(r, r.chunker.write(fresh))
  }

  /** Cancels our current response (realtime side and pending TTS). */
  function cancelOwn(reason: VoiceSessionCancelReason): void {
    const r = current
    if (!r || !r.textDone) {
      // Realtime side still streaming (or not started yet): its cancelled response_done arrives
      // synchronously and finishes ours through the listener below.
      inner.cancelResponse(reason)
    }
    if (r && !r.finished) finish(r, true, reason)
  }

  /**
   * Judges the held first sentence: cut an echoed opening; a reply that is only the echo is regenerated
   * once (returns false: the response was replaced). Then emits what was held and starts the TTS.
   */
  function release(r: HybridResponse, final: boolean): boolean {
    const echo = echoedOpening(r.utterance ?? '', r.text)
    // Only the echo so far: keep holding until the answer starts (or the response ends).
    if (echo.cut > 0 && echo.whole && !final) return true
    r.held = false
    if (echo.cut > 0 && echo.whole && final && !r.retried && !closed) {
      // Discard silently (nothing was emitted) and ask once more, with a private nudge.
      r.finished = true
      byId.delete(r.responseId)
      if (current === r) current = null
      pendingRetry = { utterance: r.utterance ?? '' }
      inner.respond({ contextText: HYBRID_ECHO_RETRY_CONTEXT })
      return false
    }
    if (echo.cut > 0 && !echo.whole) r.cut = echo.cut
    if (!r.startedEmitted) {
      r.startedEmitted = true
      emitter.emit('response_started', { responseId: r.responseId })
    }
    const spoken = outText(r)
    if (spoken) emitter.emit('response_text', { responseId: r.responseId, delta: spoken, text: spoken })
    feedText(r)
    return true
  }

  /** The first sentence (after a leading "Ah," / "Oi!") is complete, or long enough, to be judged. */
  function firstSentenceReady(text: string): boolean {
    const t = text.trim()
    const afterLead = t.replace(/^\S+[,!]\s+/, '')
    return /[.!?…](?:\s|$)/.test(afterLead) || t.length >= 240
  }

  inner.on('response_started', ({ responseId }) => {
    if (closed) return
    const retry = pendingRetry
    pendingRetry = null
    const utterance = retry ? retry.utterance : pendingUtterance
    pendingUtterance = null
    const r = newResponse(responseId, utterance, retry !== null)
    byId.set(responseId, r)
    current = r
    if (!r.held) {
      r.startedEmitted = true
      emitter.emit('response_started', { responseId })
    }
  })

  inner.on('response_text', ({ responseId, delta, text }) => {
    const r = byId.get(responseId)
    if (!r || r.finished || r.textDone) return
    r.text = text
    if (r.held) {
      if (firstSentenceReady(text)) release(r, false)
      return
    }
    emitter.emit('response_text', { responseId, delta, text: guard ? outText(r) : text })
    feedText(r)
  })

  inner.on('response_done', (ev) => {
    const r = byId.get(ev.responseId)
    if (!r || r.finished) return
    if (ev.cancelled) {
      finish(r, true, ev.cancelReason ?? 'client', ev.detail)
      return
    }
    r.text = ev.text || r.text
    if (ev.toolCalls && ev.toolCalls.length > 0) r.toolCalls = ev.toolCalls
    if (r.held && !release(r, true)) return
    feedText(r)
    r.textDone = true
    enqueuePhrases(r, r.chunker.flush())
    drainOrdered(r)
  })

  inner.on('response_audio', () => {
    // Text-only session: any stray audio from the server is ignored (the host speaks the text).
  })
  inner.on('user_speech_started', (p) => emitter.emit('user_speech_started', p))
  inner.on('user_speech_stopped', (p) => emitter.emit('user_speech_stopped', p))
  inner.on('user_transcript', (p) => emitter.emit('user_transcript', p))
  inner.on('tool_call', (p) => emitter.emit('tool_call', p))
  inner.on('tool_step_started', (p) => !closed && emitter.emit('tool_step_started', p))
  inner.on('tool_step_done', (p) => !closed && emitter.emit('tool_step_done', p))
  inner.on('error', (p) => emitter.emit('error', p))
  inner.on('closed', (p) => {
    const r = current
    if (r && !r.finished) finish(r, true, 'server', 'session closed')
    emitter.emit('closed', p)
  })

  const session: LlamaCppHybridSession = {
    get caps() {
      return caps
    },
    get connected() {
      return inner.connected
    },
    get url() {
      return inner.url
    },
    connect(init: VoiceSessionInit) {
      closed = false
      return inner.connect(init)
    },
    pushAudio(pcm: Int16Array) {
      inner.pushAudio(pcm)
    },
    commitUserTurn() {
      inner.commitUserTurn()
    },
    respond(opts?: { contextText?: string } & VoiceSubmitOptions) {
      cancelOwn('client')
      pendingUtterance = null
      pendingRetry = null
      inner.respond(opts)
    },
    submitUserText(text: string, contextOrOptions?: string | VoiceSubmitOptions, options?: VoiceSubmitOptions) {
      cancelOwn('client')
      pendingRetry = null
      const toolStep = (typeof contextOrOptions === 'object' ? contextOrOptions : options)?.toolChoice === 'auto'
      pendingUtterance = guard && !toolStep ? userUtteranceOfTurnItem(text) || null : null
      inner.submitUserText(text, contextOrOptions, options)
    },
    submitToolResults(results: VoiceToolResult[], options?: VoiceSubmitOptions) {
      cancelOwn('client')
      pendingUtterance = null
      pendingRetry = null
      inner.submitToolResults(results, options)
    },
    speakText(text: string) {
      cancelOwn('client')
      if (closed) return
      speakSeq += 1
      const responseId = `speak_${speakSeq}`
      const r = newResponse(responseId)
      byId.set(responseId, r)
      current = r
      r.startedEmitted = true
      emitter.emit('response_started', { responseId })
      r.text = text
      if (text) emitter.emit('response_text', { responseId, delta: text, text })
      feedText(r)
      r.textDone = true
      enqueuePhrases(r, r.chunker.flush())
      drainOrdered(r)
    },
    cancelResponse(reason: VoiceSessionCancelReason = 'client') {
      cancelOwn(reason)
    },
    injectContext(text: string) {
      return inner.injectContext(text)
    },
    sendToolResult(callId: string, output: string) {
      inner.sendToolResult(callId, output)
    },
    async close() {
      closed = true
      for (const r of [...byId.values()]) {
        r.finished = true
      }
      byId.clear()
      current = null
      await inner.close()
    },
    on(event, cb) {
      return emitter.on(event, cb)
    },
  }
  return session
}
