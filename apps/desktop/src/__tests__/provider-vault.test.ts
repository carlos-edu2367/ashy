import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createElectronSafeStorageProtector,
  createNodeAesSecretProtector,
} from '../host/secret-protector'
import { createProviderVault } from '../host/provider-vault'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-provider-vault-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('ProviderVault & SecretProtector', () => {
  it('encrypts API keys on disk, never exposes plaintext in public state, and preserves existing key when saving without apiKey', () => {
    const dir = makeTempDir()
    const protector = createNodeAesSecretProtector(dir)
    const vault = createProviderVault({ userDataDir: dir, secretProtector: protector })

    const updated = vault.saveProviderConfig({
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'anthropic/claude-3.7-sonnet',
      apiKey: 'sk-or-v1-supersecretkey9988',
    })

    expect(updated.hasApiKey).toBe(true)
    expect(updated.maskedApiKey).toBe('sk-or-...9988')
    expect(JSON.stringify(updated)).not.toContain('supersecretkey9988')

    // On-disk secrets file must not contain plaintext key
    const rawSecretsOnDisk = fs.readFileSync(path.join(dir, 'providers.secrets.json'), 'utf8')
    expect(rawSecretsOnDisk).not.toContain('supersecretkey9988')

    // Public state must never expose plaintext key
    const publicState = vault.getPublicState()
    expect(JSON.stringify(publicState)).not.toContain('supersecretkey9988')
    expect(publicState.hasActiveReadyProvider).toBe(true)

    // Saving model update without apiKey preserves encrypted key
    const updatedModelOnly = vault.saveProviderConfig({
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'deepseek/deepseek-chat-v3-0324',
    })
    expect(updatedModelOnly.hasApiKey).toBe(true)
    expect(updatedModelOnly.maskedApiKey).toBe('sk-or-...9988')
    expect(vault.getDecryptedApiKey('openrouter')).toBe('sk-or-v1-supersecretkey9988')
  })

  it('deduplicates concurrent testProviderConnection calls for identical credentials', async () => {
    const dir = makeTempDir()
    const protector = createNodeAesSecretProtector(dir)
    let fetchCount = 0
    const mockFetch = vi.fn(async () => {
      fetchCount += 1
      await new Promise((r) => setTimeout(r, 30))
      const sseBody = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
      return new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const vault = createProviderVault({
      userDataDir: dir,
      secretProtector: protector,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const [r1, r2] = await Promise.all([
      vault.testProviderConnection({
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-test123456',
      }),
      vault.testProviderConnection({
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-test123456',
      }),
    ])

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(fetchCount).toBe(1)

    const stateAfterOk = vault.getPublicState()
    expect(stateAfterOk.configs.openrouter.lastVerifiedAt).toBe(r1.verifiedAt)
    expect(stateAfterOk.configs.openrouter.lastError).toBeNull()
  })

  it('[Adversarial] auto-heals corrupted providers.json from .bak1 and resets to default when all backups are corrupt', () => {
    const dir = makeTempDir()
    const protector = createNodeAesSecretProtector(dir)
    const vault = createProviderVault({ userDataDir: dir, secretProtector: protector })

    vault.setActiveProvider('openai')
    vault.saveProviderConfig({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4.1-mini',
      apiKey: 'sk-proj-validkey1234',
    })
    vault.saveProviderConfig({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4.1',
    })

    // Corrupt primary providers.json with truncated JSON; .bak1 holds the gpt-4.1-mini state
    fs.writeFileSync(path.join(dir, 'providers.json'), '{"activeProviderId": "openai", broken')

    const healed = vault.getPublicState()
    expect(healed.diagnostics.status).toBe('healed_from_backup')
    expect(healed.diagnostics.healedFrom).toBe('.bak1')
    expect(healed.activeProviderId).toBe('openai')
    expect(healed.configs.openai.modelId).toBe('gpt-4.1-mini')

    // Now corrupt primary and all backups to trigger reset_to_default
    for (const suffix of ['', '.bak1', '.bak2', '.bak3']) {
      fs.writeFileSync(path.join(dir, `providers.json${suffix}`), '\0\0corrupt')
    }

    const resetState = vault.getPublicState()
    expect(resetState.diagnostics.status).toBe('reset_to_default')
    expect(resetState.activeProviderId).toBe('openrouter')
    expect(resetState.configs.openai.modelId).toBe('gpt-4o-mini')
  })

  it('[Adversarial] handles tampered ciphertext in providers.secrets.json without crashing getPublicState()', () => {
    const dir = makeTempDir()
    const protector = createNodeAesSecretProtector(dir)
    const vault = createProviderVault({ userDataDir: dir, secretProtector: protector })

    vault.saveProviderConfig({
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'anthropic/claude-3.7-sonnet',
      apiKey: 'sk-or-v1-intactkey9999',
    })
    expect(vault.getDecryptedApiKey('openrouter')).toBe('sk-or-v1-intactkey9999')

    // Tamper with ciphertext inside providers.secrets.json (valid JSON, forged AES-GCM payload)
    const tamperedPayload = JSON.stringify({
      version: 1,
      secrets: {
        openrouter: Buffer.alloc(48, 0xff).toString('base64'),
        anthropic: 'short-invalid',
      },
    })
    fs.writeFileSync(path.join(dir, 'providers.secrets.json'), tamperedPayload)

    expect(() => vault.getPublicState()).not.toThrow()
    const state = vault.getPublicState()
    expect(state.configs.openrouter.hasApiKey).toBe(false)
    expect(state.configs.openrouter.maskedApiKey).toBeNull()
    expect(state.hasActiveReadyProvider).toBe(false)
    expect(vault.getDecryptedApiKey('openrouter')).toBeNull()
    expect(vault.getDecryptedApiKey('anthropic')).toBeNull()
  })

  it('[Adversarial] marks ollama ready without an API key and supports clearApiKey: true secret deletion', () => {
    const dir = makeTempDir()
    const protector = createNodeAesSecretProtector(dir)
    const vault = createProviderVault({ userDataDir: dir, secretProtector: protector })

    // Default active provider is openrouter (requiresApiKey: true, no key yet)
    expect(vault.getPublicState().hasActiveReadyProvider).toBe(false)

    // Switching to ollama (requiresApiKey: false) makes hasActiveReadyProvider true immediately
    const ollamaState = vault.setActiveProvider('ollama')
    expect(ollamaState.activeProviderId).toBe('ollama')
    expect(ollamaState.configs.ollama.requiresApiKey).toBe(false)
    expect(ollamaState.configs.ollama.hasApiKey).toBe(false)
    expect(ollamaState.hasActiveReadyProvider).toBe(true)

    // Save a key for anthropic, then delete it with clearApiKey: true
    const savedAnthropic = vault.saveProviderConfig({
      providerId: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      modelId: 'claude-3-7-sonnet-latest',
      apiKey: 'sk-ant-api03-secretkey7777',
    })
    expect(savedAnthropic.hasApiKey).toBe(true)
    expect(savedAnthropic.maskedApiKey).toBe('sk-ant...7777')

    const clearedAnthropic = vault.saveProviderConfig({
      providerId: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      modelId: 'claude-3-7-sonnet-latest',
      clearApiKey: true,
    })
    expect(clearedAnthropic.hasApiKey).toBe(false)
    expect(clearedAnthropic.maskedApiKey).toBeNull()
    expect(vault.getDecryptedApiKey('anthropic')).toBeNull()

    // Ensure createLanguageModel selects Anthropic adapter for anthropic and OpenAI-compatible for others
    const anthropicModel = vault.createLanguageModel('anthropic')
    expect(anthropicModel.provider).toBe('anthropic')
    const ollamaModel = vault.createLanguageModel('ollama')
    expect(ollamaModel.provider).toBe('openai-compatible')
  })

  it('[Adversarial] records ok: false and persists lastError when testProviderConnection receives HTTP 401', async () => {
    const dir = makeTempDir()
    const protector = createElectronSafeStorageProtector(
      {
        isEncryptionAvailable: () => true,
        encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
        decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
      },
      dir,
    )

    const mockFetch401 = vi.fn(async () => {
      return new Response('{"error":{"message":"Invalid API key provided"}}', {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'content-type': 'application/json' },
      })
    })

    const vault = createProviderVault({
      userDataDir: dir,
      secretProtector: protector,
      fetchImpl: mockFetch401 as unknown as typeof fetch,
    })

    vault.saveProviderConfig({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4o-mini',
      apiKey: 'sk-proj-expiredkey0000',
    })

    const result = await vault.testProviderConnection({
      providerId: 'openai',
    })

    expect(result.ok).toBe(false)
    expect(result.providerId).toBe('openai')
    expect(result.error).toMatch(/401/)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)

    const publicState = vault.getPublicState()
    expect(publicState.configs.openai.lastError).toMatch(/401/)
    expect(publicState.configs.openai.lastVerifiedAt).toBeNull()
  })
})
