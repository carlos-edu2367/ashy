import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAshyCortex } from '@ashy/cortex'
import {
  DEFAULT_LIVE_MODE_SETTINGS,
  type AshyHostStreamEvent,
  type CallSynthesizeResult,
  type LiveCallHostEvent,
  type LiveModeSettings,
} from '@ashy/shared'
import { createProviderVault } from '../host/provider-vault'
import { createTurnOrchestrator, type VoiceCallTurnEvent, type VoiceCallTurnInput } from '../host/turn-orchestrator'
import { createVoiceIdentityStore } from '../host/voice-identity-store'
import { createLiveCallRegistry } from '../host/live-call/registry'
import {
  createCascadeTtsRouter,
  registerCascadeHandlers,
  resolveCascadeLlm,
  type CascadeOrchestrator,
} from '../host/live-call/cascade'
import { encodeMonoPcm16Wav } from '../host/live-call/synthesize'
import {
  VOICE_CALL_DIRECTIVE_HEADER,
  buildVoiceCallPrompt,
  createLeadingLabelFilter,
  createVoiceStreamGuard,
  stripVoiceEmojis,
} from '../host/voice-call-prompt'
import type { CallRecord } from '../host/live-call/call-hub'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    } catch {
      // ignore Windows cleanup errors
    }
  }
})
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-10-5-'))
  tempDirs.push(dir)
  return dir
}

function settingsWith(cascade: Partial<LiveModeSettings['cascade']>): LiveModeSettings {
  return { ...structuredClone(DEFAULT_LIVE_MODE_SETTINGS), cascade: { ...DEFAULT_LIVE_MODE_SETTINGS.cascade, ...cascade } }
}

const llamaResult: CallSynthesizeResult = { pcmBase64: 'AAAA', sampleRate: 24000, durationMs: 1, latencyMs: 3 }

describe('Phase 10.5 — cascade TTS routing (call:synthesize for cascade calls)', () => {
  it("'llamacpp-tts' starts the engine and uses the cascade voice + reference voice", async () => {
    let settings = settingsWith({ ttsProviderId: 'llamacpp-tts', ttsVoice: 'male', referenceVoiceId: 'voz-1' })
    const llama = { synthesize: vi.fn(async () => llamaResult) }
    const ensureLlamaEngine = vi.fn(async () => {})
    const synthesizeSpeech = vi.fn()
    const router = createCascadeTtsRouter({ getSettings: () => settings, llama, ensureLlamaEngine, synthesizeSpeech })
    await expect(router.synthesize({ text: '  Olá!  ' })).resolves.toBe(llamaResult)
    expect(ensureLlamaEngine).toHaveBeenCalledTimes(1)
    expect(llama.synthesize).toHaveBeenCalledWith({ text: 'Olá!', voice: 'male', referenceVoiceId: 'voz-1' })
    expect(synthesizeSpeech).not.toHaveBeenCalled()
    settings = settingsWith({ ttsProviderId: 'llamacpp-tts', ttsVoice: 'anything', referenceVoiceId: null })
    await router.synthesize({ text: 'Oi' })
    expect(llama.synthesize).toHaveBeenLastCalledWith({ text: 'Oi', voice: 'female', referenceVoiceId: null })
    await expect(router.synthesize({ text: '   ' })).rejects.toThrow('TTS_EMPTY_TEXT')
  })

  it.each(['local-kokoro-http', 'openai-tts', 'elevenlabs'] as const)(
    "'%s' goes through the kernel voice provider and comes back as mono PCM16",
    async (providerId) => {
      const settings = settingsWith({ ttsProviderId: providerId, ttsVoice: providerId === 'openai-tts' ? 'nova' : 'female' })
      const pcm = new Int16Array(2400).fill(1000)
      const wav = Buffer.from(encodeMonoPcm16Wav(pcm, 24000)).toString('base64')
      const synthesizeSpeech = vi.fn(async () => ({ audioBase64: wav, synthesisLatencyMs: 42 }))
      const llama = { synthesize: vi.fn() }
      const router = createCascadeTtsRouter({ getSettings: () => settings, llama, ensureLlamaEngine: vi.fn(), synthesizeSpeech })
      const res = await router.synthesize({ text: 'Oi Carlos.' })
      expect(llama.synthesize).not.toHaveBeenCalled()
      expect(synthesizeSpeech).toHaveBeenCalledWith({
        text: 'Oi Carlos.',
        providerId,
        // llama.cpp voice names never leak into another provider.
        ...(providerId === 'openai-tts' ? { voiceId: 'nova' } : {}),
      })
      expect(res.sampleRate).toBe(24000)
      expect(res.durationMs).toBe(100)
      expect(res.latencyMs).toBe(42)
      expect(Buffer.from(res.pcmBase64, 'base64').readInt16LE(0)).toBe(1000)
    },
  )

  it('rejects a provider that produced no audio (browser TTS signal) or is not wired', async () => {
    const settings = settingsWith({ ttsProviderId: 'local-kokoro-http' })
    const browser = createCascadeTtsRouter({
      getSettings: () => settings,
      llama: { synthesize: vi.fn() },
      ensureLlamaEngine: vi.fn(),
      synthesizeSpeech: async () => ({ audioBase64: '', delivery: 'use-browser-tts' }),
    })
    await expect(browser.synthesize({ text: 'x' })).rejects.toThrow('TTS_BAD_AUDIO')
    const unwired = createCascadeTtsRouter({ getSettings: () => settings, llama: { synthesize: vi.fn() }, ensureLlamaEngine: vi.fn() })
    await expect(unwired.synthesize({ text: 'x' })).rejects.toThrow('TTS_UNAVAILABLE')
  })
})

describe('Phase 10.5 — call:cascadeTurn / call:cascadeAbort handlers', () => {
  function setup(opts: { backend?: CallRecord['backend']; test?: boolean; toolsInCall?: boolean; settings?: Partial<LiveModeSettings['cascade']> } = {}) {
    const registry = createLiveCallRegistry()
    const emitted: LiveCallHostEvent[] = []
    const call: CallRecord = { callId: 'call-1', sessionId: 'sess-1', backend: opts.backend ?? 'cascade', test: opts.test ?? false }
    const runs: Array<{ input: VoiceCallTurnInput; sink: (e: VoiceCallTurnEvent) => void; turnId: string }> = []
    const aborted: string[] = []
    let n = 0
    let pendingNote: string | null = null
    const orchestrator: CascadeOrchestrator = {
      runVoiceCallTurn: vi.fn((input, sink) => {
        n += 1
        const turnId = `voice-turn-${n}`
        runs.push({ input, sink, turnId })
        return { turnId }
      }),
      abortTurn: vi.fn(async (turnId: string) => {
        aborted.push(turnId)
        runs.find((r) => r.turnId === turnId)?.sink({ kind: 'aborted' })
      }),
    }
    const settings = settingsWith({ llmProviderId: 'ollama', llmModelId: 'qwen3:4b-instruct', ...(opts.settings ?? {}) })
    const handlers = registerCascadeHandlers({
      registry,
      emit: (e) => emitted.push(e),
      getSettings: () => settings,
      getOrchestrator: () => orchestrator,
      getKnownCall: (id) => (id === call.callId ? call : null),
      getActiveCall: () => call,
      getUserName: () => 'Carlos',
      toolDeps: { getRuntime: () => null, describeScreen: async () => ({ ok: false, text: 'off', reason: 'eyes_off' }) as never },
      toolsAllowed: (c) => !c.test && (opts.toolsInCall ?? true),
      getPendingActionNote: () => pendingNote,
    })
    return { registry, emitted, runs, aborted, orchestrator, handlers, setPendingNote: (t: string | null) => (pendingNote = t) }
  }

  it('runs the turn through the orchestrator with the cascade LLM and streams call:cascade events for that turnId', async () => {
    const ctx = setup()
    const res = await ctx.registry.invoke('call:cascadeTurn', {
      callId: 'call-1',
      turnId: 'c-1',
      text: 'me conta de júpiter',
      context: '[Contexto] hora local 21:00',
      toolChoice: 'none',
    })
    expect(res).toEqual({ turnId: 'c-1', accepted: true })
    expect(ctx.runs[0]!.input).toEqual({
      sessionId: 'sess-1',
      userText: 'me conta de júpiter',
      callContext: '[Contexto] hora local 21:00',
      userName: 'Carlos',
      providerId: 'ollama',
      modelId: 'qwen3:4b-instruct',
    })
    ctx.runs[0]!.sink({ kind: 'delta', delta: 'Júpiter é enorme.' })
    ctx.runs[0]!.sink({ kind: 'done', text: 'Júpiter é enorme.', providerId: 'ollama', modelId: 'qwen3:4b-instruct', latencyMs: 400 })
    expect(ctx.emitted).toEqual([
      { type: 'call:cascade', callId: 'call-1', turnId: 'c-1', kind: 'delta', delta: 'Júpiter é enorme.' },
      { type: 'call:cascade', callId: 'call-1', turnId: 'c-1', kind: 'done', text: 'Júpiter é enorme.', providerId: 'ollama', modelId: 'qwen3:4b-instruct', latencyMs: 400 },
    ])
    expect(ctx.handlers.activeTurnCount()).toBe(0)
  })

  it("offers the 4 lean call tools only when the host tool policy says 'auto' (never in a test call)", async () => {
    const ctx = setup()
    await ctx.registry.invoke('call:cascadeTurn', { callId: 'call-1', turnId: 'c-1', text: 'anota isso', toolChoice: 'auto' })
    expect(ctx.runs[0]!.input.tools?.map((t) => t.name)).toEqual([
      'get_active_window_title',
      'capture_authorized_screen',
      'read_workspace_file',
      'write_project_note',
    ])
    await ctx.registry.invoke('call:cascadeTurn', { callId: 'call-1', turnId: 'c-2', text: 'tudo bem?', toolChoice: 'none' })
    expect(ctx.runs[1]!.input.tools).toBeUndefined()
    const test = setup({ test: true })
    await test.registry.invoke('call:cascadeTurn', { callId: 'call-1', turnId: 'c-1', text: 'anota isso', toolChoice: 'auto' })
    expect(test.runs[0]!.input.tools).toBeUndefined()
  })

  it('adds the "still pending, not done" note while an action of this call awaits approval', async () => {
    const ctx = setup()
    ctx.setPendingNote('[Contexto] Ação pendente, AINDA NÃO feita: salvar a nota "Leite".')
    await ctx.registry.invoke('call:cascadeTurn', { callId: 'call-1', turnId: 'c-1', text: 'partisim', context: '[Contexto] hora' })
    expect(ctx.runs[0]!.input.callContext).toBe('[Contexto] hora\n[Contexto] Ação pendente, AINDA NÃO feita: salvar a nota "Leite".')
  })

  it('a new turn aborts the previous one; call:cascadeAbort aborts by turnId only', async () => {
    const ctx = setup()
    await ctx.registry.invoke('call:cascadeTurn', { callId: 'call-1', turnId: 'c-1', text: 'um' })
    await ctx.registry.invoke('call:cascadeTurn', { callId: 'call-1', turnId: 'c-2', text: 'dois' })
    expect(ctx.aborted).toEqual(['voice-turn-1'])
    await expect(ctx.registry.invoke('call:cascadeAbort', { callId: 'call-1', turnId: 'c-1' })).resolves.toEqual({ aborted: false })
    await expect(ctx.registry.invoke('call:cascadeAbort', { callId: 'call-1', turnId: 'c-2' })).resolves.toEqual({ aborted: true })
    expect(ctx.aborted).toEqual(['voice-turn-1', 'voice-turn-2'])
    // Late output of an aborted turn is dropped; its 'aborted' is forwarded.
    ctx.runs[1]!.sink({ kind: 'delta', delta: 'tarde demais' })
    expect(ctx.emitted.map((e) => (e as { kind?: string }).kind)).toEqual(['aborted', 'aborted'])
  })

  it('rejects unknown / non-cascade calls and bad payloads', async () => {
    const ctx = setup({ backend: 'llamacpp-hybrid' })
    await expect(ctx.registry.invoke('call:cascadeTurn', { callId: 'call-1', turnId: 'c-1', text: 'oi' })).rejects.toThrow('CASCADE_WRONG_BACKEND')
    const ok = setup()
    await expect(ok.registry.invoke('call:cascadeTurn', { callId: 'nope', turnId: 'c-1', text: 'oi' })).rejects.toThrow('CALL_UNKNOWN')
    await expect(ok.registry.invoke('call:cascadeTurn', { callId: 'call-1', turnId: 'bad id!', text: 'oi' })).rejects.toThrow('Invalid payload')
  })

  it("resolveCascadeLlm: 'chat-default' = active chat provider, model override kept", () => {
    expect(resolveCascadeLlm(settingsWith({ llmProviderId: 'chat-default', llmModelId: '' }))).toEqual({})
    expect(resolveCascadeLlm(settingsWith({ llmProviderId: 'chat-default', llmModelId: 'gpt-x' }))).toEqual({ modelId: 'gpt-x' })
    expect(resolveCascadeLlm(settingsWith({ llmProviderId: 'openrouter', llmModelId: '' }))).toEqual({ providerId: 'openrouter' })
    expect(() => resolveCascadeLlm(settingsWith({ llmProviderId: 'bogus' }))).toThrow('CASCADE_LLM_UNKNOWN')
  })
})

describe('Phase 10.5 — voice-call prompt', () => {
  const compiled = [
    '[IDENTIDADE] Ashy completa…',
    '[MEMÓRIA ATIVA — fatos]',
    '- Fato: o usuário adora astronomia',
    '',
    '[OUTRA SEÇÃO]',
    'x',
  ].join('\n')

  it('compact (small local models): identity + name + directive + bastidores in the system prompt; the user turn is only the words', () => {
    const a = buildVoiceCallPrompt({ compiledSystemPrompt: compiled, compiledUserTurn: 'oi', userText: 'oi', callContext: '[Contexto]\nHora local: 21:00.', userName: 'Carlos', compact: true, toolsAvailable: true })
    expect(a.system).toContain(VOICE_CALL_DIRECTIVE_HEADER)
    expect(a.system).toContain('O nome do usuário é Carlos.')
    expect(a.system).not.toMatch(/<\|ACT/)
    expect(a.system).toContain('Hora local: 21:00.')
    expect(a.system).toContain('astronomia')
    expect(a.system).toContain('write_project_note')
    expect(a.userTurn).toBe('oi')
    const b = buildVoiceCallPrompt({ compiledSystemPrompt: compiled, compiledUserTurn: '', userText: '', compact: true })
    expect(b.system).not.toContain('write_project_note')
    expect(b.userTurn).toContain('iniciativa própria')
  })

  it('the voice stream guard cuts at a bracketed note or a new speaker turn (real LFM3 failure modes)', () => {
    const run = (deltas: string[]) => {
      const out: string[] = []
      const g = createVoiceStreamGuard((t) => out.push(t))
      for (const d of deltas) g.write(d)
      g.flush()
      return { text: out.join(''), cut: g.cut }
    }
    expect(run(['Um buraco negro prende até a luz. [Res', 'umo] Carlos resumiu…'])).toEqual({ text: 'Um buraco negro prende até a luz. ', cut: true })
    expect(run(['Nebulosa, que tal? ', '[Contexto] O contexto mostra'])).toEqual({ text: 'Nebulosa, que tal? ', cut: true })
    expect(run(['Claro!', '\nUsu', 'ário: e o gato?'])).toEqual({ text: 'Claro!', cut: true })
    expect(run(['Ele riu [risos] e ', 'saiu.\nDepois voltou.'])).toEqual({ text: 'Ele riu [risos] e saiu.\nDepois voltou.', cut: false })
    expect(run(['Ashy: Oi!'])).toEqual({ text: 'Oi!', cut: false })
  })

  it('full (cloud models): compiled Ashy prompt + directive; proactive turn without user text', () => {
    const p = buildVoiceCallPrompt({ compiledSystemPrompt: compiled, compiledUserTurn: 'oi', userText: '', callContext: '[Contexto] Ação aprovada: salvar a nota.', compact: false })
    expect(p.system.startsWith('[IDENTIDADE] Ashy completa')).toBe(true)
    expect(p.system).toContain(VOICE_CALL_DIRECTIVE_HEADER)
    expect(p.userTurn).toContain('Ação aprovada')
    expect(p.userTurn).toContain('iniciativa própria')
  })

  it('drops a leading speaker label and emojis from the spoken stream', () => {
    const out: string[] = []
    const f = createLeadingLabelFilter((t) => out.push(t))
    for (const d of ['Ash', 'y: ', 'Oi, ', 'Carlos!']) f.write(d)
    f.flush()
    expect(out.join('')).toBe('Oi, Carlos!')
    const out2: string[] = []
    const g = createLeadingLabelFilter((t) => out2.push(t))
    g.write('Claro')
    g.flush()
    expect(out2.join('')).toBe('Claro')
    expect(stripVoiceEmojis('Oi 😄 tudo bem? ✨')).toBe('Oi tudo bem? ')
  })
})

describe('Phase 10.5 — TurnOrchestrator.runVoiceCallTurn (real orchestrator, mocked Ollama)', () => {
  function ndjson(lines: unknown[]): Response {
    const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
  }

  function setup(chunks: string[], opts: { hang?: boolean } = {}) {
    const dir = makeTempDir()
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      requests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
      if (opts.hang) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }
      return ndjson([...chunks.map((c) => ({ message: { role: 'assistant', content: c }, done: false })), { done: true, done_reason: 'stop' }])
    })
    const cortex = createAshyCortex({ dbPath: ':memory:' })
    cortex.createChatSession({ id: 'sess-1', title: 'Chamada' })
    cortex.appendVoiceTurn({
      sessionId: 'sess-1',
      userTranscript: 'Meu nome é Carlos e eu adoro astronomia.',
      assistantSpokenText: 'Que legal, Carlos!',
      interrupted: false,
      emotion: 'happy',
      backendId: 'cascade',
      modelId: 'qwen3:4b-instruct',
      turnId: 'voice-prev-1',
      nowMs: Date.now() - 5000,
    } as Parameters<typeof cortex.appendVoiceTurn>[0])
    const providerVault = createProviderVault({ userDataDir: dir, fetchImpl: fetchImpl as unknown as typeof fetch })
    providerVault.saveProviderConfig({ providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M' })
    providerVault.setActiveProvider('ollama')
    const orchestrator = createTurnOrchestrator({
      cortex,
      voiceStore: createVoiceIdentityStore({ userDataDir: dir }),
      providerVault,
      getBootstrapSnapshot: () => {
        throw new Error('unused')
      },
    })
    const chatEvents: AshyHostStreamEvent[] = []
    orchestrator.onEvent((e) => chatEvents.push(e))
    return { cortex, orchestrator, requests, chatEvents }
  }

  it('streams a short spoken answer (model override, no thinking, voice directive, call history) and persists nothing', async () => {
    const ctx = setup(['Ashy: ', '<|ACT {"emotion":"happy","intensity":0.7}|>', 'Lembro sim, ', 'Carlos! 😄 ', 'Você adora astronomia.'])
    const before = ctx.cortex.listChatMessages('sess-1', 80).length
    const events: VoiceCallTurnEvent[] = []
    const { turnId } = ctx.orchestrator.runVoiceCallTurn(
      { sessionId: 'sess-1', userText: 'Você lembra do meu nome?', callContext: '[Contexto]\nHora local: 21:00.', userName: 'Carlos', providerId: 'ollama', modelId: 'qwen3:4b-instruct' },
      (e) => events.push(e),
    )
    expect(turnId).toMatch(/^voice-turn-/)
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done' || e.kind === 'error')).toBe(true))
    const done = events.find((e) => e.kind === 'done') as Extract<VoiceCallTurnEvent, { kind: 'done' }>
    expect(done).toMatchObject({ providerId: 'ollama', modelId: 'qwen3:4b-instruct', text: 'Lembro sim, Carlos! Você adora astronomia.' })
    const spoken = events.filter((e) => e.kind === 'delta').map((e) => (e as { delta: string }).delta).join('')
    expect(spoken).toBe('<|ACT {"emotion":"happy","intensity":0.7}|>Lembro sim, Carlos! Você adora astronomia.')

    const req = ctx.requests[0]!
    expect(req.url).toBe('http://127.0.0.1:11434/api/chat')
    expect(req.body.model).toBe('qwen3:4b-instruct')
    expect(req.body.think).toBe(false)
    expect((req.body.options as { num_predict?: number }).num_predict).toBe(260)
    const messages = req.body.messages as Array<{ role: string; content: string }>
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toContain(VOICE_CALL_DIRECTIVE_HEADER)
    expect(messages.some((m) => m.role === 'user' && m.content.includes('adoro astronomia'))).toBe(true)
    expect(messages.at(-1)!.content).toBe('Você lembra do meu nome?')
    expect(messages[0]!.content).toContain('Hora local: 21:00.')
    expect(req.body.tools).toBeUndefined()

    // No persistence (the call recorder stores what was heard) and nothing on the chat stream.
    expect(ctx.cortex.listChatMessages('sess-1', 80)).toHaveLength(before)
    expect(ctx.chatEvents).toHaveLength(0)
    ctx.cortex.close()
  })

  it('cuts the spoken answer at a "[Resumo]" note the small model starts writing', async () => {
    const ctx = setup(['Um buraco negro prende até a luz. ', '[Resumo] Carlos ', 'resumiu o buraco negro.'])
    const events: VoiceCallTurnEvent[] = []
    ctx.orchestrator.runVoiceCallTurn({ sessionId: 'sess-1', userText: 'resume' }, (e) => events.push(e))
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true))
    expect((events.find((e) => e.kind === 'done') as { text: string }).text).toBe('Um buraco negro prende até a luz.')
    ctx.cortex.close()
  })

  it('abortTurn ends the turn with "aborted" on its own sink (no chat turn:aborted)', async () => {
    const ctx = setup([], { hang: true })
    const events: VoiceCallTurnEvent[] = []
    const { turnId } = ctx.orchestrator.runVoiceCallTurn({ sessionId: 'sess-1', userText: 'oi' }, (e) => events.push(e))
    await vi.waitFor(() => expect(ctx.requests).toHaveLength(1))
    await ctx.orchestrator.abortTurn(turnId)
    await vi.waitFor(() => expect(events.map((e) => e.kind)).toEqual(['aborted']))
    expect(ctx.chatEvents).toHaveLength(0)
    ctx.cortex.close()
  })

  it('reports PROVIDER_NOT_CONFIGURED for a provider without a key', async () => {
    const ctx = setup(['x'])
    const events: VoiceCallTurnEvent[] = []
    ctx.orchestrator.runVoiceCallTurn({ sessionId: 'sess-1', userText: 'oi', providerId: 'openai' }, (e) => events.push(e))
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ kind: 'error' })
    expect((events[0] as { message: string }).message).toContain('PROVIDER_NOT_CONFIGURED')
    expect(ctx.requests).toHaveLength(0)
    ctx.cortex.close()
  })
})

describe('Phase 10.5 — voice approval tolerates the STT spelling seen in the real run', () => {
  it('"Podi sim, por favor." approves; "podia ser" does not', async () => {
    const { classifyVoiceApproval } = await import('../host/live-call/approvals')
    expect(classifyVoiceApproval('Podi sim, por favor.')).toBe('approve')
    expect(classifyVoiceApproval('Podi.')).toBe('approve')
    expect(classifyVoiceApproval('podia ser')).toBeNull()
  })
})
