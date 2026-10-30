import {
  ASHY_EMOTIONS,
  ASHY_MOTION_PRESETS,
  type AshyEmotion,
  type AshyMotionPreset,
} from '@ashy/shared'
import {
  VOWEL_KEYS,
  createWinnerRunnerUpVowelDriver,
  type VowelDriverFrame,
  type VowelKey,
} from './lip-sync-driver'

export interface AcousticLipSyncFrame {
  rawVowels: Record<VowelKey | 'S', number>
  rawVolume: number
  dominantVowel: VowelKey | null
  rmsEnergy: number
  zeroCrossingRate: number
}

export interface StageActKeyframe {
  atMs: number
  emotion?: AshyEmotion
  intensity?: number
  motion?: AshyMotionPreset
}

export interface StageSpeechTimelineSample {
  playbackTimeMs: number
  isSpeaking: boolean
  emotion: AshyEmotion
  emotionIntensity: number
  motion: AshyMotionPreset
  acoustic: AcousticLipSyncFrame
  driverFrame: VowelDriverFrame
}

export interface StageSpeechSynchronizerInput {
  samples: Float32Array
  sampleRate?: number
  frameDurationMs?: number
  initialEmotion?: AshyEmotion
  initialIntensity?: number
  initialMotion?: AshyMotionPreset
  actKeyframes?: readonly StageActKeyframe[]
}

export interface StageSpeechSynchronizer {
  readonly durationMs: number
  readonly frameCount: number
  sampleAt(playbackTimeMs: number): StageSpeechTimelineSample
}

const CANONICAL_FORMANT_PAIRS: Readonly<Record<VowelKey, readonly [number, number]>> =
  Object.freeze({
    A: [750, 1200],
    E: [530, 1850],
    I: [300, 2350],
    O: [480, 850],
    U: [310, 620],
  })

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function createSilentAcousticFrame(): AcousticLipSyncFrame {
  return {
    rawVowels: { A: 0, E: 0, I: 0, O: 0, U: 0, S: 0 },
    rawVolume: 0,
    dominantVowel: null,
    rmsEnergy: 0,
    zeroCrossingRate: 0,
  }
}

/**
 * Synthesizes a deterministic formant-rich PCM waveform for a canonical vowel ('A'|'E'|'I'|'O'|'U')
 * or high-frequency sibilant consonant ('S').
 */
export function synthesizeFormantVowelPcm(
  vowel: VowelKey | 'S',
  durationMs = 60,
  sampleRate = 16000,
): Float32Array {
  const safeRate =
    Number.isFinite(sampleRate) && sampleRate >= 4000 ? Math.floor(sampleRate) : 16000
  const safeDurationMs =
    Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 60
  const length = Math.max(1, Math.floor((safeRate * safeDurationMs) / 1000))
  const out = new Float32Array(length)

  if (vowel === 'S') {
    for (let i = 0; i < length; i++) {
      const t = i / safeRate
      const high1 = Math.sin(2 * Math.PI * 4300 * t)
      const high2 = Math.sin(2 * Math.PI * 5900 * t)
      const alternating = i % 2 === 0 ? 0.35 : -0.35
      out[i] = 0.35 * high1 + 0.35 * high2 + alternating
    }
    return out
  }

  const [f1, f2] = CANONICAL_FORMANT_PAIRS[vowel] ?? CANONICAL_FORMANT_PAIRS.A
  const f0 = 190
  for (let i = 0; i < length; i++) {
    const t = i / safeRate
    const glottal = 0.16 * Math.sin(2 * Math.PI * f0 * t)
    const formant1 = 0.44 * Math.sin(2 * Math.PI * f1 * t)
    const formant2 = 0.4 * Math.sin(2 * Math.PI * f2 * t)
    out[i] = glottal + formant1 + formant2
  }
  return out
}

function goertzelMagnitude(
  samples: Float32Array,
  count: number,
  targetFreqHz: number,
  sampleRate: number,
): number {
  if (count <= 0 || targetFreqHz <= 0 || targetFreqHz >= sampleRate * 0.5) {
    return 0
  }
  const omega = (2 * Math.PI * targetFreqHz) / sampleRate
  const coeff = 2 * Math.cos(omega)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < count; i++) {
    const x = samples[i] ?? 0
    const s0 = x + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  const power = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (count * count)
  return Math.sqrt(Math.max(0, power))
}

/**
 * Analyzes a raw PCM audio frame using RMS energy, Zero-Crossing Rate (ZCR), and Goertzel
 * formant magnitudes (Red-Team B4) to extract normalized vowel weights `{ A, E, I, O, U, S }`.
 */
export function analyzePcmFrameToVowels(
  samples: Float32Array,
  sampleRate = 16000,
): AcousticLipSyncFrame {
  if (!samples || samples.length === 0) {
    return createSilentAcousticFrame()
  }

  const safeRate =
    Number.isFinite(sampleRate) && sampleRate >= 4000 ? sampleRate : 16000
  const n = Math.min(samples.length, 1024)
  const clean = new Float32Array(n)

  let sumSq = 0
  let zeroCrossings = 0
  let prevSample = 0

  for (let i = 0; i < n; i++) {
    const raw = samples[i]!
    const s = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0
    clean[i] = s
    sumSq += s * s
    if (i > 0 && ((s >= 0 && prevSample < 0) || (s < 0 && prevSample >= 0))) {
      zeroCrossings++
    }
    prevSample = s
  }

  const rmsEnergy = Math.sqrt(sumSq / n)
  const zeroCrossingRate = n > 1 ? zeroCrossings / (n - 1) : 0

  if (!Number.isFinite(rmsEnergy) || rmsEnergy < 0.008) {
    return createSilentAcousticFrame()
  }

  const rawVolume = clampUnit(rmsEnergy * 2.2)

  // Compute Goertzel magnitudes at canonical F1/F2 formant frequencies
  const rawScores: Record<VowelKey, number> = {
    A: 0,
    E: 0,
    I: 0,
    O: 0,
    U: 0,
  }

  let maxVowelScore = 0
  let dominantVowel: VowelKey = 'A'

  for (const key of VOWEL_KEYS) {
    const [f1, f2] = CANONICAL_FORMANT_PAIRS[key]
    const m1 = goertzelMagnitude(clean, n, f1, safeRate)
    const m2 = goertzelMagnitude(clean, n, f2, safeRate)
    // Product strongly rewards simultaneous presence of both F1 and F2 formants
    const score = m1 * m2 * 12 + Math.min(m1, m2) * 0.45 + (m1 + m2) * 0.04
    rawScores[key] = score
    if (score > maxVowelScore) {
      maxVowelScore = score
      dominantVowel = key
    }
  }

  const sibilantMag =
    goertzelMagnitude(clean, n, 4300, safeRate) +
    goertzelMagnitude(clean, n, 5900, safeRate)
  const sWeight =
    zeroCrossingRate > 0.22
      ? clampUnit((zeroCrossingRate / 0.35) * 0.65 + clampUnit(sibilantMag * 2.5) * 0.45)
      : clampUnit(sibilantMag * 1.2)

  const normDenom = maxVowelScore > 1e-6 ? maxVowelScore : 1
  const vowelAttenuation = zeroCrossingRate > 0.3 ? 0.35 : 1.0

  const rawVowels: Record<VowelKey | 'S', number> = {
    A: clampUnit((rawScores.A / normDenom) * 0.92 * vowelAttenuation),
    E: clampUnit((rawScores.E / normDenom) * 0.92 * vowelAttenuation),
    I: clampUnit((rawScores.I / normDenom) * 0.92 * vowelAttenuation),
    O: clampUnit((rawScores.O / normDenom) * 0.92 * vowelAttenuation),
    U: clampUnit((rawScores.U / normDenom) * 0.92 * vowelAttenuation),
    S: sWeight,
  }

  return {
    rawVowels,
    rawVolume,
    dominantVowel: rawVolume > 0.04 ? dominantVowel : null,
    rmsEnergy,
    zeroCrossingRate,
  }
}

/**
 * Synchronizes acoustic vowel frames and `<|ACT|>` emotion/motion keyframes along a TTS audio
 * playback clock (`playbackTimeMs`).
 */
export function createStageSpeechSynchronizer(
  input: StageSpeechSynchronizerInput,
): StageSpeechSynchronizer {
  const sampleRate =
    Number.isFinite(input.sampleRate) && input.sampleRate! >= 4000
      ? Math.floor(input.sampleRate!)
      : 16000
  const frameDurationMs =
    Number.isFinite(input.frameDurationMs) && input.frameDurationMs! >= 5
      ? input.frameDurationMs!
      : 20

  const samples = input.samples ?? new Float32Array(0)
  const durationMs = samples.length > 0 ? (samples.length / sampleRate) * 1000 : 0
  const samplesPerFrame = Math.max(1, Math.floor((sampleRate * frameDurationMs) / 1000))
  const frameCount = Math.max(1, Math.ceil(samples.length / samplesPerFrame))

  const sortedKeyframes = [...(input.actKeyframes ?? [])]
    .filter((k) => Number.isFinite(k.atMs))
    .sort((a, b) => a.atMs - b.atMs)

  const initialEmotion: AshyEmotion =
    input.initialEmotion && ASHY_EMOTIONS.includes(input.initialEmotion)
      ? input.initialEmotion
      : 'neutral'
  const initialIntensity = clampUnit(input.initialIntensity ?? 0.85)
  const initialMotion: AshyMotionPreset =
    input.initialMotion && ASHY_MOTION_PRESETS.includes(input.initialMotion)
      ? input.initialMotion
      : 'idle'

  const driver = createWinnerRunnerUpVowelDriver({
    attackSpeed: 65,
    releaseSpeed: 45,
  })
  const dtSeconds = frameDurationMs / 1000

  const acousticFrames: AcousticLipSyncFrame[] = []
  const driverFrames: VowelDriverFrame[] = []

  for (let i = 0; i < frameCount; i++) {
    const start = i * samplesPerFrame
    const end = Math.min(samples.length, start + samplesPerFrame)
    const slice = samples.subarray(start, end)
    const acoustic = analyzePcmFrameToVowels(slice, sampleRate)
    const dFrame = driver.step({
      rawVowels: acoustic.rawVowels,
      rawVolume: acoustic.rawVolume,
      sibilantS: acoustic.rawVowels.S,
      dtSeconds,
    })
    acousticFrames.push(acoustic)
    driverFrames.push(dFrame)
  }

  const silentAcoustic = createSilentAcousticFrame()
  driver.reset()
  const silentDriverFrame = driver.getState()

  return {
    durationMs,
    frameCount,
    sampleAt(playbackTimeMs: number): StageSpeechTimelineSample {
      const safeMs = Number.isFinite(playbackTimeMs) ? Math.max(0, playbackTimeMs) : 0

      let emotion = initialEmotion
      let emotionIntensity = initialIntensity
      let motion = initialMotion

      for (const kf of sortedKeyframes) {
        if (kf.atMs <= safeMs) {
          if (kf.emotion && ASHY_EMOTIONS.includes(kf.emotion)) {
            emotion = kf.emotion
          }
          if (kf.intensity !== undefined && Number.isFinite(kf.intensity)) {
            emotionIntensity = clampUnit(kf.intensity)
          }
          if (kf.motion && ASHY_MOTION_PRESETS.includes(kf.motion)) {
            motion = kf.motion
          }
        } else {
          break
        }
      }

      if (durationMs <= 0 || safeMs >= durationMs) {
        return {
          playbackTimeMs: safeMs,
          isSpeaking: false,
          emotion,
          emotionIntensity,
          motion,
          acoustic: silentAcoustic,
          driverFrame: silentDriverFrame,
        }
      }

      const idx = Math.min(
        frameCount - 1,
        Math.max(0, Math.floor(safeMs / frameDurationMs)),
      )
      const acoustic = acousticFrames[idx] ?? silentAcoustic
      const driverFrame = driverFrames[idx] ?? silentDriverFrame

      return {
        playbackTimeMs: safeMs,
        isSpeaking: acoustic.rawVolume > 0.03,
        emotion,
        emotionIntensity,
        motion,
        acoustic,
        driverFrame,
      }
    },
  }
}
