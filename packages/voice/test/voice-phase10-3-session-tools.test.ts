import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallSynthesizeResult, CallToolDefinition } from '@ashy/shared'
import {
  createLlamaCppHybridSession,
  createLlamaCppRealtimeSession,
  int16ToBase64,
  type VoiceSessionEventMap,
  type VoiceSession,
} from '../src'
import { createFakeRealtimeServer, flush, sentTypes, TEST_INSTRUCTIONS } from './helpers/phase10-1-fakes'
import { streamToolStep, TOOLS } from './helpers/phase10-3-fakes'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function collect(session: VoiceSession) {
  const events: Array<{ type: keyof VoiceSessionEventMap; payload: any }> = []
  for (const type of [
    'response_started',
    'response_text',
    'response_done',
    'tool_step_started',
    'tool_call',
    'tool_step_done',
  ] as const) {
    session.on(type, (payload) => events.push({ type, payload }))
  }
  return events
}

async function realtime(tools?: CallToolDefinition[]) {
  const server = createFakeRealtimeServer()
  const session = createLlamaCppRealtimeSession({
    baseUrl: 'http://127.0.0.1:9999',
    webSocketFactory: server.factory,
  })
  const events = collect(session)
  const p = session.connect({ instructions: TEST_INSTRUCTIONS, ...(tools ? { tools } : {}) })
  await flush(5)
  await p
  return { server, session, events, ws: server.last }
}

describe('Phase 10.3 LlamaCppRealtimeSession — tools', () => {
  it('sends tools + tool_choice auto in session.update only when tools are given', async () => {
    const a = await realtime(TOOLS)
    expect(a.ws.sent[0]!.session).toEqual(
      expect.objectContaining({ tools: TOOLS, tool_choice: 'auto', output_modalities: ['text', 'audio'] }),
    )
    expect(a.session.hasTools).toBe(true)
    expect(a.session.caps.toolCalls).toBe(true)
    const b = await realtime()
    expect(b.ws.sent[0]!.session).not.toHaveProperty('tools')
    expect(b.ws.sent[0]!.session).not.toHaveProperty('tool_choice')
    // Pre-10.3 wire format kept without tools.
    b.session.submitUserText('oi')
    expect(b.ws.sent.at(-1)).toEqual({ type: 'response.create' })
  })

  it("toolChoice 'none' (and the default with tools) → response.create {tool_choice:'none'}", async () => {
    const { session, ws } = await realtime(TOOLS)
    session.submitUserText('Usuário: me conta uma piada', { toolChoice: 'none' })
    expect(ws.sent.at(-1)).toEqual({ type: 'response.create', response: { tool_choice: 'none' } })
    ws.deliver({ type: 'response.done', response: { status: 'completed' } })
    session.submitUserText('Usuário: oi')
    expect(ws.sent.at(-1)).toEqual({ type: 'response.create', response: { tool_choice: 'none' } })
    ws.deliver({ type: 'response.done', response: { status: 'completed' } })
    session.respond({ contextText: '[Contexto] x' })
    expect(ws.sent.at(-1)).toEqual({ type: 'response.create', response: { tool_choice: 'none' } })
  })

  it("toolChoice 'auto' → text-only tool step: tool_step_started, tool_call, tool_step_done (no response_* events)", async () => {
    const { session, ws, events } = await realtime(TOOLS)
    session.submitUserText('Usuário: lê o arquivo notas.txt', { toolChoice: 'auto' })
    expect(sentTypes(ws).slice(1)).toEqual(['conversation.item.create', 'response.create'])
    expect(ws.sent.at(-1)).toEqual({ type: 'response.create', response: { tool_choice: 'auto', output_modalities: ['text'] } })
    streamToolStep(ws, { text: ['Vou ler.'], calls: [{ name: 'read_workspace_file', args: '{"path":"notas.txt"}', callId: 'c_7' }] })
    expect(events.map((e) => e.type)).toEqual(['tool_step_started', 'tool_call', 'tool_step_done'])
    expect(events[1]!.payload).toEqual({
      callId: 'c_7',
      name: 'read_workspace_file',
      arguments: '{"path":"notas.txt"}',
      responseId: events[0]!.payload.responseId,
    })
    expect(events[2]!.payload).toEqual({
      responseId: events[0]!.payload.responseId,
      text: 'Vou ler.',
      calls: [{ callId: 'c_7', name: 'read_workspace_file', arguments: '{"path":"notas.txt"}' }],
      cancelled: false,
    })
  })

  it('submitToolResults → function_call_output items then response.create {tool_choice:none, session modalities}', async () => {
    const { session, ws, events } = await realtime(TOOLS)
    session.submitUserText('Usuário: que janela?', { toolChoice: 'auto' })
    streamToolStep(ws, { calls: [{ name: 'get_active_window_title', callId: 'c1' }] })
    session.submitToolResults([{ callId: 'c1', output: '{"title":"VS Code"}' }])
    expect(ws.sent.slice(-2)).toEqual([
      { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'c1', output: '{"title":"VS Code"}' } },
      { type: 'response.create', response: { tool_choice: 'none', output_modalities: ['text', 'audio'] } },
    ])
    ws.deliver({ type: 'response.created', response: { id: 'r2' } })
    ws.deliver({ type: 'response.output_text.delta', delta: 'Você está no VS Code.' })
    ws.deliver({ type: 'response.done', response: { id: 'r2', status: 'completed' } })
    expect(events.slice(3).map((e) => e.type)).toEqual(['response_started', 'response_text', 'response_done'])
    expect(events.at(-1)!.payload.toolCalls).toBeUndefined()
  })

  it('cancelling a tool step reports tool_step_done cancelled with no calls', async () => {
    const { session, ws, events } = await realtime(TOOLS)
    session.submitUserText('Usuário: que janela?', { toolChoice: 'auto' })
    ws.deliver({ type: 'response.created', response: { id: 'r1' } })
    ws.deliver({ type: 'response.output_item.added', item: { type: 'function_call', name: 'get_active_window_title', call_id: 'c1' } })
    session.cancelResponse('client')
    expect(sentTypes(ws).at(-1)).toBe('response.cancel')
    expect(events.at(-1)).toEqual({
      type: 'tool_step_done',
      payload: expect.objectContaining({ cancelled: true, cancelReason: 'client', calls: [] }),
    })
  })

  it("'auto' without session tools degrades to a plain spoken turn", async () => {
    const { session, ws, events } = await realtime()
    session.submitUserText('oi', { toolChoice: 'auto' })
    expect(ws.sent.at(-1)).toEqual({ type: 'response.create' })
    ws.deliver({ type: 'response.created', response: { id: 'r1' } })
    expect(events[0]!.type).toBe('response_started')
  })
})

describe('Phase 10.3 LlamaCppHybridSession — tools', () => {
  async function hybrid() {
    const server = createFakeRealtimeServer()
    const synthesize = vi.fn(async (text: string): Promise<CallSynthesizeResult> => {
      const pcm = new Int16Array(2400).fill(7)
      return { pcmBase64: int16ToBase64(pcm), sampleRate: 24000, durationMs: 100, latencyMs: 1 + text.length * 0 }
    })
    const session = createLlamaCppHybridSession({
      baseUrl: 'http://127.0.0.1:9999',
      synthesize,
      webSocketFactory: server.factory,
    })
    const events = collect(session)
    const audio: number[] = []
    session.on('response_audio', (e) => audio.push(e.pcm.length))
    const p = session.connect({ instructions: TEST_INSTRUCTIONS, tools: TOOLS })
    await flush(5)
    await p
    return { server, session, events, synthesize, audio, ws: server.last }
  }

  it('text-only everywhere: session.update and the post-tool response.create never ask for audio', async () => {
    const { session, ws, events } = await hybrid()
    expect(ws.sent[0]!.session).toEqual(expect.objectContaining({ output_modalities: ['text'], tools: TOOLS, tool_choice: 'auto' }))
    session.submitUserText('Usuário: que janela?', { toolChoice: 'auto' })
    expect(ws.sent.at(-1)).toEqual({ type: 'response.create', response: { tool_choice: 'auto', output_modalities: ['text'] } })
    streamToolStep(ws, { calls: [{ name: 'get_active_window_title', callId: 'c1' }] })
    expect(events.map((e) => e.type)).toEqual(['tool_step_started', 'tool_call', 'tool_step_done'])
    session.submitToolResults([{ callId: 'c1', output: '{"title":"VS Code"}' }])
    expect(ws.sent.at(-1)).toEqual({ type: 'response.create', response: { tool_choice: 'none', output_modalities: ['text'] } })
  })

  it('speakText speaks a ready text through the phrase TTS with the regular events (no generation)', async () => {
    const { session, ws, events, synthesize, audio } = await hybrid()
    const before = ws.sent.length
    session.speakText('Não achei nenhum arquivo com esse nome. Quer tentar outro?')
    await flush()
    expect(ws.sent.length).toBe(before)
    expect(synthesize.mock.calls.map((c) => c[0])).toEqual(['Não achei nenhum arquivo com esse nome.', 'Quer tentar outro?'])
    expect(audio).toEqual([2400, 2400])
    expect(events.map((e) => e.type)).toEqual(['response_started', 'response_text', 'response_done'])
    expect(events.at(-1)!.payload).toEqual(expect.objectContaining({ cancelled: false, audioMs: 200 }))
  })
})
