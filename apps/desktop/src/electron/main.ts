import {
  buildAvatarSilhouetteMask,
  shouldIgnoreMouseEvent,
  type UiIslandRect,
} from '@ashy/stage'

export interface AshyElectronOverlayOptions {
  width?: number
  height?: number
  borderThresholdPx?: number
  uiIslandRects?: readonly UiIslandRect[]
}

export interface AshyElectronBrowserWindowConfig {
  width: number
  height: number
  transparent: true
  frame: false
  resizable: true
  hasShadow: false
  skipTaskbar: false
  alwaysOnTop: true
  alwaysOnTopLevel: 'screen-saver'
  webPreferences: {
    contextIsolation: true
    nodeIntegration: false
    backgroundThrottling: false
  }
}

export interface AshyElectronOverlayController {
  browserWindowOptions: AshyElectronBrowserWindowConfig
  silhouetteMask: Uint8Array
  evaluateMouseClickThrough: (params: {
    clientX: number
    clientY: number
    isOverUiIsland?: boolean
    uiIslandRects?: readonly UiIslandRect[]
  }) => boolean
}

/**
 * Creates the Electron transparent overlay configuration and O(1) CPU click-through hit-tester
 * (`setIgnoreMouseEvents(shouldIgnore, { forward: true })` at `screen-saver` z-order).
 */
export function createAshyElectronOverlayConfig(
  options: AshyElectronOverlayOptions = {},
): AshyElectronOverlayController {
  const width = options.width ?? 380
  const height = options.height ?? 460
  const borderThresholdPx = options.borderThresholdPx ?? 10
  const defaultIslands = options.uiIslandRects ?? []

  const silhouetteMask = buildAvatarSilhouetteMask({
    centerX: 0.5,
    centerY: 0.58,
    scale: 1,
  })

  return {
    browserWindowOptions: {
      width,
      height,
      transparent: true,
      frame: false,
      resizable: true,
      hasShadow: false,
      skipTaskbar: false,
      alwaysOnTop: true,
      alwaysOnTopLevel: 'screen-saver',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    },
    silhouetteMask,
    evaluateMouseClickThrough(params) {
      return shouldIgnoreMouseEvent({
        clientX: params.clientX,
        clientY: params.clientY,
        viewportWidth: width,
        viewportHeight: height,
        silhouetteMask,
        isOverUiIsland: params.isOverUiIsland ?? false,
        uiIslandRects: params.uiIslandRects ?? defaultIslands,
        borderThresholdPx,
      })
    },
  }
}
