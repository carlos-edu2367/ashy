import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateText } from '@ashy/llm'
import { createNodeAesSecretProtector } from '../host/secret-protector'
import { createProviderVault } from '../host/provider-vault'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-ollama-native-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Phase 10.0 — ProviderVault routes Ollama to the native /api/chat adapter', () => {
  it('createActiveLanguageModel() for ollama POSTs to {origin}/api/chat with top_k=40 and think:false', async () => {
    const dir = makeTempDir()
    const urls: string[] = []
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(typeof input === 'string' ? input : input.toString())
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      const ndjson =
        [
          JSON.stringify({ message: { role: 'assistant', content: 'Oi!' }, done: false }),
          JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }),
        ].join('\n') + '\n'
      return new Response(ndjson, { status: 200 })
    })

    const vault = createProviderVault({
      userDataDir: dir,
      secretProtector: createNodeAesSecretProtector(dir),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    vault.saveProviderConfig({
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M',
    })
    vault.setActiveProvider('ollama')

    const model = vault.createActiveLanguageModel()
    expect(model.provider).toBe('ollama-native')
    expect(model.modelId).toBe('hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M')

    const result = await generateText(model, { messages: [{ role: 'user', content: 'oi' }] })
    expect(result.text).toBe('Oi!')
    expect(urls).toEqual(['http://127.0.0.1:11434/api/chat'])
    expect(bodies[0]!.think).toBe(false)
    expect(bodies[0]!.options).toMatchObject({ top_k: 40, temperature: 0.7, top_p: 0.9, repeat_penalty: 1.1 })

    // Health check also goes through the native adapter
    const health = await vault.testProviderConnection({ providerId: 'ollama' })
    expect(health.ok).toBe(true)
    expect(urls.at(-1)).toBe('http://127.0.0.1:11434/api/chat')
  })

  it('keeps the OpenAI-compatible adapter for non-Ollama providers', () => {
    const dir = makeTempDir()
    const vault = createProviderVault({
      userDataDir: dir,
      secretProtector: createNodeAesSecretProtector(dir),
    })
    expect(vault.createLanguageModel('openrouter').provider).toBe('openai-compatible')
    expect(vault.createLanguageModel('nvidia-nim').provider).toBe('openai-compatible')
    expect(vault.createLanguageModel('anthropic').provider).toBe('anthropic')
  })
})
