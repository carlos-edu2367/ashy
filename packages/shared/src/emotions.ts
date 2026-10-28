import * as v from 'valibot'

export const ASHY_EMOTIONS = [
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
  'neutral',
] as const

export type AshyEmotion = (typeof ASHY_EMOTIONS)[number]

export const AshyEmotionEnum: Readonly<{ [K in AshyEmotion]: K }> = Object.freeze({
  happy: 'happy',
  excited: 'excited',
  smug: 'smug',
  tease: 'tease',
  chaotic: 'chaotic',
  curious: 'curious',
  think: 'think',
  surprised: 'surprised',
  awkward: 'awkward',
  concerned: 'concerned',
  sad: 'sad',
  angry: 'angry',
  neutral: 'neutral',
})

export const AshyEmotionSchema = v.picklist(ASHY_EMOTIONS)

const FiniteUnitIntervalSchema = v.pipe(
  v.number(),
  v.check((n) => Number.isFinite(n), 'Value must be a finite number'),
  v.minValue(0),
  v.maxValue(1),
)

const FiniteDurationSecSchema = v.pipe(
  v.number(),
  v.check((n) => Number.isFinite(n), 'Duration must be a finite number'),
  v.minValue(0),
  v.maxValue(60),
)

export const EmotionPayloadSchema = v.object({
  emotion: AshyEmotionSchema,
  intensity: FiniteUnitIntervalSchema,
  motion: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(64))),
  durationSec: v.optional(FiniteDurationSecSchema),
})

export type EmotionPayload = v.InferOutput<typeof EmotionPayloadSchema>

export interface AffectDelta {
  valence: number
  arousal: number
  playfulness: number
}

export const EMOTION_AFFECT_DELTA: Readonly<Record<AshyEmotion, Readonly<AffectDelta>>> =
  Object.freeze({
    happy: Object.freeze({ valence: 0.25, arousal: 0.15, playfulness: 0.15 }),
    excited: Object.freeze({ valence: 0.3, arousal: 0.35, playfulness: 0.25 }),
    smug: Object.freeze({ valence: 0.15, arousal: 0.2, playfulness: 0.35 }),
    tease: Object.freeze({ valence: 0.18, arousal: 0.25, playfulness: 0.4 }),
    chaotic: Object.freeze({ valence: 0.1, arousal: 0.4, playfulness: 0.45 }),
    curious: Object.freeze({ valence: 0.12, arousal: 0.18, playfulness: 0.1 }),
    think: Object.freeze({ valence: 0.02, arousal: -0.05, playfulness: -0.1 }),
    surprised: Object.freeze({ valence: 0.05, arousal: 0.35, playfulness: 0.05 }),
    awkward: Object.freeze({ valence: -0.08, arousal: 0.1, playfulness: -0.05 }),
    concerned: Object.freeze({ valence: -0.15, arousal: 0.05, playfulness: -0.35 }),
    sad: Object.freeze({ valence: -0.3, arousal: -0.25, playfulness: -0.4 }),
    angry: Object.freeze({ valence: -0.25, arousal: 0.35, playfulness: -0.2 }),
    neutral: Object.freeze({ valence: 0, arousal: 0, playfulness: 0 }),
  })

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function clampDuration(value: number): number {
  return Math.min(60, Math.max(0, value))
}

/**
 * Safely validates and clamps an emotion payload against malformed inputs.
 * - Valid emotions have their `intensity` clamped into `[0, 1]` (defaults to `0.75` if omitted)
 *   and `durationSec` clamped into `[0, 60]`.
 * - Also accepts nested `{ emotion: { name, intensity }, motion, durationSec }` payloads.
 * - Throws a descriptive error if `input` is not a plain object, `emotion` is unknown, or
 *   numeric fields are `NaN` / `Infinity` / non-numeric.
 */
export function validateEmotionPayload(input: unknown): EmotionPayload {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Invalid EmotionPayload: expected a non-null object')
  }

  const record = input as Record<string, unknown>

  let rawEmotion: unknown = record.emotion
  let rawIntensity: unknown = record.intensity

  if (typeof rawEmotion === 'object' && rawEmotion !== null && !Array.isArray(rawEmotion)) {
    const nested = rawEmotion as Record<string, unknown>
    rawEmotion = nested.name ?? nested.emotion
    if (rawIntensity === undefined && nested.intensity !== undefined) {
      rawIntensity = nested.intensity
    }
  }

  const emotionCheck = v.safeParse(AshyEmotionSchema, rawEmotion)
  if (!emotionCheck.success) {
    throw new Error(`Invalid AshyEmotion: ${String(rawEmotion)}`)
  }

  let intensity = 0.75
  if (rawIntensity !== undefined) {
    if (typeof rawIntensity !== 'number' || !Number.isFinite(rawIntensity)) {
      throw new TypeError('Invalid EmotionPayload intensity: must be a finite number')
    }
    intensity = clampUnit(rawIntensity)
  }

  const normalized: EmotionPayload = {
    emotion: emotionCheck.output,
    intensity,
  }

  if (record.motion !== undefined) {
    if (typeof record.motion !== 'string') {
      throw new TypeError('Invalid EmotionPayload motion: must be a string')
    }
    const sanitizedMotion = record.motion.replace(/[\u0000-\u001F<>]/g, '').trim()
    if (sanitizedMotion.length > 0) {
      normalized.motion = sanitizedMotion.slice(0, 64)
    }
  }

  if (record.durationSec !== undefined) {
    if (typeof record.durationSec !== 'number' || !Number.isFinite(record.durationSec)) {
      throw new TypeError('Invalid EmotionPayload durationSec: must be a finite number')
    }
    normalized.durationSec = clampDuration(record.durationSec)
  }

  return v.parse(EmotionPayloadSchema, normalized)
}

/**
 * Non-throwing companion to `validateEmotionPayload` returning `null` on invalid inputs.
 */
export function safeValidateEmotionPayload(input: unknown): EmotionPayload | null {
  try {
    return validateEmotionPayload(input)
  } catch {
    return null
  }
}
