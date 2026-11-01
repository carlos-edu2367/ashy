/**
 * Phase 10.1 — boot of the hidden `call-engine` renderer (spec §5.1, plan W2/D).
 *
 * The call-engine window renders no UI. It listens to `call:command` host events and owns the
 * CallEngine (mic, VAD, backend session, playback). Everything it needs from the host goes through
 * the generic `liveCall:invoke` RPC (`call:getRuntimeConfig|buildContext|transcribe|recordTurn|
 * reportState|reportViseme`).
 *
 * Phase 10.2: the session is chosen by backend (`llamacpp-realtime`, or `llamacpp-hybrid` whose text
 * answer is spoken through `call:synthesize`); a `start {test:true}` command fetches
 * `call:getTestInput` and runs the engine on that WAV instead of the mic.
 *
 * Phase 10.3: `call:command inject` (active callId only) → `engine.inject`; the host adapter also
 * carries `call:executeTool` and `call:checkInitiative`.
 *
 * Phase 10.4: `openai-realtime` / `gemini-live` drive a cloud speech-to-speech session through the
 * host's loopback relay (`config.cloud`; the API key never reaches this window).
 * Phase 10.5: `cascade` (host STT → text LLM via the turn orchestrator → chunked TTS), see `./cascade`.
 *
 * Without the Electron preload (plain-browser dev over the HTTP bridge) the hub mounts this boot
 * inline instead (see `shouldMountCallEngineInline`).
 */
import type {
  AshyHostBridge,
  AshyHostStreamEvent,
  CallCheckInitiativeResult,
  CallCommand,
  CallContextResult,
  CallEndReason,
  CallExecuteToolResult,
  CallRuntimeConfig,
  CallStateSnapshot,
  CallStageSignal,
  CallStatus,
  CallSynthesizeResult,
  CallTestInput,
  CallTranscribeResult,
  LiveCallMethod,
} from '@ashy/shared'
import {
  createCallEngine,
  createCloudVoiceSession,
  createLlamaCppHybridSession,
  createLlamaCppRealtimeSession,
  isCloudBackend,
  type CallEngineHost,
  type VoiceSession,
} from '@ashy/voice'
import { getAshyHostBridge } from '../services/ashy-host-client'
import { createCascadeCallEngine, createCascadeSessionOverBridge } from './cascade'

/** URL of the Silero VAD model served from `apps/desktop/public/models`. */
export const SILERO_VAD_MODEL_URL = '/models/silero_vad.onnx'

/** Minimal engine surface the boot drives (matches `CallEngine` from `@ashy/voice`). */
export interface CallEngineLike {
  start(): Promise<CallStatus>
  stop(reason?: CallEndReason, detail?: string): Promise<void>
  setMuted(muted: boolean): void
  getStatus(): CallStatus
  /** Phase 10.3 — proactive speech (`call:command inject`); see `CallEngine.inject`. */
  inject?(contextText: string, reason: 'approval' | 'initiative'): unknown
}

export interface CreateCallEngineArgs {
  config: CallRuntimeConfig
  host: CallEngineHost
  /** Phase 10.2 test call: synthetic question that replaces the microphone. */
  testInput?: CallTestInput
}

export type CallEngineFactory = (args: CreateCallEngineArgs) => CallEngineLike

export interface CallEngineBootOptions {
  bridge?: AshyHostBridge
  createEngine?: CallEngineFactory
  log?: (message: string, data?: unknown) => void
  /** Query `call:getState` at boot and adopt a `connecting` call (default true). */
  recoverPendingStart?: boolean
}

export interface CallEngineBoot {
  /** Routes one command (also used by tests; the boot subscribes to host events itself). */
  handleCommand(command: CallCommand): Promise<void>
  getActiveCallId(): string | null
  dispose(): void
}

export function isCallEngineView(search?: string): boolean {
  const raw =
    search ?? (typeof window !== 'undefined' ? (window.location?.search ?? '') : '')
  try {
    return new URLSearchParams(raw).get('view') === 'call-engine'
  } catch {
    return raw.includes('view=call-engine')
  }
}

/** The hub mounts the call-engine inline only when there is no Electron preload (HTTP dev bridge). */
export function shouldMountCallEngineInline(): boolean {
  if (typeof window === 'undefined') return false
  return !(window as unknown as { ashyHost?: unknown }).ashyHost
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000)
}

const TERMINAL: ReadonlySet<CallStatus> = new Set<CallStatus>(['idle', 'ended'])

const SESSION_BACKENDS: ReadonlySet<string> = new Set([
  'llamacpp-realtime',
  'llamacpp-hybrid',
  'openai-realtime',
  'gemini-live',
  'cascade',
])

/**
 * Backend session for a runtime config: `llamacpp-realtime` | `llamacpp-hybrid`, the cloud
 * `openai-realtime` / `gemini-live`, or `cascade`.
 */
export function createBackendSession(config: CallRuntimeConfig, host: CallEngineHost): VoiceSession {
  if (isCloudBackend(config.backend)) return createCloudVoiceSession(config)
  if (config.backend === 'cascade') return createCascadeSessionOverBridge({ config, host })
  const llamacpp = config.llamacpp
  if (!llamacpp) {
    throw new Error(`backend ${config.backend} has no llama.cpp endpoint`)
  }
  if (config.backend === 'llamacpp-hybrid') {
    return createLlamaCppHybridSession({
      baseUrl: llamacpp.baseUrl,
      modelId: llamacpp.modelId,
      maxOutputTokens: config.settings.llamacpp.maxOutputTokens,
      maxParallelTts: config.settings.hybrid?.maxParallelTts ?? 2,
      synthesize: (text) => host.synthesize({ callId: config.callId, text }),
    })
  }
  if (config.backend === 'llamacpp-realtime') {
    return createLlamaCppRealtimeSession({
      baseUrl: llamacpp.baseUrl,
      modelId: llamacpp.modelId,
      inputMode: config.settings.llamacpp.inputMode,
      maxOutputTokens: config.settings.llamacpp.maxOutputTokens,
    })
  }
  throw new Error(`backend not implemented in the call engine: ${config.backend}`)
}

/** Default factory: CallEngine over the backend's session (cloud, cascade or llama.cpp). */
export const createDefaultCallEngine: CallEngineFactory = ({ config, host, testInput }) => {
  // Fail fast (before the mic opens) on a backend this window can't drive.
  if (!SESSION_BACKENDS.has(config.backend)) {
    throw new Error(`backend not implemented in the call engine: ${config.backend}`)
  }
  if (isCloudBackend(config.backend)) {
    if (!config.cloud) throw new Error(`backend ${config.backend} has no cloud endpoint`)
    return createCallEngine({
      callId: config.callId,
      settings: config.settings,
      host,
      vadModelUrl: SILERO_VAD_MODEL_URL,
      ...(testInput ? { testInput } : {}),
      createSession: () => createCloudVoiceSession(config),
    })
  }
  if (config.backend === 'cascade') {
    return createCascadeCallEngine({ config, host, ...(testInput ? { testInput } : {}) })
  }
  const llamacpp = config.llamacpp
  if (!llamacpp) {
    throw new Error(`backend ${config.backend} has no llama.cpp endpoint`)
  }
  return createCallEngine({
    callId: config.callId,
    settings: config.settings,
    host,
    vadModelUrl: SILERO_VAD_MODEL_URL,
    contextSize: llamacpp.contextSize,
    ...(testInput ? { testInput } : {}),
    createSession: () => createBackendSession(config, host),
  })
}

export function createCallEngineHostOverBridge(bridge: AshyHostBridge): CallEngineHost {
  const invoke = <T>(method: LiveCallMethod, payload: unknown): Promise<T> => {
    if (typeof bridge.invokeLiveCall !== 'function') {
      return Promise.reject(new Error('LIVE_CALL_UNAVAILABLE: bridge has no invokeLiveCall'))
    }
    return bridge.invokeLiveCall({ method, payload }) as Promise<T>
  }
  return {
    buildContext: (input) => invoke<CallContextResult>('call:buildContext', input),
    transcribe: (input) => invoke<CallTranscribeResult>('call:transcribe', input),
    recordTurn: (input) => invoke<unknown>('call:recordTurn', input),
    reportState: (input) => invoke<unknown>('call:reportState', input),
    reportViseme: (frame) => invoke<unknown>('call:reportViseme', frame),
    classifyAffect: (input) => invoke<CallStageSignal | null>('call:classifyAffect', input),
    reportStage: (input) => invoke<unknown>('call:reportStage', input),
    reportTestResult: (input) => invoke<unknown>('call:reportTestResult', input),
    synthesize: (input) => invoke<CallSynthesizeResult>('call:synthesize', input),
    // Phase 10.3
    executeTool: (input) => invoke<CallExecuteToolResult>('call:executeTool', input),
    checkInitiative: (input) => invoke<CallCheckInitiativeResult>('call:checkInitiative', input),
  }
}

interface ActiveCall {
  callId: string
  engine: CallEngineLike | null
  starting: boolean
  stopRequested: boolean
  muted: boolean | null
  /** Phase 10.3: inject received before the engine was created. */
  pendingInject: { contextText: string; reason: 'approval' | 'initiative' } | null
}

export function bootCallEngine(options: CallEngineBootOptions = {}): CallEngineBoot {
  const bridge = options.bridge ?? getAshyHostBridge()
  const createEngine = options.createEngine ?? createDefaultCallEngine
  const log =
    options.log ??
    ((message: string, data?: unknown) => {
      if (typeof console !== 'undefined') console.info(`[call-engine] ${message}`, data ?? '')
    })
  const host = createCallEngineHostOverBridge(bridge)
  let current: ActiveCall | null = null
  let disposed = false

  const isRunning = (call: ActiveCall | null): boolean => {
    if (!call) return false
    if (call.starting) return true
    if (!call.engine) return false
    try {
      return !TERMINAL.has(call.engine.getStatus())
    } catch {
      return false
    }
  }

  const reportEnded = async (callId: string, reason: CallEndReason, detail: string) => {
    try {
      await host.reportState({ callId, status: 'ended', reason, detail })
    } catch (err) {
      log('reportState(ended) failed', err)
    }
  }

  const start = async (callId: string, test: boolean | 'probe' = false): Promise<void> => {
    if (current && current.callId === callId) {
      log('ignoring duplicate start', callId)
      return
    }
    if (current && isRunning(current)) {
      log('ignoring start while another call is running', { running: current.callId, callId })
      return
    }
    const call: ActiveCall = {
      callId,
      engine: null,
      starting: true,
      stopRequested: false,
      muted: null,
      pendingInject: null,
    }
    current = call
    try {
      let config: CallRuntimeConfig
      try {
        config = (await host_getRuntimeConfig(callId)) as CallRuntimeConfig
        if (!config || config.callId !== callId) {
          throw new Error(`runtime config mismatch for ${callId}`)
        }
      } catch (err) {
        if (!call.stopRequested && !disposed) {
          await reportEnded(callId, 'backend_error', `runtime config: ${errorMessage(err)}`)
        }
        return
      }
      if (call.stopRequested || disposed || current !== call) return

      // Phase 10.2 test call: the synthetic question replaces the microphone.
      let testInput: CallTestInput | undefined
      if (test) {
        try {
          const raw = (await invokeRaw('call:getTestInput', { callId })) as CallTestInput | null
          if (!raw || typeof raw.wavBase64 !== 'string' || raw.wavBase64.length === 0) {
            throw new Error('empty test input')
          }
          testInput = raw
        } catch (err) {
          if (test === true) {
            if (!call.stopRequested && !disposed) {
              await reportEnded(callId, 'backend_error', `test input: ${errorMessage(err)}`)
            }
            return
          }
          // 'probe' (recovered start without the flag): not a test call.
        }
        if (call.stopRequested || disposed || current !== call) return
      }

      let engine: CallEngineLike
      try {
        engine = createEngine({ config, host, ...(testInput ? { testInput } : {}) })
      } catch (err) {
        await reportEnded(callId, 'backend_unavailable', errorMessage(err))
        return
      }
      call.engine = engine
      if (call.muted !== null) engine.setMuted(call.muted)
      if (call.pendingInject && typeof engine.inject === 'function') {
        // Queued by the engine until the call reaches `listening` (30 s expiry).
        const { contextText, reason } = call.pendingInject
        call.pendingInject = null
        try {
          engine.inject(contextText, reason)
        } catch (err) {
          log('engine.inject failed', err)
        }
      }
      try {
        await engine.start()
      } catch (err) {
        await reportEnded(callId, 'backend_unavailable', errorMessage(err))
        try {
          await engine.stop('backend_unavailable', errorMessage(err))
        } catch {
          // ignore
        }
        return
      }
      if (call.stopRequested) {
        await engine.stop('user_hangup').catch(() => undefined)
      }
    } finally {
      call.starting = false
    }
  }

  const invokeRaw = (method: LiveCallMethod, payload: unknown): Promise<unknown> => {
    if (typeof bridge.invokeLiveCall !== 'function') {
      return Promise.reject(new Error('LIVE_CALL_UNAVAILABLE: bridge has no invokeLiveCall'))
    }
    return bridge.invokeLiveCall({ method, payload })
  }
  const host_getRuntimeConfig = (callId: string): Promise<unknown> =>
    invokeRaw('call:getRuntimeConfig', { callId })

  const handleCommand = async (command: CallCommand): Promise<void> => {
    if (disposed) return
    if (command.command === 'start') {
      await start(command.callId, command.test === true)
      return
    }
    const call = current
    if (!call || call.callId !== command.callId) {
      log(`ignoring ${command.command} for another call`, command.callId)
      return
    }
    if (command.command === 'stop') {
      call.stopRequested = true
      if (call.engine) {
        try {
          await call.engine.stop('user_hangup')
        } catch (err) {
          log('engine.stop failed', err)
        }
      }
      return
    }
    if (command.command === 'inject') {
      // Phase 10.3: approval result / initiative. The engine speaks only when listening (else it
      // queues one item for 30 s); before the engine exists the latest inject waits on the call.
      if (call.stopRequested) return
      const reason = command.reason === 'initiative' ? 'initiative' : 'approval'
      const contextText = typeof command.contextText === 'string' ? command.contextText : ''
      if (!contextText.trim()) return
      if (call.engine) {
        if (typeof call.engine.inject !== 'function') {
          log('engine has no inject; ignoring', command.callId)
          return
        }
        try {
          const outcome = call.engine.inject(contextText, reason)
          log(`inject (${reason}): ${outcome}`, command.callId)
        } catch (err) {
          log('engine.inject failed', err)
        }
      } else {
        call.pendingInject = { contextText, reason }
      }
      return
    }
    call.muted = command.muted
    call.engine?.setMuted(command.muted)
  }

  const unsubscribe = bridge.onHostEvent((event: AshyHostStreamEvent) => {
    if (event.type !== 'call:command') return
    const { type: _type, ...rest } = event as { type: 'call:command' } & CallCommand
    void handleCommand(rest as CallCommand).catch((err) => log('command failed', err))
  })

  // A `start` emitted before this subscription existed would be lost: pick up a call the host
  // has just put in `connecting` that nobody owns yet.
  if (options.recoverPendingStart !== false && typeof bridge.invokeLiveCall === 'function') {
    void Promise.resolve()
      .then(() => bridge.invokeLiveCall!({ method: 'call:getState' }))
      .then((raw) => {
        const state = raw as CallStateSnapshot | null | undefined
        if (disposed || current || !state?.callId || state.status !== 'connecting') return
        log('recovering pending start', state.callId)
        // The snapshot doesn't carry the test flag: probe `call:getTestInput` (unknown → normal call).
        return start(state.callId, 'probe')
      })
      .catch(() => undefined)
  }

  return {
    handleCommand,
    getActiveCallId: () => current?.callId ?? null,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      const call = current
      current = null
      if (call) {
        call.stopRequested = true
        void call.engine?.stop('user_hangup').catch(() => undefined)
      }
    },
  }
}
