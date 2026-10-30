import { computeCosineSimilarity128, embedTextSync128 } from '@ashy/llm'
import {
  RelationalMotifSchema,
  type RelationalMotif,
  type RelationalMotifStage,
} from '@ashy/shared'
import * as v from 'valibot'
import { tokenizeForSearch } from '../memory/fsrs-ranker'

const HOUR_MS = 3_600_000
export const DEFAULT_BASE_COOLDOWN_HOURS = 24
export const MAX_COOLDOWN_HOURS = 336

export interface EligibleMotifMatch {
  motif: RelationalMotif
  relevanceScore: number
  matchedCues: string[]
  cooldownLocked: false
}

export interface MotifCooldownStatus {
  isCooldownLocked: boolean
  elapsedHoursSinceUse: number | null
  remainingCooldownHours: number
}

export interface MotifSelectionOptions {
  isSeriousContext?: boolean
  minRelevance?: number
  queryEmbedding?: readonly number[]
}

function normalizeText(text: string): string {
  if (typeof text !== 'string') return ''
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

export function inspectMotifCooldownStatus(
  motif: Pick<RelationalMotif, 'lastUsedAt' | 'cooldownHours'>,
  nowMs: number,
): MotifCooldownStatus {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now()
  const cooldownHours = Math.max(0, Number.isFinite(motif.cooldownHours) ? motif.cooldownHours : 0)

  if (motif.lastUsedAt === null || motif.lastUsedAt === undefined) {
    return {
      isCooldownLocked: false,
      elapsedHoursSinceUse: null,
      remainingCooldownHours: 0,
    }
  }

  const elapsedHours = Math.max(0, (safeNow - motif.lastUsedAt) / HOUR_MS)
  const isCooldownLocked = elapsedHours < cooldownHours
  return {
    isCooldownLocked,
    elapsedHoursSinceUse: elapsedHours,
    remainingCooldownHours: isCooldownLocked ? cooldownHours - elapsedHours : 0,
  }
}

export function computeMotifRelevance(
  motif: Pick<RelationalMotif, 'motif' | 'triggerCues'> & {
    originSummary?: string
    embedding?: readonly number[]
  },
  contextText: string,
  queryEmbedding?: readonly number[],
): { relevanceScore: number; matchedCues: string[] } {
  const normalizedContext = normalizeText(contextText)
  if (!normalizedContext.trim()) {
    return { relevanceScore: 0, matchedCues: [] }
  }

  const contextTokens = new Set(tokenizeForSearch(contextText))
  const matchedCues: string[] = []
  let score = 0

  for (const rawCue of motif.triggerCues) {
    const normalizedCue = normalizeText(rawCue).trim()
    if (!normalizedCue) continue

    if (normalizedContext.includes(normalizedCue)) {
      matchedCues.push(rawCue)
      score += 0.45
      continue
    }

    const cueTokens = tokenizeForSearch(rawCue)
    if (cueTokens.length > 0) {
      const hits = cueTokens.filter((t) => contextTokens.has(t)).length
      if (hits > 0) {
        matchedCues.push(rawCue)
        score += 0.25 * (hits / cueTokens.length)
      }
    }
  }

  // Also check lexical overlap with motif.motif description
  const motifTokens = tokenizeForSearch(motif.motif).filter((t) => t.length >= 4)
  if (motifTokens.length > 0) {
    const motifHits = motifTokens.filter((t) => contextTokens.has(t)).length
    score += 0.3 * (motifHits / motifTokens.length)
  }

  const lexicalScore = Math.min(1, score)

  const contextVec =
    queryEmbedding && queryEmbedding.length > 0
      ? queryEmbedding
      : embedTextSync128(contextText)

  const motifDoc = [motif.motif, motif.originSummary ?? '', ...motif.triggerCues].join(' ')
  const motifVec =
    motif.embedding && motif.embedding.length > 0
      ? motif.embedding
      : embedTextSync128(motifDoc)

  const semanticSim =
    contextVec.length === motifVec.length
      ? computeCosineSimilarity128(contextVec, motifVec)
      : computeCosineSimilarity128(embedTextSync128(contextText), embedTextSync128(motifDoc))
  const combined = Math.min(
    1,
    Math.max(
      lexicalScore,
      semanticSim >= 0.22 ? 0.85 * semanticSim + 0.25 * lexicalScore : lexicalScore,
    ),
  )

  if (semanticSim >= 0.22 && matchedCues.length === 0) {
    matchedCues.push('semantic_context_match')
  }

  return {
    relevanceScore: Number(combined.toFixed(4)),
    matchedCues,
  }
}

/**
 * Selects eligible inside jokes (`RelationalMotif`s) for the current turn:
 * 1. Immediately returns `[]` if `options?.isSeriousContext === true` (Seriousness Gate protection).
 * 2. Blocks any motif that is currently under `CooldownLock` (`(nowMs - lastUsedAt) / 3_600_000 < cooldownHours`).
 * 3. Scores lexical/cue relevance against `contextText` and returns matching motifs sorted by relevance.
 */
export function selectEligibleMotifs(
  motifs: readonly RelationalMotif[],
  contextText: string,
  nowMs: number,
  options?: MotifSelectionOptions,
): EligibleMotifMatch[] {
  if (options?.isSeriousContext === true) {
    return []
  }

  const minRelevance = options?.minRelevance ?? 0.2
  const precomputedQueryVec =
    options?.queryEmbedding && options.queryEmbedding.length > 0
      ? options.queryEmbedding
      : typeof contextText === 'string' && contextText.trim().length > 0
        ? embedTextSync128(contextText)
        : undefined
  const eligible: EligibleMotifMatch[] = []

  for (const motif of motifs) {
    if (motif.stage === 'dormant' || motif.approvalStatus === 'pending_review') {
      continue
    }

    const cooldown = inspectMotifCooldownStatus(motif, nowMs)
    if (cooldown.isCooldownLocked) {
      continue
    }

    const { relevanceScore, matchedCues } = computeMotifRelevance(
      motif,
      contextText,
      precomputedQueryVec,
    )
    if (relevanceScore >= minRelevance) {
      eligible.push({
        motif,
        relevanceScore,
        matchedCues,
        cooldownLocked: false,
      })
    }
  }

  eligible.sort((a, b) => b.relevanceScore - a.relevanceScore || b.motif.timesUsed - a.motif.timesUsed)
  return eligible
}

/**
 * Records an invocation of a `RelationalMotif`, advancing its lifecycle stage and
 * applying the Exponential Anti-Saturation Cooldown:
 * `cooldownHours = Math.min(336, Math.round(baseCooldownHours * (1.5 ** Math.min(6, timesUsed))))`
 */
export function recordMotifInvocation(
  motif: RelationalMotif,
  userReactedPositively: boolean,
  nowMs: number,
  baseCooldownHours = DEFAULT_BASE_COOLDOWN_HOURS,
): RelationalMotif {
  const safeNow = Number.isFinite(nowMs) && nowMs >= 0 ? nowMs : Date.now()
  const timesUsed = motif.timesUsed + 1

  let nextStage: RelationalMotifStage = motif.stage
  if (userReactedPositively) {
    if (timesUsed >= 5) {
      nextStage = 'legendary'
    } else if (motif.stage === 'seed' || motif.stage === 'callback_candidate') {
      nextStage = 'inside_joke'
    }
  } else if (motif.stage === 'seed') {
    nextStage = 'dormant'
  }

  const safeBaseCooldown =
    Number.isFinite(baseCooldownHours) && baseCooldownHours > 0
      ? baseCooldownHours
      : DEFAULT_BASE_COOLDOWN_HOURS

  const cooldownHours = Math.min(
    MAX_COOLDOWN_HOURS,
    Math.round(safeBaseCooldown * Math.pow(1.5, Math.min(6, timesUsed))),
  )

  return v.parse(RelationalMotifSchema, {
    ...motif,
    stage: nextStage,
    timesUsed,
    lastUsedAt: safeNow,
    cooldownHours,
  })
}
