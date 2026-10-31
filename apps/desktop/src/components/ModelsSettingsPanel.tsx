import React, { useEffect, useState } from 'react'
import {
  FALLBACK_PROVIDER_MODELS,
  LLM_PROVIDER_IDS,
  type LlmProviderId,
  type ProviderHealthResult,
  type ReasoningEffort,
} from '@ashy/shared'
import { Box, CheckCircle2, KeyRound, RefreshCw, Save, Search, Trash2, Wifi } from 'lucide-react'
import { useAshyStore } from '../store/useAshyStore'

export const REASONING_EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'none', label: 'Desativado (Resposta Imediata)' },
  { value: 'minimal', label: 'Mínimo' },
  { value: 'low', label: 'Baixo' },
  { value: 'medium', label: 'Médio' },
  { value: 'high', label: 'Alto (Raciocínio Profundo)' },
]

export function ModelsSettingsPanel(): React.ReactElement {
  const providers = useAshyStore((s) => s.providers)
  const providerModelCatalog = useAshyStore((s) => s.providerModelCatalog)
  const providerModelCatalogSource = useAshyStore((s) => s.providerModelCatalogSource)
  const isLoadingProviderModels = useAshyStore((s) => s.isLoadingProviderModels)
  const saveProviderConfig = useAshyStore((s) => s.saveProviderConfig)
  const setActiveProvider = useAshyStore((s) => s.setActiveProvider)
  const testProviderConnection = useAshyStore((s) => s.testProviderConnection)
  const listProviderModels = useAshyStore((s) => s.listProviderModels)
  const unifiedOmniMode = useAshyStore((s) => s.unifiedOmniMode)
  const setUnifiedOmniMode = useAshyStore((s) => s.setUnifiedOmniMode)
  const applyOmniModelPreset = useAshyStore((s) => s.applyOmniModelPreset)

  const [selectedProvider, setSelectedProvider] = useState<LlmProviderId>(
    providers.activeProviderId ?? 'openrouter',
  )

  const currentConfig = providers.configs[selectedProvider]

  const [baseUrl, setBaseUrl] = useState(currentConfig?.baseUrl ?? '')
  const [modelId, setModelId] = useState(currentConfig?.modelId ?? '')
  const [modelSearchQuery, setModelSearchQuery] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    currentConfig?.reasoningEffort ?? 'none',
  )
  const [apiKey, setApiKey] = useState('')
  const [testResult, setTestResult] = useState<ProviderHealthResult | null>(null)
  const [isTesting, setIsTesting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)

  useEffect(() => {
    const cfg = providers.configs[selectedProvider]
    if (cfg) {
      setBaseUrl(cfg.baseUrl)
      setModelId(cfg.modelId)
      setReasoningEffort(cfg.reasoningEffort ?? 'none')
    }
  }, [
    selectedProvider,
    currentConfig?.baseUrl,
    currentConfig?.modelId,
    currentConfig?.reasoningEffort,
  ])

  useEffect(() => {
    void listProviderModels({ providerId: selectedProvider })
  }, [selectedProvider, listProviderModels])

  const catalogModels =
    providerModelCatalog[selectedProvider] ?? FALLBACK_PROVIDER_MODELS[selectedProvider] ?? []
  const catalogSource = providerModelCatalogSource[selectedProvider] ?? 'fallback'
  const normalizedSearch = modelSearchQuery.trim().toLowerCase()
  const filteredCatalogModels = (
    normalizedSearch
      ? catalogModels.filter(
          (m) =>
            m.id.toLowerCase().includes(normalizedSearch) ||
            m.name.toLowerCase().includes(normalizedSearch),
        )
      : catalogModels
  ).slice(0, 60)

  const handleRefreshCatalog = async () => {
    const trimmedKey = apiKey.trim()
    await listProviderModels({
      providerId: selectedProvider,
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(trimmedKey ? { apiKey: trimmedKey } : {}),
    })
  }

  const handleSelectProvider = (providerId: LlmProviderId) => {
    setSelectedProvider(providerId)
    const cfg = providers.configs[providerId]
    if (cfg) {
      setBaseUrl(cfg.baseUrl)
      setModelId(cfg.modelId)
      setReasoningEffort(cfg.reasoningEffort ?? 'none')
    }
    setModelSearchQuery('')
    setApiKey('')
    setTestResult(null)
    setSavedNotice(null)
  }

  const handleSaveProvider = async () => {
    setIsSaving(true)
    setSavedNotice(null)
    setTestResult(null)
    try {
      const trimmedKey = apiKey.trim()
      await saveProviderConfig({
        providerId: selectedProvider,
        baseUrl: baseUrl.trim() || currentConfig.baseUrl,
        modelId: modelId.trim() || currentConfig.modelId,
        reasoningEffort,
        ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
      })
      await setActiveProvider(selectedProvider)
      setApiKey('')
      setSavedNotice('Configuração salva e ativada ✓')
    } catch (err) {
      setSavedNotice(`Erro: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsSaving(false)
    }
  }

  const handleClearKey = async () => {
    setIsSaving(true)
    setSavedNotice(null)
    setTestResult(null)
    try {
      await saveProviderConfig({
        providerId: selectedProvider,
        baseUrl: baseUrl.trim() || currentConfig.baseUrl,
        modelId: modelId.trim() || currentConfig.modelId,
        reasoningEffort,
        clearApiKey: true,
      })
      setApiKey('')
      setSavedNotice('Chave removida ✓')
    } catch (err) {
      setSavedNotice(`Erro: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsSaving(false)
    }
  }

  const handleTestConnection = async () => {
    setIsTesting(true)
    setSavedNotice(null)
    try {
      const trimmedKey = apiKey.trim()
      const res = await testProviderConnection({
        providerId: selectedProvider,
        baseUrl: baseUrl.trim() || currentConfig.baseUrl,
        modelId: modelId.trim() || currentConfig.modelId,
        reasoningEffort,
        ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
      })
      setTestResult(res)
    } catch (err) {
      setTestResult({
        providerId: selectedProvider,
        ok: false,
        latencyMs: 0,
        modelId: modelId.trim() || currentConfig.modelId,
        verifiedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsTesting(false)
    }
  }

  return (
    <section
      className="ashy-settings-card"
      data-testid="models-settings-panel"
      style={{ gap: '14px' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          flexWrap: 'wrap',
        }}
      >
        <div className="ashy-settings-section-head">
          <div className="ashy-settings-section-icon">
            <Box size={20} />
          </div>
          <div>
            <h3 className="ashy-setting-title">Modelos & Provedores LLM (Cofre Seguro)</h3>
            <p className="ashy-setting-desc">
              Configure OpenRouter, Anthropic, OpenAI, NVIDIA NIM ou Ollama local. Suas chaves
              ficam criptografadas no host.
            </p>
          </div>
        </div>

        <span
          data-testid="provider-diagnostics-badge"
          className={`ashy-badge ${
            providers.diagnostics.status === 'ok' ? 'emerald' : 'amber'
          }`}
        >
          Vault: {providers.diagnostics.status}
        </span>
      </div>

      {/* Phase 8.7 Unified Omni Model Card (LFM3-Omni-2B Local & Cloud) */}
      <div
        className="ashy-setting-box"
        data-testid="unified-omni-settings-card"
        style={{
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: '10px',
          borderColor: unifiedOmniMode ? 'var(--accent-peach)' : 'var(--border-subtle)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="ashy-setting-title">
                Modelo Omni Unificado (Voz, Texto, Imagem e Vídeo)
              </span>
              <span className={`ashy-badge ${unifiedOmniMode ? 'peach' : 'neutral'}`}>
                {unifiedOmniMode ? 'Omni Nativo Ativo' : 'Pipeline Separado'}
              </span>
            </div>
            <p className="ashy-setting-desc" style={{ margin: '2px 0 0 0' }}>
              Um único modelo processa voz 16kHz, texto, imagens e frames de vídeo 2fps, gerando
              fala 24kHz e tags de atuação diretamente.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={unifiedOmniMode}
            data-testid="toggle-unified-omni-mode"
            className={`ashy-switch ${unifiedOmniMode ? 'checked' : ''}`}
            onClick={() => setUnifiedOmniMode(!unifiedOmniMode)}
          />
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="ashy-outline-btn"
            data-testid="preset-omni-lfm3-local"
            onClick={() => {
              applyOmniModelPreset('lfm3-omni-2b')
              setSelectedProvider('ollama')
              setModelId('lfm3-omni:2b')
            }}
          >
            ⚡ LFM3-Omni-2B (Local Ollama)
          </button>
          <button
            type="button"
            className="ashy-outline-btn"
            data-testid="preset-omni-gpt4o"
            onClick={() => {
              applyOmniModelPreset('gpt-4o-audio')
              setSelectedProvider('openai')
              setModelId('gpt-4o-audio-preview')
            }}
          >
            ☁️ GPT-4o Audio (OpenAI)
          </button>
          <button
            type="button"
            className="ashy-outline-btn"
            data-testid="preset-omni-qwen"
            onClick={() => {
              applyOmniModelPreset('qwen2.5-omni')
              setSelectedProvider('openrouter')
              setModelId('qwen/qwen2.5-omni-7b')
            }}
          >
             🌐 Qwen 2.5 Omni 7B (OpenRouter)
          </button>
          <button
            type="button"
            className="ashy-outline-btn"
            data-testid="preset-omni-gemini"
            onClick={() => {
              applyOmniModelPreset('gemini-2.5-flash')
              setSelectedProvider('openrouter')
              setModelId('google/gemini-2.5-flash')
            }}
          >
            ✨ Gemini 2.5 Flash (Google)
          </button>
        </div>
      </div>

      {/* 5 Provider Tabs */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {LLM_PROVIDER_IDS.map((id) => {
          const cfg = providers.configs[id]
          const isSelected = selectedProvider === id
          const isActive = providers.activeProviderId === id
          return (
            <button
              key={id}
              type="button"
              data-testid={`provider-tab-${id}`}
              className={`ashy-filter-pill ${isSelected ? 'active' : ''}`}
              onClick={() => handleSelectProvider(id)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <span>{cfg?.label ?? id}</span>
              {isActive && (
                <CheckCircle2
                  size={13}
                  style={{ color: 'var(--status-emerald)' }}
                  aria-label="Provedor ativo"
                />
              )}
            </button>
          )
        })}
      </div>

      {/* Selected Provider Form */}
      <div
        style={{
          padding: '14px',
          borderRadius: '12px',
          background: '#171421',
          border: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <KeyRound size={15} style={{ color: 'var(--accent-peach)' }} />
            <strong style={{ fontSize: '13.5px' }}>{currentConfig?.label}</strong>
            {providers.activeProviderId === selectedProvider && (
              <span className="ashy-badge emerald">Ativo</span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              data-testid="provider-masked-key"
              className={`ashy-badge ${
                currentConfig?.hasApiKey || !currentConfig?.requiresApiKey ? 'peach' : 'violet'
              }`}
            >
              {currentConfig?.hasApiKey && currentConfig.maskedApiKey
                ? `Chave: ${currentConfig.maskedApiKey}`
                : currentConfig?.requiresApiKey
                  ? 'Sem chave configurada'
                  : 'Local (sem chave)'}
            </span>

            {currentConfig?.hasApiKey && (
              <button
                type="button"
                data-testid="clear-provider-key-btn"
                className="ashy-danger-outline-btn"
                style={{ padding: '4px 9px', fontSize: '11px' }}
                disabled={isSaving}
                onClick={() => void handleClearKey()}
              >
                <Trash2 size={12} />
                <span>Remover chave</span>
              </button>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '220px' }}>
            <label
              htmlFor="provider-base-url-input"
              style={{
                display: 'block',
                fontSize: '11.5px',
                color: 'var(--text-secondary)',
                marginBottom: '4px',
              }}
            >
              Base URL
            </label>
            <input
              id="provider-base-url-input"
              data-testid="provider-base-url-input"
              type="text"
              className="ashy-input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          <div style={{ flex: 1, minWidth: '200px' }}>
            <label
              htmlFor="provider-model-id-input"
              style={{
                display: 'block',
                fontSize: '11.5px',
                color: 'var(--text-secondary)',
                marginBottom: '4px',
              }}
            >
              Model ID
            </label>
            <input
              id="provider-model-id-input"
              data-testid="provider-model-id-input"
              type="text"
              className="ashy-input"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
            />
          </div>

          <div style={{ flex: 1, minWidth: '210px' }}>
            <label
              htmlFor="provider-reasoning-effort-select"
              style={{
                display: 'block',
                fontSize: '11.5px',
                color: 'var(--text-secondary)',
                marginBottom: '4px',
              }}
            >
              Raciocínio (Thinking Effort)
            </label>
            <select
              id="provider-reasoning-effort-select"
              data-testid="provider-reasoning-effort-select"
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

        {/* Provider Model Catalog Search & Interactive Selector */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '10px 12px',
            borderRadius: '10px',
            background: '#12101b',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
              <Search size={14} style={{ color: 'var(--text-muted)' }} />
              <input
                type="text"
                data-testid="provider-model-search-input"
                className="ashy-input"
                style={{ padding: '6px 10px', fontSize: '12px' }}
                placeholder={`Buscar modelos em ${currentConfig?.label ?? selectedProvider} (ex.: qwen, deepseek, claude)...`}
                value={modelSearchQuery}
                onChange={(e) => setModelSearchQuery(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span
                data-testid="provider-catalog-source-badge"
                className={`ashy-badge ${catalogSource === 'remote' ? 'emerald' : 'neutral'}`}
              >
                {catalogSource === 'remote' ? 'Catálogo da API' : 'Catálogo sugerido'} (
                {catalogModels.length})
              </span>
              <button
                type="button"
                data-testid="refresh-provider-models-btn"
                className="ashy-outline-btn"
                style={{ padding: '5px 10px', fontSize: '11.5px' }}
                disabled={isLoadingProviderModels}
                onClick={() => void handleRefreshCatalog()}
              >
                <RefreshCw size={12} />
                <span>{isLoadingProviderModels ? 'Buscando...' : 'Buscar Modelos na API'}</span>
              </button>
            </div>
          </div>

          <div
            data-testid="provider-model-catalog-list"
            style={{
              display: 'flex',
              gap: '6px',
              flexWrap: 'wrap',
              maxHeight: '148px',
              overflowY: 'auto',
              paddingTop: '2px',
            }}
          >
            {filteredCatalogModels.length === 0 ? (
              <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                Nenhum modelo encontrado no catálogo para &ldquo;{modelSearchQuery}&rdquo;. Você pode
                digitar qualquer Model ID manualmente no campo acima.
              </span>
            ) : (
              filteredCatalogModels.map((m) => {
                const isPicked = modelId.trim() === m.id
                return (
                  <button
                    key={m.id}
                    type="button"
                    data-testid={`provider-model-option-${m.id}`}
                    className={`ashy-filter-pill ${isPicked ? 'active' : ''}`}
                    style={{
                      padding: '4px 10px',
                      fontSize: '11.5px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                    onClick={() => setModelId(m.id)}
                    title={`${m.name} (${m.id})`}
                  >
                    <span>{m.id}</span>
                    {m.supportsReasoning && (
                      <span
                        style={{
                          fontSize: '9.5px',
                          opacity: 0.75,
                          color: 'var(--accent-peach)',
                        }}
                      >
                        • Thinking
                      </span>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </div>

        <div>
          <label
            htmlFor="provider-api-key-input"
            style={{
              display: 'block',
              fontSize: '11.5px',
              color: 'var(--text-secondary)',
              marginBottom: '4px',
            }}
          >
            {currentConfig?.hasApiKey
              ? 'Nova chave de API (deixe em branco para manter a atual)'
              : 'Chave de API'}
          </label>
          <input
            id="provider-api-key-input"
            data-testid="provider-api-key-input"
            type="password"
            autoComplete="off"
            className="ashy-input"
            placeholder={
              currentConfig?.hasApiKey
                ? `Atual: ${currentConfig.maskedApiKey ?? '••••'}`
                : currentConfig?.requiresApiKey
                  ? 'Digite a chave secreta deste provedor...'
                  : 'Opcional para Ollama local'
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
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              data-testid="save-provider-btn"
              className="ashy-peach-btn"
              disabled={isSaving}
              onClick={() => void handleSaveProvider()}
            >
              <Save size={14} />
              <span>{isSaving ? 'Salvando...' : 'Salvar Modelo'}</span>
            </button>

            <button
              type="button"
              data-testid="test-provider-btn"
              className="ashy-outline-btn"
              disabled={isTesting}
              onClick={() => void handleTestConnection()}
            >
              <Wifi size={14} />
              <span>{isTesting ? 'Testando...' : 'Testar Conexão'}</span>
            </button>
          </div>

          <div
            data-testid="provider-test-status"
            style={{ fontSize: '12px', color: 'var(--text-secondary)' }}
          >
            {testResult ? (
              <span className={`ashy-badge ${testResult.ok ? 'emerald' : 'amber'}`}>
                {testResult.ok
                  ? `Conectado (${testResult.latencyMs}ms) • ${testResult.modelId}`
                  : `Erro: ${testResult.error ?? 'Falha na verificação'}`}
              </span>
            ) : savedNotice ? (
              <span
                className={`ashy-badge ${savedNotice.startsWith('Erro:') ? 'amber' : 'emerald'}`}
              >
                {savedNotice}
              </span>
            ) : currentConfig?.lastError ? (
              <span className="ashy-badge amber">Último erro: {currentConfig.lastError}</span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}
