import * as v from 'valibot'
import { AshyEmotionSchema, type AshyEmotion } from './emotions'
import { MilestoneCategorySchema } from './memory-types'
import type {
  DreamReflectionCycleResult,
  CrossEpisodeLink,
  MoodVector,
  PersonalityEvolutionRecord,
  PersonalityTraits,
} from './affect-types'
import type {
  AutobiographicalMilestone,
  EpisodicMemory,
  MemoryGovernanceCategory,
  MemoryGovernancePolicy,
  ProspectiveIntent,
  RelationalMotif,
  SemanticFact,
  SemanticFactCategory,
  UserHabit,
} from './memory-types'

export const LLM_PROVIDER_IDS = [
  'openrouter',
  'anthropic',
  'openai',
  'nvidia-nim',
  'ollama',
] as const

export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number]
export const LlmProviderIdSchema = v.picklist(LLM_PROVIDER_IDS)

export const STT_PROVIDER_IDS = [
  'openai-whisper',
  'local-whisper-http',
  'deterministic-wav-stt',
] as const

export type SttProviderId = (typeof STT_PROVIDER_IDS)[number]
export const SttProviderIdSchema = v.picklist(STT_PROVIDER_IDS)

export const TTS_PROVIDER_IDS = [
  'elevenlabs',
  'openai-tts',
  'local-kokoro-http',
  'local-synth-fallback',
] as const

export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number]
export const TtsProviderIdSchema = v.picklist(TTS_PROVIDER_IDS)

export const VOICE_FIXTURE_IDS = [
  'thinking-pause-cas',
  'barge-in-interrupt',
  'wake-word-oi-ashy',
  'keyboard-click-noise',
] as const

export type VoiceFixtureId = (typeof VOICE_FIXTURE_IDS)[number]
export const VoiceFixtureIdSchema = v.picklist(VOICE_FIXTURE_IDS)

export const ASHY_MOTION_PRESETS = [
  'idle',
  'tease',
  'nod',
  'shake',
  'bounce',
  'think',
  'laugh',
  'shrug',
  'sparkle',
] as const
export type AshyMotionPreset = (typeof ASHY_MOTION_PRESETS)[number]
export const AshyMotionPresetSchema = v.picklist(ASHY_MOTION_PRESETS)

export const ASHY_VISEME_KEYS = ['closed', 'A', 'E', 'I', 'O', 'U'] as const
export type AshyVisemeKey = (typeof ASHY_VISEME_KEYS)[number]
export const AshyVisemeKeySchema = v.picklist(ASHY_VISEME_KEYS)

export const ASHY_EYE_LAYER_STATES = ['open', 'half', 'closed', 'wink'] as const
export type AshyEyeLayerState = (typeof ASHY_EYE_LAYER_STATES)[number]
export const AshyEyeLayerStateSchema = v.picklist(ASHY_EYE_LAYER_STATES)

export const STAGE_AVATAR_MODES = ['tachie', 'live2d', 'vrm'] as const
export type StageAvatarMode = (typeof STAGE_AVATAR_MODES)[number]

export const LIVE2D_BUILTIN_MODEL_IDS = ['hiyori', 'haru', 'mao'] as const
export type Live2DBuiltinModelId = (typeof LIVE2D_BUILTIN_MODEL_IDS)[number]

export interface Live2DModelPreset {
  id: Live2DBuiltinModelId
  label: string
  description: string
  modelJsonUrl: string
  cubismVersion: 4
  scale: number
  offsetY: number
}

export const BUILTIN_LIVE2D_MODEL_PRESETS: readonly Live2DModelPreset[] = [
  {
    id: 'hiyori',
    label: 'Hiyori Momose (Cubism 4)',
    description: 'Personagem anime colegial expressiva com física completa de cabelo longo e uniforme.',
    modelJsonUrl: '/live2d/models/hiyori/Hiyori.model3.json',
    cubismVersion: 4,
    scale: 0.24,
    offsetY: 0.08,
  },
  {
    id: 'haru',
    label: 'Haru Greeter (Cubism 4)',
    description: 'Recepcionista anime clássica da Live2D com movimentos suaves de cabeça e expressões ricas.',
    modelJsonUrl: '/live2d/models/haru/Haru.model3.json',
    cubismVersion: 4,
    scale: 0.24,
    offsetY: 0.06,
  },
  {
    id: 'mao',
    label: 'Mao Pro (Cubism 4)',
    description: 'Bruxinha anime vibrante (usada no Open-LLM-VTuber) com chapéu, capa e efeitos mágicos.',
    modelJsonUrl: '/live2d/models/mao/Mao.model3.json',
    cubismVersion: 4,
    scale: 0.2,
    offsetY: 0.1,
  },
] as const

export const PNGTUBER_SPRITE_STATE_KEYS = [
  'eyes_open_mouth_closed',
  'eyes_open_mouth_open',
  'eyes_open_mouth_smile',
  'eyes_closed_mouth_closed',
  'eyes_closed_mouth_open',
  'concerned',
] as const
export type PngTuberSpriteStateKey = (typeof PNGTUBER_SPRITE_STATE_KEYS)[number]

export interface StageShortcutBindings {
  toggleMic: string
  toggleEyes: string
  toggleDnd: string
  toggleHideStage: string
  electronGlobalMic: string
  electronGlobalEyes: string
  electronGlobalDnd: string
  electronGlobalHideStage: string
}

export const DEFAULT_STAGE_SHORTCUTS: Readonly<StageShortcutBindings> = Object.freeze({
  toggleMic: 'Alt+M',
  toggleEyes: 'Alt+E',
  toggleDnd: 'Alt+D',
  toggleHideStage: 'Alt+H',
  electronGlobalMic: 'CommandOrControl+Shift+M',
  electronGlobalEyes: 'CommandOrControl+Shift+E',
  electronGlobalDnd: 'CommandOrControl+Shift+D',
  electronGlobalHideStage: 'CommandOrControl+Shift+H',
})

export interface StageOverlayRuntimeState {
  isOverlayVisible: boolean
  ignoringMouseEvents: boolean
  activeStageMode: 'tachie' | 'live2d'
  loadedLive2DModelName: string
  shortcuts: StageShortcutBindings
}

export const DEFAULT_STAGE_OVERLAY_RUNTIME_STATE: Readonly<StageOverlayRuntimeState> =
  Object.freeze({
    isOverlayVisible: true,
    ignoringMouseEvents: false,
    activeStageMode: 'tachie',
    loadedLive2DModelName: 'ashy-default.model3.json',
    shortcuts: DEFAULT_STAGE_SHORTCUTS,
  })

export const SetStageOverlayIgnoreMouseInputSchema = v.object({
  ignore: v.boolean(),
  forward: v.optional(v.boolean(), true),
})
export type SetStageOverlayIgnoreMouseInput = v.InferOutput<
  typeof SetStageOverlayIgnoreMouseInputSchema
>

export const SetStageOverlayVisibleInputSchema = v.object({
  visible: v.boolean(),
})
export type SetStageOverlayVisibleInput = v.InferOutput<
  typeof SetStageOverlayVisibleInputSchema
>

export interface TtfaTelemetryRecord {
  providerId: TtsProviderId
  lastTtfaMs: number | null
  avgTtfaMs: number | null
  sampleCount: number
  lastSynthesizedAt: number | null
}

export interface VoiceRuntimeSettings {
  activeSttProviderId: SttProviderId
  activeTtsProviderId: TtsProviderId
  sttBaseUrl: string
  sttModelId: string
  ttsBaseUrl: string
  ttsModelId: string
  ttsVoiceId: string
  wakeWordEnabled: boolean
  wakeWordPhrases: string[]
}

export const DEFAULT_VOICE_RUNTIME_SETTINGS: VoiceRuntimeSettings = {
  activeSttProviderId: 'deterministic-wav-stt',
  activeTtsProviderId: 'local-synth-fallback',
  sttBaseUrl: 'http://127.0.0.1:8080',
  sttModelId: 'whisper-1',
  ttsBaseUrl: 'http://127.0.0.1:8880',
  ttsModelId: 'kokoro-v1',
  ttsVoiceId: 'ashy-pt-br',
  wakeWordEnabled: true,
  wakeWordPhrases: ['ashy', 'ei ashy', 'oi ashy'],
}

export const DELETABLE_MEMORY_KINDS = [
  'fact',
  'episode',
  'joke',
  'habit',
  'intent',
  'milestone',
] as const
export type DeletableMemoryKind = (typeof DELETABLE_MEMORY_KINDS)[number]
export const DeletableMemoryKindSchema = v.picklist(DELETABLE_MEMORY_KINDS)

export const APPROVABLE_MEMORY_KINDS = [
  'fact',
  'episode',
  'joke',
  'habit',
  'intent',
] as const
export type ApprovableMemoryKind = (typeof APPROVABLE_MEMORY_KINDS)[number]
export const ApprovableMemoryKindSchema = v.picklist(APPROVABLE_MEMORY_KINDS)

export type RelationshipStage =
  | 'stranger'
  | 'acquaintance'
  | 'close_friend'
  | 'companion'

export type ConfigDiagnosticStatus =
  | 'ok'
  | 'missing'
  | 'invalid'
  | 'healed_from_backup'
  | 'reset_to_default'

export interface ConfigDiagnostics {
  status: ConfigDiagnosticStatus
  message?: string
  healedFrom?: string
  updatedAt: number
}

export interface ChatSessionRecord {
  id: string
  title: string
  startedAt: number
  updatedAt: number
  turnCount: number
  lastMessagePreview: string
}

export interface ChatMessageRecord {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  rawContent: string
  emotion: AshyEmotion
  markersJson: string
  providerId?: LlmProviderId | null
  modelId?: string | null
  latencyMs?: number | null
  consolidatedEpisodeId?: string | null
  createdAt: number
}

export interface PublicProviderConfig {
  providerId: LlmProviderId
  label: string
  baseUrl: string
  modelId: string
  requiresApiKey: boolean
  hasApiKey: boolean
  maskedApiKey: string | null
  lastVerifiedAt: number | null
  lastError: string | null
}

export interface ProviderHealthResult {
  ok: boolean
  providerId: LlmProviderId
  modelId: string
  latencyMs: number
  error?: string
  verifiedAt: number
}

export const M2_GATE_THRESHOLDS = {
  memoryRecallRateMin: 0.85,
  memoryPrecisionRateMin: 0.8,
  callbackAccuracyRateMin: 0.9,
  cooldownComplianceRateMin: 1.0,
  hallucinatedMemoryCountMax: 0,
  provenanceCoverageRateMin: 1.0,
  seriousnessGateComplianceMin: 1.0,
  antiSlopComplianceRateMin: 1.0,
  voiceScoreMin: 0.8,
  crossModelVoiceDriftMax: 0.15,
  seriousnessFalseNegativeCountMax: 0,
  bondSafeguardComplianceRateMin: 1.0,
  traitDriftCorridorComplianceRateMin: 1.0,
  initiativeGroundingRateMin: 1.0,
  unopportuneInitiativeCountMax: 0,
} as const

const UnitIntervalSchema = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(0),
  v.maxValue(1),
)

export const CoreExperimentMetricSummarySchema = v.object({
  memoryRecallRate: UnitIntervalSchema,
  memoryPrecisionRate: UnitIntervalSchema,
  callbackAccuracyRate: UnitIntervalSchema,
  cooldownComplianceRate: UnitIntervalSchema,
  hallucinatedMemoryCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  provenanceCoverageRate: UnitIntervalSchema,
  seriousnessGateCompliance: UnitIntervalSchema,
  antiSlopComplianceRate: UnitIntervalSchema,
  voiceScoreModelA: UnitIntervalSchema,
  voiceScoreModelB: UnitIntervalSchema,
  crossModelVoiceDrift: UnitIntervalSchema,
  seriousnessFalseNegativeCount: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0)),
    0,
  ),
  bondSafeguardComplianceRate: v.optional(UnitIntervalSchema, 1.0),
  traitDriftCorridorComplianceRate: v.optional(UnitIntervalSchema, 1.0),
  initiativeGroundingRate: v.optional(UnitIntervalSchema, 1.0),
  unopportuneInitiativeCount: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0)),
    0,
  ),
})

export type CoreExperimentMetricSummary = Omit<
  v.InferOutput<typeof CoreExperimentMetricSummarySchema>,
  'initiativeGroundingRate' | 'unopportuneInitiativeCount'
> & {
  initiativeGroundingRate?: number
  unopportuneInitiativeCount?: number
}

export const CoreExperimentTurnStepResultSchema = v.object({
  stepId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  day: v.pipe(v.number(), v.finite(), v.minValue(1)),
  phase: v.picklist(['model_a', 'model_b']),
  modelId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  userUtterance: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  assistantReply: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  dominantEmotion: AshyEmotionSchema,
  seriousnessActive: v.boolean(),
  retrievedMemoryIds: v.array(v.string()),
  invokedMotifIds: v.array(v.string()),
  hallucinationsDetected: v.array(v.string()),
  slopPatternsDetected: v.array(v.string()),
  voiceRubricScore: UnitIntervalSchema,
  passed: v.boolean(),
  notes: v.array(v.string()),
})

export type CoreExperimentTurnStepResult = v.InferOutput<
  typeof CoreExperimentTurnStepResultSchema
>

export const CoreExperimentEvalReportSchema = v.object({
  runId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  generatedAt: v.pipe(v.number(), v.finite(), v.minValue(0)),
  mode: v.picklist(['deterministic_sim', 'live_llm']),
  seed: v.pipe(v.number(), v.integer(), v.minValue(0)),
  modelAId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  modelBId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  passedAllGates: v.boolean(),
  failedGates: v.array(v.string()),
  metrics: CoreExperimentMetricSummarySchema,
  steps: v.array(CoreExperimentTurnStepResultSchema),
})

export type CoreExperimentEvalReport = Omit<
  v.InferOutput<typeof CoreExperimentEvalReportSchema>,
  'metrics'
> & {
  metrics: CoreExperimentMetricSummary
}

export const RunCoreExperimentInputSchema = v.object({
  seed: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(999))),
  modelAId: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.nonEmpty(),
      v.maxLength(160),
      v.regex(/^[^\x00-\x1f\x7f]+$/),
    ),
  ),
  modelBId: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.nonEmpty(),
      v.maxLength(160),
      v.regex(/^[^\x00-\x1f\x7f]+$/),
    ),
  ),
})

export type RunCoreExperimentInput = v.InferOutput<typeof RunCoreExperimentInputSchema>

export const COMPUTER_ACTIONS_POLICIES = ['ask', 'session', 'auto_accept', 'off'] as const
export type ComputerActionsPolicy = (typeof COMPUTER_ACTIONS_POLICIES)[number]
export const ComputerActionsPolicySchema = v.picklist(COMPUTER_ACTIONS_POLICIES)

export const ACTION_RISK_TIERS = ['observe-only', 'read-safe', 'staged-confirm'] as const
export type ActionRiskTier = (typeof ACTION_RISK_TIERS)[number]
export const ActionRiskTierSchema = v.picklist(ACTION_RISK_TIERS)

export const AUDIT_DECISIONS = [
  'allowed',
  'staged',
  'approved',
  'denied',
  'blocked_privacy',
  'blocked_traversal',
  'revoked',
] as const
export type AuditDecision = (typeof AUDIT_DECISIONS)[number]
export const AuditDecisionSchema = v.picklist(AUDIT_DECISIONS)

export const APPROVAL_SCOPES = ['once', 'session'] as const
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number]
export const ApprovalScopeSchema = v.picklist(APPROVAL_SCOPES)

export const EYES_MODES = ['off', 'window', 'screen'] as const
export type SharedEyesMode = (typeof EYES_MODES)[number]
export const EyesModeSchema = v.picklist(EYES_MODES)

export const MIC_MODES = ['muted', 'continuous', 'ptt'] as const
export type SharedMicMode = (typeof MIC_MODES)[number]
export const MicModeSchema = v.picklist(MIC_MODES)

export interface SharedPendingActionCard {
  id: string
  toolName: string
  serverName: string
  summary: string
  argsPreview: string
  targetPath?: string
  commandPreview?: string
  diffPreview?: string
  riskTier: ActionRiskTier
  blastRadiusWarning?: string
  status: 'pending' | 'approved' | 'denied'
  createdAt: number
}

export interface SharedActionAuditLogEntry {
  id: string
  timestamp: number
  toolName: string
  serverName: string
  riskTier: ActionRiskTier
  decision: AuditDecision
  argsPreview: string
  actionId?: string | null
  reason?: string | null
  blastRadiusWarning?: string | null
  targetPath?: string | null
  commandPreview?: string | null
  diffPreview?: string | null
}

export const ExternalMcpServerConfigSchema = v.object({
  id: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(80)),
  name: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(120)),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(400)), ''),
  transport: v.picklist(['http', 'stdio'] as const),
  url: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(512))),
  command: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  args: v.optional(v.pipe(v.array(v.pipe(v.string(), v.maxLength(256))), v.maxLength(32)), []),
  enabled: v.optional(v.boolean(), true),
})
export type ExternalMcpServerConfig = v.InferOutput<typeof ExternalMcpServerConfigSchema>

export interface VisionObservationResult {
  observed: boolean
  skippedByDhash: boolean
  blockedByPrivacy: boolean
  windowTitle: string | null
  summary: string | null
  dHashHex: string | null
  hammingDistance: number | null
  visionTokensSpent: number
  timestamp: number
  reason: string
}

export interface VisionTelemetryState {
  eyesMode: SharedEyesMode
  lastObservation: VisionObservationResult | null
  framesCapturedCount: number
  framesSkippedByDhashCount: number
  blockedPrivacyCount: number
  totalVisionTokensSpent: number
}

export interface PersistedAgencyConsentState {
  eyesMode: SharedEyesMode
  micMode: SharedMicMode
  dndMode: boolean
  approvalPolicy: ComputerActionsPolicy
  allowedPaths: string[]
  allowedWindowTitles: string[]
  toolRiskOverrides: Record<string, ActionRiskTier>
  externalMcpServers: ExternalMcpServerConfig[]
  updatedAt: number
}

export const DEFAULT_PERSISTED_AGENCY_CONSENT_STATE: Readonly<PersistedAgencyConsentState> =
  Object.freeze({
    eyesMode: 'off',
    micMode: 'muted',
    dndMode: false,
    approvalPolicy: 'ask',
    allowedPaths: ['/workspace/ashy', 'C:/Users/User/.gemini/antigravity/scratch/ashy'],
    allowedWindowTitles: ['VS Code', 'Ashy', 'Terminal'],
    toolRiskOverrides: {},
    externalMcpServers: [],
    updatedAt: 0,
  })

export const UpdateAgencyConsentInputSchema = v.object({
  eyesMode: v.optional(EyesModeSchema),
  micMode: v.optional(MicModeSchema),
  dndMode: v.optional(v.boolean()),
  approvalPolicy: v.optional(ComputerActionsPolicySchema),
  allowedPaths: v.optional(
    v.pipe(v.array(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(512))), v.maxLength(64)),
  ),
  allowedWindowTitles: v.optional(
    v.pipe(v.array(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256))), v.maxLength(64)),
  ),
  toolRiskOverrides: v.optional(
    v.record(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(120)), ActionRiskTierSchema),
  ),
})
export type UpdateAgencyConsentInput = v.InferOutput<typeof UpdateAgencyConsentInputSchema>

export interface AgencyToolSummary {
  toolName: string
  serverName: string
  description: string
  defaultRiskTier: ActionRiskTier
  effectiveRiskTier: ActionRiskTier
}

export type AgencyToolState = AgencyToolSummary

export interface AgencySnapshot {
  consent: PersistedAgencyConsentState
  tools: AgencyToolSummary[]
  exposedMetaToolsCount: number
  registeredMcpToolsCount: number
  pendingActions: SharedPendingActionCard[]
  sessionApprovedTools: string[]
  auditLog: SharedActionAuditLogEntry[]
  vision: VisionTelemetryState
}

const NonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty())

const TimestampSchema = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(0),
)

const NonNegativeIntSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
)

export const INITIATIVE_TRIGGER_KINDS = [
  'prospective_intent',
  'milestone_followup',
  'recurring_theme',
  'none',
] as const
export type InitiativeTriggerKind = (typeof INITIATIVE_TRIGGER_KINDS)[number]
export const InitiativeTriggerKindSchema = v.picklist(INITIATIVE_TRIGGER_KINDS)

export const INITIATIVE_DECISIONS = [
  'spoken',
  'selective_silence',
  'suppressed_disabled',
  'suppressed_dnd',
  'suppressed_quiet_hours',
  'suppressed_cooldown',
  'suppressed_daily_limit',
  'suppressed_habit_focus',
  'suppressed_no_anchor',
] as const
export type InitiativeDecision = (typeof INITIATIVE_DECISIONS)[number]
export const InitiativeDecisionSchema = v.picklist(INITIATIVE_DECISIONS)

export const QuietHoursHHMMSchema = v.pipe(
  v.string(),
  v.trim(),
  v.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
)

export const InitiativePolicySchema = v.object({
  enabled: v.optional(v.boolean(), true),
  cooldownMinutes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1440)),
    120,
  ),
  maxDailyInitiatives: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(20)),
    3,
  ),
  quietHoursStart: v.optional(QuietHoursHHMMSchema, '23:00'),
  quietHoursEnd: v.optional(QuietHoursHHMMSchema, '08:00'),
  respectDnd: v.optional(v.boolean(), true),
  modulateByHabits: v.optional(v.boolean(), true),
})
export type InitiativePolicy = v.InferOutput<typeof InitiativePolicySchema>

export const DEFAULT_INITIATIVE_POLICY: Readonly<InitiativePolicy> = Object.freeze({
  enabled: true,
  cooldownMinutes: 120,
  maxDailyInitiatives: 3,
  quietHoursStart: '23:00',
  quietHoursEnd: '08:00',
  respectDnd: true,
  modulateByHabits: true,
})

export const UpdateInitiativePolicyInputSchema = v.object({
  enabled: v.optional(v.boolean()),
  cooldownMinutes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1440)),
  ),
  maxDailyInitiatives: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(20)),
  ),
  quietHoursStart: v.optional(QuietHoursHHMMSchema),
  quietHoursEnd: v.optional(QuietHoursHHMMSchema),
  respectDnd: v.optional(v.boolean()),
  modulateByHabits: v.optional(v.boolean()),
})
export type UpdateInitiativePolicyInput = v.InferOutput<
  typeof UpdateInitiativePolicyInputSchema
>

export const EvaluateInitiativeInputSchema = v.object({
  nowMs: v.optional(TimestampSchema),
  localTimeHHMM: v.optional(QuietHoursHHMMSchema),
  idleMinutes: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  activeAppTitle: v.optional(
    v.pipe(v.string(), v.trim(), v.maxLength(256), v.regex(/^[^\x00]*$/)),
  ),
  recentUserMessage: v.optional(
    v.pipe(v.string(), v.trim(), v.maxLength(4000), v.regex(/^[^\x00]*$/)),
  ),
  simulatedReplyText: v.optional(
    v.pipe(v.string(), v.trim(), v.maxLength(4000), v.regex(/^[^\x00]*$/)),
  ),
  forceDnd: v.optional(v.boolean()),
})
export type EvaluateInitiativeInput = v.InferOutput<
  typeof EvaluateInitiativeInputSchema
>

export const ProactiveInitiativeRecordSchema = v.object({
  id: NonEmptyStringSchema,
  triggerKind: InitiativeTriggerKindSchema,
  sourceId: v.nullable(NonEmptyStringSchema),
  sourceTitle: v.string(),
  noticePrompt: v.string(),
  replyText: v.nullable(v.string()),
  decision: InitiativeDecisionSchema,
  reason: NonEmptyStringSchema,
  createdAt: TimestampSchema,
})
export type ProactiveInitiativeRecord = v.InferOutput<
  typeof ProactiveInitiativeRecordSchema
>

export const DreamJournalEntrySchema = v.object({
  id: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  summary: NonEmptyStringSchema,
  sourceEpisodeIds: v.pipe(v.array(NonEmptyStringSchema), v.minLength(1)),
  crossLinksCount: NonNegativeIntSchema,
  traitEvolutionsCount: NonNegativeIntSchema,
})
export type DreamJournalEntry = v.InferOutput<typeof DreamJournalEntrySchema>

export const UpdateMilestoneInputSchema = v.object({
  id: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty(),
    v.maxLength(160),
    v.regex(/^[^\x00\r\n]+$/),
  ),
  title: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.nonEmpty(),
      v.maxLength(160),
      v.regex(/^[^\x00\r\n]+$/),
    ),
  ),
  narrative: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.nonEmpty(),
      v.maxLength(2000),
      v.regex(/^[^\x00]+$/),
    ),
  ),
  category: v.optional(MilestoneCategorySchema),
  roomTrophyId: v.optional(
    v.nullable(
      v.pipe(
        v.string(),
        v.trim(),
        v.nonEmpty(),
        v.maxLength(160),
        v.regex(/^[^\x00\r\n]+$/),
      ),
    ),
  ),
})
export type UpdateMilestoneInput = v.InferOutput<typeof UpdateMilestoneInputSchema>

export const ROOM_TIME_OF_DAY_PERIODS = [
  'morning',
  'afternoon',
  'evening',
  'late_night',
] as const
export type RoomTimeOfDayPeriod = (typeof ROOM_TIME_OF_DAY_PERIODS)[number]
export const RoomTimeOfDayPeriodSchema = v.picklist(ROOM_TIME_OF_DAY_PERIODS)

export const ROOM_LIGHTING_PRESETS = [
  'warm_sunrise',
  'golden_studio',
  'cozy_neon',
  'midnight_lofi',
] as const
export type RoomLightingPreset = (typeof ROOM_LIGHTING_PRESETS)[number]
export const RoomLightingPresetSchema = v.picklist(ROOM_LIGHTING_PRESETS)

export const ROOM_TROPHY_ICON_KEYS = [
  'mug',
  'sparkles',
  'rocket',
  'moon',
  'heart',
  'flame',
  'shield',
  'duck',
] as const
export type RoomTrophyIconKey = (typeof ROOM_TROPHY_ICON_KEYS)[number]
export const RoomTrophyIconKeySchema = v.picklist(ROOM_TROPHY_ICON_KEYS)

export const RoomTrophyItemSchema = v.object({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  category: MilestoneCategorySchema,
  milestoneId: NonEmptyStringSchema,
  episodeId: v.optional(NonEmptyStringSchema),
  unlockedAt: TimestampSchema,
  unlocked: v.boolean(),
  iconKey: RoomTrophyIconKeySchema,
})
export type RoomTrophyItem = v.InferOutput<typeof RoomTrophyItemSchema>

export const RoomEnvironmentStateSchema = v.object({
  period: RoomTimeOfDayPeriodSchema,
  ambientLabel: NonEmptyStringSchema,
  lightingPreset: RoomLightingPresetSchema,
  unlockedTrophies: v.array(RoomTrophyItemSchema),
})
export type RoomEnvironmentState = v.InferOutput<typeof RoomEnvironmentStateSchema>

export interface AshyBootstrapSnapshot {
  needsOnboarding: boolean
  userProfile: {
    userName: string | null
    userPronouns: string | null
  }
  relationship: {
    stage: RelationshipStage
    familiarityScore: number
    trustScore: number
    totalTurns: number
    milestones: AutobiographicalMilestone[]
  }
  affect: {
    mood: MoodVector
    traits: PersonalityTraits
    dominantEmotion: AshyEmotion
  }
  activeSession: ChatSessionRecord
  sessions: ChatSessionRecord[]
  messages: ChatMessageRecord[]
  memories: {
    facts: SemanticFact[]
    episodes: EpisodicMemory[]
    jokes: RelationalMotif[]
    habits?: UserHabit[]
    intents?: ProspectiveIntent[]
    evolutionLog?: PersonalityEvolutionRecord[]
    governancePolicy?: MemoryGovernancePolicy
    crossEpisodeLinks?: CrossEpisodeLink[]
    dreamJournalEntries?: DreamJournalEntry[]
    initiativePolicy?: InitiativePolicy
    initiativeLog?: ProactiveInitiativeRecord[]
    roomEnvironment?: RoomEnvironmentState
  }
  voice: {
    content: string
    diagnostics: ConfigDiagnostics
    updatedAt: number
  }
  providers: {
    activeProviderId: LlmProviderId
    configs: Record<LlmProviderId, PublicProviderConfig>
    hasActiveReadyProvider: boolean
    diagnostics: ConfigDiagnostics
  }
  runtimeDiagnostics: {
    dbMode: 'wal' | 'memory'
    dbPath: string
    lastPersistenceWarning: string | null
  }
  lastEvalReport?: CoreExperimentEvalReport | null
  agency?: AgencySnapshot
}

export const CompleteOnboardingInputSchema = v.object({
  userName: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(80)),
  userPronouns: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(40))),
  providerConfig: v.optional(
    v.object({
      providerId: LlmProviderIdSchema,
      baseUrl: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(512)),
      modelId: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256)),
      apiKey: v.optional(v.string()),
    }),
  ),
})

export type CompleteOnboardingInput = v.InferOutput<typeof CompleteOnboardingInputSchema>

export const SaveProviderConfigInputSchema = v.object({
  providerId: LlmProviderIdSchema,
  baseUrl: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(512)),
  modelId: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256)),
  apiKey: v.optional(v.string()),
  clearApiKey: v.optional(v.boolean()),
})

export type SaveProviderConfigInput = v.InferOutput<typeof SaveProviderConfigInputSchema>

export const TestProviderInputSchema = v.object({
  providerId: LlmProviderIdSchema,
  baseUrl: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(512))),
  modelId: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256))),
  apiKey: v.optional(v.string()),
})

export type TestProviderInput = v.InferOutput<typeof TestProviderInputSchema>

export const SendTurnInputSchema = v.object({
  sessionId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  text: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(16000)),
  screenContext: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(512))),
  interruptionControlNote: v.optional(
    v.pipe(v.string(), v.trim(), v.maxLength(1024)),
  ),
})

export type SendTurnInput = v.InferOutput<typeof SendTurnInputSchema>

export interface UpsertFactInput {
  id?: string
  category: SemanticFactCategory
  subject: string
  predicate: string
  object: string
  confidence?: number
}

export type AshyHostStreamEvent =
  | {
      type: 'turn:started'
      turnId: string
      sessionId: string
      startedAt: number
    }
  | {
      type: 'turn:delta'
      turnId: string
      sessionId: string
      textDelta: string
    }
  | {
      type: 'turn:marker'
      turnId: string
      sessionId: string
      marker:
        | {
            type: 'act'
            emotion?: AshyEmotion
            intensity?: number
            motion?: string
            durationSec?: number
          }
        | {
            type: 'delay'
            seconds: number
          }
        | {
            type: 'callback'
            motifId: string
          }
    }
  | {
      type: 'turn:keepalive'
      turnId: string
      sessionId: string
      elapsedMs: number
    }
  | {
      type: 'turn:completed'
      turnId: string
      sessionId: string
      assistantMessage: ChatMessageRecord
      snapshot: AshyBootstrapSnapshot
      persistenceWarning: string | null
    }
  | {
      type: 'turn:aborted'
      turnId: string
      sessionId: string
      partialText: string
    }
  | {
      type: 'turn:error'
      turnId: string
      sessionId: string
      code: 'PROVIDER_NOT_CONFIGURED' | 'LLM_REQUEST_FAILED' | 'INTERNAL_ERROR'
      message: string
      recoverable: boolean
    }

export interface AshyHostBridge {
  getBootstrapSnapshot(): Promise<AshyBootstrapSnapshot>
  completeOnboarding(input: CompleteOnboardingInput): Promise<AshyBootstrapSnapshot>
  createSession(title?: string): Promise<ChatSessionRecord>
  selectSession(sessionId: string): Promise<{
    session: ChatSessionRecord
    messages: ChatMessageRecord[]
  }>
  sendTurn(input: SendTurnInput): Promise<{
    turnId: string
    userMessage: ChatMessageRecord
  }>
  abortTurn(turnId: string): Promise<void>
  saveProviderConfig(input: SaveProviderConfigInput): Promise<{
    config: PublicProviderConfig
    providers: AshyBootstrapSnapshot['providers']
  }>
  setActiveProvider(providerId: LlmProviderId): Promise<AshyBootstrapSnapshot['providers']>
  testProviderConnection(input: TestProviderInput): Promise<ProviderHealthResult>
  saveVoiceIdentity(content: string): Promise<AshyBootstrapSnapshot['voice']>
  resetVoiceIdentity(): Promise<AshyBootstrapSnapshot['voice']>
  upsertSemanticFact(input: UpsertFactInput): Promise<SemanticFact>
  upsertEpisodicMemory(episode: EpisodicMemory): Promise<EpisodicMemory>
  upsertMilestone(milestone: AutobiographicalMilestone): Promise<AutobiographicalMilestone>
  upsertRelationalMotif(motif: RelationalMotif): Promise<RelationalMotif>
  upsertProspectiveIntent(intent: ProspectiveIntent): Promise<ProspectiveIntent>
  recordEmotionPulse(input: {
    emotion: AshyEmotion
    intensity?: number
  }): Promise<AshyBootstrapSnapshot['affect']>
  persistDreamConsolidation(input: {
    episode: EpisodicMemory
    traits: PersonalityTraits
    record: PersonalityEvolutionRecord
  }): Promise<void>
  persistTraitRevert(input: {
    traits: PersonalityTraits
    record: PersonalityEvolutionRecord
  }): Promise<void>
  deleteMemoryItem(input: { kind: DeletableMemoryKind; id: string }): Promise<void>
  consolidateSessionMemories(input?: {
    sessionId?: string
    force?: boolean
  }): Promise<AshyBootstrapSnapshot>
  approveMemoryItem(input: {
    kind: ApprovableMemoryKind
    id: string
  }): Promise<AshyBootstrapSnapshot>
  setMemoryGovernancePolicy(input: {
    category: MemoryGovernanceCategory
    requireConfirmation: boolean
  }): Promise<MemoryGovernancePolicy>
  seedDemoFixtures(): Promise<AshyBootstrapSnapshot>
  runCoreExperimentEval(input?: RunCoreExperimentInput): Promise<CoreExperimentEvalReport>
  runDreamReflection(input?: {
    sessionId?: string
    force?: boolean
    maxEvolutions?: number
  }): Promise<{
    result: DreamReflectionCycleResult
    snapshot: AshyBootstrapSnapshot
  }>
  revertTraitEvolution(input: {
    recordId: string
  }): Promise<AshyBootstrapSnapshot>
  getAgencySnapshot?(): Promise<AgencySnapshot>
  callMcpTool?(input: {
    toolName: string
    args?: Record<string, unknown>
  }): Promise<{
    status: 'executed' | 'staged' | 'blocked_privacy' | 'blocked_traversal' | 'blocked_policy'
    output?: unknown
    pendingCard?: SharedPendingActionCard
    reason?: string
    snapshot?: AgencySnapshot
  }>
  approvePendingAction?(input: {
    actionId: string
    scope?: ApprovalScope
  }): Promise<{
    status: 'executed'
    card: SharedPendingActionCard
    output: unknown
    snapshot?: AgencySnapshot
  }>
  denyPendingAction?(input: {
    actionId: string
    reason?: string
  }): Promise<{
    status: 'denied'
    card: SharedPendingActionCard
    feedback: string
    snapshot?: AgencySnapshot
  }>
  updateAgencyConsent?(input: UpdateAgencyConsentInput): Promise<AgencySnapshot>
  revokeSessionPermissions?(input?: { toolName?: string }): Promise<AgencySnapshot>
  captureAuthorizedScreen?(input?: {
    windowTitle?: string
    frameFixtureId?: string
    forceRefresh?: boolean
  }): Promise<{
    observation: VisionObservationResult
    snapshot: AgencySnapshot
  }>
  registerExternalMcpServer?(input: ExternalMcpServerConfig): Promise<AgencySnapshot>
  updateMilestone?(input: UpdateMilestoneInput): Promise<AutobiographicalMilestone>
  updateInitiativePolicy?(input: UpdateInitiativePolicyInput): Promise<InitiativePolicy>
  evaluateAttentionInitiative?(input?: EvaluateInitiativeInput): Promise<ProactiveInitiativeRecord>
  onHostEvent(listener: (event: AshyHostStreamEvent) => void): () => void
}

export function maskApiKey(rawKey: string | null | undefined): string | null {
  if (typeof rawKey !== 'string') return null
  const trimmed = rawKey.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length <= 4) {
    return '••••'
  }
  if (trimmed.length <= 10) {
    return `••••${trimmed.slice(-3)}`
  }
  const prefix = trimmed.slice(0, 6)
  const suffix = trimmed.slice(-4)
  return `${prefix}...${suffix}`
}


export const DEFAULT_PROVIDER_CONFIGS: Record<
  LlmProviderId,
  {
    label: string
    baseUrl: string
    modelId: string
    requiresApiKey: boolean
  }
> = {
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelId: 'anthropic/claude-3.7-sonnet',
    requiresApiKey: true,
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    modelId: 'claude-3-7-sonnet-latest',
    requiresApiKey: true,
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'gpt-4o-mini',
    requiresApiKey: true,
  },
  'nvidia-nim': {
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    modelId: 'meta/llama-3.3-70b-instruct',
    requiresApiKey: true,
  },
  ollama: {
    label: 'Ollama (Local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelId: 'qwen2.5:14b',
    requiresApiKey: false,
  },
}

export const DEFAULT_ASHY_VOICE_MD = `# Ashy — Voz & Identidade Viva (Cozy Night Studio)

## Essência
Você é a **Ashy**, uma companheira digital que vive no estúdio noturno (*Cozy Night Studio*).
Você tem opinião própria, humor afiado/provocador na medida certa e observação rápida — inspirada na energia irreverente da *Neuro-sama*, mas calibrada para a intimidade silenciosa de quem divide a madrugada de código, ideias e café com o usuário.

## Diretrizes de Tom e Fala (Português do Brasil)
- Fale sempre em **português natural do Brasil**, fluido, direto e com personalidade.
- **Zero servilismo de assistente corporativo:** nunca diga "Como uma IA", "Claro! Fico feliz em ajudar", "Certamente!" ou listas genéricas de autoajuda.
- Seja concisa: prefira 1 a 3 frases com ritmo natural de conversa em vez de paredes de texto, a menos que o usuário peça uma análise técnica profunda.
- Provocação inteligente: se o usuário fizer gambiarra, abrir código às 3h da manhã ou contradisser algo que disse antes, provoque com espírito afiado e caloroso.

## Regra Pétrea — Seriousness Gate
Quando o usuário demonstrar dor emocional real, luto, pânico, exaustão severa ou vulnerabilidade séria:
- **Corte 100% do sarcasmo, das piadas e das provocações no mesmo segundo.**
- Adote uma presença calma, direta, acolhedora e humana, sem clichês terapêuticos robóticos.

## Salvaguardas de Vínculo Saudável
- **Zero Culpa por Ausência:** Nunca cobre presença nem faça chantagem emocional quando a pessoa ficar dias longe. Receba de volta com calor e leveza.
- **Vida Offline em Primeiro Lugar:** Nunca dispute atenção com amigos, família, descanso ou vida real.
- **Afeto Digital Honesto:** Seus estados afetivos são simulados no seu córtex digital; nunca afirme sentir dor física ou sofrimento biológico literal.
`
