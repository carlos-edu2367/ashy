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
import {
  createSafeAutoUpdater,
  type ElectronAutoUpdaterDriverLike,
  type SafeAutoUpdaterController,
} from './auto-updater'
import {
  createAshySystemTray,
  type AshySystemTrayController,
  type ElectronMenuLike,
  type ElectronTrayConstructorLike,
} from './tray-manager'

export interface ElectronWebContentsNavigationEventLike {
  preventDefault(): void
}

export interface ElectronWebContentsLike {
  isDestroyed?: () => boolean
  send(channel: string, payload: AshyHostStreamEvent): void
  on?(
    event: 'will-navigate',
    listener: (event: ElectronWebContentsNavigationEventLike, url: string) => void,
  ): void
  setWindowOpenHandler?(
    handler: (details: { url: string }) => { action: 'deny' | 'allow' },
  ): void
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
  setAlwaysOnTop?(
    flag: boolean,
    level?:
      | 'normal'
      | 'floating'
      | 'torn-off-menu'
      | 'modal-panel'
      | 'main-menu'
      | 'status'
      | 'pop-up-menu'
      | 'screen-saver',
  ): void
  show?(): void
  hide?(): void
  focus?(): void
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

export function isTrustedRendererUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim()
  if (!trimmed) return false
  if (trimmed === 'about:blank') return true

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'file:') {
      return true
    }
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return true
    }
    return false
  } catch {
    return false
  }
}

export function validateIpcSender(event: unknown): void {
  if (!event || typeof event !== 'object') {
    return
  }
  const senderFrame = (event as { senderFrame?: unknown }).senderFrame
  if (!senderFrame || typeof senderFrame !== 'object') {
    return
  }
  const rawUrl = (senderFrame as { url?: unknown }).url
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return
  }
  if (!isTrustedRendererUrl(rawUrl)) {
    throw new Error('Unauthorized IPC sender origin')
  }
}

function attachWindowSecurityGuards(win: ElectronBrowserWindowInstanceLike): void {
  win.webContents.on?.('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) {
      event.preventDefault()
    }
  })
  win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }))
}

export interface ElectronBrowserWindowConstructorLike {
  new (options: Record<string, unknown>): ElectronBrowserWindowInstanceLike
}

export interface ElectronAppLike {
  getPath(name: 'userData'): string
  on(event: 'before-quit', listener: () => void | Promise<void>): void
  quit?(): void
  isPackaged?: boolean
  getVersion?(): string
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
  Tray?: ElectronTrayConstructorLike
  Menu?: ElectronMenuLike
  trayIconPath?: string
  autoUpdaterDriver?: ElectronAutoUpdaterDriverLike
  isPackaged?: boolean
  appVersion?: string
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
  autoUpdater: SafeAutoUpdaterController
  trayController: AshySystemTrayController | null
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
    const candidate =
      overlayOptions?.getOverlayWindow?.() ?? overlayOptions?.overlayWindow ?? null
    return isWindowUsable(candidate) ? candidate : null
  }
  const resolveHubWindow = (): ElectronBrowserWindowInstanceLike | null => {
    const candidate = overlayOptions?.getHubWindow?.() ?? overlayOptions?.hubWindow ?? null
    return isWindowUsable(candidate) ? candidate : null
  }

  ipcMain.handle('ashy:rpc', async (event, request) => {
    validateIpcSender(event)
    if (
      !request ||
      typeof request !== 'object' ||
      typeof request.method !== 'string'
    ) {
      throw new Error(
        'Invalid Ashy IPC RPC request: expected { method: string, payload?: unknown }',
      )
    }
    return dispatchHostRpc(kernel, request.method, request.payload)
  })

  ipcMain.handle('ashy:runDreamReflection', async (event, payload) => {
    validateIpcSender(event)
    return dispatchHostRpc(kernel, 'runDreamReflection', payload)
  })

  ipcMain.handle('ashy:revertTraitEvolution', async (event, payload) => {
    validateIpcSender(event)
    return dispatchHostRpc(kernel, 'revertTraitEvolution', payload)
  })

  ipcMain.handle('ashy:setOverlayIgnoreMouse', async (event, payload) => {
    validateIpcSender(event)
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

  ipcMain.handle('ashy:setOverlayVisible', async (event, payload) => {
    validateIpcSender(event)
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

  ipcMain.handle('ashy:getOverlayState', async (event) => {
    validateIpcSender(event)
    return overlayController.getState()
  })

  ipcMain.handle('ashy:windowMinimize', async (event) => {
    validateIpcSender(event)
    resolveHubWindow()?.minimize?.()
    return { minimized: true }
  })

  ipcMain.handle('ashy:windowMaximize', async (event) => {
    validateIpcSender(event)
    const win = resolveHubWindow()
    if (win?.isMaximized?.()) {
      win.unmaximize?.()
      return { maximized: false }
    }
    win?.maximize?.()
    return { maximized: true }
  })

  ipcMain.handle('ashy:windowClose', async (event) => {
    validateIpcSender(event)
    resolveHubWindow()?.close?.()
    return { closed: true }
  })

  ipcMain.handle('localRuntime:getStatus', async (event) => {
    validateIpcSender(event)
    return dispatchHostRpc(kernel, 'localRuntime:getStatus', undefined)
  })

  ipcMain.handle('localRuntime:ensureRunning', async (event) => {
    validateIpcSender(event)
    return dispatchHostRpc(kernel, 'localRuntime:ensureRunning', undefined)
  })

  ipcMain.handle('localRuntime:installEngine', async (event) => {
    validateIpcSender(event)
    return dispatchHostRpc(kernel, 'localRuntime:installEngine', undefined)
  })

  ipcMain.handle('localRuntime:pullModel', async (event, payload) => {
    validateIpcSender(event)
    return dispatchHostRpc(kernel, 'localRuntime:pullModel', payload)
  })

  ipcMain.handle('localRuntime:deleteModel', async (event, payload) => {
    validateIpcSender(event)
    return dispatchHostRpc(kernel, 'localRuntime:deleteModel', payload)
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
    ipcMain.removeHandler('localRuntime:getStatus')
    ipcMain.removeHandler('localRuntime:ensureRunning')
    ipcMain.removeHandler('localRuntime:installEngine')
    ipcMain.removeHandler('localRuntime:pullModel')
    ipcMain.removeHandler('localRuntime:deleteModel')
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

  const broadcastHostStreamEvent = (evt: AshyHostStreamEvent): void => {
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

  const broadcastShortcutEvent = (
    action:
      | 'toggleMic'
      | 'toggleEyes'
      | 'toggleDnd'
      | 'toggleHideStage'
      | 'togglePtt'
      | 'activatePrivacyShield',
  ): void => {
    broadcastHostStreamEvent({
      type: 'shortcut:triggered',
      action,
    })
  }

  const autoUpdater = createSafeAutoUpdater({
    currentVersion: deps.appVersion ?? deps.app.getVersion?.() ?? '1.0.0',
    isPackaged: deps.isPackaged ?? deps.app.isPackaged ?? false,
    driver: deps.autoUpdaterDriver,
    onStateChange: (state) => {
      broadcastHostStreamEvent({
        type: 'updater:status',
        state,
      })
    },
  })

  // Wire SafeAutoUpdater into kernel so RPCs (getUpdateState, checkForUpdates, downloadUpdate, quitAndInstallUpdate) use it
  kernel.getUpdateState = async () => autoUpdater.getState()
  kernel.checkForUpdates = async () => autoUpdater.checkForUpdates()
  kernel.downloadUpdate = async () => autoUpdater.downloadUpdate()
  kernel.quitAndInstallUpdate = async () => autoUpdater.quitAndInstallUpdate()

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
      webSecurity: true,
    },
  })
  hubWindowRef = hubWindow
  attachWindowSecurityGuards(hubWindow)

  const overlayWindow = new deps.BrowserWindow({
    ...overlayController.browserWindowOptions,
    webPreferences: {
      ...overlayController.browserWindowOptions.webPreferences,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  overlayWindowRef = overlayWindow
  overlayWindow.setAlwaysOnTop?.(true, 'screen-saver')
  attachWindowSecurityGuards(overlayWindow)

  activeWindows.push(hubWindow, overlayWindow)

  await hubWindow.loadURL(baseRendererUrl)
  await overlayWindow.loadURL(overlayUrl)

  const activatePrivacyShieldAndBroadcast = async (): Promise<void> => {
    await kernel.activatePrivacyShield()
    broadcastShortcutEvent('activatePrivacyShield')
  }

  if (deps.globalShortcut) {
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

    deps.globalShortcut.register(DEFAULT_STAGE_SHORTCUTS.electronGlobalPtt, () => {
      void (async () => {
        try {
          const snap = await kernel.getAgencySnapshot?.()
          if (snap) {
            const nextMic = snap.consent.micMode === 'ptt' ? 'muted' : 'ptt'
            await kernel.updateAgencyConsent?.({ micMode: nextMic })
          }
          broadcastShortcutEvent('togglePtt')
        } catch {
          // ignore shortcut error
        }
      })()
    })

    deps.globalShortcut.register(
      DEFAULT_STAGE_SHORTCUTS.electronGlobalPrivacyShield,
      () => {
        void (async () => {
          try {
            await activatePrivacyShieldAndBroadcast()
          } catch {
            // ignore shortcut error
          }
        })()
      },
    )
  }

  let isShuttingDown = false
  const processRef = deps.processRef ?? process

  let trayController: AshySystemTrayController | null = null
  if (deps.Tray && deps.Menu) {
    const trayIconPath =
      deps.trayIconPath ?? path.resolve(process.cwd(), 'build/tray-icon.png')
    trayController = createAshySystemTray({
      Tray: deps.Tray,
      Menu: deps.Menu,
      iconPath: trayIconPath,
      kernel,
      overlayController,
      getHubWindow: () => hubWindowRef,
      getOverlayWindow: () => overlayWindowRef,
      onActivatePrivacyShield: activatePrivacyShieldAndBroadcast,
      onCheckForUpdates: async () => {
        await autoUpdater.checkForUpdates()
      },
      onQuit: async () => {
        await shutdown()
        deps.app.quit?.()
      },
    })
  }

  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) return
    isShuttingDown = true
    processRef.removeListener('SIGINT', onSigInt)
    trayController?.destroy()
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
    autoUpdater,
    trayController,
    shutdown,
  }
}
