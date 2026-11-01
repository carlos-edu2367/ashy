/**
 * Phase 10.1 — Live Call UI (spec §9.1–9.3): hub call orb + status strip, overlay call buttons and
 * state dot, and the "Live Mode" settings panel. Everything reads `useCallStore`.
 *
 * Phase 10.3: push approval cards (hub strip + overlay bubble), the "👁 vendo a tela" indicator
 * and Live Mode › "Recursos na chamada" (tools / vision / initiative).
 *
 * Phase 10.4/10.5: cloud realtime backends (OpenAI-compatible / Gemini Live + API keys + "Contexto da
 * Ashy na nuvem") and the classic cascade (STT → text LLM → TTS) panels.
 */
import React, { useEffect, useRef, useState } from 'react'
import {
  CASCADE_TTS_PROVIDER_IDS,
  CLOUD_REALTIME_PRESETS,
  CLOUD_REALTIME_PROVIDERS,
  GEMINI_LIVE_DEFAULTS,
  LIVE_BACKENDS_IMPLEMENTED,
  LIVE_LOCAL_MODELS,
  LLAMACPP_VARIANTS,
  LLM_PROVIDER_IDS,
  USER_SELECTABLE_STT_PROVIDER_IDS,
  type AgencyPendingCardView,
  type CascadeTtsProviderId,
  type CloudRealtimeProvider,
  type LiveBackendId,
  type LiveInputMode,
  type LiveKeyProvider,
  type LiveModeSettings,
  type LlamaCppVariant,
  type SaveLiveModeSettingsInput,
} from '@ashy/shared'
import {
  Check,
  Cloud,
  Cpu,
  KeyRound,
  Workflow,
  FlaskConical,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Play,
  Radio,
  Save,
  Square,
  Trash2,
  Wrench,
  Upload,
  Volume2,
  X,
} from 'lucide-react'
import { VOICE_REF_ACCEPT_ATTR } from '../services/voice-reference-audio'
import {
  CALL_END_REASON_MESSAGES,
  CALL_STATUS_LABELS,
  CALL_TEST_STEP_LABELS,
  LIVE_MODE_DEFAULT_MODEL_ID,
  callRingKind,
  isCallActiveStatus,
  isVcRuntimeMissing,
  useCallStore,
} from '../store/useCallStore'

function useCallView() {
  const callState = useCallStore((s) => s.callState)
  const busy = useCallStore((s) => s.busy.call === true)
  const active = isCallActiveStatus(callState.status)
  return { callState, busy, active, ring: callRingKind(callState.status) }
}

export function callEndedMessage(
  status: string,
  reason: keyof typeof CALL_END_REASON_MESSAGES | null,
): string | null {
  if (status !== 'ended' || !reason || reason === 'user_hangup') return null
  return CALL_END_REASON_MESSAGES[reason] ?? null
}

// ───────────────────────────── Phase 10.3: approvals + vision ─────────────────────────────

export const VOICE_APPROVAL_HINT = 'ou diga “pode”, “pode sempre” ou “não”'
export const VISION_INDICATOR_LABEL = '👁 vendo a tela'

/** One push approval card (`agency:pending`) with Aprovar / Sempre permitir / Negar. */
export function PendingApprovalCard({
  card,
  compact = false,
}: {
  card: AgencyPendingCardView
  compact?: boolean
}): React.ReactElement {
  const callActive = useCallStore((s) => isCallActiveStatus(s.callState.status))
  const resolving = useCallStore((s) => s.resolvingCardIds.includes(card.id))
  const approveCard = useCallStore((s) => s.approveCard)
  const denyCard = useCallStore((s) => s.denyCard)
  return (
    <div
      className={`ashy-approval-card${compact ? ' compact' : ''}`}
      data-testid="push-approval-card"
      data-card-id={card.id}
      role="group"
      aria-label={`Permissão: ${card.summary}`}
    >
      <div className="ashy-approval-card-title">
        <strong>{card.toolName}</strong> — {card.summary}
      </div>
      {card.argsPreview && !compact && (
        <code className="ashy-approval-card-args" data-testid="push-approval-args">
          {card.argsPreview}
        </code>
      )}
      {card.blastRadiusWarning && (
        <div className="ashy-approval-card-warning" data-testid="push-approval-blast-radius" role="alert">
          ⚠️ {card.blastRadiusWarning}
        </div>
      )}
      <div className="ashy-approval-card-actions">
        <button
          type="button"
          className="ashy-peach-btn"
          data-testid="btn-card-approve"
          data-card-id={card.id}
          disabled={resolving}
          onClick={() => void approveCard(card.id, 'once')}
        >
          Aprovar
        </button>
        {!card.blastRadiusWarning && (
          <button
            type="button"
            className="ashy-outline-btn"
            data-testid="btn-card-always"
            data-card-id={card.id}
            disabled={resolving}
            title={`Não perguntar de novo para ${card.toolName}`}
            onClick={() => void approveCard(card.id, 'always')}
          >
            Sempre permitir
          </button>
        )}
        <button
          type="button"
          className="ashy-danger-outline-btn"
          data-testid="btn-card-deny"
          data-card-id={card.id}
          disabled={resolving}
          onClick={() => void denyCard(card.id)}
        >
          Negar
        </button>
        {card.voiceApprovable && !card.blastRadiusWarning && callActive && (
          <span className="ashy-approval-card-hint" data-testid="push-approval-voice-hint">
            {VOICE_APPROVAL_HINT}
          </span>
        )}
      </div>
    </div>
  )
}

/** "👁 vendo a tela" while the host captures the screen (`vision:capture`). */
export function VisionIndicator({ className = '' }: { className?: string }): React.ReactElement | null {
  const capturing = useCallStore((s) => s.capturingScreen)
  const source = useCallStore((s) => s.capturingSource)
  if (!capturing) return null
  return (
    <span
      className={`ashy-vision-indicator ${className}`.trim()}
      data-testid="vision-indicator"
      data-source={source ?? 'screen'}
      role="status"
      title={source === 'window' ? 'A Ashy está vendo a janela em foco' : 'A Ashy está vendo a tela'}
    >
      {VISION_INDICATOR_LABEL}
    </span>
  )
}

/** Hub: push approval cards + vision indicator above the call strip (also outside calls). */
export function HubPendingApprovals(): React.ReactElement | null {
  const cards = useCallStore((s) => s.pendingCards)
  const capturing = useCallStore((s) => s.capturingScreen)
  if (cards.length === 0 && !capturing) return null
  return (
    <div className="ashy-call-approvals" data-ui-island="true" data-testid="hub-call-approvals">
      <VisionIndicator />
      {cards.map((card) => (
        <PendingApprovalCard key={card.id} card={card} />
      ))}
    </div>
  )
}

// ───────────────────────────── Hub ─────────────────────────────

/** The hub dock orb: Ligar/Desligar with a state ring. */
export function HubCallOrb(): React.ReactElement {
  const { callState, busy, active, ring } = useCallView()
  const toggleCall = useCallStore((s) => s.toggleCall)
  const label = active ? `Desligar · ${CALL_STATUS_LABELS[callState.status]}` : 'Ligar'
  return (
    <div className="ashy-dock-action">
      <button
        type="button"
        data-testid="btn-call-toggle"
        data-call-status={callState.status}
        data-call-ring={ring}
        aria-pressed={active}
        disabled={busy && !active}
        className={`ashy-mic-hero-btn ashy-call-orb ashy-call-ring--${ring}`}
        onClick={() => void toggleCall()}
        title={active ? 'Desligar a chamada (Ctrl+Alt+L)' : 'Ligar para a Ashy (Ctrl+Alt+L)'}
      >
        {active ? <PhoneOff size={22} /> : <Phone size={22} />}
      </button>
      <span
        className="ashy-dock-label"
        data-testid="call-status-label"
        style={{ color: 'var(--text-primary)', fontWeight: 500 }}
      >
        {label}
      </span>
    </div>
  )
}

/** Mute + live caption + latency chip during a call; ended-reason message after a failed call. */
export function HubCallStatusStrip(): React.ReactElement | null {
  const { callState, active } = useCallView()
  const toggleMute = useCallStore((s) => s.toggleMute)
  const lastError = useCallStore((s) => s.lastError)
  const endedMessage = callEndedMessage(callState.status, callState.reason)
  if (!active && !endedMessage && !lastError) return null
  const e2e = callState.metrics?.e2eMs
  return (
    <div className="ashy-call-strip" data-ui-island="true" data-testid="call-status-strip">
      {active && (
        <>
          <button
            type="button"
            data-testid="btn-call-mute"
            aria-pressed={callState.muted}
            className={`ashy-dock-circle-btn ${callState.muted ? 'active' : ''}`}
            onClick={() => void toggleMute()}
            title={callState.muted ? 'Reativar microfone' : 'Silenciar microfone na chamada'}
          >
            {callState.muted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          <span className="ashy-call-caption" data-testid="call-caption">
            {callState.caption?.text
              ? `${callState.caption.role === 'user' ? 'Você' : 'Ashy'}: ${callState.caption.text}`
              : CALL_STATUS_LABELS[callState.status]}
          </span>
          <span className="ashy-badge violet" data-testid="call-latency">
            Latência: {typeof e2e === 'number' ? `${Math.round(e2e)} ms` : '—'}
          </span>
        </>
      )}
      {!active && endedMessage && (
        <span className="ashy-call-ended" data-testid="call-ended-message" role="status">
          {endedMessage}
        </span>
      )}
      {!active && !endedMessage && lastError && (
        <span className="ashy-call-ended" data-testid="call-error-message" role="status">
          {lastError}
        </span>
      )}
    </div>
  )
}

// ───────────────────────────── Overlay ─────────────────────────────

export function OverlayCallButtons(): React.ReactElement {
  const { callState, busy, active, ring } = useCallView()
  const toggleCall = useCallStore((s) => s.toggleCall)
  const toggleMute = useCallStore((s) => s.toggleMute)
  return (
    <>
      <button
        type="button"
        className="ashy-outline-btn"
        style={{ padding: '5px 10px', fontSize: '11.5px', flex: 1 }}
        data-testid="btn-call-toggle"
        data-call-status={callState.status}
        data-call-ring={ring}
        disabled={busy && !active}
        onClick={() => void toggleCall()}
      >
        {active ? 'Desligar' : 'Ligar'}
      </button>
      <button
        type="button"
        className="ashy-outline-btn"
        style={{ padding: '5px 10px', fontSize: '11.5px', flex: 1 }}
        data-testid="btn-call-mute"
        disabled={!active}
        aria-pressed={callState.muted}
        onClick={() => void toggleMute()}
      >
        {callState.muted ? 'Mic off' : 'Mic on'}
      </button>
    </>
  )
}

/** State dot: always visible during a call, otherwise follows the hover like the other islands. */
export function OverlayCallStateDot({ hovering }: { hovering: boolean }): React.ReactElement {
  const { callState, active, ring } = useCallView()
  const visible = active || hovering
  return (
    <div
      data-testid="call-state-dot"
      data-ui-island="true"
      data-call-status={callState.status}
      data-visible={visible ? 'true' : 'false'}
      title={CALL_STATUS_LABELS[callState.status]}
      className={`ashy-call-dot ashy-call-ring--${ring}`}
      style={{ opacity: visible ? 1 : 0 }}
    />
  )
}

// ───────────────────────────── Settings › Live Mode ─────────────────────────────

const BACKEND_CARDS: ReadonlyArray<{
  id: LiveBackendId
  label: string
  desc: string
  enabled: boolean
  testId: string
}> = [
  {
    id: 'llamacpp-realtime',
    label: 'Local omni (LFM3 via llama.cpp)',
    desc: 'Tudo no seu PC: voz entra e sai do modelo local.',
    enabled: true,
    testId: 'live-backend-card-llamacpp-realtime',
  },
  {
    id: 'llamacpp-hybrid',
    label: 'Local omni + minha voz (híbrido)',
    desc: 'O modelo local pensa em texto e o /tts do llama.cpp fala — com a sua voz de referência.',
    enabled: true,
    testId: 'live-backend-hybrid',
  },
  {
    id: 'openai-realtime',
    label: 'OpenAI Realtime / compatível',
    desc: 'Fala→fala na nuvem; requer chave; o áudio vai para o provedor.',
    enabled: true,
    testId: 'live-backend-openai-realtime',
  },
  {
    id: 'gemini-live',
    label: 'Gemini Live',
    desc: 'Fala→fala na nuvem; requer chave; o áudio vai para o provedor.',
    enabled: true,
    testId: 'live-backend-gemini-live',
  },
  {
    id: 'cascade',
    label: 'Pipeline clássica (STT → modelo de texto → voz)',
    desc: 'Usa qualquer modelo de texto (local ou nuvem) com memória e ferramentas da Ashy.',
    enabled: true,
    testId: 'live-backend-cascade',
  },
]

export function isLlamaCppBackend(backend: LiveBackendId): boolean {
  return backend === 'llamacpp-realtime' || backend === 'llamacpp-hybrid'
}

export function isCloudLiveBackend(backend: LiveBackendId): boolean {
  return backend === 'openai-realtime' || backend === 'gemini-live'
}

/** True when the backend needs the local llama.cpp engine (cascade only with the llama.cpp voice). */
export function backendNeedsLocalEngine(backend: LiveBackendId, cascadeTts: CascadeTtsProviderId): boolean {
  return isLlamaCppBackend(backend) || (backend === 'cascade' && cascadeTts === 'llamacpp-tts')
}

const VARIANT_LABELS: Record<LlamaCppVariant, string> = {
  'cuda-12.4': 'CUDA 12.4 (NVIDIA)',
  vulkan: 'Vulkan (AMD/Intel)',
  cpu: 'CPU',
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

const fieldLabel: React.CSSProperties = {
  display: 'block',
  fontSize: '12px',
  color: 'var(--text-secondary)',
  marginBottom: '4px',
}

export function LiveModeSettingsPanel(): React.ReactElement {
  const engineStatus = useCallStore((s) => s.engineStatus)
  const liveSettings = useCallStore((s) => s.liveSettings)
  const busy = useCallStore((s) => s.busy)
  const lastError = useCallStore((s) => s.lastError)
  const installEngine = useCallStore((s) => s.installEngine)
  const downloadModel = useCallStore((s) => s.downloadModel)
  const startEngine = useCallStore((s) => s.startEngine)
  const stopEngine = useCallStore((s) => s.stopEngine)
  const saveLiveSettings = useCallStore((s) => s.saveLiveSettings)
  const installVcRuntime = useCallStore((s) => s.installVcRuntime)

  const [variantOverride, setVariantOverride] = useState<LlamaCppVariant | ''>('')
  const [voice, setVoice] = useState<'female' | 'male'>('female')
  const [inputMode, setInputMode] = useState<LiveInputMode>('transcribed')
  const [endpointMode, setEndpointMode] = useState<'managed' | 'url'>('managed')
  const [endpointUrl, setEndpointUrl] = useState('')
  const [vadThreshold, setVadThreshold] = useState(0.5)
  const [endpointMs, setEndpointMs] = useState(700)
  const [rotateAfterTurns, setRotateAfterTurns] = useState(6)
  const [inputDeviceId, setInputDeviceId] = useState('')
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([])
  const [savedNotice, setSavedNotice] = useState<string | null>(null)
  const [cloudDraft, setCloudDraft] = useState<CloudRealtimeDraft>(() => cloudDraftFrom(null))
  const [geminiDraft, setGeminiDraft] = useState<GeminiDraft>(() => geminiDraftFrom(null))
  const [contextDraft, setContextDraft] = useState<CloudContextDraft>(() => cloudContextDraftFrom(null))
  const [cascadeDraft, setCascadeDraft] = useState<CascadeDraft>(() => cascadeDraftFrom(null))

  useEffect(() => {
    void useCallStore.getState().init()
  }, [])

  useEffect(() => {
    if (!liveSettings) return
    setVoice(liveSettings.llamacpp.voice)
    setInputMode(liveSettings.llamacpp.inputMode)
    if (liveSettings.llamacpp.endpoint === 'managed') {
      setEndpointMode('managed')
    } else {
      setEndpointMode('url')
      setEndpointUrl(liveSettings.llamacpp.endpoint.url)
    }
    setVadThreshold(liveSettings.turn.vadThreshold)
    setEndpointMs(liveSettings.turn.endpointMs)
    if (typeof liveSettings.session?.rotateAfterTurns === 'number') {
      setRotateAfterTurns(liveSettings.session.rotateAfterTurns)
    }
    setInputDeviceId(liveSettings.devices.inputDeviceId ?? '')
    setCloudDraft(cloudDraftFrom(liveSettings))
    setGeminiDraft(geminiDraftFrom(liveSettings))
    setContextDraft(cloudContextDraftFrom(liveSettings))
    setCascadeDraft(cascadeDraftFrom(liveSettings))
  }, [liveSettings])

  useEffect(() => {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (!md || typeof md.enumerateDevices !== 'function') return
    let cancelled = false
    void md
      .enumerateDevices()
      .then((list) => {
        if (cancelled) return
        setDevices(
          list
            .filter((d) => d.kind === 'audioinput')
            .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microfone ${i + 1}` })),
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const modelId = liveSettings?.llamacpp.modelId ?? LIVE_MODE_DEFAULT_MODEL_ID
  const modelSpec = LIVE_LOCAL_MODELS.find((m) => m.id === modelId) ?? LIVE_LOCAL_MODELS[0]
  const modelInstalled = engineStatus?.installedModelIds.includes(modelId) ?? false
  const gpu = engineStatus?.detectedGpu ?? null
  const recommended = gpu?.recommendedVariant ?? null
  const download = engineStatus?.activeDownload ?? null
  const selectedBackend = liveSettings?.backend ?? 'llamacpp-realtime'
  const vcMissing = isVcRuntimeMissing(engineStatus, lastError)
  const vcInstall = engineStatus?.vcRuntimeInstall ?? null
  const vcRebootRequired = vcInstall?.rebootRequired === true
  const llamaBackend = isLlamaCppBackend(selectedBackend)
  const showEngine = backendNeedsLocalEngine(selectedBackend, cascadeDraft.ttsProviderId)

  const handleSave = async () => {
    const trimmedUrl = endpointUrl.trim()
    if (showEngine && endpointMode === 'url' && !trimmedUrl) {
      setSavedNotice('Informe a URL do servidor (ex.: http://127.0.0.1:8080).')
      return
    }
    const endpoint = endpointMode === 'managed' ? ('managed' as const) : { url: trimmedUrl }
    const partial: SaveLiveModeSettingsInput = {
      backend: LIVE_BACKENDS_IMPLEMENTED.includes(selectedBackend) ? selectedBackend : 'llamacpp-realtime',
      turn: { vadThreshold, endpointMs },
      devices: { inputDeviceId },
    }
    if (llamaBackend) {
      partial.llamacpp = { voice, inputMode, endpoint }
      partial.session = { rotateAfterTurns: Math.min(50, Math.max(2, Math.round(rotateAfterTurns))) }
    } else if (showEngine) {
      // Cascade with the llama.cpp voice: only the engine endpoint matters.
      partial.llamacpp = { endpoint }
    }
    if (selectedBackend === 'openai-realtime') {
      const url = cloudDraft.url.trim()
      if (url && !CLOUD_URL_PATTERN.test(url)) {
        setSavedNotice(CLOUD_URL_ERROR)
        return
      }
      partial.realtimeCloud = {
        provider: cloudDraft.provider,
        url,
        model: cloudDraft.model.trim(),
        voice: cloudDraft.voice.trim(),
      }
      partial.cloudContext = clampCloudContext(contextDraft)
    } else if (selectedBackend === 'gemini-live') {
      partial.gemini = { model: geminiDraft.model.trim(), voice: geminiDraft.voice.trim() }
      partial.cloudContext = clampCloudContext(contextDraft)
    } else if (selectedBackend === 'cascade') {
      partial.cascade = {
        sttProviderId: cascadeDraft.sttProviderId,
        llmProviderId: cascadeDraft.llmProviderId,
        llmModelId: cascadeDraft.llmModelId.trim(),
        ttsProviderId: cascadeDraft.ttsProviderId,
        ttsVoice: cascadeDraft.ttsVoice.trim(),
        referenceVoiceId:
          cascadeDraft.ttsProviderId === 'llamacpp-tts' ? cascadeDraft.referenceVoiceId : null,
      }
    }
    const saved = await saveLiveSettings(partial)
    setSavedNotice(saved ? 'Configurações do Live Mode salvas.' : null)
  }

  return (
    <section className="ashy-settings-card" data-testid="live-mode-panel">
      <div className="ashy-settings-section-head">
        <div className="ashy-settings-section-icon">
          <Radio size={20} />
        </div>
        <div>
          <h3 className="ashy-setting-title">Live Mode — chamada de voz</h3>
          <p className="ashy-setting-desc">
            Ligue para a Ashy e converse em tempo real. Atalho global: Ctrl+Alt+L.
          </p>
        </div>
      </div>

      {/* Backend cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '8px',
          marginTop: '12px',
        }}
      >
        {BACKEND_CARDS.map((card) => (
          <button
            key={card.id}
            type="button"
            data-testid={card.testId}
            disabled={!card.enabled}
            aria-pressed={card.enabled && selectedBackend === card.id}
            className={`ashy-call-backend-card ${card.enabled && selectedBackend === card.id ? 'active' : ''}`}
            onClick={() => {
              if (card.enabled) void saveLiveSettings({ backend: card.id })
            }}
          >
            <strong style={{ fontSize: '12.5px' }}>{card.label}</strong>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{card.desc}</span>
            {!card.enabled && <span className="ashy-badge amber">em breve</span>}
          </button>
        ))}
      </div>

      {selectedBackend === 'openai-realtime' && (
        <CloudRealtimePanel draft={cloudDraft} onChange={setCloudDraft} />
      )}
      {selectedBackend === 'gemini-live' && <GeminiLivePanel draft={geminiDraft} onChange={setGeminiDraft} />}
      {isCloudLiveBackend(selectedBackend) && (
        <CloudContextPanel draft={contextDraft} onChange={setContextDraft} />
      )}
      {selectedBackend === 'cascade' && <CascadePanel draft={cascadeDraft} onChange={setCascadeDraft} />}

      {/* Engine panel */}
      {showEngine && (
      <div className="ashy-call-engine-panel" data-testid="live-engine-panel">
        {selectedBackend === 'cascade' && (
          <p className="ashy-live-hint" data-testid="live-engine-cascade-hint">
            A voz local do llama.cpp (LFM3) usa este motor: instale-o e inicie-o para a pipeline
            clássica falar.
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <Cpu size={16} />
          <strong style={{ fontSize: '13px' }}>Motor local (llama.cpp)</strong>
          <span className="ashy-badge violet" data-testid="live-engine-build">
            Build {engineStatus?.build ?? '—'}
          </span>
          <span
            className={`ashy-badge ${engineStatus?.running ? 'emerald' : engineStatus?.installed ? 'amber' : 'red'}`}
            data-testid="live-engine-state"
          >
            {engineStatus?.running
              ? `Rodando${engineStatus.port ? ` na porta ${engineStatus.port}` : ''}`
              : engineStatus?.installed
                ? 'Instalado (parado)'
                : 'Não instalado'}
          </span>
        </div>

        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }} data-testid="live-engine-gpu">
          GPU detectada:{' '}
          {gpu
            ? gpu.vendor === 'none'
              ? 'nenhuma (usando CPU)'
              : `${gpu.name ?? gpu.vendor}${gpu.vramMb ? ` · ${Math.round(gpu.vramMb / 1024)} GB` : ''}`
            : 'detectando…'}
          {recommended ? ` · recomendado: ${VARIANT_LABELS[recommended]}` : ''}
          {engineStatus?.installedVariant
            ? ` · instalado: ${VARIANT_LABELS[engineStatus.installedVariant]}`
            : ''}
          {engineStatus?.port ? ` · porta ${engineStatus.port}` : ''}
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label htmlFor="select-live-engine-variant" style={fieldLabel}>
              Variante do motor:
            </label>
            <select
              id="select-live-engine-variant"
              data-testid="select-live-engine-variant"
              className="ashy-select"
              value={variantOverride}
              onChange={(e) => setVariantOverride(e.target.value as LlamaCppVariant | '')}
            >
              <option value="">
                Automática{recommended ? ` (${VARIANT_LABELS[recommended]})` : ''}
              </option>
              {LLAMACPP_VARIANTS.map((v) => (
                <option key={v} value={v}>
                  {VARIANT_LABELS[v]}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="ashy-peach-btn"
            data-testid="btn-live-install-engine"
            disabled={busy.install === true || endpointMode === 'url'}
            onClick={() => void installEngine(variantOverride || undefined)}
          >
            {engineStatus?.installed ? 'Reinstalar motor' : 'Instalar motor'}
          </button>
          <button
            type="button"
            className="ashy-outline-btn"
            data-testid="btn-live-download-model"
            disabled={busy.downloadModel === true || endpointMode === 'url'}
            onClick={() => void downloadModel(modelId)}
            title="Reaproveita o modelo do Ollama se já existir"
          >
            {modelInstalled ? 'Modelo instalado' : 'Baixar modelo'}
          </button>
          <button
            type="button"
            className="ashy-outline-btn"
            data-testid="btn-live-engine-start"
            disabled={busy.startEngine === true || engineStatus?.running === true || vcMissing}
            onClick={() => void startEngine(modelId)}
          >
            <Play size={13} /> Iniciar
          </button>
          <button
            type="button"
            className="ashy-outline-btn"
            data-testid="btn-live-engine-stop"
            disabled={busy.stopEngine === true || engineStatus?.running !== true}
            onClick={() => void stopEngine()}
          >
            <Square size={13} /> Parar
          </button>
        </div>
        <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: 0 }}>
          Modelo: {modelSpec?.label ?? modelId}. O download reaproveita o modelo do Ollama se já
          existir (o mmproj Q8_0 vem do Hugging Face).
        </p>

        {(vcMissing || vcInstall) && (
          <div data-testid="live-vc-runtime-notice" className="ashy-call-progress" role="status">
            {vcMissing && (
              <>
                <div style={{ fontSize: '12px', color: '#f2be79' }}>
                  Falta um componente da Microsoft (Visual C++ Runtime) para rodar o motor local.
                </div>
                <div>
                  <button
                    type="button"
                    className="ashy-peach-btn"
                    data-testid="btn-install-vc-runtime"
                    disabled={
                      busy.installVcRuntime === true ||
                      (vcInstall !== null &&
                        vcInstall.status !== 'error' &&
                        vcInstall.status !== 'completed')
                    }
                    onClick={() => void installVcRuntime()}
                  >
                    Instalar componente da Microsoft
                  </button>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  Baixado do site oficial da Microsoft; o Windows vai pedir permissão de
                  administrador uma vez.
                </div>
              </>
            )}
            {vcInstall && (
              <div style={{ fontSize: '11.5px' }} data-testid="live-vc-runtime-status">
                {vcInstall.status === 'downloading'
                  ? 'Baixando componente da Microsoft'
                  : vcInstall.status === 'verifying'
                    ? 'Verificando componente da Microsoft'
                    : vcInstall.status === 'installing'
                      ? 'Instalando componente da Microsoft (aceite a permissão do Windows)'
                      : vcInstall.status === 'completed'
                        ? 'Componente da Microsoft instalado'
                        : `Erro ao instalar o componente${vcInstall.error ? `: ${vcInstall.error}` : ''}`}
                {typeof vcInstall.percent === 'number' && vcInstall.status !== 'completed'
                  ? ` — ${Math.round(vcInstall.percent)}%`
                  : ''}
              </div>
            )}
            {vcRebootRequired && (
              <div
                style={{ fontSize: '12px', color: '#f2be79', fontWeight: 600 }}
                data-testid="live-vc-runtime-reboot"
              >
                Reinicie o computador para concluir
              </div>
            )}
          </div>
        )}

        {download && (
          <div data-testid="live-engine-progress" className="ashy-call-progress">
            <div style={{ fontSize: '11.5px' }}>
              {download.status === 'verifying'
                ? 'Verificando'
                : download.status === 'extracting'
                  ? 'Extraindo'
                  : download.status === 'completed'
                    ? 'Concluído'
                    : download.status === 'error'
                      ? 'Erro'
                      : 'Baixando'}{' '}
              {download.fileName} — {Math.round(download.percent)}% (
              {formatMb(download.completedBytes)} / {formatMb(download.totalBytes)})
            </div>
            <div className="ashy-call-progress-bar">
              <span style={{ width: `${Math.max(0, Math.min(100, download.percent))}%` }} />
            </div>
            {download.error && (
              <div style={{ fontSize: '11px', color: 'var(--status-danger)' }}>{download.error}</div>
            )}
          </div>
        )}

        {(engineStatus?.lastError || lastError) && (
          <div
            data-testid="live-engine-error"
            style={{ fontSize: '11.5px', color: 'var(--status-danger)' }}
          >
            Último erro: {engineStatus?.lastError ?? lastError}
          </div>
        )}

        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' }}>
            <input
              type="radio"
              name="live-endpoint-mode"
              data-testid="radio-live-endpoint-managed"
              checked={endpointMode === 'managed'}
              onChange={() => setEndpointMode('managed')}
            />
            Gerenciado pela Ashy
          </label>
          <label style={{ fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' }}>
            <input
              type="radio"
              name="live-endpoint-mode"
              data-testid="radio-live-endpoint-url"
              checked={endpointMode === 'url'}
              onChange={() => setEndpointMode('url')}
            />
            Servidor próprio (URL)
          </label>
          {endpointMode === 'url' && (
            <input
              type="url"
              className="ashy-input"
              data-testid="input-live-endpoint-url"
              placeholder="http://127.0.0.1:8080"
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              style={{ minWidth: '220px' }}
            />
          )}
        </div>
      </div>
      )}

      {/* Voice, input mode, turns */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '12px',
          marginTop: '12px',
        }}
      >
        {llamaBackend && (
        <div>
          <label htmlFor="select-live-voice" style={fieldLabel}>
            Voz:
          </label>
          <select
            id="select-live-voice"
            data-testid="select-live-voice"
            className="ashy-select"
            value={voice}
            onChange={(e) => setVoice(e.target.value as 'female' | 'male')}
          >
            <option value="female">Feminina</option>
            <option value="male">Masculina</option>
          </select>
        </div>
        )}
        {llamaBackend && (
        <div>
          <label htmlFor="select-live-input-mode" style={fieldLabel}>
            Modo de entrada:
          </label>
          <select
            id="select-live-input-mode"
            data-testid="select-live-input-mode"
            className="ashy-select"
            value={inputMode}
            onChange={(e) => setInputMode(e.target.value as LiveInputMode)}
          >
            <option value="transcribed">Transcrito (recomendado)</option>
            <option value="audio-direct">Áudio direto (experimental)</option>
          </select>
        </div>
        )}
        <div>
          <label htmlFor="input-live-vad-threshold" style={fieldLabel}>
            Sensibilidade do VAD (limiar): {vadThreshold.toFixed(2)}
          </label>
          <input
            id="input-live-vad-threshold"
            data-testid="input-live-vad-threshold"
            type="range"
            min={0.05}
            max={0.95}
            step={0.05}
            value={vadThreshold}
            onChange={(e) => setVadThreshold(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>
        <div>
          <label htmlFor="input-live-endpoint-ms" style={fieldLabel}>
            Fim de fala (ms de silêncio):
          </label>
          <input
            id="input-live-endpoint-ms"
            data-testid="input-live-endpoint-ms"
            type="number"
            className="ashy-input"
            min={200}
            max={4000}
            step={50}
            value={endpointMs}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) setEndpointMs(n)
            }}
          />
        </div>
        <div>
          <label htmlFor="select-live-input-device" style={fieldLabel}>
            Microfone da chamada:
          </label>
          <select
            id="select-live-input-device"
            data-testid="select-live-input-device"
            className="ashy-select"
            value={inputDeviceId}
            onChange={(e) => setInputDeviceId(e.target.value)}
          >
            <option value="">Padrão do sistema</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        {llamaBackend && (
        <div>
          <label htmlFor="input-live-rotate-turns" style={fieldLabel}>
            Rotação de sessão (turnos):
          </label>
          <input
            id="input-live-rotate-turns"
            data-testid="input-live-rotate-turns"
            type="number"
            className="ashy-input"
            min={2}
            max={50}
            step={1}
            value={rotateAfterTurns}
            title="Abre uma sessão nova (com um resumo da conversa) a cada N turnos — evita que o modelo se repita."
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) setRotateAfterTurns(n)
            }}
          />
        </div>
        )}
      </div>

      <CallFeaturesSection />

      {selectedBackend === 'llamacpp-hybrid' && <VoiceReferenceSection />}

      <TestCallSection />

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' }}>
        <button
          type="button"
          className="ashy-peach-btn"
          data-testid="btn-live-save-settings"
          disabled={busy.saveSettings === true}
          onClick={() => void handleSave()}
        >
          <Save size={14} /> Salvar Live Mode
        </button>
        {savedNotice && (
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }} data-testid="live-save-notice">
            {savedNotice}
          </span>
        )}
      </div>
    </section>
  )
}

// ───────────────────────────── Phase 10.4: cloud realtime ─────────────────────────────

/** Same rule as `SaveLiveModeSettingsInputSchema.realtimeCloud.url` (wss://, or a local ws:// server). */
export const CLOUD_URL_PATTERN = /^(wss:\/\/[^\s]+|ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[^\s]*)?)$/
const CLOUD_URL_ERROR =
  'A URL precisa começar com wss:// (ou ws://127.0.0.1 / ws://localhost para um servidor local).'

/** Host defaults when `settings.cloudContext` is absent (see live-call-protocol.ts). */
export const CLOUD_CONTEXT_DEFAULTS = {
  includePersona: true,
  recentMessages: 12,
  memoryTopK: 4,
  maxInstructionsChars: 16000,
} as const

type CloudRealtimeDraft = LiveModeSettings['realtimeCloud']
type GeminiDraft = LiveModeSettings['gemini']
type CloudContextDraft = {
  includePersona: boolean
  recentMessages: number
  memoryTopK: number
  maxInstructionsChars: number
}
type CascadeDraft = LiveModeSettings['cascade']

const DEFAULT_CASCADE_DRAFT: CascadeDraft = {
  sttProviderId: 'ollama-transcriptions',
  llmProviderId: 'chat-default',
  llmModelId: '',
  ttsProviderId: 'llamacpp-tts',
  ttsVoice: 'female',
  referenceVoiceId: null,
}

function cloudDraftFrom(settings: LiveModeSettings | null): CloudRealtimeDraft {
  const rc = settings?.realtimeCloud
  const provider: CloudRealtimeProvider =
    rc && (CLOUD_REALTIME_PROVIDERS as readonly string[]).includes(rc.provider) ? rc.provider : 'openai'
  return { provider, url: rc?.url ?? '', model: rc?.model ?? '', voice: rc?.voice ?? '' }
}

function geminiDraftFrom(settings: LiveModeSettings | null): GeminiDraft {
  return { model: settings?.gemini?.model ?? '', voice: settings?.gemini?.voice ?? '' }
}

function cloudContextDraftFrom(settings: LiveModeSettings | null): CloudContextDraft {
  const c = settings?.cloudContext ?? {}
  return {
    includePersona: typeof c.includePersona === 'boolean' ? c.includePersona : CLOUD_CONTEXT_DEFAULTS.includePersona,
    recentMessages: typeof c.recentMessages === 'number' ? c.recentMessages : CLOUD_CONTEXT_DEFAULTS.recentMessages,
    memoryTopK: typeof c.memoryTopK === 'number' ? c.memoryTopK : CLOUD_CONTEXT_DEFAULTS.memoryTopK,
    maxInstructionsChars:
      typeof c.maxInstructionsChars === 'number' ? c.maxInstructionsChars : CLOUD_CONTEXT_DEFAULTS.maxInstructionsChars,
  }
}

function cascadeDraftFrom(settings: LiveModeSettings | null): CascadeDraft {
  return { ...DEFAULT_CASCADE_DRAFT, ...(settings?.cascade ?? {}) }
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function clampCloudContext(draft: CloudContextDraft): Required<NonNullable<LiveModeSettings['cloudContext']>> {
  return {
    includePersona: draft.includePersona,
    recentMessages: clampInt(draft.recentMessages, 0, 60, CLOUD_CONTEXT_DEFAULTS.recentMessages),
    memoryTopK: clampInt(draft.memoryTopK, 0, 12, CLOUD_CONTEXT_DEFAULTS.memoryTopK),
    maxInstructionsChars: clampInt(draft.maxInstructionsChars, 2000, 60000, CLOUD_CONTEXT_DEFAULTS.maxInstructionsChars),
  }
}

/** API key for one cloud provider: write-only input; only the host's masked status is displayed. */
export function CloudKeyField(props: {
  provider: LiveKeyProvider
  label: string
  optional?: boolean
}): React.ReactElement {
  const { provider, label, optional } = props
  const status = useCallStore((s) => s.keyStatus?.[provider] ?? null)
  const busy = useCallStore((s) => s.busy.apiKey === true)
  const setApiKey = useCallStore((s) => s.setApiKey)
  const [value, setValue] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const inputId = `cloud-key-input-${provider}`

  const save = async () => {
    const key = value.trim()
    if (!key) return
    const ok = await setApiKey(provider, key)
    if (ok) setValue('')
    setMessage(ok ? 'Chave salva.' : 'Não foi possível salvar a chave.')
  }
  const remove = async () => {
    const ok = await setApiKey(provider, '')
    setMessage(ok ? 'Chave removida.' : 'Não foi possível remover a chave.')
  }

  return (
    <div className="ashy-live-key" data-testid={`cloud-key-${provider}`}>
      <label htmlFor={inputId} style={fieldLabel}>
        <KeyRound size={12} style={{ verticalAlign: '-2px' }} /> Chave de API — {label}
        {optional ? ' (opcional)' : ''}:
      </label>
      <div className="ashy-live-key-row">
        <input
          id={inputId}
          type="password"
          className="ashy-input"
          data-testid={inputId}
          autoComplete="off"
          spellCheck={false}
          placeholder={status?.hasKey ? 'Cole uma nova chave para trocar' : 'Cole a chave aqui'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
        <button
          type="button"
          className="ashy-peach-btn"
          data-testid={`btn-cloud-key-save-${provider}`}
          disabled={busy || value.trim().length === 0}
          onClick={() => void save()}
        >
          Salvar chave
        </button>
        {status?.hasKey && (
          <button
            type="button"
            className="ashy-outline-btn"
            data-testid={`btn-cloud-key-remove-${provider}`}
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash2 size={12} /> Remover
          </button>
        )}
      </div>
      <div className="ashy-live-hint" data-testid={`cloud-key-status-${provider}`} role="status">
        {status?.hasKey
          ? `Chave salva: ${status.masked ?? '••••'}`
          : optional
            ? 'Nenhuma chave salva (opcional para servidor próprio).'
            : 'Nenhuma chave salva.'}
        {message ? ` · ${message}` : ''}
      </div>
    </div>
  )
}

/** OpenAI-Realtime-compatible provider (OpenAI / Qwen-Omni / custom URL) + its API key. */
export function CloudRealtimePanel(props: {
  draft: CloudRealtimeDraft
  onChange: (next: CloudRealtimeDraft) => void
}): React.ReactElement {
  const { draft, onChange } = props
  const preset = CLOUD_REALTIME_PRESETS[draft.provider] ?? CLOUD_REALTIME_PRESETS.openai
  const urlInvalid = draft.url.trim().length > 0 && !CLOUD_URL_PATTERN.test(draft.url.trim())

  const changeProvider = (provider: CloudRealtimeProvider) => {
    const prev = CLOUD_REALTIME_PRESETS[draft.provider]
    // A field still holding the previous provider's preset would be wrong for the new one: clear it.
    const keep = (value: string, presetValue: string | undefined) => (value === presetValue ? '' : value)
    onChange({
      provider,
      url: keep(draft.url, prev?.url),
      model: keep(draft.model, prev?.model),
      voice: keep(draft.voice, prev?.voice),
    })
  }

  return (
    <div className="ashy-call-engine-panel" data-testid="cloud-realtime-panel">
      <div className="ashy-live-panel-head">
        <Cloud size={16} />
        <strong style={{ fontSize: '13px' }}>Provedor realtime (compatível com OpenAI)</strong>
      </div>
      <div className="ashy-live-grid">
        <div>
          <label htmlFor="cloud-provider-select" style={fieldLabel}>
            Provedor:
          </label>
          <select
            id="cloud-provider-select"
            data-testid="cloud-provider-select"
            className="ashy-select"
            value={draft.provider}
            onChange={(e) => changeProvider(e.target.value as CloudRealtimeProvider)}
          >
            {CLOUD_REALTIME_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {CLOUD_REALTIME_PRESETS[p].label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="cloud-model-input" style={fieldLabel}>
            Modelo:
          </label>
          <input
            id="cloud-model-input"
            data-testid="cloud-model-input"
            className="ashy-input"
            placeholder={preset.model || 'nome do modelo'}
            value={draft.model}
            onChange={(e) => onChange({ ...draft, model: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="cloud-voice-input" style={fieldLabel}>
            Voz:
          </label>
          <input
            id="cloud-voice-input"
            data-testid="cloud-voice-input"
            className="ashy-input"
            placeholder={preset.voice || 'voz do provedor'}
            value={draft.voice}
            onChange={(e) => onChange({ ...draft, voice: e.target.value })}
          />
        </div>
      </div>
      <div>
        <label htmlFor="cloud-url-input" style={fieldLabel}>
          URL do WebSocket:
        </label>
        <input
          id="cloud-url-input"
          data-testid="cloud-url-input"
          className="ashy-input"
          style={{ width: '100%' }}
          placeholder={preset.url || 'wss://… ou ws://127.0.0.1:porta/…'}
          value={draft.url}
          aria-invalid={urlInvalid}
          onChange={(e) => onChange({ ...draft, url: e.target.value })}
        />
        <div
          className="ashy-live-hint"
          data-testid="cloud-url-hint"
          style={urlInvalid ? { color: 'var(--status-danger)' } : undefined}
        >
          {urlInvalid
            ? CLOUD_URL_ERROR
            : 'Vazio = padrão do provedor. Aceita wss://… ou um servidor local ws://127.0.0.1 / ws://localhost.'}
        </div>
      </div>
      <CloudKeyField
        provider={draft.provider}
        label={CLOUD_REALTIME_PRESETS[draft.provider]?.label ?? draft.provider}
        optional={draft.provider === 'custom'}
      />
    </div>
  )
}

/** Google Gemini Live (native audio): model / voice + API key. */
export function GeminiLivePanel(props: {
  draft: GeminiDraft
  onChange: (next: GeminiDraft) => void
}): React.ReactElement {
  const { draft, onChange } = props
  return (
    <div className="ashy-call-engine-panel" data-testid="gemini-live-panel">
      <div className="ashy-live-panel-head">
        <Cloud size={16} />
        <strong style={{ fontSize: '13px' }}>Gemini Live</strong>
      </div>
      <div className="ashy-live-grid">
        <div>
          <label htmlFor="gemini-model-input" style={fieldLabel}>
            Modelo:
          </label>
          <input
            id="gemini-model-input"
            data-testid="gemini-model-input"
            className="ashy-input"
            placeholder={GEMINI_LIVE_DEFAULTS.model}
            value={draft.model}
            onChange={(e) => onChange({ ...draft, model: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="gemini-voice-input" style={fieldLabel}>
            Voz:
          </label>
          <input
            id="gemini-voice-input"
            data-testid="gemini-voice-input"
            className="ashy-input"
            placeholder={GEMINI_LIVE_DEFAULTS.voice}
            value={draft.voice}
            onChange={(e) => onChange({ ...draft, voice: e.target.value })}
          />
        </div>
      </div>
      <CloudKeyField provider="gemini" label="Google AI Studio (Gemini)" />
    </div>
  )
}

/** "Contexto da Ashy na nuvem": how much persona / history / memory goes into a cloud session. */
export function CloudContextPanel(props: {
  draft: CloudContextDraft
  onChange: (next: CloudContextDraft) => void
}): React.ReactElement {
  const { draft, onChange } = props
  const numberField = (
    key: 'recentMessages' | 'memoryTopK' | 'maxInstructionsChars',
    testId: string,
    label: string,
    min: number,
    max: number,
    step: number,
  ) => (
    <div>
      <label htmlFor={testId} style={fieldLabel}>
        {label} ({min}–{max}):
      </label>
      <input
        id={testId}
        data-testid={testId}
        type="number"
        className="ashy-input"
        min={min}
        max={max}
        step={step}
        value={draft[key]}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange({ ...draft, [key]: n })
        }}
      />
    </div>
  )
  return (
    <div className="ashy-call-engine-panel" data-testid="cloud-context-panel">
      <div className="ashy-live-panel-head">
        <Cloud size={16} />
        <strong style={{ fontSize: '13px' }}>Contexto da Ashy na nuvem</strong>
      </div>
      <p className="ashy-live-hint" style={{ margin: 0 }}>
        O que vai para o provedor junto com o áudio. Modelos grandes aguentam mais contexto.
      </p>
      <label className="ashy-call-feature-row">
        <input
          type="checkbox"
          data-testid="cloud-context-persona"
          checked={draft.includePersona}
          onChange={(e) => onChange({ ...draft, includePersona: e.target.checked })}
        />
        <span>
          <span style={{ fontWeight: 500 }}>Personalidade completa</span>
          <span className="ashy-call-feature-desc"> — envia a persona da Ashy nas instruções.</span>
        </span>
      </label>
      <div className="ashy-live-grid">
        {numberField('recentMessages', 'cloud-context-recent', 'Mensagens recentes', 0, 60, 1)}
        {numberField('memoryTopK', 'cloud-context-memory', 'Memórias por turno', 0, 12, 1)}
        {numberField(
          'maxInstructionsChars',
          'cloud-context-max-chars',
          'Tamanho máx. das instruções (caracteres)',
          2000,
          60000,
          500,
        )}
      </div>
    </div>
  )
}

// ───────────────────────────── Phase 10.5: cascade ─────────────────────────────

const STT_LABELS: Record<string, string> = {
  'ollama-transcriptions': 'Ollama (transcrição local)',
  'local-whisper-http': 'Whisper local (servidor HTTP)',
  'openai-whisper': 'OpenAI Whisper',
  'groq-whisper': 'Groq Whisper',
  'web-speech-stt': 'Web Speech (navegador)',
}
/** Host-side STT only: the browser Web Speech recognizer can't transcribe the call's WAV turns. */
const CASCADE_STT_IDS: readonly string[] = USER_SELECTABLE_STT_PROVIDER_IDS.filter((id) => id !== 'web-speech-stt')

const LLM_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'nvidia-nim': 'NVIDIA NIM',
  ollama: 'Ollama (local)',
}

export const CASCADE_TTS_LABELS: Record<CascadeTtsProviderId, string> = {
  'llamacpp-tts': 'Voz local do llama.cpp (LFM3)',
  'local-kokoro-http': 'Kokoro (servidor local)',
  'openai-tts': 'OpenAI TTS',
  elevenlabs: 'ElevenLabs',
}

/** Cascade: STT provider → text LLM (chat default or a provider/model) → TTS provider/voice. */
export function CascadePanel(props: {
  draft: CascadeDraft
  onChange: (next: CascadeDraft) => void
}): React.ReactElement {
  const { draft, onChange } = props
  const voices = useCallStore((s) => s.voices)
  const llamaTts = draft.ttsProviderId === 'llamacpp-tts'

  useEffect(() => {
    if (llamaTts) void useCallStore.getState().loadVoices()
  }, [llamaTts])

  const changeTts = (ttsProviderId: CascadeTtsProviderId) => {
    const genderVoice = draft.ttsVoice === 'female' || draft.ttsVoice === 'male'
    let ttsVoice = draft.ttsVoice
    if (ttsProviderId === 'llamacpp-tts' && !genderVoice) ttsVoice = 'female'
    if (ttsProviderId !== 'llamacpp-tts' && genderVoice) ttsVoice = ''
    onChange({
      ...draft,
      ttsProviderId,
      ttsVoice,
      referenceVoiceId: ttsProviderId === 'llamacpp-tts' ? draft.referenceVoiceId : null,
    })
  }

  return (
    <div className="ashy-call-engine-panel" data-testid="cascade-panel">
      <div className="ashy-live-panel-head">
        <Workflow size={16} />
        <strong style={{ fontSize: '13px' }}>Pipeline clássica</strong>
      </div>
      <div className="ashy-live-grid">
        <div>
          <label htmlFor="cascade-stt-provider" style={fieldLabel}>
            Transcrição (STT):
          </label>
          <select
            id="cascade-stt-provider"
            data-testid="cascade-stt-provider"
            className="ashy-select"
            value={draft.sttProviderId}
            onChange={(e) => onChange({ ...draft, sttProviderId: e.target.value })}
          >
            {!CASCADE_STT_IDS.includes(draft.sttProviderId) && (
              <option value={draft.sttProviderId}>{STT_LABELS[draft.sttProviderId] ?? draft.sttProviderId}</option>
            )}
            {CASCADE_STT_IDS.map((id) => (
              <option key={id} value={id}>
                {STT_LABELS[id] ?? id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="cascade-llm-provider" style={fieldLabel}>
            Modelo de texto (provedor):
          </label>
          <select
            id="cascade-llm-provider"
            data-testid="cascade-llm-provider"
            className="ashy-select"
            value={draft.llmProviderId}
            onChange={(e) => onChange({ ...draft, llmProviderId: e.target.value })}
          >
            <option value="chat-default">Mesmo modelo do chat</option>
            {LLM_PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {LLM_LABELS[id] ?? id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="cascade-llm-model" style={fieldLabel}>
            Modelo (opcional):
          </label>
          <input
            id="cascade-llm-model"
            data-testid="cascade-llm-model"
            className="ashy-input"
            placeholder="qwen3:4b-instruct"
            value={draft.llmModelId}
            onChange={(e) => onChange({ ...draft, llmModelId: e.target.value })}
          />
          <div className="ashy-live-hint">
            Vazio = modelo configurado do provedor. Modelos pequenos recomendados: qwen3:4b-instruct (Ollama).
          </div>
        </div>
        <div>
          <label htmlFor="cascade-tts-provider" style={fieldLabel}>
            Voz (TTS):
          </label>
          <select
            id="cascade-tts-provider"
            data-testid="cascade-tts-provider"
            className="ashy-select"
            value={draft.ttsProviderId}
            onChange={(e) => changeTts(e.target.value as CascadeTtsProviderId)}
          >
            {CASCADE_TTS_PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {CASCADE_TTS_LABELS[id]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="cascade-tts-voice" style={fieldLabel}>
            {llamaTts ? 'Timbre:' : 'Voz do provedor:'}
          </label>
          {llamaTts ? (
            <select
              id="cascade-tts-voice"
              data-testid="cascade-tts-voice"
              className="ashy-select"
              value={draft.ttsVoice === 'male' ? 'male' : 'female'}
              onChange={(e) => onChange({ ...draft, ttsVoice: e.target.value })}
            >
              <option value="female">Feminina</option>
              <option value="male">Masculina</option>
            </select>
          ) : (
            <input
              id="cascade-tts-voice"
              data-testid="cascade-tts-voice"
              className="ashy-input"
              placeholder="vazio = voz das configurações de voz"
              value={draft.ttsVoice}
              onChange={(e) => onChange({ ...draft, ttsVoice: e.target.value })}
            />
          )}
        </div>
        {llamaTts && (
          <div>
            <label htmlFor="cascade-reference-voice" style={fieldLabel}>
              Voz de referência:
            </label>
            <select
              id="cascade-reference-voice"
              data-testid="cascade-reference-voice"
              className="ashy-select"
              value={draft.referenceVoiceId ?? ''}
              onChange={(e) => onChange({ ...draft, referenceVoiceId: e.target.value || null })}
            >
              <option value="">Sem referência</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {!llamaTts && (
        <p className="ashy-live-hint" style={{ margin: 0 }}>
          Usa a URL, a chave e a voz definidas em Configurações › Voz para esse provedor.
        </p>
      )}
    </div>
  )
}

// ───────────────────────────── Phase 10.3: Recursos na chamada ─────────────────────────────

export const CALL_TOOLS_NOTICE =
  'As ferramentas usam o modelo local de 2B; funciona melhor para pedidos simples.'
const IDLE_NUDGE_MIN_SEC = 20
const IDLE_NUDGE_MAX_SEC = 3600
const IDLE_NUDGE_DEFAULT_SEC = 90

function clampIdleNudge(value: number): number {
  if (!Number.isFinite(value)) return IDLE_NUDGE_DEFAULT_SEC
  return Math.min(IDLE_NUDGE_MAX_SEC, Math.max(IDLE_NUDGE_MIN_SEC, Math.round(value)))
}

type CallFeatureKey = 'toolsInCall' | 'visionInCall' | 'initiativeInCall'

const CALL_FEATURE_TOGGLES: ReadonlyArray<{ key: CallFeatureKey; testId: string; label: string; desc: string }> = [
  {
    key: 'toolsInCall',
    testId: 'toggle-tools-in-call',
    label: 'Ferramentas',
    desc: 'Ver a janela em foco, ler arquivos do workspace e anotar (com a sua aprovação).',
  },
  {
    key: 'visionInCall',
    testId: 'toggle-vision-in-call',
    label: 'Visão',
    desc: 'Olha a tela quando você pedir (respeita o modo Tela da privacidade).',
  },
  {
    key: 'initiativeInCall',
    testId: 'toggle-initiative-in-call',
    label: 'Iniciativa',
    desc: 'Puxa assunto depois de um tempo em silêncio (respeita o Não perturbe).',
  },
]

/** Live Mode › Recursos na chamada: each change saves right away (`liveMode:saveSettings {features}`). */
export function CallFeaturesSection(): React.ReactElement {
  const features = useCallStore((s) => s.liveSettings?.features)
  const saving = useCallStore((s) => s.busy.saveSettings === true)
  const saveLiveSettings = useCallStore((s) => s.saveLiveSettings)
  const savedIdle =
    typeof features?.idleNudgeSec === 'number' ? features.idleNudgeSec : IDLE_NUDGE_DEFAULT_SEC
  const [idleText, setIdleText] = useState(String(savedIdle))

  useEffect(() => {
    setIdleText(String(savedIdle))
  }, [savedIdle])

  const commitIdle = () => {
    const n = clampIdleNudge(Number(idleText))
    setIdleText(String(n))
    if (n !== savedIdle) void saveLiveSettings({ features: { idleNudgeSec: n } })
  }

  return (
    <div className="ashy-call-engine-panel" data-testid="call-features-section">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Wrench size={16} />
        <strong style={{ fontSize: '13px' }}>Recursos na chamada</strong>
      </div>
      {CALL_FEATURE_TOGGLES.map((t) => (
        <label key={t.key} className="ashy-call-feature-row">
          <input
            type="checkbox"
            data-testid={t.testId}
            checked={features?.[t.key] === true}
            disabled={saving}
            onChange={(e) => void saveLiveSettings({ features: { [t.key]: e.target.checked } })}
          />
          <span>
            <span style={{ fontWeight: 500 }}>{t.label}</span>
            <span className="ashy-call-feature-desc"> — {t.desc}</span>
          </span>
        </label>
      ))}
      <div className="ashy-call-feature-row">
        <label htmlFor="input-idle-nudge-sec" style={fieldLabel}>
          Puxar assunto após (segundos de silêncio):
        </label>
        <input
          id="input-idle-nudge-sec"
          data-testid="input-idle-nudge-sec"
          type="number"
          className="ashy-input"
          style={{ maxWidth: '110px' }}
          min={IDLE_NUDGE_MIN_SEC}
          max={IDLE_NUDGE_MAX_SEC}
          step={5}
          value={idleText}
          onChange={(e) => setIdleText(e.target.value)}
          onBlur={commitIdle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitIdle()
          }}
        />
      </div>
      <div className="ashy-call-feature-desc" data-testid="call-tools-notice" role="note">
        {CALL_TOOLS_NOTICE}
      </div>
    </div>
  )
}

// ───────────────────────────── Phase 10.2: reference voice + test call ─────────────────────────────

function formatDurationMs(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace('.', ',')} s`
}

/** Hybrid mode: upload / list / preview / use / delete reference voices. */
export function VoiceReferenceSection(): React.ReactElement {
  const voices = useCallStore((s) => s.voices)
  const voiceMessage = useCallStore((s) => s.voiceMessage)
  const busy = useCallStore((s) => s.busy)
  const liveSettings = useCallStore((s) => s.liveSettings)
  const importVoiceFile = useCallStore((s) => s.importVoiceFile)
  const previewVoice = useCallStore((s) => s.previewVoice)
  const deleteVoice = useCallStore((s) => s.deleteVoice)
  const selectVoice = useCallStore((s) => s.useVoice)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const activeId = liveSettings?.hybrid?.referenceVoiceId ?? null
  const fallbackVoice = liveSettings?.llamacpp.voice === 'male' ? 'masculina' : 'feminina'

  useEffect(() => {
    void useCallStore.getState().loadVoices()
  }, [])

  return (
    <div className="ashy-call-engine-panel" data-testid="voice-ref-section">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <Volume2 size={16} />
        <strong style={{ fontSize: '13px' }}>Voz de referência</strong>
        <span className="ashy-badge violet">{voices.length}/20</span>
      </div>
      <p style={{ fontSize: '11.5px', color: 'var(--text-secondary)', margin: 0 }}>
        Envie de 5 a 30 s de fala limpa (wav, mp3, flac, ogg ou m4a). O áudio é convertido aqui mesmo
        para mono 24 kHz, sem os silêncios das pontas.
      </p>
      <p
        data-testid="voice-ref-consent"
        style={{ fontSize: '11.5px', color: '#f2be79', margin: 0, fontWeight: 600 }}
      >
        Use só vozes que você tem direito de usar.
      </p>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="ashy-outline-btn" style={{ cursor: 'pointer' }}>
          <Upload size={13} /> {busy.voiceImport ? 'Importando…' : 'Enviar amostra'}
          <input
            ref={inputRef}
            type="file"
            data-testid="voice-ref-upload"
            accept={VOICE_REF_ACCEPT_ATTR}
            disabled={busy.voiceImport === true}
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              void importVoiceFile(file).finally(() => {
                if (inputRef.current) inputRef.current.value = ''
              })
            }}
          />
        </label>
        {voiceMessage && (
          <span
            data-testid="voice-ref-message"
            role="status"
            style={{
              fontSize: '11.5px',
              color: voiceMessage.kind === 'error' ? 'var(--status-danger)' : 'var(--text-secondary)',
            }}
          >
            {voiceMessage.text}
          </span>
        )}
      </div>

      <ul className="ashy-voice-ref-list" data-testid="voice-ref-list">
        <li
          className={`ashy-voice-ref-item ${activeId === null ? 'active' : ''}`}
          data-testid="voice-ref-none"
          data-active={activeId === null ? 'true' : 'false'}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong style={{ fontSize: '12.5px' }}>Sem referência (voz padrão feminina/masculina)</strong>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              Usa a voz {fallbackVoice} escolhida em “Voz”.
            </div>
          </div>
          <button
            type="button"
            className="ashy-outline-btn"
            data-testid="btn-voice-ref-none-preview"
            disabled={busy.voicePreview === true}
            onClick={() => void previewVoice(null)}
          >
            <Play size={12} /> Ouvir
          </button>
          {activeId === null ? (
            <span className="ashy-badge emerald">Em uso</span>
          ) : (
            <button
              type="button"
              className="ashy-outline-btn"
              data-testid="btn-voice-ref-none-use"
              disabled={busy.saveSettings === true}
              onClick={() => void selectVoice(null)}
            >
              Usar voz padrão
            </button>
          )}
        </li>
        {voices.map((voice) => {
          const inUse = voice.id === activeId
          return (
            <li
              key={voice.id}
              className={`ashy-voice-ref-item ${inUse ? 'active' : ''}`}
              data-testid="voice-ref-item"
              data-voice-id={voice.id}
              data-active={inUse ? 'true' : 'false'}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ fontSize: '12.5px' }}>{voice.name}</strong>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  {formatDurationMs(voice.durationMs)}
                </div>
              </div>
              <button
                type="button"
                className="ashy-outline-btn"
                data-testid="btn-voice-ref-preview"
                disabled={busy.voicePreview === true}
                onClick={() => void previewVoice(voice.id)}
              >
                <Play size={12} /> Ouvir
              </button>
              {inUse ? (
                <span className="ashy-badge emerald">Em uso</span>
              ) : (
                <button
                  type="button"
                  className="ashy-outline-btn"
                  data-testid="btn-voice-ref-use"
                  disabled={busy.saveSettings === true}
                  onClick={() => void selectVoice(voice.id)}
                >
                  Usar esta voz
                </button>
              )}
              <button
                type="button"
                className="ashy-outline-btn"
                data-testid="btn-voice-ref-delete"
                disabled={busy.voiceDelete === true}
                title="Excluir esta voz"
                onClick={() => void deleteVoice(voice.id)}
              >
                <Trash2 size={12} /> Excluir
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** "Testar chamada": a synthetic question replaces the mic; shows each stage ✓/✗ with timings. */
export function TestCallSection(): React.ReactElement {
  const testCall = useCallStore((s) => s.testCall)
  const busy = useCallStore((s) => s.busy.testCall === true)
  const callActive = useCallStore((s) => isCallActiveStatus(s.callState.status))
  const startTestCall = useCallStore((s) => s.startTestCall)
  const backend = useCallStore((s) => s.liveSettings?.backend ?? 'llamacpp-realtime')
  const engineInstalled = useCallStore((s) => s.engineStatus?.installed === true)
  // Known limit: the synthetic question is always spoken by llama.cpp /tts (also for cloud/cascade).
  const testNeedsEngine = !isLlamaCppBackend(backend) && !engineInstalled
  const running = testCall.status === 'running'
  const result = testCall.result
  const metrics = result?.metrics ?? null
  const metricEntries: Array<[string, number | undefined]> = [
    ['Fim de fala', metrics?.endpointMs],
    ['ASR', metrics?.asrMs],
    ['1º byte', metrics?.ttfbMs],
    ['Início do áudio', metrics?.playbackStartMs],
    ['Ponta a ponta', metrics?.e2eMs],
  ]

  return (
    <div className="ashy-call-engine-panel" data-testid="live-test-section">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <FlaskConical size={16} />
        <strong style={{ fontSize: '13px' }}>Testar chamada</strong>
        <button
          type="button"
          className="ashy-peach-btn"
          data-testid="btn-live-test-call"
          data-test-status={testCall.status}
          disabled={running || busy || callActive || testNeedsEngine}
          onClick={() => void startTestCall()}
          title="A Ashy ouve uma pergunta sintetizada no lugar do microfone e responde; cada etapa é medida."
        >
          {running ? 'Testando…' : 'Testar chamada'}
        </button>
      </div>
      <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: 0 }}>
        Uma pergunta sintetizada substitui o microfone por um turno. Nada disso vai para a memória.
      </p>
      {testNeedsEngine && (
        <p className="ashy-live-hint ashy-live-hint--warn" data-testid="live-test-engine-hint" role="note">
          O teste sintetiza a pergunta com a voz local do llama.cpp, que não está instalada. Instale o
          motor local (em um backend local) para testar; a chamada normal funciona sem ele.
        </p>
      )}
      {running && (
        <div data-testid="live-test-running" role="status" style={{ fontSize: '12px' }}>
          Teste em andamento…
        </div>
      )}
      {testCall.status === 'failed' && (
        <div
          data-testid="live-test-error"
          role="status"
          style={{ fontSize: '12px', color: 'var(--status-danger)' }}
        >
          {testCall.error ?? 'O teste falhou.'}
        </div>
      )}
      {result && (
        <div
          data-testid="live-test-result"
          data-ok={result.ok ? 'true' : 'false'}
          className="ashy-call-test-result"
        >
          <div
            style={{
              fontSize: '12.5px',
              fontWeight: 600,
              color: result.ok ? '#8fd6a8' : 'var(--status-danger)',
            }}
          >
            {result.ok ? '✓ Chamada funcionando' : '✗ Alguma etapa falhou'}
          </div>
          <ul className="ashy-call-test-steps">
            {result.steps.map((step) => (
              <li
                key={step.step}
                data-testid={`live-test-step-${step.step}`}
                data-ok={step.ok ? 'true' : 'false'}
              >
                <span className={step.ok ? 'ashy-test-ok' : 'ashy-test-fail'} aria-hidden="true">
                  {step.ok ? <Check size={12} /> : <X size={12} />}
                </span>
                <span>
                  {step.ok ? '✓' : '✗'} {CALL_TEST_STEP_LABELS[step.step] ?? step.step}
                </span>
                {typeof step.ms === 'number' && (
                  <span style={{ color: 'var(--text-secondary)' }}>{Math.round(step.ms)} ms</span>
                )}
                {step.detail && (
                  <span style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>— {step.detail}</span>
                )}
              </li>
            ))}
          </ul>
          {metrics && (
            <div data-testid="live-test-metrics" style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
              {metricEntries
                .filter(([, value]) => typeof value === 'number')
                .map(([label, value]) => `${label}: ${Math.round(value!)} ms`)
                .join(' · ')}
            </div>
          )}
          {result.transcript && (
            <div data-testid="live-test-transcript" style={{ fontSize: '12px' }}>
              Você (teste): {result.transcript}
            </div>
          )}
          {result.reply && (
            <div data-testid="live-test-reply" style={{ fontSize: '12px' }}>
              Ashy: {result.reply}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
