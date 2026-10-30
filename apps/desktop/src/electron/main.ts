import {
  DEFAULT_STAGE_OVERLAY_RUNTIME_STATE,
  type StageOverlayRuntimeState,
} from '@ashy/shared'
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
  getState: () => StageOverlayRuntimeState
  setIgnoreMouseEvents: (
    ignore: boolean,
    forward?: boolean,
  ) => { changed: boolean; state: StageOverlayRuntimeState }
  setOverlayVisible: (visible: boolean) => StageOverlayRuntimeState
  updateSilhouetteMask: (nextMask: Uint8Array) => void
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

  let currentMask = buildAvatarSilhouetteMask({
    centerX: 0.5,
    centerY: 0.58,
    scale: 1,
  })

  let runtimeState: StageOverlayRuntimeState = {
    ...DEFAULT_STAGE_OVERLAY_RUNTIME_STATE,
    shortcuts: { ...DEFAULT_STAGE_OVERLAY_RUNTIME_STATE.shortcuts },
  }

  const controller: AshyElectronOverlayController = {
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
    silhouetteMask: currentMask,
    getState() {
      return {
        ...runtimeState,
        shortcuts: { ...runtimeState.shortcuts },
      }
    },
    setIgnoreMouseEvents(ignore: boolean, _forward = true) {
      const nextIgnore = Boolean(ignore)
      if (nextIgnore === runtimeState.ignoringMouseEvents) {
        return {
          changed: false,
          state: controller.getState(),
        }
      }
      runtimeState = {
        ...runtimeState,
        ignoringMouseEvents: nextIgnore,
      }
      return {
        changed: true,
        state: controller.getState(),
      }
    },
    setOverlayVisible(visible: boolean) {
      const nextVisible = Boolean(visible)
      runtimeState = {
        ...runtimeState,
        isOverlayVisible: nextVisible,
        ignoringMouseEvents: nextVisible ? runtimeState.ignoringMouseEvents : false,
      }
      return controller.getState()
    },
    updateSilhouetteMask(nextMask: Uint8Array) {
      if (nextMask instanceof Uint8Array && nextMask.length === 128 * 72) {
        currentMask = nextMask
        controller.silhouetteMask = nextMask
      }
    },
    evaluateMouseClickThrough(params) {
      return shouldIgnoreMouseEvent({
        clientX: params.clientX,
        clientY: params.clientY,
        viewportWidth: width,
        viewportHeight: height,
        silhouetteMask: currentMask,
        isOverUiIsland: params.isOverUiIsland ?? false,
        uiIslandRects: params.uiIslandRects ?? defaultIslands,
        borderThresholdPx,
      })
    },
  }

  return controller
}
