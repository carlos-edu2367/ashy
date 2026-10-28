export class BusDisposedError extends Error {
  public readonly reason?: unknown

  constructor(reason?: unknown) {
    const detail = typeof reason === 'string' && reason.length > 0 ? `: ${reason}` : ''
    super(`EventBus has been disposed${detail}`)
    this.name = 'BusDisposedError'
    this.reason = reason
  }
}

export class RpcTimeoutError extends Error {
  constructor(rpcName: string, timeoutMs: number) {
    super(`RPC "${rpcName}" timeout: timed out after ${timeoutMs}ms`)
    this.name = 'RpcTimeoutError'
  }
}

export interface EventDefinition<TPayload = void> {
  readonly kind: 'event'
  readonly name: string
  readonly __payloadType?: TPayload
}

export interface RpcDefinition<TReq = void, TRes = void> {
  readonly kind: 'rpc'
  readonly name: string
  readonly __reqType?: TReq
  readonly __resType?: TRes
}

export interface StreamRpcDefinition<TReq = void, TChunk = unknown> {
  readonly kind: 'stream-rpc'
  readonly name: string
  readonly __reqType?: TReq
  readonly __chunkType?: TChunk
}

export function defineEvent<TPayload = void>(name: string): EventDefinition<TPayload> {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError('Event name must be a non-empty string')
  }
  return Object.freeze({ kind: 'event', name: name.trim() })
}

export function defineRpc<TReq = void, TRes = void>(name: string): RpcDefinition<TReq, TRes> {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError('RPC name must be a non-empty string')
  }
  return Object.freeze({ kind: 'rpc', name: name.trim() })
}

export function defineStreamRpc<TReq = void, TChunk = unknown>(
  name: string,
): StreamRpcDefinition<TReq, TChunk> {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError('Stream RPC name must be a non-empty string')
  }
  return Object.freeze({ kind: 'stream-rpc', name: name.trim() })
}

export interface EventEnvelope<TPayload = unknown> {
  deliveryId: string
  eventName: string
  payload: TPayload
  hopsRemaining: number
  timestamp: number
  originBusId: string
}

export interface EventBusOptions {
  id?: string
  maxHops?: number
  seenMaxSize?: number
  seenTtlMs?: number
}

export interface RpcInvokeOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface RpcHandlerContext {
  signal: AbortSignal
  deliveryId: string
}

export type EventHandler<TPayload> = (
  payload: TPayload,
  envelope: EventEnvelope<TPayload>,
) => void

export type RpcHandler<TReq, TRes> = (
  req: TReq,
  ctx: RpcHandlerContext,
) => TRes | Promise<TRes>

export type StreamRpcHandler<TReq, TChunk> = (
  req: TReq,
  ctx: RpcHandlerContext,
) => AsyncIterable<TChunk>

export interface StreamRpcIterator<TChunk> extends AsyncIterableIterator<TChunk> {
  toReadableStream(): ReadableStream<TChunk>
  cancel(reason?: unknown): void
}

export interface EventBus {
  readonly id: string
  readonly isDisposed: boolean
  readonly lifetimeSignal: AbortSignal
  on<TPayload>(
    event: EventDefinition<TPayload>,
    handler: EventHandler<TPayload>,
  ): () => void
  once<TPayload>(
    event: EventDefinition<TPayload>,
    handler: EventHandler<TPayload>,
  ): () => void
  emit<TPayload>(
    event: EventDefinition<TPayload>,
    payload: TPayload,
    options?: { hopsRemaining?: number; deliveryId?: string },
  ): EventEnvelope<TPayload> | null
  handleRpc<TReq, TRes>(
    rpc: RpcDefinition<TReq, TRes>,
    handler: RpcHandler<TReq, TRes>,
  ): () => void
  invokeRpc<TReq, TRes>(
    rpc: RpcDefinition<TReq, TRes>,
    req: TReq,
    options?: RpcInvokeOptions,
  ): Promise<TRes>
  handleStreamRpc<TReq, TChunk>(
    rpc: StreamRpcDefinition<TReq, TChunk>,
    handler: StreamRpcHandler<TReq, TChunk>,
  ): () => void
  invokeStreamRpc<TReq, TChunk>(
    rpc: StreamRpcDefinition<TReq, TChunk>,
    req: TReq,
    options?: RpcInvokeOptions,
  ): StreamRpcIterator<TChunk>
  dispose(reason?: unknown): void
  /** Internal hook for bridging buses */
  __receiveBridgePacket(packet: BridgePacket, fromBusId: string): void
  __subscribeBridge(listener: (packet: BridgePacket, sourceBusId: string) => void): () => void
  __hasLocalRpcHandler(name: string): boolean
  __hasLocalStreamRpcHandler(name: string): boolean
}

type BridgePacket =
  | { type: 'event'; envelope: EventEnvelope<unknown> }
  | {
      type: 'rpc-req'
      requestId: string
      rpcName: string
      req: unknown
      hopsRemaining: number
      originBusId: string
    }
  | {
      type: 'rpc-res'
      requestId: string
      ok: boolean
      res?: unknown
      error?: string
      hopsRemaining: number
    }
  | {
      type: 'rpc-abort'
      requestId: string
      hopsRemaining: number
    }
  | {
      type: 'stream-open'
      streamId: string
      rpcName: string
      req: unknown
      hopsRemaining: number
      originBusId: string
    }
  | {
      type: 'stream-chunk'
      streamId: string
      chunk: unknown
      hopsRemaining: number
    }
  | {
      type: 'stream-end'
      streamId: string
      error?: string
      hopsRemaining: number
    }
  | {
      type: 'stream-cancel'
      streamId: string
      hopsRemaining: number
    }

class LruTtlCache {
  private readonly map = new Map<string, number>()

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {}

  hasAndTouch(key: string, now = Date.now()): boolean {
    const expiresAt = this.map.get(key)
    if (expiresAt === undefined) {
      return false
    }
    if (now > expiresAt) {
      this.map.delete(key)
      return false
    }
    // Refresh LRU order
    this.map.delete(key)
    this.map.set(key, now + this.ttlMs)
    return true
  }

  add(key: string, now = Date.now()): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    }
    this.map.set(key, now + this.ttlMs)
    while (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey === undefined) break
      this.map.delete(oldestKey)
    }
  }

  clear(): void {
    this.map.clear()
  }
}

let busCounter = 0
let deliveryCounter = 0

function nextId(prefix: string): string {
  deliveryCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${deliveryCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// Tracks the shared hop budget across an entire synchronous causal cascade
// so even branching re-emits (`busA.on` + `busB.on` both calling `emit`) are strictly O(maxHops)
// and can never cause an O(2^maxHops) exponential broadcast storm!
interface CausalCascadeBudget {
  hopsRemaining: number
}
let activeCascadeBudget: CausalCascadeBudget | null = null

export function createEventBus(options: EventBusOptions = {}): EventBus {
  busCounter += 1
  const busId = options.id ?? `bus_${busCounter}`
  const maxHops = Math.max(1, options.maxHops ?? 32)
  const seenMaxSize = Math.max(16, options.seenMaxSize ?? 2048)
  const seenTtlMs = Math.max(100, options.seenTtlMs ?? 60_000)

  const seenEvents = new LruTtlCache(seenMaxSize, seenTtlMs)
  const seenBridgePackets = new LruTtlCache(seenMaxSize, seenTtlMs)

  const lifetimeController = new AbortController()
  let disposed = false
  let disposeReason: unknown

  const eventListeners = new Map<string, Set<EventHandler<any>>>()
  const bridgeListeners = new Set<(packet: BridgePacket, sourceBusId: string) => void>()

  const rpcHandlers = new Map<string, RpcHandler<any, any>>()
  const streamRpcHandlers = new Map<string, StreamRpcHandler<any, any>>()

  const pendingRpcs = new Map<
    string,
    {
      resolve: (value: any) => void
      reject: (err: unknown) => void
      cleanup: () => void
    }
  >()

  const activeRpcExecutions = new Map<string, AbortController>()

  interface ActiveStreamConsumer {
    pushChunk: (chunk: any) => void
    finish: () => void
    fail: (err: unknown) => void
  }
  const activeStreamConsumers = new Map<string, ActiveStreamConsumer>()
  const activeStreamProducers = new Map<string, AbortController>()

  function assertNotDisposed(): void {
    if (disposed) {
      throw new BusDisposedError(disposeReason)
    }
  }

  function forwardToBridges(packet: BridgePacket, excludeBusId: string): void {
    if (disposed) return
    for (const listener of bridgeListeners) {
      listener(packet, excludeBusId)
    }
  }

  function deliverEventLocally(envelope: EventEnvelope<any>): void {
    const handlers = eventListeners.get(envelope.eventName)
    if (!handlers || handlers.size === 0) return

    const isRootCascade = activeCascadeBudget === null
    if (isRootCascade) {
      activeCascadeBudget = { hopsRemaining: envelope.hopsRemaining - 1 }
    }
    try {
      for (const handler of [...handlers]) {
        handler(envelope.payload, envelope)
      }
    } finally {
      if (isRootCascade) {
        activeCascadeBudget = null
      }
    }
  }

  function on<TPayload>(
    event: EventDefinition<TPayload>,
    handler: EventHandler<TPayload>,
  ): () => void {
    assertNotDisposed()
    let set = eventListeners.get(event.name)
    if (!set) {
      set = new Set()
      eventListeners.set(event.name, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
    }
  }

  function once<TPayload>(
    event: EventDefinition<TPayload>,
    handler: EventHandler<TPayload>,
  ): () => void {
    const off = on(event, (payload, env) => {
      off()
      handler(payload, env)
    })
    return off
  }

  function emit<TPayload>(
    event: EventDefinition<TPayload>,
    payload: TPayload,
    emitOpts?: { hopsRemaining?: number; deliveryId?: string },
  ): EventEnvelope<TPayload> | null {
    assertNotDisposed()

    let initialHops: number
    if (emitOpts?.hopsRemaining !== undefined) {
      initialHops = emitOpts.hopsRemaining
    } else if (activeCascadeBudget !== null) {
      initialHops = activeCascadeBudget.hopsRemaining
      activeCascadeBudget.hopsRemaining -= 1
    } else {
      initialHops = maxHops
    }

    if (initialHops <= 0) {
      console.warn(
        `[@ashy/bus] Hop budget exhausted (hopsRemaining=${initialHops}) for event "${event.name}" on ${busId}. Dropping to prevent infinite broadcast loop.`,
      )
      return null
    }

    const deliveryId = emitOpts?.deliveryId ?? nextId('evt')
    if (seenEvents.hasAndTouch(deliveryId)) {
      return null
    }
    seenEvents.add(deliveryId)

    const envelope: EventEnvelope<TPayload> = {
      deliveryId,
      eventName: event.name,
      payload,
      hopsRemaining: initialHops,
      timestamp: Date.now(),
      originBusId: busId,
    }

    const isRootCascade = activeCascadeBudget === null
    if (isRootCascade) {
      activeCascadeBudget = { hopsRemaining: initialHops - 1 }
    }

    try {
      deliverEventLocally(envelope)

      const remainingForBridge =
        activeCascadeBudget !== null
          ? activeCascadeBudget.hopsRemaining
          : envelope.hopsRemaining - 1

      if (remainingForBridge > 0) {
        if (activeCascadeBudget !== null) {
          activeCascadeBudget.hopsRemaining -= 1
        }
        forwardToBridges(
          {
            type: 'event',
            envelope: {
              ...envelope,
              hopsRemaining: remainingForBridge,
            },
          },
          busId,
        )
      } else if (bridgeListeners.size > 0) {
        console.warn(
          `[@ashy/bus] Hop budget reached 0 before bridging event "${event.name}" (${deliveryId}).`,
        )
      }
    } finally {
      if (isRootCascade) {
        activeCascadeBudget = null
      }
    }

    return envelope
  }

  function handleRpc<TReq, TRes>(
    rpc: RpcDefinition<TReq, TRes>,
    handler: RpcHandler<TReq, TRes>,
  ): () => void {
    assertNotDisposed()
    rpcHandlers.set(rpc.name, handler)
    return () => {
      if (rpcHandlers.get(rpc.name) === handler) {
        rpcHandlers.delete(rpc.name)
      }
    }
  }

  async function executeLocalRpcHandler(
    requestId: string,
    rpcName: string,
    req: unknown,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const handler = rpcHandlers.get(rpcName)
    if (!handler) {
      throw new Error(`No RPC handler registered for "${rpcName}"`)
    }

    const execController = new AbortController()
    activeRpcExecutions.set(requestId, execController)

    const onLifetimeAbort = () =>
      execController.abort(new BusDisposedError(disposeReason))
    const onCallerAbort = () =>
      execController.abort(callerSignal?.reason ?? new Error('RPC aborted by caller'))

    lifetimeController.signal.addEventListener('abort', onLifetimeAbort, { once: true })
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

    try {
      return await handler(req, {
        signal: execController.signal,
        deliveryId: requestId,
      })
    } finally {
      activeRpcExecutions.delete(requestId)
      lifetimeController.signal.removeEventListener('abort', onLifetimeAbort)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
  }

  function invokeRpc<TReq, TRes>(
    rpc: RpcDefinition<TReq, TRes>,
    req: TReq,
    invokeOpts?: RpcInvokeOptions,
  ): Promise<TRes> {
    if (disposed) {
      return Promise.reject(new BusDisposedError(disposeReason))
    }
    if (invokeOpts?.signal?.aborted) {
      return Promise.reject(new Error('RPC aborted before invocation'))
    }

    const requestId = nextId('rpc')

    return new Promise<TRes>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        pendingRpcs.delete(requestId)
        invokeOpts?.signal?.removeEventListener('abort', onCallerAbort)
      }

      const settleResolve = (val: TRes) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(val)
      }

      const settleReject = (err: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      }

      const onCallerAbort = () => {
        const execCtrl = activeRpcExecutions.get(requestId)
        execCtrl?.abort()
        forwardToBridges(
          { type: 'rpc-abort', requestId, hopsRemaining: maxHops - 1 },
          busId,
        )
        settleReject(new Error('RPC aborted by AbortSignal'))
      }

      invokeOpts?.signal?.addEventListener('abort', onCallerAbort, { once: true })

      if (invokeOpts?.timeoutMs !== undefined && invokeOpts.timeoutMs > 0) {
        timer = setTimeout(() => {
          const execCtrl = activeRpcExecutions.get(requestId)
          execCtrl?.abort()
          forwardToBridges(
            { type: 'rpc-abort', requestId, hopsRemaining: maxHops - 1 },
            busId,
          )
          settleReject(new RpcTimeoutError(rpc.name, invokeOpts.timeoutMs!))
        }, invokeOpts.timeoutMs)
      }

      pendingRpcs.set(requestId, {
        resolve: settleResolve,
        reject: settleReject,
        cleanup,
      })

      if (rpcHandlers.has(rpc.name)) {
        executeLocalRpcHandler(requestId, rpc.name, req, invokeOpts?.signal).then(
          (res) => settleResolve(res as TRes),
          (err) => settleReject(err),
        )
      } else if (bridgeListeners.size > 0) {
        forwardToBridges(
          {
            type: 'rpc-req',
            requestId,
            rpcName: rpc.name,
            req,
            hopsRemaining: maxHops - 1,
            originBusId: busId,
          },
          busId,
        )
      } else {
        settleReject(new Error(`No RPC handler registered for "${rpc.name}"`))
      }
    })
  }

  function handleStreamRpc<TReq, TChunk>(
    rpc: StreamRpcDefinition<TReq, TChunk>,
    handler: StreamRpcHandler<TReq, TChunk>,
  ): () => void {
    assertNotDisposed()
    streamRpcHandlers.set(rpc.name, handler)
    return () => {
      if (streamRpcHandlers.get(rpc.name) === handler) {
        streamRpcHandlers.delete(rpc.name)
      }
    }
  }

  async function runStreamProducer(
    streamId: string,
    rpcName: string,
    req: unknown,
    onChunk: (chunk: unknown) => void,
    onEnd: (error?: string) => void,
  ): Promise<void> {
    const handler = streamRpcHandlers.get(rpcName)
    if (!handler) {
      onEnd(`No Stream RPC handler registered for "${rpcName}"`)
      return
    }

    const producerCtrl = new AbortController()
    activeStreamProducers.set(streamId, producerCtrl)

    const onLifetimeAbort = () =>
      producerCtrl.abort(new BusDisposedError(disposeReason))
    lifetimeController.signal.addEventListener('abort', onLifetimeAbort, { once: true })

    try {
      const iterable = handler(req, {
        signal: producerCtrl.signal,
        deliveryId: streamId,
      })
      for await (const chunk of iterable) {
        if (producerCtrl.signal.aborted || disposed) {
          break
        }
        onChunk(chunk)
      }
      if (!producerCtrl.signal.aborted && !disposed) {
        onEnd()
      }
    } catch (err) {
      if (!producerCtrl.signal.aborted && !disposed) {
        onEnd(err instanceof Error ? err.message : String(err))
      }
    } finally {
      activeStreamProducers.delete(streamId)
      lifetimeController.signal.removeEventListener('abort', onLifetimeAbort)
    }
  }

  function invokeStreamRpc<TReq, TChunk>(
    rpc: StreamRpcDefinition<TReq, TChunk>,
    req: TReq,
    invokeOpts?: RpcInvokeOptions,
  ): StreamRpcIterator<TChunk> {
    const streamId = nextId('strm')
    const buffer: TChunk[] = []
    let done = false
    let streamError: unknown = null
    const waitingResolvers: Array<{
      resolve: (res: IteratorResult<TChunk>) => void
      reject: (err: unknown) => void
    }> = []

    const cleanup = () => {
      activeStreamConsumers.delete(streamId)
      invokeOpts?.signal?.removeEventListener('abort', onCallerAbort)
    }

    const failStream = (err: unknown) => {
      if (done) return
      done = true
      streamError = err
      cleanup()
      while (waitingResolvers.length > 0) {
        const waiter = waitingResolvers.shift()!
        waiter.reject(err)
      }
    }

    const finishStream = () => {
      if (done) return
      done = true
      cleanup()
      while (waitingResolvers.length > 0) {
        const waiter = waitingResolvers.shift()!
        waiter.resolve({ value: undefined as unknown as TChunk, done: true })
      }
    }

    const pushChunk = (chunk: TChunk) => {
      if (done) return
      if (waitingResolvers.length > 0) {
        const waiter = waitingResolvers.shift()!
        waiter.resolve({ value: chunk, done: false })
      } else {
        buffer.push(chunk)
      }
    }

    const onCallerAbort = () => {
      const prodCtrl = activeStreamProducers.get(streamId)
      prodCtrl?.abort()
      forwardToBridges(
        { type: 'stream-cancel', streamId, hopsRemaining: maxHops - 1 },
        busId,
      )
      failStream(new Error('Stream RPC aborted by AbortSignal'))
    }

    if (disposed) {
      failStream(new BusDisposedError(disposeReason))
    } else if (invokeOpts?.signal?.aborted) {
      failStream(new Error('Stream RPC aborted before start'))
    } else {
      invokeOpts?.signal?.addEventListener('abort', onCallerAbort, { once: true })
      activeStreamConsumers.set(streamId, {
        pushChunk,
        finish: finishStream,
        fail: failStream,
      })

      if (streamRpcHandlers.has(rpc.name)) {
        void runStreamProducer(
          streamId,
          rpc.name,
          req,
          (chunk) => pushChunk(chunk as TChunk),
          (err) => {
            if (err) failStream(new Error(err))
            else finishStream()
          },
        )
      } else if (bridgeListeners.size > 0) {
        forwardToBridges(
          {
            type: 'stream-open',
            streamId,
            rpcName: rpc.name,
            req,
            hopsRemaining: maxHops - 1,
            originBusId: busId,
          },
          busId,
        )
      } else {
        failStream(new Error(`No Stream RPC handler registered for "${rpc.name}"`))
      }
    }

    const iterator: StreamRpcIterator<TChunk> = {
      next(): Promise<IteratorResult<TChunk>> {
        if (buffer.length > 0) {
          const val = buffer.shift()!
          return Promise.resolve({ value: val, done: false })
        }
        if (streamError !== null) {
          const err = streamError
          streamError = null
          return Promise.reject(err)
        }
        if (done) {
          return Promise.resolve({ value: undefined as unknown as TChunk, done: true })
        }
        if (disposed) {
          return Promise.reject(new BusDisposedError(disposeReason))
        }
        return new Promise<IteratorResult<TChunk>>((resolve, reject) => {
          waitingResolvers.push({ resolve, reject })
        })
      },
      return(): Promise<IteratorResult<TChunk>> {
        iterator.cancel('Consumer closed stream')
        return Promise.resolve({ value: undefined as unknown as TChunk, done: true })
      },
      throw(err?: unknown): Promise<IteratorResult<TChunk>> {
        failStream(err ?? new Error('Stream thrown'))
        return Promise.reject(err)
      },
      [Symbol.asyncIterator]() {
        return this
      },
      cancel(reason?: unknown) {
        if (done) return
        const prodCtrl = activeStreamProducers.get(streamId)
        prodCtrl?.abort(reason)
        forwardToBridges(
          { type: 'stream-cancel', streamId, hopsRemaining: maxHops - 1 },
          busId,
        )
        finishStream()
      },
      toReadableStream(): ReadableStream<TChunk> {
        return new ReadableStream<TChunk>({
          async pull(controller) {
            try {
              const res = await iterator.next()
              if (res.done) {
                controller.close()
              } else {
                controller.enqueue(res.value)
              }
            } catch (err) {
              controller.error(err)
            }
          },
          cancel(reason) {
            iterator.cancel(reason)
          },
        })
      },
    }

    return iterator
  }

  function __receiveBridgePacket(packet: BridgePacket, fromBusId: string): void {
    if (disposed) return

    if (packet.type === 'event') {
      const { envelope } = packet
      const effectiveHops =
        activeCascadeBudget !== null
          ? Math.min(envelope.hopsRemaining, activeCascadeBudget.hopsRemaining)
          : envelope.hopsRemaining

      if (effectiveHops <= 0) {
        console.warn(
          `[@ashy/bus] Dropping bridged event "${envelope.eventName}" (${envelope.deliveryId}) on ${busId}: hopsRemaining=${effectiveHops}`,
        )
        return
      }
      if (seenEvents.hasAndTouch(envelope.deliveryId)) {
        return
      }
      seenEvents.add(envelope.deliveryId)

      if (activeCascadeBudget !== null) {
        activeCascadeBudget.hopsRemaining = effectiveHops - 1
      }

      deliverEventLocally({
        ...envelope,
        hopsRemaining: effectiveHops,
      })

      const nextHops =
        activeCascadeBudget !== null
          ? activeCascadeBudget.hopsRemaining
          : effectiveHops - 1

      if (nextHops > 0) {
        forwardToBridges(
          {
            type: 'event',
            envelope: {
              ...envelope,
              hopsRemaining: nextHops,
            },
          },
          fromBusId,
        )
      } else if (bridgeListeners.size > 1) {
        console.warn(
          `[@ashy/bus] Hop budget exhausted (0 remaining) for event "${envelope.eventName}" at ${busId}.`,
        )
      }
      return
    }

    if (packet.type === 'rpc-req') {
      if (packet.hopsRemaining <= 0) return
      const dedupeKey = `rpc-req:${packet.requestId}`
      if (seenBridgePackets.hasAndTouch(dedupeKey)) return
      seenBridgePackets.add(dedupeKey)

      if (rpcHandlers.has(packet.rpcName)) {
        executeLocalRpcHandler(packet.requestId, packet.rpcName, packet.req).then(
          (res) => {
            forwardToBridges(
              {
                type: 'rpc-res',
                requestId: packet.requestId,
                ok: true,
                res,
                hopsRemaining: maxHops - 1,
              },
              busId,
            )
          },
          (err) => {
            forwardToBridges(
              {
                type: 'rpc-res',
                requestId: packet.requestId,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                hopsRemaining: maxHops - 1,
              },
              busId,
            )
          },
        )
      } else {
        forwardToBridges(
          { ...packet, hopsRemaining: packet.hopsRemaining - 1 },
          fromBusId,
        )
      }
      return
    }

    if (packet.type === 'rpc-res') {
      if (packet.hopsRemaining <= 0) return
      const dedupeKey = `rpc-res:${packet.requestId}`
      if (seenBridgePackets.hasAndTouch(dedupeKey)) return
      seenBridgePackets.add(dedupeKey)

      const pending = pendingRpcs.get(packet.requestId)
      if (pending) {
        if (packet.ok) {
          pending.resolve(packet.res)
        } else {
          pending.reject(new Error(packet.error ?? 'Remote RPC failed'))
        }
      } else {
        forwardToBridges(
          { ...packet, hopsRemaining: packet.hopsRemaining - 1 },
          fromBusId,
        )
      }
      return
    }

    if (packet.type === 'rpc-abort') {
      if (packet.hopsRemaining <= 0) return
      const dedupeKey = `rpc-abort:${packet.requestId}`
      if (seenBridgePackets.hasAndTouch(dedupeKey)) return
      seenBridgePackets.add(dedupeKey)

      const execCtrl = activeRpcExecutions.get(packet.requestId)
      if (execCtrl) {
        execCtrl.abort()
      } else {
        forwardToBridges(
          { ...packet, hopsRemaining: packet.hopsRemaining - 1 },
          fromBusId,
        )
      }
      return
    }

    if (packet.type === 'stream-open') {
      if (packet.hopsRemaining <= 0) return
      const dedupeKey = `stream-open:${packet.streamId}`
      if (seenBridgePackets.hasAndTouch(dedupeKey)) return
      seenBridgePackets.add(dedupeKey)

      if (streamRpcHandlers.has(packet.rpcName)) {
        void runStreamProducer(
          packet.streamId,
          packet.rpcName,
          packet.req,
          (chunk) => {
            forwardToBridges(
              {
                type: 'stream-chunk',
                streamId: packet.streamId,
                chunk,
                hopsRemaining: maxHops - 1,
              },
              busId,
            )
          },
          (error) => {
            forwardToBridges(
              {
                type: 'stream-end',
                streamId: packet.streamId,
                error,
                hopsRemaining: maxHops - 1,
              },
              busId,
            )
          },
        )
      } else {
        forwardToBridges(
          { ...packet, hopsRemaining: packet.hopsRemaining - 1 },
          fromBusId,
        )
      }
      return
    }

    if (packet.type === 'stream-chunk') {
      if (packet.hopsRemaining <= 0) return
      const consumer = activeStreamConsumers.get(packet.streamId)
      if (consumer) {
        consumer.pushChunk(packet.chunk)
      } else {
        forwardToBridges(
          { ...packet, hopsRemaining: packet.hopsRemaining - 1 },
          fromBusId,
        )
      }
      return
    }

    if (packet.type === 'stream-end') {
      if (packet.hopsRemaining <= 0) return
      const consumer = activeStreamConsumers.get(packet.streamId)
      if (consumer) {
        if (packet.error) {
          consumer.fail(new Error(packet.error))
        } else {
          consumer.finish()
        }
      } else {
        forwardToBridges(
          { ...packet, hopsRemaining: packet.hopsRemaining - 1 },
          fromBusId,
        )
      }
      return
    }

    if (packet.type === 'stream-cancel') {
      if (packet.hopsRemaining <= 0) return
      const prodCtrl = activeStreamProducers.get(packet.streamId)
      if (prodCtrl) {
        prodCtrl.abort()
      } else {
        forwardToBridges(
          { ...packet, hopsRemaining: packet.hopsRemaining - 1 },
          fromBusId,
        )
      }
    }
  }

  function __subscribeBridge(
    listener: (packet: BridgePacket, sourceBusId: string) => void,
  ): () => void {
    bridgeListeners.add(listener)
    return () => {
      bridgeListeners.delete(listener)
    }
  }

  function dispose(reason?: unknown): void {
    if (disposed) return
    disposed = true
    disposeReason = reason

    const err = new BusDisposedError(reason)
    lifetimeController.abort(err)

    for (const pending of [...pendingRpcs.values()]) {
      pending.reject(err)
    }
    pendingRpcs.clear()

    for (const execCtrl of [...activeRpcExecutions.values()]) {
      execCtrl.abort(err)
    }
    activeRpcExecutions.clear()

    for (const consumer of [...activeStreamConsumers.values()]) {
      consumer.fail(err)
    }
    activeStreamConsumers.clear()

    for (const prodCtrl of [...activeStreamProducers.values()]) {
      prodCtrl.abort(err)
    }
    activeStreamProducers.clear()

    eventListeners.clear()
    bridgeListeners.clear()
    rpcHandlers.clear()
    streamRpcHandlers.clear()
    seenEvents.clear()
    seenBridgePackets.clear()
  }

  return {
    id: busId,
    get isDisposed() {
      return disposed
    },
    get lifetimeSignal() {
      return lifetimeController.signal
    },
    on,
    once,
    emit,
    handleRpc,
    invokeRpc,
    handleStreamRpc,
    invokeStreamRpc,
    dispose,
    __receiveBridgePacket,
    __subscribeBridge,
    __hasLocalRpcHandler: (name: string) => rpcHandlers.has(name),
    __hasLocalStreamRpcHandler: (name: string) => streamRpcHandlers.has(name),
  }
}

export const createEventContext = createEventBus

/**
 * Bidirectionally connects two `EventBus` instances so events, unary RPCs,
 * and streaming RPCs traverse across them while respecting `hopsRemaining`
 * and LRU deduplication. Returns an `unbridge()` function.
 */
export function bridgeBuses(busA: EventBus, busB: EventBus): () => void {
  if (busA === busB) {
    return () => {}
  }

  const unsubA = busA.__subscribeBridge((packet, sourceBusId) => {
    if (sourceBusId === busB.id) return
    busB.__receiveBridgePacket(packet, busA.id)
  })

  const unsubB = busB.__subscribeBridge((packet, sourceBusId) => {
    if (sourceBusId === busA.id) return
    busA.__receiveBridgePacket(packet, busB.id)
  })

  return () => {
    unsubA()
    unsubB()
  }
}
