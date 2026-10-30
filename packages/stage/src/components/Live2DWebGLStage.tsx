import React, { useEffect, useRef, useState } from 'react'
import type { AshyEmotion, AshyMotionPreset } from '@ashy/shared'
import {
  applyLive2DParametersToCoreModel,
  hasWebGLSupport,
  type CubismCoreModelLike,
} from '../drivers/live2d-bridge'
import type { Live2DParameterMap } from '../drivers/tachie-compositor'

export type Live2DStageStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface Live2DWebGLStageProps {
  modelUrl: string
  params: Live2DParameterMap
  emotion?: AshyEmotion | string
  motionPreset?: AshyMotionPreset | string
  width?: number
  height?: number
}

interface Live2DInternalModelLike {
  width?: number
  height?: number
  coreModel?: CubismCoreModelLike
  on: (event: string, fn: () => void) => void
  off: (event: string, fn: () => void) => void
}

interface Live2DModelInstanceLike {
  internalModel: Live2DInternalModelLike
  anchor: { set: (x: number, y?: number) => void }
  scale: { set: (x: number, y?: number) => void }
  position: { set: (x: number, y?: number) => void }
  destroy: (options?: { children?: boolean }) => void
}

export function Live2DWebGLStage({
  modelUrl,
  params,
  emotion = 'neutral',
  motionPreset = 'idle',
  width = 380,
  height = 460,
}: Live2DWebGLStageProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const latestParamsRef = useRef<Live2DParameterMap>(params)
  latestParamsRef.current = params

  const [status, setStatus] = useState<Live2DStageStatus>('idle')

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
        const { Live2DModel } = await import('pixi-live2d-display-lipsyncpatch/cubism4')

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
          autoInteract: false,
        })) as unknown as Live2DModelInstanceLike

        if (disposed) {
          model.destroy({ children: true })
          return
        }

        cleanupModel = model

        const fitScale =
          Math.min(
            width / (model.internalModel.width || 1200),
            height / (model.internalModel.height || 1600),
          ) * 1.65
        model.anchor.set(0.5, 0.32)
        model.scale.set(fitScale)
        model.position.set(width * 0.5, height * 0.42)

        const updateHandler = () => {
          applyLive2DParametersToCoreModel(
            (model.internalModel as { coreModel?: CubismCoreModelLike }).coreModel,
            latestParamsRef.current,
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

  return (
    <div
      data-testid="live2d-webgl-stage"
      data-live2d-model-url={modelUrl}
      data-live2d-status={status}
      data-emotion={emotion}
      data-motion-preset={motionPreset}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    >
      <canvas
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
