import { LIVE_CALL_METHODS, type LiveCallMethod } from '@ashy/shared'

export const LIVE_CALL_METHOD_UNAVAILABLE = 'LIVE_CALL_METHOD_UNAVAILABLE' as const

export type LiveCallHandler = (payload: unknown) => Promise<unknown> | unknown

/** Thrown when a Live Call method is unknown or has no registered handler. */
export class LiveCallMethodUnavailableError extends Error {
  readonly code = LIVE_CALL_METHOD_UNAVAILABLE
  readonly method: string

  constructor(method: unknown) {
    super(`${LIVE_CALL_METHOD_UNAVAILABLE}: ${String(method)}`)
    this.name = 'LiveCallMethodUnavailableError'
    this.method = String(method)
  }
}

export interface LiveCallRegistry {
  /** Registers (or replaces) the handler for a method. Returns an unregister function. */
  register(method: LiveCallMethod, handler: LiveCallHandler): () => void
  invoke(method: string, payload?: unknown): Promise<unknown>
  has(method: string): boolean
}

const KNOWN_METHODS = new Set<string>(LIVE_CALL_METHODS)

export function createLiveCallRegistry(): LiveCallRegistry {
  const handlers = new Map<LiveCallMethod, LiveCallHandler>()

  return {
    register(method, handler) {
      if (!KNOWN_METHODS.has(method)) {
        throw new LiveCallMethodUnavailableError(method)
      }
      if (typeof handler !== 'function') {
        throw new TypeError(`Live Call handler for ${method} must be a function`)
      }
      handlers.set(method, handler)
      return () => {
        if (handlers.get(method) === handler) {
          handlers.delete(method)
        }
      }
    },

    async invoke(method, payload) {
      const handler = KNOWN_METHODS.has(method)
        ? handlers.get(method as LiveCallMethod)
        : undefined
      if (!handler) {
        throw new LiveCallMethodUnavailableError(method)
      }
      return handler(payload)
    },

    has(method) {
      return KNOWN_METHODS.has(method) && handlers.has(method as LiveCallMethod)
    },
  }
}
