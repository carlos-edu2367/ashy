/**
 * Conversation hygiene (2026-11-01, small-model conversation quality).
 *
 * Pure helpers that keep Ashy's memory from feeding a small model its own bad wording back:
 * - `conversationSimilarity` — token Jaccard / containment, accent- and stopword-insensitive;
 * - `isEchoReply` — the reply repeats the user's utterance (LFM3-2B "echo" failure);
 * - `isGreetingOnlyReply` — a reply that is only a greeting + generic offer ("Olá, Carlos! Tudo bem.
 *   Como posso te ajudar hoje?"), the greeting-loop line;
 * - `isPlaceholderUtterance` — internal markers that leaked into the chat ("[Mensagem de voz Omni]",
 *   "ashy-omni-turn-rev-1", "...");
 * - `extractUserUtterances` — the USER side of an episodic memory ("Usuário: …" lines of the content or the
 *   summary), never Ashy's wording.
 *
 * Used by the per-turn indexer (`indexTurnMemory`), the deterministic episode extractor, the Live Call
 * memory selector (host) and the live-conversation eval scorer.
 */

const STOPWORDS = new Set(
  (
    'a o e as os um uma uns umas de do da dos das em no na nos nas ao aos com sem por para pra pro que se ' +
    'eu tu voce voces ele ela eles elas nos me te lhe meu minha seu sua isso isto esse essa este esta aquilo ' +
    'aqui ai la ou mas mais muito muita tudo nada nao sim ja so tambem como quando onde foi ser sao estar ' +
    'esta estou tem ter vai vou ha bem entao'
  ).split(' '),
)

export function normalizeConversationText(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function contentTokens(text: string): string[] {
  const all = normalizeConversationText(text)
    .split(' ')
    .filter((t) => t.length > 0)
  const content = all.filter((t) => !STOPWORDS.has(t))
  return content.length > 0 ? content : all
}

/**
 * Similarity in [0, 1]: max(Jaccard of the content-token sets, containment of the smaller set in the
 * bigger one — containment only counts when the smaller side has ≥ 3 distinct tokens).
 */
export function conversationSimilarity(a: string, b: string): number {
  const ta = new Set(contentTokens(a))
  const tb = new Set(contentTokens(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter += 1
  const union = ta.size + tb.size - inter
  const jaccard = union > 0 ? inter / union : 0
  const minSize = Math.min(ta.size, tb.size)
  const containment = minSize >= 3 ? inter / minSize : 0
  return Math.max(jaccard, containment)
}

/** First sentence of a text ('' when empty). */
export function firstSentence(text: string): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  const m = /^(.+?[.!?…])(\s|$)/.exec(t)
  return (m ? m[1]! : t).trim()
}

export const ECHO_SIMILARITY = 0.6
/** Words that add nothing to an echoed utterance ("Olá, Carlos! <utterance>"). */
const ECHO_FILLER_WORDS = new Set(
  'ola oi ei ah ahh hum hmm opa claro certo entendi beleza ok okay obrigado obrigada valeu ashy amigo amiga ne tipo'.split(' '),
)

/** Share of the reply's content words that are NOT in the user's utterance. */
export function replyNovelty(user: string, reply: string): number {
  const u = new Set(contentTokens(user))
  const r = new Set(contentTokens(reply))
  if (r.size === 0) return 0
  let novel = 0
  for (const t of r) if (!u.has(t)) novel += 1
  return novel / r.size
}

/**
 * True when `reply` parrots `user`:
 * - identical, or the reply literally starts with the utterance (≥ 3 words);
 * - the reply's first sentence ≈ the utterance (similarity ≥ 0.8, utterance ≥ 2 words);
 * - the reply as a whole is the utterance plus fillers only (greetings, names, "claro"…).
 * An answer that restates the question ("A capital da Austrália é Canberra") is NOT an echo.
 */
export function isEchoReply(
  user: string,
  reply: string,
  opts: { threshold?: number; userName?: string | null } = {},
): boolean {
  const threshold = opts.threshold ?? ECHO_SIMILARITY
  const nameTokens = new Set(normalizeConversationText(opts.userName ?? '').split(' ').filter(Boolean))
  const u = normalizeConversationText(user)
  const r = normalizeConversationText(reply)
  if (u.length === 0 || r.length === 0) return false
  if (r === u) return true
  const userWords = u.split(' ').length
  if (userWords >= 3 && r.startsWith(u)) return true
  const first = firstSentence(reply)
  if (userWords >= 2 && first.length > 0 && conversationSimilarity(user, first) >= 0.8) {
    // "Sim." / "Claro!" first sentences are too short to judge.
    if (contentTokens(first).length >= 2) return true
  }
  const ta = new Set(contentTokens(user))
  const tb = new Set(contentTokens(reply))
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter += 1
  const jaccard = inter / (ta.size + tb.size - inter || 1)
  if (ta.size < 2 || jaccard < threshold - 0.1) return false
  // A clarifying question built from the user's words ("O que você está tentando resolver?") answers a
  // statement; it is not a parrot.
  if (!user.trim().endsWith('?') && reply.trim().endsWith('?')) return false
  // Whatever the reply adds besides greetings / names / fillers: nothing → it is the utterance again.
  let meaningfulNovel = 0
  for (const t of tb) if (!ta.has(t) && !ECHO_FILLER_WORDS.has(t) && !nameTokens.has(t)) meaningfulNovel += 1
  return meaningfulNovel === 0
}

const GREETING_OPENER_RE =
  /^(?:ol[aá]+|oi+e?|opa|ei|hey|e\s*a[ií]|eae|al[oô]|bom\s+dia|boa\s+tarde|boa\s+noite|tudo\s+bem|tudo\s+bom|que\s+bom\s+(?:te\s+)?(?:ver|ouvir))(?=[\s,.!?]|$)/i

/** True when a reply OPENS with a greeting ("Olá, Carlos! …", "Oi! …", "Tudo bem? …"). */
export function startsWithGreeting(text: string): boolean {
  return GREETING_OPENER_RE.test((text ?? '').trim())
}

const GENERIC_OFFER_RE =
  /(?:como\s+(?:eu\s+)?posso\s+(?:te\s+)?ajudar|em\s+que\s+posso\s+(?:te\s+)?ajudar|posso\s+te\s+ajudar|o\s+que\s+(?:voc[eê]|vc)\s+(?:quer|precisa|gostaria)|estou\s+aqui|t[oô]\s+aqui|pronta\s+para\s+te\s+ouvir|obrigad[oa]\s+por\s+perguntar|tudo\s+(?:bem|bom|certo|[oó]timo)|que\s+bom|hoje)/gi

/**
 * True when a reply is ONLY a greeting and/or a generic offer of help — nothing a memory should keep
 * ("Olá, Carlos! Tudo bem. Como posso te ajudar hoje?").
 */
export function isGreetingOnlyReply(text: string, userName?: string | null): boolean {
  let t = (text ?? '').trim()
  if (t.length === 0) return false
  if (!startsWithGreeting(t) && !GENERIC_OFFER_RE.test(t)) return false
  GENERIC_OFFER_RE.lastIndex = 0
  t = t.replace(GREETING_OPENER_RE, ' ').replace(GENERIC_OFFER_RE, ' ')
  GENERIC_OFFER_RE.lastIndex = 0
  const name = normalizeConversationText(userName ?? '')
  let rest = normalizeConversationText(t)
  if (name.length > 0) rest = rest.replace(new RegExp(`\\b${name}\\b`, 'g'), ' ')
  rest = rest.replace(/\b(?:ol[a]+|oi+|ashy|amigo|amiga|sim|claro|entao|bom|boa|agora|aqui|com|voce|vc|te|o|a|e|que|eu)\b/g, ' ')
  return rest.replace(/\s+/g, '').length <= 6
}

const PLACEHOLDER_RE =
  /^(?:\[[^\]]{1,80}\]|\(?[a-z0-9]+(?:-[a-z0-9]+){2,}\)?|[.\s…?!-]*|ashy-[\w-]+)$/i

/** Internal markers / ids / bare punctuation that are not real utterances. */
export function isPlaceholderUtterance(text: string): boolean {
  const t = (text ?? '').trim()
  if (t.length === 0) return true
  return PLACEHOLDER_RE.test(t)
}

const USER_LINE_RE = /^(?:usu[aá]rio|user)\s*:\s*(.+)$/i
const ASSISTANT_SEGMENT_RE = /\|\s*(?:ashy|assistente|assistant)\s*:[\s\S]*$/i

/**
 * The user-side utterances of an episodic memory, in order, without Ashy's wording:
 * - "Usuário: …" lines of `content` (multi-turn episodes);
 * - else the "Usuário: …" part of a "Usuário: X | Ashy: Y" summary;
 * - else nothing (free-text summaries are handled by the caller).
 */
export function extractUserUtterances(memory: { summary?: string | null; content?: string | null }): string[] {
  const out: string[] = []
  for (const raw of (memory.content ?? '').split(/\r?\n/)) {
    const m = USER_LINE_RE.exec(raw.trim())
    if (m?.[1]) out.push(m[1].trim())
  }
  if (out.length > 0) return out
  const summary = (memory.summary ?? '').trim()
  const sm = /^(?:usu[aá]rio|user)\s*:\s*(.+)$/i.exec(summary)
  if (sm?.[1]) {
    const userPart = sm[1].replace(ASSISTANT_SEGMENT_RE, '').trim()
    if (userPart.length > 0) out.push(userPart)
  }
  return out
}

/** True when a summary is a transcript-style pairing ("Usuário: … | Ashy: …" / "Ashy: …"). */
export function isTranscriptStyleSummary(summary: string): boolean {
  return /(?:^|\|)\s*(?:usu[aá]rio|user|ashy|assistente|assistant)\s*:/i.test(summary ?? '')
}

/**
 * Light "is there anything to remember here?" check for user utterances (memory selection): not a
 * placeholder, not a bare greeting, and ≥ 3 content words ("Meu gato se chama Biscoito" passes,
 * "Não sei isso, Carlos" / "Olá, tudo bem?" do not).
 */
export function hasMemorableContent(text: string): boolean {
  const t = (text ?? '').trim()
  if (isPlaceholderUtterance(t)) return false
  const tokens = new Set(
    normalizeConversationText(t)
      .split(' ')
      .filter((w) => w.length > 0 && !STOPWORDS.has(w)),
  )
  if (startsWithGreeting(t) && tokens.size <= 4) return false
  return tokens.size >= 3
}
