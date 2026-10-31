import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_STAGE_SHORTCUTS,
  type AshyHostStreamEvent,
  type AutoUpdaterState,
} from '@ashy/shared'
import { createAshyElectronOverlayConfig } from '../electron/main'
import { createAshyHostKernel } from '../host/kernel'
import { createSafeAutoUpdater, type ElectronAutoUpdaterDriverLike } from '../main/auto-updater'
import {
  bootAshyElectronMain,
  isTrustedRendererUrl,
  registerAshyElectronIpc,
  validateIpcSender,
} from '../main/index'
import {
  createAshySystemTray,
  type ElectronMenuItemTemplate,
  type ElectronTrayInstanceLike,
} from '../main/tray-manager'
import { createAshyPreloadApi } from '../preload/index'
import { createPreloadHostBridge } from '../services/ashy-host-client'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-phase9-el-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('Phase 9 — Native Electron Lifecycle (System Tray, Global Shortcuts PTT & Privacy Shield, Safe AutoUpdater, Security Hardening & Packaging)', () => {
  it('1. creates System Tray with Cozy Night Studio tooltip and all 6 context menu items wired to hubWindow, overlayWindow, micMode, Privacy Shield, AutoUpdater & Quit', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    await kernel.start()

    try {
      let hubVisible = true
      const fakeHubWindow = {
        webContents: { isDestroyed: () => false, send: vi.fn() },
        loadURL: vi.fn(async () => undefined),
        show: vi.fn(() => {
          hubVisible = true
        }),
        hide: vi.fn(() => {
          hubVisible = false
        }),
        focus: vi.fn(),
        isVisible: vi.fn(() => hubVisible),
      }

      let overlayVisible = true
      const fakeOverlayWindow = {
        webContents: { isDestroyed: () => false, send: vi.fn() },
        loadURL: vi.fn(async () => undefined),
        show: vi.fn(() => {
          overlayVisible = true
        }),
        hide: vi.fn(() => {
          overlayVisible = false
        }),
        isVisible: vi.fn(() => overlayVisible),
      }

      const overlayController = createAshyElectronOverlayConfig()

      let builtTemplate: ElectronMenuItemTemplate[] = []
      const fakeTrayInstances: Array<{
        iconPath: string
        tooltip: string
        contextMenu: unknown
        destroyed: boolean
      }> = []

      class FakeTray implements ElectronTrayInstanceLike {
        iconPath: string
        tooltip = ''
        contextMenu: unknown = null
        destroyed = false

        constructor(iconPath: string) {
          this.iconPath = iconPath
          fakeTrayInstances.push(this)
        }
        setToolTip(toolTip: string) {
          this.tooltip = toolTip
        }
        setContextMenu(menu: unknown) {
          this.contextMenu = menu
        }
        destroy() {
          this.destroyed = true
        }
      }

      const fakeMenu = {
        buildFromTemplate: vi.fn((template: ElectronMenuItemTemplate[]) => {
          builtTemplate = template
          return { items: template }
        }),
      }

      const onActivatePrivacyShield = vi.fn(async () => {
        await kernel.activatePrivacyShield()
      })
      const onCheckForUpdates = vi.fn(async () => undefined)
      const onQuit = vi.fn(async () => undefined)

      const trayController = createAshySystemTray({
        Tray: FakeTray,
        Menu: fakeMenu,
        iconPath: '/fake/tray-icon.png',
        kernel,
        overlayController,
        getHubWindow: () => fakeHubWindow,
        getOverlayWindow: () => fakeOverlayWindow,
        onActivatePrivacyShield,
        onCheckForUpdates,
        onQuit,
      })

      expect(fakeTrayInstances).toHaveLength(1)
      expect(fakeTrayInstances[0]!.iconPath).toBe('/fake/tray-icon.png')
      expect(fakeTrayInstances[0]!.tooltip).toBe('Ashy — Cozy Night Studio')

      const itemIds = builtTemplate.filter((i) => i.id).map((i) => i.id)
      expect(itemIds).toEqual([
        'toggle-hub',
        'toggle-overlay',
        'toggle-mic',
        'privacy-shield',
        'check-updates',
        'quit',
      ])

      const labelsById = Object.fromEntries(
        builtTemplate.filter((i) => i.id).map((i) => [i.id, i.label]),
      )
      expect(labelsById['toggle-hub']).toBe('Mostrar / Ocultar Estúdio')
      expect(labelsById['toggle-overlay']).toBe('Mostrar / Ocultar Avatar Flutuante')
      expect(labelsById['toggle-mic']).toBe('Silenciar / Ativar Microfone')
      expect(labelsById['privacy-shield']).toBe('Escudo de Privacidade Total (Kill Switch)')
      expect(labelsById['check-updates']).toBe('Verificar Atualizações...')
      expect(labelsById['quit']).toBe('Sair da Ashy')

      // 1. toggle-hub hides visible hub, then shows + focuses hidden hub
      await trayController.triggerMenuItem('toggle-hub')
      expect(fakeHubWindow.hide).toHaveBeenCalledTimes(1)
      expect(hubVisible).toBe(false)

      await trayController.triggerMenuItem('toggle-hub')
      expect(fakeHubWindow.show).toHaveBeenCalledTimes(1)
      expect(fakeHubWindow.focus).toHaveBeenCalledTimes(1)
      expect(hubVisible).toBe(true)

      // 2. toggle-overlay hides overlay and updates stagePreferences.isStageHidden
      await trayController.triggerMenuItem('toggle-overlay')
      expect(fakeOverlayWindow.hide).toHaveBeenCalledTimes(1)
      expect(overlayController.getState().isOverlayVisible).toBe(false)
      const snapAfterHide = await kernel.getBootstrapSnapshot()
      expect(snapAfterHide.stagePreferences?.isStageHidden).toBe(true)

      await trayController.triggerMenuItem('toggle-overlay')
      expect(fakeOverlayWindow.show).toHaveBeenCalledTimes(1)
      expect(overlayController.getState().isOverlayVisible).toBe(true)
      const snapAfterShow = await kernel.getBootstrapSnapshot()
      expect(snapAfterShow.stagePreferences?.isStageHidden).toBe(false)

      // 3. toggle-mic switches muted <-> continuous
      expect((await kernel.getAgencySnapshot!()).consent.micMode).toBe('muted')
      await trayController.triggerMenuItem('toggle-mic')
      expect((await kernel.getAgencySnapshot!()).consent.micMode).toBe('continuous')
      await trayController.triggerMenuItem('toggle-mic')
      expect((await kernel.getAgencySnapshot!()).consent.micMode).toBe('muted')

      // 4. privacy-shield calls onActivatePrivacyShield
      await kernel.updateAgencyConsent!({ micMode: 'continuous', eyesMode: 'screen', dndMode: false })
      await trayController.triggerMenuItem('privacy-shield')
      expect(onActivatePrivacyShield).toHaveBeenCalledTimes(1)
      const snapAfterShield = await kernel.getAgencySnapshot!()
      expect(snapAfterShield.consent.micMode).toBe('muted')
      expect(snapAfterShield.consent.eyesMode).toBe('off')
      expect(snapAfterShield.consent.dndMode).toBe(true)

      // 5. check-updates & quit
      await trayController.triggerMenuItem('check-updates')
      expect(onCheckForUpdates).toHaveBeenCalledTimes(1)

      await trayController.triggerMenuItem('quit')
      expect(onQuit).toHaveBeenCalledTimes(1)

      // 6. destroy cleans up idempotently
      trayController.destroy()
      trayController.destroy()
      expect(fakeTrayInstances[0]!.destroyed).toBe(true)
    } finally {
      await kernel.stop()
    }
  })

  it('2. enforces explicit user consent in createSafeAutoUpdater (autoDownload=false, autoInstallOnAppQuit=false) and transitions idle -> checking -> available -> downloading -> downloaded -> quitAndInstall', async () => {
    const emittedStates: AutoUpdaterState[] = []
    let quitAndInstallArgs: [boolean, boolean] | null = null

    const fakeDriver: ElectronAutoUpdaterDriverLike = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      checkForUpdates: vi.fn(async () => ({
        updateInfo: { version: '1.1.0' },
      })),
      downloadUpdate: vi.fn(async () => ['ashy-1.1.0.exe']),
      quitAndInstall: vi.fn((isSilent?: boolean, isForceRunAfter?: boolean) => {
        quitAndInstallArgs = [Boolean(isSilent), Boolean(isForceRunAfter)]
      }),
    }

    const updater = createSafeAutoUpdater({
      currentVersion: '1.0.0',
      isPackaged: true,
      driver: fakeDriver,
      onStateChange: (state) => {
        emittedStates.push(state)
      },
    })

    // Immediately disables silent background downloads & installs
    expect(fakeDriver.autoDownload).toBe(false)
    expect(fakeDriver.autoInstallOnAppQuit).toBe(false)
    expect(updater.getState().autoDownload).toBe(false)
    expect(updater.getState().status).toBe('idle')

    // Adversarial: cannot downloadUpdate before an update is available
    await expect(updater.downloadUpdate()).rejects.toThrow(/available/i)
    // Adversarial: cannot quitAndInstallUpdate before update is downloaded
    await expect(updater.quitAndInstallUpdate()).rejects.toThrow(/downloaded/i)

    // Check for updates -> transitions through checking -> available
    const availableState = await updater.checkForUpdates()
    expect(availableState.status).toBe('available')
    expect(availableState.availableVersion).toBe('1.1.0')
    expect(availableState.autoDownload).toBe(false)
    expect(availableState.checkedAt).toBeTruthy()
    expect(emittedStates.some((s) => s.status === 'checking')).toBe(true)
    expect(emittedStates.at(-1)?.status).toBe('available')

    // Download update -> transitions downloading -> downloaded
    const downloadedState = await updater.downloadUpdate()
    expect(downloadedState.status).toBe('downloaded')
    expect(downloadedState.progressPercent).toBe(100)
    expect(emittedStates.some((s) => s.status === 'downloading')).toBe(true)
    expect(emittedStates.at(-1)?.status).toBe('downloaded')

    // Quit and install -> calls driver.quitAndInstall(false, true)
    const installRes = await updater.quitAndInstallUpdate()
    expect(installRes).toEqual({ ok: true })
    expect(quitAndInstallArgs).toEqual([false, true])

    // Unpackaged fallback without custom driver returns not-available cleanly
    const devUpdater = createSafeAutoUpdater({
      currentVersion: '1.0.0',
      isPackaged: false,
    })
    const devCheck = await devUpdater.checkForUpdates()
    expect(devCheck.status).toBe('not-available')
    expect(devCheck.checkedAt).toBeTruthy()
    expect(devCheck.autoDownload).toBe(false)
  })

  it('3. hardens BrowserWindow config (sandbox, webSecurity, contextIsolation, nodeIntegration=false, will-navigate & setWindowOpenHandler guards, alwaysOnTop screen-saver) and validates IPC sender origin', async () => {
    const dir = makeTempDir()
    const overlayCfg = createAshyElectronOverlayConfig()
    expect(overlayCfg.browserWindowOptions.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    })

    // Direct unit checks on isTrustedRendererUrl & validateIpcSender
    expect(isTrustedRendererUrl('http://localhost:5173/?view=stage-overlay')).toBe(true)
    expect(isTrustedRendererUrl('http://127.0.0.1:4173/index.html')).toBe(true)
    expect(isTrustedRendererUrl('file:///C:/Users/Ashy/dist/index.html')).toBe(true)
    expect(isTrustedRendererUrl('about:blank')).toBe(true)
    expect(isTrustedRendererUrl('https://evil.example.com/phish')).toBe(false)
    expect(isTrustedRendererUrl('http://localhost.evil.example.com/phish')).toBe(false)
    expect(isTrustedRendererUrl('javascript:alert(1)')).toBe(false)

    expect(() =>
      validateIpcSender({ senderFrame: { url: 'http://localhost:5173/index.html' } }),
    ).not.toThrow()
    expect(() =>
      validateIpcSender({ senderFrame: { url: 'https://evil.example.com/frame' } }),
    ).toThrow('Unauthorized IPC sender origin')
    expect(() =>
      validateIpcSender({ senderFrame: { url: 'http://127.0.0.1.evil.com/' } }),
    ).toThrow('Unauthorized IPC sender origin')

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

    const willNavigateListeners: Array<(event: { preventDefault: () => void }, url: string) => void> =
      []
    const windowOpenHandlers: Array<(details: { url: string }) => { action: 'deny' | 'allow' }> = []
    const alwaysOnTopCalls: Array<[boolean, string | undefined]> = []
    const createdOptions: Array<Record<string, unknown>> = []

    class HardenedFakeBrowserWindow {
      options: Record<string, unknown>
      webContents = {
        isDestroyed: () => false,
        send: vi.fn(),
        on: vi.fn(
          (
            event: string,
            listener: (ev: { preventDefault: () => void }, url: string) => void,
          ) => {
            if (event === 'will-navigate') {
              willNavigateListeners.push(listener)
            }
          },
        ),
        setWindowOpenHandler: vi.fn(
          (handler: (details: { url: string }) => { action: 'deny' | 'allow' }) => {
            windowOpenHandlers.push(handler)
          },
        ),
      }
      loadURL = vi.fn(async () => undefined)
      setAlwaysOnTop = vi.fn((flag: boolean, level?: string) => {
        alwaysOnTopCalls.push([flag, level])
      })
      setIgnoreMouseEvents = vi.fn()
      show = vi.fn()
      hide = vi.fn()

      constructor(options: Record<string, unknown>) {
        this.options = options
        createdOptions.push(options)
      }
    }

    const booted = await bootAshyElectronMain({
      app: {
        getPath: () => dir,
        on: vi.fn(),
      },
      BrowserWindow: HardenedFakeBrowserWindow as unknown as never,
      ipcMain: fakeIpcMain,
      rendererUrl: 'http://localhost:5173',
    })

    try {
      expect(createdOptions).toHaveLength(2)
      for (const winOpts of createdOptions) {
        const prefs = winOpts.webPreferences as Record<string, unknown>
        expect(prefs.sandbox).toBe(true)
        expect(prefs.webSecurity).toBe(true)
        expect(prefs.contextIsolation).toBe(true)
        expect(prefs.nodeIntegration).toBe(false)
      }

      // Overlay window must enforce setAlwaysOnTop(true, 'screen-saver')
      expect(alwaysOnTopCalls).toContainEqual([true, 'screen-saver'])

      // Both windows must attach will-navigate and setWindowOpenHandler guards
      expect(willNavigateListeners).toHaveLength(2)
      expect(windowOpenHandlers).toHaveLength(2)

      for (const openHandler of windowOpenHandlers) {
        expect(openHandler({ url: 'https://external.example.com' })).toEqual({ action: 'deny' })
      }

      for (const navListener of willNavigateListeners) {
        const evilEvent = { preventDefault: vi.fn() }
        navListener(evilEvent, 'https://evil.example.com/ takeover')
        expect(evilEvent.preventDefault).toHaveBeenCalledTimes(1)

        const trustedEvent = { preventDefault: vi.fn() }
        navListener(trustedEvent, 'http://localhost:5173/?view=stage-overlay')
        expect(trustedEvent.preventDefault).not.toHaveBeenCalled()
      }

      // Adversarial IPC invocation from untrusted frame must throw 'Unauthorized IPC sender origin'
      const evilIpcEvent = { senderFrame: { url: 'https://evil.example.com/frame' } }
      await expect(
        ipcHandlers.get('ashy:rpc')!(evilIpcEvent, { method: 'getBootstrapSnapshot' }),
      ).rejects.toThrow('Unauthorized IPC sender origin')
      await expect(
        ipcHandlers.get('ashy:windowMinimize')!(evilIpcEvent),
      ).rejects.toThrow('Unauthorized IPC sender origin')
    } finally {
      await booted.shutdown()
    }
  })

  it('4. registers all 6 Global Shortcuts including PTT (CommandOrControl+Shift+Space) and Privacy Shield Kill Switch (CommandOrControl+Shift+K), and wires AutoUpdater RPCs end-to-end', async () => {
    const dir = makeTempDir()
    const registeredShortcuts = new Map<string, () => void | Promise<void>>()
    const sentEvents: AshyHostStreamEvent[] = []
    const ipcHandlers = new Map<
      string,
      (event: unknown, req?: unknown) => Promise<unknown> | unknown
    >()

    class FakeBrowserWindow {
      webContents = {
        isDestroyed: () => false,
        send: vi.fn((channel: string, payload: AshyHostStreamEvent) => {
          if (channel === 'ashy:event') {
            sentEvents.push(payload)
          }
        }),
      }
      loadURL = vi.fn(async () => undefined)
      setAlwaysOnTop = vi.fn()
      setIgnoreMouseEvents = vi.fn()
      show = vi.fn()
      hide = vi.fn()
    }

    const fakeUpdaterDriver: ElectronAutoUpdaterDriverLike = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      checkForUpdates: vi.fn(async () => ({ updateInfo: { version: '1.2.0' } })),
      downloadUpdate: vi.fn(async () => ['ashy-1.2.0.exe']),
      quitAndInstall: vi.fn(),
    }

    const booted = await bootAshyElectronMain({
      app: {
        getPath: () => dir,
        on: vi.fn(),
      },
      BrowserWindow: FakeBrowserWindow as unknown as never,
      ipcMain: {
        handle: (ch, fn) => {
          ipcHandlers.set(ch, fn)
        },
        removeHandler: (ch) => {
          ipcHandlers.delete(ch)
        },
      },
      globalShortcut: {
        register: vi.fn((acc: string, cb: () => void) => {
          registeredShortcuts.set(acc, cb)
          return true
        }),
        unregisterAll: vi.fn(() => {
          registeredShortcuts.clear()
        }),
      },
      autoUpdaterDriver: fakeUpdaterDriver,
      isPackaged: true,
      rendererUrl: 'http://localhost:5173',
    })

    try {
      expect(registeredShortcuts.size).toBe(6)
      expect(Array.from(registeredShortcuts.keys())).toEqual(
        expect.arrayContaining([
          DEFAULT_STAGE_SHORTCUTS.electronGlobalMic,
          DEFAULT_STAGE_SHORTCUTS.electronGlobalEyes,
          DEFAULT_STAGE_SHORTCUTS.electronGlobalDnd,
          DEFAULT_STAGE_SHORTCUTS.electronGlobalHideStage,
          DEFAULT_STAGE_SHORTCUTS.electronGlobalPtt,
          DEFAULT_STAGE_SHORTCUTS.electronGlobalPrivacyShield,
        ]),
      )

      // Trigger PTT shortcut: muted -> ptt -> muted
      const pttShortcut = registeredShortcuts.get(DEFAULT_STAGE_SHORTCUTS.electronGlobalPtt)!
      await pttShortcut()
      await vi.waitFor(async () => {
        const snap = await booted.kernel.getAgencySnapshot!()
        expect(snap.consent.micMode).toBe('ptt')
      })
      expect(sentEvents).toContainEqual({
        type: 'shortcut:triggered',
        action: 'togglePtt',
      })

      await pttShortcut()
      await vi.waitFor(async () => {
        const snap = await booted.kernel.getAgencySnapshot!()
        expect(snap.consent.micMode).toBe('muted')
      })

      // Enable mic & eyes, then trigger Privacy Shield Kill Switch (CommandOrControl+Shift+K)
      await booted.kernel.updateAgencyConsent!({
        micMode: 'continuous',
        eyesMode: 'screen',
        dndMode: false,
      })
      const shieldShortcut = registeredShortcuts.get(
        DEFAULT_STAGE_SHORTCUTS.electronGlobalPrivacyShield,
      )!
      await shieldShortcut()

      await vi.waitFor(async () => {
        const snap = await booted.kernel.getAgencySnapshot!()
        expect(snap.consent.micMode).toBe('muted')
        expect(snap.consent.eyesMode).toBe('off')
        expect(snap.consent.dndMode).toBe(true)
      })
      expect(sentEvents).toContainEqual({
        type: 'shortcut:triggered',
        action: 'activatePrivacyShield',
      })

      // Test AutoUpdater RPC wiring via Preload Bridge
      const preloadApi = createAshyPreloadApi({
        invoke: (ch, req) =>
          ipcHandlers.get(ch)!(
            { senderFrame: { url: 'http://localhost:5173' } },
            req,
          ) as Promise<unknown>,
        on: vi.fn(),
        removeListener: vi.fn(),
      })
      const bridge = createPreloadHostBridge(preloadApi)

      const state0 = await bridge.getUpdateState!()
      expect(state0.autoDownload).toBe(false)
      expect(state0.status).toBe('idle')

      const stateChecked = await bridge.checkForUpdates!()
      expect(stateChecked.status).toBe('available')
      expect(stateChecked.availableVersion).toBe('1.2.0')
      expect(
        sentEvents.some(
          (e) => e.type === 'updater:status' && e.state.status === 'available',
        ),
      ).toBe(true)

      const stateDownloaded = await bridge.downloadUpdate!()
      expect(stateDownloaded.status).toBe('downloaded')

      const installRes = await bridge.quitAndInstallUpdate!()
      expect(installRes).toEqual({ ok: true })
      expect(fakeUpdaterDriver.quitAndInstall).toHaveBeenCalledWith(false, true)
    } finally {
      await booted.shutdown()
    }
  })

  it('5. verifies electron-builder.yml (valid v26 schema, github publish, AshySetup.exe), 256x256 icon.ico, macOS entitlements, package.json metadata/scripts, and Orin-style install.ps1 / install.sh / release.yml', async () => {
    const desktopRoot = path.resolve(__dirname, '../..')
    const repoRoot = path.resolve(desktopRoot, '../..')
    const builderYmlPath = path.join(desktopRoot, 'electron-builder.yml')
    const entitlementsPath = path.join(desktopRoot, 'build/entitlements.mac.plist')
    const buildScriptPath = path.join(desktopRoot, 'scripts/build-electron.mjs')
    const pkgJsonPath = path.join(desktopRoot, 'package.json')

    expect(fs.existsSync(builderYmlPath)).toBe(true)
    const builderYml = fs.readFileSync(builderYmlPath, 'utf8')
    expect(builderYml).toContain('appId: com.ashy.desktop')
    expect(builderYml).toContain('productName: Ashy')
    expect(builderYml).toContain('npmRebuild: false')
    expect(builderYml).toContain('hardenedRuntime: true')
    expect(builderYml).toContain('build/entitlements.mac.plist')
    expect(builderYml).toContain('provider: github')
    expect(builderYml).toContain('owner: carlos-edu2367')
    expect(builderYml).toContain('repo: ashy')
    expect(builderYml).not.toContain('autoUpdate:')
    expect(builderYml).toContain('artifactName: AshySetup.exe')
    expect(builderYml).toContain('artifactName: AshyPortable.exe')

    expect(fs.existsSync(entitlementsPath)).toBe(true)
    const entitlements = fs.readFileSync(entitlementsPath, 'utf8')
    expect(entitlements).toContain('com.apple.security.device.audio-input')
    expect(entitlements).toContain('com.apple.security.device.camera')
    expect(entitlements).toContain('com.apple.security.cs.allow-jit')

    expect(fs.existsSync(buildScriptPath)).toBe(true)

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
      description?: string
      author?: string
      homepage?: string
      scripts?: Record<string, string>
    }
    expect(pkgJson.description).toBeTruthy()
    expect(pkgJson.author).toBeTruthy()
    expect(pkgJson.homepage).toBe('https://github.com/carlos-edu2367/ashy')
    expect(pkgJson.scripts?.['build:electron']).toBe('node scripts/build-electron.mjs')
    expect(pkgJson.scripts?.['pack:dir']).toBe('pnpm build && pnpm build:electron')
    expect(pkgJson.scripts?.['electron:start']).toContain('electron ./dist/main/index.mjs')
    expect(pkgJson.scripts?.['dist:win']).toContain('electron-builder --win')

    const iconPngPath = path.join(desktopRoot, 'build/icon.png')
    const iconIcoPath = path.join(desktopRoot, 'build/icon.ico')
    const trayIconPath = path.join(desktopRoot, 'build/tray-icon.png')
    const mainBundlePath = path.join(desktopRoot, 'dist/main/index.mjs')
    const preloadBundlePath = path.join(desktopRoot, 'dist/preload/index.cjs')

    expect(fs.existsSync(iconPngPath)).toBe(true)
    expect(fs.existsSync(iconIcoPath)).toBe(true)
    expect(fs.existsSync(trayIconPath)).toBe(true)
    expect(fs.existsSync(mainBundlePath)).toBe(true)
    expect(fs.existsSync(preloadBundlePath)).toBe(true)

    const pngBuf = fs.readFileSync(iconPngPath)
    expect(Array.from(pngBuf.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    // Verify PNG IHDR width & height are 256x256
    expect(pngBuf.readUInt32BE(16)).toBe(256)
    expect(pngBuf.readUInt32BE(20)).toBe(256)

    const icoBuf = fs.readFileSync(iconIcoPath)
    expect(Array.from(icoBuf.subarray(0, 4))).toEqual([0, 0, 1, 0])
    // Verify ICO directory entry width & height bytes (0 = 256px in Windows ICO specification)
    expect(icoBuf[6]).toBe(0)
    expect(icoBuf[7]).toBe(0)

    const installPs1Path = path.join(repoRoot, 'install.ps1')
    const installShPath = path.join(repoRoot, 'install.sh')
    const releaseWorkflowPath = path.join(repoRoot, '.github/workflows/release.yml')

    expect(fs.existsSync(installPs1Path)).toBe(true)
    expect(fs.existsSync(installShPath)).toBe(true)
    expect(fs.existsSync(releaseWorkflowPath)).toBe(true)

    const installPs1 = fs.readFileSync(installPs1Path, 'utf8')
    expect(installPs1).toContain('carlos-edu2367/ashy')
    expect(installPs1).toContain('AshySetup.exe')
    expect(installPs1).toContain('-Uninstall')
    // Must be 100% 7-bit ASCII so Windows PowerShell 5.1 (ANSI/CP1252 when no BOM) never fails on UTF-8 bytes 0x93/0x94
    expect(/^[\x00-\x7F]*$/.test(installPs1)).toBe(true)
    if (process.platform === 'win32') {
      const { execFileSync } = await import('node:child_process')
      const parseOut = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${installPs1Path.replace(/'/g, "''")}', [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { throw ($errors | Out-String) }; Write-Output 'AST_OK'`,
        ],
        { encoding: 'utf8', windowsHide: true },
      )
      expect(parseOut.trim()).toContain('AST_OK')
    }

    const installSh = fs.readFileSync(installShPath, 'utf8')
    expect(installSh).toContain('carlos-edu2367/ashy')
    expect(installSh).toContain('Ashy-linux-x86_64.AppImage')
    expect(installSh).toContain('--uninstall')

    const releaseYml = fs.readFileSync(releaseWorkflowPath, 'utf8')
    expect(releaseYml).toContain('AshySetup.exe')
    expect(releaseYml).toContain('install.ps1')
    expect(releaseYml).toContain('install.sh')

    for (const readmeFile of ['README.md', 'README.pt-BR.md', 'README.en.md']) {
      const readmeContent = fs.readFileSync(path.join(repoRoot, readmeFile), 'utf8')
      expect(readmeContent).toContain(
        'irm https://github.com/carlos-edu2367/ashy/releases/latest/download/install.ps1 | iex',
      )
      expect(readmeContent).toContain(
        'curl -fsSL https://github.com/carlos-edu2367/ashy/releases/latest/download/install.sh | bash',
      )
    }
  })
})
