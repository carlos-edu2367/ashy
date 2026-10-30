// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AshyBootstrapSnapshot,
  AshyHostBridge,
  AshyHostStreamEvent,
} from '@ashy/shared'
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

function getByTestId<T extends HTMLElement = HTMLElement>(testId: string): T {
  const el = container?.querySelector(`[data-testid="${testId}"]`) as T | null
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
      id: 'session-p81',
      title: 'Sessão 8.1',
      startedAt: now,
      updatedAt: now,
      turnCount: 0,
      lastMessagePreview: '',
    },
    sessions: [
      {
        id: 'session-p81',
        title: 'Sessão 8.1',
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

describe('Phase 8.1 — Optimistic Chat Message Insertion & Reasoning Effort UI Selector', () => {
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

  it('inserts user message optimistically before sendTurn resolves and guarantees user bubble precedes assistant bubble even if turn:started arrives first', async () => {
    const snap = createBaseSnapshot()
    let emitHostEvent: (ev: AshyHostStreamEvent) => void = () => {}
    let resolveSendTurn: (val: {
      turnId: string
      userMessage: AshyBootstrapSnapshot['messages'][number]
    }) => void = () => {}

    const mockBridge = {
      getBootstrapSnapshot: vi.fn(async () => snap),
      onHostEvent: vi.fn((listener: (ev: AshyHostStreamEvent) => void) => {
        emitHostEvent = listener
        return () => {
          emitHostEvent = () => {}
        }
      }),
      sendTurn: vi.fn(
        () =>
          new Promise<{
            turnId: string
            userMessage: AshyBootstrapSnapshot['messages'][number]
          }>((resolve) => {
            resolveSendTurn = resolve
          }),
      ),
    } as unknown as AshyHostBridge

    setAshyHostBridgeForTesting(mockBridge)
    await useAshyStore.getState().bootstrapFromHost()
    useAshyStore.setState({ chatMessages: [] })

    const sendPromise = useAshyStore.getState().sendUserMessage('Oi Ashy, tudo bem?')

    // Immediately after calling sendUserMessage (before sendTurn resolves!), the user message MUST already be in chatMessages
    const immediateMessages = useAshyStore.getState().chatMessages
    expect(immediateMessages.length).toBe(1)
    expect(immediateMessages[0]?.role).toBe('user')
    expect(immediateMessages[0]?.content).toBe('Oi Ashy, tudo bem?')

    // Now simulate SSE turn:started arriving BEFORE the HTTP POST sendTurn response resolves!
    const now = Date.now()
    emitHostEvent({
      type: 'turn:started',
      turnId: 'turn-race-1',
      sessionId: 'session-p81',
      startedAt: now,
    })

    // Resolve sendTurn after turn:started
    resolveSendTurn({
      turnId: 'turn-race-1',
      userMessage: {
        id: 'msg-user-turn-race-1',
        sessionId: 'session-p81',
        role: 'user',
        content: 'Oi Ashy, tudo bem?',
        rawContent: 'Oi Ashy, tudo bem?',
        emotion: 'neutral',
        markersJson: '[]',
        createdAt: now,
      },
    })

    emitHostEvent({
      type: 'turn:delta',
      turnId: 'turn-race-1',
      sessionId: 'session-p81',
      textDelta: 'Tudo ótimo por aqui!',
    })

    const assistantMsg = {
      id: 'msg-assistant-turn-race-1',
      sessionId: 'session-p81',
      role: 'assistant' as const,
      content: 'Tudo ótimo por aqui!',
      rawContent: 'Tudo ótimo por aqui!',
      emotion: 'happy' as const,
      markersJson: '[]',
      createdAt: now + 10,
    }
    emitHostEvent({
      type: 'turn:completed',
      turnId: 'turn-race-1',
      sessionId: 'session-p81',
      assistantMessage: assistantMsg,
      snapshot: {
        ...snap,
        messages: [
          {
            id: 'msg-user-turn-race-1',
            sessionId: 'session-p81',
            role: 'user',
            content: 'Oi Ashy, tudo bem?',
            rawContent: 'Oi Ashy, tudo bem?',
            emotion: 'neutral',
            markersJson: '[]',
            createdAt: now,
          },
          assistantMsg,
        ],
      },
      persistenceWarning: null,
    })

    await sendPromise

    const finalMessages = useAshyStore.getState().chatMessages
    expect(finalMessages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(finalMessages[0]?.id).toBe('msg-user-turn-race-1')
    expect(finalMessages[1]?.id).toBe('msg-assistant-turn-race-1')
  })

  it('renders reasoningEffort selector in ModelsSettingsPanel with default "none" and passes selected reasoningEffort to saveProviderConfig', async () => {
    const snap = createBaseSnapshot()
    const saveProviderConfigSpy = vi.fn(async (input) => {
      const updated = {
        ...snap.providers.configs.openrouter,
        ...input,
      }
      return {
        updated,
        providers: {
          ...snap.providers,
          configs: {
            ...snap.providers.configs,
            openrouter: updated,
          },
        },
      }
    })
    const setActiveProviderSpy = vi.fn(async () => snap.providers)

    const mockBridge = {
      getBootstrapSnapshot: vi.fn(async () => snap),
      onHostEvent: vi.fn(() => () => {}),
      saveProviderConfig: saveProviderConfigSpy,
      setActiveProvider: setActiveProviderSpy,
    } as unknown as AshyHostBridge

    setAshyHostBridgeForTesting(mockBridge)
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root?.render(<ModelsSettingsPanel />)
    })

    const effortSelect = getByTestId<HTMLSelectElement>('provider-reasoning-effort-select')
    expect(effortSelect.value).toBe('none')

    await act(async () => {
      setNativeInputValue(effortSelect, 'low')
    })
    expect(effortSelect.value).toBe('low')

    await act(async () => {
      clickElement(getByTestId('save-provider-btn'))
    })

    await vi.waitFor(() => {
      expect(saveProviderConfigSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'openrouter',
          modelId: 'qwen/qwen3.8-flash',
          reasoningEffort: 'low',
        }),
      )
    })
  })

  it('[Adversarial] rolls back optimistic user bubble if sendTurn fails on the host bridge', async () => {
    const snap = createBaseSnapshot()
    const mockBridge = {
      getBootstrapSnapshot: vi.fn(async () => snap),
      onHostEvent: vi.fn(() => () => {}),
      sendTurn: vi.fn(async () => {
        throw new Error('Host IPC disconnected')
      }),
    } as unknown as AshyHostBridge

    setAshyHostBridgeForTesting(mockBridge)
    await useAshyStore.getState().bootstrapFromHost()
    useAshyStore.setState({ chatMessages: [] })

    await expect(
      useAshyStore.getState().sendUserMessage('Mensagem que vai falhar'),
    ).rejects.toThrow('Host IPC disconnected')

    expect(useAshyStore.getState().chatMessages).toEqual([])
  })

  it('[Red-Team] preserves unsaved modelId and reasoningEffort in ModelsSettingsPanel when Testar Conexão refreshes providers snapshot, and removes empty ghost assistant bubble on turn:aborted', async () => {
    const snap = createBaseSnapshot()
    let emitHostEvent: (ev: AshyHostStreamEvent) => void = () => {}

    const mockBridge = {
      getBootstrapSnapshot: vi.fn(async () => ({
        ...snap,
        providers: {
          ...snap.providers,
          configs: {
            ...snap.providers.configs,
            openrouter: {
              ...snap.providers.configs.openrouter,
              lastVerifiedAt: Date.now() + 5000,
            },
          },
        },
      })),
      onHostEvent: vi.fn((listener: (ev: AshyHostStreamEvent) => void) => {
        emitHostEvent = listener
        return () => {
          emitHostEvent = () => {}
        }
      }),
      testProviderConnection: vi.fn(async (input) => ({
        ok: true,
        providerId: input.providerId,
        modelId: input.modelId ?? 'deepseek/deepseek-chat',
        latencyMs: 42,
        verifiedAt: Date.now(),
      })),
    } as unknown as AshyHostBridge

    setAshyHostBridgeForTesting(mockBridge)
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root?.render(<ModelsSettingsPanel />)
    })

    const modelInput = getByTestId<HTMLInputElement>('provider-model-id-input')
    const effortSelect = getByTestId<HTMLSelectElement>('provider-reasoning-effort-select')

    // Edit modelId and reasoningEffort without clicking Save yet
    await act(async () => {
      setNativeInputValue(modelInput, 'deepseek/deepseek-chat-v3')
      setNativeInputValue(effortSelect, 'medium')
    })
    expect(modelInput.value).toBe('deepseek/deepseek-chat-v3')
    expect(effortSelect.value).toBe('medium')

    // Click Testar Conexão (which triggers getBootstrapSnapshot() with a new providers.configs object reference)
    await act(async () => {
      clickElement(getByTestId('test-provider-btn'))
    })

    // Unsaved edits must NOT be clobbered back to qwen/qwen3.8-flash and none!
    expect(modelInput.value).toBe('deepseek/deepseek-chat-v3')
    expect(effortSelect.value).toBe('medium')

    // Now simulate turn:started followed immediately by turn:aborted with empty partialText
    useAshyStore.setState({ chatMessages: [] })
    emitHostEvent({
      type: 'turn:started',
      turnId: 'turn-abort-empty',
      sessionId: 'session-p81',
      startedAt: Date.now(),
    })
    expect(useAshyStore.getState().chatMessages.length).toBe(1)

    emitHostEvent({
      type: 'turn:aborted',
      turnId: 'turn-abort-empty',
      sessionId: 'session-p81',
      partialText: '',
    })
    // Empty ghost assistant bubble must be removed!
    expect(useAshyStore.getState().chatMessages).toEqual([])
  })
})
