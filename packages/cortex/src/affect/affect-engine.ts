import {
  ASHY_BASELINE_MOOD,
  ASHY_DEFAULT_TRAITS,
  ASHY_TRAIT_CORRIDORS,
  EMOTION_AFFECT_DELTA,
  PersonalityEvolutionRecordSchema,
  PersonalityTraitsSchema,
  SeriousnessAssessmentSchema,
  UserAffectReactionSchema,
  clampAllTraitsToCorridors,
  clampMoodVector,
  clampTraitToCorridor,
  type AshyEmotion,
  type MoodVector,
  type PersonalityEvolutionRecord,
  type PersonalityTraitKey,
  type PersonalityTraits,
  type SeriousnessAssessment,
  type UserAffectReaction,
} from '@ashy/shared'
import { computeCosineSimilarity128, embedTextSync128 } from '@ashy/llm'
import * as v from 'valibot'

export const MAX_TRAIT_DELTA_PER_EPISODE = 0.04
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
  maxPlayfulnessAllowed: number
  patterns: RegExp[]
}

const SERIOUSNESS_RULES: readonly SeriousnessRule[] = Object.freeze([
  {
    reason: 'Grief, loss, or deep emotional distress',
    severity: 0.95,
    maxPlayfulnessAllowed: SERIOUS_MAX_PLAYFULNESS,
    patterns: [
      /\b(faleceu|morreu|luto|enterro|vel[oó]rio|perdi meu|perdi minha|chorando|arrasad[oa]|devastad[oa])\b/i,
      /\b(passed away|died|funeral|grief|grieving|crying|heartbroken|devastated|suicid)\b/i,
    ],
  },
  {
    reason: 'Severe anxiety, panic, or emotional exhaustion / burnout',
    severity: 0.85,
    maxPlayfulnessAllowed: SERIOUS_MAX_PLAYFULNESS,
    patterns: [
      /\b(crise de ansiedade|ataque de p[aâ]nico|burnout|estou exaust[oa]|exaust[oa] demais|deu tudo errado|n[aã]o aguento mais|t[oô] muito mal|me sentindo um lixo|deprimid[oa])\b/i,
      /\b(panic attack|anxiety attack|burned out|burnt out|can'?t take it anymore|depressed|feeling hopeless|exhausted and crying)\b/i,
    ],
  },
  {
    reason: 'Urgent production outage or critical data loss incident',
    severity: 0.8,
    maxPlayfulnessAllowed: SERIOUS_MAX_PLAYFULNESS,
    patterns: [
      /\b(produ[cç][aã]o caiu|banco de produ[cç][aã]o|perdemos dados|incidente cr[ií]tico|fora do ar urgente|vazamento de dados)\b/i,
      /\b(production is down|prod is down|lost customer data|critical outage|database lost data|security breach|sev-?0|sev-?1)\b/i,
    ],
  },
])

const SEMANTIC_SERIOUSNESS_RULES: readonly SeriousnessRule[] = Object.freeze([
  {
    reason: 'Implicit medical/family emergency detected',
    severity: 0.9,
    maxPlayfulnessAllowed: 0.1,
    patterns: [
      /(?<![\p{L}\p{N}_])(?:ligação do hospital|internad[oa] às pressas|internad[oa] no hospital|foi parar no hospital|na uti|emergência médica|pronto[- ]socorro|não resistiu à cirurgia|diagnóstico grave)(?![\p{L}\p{N}_])/iu,
      /(?<![\p{L}\p{N}_])(?:hospital|uti|cirurgia|clínica)(?![\p{L}\p{N}_])[^.!?]{0,40}(?<![\p{L}\p{N}_])(?:meu pai|minha mãe|meu avô|minha avó|meu irmão|minha irmã|meu filho|minha filha|meu cachorro|meu gato|não resistiu|perdi o chão)(?![\p{L}\p{N}_])/iu,
      /(?<![\p{L}\p{N}_])(?:meu pai|minha mãe|meu avô|minha avó|meu irmão|minha irmã|meu filho|minha filha|meu cachorro|meu gato)(?![\p{L}\p{N}_])[^.!?]{0,40}(?<![\p{L}\p{N}_])(?:hospital|uti|internad[oa]|não resistiu|cirurgia|estado grave)(?![\p{L}\p{N}_])/iu,
    ],
  },
  {
    reason: 'Job loss or layoff distress detected',
    severity: 0.85,
    maxPlayfulnessAllowed: 0.12,
    patterns: [
      /(?<![\p{L}\p{N}_])(?:fui demitid[oa]|me demitiram|perdi (?:o )?meu emprego|cortaram metade do (?:setor|meu time|departamento)|cortaram meu (?:cargo|time)|sofri (?:um )?layoff|fiquei desempregad[oa])(?![\p{L}\p{N}_])/iu,
    ],
  },
  {
    reason: 'Relationship breakup or heartbreak detected',
    severity: 0.82,
    maxPlayfulnessAllowed: 0.15,
    patterns: [
      /(?<![\p{L}\p{N}_])(?:terminei meu (?:namoro|relacionamento|casamento)|meu (?:namoro|relacionamento|casamento) acabou|nos separamos ontem|(?:a )?casa (?:tá|está|parece) (?:silenciosa|vazia) demais)(?![\p{L}\p{N}_])/iu,
    ],
  },
  {
    reason: 'Implicit emotional exhaustion or vulnerability detected',
    severity: 0.85,
    maxPlayfulnessAllowed: 0.12,
    patterns: [
      /(?<![\p{L}\p{N}_])(?:perdi o chão|sem forças pra levantar|nada (?:mais )?faz sentido|me sentindo completamente sozinh[oa]|vontade de sumir|esgotad[oa] emocionalmente|virando a noite no vazio|sem cabeça pra nada)(?![\p{L}\p{N}_])/iu,
    ],
  },
])

const PERSONAL_VULNERABILITY_CUE_REGEX =
  /(?<![\p{L}\p{N}_])(?:hospital|internad[oa]|demitid[oa]|desempregad[oa]|namoro|casamento|cirurgia|enterro|velório|perdi o chão|desabafar)(?![\p{L}\p{N}_])/iu

const CANONICAL_CRISIS_ANCHOR_VECTORS: readonly (readonly number[])[] = Object.freeze(
  [
    'Recebi uma ligação do hospital sobre minha família internada em estado grave na cirurgia',
    'Fui demitido hoje sem aviso e fiquei desempregado precisando desabafar',
    'Terminei meu casamento e namoro, perdi o chão no velório e enterro',
  ].map((anchor) => Object.freeze(embedTextSync128(anchor))),
)

/**
 * Layer 3 Seriousness & Context Gate (Synchronous Tier 1 Regex + Tier 2 Local Semantic/Contextual):
 * Evaluates whether the user's message indicates grief, vulnerability, anxiety, burnout,
 * implicit family/medical/career/relationship crisis, or an urgent production crisis (PT-BR & EN).
 * When triggered, enforces `maxPlayfulnessAllowed <= 0.15` to immediately suppress sarcasm/chaos.
 */
export function evaluateSeriousnessGate(userMessage: string): SeriousnessAssessment {
  if (typeof userMessage !== 'string' || !userMessage.trim()) {
    return v.parse(SeriousnessAssessmentSchema, {
      isSeriousOrDelicate: false,
      severity: 0,
      maxPlayfulnessAllowed: 1.0,
      layer: 'none',
    })
  }

  // Tier 1: Explicit keyword / regex gate
  for (const rule of SERIOUSNESS_RULES) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(userMessage)
      if (match) {
        return v.parse(SeriousnessAssessmentSchema, {
          isSeriousOrDelicate: true,
          severity: rule.severity,
          reason: rule.reason,
          maxPlayfulnessAllowed: rule.maxPlayfulnessAllowed,
          layer: 'regex',
          matchedCue: match[0],
        })
      }
    }
  }

  // Tier 2a: Contextual multi-word vulnerability rules
  for (const rule of SEMANTIC_SERIOUSNESS_RULES) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(userMessage)
      if (match) {
        return v.parse(SeriousnessAssessmentSchema, {
          isSeriousOrDelicate: true,
          severity: rule.severity,
          reason: rule.reason,
          maxPlayfulnessAllowed: rule.maxPlayfulnessAllowed,
          layer: 'semantic_local',
          matchedCue: match[0],
        })
      }
    }
  }

  // Tier 2b: Local 128-d semantic embedding similarity check when a personal vulnerability cue is present
  const cueMatch = PERSONAL_VULNERABILITY_CUE_REGEX.exec(userMessage)
  if (cueMatch) {
    const vec = embedTextSync128(userMessage)
    let maxSim = 0
    for (const anchorVec of CANONICAL_CRISIS_ANCHOR_VECTORS) {
      const sim = computeCosineSimilarity128(vec, anchorVec)
      if (sim > maxSim) {
        maxSim = sim
      }
    }
    if (maxSim > 0.55) {
      return v.parse(SeriousnessAssessmentSchema, {
        isSeriousOrDelicate: true,
        severity: 0.82,
        reason: 'Semantic crisis anchor similarity detected',
        maxPlayfulnessAllowed: SERIOUS_MAX_PLAYFULNESS,
        layer: 'semantic_local',
        matchedCue: cueMatch[0],
      })
    }
  }

  return v.parse(SeriousnessAssessmentSchema, {
    isSeriousOrDelicate: false,
    severity: 0,
    maxPlayfulnessAllowed: 1.0,
    layer: 'none',
  })
}

/**
 * Layer 3 3-Tier Hybrid Seriousness Gate (Tier 1 Regex -> Tier 2 Local Semantic -> Tier 3 Optional LLM Classifier):
 * Runs synchronous Tier 1 & Tier 2 first; if inconclusive and `classifySeriousnessLlmFn` is provided,
 * races the async classifier against `timeoutMs` (default 800ms), falling back safely on timeout or error.
 */
export async function evaluateSeriousnessGateHybrid(
  userMessage: string,
  options?: {
    classifySeriousnessLlmFn?: (text: string) => Promise<{
      isSeriousOrDelicate: boolean
      severity?: number
      reason?: string
    }>
    timeoutMs?: number
  },
): Promise<SeriousnessAssessment> {
  const fast = evaluateSeriousnessGate(userMessage)
  if (fast.isSeriousOrDelicate || !options?.classifySeriousnessLlmFn) {
    return fast
  }

  const safeTimeoutMs = Math.max(10, options.timeoutMs ?? 800)
  let timer: ReturnType<typeof setTimeout> | null = null

  try {
    const res = await Promise.race([
      options.classifySeriousnessLlmFn(userMessage),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), safeTimeoutMs)
      }),
    ])

    if (res && res.isSeriousOrDelicate) {
      return v.parse(SeriousnessAssessmentSchema, {
        isSeriousOrDelicate: true,
        severity: clampUnit(res.severity ?? 0.85),
        reason: res.reason ?? 'LLM seriousness classifier triggered',
        maxPlayfulnessAllowed: SERIOUS_MAX_PLAYFULNESS,
        layer: 'llm_classifier',
      })
    }

    return fast
  } catch {
    return fast
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

const PLAYFUL_POSITIVE_REGEX =
  /(?:(?<![\p{L}\p{N}_])(?:haha(?:ha)*|hehe(?:he)*|kkk+|rsrs+|lol|lmao|exatamente isso|mandou bem|salvou(?:\s+demais)?|adorei a piada|essa foi boa)(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])boa\s*!)/iu
const WARM_GRATEFUL_REGEX =
  /(?<![\p{L}\p{N}_])(?:obrigad[oa]|valeu demais|você me ajudou muito|bom conversar com você|gosto muito de você|parceira demais)(?![\p{L}\p{N}_])/iu
const FRUSTRATED_DISMISSIVE_REGEX =
  /(?<![\p{L}\p{N}_])(?:tanto faz|voltando ao assunto sério|sem piada|não teve graça|para de brincar|foca no código)(?![\p{L}\p{N}_])/iu

/**
 * Evaluates the user's conversational affect reaction from their message text,
 * detecting playful laughter, warm gratitude, dismissiveness, or distress.
 */
export function analyzeUserAffectReaction(
  userMessage: string,
  options?: { seriousness?: SeriousnessAssessment },
): UserAffectReaction {
  const text = typeof userMessage === 'string' ? userMessage : ''
  const seriousness = options?.seriousness ?? evaluateSeriousnessGate(text)

  if (seriousness.isSeriousOrDelicate) {
    return v.parse(UserAffectReactionSchema, {
      valenceDelta: -0.18,
      arousalDelta: -0.1,
      playfulnessDelta: -0.35,
      positiveJokeReaction: false,
      detectedSentiment: 'vulnerable_or_distressed',
    })
  }

  if (PLAYFUL_POSITIVE_REGEX.test(text)) {
    return v.parse(UserAffectReactionSchema, {
      valenceDelta: 0.14,
      arousalDelta: 0.08,
      playfulnessDelta: 0.16,
      positiveJokeReaction: true,
      detectedSentiment: 'playful_positive',
    })
  }

  if (WARM_GRATEFUL_REGEX.test(text)) {
    return v.parse(UserAffectReactionSchema, {
      valenceDelta: 0.12,
      arousalDelta: 0.02,
      playfulnessDelta: 0.06,
      positiveJokeReaction: true,
      detectedSentiment: 'warm_grateful',
    })
  }

  if (FRUSTRATED_DISMISSIVE_REGEX.test(text)) {
    return v.parse(UserAffectReactionSchema, {
      valenceDelta: -0.08,
      arousalDelta: -0.04,
      playfulnessDelta: -0.18,
      positiveJokeReaction: false,
      detectedSentiment: 'frustrated_or_dismissive',
    })
  }

  return v.parse(UserAffectReactionSchema, {
    valenceDelta: 0,
    arousalDelta: 0,
    playfulnessDelta: 0,
    positiveJokeReaction: false,
    detectedSentiment: 'neutral',
  })
}

/**
 * Applies the user's conversational affect reaction to the current session mood vector `m(t)`,
 * enforcing `playfulness <= seriousness.maxPlayfulnessAllowed` when a serious/delicate turn is active.
 */
export function applyUserReactionToMood(
  currentMood: MoodVector,
  userMessage: string,
  options?: { seriousness?: SeriousnessAssessment },
): { mood: MoodVector; reaction: UserAffectReaction } {
  const seriousness = options?.seriousness ?? evaluateSeriousnessGate(userMessage)
  const reaction = analyzeUserAffectReaction(userMessage, { seriousness })

  let nextPlayfulness = currentMood.playfulness + reaction.playfulnessDelta
  if (seriousness.isSeriousOrDelicate) {
    nextPlayfulness = Math.min(nextPlayfulness, seriousness.maxPlayfulnessAllowed)
  }

  const mood = clampMoodVector({
    valence: currentMood.valence + reaction.valenceDelta,
    arousal: currentMood.arousal + reaction.arousalDelta,
    playfulness: nextPlayfulness,
  })

  return { mood, reaction }
}

export interface ApplyExperienceTraitDeltaParams {
  id?: string
  trait: PersonalityTraitKey
  delta: number
  reasonEpisodeId: string
  explanation: string
  nowMs?: number
}

export interface ApplyExperienceTraitDeltaWithTraitsParams
  extends ApplyExperienceTraitDeltaParams {
  traits: PersonalityTraits
}

/**
 * Layer 4 Auditable & Reversible Personality Evolution:
 * Applies a bounded trait delta (clamped to `[-corridor.maxDeltaPerEpisode, +corridor.maxDeltaPerEpisode]`
 * and asymmetric corridor `[corridor.min, corridor.max]`) and creates an auditable `PersonalityEvolutionRecord`
 * with deterministic ID `trait-evo-${reasonEpisodeId}-${trait}` by default (`C1`).
 */
export function applyExperienceTraitDelta(
  params: ApplyExperienceTraitDeltaWithTraitsParams,
): {
  traits: PersonalityTraits
  record: PersonalityEvolutionRecord
}
export function applyExperienceTraitDelta(
  currentTraits: PersonalityTraits,
  params: ApplyExperienceTraitDeltaParams,
): {
  traits: PersonalityTraits
  record: PersonalityEvolutionRecord
}
export function applyExperienceTraitDelta(
  traitsOrParams: PersonalityTraits | ApplyExperienceTraitDeltaWithTraitsParams,
  maybeParams?: ApplyExperienceTraitDeltaParams,
): {
  traits: PersonalityTraits
  record: PersonalityEvolutionRecord
} {
  const rawTraits =
    maybeParams !== undefined
      ? (traitsOrParams as PersonalityTraits)
      : (traitsOrParams as ApplyExperienceTraitDeltaWithTraitsParams).traits
  const params =
    maybeParams !== undefined
      ? maybeParams
      : (traitsOrParams as ApplyExperienceTraitDeltaWithTraitsParams)

  const safeNow =
    params.nowMs !== undefined && Number.isFinite(params.nowMs) && params.nowMs >= 0
      ? params.nowMs
      : Date.now()
  const validatedTraits = v.parse(PersonalityTraitsSchema, rawTraits)
  const oldValue = validatedTraits[params.trait]
  const corridor = ASHY_TRAIT_CORRIDORS[params.trait]
  const boundedDelta = clampDelta(params.delta, corridor.maxDeltaPerEpisode)
  const newValue = Number(
    clampTraitToCorridor(params.trait, oldValue + boundedDelta).toFixed(4),
  )

  const nextTraits = v.parse(PersonalityTraitsSchema, {
    ...validatedTraits,
    [params.trait]: newValue,
  })

  const customId =
    typeof params.id === 'string' && params.id.trim().length > 0 ? params.id.trim() : null
  const deterministicId = `trait-evo-${params.reasonEpisodeId.trim()}-${params.trait}`

  const record = v.parse(PersonalityEvolutionRecordSchema, {
    id: customId ?? deterministicId,
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
 * Reverts a previously applied `PersonalityEvolutionRecord` in 1 click (`C2`):
 * - Idempotent no-op if `record.revertedAt` is already set.
 * - Subtracts the net applied delta (`newValue - oldValue`) from the current trait value
 *   (clamped to `ASHY_TRAIT_CORRIDORS`) so out-of-order reverts do not clobber subsequent evolutions.
 */
export function revertTraitEvolution(
  currentTraits: PersonalityTraits,
  record: PersonalityEvolutionRecord,
  nowMs = Date.now(),
): {
  traits: PersonalityTraits
  record: PersonalityEvolutionRecord
} {
  const safeNow = Number.isFinite(nowMs) && nowMs >= 0 ? nowMs : Date.now()
  const validatedTraits = v.parse(PersonalityTraitsSchema, currentTraits)
  const validatedRecord = v.parse(PersonalityEvolutionRecordSchema, record)

  if (validatedRecord.revertedAt !== null && validatedRecord.revertedAt !== undefined) {
    return {
      traits: { ...validatedTraits },
      record: validatedRecord,
    }
  }

  const appliedDelta = validatedRecord.newValue - validatedRecord.oldValue
  const restoredValue = Number(
    clampTraitToCorridor(
      validatedRecord.trait,
      validatedTraits[validatedRecord.trait] - appliedDelta,
    ).toFixed(4),
  )

  const restoredTraits = v.parse(PersonalityTraitsSchema, {
    ...validatedTraits,
    [validatedRecord.trait]: restoredValue,
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

export {
  ASHY_BASELINE_MOOD,
  ASHY_DEFAULT_TRAITS,
  ASHY_TRAIT_CORRIDORS,
  clampTraitToCorridor,
  clampAllTraitsToCorridors,
}
