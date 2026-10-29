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

  // Semantic topic shift check across consecutive user turns (requires at least 2 user turns)
  if (userMessages.length >= 2) {
    for (let i = 1; i < userMessages.length; i++) {
      const prevVec = embedTextSync128(userMessages[i - 1]!.content)
      const currVec = embedTextSync128(userMessages[i]!.content)
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
