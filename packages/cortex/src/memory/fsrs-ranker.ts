import { EpisodicMemorySchema, type EpisodicMemory } from '@ashy/shared'
import * as v from 'valibot'

const DAY_MS = 86_400_000
/**
 * Standard FSRS power-law constants such that at delta_t === S, R(S, S) = 0.90:
 * (1 + (19 / 81) * 1)^(-0.5) = (100 / 81)^(-0.5) = 9 / 10 = 0.90.
 */
export const FSRS_DEFAULT_FACTOR = 19 / 81
export const FSRS_DEFAULT_DECAY_POWER = 0.5
export const FLASHBULB_RETRIEVABILITY_FLOOR = 0.7
export const RRF_K = 30

export type FsrsReviewRating = 'again' | 'hard' | 'good' | 'easy'
export type SubjectiveClarity = 'vivid' | 'clear' | 'hazy' | 'faint'

export interface FsrsRetrievabilityResult {
  rawRetrievability: number
  effectiveRetrievability: number
  elapsedDays: number
  isFlashbulbProtected: boolean
}

export interface RankedEpisodicMemory {
  memory: EpisodicMemory
  bm25Rank: number
  vectorRank: number
  bm25Score: number
  vectorSimilarity: number
  rrfScore: number
  rawRetrievability: number
  effectiveRetrievability: number
  finalScore: number
  subjectiveClarity: SubjectiveClarity
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

export function classifySubjectiveClarity(retrievability: number): SubjectiveClarity {
  if (retrievability >= 0.75) return 'vivid'
  if (retrievability >= 0.5) return 'clear'
  if (retrievability >= 0.3) return 'hazy'
  return 'faint'
}

/**
 * Computes the FSRS-6 forgetting curve retrievability:
 * R(S, delta_t) = (1 + f * delta_t / S)^(-w20)
 * Applies the Emotional Flashbulb Floor (0.70) when `isFlashbulb === true` or `surprise >= 0.8`.
 */
export function computeFsrsRetrievability(
  memory: Pick<EpisodicMemory, 'stability' | 'lastReviewedAt' | 'isFlashbulb' | 'surprise'>,
  nowMs: number,
  options?: {
    factor?: number
    decayPower?: number
    applyFlashbulbFloor?: boolean
  },
): FsrsRetrievabilityResult {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now()
  const safeLastReviewed = Number.isFinite(memory.lastReviewedAt) ? memory.lastReviewedAt : safeNow
  const elapsedDays = Math.max(0, (safeNow - safeLastReviewed) / DAY_MS)
  const stability = Math.max(0.1, Number.isFinite(memory.stability) ? memory.stability : 1.0)

  const factor = options?.factor ?? FSRS_DEFAULT_FACTOR
  const decayPower = options?.decayPower ?? FSRS_DEFAULT_DECAY_POWER
  const applyFloor = options?.applyFlashbulbFloor ?? true

  const rawRetrievability = clamp(Math.pow(1 + (factor * elapsedDays) / stability, -decayPower), 0, 1)
  const isFlashbulbProtected = Boolean(
    applyFloor && (memory.isFlashbulb || (Number.isFinite(memory.surprise) && memory.surprise >= 0.8)),
  )
  const effectiveRetrievability = isFlashbulbProtected
    ? Math.max(FLASHBULB_RETRIEVABILITY_FLOOR, rawRetrievability)
    : rawRetrievability

  return {
    rawRetrievability,
    effectiveRetrievability,
    elapsedDays,
    isFlashbulbProtected,
  }
}

/**
 * Updates an episodic memory's synaptic stability, difficulty, and lastReviewedAt timestamp
 * according to the FSRS review rating ('again' | 'hard' | 'good' | 'easy').
 */
export function reviewEpisodicMemory(
  memory: EpisodicMemory,
  rating: FsrsReviewRating,
  nowMs: number,
): EpisodicMemory {
  const safeNow = Number.isFinite(nowMs) && nowMs >= 0 ? nowMs : Date.now()
  const currentStability = Math.max(0.1, Number.isFinite(memory.stability) ? memory.stability : 1.0)
  const currentDifficulty = clamp(Number.isFinite(memory.difficulty) ? memory.difficulty : 5.0, 0, 10)

  let nextStability = currentStability
  let nextDifficulty = currentDifficulty

  switch (rating) {
    case 'again':
      nextStability = Math.max(0.5, currentStability * 0.45)
      nextDifficulty = clamp(currentDifficulty + 0.8, 0, 10)
      break
    case 'hard':
      nextStability = Math.max(0.5, currentStability * 1.15)
      nextDifficulty = clamp(currentDifficulty + 0.25, 0, 10)
      break
    case 'good':
      nextStability = Math.max(0.5, currentStability * 2.1 + 0.5)
      nextDifficulty = clamp(currentDifficulty - 0.1, 0, 10)
      break
    case 'easy':
      nextStability = Math.max(0.5, currentStability * 3.2 + 1.5)
      nextDifficulty = clamp(currentDifficulty - 0.45, 0, 10)
      break
    default:
      throw new Error(`Invalid FsrsReviewRating: ${String(rating)}`)
  }

  return v.parse(EpisodicMemorySchema, {
    ...memory,
    stability: nextStability,
    difficulty: nextDifficulty,
    lastReviewedAt: safeNow,
  })
}

export function cosineSimilarity(a?: readonly number[], b?: readonly number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0
  const len = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < len; i++) {
    const va = Number.isFinite(a[i]) ? a[i]! : 0
    const vb = Number.isFinite(b[i]) ? b[i]! : 0
    dot += va * vb
    normA += va * va
    normB += vb * vb
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom <= 1e-12) return 0
  return clamp(dot / denom, -1, 1)
}

export function tokenizeForSearch(text: string): string[] {
  if (typeof text !== 'string') return []
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9_]+/g)
    .filter((token) => token.length >= 2)
}

export function computeLexicalBm25LikeScore(queryTokens: string[], docText: string): number {
  if (queryTokens.length === 0) return 0
  const docTokens = tokenizeForSearch(docText)
  if (docTokens.length === 0) return 0

  const counts = new Map<string, number>()
  for (const t of docTokens) {
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }

  const k1 = 1.2
  const b = 0.75
  const avgDl = 32
  const dl = docTokens.length
  let score = 0

  for (const qt of queryTokens) {
    const tf = counts.get(qt) ?? 0
    if (tf > 0) {
      score += (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDl)))
    }
  }
  return score
}

export function computeRrfScore(bm25Rank: number, vectorRank: number, k = RRF_K): number {
  const safeBm25Rank = Math.max(1, Math.floor(bm25Rank))
  const safeVecRank = Math.max(1, Math.floor(vectorRank))
  return 1 / (k + safeBm25Rank) + 1 / (k + safeVecRank)
}

/**
 * Ranks episodic memories using Hybrid RRF (BM25 + Cosine Vector Similarity) multiplied
 * by FSRS-6 effective retrievability (including the 0.70 Flashbulb Emotional Floor).
 */
export function rankEpisodicMemories(
  memories: readonly EpisodicMemory[],
  query: {
    text: string
    embedding?: readonly number[]
    nowMs?: number
    bm25ScoresById?: ReadonlyMap<string, number>
    limit?: number
  },
): RankedEpisodicMemory[] {
  if (memories.length === 0) return []
  const nowMs = query.nowMs ?? Date.now()
  const queryTokens = tokenizeForSearch(query.text)

  const preScored = memories.map((memory) => {
    const combinedDoc = `${memory.title} ${memory.summary} ${memory.content} ${memory.tags.join(' ')}`
    const externalBm25 = query.bm25ScoresById?.get(memory.id)
    const lexicalScore = computeLexicalBm25LikeScore(queryTokens, combinedDoc)
    const bm25Score =
      externalBm25 !== undefined && Number.isFinite(externalBm25)
        ? externalBm25 + lexicalScore * 0.25
        : lexicalScore

    const vectorSimilarity = query.embedding
      ? cosineSimilarity(query.embedding, memory.embedding)
      : lexicalScore > 0
        ? Math.min(1, lexicalScore / 4)
        : 0

    return {
      memory,
      bm25Score,
      vectorSimilarity,
    }
  })

  // Rank by BM25 descending (1-based)
  const bm25Sorted = [...preScored].sort(
    (a, b) => b.bm25Score - a.bm25Score || b.memory.lastReviewedAt - a.memory.lastReviewedAt,
  )
  const bm25RankMap = new Map<string, number>()
  bm25Sorted.forEach((item, idx) => {
    bm25RankMap.set(item.memory.id, idx + 1)
  })

  // Rank by Vector similarity descending (1-based)
  const vecSorted = [...preScored].sort(
    (a, b) => b.vectorSimilarity - a.vectorSimilarity || b.memory.lastReviewedAt - a.memory.lastReviewedAt,
  )
  const vecRankMap = new Map<string, number>()
  vecSorted.forEach((item, idx) => {
    vecRankMap.set(item.memory.id, idx + 1)
  })

  const ranked: RankedEpisodicMemory[] = preScored.map((item) => {
    const bm25Rank = bm25RankMap.get(item.memory.id) ?? memories.length
    const vectorRank = vecRankMap.get(item.memory.id) ?? memories.length
    const rrfScore = computeRrfScore(bm25Rank, vectorRank, RRF_K)
    const fsrs = computeFsrsRetrievability(item.memory, nowMs)
    const finalScore = rrfScore * fsrs.effectiveRetrievability

    return {
      memory: item.memory,
      bm25Rank,
      vectorRank,
      bm25Score: item.bm25Score,
      vectorSimilarity: item.vectorSimilarity,
      rrfScore,
      rawRetrievability: fsrs.rawRetrievability,
      effectiveRetrievability: fsrs.effectiveRetrievability,
      finalScore,
      subjectiveClarity: classifySubjectiveClarity(fsrs.effectiveRetrievability),
    }
  })

  ranked.sort((a, b) => b.finalScore - a.finalScore || b.bm25Score - a.bm25Score)

  if (query.limit && query.limit > 0) {
    return ranked.slice(0, query.limit)
  }
  return ranked
}
