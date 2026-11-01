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
export const LIVE_BACKENDS_IMPLEMENTED: readonly LiveBackendId[] = ['llamacpp-realtime', 'llamacpp-hybrid']

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
    /** Rotate the realtime session (seeded with a recap) after this many turns — curbs 2B-model repetition. */
    rotateAfterTurns: number
  }
  devices: { inputDeviceId?: string; outputDeviceId?: string }
  features: {
    toolsInCall: boolean
    visionInCall: boolean
    initiativeInCall: boolean
    idleNudgeSec: number
  }
}

export const DEFAULT_LIVE_MODE_SETTINGS: LiveModeSettings = {
  backend: 'llamacpp-realtime',
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
    rotateAfterTurns: 6,
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
    contextSize: 8192,
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

/** Runtime config the call-engine renderer needs to open a backend session. */
export interface CallRuntimeConfig {
  callId: string
  backend: LiveBackendId
  sessionId: string
  settings: LiveModeSettings
  llamacpp: { baseUrl: string; modelId: string; contextSize: number } | null
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

// ───────────────────────────── Host → renderer events ─────────────────────────────

export type LiveCallHostEvent =
  | { type: 'call:state'; state: CallStateSnapshot }
  | ({ type: 'call:viseme' } & CallVisemeFrame)
  | ({ type: 'call:command' } & CallCommand)
  | { type: 'engine:status'; status: LlamaCppEngineStatus }
  | { type: 'chat:appended'; sessionId: string; messageIds: string[] }
  | ({ type: 'call:stage'; callId: string } & CallStageSignal)
  | { type: 'call:testResult'; result: CallTestResult }

export const LIVE_CALL_EVENT_TYPES = [
  'call:state',
  'call:viseme',
  'call:command',
  'engine:status',
  'chat:appended',
  'call:stage',
  'call:testResult',
] as const

export function isLiveCallHostEvent(e: { type: string }): e is LiveCallHostEvent {
  return (LIVE_CALL_EVENT_TYPES as readonly string[]).includes(e.type)
}
