/**
 * Phase 10.1 — Live Call view store (hub + overlay). The host owns the authoritative
 * `CallStateSnapshot`; this slice only mirrors `call:state`, `call:viseme`, `engine:status`
 * and Live Mode settings, and sends control RPCs over `liveCall:invoke`.
 *
 * While a call is active, `call:viseme` drives the stage mouth by writing the existing
 * `useAshyStore` lip-sync fields; with no call the old voice path is untouched.
 *
 * Phase 10.2: `call:stage` (emotion/motion at the moment a segment starts playing) drives the
 * stage emotion fields during a call; reference voices (`liveVoice:*`) and the test call
 * (`call:startTest` → `call:testResult`) live here too.
 *
 * Phase 10.3: push approval cards (`agency:pending` / `agency:resolved`, also outside calls),
 * the "vendo a tela" flag (`vision:capture`, auto-off after 5 s) and `agency:approve|deny`.
 *
 * Phase 10.4: cloud API keys (`liveMode:setApiKey` / `liveMode:getKeyStatus`). Only the host's
 * masked status is kept here — the key itself never lives in the store.
 */
import { create } from 'zustand'
import {
  ASHY_EMOTIONS,
  IDLE_CALL_STATE,
  LIVE_KEY_PROVIDERS,
  type AgencyPendingCardView,
  type AshyEmotion,
  type AshyHostBridge,
  type AshyHostStreamEvent,
  type AshyVisemeKey,
  type CallEndReason,
  type CallStateSnapshot,
  type CallStatus,
  type CallTestResult,
  type CallVisemeFrame,
  type LiveCallMethod,
  type LiveKeyProvider,
  type LiveKeyStatus,
  type LiveModeSettings,
  type LiveVoicePreviewResult,
  type LlamaCppEngineStatus,
  type LlamaCppVariant,
  type SaveLiveModeSettingsInput,
  type VoiceReference,
} from '@ashy/shared'
import { getAshyHostBridge } from '../services/ashy-host-client'
import {
  isAcceptedVoiceFile,
  normalizeVoiceReference,
  readFileAsArrayBuffer,
  voiceNameFromFile,
  type VoiceReferenceAudioDeps,
} from '../services/voice-reference-audio'
import { resolveMotionPreset, useAshyStore } from './useAshyStore'

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
  | 'voiceImport'
  | 'voicePreview'
  | 'voiceDelete'
  | 'testCall'
  | 'apiKey'

/** Phase 10.3: the "👁 vendo a tela" flag turns itself off after this long without a closing event. */
export const VISION_CAPTURE_AUTO_OFF_MS = 5_000
/** `agency:approve` scope: 'always' persists a per-tool allow rule host-side (never for blast-radius cards). */
export type AgencyApprovalScope = 'once' | 'session' | 'always'
/** Upper bound of push cards kept in memory (oldest dropped). */
const MAX_PENDING_CARDS = 20

/** Test call lifecycle as the settings panel shows it. */
export interface TestCallView {
  status: 'idle' | 'running' | 'done' | 'failed'
  callId: string | null
  result: CallTestResult | null
  error: string | null
}

export const IDLE_TEST_CALL: TestCallView = { status: 'idle', callId: null, result: null, error: null }

/** pt-BR labels of the test-call steps. */
export const CALL_TEST_STEP_LABELS: Record<CallTestResult['steps'][number]['step'], string> = {
  engine: 'Motor',
  session: 'Sessão',
  vad: 'Detecção de fala',
  transcription: 'Transcrição',
  first_audio: 'Primeiro áudio',
  playback: 'Reprodução',
}

/** Plays a WAV (base64) — replaceable in tests (jsdom has no audio output). */
export type WavPlayer = (wavBase64: string) => Promise<void> | void

const defaultWavPlayer: WavPlayer = async (wavBase64) => {
  if (typeof Audio === 'undefined') return
  const audio = new Audio(`data:audio/wav;base64,${wavBase64}`)
  await audio.play()
}

let wavPlayer: WavPlayer = defaultWavPlayer
let voiceAudioDeps: VoiceReferenceAudioDeps = {}

export function setWavPlayerForTesting(player: WavPlayer | null): void {
  wavPlayer = player ?? defaultWavPlayer
}

export function setVoiceAudioDepsForTesting(deps: VoiceReferenceAudioDeps | null): void {
  voiceAudioDeps = deps ?? {}
}

export interface CallStoreState {
  callState: CallStateSnapshot
  viseme: CallVisemeFrame | null
  engineStatus: EngineStatusView | null
  liveSettings: LiveModeSettings | null
  lastError: string | null
  busy: Partial<Record<CallStoreBusyAction, boolean>>
  initialized: boolean
  /** Phase 10.2: reference voices (`liveVoice:list`). */
  voices: VoiceReference[]
  /** Last voice upload/preview/delete message (pt-BR), success or error. */
  voiceMessage: { kind: 'ok' | 'error'; text: string } | null
  testCall: TestCallView
  /** Phase 10.3: push approval cards (`agency:pending`), oldest first, deduped by id. */
  pendingCards: AgencyPendingCardView[]
  /** Card ids with an approve/deny RPC in flight. */
  resolvingCardIds: string[]
  /** Phase 10.3: true while the host is capturing the screen for the call's vision. */
  capturingScreen: boolean
  capturingSource: 'screen' | 'window' | null
  /** Phase 10.4: masked cloud key status per provider (`liveMode:getKeyStatus`); never the key. */
  keyStatus: LiveKeyStatus | null

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

  loadVoices(): Promise<void>
  /** Normalizes the file in the renderer (mono 24 kHz, trimmed, ≤ 30 s) and imports it. */
  importVoiceFile(file: File, name?: string): Promise<VoiceReference | null>
  previewVoice(id: string | null): Promise<void>
  deleteVoice(id: string): Promise<void>
  /** `null` = no reference (default female/male voice). */
  useVoice(id: string | null): Promise<void>
  startTestCall(): Promise<void>
  /** Phase 10.3: `agency:approve` (default scope 'once'). */
  approveCard(cardId: string, scope?: AgencyApprovalScope): Promise<void>
  /** Phase 10.3: `agency:deny`. */
  denyCard(cardId: string): Promise<void>
  /** Phase 10.4: `liveMode:getKeyStatus`. */
  loadKeyStatus(): Promise<void>
  /** Phase 10.4: `liveMode:setApiKey` ('' removes the key); true on success. */
  setApiKey(provider: LiveKeyProvider, apiKey: string): Promise<boolean>
}

let unsubscribeHost: (() => void) | null = null
let subscribedBridge: AshyHostBridge | null = null
/** True while the call store is the one writing the stage lip-sync fields. */
let drivingStage = false
let chatRefreshInFlight = false
let chatRefreshQueued = false
let visionAutoOffTimer: ReturnType<typeof setTimeout> | null = null

function clearVisionTimer(): void {
  if (visionAutoOffTimer !== null) {
    clearTimeout(visionAutoOffTimer)
    visionAutoOffTimer = null
  }
}

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
  voices: [] as VoiceReference[],
  voiceMessage: null as CallStoreState['voiceMessage'],
  testCall: { ...IDLE_TEST_CALL } as TestCallView,
  pendingCards: [] as AgencyPendingCardView[],
  resolvingCardIds: [] as string[],
  capturingScreen: false,
  capturingSource: null as 'screen' | 'window' | null,
  keyStatus: null as LiveKeyStatus | null,
})

/** Keeps only the masked shape of a `LiveKeyStatus` (drops anything else the host might send). */
export function normalizeKeyStatus(value: unknown): LiveKeyStatus | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (!LIVE_KEY_PROVIDERS.some((p) => raw[p] && typeof raw[p] === 'object')) return null
  const out = {} as LiveKeyStatus
  for (const provider of LIVE_KEY_PROVIDERS) {
    const entry = raw[provider] as { hasKey?: unknown; masked?: unknown } | undefined
    out[provider] = {
      hasKey: entry?.hasKey === true,
      masked: typeof entry?.masked === 'string' && entry.masked.length > 0 ? entry.masked.slice(0, 64) : null,
    }
  }
  return out
}

function isPendingCardView(value: unknown): value is AgencyPendingCardView {
  if (!value || typeof value !== 'object') return false
  const c = value as AgencyPendingCardView
  return typeof c.id === 'string' && c.id.length > 0 && typeof c.toolName === 'string'
}

/** Re-reads `consent.toolRiskOverrides` from the host after a "Sempre permitir" (best-effort). */
async function refreshToolRiskOverrides(): Promise<void> {
  try {
    const bridge = getAshyHostBridge()
    if (typeof bridge.getAgencySnapshot !== 'function') return
    const snap = await bridge.getAgencySnapshot()
    const overrides = snap?.consent?.toolRiskOverrides
    if (overrides && typeof overrides === 'object') {
      useAshyStore.setState({ toolRiskOverrides: { ...overrides } })
    }
  } catch {
    // keep the current mirror
  }
}

/** Drops a resolved card from the agency snapshot mirror too (so the overlay bubble clears). */
function dropSnapshotPendingAction(cardId: string): void {
  const app = useAshyStore.getState()
  if (!Array.isArray(app.pendingActions) || !app.pendingActions.some((c) => c.id === cardId)) return
  useAshyStore.setState({ pendingActions: app.pendingActions.filter((c) => c.id !== cardId) })
}

function isAshyEmotion(value: unknown): value is AshyEmotion {
  return typeof value === 'string' && (ASHY_EMOTIONS as readonly string[]).includes(value)
}

/** Applies a `call:stage` signal to the avatar (only called while a call is active). */
function applyStageSignal(signal: { emotion: string; intensity: number; motion?: string }): void {
  const emotion = typeof signal.emotion === 'string' ? signal.emotion.trim().toLowerCase() : ''
  const motion = resolveMotionPreset(signal.motion)
  const patch: Partial<{ stageEmotion: AshyEmotion; emotionIntensity: number; activeMotion: NonNullable<typeof motion> }> = {}
  if (isAshyEmotion(emotion)) {
    patch.stageEmotion = emotion
    const intensity = Number(signal.intensity)
    patch.emotionIntensity = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0.85
  }
  if (motion) patch.activeMotion = motion
  if (Object.keys(patch).length > 0) useAshyStore.setState(patch)
}

function isCallStateSnapshot(value: unknown): value is CallStateSnapshot {
  return !!value && typeof value === 'object' && typeof (value as CallStateSnapshot).status === 'string'
}

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
    let test = get().testCall
    if (test.status === 'running' && test.callId === null && isCallActiveStatus(next.status) && next.callId) {
      // `call:startTest` may answer after the first `call:state` of the test call.
      test = { ...test, callId: next.callId }
      set({ testCall: test })
    }
    if (
      test.status === 'running' &&
      next.status === 'ended' &&
      test.callId !== null &&
      (next.callId === null || next.callId === test.callId)
    ) {
      // The engine reports the result before hanging up; ending without one means the test broke.
      const reason = next.reason && next.reason !== 'user_hangup' ? CALL_END_REASON_MESSAGES[next.reason] : null
      set({
        testCall: {
          ...test,
          status: 'failed',
          error: reason ?? next.detail ?? 'O teste terminou sem resultado.',
        },
      })
    }
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

  const applyVoices = (value: unknown): void => {
    const list = Array.isArray(value)
      ? value
      : value && typeof value === 'object' && Array.isArray((value as { voices?: unknown }).voices)
        ? (value as { voices: unknown[] }).voices
        : null
    if (!list) return
    set({
      voices: list.filter(
        (v): v is VoiceReference =>
          !!v && typeof v === 'object' && typeof (v as VoiceReference).id === 'string',
      ),
    })
  }

  const reloadSettings = async (): Promise<void> => {
    try {
      const settings = await invoke<LiveModeSettings>('liveMode:getSettings')
      if (settings) set({ liveSettings: settings })
    } catch {
      // keep the current snapshot
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
      const [state, engine, settings, voices, keys] = await Promise.allSettled([
        invoke<CallStateSnapshot>('call:getState'),
        invoke<LlamaCppEngineStatus>('engines:getStatus'),
        invoke<LiveModeSettings>('liveMode:getSettings'),
        invoke<VoiceReference[]>('liveVoice:list'),
        invoke<LiveKeyStatus>('liveMode:getKeyStatus'),
      ])
      if (state.status === 'fulfilled') applyCallState(state.value)
      if (engine.status === 'fulfilled') applyEngineStatus(engine.value)
      if (settings.status === 'fulfilled' && settings.value) set({ liveSettings: settings.value })
      if (voices.status === 'fulfilled') applyVoices(voices.value)
      if (keys.status === 'fulfilled') {
        const status = normalizeKeyStatus(keys.value)
        if (status) set({ keyStatus: status })
      }
    },

    dispose() {
      unsubscribeHost?.()
      unsubscribeHost = null
      subscribedBridge = null
      releaseStage()
      clearVisionTimer()
      set({ initialized: false, capturingScreen: false, capturingSource: null })
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
        case 'call:stage': {
          const { callState } = get()
          if (!isCallActiveStatus(callState.status)) return
          if (callState.callId && event.callId !== callState.callId) return
          applyStageSignal(event)
          return
        }
        case 'call:testResult': {
          const result = event.result
          if (!result || typeof result !== 'object' || !Array.isArray(result.steps)) return
          set({ testCall: { status: 'done', callId: result.callId, result: { ...result }, error: null } })
          return
        }
        case 'agency:pending': {
          const card = event.card
          if (!isPendingCardView(card)) return
          set((s) => {
            const rest = s.pendingCards.filter((c) => c.id !== card.id)
            const next = [...rest, { ...card }]
            return { pendingCards: next.slice(Math.max(0, next.length - MAX_PENDING_CARDS)) }
          })
          return
        }
        case 'agency:resolved': {
          if (typeof event.cardId !== 'string') return
          set((s) => ({
            pendingCards: s.pendingCards.filter((c) => c.id !== event.cardId),
            resolvingCardIds: s.resolvingCardIds.filter((id) => id !== event.cardId),
          }))
          dropSnapshotPendingAction(event.cardId)
          return
        }
        case 'vision:capture': {
          clearVisionTimer()
          if (event.active) {
            set({ capturingScreen: true, capturingSource: event.source === 'window' ? 'window' : 'screen' })
            visionAutoOffTimer = setTimeout(() => {
              visionAutoOffTimer = null
              set({ capturingScreen: false, capturingSource: null })
            }, VISION_CAPTURE_AUTO_OFF_MS)
          } else {
            set({ capturingScreen: false, capturingSource: null })
          }
          return
        }
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

    async loadVoices() {
      try {
        applyVoices(await invoke<VoiceReference[]>('liveVoice:list'))
      } catch (err) {
        set({ voiceMessage: { kind: 'error', text: errorMessage(err) } })
      }
    },

    async importVoiceFile(file, name) {
      set({ voiceMessage: null })
      if (!isAcceptedVoiceFile(file.name)) {
        set({
          voiceMessage: { kind: 'error', text: 'Formato não suportado. Use wav, mp3, flac, ogg ou m4a.' },
        })
        return null
      }
      set((s) => ({ busy: { ...s.busy, voiceImport: true } }))
      try {
        const data = await readFileAsArrayBuffer(file)
        const normalized = await normalizeVoiceReference(data, voiceAudioDeps)
        const voiceName = (name ?? '').trim() || voiceNameFromFile(file.name)
        const created = await invoke<VoiceReference>('liveVoice:import', {
          name: voiceName.slice(0, 60),
          wavBase64: normalized.wavBase64,
        })
        await get().loadVoices()
        set({
          voiceMessage: {
            kind: 'ok',
            text: `Voz "${created?.name ?? voiceName}" importada (${(normalized.durationMs / 1000).toFixed(1).replace('.', ',')} s).`,
          },
        })
        return created ?? null
      } catch (err) {
        set({ voiceMessage: { kind: 'error', text: errorMessage(err) } })
        return null
      } finally {
        set((s) => ({ busy: { ...s.busy, voiceImport: false } }))
      }
    },

    async previewVoice(id) {
      set((s) => ({ busy: { ...s.busy, voicePreview: true }, voiceMessage: null }))
      try {
        const res = await invoke<LiveVoicePreviewResult>('liveVoice:preview', { id })
        if (!res || typeof res.wavBase64 !== 'string' || res.wavBase64.length === 0) {
          throw new Error('A prévia não retornou áudio.')
        }
        await wavPlayer(res.wavBase64)
      } catch (err) {
        set({ voiceMessage: { kind: 'error', text: errorMessage(err) } })
      } finally {
        set((s) => ({ busy: { ...s.busy, voicePreview: false } }))
      }
    },

    async deleteVoice(id) {
      set((s) => ({ busy: { ...s.busy, voiceDelete: true }, voiceMessage: null }))
      try {
        await invoke('liveVoice:delete', { id })
        set((s) => ({ voices: s.voices.filter((v) => v.id !== id) }))
        // Deleting the voice in use resets `hybrid.referenceVoiceId` host-side.
        await Promise.all([get().loadVoices(), reloadSettings()])
      } catch (err) {
        set({ voiceMessage: { kind: 'error', text: errorMessage(err) } })
      } finally {
        set((s) => ({ busy: { ...s.busy, voiceDelete: false } }))
      }
    },

    async useVoice(id) {
      await get().saveLiveSettings({ hybrid: { referenceVoiceId: id } })
    },

    async startTestCall() {
      if (get().testCall.status === 'running') return
      set({ testCall: { status: 'running', callId: null, result: null, error: null } })
      const res = await withBusy('testCall', () => invoke<unknown>('call:startTest', {}))
      if (res === null) {
        set((s) => ({
          testCall: { ...s.testCall, status: 'failed', error: s.lastError ?? 'Falha ao iniciar o teste.' },
        }))
        return
      }
      const snapshot = isCallStateSnapshot(res)
        ? res
        : res && typeof res === 'object' && isCallStateSnapshot((res as { state?: unknown }).state)
          ? (res as { state: CallStateSnapshot }).state
          : null
      const callId =
        snapshot?.callId ??
        (res && typeof res === 'object' && typeof (res as { callId?: unknown }).callId === 'string'
          ? (res as { callId: string }).callId
          : null)
      set((s) =>
        s.testCall.status === 'running' ? { testCall: { ...s.testCall, callId } } : {},
      )
      if (snapshot) applyCallState(snapshot)
    },

    async approveCard(cardId, scope) {
      await resolveCard(cardId, 'agency:approve', scope ? { cardId, scope } : { cardId })
    },

    async denyCard(cardId) {
      await resolveCard(cardId, 'agency:deny', { cardId })
    },

    async loadKeyStatus() {
      try {
        const status = normalizeKeyStatus(await invoke<LiveKeyStatus>('liveMode:getKeyStatus'))
        if (status) set({ keyStatus: status })
      } catch {
        // keep the current snapshot (older host without cloud keys)
      }
    },

    async setApiKey(provider, apiKey) {
      const res = await withBusy('apiKey', () =>
        invoke<LiveKeyStatus>('liveMode:setApiKey', { provider, apiKey: apiKey.trim() }),
      )
      if (res === null) return false
      const status = normalizeKeyStatus(res)
      if (status) set({ keyStatus: status })
      else await get().loadKeyStatus()
      return true
    },
  }

  async function resolveCard(
    cardId: string,
    method: 'agency:approve' | 'agency:deny',
    payload: { cardId: string; scope?: AgencyApprovalScope },
  ): Promise<void> {
    if (!cardId || get().resolvingCardIds.includes(cardId)) return
    set((s) => ({ resolvingCardIds: [...s.resolvingCardIds, cardId], lastError: null }))
    try {
      await invoke(method, payload)
      // The host also emits `agency:resolved`; drop the card now so the UI doesn't wait on it.
      set((s) => ({ pendingCards: s.pendingCards.filter((c) => c.id !== cardId) }))
      dropSnapshotPendingAction(cardId)
      // 'always' persisted a per-tool allow rule host-side: mirror it into the consent center.
      if (payload.scope === 'always') void refreshToolRiskOverrides()
    } catch (err) {
      set({ lastError: errorMessage(err) })
    } finally {
      set((s) => ({ resolvingCardIds: s.resolvingCardIds.filter((id) => id !== cardId) }))
    }
  }
})

export function resetCallStoreForTesting(): void {
  unsubscribeHost?.()
  unsubscribeHost = null
  subscribedBridge = null
  drivingStage = false
  chatRefreshInFlight = false
  chatRefreshQueued = false
  clearVisionTimer()
  wavPlayer = defaultWavPlayer
  voiceAudioDeps = {}
  useCallStore.setState(initialCallStoreState())
}
