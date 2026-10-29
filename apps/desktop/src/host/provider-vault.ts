import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as v from 'valibot'
import {
  LLM_PROVIDER_IDS,
  maskApiKey,
  SaveProviderConfigInputSchema,
  TestProviderInputSchema,
  type AshyBootstrapSnapshot,
  type ConfigDiagnostics,
  type LlmProviderId,
  type ProviderHealthResult,
  type PublicProviderConfig,
  type SaveProviderConfigInput,
  type TestProviderInput,
} from '@ashy/shared'
import {
  createAnthropicMessagesModel,
  createOpenAICompatibleModel,
  streamText,
  type LanguageModel,
} from '@ashy/llm'
import { readWithAutoHeal, writeAtomicWithBackup } from './atomic-file'
import { createNodeAesSecretProtector, type SecretProtector } from './secret-protector'

interface StoredProviderEntry {
  providerId: LlmProviderId
  label: string
  baseUrl: string
  modelId: string
  requiresApiKey: boolean
  lastVerifiedAt: number | null
  lastError: string | null
}

interface StoredProvidersDocument {
  version: 1
  activeProviderId: LlmProviderId
  providers: Record<LlmProviderId, StoredProviderEntry>
}

interface StoredSecretsDocument {
  version: 1
  secrets: Partial<Record<LlmProviderId, string>>
}

export const DEFAULT_PROVIDER_CONFIGS: Record<
  LlmProviderId,
  Omit<StoredProviderEntry, 'providerId' | 'lastVerifiedAt' | 'lastError'>
> = {
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelId: 'anthropic/claude-3.7-sonnet',
    requiresApiKey: true,
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    modelId: 'claude-3-7-sonnet-latest',
    requiresApiKey: true,
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'gpt-4o-mini',
    requiresApiKey: true,
  },
  'nvidia-nim': {
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    modelId: 'meta/llama-3.3-70b-instruct',
    requiresApiKey: true,
  },
  ollama: {
    label: 'Ollama (Local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelId: 'qwen2.5:14b',
    requiresApiKey: false,
  },
}

function isLlmProviderId(value: unknown): value is LlmProviderId {
  return typeof value === 'string' && (LLM_PROVIDER_IDS as readonly string[]).includes(value)
}

function createDefaultProvidersDocument(): StoredProvidersDocument {
  const providers = {} as Record<LlmProviderId, StoredProviderEntry>
  for (const id of LLM_PROVIDER_IDS) {
    const def = DEFAULT_PROVIDER_CONFIGS[id]
    providers[id] = {
      providerId: id,
      label: def.label,
      baseUrl: def.baseUrl,
      modelId: def.modelId,
      requiresApiKey: def.requiresApiKey,
      lastVerifiedAt: null,
      lastError: null,
    }
  }
  return {
    version: 1,
    activeProviderId: 'openrouter',
    providers,
  }
}

function createDefaultSecretsDocument(): StoredSecretsDocument {
  return {
    version: 1,
    secrets: {},
  }
}

function parseAndValidateProviders(raw: string): StoredProvidersDocument {
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('providers.json root must be an object')
  }
  const obj = parsed as Record<string, unknown>
  if (!isLlmProviderId(obj.activeProviderId)) {
    throw new Error('providers.json has invalid activeProviderId')
  }
  if (
    typeof obj.providers !== 'object' ||
    obj.providers === null ||
    Array.isArray(obj.providers)
  ) {
    throw new Error('providers.json is missing providers map')
  }

  const rawMap = obj.providers as Record<string, unknown>
  const providers = {} as Record<LlmProviderId, StoredProviderEntry>

  for (const id of LLM_PROVIDER_IDS) {
    const def = DEFAULT_PROVIDER_CONFIGS[id]
    const item = rawMap[id]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`providers.json is missing valid config for ${id}`)
    }
    const entry = item as Record<string, unknown>
    const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : ''
    const modelId = typeof entry.modelId === 'string' ? entry.modelId.trim() : ''
    if (baseUrl.length === 0 || modelId.length === 0) {
      throw new Error(`providers.json entry ${id} has empty baseUrl or modelId`)
    }

    providers[id] = {
      providerId: id,
      label: def.label,
      baseUrl,
      modelId,
      requiresApiKey: def.requiresApiKey,
      lastVerifiedAt:
        typeof entry.lastVerifiedAt === 'number' && Number.isFinite(entry.lastVerifiedAt)
          ? entry.lastVerifiedAt
          : null,
      lastError: typeof entry.lastError === 'string' ? entry.lastError : null,
    }
  }

  return {
    version: 1,
    activeProviderId: obj.activeProviderId,
    providers,
  }
}

function parseAndValidateSecrets(raw: string): StoredSecretsDocument {
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('providers.secrets.json root must be an object')
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.secrets !== 'object' || obj.secrets === null || Array.isArray(obj.secrets)) {
    throw new Error('providers.secrets.json is missing secrets map')
  }

  const rawSecrets = obj.secrets as Record<string, unknown>
  const secrets: Partial<Record<LlmProviderId, string>> = {}

  for (const [key, value] of Object.entries(rawSecrets)) {
    if (!isLlmProviderId(key)) continue
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Invalid secret value for provider ${key}`)
    }
    secrets[key] = value.trim()
  }

  return {
    version: 1,
    secrets,
  }
}

export interface ProviderModelOverrides {
  baseUrl?: string
  modelId?: string
  apiKey?: string
}

export interface ProviderVault {
  readonly providersFilePath: string
  readonly secretsFilePath: string
  getPublicState(): AshyBootstrapSnapshot['providers']
  saveProviderConfig(input: SaveProviderConfigInput): PublicProviderConfig
  setActiveProvider(providerId: LlmProviderId): AshyBootstrapSnapshot['providers']
  getDecryptedApiKey(providerId: LlmProviderId): string | null
  createLanguageModel(
    providerId?: LlmProviderId,
    overrides?: ProviderModelOverrides,
  ): LanguageModel
  createActiveLanguageModel(): LanguageModel
  testProviderConnection(input: TestProviderInput): Promise<ProviderHealthResult>
}

export interface ProviderVaultOptions {
  userDataDir: string
  secretProtector?: SecretProtector
  fetchImpl?: typeof fetch
}

export function createProviderVault(options: ProviderVaultOptions): ProviderVault {
  const providersFilePath = path.join(options.userDataDir, 'providers.json')
  const secretsFilePath = path.join(options.userDataDir, 'providers.secrets.json')
  const secretProtector =
    options.secretProtector ?? createNodeAesSecretProtector(options.userDataDir)

  const defaultProvidersJson = JSON.stringify(createDefaultProvidersDocument(), null, 2)
  const defaultSecretsJson = JSON.stringify(createDefaultSecretsDocument(), null, 2)

  const inFlightProbes = new Map<string, Promise<ProviderHealthResult>>()

  function readProvidersWithHeal() {
    return readWithAutoHeal({
      filePath: providersFilePath,
      defaultContent: defaultProvidersJson,
      parseAndValidate: parseAndValidateProviders,
    })
  }

  function readSecretsWithHeal() {
    return readWithAutoHeal({
      filePath: secretsFilePath,
      defaultContent: defaultSecretsJson,
      parseAndValidate: parseAndValidateSecrets,
    })
  }

  function loadProvidersForMutation(): StoredProvidersDocument {
    if (!fs.existsSync(providersFilePath)) {
      return createDefaultProvidersDocument()
    }
    return readProvidersWithHeal().value
  }

  function loadSecretsForMutation(): StoredSecretsDocument {
    if (!fs.existsSync(secretsFilePath)) {
      return createDefaultSecretsDocument()
    }
    return readSecretsWithHeal().value
  }

  function decryptFromSecretsMap(
    secrets: Partial<Record<LlmProviderId, string>>,
    providerId: LlmProviderId,
  ): string | null {
    const cipherText = secrets[providerId]
    if (!cipherText || typeof cipherText !== 'string' || cipherText.trim().length === 0) {
      return null
    }
    try {
      const decrypted = secretProtector.decrypt(cipherText).trim()
      return decrypted.length > 0 ? decrypted : null
    } catch {
      return null
    }
  }

  function toPublicConfig(
    entry: StoredProviderEntry,
    decryptedKey: string | null,
  ): PublicProviderConfig {
    const hasApiKey = decryptedKey !== null && decryptedKey.length > 0
    return {
      providerId: entry.providerId,
      label: entry.label,
      baseUrl: entry.baseUrl,
      modelId: entry.modelId,
      requiresApiKey: entry.requiresApiKey,
      hasApiKey,
      maskedApiKey: hasApiKey ? maskApiKey(decryptedKey) : null,
      lastVerifiedAt: entry.lastVerifiedAt,
      lastError: entry.lastError,
    }
  }

  function getDecryptedApiKey(providerId: LlmProviderId): string | null {
    if (!isLlmProviderId(providerId)) {
      throw new Error(`Invalid providerId: ${String(providerId)}`)
    }
    const secretsDoc = fs.existsSync(secretsFilePath)
      ? readSecretsWithHeal().value
      : createDefaultSecretsDocument()
    return decryptFromSecretsMap(secretsDoc.secrets, providerId)
  }

  function getPublicState(): AshyBootstrapSnapshot['providers'] {
    const providersRead = readProvidersWithHeal()
    const secretsRead = readSecretsWithHeal()

    const configs = {} as Record<LlmProviderId, PublicProviderConfig>
    for (const id of LLM_PROVIDER_IDS) {
      const entry = providersRead.value.providers[id]
      const decryptedKey = decryptFromSecretsMap(secretsRead.value.secrets, id)
      configs[id] = toPublicConfig(entry, decryptedKey)
    }

    const activeProviderId = providersRead.value.activeProviderId
    const activeConfig = configs[activeProviderId]
    const hasActiveReadyProvider =
      Boolean(activeConfig) &&
      activeConfig.baseUrl.trim().length > 0 &&
      activeConfig.modelId.trim().length > 0 &&
      (!activeConfig.requiresApiKey || activeConfig.hasApiKey)

    const diagnostics: ConfigDiagnostics =
      providersRead.diagnostics.status !== 'ok'
        ? providersRead.diagnostics
        : secretsRead.diagnostics.status !== 'ok' && secretsRead.diagnostics.status !== 'missing'
          ? secretsRead.diagnostics
          : providersRead.diagnostics

    return {
      activeProviderId,
      configs,
      hasActiveReadyProvider,
      diagnostics,
    }
  }

  function saveProviderConfig(rawInput: SaveProviderConfigInput): PublicProviderConfig {
    const parsed = v.parse(SaveProviderConfigInputSchema, rawInput)
    const { providerId, baseUrl, modelId, apiKey, clearApiKey } = parsed

    const providersDoc = loadProvidersForMutation()
    const secretsDoc = loadSecretsForMutation()

    const existing = providersDoc.providers[providerId]
    const updatedEntry: StoredProviderEntry = {
      ...existing,
      baseUrl,
      modelId,
    }
    providersDoc.providers[providerId] = updatedEntry

    if (clearApiKey === true) {
      delete secretsDoc.secrets[providerId]
      writeAtomicWithBackup(secretsFilePath, JSON.stringify(secretsDoc, null, 2))
    } else if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
      secretsDoc.secrets[providerId] = secretProtector.encrypt(apiKey.trim())
      writeAtomicWithBackup(secretsFilePath, JSON.stringify(secretsDoc, null, 2))
    }

    writeAtomicWithBackup(providersFilePath, JSON.stringify(providersDoc, null, 2))

    const decryptedKey = decryptFromSecretsMap(secretsDoc.secrets, providerId)
    return toPublicConfig(updatedEntry, decryptedKey)
  }

  function setActiveProvider(providerId: LlmProviderId): AshyBootstrapSnapshot['providers'] {
    if (!isLlmProviderId(providerId)) {
      throw new Error(`Invalid providerId: ${String(providerId)}`)
    }
    const providersDoc = loadProvidersForMutation()
    providersDoc.activeProviderId = providerId
    writeAtomicWithBackup(providersFilePath, JSON.stringify(providersDoc, null, 2))
    return getPublicState()
  }

  function createLanguageModel(
    providerId?: LlmProviderId,
    overrides?: ProviderModelOverrides,
  ): LanguageModel {
    const providersDoc = fs.existsSync(providersFilePath)
      ? readProvidersWithHeal().value
      : createDefaultProvidersDocument()
    const targetProviderId = providerId ?? providersDoc.activeProviderId
    if (!isLlmProviderId(targetProviderId)) {
      throw new Error(`Invalid providerId: ${String(targetProviderId)}`)
    }

    const stored = providersDoc.providers[targetProviderId]
    const baseUrl =
      typeof overrides?.baseUrl === 'string' && overrides.baseUrl.trim().length > 0
        ? overrides.baseUrl.trim()
        : stored.baseUrl
    const modelId =
      typeof overrides?.modelId === 'string' && overrides.modelId.trim().length > 0
        ? overrides.modelId.trim()
        : stored.modelId
    const apiKey =
      typeof overrides?.apiKey === 'string' && overrides.apiKey.trim().length > 0
        ? overrides.apiKey.trim()
        : (getDecryptedApiKey(targetProviderId) ?? undefined)

    if (targetProviderId === 'anthropic') {
      return createAnthropicMessagesModel({
        baseUrl,
        apiKey,
        model: modelId,
        fetchImpl: options.fetchImpl,
      })
    }

    return createOpenAICompatibleModel({
      baseUrl,
      apiKey,
      model: modelId,
      fetchImpl: options.fetchImpl,
    })
  }

  function createActiveLanguageModel(): LanguageModel {
    return createLanguageModel()
  }

  function testProviderConnection(rawInput: TestProviderInput): Promise<ProviderHealthResult> {
    const input = v.parse(TestProviderInputSchema, rawInput)
    const providersDoc = fs.existsSync(providersFilePath)
      ? readProvidersWithHeal().value
      : createDefaultProvidersDocument()
    const stored = providersDoc.providers[input.providerId]

    const baseUrl =
      typeof input.baseUrl === 'string' && input.baseUrl.trim().length > 0
        ? input.baseUrl.trim()
        : stored.baseUrl
    const modelId =
      typeof input.modelId === 'string' && input.modelId.trim().length > 0
        ? input.modelId.trim()
        : stored.modelId
    const effectiveApiKey =
      typeof input.apiKey === 'string' && input.apiKey.trim().length > 0
        ? input.apiKey.trim()
        : getDecryptedApiKey(input.providerId)

    const dedupeKey = crypto
      .createHash('sha256')
      .update(`${input.providerId}|${baseUrl}|${modelId}|${effectiveApiKey ?? ''}`)
      .digest('hex')

    const existingProbe = inFlightProbes.get(dedupeKey)
    if (existingProbe) {
      return existingProbe
    }

    const probePromise = (async (): Promise<ProviderHealthResult> => {
      const startedAt = Date.now()
      try {
        if (stored.requiresApiKey && !effectiveApiKey) {
          throw new Error(`API key is required for provider ${stored.label}`)
        }

        const model = createLanguageModel(input.providerId, {
          baseUrl,
          modelId,
          apiKey: effectiveApiKey ?? undefined,
        })

        const stream = streamText(model, {
          messages: [{ role: 'user', content: 'ping' }],
          maxTokens: 8,
          maxSteps: 1,
          signal: AbortSignal.timeout(10_000),
        })

        for await (const event of stream) {
          if (event.type === 'error') {
            throw new Error(event.error)
          }
        }

        const verifiedAt = Date.now()
        const latencyMs = Math.max(0, verifiedAt - startedAt)

        const docToUpdate = loadProvidersForMutation()
        docToUpdate.providers[input.providerId] = {
          ...docToUpdate.providers[input.providerId],
          lastVerifiedAt: verifiedAt,
          lastError: null,
        }
        writeAtomicWithBackup(providersFilePath, JSON.stringify(docToUpdate, null, 2))

        return {
          ok: true,
          providerId: input.providerId,
          modelId,
          latencyMs,
          verifiedAt,
        }
      } catch (err) {
        const verifiedAt = Date.now()
        const latencyMs = Math.max(0, verifiedAt - startedAt)
        const errorMessage = err instanceof Error ? err.message : String(err)

        const docToUpdate = loadProvidersForMutation()
        docToUpdate.providers[input.providerId] = {
          ...docToUpdate.providers[input.providerId],
          lastError: errorMessage,
        }
        writeAtomicWithBackup(providersFilePath, JSON.stringify(docToUpdate, null, 2))

        return {
          ok: false,
          providerId: input.providerId,
          modelId,
          latencyMs,
          error: errorMessage,
          verifiedAt,
        }
      }
    })().finally(() => {
      inFlightProbes.delete(dedupeKey)
    })

    inFlightProbes.set(dedupeKey, probePromise)
    return probePromise
  }

  return {
    providersFilePath,
    secretsFilePath,
    getPublicState,
    saveProviderConfig,
    setActiveProvider,
    getDecryptedApiKey,
    createLanguageModel,
    createActiveLanguageModel,
    testProviderConnection,
  }
}
