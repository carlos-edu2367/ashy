/**
 * Phase 10 — Live Call Engine shared contracts.
 * Spec: docs/superpowers/specs/2026-10-31-phase-10-live-call-engine-design.md
 *
 * Kept in its own module so parallel implementation tasks don't collide on host-protocol.ts.
 * All Live Call RPCs go through ONE generic RPC (`liveCall:invoke`) and are routed host-side by
 * a handler registry, so adding a method never touches the transport plumbing again.
 */
import * as v from 'valibot'

// ───────────────────────────── Live Mode settings ─────────────────────────────

export const LIVE_BACKEND_IDS = [
  'llamacpp-realtime',
  'llamacpp-hybrid',
  'gemini-live',
  'openai-realtime',
  'cascade',
] as const
export type LiveBackendId = (typeof LIVE_BACKEND_IDS)[number]
export const LiveBackendIdSchema = v.picklist(LIVE_BACKEND_IDS)

/** Phase 10.1 implements only these backends; others are rejected by `call:start`. */
export const LIVE_BACKENDS_IMPLEMENTED: readonly LiveBackendId[] = [
  'llamacpp-realtime',
  'llamacpp-hybrid',
  'openai-realtime',
  'gemini-live',
  'cascade',
]

export const LIVE_INPUT_MODES = ['transcribed', 'audio-direct'] as const
export type LiveInputMode = (typeof LIVE_INPUT_MODES)[number]

export interface LiveModeSettings {
  backend: LiveBackendId
  llamacpp: {
    modelId: string
    voice: 'female' | 'male'
    inputMode: LiveInputMode
    /** 'managed' = Ashy-managed llama-server; otherwise a user-provided base URL (http://host:port). */
    endpoint: 'managed' | { url: string }
    maxOutputTokens: number
  }
  turn: {
    vadThreshold: number
    minSpeechMs: number
    endpointMs: number
    graceMs: number
    preRollMs: number
    pushToTalk: boolean
  }
  interrupt: {
    enabled: boolean
    bargeInMinMs: number
    falseInterruptionMs: number
    aecWarmupMs: number
  }
  /** Hybrid: realtime session answers in text, llama-server /tts speaks it (optionally with the user's reference voice). */
  hybrid: {
    referenceVoiceId: string | null
    /** Max /tts requests in flight (ordered playback). */
    maxParallelTts: number
  }
  session: {
    /**
     * Safety net: rotate the realtime session (seeded with a short recap) after this many turns.
     * Default 40. A one-continuous-session call is what keeps LFM3-2B coherent — the 2026-11-01
     * real report showed rotation-with-recap (then triggered on every near-repeat) locking Ashy
     * into repeating the recap's greeting on every turn.
     */
    rotateAfterTurns: number
  }
  /**
   * Phase 10.4 — 'openai-realtime' backend = ANY OpenAI-Realtime-compatible speech-to-speech endpoint
   * (OpenAI gpt-realtime*, Alibaba Qwen-Omni realtime via DashScope, Azure, or a custom URL).
   * The API key lives in the host (`liveMode:setApiKey`) and is injected by the main process.
   */
  realtimeCloud: {
    provider: CloudRealtimeProvider
    /** Full wss URL (without query); empty = provider default. */
    url: string
    model: string
    voice: string
  }
  /**
   * Phase 10.4 — how much of Ashy goes into a cloud realtime session (big models handle it).
   * Optional; host defaults: persona on, 12 recent messages, 4 memories per turn, 16000 chars.
   */
  cloudContext?: {
    includePersona?: boolean
    recentMessages?: number
    memoryTopK?: number
    maxInstructionsChars?: number
  }
  /** Phase 10.4 — Google Gemini Live (native audio). */
  gemini: {
    model: string
    voice: string
  }
  /** Phase 10.5 — classic pipeline: STT → any text LLM (full Ashy context + tools) → chunked TTS. */
  cascade: {
    /** One of the voice STT provider ids (e.g. 'ollama-transcriptions', 'local-whisper-http', 'openai-whisper', 'groq-whisper'). */
    sttProviderId: string
    /** 'chat-default' = the active chat provider/model of the app. */
    llmProviderId: string
    /** Optional model override for the LLM provider ('' = provider's configured model). */
    llmModelId: string
    ttsProviderId: CascadeTtsProviderId
    /** Voice for the TTS provider ('female'/'male' for llama.cpp /tts, provider voice id otherwise). */
    ttsVoice: string
    /** Optional reference voice (llama.cpp /tts only). */
    referenceVoiceId: string | null
  }
  devices: { inputDeviceId?: string; outputDeviceId?: string }
  features: {
    toolsInCall: boolean
    visionInCall: boolean
    initiativeInCall: boolean
    idleNudgeSec: number
  }
}

export const CLOUD_REALTIME_PROVIDERS = ['openai', 'qwen', 'custom'] as const
export type CloudRealtimeProvider = (typeof CLOUD_REALTIME_PROVIDERS)[number]
/** Defaults per OpenAI-Realtime-compatible provider (URL is the WebSocket endpoint without query). */
export const CLOUD_REALTIME_PRESETS: Record<CloudRealtimeProvider, { url: string; model: string; voice: string; label: string }> = {
  openai: { url: 'wss://api.openai.com/v1/realtime', model: 'gpt-realtime-2.1-mini', voice: 'marin', label: 'OpenAI Realtime' },
  qwen: { url: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime', model: 'qwen3.5-omni-flash-realtime', voice: 'Tina', label: 'Qwen-Omni Realtime (DashScope)' },
  custom: { url: '', model: '', voice: '', label: 'Personalizado (compatível com OpenAI Realtime)' },
}
export const GEMINI_LIVE_DEFAULTS = { model: 'gemini-3.8-live', voice: 'Kore' } as const

export const CASCADE_TTS_PROVIDER_IDS = ['llamacpp-tts', 'local-kokoro-http', 'openai-tts', 'elevenlabs'] as const
export type CascadeTtsProviderId = (typeof CASCADE_TTS_PROVIDER_IDS)[number]

/** Providers whose API key is stored for Live Mode cloud backends. */
export const LIVE_KEY_PROVIDERS = ['openai', 'qwen', 'custom', 'gemini'] as const
export type LiveKeyProvider = (typeof LIVE_KEY_PROVIDERS)[number]

export const DEFAULT_LIVE_MODE_SETTINGS: LiveModeSettings = {
  backend: 'llamacpp-hybrid',
  llamacpp: {
    modelId: 'lfm3-omni-2b-q4km',
    voice: 'female',
    inputMode: 'transcribed',
    endpoint: 'managed',
    maxOutputTokens: 400,
  },
  turn: {
    vadThreshold: 0.5,
    minSpeechMs: 250,
    endpointMs: 700,
    graceMs: 1500,
    preRollMs: 360,
    pushToTalk: false,
  },
  interrupt: {
    enabled: true,
    bargeInMinMs: 400,
    falseInterruptionMs: 1500,
    aecWarmupMs: 1500,
  },
  hybrid: {
    referenceVoiceId: null,
    maxParallelTts: 2,
  },
  session: {
    rotateAfterTurns: 40,
  },
  realtimeCloud: {
    provider: 'openai',
    url: '',
    model: 'gpt-realtime-2.1-mini',
    voice: 'marin',
  },
  gemini: {
    model: 'gemini-3.8-live',
    voice: 'Kore',
  },
  cascade: {
    sttProviderId: 'ollama-transcriptions',
    llmProviderId: 'chat-default',
    llmModelId: '',
    ttsProviderId: 'llamacpp-tts',
    ttsVoice: 'female',
    referenceVoiceId: null,
  },
  devices: {},
  features: {
    toolsInCall: false,
    visionInCall: false,
    initiativeInCall: false,
    idleNudgeSec: 90,
  },
}

const EndpointSchema = v.union([
  v.literal('managed'),
  v.object({ url: v.pipe(v.string(), v.trim(), v.url(), v.maxLength(512)) }),
])

/** Partial update accepted by `liveMode:saveSettings` (deep-merged host-side). */
export const SaveLiveModeSettingsInputSchema = v.object({
  backend: v.optional(LiveBackendIdSchema),
  llamacpp: v.optional(
    v.object({
      modelId: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(128))),
      voice: v.optional(v.picklist(['female', 'male'] as const)),
      inputMode: v.optional(v.picklist(LIVE_INPUT_MODES)),
      endpoint: v.optional(EndpointSchema),
      maxOutputTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(32), v.maxValue(4096))),
    }),
  ),
  turn: v.optional(
    v.object({
      vadThreshold: v.optional(v.pipe(v.number(), v.minValue(0.05), v.maxValue(0.95))),
      minSpeechMs: v.optional(v.pipe(v.number(), v.minValue(50), v.maxValue(2000))),
      endpointMs: v.optional(v.pipe(v.number(), v.minValue(200), v.maxValue(4000))),
      graceMs: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(5000))),
      preRollMs: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1500))),
      pushToTalk: v.optional(v.boolean()),
    }),
  ),
  interrupt: v.optional(
    v.object({
      enabled: v.optional(v.boolean()),
      bargeInMinMs: v.optional(v.pipe(v.number(), v.minValue(100), v.maxValue(3000))),
      falseInterruptionMs: v.optional(v.pipe(v.number(), v.minValue(300), v.maxValue(5000))),
      aecWarmupMs: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(5000))),
    }),
  ),
  devices: v.optional(
    v.object({
      inputDeviceId: v.optional(v.pipe(v.string(), v.maxLength(256))),
      outputDeviceId: v.optional(v.pipe(v.string(), v.maxLength(256))),
    }),
  ),
  realtimeCloud: v.optional(
    v.object({
      provider: v.optional(v.picklist(CLOUD_REALTIME_PROVIDERS)),
      url: v.optional(v.union([v.literal(''), v.pipe(v.string(), v.trim(), v.regex(/^(wss:\/\/[^\s]+|ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[^\s]*)?)$/), v.maxLength(512))])),
      model: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(128))),
      voice: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
    }),
  ),
  cloudContext: v.optional(
    v.object({
      includePersona: v.optional(v.boolean()),
      recentMessages: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(60))),
      memoryTopK: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(12))),
      maxInstructionsChars: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2000), v.maxValue(60000))),
    }),
  ),
  gemini: v.optional(
    v.object({
      model: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(128))),
      voice: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
    }),
  ),
  cascade: v.optional(
    v.object({
      sttProviderId: v.optional(v.pipe(v.string(), v.maxLength(64))),
      llmProviderId: v.optional(v.pipe(v.string(), v.maxLength(64))),
      llmModelId: v.optional(v.pipe(v.string(), v.maxLength(256))),
      ttsProviderId: v.optional(v.picklist(CASCADE_TTS_PROVIDER_IDS)),
      ttsVoice: v.optional(v.pipe(v.string(), v.maxLength(128))),
      referenceVoiceId: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,64}$/)))),
    }),
  ),
  hybrid: v.optional(
    v.object({
      referenceVoiceId: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,64}$/)))),
      maxParallelTts: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4))),
    }),
  ),
  session: v.optional(
    v.object({
      rotateAfterTurns: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(50))),
    }),
  ),
  features: v.optional(
    v.object({
      toolsInCall: v.optional(v.boolean()),
      visionInCall: v.optional(v.boolean()),
      initiativeInCall: v.optional(v.boolean()),
      idleNudgeSec: v.optional(v.pipe(v.number(), v.minValue(20), v.maxValue(3600))),
    }),
  ),
})
export type SaveLiveModeSettingsInput = v.InferOutput<typeof SaveLiveModeSettingsInputSchema>

// ───────────────────────────── Local engines (llama.cpp) ─────────────────────────────

export const LLAMACPP_VARIANTS = ['cuda-12.4', 'vulkan', 'cpu'] as const
export type LlamaCppVariant = (typeof LLAMACPP_VARIANTS)[number]

export interface PinnedDownloadAsset {
  url: string
  fileName: string
  sizeBytes: number
  sha256: string
}

/** Pinned llama.cpp release (verified 2026-10-31 via GitHub API asset digests). */
export const LLAMACPP_PINNED_BUILD = 'b12024'
const LLAMACPP_RELEASE_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMACPP_PINNED_BUILD}`
export const LLAMACPP_RELEASE_ASSETS: Record<LlamaCppVariant, PinnedDownloadAsset[]> = {
  'cuda-12.4': [
    {
      url: `${LLAMACPP_RELEASE_BASE}/llama-${LLAMACPP_PINNED_BUILD}-bin-win-cuda-12.4-x64.zip`,
      fileName: `llama-${LLAMACPP_PINNED_BUILD}-bin-win-cuda-12.4-x64.zip`,
      sizeBytes: 279945240,
      sha256: '6eed15a36babfdbb6ed4b28839282395abeb6209081cb4d44070bb3e6a7fb5a7',
    },
    {
      url: `${LLAMACPP_RELEASE_BASE}/cudart-llama-bin-win-cuda-12.4-x64.zip`,
      fileName: 'cudart-llama-bin-win-cuda-12.4-x64.zip',
      sizeBytes: 391443627,
      sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
    },
  ],
  vulkan: [
    {
      url: `${LLAMACPP_RELEASE_BASE}/llama-${LLAMACPP_PINNED_BUILD}-bin-win-vulkan-x64.zip`,
      fileName: `llama-${LLAMACPP_PINNED_BUILD}-bin-win-vulkan-x64.zip`,
      sizeBytes: 37516123,
      sha256: 'a843d12c9cc3ae30e29646918f9dc4d0c7a60348499b0af497661f3b6aafc9a8',
    },
  ],
  cpu: [
    {
      url: `${LLAMACPP_RELEASE_BASE}/llama-${LLAMACPP_PINNED_BUILD}-bin-win-cpu-x64.zip`,
      fileName: `llama-${LLAMACPP_PINNED_BUILD}-bin-win-cpu-x64.zip`,
      sizeBytes: 24574821,
      sha256: 'a8a1bc0167c594c377255e54aab617b288a38e09efb50f39ac5bd087e4398f72',
    },
  ],
}

export interface LiveLocalModelSpec {
  id: string
  label: string
  repo: string
  /** Pinned HF revision (commit sha). */
  revision: string
  model: PinnedDownloadAsset
  mmproj: PinnedDownloadAsset
  contextSize: number
  capabilities: { audioIn: boolean; audioOut: boolean; imageIn: boolean; tools: boolean }
}

const LFM3_OMNI_REPO = 'LiquidAI/LFM3-Omni-2B-GGUF'
const LFM3_OMNI_REV = '3d29af2ad166f8299c2d820937e47dc0add20ffc'
const hf = (file: string) => `https://huggingface.co/${LFM3_OMNI_REPO}/resolve/${LFM3_OMNI_REV}/${file}`

/** Catalog of models the managed llama-server can run for Live Mode (sha256 = HF LFS oid). */
export const LIVE_LOCAL_MODELS: LiveLocalModelSpec[] = [
  {
    id: 'lfm3-omni-2b-q4km',
    label: 'LFM3-Omni 2B (Q4_K_M + mmproj Q8_0)',
    repo: LFM3_OMNI_REPO,
    revision: LFM3_OMNI_REV,
    model: {
      url: hf('LFM3-Omni-2B-Q4_K_M.gguf'),
      fileName: 'LFM3-Omni-2B-Q4_K_M.gguf',
      sizeBytes: 1099630080,
      sha256: '9f8d30e9d4fd7a9349d586e077988229b3ca0a0e4ad730897563d1eccc9893e2',
    },
    mmproj: {
      url: hf('mmproj-LFM3-Omni-2B-Q8_0.gguf'),
      fileName: 'mmproj-LFM3-Omni-2B-Q8_0.gguf',
      sizeBytes: 506842528,
      sha256: '8a25f9d1931244429de404fccacfb7fb933970a36aa5688d2f5069f29c6b27b1',
    },
    contextSize: 16384,
    capabilities: { audioIn: true, audioOut: true, imageIn: true, tools: true },
  },
]

export interface EngineDownloadProgress {
  fileName: string
  phase: 'binary' | 'model'
  status: 'downloading' | 'verifying' | 'extracting' | 'completed' | 'error'
  completedBytes: number
  totalBytes: number
  percent: number
  error?: string
}

export interface DetectedGpu {
  vendor: 'nvidia' | 'amd' | 'intel' | 'other' | 'none'
  name?: string
  vramMb?: number
  recommendedVariant: LlamaCppVariant
}

export interface LlamaCppEngineStatus {
  engineId: 'llamacpp'
  build: string
  installed: boolean
  installedVariant: LlamaCppVariant | null
  detectedGpu: DetectedGpu | null
  running: boolean
  managed: boolean
  baseUrl: string | null
  port: number | null
  activeModelId: string | null
  installedModelIds: string[]
  activeDownload: EngineDownloadProgress | null
  lastError: string | null
  /**
   * Windows only: the Microsoft Visual C++ 2015-2022 x64 runtime DLLs llama-server needs are not
   * present (System32 or app-local). Always `false` elsewhere.
   */
  vcRuntimeMissing: boolean
  /** Progress of the one-click official VC++ redistributable install (`engines:installVcRuntime`). */
  vcRuntimeInstall: VcRuntimeInstallProgress | null
}

export interface VcRuntimeInstallProgress {
  status: 'downloading' | 'verifying' | 'installing' | 'completed' | 'error'
  percent?: number
  error?: string
  rebootRequired?: boolean
}

// ───────────────────────────── Call state ─────────────────────────────

export const CALL_STATUSES = [
  'idle',
  'connecting',
  'listening',
  'user_speaking',
  'thinking',
  'speaking',
  'interrupt_pending',
  'reconnecting',
  'ended',
] as const
export type CallStatus = (typeof CALL_STATUSES)[number]

export const CALL_END_REASONS = [
  'user_hangup',
  'mic_denied',
  'mic_lost',
  'backend_unavailable',
  'backend_error',
  'session_expired',
  'engine_not_installed',
  'backend_not_implemented',
] as const
export type CallEndReason = (typeof CALL_END_REASONS)[number]

export interface CallMetrics {
  endpointMs?: number
  asrMs?: number
  ttfbMs?: number
  playbackStartMs?: number
  e2eMs?: number
}

export interface CallCaption {
  role: 'user' | 'assistant'
  text: string
  final: boolean
}

export interface CallStateSnapshot {
  callId: string | null
  status: CallStatus
  muted: boolean
  backend: LiveBackendId | null
  sessionId: string | null
  caption: CallCaption | null
  metrics: CallMetrics | null
  reason: CallEndReason | null
  detail: string | null
  updatedAt: number
}

export const IDLE_CALL_STATE: CallStateSnapshot = {
  callId: null,
  status: 'idle',
  muted: false,
  backend: null,
  sessionId: null,
  caption: null,
  metrics: null,
  reason: null,
  detail: null,
  updatedAt: 0,
}

export interface CallVisemeFrame {
  A: number
  E: number
  I: number
  O: number
  U: number
  volume: number
}

export type CallCommand =
  | { command: 'start'; callId: string; backend: LiveBackendId; sessionId: string; test?: boolean }
  | { command: 'stop'; callId: string }
  | { command: 'setMuted'; callId: string; muted: boolean }
  /** Phase 10.3 — speak proactively (approved-action result, initiative) when the call is listening. */
  | { command: 'inject'; callId: string; contextText: string; reason: 'approval' | 'initiative' }

/** Runtime config the call-engine renderer needs to open a backend session. */
export interface CallRuntimeConfig {
  callId: string
  backend: LiveBackendId
  sessionId: string
  settings: LiveModeSettings
  llamacpp: { baseUrl: string; modelId: string; contextSize: number } | null
  /**
   * Phase 10.4 — resolved cloud endpoint for 'openai-realtime' / 'gemini-live'. The API key is NOT
   * here: the main process injects it into the call window's WebSocket upgrade.
   */
  cloud?: { kind: 'openai-compatible' | 'gemini'; url: string; model: string; voice: string } | null
}

export interface CallContextResult {
  sessionId: string
  /** Session-level instructions (llama.cpp: compact, English persona, model-card mode line last). */
  instructions: string
  /** Per-turn context injected as an input_text item before the user turn ('' when none). */
  perTurnContext: string
  /**
   * Speaker label prefixed to the user's transcribed turn (`<label>: <text>`). The 2026-11-01
   * integration check showed LFM3 confuses roles (calls the user "Ashy") without it; merging
   * context + labelled turn into ONE input_text item gave the best replies.
   */
  userLabel?: string
  /**
   * Phase 10.3 — only on the session-level call (no userText): tool definitions to send in
   * `session.update` (tools can only be set before the first input). Absent/empty = no tools.
   */
  tools?: CallToolDefinition[]
  /**
   * Phase 10.3 — per-turn tool policy decided host-side from the user's words (PT intent check).
   * 'auto': run the turn as a text-only tool step first (`response.create {tool_choice:'auto',
   * output_modalities:['text']}`), then the spoken answer. 'none': plain spoken turn with
   * `tool_choice:'none'` (the 2B model otherwise calls tools for small talk — 2026-11-01 spike).
   */
  toolChoice?: 'auto' | 'none'
  /** Phase 10.3 — true when the host consumed the turn as a voice approval/denial of a pending action. */
  approvalHandled?: boolean
}

/** OpenAI-Realtime style function tool (what llama.cpp `/v1/realtime` accepts in `session.update`). */
export interface CallToolDefinition {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Formats the single input_text item for a transcribed user turn (context + labelled speech). */
export function formatTranscribedUserTurn(text: string, perTurnContext: string, userLabel?: string): string {
  const label = (userLabel ?? '').trim() || 'Usuário'
  const turn = `${label}: ${text.trim()}`
  return perTurnContext.trim().length > 0 ? `${perTurnContext.trim()}\n\n${turn}` : turn
}

// ───────────────────────────── Generic Live Call RPC ─────────────────────────────

export const LIVE_CALL_METHODS = [
  // settings
  'liveMode:getSettings',
  'liveMode:saveSettings',
  // engines
  'engines:getStatus',
  'engines:install',
  'engines:downloadModel',
  'engines:start',
  'engines:stop',
  'engines:installVcRuntime',
  // call control (hub/overlay → host)
  'call:start',
  'call:stop',
  'call:setMuted',
  'call:getState',
  // call-engine renderer → host
  'call:getRuntimeConfig',
  'call:reportState',
  'call:reportViseme',
  'call:buildContext',
  'call:transcribe',
  'call:recordTurn',
  // Phase 10.2
  'call:classifyAffect',
  'call:reportStage',
  'call:synthesize',
  'call:startTest',
  'call:getTestInput',
  'call:reportTestResult',
  'liveVoice:list',
  'liveVoice:import',
  'liveVoice:delete',
  'liveVoice:preview',
  // Phase 10.3
  'call:executeTool',
  'call:checkInitiative',
  'agency:approve',
  'agency:deny',
  // Phase 10.4 / 10.5
  'liveMode:setApiKey',
  'liveMode:getKeyStatus',
  // Phase 10.5 — classic cascade (STT → text LLM through the turn orchestrator → chunked TTS)
  'call:cascadeTurn',
  'call:cascadeAbort',
  // Phase 10.5 latency: warm the cascade LLM at connect; streamed TTS (PCM as `call:ttsChunk` events)
  'call:cascadeWarmup',
  'call:synthesizeStream',
  'call:synthesizeAbort',
] as const
export type LiveCallMethod = (typeof LIVE_CALL_METHODS)[number]
export const LiveCallMethodSchema = v.picklist(LIVE_CALL_METHODS)

export const LiveCallInvokeInputSchema = v.object({
  method: LiveCallMethodSchema,
  payload: v.optional(v.unknown()),
})
export type LiveCallInvokeInput = v.InferOutput<typeof LiveCallInvokeInputSchema>

export const CallStartInputSchema = v.object({ backend: v.optional(LiveBackendIdSchema) })
export const CallStopInputSchema = v.object({ callId: v.optional(v.string()) })
export const CallSetMutedInputSchema = v.object({ muted: v.boolean() })
export const CallReportStateInputSchema = v.object({
  callId: v.string(),
  status: v.picklist(CALL_STATUSES),
  caption: v.optional(
    v.nullable(
      v.object({
        role: v.picklist(['user', 'assistant'] as const),
        text: v.pipe(v.string(), v.maxLength(4000)),
        final: v.boolean(),
      }),
    ),
  ),
  metrics: v.optional(
    v.nullable(
      v.object({
        endpointMs: v.optional(v.number()),
        asrMs: v.optional(v.number()),
        ttfbMs: v.optional(v.number()),
        playbackStartMs: v.optional(v.number()),
        e2eMs: v.optional(v.number()),
      }),
    ),
  ),
  reason: v.optional(v.nullable(v.picklist(CALL_END_REASONS))),
  detail: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(1000)))),
})
export const CallReportVisemeInputSchema = v.object({
  A: v.number(),
  E: v.number(),
  I: v.number(),
  O: v.number(),
  U: v.number(),
  volume: v.number(),
})
export const CallBuildContextInputSchema = v.object({
  callId: v.string(),
  userText: v.optional(v.pipe(v.string(), v.maxLength(4000))),
  /** Assistant text that was cut by the user (for the interruption note). */
  interruptedAfterText: v.optional(v.pipe(v.string(), v.maxLength(4000))),
})
export const CallTranscribeInputSchema = v.object({
  callId: v.string(),
  audioWavBase64: v.pipe(v.string(), v.maxLength(8_000_000)),
  language: v.optional(v.pipe(v.string(), v.maxLength(16))),
})
export interface CallTranscribeResult {
  text: string
  providerId: string
  latencyMs: number
}
export const CallRecordTurnInputSchema = v.object({
  callId: v.string(),
  userTranscript: v.pipe(v.string(), v.maxLength(8000)),
  /** Only what was actually played to the user. */
  assistantSpokenText: v.pipe(v.string(), v.maxLength(16000)),
  /** Full generated text (kept in meta only, never in history). */
  assistantFullText: v.optional(v.pipe(v.string(), v.maxLength(16000))),
  interrupted: v.boolean(),
  playedMs: v.optional(v.number()),
  emotion: v.optional(v.string()),
  metrics: v.optional(
    v.object({
      endpointMs: v.optional(v.number()),
      asrMs: v.optional(v.number()),
      ttfbMs: v.optional(v.number()),
      playbackStartMs: v.optional(v.number()),
      e2eMs: v.optional(v.number()),
    }),
  ),
  /**
   * Phase 10.3 — Ashy spoke on her own (approved-action result / initiative): there is no user
   * utterance, so only the assistant row is persisted (no "🎤 (fala não transcrita)" user row).
   */
  injectReason: v.optional(v.picklist(['approval', 'initiative'] as const)),
})
export const EnginesInstallInputSchema = v.object({
  engineId: v.literal('llamacpp'),
  variant: v.optional(v.picklist(LLAMACPP_VARIANTS)),
})
export const EnginesDownloadModelInputSchema = v.object({
  modelId: v.pipe(v.string(), v.nonEmpty(), v.maxLength(128)),
})
export const EnginesStartInputSchema = v.object({
  modelId: v.optional(v.pipe(v.string(), v.maxLength(128))),
})

// ───────────────────────────── Phase 10.2: stage signals, hybrid TTS, voices, test call ─────────────────────────────

/** Emotion/motion for the avatar, applied when the segment that carries it starts playing. */
export interface CallStageSignal {
  emotion: string
  intensity: number
  motion?: string
}
export const CallClassifyAffectInputSchema = v.object({
  callId: v.string(),
  text: v.pipe(v.string(), v.maxLength(2000)),
})
export const CallReportStageInputSchema = v.object({
  callId: v.string(),
  emotion: v.pipe(v.string(), v.maxLength(32)),
  intensity: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  motion: v.optional(v.pipe(v.string(), v.maxLength(48))),
})

/** Hybrid mode: host synthesizes one text chunk with llama-server /tts (+ reference voice). */
export const CallSynthesizeInputSchema = v.object({
  callId: v.string(),
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
})
export interface CallSynthesizeResult {
  /** Mono PCM16 little-endian, base64. */
  pcmBase64: string
  sampleRate: number
  durationMs: number
  latencyMs: number
}

export interface VoiceReference {
  id: string
  name: string
  durationMs: number
  createdAt: number
}
/** The renderer normalizes the upload (decode → mono 24 kHz → trim silence) and sends a PCM16 WAV. */
export const LiveVoiceImportInputSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)),
  wavBase64: v.pipe(v.string(), v.maxLength(4_000_000)),
})
export const LiveVoiceIdInputSchema = v.object({ id: v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,64}$/)) })
export const LiveVoicePreviewInputSchema = v.object({
  id: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,64}$/)))),
  text: v.optional(v.pipe(v.string(), v.maxLength(300))),
})
export interface LiveVoicePreviewResult {
  wavBase64: string
  latencyMs: number
}

/** Test call: one synthetic question replaces the microphone; each stage is checked. */
export const CALL_TEST_STEPS = ['engine', 'session', 'vad', 'transcription', 'first_audio', 'playback'] as const
export type CallTestStep = (typeof CALL_TEST_STEPS)[number]
export interface CallTestResult {
  callId: string
  ok: boolean
  steps: Array<{ step: CallTestStep; ok: boolean; ms?: number; detail?: string }>
  metrics: CallMetrics | null
  transcript: string | null
  reply: string | null
  finishedAt: number
}
export const CallGetTestInputSchema = v.object({ callId: v.string() })
export interface CallTestInput {
  /** Question audio (mono PCM16 WAV, 16 kHz) to feed instead of the mic. */
  wavBase64: string
  expectedText: string
}
export const CallReportTestResultInputSchema = v.object({
  callId: v.string(),
  ok: v.boolean(),
  steps: v.array(
    v.object({
      step: v.picklist(CALL_TEST_STEPS),
      ok: v.boolean(),
      ms: v.optional(v.number()),
      detail: v.optional(v.pipe(v.string(), v.maxLength(500))),
    }),
  ),
  metrics: v.optional(
    v.nullable(
      v.object({
        endpointMs: v.optional(v.number()),
        asrMs: v.optional(v.number()),
        ttfbMs: v.optional(v.number()),
        playbackStartMs: v.optional(v.number()),
        e2eMs: v.optional(v.number()),
      }),
    ),
  ),
  transcript: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(4000)))),
  reply: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(4000)))),
})

// ───────────────────────────── Phase 10.3: tools, approvals, vision, initiative ─────────────────────────────

export const CallExecuteToolInputSchema = v.object({
  callId: v.string(),
  toolCallId: v.pipe(v.string(), v.maxLength(128)),
  name: v.pipe(v.string(), v.maxLength(128)),
  argsJson: v.pipe(v.string(), v.maxLength(20000)),
})
export interface CallExecuteToolResult {
  status: 'executed' | 'staged' | 'blocked' | 'error'
  /** String handed back to the model as the function_call_output. */
  output: string
  cardId?: string
}

export const CallCheckInitiativeInputSchema = v.object({
  callId: v.string(),
  idleMs: v.number(),
})
export interface CallCheckInitiativeResult {
  speak: boolean
  contextText?: string
  reason?: string
}

/** Minimal view of an agency pending-action card pushed to the UI. */
export interface AgencyPendingCardView {
  id: string
  toolName: string
  summary: string
  argsPreview: string
  riskTier: string
  blastRadiusWarning?: string
  /** true when the action can be approved by voice (never for blast-radius actions). */
  voiceApprovable: boolean
  callId?: string
  createdAt: number
}
export const AgencyResolveInputSchema = v.object({
  cardId: v.pipe(v.string(), v.maxLength(128)),
  /** 'always' persists an allow rule for this tool (never applies to blast-radius actions). */
  scope: v.optional(v.picklist(['once', 'session', 'always'] as const)),
})

// ───────────────────────────── Phase 10.4: cloud keys ─────────────────────────────

export const LiveSetApiKeyInputSchema = v.object({
  provider: v.picklist(LIVE_KEY_PROVIDERS),
  /** '' clears the key. */
  apiKey: v.pipe(v.string(), v.trim(), v.maxLength(512)),
})
export type LiveKeyStatus = Record<LiveKeyProvider, { hasKey: boolean; masked: string | null }>

// ───────────────────────────── Phase 10.5: cascade pipeline ─────────────────────────────

/**
 * One cascade turn: the call engine already transcribed the user; the host runs the text LLM through
 * the turn orchestrator (full Ashy persona, memory, tools) and streams `call:cascade` events back.
 * `turnId` is chosen by the caller (so no event can arrive before it knows the id). Nothing is
 * persisted by this turn: the engine's `call:recordTurn` stores only what was actually spoken.
 */
export const CallCascadeTurnInputSchema = v.object({
  callId: v.string(),
  turnId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.:-]{1,96}$/)),
  /** Transcribed user speech ('' for a proactive turn: approval result / initiative). */
  text: v.pipe(v.string(), v.maxLength(4000)),
  /** Per-turn call context from `call:buildContext` (approval line, screen, interruption, recap). */
  context: v.optional(v.pipe(v.string(), v.maxLength(8000))),
  /** Host tool policy for this turn (`CallContextResult.toolChoice`); tools only with 'auto'. */
  toolChoice: v.optional(v.picklist(['auto', 'none'] as const)),
  /** Set for proactive turns (no user speech). */
  injectReason: v.optional(v.picklist(['approval', 'initiative'] as const)),
})
export type CallCascadeTurnInput = v.InferOutput<typeof CallCascadeTurnInputSchema>
export const CallCascadeAbortInputSchema = v.object({
  callId: v.string(),
  turnId: v.pipe(v.string(), v.maxLength(96)),
})

/** Streamed result of a cascade turn (host → call-engine window). */
export type CallCascadeEvent =
  /** Clean speakable text (ACT markers re-emitted inline as `<|ACT {json}|>`). */
  | { kind: 'delta'; delta: string }
  /** A tool started (caption only). */
  | { kind: 'tool'; name: string }
  | { kind: 'done'; text: string; providerId: string; modelId: string | null; latencyMs: number }
  | { kind: 'error'; message: string }
  | { kind: 'aborted' }

/** Warms the cascade LLM (loads a local model) at call connect. Nothing is persisted or emitted. */
export const CallCascadeWarmupInputSchema = v.object({
  callId: v.string(),
})
export interface CallCascadeWarmupResult {
  warmed: boolean
  providerId: string | null
  modelId: string | null
  latencyMs: number
}

/**
 * Streamed synthesis of one phrase: PCM arrives as `call:ttsChunk` host events (`seq` 0..n-1, same
 * `streamId`); the invoke resolves once synthesis finished, with the chunk count, so the caller can
 * wait for events still in transit. Providers without streaming deliver the phrase as one chunk.
 */
export const CallSynthesizeStreamInputSchema = v.object({
  callId: v.string(),
  streamId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.:-]{1,96}$/)),
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
})
export interface CallSynthesizeStreamResult {
  streamId: string
  /** Number of `call:ttsChunk` events emitted for this stream. */
  chunks: number
  sampleRate: number
  durationMs: number
  /** Request → end of synthesis. */
  latencyMs: number
  /** Request → first chunk (null when no audio). */
  firstChunkMs: number | null
  /** True when the stream was aborted (`call:synthesizeAbort`) before the end. */
  aborted?: boolean
}
export const CallSynthesizeAbortInputSchema = v.object({
  callId: v.string(),
  streamId: v.pipe(v.string(), v.maxLength(96)),
})
export interface CallTtsChunk {
  streamId: string
  seq: number
  /** Mono PCM16 little-endian, base64. */
  pcmBase64: string
  sampleRate: number
}

// ───────────────────────────── Host → renderer events ─────────────────────────────

export type LiveCallHostEvent =
  | { type: 'call:state'; state: CallStateSnapshot }
  | ({ type: 'call:viseme' } & CallVisemeFrame)
  | ({ type: 'call:command' } & CallCommand)
  | { type: 'engine:status'; status: LlamaCppEngineStatus }
  | { type: 'chat:appended'; sessionId: string; messageIds: string[] }
  | ({ type: 'call:stage'; callId: string } & CallStageSignal)
  | { type: 'call:testResult'; result: CallTestResult }
  | { type: 'agency:pending'; card: AgencyPendingCardView }
  | { type: 'agency:resolved'; cardId: string; status: 'approved' | 'denied' | 'failed'; output?: string }
  | { type: 'vision:capture'; active: boolean; source: 'screen' | 'window' }
  | ({ type: 'call:cascade'; callId: string; turnId: string } & CallCascadeEvent)
  | ({ type: 'call:ttsChunk'; callId: string } & CallTtsChunk)

export const LIVE_CALL_EVENT_TYPES = [
  'call:state',
  'call:viseme',
  'call:command',
  'engine:status',
  'chat:appended',
  'call:stage',
  'call:testResult',
  'agency:pending',
  'agency:resolved',
  'vision:capture',
  'call:cascade',
  'call:ttsChunk',
] as const

export function isLiveCallHostEvent(e: { type: string }): e is LiveCallHostEvent {
  return (LIVE_CALL_EVENT_TYPES as readonly string[]).includes(e.type)
}
