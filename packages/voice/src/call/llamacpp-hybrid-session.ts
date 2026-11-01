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
 */
import type { CallSynthesizeResult } from '@ashy/shared'
import { cleanSpeakableMarkdown } from '../markdown-segmenter'
import { createTtsChunker, type TtsChunker } from '../tts-chunker'
import { createLlamaCppRealtimeSession, type LlamaCppRealtimeSession } from './llamacpp-realtime-session'
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
}

export interface LlamaCppHybridSession extends VoiceSession {
  submitUserText(text: string, contextText?: string): void
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
    toolCalls: false,
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

  let current: HybridResponse | null = null
  const byId = new Map<string, HybridResponse>()
  let closed = false

  function newResponse(responseId: string): HybridResponse {
    return {
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
    emitter.emit('response_done', {
      responseId: r.responseId,
      text: r.text,
      audioMs: r.audioMs,
      cancelled,
      ...(cancelled && reason ? { cancelReason: reason } : {}),
      ...(detail ? { detail } : {}),
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
      const text = speakablePhrase(chunk)
      if (!/[\p{L}\p{N}]/u.test(text)) continue
      r.jobs.push({ index: r.jobs.length, text, state: 'queued', pcm: null, sampleRate: DEFAULT_OUTPUT_RATE })
    }
    pump(r)
  }

  function feedText(r: HybridResponse): void {
    const speakable = speakableStreamText(r.text)
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

  inner.on('response_started', ({ responseId }) => {
    if (closed) return
    const r = newResponse(responseId)
    byId.set(responseId, r)
    current = r
    emitter.emit('response_started', { responseId })
  })

  inner.on('response_text', ({ responseId, delta, text }) => {
    const r = byId.get(responseId)
    if (!r || r.finished || r.textDone) return
    r.text = text
    emitter.emit('response_text', { responseId, delta, text })
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
    respond(opts?: { contextText?: string }) {
      cancelOwn('client')
      inner.respond(opts)
    },
    submitUserText(text: string, contextText?: string) {
      cancelOwn('client')
      inner.submitUserText(text, contextText)
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
