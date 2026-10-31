// @vitest-environment jsdom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { createAshyHostKernel } from '../host/kernel'
import { registerAshyElectronIpc } from '../main/index'
import { createAshyPreloadApi } from '../preload/index'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const tempDirs: string[] = []
const activeKernels: Array<{ stop(): Promise<void> }> = []
let container: HTMLDivElement | null = null
let root: Root | null = null
let originalSearch = ''

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-ui-p92-overlay-'))
  tempDirs.push(dir)
  return dir
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
  window.history.replaceState({}, '', '/?view=stage-overlay')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetAshyStore()
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

describe('Phase 9.2 — 100% Transparent Overlay & Free Pointer Dragging', () => {
  it('1. renders transparent overlay without studio chat form or opaque card borders, hides idle bubble/HUD, and drags via setOverlayPosition IPC while locking interactive mouse', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    const setOverlayPosition = vi.fn(async ({ x, y }: { x: number; y: number }) => ({
      x,
      y,
      width: 380,
      height: 460,
    }))
    const getOverlayBounds = vi.fn(async () => ({
      x: 100,
      y: 100,
      width: 380,
      height: 460,
    }))
    const focusHubWindow = vi.fn(async () => ({ focused: true }))
    const setOverlayIgnoreMouse = vi.fn(async ({ ignore }: { ignore: boolean }) => ({
      isOverlayVisible: true,
      ignoringMouseEvents: ignore,
      activeStageMode: 'tachie' as const,
      loadedLive2DModelName: 'ashy-default.model3.json',
      shortcuts: {
        toggleMic: 'Alt+M',
        toggleEyes: 'Alt+E',
        toggleDnd: 'Alt+D',
        toggleHideStage: 'Alt+H',
        electronGlobalMic: 'CommandOrControl+Shift+M',
        electronGlobalEyes: 'CommandOrControl+Shift+E',
        electronGlobalDnd: 'CommandOrControl+Shift+D',
        electronGlobalHideStage: 'CommandOrControl+Shift+H',
      },
    }))

    ;(globalThis as Record<string, unknown>).ashyHost = {
      invoke: vi.fn().mockResolvedValue({}),
      onEvent: () => () => {},
      setOverlayPosition,
      getOverlayBounds,
      focusHubWindow,
      setOverlayIgnoreMouse,
    }

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    const overlayEl = getByTestId('floating-stage-overlay')
    expect(overlayEl.style.background).toBe('transparent')
    expect(overlayEl.style.padding).toBe('0px')
    expect(document.documentElement.style.backgroundColor).toBe('transparent')
    expect(document.body.style.backgroundColor).toBe('transparent')
    expect(document.body.style.overflow).toBe('hidden')

    // Studio text input & bottom sensor bar must NOT clutter the transparent overlay pet
    expect(container?.querySelector('[data-testid="stage-chat-input"]')).toBeNull()
    expect(container?.querySelector('[data-testid="btn-stage-barge-in"]')).toBeNull()

    // Quick controls and header remain in DOM for hover access, hidden (opacity: 0) at rest
    const quickControls = getByTestId('stage-quick-controls')
    expect(quickControls.style.opacity).toBe('0')

    await act(async () => {
      overlayEl.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }),
      )
    })
    expect(Number(quickControls.style.opacity)).toBeGreaterThan(0.8)

    // Clicking 'Voltar ao estúdio' in transparent overlay calls focusHubWindow IPC instead of turning tiny overlay into hub
    const expandBtn = getByTestId('btn-expand-hub')
    await act(async () => {
      expandBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(focusHubWindow).toHaveBeenCalledTimes(1)
    expect(useAshyStore.getState().viewMode).toBe('stage')

    // Live2D parameter HUD must not render when transparentBackground is true
    await act(async () => {
      useAshyStore.getState().setStageMode('live2d')
    })
    expect(container?.querySelector('[data-testid="live2d-parameter-hud"]')).toBeNull()

    // Idle empty/... bubble must be hidden on transparent background
    await act(async () => {
      useAshyStore.setState({ bubbleText: '...', presenceStatus: 'Idle' })
    })
    expect(container?.querySelector('[data-testid="ashy-presence-bubble"]')).toBeNull()

    // Pointer dragging on stage canvas updates overlay position via IPC
    const canvas = getByTestId('ashy-stage-canvas')
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 380,
      height: 460,
      right: 380,
      bottom: 460,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    await act(async () => {
      canvas.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          button: 0,
          screenX: 200,
          screenY: 200,
          clientX: 190,
          clientY: 230,
        }),
      )
    })

    // While dragging, moving mouse over transparent corner (10, 10) must NOT enable click-through
    await act(async () => {
      canvas.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: 10,
          clientY: 10,
          screenX: 340,
          screenY: 280,
        }),
      )
      window.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          screenX: 340,
          screenY: 280,
        }),
      )
    })

    expect(useAshyStore.getState().ignoringMouseEvents).toBe(false)
    expect(setOverlayPosition).toHaveBeenCalledWith({ x: 240, y: 180 })

    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })

    // Adversarial: right-click (button: 2) or mousedown inside a UI island does NOT drag
    setOverlayPosition.mockClear()
    await act(async () => {
      canvas.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          button: 2,
          screenX: 340,
          screenY: 280,
        }),
      )
      window.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          screenX: 400,
          screenY: 320,
        }),
      )
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    expect(setOverlayPosition).not.toHaveBeenCalled()

    const micBtn = getByTestId('btn-quick-mic')
    await act(async () => {
      micBtn.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          button: 0,
          screenX: 340,
          screenY: 280,
        }),
      )
      window.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          screenX: 450,
          screenY: 360,
        }),
      )
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    expect(setOverlayPosition).not.toHaveBeenCalled()
  })

  it('2. wires ashy:getOverlayBounds, ashy:setOverlayPosition (with clamping), and ashy:focusHubWindow across Electron IPC and Preload API', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)

    const handlers = new Map<
      string,
      (event: unknown, req?: unknown) => Promise<unknown> | unknown
    >()
    const fakeIpcMain = {
      handle: vi.fn(
        (
          channel: string,
          handler: (event: unknown, req?: unknown) => Promise<unknown> | unknown,
        ) => {
          handlers.set(channel, handler)
        },
      ),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel)
      }),
    }

    let currentBounds = { x: 120, y: 120, width: 380, height: 460 }
    const fakeOverlayWindow = {
      webContents: { isDestroyed: () => false, send: vi.fn() },
      loadURL: vi.fn(async () => undefined),
      getBounds: vi.fn(() => ({ ...currentBounds })),
      setBounds: vi.fn((b: { x: number; y: number; width: number; height: number }) => {
        currentBounds = { ...b }
      }),
    }
    const fakeHubWindow = {
      webContents: { isDestroyed: () => false, send: vi.fn() },
      loadURL: vi.fn(async () => undefined),
      show: vi.fn(),
      focus: vi.fn(),
    }

    const overlayPositionFilePath = path.join(dir, 'overlay-bounds.json')
    const cleanup = registerAshyElectronIpc(fakeIpcMain, kernel, () => [], {
      overlayWindow: fakeOverlayWindow,
      hubWindow: fakeHubWindow,
      overlayPositionFilePath,
    })

    const preloadApi = createAshyPreloadApi({
      invoke: async (channel: string, req?: unknown) => {
        const h = handlers.get(channel)
        if (!h) throw new Error(`Missing IPC channel: ${channel}`)
        return h({ senderFrame: { url: 'http://127.0.0.1:5173/?view=stage-overlay' } }, req)
      },
      on: vi.fn(),
      removeListener: vi.fn(),
    })

    const bounds0 = await preloadApi.getOverlayBounds!()
    expect(bounds0).toEqual({ x: 120, y: 120, width: 380, height: 460 })

    const bounds1 = await preloadApi.setOverlayPosition!({ x: 310.4, y: 245.8 })
    expect(bounds1).toEqual({ x: 310, y: 246, width: 380, height: 460 })
    expect(fakeOverlayWindow.setBounds).toHaveBeenCalledWith({
      x: 310,
      y: 246,
      width: 380,
      height: 460,
    })
    expect(JSON.parse(fs.readFileSync(overlayPositionFilePath, 'utf8'))).toEqual({
      x: 310,
      y: 246,
    })

    // Clamps extreme coordinates to [-10000, 10000]
    const boundsClamped = await preloadApi.setOverlayPosition!({ x: 999999, y: -999999 })
    expect(boundsClamped).toEqual({ x: 10000, y: -10000, width: 380, height: 460 })

    const focusRes = await preloadApi.focusHubWindow!()
    expect(focusRes).toEqual({ focused: true })
    expect(fakeHubWindow.show).toHaveBeenCalledTimes(1)
    expect(fakeHubWindow.focus).toHaveBeenCalledTimes(1)

    cleanup()
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith('ashy:getOverlayBounds')
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith('ashy:setOverlayPosition')
    expect(fakeIpcMain.removeHandler).toHaveBeenCalledWith('ashy:focusHubWindow')
  })
})
