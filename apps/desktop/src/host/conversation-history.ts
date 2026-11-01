/**
 * Phase 10.0 (T2) — conversation history sanitization.
 *
 * Small local models (e.g. LFM3-Omni-2B via Ollama) copy whatever is in the
 * replayed history. Live sessions accumulated placeholder user turns
 * (`[Mensagem de voz Omni]`) and several near-identical assistant replies,
 * which the model then parroted on every turn. This module is a pure filter
 * applied before the history is replayed to the LLM. It never mutates the
 * persisted records.
 */

/** Placeholder persisted when a voice turn reaches the host without a transcript. */
export const OMNI_VOICE_PLACEHOLDER_TEXT = '[Mensagem de voz Omni]'
/** Placeholder persisted when only media (frames/attachments) was sent. */
export const OMNI_MEDIA_PLACEHOLDER_TEXT = '[Mídia enviada para análise Omni]'
/**
 * Phase 10.1: persisted by `cortex.appendVoiceTurn` when a Live Call user turn
 * could not be transcribed (mirrors `VOICE_UNTRANSCRIBED_PLACEHOLDER` in @ashy/cortex).
 */
export const VOICE_UNTRANSCRIBED_PLACEHOLDER_TEXT = '🎤 (fala não transcrita)'
/** Phase 10.1: appended to assistant replies the user interrupted (barge-in). */
export const INTERRUPTED_REPLY_SUFFIX = '…'

/**
 * User contents that carry no conversational meaning. Matching is done on the
 * trimmed content (exact) — see `isPlaceholderUserContent`.
 */
const PLACEHOLDER_USER_CONTENTS = new Set<string>([
  OMNI_VOICE_PLACEHOLDER_TEXT,
  OMNI_MEDIA_PLACEHOLDER_TEXT,
  VOICE_UNTRANSCRIBED_PLACEHOLDER_TEXT,
  '🎤 (áudio)',
  '🎤 (áudio sem transcrição)',
])

const SYNTHETIC_OMNI_REVISION_REGEX = /^ashy-omni-turn-rev-\d+$/i

export interface ConversationHistoryEntry {
  role: string
  content: string
  /**
   * Phase 10.1: assistant reply cut by the user. The sanitizer appends `…` to
   * its content and strips this flag from the output.
   */
  interrupted?: boolean
}

export interface ConversationHistoryLimits {
  maxMessages: number
  maxChars: number
}

export interface SanitizeConversationHistoryOptions extends ConversationHistoryLimits {
  /** Near-duplicate threshold for assistant replies (default 0.85). */
  similarityThreshold?: number
  /**
   * Drop trailing user messages (default true). The sanitized history is always
   * followed by the new user turn, so a trailing user message (e.g. a turn that
   * failed before the assistant replied) would produce two user turns in a row.
   */
  dropTrailingUser?: boolean
}

/** Local/small-context providers get a tight window; cloud providers keep 80. */
export const LOCAL_PROVIDER_HISTORY_LIMITS: ConversationHistoryLimits = {
  maxMessages: 8,
  maxChars: 6000,
}
export const DEFAULT_PROVIDER_HISTORY_LIMITS: ConversationHistoryLimits = {
  maxMessages: 80,
  maxChars: 120_000,
}

export function resolveConversationHistoryLimits(
  providerId: string | null | undefined,
): ConversationHistoryLimits {
  return providerId === 'ollama'
    ? { ...LOCAL_PROVIDER_HISTORY_LIMITS }
    : { ...DEFAULT_PROVIDER_HISTORY_LIMITS }
}

export function isPlaceholderUserContent(content: string | null | undefined): boolean {
  const trimmed = (content ?? '').trim()
  if (trimmed.length === 0) return true
  if (PLACEHOLDER_USER_CONTENTS.has(trimmed)) return true
  return SYNTHETIC_OMNI_REVISION_REGEX.test(trimmed)
}

/**
 * Normalizes text for similarity: strips `<|...|>` stage markers (including the
 * malformed `}>` closing some small models emit), lowercases, removes accents
 * and punctuation, collapses whitespace.
 */
export function normalizeForSimilarity(text: string): string {
  return text
    .replace(/<\|[\s\S]*?(?:\|>|\}>)/g, ' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenSet(text: string): Set<string> {
  const normalized = normalizeForSimilarity(text)
  return new Set(normalized.length > 0 ? normalized.split(' ') : [])
}

/** Below this size, containment is too noisy ("tudo bem" ⊂ everything). */
const MIN_TOKENS_FOR_CONTAINMENT = 6

/**
 * Similarity in [0, 1] = max(token Jaccard, containment of the smaller set in
 * the larger one). Containment catches the real poisoned case where one reply
 * is a strict truncation of the other ("Carlos, o que você quer que eu analise
 * ou te conte hoje?" ⊂ "Oi, Carlos! Tudo bem? … o que você quer que eu analise
 * ou te conte hoje?"), whose Jaccard is only ~0.63. Containment only counts
 * when the smaller reply has at least 6 distinct tokens.
 */
export function textSimilarity(a: string, b: string): number {
  const setA = tokenSet(a)
  const setB = tokenSet(b)
  if (setA.size === 0 && setB.size === 0) return 1
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const token of setA) {
    if (setB.has(token)) intersection += 1
  }
  const union = setA.size + setB.size - intersection
  const jaccard = union > 0 ? intersection / union : 0
  const minSize = Math.min(setA.size, setB.size)
  const containment = minSize >= MIN_TOKENS_FOR_CONTAINMENT ? intersection / minSize : 0
  return Math.max(jaccard, containment)
}

/**
 * Pure history sanitizer (input in chronological order, oldest first):
 * 1. drops placeholder/empty user messages together with the assistant reply
 *    immediately after them (it answered nothing real); drops empty assistant
 *    replies;
 * 2. collapses near-duplicate assistant replies (similarity ≥ threshold),
 *    keeping only the most recent occurrence;
 * 3. restores role alternation: consecutive user messages are merged (joined
 *    by a newline) and so are consecutive assistant messages (blank line) —
 *    e.g. a reply followed by an injected Live Call turn (initiative/approval
 *    result, Phase 10.3) has no user row in between; near-duplicates were
 *    already removed in step 2; trailing user messages are dropped (see `dropTrailingUser`);
 * 4. caps to the last `maxMessages` and then to `maxChars` (oldest dropped
 *    first; a single oversized message keeps its most recent tail).
 * Messages with roles other than user/assistant (e.g. system) are passed
 * through untouched and do not take part in the alternation rules.
 */
export function sanitizeConversationHistory<T extends ConversationHistoryEntry>(
  records: readonly T[],
  options: SanitizeConversationHistoryOptions,
): T[] {
  const threshold = options.similarityThreshold ?? 0.85
  const maxMessages = Math.max(0, Math.floor(options.maxMessages))
  const maxChars = Math.max(0, Math.floor(options.maxChars))
  const dropTrailingUser = options.dropTrailingUser ?? true

  // 1. Placeholder user turns + the reply that answered them.
  const withoutPlaceholders: T[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    if (record.role === 'user' && isPlaceholderUserContent(record.content)) {
      const next = records[i + 1]
      if (next && next.role === 'assistant') {
        i += 1
      }
      continue
    }
    if (record.role === 'assistant' && record.content.trim().length === 0) {
      continue
    }
    if ('interrupted' in record) {
      const { interrupted, ...rest } = record
      const content =
        interrupted === true && record.role === 'assistant'
          ? `${record.content.trimEnd()}${INTERRUPTED_REPLY_SUFFIX}`
          : record.content
      withoutPlaceholders.push({ ...rest, content } as unknown as T)
      continue
    }
    withoutPlaceholders.push(record)
  }

  // 2. Near-duplicate assistant replies — iterate newest → oldest, keep newest.
  const keptAssistant: string[] = []
  const deduped: T[] = []
  for (let i = withoutPlaceholders.length - 1; i >= 0; i--) {
    const record = withoutPlaceholders[i]!
    if (record.role === 'assistant') {
      const isDuplicate = keptAssistant.some(
        (kept) => textSimilarity(kept, record.content) >= threshold,
      )
      if (isDuplicate) continue
      keptAssistant.push(record.content)
    }
    deduped.push(record)
  }
  deduped.reverse()

  // 3. Role alternation.
  const alternated: T[] = []
  for (const record of deduped) {
    let lastConversational: T | undefined
    let lastIndex = -1
    for (let j = alternated.length - 1; j >= 0; j--) {
      const candidate = alternated[j]!
      if (candidate.role === 'user' || candidate.role === 'assistant') {
        lastConversational = candidate
        lastIndex = j
        break
      }
    }
    if (
      (record.role === 'user' || record.role === 'assistant') &&
      lastConversational &&
      lastConversational.role === record.role
    ) {
      if (record.role === 'user') {
        alternated[lastIndex] = {
          ...lastConversational,
          ...record,
          content: `${lastConversational.content.trim()}\n${record.content.trim()}`,
        }
      } else {
        alternated[lastIndex] = {
          ...lastConversational,
          ...record,
          content: `${lastConversational.content.trim()}\n\n${record.content.trim()}`,
        }
      }
      continue
    }
    alternated.push(record)
  }
  if (dropTrailingUser) {
    while (alternated.length > 0 && alternated[alternated.length - 1]!.role === 'user') {
      alternated.pop()
    }
  }

  // 4. Caps.
  let capped = maxMessages > 0 ? alternated.slice(-maxMessages) : []
  let totalChars = capped.reduce((sum, m) => sum + m.content.length, 0)
  while (capped.length > 1 && totalChars > maxChars) {
    totalChars -= capped[0]!.content.length
    capped = capped.slice(1)
  }
  if (capped.length === 1 && capped[0]!.content.length > maxChars) {
    const only = capped[0]!
    capped = maxChars > 0 ? [{ ...only, content: only.content.slice(-maxChars) }] : []
  }
  return capped
}
