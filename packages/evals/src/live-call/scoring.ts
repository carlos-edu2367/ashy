/**
 * Live Call conversation-quality scorer (2026-11-01). Pure: given the scripted user turns and Ashy's
 * replies, flags the small-model failure modes seen in real calls:
 * echo of the user, repeated replies, greeting on every turn, wrong name / role confusion, context-tag
 * leakage, off-topic / missed recall, empty or runaway length.
 */
import {
  conversationSimilarity,
  isEchoReply,
  isGreetingOnlyReply,
  normalizeConversationText,
  startsWithGreeting,
} from '@ashy/cortex'
import type { LiveEvalScenario, LiveEvalTurn } from './scenarios'

export const REPEAT_SIMILARITY = 0.75
export const MAX_REPLY_CHARS = 420

export type LiveTurnFlag =
  | 'empty'
  | 'echo'
  | 'repeat'
  | 'greeting_again'
  | 'wrong_name'
  | 'leak'
  | 'off_topic'
  | 'recall_miss'
  | 'too_long'
  | 'not_portuguese'

export interface LiveTurnScore {
  index: number
  user: string
  reply: string
  flags: LiveTurnFlag[]
  pass: boolean
  /** Highest similarity to an earlier reply of the same conversation. */
  maxPrevSimilarity: number
  echoSimilarity: number
  latencyMs?: number
}

export interface LiveConversationScore {
  scenarioId: string
  backend: string
  turns: LiveTurnScore[]
  passRate: number
  counts: Record<LiveTurnFlag, number>
  /** Recall turns that used the expected fact / total recall turns. */
  recall: { hit: number; total: number }
  /** Turns with an on-topic expectation that matched / total. */
  onTopic: { hit: number; total: number }
}

const LEAK_RE =
  /\[(?:contexto|tela|sua fala)|mem[oó]rias relevantes|humor da ashy|hora local\s*:|<\|[^>]*\|?>|\bfunction_call\b|aguardando_aprovacao/i
const WRONG_NAME_RE =
  /(?:^|[.!?]\s*)(?:ol[aá]|oi|ei|e a[ií]|obrigad[oa]|valeu|tchau|bom dia|boa tarde|boa noite|tudo bem|claro|certo)[,!\s]+ashy\b|,\s*ashy\s*[.!?]|^\s*ashy\s*[,!]|\beu sou (?:o |a )?(carlos)\b/i
const PT_WORDS = new Set('voce nao que e de do da um uma eu ele ela isso com pra para seu sua muito bem vou sim o a os as no na se te me mas foi tem ta ja'.split(' '))
const EN_WORDS = new Set("the and you is are to of it that this what how i'm i your".split(' '))

/** True when the reply looks English rather than Portuguese (more English than pt function words). */
function looksEnglish(reply: string): boolean {
  let pt = 0
  let en = 0
  for (const w of normalizeConversationText(reply).split(' ')) {
    if (PT_WORDS.has(w)) pt += 1
    if (EN_WORDS.has(w)) en += 1
  }
  return en >= 2 && en > pt
}

/**
 * Near-identical replies (Jaccard), or one reply containing the other when both are of comparable size —
 * a short follow-up that reuses words of an earlier long story is not a repeat.
 */
export function repeatSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeConversationText(a).split(' ').filter((w) => w.length > 2))
  const tb = new Set(normalizeConversationText(b).split(' ').filter((w) => w.length > 2))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter += 1
  const jaccard = inter / (ta.size + tb.size - inter)
  const min = Math.min(ta.size, tb.size)
  const max = Math.max(ta.size, tb.size)
  const containment = min >= 5 && min / max >= 0.5 ? inter / min : 0
  // A repeated tail sentence ("Vai chover amanhã e você vai ao dentista?") is a repeat too.
  const tail = (t: string) => normalizeConversationText(t.split(/(?<=[.!?])\s+/).filter(Boolean).at(-1) ?? '')
  const ta2 = tail(a)
  const sameTail = ta2.split(' ').length >= 5 && ta2 === tail(b) ? 1 : 0
  return Math.max(jaccard, containment * 0.95, sameTail)
}

function matchesAny(reply: string, words: readonly string[]): boolean {
  const r = normalizeConversationText(reply)
  return words.some((w) => {
    const k = normalizeConversationText(w)
    return k.length > 0 && (` ${r} `.includes(` ${k} `) || (k.length >= 5 && r.includes(k)))
  })
}

/** Scores one reply given the turn spec and the replies before it. */
export function scoreLiveTurn(input: {
  index: number
  turn: LiveEvalTurn
  reply: string
  previousReplies: readonly string[]
  userName?: string
  latencyMs?: number
}): LiveTurnScore {
  const { turn, index } = input
  const reply = (input.reply ?? '').replace(/\s+/g, ' ').trim()
  const flags: LiveTurnFlag[] = []
  const echoSimilarity = conversationSimilarity(turn.user, reply)
  let maxPrev = 0
  for (const p of input.previousReplies) maxPrev = Math.max(maxPrev, repeatSimilarity(reply, p))

  if (reply.length < 2) flags.push('empty')
  else {
    if (isEchoReply(turn.user, reply, { userName: input.userName ?? null })) flags.push('echo')
    if (maxPrev >= REPEAT_SIMILARITY) flags.push('repeat')
    // A greeting is fine on the first turn and when the user greets; never as a habit after that.
    if (index > 0 && !turn.greetingOk && startsWithGreeting(reply)) flags.push('greeting_again')
    if (WRONG_NAME_RE.test(reply)) flags.push('wrong_name')
    if (LEAK_RE.test(reply)) flags.push('leak')
    if (reply.length > (turn.maxChars ?? MAX_REPLY_CHARS)) flags.push('too_long')
    if (looksEnglish(reply)) flags.push('not_portuguese')
    // A greeting / generic "how can I help?" never counts as answering the turn.
    if (
      turn.expectAny &&
      turn.expectAny.length > 0 &&
      (!matchesAny(reply, turn.expectAny) || isGreetingOnlyReply(reply, input.userName))
    ) {
      flags.push('off_topic')
    }
    if (turn.recallAny && turn.recallAny.length > 0 && !matchesAny(reply, turn.recallAny)) flags.push('recall_miss')
  }
  if (reply.length < 2 && turn.recallAny?.length) flags.push('recall_miss')
  return {
    index,
    user: turn.user,
    reply,
    flags,
    pass: flags.length === 0,
    maxPrevSimilarity: Number(maxPrev.toFixed(2)),
    echoSimilarity: Number(echoSimilarity.toFixed(2)),
    ...(input.latencyMs !== undefined ? { latencyMs: Math.round(input.latencyMs) } : {}),
  }
}

const ALL_FLAGS: LiveTurnFlag[] = [
  'empty',
  'echo',
  'repeat',
  'greeting_again',
  'wrong_name',
  'leak',
  'off_topic',
  'recall_miss',
  'too_long',
  'not_portuguese',
]

export function scoreLiveConversation(input: {
  scenario: LiveEvalScenario
  backend: string
  replies: readonly string[]
  latenciesMs?: readonly number[]
  userName?: string
}): LiveConversationScore {
  const turns: LiveTurnScore[] = []
  const prev: string[] = []
  input.scenario.turns.forEach((turn, index) => {
    const reply = input.replies[index] ?? ''
    turns.push(
      scoreLiveTurn({
        index,
        turn,
        reply,
        previousReplies: prev,
        ...(input.userName ? { userName: input.userName } : {}),
        ...(input.latenciesMs?.[index] !== undefined ? { latencyMs: input.latenciesMs[index] } : {}),
      }),
    )
    prev.push(reply)
  })
  const counts = Object.fromEntries(ALL_FLAGS.map((f) => [f, 0])) as Record<LiveTurnFlag, number>
  for (const t of turns) for (const f of t.flags) counts[f] += 1
  const recallTurns = turns.filter((t) => (input.scenario.turns[t.index]?.recallAny?.length ?? 0) > 0)
  const topicTurns = turns.filter((t) => (input.scenario.turns[t.index]?.expectAny?.length ?? 0) > 0)
  return {
    scenarioId: input.scenario.id,
    backend: input.backend,
    turns,
    passRate: turns.length > 0 ? turns.filter((t) => t.pass).length / turns.length : 0,
    counts,
    recall: { hit: recallTurns.filter((t) => !t.flags.includes('recall_miss')).length, total: recallTurns.length },
    onTopic: { hit: topicTurns.filter((t) => !t.flags.includes('off_topic')).length, total: topicTurns.length },
  }
}

/** Plain-text table: one row per (backend, scenario) + totals. */
export function formatLiveEvalTable(scores: readonly LiveConversationScore[]): string {
  const head = ['backend', 'scenario', 'pass', 'echo', 'repeat', 'greet', 'name', 'leak', 'topic', 'recall', 'long', 'empty']
  const rows = scores.map((s) => [
    s.backend,
    s.scenarioId,
    `${Math.round(s.passRate * 100)}%`,
    String(s.counts.echo),
    String(s.counts.repeat),
    String(s.counts.greeting_again),
    String(s.counts.wrong_name),
    String(s.counts.leak),
    s.onTopic.total ? `${s.onTopic.hit}/${s.onTopic.total}` : '-',
    s.recall.total ? `${s.recall.hit}/${s.recall.total}` : '-',
    String(s.counts.too_long),
    String(s.counts.empty),
  ])
  const all = [head, ...rows]
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i]!.length)))
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`
  const sep = `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`
  return [line(head), sep, ...rows.map(line)].join('\n')
}
