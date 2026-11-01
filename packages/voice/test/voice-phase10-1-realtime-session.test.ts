import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  audioBudgetMs,
  buildRealtimeUrl,
  checkRunaway,
  createLlamaCppRealtimeSession,
  detectDegenerateText,
  type VoiceSessionEventMap,
} from '../src'
import { createFakeRealtimeServer, flush, pcmBase64, sentTypes, TEST_INSTRUCTIONS } from './helpers/phase10-1-fakes'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function collect(session: ReturnType<typeof createLlamaCppRealtimeSession>) {
  const events: Array<{ type: keyof VoiceSessionEventMap; payload: unknown }> = []
  for (const type of [
    'response_started',
    'response_text',
    'response_audio',
    'response_done',
    'error',
    'closed',
  ] as const) {
    session.on(type, (payload) => events.push({ type, payload }))
  }
  return events
}

describe('Phase 10.1 LlamaCppRealtimeSession (spec §8.1)', () => {
  it('builds the realtime URL from the llama-server base URL', () => {
    expect(buildRealtimeUrl('http://127.0.0.1:8081', 'lfm3-omni-2b-q4km')).toBe(
      'ws://127.0.0.1:8081/v1/realtime?model=lfm3-omni-2b-q4km',
    )
    expect(buildRealtimeUrl('http://127.0.0.1:8081/')).toBe('ws://127.0.0.1:8081/v1/realtime')
  })

  it('waits for session.created, sends session.update with host instructions, and resolves only after session.updated', async () => {
    const server = createFakeRealtimeServer({ autoSessionUpdated: false, inputRate: 16000, outputRate: 24000 })
    const session = createLlamaCppRealtimeSession({
      baseUrl: 'http://127.0.0.1:9999',
      maxOutputTokens: 321,
      webSocketFactory: server.factory,
    })
    let resolved = false
    const p = session.connect({ instructions: TEST_INSTRUCTIONS }).then(() => {
      resolved = true
    })
    expect(server.last.sent).toHaveLength(0) // nothing before session.created
    await flush(3)
    expect(sentTypes(server.last)).toEqual(['session.update'])
    expect(server.last.sent[0]!.session).toEqual({
      instructions: TEST_INSTRUCTIONS,
      output_modalities: ['text', 'audio'],
      max_output_tokens: 321,
    })
    expect(resolved).toBe(false)

    // Input before session.updated is refused (nothing goes on the wire).
    const errors: unknown[] = []
    session.on('error', (e) => errors.push(e))
    session.submitUserText('oi', '[Contexto] x')
    expect(sentTypes(server.last)).toEqual(['session.update'])
    expect(errors).toHaveLength(1)

    server.last.deliver({ type: 'session.updated', session: {} })
    await p
    expect(resolved).toBe(true)
    expect(session.caps.inputSampleRate).toBe(16000)
    expect(session.caps.outputSampleRate).toBe(24000)
    expect(session.caps.serverTurnDetection).toBe(false)
    expect(session.caps.contextInjection).toBe('input_text_item')
  })

  it('reads the rates from session.created', async () => {
    const server = createFakeRealtimeServer({ inputRate: 22050, outputRate: 48000 })
    const session = createLlamaCppRealtimeSession({ baseUrl: 'http://127.0.0.1:1', webSocketFactory: server.factory })
    const p = session.connect({ instructions: 'x' })
    await flush(5)
    await p
    expect(session.caps.inputSampleRate).toBe(22050)
    expect(session.caps.outputSampleRate).toBe(48000)
  })

  it('transcribed mode: context item, then user text item, then response.create', async () => {
    const server = createFakeRealtimeServer()
    const session = createLlamaCppRealtimeSession({ baseUrl: 'http://127.0.0.1:1', webSocketFactory: server.factory })
    const p = session.connect({ instructions: TEST_INSTRUCTIONS })
    await flush(5)
    await p
    session.submitUserText('me fala de gatos', '[Contexto] hora local 21:00')
    const msgs = server.last.sent.slice(1)
    expect(msgs.map((m) => m.type)).toEqual(['conversation.item.create', 'conversation.item.create', 'response.create'])
    expect(msgs[0]!.item).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '[Contexto] hora local 21:00' }],
    })
    expect(msgs[1]!.item).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'me fala de gatos' }],
    })

    // Empty context → only the user item.
    server.last.sent.length = 0
    server.last.deliver({ type: 'response.done', response: { status: 'completed' } })
    session.submitUserText('oi', '   ')
    expect(sentTypes(server.last)).toEqual(['conversation.item.create', 'response.create'])
  })

  it('streams text and PCM16 audio deltas, then response_done', async () => {
    const server = createFakeRealtimeServer()
    const session = createLlamaCppRealtimeSession({ baseUrl: 'http://127.0.0.1:1', webSocketFactory: server.factory })
    const events = collect(session)
    const p = session.connect({ instructions: 'x' })
    await flush(5)
    await p
    session.submitUserText('oi')
    server.streamResponse(server.last, { text: ['Oi, ', 'tudo bem?'], audioMs: [200, 200] })
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('response_started')
    expect(types.filter((t) => t === 'response_audio')).toHaveLength(2)
    const audio = events.find((e) => e.type === 'response_audio')!.payload as VoiceSessionEventMap['response_audio']
    expect(audio.pcm).toBeInstanceOf(Int16Array)
    expect(audio.pcm.length).toBe(4800)
    expect(audio.sampleRate).toBe(24000)
    const done = events.find((e) => e.type === 'response_done')!.payload as VoiceSessionEventMap['response_done']
    expect(done.text).toBe('Oi, tudo bem?')
    expect(done.cancelled).toBe(false)
    expect(done.audioMs).toBeCloseTo(400, 0)
  })

  it('watchdog cancels runaway audio (audio ≫ text estimate) and drops the rest of the response', async () => {
    const server = createFakeRealtimeServer()
    const session = createLlamaCppRealtimeSession({ baseUrl: 'http://127.0.0.1:1', webSocketFactory: server.factory })
    const events = collect(session)
    const p = session.connect({ instructions: 'x' })
    await flush(5)
    await p
    session.submitUserText('oi')
    // "Oi." (3 chars → ~214 ms) but the model keeps talking: 10 × 1 s of audio.
    server.streamResponse(server.last, {
      text: ['Oi.'],
      audioMs: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
      done: false,
    })
    expect(sentTypes(server.last)).toContain('response.cancel')
    const done = events.filter((e) => e.type === 'response_done')
    expect(done).toHaveLength(1)
    const payload = done[0]!.payload as VoiceSessionEventMap['response_done']
    expect(payload.cancelled).toBe(true)
    expect(payload.cancelReason).toBe('watchdog')
    // Budget is the 4 s floor: the 5th second trips it, later deltas are ignored.
    expect(events.filter((e) => e.type === 'response_audio')).toHaveLength(5)

    // The server's response.done for the cancelled response is swallowed; the next request goes out.
    server.last.deliver({ type: 'response.done', response: { status: 'cancelled' } })
    expect(events.filter((e) => e.type === 'response_done')).toHaveLength(1)
  })

  it('watchdog cancels degenerate text (repetition / sustained vowel)', async () => {
    const server = createFakeRealtimeServer()
    const session = createLlamaCppRealtimeSession({ baseUrl: 'http://127.0.0.1:1', webSocketFactory: server.factory })
    const events = collect(session)
    const p = session.connect({ instructions: 'x' })
    await flush(5)
    await p
    session.submitUserText('oi')
    server.streamResponse(server.last, { text: ['Ent', 'ãooooooooooo'], done: false })
    const done = events.find((e) => e.type === 'response_done')!.payload as VoiceSessionEventMap['response_done']
    expect(done.cancelReason).toBe('watchdog')
    expect(done.detail).toMatch(/vowel_run/)
  })

  it('cancelResponse sends response.cancel and defers the next request until the server confirms', async () => {
    const server = createFakeRealtimeServer()
    const session = createLlamaCppRealtimeSession({ baseUrl: 'http://127.0.0.1:1', webSocketFactory: server.factory })
    const events = collect(session)
    const p = session.connect({ instructions: 'x' })
    await flush(5)
    await p
    session.submitUserText('primeira')
    server.streamResponse(server.last, { text: ['Era uma vez'], audioMs: [300], done: false })
    session.cancelResponse()
    expect(sentTypes(server.last).at(-1)).toBe('response.cancel')
    const done = events.filter((e) => e.type === 'response_done')
    expect((done[0]!.payload as VoiceSessionEventMap['response_done']).cancelReason).toBe('client')

    // Late deltas of the cancelled response are dropped.
    server.last.deliver({ type: 'response.output_audio.delta', delta: pcmBase64(100, 24000) })
    expect(events.filter((e) => e.type === 'response_audio')).toHaveLength(1)

    server.last.sent.length = 0
    session.submitUserText('segunda')
    expect(sentTypes(server.last)).toEqual([]) // waiting for the cancel to settle
    server.last.deliver({ type: 'response.done', response: { status: 'cancelled' } })
    expect(sentTypes(server.last)).toEqual(['conversation.item.create', 'response.create'])
  })

  it('audio-direct (experimental): append in ≥40 ms chunks, commit, context, response.create', async () => {
    const server = createFakeRealtimeServer()
    const session = createLlamaCppRealtimeSession({
      baseUrl: 'http://127.0.0.1:1',
      inputMode: 'audio-direct',
      appendChunkMs: 50,
      webSocketFactory: server.factory,
    })
    const p = session.connect({ instructions: 'x' })
    await flush(5)
    await p
    for (let i = 0; i < 5; i++) session.pushAudio(new Int16Array(320)) // 5 × 20 ms
    expect(sentTypes(server.last).filter((t) => t === 'input_audio_buffer.append')).toHaveLength(1)
    session.commitUserTurn()
    session.respond({ contextText: '[Contexto] y' })
    expect(sentTypes(server.last).slice(1)).toEqual([
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
      'conversation.item.create',
      'response.create',
    ])
  })

  it('emits closed(expected:false) when the server drops the socket, expected:true on close()', async () => {
    const server = createFakeRealtimeServer()
    const s1 = createLlamaCppRealtimeSession({ baseUrl: 'http://127.0.0.1:1', webSocketFactory: server.factory })
    const e1 = collect(s1)
    const p1 = s1.connect({ instructions: 'x' })
    await flush(5)
    await p1
    server.last.serverClose(1006)
    expect(e1.find((e) => e.type === 'closed')!.payload).toMatchObject({ expected: false, code: 1006 })

    const s2 = createLlamaCppRealtimeSession({ baseUrl: 'http://127.0.0.1:1', webSocketFactory: server.factory })
    const e2 = collect(s2)
    const p2 = s2.connect({ instructions: 'x' })
    await flush(5)
    await p2
    await s2.close()
    await flush(2)
    expect(e2.filter((e) => e.type === 'closed')).toHaveLength(1)
    expect(e2.find((e) => e.type === 'closed')!.payload).toMatchObject({ expected: true })
  })

  it('handshake fails on timeout and requires host instructions', async () => {
    const server = createFakeRealtimeServer({ autoSessionUpdated: false })
    const session = createLlamaCppRealtimeSession({
      baseUrl: 'http://127.0.0.1:1',
      webSocketFactory: server.factory,
      handshakeTimeoutMs: 500,
    })
    const p = session.connect({ instructions: 'x' })
    const assertion = expect(p).rejects.toThrow(/timeout/)
    await vi.advanceTimersByTimeAsync(600)
    await assertion
    const other = createLlamaCppRealtimeSession({ baseUrl: 'http://127.0.0.1:1', webSocketFactory: server.factory })
    await expect(other.connect({} as { instructions: string })).rejects.toThrow(/instructions/)
  })
})

describe('Phase 10.1 runaway watchdog rules', () => {
  it('budget = max(3 × text estimate @14 chars/s, 4 s), hard cap 45 s', () => {
    expect(audioBudgetMs(0)).toBe(4000)
    expect(audioBudgetMs(140)).toBe(30000)
    expect(audioBudgetMs(1000)).toBe(45000)
    expect(checkRunaway({ audioMs: 46000, text: 'x'.repeat(5000) })).toMatchObject({ runaway: true, kind: 'audio_cap' })
    expect(checkRunaway({ audioMs: 3000, text: 'Oi, tudo bem?' })).toEqual({ runaway: false })
  })

  it('detects repeated n-grams but not normal speech', () => {
    expect(detectDegenerateText('Oi, tudo bem? Gatos são ótimos parceiros, independentes e curiosos.').runaway).toBe(false)
    expect(detectDegenerateText('eu acho que eu acho que eu acho que eu acho que').runaway).toBe(true)
    expect(detectDegenerateText('não não não não não não não').runaway).toBe(true)
    expect(detectDegenerateText('aaaaaaaaaah').runaway).toBe(true)
    expect(detectDegenerateText('haha que legal').runaway).toBe(false)
  })
})
