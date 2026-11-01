import { describe, expect, it } from 'vitest'
import type { ChatMessageRecord } from '@ashy/shared'
import {
  conversationSimilarity,
  createAshyCortex,
  extractEpisodeDeterministic,
  extractUserUtterances,
  hasMemorableContent,
  isEchoReply,
  isGreetingOnlyReply,
  isPlaceholderUtterance,
  isTranscriptStyleSummary,
  startsWithGreeting,
} from '../index'

describe('conversation hygiene (2026-11-01 small-model quality)', () => {
  it('detects echoes of the user (the LFM3-2B failure) but not answers that restate the question', () => {
    expect(isEchoReply('O que você sabe fazer?', 'O que você sabe fazer?')).toBe(true)
    expect(isEchoReply('Estou tentando resolver isso aqui.', 'Estou tentando resolver isso aqui. Como posso te ajudar hoje?')).toBe(true)
    expect(
      isEchoReply('Me conta uma curiosidade sobre o espaço.', 'Olá, Carlos! Tudo bem. Me conta uma curiosidade sobre o espaço.', {
        userName: 'Carlos',
      }),
    ).toBe(true)
    expect(isEchoReply('Quanto é sete vezes oito?', 'Sete vezes oito é 56.')).toBe(false)
    expect(isEchoReply('Estou tentando resolver isso aqui.', 'Entendi! O que você está tentando resolver?')).toBe(false)
    expect(isEchoReply('Oi Ashy, tudo bem?', 'Oi Ashy, tudo bem? Estou bem, obrigado!')).toBe(true)
    expect(isEchoReply('Qual é a capital da Austrália?', 'A capital da Austrália é Canberra.')).toBe(false)
    expect(isEchoReply('Me conta uma curiosidade sobre o espaço.', 'Ah, curiosidade sobre o espaço! No espaço não existe som, porque não tem ar.')).toBe(false)
    expect(isEchoReply('Qual é o nome do meu gato?', 'O nome do seu gato é Biscoito, né?')).toBe(false)
    expect(isEchoReply('', 'qualquer coisa')).toBe(false)
  })

  it('recognises greeting openers and greeting-only replies', () => {
    expect(startsWithGreeting('Olá, Carlos! Tudo bem?')).toBe(true)
    expect(startsWithGreeting('Oi! Que bom te ouvir.')).toBe(true)
    expect(startsWithGreeting('Olhando por esse lado, faz sentido.')).toBe(false)
    expect(isGreetingOnlyReply('Olá, Carlos! Tudo bem. Como posso te ajudar hoje?', 'Carlos')).toBe(true)
    expect(isGreetingOnlyReply('Olá, Carlos! Tudo bem, obrigado por perguntar. Como posso te ajudar hoje?', 'Carlos')).toBe(true)
    expect(isGreetingOnlyReply('Oi! Tudo bem?')).toBe(true)
    expect(isGreetingOnlyReply('Olá, Carlos! No espaço não existe som, porque não tem ar para propagar.', 'Carlos')).toBe(false)
    expect(isGreetingOnlyReply('A capital da Austrália é Canberra.')).toBe(false)
  })

  it('flags placeholders and keeps only memorable user statements', () => {
    expect(isPlaceholderUtterance('[Mensagem de voz Omni]')).toBe(true)
    expect(isPlaceholderUtterance('ashy-omni-turn-rev-1')).toBe(true)
    expect(isPlaceholderUtterance('...')).toBe(true)
    expect(isPlaceholderUtterance('Meu gato se chama Biscoito.')).toBe(false)
    expect(hasMemorableContent('Meu gato se chama Biscoito.')).toBe(true)
    expect(hasMemorableContent('Hoje eu comecei a aprender violão.')).toBe(true)
    expect(hasMemorableContent('Olá.')).toBe(false)
    expect(hasMemorableContent('Não sei isso, Carlos.')).toBe(false)
    expect(hasMemorableContent('Oi Ashy, tudo bem?')).toBe(false)
  })

  it('extracts only the user side of an episode', () => {
    expect(
      extractUserUtterances({
        summary: 'Usuário: Olá. | Ashy: Olá, Carlos!',
        content: 'Usuário: Olá.\nAshy: Olá, Carlos! Tudo bem.\nUsuário: Meu gato se chama Biscoito.\nAshy: Que fofo!',
      }),
    ).toEqual(['Olá.', 'Meu gato se chama Biscoito.'])
    expect(extractUserUtterances({ summary: 'Usuário: Eu moro em Recife | Ashy: Que legal!', content: '' })).toEqual([
      'Eu moro em Recife',
    ])
    expect(extractUserUtterances({ summary: 'Carlos contou que adotou um gato.', content: '' })).toEqual([])
    expect(isTranscriptStyleSummary('Usuário: x | Ashy: y')).toBe(true)
    expect(isTranscriptStyleSummary('Carlos contou que adotou um gato.')).toBe(false)
    expect(conversationSimilarity('Olá, Carlos!', 'olá carlos')).toBe(1)
  })
})

describe('indexTurnMemory hygiene', () => {
  it('indexes the user side only when the caller passes no assistant text', () => {
    const cortex = createAshyCortex({ dbPath: ':memory:' })
    const res = cortex.indexTurnMemory({
      turnId: 't1',
      userText: 'Hoje eu comecei a aprender violão com um amigo do trabalho.',
      assistantText: '',
      emotion: 'neutral',
      now: 1_000,
    })
    expect(res.episodeCreated).toBe(true)
    const ep = cortex.db.listEpisodicMemories().find((e) => e.id === 'ep-turn-t1')!
    expect(ep.summary).toBe('Usuário: Hoje eu comecei a aprender violão com um amigo do trabalho.')
    expect(ep.content).not.toContain('Ashy:')
  })

  it('never indexes placeholder transcripts', () => {
    const cortex = createAshyCortex({ dbPath: ':memory:' })
    const res = cortex.indexTurnMemory({ turnId: 't2', userText: '[Mensagem de voz Omni]', assistantText: 'Oi!', emotion: 'neutral', now: 1_000 })
    expect(res.episodeCreated).toBe(false)
  })

  it('extracts named relations (pets/family), city and likes as user facts', () => {
    const cortex = createAshyCortex({ dbPath: ':memory:' })
    cortex.indexTurnMemory({ turnId: 'a', userText: 'Meu gato se chama Biscoito.', assistantText: '', emotion: 'neutral', now: 1_000 })
    cortex.indexTurnMemory({ turnId: 'b', userText: 'O nome da minha irmã é Ana Paula.', assistantText: '', emotion: 'neutral', now: 2_000 })
    cortex.indexTurnMemory({ turnId: 'c', userText: 'Eu moro em Belo Horizonte, faz frio aqui.', assistantText: '', emotion: 'neutral', now: 3_000 })
    cortex.indexTurnMemory({ turnId: 'd', userText: 'Eu curto rock dos anos oitenta.', assistantText: '', emotion: 'neutral', now: 4_000 })
    cortex.indexTurnMemory({ turnId: 'e', userText: 'Eu gosto de você, Ashy.', assistantText: '', emotion: 'neutral', now: 5_000 })
    const facts = cortex.db.listSemanticFacts({ activeOnly: true }).map((f) => [f.predicate, f.object])
    expect(facts).toContainEqual(['named:gato', 'Biscoito'])
    expect(facts).toContainEqual(['named:irmã', 'Ana Paula'])
    expect(facts).toContainEqual(['lives_in', 'Belo Horizonte'])
    expect(facts).toContainEqual(['likes:rock-dos-anos-oitenta', 'rock dos anos oitenta'])
    expect(facts.some(([p, o]) => String(p).startsWith('likes') && /voc/i.test(String(o)))).toBe(false)
    // A new name for the same relation replaces the old one.
    cortex.indexTurnMemory({ turnId: 'f', userText: 'Meu gato se chama Paçoca agora.', assistantText: '', emotion: 'neutral', now: 6_000 })
    const cat = cortex.db.listSemanticFacts({ activeOnly: true }).filter((f) => f.predicate === 'named:gato')
    expect(cat.map((f) => f.object)).toEqual(['Paçoca'])
    // The fact turn also creates an episode even though the sentence is short.
    expect(cortex.db.listEpisodicMemories().some((e) => e.id === 'ep-turn-a')).toBe(true)
  })
})

describe('deterministic episode extraction hygiene', () => {
  const msg = (id: string, role: 'user' | 'assistant', content: string, createdAt: number): ChatMessageRecord =>
    ({ id, sessionId: 's', role, content, createdAt, emotion: 'neutral' }) as ChatMessageRecord

  it('does not pair the user with an echo / greeting-only reply', () => {
    const out = extractEpisodeDeterministic('ep-x', [
      msg('m1', 'user', 'Me conta uma curiosidade sobre o espaço.', 1),
      msg('m2', 'assistant', 'Me conta uma curiosidade sobre o espaço.', 2),
      msg('m3', 'user', 'Estou tentando resolver um bug no meu projeto de jogo.', 3),
      msg('m4', 'assistant', 'Olá, Carlos! Tudo bem. Como posso te ajudar hoje?', 4),
    ])
    expect(out.episode.summary).not.toContain('Ashy:')
    expect(out.episode.content).not.toContain('Ashy: Me conta')
    expect(out.episode.content).not.toContain('Como posso te ajudar')
    expect(out.episode.content).toContain('Usuário: Estou tentando resolver um bug')
  })

  it('keeps a real reply', () => {
    const out = extractEpisodeDeterministic('ep-y', [
      msg('m1', 'user', 'Estou tentando resolver um bug no meu projeto de jogo.', 1),
      msg('m2', 'assistant', 'Qual erro aparece quando você roda o jogo?', 2),
    ])
    expect(out.episode.summary).toContain('Ashy: Qual erro aparece')
  })
})

describe('poisoned legacy memories are skipped at retrieval (non-destructive)', () => {
  it('isPoisonedTranscriptMemory', async () => {
    const { isPoisonedTranscriptMemory } = await import('../index')
    expect(isPoisonedTranscriptMemory({ summary: 'Usuário: Olá. | Ashy: Olá, Carlos! Tudo bem. Como posso te ajudar hoje?' })).toBe(true)
    expect(isPoisonedTranscriptMemory({ summary: 'Usuário: O que você sabe fazer? | Ashy: O que você sabe fazer?' })).toBe(true)
    expect(isPoisonedTranscriptMemory({ summary: 'Usuário: Meu gato se chama Biscoito. | Ashy: Que fofo! O Biscoito tem bom gosto.' })).toBe(false)
    expect(isPoisonedTranscriptMemory({ summary: 'Usuário: Meu gato se chama Biscoito.' })).toBe(false)
    expect(isPoisonedTranscriptMemory({ summary: 'Carlos adotou um gato.' })).toBe(false)
  })

  it('the text-chat prompt never shows them, and they stay in the store', () => {
    const cortex = createAshyCortex({ dbPath: ':memory:' })
    const base = { createdAt: 1, lastReviewedAt: 1, stability: 6, difficulty: 4.5, surprise: 0.4, isFlashbulb: false, approvalStatus: 'approved' as const }
    cortex.db.upsertEpisodicMemory({
      ...base,
      id: 'ep-session-poison',
      title: 'Me conta uma curiosidade sobre o espaço.',
      summary: 'Usuário: Me conta uma curiosidade sobre o espaço. | Ashy: Me conta uma curiosidade sobre o espaço.',
      content: 'Usuário: Me conta uma curiosidade sobre o espaço.\nAshy: Me conta uma curiosidade sobre o espaço.',
      tags: ['espaco'],
    })
    cortex.db.upsertEpisodicMemory({
      ...base,
      id: 'ep-session-good',
      title: 'Curiosidade sobre o espaço e Marte',
      summary: 'Usuário: Eu adoro curiosidades sobre o espaço, principalmente Marte. | Ashy: Marte tem o maior vulcão do sistema solar.',
      content: 'Usuário: Eu adoro curiosidades sobre o espaço, principalmente Marte.\nAshy: Marte tem o maior vulcão do sistema solar.',
      tags: ['espaco', 'marte'],
    })
    const out = cortex.compileTurnPrompt({ userMessage: 'Me conta uma curiosidade sobre o espaço.', topKMemories: 4 }, { sideEffects: false })
    const text = JSON.stringify(out)
    expect(text).not.toContain('ep-session-poison')
    expect(cortex.db.listEpisodicMemories().map((m) => m.id)).toContain('ep-session-poison')
  })
})
