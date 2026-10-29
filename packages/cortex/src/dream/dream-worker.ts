import { computeCosineSimilarity128, embedTextSync128 } from '@ashy/llm'
import {
  ASHY_TRAIT_CORRIDORS,
  AutobiographicalMilestoneSchema,
  CrossEpisodeLinkSchema,
  RelationalMotifSchema,
  SemanticFactSchema,
  type AutobiographicalMilestone,
  type CrossEpisodeLink,
  type DreamReflectionCycleResult,
  type EpisodicMemory,
  type MilestoneCategory,
  type PersonalityEvolutionRecord,
  type PersonalityTraitKey,
  type PersonalityTraits,
  type RelationalMotif,
  type SemanticFact,
  type SemanticFactCategory,
} from '@ashy/shared'
import * as v from 'valibot'
import { applyExperienceTraitDelta } from '../affect/affect-engine'
import { DEFAULT_BASE_COOLDOWN_HOURS } from '../relational/inside-joke-engine'

export { type CrossEpisodeLink, type DreamReflectionCycleResult, ASHY_TRAIT_CORRIDORS }

export interface CandidateSemanticFactInput {
  id?: string
  category: SemanticFactCategory
  subject: string
  predicate: string
  object: string
  confidence?: number
}

export interface CandidateRelationalMotifInput {
  id?: string
  motif: string
  triggerCues: string[]
  originSummary?: string
}

export type ConsolidationAction = 'new' | 'reinforce' | 'update'

export interface ConsolidationDecision {
  action: ConsolidationAction
  fact: SemanticFact
  invalidatedFactId?: string
}

export interface ConsolidationResult {
  decisions: ConsolidationDecision[]
  updatedFacts: SemanticFact[]
  updatedMotifs: RelationalMotif[]
  newMilestones: AutobiographicalMilestone[]
}

function normKey(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Predictive-Coding inspired Dream & Reflection Consolidation:
 * Compares candidate semantic facts against existing active facts:
 * - Same (category, subject, predicate) & same object -> `reinforce` (append episode.id, boost confidence)
 * - Same (category, subject, predicate) & different object -> `update` (mark old fact `invalidAt = nowMs`, create new fact)
 * - Unseen (category, subject, predicate) -> `new` (insert new fact)
 * Also extracts `AutobiographicalMilestone`s for *Our Story* (first meeting, inside joke born, flashbulb moment, etc.).
 */
export function runPredictCalibrateConsolidation(params: {
  episode: EpisodicMemory
  candidateFacts?: readonly CandidateSemanticFactInput[]
  candidateMotifs?: readonly CandidateRelationalMotifInput[]
  existingFacts: readonly SemanticFact[]
  existingMotifs: readonly RelationalMotif[]
  isFirstMeeting?: boolean
  nowMs?: number
}): ConsolidationResult {
  const safeNow =
    params.nowMs !== undefined && Number.isFinite(params.nowMs) && params.nowMs >= 0
      ? params.nowMs
      : params.episode.createdAt

  const factsById = new Map<string, SemanticFact>()
  for (const existing of params.existingFacts) {
    factsById.set(existing.id, {
      ...existing,
      sourceEpisodeIds: [...existing.sourceEpisodeIds],
    })
  }

  const decisions: ConsolidationDecision[] = []
  const candidates = params.candidateFacts ?? []

  candidates.forEach((cand, index) => {
    const activeMatch = Array.from(factsById.values()).find(
      (f) =>
        (f.invalidAt === null || f.invalidAt === undefined) &&
        normKey(f.category) === normKey(cand.category) &&
        normKey(f.subject) === normKey(cand.subject) &&
        normKey(f.predicate) === normKey(cand.predicate),
    )

    if (!activeMatch) {
      const created = v.parse(SemanticFactSchema, {
        id: cand.id ?? `fact-${params.episode.id}-${index + 1}`,
        category: cand.category,
        subject: cand.subject.trim(),
        predicate: cand.predicate.trim(),
        object: cand.object.trim(),
        confidence: cand.confidence ?? 0.85,
        sourceEpisodeIds: [params.episode.id],
        validFrom: safeNow,
        invalidAt: null,
      })
      factsById.set(created.id, created)
      decisions.push({ action: 'new', fact: created })
      return
    }

    if (normKey(activeMatch.object) === normKey(cand.object)) {
      const mergedEpisodeIds = Array.from(
        new Set([...activeMatch.sourceEpisodeIds, params.episode.id]),
      )
      const reinforced = v.parse(SemanticFactSchema, {
        ...activeMatch,
        confidence: Math.min(1, Number((activeMatch.confidence + 0.08).toFixed(4))),
        sourceEpisodeIds: mergedEpisodeIds,
      })
      factsById.set(reinforced.id, reinforced)
      decisions.push({ action: 'reinforce', fact: reinforced })
      return
    }

    // Contradiction / preference evolution -> invalidate old fact and create updated fact
    const invalidatedOld = v.parse(SemanticFactSchema, {
      ...activeMatch,
      invalidAt: safeNow,
    })
    factsById.set(invalidatedOld.id, invalidatedOld)

    const replacement = v.parse(SemanticFactSchema, {
      id: cand.id ?? `fact-${params.episode.id}-${index + 1}`,
      category: cand.category,
      subject: cand.subject.trim(),
      predicate: cand.predicate.trim(),
      object: cand.object.trim(),
      confidence: cand.confidence ?? 0.9,
      sourceEpisodeIds: [params.episode.id],
      validFrom: safeNow,
      invalidAt: null,
    })
    factsById.set(replacement.id, replacement)
    decisions.push({
      action: 'update',
      fact: replacement,
      invalidatedFactId: invalidatedOld.id,
    })
  })

  // Process candidate relational motifs
  const motifsById = new Map<string, RelationalMotif>()
  for (const m of params.existingMotifs) {
    motifsById.set(m.id, { ...m, triggerCues: [...m.triggerCues] })
  }

  let createdNewMotif = false
  const candidateMotifs = params.candidateMotifs ?? []
  candidateMotifs.forEach((cm, idx) => {
    const existingMotif = Array.from(motifsById.values()).find(
      (m) => normKey(m.motif) === normKey(cm.motif),
    )
    if (existingMotif) {
      const mergedCues = Array.from(new Set([...existingMotif.triggerCues, ...cm.triggerCues]))
      motifsById.set(
        existingMotif.id,
        v.parse(RelationalMotifSchema, {
          ...existingMotif,
          triggerCues: mergedCues,
        }),
      )
    } else {
      createdNewMotif = true
      const newMotif = v.parse(RelationalMotifSchema, {
        id: cm.id ?? `motif-${params.episode.id}-${idx + 1}`,
        motif: cm.motif.trim(),
        originSummary: cm.originSummary ?? params.episode.summary ?? params.episode.title,
        originEpisodeId: params.episode.id,
        triggerCues: cm.triggerCues.length > 0 ? cm.triggerCues : [cm.motif.trim()],
        stage: 'seed',
        timesUsed: 0,
        lastUsedAt: null,
        cooldownHours: DEFAULT_BASE_COOLDOWN_HOURS,
        createdAt: safeNow,
      })
      motifsById.set(newMotif.id, newMotif)
    }
  })

  // Extract Autobiographical Milestones for Our Story
  const newMilestones: AutobiographicalMilestone[] = []
  const milestoneCategories = new Set<MilestoneCategory>()

  if (params.isFirstMeeting || params.episode.tags.includes('first_meeting')) {
    milestoneCategories.add('first_meeting')
  }
  if (createdNewMotif || params.episode.tags.includes('inside_joke')) {
    milestoneCategories.add('inside_joke_born')
  }
  if (params.episode.isFlashbulb || params.episode.surprise >= 0.8) {
    milestoneCategories.add('flashbulb_moment')
  }
  if (params.episode.tags.includes('project_shipped')) {
    milestoneCategories.add('project_shipped')
  }
  if (params.episode.tags.includes('late_night_debug')) {
    milestoneCategories.add('late_night_debug')
  }

  const trophyByCategory: Record<MilestoneCategory, string> = {
    first_meeting: 'trophy-spark-crystal',
    inside_joke_born: 'trophy-rubber-duck',
    project_shipped: 'trophy-launch-rocket',
    late_night_debug: 'trophy-midnight-mug',
    trait_evolution: 'trophy-prism-heart',
    flashbulb_moment: 'trophy-polaroid-frame',
  }

  for (const category of milestoneCategories) {
    newMilestones.push(
      v.parse(AutobiographicalMilestoneSchema, {
        id: `milestone-${params.episode.id}-${category}`,
        title: params.episode.title,
        narrative: params.episode.summary || params.episode.content,
        category,
        episodeId: params.episode.id,
        roomTrophyId: trophyByCategory[category],
        createdAt: safeNow,
      }),
    )
  }

  return {
    decisions,
    updatedFacts: Array.from(factsById.values()),
    updatedMotifs: Array.from(motifsById.values()),
    newMilestones,
  }
}

const GENERIC_EPISODE_TAGS = new Set(['conversation', 'casual', 'general'])

/**
 * Returns `true` iff the episode is an approved, permanent conversational episode
 * (excluding synthetic `ep-dream-*` stubs, transient `ep-turn-*` drafts, and `pending_review` items).
 */
export function isReflectablePermanentEpisode(ep: EpisodicMemory): boolean {
  if (!ep || typeof ep.id !== 'string') return false
  return (
    !ep.id.startsWith('ep-dream-') &&
    !ep.id.startsWith('ep-turn-') &&
    ep.approvalStatus !== 'pending_review'
  )
}

function episodeCombinedText(ep: EpisodicMemory): string {
  return `${ep.title} ${ep.summary ?? ''} ${ep.content} ${(ep.tags ?? []).join(' ')}`
}

function getEpisodeVector128(ep: EpisodicMemory): readonly number[] {
  if (ep.embedding && ep.embedding.length === 128) {
    return ep.embedding
  }
  return embedTextSync128(episodeCombinedText(ep))
}

function inferSharedThemeFromTexts(textA: string, textB: string): string {
  const combined = `${textA} ${textB}`
  if (/\b(?:madrugada|noite|late_night)\b/i.test(combined)) {
    return 'late_night_coding'
  }
  if (/\b(?:apoio|acolhimento|desabafo|hospital|ansiedade|carinho)\b/i.test(combined)) {
    return 'emotional_support'
  }
  if (/\b(?:piada|fantasma|exorcista|padre|humor|inside_joke)\b/i.test(combined)) {
    return 'inside_joke'
  }
  if (/\b(?:arquitetura|typescript|sqlite|backend|debug|código)\b/i.test(combined)) {
    return 'architecture_debug'
  }
  return 'shared_studio_context'
}

/**
 * Compares pairs of approved permanent episodes by shared tags and 128-d cosine similarity,
 * returning the top thematic cross-episode links (`<= 10`).
 */
export function detectCrossEpisodeLinks(
  episodes: readonly EpisodicMemory[],
): CrossEpisodeLink[] {
  const reflectable = episodes.filter(isReflectablePermanentEpisode)
  if (reflectable.length < 2) return []

  const vectors = reflectable.map((ep) => getEpisodeVector128(ep))
  const texts = reflectable.map((ep) => episodeCombinedText(ep))
  const links: CrossEpisodeLink[] = []

  for (let i = 0; i < reflectable.length; i++) {
    const epA = reflectable[i]!
    const tagsA = (epA.tags ?? [])
      .map((t) => normKey(t))
      .filter((t) => t.length >= 2 && !GENERIC_EPISODE_TAGS.has(t))
    const tagSetA = new Set(tagsA)

    for (let j = i + 1; j < reflectable.length; j++) {
      const epB = reflectable[j]!
      const tagsB = (epB.tags ?? [])
        .map((t) => normKey(t))
        .filter((t) => t.length >= 2 && !GENERIC_EPISODE_TAGS.has(t))

      const sharedTag = tagsB.find((t) => tagSetA.has(t))
      const rawSim = computeCosineSimilarity128(vectors[i]!, vectors[j]!)
      const sim = Number.isFinite(rawSim) ? Math.max(0, Math.min(1, rawSim)) : 0

      if (sharedTag || sim >= 0.45) {
        const similarity = Number(
          Math.min(1, Math.max(sim, sharedTag ? 0.65 : sim)).toFixed(4),
        )
        const sharedTheme = sharedTag ?? inferSharedThemeFromTexts(texts[i]!, texts[j]!)
        links.push(
          v.parse(CrossEpisodeLinkSchema, {
            fromEpisodeId: epA.id,
            toEpisodeId: epB.id,
            sharedTheme,
            similarity,
          }),
        )
      }
    }
  }

  links.sort((a, b) => b.similarity - a.similarity)
  return links.slice(0, 10)
}

function computeCandidatePriority(ep: EpisodicMemory): number {
  let score = Number.isFinite(ep.surprise) ? ep.surprise : 0
  if (ep.isFlashbulb) score += 4
  const lowerTags = (ep.tags ?? []).map((t) => normKey(t))
  if (
    lowerTags.some((t) =>
      ['late_night', 'late_night_debug', 'emotional_support', 'inside_joke'].includes(t),
    )
  ) {
    score += 2
  }
  return score
}

function classifyEpisodeTraitDelta(ep: EpisodicMemory): {
  trait: PersonalityTraitKey
  delta: number
  explanation: string
} {
  const text = episodeCombinedText(ep)
  const lowerTags = new Set((ep.tags ?? []).map((t) => normKey(t)))
  const epEmotion = (ep as { emotion?: string }).emotion

  const hasExplicitInsideJoke =
    lowerTags.has('inside_joke') ||
    epEmotion === 'tease' ||
    epEmotion === 'smug' ||
    /\b(?:piada|fantasma|exorcista|padre|sarcasmo|humor|risada)\b/i.test(text)

  const hasEmpathyOrWarmth =
    ep.isFlashbulb ||
    lowerTags.has('emotional_support') ||
    epEmotion === 'warm' ||
    epEmotion === 'concerned' ||
    /\b(?:apoio|acolhimento|desabafo|cansaço|ansiedade|hospital|obrigad[oa]|carinho)\b/i.test(
      text,
    ) ||
    (!hasExplicitInsideJoke &&
      (lowerTags.has('late_night') ||
        lowerTags.has('late_night_debug') ||
        /\bmadrugada\b/i.test(text)))

  if (hasEmpathyOrWarmth) {
    return {
      trait: 'warmthAffection',
      delta: 0.03,
      explanation: `Reflexão sobre "${ep.title}": presença acolhedora fortaleceu o afeto.`,
    }
  }

  if (hasExplicitInsideJoke) {
    return {
      trait: 'witSarcasm',
      delta: 0.02,
      explanation: `Reflexão sobre "${ep.title}": sintonia de humor afiado e piada interna.`,
    }
  }

  if (
    ['architecture', 'typescript', 'debug', 'coding'].some((t) => lowerTags.has(t)) ||
    /\b(?:arquitetura|typescript|debug|código|sqlite|backend|refatoração)\b/i.test(text)
  ) {
    return {
      trait: 'intellectualCuriosity',
      delta: 0.02,
      explanation: `Reflexão sobre "${ep.title}": investigação técnica aprofundou a curiosidade.`,
    }
  }

  if (/\b(?:deploy|planejamento|roadmap|meta|próximo passo|amanhã)\b/i.test(text)) {
    return {
      trait: 'proactivity',
      delta: 0.02,
      explanation: `Reflexão sobre "${ep.title}": acompanhamento de metas reforçou a proatividade.`,
    }
  }

  return {
    trait: 'warmthAffection',
    delta: 0.02,
    explanation: `Reflexão sobre "${ep.title}": convivência contínua no estúdio.`,
  }
}

/**
 * Proposes grounded personality trait evolutions strictly from permanent, approved episodes
 * that have not yet been reflected in `existingLog`. Uses deterministic IDs
 * `trait-evo-${ep.id}-${trait}` (`C1`) and clamps values to `ASHY_TRAIT_CORRIDORS`.
 */
export function proposeGroundedTraitEvolutions(params: {
  episodes: readonly EpisodicMemory[]
  existingLog: readonly PersonalityEvolutionRecord[]
  currentTraits: PersonalityTraits
  nowMs?: number
  maxEvolutions?: number
}): {
  traits: PersonalityTraits
  records: PersonalityEvolutionRecord[]
  milestones: AutobiographicalMilestone[]
} {
  const safeNow =
    params.nowMs !== undefined && Number.isFinite(params.nowMs) && params.nowMs >= 0
      ? params.nowMs
      : Date.now()
  const maxEvolutions =
    params.maxEvolutions !== undefined &&
    Number.isFinite(params.maxEvolutions) &&
    params.maxEvolutions >= 0
      ? Math.floor(params.maxEvolutions)
      : 3

  const reflectedEpisodeIds = new Set(params.existingLog.map((r) => r.reasonEpisodeId))
  const candidates = params.episodes
    .filter((ep) => isReflectablePermanentEpisode(ep) && !reflectedEpisodeIds.has(ep.id))
    .slice()
    .sort(
      (a, b) =>
        computeCandidatePriority(b) - computeCandidatePriority(a) ||
        b.createdAt - a.createdAt,
    )

  let workingTraits: PersonalityTraits = { ...params.currentTraits }
  const records: PersonalityEvolutionRecord[] = []
  const milestones: AutobiographicalMilestone[] = []

  for (const ep of candidates) {
    if (records.length >= maxEvolutions) break

    const { trait, delta, explanation } = classifyEpisodeTraitDelta(ep)
    const { traits: nextTraits, record } = applyExperienceTraitDelta(workingTraits, {
      id: `trait-evo-${ep.id}-${trait}`,
      trait,
      delta,
      reasonEpisodeId: ep.id,
      explanation,
      nowMs: safeNow,
    })

    if (Math.abs(record.newValue - record.oldValue) > 1e-6) {
      workingTraits = nextTraits
      records.push(record)
      milestones.push(
        v.parse(AutobiographicalMilestoneSchema, {
          id: `ms-evo-${ep.id}-${trait}`,
          title: `Evolução de Personalidade: ${trait}`,
          narrative: explanation,
          category: 'trait_evolution',
          episodeId: ep.id,
          roomTrophyId: 'trophy-prism-heart',
          createdAt: safeNow,
        }),
      )
    }
  }

  return {
    traits: workingTraits,
    records,
    milestones,
  }
}
