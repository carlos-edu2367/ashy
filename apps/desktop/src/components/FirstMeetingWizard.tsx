import React, { useEffect, useState } from 'react'
import {
  FALLBACK_PROVIDER_MODELS,
  LLM_PROVIDER_IDS,
  type ComputerActionsPolicy,
  type LlmProviderId,
  type OmniExecutionMode,
  type OnboardingArchitectureMode,
  type ProviderHealthResult,
  type ReasoningEffort,
  type SharedEyesMode,
  type SharedMicMode,
  type UpdateInitiativePolicyInput,
} from '@ashy/shared'
import {
  KeyRound,
  Mic,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Volume2,
  Wifi,
} from 'lucide-react'
import { useAshyStore } from '../store/useAshyStore'
import { REASONING_EFFORT_OPTIONS } from './ModelsSettingsPanel'

function parseQuietHoursToInitiativePolicy(quietHoursRange: string): UpdateInitiativePolicyInput {
  const trimmed = quietHoursRange.trim()
  if (trimmed.toLowerCase() === 'desativado') {
    return {
      enabled: true,
      respectDnd: false,
    }
  }
  const match = trimmed.match(/^((?:[01]\d|2[0-3]):[0-5]\d)\s*[-–—]\s*((?:[01]\d|2[0-3]):[0-5]\d)$/)
  if (match) {
    return {
      enabled: true,
      quietHoursStart: match[1]!,
      quietHoursEnd: match[2]!,
      respectDnd: true,
    }
  }
  return {
    enabled: true,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00',
    respectDnd: true,
  }
}

export function FirstMeetingWizard(): React.ReactElement {
  const providers = useAshyStore((s) => s.providers)
  const completeOnboarding = useAshyStore((s) => s.completeOnboarding)
  const testProviderConnection = useAshyStore((s) => s.testProviderConnection)
  const providerModelCatalog = useAshyStore((s) => s.providerModelCatalog)
  const isLoadingProviderModels = useAshyStore((s) => s.isLoadingProviderModels)
  const listProviderModels = useAshyStore((s) => s.listProviderModels)

  const initialProvider: LlmProviderId = providers.activeProviderId ?? 'openrouter'
  const initialConfig = providers.configs[initialProvider]

  const [userName, setUserName] = useState('')
  const [userPronouns, setUserPronouns] = useState('ele/dele')
  const [architectureMode, setArchitectureMode] =
    useState<OnboardingArchitectureMode>('cloud-hybrid')
  const [selectedProvider, setSelectedProvider] = useState<LlmProviderId>(initialProvider)
  const [baseUrl, setBaseUrl] = useState(initialConfig?.baseUrl ?? 'https://openrouter.ai/api/v1')
  const [modelId, setModelId] = useState(
    initialConfig?.modelId ?? 'anthropic/claude-3.7-sonnet',
  )
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    initialConfig?.reasoningEffort ?? 'none',
  )
  const [isOmniModel, setIsOmniModel] = useState<boolean>(false)
  const [omniExecutionMode, setOmniExecutionMode] = useState<OmniExecutionMode>('modular')
  const [omniVoiceId, setOmniVoiceId] = useState<string>('ashy-warm-ptbr')
  const [apiKey, setApiKey] = useState('')
  const [modelSearch, setModelSearch] = useState('')
  const [testResult, setTestResult] = useState<ProviderHealthResult | null>(null)
  const [isTesting, setIsTesting] = useState(false)

  // Privacy Permissions & Quiet Hours State
  const [eyesMode, setEyesMode] = useState<SharedEyesMode>('off')
  const [micMode, setMicMode] = useState<SharedMicMode>('muted')
  const [approvalPolicy, setApprovalPolicy] = useState<ComputerActionsPolicy>('ask')
  const [quietHoursSelect, setQuietHoursSelect] = useState<string>('22:00 — 08:00')

  // Quick Voice & Mic Test State
  const [micTestStatus, setMicTestStatus] = useState<string | null>(null)
  const [ttsTestStatus, setTtsTestStatus] = useState<string | null>(null)
  const [isTestingMicBtn, setIsTestingMicBtn] = useState(false)
  const [isTestingTtsBtn, setIsTestingTtsBtn] = useState(false)

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const currentProviderMeta = providers.configs[selectedProvider]
  const currentCatalog =
    providerModelCatalog[selectedProvider] ?? FALLBACK_PROVIDER_MODELS[selectedProvider] ?? []
  const filteredCatalog = currentCatalog.filter((m) => {
    const q = modelSearch.trim().toLowerCase()
    if (!q) return true
    return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
  })
  const isLoadingCatalog = isLoadingProviderModels

  useEffect(() => {
    void listProviderModels({ providerId: selectedProvider })
  }, [selectedProvider, listProviderModels])

  const handleSelectLocalOmniMode = () => {
    setArchitectureMode('local-omni')
    setSelectedProvider('ollama')
    setBaseUrl('http://127.0.0.1:11434')
    setModelId('lfm3-omni:2b')
    setReasoningEffort('none')
    setIsOmniModel(true)
    setOmniExecutionMode('native-omni')
    setOmniVoiceId('ashy-warm-ptbr')
    setTestResult(null)
    setErrorMsg(null)
  }

  const handleSelectCloudHybridMode = () => {
    setArchitectureMode('cloud-hybrid')
    setIsOmniModel(false)
    setOmniExecutionMode('modular')
    if (selectedProvider === 'ollama' && modelId === 'lfm3-omni:2b') {
      const cloudCfg = providers.configs.openrouter
      setSelectedProvider('openrouter')
      setBaseUrl(cloudCfg?.baseUrl ?? 'https://openrouter.ai/api/v1')
      setModelId(cloudCfg?.modelId ?? 'anthropic/claude-3.7-sonnet')
      setReasoningEffort(cloudCfg?.reasoningEffort ?? 'none')
    }
    setTestResult(null)
    setErrorMsg(null)
  }

  const handleRefreshCatalog = () => {
    void listProviderModels({
      providerId: selectedProvider,
      baseUrl: baseUrl.trim() || currentProviderMeta?.baseUrl,
      ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
    })
  }

  const handleProviderChange = (nextId: LlmProviderId) => {
    setSelectedProvider(nextId)
    const nextCfg = providers.configs[nextId]
    if (nextCfg) {
      setBaseUrl(nextCfg.baseUrl)
      setModelId(nextCfg.modelId)
      setReasoningEffort(nextCfg.reasoningEffort ?? 'none')
    }
    setTestResult(null)
    setErrorMsg(null)
  }

  const handleTestConnection = async () => {
    setIsTesting(true)
    setErrorMsg(null)
    try {
      const res = await testProviderConnection({
        providerId: selectedProvider,
        baseUrl: baseUrl.trim() || currentProviderMeta.baseUrl,
        modelId: modelId.trim() || currentProviderMeta.modelId,
        reasoningEffort,
        ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
      })
      setTestResult(res)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setIsTesting(false)
    }
  }

  const handleTestMic = async () => {
    setIsTestingMicBtn(true)
    try {
      const res = await useAshyStore.getState().testMicrophone()
      setMicTestStatus(res.message)
    } catch (err) {
      setMicTestStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setIsTestingMicBtn(false)
    }
  }

  const handleTestTts = async () => {
    setIsTestingTtsBtn(true)
    try {
      const res = await useAshyStore.getState().testTtsVoice()
      setTtsTestStatus(res.message)
    } catch (err) {
      setTtsTestStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setIsTestingTtsBtn(false)
    }
  }

  const handleComplete = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    const cleanName = userName.trim()
    if (!cleanName) {
      setErrorMsg('Como posso te chamar? Digite seu nome para começarmos.')
      return
    }

    setIsSubmitting(true)
    setErrorMsg(null)
    try {
      const trimmedKey = apiKey.trim()
      const shouldIncludeProvider =
        architectureMode === 'local-omni' ||
        !currentProviderMeta.requiresApiKey ||
        trimmedKey.length > 0 ||
        currentProviderMeta.hasApiKey

      const isLocalOmni = architectureMode === 'local-omni' || isOmniModel

      await completeOnboarding({
        userName: cleanName,
        userPronouns: userPronouns.trim() || undefined,
        architectureMode,
        seedFirstGreeting: true,
        ...(shouldIncludeProvider
          ? {
              providerConfig: {
                providerId: selectedProvider,
                baseUrl: baseUrl.trim() || currentProviderMeta.baseUrl,
                modelId: modelId.trim() || currentProviderMeta.modelId,
                reasoningEffort,
                ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
                ...(isLocalOmni
                  ? {
                      isOmniModel: true,
                      supportsOmniAudioIn: true,
                      supportsOmniAudioOut: true,
                      supportsOmniVideoIn: true,
                      inputModalities: ['text', 'audio', 'image', 'video'],
                      outputModalities: ['text', 'audio'],
                      omniExecutionMode,
                      omniVoiceId,
                    }
                  : {}),
              },
            }
          : {}),
        ...(architectureMode === 'local-omni'
          ? {
              voiceSettings: {
                unifiedOmniMode: true,
                directOmniAudio: true,
              },
            }
          : {}),
        agencyConsent: {
          eyesMode,
          micMode,
          approvalPolicy,
        },
        initiativePolicy: parseQuietHoursToInitiativePolicy(quietHoursSelect),
      })
      setApiKey('')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSkipProvider = async () => {
    const cleanName = userName.trim() || 'Você'
    setIsSubmitting(true)
    setErrorMsg(null)
    try {
      await completeOnboarding({
        userName: cleanName,
        userPronouns: userPronouns.trim() || undefined,
        architectureMode,
        seedFirstGreeting: true,
        agencyConsent: {
          eyesMode,
          micMode,
          approvalPolicy,
        },
        initiativePolicy: parseQuietHoursToInitiativePolicy(quietHoursSelect),
      })
      setApiKey('')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      data-testid="first-meeting-wizard"
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-meeting-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        background: 'rgba(13, 11, 19, 0.86)',
        backdropFilter: 'blur(18px)',
        overflowY: 'auto',
      }}
    >
      <form
        onSubmit={handleComplete}
        className="ashy-settings-card"
        style={{
          width: 'min(640px, 100%)',
          maxHeight: '92vh',
          overflowY: 'auto',
          padding: '24px 28px',
          borderRadius: '20px',
          background: 'linear-gradient(165deg, #1f1b2c 0%, #15131f 100%)',
          border: '1px solid rgba(244, 166, 136, 0.32)',
          boxShadow: '0 28px 72px rgba(0, 0, 0, 0.72)',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="ashy-badge peach">
            <Sparkles size={12} style={{ marginRight: '5px' }} />
            Fase 0 • Primeiro Encontro
          </span>
          <span className="ashy-badge violet">Cozy Night Studio • v1.0</span>
        </div>

        <div>
          <h2 id="first-meeting-title" className="ashy-serif-title" style={{ fontSize: '28px' }}>
            As luzes do estúdio acabaram de acender.
          </h2>
          <p className="ashy-subtitle" style={{ marginTop: '6px' }}>
            Ainda não temos memórias pré-fabricadas. Nossa história começa de verdade a partir
            deste instante.
          </p>
        </div>

        {/* Step 1: User Identity */}
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '210px' }}>
            <label
              htmlFor="onboarding-user-name-input"
              style={{
                display: 'block',
                fontSize: '12px',
                color: 'var(--text-secondary)',
                marginBottom: '6px',
              }}
            >
              Como posso te chamar?
            </label>
            <input
              id="onboarding-user-name-input"
              data-testid="onboarding-user-name-input"
              type="text"
              className="ashy-input"
              placeholder="Seu nome ou apelido..."
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
            />
          </div>

          <div style={{ width: '160px' }}>
            <label
              htmlFor="onboarding-pronouns-select"
              style={{
                display: 'block',
                fontSize: '12px',
                color: 'var(--text-secondary)',
                marginBottom: '6px',
              }}
            >
              Pronomes
            </label>
            <select
              id="onboarding-pronouns-select"
              data-testid="onboarding-pronouns-select"
              className="ashy-select"
              value={userPronouns}
              onChange={(e) => setUserPronouns(e.target.value)}
            >
              <option value="ele/dele">ele/dele</option>
              <option value="ela/dela">ela/dela</option>
              <option value="elu/delu">elu/delu</option>
              <option value="">Prefiro não informar</option>
            </select>
          </div>
        </div>

        {/* Step 1.5: Architecture Mode Selector (Local Omni vs Cloud Hybrid) */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '12px 14px',
            borderRadius: '14px',
            background: 'rgba(17, 15, 24, 0.68)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <span style={{ fontWeight: 600, fontSize: '12.5px', color: 'var(--text-primary)' }}>
            Arquitetura de Execução (Local Omni vs Cloud Híbrido)
          </span>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              data-testid="onboarding-mode-local-omni"
              aria-pressed={architectureMode === 'local-omni'}
              className={`ashy-outline-btn ${architectureMode === 'local-omni' ? 'active' : ''}`}
              style={{
                flex: 1,
                minWidth: '220px',
                padding: '8px 12px',
                fontSize: '11.5px',
                textAlign: 'left',
                borderColor:
                  architectureMode === 'local-omni'
                    ? 'var(--accent-peach)'
                    : 'var(--border-soft)',
              }}
              onClick={handleSelectLocalOmniMode}
            >
              ⚡ Modo Local / Omni Unificado (LFM3-Omni-2B / Ollama / llama-server)
            </button>
            <button
              type="button"
              data-testid="onboarding-mode-cloud-hybrid"
              aria-pressed={architectureMode === 'cloud-hybrid'}
              className={`ashy-outline-btn ${architectureMode === 'cloud-hybrid' ? 'active' : ''}`}
              style={{
                flex: 1,
                minWidth: '220px',
                padding: '8px 12px',
                fontSize: '11.5px',
                textAlign: 'left',
                borderColor:
                  architectureMode === 'cloud-hybrid'
                    ? 'var(--accent-peach)'
                    : 'var(--border-soft)',
              }}
              onClick={handleSelectCloudHybridMode}
            >
              ☁️ Modo Cloud / Híbrido (OpenRouter, OpenAI, Anthropic, Gemini, Groq, ElevenLabs)
            </button>
          </div>
        </div>

        {/* Step 2: LLM Provider Setup */}
        <div
          style={{
            padding: '14px 16px',
            borderRadius: '14px',
            background: 'rgba(17, 15, 24, 0.68)',
            border: '1px solid var(--border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <KeyRound size={15} style={{ color: 'var(--accent-peach)' }} />
            <span style={{ fontWeight: 600, fontSize: '13px' }}>
              Motor cognitivo (LLM Provider)
            </span>
          </div>

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: '150px' }}>
              <label
                htmlFor="onboarding-provider-select"
                style={{
                  display: 'block',
                  fontSize: '11.5px',
                  color: 'var(--text-secondary)',
                  marginBottom: '4px',
                }}
              >
                Provedor
              </label>
              <select
                id="onboarding-provider-select"
                data-testid="onboarding-provider-select"
                className="ashy-select"
                value={selectedProvider}
                onChange={(e) => handleProviderChange(e.target.value as LlmProviderId)}
              >
                {LLM_PROVIDER_IDS.map((id) => (
                  <option key={id} value={id}>
                    {providers.configs[id]?.label ?? id}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ flex: 1, minWidth: '180px' }}>
              <label
                htmlFor="onboarding-model-id-input"
                style={{
                  display: 'block',
                  fontSize: '11.5px',
                  color: 'var(--text-secondary)',
                  marginBottom: '4px',
                }}
              >
                Modelo (Model ID)
              </label>
              <input
                id="onboarding-model-id-input"
                data-testid="onboarding-model-id-input"
                type="text"
                className="ashy-input"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
              />
            </div>

            <div style={{ flex: 1, minWidth: '180px' }}>
              <label
                htmlFor="onboarding-reasoning-effort-select"
                style={{
                  display: 'block',
                  fontSize: '11.5px',
                  color: 'var(--text-secondary)',
                  marginBottom: '4px',
                }}
              >
                Raciocínio (Thinking)
              </label>
              <select
                id="onboarding-reasoning-effort-select"
                data-testid="onboarding-reasoning-effort-select"
                className="ashy-select"
                value={reasoningEffort}
                onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort)}
              >
                {REASONING_EFFORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div
            data-testid="onboarding-model-suggestions"
            style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <Search
                  size={12}
                  style={{
                    position: 'absolute',
                    left: '9px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--text-muted)',
                  }}
                />
                <input
                  data-testid="onboarding-model-search-input"
                  type="text"
                  className="ashy-input"
                  style={{ paddingLeft: '26px', height: '28px', fontSize: '11.5px' }}
                  placeholder="Filtrar modelos do catálogo..."
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                />
              </div>
              <button
                type="button"
                data-testid="wizard-refresh-models-btn"
                className="ashy-outline-btn"
                style={{ padding: '4px 10px', fontSize: '11px' }}
                disabled={isLoadingCatalog}
                onClick={handleRefreshCatalog}
              >
                <RefreshCw size={11} />
                <span>{isLoadingCatalog ? 'Buscando...' : 'Buscar da API'}</span>
              </button>
            </div>

            <div
              data-testid="onboarding-model-catalog-list"
              style={{
                display: 'flex',
                gap: '6px',
                flexWrap: 'wrap',
                maxHeight: '90px',
                overflowY: 'auto',
              }}
            >
              {filteredCatalog.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  data-testid={`onboarding-model-option-${m.id}`}
                  className={`ashy-filter-pill ${modelId.trim() === m.id ? 'active' : ''}`}
                  style={{ padding: '3px 8px', fontSize: '11px' }}
                  onClick={() => setModelId(m.id)}
                >
                  {m.id}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label
              htmlFor="onboarding-base-url-input"
              style={{
                display: 'block',
                fontSize: '11.5px',
                color: 'var(--text-secondary)',
                marginBottom: '4px',
              }}
            >
              Endpoint Base URL
            </label>
            <input
              id="onboarding-base-url-input"
              data-testid="onboarding-base-url-input"
              type="text"
              className="ashy-input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          <div>
            <label
              htmlFor="onboarding-api-key-input"
              style={{
                display: 'block',
                fontSize: '11.5px',
                color: 'var(--text-secondary)',
                marginBottom: '4px',
              }}
            >
              {currentProviderMeta?.requiresApiKey
                ? `Chave de API (${currentProviderMeta.label})`
                : 'Chave de API (opcional para Ollama local)'}
            </label>
            <input
              id="onboarding-api-key-input"
              data-testid="onboarding-api-key-input"
              type="password"
              autoComplete="off"
              className="ashy-input"
              placeholder={
                currentProviderMeta?.requiresApiKey
                  ? 'Cole sua chave secreta (criptografada localmente)...'
                  : 'Sem chave necessária para execução local'
              }
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
              flexWrap: 'wrap',
            }}
          >
            <button
              type="button"
              data-testid="onboarding-test-provider-btn"
              className="ashy-outline-btn"
              style={{ padding: '6px 12px', fontSize: '12px' }}
              disabled={isTesting}
              onClick={() => void handleTestConnection()}
            >
              <Wifi size={13} />
              <span>{isTesting ? 'Testando...' : 'Testar Conexão'}</span>
            </button>

            {testResult && (
              <span
                data-testid="onboarding-test-status"
                className={`ashy-badge ${testResult.ok ? 'emerald' : 'amber'}`}
              >
                {testResult.ok
                  ? `Conectado (${testResult.latencyMs}ms)`
                  : `Falha: ${testResult.error ?? 'Erro de conexão'}`}
              </span>
            )}
          </div>
        </div>

        {/* Step 3: Privacy Permissions & Quiet Hours + Quick Voice/Mic Tests */}
        <div
          style={{
            padding: '14px 16px',
            borderRadius: '14px',
            background: 'rgba(17, 15, 24, 0.68)',
            border: '1px solid var(--border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldCheck size={15} style={{ color: 'var(--accent-peach)' }} />
            <span style={{ fontWeight: 600, fontSize: '13px' }}>
              Permissões &amp; Limites de Privacidade
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' }}>
            <div>
              <label
                htmlFor="onboarding-eyes-mode-select"
                style={{
                  display: 'block',
                  fontSize: '11.5px',
                  color: 'var(--text-secondary)',
                  marginBottom: '4px',
                }}
              >
                Visão da Tela (EyesMode)
              </label>
              <select
                id="onboarding-eyes-mode-select"
                data-testid="onboarding-eyes-mode-select"
                className="ashy-select"
                value={eyesMode}
                onChange={(e) => setEyesMode(e.target.value as SharedEyesMode)}
              >
                <option value="off">Desligado (Padrão)</option>
                <option value="window">Apenas janela ativa</option>
                <option value="screen">Tela inteira</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="onboarding-mic-mode-select"
                style={{
                  display: 'block',
                  fontSize: '11.5px',
                  color: 'var(--text-secondary)',
                  marginBottom: '4px',
                }}
              >
                Modo do Microfone (MicMode)
              </label>
              <select
                id="onboarding-mic-mode-select"
                data-testid="onboarding-mic-mode-select"
                className="ashy-select"
                value={micMode}
                onChange={(e) => setMicMode(e.target.value as SharedMicMode)}
              >
                <option value="muted">Microfone Mudo</option>
                <option value="ptt">Push-to-Talk (Segurar para falar)</option>
                <option value="continuous">Escuta Contínua (VAD)</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="onboarding-approval-policy-select"
                style={{
                  display: 'block',
                  fontSize: '11.5px',
                  color: 'var(--text-secondary)',
                  marginBottom: '4px',
                }}
              >
                Ações no Computador (Gatekeeper)
              </label>
              <select
                id="onboarding-approval-policy-select"
                data-testid="onboarding-approval-policy-select"
                className="ashy-select"
                value={approvalPolicy}
                onChange={(e) => setApprovalPolicy(e.target.value as ComputerActionsPolicy)}
              >
                <option value="ask">Sempre pedir aprovação no Gatekeeper</option>
                <option value="session">Confiar durante a sessão</option>
                <option value="auto_accept">Autônomo</option>
                <option value="off">Ações desativadas</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="onboarding-quiet-hours-select"
                style={{
                  display: 'block',
                  fontSize: '11.5px',
                  color: 'var(--text-secondary)',
                  marginBottom: '4px',
                }}
              >
                Horários de Silêncio (Quiet Hours)
              </label>
              <select
                id="onboarding-quiet-hours-select"
                data-testid="onboarding-quiet-hours-select"
                className="ashy-select"
                value={quietHoursSelect}
                onChange={(e) => setQuietHoursSelect(e.target.value)}
              >
                <option value="22:00 — 08:00">22:00 — 08:00</option>
                <option value="23:00 — 08:00">23:00 — 08:00</option>
                <option value="23:00 — 07:00">23:00 — 07:00</option>
                <option value="00:00 — 06:00">00:00 — 06:00</option>
                <option value="Desativado">Desativado</option>
              </select>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              flexWrap: 'wrap',
              marginTop: '2px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                data-testid="onboarding-test-mic-btn"
                className="ashy-outline-btn"
                style={{ padding: '5px 10px', fontSize: '11.5px' }}
                disabled={isTestingMicBtn}
                onClick={() => void handleTestMic()}
              >
                <Mic size={12} />
                <span>{isTestingMicBtn ? 'Testando...' : 'Testar Microfone'}</span>
              </button>
              <span
                data-testid="onboarding-mic-test-status"
                className="ashy-badge neutral"
                style={{ fontSize: '11px' }}
              >
                {micTestStatus ?? 'Microfone pronto para teste'}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                data-testid="onboarding-test-tts-btn"
                className="ashy-outline-btn"
                style={{ padding: '5px 10px', fontSize: '11.5px' }}
                disabled={isTestingTtsBtn}
                onClick={() => void handleTestTts()}
              >
                <Volume2 size={12} />
                <span>{isTestingTtsBtn ? 'Sintetizando...' : 'Testar Voz da Ashy'}</span>
              </button>
              <span
                data-testid="onboarding-tts-test-status"
                className="ashy-badge neutral"
                style={{ fontSize: '11px' }}
              >
                {ttsTestStatus ?? 'Voz pronta para teste'}
              </span>
            </div>
          </div>
        </div>

        {errorMsg && (
          <div
            data-testid="onboarding-error-msg"
            style={{
              padding: '9px 12px',
              borderRadius: '10px',
              background: 'rgba(217, 107, 112, 0.14)',
              border: '1px solid rgba(217, 107, 112, 0.4)',
              fontSize: '12px',
              color: '#f5b5b8',
            }}
          >
            {errorMsg}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            flexWrap: 'wrap',
            marginTop: '4px',
          }}
        >
          <button
            type="button"
            data-testid="onboarding-skip-provider-btn"
            className="ashy-outline-btn"
            disabled={isSubmitting}
            onClick={() => void handleSkipProvider()}
          >
            Configurar provedor depois
          </button>

          <button
            type="submit"
            data-testid="onboarding-complete-btn"
            className="ashy-peach-btn"
            disabled={isSubmitting}
          >
            <Sparkles size={15} />
            <span>{isSubmitting ? 'Despertando...' : 'Despertar Ashy'}</span>
          </button>
        </div>
      </form>
    </div>
  )
}
