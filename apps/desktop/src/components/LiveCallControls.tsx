/**
 * Phase 10.1 — Live Call UI (spec §9.1–9.3): hub call orb + status strip, overlay call buttons and
 * state dot, and the "Live Mode" settings panel. Everything reads `useCallStore`.
 */
import React, { useEffect, useRef, useState } from 'react'
import {
  LIVE_BACKENDS_IMPLEMENTED,
  LIVE_LOCAL_MODELS,
  LLAMACPP_VARIANTS,
  type LiveBackendId,
  type LiveInputMode,
  type LlamaCppVariant,
} from '@ashy/shared'
import {
  Check,
  Cpu,
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

const BACKEND_CARDS: ReadonlyArray<{ id: LiveBackendId; label: string; desc: string; enabled: boolean }> = [
  {
    id: 'llamacpp-realtime',
    label: 'Local omni (LFM3 via llama.cpp)',
    desc: 'Tudo no seu PC: voz entra e sai do modelo local.',
    enabled: true,
  },
  {
    id: 'llamacpp-hybrid',
    label: 'Local omni + minha voz (híbrido)',
    desc: 'O modelo local pensa em texto e o /tts do llama.cpp fala — com a sua voz de referência.',
    enabled: true,
  },
  { id: 'gemini-live', label: 'Gemini Live', desc: 'Nuvem realtime (Google).', enabled: false },
  { id: 'openai-realtime', label: 'OpenAI Realtime', desc: 'Nuvem realtime (OpenAI).', enabled: false },
  { id: 'cascade', label: 'Cascata (STT → LLM → TTS)', desc: 'Cada etapa com o seu provedor.', enabled: false },
]

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

  const handleSave = async () => {
    const trimmedUrl = endpointUrl.trim()
    if (endpointMode === 'url' && !trimmedUrl) {
      setSavedNotice('Informe a URL do servidor (ex.: http://127.0.0.1:8080).')
      return
    }
    const saved = await saveLiveSettings({
      backend: LIVE_BACKENDS_IMPLEMENTED.includes(selectedBackend) ? selectedBackend : 'llamacpp-realtime',
      llamacpp: {
        voice,
        inputMode,
        endpoint: endpointMode === 'managed' ? 'managed' : { url: trimmedUrl },
      },
      turn: { vadThreshold, endpointMs },
      session: { rotateAfterTurns: Math.min(50, Math.max(2, Math.round(rotateAfterTurns))) },
      devices: { inputDeviceId },
    })
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
            data-testid={card.id === 'llamacpp-hybrid' ? 'live-backend-hybrid' : `live-backend-card-${card.id}`}
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

      {/* Engine panel */}
      <div className="ashy-call-engine-panel" data-testid="live-engine-panel">
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

      {/* Voice, input mode, turns */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '12px',
          marginTop: '12px',
        }}
      >
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
      </div>

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
          disabled={running || busy || callActive}
          onClick={() => void startTestCall()}
          title="A Ashy ouve uma pergunta sintetizada no lugar do microfone e responde; cada etapa é medida."
        >
          {running ? 'Testando…' : 'Testar chamada'}
        </button>
      </div>
      <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: 0 }}>
        Uma pergunta sintetizada substitui o microfone por um turno. Nada disso vai para a memória.
      </p>
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
