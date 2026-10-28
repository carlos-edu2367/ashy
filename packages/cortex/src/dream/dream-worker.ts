import {
  AutobiographicalMilestoneSchema,
  RelationalMotifSchema,
  SemanticFactSchema,
  type AutobiographicalMilestone,
  type EpisodicMemory,
  type MilestoneCategory,
  type RelationalMotif,
  type SemanticFact,
  type SemanticFactCategory,
} from '@ashy/shared'
import * as v from 'valibot'
import { DEFAULT_BASE_COOLDOWN_HOURS } from '../relational/inside-joke-engine'

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
