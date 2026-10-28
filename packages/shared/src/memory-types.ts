import * as v from 'valibot'

const NonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty())

const TimestampSchema = v.pipe(
  v.number(),
  v.check((n) => Number.isFinite(n) && n >= 0, 'Timestamp must be a finite non-negative number'),
)

const UnitIntervalSchema = v.pipe(
  v.number(),
  v.check((n) => Number.isFinite(n), 'Must be a finite number'),
  v.minValue(0),
  v.maxValue(1),
)

const PositiveFiniteNumberSchema = v.pipe(
  v.number(),
  v.check((n) => Number.isFinite(n) && n > 0, 'Must be a finite positive number'),
)

const NonNegativeFiniteNumberSchema = v.pipe(
  v.number(),
  v.check((n) => Number.isFinite(n) && n >= 0, 'Must be a finite non-negative number'),
)

const NonNegativeIntSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
)

const FiniteNumberSchema = v.pipe(
  v.number(),
  v.check((n) => Number.isFinite(n), 'Embedding element must be a finite number'),
)

// 1. EpisodicMemory
export const EpisodicMemorySchema = v.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  summary: v.string(),
  content: v.string(),
  createdAt: TimestampSchema,
  lastReviewedAt: TimestampSchema,
  stability: PositiveFiniteNumberSchema,
  difficulty: v.pipe(
    v.number(),
    v.check((n) => Number.isFinite(n), 'Difficulty must be a finite number'),
    v.minValue(0),
    v.maxValue(10),
  ),
  surprise: UnitIntervalSchema,
  isFlashbulb: v.boolean(),
  tags: v.array(NonEmptyStringSchema),
  embedding: v.optional(v.array(FiniteNumberSchema)),
})

export type EpisodicMemory = v.InferOutput<typeof EpisodicMemorySchema>

// 2. SemanticFact
export const SEMANTIC_FACT_CATEGORIES = [
  'identity',
  'preference',
  'interest',
  'personality',
  'relationship',
  'experience',
  'goal',
  'guideline',
] as const

export type SemanticFactCategory = (typeof SEMANTIC_FACT_CATEGORIES)[number]
export const SemanticFactCategorySchema = v.picklist(SEMANTIC_FACT_CATEGORIES)

export const SemanticFactSchema = v.object({
  id: NonEmptyStringSchema,
  category: SemanticFactCategorySchema,
  subject: NonEmptyStringSchema,
  predicate: NonEmptyStringSchema,
  object: NonEmptyStringSchema,
  confidence: UnitIntervalSchema,
  sourceEpisodeIds: v.array(NonEmptyStringSchema),
  validFrom: TimestampSchema,
  invalidAt: v.optional(v.nullable(TimestampSchema)),
})

export type SemanticFact = v.InferOutput<typeof SemanticFactSchema>

// 3. RelationalMotif
export const RELATIONAL_MOTIF_STAGES = [
  'seed',
  'callback_candidate',
  'inside_joke',
  'legendary',
  'dormant',
] as const

export type RelationalMotifStage = (typeof RELATIONAL_MOTIF_STAGES)[number]
export const RelationalMotifStageSchema = v.picklist(RELATIONAL_MOTIF_STAGES)

export const RelationalMotifSchema = v.object({
  id: NonEmptyStringSchema,
  motif: NonEmptyStringSchema,
  originSummary: v.string(),
  originEpisodeId: v.optional(NonEmptyStringSchema),
  triggerCues: v.array(NonEmptyStringSchema),
  stage: RelationalMotifStageSchema,
  timesUsed: NonNegativeIntSchema,
  lastUsedAt: v.optional(v.nullable(TimestampSchema)),
  cooldownHours: NonNegativeFiniteNumberSchema,
  createdAt: TimestampSchema,
})

export type RelationalMotif = v.InferOutput<typeof RelationalMotifSchema>

// 4. AutobiographicalMilestone
export const MILESTONE_CATEGORIES = [
  'first_meeting',
  'inside_joke_born',
  'project_shipped',
  'late_night_debug',
  'trait_evolution',
  'flashbulb_moment',
] as const

export type MilestoneCategory = (typeof MILESTONE_CATEGORIES)[number]
export const MilestoneCategorySchema = v.picklist(MILESTONE_CATEGORIES)

export const AutobiographicalMilestoneSchema = v.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  narrative: NonEmptyStringSchema,
  category: MilestoneCategorySchema,
  episodeId: v.optional(NonEmptyStringSchema),
  roomTrophyId: v.optional(NonEmptyStringSchema),
  createdAt: TimestampSchema,
})

export type AutobiographicalMilestone = v.InferOutput<typeof AutobiographicalMilestoneSchema>

// 5. UserHabit
export const UserHabitSchema = v.object({
  id: NonEmptyStringSchema,
  patternKey: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  confidence: UnitIntervalSchema,
  observationCount: NonNegativeIntSchema,
  updatedAt: TimestampSchema,
})

export type UserHabit = v.InferOutput<typeof UserHabitSchema>

// 6. ProspectiveIntent
export const PROSPECTIVE_INTENT_STATUSES = [
  'pending',
  'triggered',
  'completed',
  'dismissed',
] as const

export type ProspectiveIntentStatus = (typeof PROSPECTIVE_INTENT_STATUSES)[number]
export const ProspectiveIntentStatusSchema = v.picklist(PROSPECTIVE_INTENT_STATUSES)

export const ProspectiveIntentSchema = v.object({
  id: NonEmptyStringSchema,
  topic: NonEmptyStringSchema,
  contextCue: v.string(),
  dueAt: v.optional(v.nullable(TimestampSchema)),
  status: ProspectiveIntentStatusSchema,
  createdAt: TimestampSchema,
})

export type ProspectiveIntent = v.InferOutput<typeof ProspectiveIntentSchema>
