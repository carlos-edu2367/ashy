import {
  ActionGatekeeper,
  PrivacyController,
  ProgressiveMcpRegistry,
  type ActionAuditLogEntry,
  type ApprovalScope,
  type EyesMode,
  type GatekeeperExecutionResult,
  type McpToolCompactSummary,
  type MicMode,
  type PendingActionCard,
  type PrivacyState,
} from '@ashy/agency'
import {
  applyEmotionSignalToMood,
  composeAshyTurnPrompt,
  evaluateSeriousnessGate,
  formatLocalTimeHHMM,
  inspectMotifCooldownStatus,
  proposeGroundedTraitEvolutions,
  rankEpisodicMemories,
  recordMotifInvocation,
  revertTraitEvolution as revertCortexTraitEvolution,
  reviewEpisodicMemory,
  selectEligibleMotifs,
  type ComposedTurnPrompt,
  type FsrsReviewRating,
  type MotifCooldownStatus,
  type RankedEpisodicMemory,
} from '@ashy/cortex'
import {
  CONTROL_SENTINEL,
  createTailSafeMarkerParser,
  stripLeadingAssistantSlop,
  type AshyStageSignal,
} from '@ashy/llm'
import {
  ASHY_BASELINE_MOOD,
  ASHY_DEFAULT_TRAITS,
  ASHY_EMOTIONS,
  ASHY_TRAIT_CORRIDORS,
  DEFAULT_ASHY_VOICE_MD,
  DEFAULT_MEMORY_GOVERNANCE_POLICY,
  DEFAULT_PROVIDER_CONFIGS,
  DEFAULT_VOICE_RUNTIME_SETTINGS,
  LLM_PROVIDER_IDS,
  type ApprovableMemoryKind,
  type AshyBootstrapSnapshot,
  type AshyEmotion,
  type AshyHostBridge,
  type AshyHostStreamEvent,
  type AutobiographicalMilestone,
  type ChatMessageRecord,
  type ChatSessionRecord,
  type CompleteOnboardingInput,
  type CoreExperimentEvalReport,
  type DeletableMemoryKind,
  type EpisodicMemory,
  type LlmProviderId,
  type MemoryGovernanceCategory,
  type MemoryGovernancePolicy,
  type MilestoneCategory,
  type MoodVector,
  type PersonalityEvolutionRecord,
  type PersonalityTraits,
  type ProspectiveIntent,
  type ProviderHealthResult,
  type PublicProviderConfig,
  type RelationalMotif,
  type RelationshipStage,
  type RunCoreExperimentInput,
  type SaveProviderConfigInput,
  type SemanticFact,
  type SemanticFactCategory,
  type SttProviderId,
  type TestProviderInput,
  type TtfaTelemetryRecord,
  type TtsProviderId,
  type UserHabit,
  type VoiceFixtureId,
  type VoiceRuntimeSettings,
} from '@ashy/shared'
import type { AshyPresenceStatus } from '@ashy/stage'
import {
  createRealtimeSpeechPipeline,
  createVoiceSessionRuntime,
  type PlaybackReceipt,
  type RealtimeSpeechPipeline,
  type ScheduledAudioChunk,
  type VoiceFixtureScenarioResult,
} from '@ashy/voice'
import { create } from 'zustand'
import { getAshyHostBridge } from '../services/ashy-host-client'
import { DEMO_MEMORY_CARDS } from '../test/fixtures/demo-seed'

export type DesktopViewMode = 'hub' | 'stage'
export type HubTabId = 'studio' | 'story' | 'memories' | 'personality' | 'agency'
export type MemoryFilterCategory = 'todas' | 'momentos' | 'sobre_voce' | 'referencias' | 'planos'
export type SettingsSubTab = 'geral' | 'voz' | 'modelos' | 'privacidade'

export interface FeaturedMemoryCard {
  id: string
  title: string
  summary: string
  fullStory: string
  dateLabel: string
  originLabel: string
  filterCategory: Exclude<MemoryFilterCategory, 'todas'>
  badge?: string
  image: string
  featured: boolean
  episodeId?: string
}

export type SupportedModelId =
  | 'claude-3-7-sonnet'
  | 'gpt-4.1'
  | 'deepseek-v3'
  | 'llama-3.3-70b-local'

export const SUPPORTED_MODELS: ReadonlyArray<{
  id: SupportedModelId
  label: string
  provider: string
  badge: string
}> = [
  {
    id: 'claude-3-7-sonnet',
    label: 'Claude 3.7 Sonnet',
    provider: 'Anthropic',
    badge: 'Cloud Flagship',
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    provider: 'OpenAI',
    badge: 'Fast Reasoning',
  },
  {
    id: 'deepseek-v3',
    label: 'DeepSeek V3',
    provider: 'OpenRouter',
    badge: 'Open-Weights MoE',
  },
  {
    id: 'llama-3.3-70b-local',
    label: 'Llama 3.3 70B (Local)',
    provider: 'Ollama Local',
    badge: '100% Offline',
  },
]

export interface ChatJokeCallbackCard {
  title: string
  description: string
  motifId: string
  memoryId: string
}

export interface ChatTurnMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  rawContent?: string
  emotion?: AshyEmotion
  modelId?: string
  invokedMotifId?: string
  seriousnessTriggered?: boolean
  timeLabel?: string
  jokeCard?: ChatJokeCallbackCard
  timestamp: number
}

export interface RoomTrophy {
  id: string
  title: string
  subtitle: string
  milestoneId: string
  unlocked: boolean
}

export interface TurnErrorState {
  code: 'PROVIDER_NOT_CONFIGURED' | 'LLM_REQUEST_FAILED' | 'INTERNAL_ERROR'
  message: string
  recoverable: boolean
}

export interface AshyDesktopState {
  // Navigation & View Mode
  viewMode: DesktopViewMode
  activeTab: HubTabId
  activeModelId: SupportedModelId

  // Phase 0/1 Host Runtime & Onboarding State
  isBootstrapped: boolean
  needsOnboarding: boolean
  userProfile: AshyBootstrapSnapshot['userProfile']
  relationshipStage: RelationshipStage
  familiarityScore: number
  trustScore: number
  totalTurns: number
  activeSessionId: string
  sessions: ChatSessionRecord[]
  providers: AshyBootstrapSnapshot['providers']
  voiceIdentity: AshyBootstrapSnapshot['voice']
  runtimeDiagnostics: AshyBootstrapSnapshot['runtimeDiagnostics']
  isStreamingTurn: boolean
  activeTurnId: string | null
  lastTurnError: TurnErrorState | null
  persistenceWarning: string | null

  // Stage & Procedural Controls
  stageMode: 'tachie' | 'live2d'
  stageEmotion: AshyEmotion
  emotionIntensity: number
  ambientLuminance: number
  isSpeaking: boolean
  presenceStatus: AshyPresenceStatus
  bubbleText: string
  simulatedVowels: { A: number; E: number; I: number; O: number; U: number }

  // Cortex Snapshots & Memory Governance
  mood: MoodVector
  traits: PersonalityTraits
  milestones: AutobiographicalMilestone[]
  episodicMemories: EpisodicMemory[]
  rankedMemories: RankedEpisodicMemory[]
  memoryCards: FeaturedMemoryCard[]
  selectedMemoryId: string
  memoryFilter: MemoryFilterCategory
  memorySearchQuery: string
  semanticFacts: SemanticFact[]
  relationalMotifs: RelationalMotif[]
  userHabits: UserHabit[]
  prospectiveIntents: ProspectiveIntent[]
  personalityEvolutionLog: PersonalityEvolutionRecord[]
  memoryGovernancePolicy: MemoryGovernancePolicy
  lastPrompt: ComposedTurnPrompt
  roomTrophies: RoomTrophy[]
  lastEvalReport: CoreExperimentEvalReport | null
  lastEvalError: string | null
  isRunningEval: boolean

  // Chat & Speech Pipeline
  chatMessages: ChatTurnMessage[]
  scheduledAudioChunks: ScheduledAudioChunk[]
  lastPlaybackReceipt: PlaybackReceipt | null
  lastStageSignals: AshyStageSignal[]
  voiceSettings: VoiceRuntimeSettings
  ttfaByProvider: Record<TtsProviderId, TtfaTelemetryRecord>
  pendingInterruptionControlNote: string | null
  lastTurnInterruptionNote: string | null
  voiceCasRejectedCount: number
  voiceCancelledShortCount: number
  lastVoiceFixtureResult: VoiceFixtureScenarioResult | null
  isPushToTalkHeld: boolean

  // Privacy, Settings & MCP Agency
  settingsSubTab: SettingsSubTab
  showDesktopAvatar: boolean
  computerActionsEnabled: boolean
  computerActionsPolicy: 'ask' | 'session' | 'off'
  quietHoursRange: string
  preferencesSavedToast: boolean
  privacyState: PrivacyState
  mcpSearchQuery: string
  mcpSearchResults: McpToolCompactSummary[]
  exposedMetaToolsCount: number
  registeredMcpToolsCount: number
  pendingActions: PendingActionCard[]
  auditLog: ActionAuditLogEntry[]
  lastMcpResultSummary: string | null

  // Host & Onboarding Actions
  bootstrapFromHost: () => Promise<AshyBootstrapSnapshot>
  applyBootstrapSnapshot: (snapshot: AshyBootstrapSnapshot) => void
  completeOnboarding: (input: CompleteOnboardingInput) => Promise<AshyBootstrapSnapshot>
  saveProviderConfig: (input: SaveProviderConfigInput) => Promise<{
    config: PublicProviderConfig
    providers: AshyBootstrapSnapshot['providers']
  }>
  setActiveProvider: (providerId: LlmProviderId) => Promise<AshyBootstrapSnapshot['providers']>
  testProviderConnection: (input: TestProviderInput) => Promise<ProviderHealthResult>
  saveVoiceIdentity: (content: string) => Promise<AshyBootstrapSnapshot['voice']>
  resetVoiceIdentity: () => Promise<AshyBootstrapSnapshot['voice']>
  createSession: (title?: string) => Promise<ChatSessionRecord>
  selectSession: (sessionId: string) => Promise<void>
  abortActiveTurn: () => Promise<void>
  seedDemoFixtures: () => Promise<AshyBootstrapSnapshot>
  runCoreExperimentEval: (input?: RunCoreExperimentInput) => Promise<CoreExperimentEvalReport>

  // Navigation & Stage Actions
  setViewMode: (mode: DesktopViewMode) => void
  setActiveTab: (tab: HubTabId) => void
  setActiveModelId: (modelId: SupportedModelId) => void
  setStageMode: (mode: 'tachie' | 'live2d') => void
  setStageEmotion: (emotion: AshyEmotion, intensity?: number) => void
  setAmbientLuminance: (luminance: number) => void
  toggleSimulatedSpeech: (speaking?: boolean) => void

  sendUserMessage: (userMessage: string) => Promise<void>
  triggerBargeIn: (interruptAtMs?: number) => PlaybackReceipt

  // Memory, Governance & Story Actions
  setSelectedMemoryId: (id: string) => void
  setMemoryFilter: (filter: MemoryFilterCategory) => void
  createMemoryCard: (input: {
    title: string
    summary: string
    fullStory?: string
    filterCategory?: Exclude<MemoryFilterCategory, 'todas'>
  }) => FeaturedMemoryCard
  updateMemoryStory: (id: string, newTitle: string, newStory: string) => void
  deleteMemoryCard: (id: string) => void
  deleteMemoryItem: (kind: DeletableMemoryKind, id: string) => Promise<void>
  consolidateSessionMemories: (force?: boolean) => Promise<void>
  approveMemoryItem: (kind: ApprovableMemoryKind, id: string) => Promise<void>
  setMemoryGovernancePolicy: (
    category: MemoryGovernanceCategory,
    requireConfirmation: boolean,
  ) => Promise<void>
  addMilestone: (input: {
    title: string
    narrative: string
    category: MilestoneCategory
  }) => AutobiographicalMilestone
  searchMemories: (query: string) => RankedEpisodicMemory[]
  reviewEpisodicMemoryById: (id: string, rating: FsrsReviewRating) => void
  invokeMotifManually: (motifId: string) => void
  resetMotifCooldown: (motifId: string) => void
  getMotifCooldownInfo: (motifId: string) => MotifCooldownStatus
  addSemanticFact: (input: {
    category: SemanticFactCategory
    subject: string
    predicate: string
    object: string
  }) => void
  completeProspectiveIntent: (intentId: string) => void

  // Personality & Dream Actions
  runDreamConsolidation: (nowMs?: number) => PersonalityEvolutionRecord
  revertTraitEvolution: (recordId: string) => PersonalityEvolutionRecord | null

  // Privacy, Settings & MCP Actions
  setSettingsSubTab: (subTab: SettingsSubTab) => void
  setShowDesktopAvatar: (show: boolean) => void
  setComputerActionsEnabled: (enabled: boolean) => void
  setComputerActionsPolicy: (policy: 'ask' | 'session' | 'off') => void
  setQuietHoursRange: (range: string) => void
  saveUserPreferences: () => void
  setMicMode: (mode: MicMode | 'push-to-talk') => void
  setActiveSttProvider: (providerId: SttProviderId) => void
  setActiveTtsProvider: (providerId: TtsProviderId) => void
  setWakeWordEnabled: (enabled: boolean) => void
  setPushToTalkHeld: (held: boolean) => Promise<void>
  runAudioFixtureSimulation: (fixtureId: VoiceFixtureId) => Promise<VoiceFixtureScenarioResult>
  runVoiceFixtureScenario: (fixtureId: VoiceFixtureId) => Promise<VoiceFixtureScenarioResult>
  setEyesMode: (mode: EyesMode) => void
  setDndMode: (enabled: boolean) => void
  activateFullPrivacyShield: () => void
  searchMcpTools: (query: string) => McpToolCompactSummary[]
  triggerMcpTool: (
    toolName: string,
    args?: Record<string, unknown>,
  ) => Promise<GatekeeperExecutionResult>
  approvePendingAction: (actionId: string, scope: ApprovalScope) => Promise<void>
  denyPendingAction: (actionId: string, reason?: string) => void

  resetStoreForTesting: () => void
}

function createAgencyRuntime() {
  const privacyController = new PrivacyController({
    micMode: 'continuous',
    eyesMode: 'window',
    dndMode: false,
    allowedWindowTitles: ['VS Code', 'Ashy', 'Terminal'],
    allowedPaths: ['/workspace/ashy', 'C:/Users/User/.gemini/antigravity/scratch/ashy'],
  })

  const gatekeeper = new ActionGatekeeper({
    privacyController,
  })

  const mcpRegistry = new ProgressiveMcpRegistry({
    gatekeeper,
  })

  mcpRegistry.registerServer({
    name: 'desktop-vision',
    description: 'Active window and screen observation sensor with dHash perceptual dedup',
  })
  mcpRegistry.registerServer({
    name: 'workspace-fs',
    description: 'Sandboxed workspace file reader protected against path traversal',
  })
  mcpRegistry.registerServer({
    name: 'workspace-notes',
    description: 'Project notes and architectural decision log writer',
  })
  mcpRegistry.registerServer({
    name: 'workspace-shell',
    description: 'Workspace build & cleanup runner with Blast-Radius Guard',
  })

  mcpRegistry.registerTools([
    {
      toolName: 'get_active_window_title',
      serverName: 'desktop-vision',
      description: 'Reads the currently focused desktop window title when EyesMode allows it.',
      riskTier: 'observe-only',
      inputSchema: {
        type: 'object',
        properties: {
          windowTitle: { type: 'string' },
        },
      },
      handler: (args) => ({
        observedWindow: String(args.windowTitle ?? 'Ashy Studio Window'),
        timestamp: Date.now(),
      }),
    },
    {
      toolName: 'read_workspace_file',
      serverName: 'workspace-fs',
      description: 'Reads a file strictly inside the allowed workspace directory.',
      riskTier: 'read-safe',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
      handler: (args) => ({
        path: String(args.path),
        preview: 'export const PACKAGE_NAME = "@ashy/desktop"',
      }),
    },
    {
      toolName: 'write_project_note',
      serverName: 'workspace-notes',
      description: 'Writes a markdown note to the project workspace (requires user confirmation).',
      riskTier: 'staged-confirm',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title'],
      },
      handler: (args) => ({
        saved: true,
        title: String(args.title ?? 'Untitled Note'),
      }),
    },
    {
      toolName: 'run_cleanup_command',
      serverName: 'workspace-shell',
      description: 'Executes a workspace shell cleanup command (inspected by Blast-Radius Guard).',
      riskTier: 'staged-confirm',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
      handler: (args) => ({
        executedCommand: String(args.command ?? ''),
        exitCode: 0,
      }),
    },
  ])

  return {
    privacyController,
    gatekeeper,
    mcpRegistry,
  }
}

function createInitialPublicProviders(): AshyBootstrapSnapshot['providers'] {
  const configs = {} as Record<LlmProviderId, PublicProviderConfig>
  for (const id of LLM_PROVIDER_IDS) {
    const def = DEFAULT_PROVIDER_CONFIGS[id]
    configs[id] = {
      providerId: id,
      label: def.label,
      baseUrl: def.baseUrl,
      modelId: def.modelId,
      requiresApiKey: def.requiresApiKey,
      hasApiKey: false,
      maskedApiKey: null,
      lastVerifiedAt: null,
      lastError: null,
    }
  }
  return {
    activeProviderId: 'openrouter',
    configs,
    hasActiveReadyProvider: false,
    diagnostics: {
      status: 'ok',
      updatedAt: 0,
    },
  }
}

function buildRoomTrophies(milestones: readonly AutobiographicalMilestone[]): RoomTrophy[] {
  const milestoneIds = new Set(milestones.map((m) => m.id))
  return [
    {
      id: 'trophy-first-boot-mug',
      title: 'First Boot Mug',
      subtitle: 'Unlocked by First Boot & Late-Night Architecture Session',
      milestoneId: 'milestone-first-meeting',
      unlocked: milestoneIds.has('milestone-first-meeting'),
    },
    {
      id: 'trophy-padre-npm-relic',
      title: 'Padre no NPM Relic',
      subtitle: "Unlocked by Born Inside Joke: 'Chamar um padre no npm'",
      milestoneId: 'milestone-inside-joke-padre',
      unlocked: milestoneIds.has('milestone-inside-joke-padre'),
    },
    {
      id: 'trophy-prod-shield',
      title: '03:14 AM Production Shield',
      subtitle: 'Unlocked by Saved Production Database at 03:14 AM',
      milestoneId: 'milestone-flashbulb-deploy',
      unlocked: milestoneIds.has('milestone-flashbulb-deploy'),
    },
  ]
}

function parseAssistantRawOutput(rawReply: string): {
  cleanText: string
  textWithSentinels: string
  signals: AshyStageSignal[]
} {
  let literalAccum = ''
  let sentinelAccum = ''
  const signals: AshyStageSignal[] = []

  const parser = createTailSafeMarkerParser({
    onLiteral(chunk) {
      literalAccum += chunk
      sentinelAccum += chunk
    },
    onSpecial(sig) {
      signals.push(sig)
      sentinelAccum += CONTROL_SENTINEL
    },
  })

  parser.write(rawReply)
  parser.flush()

  const cleanText = stripLeadingAssistantSlop(literalAccum).trim()
  const cleanSentinelText = stripLeadingAssistantSlop(sentinelAccum).trim()

  return {
    cleanText,
    textWithSentinels: cleanSentinelText,
    signals,
  }
}

function rankEpisodesInMemory(
  episodes: readonly EpisodicMemory[],
  query: string,
  nowMs = Date.now(),
): RankedEpisodicMemory[] {
  const approvedEpisodes = episodes.filter((ep) => ep.approvalStatus !== 'pending_review')
  const q = query.trim().toLowerCase()
  const filtered = q
    ? approvedEpisodes.filter(
        (ep) =>
          ep.title.toLowerCase().includes(q) ||
          ep.summary.toLowerCase().includes(q) ||
          ep.content.toLowerCase().includes(q) ||
          ep.tags.some((t) => t.toLowerCase().includes(q)),
      )
    : [...approvedEpisodes]

  return rankEpisodicMemories(filtered, {
    text: query,
    nowMs,
    limit: 10,
  })
}

function mapChatRecordsToTurnMessages(
  records: readonly ChatMessageRecord[],
  motifs: readonly RelationalMotif[],
): ChatTurnMessage[] {
  const result: ChatTurnMessage[] = []
  for (const rec of records) {
    if (rec.role !== 'user' && rec.role !== 'assistant') continue
    let invokedMotifId: string | undefined
    let jokeCard: ChatJokeCallbackCard | undefined

    if (rec.role === 'assistant' && rec.markersJson) {
      try {
        const parsedMarkers = JSON.parse(rec.markersJson) as Array<{
          type?: string
          motifId?: string
        }>
        if (Array.isArray(parsedMarkers)) {
          const cb = parsedMarkers.find((m) => m.type === 'callback' && typeof m.motifId === 'string')
          if (cb?.motifId) {
            invokedMotifId = cb.motifId
            const matchedMotif = motifs.find(
              (j) => j.id === cb.motifId && j.approvalStatus !== 'pending_review',
            )
            if (matchedMotif) {
              jokeCard = {
                title: 'Uma piada nossa',
                description: matchedMotif.originSummary,
                motifId: matchedMotif.id,
                memoryId: matchedMotif.originEpisodeId ?? '',
              }
            }
          }
        }
      } catch {
        // Ignore malformed markersJson
      }
    }

    result.push({
      id: rec.id,
      role: rec.role,
      content: rec.content,
      rawContent: rec.rawContent,
      emotion: rec.emotion,
      modelId: rec.modelId ?? undefined,
      invokedMotifId,
      timeLabel: formatLocalTimeHHMM(rec.createdAt),
      jokeCard,
      timestamp: rec.createdAt,
    })
  }
  return result
}

function mapEpisodesToMemoryCards(
  episodes: readonly EpisodicMemory[],
  existingCards: readonly FeaturedMemoryCard[],
): FeaturedMemoryCard[] {
  const approvedEpisodes = episodes.filter((ep) => ep.approvalStatus !== 'pending_review')
  const hasDemoSeed =
    DEMO_MEMORY_CARDS.length > 0 &&
    approvedEpisodes.some((ep) => ep.id === DEMO_MEMORY_CARDS[0]?.id)

  const baseCards: FeaturedMemoryCard[] = hasDemoSeed
    ? DEMO_MEMORY_CARDS.map((card) => {
        const edited = existingCards.find((c) => c.id === card.id)
        return edited ? { ...edited } : { ...card }
      })
    : []

  const seenEpisodeIds = new Set<string>()
  const seenCardIds = new Set<string>()
  for (const card of baseCards) {
    seenCardIds.add(card.id)
    if (card.episodeId) seenEpisodeIds.add(card.episodeId)
  }

  const dynamicCards: FeaturedMemoryCard[] = []
  for (const ep of approvedEpisodes) {
    if (seenCardIds.has(ep.id) || seenEpisodeIds.has(ep.id)) continue
    const existing = existingCards.find((c) => c.id === ep.id)
    if (existing) {
      dynamicCards.push(existing)
      continue
    }
    const categoryTag = ep.tags.find(
      (t): t is Exclude<MemoryFilterCategory, 'todas'> =>
        t === 'momentos' || t === 'sobre_voce' || t === 'referencias' || t === 'planos',
    )
    dynamicCards.push({
      id: ep.id,
      title: ep.title,
      summary: ep.summary,
      fullStory: ep.content,
      dateLabel: formatLocalTimeHHMM(ep.createdAt),
      originLabel: 'Conversa registrada',
      filterCategory: categoryTag ?? 'momentos',
      image: '/assets/mem-first-chat.jpg',
      featured: ep.isFlashbulb,
      episodeId: ep.id,
    })
  }

  return [...dynamicCards, ...baseCards]
}

let agency = createAgencyRuntime()
let voiceRuntime = createVoiceSessionRuntime({
  micMode: 'continuous',
  wakeWordEnabled: DEFAULT_VOICE_RUNTIME_SETTINGS.wakeWordEnabled,
  wakeWordPhrases: DEFAULT_VOICE_RUNTIME_SETTINGS.wakeWordPhrases,
  activeSttProviderId: DEFAULT_VOICE_RUNTIME_SETTINGS.activeSttProviderId,
  activeTtsProviderId: DEFAULT_VOICE_RUNTIME_SETTINGS.activeTtsProviderId,
})
let activeSpeechPipeline: RealtimeSpeechPipeline | null = null
let firstDeltaEnqueuedAtMs: number | null = null
let firstChunkRecordedForTurn = false
let subscribedBridge: AshyHostBridge | null = null
let unsubscribeHostEvents: (() => void) | null = null
let lastPromptMinuteLabel = formatLocalTimeHHMM(Date.now())
let evalRunSeq = 0

const completedTurnEvents = new Map<string, AshyHostStreamEvent>()
const pendingTurnResolvers = new Map<string, () => void>()
const pendingTurnSeriousness = new Map<string, boolean>()
const streamedDeltaTurnIds = new Set<string>()
const bargeInTurnIds = new Set<string>()

export const useAshyStore = create<AshyDesktopState>((set, get) => {
  function compilePromptFromState(params?: {
    userMessage?: string
    modelId?: string
    stage?: RelationshipStage
    voiceIdentityMarkdown?: string
    userName?: string | null
    userPronouns?: string | null
    semanticFacts?: readonly SemanticFact[]
    traits?: PersonalityTraits
    mood?: MoodVector
    rankedMemories?: readonly RankedEpisodicMemory[]
    relationalMotifs?: readonly RelationalMotif[]
    userHabits?: readonly UserHabit[]
    prospectiveIntents?: readonly ProspectiveIntent[]
    chatMessages?: readonly ChatTurnMessage[]
    interruptionControlNote?: string
  }): ComposedTurnPrompt {
    const current = get()
    const userMessage =
      params?.userMessage ??
      [...(params?.chatMessages ?? current?.chatMessages ?? [])]
        .reverse()
        .find((m) => m.role === 'user')?.content ??
      'Olá Ashy.'

    const modelId = params?.modelId ?? current?.activeModelId ?? 'claude-3-7-sonnet'
    const seriousness = evaluateSeriousnessGate(userMessage)
    const baseMood = params?.mood ?? current?.mood ?? ASHY_BASELINE_MOOD
    const effectiveMood: MoodVector = seriousness.isSeriousOrDelicate
      ? {
          ...baseMood,
          playfulness: Math.min(baseMood.playfulness, seriousness.maxPlayfulnessAllowed),
        }
      : baseMood

    const motifs = (params?.relationalMotifs ?? current?.relationalMotifs ?? []).filter(
      (m) => m.approvalStatus !== 'pending_review',
    )
    const eligibleMotifs = selectEligibleMotifs(motifs, userMessage, Date.now(), {
      isSeriousContext: seriousness.isSeriousOrDelicate,
    })

    const facts = (params?.semanticFacts ?? current?.semanticFacts ?? []).filter(
      (f) =>
        (f.invalidAt === null || f.invalidAt === undefined) &&
        f.approvalStatus !== 'pending_review',
    )

    const retrievedMemories = (params?.rankedMemories ?? current?.rankedMemories ?? [])
      .filter((r) => r.memory.approvalStatus !== 'pending_review')
      .slice(0, 4)

    const habits = (params?.userHabits ?? current?.userHabits ?? []).filter(
      (h) => h.approvalStatus !== 'pending_review',
    )

    const intents = (
      params?.prospectiveIntents ??
      current?.prospectiveIntents ??
      []
    ).filter((i) => i.approvalStatus !== 'pending_review' && i.status === 'pending')

    return composeAshyTurnPrompt({
      userMessage,
      modelId,
      timeOfDayLabel: lastPromptMinuteLabel,
      stage: params?.stage ?? current?.relationshipStage ?? 'stranger',
      voiceIdentityMarkdown:
        params?.voiceIdentityMarkdown ?? current?.voiceIdentity?.content ?? DEFAULT_ASHY_VOICE_MD,
      userName:
        params?.userName !== undefined ? params.userName : (current?.userProfile?.userName ?? null),
      userPronouns:
        params?.userPronouns !== undefined
          ? params.userPronouns
          : (current?.userProfile?.userPronouns ?? null),
      semanticFacts: facts,
      traits: params?.traits ?? current?.traits ?? ASHY_DEFAULT_TRAITS,
      mood: effectiveMood,
      seriousness,
      retrievedMemories,
      eligibleMotifs,
      userHabits: habits,
      prospectiveIntents: intents,
      interruptionControlNote: params?.interruptionControlNote,
      conversationHistory: (params?.chatMessages ?? current?.chatMessages ?? []).map((m) => ({
        role: m.role,
        content: m.content,
      })),
    })
  }

  function createPipelineForTurn(): RealtimeSpeechPipeline {
    firstDeltaEnqueuedAtMs = null
    firstChunkRecordedForTurn = false
    const pipeline = createRealtimeSpeechPipeline({
      synthesizeFn: async (text) => {
        const wordCount = Math.max(1, text.trim().split(/\s+/).length)
        const durationMs = Math.max(450, wordCount * 120)
        return {
          providerId: get().voiceSettings.activeTtsProviderId,
          durationMs,
          durationSec: durationMs / 1000,
        }
      },
      onAudioScheduled: () => {
        const chunks = [...pipeline.getScheduledChunks()]
        if (!firstChunkRecordedForTurn && firstDeltaEnqueuedAtMs !== null) {
          firstChunkRecordedForTurn = true
          const ttfaMs = Math.max(1, Math.round(performance.now() - firstDeltaEnqueuedAtMs))
          const providerId = get().voiceSettings.activeTtsProviderId
          voiceRuntime.recordTtfaSample(providerId, ttfaMs)
        }
        set({
          scheduledAudioChunks: chunks,
          ttfaByProvider: voiceRuntime.getTtfaTelemetry(),
        })
      },
      onStageSignal: (signal) => {
        if (signal.type === 'act' && signal.emotion) {
          set({
            stageEmotion: signal.emotion,
            emotionIntensity: signal.intensity ?? 0.85,
          })
        }
      },
    })
    activeSpeechPipeline = pipeline
    return pipeline
  }

  function handleHostStreamEvent(event: AshyHostStreamEvent): void {
    const assistantMsgId = `msg-assistant-${event.turnId}`

    if (event.type === 'turn:started') {
      streamedDeltaTurnIds.delete(event.turnId)
      bargeInTurnIds.delete(event.turnId)
      createPipelineForTurn()
      set((state) => {
        const hasAssistantMsg = state.chatMessages.some((m) => m.id === assistantMsgId)
        return {
          isStreamingTurn: true,
          activeTurnId: event.turnId,
          lastTurnError: null,
          presenceStatus: 'Thinking',
          scheduledAudioChunks: [],
          chatMessages: hasAssistantMsg
            ? state.chatMessages
            : [
                ...state.chatMessages,
                {
                  id: assistantMsgId,
                  role: 'assistant',
                  content: '',
                  emotion: state.stageEmotion,
                  modelId: state.activeModelId,
                  timeLabel: formatLocalTimeHHMM(event.startedAt),
                  timestamp: event.startedAt,
                },
              ],
        }
      })
      return
    }

    if (event.type === 'turn:delta') {
      const pipeline = activeSpeechPipeline ?? createPipelineForTurn()
      if (firstDeltaEnqueuedAtMs === null) {
        firstDeltaEnqueuedAtMs = performance.now()
      }
      streamedDeltaTurnIds.add(event.turnId)
      pipeline.enqueueDelta(event.textDelta)

      set((state) => {
        const exists = state.chatMessages.some((m) => m.id === assistantMsgId)
        const updatedMessages = exists
          ? state.chatMessages.map((m) =>
              m.id === assistantMsgId ? { ...m, content: m.content + event.textDelta } : m,
            )
          : [
              ...state.chatMessages,
              {
                id: assistantMsgId,
                role: 'assistant' as const,
                content: event.textDelta,
                emotion: state.stageEmotion,
                modelId: state.activeModelId,
                timeLabel: formatLocalTimeHHMM(Date.now()),
                timestamp: Date.now(),
              },
            ]
        const latestContent =
          updatedMessages.find((m) => m.id === assistantMsgId)?.content ?? event.textDelta

        return {
          chatMessages: updatedMessages,
          bubbleText: latestContent,
          isSpeaking: true,
          presenceStatus: 'Speaking',
          simulatedVowels: { A: 0.75, E: 0.4, I: 0.2, O: 0.5, U: 0.15 },
        }
      })
      return
    }

    if (event.type === 'turn:marker') {
      const marker = event.marker
      if (marker.type === 'act' && marker.emotion) {
        const nextEmotion = marker.emotion
        const nextIntensity = marker.intensity ?? 0.85
        const actSignal: AshyStageSignal = {
          type: 'act',
          emotion: nextEmotion,
          intensity: nextIntensity,
          raw: `<|ACT {"emotion":"${nextEmotion}","intensity":${nextIntensity}}|>`,
        }
        const pipeline = activeSpeechPipeline ?? createPipelineForTurn()
        if (firstDeltaEnqueuedAtMs === null) {
          firstDeltaEnqueuedAtMs = performance.now()
        }
        pipeline.enqueue(CONTROL_SENTINEL, [actSignal], { flush: false })

        set((state) => ({
          stageEmotion: nextEmotion,
          emotionIntensity: nextIntensity,
          lastStageSignals: [...state.lastStageSignals, actSignal],
          chatMessages: state.chatMessages.map((m) =>
            m.id === assistantMsgId ? { ...m, emotion: nextEmotion } : m,
          ),
        }))
        return
      }

      if (marker.type === 'callback') {
        const matchedMotif = get().relationalMotifs.find(
          (j) => j.id === marker.motifId && j.approvalStatus !== 'pending_review',
        )
        const jokeCard: ChatJokeCallbackCard | undefined = matchedMotif
          ? {
              title: 'Uma piada nossa',
              description: matchedMotif.originSummary,
              motifId: matchedMotif.id,
              memoryId: matchedMotif.originEpisodeId ?? '',
            }
          : undefined

        set((state) => ({
          lastStageSignals: [
            ...state.lastStageSignals,
            {
              type: 'callback',
              motifId: marker.motifId,
              raw: `<|CALLBACK motif="${marker.motifId}"|>`,
            },
          ],
          chatMessages: state.chatMessages.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  invokedMotifId: marker.motifId,
                  ...(jokeCard ? { jokeCard } : {}),
                }
              : m,
          ),
        }))
        return
      }

      if (marker.type === 'delay') {
        const delaySignal: AshyStageSignal = {
          type: 'delay',
          seconds: marker.seconds,
          raw: `<|DELAY ${marker.seconds}|>`,
        }
        const pipeline = activeSpeechPipeline ?? createPipelineForTurn()
        if (firstDeltaEnqueuedAtMs === null) {
          firstDeltaEnqueuedAtMs = performance.now()
        }
        pipeline.enqueue(CONTROL_SENTINEL, [delaySignal], { flush: false })

        set((state) => ({
          lastStageSignals: [...state.lastStageSignals, delaySignal],
        }))
      }
      return
    }

    if (event.type === 'turn:keepalive') {
      set({
        presenceStatus: 'Thinking',
      })
      return
    }

    if (event.type === 'turn:completed') {
      void (async () => {
        const parsed = parseAssistantRawOutput(
          event.assistantMessage.rawContent || event.assistantMessage.content,
        )
        const hadStreamedDeltas = streamedDeltaTurnIds.delete(event.turnId)
        const pipeline =
          hadStreamedDeltas && activeSpeechPipeline
            ? activeSpeechPipeline
            : createPipelineForTurn()

        if (firstDeltaEnqueuedAtMs === null) {
          firstDeltaEnqueuedAtMs = performance.now()
        }

        if (hadStreamedDeltas) {
          pipeline.flush()
        } else {
          pipeline.enqueue(
            parsed.textWithSentinels || event.assistantMessage.content,
            parsed.signals,
          )
        }
        await Promise.resolve()
        await Promise.resolve()

        const scheduledChunks = [...pipeline.getScheduledChunks()]
        const wasSerious = pendingTurnSeriousness.get(event.turnId) === true
        pendingTurnSeriousness.delete(event.turnId)

        get().applyBootstrapSnapshot(event.snapshot)

        const targetEmotion: AshyEmotion = wasSerious
          ? 'concerned'
          : event.assistantMessage.emotion

        set((state) => ({
          isStreamingTurn: false,
          activeTurnId: null,
          persistenceWarning: event.persistenceWarning,
          stageEmotion: targetEmotion,
          mood: wasSerious
            ? {
                ...state.mood,
                playfulness: Math.min(0.12, state.mood.playfulness),
              }
            : state.mood,
          bubbleText: event.assistantMessage.content,
          isSpeaking: true,
          presenceStatus: 'Speaking',
          simulatedVowels: { A: 0.75, E: 0.4, I: 0.2, O: 0.5, U: 0.15 },
          scheduledAudioChunks: scheduledChunks,
          ttfaByProvider: voiceRuntime.getTtfaTelemetry(),
          lastStageSignals: parsed.signals,
          chatMessages: state.chatMessages.map((m) =>
            m.id === event.assistantMessage.id
              ? {
                  ...m,
                  emotion: targetEmotion,
                  seriousnessTriggered: wasSerious,
                }
              : m,
          ),
        }))

        completedTurnEvents.set(event.turnId, event)
        const resolver = pendingTurnResolvers.get(event.turnId)
        if (resolver) {
          pendingTurnResolvers.delete(event.turnId)
          resolver()
        }
      })()
      return
    }

    if (event.type === 'turn:aborted') {
      pendingTurnSeriousness.delete(event.turnId)
      streamedDeltaTurnIds.delete(event.turnId)
      const wasBargeIn = bargeInTurnIds.delete(event.turnId)
      set((state) => ({
        isStreamingTurn: false,
        activeTurnId: null,
        isSpeaking: false,
        presenceStatus: wasBargeIn ? 'Listening' : 'Idle',
        stageEmotion: wasBargeIn ? 'surprised' : state.stageEmotion,
        bubbleText: state.bubbleText,
        simulatedVowels: { A: 0, E: 0, I: 0, O: 0, U: 0 },
      }))
      completedTurnEvents.set(event.turnId, event)
      const resolver = pendingTurnResolvers.get(event.turnId)
      if (resolver) {
        pendingTurnResolvers.delete(event.turnId)
        resolver()
      }
      return
    }

    if (event.type === 'turn:error') {
      pendingTurnSeriousness.delete(event.turnId)
      set((state) => ({
        isStreamingTurn: false,
        activeTurnId: null,
        isSpeaking: false,
        presenceStatus: 'Idle',
        simulatedVowels: { A: 0, E: 0, I: 0, O: 0, U: 0 },
        lastTurnError: {
          code: event.code,
          message: event.message,
          recoverable: event.recoverable,
        },
        chatMessages: state.chatMessages.filter(
          (m) => !(m.id === assistantMsgId && m.content.trim().length === 0),
        ),
      }))
      completedTurnEvents.set(event.turnId, event)
      const resolver = pendingTurnResolvers.get(event.turnId)
      if (resolver) {
        pendingTurnResolvers.delete(event.turnId)
        resolver()
      }
    }
  }

  function ensureHostSubscription(): AshyHostBridge {
    const bridge = getAshyHostBridge()
    if (subscribedBridge !== bridge) {
      unsubscribeHostEvents?.()
      subscribedBridge = bridge
      unsubscribeHostEvents = bridge.onHostEvent(handleHostStreamEvent)
    }
    return bridge
  }

  const initialPrompt = composeAshyTurnPrompt({
    userMessage: 'Olá Ashy.',
    modelId: 'claude-3-7-sonnet',
    timeOfDayLabel: lastPromptMinuteLabel,
    stage: 'stranger',
    voiceIdentityMarkdown: DEFAULT_ASHY_VOICE_MD,
    traits: ASHY_DEFAULT_TRAITS,
    mood: ASHY_BASELINE_MOOD,
  })

  return {
    viewMode:
      typeof window !== 'undefined' && window.location?.search?.includes('view=stage')
        ? 'stage'
        : 'hub',
    activeTab: 'studio',
    activeModelId: 'claude-3-7-sonnet',

    isBootstrapped: false,
    needsOnboarding: true,
    userProfile: {
      userName: null,
      userPronouns: null,
    },
    relationshipStage: 'stranger',
    familiarityScore: 0,
    trustScore: 0.1,
    totalTurns: 0,
    activeSessionId: 'session-initial',
    sessions: [],
    providers: createInitialPublicProviders(),
    voiceIdentity: {
      content: DEFAULT_ASHY_VOICE_MD,
      diagnostics: {
        status: 'ok',
        updatedAt: 0,
      },
      updatedAt: 0,
    },
    runtimeDiagnostics: {
      dbMode: 'wal',
      dbPath: '',
      lastPersistenceWarning: null,
    },
    isStreamingTurn: false,
    activeTurnId: null,
    lastTurnError: null,
    persistenceWarning: null,

    stageMode: 'tachie',
    stageEmotion: 'neutral',
    emotionIntensity: 0.85,
    ambientLuminance: 0.35,
    isSpeaking: false,
    presenceStatus: 'Idle',
    bubbleText: 'Fico por aqui. No seu ritmo. ♡',
    simulatedVowels: { A: 0.65, E: 0.25, I: 0.1, O: 0.35, U: 0.15 },

    mood: { ...ASHY_BASELINE_MOOD },
    traits: { ...ASHY_DEFAULT_TRAITS },
    milestones: [],
    episodicMemories: [],
    rankedMemories: [],
    memoryCards: [],
    selectedMemoryId: '',
    memoryFilter: 'todas',
    memorySearchQuery: '',
    semanticFacts: [],
    relationalMotifs: [],
    userHabits: [],
    prospectiveIntents: [],
    personalityEvolutionLog: [],
    memoryGovernancePolicy: { ...DEFAULT_MEMORY_GOVERNANCE_POLICY },
    lastPrompt: initialPrompt,
    roomTrophies: buildRoomTrophies([]),
    lastEvalReport: null,
    lastEvalError: null,
    isRunningEval: false,

    chatMessages: [],
    scheduledAudioChunks: [],
    lastPlaybackReceipt: null,
    lastStageSignals: [],
    voiceSettings: {
      ...DEFAULT_VOICE_RUNTIME_SETTINGS,
      wakeWordPhrases: [...DEFAULT_VOICE_RUNTIME_SETTINGS.wakeWordPhrases],
    },
    ttfaByProvider: voiceRuntime.getTtfaTelemetry(),
    pendingInterruptionControlNote: null,
    lastTurnInterruptionNote: null,
    voiceCasRejectedCount: 0,
    voiceCancelledShortCount: 0,
    lastVoiceFixtureResult: null,
    isPushToTalkHeld: false,

    settingsSubTab: 'privacidade',
    showDesktopAvatar: true,
    computerActionsEnabled: true,
    computerActionsPolicy: 'ask',
    quietHoursRange: '22:00 — 08:00',
    preferencesSavedToast: false,
    privacyState: agency.privacyController.getState(),
    mcpSearchQuery: '',
    mcpSearchResults: agency.mcpRegistry.search_mcp_tools({ query: '', limit: 10 }),
    exposedMetaToolsCount: agency.mcpRegistry.getExposedMetaTools().length,
    registeredMcpToolsCount: agency.mcpRegistry.getRegisteredToolsCount(),
    pendingActions: agency.gatekeeper.getPendingActions(),
    auditLog: [...agency.gatekeeper.getAuditLog()],
    lastMcpResultSummary: null,

    async bootstrapFromHost() {
      const bridge = ensureHostSubscription()
      const snapshot = await bridge.getBootstrapSnapshot()
      get().applyBootstrapSnapshot(snapshot)
      return snapshot
    },

    applyBootstrapSnapshot(snapshot) {
      const current = get()
      const ranked = rankEpisodesInMemory(
        snapshot.memories.episodes,
        current.memorySearchQuery,
      )
      const mappedMessages = mapChatRecordsToTurnMessages(
        snapshot.messages,
        snapshot.memories.jokes,
      )
      const mappedCards = mapEpisodesToMemoryCards(
        snapshot.memories.episodes,
        current.memoryCards,
      )
      const nextSelectedMemoryId =
        mappedCards.some((c) => c.id === current.selectedMemoryId) && current.selectedMemoryId
          ? current.selectedMemoryId
          : (mappedCards[0]?.id ?? '')

      const userHabits = snapshot.memories.habits ?? current.userHabits
      const prospectiveIntents = snapshot.memories.intents ?? current.prospectiveIntents
      const personalityEvolutionLog =
        snapshot.memories.evolutionLog ?? current.personalityEvolutionLog
      const memoryGovernancePolicy =
        snapshot.memories.governancePolicy ?? current.memoryGovernancePolicy

      const nextPrompt = compilePromptFromState({
        modelId: current.activeModelId,
        stage: snapshot.relationship.stage,
        voiceIdentityMarkdown: snapshot.voice.content,
        userName: snapshot.userProfile.userName,
        userPronouns: snapshot.userProfile.userPronouns,
        semanticFacts: snapshot.memories.facts,
        traits: snapshot.affect.traits,
        mood: snapshot.affect.mood,
        rankedMemories: ranked,
        relationalMotifs: snapshot.memories.jokes,
        userHabits,
        prospectiveIntents,
        chatMessages: mappedMessages,
        interruptionControlNote: current.lastTurnInterruptionNote ?? undefined,
      })

      set({
        isBootstrapped: true,
        needsOnboarding: snapshot.needsOnboarding,
        userProfile: snapshot.userProfile,
        relationshipStage: snapshot.relationship.stage,
        familiarityScore: snapshot.relationship.familiarityScore,
        trustScore: snapshot.relationship.trustScore,
        totalTurns: snapshot.relationship.totalTurns,
        activeSessionId: snapshot.activeSession.id,
        sessions: snapshot.sessions,
        providers: snapshot.providers,
        voiceIdentity: snapshot.voice,
        runtimeDiagnostics: snapshot.runtimeDiagnostics,
        persistenceWarning: snapshot.runtimeDiagnostics.lastPersistenceWarning,
        mood: snapshot.affect.mood,
        traits: snapshot.affect.traits,
        stageEmotion: snapshot.affect.dominantEmotion,
        milestones: snapshot.relationship.milestones,
        episodicMemories: snapshot.memories.episodes,
        rankedMemories: ranked,
        memoryCards: mappedCards,
        selectedMemoryId: nextSelectedMemoryId,
        semanticFacts: snapshot.memories.facts,
        relationalMotifs: snapshot.memories.jokes,
        userHabits,
        prospectiveIntents,
        personalityEvolutionLog,
        memoryGovernancePolicy,
        chatMessages: mappedMessages,
        lastPrompt: nextPrompt,
        roomTrophies: buildRoomTrophies(snapshot.relationship.milestones),
        lastEvalReport: snapshot.lastEvalReport ?? current.lastEvalReport,
      })
    },

    async completeOnboarding(input) {
      const bridge = ensureHostSubscription()
      const snapshot = await bridge.completeOnboarding(input)
      get().applyBootstrapSnapshot(snapshot)
      return snapshot
    },

    async saveProviderConfig(input) {
      const bridge = ensureHostSubscription()
      const result = await bridge.saveProviderConfig(input)
      set({ providers: result.providers })
      return result
    },

    async setActiveProvider(providerId) {
      const bridge = ensureHostSubscription()
      const providers = await bridge.setActiveProvider(providerId)
      set({ providers })
      return providers
    },

    async testProviderConnection(input) {
      const bridge = ensureHostSubscription()
      const result = await bridge.testProviderConnection(input)
      try {
        const snapshot = await bridge.getBootstrapSnapshot()
        set({ providers: snapshot.providers })
      } catch {
        // Ignore snapshot refresh failure during probe
      }
      return result
    },

    async saveVoiceIdentity(content) {
      const bridge = ensureHostSubscription()
      const voice = await bridge.saveVoiceIdentity(content)
      set((state) => ({
        voiceIdentity: voice,
        lastPrompt: compilePromptFromState({
          voiceIdentityMarkdown: voice.content,
          modelId: state.activeModelId,
        }),
      }))
      return voice
    },

    async resetVoiceIdentity() {
      const bridge = ensureHostSubscription()
      const voice = await bridge.resetVoiceIdentity()
      set((state) => ({
        voiceIdentity: voice,
        lastPrompt: compilePromptFromState({
          voiceIdentityMarkdown: voice.content,
          modelId: state.activeModelId,
        }),
      }))
      return voice
    },

    async createSession(title) {
      const bridge = ensureHostSubscription()
      const session = await bridge.createSession(title)
      const snapshot = await bridge.getBootstrapSnapshot()
      get().applyBootstrapSnapshot(snapshot)
      return session
    },

    async selectSession(sessionId) {
      const bridge = ensureHostSubscription()
      await bridge.selectSession(sessionId)
      const snapshot = await bridge.getBootstrapSnapshot()
      get().applyBootstrapSnapshot(snapshot)
    },

    async abortActiveTurn() {
      const turnId = get().activeTurnId
      if (!turnId) return
      const bridge = ensureHostSubscription()
      await bridge.abortTurn(turnId)
    },

    async seedDemoFixtures() {
      const bridge = ensureHostSubscription()
      const snapshot = await bridge.seedDemoFixtures()
      get().applyBootstrapSnapshot(snapshot)
      return snapshot
    },

    async runCoreExperimentEval(input) {
      const bridge = ensureHostSubscription()
      evalRunSeq += 1
      const currentSeq = evalRunSeq
      set({ isRunningEval: true, lastEvalError: null })
      try {
        const report = await bridge.runCoreExperimentEval(input)
        if (currentSeq === evalRunSeq) {
          set({
            lastEvalReport: report,
            lastEvalError: null,
            isRunningEval: false,
          })
        }
        return report
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (currentSeq === evalRunSeq) {
          set({
            isRunningEval: false,
            lastEvalError: message,
          })
        }
        throw err
      }
    },

    setViewMode(mode) {
      set({ viewMode: mode })
    },

    setActiveTab(tab) {
      set({ activeTab: tab })
    },

    setActiveModelId(modelId) {
      const compiled = compilePromptFromState({
        modelId,
      })
      set({
        activeModelId: modelId,
        lastPrompt: compiled,
      })
    },

    setStageMode(mode) {
      set({ stageMode: mode })
    },

    setStageEmotion(emotion, intensity = 0.85) {
      if (!ASHY_EMOTIONS.includes(emotion)) return
      const nextMood = applyEmotionSignalToMood(get().mood, emotion, intensity)
      set({
        stageEmotion: emotion,
        emotionIntensity: intensity,
        mood: nextMood,
      })
      void getAshyHostBridge()
        .recordEmotionPulse({ emotion, intensity })
        .catch(() => {
          // Ignore when offline in unit test
        })
    },

    setAmbientLuminance(luminance) {
      const clamped = Math.min(1, Math.max(0, Number.isFinite(luminance) ? luminance : 0.35))
      set({ ambientLuminance: clamped })
    },

    toggleSimulatedSpeech(speaking) {
      const nextSpeaking = speaking !== undefined ? speaking : !get().isSpeaking
      set({
        isSpeaking: nextSpeaking,
        presenceStatus: nextSpeaking ? 'Speaking' : 'Idle',
        simulatedVowels: nextSpeaking
          ? { A: 0.78, E: 0.35, I: 0.15, O: 0.45, U: 0.2 }
          : { A: 0, E: 0, I: 0, O: 0, U: 0 },
      })
    },

    async sendUserMessage(userMessage: string) {
      const trimmed = userMessage.trim()
      if (!trimmed) return

      const bridge = ensureHostSubscription()
      const current = get()
      const interruptionNote = current.pendingInterruptionControlNote ?? undefined
      set({
        pendingInterruptionControlNote: null,
        lastTurnInterruptionNote: interruptionNote ?? null,
      })

      const seriousness = evaluateSeriousnessGate(trimmed)
      const compiledPrompt = compilePromptFromState({
        userMessage: trimmed,
        modelId: current.activeModelId,
        interruptionControlNote: interruptionNote,
      })

      if (seriousness.isSeriousOrDelicate) {
        const seriousMood: MoodVector = {
          valence: -0.1,
          arousal: 0.35,
          playfulness: Math.min(0.12, seriousness.maxPlayfulnessAllowed),
        }
        set({
          lastPrompt: compiledPrompt,
          stageEmotion: 'concerned',
          mood: seriousMood,
        })
      } else {
        set({
          lastPrompt: compiledPrompt,
        })
      }

      const { turnId, userMessage: savedUserMsg } = await bridge.sendTurn({
        sessionId: get().activeSessionId,
        text: trimmed,
        ...(interruptionNote ? { interruptionControlNote: interruptionNote } : {}),
      })

      pendingTurnSeriousness.set(turnId, seriousness.isSeriousOrDelicate)

      set((state) => {
        const hasUserMsg = state.chatMessages.some((m) => m.id === savedUserMsg.id)
        if (hasUserMsg) return {}
        const userTurn: ChatTurnMessage = {
          id: savedUserMsg.id,
          role: 'user',
          content: savedUserMsg.content,
          timeLabel: formatLocalTimeHHMM(savedUserMsg.createdAt),
          timestamp: savedUserMsg.createdAt,
        }
        return {
          chatMessages: [...state.chatMessages, userTurn],
        }
      })

      if (completedTurnEvents.has(turnId)) {
        completedTurnEvents.delete(turnId)
        return
      }

      await new Promise<void>((resolve) => {
        pendingTurnResolvers.set(turnId, resolve)
      })
      completedTurnEvents.delete(turnId)
    },

    triggerBargeIn(interruptAtMs = 600) {
      const activeTurnId = get().activeTurnId
      if (activeTurnId !== null) {
        bargeInTurnIds.add(activeTurnId)
        void get().abortActiveTurn()
      }

      let pipeline = activeSpeechPipeline
      if (!pipeline || (pipeline.getScheduledChunks().length === 0 && !get().isStreamingTurn)) {
        pipeline = createPipelineForTurn()
        pipeline.enqueue(
          'Olha só, eu estava explicando toda a arquitetura de memória episódica FSRS-6. Mas você me cortou bem no meio da frase!',
          [],
        )
      }

      const interruptSec = Math.max(0.05, interruptAtMs / 1000)
      const receipt = pipeline.interrupt('user_barge_in', interruptSec)

      set({
        isSpeaking: false,
        presenceStatus: 'Listening',
        stageEmotion: 'surprised',
        simulatedVowels: { A: 0, E: 0, I: 0, O: 0, U: 0 },
        lastPlaybackReceipt: receipt,
        pendingInterruptionControlNote: receipt.controlNote,
        bubbleText: `${receipt.heardText} — [Barge-In!]`,
      })

      return receipt
    },

    setSelectedMemoryId(id) {
      set({ selectedMemoryId: id })
    },

    setMemoryFilter(filter) {
      set({ memoryFilter: filter })
    },

    createMemoryCard(input) {
      const nowMs = Date.now()
      const newId = `ep-custom-${nowMs}`
      const cleanTitle = input.title.trim() || 'Nova lembrança'
      const cleanSummary = input.summary.trim() || 'Momento registrado manualmente.'
      const cleanStory = input.fullStory?.trim() || cleanSummary
      const cat = input.filterCategory ?? 'momentos'

      const episode: EpisodicMemory = {
        id: newId,
        title: cleanTitle,
        summary: cleanSummary,
        content: cleanStory,
        createdAt: nowMs,
        lastReviewedAt: nowMs,
        stability: 8.5,
        difficulty: 3.5,
        surprise: 0.8,
        isFlashbulb: false,
        tags: [cat],
      }

      const card: FeaturedMemoryCard = {
        id: newId,
        title: cleanTitle,
        summary: cleanSummary,
        fullStory: cleanStory,
        dateLabel: 'Hoje',
        originLabel: 'Criada agora',
        filterCategory: cat,
        image: '/assets/mem-first-chat.jpg',
        featured: false,
        episodeId: newId,
      }

      const nextEpisodes = [episode, ...get().episodicMemories]
      set({
        episodicMemories: nextEpisodes,
        rankedMemories: rankEpisodesInMemory(nextEpisodes, get().memorySearchQuery, nowMs),
        memoryCards: [card, ...get().memoryCards],
        selectedMemoryId: card.id,
      })

      void getAshyHostBridge()
        .upsertEpisodicMemory(episode)
        .catch(() => {
          // Ignore when offline in unit test
        })

      return card
    },

    updateMemoryStory(id, newTitle, newStory) {
      const nowMs = Date.now()
      const cleanTitle = newTitle.trim()
      const cleanStory = newStory.trim()

      const cards = get().memoryCards.map((c) =>
        c.id === id
          ? {
              ...c,
              title: cleanTitle || c.title,
              fullStory: cleanStory || c.fullStory,
              summary: (cleanStory || c.summary).split('\n')[0] ?? c.summary,
            }
          : c,
      )

      const existingEpisode = get().episodicMemories.find((ep) => ep.id === id)
      let nextEpisodes = get().episodicMemories
      if (existingEpisode) {
        const updatedEpisode: EpisodicMemory = {
          ...existingEpisode,
          title: cleanTitle || existingEpisode.title,
          content: cleanStory || existingEpisode.content,
          summary: (cleanStory || existingEpisode.summary).split('\n')[0] ?? existingEpisode.summary,
          lastReviewedAt: nowMs,
        }
        nextEpisodes = get().episodicMemories.map((ep) =>
          ep.id === id ? updatedEpisode : ep,
        )
        void getAshyHostBridge()
          .upsertEpisodicMemory(updatedEpisode)
          .catch(() => {
            // Ignore when offline in unit test
          })
      }

      set({
        memoryCards: cards,
        episodicMemories: nextEpisodes,
        rankedMemories: rankEpisodesInMemory(nextEpisodes, get().memorySearchQuery, nowMs),
      })
    },

    deleteMemoryCard(id) {
      void get().deleteMemoryItem('episode', id)
    },

    async deleteMemoryItem(kind, id) {
      const current = get()
      if (kind === 'episode') {
        const nextEpisodes = current.episodicMemories.filter((ep) => ep.id !== id)
        const nextRanked = rankEpisodesInMemory(nextEpisodes, current.memorySearchQuery)
        const remainingCards = current.memoryCards.filter(
          (c) => c.id !== id && c.episodeId !== id,
        )
        const nextSelected =
          current.selectedMemoryId === id
            ? (remainingCards[0]?.id ?? '')
            : current.selectedMemoryId
        const nextFacts = current.semanticFacts.map((f) => {
          if (!f.sourceEpisodeIds.includes(id)) return f
          const filtered = f.sourceEpisodeIds.filter((epId) => epId !== id)
          return {
            ...f,
            sourceEpisodeIds: filtered.length > 0 ? filtered : ['deleted-episode'],
          }
        })
        const nextMotifs = current.relationalMotifs.map((m) =>
          m.originEpisodeId === id ? { ...m, originEpisodeId: undefined } : m,
        )
        const nextHabits = current.userHabits.map((h) =>
          h.sourceEpisodeId === id ? { ...h, sourceEpisodeId: undefined } : h,
        )
        const nextIntents = current.prospectiveIntents.map((i) =>
          i.sourceEpisodeId === id ? { ...i, sourceEpisodeId: undefined } : i,
        )
        const nextMilestones = current.milestones.map((m) =>
          m.episodeId === id ? { ...m, episodeId: undefined } : m,
        )
        set({
          episodicMemories: nextEpisodes,
          rankedMemories: nextRanked,
          memoryCards: remainingCards,
          selectedMemoryId: nextSelected,
          semanticFacts: nextFacts,
          relationalMotifs: nextMotifs,
          userHabits: nextHabits,
          prospectiveIntents: nextIntents,
          milestones: nextMilestones,
          lastPrompt: compilePromptFromState({
            rankedMemories: nextRanked,
            semanticFacts: nextFacts,
            relationalMotifs: nextMotifs,
            userHabits: nextHabits,
            prospectiveIntents: nextIntents,
          }),
        })
      } else if (kind === 'fact') {
        const nextFacts = current.semanticFacts.filter((f) => f.id !== id)
        set({
          semanticFacts: nextFacts,
          lastPrompt: compilePromptFromState({
            semanticFacts: nextFacts,
          }),
        })
      } else if (kind === 'joke') {
        const nextMotifs = current.relationalMotifs.filter((m) => m.id !== id)
        set({
          relationalMotifs: nextMotifs,
          lastPrompt: compilePromptFromState({
            relationalMotifs: nextMotifs,
          }),
        })
      } else if (kind === 'habit') {
        const nextHabits = current.userHabits.filter((h) => h.id !== id)
        set({
          userHabits: nextHabits,
          lastPrompt: compilePromptFromState({
            userHabits: nextHabits,
          }),
        })
      } else if (kind === 'intent') {
        const nextIntents = current.prospectiveIntents.filter((i) => i.id !== id)
        set({
          prospectiveIntents: nextIntents,
          lastPrompt: compilePromptFromState({
            prospectiveIntents: nextIntents,
          }),
        })
      } else if (kind === 'milestone') {
        const nextMilestones = current.milestones.filter((m) => m.id !== id)
        set({
          milestones: nextMilestones,
          roomTrophies: buildRoomTrophies(nextMilestones),
        })
      }

      try {
        await getAshyHostBridge().deleteMemoryItem({ kind, id })
      } catch {
        // Ignore when offline in unit test
      }
    },

    async consolidateSessionMemories(force = true) {
      const bridge = ensureHostSubscription()
      const snapshot = await bridge.consolidateSessionMemories({
        sessionId: get().activeSessionId,
        force,
      })
      get().applyBootstrapSnapshot(snapshot)
    },

    async approveMemoryItem(kind, id) {
      const bridge = ensureHostSubscription()
      const snapshot = await bridge.approveMemoryItem({ kind, id })
      get().applyBootstrapSnapshot(snapshot)
    },

    async setMemoryGovernancePolicy(category, requireConfirmation) {
      set((state) => ({
        memoryGovernancePolicy: {
          ...state.memoryGovernancePolicy,
          [category]: requireConfirmation,
        },
      }))
      const bridge = ensureHostSubscription()
      const updated = await bridge.setMemoryGovernancePolicy({
        category,
        requireConfirmation,
      })
      set({ memoryGovernancePolicy: updated })
    },

    addMilestone(input) {
      const nowMs = Date.now()
      const created: AutobiographicalMilestone = {
        id: `milestone-custom-${nowMs}`,
        title: input.title.trim() || 'New Shared Milestone',
        narrative: input.narrative.trim() || 'Recorded manually in Our Story timeline.',
        category: input.category,
        createdAt: nowMs,
      }
      const nextMilestones = [...get().milestones, created]
      set({
        milestones: nextMilestones,
        roomTrophies: buildRoomTrophies(nextMilestones),
      })
      void getAshyHostBridge()
        .upsertMilestone(created)
        .catch(() => {
          // Ignore when offline in unit test
        })
      return created
    },

    searchMemories(query) {
      const results = rankEpisodesInMemory(get().episodicMemories, query, Date.now())
      set({
        memorySearchQuery: query,
        rankedMemories: results,
      })
      return results
    },

    reviewEpisodicMemoryById(id, rating) {
      const nowMs = Date.now()
      const existing = get().episodicMemories.find((m) => m.id === id)
      if (!existing) return
      const updated = reviewEpisodicMemory(existing, rating, nowMs)
      const nextEpisodes = get().episodicMemories.map((m) => (m.id === id ? updated : m))
      set({
        episodicMemories: nextEpisodes,
        rankedMemories: rankEpisodesInMemory(nextEpisodes, get().memorySearchQuery, nowMs),
      })
      void getAshyHostBridge()
        .upsertEpisodicMemory(updated)
        .catch(() => {
          // Ignore when offline in unit test
        })
    },

    invokeMotifManually(motifId) {
      const nowMs = Date.now()
      const existing = get().relationalMotifs.find((m) => m.id === motifId)
      if (!existing || existing.approvalStatus === 'pending_review') return
      const updated = recordMotifInvocation(existing, true, nowMs)
      set({
        relationalMotifs: get().relationalMotifs.map((m) => (m.id === motifId ? updated : m)),
      })
      void getAshyHostBridge()
        .upsertRelationalMotif(updated)
        .catch(() => {
          // Ignore when offline in unit test
        })
    },

    resetMotifCooldown(motifId) {
      const existing = get().relationalMotifs.find((m) => m.id === motifId)
      if (!existing) return
      const updated: RelationalMotif = {
        ...existing,
        lastUsedAt: null,
      }
      set({
        relationalMotifs: get().relationalMotifs.map((m) => (m.id === motifId ? updated : m)),
      })
      void getAshyHostBridge()
        .upsertRelationalMotif(updated)
        .catch(() => {
          // Ignore when offline in unit test
        })
    },

    getMotifCooldownInfo(motifId) {
      const motif = get().relationalMotifs.find((m) => m.id === motifId)
      if (!motif) {
        return {
          isCooldownLocked: false,
          elapsedHoursSinceUse: null,
          remainingCooldownHours: 0,
        }
      }
      return inspectMotifCooldownStatus(motif, Date.now())
    },

    addSemanticFact(input) {
      const nowMs = Date.now()
      const cleanSubject = input.subject.trim() || 'User'
      const cleanPredicate = input.predicate.trim() || 'prefers'
      const cleanObject = input.object.trim() || 'TypeScript'

      const updatedFacts = get().semanticFacts.map((f) => {
        if (
          f.invalidAt === null &&
          f.category.toLowerCase() === input.category.toLowerCase() &&
          f.subject.toLowerCase() === cleanSubject.toLowerCase() &&
          f.predicate.toLowerCase() === cleanPredicate.toLowerCase()
        ) {
          return {
            ...f,
            invalidAt: nowMs,
          }
        }
        return f
      })

      const newFact: SemanticFact = {
        id: `fact-custom-${nowMs}`,
        category: input.category,
        subject: cleanSubject,
        predicate: cleanPredicate,
        object: cleanObject,
        confidence: 0.95,
        sourceEpisodeIds: ['manual-ui-entry'],
        validFrom: nowMs,
        invalidAt: null,
      }

      const nextFacts = [...updatedFacts, newFact]
      set({
        semanticFacts: nextFacts,
        lastPrompt: compilePromptFromState({
          semanticFacts: nextFacts,
        }),
      })

      void getAshyHostBridge()
        .upsertSemanticFact({
          id: newFact.id,
          category: newFact.category,
          subject: newFact.subject,
          predicate: newFact.predicate,
          object: newFact.object,
          confidence: newFact.confidence,
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
    },

    completeProspectiveIntent(intentId) {
      const existing = get().prospectiveIntents.find((i) => i.id === intentId)
      if (!existing) return
      const updated: ProspectiveIntent = {
        ...existing,
        status: 'completed',
      }
      const nextIntents = get().prospectiveIntents.map((i) =>
        i.id === intentId ? updated : i,
      )
      set({
        prospectiveIntents: nextIntents,
        lastPrompt: compilePromptFromState({
          prospectiveIntents: nextIntents,
        }),
      })
      void getAshyHostBridge()
        .upsertProspectiveIntent(updated)
        .catch(() => {
          // Ignore when offline in unit test
        })
    },

    runDreamConsolidation(nowMs = Date.now()) {
      const state = get()
      const evoRes = proposeGroundedTraitEvolutions({
        episodes: state.episodicMemories,
        existingLog: state.personalityEvolutionLog,
        currentTraits: state.traits,
        nowMs,
        maxEvolutions: 1,
      })

      if (evoRes.records[0]) {
        const record = evoRes.records[0]
        const nextTraits = evoRes.traits
        const milestone = evoRes.milestones[0]
        const targetEpisode = state.episodicMemories.find(
          (e) => e.id === record.reasonEpisodeId,
        )
        const nextLog = [record, ...state.personalityEvolutionLog]
        const nextMilestones =
          milestone && !state.milestones.some((m) => m.id === milestone.id)
            ? [milestone, ...state.milestones]
            : state.milestones

        set({
          traits: nextTraits,
          personalityEvolutionLog: nextLog,
          milestones: nextMilestones,
          roomTrophies: buildRoomTrophies(nextMilestones),
          stageEmotion: 'happy',
          lastPrompt: compilePromptFromState({
            traits: nextTraits,
          }),
        })

        if (targetEpisode) {
          void getAshyHostBridge()
            .persistDreamConsolidation({
              episode: targetEpisode,
              traits: nextTraits,
              record,
            })
            .catch(() => {
              // Ignore when offline in unit test
            })
        }
        if (milestone) {
          void getAshyHostBridge()
            .upsertMilestone(milestone)
            .catch(() => {
              // Ignore when offline in unit test
            })
        }

        return record
      }

      void getAshyHostBridge()
        .runDreamReflection({
          sessionId: state.activeSessionId,
          force: true,
          maxEvolutions: 1,
        })
        .then((res) => {
          if (res?.snapshot && res.result.appliedEvolutions.length > 0) {
            get().applyBootstrapSnapshot(res.snapshot)
          }
        })
        .catch(() => {
          // Ignore when offline in unit test
        })

      const fallbackVal =
        state.traits.warmthAffection ?? ASHY_TRAIT_CORRIDORS.warmthAffection.baseline
      return {
        id: `trait-evo-noop-${nowMs}`,
        trait: 'warmthAffection',
        oldValue: fallbackVal,
        newValue: fallbackVal,
        reasonEpisodeId: 'no_new_episodes',
        explanation: 'Nenhum novo episódio aprovado disponível para reflexão.',
        createdAt: nowMs,
        revertedAt: null,
      }
    },

    revertTraitEvolution(recordId) {
      const nowMs = Date.now()
      const state = get()
      const target = state.personalityEvolutionLog.find((r) => r.id === recordId)
      if (!target || target.revertedAt != null) return null
      const { traits: revertedTraits, record: revertedRecord } = revertCortexTraitEvolution(
        state.traits,
        target,
        nowMs,
      )

      set({
        traits: revertedTraits,
        personalityEvolutionLog: state.personalityEvolutionLog.map((r) =>
          r.id === recordId ? revertedRecord : r,
        ),
        lastPrompt: compilePromptFromState({
          traits: revertedTraits,
        }),
      })

      void getAshyHostBridge()
        .revertTraitEvolution({ recordId })
        .then((snapshot) => {
          if (snapshot) {
            get().applyBootstrapSnapshot(snapshot)
          }
        })
        .catch(() => {
          void getAshyHostBridge()
            .persistTraitRevert({
              traits: revertedTraits,
              record: revertedRecord,
            })
            .catch(() => {
              // Ignore when offline in unit test
            })
        })

      return revertedRecord
    },

    setSettingsSubTab(subTab) {
      set({ settingsSubTab: subTab })
    },

    setShowDesktopAvatar(show) {
      set({ showDesktopAvatar: show })
    },

    setComputerActionsEnabled(enabled) {
      set({ computerActionsEnabled: enabled })
    },

    setComputerActionsPolicy(policy) {
      set({ computerActionsPolicy: policy })
    },

    setQuietHoursRange(range) {
      set({ quietHoursRange: range })
    },

    saveUserPreferences() {
      set({ preferencesSavedToast: true })
    },

    setMicMode(mode) {
      const agencyMode: MicMode = mode === 'push-to-talk' ? 'ptt' : mode
      agency.privacyController.setMicMode(agencyMode)
      voiceRuntime.setMicMode(mode)
      set({ privacyState: agency.privacyController.getState() })
    },

    setActiveSttProvider(providerId) {
      voiceRuntime.setActiveSttProvider(providerId)
      set((state) => ({
        voiceSettings: {
          ...state.voiceSettings,
          activeSttProviderId: providerId,
        },
      }))
    },

    setActiveTtsProvider(providerId) {
      voiceRuntime.setActiveTtsProvider(providerId)
      set((state) => ({
        voiceSettings: {
          ...state.voiceSettings,
          activeTtsProviderId: providerId,
        },
        ttfaByProvider: voiceRuntime.getTtfaTelemetry(),
      }))
    },

    setWakeWordEnabled(enabled) {
      voiceRuntime.setWakeWordEnabled(enabled)
      set((state) => ({
        voiceSettings: {
          ...state.voiceSettings,
          wakeWordEnabled: enabled,
        },
      }))
    },

    async setPushToTalkHeld(held) {
      set({ isPushToTalkHeld: held })
      await voiceRuntime.setPushToTalkActive(held)
    },

    async runAudioFixtureSimulation(fixtureId) {
      const prevWake = get().voiceSettings.wakeWordEnabled
      const prevMic = get().privacyState.micMode
      const result = await voiceRuntime.runFixtureScenario(fixtureId)
      voiceRuntime.setWakeWordEnabled(prevWake)
      voiceRuntime.setMicMode(prevMic)
      const snap = result.snapshot
      set((state) => ({
        lastVoiceFixtureResult: result,
        ttfaByProvider: snap.ttfaByProvider,
        voiceCasRejectedCount: snap.turnState.casRejectedCount,
        voiceCancelledShortCount: snap.cancelledShortCount,
        lastPlaybackReceipt: snap.lastPlaybackReceipt ?? state.lastPlaybackReceipt,
        pendingInterruptionControlNote:
          snap.lastPlaybackReceipt?.controlNote ?? state.pendingInterruptionControlNote,
      }))
      return result
    },

    async runVoiceFixtureScenario(fixtureId) {
      return get().runAudioFixtureSimulation(fixtureId)
    },

    setEyesMode(mode) {
      agency.privacyController.setEyesMode(mode)
      set({ privacyState: agency.privacyController.getState() })
    },

    setDndMode(enabled) {
      agency.privacyController.setDndMode(enabled)
      set({ privacyState: agency.privacyController.getState() })
    },

    activateFullPrivacyShield() {
      const next = agency.privacyController.activatePrivacyShield()
      set({ privacyState: next })
    },

    searchMcpTools(query) {
      const results = agency.mcpRegistry.search_mcp_tools({ query, limit: 10 })
      set({
        mcpSearchQuery: query,
        mcpSearchResults: results,
      })
      return results
    },

    async triggerMcpTool(toolName, args = {}) {
      const res = await agency.mcpRegistry.call_mcp_tool({ toolName, args })
      let summary = `Tool "${toolName}" -> ${res.status}`
      if (res.pendingCard?.blastRadiusWarning) {
        summary += ` (${res.pendingCard.blastRadiusWarning})`
      } else if (res.reason) {
        summary += ` (${res.reason})`
      }

      set({
        pendingActions: agency.gatekeeper.getPendingActions(),
        auditLog: [...agency.gatekeeper.getAuditLog()],
        lastMcpResultSummary: summary,
      })
      return res
    },

    async approvePendingAction(actionId, scope) {
      await agency.gatekeeper.approveAction(actionId, scope)
      set({
        pendingActions: agency.gatekeeper.getPendingActions(),
        auditLog: [...agency.gatekeeper.getAuditLog()],
        lastMcpResultSummary: `Approved action ${actionId} (scope=${scope})`,
      })
    },

    denyPendingAction(actionId, reason = 'Denied by user in Consent Center') {
      const res = agency.gatekeeper.denyAction(actionId, reason)
      set({
        pendingActions: agency.gatekeeper.getPendingActions(),
        auditLog: [...agency.gatekeeper.getAuditLog()],
        lastMcpResultSummary: res.feedback,
      })
    },

    resetStoreForTesting() {
      unsubscribeHostEvents?.()
      unsubscribeHostEvents = null
      subscribedBridge = null
      activeSpeechPipeline = null
      firstDeltaEnqueuedAtMs = null
      firstChunkRecordedForTurn = false
      evalRunSeq += 1
      completedTurnEvents.clear()
      pendingTurnResolvers.clear()
      pendingTurnSeriousness.clear()
      streamedDeltaTurnIds.clear()
      bargeInTurnIds.clear()
      agency = createAgencyRuntime()
      voiceRuntime = createVoiceSessionRuntime({
        micMode: 'continuous',
        wakeWordEnabled: DEFAULT_VOICE_RUNTIME_SETTINGS.wakeWordEnabled,
        wakeWordPhrases: DEFAULT_VOICE_RUNTIME_SETTINGS.wakeWordPhrases,
        activeSttProviderId: DEFAULT_VOICE_RUNTIME_SETTINGS.activeSttProviderId,
        activeTtsProviderId: DEFAULT_VOICE_RUNTIME_SETTINGS.activeTtsProviderId,
      })
      lastPromptMinuteLabel = formatLocalTimeHHMM(Date.now())

      const freshPrompt = composeAshyTurnPrompt({
        userMessage: 'Olá Ashy.',
        modelId: 'claude-3-7-sonnet',
        timeOfDayLabel: lastPromptMinuteLabel,
        stage: 'stranger',
        voiceIdentityMarkdown: DEFAULT_ASHY_VOICE_MD,
        traits: ASHY_DEFAULT_TRAITS,
        mood: ASHY_BASELINE_MOOD,
      })

      set({
        viewMode: 'hub',
        activeTab: 'studio',
        activeModelId: 'claude-3-7-sonnet',
        isBootstrapped: false,
        needsOnboarding: true,
        userProfile: {
          userName: null,
          userPronouns: null,
        },
        relationshipStage: 'stranger',
        familiarityScore: 0,
        trustScore: 0.1,
        totalTurns: 0,
        activeSessionId: 'session-initial',
        sessions: [],
        providers: createInitialPublicProviders(),
        voiceIdentity: {
          content: DEFAULT_ASHY_VOICE_MD,
          diagnostics: {
            status: 'ok',
            updatedAt: 0,
          },
          updatedAt: 0,
        },
        runtimeDiagnostics: {
          dbMode: 'wal',
          dbPath: '',
          lastPersistenceWarning: null,
        },
        isStreamingTurn: false,
        activeTurnId: null,
        lastTurnError: null,
        persistenceWarning: null,
        stageMode: 'tachie',
        stageEmotion: 'neutral',
        emotionIntensity: 0.85,
        ambientLuminance: 0.35,
        isSpeaking: false,
        presenceStatus: 'Idle',
        bubbleText: 'Fico por aqui. No seu ritmo. ♡',
        simulatedVowels: { A: 0.65, E: 0.25, I: 0.1, O: 0.35, U: 0.15 },
        mood: { ...ASHY_BASELINE_MOOD },
        traits: { ...ASHY_DEFAULT_TRAITS },
        milestones: [],
        episodicMemories: [],
        rankedMemories: [],
        memoryCards: [],
        selectedMemoryId: '',
        memoryFilter: 'todas',
        memorySearchQuery: '',
        semanticFacts: [],
        relationalMotifs: [],
        userHabits: [],
        prospectiveIntents: [],
        personalityEvolutionLog: [],
        memoryGovernancePolicy: { ...DEFAULT_MEMORY_GOVERNANCE_POLICY },
        lastPrompt: freshPrompt,
        roomTrophies: buildRoomTrophies([]),
        lastEvalReport: null,
        lastEvalError: null,
        isRunningEval: false,
        chatMessages: [],
        scheduledAudioChunks: [],
        lastPlaybackReceipt: null,
        lastStageSignals: [],
        voiceSettings: {
          ...DEFAULT_VOICE_RUNTIME_SETTINGS,
          wakeWordPhrases: [...DEFAULT_VOICE_RUNTIME_SETTINGS.wakeWordPhrases],
        },
        ttfaByProvider: voiceRuntime.getTtfaTelemetry(),
        pendingInterruptionControlNote: null,
        lastTurnInterruptionNote: null,
        voiceCasRejectedCount: 0,
        voiceCancelledShortCount: 0,
        lastVoiceFixtureResult: null,
        isPushToTalkHeld: false,
        settingsSubTab: 'privacidade',
        showDesktopAvatar: true,
        computerActionsEnabled: true,
        computerActionsPolicy: 'ask',
        quietHoursRange: '22:00 — 08:00',
        preferencesSavedToast: false,
        privacyState: agency.privacyController.getState(),
        mcpSearchQuery: '',
        mcpSearchResults: agency.mcpRegistry.search_mcp_tools({ query: '', limit: 10 }),
        exposedMetaToolsCount: agency.mcpRegistry.getExposedMetaTools().length,
        registeredMcpToolsCount: agency.mcpRegistry.getRegisteredToolsCount(),
        pendingActions: agency.gatekeeper.getPendingActions(),
        auditLog: [...agency.gatekeeper.getAuditLog()],
        lastMcpResultSummary: null,
      })
    },
  }
})

export function resetAshyStore(): void {
  useAshyStore.getState().resetStoreForTesting()
}
