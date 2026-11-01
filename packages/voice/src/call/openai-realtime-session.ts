/**
 * Phase 10.4 — `OpenAIRealtimeSession`: VoiceSession over ANY OpenAI-Realtime-compatible WebSocket
 * (OpenAI GA Realtime, Alibaba Qwen-Omni realtime via DashScope, custom/Azure-style endpoints).
 * Protocol facts (verified 2026-11-01, see docs/superpowers/research/2026-11-01-cloud-realtime-backends.md):
 *
 * OpenAI GA (`dialect:'openai'`): server speaks first (`session.created`) → `session.update {type:'realtime',
 * instructions, output_modalities:['audio'], audio:{input:{format:{type:'audio/pcm',rate:24000},
 * transcription:{model,language}, turn_detection:{type:'semantic_vad'|'server_vad', create_response:false,
 * interrupt_response:true}}, output:{format, voice}}, tools, tool_choice:'auto'}` → wait `session.updated`.
 * Server VAD emits `input_audio_buffer.speech_started|speech_stopped|committed`; with
 * `create_response:false` the engine injects this turn's context and calls `respond()` →
 * `response.create {response:{instructions: base + context}}` (per-response override, nothing accumulates
 * in the conversation). Audio = `response.output_audio.delta` (pcm16 24 kHz), its transcript
 * `response.output_audio_transcript.delta`; user transcript = `conversation.item.input_audio_transcription.*`.
 * Barge-in: the server cancels on speech start (`interrupt_response`), the client stops playback and sends
 * `conversation.item.truncate {item_id, content_index:0, audio_end_ms}` so the model knows what was heard.
 * Tools: `response.function_call_arguments.done` / `function_call` output items of `response.done` →
 * `conversation.item.create {type:'function_call_output'}` → `response.create`.
 *
 * Qwen-Omni (`dialect:'qwen'`, DashScope): beta-style flat session (`modalities:['text','audio']`, `voice`,
 * `input_audio_format:'pcm'` 16 kHz, `output_audio_format:'pcm'` 24 kHz, `turn_detection:{type:'server_vad'}`,
 * `input_audio_transcription:{model}`, tools as `{type:'function', function:{name,description,parameters}}`).
 * The server answers by itself after VAD (`serverAutoResponse`), `response.create` takes no fields,
 * `conversation.item.create` only accepts `function_call_output`, there is no `conversation.item.truncate`,
 * images go through `input_image_buffer.append`. Per-turn context therefore goes in the (mutable)
 * session instructions.
 *
 * The API key is never handled here: the renderer connects to the host's loopback relay (or a URL the main
 * process authenticates), see apps/desktop/src/host/live-call/cloud-relay.ts.
 */
import type { CallToolDefinition } from '@ashy/shared'
import { base64ToInt16, int16ToBase64 } from './pcm-utils'
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
  type VoiceToolChoice,
  type VoiceToolResult,
  type WebSocketFactory,
  type WebSocketLike,
} from './types'

export type OpenAIRealtimeDialect = 'openai' | 'qwen'

/** Close codes the host relay uses when the upstream handshake fails (4000 + HTTP status). */
export const CLOUD_RELAY_CLOSE = {
  /** Upstream rejected the handshake with this HTTP status: code = 4000 + status. */
  HTTP_BASE: 4000,
  /** No API key stored for the provider. */
  NO_KEY: 4001,
  /** Upstream unreachable (DNS/TLS/timeout). */
  UNREACHABLE: 4002,
  /** Unknown relay target / bad relay token. */
  FORBIDDEN: 4003,
} as const

/** Human (PT) description of a relay/upstream close code, or null for ordinary codes. */
export function describeCloudCloseCode(code: number | undefined, reason?: string): string | null {
  if (typeof code !== 'number') return null
  const why = reason && reason.trim() ? ` — ${reason.trim().slice(0, 200)}` : ''
  if (code === CLOUD_RELAY_CLOSE.NO_KEY) return `chave de API ausente${why}`
  if (code === CLOUD_RELAY_CLOSE.UNREACHABLE) return `servidor de voz na nuvem inacessível${why}`
  if (code === CLOUD_RELAY_CLOSE.FORBIDDEN) return `relay recusou a conexão${why}`
  if (code > CLOUD_RELAY_CLOSE.HTTP_BASE && code < CLOUD_RELAY_CLOSE.HTTP_BASE + 600) {
    const status = code - CLOUD_RELAY_CLOSE.HTTP_BASE
    if (status === 401) return `chave de API inválida (HTTP 401)${why}`
    if (status === 403) return `acesso negado pelo provedor (HTTP 403)${why}`
    if (status === 404) return `modelo ou endpoint não encontrado (HTTP 404)${why}`
    if (status === 429) return `limite de uso/cota excedido (HTTP 429)${why}`
    return `o provedor recusou a conexão (HTTP ${status})${why}`
  }
  return null
}

export interface OpenAIRealtimeSessionOptions {
  /** ws(s) URL to open (host relay URL or a direct endpoint). `?model=` is appended unless present. */
  url: string
  model: string
  voice?: string
  dialect?: OpenAIRealtimeDialect
  /** OpenAI only: 'semantic_vad' (default) or 'server_vad'. Qwen always uses server_vad. */
  turnDetection?: 'semantic_vad' | 'server_vad'
  /** server_vad tuning. */
  vad?: { threshold?: number; silenceDurationMs?: number; prefixPaddingMs?: number }
  /** semantic_vad eagerness (OpenAI). */
  eagerness?: 'low' | 'medium' | 'high' | 'auto'
  /** Input transcription model (OpenAI default 'gpt-4o-mini-transcribe'; Qwen 'qwen3-asr-flash-realtime'). '' disables. */
  transcriptionModel?: string
  /** ISO-639-1 language hint for the input transcription (default 'pt'). */
  transcriptionLanguage?: string
  maxOutputTokens?: number
  webSocketFactory?: WebSocketFactory
  timers?: CallTimers
  handshakeTimeoutMs?: number
  /** Append chunk size in ms of input audio (default 60). */
  appendChunkMs?: number
}

export interface OpenAIRealtimeSession extends VoiceSession {
  readonly dialect: OpenAIRealtimeDialect
  readonly url: string
  readonly connected: boolean
  readonly hasTools: boolean
}

interface ActiveResponse {
  localId: string
  serverId: string | null
  text: string
  audioSamples: number
  started: boolean
  cancelled: boolean
  /** Assistant audio message item (for conversation.item.truncate). */
  audioItemId: string | null
  calls: Array<VoiceToolCall & { done: boolean }>
}

export const OPENAI_REALTIME_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']

export function buildOpenAIRealtimeUrl(url: string, model: string): string {
  const base = url.trim()
  if (!model || /[?&]model=/.test(base)) return base
  return `${base}${base.includes('?') ? '&' : '?'}model=${encodeURIComponent(model)}`
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

/** Qwen (DashScope) declares tools Chat-Completions style. */
function toQwenTool(t: CallToolDefinition): Record<string, unknown> {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }
}

export function createOpenAIRealtimeSession(options: OpenAIRealtimeSessionOptions): OpenAIRealtimeSession {
  const dialect: OpenAIRealtimeDialect = options.dialect ?? 'openai'
  const qwen = dialect === 'qwen'
  const wsFactory = options.webSocketFactory ?? createDefaultWebSocketFactory()
  const timers = options.timers ?? createDefaultCallTimers()
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15000
  const appendChunkMs = Math.max(20, Math.min(200, options.appendChunkMs ?? 60))
  const url = buildOpenAIRealtimeUrl(options.url, options.model)
  const transcriptionModel =
    options.transcriptionModel !== undefined
      ? options.transcriptionModel
      : qwen
        ? 'qwen3-asr-flash-realtime'
        : 'gpt-4o-mini-transcribe'
  const transcriptionLanguage = options.transcriptionLanguage ?? 'pt'

  const emitter = createEmitter<VoiceSessionEventMap>()
  const caps: VoiceSessionCapabilities = {
    serverTurnDetection: true,
    messageTruncation: !qwen,
    mutableInstructions: true,
    contextInjection: 'instructions',
    userTranscription: transcriptionModel.length > 0,
    toolCalls: true,
    imageInput: true,
    speakerReference: false,
    voices: qwen ? ['Tina', 'Ethan', 'Cherry'] : [...OPENAI_REALTIME_VOICES],
    inputSampleRate: qwen ? 16000 : 24000,
    outputSampleRate: 24000,
    serverAutoResponse: qwen,
    inlineToolCalls: true,
    managesContext: true,
  }

  let ws: WebSocketLike | null = null
  let ready = false
  let closing = false
  let closedEmitted = false
  let baseInstructions = ''
  let hasTools = false
  let responseSeq = 0
  let active: ActiveResponse | null = null
  /** Server ids of responses cancelled locally (their late events are ignored). */
  const ignoredServerIds = new Set<string>()
  /** Cancels sent before the server announced the response id. */
  let unmatchedCancels = 0
  /** Instructions of the current turn (base + context), reused by its tool follow-ups. */
  let turnInstructions: string | null = null
  /** Qwen: instructions currently applied via session.update. */
  let appliedInstructions = ''
  const userTranscripts = new Map<string, string>()
  let appendBuffer: Int16Array[] = []
  let appendSamples = 0
  let audioSentSinceOpen = false

  function send(obj: Record<string, unknown>): void {
    if (!ws || ws.readyState !== WS_READY_STATE.OPEN) return
    ws.send(JSON.stringify(obj))
  }

  function newActive(serverId: string | null): ActiveResponse {
    responseSeq += 1
    return {
      localId: `resp_${responseSeq}`,
      serverId,
      text: '',
      audioSamples: 0,
      started: false,
      cancelled: false,
      audioItemId: null,
      calls: [],
    }
  }

  function ensureStarted(r: ActiveResponse): void {
    if (r.started) return
    r.started = true
    emitter.emit('response_started', { responseId: r.localId })
  }

  function audioMsOf(r: ActiveResponse): number {
    return (r.audioSamples / caps.outputSampleRate) * 1000
  }

  function callsOf(r: ActiveResponse): VoiceToolCall[] {
    return r.calls.filter((c) => c.name).map(({ callId, name, arguments: a }) => ({ callId, name, arguments: a || '{}' }))
  }

  /** Audio item ids by local response id (kept after the response ends, for a late truncate). */
  const audioItemByResponse = new Map<string, { itemId: string; audioMs: number }>()

  function finish(r: ActiveResponse, cancelled: boolean, reason?: VoiceSessionCancelReason, detail?: string): void {
    ensureStarted(r)
    if (r.audioItemId) {
      audioItemByResponse.set(r.localId, { itemId: r.audioItemId, audioMs: audioMsOf(r) })
      while (audioItemByResponse.size > 8) {
        const first = audioItemByResponse.keys().next().value
        if (first === undefined) break
        audioItemByResponse.delete(first)
      }
    }
    const calls = cancelled ? [] : callsOf(r)
    emitter.emit('response_done', {
      responseId: r.localId,
      text: r.text,
      audioMs: audioMsOf(r),
      cancelled,
      ...(cancelled && reason ? { cancelReason: reason } : {}),
      ...(detail ? { detail } : {}),
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    })
  }

  /** The response the event belongs to (null = ignore it). Adopts server-initiated responses. */
  function responseFor(ev: Record<string, unknown>, adopt: boolean): ActiveResponse | null {
    const rid = str(ev.response_id) || str((ev.response as { id?: unknown } | undefined)?.id)
    if (rid && ignoredServerIds.has(rid)) return null
    if (active) {
      if (!active.serverId && rid) active.serverId = rid
      if (rid && active.serverId && rid !== active.serverId) {
        if (!adopt) return null
        // A new server response while ours is still open (server-initiated): the old one is over.
        const old = active
        active = null
        finish(old, false)
      } else {
        return active.cancelled ? null : active
      }
    }
    if (!adopt) return null
    if (rid && unmatchedCancels > 0) {
      unmatchedCancels -= 1
      ignoredServerIds.add(rid)
      return null
    }
    active = newActive(rid || null)
    return active
  }

  function upsertCall(r: ActiveResponse, callId: string, name: string): VoiceToolCall & { done: boolean } {
    let c = callId ? r.calls.find((x) => x.callId === callId) : undefined
    if (!c) {
      c = { callId: callId || `call_${r.localId}_${r.calls.length + 1}`, name, arguments: '', done: false }
      r.calls.push(c)
    } else if (name && !c.name) c.name = name
    return c
  }

  function handleEvent(ev: Record<string, unknown>): void {
    const type = str(ev.type)
    switch (type) {
      case 'input_audio_buffer.speech_started':
        emitter.emit('user_speech_started', {})
        return
      case 'input_audio_buffer.speech_stopped':
        emitter.emit('user_speech_stopped', {})
        return
      case 'input_audio_buffer.committed': {
        const itemId = str(ev.item_id)
        if (!qwen) emitter.emit('user_turn_committed', itemId ? { itemId } : {})
        return
      }
      case 'conversation.item.input_audio_transcription.delta': {
        const itemId = str(ev.item_id)
        const delta = str(ev.delta)
        if (!delta) return
        const text = (userTranscripts.get(itemId) ?? '') + delta
        userTranscripts.set(itemId, text)
        emitter.emit('user_transcript', { text, final: false, ...(itemId ? { itemId } : {}) })
        return
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const itemId = str(ev.item_id)
        const text = (str(ev.transcript) || userTranscripts.get(itemId) || '').trim()
        userTranscripts.delete(itemId)
        emitter.emit('user_transcript', { text, final: true, ...(itemId ? { itemId } : {}) })
        return
      }
      case 'conversation.item.input_audio_transcription.failed': {
        const itemId = str(ev.item_id)
        userTranscripts.delete(itemId)
        emitter.emit('user_transcript', { text: '', final: true, ...(itemId ? { itemId } : {}) })
        return
      }
      case 'response.created': {
        const r = responseFor(ev, true)
        if (r) ensureStarted(r)
        return
      }
      case 'response.output_item.added': {
        const r = responseFor(ev, true)
        if (!r) return
        const item = (ev.item ?? {}) as { id?: unknown; type?: unknown; call_id?: unknown; name?: unknown }
        ensureStarted(r)
        if (item.type === 'function_call') upsertCall(r, str(item.call_id), str(item.name))
        else if (item.type === 'message' && typeof item.id === 'string' && !r.audioItemId) r.audioItemId = item.id
        return
      }
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const r = responseFor(ev, true)
        if (!r) return
        const pcm = base64ToInt16(str(ev.delta))
        if (pcm.length === 0) return
        ensureStarted(r)
        if (!r.audioItemId && typeof ev.item_id === 'string') r.audioItemId = ev.item_id
        r.audioSamples += pcm.length
        emitter.emit('response_audio', { responseId: r.localId, pcm, sampleRate: caps.outputSampleRate })
        return
      }
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta':
      case 'response.text.delta': {
        const r = responseFor(ev, true)
        if (!r) return
        const delta = str(ev.delta)
        if (!delta) return
        ensureStarted(r)
        r.text += delta
        emitter.emit('response_text', { responseId: r.localId, delta, text: r.text })
        return
      }
      case 'response.function_call_arguments.done': {
        const r = responseFor(ev, true)
        if (!r) return
        ensureStarted(r)
        const callId = str(ev.call_id)
        const name = str(ev.name)
        const c =
          (callId ? r.calls.find((x) => x.callId === callId) : undefined) ??
          (!callId ? [...r.calls].reverse().find((x) => !x.done) : undefined) ??
          upsertCall(r, callId, name)
        if (name && !c.name) c.name = name
        c.arguments = str(ev.arguments) || '{}'
        c.done = true
        if (c.name) emitter.emit('tool_call', { callId: c.callId, name: c.name, arguments: c.arguments, responseId: r.localId })
        return
      }
      case 'response.done': {
        const resp = (ev.response ?? {}) as {
          id?: unknown
          status?: unknown
          output?: unknown
          status_details?: { error?: { message?: unknown; code?: unknown }; reason?: unknown } | null
        }
        const rid = str(resp.id)
        if (rid && ignoredServerIds.has(rid)) {
          ignoredServerIds.delete(rid)
          return
        }
        const r = responseFor(ev, false) ?? (active && !active.serverId ? active : null)
        if (!r) return
        // Complete function calls also live in response.done.output (GA docs).
        if (Array.isArray(resp.output)) {
          for (const item of resp.output as Array<Record<string, unknown>>) {
            if (item?.type === 'function_call') {
              const c = upsertCall(r, str(item.call_id), str(item.name))
              if (!c.done) {
                c.arguments = str(item.arguments) || c.arguments || '{}'
                c.done = true
              }
            } else if (item?.type === 'message' && typeof item.id === 'string' && !r.audioItemId) {
              r.audioItemId = item.id
            }
          }
        }
        active = null
        const status = str(resp.status)
        if (status === 'failed') {
          const msg = str(resp.status_details?.error?.message) || 'response failed'
          const code = str(resp.status_details?.error?.code)
          emitter.emit('error', { message: msg, ...(code ? { code } : {}), fatal: false })
        }
        const cancelled = status === 'cancelled'
        const detail = status === 'incomplete' ? `incomplete: ${str(resp.status_details?.reason) || '?'}` : undefined
        finish(r, cancelled, cancelled ? 'server' : undefined, detail)
        return
      }
      case 'error': {
        const err = (ev.error ?? {}) as { message?: unknown; code?: unknown; type?: unknown }
        const code = str(err.code) || str(err.type)
        const message = str(err.message) || 'realtime error'
        // Cancelling a response that already ended is harmless.
        if (code === 'response_cancel_not_active') return
        const fatal = code === 'session_expired' || /session.*(expired|maximum duration)/i.test(message)
        emitter.emit('error', { message, ...(code ? { code } : {}), fatal })
        return
      }
      default:
        return
    }
  }

  function buildSessionUpdate(init: VoiceSessionInit, tools: CallToolDefinition[]): Record<string, unknown> {
    const voice = (init.voice || options.voice || '').trim()
    if (qwen) {
      return {
        modalities: ['text', 'audio'],
        ...(voice ? { voice } : {}),
        input_audio_format: 'pcm',
        output_audio_format: 'pcm',
        instructions: init.instructions,
        ...(transcriptionModel ? { input_audio_transcription: { model: transcriptionModel } } : {}),
        turn_detection: {
          type: 'server_vad',
          threshold: options.vad?.threshold ?? 0.5,
          silence_duration_ms: options.vad?.silenceDurationMs ?? 800,
          ...(options.vad?.prefixPaddingMs !== undefined ? { prefix_padding_ms: options.vad.prefixPaddingMs } : {}),
        },
        ...(tools.length > 0 ? { tools: tools.map(toQwenTool) } : {}),
        ...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {}),
      }
    }
    const td = options.turnDetection ?? 'semantic_vad'
    const turnDetection =
      td === 'server_vad'
        ? {
            type: 'server_vad',
            threshold: options.vad?.threshold ?? 0.5,
            prefix_padding_ms: options.vad?.prefixPaddingMs ?? 300,
            silence_duration_ms: options.vad?.silenceDurationMs ?? 600,
            create_response: false,
            interrupt_response: true,
          }
        : { type: 'semantic_vad', eagerness: options.eagerness ?? 'auto', create_response: false, interrupt_response: true }
    return {
      type: 'realtime',
      instructions: init.instructions,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          ...(transcriptionModel
            ? { transcription: { model: transcriptionModel, ...(transcriptionLanguage ? { language: transcriptionLanguage } : {}) } }
            : {}),
          turn_detection: turnDetection,
        },
        output: { format: { type: 'audio/pcm', rate: 24000 }, ...(voice ? { voice } : {}) },
      },
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      ...(options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {}),
    }
  }

  function connect(init: VoiceSessionInit): Promise<void> {
    if (ws) return Promise.reject(new Error('OpenAIRealtimeSession already connected'))
    if (typeof init?.instructions !== 'string') {
      return Promise.reject(new Error('OpenAIRealtimeSession.connect requires host-provided instructions'))
    }
    closing = false
    closedEmitted = false
    baseInstructions = init.instructions
    appliedInstructions = init.instructions
    const tools = Array.isArray(init.tools) ? init.tools.filter((t) => t && typeof t.name === 'string' && t.name.length > 0) : []
    hasTools = tools.length > 0

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let phase: 'open' | 'created' | 'updated' = 'open'
      const timeout = timers.setTimeout(() => fail(new Error(`cloud realtime handshake timeout (${phase})`)), handshakeTimeoutMs)
      function fail(err: Error): void {
        if (settled) return
        settled = true
        timers.clearTimeout(timeout)
        const s = ws
        ws = null
        try {
          s?.close()
        } catch {
          // ignore
        }
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
      try {
        ;(socket as unknown as { binaryType?: string }).binaryType = 'arraybuffer'
      } catch {
        // not settable on this implementation
      }
      socket.onopen = () => {
        // The server speaks first (session.created).
      }
      socket.onerror = () => {
        if (!settled) return // the close event carries the reason
        emitter.emit('error', { message: 'cloud realtime websocket error', fatal: false })
      }
      socket.onclose = (event) => {
        const wasReady = ready
        ready = false
        if (ws === socket) ws = null
        const described = describeCloudCloseCode(event?.code, event?.reason)
        if (!settled) {
          fail(new Error(described ?? `cloud realtime websocket closed during handshake (${event?.code ?? '?'}${event?.reason ? `: ${event.reason}` : ''})`))
          return
        }
        const r = active
        active = null
        if (r) finish(r, true, 'server', 'connection closed')
        if (!closedEmitted) {
          closedEmitted = true
          emitter.emit('closed', {
            ...(typeof event?.code === 'number' ? { code: event.code } : {}),
            ...(described ? { reason: described } : typeof event?.reason === 'string' ? { reason: event.reason } : {}),
            expected: closing || !wasReady,
          })
        }
      }
      socket.onmessage = (event) => {
        const raw = decodeData(event?.data)
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
            send({ type: 'session.update', session: buildSessionUpdate(init, tools) })
          } else if (ev.type === 'session.updated' && phase === 'created') {
            phase = 'updated'
            succeed()
          } else if (ev.type === 'error') {
            const e = (ev.error ?? {}) as { message?: unknown; code?: unknown }
            fail(new Error(`cloud realtime handshake error: ${str(e.message) || str(e.code) || 'unknown'}`))
          }
          return
        }
        handleEvent(ev)
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
    if (appendSamples === 0) return
    const merged = new Int16Array(appendSamples)
    let off = 0
    for (const c of appendBuffer) {
      merged.set(c, off)
      off += c.length
    }
    appendBuffer = []
    appendSamples = 0
    audioSentSinceOpen = true
    send({ type: 'input_audio_buffer.append', audio: int16ToBase64(merged) })
  }

  function withContext(context: string): string {
    const ctx = context.trim()
    return ctx ? `${baseInstructions}\n\n${ctx}` : baseInstructions
  }

  /** Qwen: per-turn context lives in the session instructions (no per-response override). */
  function applyQwenInstructions(next: string): void {
    if (next === appliedInstructions) return
    appliedInstructions = next
    send({ type: 'session.update', session: { instructions: next } })
  }

  function startResponse(instructions: string | null, choice?: VoiceToolChoice): void {
    if (active && !active.cancelled) cancelActive('client')
    active = newActive(null)
    if (qwen) {
      if (instructions !== null) applyQwenInstructions(instructions)
      send({ type: 'response.create' })
      return
    }
    const response: Record<string, unknown> = {}
    if (instructions !== null) response.instructions = instructions
    if (hasTools && choice) response.tool_choice = choice
    send({ type: 'response.create', ...(Object.keys(response).length > 0 ? { response } : {}) })
  }

  function cancelActive(reason: VoiceSessionCancelReason): void {
    const r = active
    if (!r || r.cancelled) return
    r.cancelled = true
    active = null
    if (r.serverId) ignoredServerIds.add(r.serverId)
    else unmatchedCancels += 1
    send({ type: 'response.cancel' })
    finish(r, true, reason)
  }

  const session: OpenAIRealtimeSession = {
    get caps() {
      return caps
    },
    get connected() {
      return ready
    },
    get hasTools() {
      return hasTools
    },
    dialect,
    url,
    connect,
    pushAudio(pcm: Int16Array): void {
      if (!ready || pcm.length === 0) return
      appendBuffer.push(pcm)
      appendSamples += pcm.length
      if (appendSamples >= Math.round((caps.inputSampleRate * appendChunkMs) / 1000)) flushAppend()
    },
    commitUserTurn(): void {
      if (!assertReady('commitUserTurn')) return
      flushAppend()
      send({ type: 'input_audio_buffer.commit' })
    },
    endAudioStream(): void {
      if (!ready) return
      appendBuffer = []
      appendSamples = 0
      send({ type: 'input_audio_buffer.clear' })
    },
    respond(opts?: { contextText?: string } & VoiceSubmitOptions): void {
      if (!assertReady('respond')) return
      const ctx = opts?.contextText?.trim() ?? ''
      turnInstructions = ctx ? withContext(ctx) : null
      // Qwen without context: back to the base instructions for this response.
      startResponse(turnInstructions ?? (qwen ? baseInstructions : null), opts?.toolChoice === 'none' ? 'none' : 'auto')
    },
    submitUserText(text: string, contextOrOptions?: string | VoiceSubmitOptions, maybeOptions?: VoiceSubmitOptions): void {
      if (!assertReady('submitUserText')) return
      const ctx = typeof contextOrOptions === 'string' ? contextOrOptions : ''
      const opts = typeof contextOrOptions === 'object' && contextOrOptions !== null ? contextOrOptions : maybeOptions
      const t = text.trim()
      if (t && !qwen) {
        send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] } })
      }
      turnInstructions = ctx.trim() ? withContext(ctx) : null
      startResponse(turnInstructions ?? (qwen ? baseInstructions : null), opts?.toolChoice === 'none' ? 'none' : 'auto')
    },
    submitToolResults(results: VoiceToolResult[], opts?: VoiceSubmitOptions): void {
      if (!assertReady('submitToolResults')) return
      for (const r of results) {
        if (!r || typeof r.callId !== 'string' || !r.callId) continue
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: r.callId, output: String(r.output ?? '') } })
      }
      startResponse(turnInstructions, opts?.toolChoice ?? 'auto')
    },
    cancelResponse(reason: VoiceSessionCancelReason = 'client'): void {
      cancelActive(reason)
    },
    async truncate(responseId: string, playedMs: number): Promise<void> {
      if (qwen || !ready) return
      const known =
        audioItemByResponse.get(responseId) ??
        (active && active.localId === responseId && active.audioItemId
          ? { itemId: active.audioItemId, audioMs: audioMsOf(active) }
          : null)
      if (!known) return
      // audio_end_ms beyond the audio actually generated is an error.
      const end = Math.max(0, Math.min(Math.floor(playedMs), Math.floor(known.audioMs) - 1))
      send({ type: 'conversation.item.truncate', item_id: known.itemId, content_index: 0, audio_end_ms: end })
    },
    async injectContext(text: string): Promise<void> {
      if (!assertReady('injectContext')) return
      const t = text.trim()
      if (!t) return
      if (qwen) {
        applyQwenInstructions(withContext(t))
        return
      }
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: t }] } })
    },
    sendToolResult(callId: string, output: string): void {
      if (!assertReady('sendToolResult')) return
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } })
    },
    sendImage(jpegBase64: string): void {
      if (!ready || !jpegBase64) return
      if (qwen) {
        // DashScope: at least one audio append must precede the first image.
        if (!audioSentSinceOpen) return
        send({ type: 'input_image_buffer.append', image: jpegBase64 })
        return
      }
      send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${jpegBase64}` }] },
      })
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
