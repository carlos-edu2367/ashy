// @vitest-environment jsdom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { createAshyHostKernel } from '../host/kernel'
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-ui-p6-'))
  tempDirs.push(dir)
  return dir
}

function setNativeInputValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  if (descriptor?.set) {
    descriptor.set.call(element, value)
  } else {
    element.value = value
  }
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
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

describe('Phase 6 Digital Body & Presence — Stage Overlay Click-Through, Acoustic Lip-Sync, Quick Controls & Live2D Importer', () => {
  it('1. auto-boots into transparent stage overlay on ?view=stage-overlay and performs O(1) click-through hit-testing with IPC deduplication (Red-Team B1 & B2)', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    const setOverlayIgnoreMouseSpy = vi.fn(async () => ({
      isOverlayVisible: true,
      ignoringMouseEvents: false,
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
      setOverlayIgnoreMouse: setOverlayIgnoreMouseSpy,
    }

    // Boot with ?view=stage-overlay
    window.history.replaceState({}, '', '/?view=stage-overlay')
    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()

    expect(useAshyStore.getState().viewMode).toBe('stage')
    expect(useAshyStore.getState().isTransparentOverlayWindow).toBe(true)

    await useAshyStore.getState().bootstrapFromHost()
    // Must preserve viewMode and isTransparentOverlayWindow across bootstrapFromHost
    expect(useAshyStore.getState().viewMode).toBe('stage')
    expect(useAshyStore.getState().isTransparentOverlayWindow).toBe(true)

    await act(async () => {
      root!.render(<App />)
    })

    const overlayEl = getByTestId('floating-stage-overlay')
    expect(overlayEl.style.background).toBe('transparent')

    const stageCanvas = getByTestId('ashy-stage-canvas')
    // Red-Team B1: stageCanvas must NOT have a parent [data-ui-island="true"] wrapping it!
    expect(stageCanvas.parentElement?.closest('[data-ui-island="true"]')).toBeNull()

    vi.spyOn(stageCanvas, 'getBoundingClientRect').mockReturnValue({
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

    // 1. Move mouse over transparent background corner (80, 80) -> click-through ON
    await act(async () => {
      stageCanvas.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 80, clientY: 80 }),
      )
    })
    expect(useAshyStore.getState().ignoringMouseEvents).toBe(true)
    expect(useAshyStore.getState().ignoreMouseTransitionCount).toBe(1)
    expect(setOverlayIgnoreMouseSpy).toHaveBeenCalledTimes(1)
    expect(setOverlayIgnoreMouseSpy).toHaveBeenLastCalledWith({ ignore: true, forward: true })
    expect(getByTestId('stage-clickthrough-badge').textContent).toContain('Click-Through: ON')

    // Repeated move at (82, 82) in transparent zone -> deduplicated (no extra IPC call)
    await act(async () => {
      stageCanvas.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 82, clientY: 82 }),
      )
    })
    expect(useAshyStore.getState().ignoreMouseTransitionCount).toBe(1)
    expect(setOverlayIgnoreMouseSpy).toHaveBeenCalledTimes(1)

    // 2. Move mouse over opaque avatar center (180, 220) -> click-through OFF
    await act(async () => {
      stageCanvas.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 180, clientY: 220 }),
      )
    })
    expect(useAshyStore.getState().ignoringMouseEvents).toBe(false)
    expect(useAshyStore.getState().ignoreMouseTransitionCount).toBe(2)
    expect(setOverlayIgnoreMouseSpy).toHaveBeenCalledTimes(2)
    expect(setOverlayIgnoreMouseSpy).toHaveBeenLastCalledWith({ ignore: false, forward: true })
    expect(getByTestId('stage-clickthrough-badge').textContent).toContain('Click-Through: OFF')
  })

  it('2. runs acoustic lip-sync & <|ACT|> timeline synchronization (runStageLipSyncActDemo & turn markers) updating visemes, emotions, and motions (Red-Team B5)', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"<|ACT {\\"emotion\\":\\"smug\\",\\"intensity\\":0.9,\\"motion\\":\\"tease\\"}|> Provocação sincronizada!"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-phase6act1234',
      },
    })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    // 1. Run deterministic acoustic lip-sync + <|ACT|> demo
    const demoResult = await useAshyStore.getState().runStageLipSyncActDemo()
    expect(demoResult.visitedVisemes).toEqual(expect.arrayContaining(['A', 'O']))
    expect(demoResult.visitedEmotions).toEqual(expect.arrayContaining(['smug', 'excited']))
    expect(demoResult.visitedMotions).toEqual(expect.arrayContaining(['tease', 'bounce']))
    // After demo completes at 450ms, mouth returns to 'closed' and isSpeaking is false
    expect(useAshyStore.getState().activeViseme).toBe('closed')
    expect(useAshyStore.getState().isSpeaking).toBe(false)

    // 2. Verify live turn with <|ACT {"emotion":"smug","intensity":0.9,"motion":"tease"}|> updates activeMotion
    await useAshyStore.getState().sendUserMessage('Faz uma cara provocadora!')
    expect(useAshyStore.getState().stageEmotion).toBe('smug')
    expect(useAshyStore.getState().activeMotion).toBe('tease')
  })

  it('3. operates 1-click Stage Quick Controls and Alt+M/E/D/H keyboard shortcuts including hide/restore pill (Red-Team M2 & M3)', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    const setOverlayVisibleSpy = vi.fn(async ({ visible }: { visible: boolean }) => ({
      isOverlayVisible: visible,
      ignoringMouseEvents: false,
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
      setOverlayVisible: setOverlayVisibleSpy,
    }

    window.history.replaceState({}, '', '/?view=stage-overlay')
    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    expect(getByTestId('stage-quick-controls')).toBeTruthy()

    // 1. Mic toggle via button and Alt+M
    expect(useAshyStore.getState().privacyState.micMode).toBe('continuous')
    await act(async () => {
      clickElement(getByTestId('btn-quick-mic'))
    })
    expect(useAshyStore.getState().privacyState.micMode).toBe('muted')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', altKey: true, bubbles: true }))
    })
    expect(useAshyStore.getState().privacyState.micMode).toBe('continuous')

    // 2. Eyes mode cycle (window -> screen -> off -> window) via button and Alt+E
    expect(useAshyStore.getState().privacyState.eyesMode).toBe('window')
    await act(async () => {
      clickElement(getByTestId('btn-quick-eyes'))
    })
    expect(useAshyStore.getState().privacyState.eyesMode).toBe('screen')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', altKey: true, bubbles: true }))
    })
    expect(useAshyStore.getState().privacyState.eyesMode).toBe('off')

    // 3. DND toggle via button and Alt+D
    expect(useAshyStore.getState().privacyState.dndMode).toBe(false)
    await act(async () => {
      clickElement(getByTestId('btn-quick-dnd'))
    })
    expect(useAshyStore.getState().privacyState.dndMode).toBe(true)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', altKey: true, bubbles: true }))
    })
    expect(useAshyStore.getState().privacyState.dndMode).toBe(false)

    // 4. Hide stage while speaking (Red-Team M3: stops speech, resets ignoringMouseEvents, shows restore pill)
    await act(async () => {
      useAshyStore.getState().toggleSimulatedSpeech(true)
      useAshyStore.getState().setStageIgnoreMouseEvents(true)
    })
    expect(useAshyStore.getState().isSpeaking).toBe(true)
    expect(useAshyStore.getState().ignoringMouseEvents).toBe(true)

    await act(async () => {
      clickElement(getByTestId('btn-quick-hide-stage'))
    })
    expect(useAshyStore.getState().isStageHidden).toBe(true)
    expect(useAshyStore.getState().isSpeaking).toBe(false)
    expect(useAshyStore.getState().activeViseme).toBe('closed')
    expect(useAshyStore.getState().ignoringMouseEvents).toBe(false)
    expect(setOverlayVisibleSpy).toHaveBeenCalledWith({ visible: false })
    expect(container?.querySelector('[data-testid="ashy-stage-canvas"]')).toBeNull()
    expect(getByTestId('btn-restore-hidden-stage')).toBeTruthy()

    // Restore via restore pill button
    await act(async () => {
      clickElement(getByTestId('btn-restore-hidden-stage'))
    })
    expect(useAshyStore.getState().isStageHidden).toBe(false)
    expect(setOverlayVisibleSpy).toHaveBeenLastCalledWith({ visible: true })
    expect(getByTestId('ashy-stage-canvas')).toBeTruthy()

    // Hide and restore via Alt+H
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', altKey: true, bubbles: true }))
    })
    expect(useAshyStore.getState().isStageHidden).toBe(true)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', altKey: true, bubbles: true }))
    })
    expect(useAshyStore.getState().isStageHidden).toBe(false)
  })

  it('4. imports a custom Live2D .model3.json manifest in Aparência, switches stageMode to live2d, and injects formatLive2DControlPrompt into volatileTurnContext', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    await act(async () => {
      clickElement(getByTestId('tab-personality'))
    })

    const customModelJson = JSON.stringify({
      Version: 3,
      FileReferences: {
        Expressions: [
          { Name: 'cyber_smug', File: 'expressions/cyber_smug.exp3.json' },
          { Name: 'starry_excited', File: 'expressions/starry_excited.exp3.json' },
        ],
        Motions: {
          CyberBounce: [{ File: 'motions/bounce1.motion3.json' }, { File: 'motions/bounce2.motion3.json' }],
          HeadTilt: [{ File: 'motions/tilt.motion3.json' }],
        },
      },
      HitAreas: [{ Name: 'Head', Id: 'HitAreaHead' }],
    })

    const jsonInput = getByTestId<HTMLTextAreaElement>('live2d-json-import-input')
    const importBtn = getByTestId<HTMLButtonElement>('btn-import-live2d-json')

    await act(async () => {
      setNativeInputValue(jsonInput, customModelJson)
      clickElement(importBtn)
    })

    const state = useAshyStore.getState()
    expect(state.stageMode).toBe('live2d')
    expect(state.live2dModelControls.expressions).toEqual(['cyber_smug', 'starry_excited'])
    expect(state.live2dModelControls.motionGroups).toEqual([
      { name: 'CyberBounce', count: 2 },
      { name: 'HeadTilt', count: 1 },
    ])
    expect(getByTestId('live2d-loaded-expressions-badge').textContent).toContain('cyber_smug')
    expect(state.lastPrompt.volatileTurnContext).toContain('[STAGE AVATAR CAPABILITIES]')
    expect(state.lastPrompt.volatileTurnContext).toContain('cyber_smug, starry_excited')
    expect(state.lastPrompt.volatileTurnContext).toContain('CyberBounce (2)')

    // Adversarial: malformed JSON import throws cleanly and preserves existing valid controls
    expect(() => useAshyStore.getState().importLive2DModelJson('{broken json')).toThrow(
      /Invalid Live2D \.model3\.json/,
    )
    expect(useAshyStore.getState().live2dModelControls.expressions).toEqual([
      'cyber_smug',
      'starry_excited',
    ])

    // Adversarial: invalid motion preset falls back to 'idle' without corrupting state
    await act(async () => {
      useAshyStore.getState().triggerStageMotion('backflip' as unknown as 'idle')
    })
    expect(useAshyStore.getState().activeMotion).toBe('idle')
  })

  it('5. switches between AnimePngTuberStage and Live2D Cubism 4 presets (Hiyori, Haru, Mao) via live2d-preset-select and preserves live2dModelUrl on JSON import (Red-Team B3 & M3)', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    expect(useAshyStore.getState().live2dPresetId).toBe('hiyori')
    expect(useAshyStore.getState().live2dModelUrl).toBe('/live2d/models/hiyori/Hiyori.model3.json')

    await act(async () => {
      root!.render(<App />)
    })

    // In default tachie mode, renders ashy-pngtuber-stage with zero geometric SVG ellipses
    expect(getByTestId('ashy-pngtuber-stage')).toBeTruthy()
    expect(container?.querySelector('[data-testid="ashy-tachie-svg"]')).toBeNull()

    await act(async () => {
      clickElement(getByTestId('tab-personality'))
    })

    const presetSelect = getByTestId<HTMLSelectElement>('live2d-preset-select')
    expect(presetSelect.value).toBe('hiyori')

    // Switch to Mao Pro (Cubism 4) via selector
    await act(async () => {
      setNativeInputValue(presetSelect, 'mao')
    })

    expect(useAshyStore.getState().stageMode).toBe('live2d')
    expect(useAshyStore.getState().live2dPresetId).toBe('mao')
    expect(useAshyStore.getState().live2dModelUrl).toBe('/live2d/models/mao/Mao.model3.json')
    expect(getByTestId('live2d-webgl-stage').getAttribute('data-live2d-model-url')).toBe(
      '/live2d/models/mao/Mao.model3.json',
    )

    // Red-Team M3: importing raw JSON text updates live2dModelControls while keeping live2dModelUrl intact
    await act(async () => {
      useAshyStore.getState().importLive2DModelJson(
        JSON.stringify({
          Version: 3,
          FileReferences: {
            Expressions: [{ Name: 'exp_01', File: 'expressions/exp_01.exp3.json' }],
            Motions: { Idle: [{ File: 'motions/mtn_01.motion3.json' }] },
          },
        }),
      )
    })
    expect(useAshyStore.getState().live2dModelUrl).toBe('/live2d/models/mao/Mao.model3.json')
  })
})
