// @vitest-environment jsdom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AshyHostStreamEvent } from '@ashy/shared'
import { App } from '../App'
import { createAshyHostKernel } from '../host/kernel'
import { dispatchHostRpc } from '../host/vite-host-plugin'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'

// Enable React 19 act environment
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const tempDirs: string[] = []
const activeKernels: Array<{ stop(): Promise<void> }> = []
let container: HTMLDivElement | null = null
let root: Root | null = null

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-ui-p2-'))
  tempDirs.push(dir)
  return dir
}

function clickElement(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function getByTestId<T extends HTMLElement = HTMLElement>(testId: string): T {
  const el = container?.querySelector(`[data-testid="${testId}"]`) as T | null
  if (!el) {
    throw new Error(`Unable to find an element by: [data-testid="${testId}"]`)
  }
  return el
}

function queryByTestId<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return (container?.querySelector(`[data-testid="${testId}"]`) as T | null) ?? null
}

beforeEach(() => {
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
  while (activeKernels.length > 0) {
    await activeKernels.pop()!.stop()
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Phase 2 Self-Writing Memory — TurnOrchestrator FSRS Review, Consolidation & Hub Governance UI', () => {
  it('1. updates FSRS-6 stability & lastReviewedAt via cortex.reviewTurnMemories during a real turn with exactly 1 LLM fetch call, and consolidates memories with provenance on boundary/sessionSwitch/stop', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"<|ACT {\\"emotion\\":\\"smug\\",\\"intensity\\":0.85}|>"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"<|CALLBACK motif-padre-npm|>"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Esse fantasma no backend ainda assombra os logs, quase chamo um padre no npm de novo!"}}]}\n\n',
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

    await kernel.seedDemoFixtures()
    const bootSnap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-phase2key1234',
      },
    })

    expect(bootSnap.memories.governancePolicy).toEqual({
      facts: false,
      episodes: false,
      jokes: false,
      habits: false,
      intents: false,
    })

    const originEpBefore = bootSnap.memories.episodes.find(
      (ep) => ep.id === 'ep-padre-npm-origin',
    )
    expect(originEpBefore).toBeDefined()
    const beforeStability = originEpBefore!.stability
    const beforeReviewedAt = originEpBefore!.lastReviewedAt

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    await kernel.sendTurn({
      sessionId: bootSnap.activeSession.id,
      text: 'Lembra daquele fantasma no backend e do padre no npm? Hoje sempre costumo programar de madrugada e amanhã tenho deploy da API.',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:completed')).toBe(true)
    })
    unsub()

    // Invariant: standard sendTurn makes ONLY 1 fetch call per turn
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const afterTurnSnap = await kernel.getBootstrapSnapshot()
    const originEpAfter = afterTurnSnap.memories.episodes.find(
      (ep) => ep.id === 'ep-padre-npm-origin',
    )
    expect(originEpAfter).toBeDefined()
    expect(originEpAfter!.stability).toBeGreaterThan(beforeStability)
    expect(originEpAfter!.lastReviewedAt).toBeGreaterThan(beforeReviewedAt)

    // Manual / explicit consolidation via kernel.consolidateSessionMemories
    const consolidatedSnap = await kernel.consolidateSessionMemories({
      sessionId: bootSnap.activeSession.id,
      force: true,
    })

    // Consolidated episode should exist and have replaced draft ep-turn-* for this session
    const consolidatedEp = consolidatedSnap.memories.episodes.find((ep) =>
      ep.id.startsWith(`ep-${bootSnap.activeSession.id}`),
    )
    expect(consolidatedEp).toBeDefined()

    // Prospective intent and habit extracted from the turn must carry sourceEpisodeId pointing to consolidatedEp.id
    const deployIntent = consolidatedSnap.memories.intents?.find((i) =>
      i.topic.toLowerCase().includes('deploy da api'),
    )
    expect(deployIntent).toBeDefined()
    expect(deployIntent?.sourceEpisodeId).toBe(consolidatedEp?.id)

    const nightHabit = consolidatedSnap.memories.habits?.find(
      (h) => h.sourceEpisodeId === consolidatedEp?.id,
    )
    expect(nightHabit).toBeDefined()

    // Test automatic consolidation on selectSession when switching sessions
    const secondSession = await kernel.createSession('Sessão 2')
    await kernel.sendTurn({
      sessionId: secondSession.id,
      text: 'Meu projeto atual é Orin Engine v2 e uso muito Neovim.',
    })
    await vi.waitFor(() => {
      const msgs = kernel.cortex.listChatMessages(secondSession.id)
      expect(msgs.some((m) => m.role === 'assistant')).toBe(true)
    })

    // Switching back to initial session should automatically consolidate secondSession
    await kernel.selectSession(bootSnap.activeSession.id)
    const snapAfterSwitch = await kernel.getBootstrapSnapshot()
    const secondSessionEp = snapAfterSwitch.memories.episodes.find((ep) =>
      ep.id.startsWith(`ep-${secondSession.id}`),
    )
    expect(secondSessionEp).toBeDefined()

    // Test automatic consolidation on kernel.stop() for unconsolidated messages
    const thirdSession = await kernel.createSession('Sessão Shutdown')
    await kernel.sendTurn({
      sessionId: thirdSession.id,
      text: 'Meu nome é Carlos Eduardo e trabalho com arquitetura distribuída.',
    })
    await vi.waitFor(() => {
      const msgs = kernel.cortex.listChatMessages(thirdSession.id)
      expect(msgs.some((m) => m.role === 'assistant')).toBe(true)
    })

    await kernel.stop()
    activeKernels.pop()

    const rebootedKernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    activeKernels.push(rebootedKernel)

    const snapAfterReboot = await rebootedKernel.getBootstrapSnapshot()
    const shutdownEp = snapAfterReboot.memories.episodes.find((ep) =>
      ep.id.startsWith(`ep-${thirdSession.id}`),
    )
    expect(shutdownEp).toBeDefined()
  })

  it('2. enforces quarantine (pending_review) when governance confirmation is enabled, and supports Approve, Discard, and Consolidate Now in <App /> Memory Inspector', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"Entendido, Carlos! Anotei tudo por aqui."}}]}\n\n',
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

    const initialSnap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-phase2key9999',
      },
    })

    // Seed an existing approved fact for user's tool so we can verify conflict invalidation upon approval
    const oldToolFact = await kernel.upsertSemanticFact({
      id: 'fact-tool-vscode',
      category: 'preference',
      subject: 'user',
      predicate: 'uses_tool',
      object: 'VS Code',
      confidence: 0.9,
    })
    expect(oldToolFact.invalidAt).toBeNull()

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()

    await act(async () => {
      root!.render(<App />)
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().isBootstrapped).toBe(true)
    })

    // Navigate to Memory Inspector ('Memórias' tab)
    await act(async () => {
      clickElement(getByTestId('tab-memories'))
    })

    // Verify Memory Governance Panel & Consolidate Now button are rendered
    const consolidateBtn = getByTestId('btn-consolidate-memories')
    expect(consolidateBtn.textContent).toContain('Consolidar Agora')

    const governancePanel = getByTestId('memory-governance-panel')
    expect(governancePanel).toBeTruthy()

    // Enable confirmation quarantine for 'facts' and 'intents' via UI toggles
    const toggleFactsBtn = getByTestId('governance-toggle-facts')
    const toggleIntentsBtn = getByTestId('governance-toggle-intents')

    await act(async () => {
      clickElement(toggleFactsBtn)
    })
    await vi.waitFor(() => {
      expect(useAshyStore.getState().memoryGovernancePolicy.facts).toBe(true)
    })

    await act(async () => {
      clickElement(toggleIntentsBtn)
    })
    await vi.waitFor(() => {
      expect(useAshyStore.getState().memoryGovernancePolicy.intents).toBe(true)
    })

    // Send a turn that declares a new conflicting tool ('Zed Editor') and a prospective intent ('Amanhã tenho revisão de segurança')
    await act(async () => {
      await useAshyStore
        .getState()
        .sendUserMessage(
          'Agora uso muito Zed Editor no projeto e amanhã tenho revisão de segurança.',
        )
    })

    // Trigger manual consolidation via the UI button "Consolidar Agora"
    await act(async () => {
      clickElement(getByTestId('btn-consolidate-memories'))
    })

    await vi.waitFor(() => {
      const pendingSection = queryByTestId('pending-review-memories')
      expect(pendingSection).not.toBeNull()
    })

    const stateWhilePending = useAshyStore.getState()
    const pendingFact = stateWhilePending.semanticFacts.find(
      (f) =>
        f.approvalStatus === 'pending_review' &&
        f.object.toLowerCase().includes('zed editor'),
    )
    expect(pendingFact).toBeDefined()
    expect(pendingFact!.sourceEpisodeIds.length).toBeGreaterThan(0)

    const pendingIntent = stateWhilePending.prospectiveIntents.find(
      (i) =>
        i.approvalStatus === 'pending_review' &&
        i.topic.toLowerCase().includes('revisão de segurança'),
    )
    expect(pendingIntent).toBeDefined()
    expect(pendingIntent!.sourceEpisodeId).toBeTruthy()

    // While pending_review:
    // 1. Pending fact MUST NOT be injected into compiled prompt (volatileTurnContext)
    expect(stateWhilePending.lastPrompt.volatileTurnContext).not.toContain('Zed Editor')
    const hostCompiledBefore = kernel.cortex.compileTurnPrompt({
      userMessage: 'Qual editor eu uso?',
    })
    expect(hostCompiledBefore.volatileTurnContext).not.toContain('Zed Editor')
    expect(hostCompiledBefore.volatileTurnContext).toContain('VS Code')

    // 2. Old approved fact ('VS Code') MUST still be active (invalidAt === null) while replacement is in quarantine
    const activeOldFactWhilePending = stateWhilePending.semanticFacts.find(
      (f) => f.id === oldToolFact.id,
    )
    expect(activeOldFactWhilePending?.invalidAt).toBeNull()

    // Click "Aprovar" on the pending fact in the UI
    const approveFactBtn = getByTestId(`btn-approve-memory-${pendingFact!.id}`)
    await act(async () => {
      clickElement(approveFactBtn)
    })

    await vi.waitFor(() => {
      const updatedFact = useAshyStore
        .getState()
        .semanticFacts.find((f) => f.id === pendingFact!.id)
      expect(updatedFact?.approvalStatus).toBe('approved')
    })

    const stateAfterApprove = useAshyStore.getState()
    // Now the approved fact is active in the compiled prompt and the superseded 'VS Code' fact is invalidated!
    expect(stateAfterApprove.lastPrompt.volatileTurnContext).toContain('Zed Editor')
    const supersededOldFact = stateAfterApprove.semanticFacts.find(
      (f) => f.id === oldToolFact.id,
    )
    expect(supersededOldFact?.invalidAt).not.toBeNull()

    const hostCompiledAfter = kernel.cortex.compileTurnPrompt({
      userMessage: 'Qual editor eu uso?',
    })
    expect(hostCompiledAfter.volatileTurnContext).toContain('Zed Editor')
    expect(hostCompiledAfter.volatileTurnContext).not.toContain('VS Code')

    // Click "Descartar" on the pending prospective intent in the UI
    const discardIntentBtn = getByTestId(`btn-discard-memory-${pendingIntent!.id}`)
    await act(async () => {
      clickElement(discardIntentBtn)
    })

    await vi.waitFor(() => {
      expect(
        useAshyStore
          .getState()
          .prospectiveIntents.some((i) => i.id === pendingIntent!.id),
      ).toBe(false)
    })

    // Verify it was also deleted from SQLite on the host
    const snapAfterDiscard = await kernel.getBootstrapSnapshot()
    expect(
      snapAfterDiscard.memories.intents?.some((i) => i.id === pendingIntent!.id),
    ).toBe(false)

    // Verify RPC transport validation for new Phase 2 methods
    const policyViaRpc = await dispatchHostRpc(kernel, 'setMemoryGovernancePolicy', {
      category: 'habits',
      requireConfirmation: true,
    })
    expect(policyViaRpc).toMatchObject({ habits: true })

    await expect(
      dispatchHostRpc(kernel, 'setMemoryGovernancePolicy', {
        category: 'invalid_category',
        requireConfirmation: true,
      }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'approveMemoryItem', {
        kind: 'invalid_kind',
        id: '123',
      }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    // Verify session id is still intact
    expect(initialSnap.activeSession.id).toBeTruthy()
  })

  it('3. Red-Team UI & Host Remediation: isolates pending_review from relationship metrics & active UI lists, persists completeProspectiveIntent to SQLite, exposes active Habits/Intents/Jokes/Facts/Milestones delete controls, and guards RPC/activeTurn edge cases', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"Beleza, Carlos!"}}]}\n\n',
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
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-phase2key7777',
      },
    })

    const baseSnap = await kernel.getBootstrapSnapshot()
    const baseFamiliarity = baseSnap.relationship.familiarityScore

    // 1. Seed a pending_review joke with timesUsed: 5 and a pending_review episode:
    // Neither may inflate familiarityScore or stage in getBootstrapSnapshot()
    kernel.cortex.db.upsertRelationalMotif({
      id: 'motif-pending-unapproved',
      motif: 'piada secreta nao aprovada',
      originSummary: 'contexto nao aprovado',
      triggerCues: ['piada', 'secreta'],
      stage: 'inside_joke',
      timesUsed: 5,
      createdAt: Date.now() - 86_400_000,
      lastUsedAt: Date.now() - 43_200_000,
      cooldownHours: 12,
      embedding: [],
      approvalStatus: 'pending_review',
    })
    kernel.cortex.db.upsertEpisodicMemory({
      id: 'ep-pending-unapproved',
      title: 'Episodio em Quarentena',
      summary: 'Resumo de episodio em quarentena que nao deve inflar familiaridade.',
      content: 'Conteudo em quarentena.',
      surprise: 0.8,
      stability: 3.5,
      difficulty: 4.5,
      createdAt: Date.now(),
      lastReviewedAt: Date.now(),
      isFlashbulb: true,
      tags: ['quarantine'],
      embedding: [],
      approvalStatus: 'pending_review',
    })

    const snapWithPending = await kernel.getBootstrapSnapshot()
    expect(snapWithPending.relationship.familiarityScore).toBe(baseFamiliarity)
    expect(snapWithPending.relationship.stage).toBe('stranger')

    // 2. Seed approved items across all categories (Habit, Intent, Joke, Fact, Milestone)
    kernel.cortex.db.upsertUserHabit({
      id: 'habit-approved-1',
      patternKey: 'late_night_coding',
      description: 'Costuma programar de madrugada',
      confidence: 0.88,
      observationCount: 2,
      updatedAt: Date.now(),
      approvalStatus: 'approved',
    })
    await kernel.upsertProspectiveIntent({
      id: 'intent-approved-1',
      topic: 'Deploy do cluster Kubernetes',
      contextCue: 'Amanhã tenho deploy do cluster Kubernetes',
      dueAt: Date.now() - 10_000,
      status: 'pending',
      createdAt: Date.now() - 50_000,
      approvalStatus: 'approved',
    })
    kernel.cortex.db.upsertRelationalMotif({
      id: 'motif-approved-1',
      motif: 'chamar um padre no npm',
      originSummary: 'Bug espiritual no npm',
      triggerCues: ['padre', 'npm'],
      stage: 'inside_joke',
      timesUsed: 2,
      createdAt: Date.now() - 86_400_000,
      lastUsedAt: Date.now() - 43_200_000,
      cooldownHours: 12,
      embedding: [],
      approvalStatus: 'approved',
    })
    await kernel.upsertSemanticFact({
      id: 'fact-approved-1',
      category: 'preference',
      subject: 'user',
      predicate: 'uses_tool',
      object: 'Neovim',
      confidence: 0.95,
    })
    await kernel.upsertMilestone({
      id: 'ms-approved-1',
      category: 'project_shipped',
      title: 'Deploy Zero Downtime',
      narrative: 'Subimos o cluster sem cair nenhuma conexão.',
      createdAt: Date.now(),
    })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()

    await act(async () => {
      root!.render(<App />)
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().isBootstrapped).toBe(true)
    })

    // Navigate to 'Memórias' tab
    await act(async () => {
      clickElement(getByTestId('tab-memories'))
    })

    // Verify pending_review items appear ONLY in pending-review-memories, NOT in active lists
    const pendingBox = getByTestId('pending-review-memories')
    expect(pendingBox.textContent).toContain('piada secreta nao aprovada')
    expect(pendingBox.textContent).toContain('Episodio em Quarentena')

    // Verify active habits & intents sections render in Memory Inspector
    const activeHabitsSection = getByTestId('active-habits-list')
    expect(activeHabitsSection.textContent).toContain('Costuma programar de madrugada')

    const activeIntentsSection = getByTestId('active-intents-list')
    expect(activeIntentsSection.textContent).toContain('Deploy do cluster Kubernetes')

    // Complete prospective intent via UI button and verify it persists to SQLite on host
    const completeIntentBtn = getByTestId('btn-complete-intent-intent-approved-1')
    await act(async () => {
      clickElement(completeIntentBtn)
    })

    await vi.waitFor(() => {
      const hostIntent = kernel.cortex.db
        .listProspectiveIntents()
        .find((i) => i.id === 'intent-approved-1')
      expect(hostIntent?.status).toBe('completed')
    })

    // Delete active habit, intent, and joke from Memory Inspector UI
    await act(async () => {
      clickElement(getByTestId('btn-delete-habit-habit-approved-1'))
      clickElement(getByTestId('btn-delete-intent-intent-approved-1'))
      clickElement(getByTestId('btn-delete-joke-motif-approved-1'))
    })

    await vi.waitFor(() => {
      expect(
        kernel.cortex.db.listUserHabits().some((h) => h.id === 'habit-approved-1'),
      ).toBe(false)
      expect(
        kernel.cortex.db.listProspectiveIntents().some((i) => i.id === 'intent-approved-1'),
      ).toBe(false)
      expect(
        kernel.cortex.db.listRelationalMotifs().some((m) => m.id === 'motif-approved-1'),
      ).toBe(false)
    })

    // Delete approved fact and milestone (either from Memories or Story tab)
    if (!queryByTestId('btn-delete-fact-fact-approved-1')) {
      await act(async () => {
        clickElement(getByTestId('tab-story'))
      })
    }
    await act(async () => {
      clickElement(getByTestId('btn-delete-fact-fact-approved-1'))
      clickElement(getByTestId('btn-delete-milestone-ms-approved-1'))
    })

    await vi.waitFor(() => {
      expect(
        kernel.cortex.db.listSemanticFacts().some((f) => f.id === 'fact-approved-1'),
      ).toBe(false)
      expect(
        kernel.cortex.db.listMilestones().some((m) => m.id === 'ms-approved-1'),
      ).toBe(false)
    })

    // 3. RPC validation guards: null bytes, oversized IDs, and blank sessionId normalization
    await expect(
      dispatchHostRpc(kernel, 'deleteMemoryItem', {
        kind: 'fact',
        id: 'bad\0id',
      }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'approveMemoryItem', {
        kind: 'fact',
        id: 'x'.repeat(300),
      }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'consolidateSessionMemories', {
        sessionId: 'bad\0session',
      }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    // Blank sessionId falls back to activeSessionId without creating ghost episode
    const snapBlankSession = await kernel.consolidateSessionMemories({
      sessionId: '   ',
      force: true,
    })
    expect(
      snapBlankSession.memories.episodes.some((ep) => ep.id.startsWith('ep-   ')),
    ).toBe(false)

    // 4. selectSession skips auto-consolidation when turnOrchestrator has an active turn for the session
    const activeTurnSession = await kernel.createSession('Sessão Em Streaming')
    const spyConsolidate = vi.spyOn(kernel.cortex, 'consolidateSessionMemories')
    vi.spyOn(kernel.turnOrchestrator, 'hasActiveTurnForSession').mockReturnValueOnce(true)
    await kernel.selectSession(baseSnap.activeSession.id)
    expect(
      spyConsolidate.mock.calls.some(([arg]) => arg.sessionId === activeTurnSession.id),
    ).toBe(false)
    spyConsolidate.mockRestore()
  })
})
