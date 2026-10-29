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

export interface TraitCorridorSpec {
  readonly baseline: number
  readonly min: number
  readonly max: number
  readonly maxDeltaPerEpisode: number
}

export const ASHY_TRAIT_CORRIDORS: Readonly<
  Record<PersonalityTraitKey, TraitCorridorSpec>
> = Object.freeze({
  witSarcasm: Object.freeze({
    baseline: 0.78,
    min: 0.58,
    max: 0.92,
    maxDeltaPerEpisode: 0.04,
  }),
  chaosEnergy: Object.freeze({
    baseline: 0.75,
    min: 0.45,
    max: 0.9,
    maxDeltaPerEpisode: 0.04,
  }),
  warmthAffection: Object.freeze({
    baseline: 0.68,
    min: 0.52,
    max: 0.92,
    maxDeltaPerEpisode: 0.04,
  }),
  intellectualCuriosity: Object.freeze({
    baseline: 0.85,
    min: 0.68,
    max: 0.96,
    maxDeltaPerEpisode: 0.04,
  }),
  proactivity: Object.freeze({
    baseline: 0.65,
    min: 0.4,
    max: 0.88,
    maxDeltaPerEpisode: 0.04,
  }),
})

export function clampTraitToCorridor(
  trait: PersonalityTraitKey,
  value: number,
): number {
  const spec = ASHY_TRAIT_CORRIDORS[trait]
  if (!Number.isFinite(value)) return spec.baseline
  return Number(Math.min(spec.max, Math.max(spec.min, value)).toFixed(6))
}

export function clampAllTraitsToCorridors(
  traits: PersonalityTraits,
): PersonalityTraits {
  return {
    witSarcasm: clampTraitToCorridor('witSarcasm', traits.witSarcasm),
    chaosEnergy: clampTraitToCorridor('chaosEnergy', traits.chaosEnergy),
    warmthAffection: clampTraitToCorridor('warmthAffection', traits.warmthAffection),
    intellectualCuriosity: clampTraitToCorridor(
      'intellectualCuriosity',
      traits.intellectualCuriosity,
    ),
    proactivity: clampTraitToCorridor('proactivity', traits.proactivity),
  }
}

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
export const SeriousnessLayerSchema = v.picklist([
  'none',
  'regex',
  'semantic_local',
  'llm_classifier',
])
export type SeriousnessLayer = v.InferOutput<typeof SeriousnessLayerSchema>

export const SeriousnessAssessmentSchema = v.object({
  isSeriousOrDelicate: v.boolean(),
  severity: UnitIntervalSchema,
  reason: v.optional(v.string()),
  maxPlayfulnessAllowed: BipolarIntervalSchema,
  layer: v.optional(SeriousnessLayerSchema),
  matchedCue: v.optional(v.string()),
})

export type SeriousnessAssessment = v.InferOutput<typeof SeriousnessAssessmentSchema>

export const UserAffectReactionSchema = v.object({
  valenceDelta: BipolarIntervalSchema,
  arousalDelta: BipolarIntervalSchema,
  playfulnessDelta: BipolarIntervalSchema,
  positiveJokeReaction: v.boolean(),
  detectedSentiment: v.picklist([
    'playful_positive',
    'warm_grateful',
    'neutral',
    'frustrated_or_dismissive',
    'vulnerable_or_distressed',
  ]),
})
export type UserAffectReaction = v.InferOutput<typeof UserAffectReactionSchema>

export const CrossEpisodeLinkSchema = v.object({
  fromEpisodeId: NonEmptyStringSchema,
  toEpisodeId: NonEmptyStringSchema,
  sharedTheme: NonEmptyStringSchema,
  similarity: UnitIntervalSchema,
})
export type CrossEpisodeLink = v.InferOutput<typeof CrossEpisodeLinkSchema>

export const DreamReflectionCycleResultSchema = v.object({
  ranAt: TimestampSchema,
  consolidatedEpisodesCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  reviewedMemoriesCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  crossEpisodeLinks: v.array(CrossEpisodeLinkSchema),
  appliedEvolutions: v.array(PersonalityEvolutionRecordSchema),
  skippedReason: v.nullable(v.picklist(['no_new_episodes', 'already_reflected'])),
})
export type DreamReflectionCycleResult = v.InferOutput<
  typeof DreamReflectionCycleResultSchema
>
