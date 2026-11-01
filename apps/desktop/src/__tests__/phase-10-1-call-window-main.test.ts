import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDLE_CALL_STATE, type CallStateSnapshot } from '@ashy/shared'
import {
  CALL_TOGGLE_SHORTCUT,
  CALL_WINDOW_IDLE_DESTROY_MS,
  bootAshyElectronMain,
  createCallWindowController,
  type ElectronPermissionCheckHandlerLike,
  type ElectronPermissionRequestHandlerLike,
} from '../main/index'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function makeFakeSession() {
  const session = {
    request: null as ElectronPermissionRequestHandlerLike | null,
    check: null as ElectronPermissionCheckHandlerLike | null,
    setPermissionRequestHandler: vi.fn((h: ElectronPermissionRequestHandlerLike | null) => {
      session.request = h
    }),
    setPermissionCheckHandler: vi.fn((h: ElectronPermissionCheckHandlerLike | null) => {
      session.check = h
    }),
  }
  return session
}

function makeFakeTimers() {
  let nextId = 1
  const pending = new Map<number, { fn: () => void; ms: number }>()
  return {
    pending,
    setTimeout: vi.fn((fn: () => void, ms: number) => {
      const id = nextId++
      pending.set(id, { fn, ms })
      return id
    }),
    clearTimeout: vi.fn((h: unknown) => {
      pending.delete(h as number)
    }),
    fireAll() {
      const all = [...pending.values()]
      pending.clear()
      for (const t of all) t.fn()
    },
  }
}

function makeWindowClass(session: ReturnType<typeof makeFakeSession>) {
  const created: FakeWin[] = []
  let nextWcId = 100
  class FakeWin {
    options: Record<string, unknown>
    destroyed = false
    closedListeners: Array<() => void> = []
    finishLoad: Array<() => void> = []
    webContents: Record<string, unknown>
    loadURL = vi.fn(async (_url: string) => undefined)
    destroy = vi.fn(() => {
      this.destroyed = true
      for (const l of this.closedListeners) l()
    })
    setAlwaysOnTop = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    show = vi.fn()
    hide = vi.fn()
    constructor(options: Record<string, unknown>) {
      this.options = options
      this.webContents = {
        id: nextWcId++,
        session,
        isDestroyed: () => this.destroyed,
        send: vi.fn(),
        on: vi.fn(),
        once: vi.fn((event: string, l: () => void) => {
          if (event === 'did-finish-load') this.finishLoad.push(l)
        }),
        setWindowOpenHandler: vi.fn(),
      }
      created.push(this)
    }
    isDestroyed() {
      return this.destroyed
    }
    on(event: string, l: () => void) {
      if (event === 'closed') this.closedListeners.push(l)
    }
  }
  return { FakeWin, created }
}

describe('Phase 10.1 — hidden call-engine window controller (Electron main)', () => {
  it('1. ensure() creates a hidden, unthrottled, autoplay window on the call-engine URL; resolves on load; reuses it', async () => {
    const session = makeFakeSession()
    const { FakeWin, created } = makeWindowClass(session)
    // loadURL never resolves: only did-finish-load must settle ensure().
    const onCreated = vi.fn()
    const controller = createCallWindowController({
      BrowserWindow: FakeWin as never,
      preloadPath: '/p/preload.cjs',
      url: 'http://127.0.0.1:4000?view=call-engine',
      onWindowCreated: onCreated,
    })
    const ensured = controller.ensure()
    expect(created).toHaveLength(1)
    const win = created[0]!
    win.loadURL.mockImplementation(() => new Promise(() => undefined))
    expect(win.loadURL).toHaveBeenCalledWith('http://127.0.0.1:4000?view=call-engine')
    expect(win.options.show).toBe(false)
    expect(win.options.webPreferences).toMatchObject({
      preload: '/p/preload.cjs',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    })
    expect(onCreated).toHaveBeenCalledWith(win)
    for (const l of win.finishLoad) l()
    await expect(ensured).resolves.toBeUndefined()
    await controller.ensure()
    expect(created).toHaveLength(1)
    expect(controller.getWindow()).toBe(win)
    controller.destroy()
    expect(win.destroy).toHaveBeenCalled()
    expect(controller.getWindow()).toBeNull()
  })

  it('2. grants audio-only media to the call window webContents and leaves other webContents on the default', async () => {
    const session = makeFakeSession()
    const { FakeWin, created } = makeWindowClass(session)
    const controller = createCallWindowController({
      BrowserWindow: FakeWin as never,
      preloadPath: '/p.cjs',
      url: 'http://localhost:5173?view=call-engine',
    })
    await controller.ensure()
    const callWc = created[0]!.webContents
    const otherWc = { id: 1 }
    expect(session.request).toBeTypeOf('function')

    const decide = (wc: unknown, permission: string, mediaTypes?: string[]) => {
      let granted: boolean | null = null
      session.request!(wc, permission, (g) => (granted = g), mediaTypes ? { mediaTypes } : {})
      return granted
    }
    expect(decide(callWc, 'media', ['audio'])).toBe(true)
    expect(decide(callWc, 'media', ['audio', 'video'])).toBe(false)
    expect(decide(callWc, 'media', ['video'])).toBe(false)
    expect(decide(callWc, 'notifications')).toBe(false)
    // Other windows (hub/overlay) keep Electron's default (allow), i.e. nothing changes for them.
    expect(decide(otherWc, 'media', ['audio', 'video'])).toBe(true)

    expect(session.check!(callWc, 'media', 'http://localhost:5173', { mediaType: 'audio' })).toBe(true)
    expect(session.check!(callWc, 'media', 'http://localhost:5173', { mediaType: 'video' })).toBe(false)
    expect(session.check!(callWc, 'geolocation', 'http://localhost:5173', {})).toBe(false)
    expect(session.check!(otherWc, 'media', 'http://localhost:5173', { mediaType: 'video' })).toBe(true)

    // After the window is destroyed its webContents is no longer special.
    controller.destroy()
    expect(decide(callWc, 'media', ['audio', 'video'])).toBe(true)
    // A new window re-uses the same session handlers (installed once, not overridden).
    await controller.ensure()
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(decide(created[1]!.webContents, 'media', ['audio'])).toBe(true)
    expect(decide(created[1]!.webContents, 'media', ['video'])).toBe(false)
    controller.destroy()
  })

  it('3. auto-destroys 60 s after the call goes idle/ended; activity cancels the timer', async () => {
    const session = makeFakeSession()
    const { FakeWin, created } = makeWindowClass(session)
    const timers = makeFakeTimers()
    const controller = createCallWindowController({
      BrowserWindow: FakeWin as never,
      preloadPath: '/p.cjs',
      url: 'http://localhost:5173?view=call-engine',
      timers,
    })
    controller.handleCallState('idle') // no window yet -> nothing armed
    expect(timers.pending.size).toBe(0)

    await controller.ensure()
    controller.handleCallState('listening')
    controller.handleCallState('idle')
    expect([...timers.pending.values()][0]!.ms).toBe(CALL_WINDOW_IDLE_DESTROY_MS)
    controller.handleCallState('connecting') // a new call cancels it
    expect(timers.pending.size).toBe(0)
    controller.handleCallState('ended')
    expect(timers.pending.size).toBe(1)
    timers.fireAll()
    expect(created[0]!.destroy).toHaveBeenCalledTimes(1)
    expect(controller.getWindow()).toBeNull()
  })

  it('4. bootAshyElectronMain registers the controller with the kernel, Ctrl+Alt+L toggles the call, and quit closes the window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-p10-1-main-'))
    tempDirs.push(dir)
    const session = makeFakeSession()
    const { FakeWin, created } = makeWindowClass(session)
    const shortcuts = new Map<string, () => void>()
    const timers = makeFakeTimers()

    const booted = await bootAshyElectronMain({
      app: { getPath: () => dir, on: vi.fn() },
      BrowserWindow: FakeWin as never,
      ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
      globalShortcut: {
        register: vi.fn((acc: string, cb: () => void) => {
          shortcuts.set(acc, cb)
          return true
        }),
        unregisterAll: vi.fn(),
      },
      rendererUrl: 'http://localhost:5173',
      session,
      callWindowTimers: timers,
    })
    try {
      expect(created).toHaveLength(2) // hub + overlay; the call window is on demand
      expect(CALL_TOGGLE_SHORTCUT).toBe('CommandOrControl+Alt+L')
      expect(shortcuts.has(CALL_TOGGLE_SHORTCUT)).toBe(true)

      const kernel = booted.kernel
      const controller = kernel.liveCall.getCallWindowController()
      expect(controller).not.toBeNull()
      await controller!.ensure()
      expect(created).toHaveLength(3)
      expect(created[2]!.loadURL).toHaveBeenCalledWith('http://localhost:5173?view=call-engine')

      // Host events reach the call window like the other windows.
      kernel.liveCall.emit({ type: 'call:command', command: 'stop', callId: 'x' })
      expect(created[2]!.webContents.send).toHaveBeenCalledWith(
        'ashy:event',
        expect.objectContaining({ type: 'call:command' }),
      )

      // The shortcut reads call:getState and calls call:start when idle, call:stop otherwise.
      const invokeSpy = vi.spyOn(kernel, 'invokeLiveCall').mockImplementation(async (input) => {
        if (input.method === 'call:getState') return { ...IDLE_CALL_STATE } satisfies CallStateSnapshot
        return { ...IDLE_CALL_STATE, status: 'connecting', callId: 'c1' }
      })
      shortcuts.get(CALL_TOGGLE_SHORTCUT)!()
      await vi.waitFor(() =>
        expect(invokeSpy).toHaveBeenCalledWith({ method: 'call:start' }),
      )
      invokeSpy.mockImplementation(async (input) => {
        if (input.method === 'call:getState') return { ...IDLE_CALL_STATE, status: 'listening', callId: 'c1' }
        return { ...IDLE_CALL_STATE }
      })
      shortcuts.get(CALL_TOGGLE_SHORTCUT)!()
      await vi.waitFor(() => expect(invokeSpy).toHaveBeenCalledWith({ method: 'call:stop' }))
      invokeSpy.mockRestore()

      // call:state idle (via the kernel event bus) arms the 60 s auto-destroy.
      kernel.liveCall.emit({ type: 'call:state', state: { ...IDLE_CALL_STATE, updatedAt: 1 } })
      expect([...timers.pending.values()].some((t) => t.ms === CALL_WINDOW_IDLE_DESTROY_MS)).toBe(true)
    } finally {
      await booted.shutdown()
    }
    expect(created[2]!.destroy).toHaveBeenCalled()
  })
})
