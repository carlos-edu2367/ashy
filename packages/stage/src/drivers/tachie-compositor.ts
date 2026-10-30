import type { ComputedStageFrameState } from '../components/AshyStageCanvas'
import {
  SILHOUETTE_MASK_HEIGHT,
  SILHOUETTE_MASK_WIDTH,
  buildAvatarSilhouetteMask,
} from './hit-test-cpu'
import type { ResolvedTachieLayerState } from './tachie-manifest'

export interface DynamicSilhouetteParams {
  headTx?: number
  headTy?: number
  viewportWidth?: number
  viewportHeight?: number
  scale?: number
}

export interface Live2DParameterMap {
  ParamAngleX: number
  ParamAngleY: number
  ParamAngleZ: number
  ParamEyeLOpen: number
  ParamEyeROpen: number
  ParamEyeBallX: number
  ParamEyeBallY: number
  ParamBrowLY: number
  ParamBrowRY: number
  ParamMouthOpenY: number
  ParamMouthForm: number
  ParamCheek: number
  ParamBreath: number
}

/**
 * Downsamples an RGBA pixel buffer into a 128x72 CPU silhouette alpha mask for O(1) hit-testing.
 */
export function extractCanvasSilhouetteMask128x72(
  rgbaData: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(SILHOUETTE_MASK_WIDTH * SILHOUETTE_MASK_HEIGHT)
  if (
    !rgbaData ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    rgbaData.length < width * height * 4
  ) {
    return mask
  }

  for (let row = 0; row < SILHOUETTE_MASK_HEIGHT; row++) {
    const srcY = Math.min(
      height - 1,
      Math.max(0, Math.floor(((row + 0.5) / SILHOUETTE_MASK_HEIGHT) * height)),
    )
    for (let col = 0; col < SILHOUETTE_MASK_WIDTH; col++) {
      const srcX = Math.min(
        width - 1,
        Math.max(0, Math.floor(((col + 0.5) / SILHOUETTE_MASK_WIDTH) * width)),
      )
      const alpha = rgbaData[(srcY * width + srcX) * 4 + 3] ?? 0
      mask[row * SILHOUETTE_MASK_WIDTH + col] = alpha
    }
  }

  return mask
}

/**
 * Builds a dynamic 128x72 silhouette mask shifted by Ashy's current head/torso spring offset.
 */
export function buildDynamicAvatarSilhouetteMask(
  params: DynamicSilhouetteParams = {},
): Uint8Array {
  const vw =
    Number.isFinite(params.viewportWidth) && params.viewportWidth! > 0
      ? params.viewportWidth!
      : 380
  const vh =
    Number.isFinite(params.viewportHeight) && params.viewportHeight! > 0
      ? params.viewportHeight!
      : 460
  const tx = Number.isFinite(params.headTx) ? params.headTx! : 0
  const ty = Number.isFinite(params.headTy) ? params.headTy! : 0
  const scale =
    Number.isFinite(params.scale) && params.scale! > 0 ? params.scale! : 1

  const centerX = Math.min(0.85, Math.max(0.15, 0.5 + (tx / vw) * 0.5))
  const centerY = Math.min(0.85, Math.max(0.2, 0.58 + (ty / vh) * 0.5))

  return buildAvatarSilhouetteMask({
    centerX,
    centerY,
    scale,
  })
}

/**
 * Computes Cubism 4 Live2D parameter bindings from the current stage frame state.
 */
export function computeLive2DParameterMap(
  frame: ComputedStageFrameState,
): Live2DParameterMap {
  const { pose, eyeFocus, headFocus, breathValue, springOffset } = frame
  return {
    ParamAngleX: Number.isFinite(headFocus.x)
      ? Math.max(-30, Math.min(30, headFocus.x * 25 + springOffset.x * 0.6))
      : 0,
    ParamAngleY: Number.isFinite(headFocus.y)
      ? Math.max(-30, Math.min(30, -headFocus.y * 20 - springOffset.y * 0.5))
      : 0,
    ParamAngleZ: Number.isFinite(headFocus.x)
      ? Math.max(-20, Math.min(20, headFocus.x * 8))
      : 0,
    ParamEyeLOpen: Number.isFinite(pose.eyeOpenL) ? pose.eyeOpenL : 0.85,
    ParamEyeROpen: Number.isFinite(pose.eyeOpenR) ? pose.eyeOpenR : 0.85,
    ParamEyeBallX: Number.isFinite(eyeFocus.x) ? eyeFocus.x : 0,
    ParamEyeBallY: Number.isFinite(eyeFocus.y) ? -eyeFocus.y : 0,
    ParamBrowLY: Number.isFinite(pose.browLY) ? pose.browLY : 0,
    ParamBrowRY: Number.isFinite(pose.browRY) ? pose.browRY : 0,
    ParamMouthOpenY: Number.isFinite(pose.mouthOpen) ? pose.mouthOpen : 0,
    ParamMouthForm: Number.isFinite(pose.mouthForm) ? pose.mouthForm : 0,
    ParamCheek: Number.isFinite(pose.cheekBlush) ? pose.cheekBlush : 0,
    ParamBreath: Number.isFinite(breathValue) ? breathValue : 0,
  }
}

/**
 * Rasterizes only the invisible anatomical silhouette mask onto an HTML5 Canvas 2D context
 * for O(1) 4 Hz 128x72 CPU click-through hit-testing (zero facial eyes/brows/mouth drawing — Red-Team B3).
 */
export function renderTachieStageToCanvas(
  ctx: CanvasRenderingContext2D,
  frame: ComputedStageFrameState,
  _layers: ResolvedTachieLayerState,
  width: number,
  height: number,
): void {
  if (!ctx || typeof ctx.clearRect !== 'function') return

  try {
    ctx.clearRect(0, 0, width, height)
    const scaleX = width / 380
    const scaleY = height / 460
    const { headFocus, breathValue, springOffset } = frame
    const headTx = springOffset.x + headFocus.x * 10
    const headTy = springOffset.y + headFocus.y * 8 - breathValue * 4

    ctx.save()
    ctx.scale(scaleX, scaleY)

    // 1. Torso / shoulders anatomical silhouette mask
    ctx.fillStyle = 'rgba(20, 18, 29, 1)'
    ctx.beginPath()
    if (typeof ctx.moveTo === 'function' && typeof ctx.bezierCurveTo === 'function') {
      ctx.moveTo(95, 455)
      ctx.bezierCurveTo(102, 330, 145, 295, 190, 295 - breathValue * 4.5)
      ctx.bezierCurveTo(235, 295, 278, 330, 285, 455)
      ctx.closePath?.()
    } else {
      ctx.ellipse(190, 410 - breathValue * 4.5, 92, 85, 0, Math.PI, Math.PI * 2)
    }
    ctx.fill()

    // 2. Head / hair anatomical silhouette ellipse (zero facial features)
    ctx.beginPath()
    ctx.ellipse(190 + headTx, 235 + headTy, 92, 108, 0, 0, Math.PI * 2)
    ctx.fill()

    ctx.restore()
  } catch {
    // Ignore partial canvas mock errors in headless test environments
  }
}
