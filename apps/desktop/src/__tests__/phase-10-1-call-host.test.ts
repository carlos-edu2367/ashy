import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIVE_MODE_SETTINGS,
  LIVE_LOCAL_MODELS,
  type AshyHostStreamEvent,
  type CallContextResult,
  type CallRuntimeConfig,
  type CallStateSnapshot,
  type CallTranscribeResult,
  type LiveModeSettings,
  type LlamaCppEngineStatus,
} from '@ashy/shared'
import { encodeWavPcm16 } from '@ashy/voice'
import { createAshyHostKernel, type AshyHostKernel } from '../host/kernel'
import {
  INTERRUPTED_REPLY_SUFFIX,
  VOICE_UNTRANSCRIBED_PLACEHOLDER_TEXT,
  sanitizeConversationHistory,
} from '../host/conversation-history'
import { registerCallHostHandlers, type CallHostDeps } from '../host/live-call/handlers'
import { CALL_INSTRUCTIONS_MODE_LINE } from '../host/live-call/context'

const tempDirs: string[] = []
const kernels: AshyHostKernel[] = []

async function makeKernel(): Promise<AshyHostKernel> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-call-host-'))
  tempDirs.push(dir)
  const kernel = await createAshyHostKernel({ userDataDir: dir })
  kernels.push(kernel)
  return kernel
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (kernels.length > 0) {
    await kernels.pop()!.stop()
  }
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    } catch {
      // Windows EPERM on a leaked handle
    }
  }
})

const MODEL_ID = DEFAULT_LIVE_MODE_SETTINGS.llamacpp.modelId

function baseStatus(overrides: Partial<LlamaCppEngineStatus> = {}): LlamaCppEngineStatus {
  return {
    engineId: 'llamacpp',
    build: 'b12024',
    installed: true,
    installedVariant: 'cuda-12.4',
    detectedGpu: null,
    running: false,
    managed: true,
    baseUrl: null,
    port: null,
    activeModelId: null,
    installedModelIds: [MODEL_ID],
    activeDownload: null,
    lastError: null,
    vcRuntimeMissing: false,
    vcRuntimeInstall: null,
    ...overrides,
  }
}

function wavBase64(durationMs: number, sampleRate = 16000): string {
  const samples = new Float32Array(Math.round((sampleRate * durationMs) / 1000))
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 8) * 0.3
  return Buffer.from(encodeWavPcm16(samples, sampleRate)).toString('base64')
}

async function makeHarness(
  opts: {
    status?: Partial<LlamaCppEngineStatus>
    startImpl?: (modelId?: string) => Promise<LlamaCppEngineStatus>
    deps?: Partial<CallHostDeps>
    settings?: LiveModeSettings
  } = {},
) {
  const kernel = await makeKernel()
  const session = await kernel.createSession('Chamada teste')
  const events: AshyHostStreamEvent[] = []
  kernel.onHostEvent((e) => events.push(e))

  const status = baseStatus(opts.status)
  const engine = {
    getStatus: vi.fn(() => ({ ...status })),
    start: vi.fn(
      opts.startImpl ??
        (async (modelId?: string) => {
          status.running = true
          status.baseUrl = 'http://127.0.0.1:39123'
          status.port = 39123
          status.activeModelId = modelId ?? MODEL_ID
          return { ...status }
        }),
    ),
    getModelSpec: (id: string) => LIVE_LOCAL_MODELS.find((m) => m.id === id),
  }
  const controller = { ensure: vi.fn(async () => undefined), destroy: vi.fn() }
  kernel.setCallWindowController(controller)
  const transcribe = vi.fn(async () => ({
    text: 'oi ashy, tudo bem?',
    providerId: 'ollama-transcriptions',
    latencyMs: 42,
  }))
  const clock = { t: 1_800_000_000_000 }
  const settings = opts.settings ?? structuredClone(DEFAULT_LIVE_MODE_SETTINGS)
  let seq = 0
  registerCallHostHandlers(kernel.liveCall, {
    settings: { get: () => settings },
    engine,
    getCortex: () => kernel.cortex,
    resolveSessionId: () => session.id,
    transcribe,
    now: () => clock.t,
    createCallId: () => `call-test-${++seq}`,
    ...opts.deps,
  })
  const invoke = <T = unknown>(method: string, payload?: unknown) =>
    kernel.invokeLiveCall({ method: method as never, payload }) as Promise<T>
  const ofType = <K extends AshyHostStreamEvent['type']>(type: K) =>
    events.filter((e): e is Extract<AshyHostStreamEvent, { type: K }> => e.type === type)
  return { kernel, session, events, engine, controller, transcribe, clock, invoke, ofType }
}

describe('Phase 10.1 — call host services (hub, context, transcribe, recorder)', () => {
  it('the kernel wires call:* handlers itself (real engine in an empty userData → engine_not_installed)', async () => {
    const kernel = await makeKernel()
    await expect(kernel.invokeLiveCall({ method: 'call:getState' })).resolves.toMatchObject({
      status: 'idle',
      callId: null,
    })
    const ended = (await kernel.invokeLiveCall({
      method: 'call:start',
      payload: {},
    })) as CallStateSnapshot
    expect(ended).toMatchObject({ status: 'ended', reason: 'engine_not_installed' })
    expect(ended.updatedAt).toBeGreaterThan(0)
  })

  it('call:start starts the engine, ensures the window, emits call:command start + call:state connecting', async () => {
    const h = await makeHarness()
    const state = await h.invoke<CallStateSnapshot>('call:start', { backend: 'llamacpp-realtime' })

    expect(h.engine.start).toHaveBeenCalledWith(MODEL_ID)
    expect(h.controller.ensure).toHaveBeenCalledTimes(1)
    expect(state).toMatchObject({
      callId: 'call-test-1',
      status: 'connecting',
      backend: 'llamacpp-realtime',
      sessionId: h.session.id,
      muted: false,
      reason: null,
      updatedAt: h.clock.t,
    })
    expect(h.ofType('call:command')).toEqual([
      {
        type: 'call:command',
        command: 'start',
        callId: 'call-test-1',
        backend: 'llamacpp-realtime',
        sessionId: h.session.id,
      },
    ])
    expect(h.ofType('call:state').at(-1)?.state).toEqual(state)

    // A second start while active returns the current state without a new call.
    const again = await h.invoke<CallStateSnapshot>('call:start', {})
    expect(again.callId).toBe('call-test-1')
    expect(h.ofType('call:command')).toHaveLength(1)
    expect(h.engine.start).toHaveBeenCalledTimes(1)

    const cfg = await h.invoke<CallRuntimeConfig>('call:getRuntimeConfig', { callId: 'call-test-1' })
    expect(cfg).toMatchObject({
      callId: 'call-test-1',
      backend: 'llamacpp-realtime',
      sessionId: h.session.id,
      llamacpp: { baseUrl: 'http://127.0.0.1:39123', modelId: MODEL_ID, contextSize: 16384 },
    })
    expect(cfg.settings.llamacpp.inputMode).toBe('transcribed')
    await expect(h.invoke('call:getRuntimeConfig', { callId: 'nope' })).rejects.toThrow(/CALL_NOT_ACTIVE/)
  })

  it('does not restart an engine that is already running the model', async () => {
    const h = await makeHarness({
      status: { running: true, baseUrl: 'http://127.0.0.1:4000', activeModelId: MODEL_ID },
    })
    await h.invoke('call:start', {})
    expect(h.engine.start).not.toHaveBeenCalled()
  })

  it('call:reportState merges reports from the active callId and ignores a wrong callId', async () => {
    const h = await makeHarness()
    await h.invoke('call:start', {})
    h.clock.t += 10
    const s1 = await h.invoke<CallStateSnapshot>('call:reportState', {
      callId: 'call-test-1',
      status: 'listening',
      metrics: { endpointMs: 700 },
    })
    expect(s1).toMatchObject({ status: 'listening', metrics: { endpointMs: 700 }, updatedAt: h.clock.t })

    h.clock.t += 10
    const s2 = await h.invoke<CallStateSnapshot>('call:reportState', {
      callId: 'call-test-1',
      status: 'speaking',
      caption: { role: 'assistant', text: 'Oi!', final: false },
      metrics: { e2eMs: 1100 },
    })
    expect(s2).toMatchObject({
      status: 'speaking',
      caption: { role: 'assistant', text: 'Oi!', final: false },
      metrics: { endpointMs: 700, e2eMs: 1100 },
      muted: false,
      sessionId: h.session.id,
    })

    const statesBefore = h.ofType('call:state').length
    const ignored = await h.invoke<CallStateSnapshot>('call:reportState', {
      callId: 'call-other',
      status: 'ended',
      reason: 'backend_error',
    })
    expect(ignored).toEqual(s2)
    expect(h.ofType('call:state')).toHaveLength(statesBefore)

    await expect(h.invoke('call:reportState', { callId: 'call-test-1', status: 'bogus' })).rejects.toThrow(
      /Invalid payload for call:reportState/,
    )

    // Engine-reported end clears the active call.
    const ended = await h.invoke<CallStateSnapshot>('call:reportState', {
      callId: 'call-test-1',
      status: 'ended',
      reason: 'mic_denied',
    })
    expect(ended).toMatchObject({ status: 'ended', reason: 'mic_denied' })
    const restarted = await h.invoke<CallStateSnapshot>('call:start', {})
    expect(restarted.callId).toBe('call-test-2')
  })

  it('call:setMuted emits call:command setMuted + state; call:stop emits stop, ended(user_hangup) then idle', async () => {
    const h = await makeHarness()
    await h.invoke('call:start', {})
    const muted = await h.invoke<CallStateSnapshot>('call:setMuted', { muted: true })
    expect(muted.muted).toBe(true)
    expect(h.ofType('call:command').at(-1)).toEqual({
      type: 'call:command',
      command: 'setMuted',
      callId: 'call-test-1',
      muted: true,
    })

    const idle = await h.invoke<CallStateSnapshot>('call:stop', {})
    expect(idle).toMatchObject({ status: 'idle', callId: null })
    expect(h.ofType('call:command').at(-1)).toEqual({
      type: 'call:command',
      command: 'stop',
      callId: 'call-test-1',
    })
    const lastTwo = h.ofType('call:state').slice(-2).map((e) => e.state)
    expect(lastTwo[0]).toMatchObject({ status: 'ended', reason: 'user_hangup', callId: 'call-test-1' })
    expect(lastTwo[1]).toMatchObject({ status: 'idle', reason: null })
    await expect(h.invoke('call:getState')).resolves.toMatchObject({ status: 'idle' })
  })

  it('ends with engine_not_installed / backend_not_implemented / backend_unavailable', async () => {
    const notInstalled = await makeHarness({ status: { installed: false, installedModelIds: [] } })
    await expect(notInstalled.invoke('call:start', {})).resolves.toMatchObject({
      status: 'ended',
      reason: 'engine_not_installed',
    })
    expect(notInstalled.engine.start).not.toHaveBeenCalled()
    expect(notInstalled.controller.ensure).not.toHaveBeenCalled()
    expect(notInstalled.ofType('call:command')).toHaveLength(0)

    const noModel = await makeHarness({ status: { installedModelIds: [] } })
    await expect(noModel.invoke('call:start', {})).resolves.toMatchObject({
      status: 'ended',
      reason: 'engine_not_installed',
    })

    // Phase 10.4: gemini-live is implemented; without its API key (cloud deps absent here) the call
    // ends backend_unavailable before touching the llama.cpp engine.
    const notImpl = await makeHarness()
    await expect(notImpl.invoke('call:start', { backend: 'gemini-live' })).resolves.toMatchObject({
      status: 'ended',
      reason: 'backend_unavailable',
      backend: 'gemini-live',
    })
    expect(notImpl.engine.getStatus).not.toHaveBeenCalled()

    const unavailable = await makeHarness({
      startImpl: async () => {
        throw new Error('health timeout')
      },
    })
    const s = await unavailable.invoke<CallStateSnapshot>('call:start', {})
    expect(s).toMatchObject({ status: 'ended', reason: 'backend_unavailable', detail: 'health timeout' })
  })

  it('call:buildContext: English instructions with the exact mode line last, no "Perform TTS", PT per-turn context', async () => {
    const h = await makeHarness({
      deps: { retrieveMemories: () => ({ memories: ['O Carlos adora gatos e tem uma gata chamada Mia.'] }) },
    })
    await h.invoke('call:start', {})

    const base = await h.invoke<CallContextResult>('call:buildContext', { callId: 'call-test-1' })
    const lines = base.instructions.split('\n')
    expect(lines.at(-1)).toBe('Respond in interleaved text and audio.')
    expect(lines.at(-1)).toBe(CALL_INSTRUCTIONS_MODE_LINE)
    expect(lines.at(-2)).toBe(
      'Always respond in Brazilian Portuguese, briefly and naturally (1–3 sentences unless asked).',
    )
    expect(base.instructions).toMatch(/Ashy/)
    expect(base.instructions).not.toMatch(/perform\s+tts/i)
    expect(base.instructions.length).toBeLessThanOrEqual(1200)
    expect(base.sessionId).toBe(h.session.id)
    expect(base.perTurnContext).toBe('')

    const turn = await h.invoke<CallContextResult>('call:buildContext', {
      callId: 'call-test-1',
      userText: 'Lembra da minha gata?',
      interruptedAfterText: 'Então, eu estava dizendo que',
    })
    expect(turn.perTurnContext.startsWith('[Contexto]')).toBe(true)
    expect(turn.perTurnContext).toContain('Hora local:')
    expect(turn.perTurnContext).toContain('Humor da Ashy:')
    expect(turn.perTurnContext).toContain('- O Carlos adora gatos e tem uma gata chamada Mia.')
    expect(turn.perTurnContext).toContain(
      '[Sua fala anterior foi interrompida após: «Então, eu estava dizendo que»]',
    )

    await expect(h.invoke('call:buildContext', { callId: 'unknown' })).rejects.toThrow(/CALL_UNKNOWN/)
  })

  it('call:buildContext with the default cortex retriever never writes the mood (sideEffects:false)', async () => {
    const h = await makeHarness()
    await h.invoke('call:start', {})
    const compileSpy = vi.spyOn(h.kernel.cortex, 'compileTurnPrompt')
    const before = h.kernel.cortex.db.getAffectiveState()
    const res = await h.invoke<CallContextResult>('call:buildContext', {
      callId: 'call-test-1',
      userText: 'hahaha adorei, que engraçado!',
    })
    expect(res.perTurnContext).toContain('[Contexto]')
    expect(compileSpy).toHaveBeenCalledWith(expect.anything(), { sideEffects: false })
    expect(h.kernel.cortex.db.getAffectiveState()).toEqual(before)
  })

  it('call:buildContext omits memories when retrieval exceeds the 150 ms budget', async () => {
    const h = await makeHarness({
      deps: {
        retrieveMemories: () =>
          new Promise((resolve) => setTimeout(() => resolve({ memories: ['memória lenta'] }), 1500)),
      },
    })
    await h.invoke('call:start', {})
    const startedAt = performance.now()
    const res = await h.invoke<CallContextResult>('call:buildContext', {
      callId: 'call-test-1',
      userText: 'oi',
    })
    expect(performance.now() - startedAt).toBeLessThan(1000)
    expect(res.perTurnContext).toContain('[Contexto]')
    expect(res.perTurnContext).not.toContain('memória lenta')
    expect(res.perTurnContext).not.toContain('Memórias relevantes')
  })

  it('call:recordTurn persists 2 voice rows, emits chat:appended and runs affect + the memory trio once', async () => {
    const h = await makeHarness()
    await h.invoke('call:start', {})
    const cortex = h.kernel.cortex
    const affectSpy = vi.spyOn(cortex, 'applyUserTurnAffect')
    const indexSpy = vi.spyOn(cortex, 'indexTurnMemory')
    const reviewSpy = vi.spyOn(cortex, 'reviewTurnMemories')
    const consolidateSpy = vi.spyOn(cortex, 'consolidateSessionMemories')

    const res = await h.invoke<{
      userMessage: { id: string; content: string; modality?: string }
      assistantMessage: { id: string; content: string; interrupted?: boolean } | null
    }>('call:recordTurn', {
      callId: 'call-test-1',
      userTranscript: 'Me conta algo legal sobre gatos',
      assistantSpokenText: 'Sabia que gatos',
      assistantFullText: 'Sabia que gatos dormem até dezesseis horas por dia?',
      interrupted: true,
      playedMs: 900,
      emotion: 'happy',
      metrics: { e2eMs: 1050 },
    })

    expect(res.userMessage).toMatchObject({ content: 'Me conta algo legal sobre gatos', modality: 'voice' })
    expect(res.assistantMessage).toMatchObject({ content: 'Sabia que gatos', interrupted: true })

    const rows = cortex.listChatMessages(h.session.id)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.modality === 'voice')).toBe(true)
    expect(JSON.parse(rows[1]!.metaJson!)).toMatchObject({
      fullText: 'Sabia que gatos dormem até dezesseis horas por dia?',
      playedMs: 900,
      backend: 'llamacpp-realtime',
    })

    expect(h.ofType('chat:appended')).toEqual([
      {
        type: 'chat:appended',
        sessionId: h.session.id,
        messageIds: [res.userMessage.id, res.assistantMessage!.id],
      },
    ])
    expect(affectSpy).toHaveBeenCalledTimes(1)
    expect(indexSpy).toHaveBeenCalledTimes(1)
    expect(indexSpy.mock.calls[0]![0]).toMatchObject({
      userText: 'Me conta algo legal sobre gatos',
      assistantText: 'Sabia que gatos',
      emotion: 'happy',
    })
    expect(reviewSpy).toHaveBeenCalledTimes(1)
    expect(consolidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: h.session.id, force: false }),
    )

    // Untranscribed turn: placeholder row, no affect/memory side effects.
    const res2 = await h.invoke<{ userMessage: { content: string } }>('call:recordTurn', {
      callId: 'call-test-1',
      userTranscript: '',
      assistantSpokenText: 'Desculpa, não entendi.',
      interrupted: false,
    })
    expect(res2.userMessage.content).toBe(VOICE_UNTRANSCRIBED_PLACEHOLDER_TEXT)
    expect(affectSpy).toHaveBeenCalledTimes(1)
    expect(indexSpy).toHaveBeenCalledTimes(1)

    // A turn recorded right after hang-up (same callId) is still persisted.
    await h.invoke('call:stop', {})
    await expect(
      h.invoke('call:recordTurn', {
        callId: 'call-test-1',
        userTranscript: 'tchau',
        assistantSpokenText: 'Tchau!',
        interrupted: false,
      }),
    ).resolves.toMatchObject({ userMessage: { content: 'tchau' } })
    await expect(
      h.invoke('call:recordTurn', {
        callId: 'never-started',
        userTranscript: 'x',
        assistantSpokenText: 'y',
        interrupted: false,
      }),
    ).rejects.toThrow(/CALL_UNKNOWN/)
  })

  it('the next text-turn history excludes untranscribed voice rows and marks interrupted replies with …', () => {
    const history = sanitizeConversationHistory(
      [
        { role: 'user', content: 'oi' },
        { role: 'assistant', content: 'Oi! Tudo bem com você', interrupted: true },
        { role: 'user', content: VOICE_UNTRANSCRIBED_PLACEHOLDER_TEXT },
        { role: 'assistant', content: 'Não ouvi direito.' },
        { role: 'user', content: 'me conta uma piada' },
        { role: 'assistant', content: 'Por que o livro de matemática ficou triste?' },
      ],
      { maxMessages: 80, maxChars: 120_000 },
    )
    expect(history).toEqual([
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: `Oi! Tudo bem com você${INTERRUPTED_REPLY_SUFFIX}` },
      { role: 'user', content: 'me conta uma piada' },
      { role: 'assistant', content: 'Por que o livro de matemática ficou triste?' },
    ])
    expect(VOICE_UNTRANSCRIBED_PLACEHOLDER_TEXT).toBe('🎤 (fala não transcrita)')
  })

  it('call:transcribe rejects < 300 ms audio without calling STT and forwards longer audio to the host STT', async () => {
    const h = await makeHarness()
    await h.invoke('call:start', {})

    const short = await h.invoke<CallTranscribeResult>('call:transcribe', {
      callId: 'call-test-1',
      audioWavBase64: wavBase64(200),
    })
    expect(short.text).toBe('')
    expect(h.transcribe).not.toHaveBeenCalled()

    const audio = wavBase64(1000)
    const res = await h.invoke<CallTranscribeResult>('call:transcribe', {
      callId: 'call-test-1',
      audioWavBase64: audio,
      language: 'pt',
    })
    expect(res).toEqual({ text: 'oi ashy, tudo bem?', providerId: 'ollama-transcriptions', latencyMs: 42 })
    expect(h.transcribe).toHaveBeenCalledWith({ audioBase64: audio, mimeType: 'audio/wav', language: 'pt' })

    await expect(
      h.invoke('call:transcribe', { callId: 'call-test-1', audioWavBase64: 'bm90LWEtd2F2' }),
    ).rejects.toThrow(/invalid WAV/)
  })

  it('call:reportViseme re-emits frames throttled to ≤ 30 Hz and only during a call', async () => {
    const h = await makeHarness()
    const frame = { A: 0.5, E: 0.1, I: 0, O: 0.2, U: 0, volume: 0.7 }
    await expect(h.invoke('call:reportViseme', frame)).resolves.toEqual({ emitted: false })

    await h.invoke('call:start', {})
    for (let i = 0; i < 10; i++) {
      await h.invoke('call:reportViseme', frame)
      h.clock.t += 3 // 10 frames within 30 ms
    }
    expect(h.ofType('call:viseme')).toHaveLength(1)
    h.clock.t += 10 // now 40 ms after the first emitted frame
    await expect(h.invoke('call:reportViseme', frame)).resolves.toEqual({ emitted: true })
    expect(h.ofType('call:viseme')).toHaveLength(2)
    expect(h.ofType('call:viseme')[0]).toEqual({ type: 'call:viseme', ...frame })

    // 1 s of 100 Hz frames → at most 30 emitted.
    for (let i = 0; i < 100; i++) {
      h.clock.t += 10
      await h.invoke('call:reportViseme', frame)
    }
    expect(h.ofType('call:viseme').length - 2).toBeLessThanOrEqual(30)

    await expect(h.invoke('call:reportViseme', { A: 'x' })).rejects.toThrow(/Invalid payload/)
  })
})
