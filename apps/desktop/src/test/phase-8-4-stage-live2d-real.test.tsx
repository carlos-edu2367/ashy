// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASHY_EMOTIONS } from '@ashy/shared'
import {
  AshyStageCanvas,
  BUILTIN_LIVE2D_MODEL3_MANIFESTS,
  DEFAULT_ASHY_LIVE2D_MODEL3_JSON,
  Live2DWebGLStage,
  applyLive2DExpressionAndMotion,
  computeMotionImpulseOffset,
  ensureCubismMultiContextShaderPatch,
  getBuiltinLive2DModelControls,
  inspectLive2DModelJson,
  smoothLive2DParameterMap,
  type CubismExpressiveModelLike,
} from '@ashy/stage'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount()
    })
    root = null
  }
  if (container) {
    container.remove()
    container = null
  }
  vi.restoreAllMocks()
})

describe('Phase 8.4 — Task 1: @ashy/stage Real Gaze Tracking, Animated motionImpulse & Cubism 4 Expressions/Motions', () => {
  it('1. exports BUILTIN_LIVE2D_MODEL3_MANIFESTS matching real on-disk .model3.json files and resolves getBuiltinLive2DModelControls with safe fallback', () => {
    const hiyoriControls = getBuiltinLive2DModelControls('hiyori')
    expect(hiyoriControls.version).toBe(3)
    expect(hiyoriControls.expressions).toEqual([])
    expect(hiyoriControls.motionGroups).toEqual([
      { name: 'Idle', count: 9 },
      { name: 'TapBody', count: 1 },
    ])
    expect(hiyoriControls.hitAreas).toEqual(['Body'])

    const haruControls = getBuiltinLive2DModelControls('haru')
    expect(haruControls.version).toBe(3)
    expect(haruControls.expressions).toEqual([
      'F01',
      'F02',
      'F03',
      'F04',
      'F05',
      'F06',
      'F07',
      'F08',
    ])
    expect(haruControls.motionGroups).toEqual([
      { name: 'Idle', count: 2 },
      { name: 'TapBody', count: 4 },
    ])
    expect(haruControls.hitAreas).toEqual(['Head', 'Body'])

    const maoControls = getBuiltinLive2DModelControls('mao')
    expect(maoControls.version).toBe(3)
    expect(maoControls.expressions).toEqual([
      'exp_01',
      'exp_02',
      'exp_03',
      'exp_04',
      'exp_05',
      'exp_06',
      'exp_07',
      'exp_08',
    ])
    expect(maoControls.motionGroups).toEqual([
      { name: 'Idle', count: 2 },
      { name: 'TapBody', count: 6 },
    ])
    expect(maoControls.hitAreas).toEqual(['Head', 'Body'])

    // Verify exact parity with on-disk public/live2d/models/*.model3.json
    const publicModelsDir = path.resolve(__dirname, '../../public/live2d/models')
    const diskHiyori = JSON.parse(
      fs.readFileSync(path.join(publicModelsDir, 'hiyori/Hiyori.model3.json'), 'utf8'),
    )
    const diskHaru = JSON.parse(
      fs.readFileSync(path.join(publicModelsDir, 'haru/Haru.model3.json'), 'utf8'),
    )
    const diskMao = JSON.parse(
      fs.readFileSync(path.join(publicModelsDir, 'mao/Mao.model3.json'), 'utf8'),
    )

    expect(inspectLive2DModelJson(BUILTIN_LIVE2D_MODEL3_MANIFESTS.hiyori)).toEqual(
      inspectLive2DModelJson(diskHiyori),
    )
    expect(inspectLive2DModelJson(BUILTIN_LIVE2D_MODEL3_MANIFESTS.haru)).toEqual(
      inspectLive2DModelJson(diskHaru),
    )
    expect(inspectLive2DModelJson(BUILTIN_LIVE2D_MODEL3_MANIFESTS.mao)).toEqual(
      inspectLive2DModelJson(diskMao),
    )

    // Safe fallback for unknown or adversarial preset IDs
    const fallbackControls = getBuiltinLive2DModelControls('unknown-model-id')
    expect(fallbackControls).toEqual(inspectLive2DModelJson(DEFAULT_ASHY_LIVE2D_MODEL3_JSON))
    expect(fallbackControls.expressions).toEqual([...ASHY_EMOTIONS])

    const protoFallback = getBuiltinLive2DModelControls('__proto__')
    expect(protoFallback).toEqual(inspectLive2DModelJson(DEFAULT_ASHY_LIVE2D_MODEL3_JSON))
  })

  it('2. drives Cubism 4 model.expression() and model.motion() via applyLive2DExpressionAndMotion with async/error resilience', async () => {
    // Null/undefined guard
    expect(
      applyLive2DExpressionAndMotion(null, {
        emotion: 'happy',
        motionPreset: 'bounce',
      }),
    ).toEqual({
      appliedExpression: null,
      appliedMotionGroup: null,
      appliedMotionIndex: 0,
    })

    const expressionCalls: Array<string | number | undefined> = []
    const motionCalls: Array<{ group: string; index?: number }> = []

    const mockModel: CubismExpressiveModelLike = {
      expression: vi.fn((id) => {
        expressionCalls.push(id)
        return Promise.resolve(true)
      }),
      motion: vi.fn((group, index) => {
        motionCalls.push({ group, index })
        return Promise.resolve(true)
      }),
    }

    const maoControls = getBuiltinLive2DModelControls('mao')

    // Non-idle motion ('bounce') on Mao -> maps to TapBody group and resolves expression from exp_01..exp_08
    const resMao = applyLive2DExpressionAndMotion(mockModel, {
      emotion: 'excited',
      motionPreset: 'bounce',
      controls: maoControls,
    })
    expect(resMao.appliedExpression).toBe('exp_03')
    expect(resMao.appliedMotionGroup).toBe('TapBody')
    expect(resMao.appliedMotionIndex).toBeGreaterThanOrEqual(0)
    expect(resMao.appliedMotionIndex).toBeLessThan(6)
    expect(expressionCalls).toContain('exp_03')
    expect(motionCalls[0]?.group).toBe('TapBody')

    // Idle motion -> maps to Idle group
    const resIdle = applyLive2DExpressionAndMotion(mockModel, {
      emotion: 'neutral',
      motionPreset: 'idle',
      controls: maoControls,
    })
    expect(resIdle.appliedExpression).toBe('exp_01')
    expect(resIdle.appliedMotionGroup).toBe('Idle')
    expect(resIdle.appliedMotionIndex).toBe(0)

    // Direct group name match (case-insensitive) when controls has custom group
    const customControls = inspectLive2DModelJson(DEFAULT_ASHY_LIVE2D_MODEL3_JSON)
    const resCustom = applyLive2DExpressionAndMotion(mockModel, {
      emotion: 'tease',
      motionPreset: 'tease',
      controls: customControls,
    })
    expect(resCustom.appliedExpression).toBe('tease')
    expect(resCustom.appliedMotionGroup).toBe('Tease')
    expect(resCustom.appliedMotionIndex).toBe(0)

    // Without controls -> uses emotion string directly and maps 'idle' -> 'Idle', other -> 'TapBody'
    const resNoControls = applyLive2DExpressionAndMotion(mockModel, {
      emotion: 'smug',
      motionPreset: 'nod',
    })
    expect(resNoControls.appliedExpression).toBe('smug')
    expect(resNoControls.appliedMotionGroup).toBe('TapBody')

    // Resilience to synchronous throws and rejected promises in model.expression / model.motion
    const throwingModel: CubismExpressiveModelLike = {
      expression: () => Promise.reject(new Error('Cubism expression load failed')),
      motion: () => {
        throw new Error('Cubism motion sync throw')
      },
    }
    expect(() =>
      applyLive2DExpressionAndMotion(throwingModel, {
        emotion: 'chaotic',
        motionPreset: 'laugh',
        controls: maoControls,
      }),
    ).not.toThrow()
  })

  it('3. tracks mousemove in AshyStageCanvas even without onIgnoreMouseChange, updates data-gaze-x/y, clears on mouseleave, and respects explicit gazeTarget prop', () => {
    act(() => {
      root!.render(
        <AshyStageCanvas
          emotion="neutral"
          mode="tachie"
          width={400}
          height={500}
        />,
      )
    })

    const stageEl = container!.querySelector('[data-testid="ashy-stage-canvas"]') as HTMLDivElement
    expect(stageEl).toBeTruthy()
    expect(stageEl.getAttribute('data-gaze-x')).toBe('0.00')
    expect(stageEl.getAttribute('data-gaze-y')).toBe('0.00')

    vi.spyOn(stageEl, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 500,
      right: 400,
      bottom: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    // Move mouse to far right-top (clientX = 380, clientY = 50 -> normX > 0.8, normY < -0.7)
    act(() => {
      stageEl.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: 380,
          clientY: 50,
        }),
      )
    })

    const gazeXAfterMove = Number(stageEl.getAttribute('data-gaze-x'))
    const gazeYAfterMove = Number(stageEl.getAttribute('data-gaze-y'))
    expect(gazeXAfterMove).toBeGreaterThan(0.15)
    expect(gazeYAfterMove).toBeLessThan(-0.15)

    // MouseLeave resets pointerGaze back to center (0.00, 0.00) when no explicit gazeTarget prop is set
    act(() => {
      stageEl.dispatchEvent(
        new MouseEvent('mouseout', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      )
    })
    expect(Number(stageEl.getAttribute('data-gaze-x'))).toBeCloseTo(0, 2)
    expect(Number(stageEl.getAttribute('data-gaze-y'))).toBeCloseTo(0, 2)

    // Explicit gazeTarget prop overrides mouse position
    act(() => {
      root!.render(
        <AshyStageCanvas
          emotion="neutral"
          mode="tachie"
          width={400}
          height={500}
          gazeTarget={{ x: -0.9, y: 0.8 }}
        />,
      )
    })

    expect(Number(stageEl.getAttribute('data-gaze-x'))).toBeLessThan(-0.15)
    expect(Number(stageEl.getAttribute('data-gaze-y'))).toBeGreaterThan(0.15)
  })

  it('4. animates motionImpulse over requestAnimationFrame time (not frozen at 0.12) and resets impulse when motionPreset changes', () => {
    const rafCallbacks: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    act(() => {
      root!.render(
        <AshyStageCanvas
          emotion="excited"
          motionPreset="bounce"
          mode="tachie"
        />,
      )
    })

    const stageEl = container!.querySelector('[data-testid="ashy-stage-canvas"]') as HTMLDivElement
    expect(stageEl).toBeTruthy()
    const initialImpulseY = Number(stageEl.getAttribute('data-motion-impulse-y'))
    expect(Number.isFinite(initialImpulseY)).toBe(true)
    expect(initialImpulseY).toBeLessThan(0) // bounce at t=0.12 has negative y offset

    // Advance multiple RAF frames so motionElapsedSec progresses well past 0.12s (e.g. +1.5s total where envelope decays toward 0)
    let nowMs = performance.now()
    for (let i = 0; i < 20; i++) {
      nowMs += 100
      const cb = rafCallbacks[rafCallbacks.length - 1]
      if (cb) {
        act(() => {
          cb(nowMs)
        })
      }
    }

    const decayedImpulseY = Number(stageEl.getAttribute('data-motion-impulse-y'))
    expect(Math.abs(decayedImpulseY)).toBeLessThan(Math.abs(initialImpulseY) * 0.35)

    // Changing motionPreset to 'nod' resets motionElapsedSec to 0.05 and triggers a fresh impulse!
    act(() => {
      root!.render(
        <AshyStageCanvas
          emotion="happy"
          motionPreset="nod"
          mode="tachie"
        />,
      )
    })

    const expectedFreshNodY = Number(computeMotionImpulseOffset('nod', 0.05).y.toFixed(2))
    const resetImpulseY = Number(stageEl.getAttribute('data-motion-impulse-y'))
    expect(resetImpulseY).toBeCloseTo(expectedFreshNodY, 2)
    expect(Math.abs(resetImpulseY)).toBeGreaterThan(2)
  })

  it('5. exposes deterministic data-applied-expression and data-applied-motion-group on Live2DWebGLStage with preset controls', () => {
    const maoControls = getBuiltinLive2DModelControls('mao')

    act(() => {
      root!.render(
        <Live2DWebGLStage
          modelUrl="/live2d/models/mao/Mao.model3.json"
          params={{
            ParamAngleX: 0,
            ParamAngleY: 0,
            ParamAngleZ: 0,
            ParamEyeLOpen: 1,
            ParamEyeROpen: 1,
            ParamEyeBallX: 0,
            ParamEyeBallY: 0,
            ParamBrowLY: 0,
            ParamBrowRY: 0,
            ParamMouthOpenY: 0,
            ParamMouthForm: 0,
            ParamCheek: 0,
            ParamBreath: 0,
          }}
          emotion="happy"
          motionPreset="bounce"
          controls={maoControls}
        />,
      )
    })

    const webglStage = container!.querySelector('[data-testid="live2d-webgl-stage"]') as HTMLDivElement
    expect(webglStage).toBeTruthy()
    expect(webglStage.getAttribute('data-applied-expression')).toBe('exp_02')
    expect(webglStage.getAttribute('data-applied-motion-group')).toBe('TapBody')
  })

  it('6. isolates CubismShader_WebGL _shaderSets and gl per WebGLRenderingContext across tab switches and concurrent canvases', () => {
    const usedProgramsByGl = new Map<object, string[]>()

    class FakeCubismShaderWebGL {
      gl: { id: string } | null = null
      _shaderSets: Array<{ programOwner: string }> = []
      generateCount = 0

      setGl(gl: { id: string }) {
        this.gl = gl
      }

      generateShaders() {
        this.generateCount += 1
        const owner = this.gl?.id ?? 'unknown'
        this._shaderSets = [{ programOwner: owner }]
      }

      setupShaderProgram(renderer: { gl: { id: string } }) {
        if (this._shaderSets.length === 0) {
          this.generateShaders()
        }
        const activeGl = this.gl!
        const list = usedProgramsByGl.get(activeGl) ?? []
        list.push(this._shaderSets[0]!.programOwner)
        usedProgramsByGl.set(activeGl, list)
      }
    }

    ensureCubismMultiContextShaderPatch({
      CubismShader_WebGL: FakeCubismShaderWebGL,
    })
    // Idempotent second call
    ensureCubismMultiContextShaderPatch({
      CubismShader_WebGL: FakeCubismShaderWebGL,
    })

    const singleton = new FakeCubismShaderWebGL()
    const glA = { id: 'ctx-A' }
    const glB = { id: 'ctx-B' }

    // Canvas A starts up and renders frame 1
    singleton.setGl(glA)
    singleton.setupShaderProgram({ gl: glA })

    // Canvas B starts up (even if updateWebGLContext returns early without clearing _shaderSets)
    singleton.setGl(glB)
    singleton.setupShaderProgram({ gl: glB })

    // Concurrent frame 2: Canvas A and Canvas B both call draw() -> setupShaderProgram(renderer) without calling setGl()
    singleton.setupShaderProgram({ gl: glA })
    singleton.setupShaderProgram({ gl: glB })

    expect(singleton.generateCount).toBe(2)
    expect(usedProgramsByGl.get(glA)).toEqual(['ctx-A', 'ctx-A'])
    expect(usedProgramsByGl.get(glB)).toEqual(['ctx-B', 'ctx-B'])
  })

  it('7. eliminates ParamAngleX mousemove stutter (-10 <-> -16 oscillation) and smooths autonomous idle saccade transitions without frame-to-frame jumps', () => {
    const rafCallbacks: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    act(() => {
      root!.render(
        <AshyStageCanvas
          emotion="neutral"
          mode="live2d"
          live2dModelUrl="/live2d/models/mao/Mao.model3.json"
          width={400}
          height={500}
        />,
      )
    })

    const stageEl = container!.querySelector('[data-testid="ashy-stage-canvas"]') as HTMLDivElement
    expect(stageEl).toBeTruthy()
    vi.spyOn(stageEl, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 500,
      right: 400,
      bottom: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    const readHudAngleX = (): number => {
      const hud = container!.querySelector('[data-testid="live2d-parameter-hud"]')
      const text = hud?.textContent ?? ''
      const match = text.match(/ParamAngleX:\s*(-?\d+(?:\.\d+)?)/)
      return match ? Number(match[1]) : Number.NaN
    }

    // Part A: Autonomous idle movement over 120 frames (2.0 seconds at 60fps) must never jump abruptly between consecutive frames
    let nowMs = performance.now()
    let prevAngleX = readHudAngleX()
    expect(Number.isFinite(prevAngleX)).toBe(true)

    let maxIdleFrameDelta = 0
    for (let i = 0; i < 120; i++) {
      nowMs += 16.67
      const cb = rafCallbacks[rafCallbacks.length - 1]
      if (cb) {
        act(() => {
          cb(nowMs)
        })
      }
      const curAngleX = readHudAngleX()
      const delta = Math.abs(curAngleX - prevAngleX)
      if (delta > maxIdleFrameDelta) {
        maxIdleFrameDelta = delta
      }
      prevAngleX = curAngleX
    }
    // Frame-to-frame head angle change during autonomous idle must be smooth (< 0.8 deg per 16ms frame)
    expect(maxIdleFrameDelta).toBeLessThan(0.8)

    // Part B: Interleaved mousemove + RAF ticks moving left (toward clientX = 40 -> normX = -0.8)
    // Must progress smoothly toward negative ParamAngleX without snapping backwards (-16 -> -10 stutter)
    const angleHistory: number[] = []
    for (let step = 0; step < 15; step++) {
      const clientX = 160 - step * 8 // slowly moving left from 160 to 48
      act(() => {
        stageEl.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            clientX,
            clientY: 250,
          }),
        )
      })
      const angleOnMouseEvent = readHudAngleX()
      angleHistory.push(angleOnMouseEvent)

      nowMs += 16.67
      const cb = rafCallbacks[rafCallbacks.length - 1]
      if (cb) {
        act(() => {
          cb(nowMs)
        })
      }
      const angleOnRafTick = readHudAngleX()
      angleHistory.push(angleOnRafTick)
    }

    // Check that consecutive samples during mouse tracking never jump > 1.5 deg or oscillate backwards by > 0.3 deg
    for (let i = 1; i < angleHistory.length; i++) {
      const diff = angleHistory[i]! - angleHistory[i - 1]!
      // Since we are moving strictly left (negative X), angleX should move smoothly toward negative without positive snapbacks
      expect(diff).toBeLessThanOrEqual(0.15)
      expect(Math.abs(diff)).toBeLessThan(1.5)
    }
    expect(angleHistory[angleHistory.length - 1]!).toBeLessThan(-2.0)

    // Part C: smoothLive2DParameterMap smoothly interpolates step changes
    const prevParams = {
      ParamAngleX: 0,
      ParamAngleY: 0,
      ParamAngleZ: 0,
      ParamEyeLOpen: 1,
      ParamEyeROpen: 1,
      ParamEyeBallX: 0,
      ParamEyeBallY: 0,
      ParamBrowLY: 0,
      ParamBrowRY: 0,
      ParamMouthOpenY: 0,
      ParamMouthForm: 0,
      ParamCheek: 0,
      ParamBreath: 0,
    }
    const targetParams = {
      ...prevParams,
      ParamAngleX: -16,
      ParamEyeBallX: -0.8,
      ParamMouthOpenY: 0.7,
    }
    const smoothedOneFrame = smoothLive2DParameterMap(prevParams, targetParams, 1 / 60)
    expect(smoothedOneFrame.ParamAngleX).toBeLessThan(0)
    expect(smoothedOneFrame.ParamAngleX).toBeGreaterThan(-4) // Smooth step, not instant -16
    expect(smoothedOneFrame.ParamMouthOpenY).toBeGreaterThan(0.2) // Mouth stays responsive for lip-sync
  })
})
