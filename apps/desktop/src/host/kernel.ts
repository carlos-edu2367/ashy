import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as v from 'valibot'
import { createContainer, type DIContainer } from '@ashy/bus'
import { createAshyCortex, type AshyCortex } from '@ashy/cortex'
import { runCoreExperimentM2 } from '@ashy/evals'
import { generateText } from '@ashy/llm'
import {
  AshySoulArchiveSchema,
  canonicalizeJson,
  CompleteOnboardingInputSchema,
  CURRENT_SOUL_SCHEMA_VERSION,
  DEFAULT_PERSISTED_AGENCY_CONSENT_STATE,
  DEFAULT_PERSISTED_STAGE_PREFERENCES,
  DEFAULT_VOICE_RUNTIME_SETTINGS,
  EvaluateInitiativeInputSchema,
  ExportSoulInputSchema,
  ImportSoulInputSchema,
  ListVoiceProviderModelsInputSchema,
  maskApiKey,
  PersistedStagePreferencesSchema,
  RunCoreExperimentInputSchema,
  safeJsonParseWithoutProto,
  SaveVoiceRuntimeSettingsInputSchema,
  SetEncryptionAtRestInputSchema,
  SynthesizeVoiceSpeechInputSchema,
  TranscribeVoiceAudioInputSchema,
  UpdateInitiativePolicyInputSchema,
  UpdateMilestoneInputSchema,
  UpdateStagePreferencesInputSchema,
  type AgencySnapshot,
  type ApprovalScope,
  type ApprovableMemoryKind,
  type AshyBootstrapSnapshot,
  type AshyEmotion,
  type AshyHostBridge,
  type AshyHostStreamEvent,
  type AshySoulArchive,
  type AshySoulBundlePayload,
  type AutobiographicalMilestone,
  type AutoUpdaterState,
  type ChatMessageRecord,
  type ChatSessionRecord,
  type CompleteOnboardingInput,
  type CoreExperimentEvalReport,
  type DeletableMemoryKind,
  type DreamReflectionCycleResult,
  type EncryptionAtRestStatus,
  type EpisodicMemory,
  type EvaluateInitiativeInput,
  type ExportSoulInput,
  type ExternalMcpServerConfig,
  type ImportSoulInput,
  type InitiativePolicy,
  type ListProviderModelsInput,
  type ListProviderModelsResult,
  type ListVoiceProviderModelsInput,
  type LlmProviderId,
  type MemoryGovernanceCategory,
  type MemoryGovernancePolicy,
  type PersistedStagePreferences,
  type PersonalityEvolutionRecord,
  type PersonalityTraits,
  type ProactiveInitiativeRecord,
  type ProspectiveIntent,
  type ProviderHealthResult,
  type PublicProviderConfig,
  type RelationalMotif,
  type RelationshipStage,
  type RunCoreExperimentInput,
  type SaveProviderConfigInput,
  type SaveVoiceRuntimeSettingsInput,
  type SemanticFact,
  type SendTurnInput,
  type SetEncryptionAtRestInput,
  type SharedPendingActionCard,
  type SttProviderId,
  type SynthesizeVoiceSpeechInput,
  type TestProviderInput,
  type TranscribeVoiceAudioInput,
  type TtsProviderId,
  type UpdateAgencyConsentInput,
  type UpdateInitiativePolicyInput,
  type UpdateMilestoneInput,
  type UpdateStagePreferencesInput,
  type UpsertFactInput,
  type VisionObservationResult,
  type VoiceProviderModelOption,
  type VoiceProviderModelsCatalog,
  type VoiceRuntimeSettings,
  type VoiceSynthesizedVowelFrame,
  type VoiceSynthesizeSpeechResult,
  type VoiceTranscribeAudioResult,
} from '@ashy/shared'
import {
  createDeterministicWavSttProvider,
  createElevenLabsTtsProvider,
  createGroqWhisperSttProvider,
  createLocalKokoroHttpTtsProvider,
  createLocalSynthFallbackTtsProvider,
  createLocalWhisperHttpSttProvider,
  createOpenAiTtsProvider,
  createOpenAiWhisperSttProvider,
  decodeWavToPcmBlocks,
  encodeWavPcm16,
} from '@ashy/voice'
import { seedAshyDemoFixtures } from '../test/fixtures/demo-seed'
import { createHostAgencyRuntime, type HostAgencyRuntime } from './agency-runtime'
import { removeFileAtomicWithBackups, writeAtomicWithBackup } from './atomic-file'
import { createProviderVault, type ProviderVault } from './provider-vault'
import { createNodeAesSecretProtector, type SecretProtector } from './secret-protector'
import { createTurnOrchestrator, type TurnOrchestrator } from './turn-orchestrator'
import { createVoiceIdentityStore, type VoiceIdentityStore } from './voice-identity-store'

export const DEFAULT_DREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const MAX_TTS_BINARY_RESPONSE_BYTES = 15 * 1024 * 1024
const VOICE_HTTP_TIMEOUT_MS = 15_000

interface StoredVoiceSettingsDocument extends VoiceRuntimeSettings {
  encryptedOpenAiApiKey?: string
  encryptedGroqApiKey?: string
  encryptedElevenLabsApiKey?: string
  encryptedLocalSttApiKey?: string
  encryptedLocalTtsApiKey?: string
}

const FALLBACK_VOICE_MODEL_CATALOG: Record<
  SttProviderId | TtsProviderId,
  { models: VoiceProviderModelOption[]; voices?: VoiceProviderModelOption[] }
> = {
  'openai-whisper': {
    models: [
      { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe' },
      { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
      { id: 'whisper-1', label: 'Whisper v2 (whisper-1)' },
    ],
  },
  'groq-whisper': {
    models: [
      { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo (Groq)' },
      { id: 'whisper-large-v3', label: 'Whisper Large v3 (Groq)' },
      { id: 'distil-whisper-large-v3-en', label: 'Distil Whisper Large v3 (EN)' },
    ],
  },
  'local-whisper-http': {
    models: [
      { id: 'whisper-1', label: 'Whisper Local (Compatível OpenAI)' },
      { id: 'Systran/faster-whisper-small', label: 'Faster-Whisper Small' },
      { id: 'Systran/faster-whisper-large-v3-turbo', label: 'Faster-Whisper Large v3 Turbo' },
      { id: 'ggml-base.bin', label: 'whisper.cpp (ggml-base.bin)' },
    ],
  },
  'web-speech-stt': {
    models: [
      { id: 'browser-native-pt-BR', label: 'Web Speech API (pt-BR Nativo)' },
      { id: 'browser-native-en-US', label: 'Web Speech API (en-US Nativo)' },
    ],
  },
  'deterministic-wav-stt': {
    models: [{ id: 'deterministic-v1', label: 'Diagnóstico Determinístico (.wav)' }],
  },
  elevenlabs: {
    models: [
      { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5 (Baixa Latência)' },
      { id: 'eleven_multilingual_v2', label: 'Eleven Multilingual v2' },
      { id: 'eleven_turbo_v2_5', label: 'Eleven Turbo v2.5' },
    ],
    voices: [
      { id: 'ashy-pt-br', label: 'Ashy Studio (pt-BR)' },
      { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel' },
      { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah' },
    ],
  },
  'openai-tts': {
    models: [
      { id: 'gpt-4o-mini-tts', label: 'GPT-4o Mini TTS' },
      { id: 'tts-1', label: 'TTS-1 (Baixa Latência)' },
      { id: 'tts-1-hd', label: 'TTS-1 HD' },
    ],
    voices: [
      { id: 'nova', label: 'Nova' },
      { id: 'alloy', label: 'Alloy' },
      { id: 'shimmer', label: 'Shimmer' },
      { id: 'coral', label: 'Coral' },
      { id: 'sage', label: 'Sage' },
    ],
  },
  'local-kokoro-http': {
    models: [
      { id: 'kokoro-v1', label: 'Kokoro 82M v1.0 (Local)' },
      { id: 'tts-1', label: 'Compatível OpenAI Local (tts-1)' },
    ],
    voices: [
      { id: 'pf_dora', label: 'Dora (pt-BR Feminina)' },
      { id: 'pm_alex', label: 'Alex (pt-BR Masculino)' },
      { id: 'af_heart', label: 'Heart (Multilíngue)' },
      { id: 'af_bella', label: 'Bella (Multilíngue)' },
      { id: 'ashy-pt-br', label: 'Ashy Default (pt-BR)' },
    ],
  },
  'web-speech-tts': {
    models: [{ id: 'browser-speech-synthesis', label: 'Web Speech Synthesis (Nativo)' }],
    voices: [{ id: 'pt-BR', label: 'Voz do Sistema (pt-BR)' }],
  },
  'local-synth-fallback': {
    models: [{ id: 'synth-harmonic-16k', label: 'Sintetizador Harmônico Local (16kHz)' }],
    voices: [{ id: 'ashy-pt-br', label: 'Ashy Harmônica (Diagnóstico)' }],
  },
}

function extractUrlOrigin(rawUrl: string): string | null {
  try {
    return new URL(rawUrl.trim()).origin.toLowerCase()
  } catch {
    return null
  }
}

export function validateVoiceEndpointUrl(rawUrl: string, providerId?: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new Error(`Invalid voice endpoint URL: ${rawUrl}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported voice endpoint protocol: ${parsed.protocol}`)
  }

  if (parsed.username || parsed.password) {
    throw new Error('SSRF/Security violation: Voice endpoint URL cannot contain embedded credentials')
  }

  const cleanHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    cleanHost === '0.0.0.0' ||
    cleanHost === '::' ||
    cleanHost === '0:0:0:0:0:0:0:0' ||
    cleanHost.startsWith('169.254.') ||
    cleanHost.startsWith('fe80:') ||
    cleanHost.startsWith('::ffff:169.254.') ||
    cleanHost === 'metadata.google.internal' ||
    cleanHost === 'metadata' ||
    cleanHost === '100.100.100.200'
  ) {
    throw new Error(`SSRF protection blocked forbidden voice host: ${parsed.hostname}`)
  }

  const origin = parsed.origin.toLowerCase()
  if (providerId === 'openai-whisper' || providerId === 'openai-tts') {
    if (origin !== 'https://api.openai.com') {
      throw new Error(
        `Origin pinning violation for ${providerId}: expected https://api.openai.com, got ${parsed.origin}`,
      )
    }
  } else if (providerId === 'groq-whisper') {
    if (origin !== 'https://api.groq.com') {
      throw new Error(
        `Origin pinning violation for ${providerId}: expected https://api.groq.com, got ${parsed.origin}`,
      )
    }
  } else if (providerId === 'elevenlabs') {
    if (origin !== 'https://api.elevenlabs.io') {
      throw new Error(
        `Origin pinning violation for ${providerId}: expected https://api.elevenlabs.io, got ${parsed.origin}`,
      )
    }
  }

  return parsed
}

export interface AshyHostKernelOptions {
  userDataDir: string
  secretProtector?: SecretProtector
  fetchImpl?: typeof fetch
  keepaliveIntervalMs?: number
  dreamIdleTimeoutMs?: number
}

export interface AshyHostKernel extends AshyHostBridge {
  readonly userDataDir: string
  readonly container: DIContainer
  readonly cortex: AshyCortex
  readonly voiceStore: VoiceIdentityStore
  readonly providerVault: ProviderVault
  readonly agencyRuntime: HostAgencyRuntime
  readonly turnOrchestrator: TurnOrchestrator
  emitHostEvent?(event: AshyHostStreamEvent): void
  start(): Promise<void>
  stop(): Promise<void>
  exportSoul(input?: ExportSoulInput): Promise<AshySoulArchive>
  importSoul(input: ImportSoulInput): Promise<AshyBootstrapSnapshot>
  wipeAllData(): Promise<AshyBootstrapSnapshot>
  setEncryptionAtRest(input: SetEncryptionAtRestInput): Promise<AshyBootstrapSnapshot>
  getEncryptionAtRestStatus(): Promise<EncryptionAtRestStatus>
  activatePrivacyShield(): Promise<AshyBootstrapSnapshot>
  getUpdateState(): Promise<AutoUpdaterState>
  checkForUpdates(): Promise<AutoUpdaterState>
  downloadUpdate(): Promise<AutoUpdaterState>
  quitAndInstallUpdate(): Promise<{ ok: boolean }>
}

function deriveRelationshipMetrics(params: {
  totalTurns: number
  milestonesCount: number
  episodesCount: number
  hasEstablishedJoke: boolean
}): {
  stage: RelationshipStage
  familiarityScore: number
  trustScore: number
} {
  const { totalTurns, milestonesCount, episodesCount, hasEstablishedJoke } = params

  const familiarityScore = Math.min(
    1,
    Number((totalTurns * 0.05 + episodesCount * 0.05 + (hasEstablishedJoke ? 0.15 : 0)).toFixed(3)),
  )
  const trustScore = Math.min(
    1,
    Number((0.1 + totalTurns * 0.03 + Math.max(0, milestonesCount - 1) * 0.06).toFixed(3)),
  )

  let stage: RelationshipStage = 'stranger'
  if (totalTurns >= 40 || milestonesCount >= 5) {
    stage = 'companion'
  } else if (totalTurns >= 15 || hasEstablishedJoke) {
    stage = 'close_friend'
  } else if (totalTurns >= 3 || episodesCount >= 2) {
    stage = 'acquaintance'
  }

  return {
    stage,
    familiarityScore,
    trustScore,
  }
}

export async function createAshyHostKernel(
  options: AshyHostKernelOptions,
): Promise<AshyHostKernel> {
  fs.mkdirSync(options.userDataDir, { recursive: true })

  let activeSessionId = 'session-initial'
  let dominantEmotion: AshyEmotion = 'neutral'
  let lastPersistenceWarning: string | null = null
  let lastEvalReport: CoreExperimentEvalReport | null = null
  let evalLock: Promise<unknown> = Promise.resolve()
  let sessionSequence = 0
  let started = false

  const stagePreferencesPath = path.join(options.userDataDir, 'stage-preferences.json')
  function loadPersistedStagePreferences(): PersistedStagePreferences {
    if (!fs.existsSync(stagePreferencesPath)) {
      return { ...DEFAULT_PERSISTED_STAGE_PREFERENCES }
    }
    try {
      const raw = fs.readFileSync(stagePreferencesPath, 'utf8')
      if (!raw.trim() || raw.includes('\0')) {
        return { ...DEFAULT_PERSISTED_STAGE_PREFERENCES }
      }
      const parsed = JSON.parse(raw) as unknown
      return v.parse(PersistedStagePreferencesSchema, parsed)
    } catch {
      return { ...DEFAULT_PERSISTED_STAGE_PREFERENCES }
    }
  }

  let currentStagePreferences: PersistedStagePreferences = loadPersistedStagePreferences()
  const voiceSecretProtector: SecretProtector =
    options.secretProtector ?? createNodeAesSecretProtector(options.userDataDir)
  const voiceSettingsPath = path.join(options.userDataDir, 'voice-settings.json')

  function createDefaultStoredVoiceSettings(): StoredVoiceSettingsDocument {
    return {
      ...DEFAULT_VOICE_RUNTIME_SETTINGS,
      wakeWordPhrases: [...DEFAULT_VOICE_RUNTIME_SETTINGS.wakeWordPhrases],
      groqSttModelId: 'whisper-large-v3-turbo',
      openaiSttModelId: 'whisper-1',
      openaiTtsModelId: 'tts-1',
      openaiTtsVoiceId: 'nova',
      elevenLabsModelId: 'eleven_multilingual_v2',
      localKokoroModelId: 'kokoro-v1',
      localKokoroVoiceId: 'ashy-pt-br',
      webSpeechLang: 'pt-BR',
      autoSpeakReplies: true,
    }
  }

  function loadStoredVoiceSettings(): StoredVoiceSettingsDocument {
    const defaults = createDefaultStoredVoiceSettings()
    if (!fs.existsSync(voiceSettingsPath)) {
      return defaults
    }
    try {
      const raw = fs.readFileSync(voiceSettingsPath, 'utf8')
      if (!raw.trim() || raw.includes('\0')) {
        return defaults
      }
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return defaults
      }
      return {
        ...defaults,
        ...(typeof parsed.activeSttProviderId === 'string'
          ? { activeSttProviderId: parsed.activeSttProviderId as SttProviderId }
          : {}),
        ...(typeof parsed.activeTtsProviderId === 'string'
          ? { activeTtsProviderId: parsed.activeTtsProviderId as TtsProviderId }
          : {}),
        ...(typeof parsed.sttBaseUrl === 'string' && parsed.sttBaseUrl.trim()
          ? { sttBaseUrl: parsed.sttBaseUrl.trim() }
          : {}),
        ...(typeof parsed.sttModelId === 'string' && parsed.sttModelId.trim()
          ? { sttModelId: parsed.sttModelId.trim() }
          : {}),
        ...(typeof parsed.ttsBaseUrl === 'string' && parsed.ttsBaseUrl.trim()
          ? { ttsBaseUrl: parsed.ttsBaseUrl.trim() }
          : {}),
        ...(typeof parsed.ttsModelId === 'string' && parsed.ttsModelId.trim()
          ? { ttsModelId: parsed.ttsModelId.trim() }
          : {}),
        ...(typeof parsed.ttsVoiceId === 'string' && parsed.ttsVoiceId.trim()
          ? { ttsVoiceId: parsed.ttsVoiceId.trim() }
          : {}),
        ...(typeof parsed.wakeWordEnabled === 'boolean'
          ? { wakeWordEnabled: parsed.wakeWordEnabled }
          : {}),
        ...(Array.isArray(parsed.wakeWordPhrases)
          ? {
              wakeWordPhrases: parsed.wakeWordPhrases
                .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
                .map((p) => p.trim()),
            }
          : {}),
        ...(typeof parsed.groqSttModelId === 'string'
          ? { groqSttModelId: parsed.groqSttModelId.trim() }
          : {}),
        ...(typeof parsed.openaiSttModelId === 'string'
          ? { openaiSttModelId: parsed.openaiSttModelId.trim() }
          : {}),
        ...(typeof parsed.openaiTtsModelId === 'string'
          ? { openaiTtsModelId: parsed.openaiTtsModelId.trim() }
          : {}),
        ...(typeof parsed.openaiTtsVoiceId === 'string'
          ? { openaiTtsVoiceId: parsed.openaiTtsVoiceId.trim() }
          : {}),
        ...(typeof parsed.elevenLabsModelId === 'string'
          ? { elevenLabsModelId: parsed.elevenLabsModelId.trim() }
          : {}),
        ...(typeof parsed.localKokoroModelId === 'string'
          ? { localKokoroModelId: parsed.localKokoroModelId.trim() }
          : {}),
        ...(typeof parsed.localKokoroVoiceId === 'string'
          ? { localKokoroVoiceId: parsed.localKokoroVoiceId.trim() }
          : {}),
        ...(typeof parsed.webSpeechLang === 'string'
          ? { webSpeechLang: parsed.webSpeechLang.trim() }
          : {}),
        ...(typeof parsed.webSpeechVoiceURI === 'string'
          ? { webSpeechVoiceURI: parsed.webSpeechVoiceURI.trim() }
          : {}),
        ...(typeof parsed.selectedMicDeviceId === 'string'
          ? { selectedMicDeviceId: parsed.selectedMicDeviceId.trim() }
          : {}),
        ...(typeof parsed.unifiedOmniMode === 'boolean'
          ? { unifiedOmniMode: parsed.unifiedOmniMode }
          : {}),
        ...(typeof parsed.directOmniAudio === 'boolean'
          ? { directOmniAudio: parsed.directOmniAudio }
          : {}),
        ...(typeof parsed.autoSpeakReplies === 'boolean'
          ? { autoSpeakReplies: parsed.autoSpeakReplies }
          : {}),
        ...(typeof parsed.encryptedOpenAiApiKey === 'string'
          ? { encryptedOpenAiApiKey: parsed.encryptedOpenAiApiKey }
          : {}),
        ...(typeof parsed.encryptedGroqApiKey === 'string'
          ? { encryptedGroqApiKey: parsed.encryptedGroqApiKey }
          : {}),
        ...(typeof parsed.encryptedElevenLabsApiKey === 'string'
          ? { encryptedElevenLabsApiKey: parsed.encryptedElevenLabsApiKey }
          : {}),
        ...(typeof parsed.encryptedLocalSttApiKey === 'string'
          ? { encryptedLocalSttApiKey: parsed.encryptedLocalSttApiKey }
          : {}),
        ...(typeof parsed.encryptedLocalTtsApiKey === 'string'
          ? { encryptedLocalTtsApiKey: parsed.encryptedLocalTtsApiKey }
          : {}),
      }
    } catch {
      return defaults
    }
  }

  let currentVoiceSettings: StoredVoiceSettingsDocument = loadStoredVoiceSettings()

  function decryptVoiceSecret(cipherText?: string): string | null {
    if (!cipherText || typeof cipherText !== 'string' || cipherText.trim().length === 0) {
      return null
    }
    try {
      const plain = voiceSecretProtector.decrypt(cipherText.trim()).trim()
      return plain.length > 0 ? plain : null
    } catch {
      return null
    }
  }

  function resolveDecryptedOpenAiVoiceKey(providerVault?: ProviderVault): string | null {
    const dedicated = decryptVoiceSecret(currentVoiceSettings.encryptedOpenAiApiKey)
    if (dedicated) return dedicated
    const vault = providerVault ?? providerVaultInstance
    try {
      return vault?.getDecryptedApiKey('openai') ?? null
    } catch {
      return null
    }
  }

  function buildSanitizedVoiceRuntimeSettings(
    providerVault?: ProviderVault,
  ): VoiceRuntimeSettings {
    const openAiKey = resolveDecryptedOpenAiVoiceKey(providerVault)
    const groqKey = decryptVoiceSecret(currentVoiceSettings.encryptedGroqApiKey)
    const elevenLabsKey = decryptVoiceSecret(currentVoiceSettings.encryptedElevenLabsApiKey)
    const localSttKey = decryptVoiceSecret(currentVoiceSettings.encryptedLocalSttApiKey)
    const localTtsKey = decryptVoiceSecret(currentVoiceSettings.encryptedLocalTtsApiKey)

    const {
      encryptedOpenAiApiKey: _1,
      encryptedGroqApiKey: _2,
      encryptedElevenLabsApiKey: _3,
      encryptedLocalSttApiKey: _4,
      encryptedLocalTtsApiKey: _5,
      ...publicFields
    } = currentVoiceSettings

    return {
      ...publicFields,
      wakeWordPhrases: [...publicFields.wakeWordPhrases],
      hasOpenAiApiKey: Boolean(openAiKey),
      hasGroqApiKey: Boolean(groqKey),
      hasElevenLabsApiKey: Boolean(elevenLabsKey),
      hasLocalSttApiKey: Boolean(localSttKey),
      hasLocalTtsApiKey: Boolean(localTtsKey),
      maskedOpenAiApiKey: maskApiKey(openAiKey),
      maskedGroqApiKey: maskApiKey(groqKey),
      maskedElevenLabsApiKey: maskApiKey(elevenLabsKey),
    }
  }

  function resolveEffectiveVoiceBaseUrl(
    providerId: SttProviderId | TtsProviderId,
    overrideBaseUrl?: string,
  ): string {
    if (typeof overrideBaseUrl === 'string' && overrideBaseUrl.trim().length > 0) {
      validateVoiceEndpointUrl(overrideBaseUrl, providerId)
      return overrideBaseUrl.trim().replace(/\/+$/, '')
    }

    if (providerId === 'openai-whisper' || providerId === 'openai-tts') {
      const candidate =
        providerId === 'openai-whisper'
          ? currentVoiceSettings.sttBaseUrl
          : currentVoiceSettings.ttsBaseUrl
      if (extractUrlOrigin(candidate) === 'https://api.openai.com') {
        return candidate.trim().replace(/\/+$/, '')
      }
      return 'https://api.openai.com/v1'
    }

    if (providerId === 'groq-whisper') {
      if (extractUrlOrigin(currentVoiceSettings.sttBaseUrl) === 'https://api.groq.com') {
        return currentVoiceSettings.sttBaseUrl.trim().replace(/\/+$/, '')
      }
      return 'https://api.groq.com/openai/v1'
    }

    if (providerId === 'elevenlabs') {
      if (extractUrlOrigin(currentVoiceSettings.ttsBaseUrl) === 'https://api.elevenlabs.io') {
        return currentVoiceSettings.ttsBaseUrl.trim().replace(/\/+$/, '')
      }
      return 'https://api.elevenlabs.io/v1'
    }

    const localCandidate =
      providerId === 'local-whisper-http'
        ? currentVoiceSettings.sttBaseUrl
        : currentVoiceSettings.ttsBaseUrl
    validateVoiceEndpointUrl(localCandidate, providerId)
    return localCandidate.trim().replace(/\/+$/, '')
  }

  function resolvePinnedVoiceApiKey(
    providerId: SttProviderId | TtsProviderId,
    effectiveBaseUrl: string,
    overrideApiKey?: string,
  ): string | undefined {
    validateVoiceEndpointUrl(effectiveBaseUrl, providerId)

    if (typeof overrideApiKey === 'string' && overrideApiKey.trim().length > 0) {
      return overrideApiKey.trim()
    }

    const targetOrigin = extractUrlOrigin(effectiveBaseUrl)
    if (providerId === 'openai-whisper' || providerId === 'openai-tts') {
      if (targetOrigin !== 'https://api.openai.com') {
        return undefined
      }
      return resolveDecryptedOpenAiVoiceKey() ?? undefined
    }

    if (providerId === 'groq-whisper') {
      if (targetOrigin !== 'https://api.groq.com') {
        return undefined
      }
      return decryptVoiceSecret(currentVoiceSettings.encryptedGroqApiKey) ?? undefined
    }

    if (providerId === 'elevenlabs') {
      if (targetOrigin !== 'https://api.elevenlabs.io') {
        return undefined
      }
      return decryptVoiceSecret(currentVoiceSettings.encryptedElevenLabsApiKey) ?? undefined
    }

    if (providerId === 'local-whisper-http') {
      const storedOrigin = extractUrlOrigin(currentVoiceSettings.sttBaseUrl)
      if (!targetOrigin || targetOrigin !== storedOrigin) {
        return undefined
      }
      return decryptVoiceSecret(currentVoiceSettings.encryptedLocalSttApiKey) ?? undefined
    }

    if (providerId === 'local-kokoro-http') {
      const storedOrigin = extractUrlOrigin(currentVoiceSettings.ttsBaseUrl)
      if (!targetOrigin || targetOrigin !== storedOrigin) {
        return undefined
      }
      return decryptVoiceSecret(currentVoiceSettings.encryptedLocalTtsApiKey) ?? undefined
    }

    return undefined
  }

  function createSafeVoiceFetch(expectedProviderId: string): typeof fetch {
    const baseFetch: typeof fetch =
      options.fetchImpl ?? ((...args) => globalThis.fetch(...args))

    return async (input, init) => {
      const targetUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      validateVoiceEndpointUrl(targetUrl, expectedProviderId)

      const timeoutSignal = AbortSignal.timeout(VOICE_HTTP_TIMEOUT_MS)
      const signal = init?.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal

      const response = await baseFetch(input, {
        ...init,
        redirect: 'error',
        signal,
      })

      const contentLengthHeader = response.headers?.get?.('content-length')
      if (contentLengthHeader) {
        const declaredBytes = Number(contentLengthHeader)
        if (Number.isFinite(declaredBytes) && declaredBytes > MAX_TTS_BINARY_RESPONSE_BYTES) {
          throw new Error(
            `Voice HTTP response exceeds maximum allowed size (${MAX_TTS_BINARY_RESPONSE_BYTES} bytes)`,
          )
        }
      }

      const originalArrayBuffer = response.arrayBuffer.bind(response)
      return new Proxy(response, {
        get(target, prop) {
          if (prop === 'arrayBuffer') {
            return async () => {
              const buf = await originalArrayBuffer()
              if (buf.byteLength > MAX_TTS_BINARY_RESPONSE_BYTES) {
                throw new Error(
                  `Voice HTTP response exceeds maximum allowed size (${MAX_TTS_BINARY_RESPONSE_BYTES} bytes)`,
                )
              }
              return buf
            }
          }
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }
  }
  const hostEventListeners = new Set<(event: AshyHostStreamEvent) => void>()

  function emitHostEvent(event: AshyHostStreamEvent): void {
    for (const listener of hostEventListeners) {
      try {
        listener(event)
      } catch {
        // Isolate listener error
      }
    }
  }

  let kernelEpoch = 0
  let encryptionUpdatedAt: string | null = null
  let currentUpdaterState: AutoUpdaterState = {
    status: 'idle',
    currentVersion: '1.0.0',
    availableVersion: null,
    progressPercent: null,
    errorMessage: null,
    checkedAt: null,
    autoDownload: true,
  }

  const cortexEncryptionCodec = {
    encrypt: (plain: string, aad: string) => voiceSecretProtector.encryptEnvelope(plain, aad),
    decrypt: (cipher: string, aad: string) => voiceSecretProtector.decryptEnvelope(cipher, aad),
  }

  const container = createContainer()

  const cortexToken = container.provide('cortex', {
    build: () =>
      createAshyCortex({
        filePath: path.join(options.userDataDir, 'ashy.db'),
        encryptionCodec: cortexEncryptionCodec,
      }),
    onStop: (instance) => {
      instance.close()
    },
  })

  const voiceStoreToken = container.provide('voiceStore', {
    build: () =>
      createVoiceIdentityStore({
        userDataDir: options.userDataDir,
        encryptionCodec: {
          isEnabled: () => (cortexInstance ? cortexInstance.isEncryptionAtRestEnabled() : false),
          encrypt: (plain, aad) => voiceSecretProtector.encryptEnvelope(plain, aad),
          decrypt: (cipher, aad) => voiceSecretProtector.decryptEnvelope(cipher, aad),
        },
      }),
  })

  const providerVaultToken = container.provide('providerVault', {
    build: () =>
      createProviderVault({
        userDataDir: options.userDataDir,
        secretProtector: options.secretProtector,
        fetchImpl: options.fetchImpl,
      }),
  })

  const agencyRuntimeToken = container.provide('agencyRuntime', {
    dependsOn: {
      cortex: cortexToken,
      providerVault: providerVaultToken,
    },
    build: ({ cortex, providerVault }) =>
      createHostAgencyRuntime({
        cortex,
        providerVault,
        userDataDir: options.userDataDir,
        fetchImpl: options.fetchImpl,
      } as Parameters<typeof createHostAgencyRuntime>[0]),
    onStop: async (instance) => {
      await instance.close()
    },
  })

  const turnOrchestratorToken = container.provide('turnOrchestrator', {
    dependsOn: {
      cortex: cortexToken,
      voiceStore: voiceStoreToken,
      providerVault: providerVaultToken,
      agencyRuntime: agencyRuntimeToken,
    },
    build: ({ cortex, voiceStore, providerVault, agencyRuntime }) =>
      createTurnOrchestrator({
        cortex,
        voiceStore,
        providerVault,
        agencyRuntime: agencyRuntime as HostAgencyRuntime,
        getBootstrapSnapshot: () =>
          buildSnapshot(cortex, voiceStore, providerVault, agencyRuntime),
        getActiveVisionContext: () => agencyRuntime.getActiveVisionContextForTurn(),
        onPersistenceWarning: (warning) => {
          lastPersistenceWarning = warning
        },
        onDominantEmotionChange: (emotion) => {
          dominantEmotion = emotion
        },
        keepaliveIntervalMs: options.keepaliveIntervalMs,
        getKernelEpoch: () => kernelEpoch,
      }),
    onStop: (instance) => {
      instance.abortAll()
    },
  })

  function buildSnapshot(
    cortex: AshyCortex,
    voiceStore: VoiceIdentityStore,
    providerVault: ProviderVault,
    agencyRuntime?: HostAgencyRuntime,
  ): AshyBootstrapSnapshot {
    let sessions = cortex.listChatSessions()
    if (sessions.length === 0) {
      const initialSession = cortex.createChatSession({
        id: 'session-initial',
        title: 'Primeiro Encontro',
      })
      sessions = [initialSession]
    }

    const activeSession =
      sessions.find((s) => s.id === activeSessionId) ?? sessions[0]!
    activeSessionId = activeSession.id

    const messages = cortex.listChatMessages(activeSession.id, 80)
    const milestones = cortex.db.listMilestones()
    const needsOnboarding = !milestones.some((m) => m.category === 'first_meeting')

    const identityFacts = cortex.db.listActiveSemanticFacts('identity')
    const userName =
      identityFacts
        .filter(
          (f) =>
            f.subject.toLowerCase() === 'user' &&
            (f.predicate === 'name' || f.predicate === 'user_name'),
        )
        .at(-1)?.object ?? null

    const userPronouns =
      identityFacts
        .filter(
          (f) =>
            f.subject.toLowerCase() === 'user' &&
            (f.predicate === 'pronouns' || f.predicate === 'user_pronouns'),
        )
        .at(-1)?.object ?? null

    const facts = cortex.db.listSemanticFacts()
    const episodes = cortex.db.listEpisodicMemories()
    const jokes = cortex.db.listRelationalMotifs()
    const habits = cortex.db.listUserHabits()
    const intents = cortex.db.listProspectiveIntents()
    const evolutionLog = cortex.db.listPersonalityEvolution()
    const governancePolicy = cortex.db.getMemoryGovernancePolicy()

    const totalTurns = sessions.reduce((sum, s) => sum + s.turnCount, 0)
    const approvedEpisodes = episodes.filter((ep) => ep.approvalStatus !== 'pending_review')
    const approvedJokes = jokes.filter((j) => j.approvalStatus !== 'pending_review')
    const hasEstablishedJoke = approvedJokes.some(
      (j) => j.stage === 'inside_joke' || j.stage === 'legendary',
    )
    const relMetrics = deriveRelationshipMetrics({
      totalTurns,
      milestonesCount: milestones.length,
      episodesCount: approvedEpisodes.length,
      hasEstablishedJoke,
    })

    const affective = cortex.db.getAffectiveState()
    const lastAssistantEmotion = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant')?.emotion
    const resolvedDominantEmotion = lastAssistantEmotion ?? dominantEmotion

    return {
      needsOnboarding,
      userProfile: {
        userName,
        userPronouns,
      },
      relationship: {
        stage: relMetrics.stage,
        familiarityScore: relMetrics.familiarityScore,
        trustScore: relMetrics.trustScore,
        totalTurns,
        milestones,
      },
      affect: {
        mood: affective.mood,
        traits: affective.traits,
        dominantEmotion: resolvedDominantEmotion,
      },
      activeSession,
      sessions,
      messages,
      memories: {
        facts,
        episodes,
        jokes,
        habits,
        intents,
        evolutionLog,
        governancePolicy,
        crossEpisodeLinks: cortex.getCrossEpisodeLinks(),
        dreamJournalEntries: cortex.listDreamJournalEntries(50),
        initiativePolicy: cortex.getInitiativePolicy(),
        initiativeLog: cortex.listProactiveInitiativeLog(50),
        roomEnvironment: cortex.getRoomEnvironment(),
      },
      voice: voiceStore.read(),
      providers: providerVault.getPublicState(),
      runtimeDiagnostics: {
        dbMode: cortex.db.isPersistent ? 'wal' : 'memory',
        dbPath: cortex.db.filePath,
        lastPersistenceWarning,
      },
      lastEvalReport,
      agency: (agencyRuntime ?? agencyRuntimeInstance)?.getSnapshot(),
      stagePreferences: currentStagePreferences,
      voiceSettings: buildSanitizedVoiceRuntimeSettings(providerVault),
      encryptionAtRest: {
        enabled: cortex.isEncryptionAtRestEnabled(),
        algorithm: 'AES-256-GCM',
        keyBackend: voiceSecretProtector.getBackendKind(),
        updatedAt: encryptionUpdatedAt ?? cortex.db.getEncryptionUpdatedAt(),
      },
      updaterState: currentUpdaterState,
    }
  }

  let cortexInstance!: AshyCortex
  let voiceStoreInstance!: VoiceIdentityStore
  let providerVaultInstance!: ProviderVault
  let agencyRuntimeInstance!: HostAgencyRuntime
  let turnOrchestratorInstance!: TurnOrchestrator
  let dreamIdleTimer: ReturnType<typeof setTimeout> | null = null
  let turnOrchestratorUnsub: (() => void) | null = null

  function clearDreamIdleTimer(): void {
    if (dreamIdleTimer !== null) {
      clearTimeout(dreamIdleTimer)
      dreamIdleTimer = null
    }
  }

  function applyStagePreferencesUpdate(
    rawInput: UpdateStagePreferencesInput,
  ): PersistedStagePreferences {
    let parsed: UpdateStagePreferencesInput
    try {
      parsed = v.parse(UpdateStagePreferencesInputSchema, rawInput)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Invalid RPC argument: ${message}`)
    }

    currentStagePreferences = {
      ...currentStagePreferences,
      ...(parsed.stageMode !== undefined ? { stageMode: parsed.stageMode } : {}),
      ...(parsed.live2dPresetId !== undefined ? { live2dPresetId: parsed.live2dPresetId } : {}),
      ...(parsed.live2dModelUrl !== undefined ? { live2dModelUrl: parsed.live2dModelUrl } : {}),
      ...(parsed.loadedLive2DModelName !== undefined
        ? { loadedLive2DModelName: parsed.loadedLive2DModelName }
        : {}),
      ...(parsed.live2dModelControls !== undefined
        ? { live2dModelControls: parsed.live2dModelControls }
        : {}),
      ...(parsed.ambientLuminance !== undefined
        ? { ambientLuminance: parsed.ambientLuminance }
        : {}),
      ...(parsed.showDesktopAvatar !== undefined
        ? { showDesktopAvatar: parsed.showDesktopAvatar }
        : {}),
      ...(parsed.isStageHidden !== undefined ? { isStageHidden: parsed.isStageHidden } : {}),
      updatedAt: Date.now(),
    }

    writeAtomicWithBackup(stagePreferencesPath, JSON.stringify(currentStagePreferences, null, 2))
    emitHostEvent({
      type: 'stage:updated',
      stagePreferences: currentStagePreferences,
    })
    return currentStagePreferences
  }

  function applyVoiceRuntimeSettingsUpdate(
    rawInput: SaveVoiceRuntimeSettingsInput,
  ): VoiceRuntimeSettings {
    let parsed: SaveVoiceRuntimeSettingsInput
    try {
      parsed = v.parse(SaveVoiceRuntimeSettingsInputSchema, rawInput)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Invalid RPC argument: ${message}`)
    }

    const nextSttProvider =
      parsed.activeSttProviderId ?? currentVoiceSettings.activeSttProviderId
    const nextTtsProvider =
      parsed.activeTtsProviderId ?? currentVoiceSettings.activeTtsProviderId

    if (parsed.sttBaseUrl !== undefined) {
      const checkProvider =
        nextSttProvider === 'openai-whisper' || nextSttProvider === 'groq-whisper'
          ? extractUrlOrigin(parsed.sttBaseUrl) === 'https://api.openai.com' ||
            extractUrlOrigin(parsed.sttBaseUrl) === 'https://api.groq.com'
            ? nextSttProvider
            : 'local-whisper-http'
          : 'local-whisper-http'
      validateVoiceEndpointUrl(parsed.sttBaseUrl, checkProvider)
    }

    if (parsed.ttsBaseUrl !== undefined) {
      const checkProvider =
        nextTtsProvider === 'openai-tts' || nextTtsProvider === 'elevenlabs'
          ? extractUrlOrigin(parsed.ttsBaseUrl) === 'https://api.openai.com' ||
            extractUrlOrigin(parsed.ttsBaseUrl) === 'https://api.elevenlabs.io'
            ? nextTtsProvider
            : 'local-kokoro-http'
          : 'local-kokoro-http'
      validateVoiceEndpointUrl(parsed.ttsBaseUrl, checkProvider)
    }

    const nextSettings: StoredVoiceSettingsDocument = {
      ...currentVoiceSettings,
      ...(parsed.activeSttProviderId !== undefined
        ? { activeSttProviderId: parsed.activeSttProviderId }
        : {}),
      ...(parsed.activeTtsProviderId !== undefined
        ? { activeTtsProviderId: parsed.activeTtsProviderId }
        : {}),
      ...(parsed.sttBaseUrl !== undefined ? { sttBaseUrl: parsed.sttBaseUrl } : {}),
      ...(parsed.sttModelId !== undefined ? { sttModelId: parsed.sttModelId } : {}),
      ...(parsed.ttsBaseUrl !== undefined ? { ttsBaseUrl: parsed.ttsBaseUrl } : {}),
      ...(parsed.ttsModelId !== undefined ? { ttsModelId: parsed.ttsModelId } : {}),
      ...(parsed.ttsVoiceId !== undefined ? { ttsVoiceId: parsed.ttsVoiceId } : {}),
      ...(parsed.wakeWordEnabled !== undefined
        ? { wakeWordEnabled: parsed.wakeWordEnabled }
        : {}),
      ...(parsed.wakeWordPhrases !== undefined
        ? { wakeWordPhrases: [...parsed.wakeWordPhrases] }
        : {}),
      ...(parsed.groqSttModelId !== undefined ? { groqSttModelId: parsed.groqSttModelId } : {}),
      ...(parsed.openaiSttModelId !== undefined
        ? { openaiSttModelId: parsed.openaiSttModelId }
        : {}),
      ...(parsed.openaiTtsModelId !== undefined
        ? { openaiTtsModelId: parsed.openaiTtsModelId }
        : {}),
      ...(parsed.openaiTtsVoiceId !== undefined
        ? { openaiTtsVoiceId: parsed.openaiTtsVoiceId }
        : {}),
      ...(parsed.elevenLabsModelId !== undefined
        ? { elevenLabsModelId: parsed.elevenLabsModelId }
        : {}),
      ...(parsed.localKokoroModelId !== undefined
        ? { localKokoroModelId: parsed.localKokoroModelId }
        : {}),
      ...(parsed.localKokoroVoiceId !== undefined
        ? { localKokoroVoiceId: parsed.localKokoroVoiceId }
        : {}),
      ...(parsed.webSpeechLang !== undefined ? { webSpeechLang: parsed.webSpeechLang } : {}),
      ...(parsed.webSpeechVoiceURI !== undefined
        ? { webSpeechVoiceURI: parsed.webSpeechVoiceURI }
        : {}),
      ...(parsed.selectedMicDeviceId !== undefined
        ? { selectedMicDeviceId: parsed.selectedMicDeviceId }
        : {}),
      ...(parsed.unifiedOmniMode !== undefined
        ? { unifiedOmniMode: parsed.unifiedOmniMode }
        : {}),
      ...(parsed.directOmniAudio !== undefined
        ? { directOmniAudio: parsed.directOmniAudio }
        : {}),
      ...(parsed.autoSpeakReplies !== undefined
        ? { autoSpeakReplies: parsed.autoSpeakReplies }
        : {}),
    }

    if (parsed.clearOpenAiApiKey === true) {
      delete nextSettings.encryptedOpenAiApiKey
    } else if (typeof parsed.openaiApiKey === 'string' && parsed.openaiApiKey.trim().length > 0) {
      nextSettings.encryptedOpenAiApiKey = voiceSecretProtector.encrypt(
        parsed.openaiApiKey.trim(),
      )
    }

    if (parsed.clearGroqApiKey === true) {
      delete nextSettings.encryptedGroqApiKey
    } else if (typeof parsed.groqApiKey === 'string' && parsed.groqApiKey.trim().length > 0) {
      nextSettings.encryptedGroqApiKey = voiceSecretProtector.encrypt(parsed.groqApiKey.trim())
    }

    if (parsed.clearElevenLabsApiKey === true) {
      delete nextSettings.encryptedElevenLabsApiKey
    } else if (
      typeof parsed.elevenLabsApiKey === 'string' &&
      parsed.elevenLabsApiKey.trim().length > 0
    ) {
      nextSettings.encryptedElevenLabsApiKey = voiceSecretProtector.encrypt(
        parsed.elevenLabsApiKey.trim(),
      )
    }

    if (parsed.clearLocalSttApiKey === true) {
      delete nextSettings.encryptedLocalSttApiKey
    } else if (
      typeof parsed.localSttApiKey === 'string' &&
      parsed.localSttApiKey.trim().length > 0
    ) {
      nextSettings.encryptedLocalSttApiKey = voiceSecretProtector.encrypt(
        parsed.localSttApiKey.trim(),
      )
    }

    if (parsed.clearLocalTtsApiKey === true) {
      delete nextSettings.encryptedLocalTtsApiKey
    } else if (
      typeof parsed.localTtsApiKey === 'string' &&
      parsed.localTtsApiKey.trim().length > 0
    ) {
      nextSettings.encryptedLocalTtsApiKey = voiceSecretProtector.encrypt(
        parsed.localTtsApiKey.trim(),
      )
    }

    currentVoiceSettings = nextSettings
    writeAtomicWithBackup(voiceSettingsPath, JSON.stringify(currentVoiceSettings, null, 2))
    return buildSanitizedVoiceRuntimeSettings(providerVaultInstance)
  }

  function resolveDreamJsonGenerator(): ((prompt: string) => Promise<string>) | undefined {
    if (!providerVaultInstance?.getPublicState().hasActiveReadyProvider) {
      return undefined
    }
    return async (prompt: string) => {
      const model = providerVaultInstance.createActiveLanguageModel() as unknown as {
        generateText?: (opts: {
          messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
          temperature?: number
          maxTokens?: number
          reasoningEffort?: 'none'
        }) => Promise<{ text: string }>
      }
      if (typeof model.generateText === 'function') {
        const res = await model.generateText({
          messages: [
            { role: 'system', content: 'Responda apenas com JSON válido.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          maxTokens: 600,
          reasoningEffort: 'none',
        })
        return res.text
      }
      const res = await generateText(
        model as unknown as Parameters<typeof generateText>[0],
        {
          messages: [
            { role: 'system', content: 'Responda apenas com JSON válido.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          maxTokens: 600,
          reasoningEffort: 'none',
        },
      )
      return res.text
    }
  }

  function scheduleDreamIdleTimer(): void {
    const timeoutMs = options.dreamIdleTimeoutMs ?? DEFAULT_DREAM_IDLE_TIMEOUT_MS
    if (!started || timeoutMs <= 0) {
      return
    }
    clearDreamIdleTimer()
    dreamIdleTimer = setTimeout(() => {
      dreamIdleTimer = null
      if (!started || turnOrchestratorInstance.hasActiveTurnForSession(activeSessionId)) {
        return
      }
      void cortexInstance
        .runDreamReflectionCycle({
          sessionId: activeSessionId,
          forceConsolidate: true,
          generateJsonFn: resolveDreamJsonGenerator(),
        })
        .catch(() => undefined)
    }, timeoutMs)
    dreamIdleTimer.unref?.()
  }

  async function start(): Promise<void> {
    if (started) return
    await container.start()
    cortexInstance = await container.resolve(cortexToken)
    if (encryptionUpdatedAt === null) {
      encryptionUpdatedAt = cortexInstance.db.getEncryptionUpdatedAt()
    }
    voiceStoreInstance = await container.resolve(voiceStoreToken)
    providerVaultInstance = await container.resolve(providerVaultToken)
    agencyRuntimeInstance = await container.resolve(agencyRuntimeToken)
    turnOrchestratorInstance = await container.resolve(turnOrchestratorToken)
    started = true
    turnOrchestratorUnsub = turnOrchestratorInstance.onEvent((event) => {
      if (event.type === 'turn:completed') {
        scheduleDreamIdleTimer()
      }
    })
  }

  async function stop(): Promise<void> {
    if (!started) return
    clearDreamIdleTimer()
    turnOrchestratorUnsub?.()
    turnOrchestratorUnsub = null
    started = false
    try {
      await cortexInstance.consolidateSessionMemories({
        sessionId: activeSessionId,
        force: true,
        sessionSwitch: true,
        generateJsonFn: resolveDreamJsonGenerator(),
      })
    } catch {
      // Fault-isolated: do not block shutdown if consolidation fails
    }
    await container.stop()
  }

  await start()

  return {
    userDataDir: options.userDataDir,
    container,
    get cortex() {
      return cortexInstance
    },
    get voiceStore() {
      return voiceStoreInstance
    },
    get providerVault() {
      return providerVaultInstance
    },
    get agencyRuntime() {
      return agencyRuntimeInstance
    },
    get turnOrchestrator() {
      return turnOrchestratorInstance
    },
    emitHostEvent,
    start,
    stop,

    async getBootstrapSnapshot(): Promise<AshyBootstrapSnapshot> {
      return buildSnapshot(cortexInstance, voiceStoreInstance, providerVaultInstance)
    },

    async completeOnboarding(rawInput: CompleteOnboardingInput): Promise<AshyBootstrapSnapshot> {
      const input = v.parse(CompleteOnboardingInputSchema, rawInput)
      const now = Date.now()

      cortexInstance.db.upsertSemanticFact({
        id: 'fact-user-name',
        category: 'identity',
        subject: 'user',
        predicate: 'name',
        object: input.userName,
        confidence: 1.0,
        sourceEpisodeIds: ['milestone-first-meeting'],
        validFrom: now,
        invalidAt: null,
      })

      if (input.userPronouns && input.userPronouns.trim().length > 0) {
        cortexInstance.db.upsertSemanticFact({
          id: 'fact-user-pronouns',
          category: 'identity',
          subject: 'user',
          predicate: 'pronouns',
          object: input.userPronouns.trim(),
          confidence: 1.0,
          sourceEpisodeIds: ['milestone-first-meeting'],
          validFrom: now,
          invalidAt: null,
        })
      }

      if (input.providerConfig) {
        providerVaultInstance.saveProviderConfig(input.providerConfig)
        providerVaultInstance.setActiveProvider(input.providerConfig.providerId)
      }

      if (input.voiceSettings) {
        applyVoiceRuntimeSettingsUpdate(input.voiceSettings)
      }

      if (input.agencyConsent) {
        await agencyRuntimeInstance.updateConsent(input.agencyConsent)
      }

      if (input.initiativePolicy) {
        cortexInstance.saveInitiativePolicy(input.initiativePolicy)
      }

      if (input.stagePreferences) {
        applyStagePreferencesUpdate(input.stagePreferences)
      }

      cortexInstance.db.upsertMilestone({
        id: 'milestone-first-meeting',
        title: 'Primeiro Encontro no Estúdio',
        narrative: `Ashy conheceu ${input.userName} no Cozy Night Studio.`,
        category: 'first_meeting',
        roomTrophyId: 'trophy-first-boot-mug',
        createdAt: now,
      })

      if (input.seedFirstGreeting === true) {
        if (!cortexInstance.getChatSession('session-initial')) {
          cortexInstance.createChatSession({
            id: 'session-initial',
            title: 'Primeiro Encontro',
          })
        }
        activeSessionId = 'session-initial'
        const greetingContent = `Oi, ${input.userName}! Que bom te conhecer de verdade aqui no estúdio. Já deixei uma caneca de café pra gente na estante — me conta: no que você tá trabalhando ou pensando hoje?`
        cortexInstance.appendChatMessage({
          id: 'msg-onboarding-greeting',
          sessionId: 'session-initial',
          role: 'assistant',
          content: greetingContent,
          rawContent: greetingContent,
          emotion: 'happy',
          markersJson: '[]',
          consolidatedEpisodeId: 'milestone-first-meeting',
          createdAt: now,
        })
      }

      return buildSnapshot(cortexInstance, voiceStoreInstance, providerVaultInstance)
    },

    async createSession(title?: string): Promise<ChatSessionRecord> {
      sessionSequence += 1
      const id = `session-${Date.now()}-${sessionSequence}`
      const session = cortexInstance.createChatSession({
        id,
        title: title?.trim() || 'Nova Conversa',
      })
      activeSessionId = session.id
      return session
    },

    async selectSession(sessionId: string): Promise<{
      session: ChatSessionRecord
      messages: ChatMessageRecord[]
    }> {
      const session = cortexInstance.getChatSession(sessionId)
      if (!session) {
        throw new Error(`ChatSession not found: ${sessionId}`)
      }
      if (
        sessionId !== activeSessionId &&
        !turnOrchestratorInstance.hasActiveTurnForSession(activeSessionId)
      ) {
        try {
          await cortexInstance.consolidateSessionMemories({
            sessionId: activeSessionId,
            force: true,
            sessionSwitch: true,
            generateJsonFn: resolveDreamJsonGenerator(),
          })
        } catch {
          // Fault-isolated: do not block session switch if consolidation fails
        }
      }
      activeSessionId = session.id
      return {
        session,
        messages: cortexInstance.listChatMessages(session.id, 80),
      }
    },

    async sendTurn(input: SendTurnInput): Promise<{
      turnId: string
      userMessage: ChatMessageRecord
    }> {
      clearDreamIdleTimer()
      activeSessionId = input.sessionId
      return turnOrchestratorInstance.sendTurn(input)
    },

    async abortTurn(turnId: string): Promise<void> {
      return turnOrchestratorInstance.abortTurn(turnId)
    },

    async saveProviderConfig(input: SaveProviderConfigInput): Promise<{
      config: PublicProviderConfig
      providers: AshyBootstrapSnapshot['providers']
    }> {
      const config = providerVaultInstance.saveProviderConfig(input)
      return {
        config,
        providers: providerVaultInstance.getPublicState(),
      }
    },

    async setActiveProvider(
      providerId: LlmProviderId,
    ): Promise<AshyBootstrapSnapshot['providers']> {
      return providerVaultInstance.setActiveProvider(providerId)
    },

    async testProviderConnection(input: TestProviderInput): Promise<ProviderHealthResult> {
      return providerVaultInstance.testProviderConnection(input)
    },

    async listProviderModels(input: ListProviderModelsInput): Promise<ListProviderModelsResult> {
      return providerVaultInstance.listProviderModels(input)
    },

    async saveVoiceIdentity(content: string): Promise<AshyBootstrapSnapshot['voice']> {
      return voiceStoreInstance.save(content)
    },

    async resetVoiceIdentity(): Promise<AshyBootstrapSnapshot['voice']> {
      return voiceStoreInstance.reset()
    },

    async upsertSemanticFact(input: UpsertFactInput): Promise<SemanticFact> {
      const now = Date.now()
      const subject = input.subject.trim()
      const predicate = input.predicate.trim()
      const object = input.object.trim()

      const existingActive = cortexInstance.db
        .listSemanticFacts({ activeOnly: true })
        .filter(
          (f) =>
            f.subject.toLowerCase() === subject.toLowerCase() &&
            f.predicate.toLowerCase() === predicate.toLowerCase(),
        )

      for (const prev of existingActive) {
        if (prev.id !== input.id && prev.object !== object) {
          cortexInstance.db.invalidateSemanticFact(prev.id, now)
        }
      }

      return cortexInstance.db.upsertSemanticFact({
        id: input.id?.trim() || `fact-${now}-${Math.random().toString(36).slice(2, 7)}`,
        category: input.category,
        subject,
        predicate,
        object,
        confidence: input.confidence ?? 0.95,
        sourceEpisodeIds: ['manual-ui-entry'],
        validFrom: now,
        invalidAt: null,
      })
    },

    async upsertEpisodicMemory(episode: EpisodicMemory): Promise<EpisodicMemory> {
      return cortexInstance.db.upsertEpisodicMemory(episode)
    },

    async upsertMilestone(
      milestone: AutobiographicalMilestone,
    ): Promise<AutobiographicalMilestone> {
      return cortexInstance.db.upsertMilestone(milestone)
    },

    async upsertRelationalMotif(motif: RelationalMotif): Promise<RelationalMotif> {
      return cortexInstance.db.upsertRelationalMotif(motif)
    },

    async upsertProspectiveIntent(intent: ProspectiveIntent): Promise<ProspectiveIntent> {
      return cortexInstance.db.upsertProspectiveIntent(intent)
    },

    async recordEmotionPulse(input: {
      emotion: AshyEmotion
      intensity?: number
    }): Promise<AshyBootstrapSnapshot['affect']> {
      dominantEmotion = input.emotion
      const pulsed = cortexInstance.recordEmotionPulse(
        input.emotion,
        input.intensity ?? 0.85,
        Date.now(),
      )
      return {
        mood: pulsed.mood,
        traits: pulsed.traits,
        dominantEmotion,
      }
    },

    async persistDreamConsolidation(input: {
      episode: EpisodicMemory
      traits: PersonalityTraits
      record: PersonalityEvolutionRecord
    }): Promise<void> {
      const now = Date.now()
      cortexInstance.db.upsertEpisodicMemory(input.episode)
      const currentAffect = cortexInstance.db.getAffectiveState()
      cortexInstance.db.saveAffectiveState(currentAffect.mood, input.traits, now)
      cortexInstance.db.upsertPersonalityEvolution(input.record)
    },

    async persistTraitRevert(input: {
      traits: PersonalityTraits
      record: PersonalityEvolutionRecord
    }): Promise<void> {
      const now = Date.now()
      const currentAffect = cortexInstance.db.getAffectiveState()
      cortexInstance.db.saveAffectiveState(currentAffect.mood, input.traits, now)
      cortexInstance.db.upsertPersonalityEvolution(input.record)
    },

    async deleteMemoryItem(input: {
      kind: DeletableMemoryKind
      id: string
    }): Promise<void> {
      if (input.kind === 'fact') {
        cortexInstance.db.deleteSemanticFact(input.id)
      } else if (input.kind === 'episode') {
        cortexInstance.db.deleteEpisodicMemory(input.id)
      } else if (input.kind === 'joke') {
        cortexInstance.db.deleteRelationalMotif(input.id)
      } else if (input.kind === 'habit') {
        cortexInstance.db.deleteUserHabit(input.id)
      } else if (input.kind === 'intent') {
        cortexInstance.db.deleteProspectiveIntent(input.id)
      } else if (input.kind === 'milestone') {
        cortexInstance.db.deleteMilestone(input.id)
      }
    },

    async consolidateSessionMemories(input?: {
      sessionId?: string
      force?: boolean
    }): Promise<AshyBootstrapSnapshot> {
      const normalizedSessionId =
        input?.sessionId && input.sessionId.trim().length > 0
          ? input.sessionId.trim()
          : activeSessionId
      await cortexInstance.consolidateSessionMemories({
        sessionId: normalizedSessionId,
        force: input?.force ?? true,
        generateJsonFn: resolveDreamJsonGenerator(),
      })
      return buildSnapshot(cortexInstance, voiceStoreInstance, providerVaultInstance)
    },

    async approveMemoryItem(input: {
      kind: ApprovableMemoryKind
      id: string
    }): Promise<AshyBootstrapSnapshot> {
      cortexInstance.approveMemoryItem(input.kind, input.id)
      return buildSnapshot(cortexInstance, voiceStoreInstance, providerVaultInstance)
    },

    async setMemoryGovernancePolicy(input: {
      category: MemoryGovernanceCategory
      requireConfirmation: boolean
    }): Promise<MemoryGovernancePolicy> {
      return cortexInstance.setMemoryGovernancePolicy(
        input.category,
        input.requireConfirmation,
      )
    },

    async seedDemoFixtures(): Promise<AshyBootstrapSnapshot> {
      seedAshyDemoFixtures(cortexInstance)
      dominantEmotion = 'smug'
      return buildSnapshot(cortexInstance, voiceStoreInstance, providerVaultInstance)
    },

    async runCoreExperimentEval(
      rawInput?: RunCoreExperimentInput,
    ): Promise<CoreExperimentEvalReport> {
      const input = rawInput ? v.parse(RunCoreExperimentInputSchema, rawInput) : {}
      const nextRun = evalLock.then(async () => {
        const report = await runCoreExperimentM2({
          seed: input.seed ?? 0,
          modelAId: input.modelAId,
          modelBId: input.modelBId,
        })
        const normalizedReport: CoreExperimentEvalReport = {
          ...report,
          metrics: {
            ...report.metrics,
            seriousnessFalseNegativeCount:
              report.metrics.seriousnessFalseNegativeCount ?? 0,
            bondSafeguardComplianceRate:
              report.metrics.bondSafeguardComplianceRate ?? 1.0,
            traitDriftCorridorComplianceRate:
              report.metrics.traitDriftCorridorComplianceRate ?? 1.0,
            initiativeGroundingRate:
              report.metrics.initiativeGroundingRate ?? 1.0,
            unopportuneInitiativeCount:
              report.metrics.unopportuneInitiativeCount ?? 0,
          },
        }
        lastEvalReport = normalizedReport
        return normalizedReport
      })
      evalLock = nextRun.then(
        () => undefined,
        () => undefined,
      )
      return nextRun
    },

    async runDreamReflection(input?: {
      sessionId?: string
      force?: boolean
      maxEvolutions?: number
    }): Promise<{
      result: DreamReflectionCycleResult
      snapshot: AshyBootstrapSnapshot
    }> {
      clearDreamIdleTimer()
      const targetSessionId =
        typeof input?.sessionId === 'string' && input.sessionId.trim().length > 0
          ? input.sessionId.trim()
          : activeSessionId
      const result = await cortexInstance.runDreamReflectionCycle({
        sessionId: targetSessionId,
        forceConsolidate: input?.force !== false,
        maxEvolutions: input?.maxEvolutions,
        generateJsonFn: resolveDreamJsonGenerator(),
      })
      return {
        result,
        snapshot: buildSnapshot(cortexInstance, voiceStoreInstance, providerVaultInstance),
      }
    },

    async revertTraitEvolution(input: {
      recordId: string
    }): Promise<AshyBootstrapSnapshot> {
      cortexInstance.revertTrait(input.recordId.trim(), Date.now())
      return buildSnapshot(cortexInstance, voiceStoreInstance, providerVaultInstance)
    },

    async getAgencySnapshot(): Promise<AgencySnapshot> {
      return agencyRuntimeInstance.getSnapshot()
    },

    async callMcpTool(input: {
      toolName: string
      args?: Record<string, unknown>
    }): Promise<{
      status: 'executed' | 'staged' | 'blocked_privacy' | 'blocked_traversal' | 'blocked_policy'
      output?: unknown
      pendingCard?: SharedPendingActionCard
      reason?: string
      snapshot?: AgencySnapshot
    }> {
      return agencyRuntimeInstance.callMcpTool(input)
    },

    async approvePendingAction(input: {
      actionId: string
      scope?: ApprovalScope
    }): Promise<{
      status: 'executed'
      card: SharedPendingActionCard
      output: unknown
      snapshot?: AgencySnapshot
    }> {
      return agencyRuntimeInstance.approvePendingAction(input)
    },

    async denyPendingAction(input: {
      actionId: string
      reason?: string
    }): Promise<{
      status: 'denied'
      card: SharedPendingActionCard
      feedback: string
      snapshot?: AgencySnapshot
    }> {
      return agencyRuntimeInstance.denyPendingAction(input)
    },

    async updateAgencyConsent(input: UpdateAgencyConsentInput): Promise<AgencySnapshot> {
      return agencyRuntimeInstance.updateConsent(input)
    },

    async revokeSessionPermissions(input?: { toolName?: string }): Promise<AgencySnapshot> {
      return agencyRuntimeInstance.revokeSessionPermissions(input)
    },

    async captureAuthorizedScreen(input?: {
      windowTitle?: string
      frameFixtureId?: string
      forceRefresh?: boolean
    }): Promise<{
      observation: VisionObservationResult
      snapshot: AgencySnapshot
    }> {
      return agencyRuntimeInstance.captureAuthorizedScreen(input)
    },

    async registerExternalMcpServer(input: ExternalMcpServerConfig): Promise<AgencySnapshot> {
      return agencyRuntimeInstance.registerExternalMcpServer(input)
    },

    async updateMilestone(
      input: UpdateMilestoneInput,
    ): Promise<AutobiographicalMilestone> {
      let parsed: UpdateMilestoneInput
      try {
        parsed = v.parse(UpdateMilestoneInputSchema, input)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Invalid RPC argument: ${message}`)
      }
      return cortexInstance.updateMilestone(parsed)
    },

    async updateInitiativePolicy(
      input: UpdateInitiativePolicyInput,
    ): Promise<InitiativePolicy> {
      let parsed: UpdateInitiativePolicyInput
      try {
        parsed = v.parse(UpdateInitiativePolicyInputSchema, input)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Invalid RPC argument: ${message}`)
      }
      return cortexInstance.saveInitiativePolicy(parsed)
    },

    async evaluateAttentionInitiative(
      input?: EvaluateInitiativeInput,
    ): Promise<ProactiveInitiativeRecord> {
      let parsed: EvaluateInitiativeInput
      try {
        parsed = v.parse(EvaluateInitiativeInputSchema, input ?? {})
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Invalid RPC argument: ${message}`)
      }
      const dndMode = parsed.forceDnd ?? agencyRuntimeInstance.privacyController.dndMode
      let record = cortexInstance.evaluateAttentionInitiative({
        ...parsed,
        forceDnd: dndMode,
      })
      if (
        record.decision === 'spoken' &&
        !parsed.simulatedReplyText &&
        providerVaultInstance.getPublicState().hasActiveReadyProvider
      ) {
        try {
          const model = providerVaultInstance.createActiveLanguageModel()
          const res = await generateText(
            model as unknown as Parameters<typeof generateText>[0],
            {
              messages: [
                {
                  role: 'system',
                  content:
                    'Você é Ashy no Cozy Night Studio. Escreva apenas a fala proativa curta (1 a 2 frases naturais em português) para iniciar conversa a partir do lembrete abaixo.',
                },
                {
                  role: 'user',
                  content: record.noticePrompt || record.sourceTitle,
                },
              ],
              temperature: 0.4,
              maxTokens: 160,
              reasoningEffort: 'none',
            },
          )
          const candidateReply = res.text
            .replace(/<\|ACT\s+[^|]+\|>/g, '')
            .replace(/<\|DELAY\s+[^|]+\|>/g, '')
            .replace(/<\|CALLBACK\s+[^|]+\|>/g, '')
            .replace(/\0/g, '')
            .trim()
          if (candidateReply.length >= 8 && !candidateReply.startsWith('data:')) {
            record = cortexInstance.db.insertProactiveInitiativeLog({
              ...record,
              replyText: candidateReply.slice(0, 500),
            })
          }
        } catch {
          // Keep grounded deterministic replyText fallback on error
        }
      }
      if (record.decision === 'spoken' && record.replyText) {
        let sessions = cortexInstance.listChatSessions()
        if (sessions.length === 0) {
          const initialSession = cortexInstance.createChatSession({
            id: 'session-initial',
            title: 'Primeiro Encontro',
          })
          sessions = [initialSession]
        }
        const targetSession =
          sessions.find((s) => s.id === activeSessionId) ?? sessions[0]!
        activeSessionId = targetSession.id
        cortexInstance.appendChatMessage({
          id: `msg-proactive-${record.id}`,
          sessionId: targetSession.id,
          role: 'assistant',
          content: record.replyText,
          rawContent: record.replyText,
          emotion: 'happy',
          markersJson: '[]',
          createdAt: record.createdAt,
        })
        cortexInstance.db.markChatMessagesConsolidated(
          [`msg-proactive-${record.id}`],
          `proactive-${record.id}`,
        )
      }
      return record
    },

    async updateStagePreferences(
      rawInput: UpdateStagePreferencesInput,
    ): Promise<PersistedStagePreferences> {
      let parsed: UpdateStagePreferencesInput
      try {
        parsed = v.parse(UpdateStagePreferencesInputSchema, rawInput)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Invalid RPC argument: ${message}`)
      }

      currentStagePreferences = {
        ...currentStagePreferences,
        ...(parsed.stageMode !== undefined ? { stageMode: parsed.stageMode } : {}),
        ...(parsed.live2dPresetId !== undefined ? { live2dPresetId: parsed.live2dPresetId } : {}),
        ...(parsed.live2dModelUrl !== undefined ? { live2dModelUrl: parsed.live2dModelUrl } : {}),
        ...(parsed.loadedLive2DModelName !== undefined
          ? { loadedLive2DModelName: parsed.loadedLive2DModelName }
          : {}),
        ...(parsed.live2dModelControls !== undefined
          ? { live2dModelControls: parsed.live2dModelControls }
          : {}),
        ...(parsed.ambientLuminance !== undefined
          ? { ambientLuminance: parsed.ambientLuminance }
          : {}),
        ...(parsed.showDesktopAvatar !== undefined
          ? { showDesktopAvatar: parsed.showDesktopAvatar }
          : {}),
        ...(parsed.isStageHidden !== undefined ? { isStageHidden: parsed.isStageHidden } : {}),
        updatedAt: Date.now(),
      }

      writeAtomicWithBackup(stagePreferencesPath, JSON.stringify(currentStagePreferences, null, 2))
      emitHostEvent({
        type: 'stage:updated',
        stagePreferences: currentStagePreferences,
      })
      return currentStagePreferences
    },

    async getVoiceRuntimeSettings(): Promise<VoiceRuntimeSettings> {
      return buildSanitizedVoiceRuntimeSettings(providerVaultInstance)
    },

    async saveVoiceRuntimeSettings(
      rawInput: SaveVoiceRuntimeSettingsInput,
    ): Promise<VoiceRuntimeSettings> {
      let parsed: SaveVoiceRuntimeSettingsInput
      try {
        parsed = v.parse(SaveVoiceRuntimeSettingsInputSchema, rawInput)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Invalid RPC argument: ${message}`)
      }

      const nextSttProvider =
        parsed.activeSttProviderId ?? currentVoiceSettings.activeSttProviderId
      const nextTtsProvider =
        parsed.activeTtsProviderId ?? currentVoiceSettings.activeTtsProviderId

      if (parsed.sttBaseUrl !== undefined) {
        const checkProvider =
          nextSttProvider === 'openai-whisper' || nextSttProvider === 'groq-whisper'
            ? extractUrlOrigin(parsed.sttBaseUrl) === 'https://api.openai.com' ||
              extractUrlOrigin(parsed.sttBaseUrl) === 'https://api.groq.com'
              ? nextSttProvider
              : 'local-whisper-http'
            : 'local-whisper-http'
        validateVoiceEndpointUrl(parsed.sttBaseUrl, checkProvider)
      }

      if (parsed.ttsBaseUrl !== undefined) {
        const checkProvider =
          nextTtsProvider === 'openai-tts' || nextTtsProvider === 'elevenlabs'
            ? extractUrlOrigin(parsed.ttsBaseUrl) === 'https://api.openai.com' ||
              extractUrlOrigin(parsed.ttsBaseUrl) === 'https://api.elevenlabs.io'
              ? nextTtsProvider
              : 'local-kokoro-http'
            : 'local-kokoro-http'
        validateVoiceEndpointUrl(parsed.ttsBaseUrl, checkProvider)
      }

      const nextSettings: StoredVoiceSettingsDocument = {
        ...currentVoiceSettings,
        ...(parsed.activeSttProviderId !== undefined
          ? { activeSttProviderId: parsed.activeSttProviderId }
          : {}),
        ...(parsed.activeTtsProviderId !== undefined
          ? { activeTtsProviderId: parsed.activeTtsProviderId }
          : {}),
        ...(parsed.sttBaseUrl !== undefined ? { sttBaseUrl: parsed.sttBaseUrl } : {}),
        ...(parsed.sttModelId !== undefined ? { sttModelId: parsed.sttModelId } : {}),
        ...(parsed.ttsBaseUrl !== undefined ? { ttsBaseUrl: parsed.ttsBaseUrl } : {}),
        ...(parsed.ttsModelId !== undefined ? { ttsModelId: parsed.ttsModelId } : {}),
        ...(parsed.ttsVoiceId !== undefined ? { ttsVoiceId: parsed.ttsVoiceId } : {}),
        ...(parsed.wakeWordEnabled !== undefined
          ? { wakeWordEnabled: parsed.wakeWordEnabled }
          : {}),
        ...(parsed.wakeWordPhrases !== undefined
          ? { wakeWordPhrases: [...parsed.wakeWordPhrases] }
          : {}),
        ...(parsed.groqSttModelId !== undefined
          ? { groqSttModelId: parsed.groqSttModelId }
          : {}),
        ...(parsed.openaiSttModelId !== undefined
          ? { openaiSttModelId: parsed.openaiSttModelId }
          : {}),
        ...(parsed.openaiTtsModelId !== undefined
          ? { openaiTtsModelId: parsed.openaiTtsModelId }
          : {}),
        ...(parsed.openaiTtsVoiceId !== undefined
          ? { openaiTtsVoiceId: parsed.openaiTtsVoiceId }
          : {}),
        ...(parsed.elevenLabsModelId !== undefined
          ? { elevenLabsModelId: parsed.elevenLabsModelId }
          : {}),
        ...(parsed.localKokoroModelId !== undefined
          ? { localKokoroModelId: parsed.localKokoroModelId }
          : {}),
        ...(parsed.localKokoroVoiceId !== undefined
          ? { localKokoroVoiceId: parsed.localKokoroVoiceId }
          : {}),
        ...(parsed.webSpeechLang !== undefined ? { webSpeechLang: parsed.webSpeechLang } : {}),
        ...(parsed.webSpeechVoiceURI !== undefined
          ? { webSpeechVoiceURI: parsed.webSpeechVoiceURI }
          : {}),
        ...(parsed.selectedMicDeviceId !== undefined
          ? { selectedMicDeviceId: parsed.selectedMicDeviceId }
          : {}),
        ...(parsed.unifiedOmniMode !== undefined
          ? { unifiedOmniMode: parsed.unifiedOmniMode }
          : {}),
        ...(parsed.directOmniAudio !== undefined
          ? { directOmniAudio: parsed.directOmniAudio }
          : {}),
        ...(parsed.autoSpeakReplies !== undefined
          ? { autoSpeakReplies: parsed.autoSpeakReplies }
          : {}),
      }

      if (parsed.clearOpenAiApiKey === true) {
        delete nextSettings.encryptedOpenAiApiKey
      } else if (typeof parsed.openaiApiKey === 'string' && parsed.openaiApiKey.trim().length > 0) {
        nextSettings.encryptedOpenAiApiKey = voiceSecretProtector.encrypt(
          parsed.openaiApiKey.trim(),
        )
      }

      if (parsed.clearGroqApiKey === true) {
        delete nextSettings.encryptedGroqApiKey
      } else if (typeof parsed.groqApiKey === 'string' && parsed.groqApiKey.trim().length > 0) {
        nextSettings.encryptedGroqApiKey = voiceSecretProtector.encrypt(parsed.groqApiKey.trim())
      }

      if (parsed.clearElevenLabsApiKey === true) {
        delete nextSettings.encryptedElevenLabsApiKey
      } else if (
        typeof parsed.elevenLabsApiKey === 'string' &&
        parsed.elevenLabsApiKey.trim().length > 0
      ) {
        nextSettings.encryptedElevenLabsApiKey = voiceSecretProtector.encrypt(
          parsed.elevenLabsApiKey.trim(),
        )
      }

      if (parsed.clearLocalSttApiKey === true) {
        delete nextSettings.encryptedLocalSttApiKey
      } else if (
        typeof parsed.localSttApiKey === 'string' &&
        parsed.localSttApiKey.trim().length > 0
      ) {
        nextSettings.encryptedLocalSttApiKey = voiceSecretProtector.encrypt(
          parsed.localSttApiKey.trim(),
        )
      }

      if (parsed.clearLocalTtsApiKey === true) {
        delete nextSettings.encryptedLocalTtsApiKey
      } else if (
        typeof parsed.localTtsApiKey === 'string' &&
        parsed.localTtsApiKey.trim().length > 0
      ) {
        nextSettings.encryptedLocalTtsApiKey = voiceSecretProtector.encrypt(
          parsed.localTtsApiKey.trim(),
        )
      }

      currentVoiceSettings = nextSettings
      writeAtomicWithBackup(voiceSettingsPath, JSON.stringify(currentVoiceSettings, null, 2))
      return buildSanitizedVoiceRuntimeSettings(providerVaultInstance)
    },

    async listVoiceProviderModels(
      rawInput: ListVoiceProviderModelsInput,
    ): Promise<VoiceProviderModelsCatalog> {
      let input: ListVoiceProviderModelsInput
      try {
        input = v.parse(ListVoiceProviderModelsInputSchema, rawInput)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Invalid RPC argument: ${message}`)
      }

      const fallbackCatalog = FALLBACK_VOICE_MODEL_CATALOG[input.providerId] ?? {
        models: [],
      }

      if (
        input.providerId === 'web-speech-stt' ||
        input.providerId === 'deterministic-wav-stt' ||
        input.providerId === 'web-speech-tts' ||
        input.providerId === 'local-synth-fallback'
      ) {
        return {
          kind: input.kind,
          providerId: input.providerId,
          models: [...fallbackCatalog.models],
          ...(fallbackCatalog.voices ? { voices: [...fallbackCatalog.voices] } : {}),
          source: 'fallback',
        }
      }

      const effectiveBaseUrl = resolveEffectiveVoiceBaseUrl(input.providerId, input.baseUrl)
      const apiKey = resolvePinnedVoiceApiKey(input.providerId, effectiveBaseUrl, input.apiKey)
      const safeFetch = createSafeVoiceFetch(input.providerId)

      try {
        if (input.providerId === 'elevenlabs') {
          const headers: Record<string, string> = {}
          if (apiKey) {
            headers['xi-api-key'] = apiKey
          }
          const voicesEndpoint = effectiveBaseUrl.endsWith('/voices')
            ? effectiveBaseUrl
            : `${effectiveBaseUrl}/voices`
          const res = await safeFetch(voicesEndpoint, { method: 'GET', headers })
          if (!res.ok) {
            throw new Error(`ElevenLabs voices catalog failed with HTTP ${res.status}`)
          }
          const json = (await res.json()) as {
            voices?: Array<{ voice_id?: string; name?: string }>
          }
          const voices: VoiceProviderModelOption[] = Array.isArray(json.voices)
            ? json.voices
                .filter((vItem) => typeof vItem?.voice_id === 'string' && vItem.voice_id.trim())
                .map((vItem) => ({
                  id: vItem.voice_id!.trim(),
                  label:
                    typeof vItem.name === 'string' && vItem.name.trim()
                      ? vItem.name.trim()
                      : vItem.voice_id!.trim(),
                }))
            : []

          return {
            kind: 'tts',
            providerId: 'elevenlabs',
            models: [...fallbackCatalog.models],
            voices: voices.length > 0 ? voices : [...(fallbackCatalog.voices ?? [])],
            source: 'remote',
          }
        }

        const headers: Record<string, string> = {}
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`
        }

        const modelsEndpoint = effectiveBaseUrl.endsWith('/models')
          ? effectiveBaseUrl
          : `${effectiveBaseUrl}/models`
        const res = await safeFetch(modelsEndpoint, { method: 'GET', headers })
        if (!res.ok) {
          throw new Error(`${input.providerId} models catalog failed with HTTP ${res.status}`)
        }

        const json = (await res.json()) as {
          data?: Array<{ id?: string; name?: string }>
          models?: Array<{ id?: string; name?: string }>
        }
        const rawList = Array.isArray(json.data)
          ? json.data
          : Array.isArray(json.models)
            ? json.models
            : []
        const remoteModels: VoiceProviderModelOption[] = rawList
          .filter((item) => typeof item?.id === 'string' && item.id.trim().length > 0)
          .map((item) => ({
            id: item.id!.trim(),
            label:
              typeof item.name === 'string' && item.name.trim().length > 0
                ? item.name.trim()
                : item.id!.trim(),
          }))

        let remoteVoices = fallbackCatalog.voices ? [...fallbackCatalog.voices] : undefined
        if (input.providerId === 'local-kokoro-http') {
          try {
            const voicesRes = await safeFetch(`${effectiveBaseUrl}/audio/voices`, {
              method: 'GET',
              headers,
            })
            if (voicesRes.ok) {
              const voicesJson = (await voicesRes.json()) as {
                voices?: Array<string | { id?: string; name?: string }>
              }
              if (Array.isArray(voicesJson.voices) && voicesJson.voices.length > 0) {
                remoteVoices = voicesJson.voices
                  .map((vEntry) =>
                    typeof vEntry === 'string'
                      ? { id: vEntry.trim(), label: vEntry.trim() }
                      : {
                          id: String(vEntry?.id ?? '').trim(),
                          label: String(vEntry?.name ?? vEntry?.id ?? '').trim(),
                        },
                  )
                  .filter((vEntry) => vEntry.id.length > 0)
              }
            }
          } catch {
            // Keep default Kokoro voices if /audio/voices is not supported
          }
        }

        return {
          kind: input.kind,
          providerId: input.providerId,
          models: remoteModels.length > 0 ? remoteModels : [...fallbackCatalog.models],
          ...(remoteVoices ? { voices: remoteVoices } : {}),
          source: 'remote',
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          kind: input.kind,
          providerId: input.providerId,
          models: [...fallbackCatalog.models],
          ...(fallbackCatalog.voices ? { voices: [...fallbackCatalog.voices] } : {}),
          source: 'fallback',
          error: message,
        }
      }
    },

    async transcribeVoiceAudio(
      rawInput: TranscribeVoiceAudioInput,
    ): Promise<VoiceTranscribeAudioResult> {
      let input: TranscribeVoiceAudioInput
      try {
        input = v.parse(TranscribeVoiceAudioInputSchema, rawInput)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Invalid RPC argument: ${message}`)
      }

      const wavBytes = new Uint8Array(Buffer.from(input.audioBase64, 'base64'))
      const decoded = decodeWavToPcmBlocks(wavBytes, 20)
      const providerId: SttProviderId =
        input.providerId ?? currentVoiceSettings.activeSttProviderId
      const language = input.language ?? currentVoiceSettings.webSpeechLang ?? 'pt'

      if (providerId === 'deterministic-wav-stt' || providerId === 'web-speech-stt') {
        const det = createDeterministicWavSttProvider()
        const res = await det.transcribe({
          blocks: decoded.blocks,
          language,
          metadataComment: decoded.metadataComment ?? undefined,
        })
        return {
          providerId,
          text: res.text,
          latencyMs: res.latencyMs,
          confidence: res.confidence,
        }
      }

      const effectiveBaseUrl = resolveEffectiveVoiceBaseUrl(providerId, input.baseUrl)
      const apiKey = resolvePinnedVoiceApiKey(providerId, effectiveBaseUrl)
      const safeFetch = createSafeVoiceFetch(providerId)

      if (providerId === 'openai-whisper') {
        const modelId =
          input.modelId ??
          currentVoiceSettings.openaiSttModelId ??
          currentVoiceSettings.sttModelId ??
          'whisper-1'
        const provider = createOpenAiWhisperSttProvider({
          baseUrl: effectiveBaseUrl,
          apiKey,
          modelId,
          language,
          allowOfflineFallback: false,
          fetchImpl: safeFetch,
        })
        const res = await provider.transcribe({ blocks: decoded.blocks, language })
        return {
          providerId: 'openai-whisper',
          text: res.text,
          latencyMs: res.latencyMs,
          confidence: res.confidence,
        }
      }

      if (providerId === 'groq-whisper') {
        const modelId =
          input.modelId ??
          currentVoiceSettings.groqSttModelId ??
          'whisper-large-v3-turbo'
        const provider = createGroqWhisperSttProvider({
          baseUrl: effectiveBaseUrl,
          apiKey,
          modelId,
          language,
          allowOfflineFallback: false,
          fetchImpl: safeFetch,
        })
        const res = await provider.transcribe({ blocks: decoded.blocks, language })
        return {
          providerId: 'groq-whisper',
          text: res.text,
          latencyMs: res.latencyMs,
          confidence: res.confidence,
        }
      }

      const modelId = input.modelId ?? currentVoiceSettings.sttModelId ?? 'whisper-1'
      const provider = createLocalWhisperHttpSttProvider({
        baseUrl: effectiveBaseUrl,
        apiKey,
        modelId,
        language,
        allowOfflineFallback: false,
        fetchImpl: safeFetch,
      })
      const res = await provider.transcribe({ blocks: decoded.blocks, language })
      return {
        providerId: 'local-whisper-http',
        text: res.text,
        latencyMs: res.latencyMs,
        confidence: res.confidence,
      }
    },

    async synthesizeVoiceSpeech(
      rawInput: SynthesizeVoiceSpeechInput,
    ): Promise<VoiceSynthesizeSpeechResult> {
      let input: SynthesizeVoiceSpeechInput
      try {
        input = v.parse(SynthesizeVoiceSpeechInputSchema, rawInput)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Invalid RPC argument: ${message}`)
      }

      const providerId: TtsProviderId =
        input.providerId ?? currentVoiceSettings.activeTtsProviderId

      const formatResult = (
        resolvedProviderId: TtsProviderId,
        synth: Awaited<ReturnType<ReturnType<typeof createLocalSynthFallbackTtsProvider>['synthesize']>>,
      ): VoiceSynthesizeSpeechResult => {
        const wavBytes = encodeWavPcm16(synth.samples, synth.sampleRate)
        const audioBase64 = Buffer.from(wavBytes).toString('base64')
        const frameCount = Math.max(1, synth.vowelFrames.length)
        const frameDurationSec = synth.durationSec / frameCount
        const vowelFrames: VoiceSynthesizedVowelFrame[] = synth.vowelFrames.map((f, idx) => {
          const entries: Array<['A' | 'E' | 'I' | 'O' | 'U', number]> = [
            ['A', f.A],
            ['E', f.E],
            ['I', f.I],
            ['O', f.O],
            ['U', f.U],
          ]
          entries.sort((a, b) => b[1] - a[1])
          const dominantVowel = entries[0]![1] > 0.02 ? entries[0]![0] : 'closed'
          return {
            timeSec: Number((idx * frameDurationSec).toFixed(4)),
            durationSec: Number(frameDurationSec.toFixed(4)),
            A: f.A,
            E: f.E,
            I: f.I,
            O: f.O,
            U: f.U,
            dominantVowel,
          }
        })

        return {
          providerId: resolvedProviderId,
          audioBase64,
          mimeType: 'audio/wav',
          sampleRate: synth.sampleRate,
          durationMs: synth.durationMs,
          durationSec: synth.durationSec,
          synthesisLatencyMs: synth.synthesisLatencyMs,
          vowelFrames,
        }
      }

      // Red-Team C2: local-synth-fallback (and host fallback for web-speech-tts) never calls fetchImpl
      if (providerId === 'local-synth-fallback' || providerId === 'web-speech-tts') {
        const localSynth = createLocalSynthFallbackTtsProvider()
        const synth = await localSynth.synthesize({
          text: input.text,
          voiceId: input.voiceId ?? currentVoiceSettings.ttsVoiceId,
          modelId: input.modelId ?? currentVoiceSettings.ttsModelId,
        })
        return formatResult(providerId, synth)
      }

      const effectiveBaseUrl = resolveEffectiveVoiceBaseUrl(providerId, input.baseUrl)
      const apiKey = resolvePinnedVoiceApiKey(providerId, effectiveBaseUrl)
      const safeFetch = createSafeVoiceFetch(providerId)

      if (providerId === 'elevenlabs') {
        const modelId =
          input.modelId ??
          currentVoiceSettings.elevenLabsModelId ??
          'eleven_multilingual_v2'
        const voiceId = input.voiceId ?? currentVoiceSettings.ttsVoiceId ?? 'ashy-pt-br'
        const provider = createElevenLabsTtsProvider({
          baseUrl: effectiveBaseUrl,
          apiKey,
          modelId,
          voiceId,
          allowOfflineFallback: false,
          fetchImpl: safeFetch,
        })
        const synth = await provider.synthesize({ text: input.text, modelId, voiceId })
        return formatResult('elevenlabs', synth)
      }

      if (providerId === 'openai-tts') {
        const modelId =
          input.modelId ?? currentVoiceSettings.openaiTtsModelId ?? 'tts-1'
        const voiceId =
          input.voiceId ?? currentVoiceSettings.openaiTtsVoiceId ?? 'nova'
        const provider = createOpenAiTtsProvider({
          baseUrl: effectiveBaseUrl,
          apiKey,
          modelId,
          voiceId,
          allowOfflineFallback: false,
          fetchImpl: safeFetch,
        })
        const synth = await provider.synthesize({ text: input.text, modelId, voiceId })
        return formatResult('openai-tts', synth)
      }

      const modelId =
        input.modelId ??
        currentVoiceSettings.localKokoroModelId ??
        currentVoiceSettings.ttsModelId ??
        'kokoro-v1'
      const voiceId =
        input.voiceId ??
        currentVoiceSettings.localKokoroVoiceId ??
        currentVoiceSettings.ttsVoiceId ??
        'ashy-pt-br'
      const provider = createLocalKokoroHttpTtsProvider({
        baseUrl: effectiveBaseUrl,
        apiKey,
        modelId,
        voiceId,
        allowOfflineFallback: false,
        fetchImpl: safeFetch,
      })
      const synth = await provider.synthesize({ text: input.text, modelId, voiceId })
      return formatResult('local-kokoro-http', synth)
    },

    async exportSoul(rawInput?: ExportSoulInput): Promise<AshySoulArchive> {
      let parsed: ExportSoulInput
      try {
        parsed = v.parse(ExportSoulInputSchema, rawInput)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Invalid RPC argument: ${message}`)
      }

      const cortexSnapshot = cortexInstance.exportSoulSnapshot()
      if (parsed?.includeChatHistory === false) {
        cortexSnapshot.chatSessions = []
        cortexSnapshot.chatMessages = []
      }
      if (parsed?.includeAuditLog === false) {
        cortexSnapshot.actionAuditLog = []
      }

      const voiceIdentityMarkdown = voiceStoreInstance.get().markdown
      const stagePreferences: PersistedStagePreferences = { ...currentStagePreferences }
      const voicePreferences: VoiceRuntimeSettings = {
        ...buildSanitizedVoiceRuntimeSettings(providerVaultInstance),
        hasOpenAiApiKey: false,
        hasGroqApiKey: false,
        hasElevenLabsApiKey: false,
        hasLocalSttApiKey: false,
        hasLocalTtsApiKey: false,
        maskedOpenAiApiKey: null,
        maskedGroqApiKey: null,
        maskedElevenLabsApiKey: null,
      }

      const payload: AshySoulBundlePayload = {
        formatVersion: 1,
        schemaVersion: CURRENT_SOUL_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        appVersion: '1.0.0',
        cortex: cortexSnapshot,
        voiceIdentityMarkdown,
        stagePreferences,
        voicePreferences,
      }

      const checksumSha256 = crypto
        .createHash('sha256')
        .update(canonicalizeJson(payload), 'utf8')
        .digest('hex')

      return {
        magic: 'ASHY_SOUL_V1',
        checksumSha256,
        payload,
      }
    },

    async importSoul(rawInput: ImportSoulInput): Promise<AshyBootstrapSnapshot> {
      if (!rawInput || typeof rawInput !== 'object') {
        throw new Error('Invalid RPC argument: importSoul requires an object input')
      }
      canonicalizeJson(rawInput)
      const parsedInput = v.parse(ImportSoulInputSchema, rawInput)

      const rawArchiveObj =
        typeof parsedInput.archive === 'string'
          ? safeJsonParseWithoutProto(parsedInput.archive)
          : parsedInput.archive

      canonicalizeJson(rawArchiveObj)
      const archive = v.parse(AshySoulArchiveSchema, rawArchiveObj)

      const expectedHex = crypto
        .createHash('sha256')
        .update(canonicalizeJson(archive.payload), 'utf8')
        .digest('hex')
      const expectedBuf = Buffer.from(expectedHex, 'hex')
      const providedBuf = Buffer.from(archive.checksumSha256.toLowerCase(), 'hex')

      if (
        expectedBuf.length !== providedBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, providedBuf)
      ) {
        throw new Error('SOUL_CHECKSUM_MISMATCH: Soul archive checksum verification failed')
      }

      if (
        typeof archive.payload.voiceIdentityMarkdown !== 'string' ||
        archive.payload.voiceIdentityMarkdown.includes('\0') ||
        archive.payload.voiceIdentityMarkdown.trim().length < 16
      ) {
        throw new Error(
          'Invalid voiceIdentityMarkdown in Soul archive: must contain at least 16 non-whitespace characters and no null bytes',
        )
      }

      if (archive.payload.stagePreferences) {
        v.parse(UpdateStagePreferencesInputSchema, archive.payload.stagePreferences)
      }

      kernelEpoch += 1
      clearDreamIdleTimer()
      turnOrchestratorInstance.abortAll()

      cortexInstance.importSoulSnapshot(archive.payload.cortex)
      voiceStoreInstance.save(archive.payload.voiceIdentityMarkdown)

      if (archive.payload.stagePreferences) {
        applyStagePreferencesUpdate(archive.payload.stagePreferences)
      }

      const restoredConsent = cortexInstance.db.getAgencyConsentState()
      await agencyRuntimeInstance.updateConsent({
        eyesMode: restoredConsent.eyesMode,
        micMode: restoredConsent.micMode,
        dndMode: restoredConsent.dndMode,
        approvalPolicy: restoredConsent.approvalPolicy,
        allowedPaths: restoredConsent.allowedPaths,
        allowedWindowTitles: restoredConsent.allowedWindowTitles,
        toolRiskOverrides: restoredConsent.toolRiskOverrides,
      })

      const restoredSessions = cortexInstance.listChatSessions()
      activeSessionId = restoredSessions[0]?.id ?? 'session-initial'

      return buildSnapshot(cortexInstance, voiceStoreInstance, providerVaultInstance)
    },

    async wipeAllData(): Promise<AshyBootstrapSnapshot> {
      kernelEpoch += 1
      clearDreamIdleTimer()
      turnOrchestratorInstance.abortAll()

      dominantEmotion = 'neutral'
      lastPersistenceWarning = null
      lastEvalReport = null
      activeSessionId = 'session-initial'

      cortexInstance.wipeAll()
      providerVaultInstance.resetAll()
      voiceStoreInstance.reset()

      removeFileAtomicWithBackups(voiceSettingsPath, 3)
      currentVoiceSettings = createDefaultStoredVoiceSettings()

      removeFileAtomicWithBackups(stagePreferencesPath, 3)
      currentStagePreferences = { ...DEFAULT_PERSISTED_STAGE_PREFERENCES }

      agencyRuntimeInstance.revokeSessionPermissions()
      await agencyRuntimeInstance.updateConsent({
        eyesMode: DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.eyesMode,
        micMode: DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.micMode,
        dndMode: DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.dndMode,
        approvalPolicy: DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.approvalPolicy,
        allowedPaths: [...DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.allowedPaths],
        allowedWindowTitles: [...DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.allowedWindowTitles],
        toolRiskOverrides: {},
      })

      return buildSnapshot(cortexInstance, voiceStoreInstance, providerVaultInstance)
    },

    async setEncryptionAtRest(
      rawInput: SetEncryptionAtRestInput,
    ): Promise<AshyBootstrapSnapshot> {
      const parsed = v.parse(SetEncryptionAtRestInputSchema, rawInput)
      kernelEpoch += 1
      cortexInstance.setEncryptionAtRest(parsed.enabled, cortexEncryptionCodec)
      voiceStoreInstance.rewrapForEncryptionState()
      encryptionUpdatedAt =
        cortexInstance.db.getEncryptionUpdatedAt() ?? new Date().toISOString()
      return buildSnapshot(cortexInstance, voiceStoreInstance, providerVaultInstance)
    },

    async getEncryptionAtRestStatus(): Promise<EncryptionAtRestStatus> {
      return {
        enabled: cortexInstance.isEncryptionAtRestEnabled(),
        algorithm: 'AES-256-GCM',
        keyBackend: voiceSecretProtector.getBackendKind(),
        updatedAt: encryptionUpdatedAt ?? cortexInstance.db.getEncryptionUpdatedAt(),
      }
    },

    async activatePrivacyShield(): Promise<AshyBootstrapSnapshot> {
      kernelEpoch += 1
      clearDreamIdleTimer()
      turnOrchestratorInstance.abortAll()
      agencyRuntimeInstance.revokeSessionPermissions()
      await agencyRuntimeInstance.updateConsent({
        micMode: 'muted',
        eyesMode: 'off',
        dndMode: true,
      })
      return buildSnapshot(cortexInstance, voiceStoreInstance, providerVaultInstance)
    },

    async getUpdateState(): Promise<AutoUpdaterState> {
      return { ...currentUpdaterState }
    },

    async checkForUpdates(): Promise<AutoUpdaterState> {
      currentUpdaterState = {
        ...currentUpdaterState,
        status: 'not-available',
        checkedAt: new Date().toISOString(),
        errorMessage: null,
      }
      emitHostEvent({
        type: 'updater:status',
        state: { ...currentUpdaterState },
      })
      return { ...currentUpdaterState }
    },

    async downloadUpdate(): Promise<AutoUpdaterState> {
      return { ...currentUpdaterState }
    },

    async quitAndInstallUpdate(): Promise<{ ok: boolean }> {
      return { ok: true }
    },

    onHostEvent(listener: (event: AshyHostStreamEvent) => void): () => void {
      hostEventListeners.add(listener)
      const unsubOrchestrator = turnOrchestratorInstance.onEvent(listener)
      return () => {
        hostEventListeners.delete(listener)
        unsubOrchestrator()
      }
    },
  }
}
