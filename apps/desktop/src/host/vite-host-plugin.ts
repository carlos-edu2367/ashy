import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Plugin } from 'vite'
import type {
  ApprovableMemoryKind,
  AshyEmotion,
  AshyHostBridge,
  AutobiographicalMilestone,
  CompleteOnboardingInput,
  DeletableMemoryKind,
  EpisodicMemory,
  LlmProviderId,
  MemoryGovernanceCategory,
  PersonalityEvolutionRecord,
  PersonalityTraits,
  ProspectiveIntent,
  RelationalMotif,
  RunCoreExperimentInput,
  SaveProviderConfigInput,
  SendTurnInput,
  TestProviderInput,
  UpsertFactInput,
} from '@ashy/shared'
import type { AshyHostKernel, AshyHostKernelOptions } from './kernel'
import { createNodeAesSecretProtector, type SecretProtector } from './secret-protector'

const MAX_RPC_BODY_BYTES = 2 * 1024 * 1024

const VALID_DELETABLE_MEMORY_KINDS: readonly DeletableMemoryKind[] = [
  'fact',
  'episode',
  'joke',
  'habit',
  'intent',
  'milestone',
]

const VALID_APPROVABLE_MEMORY_KINDS: readonly ApprovableMemoryKind[] = [
  'fact',
  'episode',
  'joke',
  'habit',
  'intent',
]

const VALID_MEMORY_GOVERNANCE_CATEGORIES: readonly MemoryGovernanceCategory[] = [
  'facts',
  'episodes',
  'jokes',
  'habits',
  'intents',
]

const ALLOWED_RPC_METHODS = new Set<string>([
  'getBootstrapSnapshot',
  'completeOnboarding',
  'createSession',
  'selectSession',
  'sendTurn',
  'abortTurn',
  'saveProviderConfig',
  'setActiveProvider',
  'testProviderConnection',
  'saveVoiceIdentity',
  'resetVoiceIdentity',
  'upsertSemanticFact',
  'upsertEpisodicMemory',
  'upsertMilestone',
  'upsertRelationalMotif',
  'upsertProspectiveIntent',
  'recordEmotionPulse',
  'persistDreamConsolidation',
  'persistTraitRevert',
  'deleteMemoryItem',
  'consolidateSessionMemories',
  'approveMemoryItem',
  'setMemoryGovernancePolicy',
  'seedDemoFixtures',
  'runCoreExperimentEval',
])

export class DisallowedRpcMethodError extends Error {
  constructor(method: unknown) {
    super(`Unsupported or disallowed AshyHost RPC method: ${String(method)}`)
    this.name = 'DisallowedRpcMethodError'
  }
}

function isValidRpcIdString(val: unknown): val is string {
  return (
    typeof val === 'string' &&
    val.trim().length > 0 &&
    val.length <= 256 &&
    !val.includes('\0')
  )
}

function extractStringArg(payload: unknown, fieldName: string): string {
  if (typeof payload === 'string' && payload.trim().length > 0 && !payload.includes('\0')) {
    return payload
  }
  if (
    payload !== null &&
    typeof payload === 'object' &&
    Object.prototype.hasOwnProperty.call(payload, fieldName) &&
    typeof (payload as Record<string, unknown>)[fieldName] === 'string' &&
    ((payload as Record<string, string>)[fieldName] ?? '').trim().length > 0 &&
    !((payload as Record<string, string>)[fieldName] ?? '').includes('\0')
  ) {
    return (payload as Record<string, string>)[fieldName]!
  }
  throw new Error(`Invalid RPC argument: expected non-empty string or { ${fieldName}: string }`)
}

function assertObjectPayload<T extends object>(
  payload: unknown,
  method: string,
): T {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Invalid RPC argument for ${method}: expected object payload`)
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, '__proto__') ||
    Object.prototype.hasOwnProperty.call(payload, 'constructor') ||
    Object.prototype.hasOwnProperty.call(payload, 'prototype')
  ) {
    throw new Error(
      `Invalid RPC argument for ${method}: forbidden prototype-pollution property`,
    )
  }
  return payload as T
}

export async function dispatchHostRpc(
  kernel: AshyHostBridge,
  method: string,
  payload: unknown,
): Promise<unknown> {
  if (typeof method !== 'string' || !ALLOWED_RPC_METHODS.has(method)) {
    throw new DisallowedRpcMethodError(method)
  }

  switch (method) {
    case 'getBootstrapSnapshot':
      return kernel.getBootstrapSnapshot()

    case 'completeOnboarding':
      return kernel.completeOnboarding(
        assertObjectPayload<CompleteOnboardingInput>(payload, method),
      )

    case 'createSession': {
      const title =
        typeof payload === 'string'
          ? payload
          : payload !== null &&
              typeof payload === 'object' &&
              Object.prototype.hasOwnProperty.call(payload, 'title') &&
              typeof (payload as { title?: unknown }).title === 'string'
            ? (payload as { title: string }).title
            : undefined
      return kernel.createSession(title)
    }

    case 'selectSession':
      return kernel.selectSession(extractStringArg(payload, 'sessionId'))

    case 'sendTurn':
      return kernel.sendTurn(assertObjectPayload<SendTurnInput>(payload, method))

    case 'abortTurn':
      return kernel.abortTurn(extractStringArg(payload, 'turnId'))

    case 'saveProviderConfig':
      return kernel.saveProviderConfig(
        assertObjectPayload<SaveProviderConfigInput>(payload, method),
      )

    case 'setActiveProvider':
      return kernel.setActiveProvider(
        extractStringArg(payload, 'providerId') as LlmProviderId,
      )

    case 'testProviderConnection':
      return kernel.testProviderConnection(
        assertObjectPayload<TestProviderInput>(payload, method),
      )

    case 'saveVoiceIdentity':
      return kernel.saveVoiceIdentity(extractStringArg(payload, 'content'))

    case 'resetVoiceIdentity':
      return kernel.resetVoiceIdentity()

    case 'upsertSemanticFact': {
      const obj = assertObjectPayload<UpsertFactInput>(payload, method)
      if (
        typeof obj.category !== 'string' ||
        typeof obj.subject !== 'string' ||
        typeof obj.predicate !== 'string' ||
        typeof obj.object !== 'string'
      ) {
        throw new Error('Invalid RPC argument for upsertSemanticFact: missing required string fields')
      }
      return kernel.upsertSemanticFact(obj)
    }

    case 'upsertEpisodicMemory':
      return kernel.upsertEpisodicMemory(
        assertObjectPayload<EpisodicMemory>(payload, method),
      )

    case 'upsertMilestone':
      return kernel.upsertMilestone(
        assertObjectPayload<AutobiographicalMilestone>(payload, method),
      )

    case 'upsertRelationalMotif':
      return kernel.upsertRelationalMotif(
        assertObjectPayload<RelationalMotif>(payload, method),
      )

    case 'upsertProspectiveIntent':
      return kernel.upsertProspectiveIntent(
        assertObjectPayload<ProspectiveIntent>(payload, method),
      )

    case 'recordEmotionPulse':
      return kernel.recordEmotionPulse(
        assertObjectPayload<{ emotion: AshyEmotion; intensity?: number }>(payload, method),
      )

    case 'persistDreamConsolidation':
      return kernel.persistDreamConsolidation(
        assertObjectPayload<{
          episode: EpisodicMemory
          traits: PersonalityTraits
          record: PersonalityEvolutionRecord
        }>(payload, method),
      )

    case 'persistTraitRevert':
      return kernel.persistTraitRevert(
        assertObjectPayload<{
          traits: PersonalityTraits
          record: PersonalityEvolutionRecord
        }>(payload, method),
      )

    case 'deleteMemoryItem': {
      const obj = assertObjectPayload<{
        kind: DeletableMemoryKind
        id: string
      }>(payload, method)
      if (
        !VALID_DELETABLE_MEMORY_KINDS.includes(obj.kind) ||
        !isValidRpcIdString(obj.id)
      ) {
        throw new Error(
          'Invalid RPC argument for deleteMemoryItem: expected { kind: fact|episode|joke|habit|intent|milestone, id: string }',
        )
      }
      return kernel.deleteMemoryItem(obj)
    }

    case 'consolidateSessionMemories': {
      if (payload === undefined || payload === null) {
        return kernel.consolidateSessionMemories()
      }
      const obj = assertObjectPayload<{
        sessionId?: string
        force?: boolean
      }>(payload, method)
      if (
        (obj.sessionId !== undefined &&
          (typeof obj.sessionId !== 'string' ||
            obj.sessionId.length > 256 ||
            obj.sessionId.includes('\0'))) ||
        (obj.force !== undefined && typeof obj.force !== 'boolean')
      ) {
        throw new Error(
          'Invalid RPC argument for consolidateSessionMemories: expected { sessionId?: string, force?: boolean }',
        )
      }
      return kernel.consolidateSessionMemories(obj)
    }

    case 'approveMemoryItem': {
      const obj = assertObjectPayload<{
        kind: ApprovableMemoryKind
        id: string
      }>(payload, method)
      if (
        !VALID_APPROVABLE_MEMORY_KINDS.includes(obj.kind) ||
        !isValidRpcIdString(obj.id)
      ) {
        throw new Error(
          'Invalid RPC argument for approveMemoryItem: expected { kind: fact|episode|joke|habit|intent, id: string }',
        )
      }
      return kernel.approveMemoryItem(obj)
    }

    case 'setMemoryGovernancePolicy': {
      const obj = assertObjectPayload<{
        category: MemoryGovernanceCategory
        requireConfirmation: boolean
      }>(payload, method)
      if (
        !VALID_MEMORY_GOVERNANCE_CATEGORIES.includes(obj.category) ||
        typeof obj.requireConfirmation !== 'boolean'
      ) {
        throw new Error(
          'Invalid RPC argument for setMemoryGovernancePolicy: expected { category: facts|episodes|jokes|habits|intents, requireConfirmation: boolean }',
        )
      }
      return kernel.setMemoryGovernancePolicy(obj)
    }

    case 'seedDemoFixtures':
      return kernel.seedDemoFixtures()

    case 'runCoreExperimentEval': {
      if (payload === undefined || payload === null) {
        return kernel.runCoreExperimentEval()
      }
      const obj = assertObjectPayload<RunCoreExperimentInput>(payload, method)
      if (
        obj.seed !== undefined &&
        (typeof obj.seed !== 'number' ||
          !Number.isInteger(obj.seed) ||
          obj.seed < 0 ||
          obj.seed > 999)
      ) {
        throw new Error(
          'Invalid RPC argument for runCoreExperimentEval: expected integer seed in 0..999',
        )
      }
      if (
        obj.modelAId !== undefined &&
        (typeof obj.modelAId !== 'string' ||
          obj.modelAId.trim().length === 0 ||
          obj.modelAId.length > 160 ||
          /[\x00-\x1f\x7f]/.test(obj.modelAId))
      ) {
        throw new Error(
          'Invalid RPC argument for runCoreExperimentEval: expected non-empty modelAId <= 160 chars without control characters',
        )
      }
      if (
        obj.modelBId !== undefined &&
        (typeof obj.modelBId !== 'string' ||
          obj.modelBId.trim().length === 0 ||
          obj.modelBId.length > 160 ||
          /[\x00-\x1f\x7f]/.test(obj.modelBId))
      ) {
        throw new Error(
          'Invalid RPC argument for runCoreExperimentEval: expected non-empty modelBId <= 160 chars without control characters',
        )
      }
      return kernel.runCoreExperimentEval({
        ...(obj.seed !== undefined ? { seed: obj.seed } : {}),
        ...(obj.modelAId !== undefined ? { modelAId: obj.modelAId.trim() } : {}),
        ...(obj.modelBId !== undefined ? { modelBId: obj.modelBId.trim() } : {}),
      })
    }

    default:
      throw new DisallowedRpcMethodError(method)
  }
}

function readJsonBody(req: IncomingMessage): Promise<{ method: string; payload?: unknown }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let aborted = false

    req.on('data', (chunk: Buffer | string) => {
      if (aborted) return
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      totalBytes += buf.byteLength
      if (totalBytes > MAX_RPC_BODY_BYTES) {
        aborted = true
        reject(new Error('RPC request payload exceeds maximum allowed size (2MB)'))
        return
      }
      chunks.push(buf)
    })

    req.on('end', () => {
      if (aborted) return
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        const parsed: unknown = raw.trim().length > 0 ? JSON.parse(raw) : null
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          typeof (parsed as { method?: unknown }).method !== 'string'
        ) {
          reject(new Error('Invalid RPC JSON body: expected { method: string, payload?: unknown }'))
          return
        }
        resolve(parsed as { method: string; payload?: unknown })
      } catch (err) {
        reject(
          err instanceof Error
            ? new Error(`Invalid RPC JSON body: ${err.message}`)
            : new Error('Invalid RPC JSON body'),
        )
      }
    })

    req.on('error', (err) => {
      if (!aborted) {
        aborted = true
        reject(err)
      }
    })
  })
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.writableEnded) return
  const payload = JSON.stringify(body)
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(payload)
}

const ALLOWED_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function parseHostHeaderHostname(rawHost: string): string {
  const trimmed = rawHost.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']')
    return closeIdx >= 0 ? trimmed.slice(0, closeIdx + 1) : trimmed
  }
  const colonIdx = trimmed.indexOf(':')
  return colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed
}

function isAllowedLoopbackRequest(req: IncomingMessage): { ok: true } | { ok: false; reason: string } {
  const hostHeader = req.headers.host
  if (typeof hostHeader === 'string' && hostHeader.trim().length > 0) {
    const hostname = parseHostHeaderHostname(hostHeader)
    if (!ALLOWED_LOOPBACK_HOSTS.has(hostname)) {
      return { ok: false, reason: 'Forbidden: non-loopback Host header (DNS rebinding protection)' }
    }
  }

  const secFetchSite = req.headers['sec-fetch-site']
  if (typeof secFetchSite === 'string' && secFetchSite.trim().toLowerCase() === 'cross-site') {
    return { ok: false, reason: 'Forbidden: cross-site request blocked' }
  }

  const originHeader = req.headers.origin
  if (typeof originHeader === 'string' && originHeader.trim().length > 0) {
    try {
      const parsedOrigin = new URL(originHeader)
      const originHost = parsedOrigin.hostname.toLowerCase()
      if (
        (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') ||
        !ALLOWED_LOOPBACK_HOSTS.has(originHost)
      ) {
        return { ok: false, reason: 'Forbidden: cross-origin request blocked' }
      }
    } catch {
      return { ok: false, reason: 'Forbidden: invalid Origin header' }
    }
  }

  return { ok: true }
}

function hasJsonContentType(req: IncomingMessage): boolean {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string') return false
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return mediaType === 'application/json'
}

export function createAshyHostHttpMiddleware(
  getKernel: () => Promise<AshyHostBridge>,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  return (req, res, next) => {
    const rawUrl = req.url ?? ''
    const pathname = rawUrl.split('?')[0]

    if (pathname === '/__ashy_host/events') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
        return
      }
      const check = isAllowedLoopbackRequest(req)
      if (!check.ok) {
        sendJson(res, 403, { ok: false, error: check.reason })
        return
      }

      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders?.()
      res.write(': connected\n\n')

      let closed = false
      let unsubscribe: (() => void) | null = null

      const cleanup = () => {
        if (closed) return
        closed = true
        unsubscribe?.()
        unsubscribe = null
      }

      req.on('close', cleanup)
      res.on('close', cleanup)

      void getKernel()
        .then((kernel) => {
          if (closed || res.writableEnded) return
          unsubscribe = kernel.onHostEvent((event) => {
            if (!closed && !res.writableEnded) {
              res.write(`data: ${JSON.stringify(event)}\n\n`)
            }
          })
        })
        .catch(() => {
          if (!res.writableEnded) {
            res.end()
          }
        })
      return
    }

    if (pathname === '/__ashy_host/rpc') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
        return
      }
      const check = isAllowedLoopbackRequest(req)
      if (!check.ok) {
        sendJson(res, 403, { ok: false, error: check.reason })
        return
      }
      if (!hasJsonContentType(req)) {
        sendJson(res, 415, {
          ok: false,
          error: 'Unsupported Media Type: expected application/json',
        })
        return
      }

      void (async () => {
        try {
          const body = await readJsonBody(req)
          const kernel = await getKernel()
          const result = await dispatchHostRpc(kernel, body.method, body.payload)
          sendJson(res, 200, { ok: true, result })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const isClientError =
            err instanceof DisallowedRpcMethodError ||
            message.startsWith('Invalid RPC') ||
            message.includes('maximum allowed size')
          sendJson(res, isClientError ? 400 : 500, {
            ok: false,
            error: message,
          })
        }
      })()
      return
    }

    next()
  }
}

export interface AshyViteHostPluginOptions {
  userDataDir?: string
  secretProtector?: SecretProtector
  fetchImpl?: typeof fetch
  kernel?: AshyHostKernel
}

export function createAshyViteHostPlugin(
  options: AshyViteHostPluginOptions = {},
): Plugin {
  let kernelPromise: Promise<AshyHostKernel> | null = options.kernel
    ? Promise.resolve(options.kernel)
    : null
  let ssrLoader: ((url: string) => Promise<Record<string, unknown>>) | null = null

  function getOrStartKernel(): Promise<AshyHostKernel> {
    if (!kernelPromise) {
      const userDataDir =
        options.userDataDir ??
        process.env.ASHY_USER_DATA_DIR ??
        path.resolve(process.cwd(), '.ashy-data')
      const secretProtector =
        options.secretProtector ?? createNodeAesSecretProtector(userDataDir)
      const kernelOptions: AshyHostKernelOptions = {
        userDataDir,
        secretProtector,
        fetchImpl: options.fetchImpl,
      }
      kernelPromise = (async () => {
        if (ssrLoader) {
          const mod = (await ssrLoader('/src/host/kernel.ts')) as {
            createAshyHostKernel: (opts: AshyHostKernelOptions) => Promise<AshyHostKernel>
          }
          return mod.createAshyHostKernel(kernelOptions)
        }
        const kernelSpecifier = './kernel'
        const mod = (await import(/* @vite-ignore */ kernelSpecifier)) as {
          createAshyHostKernel: (opts: AshyHostKernelOptions) => Promise<AshyHostKernel>
        }
        return mod.createAshyHostKernel(kernelOptions)
      })()
    }
    return kernelPromise
  }

  async function stopKernel(): Promise<void> {
    if (!kernelPromise) return
    const current = kernelPromise
    kernelPromise = null
    try {
      const kernel = await current
      await kernel.stop()
    } catch {
      // Ignore shutdown errors on dev server teardown
    }
  }

  const middleware = createAshyHostHttpMiddleware(getOrStartKernel)

  return {
    name: 'ashy-vite-host-plugin',
    configureServer(server) {
      ssrLoader = (url) => server.ssrLoadModule(url)
      server.middlewares.use(middleware)
      server.httpServer?.once('close', () => {
        void stopKernel()
      })
    },
    configurePreviewServer(previewServer) {
      previewServer.middlewares.use(middleware)
      previewServer.httpServer?.once('close', () => {
        void stopKernel()
      })
    },
  }
}
