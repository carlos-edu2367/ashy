import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as v from 'valibot'
import {
  FALLBACK_PROVIDER_MODELS,
  inferModelOmniCapabilities,
  OMNI_EXECUTION_MODES,
  type OmniExecutionMode,
  ListProviderModelsInputSchema,
  LLM_PROVIDER_IDS,
  maskApiKey,
  REASONING_EFFORT_LEVELS,
  SaveProviderConfigInputSchema,
  TestProviderInputSchema,
  type AshyBootstrapSnapshot,
  type ConfigDiagnostics,
  type ListProviderModelsInput,
  type ListProviderModelsResult,
  type LlmProviderId,
  type ProviderHealthResult,
  type ProviderModelCatalogItem,
  type PublicProviderConfig,
  type ReasoningEffort,
  type SaveProviderConfigInput,
  type TestProviderInput,
} from '@ashy/shared'
import {
  createAnthropicMessagesModel,
  createOpenAICompatibleModel,
  streamText,
  type LanguageModel,
} from '@ashy/llm'
import {
  readWithAutoHeal,
  removeFileAtomicWithBackups,
  writeAtomicWithBackup,
} from './atomic-file'
import { createNodeAesSecretProtector, type SecretProtector } from './secret-protector'

interface StoredProviderEntry {
  providerId: LlmProviderId
  label: string
  baseUrl: string
  modelId: string
  reasoningEffort: ReasoningEffort
  requiresApiKey: boolean
  lastVerifiedAt: number | null
  lastError: string | null
  omniExecutionMode?: OmniExecutionMode
  omniVoiceId?: string
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
    reasoningEffort: 'none',
    requiresApiKey: true,
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    modelId: 'claude-3-7-sonnet-latest',
    reasoningEffort: 'none',
    requiresApiKey: true,
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'gpt-4o-mini',
    reasoningEffort: 'none',
    requiresApiKey: true,
  },
  'nvidia-nim': {
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    modelId: 'meta/llama-3.3-70b-instruct',
    reasoningEffort: 'none',
    requiresApiKey: true,
  },
  ollama: {
    label: 'Ollama (Local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelId: 'qwen2.5:14b',
    reasoningEffort: 'none',
    requiresApiKey: false,
  },
}

export { FALLBACK_PROVIDER_MODELS }

function isLlmProviderId(value: unknown): value is LlmProviderId {
  return typeof value === 'string' && (LLM_PROVIDER_IDS as readonly string[]).includes(value)
}

function isOmniExecutionMode(value: unknown): value is OmniExecutionMode {
  return typeof value === 'string' && (OMNI_EXECUTION_MODES as readonly string[]).includes(value)
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORT_LEVELS as readonly string[]).includes(value)
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
      reasoningEffort: def.reasoningEffort,
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

    const reasoningEffort: ReasoningEffort = isReasoningEffort(entry.reasoningEffort)
      ? entry.reasoningEffort
      : def.reasoningEffort

    providers[id] = {
      providerId: id,
      label: def.label,
      baseUrl,
      modelId,
      reasoningEffort,
      requiresApiKey: def.requiresApiKey,
      lastVerifiedAt:
        typeof entry.lastVerifiedAt === 'number' && Number.isFinite(entry.lastVerifiedAt)
          ? entry.lastVerifiedAt
          : null,
      lastError: typeof entry.lastError === 'string' ? entry.lastError : null,
      ...(isOmniExecutionMode(entry.omniExecutionMode)
        ? { omniExecutionMode: entry.omniExecutionMode }
        : {}),
      ...(typeof entry.omniVoiceId === 'string' && entry.omniVoiceId.trim().length > 0
        ? { omniVoiceId: entry.omniVoiceId.trim() }
        : {}),
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
  reasoningEffort?: ReasoningEffort
  apiKey?: string
}

export type ProviderVaultPublicState = AshyBootstrapSnapshot['providers']

export interface ProviderVault {
  readonly providersFilePath: string
  readonly secretsFilePath: string
  getPublicState(): AshyBootstrapSnapshot['providers']
  saveProviderConfig(input: SaveProviderConfigInput): PublicProviderConfig
  setActiveProvider(providerId: LlmProviderId): AshyBootstrapSnapshot['providers']
  resetAll(): ProviderVaultPublicState
  getDecryptedApiKey(providerId: LlmProviderId): string | null
  createLanguageModel(
    providerId?: LlmProviderId,
    overrides?: ProviderModelOverrides,
  ): LanguageModel
  createActiveLanguageModel(): LanguageModel
  testProviderConnection(input: TestProviderInput): Promise<ProviderHealthResult>
  listProviderModels(input: ListProviderModelsInput): Promise<ListProviderModelsResult>
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
  const inFlightCatalogRequests = new Map<string, Promise<ListProviderModelsResult>>()
  const decryptedKeyCache = new Map<string, string | null>()

  function validateHttpBaseUrl(rawUrl: string): URL {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(rawUrl)
    } catch {
      throw new Error(`Invalid provider baseUrl: ${rawUrl}`)
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Invalid provider baseUrl protocol: ${parsedUrl.protocol}`)
    }
    return parsedUrl
  }

  function resolveEffectiveApiKey(
    providerId: LlmProviderId,
    storedBaseUrl: string,
    effectiveBaseUrl: string,
    inputApiKey?: string,
  ): string | null {
    if (typeof inputApiKey === 'string' && inputApiKey.trim().length > 0) {
      return inputApiKey.trim()
    }
    try {
      const storedOrigin = new URL(storedBaseUrl).origin
      const targetOrigin = new URL(effectiveBaseUrl).origin
      if (storedOrigin !== targetOrigin) {
        return null
      }
    } catch {
      return null
    }
    return getDecryptedApiKey(providerId)
  }

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
    const normalizedCipherText = cipherText.trim()
    if (decryptedKeyCache.has(normalizedCipherText)) {
      return decryptedKeyCache.get(normalizedCipherText) ?? null
    }
    try {
      const decrypted = secretProtector.decrypt(normalizedCipherText).trim()
      const result = decrypted.length > 0 ? decrypted : null
      if (decryptedKeyCache.size >= 64) {
        const firstKey = decryptedKeyCache.keys().next().value
        if (firstKey !== undefined) {
          decryptedKeyCache.delete(firstKey)
        }
      }
      decryptedKeyCache.set(normalizedCipherText, result)
      return result
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
      reasoningEffort: entry.reasoningEffort,
      requiresApiKey: entry.requiresApiKey,
      hasApiKey,
      maskedApiKey: hasApiKey ? maskApiKey(decryptedKey) : null,
      lastVerifiedAt: entry.lastVerifiedAt,
      lastError: entry.lastError,
      ...inferModelOmniCapabilities(entry.providerId, entry.modelId),
      omniExecutionMode:
        entry.omniExecutionMode ??
        (inferModelOmniCapabilities(entry.providerId, entry.modelId).supportsOmniAudioOut
          ? 'native-omni'
          : inferModelOmniCapabilities(entry.providerId, entry.modelId).supportsOmniAudioIn
            ? 'hybrid-omni-in'
            : 'modular'),
      omniVoiceId:
        entry.omniVoiceId ??
        (/lfm3|lfm2|liquid/i.test(entry.modelId) ? 'female' : 'coral'),
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
    const {
      providerId,
      baseUrl,
      modelId,
      reasoningEffort,
      omniExecutionMode,
      omniVoiceId,
      apiKey,
      clearApiKey,
    } = parsed

    const providersDoc = loadProvidersForMutation()
    const secretsDoc = loadSecretsForMutation()

    const existing = providersDoc.providers[providerId]
    const updatedEntry: StoredProviderEntry = {
      ...existing,
      baseUrl,
      modelId,
      reasoningEffort: reasoningEffort ?? existing.reasoningEffort ?? 'none',
      ...(omniExecutionMode ?? existing.omniExecutionMode
        ? { omniExecutionMode: omniExecutionMode ?? existing.omniExecutionMode }
        : {}),
      ...(omniVoiceId ?? existing.omniVoiceId
        ? { omniVoiceId: omniVoiceId ?? existing.omniVoiceId }
        : {}),
    }
    providersDoc.providers[providerId] = updatedEntry

    const prevCipher = secretsDoc.secrets[providerId]?.trim()
    if (clearApiKey === true) {
      if (prevCipher) {
        decryptedKeyCache.delete(prevCipher)
      }
      delete secretsDoc.secrets[providerId]
      writeAtomicWithBackup(secretsFilePath, JSON.stringify(secretsDoc, null, 2))
    } else if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
      if (prevCipher) {
        decryptedKeyCache.delete(prevCipher)
      }
      const trimmedKey = apiKey.trim()
      const encrypted = secretProtector.encrypt(trimmedKey)
      secretsDoc.secrets[providerId] = encrypted
      decryptedKeyCache.set(encrypted.trim(), trimmedKey)
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
    const reasoningEffort: ReasoningEffort =
      overrides?.reasoningEffort ?? stored.reasoningEffort ?? 'none'
    const apiKey =
      resolveEffectiveApiKey(targetProviderId, stored.baseUrl, baseUrl, overrides?.apiKey) ??
      undefined

    if (targetProviderId === 'anthropic') {
      return createAnthropicMessagesModel({
        baseUrl,
        apiKey,
        model: modelId,
        reasoningEffort,
        fetchImpl: options.fetchImpl,
      })
    }

    return createOpenAICompatibleModel({
      baseUrl,
      apiKey,
      model: modelId,
      reasoningEffort,
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
    const reasoningEffort: ReasoningEffort =
      input.reasoningEffort ?? stored.reasoningEffort ?? 'none'
    const effectiveApiKey = resolveEffectiveApiKey(
      input.providerId,
      stored.baseUrl,
      baseUrl,
      input.apiKey,
    )

    const dedupeKey = crypto
      .createHash('sha256')
      .update(`${input.providerId}|${baseUrl}|${modelId}|${reasoningEffort}|${effectiveApiKey ?? ''}`)
      .digest('hex')

    const existingProbe = inFlightProbes.get(dedupeKey)
    if (existingProbe) {
      return existingProbe
    }

    const probePromise = (async (): Promise<ProviderHealthResult> => {
      const startedAt = Date.now()
      try {
        validateHttpBaseUrl(baseUrl)
        if (stored.requiresApiKey && !effectiveApiKey) {
          throw new Error(`API key is required for provider ${stored.label}`)
        }

        const model = createLanguageModel(input.providerId, {
          baseUrl,
          modelId,
          reasoningEffort: 'none',
          apiKey: effectiveApiKey ?? undefined,
        })

        const stream = streamText(model, {
          messages: [{ role: 'user', content: 'ping' }],
          maxTokens: 8,
          maxSteps: 1,
          reasoningEffort: 'none',
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

  function listProviderModels(
    rawInput: ListProviderModelsInput,
  ): Promise<ListProviderModelsResult> {
    const input = v.parse(ListProviderModelsInputSchema, rawInput)
    const providersDoc = fs.existsSync(providersFilePath)
      ? readProvidersWithHeal().value
      : createDefaultProvidersDocument()
    const stored = providersDoc.providers[input.providerId]

    const baseUrl =
      typeof input.baseUrl === 'string' && input.baseUrl.trim().length > 0
        ? input.baseUrl.trim()
        : stored.baseUrl
    const effectiveApiKey = resolveEffectiveApiKey(
      input.providerId,
      stored.baseUrl,
      baseUrl,
      input.apiKey,
    )

    const dedupeKey = crypto
      .createHash('sha256')
      .update(`${input.providerId}|${baseUrl}|${effectiveApiKey ?? ''}`)
      .digest('hex')

    const existingRequest = inFlightCatalogRequests.get(dedupeKey)
    if (existingRequest) {
      return existingRequest
    }

    const fetchFn: typeof fetch =
      options.fetchImpl ?? ((...args) => globalThis.fetch(...args))

    function parseOpenAiCompatibleData(
      rawList: unknown,
      providerId: LlmProviderId,
    ): ProviderModelCatalogItem[] {
      if (!Array.isArray(rawList)) return []
      const seen = new Set<string>()
      const items: ProviderModelCatalogItem[] = []
      for (const rawItem of rawList) {
        if (items.length >= 500) break
        if (typeof rawItem !== 'object' || rawItem === null) continue
        const obj = rawItem as Record<string, unknown>
        const id = typeof obj.id === 'string' ? obj.id.trim() : ''
        if (!id || id.length > 256 || seen.has(id)) continue
        seen.add(id)
        const rawName =
          typeof obj.display_name === 'string' && obj.display_name.trim().length > 0
            ? obj.display_name.trim()
            : typeof obj.name === 'string' && obj.name.trim().length > 0
              ? obj.name.trim()
              : id
        const name = rawName.slice(0, 256)
        const rawContext =
          typeof obj.context_length === 'number' && Number.isFinite(obj.context_length)
            ? obj.context_length
            : typeof obj.contextLength === 'number' && Number.isFinite(obj.contextLength)
              ? obj.contextLength
              : null
        const contextLength = rawContext !== null ? Math.max(0, Math.trunc(rawContext)) : null
        const supportedParams = Array.isArray(obj.supported_parameters)
          ? obj.supported_parameters.filter((p): p is string => typeof p === 'string')
          : null

        items.push({
          id,
          name,
          providerId,
          contextLength,
          ...inferModelOmniCapabilities(providerId, id),
          ...(supportedParams
            ? {
                supportsTools: supportedParams.includes('tools'),
                supportsReasoning:
                  supportedParams.includes('reasoning') ||
                  supportedParams.includes('include_reasoning'),
              }
            : {}),
        })
      }
      return items
    }

    const catalogPromise = (async (): Promise<ListProviderModelsResult> => {
      try {
        validateHttpBaseUrl(baseUrl)
        if (stored.requiresApiKey && !effectiveApiKey) {
          throw new Error(`API key is required for provider ${stored.label}`)
        }

        if (input.providerId === 'ollama') {
          const tagsBase = baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
          const tagsUrl = `${tagsBase}/api/tags`
          let models: ProviderModelCatalogItem[] = []
          let tagsError: string | null = null

          try {
            const tagsRes = await fetchFn(tagsUrl, {
              method: 'GET',
              signal: AbortSignal.timeout(8_000),
            })
            if (!tagsRes.ok) {
              tagsError = `HTTP ${tagsRes.status}: ${tagsRes.statusText || 'Failed to fetch Ollama tags'}`
            } else {
              const tagsJson = (await tagsRes.json()) as Record<string, unknown>
              if (Array.isArray(tagsJson?.models)) {
                const seen = new Set<string>()
                for (const rawModel of tagsJson.models) {
                  if (models.length >= 500) break
                  if (typeof rawModel !== 'object' || rawModel === null) continue
                  const m = rawModel as Record<string, unknown>
                  const id =
                    typeof m.model === 'string' && m.model.trim().length > 0
                      ? m.model.trim()
                      : typeof m.name === 'string' && m.name.trim().length > 0
                        ? m.name.trim()
                        : ''
                  if (!id || id.length > 256 || seen.has(id)) continue
                  seen.add(id)
                  const rawName =
                    typeof m.name === 'string' && m.name.trim().length > 0 ? m.name.trim() : id
                  models.push({
                    id,
                    name: rawName.slice(0, 256),
                    providerId: 'ollama',
                    contextLength: null,
                    ...inferModelOmniCapabilities('ollama', id),
                  })
                }
              }
            }
          } catch (err) {
            tagsError = err instanceof Error ? err.message : String(err)
          }

          if (models.length === 0 && !tagsError) {
            const openAiModelsUrl = `${baseUrl.replace(/\/+$/, '')}/models`
            const fallbackRes = await fetchFn(openAiModelsUrl, {
              method: 'GET',
              signal: AbortSignal.timeout(8_000),
            })
            if (!fallbackRes.ok) {
              throw new Error(
                `HTTP ${fallbackRes.status}: ${fallbackRes.statusText || 'Failed to fetch Ollama models'}`,
              )
            }
            const fallbackJson = (await fallbackRes.json()) as Record<string, unknown>
            models = parseOpenAiCompatibleData(fallbackJson?.data, 'ollama')
          }

          if (tagsError && models.length === 0) {
            throw new Error(tagsError)
          }
          if (models.length === 0) {
            throw new Error('No local models installed in Ollama')
          }

          return {
            providerId: 'ollama',
            models,
            source: 'remote',
            fetchedAt: Date.now(),
            error: null,
          }
        }

        if (input.providerId === 'anthropic') {
          const modelsUrl = `${baseUrl.replace(/\/+$/, '')}/models`
          const res = await fetchFn(modelsUrl, {
            method: 'GET',
            headers: {
              'x-api-key': effectiveApiKey ?? '',
              'anthropic-version': '2023-06-01',
            },
            signal: AbortSignal.timeout(8_000),
          })
          if (!res.ok) {
            throw new Error(
              `HTTP ${res.status}: ${res.statusText || 'Failed to fetch Anthropic models'}`,
            )
          }
          const json = (await res.json()) as Record<string, unknown>
          const models = parseOpenAiCompatibleData(json?.data, 'anthropic')
          if (models.length === 0) {
            throw new Error('Anthropic API returned no models')
          }
          return {
            providerId: 'anthropic',
            models,
            source: 'remote',
            fetchedAt: Date.now(),
            error: null,
          }
        }

        const modelsUrl = `${baseUrl.replace(/\/+$/, '')}/models`
        const headers: Record<string, string> = {}
        if (effectiveApiKey) {
          headers.Authorization = `Bearer ${effectiveApiKey}`
        }
        const res = await fetchFn(modelsUrl, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(8_000),
        })
        if (!res.ok) {
          throw new Error(
            `HTTP ${res.status}: ${res.statusText || `Failed to fetch ${stored.label} models`}`,
          )
        }
        const json = (await res.json()) as Record<string, unknown>
        const models = parseOpenAiCompatibleData(json?.data, input.providerId)
        if (models.length === 0) {
          throw new Error(`${stored.label} API returned no models`)
        }

        return {
          providerId: input.providerId,
          models,
          source: 'remote',
          fetchedAt: Date.now(),
          error: null,
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        return {
          providerId: input.providerId,
          models: FALLBACK_PROVIDER_MODELS[input.providerId].map((m) => ({ ...m })),
          source: 'fallback',
          fetchedAt: Date.now(),
          error: errorMessage,
        }
      }
    })().finally(() => {
      inFlightCatalogRequests.delete(dedupeKey)
    })

    inFlightCatalogRequests.set(dedupeKey, catalogPromise)
    return catalogPromise
  }

  function resetAll(): ProviderVaultPublicState {
    decryptedKeyCache.clear()
    inFlightProbes.clear()
    inFlightCatalogRequests.clear()
    removeFileAtomicWithBackups(secretsFilePath, 3)
    removeFileAtomicWithBackups(providersFilePath, 3)
    writeAtomicWithBackup(providersFilePath, defaultProvidersJson, { rotateBackup: false })
    writeAtomicWithBackup(secretsFilePath, defaultSecretsJson, { rotateBackup: false })
    return getPublicState()
  }

  function _unusedPlaceholder() {
    return null
  
  }

  return {
    providersFilePath,
    secretsFilePath,
    getPublicState,
    saveProviderConfig,
    setActiveProvider,
    resetAll,
    getDecryptedApiKey,
    createLanguageModel,
    createActiveLanguageModel,
    testProviderConnection,
    listProviderModels,
  }
}
