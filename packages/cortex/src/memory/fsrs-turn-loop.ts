import { computeCosineSimilarity128, embedTextSync128 } from '@ashy/llm'
import type { EpisodicMemory, RelationalMotif } from '@ashy/shared'
import {
  reviewEpisodicMemory,
  tokenizeForSearch,
  type FsrsReviewRating,
  type RankedEpisodicMemory,
} from './fsrs-ranker'

const USAGE_STOPWORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'um',
  'uma',
  'uns',
  'umas',
  'o',
  'a',
  'os',
  'as',
  'e',
  'ou',
  'mas',
  'que',
  'se',
  'por',
  'para',
  'pra',
  'com',
  'sem',
  'eu',
  'voce',
  'ele',
  'ela',
  'meu',
  'minha',
  'seu',
  'sua',
  'esse',
  'essa',
  'isso',
  'este',
  'esta',
  'ta',
  'to',
  'tava',
  'estou',
  'foi',
  'ser',
  'ter',
  'tem',
  'muito',
  'mais',
  'como',
])

export interface TurnMemoryEvaluationItem {
  memory: EpisodicMemory
  previousStability: number
  previousDifficulty: number
  rating: FsrsReviewRating
  usageScore: number
  queryRelevance: number
  hasDirectCallback: boolean
}

export interface EvaluateTurnMemoryUsageInput {
  retrievedMemories: readonly RankedEpisodicMemory[]
  assistantText: string
  invokedMotifIds?: readonly string[]
  motifs?: readonly RelationalMotif[]
  nowMs?: number
}

export interface EvaluateTurnMemoryUsageResult {
  reviewedMemories: TurnMemoryEvaluationItem[]
}

function getSalientTokens(text: string): string[] {
  return Array.from(
    new Set(
      tokenizeForSearch(text).filter((token) => token.length >= 3 && !USAGE_STOPWORDS.has(token)),
    ),
  )
}

function extractCallbackIdsFromText(text: string): string[] {
  if (typeof text !== 'string') return []
  const ids: string[] = []
  const re = /<\|CALLBACK:([^|>]+)\|>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match[1]?.trim()) {
      ids.push(match[1].trim())
    }
  }
  return ids
}

/**
 * Post-Turn FSRS-6 Memory Usage Evaluator:
 * Evaluates retrieved episodic memories injected into the turn context against the
 * assistant's generated reply and `<|CALLBACK|>` markers:
 * - `'easy'` when referenced by `<|CALLBACK|>` or strong response overlap (`>= 0.45`)
 * - `'good'` when moderately referenced in the response (`0.20 <= usageScore < 0.45`)
 * - `'hard'` when highly relevant to the user query (`queryRelevance >= 0.65`) but ignored (`usageScore < 0.08`)
 */
export function evaluateTurnMemoryUsage(
  input: EvaluateTurnMemoryUsageInput,
): EvaluateTurnMemoryUsageResult {
  if (!Array.isArray(input.retrievedMemories) || input.retrievedMemories.length === 0) {
    return { reviewedMemories: [] }
  }

  const safeNow =
    input.nowMs !== undefined && Number.isFinite(input.nowMs) && input.nowMs >= 0
      ? input.nowMs
      : Date.now()
  const assistantText = typeof input.assistantText === 'string' ? input.assistantText : ''
  const assistantTokens = getSalientTokens(assistantText)
  const assistantTokenSet = new Set(assistantTokens)
  const assistantVec = embedTextSync128(assistantText)

  const invokedSet = new Set<string>([
    ...(input.invokedMotifIds ?? []),
    ...extractCallbackIdsFromText(assistantText),
  ])

  const reviewedMemories: TurnMemoryEvaluationItem[] = []

  for (const item of input.retrievedMemories) {
    const memory = item.memory
    const queryRelevance = Number(
      Math.max(item.vectorSimilarity, Math.min(1, item.bm25Score / 2.5)).toFixed(4),
    )

    const hasDirectCallback =
      invokedSet.has(memory.id) ||
      Boolean(
        input.motifs?.some(
          (motif) => invokedSet.has(motif.id) && motif.originEpisodeId === memory.id,
        ),
      )

    const memoryDoc = `${memory.title} ${memory.summary} ${memory.tags.join(' ')}`
    const memoryTokens = getSalientTokens(memoryDoc)

    let matchedCount = 0
    for (const mt of memoryTokens) {
      if (assistantTokenSet.has(mt)) {
        matchedCount += 1
        continue
      }
      if (mt.length >= 5) {
        const prefix = mt.slice(0, 5)
        if (assistantTokens.some((at) => at.startsWith(prefix))) {
          matchedCount += 1
        }
      }
    }

    const denom = Math.max(1, Math.min(6, memoryTokens.length))
    const lexicalOverlap = Math.min(1, matchedCount / denom)

    let usageScore = 0
    if (hasDirectCallback) {
      usageScore = Math.max(lexicalOverlap, 1.0)
    } else if (matchedCount > 0) {
      const memVec =
        memory.embedding && memory.embedding.length > 0
          ? memory.embedding
          : embedTextSync128(memoryDoc)
      const semanticSim = Math.max(
        0,
        memVec.length === assistantVec.length
          ? computeCosineSimilarity128(assistantVec, memVec)
          : computeCosineSimilarity128(assistantVec, embedTextSync128(memoryDoc)),
      )
      usageScore = Number(
        Math.min(1, Math.max(lexicalOverlap, lexicalOverlap * 0.85 + semanticSim * 0.25)).toFixed(4),
      )
    }

    let rating: FsrsReviewRating | null = null
    if (hasDirectCallback || usageScore >= 0.45) {
      rating = 'easy'
    } else if (usageScore >= 0.2) {
      rating = 'good'
    } else if (queryRelevance >= 0.65 && usageScore < 0.08) {
      rating = 'hard'
    }

    if (rating !== null) {
      const updatedMemory = reviewEpisodicMemory(memory, rating, safeNow)
      reviewedMemories.push({
        memory: updatedMemory,
        previousStability: memory.stability,
        previousDifficulty: memory.difficulty,
        rating,
        usageScore,
        queryRelevance,
        hasDirectCallback,
      })
    }
  }

  return { reviewedMemories }
}
