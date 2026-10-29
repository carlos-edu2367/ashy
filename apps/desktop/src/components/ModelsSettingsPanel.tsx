import React, { useEffect, useState } from 'react'
import { LLM_PROVIDER_IDS, type LlmProviderId, type ProviderHealthResult } from '@ashy/shared'
import { Box, CheckCircle2, KeyRound, Save, Trash2, Wifi } from 'lucide-react'
import { useAshyStore } from '../store/useAshyStore'

export function ModelsSettingsPanel(): React.ReactElement {
  const providers = useAshyStore((s) => s.providers)
  const saveProviderConfig = useAshyStore((s) => s.saveProviderConfig)
  const setActiveProvider = useAshyStore((s) => s.setActiveProvider)
  const testProviderConnection = useAshyStore((s) => s.testProviderConnection)

  const [selectedProvider, setSelectedProvider] = useState<LlmProviderId>(
    providers.activeProviderId ?? 'openrouter',
  )

  const currentConfig = providers.configs[selectedProvider]

  const [baseUrl, setBaseUrl] = useState(currentConfig?.baseUrl ?? '')
  const [modelId, setModelId] = useState(currentConfig?.modelId ?? '')
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
    }
  }, [selectedProvider, providers.configs])

  const handleSelectProvider = (providerId: LlmProviderId) => {
    setSelectedProvider(providerId)
    const cfg = providers.configs[providerId]
    if (cfg) {
      setBaseUrl(cfg.baseUrl)
      setModelId(cfg.modelId)
    }
    setApiKey('')
    setTestResult(null)
    setSavedNotice(null)
  }

  const handleSaveProvider = async () => {
    setIsSaving(true)
    setSavedNotice(null)
    try {
      const trimmedKey = apiKey.trim()
      await saveProviderConfig({
        providerId: selectedProvider,
        baseUrl: baseUrl.trim() || currentConfig.baseUrl,
        modelId: modelId.trim() || currentConfig.modelId,
        ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
      })
      await setActiveProvider(selectedProvider)
      setApiKey('')
      setSavedNotice('Configuração salva e ativada ✓')
    } finally {
      setIsSaving(false)
    }
  }

  const handleClearKey = async () => {
    setIsSaving(true)
    setSavedNotice(null)
    try {
      await saveProviderConfig({
        providerId: selectedProvider,
        baseUrl: baseUrl.trim() || currentConfig.baseUrl,
        modelId: modelId.trim() || currentConfig.modelId,
        clearApiKey: true,
      })
      setApiKey('')
      setSavedNotice('Chave removida ✓')
    } finally {
      setIsSaving(false)
    }
  }

  const handleTestConnection = async () => {
    setIsTesting(true)
    try {
      const trimmedKey = apiKey.trim()
      const res = await testProviderConnection({
        providerId: selectedProvider,
        baseUrl: baseUrl.trim() || currentConfig.baseUrl,
        modelId: modelId.trim() || currentConfig.modelId,
        ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
      })
      setTestResult(res)
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
              <span className="ashy-badge emerald">{savedNotice}</span>
            ) : currentConfig?.lastError ? (
              <span className="ashy-badge amber">Último erro: {currentConfig.lastError}</span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}
