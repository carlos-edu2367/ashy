import type { AshyHostBridge } from '@ashy/shared'
import type { AshyElectronOverlayController } from '../electron/main'

export interface ElectronTrayInstanceLike {
  setToolTip(toolTip: string): void
  setContextMenu(menu: unknown): void
  destroy(): void
}

export interface ElectronTrayConstructorLike {
  new (iconPath: string): ElectronTrayInstanceLike
}

export interface ElectronMenuItemTemplate {
  id?: string
  label?: string
  type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
  enabled?: boolean
  checked?: boolean
  click?: () => void | Promise<void>
}

export interface ElectronMenuLike {
  buildFromTemplate(template: ElectronMenuItemTemplate[]): unknown
}

export interface TrayWindowTargetLike {
  isDestroyed?(): boolean
  isVisible?(): boolean
  show?(): void
  hide?(): void
  focus?(): void
}

export type AshyTrayMenuItemId =
  | 'toggle-hub'
  | 'toggle-overlay'
  | 'toggle-mic'
  | 'privacy-shield'
  | 'check-updates'
  | 'quit'

export interface CreateAshySystemTrayOptions {
  Tray: ElectronTrayConstructorLike
  Menu: ElectronMenuLike
  iconPath: string
  kernel: AshyHostBridge
  overlayController?: AshyElectronOverlayController
  getHubWindow: () => TrayWindowTargetLike | null | undefined
  getOverlayWindow: () => TrayWindowTargetLike | null | undefined
  onActivatePrivacyShield: () => void | Promise<void>
  onCheckForUpdates?: () => void | Promise<void>
  onQuit: () => void | Promise<void>
}

export interface AshySystemTrayController {
  tray: ElectronTrayInstanceLike
  rebuildMenu(): void
  triggerMenuItem(id: AshyTrayMenuItemId | string): Promise<void>
  destroy(): void
}

function isTrayWindowUsable(
  win: TrayWindowTargetLike | null | undefined,
): win is TrayWindowTargetLike {
  if (!win) return false
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false
  return true
}

export function createAshySystemTray(
  options: CreateAshySystemTrayOptions,
): AshySystemTrayController {
  const tray = new options.Tray(options.iconPath)
  tray.setToolTip('Ashy — Cozy Night Studio')

  let currentTemplate: ElectronMenuItemTemplate[] = []
  let destroyed = false

  const handleToggleHub = async (): Promise<void> => {
    const hubWin = options.getHubWindow()
    if (!isTrayWindowUsable(hubWin)) return
    const visible = typeof hubWin.isVisible === 'function' ? hubWin.isVisible() : true
    if (visible) {
      hubWin.hide?.()
    } else {
      hubWin.show?.()
      hubWin.focus?.()
    }
  }

  const handleToggleOverlay = async (): Promise<void> => {
    const overlayWin = options.getOverlayWindow()
    const currentVisible = options.overlayController
      ? options.overlayController.getState().isOverlayVisible
      : isTrayWindowUsable(overlayWin) && typeof overlayWin.isVisible === 'function'
        ? overlayWin.isVisible()
        : true

    const nextVisible = !currentVisible
    options.overlayController?.setOverlayVisible(nextVisible)

    if (isTrayWindowUsable(overlayWin)) {
      if (nextVisible) {
        overlayWin.show?.()
      } else {
        overlayWin.hide?.()
      }
    }

    await options.kernel.updateStagePreferences?.({
      isStageHidden: !nextVisible,
    })
  }

  const handleToggleMic = async (): Promise<void> => {
    const snap = await options.kernel.getAgencySnapshot?.()
    const currentMic = snap?.consent.micMode ?? 'muted'
    const nextMic = currentMic === 'muted' ? 'continuous' : 'muted'
    await options.kernel.updateAgencyConsent?.({ micMode: nextMic })
  }

  const handlePrivacyShield = async (): Promise<void> => {
    await options.onActivatePrivacyShield()
  }

  const handleCheckUpdates = async (): Promise<void> => {
    await options.onCheckForUpdates?.()
  }

  const handleQuit = async (): Promise<void> => {
    await options.onQuit()
  }

  const buildTemplate = (): ElectronMenuItemTemplate[] => [
    {
      id: 'toggle-hub',
      label: 'Mostrar / Ocultar Estúdio',
      click: () => {
        void handleToggleHub()
      },
    },
    {
      id: 'toggle-overlay',
      label: 'Mostrar / Ocultar Avatar Flutuante',
      click: () => {
        void handleToggleOverlay()
      },
    },
    {
      type: 'separator',
    },
    {
      id: 'toggle-mic',
      label: 'Silenciar / Ativar Microfone',
      click: () => {
        void handleToggleMic()
      },
    },
    {
      id: 'privacy-shield',
      label: 'Escudo de Privacidade Total (Kill Switch)',
      click: () => {
        void handlePrivacyShield()
      },
    },
    {
      type: 'separator',
    },
    {
      id: 'check-updates',
      label: 'Verificar Atualizações...',
      click: () => {
        void handleCheckUpdates()
      },
    },
    {
      type: 'separator',
    },
    {
      id: 'quit',
      label: 'Sair da Ashy',
      click: () => {
        void handleQuit()
      },
    },
  ]

  const rebuildMenu = (): void => {
    if (destroyed) return
    currentTemplate = buildTemplate()
    const menu = options.Menu.buildFromTemplate(currentTemplate)
    tray.setContextMenu(menu)
  }

  const triggerMenuItem = async (id: AshyTrayMenuItemId | string): Promise<void> => {
    if (destroyed) return
    switch (id) {
      case 'toggle-hub':
        await handleToggleHub()
        return
      case 'toggle-overlay':
        await handleToggleOverlay()
        return
      case 'toggle-mic':
        await handleToggleMic()
        return
      case 'privacy-shield':
        await handlePrivacyShield()
        return
      case 'check-updates':
        await handleCheckUpdates()
        return
      case 'quit':
        await handleQuit()
        return
      default: {
        const item = currentTemplate.find((entry) => entry.id === id)
        if (item?.click) {
          await item.click()
        }
      }
    }
  }

  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    tray.destroy()
  }

  rebuildMenu()

  return {
    tray,
    rebuildMenu,
    triggerMenuItem,
    destroy,
  }
}
