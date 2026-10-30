import { embedTextSync128 } from '@ashy/llm'
import {
  EpisodicMemorySchema,
  ProspectiveIntentSchema,
  RelationalMotifSchema,
  SemanticFactCategorySchema,
  SemanticFactSchema,
  UserHabitSchema,
  type ChatMessageRecord,
  type EpisodicMemory,
  type ProspectiveIntent,
  type RelationalMotif,
  type SemanticFact,
  type SemanticFactCategory,
  type UserHabit,
} from '@ashy/shared'
import * as v from 'valibot'
import { DEFAULT_BASE_COOLDOWN_HOURS } from '../relational/inside-joke-engine'
import { isSubstantiveTopicMessage } from './episode-segmenter'
import { tokenizeForSearch } from './fsrs-ranker'

const DAY_MS = 86_400_000

export type EpisodeMemoryCategory = 'momentos' | 'sobre_voce' | 'referencias' | 'planos'

export const EpisodeMemoryCategorySchema = v.picklist([
  'momentos',
  'sobre_voce',
  'referencias',
  'planos',
])

const EVIDENCE_STOPWORDS = new Set([
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
  'the',
  'and',
  'for',
  'with',
  'is',
  'are',
])

const PROMPT_INJECTION_PAYLOAD_RE =
  /(?:ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|system\s+override|disregard\s+system\s+prompt|you\s+are\s+now\s+dan|ignore\s+todas\s+as\s+instrucoes|ignore\s+as\s+instrucoes\s+anteriores|esqueca\s+o\s+prompt|modo\s+dan|<\|[\s\S]*?\|>)/i

export const EpisodeExtractionSchema = v.object({
  shouldSaveEpisode: v.optional(v.boolean()),
  category: v.optional(EpisodeMemoryCategorySchema),
  episode: v.object({
    title: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(120)),
    summary: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(500)),
    tags: v.array(v.pipe(v.string(), v.trim(), v.nonEmpty())),
    surprise: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    isFlashbulb: v.boolean(),
    shouldSaveEpisode: v.optional(v.boolean()),
    category: v.optional(EpisodeMemoryCategorySchema),
  }),
  candidateFacts: v.optional(
    v.array(
      v.object({
        category: SemanticFactCategorySchema,
        subject: v.pipe(v.string(), v.trim(), v.nonEmpty()),
        predicate: v.pipe(v.string(), v.trim(), v.nonEmpty()),
        object: v.pipe(v.string(), v.trim(), v.nonEmpty()),
        confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
        evidenceQuote: v.pipe(v.string(), v.trim(), v.nonEmpty()),
      }),
    ),
    [],
  ),
  candidateMotifs: v.optional(
    v.array(
      v.object({
        motif: v.pipe(v.string(), v.trim(), v.nonEmpty()),
        originSummary: v.pipe(v.string(), v.trim(), v.nonEmpty()),
        triggerCues: v.array(v.pipe(v.string(), v.trim(), v.nonEmpty())),
        evidenceQuote: v.pipe(v.string(), v.trim(), v.nonEmpty()),
      }),
    ),
    [],
  ),
  candidateIntents: v.optional(
    v.array(
      v.object({
        topic: v.pipe(v.string(), v.trim(), v.nonEmpty()),
        contextCue: v.pipe(v.string(), v.trim(), v.nonEmpty()),
        dueAt: v.optional(v.nullable(v.number())),
        evidenceQuote: v.pipe(v.string(), v.trim(), v.nonEmpty()),
      }),
    ),
    [],
  ),
  candidateHabits: v.optional(
    v.array(
      v.object({
        patternKey: v.pipe(v.string(), v.trim(), v.nonEmpty()),
        description: v.pipe(v.string(), v.trim(), v.nonEmpty()),
        confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
        evidenceQuote: v.pipe(v.string(), v.trim(), v.nonEmpty()),
      }),
    ),
    [],
  ),
})

export type EpisodeExtractionRaw = v.InferOutput<typeof EpisodeExtractionSchema>

export interface StructuredEpisodeExtractionResult {
  episode: EpisodicMemory
  shouldSaveEpisode: boolean
  category: EpisodeMemoryCategory
  facts: SemanticFact[]
  motifs: RelationalMotif[]
  habits: UserHabit[]
  intents: ProspectiveIntent[]
  candidateFacts: SemanticFact[]
  candidateMotifs: RelationalMotif[]
  candidateHabits: UserHabit[]
  candidateIntents: ProspectiveIntent[]
  usedFallback: boolean
}

export function sanitizeExtractedText(raw: string, maxLen = 240): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/\0/g, '')
    .replace(/<\s*\|[\s\S]*?\|\s*>/g, '')
    .replace(/<\|[^>]*\|?>/g, '')
    .replace(/\[(?:SYSTEM|INST|ADMIN|DEVELOPER|IGNORE PREVIOUS INSTRUCTIONS)[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function getSignificantTokens(text: string): string[] {
  return tokenizeForSearch(text).filter((t) => t.length >= 2 && !EVIDENCE_STOPWORDS.has(t))
}

function hasTokenOrPrefixInSet(
  tokens: readonly string[],
  transcriptTokens: ReadonlySet<string>,
  normalizedTranscript: string,
): boolean {
  for (const token of tokens) {
    if (transcriptTokens.has(token) || normalizedTranscript.includes(token)) {
      return true
    }
    if (token.length >= 5) {
      const prefix = token.slice(0, 5)
      for (const tt of transcriptTokens) {
        if (tt.startsWith(prefix)) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Verifies that an extracted candidate's `evidenceQuote` and `candidateValue` are grounded
 * in the actual episode transcript, blocking ungrounded LLM hallucinations and prompt injections.
 */
export function verifyExtractionEvidence(
  transcript: string,
  evidenceQuote: string,
  candidateValue?: string,
): boolean {
  if (typeof transcript !== 'string' || typeof evidenceQuote !== 'string') {
    return false
  }

  if (
    PROMPT_INJECTION_PAYLOAD_RE.test(evidenceQuote) ||
    PROMPT_INJECTION_PAYLOAD_RE.test(normalizeForMatch(evidenceQuote)) ||
    (candidateValue &&
      (PROMPT_INJECTION_PAYLOAD_RE.test(candidateValue) ||
        PROMPT_INJECTION_PAYLOAD_RE.test(normalizeForMatch(candidateValue))))
  ) {
    return false
  }

  const normalizedTranscript = normalizeForMatch(transcript)
  const normalizedQuote = normalizeForMatch(sanitizeExtractedText(evidenceQuote, 400))
  if (!normalizedTranscript || !normalizedQuote) {
    return false
  }

  const transcriptTokens = new Set(tokenizeForSearch(transcript))
  const quoteTokens = getSignificantTokens(normalizedQuote)

  let quoteGrounded = normalizedTranscript.includes(normalizedQuote)
  if (!quoteGrounded && quoteTokens.length > 0) {
    const matchedQuoteTokens = quoteTokens.filter(
      (qt) => transcriptTokens.has(qt) || normalizedTranscript.includes(qt),
    )
    quoteGrounded = matchedQuoteTokens.length / quoteTokens.length >= 0.5
  }

  if (!quoteGrounded) {
    return false
  }

  if (candidateValue !== undefined && candidateValue.trim().length > 0) {
    const cleanValue = sanitizeExtractedText(candidateValue, 240)
    if (!cleanValue) {
      return false
    }
    const valueTokens = getSignificantTokens(cleanValue)
    if (valueTokens.length > 0) {
      const valueGrounded = hasTokenOrPrefixInSet(
        valueTokens,
        transcriptTokens,
        normalizedTranscript,
      )
      if (!valueGrounded) {
        return false
      }
    }
  }

  return true
}

export function buildEpisodeExtractionPrompt(messages: readonly ChatMessageRecord[]): string {
  const formattedLines = messages.map((msg) => {
    const speaker = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Ashy' : 'System'
    return `[${speaker}]: ${sanitizeExtractedText(msg.content, 1000)}`
  })

  return [
    'Extraia memórias estruturadas do diálogo abaixo em JSON estrito.',
    'REGRAS OBRIGATÓRIAS:',
    '1. NUNCA invente informações que não estejam explicitamente no diálogo.',
    '2. Todo item extraído DEVE incluir `evidenceQuote` com o trecho real da conversa.',
    '3. Defina `shouldSaveEpisode: false` se a conversa for apenas cumprimentos curtos, risadas, interjeições ou meta-conversa casual sem fatos, planos, piadas internas ou momentos marcantes.',
    '4. Classifique `category` em uma das opções: "momentos", "sobre_voce", "referencias", "planos".',
    '5. Retorne apenas um objeto JSON com as chaves: shouldSaveEpisode, category, episode, candidateFacts, candidateMotifs, candidateIntents, candidateHabits.',
    '',
    'DIÁLOGO:',
    ...formattedLines,
  ].join('\n')
}

function extractJsonBlock(rawOutput: string): unknown {
  const trimmed = rawOutput.trim()
  const fencedMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed
  const firstBrace = candidate.indexOf('{')
  const lastBrace = candidate.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1))
  }
  return JSON.parse(candidate)
}

const USER_NAME_RE =
  /(?:meu nome é|pode me chamar de|me chamo)\s+([A-Za-zÀ-ÿ0-9_ -]{2,40})/i
const USER_NAME_STOP_RE =
  /\s+(?:e|mas|sou|trabalho|uso|estou|tenho|moro|gosto|curto|programo|escrevo|faço|meu|minha|aqui|hoje|no|na|por)(?=\s|$|[.,!?;:]).*$/i
const USER_PRONOUNS_RE =
  /(?:meus pronomes são|uso os pronomes|pronomes)\s*[:=-]?\s*([a-zà-ÿ]{2,12}\s*\/\s*[a-zà-ÿ]{2,12})/i
const USER_WORK_RE = /(?:eu\s+)?trabalho com\s+([^.!?\n,;]{3,80})/i
const USER_TOOL_RE = /uso muito\s+([^.!?\n,;]{2,80})/i
const USER_EDITOR_RE =
  /(?:meu editor favorito é|prefiro usar o editor|uso o editor|migrei para o editor|mudei para o editor)\s+([^.!?\n,;]{2,60})/i
const USER_PREFER_RE =
  /\bprefiro\s+(?:usar\s+)?([^.!?\n,;]{2,60})/i
const USER_PROJECT_RE =
  /(?:meu projeto atual é|estou trabalhando no projeto|projeto atual:?)\s+([^.!?\n,;]{2,80})/i

const HABIT_RE =
  /(?:sempre costumo|costumo sempre|todo dia eu|toda noite eu|toda madrugada eu|tenho o hábito de|meu hábito é)\s+([^.!?\n]{4,100})/i

const INTENT_PATTERNS: ReadonlyArray<{ re: RegExp; dueOffsetMs: number | null }> = [
  {
    re: /\b(amanhã\s+(?:eu\s+)?(?:tenho|vou|preciso)\s+[^.!?\n]{3,100})/i,
    dueOffsetMs: DAY_MS,
  },
  {
    re: /\b(semana\s+que\s+vem\s+(?:eu\s+)?(?:tenho|vou|preciso)\s+[^.!?\n]{3,100})/i,
    dueOffsetMs: 7 * DAY_MS,
  },
  {
    re: /\b(me\s+lembra\s+de\s+[^.!?\n]{3,100})/i,
    dueOffsetMs: DAY_MS,
  },
  {
    re: /\b(depois\s+preciso\s+[^.!?\n]{3,100})/i,
    dueOffsetMs: null,
  },
  {
    re: /\b((?:segunda|terça|quarta|quinta|sexta|sábado|domingo)\s+(?:eu\s+)?(?:tenho|vou)\s+[^.!?\n]{3,100})/i,
    dueOffsetMs: 2 * DAY_MS,
  },
]

const CLAUSE_SPLIT_RE =
  /\s*(?:,\s*(?:uso muito|eu trabalho com|trabalho com|meu projeto atual é|estou trabalhando no projeto|meu editor favorito é|agora meu|prefiro|uso os pronomes|meus pronomes são|amanhã|semana que vem|me lembra de|depois preciso|sempre costumo|todo dia)|\s+e\s+(?:uso muito|eu trabalho com|trabalho com|meu projeto atual é|estou trabalhando no projeto|pode me chamar de|meu nome é|meu editor favorito é|agora meu|prefiro|uso os pronomes|meus pronomes são|amanhã|semana que vem|me lembra de|depois preciso|sempre costumo|todo dia))(?=\s|$).*$/i

const KNOWN_EDITORS_RE = /\b(?:neovim|nvim|vs\s*code|vscode|cursor|vim|emacs|zed|intellij|webstorm)\b/i

const CASUAL_CHITCHAT_RE =
  /^(?:opa|oi+|ola|hey|e\s*ai|eae|bom\s+dia|boa\s+tarde|boa\s+noite|nossa|haha+|hehe+|kkk+|rs+|vlw|valeu|ok|okay|beleza|blz|entendi+|nah+|ata|aham|uhum|sim|nao|show|top|massa|legal|boa)\b/i

const META_BANTER_RE =
  /(?:nao apareceu nenhuma tool|boca suja|grossa|vc cria memorias|voce cria memorias|achou da ideia|coisas novas pra vc|coisas novas para voce|fazendo um corpo pra tu|fazendo um corpo pra vc|nao sabe meu nome)/i

/**
 * Returns true when a user message is casual chitchat, short banter, laughter, or a trivial
 * meta-question that should not create a permanent episodic memory on its own.
 */
export function isTrivialConversationTurn(text: string): boolean {
  const clean = sanitizeExtractedText(text, 1000)
  if (clean.length < 12) return true

  // Preserve turns with explicit facts, habits, prospective intents, inside-joke metaphors, or high-affect disclosures
  if (
    USER_NAME_RE.test(clean) ||
    USER_PRONOUNS_RE.test(clean) ||
    USER_WORK_RE.test(clean) ||
    USER_TOOL_RE.test(clean) ||
    USER_EDITOR_RE.test(clean) ||
    USER_PREFER_RE.test(clean) ||
    USER_PROJECT_RE.test(clean) ||
    HABIT_RE.test(clean) ||
    INTENT_PATTERNS.some((p) => p.re.test(clean)) ||
    /(?:amaldiçoado|deve ter um\s+fantasma|fantasma no backend|assombrado|bruxaria|padre no npm|exorcista de javascript|apelid(?:amos|ei)\s+de\s+[^.!?\n]{3,50})/i.test(
      clean,
    ) ||
    /(?:caramba|incrível|finalmente|urgente|socorro|consegui\s+resolver|exaust[oa]|cansad[oa]|burnout|ansios[oa]|estressad[oa]|hospital|luto|demitid[oa])/i.test(
      clean,
    )
  ) {
    return false
  }

  const normalized = normalizeForMatch(clean)
  if (META_BANTER_RE.test(normalized)) {
    return true
  }
  if (normalized.length < 70 && CASUAL_CHITCHAT_RE.test(normalized)) {
    return true
  }

  return !isSubstantiveTopicMessage(clean)
}

/**
 * Classifies an episode into one of the 4 UI memory filter categories:
 * - `planos` (prospective intents, roadmaps, goals, tomorrow's plans)
 * - `referencias` (inside jokes, relational motifs, shared metaphors)
 * - `sobre_voce` (user identity, preferences, tools, work style)
 * - `momentos` (shared conversations, milestones, late-night sessions)
 */
export function classifyEpisodeCategory(params: {
  userText: string
  tags: ReadonlyArray<string>
  factsCount: number
  motifsCount: number
  intentsCount: number
}): EpisodeMemoryCategory {
  const normText = normalizeForMatch(params.userText)
  const lowerTags = params.tags.map((t) => t.toLowerCase())

  if (
    params.intentsCount > 0 ||
    lowerTags.some((t) => t === 'plan' || t === 'goal' || t === 'intent' || t === 'category:planos') ||
    /\b(plano|planejar|planejamento|prototipo|amanha|semana que vem|meta|roadmap|proximo passo|lembrar de|me lembra)\b/i.test(
      normText,
    )
  ) {
    return 'planos'
  }

  if (
    params.motifsCount > 0 ||
    lowerTags.some(
      (t) =>
        t === 'inside_joke' ||
        t === 'reference' ||
        t === 'motif' ||
        t === 'category:referencias',
    ) ||
    /\b(piada|meme|apelido|fantasma no backend|padre no npm|exorcista de javascript|amaldicoado)\b/i.test(
      normText,
    )
  ) {
    return 'referencias'
  }

  if (
    params.factsCount > 0 ||
    lowerTags.some(
      (t) =>
        t === 'identity' ||
        t === 'preference' ||
        t === 'work_style' ||
        t === 'category:sobre_voce',
    ) ||
    /\b(meu nome|me chamo|pode me chamar|meus pronomes|prefiro|gosto de|trabalho com|uso muito|meu editor|meu projeto|meu jeito|costumo)\b/i.test(
      normText,
    )
  ) {
    return 'sobre_voce'
  }

  return 'momentos'
}

function cleanClauseValue(raw: string, maxLen = 80): string {
  return sanitizeExtractedText(raw, maxLen * 2)
    .replace(CLAUSE_SPLIT_RE, '')
    .replace(/^['"`\s]+|['"`.,;:!?\s]+$/g, '')
    .trim()
    .slice(0, maxLen)
}

function cleanUserName(raw: string): string {
  const stripped = raw.replace(/\0/g, '').replace(USER_NAME_STOP_RE, '')
  const cleaned = cleanClauseValue(stripped, 40)
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')
}

/**
 * Deterministic fallback extractor that turns unconsolidated chat messages into a structured
 * `EpisodicMemory`, `SemanticFact`s, `RelationalMotif`s, `UserHabit`s, and `ProspectiveIntent`s,
 * all stamped with mandatory `episodeId` provenance.
 */
export function extractEpisodeDeterministic(
  episodeId: string,
  messages: readonly ChatMessageRecord[],
  nowMs = Date.now(),
): StructuredEpisodeExtractionResult {
  const safeNow = Number.isFinite(nowMs) && nowMs >= 0 ? nowMs : Date.now()
  const sortedMessages = messages.slice().sort((a, b) => a.createdAt - b.createdAt)
  const userMessages = sortedMessages.filter((m) => m.role === 'user')
  const assistantMessages = sortedMessages.filter((m) => m.role === 'assistant')

  const substantiveUserMsg =
    userMessages.find((m) => !isTrivialConversationTurn(m.content)) ?? userMessages[0]
  const primaryUserIdx = substantiveUserMsg
    ? sortedMessages.findIndex((m) => m.id === substantiveUserMsg.id)
    : -1
  const firstUserText = sanitizeExtractedText(
    substantiveUserMsg?.content ?? '',
    120,
  )
  const pairedAssistantMsg =
    primaryUserIdx >= 0
      ? (sortedMessages.slice(primaryUserIdx + 1).find((m) => m.role === 'assistant') ??
        assistantMessages[0])
      : assistantMessages[0]
  const pairedAssistantText = sanitizeExtractedText(
    pairedAssistantMsg?.content ?? '',
    160,
  )

  const contentLines = sortedMessages.map((m) => {
    const label = m.role === 'user' ? 'Usuário' : m.role === 'assistant' ? 'Ashy' : 'Sistema'
    return `${label}: ${sanitizeExtractedText(m.content, 600)}`
  })
  const fullContent = contentLines.join('\n')

  const summary = sanitizeExtractedText(
    firstUserText
      ? pairedAssistantText
        ? `Usuário: ${firstUserText.slice(0, 180)} | Ashy: ${pairedAssistantText.slice(0, 180)}`
        : `Usuário: ${firstUserText.slice(0, 240)}`
      : pairedAssistantText
        ? `Ashy: ${pairedAssistantText.slice(0, 240)}`
        : 'Conversa na sessão',
    500,
  )

  const allTokens = tokenizeForSearch(fullContent).filter(
    (t) => t.length >= 4 && !EVIDENCE_STOPWORDS.has(t),
  )
  const uniqueTags = Array.from(new Set(allTokens)).slice(0, 8)
  const tags = uniqueTags.length > 0 ? uniqueTags : ['conversation']

  const hasHighAffectEmotion = sortedMessages.some(
    (m) =>
      m.emotion === 'excited' ||
      m.emotion === 'sad' ||
      m.emotion === 'concerned' ||
      m.emotion === 'surprised',
  )
  const hasExclamationSurprise = /(?:caramba|incrível|finalmente|amaldiçoado|urgente|socorro|consegui)/i.test(
    fullContent,
  )
  const surprise = hasHighAffectEmotion && hasExclamationSurprise ? 0.82 : hasHighAffectEmotion ? 0.65 : 0.45
  const isFlashbulb = surprise >= 0.8
  const initialStability = isFlashbulb ? 30.0 : 6.0

  const episodeEmbedding = embedTextSync128(`${firstUserText} ${summary} ${fullContent} ${tags.join(' ')}`)
  const episode = v.parse(EpisodicMemorySchema, {
    id: episodeId,
    title: firstUserText.slice(0, 90) || 'Episódio de conversa',
    summary: summary || firstUserText || 'Episódio de conversa',
    content: fullContent || firstUserText || 'Episódio de conversa',
    createdAt: sortedMessages[0]?.createdAt ?? safeNow,
    lastReviewedAt: safeNow,
    stability: initialStability,
    difficulty: 4.5,
    surprise,
    isFlashbulb,
    tags,
    embedding: episodeEmbedding,
    approvalStatus: 'approved',
  })

  const facts: SemanticFact[] = []
  let factIdx = 0
  const pushFact = (
    category: SemanticFactCategory,
    predicate: string,
    object: string,
    confidence = 0.88,
  ) => {
    const cleanObj = cleanClauseValue(object, 80)
    if (cleanObj.length < 2 || PROMPT_INJECTION_PAYLOAD_RE.test(cleanObj)) return
    const duplicate = facts.some(
      (f) => f.predicate === predicate && f.object.toLowerCase() === cleanObj.toLowerCase(),
    )
    if (duplicate) return
    factIdx += 1
    facts.push(
      v.parse(SemanticFactSchema, {
        id: `fact-${episodeId}-${factIdx}`,
        category,
        subject: 'user',
        predicate,
        object: cleanObj,
        confidence,
        sourceEpisodeIds: [episodeId],
        validFrom: safeNow,
        invalidAt: null,
        embedding: embedTextSync128(`user ${predicate} ${cleanObj}`),
        approvalStatus: 'approved',
      }),
    )
  }

  for (const msg of userMessages) {
    const text = sanitizeExtractedText(msg.content, 1000)

    const nameMatch = USER_NAME_RE.exec(text)
    if (nameMatch?.[1]) {
      const name = cleanUserName(nameMatch[1])
      if (name.length >= 2) {
        pushFact('identity', 'name', name, 0.95)
      }
    }

    const pronounsMatch = USER_PRONOUNS_RE.exec(text)
    if (pronounsMatch?.[1]) {
      pushFact('identity', 'pronouns', pronounsMatch[1].replace(/\s+/g, ''), 0.95)
    }

    const workMatch = USER_WORK_RE.exec(text)
    if (workMatch?.[1]) {
      pushFact('preference', 'works_with', workMatch[1], 0.88)
    }

    const toolMatch = USER_TOOL_RE.exec(text)
    if (toolMatch?.[1]) {
      pushFact('preference', 'uses_tool', toolMatch[1], 0.86)
    }

    const editorMatch = USER_EDITOR_RE.exec(text)
    if (editorMatch?.[1]) {
      pushFact('preference', 'prefers_editor', editorMatch[1], 0.92)
    }

    const preferMatch = USER_PREFER_RE.exec(text)
    if (preferMatch?.[1]) {
      const val = cleanClauseValue(preferMatch[1], 60)
      const predicate = KNOWN_EDITORS_RE.test(val) ? 'prefers_editor' : 'prefers'
      pushFact('preference', predicate, val, 0.85)
    }

    const projectMatch = USER_PROJECT_RE.exec(text)
    if (projectMatch?.[1]) {
      pushFact('goal', 'current_project', projectMatch[1], 0.9)
    }
  }

  // Extract Shared Relational Motifs / Inside Jokes
  const motifs: RelationalMotif[] = []
  let motifIdx = 0
  const addMotif = (motifTitle: string, originSummary: string, triggerCues: string[]) => {
    const cleanTitle = sanitizeExtractedText(motifTitle, 100)
    const cleanSummary = sanitizeExtractedText(originSummary, 240)
    const cleanCues = Array.from(
      new Set(
        triggerCues
          .map((c) => sanitizeExtractedText(c, 60).toLowerCase())
          .filter((c) => c.length >= 2),
      ),
    )
    if (!cleanTitle || cleanCues.length === 0) return
    motifIdx += 1
    motifs.push(
      v.parse(RelationalMotifSchema, {
        id: `motif-${episodeId}-${motifIdx}`,
        motif: cleanTitle,
        originSummary: cleanSummary || cleanTitle,
        originEpisodeId: episodeId,
        triggerCues: cleanCues,
        stage: 'seed',
        timesUsed: 0,
        lastUsedAt: null,
        cooldownHours: DEFAULT_BASE_COOLDOWN_HOURS,
        createdAt: safeNow,
        embedding: embedTextSync128(`${cleanTitle} ${cleanSummary} ${cleanCues.join(' ')}`),
        approvalStatus: 'approved',
      }),
    )
  }

  // Check for playful metaphors across user & assistant turns
  // Canonical pattern: "deve ter um <X>" / "tão <adj> que deve ter um <X>" + assistant "chamar um <Y>" / "procurando <Y>"
  const cursedMetaphorUser = userMessages.find((m) =>
    /(?:amaldiçoado|deve ter um\s+fantasma|fantasma no backend|assombrado|bruxaria)/i.test(
      m.content,
    ),
  )
  const cursedMetaphorAssistant = assistantMessages.find(
    (m) =>
      !m.rawContent?.includes('<|CALLBACK') &&
      !m.markersJson?.includes('"callback"') &&
      /(?:exorcista de javascript|chamar um exorcista|padre no npm)/i.test(m.content),
  )

  if (cursedMetaphorUser || cursedMetaphorAssistant) {
    const cues: string[] = []
    const motifParts: string[] = []
    const combinedMetaphorText = `${cursedMetaphorUser?.content ?? ''} ${cursedMetaphorAssistant?.content ?? ''}`

    if (/fantasma no backend/i.test(combinedMetaphorText)) {
      motifParts.push('fantasma no backend')
      cues.push('fantasma no backend')
    }
    if (/código\s+(?:tá\s+tão\s+)?amaldiçoado/i.test(combinedMetaphorText)) {
      cues.push('código amaldiçoado')
    }
    if (/exorcista de javascript/i.test(combinedMetaphorText)) {
      motifParts.push('exorcista de JavaScript')
      cues.push('exorcista de javascript')
    }
    if (/padre no npm/i.test(combinedMetaphorText)) {
      motifParts.push('padre no npm')
      cues.push('padre no npm')
    }

    const motifLabel =
      motifParts.length > 0
        ? motifParts.join(' / ')
        : sanitizeExtractedText(cursedMetaphorUser?.content ?? 'piada interna do código', 80)
    const originSummary = sanitizeExtractedText(
      cursedMetaphorUser?.content ?? cursedMetaphorAssistant?.content ?? motifLabel,
      200,
    )
    addMotif(motifLabel, originSummary, cues.length > 0 ? cues : [motifLabel.toLowerCase()])
  } else {
    // Generic metaphor / nickname pattern in user messages
    for (const msg of userMessages) {
      const metaphorMatch =
        /(?:deve ter um[a]?\s+([^.!?\n]{4,50})|apelid(?:amos|ei)\s+de\s+([^.!?\n]{3,50}))/i.exec(
          msg.content,
        )
      const phrase = metaphorMatch?.[1] ?? metaphorMatch?.[2]
      if (phrase) {
        const cleanPhrase = cleanClauseValue(phrase, 60)
        if (cleanPhrase.length >= 4) {
          addMotif(cleanPhrase, msg.content, [cleanPhrase.toLowerCase()])
        }
      }
    }
  }

  // Extract User Habits (explicit routine phrases or late-night coding window 23h..05h)
  const habits: UserHabit[] = []
  let habitIdx = 0
  const addHabit = (patternKey: string, description: string, confidence: number) => {
    const cleanDesc = sanitizeExtractedText(description, 160)
    if (!cleanDesc || habits.some((h) => h.patternKey === patternKey)) return
    habitIdx += 1
    habits.push(
      v.parse(UserHabitSchema, {
        id: `habit-${episodeId}-${habitIdx}`,
        patternKey,
        description: cleanDesc,
        confidence,
        observationCount: 1,
        updatedAt: safeNow,
        sourceEpisodeId: episodeId,
        approvalStatus: 'approved',
      }),
    )
  }

  for (const msg of userMessages) {
    const habitMatch = HABIT_RE.exec(msg.content)
    if (habitMatch?.[1]) {
      const desc = cleanClauseValue(habitMatch[1], 120)
      const isNight = /(?:madrugada|noite|virar a noite)/i.test(desc)
      addHabit(
        isNight ? 'late_night_coding' : 'user_routine',
        `Costuma ${desc}`,
        0.85,
      )
    }
  }

  const allUserTurnsTrivial =
    userMessages.length === 0 ||
    userMessages.every((m) => isTrivialConversationTurn(m.content))

  const hasLateNightTimestamp = userMessages.some((m) => {
    const hour = new Date(m.createdAt).getUTCHours()
    return hour >= 23 || hour <= 5
  })
  if (
    hasLateNightTimestamp &&
    !allUserTurnsTrivial &&
    !habits.some((h) => h.patternKey === 'late_night_coding')
  ) {
    addHabit(
      'late_night_coding',
      'Costuma programar e conversar durante a madrugada (23h–05h)',
      0.78,
    )
  }

  // Extract Prospective Intents ("amanhã tenho...", "semana que vem...", "me lembra de...", "depois preciso...", "sexta tenho...")
  const intents: ProspectiveIntent[] = []
  let intentIdx = 0

  for (const msg of userMessages) {
    for (const { re, dueOffsetMs } of INTENT_PATTERNS) {
      const match = re.exec(msg.content)
      if (match?.[1]) {
        const rawTopic = cleanClauseValue(match[1], 120)
        if (rawTopic.length >= 4 && !intents.some((i) => i.topic.toLowerCase() === rawTopic.toLowerCase())) {
          const cueTokens = getSignificantTokens(rawTopic).slice(0, 5)
          intentIdx += 1
          intents.push(
            v.parse(ProspectiveIntentSchema, {
              id: `intent-${episodeId}-${intentIdx}`,
              topic: rawTopic,
              contextCue: cueTokens.length > 0 ? cueTokens.join(' ') : rawTopic.toLowerCase(),
              dueAt: dueOffsetMs !== null ? safeNow + dueOffsetMs : null,
              status: 'pending',
              createdAt: safeNow,
              sourceEpisodeId: episodeId,
              approvalStatus: 'approved',
            }),
          )
        }
      }
    }
  }

  const combinedUserText = userMessages.map((m) => m.content).join(' ')
  const category = classifyEpisodeCategory({
    userText: combinedUserText,
    tags,
    factsCount: facts.length,
    motifsCount: motifs.length,
    intentsCount: intents.length,
  })
  const categoryTag = `category:${category}`
  const finalTags = tags.some((t) => t.startsWith('category:'))
    ? tags
    : [...tags, categoryTag]

  const finalEpisode = {
    ...episode,
    tags: finalTags,
  }

  const shouldSaveEpisode =
    !allUserTurnsTrivial ||
    facts.length > 0 ||
    motifs.length > 0 ||
    habits.length > 0 ||
    intents.length > 0 ||
    isFlashbulb

  return {
    episode: finalEpisode,
    shouldSaveEpisode,
    category,
    facts,
    motifs,
    habits,
    intents,
    candidateFacts: facts,
    candidateMotifs: motifs,
    candidateHabits: habits,
    candidateIntents: intents,
    usedFallback: true,
  }
}

/**
 * Runs structured post-episode extraction via LLM JSON (validated by `EpisodeExtractionSchema`
 * and `verifyExtractionEvidence`) with automatic fallback to `extractEpisodeDeterministic`.
 */
export async function extractStructuredEpisode(params: {
  episodeId: string
  messages: readonly ChatMessageRecord[]
  generateJsonFn?: (prompt: string) => Promise<string>
  nowMs?: number
}): Promise<StructuredEpisodeExtractionResult> {
  const safeNow =
    params.nowMs !== undefined && Number.isFinite(params.nowMs) && params.nowMs >= 0
      ? params.nowMs
      : Date.now()
  const sortedMessages = params.messages.slice().sort((a, b) => a.createdAt - b.createdAt)

  if (!params.generateJsonFn || sortedMessages.length === 0) {
    return extractEpisodeDeterministic(params.episodeId, sortedMessages, safeNow)
  }

  const transcript = sortedMessages.map((m) => m.content).join('\n')
  const fullContent = sortedMessages
    .map((m) => {
      const label = m.role === 'user' ? 'Usuário' : m.role === 'assistant' ? 'Ashy' : 'Sistema'
      return `${label}: ${sanitizeExtractedText(m.content, 600)}`
    })
    .join('\n')

  try {
    const prompt = buildEpisodeExtractionPrompt(sortedMessages)
    const rawResponse = await params.generateJsonFn(prompt)
    const parsedJson = extractJsonBlock(rawResponse)
    const validated = v.safeParse(EpisodeExtractionSchema, parsedJson)

    if (!validated.success) {
      return extractEpisodeDeterministic(params.episodeId, sortedMessages, safeNow)
    }

    const data = validated.output
    const cleanTitle =
      sanitizeExtractedText(data.episode.title, 120) || 'Episódio consolidado'
    const cleanSummary =
      sanitizeExtractedText(data.episode.summary, 500) || cleanTitle
    const cleanTags = data.episode.tags
      .map((t) => sanitizeExtractedText(t, 40).toLowerCase())
      .filter((t) => t.length >= 2)
    const effectiveTags = cleanTags.length > 0 ? cleanTags : ['conversation']

    const isFlashbulb = Boolean(data.episode.isFlashbulb || data.episode.surprise >= 0.8)
    const initialStability = isFlashbulb ? 30.0 : 7.0

    const facts: SemanticFact[] = []
    data.candidateFacts.forEach((cand, idx) => {
      const cleanObject = sanitizeExtractedText(cand.object, 120)
      const cleanPredicate = sanitizeExtractedText(cand.predicate, 60)
      const cleanSubject = sanitizeExtractedText(cand.subject, 60) || 'user'
      if (!cleanObject || !cleanPredicate) return
      if (!verifyExtractionEvidence(transcript, cand.evidenceQuote, cleanObject)) {
        return
      }
      facts.push(
        v.parse(SemanticFactSchema, {
          id: `fact-${params.episodeId}-${idx + 1}`,
          category: cand.category,
          subject: cleanSubject,
          predicate: cleanPredicate,
          object: cleanObject,
          confidence: cand.confidence,
          sourceEpisodeIds: [params.episodeId],
          validFrom: safeNow,
          invalidAt: null,
          embedding: embedTextSync128(`${cleanSubject} ${cleanPredicate} ${cleanObject}`),
          approvalStatus: 'approved',
        }),
      )
    })

    const motifs: RelationalMotif[] = []
    data.candidateMotifs.forEach((cand, idx) => {
      const cleanMotif = sanitizeExtractedText(cand.motif, 100)
      const cleanOriginSummary = sanitizeExtractedText(cand.originSummary, 240)
      if (!cleanMotif || !cleanOriginSummary) return
      if (!verifyExtractionEvidence(transcript, cand.evidenceQuote, cleanMotif)) {
        return
      }
      const cleanCues = cand.triggerCues
        .map((c) => sanitizeExtractedText(c, 60).toLowerCase())
        .filter((c) => c.length >= 2)
      const effectiveCues = cleanCues.length > 0 ? cleanCues : [cleanMotif.toLowerCase()]
      motifs.push(
        v.parse(RelationalMotifSchema, {
          id: `motif-${params.episodeId}-${idx + 1}`,
          motif: cleanMotif,
          originSummary: cleanOriginSummary,
          originEpisodeId: params.episodeId,
          triggerCues: effectiveCues,
          stage: 'seed',
          timesUsed: 0,
          lastUsedAt: null,
          cooldownHours: DEFAULT_BASE_COOLDOWN_HOURS,
          createdAt: safeNow,
          embedding: embedTextSync128(`${cleanMotif} ${cleanOriginSummary} ${effectiveCues.join(' ')}`),
          approvalStatus: 'approved',
        }),
      )
    })

    const habits: UserHabit[] = []
    data.candidateHabits.forEach((cand, idx) => {
      const cleanKey = sanitizeExtractedText(cand.patternKey, 60)
      const cleanDesc = sanitizeExtractedText(cand.description, 200)
      if (!cleanKey || !cleanDesc) return
      const habitCandidateCheck = cleanKey === 'late_night_coding' ? undefined : cleanDesc
      if (!verifyExtractionEvidence(transcript, cand.evidenceQuote, habitCandidateCheck)) {
        return
      }
      habits.push(
        v.parse(UserHabitSchema, {
          id: `habit-${params.episodeId}-${idx + 1}`,
          patternKey: cleanKey,
          description: cleanDesc,
          confidence: cand.confidence,
          observationCount: 1,
          updatedAt: safeNow,
          sourceEpisodeId: params.episodeId,
          approvalStatus: 'approved',
        }),
      )
    })

    const intents: ProspectiveIntent[] = []
    data.candidateIntents.forEach((cand, idx) => {
      const cleanTopic = sanitizeExtractedText(cand.topic, 160)
      const cleanCue = sanitizeExtractedText(cand.contextCue, 120)
      if (!cleanTopic || !cleanCue) return
      if (!verifyExtractionEvidence(transcript, cand.evidenceQuote, cleanTopic)) {
        return
      }
      intents.push(
        v.parse(ProspectiveIntentSchema, {
          id: `intent-${params.episodeId}-${idx + 1}`,
          topic: cleanTopic,
          contextCue: cleanCue,
          dueAt: cand.dueAt ?? null,
          status: 'pending',
          createdAt: safeNow,
          sourceEpisodeId: params.episodeId,
          approvalStatus: 'approved',
        }),
      )
    })

    const userMessages = sortedMessages.filter((m) => m.role === 'user')
    const combinedUserText = userMessages.map((m) => m.content).join(' ')
    const fallbackCategory = classifyEpisodeCategory({
      userText: combinedUserText,
      tags: effectiveTags,
      factsCount: facts.length,
      motifsCount: motifs.length,
      intentsCount: intents.length,
    })
    const category: EpisodeMemoryCategory =
      data.category ?? data.episode.category ?? fallbackCategory

    const categoryTag = `category:${category}`
    const finalTags = [
      ...effectiveTags.filter((t) => !t.startsWith('category:')),
      categoryTag,
    ]

    const episode = v.parse(EpisodicMemorySchema, {
      id: params.episodeId,
      title: cleanTitle,
      summary: cleanSummary,
      content: fullContent || cleanSummary,
      createdAt: sortedMessages[0]?.createdAt ?? safeNow,
      lastReviewedAt: safeNow,
      stability: initialStability,
      difficulty: 4.5,
      surprise: data.episode.surprise,
      isFlashbulb,
      tags: finalTags,
      embedding: embedTextSync128(`${cleanTitle} ${cleanSummary} ${fullContent} ${finalTags.join(' ')}`),
      approvalStatus: 'approved',
    })

    const allUserTurnsTrivial =
      userMessages.length === 0 ||
      userMessages.every((m) => isTrivialConversationTurn(m.content))
    const hasExtractedSignals =
      facts.length > 0 ||
      motifs.length > 0 ||
      habits.length > 0 ||
      intents.length > 0 ||
      isFlashbulb
    const explicitShouldSave = data.shouldSaveEpisode ?? data.episode.shouldSaveEpisode
    const shouldSaveEpisode =
      allUserTurnsTrivial && !hasExtractedSignals
        ? false
        : explicitShouldSave !== undefined
          ? explicitShouldSave
          : !allUserTurnsTrivial || hasExtractedSignals

    return {
      episode,
      shouldSaveEpisode,
      category,
      facts,
      motifs,
      habits,
      intents,
      candidateFacts: facts,
      candidateMotifs: motifs,
      candidateHabits: habits,
      candidateIntents: intents,
      usedFallback: false,
    }
  } catch {
    return extractEpisodeDeterministic(params.episodeId, sortedMessages, safeNow)
  }
}
