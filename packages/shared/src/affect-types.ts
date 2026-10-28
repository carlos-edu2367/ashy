import * as v from 'valibot'

const NonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty())

const TimestampSchema = v.pipe(
  v.number(),
  v.check((n) => Number.isFinite(n) && n >= 0, 'Timestamp must be a finite non-negative number'),
)

const BipolarIntervalSchema = v.pipe(
  v.number(),
  v.check((n) => Number.isFinite(n), 'Value must be a finite number'),
  v.minValue(-1),
  v.maxValue(1),
)

const UnitIntervalSchema = v.pipe(
  v.number(),
  v.check((n) => Number.isFinite(n), 'Value must be a finite number'),
  v.minValue(0),
  v.maxValue(1),
)

// Layer 2: Session Mood Vector m(t) = [Valence, Arousal, Playfulness] in [-1, 1]^3
export const MoodVectorSchema = v.object({
  valence: BipolarIntervalSchema,
  arousal: BipolarIntervalSchema,
  playfulness: BipolarIntervalSchema,
})

export type MoodVector = v.InferOutput<typeof MoodVectorSchema>

export const ASHY_BASELINE_MOOD: Readonly<MoodVector> = Object.freeze({
  valence: 0.35,
  arousal: 0.65,
  playfulness: 0.6,
})

function clampBipolar(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(-1, n))
}

export function clampMoodVector(mood: MoodVector): MoodVector {
  return {
    valence: clampBipolar(mood.valence),
    arousal: clampBipolar(mood.arousal),
    playfulness: clampBipolar(mood.playfulness),
  }
}

// Layer 4: Auditable & Reversible Personality Traits in [0, 1]
export const PERSONALITY_TRAIT_KEYS = [
  'witSarcasm',
  'chaosEnergy',
  'warmthAffection',
  'intellectualCuriosity',
  'proactivity',
] as const

export type PersonalityTraitKey = (typeof PERSONALITY_TRAIT_KEYS)[number]
export const PersonalityTraitKeySchema = v.picklist(PERSONALITY_TRAIT_KEYS)

export const PersonalityTraitsSchema = v.object({
  witSarcasm: UnitIntervalSchema,
  chaosEnergy: UnitIntervalSchema,
  warmthAffection: UnitIntervalSchema,
  intellectualCuriosity: UnitIntervalSchema,
  proactivity: UnitIntervalSchema,
})

export type PersonalityTraits = v.InferOutput<typeof PersonalityTraitsSchema>

export const ASHY_DEFAULT_TRAITS: Readonly<PersonalityTraits> = Object.freeze({
  witSarcasm: 0.78,
  chaosEnergy: 0.75,
  warmthAffection: 0.68,
  intellectualCuriosity: 0.85,
  proactivity: 0.65,
})

export const PersonalityEvolutionRecordSchema = v.object({
  id: NonEmptyStringSchema,
  trait: PersonalityTraitKeySchema,
  oldValue: UnitIntervalSchema,
  newValue: UnitIntervalSchema,
  reasonEpisodeId: NonEmptyStringSchema,
  explanation: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  revertedAt: v.optional(v.nullable(TimestampSchema)),
})

export type PersonalityEvolutionRecord = v.InferOutput<typeof PersonalityEvolutionRecordSchema>

// Layer 3: Seriousness & Context Gate
export const SeriousnessAssessmentSchema = v.object({
  isSeriousOrDelicate: v.boolean(),
  severity: UnitIntervalSchema,
  reason: v.optional(v.string()),
  maxPlayfulnessAllowed: BipolarIntervalSchema,
})

export type SeriousnessAssessment = v.InferOutput<typeof SeriousnessAssessmentSchema>
