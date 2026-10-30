import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as v from 'valibot'
import {
  ASHY_HOST_RPC_METHODS,
  ListProviderModelsInputSchema,
  ListProviderModelsResultSchema,
  ProviderModelCatalogItemSchema,
} from '@ashy/shared'
import { createAshyHostKernel } from '../host/kernel'
import { createProviderVault, FALLBACK_PROVIDER_MODELS } from '../host/provider-vault'
import { dispatchHostRpc } from '../host/vite-host-plugin'
import { createAshyPreloadApi } from '../preload/index'
import { createHttpSseHostBridge, createPreloadHostBridge } from '../services/ashy-host-client'

describe('Phase 8.2 — Provider Models Catalog Discovery & Fallback Resilience', () => {
  const tempDirs: string[] = []

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-p82-catalog-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors on Windows
      }
    }
  })

  it('fetches OpenRouter models from GET https://openrouter.ai/api/v1/models with Bearer token and parses id, name, contextLength', async () => {
    const userDataDir = makeTempDir()
    const capturedRequests: Array<{ url: string; headers: Record<string, string> }> = []

    const fetchMock: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      capturedRequests.push({
        url,
        headers: Object.fromEntries(headers.entries()),
      })

      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'qwen/qwen3.8-flash',
              name: 'Qwen: Qwen 3.8 Flash',
              context_length: 131072,
              supported_parameters: ['tools', 'reasoning'],
            },
            {
              id: 'anthropic/claude-3.7-sonnet',
              name: 'Anthropic: Claude 3.7 Sonnet',
              context_length: 200000,
              supported_parameters: ['tools'],
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    const vault = createProviderVault({
      userDataDir,
      fetchImpl: fetchMock,
    })

    vault.saveProviderConfig({
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'qwen/qwen3.8-flash',
      apiKey: 'sk-or-v1-secret-openrouter-key',
    })

    const result = await vault.listProviderModels({ providerId: 'openrouter' })

    expect(capturedRequests).toHaveLength(1)
    expect(capturedRequests[0]?.url).toBe('https://openrouter.ai/api/v1/models')
    expect(capturedRequests[0]?.headers.authorization).toBe('Bearer sk-or-v1-secret-openrouter-key')

    expect(result.providerId).toBe('openrouter')
    expect(result.source).toBe('remote')
    expect(result.error).toBeNull()
    expect(result.models).toEqual([
      expect.objectContaining({
        id: 'qwen/qwen3.8-flash',
        name: 'Qwen: Qwen 3.8 Flash',
        providerId: 'openrouter',
        contextLength: 131072,
      }),
      expect.objectContaining({
        id: 'anthropic/claude-3.7-sonnet',
        name: 'Anthropic: Claude 3.7 Sonnet',
        providerId: 'openrouter',
        contextLength: 200000,
      }),
    ])
    expect(v.safeParse(ListProviderModelsResultSchema, result).success).toBe(true)
  })

  it('fetches local Ollama models from GET http://127.0.0.1:11434/api/tags (and falls back to /v1/models if tags has no models array)', async () => {
    const userDataDir = makeTempDir()
    const capturedUrls: string[] = []

    const fetchMock: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      capturedUrls.push(url)

      return new Response(
        JSON.stringify({
          models: [
            { name: 'qwen3:8b', model: 'qwen3:8b' },
            { name: 'deepseek-r1:8b', model: 'deepseek-r1:8b' },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    const vault = createProviderVault({
      userDataDir,
      fetchImpl: fetchMock,
    })

    const result = await vault.listProviderModels({ providerId: 'ollama' })

    expect(capturedUrls).toEqual(['http://127.0.0.1:11434/api/tags'])
    expect(result.providerId).toBe('ollama')
    expect(result.source).toBe('remote')
    expect(result.error).toBeNull()
    expect(result.models.map((m) => m.id)).toEqual(['qwen3:8b', 'deepseek-r1:8b'])
  })

  it('fetches Anthropic models from GET https://api.anthropic.com/v1/models with x-api-key and anthropic-version headers', async () => {
    const userDataDir = makeTempDir()
    const capturedRequests: Array<{ url: string; headers: Record<string, string> }> = []

    const fetchMock: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      capturedRequests.push({
        url,
        headers: Object.fromEntries(headers.entries()),
      })

      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'claude-3-7-sonnet-latest',
              display_name: 'Claude 3.7 Sonnet',
            },
            {
              id: 'claude-3-5-haiku-latest',
              display_name: 'Claude 3.5 Haiku',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    const vault = createProviderVault({
      userDataDir,
      fetchImpl: fetchMock,
    })

    const result = await vault.listProviderModels({
      providerId: 'anthropic',
      apiKey: 'sk-ant-api03-test-key-9999',
    })

    expect(capturedRequests).toHaveLength(1)
    expect(capturedRequests[0]?.url).toBe('https://api.anthropic.com/v1/models')
    expect(capturedRequests[0]?.headers['x-api-key']).toBe('sk-ant-api03-test-key-9999')
    expect(capturedRequests[0]?.headers['anthropic-version']).toBe('2023-06-01')

    expect(result.providerId).toBe('anthropic')
    expect(result.source).toBe('remote')
    expect(result.error).toBeNull()
    expect(result.models).toEqual([
      expect.objectContaining({
        id: 'claude-3-7-sonnet-latest',
        name: 'Claude 3.7 Sonnet',
        providerId: 'anthropic',
      }),
      expect.objectContaining({
        id: 'claude-3-5-haiku-latest',
        name: 'Claude 3.5 Haiku',
        providerId: 'anthropic',
      }),
    ])
  })

  it('[Adversarial] never throws unhandled error on HTTP 500, offline network, or missing API key — returns curated fallback catalog with error message', async () => {
    const userDataDir = makeTempDir()
    const failingFetch: typeof fetch = async () => {
      return new Response('Internal Server Error', { status: 500 })
    }

    const vault = createProviderVault({
      userDataDir,
      fetchImpl: failingFetch,
    })

    // 1. Missing API key on provider that requires one -> returns fallback without throwing
    const noKeyRes = await vault.listProviderModels({ providerId: 'openrouter' })
    expect(noKeyRes.providerId).toBe('openrouter')
    expect(noKeyRes.source).toBe('fallback')
    expect(noKeyRes.error).toBeTruthy()
    expect(noKeyRes.models.length).toBeGreaterThan(0)
    expect(noKeyRes.models.some((m) => m.id === 'qwen/qwen3.8-flash')).toBe(true)
    expect(noKeyRes.models).toEqual(FALLBACK_PROVIDER_MODELS.openrouter)

    // 2. HTTP 500 with API key provided -> returns fallback without throwing
    const http500Res = await vault.listProviderModels({
      providerId: 'openai',
      apiKey: 'sk-proj-test-key',
    })
    expect(http500Res.providerId).toBe('openai')
    expect(http500Res.source).toBe('fallback')
    expect(http500Res.error).toMatch(/500/)
    expect(http500Res.models).toEqual(FALLBACK_PROVIDER_MODELS.openai)

    // 3. Offline Ollama -> returns fallback without throwing
    const offlineOllamaVault = createProviderVault({
      userDataDir,
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
      },
    })
    const offlineOllamaRes = await offlineOllamaVault.listProviderModels({
      providerId: 'ollama',
    })
    expect(offlineOllamaRes.providerId).toBe('ollama')
    expect(offlineOllamaRes.source).toBe('fallback')
    expect(offlineOllamaRes.error).toMatch(/ECONNREFUSED/)
    expect(offlineOllamaRes.models).toEqual(FALLBACK_PROVIDER_MODELS.ollama)
  })

  it('delegates kernel.listProviderModels to providerVault.listProviderModels and wires RPC across dispatchHostRpc, Preload, and HTTP bridge', async () => {
    const userDataDir = makeTempDir()
    const fetchMock: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'qwen/qwen3.8-flash',
              name: 'Qwen 3.8 Flash',
              context_length: 131072,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const kernel = await createAshyHostKernel({
      userDataDir,
      fetchImpl: fetchMock,
    })

    try {
      expect(ASHY_HOST_RPC_METHODS).toContain('listProviderModels')
      expect(v.safeParse(ListProviderModelsInputSchema, { providerId: 'openrouter' }).success).toBe(true)
      expect(
        v.safeParse(ProviderModelCatalogItemSchema, {
          id: 'qwen/qwen3.8-flash',
          name: 'Qwen 3.8 Flash',
          providerId: 'openrouter',
          contextLength: 131072,
        }).success,
      ).toBe(true)

      const spy = vi.spyOn(kernel.providerVault, 'listProviderModels')

      const res1 = await kernel.listProviderModels({
        providerId: 'openrouter',
        apiKey: 'sk-or-v1-kernel-test',
      })
      expect(spy).toHaveBeenCalledWith({
        providerId: 'openrouter',
        apiKey: 'sk-or-v1-kernel-test',
      })
      expect(res1.source).toBe('remote')
      expect(res1.models[0]?.id).toBe('qwen/qwen3.8-flash')

      // Verify dispatchHostRpc
      const rpcRes = await dispatchHostRpc(kernel, 'listProviderModels', {
        providerId: 'openrouter',
        apiKey: 'sk-or-v1-rpc-test',
      })
      expect(rpcRes).toMatchObject({
        providerId: 'openrouter',
        source: 'remote',
      })

      // Verify Preload bridge
      const fakeIpcRenderer = {
        invoke: vi.fn(async (_channel: string, req: { method: string; payload?: unknown }) =>
          dispatchHostRpc(kernel, req.method, req.payload),
        ),
        on: vi.fn(),
        removeListener: vi.fn(),
      }
      const preloadBridge = createPreloadHostBridge(createAshyPreloadApi(fakeIpcRenderer))
      const preloadRes = await preloadBridge.listProviderModels({
        providerId: 'openrouter',
        apiKey: 'sk-or-v1-preload-test',
      })
      expect(preloadRes.source).toBe('remote')

      // Verify HTTP bridge
      const httpBridge = createHttpSseHostBridge({
        baseUrl: 'http://127.0.0.1:5173',
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            method: string
            payload?: unknown
          }
          const result = await dispatchHostRpc(kernel, body.method, body.payload)
          return new Response(JSON.stringify({ ok: true, result }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        },
      })
      const httpRes = await httpBridge.listProviderModels({
        providerId: 'openrouter',
        apiKey: 'sk-or-v1-http-test',
      })
      expect(httpRes.source).toBe('remote')
    } finally {
      await kernel.stop()
    }
  })

  it('[Red-Team #1] prevents SSRF / API key exfiltration when baseUrl is overridden to a different origin without an explicit apiKey', async () => {
    const userDataDir = makeTempDir()
    const capturedRequests: Array<{ url: string; headers: Record<string, string> }> = []

    const fetchMock: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      capturedRequests.push({
        url,
        headers: Object.fromEntries(headers.entries()),
      })
      return new Response(
        JSON.stringify({
          data: [{ id: 'attacker/model', name: 'Attacker Model' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const vault = createProviderVault({
      userDataDir,
      fetchImpl: fetchMock,
    })

    vault.saveProviderConfig({
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'qwen/qwen3.8-flash',
      apiKey: 'sk-or-v1-top-secret-vault-key',
    })

    // 1. listProviderModels with evil baseUrl and no apiKey -> MUST NOT send stored openrouter key!
    const listEvilRes = await vault.listProviderModels({
      providerId: 'openrouter',
      baseUrl: 'https://evil-attacker.example.com/v1',
    })
    expect(listEvilRes.source).toBe('fallback')
    for (const req of capturedRequests) {
      expect(req.headers.authorization).toBeUndefined()
    }

    // 2. testProviderConnection with evil baseUrl and no apiKey -> MUST NOT send stored openrouter key!
    const testEvilRes = await vault.testProviderConnection({
      providerId: 'openrouter',
      baseUrl: 'https://evil-attacker.example.com/v1',
    })
    expect(testEvilRes.ok).toBe(false)
    for (const req of capturedRequests) {
      expect(req.headers.authorization).toBeUndefined()
    }

    // 3. Invalid protocol (ftp:// or file://) is rejected before fetch
    const fileProtoRes = await vault.listProviderModels({
      providerId: 'ollama',
      baseUrl: 'file:///etc/passwd',
    })
    expect(fileProtoRes.source).toBe('fallback')
    expect(fileProtoRes.error).toMatch(/protocol|URL/i)
  })

  it('[Red-Team #4] truncates model name to <= 256 chars, skips id > 256 chars, caps catalog at 500 items, and deduplicates concurrent in-flight requests', async () => {
    const userDataDir = makeTempDir()
    let fetchCount = 0

    const fetchMock: typeof fetch = async () => {
      fetchCount += 1
      await new Promise((r) => setTimeout(r, 20))
      const hugeList = [
        {
          id: 'I'.repeat(300),
          name: 'Invalid Too Long ID',
        },
        {
          id: 'valid/long-name-model',
          name: 'X'.repeat(350),
          context_length: 64000,
        },
        ...Array.from({ length: 550 }, (_, i) => ({
          id: `provider/model-${i}`,
          name: `Model ${i}`,
        })),
      ]
      return new Response(JSON.stringify({ data: hugeList }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const vault = createProviderVault({
      userDataDir,
      fetchImpl: fetchMock,
    })

    const [resA, resB] = await Promise.all([
      vault.listProviderModels({
        providerId: 'openrouter',
        apiKey: 'sk-or-v1-dedupe-test',
      }),
      vault.listProviderModels({
        providerId: 'openrouter',
        apiKey: 'sk-or-v1-dedupe-test',
      }),
    ])

    expect(fetchCount).toBe(1)
    expect(resA.source).toBe('remote')
    expect(resB.source).toBe('remote')
    expect(resA.models.length).toBe(500)
    expect(resA.models[0]?.id).toBe('valid/long-name-model')
    expect(resA.models[0]?.name.length).toBe(256)

    // Must pass Valibot schema validation without throwing!
    const parsed = v.parse(ListProviderModelsResultSchema, resA)
    expect(parsed.models.length).toBe(500)
  })
})
