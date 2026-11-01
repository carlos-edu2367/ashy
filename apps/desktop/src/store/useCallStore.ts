/**
 * Phase 10.1 — Live Call view store (hub + overlay). The host owns the authoritative
 * `CallStateSnapshot`; this slice only mirrors `call:state`, `call:viseme`, `engine:status`
 * and Live Mode settings, and sends control RPCs over `liveCall:invoke`.
 *
 * While a call is active, `call:viseme` drives the stage mouth by writing the existing
 * `useAshyStore` lip-sync fields; with no call the old voice path is untouched.
 */
import { create } from 'zustand'
import {
  IDLE_CALL_STATE,
  type AshyHostBridge,
  type AshyHostStreamEvent,
  type AshyVisemeKey,
  type CallEndReason,
  type CallStateSnapshot,
  type CallStatus,
  type CallVisemeFrame,
  type LiveCallMethod,
  type LiveModeSettings,
  type LlamaCppEngineStatus,
  type LlamaCppVariant,
  type SaveLiveModeSettingsInput,
} from '@ashy/shared'
import { getAshyHostBridge } from '../services/ashy-host-client'
import { useAshyStore } from './useAshyStore'

export const LIVE_MODE_DEFAULT_MODEL_ID = 'lfm3-omni-2b-q4km'

/** Error code the host uses when llama-server cannot run for lack of the MSVC runtime. */
export const VC_RUNTIME_MISSING_CODE = 'LLAMACPP_VC_RUNTIME_MISSING'

/** Engine status as the view sees it (VC runtime fields may be absent on an older host). */
export type EngineStatusView = Omit<LlamaCppEngineStatus, 'vcRuntimeMissing' | 'vcRuntimeInstall'> &
  Partial<Pick<LlamaCppEngineStatus, 'vcRuntimeMissing' | 'vcRuntimeInstall'>>

/** True when the engine reports (or an error says) the Visual C++ runtime is missing. */
export function isVcRuntimeMissing(
  status: EngineStatusView | null | undefined,
  lastError?: string | null,
): boolean {
  if (status?.vcRuntimeInstall?.status === 'completed') return false
  if (status?.vcRuntimeMissing === true) return true
  return [status?.lastError, lastError].some(
    (msg) => typeof msg === 'string' && msg.includes(VC_RUNTIME_MISSING_CODE),
  )
}

export function isCallActiveStatus(status: CallStatus): boolean {
  return status !== 'idle' && status !== 'ended'
}

/** Short pt-BR status label for the call button / overlay dot. */
export const CALL_STATUS_LABELS: Record<CallStatus, string> = {
  idle: 'Ligar',
  connecting: 'Conectando…',
  listening: 'Ouvindo',
  user_speaking: 'Você está falando',
  thinking: 'Pensando…',
  speaking: 'Falando',
  interrupt_pending: 'Ouvindo você…',
  reconnecting: 'Reconectando…',
  ended: 'Chamada encerrada',
}

/** Short pt-BR message for a call that ended with a reason. */
export const CALL_END_REASON_MESSAGES: Record<CallEndReason, string> = {
  user_hangup: 'Chamada encerrada.',
  mic_denied: 'Microfone bloqueado — permita o acesso ao microfone e ligue de novo.',
  mic_lost: 'O microfone foi desconectado durante a chamada.',
  backend_unavailable: 'Motor local indisponível — verifique em Configurações › Live Mode.',
  backend_error: 'Erro ao abrir a chamada — tente ligar de novo.',
  session_expired: 'A sessão de voz expirou — ligue de novo.',
  engine_not_installed: 'Motor local não instalado — abra Configurações › Live Mode',
  backend_not_implemented: 'Esse modo de chamada ainda não está disponível (em breve).',
}

/** Visual ring kind per status (spec §9.1). */
export type CallRingKind = 'neutral' | 'amber' | 'green' | 'pulse' | 'spinner' | 'waves' | 'ended'

export function callRingKind(status: CallStatus): CallRingKind {
  switch (status) {
    case 'connecting':
    case 'reconnecting':
      return 'amber'
    case 'listening':
      return 'green'
    case 'user_speaking':
    case 'interrupt_pending':
      return 'pulse'
    case 'thinking':
      return 'spinner'
    case 'speaking':
      return 'waves'
    case 'ended':
      return 'ended'
    default:
      return 'neutral'
  }
}

export type CallStoreBusyAction =
  | 'call'
  | 'install'
  | 'downloadModel'
  | 'startEngine'
  | 'stopEngine'
  | 'saveSettings'
  | 'installVcRuntime'

export interface CallStoreState {
  callState: CallStateSnapshot
  viseme: CallVisemeFrame | null
  engineStatus: EngineStatusView | null
  liveSettings: LiveModeSettings | null
  lastError: string | null
  busy: Partial<Record<CallStoreBusyAction, boolean>>
  initialized: boolean

  /** Subscribes to host events and bootstraps state (idempotent). */
  init(): Promise<void>
  dispose(): void
  handleHostEvent(event: AshyHostStreamEvent): void

  startCall(): Promise<void>
  stopCall(): Promise<void>
  toggleCall(): Promise<void>
  toggleMute(): Promise<void>
  installEngine(variant?: LlamaCppVariant): Promise<void>
  downloadModel(modelId?: string): Promise<void>
  startEngine(modelId?: string): Promise<void>
  stopEngine(): Promise<void>
  installVcRuntime(): Promise<void>
  saveLiveSettings(partial: SaveLiveModeSettingsInput): Promise<LiveModeSettings | null>
}

let unsubscribeHost: (() => void) | null = null
let subscribedBridge: AshyHostBridge | null = null
/** True while the call store is the one writing the stage lip-sync fields. */
let drivingStage = false
let chatRefreshInFlight = false
let chatRefreshQueued = false

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500)
}

function hasLiveCall(bridge: AshyHostBridge): boolean {
  return typeof bridge.invokeLiveCall === 'function'
}

function invoke<T>(method: LiveCallMethod, payload?: unknown): Promise<T> {
  const bridge = getAshyHostBridge()
  if (!hasLiveCall(bridge)) {
    return Promise.reject(new Error('Live Call indisponível neste host.'))
  }
  return bridge.invokeLiveCall!(
    payload === undefined ? { method } : { method, payload },
  ) as Promise<T>
}

const CLOSED_VOWELS = { A: 0, E: 0, I: 0, O: 0, U: 0 }

function releaseStage(): void {
  if (!drivingStage) return
  drivingStage = false
  useAshyStore.setState({
    isSpeaking: false,
    simulatedVowels: { ...CLOSED_VOWELS },
    activeViseme: 'closed',
    rawVolume: 0,
  })
}

function feedStage(frame: CallVisemeFrame, status: CallStatus): void {
  const entries: Array<[Exclude<AshyVisemeKey, 'closed'>, number]> = [
    ['A', frame.A],
    ['E', frame.E],
    ['I', frame.I],
    ['O', frame.O],
    ['U', frame.U],
  ]
  entries.sort((a, b) => b[1] - a[1])
  const top = entries[0]!
  const dominant: AshyVisemeKey = top[1] > 0.05 ? top[0] : 'closed'
  const volume = Math.min(1, Math.max(0, frame.volume))
  drivingStage = true
  useAshyStore.setState({
    isSpeaking: status === 'speaking' || volume > 0.02,
    simulatedVowels: { A: frame.A, E: frame.E, I: frame.I, O: frame.O, U: frame.U },
    activeViseme: dominant,
    rawVolume: volume,
  })
}

function refreshChatForSession(sessionId: string): void {
  const app = useAshyStore.getState()
  if (app.activeSessionId && app.activeSessionId !== sessionId) return
  if (chatRefreshInFlight) {
    chatRefreshQueued = true
    return
  }
  chatRefreshInFlight = true
  void useAshyStore
    .getState()
    .bootstrapFromHost()
    .catch(() => undefined)
    .finally(() => {
      chatRefreshInFlight = false
      if (chatRefreshQueued) {
        chatRefreshQueued = false
        refreshChatForSession(sessionId)
      }
    })
}

const initialCallStoreState = () => ({
  callState: { ...IDLE_CALL_STATE },
  viseme: null as CallVisemeFrame | null,
  engineStatus: null as EngineStatusView | null,
  liveSettings: null as LiveModeSettings | null,
  lastError: null as string | null,
  busy: {} as Partial<Record<CallStoreBusyAction, boolean>>,
  initialized: false,
})

export const useCallStore = create<CallStoreState>()((set, get) => {
  const withBusy = async <T>(action: CallStoreBusyAction, fn: () => Promise<T>): Promise<T | null> => {
    set((s) => ({ busy: { ...s.busy, [action]: true }, lastError: null }))
    try {
      return await fn()
    } catch (err) {
      set({ lastError: errorMessage(err) })
      return null
    } finally {
      set((s) => ({ busy: { ...s.busy, [action]: false } }))
    }
  }

  const applyCallState = (next: CallStateSnapshot | null | undefined): void => {
    if (!next || typeof next !== 'object' || typeof next.status !== 'string') return
    const prev = get().callState
    // Drop stale snapshots (the host stamps every emission).
    if (next.updatedAt && prev.updatedAt && next.updatedAt < prev.updatedAt) return
    set({ callState: { ...next } })
    if (!isCallActiveStatus(next.status)) {
      set({ viseme: null })
      releaseStage()
    } else if (next.status !== 'speaking' && prev.status === 'speaking') {
      releaseStage()
    }
  }

  const applyEngineStatus = (status: LlamaCppEngineStatus | null | undefined): void => {
    if (status && typeof status === 'object' && status.engineId === 'llamacpp') {
      set({ engineStatus: { ...status } })
    }
  }

  return {
    ...initialCallStoreState(),

    async init() {
      const bridge = getAshyHostBridge()
      if (!hasLiveCall(bridge)) return
      if (subscribedBridge !== bridge) {
        unsubscribeHost?.()
        subscribedBridge = bridge
        unsubscribeHost = bridge.onHostEvent((event) => get().handleHostEvent(event))
      }
      if (get().initialized) return
      set({ initialized: true })
      const [state, engine, settings] = await Promise.allSettled([
        invoke<CallStateSnapshot>('call:getState'),
        invoke<LlamaCppEngineStatus>('engines:getStatus'),
        invoke<LiveModeSettings>('liveMode:getSettings'),
      ])
      if (state.status === 'fulfilled') applyCallState(state.value)
      if (engine.status === 'fulfilled') applyEngineStatus(engine.value)
      if (settings.status === 'fulfilled' && settings.value) set({ liveSettings: settings.value })
    },

    dispose() {
      unsubscribeHost?.()
      unsubscribeHost = null
      subscribedBridge = null
      releaseStage()
      set({ initialized: false })
    },

    handleHostEvent(event) {
      switch (event.type) {
        case 'call:state':
          applyCallState(event.state)
          return
        case 'call:viseme': {
          const status = get().callState.status
          if (!isCallActiveStatus(status)) return
          const frame: CallVisemeFrame = {
            A: event.A,
            E: event.E,
            I: event.I,
            O: event.O,
            U: event.U,
            volume: event.volume,
          }
          set({ viseme: frame })
          feedStage(frame, status)
          return
        }
        case 'engine:status':
          applyEngineStatus(event.status)
          return
        case 'chat:appended':
          refreshChatForSession(event.sessionId)
          return
        default:
          return
      }
    },

    async startCall() {
      const res = await withBusy('call', () => invoke<CallStateSnapshot>('call:start', {}))
      applyCallState(res)
    },

    async stopCall() {
      const callId = get().callState.callId
      const res = await withBusy('call', () =>
        invoke<CallStateSnapshot>('call:stop', callId ? { callId } : {}),
      )
      applyCallState(res)
    },

    async toggleCall() {
      if (isCallActiveStatus(get().callState.status)) {
        await get().stopCall()
      } else {
        await get().startCall()
      }
    },

    async toggleMute() {
      const { callState } = get()
      if (!isCallActiveStatus(callState.status)) return
      try {
        const res = await invoke<CallStateSnapshot>('call:setMuted', { muted: !callState.muted })
        applyCallState(res)
      } catch (err) {
        set({ lastError: errorMessage(err) })
      }
    },

    async installEngine(variant) {
      const res = await withBusy('install', () =>
        invoke<LlamaCppEngineStatus>('engines:install', {
          engineId: 'llamacpp',
          ...(variant ? { variant } : {}),
        }),
      )
      applyEngineStatus(res)
    },

    async downloadModel(modelId) {
      const id = modelId ?? get().liveSettings?.llamacpp.modelId ?? LIVE_MODE_DEFAULT_MODEL_ID
      const res = await withBusy('downloadModel', () =>
        invoke<LlamaCppEngineStatus>('engines:downloadModel', { modelId: id }),
      )
      applyEngineStatus(res)
    },

    async startEngine(modelId) {
      const res = await withBusy('startEngine', () =>
        invoke<LlamaCppEngineStatus>('engines:start', modelId ? { modelId } : {}),
      )
      applyEngineStatus(res)
    },

    async stopEngine() {
      const res = await withBusy('stopEngine', () => invoke<LlamaCppEngineStatus>('engines:stop'))
      applyEngineStatus(res)
    },

    async installVcRuntime() {
      const res = await withBusy('installVcRuntime', () =>
        invoke<LlamaCppEngineStatus>('engines:installVcRuntime'),
      )
      applyEngineStatus(res)
    },

    async saveLiveSettings(partial) {
      const res = await withBusy('saveSettings', () =>
        invoke<LiveModeSettings>('liveMode:saveSettings', partial),
      )
      if (res) set({ liveSettings: res })
      return res
    },
  }
})

export function resetCallStoreForTesting(): void {
  unsubscribeHost?.()
  unsubscribeHost = null
  subscribedBridge = null
  drivingStage = false
  chatRefreshInFlight = false
  chatRefreshQueued = false
  useCallStore.setState(initialCallStoreState())
}
