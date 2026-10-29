import { describe, it, expect, vi } from 'vitest'
import {
  createContainer,
  CircularDependencyError,
  createEventBus,
  createEventContext,
  bridgeBuses,
  defineEvent,
  defineRpc,
  defineStreamRpc,
  BusDisposedError,
} from '../src/index'

describe('@ashy/bus — 1. Functional DI Container (di.ts)', () => {
  it('resolves async dependency graph and deduplicates concurrent resolve() calls', async () => {
    const container = createContainer()
    let dbBuildCount = 0

    const dbToken = container.provide('db', {
      build: async () => {
        dbBuildCount += 1
        await new Promise((r) => setTimeout(r, 20))
        return { connected: true, id: Math.random() }
      },
    })

    const repoToken = container.provide('repo', {
      dependsOn: { db: dbToken },
      build: async ({ dependsOn }) => {
        return { db: dependsOn.db, query: () => 'ok' }
      },
    })

    // Call resolve 10x in parallel for repoToken and dbToken
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => container.resolve(dbToken)),
      ...Array.from({ length: 5 }, () => container.resolve(repoToken)),
    ])

    expect(dbBuildCount).toBe(1)
    const firstDb = results[0]
    for (let i = 1; i < 5; i++) {
      expect(results[i]).toBe(firstDb)
    }
    for (let i = 5; i < 10; i++) {
      expect((results[i] as { db: unknown }).db).toBe(firstDb)
    }
  })

  it('runs onStart in topological order (leaves first) and onStop in strictly reverse topological order', async () => {
    const container = createContainer()
    const lifecycleLog: string[] = []

    const configToken = container.provide('config', {
      build: () => ({ port: 3000 }),
      onStart: () => {
        lifecycleLog.push('start:config')
      },
      onStop: () => {
        lifecycleLog.push('stop:config')
      },
    })

    const dbToken = container.provide('db', {
      dependsOn: { config: configToken },
      build: ({ dependsOn }) => ({ url: `sqlite:${dependsOn.config.port}` }),
      onStart: async () => {
        await new Promise((r) => setTimeout(r, 5))
        lifecycleLog.push('start:db')
      },
      onStop: async () => {
        await new Promise((r) => setTimeout(r, 5))
        lifecycleLog.push('stop:db')
      },
    })

    const cortexToken = container.provide('cortex', {
      dependsOn: { db: dbToken, config: configToken },
      build: ({ dependsOn }) => ({ db: dependsOn.db }),
      onStart: () => {
        lifecycleLog.push('start:cortex')
      },
      onStop: () => {
        lifecycleLog.push('stop:cortex')
      },
    })

    container.invoke({
      name: 'desktopApp',
      dependsOn: { cortex: cortexToken },
      callback: () => {
        lifecycleLog.push('invoke:desktopApp')
      },
    })

    await container.start()

    expect(lifecycleLog).toEqual([
      'start:config',
      'start:db',
      'start:cortex',
      'invoke:desktopApp',
    ])

    await container.stop()

    expect(lifecycleLog).toEqual([
      'start:config',
      'start:db',
      'start:cortex',
      'invoke:desktopApp',
      'stop:cortex',
      'stop:db',
      'stop:config',
    ])
  })

  it('detects direct and multi-hop circular dependencies with CircularDependencyError', async () => {
    const container = createContainer()

    const tokenA = container.provide('serviceA', {
      dependsOn: {} as Record<string, any>,
      build: () => 'A',
    })
    const tokenB = container.provide('serviceB', {
      dependsOn: { a: tokenA },
      build: () => 'B',
    })
    const tokenC = container.provide('serviceC', {
      dependsOn: { b: tokenB },
      build: () => 'C',
    })

    // Introduce cycle: A -> C -> B -> A
    ;(tokenA.dependsOn as Record<string, any>).c = tokenC

    await expect(container.start()).rejects.toThrow(CircularDependencyError)
    await expect(container.resolve(tokenA)).rejects.toThrow(CircularDependencyError)
  })
})

describe('@ashy/bus — 2. Typed Event Bus, Hop Budget & Streaming RPC (event-bus.ts)', () => {
  it('delivers typed events across bridged buses and deduplicates duplicate deliveryIds via LRU cache', () => {
    const busA = createEventBus({ seenMaxSize: 4, seenTtlMs: 5000 })
    const busB = createEventContext({ seenMaxSize: 4, seenTtlMs: 5000 })

    // Create two parallel bridges between busA and busB to simulate duplicate delivery paths
    const unbridge1 = bridgeBuses(busA, busB)
    const unbridge2 = bridgeBuses(busA, busB)

    const moodChanged = defineEvent<{ valence: number }>('cortex:mood-changed')
    const receivedOnB: Array<{ valence: number }> = []

    busB.on(moodChanged, (payload) => {
      receivedOnB.push(payload)
    })

    busA.emit(moodChanged, { valence: 0.8 })

    // Despite 2 parallel bridges, LRU deliveryId deduplication ensures busB receives it exactly once
    expect(receivedOnB).toEqual([{ valence: 0.8 }])

    unbridge1()
    unbridge2()
  })

  it('enforces hopsRemaining = 32 budget and stops infinite A <-> B broadcast loops', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const busA = createEventBus({ maxHops: 32 })
    const busB = createEventBus({ maxHops: 32 })
    bridgeBuses(busA, busB)

    const pingPong = defineEvent<{ count: number }>('test:ping-pong')
    let bReceived = 0
    let aReceived = 0

    // Adversarial loop: handler on B re-emits on B, handler on A re-emits on A
    busB.on(pingPong, (p) => {
      bReceived += 1
      busB.emit(pingPong, { count: p.count + 1 })
    })
    busA.on(pingPong, (p) => {
      aReceived += 1
      busA.emit(pingPong, { count: p.count + 1 })
    })

    busA.emit(pingPong, { count: 0 })

    // Should terminate strictly at maxHops (32 total hops) instead of overflowing the call stack!
    expect(aReceived + bReceived).toBeLessThanOrEqual(33)
    expect(aReceived + bReceived).toBeGreaterThanOrEqual(16)
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('isolates hop budgets between independent (unbridged) EventBus instances during nested synchronous emits', () => {
    const busLowHops = createEventBus({ id: 'low-hops', maxHops: 1 })
    const busIndependent = createEventBus({ id: 'independent', maxHops: 8 })

    const triggerEvt = defineEvent<string>('test:trigger')
    const auditEvt = defineEvent<string>('test:audit')

    const auditReceived: string[] = []
    busIndependent.on(auditEvt, (msg) => {
      auditReceived.push(msg)
    })

    busLowHops.on(triggerEvt, (msg) => {
      // At this point busLowHops has 0 hops remaining in its own cascade,
      // but busIndependent is NOT bridged to busLowHops and must not be starved.
      busIndependent.emit(auditEvt, `audit:${msg}`)
    })

    busLowHops.emit(triggerEvt, 'hello')
    expect(auditReceived).toEqual(['audit:hello'])
  })

  it('supports unary RPC across bridged buses with timeout and AbortSignal', async () => {
    const busA = createEventBus()
    const busB = createEventBus()
    bridgeBuses(busA, busB)

    const addRpc = defineRpc<{ a: number; b: number }, { sum: number }>('math:add')
    const slowRpc = defineRpc<{ delayMs: number }, string>('test:slow')

    busB.handleRpc(addRpc, async ({ a, b }) => {
      return { sum: a + b }
    })

    busB.handleRpc(slowRpc, async ({ delayMs }, { signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        })
      })
      return 'done'
    })

    const res = await busA.invokeRpc(addRpc, { a: 19, b: 23 })
    expect(res).toEqual({ sum: 42 })

    // Timeout test
    await expect(busA.invokeRpc(slowRpc, { delayMs: 500 }, { timeoutMs: 25 })).rejects.toThrow(
      /timeout/i,
    )

    // AbortSignal test
    const controller = new AbortController()
    const promise = busA.invokeRpc(slowRpc, { delayMs: 500 }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 15)
    await expect(promise).rejects.toThrow(/abort/i)
  })

  it('supports Streaming RPC across bridged buses', async () => {
    const busA = createEventBus()
    const busB = createEventBus()
    bridgeBuses(busA, busB)

    const tokenStreamRpc = defineStreamRpc<{ prompt: string }, { token: string }>('llm:stream')

    busB.handleStreamRpc(tokenStreamRpc, async function* (req) {
      const words = req.prompt.split(' ')
      for (const word of words) {
        await new Promise((r) => setTimeout(r, 5))
        yield { token: word }
      }
    })

    const chunks: string[] = []
    for await (const item of busA.invokeStreamRpc(tokenStreamRpc, { prompt: 'Ashy is alive' })) {
      chunks.push(item.token)
    }

    expect(chunks).toEqual(['Ashy', 'is', 'alive'])
  })

  it('immediately aborts in-flight unary RPCs and open stream RPCs with BusDisposedError when dispose() is called', async () => {
    const busA = createEventBus()
    const busB = createEventBus()
    bridgeBuses(busA, busB)

    const hangingRpc = defineRpc<void, string>('test:hanging-rpc')
    const hangingStream = defineStreamRpc<void, number>('test:hanging-stream')

    busB.handleRpc(hangingRpc, async (_req, { signal }) => {
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('handler aborted')))
      })
    })

    busB.handleStreamRpc(hangingStream, async function* (_req, { signal }) {
      yield 1
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('stream aborted')))
      })
      yield 2
    })

    const rpcPromise = busA.invokeRpc(hangingRpc, undefined)
    const stream = busA.invokeStreamRpc(hangingStream, undefined)

    const firstChunk = await stream.next()
    expect(firstChunk).toEqual({ value: 1, done: false })

    const secondChunkPromise = stream.next()

    // Dispose busA while both RPC and Stream are waiting
    busA.dispose('shutdown requested')

    await expect(rpcPromise).rejects.toThrow(BusDisposedError)
    await expect(secondChunkPromise).rejects.toThrow(BusDisposedError)
  })

  it('recovers from transient build() errors in DI container and supportsReadableStream conversion on Stream RPC', async () => {
    const container = createContainer()
    let attempts = 0
    const flakyToken = container.provide('flaky', {
      build: async ({ lifecycle }) => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('Transient DB lock')
        }
        lifecycle.onStart(() => {})
        lifecycle.onStop(() => {})
        return { ready: true }
      },
    })

    await expect(container.resolve(flakyToken)).rejects.toThrow('Transient DB lock')
    const secondTry = await container.resolve(flakyToken)
    expect(secondTry).toEqual({ ready: true })

    // Multi-hop bridge A -> B -> C + ReadableStream
    const busA = createEventBus()
    const busB = createEventBus()
    const busC = createEventBus()
    bridgeBuses(busA, busB)
    bridgeBuses(busB, busC)

    const streamRpc = defineStreamRpc<number, number>('math:count')
    busC.handleStreamRpc(streamRpc, async function* (max) {
      for (let i = 1; i <= max; i++) {
        yield i * 10
      }
    })

    const readable = busA.invokeStreamRpc(streamRpc, 3).toReadableStream()
    const reader = readable.getReader()
    const items: number[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      items.push(value)
    }
    expect(items).toEqual([10, 20, 30])
  })
})
