import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallToolDefinition } from '@ashy/shared'
import { createCallEngine, createGeminiLiveSession, createOpenAIRealtimeSession } from '../src'
import { createFakeHost, createFakeMicrophone, createFakePlaybackContext, flush, testSettings } from './helpers/phase10-1-fakes'
import { createFakeGeminiLiveServer, createFakeOpenAIRealtimeServer, sentTypesOf } from './helpers/phase10-4-cloud-fakes'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const TOOLS: CallToolDefinition[] = [
  {
    type: 'function',
    name: 'read_workspace_file',
    description: 'Reads a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
]

function setupOpenAI(opts: { host?: Parameters<typeof createFakeHost>[0]; contextSize?: number } = {}) {
  const settings = testSettings({ features: { toolsInCall: true } })
  const server = createFakeOpenAIRealtimeServer()
  const mic = createFakeMicrophone()
  const playback = createFakePlaybackContext()
  const fakeHost = createFakeHost({ perTurnContext: '[Contexto] Memórias relevantes:\n- O cachorro se chama Thor.', ...(opts.host ?? {}) })
  const engine = createCallEngine({
    callId: 'call-cloud',
    settings,
    host: fakeHost.host,
    createSession: () =>
      createOpenAIRealtimeSession({ url: 'ws://127.0.0.1:5555/cloud/call-cloud', model: 'gpt-realtime-2.1-mini', voice: 'marin', webSocketFactory: server.factory }),
    mediaDevices: mic.mediaDevices,
    captureAudioContextFactory: mic.captureContextFactory,
    playbackAudioContext: playback.ctx,
    detectorOptions: { sessionLoader: async () => null },
    now: () => Date.now(),
    ...(opts.contextSize ? { contextSize: opts.contextSize } : {}),
  })
  return { engine, server, mic, playback, ...fakeHost }
}

function setupGemini(opts: { host?: Parameters<typeof createFakeHost>[0] } = {}) {
  const settings = testSettings({})
  const server = createFakeGeminiLiveServer()
  const mic = createFakeMicrophone()
  const playback = createFakePlaybackContext()
  const fakeHost = createFakeHost({ perTurnContext: '[Contexto] Memórias relevantes:\n- Gosta de piadas de pato.', ...(opts.host ?? {}) })
  const engine = createCallEngine({
    callId: 'call-gem',
    settings,
    host: fakeHost.host,
    createSession: () => createGeminiLiveSession({ url: 'ws://127.0.0.1:5555/cloud/call-gem', model: 'gemini-3.8-live', voice: 'Kore', webSocketFactory: server.factory }),
    mediaDevices: mic.mediaDevices,
    captureAudioContextFactory: mic.captureContextFactory,
    playbackAudioContext: playback.ctx,
    detectorOptions: { sessionLoader: async () => null },
    now: () => Date.now(),
  })
  return { engine, server, mic, playback, ...fakeHost }
}

describe('Phase 10.4 CallEngine × OpenAI Realtime (server VAD, create_response:false)', () => {
  it('streams the mic, follows the server VAD, uses the backend transcript for context + recordTurn (no host STT)', async () => {
    const ctx = setupOpenAI()
    const p = ctx.engine.start()
    await flush()
    expect(await p).toBe('listening')
    const ws = ctx.server.last

    ctx.mic.speech(600)
    await flush()
    expect(sentTypesOf(ws)).toContain('input_audio_buffer.append')
    const itemId = ctx.server.userTurn(ws, null)
    ctx.mic.silence(900)
    await flush()
    expect(ctx.engine.getStatus()).toBe('thinking')
    // Waiting for this turn's transcript: no response yet.
    expect(sentTypesOf(ws)).not.toContain('response.create')

    ctx.server.userTranscript(ws, itemId, 'qual é o nome do meu cachorro?')
    await flush()
    expect(ctx.contexts.at(-1)).toEqual({ callId: 'call-cloud', userText: 'qual é o nome do meu cachorro?' })
    const create = ws.sent.filter((m) => m.type === 'response.create').at(-1)!
    expect((create.response as { instructions: string }).instructions).toContain('O cachorro se chama Thor.')
    expect(ctx.transcribes).toHaveLength(0)

    ctx.server.streamResponse(ws, { text: ['O nome dele ', 'é Thor!'], audioMs: [400, 400] })
    await flush()
    expect(ctx.engine.getStatus()).toBe('speaking')
    ctx.playback.advance(1)
    await flush()
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(ctx.turns).toHaveLength(1)
    expect(ctx.turns[0]).toMatchObject({
      userTranscript: 'qual é o nome do meu cachorro?',
      assistantSpokenText: 'O nome dele é Thor!',
      interrupted: false,
    })
    await ctx.engine.stop()
  })

  it('falls back to a context without user text when the transcript is late, and still records it', async () => {
    const ctx = setupOpenAI()
    const p = ctx.engine.start()
    await flush()
    await p
    const ws = ctx.server.last
    const itemId = ctx.server.userTurn(ws, null)
    await flush()
    await vi.advanceTimersByTimeAsync(1600)
    await flush()
    expect(ws.sent.some((m) => m.type === 'response.create')).toBe(true)
    ctx.server.streamResponse(ws, { text: ['Oi!'], audioMs: [300] })
    ctx.server.userTranscript(ws, itemId, 'oi Ashy')
    await flush()
    ctx.playback.advance(1)
    await flush()
    expect(ctx.turns[0]).toMatchObject({ userTranscript: 'oi Ashy', assistantSpokenText: 'Oi!' })
    await ctx.engine.stop()
  })

  it('barge-in (server speech_started while speaking): cancels, truncates at the played ms, records what was heard', async () => {
    const ctx = setupOpenAI()
    const p = ctx.engine.start()
    await flush()
    await p
    const ws = ctx.server.last
    const itemId = ctx.server.userTurn(ws, 'me conta uma história longa')
    await flush()
    const { itemId: asstItem, responseId } = ctx.server.streamResponse(ws, {
      text: ['Era uma vez um gato. ', 'Ele morava num barco. ', 'E tinha medo de água.'],
      audioMs: [600, 600, 600],
      done: false,
    })
    await flush()
    expect(ctx.engine.getStatus()).toBe('speaking')
    ctx.playback.advance(0.7)
    await flush()
    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 5000, item_id: 'item_next' })
    ctx.server.cancelResponse(ws, responseId)
    await flush()
    expect(ctx.engine.getStatus()).toBe('user_speaking')
    const truncate = ws.sent.find((m) => m.type === 'conversation.item.truncate')!
    expect(truncate).toMatchObject({ item_id: asstItem, content_index: 0 })
    expect(Number(truncate.audio_end_ms)).toBeGreaterThanOrEqual(650)
    expect(Number(truncate.audio_end_ms)).toBeLessThanOrEqual(760)
    expect(ctx.turns).toHaveLength(1)
    expect(ctx.turns[0]).toMatchObject({ userTranscript: 'me conta uma história longa', interrupted: true })
    expect(ctx.turns[0]!.assistantSpokenText.length).toBeLessThan('Era uma vez um gato. Ele morava num barco. E tinha medo de água.'.length)
    void itemId
    await ctx.engine.stop()
  })

  it('tool round trip inside a spoken turn: function call → host.executeTool → function_call_output → response.create → answer', async () => {
    const ctx = setupOpenAI({ host: { tools: TOOLS } })
    const p = ctx.engine.start()
    await flush()
    await p
    const ws = ctx.server.last
    expect((ws.sent[0]!.session as { tools?: unknown[] }).tools).toHaveLength(1)
    ctx.server.userTurn(ws, 'lê o arquivo notas.txt')
    await flush()
    const first = ctx.server.streamResponse(ws, {
      text: ['Vou ler. '],
      audioMs: [300],
      functionCalls: [{ name: 'read_workspace_file', arguments: '{"path":"notas.txt"}' }],
    })
    await flush()
    expect(ctx.toolExecutions).toEqual([{ callId: 'call-cloud', toolCallId: first.callIds[0], name: 'read_workspace_file', argsJson: '{"path":"notas.txt"}' }])
    const out = ws.sent.find((m) => m.type === 'conversation.item.create' && (m.item as { type?: string }).type === 'function_call_output')!
    expect((out.item as { call_id: string }).call_id).toBe(first.callIds[0])
    expect(ws.sent.at(-1)!.type).toBe('response.create')
    ctx.server.streamResponse(ws, { text: ['Diz: comprar ração.'], audioMs: [400] })
    await flush()
    ctx.playback.advance(2)
    await flush()
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(ctx.turns).toHaveLength(1)
    expect(ctx.turns[0]).toMatchObject({ userTranscript: 'lê o arquivo notas.txt', assistantSpokenText: 'Vou ler. Diz: comprar ração.' })
    await ctx.engine.stop()
  })

  it('never rotates a server-managed session (even with a tiny context estimate)', async () => {
    const ctx = setupOpenAI({ contextSize: 50 })
    const p = ctx.engine.start()
    await flush()
    await p
    const ws = ctx.server.last
    for (let i = 0; i < 3; i++) {
      ctx.server.userTurn(ws, `pergunta ${i} bem longa para encher o contexto estimado do motor de chamada`)
      await flush()
      ctx.server.streamResponse(ws, { text: ['Resposta longa '.repeat(20)], audioMs: [300] })
      await flush()
      ctx.playback.advance(1)
      await flush()
    }
    expect(ctx.turns).toHaveLength(3)
    expect(ctx.server.sockets).toHaveLength(1)
    await ctx.engine.stop()
  })

  it('mute clears the server input buffer', async () => {
    const ctx = setupOpenAI()
    const p = ctx.engine.start()
    await flush()
    await p
    ctx.engine.setMuted(true)
    expect(ctx.server.last.sent.at(-1)).toEqual({ type: 'input_audio_buffer.clear' })
    await ctx.engine.stop()
  })
})

describe('Phase 10.4 CallEngine × Gemini Live (server VAD, automatic response)', () => {
  it('local VAD drives the UI, the server answers by itself, transcript → lagged clientContent context → recordTurn', async () => {
    const ctx = setupGemini()
    const p = ctx.engine.start()
    await flush()
    expect(await p).toBe('listening')
    const ws = ctx.server.last
    ctx.mic.speech(600)
    await flush()
    expect(ctx.engine.getStatus()).toBe('user_speaking')
    expect(ws.sent.some((m) => 'realtimeInput' in m)).toBe(true)
    ctx.server.userSpeech(ws, 'me conta uma piada')
    ctx.mic.silence(900)
    await flush()
    expect(ctx.engine.getStatus()).toBe('thinking')

    ctx.server.modelTurn(ws, { text: ['Por que o pato ', 'atravessou a rua?'], audioMs: [400, 400], complete: false })
    await flush()
    expect(ctx.engine.getStatus()).toBe('speaking')
    ctx.server.send(ws, { serverContent: { turnComplete: true } })
    await flush()
    // Final transcript → buildContext(userText) → context injected for the next turns (model idle).
    expect(ctx.contexts.at(-1)).toEqual({ callId: 'call-gem', userText: 'me conta uma piada' })
    const cc = ws.sent.find((m) => 'clientContent' in m)!
    expect(cc).toEqual({
      clientContent: { turns: [{ role: 'user', parts: [{ text: '[Contexto] Memórias relevantes:\n- Gosta de piadas de pato.' }] }], turnComplete: false },
    })
    ctx.playback.advance(1)
    await flush()
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(ctx.turns[0]).toMatchObject({ userTranscript: 'me conta uma piada', assistantSpokenText: 'Por que o pato atravessou a rua?', interrupted: false })
    expect(ctx.transcribes).toHaveLength(0)
    await ctx.engine.stop()
  })

  it('server `interrupted` while speaking → barge-in, partial turn recorded', async () => {
    const ctx = setupGemini()
    const p = ctx.engine.start()
    await flush()
    await p
    const ws = ctx.server.last
    ctx.server.userSpeech(ws, 'fala sobre o espaço')
    ctx.server.modelTurn(ws, { text: ['O espaço é enorme. ', 'Tem bilhões de galáxias.'], audioMs: [600, 600], complete: false })
    await flush()
    expect(ctx.engine.getStatus()).toBe('speaking')
    ctx.playback.advance(0.5)
    await flush()
    ctx.server.interrupted(ws)
    await flush()
    expect(ctx.engine.getStatus()).toBe('user_speaking')
    expect(ctx.turns).toHaveLength(1)
    expect(ctx.turns[0]).toMatchObject({ interrupted: true })
    // Gemini has no truncate: the server keeps only what was sent.
    expect(ws.sent.some((m) => 'conversation.item.truncate' === m.type)).toBe(false)
    await ctx.engine.stop()
  })

  it('a server response without local speech detection is adopted (listening → thinking → speaking)', async () => {
    const ctx = setupGemini()
    const p = ctx.engine.start()
    await flush()
    await p
    const ws = ctx.server.last
    ctx.server.userSpeech(ws, 'oi')
    ctx.server.modelTurn(ws, { text: ['Oi!'], audioMs: [300] })
    await flush()
    expect(ctx.engine.getStatus()).toBe('speaking')
    ctx.playback.advance(1)
    await flush()
    expect(ctx.turns[0]).toMatchObject({ userTranscript: 'oi', assistantSpokenText: 'Oi!' })
    await ctx.engine.stop()
  })

  it('back to listening when the backend never answers', async () => {
    const ctx = setupGemini()
    const p = ctx.engine.start()
    await flush()
    await p
    ctx.mic.speech(600)
    await flush()
    ctx.mic.silence(900)
    await flush()
    expect(ctx.engine.getStatus()).toBe('thinking')
    await vi.advanceTimersByTimeAsync(12500)
    await flush()
    expect(ctx.engine.getStatus()).toBe('listening')
    await ctx.engine.stop()
  })
})
