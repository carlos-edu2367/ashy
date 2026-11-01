import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import * as v from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ASHY_HOST_RPC_METHODS,
  AshyHostStreamEventSchema,
  IDLE_CALL_STATE,
  LiveCallHostEventSchema,
  type AshyHostStreamEvent,
  type LiveCallHostEvent,
  type LiveCallMethod,
} from '@ashy/shared'
import { createAshyHostKernel, type AshyHostKernel } from '../host/kernel'
import { createLiveCallRegistry } from '../host/live-call/registry'
import { createAshyHostHttpMiddleware, dispatchHostRpc } from '../host/vite-host-plugin'
import { registerAshyElectronIpc } from '../main/index'
import { createAshyPreloadApi } from '../preload/index'
import {
  createHttpSseHostBridge,
  createPreloadHostBridge,
  type EventSourceLike,
} from '../services/ashy-host-client'

const tempDirs: string[] = []
const kernels: AshyHostKernel[] = []

async function makeKernel(): Promise<AshyHostKernel> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-live-call-'))
  tempDirs.push(dir)
  const kernel = await createAshyHostKernel({ userDataDir: dir })
  kernels.push(kernel)
  return kernel
}

/**
 * The kernel now registers real `call:*` (task B) and `engines:*` (task A) handlers;
 * transport tests that need an "unregistered" method remove the real one first.
 */
function unregisterMethod(kernel: AshyHostKernel, method: LiveCallMethod): void {
  kernel.liveCall.registry.register(method, () => null)()
}

afterEach(async () => {
  while (kernels.length > 0) {
    await kernels.pop()!.stop()
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

const callStateEvent: LiveCallHostEvent = {
  type: 'call:state',
  state: { ...IDLE_CALL_STATE, callId: 'call-1', status: 'listening', updatedAt: 1 },
}
const visemeEvent: LiveCallHostEvent = {
  type: 'call:viseme',
  A: 0.4,
  E: 0.1,
  I: 0,
  O: 0.2,
  U: 0,
  volume: 0.6,
}

/** Wires a real kernel through registerAshyElectronIpc + preload API with fake Electron objects. */
function wireIpc(kernel: AshyHostKernel) {
  type IpcHandler = (event: unknown, req: unknown) => Promise<unknown> | unknown
  const handlers = new Map<string, IpcHandler>()
  const rendererListeners = new Set<(event: unknown, payload: AshyHostStreamEvent) => void>()
  const fakeIpcMain = {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    }),
  }
  const fakeWebContents = {
    isDestroyed: () => false,
    send: vi.fn((channel: string, payload: AshyHostStreamEvent) => {
      if (channel === 'ashy:event') {
        for (const l of rendererListeners) l({}, payload)
      }
    }),
  }
  const cleanup = registerAshyElectronIpc(fakeIpcMain, kernel, () => [fakeWebContents])
  const fakeIpcRenderer = {
    invoke: vi.fn(async (channel: string, req?: unknown) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No handler for ${channel}`)
      return handler({}, req)
    }),
    on: vi.fn((channel: string, l: (event: unknown, payload: AshyHostStreamEvent) => void) => {
      if (channel === 'ashy:event') rendererListeners.add(l)
    }),
    removeListener: vi.fn(
      (channel: string, l: (event: unknown, payload: AshyHostStreamEvent) => void) => {
        if (channel === 'ashy:event') rendererListeners.delete(l)
      },
    ),
  }
  const preloadApi = createAshyPreloadApi(fakeIpcRenderer)
  return { preloadApi, fakeIpcRenderer, cleanup }
}

function nodeEventSource(url: string, abort: AbortController): EventSourceLike {
  const target: EventSourceLike = {
    onmessage: null,
    onerror: null,
    close: () => abort.abort(),
  }
  void (async () => {
    try {
      const response = await fetch(url, { signal: abort.signal })
      const reader = response.body?.getReader()
      if (!reader) return
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (line.startsWith('data: ')) target.onmessage?.({ data: line.slice(6) })
          }
        }
      }
    } catch {
      // Expected on abort
    }
  })()
  return target
}

async function startHttpServer(kernel: AshyHostKernel) {
  const middleware = createAshyHostHttpMiddleware(async () => kernel)
  const server = http.createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 404
      res.end('Not Found')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('Phase 10.1 W0 — liveCall:invoke RPC + Live Call events', () => {
  it('exposes liveCall:invoke in the shared RPC method list and validates the 5 new events', () => {
    expect(ASHY_HOST_RPC_METHODS).toContain('liveCall:invoke')
    const events: unknown[] = [
      callStateEvent,
      visemeEvent,
      { type: 'call:command', command: 'start', callId: 'c', backend: 'llamacpp-realtime', sessionId: 's' },
      { type: 'call:command', command: 'stop', callId: 'c' },
      { type: 'call:command', command: 'setMuted', callId: 'c', muted: true },
      {
        type: 'engine:status',
        status: {
          engineId: 'llamacpp',
          build: 'b12024',
          installed: false,
          installedVariant: null,
          detectedGpu: { vendor: 'nvidia', name: 'RTX', vramMb: 8192, recommendedVariant: 'cuda-12.4' },
          running: false,
          managed: true,
          baseUrl: null,
          port: null,
          activeModelId: null,
          installedModelIds: [],
          activeDownload: null,
          lastError: null,
          vcRuntimeMissing: true,
          vcRuntimeInstall: { status: 'installing' },
        },
      },
      { type: 'chat:appended', sessionId: 's', messageIds: ['m1', 'm2'] },
    ]
    for (const ev of events) {
      expect(v.safeParse(LiveCallHostEventSchema, ev).success).toBe(true)
      expect(v.safeParse(AshyHostStreamEventSchema, ev).success).toBe(true)
    }
    expect(
      v.safeParse(AshyHostStreamEventSchema, { type: 'call:command', command: 'start', callId: 'c' }).success,
    ).toBe(false)
    expect(v.safeParse(AshyHostStreamEventSchema, { type: 'call:viseme', A: 'x' }).success).toBe(false)
  })

  it('registry routes registered methods and rejects unknown/unregistered ones', async () => {
    const registry = createLiveCallRegistry()
    const unregister = registry.register('call:getState', (p) => ({ echo: p }))
    await expect(registry.invoke('call:getState', 7)).resolves.toEqual({ echo: 7 })
    await expect(registry.invoke('call:start', {})).rejects.toThrow(
      'LIVE_CALL_METHOD_UNAVAILABLE: call:start',
    )
    await expect(registry.invoke('nope:method', {})).rejects.toMatchObject({
      code: 'LIVE_CALL_METHOD_UNAVAILABLE',
    })
    expect(() => registry.register('bogus' as never, () => null)).toThrow(/LIVE_CALL_METHOD_UNAVAILABLE/)
    unregister()
    await expect(registry.invoke('call:getState', 7)).rejects.toThrow(/LIVE_CALL_METHOD_UNAVAILABLE/)
  })

  it('dispatches liveCall:invoke through dispatchHostRpc to a registered kernel handler', async () => {
    const kernel = await makeKernel()
    const handler = vi.fn(async (payload: unknown) => ({ ok: true, payload }))
    kernel.liveCall.registry.register('call:start', handler)

    await expect(
      dispatchHostRpc(kernel, 'liveCall:invoke', { method: 'call:start', payload: { backend: 'llamacpp-realtime' } }),
    ).resolves.toEqual({ ok: true, payload: { backend: 'llamacpp-realtime' } })
    expect(handler).toHaveBeenCalledWith({ backend: 'llamacpp-realtime' })

    await expect(kernel.invokeLiveCall({ method: 'call:start' })).resolves.toEqual({
      ok: true,
      payload: undefined,
    })

    unregisterMethod(kernel, 'call:stop')
    await expect(
      dispatchHostRpc(kernel, 'liveCall:invoke', { method: 'call:stop', payload: {} }),
    ).rejects.toThrow('LIVE_CALL_METHOD_UNAVAILABLE: call:stop')
    await expect(
      dispatchHostRpc(kernel, 'liveCall:invoke', { method: 'not-a-method' }),
    ).rejects.toThrow('LIVE_CALL_METHOD_UNAVAILABLE: not-a-method')
    await expect(dispatchHostRpc(kernel, 'liveCall:invoke', null)).rejects.toThrow(/Invalid RPC argument/)
    await expect(dispatchHostRpc(kernel, 'liveCall:invoke', { payload: 1 })).rejects.toThrow(
      /Invalid RPC argument/,
    )
  })

  it('stores the call window controller on the kernel', async () => {
    const kernel = await makeKernel()
    expect(kernel.liveCall.getCallWindowController()).toBeNull()
    const controller = { ensure: vi.fn(async () => undefined), destroy: vi.fn() }
    kernel.setCallWindowController(controller)
    expect(kernel.liveCall.getCallWindowController()).toBe(controller)
    kernel.setCallWindowController(null)
    expect(kernel.liveCall.getCallWindowController()).toBeNull()
  })

  it('round-trips liveCall:invoke and Live Call events over Electron IPC (preload API + preload bridge)', async () => {
    const kernel = await makeKernel()
    kernel.liveCall.registry.register('call:getState', () => ({ ...IDLE_CALL_STATE, status: 'listening' }))
    unregisterMethod(kernel, 'call:stop')
    const { preloadApi, fakeIpcRenderer, cleanup } = wireIpc(kernel)
    try {
      await expect(preloadApi.invokeLiveCall!({ method: 'call:getState' })).resolves.toMatchObject({
        status: 'listening',
      })
      expect(fakeIpcRenderer.invoke).toHaveBeenCalledWith('ashy:rpc', {
        method: 'liveCall:invoke',
        payload: { method: 'call:getState' },
      })

      const bridge = createPreloadHostBridge(preloadApi)
      await expect(bridge.invokeLiveCall!({ method: 'call:getState' })).resolves.toMatchObject({
        status: 'listening',
      })
      await expect(bridge.invokeLiveCall!({ method: 'call:stop' })).rejects.toThrow(
        /LIVE_CALL_METHOD_UNAVAILABLE: call:stop/,
      )

      const received: AshyHostStreamEvent[] = []
      const unsub = bridge.onHostEvent((ev) => received.push(ev))
      kernel.liveCall.emit(callStateEvent)
      // Identical viseme frames (e.g. silence) must not be dropped by dedup.
      kernel.liveCall.emit(visemeEvent)
      kernel.liveCall.emit(visemeEvent)
      kernel.liveCall.emit({ type: 'chat:appended', sessionId: 's1', messageIds: ['m1'] })
      expect(received.filter((e) => e.type === 'call:state')).toEqual([callStateEvent])
      expect(received.filter((e) => e.type === 'call:viseme')).toHaveLength(2)
      expect(received.some((e) => e.type === 'chat:appended')).toBe(true)
      unsub()
    } finally {
      cleanup()
    }
  })

  it('preload bridge delivers viseme from IPC only and dedups call:state across IPC + SSE', () => {
    let ipcListener: ((ev: AshyHostStreamEvent) => void) | null = null
    let sse: EventSourceLike | null = null
    const preloadApi = {
      ...createAshyPreloadApi({ invoke: vi.fn(async () => ({})), on: vi.fn(), removeListener: vi.fn() }),
      onEvent: (cb: (ev: AshyHostStreamEvent) => void) => {
        ipcListener = cb
        return () => {
          ipcListener = null
        }
      },
    }
    const bridge = createPreloadHostBridge(preloadApi, {
      createEventSource: () => {
        sse = { onmessage: null, onerror: null, close: vi.fn() }
        return sse
      },
    })
    const received: AshyHostStreamEvent[] = []
    const unsub = bridge.onHostEvent((ev) => received.push(ev))

    ipcListener!(callStateEvent)
    sse!.onmessage?.({ data: JSON.stringify(callStateEvent) })
    expect(received.filter((e) => e.type === 'call:state')).toHaveLength(1)

    sse!.onmessage?.({ data: JSON.stringify(visemeEvent) })
    expect(received.filter((e) => e.type === 'call:viseme')).toHaveLength(0)
    ipcListener!(visemeEvent)
    ipcListener!(visemeEvent)
    expect(received.filter((e) => e.type === 'call:viseme')).toHaveLength(2)
    unsub()
  })

  it('round-trips liveCall:invoke over the HTTP bridge and streams call:state (but never call:viseme) over SSE', async () => {
    const kernel = await makeKernel()
    kernel.liveCall.registry.register('liveMode:getSettings', () => ({ backend: 'llamacpp-realtime' }))
    unregisterMethod(kernel, 'engines:start')
    unregisterMethod(kernel, 'call:stop')
    const server = await startHttpServer(kernel)
    const abort = new AbortController()
    try {
      const bridge = createHttpSseHostBridge({
        baseUrl: server.baseUrl,
        fetchImpl: fetch,
        createEventSource: (url) => nodeEventSource(url, abort),
      })
      await expect(bridge.invokeLiveCall!({ method: 'liveMode:getSettings' })).resolves.toEqual({
        backend: 'llamacpp-realtime',
      })
      await expect(bridge.invokeLiveCall!({ method: 'engines:start' })).rejects.toThrow(
        'LIVE_CALL_METHOD_UNAVAILABLE: engines:start',
      )

      // Unregistered method is reported as a client error (HTTP 400).
      const raw = await fetch(`${server.baseUrl}/__ashy_host/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ashy-Request': '1' },
        body: JSON.stringify({ method: 'liveCall:invoke', payload: { method: 'call:stop' } }),
      })
      expect(raw.status).toBe(400)

      const received: AshyHostStreamEvent[] = []
      const unsub = bridge.onHostEvent((ev) => received.push(ev))
      await new Promise((r) => setTimeout(r, 60))

      kernel.liveCall.emit(visemeEvent)
      kernel.liveCall.emit(callStateEvent)
      kernel.liveCall.emit(visemeEvent)
      await vi.waitFor(() => {
        expect(received.some((e) => e.type === 'call:state')).toBe(true)
      })
      // call:state was emitted after the first viseme, so if viseme were on SSE it would be here already.
      await new Promise((r) => setTimeout(r, 40))
      expect(received.filter((e) => e.type === 'call:viseme')).toHaveLength(0)
      expect(received.find((e) => e.type === 'call:state')).toEqual(callStateEvent)
      unsub()
    } finally {
      abort.abort()
      await server.close()
    }
  })

  it('never writes call:viseme frames to the raw SSE stream', async () => {
    const kernel = await makeKernel()
    const server = await startHttpServer(kernel)
    const abort = new AbortController()
    try {
      const response = await fetch(`${server.baseUrl}/__ashy_host/events`, { signal: abort.signal })
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let text = ''
      // Read the ': connected' preamble so the subscription is attached.
      while (!text.includes(': connected')) {
        const { value } = await reader.read()
        text += decoder.decode(value, { stream: true })
      }
      await new Promise((r) => setTimeout(r, 30))
      kernel.liveCall.emit(visemeEvent)
      kernel.liveCall.emit({ type: 'chat:appended', sessionId: 's1', messageIds: ['m1'] })
      while (!text.includes('chat:appended')) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
      expect(text).toContain('"type":"chat:appended"')
      expect(text).not.toContain('call:viseme')
    } finally {
      abort.abort()
      await server.close()
    }
  })
})
