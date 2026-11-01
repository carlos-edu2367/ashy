/**
 * Phase 10.4 test fakes: scripted cloud speech-to-speech WebSocket servers that replay realistic
 * event sequences of the OpenAI GA Realtime API, DashScope Qwen-Omni realtime and Gemini Live
 * (BidiGenerateContent). No network: the factory hands the session an in-memory socket.
 */
import type { WebSocketFactory, WebSocketLike } from '../../src'
import { pcmBase64 } from './phase10-1-fakes'

export interface CloudFakeSocket extends WebSocketLike {
  url: string
  sent: Array<Record<string, unknown>>
  closedWith: { code?: number; reason?: string } | null
  deliver(event: Record<string, unknown>): void
  /** Delivers JSON as a binary frame (Gemini sends binary). */
  deliverBinary(event: Record<string, unknown>): void
  serverClose(code?: number, reason?: string): void
}

export interface CloudFakeServerOptions {
  /** First server message after open (OpenAI: session.created). Null = client speaks first (Gemini). */
  greeting?: Record<string, unknown> | null
  /** Auto-reply to the client's handshake message. */
  onClientMessage?: (socket: CloudFakeSocket, msg: Record<string, unknown>) => void
  /** Reject the handshake: close right after open with this code/reason (relay upstream failure). */
  rejectWith?: { code: number; reason: string }
}

export function createCloudFakeServer(opts: CloudFakeServerOptions = {}) {
  const sockets: CloudFakeSocket[] = []
  const factory: WebSocketFactory = (url: string) => {
    const socket: CloudFakeSocket = {
      url,
      readyState: 0,
      sent: [],
      closedWith: null,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data: string) {
        const msg = JSON.parse(data) as Record<string, unknown>
        socket.sent.push(msg)
        opts.onClientMessage?.(socket, msg)
      },
      close(code?: number, reason?: string) {
        if (socket.readyState === 3) return
        ;(socket as { readyState: number }).readyState = 3
        socket.closedWith = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) }
        queueMicrotask(() => socket.onclose?.({ code: code ?? 1000, reason: reason ?? 'client close' }))
      },
      deliver(event) {
        if (socket.readyState !== 1) return
        socket.onmessage?.({ data: JSON.stringify(event) })
      },
      deliverBinary(event) {
        if (socket.readyState !== 1) return
        socket.onmessage?.({ data: new TextEncoder().encode(JSON.stringify(event)).buffer })
      },
      serverClose(code = 1006, reason = 'server gone') {
        if (socket.readyState === 3) return
        ;(socket as { readyState: number }).readyState = 3
        socket.onclose?.({ code, reason })
      },
    }
    sockets.push(socket)
    queueMicrotask(() => {
      ;(socket as { readyState: number }).readyState = 1
      socket.onopen?.({})
      if (opts.rejectWith) {
        socket.serverClose(opts.rejectWith.code, opts.rejectWith.reason)
        return
      }
      if (opts.greeting) socket.deliver(opts.greeting)
    })
    return socket
  }
  return {
    factory,
    sockets,
    get last(): CloudFakeSocket {
      return sockets[sockets.length - 1]!
    },
  }
}

export function sentTypesOf(socket: CloudFakeSocket): string[] {
  return socket.sent.map((m) => String(m.type ?? Object.keys(m)[0]))
}

// ───────────────────────────── OpenAI GA Realtime ─────────────────────────────

export function createFakeOpenAIRealtimeServer(opts: { autoSessionUpdated?: boolean; rejectWith?: { code: number; reason: string } } = {}) {
  let responseCounter = 0
  let itemCounter = 0
  const server = createCloudFakeServer({
    greeting: { type: 'session.created', event_id: 'ev_1', session: { type: 'realtime', id: 'sess_1', model: 'gpt-realtime-2.1-mini' } },
    ...(opts.rejectWith ? { rejectWith: opts.rejectWith } : {}),
    onClientMessage(socket, msg) {
      if (msg.type === 'session.update' && opts.autoSessionUpdated !== false) {
        queueMicrotask(() => socket.deliver({ type: 'session.updated', session: msg.session }))
      }
    },
  })

  /** Server VAD: speech started → stopped → committed (+ optional transcription). */
  function userTurn(socket: CloudFakeSocket, transcript: string | null): string {
    const itemId = `item_user_${++itemCounter}`
    socket.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 100, item_id: itemId })
    socket.deliver({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1200, item_id: itemId })
    socket.deliver({ type: 'input_audio_buffer.committed', previous_item_id: null, item_id: itemId })
    socket.deliver({ type: 'conversation.item.added', item: { id: itemId, type: 'message', role: 'user', content: [{ type: 'input_audio' }] } })
    if (transcript !== null) userTranscript(socket, itemId, transcript)
    return itemId
  }

  function userTranscript(socket: CloudFakeSocket, itemId: string, transcript: string): void {
    const half = Math.ceil(transcript.length / 2)
    socket.deliver({ type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, content_index: 0, delta: transcript.slice(0, half) })
    socket.deliver({ type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, content_index: 0, delta: transcript.slice(half) })
    socket.deliver({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, content_index: 0, transcript })
  }

  /** A spoken response: created → message item → transcript/audio deltas → (done). */
  function streamResponse(
    socket: CloudFakeSocket,
    script: { text?: string[]; audioMs?: number[]; done?: boolean; functionCalls?: Array<{ name: string; arguments: string }> },
  ): { responseId: string; itemId: string; callIds: string[] } {
    const id = `resp_srv_${++responseCounter}`
    const itemId = `item_asst_${++itemCounter}`
    socket.deliver({ type: 'response.created', response: { id, status: 'in_progress', output: [] } })
    const texts = script.text ?? []
    const audios = script.audioMs ?? []
    if (texts.length > 0 || audios.length > 0) {
      socket.deliver({ type: 'response.output_item.added', response_id: id, output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
      const n = Math.max(texts.length, audios.length)
      for (let i = 0; i < n; i++) {
        if (texts[i] !== undefined) {
          socket.deliver({ type: 'response.output_audio_transcript.delta', response_id: id, item_id: itemId, output_index: 0, content_index: 0, delta: texts[i] })
        }
        if (audios[i] !== undefined) {
          socket.deliver({ type: 'response.output_audio.delta', response_id: id, item_id: itemId, output_index: 0, content_index: 0, delta: pcmBase64(audios[i]!, 24000) })
        }
      }
    }
    const callIds: string[] = []
    const output: Array<Record<string, unknown>> = []
    if (texts.length > 0 || audios.length > 0) output.push({ id: itemId, type: 'message', role: 'assistant' })
    for (const fc of script.functionCalls ?? []) {
      const callId = `call_${++itemCounter}`
      const fcItem = `item_fc_${itemCounter}`
      callIds.push(callId)
      socket.deliver({ type: 'response.output_item.added', response_id: id, output_index: output.length, item: { id: fcItem, type: 'function_call', call_id: callId, name: fc.name, arguments: '' } })
      socket.deliver({ type: 'response.function_call_arguments.delta', response_id: id, item_id: fcItem, call_id: callId, delta: fc.arguments })
      socket.deliver({ type: 'response.function_call_arguments.done', response_id: id, item_id: fcItem, call_id: callId, name: fc.name, arguments: fc.arguments })
      output.push({ id: fcItem, type: 'function_call', call_id: callId, name: fc.name, arguments: fc.arguments, status: 'completed' })
    }
    if (script.done !== false) socket.deliver({ type: 'response.done', response: { id, status: 'completed', output } })
    return { responseId: id, itemId, callIds }
  }

  function cancelResponse(socket: CloudFakeSocket, responseId: string): void {
    socket.deliver({ type: 'response.done', response: { id: responseId, status: 'cancelled', status_details: { type: 'cancelled', reason: 'turn_detected' }, output: [] } })
  }

  return Object.assign(server, { userTurn, userTranscript, streamResponse, cancelResponse })
}

// ───────────────────────────── DashScope Qwen-Omni realtime ─────────────────────────────

export function createFakeQwenRealtimeServer() {
  let responseCounter = 0
  let itemCounter = 0
  const server = createCloudFakeServer({
    greeting: { type: 'session.created', event_id: 'event_1', session: { id: 'sess_q', model: 'qwen3.5-omni-flash-realtime', modalities: ['text', 'audio'], voice: 'Tina' } },
    onClientMessage(socket, msg) {
      if (msg.type === 'session.update') queueMicrotask(() => socket.deliver({ type: 'session.updated', session: msg.session }))
    },
  })
  /** Server VAD turn + automatic response (beta-style event names). */
  function autoTurn(socket: CloudFakeSocket, transcript: string, reply: { text: string[]; audioMs: number[] }): { responseId: string } {
    const userItem = `item_${++itemCounter}`
    socket.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 200, item_id: userItem })
    socket.deliver({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1300, item_id: userItem })
    socket.deliver({ type: 'input_audio_buffer.committed', item_id: userItem })
    socket.deliver({ type: 'conversation.item.created', item: { id: userItem, role: 'user' } })
    socket.deliver({ type: 'conversation.item.input_audio_transcription.completed', item_id: userItem, content_index: 0, transcript })
    const id = `resp_q_${++responseCounter}`
    const asst = `item_${++itemCounter}`
    socket.deliver({ type: 'response.created', response: { id, status: 'in_progress' } })
    socket.deliver({ type: 'response.output_item.added', response_id: id, item: { id: asst, type: 'message', role: 'assistant' } })
    for (let i = 0; i < Math.max(reply.text.length, reply.audioMs.length); i++) {
      if (reply.text[i] !== undefined) socket.deliver({ type: 'response.audio_transcript.delta', response_id: id, item_id: asst, delta: reply.text[i] })
      if (reply.audioMs[i] !== undefined) socket.deliver({ type: 'response.audio.delta', response_id: id, item_id: asst, delta: pcmBase64(reply.audioMs[i]!, 24000) })
    }
    socket.deliver({ type: 'response.done', response: { id, status: 'completed', output: [{ id: asst, type: 'message' }] } })
    return { responseId: id }
  }
  return Object.assign(server, { autoTurn })
}

// ───────────────────────────── Gemini Live ─────────────────────────────

export function createFakeGeminiLiveServer(opts: { binary?: boolean; resumable?: boolean } = {}) {
  let handleCounter = 0
  const server = createCloudFakeServer({
    greeting: null,
    onClientMessage(socket, msg) {
      if (msg.setup) {
        queueMicrotask(() => {
          send(socket, { setupComplete: {} })
          if (opts.resumable !== false) send(socket, { sessionResumptionUpdate: { newHandle: `handle_${++handleCounter}`, resumable: true } })
        })
      }
    },
  })
  function send(socket: CloudFakeSocket, msg: Record<string, unknown>): void {
    if (opts.binary !== false) socket.deliverBinary(msg)
    else socket.deliver(msg)
  }
  /** The user speaks: input transcription fragments (no explicit VAD events in Gemini Live). */
  function userSpeech(socket: CloudFakeSocket, transcript: string): void {
    const words = transcript.split(' ')
    const mid = Math.ceil(words.length / 2)
    send(socket, { serverContent: { inputTranscription: { text: words.slice(0, mid).join(' ') } } })
    send(socket, { serverContent: { inputTranscription: { text: ` ${words.slice(mid).join(' ')}` } } })
  }
  /** The model answers: audio chunks + output transcription, then generationComplete/turnComplete. */
  function modelTurn(socket: CloudFakeSocket, script: { text?: string[]; audioMs?: number[]; complete?: boolean }): void {
    const texts = script.text ?? []
    const audios = script.audioMs ?? []
    for (let i = 0; i < Math.max(texts.length, audios.length); i++) {
      if (audios[i] !== undefined) {
        send(socket, { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmBase64(audios[i]!, 24000) } }] } } })
      }
      if (texts[i] !== undefined) send(socket, { serverContent: { outputTranscription: { text: texts[i] } } })
    }
    if (script.complete !== false) {
      send(socket, { serverContent: { generationComplete: true } })
      send(socket, { serverContent: { turnComplete: true }, usageMetadata: { totalTokenCount: 321 } })
    }
  }
  function interrupted(socket: CloudFakeSocket): void {
    send(socket, { serverContent: { interrupted: true } })
  }
  function toolCall(socket: CloudFakeSocket, calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): void {
    send(socket, { toolCall: { functionCalls: calls } })
  }
  function goAway(socket: CloudFakeSocket): void {
    send(socket, { goAway: { timeLeft: '10s' } })
  }
  return Object.assign(server, { send, userSpeech, modelTurn, interrupted, toolCall, goAway })
}
