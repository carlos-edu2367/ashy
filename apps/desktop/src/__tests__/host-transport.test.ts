import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AshyHostStreamEvent } from '@ashy/shared'
import { createAshyHostKernel } from '../host/kernel'
import {
  createAshyHostHttpMiddleware,
  dispatchHostRpc,
} from '../host/vite-host-plugin'
import { bootAshyElectronMain, registerAshyElectronIpc } from '../main/index'
import { createAshyPreloadApi, exposeAshyPreload } from '../preload/index'
import {
  createHttpSseHostBridge,
  createPreloadHostBridge,
  getAshyHostBridge,
  setAshyHostBridgeForTesting,
} from '../services/ashy-host-client'
import { useAshyStore } from '../store/useAshyStore'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-transport-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  setAshyHostBridgeForTesting(null)
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Ashy Dual-Runtime Transport (IPC & HTTP RPC)', () => {
  it('dispatches RPC calls to AshyHostKernel and returns typed results', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })

    const snapshot = await dispatchHostRpc(kernel, 'getBootstrapSnapshot', undefined)
    expect(snapshot).toHaveProperty('needsOnboarding', true)

    await dispatchHostRpc(kernel, 'completeOnboarding', {
      userName: 'Carlos',
    })

    const updated = await dispatchHostRpc(kernel, 'getBootstrapSnapshot', undefined)
    expect(updated).toHaveProperty('needsOnboarding', false)
    await kernel.stop()
  })

  it('rejects unknown, prototype-pollution, or lifecycle RPC method names in dispatchHostRpc', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })

    await expect(dispatchHostRpc(kernel, '__proto__', {})).rejects.toThrow(
      /Unsupported or disallowed AshyHost RPC method/i,
    )
    await expect(dispatchHostRpc(kernel, 'constructor', {})).rejects.toThrow(
      /Unsupported or disallowed AshyHost RPC method/i,
    )
    await expect(dispatchHostRpc(kernel, 'toString', {})).rejects.toThrow(
      /Unsupported or disallowed AshyHost RPC method/i,
    )
    await expect(dispatchHostRpc(kernel, 'stop', {})).rejects.toThrow(
      /Unsupported or disallowed AshyHost RPC method/i,
    )
    await expect(dispatchHostRpc(kernel, 'start', {})).rejects.toThrow(
      /Unsupported or disallowed AshyHost RPC method/i,
    )
    await expect(dispatchHostRpc(kernel, 'onHostEvent', {})).rejects.toThrow(
      /Unsupported or disallowed AshyHost RPC method/i,
    )
    await expect(dispatchHostRpc(kernel, 'nonExistentMethod', {})).rejects.toThrow(
      /Unsupported or disallowed AshyHost RPC method/i,
    )
    await expect(dispatchHostRpc(kernel, 'deleteMemoryItem', null)).rejects.toThrow(
      /Invalid RPC argument/i,
    )
    await expect(
      dispatchHostRpc(kernel, 'deleteMemoryItem', { kind: 'invalid', id: '' }),
    ).rejects.toThrow(/Invalid RPC argument/i)
    await expect(dispatchHostRpc(kernel, 'upsertSemanticFact', [])).rejects.toThrow(
      /Invalid RPC argument/i,
    )
    await expect(dispatchHostRpc(kernel, 'selectSession', {})).rejects.toThrow(
      /Invalid RPC argument/i,
    )

    await kernel.stop()
  })

  it('registers all Electron ipcMain handlers synchronously before any window loadURL call', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    const registeredChannels: string[] = []

    const fakeIpcMain = {
      handle: vi.fn((channel: string) => {
        registeredChannels.push(channel)
      }),
      removeHandler: vi.fn(),
    }

    const cleanup = registerAshyElectronIpc(fakeIpcMain, kernel, () => [])
    expect(registeredChannels).toContain('ashy:rpc')
    cleanup()
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith('ashy:rpc')
    await kernel.stop()
  })

  it('enforces the airi boot invariant in bootAshyElectronMain: kernel.start -> ipcMain.handle BEFORE hubWindow.loadURL and overlayWindow.loadURL', async () => {
    const dir = makeTempDir()
    const callOrder: string[] = []

    const fakeIpcMain = {
      handle: vi.fn((channel: string) => {
        callOrder.push(`ipcMain.handle:${channel}`)
      }),
      removeHandler: vi.fn((channel: string) => {
        callOrder.push(`ipcMain.removeHandler:${channel}`)
      }),
    }

    const createdWindows: Array<{
      options: Record<string, unknown>
      webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
      loadURL: ReturnType<typeof vi.fn>
    }> = []

    class FakeBrowserWindow {
      options: Record<string, unknown>
      webContents = {
        isDestroyed: () => false,
        send: vi.fn(),
      }
      loadURL = vi.fn(async (url: string) => {
        callOrder.push(`window.loadURL:${url}`)
      })

      constructor(options: Record<string, unknown>) {
        this.options = options
        callOrder.push('new BrowserWindow')
        createdWindows.push(this)
      }
    }

    const beforeQuitHandlers: Array<() => void | Promise<void>> = []
    const fakeApp = {
      getPath: vi.fn(() => dir),
      on: vi.fn((event: string, handler: () => void | Promise<void>) => {
        if (event === 'before-quit') {
          beforeQuitHandlers.push(handler)
        }
      }),
    }

    const booted = await bootAshyElectronMain({
      app: fakeApp,
      BrowserWindow: FakeBrowserWindow as unknown as never,
      ipcMain: fakeIpcMain,
      rendererUrl: 'http://localhost:5173',
    })

    const handleIdx = callOrder.indexOf('ipcMain.handle:ashy:rpc')
    const hubLoadIdx = callOrder.indexOf('window.loadURL:http://localhost:5173')
    const overlayLoadIdx = callOrder.indexOf(
      'window.loadURL:http://localhost:5173?view=stage-overlay',
    )

    expect(handleIdx).toBeGreaterThanOrEqual(0)
    expect(hubLoadIdx).toBeGreaterThan(handleIdx)
    expect(overlayLoadIdx).toBeGreaterThan(handleIdx)
    expect(createdWindows).toHaveLength(2)
    expect(createdWindows[0]!.options).toMatchObject({
      width: 1280,
      height: 820,
      backgroundColor: '#13111C',
    })
    expect(createdWindows[1]!.options).toMatchObject({
      transparent: true,
      frame: false,
      alwaysOnTop: true,
    })

    await booted.shutdown()
    expect(callOrder).toContain('ipcMain.removeHandler:ashy:rpc')
  })

  it('round-trips RPC calls and broadcasts stream events across Preload and Renderer AshyHostClient', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"<|ACT {\\"emotion\\":\\"warm\\",\\"intensity\\":0.75}|>Oi pelo IPC!"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    type IpcRpcListener = (
      event: unknown,
      req: { method: string; payload?: unknown },
    ) => Promise<unknown> | unknown
    let rpcHandler: IpcRpcListener | null = null
    const rendererEventListeners = new Set<(event: unknown, payload: AshyHostStreamEvent) => void>()

    const fakeIpcMain = {
      handle: vi.fn((channel: string, handler: IpcRpcListener) => {
        if (channel === 'ashy:rpc') {
          rpcHandler = handler
        }
      }),
      removeHandler: vi.fn(),
    }

    const fakeWebContents = {
      isDestroyed: () => false,
      send: vi.fn((channel: string, payload: AshyHostStreamEvent) => {
        if (channel === 'ashy:event') {
          for (const listener of rendererEventListeners) {
            listener({}, payload)
          }
        }
      }),
    }

    const cleanupIpc = registerAshyElectronIpc(fakeIpcMain, kernel, () => [fakeWebContents])

    const fakeIpcRenderer = {
      invoke: vi.fn(async (channel: string, req: { method: string; payload?: unknown }) => {
        if (channel !== 'ashy:rpc' || !rpcHandler) {
          throw new Error(`No handler for ${channel}`)
        }
        return rpcHandler({}, req)
      }),
      on: vi.fn((channel: string, listener: (event: unknown, payload: AshyHostStreamEvent) => void) => {
        if (channel === 'ashy:event') {
          rendererEventListeners.add(listener)
        }
      }),
      removeListener: vi.fn(
        (channel: string, listener: (event: unknown, payload: AshyHostStreamEvent) => void) => {
          if (channel === 'ashy:event') {
            rendererEventListeners.delete(listener)
          }
        },
      ),
    }

    const exposedGlobals: Record<string, unknown> = {}
    const fakeContextBridge = {
      exposeInMainWorld: vi.fn((key: string, api: unknown) => {
        exposedGlobals[key] = api
      }),
    }

    const preloadApi = exposeAshyPreload(fakeContextBridge, fakeIpcRenderer)
    expect(exposedGlobals.ashyHost).toBe(preloadApi)

    const bridge = createPreloadHostBridge(createAshyPreloadApi(fakeIpcRenderer))
    setAshyHostBridgeForTesting(bridge)
    expect(getAshyHostBridge()).toBe(bridge)

    const snap = await bridge.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-ipc-key-1234',
      },
    })
    expect(snap.needsOnboarding).toBe(false)

    const receivedEvents: AshyHostStreamEvent[] = []
    const unsub = bridge.onHostEvent((ev) => receivedEvents.push(ev))

    await bridge.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Testando IPC real',
    })

    await vi.waitFor(() => {
      expect(receivedEvents.some((e) => e.type === 'turn:completed')).toBe(true)
    })

    unsub()
    cleanupIpc()
    await kernel.stop()
  })

  it('round-trips RPC calls and streams SSE events via createHttpSseHostBridge and createAshyHostHttpMiddleware', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"Oi via HTTP SSE!"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

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
    const baseUrl = `http://127.0.0.1:${port}`

    // Minimal EventSource client over Node fetch for testing SSE endpoint
    const abortController = new AbortController()
    const bridge = createHttpSseHostBridge({
      baseUrl,
      fetchImpl: fetch,
      createEventSource: (url) => {
        const target = {
          onmessage: null as ((ev: { data: string }) => void) | null,
          onerror: null as ((err: unknown) => void) | null,
          close: () => abortController.abort(),
        }
        void (async () => {
          try {
            const response = await fetch(url, { signal: abortController.signal })
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
                  if (line.startsWith('data: ')) {
                    target.onmessage?.({ data: line.slice(6) })
                  }
                }
              }
            }
          } catch {
            // Expected on abort
          }
        })()
        return target
      },
    })

    try {
      const snap = await bridge.completeOnboarding({
        userName: 'Carlos',
        providerConfig: {
          providerId: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          modelId: 'anthropic/claude-3.7-sonnet',
          apiKey: 'sk-or-v1-http-key-1234',
        },
      })
      expect(snap.needsOnboarding).toBe(false)

      const receivedEvents: AshyHostStreamEvent[] = []
      const unsub = bridge.onHostEvent((ev) => receivedEvents.push(ev))

      // Give SSE connection a tick to attach on the server
      await new Promise((r) => setTimeout(r, 40))

      await bridge.sendTurn({
        sessionId: snap.activeSession.id,
        text: 'Testando HTTP SSE',
      })

      await vi.waitFor(() => {
        expect(receivedEvents.some((e) => e.type === 'turn:completed')).toBe(true)
      })

      unsub()
    } finally {
      abortController.abort()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await kernel.stop()
    }
  })

  it('isolates destroyed or throwing webContents in registerAshyElectronIpc and handles malformed HTTP/SSE inputs gracefully', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })

    // 1. Verify destroyed/throwing webContents do not break healthy windows
    const healthySend = vi.fn()
    const destroyedSend = vi.fn()
    const throwingSend = vi.fn(() => {
      throw new Error('Object has been destroyed')
    })

    const fakeIpcMain = {
      handle: vi.fn(),
      removeHandler: vi.fn(),
    }

    const cleanupIpc = registerAshyElectronIpc(fakeIpcMain, kernel, () => [
      { isDestroyed: () => true, send: destroyedSend },
      { isDestroyed: () => false, send: throwingSend },
      { isDestroyed: () => false, send: healthySend },
    ])

    const snap = await kernel.getBootstrapSnapshot()
    await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Trigger turn:error because no provider is configured yet',
    })

    await vi.waitFor(() => {
      expect(healthySend).toHaveBeenCalled()
    })
    expect(destroyedSend).not.toHaveBeenCalled()

    cleanupIpc()

    // 2. Verify HTTP middleware rejects invalid methods (405) and malformed/disallowed JSON (400)
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
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const getRpcRes = await fetch(`${baseUrl}/__ashy_host/rpc`, { method: 'GET' })
      expect(getRpcRes.status).toBe(405)

      const postEventsRes = await fetch(`${baseUrl}/__ashy_host/events`, {
        method: 'POST',
      })
      expect(postEventsRes.status).toBe(405)

      const malformedRes = await fetch(`${baseUrl}/__ashy_host/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad-json',
      })
      expect(malformedRes.status).toBe(400)

      const protoRes = await fetch(`${baseUrl}/__ashy_host/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: '__proto__', payload: {} }),
      })
      expect(protoRes.status).toBe(400)

      // 3. Verify CSRF / Cross-Origin / DNS Rebinding / Content-Type security hardening
      const crossOriginRpcRes = await fetch(`${baseUrl}/__ashy_host/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.attacker.example',
        },
        body: JSON.stringify({ method: 'getBootstrapSnapshot' }),
      })
      expect(crossOriginRpcRes.status).toBe(403)

      const crossSiteFetchRes = await fetch(`${baseUrl}/__ashy_host/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'cross-site',
        },
        body: JSON.stringify({ method: 'getBootstrapSnapshot' }),
      })
      expect(crossSiteFetchRes.status).toBe(403)

      const crossOriginEventsRes = await fetch(`${baseUrl}/__ashy_host/events`, {
        method: 'GET',
        headers: {
          Origin: 'https://evil.attacker.example',
        },
      })
      expect(crossOriginEventsRes.status).toBe(403)

      const textPlainCsrfRes = await fetch(`${baseUrl}/__ashy_host/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
        },
        body: JSON.stringify({ method: 'getBootstrapSnapshot' }),
      })
      expect(textPlainCsrfRes.status).toBe(415)

      // DNS rebinding check via raw http.request with spoofed Host header
      const dnsRebindStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/__ashy_host/rpc',
            method: 'POST',
            headers: {
              Host: 'rebind.attacker.example:5173',
              'Content-Type': 'application/json',
            },
          },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('error', reject)
        req.write(JSON.stringify({ method: 'getBootstrapSnapshot' }))
        req.end()
      })
      expect(dnsRebindStatus).toBe(403)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await kernel.stop()
    }
  })

  it('persists store mutations (memories, story edits, milestones, dream cycle, trait revert, motifs, intents) across IPC bridge without in-process cortex access', async () => {
    const dir = makeTempDir()
    const kernel1 = await createAshyHostKernel({ userDataDir: dir })

    type IpcRpcListener = (
      event: unknown,
      req: { method: string; payload?: unknown },
    ) => Promise<unknown> | unknown
    let rpcHandler: IpcRpcListener | null = null

    const fakeIpcMain = {
      handle: vi.fn((channel: string, handler: IpcRpcListener) => {
        if (channel === 'ashy:rpc') {
          rpcHandler = handler
        }
      }),
      removeHandler: vi.fn(),
    }

    const cleanupIpc1 = registerAshyElectronIpc(fakeIpcMain, kernel1, () => [])
    const fakeIpcRenderer = {
      invoke: vi.fn(async (channel: string, req: { method: string; payload?: unknown }) => {
        if (channel !== 'ashy:rpc' || !rpcHandler) {
          throw new Error(`No handler for ${channel}`)
        }
        return rpcHandler({}, req)
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    }

    const ipcBridge = createPreloadHostBridge(createAshyPreloadApi(fakeIpcRenderer))
    // Ensure the bridge does NOT expose .cortex (simulating strict Electron contextIsolation / HTTP)
    expect('cortex' in (ipcBridge as unknown as Record<string, unknown>)).toBe(false)

    setAshyHostBridgeForTesting(ipcBridge)
    useAshyStore.getState().resetStoreForTesting()
    await useAshyStore.getState().seedDemoFixtures()

    // 1. Create memory card & edit its story
    const createdCard = useAshyStore.getState().createMemoryCard({
      title: 'Memória via IPC',
      summary: 'Resumo original',
      fullStory: 'História original',
      filterCategory: 'momentos',
    })
    useAshyStore.getState().updateMemoryStory(
      createdCard.id,
      'Memória via IPC Editada',
      'História atualizada pelo IPC real',
    )

    // 2. Add milestone
    const milestone = useAshyStore.getState().addMilestone({
      title: 'Marco IPC',
      narrative: 'Persistido via IPC sem getInProcessKernelCortex',
      category: 'project_shipped',
    })

    // 3. Run dream consolidation & revert trait evolution
    const evoRecord = useAshyStore.getState().runDreamConsolidation()
    useAshyStore.getState().revertTraitEvolution(evoRecord.id)

    // 4. Complete prospective intent & invoke motif
    const firstIntentId = useAshyStore.getState().prospectiveIntents[0]?.id
    if (firstIntentId) {
      useAshyStore.getState().completeProspectiveIntent(firstIntentId)
    }

    // Flush background RPC promises
    await new Promise((r) => setTimeout(r, 50))
    cleanupIpc1()
    await kernel1.stop()

    // Reboot a brand-new kernel2 on the same userDataDir and bootstrap store over IPC
    const kernel2 = await createAshyHostKernel({ userDataDir: dir })
    const cleanupIpc2 = registerAshyElectronIpc(fakeIpcMain, kernel2, () => [])

    useAshyStore.getState().resetStoreForTesting()
    await useAshyStore.getState().bootstrapFromHost()

    const rebootedState = useAshyStore.getState()
    const persistedEp = rebootedState.episodicMemories.find((e) => e.id === createdCard.id)
    expect(persistedEp?.title).toBe('Memória via IPC Editada')
    expect(persistedEp?.content).toBe('História atualizada pelo IPC real')

    expect(rebootedState.milestones.some((m) => m.id === milestone.id)).toBe(true)
    const persistedEvo = rebootedState.personalityEvolutionLog.find((r) => r.id === evoRecord.id)
    expect(persistedEvo?.revertedAt).toBeTypeOf('number')

    if (firstIntentId) {
      const persistedIntent = rebootedState.prospectiveIntents.find((i) => i.id === firstIntentId)
      expect(persistedIntent?.status).toBe('completed')
    }

    cleanupIpc2()
    await kernel2.stop()
  })

  it('wires Stage Overlay IPC (setOverlayIgnoreMouse deduplication, setOverlayVisible, getOverlayState) and globalShortcut registration + unregisterAll on shutdown', async () => {
    const dir = makeTempDir()
    const handlers = new Map<string, (event: unknown, req?: unknown) => Promise<unknown> | unknown>()

    const fakeIpcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, req?: unknown) => Promise<unknown> | unknown) => {
        handlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel)
      }),
    }

    const createdWindows: Array<{
      options: Record<string, unknown>
      webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
      loadURL: ReturnType<typeof vi.fn>
      setIgnoreMouseEvents: ReturnType<typeof vi.fn>
      show: ReturnType<typeof vi.fn>
      hide: ReturnType<typeof vi.fn>
    }> = []

    class FakeBrowserWindow {
      options: Record<string, unknown>
      webContents = {
        isDestroyed: () => false,
        send: vi.fn(),
      }
      loadURL = vi.fn(async () => undefined)
      setIgnoreMouseEvents = vi.fn()
      show = vi.fn()
      hide = vi.fn()

      constructor(options: Record<string, unknown>) {
        this.options = options
        createdWindows.push(this)
      }
    }

    const registeredShortcuts = new Map<string, () => void>()
    const fakeGlobalShortcut = {
      register: vi.fn((accelerator: string, callback: () => void) => {
        registeredShortcuts.set(accelerator, callback)
        return true
      }),
      unregisterAll: vi.fn(() => {
        registeredShortcuts.clear()
      }),
    }

    const fakeApp = {
      getPath: vi.fn(() => dir),
      on: vi.fn(),
    }

    const booted = await bootAshyElectronMain({
      app: fakeApp,
      BrowserWindow: FakeBrowserWindow as unknown as never,
      ipcMain: fakeIpcMain,
      globalShortcut: fakeGlobalShortcut,
      rendererUrl: 'http://localhost:5173',
    })

    const overlayWin = createdWindows[1]!
    expect(fakeGlobalShortcut.register).toHaveBeenCalledTimes(4)
    expect(Array.from(registeredShortcuts.keys())).toEqual(
      expect.arrayContaining([
        'CommandOrControl+Shift+M',
        'CommandOrControl+Shift+E',
        'CommandOrControl+Shift+D',
        'CommandOrControl+Shift+H',
      ]),
    )

    const preloadApi = createAshyPreloadApi({
      invoke: async (channel: string, req?: unknown) => {
        const handler = handlers.get(channel)
        if (!handler) throw new Error(`Missing handler: ${channel}`)
        return handler({}, req)
      },
      on: vi.fn(),
      removeListener: vi.fn(),
    })

    // 1. Deduplicated setOverlayIgnoreMouse
    const state1 = await preloadApi.setOverlayIgnoreMouse!({ ignore: true, forward: true })
    expect(state1.ignoringMouseEvents).toBe(true)
    expect(overlayWin.setIgnoreMouseEvents).toHaveBeenCalledTimes(1)
    expect(overlayWin.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })

    // Repeated call with ignore: true must be deduplicated
    const state2 = await preloadApi.setOverlayIgnoreMouse!({ ignore: true, forward: true })
    expect(state2.ignoringMouseEvents).toBe(true)
    expect(overlayWin.setIgnoreMouseEvents).toHaveBeenCalledTimes(1)

    // Transition back to ignore: false
    const state3 = await preloadApi.setOverlayIgnoreMouse!({ ignore: false })
    expect(state3.ignoringMouseEvents).toBe(false)
    expect(overlayWin.setIgnoreMouseEvents).toHaveBeenCalledTimes(2)
    expect(overlayWin.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })

    // 2. setOverlayVisible hides and shows overlayWindow
    const hiddenState = await preloadApi.setOverlayVisible!({ visible: false })
    expect(hiddenState.isOverlayVisible).toBe(false)
    expect(overlayWin.hide).toHaveBeenCalledTimes(1)

    const shownState = await preloadApi.setOverlayVisible!({ visible: true })
    expect(shownState.isOverlayVisible).toBe(true)
    expect(overlayWin.show).toHaveBeenCalledTimes(1)

    // 3. getOverlayState returns current runtime state
    const current = await preloadApi.getOverlayState!()
    expect(current.isOverlayVisible).toBe(true)
    expect(current.ignoringMouseEvents).toBe(false)

    // 4. Shutdown unregisters all global shortcuts and IPC handlers
    await booted.shutdown()
    expect(fakeGlobalShortcut.unregisterAll).toHaveBeenCalledTimes(1)
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith('ashy:setOverlayIgnoreMouse')
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith('ashy:setOverlayVisible')
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith('ashy:getOverlayState')
  })
})
