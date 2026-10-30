import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeCosineSimilarity, computeCosineSimilarity128 } from '@ashy/llm'
import {
  classifyEpisodeCategory,
  classifyEpisodeTraitDelta,
   computeMotifRelevance,
  createAshyCortex,
  detectCrossEpisodeLinks,
  detectEpisodeBoundary,
  evaluateTurnMemoryUsage,
  extractEpisodeDeterministic,
  extractStructuredEpisode,
  isSubstantiveTopicMessage,
  isTrivialConversationTurn,
  rankEpisodicMemories,
} from '@ashy/cortex'
import type { ChatMessageRecord, EpisodicMemory } from '@ashy/shared'
import { createAshyHostKernel, DEFAULT_DREAM_IDLE_TIMEOUT_MS } from '../host/kernel'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

const tempDirs: string[] = []
const activeKernels: Array<{ stop(): Promise<void> }> = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-p83-cortex-'))
  tempDirs.push(dir)
  return dir
}

function makeMsg(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  createdAt: number,
  sessionId = 'session-p83',
): ChatMessageRecord {
  return {
    id,
    sessionId,
    role,
    content,
    rawContent: content,
    emotion: 'neutral',
    markersJson: '[]',
    createdAt,
    consolidatedEpisodeId: null,
  }
}

afterEach(async () => {
  while (activeKernels.length > 0) {
    await activeKernels.pop()!.stop()
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Phase 8.3 — Selective Memory, Embeddings Any-Dim, DreamWorker & Host Kernel Wiring', () => {
  it('1. computeCosineSimilarity and computeCosineSimilarity128 support arbitrary matching vector dimensions (384-d, 1536-d)', () => {
    const vec384A = Array.from({ length: 384 }, (_, i) => (i % 2 === 0 ? 1 : 0.5))
    const vec384B = Array.from({ length: 384 }, (_, i) => (i % 2 === 0 ? 1 : 0.5))
    const vec1536A = Array.from({ length: 1536 }, (_, i) => Math.sin(i + 1))
    const vec1536B = Array.from({ length: 1536 }, (_, i) => -Math.sin(i + 1))

    expect(computeCosineSimilarity).toBe(computeCosineSimilarity128)
    expect(computeCosineSimilarity(vec384A, vec384B)).toBeCloseTo(1, 5)
    expect(computeCosineSimilarity128(vec1536A, vec1536B)).toBeCloseTo(-1, 5)
    expect(computeCosineSimilarity([], [])).toBe(0)
    expect(computeCosineSimilarity(vec384A, vec1536A)).toBe(0)
  })

  it('2. isSubstantiveTopicMessage and detectEpisodeBoundary ignore casual chitchat for topic_shift while triggering on real substantive topic changes', () => {
    const casualTurns = [
      'opa',
      'oi',
      'nossa, grossa',
      'que boca suja rapaz?',
      'nao apareceu nenhuma tool pra vc ai?',
      'entendii, e vc cria memórias?',
      'nahh, só quero saber o que vc achou da ideia',
      'coloquei umas coisas novas pra vc',
      'opa, to fazendo um corpo pra tu',
      'sou o dev mesmo kkkkkkk, mas não sabe meu nome?',
    ]

    for (const text of casualTurns) {
      expect(isSubstantiveTopicMessage(text), `Expected false for "${text}"`).toBe(false)
    }

    const t0 = Date.UTC(2026, 9, 30, 14, 0, 0)
    const casualMessages: ChatMessageRecord[] = [
      makeMsg('c1', 'user', 'opa', t0),
      makeMsg('c2', 'assistant', 'E aí! Tudo certo?', t0 + 5_000),
      makeMsg('c3', 'user', 'nossa, grossa', t0 + 20_000),
      makeMsg('c4', 'assistant', 'Calma, foi só uma resposta rápida.', t0 + 25_000),
      makeMsg('c5', 'user', 'que boca suja rapaz?', t0 + 40_000),
      makeMsg('c6', 'assistant', 'Haha nada disso.', t0 + 45_000),
      makeMsg('c7', 'user', 'nao apareceu nenhuma tool pra vc ai?', t0 + 60_000),
      makeMsg('c8', 'assistant', 'Por enquanto nenhuma tool extra.', t0 + 65_000),
    ]

    const casualBoundary = detectEpisodeBoundary(casualMessages, {
      nowMs: t0 + 2 * MINUTE_MS,
    })
    expect(casualBoundary.shouldConsolidate).toBe(false)
    expect(casualBoundary.reason).toBeNull()

    // Two consecutive substantive messages on completely different topics still trigger topic_shift
    const substantiveMessages: ChatMessageRecord[] = [
      makeMsg(
        's1',
        'user',
        'Estou otimizando as queries do banco SQLite e o índice FTS5 no backend.',
        t0,
      ),
      makeMsg(
        's2',
        'assistant',
        'O FTS5 com BM25 no SQLite fica ótimo para busca híbrida.',
        t0 + 10_000,
      ),
      makeMsg(
        's3',
        'user',
        'Comprei pão, queijo e leite fresco na padaria hoje para o almoço.',
        t0 + 2 * MINUTE_MS,
      ),
      makeMsg(
        's4',
        'assistant',
        'Pão quentinho da padaria salva qualquer tarde.',
        t0 + 2 * MINUTE_MS + 10_000,
      ),
    ]

    expect(isSubstantiveTopicMessage(substantiveMessages[0]!.content)).toBe(true)
    expect(isSubstantiveTopicMessage(substantiveMessages[2]!.content)).toBe(true)

    const substantiveBoundary = detectEpisodeBoundary(substantiveMessages, {
      nowMs: t0 + 3 * MINUTE_MS,
    })
    expect(substantiveBoundary.shouldConsolidate).toBe(true)
    expect(substantiveBoundary.reason).toBe('topic_shift')
  })

  it('3. extractEpisodeDeterministic and extractStructuredEpisode classify shouldSaveEpisode, EpisodeMemoryCategory, and category:<cat> tags accurately', async () => {
    const t0 = Date.UTC(2026, 9, 30, 15, 0, 0)

    const trivialBatch: ChatMessageRecord[] = [
      makeMsg('t1', 'user', 'opa', t0),
      makeMsg('t2', 'assistant', 'Oi! Como estão as coisas?', t0 + 5_000),
      makeMsg('t3', 'user', 'nossa, grossa', t0 + 15_000),
      makeMsg('t4', 'assistant', 'Oxe, só dei oi!', t0 + 20_000),
      makeMsg('t5', 'user', 'que boca suja rapaz?', t0 + 30_000),
    ]

    for (const m of trivialBatch.filter((x) => x.role === 'user')) {
      expect(isTrivialConversationTurn(m.content)).toBe(true)
    }

    const trivialExtracted = extractEpisodeDeterministic('ep-trivial-1', trivialBatch, t0 + MINUTE_MS)
    expect(trivialExtracted.shouldSaveEpisode).toBe(false)
    expect(trivialExtracted.category).toBe('momentos')
    expect(trivialExtracted.episode.tags).toContain('category:momentos')

    // Planos category
    const planBatch: ChatMessageRecord[] = [
      makeMsg(
        'p1',
        'user',
        'Amanhã tenho deploy do protótipo e preciso lembrar de revisar o roadmap.',
        t0,
      ),
      makeMsg('p2', 'assistant', 'Combinado, te lembro do deploy amanhã.', t0 + 5_000),
    ]
    const planExtracted = extractEpisodeDeterministic('ep-plan-1', planBatch, t0 + MINUTE_MS)
    expect(planExtracted.shouldSaveEpisode).toBe(true)
    expect(planExtracted.category).toBe('planos')
    expect(planExtracted.episode.tags).toContain('category:planos')

    // Sobre você category
    const aboutBatch: ChatMessageRecord[] = [
      makeMsg(
        'u1',
        'user',
        'Meu nome é Marina e eu prefiro programar usando Neovim com TypeScript.',
        t0,
      ),
      makeMsg('u2', 'assistant', 'Prazer, Marina! Neovim com TypeScript é excelente.', t0 + 5_000),
    ]
    const aboutExtracted = extractEpisodeDeterministic('ep-about-1', aboutBatch, t0 + MINUTE_MS)
    expect(aboutExtracted.shouldSaveEpisode).toBe(true)
    expect(aboutExtracted.category).toBe('sobre_voce')
    expect(aboutExtracted.episode.tags).toContain('category:sobre_voce')

    // Referências category
    const refBatch: ChatMessageRecord[] = [
      makeMsg(
        'r1',
        'user',
        'Esse código tá tão amaldiçoado que deve ter um fantasma no backend.',
        t0,
      ),
      makeMsg(
        'r2',
        'assistant',
        'Eu já tava pensando em chamar um exorcista de JavaScript.',
        t0 + 5_000,
      ),
    ]
    const refExtracted = extractEpisodeDeterministic('ep-ref-1', refBatch, t0 + MINUTE_MS)
    expect(refExtracted.shouldSaveEpisode).toBe(true)
    expect(refExtracted.category).toBe('referencias')
    expect(refExtracted.episode.tags).toContain('category:referencias')

    // Structured LLM extraction normalizes shouldSaveEpisode and category
    const llmStructured = await extractStructuredEpisode({
      episodeId: 'ep-llm-cat',
      messages: planBatch,
      nowMs: t0 + MINUTE_MS,
      generateJsonFn: async () =>
        JSON.stringify({
          shouldSaveEpisode: true,
          category: 'planos',
          episode: {
            title: 'Planejamento do Protótipo',
            summary: 'Definimos os próximos passos do protótipo para amanhã.',
            tags: ['prototipo', 'roadmap'],
            surprise: 0.55,
            isFlashbulb: false,
          },
        }),
    })
    expect(llmStructured.shouldSaveEpisode).toBe(true)
    expect(llmStructured.category).toBe('planos')
    expect(llmStructured.episode.tags).toContain('category:planos')

    expect(
      classifyEpisodeCategory({
        userText: 'Conversa marcante sobre arquitetura na madrugada',
        tags: ['arquitetura'],
        factsCount: 0,
        motifsCount: 0,
        intentsCount: 0,
      }),
    ).toBe('momentos')
  })

  it('4. AshyCortex.indexTurnMemory skips ep-turn-* for trivial banter and consolidateSessionMemories (force: false) skips saving noise episodes', async () => {
    const cortex = createAshyCortex({ inMemory: true })
    const sessionId = 'session-selective'
    const t0 = Date.UTC(2026, 9, 30, 16, 0, 0)

    cortex.createChatSession({
      id: sessionId,
      title: 'Conversa Rápida',
      startedAt: t0,
    })

    const noisyInputs = [
      'opa',
      'nossa, grossa',
      'que boca suja rapaz?',
      'nao apareceu nenhuma tool pra vc ai?',
      'entendii, e vc cria memórias?',
      'nahh, só quero saber o que vc achou da ideia',
      'coloquei umas coisas novas pra vc',
      'opa, to fazendo um corpo pra tu',
      'sou o dev mesmo kkkkkkk, mas não sabe meu nome?',
    ]

    noisyInputs.forEach((userText, idx) => {
      const turnTime = t0 + idx * 10_000
      cortex.appendChatMessage(
        makeMsg(`u-noise-${idx}`, 'user', userText, turnTime, sessionId),
      )
      cortex.appendChatMessage(
        makeMsg(`a-noise-${idx}`, 'assistant', 'Resposta curta da Ashy.', turnTime + 2_000, sessionId),
      )
      const indexed = cortex.indexTurnMemory({
        turnId: `turn-noise-${idx}`,
        userText,
        assistantText: 'Resposta curta da Ashy.',
        emotion: 'neutral',
        now: turnTime + 2_000,
      })
      expect(indexed.episodeCreated, `Expected episodeCreated=false for "${userText}"`).toBe(false)
      expect(indexed.factsCreated).toBe(0)
    })

    expect(cortex.db.listEpisodicMemories()).toHaveLength(0)

    // Consolidating with force: false after > 30m idle gap on pure trivial banter marks messages consolidated without creating an episode
    const consResult = await cortex.consolidateSessionMemories({
      sessionId,
      nowMs: t0 + 45 * MINUTE_MS,
      force: false,
    })

    expect(consResult.consolidated).toBe(false)
    expect(consResult.episode).toBeNull()
    expect(cortex.db.listEpisodicMemories()).toHaveLength(0)
    expect(cortex.db.listUnconsolidatedChatMessages(sessionId)).toHaveLength(0)

    // Substantive turn DOES create ep-turn-* with category tag
    const substantiveTurn = cortex.indexTurnMemory({
      turnId: 'turn-substantive-1',
      userText: 'Estou refatorando o módulo de persistência SQLite com índices FTS5 no backend.',
      assistantText: 'Excelente! O FTS5 deixa a busca híbrida muito rápida.',
      emotion: 'neutral',
      now: t0 + 50 * MINUTE_MS,
    })
    expect(substantiveTurn.episodeCreated).toBe(true)
    const draftEp = cortex.db.getEpisodicMemory('ep-turn-turn-substantive-1')
    expect(draftEp).not.toBeNull()
    expect(draftEp?.tags.some((t) => t.startsWith('category:'))).toBe(true)

    cortex.close()
  })

  it('5. classifyEpisodeTraitDelta supports chaosEnergy and 384-d embeddings work across DreamWorker, InsideJokeEngine, and FsrsTurnLoop (with domain words un-stopworded)', () => {
    const nowMs = Date.UTC(2026, 9, 30, 18, 0, 0)

    const chaosEp: EpisodicMemory = {
      id: 'ep-chaos-1',
      title: 'Sessão de improviso e caos criativo',
      summary: 'Brincamos de travessura e zoeira no meio do experimento.',
      content: 'Puro caos e improviso divertido no estúdio.',
      createdAt: nowMs - DAY_MS,
      lastReviewedAt: nowMs - DAY_MS,
      stability: 5,
      difficulty: 4,
      surprise: 0.7,
      isFlashbulb: false,
      tags: ['chaos', 'playful', 'improv'],
      approvalStatus: 'approved',
    }

    const delta = classifyEpisodeTraitDelta(chaosEp)
    expect(delta.trait).toBe('chaosEnergy')
    expect(delta.delta).toBeGreaterThan(0)

    // 384-d embeddings in detectCrossEpisodeLinks & computeMotifRelevance
    const vec384 = Array.from({ length: 384 }, (_, i) => (i < 20 ? 0.8 : 0.05))
    const ep384A: EpisodicMemory = {
      ...chaosEp,
      id: 'ep-384-a',
      tags: ['custom_tag_a'],
      embedding: vec384,
    }
    const ep384B: EpisodicMemory = {
      ...chaosEp,
      id: 'ep-384-b',
      tags: ['custom_tag_b'],
      embedding: vec384,
    }

    const links = detectCrossEpisodeLinks([ep384A, ep384B])
    expect(links).toHaveLength(1)
    expect(links[0]!.similarity).toBeGreaterThanOrEqual(0.95)

    const motifRel = computeMotifRelevance(
      {
        motif: 'improviso caótico',
        triggerCues: ['outro_gatilho'],
        embedding: vec384,
      },
      'Contexto com vetor 384d',
      vec384,
    )
    expect(motifRel.relevanceScore).toBeGreaterThanOrEqual(0.8)

    // evaluateTurnMemoryUsage recognizes 'banco', 'codigo', 'projeto', 'local' as salient domain words
    const domainEp: EpisodicMemory = {
      id: 'ep-domain-words',
      title: 'Banco e código do projeto local',
      summary: 'Ajustamos a configuração quando configuramos o banco local do projeto',
      content: 'Banco código projeto local.',
      createdAt: nowMs - DAY_MS,
      lastReviewedAt: nowMs - DAY_MS,
      stability: 4,
      difficulty: 5,
      surprise: 0.5,
      isFlashbulb: false,
      tags: ['banco', 'codigo', 'projeto', 'local'],
      embedding: vec384,
      approvalStatus: 'approved',
    }

    const ranked = rankEpisodicMemories([domainEp], {
      text: 'Como está o banco e o código do projeto local?',
      nowMs,
    })

    const usageEval = evaluateTurnMemoryUsage({
      retrievedMemories: ranked,
      assistantText: 'O banco e o código do projeto local estão ajustados na configuração!',
      nowMs,
    })

    expect(usageEval.reviewedMemories).toHaveLength(1)
    expect(usageEval.reviewedMemories[0]!.usageScore).toBeGreaterThanOrEqual(0.45)
    expect(usageEval.reviewedMemories[0]!.rating).toBe('easy')
  })

  it('6. createAshyHostKernel exports DEFAULT_DREAM_IDLE_TIMEOUT_MS and wires resolveDreamJsonGenerator() to enrich DreamJournalEntry in 1st person', async () => {
    expect(DEFAULT_DREAM_IDLE_TIMEOUT_MS).toBe(5 * 60 * 1000)

    const dir = makeTempDir()
    const firstPersonSummary =
      'Hoje conectei nossas conversas da madrugada e percebi o quanto evoluí em acolhimento e curiosidade técnica ao seu lado.'

    const mockFetch = vi.fn(async () => {
      const sse = [
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: JSON.stringify({ summary: firstPersonSummary }),
              },
            },
          ],
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    activeKernels.push(kernel)

    await kernel.completeOnboarding({
      userName: 'Marina',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-dreamjsonkey1234',
      },
    })

    await kernel.seedDemoFixtures()

    const { snapshot } = await kernel.runDreamReflection({ force: true })
    expect(mockFetch).toHaveBeenCalled()
    const journalEntries = snapshot.memories.dreamJournalEntries ?? []
    expect(journalEntries.length).toBeGreaterThanOrEqual(1)
    expect(journalEntries[0]!.summary).toBe(firstPersonSummary)
  })

  it('7. [Red-Team #1, #2, #3, #4, #9] skips saving trivial episodes even with force: true or hallucinated LLM shouldSaveEpisode: true, and generates LLM proactive replies in kernel.evaluateAttentionInitiative', async () => {
    const dir = makeTempDir()
    const cortex = createAshyCortex({
      filePath: path.join(dir, 'redteam-8-3.db'),
    })
    activeKernels.push({ stop: async () => cortex.close() })

    const sessionId = 'session-redteam-trivial'
    cortex.createChatSession({
      id: sessionId,
      title: 'Conversa Casual',
      startedAt: 1_000,
    })

    // Longer casual greeting (>= 40 chars) that previously bypassed isTrivialConversationTurn
    const casualLongGreeting = 'bom dia amigo, tudo tranquilo contigo hoje?'
    expect(isTrivialConversationTurn(casualLongGreeting)).toBe(true)
    expect(isSubstantiveTopicMessage(casualLongGreeting)).toBe(false)

    cortex.appendChatMessage({
      id: 'rt-m-1',
      sessionId,
      role: 'user',
      content: casualLongGreeting,
      rawContent: casualLongGreeting,
      emotion: 'neutral',
      markersJson: '[]',
      createdAt: 1_000,
    })
    cortex.appendChatMessage({
      id: 'rt-m-2',
      sessionId,
      role: 'assistant',
      content: 'Bom dia! Tudo ótimo por aqui no estúdio.',
      rawContent: 'Bom dia! Tudo ótimo por aqui no estúdio.',
      emotion: 'happy',
      markersJson: '[]',
      createdAt: 2_000,
    })

    // Even if an LLM hallucinates shouldSaveEpisode: true on trivial turns with zero facts/motifs/habits/intents,
    // and even with force: true, consolidateSessionMemories must NOT persist a noise episode
    const forcedTrivialRes = await cortex.consolidateSessionMemories({
      sessionId,
      nowMs: 10_000,
      force: true,
      generateJsonFn: async () =>
        JSON.stringify({
          shouldSaveEpisode: true,
          category: 'momentos',
          episode: {
            title: 'Bom dia amigo',
            summary: 'Saudação casual de bom dia.',
            surprise: 0.2,
            isFlashbulb: false,
            tags: ['greeting'],
          },
          facts: [],
          insideJokes: [],
          habits: [],
          prospectiveIntents: [],
        }),
    })

    expect(forcedTrivialRes.consolidated).toBe(false)
    expect(forcedTrivialRes.episode).toBeNull()
    expect(cortex.db.listEpisodicMemories()).toHaveLength(0)
    expect(cortex.db.listUnconsolidatedMessages(sessionId)).toHaveLength(0)

    // Test kernel.evaluateAttentionInitiative with active LLM generating proactive reply
    const kernelDir = makeTempDir()
    const llmProactiveReply =
      'Ei Marina, lembrei que o nosso deploy da API está chegando — quer revisar o checklist comigo?'
    const mockFetch = vi.fn(async () => {
      const sse = [
        `data: ${JSON.stringify({
          choices: [{ delta: { content: llmProactiveReply } }],
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: kernelDir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    activeKernels.push(kernel)

    await kernel.completeOnboarding({
      userName: 'Marina',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-proactivekey1234',
      },
    })
    await kernel.seedDemoFixtures()

    const nowMs = Date.now()
    kernel.cortex.db.upsertProspectiveIntent({
      id: 'intent-due-rt',
      topic: 'Deploy da API em produção',
      contextCue: 'Checklist de deploy em produção',
      dueAt: nowMs - 60_000,
      status: 'pending',
      sourceEpisodeId: 'ep-flashbulb-0314',
      createdAt: nowMs - 120_000,
    })

    const record = await kernel.evaluateAttentionInitiative!({
      nowMs,
      localTimeHHMM: '14:00',
      idleMinutes: 30,
      forceDnd: false,
    })

    expect(record.decision).toBe('spoken')
    expect(record.replyText).toBe(llmProactiveReply)
    const snapAfter = await kernel.getBootstrapSnapshot()
    expect(
      snapAfter.messages.some(
        (m) => m.id === `msg-proactive-${record.id}` && m.content === llmProactiveReply,
      ),
    ).toBe(true)
    // Proactive message must NOT remain unconsolidated
    expect(
      kernel.cortex.db
        .listUnconsolidatedMessages(snapAfter.activeSession.id)
        .some((m) => m.id === `msg-proactive-${record.id}`),
    ).toBe(false)
  })

  it('8. [Ashy Self-Diagnosis] fixes multi-turn user/assistant swap in extractEpisodeDeterministic, prevents proactive echo as Usuário, deduplicates active conversationHistory from [Context], and prunes/repairs legacy corrupted episodes on boot', () => {
    // 1. Multi-turn batch: Turn 1 (gate idea) + Turn 2 (model introspection)
    // extractEpisodeDeterministic must pair Turn 1's question with Turn 1's answer (NOT Turn 2's answer!)
    const multiTurnBatch: ChatMessageRecord[] = [
      makeMsg(
        'm-u1',
        'user',
        'Implementei um novo gate de aprovação para proteger o banco de dados local.',
        1_000,
      ),
      makeMsg(
        'm-a1',
        'assistant',
        'Excelente ideia! Esse gate garante segurança total antes de qualquer escrita.',
        2_000,
      ),
      makeMsg(
        'm-u2',
        'user',
        'Qual é o modelo exato que está rodando por baixo do seu córtex agora?',
        3_000,
      ),
      makeMsg(
        'm-a2',
        'assistant',
        'Eu não tenho acesso introspectivo ao nome exato do modelo sem consultar o cofre.',
        4_000,
      ),
    ]

    const multiExtracted = extractEpisodeDeterministic('ep-multi-turn', multiTurnBatch, 5_000)
    expect(multiExtracted.episode.summary).toContain(
      'Excelente ideia! Esse gate garante segurança total',
    )
    expect(multiExtracted.episode.summary).not.toContain(
      'Eu não tenho acesso introspectivo ao nome exato do modelo',
    )

    // 2. Standalone proactive assistant message batch (zero user messages):
    // Must NEVER label Ashy's proactive message as "Usuário: ..." and must set shouldSaveEpisode = false
    const proactiveOnlyBatch: ChatMessageRecord[] = [
      makeMsg(
        'msg-proactive-1793372187126',
        'assistant',
        'Ei, lembrei do nosso deploy de madrugada!',
        10_000,
      ),
    ]
    const proactiveExtracted = extractEpisodeDeterministic(
      'ep-proactive-only',
      proactiveOnlyBatch,
      11_000,
    )
    expect(proactiveExtracted.shouldSaveEpisode).toBe(false)
    expect(proactiveExtracted.episode.summary).not.toContain(
      'Usuário: Ei, lembrei do nosso deploy',
    )

    // 3. Booting AshyCortex on a database with legacy pre-8.3 corrupted episodes:
    // - deletes `ep-*-msg-proactive-*` and episodes where Usuário echoes Ashy
    // - deletes unreferenced trivial chitchat episodes ("opa", "nahh, só quero saber...")
    // - repairs swapped multi-turn summary from full content
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'legacy-corrupted.db')
    const cortex1 = createAshyCortex({ filePath: dbPath })

    // Insert legacy corrupted proactive echo episode
    cortex1.db.upsertEpisodicMemory({
      id: 'ep-session-initial-1793372187126-msg-proactive-init-1',
      title: 'Ei, lembrei do nosso deploy!',
      summary: 'Usuário: Ei, lembrei do nosso deploy! | Ashy: Ei, lembrei do nosso deploy!',
      content: 'Ashy: Ei, lembrei do nosso deploy!',
      createdAt: 1_000,
      lastReviewedAt: 1_000,
      stability: 6,
      difficulty: 4.5,
      surprise: 0.4,
      isFlashbulb: false,
      tags: ['conversation'],
    })

    // Insert legacy trivial chitchat episode from before Phase 8.3
    cortex1.db.upsertEpisodicMemory({
      id: 'ep-session-initial-1793300000000-msg-user-opa',
      title: 'opa',
      summary: 'Usuário: opa | Ashy: Opa! Tudo certo por aqui.',
      content: 'Usuário: opa\nAshy: Opa! Tudo certo por aqui.',
      createdAt: 2_000,
      lastReviewedAt: 2_000,
      stability: 6,
      difficulty: 4.5,
      surprise: 0.4,
      isFlashbulb: false,
      tags: ['conversation'],
    })

    // Insert legacy multi-turn episode with swapped summary
    cortex1.db.upsertEpisodicMemory({
      id: 'ep-session-initial-1793305015627-msg-user-turn-1',
      title: 'Arquitetura do gate de segurança no SQLite',
      summary:
        'Usuário: Arquitetura do gate de segurança no SQLite | Ashy: Eu não tenho acesso introspectivo ao nome do modelo.',
      content: [
        'Usuário: Arquitetura do gate de segurança no SQLite',
        'Ashy: Esse gate ficou muito sólido para proteger as tabelas.',
        'Usuário: Qual modelo está rodando?',
        'Ashy: Eu não tenho acesso introspectivo ao nome do modelo.',
      ].join('\n'),
      createdAt: 3_000,
      lastReviewedAt: 3_000,
      stability: 6,
      difficulty: 4.5,
      surprise: 0.5,
      isFlashbulb: false,
      tags: ['sqlite', 'security'],
    })
    cortex1.close()

    // Re-open AshyCortex -> auto-sanitation runs on boot
    const cortex2 = createAshyCortex({ filePath: dbPath })
    activeKernels.push({ stop: async () => cortex2.close() })

    const remaining = cortex2.db.listEpisodicMemories()
    expect(
      remaining.some((e) => e.id === 'ep-session-initial-1793372187126-msg-proactive-init-1'),
    ).toBe(false)
    expect(
      remaining.some((e) => e.id === 'ep-session-initial-1793300000000-msg-user-opa'),
    ).toBe(false)

    const repaired = remaining.find(
      (e) => e.id === 'ep-session-initial-1793305015627-msg-user-turn-1',
    )
    expect(repaired).toBeDefined()
    expect(repaired?.summary).toContain('Esse gate ficou muito sólido para proteger as tabelas.')
    expect(repaired?.summary).not.toContain('Eu não tenho acesso introspectivo')

    // 4. compileTurnPrompt deduplicates episodes whose turn is already in conversationHistory
    // and includes [INTERNAL CORTEX RECALL — HOW TO READ [Context]]
    const compiled = cortex2.compileTurnPrompt({
      userMessage: 'Me fala sobre o gate de segurança no SQLite',
      conversationHistory: [
        {
          role: 'user',
          content: 'Arquitetura do gate de segurança no SQLite',
        },
        {
          role: 'assistant',
          content: 'Esse gate ficou muito sólido para proteger as tabelas.',
        },
      ],
    })
    expect(compiled.staticSystemPrompt).toContain(
      '[INTERNAL CORTEX RECALL — HOW TO READ [Context]]',
    )
    expect(compiled.userTurnContent).not.toContain(
      'ep-session-initial-1793305015627-msg-user-turn-1',
    )
  })
})
