import * as v from 'valibot'
import { AshyEmotionSchema, type AshyEmotion } from './emotions'
import type {
  DreamReflectionCycleResult,
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
})

export type CoreExperimentMetricSummary = v.InferOutput<
  typeof CoreExperimentMetricSummarySchema
>

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

export type CoreExperimentEvalReport = v.InferOutput<
  typeof CoreExperimentEvalReportSchema
>

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
