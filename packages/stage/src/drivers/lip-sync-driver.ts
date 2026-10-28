export const VOWEL_KEYS = ['A', 'E', 'I', 'O', 'U'] as const
export type VowelKey = (typeof VOWEL_KEYS)[number]
export type VowelWeights = Record<VowelKey, number>

export interface FacialExpressionPose {
  eyeOpenL: number
  eyeOpenR: number
  browLY: number
  browRY: number
  browAngle: number
  mouthOpen: number
  mouthForm: number
  mouthSmile: number
  cheekBlush: number
  pupilScale: number
}

export interface VowelDriverOptions {
  silenceAmpThreshold?: number
  silenceWinnerThreshold?: number
  silenceHoldSec?: number
  winnerCap?: number
  runnerUpScale?: number
  runnerUpCap?: number
  attackSpeed?: number
  releaseSpeed?: number
  outputScale?: number
}

export interface VowelDriverInput {
  rawVowels: Partial<Record<VowelKey | 'S', number>>
  rawVolume: number
  dtSeconds: number
  sibilantS?: number
}

export interface VowelDriverFrame extends VowelWeights {
  vowels: VowelWeights
  targets: VowelWeights
  smoothed: VowelWeights
  amp: number
  winner: VowelKey | null
  runnerUp: VowelKey | null
  isSilent: boolean
  silenceDurationSec: number
}

export interface WinnerRunnerUpVowelDriver {
  step(input: VowelDriverInput): VowelDriverFrame
  getState(): VowelDriverFrame
  reset(): void
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function clampBipolar(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(-1, value))
}

function createZeroVowels(): VowelWeights {
  return { A: 0, E: 0, I: 0, O: 0, U: 0 }
}

export function createWinnerRunnerUpVowelDriver(
  options: VowelDriverOptions = {},
): WinnerRunnerUpVowelDriver {
  const silenceAmpThreshold = options.silenceAmpThreshold ?? 0.04
  const silenceWinnerThreshold = options.silenceWinnerThreshold ?? 0.05
  const silenceHoldSec = options.silenceHoldSec ?? 0.16
  const winnerCap = options.winnerCap ?? 0.7
  const runnerUpScale = options.runnerUpScale ?? 0.6
  const runnerUpCap = options.runnerUpCap ?? 0.35
  const attackSpeed = options.attackSpeed ?? 50
  const releaseSpeed = options.releaseSpeed ?? 30
  const outputScale = options.outputScale ?? 0.7

  let smoothed: VowelWeights = createZeroVowels()
  let lastTargets: VowelWeights = createZeroVowels()
  let silenceDurationSec = silenceHoldSec
  let lastAmp = 0
  let lastWinner: VowelKey | null = null
  let lastRunnerUp: VowelKey | null = null
  let lastIsSilent = true

  function buildFrame(): VowelDriverFrame {
    const scaled: VowelWeights = {
      A: smoothed.A * outputScale,
      E: smoothed.E * outputScale,
      I: smoothed.I * outputScale,
      O: smoothed.O * outputScale,
      U: smoothed.U * outputScale,
    }
    return {
      ...scaled,
      vowels: { ...scaled },
      targets: { ...lastTargets },
      smoothed: { ...smoothed },
      amp: lastAmp,
      winner: lastWinner,
      runnerUp: lastRunnerUp,
      isSilent: lastIsSilent,
      silenceDurationSec,
    }
  }

  return {
    step(input: VowelDriverInput): VowelDriverFrame {
      const safeVolume = Number.isFinite(input.rawVolume) ? Math.max(0, input.rawVolume) : 0
      const safeDt = Number.isFinite(input.dtSeconds)
        ? Math.min(0.5, Math.max(0, input.dtSeconds))
        : 0

      // Power curve on amplitude: amp = Math.min(Math.max(0, rawVolume) * 0.9, 1) ** 0.7
      const amp = Math.min(Math.max(0, safeVolume) * 0.9, 1) ** 0.7
      lastAmp = amp

      const sibilantWeight = clampUnit(input.sibilantS ?? input.rawVowels?.S ?? 0)

      const ranked = VOWEL_KEYS.map((key) => {
        const baseRaw = clampUnit(input.rawVowels?.[key] ?? 0)
        const effectiveRaw =
          key === 'I' ? Math.min(1, Math.max(baseRaw, sibilantWeight) + (baseRaw > 0 && sibilantWeight > 0 ? sibilantWeight * 0.5 : 0)) : baseRaw
        return {
          key,
          raw: effectiveRaw,
          weight: effectiveRaw * amp,
        }
      }).sort((a, b) => b.weight - a.weight)

      const winnerEntry = ranked[0]!
      const runnerUpEntry = ranked[1]!

      const belowSilenceThreshold =
        amp < silenceAmpThreshold || winnerEntry.weight < silenceWinnerThreshold

      if (belowSilenceThreshold) {
        silenceDurationSec += safeDt
      } else {
        silenceDurationSec = 0
      }

      const isSilent = silenceDurationSec >= silenceHoldSec
      lastIsSilent = isSilent

      const targets = createZeroVowels()
      if (!isSilent && amp > 0 && winnerEntry.weight > 0) {
        targets[winnerEntry.key] = Math.min(winnerCap, winnerEntry.weight)
        targets[runnerUpEntry.key] = Math.min(runnerUpCap, runnerUpEntry.weight * runnerUpScale)
        lastWinner = winnerEntry.key
        lastRunnerUp = runnerUpEntry.weight > 0 ? runnerUpEntry.key : null
      } else {
        lastWinner = null
        lastRunnerUp = null
      }

      lastTargets = targets

      // Asymmetric exponential smoothing: speed = to > from ? 50 : 30
      const nextSmoothed = createZeroVowels()
      for (const key of VOWEL_KEYS) {
        const from = smoothed[key]
        const to = targets[key]
        const speed = to > from ? attackSpeed : releaseSpeed
        const alpha = safeDt > 0 ? 1 - Math.exp(-speed * safeDt) : 0
        const nextVal = from + (to - from) * alpha
        nextSmoothed[key] = Number.isFinite(nextVal) ? Math.max(0, nextVal) : 0
      }
      smoothed = nextSmoothed

      return buildFrame()
    },

    getState(): VowelDriverFrame {
      return buildFrame()
    },

    reset(): void {
      smoothed = createZeroVowels()
      lastTargets = createZeroVowels()
      silenceDurationSec = silenceHoldSec
      lastAmp = 0
      lastWinner = null
      lastRunnerUp = null
      lastIsSilent = true
    },
  }
}

export interface DynamicVisemeBlenderOptions {
  visemeBlendDurationSec?: number
}

export interface DynamicVisemeBlendInput {
  isSpeaking: boolean
  dtSeconds: number
  expression: FacialExpressionPose
  vowels: VowelWeights
  vocalMouthOpenOverride?: number
}

export interface BlendedFacialPose extends FacialExpressionPose {
  vowels: VowelWeights
  visemeWeight: number
  isBlendingBack: boolean
}

export interface DynamicVisemeBlender {
  step(input: DynamicVisemeBlendInput): BlendedFacialPose
  getState(): { visemeWeight: number; blendElapsedSec: number; isBlendingBack: boolean }
  reset(): void
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

export function computeVocalMouthChannels(
  vowels: VowelWeights,
  expression: FacialExpressionPose,
  vocalMouthOpenOverride?: number,
): { mouthOpen: number; mouthForm: number; mouthSmile: number } {
  const A = clampUnit(vowels.A)
  const E = clampUnit(vowels.E)
  const I = clampUnit(vowels.I)
  const O = clampUnit(vowels.O)
  const U = clampUnit(vowels.U)

  const computedOpen = clampUnit(A * 1.0 + O * 0.85 + E * 0.55 + U * 0.45 + I * 0.25)
  const mouthOpen =
    vocalMouthOpenOverride !== undefined && Number.isFinite(vocalMouthOpenOverride)
      ? clampUnit(vocalMouthOpenOverride)
      : computedOpen

  const mouthForm = clampBipolar(I * 0.8 + E * 0.5 - (O * 0.8 + U * 0.9))
  const mouthSmile = clampUnit(expression.mouthSmile * 0.35 + I * 0.65 + E * 0.45)

  return { mouthOpen, mouthForm, mouthSmile }
}

export function createDynamicVisemeBlender(
  options: DynamicVisemeBlenderOptions = {},
): DynamicVisemeBlender {
  const visemeBlendDurationSec = Math.max(0.001, options.visemeBlendDurationSec ?? 0.18)

  let wasSpeaking = false
  let isBlendingBack = false
  let blendElapsedSec = visemeBlendDurationSec
  let visemeWeight = 0
  let lastVocalMouth = { mouthOpen: 0, mouthForm: 0, mouthSmile: 0 }
  let lastVocalVowels: VowelWeights = createZeroVowels()

  return {
    step(input: DynamicVisemeBlendInput): BlendedFacialPose {
      const safeDt = Number.isFinite(input.dtSeconds)
        ? Math.min(1, Math.max(0, input.dtSeconds))
        : 0
      const expr = input.expression

      if (input.isSpeaking) {
        const vocalMouth = computeVocalMouthChannels(
          input.vowels,
          expr,
          input.vocalMouthOpenOverride,
        )
        lastVocalMouth = vocalMouth
        lastVocalVowels = {
          A: clampUnit(input.vowels.A),
          E: clampUnit(input.vowels.E),
          I: clampUnit(input.vowels.I),
          O: clampUnit(input.vowels.O),
          U: clampUnit(input.vowels.U),
        }
        wasSpeaking = true
        isBlendingBack = false
        blendElapsedSec = 0
        visemeWeight = 1

        return {
          // Non-mouth channels stay 100% locked to emotional expression
          eyeOpenL: expr.eyeOpenL,
          eyeOpenR: expr.eyeOpenR,
          browLY: expr.browLY,
          browRY: expr.browRY,
          browAngle: expr.browAngle,
          cheekBlush: expr.cheekBlush,
          pupilScale: expr.pupilScale,
          // Mouth channels ceded to lip-sync visemes
          mouthOpen: vocalMouth.mouthOpen,
          mouthForm: vocalMouth.mouthForm,
          mouthSmile: vocalMouth.mouthSmile,
          vowels: { ...lastVocalVowels },
          visemeWeight: 1,
          isBlendingBack: false,
        }
      }

      if (wasSpeaking) {
        isBlendingBack = true
        blendElapsedSec = 0
        wasSpeaking = false
      }

      if (isBlendingBack) {
        blendElapsedSec += safeDt
        const t = Math.min(1, blendElapsedSec / visemeBlendDurationSec)
        visemeWeight = 1 - t
        if (t >= 1) {
          isBlendingBack = false
          visemeWeight = 0
        }

        return {
          eyeOpenL: expr.eyeOpenL,
          eyeOpenR: expr.eyeOpenR,
          browLY: expr.browLY,
          browRY: expr.browRY,
          browAngle: expr.browAngle,
          cheekBlush: expr.cheekBlush,
          pupilScale: expr.pupilScale,
          mouthOpen: lerp(lastVocalMouth.mouthOpen, expr.mouthOpen, t),
          mouthForm: lerp(lastVocalMouth.mouthForm, expr.mouthForm, t),
          mouthSmile: lerp(lastVocalMouth.mouthSmile, expr.mouthSmile, t),
          vowels: {
            A: lerp(lastVocalVowels.A, 0, t),
            E: lerp(lastVocalVowels.E, 0, t),
            I: lerp(lastVocalVowels.I, 0, t),
            O: lerp(lastVocalVowels.O, 0, t),
            U: lerp(lastVocalVowels.U, 0, t),
          },
          visemeWeight,
          isBlendingBack,
        }
      }

      visemeWeight = 0
      return {
        ...expr,
        vowels: createZeroVowels(),
        visemeWeight: 0,
        isBlendingBack: false,
      }
    },

    getState() {
      return { visemeWeight, blendElapsedSec, isBlendingBack }
    },

    reset() {
      wasSpeaking = false
      isBlendingBack = false
      blendElapsedSec = visemeBlendDurationSec
      visemeWeight = 0
      lastVocalMouth = { mouthOpen: 0, mouthForm: 0, mouthSmile: 0 }
      lastVocalVowels = createZeroVowels()
    },
  }
}
