/**
 * Phase 10.2 — call-quality helpers for the CallEngine (pure, no I/O):
 * - `textSimilarity` (token Jaccard + containment) to catch the 2B model repeating an earlier reply;
 * - `buildSessionRecap`: the single `[Contexto] Resumo da conversa até aqui: …` seed of a rotated session;
 * - `extractActMarkers`: `<|ACT {json}|>` (also the `…}>` ending) parsed out of the response text, with the
 *   offsets of each marker in the CLEAN text (caption / ledger never show markers);
 * - `splitCompletedSentences`: sentence spans of the clean text (emotion fallback runs per sentence).
 */
import { parseStageSignal } from '@ashy/llm'
import type { CallStageSignal } from '@ashy/shared'

// ───────────────────────────── similarity ─────────────────────────────

/** Portuguese function words: ignored so two unrelated replies don't look alike through "e", "com", "que"… */
const STOPWORDS = new Set(
  (
    'a o e as os um uma uns umas de do da dos das em no na nos nas ao aos com sem por para pra pro que se ' +
    'eu tu voce voces ele ela eles elas nos me te lhe meu minha seu sua isso isto esse essa este esta aquilo ' +
    'aqui ai la ou mas mais muito muita tudo nada nao sim ja so tambem como quando onde e e foi ser sao estar ' +
    'esta estou tem ter vai vou ha bem entao'
  ).split(' '),
)

function tokenize(text: string): string[] {
  const all = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
  const content = all.filter((t) => !STOPWORDS.has(t))
  return content.length > 0 ? content : all
}

/** Minimum size of the shorter text before containment counts (short replies like "sim" would match everything). */
const CONTAINMENT_MIN_TOKENS = 5

/**
 * Similarity in [0, 1]: max(Jaccard of the token sets, containment of the smaller set in the bigger one).
 * Containment only counts when the smaller text has ≥ 5 distinct tokens.
 */
export function textSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a))
  const tb = new Set(tokenize(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter += 1
  const union = ta.size + tb.size - inter
  const jaccard = union > 0 ? inter / union : 0
  const minSize = Math.min(ta.size, tb.size)
  const containment = minSize >= CONTAINMENT_MIN_TOKENS ? inter / minSize : 0
  return Math.max(jaccard, containment)
}

/** Threshold above which a reply counts as a near-repeat (plan 10.2: ≥ 0.8 vs any of the last 6 replies). */
export const NEAR_REPEAT_SIMILARITY = 0.8
export const NEAR_REPEAT_WINDOW = 6

export function isNearRepeat(reply: string, previous: readonly string[], threshold = NEAR_REPEAT_SIMILARITY): boolean {
  if (!reply.trim()) return false
  return previous.some((p) => textSimilarity(reply, p) >= threshold)
}

// ───────────────────────────── recap ─────────────────────────────

export interface CallExchange {
  user: string
  /** What the user actually heard. */
  assistant: string
}

export interface SessionRecapOptions {
  maxExchanges?: number
  userLabel?: string
  maxCharsPerLine?: number
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trim()}…`
}

/**
 * The single input_text that seeds a rotated session (llama.cpp realtime only accepts `input_text` user items):
 * the last `maxExchanges` (default 4) exchanges, with near-duplicate lines removed.
 * Returns '' when there is nothing to summarise.
 */
export function buildSessionRecap(exchanges: readonly CallExchange[], opts: SessionRecapOptions = {}): string {
  const maxExchanges = opts.maxExchanges ?? 4
  const maxChars = opts.maxCharsPerLine ?? 220
  const label = (opts.userLabel ?? '').trim() || 'Usuário'
  const recent = exchanges.slice(-maxExchanges)
  const keptUser: string[] = []
  const keptAssistant: string[] = []
  const lines: string[] = []
  for (const ex of recent) {
    const user = ex.user.trim()
    const assistant = ex.assistant.trim()
    if (user && !isNearRepeat(user, keptUser)) {
      keptUser.push(user)
      lines.push(`- ${label}: ${clip(user, maxChars)}`)
    }
    if (assistant && !isNearRepeat(assistant, keptAssistant)) {
      keptAssistant.push(assistant)
      lines.push(`- Você: ${clip(assistant, maxChars)}`)
    }
  }
  if (lines.length === 0) return ''
  return `[Contexto] Resumo da conversa até aqui:\n${lines.join('\n')}\n(Não repita respostas anteriores; responda só à nova fala.)`
}

// ───────────────────────────── ACT markers ─────────────────────────────

export interface ParsedActMarker {
  /** Offset in the CLEAN text where the marker was. */
  offset: number
  signal: CallStageSignal
}

export interface ActExtraction {
  /** Text without any `<|…|>` marker (an unfinished trailing marker is hidden too). */
  clean: string
  markers: ParsedActMarker[]
}

/** An unfinished `<|…` tail longer than this is treated as garbage and dropped (never shown). */
const MAX_OPEN_MARKER_CHARS = 400

/**
 * Removes every `<|…|>` / `<|…}>` marker from `raw` and returns the ACT signals with their offsets in the
 * clean text. Non-ACT markers (DELAY, CALLBACK, model control tokens) are stripped and ignored.
 */
export function extractActMarkers(raw: string): ActExtraction {
  let clean = ''
  const markers: ParsedActMarker[] = []
  let i = 0
  while (i < raw.length) {
    const open = raw.indexOf('<|', i)
    if (open === -1) {
      clean += raw.slice(i)
      break
    }
    clean += raw.slice(i, open)
    const closePipe = raw.indexOf('|>', open + 2)
    const closeBrace = raw.indexOf('}>', open + 2)
    let end = -1
    let body = ''
    if (closePipe !== -1 && (closeBrace === -1 || closePipe <= closeBrace + 1)) {
      body = raw.slice(open + 2, closePipe)
      end = closePipe + 2
    } else if (closeBrace !== -1) {
      body = raw.slice(open + 2, closeBrace + 1)
      end = closeBrace + 2
    }
    if (end === -1) {
      // Unfinished marker at the tail (still streaming): hide it.
      if (raw.length - open > MAX_OPEN_MARKER_CHARS) {
        // Too long to be a marker: drop just the opener so the text is not lost.
        i = open + 2
        continue
      }
      break
    }
    const parsed = parseStageSignal(`<|${body.trim()}|>`)
    if (parsed.type === 'act' && (parsed.emotion !== undefined || parsed.motion !== undefined)) {
      markers.push({
        offset: clean.length,
        signal: {
          emotion: parsed.emotion ?? 'neutral',
          intensity: parsed.intensity ?? 0.6,
          ...(parsed.motion ? { motion: parsed.motion.slice(0, 48) } : {}),
        },
      })
    }
    i = end
  }
  return { clean, markers }
}

/** Caption / ledger text: markers removed, whitespace tidied. */
export function stripCallMarkers(raw: string): string {
  return extractActMarkers(raw).clean.replace(/\s{2,}/g, ' ')
}

// ───────────────────────────── sentences ─────────────────────────────

export interface SentenceSpan {
  start: number
  end: number
  text: string
}

/**
 * Sentence spans of `text` that are complete: terminated by . ! ? … (or a newline) followed by whitespace,
 * or — when `final` — whatever remains at the end.
 */
export function splitCompletedSentences(text: string, final: boolean): SentenceSpan[] {
  const spans: SentenceSpan[] = []
  const re = /[.!?…]+(?=\s)|\n+/g
  let start = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length
    pushSpan(spans, text, start, end)
    start = end
  }
  if (final && start < text.length) pushSpan(spans, text, start, text.length)
  return spans
}

function pushSpan(spans: SentenceSpan[], text: string, start: number, end: number): void {
  const slice = text.slice(start, end)
  const lead = slice.length - slice.trimStart().length
  const trimmed = slice.trim()
  if (!trimmed) return
  spans.push({ start: start + lead, end, text: trimmed })
}
