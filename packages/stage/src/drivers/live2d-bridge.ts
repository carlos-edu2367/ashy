import type {
  AshyEmotion,
  AshyEyeLayerState,
  AshyMotionPreset,
  AshyVisemeKey,
  PngTuberSpriteStateKey,
} from '@ashy/shared'
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
