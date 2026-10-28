import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ASHY_EMOTIONS, type AshyEmotion } from '@ashy/shared'
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
  mode?: 'tachie' | 'live2d'
  width?: number
  height?: number
  uiIslandRects?: readonly UiIslandRect[]
  onIgnoreMouseChange?: (shouldIgnore: boolean) => void
}

export function AshyStageCanvas({
  emotion = 'neutral',
  emotionIntensity = 0.85,
  isSpeaking = false,
  rawVowels = { A: 0, E: 0, I: 0, O: 0, U: 0 },
  rawVolume = 0,
  ambientLuminance = 0.35,
  gazeTarget = null,
  bubbleText,
  statusLabel = 'Idle',
  mode = 'tachie',
  width = 380,
  height = 460,
  uiIslandRects,
  onIgnoreMouseChange,
}: AshyStageCanvasProps): React.ReactElement {
  const gradientId = useId()
  const vowelDriverRef = useRef(createWinnerRunnerUpVowelDriver())
  const visemeBlenderRef = useRef(createDynamicVisemeBlender())
  const blinkDriverRef = useRef(createAutoBlinkDriver())
  const saccadeDriverRef = useRef(createEyeSaccadeDriver())
  const squintDriverRef = useRef(createRetinalLightSquint({ initialLuminance: ambientLuminance }))
  const headSpringRef = useRef(createSubsteppedSpring2D({ x: 0, y: 0 }))
  const bubbleSpringRef = useRef(createSubsteppedSpring2D({ x: 0, y: 0 }))

  const silhouetteMask = useMemo(
    () => buildAvatarSilhouetteMask({ centerX: 0.5, centerY: 0.58, scale: 1 }),
    [],
  )

  const initialSynchronizedFrame = useMemo(() => {
    const vFrame = vowelDriverRef.current.step({
      rawVowels,
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
    const saccade = saccadeDriverRef.current.step(1 / 60, gazeTarget)
    const squint = squintDriverRef.current.step(ambientLuminance, 1 / 60)
    const breath = sampleBreathCycle(0.18)

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
      springOffset: { x: 0, y: 0 },
    })
  }, [emotion, emotionIntensity, isSpeaking, rawVowels, rawVolume, ambientLuminance, gazeTarget])

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
      const dtSeconds = Math.min(0.1, Math.max(0.001, (nowMs - lastTimeMs) / 1000))
      lastTimeMs = nowMs
      elapsedSec += dtSeconds

      const vFrame = vowelDriverRef.current.step({
        rawVowels,
        rawVolume: isSpeaking ? rawVolume : 0,
        dtSeconds,
      })

      const exprPose = interpolateEmotionPose(emotion, emotionIntensity)
      const blended = visemeBlenderRef.current.step({
        isSpeaking,
        dtSeconds,
        expression: exprPose,
        vowels: vFrame.vowels,
      })

      const blinkState = blinkDriverRef.current.step(dtSeconds, blended.eyeOpenL)
      const saccadeState = saccadeDriverRef.current.step(dtSeconds, gazeTarget)
      const squintState = squintDriverRef.current.step(ambientLuminance, dtSeconds)
      const breathValue = sampleBreathCycle(elapsedSec / 3.8)

      const springState = headSpringRef.current.step(
        {
          x: saccadeState.headFocus.x * 18,
          y: saccadeState.headFocus.y * 12 - breathValue * 5,
        },
        dtSeconds,
      )

      const bSpring = bubbleSpringRef.current.step(
        {
          x: saccadeState.headFocus.x * 8,
          y: -breathValue * 3,
        },
        dtSeconds,
      )

      setBubbleOffset({ x: bSpring.x, y: bSpring.y })
      setFrame(
        computeStageFrameState({
          emotion,
          emotionIntensity,
          isSpeaking,
          vowels: blended.vowels,
          blinkFactor: blinkState.blinkFactor,
          eyeFocus: saccadeState.eyeFocus,
          headFocus: saccadeState.headFocus,
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
  }, [emotion, emotionIntensity, isSpeaking, rawVowels, rawVolume, ambientLuminance, gazeTarget])

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onIgnoreMouseChange) return
    const rect = event.currentTarget.getBoundingClientRect()
    const clientX = event.clientX - rect.left
    const clientY = event.clientY - rect.top
    const targetEl = event.target as HTMLElement | null
    const isOverUiIsland = Boolean(targetEl?.closest?.('[data-ui-island="true"]'))

    const ignore = shouldIgnoreMouseEvent({
      clientX,
      clientY,
      viewportWidth: rect.width || width,
      viewportHeight: rect.height || height,
      silhouetteMask,
      isOverUiIsland,
      uiIslandRects,
    })
    onIgnoreMouseChange(ignore)
  }

  const { pose, eyeFocus, headFocus, breathValue, springOffset } = frame
  const mouthRx = Math.max(6, 16 + pose.mouthForm * 8 + pose.mouthSmile * 6)
  const mouthRy = Math.max(1.8, 2 + pose.mouthOpen * 16)
  const eyeRyL = Math.max(1.5, pose.eyeOpenL * 14)
  const eyeRyR = Math.max(1.5, pose.eyeOpenR * 14)
  const pupilOffsetX = eyeFocus.x * 6
  const pupilOffsetY = eyeFocus.y * 4
  const headTx = springOffset.x + headFocus.x * 10
  const headTy = springOffset.y + headFocus.y * 8 - breathValue * 4

  return (
    <div
      data-testid="ashy-stage-canvas"
      data-emotion={emotion}
      data-mode={mode}
      data-speaking={String(isSpeaking)}
      onMouseMove={handleMouseMove}
      style={{
        position: 'relative',
        width: `${width}px`,
        height: `${height}px`,
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      <PresenceBubble
        text={bubbleText}
        emotion={emotion}
        statusLabel={statusLabel}
        springOffset={bubbleOffset}
      />

      <svg
        data-testid="ashy-tachie-svg"
        viewBox="0 0 380 460"
        width={width}
        height={height}
        style={{ display: 'block', width: '100%', height: '100%' }}
      >
        <defs>
          <linearGradient id={`${gradientId}-hair`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#312e81" />
            <stop offset="55%" stopColor="#6d28d9" />
            <stop offset="100%" stopColor="#db2777" />
          </linearGradient>
          <linearGradient id={`${gradientId}-jacket`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#1e1b4b" />
            <stop offset="100%" stopColor="#0f172a" />
          </linearGradient>
        </defs>

        {/* Breathing Torso / Shoulders */}
        <g
          data-testid="ashy-layer-torso"
          transform={`translate(0, ${(34 - breathValue * 4.5).toFixed(2)})`}
        >
          <path
            d="M 95 455 C 102 330, 145 295, 190 295 C 235 295, 278 330, 285 455 Z"
            fill={`url(#${gradientId}-jacket)`}
            stroke="#f472b6"
            strokeWidth="2"
          />
          <path d="M 162 295 L 190 355 L 218 295 Z" fill="#f472b6" opacity="0.85" />
        </g>

        {/* Spring-Driven Head & Facial Expression Group */}
        <g
          data-testid="ashy-layer-head"
          transform={`translate(${headTx.toFixed(2)}, ${(34 + headTy).toFixed(2)})`}
        >
          {/* Back Hair */}
          <ellipse
            cx="190"
            cy="205"
            rx="92"
            ry="108"
            fill={`url(#${gradientId}-hair)`}
          />

          {/* Face Contour */}
          <path
            d="M 122 175 C 122 122, 258 122, 258 175 C 258 242, 224 282, 190 286 C 156 282, 122 242, 122 175 Z"
            fill="#fde8e8"
          />

          {/* Cheek Blush */}
          <ellipse
            cx="144"
            cy="226"
            rx="16"
            ry="8"
            fill="#fb7185"
            opacity={pose.cheekBlush}
          />
          <ellipse
            cx="236"
            cy="226"
            rx="16"
            ry="8"
            fill="#fb7185"
            opacity={pose.cheekBlush}
          />

          {/* Left & Right Eyebrows */}
          <line
            data-testid="ashy-brow-left"
            x1="138"
            y1={168 - pose.browLY * 12 - pose.browAngle * 8}
            x2="172"
            y2={168 - pose.browLY * 12 + pose.browAngle * 8}
            stroke="#312e81"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
          <line
            data-testid="ashy-brow-right"
            x1="208"
            y1={168 - pose.browRY * 12 + pose.browAngle * 8}
            x2="242"
            y2={168 - pose.browRY * 12 - pose.browAngle * 8}
            stroke="#312e81"
            strokeWidth="3.5"
            strokeLinecap="round"
          />

          {/* Left Eye */}
          <g data-testid="ashy-eye-left">
            <ellipse cx="155" cy="196" rx="16" ry={eyeRyL} fill="#ffffff" />
            {pose.eyeOpenL > BLINK_THRESHOLD ? (
              <>
                <circle
                  cx={155 + pupilOffsetX}
                  cy={196 + pupilOffsetY}
                  r={8.5 * pose.pupilScale}
                  fill="#9333ea"
                />
                <circle
                  cx={152 + pupilOffsetX * 0.6}
                  cy={192 + pupilOffsetY * 0.6}
                  r="3"
                  fill="#ffffff"
                />
              </>
            ) : null}
          </g>

          {/* Right Eye */}
          <g data-testid="ashy-eye-right">
            <ellipse cx="225" cy="196" rx="16" ry={eyeRyR} fill="#ffffff" />
            {pose.eyeOpenR > BLINK_THRESHOLD ? (
              <>
                <circle
                  cx={225 + pupilOffsetX}
                  cy={196 + pupilOffsetY}
                  r={8.5 * pose.pupilScale}
                  fill="#9333ea"
                />
                <circle
                  cx={222 + pupilOffsetX * 0.6}
                  cy={192 + pupilOffsetY * 0.6}
                  r="3"
                  fill="#ffffff"
                />
              </>
            ) : null}
          </g>

          {/* Viseme-Driven Mouth */}
          <ellipse
            data-testid="ashy-mouth"
            cx="190"
            cy={248 - pose.mouthSmile * 3}
            rx={mouthRx}
            ry={mouthRy}
            fill="#be185d"
            stroke="#831843"
            strokeWidth="2"
          />

          {/* Front Hair Bangs */}
          <path
            d="M 110 175 C 125 110, 255 110, 270 175 C 248 142, 222 158, 190 145 C 158 158, 132 142, 110 175 Z"
            fill={`url(#${gradientId}-hair)`}
          />
        </g>
      </svg>
    </div>
  )
}
