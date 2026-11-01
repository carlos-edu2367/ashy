/**
 * Phase 10.1 — registers the `call:*` Live Call handlers (hub, context,
 * transcription, recorder) on the kernel's Live Call registry, with valibot
 * input validation for every payload.
 */
import * as v from 'valibot'
import {
  CallBuildContextInputSchema,
  CallRecordTurnInputSchema,
  CallReportStateInputSchema,
  CallReportVisemeInputSchema,
  CallSetMutedInputSchema,
  CallStartInputSchema,
  CallStopInputSchema,
  CallTranscribeInputSchema,
  CallClassifyAffectInputSchema,
  CallGetTestInputSchema,
  CallReportStageInputSchema,
  CallReportTestResultInputSchema,
  CallSynthesizeInputSchema,
  LiveVoiceIdInputSchema,
  LiveVoiceImportInputSchema,
  LiveVoicePreviewInputSchema,
  AgencyResolveInputSchema,
  CallCheckInitiativeInputSchema,
  CallExecuteToolInputSchema,
  type CallCheckInitiativeResult,
  type CallExecuteToolResult,
  type EvaluateInitiativeInput,
  type ProactiveInitiativeRecord,
  type CallContextResult,
  type CallStageSignal,
  type LiveCallHostEvent,
  type LiveModeSettings,
  type LiveVoicePreviewResult,
  type SaveLiveModeSettingsInput,
} from '@ashy/shared'
import type { LiveCallRegistry } from './registry'
import {
  createCallHub,
  type CallEngineSource,
  type CallHub,
  type CallSettingsSource,
  type CallWindowControllerLike,
} from './call-hub'
import {
  createCallContextBuilder,
  createCortexMemoryRetriever,
  createCortexMoodReader,
  createCortexUserNameReader,
  type CallMemoryRetrieval,
} from './context'
import { createCallRecorder, type CallRecorderCortex } from './recorder'
import { transcribeCallAudio, type HostTranscribeFn } from './transcribe'
import type { AshyCortex } from '@ashy/cortex'
import { classifyCallAffect, normalizeStageSignal } from './affect'
import { createCallSynthesizer, requestLlamaTts, resolveLlamaBaseUrl, type FetchLike } from './synthesize'
import { createTestCallManager } from './test-call'
import { createVoiceStore, VOICE_PREVIEW_DEFAULT_TEXT, type VoiceStore } from './voices'
import type { HostAgencyRuntime } from '../agency-runtime'
import { createAgencyEventBridge, createCallApprovals, type AgencyEventBridge } from './approvals'
import { buildCallToolDefinitions, describePendingActionPt, executeCallTool } from './tools'
import { createVisionDescriber, hasVisualIntent, type ScreenCaptureProvider, type VisionDescriber } from './vision'
import { createCallInitiative } from './initiative'
import {
  buildCloudSessionInstructions,
  createLiveCloud,
  createLiveCloudKeyStore,
  isCloudBackend,
  type CloudContextCortex,
  type LiveCloud,
} from './cloud'
import type { ConnectUpstream } from './cloud-relay'
import type { SecretProtector } from '../secret-protector'
import { LiveSetApiKeyInputSchema, type LiveKeyProvider } from '@ashy/shared'
import {
  createCascadeTtsRouter,
  registerCascadeHandlers,
  resolveCascadeLlm,
  type CascadeOrchestrator,
  type HostSpeechSynthesizer,
} from './cascade'
import { STT_PROVIDER_IDS, type SttProviderId } from '@ashy/shared'

export type CallHostCortex = CallRecorderCortex &
  Pick<AshyCortex, 'compileTurnPrompt' | 'db' | 'evaluateAttentionInitiative'>

export interface CallHostApi {
  readonly registry: LiveCallRegistry
  emit(event: LiveCallHostEvent): void
  getCallWindowController(): CallWindowControllerLike | null
}

export interface CallHostDeps {
  /** `save` (optional) lets `liveVoice:delete` reset `hybrid.referenceVoiceId`. */
  settings: CallSettingsSource & { save?(patch: SaveLiveModeSettingsInput): LiveModeSettings }
  engine: CallEngineSource
  /** Lazy: the cortex is resolved after the kernel starts. */
  getCortex(): CallHostCortex
  /** Active chat session id (creates one when none exists). */
  resolveSessionId(): string | Promise<string>
  /** Host STT (kernel `transcribeVoiceAudio`). */
  transcribe: HostTranscribeFn
  /** Overrides cortex retrieval (tests / alternative stores). */
  retrieveMemories?: (userText: string) => Promise<CallMemoryRetrieval> | CallMemoryRetrieval
  memoryBudgetMs?: number
  now?: () => number
  createCallId?: () => string
  visemeMinIntervalMs?: number
  onWarning?: (message: string) => void
  /** Phase 10.2: enables `liveVoice:*` (voices live in `<userDataDir>/voices`). */
  userDataDir?: string
  /** Host → llama-server HTTP (tests). */
  fetchImpl?: FetchLike
  ttsTimeoutMs?: number
  /**
   * Phase 10.3 — the agency runtime (tools, approvals, privacy). Default: the runtime that
   * attached itself to `handlers.agencyBridge` (kernel passes the bridge to createHostAgencyRuntime).
   */
  getAgencyRuntime?: () => HostAgencyRuntime | null
  /** Phase 10.3 — overrides `cortex.evaluateAttentionInitiative` (tests). */
  evaluateInitiative?: (input: EvaluateInitiativeInput) => ProactiveInitiativeRecord
  visionTimeoutMs?: number
  visionCacheTtlMs?: number
  /** Phase 10.5 — cascade backend: the turn orchestrator (lazy; null until the kernel started). */
  getTurnOrchestrator?: () => CascadeOrchestrator | null
  /** Phase 10.5 — cascade TTS through the kernel voice providers (Kokoro / OpenAI / ElevenLabs). */
  synthesizeSpeech?: HostSpeechSynthesizer
  /**
   * Phase 10.4 — cloud speech-to-speech backends: the secret protector that encrypts their API keys
   * (`<userDataDir>/live-cloud-keys.json`). Without it (or without `userDataDir`) the cloud backends
   * end with `backend_unavailable` and `liveMode:setApiKey` is not registered.
   */
  cloudSecretProtector?: Pick<SecretProtector, 'encryptEnvelope' | 'decryptEnvelope'>
  /** Phase 10.4 — key fallback per provider (e.g. the OpenAI key already configured for chat/voice). */
  cloudFallbackKey?: (provider: LiveKeyProvider) => string | null
  /** Phase 10.4 — tests: fake upstream connector for the loopback relay. */
  cloudConnectUpstream?: ConnectUpstream
}

export interface CallHostHandlers {
  hub: CallHub
  /** Present when `userDataDir` was given. */
  voices: VoiceStore | null
  /** Phase 10.3 — hand to `createHostAgencyRuntime({ eventBridge })`. */
  agencyBridge: AgencyEventBridge
  /** Phase 10.3 — Electron main's desktopCapturer provider (`kernel.setScreenCaptureProvider`). */
  setScreenCaptureProvider(provider: ScreenCaptureProvider | null): void
  vision: VisionDescriber
  /** Phase 10.4 — cloud backends (keys + loopback relay); null when not configured. */
  cloud: LiveCloud | null
  unregister(): void
}

const CallIdOnlySchema = v.object({ callId: v.optional(v.string()) })

function parseOrThrow<TSchema extends v.GenericSchema>(
  schema: TSchema,
  payload: unknown,
  method: string,
): v.InferOutput<TSchema> {
  const parsed = v.safeParse(schema, payload ?? {})
  if (!parsed.success) {
    const issue = parsed.issues[0]
    const where = issue?.path?.map((p) => String(p.key)).join('.') ?? ''
    throw new Error(
      `Invalid payload for ${method}${where ? ` at ${where}` : ''}: ${issue?.message ?? 'invalid input'}`,
    )
  }
  return parsed.output
}

export class CallUnknownError extends Error {
  readonly code = 'CALL_UNKNOWN' as const
  constructor(callId: string) {
    super(`CALL_UNKNOWN: ${callId}`)
    this.name = 'CallUnknownError'
  }
}

/** Registers every `call:*` method. Returns the hub plus an unregister function. */
export function registerCallHostHandlers(api: CallHostApi, deps: CallHostDeps): CallHostHandlers {
  const nowMs = deps.now ?? (() => Date.now())
  // Phase 10.4 — cloud backends: the relay serves only the hub's active call (late-bound).
  let hubRef: CallHub | null = null
  const cloud: LiveCloud | null =
    deps.userDataDir && deps.cloudSecretProtector
      ? createLiveCloud({
          keys: createLiveCloudKeyStore({
            userDataDir: deps.userDataDir,
            protector: deps.cloudSecretProtector,
            ...(deps.cloudFallbackKey ? { fallbackKey: deps.cloudFallbackKey } : {}),
          }),
          getSettings: () => deps.settings.get(),
          getActiveCall: () => hubRef?.getActiveCall() ?? null,
          ...(deps.cloudConnectUpstream ? { connectUpstream: deps.cloudConnectUpstream } : {}),
          ...(deps.onWarning ? { log: (m: string) => deps.onWarning!(m) } : {}),
        })
      : null
  const hub = createCallHub({
    emit: (event) => api.emit(event),
    settings: deps.settings,
    engine: deps.engine,
    getCallWindowController: () => api.getCallWindowController(),
    resolveSessionId: deps.resolveSessionId,
    now: nowMs,
    ...(deps.createCallId ? { createCallId: deps.createCallId } : {}),
    ...(deps.visemeMinIntervalMs !== undefined
      ? { visemeMinIntervalMs: deps.visemeMinIntervalMs }
      : {}),
    ...(cloud ? { cloud } : {}),
  })
  hubRef = hub
  const contextBuilder = createCallContextBuilder({
    retrieveMemories: deps.retrieveMemories ?? createCortexMemoryRetriever(deps.getCortex),
    getMood: createCortexMoodReader(deps.getCortex, nowMs),
    getUserName: createCortexUserNameReader(deps.getCortex),
    now: () => new Date(nowMs()),
    ...(deps.memoryBudgetMs !== undefined ? { memoryBudgetMs: deps.memoryBudgetMs } : {}),
  })
  const recorder = createCallRecorder({
    getCortex: deps.getCortex,
    emit: (event) => api.emit(event),
    now: nowMs,
    ...(deps.onWarning ? { onWarning: deps.onWarning } : {}),
  })
  /** Last in-budget retrieval per call, consumed by the next recordTurn (FSRS review). */
  const lastRetrievalByCall = new Map<string, CallMemoryRetrieval>()

  function requireKnownCall(callId: string) {
    const record = hub.getKnownCall(callId)
    if (!record) throw new CallUnknownError(callId)
    return record
  }

  // ── Phase 10.3: agency bridge, vision, approvals, initiative ──
  const agencyBridge = createAgencyEventBridge((event) => api.emit(event))
  const getRuntime = (): HostAgencyRuntime | null => {
    try {
      return deps.getAgencyRuntime ? deps.getAgencyRuntime() ?? null : agencyBridge.getRuntime()
    } catch {
      return null
    }
  }
  let screenCaptureProvider: ScreenCaptureProvider | null = null
  const vision = createVisionDescriber({
    getProvider: () => screenCaptureProvider,
    getPrivacy: () => getRuntime()?.privacyController ?? null,
    getActiveWindowTitle: async () => (await getRuntime()?.getActiveWindowTitle()) ?? null,
    getSettings: () => deps.settings.get(),
    engine: deps.engine,
    emit: (event) => api.emit(event),
    now: nowMs,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.visionTimeoutMs !== undefined ? { timeoutMs: deps.visionTimeoutMs } : {}),
    ...(deps.visionCacheTtlMs !== undefined ? { cacheTtlMs: deps.visionCacheTtlMs } : {}),
  })
  const lastUserTextByCall = new Map<string, string>()
  const agency = {
    getRuntime,
    features: () => deps.settings.get().features,
    modelSupportsTools: (): boolean => {
      try {
        const modelId = deps.settings.get().llamacpp.modelId
        return deps.engine.getModelSpec(modelId)?.capabilities.tools ?? true
      } catch {
        return true
      }
    },
    rememberUserText(callId: string, text: string) {
      lastUserTextByCall.delete(callId)
      lastUserTextByCall.set(callId, text)
      while (lastUserTextByCall.size > 20) {
        const oldest = lastUserTextByCall.keys().next().value
        if (oldest === undefined) break
        lastUserTextByCall.delete(oldest)
      }
    },
    approvals: createCallApprovals({
      getRuntime,
      getActiveCallId: () => hub.getActiveCall()?.callId ?? null,
      inject: (callId, contextText) => {
        hub.inject({ callId, contextText, reason: 'approval' })
      },
    }),
    initiative: createCallInitiative({
      getSettings: () => deps.settings.get(),
      getActiveCall: () => hub.getActiveCall(),
      isMuted: () => hub.getState().muted,
      getDndMode: () => getRuntime()?.privacyController.dndMode ?? null,
      evaluate: (input) =>
        deps.evaluateInitiative
          ? deps.evaluateInitiative(input)
          : deps.getCortex().evaluateAttentionInitiative(input),
      getLastUserText: (callId) => lastUserTextByCall.get(callId) ?? null,
      now: nowMs,
    }),
  }

  const unregisterFns = [
    api.registry.register('call:start', (payload) =>
      hub.start(parseOrThrow(CallStartInputSchema, payload, 'call:start')),
    ),
    api.registry.register('call:stop', (payload) =>
      hub.stop(parseOrThrow(CallStopInputSchema, payload, 'call:stop')),
    ),
    api.registry.register('call:setMuted', (payload) =>
      hub.setMuted(parseOrThrow(CallSetMutedInputSchema, payload, 'call:setMuted')),
    ),
    api.registry.register('call:getState', () => hub.getState()),
    api.registry.register('call:getRuntimeConfig', (payload) =>
      hub.getRuntimeConfig(parseOrThrow(CallIdOnlySchema, payload, 'call:getRuntimeConfig')),
    ),
    api.registry.register('call:reportState', (payload) =>
      hub.reportState(parseOrThrow(CallReportStateInputSchema, payload, 'call:reportState')),
    ),
    api.registry.register('call:reportViseme', (payload) => ({
      emitted: hub.reportViseme(
        parseOrThrow(CallReportVisemeInputSchema, payload, 'call:reportViseme'),
      ),
    })),
    api.registry.register('call:buildContext', async (payload): Promise<CallContextResult> => {
      const input = parseOrThrow(CallBuildContextInputSchema, payload, 'call:buildContext')
      const call = requireKnownCall(input.callId)
      // Phase 10.3 — tools / voice approval / screen context (never in a test call).
      const features = agency.features()
      // Phase 10.4: cloud models always get the call tools when `features.toolsInCall`.
      const cloudCall = isCloudBackend(call.backend)
      const toolsOn = !call.test && features.toolsInCall && (cloudCall || agency.modelSupportsTools())
      const userText = (input.userText ?? '').trim()
      let approval: { handled: boolean; contextLine?: string } | null = null
      let screen: string | null = null
      if (userText.length > 0 && !call.test) {
        agency.rememberUserText(input.callId, userText)
        approval = await agency.approvals.handleVoiceTurn(input.callId, userText).catch(() => null)
        if (!approval?.handled && !toolsOn && features.visionInCall && hasVisualIntent(userText)) {
          const seen = await vision.describe()
          screen = seen.text
        }
      }
      const built = await contextBuilder.build({
        sessionId: call.sessionId,
        // Hybrid: the realtime session answers in TEXT (llama-server /tts speaks it).
        mode: call.backend === 'llamacpp-hybrid' ? 'text' : 'audio',
        ...(input.userText !== undefined ? { userText: input.userText } : {}),
        ...(input.interruptedAfterText !== undefined
          ? { interruptedAfterText: input.interruptedAfterText }
          : {}),
        // Cloud models call tools inside their spoken answers: no per-turn tool policy / context drop.
        ...(toolsOn && !cloudCall ? { tools: buildCallToolDefinitions() } : {}),
        ...(approval ? { approval } : {}),
        ...(screen ? { screen } : {}),
      })
      if (built.retrieval && !call.test) {
        lastRetrievalByCall.set(input.callId, built.retrieval)
      }
      if (cloudCall) {
        const sessionLevel = input.userText === undefined
        let cortex: CloudContextCortex | null = null
        try {
          cortex = deps.getCortex() as unknown as CloudContextCortex
        } catch {
          cortex = null
        }
        return {
          sessionId: built.sessionId,
          instructions: sessionLevel
            ? buildCloudSessionInstructions({
                cortex,
                sessionId: call.sessionId,
                settings: deps.settings.get(),
                userName: built.userLabel && built.userLabel !== 'Usuário' ? built.userLabel : null,
                tools: toolsOn,
              })
            : '',
          perTurnContext: built.perTurnContext,
          ...(built.userLabel ? { userLabel: built.userLabel } : {}),
          ...(sessionLevel && toolsOn ? { tools: buildCallToolDefinitions() } : {}),
          ...(built.approvalHandled ? { approvalHandled: true } : {}),
        }
      }
      return {
        sessionId: built.sessionId,
        instructions: built.instructions,
        perTurnContext: built.perTurnContext,
        ...(built.userLabel ? { userLabel: built.userLabel } : {}),
        ...(built.tools ? { tools: built.tools } : {}),
        ...(built.toolChoice ? { toolChoice: built.toolChoice } : {}),
        ...(built.approvalHandled ? { approvalHandled: true } : {}),
      }
    }),
    // ── Phase 10.3 ──
    api.registry.register('call:executeTool', async (payload): Promise<CallExecuteToolResult> => {
      const input = parseOrThrow(CallExecuteToolInputSchema, payload, 'call:executeTool')
      const call = requireKnownCall(input.callId)
      if (call.test || !agency.features().toolsInCall) {
        return {
          status: 'blocked',
          output: JSON.stringify({ status: 'bloqueado', motivo: 'ferramentas desligadas nesta chamada' }),
        }
      }
      return executeCallTool(
        { callId: input.callId, name: input.name, argsJson: input.argsJson },
        { getRuntime: agency.getRuntime, describeScreen: () => vision.describe() },
      )
    }),
    api.registry.register('call:checkInitiative', (payload): CallCheckInitiativeResult => {
      const input = parseOrThrow(CallCheckInitiativeInputSchema, payload, 'call:checkInitiative')
      return agency.initiative.check(input)
    }),
    api.registry.register('agency:approve', (payload) => {
      const input = parseOrThrow(AgencyResolveInputSchema, payload, 'agency:approve')
      return agency.approvals.approve({ cardId: input.cardId, ...(input.scope ? { scope: input.scope } : {}) })
    }),
    api.registry.register('agency:deny', (payload) => {
      const input = parseOrThrow(AgencyResolveInputSchema, payload, 'agency:deny')
      return agency.approvals.deny({ cardId: input.cardId })
    }),
    api.registry.register('call:transcribe', async (payload) => {
      const input = parseOrThrow(CallTranscribeInputSchema, payload, 'call:transcribe')
      const call = requireKnownCall(input.callId)
      // Phase 10.5: a cascade call uses its own STT provider (`settings.cascade.sttProviderId`).
      const cascadeStt = call.backend === 'cascade' ? deps.settings.get().cascade?.sttProviderId : undefined
      const sttProviderId =
        cascadeStt && (STT_PROVIDER_IDS as readonly string[]).includes(cascadeStt) ? (cascadeStt as SttProviderId) : undefined
      return transcribeCallAudio(
        {
          audioWavBase64: input.audioWavBase64,
          ...(input.language ? { language: input.language } : {}),
          ...(sttProviderId ? { providerId: sttProviderId } : {}),
        },
        { transcribe: deps.transcribe },
      )
    }),
    api.registry.register('call:recordTurn', async (payload) => {
      const input = parseOrThrow(CallRecordTurnInputSchema, payload, 'call:recordTurn')
      const call = requireKnownCall(input.callId)
      const retrieval = lastRetrievalByCall.get(input.callId) ?? null
      lastRetrievalByCall.delete(input.callId)
      let modelId: string | null = null
      try {
        const s = deps.settings.get()
        // Phase 10.5: a cascade turn was generated by the cascade LLM, not the llama.cpp model.
        modelId = call.backend === 'cascade' ? (resolveCascadeLlm(s).modelId ?? s.cascade.llmProviderId) : s.llamacpp.modelId
      } catch {
        modelId = null
      }
      return recorder.recordTurn({
        callId: input.callId,
        sessionId: call.sessionId,
        backendId: call.backend,
        modelId,
        userTranscript: input.userTranscript,
        assistantSpokenText: input.assistantSpokenText,
        ...(input.assistantFullText !== undefined ? { assistantFullText: input.assistantFullText } : {}),
        interrupted: input.interrupted,
        ...(input.playedMs !== undefined ? { playedMs: input.playedMs } : {}),
        ...(input.emotion !== undefined ? { emotion: input.emotion } : {}),
        ...(input.metrics !== undefined ? { metrics: input.metrics } : {}),
        ...(input.injectReason !== undefined ? { injectReason: input.injectReason } : {}),
        retrieval,
        // Test calls never reach the chat history, the mood or the memory.
        test: call.test,
      })
    }),
  ]

  const quality = registerCallQualityHandlers(api, deps, hub, requireKnownCall)
  // Phase 10.4 — cloud API keys (masked status only ever leaves the host).
  if (cloud) {
    unregisterFns.push(
      api.registry.register('liveMode:setApiKey', (payload) => {
        const input = parseOrThrow(LiveSetApiKeyInputSchema, payload, 'liveMode:setApiKey')
        return cloud.keys.set(input.provider, input.apiKey)
      }),
      api.registry.register('liveMode:getKeyStatus', () => cloud.keys.status()),
    )
  }
  const cascade = registerCascadeHandlers({
    registry: api.registry,
    emit: (event) => api.emit(event),
    getSettings: () => deps.settings.get(),
    getOrchestrator: () => deps.getTurnOrchestrator?.() ?? null,
    getKnownCall: (callId) => hub.getKnownCall(callId),
    getActiveCall: () => hub.getActiveCall(),
    getUserName: createCortexUserNameReader(deps.getCortex),
    toolDeps: { getRuntime: agency.getRuntime, describeScreen: () => vision.describe() },
    toolsAllowed: (call) => !call.test && agency.features().toolsInCall,
    getPendingActionNote: (callId) => {
      const rt = agency.getRuntime()
      const card = rt?.listPendingCards().filter((c) => rt.getCardOrigin(c.id)?.callId === callId).at(-1)
      if (!card) return null
      return `[Contexto] Ação pendente, AINDA NÃO feita: ${describePendingActionPt(card)}. Só acontece quando o usuário disser "pode" ou clicar em aprovar; nunca diga que já fez.`
    },
    ...(deps.onWarning ? { onWarning: deps.onWarning } : {}),
  })

  return {
    hub,
    voices: quality.voices,
    agencyBridge,
    setScreenCaptureProvider(provider) {
      screenCaptureProvider = provider
      vision.clearCache()
    },
    vision,
    cloud,
    unregister() {
      void cloud?.close().catch(() => undefined)
      for (const fn of unregisterFns) fn()
      quality.unregister()
      cascade.unregister()
      lastRetrievalByCall.clear()
      lastUserTextByCall.clear()
    },
  }
}

/**
 * Phase 10.2 — `call:classifyAffect|reportStage|synthesize|startTest|getTestInput|reportTestResult`
 * and `liveVoice:list|import|delete|preview` (the latter only when `deps.userDataDir` is set).
 */
export function registerCallQualityHandlers(
  api: CallHostApi,
  deps: CallHostDeps,
  hub: CallHub,
  requireKnownCall: (callId: string) => unknown,
): { voices: VoiceStore | null; unregister(): void } {
  const nowMs = deps.now ?? (() => Date.now())
  const voices = deps.userDataDir ? createVoiceStore({ userDataDir: deps.userDataDir, now: nowMs }) : null
  const synthesizer = createCallSynthesizer({
    getSettings: () => deps.settings.get(),
    engine: deps.engine,
    loadReferenceBase64: (id) => voices?.readWavBase64(id) ?? null,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.ttsTimeoutMs !== undefined ? { timeoutMs: deps.ttsTimeoutMs } : {}),
  })
  const testCalls = createTestCallManager({
    hub,
    synthesizer,
    engine: deps.engine,
    getSettings: () => deps.settings.get(),
    emit: (event) => api.emit(event),
    now: nowMs,
  })

  async function ensureEngineForTts(): Promise<void> {
    const settings = deps.settings.get()
    if (settings.llamacpp.endpoint !== 'managed') return
    const status = deps.engine.getStatus()
    if (status.running) return
    if (!status.installed) throw new Error('TTS_UNAVAILABLE: llama.cpp is not installed')
    const started = await deps.engine.start(settings.llamacpp.modelId)
    if (!started.running) throw new Error(`TTS_UNAVAILABLE: ${started.lastError ?? 'engine did not start'}`)
  }
  let engineStarting: Promise<void> | null = null
  const cascadeTts = createCascadeTtsRouter({
    getSettings: () => deps.settings.get(),
    llama: synthesizer,
    // Parallel phrases share one engine start.
    ensureLlamaEngine: () => {
      if (!engineStarting) engineStarting = ensureEngineForTts().finally(() => (engineStarting = null))
      return engineStarting
    },
    ...(deps.synthesizeSpeech ? { synthesizeSpeech: deps.synthesizeSpeech } : {}),
  })

  const unregisterFns = [
    api.registry.register('call:classifyAffect', (payload): CallStageSignal | null => {
      const input = parseOrThrow(CallClassifyAffectInputSchema, payload, 'call:classifyAffect')
      requireKnownCall(input.callId)
      return classifyCallAffect(input.text)
    }),
    api.registry.register('call:reportStage', (payload) => {
      const input = parseOrThrow(CallReportStageInputSchema, payload, 'call:reportStage')
      const active = hub.getActiveCall()
      if (!active || active.callId !== input.callId) return { emitted: false }
      const signal = normalizeStageSignal(input)
      if (!signal) return { emitted: false }
      api.emit({ type: 'call:stage', callId: input.callId, ...signal })
      return { emitted: true }
    }),
    api.registry.register('call:synthesize', (payload) => {
      const input = parseOrThrow(CallSynthesizeInputSchema, payload, 'call:synthesize')
      const call = requireKnownCall(input.callId) as { backend?: string } | null
      // Phase 10.5: cascade calls speak through `settings.cascade.ttsProviderId`.
      if (call?.backend === 'cascade') return cascadeTts.synthesize({ text: input.text })
      return synthesizer.synthesize({ text: input.text })
    }),
    api.registry.register('call:startTest', (payload) => {
      const input = parseOrThrow(CallStartInputSchema, payload, 'call:startTest')
      return testCalls.startTest(input)
    }),
    api.registry.register('call:getTestInput', (payload) => {
      const input = parseOrThrow(CallGetTestInputSchema, payload, 'call:getTestInput')
      return testCalls.getTestInput(input.callId)
    }),
    api.registry.register('call:reportTestResult', (payload) => {
      const input = parseOrThrow(CallReportTestResultInputSchema, payload, 'call:reportTestResult')
      return testCalls.reportTestResult(input)
    }),
  ]

  if (voices) {
    unregisterFns.push(
      api.registry.register('liveVoice:list', () => voices.list()),
      api.registry.register('liveVoice:import', (payload) => {
        const input = parseOrThrow(LiveVoiceImportInputSchema, payload, 'liveVoice:import')
        return voices.import(input)
      }),
      api.registry.register('liveVoice:delete', (payload) => {
        const input = parseOrThrow(LiveVoiceIdInputSchema, payload, 'liveVoice:delete')
        const deleted = voices.delete(input.id)
        synthesizer.invalidateReference(input.id)
        let settings = deps.settings.get()
        if (settings.hybrid.referenceVoiceId === input.id && deps.settings.save) {
          settings = deps.settings.save({ hybrid: { referenceVoiceId: null } })
        }
        return { deleted, voices: voices.list(), referenceVoiceId: settings.hybrid.referenceVoiceId }
      }),
      api.registry.register('liveVoice:preview', async (payload): Promise<LiveVoicePreviewResult> => {
        const input = parseOrThrow(LiveVoicePreviewInputSchema, payload, 'liveVoice:preview')
        let ref: string | null = null
        if (input.id) {
          ref = voices.readWavBase64(input.id)
          if (!ref) throw new Error(`VOICE_NOT_FOUND: ${input.id}`)
        }
        await ensureEngineForTts()
        const settings = deps.settings.get()
        const baseUrl = resolveLlamaBaseUrl(settings, deps.engine)
        if (!baseUrl) throw new Error('TTS_UNAVAILABLE: llama-server is not running')
        const text = input.text?.trim() || VOICE_PREVIEW_DEFAULT_TEXT
        const res = await requestLlamaTts({
          baseUrl,
          text,
          voice: settings.llamacpp.voice,
          speakerRefB64: ref,
          headers: deps.engine.getRequestHeaders?.() ?? {},
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.ttsTimeoutMs !== undefined ? { timeoutMs: deps.ttsTimeoutMs } : {}),
        })
        return { wavBase64: Buffer.from(res.wav).toString('base64'), latencyMs: res.latencyMs }
      }),
    )
  }

  return {
    voices,
    unregister() {
      for (const fn of unregisterFns) fn()
    },
  }
}
