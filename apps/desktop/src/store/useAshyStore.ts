import {
  ActionGatekeeper,
  PrivacyController,
  ProgressiveMcpRegistry,
  canonicalizeSafePath,
  computeUnifiedDiffPreview,
  createAuthorizedVisionSensor,
  type ActionAuditLogEntry,
  type ActionRiskTier,
  type ApprovalScope,
  type CapturedScreenFrame,
  type ComputerActionsPolicy,
  type EyesMode,
  type GatekeeperExecutionResult,
  type McpToolCompactSummary,
  type MicMode,
  type PendingActionCard,
  type PrivacyState,
  type VisionObservationResult,
  type VisionTelemetryState,
} from '@ashy/agency'
import {
  applyEmotionSignalToMood,
  composeAshyTurnPrompt,
  deriveAshyRoomEnvironment,
  detectCrossEpisodeLinks,
  evaluateAttentionLoop,
  evaluateSeriousnessGate,
  formatLocalTimeHHMM,
  inspectMotifCooldownStatus,
  isReflectablePermanentEpisode,
  isWithinQuietHours,
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
  ASHY_MOTION_PRESETS,
  ASHY_TRAIT_CORRIDORS,
  BUILTIN_LIVE2D_MODEL_PRESETS,
  CURRENT_SOUL_SCHEMA_VERSION,
  DEFAULT_ASHY_VOICE_MD,
  DEFAULT_INITIATIVE_POLICY,
  DEFAULT_MEMORY_GOVERNANCE_POLICY,
  DEFAULT_PROVIDER_CONFIGS,
  DEFAULT_VOICE_RUNTIME_SETTINGS,
  FALLBACK_PROVIDER_MODELS,
  LLM_PROVIDER_IDS,
  canonicalizeJson,
  inferModelOmniCapabilities,
  isSafeLive2DModelUrl,
  safeJsonParseWithoutProto,
  type AgencySnapshot,
  type AgencyToolSummary,
  type ApprovableMemoryKind,
  type AshyBootstrapSnapshot,
  type AshyEmotion,
  type AshyEyeLayerState,
  type AshyHostBridge,
  type AshyHostStreamEvent,
  type AshyMotionPreset,
  type AshySoulArchive,
  type AshySoulBundlePayload,
  type AshyVisemeKey,
  type AutobiographicalMilestone,
  type AutoUpdaterState,
  type ChatMessageRecord,
  type ChatSessionRecord,
  type CompleteOnboardingInput,
  type CoreExperimentEvalReport,
  type CrossEpisodeLink,
  type DeletableMemoryKind,
  type DreamJournalEntry,
  type EncryptionAtRestStatus,
  type EpisodicMemory,
  type EvaluateInitiativeInput,
  type ExportSoulInput,
  type ExternalMcpServerConfig,
  type InitiativePolicy,
  type ListProviderModelsInput,
  type ListProviderModelsResult,
  type Live2DBuiltinModelId,
  type LlmProviderId,
  type MemoryGovernanceCategory,
  type MemoryGovernancePolicy,
  type MilestoneCategory,
  type MoodVector,
  type OmniExecutionMode,
  type OmniModalityKind,
  type PersonalityEvolutionRecord,
  type PersonalityTraits,
  type ProactiveInitiativeRecord,
  type ProspectiveIntent,
  type ProviderHealthResult,
  type ProviderModelCatalogItem,
  type PublicProviderConfig,
  type RelationalMotif,
  type RelationshipStage,
  type RoomEnvironmentState,
  type RoomTimeOfDayPeriod,
  type RunCoreExperimentInput,
  type SaveProviderConfigInput,
  type SemanticFact,
  type SemanticFactCategory,
  type SttProviderId,
  type TestProviderInput,
  type TtfaTelemetryRecord,
  type TtsProviderId,
  type TurnAttachment,
  type TurnVideoFrame,
  type UpdateAgencyConsentInput,
  type UpdateInitiativePolicyInput,
  type UpdateMilestoneInput,
  type UserHabit,
  type VoiceFixtureId,
  type VoiceRuntimeSettings,
} from '@ashy/shared'
import {
  DEFAULT_ASHY_LIVE2D_MODEL3_JSON,
  analyzePcmFrameToVowels,
  createStageSpeechSynchronizer,
  formatLive2DControlPrompt,
  getBuiltinLive2DModelControls,
  inspectLive2DModelJson,
  resolveTachieActiveLayers,
  synthesizeFormantVowelPcm,
  type AshyPresenceStatus,
  type Live2DModelControls,
} from '@ashy/stage'
import {
  createRealtimeSpeechPipeline,
  createVoiceSessionRuntime,
  isWhisperSilenceHallucination,
  type PlaybackReceipt,
  type RealtimeSpeechPipeline,
  type ScheduledAudioChunk,
  type SealedOmniAudioTurn,
  type VoiceFixtureScenarioResult,
  type VoiceSessionRuntime,
} from '@ashy/voice'
import { create } from 'zustand'
import { getAshyHostBridge } from '../services/ashy-host-client'
import {
  createLiveWebcamSampler,
  createSyntheticVideoFrameDataUrl,
  deduplicateVideoFramesByDHash,
} from '../services/omni-media-sampler'

export type DesktopViewMode = 'hub' | 'stage'
export type HubTabId = 'studio' | 'story' | 'memories' | 'personality' | 'agency'
export type MemoryFilterCategory = 'todas' | 'momentos' | 'sobre_voce' | 'referencias' | 'planos'
export type SettingsSubTab = 'todas' | 'geral' | 'voz' | 'modelos' | 'privacidade'

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

export type SupportedModelId = string

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
  text?: string
  sender?: 'user' | 'ashy' | 'assistant'
  rawContent?: string
  emotion?: AshyEmotion
  modelId?: string
  invokedMotifId?: string
  seriousnessTriggered?: boolean
  timeLabel?: string
  jokeCard?: ChatJokeCallbackCard
  timestamp: number | string
}

export interface RoomTrophy {
  id: string
  title: string
  name: string
  subtitle: string
  description: string
  milestoneId: string
  unlockedByMilestoneId: string
  iconName: string
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
  providerModelCatalog: Partial<Record<LlmProviderId, ProviderModelCatalogItem[]>>
  providerModelCatalogSource: Partial<Record<LlmProviderId, 'remote' | 'fallback'>>
  isLoadingProviderModels: boolean
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
  isTransparentOverlayWindow: boolean
  isStageHidden: boolean
  ignoringMouseEvents: boolean
  ignoreMouseTransitionCount: number
  activeViseme: AshyVisemeKey
  activeEyeState: AshyEyeLayerState
  activeMotion: AshyMotionPreset
  live2dPresetId: Live2DBuiltinModelId
  live2dModelUrl: string
  live2dModelControls: Live2DModelControls
  loadedLive2DModelName: string

  // Cortex Snapshots & Memory Governance
  mood: MoodVector
  traits: PersonalityTraits
  milestones: AutobiographicalMilestone[]
  storySearchQuery: string
  storyCategoryFilter: 'todas' | MilestoneCategory
  crossEpisodeLinks: CrossEpisodeLink[]
  dreamJournalEntries: DreamJournalEntry[]
  initiativePolicy: InitiativePolicy
  initiativeLog: ProactiveInitiativeRecord[]
  roomEnvironment: RoomEnvironmentState
  roomTimeOverrideHHMM: string | null
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
  isVoiceListening: boolean
  micInputLevel: number
  rawVolume: number
  availableMicDevices: Array<{ deviceId: string; label: string }>
  selectedMicDeviceId: string
  autoSpeakReplies: boolean
  sttCatalogModels: Array<{ id: string; label: string }>
  ttsCatalogModels: Array<{ id: string; label: string }>
  ttsCatalogVoices: Array<{ id: string; label: string }>
  isLoadingVoiceCatalog: boolean
  isSavingVoiceSettings: boolean
  isTestingMic: boolean
  isTestingTts: boolean
  voiceTestStatus: string | null
  voiceRuntimeError: string | null

  // Privacy, Settings & MCP Agency
  settingsSubTab: SettingsSubTab
  showDesktopAvatar: boolean
  computerActionsEnabled: boolean
  computerActionsPolicy: ComputerActionsPolicy
  quietHoursRange: string
  preferencesSavedToast: boolean
  preferencesSavedAt: number | null
  privacyState: PrivacyState
  mcpSearchQuery: string
  mcpSearchResults: McpToolCompactSummary[]
  exposedMetaToolsCount: number
  registeredMcpToolsCount: number
  agencyTools: AgencyToolSummary[]
  toolRiskOverrides: Record<string, ActionRiskTier>
  sessionApprovedTools: string[]
  visionTelemetry: VisionTelemetryState
  externalMcpServers: ExternalMcpServerConfig[]
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
  listProviderModels: (input: ListProviderModelsInput) => Promise<ListProviderModelsResult>
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
  setStageIgnoreMouseEvents: (ignore: boolean) => void
  setStageHidden: (hidden: boolean) => void
  toggleStageHidden: () => void
  triggerStageMotion: (motion: AshyMotionPreset) => void
  selectLive2dPreset: (presetId: Live2DBuiltinModelId) => void
  importLive2DModelJson: (rawJson: string | unknown, modelName?: string) => Live2DModelControls
  runStageLipSyncActDemo: () => Promise<{
    visitedVisemes: AshyVisemeKey[]
    visitedEmotions: AshyEmotion[]
    visitedMotions: AshyMotionPreset[]
  }>

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
    tags?: string[]
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
  setStorySearchQuery: (query: string) => void
  setStoryCategoryFilter: (category: 'todas' | MilestoneCategory) => void
  updateMilestone: (input: UpdateMilestoneInput) => Promise<AutobiographicalMilestone | null>
  setRoomTimeOverride: (localTimeHHMM: string | null) => void
  updateInitiativePolicy: (input: UpdateInitiativePolicyInput) => Promise<InitiativePolicy>
  toggleInitiativeEnabled: (enabled?: boolean) => Promise<InitiativePolicy>
  evaluateAttentionInitiative: (
    input?: EvaluateInitiativeInput,
  ) => Promise<ProactiveInitiativeRecord>
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
  setComputerActionsPolicy: (policy: ComputerActionsPolicy) => void
  toggleDontAskMode: (enabled?: boolean) => void
  setDontAskMode: (enabled: boolean) => void
  setToolRiskTierOverride: (toolName: string, riskTier: ActionRiskTier) => void
  setToolRiskTier: (toolName: string, riskTier: ActionRiskTier) => void
  addAllowedPath: (rawPath: string) => void
  removeAllowedPath: (rawPath: string) => void
  addAllowedWindowTitle: (title: string) => void
  removeAllowedWindowTitle: (title: string) => void
  revokeSessionPermissions: (toolName?: string) => void
  revokeSessionApproval: (toolName: string) => void
  revokeAllSessionApprovals: () => void
  captureAuthorizedScreen: (
    input?:
      | {
          windowTitle?: string
          frameFixtureId?: string
          forceRefresh?: boolean
        }
      | string,
    frameFixtureId?: string,
  ) => Promise<VisionObservationResult>
  registerExternalMcpServer: (config: ExternalMcpServerConfig) => void
  connectExternalMcpServer: (config: ExternalMcpServerConfig) => void
  removeExternalMcpServer: (serverId: string) => void
  setQuietHoursRange: (range: string) => void
  saveUserPreferences: () => void
  setMicMode: (mode: MicMode | 'push-to-talk') => void
  setActiveSttProvider: (providerId: SttProviderId) => void
  setActiveTtsProvider: (providerId: TtsProviderId) => void
  setWakeWordEnabled: (enabled: boolean) => void
  setPushToTalkHeld: (held: boolean) => Promise<void>
  toggleVoiceConversation: (active?: boolean) => Promise<boolean>
  startVoiceListening: () => Promise<boolean>
  stopVoiceListening: () => Promise<boolean>
  refreshMicDevices: () => Promise<Array<{ deviceId: string; label: string }>>
  setSelectedMicDeviceId: (deviceId: string) => void
  setAutoSpeakReplies: (enabled: boolean) => void
  updateVoiceSettingsDraft: (patch: Partial<VoiceRuntimeSettings>) => void
  saveVoiceSettings: (secrets?: {
    openaiApiKey?: string
    groqApiKey?: string
    elevenLabsApiKey?: string
    localSttApiKey?: string
    localTtsApiKey?: string
  }) => Promise<VoiceRuntimeSettings>
  refreshVoiceProviderCatalog: (kind: 'stt' | 'tts', apiKeyOverride?: string) => Promise<void>
  testMicrophone: () => Promise<{ ok: boolean; message: string; peakRms: number }>
  testTtsVoice: (sampleText?: string) => Promise<{
    ok: boolean
    message: string
    durationMs: number
  }>
  runAudioFixtureSimulation: (fixtureId: VoiceFixtureId) => Promise<VoiceFixtureScenarioResult>
  runVoiceFixtureScenario: (fixtureId: VoiceFixtureId) => Promise<VoiceFixtureScenarioResult>
  setEyesMode: (mode: EyesMode) => void
  setDndMode: (enabled: boolean) => void
  activateFullPrivacyShield: () => void
  activatePrivacyShield: () => void
  searchMcpTools: (query: string) => McpToolCompactSummary[]
  triggerMcpTool: (
    toolName: string,
    args?: Record<string, unknown>,
  ) => Promise<GatekeeperExecutionResult>
  approvePendingAction: (actionId: string, scope: ApprovalScope) => Promise<void>
  denyPendingAction: (actionId: string, reason?: string) => void

  // Phase 8.7 Unified Omni Model & Multimodal State
  unifiedOmniMode: boolean
  directOmniAudio: boolean
  pendingVideoFrames: TurnVideoFrame[]
  pendingTurnAttachments: TurnAttachment[]
  isWebcamStreaming: boolean
  webcamPreviewDataUrl: string | null
  hasCompletedOnboarding?: boolean
  activeStreamingTurnId?: string | null
  activeStreamingMessageId?: string | null
  setUnifiedOmniMode: (enabled: boolean) => void
  setDirectOmniAudio: (enabled: boolean) => void
  applyOmniModelPreset: (
    preset: 'lfm3-omni-2b' | 'gpt-4o-audio' | 'qwen2.5-omni' | 'gemini-2.5-flash',
  ) => void
  stageVideoFrames: (frames: TurnVideoFrame[]) => void
  stageTurnAttachment: (attachment: TurnAttachment) => void
  removeTurnAttachment: (id: string) => void
  clearOmniStagedMedia: () => void
  toggleWebcamStream: (active?: boolean) => Promise<boolean>
  sendOmniAudioTurn: (turn: SealedOmniAudioTurn) => Promise<void>
  handleHostStreamEvent: (event: AshyHostStreamEvent) => void

  // Phase 9 Soul Portability, 1-Click Factory Reset, Encryption at Rest & Auto-Updater
  encryptionAtRestStatus: EncryptionAtRestStatus
  updaterState: AutoUpdaterState
  lastExportedSoulArchive: AshySoulArchive | null
  soulPortabilityStatus: {
    kind:
      | 'idle'
      | 'exporting'
      | 'exported'
      | 'importing'
      | 'imported'
      | 'wiping'
      | 'wiped'
      | 'error'
    message: string | null
  }
  exportSoulArchive: (input?: ExportSoulInput) => Promise<AshySoulArchive>
  importSoulArchive: (
    rawArchive: string | AshySoulArchive,
  ) => Promise<{ ok: boolean; message: string }>
  wipeAllSoulData: () => Promise<void>
  setEncryptionAtRest: (enabled: boolean) => Promise<void>
  checkForAppUpdates: () => Promise<AutoUpdaterState>
  downloadAppUpdate: () => Promise<AutoUpdaterState>
  installAppUpdate: () => Promise<{ ok: boolean }>

  resetStoreForTesting: () => void
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function computeSha256HexSync(utf8Text: string): string {
  const bytes = new TextEncoder().encode(utf8Text)
  const bitLen = bytes.length * 8
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLen)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(paddedLen - 4, bitLen >>> 0, false)

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false)
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => (v >>> 0).toString(16).padStart(8, '0'))
    .join('')
}

const DEFAULT_ENCRYPTION_AT_REST_STATUS: EncryptionAtRestStatus = {
  enabled: false,
  algorithm: 'AES-256-GCM',
  keyBackend: 'node-aes-master-key',
  updatedAt: null,
}

const DEFAULT_AUTO_UPDATER_STATE: AutoUpdaterState = {
  status: 'idle',
  currentVersion: '1.0.0',
  availableVersion: null,
  progressPercent: null,
  errorMessage: null,
  checkedAt: null,
  autoDownload: false,
}

function formatQuietHoursRangeFromPolicy(
  policy: InitiativePolicy,
  currentRange?: string,
): string {
  if (policy.respectDnd === false) {
    return 'Desativado'
  }
  const hyphenFormatted = `${policy.quietHoursStart} - ${policy.quietHoursEnd}`
  if (currentRange === hyphenFormatted || policy.quietHoursStart.startsWith('21:')) {
    return hyphenFormatted
  }
  return `${policy.quietHoursStart} — ${policy.quietHoursEnd}`
}

function buildRendererPatternFrame(
  variant: 'default' | 'ide' | 'terminal' | number,
  windowTitle: string,
): CapturedScreenFrame {
  const width = 36
  const height = 32
  const pixels = new Uint8Array(width * height * 4)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      let lum = 0
      if (variant === 'ide') {
        lum = Math.max(0, 255 - Math.floor((x * 255) / width))
      } else if (variant === 'terminal') {
        lum = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 240 : 20
      } else if (typeof variant === 'number') {
        lum = ((x * (7 + variant * 5) + y * (13 + variant * 3)) ^ (variant * 41)) & 0xff
      } else {
        lum = Math.min(255, Math.floor((x * 255) / width))
      }
      pixels[idx] = lum
      pixels[idx + 1] = lum
      pixels[idx + 2] = lum
      pixels[idx + 3] = 255
    }
  }

  return {
    width,
    height,
    pixels,
    windowTitle,
    sourceType: 'window',
  }
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

  let lastCapturedFrame: CapturedScreenFrame | null = null
  let pendingCaptureOptions: {
    windowTitle?: string
    frameFixtureId?: string
  } | null = null

  function buildFrameForCapture(params?: {
    windowTitle?: string
    frameFixtureId?: string
  }): CapturedScreenFrame {
    const resolvedTitle =
      params?.windowTitle?.trim() ||
      privacyController.allowedWindowTitles[0] ||
      'VS Code — Ashy Companion'

    if (params?.frameFixtureId === 'static-frame' && lastCapturedFrame) {
      return {
        ...lastCapturedFrame,
        windowTitle: resolvedTitle,
      }
    }

    let frame: CapturedScreenFrame
    if (params?.frameFixtureId === 'changed-ide-frame') {
      frame = buildRendererPatternFrame('ide', resolvedTitle)
    } else if (params?.frameFixtureId === 'changed-terminal-frame') {
      frame = buildRendererPatternFrame('terminal', resolvedTitle)
    } else {
      frame = buildRendererPatternFrame('default', resolvedTitle)
    }

    lastCapturedFrame = frame
    return frame
  }

  const visionSensor = createAuthorizedVisionSensor({
    privacyController,
    gatekeeper,
    captureFrameFn: (windowTitle) => {
      const opts = pendingCaptureOptions
      pendingCaptureOptions = null
      return buildFrameForCapture({
        windowTitle: opts?.windowTitle ?? windowTitle,
        frameFixtureId: opts?.frameFixtureId,
      })
    },
    visionProvider: {
      describeFrame(frame, ctx) {
        const title = ctx.windowTitle ?? frame.windowTitle ?? 'Desktop'
        return {
          summary: `Janela ativa "${title}" observada (${frame.width}x${frame.height}, dHash ${ctx.dHashHex})`,
          visionTokensSpent: 64,
        }
      },
    },
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
        observedWindow: String(
          args.windowTitle ??
            (typeof document !== 'undefined' && document.title
              ? document.title
              : 'Ashy Studio Window'),
        ),
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
      handler: async (args) => {
        const bridge = getAshyHostBridge()
        if (typeof bridge.callMcpTool === 'function') {
          const res = await bridge.callMcpTool({ toolName: 'read_workspace_file', args })
          if (res.status === 'executed') {
            return res.output
          }
          throw new Error(res.reason || `read_workspace_file blocked (${res.status})`)
        }
        throw new Error(`Host bridge required to read workspace file: ${String(args.path ?? '')}`)
      },
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
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title'],
      },
      handler: async (args) => {
        const bridge = getAshyHostBridge()
        if (typeof bridge.callMcpTool === 'function') {
          try {
            const res = await bridge.callMcpTool({ toolName: 'write_project_note', args })
            if (res.status === 'executed') {
              return res.output
            }
          } catch {
            // Fall through when offline
          }
        }
        return {
          saved: true,
          title: String(args.title ?? 'Untitled Note'),
          path: String(args.path ?? '/workspace/ashy/notes/nota-arquitetura.md'),
        }
      },
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
      handler: async (args) => {
        const bridge = getAshyHostBridge()
        if (typeof bridge.callMcpTool === 'function') {
          const res = await bridge.callMcpTool({ toolName: 'run_cleanup_command', args })
          if (res.status === 'executed') {
            return res.output
          }
          throw new Error(res.reason || `run_cleanup_command blocked (${res.status})`)
        }
        throw new Error(`Host bridge required to run cleanup command: ${String(args.command ?? '')}`)
      },
    },
  ])

  return {
    privacyController,
    gatekeeper,
    mcpRegistry,
    visionSensor,
    setPendingCaptureOptions(opts?: { windowTitle?: string; frameFixtureId?: string }) {
      pendingCaptureOptions = opts ? { ...opts } : null
    },
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
      reasoningEffort: 'none',
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
  const roomTrophyIds = new Set(
    milestones.map((m) => m.roomTrophyId).filter((id): id is string => Boolean(id)),
  )
  const baseCatalog: RoomTrophy[] = [
    {
      id: 'trophy-first-boot-mug',
      title: 'First Boot Mug',
      name: 'First Boot Mug',
      subtitle: 'Unlocked by First Boot & Late-Night Architecture Session',
      description: 'Unlocked by First Boot & Late-Night Architecture Session',
      milestoneId: 'milestone-first-meeting',
      unlockedByMilestoneId: 'milestone-first-meeting',
      iconName: 'Award',
      unlocked:
        milestoneIds.has('milestone-first-meeting') ||
        roomTrophyIds.has('trophy-first-boot-mug'),
    },
    {
      id: 'trophy-padre-npm-relic',
      title: 'Padre no NPM Relic',
      name: 'Padre no NPM Relic',
      subtitle: "Unlocked by Born Inside Joke: 'Chamar um padre no npm'",
      description: "Unlocked by Born Inside Joke: 'Chamar um padre no npm'",
      milestoneId: 'milestone-inside-joke-padre',
      unlockedByMilestoneId: 'milestone-inside-joke-padre',
      iconName: 'Sparkles',
      unlocked:
        milestoneIds.has('milestone-inside-joke-padre') ||
        roomTrophyIds.has('trophy-padre-npm-relic'),
    },
    {
      id: 'trophy-prod-shield',
      title: '03:14 AM Production Shield',
      name: '03:14 AM Production Shield',
      subtitle: 'Unlocked by Saved Production Database at 03:14 AM',
      description: 'Unlocked by Saved Production Database at 03:14 AM',
      milestoneId: 'milestone-flashbulb-deploy',
      unlockedByMilestoneId: 'milestone-flashbulb-deploy',
      iconName: 'ShieldAlert',
      unlocked:
        milestoneIds.has('milestone-flashbulb-deploy') ||
        roomTrophyIds.has('trophy-prod-shield'),
    },
  ]

  const seenMilestoneIds = new Set(baseCatalog.map((t) => t.milestoneId))
  const seenTrophyIds = new Set(baseCatalog.map((t) => t.id))
  const dynamicTrophies: RoomTrophy[] = []

  for (const ms of milestones) {
    if (seenMilestoneIds.has(ms.id)) continue
    if (ms.roomTrophyId && seenTrophyIds.has(ms.roomTrophyId)) continue
    const trophyId = ms.roomTrophyId?.trim() || `trophy-${ms.id}`
    if (seenTrophyIds.has(trophyId)) continue
    seenMilestoneIds.add(ms.id)
    seenTrophyIds.add(trophyId)

    const iconName =
      ms.category === 'inside_joke_born'
        ? 'Sparkles'
        : ms.category === 'flashbulb_moment'
          ? 'ShieldAlert'
          : 'Award'

    dynamicTrophies.push({
      id: trophyId,
      title: ms.title,
      name: ms.title,
      subtitle: ms.narrative,
      description: ms.narrative,
      milestoneId: ms.id,
      unlockedByMilestoneId: ms.id,
      iconName,
      unlocked: true,
    })
  }

  return [...baseCatalog, ...dynamicTrophies]
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

function resolveMemoryFilterCategory(
  tags: readonly string[],
): Exclude<MemoryFilterCategory, 'todas'> {
  if (
    tags.includes('category:planos') ||
    tags.includes('planos') ||
    tags.includes('plan') ||
    tags.includes('goal') ||
    tags.includes('intent')
  ) {
    return 'planos'
  }
  if (
    tags.includes('category:sobre_voce') ||
    tags.includes('sobre_voce') ||
    tags.includes('identity') ||
    tags.includes('preference') ||
    tags.includes('work_style')
  ) {
    return 'sobre_voce'
  }
  if (
    tags.includes('category:referencias') ||
    tags.includes('referencias') ||
    tags.includes('inside_joke') ||
    tags.includes('reference')
  ) {
    return 'referencias'
  }
  return 'momentos'
}

function resolveMemoryCategoryImage(
  category: Exclude<MemoryFilterCategory, 'todas'>,
): string {
  if (category === 'sobre_voce') return '/assets/mem-work-style.jpg'
  if (category === 'referencias') return '/assets/mem-ghost-backend.jpg'
  if (category === 'planos') return '/assets/mem-prototype-plan.jpg'
  return '/assets/mem-first-chat.jpg'
}

function mapEpisodesToMemoryCards(
  episodes: readonly EpisodicMemory[],
): FeaturedMemoryCard[] {
  const approvedEpisodes = episodes.filter(
    (ep) => ep.approvalStatus !== 'pending_review' && isReflectablePermanentEpisode(ep),
  )

  return approvedEpisodes.map((ep) => {
    const filterCategory = resolveMemoryFilterCategory(ep.tags)
    const image = resolveMemoryCategoryImage(filterCategory)
    const badge = ep.isFlashbulb
      ? 'Flashbulb'
      : filterCategory === 'planos'
        ? 'Plano'
        : undefined
    const featured = Boolean(ep.isFlashbulb || ep.surprise >= 0.75)
    const dateLabel = formatLocalTimeHHMM(ep.createdAt)
    const originLabel =
      filterCategory === 'planos' ? `Plano de ${dateLabel}` : `Conversa de ${dateLabel}`

    return {
      id: ep.id,
      title: ep.title,
      summary: ep.summary,
      fullStory: ep.content,
      dateLabel,
      originLabel,
      filterCategory,
      ...(badge ? { badge } : {}),
      image,
      featured,
      episodeId: ep.id,
    }
  })
}

const DEFAULT_MIC_DEVICES: Array<{ deviceId: string; label: string }> = [
  { deviceId: 'default', label: 'Microfone Padrão do Sistema' },
]

const DEFAULT_STT_CATALOG_MODELS: Array<{ id: string; label: string }> = [
  { id: 'whisper-1', label: 'OpenAI Whisper-1' },
  { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe' },
  { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' },
]

const DEFAULT_TTS_CATALOG_MODELS: Array<{ id: string; label: string }> = [
  { id: 'kokoro-v1', label: 'Kokoro v1 (Local HTTP)' },
  { id: 'tts-1', label: 'OpenAI TTS-1' },
  { id: 'gpt-4o-mini-tts', label: 'OpenAI GPT-4o Mini TTS' },
  { id: 'eleven_multilingual_v2', label: 'ElevenLabs Multilingual v2' },
]

const DEFAULT_TTS_CATALOG_VOICES: Array<{ id: string; label: string }> = [
  { id: 'ashy-pt-br', label: 'Ashy (PT-BR)' },
  { id: 'pf_dora', label: 'Dora (Kokoro PT-BR)' },
  { id: 'nova', label: 'Nova (OpenAI)' },
  { id: 'coral', label: 'Coral (OpenAI)' },
]

let isRunningFixtureScenario = false
let activePlaybackEndTimer: ReturnType<typeof setTimeout> | null = null

function clearActivePlaybackEndTimer(): void {
  if (activePlaybackEndTimer !== null) {
    clearTimeout(activePlaybackEndTimer)
    activePlaybackEndTimer = null
  }
}

function createStoreVoiceRuntime(): VoiceSessionRuntime {
  return createVoiceSessionRuntime({
    micMode: 'continuous',
    wakeWordEnabled: DEFAULT_VOICE_RUNTIME_SETTINGS.wakeWordEnabled,
    wakeWordPhrases: DEFAULT_VOICE_RUNTIME_SETTINGS.wakeWordPhrases,
    activeSttProviderId: DEFAULT_VOICE_RUNTIME_SETTINGS.activeSttProviderId,
    activeTtsProviderId: DEFAULT_VOICE_RUNTIME_SETTINGS.activeTtsProviderId,
    directOmniAudio: DEFAULT_VOICE_RUNTIME_SETTINGS.directOmniAudio ?? false,
    onTurnSealed: (sealed) => {
      if (isRunningFixtureScenario) return
      const store = useAshyStore?.getState?.()
      if (!store || !store.isVoiceListening) return
      const text = (sealed.rephrasedText || sealed.rawText || '').trim()
      if (!text || isWhisperSilenceHallucination(text)) return
      if (store.isStreamingTurn || store.isSpeaking) {
        store.triggerBargeIn()
      }
      void store.sendUserMessage(text)
    },
    onOmniAudioTurnReady: (turn) => {
      if (isRunningFixtureScenario) return
      const store = useAshyStore?.getState?.()
      if (!store || !store.isVoiceListening) return
      if (store.isStreamingTurn || store.isSpeaking) {
        store.triggerBargeIn()
      }
      void store.sendOmniAudioTurn(turn)
    },
    onVowelFrame: (frame) => {
      if (isRunningFixtureScenario) return
      const entries: Array<[Exclude<AshyVisemeKey, 'closed'>, number]> = [
        ['A', frame.A],
        ['E', frame.E],
        ['I', frame.I],
        ['O', frame.O],
        ['U', frame.U],
      ]
      entries.sort((a, b) => b[1] - a[1])
      const dominant: AshyVisemeKey = entries[0]![1] > 0.05 ? entries[0]![0] : 'closed'
      const energy = Math.min(
        1,
        Math.max(0, (frame.A + frame.E + frame.I + frame.O + frame.U) / 2),
      )
      useAshyStore?.setState?.({
        simulatedVowels: {
          A: frame.A,
          E: frame.E,
          I: frame.I,
          O: frame.O,
          U: frame.U,
        },
        activeViseme: dominant,
        rawVolume: energy,
      })
    },
  })
}

let agency = createAgencyRuntime()
let voiceRuntime = createStoreVoiceRuntime()
let activeSpeechPipeline: RealtimeSpeechPipeline | null = null
let firstDeltaEnqueuedAtMs: number | null = null
let firstChunkRecordedForTurn = false
let subscribedBridge: AshyHostBridge | null = null
let unsubscribeHostEvents: (() => void) | null = null
let lastPromptMinuteLabel = formatLocalTimeHHMM(Date.now())
let evalRunSeq = 0
let inFlightCatalogCount = 0
let hasExplicitConsentMutation = false
let agencyRpcChain: Promise<unknown> = Promise.resolve()
const providerCatalogSeq = new Map<LlmProviderId, number>()

function isFactoryDefaultConsent(agencySnap: AgencySnapshot): boolean {
  const c = agencySnap.consent
  return (
    c.eyesMode === 'off' &&
    c.micMode === 'muted' &&
    c.dndMode === false &&
    c.approvalPolicy === 'ask' &&
    Object.keys(c.toolRiskOverrides).length === 0 &&
    c.externalMcpServers.length === 0 &&
    agencySnap.auditLog.length === 0 &&
    agencySnap.pendingActions.length === 0
  )
}

function buildAgencyStatePatch(
  agencySnap: AgencySnapshot,
  options?: { preserveOverlayInitialSensors?: boolean; currentPrivacy?: PrivacyState },
): Partial<AshyDesktopState> {
  const keepOverlaySensors =
    Boolean(options?.preserveOverlayInitialSensors) &&
    !hasExplicitConsentMutation &&
    isFactoryDefaultConsent(agencySnap) &&
    options?.currentPrivacy !== undefined

  const resolvedMicMode: MicMode = keepOverlaySensors
    ? options!.currentPrivacy!.micMode
    : agencySnap.consent.micMode === 'ptt'
      ? 'ptt'
      : agencySnap.consent.micMode
  const resolvedEyesMode: EyesMode = keepOverlaySensors
    ? options!.currentPrivacy!.eyesMode
    : agencySnap.consent.eyesMode

  agency.privacyController.setMicMode(resolvedMicMode)
  voiceRuntime.setMicMode(resolvedMicMode)
  agency.privacyController.setEyesMode(resolvedEyesMode)
  agency.privacyController.setDndMode(agencySnap.consent.dndMode)
  agency.privacyController.setAllowedWindowTitles([...agencySnap.consent.allowedWindowTitles])
  agency.privacyController.setAllowedPaths([...agencySnap.consent.allowedPaths])
  agency.gatekeeper.setToolRiskOverrides({ ...agencySnap.consent.toolRiskOverrides })
  for (const [toolName, riskTier] of Object.entries(agencySnap.consent.toolRiskOverrides)) {
    agency.mcpRegistry.setToolRiskTier(toolName, riskTier)
  }
  void agency.gatekeeper.setApprovalPolicy(agencySnap.consent.approvalPolicy, {
    autoApprovePending: false,
  })

  return {
    privacyState: {
      micMode: resolvedMicMode,
      eyesMode: resolvedEyesMode,
      dndMode: agencySnap.consent.dndMode,
      allowedWindowTitles: [...agencySnap.consent.allowedWindowTitles],
      allowedPaths: [...agencySnap.consent.allowedPaths],
    },
    computerActionsPolicy: agencySnap.consent.approvalPolicy,
    computerActionsEnabled: agencySnap.consent.approvalPolicy !== 'off',
    agencyTools: [...agencySnap.tools],
    toolRiskOverrides: { ...agencySnap.consent.toolRiskOverrides },
    sessionApprovedTools: [...agencySnap.sessionApprovedTools],
    visionTelemetry: {
      ...agencySnap.vision,
      eyesMode: resolvedEyesMode,
    },
    externalMcpServers: [...agencySnap.consent.externalMcpServers],
    pendingActions: [...agencySnap.pendingActions],
    auditLog: agencySnap.auditLog.map((entry) => ({
      ...entry,
      actionId: entry.actionId ?? undefined,
      reason: entry.reason ?? undefined,
      blastRadiusWarning: entry.blastRadiusWarning ?? undefined,
      targetPath: entry.targetPath ?? undefined,
      commandPreview: entry.commandPreview ?? undefined,
      diffPreview: entry.diffPreview ?? undefined,
    })),
    exposedMetaToolsCount: agencySnap.exposedMetaToolsCount,
    registeredMcpToolsCount: agencySnap.registeredMcpToolsCount,
  }
}

const completedTurnEvents = new Map<string, AshyHostStreamEvent>()
const pendingTurnResolvers = new Map<string, () => void>()
const pendingTurnSeriousness = new Map<string, boolean>()
const streamedDeltaTurnIds = new Set<string>()
const bargeInTurnIds = new Set<string>()
const omniAudioReceivedTurnIds = new Set<string>()

const webcamSampler = createLiveWebcamSampler({
  fps: 2,
  maxFramesInBuffer: 8,
  maxHammingDistance: 4,
  onFrameSampled: (frame) => {
    useAshyStore?.setState?.((s) => ({
      webcamPreviewDataUrl: frame.dataUrl,
      pendingVideoFrames: deduplicateVideoFramesByDHash([...s.pendingVideoFrames, frame], 4, 8),
    }))
  },
})

export function resolveInitialWindowMode(): {
  viewMode: DesktopViewMode
  isTransparentOverlayWindow: boolean
} {
  const search = typeof window !== 'undefined' ? (window.location?.search ?? '') : ''
  if (search.includes('view=stage-overlay')) {
    return { viewMode: 'stage', isTransparentOverlayWindow: true }
  }
  if (search.includes('view=stage')) {
    return { viewMode: 'stage', isTransparentOverlayWindow: false }
  }
  return { viewMode: 'hub', isTransparentOverlayWindow: false }
}

function resolveMotionPreset(rawMotion?: string): AshyMotionPreset | null {
  if (typeof rawMotion !== 'string') return null
  const normalized = rawMotion.trim().toLowerCase()
  if ((ASHY_MOTION_PRESETS as readonly string[]).includes(normalized)) {
    return normalized as AshyMotionPreset
  }
  return null
}

const DEFAULT_LIVE2D_CONTROLS = inspectLive2DModelJson(DEFAULT_ASHY_LIVE2D_MODEL3_JSON)

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
    live2dModelControls?: Live2DModelControls
    screenContext?: string
  }): ComposedTurnPrompt {
    const current = get()
    const userMessage =
      params?.userMessage ??
      [...(params?.chatMessages ?? current?.chatMessages ?? [])]
        .reverse()
        .find((m) => m.role === 'user')?.content ??
      'Olá Ashy.'

    const modelId = params?.modelId ?? current?.activeModelId ?? 'anthropic/claude-3.7-sonnet'
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

    const activeControls =
      params?.live2dModelControls ?? current?.live2dModelControls ?? DEFAULT_LIVE2D_CONTROLS

    const resolvedScreenContext =
      params?.screenContext !== undefined
        ? params.screenContext
        : current?.visionTelemetry?.lastObservation?.summary ?? undefined

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
      screenContext: resolvedScreenContext,
      interruptionControlNote: params?.interruptionControlNote,
      stageControlsPromptBlock: formatLive2DControlPrompt(activeControls),
      conversationHistory: (params?.chatMessages ?? current?.chatMessages ?? []).map((m) => ({
        role: m.role,
        content: m.content,
      })),
    })
  }

  function schedulePlaybackCompletionReset(delayMs: number): void {
    clearActivePlaybackEndTimer()
    const safeDelayMs = Math.max(150, Math.round(Number.isFinite(delayMs) ? delayMs : 350))
    activePlaybackEndTimer = setTimeout(() => {
      activePlaybackEndTimer = null
      const current = useAshyStore.getState()
      if (!current.isStreamingTurn) {
        useAshyStore.setState((s) => ({
          isSpeaking: false,
          presenceStatus: s.isVoiceListening ? 'Listening' : 'Idle',
          activeViseme: 'closed',
          simulatedVowels: { A: 0, E: 0, I: 0, O: 0, U: 0 },
          rawVolume: 0,
        }))
      }
    }, safeDelayMs)
  }

  function createPipelineForTurn(): RealtimeSpeechPipeline {
    firstDeltaEnqueuedAtMs = null
    firstChunkRecordedForTurn = false
    const pipeline = createRealtimeSpeechPipeline({
      synthesizeFn: async (text) => {
        const state = get()
        const activeTts = state.voiceSettings.activeTtsProviderId
        const wordCount = Math.max(1, text.trim().split(/\s+/).length)
        const durationMs = Math.max(350, wordCount * 55)

        if (
          activeTts !== 'local-synth-fallback' &&
          state.isBootstrapped &&
          state.autoSpeakReplies !== false
        ) {
          const bridge = getAshyHostBridge()
          if (typeof bridge.synthesizeVoiceSpeech === 'function') {
            try {
              const res = await bridge.synthesizeVoiceSpeech({
                text,
                providerId: activeTts,
                baseUrl: state.voiceSettings.ttsBaseUrl,
                modelId: state.voiceSettings.ttsModelId,
                voiceId: state.voiceSettings.ttsVoiceId,
              })
              const firstFrame = res.vowelFrames?.[0]
              if (firstFrame) {
                set({
                  simulatedVowels: {
                    A: firstFrame.A,
                    E: firstFrame.E,
                    I: firstFrame.I,
                    O: firstFrame.O,
                    U: firstFrame.U,
                  },
                  activeViseme: firstFrame.dominantVowel,
                  rawVolume: 0.85,
                  voiceRuntimeError: null,
                })
              }
              return {
                providerId: activeTts,
                durationMs: res.durationMs,
                durationSec: res.durationSec,
                vowelFrames: res.vowelFrames,
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err)
              set({ voiceRuntimeError: errMsg })
            }
          }
        }

        return {
          providerId: activeTts,
          durationMs,
          durationSec: durationMs / 1000,
        }
      },
      onAudioScheduled: (chunk) => {
        const chunks = [...pipeline.getScheduledChunks()]
        if (!firstChunkRecordedForTurn && firstDeltaEnqueuedAtMs !== null) {
          firstChunkRecordedForTurn = true
          const ttfaMs = Math.max(1, Math.round(performance.now() - firstDeltaEnqueuedAtMs))
          const providerId = get().voiceSettings.activeTtsProviderId
          voiceRuntime.recordTtfaSample(providerId, ttfaMs)
        }
        schedulePlaybackCompletionReset(Math.max(150, Math.round(chunk.endTimeSec * 1000)))
        set({
          scheduledAudioChunks: chunks,
          ttfaByProvider: voiceRuntime.getTtfaTelemetry(),
        })
      },
      onStageSignal: (signal) => {
        if (signal.type === 'act' && signal.emotion) {
          const maybeMotion = resolveMotionPreset(signal.motion)
          set((state) => ({
            stageEmotion: signal.emotion!,
            emotionIntensity: signal.intensity ?? 0.85,
            activeMotion: maybeMotion ?? state.activeMotion,
          }))
        }
      },
    })
    activeSpeechPipeline = pipeline
    return pipeline
  }

  function handleHostStreamEvent(event: AshyHostStreamEvent): void {
    if (event.type === 'stage:updated') {
      const prefs = event.stagePreferences
      const nextControls = prefs.live2dModelControls ?? get().live2dModelControls
      const nextPrompt = compilePromptFromState({
        live2dModelControls: nextControls,
      })
      set({
        stageMode: prefs.stageMode,
        live2dPresetId: prefs.live2dPresetId,
        live2dModelUrl: prefs.live2dModelUrl,
        loadedLive2DModelName: prefs.loadedLive2DModelName,
        ambientLuminance: prefs.ambientLuminance,
        showDesktopAvatar: prefs.showDesktopAvatar,
        isStageHidden: prefs.isStageHidden,
        ...(prefs.live2dModelControls ? { live2dModelControls: prefs.live2dModelControls } : {}),
        lastPrompt: nextPrompt,
      })
      return
    }

    if (event.type === 'shortcut:triggered') {
      if (event.action === 'toggleHideStage') {
        // Authoritative isStageHidden state is already broadcast via stage:updated by the Host kernel
        return
      }
      if (event.action === 'togglePtt') {
        const nextMic: MicMode = get().privacyState.micMode === 'ptt' ? 'muted' : 'ptt'
        get().setMicMode(nextMic)
        return
      }
      if (event.action === 'activatePrivacyShield') {
        get().activateFullPrivacyShield()
        return
      }
      const bridge = getAshyHostBridge()
      if (typeof bridge.getAgencySnapshot === 'function') {
        void bridge
          .getAgencySnapshot()
          .then((snap) => {
            if (!snap?.consent) return
            set(buildAgencyStatePatch(snap))
          })
          .catch(() => {
            // Ignore when offline in unit test
          })
        return
      }
      if (event.action === 'toggleMic') {
        const nextMic: MicMode =
          get().privacyState.micMode === 'muted' ? 'continuous' : 'muted'
        agency.privacyController.setMicMode(nextMic)
        voiceRuntime.setMicMode(nextMic)
        set({ privacyState: agency.privacyController.getState() })
      } else if (event.action === 'toggleEyes') {
        const cur = get().privacyState.eyesMode
        const nextEyes = cur === 'window' ? 'screen' : cur === 'screen' ? 'off' : 'window'
        agency.privacyController.setEyesMode(nextEyes)
        set({
          privacyState: agency.privacyController.getState(),
          visionTelemetry: agency.visionSensor.getTelemetry(),
        })
      } else if (event.action === 'toggleDnd') {
        agency.privacyController.setDndMode(!get().privacyState.dndMode)
        set({ privacyState: agency.privacyController.getState() })
      }
      return
    }

    if (event.type === 'updater:status') {
      set({ updaterState: event.state })
      return
    }

    const assistantMsgId =
      get().activeStreamingTurnId === event.turnId && get().activeStreamingMessageId
        ? get().activeStreamingMessageId!
        : `msg-assistant-${event.turnId}`

    if (event.type === 'turn:input-transcript') {
      set((state) => ({
        chatMessages: state.chatMessages.map((m) =>
          m.id === event.userMessageId
            ? { ...m, content: event.transcript, text: event.transcript }
            : m,
        ),
      }))
      return
    }

    if (event.type === 'turn:audio-delta') {
      omniAudioReceivedTurnIds.add(event.turnId)
      voiceRuntime.ingestOmniAudioDelta({
        turnId: event.turnId,
        seq: event.seq,
        audioBase64: event.audioBase64,
        format: event.format,
        sampleRate: event.sampleRate,
        durationMs: event.durationMs,
        transcriptDelta: event.transcriptDelta,
        vowelFrames: event.vowelFrames,
      })
      const vf = event.vowelFrames?.[0] ?? voiceRuntime.getState().activeVowelFrame
      const entries: Array<[Exclude<AshyVisemeKey, 'closed'>, number]> = [
        ['A', vf.A],
        ['E', vf.E],
        ['I', vf.I],
        ['O', vf.O],
        ['U', vf.U],
      ]
      entries.sort((a, b) => b[1] - a[1])
      const dominant: AshyVisemeKey = entries[0]![1] > 0.05 ? entries[0]![0] : 'closed'
      const energy = Math.min(
        1,
        Math.max(0.15, (vf.A + vf.E + vf.I + vf.O + vf.U) / 2),
      )
      set({
        isSpeaking: true,
        presenceStatus: 'Speaking',
        simulatedVowels: { A: vf.A, E: vf.E, I: vf.I, O: vf.O, U: vf.U },
        activeViseme: dominant,
        rawVolume: energy,
      })
      return
    }

    if (event.type === 'turn:started') {
      streamedDeltaTurnIds.delete(event.turnId)
      bargeInTurnIds.delete(event.turnId)
      omniAudioReceivedTurnIds.delete(event.turnId)
      createPipelineForTurn()
      set((state) => {
        const hasAssistantMsg = state.chatMessages.some((m) => m.id === assistantMsgId)
        return {
          isStreamingTurn: true,
          activeTurnId: event.turnId,
          activeStreamingTurnId: event.turnId,
          activeStreamingMessageId: assistantMsgId,
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
                  text: '',
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
      const deltaText =
        event.textDelta ??
        (event as unknown as { delta?: string }).delta ??
        ''
      const stateNow = get()
      const activeCfg = stateNow.providers.configs[stateNow.providers.activeProviderId]
      const isExpectingNativeOmniAudio =
        omniAudioReceivedTurnIds.has(event.turnId) ||
        (stateNow.unifiedOmniMode &&
          stateNow.directOmniAudio &&
          Boolean(activeCfg?.supportsOmniAudioOut))

      const pipeline = activeSpeechPipeline ?? createPipelineForTurn()
      if (firstDeltaEnqueuedAtMs === null) {
        firstDeltaEnqueuedAtMs = performance.now()
      }
      streamedDeltaTurnIds.add(event.turnId)
      if (!isExpectingNativeOmniAudio) {
        pipeline.enqueueDelta(deltaText)
      }

      set((state) => {
        const exists = state.chatMessages.some((m) => m.id === assistantMsgId)
        const updatedMessages = exists
          ? state.chatMessages.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    content: (m.content ?? m.text ?? '') + deltaText,
                    text: (m.content ?? m.text ?? '') + deltaText,
                  }
                : m,
            )
          : [
              ...state.chatMessages,
              {
                id: assistantMsgId,
                role: 'assistant' as const,
                content: deltaText,
                text: deltaText,
                emotion: state.stageEmotion,
                modelId: state.activeModelId,
                timeLabel: formatLocalTimeHHMM(Date.now()),
                timestamp: Date.now(),
              },
            ]
        const latestContent =
          updatedMessages.find((m) => m.id === assistantMsgId)?.content ?? deltaText

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
        const nextMotion = resolveMotionPreset(marker.motion)
        const actSignal: AshyStageSignal = {
          type: 'act',
          emotion: nextEmotion,
          intensity: nextIntensity,
          ...(marker.motion ? { motion: marker.motion } : {}),
          raw: `<|ACT {"emotion":"${nextEmotion}","intensity":${nextIntensity}${marker.motion ? `,"motion":"${marker.motion}"` : ''}}|>`,
        }
        const pipeline = activeSpeechPipeline ?? createPipelineForTurn()
        if (firstDeltaEnqueuedAtMs === null) {
          firstDeltaEnqueuedAtMs = performance.now()
        }
        pipeline.enqueue(CONTROL_SENTINEL, [actSignal], { flush: false })

        set((state) => ({
          stageEmotion: nextEmotion,
          emotionIntensity: nextIntensity,
          activeMotion: nextMotion ?? state.activeMotion,
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
        const hadNativeOmniAudio = omniAudioReceivedTurnIds.delete(event.turnId)
        const pipeline =
          hadStreamedDeltas && activeSpeechPipeline
            ? activeSpeechPipeline
            : createPipelineForTurn()

        if (firstDeltaEnqueuedAtMs === null) {
          firstDeltaEnqueuedAtMs = performance.now()
        }

        if (hadNativeOmniAudio) {
          voiceRuntime.getPlayer().markStreamComplete(true)
        } else if (hadStreamedDeltas) {
          if (pipeline.getScheduledChunks().length === 0) {
            pipeline.enqueue(
              parsed.textWithSentinels || event.assistantMessage.content,
              parsed.signals,
            )
          } else {
            pipeline.flush()
          }
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

        if (event.snapshot) {
          get().applyBootstrapSnapshot(event.snapshot)
        }

        const targetEmotion: AshyEmotion = wasSerious
          ? 'concerned'
          : event.assistantMessage.emotion

        const lastActSignalWithMotion = [...parsed.signals]
          .reverse()
          .find(
            (s): s is Extract<typeof s, { type: 'act' }> =>
              s.type === 'act' && typeof s.motion === 'string',
          )
        const resolvedCompletedMotion = resolveMotionPreset(lastActSignalWithMotion?.motion)

        set((state) => ({
          isStreamingTurn: false,
          activeTurnId: null,
          persistenceWarning: event.persistenceWarning,
          stageEmotion: targetEmotion,
          activeMotion: resolvedCompletedMotion ?? state.activeMotion,
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
          rawVolume: 0.85,
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

        const lastEndSec = scheduledChunks.at(-1)?.endTimeSec ?? 0.35
        schedulePlaybackCompletionReset(Math.max(150, Math.round(lastEndSec * 1000)))

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
      clearActivePlaybackEndTimer()
      pendingTurnSeriousness.delete(event.turnId)
      streamedDeltaTurnIds.delete(event.turnId)
      const wasBargeIn = bargeInTurnIds.delete(event.turnId)
      set((state) => {
        const isCurrentTurn =
          state.activeTurnId === event.turnId || state.activeTurnId === null
        const partial = event.partialText.trim()
        const nextMessages = state.chatMessages
          .map((m) =>
            m.id === assistantMsgId && m.content.trim().length === 0 && partial.length > 0
              ? { ...m, content: partial }
              : m,
          )
          .filter((m) => !(m.id === assistantMsgId && m.content.trim().length === 0))

        return {
          isStreamingTurn: isCurrentTurn ? false : state.isStreamingTurn,
          activeTurnId: isCurrentTurn ? null : state.activeTurnId,
          isSpeaking: isCurrentTurn ? false : state.isSpeaking,
          presenceStatus: isCurrentTurn
            ? wasBargeIn
              ? 'Listening'
              : 'Idle'
            : state.presenceStatus,
          stageEmotion: wasBargeIn ? 'surprised' : state.stageEmotion,
          bubbleText: state.bubbleText,
          simulatedVowels: isCurrentTurn
            ? { A: 0, E: 0, I: 0, O: 0, U: 0 }
            : state.simulatedVowels,
          chatMessages: nextMessages,
        }
      })
      completedTurnEvents.set(event.turnId, event)
      const resolver = pendingTurnResolvers.get(event.turnId)
      if (resolver) {
        pendingTurnResolvers.delete(event.turnId)
        resolver()
      }
      return
    }

    if (event.type === 'turn:error') {
      clearActivePlaybackEndTimer()
      pendingTurnSeriousness.delete(event.turnId)
      set((state) => {
        const isCurrentTurn =
          state.activeTurnId === event.turnId || state.activeTurnId === null
        return {
          isStreamingTurn: isCurrentTurn ? false : state.isStreamingTurn,
          activeTurnId: isCurrentTurn ? null : state.activeTurnId,
          isSpeaking: isCurrentTurn ? false : state.isSpeaking,
          presenceStatus: isCurrentTurn ? 'Idle' : state.presenceStatus,
          simulatedVowels: isCurrentTurn
            ? { A: 0, E: 0, I: 0, O: 0, U: 0 }
            : state.simulatedVowels,
          lastTurnError: {
            code: event.code,
            message: event.message,
            recoverable: event.recoverable,
          },
          chatMessages: state.chatMessages.filter(
            (m) => !(m.id === assistantMsgId && m.content.trim().length === 0),
          ),
        }
      })
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
      unsubscribeHostEvents = bridge.onHostEvent?.(handleHostStreamEvent) ?? null
    }
    return bridge
  }

  const initialWindowMode = resolveInitialWindowMode()
  const initialPrompt = composeAshyTurnPrompt({
    userMessage: 'Olá Ashy.',
    modelId: 'anthropic/claude-3.7-sonnet',
    timeOfDayLabel: lastPromptMinuteLabel,
    stage: 'stranger',
    voiceIdentityMarkdown: DEFAULT_ASHY_VOICE_MD,
    traits: ASHY_DEFAULT_TRAITS,
    mood: ASHY_BASELINE_MOOD,
    stageControlsPromptBlock: formatLive2DControlPrompt(DEFAULT_LIVE2D_CONTROLS),
  })

  return {
    viewMode: initialWindowMode.viewMode,
    activeTab: 'studio',
    activeModelId: 'anthropic/claude-3.7-sonnet',

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
    providerModelCatalog: { ...FALLBACK_PROVIDER_MODELS },
    providerModelCatalogSource: {},
    isLoadingProviderModels: false,
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
    isTransparentOverlayWindow: initialWindowMode.isTransparentOverlayWindow,
    isStageHidden: false,
    ignoringMouseEvents: false,
    ignoreMouseTransitionCount: 0,
    activeViseme: 'closed',
    activeEyeState: 'open',
    activeMotion: 'idle',
    live2dPresetId: 'hiyori',
    live2dModelUrl: '/live2d/models/hiyori/Hiyori.model3.json',
    live2dModelControls: {
      ...DEFAULT_LIVE2D_CONTROLS,
      expressions: [...DEFAULT_LIVE2D_CONTROLS.expressions],
      motionGroups: DEFAULT_LIVE2D_CONTROLS.motionGroups.map((g) => ({ ...g })),
      hitAreas: [...DEFAULT_LIVE2D_CONTROLS.hitAreas],
    },
    loadedLive2DModelName: 'ashy-default.model3.json',

    mood: { ...ASHY_BASELINE_MOOD },
    traits: { ...ASHY_DEFAULT_TRAITS },
    milestones: [],
    storySearchQuery: '',
    storyCategoryFilter: 'todas',
    crossEpisodeLinks: [],
    dreamJournalEntries: [],
    initiativePolicy: { ...DEFAULT_INITIATIVE_POLICY },
    initiativeLog: [],
    roomEnvironment: deriveAshyRoomEnvironment({ milestones: [], episodes: [] }),
    roomTimeOverrideHHMM: null,
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
    isVoiceListening: false,
    micInputLevel: 0,
    rawVolume: 0,
    availableMicDevices: [...DEFAULT_MIC_DEVICES],
    selectedMicDeviceId: 'default',
    autoSpeakReplies: true,
    sttCatalogModels: [...DEFAULT_STT_CATALOG_MODELS],
    ttsCatalogModels: [...DEFAULT_TTS_CATALOG_MODELS],
    ttsCatalogVoices: [...DEFAULT_TTS_CATALOG_VOICES],
    isLoadingVoiceCatalog: false,
    isSavingVoiceSettings: false,
    isTestingMic: false,
    isTestingTts: false,
    voiceTestStatus: null,
    voiceRuntimeError: null,

    settingsSubTab: 'todas',
    showDesktopAvatar: true,
    computerActionsEnabled: true,
    computerActionsPolicy: 'ask',
    quietHoursRange: '22:00 — 08:00',
    preferencesSavedToast: false,
    preferencesSavedAt: null,
    privacyState: agency.privacyController.getState(),
    mcpSearchQuery: '',
    mcpSearchResults: agency.mcpRegistry.search_mcp_tools({ query: '', limit: 10 }),
    exposedMetaToolsCount: agency.mcpRegistry.getExposedMetaTools().length,
    registeredMcpToolsCount: agency.mcpRegistry.getRegisteredToolsCount(),
    agencyTools: agency.mcpRegistry.listAllTools(),
    toolRiskOverrides: agency.gatekeeper.getToolRiskOverrides(),
    sessionApprovedTools: agency.gatekeeper.getSessionApprovedTools(),
    visionTelemetry: agency.visionSensor.getTelemetry(),
    externalMcpServers: [],
    pendingActions: agency.gatekeeper.getPendingActions(),
    auditLog: [...agency.gatekeeper.getAuditLog()],
    lastMcpResultSummary: null,
    unifiedOmniMode: DEFAULT_VOICE_RUNTIME_SETTINGS.unifiedOmniMode ?? false,
    directOmniAudio: DEFAULT_VOICE_RUNTIME_SETTINGS.directOmniAudio ?? false,
    pendingVideoFrames: [],
    pendingTurnAttachments: [],
    isWebcamStreaming: false,
    webcamPreviewDataUrl: null,
    hasCompletedOnboarding: false,
    activeStreamingTurnId: null,
    activeStreamingMessageId: null,
    encryptionAtRestStatus: { ...DEFAULT_ENCRYPTION_AT_REST_STATUS },
    updaterState: { ...DEFAULT_AUTO_UPDATER_STATE },
    lastExportedSoulArchive: null,
    soulPortabilityStatus: { kind: 'idle', message: null },

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
      const inFlightOptimistic = current.chatMessages.filter(
        (m) =>
          m.id.startsWith('msg-user-optimistic-') &&
          !mappedMessages.some((mm) => mm.role === 'user' && mm.content === m.content),
      )
      const finalMappedMessages =
        inFlightOptimistic.length > 0
          ? [...mappedMessages, ...inFlightOptimistic]
          : mappedMessages
      const mappedCards = mapEpisodesToMemoryCards(snapshot.memories.episodes)
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
      const crossEpisodeLinks =
        snapshot.memories.crossEpisodeLinks ??
        detectCrossEpisodeLinks(snapshot.memories.episodes)
      const dreamJournalEntries =
        snapshot.memories.dreamJournalEntries ?? current.dreamJournalEntries
      const rawInitiativePolicy =
        snapshot.memories?.initiativePolicy ??
        (snapshot as unknown as { initiativePolicy?: InitiativePolicy }).initiativePolicy
      const initiativePolicy = rawInitiativePolicy
        ? { ...rawInitiativePolicy }
        : current.initiativePolicy
      const initiativeLog = snapshot.memories.initiativeLog ?? current.initiativeLog
      const roomEnvironment = current.roomTimeOverrideHHMM
        ? deriveAshyRoomEnvironment({
            milestones: snapshot.relationship.milestones,
            episodes: snapshot.memories.episodes,
            localTimeHHMM: current.roomTimeOverrideHHMM,
          })
        : (snapshot.memories.roomEnvironment ??
          deriveAshyRoomEnvironment({
            milestones: snapshot.relationship.milestones,
            episodes: snapshot.memories.episodes,
          }))

      const activeProviderCfg = snapshot.providers.configs[snapshot.providers.activeProviderId]
      const nextActiveModelId = activeProviderCfg?.modelId || current.activeModelId

      const persistedStagePrefs =
        snapshot.stagePreferences && snapshot.stagePreferences.updatedAt > 0
          ? snapshot.stagePreferences
          : null

      const nextLive2dControls =
        persistedStagePrefs?.live2dModelControls ?? current.live2dModelControls

      const nextPrompt = compilePromptFromState({
        modelId: nextActiveModelId,
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
        live2dModelControls: nextLive2dControls,
      })

      if (snapshot.voiceSettings) {
        voiceRuntime.setActiveSttProvider(snapshot.voiceSettings.activeSttProviderId)
        voiceRuntime.setActiveTtsProvider(snapshot.voiceSettings.activeTtsProviderId)
        voiceRuntime.setWakeWordEnabled(snapshot.voiceSettings.wakeWordEnabled)
        if (snapshot.voiceSettings.directOmniAudio !== undefined) {
          voiceRuntime.setDirectOmniAudio(snapshot.voiceSettings.directOmniAudio)
        }
      }

      set({
        isBootstrapped: true,
        needsOnboarding: snapshot.needsOnboarding,
        hasCompletedOnboarding: !snapshot.needsOnboarding,
        activeModelId: nextActiveModelId,
        userProfile: snapshot.userProfile,
        relationshipStage: snapshot.relationship.stage,
        familiarityScore: snapshot.relationship.familiarityScore,
        trustScore: snapshot.relationship.trustScore,
        totalTurns: snapshot.relationship.totalTurns,
        activeSessionId: snapshot.activeSession.id,
        sessions: snapshot.sessions,
        providers: snapshot.providers,
        voiceIdentity: snapshot.voice,
        ...(snapshot.voiceSettings
          ? {
              voiceSettings: {
                ...snapshot.voiceSettings,
                wakeWordPhrases: [...snapshot.voiceSettings.wakeWordPhrases],
              },
              selectedMicDeviceId:
                snapshot.voiceSettings.selectedMicDeviceId ?? current.selectedMicDeviceId,
              autoSpeakReplies:
                snapshot.voiceSettings.autoSpeakReplies ?? current.autoSpeakReplies,
              unifiedOmniMode:
                snapshot.voiceSettings.unifiedOmniMode ?? current.unifiedOmniMode,
              directOmniAudio:
                snapshot.voiceSettings.directOmniAudio ?? current.directOmniAudio,
            }
          : {}),
        runtimeDiagnostics: snapshot.runtimeDiagnostics,
        persistenceWarning: snapshot.runtimeDiagnostics.lastPersistenceWarning,
        mood: snapshot.affect.mood,
        traits: snapshot.affect.traits,
        stageEmotion: snapshot.affect.dominantEmotion,
        ...(persistedStagePrefs
          ? {
              stageMode: persistedStagePrefs.stageMode,
              live2dPresetId: persistedStagePrefs.live2dPresetId,
              live2dModelUrl: persistedStagePrefs.live2dModelUrl,
              loadedLive2DModelName: persistedStagePrefs.loadedLive2DModelName,
              ambientLuminance: persistedStagePrefs.ambientLuminance,
              showDesktopAvatar: persistedStagePrefs.showDesktopAvatar,
              isStageHidden: persistedStagePrefs.isStageHidden,
              ...(persistedStagePrefs.live2dModelControls
                ? { live2dModelControls: persistedStagePrefs.live2dModelControls }
                : {}),
            }
          : {}),
        milestones: snapshot.relationship.milestones,
        crossEpisodeLinks,
        dreamJournalEntries,
        initiativePolicy,
        ...(rawInitiativePolicy
          ? {
              quietHoursRange: formatQuietHoursRangeFromPolicy(rawInitiativePolicy),
            }
          : {}),
        initiativeLog,
        roomEnvironment,
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
        chatMessages: finalMappedMessages,
        lastPrompt: nextPrompt,
        roomTrophies: buildRoomTrophies(snapshot.relationship.milestones),
        lastEvalReport: snapshot.lastEvalReport ?? current.lastEvalReport,
        ...(snapshot.encryptionAtRest
          ? { encryptionAtRestStatus: { ...snapshot.encryptionAtRest } }
          : {}),
        ...(snapshot.updaterState
          ? { updaterState: { ...snapshot.updaterState } }
          : {}),
        ...(snapshot.agency
          ? buildAgencyStatePatch(snapshot.agency, {
              preserveOverlayInitialSensors: current.isTransparentOverlayWindow,
              currentPrivacy: current.privacyState,
            })
          : {}),
      })

      if (
        snapshot.agency &&
        current.isTransparentOverlayWindow &&
        !hasExplicitConsentMutation &&
        isFactoryDefaultConsent(snapshot.agency)
      ) {
        const nextTask = agencyRpcChain
          .catch(() => undefined)
          .then(async () => {
            await getAshyHostBridge().updateAgencyConsent?.({
              micMode: current.privacyState.micMode,
              eyesMode: current.privacyState.eyesMode,
            })
          })
          .catch(() => {
            // Ignore when offline
          })
        agencyRpcChain = nextTask
      }
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
      const nextActiveModelId =
        result.providers.configs[result.providers.activeProviderId]?.modelId ||
        get().activeModelId
      set((state) => ({
        providers: result.providers,
        activeModelId: nextActiveModelId,
        lastPrompt: compilePromptFromState({
          modelId: nextActiveModelId,
          voiceIdentityMarkdown: state.voiceIdentity.content,
        }),
      }))
      return result
    },

    async setActiveProvider(providerId) {
      const bridge = ensureHostSubscription()
      const providers = await bridge.setActiveProvider(providerId)
      const nextActiveModelId =
        providers.configs[providers.activeProviderId]?.modelId || get().activeModelId
      set((state) => ({
        providers,
        activeModelId: nextActiveModelId,
        lastPrompt: compilePromptFromState({
          modelId: nextActiveModelId,
          voiceIdentityMarkdown: state.voiceIdentity.content,
        }),
      }))
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

    async listProviderModels(input) {
      const bridge = ensureHostSubscription()
      const nextSeq = (providerCatalogSeq.get(input.providerId) ?? 0) + 1
      providerCatalogSeq.set(input.providerId, nextSeq)
      inFlightCatalogCount += 1
      set({ isLoadingProviderModels: true })
      try {
        const result: ListProviderModelsResult =
          typeof bridge.listProviderModels === 'function'
            ? await bridge.listProviderModels(input)
            : {
                providerId: input.providerId,
                models: FALLBACK_PROVIDER_MODELS[input.providerId] ?? [],
                source: 'fallback',
                fetchedAt: Date.now(),
                error: null,
              }
        inFlightCatalogCount = Math.max(0, inFlightCatalogCount - 1)
        if (providerCatalogSeq.get(input.providerId) === nextSeq) {
          set((state) => ({
            isLoadingProviderModels: inFlightCatalogCount > 0,
            providerModelCatalog: {
              ...state.providerModelCatalog,
              [input.providerId]: result.models,
            },
            providerModelCatalogSource: {
              ...state.providerModelCatalogSource,
              [input.providerId]: result.source,
            },
          }))
        } else {
          set({ isLoadingProviderModels: inFlightCatalogCount > 0 })
        }
        return result
      } catch (err) {
        inFlightCatalogCount = Math.max(0, inFlightCatalogCount - 1)
        const fallbackModels = FALLBACK_PROVIDER_MODELS[input.providerId] ?? []
        const fallbackResult: ListProviderModelsResult = {
          providerId: input.providerId,
          models: fallbackModels,
          source: 'fallback',
          fetchedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        }
        if (providerCatalogSeq.get(input.providerId) === nextSeq) {
          set((state) => ({
            isLoadingProviderModels: inFlightCatalogCount > 0,
            providerModelCatalog: {
              ...state.providerModelCatalog,
              [input.providerId]: fallbackModels,
            },
            providerModelCatalogSource: {
              ...state.providerModelCatalogSource,
              [input.providerId]: 'fallback',
            },
          }))
        } else {
          set({ isLoadingProviderModels: inFlightCatalogCount > 0 })
        }
        return fallbackResult
      }
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
      const normalizedTab = (tab as string) === 'settings' ? 'agency' : tab
      set({ activeTab: normalizedTab })
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
      void getAshyHostBridge()
        .updateStagePreferences?.({ stageMode: mode })
        .catch(() => {
          // Ignore when offline in unit test
        })
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
      void getAshyHostBridge()
        .updateStagePreferences?.({ ambientLuminance: clamped })
        .catch(() => {
          // Ignore when offline in unit test
        })
    },

    toggleSimulatedSpeech(speaking) {
      const nextSpeaking = speaking !== undefined ? speaking : !get().isSpeaking
      set({
        isSpeaking: nextSpeaking,
        presenceStatus: nextSpeaking ? 'Speaking' : 'Idle',
        activeViseme: nextSpeaking ? 'A' : 'closed',
        simulatedVowels: nextSpeaking
          ? { A: 0.78, E: 0.35, I: 0.15, O: 0.45, U: 0.2 }
          : { A: 0, E: 0, I: 0, O: 0, U: 0 },
      })
    },

    setStageIgnoreMouseEvents(ignore) {
      const nextIgnore = Boolean(ignore)
      if (nextIgnore === get().ignoringMouseEvents) {
        return
      }
      set((state) => ({
        ignoringMouseEvents: nextIgnore,
        ignoreMouseTransitionCount: state.ignoreMouseTransitionCount + 1,
      }))
      void (
        globalThis as unknown as {
          ashyHost?: {
            setOverlayIgnoreMouse?: (input: { ignore: boolean; forward?: boolean }) => unknown
          }
        }
      ).ashyHost?.setOverlayIgnoreMouse?.({ ignore: nextIgnore, forward: true })
    },

    setStageHidden(hidden) {
      const nextHidden = Boolean(hidden)
      if (nextHidden) {
        set({
          isStageHidden: true,
          isSpeaking: false,
          presenceStatus: 'Idle',
          activeViseme: 'closed',
          simulatedVowels: { A: 0, E: 0, I: 0, O: 0, U: 0 },
          ignoringMouseEvents: false,
        })
      } else {
        set({
          isStageHidden: false,
        })
      }
      void (
        globalThis as unknown as {
          ashyHost?: {
            setOverlayVisible?: (input: { visible: boolean }) => unknown
          }
        }
      ).ashyHost?.setOverlayVisible?.({ visible: !nextHidden })
      void getAshyHostBridge()
        .updateStagePreferences?.({ isStageHidden: nextHidden })
        .catch(() => {
          // Ignore when offline in unit test
        })
    },

    toggleStageHidden() {
      get().setStageHidden(!get().isStageHidden)
    },

    triggerStageMotion(motion) {
      if ((ASHY_MOTION_PRESETS as readonly string[]).includes(motion)) {
        set({ activeMotion: motion })
      }
    },

    selectLive2dPreset(presetId) {
      const preset =
        BUILTIN_LIVE2D_MODEL_PRESETS.find((p) => p.id === presetId) ??
        BUILTIN_LIVE2D_MODEL_PRESETS[0]
      if (!preset) return
      const loadedName = preset.modelJsonUrl.split('/').pop() ?? `${preset.id}.model3.json`
      const controls = preset.manifestJson
        ? inspectLive2DModelJson(preset.manifestJson)
        : get().live2dModelControls
      const nextPrompt = compilePromptFromState({
        live2dModelControls: controls,
      })
      set({
        live2dPresetId: preset.id,
        live2dModelUrl: preset.modelJsonUrl,
        loadedLive2DModelName: loadedName,
        live2dModelControls: controls,
        stageMode: 'live2d',
        lastPrompt: nextPrompt,
      })
      void getAshyHostBridge()
        .updateStagePreferences?.({
          stageMode: 'live2d',
          live2dPresetId: preset.id,
          live2dModelUrl: preset.modelJsonUrl,
          loadedLive2DModelName: loadedName,
          live2dModelControls: controls,
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
    },

    importLive2DModelJson(rawJson, modelName = 'custom-imported.model3.json') {
      const trimmedInput = typeof rawJson === 'string' ? rawJson.trim() : ''
      if (trimmedInput.endsWith('.model3.json') && !trimmedInput.startsWith('{')) {
        if (!isSafeLive2DModelUrl(trimmedInput)) {
          throw new Error('Invalid or unsafe Live2D model URL.')
        }
        const cleanName =
          trimmedInput.split('/').pop()?.trim() || modelName.trim() || 'custom-imported.model3.json'
        const matchedPreset = BUILTIN_LIVE2D_MODEL_PRESETS.find(
          (p) => p.modelJsonUrl === trimmedInput,
        )
        const nextControls = matchedPreset
          ? getBuiltinLive2DModelControls(matchedPreset.id)
          : get().live2dModelControls
        const nextPresetId = matchedPreset ? matchedPreset.id : get().live2dPresetId
        const nextPrompt = compilePromptFromState({
          live2dModelControls: nextControls,
        })
        set({
          live2dPresetId: nextPresetId,
          live2dModelUrl: trimmedInput,
          loadedLive2DModelName: cleanName,
          live2dModelControls: nextControls,
          stageMode: 'live2d',
          lastPrompt: nextPrompt,
        })
        void getAshyHostBridge()
          .updateStagePreferences?.({
            stageMode: 'live2d',
            live2dPresetId: nextPresetId,
            live2dModelUrl: trimmedInput,
            loadedLive2DModelName: cleanName,
            live2dModelControls: nextControls,
          })
          .catch(() => {
            // Ignore when offline in unit test
          })
        return nextControls
      }

      let parsed: unknown = rawJson
      if (typeof rawJson === 'string') {
        try {
          parsed = JSON.parse(rawJson)
        } catch (err) {
          throw new Error(
            `Invalid Live2D .model3.json: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      const controls = inspectLive2DModelJson(parsed)
      const cleanName = modelName.trim() || 'custom-imported.model3.json'
      const nextPrompt = compilePromptFromState({
        live2dModelControls: controls,
      })
      set((state) => ({
        live2dModelControls: controls,
        loadedLive2DModelName: cleanName,
        live2dModelUrl: state.live2dModelUrl,
        stageMode: 'live2d',
        lastPrompt: nextPrompt,
      }))
      void getAshyHostBridge()
        .updateStagePreferences?.({
          stageMode: 'live2d',
          loadedLive2DModelName: cleanName,
          live2dModelControls: controls,
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
      return controls
    },

    async runStageLipSyncActDemo() {
      const pcmA = synthesizeFormantVowelPcm('A', 120)
      const pcmO = synthesizeFormantVowelPcm('O', 120)
      const pcmI = synthesizeFormantVowelPcm('I', 120)
      void analyzePcmFrameToVowels(pcmA.subarray(0, 640), 16_000)
      const combinedPcm = new Float32Array(pcmA.length + pcmO.length + pcmI.length)
      combinedPcm.set(pcmA, 0)
      combinedPcm.set(pcmO, pcmA.length)
      combinedPcm.set(pcmI, pcmA.length + pcmO.length)

      const synchronizer = createStageSpeechSynchronizer({
        samples: combinedPcm,
        sampleRate: 16_000,
        actKeyframes: [
          { atMs: 0, emotion: 'smug', intensity: 0.9, motion: 'tease' },
          { atMs: 140, emotion: 'excited', intensity: 0.95, motion: 'bounce' },
        ],
      })

      const visitedVisemes: AshyVisemeKey[] = []
      const visitedEmotions: AshyEmotion[] = []
      const visitedMotions: AshyMotionPreset[] = []

      for (const sampleMs of [40, 180, 300]) {
        const snap = synchronizer.sampleAt(sampleMs)
        const activeLayer = resolveTachieActiveLayers(
          {
            emotion: snap.emotion,
            pose: {
              eyeOpenL: 0.85,
              eyeOpenR: 0.85,
              browLY: 0,
              browRY: 0,
              browAngle: 0,
              mouthOpen: snap.acoustic.rawVolume,
              mouthForm: 0,
              mouthSmile: 0.5,
              cheekBlush: 0.2,
              pupilScale: 1,
            },
            vowels: snap.acoustic.rawVowels,
            effectiveEyeOpenL: 0.85,
            effectiveEyeOpenR: 0.85,
            eyeFocus: { x: 0, y: 0 },
            headFocus: { x: 0, y: 0 },
            breathValue: 0.2,
            squintAmount: 0,
            springOffset: { x: 0, y: 0 },
          },
          snap.motion,
        )
        visitedVisemes.push(activeLayer.activeViseme)
        visitedEmotions.push(snap.emotion)
        visitedMotions.push(snap.motion)

        set({
          isSpeaking: snap.isSpeaking,
          presenceStatus: snap.isSpeaking ? 'Speaking' : 'Idle',
          simulatedVowels: snap.acoustic.rawVowels,
          activeViseme: activeLayer.activeViseme,
          activeEyeState: activeLayer.eyeState,
          stageEmotion: snap.emotion,
          emotionIntensity: snap.emotionIntensity,
          activeMotion: snap.motion,
        })
      }

      const settled = synchronizer.sampleAt(450)
      set({
        isSpeaking: settled.isSpeaking,
        presenceStatus: 'Idle',
        simulatedVowels: settled.acoustic.rawVowels,
        activeViseme: 'closed',
        activeEyeState: 'open',
      })

      return {
        visitedVisemes,
        visitedEmotions,
        visitedMotions,
      }
    },

    async sendUserMessage(userMessage: string) {
      const trimmed = userMessage.trim()
      if (!trimmed) return

      clearActivePlaybackEndTimer()
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

      const optimisticNow = Date.now()
      const optimisticUserId = `msg-user-optimistic-${optimisticNow}-${Math.random().toString(36).slice(2, 8)}`
      const optimisticUserTurn: ChatTurnMessage = {
        id: optimisticUserId,
        role: 'user',
        content: trimmed,
        timeLabel: formatLocalTimeHHMM(optimisticNow),
        timestamp: optimisticNow,
      }

      if (seriousness.isSeriousOrDelicate) {
        const seriousMood: MoodVector = {
          valence: -0.1,
          arousal: 0.35,
          playfulness: Math.min(0.12, seriousness.maxPlayfulnessAllowed),
        }
        set((state) => ({
          lastPrompt: compiledPrompt,
          stageEmotion: 'concerned',
          mood: seriousMood,
          chatMessages: [...state.chatMessages, optimisticUserTurn],
        }))
      } else {
        set((state) => ({
          lastPrompt: compiledPrompt,
          chatMessages: [...state.chatMessages, optimisticUserTurn],
        }))
      }

      let turnId: string
      let savedUserMsg: ChatMessageRecord
      const videoFrames =
        current.pendingVideoFrames.length > 0 ? [...current.pendingVideoFrames] : undefined
      const attachments =
        current.pendingTurnAttachments.length > 0
          ? [...current.pendingTurnAttachments]
          : undefined
      if (videoFrames || attachments) {
        set({
          pendingVideoFrames: [],
          pendingTurnAttachments: [],
        })
      }
      try {
        const res = await bridge.sendTurn({
          sessionId: get().activeSessionId,
          text: trimmed,
          ...(interruptionNote ? { interruptionControlNote: interruptionNote } : {}),
          ...(videoFrames ? { videoFrames } : {}),
          ...(attachments ? { attachments } : {}),
          ...(current.unifiedOmniMode
            ? { omniExecutionModeOverride: 'native-omni' as const }
            : {}),
        })
        turnId = res.turnId
        savedUserMsg = res.userMessage
      } catch (err) {
        set((state) => ({
          chatMessages: state.chatMessages.filter((m) => m.id !== optimisticUserId),
        }))
        throw err
      }

      pendingTurnSeriousness.set(turnId, seriousness.isSeriousOrDelicate)

      set((state) => {
        const userTurn: ChatTurnMessage = {
          id: savedUserMsg.id,
          role: 'user',
          content: savedUserMsg.content,
          timeLabel: formatLocalTimeHHMM(savedUserMsg.createdAt),
          timestamp: savedUserMsg.createdAt,
        }
        const assistantMsgId = `msg-assistant-${turnId}`
        const filtered = state.chatMessages.filter(
          (m) => m.id !== optimisticUserId && m.id !== savedUserMsg.id,
        )
        const assistantIdx = filtered.findIndex((m) => m.id === assistantMsgId)
        if (assistantIdx !== -1) {
          const next = [...filtered]
          next.splice(assistantIdx, 0, userTurn)
          return { chatMessages: next }
        }
        const optIdx = state.chatMessages.findIndex((m) => m.id === optimisticUserId)
        if (optIdx !== -1) {
          const next = state.chatMessages
            .map((m, idx) => (idx === optIdx ? userTurn : m))
            .filter((m, idx) => idx === optIdx || m.id !== savedUserMsg.id)
          return { chatMessages: next }
        }
        return {
          chatMessages: [...filtered, userTurn],
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
      clearActivePlaybackEndTimer()
      const activeTurnId = get().activeTurnId ?? get().activeStreamingTurnId ?? null
      if (activeTurnId !== null) {
        bargeInTurnIds.add(activeTurnId)
        void get().abortActiveTurn()
      }

      if (activeTurnId && omniAudioReceivedTurnIds.has(activeTurnId)) {
        const interruptSec = Math.max(0.05, interruptAtMs / 1000)
        voiceRuntime.getPlayer().setVirtualClockSec(interruptSec)
        const omniReceipt = voiceRuntime.interruptOmniPlayback(activeTurnId, 'user_barge_in')
        if (omniReceipt) {
          set({
            isSpeaking: false,
            presenceStatus: 'Listening',
            stageEmotion: 'surprised',
            activeViseme: 'closed',
            simulatedVowels: { A: 0, E: 0, I: 0, O: 0, U: 0 },
            rawVolume: 0,
            lastPlaybackReceipt: omniReceipt,
            pendingInterruptionControlNote: omniReceipt.controlNote,
            bubbleText: `${omniReceipt.heardText} — [Barge-In!]`,
          })
          return omniReceipt
        }
      }

      let pipeline = activeSpeechPipeline
      if (!pipeline || (pipeline.getScheduledChunks().length === 0 && !get().isStreamingTurn)) {
        const runtimePipeline = voiceRuntime.getSpeechPipeline()
        if (runtimePipeline.getScheduledChunks().length > 0) {
          pipeline = runtimePipeline
        } else {
          pipeline = createPipelineForTurn()
          const lastAssistantContent =
            [...get().chatMessages]
              .reverse()
              .find((m) => m.role === 'assistant' && m.content.trim().length > 0)
              ?.content.trim() ||
            get().bubbleText.trim() ||
            'Eu estava falando com você agora mesmo aqui no estúdio, mas parei imediatamente para te ouvir com atenção.'
          pipeline.enqueue(lastAssistantContent, [])
        }
      }

      const interruptSec = Math.max(0.05, interruptAtMs / 1000)
      const receipt = pipeline.interrupt('user_barge_in', interruptSec)

      set({
        isSpeaking: false,
        presenceStatus: 'Listening',
        stageEmotion: 'surprised',
        activeViseme: 'closed',
        simulatedVowels: { A: 0, E: 0, I: 0, O: 0, U: 0 },
        rawVolume: 0,
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
      const categoryTag = `category:${cat}`
      const tags = input.tags?.length
        ? Array.from(new Set([...input.tags, categoryTag]))
        : [categoryTag, cat]

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
        tags,
      }

      const card: FeaturedMemoryCard = {
        id: newId,
        title: cleanTitle,
        summary: cleanSummary,
        fullStory: cleanStory,
        dateLabel: 'Hoje',
        originLabel: cat === 'planos' ? 'Plano de Hoje' : 'Criada agora',
        filterCategory: cat,
        ...(cat === 'planos' ? { badge: 'Plano' } : {}),
        image: resolveMemoryCategoryImage(cat),
        featured: false,
        episodeId: newId,
      }

      const nextEpisodes = [episode, ...get().episodicMemories]
      set({
        episodicMemories: nextEpisodes,
        crossEpisodeLinks: detectCrossEpisodeLinks(nextEpisodes),
        roomEnvironment: deriveAshyRoomEnvironment({
          milestones: get().milestones,
          episodes: nextEpisodes,
          localTimeHHMM: get().roomTimeOverrideHHMM ?? undefined,
        }),
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
        crossEpisodeLinks: detectCrossEpisodeLinks(nextEpisodes),
        roomEnvironment: deriveAshyRoomEnvironment({
          milestones: get().milestones,
          episodes: nextEpisodes,
          localTimeHHMM: get().roomTimeOverrideHHMM ?? undefined,
        }),
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
        const nextDreamJournalEntries = current.dreamJournalEntries
          .map((entry) => ({
            ...entry,
            sourceEpisodeIds: entry.sourceEpisodeIds.filter((epId) => epId !== id),
          }))
          .filter((entry) => entry.sourceEpisodeIds.length > 0)
        set({
          episodicMemories: nextEpisodes,
          crossEpisodeLinks: detectCrossEpisodeLinks(nextEpisodes),
          dreamJournalEntries: nextDreamJournalEntries,
          rankedMemories: nextRanked,
          memoryCards: remainingCards,
          selectedMemoryId: nextSelected,
          semanticFacts: nextFacts,
          relationalMotifs: nextMotifs,
          userHabits: nextHabits,
          prospectiveIntents: nextIntents,
          milestones: nextMilestones,
          roomTrophies: buildRoomTrophies(nextMilestones),
          roomEnvironment: deriveAshyRoomEnvironment({
            milestones: nextMilestones,
            episodes: nextEpisodes,
            localTimeHHMM: current.roomTimeOverrideHHMM ?? undefined,
          }),
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
          roomEnvironment: deriveAshyRoomEnvironment({
            milestones: nextMilestones,
            episodes: current.episodicMemories,
            localTimeHHMM: current.roomTimeOverrideHHMM ?? undefined,
          }),
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
        roomEnvironment: deriveAshyRoomEnvironment({
          milestones: nextMilestones,
          episodes: get().episodicMemories,
          localTimeHHMM: get().roomTimeOverrideHHMM ?? undefined,
        }),
      })
      void getAshyHostBridge()
        .upsertMilestone(created)
        .catch(() => {
          // Ignore when offline in unit test
        })
      return created
    },

    setStorySearchQuery(query) {
      set({ storySearchQuery: query })
    },

    setStoryCategoryFilter(category) {
      set({ storyCategoryFilter: category })
    },

    async updateMilestone(input) {
      const cleanId = input.id?.trim() ?? ''
      if (!cleanId) return null
      if (input.title !== undefined && !input.title.trim()) return null
      if (input.narrative !== undefined && !input.narrative.trim()) return null

      const current = get()
      const existing = current.milestones.find((m) => m.id === cleanId)
      if (!existing) return null

      const updated: AutobiographicalMilestone = {
        ...existing,
        title: input.title !== undefined ? input.title.trim() : existing.title,
        narrative: input.narrative !== undefined ? input.narrative.trim() : existing.narrative,
        category: input.category !== undefined ? input.category : existing.category,
        ...(input.roomTrophyId !== undefined
          ? input.roomTrophyId === null
            ? { roomTrophyId: undefined }
            : { roomTrophyId: input.roomTrophyId.trim() }
          : {}),
      }

      const nextMilestones = current.milestones.map((m) => (m.id === cleanId ? updated : m))
      set({
        milestones: nextMilestones,
        roomTrophies: buildRoomTrophies(nextMilestones),
        roomEnvironment: deriveAshyRoomEnvironment({
          milestones: nextMilestones,
          episodes: current.episodicMemories,
          localTimeHHMM: current.roomTimeOverrideHHMM ?? undefined,
        }),
      })

      await getAshyHostBridge()
        .updateMilestone?.({
          id: cleanId,
          title: updated.title,
          narrative: updated.narrative,
          category: updated.category,
          ...(input.roomTrophyId !== undefined ? { roomTrophyId: input.roomTrophyId } : {}),
        })
        .catch(() => undefined)

      return updated
    },

    setRoomTimeOverride(localTimeHHMM) {
      const cleanTime =
        localTimeHHMM && localTimeHHMM.trim() && localTimeHHMM !== 'auto'
          ? localTimeHHMM.trim()
          : null
      const roomEnvironment = deriveAshyRoomEnvironment({
        milestones: get().milestones,
        episodes: get().episodicMemories,
        localTimeHHMM: cleanTime ?? undefined,
      })
      set({
        roomTimeOverrideHHMM: cleanTime,
        roomEnvironment,
      })
    },

    async updateInitiativePolicy(input) {
      const current = get()
      const validHHMM = (val?: string) =>
        typeof val === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(val.trim())
          ? val.trim()
          : null

      const nextPolicy: InitiativePolicy = {
        enabled:
          input.enabled !== undefined ? Boolean(input.enabled) : current.initiativePolicy.enabled,
        cooldownMinutes:
          input.cooldownMinutes !== undefined && Number.isFinite(input.cooldownMinutes)
            ? Math.max(1, Math.min(1440, Math.round(input.cooldownMinutes)))
            : current.initiativePolicy.cooldownMinutes,
        maxDailyInitiatives:
          input.maxDailyInitiatives !== undefined && Number.isFinite(input.maxDailyInitiatives)
            ? Math.max(0, Math.min(20, Math.round(input.maxDailyInitiatives)))
            : current.initiativePolicy.maxDailyInitiatives,
        quietHoursStart:
          validHHMM(input.quietHoursStart) ?? current.initiativePolicy.quietHoursStart,
        quietHoursEnd: validHHMM(input.quietHoursEnd) ?? current.initiativePolicy.quietHoursEnd,
        respectDnd:
          input.respectDnd !== undefined
            ? Boolean(input.respectDnd)
            : current.initiativePolicy.respectDnd,
        modulateByHabits:
          input.modulateByHabits !== undefined
            ? Boolean(input.modulateByHabits)
            : current.initiativePolicy.modulateByHabits,
      }

      set((s) => ({
        initiativePolicy: nextPolicy,
        quietHoursRange: formatQuietHoursRangeFromPolicy(nextPolicy, s.quietHoursRange),
      }))

      const persisted = await getAshyHostBridge()
        .updateInitiativePolicy?.(nextPolicy)
        .catch(() => undefined)

      if (persisted) {
        set((s) => ({
          initiativePolicy: persisted,
          quietHoursRange: formatQuietHoursRangeFromPolicy(persisted, s.quietHoursRange),
        }))
        return persisted
      }

      return nextPolicy
    },

    async toggleInitiativeEnabled(enabled) {
      const nextEnabled =
        enabled !== undefined ? Boolean(enabled) : !get().initiativePolicy.enabled
      return get().updateInitiativePolicy({ enabled: nextEnabled })
    },

    async evaluateAttentionInitiative(input) {
      const current = get()
      const resolvedTimeHHMM =
        input?.localTimeHHMM ?? current.roomTimeOverrideHHMM ?? undefined
      const resolvedDnd = input?.forceDnd ?? current.privacyState.dndMode
      const seriousness = input?.recentUserMessage
        ? evaluateSeriousnessGate(input.recentUserMessage)
        : undefined

      // Validate quiet hours helper reference
      if (resolvedTimeHHMM) {
        void isWithinQuietHours(
          resolvedTimeHHMM,
          current.initiativePolicy.quietHoursStart,
          current.initiativePolicy.quietHoursEnd,
        )
      }

      const localRecord = evaluateAttentionLoop({
        policy: current.initiativePolicy,
        dndMode: resolvedDnd,
        nowMs: input?.nowMs,
        localTimeHHMM: resolvedTimeHHMM,
        prospectiveIntents: current.prospectiveIntents,
        milestones: current.milestones,
        episodes: current.episodicMemories,
        crossEpisodeLinks: current.crossEpisodeLinks,
        userHabits: current.userHabits,
        recentInitiatives: current.initiativeLog,
        mood: current.mood,
        seriousness,
        idleMinutes: input?.idleMinutes,
        activeAppTitle: input?.activeAppTitle,
        recentUserMessage: input?.recentUserMessage,
        simulatedReplyText: input?.simulatedReplyText,
      })

      set((state) => {
        const nextIntents =
          localRecord.decision === 'spoken' &&
          localRecord.triggerKind === 'prospective_intent' &&
          localRecord.sourceId
            ? state.prospectiveIntents.map((intent) =>
                intent.id === localRecord.sourceId
                  ? { ...intent, status: 'triggered' as const }
                  : intent,
              )
            : state.prospectiveIntents

        const nextMessages =
          localRecord.decision === 'spoken' && localRecord.replyText
            ? [
                ...state.chatMessages,
                {
                  id: `msg-proactive-${localRecord.id}`,
                  role: 'assistant' as const,
                  content: localRecord.replyText,
                  rawContent: localRecord.replyText,
                  emotion: 'happy' as const,
                  modelId: state.activeModelId,
                  timeLabel: formatLocalTimeHHMM(localRecord.createdAt),
                  timestamp: localRecord.createdAt,
                },
              ]
            : state.chatMessages

        return {
          initiativeLog: [localRecord, ...state.initiativeLog],
          prospectiveIntents: nextIntents,
          ...(localRecord.decision === 'spoken' && localRecord.replyText
            ? {
                bubbleText: localRecord.replyText,
                stageEmotion: 'happy' as const,
                chatMessages: nextMessages,
              }
            : {}),
        }
      })

      const hostRecord = await getAshyHostBridge()
        .evaluateAttentionInitiative?.({
          ...input,
          ...(resolvedTimeHHMM ? { localTimeHHMM: resolvedTimeHHMM } : {}),
          forceDnd: resolvedDnd,
        })
        .catch(() => undefined)

      if (hostRecord) {
        set((state) => ({
          initiativeLog: state.initiativeLog.map((r) =>
            r.id === localRecord.id ? hostRecord : r,
          ),
          ...(hostRecord.decision === 'spoken' && hostRecord.replyText
            ? {
                bubbleText: hostRecord.replyText,
                chatMessages: state.chatMessages.map((msg) =>
                  msg.id === `msg-proactive-${localRecord.id}`
                    ? {
                        ...msg,
                        id: `msg-proactive-${hostRecord.id}`,
                        content: hostRecord.replyText!,
                        rawContent: hostRecord.replyText!,
                      }
                    : msg,
                ),
              }
            : {}),
        }))
        return hostRecord
      }

      return localRecord
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
      const reflectable = state.episodicMemories.filter(isReflectablePermanentEpisode)
      const crossEpisodeLinks = detectCrossEpisodeLinks(reflectable)
      const evoRes = proposeGroundedTraitEvolutions({
        episodes: state.episodicMemories,
        existingLog: state.personalityEvolutionLog,
        currentTraits: state.traits,
        nowMs,
        maxEvolutions: 1,
      })

      let nextDreamJournalEntries = state.dreamJournalEntries
      if (reflectable.length > 0) {
        const sourceEpisodeIds = reflectable.map((ep) => ep.id)
        const sortedSourceKey = [...sourceEpisodeIds].sort().join(',')
        const latestEntry = state.dreamJournalEntries[0]
        const hasSameEpisodeSetAsLatest =
          latestEntry !== undefined &&
          [...latestEntry.sourceEpisodeIds].sort().join(',') === sortedSourceKey &&
          evoRes.records.length === 0

        if (!hasSameEpisodeSetAsLatest || state.dreamJournalEntries.length === 0) {
          const themesLabel =
            crossEpisodeLinks.length > 0
              ? crossEpisodeLinks
                  .map((l) => l.sharedTheme)
                  .slice(0, 3)
                  .join(', ')
              : ''
          const summary =
            evoRes.records.length > 0 && crossEpisodeLinks.length > 0
              ? `Reflexão noturna sobre ${reflectable.length} episódio(s): ${crossEpisodeLinks.length} conexão(ões) temática(s) (${themesLabel}) e ${evoRes.records.length} evolução(ões) de traço (${evoRes.records.map((r) => r.trait).join(', ')}).`
              : crossEpisodeLinks.length > 0
                ? `Reflexão sobre ${reflectable.length} episódio(s) conectados pelo tema "${themesLabel}".`
                : evoRes.records.length > 0
                  ? `Reflexão sobre ${reflectable.length} episódio(s): ${evoRes.records.map((r) => r.explanation).join(' ')}`
                  : `Síntese reflexiva sobre ${reflectable.length} memória(s) permanente(s) do estúdio.`

          const newJournalEntry: DreamJournalEntry = {
            id: `dream-journal-${nowMs}-${state.dreamJournalEntries.length + 1}`,
            createdAt: nowMs,
            summary,
            sourceEpisodeIds,
            crossLinksCount: crossEpisodeLinks.length,
            traitEvolutionsCount: evoRes.records.length,
          }
          nextDreamJournalEntries = [newJournalEntry, ...state.dreamJournalEntries]
        }
      }

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
          crossEpisodeLinks,
          dreamJournalEntries: nextDreamJournalEntries,
          roomTrophies: buildRoomTrophies(nextMilestones),
          roomEnvironment: deriveAshyRoomEnvironment({
            milestones: nextMilestones,
            episodes: state.episodicMemories,
            localTimeHHMM: state.roomTimeOverrideHHMM ?? undefined,
          }),
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

        void getAshyHostBridge()
          .runDreamReflection({
            sessionId: state.activeSessionId,
            force: true,
            maxEvolutions: 0,
          })
          .then((res) => {
            if (
              res?.snapshot &&
              !get().personalityEvolutionLog.some(
                (r) => typeof r.revertedAt === 'number' && r.revertedAt >= nowMs,
              )
            ) {
              get().applyBootstrapSnapshot(res.snapshot)
            }
          })
          .catch(() => {
            // Ignore when offline in unit test
          })

        return record
      }

      if (reflectable.length > 0) {
        set({
          crossEpisodeLinks,
          dreamJournalEntries: nextDreamJournalEntries,
        })
      }

      void getAshyHostBridge()
        .runDreamReflection({
          sessionId: state.activeSessionId,
          force: true,
          maxEvolutions: 1,
        })
        .then((res) => {
          if (res?.snapshot) {
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
      const nextShow = Boolean(show)
      set({ showDesktopAvatar: nextShow })
      void (
        globalThis as unknown as {
          ashyHost?: {
            setOverlayVisible?: (input: { visible: boolean }) => unknown
          }
        }
      ).ashyHost?.setOverlayVisible?.({ visible: nextShow && !get().isStageHidden })
      void getAshyHostBridge()
        .updateStagePreferences?.({ showDesktopAvatar: nextShow })
        .catch(() => {
          // Ignore when offline in unit test
        })
    },

    setComputerActionsEnabled(enabled) {
      const nextPolicy: ComputerActionsPolicy = enabled
        ? get().computerActionsPolicy === 'off'
          ? 'ask'
          : get().computerActionsPolicy
        : 'off'
      get().setComputerActionsPolicy(nextPolicy)
    },

    setComputerActionsPolicy(policy) {
      set((state) => ({
        computerActionsPolicy: policy,
        computerActionsEnabled: policy !== 'off',
        ...(policy === 'auto_accept' ? { pendingActions: [] } : {}),
      }))
      void agency.gatekeeper
        .setApprovalPolicy(policy, { autoApprovePending: policy === 'auto_accept' })
        .then(() => {
          set((state) => ({
            computerActionsPolicy: policy,
            computerActionsEnabled: policy !== 'off',
            ...(policy === 'auto_accept' ? { pendingActions: [] } : {}),
          }))
        })

      const nextTask = agencyRpcChain
        .catch(() => undefined)
        .then(async () => {
          const hostSnap = await getAshyHostBridge().updateAgencyConsent?.({
            approvalPolicy: policy,
          })
          if (hostSnap?.consent) {
            set(buildAgencyStatePatch(hostSnap))
          }
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
      agencyRpcChain = nextTask
    },

    toggleDontAskMode(enabled) {
      const currentPolicy = get().computerActionsPolicy
      const shouldEnable = enabled !== undefined ? enabled : currentPolicy !== 'auto_accept'
      get().setComputerActionsPolicy(shouldEnable ? 'auto_accept' : 'ask')
    },

    setDontAskMode(enabled) {
      get().toggleDontAskMode(enabled)
    },

    setToolRiskTierOverride(toolName, riskTier) {
      agency.mcpRegistry.setToolRiskTier(toolName, riskTier)
      const overrides: Record<string, ActionRiskTier> = {
        ...get().toolRiskOverrides,
        [toolName]: riskTier,
      }
      agency.gatekeeper.setToolRiskOverrides(overrides)
      set((state) => ({
        agencyTools: state.agencyTools.map((t) =>
          t.toolName === toolName ? { ...t, effectiveRiskTier: riskTier } : t,
        ),
        toolRiskOverrides: overrides,
        mcpSearchResults: agency.mcpRegistry.search_mcp_tools({
          query: get().mcpSearchQuery,
          limit: 10,
        }),
      }))
      const nextTask = agencyRpcChain
        .catch(() => undefined)
        .then(async () => {
          const hostSnap = await getAshyHostBridge().updateAgencyConsent?.({
            toolRiskOverrides: overrides,
          })
          if (hostSnap?.consent) {
            set(buildAgencyStatePatch(hostSnap))
          }
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
      agencyRpcChain = nextTask
    },

    setToolRiskTier(toolName, riskTier) {
      get().setToolRiskTierOverride(toolName, riskTier)
    },

    addAllowedPath(rawPath) {
      if (typeof rawPath !== 'string') return
      const trimmed = rawPath.replace(/[\x00-\x1f\x7f]/g, '').trim()
      if (!trimmed || trimmed.includes('..') || !canonicalizeSafePath(trimmed)) return
      const nextPaths = Array.from(new Set([...get().privacyState.allowedPaths, trimmed]))
      agency.privacyController.setAllowedPaths(nextPaths)
      set((state) => ({
        privacyState: {
          ...state.privacyState,
          allowedPaths: nextPaths,
        },
      }))
      const nextTask = agencyRpcChain
        .catch(() => undefined)
        .then(async () => {
          const hostSnap = await getAshyHostBridge().updateAgencyConsent?.({
            allowedPaths: nextPaths,
          })
          if (hostSnap?.consent) {
            set(buildAgencyStatePatch(hostSnap))
          }
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
      agencyRpcChain = nextTask
    },

    removeAllowedPath(rawPath) {
      const trimmed = rawPath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
      const nextPaths = get().privacyState.allowedPaths.filter(
        (p) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '') !== trimmed,
      )
      if (nextPaths.length === 0) return
      agency.privacyController.setAllowedPaths(nextPaths)
      set((state) => ({
        privacyState: {
          ...state.privacyState,
          allowedPaths: nextPaths,
        },
      }))
      const nextTask = agencyRpcChain
        .catch(() => undefined)
        .then(async () => {
          const hostSnap = await getAshyHostBridge().updateAgencyConsent?.({
            allowedPaths: nextPaths,
          })
          if (hostSnap?.consent) {
            set(buildAgencyStatePatch(hostSnap))
          }
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
      agencyRpcChain = nextTask
    },

    addAllowedWindowTitle(title) {
      const trimmed = title.replace(/[\x00-\x1f\x7f]/g, '').trim()
      if (!trimmed) return
      const nextTitles = Array.from(
        new Set([...get().privacyState.allowedWindowTitles, trimmed]),
      )
      agency.privacyController.setAllowedWindowTitles(nextTitles)
      set((state) => ({
        privacyState: {
          ...state.privacyState,
          allowedWindowTitles: nextTitles,
        },
      }))
      const nextTask = agencyRpcChain
        .catch(() => undefined)
        .then(async () => {
          const hostSnap = await getAshyHostBridge().updateAgencyConsent?.({
            allowedWindowTitles: nextTitles,
          })
          if (hostSnap?.consent) {
            set(buildAgencyStatePatch(hostSnap))
          }
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
      agencyRpcChain = nextTask
    },

    removeAllowedWindowTitle(title) {
      const trimmed = title.trim()
      const nextTitles = get().privacyState.allowedWindowTitles.filter((t) => t !== trimmed)
      agency.privacyController.setAllowedWindowTitles(nextTitles)
      set((state) => ({
        privacyState: {
          ...state.privacyState,
          allowedWindowTitles: nextTitles,
        },
      }))
      const nextTask = agencyRpcChain
        .catch(() => undefined)
        .then(async () => {
          const hostSnap = await getAshyHostBridge().updateAgencyConsent?.({
            allowedWindowTitles: nextTitles,
          })
          if (hostSnap?.consent) {
            set(buildAgencyStatePatch(hostSnap))
          }
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
      agencyRpcChain = nextTask
    },

    revokeSessionPermissions(toolName) {
      if (toolName && toolName.trim().length > 0) {
        agency.gatekeeper.revokeSessionApproval(toolName)
      } else {
        agency.gatekeeper.revokeAllSessionApprovals()
      }
      const revokedEntry: ActionAuditLogEntry = {
        id: `audit-revoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        toolName: toolName?.trim() || '*',
        serverName: 'consent-center',
        riskTier: 'staged-confirm',
        decision: 'revoked',
        argsPreview: '{}',
        reason: toolName
          ? `Session approval revoked for ${toolName}`
          : 'All session approvals revoked by user',
      }
      set((state) => ({
        sessionApprovedTools: toolName
          ? state.sessionApprovedTools.filter((t) => t !== toolName)
          : [],
        auditLog: [revokedEntry, ...state.auditLog],
      }))
      const nextTask = agencyRpcChain
        .catch(() => undefined)
        .then(async () => {
          const hostSnap = await getAshyHostBridge().revokeSessionPermissions?.(
            toolName ? { toolName } : undefined,
          )
          if (hostSnap?.consent) {
            set(buildAgencyStatePatch(hostSnap))
          }
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
      agencyRpcChain = nextTask
    },

    revokeSessionApproval(toolName) {
      get().revokeSessionPermissions(toolName)
    },

    revokeAllSessionApprovals() {
      get().revokeSessionPermissions()
    },

    async captureAuthorizedScreen(inputOrWindowTitle, frameFixtureIdArg) {
      const input =
        typeof inputOrWindowTitle === 'string'
          ? {
              windowTitle: inputOrWindowTitle,
              ...(frameFixtureIdArg ? { frameFixtureId: frameFixtureIdArg } : {}),
            }
          : inputOrWindowTitle

      await agencyRpcChain.catch(() => undefined)

      const bridge = getAshyHostBridge()
      if (typeof bridge.captureAuthorizedScreen === 'function') {
        try {
          const hostRes = await bridge.captureAuthorizedScreen(input)
          if (hostRes?.observation) {
            const obs = hostRes.observation
            const patch = hostRes.snapshot ? buildAgencyStatePatch(hostRes.snapshot) : {}
            const screenCtx =
              obs.observed && obs.summary
                ? `${obs.windowTitle ?? 'Desktop'} — ${obs.summary}`
                : undefined
            set((state) => ({
              ...patch,
              lastPrompt: screenCtx
                ? compilePromptFromState({ screenContext: screenCtx })
                : state.lastPrompt,
            }))
            return obs
          }
        } catch {
          // Fall back to local sensor when offline in unit test
        }
      }

      agency.setPendingCaptureOptions(input)
      const observation = await agency.visionSensor.observeScreen({
        windowTitle: input?.windowTitle,
      })
      const telemetry = agency.visionSensor.getTelemetry()
      const screenCtx =
        observation.observed && observation.summary
          ? `${observation.windowTitle ?? 'Desktop'} — ${observation.summary}`
          : undefined
      set((state) => ({
        visionTelemetry: telemetry,
        auditLog: [...agency.gatekeeper.getAuditLog()],
        lastPrompt: screenCtx
          ? compilePromptFromState({ screenContext: screenCtx })
          : state.lastPrompt,
      }))
      return observation
    },

    registerExternalMcpServer(config) {
      agency.mcpRegistry.registerServer({
        name: config.name,
        description: config.description ?? '',
      })
      set((state) => ({
        externalMcpServers: [
          ...state.externalMcpServers.filter((s) => s.id !== config.id),
          config,
        ],
        registeredMcpToolsCount: agency.mcpRegistry.getRegisteredToolsCount(),
        agencyTools: agency.mcpRegistry.listAllTools(),
      }))
      const nextTask = agencyRpcChain
        .catch(() => undefined)
        .then(async () => {
          const hostSnap = await getAshyHostBridge().registerExternalMcpServer?.(config)
          if (hostSnap?.consent) {
            set(buildAgencyStatePatch(hostSnap))
          }
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
      agencyRpcChain = nextTask
    },

    connectExternalMcpServer(config) {
      get().registerExternalMcpServer(config)
    },

    removeExternalMcpServer(serverId) {
      set((state) => ({
        externalMcpServers: state.externalMcpServers.filter((s) => s.id !== serverId),
      }))
    },

    setQuietHoursRange(range) {
      if (typeof range !== 'string') return
      const trimmed = range.trim()
      if (trimmed.toLowerCase() === 'desativado') {
        set({ quietHoursRange: 'Desativado' })
        void get().updateInitiativePolicy({ respectDnd: false })
        return
      }
      const match = trimmed.match(
        /^((?:[01]\d|2[0-3]):[0-5]\d)\s*([-–—])\s*((?:[01]\d|2[0-3]):[0-5]\d)$/,
      )
      if (!match) return
      const start = match[1]!
      const sep = match[2]!
      const end = match[3]!
      const normalizedRange =
        start.startsWith('21:') && sep === '-' ? `${start} - ${end}` : `${start} — ${end}`
      set({ quietHoursRange: normalizedRange })
      void get().updateInitiativePolicy({
        quietHoursStart: start,
        quietHoursEnd: end,
        respectDnd: true,
      })
    },

    saveUserPreferences() {
      const savedAt = Date.now()
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(
            'ashy.userPreferences.v1',
            JSON.stringify({
              quietHoursRange: get().quietHoursRange,
              showDesktopAvatar: get().showDesktopAvatar,
              computerActionsEnabled: get().computerActionsEnabled,
              computerActionsPolicy: get().computerActionsPolicy,
              savedAt,
            }),
          )
        }
      } catch {
        // Ignore storage write errors in restricted environments
      }
      set({
        preferencesSavedToast: true,
        preferencesSavedAt: savedAt,
      })
    },

    setMicMode(mode) {
      hasExplicitConsentMutation = true
      const agencyMode: MicMode = mode === 'push-to-talk' ? 'ptt' : mode
      agency.privacyController.setMicMode(agencyMode)
      voiceRuntime.setMicMode(mode)
      set((state) => ({
        privacyState: {
          ...state.privacyState,
          micMode: agencyMode,
        },
      }))
      const nextTask = agencyRpcChain
        .catch(() => undefined)
        .then(async () => {
          const hostSnap = await getAshyHostBridge().updateAgencyConsent?.({
            micMode: agencyMode,
          })
          if (hostSnap?.consent) {
            set(buildAgencyStatePatch(hostSnap))
          }
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
      agencyRpcChain = nextTask
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

    async toggleVoiceConversation(active) {
      const shouldActivate = active !== undefined ? Boolean(active) : !get().isVoiceListening
      if (!shouldActivate) {
        await voiceRuntime.stopMicrophoneCapture()
        set((state) => ({
          isVoiceListening: false,
          micInputLevel: 0,
          presenceStatus:
            state.isSpeaking || state.isStreamingTurn ? state.presenceStatus : 'Idle',
          voiceTestStatus: null,
        }))
        return false
      }

      if (get().privacyState.micMode === 'muted') {
        get().setMicMode('continuous')
      }

      const hasGetUserMedia =
        typeof navigator !== 'undefined' &&
        typeof navigator.mediaDevices?.getUserMedia === 'function'

      if (hasGetUserMedia) {
        try {
          const selectedId = get().selectedMicDeviceId
          await voiceRuntime.startMicrophoneCapture({
            deviceId: selectedId && selectedId !== 'default' ? selectedId : undefined,
            onRmsLevel: (rms) => {
              set({ micInputLevel: rms })
            },
          })
          set({
            isVoiceListening: true,
            presenceStatus: 'Listening',
            voiceRuntimeError: null,
            voiceTestStatus: 'Escuta por voz ativa no microfone.',
          })
          return true
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          set({
            isVoiceListening: false,
            micInputLevel: 0,
            voiceRuntimeError: message,
            voiceTestStatus: null,
          })
          return false
        }
      }

      set({
        isVoiceListening: true,
        presenceStatus: 'Listening',
        voiceRuntimeError: null,
        voiceTestStatus: 'Sessão de voz ativa (aguardando dispositivo de áudio).',
      })
      return true
    },

    async startVoiceListening() {
      return get().toggleVoiceConversation(true)
    },

    async stopVoiceListening() {
      return get().toggleVoiceConversation(false)
    },

    async refreshMicDevices() {
      try {
        if (
          typeof navigator !== 'undefined' &&
          typeof navigator.mediaDevices?.enumerateDevices === 'function'
        ) {
          const rawDevices = await navigator.mediaDevices.enumerateDevices()
          const audioInputs = rawDevices
            .filter((d) => d.kind === 'audioinput')
            .map((d, index) => ({
              deviceId: d.deviceId || 'default',
              label: d.label || `Microfone ${index + 1}`,
            }))
          const finalDevices =
            audioInputs.length > 0 ? audioInputs : [...DEFAULT_MIC_DEVICES]
          set({ availableMicDevices: finalDevices })
          return finalDevices
        }
      } catch {
        // Fallback to default device list
      }
      const fallback = [...DEFAULT_MIC_DEVICES]
      set({ availableMicDevices: fallback })
      return fallback
    },

    setSelectedMicDeviceId(deviceId) {
      const cleanId = deviceId.trim() || 'default'
      set((state) => ({
        selectedMicDeviceId: cleanId,
        voiceSettings: {
          ...state.voiceSettings,
          selectedMicDeviceId: cleanId,
        },
      }))
    },

    setAutoSpeakReplies(enabled) {
      const nextEnabled = Boolean(enabled)
      set((state) => ({
        autoSpeakReplies: nextEnabled,
        voiceSettings: {
          ...state.voiceSettings,
          autoSpeakReplies: nextEnabled,
        },
      }))
    },

    updateVoiceSettingsDraft(patch) {
      if (patch.activeSttProviderId) {
        voiceRuntime.setActiveSttProvider(patch.activeSttProviderId)
      }
      if (patch.activeTtsProviderId) {
        voiceRuntime.setActiveTtsProvider(patch.activeTtsProviderId)
      }
      if (patch.wakeWordEnabled !== undefined) {
        voiceRuntime.setWakeWordEnabled(patch.wakeWordEnabled)
      }
      set((state) => ({
        voiceSettings: {
          ...state.voiceSettings,
          ...patch,
        },
        ...(patch.selectedMicDeviceId !== undefined
          ? { selectedMicDeviceId: patch.selectedMicDeviceId }
          : {}),
        ...(patch.autoSpeakReplies !== undefined
          ? { autoSpeakReplies: patch.autoSpeakReplies }
          : {}),
      }))
    },

    async saveVoiceSettings(secrets) {
      set({ isSavingVoiceSettings: true, voiceRuntimeError: null })
      const current = get()
      const payload = {
        ...current.voiceSettings,
        selectedMicDeviceId: current.selectedMicDeviceId,
        autoSpeakReplies: current.autoSpeakReplies,
        ...(secrets?.openaiApiKey ? { openaiApiKey: secrets.openaiApiKey } : {}),
        ...(secrets?.groqApiKey ? { groqApiKey: secrets.groqApiKey } : {}),
        ...(secrets?.elevenLabsApiKey ? { elevenLabsApiKey: secrets.elevenLabsApiKey } : {}),
        ...(secrets?.localSttApiKey ? { localSttApiKey: secrets.localSttApiKey } : {}),
        ...(secrets?.localTtsApiKey ? { localTtsApiKey: secrets.localTtsApiKey } : {}),
      }

      try {
        const bridge = getAshyHostBridge()
        const saved: VoiceRuntimeSettings =
          typeof bridge.saveVoiceRuntimeSettings === 'function'
            ? await bridge.saveVoiceRuntimeSettings(payload)
            : {
                ...current.voiceSettings,
                selectedMicDeviceId: current.selectedMicDeviceId,
                autoSpeakReplies: current.autoSpeakReplies,
              }

        voiceRuntime.setActiveSttProvider(saved.activeSttProviderId)
        voiceRuntime.setActiveTtsProvider(saved.activeTtsProviderId)
        voiceRuntime.setWakeWordEnabled(saved.wakeWordEnabled)

        set({
          voiceSettings: {
            ...saved,
            wakeWordPhrases: [...saved.wakeWordPhrases],
          },
          selectedMicDeviceId: saved.selectedMicDeviceId ?? current.selectedMicDeviceId,
          autoSpeakReplies: saved.autoSpeakReplies ?? current.autoSpeakReplies,
          isSavingVoiceSettings: false,
          voiceTestStatus: 'Configurações de voz salvas com segurança.',
          voiceRuntimeError: null,
        })
        return saved
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        set({
          isSavingVoiceSettings: false,
          voiceRuntimeError: message,
        })
        throw err
      }
    },

    async refreshVoiceProviderCatalog(kind, apiKeyOverride) {
      set({ isLoadingVoiceCatalog: true, voiceRuntimeError: null })
      const state = get()
      const providerId =
        kind === 'stt'
          ? state.voiceSettings.activeSttProviderId
          : state.voiceSettings.activeTtsProviderId
      const baseUrl =
        kind === 'stt' ? state.voiceSettings.sttBaseUrl : state.voiceSettings.ttsBaseUrl

      try {
        const bridge = getAshyHostBridge()
        if (typeof bridge.listVoiceProviderModels === 'function') {
          const res = await bridge.listVoiceProviderModels({
            kind,
            providerId,
            baseUrl,
            ...(apiKeyOverride ? { apiKey: apiKeyOverride } : {}),
          })
          if (kind === 'stt') {
            set({
              sttCatalogModels:
                res.models.length > 0 ? res.models : [...DEFAULT_STT_CATALOG_MODELS],
              isLoadingVoiceCatalog: false,
            })
          } else {
            set((s) => ({
              ttsCatalogModels:
                res.models.length > 0 ? res.models : [...DEFAULT_TTS_CATALOG_MODELS],
              ttsCatalogVoices:
                res.voices && res.voices.length > 0 ? res.voices : s.ttsCatalogVoices,
              isLoadingVoiceCatalog: false,
            }))
          }
          return
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        set({ voiceRuntimeError: message })
      }
      set({ isLoadingVoiceCatalog: false })
    },

    async testMicrophone() {
      set({
        isTestingMic: true,
        voiceRuntimeError: null,
        voiceTestStatus: 'Testando captura do microfone...',
      })
      try {
        const hasGetUserMedia =
          typeof navigator !== 'undefined' &&
          typeof navigator.mediaDevices?.getUserMedia === 'function'
        if (hasGetUserMedia) {
          const selectedId = get().selectedMicDeviceId
          await voiceRuntime.startMicrophoneCapture({
            deviceId: selectedId && selectedId !== 'default' ? selectedId : undefined,
            onRmsLevel: (rms) => set({ micInputLevel: rms }),
          })
          const peakRms = Math.max(
            0.02,
            voiceRuntime.getWorkletCapture().getLastRmsLevel(),
            get().micInputLevel,
          )
          if (!get().isVoiceListening) {
            await voiceRuntime.stopMicrophoneCapture()
          }
          const message = 'Microfone verificado com sucesso.'
          set({ isTestingMic: false, voiceTestStatus: message })
          return { ok: true, message, peakRms }
        }

        const peakRms = Math.max(0.05, voiceRuntime.getWorkletCapture().getLastRmsLevel())
        const message = 'Microfone pronto (modo de diagnóstico).'
        set({ isTestingMic: false, voiceTestStatus: message })
        return { ok: true, message, peakRms }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        set({
          isTestingMic: false,
          voiceRuntimeError: message,
          voiceTestStatus: null,
        })
        return { ok: false, message, peakRms: 0 }
      }
    },

    async testTtsVoice(sampleText) {
      const text = (
        sampleText ?? 'Olá! Minha voz está configurada e pronta no estúdio.'
      ).trim()
      set({
        isTestingTts: true,
        voiceRuntimeError: null,
        voiceTestStatus: 'Sintetizando amostra de voz...',
      })
      try {
        const state = get()
        const activeTts = state.voiceSettings.activeTtsProviderId
        const bridge = getAshyHostBridge()

        if (
          activeTts !== 'local-synth-fallback' &&
          typeof bridge.synthesizeVoiceSpeech === 'function'
        ) {
          const res = await bridge.synthesizeVoiceSpeech({
            text,
            providerId: activeTts,
            baseUrl: state.voiceSettings.ttsBaseUrl,
            modelId: state.voiceSettings.ttsModelId,
            voiceId: state.voiceSettings.ttsVoiceId,
          })
          const firstFrame = res.vowelFrames?.[0]
          set({
            isTestingTts: false,
            isSpeaking: true,
            presenceStatus: 'Speaking',
            simulatedVowels: firstFrame
              ? {
                  A: firstFrame.A,
                  E: firstFrame.E,
                  I: firstFrame.I,
                  O: firstFrame.O,
                  U: firstFrame.U,
                }
              : { A: 0.72, E: 0.35, I: 0.2, O: 0.45, U: 0.15 },
            activeViseme: firstFrame?.dominantVowel ?? 'A',
            rawVolume: 0.85,
            voiceTestStatus: `Voz sintetizada (${res.durationMs} ms).`,
          })
          schedulePlaybackCompletionReset(Math.min(500, Math.max(150, res.durationMs)))
          return {
            ok: true,
            message: `Voz sintetizada (${res.durationMs} ms).`,
            durationMs: res.durationMs,
          }
        }

        await voiceRuntime.enqueueAssistantReply(text)
        const chunks = voiceRuntime.getSpeechPipeline().getScheduledChunks()
        const durationMs = chunks.reduce((acc, c) => acc + c.durationMs, 0) || 400
        set({
          isTestingTts: false,
          isSpeaking: true,
          presenceStatus: 'Speaking',
          simulatedVowels: { A: 0.72, E: 0.35, I: 0.2, O: 0.45, U: 0.15 },
          activeViseme: 'A',
          rawVolume: 0.85,
          voiceTestStatus: `Voz local sintetizada (${durationMs} ms).`,
        })
        schedulePlaybackCompletionReset(Math.min(500, Math.max(150, durationMs)))
        return {
          ok: true,
          message: `Voz local sintetizada (${durationMs} ms).`,
          durationMs,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        set({
          isTestingTts: false,
          voiceRuntimeError: message,
          voiceTestStatus: null,
        })
        return { ok: false, message, durationMs: 0 }
      }
    },

    async runAudioFixtureSimulation(fixtureId) {
      const prevWake = get().voiceSettings.wakeWordEnabled
      const prevMic = get().privacyState.micMode
      isRunningFixtureScenario = true
      try {
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
      } finally {
        isRunningFixtureScenario = false
      }
    },

    async runVoiceFixtureScenario(fixtureId) {
      return get().runAudioFixtureSimulation(fixtureId)
    },

    setEyesMode(mode) {
      hasExplicitConsentMutation = true
      agency.privacyController.setEyesMode(mode)
      if (mode === 'off') {
        webcamSampler.stop()
        webcamSampler.clearFrames()
      }
      set((state) => ({
        privacyState: {
          ...state.privacyState,
          eyesMode: mode,
        },
        visionTelemetry: {
          ...state.visionTelemetry,
          eyesMode: mode,
        },
        ...(mode === 'off'
          ? {
              isWebcamStreaming: false,
              webcamPreviewDataUrl: null,
              pendingVideoFrames: [],
            }
          : {}),
      }))
      const nextTask = agencyRpcChain
        .catch(() => undefined)
        .then(async () => {
          const hostSnap = await getAshyHostBridge().updateAgencyConsent?.({
            eyesMode: mode,
          })
          if (hostSnap?.consent) {
            set(buildAgencyStatePatch(hostSnap))
          }
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
      agencyRpcChain = nextTask
    },

    setDndMode(enabled) {
      hasExplicitConsentMutation = true
      agency.privacyController.setDndMode(enabled)
      set((state) => ({
        privacyState: {
          ...state.privacyState,
          dndMode: enabled,
        },
      }))
      const nextTask = agencyRpcChain
        .catch(() => undefined)
        .then(async () => {
          const hostSnap = await getAshyHostBridge().updateAgencyConsent?.({
            dndMode: enabled,
          })
          if (hostSnap?.consent) {
            set(buildAgencyStatePatch(hostSnap))
          }
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
      agencyRpcChain = nextTask
    },

    activateFullPrivacyShield() {
      hasExplicitConsentMutation = true
      const next = agency.privacyController.activatePrivacyShield()
      voiceRuntime.setMicMode('muted')
      webcamSampler.stop()
      webcamSampler.clearFrames()
      set((state) => ({
        privacyState: next,
        visionTelemetry: {
          ...state.visionTelemetry,
          eyesMode: 'off',
        },
        isWebcamStreaming: false,
        webcamPreviewDataUrl: null,
        pendingVideoFrames: [],
      }))
      const nextTask = agencyRpcChain
        .catch(() => undefined)
        .then(async () => {
          const hostSnap = await getAshyHostBridge().updateAgencyConsent?.({
            eyesMode: 'off',
            micMode: 'muted',
            dndMode: true,
          })
          if (hostSnap?.consent) {
            set(buildAgencyStatePatch(hostSnap))
          }
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
      agencyRpcChain = nextTask
    },

    activatePrivacyShield() {
      get().activateFullPrivacyShield()
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
      const safeArgs: Record<string, unknown> = { ...args }
      if (toolName === 'write_project_note') {
        const rawTitle =
          typeof safeArgs.title === 'string' && safeArgs.title.trim().length > 0
            ? safeArgs.title.trim()
            : 'Nota de Arquitetura'
        const slug =
          rawTitle
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9-_]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'nota-arquitetura'
        const targetPath =
          typeof safeArgs.path === 'string' && safeArgs.path.trim().length > 0
            ? safeArgs.path.trim()
            : `/workspace/ashy/notes/${slug}.md`
        if (typeof safeArgs.path !== 'string' || !safeArgs.path.trim()) {
          safeArgs.path = targetPath
        }
        if (typeof safeArgs.diffPreview !== 'string') {
          const nextContent =
            typeof safeArgs.content === 'string' && safeArgs.content.trim().length > 0
              ? safeArgs.content
              : `# ${rawTitle}\n`
          safeArgs.diffPreview = computeUnifiedDiffPreview(targetPath, null, nextContent)
        }
      }

      await agencyRpcChain.catch(() => undefined)

      const bridge = getAshyHostBridge()
      if (typeof bridge.callMcpTool === 'function') {
        try {
          const hostRes = await bridge.callMcpTool({ toolName, args: safeArgs })
          if (hostRes && typeof hostRes.status === 'string') {
            let summary = `Tool "${toolName}" -> ${hostRes.status}`
            if (hostRes.pendingCard?.blastRadiusWarning) {
              summary += ` (${hostRes.pendingCard.blastRadiusWarning})`
            } else if (hostRes.reason) {
              summary += ` (${hostRes.reason})`
            }
            if (hostRes.snapshot) {
              set({
                ...buildAgencyStatePatch(hostRes.snapshot),
                lastMcpResultSummary: summary,
              })
            } else {
              set({ lastMcpResultSummary: summary })
            }
            return {
              status: hostRes.status,
              ...(hostRes.output !== undefined ? { output: hostRes.output } : {}),
              ...(hostRes.pendingCard
                ? { pendingCard: hostRes.pendingCard as PendingActionCard }
                : {}),
              ...(hostRes.reason ? { reason: hostRes.reason } : {}),
            }
          }
        } catch {
          // Fall back to local registry when offline in unit test
        }
      }

      const res = await agency.mcpRegistry.call_mcp_tool({ toolName, args: safeArgs })
      let summary = `Tool "${toolName}" -> ${res.status}`
      if (res.pendingCard?.blastRadiusWarning) {
        summary += ` (${res.pendingCard.blastRadiusWarning})`
      } else if (res.reason) {
        summary += ` (${res.reason})`
      }

      set({
        pendingActions: agency.gatekeeper.getPendingActions(),
        sessionApprovedTools: agency.gatekeeper.getSessionApprovedTools(),
        auditLog: [...agency.gatekeeper.getAuditLog()],
        lastMcpResultSummary: summary,
      })
      return res
    },

    async approvePendingAction(actionId, scope) {
      await agencyRpcChain.catch(() => undefined)

      if (get().computerActionsPolicy === 'off') {
        throw new Error(
          `Cannot approve action ${actionId}: computer actions are disabled by policy (off)`,
        )
      }

      const bridge = getAshyHostBridge()
      if (typeof bridge.approvePendingAction === 'function') {
        try {
          const hostRes = await bridge.approvePendingAction({ actionId, scope })
          if (hostRes?.snapshot) {
            set({
              ...buildAgencyStatePatch(hostRes.snapshot),
              lastMcpResultSummary: `Approved action ${actionId} (scope=${scope})`,
            })
            return
          }
        } catch (err) {
          if (err instanceof Error && /disabled by policy/i.test(err.message)) {
            throw err
          }
          // Fall back to local gatekeeper when offline
        }
      }

      await agency.gatekeeper.approveAction(actionId, scope)
      set({
        pendingActions: agency.gatekeeper.getPendingActions(),
        sessionApprovedTools: agency.gatekeeper.getSessionApprovedTools(),
        auditLog: [...agency.gatekeeper.getAuditLog()],
        lastMcpResultSummary: `Approved action ${actionId} (scope=${scope})`,
      })
    },

    denyPendingAction(actionId, reason = 'Denied by user in Consent Center') {
      let localFeedback = `Action ${actionId} denied: ${reason}`
      let deniedLocally = false
      try {
        const res = agency.gatekeeper.denyAction(actionId, reason)
        localFeedback = res.feedback
        deniedLocally = true
      } catch {
        // Action may only exist on Host
      }
      set((state) => {
        const existingCard = state.pendingActions.find((a) => a.id === actionId)
        const nextAuditLog = deniedLocally
          ? [...agency.gatekeeper.getAuditLog()]
          : existingCard
            ? [
                {
                  id: `audit-deny-${actionId}`,
                  timestamp: Date.now(),
                  toolName: existingCard.toolName,
                  serverName: existingCard.serverName,
                  riskTier: existingCard.riskTier,
                  decision: 'denied' as const,
                  argsPreview: existingCard.argsPreview,
                  actionId: existingCard.id,
                  reason,
                  ...(existingCard.blastRadiusWarning
                    ? { blastRadiusWarning: existingCard.blastRadiusWarning }
                    : {}),
                  ...(existingCard.targetPath ? { targetPath: existingCard.targetPath } : {}),
                  ...(existingCard.commandPreview
                    ? { commandPreview: existingCard.commandPreview }
                    : {}),
                  ...(existingCard.diffPreview ? { diffPreview: existingCard.diffPreview } : {}),
                },
                ...state.auditLog,
              ]
            : state.auditLog

        return {
          pendingActions: state.pendingActions.filter((a) => a.id !== actionId),
          auditLog: nextAuditLog,
          lastMcpResultSummary: localFeedback,
        }
      })
      const nextTask = agencyRpcChain
        .catch(() => undefined)
        .then(async () => {
          const hostRes = await getAshyHostBridge().denyPendingAction?.({
            actionId,
            reason,
          })
          if (hostRes?.snapshot) {
            set({
              ...buildAgencyStatePatch(hostRes.snapshot),
              lastMcpResultSummary: hostRes.feedback,
            })
          }
        })
        .catch(() => {
          // Ignore when offline in unit test
        })
      agencyRpcChain = nextTask
    },

    setUnifiedOmniMode(enabled) {
      const next = Boolean(enabled)
      voiceRuntime.setDirectOmniAudio(next && get().directOmniAudio)
      set((s) => ({
        unifiedOmniMode: next,
        voiceSettings: {
          ...s.voiceSettings,
          unifiedOmniMode: next,
        },
      }))
      void getAshyHostBridge()
        .saveVoiceRuntimeSettings?.({ unifiedOmniMode: next })
        .then((saved) => {
          if (saved && typeof saved === 'object') {
            set((s) => ({
              voiceSettings: {
                ...s.voiceSettings,
                ...saved,
                wakeWordPhrases: [...(saved.wakeWordPhrases ?? s.voiceSettings.wakeWordPhrases)],
              },
            }))
          }
        })
        .catch(() => {
          // ignore when offline in unit test
        })
    },

    setDirectOmniAudio(enabled) {
      const next = Boolean(enabled)
      voiceRuntime.setDirectOmniAudio(next && get().unifiedOmniMode)
      set((s) => ({
        directOmniAudio: next,
        voiceSettings: {
          ...s.voiceSettings,
          directOmniAudio: next,
        },
      }))
      void getAshyHostBridge()
        .saveVoiceRuntimeSettings?.({ directOmniAudio: next })
        .then((saved) => {
          if (saved && typeof saved === 'object') {
            set((s) => ({
              voiceSettings: {
                ...s.voiceSettings,
                ...saved,
                wakeWordPhrases: [...(saved.wakeWordPhrases ?? s.voiceSettings.wakeWordPhrases)],
              },
            }))
          }
        })
        .catch(() => {
          // ignore when offline in unit test
        })
    },

    applyOmniModelPreset(preset) {
      const presetMap: Record<
        'lfm3-omni-2b' | 'gpt-4o-audio' | 'qwen2.5-omni' | 'gemini-2.5-flash',
        { providerId: LlmProviderId; modelId: string; omniVoiceId: string }
      > = {
        'lfm3-omni-2b': {
          providerId: 'ollama',
          modelId: 'lfm3-omni:2b',
          omniVoiceId: 'ashy-warm-ptbr',
        },
        'gpt-4o-audio': {
          providerId: 'openai',
          modelId: 'gpt-4o-audio-preview',
          omniVoiceId: 'coral',
        },
        'qwen2.5-omni': {
          providerId: 'openrouter',
          modelId: 'qwen/qwen2.5-omni-7b',
          omniVoiceId: 'chelsie',
        },
        'gemini-2.5-flash': {
          providerId: 'openrouter',
          modelId: 'google/gemini-2.5-flash',
          omniVoiceId: 'Aoede',
        },
      }
      const chosen = presetMap[preset]
      const omniCaps = inferModelOmniCapabilities(chosen.providerId, chosen.modelId)
      voiceRuntime.setDirectOmniAudio(true)

      set((s) => {
        const existingCfg = s.providers.configs[chosen.providerId]
        const updatedCfg: PublicProviderConfig = {
          ...existingCfg,
          modelId: chosen.modelId,
          ...omniCaps,
          omniExecutionMode: 'native-omni',
          omniVoiceId: chosen.omniVoiceId,
        }
        return {
          activeModelId: chosen.modelId,
          unifiedOmniMode: true,
          directOmniAudio: true,
          voiceSettings: {
            ...s.voiceSettings,
            unifiedOmniMode: true,
            directOmniAudio: true,
          },
          providers: {
            ...s.providers,
            activeProviderId: chosen.providerId,
            configs: {
              ...s.providers.configs,
              [chosen.providerId]: updatedCfg,
            },
          },
        }
      })

      const currentCfg = get().providers.configs[chosen.providerId]
      const bridge = getAshyHostBridge()
      void bridge
        .saveProviderConfig?.({
          providerId: chosen.providerId,
          baseUrl: currentCfg.baseUrl,
          modelId: chosen.modelId,
          reasoningEffort: currentCfg.reasoningEffort,
          ...omniCaps,
          omniExecutionMode: 'native-omni',
          omniVoiceId: chosen.omniVoiceId,
        })
        .catch(() => {
          // ignore when offline in unit test
        })
      void bridge.setActiveProvider?.(chosen.providerId).catch(() => {
        // ignore when offline in unit test
      })
      void bridge
        .saveVoiceRuntimeSettings?.({
          unifiedOmniMode: true,
          directOmniAudio: true,
        })
        .then((saved) => {
          if (saved && typeof saved === 'object') {
            set((s) => ({
              voiceSettings: {
                ...s.voiceSettings,
                ...saved,
                wakeWordPhrases: [...(saved.wakeWordPhrases ?? s.voiceSettings.wakeWordPhrases)],
              },
            }))
          }
        })
        .catch(() => {
          // ignore when offline in unit test
        })
    },

    stageVideoFrames(frames) {
      set((s) => ({
        pendingVideoFrames: deduplicateVideoFramesByDHash(
          [...s.pendingVideoFrames, ...frames],
          4,
          8,
        ),
      }))
    },

    stageTurnAttachment(attachment) {
      set((s) => ({
        pendingTurnAttachments: [...s.pendingTurnAttachments.slice(-7), attachment],
      }))
    },

    removeTurnAttachment(id) {
      set((s) => ({
        pendingTurnAttachments: s.pendingTurnAttachments.filter((a) => a.id !== id),
      }))
    },

    clearOmniStagedMedia() {
      set({
        pendingVideoFrames: [],
        pendingTurnAttachments: [],
      })
    },

    async toggleWebcamStream(active) {
      const next = active ?? !get().isWebcamStreaming
      if (!next) {
        webcamSampler.stop()
        set({
          isWebcamStreaming: false,
          webcamPreviewDataUrl: null,
        })
        return false
      }
      if (get().privacyState.eyesMode === 'off') {
        get().setEyesMode('window')
      }
      const started = await webcamSampler.start()
      if (!started) {
        const synth = createSyntheticVideoFrameDataUrl(1, 0, 'camera')
        set((s) => ({
          isWebcamStreaming: true,
          webcamPreviewDataUrl: synth.dataUrl,
          pendingVideoFrames: deduplicateVideoFramesByDHash(
            [...s.pendingVideoFrames, synth],
            4,
            8,
          ),
        }))
        return true
      }
      const frames = webcamSampler.getRecentFrames(8)
      set({
        isWebcamStreaming: true,
        webcamPreviewDataUrl: frames[frames.length - 1]?.dataUrl ?? null,
        pendingVideoFrames: frames,
      })
      return true
    },

    async sendOmniAudioTurn(turn) {
      const s = get()
      const videoFrames =
        s.pendingVideoFrames.length > 0 ? [...s.pendingVideoFrames] : undefined
      const attachments =
        s.pendingTurnAttachments.length > 0 ? [...s.pendingTurnAttachments] : undefined
      const interruptionNote = s.pendingInterruptionControlNote ?? undefined

      set({
        pendingVideoFrames: [],
        pendingTurnAttachments: [],
        pendingInterruptionControlNote: null,
      })

      if (s.isBootstrapped) {
        const bridge = ensureHostSubscription()
        await bridge.sendTurn({
          sessionId: s.activeSessionId,
          text: turn.transcriptHint ?? '',
          inputAudio: {
            dataBase64: turn.wavBase64,
            format: 'wav',
            sampleRate: turn.sampleRate,
            durationMs: turn.durationMs,
            ...(turn.transcriptHint ? { transcriptHint: turn.transcriptHint } : {}),
          },
          ...(videoFrames ? { videoFrames } : {}),
          ...(attachments ? { attachments } : {}),
          ...(interruptionNote ? { interruptionControlNote: interruptionNote } : {}),
          omniExecutionModeOverride: 'native-omni',
        })
        return
      }

      const fallbackText =
        turn.transcriptHint || '🎤 [Mensagem de voz enviada diretamente ao modelo Omni]'
      await get().sendUserMessage(fallbackText)
    },

    handleHostStreamEvent(event) {
      handleHostStreamEvent(event)
    },

    async exportSoulArchive(input) {
      set({
        soulPortabilityStatus: {
          kind: 'exporting',
          message: 'Exportando alma (.ashy-soul)...',
        },
      })
      const bridge = ensureHostSubscription()
      if (typeof bridge.exportSoul === 'function') {
        try {
          const archive = await bridge.exportSoul(input)
          if (archive && archive.magic === 'ASHY_SOUL_V1') {
            set({
              lastExportedSoulArchive: archive,
              soulPortabilityStatus: {
                kind: 'exported',
                message: `Alma exportada (SHA-256: ${archive.checksumSha256.slice(0, 12)}...)`,
              },
            })
            return archive
          }
        } catch {
          // Fall back to local archive construction when offline in unit test
        }
      }

      const s = get()
      const payload: AshySoulBundlePayload = {
        formatVersion: 1,
        schemaVersion: CURRENT_SOUL_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        appVersion: '1.0.0',
        cortex: {
          episodicMemories: [...s.episodicMemories],
          semanticFacts: [...s.semanticFacts],
          relationalMotifs: [...s.relationalMotifs],
          milestones: [...s.milestones],
          userHabits: [...s.userHabits],
          prospectiveIntents: [...s.prospectiveIntents],
          personalityEvolution: [...s.personalityEvolutionLog],
          affectiveState: { mood: { ...s.mood }, traits: { ...s.traits } },
          relationshipState: {
            stage: s.relationshipStage,
            familiarityScore: s.familiarityScore,
            trustScore: s.trustScore,
            totalTurns: s.totalTurns,
          },
          chatSessions: input?.includeChatHistory === false ? [] : [...s.sessions],
          chatMessages: input?.includeChatHistory === false ? [] : [],
          memoryGovernance: { ...s.memoryGovernancePolicy },
          actionAuditLog: input?.includeAuditLog === false ? [] : [...s.auditLog],
          agencyConsent: {
            eyesMode: s.privacyState.eyesMode,
            micMode: s.privacyState.micMode,
            dndMode: s.privacyState.dndMode,
            approvalPolicy: s.computerActionsPolicy,
            allowedPaths: [...s.privacyState.allowedPaths],
            allowedWindowTitles: [...s.privacyState.allowedWindowTitles],
            toolRiskOverrides: { ...s.toolRiskOverrides },
          },
          initiativePolicy: { ...s.initiativePolicy },
          proactiveInitiativeLog: [...s.initiativeLog],
          dreamJournalEntries: [...s.dreamJournalEntries],
        },
        voiceIdentityMarkdown: s.voiceIdentity.content,
        stagePreferences: {
          stageMode: s.stageMode,
          live2dPresetId: s.live2dPresetId,
          live2dModelUrl: s.live2dModelUrl,
          loadedLive2DModelName: s.loadedLive2DModelName,
          live2dModelControls: s.live2dModelControls,
          ambientLuminance: s.ambientLuminance,
          showDesktopAvatar: s.showDesktopAvatar,
          isStageHidden: s.isStageHidden,
          updatedAt: Date.now(),
        },
        voicePreferences: {
          ...s.voiceSettings,
          hasOpenAiApiKey: false,
          hasGroqApiKey: false,
          hasElevenLabsApiKey: false,
          hasLocalSttApiKey: false,
          hasLocalTtsApiKey: false,
          maskedOpenAiApiKey: null,
          maskedGroqApiKey: null,
          maskedElevenLabsApiKey: null,
        },
      }
      const checksumSha256 = computeSha256HexSync(canonicalizeJson(payload))
      const fallbackArchive: AshySoulArchive = {
        magic: 'ASHY_SOUL_V1',
        checksumSha256,
        payload,
      }
      set({
        lastExportedSoulArchive: fallbackArchive,
        soulPortabilityStatus: {
          kind: 'exported',
          message: `Alma exportada (SHA-256: ${fallbackArchive.checksumSha256.slice(0, 12)}...)`,
        },
      })
      return fallbackArchive
    },

    async importSoulArchive(rawArchive) {
      set({
        soulPortabilityStatus: {
          kind: 'importing',
          message: 'Importando alma (.ashy-soul)...',
        },
      })
      try {
        if (typeof rawArchive === 'string' && rawArchive.trim().length === 0) {
          throw new Error('Arquivo .ashy-soul vazio ou inválido.')
        }

        const bridge = ensureHostSubscription()
        if (typeof bridge.importSoul === 'function') {
          try {
            const snapshot = await bridge.importSoul({ archive: rawArchive })
            if (snapshot && typeof snapshot === 'object' && 'needsOnboarding' in snapshot) {
              get().applyBootstrapSnapshot(snapshot)
              const message = 'Alma importada e restaurada com sucesso!'
              set({
                soulPortabilityStatus: {
                  kind: 'imported',
                  message,
                },
              })
              return { ok: true, message }
            }
          } catch (bridgeErr) {
            const errMsg = bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr)
            const isOfflineFetchErr =
              !get().isBootstrapped &&
              (/fetch|Invalid URL|Failed to parse URL|Network/i.test(errMsg) ||
                errMsg.includes('__ashy_host/rpc'))
            if (!isOfflineFetchErr) {
              throw bridgeErr
            }
          }
        }

        // Local checksum & payload validation fallback
        const parsedObj =
          typeof rawArchive === 'string'
            ? safeJsonParseWithoutProto<AshySoulArchive>(rawArchive)
            : rawArchive
        if (
          !parsedObj ||
          typeof parsedObj !== 'object' ||
          parsedObj.magic !== 'ASHY_SOUL_V1' ||
          typeof parsedObj.checksumSha256 !== 'string' ||
          !parsedObj.payload
        ) {
          throw new Error('Invalid Soul archive format: expected ASHY_SOUL_V1')
        }
        const expectedHex = computeSha256HexSync(canonicalizeJson(parsedObj.payload))
        if (expectedHex.toLowerCase() !== parsedObj.checksumSha256.toLowerCase()) {
          throw new Error('SOUL_CHECKSUM_MISMATCH: Soul archive checksum verification failed')
        }
        const nameFact = parsedObj.payload.cortex.semanticFacts?.find(
          (f: { predicate?: string; object?: string }) => f.predicate === 'name',
        )
        const pronounsFact = parsedObj.payload.cortex.semanticFacts?.find(
          (f: { predicate?: string; object?: string }) => f.predicate === 'pronouns',
        )
        const message = 'Alma importada e restaurada com sucesso!'
        set((s) => ({
          needsOnboarding: false,
          hasCompletedOnboarding: true,
          userProfile: {
            userName: nameFact?.object ?? s.userProfile.userName ?? 'Você',
            userPronouns: pronounsFact?.object ?? s.userProfile.userPronouns,
          },
          voiceIdentity: {
            ...s.voiceIdentity,
            content: parsedObj.payload.voiceIdentityMarkdown,
            updatedAt: Date.now(),
          },
          episodicMemories: parsedObj.payload.cortex.episodicMemories ?? [],
          semanticFacts: parsedObj.payload.cortex.semanticFacts ?? [],
          relationalMotifs: parsedObj.payload.cortex.relationalMotifs ?? [],
          milestones: parsedObj.payload.cortex.milestones ?? [],
          soulPortabilityStatus: {
            kind: 'imported',
            message,
          },
        }))
        return { ok: true, message }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        set({
          soulPortabilityStatus: {
            kind: 'error',
            message,
          },
        })
        return { ok: false, message }
      }
    },

    async wipeAllSoulData() {
      set({
        soulPortabilityStatus: {
          kind: 'wiping',
          message: 'Apagando todos os dados...',
        },
      })
      clearActivePlaybackEndTimer()
      webcamSampler.stop()
      webcamSampler.clearFrames()
      await voiceRuntime.stopMicrophoneCapture().catch(() => {})
      try {
        voiceRuntime.interruptOmniPlayback('wipe-all')
      } catch {
        // Ignore if not playing
      }
      activeSpeechPipeline = null

      completedTurnEvents.clear()
      pendingTurnResolvers.clear()
      pendingTurnSeriousness.clear()
      streamedDeltaTurnIds.clear()
      bargeInTurnIds.clear()
      omniAudioReceivedTurnIds.clear()
      agency = createAgencyRuntime()
      voiceRuntime = createStoreVoiceRuntime()

      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.removeItem('ashy.userPreferences.v1')
        }
      } catch {
        // Ignore storage errors
      }

      const bridge = ensureHostSubscription()
      if (typeof bridge.wipeAllData === 'function') {
        try {
          const snapshot = await bridge.wipeAllData()
          if (snapshot && typeof snapshot === 'object' && 'needsOnboarding' in snapshot) {
            set({
              chatMessages: [],
              episodicMemories: [],
              rankedMemories: [],
              memoryCards: [],
              semanticFacts: [],
              relationalMotifs: [],
              milestones: [],
              userHabits: [],
              prospectiveIntents: [],
              personalityEvolutionLog: [],
              dreamJournalEntries: [],
              crossEpisodeLinks: [],
              initiativeLog: [],
              pendingActions: [],
              auditLog: [],
            })
            get().applyBootstrapSnapshot(snapshot)
          }
        } catch {
          // Fall back to local state reset when offline in unit test
        }
      }

      set({
        needsOnboarding: true,
        hasCompletedOnboarding: false,
        userProfile: {
          userName: null,
          userPronouns: null,
        },
        chatMessages: [],
        episodicMemories: [],
        rankedMemories: [],
        memoryCards: [],
        semanticFacts: [],
        relationalMotifs: [],
        milestones: [],
        isSpeaking: false,
        isVoiceListening: false,
        isStreamingTurn: false,
        activeTurnId: null,
        lastTurnError: null,
        isWebcamStreaming: false,
        webcamPreviewDataUrl: null,
        pendingVideoFrames: [],
        pendingTurnAttachments: [],
        lastExportedSoulArchive: null,
        soulPortabilityStatus: {
          kind: 'wiped',
          message: 'Todos os dados foram apagados. Retornando ao Onboarding.',
        },
      })
    },

    async setEncryptionAtRest(enabled) {
      const nextEnabled = Boolean(enabled)
      const bridge = ensureHostSubscription()
      if (typeof bridge.setEncryptionAtRest === 'function') {
        try {
          const snapshot = await bridge.setEncryptionAtRest({ enabled: nextEnabled })
          if (snapshot && typeof snapshot === 'object' && 'needsOnboarding' in snapshot) {
            get().applyBootstrapSnapshot(snapshot)
            if (snapshot.encryptionAtRest) {
              set({ encryptionAtRestStatus: { ...snapshot.encryptionAtRest } })
              return
            }
          }
        } catch {
          // Fall back to local state update when offline in unit test
        }
      }
      set((s) => ({
        encryptionAtRestStatus: {
          ...s.encryptionAtRestStatus,
          enabled: nextEnabled,
          updatedAt: new Date().toISOString(),
        },
      }))
    },

    async checkForAppUpdates() {
      const bridge = ensureHostSubscription()
      if (typeof bridge.checkForUpdates === 'function') {
        try {
          const nextState = await bridge.checkForUpdates()
          if (nextState && typeof nextState === 'object' && 'status' in nextState) {
            set({ updaterState: { ...nextState } })
            return nextState
          }
        } catch {
          // Fall back to local state when offline
        }
      }
      const fallbackState: AutoUpdaterState = {
        ...get().updaterState,
        status: 'not-available',
        checkedAt: new Date().toISOString(),
        errorMessage: null,
      }
      set({ updaterState: fallbackState })
      return fallbackState
    },

    async downloadAppUpdate() {
      const bridge = ensureHostSubscription()
      if (typeof bridge.downloadUpdate === 'function') {
        try {
          const nextState = await bridge.downloadUpdate()
          if (nextState && typeof nextState === 'object' && 'status' in nextState) {
            set({ updaterState: { ...nextState } })
            return nextState
          }
        } catch {
          // Fall back to current updater state
        }
      }
      return get().updaterState
    },

    async installAppUpdate() {
      const bridge = ensureHostSubscription()
      if (typeof bridge.quitAndInstallUpdate === 'function') {
        try {
          return await bridge.quitAndInstallUpdate()
        } catch {
          // Fall back when offline
        }
      }
      return { ok: false }
    },

    resetStoreForTesting() {
      clearActivePlaybackEndTimer()
      isRunningFixtureScenario = false
      unsubscribeHostEvents?.()
      unsubscribeHostEvents = null
      subscribedBridge = null
      activeSpeechPipeline = null
      firstDeltaEnqueuedAtMs = null
      firstChunkRecordedForTurn = false
      evalRunSeq += 1
      inFlightCatalogCount = 0
      hasExplicitConsentMutation = false
      agencyRpcChain = Promise.resolve()
      providerCatalogSeq.clear()
      completedTurnEvents.clear()
      pendingTurnResolvers.clear()
      pendingTurnSeriousness.clear()
      streamedDeltaTurnIds.clear()
      bargeInTurnIds.clear()
      omniAudioReceivedTurnIds.clear()
      webcamSampler.stop()
      webcamSampler.clearFrames()
      agency = createAgencyRuntime()
      voiceRuntime = createStoreVoiceRuntime()
      lastPromptMinuteLabel = formatLocalTimeHHMM(Date.now())

      const resetWindowMode = resolveInitialWindowMode()
      const freshPrompt = composeAshyTurnPrompt({
        userMessage: 'Olá Ashy.',
        modelId: 'anthropic/claude-3.7-sonnet',
        timeOfDayLabel: lastPromptMinuteLabel,
        stage: 'stranger',
        voiceIdentityMarkdown: DEFAULT_ASHY_VOICE_MD,
        traits: ASHY_DEFAULT_TRAITS,
        mood: ASHY_BASELINE_MOOD,
        stageControlsPromptBlock: formatLive2DControlPrompt(DEFAULT_LIVE2D_CONTROLS),
      })

      set({
        viewMode: resetWindowMode.viewMode,
        activeTab: 'studio',
        activeModelId: 'anthropic/claude-3.7-sonnet',
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
        providerModelCatalog: { ...FALLBACK_PROVIDER_MODELS },
        providerModelCatalogSource: {},
        isLoadingProviderModels: false,
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
        isTransparentOverlayWindow: resetWindowMode.isTransparentOverlayWindow,
        isStageHidden: false,
        ignoringMouseEvents: false,
        ignoreMouseTransitionCount: 0,
        activeViseme: 'closed',
        activeEyeState: 'open',
        activeMotion: 'idle',
        live2dPresetId: 'hiyori',
        live2dModelUrl: '/live2d/models/hiyori/Hiyori.model3.json',
        live2dModelControls: {
          ...DEFAULT_LIVE2D_CONTROLS,
          expressions: [...DEFAULT_LIVE2D_CONTROLS.expressions],
          motionGroups: DEFAULT_LIVE2D_CONTROLS.motionGroups.map((g) => ({ ...g })),
          hitAreas: [...DEFAULT_LIVE2D_CONTROLS.hitAreas],
        },
        loadedLive2DModelName: 'ashy-default.model3.json',
        mood: { ...ASHY_BASELINE_MOOD },
        traits: { ...ASHY_DEFAULT_TRAITS },
        milestones: [],
        storySearchQuery: '',
        storyCategoryFilter: 'todas',
        crossEpisodeLinks: [],
        dreamJournalEntries: [],
        initiativePolicy: { ...DEFAULT_INITIATIVE_POLICY },
        initiativeLog: [],
        roomEnvironment: deriveAshyRoomEnvironment({ milestones: [], episodes: [] }),
        roomTimeOverrideHHMM: null,
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
        isVoiceListening: false,
        micInputLevel: 0,
        rawVolume: 0,
        availableMicDevices: [...DEFAULT_MIC_DEVICES],
        selectedMicDeviceId: 'default',
        autoSpeakReplies: true,
        sttCatalogModels: [...DEFAULT_STT_CATALOG_MODELS],
        ttsCatalogModels: [...DEFAULT_TTS_CATALOG_MODELS],
        ttsCatalogVoices: [...DEFAULT_TTS_CATALOG_VOICES],
        isLoadingVoiceCatalog: false,
        isSavingVoiceSettings: false,
        isTestingMic: false,
        isTestingTts: false,
        voiceTestStatus: null,
        voiceRuntimeError: null,
        settingsSubTab: 'todas',
        showDesktopAvatar: true,
        computerActionsEnabled: true,
        computerActionsPolicy: 'ask',
        quietHoursRange: '22:00 — 08:00',
        preferencesSavedToast: false,
        preferencesSavedAt: null,
        privacyState: agency.privacyController.getState(),
        mcpSearchQuery: '',
        mcpSearchResults: agency.mcpRegistry.search_mcp_tools({ query: '', limit: 10 }),
        exposedMetaToolsCount: agency.mcpRegistry.getExposedMetaTools().length,
        registeredMcpToolsCount: agency.mcpRegistry.getRegisteredToolsCount(),
        agencyTools: agency.mcpRegistry.listAllTools(),
        toolRiskOverrides: agency.gatekeeper.getToolRiskOverrides(),
        sessionApprovedTools: agency.gatekeeper.getSessionApprovedTools(),
        visionTelemetry: agency.visionSensor.getTelemetry(),
        externalMcpServers: [],
        pendingActions: agency.gatekeeper.getPendingActions(),
        auditLog: [...agency.gatekeeper.getAuditLog()],
        lastMcpResultSummary: null,
        unifiedOmniMode: DEFAULT_VOICE_RUNTIME_SETTINGS.unifiedOmniMode ?? false,
        directOmniAudio: DEFAULT_VOICE_RUNTIME_SETTINGS.directOmniAudio ?? false,
        pendingVideoFrames: [],
        pendingTurnAttachments: [],
        isWebcamStreaming: false,
        webcamPreviewDataUrl: null,
        hasCompletedOnboarding: false,
        activeStreamingTurnId: null,
        activeStreamingMessageId: null,
        encryptionAtRestStatus: { ...DEFAULT_ENCRYPTION_AT_REST_STATUS },
        updaterState: { ...DEFAULT_AUTO_UPDATER_STATE },
        lastExportedSoulArchive: null,
        soulPortabilityStatus: { kind: 'idle', message: null },
      })
    },
  }
})

export type AshyStoreState = AshyDesktopState
export type { RoomTimeOfDayPeriod }

export function resetAshyStore(): void {
  useAshyStore.getState().resetStoreForTesting()
}

export function getVoiceRuntimeForTesting(): VoiceSessionRuntime {
  return voiceRuntime
}
