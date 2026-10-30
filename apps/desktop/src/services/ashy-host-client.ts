import type {
  AgencySnapshot,
  ApprovalScope,
  ApprovableMemoryKind,
  AshyBootstrapSnapshot,
  AshyEmotion,
  AshyHostBridge,
  AshyHostStreamEvent,
  AutobiographicalMilestone,
  ChatMessageRecord,
  ChatSessionRecord,
  CompleteOnboardingInput,
  CoreExperimentEvalReport,
  DeletableMemoryKind,
  DreamReflectionCycleResult,
  EpisodicMemory,
  EvaluateInitiativeInput,
  ExternalMcpServerConfig,
  InitiativePolicy,
  LlmProviderId,
  MemoryGovernanceCategory,
  MemoryGovernancePolicy,
  PersonalityEvolutionRecord,
  PersonalityTraits,
  ProactiveInitiativeRecord,
  ProspectiveIntent,
  ProviderHealthResult,
  PublicProviderConfig,
  RelationalMotif,
  RunCoreExperimentInput,
  SaveProviderConfigInput,
  SemanticFact,
  SendTurnInput,
  SharedPendingActionCard,
  TestProviderInput,
  UpdateAgencyConsentInput,
  UpdateInitiativePolicyInput,
  UpdateMilestoneInput,
  UpsertFactInput,
  VisionObservationResult,
} from '@ashy/shared'
import type { AshyPreloadApi } from '../preload/index'

export interface EventSourceLike {
  onmessage: ((ev: { data: string }) => void) | null
  onerror: ((err: unknown) => void) | null
  close(): void
}

export interface HttpSseHostBridgeOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  createEventSource?: (url: string) => EventSourceLike
}

declare global {
  interface Window {
    ashyHost?: AshyPreloadApi
  }
}

export function createPreloadHostBridge(
  preloadApi: AshyPreloadApi,
): AshyHostBridge {
  const invoke = <T>(method: string, payload?: unknown): Promise<T> =>
    preloadApi.invoke(method, payload) as Promise<T>

  return {
    getBootstrapSnapshot(): Promise<AshyBootstrapSnapshot> {
      return invoke<AshyBootstrapSnapshot>('getBootstrapSnapshot')
    },
    completeOnboarding(
      input: CompleteOnboardingInput,
    ): Promise<AshyBootstrapSnapshot> {
      return invoke<AshyBootstrapSnapshot>('completeOnboarding', input)
    },
    createSession(title?: string): Promise<ChatSessionRecord> {
      return invoke<ChatSessionRecord>('createSession', { title })
    },
    selectSession(sessionId: string): Promise<{
      session: ChatSessionRecord
      messages: ChatMessageRecord[]
    }> {
      return invoke('selectSession', { sessionId })
    },
    sendTurn(input: SendTurnInput): Promise<{
      turnId: string
      userMessage: ChatMessageRecord
    }> {
      return invoke('sendTurn', input)
    },
    abortTurn(turnId: string): Promise<void> {
      return invoke<void>('abortTurn', { turnId })
    },
    saveProviderConfig(input: SaveProviderConfigInput): Promise<{
      config: PublicProviderConfig
      providers: AshyBootstrapSnapshot['providers']
    }> {
      return invoke('saveProviderConfig', input)
    },
    setActiveProvider(
      providerId: LlmProviderId,
    ): Promise<AshyBootstrapSnapshot['providers']> {
      return invoke('setActiveProvider', { providerId })
    },
    testProviderConnection(
      input: TestProviderInput,
    ): Promise<ProviderHealthResult> {
      return invoke<ProviderHealthResult>('testProviderConnection', input)
    },
    saveVoiceIdentity(
      content: string,
    ): Promise<AshyBootstrapSnapshot['voice']> {
      return invoke('saveVoiceIdentity', { content })
    },
    resetVoiceIdentity(): Promise<AshyBootstrapSnapshot['voice']> {
      return invoke('resetVoiceIdentity')
    },
    upsertSemanticFact(input: UpsertFactInput): Promise<SemanticFact> {
      return invoke<SemanticFact>('upsertSemanticFact', input)
    },
    upsertEpisodicMemory(episode: EpisodicMemory): Promise<EpisodicMemory> {
      return invoke<EpisodicMemory>('upsertEpisodicMemory', episode)
    },
    upsertMilestone(
      milestone: AutobiographicalMilestone,
    ): Promise<AutobiographicalMilestone> {
      return invoke<AutobiographicalMilestone>('upsertMilestone', milestone)
    },
    upsertRelationalMotif(motif: RelationalMotif): Promise<RelationalMotif> {
      return invoke<RelationalMotif>('upsertRelationalMotif', motif)
    },
    upsertProspectiveIntent(intent: ProspectiveIntent): Promise<ProspectiveIntent> {
      return invoke<ProspectiveIntent>('upsertProspectiveIntent', intent)
    },
    recordEmotionPulse(input: {
      emotion: AshyEmotion
      intensity?: number
    }): Promise<AshyBootstrapSnapshot['affect']> {
      return invoke('recordEmotionPulse', input)
    },
    persistDreamConsolidation(input: {
      episode: EpisodicMemory
      traits: PersonalityTraits
      record: PersonalityEvolutionRecord
    }): Promise<void> {
      return invoke<void>('persistDreamConsolidation', input)
    },
    persistTraitRevert(input: {
      traits: PersonalityTraits
      record: PersonalityEvolutionRecord
    }): Promise<void> {
      return invoke<void>('persistTraitRevert', input)
    },
    deleteMemoryItem(input: {
      kind: DeletableMemoryKind
      id: string
    }): Promise<void> {
      return invoke<void>('deleteMemoryItem', input)
    },
    consolidateSessionMemories(input?: {
      sessionId?: string
      force?: boolean
    }): Promise<AshyBootstrapSnapshot> {
      return invoke<AshyBootstrapSnapshot>('consolidateSessionMemories', input)
    },
    approveMemoryItem(input: {
      kind: ApprovableMemoryKind
      id: string
    }): Promise<AshyBootstrapSnapshot> {
      return invoke<AshyBootstrapSnapshot>('approveMemoryItem', input)
    },
    setMemoryGovernancePolicy(input: {
      category: MemoryGovernanceCategory
      requireConfirmation: boolean
    }): Promise<MemoryGovernancePolicy> {
      return invoke<MemoryGovernancePolicy>('setMemoryGovernancePolicy', input)
    },
    seedDemoFixtures(): Promise<AshyBootstrapSnapshot> {
      return invoke<AshyBootstrapSnapshot>('seedDemoFixtures')
    },
    runCoreExperimentEval(
      input?: RunCoreExperimentInput,
    ): Promise<CoreExperimentEvalReport> {
      return invoke<CoreExperimentEvalReport>('runCoreExperimentEval', input)
    },
    runDreamReflection(input?: {
      sessionId?: string
      force?: boolean
      maxEvolutions?: number
    }): Promise<{
      result: DreamReflectionCycleResult
      snapshot: AshyBootstrapSnapshot
    }> {
      return invoke('runDreamReflection', input)
    },
    revertTraitEvolution(input: {
      recordId: string
    }): Promise<AshyBootstrapSnapshot> {
      return invoke<AshyBootstrapSnapshot>('revertTraitEvolution', input)
    },
    getAgencySnapshot(): Promise<AgencySnapshot> {
      return invoke<AgencySnapshot>('getAgencySnapshot')
    },
    callMcpTool(input: {
      toolName: string
      args?: Record<string, unknown>
    }): Promise<{
      status: 'executed' | 'staged' | 'blocked_privacy' | 'blocked_traversal' | 'blocked_policy'
      output?: unknown
      pendingCard?: SharedPendingActionCard
      reason?: string
      snapshot?: AgencySnapshot
    }> {
      return invoke('callMcpTool', input)
    },
    approvePendingAction(input: {
      actionId: string
      scope?: ApprovalScope
    }): Promise<{
      status: 'executed'
      card: SharedPendingActionCard
      output: unknown
      snapshot?: AgencySnapshot
    }> {
      return invoke('approvePendingAction', input)
    },
    denyPendingAction(input: {
      actionId: string
      reason?: string
    }): Promise<{
      status: 'denied'
      card: SharedPendingActionCard
      feedback: string
      snapshot?: AgencySnapshot
    }> {
      return invoke('denyPendingAction', input)
    },
    updateAgencyConsent(input: UpdateAgencyConsentInput): Promise<AgencySnapshot> {
      return invoke<AgencySnapshot>('updateAgencyConsent', input)
    },
    revokeSessionPermissions(input?: { toolName?: string }): Promise<AgencySnapshot> {
      return invoke<AgencySnapshot>('revokeSessionPermissions', input)
    },
    captureAuthorizedScreen(input?: {
      windowTitle?: string
      frameFixtureId?: string
      forceRefresh?: boolean
    }): Promise<{
      observation: VisionObservationResult
      snapshot: AgencySnapshot
    }> {
      return invoke('captureAuthorizedScreen', input)
    },
    registerExternalMcpServer(input: ExternalMcpServerConfig): Promise<AgencySnapshot> {
      return invoke<AgencySnapshot>('registerExternalMcpServer', input)
    },
    updateMilestone(input: UpdateMilestoneInput): Promise<AutobiographicalMilestone> {
      return invoke<AutobiographicalMilestone>('updateMilestone', input)
    },
    updateInitiativePolicy(input: UpdateInitiativePolicyInput): Promise<InitiativePolicy> {
      return invoke<InitiativePolicy>('updateInitiativePolicy', input)
    },
    evaluateAttentionInitiative(
      input?: EvaluateInitiativeInput,
    ): Promise<ProactiveInitiativeRecord> {
      return invoke<ProactiveInitiativeRecord>('evaluateAttentionInitiative', input)
    },
    onHostEvent(listener: (event: AshyHostStreamEvent) => void): () => void {
      return preloadApi.onEvent(listener)
    },
  }
}

export function createHttpSseHostBridge(
  options: HttpSseHostBridgeOptions = {},
): AshyHostBridge {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '')
  const fetchFn: typeof fetch =
    options.fetchImpl ?? ((...args) => globalThis.fetch(...args))

  const createEventSourceFn: (url: string) => EventSourceLike =
    options.createEventSource ??
    ((url: string) => {
      if (typeof globalThis.EventSource === 'function') {
        return new globalThis.EventSource(url) as unknown as EventSourceLike
      }
      return {
        onmessage: null,
        onerror: null,
        close() {
          // No-op when EventSource is unavailable in non-browser environment
        },
      }
    })

  async function rpc<T>(method: string, payload?: unknown): Promise<T> {
    const res = await fetchFn(`${baseUrl}/__ashy_host/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ method, payload }),
    })

    let parsed: { ok?: boolean; result?: T; error?: string } | null = null
    try {
      parsed = (await res.json()) as { ok?: boolean; result?: T; error?: string }
    } catch {
      parsed = null
    }

    if (!res.ok || !parsed || parsed.ok !== true) {
      throw new Error(
        parsed?.error || `AshyHost RPC failed (${method}): HTTP ${res.status}`,
      )
    }

    return parsed.result as T
  }

  const listeners = new Set<(event: AshyHostStreamEvent) => void>()
  let activeEventSource: EventSourceLike | null = null

  function ensureEventSource(): void {
    if (activeEventSource || listeners.size === 0) return
    const es = createEventSourceFn(`${baseUrl}/__ashy_host/events`)
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as AshyHostStreamEvent
        for (const listener of listeners) {
          listener(parsed)
        }
      } catch {
        // Ignore malformed SSE frame
      }
    }
    activeEventSource = es
  }

  function releaseEventSourceIfIdle(): void {
    if (listeners.size > 0 || !activeEventSource) return
    try {
      activeEventSource.close()
    } catch {
      // Ignore close error
    }
    activeEventSource = null
  }

  return {
    getBootstrapSnapshot(): Promise<AshyBootstrapSnapshot> {
      return rpc<AshyBootstrapSnapshot>('getBootstrapSnapshot')
    },
    completeOnboarding(
      input: CompleteOnboardingInput,
    ): Promise<AshyBootstrapSnapshot> {
      return rpc<AshyBootstrapSnapshot>('completeOnboarding', input)
    },
    createSession(title?: string): Promise<ChatSessionRecord> {
      return rpc<ChatSessionRecord>('createSession', { title })
    },
    selectSession(sessionId: string): Promise<{
      session: ChatSessionRecord
      messages: ChatMessageRecord[]
    }> {
      return rpc('selectSession', { sessionId })
    },
    sendTurn(input: SendTurnInput): Promise<{
      turnId: string
      userMessage: ChatMessageRecord
    }> {
      return rpc('sendTurn', input)
    },
    abortTurn(turnId: string): Promise<void> {
      return rpc<void>('abortTurn', { turnId })
    },
    saveProviderConfig(input: SaveProviderConfigInput): Promise<{
      config: PublicProviderConfig
      providers: AshyBootstrapSnapshot['providers']
    }> {
      return rpc('saveProviderConfig', input)
    },
    setActiveProvider(
      providerId: LlmProviderId,
    ): Promise<AshyBootstrapSnapshot['providers']> {
      return rpc('setActiveProvider', { providerId })
    },
    testProviderConnection(
      input: TestProviderInput,
    ): Promise<ProviderHealthResult> {
      return rpc<ProviderHealthResult>('testProviderConnection', input)
    },
    saveVoiceIdentity(
      content: string,
    ): Promise<AshyBootstrapSnapshot['voice']> {
      return rpc('saveVoiceIdentity', { content })
    },
    resetVoiceIdentity(): Promise<AshyBootstrapSnapshot['voice']> {
      return rpc('resetVoiceIdentity')
    },
    upsertSemanticFact(input: UpsertFactInput): Promise<SemanticFact> {
      return rpc<SemanticFact>('upsertSemanticFact', input)
    },
    upsertEpisodicMemory(episode: EpisodicMemory): Promise<EpisodicMemory> {
      return rpc<EpisodicMemory>('upsertEpisodicMemory', episode)
    },
    upsertMilestone(
      milestone: AutobiographicalMilestone,
    ): Promise<AutobiographicalMilestone> {
      return rpc<AutobiographicalMilestone>('upsertMilestone', milestone)
    },
    upsertRelationalMotif(motif: RelationalMotif): Promise<RelationalMotif> {
      return rpc<RelationalMotif>('upsertRelationalMotif', motif)
    },
    upsertProspectiveIntent(intent: ProspectiveIntent): Promise<ProspectiveIntent> {
      return rpc<ProspectiveIntent>('upsertProspectiveIntent', intent)
    },
    recordEmotionPulse(input: {
      emotion: AshyEmotion
      intensity?: number
    }): Promise<AshyBootstrapSnapshot['affect']> {
      return rpc('recordEmotionPulse', input)
    },
    persistDreamConsolidation(input: {
      episode: EpisodicMemory
      traits: PersonalityTraits
      record: PersonalityEvolutionRecord
    }): Promise<void> {
      return rpc<void>('persistDreamConsolidation', input)
    },
    persistTraitRevert(input: {
      traits: PersonalityTraits
      record: PersonalityEvolutionRecord
    }): Promise<void> {
      return rpc<void>('persistTraitRevert', input)
    },
    deleteMemoryItem(input: {
      kind: DeletableMemoryKind
      id: string
    }): Promise<void> {
      return rpc<void>('deleteMemoryItem', input)
    },
    consolidateSessionMemories(input?: {
      sessionId?: string
      force?: boolean
    }): Promise<AshyBootstrapSnapshot> {
      return rpc<AshyBootstrapSnapshot>('consolidateSessionMemories', input)
    },
    approveMemoryItem(input: {
      kind: ApprovableMemoryKind
      id: string
    }): Promise<AshyBootstrapSnapshot> {
      return rpc<AshyBootstrapSnapshot>('approveMemoryItem', input)
    },
    setMemoryGovernancePolicy(input: {
      category: MemoryGovernanceCategory
      requireConfirmation: boolean
    }): Promise<MemoryGovernancePolicy> {
      return rpc<MemoryGovernancePolicy>('setMemoryGovernancePolicy', input)
    },
    seedDemoFixtures(): Promise<AshyBootstrapSnapshot> {
      return rpc<AshyBootstrapSnapshot>('seedDemoFixtures')
    },
    runCoreExperimentEval(
      input?: RunCoreExperimentInput,
    ): Promise<CoreExperimentEvalReport> {
      return rpc<CoreExperimentEvalReport>('runCoreExperimentEval', input)
    },
    runDreamReflection(input?: {
      sessionId?: string
      force?: boolean
      maxEvolutions?: number
    }): Promise<{
      result: DreamReflectionCycleResult
      snapshot: AshyBootstrapSnapshot
    }> {
      return rpc('runDreamReflection', input)
    },
    revertTraitEvolution(input: {
      recordId: string
    }): Promise<AshyBootstrapSnapshot> {
      return rpc<AshyBootstrapSnapshot>('revertTraitEvolution', input)
    },
    getAgencySnapshot(): Promise<AgencySnapshot> {
      return rpc<AgencySnapshot>('getAgencySnapshot')
    },
    callMcpTool(input: {
      toolName: string
      args?: Record<string, unknown>
    }): Promise<{
      status: 'executed' | 'staged' | 'blocked_privacy' | 'blocked_traversal' | 'blocked_policy'
      output?: unknown
      pendingCard?: SharedPendingActionCard
      reason?: string
      snapshot?: AgencySnapshot
    }> {
      return rpc('callMcpTool', input)
    },
    approvePendingAction(input: {
      actionId: string
      scope?: ApprovalScope
    }): Promise<{
      status: 'executed'
      card: SharedPendingActionCard
      output: unknown
      snapshot?: AgencySnapshot
    }> {
      return rpc('approvePendingAction', input)
    },
    denyPendingAction(input: {
      actionId: string
      reason?: string
    }): Promise<{
      status: 'denied'
      card: SharedPendingActionCard
      feedback: string
      snapshot?: AgencySnapshot
    }> {
      return rpc('denyPendingAction', input)
    },
    updateAgencyConsent(input: UpdateAgencyConsentInput): Promise<AgencySnapshot> {
      return rpc<AgencySnapshot>('updateAgencyConsent', input)
    },
    revokeSessionPermissions(input?: { toolName?: string }): Promise<AgencySnapshot> {
      return rpc<AgencySnapshot>('revokeSessionPermissions', input)
    },
    captureAuthorizedScreen(input?: {
      windowTitle?: string
      frameFixtureId?: string
      forceRefresh?: boolean
    }): Promise<{
      observation: VisionObservationResult
      snapshot: AgencySnapshot
    }> {
      return rpc('captureAuthorizedScreen', input)
    },
    registerExternalMcpServer(input: ExternalMcpServerConfig): Promise<AgencySnapshot> {
      return rpc<AgencySnapshot>('registerExternalMcpServer', input)
    },
    updateMilestone(input: UpdateMilestoneInput): Promise<AutobiographicalMilestone> {
      return rpc<AutobiographicalMilestone>('updateMilestone', input)
    },
    updateInitiativePolicy(input: UpdateInitiativePolicyInput): Promise<InitiativePolicy> {
      return rpc<InitiativePolicy>('updateInitiativePolicy', input)
    },
    evaluateAttentionInitiative(
      input?: EvaluateInitiativeInput,
    ): Promise<ProactiveInitiativeRecord> {
      return rpc<ProactiveInitiativeRecord>('evaluateAttentionInitiative', input)
    },
    onHostEvent(listener: (event: AshyHostStreamEvent) => void): () => void {
      listeners.add(listener)
      ensureEventSource()
      return () => {
        listeners.delete(listener)
        releaseEventSourceIfIdle()
      }
    },
  }
}

let testBridgeOverride: AshyHostBridge | null = null
let cachedDefaultBridge: AshyHostBridge | null = null

export function setAshyHostBridgeForTesting(
  bridge: AshyHostBridge | null,
): void {
  testBridgeOverride = bridge
}

export function getAshyHostBridge(): AshyHostBridge {
  if (testBridgeOverride) {
    return testBridgeOverride
  }

  const globalPreload =
    (typeof window !== 'undefined' ? window.ashyHost : undefined) ??
    (globalThis as unknown as { ashyHost?: AshyPreloadApi }).ashyHost

  if (globalPreload) {
    return createPreloadHostBridge(globalPreload)
  }

  if (!cachedDefaultBridge) {
    cachedDefaultBridge = createHttpSseHostBridge()
  }

  return cachedDefaultBridge
}

export const getAshyHostClient = getAshyHostBridge
