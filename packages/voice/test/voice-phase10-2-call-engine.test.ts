import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CALL_TEST_STEPS, type CallStageSignal } from '@ashy/shared'
import {
  createCallEngine,
  createLlamaCppRealtimeSession,
  encodeWavPcm16,
  synthesizeVoicedSpeechPcm,
  uint8ArrayToBase64,
  type CallEngineOptions,
} from '../src'
import {
  createFakeHost,
  createFakeMicrophone,
  createFakePlaybackContext,
  createFakeRealtimeServer,
  flush,
  sentTypes,
  TEST_INSTRUCTIONS,
  testSettings,
  type FakeRealtimeServerOptions,
  type FakeSocket,
} from './helpers/phase10-1-fakes'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function setup(
  opts: {
    settings?: Parameters<typeof testSettings>[0]
    host?: Parameters<typeof createFakeHost>[0]
    server?: FakeRealtimeServerOptions
    engine?: Partial<CallEngineOptions>
    noPlaybackContext?: boolean
  } = {},
) {
  const settings = testSettings(opts.settings)
  const server = createFakeRealtimeServer(opts.server)
  const mic = createFakeMicrophone()
  const playback = createFakePlaybackContext()
  const fakeHost = createFakeHost(opts.host)
  const engine = createCallEngine({
    callId: 'call-1',
    settings,
    host: fakeHost.host,
    createSession: () =>
      createLlamaCppRealtimeSession({
        baseUrl: 'http://127.0.0.1:8081',
        modelId: settings.llamacpp.modelId,
        inputMode: settings.llamacpp.inputMode,
        maxOutputTokens: settings.llamacpp.maxOutputTokens,
        webSocketFactory: server.factory,
      }),
    mediaDevices: mic.mediaDevices,
    captureAudioContextFactory: mic.captureContextFactory,
    playbackAudioContext: opts.noPlaybackContext ? null : playback.ctx,
    detectorOptions: { sessionLoader: async () => null }, // DSP fallback in node
    now: () => Date.now(),
    ...(opts.engine ?? {}),
  })
  return { engine, server, mic, playback, ...fakeHost }
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

/** One full turn: speech → transcription → reply streamed on the current socket → playback to the end. */
async function runTurn(ctx: Ctx, reply: string, audioMs: number[] = [500, 500]) {
  await speakTurn(ctx)
  await flush()
  const ws = ctx.server.last
  expect(sentTypes(ws).at(-1)).toBe('response.create')
  ctx.server.streamResponse(ws, { text: [reply], audioMs })
  await flush()
  ctx.playback.advance(audioMs.reduce((a, b) => a + b, 0) / 1000 + 0.05)
  await flush()
  expect(ctx.engine.getStatus()).toBe('listening')
  return ws
}

function userItems(ws: FakeSocket): string[] {
  return ws.sent
    .filter((m) => m.type === 'conversation.item.create')
    .map((m) => (m.item as { content: Array<{ text: string }> }).content[0]!.text)
}

const statuses = (states: Array<{ status: string }>) =>
  states.map((s) => s.status).filter((s, i, arr) => i === 0 || arr[i - 1] !== s)

const DUCKED = Math.pow(10, -12 / 20)

describe('Phase 10.2 CallEngine — ducking', () => {
  it('ducks −12 dB in interrupt_pending and restores on a false interruption', async () => {
    const ctx = setup({ settings: { interrupt: { aecWarmupMs: 0, bargeInMinMs: 400 } } })
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    ctx.server.streamResponse(ctx.server.last, { text: ['Uma resposta bem longa sobre gatos.'], audioMs: [3000], done: false })
    await flush()
    expect(ctx.engine.getStatus()).toBe('speaking')
    const gain = ctx.playback.gains.at(-1)!.gain
    gain.linearRampToValueAtTime.mockClear()

    ctx.playback.advance(0.3)
    ctx.mic.speech(300) // onset, but shorter than bargeInMinMs
    await flush()
    expect(ctx.engine.getStatus()).toBe('interrupt_pending')
    expect(gain.linearRampToValueAtTime).toHaveBeenCalledTimes(1)
    expect(gain.linearRampToValueAtTime.mock.calls[0]![0]).toBeCloseTo(DUCKED, 4)

    ctx.mic.silence(900)
    await flush()
    expect(ctx.engine.getStatus()).toBe('speaking')
    expect(gain.linearRampToValueAtTime).toHaveBeenCalledTimes(2)
    expect(gain.linearRampToValueAtTime.mock.calls[1]![0]).toBe(1)
    expect(ctx.turns).toHaveLength(0)
    expect(statuses(ctx.states)).toEqual([
      'connecting',
      'listening',
      'user_speaking',
      'thinking',
      'speaking',
      'interrupt_pending',
      'speaking',
    ])
  })

  it('a confirmed barge-in fades from the ducked level (no un-duck ramp afterwards)', async () => {
    const ctx = setup({ settings: { interrupt: { aecWarmupMs: 0, bargeInMinMs: 400 } } })
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    ctx.server.streamResponse(ctx.server.last, { text: ['Gatos são ótimos parceiros.'], audioMs: [3000], done: false })
    await flush()
    const gain = ctx.playback.gains.at(-1)!.gain
    ctx.playback.advance(0.5)
    ctx.mic.speech(300)
    await flush()
    expect(ctx.engine.getStatus()).toBe('interrupt_pending')
    ctx.playback.advance(0.1) // the 80 ms duck ramp is over on the audio clock
    gain.linearRampToValueAtTime.mockClear()
    gain.setValueAtTime.mockClear()
    ctx.mic.speech(400)
    await flush()
    expect(ctx.engine.getStatus()).toBe('user_speaking')
    // Only the fade to 0, starting from the ducked level.
    expect(gain.linearRampToValueAtTime.mock.calls.map((c) => c[0])).toEqual([0])
    expect(gain.setValueAtTime.mock.calls[0]![0]).toBeCloseTo(DUCKED, 2)
    expect(ctx.turns[0]!.interrupted).toBe(true)
  })
})

describe('Phase 10.2 CallEngine — session rotation', () => {
  const cats = 'Gatos são ótimos parceiros, independentes e muito curiosos com tudo.'

  it('rotates after rotateAfterTurns: same instructions, old socket closed quietly, recap in the next turn item', async () => {
    const ctx = setup({ settings: { session: { rotateAfterTurns: 2 } } })
    await startCall(ctx)
    const ws1 = await runTurn(ctx, cats)
    expect(ctx.server.sockets).toHaveLength(1)
    await runTurn(ctx, 'Cachorros são leais e brincalhões demais.')
    await flush()
    expect(ctx.server.sockets).toHaveLength(2)
    expect(ws1.readyState).toBe(3)
    const ws2 = ctx.server.last
    expect(sentTypes(ws2)).toEqual(['session.update'])
    expect((ws2.sent[0]!.session as { instructions: string }).instructions).toBe(TEST_INSTRUCTIONS)
    // Quiet: no reconnecting / extra status while rotating.
    expect(statuses(ctx.states).filter((s) => s === 'reconnecting' || s === 'connecting')).toEqual(['connecting'])

    await speakTurn(ctx)
    await flush()
    expect(sentTypes(ws2)).toEqual(['session.update', 'conversation.item.create', 'response.create'])
    const [item] = userItems(ws2)
    expect(item!.startsWith('[Contexto] Assuntos que')).toBe(true)
    expect(item).toContain('«me fala de gatos»')
    // Ashy's own past lines never go into the recap (the 2B model copies them).
    expect(item).not.toContain(cats)
    expect(item).not.toContain('Cachorros são leais e brincalhões demais.')
    expect(item!.endsWith('[Contexto] hora local 21:00\n\nUsuário: me fala de gatos')).toBe(true)
    // The recap is sent once only.
    ctx.server.streamResponse(ws2, { text: ['Ok!'], audioMs: [300] })
    await flush()
    ctx.playback.advance(0.4)
    await flush()
    await speakTurn(ctx)
    await flush()
    expect(userItems(ws2)[1]).toBe('[Contexto] hora local 21:00\n\nUsuário: me fala de gatos')
    // The old socket never got the later turns.
    expect(userItems(ws1)).toHaveLength(2)
  })

  it('a near-repeat reply does NOT rotate the session (rotation-with-recap caused the greeting loop)', async () => {
    const ctx = setup()
    await startCall(ctx)
    await runTurn(ctx, cats)
    expect(ctx.server.sockets).toHaveLength(1)
    await runTurn(ctx, `Claro! ${cats}`) // "tudo bem?" answered with the cats answer again
    await flush()
    expect(ctx.server.sockets).toHaveLength(1) // same continuous session
    await speakTurn(ctx)
    await flush()
    expect(userItems(ctx.server.last).some((t) => t.includes('Gatos são ótimos parceiros'))).toBe(false)
  })

  it('a RUN of near-repeats (stuck model) rotates once, with a user-only recap that forbids a new greeting', async () => {
    const ctx = setup()
    await startCall(ctx)
    await runTurn(ctx, cats)
    await runTurn(ctx, `Claro! ${cats}`)
    await flush()
    expect(ctx.server.sockets).toHaveLength(1)
    await runTurn(ctx, `Pois é. ${cats}`) // second consecutive repeat → stuck
    await flush()
    expect(ctx.server.sockets).toHaveLength(2)
    await speakTurn(ctx)
    await flush()
    const [item] = userItems(ctx.server.last)
    expect(item!.startsWith('[Contexto] Assuntos que')).toBe(true)
    expect(item).toContain('não cumprimente de novo')
    expect(item).not.toContain('Gatos são ótimos parceiros')
  })

  it('rotates when the token estimate passes 70 % of contextSize', async () => {
    const ctx = setup({ engine: { contextSize: 300 } })
    await startCall(ctx)
    await runTurn(ctx, 'Curto.')
    expect(ctx.server.sockets).toHaveLength(1)
    const long = Array.from({ length: 16 }, (_, i) => `Frase número ${i} sobre um assunto diferente.`).join(' ')
    await runTurn(ctx, long, [1000, 1000, 1000])
    await flush()
    expect(ctx.server.sockets).toHaveLength(2)
    await speakTurn(ctx)
    await flush()
    expect(userItems(ctx.server.last)[0]!.startsWith('[Contexto] Assuntos que')).toBe(true)
  })

  it('a due rotation after a barge-in completes before the next turn is submitted', async () => {
    const ctx = setup({ settings: { session: { rotateAfterTurns: 2 }, interrupt: { aecWarmupMs: 0, bargeInMinMs: 400 } } })
    await startCall(ctx)
    await runTurn(ctx, 'Primeira resposta.')
    await speakTurn(ctx)
    await flush()
    const ws1 = ctx.server.last
    ctx.server.streamResponse(ws1, { text: ['Segunda resposta comprida demais.'], audioMs: [2000], done: false })
    await flush()
    ctx.playback.advance(0.5)
    ctx.mic.speech(700) // barge-in → turn 2 finalized, rotation due
    await flush()
    expect(ctx.engine.getStatus()).toBe('user_speaking')
    ws1.deliver({ type: 'response.done', response: { status: 'cancelled' } })
    ctx.mic.silence(900)
    await flush()
    expect(ctx.server.sockets).toHaveLength(2)
    const ws2 = ctx.server.last
    expect(sentTypes(ws2)).toEqual(['session.update', 'conversation.item.create', 'response.create'])
    expect(userItems(ws2)[0]!).toContain('[Contexto] Assuntos que')
    expect(userItems(ws1)).toHaveLength(2)
  })
})

describe('Phase 10.2 CallEngine — emotion layers', () => {
  it('parses the ACT marker (removed from caption and ledger) and classifies the other sentences', async () => {
    const ctx = setup({ host: { classifyAffect: () => ({ emotion: 'curious', intensity: 0.4 }) } })
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    ctx.server.streamResponse(ctx.server.last, {
      text: ['<|ACT {"emotion":"happy","intensity":0.8,"motion":"nod"}|>Oi! ', 'Gatos são ótimos.'],
      audioMs: [500, 500],
    })
    await flush()
    expect(ctx.states.every((s) => !s.caption?.text.includes('<|'))).toBe(true)
    await vi.advanceTimersByTimeAsync(40)
    expect(ctx.stages[0]).toMatchObject({ callId: 'call-1', emotion: 'happy', intensity: 0.8, motion: 'nod' })
    expect(ctx.affects.map((a) => a.text)).toEqual(['Gatos são ótimos.'])
    ctx.playback.advance(1.1)
    await flush()
    expect(ctx.turns[0]!.assistantFullText).toBe('Oi! Gatos são ótimos.')
    expect(ctx.turns[0]!.assistantSpokenText).toBe('Oi! Gatos são ótimos.')
  })

  it('reports each sentence stage when its audio starts playing on the player clock', async () => {
    const byText: Record<string, CallStageSignal> = {
      'Primeira frase aqui.': { emotion: 'happy', intensity: 0.5 },
      'Segunda frase aqui.': { emotion: 'sad', intensity: 0.7, motion: 'look_down' },
    }
    const ctx = setup({ host: { classifyAffect: (t) => byText[t] ?? null } })
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    ctx.server.streamResponse(ctx.server.last, {
      text: ['Primeira frase aqui. ', 'Segunda frase aqui.'],
      audioMs: [1000, 1000],
    })
    await flush()
    await vi.advanceTimersByTimeAsync(40)
    expect(ctx.stages.map((s) => s.emotion)).toEqual(['happy'])
    // Sentence 2 starts at char 21 of 40 → 1050 ms of 2000 ms.
    ctx.playback.advance(0.95)
    await vi.advanceTimersByTimeAsync(40)
    expect(ctx.stages.map((s) => s.emotion)).toEqual(['happy'])
    ctx.playback.advance(0.15)
    await vi.advanceTimersByTimeAsync(40)
    expect(ctx.stages.map((s) => s.emotion)).toEqual(['happy', 'sad'])
    expect(ctx.stages[1]).toMatchObject({ intensity: 0.7, motion: 'look_down' })
  })

  it('cancels pending stage signals on barge-in', async () => {
    const ctx = setup({
      settings: { interrupt: { aecWarmupMs: 0, bargeInMinMs: 400 } },
      host: { classifyAffect: (t) => (t.startsWith('Primeira') ? { emotion: 'happy', intensity: 0.5 } : { emotion: 'sad', intensity: 0.5 }) },
    })
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    ctx.server.streamResponse(ctx.server.last, {
      text: ['Primeira frase aqui. ', 'Segunda frase aqui. '],
      audioMs: [500, 500, 500, 500],
      done: false,
    })
    await flush()
    await vi.advanceTimersByTimeAsync(40)
    expect(ctx.stages.map((s) => s.emotion)).toEqual(['happy'])
    ctx.playback.advance(0.5)
    ctx.mic.speech(700)
    await flush()
    expect(ctx.engine.getStatus()).toBe('user_speaking')
    ctx.playback.advance(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(ctx.stages.map((s) => s.emotion)).toEqual(['happy'])
  })
})

describe('Phase 10.2 CallEngine — test mode', () => {
  function testWav(): string {
    const speech = synthesizeVoicedSpeechPcm({ durationMs: 900, sampleRate: 16000, amplitude: 0.5 })
    const samples = new Float32Array(3200 + speech.length)
    samples.set(speech, 3200) // 200 ms lead-in silence
    return uint8ArrayToBase64(encodeWavPcm16(samples, 16000))
  }

  function setupTest(opts: { reply?: string | null; transcript?: string } = {}) {
    const reply = opts.reply === undefined ? 'Oi! Gatos dormem até dezesseis horas por dia.' : opts.reply
    const holder: { server: ReturnType<typeof createFakeRealtimeServer> | null } = { server: null }
    const ctx = setup({
      // The scripted server answers ~120 ms after response.create (null = never answers).
      server: {
        onClientMessage: (socket, msg) => {
          if (reply !== null && msg.type === 'response.create') {
            setTimeout(() => holder.server?.streamResponse(socket, { text: [reply], audioMs: [500] }), 120)
          }
        },
      },
      host: opts.transcript !== undefined ? { transcript: opts.transcript } : {},
      noPlaybackContext: true,
      engine: { testInput: { wavBase64: testWav(), expectedText: 'me fala de gatos' } },
    })
    holder.server = ctx.server
    return ctx
  }

  async function runFor(ms: number) {
    for (let t = 0; t < ms; t += 100) {
      await vi.advanceTimersByTimeAsync(100)
    }
    await flush()
  }

  it('feeds the WAV instead of the mic, runs one turn, reports every step and never records the turn', async () => {
    const ctx = setupTest()
    expect(await startCall(ctx)).toBe('listening')
    expect(ctx.mic.mediaDevices.getUserMedia).not.toHaveBeenCalled()
    await runFor(6000)
    expect(ctx.testResults).toHaveLength(1)
    const r = ctx.testResults[0]!
    expect(r.callId).toBe('call-1')
    expect(r.steps.map((s) => s.step)).toEqual([...CALL_TEST_STEPS])
    expect(r.steps.filter((s) => !s.ok)).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.transcript).toBe('me fala de gatos')
    expect(r.steps.find((s) => s.step === 'transcription')!.detail).toBe('similarity 1.00 with the expected text')
    expect(r.reply).toBe('Oi! Gatos dormem até dezesseis horas por dia.')
    expect(r.steps.find((s) => s.step === 'first_audio')!.ms).toBeGreaterThanOrEqual(120)
    expect(r.steps.find((s) => s.step === 'playback')!.ms).toBeCloseTo(500, -1)
    expect(r.steps.find((s) => s.step === 'vad')!.ms).toBeGreaterThan(1100)
    expect(r.metrics?.ttfbMs).toBeGreaterThanOrEqual(120)
    // The WAV went through the same capture → detector → transcribe path.
    expect(ctx.transcribes).toHaveLength(1)
    expect(ctx.host.recordTurn).not.toHaveBeenCalled()
    expect(ctx.engine.getStatus()).toBe('idle')
    expect(ctx.states.slice(-2).map((s) => s.status)).toEqual(['ended', 'idle'])
    expect(ctx.states.at(-2)!.reason).toBe('user_hangup')
  })

  it('reports a failed transcription right away (no waiting for the timeout)', async () => {
    const ctx = setupTest({ transcript: '' })
    await startCall(ctx)
    await runFor(4000)
    expect(ctx.testResults).toHaveLength(1)
    const r = ctx.testResults[0]!
    expect(r.ok).toBe(false)
    const byStep = Object.fromEntries(r.steps.map((s) => [s.step, s]))
    expect(byStep.engine!.ok && byStep.session!.ok && byStep.vad!.ok).toBe(true)
    expect(byStep.transcription).toMatchObject({ ok: false, detail: 'empty transcription' })
    expect(byStep.first_audio!.ok).toBe(false)
    expect(byStep.playback!.ok).toBe(false)
    expect(ctx.host.recordTurn).not.toHaveBeenCalled()
    expect(ctx.engine.getStatus()).toBe('idle')
  })

  it('times out after 45 s with the missing steps failed', async () => {
    const ctx = setupTest({ reply: null })
    await startCall(ctx)
    await runFor(44000)
    expect(ctx.testResults).toHaveLength(0)
    await runFor(1500)
    expect(ctx.testResults).toHaveLength(1)
    const r = ctx.testResults[0]!
    expect(r.ok).toBe(false)
    const byStep = Object.fromEntries(r.steps.map((s) => [s.step, s]))
    expect(byStep.transcription!.ok).toBe(true)
    expect(byStep.first_audio).toMatchObject({ ok: false })
    expect(byStep.first_audio!.detail).toContain('timeout after 45 s')
    expect(ctx.engine.getStatus()).toBe('idle')
  })

  it('reports the engine/session failure when the backend is unreachable', async () => {
    const fakeHost = createFakeHost()
    const engine = createCallEngine({
      callId: 'call-x',
      settings: testSettings(),
      host: fakeHost.host,
      createSession: () =>
        createLlamaCppRealtimeSession({
          baseUrl: 'http://127.0.0.1:1',
          webSocketFactory: () => {
            throw new Error('ECONNREFUSED')
          },
        }),
      playbackAudioContext: null,
      detectorOptions: { sessionLoader: async () => null },
      now: () => Date.now(),
      testInput: { wavBase64: testWav(), expectedText: 'oi' },
    })
    const p = engine.start()
    await flush()
    expect(await p).toBe('ended')
    expect(fakeHost.testResults).toHaveLength(1)
    const r = fakeHost.testResults[0]!
    expect(r.ok).toBe(false)
    expect(r.steps[0]).toMatchObject({ step: 'engine', ok: false })
    expect(r.steps[1]).toMatchObject({ step: 'session', ok: false, detail: 'ECONNREFUSED' })
  })
})
