import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallCascadeEvent, CallSynthesizeResult } from '@ashy/shared'
import {
  createCallEngine,
  createCascadeSession,
  type CascadeHostEvent,
  type CascadeSessionOptions,
  type CascadeTurnRequest,
  type VoiceSessionEventMap,
} from '../src'
import {
  createFakeHost,
  createFakeMicrophone,
  createFakePlaybackContext,
  flush,
  pcmBase64,
  testSettings,
} from './helpers/phase10-1-fakes'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(err: unknown): void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function ttsResult(ms = 300): CallSynthesizeResult {
  return { pcmBase64: pcmBase64(ms, 24000), sampleRate: 24000, durationMs: ms, latencyMs: 5 }
}

/** Fake host side: records turns/aborts, lets the test push `call:cascade` events. */
function fakeCascadeHost(opts: { manualTts?: boolean } = {}) {
  const turns: CascadeTurnRequest[] = []
  const aborts: string[] = []
  const tts: Array<{ text: string; d: Deferred<CallSynthesizeResult> }> = []
  let listener: ((e: CascadeHostEvent) => void) | null = null
  const options: CascadeSessionOptions = {
    startTurn: vi.fn(async (req: CascadeTurnRequest) => {
      turns.push(req)
      return { accepted: true }
    }),
    abortTurn: vi.fn((turnId: string) => {
      aborts.push(turnId)
    }),
    synthesize: vi.fn((text: string) => {
      if (!opts.manualTts) return Promise.resolve(ttsResult())
      const d = deferred<CallSynthesizeResult>()
      tts.push({ text, d })
      return d.promise
    }),
    subscribe: (cb) => {
      listener = cb
      return () => {
        listener = null
      }
    },
  }
  return {
    options,
    turns,
    aborts,
    tts,
    get subscribed() {
      return listener !== null
    },
    push(turnId: string, event: CallCascadeEvent) {
      listener?.({ turnId, ...event } as CascadeHostEvent)
    },
    delta(turnId: string, text: string) {
      listener?.({ turnId, kind: 'delta', delta: text })
    },
    done(turnId: string, text = '') {
      listener?.({ turnId, kind: 'done', text, providerId: 'ollama', modelId: 'm', latencyMs: 10 })
    },
  }
}

function recordEvents(session: ReturnType<typeof createCascadeSession>) {
  const events: Array<{ type: keyof VoiceSessionEventMap; payload: unknown }> = []
  for (const type of ['response_started', 'response_text', 'response_audio', 'response_done', 'error'] as const) {
    session.on(type, (payload) => events.push({ type, payload }))
  }
  return events
}

describe('Phase 10.5 — CascadeSession', () => {
  it('connects by subscribing (and running prepare), with cascade caps', async () => {
    const host = fakeCascadeHost()
    const prepare = vi.fn(async () => {})
    const s = createCascadeSession({ ...host.options, prepare })
    await s.connect({ instructions: 'x' })
    expect(host.subscribed).toBe(true)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(s.caps.toolCalls).toBe(false)
    expect(s.caps.managesContext).toBe(true)
    expect(s.caps.serverTurnDetection).toBe(false)
    await s.close()
    expect(host.subscribed).toBe(false)
  })

  it('a failing prepare fails connect (e.g. TTS engine unavailable)', async () => {
    const host = fakeCascadeHost()
    const s = createCascadeSession({ ...host.options, prepare: async () => Promise.reject(new Error('TTS_UNAVAILABLE')) })
    await expect(s.connect({ instructions: '' })).rejects.toThrow('TTS_UNAVAILABLE')
  })

  it('forwards the transcribed turn (text, context, tool policy) and never starts the response synchronously', async () => {
    const host = fakeCascadeHost()
    const s = createCascadeSession({ ...host.options, turnIdPrefix: 'c1' })
    const events = recordEvents(s)
    await s.connect({ instructions: '' })
    s.submitTranscribedTurn({ text: 'anota isso', context: '[Contexto] hora 21:00', toolChoice: 'auto' })
    expect(events).toHaveLength(0)
    await flush()
    expect(host.turns).toEqual([{ turnId: 'c1-1', text: 'anota isso', context: '[Contexto] hora 21:00', toolChoice: 'auto' }])
    // A voice approval turn never carries the tool policy.
    s.submitTranscribedTurn({ text: 'pode', context: '', toolChoice: 'auto', approvalHandled: true })
    await flush()
    expect(host.turns[1]).toEqual({ turnId: 'c1-2', text: 'pode' })
    // The new turn aborted the previous host turn.
    expect(host.aborts).toEqual(['c1-1'])
  })

  it('respond(contextText) starts a proactive turn without user text', async () => {
    const host = fakeCascadeHost()
    const s = createCascadeSession({ ...host.options, turnIdPrefix: 'c' })
    await s.connect({ instructions: '' })
    s.respond({ contextText: '[Contexto] Ação aprovada: salvar a nota.' })
    await flush()
    expect(host.turns).toEqual([{ turnId: 'c-1', text: '', context: '[Contexto] Ação aprovada: salvar a nota.' }])
  })

  it('synthesizes phrases in parallel (bounded) and emits audio + spoken text strictly in phrase order', async () => {
    const host = fakeCascadeHost({ manualTts: true })
    const s = createCascadeSession({ ...host.options, turnIdPrefix: 'c', maxParallelTts: 2 })
    const events = recordEvents(s)
    await s.connect({ instructions: '' })
    s.submitTranscribedTurn({ text: 'oi', context: '' })
    await flush()
    host.delta('c-1', 'Oi Carlos, tudo bem com você hoje? ')
    host.delta('c-1', 'Eu estava pensando em astronomia agora. ')
    host.delta('c-1', 'Júpiter tem dezenas de luas conhecidas.')
    host.done('c-1')
    await flush()
    expect(events[0]!.type).toBe('response_started')
    expect(host.tts.length).toBe(2) // bounded parallelism
    // Second phrase finishes first: nothing is emitted until the first one is ready.
    host.tts[1]!.d.resolve(ttsResult(200))
    await flush()
    expect(events.filter((e) => e.type === 'response_audio')).toHaveLength(0)
    host.tts[0]!.d.resolve(ttsResult(300))
    await flush()
    const audio = events.filter((e) => e.type === 'response_audio')
    expect(audio).toHaveLength(2)
    expect((audio[0]!.payload as { pcm: Int16Array }).pcm.length).toBe(Math.round(0.3 * 24000))
    expect(host.tts.length).toBe(3)
    // Spoken text only covers phrases already handed to playback.
    const texts = events.filter((e) => e.type === 'response_text').map((e) => (e.payload as { text: string }).text)
    expect(texts.at(-1)).toBe(`${host.tts[0]!.text} ${host.tts[1]!.text}`)
    expect(events.some((e) => e.type === 'response_done')).toBe(false)
    host.tts[2]!.d.resolve(ttsResult(300))
    await flush()
    const done = events.find((e) => e.type === 'response_done')!.payload as VoiceSessionEventMap['response_done']
    expect(done.cancelled).toBe(false)
    expect(done.text).toBe(host.tts.map((t) => t.text).join(' '))
    expect(Math.round(done.audioMs)).toBe(800)
  })

  it('cancelResponse aborts the host turn and drops late deltas and late TTS', async () => {
    const host = fakeCascadeHost({ manualTts: true })
    const s = createCascadeSession({ ...host.options, turnIdPrefix: 'c' })
    const events = recordEvents(s)
    await s.connect({ instructions: '' })
    s.submitTranscribedTurn({ text: 'conta uma história', context: '' })
    await flush()
    host.delta('c-1', 'Era uma vez um gato muito curioso, que morava na lua. Ele gostava de queijo. ')
    await flush()
    const queued = host.tts.length
    expect(queued).toBeGreaterThan(0)
    s.cancelResponse('client')
    expect(host.aborts).toEqual(['c-1'])
    const done = events.find((e) => e.type === 'response_done')!.payload as VoiceSessionEventMap['response_done']
    expect(done).toMatchObject({ cancelled: true, cancelReason: 'client', text: '' })
    host.tts[0]!.d.resolve(ttsResult())
    host.delta('c-1', 'E ele voou. ')
    host.done('c-1')
    await flush()
    expect(events.filter((e) => e.type === 'response_audio')).toHaveLength(0)
    expect(host.tts.length).toBe(queued)
    expect(s.activeTurnId).toBeNull()
  })

  it('a phrase whose TTS failed is skipped and never counted as spoken', async () => {
    const host = fakeCascadeHost({ manualTts: true })
    const s = createCascadeSession({ ...host.options, turnIdPrefix: 'c', maxParallelTts: 3 })
    const events = recordEvents(s)
    await s.connect({ instructions: '' })
    s.submitTranscribedTurn({ text: 'oi', context: '' })
    await flush()
    host.delta('c-1', 'Primeira frase bem curtinha aqui agora. Segunda frase que vai falhar no tts. Terceira frase final.')
    host.done('c-1')
    await flush()
    expect(host.tts.length).toBe(3)
    host.tts[0]!.d.resolve(ttsResult())
    host.tts[1]!.d.reject(new Error('TTS_TIMEOUT'))
    host.tts[2]!.d.resolve(ttsResult())
    await flush()
    const done = events.find((e) => e.type === 'response_done')!.payload as VoiceSessionEventMap['response_done']
    expect(done.text).toBe(`${host.tts[0]!.text} ${host.tts[2]!.text}`)
    expect(events.some((e) => e.type === 'error' && (e.payload as { code?: string }).code === 'tts_failed')).toBe(true)
  })

  it('re-attaches ACT markers to the phrase that follows them', async () => {
    const host = fakeCascadeHost()
    const s = createCascadeSession({ ...host.options, turnIdPrefix: 'c' })
    const events = recordEvents(s)
    await s.connect({ instructions: '' })
    s.submitTranscribedTurn({ text: 'oi', context: '' })
    await flush()
    host.delta('c-1', '<|ACT {"emotion":"happy","intensity":0.7}|>')
    host.delta('c-1', 'Que bom te ouvir de novo, Carlos!')
    host.done('c-1')
    await flush()
    const done = events.find((e) => e.type === 'response_done')!.payload as VoiceSessionEventMap['response_done']
    expect(done.text).toBe('<|ACT {"emotion":"happy","intensity":0.7}|>Que bom te ouvir de novo, Carlos!')
    // The marker itself is never sent to the TTS.
    const sent = (host.options.synthesize as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    expect(sent.join(' ')).toBe('Que bom te ouvir de novo, Carlos!')
    expect(sent.some((t) => t.includes('<|'))).toBe(false)
  })

  it('a host error speaks what already arrived; with nothing, the response ends empty', async () => {
    const host = fakeCascadeHost()
    const s = createCascadeSession({ ...host.options, turnIdPrefix: 'c' })
    const events = recordEvents(s)
    await s.connect({ instructions: '' })
    s.submitTranscribedTurn({ text: 'oi', context: '' })
    await flush()
    host.delta('c-1', 'Tudo certo por aqui')
    host.push('c-1', { kind: 'error', message: 'LLM_REQUEST_FAILED' })
    await flush()
    let done = events.find((e) => e.type === 'response_done')!.payload as VoiceSessionEventMap['response_done']
    expect(done).toMatchObject({ cancelled: false, text: 'Tudo certo por aqui' })

    events.length = 0
    s.submitTranscribedTurn({ text: 'e aí', context: '' })
    await flush()
    host.push('c-2', { kind: 'error', message: 'PROVIDER_NOT_CONFIGURED' })
    await flush()
    done = events.find((e) => e.type === 'response_done')!.payload as VoiceSessionEventMap['response_done']
    expect(done).toMatchObject({ cancelled: false, text: '', audioMs: 0 })
  })

  it('startTurn rejection and a silent host both end the turn (timeout aborts the host turn)', async () => {
    const host = fakeCascadeHost()
    host.options.startTurn = vi.fn(async () => Promise.reject(new Error('CALL_NOT_ACTIVE')))
    const s = createCascadeSession({ ...host.options, turnIdPrefix: 'c', turnTimeoutMs: 5000 })
    const events = recordEvents(s)
    await s.connect({ instructions: '' })
    s.submitTranscribedTurn({ text: 'oi', context: '' })
    await flush()
    expect(events.map((e) => e.type)).toEqual(['error', 'response_started', 'response_done'])

    host.options.startTurn = vi.fn(async () => ({ accepted: true }))
    const s2 = createCascadeSession({ ...host.options, turnIdPrefix: 'd', turnTimeoutMs: 5000 })
    const ev2 = recordEvents(s2)
    await s2.connect({ instructions: '' })
    s2.submitTranscribedTurn({ text: 'oi', context: '' })
    await flush()
    await vi.advanceTimersByTimeAsync(5100)
    expect(host.aborts).toContain('d-1')
    expect(ev2.some((e) => e.type === 'response_done')).toBe(true)
  })

  it('ignores events of other turns and of a host-aborted turn after the fact', async () => {
    const host = fakeCascadeHost()
    const s = createCascadeSession({ ...host.options, turnIdPrefix: 'c' })
    const events = recordEvents(s)
    await s.connect({ instructions: '' })
    s.submitTranscribedTurn({ text: 'oi', context: '' })
    await flush()
    host.delta('other-1', 'não é meu')
    await flush()
    expect(events).toHaveLength(0)
    host.push('c-1', { kind: 'aborted' })
    await flush()
    const done = events.find((e) => e.type === 'response_done')!.payload as VoiceSessionEventMap['response_done']
    expect(done).toMatchObject({ cancelled: true, cancelReason: 'server' })
  })
})

// ───────────────────────────── with the real CallEngine ─────────────────────────────

function setupEngine(opts: { manualTts?: boolean } = {}) {
  const settings = testSettings({ interrupt: { aecWarmupMs: 0, bargeInMinMs: 400 } })
  const mic = createFakeMicrophone()
  const playback = createFakePlaybackContext()
  const fake = createFakeHost({ transcript: 'me conta sobre júpiter', perTurnContext: '[Contexto] hora local 21:00' })
  const cascade = fakeCascadeHost(opts)
  const synth = cascade.options.synthesize
  fake.host.synthesize = vi.fn((input: { text: string }) => synth(input.text))
  const engine = createCallEngine({
    callId: 'call-1',
    settings,
    host: fake.host,
    createSession: () =>
      createCascadeSession({
        ...cascade.options,
        turnIdPrefix: 'c',
        synthesize: (text) => fake.host.synthesize({ callId: 'call-1', text }),
      }),
    mediaDevices: mic.mediaDevices,
    captureAudioContextFactory: mic.captureContextFactory,
    playbackAudioContext: playback.ctx,
    detectorOptions: { sessionLoader: async () => null },
    now: () => Date.now(),
  })
  return { engine, mic, playback, cascade, ...fake }
}

describe('Phase 10.5 — CallEngine over CascadeSession', () => {
  it('transcribed turn → host LLM turn (raw text + context) → ordered TTS → ONE recordTurn with the spoken text', async () => {
    const ctx = setupEngine()
    const p = ctx.engine.start()
    await flush()
    expect(await p).toBe('listening')
    ctx.mic.speech(600)
    await flush()
    ctx.mic.silence(900)
    await flush()
    expect(ctx.cascade.turns).toEqual([
      { turnId: 'c-1', text: 'me conta sobre júpiter', context: '[Contexto] hora local 21:00' },
    ])
    ctx.cascade.delta('c-1', 'Júpiter é o maior planeta do sistema solar. ')
    ctx.cascade.delta('c-1', 'Ele tem uma tempestade gigante.')
    ctx.cascade.done('c-1')
    await flush()
    expect(ctx.engine.getStatus()).toBe('speaking')
    ctx.playback.advance(5)
    await flush()
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(ctx.turns).toHaveLength(1)
    expect(ctx.turns[0]).toMatchObject({
      userTranscript: 'me conta sobre júpiter',
      interrupted: false,
      assistantSpokenText: 'Júpiter é o maior planeta do sistema solar. Ele tem uma tempestade gigante.',
    })
    expect(ctx.turns[0]!.metrics?.e2eMs).toBeTypeOf('number')
    await ctx.engine.stop()
  })

  it('barge-in aborts the host turn, drops pending TTS and records only what was heard (interrupted)', async () => {
    const ctx = setupEngine({ manualTts: true })
    const p = ctx.engine.start()
    await flush()
    await p
    ctx.mic.speech(600)
    await flush()
    ctx.mic.silence(900)
    await flush()
    // The LLM is still streaming a long answer; only the first phrase has audio.
    ctx.cascade.delta('c-1', 'Júpiter é enorme e gasoso. ')
    ctx.cascade.delta('c-1', 'A Grande Mancha Vermelha é uma tempestade antiga. ')
    ctx.cascade.delta('c-1', 'Ele tem quase cem luas conhecidas hoje em dia e ')
    await flush()
    ctx.cascade.tts[0]!.d.resolve(ttsResult(1000))
    await flush()
    expect(ctx.engine.getStatus()).toBe('speaking')
    ctx.playback.advance(0.5) // half of the first phrase heard
    ctx.mic.speech(700)
    await flush()
    expect(ctx.cascade.aborts).toEqual(['c-1'])
    expect(ctx.turns).toHaveLength(1)
    const rec = ctx.turns[0]!
    expect(rec.interrupted).toBe(true)
    // Truthful: a prefix of the FIRST phrase only — never the text the LLM generated ahead of the audio.
    expect('Júpiter é enorme e gasoso.'.startsWith(rec.assistantSpokenText)).toBe(true)
    expect(rec.assistantSpokenText.length).toBeGreaterThan(0)
    expect(rec.assistantSpokenText).not.toContain('Mancha')
    // Late TTS of the cancelled turn never plays.
    const before = ctx.playback.sources.length
    ctx.cascade.tts[1]?.d.resolve(ttsResult())
    await flush()
    expect(ctx.playback.sources.length).toBe(before)
    // The next turn carries the interruption note and a fresh turn id.
    ctx.mic.silence(900)
    await flush()
    expect(ctx.contexts.at(-1)?.interruptedAfterText).toBe(rec.assistantSpokenText)
    expect(ctx.cascade.turns.at(-1)?.turnId).toBe('c-2')
    await ctx.engine.stop()
  })

  it('a turn with no audio (LLM error) returns to listening and records nothing heard', async () => {
    const ctx = setupEngine()
    const p = ctx.engine.start()
    await flush()
    await p
    ctx.mic.speech(600)
    await flush()
    ctx.mic.silence(900)
    await flush()
    ctx.cascade.push('c-1', { kind: 'error', message: 'PROVIDER_NOT_CONFIGURED' })
    await flush()
    expect(ctx.engine.getStatus()).toBe('listening')
    expect(ctx.turns).toHaveLength(1)
    expect(ctx.turns[0]).toMatchObject({ assistantSpokenText: '', interrupted: false })
    await ctx.engine.stop()
  })
})
