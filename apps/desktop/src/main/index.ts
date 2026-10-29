import path from 'node:path'
import type { AshyHostBridge, AshyHostStreamEvent } from '@ashy/shared'
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
      request: { method: string; payload?: unknown },
    ) => Promise<unknown> | unknown,
  ): void
  removeHandler(channel: string): void
}

export interface ElectronBrowserWindowInstanceLike {
  webContents: ElectronWebContentsLike
  loadURL(url: string): Promise<void>
  loadFile?(filePath: string): Promise<void>
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

export interface BootAshyElectronMainDeps {
  app: ElectronAppLike
  BrowserWindow: ElectronBrowserWindowConstructorLike
  ipcMain: ElectronIpcMainLike
  safeStorage?: ElectronSafeStorageLike
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

export function registerAshyElectronIpc(
  ipcMain: ElectronIpcMainLike,
  kernel: AshyHostBridge,
  getWebContents: () => ReadonlyArray<ElectronWebContentsLike>,
): () => void {
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

  // airi invariant: register all ipcMain.handle channels strictly BEFORE window.loadURL / loadFile
  const cleanupIpc = registerAshyElectronIpc(deps.ipcMain, kernel, () =>
    activeWindows.map((win) => win.webContents),
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

  const overlayController = createAshyElectronOverlayConfig()
  const overlayWindow = new deps.BrowserWindow({
    ...overlayController.browserWindowOptions,
    webPreferences: {
      ...overlayController.browserWindowOptions.webPreferences,
      preload: preloadPath,
    },
  })

  activeWindows.push(hubWindow, overlayWindow)

  await hubWindow.loadURL(baseRendererUrl)
  await overlayWindow.loadURL(overlayUrl)

  let isShuttingDown = false
  const processRef = deps.processRef ?? process

  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) return
    isShuttingDown = true
    processRef.removeListener('SIGINT', onSigInt)
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
