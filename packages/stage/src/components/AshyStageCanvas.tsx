import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ASHY_EMOTIONS,
  type AshyEmotion,
  type AshyMotionPreset,
  type StageAvatarMode,
} from '@ashy/shared'
import {
  type FacialExpressionPose,
  type VowelKey,
  type VowelWeights,
  createDynamicVisemeBlender,
  createWinnerRunnerUpVowelDriver,
} from '../drivers/lip-sync-driver'
import {
  type Point2D,
  BLINK_THRESHOLD,
  createAutoBlinkDriver,
  createEyeSaccadeDriver,
  createRetinalLightSquint,
  createSubsteppedSpring2D,
  sampleBreathCycle,
} from '../drivers/procedural-life'
import {
  buildAvatarSilhouetteMask,
  shouldIgnoreMouseEvent,
  type UiIslandRect,
} from '../drivers/hit-test-cpu'
import {
  inspectLive2DModelJson,
  type Live2DModelControls,
} from '../drivers/live2d-inspector'
import {
  DEFAULT_ASHY_LIVE2D_MODEL3_JSON,
  computeMotionImpulseOffset,
  resolveTachieActiveLayers,
} from '../drivers/tachie-manifest'
import {
  buildDynamicAvatarSilhouetteMask,
  computeLive2DParameterMap,
  extractCanvasSilhouetteMask128x72,
  renderTachieStageToCanvas,
} from '../drivers/tachie-compositor'
import {
  PNGTUBER_SPRITE_PATHS,
  computePngTuberBounceTransform,
  resolvePngTuberSpriteState,
} from '../drivers/live2d-bridge'
import { Live2DWebGLStage } from './Live2DWebGLStage'

export const EMOTION_FACIAL_PRESETS: Readonly<Record<AshyEmotion, Readonly<FacialExpressionPose>>> =
  Object.freeze({
    neutral: Object.freeze({
      eyeOpenL: 0.88,
      eyeOpenR: 0.88,
      browLY: 0.0,
      browRY: 0.0,
      browAngle: 0.0,
      mouthOpen: 0.04,
      mouthForm: 0.1,
      mouthSmile: 0.28,
      cheekBlush: 0.12,
      pupilScale: 1.0,
    }),
    happy: Object.freeze({
      eyeOpenL: 0.14, // <= 0.15 triggers anti-loop blink guard (happy closed-eye smile)
      eyeOpenR: 0.14,
      browLY: 0.25,
      browRY: 0.25,
      browAngle: 0.12,
      mouthOpen: 0.28,
      mouthForm: 0.55,
      mouthSmile: 0.92,
      cheekBlush: 0.55,
      pupilScale: 1.08,
    }),
    excited: Object.freeze({
      eyeOpenL: 1.05,
      eyeOpenR: 1.05,
      browLY: 0.38,
      browRY: 0.38,
      browAngle: 0.18,
      mouthOpen: 0.62,
      mouthForm: 0.65,
      mouthSmile: 0.98,
      cheekBlush: 0.68,
      pupilScale: 1.18,
    }),
    smug: Object.freeze({
      eyeOpenL: 0.42,
      eyeOpenR: 0.34,
      browLY: 0.32,
      browRY: -0.14,
      browAngle: -0.22,
      mouthOpen: 0.08,
      mouthForm: 0.42,
      mouthSmile: 0.76,
      cheekBlush: 0.25,
      pupilScale: 0.96,
    }),
    tease: Object.freeze({
      eyeOpenL: 0.78,
      eyeOpenR: 0.12, // playful wink on right eye (<= 0.15 guard!)
      browLY: 0.3,
      browRY: -0.1,
      browAngle: 0.15,
      mouthOpen: 0.35,
      mouthForm: 0.48,
      mouthSmile: 0.84,
      cheekBlush: 0.48,
      pupilScale: 1.05,
    }),
    chaotic: Object.freeze({
      eyeOpenL: 1.08,
      eyeOpenR: 0.82,
      browLY: 0.42,
      browRY: -0.25,
      browAngle: -0.35,
      mouthOpen: 0.58,
      mouthForm: 0.7,
      mouthSmile: 0.9,
      cheekBlush: 0.42,
      pupilScale: 0.82,
    }),
    curious: Object.freeze({
      eyeOpenL: 0.98,
      eyeOpenR: 1.02,
      browLY: 0.34,
      browRY: 0.12,
      browAngle: 0.2,
      mouthOpen: 0.18,
      mouthForm: -0.2,
      mouthSmile: 0.38,
      cheekBlush: 0.2,
      pupilScale: 1.12,
    }),
    think: Object.freeze({
      eyeOpenL: 0.68,
      eyeOpenR: 0.74,
      browLY: -0.18,
      browRY: 0.26,
      browAngle: 0.1,
      mouthOpen: 0.04,
      mouthForm: -0.15,
      mouthSmile: 0.14,
      cheekBlush: 0.08,
      pupilScale: 0.98,
    }),
    surprised: Object.freeze({
      eyeOpenL: 1.14,
      eyeOpenR: 1.14,
      browLY: 0.52,
      browRY: 0.52,
      browAngle: 0.28,
      mouthOpen: 0.68,
      mouthForm: -0.65,
      mouthSmile: 0.1,
      cheekBlush: 0.32,
      pupilScale: 0.78,
    }),
    awkward: Object.freeze({
      eyeOpenL: 0.62,
      eyeOpenR: 0.54,
      browLY: 0.18,
      browRY: 0.22,
      browAngle: 0.36,
      mouthOpen: 0.14,
      mouthForm: -0.28,
      mouthSmile: 0.32,
      cheekBlush: 0.52,
      pupilScale: 0.92,
    }),
    concerned: Object.freeze({
      eyeOpenL: 0.84,
      eyeOpenR: 0.84,
      browLY: 0.12,
      browRY: 0.12,
      browAngle: 0.42,
      mouthOpen: 0.12,
      mouthForm: -0.35,
      mouthSmile: 0.06,
      cheekBlush: 0.14,
      pupilScale: 1.04,
    }),
    sad: Object.freeze({
      eyeOpenL: 0.52,
      eyeOpenR: 0.52,
      browLY: -0.12,
      browRY: -0.12,
      browAngle: 0.48,
      mouthOpen: 0.08,
      mouthForm: -0.5,
      mouthSmile: 0.0,
      cheekBlush: 0.18,
      pupilScale: 1.06,
    }),
    angry: Object.freeze({
      eyeOpenL: 0.74,
      eyeOpenR: 0.74,
      browLY: -0.38,
      browRY: -0.38,
      browAngle: -0.46,
      mouthOpen: 0.24,
      mouthForm: -0.42,
      mouthSmile: 0.02,
      cheekBlush: 0.36,
      pupilScale: 0.88,
    }),
  })

function clampUnit(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function interpolateEmotionPose(
  emotion: AshyEmotion,
  intensity = 0.85,
): FacialExpressionPose {
  const safeEmotion: AshyEmotion = ASHY_EMOTIONS.includes(emotion) ? emotion : 'neutral'
  const t = clampUnit(intensity)
  const neutral = EMOTION_FACIAL_PRESETS.neutral
  const target = EMOTION_FACIAL_PRESETS[safeEmotion]

  return {
    eyeOpenL: lerp(neutral.eyeOpenL, target.eyeOpenL, t),
    eyeOpenR: lerp(neutral.eyeOpenR, target.eyeOpenR, t),
    browLY: lerp(neutral.browLY, target.browLY, t),
    browRY: lerp(neutral.browRY, target.browRY, t),
    browAngle: lerp(neutral.browAngle, target.browAngle, t),
    mouthOpen: lerp(neutral.mouthOpen, target.mouthOpen, t),
    mouthForm: lerp(neutral.mouthForm, target.mouthForm, t),
    mouthSmile: lerp(neutral.mouthSmile, target.mouthSmile, t),
    cheekBlush: lerp(neutral.cheekBlush, target.cheekBlush, t),
    pupilScale: lerp(neutral.pupilScale, target.pupilScale, t),
  }
}

export interface ComputeStageFrameInput {
  emotion: AshyEmotion
  emotionIntensity?: number
  isSpeaking?: boolean
  vowels?: VowelWeights
  blinkFactor?: number
  eyeFocus?: Point2D
  headFocus?: Point2D
  breathValue?: number
  squintAmount?: number
  springOffset?: Point2D
}

export interface ComputedStageFrameState {
  emotion: AshyEmotion
  pose: FacialExpressionPose
  vowels: VowelWeights
  effectiveEyeOpenL: number
  effectiveEyeOpenR: number
  eyeFocus: Point2D
  headFocus: Point2D
  breathValue: number
  squintAmount: number
  springOffset: Point2D
}

export function computeStageFrameState(
  input: ComputeStageFrameInput,
): ComputedStageFrameState {
  const basePose = interpolateEmotionPose(input.emotion, input.emotionIntensity ?? 0.85)
  const vowels: VowelWeights = input.vowels ?? { A: 0, E: 0, I: 0, O: 0, U: 0 }
  const blinkFactor = clampUnit(input.blinkFactor ?? 1)
  const squintAmount = clampUnit(input.squintAmount ?? 0)
  const squintFactor = 1 - squintAmount * 0.38

  // Apply multiplicative Auto-Blink with BLINK_THRESHOLD = 0.15 anti-loop guard per eye
  const rawEyeL =
    basePose.eyeOpenL <= BLINK_THRESHOLD ? basePose.eyeOpenL : basePose.eyeOpenL * blinkFactor
  const rawEyeR =
    basePose.eyeOpenR <= BLINK_THRESHOLD ? basePose.eyeOpenR : basePose.eyeOpenR * blinkFactor

  const effectiveEyeOpenL = Math.max(0.05, rawEyeL * squintFactor)
  const effectiveEyeOpenR = Math.max(0.05, rawEyeR * squintFactor)

  let mouthOpen = basePose.mouthOpen
  let mouthForm = basePose.mouthForm
  let mouthSmile = basePose.mouthSmile

  if (input.isSpeaking) {
    mouthOpen = clampUnit(
      vowels.A * 1.0 + vowels.O * 0.85 + vowels.E * 0.55 + vowels.U * 0.45 + vowels.I * 0.25,
    )
    mouthForm = Math.min(
      1,
      Math.max(-1, vowels.I * 0.8 + vowels.E * 0.5 - (vowels.O * 0.8 + vowels.U * 0.9)),
    )
    mouthSmile = clampUnit(basePose.mouthSmile * 0.35 + vowels.I * 0.65 + vowels.E * 0.45)
  }

  return {
    emotion: input.emotion,
    pose: {
      ...basePose,
      eyeOpenL: effectiveEyeOpenL,
      eyeOpenR: effectiveEyeOpenR,
      mouthOpen,
      mouthForm,
      mouthSmile,
    },
    vowels,
    effectiveEyeOpenL,
    effectiveEyeOpenR,
    eyeFocus: input.eyeFocus ?? { x: 0, y: 0 },
    headFocus: input.headFocus ?? { x: 0, y: 0 },
    breathValue: clampUnit(input.breathValue ?? 0),
    squintAmount,
    springOffset: input.springOffset ?? { x: 0, y: 0 },
  }
}

export type AshyPresenceStatus = 'Idle' | 'Listening' | 'Thinking' | 'Speaking'

export interface PresenceBubbleProps {
  text?: string
  emotion: AshyEmotion
  statusLabel?: AshyPresenceStatus | string
  springOffset?: Point2D
}

export function PresenceBubble({
  text,
  emotion,
  statusLabel = 'Idle',
  springOffset = { x: 0, y: 0 },
}: PresenceBubbleProps): React.ReactElement | null {
  if (!text && !statusLabel) return null

  return (
    <div
      data-testid="ashy-presence-bubble"
      data-ui-island="true"
      style={{
        position: 'absolute',
        top: '8px',
        left: '50%',
        transform: `translate3d(calc(-50% + ${springOffset.x.toFixed(2)}px), ${springOffset.y.toFixed(2)}px, 0)`,
        maxWidth: '330px',
        padding: '8px 12px',
        borderRadius: '14px',
        background: 'rgba(18, 19, 28, 0.90)',
        border: '1px solid rgba(244, 114, 182, 0.38)',
        boxShadow: '0 10px 24px rgba(0, 0, 0, 0.42)',
        color: '#f8fafc',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '12px',
        lineHeight: 1.35,
        pointerEvents: 'auto',
        zIndex: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          marginBottom: text ? '4px' : '0',
          fontSize: '11px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: '#f472b6',
        }}
      >
        <span data-testid="ashy-status-pill">{statusLabel}</span>
        <span data-testid="ashy-emotion-pill" style={{ color: '#c084fc' }}>
          {emotion}
        </span>
      </div>
      {text ? (
        <div
          data-testid="ashy-bubble-text"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {text}
        </div>
      ) : null}
    </div>
  )
}

export interface AshyStageCanvasProps {
  emotion?: AshyEmotion
  emotionIntensity?: number
  isSpeaking?: boolean
  rawVowels?: Partial<Record<VowelKey | 'S', number>>
  rawVolume?: number
  ambientLuminance?: number
  gazeTarget?: Point2D | null
  bubbleText?: string
  statusLabel?: AshyPresenceStatus | string
  mode?: StageAvatarMode
  motionPreset?: AshyMotionPreset
  transparentBackground?: boolean
  live2dControls?: Live2DModelControls
  live2dModelUrl?: string
  width?: number
  height?: number
  fullBleed?: boolean
  hideBubble?: boolean
  uiIslandRects?: readonly UiIslandRect[]
  onIgnoreMouseChange?: (shouldIgnore: boolean) => void
}

const DEFAULT_RAW_VOWELS: Readonly<Partial<Record<VowelKey | 'S', number>>> = Object.freeze({
  A: 0,
  E: 0,
  I: 0,
  O: 0,
  U: 0,
})

export function AshyStageCanvas({
  emotion = 'neutral',
  emotionIntensity = 0.85,
  isSpeaking = false,
  rawVowels = DEFAULT_RAW_VOWELS,
  rawVolume = 0,
  ambientLuminance = 0.35,
  gazeTarget = null,
  bubbleText,
  statusLabel = 'Idle',
  mode = 'tachie',
  motionPreset,
  transparentBackground = false,
  live2dControls,
  live2dModelUrl = '/live2d/models/hiyori/Hiyori.model3.json',
  width = 380,
  height = 460,
  fullBleed = false,
  hideBubble = false,
  uiIslandRects,
  onIgnoreMouseChange,
}: AshyStageCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const live2dCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const vowelDriverRef = useRef(createWinnerRunnerUpVowelDriver())
  const visemeBlenderRef = useRef(createDynamicVisemeBlender())
  const blinkDriverRef = useRef(createAutoBlinkDriver())
  const saccadeDriverRef = useRef(
    createEyeSaccadeDriver({
      maxSaccadeAmplitudeX: 0.18,
      maxSaccadeAmplitudeY: 0.1,
      eyeLerpFactor: 0.3,
      headCouplingFactor: 0.5,
    }),
  )
  const squintDriverRef = useRef(createRetinalLightSquint({ initialLuminance: ambientLuminance }))
  const headFocusSpringRef = useRef(
    createSubsteppedSpring2D({ x: 0, y: 0 }, { stiffness: 36, damping: 12 }),
  )
  const eyeFocusSpringRef = useRef(
    createSubsteppedSpring2D({ x: 0, y: 0 }, { stiffness: 56, damping: 15 }),
  )
  const headSpringRef = useRef(
    createSubsteppedSpring2D({ x: 0, y: 0 }, { stiffness: 32, damping: 11.5 }),
  )
  const bubbleSpringRef = useRef(
    createSubsteppedSpring2D({ x: 0, y: 0 }, { stiffness: 28, damping: 10.5 }),
  )
  const silhouetteMaskRef = useRef<Uint8Array>(
    buildAvatarSilhouetteMask({ centerX: 0.5, centerY: 0.58, scale: 1 }),
  )
  const lastIgnoreMouseRef = useRef<boolean | null>(null)
  const pointerGazeRef = useRef<Point2D | null>(null)
  const rafTickCountRef = useRef<number>(0)

  const propGazeX = gazeTarget?.x ?? null
  const propGazeY = gazeTarget?.y ?? null
  const explicitGazeTarget = useMemo<Point2D | null>(
    () => (propGazeX !== null && propGazeY !== null ? { x: propGazeX, y: propGazeY } : null),
    [propGazeX, propGazeY],
  )

  const vowelA = rawVowels?.A ?? 0
  const vowelE = rawVowels?.E ?? 0
  const vowelI = rawVowels?.I ?? 0
  const vowelO = rawVowels?.O ?? 0
  const vowelU = rawVowels?.U ?? 0
  const vowelS = rawVowels?.S ?? 0
  const stableRawVowels = useMemo<Partial<Record<VowelKey | 'S', number>>>(
    () => ({ A: vowelA, E: vowelE, I: vowelI, O: vowelO, U: vowelU, S: vowelS }),
    [vowelA, vowelE, vowelI, vowelO, vowelU, vowelS],
  )

  const latestInputsRef = useRef({
    emotion,
    emotionIntensity,
    isSpeaking,
    stableRawVowels,
    rawVolume,
    ambientLuminance,
    explicitGazeTarget,
    motionPreset,
  })
  latestInputsRef.current = {
    emotion,
    emotionIntensity,
    isSpeaking,
    stableRawVowels,
    rawVolume,
    ambientLuminance,
    explicitGazeTarget,
    motionPreset,
  }

  const [motionElapsedSec, setMotionElapsedSec] = useState<number>(0.12)
  const motionElapsedRef = useRef<number>(0.12)
  const prevMotionKeyRef = useRef<string>(`${emotion}:${motionPreset ?? ''}`)

  useEffect(() => {
    const nextKey = `${emotion}:${motionPreset ?? ''}`
    if (prevMotionKeyRef.current !== nextKey) {
      prevMotionKeyRef.current = nextKey
      motionElapsedRef.current = 0.05
      setMotionElapsedSec(0.05)
    }
  }, [emotion, motionPreset])

  const initialSynchronizedFrame = useMemo(() => {
    const vFrame = vowelDriverRef.current.step({
      rawVowels: stableRawVowels,
      rawVolume: isSpeaking ? rawVolume : 0,
      dtSeconds: 1 / 60,
    })
    const exprPose = interpolateEmotionPose(emotion, emotionIntensity)
    const blended = visemeBlenderRef.current.step({
      isSpeaking,
      dtSeconds: 1 / 60,
      expression: exprPose,
      vowels: vFrame.vowels,
    })
    const blinkL = blinkDriverRef.current.step(1 / 60, blended.eyeOpenL)
    const activeGaze = explicitGazeTarget ?? pointerGazeRef.current
    const saccade = saccadeDriverRef.current.step(1 / 60, activeGaze)
    const squint = squintDriverRef.current.step(ambientLuminance, 1 / 60)
    const breath = sampleBreathCycle(0.18)
    const curSpring = headSpringRef.current.getState()

    return computeStageFrameState({
      emotion,
      emotionIntensity,
      isSpeaking,
      vowels: blended.vowels,
      blinkFactor: blinkL.blinkFactor,
      eyeFocus: saccade.eyeFocus,
      headFocus: saccade.headFocus,
      breathValue: breath,
      squintAmount: squint.squintAmount,
      springOffset: { x: curSpring.x, y: curSpring.y },
    })
  }, [
    emotion,
    emotionIntensity,
    isSpeaking,
    stableRawVowels,
    rawVolume,
    ambientLuminance,
    explicitGazeTarget,
  ])

  const [frame, setFrame] = useState<ComputedStageFrameState>(initialSynchronizedFrame)
  const [bubbleOffset, setBubbleOffset] = useState<Point2D>({ x: 0, y: 0 })

  useEffect(() => {
    setFrame(initialSynchronizedFrame)
  }, [initialSynchronizedFrame])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      return
    }

    let rafId = 0
    let lastTimeMs = performance.now()
    let elapsedSec = 0

    const tick = (nowMs: number) => {
      rafTickCountRef.current += 1
      const dtSeconds = Math.min(0.1, Math.max(0.001, (nowMs - lastTimeMs) / 1000))
      lastTimeMs = nowMs
      elapsedSec += dtSeconds
      motionElapsedRef.current += dtSeconds

      const inputs = latestInputsRef.current
      const activeGaze = inputs.explicitGazeTarget ?? pointerGazeRef.current

      const vFrame = vowelDriverRef.current.step({
        rawVowels: inputs.stableRawVowels,
        rawVolume: inputs.isSpeaking ? inputs.rawVolume : 0,
        dtSeconds,
      })

      const exprPose = interpolateEmotionPose(inputs.emotion, inputs.emotionIntensity)
      const blended = visemeBlenderRef.current.step({
        isSpeaking: inputs.isSpeaking,
        dtSeconds,
        expression: exprPose,
        vowels: vFrame.vowels,
      })

      const blinkState = blinkDriverRef.current.step(dtSeconds, blended.eyeOpenL)
      const saccadeState = saccadeDriverRef.current.step(dtSeconds, activeGaze)
      const squintState = squintDriverRef.current.step(inputs.ambientLuminance, dtSeconds)
      const breathValue = sampleBreathCycle(elapsedSec / 3.8)
      const activeMotion = inputs.motionPreset ?? 'idle'
      const motionImp = computeMotionImpulseOffset(activeMotion, motionElapsedRef.current)
      setMotionElapsedSec(motionElapsedRef.current)

      const headScale = activeGaze ? 1.0 : 0.35
      const smoothedHeadFocus = headFocusSpringRef.current.step(
        {
          x: saccadeState.headFocus.x * headScale,
          y: saccadeState.headFocus.y * headScale,
        },
        dtSeconds,
      )
      const smoothedEyeFocus = eyeFocusSpringRef.current.step(saccadeState.eyeFocus, dtSeconds)

      const springState = headSpringRef.current.step(
        {
          x: smoothedHeadFocus.x * 14 + motionImp.x,
          y: smoothedHeadFocus.y * 10 - breathValue * 4 + motionImp.y,
        },
        dtSeconds,
      )

      const bSpring = bubbleSpringRef.current.step(
        {
          x: smoothedHeadFocus.x * 8,
          y: -breathValue * 3,
        },
        dtSeconds,
      )

      setBubbleOffset({ x: bSpring.x, y: bSpring.y })
      setFrame(
        computeStageFrameState({
          emotion: inputs.emotion,
          emotionIntensity: inputs.emotionIntensity,
          isSpeaking: inputs.isSpeaking,
          vowels: blended.vowels,
          blinkFactor: blinkState.blinkFactor,
          eyeFocus: { x: smoothedEyeFocus.x, y: smoothedEyeFocus.y },
          headFocus: { x: smoothedHeadFocus.x, y: smoothedHeadFocus.y },
          breathValue,
          squintAmount: squintState.squintAmount,
          springOffset: { x: springState.x, y: springState.y },
        }),
      )

      rafId = window.requestAnimationFrame(tick)
    }

    rafId = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [])

  const resolvedLayers = useMemo(
    () => resolveTachieActiveLayers(frame, motionPreset),
    [frame, motionPreset],
  )
  const motionImpulse = useMemo(
    () => computeMotionImpulseOffset(resolvedLayers.motionPreset, motionElapsedSec),
    [resolvedLayers.motionPreset, motionElapsedSec],
  )
  const live2dParams = useMemo(() => computeLive2DParameterMap(frame), [frame])
  const effectiveLive2dControls = useMemo(
    () => live2dControls ?? inspectLive2DModelJson(DEFAULT_ASHY_LIVE2D_MODEL3_JSON),
    [live2dControls],
  )

  const { pose, headFocus, breathValue, springOffset } = frame
  const headTx = springOffset.x + headFocus.x * 10 + motionImpulse.x
  const headTy = springOffset.y + headFocus.y * 8 - breathValue * 4 + motionImpulse.y
  const headRotDeg = headFocus.x * 3.5 + motionImpulse.rotationDeg

  const spriteState = resolvePngTuberSpriteState({
    eyeState: resolvedLayers.eyeState,
    activeViseme: resolvedLayers.activeViseme,
    emotion,
    isSpeaking,
  })
  const bounceTransform = computePngTuberBounceTransform({
    mouthOpen: pose.mouthOpen,
    isSpeaking,
    breathValue,
    headTx,
    headTy,
    headRotDeg,
    motionPreset: resolvedLayers.motionPreset,
  })

  // Render onto <canvas> when 2D context is available (Red-Team M4 jsdom guard)
  useEffect(() => {
    const canvas = mode === 'tachie' ? canvasRef.current : null
    if (!canvas) return
    if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
      return
    }
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx) {
        renderTachieStageToCanvas(ctx, frame, resolvedLayers, width, height)
      }
    } catch {
      // Ignore canvas context errors in headless environments
    }
  }, [mode, frame, resolvedLayers, width, height])

  // Refresh 128x72 silhouette mask at 4 Hz (250ms)
  // IMPORTANT: Never call .getContext('2d') on live2dCanvasRef (WebGL canvas), as HTML5 locks a canvas to a single context type and breaks PIXI WebGL initialization!
  useEffect(() => {
    const refreshSilhouette = () => {
      const canvas = mode === 'tachie' ? canvasRef.current : null
      if (
        canvas &&
        (typeof navigator === 'undefined' || !/jsdom/i.test(navigator.userAgent))
      ) {
        try {
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          if (ctx && typeof ctx.getImageData === 'function') {
            const imgData = ctx.getImageData(0, 0, canvas.width || width, canvas.height || height)
            if (imgData && imgData.data && imgData.data.length > 0) {
              silhouetteMaskRef.current = extractCanvasSilhouetteMask128x72(
                imgData.data,
                canvas.width || width,
                canvas.height || height,
              )
              return
            }
          }
        } catch {
          // Fallback to dynamic pose mask
        }
      }
      silhouetteMaskRef.current = buildDynamicAvatarSilhouetteMask({
        headTx,
        headTy,
        viewportWidth: width,
        viewportHeight: height,
        scale: motionImpulse.scale,
      })
    }

    refreshSilhouette()
    const timer = setInterval(refreshSilhouette, 250)
    return () => {
      clearInterval(timer)
    }
  }, [headTx, headTy, width, height, motionImpulse.scale])

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const vw = rect.width || width
    const vh = rect.height || height
    const clientX = event.clientX - rect.left
    const clientY = event.clientY - rect.top

    const rawNormX = vw > 0 ? (clientX / vw) * 2 - 1 : 0
    const rawNormY = vh > 0 ? (clientY / vh) * 2 - 1 : 0
    if (Number.isFinite(rawNormX) && Number.isFinite(rawNormY)) {
      const normX = Math.max(-1, Math.min(1, rawNormX))
      const normY = Math.max(-1, Math.min(1, rawNormY))
      const nextPointerGaze: Point2D = {
        x: Number(normX.toFixed(3)),
        y: Number(normY.toFixed(3)),
      }
      pointerGazeRef.current = nextPointerGaze
      // Only update frame synchronously when RAF loop hasn't ticked (e.g., synchronous jsdom unit tests)
      if (rafTickCountRef.current === 0) {
        const activeGaze = explicitGazeTarget ?? nextPointerGaze
        const saccade = saccadeDriverRef.current.step(1 / 60, activeGaze)
        setFrame((prev) => ({
          ...prev,
          eyeFocus: saccade.eyeFocus,
          headFocus: saccade.headFocus,
        }))
      }
    }

    if (!onIgnoreMouseChange) return
    const targetEl = event.target as HTMLElement | null
    const isOverUiIsland = Boolean(targetEl?.closest?.('[data-ui-island="true"]'))

    const ignore = shouldIgnoreMouseEvent({
      clientX,
      clientY,
      viewportWidth: vw,
      viewportHeight: vh,
      silhouetteMask: silhouetteMaskRef.current,
      isOverUiIsland,
      uiIslandRects,
    })

    // Red-Team B6 deduplication: only notify when ignore state transitions
    if (ignore !== lastIgnoreMouseRef.current) {
      lastIgnoreMouseRef.current = ignore
      onIgnoreMouseChange(ignore)
    }
  }

  const handleMouseLeave = () => {
    pointerGazeRef.current = null
    if (!explicitGazeTarget && rafTickCountRef.current === 0) {
      saccadeDriverRef.current.reset()
      setFrame((prev) => ({
        ...prev,
        eyeFocus: { x: 0, y: 0 },
        headFocus: { x: 0, y: 0 },
      }))
    }
  }

  return (
    <div
      data-testid="ashy-stage-canvas"
      data-emotion={emotion}
      data-mode={mode}
      data-speaking={String(isSpeaking)}
      data-active-viseme={resolvedLayers.activeViseme}
      data-eye-state={resolvedLayers.eyeState}
      data-motion-preset={resolvedLayers.motionPreset}
      data-brow-preset={resolvedLayers.browPreset}
      data-accessory-fx={resolvedLayers.accessoryFx}
      data-gaze-x={frame.eyeFocus.x.toFixed(2)}
      data-gaze-y={frame.eyeFocus.y.toFixed(2)}
      data-motion-impulse-y={motionImpulse.y.toFixed(2)}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        position: 'relative',
        width: fullBleed ? '100%' : `${width}px`,
        height: fullBleed ? '100%' : `${height}px`,
        overflow: 'hidden',
        userSelect: 'none',
        background: transparentBackground ? 'transparent' : '#14121d',
      }}
    >
      {mode === 'live2d' ? (
        <>
          {!transparentBackground && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                background:
                  'radial-gradient(circle at 50% 38%, rgba(49, 46, 129, 0.42), rgba(15, 13, 22, 0.96))',
              }}
            />
          )}
          <Live2DWebGLStage
            modelUrl={live2dModelUrl}
            params={live2dParams}
            emotion={emotion}
            motionPreset={resolvedLayers.motionPreset}
            controls={effectiveLive2dControls}
            onCanvasReady={(c) => {
              live2dCanvasRef.current = c
            }}
            width={width}
            height={height}
          />
          <div
            data-testid="live2d-parameter-hud"
            style={{
              position: 'absolute',
              bottom: '8px',
              left: '8px',
              padding: '6px 10px',
              borderRadius: '10px',
              background: 'rgba(15, 23, 42, 0.85)',
              border: '1px solid rgba(192, 132, 252, 0.4)',
              color: '#e2e8f0',
              fontFamily: 'monospace',
              fontSize: '10px',
              lineHeight: 1.35,
              pointerEvents: 'none',
              zIndex: 9,
            }}
          >
            <div>
              Live2D Cubism v{effectiveLive2dControls.version} · Expr:{' '}
              {effectiveLive2dControls.expressions.length}
            </div>
            <div>
              ParamMouthOpenY: {live2dParams.ParamMouthOpenY.toFixed(2)} · ParamEyeLOpen:{' '}
              {live2dParams.ParamEyeLOpen.toFixed(2)} · ParamAngleX:{' '}
              {live2dParams.ParamAngleX.toFixed(1)}
            </div>
          </div>
        </>
      ) : (
        <div
          data-testid="ashy-pngtuber-stage"
          data-pngtuber-sprite={spriteState}
          data-active-viseme={resolvedLayers.activeViseme}
          data-eye-state={resolvedLayers.eyeState}
          data-motion-preset={resolvedLayers.motionPreset}
          data-brow-preset={resolvedLayers.browPreset}
          data-accessory-fx={resolvedLayers.accessoryFx}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
        >
          <img
            src={PNGTUBER_SPRITE_PATHS[spriteState]}
            alt={`Ashy (${emotion})`}
            data-testid="ashy-stage-portrait"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center 22%',
              opacity: transparentBackground ? 0.92 : 1,
              transform: bounceTransform.cssTransform,
              transformOrigin: '50% 82%',
              transition: 'transform 0.08s ease-out, filter 0.25s ease',
              filter: isSpeaking
                ? 'brightness(1.06) saturate(1.05) drop-shadow(0 0 18px rgba(244, 166, 136, 0.28))'
                : `brightness(${(0.92 + ambientLuminance * 0.18).toFixed(2)})`,
              pointerEvents: 'none',
            }}
          />

          {/* Warm Ambient Vignette & Speaking Rim-Light Glow */}
          {!transparentBackground && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                background: isSpeaking
                  ? 'radial-gradient(circle at 50% 42%, rgba(244, 166, 136, 0.12) 0%, rgba(17, 15, 24, 0.30) 68%, rgba(14, 12, 20, 0.72) 100%)'
                  : 'radial-gradient(circle at 50% 42%, rgba(244, 166, 136, 0.03) 0%, rgba(17, 15, 24, 0.28) 65%, rgba(14, 12, 20, 0.68) 100%)',
                transition: 'background 0.35s ease',
              }}
            />
          )}
        </div>
      )}

      {/* Invisible HTML5 2D Silhouette Buffer (opacity: 0 in all modes — Red-Team B3) */}
      <canvas
        ref={canvasRef}
        data-testid="ashy-stage-render-canvas"
        width={width}
        height={height}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          opacity: 0,
        }}
      />

      {!hideBubble && (
        <PresenceBubble
          text={bubbleText}
          emotion={emotion}
          statusLabel={statusLabel}
          springOffset={bubbleOffset}
        />
      )}
    </div>
  )
}
