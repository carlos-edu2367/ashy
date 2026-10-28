import {
  ASHY_BASELINE_MOOD,
  ASHY_DEFAULT_TRAITS,
  EMOTION_AFFECT_DELTA,
  PersonalityEvolutionRecordSchema,
  PersonalityTraitsSchema,
  SeriousnessAssessmentSchema,
  clampMoodVector,
  type AshyEmotion,
  type MoodVector,
  type PersonalityEvolutionRecord,
  type PersonalityTraitKey,
  type PersonalityTraits,
  type SeriousnessAssessment,
} from '@ashy/shared'
import * as v from 'valibot'

export const MAX_TRAIT_DELTA_PER_EPISODE = 0.08
export const SERIOUS_MAX_PLAYFULNESS = 0.15

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function clampDelta(delta: number, maxAbs = MAX_TRAIT_DELTA_PER_EPISODE): number {
  if (!Number.isFinite(delta)) return 0
  return Math.min(maxAbs, Math.max(-maxAbs, delta))
}

/**
 * Exponentially decays the session mood vector m(t) toward `ASHY_BASELINE_MOOD`
 * with configurable half-life in minutes (default 25 min).
 */
export function decayMoodToBaseline(
  currentMood: MoodVector,
  elapsedMinutes: number,
  halfLifeMinutes = 25,
  baseline: MoodVector = ASHY_BASELINE_MOOD,
): MoodVector {
  const safeElapsed = Math.max(0, Number.isFinite(elapsedMinutes) ? elapsedMinutes : 0)
  const safeHalfLife = Math.max(0.1, Number.isFinite(halfLifeMinutes) ? halfLifeMinutes : 25)
  const retention = Math.pow(0.5, safeElapsed / safeHalfLife)

  return clampMoodVector({
    valence: baseline.valence + (currentMood.valence - baseline.valence) * retention,
    arousal: baseline.arousal + (currentMood.arousal - baseline.arousal) * retention,
    playfulness:
      baseline.playfulness + (currentMood.playfulness - baseline.playfulness) * retention,
  })
}

/**
 * Applies an instant Layer-1 emotion pulse to the Layer-2 session mood vector
 * using `EMOTION_AFFECT_DELTA` from `@ashy/shared`.
 */
export function applyEmotionSignalToMood(
  currentMood: MoodVector,
  emotion: AshyEmotion,
  intensity = 0.8,
  options?: { seriousness?: SeriousnessAssessment },
): MoodVector {
  const delta = EMOTION_AFFECT_DELTA[emotion] ?? EMOTION_AFFECT_DELTA.neutral
  const weight = clampUnit(intensity)

  let nextPlayfulness = currentMood.playfulness + delta.playfulness * weight
  if (options?.seriousness?.isSeriousOrDelicate) {
    nextPlayfulness = Math.min(nextPlayfulness, options.seriousness.maxPlayfulnessAllowed)
  }

  return clampMoodVector({
    valence: currentMood.valence + delta.valence * weight,
    arousal: currentMood.arousal + delta.arousal * weight,
    playfulness: nextPlayfulness,
  })
}

interface SeriousnessRule {
  reason: string
  severity: number
  patterns: RegExp[]
}

const SERIOUSNESS_RULES: readonly SeriousnessRule[] = Object.freeze([
  {
    reason: 'Grief, loss, or deep emotional distress',
    severity: 0.95,
    patterns: [
      /\b(faleceu|morreu|luto|enterro|vel[oó]rio|perdi meu|perdi minha|chorando|arrasad[oa]|devastad[oa])\b/i,
      /\b(passed away|died|funeral|grief|grieving|crying|heartbroken|devastated|suicid)\b/i,
    ],
  },
  {
    reason: 'Severe anxiety, panic, or emotional exhaustion / burnout',
    severity: 0.85,
    patterns: [
      /\b(crise de ansiedade|ataque de p[aâ]nico|burnout|estou exaust[oa]|exaust[oa] demais|deu tudo errado|n[aã]o aguento mais|t[oô] muito mal|me sentindo um lixo|deprimid[oa])\b/i,
      /\b(panic attack|anxiety attack|burned out|burnt out|can'?t take it anymore|depressed|feeling hopeless|exhausted and crying)\b/i,
    ],
  },
  {
    reason: 'Urgent production outage or critical data loss incident',
    severity: 0.8,
    patterns: [
      /\b(produ[cç][aã]o caiu|banco de produ[cç][aã]o|perdemos dados|incidente cr[ií]tico|fora do ar urgente|vazamento de dados)\b/i,
      /\b(production is down|prod is down|lost customer data|critical outage|database lost data|security breach|sev-?0|sev-?1)\b/i,
    ],
  },
])

/**
 * Layer 3 Seriousness & Context Gate:
 * Evaluates whether the user's message indicates grief, vulnerability, anxiety, burnout,
 * or an urgent production crisis (supporting PT-BR and EN).
 * When triggered, enforces `maxPlayfulnessAllowed: 0.15` to immediately suppress sarcasm/chaos.
 */
export function evaluateSeriousnessGate(userMessage: string): SeriousnessAssessment {
  if (typeof userMessage !== 'string' || !userMessage.trim()) {
    return v.parse(SeriousnessAssessmentSchema, {
      isSeriousOrDelicate: false,
      severity: 0,
      maxPlayfulnessAllowed: 1.0,
    })
  }

  for (const rule of SERIOUSNESS_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(userMessage)) {
        return v.parse(SeriousnessAssessmentSchema, {
          isSeriousOrDelicate: true,
          severity: rule.severity,
          reason: rule.reason,
          maxPlayfulnessAllowed: SERIOUS_MAX_PLAYFULNESS,
        })
      }
    }
  }

  return v.parse(SeriousnessAssessmentSchema, {
    isSeriousOrDelicate: false,
    severity: 0,
    maxPlayfulnessAllowed: 1.0,
  })
}

/**
 * Layer 4 Auditable & Reversible Personality Evolution:
 * Applies a bounded trait delta (clamped to `[-0.08, +0.08]` per episode) and creates
 * an auditable `PersonalityEvolutionRecord`.
 */
export function applyExperienceTraitDelta(params: {
  traits: PersonalityTraits
  trait: PersonalityTraitKey
  delta: number
  reasonEpisodeId: string
  explanation: string
  nowMs?: number
  id?: string
}): {
  traits: PersonalityTraits
  record: PersonalityEvolutionRecord
} {
  const safeNow =
    params.nowMs !== undefined && Number.isFinite(params.nowMs) && params.nowMs >= 0
      ? params.nowMs
      : Date.now()
  const validatedTraits = v.parse(PersonalityTraitsSchema, params.traits)
  const oldValue = validatedTraits[params.trait]
  const boundedDelta = clampDelta(params.delta, MAX_TRAIT_DELTA_PER_EPISODE)
  const newValue = clampUnit(Number((oldValue + boundedDelta).toFixed(6)))

  const nextTraits = v.parse(PersonalityTraitsSchema, {
    ...validatedTraits,
    [params.trait]: newValue,
  })

  const record = v.parse(PersonalityEvolutionRecordSchema, {
    id: params.id ?? `trait-evo-${params.trait}-${safeNow}`,
    trait: params.trait,
    oldValue,
    newValue,
    reasonEpisodeId: params.reasonEpisodeId,
    explanation: params.explanation,
    createdAt: safeNow,
    revertedAt: null,
  })

  return {
    traits: nextTraits,
    record,
  }
}

/**
 * Reverts a previously applied `PersonalityEvolutionRecord` in 1 click,
 * restoring `oldValue` on the trait and stamping `revertedAt`.
 */
export function revertTraitEvolution(
  traits: PersonalityTraits,
  record: PersonalityEvolutionRecord,
  nowMs = Date.now(),
): {
  traits: PersonalityTraits
  record: PersonalityEvolutionRecord
} {
  const safeNow = Number.isFinite(nowMs) && nowMs >= 0 ? nowMs : Date.now()
  const validatedTraits = v.parse(PersonalityTraitsSchema, traits)
  const validatedRecord = v.parse(PersonalityEvolutionRecordSchema, record)

  const restoredTraits = v.parse(PersonalityTraitsSchema, {
    ...validatedTraits,
    [validatedRecord.trait]: validatedRecord.oldValue,
  })

  const updatedRecord = v.parse(PersonalityEvolutionRecordSchema, {
    ...validatedRecord,
    revertedAt: safeNow,
  })

  return {
    traits: restoredTraits,
    record: updatedRecord,
  }
}

export { ASHY_BASELINE_MOOD, ASHY_DEFAULT_TRAITS }
