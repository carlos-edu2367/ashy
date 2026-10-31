// @vitest-environment jsdom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startLocalAiTestServer, type LocalAiTestServer } from '../../e2e/helpers/local-ai-test-server'
import { App } from '../App'
import { createAshyHostKernel } from '../host/kernel'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const tempDirs: string[] = []
const activeKernels: Array<{ stop(): Promise<void> }> = []
const activeServers: LocalAiTestServer[] = []
let container: HTMLDivElement | null = null
let root: Root | null = null

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-ui-p9-1-'))
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
  while (activeServers.length > 0) {
    await activeServers.pop()!.close()
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Phase 9.1 Task 3 — In-App Local Runtime UI (FirstMeetingWizard & Settings Panel) + LocalAiTestServer', () => {
  it('1. renders Motor Local Integrado card in FirstMeetingWizard, supports 1-click engine install/start, shows live pull progress, and pulls & activates recommended model', async () => {
    const dir = makeTempDir()
    let binaryPath: string | null = null
    let daemonOnline = false
    const installedModels: Array<{ name: string; size: number }> = []

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/tags')) {
        if (!daemonOnline) {
          throw new Error('ECONNREFUSED')
        }
        return new Response(JSON.stringify({ models: installedModels }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/pull') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string }
        installedModels.push({ name: body.name, size: 1_900_000_000 })
        const ndjson = [
          JSON.stringify({ status: 'pulling manifest' }),
          JSON.stringify({ status: 'pulling layers', completed: 950_000_000, total: 1_900_000_000 }),
          JSON.stringify({ status: 'success', completed: 1_900_000_000, total: 1_900_000_000 }),
        ].join('\n')
        return new Response(ndjson, { status: 200 })
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
      localRuntimeOptions: {
        baseUrl: 'http://127.0.0.1:11434',
        findBinaryImpl: () => binaryPath,
        spawnDaemonImpl: () => {
          daemonOnline = true
          return { kill: vi.fn() }
        },
        installEngineImpl: async (onProgress) => {
          onProgress(50, 'Instalando Ollama silenciosamente...')
          binaryPath = 'C:\\Users\\carlos\\AppData\\Local\\Programs\\Ollama\\ollama.exe'
          return binaryPath
        },
      },
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

    // Switch to Local Omni mode -> triggers refreshLocalRuntimeStatus() and renders onboarding-local-runtime-card
    await act(async () => {
      clickElement(getByTestId('onboarding-mode-local-omni'))
    })

    await vi.waitFor(() => {
      expect(getByTestId('onboarding-local-runtime-card')).toBeTruthy()
    })

    // Initially engine is not installed
    expect(getByTestId('onboarding-local-engine-status').textContent).toContain(
      'Motor Local (Ollama) não detectado',
    )
    const installBtn = getByTestId('btn-onboarding-install-local-engine')
    expect(installBtn.textContent).toContain('Instalar Motor Local no App (1 Clique)')

    // Simulate stopped-but-installed state first to verify btn-onboarding-start-local-engine
    binaryPath = 'C:\\Users\\carlos\\AppData\\Local\\Programs\\Ollama\\ollama.exe'
    daemonOnline = false
    await act(async () => {
      await useAshyStore.getState().refreshLocalRuntimeStatus()
    })
    expect(getByTestId('onboarding-local-engine-status').textContent).toContain(
      'Motor Local Instalado (Parado)',
    )
    const startBtn = getByTestId('btn-onboarding-start-local-engine')
    expect(startBtn.textContent).toContain('Iniciar Motor Local (Sem Terminal)')

    // Click start engine button -> starts daemon headlessly
    await act(async () => {
      clickElement(startBtn)
    })

    await vi.waitFor(() => {
      expect(getByTestId('onboarding-local-engine-status').textContent).toContain(
        'Motor Local Ativo (http://127.0.0.1:11434) • 0 modelo(s) no disco',
      )
    })

    // Verify activePull live progress bar rendering in Wizard
    await act(async () => {
      useAshyStore.getState().handleHostStreamEvent({
        type: 'local-runtime:status',
        status: {
          ...useAshyStore.getState().localRuntime,
          activePull: {
            model: 'qwen2.5:3b',
            status: 'pulling',
            phaseText: 'Baixando qwen2.5:3b (50%)...',
            completedBytes: 950_000_000,
            totalBytes: 1_900_000_000,
            percent: 50,
          },
        },
      })
    })
    expect(getByTestId('onboarding-local-pull-progress').textContent).toContain(
      'Baixando qwen2.5:3b (50%)...',
    )
    expect(getByTestId('onboarding-local-pull-progress').textContent).toContain('50%')

    // Pull recommended model qwen2.5:3b with 1 click inside Wizard
    const pullQwenBtn = getByTestId('btn-onboarding-pull-model-qwen2.5:3b')
    expect(pullQwenBtn.textContent).toContain('Baixar e Ativar (1.9 GB)')

    await act(async () => {
      clickElement(pullQwenBtn)
    })

    await vi.waitFor(() => {
      expect(getByTestId('btn-onboarding-pull-model-qwen2.5:3b').textContent).toContain(
        'Usar qwen2.5:3b (Instalado ✓)',
      )
    })
    expect(getByTestId('onboarding-local-engine-status').textContent).toContain(
      '1 modelo(s) no disco',
    )
    expect(getByTestId<HTMLSelectElement>('onboarding-provider-select').value).toBe('ollama')
    expect(getByTestId<HTMLInputElement>('onboarding-base-url-input').value).toBe(
      'http://127.0.0.1:11434/v1',
    )
    expect(getByTestId<HTMLInputElement>('onboarding-model-id-input').value).toBe('qwen2.5:3b')
  })

  it('2. manages local runtime & models in Configurações (panel-local-runtime-manager) against LocalAiTestServer (/api/pull & /api/delete)', async () => {
    const aiServer = await startLocalAiTestServer()
    activeServers.push(aiServer)

    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: (input, init) =>
        globalThis.fetch(input, init ? { ...init, signal: undefined } : undefined),
      localRuntimeOptions: {
        baseUrl: aiServer.rootUrl,
        findBinaryImpl: () => '/usr/local/bin/ollama',
      },
    })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    // Navigate to Configurações (tab-agency)
    await act(async () => {
      clickElement(getByTestId('tab-agency'))
    })

    expect(getByTestId('panel-local-runtime-manager')).toBeTruthy()

    // Refresh status from LocalAiTestServer
    await act(async () => {
      clickElement(getByTestId('btn-settings-refresh-local-engine'))
    })

    await vi.waitFor(() => {
      expect(getByTestId('settings-local-engine-status').textContent).toContain(
        'Rodando em segundo plano (Zero CMD)',
      )
    })

    // Initial models from LocalAiTestServer: lfm3-omni:2b and qwen3:8b
    expect(getByTestId('installed-local-model-lfm3-omni:2b')).toBeTruthy()
    expect(getByTestId('installed-local-model-qwen3:8b')).toBeTruthy()

    // Pull recommended model qwen2.5:3b via 1-click button in Settings
    const pullRecBtn = getByTestId('btn-settings-pull-model-qwen2.5:3b')
    expect(pullRecBtn.textContent).toContain('Baixar no App (1.9 GB)')

    await act(async () => {
      clickElement(pullRecBtn)
    })

    await vi.waitFor(() => {
      expect(getByTestId('installed-local-model-qwen2.5:3b')).toBeTruthy()
    })
    expect(getByTestId('installed-local-model-qwen2.5:3b').textContent).toContain('1.9 GB')
    expect(getByTestId('btn-settings-pull-model-qwen2.5:3b').textContent).toContain(
      'Revalidar / Ativar',
    )
    expect(useAshyStore.getState().providers.activeProviderId).toBe('ollama')
    expect(useAshyStore.getState().activeModelId).toBe('qwen2.5:3b')

    // Pull custom model by tag via input-custom-local-model + btn-pull-custom-local-model
    const customInput = getByTestId<HTMLInputElement>('input-custom-local-model')
    await act(async () => {
      setNativeInputValue(customInput, 'deepseek-r1:1.5b')
    })
    await act(async () => {
      clickElement(getByTestId('btn-pull-custom-local-model'))
    })

    await vi.waitFor(() => {
      expect(getByTestId('installed-local-model-deepseek-r1:1.5b')).toBeTruthy()
    })

    // Activate another installed model (lfm3-omni:2b)
    await act(async () => {
      clickElement(getByTestId('btn-activate-local-model-lfm3-omni:2b'))
    })
    await vi.waitFor(() => {
      expect(useAshyStore.getState().activeModelId).toBe('lfm3-omni:2b')
      expect(useAshyStore.getState().providers.activeProviderId).toBe('ollama')
    })

    // Delete installed model deepseek-r1:1.5b
    await act(async () => {
      clickElement(getByTestId('btn-delete-local-model-deepseek-r1:1.5b'))
    })

    await vi.waitFor(() => {
      expect(queryByTestId('installed-local-model-deepseek-r1:1.5b')).toBeNull()
    })
  })

  it('3. renders stopped/uninstalled states and live pull progress bar in panel-local-runtime-manager', async () => {
    const dir = makeTempDir()
    let binaryPath: string | null = null
    let daemonOnline = false

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: vi.fn(async () => {
        if (!daemonOnline) throw new Error('ECONNREFUSED')
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }) as unknown as typeof fetch,
      localRuntimeOptions: {
        findBinaryImpl: () => binaryPath,
        spawnDaemonImpl: () => {
          daemonOnline = true
          return { kill: vi.fn() }
        },
        installEngineImpl: async () => {
          binaryPath = '/usr/local/bin/ollama'
          return binaryPath
        },
      },
    })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    await act(async () => {
      clickElement(getByTestId('tab-agency'))
    })

    // Uninstalled state
    expect(getByTestId('settings-local-engine-status').textContent).toContain('Não instalado')
    expect(getByTestId('btn-settings-install-local-engine').textContent).toContain(
      'Instalar Motor Local (1 Clique)',
    )

    // Installed but stopped state
    binaryPath = '/usr/local/bin/ollama'
    daemonOnline = false
    await act(async () => {
      await useAshyStore.getState().refreshLocalRuntimeStatus()
    })
    expect(getByTestId('settings-local-engine-status').textContent).toContain('Parado')
    expect(getByTestId('btn-settings-start-local-engine').textContent).toContain(
      'Iniciar Motor Local (Sem Terminal)',
    )

    // Live pull progress bar in Settings
    await act(async () => {
      useAshyStore.getState().handleHostStreamEvent({
        type: 'local-runtime:status',
        status: {
          ...useAshyStore.getState().localRuntime,
          activePull: {
            model: 'gemma3:4b',
            status: 'pulling',
            phaseText: 'Baixando gemma3:4b (72%)...',
            completedBytes: 2_376_000_000,
            totalBytes: 3_300_000_000,
            percent: 72,
          },
        },
      })
    })
    expect(getByTestId('settings-local-pull-progress').textContent).toContain(
      'Baixando gemma3:4b (72%)...',
    )
    expect(getByTestId('settings-local-pull-progress').textContent).toContain('72%')
  })

  it('4. [adversarial] guards against whitespace custom model pulls, disables buttons during activePull, surfaces lastError in UI, and keeps /api/pull idempotent', async () => {
    const aiServer = await startLocalAiTestServer()
    activeServers.push(aiServer)

    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: (input, init) =>
        globalThis.fetch(input, init ? { ...init, signal: undefined } : undefined),
      localRuntimeOptions: {
        baseUrl: aiServer.rootUrl,
        findBinaryImpl: () => '/usr/local/bin/ollama',
      },
    })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    await act(async () => {
      clickElement(getByTestId('tab-agency'))
    })

    // 1. Whitespace-only custom model tag keeps pull button disabled
    const customInput = getByTestId<HTMLInputElement>('input-custom-local-model')
    const customPullBtn = getByTestId<HTMLButtonElement>('btn-pull-custom-local-model')
    await act(async () => {
      setNativeInputValue(customInput, '   ')
    })
    expect(customPullBtn.disabled).toBe(true)

    // 2. Active pull disables recommended model buttons and custom pull button, and surfaces lastError
    await act(async () => {
      setNativeInputValue(customInput, 'phi4-mini:3.8b')
      useAshyStore.getState().handleHostStreamEvent({
        type: 'local-runtime:status',
        status: {
          ...useAshyStore.getState().localRuntime,
          lastError: 'Falha simulada de rede ao baixar camada sha256',
          activePull: {
            model: 'qwen2.5:3b',
            status: 'pulling',
            phaseText: 'Baixando...',
            completedBytes: 100,
            totalBytes: 1000,
            percent: 10,
          },
        },
      })
    })

    expect(getByTestId<HTMLButtonElement>('btn-settings-pull-model-qwen2.5:3b').disabled).toBe(true)
    expect(getByTestId<HTMLButtonElement>('btn-pull-custom-local-model').disabled).toBe(true)
    expect(getByTestId('panel-local-runtime-manager').textContent).toContain(
      'Falha simulada de rede ao baixar camada sha256',
    )

    // 3. Pulling an already-present model on LocalAiTestServer does not duplicate it in installedModels
    await act(async () => {
      await useAshyStore.getState().pullLocalModel('qwen3:8b')
    })
    const qwen3Matches = useAshyStore
      .getState()
      .localRuntime.installedModels.filter((m) => m.name === 'qwen3:8b')
    expect(qwen3Matches).toHaveLength(1)
  })
})
