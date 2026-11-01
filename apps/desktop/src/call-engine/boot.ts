/**
 * Phase 10.1 — boot of the hidden `call-engine` renderer (spec §5.1, plan W2/D).
 *
 * The call-engine window renders no UI. It listens to `call:command` host events and owns the
 * CallEngine (mic, VAD, backend session, playback). Everything it needs from the host goes through
 * the generic `liveCall:invoke` RPC (`call:getRuntimeConfig|buildContext|transcribe|recordTurn|
 * reportState|reportViseme`).
 *
 * Without the Electron preload (plain-browser dev over the HTTP bridge) the hub mounts this boot
 * inline instead (see `shouldMountCallEngineInline`).
 */
import type {
  AshyHostBridge,
  AshyHostStreamEvent,
  CallCommand,
  CallContextResult,
  CallEndReason,
  CallRuntimeConfig,
  CallStateSnapshot,
  CallStatus,
  CallTranscribeResult,
  LiveCallMethod,
} from '@ashy/shared'
import {
  createCallEngine,
  createLlamaCppRealtimeSession,
  type CallEngineHost,
} from '@ashy/voice'
import { getAshyHostBridge } from '../services/ashy-host-client'

/** URL of the Silero VAD model served from `apps/desktop/public/models`. */
export const SILERO_VAD_MODEL_URL = '/models/silero_vad.onnx'

/** Minimal engine surface the boot drives (matches `CallEngine` from `@ashy/voice`). */
export interface CallEngineLike {
  start(): Promise<CallStatus>
  stop(reason?: CallEndReason, detail?: string): Promise<void>
  setMuted(muted: boolean): void
  getStatus(): CallStatus
}

export interface CreateCallEngineArgs {
  config: CallRuntimeConfig
  host: CallEngineHost
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

/** Default factory: CallEngine over a llama.cpp `/v1/realtime` session. */
export const createDefaultCallEngine: CallEngineFactory = ({ config, host }) => {
  const llamacpp = config.llamacpp
  if (!llamacpp) {
    throw new Error(`backend ${config.backend} has no llama.cpp endpoint`)
  }
  return createCallEngine({
    callId: config.callId,
    settings: config.settings,
    host,
    vadModelUrl: SILERO_VAD_MODEL_URL,
    createSession: () =>
      createLlamaCppRealtimeSession({
        baseUrl: llamacpp.baseUrl,
        modelId: llamacpp.modelId,
        inputMode: config.settings.llamacpp.inputMode,
        maxOutputTokens: config.settings.llamacpp.maxOutputTokens,
      }),
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
  }
}

interface ActiveCall {
  callId: string
  engine: CallEngineLike | null
  starting: boolean
  stopRequested: boolean
  muted: boolean | null
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

  const start = async (callId: string): Promise<void> => {
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

      let engine: CallEngineLike
      try {
        engine = createEngine({ config, host })
      } catch (err) {
        await reportEnded(callId, 'backend_unavailable', errorMessage(err))
        return
      }
      call.engine = engine
      if (call.muted !== null) engine.setMuted(call.muted)
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

  const host_getRuntimeConfig = (callId: string): Promise<unknown> => {
    if (typeof bridge.invokeLiveCall !== 'function') {
      return Promise.reject(new Error('LIVE_CALL_UNAVAILABLE: bridge has no invokeLiveCall'))
    }
    return bridge.invokeLiveCall({ method: 'call:getRuntimeConfig', payload: { callId } })
  }

  const handleCommand = async (command: CallCommand): Promise<void> => {
    if (disposed) return
    if (command.command === 'start') {
      await start(command.callId)
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
        return handleCommand({
          command: 'start',
          callId: state.callId,
          backend: state.backend ?? 'llamacpp-realtime',
          sessionId: state.sessionId ?? '',
        })
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
