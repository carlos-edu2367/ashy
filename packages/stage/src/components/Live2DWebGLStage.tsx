import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AshyEmotion, AshyMotionPreset } from '@ashy/shared'
import {
  applyLive2DExpressionAndMotion,
  applyLive2DParametersToCoreModel,
  hasWebGLSupport,
  resolveLive2DExpressionAndMotion,
  smoothLive2DParameterMap,
  type CubismCoreModelLike,
} from '../drivers/live2d-bridge'
import type { Live2DModelControls } from '../drivers/live2d-inspector'
import type { Live2DParameterMap } from '../drivers/tachie-compositor'

export type Live2DStageStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface Live2DWebGLStageProps {
  modelUrl: string
  params: Live2DParameterMap
  emotion?: AshyEmotion | string
  motionPreset?: AshyMotionPreset | string
  controls?: Live2DModelControls
  onCanvasReady?: (canvas: HTMLCanvasElement | null) => void
  width?: number
  height?: number
}

interface Live2DInternalModelLike {
  width?: number
  height?: number
  originalWidth?: number
  originalHeight?: number
  coreModel?: CubismCoreModelLike
  focusController?: {
    focus: (x: number, y: number, instant?: boolean) => void
  }
  on: (event: string, fn: () => void) => void
  off: (event: string, fn: () => void) => void
}

interface Live2DModelInstanceLike {
  internalModel: Live2DInternalModelLike
  anchor: { set: (x: number, y?: number) => void }
  scale: { set: (x: number, y?: number) => void }
  position: { set: (x: number, y?: number) => void }
  expression?: (id?: string | number) => Promise<unknown> | unknown
  motion?: (group: string, index?: number, priority?: number) => Promise<unknown> | unknown
  destroy: (options?: { children?: boolean }) => void
}

interface CubismShaderWebGLInstanceLike {
  gl?: object | null
  _shaderSets?: unknown[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setGl?(gl: any): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setupShaderProgram?(renderer: any, ...rest: unknown[]): unknown
}

interface CubismShaderWebGLConstructorLike {
  prototype?: CubismShaderWebGLInstanceLike & {
    __ashyMultiContextPatched?: boolean
  }
}

const shaderSetsByGlContext = new WeakMap<object, unknown[]>()

/**
 * Cubism 4 Web SDK's `CubismShader_WebGL` is a process-wide singleton holding a single
 * `this.gl` and `this._shaderSets` array. When multiple Live2D canvases exist simultaneously
 * or when a tab switch creates a new WebGLRenderingContext, `CubismShader_WebGL` otherwise
 * attempts `gl.useProgram` with WebGLProgram objects compiled for a different WebGL context,
 * resulting in `WebGL: INVALID_OPERATION: drawElements: no valid shader program in use`.
 *
 * This patch isolates `_shaderSets` and `this.gl` per `WebGLRenderingContext` via a WeakMap.
 */
export function ensureCubismMultiContextShaderPatch(cubismModule: {
  CubismShader_WebGL?: CubismShaderWebGLConstructorLike
} | null | undefined): void {
  const proto = cubismModule?.CubismShader_WebGL?.prototype
  if (!proto || proto.__ashyMultiContextPatched) {
    return
  }

  const origSetGl = proto.setGl
  const origSetupShaderProgram = proto.setupShaderProgram

  if (typeof origSetGl === 'function') {
    proto.setGl = function patchedSetGl(this: CubismShaderWebGLInstanceLike, nextGl: object | null) {
      if (
        this.gl &&
        typeof this.gl === 'object' &&
        Array.isArray(this._shaderSets) &&
        this._shaderSets.length > 0
      ) {
        shaderSetsByGlContext.set(this.gl, this._shaderSets)
      }
      origSetGl.call(this, nextGl)
      if (nextGl && typeof nextGl === 'object') {
        const existing = shaderSetsByGlContext.get(nextGl)
        this._shaderSets = Array.isArray(existing) ? existing : []
      }
    }
  }

  if (typeof origSetupShaderProgram === 'function') {
    proto.setupShaderProgram = function patchedSetupShaderProgram(
      this: CubismShaderWebGLInstanceLike,
      renderer: { gl?: object | null } | null | undefined,
      ...rest: unknown[]
    ) {
      const targetGl = renderer?.gl ?? this.gl ?? null
      if (targetGl && typeof targetGl === 'object') {
        if (
          this.gl &&
          this.gl !== targetGl &&
          typeof this.gl === 'object' &&
          Array.isArray(this._shaderSets) &&
          this._shaderSets.length > 0
        ) {
          shaderSetsByGlContext.set(this.gl, this._shaderSets)
        }
        this.gl = targetGl
        const cached = shaderSetsByGlContext.get(targetGl)
        if (Array.isArray(cached) && cached.length > 0) {
          this._shaderSets = cached
        } else if (!Array.isArray(this._shaderSets) || this._shaderSets.length > 0) {
          this._shaderSets = []
        }
      }

      const result = origSetupShaderProgram.call(this, renderer, ...rest)

      if (
        targetGl &&
        typeof targetGl === 'object' &&
        Array.isArray(this._shaderSets) &&
        this._shaderSets.length > 0
      ) {
        shaderSetsByGlContext.set(targetGl, this._shaderSets)
      }

      return result
    }
  }

  Object.defineProperty(proto, '__ashyMultiContextPatched', {
    value: true,
    configurable: true,
    enumerable: false,
    writable: false,
  })
}

export function Live2DWebGLStage({
  modelUrl,
  params,
  emotion = 'neutral',
  motionPreset = 'idle',
  controls,
  onCanvasReady,
  width = 380,
  height = 460,
}: Live2DWebGLStageProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const modelRef = useRef<Live2DModelInstanceLike | null>(null)
  const latestParamsRef = useRef<Live2DParameterMap>(params)
  latestParamsRef.current = params
  const smoothedParamsRef = useRef<Live2DParameterMap>({ ...params })
  const lastUpdateMsRef = useRef<number>(
    typeof performance !== 'undefined' ? performance.now() : 0,
  )

  const [status, setStatus] = useState<Live2DStageStatus>('idle')

  const resolvedControlState = useMemo(
    () =>
      resolveLive2DExpressionAndMotion({
        emotion,
        motionPreset,
        controls,
      }),
    [emotion, motionPreset, controls],
  )

  useEffect(() => {
    onCanvasReady?.(canvasRef.current)
    return () => {
      onCanvasReady?.(null)
    }
  }, [onCanvasReady, modelUrl, width, height])

  useEffect(() => {
    if (!hasWebGLSupport() || !canvasRef.current) {
      return
    }

    let disposed = false
    let cleanupModel: Live2DModelInstanceLike | null = null
    let cleanupApp: { destroy: (removeView?: boolean, stageOptions?: { children?: boolean }) => void } | null = null
    let cleanupUpdateHandler: (() => void) | null = null

    setStatus('loading')

    void (async () => {
      try {
        const PIXI = await import('pixi.js')
        ;(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI
        const cubismModule = await import('pixi-live2d-display-lipsyncpatch/cubism4')
        ensureCubismMultiContextShaderPatch(
          cubismModule as unknown as { CubismShader_WebGL?: CubismShaderWebGLConstructorLike },
        )
        const { Live2DModel } = cubismModule

        if (disposed || !canvasRef.current) {
          return
        }

        const app = new PIXI.Application({
          view: canvasRef.current,
          width,
          height,
          backgroundAlpha: 0,
          antialias: true,
          autoStart: true,
        })
        cleanupApp = app

        const model = (await Live2DModel.from(modelUrl, {
          autoHitTest: false,
          autoFocus: false,
        } as unknown as Parameters<typeof Live2DModel.from>[1])) as unknown as Live2DModelInstanceLike

        if (disposed) {
          model.destroy({ children: true })
          return
        }

        cleanupModel = model
        modelRef.current = model

        const isMao = /\/mao\//i.test(modelUrl) || /mao\.model3\.json/i.test(modelUrl)
        const modelHeight = model.internalModel.originalHeight || model.internalModel.height || 4200
        const fitScale = (height / modelHeight) * (isMao ? 2.15 : 1.78)
        model.anchor.set(0.5, isMao ? 0.31 : 0.17)
        model.scale.set(fitScale)
        model.position.set(width * 0.5, height * (isMao ? 0.56 : 0.45))

        // Prevent Cubism's internal harmonic breath oscillator (±15 deg ParamAngleX) from fighting our smooth spring driver during physics evaluation
        const internalWithBreath = model.internalModel as {
          breath?: { updateParameters?: () => void } | null
        }
        if (internalWithBreath.breath) {
          internalWithBreath.breath = null
        }

        smoothedParamsRef.current = { ...latestParamsRef.current }
        lastUpdateMsRef.current = typeof performance !== 'undefined' ? performance.now() : 0

        const updateHandler = () => {
          const nowMs = typeof performance !== 'undefined' ? performance.now() : lastUpdateMsRef.current + 16.67
          const dtSeconds = Math.min(0.1, Math.max(0.001, (nowMs - lastUpdateMsRef.current) / 1000))
          lastUpdateMsRef.current = nowMs

          const smoothed = smoothLive2DParameterMap(
            smoothedParamsRef.current,
            latestParamsRef.current,
            dtSeconds,
          )
          smoothedParamsRef.current = smoothed

          if (model.internalModel.focusController?.focus) {
            model.internalModel.focusController.focus(
              smoothed.ParamEyeBallX * 0.35,
              -smoothed.ParamEyeBallY * 0.35,
              false,
            )
          }
          applyLive2DParametersToCoreModel(
            (model.internalModel as { coreModel?: CubismCoreModelLike }).coreModel,
            smoothed,
          )
        }
        cleanupUpdateHandler = updateHandler
        model.internalModel.on('beforeModelUpdate', updateHandler)

        app.stage.addChild(model as unknown as import('pixi.js').DisplayObject)
        setStatus('ready')
      } catch {
        if (!disposed) {
          setStatus('error')
        }
      }
    })()

    return () => {
      disposed = true
      modelRef.current = null
      if (cleanupModel && cleanupUpdateHandler) {
        try {
          cleanupModel.internalModel.off('beforeModelUpdate', cleanupUpdateHandler)
        } catch {
          // Ignore teardown errors
        }
      }
      if (cleanupModel) {
        try {
          cleanupModel.destroy({ children: true })
        } catch {
          // Ignore teardown errors
        }
      }
      if (cleanupApp) {
        try {
          cleanupApp.destroy(false, { children: true })
        } catch {
          // Ignore teardown errors
        }
      }
    }
  }, [modelUrl, width, height])

  useEffect(() => {
    if (!modelRef.current) {
      return
    }
    applyLive2DExpressionAndMotion(modelRef.current, {
      emotion,
      motionPreset,
      controls,
    })
  }, [emotion, motionPreset, controls, status])

  return (
    <div
      data-testid="live2d-webgl-stage"
      data-live2d-model-url={modelUrl}
      data-live2d-status={status}
      data-emotion={emotion}
      data-motion-preset={motionPreset}
      data-applied-expression={
        resolvedControlState.appliedExpression !== null
          ? String(resolvedControlState.appliedExpression)
          : ''
      }
      data-applied-motion-group={resolvedControlState.appliedMotionGroup ?? ''}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    >
      <canvas
        key={`${modelUrl}-${width}-${height}`}
        ref={canvasRef}
        data-testid="live2d-webgl-canvas"
        width={width}
        height={height}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
