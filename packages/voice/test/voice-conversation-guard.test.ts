/**
 * 2026-11-01 — small-model conversation guard: echo / self-vocative helpers and the hybrid session
 * dropping an echoed opening, regenerating a pure echo once and never saying "Ashy" to the user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallSynthesizeResult } from '@ashy/shared'
import {
  HYBRID_ECHO_RETRY_CONTEXT,
  createLlamaCppHybridSession,
  echoedOpening,
  int16ToBase64,
  isEchoOfUtterance,
  removeSelfVocative,
  userUtteranceOfTurnItem,
  type VoiceSessionEventMap,
} from '../src'
import { createFakeRealtimeServer, flush, TEST_INSTRUCTIONS } from './helpers/phase10-1-fakes'

describe('conversation guard helpers', () => {
  it('extracts the user words of a turn item', () => {
    expect(userUtteranceOfTurnItem('[Contexto]\nHora local: 10:00.\n\nCarlos: O que você sabe fazer?')).toBe('O que você sabe fazer?')
    expect(userUtteranceOfTurnItem('Me conta uma curiosidade.')).toBe('Me conta uma curiosidade.')
    expect(userUtteranceOfTurnItem('[Contexto] Só contexto.')).toBe('')
  })

  it('finds an echoed opening', () => {
    expect(isEchoOfUtterance('O que você sabe fazer?', 'O que você sabe fazer?')).toBe(true)
    const r1 = echoedOpening('Estou tentando resolver isso aqui.', 'Estou tentando resolver isso aqui. O que está dando errado?')
    expect(r1.whole).toBe(false)
    expect('Estou tentando resolver isso aqui. O que está dando errado?'.slice(r1.cut)).toBe('O que está dando errado?')
    expect(echoedOpening('O que você sabe fazer?', 'Ah, o que você sabe fazer?')).toEqual({ cut: 26, whole: true })
    expect(echoedOpening('Me conta uma curiosidade sobre o espaço.', 'No espaço não existe som.')).toEqual({ cut: 0, whole: false })
    expect(echoedOpening('Qual é a capital da Austrália?', 'A capital da Austrália é Canberra.').cut).toBe(0)
  })

  it('removes Ashy addressing herself', () => {
    expect(removeSelfVocative('Oi, Ashy! Tudo bem?')).toBe('Oi! Tudo bem?')
    expect(removeSelfVocative('Boa noite, Ashy!')).toBe('Boa noite!')
    expect(removeSelfVocative('Vai ser um desafio, mas não se desanime, Ashy.')).toBe('Vai ser um desafio, mas não se desanime.')
    expect(removeSelfVocative('Eu sou a Ashy, sua companheira.')).toBe('Eu sou a Ashy, sua companheira.')
    expect(removeSelfVocative('Tudo bem, Carlos!')).toBe('Tudo bem, Carlos!')
  })
})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function instantTts() {
  return vi.fn(
    async (_text: string): Promise<CallSynthesizeResult> => ({
      pcmBase64: int16ToBase64(new Int16Array(240).fill(1)),
      sampleRate: 24000,
      durationMs: 10,
      latencyMs: 1,
    }),
  )
}

async function connected(conversationGuard?: boolean) {
  const server = createFakeRealtimeServer()
  const synthesize = instantTts()
  const session = createLlamaCppHybridSession({
    baseUrl: 'http://127.0.0.1:9999',
    synthesize,
    webSocketFactory: server.factory,
    ...(conversationGuard !== undefined ? { conversationGuard } : {}),
  })
  const events: Array<{ type: keyof VoiceSessionEventMap; payload: any }> = []
  for (const type of ['response_started', 'response_text', 'response_done'] as const) {
    session.on(type, (payload) => events.push({ type, payload }))
  }
  const p = session.connect({ instructions: TEST_INSTRUCTIONS })
  await flush(5)
  await p
  return { server, session, synthesize, events }
}

describe('hybrid session conversation guard', () => {
  it('drops an echoed first sentence before TTS and reports only what is spoken', async () => {
    const { server, session, synthesize, events } = await connected()
    session.submitUserText('[Contexto] Hora local: 10:00.\n\nCarlos: O que você sabe fazer?')
    server.streamResponse(server.last, { text: ['O que você ', 'sabe fazer? ', 'Eu converso, conto curiosidades e te ajudo a pensar.'] })
    await flush(8)
    const spoken = synthesize.mock.calls.map((c) => c[0]).join(' ')
    expect(spoken).not.toMatch(/sabe fazer/)
    expect(spoken).toMatch(/Eu converso/)
    const done = events.find((e) => e.type === 'response_done')!
    expect(done.payload.text).toBe('Eu converso, conto curiosidades e te ajudo a pensar.')
    expect(events.filter((e) => e.type === 'response_started')).toHaveLength(1)
  })

  it('regenerates a pure echo once, with a private nudge, emitting a single response', async () => {
    const { server, session, synthesize, events } = await connected()
    session.submitUserText('Carlos: O que você sabe fazer?')
    server.streamResponse(server.last, { text: ['O que você sabe fazer?'] })
    await flush(5)
    const sent = server.last.sent.map((m) => JSON.stringify(m))
    expect(sent.some((m) => m.includes('Você só repetiu a fala do usuário'))).toBe(true)
    expect(HYBRID_ECHO_RETRY_CONTEXT).toMatch(/^\[Contexto\]/)
    expect(events).toHaveLength(0)
    expect(synthesize).not.toHaveBeenCalled()
    server.streamResponse(server.last, { text: ['Eu sei conversar e contar histórias.'] })
    await flush(8)
    expect(events.filter((e) => e.type === 'response_started')).toHaveLength(1)
    expect(events.find((e) => e.type === 'response_done')!.payload.text).toBe('Eu sei conversar e contar histórias.')
  })

  it('a second pure echo is not retried again (nothing left to say → empty response)', async () => {
    const { server, session, events } = await connected()
    session.submitUserText('Carlos: O que você sabe fazer?')
    server.streamResponse(server.last, { text: ['O que você sabe fazer?'] })
    await flush(5)
    server.streamResponse(server.last, { text: ['O que você sabe fazer?'] })
    await flush(8)
    const retries = server.last.sent.filter((m) => JSON.stringify(m).includes('Você só repetiu')).length
    expect(retries).toBe(1)
    expect(events.filter((e) => e.type === 'response_done')).toHaveLength(1)
  })

  it('never says "Ashy" to the user', async () => {
    const { server, session, synthesize, events } = await connected()
    session.submitUserText('Carlos: Oi, Ashy!')
    server.streamResponse(server.last, { text: ['Oi, Ashy! ', 'Tudo bem com você?'] })
    await flush(8)
    expect(synthesize.mock.calls.map((c) => c[0]).join(' ')).not.toMatch(/Ashy/)
    expect(events.find((e) => e.type === 'response_done')!.payload.text).toBe('Oi! Tudo bem com você?')
  })

  it('conversationGuard:false keeps the raw behaviour', async () => {
    const { server, session, events } = await connected(false)
    session.submitUserText('Carlos: O que você sabe fazer?')
    server.streamResponse(server.last, { text: ['O que você sabe fazer?'] })
    await flush(8)
    expect(events.find((e) => e.type === 'response_done')!.payload.text).toBe('O que você sabe fazer?')
  })
})
