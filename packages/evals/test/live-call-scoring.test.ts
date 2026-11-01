import { describe, expect, it } from 'vitest'
import {
  LIVE_EVAL_SCENARIOS,
  formatLiveEvalTable,
  getLiveEvalScenarios,
  repeatSimilarity,
  scoreLiveConversation,
  scoreLiveTurn,
} from '../src/live-call'

describe('live-call conversation scorer', () => {
  it('flags the 2026-11-01 greeting loop: repeats, greeting again, off-topic', () => {
    const scenario = getLiveEvalScenarios(['user-failing-seq'])[0]!
    const loop = 'Olá, Carlos! Tudo bem. Como posso te ajudar hoje?'
    const s = scoreLiveConversation({ scenario, backend: 'realtime', replies: scenario.turns.map(() => loop), userName: 'Carlos' })
    expect(s.turns[0]!.pass).toBe(true)
    for (const t of s.turns.slice(1)) {
      expect(t.flags).toContain('repeat')
      expect(t.flags).toContain('greeting_again')
    }
    expect(s.counts.off_topic).toBe(3)
    expect(s.passRate).toBeCloseTo(0.2)
  })

  it('flags echoes, wrong name, leaks, recall misses and runaway length', () => {
    const turn = { user: 'O que você sabe fazer?' }
    expect(scoreLiveTurn({ index: 2, turn, reply: 'O que você sabe fazer?', previousReplies: [] }).flags).toContain('echo')
    expect(scoreLiveTurn({ index: 1, turn: { user: 'Oi' }, reply: 'Tudo bem, Ashy! E você?', previousReplies: [] }).flags).toContain('wrong_name')
    expect(
      scoreLiveTurn({ index: 1, turn: { user: 'Oi' }, reply: '[Contexto] Hora local: 10:00. Carlos: Oi', previousReplies: [] }).flags,
    ).toContain('leak')
    expect(
      scoreLiveTurn({ index: 4, turn: { user: 'Qual é o nome do meu gato?', recallAny: ['Biscoito'] }, reply: 'Não sei, me conta!', previousReplies: [] })
        .flags,
    ).toContain('recall_miss')
    expect(scoreLiveTurn({ index: 1, turn: { user: 'x' }, reply: 'a '.repeat(300), previousReplies: [] }).flags).toContain('too_long')
    expect(scoreLiveTurn({ index: 1, turn: { user: 'x' }, reply: '', previousReplies: [] }).flags).toEqual(['empty'])
  })

  it('accepts good answers', () => {
    const good = scoreLiveTurn({
      index: 3,
      turn: { user: 'Qual é a capital da Austrália?', expectAny: ['Canberra'] },
      reply: 'A capital da Austrália é Canberra, não Sydney!',
      previousReplies: ['Oi, Carlos! Que bom te ouvir.'],
      userName: 'Carlos',
    })
    expect(good.flags).toEqual([])
    const recall = scoreLiveTurn({
      index: 4,
      turn: { user: 'Qual é o nome do meu gato?', recallAny: ['Biscoito'] },
      reply: 'O nome do seu gato é Biscoito, né?',
      previousReplies: [],
    })
    expect(recall.pass).toBe(true)
  })

  it('repeat similarity: identical / same tail = repeat, short follow-up of a long story ≠ repeat', () => {
    expect(repeatSimilarity('Olá, Carlos! Tudo bem.', 'Olá, Carlos! Tudo bem.')).toBe(1)
    expect(
      repeatSimilarity('De nada! Vai chover amanhã e você vai ao dentista?', 'Boa! Vai chover amanhã e você vai ao dentista?'),
    ).toBe(1)
    expect(
      repeatSimilarity(
        'Ele se chama Fênix.',
        'Imagina um dragão chamado Fênix que vive numa caverna nas montanhas e se chama Fênix porque brilha muito.',
      ),
    ).toBeLessThan(0.75)
  })

  it('ships the required pt-BR scenarios and a table', () => {
    const ids = LIVE_EVAL_SCENARIOS.map((s) => s.id)
    for (const id of ['user-failing-seq', 'poisoned-store', 'small-talk', 'questions', 'recall-in-call', 'recall-across-calls', 'long-15', 'interruption']) {
      expect(ids).toContain(id)
    }
    expect(LIVE_EVAL_SCENARIOS.find((s) => s.id === 'long-15')!.turns).toHaveLength(15)
    const scenario = getLiveEvalScenarios(['questions'])[0]!
    const table = formatLiveEvalTable([scoreLiveConversation({ scenario, backend: 'hybrid', replies: [] })])
    expect(table.split('\n')[0]).toMatch(/backend.*scenario.*pass/)
  })
})
