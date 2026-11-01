import { describe, expect, it, vi } from 'vitest'

// Routing tests (Phase 10.4/10.5): the real factories are swapped for spies; nothing connects.
vi.mock('@ashy/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ashy/voice')>()
  return {
    ...actual,
    createCallEngine: vi.fn((opts: unknown) => ({ __engineOpts: opts })),
    createCloudVoiceSession: vi.fn((config: { backend: string }) => ({ __cloud: config.backend })),
    createCascadeSession: vi.fn((opts: unknown) => ({ __cascade: opts })),
    createLlamaCppRealtimeSession: vi.fn(() => ({ __llamacpp: 'realtime' })),
  }
})
import {
  DEFAULT_LIVE_MODE_SETTINGS,
  type AshyHostBridge,
  type AshyHostStreamEvent,
  type CallCommand,
  type CallRuntimeConfig,
  type CallStatus,
  type LiveCallInvokeInput,
} from '@ashy/shared'
import * as voice from '@ashy/voice'
import {
  bootCallEngine,
  createBackendSession,
  createDefaultCallEngine,
  isCallEngineView,
  type CallEngineFactory,
  type CallEngineLike,
  type CreateCallEngineArgs,
} from '../call-engine/boot'

function config(callId: string, withLlama = true): CallRuntimeConfig {
  return {
    callId,
    backend: 'llamacpp-realtime',
    sessionId: 's1',
    settings: structuredClone(DEFAULT_LIVE_MODE_SETTINGS),
    llamacpp: withLlama ? { baseUrl: 'http://127.0.0.1:5555', modelId: 'lfm3-omni-2b-q4km', contextSize: 8192 } : null,
  }
}

function createFakeHost(getRuntimeConfig: (payload: { callId: string }) => unknown) {
  const listeners = new Set<(event: AshyHostStreamEvent) => void>()
  const invokeLiveCall = vi.fn(async (input: LiveCallInvokeInput) => {
    switch (input.method) {
      case 'call:getRuntimeConfig':
        return getRuntimeConfig(input.payload as { callId: string })
      case 'call:getState':
        return { status: 'idle', callId: null }
      default:
        return { ok: true }
    }
  })
  const bridge = {
    invokeLiveCall,
    onHostEvent(l: (event: AshyHostStreamEvent) => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  } as unknown as AshyHostBridge
  return {
    bridge,
    invokeLiveCall,
    listenerCount: () => listeners.size,
    emit(cmd: CallCommand) {
      for (const l of [...listeners]) l({ type: 'call:command', ...cmd } as AshyHostStreamEvent)
    },
    reports: () =>
      invokeLiveCall.mock.calls.filter(([i]) => i.method === 'call:reportState').map(([i]) => i.payload),
  }
}

interface FakeEngine extends CallEngineLike {
  args: CreateCallEngineArgs
  status: CallStatus
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  setMuted: ReturnType<typeof vi.fn>
  inject: ReturnType<typeof vi.fn>
}

function createFakeFactory(opts: { failStart?: boolean } = {}) {
  const engines: FakeEngine[] = []
  const factory: CallEngineFactory = (args) => {
    const engine: FakeEngine = {
      args,
      status: 'idle',
      start: vi.fn(async () => {
        if (opts.failStart) throw new Error('ws refused')
        engine.status = 'listening'
        return engine.status
      }),
      stop: vi.fn(async () => {
        engine.status = 'idle'
      }),
      setMuted: vi.fn(),
      inject: vi.fn(() => 'sent'),
      getStatus: () => engine.status,
    }
    engines.push(engine)
    return engine
  }
  return { factory, engines }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('Phase 10.1 — call-engine boot (command routing, guards, error reporting)', () => {
  it('1. detects the call-engine view from the query string', () => {
    expect(isCallEngineView('?view=call-engine')).toBe(true)
    expect(isCallEngineView('?foo=1&view=call-engine')).toBe(true)
    expect(isCallEngineView('?view=stage-overlay')).toBe(false)
    expect(isCallEngineView('')).toBe(false)
  })

  it('2. start fetches the runtime config, creates the engine with a host over invokeLiveCall, routes setMuted/stop', async () => {
    const fake = createFakeHost((p) => config(p.callId))
    const { factory, engines } = createFakeFactory()
    const boot = bootCallEngine({ bridge: fake.bridge, createEngine: factory, log: () => undefined })

    fake.emit({ command: 'start', callId: 'c1', backend: 'llamacpp-realtime', sessionId: 's1' })
    await flush()
    expect(fake.invokeLiveCall).toHaveBeenCalledWith({ method: 'call:getRuntimeConfig', payload: { callId: 'c1' } })
    expect(engines).toHaveLength(1)
    expect(engines[0]!.args.config.llamacpp?.baseUrl).toBe('http://127.0.0.1:5555')
    expect(engines[0]!.start).toHaveBeenCalledTimes(1)
    expect(boot.getActiveCallId()).toBe('c1')

    // The injected host talks to the host through the generic RPC.
    const host = engines[0]!.args.host
    await host.buildContext({ callId: 'c1' })
    await host.transcribe({ callId: 'c1', audioWavBase64: 'AAAA' })
    await host.recordTurn({ callId: 'c1', userTranscript: 'oi', assistantSpokenText: 'olá', interrupted: false })
    await host.reportState({ callId: 'c1', status: 'listening' })
    await host.reportViseme({ A: 1, E: 0, I: 0, O: 0, U: 0, volume: 0.5 })
    const methods = fake.invokeLiveCall.mock.calls.map(([i]) => i.method)
    expect(methods).toEqual(
      expect.arrayContaining(['call:buildContext', 'call:transcribe', 'call:recordTurn', 'call:reportState', 'call:reportViseme']),
    )

    fake.emit({ command: 'setMuted', callId: 'c1', muted: true })
    await flush()
    expect(engines[0]!.setMuted).toHaveBeenCalledWith(true)

    fake.emit({ command: 'stop', callId: 'c1' })
    await flush()
    expect(engines[0]!.stop).toHaveBeenCalledWith('user_hangup')

    boot.dispose()
    expect(fake.listenerCount()).toBe(0)
  })

  it('3. ignores commands for another callId and a second start while a call runs; accepts a new callId after the old one ended', async () => {
    const fake = createFakeHost((p) => config(p.callId))
    const { factory, engines } = createFakeFactory()
    const boot = bootCallEngine({ bridge: fake.bridge, createEngine: factory, log: () => undefined })

    fake.emit({ command: 'start', callId: 'c1', backend: 'llamacpp-realtime', sessionId: 's1' })
    await flush()
    fake.emit({ command: 'setMuted', callId: 'other', muted: true })
    fake.emit({ command: 'stop', callId: 'other' })
    await flush()
    expect(engines[0]!.setMuted).not.toHaveBeenCalled()
    expect(engines[0]!.stop).not.toHaveBeenCalled()

    // Duplicate start and a concurrent start for another call are ignored.
    fake.emit({ command: 'start', callId: 'c1', backend: 'llamacpp-realtime', sessionId: 's1' })
    fake.emit({ command: 'start', callId: 'c2', backend: 'llamacpp-realtime', sessionId: 's1' })
    await flush()
    expect(engines).toHaveLength(1)

    // Once c1 has ended, a new callId starts a new engine.
    fake.emit({ command: 'stop', callId: 'c1' })
    await flush()
    fake.emit({ command: 'start', callId: 'c2', backend: 'llamacpp-realtime', sessionId: 's1' })
    await flush()
    expect(engines).toHaveLength(2)
    expect(engines[1]!.args.config.callId).toBe('c2')
    expect(boot.getActiveCallId()).toBe('c2')
    boot.dispose()
  })

  it('4. a stop that arrives while the config is loading cancels the start; setMuted before the engine exists is applied on creation', async () => {
    let release: (v: unknown) => void = () => undefined
    const fake = createFakeHost(() => new Promise((r) => (release = r)))
    const { factory, engines } = createFakeFactory()
    const boot = bootCallEngine({ bridge: fake.bridge, createEngine: factory, log: () => undefined })

    fake.emit({ command: 'start', callId: 'c1', backend: 'llamacpp-realtime', sessionId: 's1' })
    await flush()
    fake.emit({ command: 'stop', callId: 'c1' })
    release(config('c1'))
    await flush()
    expect(engines).toHaveLength(0)
    boot.dispose()

    let release2: (v: unknown) => void = () => undefined
    const fake2 = createFakeHost(() => new Promise((r) => (release2 = r)))
    const f2 = createFakeFactory()
    const boot2 = bootCallEngine({ bridge: fake2.bridge, createEngine: f2.factory, log: () => undefined })
    fake2.emit({ command: 'start', callId: 'c9', backend: 'llamacpp-realtime', sessionId: 's1' })
    await flush()
    fake2.emit({ command: 'setMuted', callId: 'c9', muted: true })
    release2(config('c9'))
    await flush()
    expect(f2.engines[0]!.setMuted).toHaveBeenCalledWith(true)
    boot2.dispose()
  })

  it('5. reports ended(backend_error) when the runtime config fails and ended(backend_unavailable) when the engine cannot start', async () => {
    const failing = createFakeHost(() => {
      throw new Error('CALL_NOT_ACTIVE')
    })
    const f1 = createFakeFactory()
    const boot1 = bootCallEngine({ bridge: failing.bridge, createEngine: f1.factory, log: () => undefined })
    failing.emit({ command: 'start', callId: 'c1', backend: 'llamacpp-realtime', sessionId: 's1' })
    await flush()
    expect(f1.engines).toHaveLength(0)
    expect(failing.reports()).toEqual([
      expect.objectContaining({ callId: 'c1', status: 'ended', reason: 'backend_error' }),
    ])
    boot1.dispose()

    const fake = createFakeHost((p) => config(p.callId))
    const f2 = createFakeFactory({ failStart: true })
    const boot2 = bootCallEngine({ bridge: fake.bridge, createEngine: f2.factory, log: () => undefined })
    fake.emit({ command: 'start', callId: 'c2', backend: 'llamacpp-realtime', sessionId: 's1' })
    await flush()
    expect(fake.reports()).toEqual([
      expect.objectContaining({ callId: 'c2', status: 'ended', reason: 'backend_unavailable', detail: 'ws refused' }),
    ])
    boot2.dispose()

    // Default factory without a llama.cpp endpoint -> backend_unavailable.
    const noLlama = createFakeHost((p) => config(p.callId, false))
    const boot3 = bootCallEngine({ bridge: noLlama.bridge, log: () => undefined })
    noLlama.emit({ command: 'start', callId: 'c3', backend: 'llamacpp-realtime', sessionId: 's1' })
    await flush()
    expect(noLlama.reports()).toEqual([
      expect.objectContaining({ callId: 'c3', status: 'ended', reason: 'backend_unavailable' }),
    ])
    boot3.dispose()
  })

  it('6. adopts a call the host already put in connecting before the boot subscribed', async () => {
    const fake = createFakeHost((p) => config(p.callId))
    fake.invokeLiveCall.mockImplementation(async (input: LiveCallInvokeInput) => {
      if (input.method === 'call:getState') {
        return { status: 'connecting', callId: 'early', backend: 'llamacpp-realtime', sessionId: 's1' }
      }
      if (input.method === 'call:getRuntimeConfig') return config('early')
      return { ok: true }
    })
    const { factory, engines } = createFakeFactory()
    const boot = bootCallEngine({ bridge: fake.bridge, createEngine: factory, log: () => undefined })
    await flush()
    expect(engines).toHaveLength(1)
    expect(boot.getActiveCallId()).toBe('early')
    // The late real command is a duplicate.
    fake.emit({ command: 'start', callId: 'early', backend: 'llamacpp-realtime', sessionId: 's1' })
    await flush()
    expect(engines).toHaveLength(1)
    boot.dispose()
  })

  it('7. Phase 10.3: inject goes to the active call only (also before the engine exists); executeTool/checkInitiative go over invokeLiveCall', async () => {
    const fake = createFakeHost((p) => config(p.callId))
    const { factory, engines } = createFakeFactory()
    const boot = bootCallEngine({ bridge: fake.bridge, createEngine: factory, log: () => undefined })
    fake.emit({ command: 'start', callId: 'c1', backend: 'llamacpp-realtime', sessionId: 's1' })
    await flush()
    fake.emit({ command: 'inject', callId: 'other', contextText: '[Contexto] x', reason: 'approval' })
    await flush()
    expect(engines[0]!.inject).not.toHaveBeenCalled()
    fake.emit({ command: 'inject', callId: 'c1', contextText: '[Contexto] Ação aprovada: nota.', reason: 'approval' })
    fake.emit({ command: 'inject', callId: 'c1', contextText: '   ', reason: 'initiative' })
    await flush()
    expect(engines[0]!.inject).toHaveBeenCalledTimes(1)
    expect(engines[0]!.inject).toHaveBeenCalledWith('[Contexto] Ação aprovada: nota.', 'approval')

    const host = engines[0]!.args.host
    await host.executeTool({ callId: 'c1', toolCallId: 't1', name: 'get_active_window_title', argsJson: '{}' })
    await host.checkInitiative({ callId: 'c1', idleMs: 90000 })
    expect(fake.invokeLiveCall).toHaveBeenCalledWith({
      method: 'call:executeTool',
      payload: { callId: 'c1', toolCallId: 't1', name: 'get_active_window_title', argsJson: '{}' },
    })
    expect(fake.invokeLiveCall).toHaveBeenCalledWith({ method: 'call:checkInitiative', payload: { callId: 'c1', idleMs: 90000 } })
    boot.dispose()

    // Before the engine exists: the latest inject is handed over on creation.
    let release: (v: unknown) => void = () => undefined
    const fake2 = createFakeHost(() => new Promise((r) => (release = r)))
    const f2 = createFakeFactory()
    const boot2 = bootCallEngine({ bridge: fake2.bridge, createEngine: f2.factory, log: () => undefined })
    fake2.emit({ command: 'start', callId: 'c9', backend: 'llamacpp-realtime', sessionId: 's1' })
    await flush()
    fake2.emit({ command: 'inject', callId: 'c9', contextText: '[Contexto] (Iniciativa) gatos', reason: 'initiative' })
    release(config('c9'))
    await flush()
    expect(f2.engines[0]!.inject).toHaveBeenCalledWith('[Contexto] (Iniciativa) gatos', 'initiative')
    boot2.dispose()
  })
})

describe('Phase 10.4/10.5 — default call-engine factory routing (cloud + cascade)', () => {
  const host = createCallEngineHostStub()

  function createCallEngineHostStub() {
    return {} as unknown as CreateCallEngineArgs['host']
  }

  function routedConfig(backend: CallRuntimeConfig['backend'], extra: Partial<CallRuntimeConfig> = {}): CallRuntimeConfig {
    return {
      callId: `call-${backend}`,
      backend,
      sessionId: 's1',
      settings: { ...structuredClone(DEFAULT_LIVE_MODE_SETTINGS), backend },
      llamacpp: null,
      ...extra,
    }
  }

  type EngineOpts = {
    callId: string
    settings: CallRuntimeConfig['settings']
    vadModelUrl: string
    contextSize?: number
    testInput?: unknown
    createSession: () => unknown
  }
  const lastEngineOpts = (): EngineOpts => {
    const calls = vi.mocked(voice.createCallEngine).mock.calls
    return calls[calls.length - 1]![0] as unknown as EngineOpts
  }

  it('8. openai-realtime: CallEngine over createCloudVoiceSession (no llama.cpp endpoint needed); test input passes through', () => {
    vi.mocked(voice.createCallEngine).mockClear()
    vi.mocked(voice.createCloudVoiceSession).mockClear()
    const cfg = routedConfig('openai-realtime', {
      cloud: { kind: 'openai-compatible', url: 'ws://127.0.0.1:4100/relay/abc', model: 'gpt-realtime-2.1-mini', voice: 'marin' },
    })
    const testInput = { wavBase64: 'UklGRg==', question: 'oi' } as unknown as NonNullable<CreateCallEngineArgs['testInput']>
    createDefaultCallEngine({ config: cfg, host, testInput })
    const opts = lastEngineOpts()
    expect(opts.callId).toBe('call-openai-realtime')
    expect(opts.vadModelUrl).toBe('/models/silero_vad.onnx')
    expect(opts.testInput).toBe(testInput)
    expect(opts.contextSize).toBeUndefined()
    expect(voice.createCloudVoiceSession).not.toHaveBeenCalled()
    expect(opts.createSession()).toEqual({ __cloud: 'openai-realtime' })
    expect(voice.createCloudVoiceSession).toHaveBeenCalledWith(cfg)
    // createBackendSession routes the same way.
    expect(createBackendSession(cfg, host)).toEqual({ __cloud: 'openai-realtime' })
  })

  it('9. gemini-live: cloud session; a cloud backend without a resolved endpoint fails fast', () => {
    vi.mocked(voice.createCloudVoiceSession).mockClear()
    const cfg = routedConfig('gemini-live', {
      cloud: { kind: 'gemini', url: 'ws://127.0.0.1:4100/relay/g', model: 'gemini-3.8-live', voice: 'Kore' },
    })
    createDefaultCallEngine({ config: cfg, host })
    expect(lastEngineOpts().testInput).toBeUndefined()
    expect(lastEngineOpts().createSession()).toEqual({ __cloud: 'gemini-live' })
    expect(() => createDefaultCallEngine({ config: routedConfig('gemini-live', { cloud: null }), host })).toThrow(
      /gemini-live has no cloud endpoint/,
    )
    expect(() => createDefaultCallEngine({ config: routedConfig('openai-realtime'), host })).toThrow(
      /openai-realtime has no cloud endpoint/,
    )
  })

  it('10. cascade: createCascadeCallEngine (transcribed input forced, no llama.cpp endpoint), session over the bridge', () => {
    vi.mocked(voice.createCascadeSession).mockClear()
    const cfg = routedConfig('cascade')
    cfg.settings.llamacpp.inputMode = 'audio-direct'
    createDefaultCallEngine({ config: cfg, host })
    const opts = lastEngineOpts()
    expect(opts.callId).toBe('call-cascade')
    expect(opts.settings.llamacpp.inputMode).toBe('transcribed')
    expect(voice.createCascadeSession).not.toHaveBeenCalled()
    opts.createSession()
    expect(voice.createCascadeSession).toHaveBeenCalledTimes(1)
    expect(voice.createCloudVoiceSession).not.toHaveBeenCalledWith(cfg)
  })

  it('11. llama.cpp backends still need their endpoint; unknown backends fail fast', () => {
    expect(() => createDefaultCallEngine({ config: routedConfig('llamacpp-realtime'), host })).toThrow(
      /no llama.cpp endpoint/,
    )
    const ok = { ...routedConfig('llamacpp-realtime'), llamacpp: { baseUrl: 'http://127.0.0.1:5555', modelId: 'm', contextSize: 4096 } }
    createDefaultCallEngine({ config: ok, host })
    expect(lastEngineOpts().contextSize).toBe(4096)
    expect(lastEngineOpts().createSession()).toEqual({ __llamacpp: 'realtime' })
    expect(() =>
      createDefaultCallEngine({ config: routedConfig('nope' as CallRuntimeConfig['backend']), host }),
    ).toThrow(/not implemented in the call engine: nope/)
  })
})
