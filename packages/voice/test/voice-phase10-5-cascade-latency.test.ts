/**
 * Phase 10.5 latency fixes (2026-11-01 run): LLM warm-up at connect (+ patient first turn with the
 * "carregando o modelo…" caption) and streamed TTS assembly (order, prebuffer, late chunks, cancel,
 * fallback), plus the short first chunk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallSynthesizeResult, CallSynthesizeStreamResult, CallTtsChunk } from '@ashy/shared'
import {
  CASCADE_WARMUP_CAPTION,
  createCallEngine,
  createCascadeSession,
  createTtsChunker,
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

function fakeHost(opts: { stream?: boolean } = {}) {
  const turns: CascadeTurnRequest[] = []
  const aborts: string[] = []
  const synthAborts: string[] = []
  const streams: Array<{ streamId: string; text: string; d: Deferred<CallSynthesizeStreamResult> }> = []
  const whole: Array<{ text: string; d: Deferred<CallSynthesizeResult> }> = []
  let listener: ((e: CascadeHostEvent) => void) | null = null
  let chunkListener: ((c: CallTtsChunk) => void) | null = null
  const options: CascadeSessionOptions = {
    startTurn: vi.fn(async (req: CascadeTurnRequest) => {
      turns.push(req)
      return { accepted: true }
    }),
    abortTurn: vi.fn((turnId: string) => {
      aborts.push(turnId)
    }),
    synthesize: vi.fn((text: string) => {
      const d = deferred<CallSynthesizeResult>()
      whole.push({ text, d })
      return d.promise
    }),
    subscribe: (cb) => {
      listener = cb
      return () => {
        listener = null
      }
    },
    ...(opts.stream
      ? {
          synthesizeStream: vi.fn((req: { streamId: string; text: string }) => {
            const d = deferred<CallSynthesizeStreamResult>()
            streams.push({ ...req, d })
            return d.promise
          }),
          subscribeTtsChunks: (cb: (c: CallTtsChunk) => void) => {
            chunkListener = cb
            return () => {
              chunkListener = null
            }
          },
          abortSynthesis: vi.fn((streamId: string) => {
            synthAborts.push(streamId)
          }),
        }
      : {}),
  }
  return {
    options,
    turns,
    aborts,
    synthAborts,
    streams,
    whole,
    delta(turnId: string, text: string) {
      listener?.({ turnId, kind: 'delta', delta: text })
    },
    done(turnId: string) {
      listener?.({ turnId, kind: 'done', text: '', providerId: 'ollama', modelId: 'm', latencyMs: 1 })
    },
    chunk(streamId: string, seq: number, ms: number) {
      chunkListener?.({ streamId, seq, pcmBase64: pcmBase64(ms, 24000), sampleRate: 24000 })
    },
    finishStream(i: number, chunks: number, extra: Partial<CallSynthesizeStreamResult> = {}) {
      const s = streams[i]!
      s.d.resolve({ streamId: s.streamId, chunks, sampleRate: 24000, durationMs: 0, latencyMs: 1, firstChunkMs: 1, ...extra })
    },
  }
}

function record(session: ReturnType<typeof createCascadeSession>) {
  const events: Array<{ type: keyof VoiceSessionEventMap; payload: any }> = []
  for (const type of ['response_started', 'response_status', 'response_text', 'response_audio', 'response_done', 'error'] as const) {
    session.on(type, (payload) => events.push({ type, payload }))
  }
  return {
    events,
    audioMs: () =>
      events
        .filter((e) => e.type === 'response_audio')
        .map((e) => Math.round((e.payload.pcm.length / e.payload.sampleRate) * 1000)),
  }
}

describe('Phase 10.5 — LLM warm-up at connect', () => {
  it('runs the warm-up in parallel with prepare; connect waits only for prepare', async () => {
    const host = fakeHost()
    const warm = deferred<unknown>()
    const prep = deferred<void>()
    const warmup = vi.fn(() => warm.promise)
    const prepare = vi.fn(() => prep.promise)
    const s = createCascadeSession({ ...host.options, warmup, prepare })
    let connected = false
    void s.connect({ instructions: '' }).then(() => (connected = true))
    await flush()
    expect(warmup).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(connected).toBe(false)
    prep.resolve()
    await flush()
    expect(connected).toBe(true) // the LLM warm-up is still running
    warm.resolve({ warmed: true })
    await flush()
  })

  it('a failing warm-up never fails the call: non-fatal warmup_failed, turns still work', async () => {
    const host = fakeHost()
    const s = createCascadeSession({ ...host.options, turnIdPrefix: 'c', warmup: async () => Promise.reject(new Error('ollama down')) })
    const rec = record(s)
    await expect(s.connect({ instructions: '' })).resolves.toBeUndefined()
    await flush()
    const err = rec.events.find((e) => e.type === 'error')!.payload
    expect(err).toMatchObject({ code: 'warmup_failed', fatal: false })
    expect(err.message).toContain('ollama down')
    s.submitTranscribedTurn({ text: 'oi', context: '' })
    await flush()
    expect(host.turns).toHaveLength(1)
  })

  it('a turn that starts while the warm-up runs gets the long timeout and the loading caption', async () => {
    const host = fakeHost()
    const warm = deferred<unknown>()
    const s = createCascadeSession({ ...host.options, turnIdPrefix: 'c', warmup: () => warm.promise })
    const rec = record(s)
    await s.connect({ instructions: '' })
    s.submitTranscribedTurn({ text: 'oi', context: '' })
    // never synchronously: the engine installs its ledger first
    expect(rec.events.some((e) => e.type === 'response_status')).toBe(false)
    await flush()
    expect(rec.events.find((e) => e.type === 'response_status')!.payload).toEqual({ responseId: 'c-1', text: CASCADE_WARMUP_CAPTION })
    await vi.advanceTimersByTimeAsync(60_000) // past the normal 45 s
    expect(host.aborts).toEqual([])
    expect(rec.events.some((e) => e.type === 'response_done')).toBe(false)
    await vi.advanceTimersByTimeAsync(31_000) // past 90 s
    expect(host.aborts).toEqual(['c-1'])
    expect(rec.events.find((e) => e.type === 'error')!.payload.message).toContain('90000 ms')
    // Warm-up done → the next turn is back to the normal timeout, no caption.
    warm.resolve(undefined)
    await flush()
    s.submitTranscribedTurn({ text: 'oi de novo', context: '' })
    await flush()
    expect(rec.events.filter((e) => e.type === 'response_status')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(46_000)
    expect(host.aborts).toEqual(['c-1', 'c-2'])
  })

  it('CallEngine shows "carregando o modelo…" while the first turn waits for the cold model', async () => {
    const settings = testSettings({ interrupt: { aecWarmupMs: 0, bargeInMinMs: 400 } })
    const mic = createFakeMicrophone()
    const playback = createFakePlaybackContext()
    const fake = createFakeHost({ transcript: 'oi ashy', perTurnContext: '' })
    const host = fakeHost()
    const warm = deferred<unknown>()
    fake.host.synthesize = vi.fn(async () => ttsResult())
    const engine = createCallEngine({
      callId: 'call-1',
      settings,
      host: fake.host,
      createSession: () =>
        createCascadeSession({
          ...host.options,
          turnIdPrefix: 'c',
          warmup: () => warm.promise,
          synthesize: (text) => fake.host.synthesize({ callId: 'call-1', text }),
        }),
      mediaDevices: mic.mediaDevices,
      captureAudioContextFactory: mic.captureContextFactory,
      playbackAudioContext: playback.ctx,
      detectorOptions: { sessionLoader: async () => null },
      now: () => Date.now(),
    })
    const p = engine.start()
    await flush()
    expect(await p).toBe('listening')
    mic.speech(600)
    await flush()
    mic.silence(900)
    await flush()
    expect(host.turns).toHaveLength(1)
    expect(engine.getSnapshot().caption).toEqual({ role: 'assistant', text: CASCADE_WARMUP_CAPTION, final: false })
    warm.resolve(undefined)
    host.delta('c-1', 'Oi Carlos, tudo bem?')
    host.done('c-1')
    await flush()
    expect(engine.getStatus()).toBe('speaking')
    expect(engine.getSnapshot().caption?.text).toBe('Oi Carlos, tudo bem?')
    await engine.stop()
  })
})

describe('Phase 10.5 — streamed TTS assembly', () => {
  async function streamingSession(extra: Partial<CascadeSessionOptions> = {}) {
    const host = fakeHost({ stream: true })
    const s = createCascadeSession({ ...host.options, turnIdPrefix: 'c', maxParallelTts: 2, ...extra })
    const rec = record(s)
    await s.connect({ instructions: '' })
    s.submitTranscribedTurn({ text: 'oi', context: '' })
    await flush()
    return { host, s, rec }
  }

  it('plays the head phrase as its chunks arrive (after the prebuffer), later phrases strictly in order', async () => {
    const { host, rec } = await streamingSession()
    host.delta('c-1', 'Oi Carlos, tudo bem com você hoje? ')
    host.delta('c-1', 'Júpiter tem dezenas de luas conhecidas.')
    host.done('c-1')
    await flush()
    expect(host.streams.map((x) => x.streamId)).toEqual(['c-1-p0', 'c-1-p1'])
    expect(host.whole).toHaveLength(0)
    // Phrase 2 streams first: buffered, nothing plays.
    host.chunk('c-1-p1', 0, 500)
    await flush()
    expect(rec.audioMs()).toEqual([])
    // Head: 100 ms < 200 ms prebuffer → wait; 120 more → play 220 ms; then each chunk as it comes.
    host.chunk('c-1-p0', 0, 100)
    await flush()
    expect(rec.audioMs()).toEqual([])
    host.chunk('c-1-p0', 1, 120)
    await flush()
    expect(rec.audioMs()).toEqual([220])
    const texts = rec.events.filter((e) => e.type === 'response_text').map((e) => e.payload.text)
    expect(texts).toEqual(['Oi Carlos, tudo bem com você hoje?'])
    host.chunk('c-1-p0', 2, 80)
    await flush()
    expect(rec.audioMs()).toEqual([220, 80])
    host.finishStream(0, 3)
    await flush()
    // Phrase 1 complete → phrase 2's buffered audio plays at once.
    expect(rec.audioMs()).toEqual([220, 80, 500])
    expect(rec.events.filter((e) => e.type === 'response_text').at(-1)!.payload.text).toBe(
      'Oi Carlos, tudo bem com você hoje? Júpiter tem dezenas de luas conhecidas.',
    )
    expect(rec.events.some((e) => e.type === 'response_done')).toBe(false)
    host.chunk('c-1-p1', 1, 100)
    host.finishStream(1, 2)
    await flush()
    expect(rec.audioMs()).toEqual([220, 80, 500, 100])
    const done = rec.events.find((e) => e.type === 'response_done')!.payload
    expect(done.cancelled).toBe(false)
    expect(Math.round(done.audioMs)).toBe(900)
  })

  it('reassembles out-of-order chunks and waits (grace) for chunks still in transit after the result', async () => {
    const { host, rec } = await streamingSession({ streamPrebufferMs: 0 })
    host.delta('c-1', 'Oi Carlos, tudo bem?')
    host.done('c-1')
    await flush()
    host.chunk('c-1-p0', 1, 50)
    await flush()
    expect(rec.audioMs()).toEqual([]) // seq 0 missing
    host.finishStream(0, 3)
    await flush()
    host.chunk('c-1-p0', 0, 40)
    await flush()
    expect(rec.audioMs()).toEqual([90])
    expect(rec.events.some((e) => e.type === 'response_done')).toBe(false)
    host.chunk('c-1-p0', 2, 30)
    await flush()
    expect(rec.audioMs()).toEqual([90, 30])
    expect(rec.events.some((e) => e.type === 'response_done')).toBe(true)
  })

  it('gives up on chunks that never arrive after the grace period', async () => {
    const { host, rec } = await streamingSession({ streamPrebufferMs: 0, streamGraceMs: 500 })
    host.delta('c-1', 'Oi Carlos, tudo bem?')
    host.done('c-1')
    await flush()
    host.chunk('c-1-p0', 0, 60)
    host.finishStream(0, 2)
    await flush()
    expect(rec.audioMs()).toEqual([60])
    expect(rec.events.some((e) => e.type === 'response_done')).toBe(false)
    await vi.advanceTimersByTimeAsync(600)
    expect(rec.events.find((e) => e.type === 'response_done')!.payload.cancelled).toBe(false)
  })

  it('cancel (barge-in) aborts live streams host-side and ignores their late chunks', async () => {
    const { host, s, rec } = await streamingSession({ streamPrebufferMs: 0 })
    host.delta('c-1', 'Oi Carlos, tudo bem com você hoje? ')
    host.delta('c-1', 'Júpiter tem dezenas de luas conhecidas.')
    host.done('c-1')
    await flush()
    host.chunk('c-1-p0', 0, 100)
    await flush()
    expect(rec.audioMs()).toEqual([100])
    s.cancelResponse('client')
    await flush()
    expect(host.synthAborts.sort()).toEqual(['c-1-p0', 'c-1-p1'])
    host.chunk('c-1-p0', 1, 100)
    host.chunk('c-1-p1', 0, 100)
    host.finishStream(0, 2)
    host.finishStream(1, 1)
    await flush()
    expect(rec.audioMs()).toEqual([100])
    const done = rec.events.filter((e) => e.type === 'response_done')
    expect(done).toHaveLength(1)
    expect(done[0]!.payload).toMatchObject({ cancelled: true, cancelReason: 'client' })
  })

  it('a stream that fails before any audio retries the phrase once without streaming', async () => {
    const { host, rec } = await streamingSession()
    host.delta('c-1', 'Oi Carlos, tudo bem?')
    host.done('c-1')
    await flush()
    host.streams[0]!.d.reject(new Error('LIVE_CALL_METHOD_UNAVAILABLE'))
    await flush()
    expect(rec.events.find((e) => e.type === 'error')!.payload.code).toBe('tts_stream_failed')
    expect(host.whole.map((w) => w.text)).toEqual(['Oi Carlos, tudo bem?'])
    host.whole[0]!.d.resolve(ttsResult(300))
    await flush()
    expect(rec.audioMs()).toEqual([300])
    expect(rec.events.find((e) => e.type === 'response_done')!.payload.text).toBe('Oi Carlos, tudo bem?')
  })

  it('slower-than-real-time TTS: the head phrase buffers enough before playing (no mid-phrase stutter)', async () => {
    let clock = 0
    const { host, s, rec } = await streamingSession({ now: () => clock })
    // Turn 1: a stream that produced 1 s of audio in 2 s (rate 0.5) teaches the rate estimate.
    host.delta('c-1', 'Oi Carlos, tudo bem?')
    host.done('c-1')
    await flush()
    clock = 2000
    host.chunk('c-1-p0', 0, 1000)
    host.finishStream(0, 1, { durationMs: 1000 })
    await flush()
    expect(rec.events.filter((e) => e.type === 'response_done')).toHaveLength(1)
    clock = 10_000 // the player drained long ago
    s.submitTranscribedTurn({ text: 'mais', context: '' })
    await flush()
    // 40 chars ≈ 2.4 s of speech at rate ~0.75 → needs ≈ 0.55–0.7 s buffered (not just the 200 ms prebuffer).
    host.delta('c-2', 'Júpiter tem dezenas de luas conhecidas!!')
    host.done('c-2')
    await flush()
    const id = host.streams[1]!.streamId
    const before = rec.audioMs().length
    clock = 10_400
    host.chunk(id, 0, 300)
    await flush()
    expect(rec.audioMs().length).toBe(before) // 300 ms is not enough yet
    clock = 11_000
    host.chunk(id, 1, 500)
    await flush()
    expect(rec.audioMs().slice(before)).toEqual([800])
    host.chunk(id, 2, 100)
    await flush()
    expect(rec.audioMs().slice(before)).toEqual([800, 100]) // once started, pieces flow as they come
  })

  it("streamPhrases 'first' streams only the first phrase", async () => {
    const { host } = await streamingSession({ streamPhrases: 'first' })
    host.delta('c-1', 'Oi Carlos, tudo bem com você hoje? ')
    host.delta('c-1', 'Júpiter tem dezenas de luas conhecidas.')
    host.done('c-1')
    await flush()
    expect(host.streams.map((x) => x.streamId)).toEqual(['c-1-p0'])
    expect(host.whole.map((w) => w.text)).toEqual(['Júpiter tem dezenas de luas conhecidas.'])
  })
})

describe('Phase 10.5 — short first chunk', () => {
  it('firstChunkMaxWords caps only the first chunk', () => {
    const chunker = createTtsChunker({ firstChunkMaxWords: 6 })
    const out = chunker.writeFlush(
      'Bom, eu acho que a gente podia conversar sobre astronomia hoje porque eu adoro planetas e estrelas brilhantes no céu',
    )
    expect(out[0]).toBe('Bom, eu acho que a gente')
    expect(out[1]!.split(' ').length).toBeGreaterThan(6)
  })

  it('the cascade session sends a ≤7-word first phrase to the TTS', async () => {
    const host = fakeHost()
    const s = createCascadeSession({ ...host.options, turnIdPrefix: 'c' })
    await s.connect({ instructions: '' })
    s.submitTranscribedTurn({ text: 'oi', context: '' })
    await flush()
    host.delta('c-1', 'Então, eu estava pensando que Júpiter é um planeta fascinante e enorme. ')
    await flush()
    expect(host.whole[0]!.text.split(' ').length).toBeLessThanOrEqual(7)
  })
})
