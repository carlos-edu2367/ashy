/**
 * Live Call memory selection (2026-11-01 — small-model conversation quality).
 *
 * The 2B realtime model copies any sentence it sees in the turn. The 10.1 retriever injected raw episode
 * summaries ("Usuário: Olá. | Ashy: Olá, Carlos! Tudo bem…"), so Ashy's own bad replies came back as
 * "memories" and locked the call into a loop. This module turns retrieval results into a few short,
 * USER-CENTRIC lines:
 *  1. semantic facts about the user (name/pronouns excluded — they live in the instructions), only when
 *     the utterance touches them;
 *  2. statements the user made in earlier episodes (user side only — Ashy's wording is never injected),
 *     dropping greetings/trivia, placeholders, questions/requests, near-duplicates and anything that
 *     parrots the current utterance;
 *  3. LLM-written (non-transcript) episode summaries, under the same filters.
 * Non-destructive: poisoned rows stay in the store; they are only filtered out of the call context.
 */
import {
  conversationSimilarity,
  extractUserUtterances,
  isTranscriptStyleSummary,
  hasMemorableContent,
  normalizeConversationText,
} from '@ashy/cortex'
import type { SemanticFact } from '@ashy/shared'

export const CALL_MEMORY_MAX_LINES = 3
export const CALL_MEMORY_MAX_CHARS = 360
const LINE_MAX_CHARS = 150
const DUPLICATE_SIMILARITY = 0.75
/** A memory (almost) identical to the current utterance adds nothing and invites an echo. Lower values would
 * drop the very statement a recall question is about ("lembra o que eu comecei a aprender?"). */
const CURRENT_UTTERANCE_SIMILARITY = 0.85

export interface CallMemoryEpisode {
  id?: string
  title?: string | null
  summary?: string | null
  content?: string | null
}

export interface SelectCallMemoriesInput {
  /** Ranked episodes (most relevant first). */
  episodes: readonly CallMemoryEpisode[]
  facts?: readonly SemanticFact[]
  userText: string
  /** How the user is called in the lines ('Carlos'; default 'O usuário'). */
  userLabel?: string | null
  maxLines?: number
  maxChars?: number
}

export interface SelectedCallMemories {
  lines: string[]
  /** Indexes (in `episodes`) of the episodes that contributed a line. */
  usedEpisodeIndexes: number[]
}

/** Requests/questions are not things to remember about the user ("me conta…", "o que você…?"). */
const REQUEST_RE =
  /^(?:me\s+(?:conta|fala|diz|explica|ajuda|mostra|d[aá])|conta|fala|explica|diz|faz|fa[cç]a|mostra|pode|poderia|sabe|voc[eê]|vc|o\s+que|qual|quais|quanto|quantos|como|onde|quando|por\s*que|cad[eê]|lembra)\b/i

function isRequestOrQuestion(text: string): boolean {
  const t = text.trim()
  return t.endsWith('?') || REQUEST_RE.test(normalizeConversationText(t))
}

function clip(text: string, max = LINE_MAX_CHARS): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trim()}…`
}

function sanitize(text: string): string {
  return text
    .replace(/\0/g, '')
    .replace(/<\|[\s\S]*?(?:\|>|\}>)/g, ' ')
    .replace(/\[(?:contexto|tela)[^\]]*\]/gi, ' ')
    .replace(/["«»“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 5-char stems of the content words (accent-insensitive): "trabalho" ≈ "trabalha". */
function stems(text: string): Set<string> {
  return new Set(
    normalizeConversationText(text)
      .split(' ')
      .filter((t) => t.length >= 3)
      .map((t) => t.slice(0, 5)),
  )
}

function overlaps(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const t of a) if (b.has(t)) n += 1
  return n
}

const IGNORED_FACT_PREDICATES = new Set(['name', 'user_name', 'pronouns', 'user_pronouns'])
const STEM_STOP = new Set(['voce', 'mesmo', 'agora', 'entao', 'sobre', 'isso', 'esse', 'essa', 'aquel', 'tambe', 'muito', 'qual', 'quais', 'lembr'])

/** pt-BR sentence + cue words for a semantic fact about the user. */
export function renderUserFact(fact: Pick<SemanticFact, 'predicate' | 'object'>, label: string): { text: string; cues: string } {
  const object = sanitize(fact.object)
  const predicate = fact.predicate.trim()
  const named = /^named:(.+)$/i.exec(predicate)
  if (named?.[1]) {
    const noun = named[1].replace(/_/g, ' ')
    return { text: `${noun} de ${label} se chama ${object}`, cues: `${noun} nome chama ${object}` }
  }
  if (/^likes(?::|$)/.test(predicate)) {
    return { text: `${label} gosta de ${object}`, cues: `gosto gosta curto adoro ${object}` }
  }
  switch (predicate) {
    case 'works_with':
      return { text: `${label} trabalha com ${object}`, cues: `trabalho trabalha emprego profissão ${object}` }
    case 'uses_tool':
      return { text: `${label} usa muito ${object}`, cues: `uso usa ferramenta ${object}` }
    case 'current_project':
      return { text: `projeto atual de ${label}: ${object}`, cues: `projeto ${object}` }
    case 'lives_in':
      return { text: `${label} mora em ${object}`, cues: `moro mora cidade casa ${object}` }
    case 'favorite_editor':
    case 'editor':
      return { text: `editor favorito de ${label}: ${object}`, cues: `editor ${object}` }
    default:
      return {
        text: `${label}: ${predicate.replace(/[_:]+/g, ' ')} ${object}`,
        cues: `${predicate.replace(/[_:]+/g, ' ')} ${object}`,
      }
  }
}

function isUsableFact(f: SemanticFact): boolean {
  return (
    (f.invalidAt === null || f.invalidAt === undefined) &&
    f.approvalStatus !== 'pending_review' &&
    normalizeConversationText(f.subject) === 'user' &&
    !IGNORED_FACT_PREDICATES.has(f.predicate) &&
    sanitize(f.object).length > 0
  )
}

/** Picks the clean, user-centric memory lines for one call turn (see the module header). */
export function selectCallMemoryLines(input: SelectCallMemoriesInput): SelectedCallMemories {
  const label = sanitize(input.userLabel ?? '').slice(0, 40) || 'O usuário'
  const maxLines = input.maxLines ?? CALL_MEMORY_MAX_LINES
  const maxChars = input.maxChars ?? CALL_MEMORY_MAX_CHARS
  const userText = input.userText ?? ''
  const queryStems = new Set([...stems(userText)].filter((s) => !STEM_STOP.has(s)))
  const lines: string[] = []
  const raw: string[] = []
  const usedEpisodeIndexes: number[] = []
  let used = 0

  const push = (line: string, rawText: string): boolean => {
    if (lines.length >= maxLines) return false
    const clipped = clip(line)
    if (used + clipped.length + 3 > maxChars) return false
    if (raw.some((r) => conversationSimilarity(r, rawText) >= DUPLICATE_SIMILARITY)) return false
    lines.push(clipped)
    raw.push(rawText)
    used += clipped.length + 3
    return true
  }

  // 1. Facts touched by the utterance (best overlap first, max 2).
  const facts = (input.facts ?? [])
    .filter(isUsableFact)
    .map((f) => {
      const r = renderUserFact(f, label)
      return { r, score: overlaps(queryStems, stems(r.cues)) }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
  for (const { r } of facts) push(r.text, r.text)

  // 2./3. Episodes: user statements or free-text summaries.
  input.episodes.forEach((ep, index) => {
    if (lines.length >= maxLines) return
    const candidates: Array<{ line: string; text: string }> = []
    const utterances = extractUserUtterances({ summary: ep.summary ?? '', content: ep.content ?? '' })
    if (utterances.length > 0) {
      for (const u of utterances) {
        const clean = sanitize(u)
        if (!hasMemorableContent(clean) || isRequestOrQuestion(clean)) continue
        candidates.push({ line: `${label} contou: ${clean}`, text: clean })
      }
    } else {
      const summary = sanitize(ep.summary ?? '')
      if (summary.length > 0 && !isTranscriptStyleSummary(ep.summary ?? '') && hasMemorableContent(summary)) {
        candidates.push({ line: summary, text: summary })
      }
    }
    // The most query-relevant statements of the episode first.
    candidates.sort((a, b) => overlaps(queryStems, stems(b.text)) - overlaps(queryStems, stems(a.text)))
    let contributed = false
    for (const c of candidates.slice(0, 2)) {
      if (conversationSimilarity(c.text, userText) >= CURRENT_UTTERANCE_SIMILARITY) continue
      if (push(c.line, c.text)) contributed = true
    }
    if (contributed) usedEpisodeIndexes.push(index)
  })

  return { lines, usedEpisodeIndexes }
}
