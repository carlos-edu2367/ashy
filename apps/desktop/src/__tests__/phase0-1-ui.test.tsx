// @vitest-environment jsdom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAshyHostKernel } from '../host/kernel'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { App } from '../App'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'

// Enable React 19 act environment
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const tempDirs: string[] = []
const activeKernels: Array<{ stop(): Promise<void> }> = []
let container: HTMLDivElement | null = null
let root: Root | null = null

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-ui-p1-'))
  tempDirs.push(dir)
  return dir
}

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

function queryByTestId<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return (container?.querySelector(`[data-testid="${testId}"]`) as T | null) ?? null
}

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
  while (activeKernels.length > 0) {
    await activeKernels.pop()!.stop()
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Phase 0/1 UI — First-Meeting Wizard, Models Settings, Voice Identity & Real Streaming Chat', () => {
  it('1. shows First-Meeting Wizard on clean boot with zero fake memories, completes onboarding, masks API key, and streams real LLM turn into chat', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"<|ACT {\\"emotion\\":\\"smug\\",\\"intensity\\":0.8}|>"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Estúdio aceso, Carlos. Bora construir."}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    activeKernels.push(kernel)
    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()

    // Clean boot state must have zero fake memories and zero fake messages
    expect(useAshyStore.getState().memoryCards).toHaveLength(0)
    expect(useAshyStore.getState().chatMessages).toHaveLength(0)

    await act(async () => {
      root!.render(<App />)
    })

    // 1. Clean boot must show Phase 0 First-Meeting Wizard
    await vi.waitFor(() => {
      expect(getByTestId('first-meeting-wizard')).toBeTruthy()
    })

    await act(async () => {
      setNativeInputValue(getByTestId<HTMLInputElement>('onboarding-user-name-input'), 'Carlos')
      setNativeInputValue(
        getByTestId<HTMLSelectElement>('onboarding-pronouns-select'),
        'ele/dele',
      )
      setNativeInputValue(
        getByTestId<HTMLSelectElement>('onboarding-provider-select'),
        'openrouter',
      )
      setNativeInputValue(
        getByTestId<HTMLInputElement>('onboarding-api-key-input'),
        'sk-or-v1-livekey9999',
      )
    })

    await act(async () => {
      clickElement(getByTestId('onboarding-complete-btn'))
    })

    await vi.waitFor(() => {
      expect(queryByTestId('first-meeting-wizard')).toBeNull()
    })

    // Verify zero raw API key leakage in store state
    const serializedState = JSON.stringify(useAshyStore.getState())
    expect(serializedState).not.toContain('sk-or-v1-livekey9999')
    expect(
      useAshyStore.getState().providers.configs.openrouter.maskedApiKey,
    ).toBe('sk-or-...9999')

    // 2. Send a real message and verify streamed response from @ashy/llm
    await act(async () => {
      setNativeInputValue(
        getByTestId<HTMLTextAreaElement>('studio-chat-input'),
        'Oi Ashy, testando nosso fluxo real na Fase 1!',
      )
    })

    await act(async () => {
      clickElement(getByTestId('studio-send-btn'))
    })

    await vi.waitFor(() => {
      expect(container?.textContent).toContain('Estúdio aceso, Carlos. Bora construir.')
    })

    expect(useAshyStore.getState().stageEmotion).toBe('smug')
  })

  it('2. allows skipping provider setup during onboarding and surfaces PROVIDER_NOT_CONFIGURED recoverable notice on chat turn', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({
      userDataDir: dir,
    })
    activeKernels.push(kernel)
    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()

    await act(async () => {
      root!.render(<App />)
    })

    await vi.waitFor(() => {
      expect(getByTestId('first-meeting-wizard')).toBeTruthy()
    })

    await act(async () => {
      setNativeInputValue(getByTestId<HTMLInputElement>('onboarding-user-name-input'), 'Marina')
    })

    await act(async () => {
      clickElement(getByTestId('onboarding-skip-provider-btn'))
    })

    await vi.waitFor(() => {
      expect(queryByTestId('first-meeting-wizard')).toBeNull()
    })

    expect(useAshyStore.getState().userProfile.userName).toBe('Marina')
    expect(useAshyStore.getState().providers.hasActiveReadyProvider).toBe(false)

    await act(async () => {
      setNativeInputValue(
        getByTestId<HTMLTextAreaElement>('studio-chat-input'),
        'Oi Ashy, sem provedor configurado ainda.',
      )
    })

    await act(async () => {
      clickElement(getByTestId('studio-send-btn'))
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().lastTurnError?.code).toBe('PROVIDER_NOT_CONFIGURED')
    })
  })

  it('3. renders ModelsSettingsPanel in Ajustes > Modelos for all 5 providers and supports saving config & testing connection', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = 'data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n'
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })
    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()

    await act(async () => {
      root!.render(<App />)
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().needsOnboarding).toBe(false)
    })

    // Navigate to Ajustes -> Modelos
    await act(async () => {
      clickElement(getByTestId('tab-agency'))
    })
    await act(async () => {
      clickElement(getByTestId('subtab-modelos'))
    })

    const panel = getByTestId('models-settings-panel')
    expect(panel).toBeTruthy()

    // Select nvidia-nim tab
    await act(async () => {
      clickElement(getByTestId('provider-tab-nvidia-nim'))
    })

    await act(async () => {
      setNativeInputValue(
        getByTestId<HTMLInputElement>('provider-base-url-input'),
        'https://integrate.api.nvidia.com/v1',
      )
      setNativeInputValue(
        getByTestId<HTMLInputElement>('provider-model-id-input'),
        'meta/llama-3.3-70b-instruct',
      )
      setNativeInputValue(
        getByTestId<HTMLInputElement>('provider-api-key-input'),
        'nvapi-secretkey9876',
      )
    })

    await act(async () => {
      clickElement(getByTestId('save-provider-btn'))
    })

    await vi.waitFor(() => {
      expect(getByTestId('provider-masked-key').textContent).toContain('nvapi-...9876')
    })

    await act(async () => {
      clickElement(getByTestId('test-provider-btn'))
    })

    await vi.waitFor(() => {
      expect(getByTestId('provider-test-status').textContent).toMatch(/Conectado|ms/i)
    })

    // Adversarial: clear API key via clear-provider-key-btn
    await act(async () => {
      clickElement(getByTestId('clear-provider-key-btn'))
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().providers.configs['nvidia-nim'].hasApiKey).toBe(false)
    })
  })

  it('4. renders live voice.md editor in Alma tab connected to saveVoiceIdentity and resetVoiceIdentity with diagnostics', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })
    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()

    await act(async () => {
      root!.render(<App />)
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().needsOnboarding).toBe(false)
    })

    // Navigate to Alma (personality tab)
    await act(async () => {
      clickElement(getByTestId('tab-personality'))
    })

    const editor = getByTestId<HTMLTextAreaElement>('voice-identity-editor')
    expect(editor.value).toContain('Ashy — Voz & Identidade Viva')

    await act(async () => {
      setNativeInputValue(
        editor,
        '# Ashy Customizada\nSempre mencione café expresso duplo da madrugada.',
      )
    })

    await act(async () => {
      clickElement(getByTestId('save-voice-identity-btn'))
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().voiceIdentity.content).toContain(
        'Sempre mencione café expresso duplo da madrugada.',
      )
    })

    // Adversarial: attempt to save invalid short voice.md (<16 chars) and verify error notice
    await act(async () => {
      setNativeInputValue(editor, 'curto')
    })

    await act(async () => {
      clickElement(getByTestId('save-voice-identity-btn'))
    })

    await vi.waitFor(() => {
      expect(getByTestId('voice-save-notice').textContent).toMatch(/Erro:.*at least 16/i)
    })
    expect(useAshyStore.getState().voiceIdentity.content).toContain(
      'Sempre mencione café expresso duplo da madrugada.',
    )

    await act(async () => {
      clickElement(getByTestId('reset-voice-identity-btn'))
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().voiceIdentity.content).toContain(
        'Ashy — Voz & Identidade Viva',
      )
    })
  })

  it('5. rejects whitespace-only user name in First-Meeting Wizard with validation error', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()

    await act(async () => {
      root!.render(<App />)
    })

    await vi.waitFor(() => {
      expect(getByTestId('first-meeting-wizard')).toBeTruthy()
    })

    await act(async () => {
      setNativeInputValue(getByTestId<HTMLInputElement>('onboarding-user-name-input'), '   ')
    })

    await act(async () => {
      clickElement(getByTestId('onboarding-complete-btn'))
    })

    expect(getByTestId('onboarding-error-msg').textContent).toMatch(/Como posso te chamar/i)
    expect(useAshyStore.getState().needsOnboarding).toBe(true)
  })
})
