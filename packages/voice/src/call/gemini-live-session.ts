/**
 * Phase 10.4 — `GeminiLiveSession`: VoiceSession over the Gemini Live API (`BidiGenerateContent`,
 * native-audio models such as `gemini-3.8-live`). Verified 2026-11-01 (ai.google.dev/api/live,
 * /gemini-api/docs/live-api/{capabilities,session-management,get-started-websocket}):
 *
 * - First client message = `{setup:{model:'models/<id>', generationConfig:{responseModalities:['AUDIO'],
 *   speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName}}}}, systemInstruction:{parts:[{text}]},
 *   tools:[{functionDeclarations}], realtimeInputConfig:{automaticActivityDetection:{…}, activityHandling},
 *   inputAudioTranscription:{}, outputAudioTranscription:{}, contextWindowCompression:{slidingWindow:{}},
 *   sessionResumption:{handle?}}}`; wait `setupComplete` before anything else. Native-audio models pick the
 *   language themselves (no `languageCode`): Brazilian Portuguese is asked for in the system instruction.
 * - Mic: `realtimeInput.audio {data, mimeType:'audio/pcm;rate=16000'}` (raw PCM16 LE 16 kHz);
 *   `audioStreamEnd` when the stream pauses. Automatic VAD on the server; the model answers by itself.
 * - Server: `serverContent.modelTurn.parts[].inlineData` (PCM16 24 kHz), `outputTranscription.text`,
 *   `inputTranscription.text`, `interrupted` (server VAD barge-in: stop playback, the history keeps only
 *   what was sent), `generationComplete`, `turnComplete`; `toolCall.functionCalls[{id,name,args}]` →
 *   `toolResponse.functionResponses[{id,name,response}]`; `toolCallCancellation`; `goAway.timeLeft`;
 *   `sessionResumptionUpdate {newHandle, resumable}` (handles valid 2 h) — a connection lives ~10 min, so the
 *   session reconnects transparently with the last handle.
 * - Per-turn context: `clientContent {turns:[{role:'user', parts:[{text}]}], turnComplete:false}` (allowed
 *   during the whole session; it interrupts an ongoing generation, so it is only sent while idle).
 * - 3.8 Live function calling is async (NON_BLOCKING) by default; declarations here ask for BLOCKING (the
 *   model waits for the result) except on `*-extended-thinking`, which only supports NON_BLOCKING.
 *
 * The API key never reaches this code: the renderer connects to the host loopback relay, which appends
 * `?key=` upstream (WebSocket redirects are ignored by Chromium's webRequest, so a header/redirect trick
 * in the renderer session cannot carry it).
 */
import type { CallToolDefinition } from '@ashy/shared'
import { base64ToInt16, int16ToBase64 } from './pcm-utils'
import { describeCloudCloseCode } from './openai-realtime-session'
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
  type VoiceSubmitOptions,
  type VoiceToolCall,
  type VoiceToolResult,
  type WebSocketFactory,
  type WebSocketLike,
} from './types'

export const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

/** A few of the prebuilt voices the native-audio models accept (any TTS voice works). */
export const GEMINI_LIVE_VOICES = ['Kore', 'Puck', 'Charon', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Zephyr']

export interface GeminiLiveSessionOptions {
  /** ws(s) URL to open (host relay URL; GEMINI_LIVE_WS_URL only with an external auth mechanism). */
  url: string
  model: string
  voice?: string
  webSocketFactory?: WebSocketFactory
  timers?: CallTimers
  handshakeTimeoutMs?: number
  appendChunkMs?: number
  /** Automatic VAD tuning (server). */
  vad?: {
    startOfSpeechSensitivity?: 'START_SENSITIVITY_HIGH' | 'START_SENSITIVITY_LOW'
    endOfSpeechSensitivity?: 'END_SENSITIVITY_HIGH' | 'END_SENSITIVITY_LOW'
    prefixPaddingMs?: number
    silenceDurationMs?: number
  }
  /** Transparent reconnect with the resumption handle on GoAway / connection end (default true). */
  resumption?: boolean
  /** Sliding-window context compression (default true: removes the 15-min audio session limit). */
  contextCompression?: boolean
}

export interface GeminiLiveSession extends VoiceSession {
  readonly url: string
  readonly connected: boolean
  readonly resumptionHandle: string | null
}

interface ActiveResponse {
  localId: string
  text: string
  audioSamples: number
  cancelled: boolean
  calls: VoiceToolCall[]
}

function decodeData(data: unknown): string | null {
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

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** JSON Schema (lowercase types) → Gemini OpenAPI-subset Schema (uppercase `type`, no extras). */
export function toGeminiSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const s = schema as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (typeof s.type === 'string') out.type = s.type.toUpperCase()
  if (typeof s.description === 'string') out.description = s.description
  if (Array.isArray(s.enum)) out.enum = s.enum.map(String)
  if (typeof s.format === 'string') out.format = s.format
  if (s.items) {
    const items = toGeminiSchema(s.items)
    if (items) out.items = items
  }
  if (s.properties && typeof s.properties === 'object') {
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) {
      const p = toGeminiSchema(v)
      if (p) props[k] = p
    }
    out.properties = props
  }
  if (Array.isArray(s.required) && s.required.length > 0) out.required = s.required.map(String)
  return out
}

export function buildGeminiFunctionDeclarations(tools: readonly CallToolDefinition[], model: string): Array<Record<string, unknown>> {
  const nonBlockingOnly = /extended-thinking/i.test(model)
  return tools.map((t) => {
    const params = toGeminiSchema(t.parameters)
    const hasParams = !!params && params.properties && Object.keys(params.properties as object).length > 0
    return {
      name: t.name,
      description: t.description,
      ...(hasParams ? { parameters: params } : {}),
      behavior: nonBlockingOnly ? 'NON_BLOCKING' : 'BLOCKING',
    }
  })
}

export function createGeminiLiveSession(options: GeminiLiveSessionOptions): GeminiLiveSession {
  const wsFactory = options.webSocketFactory ?? createDefaultWebSocketFactory()
  const timers = options.timers ?? createDefaultCallTimers()
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15000
  const appendChunkMs = Math.max(20, Math.min(200, options.appendChunkMs ?? 60))
  const resumptionEnabled = options.resumption !== false
  const url = options.url.trim()
  const model = options.model.trim()
  const nonBlockingTools = /extended-thinking/i.test(model)

  const emitter = createEmitter<VoiceSessionEventMap>()
  const caps: VoiceSessionCapabilities = {
    serverTurnDetection: true,
    messageTruncation: false,
    mutableInstructions: false,
    contextInjection: 'client_content',
    userTranscription: true,
    toolCalls: true,
    imageInput: true,
    speakerReference: false,
    voices: [...GEMINI_LIVE_VOICES],
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    serverAutoResponse: true,
    inlineToolCalls: true,
    managesContext: true,
  }

  let init: VoiceSessionInit | null = null
  let tools: CallToolDefinition[] = []
  let ws: WebSocketLike | null = null
  let ready = false
  let closing = false
  let closedEmitted = false
  let resumptionHandle: string | null = null
  let resuming: Promise<void> | null = null
  let goAwayPending = false
  let responseSeq = 0
  let active: ActiveResponse | null = null
  /** Ignore model content until this turn ends (client-side cancel: Gemini has no response.cancel). */
  let dropUntilTurnEnd = false
  let userText = ''
  let userFinalSent = true
  let generating = false
  const pendingClientContent: string[] = []
  /** Tool calls the server has asked for and that still wait for their responses. */
  const pendingCallNames = new Map<string, string>()
  let appendBuffer: Int16Array[] = []
  let appendSamples = 0
  /** A socket whose setup completed but that `connect`/`resume` has not adopted as `ws` yet. */
  let adopting: WebSocketLike | null = null

  function send(obj: Record<string, unknown>): void {
    if (!ws || ws.readyState !== WS_READY_STATE.OPEN) return
    ws.send(JSON.stringify(obj))
  }

  function setupMessage(handle: string | null): Record<string, unknown> {
    const voice = (init?.voice || options.voice || '').trim()
    const decls = buildGeminiFunctionDeclarations(tools, model)
    return {
      setup: {
        model: model.startsWith('models/') ? model : `models/${model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          ...(voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } : {}),
        },
        systemInstruction: { parts: [{ text: init?.instructions ?? '' }] },
        ...(decls.length > 0 ? { tools: [{ functionDeclarations: decls }] } : {}),
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            ...(options.vad?.startOfSpeechSensitivity ? { startOfSpeechSensitivity: options.vad.startOfSpeechSensitivity } : {}),
            ...(options.vad?.endOfSpeechSensitivity ? { endOfSpeechSensitivity: options.vad.endOfSpeechSensitivity } : {}),
            prefixPaddingMs: options.vad?.prefixPaddingMs ?? 300,
            silenceDurationMs: options.vad?.silenceDurationMs ?? 700,
          },
          activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        ...(options.contextCompression !== false ? { contextWindowCompression: { slidingWindow: {} } } : {}),
        ...(resumptionEnabled ? { sessionResumption: handle ? { handle } : {} } : {}),
      },
    }
  }

  function startResponse(): ActiveResponse {
    responseSeq += 1
    const r: ActiveResponse = { localId: `gem_${responseSeq}`, text: '', audioSamples: 0, cancelled: false, calls: [] }
    active = r
    generating = true
    emitter.emit('response_started', { responseId: r.localId })
    return r
  }

  function audioMsOf(r: ActiveResponse): number {
    return (r.audioSamples / caps.outputSampleRate) * 1000
  }

  function finish(r: ActiveResponse, cancelled: boolean, reason?: VoiceSessionCancelReason, detail?: string): void {
    if (active === r) active = null
    emitter.emit('response_done', {
      responseId: r.localId,
      text: r.text,
      audioMs: audioMsOf(r),
      cancelled,
      ...(cancelled && reason ? { cancelReason: reason } : {}),
      ...(detail ? { detail } : {}),
      ...(!cancelled && r.calls.length > 0 ? { toolCalls: r.calls.slice() } : {}),
    })
  }

  function emitUserFinal(): void {
    if (userFinalSent) return
    userFinalSent = true
    const text = userText.trim()
    userText = ''
    emitter.emit('user_transcript', { text, final: true })
  }

  function flushClientContent(): void {
    if (generating || active || pendingCallNames.size > 0 || !ready) return
    while (pendingClientContent.length > 0) {
      const text = pendingClientContent.shift()!
      send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: false } })
    }
  }

  function onTurnEnd(): void {
    generating = false
    dropUntilTurnEnd = false
    emitUserFinal()
    flushClientContent()
    if (goAwayPending) void resume('goAway')
  }

  function handleServerContent(sc: Record<string, unknown>): void {
    const input = (sc.inputTranscription as { text?: unknown } | undefined)?.text
    if (typeof input === 'string' && input) {
      if (userFinalSent) {
        userFinalSent = false
        userText = ''
      }
      userText += input
      emitter.emit('user_transcript', { text: userText.trim(), final: false })
    }
    if (sc.interrupted === true) {
      // Server VAD heard the user over Ashy: barge-in (playback stops; history keeps what was sent).
      const r = active
      emitter.emit('user_speech_started', {})
      // The engine's barge-in may already have cancelled it (cancelResponse → finish).
      if (r && active === r) finish(r, true, 'server', 'interrupted')
      generating = false
      dropUntilTurnEnd = false
      return
    }
    const turn = sc.modelTurn as { parts?: unknown } | undefined
    if (turn && Array.isArray(turn.parts) && !dropUntilTurnEnd) {
      for (const part of turn.parts as Array<Record<string, unknown>>) {
        const inline = part?.inlineData as { data?: unknown; mimeType?: unknown } | undefined
        if (inline && typeof inline.data === 'string' && /^audio\//i.test(str(inline.mimeType) || 'audio/pcm')) {
          const pcm = base64ToInt16(inline.data)
          if (pcm.length === 0) continue
          const r = active ?? startResponse()
          const rate = Number(/rate=(\d+)/i.exec(str(inline.mimeType))?.[1]) || caps.outputSampleRate
          r.audioSamples += Math.round(pcm.length * (caps.outputSampleRate / rate))
          emitter.emit('response_audio', { responseId: r.localId, pcm, sampleRate: rate })
        }
      }
    }
    const out = (sc.outputTranscription as { text?: unknown } | undefined)?.text
    if (typeof out === 'string' && out && !dropUntilTurnEnd) {
      const r = active ?? startResponse()
      r.text += out
      emitter.emit('response_text', { responseId: r.localId, delta: out, text: r.text })
    }
    if (sc.generationComplete === true) generating = false
    if (sc.turnComplete === true) {
      const r = active
      if (r) finish(r, false)
      onTurnEnd()
    }
  }

  function handleToolCall(tc: Record<string, unknown>): void {
    const calls = Array.isArray(tc.functionCalls) ? (tc.functionCalls as Array<Record<string, unknown>>) : []
    if (calls.length === 0) return
    const r = active ?? startResponse()
    for (const c of calls) {
      const id = str(c.id) || `gcall_${r.localId}_${r.calls.length + 1}`
      const name = str(c.name)
      if (!name) continue
      const args = c.args && typeof c.args === 'object' ? JSON.stringify(c.args) : '{}'
      pendingCallNames.set(id, name)
      r.calls.push({ callId: id, name, arguments: args })
      emitter.emit('tool_call', { callId: id, name, arguments: args, responseId: r.localId })
    }
    // The model waits for the results (BLOCKING): this "response" is over, the answer comes after
    // the toolResponse as a new model turn.
    generating = false
    finish(r, false)
  }

  function handleMessage(msg: Record<string, unknown>): void {
    if (msg.serverContent && typeof msg.serverContent === 'object') handleServerContent(msg.serverContent as Record<string, unknown>)
    if (msg.toolCall && typeof msg.toolCall === 'object') handleToolCall(msg.toolCall as Record<string, unknown>)
    if (msg.toolCallCancellation && typeof msg.toolCallCancellation === 'object') {
      const ids = (msg.toolCallCancellation as { ids?: unknown }).ids
      if (Array.isArray(ids)) for (const id of ids) pendingCallNames.delete(String(id))
    }
    if (msg.sessionResumptionUpdate && typeof msg.sessionResumptionUpdate === 'object') {
      const u = msg.sessionResumptionUpdate as { newHandle?: unknown; resumable?: unknown }
      if (u.resumable !== false && typeof u.newHandle === 'string' && u.newHandle) resumptionHandle = u.newHandle
    }
    if (msg.goAway && typeof msg.goAway === 'object') {
      goAwayPending = true
      if (!active && !generating) void resume('goAway')
    }
  }

  /** Opens a socket and runs the setup handshake. Resolves with the socket once `setupComplete`. */
  function openSocket(handle: string | null): Promise<WebSocketLike> {
    return new Promise<WebSocketLike>((resolve, reject) => {
      let settled = false
      let socket: WebSocketLike
      const timeout = timers.setTimeout(() => fail(new Error('gemini live setup timeout')), handshakeTimeoutMs)
      function fail(err: Error): void {
        if (settled) return
        settled = true
        timers.clearTimeout(timeout)
        try {
          socket?.close()
        } catch {
          // ignore
        }
        reject(err)
      }
      try {
        socket = wsFactory(url)
      } catch (err) {
        settled = true
        timers.clearTimeout(timeout)
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      try {
        ;(socket as unknown as { binaryType?: string }).binaryType = 'arraybuffer'
      } catch {
        // ignore
      }
      socket.onopen = () => {
        socket.send(JSON.stringify(setupMessage(handle)))
      }
      socket.onerror = () => {
        if (settled && ws === socket) emitter.emit('error', { message: 'gemini live websocket error', fatal: false })
      }
      socket.onclose = (event) => {
        if (!settled) {
          const described = describeCloudCloseCode(event?.code, event?.reason)
          fail(new Error(described ?? `gemini live closed during setup (${event?.code ?? '?'}${event?.reason ? `: ${event.reason}` : ''})`))
          return
        }
        onSocketClosed(socket, event)
      }
      socket.onmessage = (event) => {
        const raw = decodeData(event?.data)
        if (raw === null) return
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return
        }
        if (!settled) {
          if (msg.setupComplete !== undefined) {
            settled = true
            timers.clearTimeout(timeout)
            // Messages right after setupComplete (e.g. sessionResumptionUpdate) must not be lost.
            adopting = socket
            resolve(socket)
          }
          if (msg.sessionResumptionUpdate) handleMessage({ sessionResumptionUpdate: msg.sessionResumptionUpdate })
          return
        }
        if (ws === socket || adopting === socket) handleMessage(msg)
      }
    })
  }

  function onSocketClosed(socket: WebSocketLike, event: { code?: number; reason?: string }): void {
    if (ws !== socket) return // an old socket replaced by a resumption
    ws = null
    const wasReady = ready
    ready = false
    if (!closing && resumptionEnabled && resumptionHandle && (goAwayPending || event?.code === 1000 || event?.code === 1001)) {
      // Connection lifetime reached: resume transparently.
      void resume('connection closed')
      return
    }
    const r = active
    active = null
    if (r) finish(r, true, 'server', 'connection closed')
    if (!closedEmitted) {
      closedEmitted = true
      const described = describeCloudCloseCode(event?.code, event?.reason)
      emitter.emit('closed', {
        ...(typeof event?.code === 'number' ? { code: event.code } : {}),
        ...(described ? { reason: described } : typeof event?.reason === 'string' ? { reason: event.reason } : {}),
        expected: closing || !wasReady,
      })
    }
  }

  function resume(why: string): Promise<void> {
    if (resuming || closing || !resumptionEnabled) return resuming ?? Promise.resolve()
    const handle = resumptionHandle
    if (!handle) return Promise.resolve()
    goAwayPending = false
    const old = ws
    resuming = openSocket(handle)
      .then((socket) => {
        if (closing) {
          try {
            socket.close(1000, 'call ended')
          } catch {
            // ignore
          }
          return
        }
        ws = socket
        adopting = null
        ready = true
        if (old && old !== socket) {
          try {
            old.close(1000, 'resumed')
          } catch {
            // ignore
          }
        }
        flushClientContent()
      })
      .catch((err: unknown) => {
        if (closing) return
        if (old && ws === old && old.readyState === WS_READY_STATE.OPEN) return // keep the current one
        ws = null
        ready = false
        const r = active
        active = null
        if (r) finish(r, true, 'server', 'resumption failed')
        if (!closedEmitted) {
          closedEmitted = true
          emitter.emit('closed', { code: 1011, reason: `gemini resumption failed (${why}): ${String((err as Error)?.message ?? err)}`, expected: false })
        }
      })
      .finally(() => {
        resuming = null
      })
    return resuming
  }

  function flushAppend(): void {
    if (appendSamples === 0) return
    const merged = new Int16Array(appendSamples)
    let off = 0
    for (const c of appendBuffer) {
      merged.set(c, off)
      off += c.length
    }
    appendBuffer = []
    appendSamples = 0
    send({ realtimeInput: { audio: { data: int16ToBase64(merged), mimeType: `audio/pcm;rate=${caps.inputSampleRate}` } } })
  }

  function assertReady(op: string): boolean {
    if (!ready) {
      emitter.emit('error', { message: `${op} before setupComplete`, code: 'not_ready', fatal: false })
      return false
    }
    return true
  }

  const session: GeminiLiveSession = {
    get caps() {
      return caps
    },
    get connected() {
      return ready
    },
    get resumptionHandle() {
      return resumptionHandle
    },
    url,
    async connect(sessionInit: VoiceSessionInit): Promise<void> {
      if (ws) throw new Error('GeminiLiveSession already connected')
      if (typeof sessionInit?.instructions !== 'string') throw new Error('GeminiLiveSession.connect requires host-provided instructions')
      init = sessionInit
      tools = Array.isArray(sessionInit.tools) ? sessionInit.tools.filter((t) => t && typeof t.name === 'string' && t.name) : []
      closing = false
      closedEmitted = false
      const socket = await openSocket(null)
      ws = socket
      adopting = null
      ready = true
    },
    pushAudio(pcm: Int16Array): void {
      if (!ready || pcm.length === 0) return
      appendBuffer.push(pcm)
      appendSamples += pcm.length
      if (appendSamples >= Math.round((caps.inputSampleRate * appendChunkMs) / 1000)) flushAppend()
    },
    commitUserTurn(): void {
      // Automatic activity detection: the server ends the turn. Flush what is buffered.
      flushAppend()
    },
    endAudioStream(): void {
      if (!ready) return
      flushAppend()
      send({ realtimeInput: { audioStreamEnd: true } })
    },
    respond(opts?: { contextText?: string } & VoiceSubmitOptions): void {
      if (!assertReady('respond')) return
      // Proactive turn (inject): the context is a user-role note and the model answers it.
      const text = opts?.contextText?.trim() || '[Contexto] Continue a conversa naturalmente.'
      send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } })
      generating = true
    },
    submitToolResults(results: VoiceToolResult[]): void {
      if (!assertReady('submitToolResults')) return
      const functionResponses = results
        .filter((r) => r && typeof r.callId === 'string' && r.callId)
        .map((r) => {
          const name = pendingCallNames.get(r.callId) ?? ''
          pendingCallNames.delete(r.callId)
          let response: Record<string, unknown>
          try {
            const parsed = JSON.parse(String(r.output ?? ''))
            response = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { result: parsed } : { result: String(r.output ?? '') }
          } catch {
            response = { result: String(r.output ?? '') }
          }
          return {
            id: r.callId,
            name,
            response,
            ...(nonBlockingTools ? { scheduling: 'WHEN_IDLE' } : {}),
          }
        })
      if (functionResponses.length === 0) return
      send({ toolResponse: { functionResponses } })
      generating = true
    },
    cancelResponse(reason: VoiceSessionCancelReason = 'client'): void {
      const r = active
      if (!r || r.cancelled) return
      r.cancelled = true
      // No cancel in the Live API: drop the rest of this turn locally.
      dropUntilTurnEnd = true
      finish(r, true, reason)
    },
    async injectContext(text: string): Promise<void> {
      const t = text.trim()
      if (!t) return
      pendingClientContent.push(t)
      while (pendingClientContent.length > 3) pendingClientContent.shift()
      flushClientContent()
    },
    sendToolResult(callId: string, output: string): void {
      session.submitToolResults?.([{ callId, output }])
    },
    sendImage(jpegBase64: string): void {
      if (!ready || !jpegBase64) return
      send({ realtimeInput: { video: { data: jpegBase64, mimeType: 'image/jpeg' } } })
    },
    async close(): Promise<void> {
      closing = true
      ready = false
      active = null
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
