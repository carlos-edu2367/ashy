import path from 'node:path'
import * as v from 'valibot'
import {
  DEFAULT_STAGE_SHORTCUTS,
  SetStageOverlayIgnoreMouseInputSchema,
  SetStageOverlayVisibleInputSchema,
  type AshyHostBridge,
  type AshyHostStreamEvent,
} from '@ashy/shared'
import {
  createAshyElectronOverlayConfig,
  type AshyElectronOverlayController,
} from '../electron/main'
import { createAshyHostKernel, type AshyHostKernel } from '../host/kernel'
import { createElectronSafeStorageProtector } from '../host/secret-protector'
import { dispatchHostRpc } from '../host/vite-host-plugin'

export interface ElectronWebContentsLike {
  isDestroyed?: () => boolean
  send(channel: string, payload: AshyHostStreamEvent): void
}

export interface ElectronIpcMainLike {
  handle(
    channel: string,
    listener: (
      event: unknown,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request?: any,
    ) => Promise<unknown> | unknown,
  ): void
  removeHandler(channel: string): void
}

export interface ElectronBrowserWindowInstanceLike {
  webContents: ElectronWebContentsLike
  loadURL(url: string): Promise<void>
  loadFile?(filePath: string): Promise<void>
  isDestroyed?(): boolean
  setIgnoreMouseEvents?(ignore: boolean, options?: { forward?: boolean }): void
  show?(): void
  hide?(): void
  isVisible?(): boolean
  minimize?(): void
  maximize?(): void
  unmaximize?(): void
  isMaximized?(): boolean
  close?(): void
}

function isWindowUsable(
  win: ElectronBrowserWindowInstanceLike | null | undefined,
): win is ElectronBrowserWindowInstanceLike {
  if (!win) return false
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false
  return true
}

export interface ElectronBrowserWindowConstructorLike {
  new (options: Record<string, unknown>): ElectronBrowserWindowInstanceLike
}

export interface ElectronAppLike {
  getPath(name: 'userData'): string
  on(event: 'before-quit', listener: () => void | Promise<void>): void
}

export interface ElectronSafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface ElectronGlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean
  unregisterAll(): void
}

export interface BootAshyElectronMainDeps {
  app: ElectronAppLike
  BrowserWindow: ElectronBrowserWindowConstructorLike
  ipcMain: ElectronIpcMainLike
  safeStorage?: ElectronSafeStorageLike
  globalShortcut?: ElectronGlobalShortcutLike
  kernel?: AshyHostKernel
  preloadPath?: string
  rendererUrl?: string
  processRef?: Pick<NodeJS.Process, 'once' | 'removeListener'>
}

export interface BootedAshyElectronRuntime {
  kernel: AshyHostKernel
  hubWindow: ElectronBrowserWindowInstanceLike
  overlayWindow: ElectronBrowserWindowInstanceLike
  overlayController: AshyElectronOverlayController
  shutdown(): Promise<void>
}

export interface RegisterAshyElectronIpcOverlayOptions {
  overlayController?: AshyElectronOverlayController
  overlayWindow?: ElectronBrowserWindowInstanceLike | null
  getOverlayWindow?: () => ElectronBrowserWindowInstanceLike | null | undefined
  hubWindow?: ElectronBrowserWindowInstanceLike | null
  getHubWindow?: () => ElectronBrowserWindowInstanceLike | null | undefined
}

export function registerAshyElectronIpc(
  ipcMain: ElectronIpcMainLike,
  kernel: AshyHostBridge,
  getWebContents: () => ReadonlyArray<ElectronWebContentsLike>,
  overlayOptions?: RegisterAshyElectronIpcOverlayOptions,
): () => void {
  const overlayController =
    overlayOptions?.overlayController ?? createAshyElectronOverlayConfig()
  const resolveOverlayWindow = (): ElectronBrowserWindowInstanceLike | null => {
    const candidate = overlayOptions?.getOverlayWindow?.() ?? overlayOptions?.overlayWindow ?? null
    return isWindowUsable(candidate) ? candidate : null
  }
  const resolveHubWindow = (): ElectronBrowserWindowInstanceLike | null => {
    const candidate = overlayOptions?.getHubWindow?.() ?? overlayOptions?.hubWindow ?? null
    return isWindowUsable(candidate) ? candidate : null
  }

  ipcMain.handle('ashy:rpc', async (_event, request) => {
    if (
      !request ||
      typeof request !== 'object' ||
      typeof request.method !== 'string'
    ) {
      throw new Error('Invalid Ashy IPC RPC request: expected { method: string, payload?: unknown }')
    }
    return dispatchHostRpc(kernel, request.method, request.payload)
  })

  ipcMain.handle('ashy:runDreamReflection', async (_event, payload) => {
    return dispatchHostRpc(kernel, 'runDreamReflection', payload)
  })

  ipcMain.handle('ashy:revertTraitEvolution', async (_event, payload) => {
    return dispatchHostRpc(kernel, 'revertTraitEvolution', payload)
  })

  ipcMain.handle('ashy:setOverlayIgnoreMouse', async (_event, payload) => {
    const parsed = v.parse(SetStageOverlayIgnoreMouseInputSchema, payload)
    const forward = parsed.forward ?? true
    const { changed, state } = overlayController.setIgnoreMouseEvents(
      parsed.ignore,
      forward,
    )
    if (changed) {
      resolveOverlayWindow()?.setIgnoreMouseEvents?.(parsed.ignore, { forward })
    }
    return state
  })

  ipcMain.handle('ashy:setOverlayVisible', async (_event, payload) => {
    const parsed = v.parse(SetStageOverlayVisibleInputSchema, payload)
    const state = overlayController.setOverlayVisible(parsed.visible)
    const overlayWin = resolveOverlayWindow()
    if (parsed.visible) {
      overlayWin?.show?.()
    } else {
      overlayWin?.hide?.()
    }
    return state
  })

  ipcMain.handle('ashy:getOverlayState', async () => {
    return overlayController.getState()
  })

  ipcMain.handle('ashy:windowMinimize', async () => {
    resolveHubWindow()?.minimize?.()
    return { minimized: true }
  })

  ipcMain.handle('ashy:windowMaximize', async () => {
    const win = resolveHubWindow()
    if (win?.isMaximized?.()) {
      win.unmaximize?.()
      return { maximized: false }
    }
    win?.maximize?.()
    return { maximized: true }
  })

  ipcMain.handle('ashy:windowClose', async () => {
    resolveHubWindow()?.close?.()
    return { closed: true }
  })

  const unsubscribe = kernel.onHostEvent((event) => {
    const targets = getWebContents()
    for (const target of targets) {
      if (target.isDestroyed?.()) {
        continue
      }
      try {
        target.send('ashy:event', event)
      } catch {
        // Ignore send errors on closing/destroyed webContents
      }
    }
  })

  let cleanedUp = false
  return () => {
    if (cleanedUp) return
    cleanedUp = true
    unsubscribe()
    ipcMain.removeHandler('ashy:rpc')
    ipcMain.removeHandler('ashy:runDreamReflection')
    ipcMain.removeHandler('ashy:revertTraitEvolution')
    ipcMain.removeHandler('ashy:setOverlayIgnoreMouse')
    ipcMain.removeHandler('ashy:setOverlayVisible')
    ipcMain.removeHandler('ashy:getOverlayState')
    ipcMain.removeHandler('ashy:windowMinimize')
    ipcMain.removeHandler('ashy:windowMaximize')
    ipcMain.removeHandler('ashy:windowClose')
  }
}

export async function bootAshyElectronMain(
  deps: BootAshyElectronMainDeps,
): Promise<BootedAshyElectronRuntime> {
  const userDataDir = deps.app.getPath('userData')
  const secretProtector = deps.safeStorage
    ? createElectronSafeStorageProtector(deps.safeStorage, userDataDir)
    : undefined

  const kernel =
    deps.kernel ??
    (await createAshyHostKernel({
      userDataDir,
      secretProtector,
    }))

  await kernel.start()

  const activeWindows: ElectronBrowserWindowInstanceLike[] = []
  const overlayController = createAshyElectronOverlayConfig()
  let hubWindowRef: ElectronBrowserWindowInstanceLike | null = null
  let overlayWindowRef: ElectronBrowserWindowInstanceLike | null = null

  // airi invariant: register all ipcMain.handle channels strictly BEFORE window.loadURL / loadFile
  const cleanupIpc = registerAshyElectronIpc(
    deps.ipcMain,
    kernel,
    () => activeWindows.map((win) => win.webContents),
    {
      overlayController,
      getOverlayWindow: () => overlayWindowRef,
      getHubWindow: () => hubWindowRef,
    },
  )

  const preloadPath =
    deps.preloadPath ?? path.resolve(process.cwd(), 'dist/preload/index.cjs')
  const baseRendererUrl =
    deps.rendererUrl ?? process.env.ASHY_ELECTRON_RENDERER_URL ?? 'http://localhost:5173'
  const overlayUrl = baseRendererUrl.includes('?')
    ? `${baseRendererUrl}&view=stage-overlay`
    : `${baseRendererUrl}?view=stage-overlay`

  const hubWindow = new deps.BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#13111C',
    show: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  hubWindowRef = hubWindow

  const overlayWindow = new deps.BrowserWindow({
    ...overlayController.browserWindowOptions,
    webPreferences: {
      ...overlayController.browserWindowOptions.webPreferences,
      preload: preloadPath,
    },
  })
  overlayWindowRef = overlayWindow

  activeWindows.push(hubWindow, overlayWindow)

  await hubWindow.loadURL(baseRendererUrl)
  await overlayWindow.loadURL(overlayUrl)

  if (deps.globalShortcut) {
    const broadcastShortcutEvent = (
      action: 'toggleMic' | 'toggleEyes' | 'toggleDnd' | 'toggleHideStage',
    ) => {
      const evt: AshyHostStreamEvent = {
        type: 'shortcut:triggered',
        action,
      }
      if (typeof kernel.emitHostEvent === 'function') {
        kernel.emitHostEvent(evt)
      } else {
        for (const win of activeWindows) {
          if (isWindowUsable(win) && !win.webContents.isDestroyed?.()) {
            win.webContents.send('ashy:event', evt)
          }
        }
      }
    }

    deps.globalShortcut.register(DEFAULT_STAGE_SHORTCUTS.electronGlobalMic, () => {
      void (async () => {
        try {
          const snap = await kernel.getAgencySnapshot?.()
          if (snap) {
            const nextMic = snap.consent.micMode === 'muted' ? 'continuous' : 'muted'
            await kernel.updateAgencyConsent?.({ micMode: nextMic })
          }
          broadcastShortcutEvent('toggleMic')
        } catch {
          // ignore shortcut error
        }
      })()
    })
    deps.globalShortcut.register(DEFAULT_STAGE_SHORTCUTS.electronGlobalEyes, () => {
      void (async () => {
        try {
          const snap = await kernel.getAgencySnapshot?.()
          if (snap) {
            const nextEyes =
              snap.consent.eyesMode === 'window'
                ? 'screen'
                : snap.consent.eyesMode === 'screen'
                  ? 'off'
                  : 'window'
            await kernel.updateAgencyConsent?.({ eyesMode: nextEyes })
          }
          broadcastShortcutEvent('toggleEyes')
        } catch {
          // ignore shortcut error
        }
      })()
    })
    deps.globalShortcut.register(DEFAULT_STAGE_SHORTCUTS.electronGlobalDnd, () => {
      void (async () => {
        try {
          const snap = await kernel.getAgencySnapshot?.()
          if (snap) {
            const nextDnd = !snap.consent.dndMode
            await kernel.updateAgencyConsent?.({ dndMode: nextDnd })
          }
          broadcastShortcutEvent('toggleDnd')
        } catch {
          // ignore shortcut error
        }
      })()
    })
    deps.globalShortcut.register(DEFAULT_STAGE_SHORTCUTS.electronGlobalHideStage, () => {
      void (async () => {
        try {
          const nextVisible = !overlayController.getState().isOverlayVisible
          overlayController.setOverlayVisible(nextVisible)
          if (isWindowUsable(overlayWindow)) {
            if (nextVisible) {
              overlayWindow.show?.()
            } else {
              overlayWindow.hide?.()
            }
          }
          await kernel.updateStagePreferences?.({ isStageHidden: !nextVisible })
          broadcastShortcutEvent('toggleHideStage')
        } catch {
          // ignore shortcut error
        }
      })()
    })
  }

  let isShuttingDown = false
  const processRef = deps.processRef ?? process

  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) return
    isShuttingDown = true
    processRef.removeListener('SIGINT', onSigInt)
    deps.globalShortcut?.unregisterAll()
    cleanupIpc()
    await kernel.stop()
  }

  const onSigInt = () => {
    void shutdown()
  }

  deps.app.on('before-quit', () => {
    void shutdown()
  })
  processRef.once('SIGINT', onSigInt)

  return {
    kernel,
    hubWindow,
    overlayWindow,
    overlayController,
    shutdown,
  }
}
