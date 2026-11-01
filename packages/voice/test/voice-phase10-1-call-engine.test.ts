import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCallEngine, createLlamaCppRealtimeSession, decodeWavToPcmBlocks, base64ToUint8Array } from '../src'
import {
  createFakeHost,
  createFakeMicrophone,
  createFakePlaybackContext,
  createFakeRealtimeServer,
  flush,
  sentTypes,
  TEST_INSTRUCTIONS,
  testSettings,
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
  } = {},
) {
  const settings = testSettings(opts.settings)
  const server = createFakeRealtimeServer()
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
    playbackAudioContext: playback.ctx,
    detectorOptions: { sessionLoader: async () => null }, // no ONNX in node → DSP fallback
    now: () => Date.now(),
  })
  return { engine, server, mic, playback, ...fakeHost }
}

async function startCall(ctx: ReturnType<typeof setup>) {
  const p = ctx.engine.start()
  await flush()
  return p
}

/** Speak a turn and wait until the realtime request is on the wire. */
async function speakTurn(ctx: ReturnType<typeof setup>, speechMs = 600, silenceMs = 900) {
  ctx.mic.speech(speechMs)
  await flush()
  ctx.mic.silence(silenceMs)
  await flush()
}

const statuses = (states: Array<{ status: string }>) =>
  states.map((s) => s.status).filter((s, i, arr) => i === 0 || arr[i - 1] !== s)

describe('Phase 10.1 CallEngine (spec §6)', () => {
  it('runs a full transcribed turn: handshake first, context → text → response.create, playback, recordTurn, metrics', async () => {
    const ctx = setup({ host: { asrDelayMs: 280 } })
    expect(await startCall(ctx)).toBe('listening')
    expect(ctx.engine.getSnapshot().vadMode).toBe('hybrid-dsp')
    const ws = ctx.server.last
    expect(ws.url).toBe('ws://127.0.0.1:8081/v1/realtime?model=lfm3-omni-2b-q4km')
    expect(sentTypes(ws)).toEqual(['session.update'])
    expect((ws.sent[0]!.session as { instructions: string }).instructions).toBe(TEST_INSTRUCTIONS)
    expect(ctx.contexts[0]).toEqual({ callId: 'call-1' })

    await speakTurn(ctx)
    expect(ctx.engine.getStatus()).toBe('thinking')
    expect(ctx.transcribes).toHaveLength(1)
    // The turn WAV includes the pre-roll + the speech.
    const wav = decodeWavToPcmBlocks(base64ToUint8Array(ctx.transcribes[0]!.audioWavBase64))
    expect(wav.sampleRate).toBe(16000)
    expect(wav.totalDurationMs).toBeGreaterThanOrEqual(600)

    await vi.advanceTimersByTimeAsync(300) // ASR finishes
    await flush()
    expect(ctx.contexts[1]).toEqual({ callId: 'call-1', userText: 'me fala de gatos' })
    expect(sentTypes(ws)).toEqual(['session.update', 'conversation.item.create', 'response.create'])
    // Context + labelled user speech travel in ONE input_text item (LFM3 role-confusion fix).
    expect((ws.sent[1]!.item as { content: Array<{ text: string }> }).content[0]!.text).toBe(
      '[Contexto] hora local 21:00\n\nUsuário: me fala de gatos',
    )

    await vi.advanceTimersByTimeAsync(115) // first audio ~115 ms after response.create
    ctx.server.streamResponse(ws, {
      text: ['Oi, tudo bem? ', 'Gatos são ótimos parceiros.'],
      audioMs: [500, 500],
    })
    await flush()
    expect(ctx.engine.getStatus()).toBe('speaking')
    expect(ctx.playback.sources.length).toBe(2)

    // Visemes come from the PCM being played, ≤ 30 Hz.
    ctx.playback.advance(0.2)
    const before = ctx.visemes.length
    await vi.advanceTimersByTimeAsync(330)
    const sent = ctx.visemes.slice(before)
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.length).toBeLessThanOrEqual(11)
    expect(sent.some((f) => f.volume > 0)).toBe(true)

    ctx.playback.advance(1)
    await flush()
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(ctx.turns).toHaveLength(1)
    expect(ctx.turns[0]).toMatchObject({
      callId: 'call-1',
      userTranscript: 'me fala de gatos',
      assistantSpokenText: 'Oi, tudo bem? Gatos são ótimos parceiros.',
      assistantFullText: 'Oi, tudo bem? Gatos são ótimos parceiros.',
      interrupted: false,
    })
    expect(ctx.turns[0]!.playedMs).toBeCloseTo(1000, -1)
    const m = ctx.turns[0]!.metrics!
    expect(m.endpointMs).toBeGreaterThanOrEqual(700)
    expect(m.asrMs).toBeGreaterThanOrEqual(280)
    expect(m.ttfbMs).toBeGreaterThanOrEqual(115)
    expect(m.playbackStartMs).toBe(0)
    expect(m.e2eMs).toBeGreaterThanOrEqual((m.endpointMs ?? 0) + (m.asrMs ?? 0) + (m.ttfbMs ?? 0))
    // Metrics also reach call:state.
    expect(ctx.states.some((s) => s.metrics?.e2eMs !== undefined)).toBe(true)
    expect(ctx.visemes.at(-1)).toEqual({ A: 0, E: 0, I: 0, O: 0, U: 0, volume: 0 })

    expect(statuses(ctx.states)).toEqual(['connecting', 'listening', 'user_speaking', 'thinking', 'speaking', 'listening'])
    expect(ctx.states.every((s) => s.callId === 'call-1')).toBe(true)
  })

  it('barge-in: cancels, fades, records only the played part (interrupted) and passes it to the next buildContext', async () => {
    const ctx = setup({ settings: { interrupt: { aecWarmupMs: 0, bargeInMinMs: 400 } } })
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    const ws = ctx.server.last
    const fullText = 'Gatos são ótimos parceiros, independentes e curiosos demais.'
    ctx.server.streamResponse(ws, { text: [fullText], audioMs: [500, 500, 500, 500], done: false })
    await flush()
    expect(ctx.engine.getStatus()).toBe('speaking')

    ctx.playback.advance(0.5) // 500 of 2000 ms heard
    ctx.mic.speech(700)
    await flush()
    expect(sentTypes(ws)).toContain('response.cancel')
    expect(ctx.engine.getStatus()).toBe('user_speaking')
    expect(ctx.turns).toHaveLength(1)
    expect(ctx.turns[0]).toMatchObject({
      interrupted: true,
      assistantSpokenText: 'Gatos são',
      assistantFullText: fullText,
    })
    expect(ctx.turns[0]!.playedMs).toBeGreaterThanOrEqual(480)
    expect(ctx.turns[0]!.playedMs).toBeLessThanOrEqual(520)
    expect(ctx.playback.sources.filter((s) => s.stopped).length).toBe(4)

    // Late audio of the cancelled response never reaches the player.
    const sourcesBefore = ctx.playback.sources.length
    ws.deliver({ type: 'response.output_audio.delta', delta: 'AAAA' })
    expect(ctx.playback.sources.length).toBe(sourcesBefore)

    ws.deliver({ type: 'response.done', response: { status: 'cancelled' } })
    ctx.mic.silence(900)
    await flush()
    expect(ctx.contexts.at(-1)).toEqual({
      callId: 'call-1',
      userText: 'me fala de gatos',
      interruptedAfterText: 'Gatos são',
    })
    expect(sentTypes(ws).at(-1)).toBe('response.create')
    expect(statuses(ctx.states)).toEqual([
      'connecting',
      'listening',
      'user_speaking',
      'thinking',
      'speaking',
      'interrupt_pending',
      'user_speaking',
      'thinking',
    ])
  })

  it('AEC warm-up doubles the barge-in requirement at the start of a reply', async () => {
    const ctx = setup({ settings: { interrupt: { aecWarmupMs: 5000, bargeInMinMs: 400 } } })
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    ctx.server.streamResponse(ctx.server.last, { text: ['Uma resposta bem longa.'], audioMs: [3000], done: false })
    await flush()
    ctx.mic.speech(600) // ≥ 400 but < 800
    await flush()
    expect(ctx.engine.getStatus()).toBe('interrupt_pending')
    expect(ctx.turns).toHaveLength(0)
    ctx.mic.speech(300) // now ≥ 800
    await flush()
    expect(ctx.engine.getStatus()).toBe('user_speaking')
    expect(ctx.turns[0]!.interrupted).toBe(true)
  })

  it('user resuming while thinking cancels the response and saves nothing', async () => {
    const ctx = setup()
    await startCall(ctx)
    await speakTurn(ctx)
    await flush()
    expect(ctx.engine.getStatus()).toBe('thinking')
    ctx.mic.speech(500)
    await flush()
    expect(ctx.engine.getStatus()).toBe('user_speaking')
    expect(sentTypes(ctx.server.last)).toContain('response.cancel')
    expect(ctx.turns).toHaveLength(0)
  })

  it('mute keeps capture running but ignores the detector', async () => {
    const ctx = setup()
    await startCall(ctx)
    ctx.engine.setMuted(true)
    await speakTurn(ctx)
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(ctx.transcribes).toHaveLength(0)
    expect(ctx.mic.tracks[0]!.stop).not.toHaveBeenCalled()
    ctx.engine.setMuted(false)
    await speakTurn(ctx)
    expect(ctx.transcribes).toHaveLength(1)
  })

  it('stop() closes the WS, stops capture and player, reports ended then idle', async () => {
    const ctx = setup()
    await startCall(ctx)
    await ctx.engine.stop()
    await flush()
    expect(ctx.server.last.readyState).toBe(3)
    expect(ctx.mic.tracks[0]!.stop).toHaveBeenCalled()
    const last = ctx.states.slice(-2)
    expect(last.map((s) => s.status)).toEqual(['ended', 'idle'])
    expect(last[0]!.reason).toBe('user_hangup')
    expect(ctx.engine.getStatus()).toBe('idle')
  })

  it('ends with mic_denied when getUserMedia is refused, backend_unavailable when the handshake fails', async () => {
    const ctx = setup()
    ctx.mic.mediaDevices.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }))
    expect(await startCall(ctx)).toBe('ended')
    expect(ctx.states.find((s) => s.status === 'ended')!.reason).toBe('mic_denied')

    const ctx2 = setup()
    const engine = createCallEngine({
      callId: 'call-2',
      settings: testSettings(),
      host: ctx2.host,
      createSession: () =>
        createLlamaCppRealtimeSession({
          baseUrl: 'http://127.0.0.1:1',
          webSocketFactory: () => {
            throw new Error('ECONNREFUSED')
          },
        }),
      mediaDevices: ctx2.mic.mediaDevices,
      captureAudioContextFactory: ctx2.mic.captureContextFactory,
      playbackAudioContext: null,
      detectorOptions: { sessionLoader: async () => null },
      now: () => Date.now(),
    })
    const p = engine.start()
    await flush()
    expect(await p).toBe('ended')
    expect(ctx2.states.find((s) => s.status === 'ended')!.reason).toBe('backend_unavailable')
  })

  it('reconnects after the server drops the socket', async () => {
    const ctx = setup()
    await startCall(ctx)
    ctx.server.last.serverClose(1006)
    await flush()
    expect(ctx.engine.getStatus()).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(600)
    await flush()
    expect(ctx.server.sockets).toHaveLength(2)
    expect(ctx.engine.getStatus()).toBe('listening')
    expect((ctx.server.last.sent[0]!.session as { instructions: string }).instructions).toBe(TEST_INSTRUCTIONS)
  })
})
