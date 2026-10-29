import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Plugin } from 'vite'
import type {
  AshyHostBridge,
  CompleteOnboardingInput,
  LlmProviderId,
  SaveProviderConfigInput,
  SendTurnInput,
  TestProviderInput,
  UpsertFactInput,
} from '@ashy/shared'
import { createAshyHostKernel, type AshyHostKernel } from './kernel'
import { createNodeAesSecretProtector, type SecretProtector } from './secret-protector'

const MAX_RPC_BODY_BYTES = 2 * 1024 * 1024

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
  'deleteMemoryItem',
  'seedDemoFixtures',
])

export class DisallowedRpcMethodError extends Error {
  constructor(method: unknown) {
    super(`Unsupported or disallowed AshyHost RPC method: ${String(method)}`)
    this.name = 'DisallowedRpcMethodError'
  }
}

function extractStringArg(payload: unknown, fieldName: string): string {
  if (typeof payload === 'string' && payload.trim().length > 0) {
    return payload
  }
  if (
    payload !== null &&
    typeof payload === 'object' &&
    fieldName in payload &&
    typeof (payload as Record<string, unknown>)[fieldName] === 'string' &&
    ((payload as Record<string, string>)[fieldName] ?? '').trim().length > 0
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
              'title' in payload &&
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

    case 'deleteMemoryItem': {
      const obj = assertObjectPayload<{
        kind: 'fact' | 'episode' | 'joke'
        id: string
      }>(payload, method)
      if (
        (obj.kind !== 'fact' && obj.kind !== 'episode' && obj.kind !== 'joke') ||
        typeof obj.id !== 'string' ||
        obj.id.trim().length === 0
      ) {
        throw new Error('Invalid RPC argument for deleteMemoryItem: expected { kind: fact|episode|joke, id: string }')
      }
      return kernel.deleteMemoryItem(obj)
    }

    case 'seedDemoFixtures':
      return kernel.seedDemoFixtures()

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

  function getOrStartKernel(): Promise<AshyHostKernel> {
    if (!kernelPromise) {
      const userDataDir =
        options.userDataDir ??
        process.env.ASHY_USER_DATA_DIR ??
        path.resolve(process.cwd(), '.ashy-data')
      const secretProtector =
        options.secretProtector ?? createNodeAesSecretProtector(userDataDir)
      kernelPromise = createAshyHostKernel({
        userDataDir,
        secretProtector,
        fetchImpl: options.fetchImpl,
      })
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
