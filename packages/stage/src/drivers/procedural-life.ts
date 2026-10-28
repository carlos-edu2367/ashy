export const BLINK_THRESHOLD = 0.15
export const EYE_SACCADE_INT_P = [
  0.075, 0.185, 0.34, 0.505, 0.655, 0.785, 0.88, 0.945, 0.98, 1.0,
] as const

export const MAX_STEP_SEC = 1 / 120
export const MAX_INTEGRATION_SEC = 0.1

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function clampBipolar(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(-1, value))
}

export function easeOutQuad(t: number): number {
  const u = clampUnit(t)
  return 1 - (1 - u) * (1 - u)
}

export function easeInQuad(t: number): number {
  const u = clampUnit(t)
  return u * u
}

export type BlinkPhase = 'idle' | 'closing' | 'opening'

export interface AutoBlinkOptions {
  minIntervalMs?: number
  maxIntervalMs?: number
  closingDurationMs?: number
  minOpeningDurationMs?: number
  maxOpeningDurationMs?: number
  blinkThreshold?: number
  rng?: () => number
}

export interface AutoBlinkStepResult {
  eyeOpen: number
  blinkFactor: number
  phase: BlinkPhase
  aborted: boolean
  nextBlinkIntervalMs: number
  openingDurationMs: number
}

export interface AutoBlinkDriver {
  step(dtSeconds: number, expressionEyeOpen?: number): AutoBlinkStepResult
  getState(): AutoBlinkStepResult
  reset(): void
}

export function createAutoBlinkDriver(options: AutoBlinkOptions = {}): AutoBlinkDriver {
  const minIntervalMs = options.minIntervalMs ?? 3000
  const maxIntervalMs = options.maxIntervalMs ?? 8000
  const closingDurationSec = (options.closingDurationMs ?? 75) / 1000
  const minOpeningMs = options.minOpeningDurationMs ?? 150
  const maxOpeningMs = options.maxOpeningDurationMs ?? 300
  const blinkThreshold = options.blinkThreshold ?? BLINK_THRESHOLD
  const rng = options.rng ?? Math.random

  function sampleIntervalSec(): number {
    const u = clampUnit(rng())
    return (minIntervalMs + (maxIntervalMs - minIntervalMs) * u) / 1000
  }

  function sampleOpeningSec(): number {
    const u = clampUnit(rng())
    return (minOpeningMs + (maxOpeningMs - minOpeningMs) * u) / 1000
  }

  let phase: BlinkPhase = 'idle'
  let phaseElapsedSec = 0
  let currentIntervalSec = sampleIntervalSec()
  let currentOpeningSec = sampleOpeningSec()
  let blinkFactor = 1
  let lastEyeOpen = 1
  let lastAborted = false

  function buildResult(): AutoBlinkStepResult {
    return {
      eyeOpen: lastEyeOpen,
      blinkFactor,
      phase,
      aborted: lastAborted,
      nextBlinkIntervalMs: currentIntervalSec * 1000,
      openingDurationMs: currentOpeningSec * 1000,
    }
  }

  return {
    step(dtSeconds: number, expressionEyeOpen = 1): AutoBlinkStepResult {
      const safeExprEye = Number.isFinite(expressionEyeOpen)
        ? Math.max(0, expressionEyeOpen)
        : 0
      const safeDt = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0

      // Anti-Loop Guard: if expressionEyeOpen <= BLINK_THRESHOLD (0.15), abort blink
      if (safeExprEye <= blinkThreshold) {
        phase = 'idle'
        phaseElapsedSec = 0
        blinkFactor = 1
        lastEyeOpen = safeExprEye
        lastAborted = true
        currentIntervalSec = sampleIntervalSec()
        return buildResult()
      }

      lastAborted = false
      phaseElapsedSec += safeDt

      if (phase === 'idle') {
        if (phaseElapsedSec >= currentIntervalSec) {
          phaseElapsedSec = Math.max(0, phaseElapsedSec - currentIntervalSec)
          phase = 'closing'
          currentOpeningSec = sampleOpeningSec()
          const tClose = clampUnit(phaseElapsedSec / closingDurationSec)
          blinkFactor = 1 - easeOutQuad(tClose)
        } else {
          blinkFactor = 1
        }
      } else if (phase === 'closing') {
        if (phaseElapsedSec >= closingDurationSec) {
          phaseElapsedSec = Math.max(0, phaseElapsedSec - closingDurationSec)
          phase = 'opening'
          const tOpen = clampUnit(phaseElapsedSec / currentOpeningSec)
          blinkFactor = easeInQuad(tOpen)
        } else {
          const tClose = clampUnit(phaseElapsedSec / closingDurationSec)
          blinkFactor = 1 - easeOutQuad(tClose)
        }
      } else if (phase === 'opening') {
        if (phaseElapsedSec >= currentOpeningSec) {
          phaseElapsedSec = 0
          phase = 'idle'
          blinkFactor = 1
          currentIntervalSec = sampleIntervalSec()
        } else {
          const tOpen = clampUnit(phaseElapsedSec / currentOpeningSec)
          blinkFactor = easeInQuad(tOpen)
        }
      }

      lastEyeOpen = safeExprEye * blinkFactor
      return buildResult()
    },

    getState(): AutoBlinkStepResult {
      return buildResult()
    },

    reset(): void {
      phase = 'idle'
      phaseElapsedSec = 0
      blinkFactor = 1
      lastEyeOpen = 1
      lastAborted = false
      currentIntervalSec = sampleIntervalSec()
      currentOpeningSec = sampleOpeningSec()
    },
  }
}

export interface Point2D {
  x: number
  y: number
}

export function sampleSaccadeIntervalMs(u: number): number {
  const safeU = clampUnit(u)
  for (let i = 0; i < EYE_SACCADE_INT_P.length; i++) {
    if (safeU <= EYE_SACCADE_INT_P[i]!) {
      return 800 + i * 400
    }
  }
  return 4400
}

export interface EyeSaccadeOptions {
  rng?: () => number
  maxSaccadeAmplitudeX?: number
  maxSaccadeAmplitudeY?: number
  eyeLerpFactor?: number
  headCouplingFactor?: number
}

export interface EyeSaccadeState {
  target: Point2D
  eyeFocus: Point2D
  headFocus: Point2D
  nextIntervalMs: number
}

export interface EyeSaccadeDriver {
  step(dtSeconds: number, externalTarget?: Point2D | null): EyeSaccadeState
  getState(): EyeSaccadeState
  reset(): void
}

export function createEyeSaccadeDriver(options: EyeSaccadeOptions = {}): EyeSaccadeDriver {
  const rng = options.rng ?? Math.random
  const maxAmpX = options.maxSaccadeAmplitudeX ?? 0.35
  const maxAmpY = options.maxSaccadeAmplitudeY ?? 0.22
  const eyeLerpFactor = options.eyeLerpFactor ?? 0.3
  const headCouplingFactor = options.headCouplingFactor ?? 0.5

  let target: Point2D = { x: 0, y: 0 }
  let eyeFocus: Point2D = { x: 0, y: 0 }
  let headFocus: Point2D = { x: 0, y: 0 }
  let elapsedMs = 0
  let nextIntervalMs = sampleSaccadeIntervalMs(rng())

  function sampleSpontaneousTarget(): Point2D {
    const rx = (clampUnit(rng()) * 2 - 1) * maxAmpX
    const ry = (clampUnit(rng()) * 2 - 1) * maxAmpY
    return { x: rx, y: ry }
  }

  return {
    step(dtSeconds: number, externalTarget?: Point2D | null): EyeSaccadeState {
      const safeDtMs = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) * 1000 : 0

      if (externalTarget && Number.isFinite(externalTarget.x) && Number.isFinite(externalTarget.y)) {
        target = {
          x: clampBipolar(externalTarget.x),
          y: clampBipolar(externalTarget.y),
        }
      } else {
        elapsedMs += safeDtMs
        if (elapsedMs >= nextIntervalMs) {
          elapsedMs = 0
          nextIntervalMs = sampleSaccadeIntervalMs(rng())
          target = sampleSpontaneousTarget()
        }
      }

      headFocus = {
        x: target.x * headCouplingFactor,
        y: target.y * headCouplingFactor,
      }

      eyeFocus = {
        x: eyeFocus.x + (target.x - eyeFocus.x) * eyeLerpFactor,
        y: eyeFocus.y + (target.y - eyeFocus.y) * eyeLerpFactor,
      }

      return {
        target: { ...target },
        eyeFocus: { ...eyeFocus },
        headFocus: { ...headFocus },
        nextIntervalMs,
      }
    },

    getState(): EyeSaccadeState {
      return {
        target: { ...target },
        eyeFocus: { ...eyeFocus },
        headFocus: { ...headFocus },
        nextIntervalMs,
      }
    },

    reset(): void {
      target = { x: 0, y: 0 }
      eyeFocus = { x: 0, y: 0 }
      headFocus = { x: 0, y: 0 }
      elapsedMs = 0
      nextIntervalMs = sampleSaccadeIntervalMs(rng())
    },
  }
}

export interface BreathCycleOptions {
  inhaleShare?: number
  exhaleShare?: number
  dwellShare?: number
}

/**
 * Asymmetric breath cycle:
 * - inhaleShare = 0.42 (smooth rising half-cosine 0 -> 1)
 * - exhaleShare = 0.46 (smooth falling half-cosine 1 -> 0)
 * - dwellShare = 0.12 (bottom-of-lung rest = 0)
 */
export function sampleBreathCycle(
  cyclePhase: number,
  options: BreathCycleOptions = {},
): number {
  if (!Number.isFinite(cyclePhase)) return 0

  const inhaleShare =
    Number.isFinite(options.inhaleShare) && options.inhaleShare! > 0
      ? options.inhaleShare!
      : 0.42
  const exhaleShare =
    Number.isFinite(options.exhaleShare) && options.exhaleShare! > 0
      ? options.exhaleShare!
      : 0.46
  const dwellShare =
    Number.isFinite(options.dwellShare) && options.dwellShare! >= 0
      ? options.dwellShare!
      : 0.12
  const totalShare = inhaleShare + exhaleShare + dwellShare
  if (!Number.isFinite(totalShare) || totalShare <= 0) return 0

  const normInhale = inhaleShare / totalShare
  const normExhale = exhaleShare / totalShare

  // Wrap phase into [0, 1)
  const p = ((cyclePhase % 1) + 1) % 1

  if (p < normInhale) {
    const u = p / normInhale
    return 0.5 * (1 - Math.cos(Math.PI * u))
  }

  const exhaleEnd = normInhale + normExhale
  if (p < exhaleEnd) {
    const u = (p - normInhale) / normExhale
    return 0.5 * (1 + Math.cos(Math.PI * u))
  }

  return 0
}

export interface SpringState1D {
  position: number
  velocity: number
}

export interface SpringConfig {
  stiffness?: number
  damping?: number
}

export function advanceSpring1D(
  state: SpringState1D,
  target: number,
  dtSeconds: number,
  config: SpringConfig = {},
): SpringState1D {
  let pos = Number.isFinite(state.position) ? state.position : 0
  let vel = Number.isFinite(state.velocity) ? state.velocity : 0
  const safeTarget = Number.isFinite(target) ? target : pos

  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
    return { position: pos, velocity: vel }
  }

  // Clamp stiffness to [0, 2400] and damping to [0, 400] for unconditional stability at 120Hz
  const stiffness = Number.isFinite(config.stiffness)
    ? Math.min(2400, Math.max(0, config.stiffness!))
    : 180
  const damping = Number.isFinite(config.damping)
    ? Math.min(400, Math.max(0, config.damping!))
    : 24

  // Clamp total integration window to MAX_INTEGRATION_SEC (0.1s) to prevent background-tab explosions
  const clampedDt = Math.min(MAX_INTEGRATION_SEC, dtSeconds)
  const substeps = Math.max(1, Math.ceil(clampedDt / MAX_STEP_SEC))
  const stepDt = clampedDt / substeps

  for (let i = 0; i < substeps; i++) {
    const accel = stiffness * (safeTarget - pos) - damping * vel
    vel += accel * stepDt
    pos += vel * stepDt
  }

  return { position: pos, velocity: vel }
}

export interface SpringState2D {
  x: number
  y: number
  vx: number
  vy: number
}

export interface SubsteppedSpring2D {
  step(target: Point2D, dtSeconds: number): SpringState2D
  getState(): SpringState2D
  reset(initial?: Partial<Point2D>): void
}

export function createSubsteppedSpring2D(
  initial: Partial<Point2D> = {},
  config: SpringConfig = {},
): SubsteppedSpring2D {
  let stateX: SpringState1D = {
    position: Number.isFinite(initial.x) ? initial.x! : 0,
    velocity: 0,
  }
  let stateY: SpringState1D = {
    position: Number.isFinite(initial.y) ? initial.y! : 0,
    velocity: 0,
  }

  return {
    step(target: Point2D, dtSeconds: number): SpringState2D {
      stateX = advanceSpring1D(stateX, target.x, dtSeconds, config)
      stateY = advanceSpring1D(stateY, target.y, dtSeconds, config)
      return {
        x: stateX.position,
        y: stateY.position,
        vx: stateX.velocity,
        vy: stateY.velocity,
      }
    },

    getState(): SpringState2D {
      return {
        x: stateX.position,
        y: stateY.position,
        vx: stateX.velocity,
        vy: stateY.velocity,
      }
    },

    reset(nextInitial: Partial<Point2D> = {}): void {
      stateX = {
        position: Number.isFinite(nextInitial.x) ? nextInitial.x! : 0,
        velocity: 0,
      }
      stateY = {
        position: Number.isFinite(nextInitial.y) ? nextInitial.y! : 0,
        velocity: 0,
      }
    },
  }
}

export interface RetinalLightSquintOptions {
  tauFastSec?: number
  tauLightSec?: number
  tauDarkSec?: number
  initialLuminance?: number
  transientSensitivity?: number
  steadyGlareThreshold?: number
  steadyGlareScale?: number
}

export interface RetinalLightSquintState {
  squintAmount: number
  fastL: number
  slowL: number
  ambientL: number
}

export interface RetinalLightSquintDriver {
  step(ambientLuminance: number, dtSeconds: number): RetinalLightSquintState
  getState(): RetinalLightSquintState
  reset(initialLuminance?: number): void
}

export function createRetinalLightSquint(
  options: RetinalLightSquintOptions = {},
): RetinalLightSquintDriver {
  const tauFastSec = Math.max(0.001, options.tauFastSec ?? 0.15)
  const tauLightSec = Math.max(0.01, options.tauLightSec ?? 4.0)
  const tauDarkSec = Math.max(0.01, options.tauDarkSec ?? 90.0)
  const transientSensitivity = options.transientSensitivity ?? 1.6
  const steadyGlareThreshold = options.steadyGlareThreshold ?? 0.65
  const steadyGlareScale = options.steadyGlareScale ?? 0.6

  const initL = clampUnit(options.initialLuminance ?? 0.35)
  let fastL = initL
  let slowL = initL
  let ambientL = initL
  let squintAmount = 0

  return {
    step(ambientLuminance: number, dtSeconds: number): RetinalLightSquintState {
      ambientL = clampUnit(ambientLuminance)
      const safeDt = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0

      if (safeDt > 0) {
        const alphaFast = 1 - Math.exp(-safeDt / tauFastSec)
        fastL = fastL + (ambientL - fastL) * alphaFast

        const tauSlow = ambientL > slowL ? tauLightSec : tauDarkSec
        const alphaSlow = 1 - Math.exp(-safeDt / tauSlow)
        slowL = slowL + (ambientL - slowL) * alphaSlow
      }

      const transientDelta = Math.max(0, fastL - slowL)
      const steadyGlare = Math.max(0, ambientL - steadyGlareThreshold) * steadyGlareScale
      squintAmount = clampUnit(transientDelta * transientSensitivity + steadyGlare)

      return {
        squintAmount,
        fastL,
        slowL,
        ambientL,
      }
    },

    getState(): RetinalLightSquintState {
      return {
        squintAmount,
        fastL,
        slowL,
        ambientL,
      }
    },

    reset(nextLuminance = 0.35): void {
      const clamped = clampUnit(nextLuminance)
      fastL = clamped
      slowL = clamped
      ambientL = clamped
      squintAmount = 0
    },
  }
}

export interface AmbientLightSampleOptions {
  avatarAlphaCutoff?: number
  spatialWeights?: Float32Array | number[]
}

export interface AmbientLightSampleResult {
  oklabL: number
  oklabA: number
  oklabB: number
  linearRGB: [number, number, number]
  validSampleCount: number
  totalWeight: number
}

function srgbByteToLinear(byteVal: number): number {
  const s = clampUnit(byteVal / 255)
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function linearRgbToOklab(
  r: number,
  g: number,
  b: number,
): { L: number; a: number; b: number } {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b

  const l_ = Math.cbrt(Math.max(0, l))
  const m_ = Math.cbrt(Math.max(0, m))
  const s_ = Math.cbrt(Math.max(0, s))

  return {
    L: clampUnit(0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_),
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  }
}

/**
 * Normalized convolution (R*w, G*w, B*w, w) over an RGBA buffer that ignores any pixel
 * where `avatarPaintedAlpha > 4` to prevent self-feedback from the avatar's own pixels.
 */
export function sampleNormalizedAmbientLight(
  rgbaBuffer: Uint8Array | Uint8ClampedArray,
  avatarAlphaMask: Uint8Array | Uint8ClampedArray | null | undefined,
  width: number,
  height: number,
  options: AmbientLightSampleOptions = {},
): AmbientLightSampleResult {
  const safeW = Math.max(0, Math.floor(width))
  const safeH = Math.max(0, Math.floor(height))
  const pixelCount = safeW * safeH
  const avatarAlphaCutoff = options.avatarAlphaCutoff ?? 4

  if (pixelCount === 0 || rgbaBuffer.length < pixelCount * 4) {
    return {
      oklabL: 0,
      oklabA: 0,
      oklabB: 0,
      linearRGB: [0, 0, 0],
      validSampleCount: 0,
      totalWeight: 0,
    }
  }

  let accumR = 0
  let accumG = 0
  let accumB = 0
  let accumW = 0
  let validSampleCount = 0

  const isRgbaMask = Boolean(avatarAlphaMask && avatarAlphaMask.length === pixelCount * 4)

  for (let i = 0; i < pixelCount; i++) {
    const rgbaIdx = i * 4
    let avatarPaintedAlpha = 0
    if (avatarAlphaMask) {
      avatarPaintedAlpha = isRgbaMask
        ? (avatarAlphaMask[rgbaIdx + 3] ?? 0)
        : (avatarAlphaMask[i] ?? 0)
    }

    // Strict self-illumination exclusion: ignore pixels where avatarPaintedAlpha > 4
    if (avatarPaintedAlpha > avatarAlphaCutoff) {
      continue
    }

    const spatialW = options.spatialWeights ? (options.spatialWeights[i] ?? 1) : 1
    if (!Number.isFinite(spatialW) || spatialW <= 0) {
      continue
    }

    const rLin = srgbByteToLinear(rgbaBuffer[rgbaIdx] ?? 0)
    const gLin = srgbByteToLinear(rgbaBuffer[rgbaIdx + 1] ?? 0)
    const bLin = srgbByteToLinear(rgbaBuffer[rgbaIdx + 2] ?? 0)

    accumR += rLin * spatialW
    accumG += gLin * spatialW
    accumB += bLin * spatialW
    accumW += spatialW
    validSampleCount++
  }

  if (accumW <= 0) {
    return {
      oklabL: 0,
      oklabA: 0,
      oklabB: 0,
      linearRGB: [0, 0, 0],
      validSampleCount: 0,
      totalWeight: 0,
    }
  }

  const normR = accumR / accumW
  const normG = accumG / accumW
  const normB = accumB / accumW
  const oklab = linearRgbToOklab(normR, normG, normB)

  return {
    oklabL: oklab.L,
    oklabA: oklab.a,
    oklabB: oklab.b,
    linearRGB: [normR, normG, normB],
    validSampleCount,
    totalWeight: accumW,
  }
}
