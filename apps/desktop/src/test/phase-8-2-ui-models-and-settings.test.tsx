// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AshyBootstrapSnapshot,
  AshyHostBridge,
  ListProviderModelsInput,
  ListProviderModelsResult,
  LlmProviderId,
  SaveProviderConfigInput,
} from '@ashy/shared'
import { App } from '../App'
import { FirstMeetingWizard } from '../components/FirstMeetingWizard'
import { ModelsSettingsPanel } from '../components/ModelsSettingsPanel'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

function setNativeInputValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  if (descriptor?.set) {
    descriptor.set.call(element, value)
  } else {
    element.value = value
  }
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function clickElement(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function queryByTestId<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return (container?.querySelector(`[data-testid="${testId}"]`) as T | null) ?? null
}

function getByTestId<T extends HTMLElement = HTMLElement>(testId: string): T {
  const el = queryByTestId<T>(testId)
  if (!el) {
    throw new Error(`Unable to find an element by: [data-testid="${testId}"]`)
  }
  return el
}

function createBaseSnapshot(): AshyBootstrapSnapshot {
  const now = Date.now()
  return {
    needsOnboarding: false,
    userProfile: { userName: 'Carlos', userPronouns: 'ele/dele' },
    relationship: {
      stage: 'close_friend',
      familiarityScore: 0.6,
      trustScore: 0.7,
      totalTurns: 18,
      milestones: [],
    },
    affect: {
      mood: { valence: 0.25, arousal: 0.15, playfulness: 0.2 },
      traits: {
        warmthAffection: 0.7,
        witSarcasm: 0.65,
        intellectualCuriosity: 0.75,
        chaosEnergy: 0.5,
        proactivity: 0.55,
      },
      dominantEmotion: 'neutral',
    },
    activeSession: {
      id: 'session-p82',
      title: 'Sessão 8.2',
      startedAt: now,
      updatedAt: now,
      turnCount: 0,
      lastMessagePreview: '',
    },
    sessions: [
      {
        id: 'session-p82',
        title: 'Sessão 8.2',
        startedAt: now,
        updatedAt: now,
        turnCount: 0,
        lastMessagePreview: '',
      },
    ],
    messages: [],
    memories: { facts: [], episodes: [], jokes: [] },
    voice: {
      content: '# Ashy Voice',
      diagnostics: { status: 'ok', updatedAt: now },
      updatedAt: now,
    },
    providers: {
      activeProviderId: 'openrouter',
      hasActiveReadyProvider: true,
      diagnostics: { status: 'ok', updatedAt: now },
      configs: {
        openrouter: {
          providerId: 'openrouter',
          label: 'OpenRouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          modelId: 'qwen/qwen3.8-flash',
          reasoningEffort: 'none',
          requiresApiKey: true,
          hasApiKey: true,
          maskedApiKey: 'sk-or-...dc43',
          lastVerifiedAt: now,
          lastError: null,
        },
        anthropic: {
          providerId: 'anthropic',
          label: 'Anthropic',
          baseUrl: 'https://api.anthropic.com/v1',
          modelId: 'claude-3-7-sonnet-latest',
          reasoningEffort: 'none',
          requiresApiKey: true,
          hasApiKey: false,
          maskedApiKey: null,
          lastVerifiedAt: null,
          lastError: null,
        },
        openai: {
          providerId: 'openai',
          label: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          modelId: 'gpt-4o-mini',
          reasoningEffort: 'none',
          requiresApiKey: true,
          hasApiKey: false,
          maskedApiKey: null,
          lastVerifiedAt: null,
          lastError: null,
        },
        'nvidia-nim': {
          providerId: 'nvidia-nim',
          label: 'NVIDIA NIM',
          baseUrl: 'https://integrate.api.nvidia.com/v1',
          modelId: 'meta/llama-3.3-70b-instruct',
          reasoningEffort: 'none',
          requiresApiKey: true,
          hasApiKey: false,
          maskedApiKey: null,
          lastVerifiedAt: null,
          lastError: null,
        },
        ollama: {
          providerId: 'ollama',
          label: 'Ollama (Local)',
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelId: 'qwen2.5:14b',
          reasoningEffort: 'none',
          requiresApiKey: false,
          hasApiKey: false,
          maskedApiKey: null,
          lastVerifiedAt: null,
          lastError: null,
        },
      },
    },
    runtimeDiagnostics: {
      dbMode: 'wal',
      dbPath: '/tmp/ashy.db',
      lastPersistenceWarning: null,
    },
  }
}

describe('Phase 8.2 — Universal activeModelId Sync, Provider Models Catalog Search & Settings Sub-tabs Filtering', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
      root = null
    }
    if (container) {
      container.remove()
      container = null
    }
    setAshyHostBridgeForTesting(null)
    resetAshyStore()
  })

  it('1. synchronizes activeModelId with ProviderVault on bootstrapFromHost, saveProviderConfig, and setActiveProvider', async () => {
    const snap = createBaseSnapshot()

    const mockBridge = {
      getBootstrapSnapshot: vi.fn(async () => snap),
      onHostEvent: vi.fn(() => () => {}),
      saveProviderConfig: vi.fn(async (input: SaveProviderConfigInput) => {
        const updated = {
          ...snap.providers.configs[input.providerId],
          ...input,
        }
        const nextProviders = {
          ...snap.providers,
          configs: {
            ...snap.providers.configs,
            [input.providerId]: updated,
          },
        }
        return {
          config: updated,
          providers: nextProviders,
        }
      }),
      setActiveProvider: vi.fn(async (providerId: LlmProviderId) => ({
        ...snap.providers,
        activeProviderId: providerId,
      })),
    } as unknown as AshyHostBridge

    setAshyHostBridgeForTesting(mockBridge)

    await useAshyStore.getState().bootstrapFromHost()
    expect(useAshyStore.getState().activeModelId).toBe('qwen/qwen3.8-flash')
    expect(useAshyStore.getState().lastPrompt.modelId).toBe('qwen/qwen3.8-flash')

    await useAshyStore.getState().saveProviderConfig({
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'deepseek/deepseek-chat-v3-0324',
    })
    expect(useAshyStore.getState().activeModelId).toBe('deepseek/deepseek-chat-v3-0324')
    expect(useAshyStore.getState().lastPrompt.modelId).toBe('deepseek/deepseek-chat-v3-0324')

    await useAshyStore.getState().setActiveProvider('ollama')
    expect(useAshyStore.getState().activeModelId).toBe('qwen2.5:14b')
    expect(useAshyStore.getState().lastPrompt.modelId).toBe('qwen2.5:14b')
  })

  it('2. renders model search input, refresh button, and interactive catalog list in ModelsSettingsPanel', async () => {
    const snap = createBaseSnapshot()
    const listModelsSpy = vi.fn(
      async (input: ListProviderModelsInput): Promise<ListProviderModelsResult> => ({
        providerId: input.providerId,
        source: 'remote',
        fetchedAt: Date.now(),
        error: null,
        models: [
          {
            id: 'qwen/qwen3.8-flash',
            name: 'Qwen 3.8 Flash',
            providerId: input.providerId,
            contextLength: 131072,
            supportsTools: true,
            supportsReasoning: true,
          },
          {
            id: 'deepseek/deepseek-chat-v3-0324',
            name: 'DeepSeek Chat V3 (0324)',
            providerId: input.providerId,
            contextLength: 128000,
            supportsTools: true,
            supportsReasoning: false,
          },
        ],
      }),
    )

    const mockBridge = {
      getBootstrapSnapshot: vi.fn(async () => snap),
      onHostEvent: vi.fn(() => () => {}),
      listProviderModels: listModelsSpy,
    } as unknown as AshyHostBridge

    setAshyHostBridgeForTesting(mockBridge)
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root?.render(<ModelsSettingsPanel />)
    })

    const searchInput = getByTestId<HTMLInputElement>('provider-model-search-input')
    const refreshBtn = getByTestId<HTMLButtonElement>('refresh-provider-models-btn')
    const catalogList = getByTestId<HTMLElement>('provider-model-catalog-list')
    const modelInput = getByTestId<HTMLInputElement>('provider-model-id-input')

    expect(searchInput).toBeTruthy()
    expect(refreshBtn).toBeTruthy()
    expect(catalogList).toBeTruthy()
    expect(modelInput.value).toBe('qwen/qwen3.8-flash')

    await act(async () => {
      setNativeInputValue(searchInput, 'deepseek')
    })

    const deepseekOption = getByTestId('provider-model-option-deepseek/deepseek-chat-v3-0324')
    expect(deepseekOption).toBeTruthy()

    await act(async () => {
      clickElement(deepseekOption)
    })

    expect(modelInput.value).toBe('deepseek/deepseek-chat-v3-0324')

    await act(async () => {
      clickElement(refreshBtn)
    })
    expect(listModelsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openrouter' }),
    )
  })

  it('3. filters settings cards by sub-tab in App.tsx and shows saved confirmation badge on Salvar preferências', async () => {
    const snap = createBaseSnapshot()
    const mockBridge = {
      getBootstrapSnapshot: vi.fn(async () => snap),
      onHostEvent: vi.fn(() => () => {}),
    } as unknown as AshyHostBridge

    setAshyHostBridgeForTesting(mockBridge)
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root?.render(<App />)
    })

    await act(async () => {
      clickElement(getByTestId('tab-agency'))
    })

    // Default settingsSubTab === 'todas': both models panel and voice STT selector are visible
    expect(useAshyStore.getState().settingsSubTab).toBe('todas')
    expect(queryByTestId('models-settings-panel')).not.toBeNull()
    expect(queryByTestId('select-stt-provider')).not.toBeNull()

    // Click subtab-modelos -> models panel visible, voice STT selector NOT in DOM
    await act(async () => {
      clickElement(getByTestId('subtab-modelos'))
    })
    expect(useAshyStore.getState().settingsSubTab).toBe('modelos')
    expect(queryByTestId('models-settings-panel')).not.toBeNull()
    expect(queryByTestId('select-stt-provider')).toBeNull()

    // Click subtab-voz -> voice STT selector visible, models panel NOT in DOM
    await act(async () => {
      clickElement(getByTestId('subtab-voz'))
    })
    expect(useAshyStore.getState().settingsSubTab).toBe('voz')
    expect(queryByTestId('select-stt-provider')).not.toBeNull()
    expect(queryByTestId('models-settings-panel')).toBeNull()

    // Click active subtab-voz again -> returns to 'todas'
    await act(async () => {
      clickElement(getByTestId('subtab-voz'))
    })
    expect(useAshyStore.getState().settingsSubTab).toBe('todas')
    expect(queryByTestId('models-settings-panel')).not.toBeNull()
    expect(queryByTestId('select-stt-provider')).not.toBeNull()

    // Click Salvar preferências -> shows preferences-saved-badge
    await act(async () => {
      clickElement(getByTestId('btn-save-preferences'))
    })
    const badge = getByTestId('preferences-saved-badge')
    expect(badge.textContent).toContain('Preferências salvas')
  })

  it('4. [Adversarial] handles listProviderModels failure and out-of-order concurrent catalog responses without corrupting UI state', async () => {
    const snap = createBaseSnapshot()
    let resolveSlowFirstCall: (res: ListProviderModelsResult) => void = () => {}

    const listModelsSpy = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ListProviderModelsResult>((resolve) => {
            resolveSlowFirstCall = resolve
          }),
      )
      .mockImplementationOnce(async () => ({
        providerId: 'openrouter' as const,
        source: 'remote' as const,
        fetchedAt: Date.now(),
        error: null,
        models: [
          {
            id: 'qwen/qwen3.8-flash-fresh',
            name: 'Qwen 3.8 Flash Fresh',
            providerId: 'openrouter' as const,
          },
        ],
      }))
      .mockImplementationOnce(async () => {
        throw new Error('Network disconnected during catalog fetch')
      })

    const mockBridge = {
      getBootstrapSnapshot: vi.fn(async () => snap),
      onHostEvent: vi.fn(() => () => {}),
      listProviderModels: listModelsSpy,
    } as unknown as AshyHostBridge

    setAshyHostBridgeForTesting(mockBridge)
    await useAshyStore.getState().bootstrapFromHost()

    // Start slow call 1, then fast call 2 for openrouter
    const slowPromise = useAshyStore
      .getState()
      .listProviderModels({ providerId: 'openrouter' })
    const fastPromise = useAshyStore
      .getState()
      .listProviderModels({ providerId: 'openrouter' })

    await fastPromise
    expect(useAshyStore.getState().providerModelCatalog.openrouter?.[0]?.id).toBe(
      'qwen/qwen3.8-flash-fresh',
    )

    // Now resolve the stale first call — it MUST NOT overwrite the newer catalog!
    resolveSlowFirstCall({
      providerId: 'openrouter',
      source: 'remote',
      fetchedAt: Date.now() - 5000,
      error: null,
      models: [
        {
          id: 'stale/model-v0',
          name: 'Stale Model',
          providerId: 'openrouter',
        },
      ],
    })
    await slowPromise

    expect(useAshyStore.getState().providerModelCatalog.openrouter?.[0]?.id).toBe(
      'qwen/qwen3.8-flash-fresh',
    )
    expect(useAshyStore.getState().isLoadingProviderModels).toBe(false)

    // Third call throws -> gracefully falls back to FALLBACK_PROVIDER_MODELS
    const fallbackRes = await useAshyStore
      .getState()
      .listProviderModels({ providerId: 'ollama' })
    expect(fallbackRes.source).toBe('fallback')
    expect(fallbackRes.models.length).toBeGreaterThan(0)
  })

  it('5. [Red-Team #2, #3, #5, #8] supports FirstMeetingWizard catalog search/refresh, ready-only model cycling, duplicate modelId testid disambiguation, and localStorage preferences persistence', async () => {
    // Initial activeModelId before bootstrap must be 'anthropic/claude-3.7-sonnet'
    expect(useAshyStore.getState().activeModelId).toBe('anthropic/claude-3.7-sonnet')

    const snap = createBaseSnapshot()
    // Give anthropic the exact same modelId as openrouter to test duplicate testid disambiguation
    snap.providers.configs.anthropic.modelId = 'qwen/qwen3.8-flash'

    const listModelsSpy = vi.fn(
      async (input: ListProviderModelsInput): Promise<ListProviderModelsResult> => ({
        providerId: input.providerId,
        source: 'remote',
        fetchedAt: Date.now(),
        error: null,
        models: [
          {
            id: 'qwen/qwen3.8-flash',
            name: 'Qwen 3.8 Flash',
            providerId: input.providerId,
          },
          {
            id: 'google/gemini-2.5-flash',
            name: 'Gemini 2.5 Flash',
            providerId: input.providerId,
          },
        ],
      }),
    )

    const mockBridge = {
      getBootstrapSnapshot: vi.fn(async () => snap),
      onHostEvent: vi.fn(() => () => {}),
      listProviderModels: listModelsSpy,
      setActiveProvider: vi.fn(async (providerId: LlmProviderId) => ({
        ...snap.providers,
        activeProviderId: providerId,
      })),
    } as unknown as AshyHostBridge

    setAshyHostBridgeForTesting(mockBridge)
    await useAshyStore.getState().bootstrapFromHost()

    // Test FirstMeetingWizard search input, refresh button, and catalog list
    await act(async () => {
      root?.render(<FirstMeetingWizard />)
    })

    const wizSearch = getByTestId<HTMLInputElement>('onboarding-model-search-input')
    const wizRefresh = getByTestId<HTMLButtonElement>('wizard-refresh-models-btn')
    const wizList = getByTestId<HTMLElement>('onboarding-model-catalog-list')
    const wizModelInput = getByTestId<HTMLInputElement>('onboarding-model-id-input')

    expect(wizSearch).toBeTruthy()
    expect(wizRefresh).toBeTruthy()
    expect(wizList).toBeTruthy()

    await act(async () => {
      setNativeInputValue(wizSearch, 'gemini')
    })

    const geminiOpt = getByTestId('onboarding-model-option-google/gemini-2.5-flash')
    await act(async () => {
      clickElement(geminiOpt)
    })
    expect(wizModelInput.value).toBe('google/gemini-2.5-flash')

    await act(async () => {
      clickElement(wizRefresh)
    })
    expect(listModelsSpy).toHaveBeenCalled()

    // Now render App in settings tab and check duplicate modelId disambiguation & '(Requer chave)'
    await act(async () => {
      root?.render(<App />)
    })
    await act(async () => {
      clickElement(getByTestId('tab-agency'))
    })

    const firstSelectBtn = getByTestId('select-model-qwen/qwen3.8-flash')
    const secondSelectBtn = getByTestId('select-model-anthropic-qwen/qwen3.8-flash')
    expect(firstSelectBtn.getAttribute('data-provider-id')).toBe('openrouter')
    expect(secondSelectBtn.getAttribute('data-provider-id')).toBe('anthropic')
    expect(secondSelectBtn.textContent).toContain('(Requer chave)')

    // Save user preferences and check localStorage
    await act(async () => {
      clickElement(getByTestId('btn-save-preferences'))
    })
    const storedPrefsRaw = window.localStorage.getItem('ashy.userPreferences.v1')
    expect(storedPrefsRaw).toBeTruthy()
    const storedPrefs = JSON.parse(storedPrefsRaw!) as Record<string, unknown>
    expect(storedPrefs.quietHoursRange).toBe('22:00 — 08:00')
    expect(storedPrefs.showDesktopAvatar).toBe(true)
  })
})
