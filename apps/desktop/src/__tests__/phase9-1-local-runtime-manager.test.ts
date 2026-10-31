import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RECOMMENDED_LOCAL_MODELS,
  validateLocalModelName,
  type AshyHostStreamEvent,
  type LocalRuntimeStatus,
} from '@ashy/shared'
import { createAshyHostKernel } from '../host/kernel'
import { createLocalRuntimeManager } from '../host/local-runtime-manager'
import { dispatchHostRpc } from '../host/vite-host-plugin'
import { createAshyPreloadApi } from '../preload/index'
import { createPreloadHostBridge } from '../services/ashy-host-client'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-local-runtime-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Phase 9.1 — LocalRuntimeManager & In-App Zero-Terminal Local Model Lifecycle', () => {
  it('1. detects running local Ollama HTTP server (/api/tags), parses installed models, and returns curated recommendedModels', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'http://127.0.0.1:11434/api/tags') {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: 'qwen2.5:3b',
                size: 1_930_000_000,
                modified_at: '2026-10-31T12:00:00Z',
                details: {
                  family: 'qwen2',
                  parameter_size: '3.1B',
                  quantization_level: 'Q4_K_M',
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('Not Found', { status: 404 })
    })

    const manager = createLocalRuntimeManager({
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: mockFetch as unknown as typeof fetch,
      findBinaryImpl: () => 'C:\\Users\\carlos\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
    })

    const status = await manager.getStatus()
    expect(status.engineInstalled).toBe(true)
    expect(status.engineBinaryPath).toContain('ollama.exe')
    expect(status.engineRunning).toBe(true)
    expect(status.managedByAshy).toBe(false)
    expect(status.baseUrl).toBe('http://127.0.0.1:11434')
    expect(status.installedModels).toEqual([
      {
        name: 'qwen2.5:3b',
        sizeBytes: 1_930_000_000,
        family: 'qwen2',
        parameterSize: '3.1B',
        quantizationLevel: 'Q4_K_M',
        modifiedAt: '2026-10-31T12:00:00Z',
      },
    ])
    expect(status.recommendedModels).toEqual(RECOMMENDED_LOCAL_MODELS)
    expect(status.recommendedModels.map((m) => m.id)).toEqual([
      'qwen2.5:3b',
      'llama3.2:3b',
      'gemma3:4b',
      'qwen2.5:7b',
    ])
  })

  it('2. headlessly starts ollama serve when engine is installed but stopped, polls until ready, and kills child process on dispose()', async () => {
    let daemonOnline = false
    const killSpy = vi.fn(() => {
      daemonOnline = false
    })
    const spawnCalls: Array<{ binaryPath: string; host: string }> = []
    const emittedStatuses: LocalRuntimeStatus[] = []

    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'http://127.0.0.1:11434/api/tags') {
        if (!daemonOnline) {
          throw new Error('ECONNREFUSED')
        }
        return new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('Not Found', { status: 404 })
    })

    const manager = createLocalRuntimeManager({
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: mockFetch as unknown as typeof fetch,
      findBinaryImpl: () => '/usr/local/bin/ollama',
      spawnDaemonImpl: (binaryPath, host) => {
        spawnCalls.push({ binaryPath, host })
        setTimeout(() => {
          daemonOnline = true
        }, 30)
        return { kill: killSpy }
      },
      onStatusChange: (status) => {
        emittedStatuses.push(status)
      },
    })

    const initialStatus = await manager.getStatus()
    expect(initialStatus.engineInstalled).toBe(true)
    expect(initialStatus.engineRunning).toBe(false)

    const runningStatus = await manager.ensureEngineRunning()
    expect(spawnCalls).toEqual([
      {
        binaryPath: '/usr/local/bin/ollama',
        host: '127.0.0.1:11434',
      },
    ])
    expect(runningStatus.engineRunning).toBe(true)
    expect(runningStatus.managedByAshy).toBe(true)
    expect(emittedStatuses.some((s) => s.engineRunning && s.managedByAshy)).toBe(true)

    manager.dispose()
    expect(killSpy).toHaveBeenCalledTimes(1)

    // Also verify missing binary throws LOCAL_ENGINE_NOT_INSTALLED
    const missingManager = createLocalRuntimeManager({
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
      findBinaryImpl: () => null,
    })
    await expect(missingManager.ensureEngineRunning()).rejects.toThrow(
      'LOCAL_ENGINE_NOT_INSTALLED',
    )
    expect(missingManager.getCachedStatus().lastError).toBe('LOCAL_ENGINE_NOT_INSTALLED')
  })

  it('3. executes 1-click installEngine() when binary is missing, emits progress updates, and starts engine automatically', async () => {
    let installedBinaryPath: string | null = null
    let daemonOnline = false
    const statusHistory: LocalRuntimeStatus[] = []

    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'http://127.0.0.1:11434/api/tags') {
        if (!daemonOnline) {
          throw new Error('ECONNREFUSED')
        }
        return new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('Not Found', { status: 404 })
    })

    const manager = createLocalRuntimeManager({
      fetchImpl: mockFetch as unknown as typeof fetch,
      findBinaryImpl: () => installedBinaryPath,
      spawnDaemonImpl: () => {
        daemonOnline = true
        return { kill: vi.fn() }
      },
      installEngineImpl: async (onProgress) => {
        onProgress(45, 'Baixando instalador oficial do Ollama (45%)...')
        onProgress(85, 'Executando instalação silenciosa...')
        installedBinaryPath = 'C:\\Users\\carlos\\AppData\\Local\\Programs\\Ollama\\ollama.exe'
        return installedBinaryPath
      },
      onStatusChange: (status) => {
        statusHistory.push(structuredClone(status))
      },
    })

    const before = await manager.getStatus()
    expect(before.engineInstalled).toBe(false)
    expect(before.engineRunning).toBe(false)

    const after = await manager.installEngine()
    expect(after.engineInstalled).toBe(true)
    expect(after.engineRunning).toBe(true)
    expect(after.installingEngine).toBe(false)
    expect(after.activePull).toBeNull()

    expect(
      statusHistory.some(
        (s) => s.installingEngine && s.activePull?.model === 'ollama-engine',
      ),
    ).toBe(true)
    expect(
      statusHistory.some((s) => s.activePull?.percent === 45),
    ).toBe(true)
  })

  it('4. streams pullModel("qwen2.5:3b") NDJSON progress, auto-activates ollama in ProviderVault via Kernel/RPC, and supports deleteModel', async () => {
    const dir = makeTempDir()
    const installedModels: Array<{
      name: string
      size: number
      modified_at: string
      details: { family: string; parameter_size: string; quantization_level: string }
    }> = []

    const encoder = new TextEncoder()
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'http://127.0.0.1:11434/api/tags') {
        return new Response(JSON.stringify({ models: installedModels }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'http://127.0.0.1:11434/api/pull' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string; stream: boolean }
        expect(body).toEqual({ name: 'qwen2.5:3b', stream: true })

        installedModels.push({
          name: 'qwen2.5:3b',
          size: 1_900_000_000,
          modified_at: '2026-10-31T15:00:00Z',
          details: {
            family: 'qwen2',
            parameter_size: '3B',
            quantization_level: 'Q4_K_M',
          },
        })

        const ndjsonChunks = [
          JSON.stringify({ status: 'pulling manifest' }) + '\n',
          JSON.stringify({
            status: 'pulling sha256:abc123',
            completed: 855_000_000,
            total: 1_900_000_000,
          }) + '\n',
          JSON.stringify({
            status: 'verifying sha256 digest',
            completed: 1_900_000_000,
            total: 1_900_000_000,
          }) + '\n',
          JSON.stringify({ status: 'success' }) + '\n',
        ]

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of ndjsonChunks) {
              controller.enqueue(encoder.encode(chunk))
            }
            controller.close()
          },
        })

        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        })
      }

      if (url === 'http://127.0.0.1:11434/api/delete' && init?.method === 'DELETE') {
        const body = JSON.parse(String(init.body)) as { name: string }
        const idx = installedModels.findIndex((m) => m.name === body.name)
        if (idx >= 0) {
          installedModels.splice(idx, 1)
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      return new Response('Not Found', { status: 404 })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
      localRuntimeOptions: {
        findBinaryImpl: () => '/usr/local/bin/ollama',
      },
    })

    const receivedEvents: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => receivedEvents.push(ev))

    const preloadBridge = createPreloadHostBridge(
      createAshyPreloadApi({
        invoke: async (_channel, req) => {
          const r = req as { method: string; payload?: unknown }
          return dispatchHostRpc(kernel, r.method, r.payload)
        },
        on: vi.fn(),
        removeListener: vi.fn(),
      }),
    )

    const pulledStatus = await preloadBridge.pullLocalModel!({ model: 'qwen2.5:3b' })
    expect(pulledStatus.engineRunning).toBe(true)
    expect(pulledStatus.installedModels.some((m) => m.name === 'qwen2.5:3b')).toBe(true)
    expect(pulledStatus.activePull).toBeNull()

    const runtimeEvents = receivedEvents.filter(
      (
        e,
      ): e is Extract<AshyHostStreamEvent, { type: 'local-runtime:status' }> =>
        e.type === 'local-runtime:status',
    )
    expect(runtimeEvents.length).toBeGreaterThanOrEqual(3)
    expect(
      runtimeEvents.some((e) => e.status.activePull?.status === 'starting'),
    ).toBe(true)
    expect(
      runtimeEvents.some(
        (e) =>
          e.status.activePull?.status === 'pulling' &&
          e.status.activePull?.percent === 45,
      ),
    ).toBe(true)
    expect(
      runtimeEvents.some((e) => e.status.activePull?.status === 'verifying'),
    ).toBe(true)

    // Verify ProviderVault was automatically updated to ollama + qwen2.5:3b
    const snap = await preloadBridge.getBootstrapSnapshot()
    expect(snap.providers.activeProviderId).toBe('ollama')
    expect(snap.providers.configs.ollama.modelId).toBe('qwen2.5:3b')
    expect(snap.providers.configs.ollama.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(snap.localRuntime?.installedModels.some((m) => m.name === 'qwen2.5:3b')).toBe(
      true,
    )

    // Delete model via RPC
    const afterDelete = await preloadBridge.deleteLocalModel!({ model: 'qwen2.5:3b' })
    expect(afterDelete.installedModels).toHaveLength(0)

    unsub()
    await kernel.stop()
  })

  it('5. rejects malicious or invalid model names with INVALID_LOCAL_MODEL_NAME before any HTTP or process call', async () => {
    expect(validateLocalModelName('  qwen2.5:3b  ')).toBe('qwen2.5:3b')
    expect(validateLocalModelName('hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M')).toBe(
      'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M',
    )

    const maliciousInputs = [
      '',
      '   ',
      '../etc/passwd',
      'qwen/../../secret',
      'qwen2.5:3b; rm -rf /',
      'qwen2.5:3b && calc.exe',
      'qwen$(whoami)',
      'qwen`id`',
      'model with spaces',
      'a'.repeat(129),
    ]

    const mockFetch = vi.fn()
    const manager = createLocalRuntimeManager({
      fetchImpl: mockFetch as unknown as typeof fetch,
      findBinaryImpl: () => '/usr/local/bin/ollama',
    })

    for (const bad of maliciousInputs) {
      expect(() => validateLocalModelName(bad)).toThrow('INVALID_LOCAL_MODEL_NAME')
      await expect(manager.pullModel(bad)).rejects.toThrow('INVALID_LOCAL_MODEL_NAME')
      await expect(manager.deleteModel(bad)).rejects.toThrow('INVALID_LOCAL_MODEL_NAME')
    }

    expect(mockFetch).not.toHaveBeenCalled()

    // Adversarial NDJSON error line handling
    const errorFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      if (url.endsWith('/api/pull')) {
        return new Response(
          JSON.stringify({ error: 'pull model manifest: file does not exist' }) + '\n',
          { status: 200 },
        )
      }
      return new Response('Server Error', { status: 500 })
    })

    const errorSnapshots: LocalRuntimeStatus[] = []
    const errManager = createLocalRuntimeManager({
      fetchImpl: errorFetch as unknown as typeof fetch,
      findBinaryImpl: () => '/usr/local/bin/ollama',
      onStatusChange: (s) => errorSnapshots.push(structuredClone(s)),
    })

    await expect(errManager.pullModel('nonexistent:model')).rejects.toThrow(
      'pull model manifest: file does not exist',
    )
    expect(errManager.getCachedStatus().lastError).toBe(
      'pull model manifest: file does not exist',
    )
    expect(errorSnapshots.at(-1)?.activePull?.status).toBe('error')
  })
})
