/**
 * Phase 10.1 — `LlamaCppRealtimeSession` (spec §8.1) over llama-server `/v1/realtime`.
 *
 * Handshake (verified in the 2026-10-31 spike): wait `session.created` (rates live in
 * `session.audio.{input,output}.format.rate`) → `session.update {instructions,
 * output_modalities:["text","audio"], max_output_tokens}` → WAIT `session.updated` before any input.
 *
 * `transcribed` mode (default): context `input_text` item (when non-empty) → user `input_text` item →
 * `response.create`. `audio-direct` (experimental): `input_audio_buffer.append` chunks →
 * `input_audio_buffer.commit` → context item → `response.create`.
 *
 * The server streams `response.output_text.delta` / `response.output_audio.delta` (base64 PCM16 mono)
 * then `response.done`; `response.cancel` stops it. There is no server VAD, no truncate.
 * A runaway watchdog cancels degenerate responses (mandatory, see spec §4).
 */
import type { LiveInputMode } from '@ashy/shared'
import { base64ToInt16, int16ToBase64 } from './pcm-utils'
import {
  checkRunaway,
  DEFAULT_RUNAWAY_WATCHDOG_OPTIONS,
  type RunawayWatchdogOptions,
} from './runaway-watchdog'
import {
  createDefaultCallTimers,
  createDefaultWebSocketFactory,
  createEmitter,
  WS_READY_STATE,
  type CallTimers,
  type VoiceSession,
  type VoiceSessionCancelReason,
  type VoiceSessionCapabilities,
  type VoiceSessionEventMap,
  type VoiceSessionInit,
  type WebSocketFactory,
  type WebSocketLike,
} from './types'

export interface LlamaCppRealtimeSessionOptions {
  /** llama-server base URL (http://127.0.0.1:<port>) or a ws(s):// URL. */
  baseUrl: string
  modelId?: string
  inputMode?: LiveInputMode
  maxOutputTokens?: number
  webSocketFactory?: WebSocketFactory
  timers?: CallTimers
  handshakeTimeoutMs?: number
  /** After `response.cancel`, how long to wait for the server's `response.done` before sending the next request. */
  cancelSettleMs?: number
  /** audio-direct: append chunk size (ms of input audio). Spec: 40–100 ms. */
  appendChunkMs?: number
  watchdog?: Partial<RunawayWatchdogOptions>
}

export interface LlamaCppRealtimeSession extends VoiceSession {
  submitUserText(text: string, contextText?: string): void
  readonly connected: boolean
  readonly url: string
}

interface ActiveResponse {
  localId: string
  serverId: string | null
  text: string
  audioSamples: number
  started: boolean
  cancelled: boolean
}

export function buildRealtimeUrl(baseUrl: string, modelId?: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  let url = trimmed.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://')
  if (!/^wss?:\/\//i.test(url)) url = `ws://${url}`
  if (!/\/v1\/realtime(\?|$)/.test(url)) url = `${url}/v1/realtime`
  if (modelId && !/[?&]model=/.test(url)) {
    url += `${url.includes('?') ? '&' : '?'}model=${encodeURIComponent(modelId)}`
  }
  return url
}

function readRate(session: unknown, dir: 'input' | 'output'): number | null {
  const s = session as { audio?: Record<string, { format?: { rate?: unknown } } | undefined> } | undefined
  const rate = s?.audio?.[dir]?.format?.rate
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null
}

function decodeMessageData(data: unknown): string | null {
  if (typeof data === 'string') return data
  try {
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
    if (ArrayBuffer.isView(data)) {
      return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    }
  } catch {
    return null
  }
  return null
}

export function createLlamaCppRealtimeSession(options: LlamaCppRealtimeSessionOptions): LlamaCppRealtimeSession {
  const inputMode: LiveInputMode = options.inputMode ?? 'transcribed'
  const maxOutputTokens = options.maxOutputTokens ?? 400
  const wsFactory = options.webSocketFactory ?? createDefaultWebSocketFactory()
  const timers = options.timers ?? createDefaultCallTimers()
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10000
  const cancelSettleMs = options.cancelSettleMs ?? 1000
  const appendChunkMs = Math.max(20, Math.min(100, options.appendChunkMs ?? 50))
  const watchdogOpts: RunawayWatchdogOptions = { ...DEFAULT_RUNAWAY_WATCHDOG_OPTIONS, ...(options.watchdog ?? {}) }
  const url = buildRealtimeUrl(options.baseUrl, options.modelId)

  const emitter = createEmitter<VoiceSessionEventMap>()
  const caps: VoiceSessionCapabilities = {
    serverTurnDetection: false,
    messageTruncation: false,
    mutableInstructions: false,
    contextInjection: 'input_text_item',
    userTranscription: false,
    toolCalls: false,
    imageInput: false,
    speakerReference: false,
    voices: ['female', 'male'],
    inputSampleRate: 16000,
    outputSampleRate: 24000,
  }

  let ws: WebSocketLike | null = null
  let ready = false
  let closing = false
  let closedEmitted = false
  let responseSeq = 0
  let active: ActiveResponse | null = null
  /** Set after a cancel until the server confirms with response.done (or cancelSettleMs passes). */
  let settlingCancel = false
  let settleTimer: unknown = null
  const deferredSends: Array<() => void> = []
  let appendBuffer: Int16Array[] = []
  let appendBufferedSamples = 0

  function send(obj: Record<string, unknown>): void {
    if (!ws || ws.readyState !== WS_READY_STATE.OPEN) return
    ws.send(JSON.stringify(obj))
  }

  function sendWhenSettled(fn: () => void): void {
    if (settlingCancel) deferredSends.push(fn)
    else fn()
  }

  function finishSettling(): void {
    if (!settlingCancel) return
    settlingCancel = false
    if (settleTimer !== null) {
      timers.clearTimeout(settleTimer)
      settleTimer = null
    }
    const queued = deferredSends.splice(0)
    for (const fn of queued) fn()
  }

  function audioMsOf(r: ActiveResponse): number {
    return (r.audioSamples / caps.outputSampleRate) * 1000
  }

  function ensureStarted(r: ActiveResponse): void {
    if (r.started) return
    r.started = true
    emitter.emit('response_started', { responseId: r.localId })
  }

  function doCancel(reason: VoiceSessionCancelReason, detail?: string): void {
    const r = active
    if (!r || r.cancelled) return
    r.cancelled = true
    send({ type: 'response.cancel' })
    settlingCancel = true
    if (settleTimer !== null) timers.clearTimeout(settleTimer)
    settleTimer = timers.setTimeout(() => {
      settleTimer = null
      finishSettling()
    }, cancelSettleMs)
    active = null
    ensureStarted(r)
    emitter.emit('response_done', {
      responseId: r.localId,
      text: r.text,
      audioMs: audioMsOf(r),
      cancelled: true,
      cancelReason: reason,
      ...(detail ? { detail } : {}),
    })
  }

  function runWatchdog(r: ActiveResponse): void {
    const verdict = checkRunaway({ audioMs: audioMsOf(r), text: r.text }, watchdogOpts)
    if (verdict.runaway) {
      doCancel('watchdog', `${verdict.kind}: ${verdict.detail}`)
    }
  }

  function startResponse(): void {
    responseSeq += 1
    active = {
      localId: `resp_${responseSeq}`,
      serverId: null,
      text: '',
      audioSamples: 0,
      started: false,
      cancelled: false,
    }
    send({ type: 'response.create' })
  }

  function sendInputText(text: string): void {
    send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    })
  }

  function handleServerEvent(ev: Record<string, unknown>): void {
    const type = typeof ev.type === 'string' ? ev.type : ''
    switch (type) {
      case 'response.created': {
        const id = (ev.response as { id?: unknown } | undefined)?.id
        if (active && !active.serverId && typeof id === 'string') active.serverId = id
        if (active) ensureStarted(active)
        return
      }
      case 'response.output_text.delta':
      case 'response.text.delta': {
        if (settlingCancel || !active || active.cancelled) return
        const delta = typeof ev.delta === 'string' ? ev.delta : ''
        if (!delta) return
        const r = active
        ensureStarted(r)
        r.text += delta
        emitter.emit('response_text', { responseId: r.localId, delta, text: r.text })
        runWatchdog(r)
        return
      }
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        if (settlingCancel || !active || active.cancelled) return
        const delta = typeof ev.delta === 'string' ? ev.delta : ''
        if (!delta) return
        const pcm = base64ToInt16(delta)
        if (pcm.length === 0) return
        const r = active
        ensureStarted(r)
        r.audioSamples += pcm.length
        emitter.emit('response_audio', { responseId: r.localId, pcm, sampleRate: caps.outputSampleRate })
        runWatchdog(r)
        return
      }
      case 'response.done': {
        if (settlingCancel) {
          // Confirmation of the response we cancelled locally.
          finishSettling()
          return
        }
        const r = active
        if (!r) return
        const doneId = (ev.response as { id?: unknown } | undefined)?.id
        if (typeof doneId === 'string' && r.serverId && doneId !== r.serverId) {
          // Late confirmation of an older (cancelled) response.
          return
        }
        active = null
        const status = (ev.response as { status?: unknown } | undefined)?.status
        const serverCancelled = status === 'cancelled'
        ensureStarted(r)
        emitter.emit('response_done', {
          responseId: r.localId,
          text: r.text,
          audioMs: audioMsOf(r),
          cancelled: serverCancelled,
          ...(serverCancelled ? { cancelReason: 'server' as const } : {}),
        })
        return
      }
      case 'response.function_call_arguments.done': {
        const callId = typeof ev.call_id === 'string' ? ev.call_id : ''
        const name = typeof ev.name === 'string' ? ev.name : ''
        if (callId && name) {
          emitter.emit('tool_call', {
            callId,
            name,
            arguments: typeof ev.arguments === 'string' ? ev.arguments : '{}',
          })
        }
        return
      }
      case 'error': {
        const err = ev.error as { message?: unknown; code?: unknown; type?: unknown } | undefined
        const message = typeof err?.message === 'string' ? err.message : 'llama-server realtime error'
        const code = typeof err?.code === 'string' ? err.code : typeof err?.type === 'string' ? err.type : undefined
        emitter.emit('error', { message, ...(code ? { code } : {}), fatal: false })
        return
      }
      default:
        return
    }
  }

  function connect(init: VoiceSessionInit): Promise<void> {
    if (ws) return Promise.reject(new Error('LlamaCppRealtimeSession already connected'))
    if (typeof init?.instructions !== 'string') {
      return Promise.reject(new Error('LlamaCppRealtimeSession.connect requires host-provided instructions'))
    }
    closing = false
    closedEmitted = false

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let phase: 'open' | 'created' | 'updated' = 'open'
      const timeout = timers.setTimeout(() => {
        fail(new Error(`realtime handshake timeout (${phase})`))
      }, handshakeTimeoutMs)

      function fail(err: Error): void {
        if (settled) return
        settled = true
        timers.clearTimeout(timeout)
        try {
          ws?.close()
        } catch {
          // ignore
        }
        ws = null
        reject(err)
      }
      function succeed(): void {
        if (settled) return
        settled = true
        timers.clearTimeout(timeout)
        ready = true
        resolve()
      }

      let socket: WebSocketLike
      try {
        socket = wsFactory(url)
      } catch (err) {
        settled = true
        timers.clearTimeout(timeout)
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      ws = socket

      socket.onopen = () => {
        // Nothing to send: the server speaks first with session.created.
      }
      socket.onerror = () => {
        if (!settled) fail(new Error('realtime websocket error'))
        else emitter.emit('error', { message: 'realtime websocket error', fatal: false })
      }
      socket.onclose = (event) => {
        const wasReady = ready
        ready = false
        ws = null
        active = null
        if (!settled) {
          fail(new Error(`realtime websocket closed during handshake (${event?.code ?? '?'})`))
          return
        }
        if (!closedEmitted) {
          closedEmitted = true
          emitter.emit('closed', {
            ...(typeof event?.code === 'number' ? { code: event.code } : {}),
            ...(typeof event?.reason === 'string' ? { reason: event.reason } : {}),
            expected: closing || !wasReady,
          })
        }
      }
      socket.onmessage = (event) => {
        const raw = decodeMessageData(event?.data)
        if (raw === null) return
        let ev: Record<string, unknown>
        try {
          ev = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return
        }
        if (!settled) {
          if (ev.type === 'session.created' && phase === 'open') {
            phase = 'created'
            const inRate = readRate(ev.session, 'input')
            const outRate = readRate(ev.session, 'output')
            if (inRate) caps.inputSampleRate = inRate
            if (outRate) caps.outputSampleRate = outRate
            send({
              type: 'session.update',
              session: {
                instructions: init.instructions,
                output_modalities: ['text', 'audio'],
                max_output_tokens: maxOutputTokens,
              },
            })
          } else if (ev.type === 'session.updated' && phase === 'created') {
            phase = 'updated'
            succeed()
          } else if (ev.type === 'error') {
            const msg = (ev.error as { message?: unknown } | undefined)?.message
            fail(new Error(`realtime handshake error: ${typeof msg === 'string' ? msg : 'unknown'}`))
          }
          return
        }
        handleServerEvent(ev)
      }
    })
  }

  function assertReady(op: string): boolean {
    if (!ready) {
      emitter.emit('error', { message: `${op} before session.updated`, code: 'not_ready', fatal: false })
      return false
    }
    return true
  }

  function flushAppend(): void {
    if (appendBufferedSamples === 0) return
    const merged = new Int16Array(appendBufferedSamples)
    let off = 0
    for (const c of appendBuffer) {
      merged.set(c, off)
      off += c.length
    }
    appendBuffer = []
    appendBufferedSamples = 0
    send({ type: 'input_audio_buffer.append', audio: int16ToBase64(merged) })
  }

  function cancelIfActive(): void {
    if (active && !active.cancelled) doCancel('client')
  }

  const session: LlamaCppRealtimeSession = {
    get caps() {
      return caps
    },
    get connected() {
      return ready
    },
    url,
    connect,
    pushAudio(pcm: Int16Array): void {
      if (!ready || pcm.length === 0) return
      appendBuffer.push(pcm)
      appendBufferedSamples += pcm.length
      const chunkSamples = Math.round((caps.inputSampleRate * appendChunkMs) / 1000)
      if (appendBufferedSamples >= chunkSamples) flushAppend()
    },
    commitUserTurn(): void {
      if (!assertReady('commitUserTurn')) return
      flushAppend()
      send({ type: 'input_audio_buffer.commit' })
    },
    respond(opts?: { contextText?: string }): void {
      if (!assertReady('respond')) return
      cancelIfActive()
      const contextText = opts?.contextText?.trim() ?? ''
      sendWhenSettled(() => {
        if (contextText) sendInputText(contextText)
        startResponse()
      })
    },
    submitUserText(text: string, contextText?: string): void {
      if (!assertReady('submitUserText')) return
      if (inputMode !== 'transcribed') {
        emitter.emit('error', { message: 'submitUserText in audio-direct mode', code: 'mode', fatal: false })
      }
      cancelIfActive()
      const ctx = contextText?.trim() ?? ''
      const userText = text.trim()
      sendWhenSettled(() => {
        if (ctx) sendInputText(ctx)
        if (userText) sendInputText(userText)
        startResponse()
      })
    },
    cancelResponse(reason: VoiceSessionCancelReason = 'client'): void {
      doCancel(reason)
    },
    async injectContext(text: string): Promise<void> {
      if (!assertReady('injectContext')) return
      const t = text.trim()
      if (!t) return
      sendWhenSettled(() => sendInputText(t))
    },
    sendToolResult(callId: string, output: string): void {
      if (!assertReady('sendToolResult')) return
      sendWhenSettled(() =>
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } }),
      )
    },
    async close(): Promise<void> {
      closing = true
      ready = false
      active = null
      if (settleTimer !== null) {
        timers.clearTimeout(settleTimer)
        settleTimer = null
      }
      settlingCancel = false
      deferredSends.length = 0
      const socket = ws
      ws = null
      if (socket) {
        try {
          socket.close(1000, 'call ended')
        } catch {
          // ignore
        }
      }
      if (!closedEmitted) {
        closedEmitted = true
        emitter.emit('closed', { code: 1000, reason: 'call ended', expected: true })
      }
    },
    on(event, cb) {
      return emitter.on(event, cb)
    },
  }
  return session
}
