import {
  ASHY_MOTION_PRESETS,
  type AshyEmotion,
  type AshyEyeLayerState,
  type AshyMotionPreset,
  type AshyVisemeKey,
  type PngTuberSpriteStateKey,
} from '@ashy/shared'
import type { Live2DModelControls } from './live2d-inspector'
import type { Live2DParameterMap } from './tachie-compositor'

export type TachieEyeState = AshyEyeLayerState | 'happy_arc'
export type TachieVisemeKey = AshyVisemeKey
export type EmotionState =
  | AshyEmotion
  | 'joy'
  | 'affectionate'
  | 'playful'
export type StageMotionPreset = AshyMotionPreset

export interface CubismCoreModelLike {
  setParameterValueById?: (id: string, value: number, weight?: number) => void
  addParameterValueById?: (id: string, value: number, weight?: number) => void
}

export interface CubismExpressiveModelLike {
  expression?: (id?: string | number) => Promise<unknown> | unknown
  motion?: (group: string, index?: number, priority?: number) => Promise<unknown> | unknown
}

export function hasWebGLSupport(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false
  }
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
    return false
  }
  if (!(window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) {
    return false
  }
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

export function applyLive2DParametersToCoreModel(
  coreModel: CubismCoreModelLike | null | undefined,
  params: Live2DParameterMap,
): void {
  if (!coreModel || typeof coreModel.setParameterValueById !== 'function') {
    return
  }

  const eyeSmile =
    params.ParamMouthForm > 0.35 ? Number(Math.min(1, params.ParamMouthForm).toFixed(3)) : 0

  coreModel.setParameterValueById('ParamAngleX', params.ParamAngleX, 1)
  coreModel.setParameterValueById('ParamAngleY', params.ParamAngleY, 1)
  coreModel.setParameterValueById('ParamAngleZ', params.ParamAngleZ, 1)
  coreModel.setParameterValueById(
    'ParamBodyAngleX',
    Number((params.ParamAngleX * 0.35).toFixed(3)),
    1,
  )
  coreModel.setParameterValueById(
    'ParamBodyAngleY',
    Number((params.ParamAngleY * 0.25).toFixed(3)),
    1,
  )
  coreModel.setParameterValueById(
    'ParamBodyAngleZ',
    Number((params.ParamAngleZ * 0.35).toFixed(3)),
    1,
  )
  coreModel.setParameterValueById('ParamEyeLOpen', params.ParamEyeLOpen, 1)
  coreModel.setParameterValueById('ParamEyeROpen', params.ParamEyeROpen, 1)
  coreModel.setParameterValueById('ParamEyeLSmile', eyeSmile, 1)
  coreModel.setParameterValueById('ParamEyeRSmile', eyeSmile, 1)
  coreModel.setParameterValueById('ParamEyeBallX', params.ParamEyeBallX, 1)
  coreModel.setParameterValueById('ParamEyeBallY', params.ParamEyeBallY, 1)
  coreModel.setParameterValueById('ParamBrowLY', params.ParamBrowLY, 1)
  coreModel.setParameterValueById('ParamBrowRY', params.ParamBrowRY, 1)
  coreModel.setParameterValueById('ParamMouthOpenY', params.ParamMouthOpenY, 1)
  // Red-Team B4: Required for Mao.model3.json lip-sync!
  coreModel.setParameterValueById('ParamA', params.ParamMouthOpenY, 1)
  coreModel.setParameterValueById('ParamMouthForm', params.ParamMouthForm, 1)
  coreModel.setParameterValueById('ParamCheek', params.ParamCheek ?? 0, 1)
  coreModel.setParameterValueById('ParamBreath', params.ParamBreath, 1)
}

function expSmooth(current: number, target: number, dtSeconds: number, tauSeconds: number): number {
  const safeCur = Number.isFinite(current) ? current : 0
  const safeTgt = Number.isFinite(target) ? target : safeCur
  const safeDt = Number.isFinite(dtSeconds) ? Math.max(0, Math.min(0.1, dtSeconds)) : 1 / 60
  if (tauSeconds <= 0 || safeDt <= 0) {
    return safeTgt
  }
  const alpha = 1 - Math.exp(-safeDt / tauSeconds)
  return safeCur + (safeTgt - safeCur) * alpha
}

/**
 * Frame-rate-independent temporal smoother for Live2D parameters.
 * Eliminates step discontinuities on head/body angles and gaze while keeping blinks and lip-sync crisp.
 */
export function smoothLive2DParameterMap(
  current: Live2DParameterMap,
  target: Live2DParameterMap,
  dtSeconds: number,
): Live2DParameterMap {
  return {
    ParamAngleX: Number(expSmooth(current.ParamAngleX, target.ParamAngleX, dtSeconds, 0.14).toFixed(3)),
    ParamAngleY: Number(expSmooth(current.ParamAngleY, target.ParamAngleY, dtSeconds, 0.14).toFixed(3)),
    ParamAngleZ: Number(expSmooth(current.ParamAngleZ, target.ParamAngleZ, dtSeconds, 0.16).toFixed(3)),
    ParamEyeLOpen: Number(expSmooth(current.ParamEyeLOpen, target.ParamEyeLOpen, dtSeconds, 0.022).toFixed(3)),
    ParamEyeROpen: Number(expSmooth(current.ParamEyeROpen, target.ParamEyeROpen, dtSeconds, 0.022).toFixed(3)),
    ParamEyeBallX: Number(expSmooth(current.ParamEyeBallX, target.ParamEyeBallX, dtSeconds, 0.065).toFixed(3)),
    ParamEyeBallY: Number(expSmooth(current.ParamEyeBallY, target.ParamEyeBallY, dtSeconds, 0.065).toFixed(3)),
    ParamBrowLY: Number(expSmooth(current.ParamBrowLY, target.ParamBrowLY, dtSeconds, 0.09).toFixed(3)),
    ParamBrowRY: Number(expSmooth(current.ParamBrowRY, target.ParamBrowRY, dtSeconds, 0.09).toFixed(3)),
    ParamMouthOpenY: Number(expSmooth(current.ParamMouthOpenY, target.ParamMouthOpenY, dtSeconds, 0.028).toFixed(3)),
    ParamMouthForm: Number(expSmooth(current.ParamMouthForm, target.ParamMouthForm, dtSeconds, 0.08).toFixed(3)),
    ParamCheek: Number(expSmooth(current.ParamCheek, target.ParamCheek, dtSeconds, 0.12).toFixed(3)),
    ParamBreath: Number(expSmooth(current.ParamBreath, target.ParamBreath, dtSeconds, 0.12).toFixed(3)),
  }
}

export function resolvePngTuberSpriteState(input: {
  eyeState: TachieEyeState
  activeViseme: TachieVisemeKey
  emotion: EmotionState
  isSpeaking: boolean
}): PngTuberSpriteStateKey {
  if (input.emotion === 'concerned') {
    return 'concerned'
  }

  const isMouthOpen = input.isSpeaking && input.activeViseme !== 'closed'
  const isEyesClosed = input.eyeState === 'closed' || input.eyeState === 'happy_arc'

  if (isEyesClosed) {
    return isMouthOpen ? 'eyes_closed_mouth_open' : 'eyes_closed_mouth_closed'
  }

  if (isMouthOpen) {
    if (
      input.activeViseme === 'E' ||
      input.activeViseme === 'I' ||
      input.emotion === 'happy' ||
      input.emotion === 'joy' ||
      input.emotion === 'affectionate' ||
      input.emotion === 'playful' ||
      input.emotion === 'excited'
    ) {
      return 'eyes_open_mouth_smile'
    }
    return 'eyes_open_mouth_open'
  }

  if (
    input.emotion === 'happy' ||
    input.emotion === 'joy' ||
    input.emotion === 'affectionate' ||
    input.emotion === 'excited'
  ) {
    return 'eyes_open_mouth_smile'
  }

  return 'eyes_open_mouth_closed'
}

export const PNGTUBER_SPRITE_PATHS: Readonly<Record<PngTuberSpriteStateKey, string>> =
  Object.freeze({
    eyes_open_mouth_closed:
      '/assets/default-avatar/sprites/ashy-eyes-open-mouth-closed.png',
    eyes_open_mouth_open:
      '/assets/default-avatar/sprites/ashy-eyes-open-mouth-open.png',
    eyes_open_mouth_smile:
      '/assets/default-avatar/sprites/ashy-eyes-open-mouth-smile.png',
    eyes_closed_mouth_closed:
      '/assets/default-avatar/sprites/ashy-eyes-closed-mouth-closed.png',
    eyes_closed_mouth_open:
      '/assets/default-avatar/sprites/ashy-eyes-closed-mouth-open.png',
    concerned: '/assets/default-avatar/sprites/ashy-concerned.png',
  })

export interface PngTuberBounceTransform {
  scaleX: number
  scaleY: number
  translateX: number
  translateY: number
  rotateDeg: number
  cssTransform: string
}

export function computePngTuberBounceTransform(input: {
  mouthOpen: number
  isSpeaking: boolean
  breathValue: number
  headTx: number
  headTy: number
  headRotDeg: number
  motionPreset: StageMotionPreset
}): PngTuberBounceTransform {
  const safeMouthOpen = Number.isFinite(input.mouthOpen) ? input.mouthOpen : 0
  const safeBreath = Number.isFinite(input.breathValue) ? input.breathValue : 0
  const safeHeadTx = Number.isFinite(input.headTx) ? input.headTx : 0
  const safeHeadTy = Number.isFinite(input.headTy) ? input.headTy : 0
  const safeHeadRot = Number.isFinite(input.headRotDeg) ? input.headRotDeg : 0

  const vocalEnergy = input.isSpeaking ? Math.min(1, Math.max(0, safeMouthOpen)) : 0
  const scaleX = Number((1.03 - vocalEnergy * 0.022).toFixed(4))
  const scaleY = Number((1.03 + vocalEnergy * 0.034 + safeBreath * 0.008).toFixed(4))
  const translateY = Number((safeHeadTy * 0.55 - vocalEnergy * 8.5 - safeBreath * 3.5).toFixed(2))
  const translateX = Number((safeHeadTx * 0.55).toFixed(2))
  const rotateDeg = Number((safeHeadRot * 0.45).toFixed(2))
  const cssTransform = `translate3d(${translateX}px, ${translateY}px, 0) rotate(${rotateDeg}deg) scale(${scaleX}, ${scaleY})`

  return {
    scaleX,
    scaleY,
    translateX,
    translateY,
    rotateDeg,
    cssTransform,
  }
}

export function resolveEmotionToLive2DExpressionIndex(
  emotion: EmotionState,
  expressions: readonly string[],
): number {
  if (!Array.isArray(expressions) || expressions.length === 0) {
    return -1
  }
  const exactIdx = expressions.findIndex(
    (name) => name.toLowerCase() === String(emotion).toLowerCase(),
  )
  if (exactIdx !== -1) {
    return exactIdx
  }
  const emotionOrder: readonly EmotionState[] = [
    'neutral',
    'happy',
    'excited',
    'smug',
    'tease',
    'chaotic',
    'curious',
    'think',
    'surprised',
    'awkward',
    'concerned',
    'sad',
    'angry',
  ]
  const fallbackPos = Math.max(0, emotionOrder.indexOf(emotion))
  return fallbackPos % expressions.length
}

export function resolveLive2DExpressionAndMotion(options: {
  emotion: EmotionState | string
  motionPreset?: StageMotionPreset | string
  controls?: Live2DModelControls
}): {
  appliedExpression: string | number | null
  appliedMotionGroup: string | null
  appliedMotionIndex: number
} {
  let appliedExpression: string | number | null = null
  if (options.controls?.expressions?.length) {
    const idx = resolveEmotionToLive2DExpressionIndex(
      options.emotion as EmotionState,
      options.controls.expressions,
    )
    if (idx >= 0) {
      appliedExpression = options.controls.expressions[idx] ?? null
    }
  } else {
    const trimmed = String(options.emotion ?? '').trim()
    if (trimmed.length > 0) {
      appliedExpression = trimmed
    }
  }

  const presetRaw = String(options.motionPreset ?? 'idle').trim() || 'idle'
  const presetLower = presetRaw.toLowerCase()
  const presetIdx = Math.max(0, ASHY_MOTION_PRESETS.indexOf(presetLower as AshyMotionPreset))

  let appliedMotionGroup: string | null = null
  let appliedMotionIndex = 0

  if (options.controls?.motionGroups?.length) {
    const groups = options.controls.motionGroups
    let matchedGroup = groups.find((g) => g.name.toLowerCase() === presetLower)
    if (!matchedGroup) {
      if (presetLower !== 'idle') {
        matchedGroup =
          groups.find((g) => g.name.toLowerCase() === 'tapbody') ?? groups[0]
      } else {
        matchedGroup =
          groups.find((g) => g.name.toLowerCase() === 'idle') ?? groups[0]
      }
    }
    if (matchedGroup) {
      appliedMotionGroup = matchedGroup.name
      appliedMotionIndex = matchedGroup.count > 0 ? presetIdx % matchedGroup.count : 0
    }
  } else {
    appliedMotionGroup = presetLower === 'idle' ? 'Idle' : 'TapBody'
    appliedMotionIndex = 0
  }

  return {
    appliedExpression,
    appliedMotionGroup,
    appliedMotionIndex,
  }
}

export function applyLive2DExpressionAndMotion(
  model: CubismExpressiveModelLike | null | undefined,
  options: {
    emotion: EmotionState | string
    motionPreset?: StageMotionPreset | string
    controls?: Live2DModelControls
  },
): {
  appliedExpression: string | number | null
  appliedMotionGroup: string | null
  appliedMotionIndex: number
} {
  if (!model) {
    return {
      appliedExpression: null,
      appliedMotionGroup: null,
      appliedMotionIndex: 0,
    }
  }

  const resolved = resolveLive2DExpressionAndMotion(options)
  let appliedExpression: string | number | null = null
  let appliedMotionGroup: string | null = null
  let appliedMotionIndex = 0

  if (typeof model.expression === 'function' && resolved.appliedExpression !== null) {
    appliedExpression = resolved.appliedExpression
    try {
      void Promise.resolve(model.expression(appliedExpression)).catch(() => {})
    } catch {
      // Ignore synchronous Cubism expression throws
    }
  }

  if (typeof model.motion === 'function' && resolved.appliedMotionGroup !== null) {
    appliedMotionGroup = resolved.appliedMotionGroup
    appliedMotionIndex = resolved.appliedMotionIndex
    try {
      void Promise.resolve(model.motion(appliedMotionGroup, appliedMotionIndex)).catch(() => {})
    } catch {
      // Ignore synchronous Cubism motion throws
    }
  }

  return {
    appliedExpression,
    appliedMotionGroup,
    appliedMotionIndex,
  }
}
