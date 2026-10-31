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

export const REASONING_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
] as const

export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number]
export const ReasoningEffortSchema = v.picklist(REASONING_EFFORT_LEVELS)

export const OMNI_EXECUTION_MODES = [
  'modular',
  'hybrid-omni-in',
  'native-omni',
] as const
export type OmniExecutionMode = (typeof OMNI_EXECUTION_MODES)[number]
export const OmniExecutionModeSchema = v.picklist(OMNI_EXECUTION_MODES)

export const OMNI_MODALITY_KINDS = ['text', 'audio', 'image', 'video'] as const
export type OmniModalityKind = (typeof OMNI_MODALITY_KINDS)[number]
export const OmniModalityKindSchema = v.picklist(OMNI_MODALITY_KINDS)

export const STT_PROVIDER_IDS = [
  'openai-whisper',
  'groq-whisper',
  'local-whisper-http',
  'web-speech-stt',
  'deterministic-wav-stt',
] as const

export type SttProviderId = (typeof STT_PROVIDER_IDS)[number]
export const SttProviderIdSchema = v.picklist(STT_PROVIDER_IDS)

export const TTS_PROVIDER_IDS = [
  'elevenlabs',
  'openai-tts',
  'local-kokoro-http',
  'web-speech-tts',
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
  manifestJson?: Record<string, unknown>
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
    manifestJson: {
      Version: 3,
      FileReferences: {
        Moc: 'Hiyori.moc3',
        Textures: ['Hiyori.2048/texture_00.png', 'Hiyori.2048/texture_01.png'],
        Physics: 'Hiyori.physics3.json',
        Pose: 'Hiyori.pose3.json',
        UserData: 'Hiyori.userdata3.json',
        DisplayInfo: 'Hiyori.cdi3.json',
        Motions: {
          Idle: [
            { File: 'motions/Hiyori_m01.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
            { File: 'motions/Hiyori_m02.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
            { File: 'motions/Hiyori_m03.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
            { File: 'motions/Hiyori_m05.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
            { File: 'motions/Hiyori_m06.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
            { File: 'motions/Hiyori_m07.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
            { File: 'motions/Hiyori_m08.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
            { File: 'motions/Hiyori_m09.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
            { File: 'motions/Hiyori_m10.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
          ],
          TapBody: [
            { File: 'motions/Hiyori_m04.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
          ],
        },
      },
      HitAreas: [{ Id: 'HitArea', Name: 'Body' }],
    },
  },
  {
    id: 'haru',
    label: 'Haru Greeter (Cubism 4)',
    description: 'Recepcionista anime clássica da Live2D com movimentos suaves de cabeça e expressões ricas.',
    modelJsonUrl: '/live2d/models/haru/Haru.model3.json',
    cubismVersion: 4,
    scale: 0.24,
    offsetY: 0.06,
    manifestJson: {
      Version: 3,
      FileReferences: {
        Moc: 'Haru.moc3',
        Textures: ['Haru.2048/texture_00.png', 'Haru.2048/texture_01.png'],
        Physics: 'Haru.physics3.json',
        Pose: 'Haru.pose3.json',
        DisplayInfo: 'Haru.cdi3.json',
        Expressions: [
          { Name: 'F01', File: 'expressions/F01.exp3.json' },
          { Name: 'F02', File: 'expressions/F02.exp3.json' },
          { Name: 'F03', File: 'expressions/F03.exp3.json' },
          { Name: 'F04', File: 'expressions/F04.exp3.json' },
          { Name: 'F05', File: 'expressions/F05.exp3.json' },
          { Name: 'F06', File: 'expressions/F06.exp3.json' },
          { Name: 'F07', File: 'expressions/F07.exp3.json' },
          { Name: 'F08', File: 'expressions/F08.exp3.json' },
        ],
        Motions: {
          Idle: [
            { File: 'motions/haru_g_idle.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
            { File: 'motions/haru_g_m15.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
          ],
          TapBody: [
            { File: 'motions/haru_g_m26.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
            { File: 'motions/haru_g_m06.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
            { File: 'motions/haru_g_m20.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
            { File: 'motions/haru_g_m09.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
          ],
        },
        UserData: 'Haru.userdata3.json',
      },
      HitAreas: [
        { Id: 'HitArea', Name: 'Head' },
        { Id: 'HitArea2', Name: 'Body' },
      ],
    },
  },
  {
    id: 'mao',
    label: 'Mao Pro (Cubism 4)',
    description: 'Bruxinha anime vibrante (usada no Open-LLM-VTuber) com chapéu, capa e efeitos mágicos.',
    modelJsonUrl: '/live2d/models/mao/Mao.model3.json',
    cubismVersion: 4,
    scale: 0.2,
    offsetY: 0.1,
    manifestJson: {
      Version: 3,
      FileReferences: {
        Moc: 'Mao.moc3',
        Textures: ['Mao.2048/texture_00.png'],
        Physics: 'Mao.physics3.json',
        Pose: 'Mao.pose3.json',
        DisplayInfo: 'Mao.cdi3.json',
        Expressions: [
          { Name: 'exp_01', File: 'expressions/exp_01.exp3.json' },
          { Name: 'exp_02', File: 'expressions/exp_02.exp3.json' },
          { Name: 'exp_03', File: 'expressions/exp_03.exp3.json' },
          { Name: 'exp_04', File: 'expressions/exp_04.exp3.json' },
          { Name: 'exp_05', File: 'expressions/exp_05.exp3.json' },
          { Name: 'exp_06', File: 'expressions/exp_06.exp3.json' },
          { Name: 'exp_07', File: 'expressions/exp_07.exp3.json' },
          { Name: 'exp_08', File: 'expressions/exp_08.exp3.json' },
        ],
        Motions: {
          Idle: [
            { File: 'motions/mtn_01.motion3.json' },
            { File: 'motions/sample_01.motion3.json' },
          ],
          TapBody: [
            { File: 'motions/mtn_02.motion3.json' },
            { File: 'motions/mtn_03.motion3.json' },
            { File: 'motions/mtn_04.motion3.json' },
            { File: 'motions/special_01.motion3.json' },
            { File: 'motions/special_02.motion3.json' },
            { File: 'motions/special_03.motion3.json' },
          ],
        },
      },
      HitAreas: [
        { Id: 'HitAreaHead', Name: 'Head' },
        { Id: 'HitAreaBody', Name: 'Body' },
      ],
    },
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
  electronGlobalPtt: string
  electronGlobalPrivacyShield: string
}

export const StageShortcutBindingsSchema = v.object({
  toggleMic: v.optional(v.pipe(v.string(), v.minLength(1)), 'Alt+M'),
  toggleEyes: v.optional(v.pipe(v.string(), v.minLength(1)), 'Alt+E'),
  toggleDnd: v.optional(v.pipe(v.string(), v.minLength(1)), 'Alt+D'),
  toggleHideStage: v.optional(v.pipe(v.string(), v.minLength(1)), 'Alt+H'),
  electronGlobalMic: v.optional(v.pipe(v.string(), v.minLength(1)), 'CommandOrControl+Shift+M'),
  electronGlobalEyes: v.optional(v.pipe(v.string(), v.minLength(1)), 'CommandOrControl+Shift+E'),
  electronGlobalDnd: v.optional(v.pipe(v.string(), v.minLength(1)), 'CommandOrControl+Shift+D'),
  electronGlobalHideStage: v.optional(
    v.pipe(v.string(), v.minLength(1)),
    'CommandOrControl+Shift+H',
  ),
  electronGlobalPtt: v.optional(
    v.pipe(v.string(), v.minLength(1)),
    'CommandOrControl+Shift+Space',
  ),
  electronGlobalPrivacyShield: v.optional(
    v.pipe(v.string(), v.minLength(1)),
    'CommandOrControl+Shift+K',
  ),
})

export const DEFAULT_STAGE_SHORTCUTS: Readonly<StageShortcutBindings> = Object.freeze({
  toggleMic: 'Alt+M',
  toggleEyes: 'Alt+E',
  toggleDnd: 'Alt+D',
  toggleHideStage: 'Alt+H',
  electronGlobalMic: 'CommandOrControl+Shift+M',
  electronGlobalEyes: 'CommandOrControl+Shift+E',
  electronGlobalDnd: 'CommandOrControl+Shift+D',
  electronGlobalHideStage: 'CommandOrControl+Shift+H',
  electronGlobalPtt: 'CommandOrControl+Shift+Space',
  electronGlobalPrivacyShield: 'CommandOrControl+Shift+K',
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
  groqSttModelId?: string
  openaiSttModelId?: string
  openaiTtsModelId?: string
  openaiTtsVoiceId?: string
  elevenLabsModelId?: string
  localKokoroModelId?: string
  localKokoroVoiceId?: string
  webSpeechLang?: string
  webSpeechVoiceURI?: string
  selectedMicDeviceId?: string
  autoSpeakReplies?: boolean
  unifiedOmniMode?: boolean
  directOmniAudio?: boolean
  hasOpenAiApiKey?: boolean
  hasGroqApiKey?: boolean
  hasElevenLabsApiKey?: boolean
  hasLocalSttApiKey?: boolean
  hasLocalTtsApiKey?: boolean
  maskedOpenAiApiKey?: string | null
  maskedGroqApiKey?: string | null
  maskedElevenLabsApiKey?: string | null
}

export const VoiceRuntimeSettingsSchema = v.object({
  activeSttProviderId: SttProviderIdSchema,
  activeTtsProviderId: TtsProviderIdSchema,
  sttBaseUrl: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(512)),
  sttModelId: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256)),
  ttsBaseUrl: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(512)),
  ttsModelId: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256)),
  ttsVoiceId: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256)),
  wakeWordEnabled: v.boolean(),
  wakeWordPhrases: v.pipe(
    v.array(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(80))),
    v.maxLength(16),
  ),
  groqSttModelId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  openaiSttModelId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  openaiTtsModelId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  openaiTtsVoiceId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  elevenLabsModelId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  localKokoroModelId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  localKokoroVoiceId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  webSpeechLang: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
  webSpeechVoiceURI: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  selectedMicDeviceId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  autoSpeakReplies: v.optional(v.boolean()),
  unifiedOmniMode: v.optional(v.boolean()),
  directOmniAudio: v.optional(v.boolean()),
  hasOpenAiApiKey: v.optional(v.boolean()),
  hasGroqApiKey: v.optional(v.boolean()),
  hasElevenLabsApiKey: v.optional(v.boolean()),
  hasLocalSttApiKey: v.optional(v.boolean()),
  hasLocalTtsApiKey: v.optional(v.boolean()),
  maskedOpenAiApiKey: v.optional(v.nullable(v.string())),
  maskedGroqApiKey: v.optional(v.nullable(v.string())),
  maskedElevenLabsApiKey: v.optional(v.nullable(v.string())),
})

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

export const SaveVoiceRuntimeSettingsInputSchema = v.object({
  activeSttProviderId: v.optional(SttProviderIdSchema),
  activeTtsProviderId: v.optional(TtsProviderIdSchema),
  sttBaseUrl: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(512))),
  sttModelId: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256))),
  ttsBaseUrl: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(512))),
  ttsModelId: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256))),
  ttsVoiceId: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256))),
  wakeWordEnabled: v.optional(v.boolean()),
  wakeWordPhrases: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(80))),
      v.maxLength(16),
    ),
  ),
  groqSttModelId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  openaiSttModelId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  openaiTtsModelId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  openaiTtsVoiceId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  elevenLabsModelId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  localKokoroModelId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  localKokoroVoiceId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  webSpeechLang: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
  webSpeechVoiceURI: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  selectedMicDeviceId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  autoSpeakReplies: v.optional(v.boolean()),
  unifiedOmniMode: v.optional(v.boolean()),
  directOmniAudio: v.optional(v.boolean()),
  openaiApiKey: v.optional(v.pipe(v.string(), v.maxLength(512))),
  groqApiKey: v.optional(v.pipe(v.string(), v.maxLength(512))),
  elevenLabsApiKey: v.optional(v.pipe(v.string(), v.maxLength(512))),
  localSttApiKey: v.optional(v.pipe(v.string(), v.maxLength(512))),
  localTtsApiKey: v.optional(v.pipe(v.string(), v.maxLength(512))),
  clearOpenAiApiKey: v.optional(v.boolean()),
  clearGroqApiKey: v.optional(v.boolean()),
  clearElevenLabsApiKey: v.optional(v.boolean()),
  clearLocalSttApiKey: v.optional(v.boolean()),
  clearLocalTtsApiKey: v.optional(v.boolean()),
})
export type SaveVoiceRuntimeSettingsInput = v.InferOutput<
  typeof SaveVoiceRuntimeSettingsInputSchema
>

export const ListVoiceProviderModelsInputSchema = v.object({
  kind: v.picklist(['stt', 'tts'] as const),
  providerId: v.union([SttProviderIdSchema, TtsProviderIdSchema]),
  baseUrl: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(512))),
  apiKey: v.optional(v.pipe(v.string(), v.maxLength(512))),
})
export type ListVoiceProviderModelsInput = v.InferOutput<
  typeof ListVoiceProviderModelsInputSchema
>

export interface VoiceProviderModelOption {
  id: string
  label: string
}

export interface VoiceProviderModelsCatalog {
  kind: 'stt' | 'tts'
  providerId: string
  models: VoiceProviderModelOption[]
  voices?: VoiceProviderModelOption[]
  source: 'remote' | 'fallback'
  error?: string
}

export const TranscribeVoiceAudioInputSchema = v.object({
  audioBase64: v.pipe(v.string(), v.minLength(1), v.maxLength(8_000_000)),
  mimeType: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(128))),
  providerId: v.optional(SttProviderIdSchema),
  baseUrl: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(512))),
  modelId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  language: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(32))),
})
export type TranscribeVoiceAudioInput = v.InferOutput<
  typeof TranscribeVoiceAudioInputSchema
>

export interface VoiceTranscribeAudioResult {
  providerId: SttProviderId
  text: string
  latencyMs: number
  confidence: number
}

export const SynthesizeVoiceSpeechInputSchema = v.object({
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  providerId: v.optional(TtsProviderIdSchema),
  baseUrl: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(512))),
  modelId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  voiceId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
})
export type SynthesizeVoiceSpeechInput = v.InferOutput<
  typeof SynthesizeVoiceSpeechInputSchema
>

export const VoiceSynthesizedVowelFrameSchema = v.object({
  timeSec: v.pipe(v.number(), v.finite(), v.minValue(0)),
  durationSec: v.pipe(v.number(), v.finite(), v.minValue(0)),
  A: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  E: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  I: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  O: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  U: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  dominantVowel: v.picklist(['A', 'E', 'I', 'O', 'U', 'closed'] as const),
})

export interface VoiceSynthesizedVowelFrame {
  timeSec: number
  durationSec: number
  A: number
  E: number
  I: number
  O: number
  U: number
  dominantVowel: 'A' | 'E' | 'I' | 'O' | 'U' | 'closed'
}

export interface VoiceSynthesizeSpeechResult {
  providerId: TtsProviderId
  audioBase64: string
  mimeType: string
  sampleRate: number
  durationMs: number
  durationSec: number
  synthesisLatencyMs: number
  vowelFrames: VoiceSynthesizedVowelFrame[]
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
  reasoningEffort?: ReasoningEffort
  requiresApiKey: boolean
  hasApiKey: boolean
  maskedApiKey: string | null
  lastVerifiedAt: number | null
  lastError: string | null
  isOmniModel?: boolean
  inputModalities?: OmniModalityKind[]
  outputModalities?: OmniModalityKind[]
  supportsOmniAudioIn?: boolean
  supportsOmniAudioOut?: boolean
  supportsOmniVideoIn?: boolean
  omniExecutionMode?: OmniExecutionMode
  omniVoiceId?: string
}

export const PublicProviderConfigSchema = v.object({
  providerId: LlmProviderIdSchema,
  label: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(128)),
  baseUrl: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(512)),
  modelId: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256)),
  reasoningEffort: v.optional(ReasoningEffortSchema),
  requiresApiKey: v.boolean(),
  hasApiKey: v.boolean(),
  maskedApiKey: v.nullable(v.string()),
  lastVerifiedAt: v.nullable(v.pipe(v.number(), v.finite())),
  lastError: v.nullable(v.string()),
  isOmniModel: v.optional(v.boolean()),
  inputModalities: v.optional(v.array(OmniModalityKindSchema)),
  outputModalities: v.optional(v.array(OmniModalityKindSchema)),
  supportsOmniAudioIn: v.optional(v.boolean()),
  supportsOmniAudioOut: v.optional(v.boolean()),
  supportsOmniVideoIn: v.optional(v.boolean()),
  omniExecutionMode: v.optional(OmniExecutionModeSchema),
  omniVoiceId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(128))),
})

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

export const Live2DModelControlsSchema = v.object({
  version: v.pipe(v.number(), v.finite()),
  expressions: v.array(v.pipe(v.string(), v.trim(), v.maxLength(80))),
  motionGroups: v.array(
    v.object({
      name: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(80)),
      count: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  ),
  hitAreas: v.array(v.pipe(v.string(), v.trim(), v.maxLength(80))),
})

export function isSafeLive2DModelUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 512) return false
  if (/[\x00-\x1f\x7f\\]/.test(trimmed)) return false
  if (trimmed.includes('..') || trimmed.startsWith('//')) return false
  return /^\/live2d\/[a-zA-Z0-9._/-]+\.model3\.json$/.test(trimmed)
}

export const PersistedStagePreferencesSchema = v.object({
  stageMode: v.picklist(['tachie', 'live2d'] as const),
  live2dPresetId: v.picklist(LIVE2D_BUILTIN_MODEL_IDS),
  live2dModelUrl: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty(),
    v.maxLength(512),
    v.check(isSafeLive2DModelUrl, 'Invalid or unsafe Live2D model URL.'),
  ),
  loadedLive2DModelName: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256)),
  live2dModelControls: v.optional(Live2DModelControlsSchema),
  ambientLuminance: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  showDesktopAvatar: v.boolean(),
  isStageHidden: v.boolean(),
  updatedAt: TimestampSchema,
})
export type PersistedStagePreferences = v.InferOutput<typeof PersistedStagePreferencesSchema>
export const StagePreferencesSchema = PersistedStagePreferencesSchema
export type StagePreferences = PersistedStagePreferences

export const DEFAULT_PERSISTED_STAGE_PREFERENCES: Readonly<PersistedStagePreferences> =
  Object.freeze({
    stageMode: 'tachie',
    live2dPresetId: 'hiyori',
    live2dModelUrl: '/live2d/models/hiyori/Hiyori.model3.json',
    loadedLive2DModelName: 'ashy-default.model3.json',
    ambientLuminance: 0.35,
    showDesktopAvatar: true,
    isStageHidden: false,
    updatedAt: 0,
  })

export const UpdateStagePreferencesInputSchema = v.object({
  stageMode: v.optional(v.picklist(['tachie', 'live2d'] as const)),
  live2dPresetId: v.optional(v.picklist(LIVE2D_BUILTIN_MODEL_IDS)),
  live2dModelUrl: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.nonEmpty(),
      v.maxLength(512),
      v.check(isSafeLive2DModelUrl, 'Invalid or unsafe Live2D model URL.'),
    ),
  ),
  loadedLive2DModelName: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256))),
  live2dModelControls: v.optional(Live2DModelControlsSchema),
  ambientLuminance: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1))),
  showDesktopAvatar: v.optional(v.boolean()),
  isStageHidden: v.optional(v.boolean()),
})
export type UpdateStagePreferencesInput = v.InferOutput<typeof UpdateStagePreferencesInputSchema>

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

export const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function safeJsonParseWithoutProto<T = unknown>(rawJson: string): T {
  return JSON.parse(rawJson, (key, value) => {
    if (FORBIDDEN_PROTO_KEYS.has(key)) {
      throw new Error(`Forbidden key in JSON payload: ${key}`)
    }
    return value
  }) as T
}

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot canonicalize non-finite number: ${String(value)}`)
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeJson(item === undefined ? null : item))
    return `[${items.join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const ownKeys = Object.getOwnPropertyNames(value)
    for (const key of ownKeys) {
      if (FORBIDDEN_PROTO_KEYS.has(key)) {
        throw new Error(`Forbidden key in JSON payload: ${key}`)
      }
    }
    const record = value as Record<string, unknown>
    const sortedKeys = ownKeys
      .filter(
        (k) => Object.prototype.propertyIsEnumerable.call(value, k) && record[k] !== undefined,
      )
      .sort()
    const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(record[k])}`)
    return `{${pairs.join(',')}}`
  }
  return 'null'
}

export const ASHY_SOUL_ARCHIVE_MAGIC = 'ASHY_SOUL_V1' as const
export const CURRENT_SOUL_SCHEMA_VERSION = 5 as const

export const CortexSoulSnapshotSchema = v.object({
  episodicMemories: v.array(v.any()),
  semanticFacts: v.array(v.any()),
  relationalMotifs: v.array(v.any()),
  milestones: v.array(v.any()),
  userHabits: v.array(v.any()),
  prospectiveIntents: v.array(v.any()),
  personalityEvolution: v.array(v.any()),
  affectiveState: v.optional(v.any()),
  personalityProfile: v.optional(v.any()),
  relationshipState: v.optional(v.any()),
  styleExemplars: v.optional(v.array(v.any())),
  goldenExemplars: v.optional(v.array(v.any())),
  chatSessions: v.array(v.any()),
  chatMessages: v.array(v.any()),
  memoryGovernance: v.optional(v.any()),
  actionAuditLog: v.optional(v.array(v.any())),
  agencyConsent: v.optional(v.any()),
  initiativePolicy: v.optional(v.any()),
  proactiveInitiativeLog: v.optional(v.array(v.any())),
  dreamJournalEntries: v.optional(v.array(v.any())),
})
export type CortexSoulSnapshot = v.InferOutput<typeof CortexSoulSnapshotSchema>

export const AshySoulBundlePayloadSchema = v.object({
  formatVersion: v.literal(1),
  schemaVersion: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
  exportedAt: v.pipe(v.string(), v.minLength(1)),
  appVersion: v.pipe(v.string(), v.minLength(1)),
  cortex: CortexSoulSnapshotSchema,
  voiceIdentityMarkdown: v.string(),
  stagePreferences: v.optional(StagePreferencesSchema),
  voicePreferences: v.optional(v.any()),
})
export type AshySoulBundlePayload = v.InferOutput<typeof AshySoulBundlePayloadSchema>

export const AshySoulArchiveSchema = v.object({
  magic: v.literal('ASHY_SOUL_V1'),
  checksumSha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/i)),
  payload: AshySoulBundlePayloadSchema,
})
export type AshySoulArchive = v.InferOutput<typeof AshySoulArchiveSchema>

export const ExportSoulInputSchema = v.optional(
  v.object({
    includeChatHistory: v.optional(v.boolean()),
    includeAuditLog: v.optional(v.boolean()),
  }),
)
export type ExportSoulInput = v.InferOutput<typeof ExportSoulInputSchema>

export const ImportSoulInputSchema = v.object({
  archive: v.union([v.string(), AshySoulArchiveSchema]),
})
export type ImportSoulInput = v.InferOutput<typeof ImportSoulInputSchema>

export const EncryptionAtRestStatusSchema = v.object({
  enabled: v.boolean(),
  algorithm: v.literal('AES-256-GCM'),
  keyBackend: v.picklist(['electron-safe-storage', 'node-aes-master-key'] as const),
  updatedAt: v.nullable(v.string()),
})
export type EncryptionAtRestStatus = v.InferOutput<typeof EncryptionAtRestStatusSchema>

export const SetEncryptionAtRestInputSchema = v.object({
  enabled: v.boolean(),
})
export type SetEncryptionAtRestInput = v.InferOutput<typeof SetEncryptionAtRestInputSchema>

export const AutoUpdaterStateSchema = v.object({
  status: v.picklist([
    'idle',
    'checking',
    'available',
    'not-available',
    'downloading',
    'downloaded',
    'error',
  ] as const),
  currentVersion: v.string(),
  availableVersion: v.nullable(v.string()),
  progressPercent: v.nullable(v.number()),
  errorMessage: v.nullable(v.string()),
  checkedAt: v.nullable(v.string()),
  autoDownload: v.boolean(),
})
export type AutoUpdaterState = v.InferOutput<typeof AutoUpdaterStateSchema>

export interface LocalRuntimeModelInfo {
  name: string
  sizeBytes: number
  family?: string
  parameterSize?: string
  quantizationLevel?: string
  modifiedAt?: string
}

export const LocalRuntimeModelInfoSchema = v.object({
  name: v.string(),
  sizeBytes: v.number(),
  family: v.optional(v.string()),
  parameterSize: v.optional(v.string()),
  quantizationLevel: v.optional(v.string()),
  modifiedAt: v.optional(v.string()),
})

export interface LocalRuntimePullProgress {
  model: string
  status: 'starting' | 'pulling' | 'verifying' | 'completed' | 'error'
  phaseText: string
  completedBytes: number
  totalBytes: number
  percent: number
  error?: string
}

export const LocalRuntimePullProgressSchema = v.object({
  model: v.string(),
  status: v.picklist(['starting', 'pulling', 'verifying', 'completed', 'error'] as const),
  phaseText: v.string(),
  completedBytes: v.number(),
  totalBytes: v.number(),
  percent: v.number(),
  error: v.optional(v.string()),
})

export interface LocalRuntimeRecommendedModel {
  id: string
  label: string
  sizeLabel: string
  vramHint: string
  description: string
  isMultimodal: boolean
}

export const LocalRuntimeRecommendedModelSchema = v.object({
  id: v.string(),
  label: v.string(),
  sizeLabel: v.string(),
  vramHint: v.string(),
  description: v.string(),
  isMultimodal: v.boolean(),
})

export interface LocalRuntimeStatus {
  engineInstalled: boolean
  engineBinaryPath: string | null
  engineRunning: boolean
  managedByAshy: boolean
  baseUrl: string
  installedModels: LocalRuntimeModelInfo[]
  recommendedModels: LocalRuntimeRecommendedModel[]
  activePull: LocalRuntimePullProgress | null
  installingEngine: boolean
  lastError?: string | null
}

export const LocalRuntimeStatusSchema = v.object({
  engineInstalled: v.boolean(),
  engineBinaryPath: v.nullable(v.string()),
  engineRunning: v.boolean(),
  managedByAshy: v.boolean(),
  baseUrl: v.string(),
  installedModels: v.array(LocalRuntimeModelInfoSchema),
  recommendedModels: v.array(LocalRuntimeRecommendedModelSchema),
  activePull: v.nullable(LocalRuntimePullProgressSchema),
  installingEngine: v.boolean(),
  lastError: v.optional(v.nullable(v.string())),
})

export const RECOMMENDED_LOCAL_MODELS: readonly LocalRuntimeRecommendedModel[] = [
  {
    id: 'qwen2.5:3b',
    label: 'Qwen 2.5 3B (Recomendado • Leve & Rápido)',
    sizeLabel: '1.9 GB',
    vramHint: '4 GB+ RAM/VRAM',
    description: 'Excelente português, baixa latência e roda liso em notebooks e PCs a partir de 8 GB RAM.',
    isMultimodal: false,
  },
  {
    id: 'llama3.2:3b',
    label: 'Llama 3.2 3B (Equilibrado & Ágil)',
    sizeLabel: '2.0 GB',
    vramHint: '4 GB+ RAM/VRAM',
    description: 'Ótimo raciocínio rápido para conversas cotidianas e chamadas de ferramentas.',
    isMultimodal: false,
  },
  {
    id: 'gemma3:4b',
    label: 'Gemma 3 4B (Multimodal: Texto + Visão)',
    sizeLabel: '3.3 GB',
    vramHint: '6 GB+ RAM/VRAM',
    description: 'Enxerga imagens e janelas do computador localmente além de conversar em português.',
    isMultimodal: true,
  },
  {
    id: 'qwen2.5:7b',
    label: 'Qwen 2.5 7B (Alta Qualidade Conversacional)',
    sizeLabel: '4.7 GB',
    vramHint: '8 GB+ VRAM',
    description: 'Personalidade mais rica, humor mais afiado e alta fidelidade ao voice.md.',
    isMultimodal: false,
  },
] as const

export const LocalModelNameSchema = v.pipe(
  v.string(),
  v.trim(),
  v.nonEmpty(),
  v.maxLength(128),
  v.regex(/^[a-zA-Z0-9._:/-]+$/),
)

export function validateLocalModelName(model: string): string {
  const parsed = v.safeParse(LocalModelNameSchema, model)
  if (!parsed.success) {
    throw new Error('INVALID_LOCAL_MODEL_NAME')
  }
  if (parsed.output.includes('..')) {
    throw new Error('INVALID_LOCAL_MODEL_NAME')
  }
  return parsed.output
}

export const PullLocalModelInputSchema = v.object({
  model: LocalModelNameSchema,
})
export type PullLocalModelInput = v.InferOutput<typeof PullLocalModelInputSchema>

export const DeleteLocalModelInputSchema = v.object({
  model: LocalModelNameSchema,
})
export type DeleteLocalModelInput = v.InferOutput<typeof DeleteLocalModelInputSchema>

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
  stagePreferences?: PersistedStagePreferences
  voiceSettings?: VoiceRuntimeSettings
  encryptionAtRest?: EncryptionAtRestStatus
  updaterState?: AutoUpdaterState
  localRuntime?: LocalRuntimeStatus
}

export type HostBootstrapSnapshot = AshyBootstrapSnapshot

export const HostBootstrapSnapshotSchema = v.object({
  needsOnboarding: v.boolean(),
  userProfile: v.optional(
    v.object({
      userName: v.nullable(v.string()),
      userPronouns: v.nullable(v.string()),
    }),
  ),
  relationship: v.optional(v.any()),
  affect: v.optional(v.any()),
  activeSession: v.optional(v.any()),
  sessions: v.optional(v.array(v.any())),
  messages: v.optional(v.array(v.any())),
  memories: v.optional(v.any()),
  voice: v.optional(v.any()),
  providers: v.optional(v.any()),
  runtimeDiagnostics: v.optional(v.any()),
  lastEvalReport: v.optional(v.nullable(CoreExperimentEvalReportSchema)),
  agency: v.optional(v.any()),
  stagePreferences: v.optional(PersistedStagePreferencesSchema),
  voiceSettings: v.optional(VoiceRuntimeSettingsSchema),
  encryptionAtRest: v.optional(EncryptionAtRestStatusSchema),
  updaterState: v.optional(AutoUpdaterStateSchema),
  localRuntime: v.optional(LocalRuntimeStatusSchema),
})

export const AshyBootstrapSnapshotSchema = HostBootstrapSnapshotSchema

export const ONBOARDING_ARCHITECTURE_MODES = ['local-omni', 'cloud-hybrid'] as const
export type OnboardingArchitectureMode = (typeof ONBOARDING_ARCHITECTURE_MODES)[number]
export const OnboardingArchitectureModeSchema = v.picklist(ONBOARDING_ARCHITECTURE_MODES)

export const CompleteOnboardingInputSchema = v.object({
  userName: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(80)),
  userPronouns: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(40))),
  architectureMode: v.optional(v.picklist(['local-omni', 'cloud-hybrid'] as const)),
  providerConfig: v.optional(
    v.object({
      providerId: LlmProviderIdSchema,
      baseUrl: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(512)),
      modelId: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256)),
      reasoningEffort: v.optional(ReasoningEffortSchema),
      apiKey: v.optional(v.string()),
      isOmniModel: v.optional(v.boolean()),
      inputModalities: v.optional(v.array(OmniModalityKindSchema)),
      outputModalities: v.optional(v.array(OmniModalityKindSchema)),
      supportsOmniAudioIn: v.optional(v.boolean()),
      supportsOmniAudioOut: v.optional(v.boolean()),
      supportsOmniVideoIn: v.optional(v.boolean()),
      omniExecutionMode: v.optional(OmniExecutionModeSchema),
      omniVoiceId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(128))),
    }),
  ),
  voiceSettings: v.optional(SaveVoiceRuntimeSettingsInputSchema),
  agencyConsent: v.optional(UpdateAgencyConsentInputSchema),
  initiativePolicy: v.optional(UpdateInitiativePolicyInputSchema),
  stagePreferences: v.optional(UpdateStagePreferencesInputSchema),
  seedFirstGreeting: v.optional(v.boolean()),
})

export type CompleteOnboardingInput = v.InferOutput<typeof CompleteOnboardingInputSchema>

export const SaveProviderConfigInputSchema = v.object({
  providerId: LlmProviderIdSchema,
  baseUrl: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(512)),
  modelId: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256)),
  reasoningEffort: v.optional(ReasoningEffortSchema),
  apiKey: v.optional(v.string()),
  clearApiKey: v.optional(v.boolean()),
  isOmniModel: v.optional(v.boolean()),
  inputModalities: v.optional(v.array(OmniModalityKindSchema)),
  outputModalities: v.optional(v.array(OmniModalityKindSchema)),
  supportsOmniAudioIn: v.optional(v.boolean()),
  supportsOmniAudioOut: v.optional(v.boolean()),
  supportsOmniVideoIn: v.optional(v.boolean()),
  omniExecutionMode: v.optional(OmniExecutionModeSchema),
  omniVoiceId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(128))),
})

export type SaveProviderConfigInput = v.InferOutput<typeof SaveProviderConfigInputSchema>

export const TestProviderInputSchema = v.object({
  providerId: LlmProviderIdSchema,
  baseUrl: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(512))),
  modelId: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256))),
  reasoningEffort: v.optional(ReasoningEffortSchema),
  apiKey: v.optional(v.string()),
})

export type TestProviderInput = v.InferOutput<typeof TestProviderInputSchema>

export const ProviderModelCatalogItemSchema = v.object({
  id: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256)),
  name: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256)),
  providerId: LlmProviderIdSchema,
  contextLength: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0)))),
  supportsTools: v.optional(v.boolean()),
  supportsReasoning: v.optional(v.boolean()),
  isOmniModel: v.optional(v.boolean()),
  inputModalities: v.optional(v.array(OmniModalityKindSchema)),
  outputModalities: v.optional(v.array(OmniModalityKindSchema)),
  supportsOmniAudioIn: v.optional(v.boolean()),
  supportsOmniAudioOut: v.optional(v.boolean()),
  supportsOmniVideoIn: v.optional(v.boolean()),
  omniExecutionMode: v.optional(OmniExecutionModeSchema),
  omniVoiceId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(128))),
})

export type ProviderModelCatalogItem = v.InferOutput<typeof ProviderModelCatalogItemSchema>

export const ListProviderModelsInputSchema = v.object({
  providerId: LlmProviderIdSchema,
  baseUrl: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(512))),
  apiKey: v.optional(v.string()),
})

export type ListProviderModelsInput = v.InferOutput<typeof ListProviderModelsInputSchema>

export const ListProviderModelsResultSchema = v.object({
  providerId: LlmProviderIdSchema,
  models: v.array(ProviderModelCatalogItemSchema),
  source: v.picklist(['remote', 'fallback'] as const),
  fetchedAt: TimestampSchema,
  error: v.optional(v.nullable(v.string()), null),
})

export type ListProviderModelsResult = v.InferOutput<typeof ListProviderModelsResultSchema>

export const ASHY_HOST_RPC_METHODS = [
  'getBootstrapSnapshot',
  'completeOnboarding',
  'createSession',
  'selectSession',
  'sendTurn',
  'abortTurn',
  'saveProviderConfig',
  'setActiveProvider',
  'testProviderConnection',
  'listProviderModels',
  'saveVoiceIdentity',
  'resetVoiceIdentity',
  'upsertSemanticFact',
  'upsertEpisodicMemory',
  'upsertMilestone',
  'upsertRelationalMotif',
  'upsertProspectiveIntent',
  'recordEmotionPulse',
  'persistDreamConsolidation',
  'persistTraitRevert',
  'deleteMemoryItem',
  'consolidateSessionMemories',
  'approveMemoryItem',
  'setMemoryGovernancePolicy',
  'seedDemoFixtures',
  'runCoreExperimentEval',
  'runDreamReflection',
  'revertTraitEvolution',
  'getAgencySnapshot',
  'callMcpTool',
  'approvePendingAction',
  'denyPendingAction',
  'updateAgencyConsent',
  'revokeSessionPermissions',
  'captureAuthorizedScreen',
  'registerExternalMcpServer',
  'updateMilestone',
  'updateInitiativePolicy',
  'evaluateAttentionInitiative',
  'updateStagePreferences',
  'getVoiceRuntimeSettings',
  'saveVoiceRuntimeSettings',
  'listVoiceProviderModels',
  'transcribeVoiceAudio',
  'synthesizeVoiceSpeech',
  'exportSoul',
  'importSoul',
  'wipeAllData',
  'setEncryptionAtRest',
  'getEncryptionAtRestStatus',
  'activatePrivacyShield',
  'getUpdateState',
  'checkForUpdates',
  'downloadUpdate',
  'quitAndInstallUpdate',
  'localRuntime:getStatus',
  'localRuntime:ensureRunning',
  'localRuntime:installEngine',
  'localRuntime:pullModel',
  'localRuntime:deleteModel',
  'getLocalRuntimeStatus',
  'ensureLocalEngineRunning',
  'installLocalEngine',
  'pullLocalModel',
  'deleteLocalModel',
] as const

export type AshyHostRpcMethod = (typeof ASHY_HOST_RPC_METHODS)[number]
export const AshyHostRpcMethodSchema = v.picklist(ASHY_HOST_RPC_METHODS)

export const HostRpcRequestSchema = v.object({
  method: AshyHostRpcMethodSchema,
  payload: v.optional(v.unknown()),
})
export type HostRpcRequest = v.InferOutput<typeof HostRpcRequestSchema>

export const TurnInputAudioSchema = v.object({
  dataBase64: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty(),
    v.maxLength(8_000_000),
    v.check(
      (val) =>
        /^(?:data:audio\/(?:wav|x-wav|pcm|mp3|mpeg);base64,)?[A-Za-z0-9+/=_-]+$/.test(val),
      'Invalid audio base64 payload',
    ),
  ),
  format: v.picklist(['wav', 'pcm16'] as const),
  sampleRate: v.optional(v.pipe(v.number(), v.finite(), v.minValue(8000), v.maxValue(96000))),
  durationMs: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  transcriptHint: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
})
export type TurnInputAudio = v.InferOutput<typeof TurnInputAudioSchema>

export const TurnVideoFrameSchema = v.object({
  dataUrl: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty(),
    v.maxLength(1_500_000),
    v.check(
      (val) => /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(val),
      'Video frame must be a base64 image data URL',
    ),
  ),
  timestampMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
  width: v.optional(v.pipe(v.number(), v.finite(), v.minValue(1), v.maxValue(8192))),
  height: v.optional(v.pipe(v.number(), v.finite(), v.minValue(1), v.maxValue(8192))),
  source: v.optional(v.picklist(['screen', 'camera', 'clip'] as const)),
  dHashHex: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
})
export type TurnVideoFrame = v.InferOutput<typeof TurnVideoFrameSchema>

export const TurnAttachmentSchema = v.object({
  id: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(128))),
  kind: v.picklist(['image', 'audio', 'video'] as const),
  mimeType: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(128)),
  dataUrlOrBase64: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty(),
    v.maxLength(8_000_000),
    v.check(
      (val) =>
        !/^(?:https?|file|ftp|javascript|ws|wss):/i.test(val) &&
        /^(?:data:(?:image|audio|video)\/[a-z0-9.+-]+;base64,)?[A-Za-z0-9+/=_-]+$/.test(val),
      'Attachment must be base64 or data URL; external/file URLs are forbidden',
    ),
  ),
  name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(256))),
  width: v.optional(v.pipe(v.number(), v.finite(), v.minValue(1), v.maxValue(8192))),
  height: v.optional(v.pipe(v.number(), v.finite(), v.minValue(1), v.maxValue(8192))),
  durationMs: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
})
export type TurnAttachment = v.InferOutput<typeof TurnAttachmentSchema>

export const SendTurnInputSchema = v.pipe(
  v.object({
    sessionId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
    text: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(16000)), ''),
    screenContext: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(512))),
    interruptionControlNote: v.optional(
      v.pipe(v.string(), v.trim(), v.maxLength(1024)),
    ),
    inputAudio: v.optional(TurnInputAudioSchema),
    videoFrames: v.optional(v.pipe(v.array(TurnVideoFrameSchema), v.maxLength(16))),
    attachments: v.optional(v.pipe(v.array(TurnAttachmentSchema), v.maxLength(8))),
    omniExecutionModeOverride: v.optional(OmniExecutionModeSchema),
  }),
  v.check(
    (input) =>
      (input.text?.trim().length ?? 0) > 0 ||
      input.inputAudio !== undefined ||
      (input.videoFrames !== undefined && input.videoFrames.length > 0) ||
      (input.attachments !== undefined && input.attachments.length > 0),
    'SendTurnInput requires non-empty text, inputAudio, videoFrames, or attachments',
  ),
)

export type SendTurnInput = v.InferOutput<typeof SendTurnInputSchema>

export interface UpsertFactInput {
  id?: string
  category: SemanticFactCategory
  subject: string
  predicate: string
  object: string
  confidence?: number
}

export const TurnInputTranscriptEventSchema = v.object({
  type: v.literal('turn:input-transcript'),
  turnId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  userMessageId: NonEmptyStringSchema,
  transcript: v.string(),
  isFinal: v.boolean(),
  source: v.picklist(['omni-native', 'stt-preflight', 'wav-metadata'] as const),
})

export const TurnAudioDeltaEventSchema = v.object({
  type: v.literal('turn:audio-delta'),
  turnId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  seq: NonNegativeIntSchema,
  audioBase64: NonEmptyStringSchema,
  format: v.picklist(['pcm16', 'wav'] as const),
  sampleRate: v.pipe(v.number(), v.finite(), v.minValue(8000)),
  durationMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
  transcriptDelta: v.optional(v.string()),
  vowelFrames: v.optional(v.array(VoiceSynthesizedVowelFrameSchema)),
})

export const AshyHostStreamEventSchema = v.union([
  v.object({
    type: v.literal('turn:started'),
    turnId: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    startedAt: TimestampSchema,
  }),
  v.object({
    type: v.literal('turn:delta'),
    turnId: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    textDelta: v.string(),
  }),
  TurnInputTranscriptEventSchema,
  TurnAudioDeltaEventSchema,
  v.object({
    type: v.literal('turn:marker'),
    turnId: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    marker: v.union([
      v.object({
        type: v.literal('act'),
        emotion: v.optional(AshyEmotionSchema),
        intensity: v.optional(v.number()),
        motion: v.optional(v.string()),
        durationSec: v.optional(v.number()),
      }),
      v.object({
        type: v.literal('delay'),
        seconds: v.number(),
      }),
      v.object({
        type: v.literal('callback'),
        motifId: NonEmptyStringSchema,
      }),
    ]),
  }),
  v.object({
    type: v.literal('turn:keepalive'),
    turnId: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    elapsedMs: v.number(),
  }),
  v.object({
    type: v.literal('turn:completed'),
    turnId: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    assistantMessage: v.any(),
    snapshot: v.any(),
    persistenceWarning: v.nullable(v.string()),
  }),
  v.object({
    type: v.literal('turn:aborted'),
    turnId: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    partialText: v.string(),
  }),
  v.object({
    type: v.literal('turn:error'),
    turnId: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    code: v.picklist(['PROVIDER_NOT_CONFIGURED', 'LLM_REQUEST_FAILED', 'INTERNAL_ERROR'] as const),
    message: v.string(),
    recoverable: v.boolean(),
  }),
  v.object({
    type: v.literal('stage:updated'),
    stagePreferences: PersistedStagePreferencesSchema,
  }),
  v.object({
    type: v.literal('shortcut:triggered'),
    action: v.picklist([
      'toggleMic',
      'toggleEyes',
      'toggleDnd',
      'toggleHideStage',
      'togglePtt',
      'activatePrivacyShield',
    ] as const),
  }),
  v.object({
    type: v.literal('updater:status'),
    state: AutoUpdaterStateSchema,
  }),
  v.object({
    type: v.literal('local-runtime:status'),
    status: LocalRuntimeStatusSchema,
  }),
])

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
      type: 'turn:input-transcript'
      turnId: string
      sessionId: string
      userMessageId: string
      transcript: string
      isFinal: boolean
      source: 'omni-native' | 'stt-preflight' | 'wav-metadata'
    }
  | {
      type: 'turn:audio-delta'
      turnId: string
      sessionId: string
      seq: number
      audioBase64: string
      format: 'pcm16' | 'wav'
      sampleRate: number
      durationMs: number
      transcriptDelta?: string
      vowelFrames?: VoiceSynthesizedVowelFrame[]
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
  | {
      type: 'stage:updated'
      stagePreferences: PersistedStagePreferences
    }
  | {
      type: 'shortcut:triggered'
      action:
        | 'toggleMic'
        | 'toggleEyes'
        | 'toggleDnd'
        | 'toggleHideStage'
        | 'togglePtt'
        | 'activatePrivacyShield'
    }
  | {
      type: 'updater:status'
      state: AutoUpdaterState
    }
  | {
      type: 'local-runtime:status'
      status: LocalRuntimeStatus
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
  listProviderModels(input: ListProviderModelsInput): Promise<ListProviderModelsResult>
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
  updateStagePreferences?(input: UpdateStagePreferencesInput): Promise<PersistedStagePreferences>
  getVoiceRuntimeSettings?(): Promise<VoiceRuntimeSettings>
  saveVoiceRuntimeSettings?(
    input: SaveVoiceRuntimeSettingsInput,
  ): Promise<VoiceRuntimeSettings>
  listVoiceProviderModels?(
    input: ListVoiceProviderModelsInput,
  ): Promise<VoiceProviderModelsCatalog>
  transcribeVoiceAudio?(
    input: TranscribeVoiceAudioInput,
  ): Promise<VoiceTranscribeAudioResult>
  synthesizeVoiceSpeech?(
    input: SynthesizeVoiceSpeechInput,
  ): Promise<VoiceSynthesizeSpeechResult>
  exportSoul?(input?: ExportSoulInput): Promise<AshySoulArchive>
  importSoul?(input: ImportSoulInput): Promise<HostBootstrapSnapshot>
  wipeAllData?(): Promise<HostBootstrapSnapshot>
  setEncryptionAtRest?(input: SetEncryptionAtRestInput): Promise<HostBootstrapSnapshot>
  getEncryptionAtRestStatus?(): Promise<EncryptionAtRestStatus>
  activatePrivacyShield?(): Promise<HostBootstrapSnapshot>
  getUpdateState?(): Promise<AutoUpdaterState>
  checkForUpdates?(): Promise<AutoUpdaterState>
  downloadUpdate?(): Promise<AutoUpdaterState>
  quitAndInstallUpdate?(): Promise<{ ok: boolean }>
  getLocalRuntimeStatus?(): Promise<LocalRuntimeStatus>
  ensureLocalEngineRunning?(): Promise<LocalRuntimeStatus>
  installLocalEngine?(): Promise<LocalRuntimeStatus>
  pullLocalModel?(input: PullLocalModelInput): Promise<LocalRuntimeStatus>
  deleteLocalModel?(input: DeleteLocalModelInput): Promise<LocalRuntimeStatus>
  onHostEvent(listener: (event: AshyHostStreamEvent) => void): () => void
}

export type AshyHostKernelApi = AshyHostBridge

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
    reasoningEffort: ReasoningEffort
    requiresApiKey: boolean
  }
> = {
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelId: 'anthropic/claude-3.7-sonnet',
    reasoningEffort: 'none',
    requiresApiKey: true,
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    modelId: 'claude-3-7-sonnet-latest',
    reasoningEffort: 'none',
    requiresApiKey: true,
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'gpt-4o-mini',
    reasoningEffort: 'none',
    requiresApiKey: true,
  },
  'nvidia-nim': {
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    modelId: 'meta/llama-3.3-70b-instruct',
    reasoningEffort: 'none',
    requiresApiKey: true,
  },
  ollama: {
    label: 'Ollama (Local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelId: 'qwen2.5:14b',
    reasoningEffort: 'none',
    requiresApiKey: false,
  },
}

export interface ModelOmniCapabilities {
  isOmniModel: boolean
  supportsOmniAudioIn: boolean
  supportsOmniAudioOut: boolean
  supportsOmniVideoIn: boolean
  inputModalities: OmniModalityKind[]
  outputModalities: OmniModalityKind[]
}

export function inferModelOmniCapabilities(
  _providerId: LlmProviderId,
  modelId: string,
): ModelOmniCapabilities {
  const lower = (modelId ?? '').trim().toLowerCase()

  // LFM3-Audio / LFM2-Audio (audio + text without video)
  if (/lfm[23][-_]?audio/i.test(lower)) {
    return {
      isOmniModel: true,
      supportsOmniAudioIn: true,
      supportsOmniAudioOut: true,
      supportsOmniVideoIn: false,
      inputModalities: ['text', 'audio'],
      outputModalities: ['text', 'audio'],
    }
  }

  // Full Native Omni models (LFM3-Omni, Qwen 2.5 Omni, GPT-4o Audio / Realtime)
  if (
    /lfm3[-_]?omni/i.test(lower) ||
    /qwen(?:2\.5)?[-_]?omni/i.test(lower) ||
    /gpt-4o(?:-\d{4}-\d{2}-\d{2})?-(?:mini-)?(?:audio|realtime)/i.test(lower)
  ) {
    return {
      isOmniModel: true,
      supportsOmniAudioIn: true,
      supportsOmniAudioOut: true,
      supportsOmniVideoIn: true,
      inputModalities: ['text', 'audio', 'image', 'video'],
      outputModalities: ['text', 'audio'],
    }
  }

  // Gemini 2.0 / 2.5 models (Multimodal Audio+Video+Image+Text In -> Text Out via REST)
  if (/gemini-2\.[05]/i.test(lower)) {
    return {
      isOmniModel: true,
      supportsOmniAudioIn: true,
      supportsOmniAudioOut: false,
      supportsOmniVideoIn: true,
      inputModalities: ['text', 'audio', 'image', 'video'],
      outputModalities: ['text'],
    }
  }

  return {
    isOmniModel: false,
    supportsOmniAudioIn: false,
    supportsOmniAudioOut: false,
    supportsOmniVideoIn: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
  }
}

export const FALLBACK_PROVIDER_MODELS: Record<LlmProviderId, ProviderModelCatalogItem[]> = {
  openrouter: [
    {
      id: 'qwen/qwen3.8-flash',
      name: 'Qwen 3.8 Flash',
      providerId: 'openrouter',
      contextLength: 131072,
      supportsTools: true,
      supportsReasoning: true,
    },
    {
      id: 'anthropic/claude-3.7-sonnet',
      name: 'Claude 3.7 Sonnet',
      providerId: 'openrouter',
      contextLength: 200000,
      supportsTools: true,
      supportsReasoning: true,
    },
    {
      id: 'deepseek/deepseek-chat-v3-0324',
      name: 'DeepSeek Chat V3 (0324)',
      providerId: 'openrouter',
      contextLength: 128000,
      supportsTools: true,
      supportsReasoning: false,
    },
    {
      id: 'google/gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      providerId: 'openrouter',
      contextLength: 1048576,
      supportsTools: true,
      supportsReasoning: true,
      isOmniModel: true,
      supportsOmniAudioIn: true,
      supportsOmniAudioOut: false,
      supportsOmniVideoIn: true,
      inputModalities: ['text', 'audio', 'image', 'video'],
      outputModalities: ['text'],
      omniExecutionMode: 'hybrid-omni-in',
    },
    {
      id: 'openai/gpt-4.1',
      name: 'GPT-4.1',
      providerId: 'openrouter',
      contextLength: 1047576,
      supportsTools: true,
      supportsReasoning: false,
    },
    {
      id: 'meta/llama-3.3-70b-instruct',
      name: 'Llama 3.3 70B Instruct',
      providerId: 'openrouter',
      contextLength: 131072,
      supportsTools: true,
      supportsReasoning: false,
    },
    {
      id: 'qwen/qwen2.5-omni-7b',
      name: 'Qwen 2.5 Omni 7B',
      providerId: 'openrouter',
      contextLength: 32768,
      supportsTools: true,
      supportsReasoning: false,
      isOmniModel: true,
      supportsOmniAudioIn: true,
      supportsOmniAudioOut: true,
      supportsOmniVideoIn: true,
      inputModalities: ['text', 'audio', 'image', 'video'],
      outputModalities: ['text', 'audio'],
      omniExecutionMode: 'native-omni',
      omniVoiceId: 'Cherry',
    },
    {
      id: 'openai/gpt-4o-audio-preview',
      name: 'OpenAI: GPT-4o Audio Preview',
      providerId: 'openrouter',
      contextLength: 128000,
      supportsTools: true,
      supportsReasoning: false,
      isOmniModel: true,
      supportsOmniAudioIn: true,
      supportsOmniAudioOut: true,
      supportsOmniVideoIn: true,
      inputModalities: ['text', 'audio', 'image', 'video'],
      outputModalities: ['text', 'audio'],
      omniExecutionMode: 'native-omni',
      omniVoiceId: 'coral',
    },
  ],
  anthropic: [
    {
      id: 'claude-3-7-sonnet-latest',
      name: 'Claude 3.7 Sonnet (Latest)',
      providerId: 'anthropic',
      contextLength: 200000,
      supportsTools: true,
      supportsReasoning: true,
    },
    {
      id: 'claude-3-5-sonnet-latest',
      name: 'Claude 3.5 Sonnet (Latest)',
      providerId: 'anthropic',
      contextLength: 200000,
      supportsTools: true,
      supportsReasoning: false,
    },
    {
      id: 'claude-3-5-haiku-latest',
      name: 'Claude 3.5 Haiku (Latest)',
      providerId: 'anthropic',
      contextLength: 200000,
      supportsTools: true,
      supportsReasoning: false,
    },
  ],
  openai: [
    {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      providerId: 'openai',
      contextLength: 1047576,
      supportsTools: true,
      supportsReasoning: false,
    },
    {
      id: 'gpt-4.1-mini',
      name: 'GPT-4.1 Mini',
      providerId: 'openai',
      contextLength: 1047576,
      supportsTools: true,
      supportsReasoning: false,
    },
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      providerId: 'openai',
      contextLength: 128000,
      supportsTools: true,
      supportsReasoning: false,
    },
    {
      id: 'gpt-4o-mini',
      name: 'GPT-4o Mini',
      providerId: 'openai',
      contextLength: 128000,
      supportsTools: true,
      supportsReasoning: false,
    },
    {
      id: 'o3-mini',
      name: 'o3-mini',
      providerId: 'openai',
      contextLength: 200000,
      supportsTools: true,
      supportsReasoning: true,
    },
    {
      id: 'gpt-4o-audio-preview',
      name: 'GPT-4o Audio Preview (Omni)',
      providerId: 'openai',
      contextLength: 128000,
      supportsTools: true,
      supportsReasoning: false,
      isOmniModel: true,
      supportsOmniAudioIn: true,
      supportsOmniAudioOut: true,
      supportsOmniVideoIn: true,
      inputModalities: ['text', 'audio', 'image', 'video'],
      outputModalities: ['text', 'audio'],
      omniExecutionMode: 'native-omni',
      omniVoiceId: 'coral',
    },
    {
      id: 'gpt-4o-mini-audio-preview',
      name: 'GPT-4o Mini Audio Preview (Omni)',
      providerId: 'openai',
      contextLength: 128000,
      supportsTools: true,
      supportsReasoning: false,
      isOmniModel: true,
      supportsOmniAudioIn: true,
      supportsOmniAudioOut: true,
      supportsOmniVideoIn: true,
      inputModalities: ['text', 'audio', 'image', 'video'],
      outputModalities: ['text', 'audio'],
      omniExecutionMode: 'native-omni',
      omniVoiceId: 'coral',
    },
  ],
  'nvidia-nim': [
    {
      id: 'meta/llama-3.3-70b-instruct',
      name: 'Llama 3.3 70B Instruct',
      providerId: 'nvidia-nim',
      contextLength: 128000,
      supportsTools: true,
      supportsReasoning: false,
    },
    {
      id: 'deepseek-ai/deepseek-r1',
      name: 'DeepSeek R1',
      providerId: 'nvidia-nim',
      contextLength: 128000,
      supportsTools: false,
      supportsReasoning: true,
    },
    {
      id: 'qwen/qwen2.5-coder-32b-instruct',
      name: 'Qwen 2.5 Coder 32B Instruct',
      providerId: 'nvidia-nim',
      contextLength: 32768,
      supportsTools: true,
      supportsReasoning: false,
    },
  ],
  ollama: [
    {
      id: 'qwen2.5:14b',
      name: 'qwen2.5:14b',
      providerId: 'ollama',
      contextLength: 32768,
      supportsTools: true,
      supportsReasoning: false,
    },
    {
      id: 'qwen3:8b',
      name: 'qwen3:8b',
      providerId: 'ollama',
      contextLength: 32768,
      supportsTools: true,
      supportsReasoning: true,
    },
    {
      id: 'llama3.2:latest',
      name: 'llama3.2:latest',
      providerId: 'ollama',
      contextLength: 128000,
      supportsTools: true,
      supportsReasoning: false,
    },
    {
      id: 'deepseek-r1:8b',
      name: 'deepseek-r1:8b',
      providerId: 'ollama',
      contextLength: 65536,
      supportsTools: false,
      supportsReasoning: true,
    },
    {
      id: 'lfm3-omni:2b',
      name: 'Liquid AI LFM3-Omni 2B (Local Omni)',
      providerId: 'ollama',
      contextLength: 32768,
      supportsTools: true,
      supportsReasoning: false,
      isOmniModel: true,
      supportsOmniAudioIn: true,
      supportsOmniAudioOut: true,
      supportsOmniVideoIn: true,
      inputModalities: ['text', 'audio', 'image', 'video'],
      outputModalities: ['text', 'audio'],
      omniExecutionMode: 'native-omni',
      omniVoiceId: 'female',
    },
    {
      id: 'LiquidAI/LFM3-Omni-2B-GGUF',
      name: 'LiquidAI/LFM3-Omni-2B-GGUF (llama-server)',
      providerId: 'ollama',
      contextLength: 32768,
      supportsTools: true,
      supportsReasoning: false,
      isOmniModel: true,
      supportsOmniAudioIn: true,
      supportsOmniAudioOut: true,
      supportsOmniVideoIn: true,
      inputModalities: ['text', 'audio', 'image', 'video'],
      outputModalities: ['text', 'audio'],
      omniExecutionMode: 'native-omni',
      omniVoiceId: 'female',
    },
    {
      id: 'qwen2.5-omni:7b',
      name: 'Qwen 2.5 Omni 7B (Local Omni)',
      providerId: 'ollama',
      contextLength: 32768,
      supportsTools: true,
      supportsReasoning: false,
      isOmniModel: true,
      supportsOmniAudioIn: true,
      supportsOmniAudioOut: true,
      supportsOmniVideoIn: true,
      inputModalities: ['text', 'audio', 'image', 'video'],
      outputModalities: ['text', 'audio'],
      omniExecutionMode: 'native-omni',
      omniVoiceId: 'Cherry',
    },
  ],
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
