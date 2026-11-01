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
  type CallContextResult,
  type LiveCallHostEvent,
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

export type CallHostCortex = CallRecorderCortex & Pick<AshyCortex, 'compileTurnPrompt' | 'db'>

export interface CallHostApi {
  readonly registry: LiveCallRegistry
  emit(event: LiveCallHostEvent): void
  getCallWindowController(): CallWindowControllerLike | null
}

export interface CallHostDeps {
  settings: CallSettingsSource
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
}

export interface CallHostHandlers {
  hub: CallHub
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
        ...(input.userText !== undefined ? { userText: input.userText } : {}),
        ...(input.interruptedAfterText !== undefined
          ? { interruptedAfterText: input.interruptedAfterText }
          : {}),
      })
      if (built.retrieval) {
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
      })
    }),
  ]

  return {
    hub,
    unregister() {
      for (const fn of unregisterFns) fn()
      lastRetrievalByCall.clear()
    },
  }
}
