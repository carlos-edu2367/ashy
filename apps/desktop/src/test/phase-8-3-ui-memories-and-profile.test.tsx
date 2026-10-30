// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ASHY_BASELINE_MOOD,
  ASHY_DEFAULT_TRAITS,
  DEFAULT_ASHY_VOICE_MD,
  DEFAULT_INITIATIVE_POLICY,
  DEFAULT_MEMORY_GOVERNANCE_POLICY,
  type AshyBootstrapSnapshot,
  type AshyHostBridge,
  type EpisodicMemory,
} from '@ashy/shared'
import { App } from '../App'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

function makeBaseSnapshot(
  overrides?: Partial<AshyBootstrapSnapshot>,
): AshyBootstrapSnapshot {
  const base = useAshyStore.getState()
  return {
    needsOnboarding: false,
    userProfile: {
      userName: null,
      userPronouns: null,
    },
    relationship: {
      stage: 'close_friend',
      familiarityScore: 0.5,
      trustScore: 0.6,
      totalTurns: 8,
      milestones: [],
    },
    activeSession: {
      id: 'session-test-8-3',
      title: 'Sessão Fase 8.3',
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      turnCount: 0,
      lastMessagePreview: '',
    },
    sessions: [
      {
        id: 'session-test-8-3',
        title: 'Sessão Fase 8.3',
        startedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        turnCount: 0,
        lastMessagePreview: '',
      },
    ],
    messages: [],
    providers: base.providers,
    voice: {
      content: DEFAULT_ASHY_VOICE_MD,
      diagnostics: { status: 'ok', updatedAt: 1_700_000_000_000 },
      updatedAt: 1_700_000_000_000,
    },
    affect: {
      mood: { ...ASHY_BASELINE_MOOD },
      traits: { ...ASHY_DEFAULT_TRAITS },
      dominantEmotion: 'neutral',
    },
    memories: {
      episodes: [],
      facts: [],
      jokes: [],
      habits: [],
      intents: [],
      evolutionLog: [],
      governancePolicy: { ...DEFAULT_MEMORY_GOVERNANCE_POLICY },
      crossEpisodeLinks: [],
      dreamJournalEntries: [],
      initiativePolicy: { ...DEFAULT_INITIATIVE_POLICY },
      initiativeLog: [],
    },
    runtimeDiagnostics: {
      dbMode: 'wal',
      dbPath: ':memory:',
      lastPersistenceWarning: null,
    },
    ...overrides,
  }
}

beforeEach(() => {
  resetAshyStore()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }
  if (container) {
    container.remove()
    container = null
  }
  setAshyHostBridgeForTesting(null)
  resetAshyStore()
})

describe('Phase 8.3 — Real Selective Memories UI, Zero DEMO_MEMORY_CARDS, Dynamic Trophies & Profile', () => {
  it('1. filters out transient ep-turn-* and ep-dream-* drafts and pending_review episodes from memoryCards, never injects DEMO_MEMORY_CARDS, and maps category-specific artwork, badges, featured flags, and originLabels', () => {
    const store = useAshyStore.getState()
    expect(store.memoryCards).toEqual([])

    const episodes: EpisodicMemory[] = [
      {
        id: 'ep-turn-1700000001',
        title: 'opa',
        summary: 'Usuário disse opa',
        content: 'opa',
        createdAt: 1_700_000_001_000,
        lastReviewedAt: 1_700_000_001_000,
        stability: 3,
        difficulty: 5,
        surprise: 0.2,
        isFlashbulb: false,
        tags: ['turn'],
      },
      {
        id: 'ep-dream-1700000002',
        title: 'Rascunho de sonho',
        summary: 'Síntese transitória de sonho',
        content: 'Rascunho interno do DreamWorker',
        createdAt: 1_700_000_002_000,
        lastReviewedAt: 1_700_000_002_000,
        stability: 4,
        difficulty: 4,
        surprise: 0.5,
        isFlashbulb: false,
        tags: ['dream'],
      },
      {
        id: 'ep-pending-quarantine',
        title: 'Memória em quarentena',
        summary: 'Aguardando aprovação',
        content: 'Não deve aparecer nos cards ativos',
        createdAt: 1_700_000_003_000,
        lastReviewedAt: 1_700_000_003_000,
        stability: 5,
        difficulty: 4,
        surprise: 0.9,
        isFlashbulb: true,
        tags: ['category:momentos'],
        approvalStatus: 'pending_review',
      },
      {
        id: 'ep-padre-npm-origin',
        title: 'O Exorcismo do Backend (Padre no NPM)',
        summary: 'Caçamos um bug fantasma na fila de eventos.',
        content: 'História real do banco SQLite sobre o padre no npm.',
        createdAt: 1_700_000_010_000,
        lastReviewedAt: 1_700_000_010_000,
        stability: 6.4,
        difficulty: 4.1,
        surprise: 0.78,
        isFlashbulb: false,
        tags: ['debug', 'inside_joke', 'category:referencias'],
      },
      {
        id: 'ep-real-sobre-voce',
        title: 'Preferência por TDD rigoroso',
        summary: 'Sempre escreve o teste falhando antes da implementação.',
        content: 'Fluxo RED -> GREEN -> REFACTOR documentado.',
        createdAt: 1_700_000_020_000,
        lastReviewedAt: 1_700_000_020_000,
        stability: 7.0,
        difficulty: 3.8,
        surprise: 0.55,
        isFlashbulb: false,
        tags: ['category:sobre_voce', 'work_style'],
      },
      {
        id: 'ep-real-planos',
        title: 'Lançar Fase 8.3 em Produção',
        summary: 'Meta de eliminar mocks e consolidar memórias seletivas.',
        content: 'Plano detalhado para a release.',
        createdAt: 1_700_000_030_000,
        lastReviewedAt: 1_700_000_030_000,
        stability: 8.0,
        difficulty: 3.5,
        surprise: 0.6,
        isFlashbulb: false,
        tags: ['category:planos', 'goal'],
      },
      {
        id: 'ep-real-momentos-flashbulb',
        title: 'Deploy salvo às 03:14',
        summary: 'Momento marcante na madrugada.',
        content: 'Salvamos o cluster principal a tempo.',
        createdAt: 1_700_000_040_000,
        lastReviewedAt: 1_700_000_040_000,
        stability: 14.5,
        difficulty: 3.2,
        surprise: 0.96,
        isFlashbulb: true,
        tags: ['category:momentos', 'flashbulb'],
      },
    ]

    store.applyBootstrapSnapshot(
      makeBaseSnapshot({
        memories: {
          ...makeBaseSnapshot().memories,
          episodes,
        },
      }),
    )

    const cards = useAshyStore.getState().memoryCards
    // Only the 4 permanent approved episodes should become cards
    expect(cards.map((c) => c.id)).toEqual([
      'ep-padre-npm-origin',
      'ep-real-sobre-voce',
      'ep-real-planos',
      'ep-real-momentos-flashbulb',
    ])

    // Must NOT inject hardcoded DEMO_MEMORY_CARDS titles like 'Orin e Ashy' or 'Retomar o protótipo'
    expect(cards.some((c) => c.title === 'Orin e Ashy')).toBe(false)
    expect(cards.some((c) => c.title === 'Retomar o protótipo')).toBe(false)
    expect(cards.some((c) => c.id.startsWith('ep-turn-'))).toBe(false)
    expect(cards.some((c) => c.id.startsWith('ep-dream-'))).toBe(false)

    const refCard = cards.find((c) => c.id === 'ep-padre-npm-origin')!
    expect(refCard.filterCategory).toBe('referencias')
    expect(refCard.image).toBe('/assets/mem-ghost-backend.jpg')
    expect(refCard.featured).toBe(true) // surprise 0.78 >= 0.75
    expect(refCard.badge).toBeUndefined()
    expect(refCard.originLabel).toMatch(/^Conversa de /)

    const sobreVoceCard = cards.find((c) => c.id === 'ep-real-sobre-voce')!
    expect(sobreVoceCard.filterCategory).toBe('sobre_voce')
    expect(sobreVoceCard.image).toBe('/assets/mem-work-style.jpg')
    expect(sobreVoceCard.featured).toBe(false)
    expect(sobreVoceCard.badge).toBeUndefined()

    const planosCard = cards.find((c) => c.id === 'ep-real-planos')!
    expect(planosCard.filterCategory).toBe('planos')
    expect(planosCard.image).toBe('/assets/mem-prototype-plan.jpg')
    expect(planosCard.featured).toBe(false)
    expect(planosCard.badge).toBe('Plano')
    expect(planosCard.originLabel).toMatch(/^Plano de /)

    const momentosCard = cards.find((c) => c.id === 'ep-real-momentos-flashbulb')!
    expect(momentosCard.filterCategory).toBe('momentos')
    expect(momentosCard.image).toBe('/assets/mem-first-chat.jpg')
    expect(momentosCard.featured).toBe(true)
    expect(momentosCard.badge).toBe('Flashbulb')

    // Also test createMemoryCard assigns category-specific image and category:<filterCategory> tag
    const createdPlanCard = useAshyStore.getState().createMemoryCard({
      title: 'Revisar shaders WebGL',
      summary: 'Planejar otimização do avatar',
      filterCategory: 'planos',
    })
    expect(createdPlanCard.image).toBe('/assets/mem-prototype-plan.jpg')
    const createdEp = useAshyStore
      .getState()
      .episodicMemories.find((e) => e.id === createdPlanCard.id)
    expect(createdEp?.tags).toContain('category:planos')
  })

  it('2. dynamically builds roomTrophies from custom AutobiographicalMilestone records while preserving the 3 base catalog items', () => {
    const store = useAshyStore.getState()

    // Initially all 3 base trophies exist and are locked
    expect(store.roomTrophies).toHaveLength(3)
    expect(store.roomTrophies.every((t) => !t.unlocked)).toBe(true)

    store.applyBootstrapSnapshot(
      makeBaseSnapshot({
        relationship: {
          stage: 'close_friend',
          familiarityScore: 0.7,
          trustScore: 0.8,
          totalTurns: 15,
          milestones: [
            {
              id: 'milestone-first-meeting',
              title: 'First Boot',
              narrative: 'Primeiro encontro no desktop.',
              category: 'first_meeting',
              roomTrophyId: 'trophy-first-boot-mug',
              createdAt: 1_700_000_000_000,
            },
            {
              id: 'ms-custom-joke-1',
              title: 'Piada do Café Frio',
              narrative: 'Rimos do café esquecido no micro-ondas.',
              category: 'inside_joke_born',
              createdAt: 1_700_000_005_000,
            },
            {
              id: 'ms-custom-flashbulb-2',
              title: 'Recuperação de Cluster Crítico',
              narrative: 'Failover automático concluído em 12 segundos.',
              category: 'flashbulb_moment',
              roomTrophyId: 'trophy-custom-failover',
              createdAt: 1_700_000_009_000,
            },
          ],
        },
      }),
    )

    const trophies = useAshyStore.getState().roomTrophies
    expect(trophies).toHaveLength(5)

    const firstBoot = trophies.find((t) => t.id === 'trophy-first-boot-mug')!
    expect(firstBoot.unlocked).toBe(true)

    const padreRelic = trophies.find((t) => t.id === 'trophy-padre-npm-relic')!
    expect(padreRelic.unlocked).toBe(false)

    const customJokeTrophy = trophies.find(
      (t) => t.unlockedByMilestoneId === 'ms-custom-joke-1',
    )!
    expect(customJokeTrophy).toBeDefined()
    expect(customJokeTrophy.unlocked).toBe(true)
    expect(customJokeTrophy.name).toBe('Piada do Café Frio')
    expect(customJokeTrophy.description).toBe('Rimos do café esquecido no micro-ondas.')
    expect(customJokeTrophy.iconName).toBe('Sparkles')

    const customFlashbulbTrophy = trophies.find(
      (t) => t.id === 'trophy-custom-failover',
    )!
    expect(customFlashbulbTrophy).toBeDefined()
    expect(customFlashbulbTrophy.unlocked).toBe(true)
    expect(customFlashbulbTrophy.name).toBe('Recuperação de Cluster Crítico')
    expect(customFlashbulbTrophy.description).toBe(
      'Failover automático concluído em 12 segundos.',
    )
    expect(customFlashbulbTrophy.unlockedByMilestoneId).toBe('ms-custom-flashbulb-2')
    expect(customFlashbulbTrophy.iconName).toBe('ShieldAlert')
  })

  it('3. renders "Você" (never "Carlos" or /assets/carlos-avatar.jpg) when userProfile.userName is null', () => {
    const store = useAshyStore.getState()
    const snap = makeBaseSnapshot({
      userProfile: {
        userName: null,
        userPronouns: null,
      },
      messages: [
        {
          id: 'msg-u-1',
          sessionId: 'session-test-8-3',
          role: 'user',
          content: 'Olá Ashy, testando perfil sem nome.',
          rawContent: 'Olá Ashy, testando perfil sem nome.',
          emotion: 'neutral',
          markersJson: '[]',
          createdAt: 1_700_000_000_000,
        },
      ],
    })
    store.applyBootstrapSnapshot(snap)

    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('Bom te ver, Você.')
    expect(html).not.toContain('Bom te ver, Carlos.')
    expect(html).not.toContain('carlos-avatar.jpg')
    expect(html).not.toContain('alt="Carlos"')
  })

  it('4. allows selecting fact category (select-fact-category) and editing predicate (input-fact-predicate) in "O que aprendi sobre você" and triggers host runDreamReflection on runDreamConsolidation', async () => {
    const baseSnap = makeBaseSnapshot({
      userProfile: {
        userName: 'Marina',
        userPronouns: 'ela/dela',
      },
    })

    const upsertSemanticFactMock = vi.fn(async (input) => ({
      ...input,
      sourceEpisodeIds: ['manual-ui-entry'],
      validFrom: Date.now(),
      invalidAt: null,
    }))
    const runDreamReflectionMock = vi.fn(async () => ({
      result: {
        consolidatedEpisode: null,
        crossEpisodeLinks: [],
        dreamJournalEntry: {
          id: 'dream-journal-host-1',
          createdAt: Date.now(),
          summary: 'Sonhei com nossas arquiteturas em primeira pessoa.',
          sourceEpisodeIds: ['ep-host-1'],
          crossLinksCount: 0,
          traitEvolutionsCount: 0,
        },
        appliedEvolutions: [],
        newMilestones: [],
      },
      snapshot: {
        ...baseSnap,
        memories: {
          ...baseSnap.memories,
          dreamJournalEntries: [
            {
              id: 'dream-journal-host-1',
              createdAt: Date.now(),
              summary: 'Sonhei com nossas arquiteturas em primeira pessoa.',
              sourceEpisodeIds: ['ep-host-1'],
              crossLinksCount: 0,
              traitEvolutionsCount: 0,
            },
          ],
        },
      },
    }))

    const mockBridge = {
      getBootstrapSnapshot: vi.fn(async () => baseSnap),
      onHostEvent: vi.fn(() => () => {}),
      upsertSemanticFact: upsertSemanticFactMock,
      runDreamReflection: runDreamReflectionMock,
    } as unknown as AshyHostBridge

    setAshyHostBridgeForTesting(mockBridge)
    useAshyStore.getState().applyBootstrapSnapshot(baseSnap)
    useAshyStore.getState().setActiveTab('story')

    await act(async () => {
      root!.render(<App />)
    })

    const selectCategory = container!.querySelector(
      '[data-testid="select-fact-category"]',
    ) as HTMLSelectElement | null
    const inputPredicate = container!.querySelector(
      '[data-testid="input-fact-predicate"]',
    ) as HTMLInputElement | null
    expect(selectCategory).not.toBeNull()
    expect(inputPredicate).not.toBeNull()

    const nativeSelectSetter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      'value',
    )?.set
    const nativeInputSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set

    const factSection = selectCategory!.closest('section')!
    const objectInput = factSection.querySelector(
      'input[placeholder="Nova preferência..."]',
    ) as HTMLInputElement
    const submitBtn = Array.from(factSection.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Atualizar',
    ) as HTMLButtonElement

    await act(async () => {
      nativeSelectSetter?.call(selectCategory, 'goal')
      selectCategory!.dispatchEvent(new Event('change', { bubbles: true }))

      nativeInputSetter?.call(inputPredicate, 'next_milestone_is')
      inputPredicate!.dispatchEvent(new Event('input', { bubbles: true }))
      inputPredicate!.dispatchEvent(new Event('change', { bubbles: true }))

      nativeInputSetter?.call(objectInput, 'Lançar Ashy 1.0')
      objectInput.dispatchEvent(new Event('input', { bubbles: true }))
      objectInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await act(async () => {
      submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    const addedFact = useAshyStore
      .getState()
      .semanticFacts.find((f) => f.predicate === 'next_milestone_is')
    expect(addedFact).toBeDefined()
    expect(addedFact?.category).toBe('goal')
    expect(addedFact?.object).toBe('Lançar Ashy 1.0')

    // Trigger runDreamConsolidation and verify host bridge runDreamReflection updates store
    await act(async () => {
      useAshyStore.getState().runDreamConsolidation()
    })

    await vi.waitFor(() => {
      expect(runDreamReflectionMock).toHaveBeenCalledWith(
        expect.objectContaining({ force: true }),
      )
      expect(
        useAshyStore
          .getState()
          .dreamJournalEntries.some((e) => e.id === 'dream-journal-host-1'),
      ).toBe(true)
    })
  })

  it('5. [Red-Team #2, #10] evaluateAttentionInitiative syncs host LLM replyText into chatMessages and bubbleText', async () => {
    const nowMs = Date.now()
    const baseSnap = makeBaseSnapshot({
      userProfile: {
        userName: 'Marina',
        userPronouns: 'ela/dela',
      },
      memories: {
        facts: [],
        episodes: [],
        jokes: [],
        habits: [],
        intents: [
          {
            id: 'intent-proactive-1',
            topic: 'Revisar deploy de sexta',
            contextCue: 'Checklist de deploy',
            dueAt: nowMs - 60_000,
            status: 'pending',
            sourceEpisodeId: 'ep-1',
            createdAt: nowMs - 120_000,
          },
        ],
        evolutionLog: [],
        governancePolicy: { ...DEFAULT_MEMORY_GOVERNANCE_POLICY },
        crossEpisodeLinks: [],
        dreamJournalEntries: [],
        initiativePolicy: { ...DEFAULT_INITIATIVE_POLICY },
        initiativeLog: [],
      },
    })

    const hostReplyText =
      'Marina, lembrei que precisamos revisar o deploy de sexta! Quer abrir o checklist?'
    const mockBridge = {
      getBootstrapSnapshot: vi.fn(async () => baseSnap),
      onHostEvent: vi.fn(() => () => {}),
      evaluateAttentionInitiative: vi.fn(async () => ({
        id: 'init-host-llm-1',
        triggerKind: 'prospective_intent' as const,
        sourceId: 'intent-proactive-1',
        sourceTitle: 'Revisar deploy de sexta',
        noticePrompt: 'Lembrete proativo',
        replyText: hostReplyText,
        decision: 'spoken' as const,
        reason: 'prospective_intent_due',
        createdAt: nowMs,
      })),
    } as unknown as AshyHostBridge

    setAshyHostBridgeForTesting(mockBridge)
    useAshyStore.getState().applyBootstrapSnapshot(baseSnap)

    const result = await useAshyStore.getState().evaluateAttentionInitiative({
      nowMs,
      localTimeHHMM: '14:00',
      idleMinutes: 35,
      forceDnd: false,
    })

    expect(result.replyText).toBe(hostReplyText)
    expect(useAshyStore.getState().bubbleText).toBe(hostReplyText)
    const proactiveMsg = useAshyStore
      .getState()
      .chatMessages.find((m) => m.id === 'msg-proactive-init-host-llm-1')
    expect(proactiveMsg).toBeDefined()
    expect(proactiveMsg?.content).toBe(hostReplyText)
  })
})
