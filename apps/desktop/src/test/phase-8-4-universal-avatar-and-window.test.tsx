// @vitest-environment jsdom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isSafeLive2DModelUrl, type AshyHostStreamEvent } from '@ashy/shared'
import { App } from '../App'
import { createAshyHostKernel } from '../host/kernel'
import { dispatchHostRpc } from '../host/vite-host-plugin'
import { bootAshyElectronMain, registerAshyElectronIpc } from '../main/index'
import { createAshyPreloadApi } from '../preload/index'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'

// Enable React 19 act environment
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const tempDirs: string[] = []
const activeKernels: Array<{ stop(): Promise<void> }> = []
let container: HTMLDivElement | null = null
let root: Root | null = null
let originalSearch = ''

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-p84-'))
  tempDirs.push(dir)
  return dir
}

function clickElement(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function getByTestId<T extends HTMLElement = HTMLElement>(testId: string): T {
  const el = container?.querySelector(`[data-testid="${testId}"]`) as T | null
  if (!el) {
    throw new Error(`Unable to find an element by: [data-testid="${testId}"]`)
  }
  return el
}

beforeEach(() => {
  originalSearch = window.location.search
  window.history.replaceState({}, '', '/')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  window.history.replaceState({}, '', originalSearch || '/')
  delete (globalThis as Record<string, unknown>).ashyHost
  if (root) {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }
  if (container) {
    container.remove()
    container = null
  }
  setAshyHostBridgeForTesting(null)
  while (activeKernels.length > 0) {
    await activeKernels.pop()!.stop()
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Phase 8.4 — Universal Avatar in UI, Multi-Window stagePreferences Persistence/Sync & Real Electron Shell', () => {
  it('1. selects Live2D preset (mao / haru), updates live2dModelControls with real preset expressions, persists stagePreferences to stage-preferences.json, and survives resetAshyStore + bootstrapFromHost', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    // Select 'haru' preset -> expressions F01..F08
    useAshyStore.getState().selectLive2dPreset('haru')
    expect(useAshyStore.getState().stageMode).toBe('live2d')
    expect(useAshyStore.getState().live2dPresetId).toBe('haru')
    expect(useAshyStore.getState().live2dModelControls.expressions).toEqual([
      'F01',
      'F02',
      'F03',
      'F04',
      'F05',
      'F06',
      'F07',
      'F08',
    ])
    expect(useAshyStore.getState().lastPrompt.volatileTurnContext).toContain(
      'F01, F02, F03, F04, F05, F06, F07, F08',
    )

    // Select 'mao' preset -> expressions exp_01..exp_08
    useAshyStore.getState().selectLive2dPreset('mao')
    useAshyStore.getState().setAmbientLuminance(0.72)

    expect(useAshyStore.getState().live2dPresetId).toBe('mao')
    expect(useAshyStore.getState().live2dModelUrl).toBe('/live2d/models/mao/Mao.model3.json')
    expect(useAshyStore.getState().live2dModelControls.expressions).toEqual([
      'exp_01',
      'exp_02',
      'exp_03',
      'exp_04',
      'exp_05',
      'exp_06',
      'exp_07',
      'exp_08',
    ])
    expect(useAshyStore.getState().lastPrompt.volatileTurnContext).toContain(
      'exp_01, exp_02, exp_03, exp_04, exp_05, exp_06, exp_07, exp_08',
    )

    // Wait for async persistence to complete
    await vi.waitFor(() => {
      const stagePrefsPath = path.join(dir, 'stage-preferences.json')
      expect(fs.existsSync(stagePrefsPath)).toBe(true)
      const parsed = JSON.parse(fs.readFileSync(stagePrefsPath, 'utf8')) as {
        stageMode: string
        live2dPresetId: string
        ambientLuminance: number
      }
      expect(parsed.stageMode).toBe('live2d')
      expect(parsed.live2dPresetId).toBe('mao')
      expect(parsed.ambientLuminance).toBeCloseTo(0.72, 2)
    })

    // Reset store completely and re-bootstrap from Host
    resetAshyStore()
    expect(useAshyStore.getState().stageMode).toBe('tachie')
    expect(useAshyStore.getState().live2dPresetId).toBe('hiyori')

    await useAshyStore.getState().bootstrapFromHost()

    const hydrated = useAshyStore.getState()
    expect(hydrated.stageMode).toBe('live2d')
    expect(hydrated.live2dPresetId).toBe('mao')
    expect(hydrated.live2dModelUrl).toBe('/live2d/models/mao/Mao.model3.json')
    expect(hydrated.ambientLuminance).toBeCloseTo(0.72, 2)
    expect(hydrated.live2dModelControls.expressions).toEqual([
      'exp_01',
      'exp_02',
      'exp_03',
      'exp_04',
      'exp_05',
      'exp_06',
      'exp_07',
      'exp_08',
    ])
    expect(hydrated.lastPrompt.volatileTurnContext).toContain('exp_01, exp_02')
  })

  it('2. broadcasts stage:updated in real-time when Host updates stagePreferences, syncing store state across windows automatically', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    expect(useAshyStore.getState().stageMode).toBe('tachie')
    expect(useAshyStore.getState().live2dPresetId).toBe('hiyori')
    expect(useAshyStore.getState().ambientLuminance).toBeCloseTo(0.35, 2)

    // Simulate another window (e.g., Hub or Overlay) updating stagePreferences on the Host kernel
    const updatedPrefs = await kernel.updateStagePreferences!({
      stageMode: 'live2d',
      live2dPresetId: 'haru',
      live2dModelUrl: '/live2d/models/haru/Haru.model3.json',
      loadedLive2DModelName: 'Haru.model3.json',
      ambientLuminance: 0.88,
      showDesktopAvatar: false,
      isStageHidden: true,
      live2dModelControls: {
        version: 3,
        expressions: ['F01', 'F02'],
        motionGroups: [{ name: 'Idle', count: 2 }],
        hitAreas: ['Head', 'Body'],
      },
    })

    expect(updatedPrefs.stageMode).toBe('live2d')
    expect(updatedPrefs.live2dPresetId).toBe('haru')

    // Store subscribed via onHostEvent must automatically reflect the stage:updated event
    const synced = useAshyStore.getState()
    expect(synced.stageMode).toBe('live2d')
    expect(synced.live2dPresetId).toBe('haru')
    expect(synced.live2dModelUrl).toBe('/live2d/models/haru/Haru.model3.json')
    expect(synced.loadedLive2DModelName).toBe('Haru.model3.json')
    expect(synced.ambientLuminance).toBeCloseTo(0.88, 2)
    expect(synced.showDesktopAvatar).toBe(false)
    expect(synced.isStageHidden).toBe(true)
    expect(synced.live2dModelControls.expressions).toEqual(['F01', 'F02'])
    expect(synced.lastPrompt.volatileTurnContext).toContain('F01, F02')
  })

  it('3. renders universal <AshyStageCanvas /> in Sidebar (Memories / Story tabs) and Settings Preview Card with active Live2D model URL, removing hardcoded /assets/ashy-hero.jpg', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      useAshyStore.getState().selectLive2dPreset('mao')
    })

    await act(async () => {
      root!.render(<App />)
    })

    // Switch to Memories tab -> Sidebar portrait must render Live2D stage with Mao
    await act(async () => {
      clickElement(getByTestId('tab-memories'))
    })

    const sidebarPortrait = getByTestId('sidebar-stage-portrait')
    const sidebarWebgl = sidebarPortrait.querySelector('[data-testid="live2d-webgl-stage"]')
    expect(sidebarWebgl).not.toBeNull()
    expect(sidebarWebgl?.getAttribute('data-live2d-model-url')).toBe(
      '/live2d/models/mao/Mao.model3.json',
    )
    expect(sidebarPortrait.querySelector('img[src="/assets/ashy-hero.jpg"]')).toBeNull()

    // Switch to Story tab -> Sidebar portrait still renders Live2D stage with Mao
    await act(async () => {
      clickElement(getByTestId('tab-story'))
    })

    const storySidebarPortrait = getByTestId('sidebar-stage-portrait')
    const storySidebarWebgl = storySidebarPortrait.querySelector(
      '[data-testid="live2d-webgl-stage"]',
    )
    expect(storySidebarWebgl).not.toBeNull()
    expect(storySidebarWebgl?.getAttribute('data-live2d-model-url')).toBe(
      '/live2d/models/mao/Mao.model3.json',
    )

    // Switch to Settings (Configurações / tab-agency) -> Preview card renders Live2D stage with Mao
    await act(async () => {
      clickElement(getByTestId('tab-agency'))
    })

    const settingsPreview = getByTestId('settings-stage-preview')
    const previewWebgl = settingsPreview.querySelector('[data-testid="live2d-webgl-stage"]')
    expect(previewWebgl).not.toBeNull()
    expect(previewWebgl?.getAttribute('data-live2d-model-url')).toBe(
      '/live2d/models/mao/Mao.model3.json',
    )
    expect(settingsPreview.querySelector('img[src="/assets/ashy-hero.jpg"]')).toBeNull()
  })

  it('4. wires window control buttons (btn-window-minimize, btn-window-maximize, btn-window-close) to ashyHost preload API and IPC handlers in registerAshyElectronIpc', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    const ipcHandlers = new Map<
      string,
      (event: unknown, req?: unknown) => Promise<unknown> | unknown
    >()
    const fakeIpcMain = {
      handle: vi.fn(
        (
          channel: string,
          handler: (event: unknown, req?: unknown) => Promise<unknown> | unknown,
        ) => {
          ipcHandlers.set(channel, handler)
        },
      ),
      removeHandler: vi.fn((channel: string) => {
        ipcHandlers.delete(channel)
      }),
    }

    let isMaximizedState = false
    const fakeHubWindow = {
      webContents: {
        isDestroyed: () => false,
        send: vi.fn(),
      },
      loadURL: vi.fn(async () => undefined),
      minimize: vi.fn(),
      maximize: vi.fn(() => {
        isMaximizedState = true
      }),
      unmaximize: vi.fn(() => {
        isMaximizedState = false
      }),
      isMaximized: vi.fn(() => isMaximizedState),
      close: vi.fn(),
    }

    const cleanupIpc = registerAshyElectronIpc(fakeIpcMain, kernel, () => [], {
      getHubWindow: () => fakeHubWindow,
    })

    const preloadApi = createAshyPreloadApi({
      invoke: vi.fn(async (channel: string, req?: unknown) => {
        const handler = ipcHandlers.get(channel)
        if (!handler) throw new Error(`Missing IPC channel: ${channel}`)
        return handler({}, req)
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    })

    const minimizeSpy = vi.spyOn(preloadApi, 'minimizeWindow')
    const maximizeSpy = vi.spyOn(preloadApi, 'maximizeWindow')
    const closeSpy = vi.spyOn(preloadApi, 'closeWindow')

    ;(globalThis as Record<string, unknown>).ashyHost = preloadApi
    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    await act(async () => {
      clickElement(getByTestId('btn-window-minimize'))
    })
    expect(minimizeSpy).toHaveBeenCalledTimes(1)
    expect(fakeHubWindow.minimize).toHaveBeenCalledTimes(1)

    await act(async () => {
      clickElement(getByTestId('btn-window-maximize'))
    })
    expect(maximizeSpy).toHaveBeenCalledTimes(1)
    expect(fakeHubWindow.maximize).toHaveBeenCalledTimes(1)
    expect(isMaximizedState).toBe(true)

    // Clicking maximize again when already maximized toggles unmaximize()
    await act(async () => {
      clickElement(getByTestId('btn-window-maximize'))
    })
    expect(maximizeSpy).toHaveBeenCalledTimes(2)
    expect(fakeHubWindow.unmaximize).toHaveBeenCalledTimes(1)
    expect(isMaximizedState).toBe(false)

    await act(async () => {
      clickElement(getByTestId('btn-window-close'))
    })
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(fakeHubWindow.close).toHaveBeenCalledTimes(1)

    cleanupIpc()
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith('ashy:windowMinimize')
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith('ashy:windowMaximize')
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith('ashy:windowClose')
  })

  it('5. executes real Electron global shortcuts (electronGlobalMic, electronGlobalEyes, electronGlobalDnd) in bootAshyElectronMain, updating kernel consent and emitting shortcut:triggered to windows and store', async () => {
    const dir = makeTempDir()
    const registeredShortcuts = new Map<string, () => void | Promise<void>>()

    const fakeGlobalShortcut = {
      register: vi.fn((accelerator: string, callback: () => void | Promise<void>) => {
        registeredShortcuts.set(accelerator, callback)
        return true
      }),
      unregisterAll: vi.fn(() => {
        registeredShortcuts.clear()
      }),
    }

    const fakeIpcMain = {
      handle: vi.fn(),
      removeHandler: vi.fn(),
    }

    const sentWindowEvents: AshyHostStreamEvent[] = []
    class FakeBrowserWindow {
      options: Record<string, unknown>
      webContents = {
        isDestroyed: () => false,
        send: vi.fn((channel: string, payload: AshyHostStreamEvent) => {
          if (channel === 'ashy:event') {
            sentWindowEvents.push(payload)
          }
        }),
      }
      loadURL = vi.fn(async () => undefined)
      setIgnoreMouseEvents = vi.fn()
      show = vi.fn()
      hide = vi.fn()

      constructor(options: Record<string, unknown>) {
        this.options = options
      }
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

    try {
      setAshyHostBridgeForTesting(booted.kernel)
      resetAshyStore()
      await useAshyStore.getState().bootstrapFromHost()

      // Initial kernel consent defaults: micMode='muted', eyesMode='off', dndMode=false
      const initialSnap = await booted.kernel.getAgencySnapshot!()
      expect(initialSnap.consent.micMode).toBe('muted')
      expect(initialSnap.consent.eyesMode).toBe('off')
      expect(initialSnap.consent.dndMode).toBe(false)

      // 1. Trigger electronGlobalMic (CommandOrControl+Shift+M)
      const micShortcut = registeredShortcuts.get('CommandOrControl+Shift+M')
      expect(micShortcut).toBeTypeOf('function')
      await micShortcut!()

      await vi.waitFor(async () => {
        const snap = await booted.kernel.getAgencySnapshot!()
        expect(snap.consent.micMode).toBe('continuous')
      })
      expect(sentWindowEvents).toContainEqual({
        type: 'shortcut:triggered',
        action: 'toggleMic',
      })

      // 2. Trigger electronGlobalEyes (CommandOrControl+Shift+E): off -> window -> screen -> off
      const eyesShortcut = registeredShortcuts.get('CommandOrControl+Shift+E')
      expect(eyesShortcut).toBeTypeOf('function')
      await eyesShortcut!()

      await vi.waitFor(async () => {
        const snap = await booted.kernel.getAgencySnapshot!()
        expect(snap.consent.eyesMode).toBe('window')
      })
      expect(sentWindowEvents).toContainEqual({
        type: 'shortcut:triggered',
        action: 'toggleEyes',
      })

      await eyesShortcut!()
      await vi.waitFor(async () => {
        const snap = await booted.kernel.getAgencySnapshot!()
        expect(snap.consent.eyesMode).toBe('screen')
      })

      // 3. Trigger electronGlobalDnd (CommandOrControl+Shift+D): false -> true
      const dndShortcut = registeredShortcuts.get('CommandOrControl+Shift+D')
      expect(dndShortcut).toBeTypeOf('function')
      await dndShortcut!()

      await vi.waitFor(async () => {
        const snap = await booted.kernel.getAgencySnapshot!()
        expect(snap.consent.dndMode).toBe(true)
      })
      expect(sentWindowEvents).toContainEqual({
        type: 'shortcut:triggered',
        action: 'toggleDnd',
      })
    } finally {
      await booted.shutdown()
    }
  })

  it('6. [Red-Team] enforces isSafeLive2DModelUrl against XSS/SSRF/traversal, guards destroyed Electron windows, and hydrates snapshot.agency on bootstrap', async () => {
    // 1. Validate isSafeLive2DModelUrl helper and Valibot schema enforcement
    expect(isSafeLive2DModelUrl('/live2d/models/mao/Mao.model3.json')).toBe(true)
    expect(isSafeLive2DModelUrl('/live2d/models/haru/Haru.model3.json')).toBe(true)
    expect(isSafeLive2DModelUrl('javascript:alert(1)//.model3.json')).toBe(false)
    expect(isSafeLive2DModelUrl('https://evil.example.com/spy.model3.json')).toBe(false)
    expect(isSafeLive2DModelUrl('/live2d/../../../etc/passwd.model3.json')).toBe(false)
    expect(isSafeLive2DModelUrl('//evil.example.com/live2d/Mao.model3.json')).toBe(false)

    const userDataDir = makeTempDir()
    const kernel = await createAshyHostKernel({
      userDataDir,
    })
    await kernel.start()
    activeKernels.push(kernel)

    try {
      await expect(
        dispatchHostRpc(kernel, 'updateStagePreferences', {
          live2dModelUrl: 'javascript:alert(1)//.model3.json',
        }),
      ).rejects.toThrow()

      await expect(
        dispatchHostRpc(kernel, 'updateStagePreferences', {
          live2dModelUrl: '/live2d/../../secret.model3.json',
        }),
      ).rejects.toThrow()

      setAshyHostBridgeForTesting(kernel)
      resetAshyStore()
      await useAshyStore.getState().bootstrapFromHost()

      // 2. Verify shortcut:triggered reconciles directly from authoritative kernel.getAgencySnapshot() without inverting state
      await kernel.updateAgencyConsent!({ micMode: 'continuous', eyesMode: 'screen', dndMode: true })
      kernel.emitHostEvent!({ type: 'shortcut:triggered', action: 'toggleMic' })
      await vi.waitFor(() => {
        expect(useAshyStore.getState().privacyState.micMode).toBe('continuous')
        expect(useAshyStore.getState().privacyState.eyesMode).toBe('screen')
        expect(useAshyStore.getState().privacyState.dndMode).toBe(true)
      })

      // 3. Verify importLive2DModelJson rejects unsafe URLs and syncs preset controls for valid builtin URLs
      expect(() =>
        useAshyStore
          .getState()
          .importLive2DModelJson('https://evil.example.com/spy.model3.json'),
      ).toThrow(/Invalid or unsafe Live2D model URL/i)

      const syncedControls = useAshyStore
        .getState()
        .importLive2DModelJson('/live2d/models/mao/Mao.model3.json')
      expect(useAshyStore.getState().live2dPresetId).toBe('mao')
      expect(syncedControls.expressions).toContain('exp_01')

      // 4. Verify destroyed Electron windows do not throw on IPC or global shortcuts
      const ipcHandlers = new Map<string, (event: unknown, req?: unknown) => Promise<unknown>>()
      const registeredShortcuts = new Map<string, () => void>()
      let hubDestroyed = false
      let overlayDestroyed = false
      let minimizeCalls = 0
      let overlayShowCalls = 0

      class DestroyableBrowserWindow {
        options: Record<string, unknown>
        isOverlay: boolean
        webContents = {
          isDestroyed: () => (this.isOverlay ? overlayDestroyed : hubDestroyed),
          send: () => {
            if (this.isOverlay ? overlayDestroyed : hubDestroyed) {
              throw new Error('Object has been destroyed')
            }
          },
        }
        constructor(options: Record<string, unknown>) {
          this.options = options
          this.isOverlay = options.transparent === true
        }
        async loadURL() {}
        isDestroyed() {
          return this.isOverlay ? overlayDestroyed : hubDestroyed
        }
        minimize() {
          if (hubDestroyed) throw new Error('Object has been destroyed')
          minimizeCalls += 1
        }
        maximize() {
          if (hubDestroyed) throw new Error('Object has been destroyed')
        }
        unmaximize() {
          if (hubDestroyed) throw new Error('Object has been destroyed')
        }
        isMaximized() {
          if (hubDestroyed) throw new Error('Object has been destroyed')
          return false
        }
        close() {
          if (hubDestroyed) throw new Error('Object has been destroyed')
        }
        show() {
          if (overlayDestroyed) throw new Error('Object has been destroyed')
          overlayShowCalls += 1
        }
        hide() {
          if (overlayDestroyed) throw new Error('Object has been destroyed')
        }
        setIgnoreMouseEvents() {
          if (overlayDestroyed) throw new Error('Object has been destroyed')
        }
      }

      const booted = await bootAshyElectronMain({
        app: {
          getPath: () => userDataDir,
          on: () => {},
        },
        BrowserWindow: DestroyableBrowserWindow as unknown as never,
        ipcMain: {
          handle: (ch, fn) => {
            ipcHandlers.set(ch, fn as (event: unknown, req?: unknown) => Promise<unknown>)
          },
          removeHandler: (ch) => {
            ipcHandlers.delete(ch)
          },
        },
        globalShortcut: {
          register: (acc, cb) => {
            registeredShortcuts.set(acc, cb)
            return true
          },
          unregisterAll: () => {
            registeredShortcuts.clear()
          },
        },
        kernel,
        rendererUrl: 'http://localhost:5173',
      })

      try {
        hubDestroyed = true
        overlayDestroyed = true

        await expect(ipcHandlers.get('ashy:windowMinimize')!(null)).resolves.toEqual({
          minimized: true,
        })
        await expect(ipcHandlers.get('ashy:windowMaximize')!(null)).resolves.toEqual({
          maximized: true,
        })
        await expect(ipcHandlers.get('ashy:windowClose')!(null)).resolves.toEqual({
          closed: true,
        })
        await expect(
          ipcHandlers.get('ashy:setOverlayVisible')!(null, { visible: true }),
        ).resolves.toBeDefined()
        await expect(
          ipcHandlers.get('ashy:setOverlayIgnoreMouse')!(null, { ignore: true, forward: true }),
        ).resolves.toBeDefined()

        expect(minimizeCalls).toBe(0)
        expect(overlayShowCalls).toBe(0)

        const hideStageShortcut = registeredShortcuts.get('CommandOrControl+Shift+H')
        expect(hideStageShortcut).toBeTypeOf('function')
        expect(() => hideStageShortcut!()).not.toThrow()

        await vi.waitFor(async () => {
          const snap = await kernel.getBootstrapSnapshot()
          expect(snap.stagePreferences?.isStageHidden).toBe(true)
        })
      } finally {
        await booted.shutdown()
      }
    } finally {
      await kernel.stop()
    }
  })
})
