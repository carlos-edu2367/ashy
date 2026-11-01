import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LIVE_MODE_SETTINGS, type CallToolDefinition } from '@ashy/shared'
import {
  CLOUD_RELAY_CLOSE,
  buildGeminiFunctionDeclarations,
  createCloudVoiceSession,
  createGeminiLiveSession,
  createOpenAIRealtimeSession,
  describeCloudCloseCode,
  toGeminiSchema,
  type VoiceSession,
  type VoiceSessionEventMap,
} from '../src'
import {
  createFakeGeminiLiveServer,
  createFakeOpenAIRealtimeServer,
  createFakeQwenRealtimeServer,
  sentTypesOf,
} from './helpers/phase10-4-cloud-fakes'
import { flush } from './helpers/phase10-1-fakes'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const TOOLS: CallToolDefinition[] = [
  { type: 'function', name: 'get_active_window_title', description: 'Returns the title of the active window.', parameters: { type: 'object', properties: {} } },
  {
    type: 'function',
    name: 'read_workspace_file',
    description: 'Reads a file.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative file path' } }, required: ['path'], additionalProperties: false },
  },
]

function record(session: VoiceSession) {
  const events: Array<{ type: keyof VoiceSessionEventMap; payload: unknown }> = []
  const types: Array<keyof VoiceSessionEventMap> = [
    'user_speech_started',
    'user_speech_stopped',
    'user_transcript',
    'user_turn_committed',
    'response_started',
    'response_text',
    'response_audio',
    'response_done',
    'tool_call',
    'error',
    'closed',
  ]
  for (const t of types) session.on(t, (payload) => events.push({ type: t, payload }))
  return {
    events,
    of<E extends keyof VoiceSessionEventMap>(t: E): Array<VoiceSessionEventMap[E]> {
      return events.filter((e) => e.type === t).map((e) => e.payload as VoiceSessionEventMap[E])
    },
  }
}

describe('Phase 10.4 OpenAIRealtimeSession (OpenAI GA dialect)', () => {
  async function connected(opts: { tools?: CallToolDefinition[] } = {}) {
    const server = createFakeOpenAIRealtimeServer()
    const session = createOpenAIRealtimeSession({
      url: 'ws://127.0.0.1:5555/cloud/call-1',
      model: 'gpt-realtime-2.1-mini',
      voice: 'marin',
      webSocketFactory: server.factory,
    })
    const rec = record(session)
    const p = session.connect({ instructions: 'Você é a Ashy.', ...(opts.tools ? { tools: opts.tools } : {}) })
    await flush()
    await p
    return { server, session, rec, ws: server.last }
  }

  it('handshake: waits session.created, sends a GA session.update (semantic VAD, create_response:false, transcription, pcm 24 kHz), resolves on session.updated', async () => {
    const { session, ws } = await connected({ tools: TOOLS })
    expect(ws.url).toBe('ws://127.0.0.1:5555/cloud/call-1?model=gpt-realtime-2.1-mini')
    expect(sentTypesOf(ws)).toEqual(['session.update'])
    const s = ws.sent[0]!.session as Record<string, any>
    expect(s.type).toBe('realtime')
    expect(s.instructions).toBe('Você é a Ashy.')
    expect(s.output_modalities).toEqual(['audio'])
    expect(s.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 })
    expect(s.audio.input.transcription).toEqual({ model: 'gpt-4o-mini-transcribe', language: 'pt' })
    expect(s.audio.input.turn_detection).toEqual({ type: 'semantic_vad', eagerness: 'auto', create_response: false, interrupt_response: true })
    expect(s.audio.output).toEqual({ format: { type: 'audio/pcm', rate: 24000 }, voice: 'marin' })
    expect(s.tools).toHaveLength(2)
    expect(s.tool_choice).toBe('auto')
    expect(session.caps).toMatchObject({
      serverTurnDetection: true,
      serverAutoResponse: false,
      messageTruncation: true,
      contextInjection: 'instructions',
      userTranscription: true,
      inlineToolCalls: true,
      managesContext: true,
      inputSampleRate: 24000,
      outputSampleRate: 24000,
    })
  })

  it('streams mic audio as input_audio_buffer.append chunks and maps server VAD + transcription events', async () => {
    const { server, session, rec, ws } = await connected()
    session.pushAudio(new Int16Array(24000 * 0.03)) // 30 ms: buffered
    expect(sentTypesOf(ws)).toEqual(['session.update'])
    session.pushAudio(new Int16Array(24000 * 0.04)) // 70 ms total ≥ 60 ms chunk
    expect(sentTypesOf(ws)).toEqual(['session.update', 'input_audio_buffer.append'])
    expect(typeof ws.sent[1]!.audio).toBe('string')

    const itemId = server.userTurn(ws, 'qual é o nome do meu cachorro?')
    expect(rec.of('user_speech_started')).toHaveLength(1)
    expect(rec.of('user_speech_stopped')).toHaveLength(1)
    expect(rec.of('user_turn_committed')).toEqual([{ itemId }])
    const transcripts = rec.of('user_transcript')
    expect(transcripts.at(-1)).toEqual({ text: 'qual é o nome do meu cachorro?', final: true, itemId })
    expect(transcripts.some((t) => !t.final)).toBe(true)
  })

  it("respond({contextText}) puts this turn's context in response.instructions (nothing accumulates); audio + transcript deltas → response events", async () => {
    const { server, session, rec, ws } = await connected()
    session.respond({ contextText: '[Contexto] Memórias relevantes:\n- O cachorro se chama Thor.' })
    const create = ws.sent.at(-1)!
    expect(create.type).toBe('response.create')
    expect((create.response as { instructions: string }).instructions).toBe(
      'Você é a Ashy.\n\n[Contexto] Memórias relevantes:\n- O cachorro se chama Thor.',
    )
    server.streamResponse(ws, { text: ['O nome dele ', 'é Thor!'], audioMs: [200, 300] })
    expect(rec.of('response_started')).toHaveLength(1)
    expect(rec.of('response_audio')).toHaveLength(2)
    expect(rec.of('response_audio')[0]!.sampleRate).toBe(24000)
    const done = rec.of('response_done')
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ text: 'O nome dele é Thor!', cancelled: false })
    expect(done[0]!.audioMs).toBeCloseTo(500, 0)
  })

  it('barge-in: cancelResponse + truncate(audio item, played ms) clamped to the generated audio', async () => {
    const { server, session, rec, ws } = await connected()
    session.respond()
    const { itemId } = server.streamResponse(ws, { text: ['Era uma vez '], audioMs: [800], done: false })
    const responseId = rec.of('response_started')[0]!.responseId
    session.cancelResponse('client')
    expect(rec.of('response_done')[0]).toMatchObject({ cancelled: true, cancelReason: 'client' })
    await session.truncate!(responseId, 430.7)
    expect(ws.sent.at(-2)).toEqual({ type: 'response.cancel' })
    expect(ws.sent.at(-1)).toEqual({ type: 'conversation.item.truncate', item_id: itemId, content_index: 0, audio_end_ms: 430 })
    await session.truncate!(responseId, 5000)
    expect(ws.sent.at(-1)).toMatchObject({ audio_end_ms: 799 })
    // Late events of the cancelled response are ignored.
    server.cancelResponse(ws, 'resp_srv_1')
    expect(rec.of('response_done')).toHaveLength(1)
  })

  it('server-side interruption (interrupt_response): speech_started then response.done cancelled', async () => {
    const { server, session, rec, ws } = await connected()
    session.respond()
    const { responseId } = server.streamResponse(ws, { audioMs: [500], done: false })
    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 900, item_id: 'item_x' })
    server.cancelResponse(ws, responseId)
    expect(rec.of('user_speech_started')).toHaveLength(1)
    expect(rec.of('response_done')[0]).toMatchObject({ cancelled: true, cancelReason: 'server' })
  })

  it('tool call round trip: function call in response.done → toolCalls; submitToolResults → function_call_output + response.create with the same turn instructions', async () => {
    const { server, session, rec, ws } = await connected({ tools: TOOLS })
    session.respond({ contextText: '[Contexto] hora 21:00' })
    const { callIds } = server.streamResponse(ws, {
      text: ['Vou olhar. '],
      audioMs: [300],
      functionCalls: [{ name: 'read_workspace_file', arguments: '{"path":"notas.txt"}' }],
    })
    expect(rec.of('tool_call')).toEqual([
      { callId: callIds[0], name: 'read_workspace_file', arguments: '{"path":"notas.txt"}', responseId: 'resp_1' },
    ])
    expect(rec.of('response_done')[0]!.toolCalls).toEqual([{ callId: callIds[0], name: 'read_workspace_file', arguments: '{"path":"notas.txt"}' }])
    session.submitToolResults!([{ callId: callIds[0]!, output: '{"conteudo":"comprar ração"}' }])
    expect(ws.sent.at(-2)).toEqual({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callIds[0], output: '{"conteudo":"comprar ração"}' },
    })
    expect(ws.sent.at(-1)).toEqual({
      type: 'response.create',
      response: { instructions: 'Você é a Ashy.\n\n[Contexto] hora 21:00', tool_choice: 'auto' },
    })
  })

  it('injectContext adds a system message item; sendImage sends an input_image data URL', async () => {
    const { session, ws } = await connected()
    await session.injectContext('[Contexto] O usuário aprovou a nota.')
    expect(ws.sent.at(-1)).toEqual({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: '[Contexto] O usuário aprovou a nota.' }] },
    })
    session.sendImage!('AAAA')
    expect((ws.sent.at(-1)!.item as any).content[0]).toEqual({ type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' })
  })

  it('session expiry is fatal; rate limits / cancel-not-active are not', async () => {
    const { session, rec, ws } = await connected()
    ws.deliver({ type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active', message: 'no active response' } })
    ws.deliver({ type: 'error', error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'slow down' } })
    ws.deliver({ type: 'error', error: { type: 'invalid_request_error', code: 'session_expired', message: 'Your session hit the maximum duration of 60 minutes.' } })
    expect(rec.of('error')).toEqual([
      { message: 'slow down', code: 'rate_limit_exceeded', fatal: false },
      { message: 'Your session hit the maximum duration of 60 minutes.', code: 'session_expired', fatal: true },
    ])
    void session
  })

  it('relay upstream rejection (HTTP 401 → close 4401) fails the handshake with a clear message', async () => {
    const server = createFakeOpenAIRealtimeServer({ rejectWith: { code: CLOUD_RELAY_CLOSE.HTTP_BASE + 401, reason: 'Incorrect API key provided' } })
    const session = createOpenAIRealtimeSession({ url: 'ws://127.0.0.1:1/cloud/x', model: 'm', webSocketFactory: server.factory })
    const p = session.connect({ instructions: 'x' })
    const assertion = expect(p).rejects.toThrow(/chave de API inválida \(HTTP 401\)/)
    await flush()
    await assertion
    expect(describeCloudCloseCode(4001)).toMatch(/chave de API ausente/)
    expect(describeCloudCloseCode(4429)).toMatch(/limite/)
    expect(describeCloudCloseCode(1000)).toBeNull()
  })
})

describe('Phase 10.4 OpenAIRealtimeSession (Qwen-Omni / DashScope dialect)', () => {
  async function connected() {
    const server = createFakeQwenRealtimeServer()
    const session = createOpenAIRealtimeSession({
      url: 'ws://127.0.0.1:5555/cloud/call-q',
      model: 'qwen3.5-omni-flash-realtime',
      voice: 'Tina',
      dialect: 'qwen',
      webSocketFactory: server.factory,
    })
    const rec = record(session)
    const p = session.connect({ instructions: 'Você é a Ashy.', tools: TOOLS })
    await flush()
    await p
    return { server, session, rec, ws: server.last }
  }

  it('flat DashScope session.update (pcm 16k in / 24k out, server_vad, qwen ASR, Chat-Completions-style tools)', async () => {
    const { session, ws } = await connected()
    expect(ws.url).toBe('ws://127.0.0.1:5555/cloud/call-q?model=qwen3.5-omni-flash-realtime')
    const s = ws.sent[0]!.session as Record<string, any>
    expect(s).toMatchObject({
      modalities: ['text', 'audio'],
      voice: 'Tina',
      input_audio_format: 'pcm',
      output_audio_format: 'pcm',
      instructions: 'Você é a Ashy.',
      input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
      turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800 },
    })
    expect(s.tools[1]).toEqual({ type: 'function', function: { name: 'read_workspace_file', description: 'Reads a file.', parameters: TOOLS[1]!.parameters } })
    expect(s.type).toBeUndefined()
    expect(session.caps).toMatchObject({ serverAutoResponse: true, messageTruncation: false, inputSampleRate: 16000, outputSampleRate: 24000 })
  })

  it('adopts the server-initiated response (beta event names) and never emits user_turn_committed', async () => {
    const { server, rec, ws } = await connected()
    server.autoTurn(ws, 'oi Ashy', { text: ['Oi! ', 'Tudo bem?'], audioMs: [200, 200] })
    expect(rec.of('user_turn_committed')).toHaveLength(0)
    expect(rec.of('user_transcript').at(-1)).toMatchObject({ text: 'oi Ashy', final: true })
    expect(rec.of('response_started')).toHaveLength(1)
    expect(rec.of('response_audio')).toHaveLength(2)
    expect(rec.of('response_done')[0]).toMatchObject({ text: 'Oi! Tudo bem?', cancelled: false })
  })

  it('per-turn context goes in the mutable session instructions; response.create has no fields; no truncate', async () => {
    const { session, ws } = await connected()
    await session.injectContext('[Contexto] Memórias: gosta de gatos.')
    expect(ws.sent.at(-1)).toEqual({ type: 'session.update', session: { instructions: 'Você é a Ashy.\n\n[Contexto] Memórias: gosta de gatos.' } })
    session.respond({ contextText: '[Contexto] A nota foi salva.' })
    expect(ws.sent.at(-2)).toEqual({ type: 'session.update', session: { instructions: 'Você é a Ashy.\n\n[Contexto] A nota foi salva.' } })
    expect(ws.sent.at(-1)).toEqual({ type: 'response.create' })
    const before = ws.sent.length
    await session.truncate!('resp_1', 100)
    expect(ws.sent.length).toBe(before)
    // Images: only after some audio was appended (DashScope rule).
    session.sendImage!('IMG')
    expect(ws.sent.length).toBe(before)
    session.pushAudio(new Int16Array(16000 * 0.1))
    session.sendImage!('IMG')
    expect(ws.sent.at(-1)).toEqual({ type: 'input_image_buffer.append', image: 'IMG' })
  })
})

describe('Phase 10.4 GeminiLiveSession', () => {
  async function connected(opts: { tools?: CallToolDefinition[]; model?: string } = {}) {
    const server = createFakeGeminiLiveServer()
    const session = createGeminiLiveSession({
      url: 'ws://127.0.0.1:5555/cloud/call-g',
      model: opts.model ?? 'gemini-3.8-live',
      voice: 'Kore',
      webSocketFactory: server.factory,
    })
    const rec = record(session)
    const p = session.connect({ instructions: 'Você é a Ashy. Fale sempre em português do Brasil.', ...(opts.tools ? { tools: opts.tools } : {}) })
    await flush()
    await p
    return { server, session, rec, ws: server.last }
  }

  it('setup: model, AUDIO, prebuilt voice, system instruction, tools (BLOCKING), automatic VAD, transcriptions, compression, resumption; waits setupComplete', async () => {
    const { session, ws } = await connected({ tools: TOOLS })
    expect(ws.url).toBe('ws://127.0.0.1:5555/cloud/call-g')
    const setup = ws.sent[0]!.setup as Record<string, any>
    expect(setup.model).toBe('models/gemini-3.8-live')
    expect(setup.generationConfig).toEqual({
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    })
    expect(setup.systemInstruction).toEqual({ parts: [{ text: 'Você é a Ashy. Fale sempre em português do Brasil.' }] })
    expect(setup.tools[0].functionDeclarations).toEqual([
      { name: 'get_active_window_title', description: 'Returns the title of the active window.', behavior: 'BLOCKING' },
      {
        name: 'read_workspace_file',
        description: 'Reads a file.',
        parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Relative file path' } }, required: ['path'] },
        behavior: 'BLOCKING',
      },
    ])
    expect(setup.realtimeInputConfig).toEqual({
      automaticActivityDetection: { disabled: false, prefixPaddingMs: 300, silenceDurationMs: 700 },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
    })
    expect(setup.inputAudioTranscription).toEqual({})
    expect(setup.outputAudioTranscription).toEqual({})
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} })
    expect(setup.sessionResumption).toEqual({})
    expect(setup.generationConfig.speechConfig.languageCode).toBeUndefined()
    expect(session.caps).toMatchObject({ serverTurnDetection: true, serverAutoResponse: true, contextInjection: 'client_content', inputSampleRate: 16000, outputSampleRate: 24000 })
    expect(session.resumptionHandle).toBe('handle_1')
  })

  it('extended-thinking models get NON_BLOCKING declarations', () => {
    expect(buildGeminiFunctionDeclarations(TOOLS, 'gemini-3.8-live-extended-thinking')[0]!.behavior).toBe('NON_BLOCKING')
    expect(toGeminiSchema({ type: 'array', items: { type: 'string', enum: ['a'] } })).toEqual({ type: 'ARRAY', items: { type: 'STRING', enum: ['a'] } })
  })

  it('mic → realtimeInput.audio (PCM16 16 kHz); model audio (binary frames) → response events; transcripts; turnComplete', async () => {
    const { server, session, rec, ws } = await connected()
    session.pushAudio(new Int16Array(16000 * 0.07))
    expect(ws.sent.at(-1)).toMatchObject({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000' } } })
    server.userSpeech(ws, 'me conta uma piada')
    expect(rec.of('user_transcript').at(-1)).toEqual({ text: 'me conta uma piada', final: false })
    server.modelTurn(ws, { text: ['Por que o pato ', 'atravessou a rua?'], audioMs: [300, 300] })
    expect(rec.of('response_started')).toHaveLength(1)
    expect(rec.of('response_audio')).toHaveLength(2)
    expect(rec.of('response_audio')[0]!.sampleRate).toBe(24000)
    expect(rec.of('response_done')[0]).toMatchObject({ text: 'Por que o pato atravessou a rua?', cancelled: false })
    expect(rec.of('user_transcript').at(-1)).toEqual({ text: 'me conta uma piada', final: true })
    session.endAudioStream!()
    expect(ws.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
  })

  it('interrupted → user_speech_started + response_done cancelled (server)', async () => {
    const { server, rec, ws } = await connected()
    server.modelTurn(ws, { audioMs: [400], complete: false })
    server.interrupted(ws)
    expect(rec.of('user_speech_started')).toHaveLength(1)
    expect(rec.of('response_done')[0]).toMatchObject({ cancelled: true, cancelReason: 'server' })
  })

  it('toolCall → tool_call + response_done(toolCalls); submitToolResults → toolResponse with names; the answer is a new response', async () => {
    const { server, session, rec, ws } = await connected({ tools: TOOLS })
    server.toolCall(ws, [{ id: 'fc_1', name: 'read_workspace_file', args: { path: 'notas.txt' } }])
    expect(rec.of('tool_call')[0]).toMatchObject({ callId: 'fc_1', name: 'read_workspace_file', arguments: '{"path":"notas.txt"}' })
    expect(rec.of('response_done')[0]!.toolCalls).toEqual([{ callId: 'fc_1', name: 'read_workspace_file', arguments: '{"path":"notas.txt"}' }])
    session.submitToolResults!([{ callId: 'fc_1', output: '{"conteudo":"comprar ração"}' }])
    expect(ws.sent.at(-1)).toEqual({
      toolResponse: { functionResponses: [{ id: 'fc_1', name: 'read_workspace_file', response: { result: { conteudo: 'comprar ração' } } }] },
    })
    server.modelTurn(ws, { text: ['Tem: comprar ração.'], audioMs: [300] })
    expect(rec.of('response_started')).toHaveLength(2)
    expect(rec.of('response_done')[1]).toMatchObject({ text: 'Tem: comprar ração.', cancelled: false })
  })

  it('injectContext waits for the model to be idle, then clientContent with turnComplete:false', async () => {
    const { server, session, ws } = await connected()
    server.modelTurn(ws, { audioMs: [200], complete: false })
    await session.injectContext('[Contexto] Memórias: o cachorro se chama Thor.')
    expect(ws.sent.some((m) => 'clientContent' in m)).toBe(false)
    server.send(ws, { serverContent: { turnComplete: true } })
    expect(ws.sent.at(-1)).toEqual({
      clientContent: { turns: [{ role: 'user', parts: [{ text: '[Contexto] Memórias: o cachorro se chama Thor.' }] }], turnComplete: false },
    })
  })

  it('GoAway → transparent resumption with the last handle (no closed event, old socket closed)', async () => {
    const { server, session, rec, ws } = await connected()
    server.send(ws, { sessionResumptionUpdate: { newHandle: 'handle_latest', resumable: true } })
    server.goAway(ws)
    await flush()
    expect(server.sockets).toHaveLength(2)
    const next = server.last
    expect((next.sent[0]!.setup as any).sessionResumption).toEqual({ handle: 'handle_latest' })
    await flush()
    expect(ws.closedWith).toEqual({ code: 1000, reason: 'resumed' })
    expect(rec.of('closed')).toHaveLength(0)
    session.pushAudio(new Int16Array(16000 * 0.07))
    expect(next.sent.at(-1)).toHaveProperty('realtimeInput')
  })

  it('unexpected close without a resumable handle → closed (not expected); setup rejection → clear error', async () => {
    const { rec, ws } = await connected()
    ws.serverClose(1011, 'Internal error')
    // 1011 is not a lifetime end: no resumption.
    expect(rec.of('closed')[0]).toMatchObject({ code: 1011, expected: false })

    // Relay reports a missing key before setup completes → connect rejects with a PT message.
    const server = createFakeGeminiLiveServer()
    const s2 = createGeminiLiveSession({
      url: 'ws://127.0.0.1:1/x',
      model: 'gemini-3.8-live',
      webSocketFactory: (url) => {
        const sock = server.factory(url)
        queueMicrotask(() => (sock as unknown as { serverClose(c: number, r: string): void }).serverClose(4001, 'gemini'))
        return sock
      },
    })
    const p = s2.connect({ instructions: 'x' })
    const assertion = expect(p).rejects.toThrow(/chave de API ausente/)
    await flush()
    await assertion
  })
})

describe('Phase 10.4 createCloudVoiceSession', () => {
  it('picks the session by cloud kind / provider', () => {
    const base = {
      callId: 'c',
      sessionId: 's',
      llamacpp: null,
      settings: { ...DEFAULT_LIVE_MODE_SETTINGS },
    }
    const g = createCloudVoiceSession({ ...base, backend: 'gemini-live', cloud: { kind: 'gemini', url: 'ws://127.0.0.1:1/cloud/c', model: 'gemini-3.8-live', voice: 'Kore' } })
    expect(g.caps.contextInjection).toBe('client_content')
    const o = createCloudVoiceSession({ ...base, backend: 'openai-realtime', cloud: { kind: 'openai-compatible', url: 'ws://127.0.0.1:1/cloud/c', model: 'gpt-realtime-2.1-mini', voice: 'marin' } })
    expect(o.caps.messageTruncation).toBe(true)
    const q = createCloudVoiceSession({
      ...base,
      settings: { ...DEFAULT_LIVE_MODE_SETTINGS, realtimeCloud: { provider: 'qwen', url: '', model: 'qwen3.5-omni-flash-realtime', voice: 'Tina' } },
      backend: 'openai-realtime',
      cloud: { kind: 'openai-compatible', url: 'ws://127.0.0.1:1/cloud/c', model: 'qwen3.5-omni-flash-realtime', voice: 'Tina' },
    })
    expect(q.caps.serverAutoResponse).toBe(true)
    expect(() => createCloudVoiceSession({ ...base, backend: 'gemini-live', cloud: null })).toThrow(/no cloud endpoint/)
  })
})
