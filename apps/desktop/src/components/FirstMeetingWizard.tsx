import React, { useEffect, useState } from 'react'
import {
  FALLBACK_PROVIDER_MODELS,
  LLM_PROVIDER_IDS,
  type LlmProviderId,
  type ProviderHealthResult,
  type ReasoningEffort,
} from '@ashy/shared'
import { KeyRound, RefreshCw, Search, Sparkles, Wifi } from 'lucide-react'
import { useAshyStore } from '../store/useAshyStore'
import { REASONING_EFFORT_OPTIONS } from './ModelsSettingsPanel'

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
  const [selectedProvider, setSelectedProvider] = useState<LlmProviderId>(initialProvider)
  const [baseUrl, setBaseUrl] = useState(initialConfig?.baseUrl ?? 'https://openrouter.ai/api/v1')
  const [modelId, setModelId] = useState(
    initialConfig?.modelId ?? 'anthropic/claude-3.7-sonnet',
  )
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    initialConfig?.reasoningEffort ?? 'none',
  )
  const [apiKey, setApiKey] = useState('')
  const [modelSearch, setModelSearch] = useState('')
  const [testResult, setTestResult] = useState<ProviderHealthResult | null>(null)
  const [isTesting, setIsTesting] = useState(false)
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
        !currentProviderMeta.requiresApiKey ||
        trimmedKey.length > 0 ||
        currentProviderMeta.hasApiKey

      await completeOnboarding({
        userName: cleanName,
        userPronouns: userPronouns.trim() || undefined,
        ...(shouldIncludeProvider
          ? {
              providerConfig: {
                providerId: selectedProvider,
                baseUrl: baseUrl.trim() || currentProviderMeta.baseUrl,
                modelId: modelId.trim() || currentProviderMeta.modelId,
                reasoningEffort,
                ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
              },
            }
          : {}),
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
        padding: '24px',
        background: 'rgba(13, 11, 19, 0.86)',
        backdropFilter: 'blur(18px)',
      }}
    >
      <form
        onSubmit={handleComplete}
        className="ashy-settings-card"
        style={{
          width: 'min(560px, 100%)',
          padding: '28px 30px',
          borderRadius: '20px',
          background: 'linear-gradient(165deg, #1f1b2c 0%, #15131f 100%)',
          border: '1px solid rgba(244, 166, 136, 0.32)',
          boxShadow: '0 28px 72px rgba(0, 0, 0, 0.72)',
          display: 'flex',
          flexDirection: 'column',
          gap: '18px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="ashy-badge peach">
            <Sparkles size={12} style={{ marginRight: '5px' }} />
            Fase 0 • Primeiro Encontro
          </span>
          <span className="ashy-badge violet">Cozy Night Studio</span>
        </div>

        <div>
          <h2 id="first-meeting-title" className="ashy-serif-title" style={{ fontSize: '30px' }}>
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
                maxHeight: '110px',
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
