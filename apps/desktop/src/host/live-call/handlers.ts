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

export type CallHostCortex = CallRecorderCortex & Pick<AshyCortex, 'compileTurnPrompt' | 'db'>

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
}

export interface CallHostHandlers {
  hub: CallHub
  /** Present when `userDataDir` was given. */
  voices: VoiceStore | null
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
  })
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
      const built = await contextBuilder.build({
        sessionId: call.sessionId,
        // Hybrid: the realtime session answers in TEXT (llama-server /tts speaks it).
        mode: call.backend === 'llamacpp-hybrid' ? 'text' : 'audio',
        ...(input.userText !== undefined ? { userText: input.userText } : {}),
        ...(input.interruptedAfterText !== undefined
          ? { interruptedAfterText: input.interruptedAfterText }
          : {}),
      })
      if (built.retrieval && !call.test) {
        lastRetrievalByCall.set(input.callId, built.retrieval)
      }
      return {
        sessionId: built.sessionId,
        instructions: built.instructions,
        perTurnContext: built.perTurnContext,
        ...(built.userLabel ? { userLabel: built.userLabel } : {}),
      }
    }),
    api.registry.register('call:transcribe', async (payload) => {
      const input = parseOrThrow(CallTranscribeInputSchema, payload, 'call:transcribe')
      requireKnownCall(input.callId)
      return transcribeCallAudio(
        {
          audioWavBase64: input.audioWavBase64,
          ...(input.language ? { language: input.language } : {}),
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
        modelId = deps.settings.get().llamacpp.modelId
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
        retrieval,
        // Test calls never reach the chat history, the mood or the memory.
        test: call.test,
      })
    }),
  ]

  const quality = registerCallQualityHandlers(api, deps, hub, requireKnownCall)

  return {
    hub,
    voices: quality.voices,
    unregister() {
      for (const fn of unregisterFns) fn()
      quality.unregister()
      lastRetrievalByCall.clear()
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
      requireKnownCall(input.callId)
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
