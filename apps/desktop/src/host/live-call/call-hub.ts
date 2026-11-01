/**
 * Phase 10.1 — CallStateHub (spec §7.8): the host owns the authoritative
 * `CallStateSnapshot`. The hidden `call-engine` window reports transitions
 * (`call:reportState`); hub/overlay only read `call:state` and send control RPCs.
 * Every emission is a full snapshot stamped with `updatedAt`.
 */
import { randomUUID } from 'node:crypto'
import {
  IDLE_CALL_STATE,
  LIVE_BACKENDS_IMPLEMENTED,
  type CallEndReason,
  type CallRuntimeConfig,
  type CallStateSnapshot,
  type CallStatus,
  type CallVisemeFrame,
  type LiveBackendId,
  type LiveCallHostEvent,
  type LiveLocalModelSpec,
  type LiveModeSettings,
  type LlamaCppEngineStatus,
} from '@ashy/shared'

/** Narrow view of the Live Mode settings store (task A). */
export interface CallSettingsSource {
  get(): LiveModeSettings
}

/** Narrow view of the llama.cpp engine (task A). */
export interface CallEngineSource {
  getStatus(): LlamaCppEngineStatus
  start(modelId?: string): Promise<LlamaCppEngineStatus>
  getModelSpec(modelId: string): LiveLocalModelSpec | undefined
  /** Phase 10.2 (T3): auth headers for host → managed llama-server HTTP calls. */
  getRequestHeaders?(): Record<string, string>
}

export interface CallWindowControllerLike {
  ensure(): Promise<void>
  destroy(): void
}

export interface CallHubDeps {
  emit(event: LiveCallHostEvent): void
  settings: CallSettingsSource
  engine: CallEngineSource
  getCallWindowController(): CallWindowControllerLike | null
  /** Active chat session id (creating one when none exists). */
  resolveSessionId(): string | Promise<string>
  now?: () => number
  createCallId?: () => string
  /** Minimum interval between re-emitted viseme frames (default 1000/30 ms → ≤ 30 Hz). */
  visemeMinIntervalMs?: number
}

export interface CallRecord {
  callId: string
  sessionId: string
  backend: LiveBackendId
  /** Phase 10.2 test call: never persisted, no memory/affect side effects. */
  test: boolean
}

export interface CallHubStartInput {
  backend?: LiveBackendId
  /** Internal only (`call:startTest`); `call:start` never sets it. */
  test?: boolean
}

export interface CallHub {
  getState(): CallStateSnapshot
  /** The call currently in progress (null when idle/ended). */
  getActiveCall(): CallRecord | null
  /** Any call started by this hub recently (active or just ended), e.g. a turn recorded after hang-up. */
  getKnownCall(callId: string): CallRecord | null
  start(input: CallHubStartInput): Promise<CallStateSnapshot>
  stop(input: { callId?: string }): CallStateSnapshot
  setMuted(input: { muted: boolean }): CallStateSnapshot
  getRuntimeConfig(input: { callId?: string }): CallRuntimeConfig
  reportState(input: CallReportStateInput): CallStateSnapshot
  /** Returns true when the frame was re-emitted (false = throttled or no active call). */
  reportViseme(frame: CallVisemeFrame): boolean
}

export interface CallReportStateInput {
  callId: string
  status: CallStatus
  caption?: CallStateSnapshot['caption']
  metrics?: CallStateSnapshot['metrics']
  reason?: CallEndReason | null
  detail?: string | null
}

export class CallNotActiveError extends Error {
  readonly code = 'CALL_NOT_ACTIVE' as const
  constructor(callId?: string) {
    super(`CALL_NOT_ACTIVE${callId ? `: ${callId}` : ''}`)
    this.name = 'CallNotActiveError'
  }
}

const TERMINAL_STATUSES = new Set<CallStatus>(['idle', 'ended'])
const MAX_KNOWN_CALLS = 20
const DEFAULT_CONTEXT_SIZE = 8192

function isLlamaCppBackend(backend: LiveBackendId): boolean {
  return backend === 'llamacpp-realtime' || backend === 'llamacpp-hybrid'
}

export function createCallHub(deps: CallHubDeps): CallHub {
  const now = deps.now ?? (() => Date.now())
  const createCallId = deps.createCallId ?? (() => `call-${randomUUID()}`)
  const visemeMinIntervalMs = deps.visemeMinIntervalMs ?? 1000 / 30

  let state: CallStateSnapshot = { ...IDLE_CALL_STATE }
  let active: CallRecord | null = null
  let startInFlight: Promise<CallStateSnapshot> | null = null
  /** Bumped by stop(); a start that awaited across a bump is abandoned. */
  let generation = 0
  let lastVisemeAt = Number.NEGATIVE_INFINITY
  const knownCalls = new Map<string, CallRecord>()

  function publish(next: Omit<CallStateSnapshot, 'updatedAt'>): CallStateSnapshot {
    state = { ...next, updatedAt: now() }
    deps.emit({ type: 'call:state', state: { ...state } })
    return { ...state }
  }

  function remember(record: CallRecord): void {
    knownCalls.set(record.callId, record)
    while (knownCalls.size > MAX_KNOWN_CALLS) {
      const oldest = knownCalls.keys().next().value
      if (oldest === undefined) break
      knownCalls.delete(oldest)
    }
  }

  function endWith(
    reason: CallEndReason,
    detail: string | null,
    base: Partial<CallStateSnapshot> = {},
  ): CallStateSnapshot {
    active = null
    return publish({
      ...IDLE_CALL_STATE,
      ...base,
      status: 'ended',
      reason,
      detail,
    })
  }

  async function ensureEngineRunning(
    settings: LiveModeSettings,
    backend: LiveBackendId,
  ): Promise<{ ok: true } | { ok: false; reason: CallEndReason; detail: string }> {
    const modelId = settings.llamacpp.modelId
    let status: LlamaCppEngineStatus
    try {
      status = deps.engine.getStatus()
    } catch (err) {
      return { ok: false, reason: 'backend_unavailable', detail: errorMessage(err) }
    }
    const managed = settings.llamacpp.endpoint === 'managed'
    if (managed) {
      if (!status.installed) {
        return { ok: false, reason: 'engine_not_installed', detail: 'llama.cpp is not installed' }
      }
      if (!deps.engine.getModelSpec(modelId) || !status.installedModelIds.includes(modelId)) {
        return {
          ok: false,
          reason: 'engine_not_installed',
          detail: `model not installed: ${modelId}`,
        }
      }
    }
    if (status.running && (!managed || !status.activeModelId || status.activeModelId === modelId)) {
      return { ok: true }
    }
    try {
      const started = await deps.engine.start(modelId)
      if (!started.running) {
        return {
          ok: false,
          reason: 'backend_unavailable',
          detail: started.lastError ?? `${backend}: engine did not start`,
        }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: 'backend_unavailable', detail: errorMessage(err) }
    }
  }

  async function doStart(input: CallHubStartInput): Promise<CallStateSnapshot> {
    const myGeneration = generation
    const settings = deps.settings.get()
    const backend = input.backend ?? settings.backend

    if (!LIVE_BACKENDS_IMPLEMENTED.includes(backend)) {
      return endWith('backend_not_implemented', `backend not implemented: ${backend}`, { backend })
    }

    if (isLlamaCppBackend(backend)) {
      const engineCheck = await ensureEngineRunning(settings, backend)
      if (generation !== myGeneration) return { ...state }
      if (!engineCheck.ok) {
        return endWith(engineCheck.reason, engineCheck.detail, { backend })
      }
    }

    const sessionId = await deps.resolveSessionId()
    if (generation !== myGeneration) return { ...state }
    const callId = createCallId()

    const controller = deps.getCallWindowController()
    if (controller) {
      try {
        await controller.ensure()
      } catch (err) {
        if (generation !== myGeneration) return { ...state }
        return endWith('backend_error', `call window unavailable: ${errorMessage(err)}`, {
          backend,
          sessionId,
        })
      }
      if (generation !== myGeneration) return { ...state }
    }

    const test = input.test === true
    active = { callId, sessionId, backend, test }
    remember(active)
    deps.emit({
      type: 'call:command',
      command: 'start',
      callId,
      backend,
      sessionId,
      ...(test ? { test: true } : {}),
    })
    return publish({
      ...IDLE_CALL_STATE,
      callId,
      status: 'connecting',
      muted: false,
      backend,
      sessionId,
    })
  }

  return {
    getState() {
      return { ...state }
    },

    getActiveCall() {
      return active ? { ...active } : null
    },

    getKnownCall(callId) {
      const record = knownCalls.get(callId)
      return record ? { ...record } : null
    },

    async start(input) {
      if (active && !TERMINAL_STATUSES.has(state.status)) {
        return { ...state }
      }
      if (startInFlight) {
        return startInFlight
      }
      startInFlight = doStart(input)
      try {
        return await startInFlight
      } finally {
        startInFlight = null
      }
    },

    stop(input) {
      if (input.callId && active && input.callId !== active.callId) {
        return { ...state }
      }
      generation += 1
      if (!active) {
        if (state.status === 'ended') {
          return publish({ ...IDLE_CALL_STATE })
        }
        return { ...state }
      }
      const { callId, backend, sessionId } = active
      deps.emit({ type: 'call:command', command: 'stop', callId })
      endWith('user_hangup', null, { callId, backend, sessionId, muted: state.muted })
      return publish({ ...IDLE_CALL_STATE })
    },

    setMuted(input) {
      if (!active) return { ...state }
      if (state.muted === input.muted) return { ...state }
      deps.emit({ type: 'call:command', command: 'setMuted', callId: active.callId, muted: input.muted })
      return publish({ ...state, muted: input.muted })
    },

    getRuntimeConfig(input) {
      if (!active || (input.callId && input.callId !== active.callId)) {
        throw new CallNotActiveError(input.callId)
      }
      const settings = deps.settings.get()
      let llamacpp: CallRuntimeConfig['llamacpp'] = null
      if (isLlamaCppBackend(active.backend)) {
        let status: LlamaCppEngineStatus | null = null
        try {
          status = deps.engine.getStatus()
        } catch {
          status = null
        }
        const modelId = status?.activeModelId ?? settings.llamacpp.modelId
        const endpoint = settings.llamacpp.endpoint
        const baseUrl =
          status?.baseUrl ?? (endpoint !== 'managed' ? endpoint.url.replace(/\/+$/, '') : null)
        if (baseUrl) {
          llamacpp = {
            baseUrl,
            modelId,
            contextSize: deps.engine.getModelSpec(modelId)?.contextSize ?? DEFAULT_CONTEXT_SIZE,
          }
        }
      }
      return {
        callId: active.callId,
        backend: active.backend,
        sessionId: active.sessionId,
        settings,
        llamacpp,
      }
    },

    reportState(input) {
      if (!active || input.callId !== active.callId) {
        return { ...state }
      }
      const next: Omit<CallStateSnapshot, 'updatedAt'> = {
        ...state,
        status: input.status,
        ...(input.caption !== undefined ? { caption: input.caption } : {}),
        ...(input.metrics !== undefined
          ? { metrics: input.metrics === null ? null : { ...(state.metrics ?? {}), ...input.metrics } }
          : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
      }
      if (TERMINAL_STATUSES.has(input.status)) {
        active = null
      }
      return publish(next)
    },

    reportViseme(frame) {
      if (!active) return false
      const t = now()
      if (t - lastVisemeAt < visemeMinIntervalMs - 0.5) {
        return false
      }
      lastVisemeAt = t
      deps.emit({
        type: 'call:viseme',
        A: frame.A,
        E: frame.E,
        I: frame.I,
        O: frame.O,
        U: frame.U,
        volume: frame.volume,
      })
      return true
    },
  }
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500)
}
