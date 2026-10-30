import { computeCosineSimilarity128, embedTextSync128 } from '@ashy/llm'
import type { ChatMessageRecord } from '@ashy/shared'

export const SOFT_GAP_MS = 30 * 60 * 1000
export const HARD_GAP_MS = 3 * 60 * 60 * 1000
export const SOFT_TURN_COUNT = 6
export const TOPIC_SHIFT_THRESHOLD = 0.18

export type EpisodeBoundaryType = 'soft' | 'hard' | null

export type EpisodeBoundaryReason =
  | 'manual_force'
  | 'session_switch'
  | 'hard_gap_3h'
  | 'idle_gap_30m'
  | 'turn_window_reached'
  | 'topic_shift'
  | null

export interface EpisodeBoundaryDecision {
  shouldConsolidate: boolean
  boundaryType: EpisodeBoundaryType
  reason: EpisodeBoundaryReason
  batchMessages: ChatMessageRecord[]
}

export interface DetectEpisodeBoundaryOptions {
  nowMs?: number
  force?: boolean
  sessionSwitch?: boolean
}

const TOPIC_STOPWORDS = new Set([
  'para',
  'como',
  'isso',
  'essa',
  'esse',
  'este',
  'esta',
  'isto',
  'aquilo',
  'aquele',
  'aquela',
  'voce',
  'voces',
  'mais',
  'menos',
  'muito',
  'muita',
  'quando',
  'onde',
  'qual',
  'quais',
  'quem',
  'porque',
  'estou',
  'estava',
  'fazer',
  'fazendo',
  'coisa',
  'coisas',
  'algum',
  'alguma',
  'nenhum',
  'nenhuma',
  'apareceu',
  'quero',
  'saber',
  'sabe',
  'achou',
  'ideia',
  'coloquei',
  'umas',
  'novas',
  'nova',
  'novo',
  'novos',
  'mesmo',
  'mesma',
  'tudo',
  'nada',
  'aqui',
  'ali',
  'ainda',
  'entendi',
  'entendii',
  'nah',
  'nahh',
  'opa',
  'nossa',
  'rapaz',
  'cara',
  'mano',
  'amigo',
  'amiga',
  'gente',
  'tranquilo',
  'tranquila',
  'beleza',
  'contigo',
  'comigo',
  'hoje',
  'agora',
  'entao',
  'valeu',
  'obrigado',
  'obrigada',
  'suave',
  'firmeza',
  'tarde',
  'noite',
])

/**
 * Returns true only when a user message contains enough substantive topical content
 * (>= 4 non-stopword tokens of length >= 4, excluding laughter and short meta/banter turns)
 * to be eligible for semantic `topic_shift` episode boundary segmentation.
 */
export function isSubstantiveTopicMessage(text: string): boolean {
  if (typeof text !== 'string') return false
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (normalized.length < 20) return false

  const tokens = normalized.split(' ').filter((tok) => {
    if (tok.length < 4) return false
    if (TOPIC_STOPWORDS.has(tok)) return false
    if (/^(k+|h[aei]+h[aei]*|rs+|entendi+|nah+|opa+|oi+|ola+)$/i.test(tok)) return false
    return true
  })

  return tokens.length >= 4
}

/**
 * Evaluates unconsolidated chat messages in a session and determines whether
 * a soft (>= 30m idle gap, >= 6 turns, or topic shift < 0.18 cosine similarity)
 * or hard (> 3h idle gap, session switch, or manual force) episode boundary has been reached.
 */
export function detectEpisodeBoundary(
  messages: readonly ChatMessageRecord[],
  options?: DetectEpisodeBoundaryOptions,
): EpisodeBoundaryDecision {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      shouldConsolidate: false,
      boundaryType: null,
      reason: null,
      batchMessages: [],
    }
  }

  const unconsolidated = messages
    .filter(
      (msg) =>
        msg &&
        (msg.consolidatedEpisodeId === null ||
          msg.consolidatedEpisodeId === undefined ||
          msg.consolidatedEpisodeId === ''),
    )
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)

  if (unconsolidated.length === 0) {
    return {
      shouldConsolidate: false,
      boundaryType: null,
      reason: null,
      batchMessages: [],
    }
  }

  if (options?.sessionSwitch === true) {
    return {
      shouldConsolidate: true,
      boundaryType: 'hard',
      reason: 'session_switch',
      batchMessages: unconsolidated,
    }
  }

  if (options?.force === true) {
    return {
      shouldConsolidate: true,
      boundaryType: 'hard',
      reason: 'manual_force',
      batchMessages: unconsolidated,
    }
  }

  // Compute maximum idle gap between consecutive messages or from the last message to nowMs
  let maxGapMs = 0
  for (let i = 1; i < unconsolidated.length; i++) {
    const prev = unconsolidated[i - 1]!
    const curr = unconsolidated[i]!
    const gap = curr.createdAt - prev.createdAt
    if (Number.isFinite(gap) && gap > maxGapMs) {
      maxGapMs = gap
    }
  }

  if (options?.nowMs !== undefined && Number.isFinite(options.nowMs)) {
    const lastMsg = unconsolidated[unconsolidated.length - 1]!
    const trailingGap = options.nowMs - lastMsg.createdAt
    if (Number.isFinite(trailingGap) && trailingGap > maxGapMs) {
      maxGapMs = trailingGap
    }
  }

  if (maxGapMs > HARD_GAP_MS) {
    return {
      shouldConsolidate: true,
      boundaryType: 'hard',
      reason: 'hard_gap_3h',
      batchMessages: unconsolidated,
    }
  }

  if (maxGapMs >= SOFT_GAP_MS) {
    return {
      shouldConsolidate: true,
      boundaryType: 'soft',
      reason: 'idle_gap_30m',
      batchMessages: unconsolidated,
    }
  }

  // Turn window check (>= 6 user turns or >= 12 messages)
  const userMessages = unconsolidated.filter(
    (msg) => msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim().length > 0,
  )
  if (userMessages.length >= SOFT_TURN_COUNT || unconsolidated.length >= SOFT_TURN_COUNT * 2) {
    return {
      shouldConsolidate: true,
      boundaryType: 'soft',
      reason: 'turn_window_reached',
      batchMessages: unconsolidated,
    }
  }

  // Semantic topic shift check across consecutive user turns (requires at least 2 substantive user turns)
  if (userMessages.length >= 2) {
    for (let i = 1; i < userMessages.length; i++) {
      const prevContent = userMessages[i - 1]!.content
      const currContent = userMessages[i]!.content
      if (!isSubstantiveTopicMessage(prevContent) || !isSubstantiveTopicMessage(currContent)) {
        continue
      }
      const prevVec = embedTextSync128(prevContent)
      const currVec = embedTextSync128(currContent)
      const similarity = computeCosineSimilarity128(prevVec, currVec)
      if (similarity < TOPIC_SHIFT_THRESHOLD) {
        return {
          shouldConsolidate: true,
          boundaryType: 'soft',
          reason: 'topic_shift',
          batchMessages: unconsolidated,
        }
      }
    }
  }

  return {
    shouldConsolidate: false,
    boundaryType: null,
    reason: null,
    batchMessages: [],
  }
}
