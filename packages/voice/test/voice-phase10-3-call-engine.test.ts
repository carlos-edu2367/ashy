import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallCheckInitiativeResult, CallExecuteToolResult } from '@ashy/shared'
import {
  createCallEngine,
  createLlamaCppHybridSession,
  createLlamaCppRealtimeSession,
  toolCaptionText,
  type CallEngineOptions,
  type VoiceSession,
  type VoiceSessionEventMap,
} from '../src'
import {
  createFakeHost,
  createFakeMicrophone,
  createFakePlaybackContext,
  createFakeRealtimeServer,
  flush,
  pcmBase64,
  sentTypes,
  testSettings,
  type FakeRealtimeServerOptions,
  type FakeSocket,
} from './helpers/phase10-1-fakes'
import { streamToolStep, TOOLS } from './helpers/phase10-3-fakes'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const TOOL_INTENT = /janela|arquivo|tela/i

function setup(
  opts: {
    settings?: Parameters<typeof testSettings>[0]
    server?: FakeRealtimeServerOptions
    engine?: Partial<CallEngineOptions>
    backend?: 'realtime' | 'hybrid'
    tools?: boolean
    approvalHandled?: (t: string) => boolean
    executeTool?: (input: { name: string; toolCallId: string }) => Promise<CallExecuteToolResult> | CallExecuteToolResult
    checkInitiative?: () => Promise<CallCheckInitiativeResult> | CallCheckInitiativeResult
  } = {},
) {
  const settings = testSettings(opts.settings)
  const server = createFakeRealtimeServer(opts.server)
  const mic = createFakeMicrophone()
  const playback = createFakePlaybackContext()
  let transcript = 'que janela eu tô usando?'
  const fakeHost = createFakeHost({
    transcript: () => transcript,
    ...(opts.tools === false ? {} : { tools: TOOLS }),
    toolChoice: (t) => (TOOL_INTENT.test(t) ? 'auto' : 'none'),
    ...(opts.approvalHandled ? { approvalHandled: opts.approvalHandled } : {}),
    ...(opts.executeTool ? { executeTool: opts.executeTool } : {}),
    ...(opts.checkInitiative ? { checkInitiative: opts.checkInitiative } : {}),
  })
  // Host /tts: 300 ms of voiced PCM per phrase.
  const synthesize = vi.fn(async (input: { text: string }) => ({
    pcmBase64: pcmBase64(300, 24000),
    sampleRate: 24000,
    durationMs: 300,
    latencyMs: 5 + input.text.length * 0,
  }))
  fakeHost.host.synthesize = synthesize
  const sessions: VoiceSession[] = []
  const sessionEvents: string[] = []
  const engine = createCallEngine({
    callId: 'call-1',
    settings,
    host: fakeHost.host,
    createSession: () => {
      const s =
        opts.backend === 'hybrid'
          ? createLlamaCppHybridSession({
              baseUrl: 'http://127.0.0.1:8081',
              synthesize: (text) => fakeHost.host.synthesize({ callId: 'call-1', text }),
              webSocketFactory: server.factory,
            })
          : createLlamaCppRealtimeSession({
              baseUrl: 'http://127.0.0.1:8081',
              modelId: settings.llamacpp.modelId,
              inputMode: settings.llamacpp.inputMode,
              maxOutputTokens: settings.llamacpp.maxOutputTokens,
              webSocketFactory: server.factory,
            })
      for (const type of [
        'tool_step_started',
        'tool_call',
        'tool_step_done',
        'response_started',
        'response_text',
        'response_done',
      ] as Array<keyof VoiceSessionEventMap>) {
        s.on(type, () => {
          if (sessionEvents.at(-1) !== type || type !== 'response_text') sessionEvents.push(type)
        })
      }
      sessions.push(s)
      return s
    },
    mediaDevices: mic.mediaDevices,
    captureAudioContextFactory: mic.captureContextFactory,
    playbackAudioContext: playback.ctx,
    detectorOptions: { sessionLoader: async () => null },
    now: () => Date.now(),
    ...(opts.engine ?? {}),
  })
  return {
    engine,
    server,
    mic,
    playback,
    sessions,
    sessionEvents,
    synthesize,
    setTranscript: (t: string) => {
      transcript = t
    },
    ...fakeHost,
  }
}

type Ctx = ReturnType<typeof setup>

async function startCall(ctx: Ctx) {
  const p = ctx.engine.start()
  await flush()
  return p
}

async function speakTurn(ctx: Ctx, speechMs = 600, silenceMs = 900) {
  ctx.mic.speech(speechMs)
  await flush()
  ctx.mic.silence(silenceMs)
  await flush()
}

async function playOut(ctx: Ctx, sec: number) {
  ctx.playback.advance(sec)
  await flush()
}

const lastCreate = (ws: FakeSocket) => ws.sent.filter((m) => m.type === 'response.create').at(-1)
const creates = (ws: FakeSocket) => ws.sent.filter((m) => m.type === 'response.create')
const inputTexts = (ws: FakeSocket) =>
  ws.sent
    .filter((m) => m.type === 'conversation.item.create' && (m.item as { type: string }).type === 'message')
    .map((m) => (m.item as { content: Array<{ text: string }> }).content[0]!.text)
const toolOutputs = (ws: FakeSocket) =>
  ws.sent.filter((m) => m.type === 'conversation.item.create' && (m.item as { type: string }).type === 'function_call_output')
const statuses = (states: Array<{ status: string }>) =>
  states.map((s) => s.status).filter((s, i, arr) => i === 0 || arr[i - 1] !== s)

describe('Phase 10.3 CallEngine — tools (two-step flow)', () => {
  it('runs the exact two-step flow: text tool step → executeTool → function_call_output → spoken answer', async () => {
    const ctx = setup({
      executeTool: () => ({ status: 'executed', output: '{"title":"Visual Studio Code — ashy"}' }),
    })
    await startCall(ctx)
    const ws = ctx.server.last
    expect(ws.sent[0]!.session).toEqual(expect.objectContaining({ tools: TOOLS, tool_choice: 'auto' }))

    await speakTurn(ctx)
    await flush()
    expect(sentTypes(ws)).toEqual(['session.update', 'conversation.item.create', 'response.create'])
    expect(lastCreate(ws)).toEqual({ type: 'response.create', response: { tool_choice: 'auto', output_modalities: ['text'] } })
    expect(ctx.engine.getStatus()).toBe('thinking')

    streamToolStep(ws, { calls: [{ name: 'get_active_window_title', callId: 'call_w1' }] })
    await flush()
    expect(ctx.toolExecutions).toEqual([
      { callId: 'call-1', toolCallId: 'call_w1', name: 'get_active_window_title', argsJson: '{}' },
    ])
    expect(ctx.states.some((s) => s.caption?.text === toolCaptionText('get_active_window_title'))).toBe(true)
    expect(toolCaptionText('get_active_window_title')).toBe('🔧 usando get_active_window_title…')
    expect(sentTypes(ws)).toEqual([
      'session.update',
      'conversation.item.create',
      'response.create',
      'conversation.item.create',
      'response.create',
    ])
    expect(ws.sent[3]).toEqual({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call_w1', output: '{"title":"Visual Studio Code — ashy"}' },
    })
    expect(ws.sent[4]).toEqual({
      type: 'response.create',
      response: { tool_choice: 'none', output_modalities: ['text', 'audio'] },
    })

    ctx.server.streamResponse(ws, { text: ['Você está no Visual Studio Code.'], audioMs: [600] })
    await flush()
    expect(ctx.engine.getStatus()).toBe('speaking')
    await playOut(ctx, 0.7)
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(ctx.sessionEvents).toEqual([
      'tool_step_started',
      'tool_call',
      'tool_step_done',
      'response_started',
      'response_text',
      'response_done',
    ])
    expect(statuses(ctx.states)).toEqual(['connecting', 'listening', 'user_speaking', 'thinking', 'speaking', 'listening'])
    expect(ctx.turns).toHaveLength(1)
    expect(ctx.turns[0]).toEqual(
      expect.objectContaining({
        userTranscript: 'que janela eu tô usando?',
        assistantSpokenText: 'Você está no Visual Studio Code.',
        interrupted: false,
      }),
    )
    expect(ctx.synthesize).not.toHaveBeenCalled()
  })

  it("small talk → response.create {tool_choice:'none'} and no tool step", async () => {
    const ctx = setup()
    ctx.setTranscript('me conta uma piada curta')
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    const ws = ctx.server.last
    expect(lastCreate(ws)).toEqual({ type: 'response.create', response: { tool_choice: 'none' } })
    ctx.server.streamResponse(ws, { text: ['Por que o pato atravessou a rua?'], audioMs: [400] })
    await flush()
    await playOut(ctx, 0.5)
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(ctx.toolExecutions).toHaveLength(0)
    expect(ctx.sessionEvents).toEqual(['response_started', 'response_text', 'response_done'])
  })

  it('a voice approval (approvalHandled) is never a tool turn', async () => {
    const ctx = setup({ approvalHandled: () => true })
    ctx.setTranscript('pode, anota na tela') // matches the tool intent, but the host consumed it
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    expect(lastCreate(ctx.server.last)).toEqual({ type: 'response.create', response: { tool_choice: 'none' } })
  })

  it('without tools from the host the wire stays pre-10.3 (bare response.create, no tools in session.update)', async () => {
    const ctx = setup({ tools: false })
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    const ws = ctx.server.last
    expect(ws.sent[0]!.session).not.toHaveProperty('tools')
    expect(lastCreate(ws)).toEqual({ type: 'response.create' })
  })

  it('a tool step without calls is spoken through host.synthesize (no second generation), same playback/ledger path', async () => {
    const ctx = setup()
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    const ws = ctx.server.last
    streamToolStep(ws, { text: ['Não consegui ver a janela agora. Pode repetir?'] })
    await flush()
    expect(creates(ws)).toHaveLength(1)
    expect(ctx.synthesize.mock.calls.map((c) => c[0].text)).toEqual(['Não consegui ver a janela agora.', 'Pode repetir?'])
    expect(ctx.engine.getStatus()).toBe('speaking')
    await playOut(ctx, 0.65)
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(ctx.turns[0]).toEqual(
      expect.objectContaining({
        userTranscript: 'que janela eu tô usando?',
        assistantSpokenText: 'Não consegui ver a janela agora. Pode repetir?',
        interrupted: false,
        playedMs: 600,
      }),
    )
    expect(ctx.turns[0]!.metrics?.ttfbMs).toBeTypeOf('number')
  })

  it('caps the turn at 3 tool rounds even when the server keeps calling tools', async () => {
    let n = 0
    const ctx = setup({
      server: {
        onClientMessage: (socket, msg) => {
          if (msg.type !== 'response.create') return
          n += 1
          const callId = `c${n}`
          queueMicrotask(() => streamToolStep(socket, { calls: [{ name: 'get_active_window_title', callId }] }))
        },
      },
    })
    await startCall(ctx)
    await speakTurn(ctx)
    await flush(60)
    const ws = ctx.server.last
    expect(ctx.toolExecutions.map((t) => t.toolCallId)).toEqual(['c1', 'c2', 'c3'])
    expect(creates(ws)).toHaveLength(4)
    expect(toolOutputs(ws)).toHaveLength(3)
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(ctx.turns).toHaveLength(1)
    expect(ctx.turns[0]!.assistantSpokenText).toBe('')
  })

  it('a failing tool still answers: the error goes back as the function output', async () => {
    const ctx = setup({
      executeTool: () => {
        throw new Error('gatekeeper down')
      },
    })
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    const ws = ctx.server.last
    streamToolStep(ws, { calls: [{ name: 'read_workspace_file', args: '{"path":"x"}', callId: 'c1' }] })
    await flush()
    const out = toolOutputs(ws)[0]!.item as { output: string }
    expect(JSON.parse(out.output)).toEqual({ status: 'erro', detalhe: 'gatekeeper down' })
    expect(lastCreate(ws)).toEqual({ type: 'response.create', response: { tool_choice: 'none', output_modalities: ['text', 'audio'] } })
  })
})

describe('Phase 10.3 CallEngine — interactions', () => {
  it('barge-in while a tool runs drops its result and the new turn goes on', async () => {
    let release: (r: CallExecuteToolResult) => void = () => {}
    const ctx = setup({ executeTool: () => new Promise((r) => (release = r)) })
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    const ws = ctx.server.last
    streamToolStep(ws, { calls: [{ name: 'get_active_window_title', callId: 'c1' }] })
    await flush()
    expect(ctx.toolExecutions).toHaveLength(1)
    expect(ctx.engine.getStatus()).toBe('thinking')

    ctx.setTranscript('esquece, me conta uma piada')
    ctx.mic.speech(600)
    await flush()
    expect(ctx.engine.getStatus()).toBe('user_speaking')
    release({ status: 'executed', output: '{"title":"VS Code"}' })
    await flush()
    expect(toolOutputs(ws)).toHaveLength(0)

    ctx.mic.silence(900)
    await flush()
    expect(lastCreate(ws)).toEqual({ type: 'response.create', response: { tool_choice: 'none' } })
    expect(inputTexts(ws).at(-1)).toContain('esquece, me conta uma piada')
    expect(toolOutputs(ws)).toHaveLength(0)
  })

  it('barge-in during the tool step itself cancels it (response.cancel) and never executes its calls', async () => {
    const ctx = setup()
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    const ws = ctx.server.last
    ws.deliver({ type: 'response.created', response: { id: 'step1' } })
    ws.deliver({
      type: 'response.output_item.added',
      item: { type: 'function_call', name: 'get_active_window_title', call_id: 'c1' },
    })
    ctx.mic.speech(600)
    await flush()
    expect(ctx.engine.getStatus()).toBe('user_speaking')
    expect(sentTypes(ws)).toContain('response.cancel')
    ws.deliver({ type: 'response.function_call_arguments.done', call_id: 'c1', arguments: '{}' })
    ws.deliver({ type: 'response.done', response: { id: 'step1', status: 'cancelled' } })
    await flush()
    expect(ctx.toolExecutions).toHaveLength(0)
  })

  it('session rotation and reconnect re-send the tools in session.update', async () => {
    const ctx = setup({ settings: { session: { rotateAfterTurns: 1 } } })
    ctx.setTranscript('me fala de gatos')
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    ctx.server.streamResponse(ctx.server.last, { text: ['Gatos são ótimos.'], audioMs: [300] })
    await flush()
    await playOut(ctx, 0.4)
    await flush()
    expect(ctx.server.sockets).toHaveLength(2)
    expect(ctx.server.last.sent[0]!.session).toEqual(expect.objectContaining({ tools: TOOLS, tool_choice: 'auto' }))

    ctx.server.last.serverClose(1006, 'gone')
    await flush()
    await vi.advanceTimersByTimeAsync(600)
    await flush()
    expect(ctx.server.sockets).toHaveLength(3)
    expect(ctx.server.last.sent[0]!.session).toEqual(expect.objectContaining({ tools: TOOLS, tool_choice: 'auto' }))
    expect(ctx.engine.getStatus()).toBe('listening')
  })
})

describe('Phase 10.3 CallEngine — inject', () => {
  const APPROVAL = '[Contexto] Ação aprovada: salvar nota. Resultado: nota salva.'

  it('listening → input_text with the context, then response.create; recorded with an empty userTranscript', async () => {
    const ctx = setup()
    expect(ctx.engine.inject(APPROVAL, 'approval')).toBe('dropped') // no call yet
    await startCall(ctx)
    const ws = ctx.server.last
    expect(ctx.engine.inject(APPROVAL, 'approval')).toBe('sent')
    expect(sentTypes(ws).slice(1)).toEqual(['conversation.item.create', 'response.create'])
    expect(inputTexts(ws)).toEqual([APPROVAL])
    expect(lastCreate(ws)).toEqual({ type: 'response.create', response: { tool_choice: 'none' } })
    expect(ctx.engine.getStatus()).toBe('thinking')
    ctx.server.streamResponse(ws, { text: ['Prontinho, salvei a nota!'], audioMs: [400] })
    await flush()
    expect(ctx.engine.getStatus()).toBe('speaking')
    await playOut(ctx, 0.5)
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(ctx.turns).toEqual([
      expect.objectContaining({ userTranscript: '', assistantSpokenText: 'Prontinho, salvei a nota!', interrupted: false }),
    ])
  })

  it('busy → one-slot queue (newest wins), flushed when the call is back to listening', async () => {
    const ctx = setup()
    ctx.setTranscript('me fala de gatos')
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    const ws = ctx.server.last
    ctx.server.streamResponse(ws, { text: ['Gatos são ótimos.'], audioMs: [500], done: false })
    await flush()
    expect(ctx.engine.getStatus()).toBe('speaking')
    expect(ctx.engine.inject('[Contexto] velho', 'initiative')).toBe('queued')
    expect(ctx.engine.inject(APPROVAL, 'approval')).toBe('queued')
    ws.deliver({ type: 'response.done', response: { status: 'completed' } })
    await flush()
    await playOut(ctx, 0.6)
    expect(inputTexts(ws).at(-1)).toBe(APPROVAL)
    expect(inputTexts(ws)).not.toContain('[Contexto] velho')
    expect(ctx.engine.getStatus()).toBe('thinking')
  })

  it('a queued inject expires after 30 s', async () => {
    const ctx = setup()
    ctx.setTranscript('me fala de gatos')
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    const ws = ctx.server.last
    ctx.server.streamResponse(ws, { text: ['Gatos são ótimos.'], audioMs: [500], done: false })
    await flush()
    expect(ctx.engine.inject(APPROVAL, 'approval')).toBe('queued')
    await vi.advanceTimersByTimeAsync(31000)
    ws.deliver({ type: 'response.done', response: { status: 'completed' } })
    await flush()
    await playOut(ctx, 0.6)
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(inputTexts(ws)).not.toContain(APPROVAL)
  })
})

describe('Phase 10.3 CallEngine — initiative', () => {
  const NUDGE = '[Contexto] (Iniciativa) Puxe assunto de forma natural sobre: gatos'

  it('after idleNudgeSec of silence asks host.checkInitiative and injects when it says speak', async () => {
    const ctx = setup({
      settings: { features: { initiativeInCall: true, idleNudgeSec: 20 } },
      checkInitiative: () => ({ speak: true, contextText: NUDGE }),
    })
    await startCall(ctx)
    await vi.advanceTimersByTimeAsync(19000)
    expect(ctx.initiativeChecks).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    expect(ctx.initiativeChecks).toHaveLength(1)
    expect(ctx.initiativeChecks[0]!.callId).toBe('call-1')
    expect(ctx.initiativeChecks[0]!.idleMs).toBeGreaterThanOrEqual(20000)
    expect(inputTexts(ctx.server.last)).toEqual([NUDGE])
    expect(ctx.engine.getStatus()).toBe('thinking')
  })

  it('a refusal re-arms the timer; speech / a turn restarts it', async () => {
    const ctx = setup({ settings: { features: { initiativeInCall: true, idleNudgeSec: 20 } } })
    ctx.setTranscript('me fala de gatos')
    await startCall(ctx)
    await vi.advanceTimersByTimeAsync(20500)
    expect(ctx.initiativeChecks).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(20000)
    expect(ctx.initiativeChecks).toHaveLength(2)
    expect(inputTexts(ctx.server.last)).toEqual([])

    await vi.advanceTimersByTimeAsync(15000)
    await speakTurn(ctx)
    await flush()
    ctx.server.streamResponse(ctx.server.last, { text: ['Gatos!'], audioMs: [300] })
    await flush()
    await playOut(ctx, 0.4)
    expect(ctx.engine.getStatus()).toBe('listening')
    await vi.advanceTimersByTimeAsync(15000)
    expect(ctx.initiativeChecks).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(6000)
    expect(ctx.initiativeChecks).toHaveLength(3)
  })

  it('mute suppresses initiative; it is off unless features.initiativeInCall', async () => {
    const ctx = setup({
      settings: { features: { initiativeInCall: true, idleNudgeSec: 20 } },
      checkInitiative: () => ({ speak: true, contextText: NUDGE }),
    })
    await startCall(ctx)
    ctx.engine.setMuted(true)
    await vi.advanceTimersByTimeAsync(45000)
    expect(ctx.initiativeChecks).toHaveLength(0)
    ctx.engine.setMuted(false)
    await vi.advanceTimersByTimeAsync(20000)
    await flush()
    expect(ctx.initiativeChecks).toHaveLength(1)

    const off = setup({ checkInitiative: () => ({ speak: true, contextText: NUDGE }) })
    await startCall(off)
    await vi.advanceTimersByTimeAsync(300000)
    expect(off.initiativeChecks).toHaveLength(0)
  })
})

describe('Phase 10.3 CallEngine — hybrid backend', () => {
  it('tool step → spoken answer in TEXT mode, phrases through the host /tts', async () => {
    const ctx = setup({
      backend: 'hybrid',
      executeTool: () => ({ status: 'executed', output: '{"title":"VS Code"}' }),
    })
    await startCall(ctx)
    const ws = ctx.server.last
    expect(ws.sent[0]!.session).toEqual(expect.objectContaining({ output_modalities: ['text'], tools: TOOLS }))
    await speakTurn(ctx)
    await flush()
    expect(lastCreate(ws)).toEqual({ type: 'response.create', response: { tool_choice: 'auto', output_modalities: ['text'] } })
    streamToolStep(ws, { calls: [{ name: 'get_active_window_title', callId: 'c1' }] })
    await flush()
    expect(lastCreate(ws)).toEqual({ type: 'response.create', response: { tool_choice: 'none', output_modalities: ['text'] } })
    ctx.server.streamResponse(ws, { text: ['Você está no VS Code. Quer ajuda com o código?'] })
    await flush()
    expect(ctx.synthesize.mock.calls.map((c) => c[0].text)).toEqual(['Você está no VS Code.', 'Quer ajuda com o código?'])
    expect(ctx.engine.getStatus()).toBe('speaking')
    await playOut(ctx, 0.65)
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(ctx.turns[0]).toEqual(
      expect.objectContaining({ assistantSpokenText: 'Você está no VS Code. Quer ajuda com o código?', interrupted: false }),
    )
  })

  it('a tool step without calls is spoken by the hybrid phrase TTS (speakText), no second generation', async () => {
    const ctx = setup({ backend: 'hybrid' })
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    const ws = ctx.server.last
    streamToolStep(ws, { text: ['Hmm, não sei qual janela.'] })
    await flush()
    expect(creates(ws)).toHaveLength(1)
    expect(ctx.synthesize.mock.calls.map((c) => c[0].text)).toEqual(['Hmm, não sei qual janela.'])
    await playOut(ctx, 0.35)
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(ctx.turns[0]!.assistantSpokenText).toBe('Hmm, não sei qual janela.')
  })
})
