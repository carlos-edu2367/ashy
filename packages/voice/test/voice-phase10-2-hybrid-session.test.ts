import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallSynthesizeResult } from '@ashy/shared'
import {
  createLlamaCppHybridSession,
  int16ToBase64,
  speakableStreamText,
  type VoiceSessionEventMap,
} from '../src'
import { createFakeRealtimeServer, flush, sentTypes, TEST_INSTRUCTIONS } from './helpers/phase10-1-fakes'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

interface PendingTts {
  text: string
  resolve(samples?: number, value?: number): void
  reject(err: Error): void
}

/** Manually-resolved /tts: every phrase's PCM is filled with a marker value so order is checkable. */
function createManualTts() {
  const calls: PendingTts[] = []
  let inflight = 0
  let maxInflight = 0
  const synthesize = vi.fn(
    (text: string) =>
      new Promise<CallSynthesizeResult>((resolve, reject) => {
        inflight += 1
        maxInflight = Math.max(maxInflight, inflight)
        calls.push({
          text,
          resolve(samples = 2400, value = calls.findIndex((c) => c.text === text) + 1) {
            inflight -= 1
            const pcm = new Int16Array(samples).fill(value)
            resolve({ pcmBase64: int16ToBase64(pcm), sampleRate: 24000, durationMs: (samples / 24000) * 1000, latencyMs: 5 })
          },
          reject(err) {
            inflight -= 1
            reject(err)
          },
        })
      }),
  )
  return {
    synthesize,
    calls,
    get inflight() {
      return inflight
    },
    get maxInflight() {
      return maxInflight
    },
  }
}

function collect(session: ReturnType<typeof createLlamaCppHybridSession>) {
  const events: Array<{ type: keyof VoiceSessionEventMap; payload: any }> = []
  for (const type of ['response_started', 'response_text', 'response_audio', 'response_done', 'error'] as const) {
    session.on(type, (payload) => events.push({ type, payload }))
  }
  return events
}

async function connected(opts: { maxParallelTts?: number; tts?: ReturnType<typeof createManualTts> } = {}) {
  const server = createFakeRealtimeServer()
  const tts = opts.tts ?? createManualTts()
  const session = createLlamaCppHybridSession({
    baseUrl: 'http://127.0.0.1:9999',
    modelId: 'lfm3-omni-2b-q4km',
    maxOutputTokens: 200,
    synthesize: tts.synthesize,
    maxParallelTts: opts.maxParallelTts ?? 2,
    webSocketFactory: server.factory,
  })
  const events = collect(session)
  const p = session.connect({ instructions: TEST_INSTRUCTIONS })
  await flush(5)
  await p
  return { server, tts, session, events }
}

const THREE_SENTENCES = ['Oi! Tudo ótimo por aqui, e com você? ', 'Hoje eu aprendi que polvos têm três corações. ', 'Legal, né?']

describe('Phase 10.2 LlamaCppHybridSession (text realtime + host /tts)', () => {
  it('asks the realtime session for TEXT only and keeps the host instructions', async () => {
    const { server, session } = await connected()
    expect(sentTypes(server.last)).toEqual(['session.update'])
    expect(server.last.sent[0]!.session).toEqual({
      instructions: TEST_INSTRUCTIONS,
      output_modalities: ['text'],
      max_output_tokens: 200,
    })
    expect(server.last.url).toBe('ws://127.0.0.1:9999/v1/realtime?model=lfm3-omni-2b-q4km')
    expect(session.connected).toBe(true)
    expect(session.caps.speakerReference).toBe(true)
    expect(session.caps.outputSampleRate).toBe(24000)
  })

  it('emits text deltas, audio in phrase order even when /tts completes out of order, then response_done', async () => {
    const { server, session, tts, events } = await connected({ maxParallelTts: 3 })
    session.submitUserText('me conta uma curiosidade', '[Contexto] Hora local: 10:00.')
    expect(sentTypes(server.last).slice(1)).toEqual(['conversation.item.create', 'conversation.item.create', 'response.create'])
    server.streamResponse(server.last, { text: THREE_SENTENCES })
    await flush(3)

    expect(events.filter((e) => e.type === 'response_text').map((e) => e.payload.delta)).toEqual(THREE_SENTENCES)
    // Boosted chunker: short first phrases (soft punctuation), then sentences.
    expect(tts.calls.map((c) => c.text)).toEqual(['Oi!', 'Tudo ótimo por aqui,', 'e com você?'])
    // Text is done but audio isn't: no response_done yet.
    expect(events.some((e) => e.type === 'response_done')).toBe(false)

    // Complete out of order: always the newest in-flight phrase first; phrase i carries value i+1.
    const resolved = new Set<number>()
    for (let guard = 0; guard < 20 && resolved.size < tts.calls.length; guard++) {
      const idx = [...tts.calls.keys()].filter((i) => !resolved.has(i)).at(-1)!
      resolved.add(idx)
      tts.calls[idx]!.resolve(2400, idx + 1)
      await flush(2)
      if (!resolved.has(0)) expect(events.some((e) => e.type === 'response_audio')).toBe(false)
    }
    expect(tts.calls.map((c) => c.text)).toEqual([
      'Oi!',
      'Tudo ótimo por aqui,',
      'e com você?',
      'Hoje eu aprendi que polvos têm três corações.',
      'Legal, né?',
    ])

    const audio = events.filter((e) => e.type === 'response_audio')
    expect(audio.map((e) => e.payload.pcm[0])).toEqual([1, 2, 3, 4, 5])
    expect(audio.every((e) => e.payload.sampleRate === 24000)).toBe(true)
    const done = events.filter((e) => e.type === 'response_done')
    expect(done).toHaveLength(1)
    expect(done[0]!.payload).toMatchObject({ cancelled: false, text: THREE_SENTENCES.join(''), audioMs: 500 })
    // response_done is the last event of the response.
    expect(events.at(-1)!.type).toBe('response_done')
    expect(events[0]!.type).toBe('response_started')
  })

  it('never has more than maxParallelTts /tts requests in flight', async () => {
    const { server, session, tts } = await connected({ maxParallelTts: 2 })
    session.submitUserText('oi')
    server.streamResponse(server.last, {
      text: ['Um, dois, três, quatro, cinco palavras. ', 'Frase dois aqui. ', 'Frase três aqui. ', 'Frase quatro. ', 'Cinco.'],
    })
    await flush(3)
    expect(tts.calls).toHaveLength(2)
    expect(tts.inflight).toBe(2)
    let guard = 0
    while (tts.calls.some((c, i) => i >= 0 && !('done' in c)) && guard++ < 20) {
      const next = tts.calls.find((c) => !('done' in c))
      if (!next) break
      ;(next as PendingTts & { done?: true }).done = true
      next.resolve()
      await flush(2)
      expect(tts.inflight).toBeLessThanOrEqual(2)
    }
    expect(tts.maxInflight).toBe(2)
    expect(tts.calls.length).toBeGreaterThanOrEqual(5)
  })

  it('cancelResponse cancels the realtime response, drops pending /tts and ignores late audio', async () => {
    const { server, session, tts, events } = await connected({ maxParallelTts: 2 })
    session.submitUserText('oi')
    server.streamResponse(server.last, { text: ['Primeira frase aqui. ', 'Segunda frase ali. ', 'Terceira'], done: false })
    await flush(3)
    expect(tts.calls).toHaveLength(2)
    tts.calls[0]!.resolve(2400, 1)
    await flush(2)
    expect(events.filter((e) => e.type === 'response_audio')).toHaveLength(1)

    session.cancelResponse('client')
    expect(sentTypes(server.last)).toContain('response.cancel')
    const done = events.filter((e) => e.type === 'response_done')
    expect(done).toHaveLength(1)
    expect(done[0]!.payload).toMatchObject({ cancelled: true, cancelReason: 'client', audioMs: 100 })

    // Late completion of the in-flight phrase and late text deltas are ignored.
    tts.calls[1]!.resolve(2400, 2)
    server.last.deliver({ type: 'response.output_text.delta', delta: ' mais texto. Outra frase.' })
    server.last.deliver({ type: 'response.done', response: { status: 'cancelled' } })
    await flush(5)
    expect(events.filter((e) => e.type === 'response_audio')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'response_done')).toHaveLength(1)
    expect(tts.calls).toHaveLength(2)
  })

  it('cancel after the text finished (still speaking) drops the remaining phrases', async () => {
    const { server, session, tts, events } = await connected({ maxParallelTts: 1 })
    session.submitUserText('oi')
    server.streamResponse(server.last, { text: ['Primeira frase aqui. ', 'Segunda frase ali.'] })
    await flush(3)
    expect(tts.calls).toHaveLength(1)
    session.cancelResponse('client')
    // The realtime response was already done: nothing to cancel on the wire.
    expect(sentTypes(server.last)).not.toContain('response.cancel')
    expect(events.filter((e) => e.type === 'response_done').map((e) => e.payload.cancelled)).toEqual([true])
    tts.calls[0]!.resolve()
    await flush(3)
    expect(tts.calls).toHaveLength(1)
    expect(events.filter((e) => e.type === 'response_audio')).toHaveLength(0)
  })

  it('a new user turn while the previous answer is still being spoken cancels it first', async () => {
    const { server, session, tts, events } = await connected()
    session.submitUserText('oi')
    server.streamResponse(server.last, { text: ['Resposta um. '] })
    await flush(3)
    session.submitUserText('e aí?')
    const doneIds = events.filter((e) => e.type === 'response_done').map((e) => e.payload)
    expect(doneIds).toHaveLength(1)
    expect(doneIds[0]).toMatchObject({ cancelled: true })
    tts.calls[0]!.resolve()
    server.streamResponse(server.last, { text: ['Resposta dois.'] })
    await flush(3)
    expect(tts.calls.map((c) => c.text)).toEqual(['Resposta um.', 'Resposta dois.'])
    tts.calls[1]!.resolve(2400, 9)
    await flush(3)
    const audio = events.filter((e) => e.type === 'response_audio')
    expect(audio.map((e) => e.payload.pcm[0])).toEqual([9])
    expect(events.filter((e) => e.type === 'response_done').map((e) => e.payload.cancelled)).toEqual([true, false])
  })

  it('text-only watchdog: degenerate text cancels the response and the pending /tts', async () => {
    const { server, session, tts, events } = await connected()
    session.submitUserText('oi')
    server.streamResponse(server.last, {
      text: ['Tudo bem. ', 'aaaaaaaaaaaaaaaaaaaa'],
      done: false,
    })
    await flush(3)
    const done = events.filter((e) => e.type === 'response_done')
    expect(done).toHaveLength(1)
    expect(done[0]!.payload).toMatchObject({ cancelled: true, cancelReason: 'watchdog' })
    expect(sentTypes(server.last)).toContain('response.cancel')
    for (const c of tts.calls) c.resolve()
    await flush(3)
    expect(events.filter((e) => e.type === 'response_audio')).toHaveLength(0)
  })

  it('a long normal text answer never trips the (audio-budget) watchdog', async () => {
    const tts = createManualTts()
    const { server, session, events } = await connected({ tts })
    session.submitUserText('oi')
    const sentences = Array.from({ length: 12 }, (_, i) => `Esta é a frase número ${i + 1} da resposta comprida. `)
    server.streamResponse(server.last, { text: sentences })
    await flush(3)
    for (let i = 0; i < 40 && tts.calls.some((c) => !(c as { done?: boolean }).done); i++) {
      const next = tts.calls.find((c) => !(c as { done?: boolean }).done)!
      ;(next as { done?: boolean }).done = true
      next.resolve(24000 * 3)
      await flush(2)
    }
    const done = events.filter((e) => e.type === 'response_done')
    expect(done).toHaveLength(1)
    expect(done[0]!.payload.cancelled).toBe(false)
    expect(done[0]!.payload.audioMs).toBeGreaterThan(30000)
  })

  it('never speaks ACT markers, markdown or emojis; a failed phrase is skipped with a non-fatal error', async () => {
    const { server, session, tts, events } = await connected()
    session.submitUserText('oi')
    server.streamResponse(server.last, {
      text: ['<|ACT {"emotion":"happy"', '}|>Que **legal** 😄! ', 'Segunda frase.'],
    })
    await flush(3)
    expect(tts.calls.map((c) => c.text)).toEqual(['Que legal!', 'Segunda frase.'])
    tts.calls[0]!.reject(new Error('TTS_HTTP_500'))
    await flush(2)
    tts.calls[1]!.resolve(2400, 7)
    await flush(2)
    expect(events.filter((e) => e.type === 'error')[0]!.payload).toMatchObject({ code: 'tts_failed', fatal: false })
    expect(events.filter((e) => e.type === 'response_audio').map((e) => e.payload.pcm[0])).toEqual([7])
    expect(events.filter((e) => e.type === 'response_done')[0]!.payload.cancelled).toBe(false)
  })

  it('speakableStreamText holds back an unfinished marker and only ever grows', () => {
    expect(speakableStreamText('Oi <|ACT {"a":1')).toBe('Oi ')
    expect(speakableStreamText('Oi <|ACT {"a":1}|> tudo')).toBe('Oi   tudo')
    expect(speakableStreamText('Oi <')).toBe('Oi ')
    expect(speakableStreamText('Oi <|ACT {"a":1}}> bem')).toBe('Oi   bem')
  })

  it('close() drops everything', async () => {
    const { server, session, tts, events } = await connected()
    session.submitUserText('oi')
    server.streamResponse(server.last, { text: ['Uma frase. '] })
    await flush(3)
    await session.close()
    tts.calls[0]!.resolve()
    await flush(3)
    expect(events.filter((e) => e.type === 'response_audio')).toHaveLength(0)
  })
})
