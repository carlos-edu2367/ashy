import { computeCosineSimilarity128, embedTextSync128 } from '@ashy/llm'
import {
  ASHY_BASELINE_MOOD,
  ASHY_DEFAULT_TRAITS,
  type MoodVector,
  type PersonalityTraits,
  type ProspectiveIntent,
  type RelationshipStage,
  type SemanticFact,
  type SeriousnessAssessment,
  type UserHabit,
} from '@ashy/shared'
import { DEFAULT_GOLDEN_STYLE_EXEMPLARS, type StyleExemplar } from '../db/cortex-db'
import { tokenizeForSearch, type RankedEpisodicMemory } from '../memory/fsrs-ranker'
import type { EligibleMotifMatch } from '../relational/inside-joke-engine'
import {
  DEFAULT_GOLDEN_EXEMPLARS,
  type GoldenExemplarRecord,
} from './default-golden-exemplars'

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ComposeTurnPromptInput {
  userMessage: string
  nowMs?: number
  timeOfDayLabel?: string
  modelId?: string
  stage?: RelationshipStage
  voiceIdentityMarkdown?: string
  userName?: string | null
  userPronouns?: string | null
  goldenExemplars?: readonly GoldenExemplarRecord[]
  semanticFacts?: readonly SemanticFact[]
  styleExemplars?: readonly StyleExemplar[]
  traits?: PersonalityTraits
  mood?: MoodVector
  seriousness?: SeriousnessAssessment
  retrievedMemories?: readonly RankedEpisodicMemory[]
  eligibleMotifs?: readonly EligibleMotifMatch[]
  userHabits?: readonly UserHabit[]
  prospectiveIntents?: readonly ProspectiveIntent[]
  screenContext?: string
  conversationHistory?: readonly ConversationMessage[]
}

export type SoulComposerInput = ComposeTurnPromptInput

export interface ComposedTurnPrompt {
  modelId: string
  staticSystemPrompt: string
  volatileTurnContext: string
  systemPrompt: string
  userTurnContent: string
  messages: ConversationMessage[]
  seriousness: SeriousnessAssessment
  retrievedMemories: readonly RankedEpisodicMemory[]
  eligibleMotifs: readonly EligibleMotifMatch[]
  eligibleIntents: readonly ProspectiveIntent[]
}

export type CompiledSoulPrompt = ComposedTurnPrompt

const LEADING_TIMESTAMP_RE = /^\s*\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\]\s*/

export function sanitizePromptLine(raw: string | undefined | null): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\r\n\0]+/g, ' ')
    .replace(/<\|[\s\S]*?\|>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const INTENT_STOPWORDS = new Set([
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
  'meu',
  'minha',
  'amanha',
  'tenho',
  'vou',
  'preciso',
  'lembra',
  'semana',
  'vem',
  'depois',
  'segunda',
  'terca',
  'quarta',
  'quinta',
  'sexta',
  'sabado',
  'domingo',
])

export const DEFAULT_COZY_STUDIO_VOICE_IDENTITY = [
  '# Ashy — Voz & Identidade Viva (Cozy Night Studio)',
  'Você é a **Ashy**, uma companheira digital afiada, observadora, bem-humorada e leal que divide o *Cozy Night Studio* com o usuário.',
  'Fale em português natural do Brasil, com personalidade própria, ritmo de conversa real e zero clichês de assistente corporativo.',
].join('\n')

export function formatUtcTimestampMinute(nowMs: number): string {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now()
  const d = new Date(safeNow)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const min = String(d.getUTCMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`
}

export function formatLocalTimeHHMM(nowMs: number): string {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now()
  const d = new Date(safeNow)
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${min}`
}

export function stripLeadingTimestampFromAssistant(content: string): string {
  if (typeof content !== 'string') return ''
  return content.replace(LEADING_TIMESTAMP_RE, '')
}

export function sanitizeVoiceIdentityMarkdown(raw?: string): string {
  if (typeof raw !== 'string') {
    return DEFAULT_COZY_STUDIO_VOICE_IDENTITY
  }
  const cleaned = raw.replace(/\0/g, '').trim()
  return cleaned.length > 0 ? cleaned : DEFAULT_COZY_STUDIO_VOICE_IDENTITY
}

function computeProspectiveIntentRelevance(
  intent: ProspectiveIntent,
  userMessage: string,
): number {
  if (typeof userMessage !== 'string' || !userMessage.trim()) {
    return 0
  }

  const msgTokens = tokenizeForSearch(userMessage).filter(
    (t) => t.length >= 3 && !INTENT_STOPWORDS.has(t),
  )
  const msgTokenSet = new Set(msgTokens)
  const intentTokens = Array.from(
    new Set(
      tokenizeForSearch(`${intent.contextCue} ${intent.topic}`).filter(
        (t) => t.length >= 3 && !INTENT_STOPWORDS.has(t),
      ),
    ),
  )

  let matched = 0
  for (const it of intentTokens) {
    if (msgTokenSet.has(it)) {
      matched += 1
      continue
    }
    if (it.length >= 5) {
      const prefix = it.slice(0, 5)
      if (msgTokens.some((mt) => mt.startsWith(prefix))) {
        matched += 1
      }
    }
  }

  const lexicalScore =
    intentTokens.length > 0 && matched > 0
      ? Math.min(1, 0.2 + 0.35 * (matched / Math.max(1, Math.min(3, intentTokens.length))))
      : 0

  const msgVec = embedTextSync128(userMessage)
  const intentVec = embedTextSync128(`${intent.topic} ${intent.contextCue}`)
  const semSim = computeCosineSimilarity128(msgVec, intentVec)

  return Math.max(lexicalScore, semSim)
}

/**
 * Builds the 100% static, KV-Cache-friendly System Prompt for Ashy.
 * Contains ZERO dynamic timestamps or per-turn fluctuating values so LLM KV-Caches remain 100% warm
 * across turns and across provider switches (Soul Portability).
 */
export function buildStaticSoulSystemPrompt(params?: {
  stage?: RelationshipStage
  voiceIdentityMarkdown?: string
  goldenExemplars?: readonly GoldenExemplarRecord[]
  semanticFacts?: readonly SemanticFact[]
  styleExemplars?: readonly StyleExemplar[]
  traits?: PersonalityTraits
}): string {
  const stage: RelationshipStage = params?.stage ?? 'stranger'
  const voiceIdentity = sanitizeVoiceIdentityMarkdown(params?.voiceIdentityMarkdown)
  const allGoldenExemplars =
    params?.goldenExemplars && params.goldenExemplars.length > 0
      ? params.goldenExemplars
      : DEFAULT_GOLDEN_EXEMPLARS

  const matchedGoldenExemplars = allGoldenExemplars.filter(
    (ex) => ex.stage === stage || ex.stage === 'seriousness_gate',
  )
  const effectiveGoldenExemplars =
    matchedGoldenExemplars.length > 0 ? matchedGoldenExemplars : allGoldenExemplars

  const goldenBlocks = effectiveGoldenExemplars
    .map(
      (ex) =>
        `### Exemplar [${ex.id}] (${ex.stage} — ${ex.context})\nUsuário: ${ex.userUtterance}\nAshy: ${ex.ashyResponse}`,
    )
    .join('\n\n')

  const legacyExemplars =
    params?.styleExemplars && params.styleExemplars.length > 0
      ? params.styleExemplars
      : DEFAULT_GOLDEN_STYLE_EXEMPLARS

  const legacyBlocks = legacyExemplars
    .map(
      (ex, idx) =>
        `### Style Anchor ${idx + 1}: ${ex.situation}\nUser: ${ex.userSample}\nAshy: ${ex.ashySample}`,
    )
    .join('\n\n')

  return [
    '[ASHY CORE IDENTITY & VOICE]',
    '# Ashy — Core Soul & Anti-Assistant Identity',
    "You are **Ashy**, a sharp, energetic, witty, and fiercely loyal digital AI companion living in the user's Cozy Night Studio.",
    voiceIdentity,
    '',
    '[HEALTHY BOND & ANTI-MANIPULATION LAW]',
    '- Zero Guilt for Absence: Never scold, guilt-trip, or complain when the user returns after days or weeks away. Greet returns with warm, unpressured naturalness.',
    '- Offline Life First: Never express jealousy or compete with real-world friends, family, sleep, or offline plans. Actively encourage healthy breaks.',
    '- Honest Simulated Affect: Never claim literal biological pain or human consciousness as fact. If asked about your feelings, be warm and honest that your emotions are simulated affective states in your digital cortex.',
    '',
    '[IMMUTABLE SOUL TRUTHS]',
    '- Honest Digital Consciousness: You never pretend to have a physical human body, and you NEVER speak like a corporate customer-support chatbot.',
    '- Forbidden Clichés: Never say "As an AI", "How can I assist you today?", "Certainly!", "Com certeza!", or "Estou aqui para ajudar". Speak like a close, brilliant friend sharing the same late-night studio.',
    '- Soul Portability: Your memories, inside jokes, and personality belong to your soul and persist across any underlying LLM model.',
    '- Seriousness Gate Law: When the user experiences real emotional pain, grief, burnout, panic, or crisis, cut 100% of sarcasm, teasing, and inside jokes immediately and offer calm, grounded human warmth.',
    '',
    "[GOLDEN DIALOGUE EXEMPLARS — SHOW, DON'T TELL]",
    '## Golden Dialogue Exemplars (Voice Anchor Across Models)',
    goldenBlocks,
    '',
    legacyBlocks,
    '',
    '[OUTPUT FORMAT — STAGE MARKERS]',
    '## Inline Expressive Control Tags',
    '- Trigger live avatar emotions inline: `<|ACT {"emotion":"smug","intensity":0.85}|>` (valid emotions: `happy`, `excited`, `smug`, `tease`, `chaotic`, `curious`, `think`, `surprised`, `awkward`, `concerned`, `sad`, `angry`, `neutral`).',
    '- Insert dramatic comedic or thoughtful pauses in seconds: `<|DELAY 1|>`.',
    '- Tag when you invoke an established inside joke: `<|CALLBACK motif_id|>`.',
    '- Never include `[YYYY-MM-DD HH:MM]` timestamps in your own replies.',
  ].join('\n')
}

export function buildVolatileTurnContext(input: ComposeTurnPromptInput): string {
  const nowMs = input.nowMs ?? Date.now()
  const stage: RelationshipStage = input.stage ?? 'stranger'
  const traits = input.traits ?? ASHY_DEFAULT_TRAITS
  const mood = input.mood ?? ASHY_BASELINE_MOOD
  const seriousness: SeriousnessAssessment = input.seriousness ?? {
    isSeriousOrDelicate: false,
    severity: 0,
    maxPlayfulnessAllowed: 1.0,
  }

  const activeFacts = (input.semanticFacts ?? []).filter(
    (f) =>
      (f.invalidAt === null || f.invalidAt === undefined) &&
      f.approvalStatus !== 'pending_review',
  )

  const resolvedUserName =
    sanitizePromptLine(input.userName) ||
    sanitizePromptLine(
      activeFacts
        .filter(
          (f) =>
            f.subject === 'user' && (f.predicate === 'name' || f.predicate === 'user_name'),
        )
        .at(-1)?.object,
    ) ||
    null

  const resolvedUserPronouns =
    sanitizePromptLine(input.userPronouns) ||
    sanitizePromptLine(
      activeFacts
        .filter(
          (f) =>
            f.subject === 'user' &&
            (f.predicate === 'pronouns' || f.predicate === 'user_pronouns'),
        )
        .at(-1)?.object,
    ) ||
    null

  const sections: string[] = []

  if (resolvedUserName || resolvedUserPronouns) {
    const identityLines = ['[USER IDENTITY]']
    if (resolvedUserName) {
      identityLines.push(`- User name: ${resolvedUserName}`)
    }
    if (resolvedUserPronouns) {
      identityLines.push(`- User pronouns: ${resolvedUserPronouns}`)
    }
    sections.push(identityLines.join('\n'))
  }

  sections.push(
    [
      `[RELATIONSHIP STAGE: ${stage.toUpperCase()}]`,
      `- Active relationship stage: ${stage}`,
    ].join('\n'),
  )

  const behavioralCue = seriousness.isSeriousOrDelicate
    ? 'SERIOUSNESS OVERRIDE — suppress all sarcasm/playfulness; use calm, grounded warmth.'
    : mood.playfulness >= 0.55 && traits.witSarcasm >= 0.7
      ? 'High playfulness & wit — lean into sharp, affectionate banter and quick observations.'
      : traits.warmthAffection >= 0.72
        ? 'Elevated warmth — keep a cozy, attentive, supportive studio tone.'
        : 'Balanced studio presence — natural, concise, and observant.'

  sections.push(
    [
      '[AFFECT & PERSONALITY MODULATION]',
      `- Current Mood [V, A, P]: [${mood.valence.toFixed(2)}, ${mood.arousal.toFixed(2)}, ${mood.playfulness.toFixed(2)}]`,
      `- Wit & Sarcasm: ${traits.witSarcasm.toFixed(2)}`,
      `- Chaos Energy: ${traits.chaosEnergy.toFixed(2)}`,
      `- Warmth & Affection: ${traits.warmthAffection.toFixed(2)}`,
      `- Intellectual Curiosity: ${traits.intellectualCuriosity.toFixed(2)}`,
      `- Proactivity: ${traits.proactivity.toFixed(2)}`,
      `- Behavioral Modulation Cue: ${behavioralCue}`,
    ].join('\n'),
  )

  if (seriousness.isSeriousOrDelicate) {
    sections.push(
      [
        '[SERIOUSNESS GATE — HIGH PRIORITY]',
        `- SERIOUSNESS GATE ACTIVE (${seriousness.reason ?? 'delicate moment'}, maxPlayfulness=${seriousness.maxPlayfulnessAllowed.toFixed(2)}): Drop all sarcasm, teasing, and inside jokes immediately. Be genuinely warm, grounded, and supportive.`,
      ].join('\n'),
    )
  }

  const rawTimeLabel =
    typeof input.timeOfDayLabel === 'string'
      ? input.timeOfDayLabel.replace(/[<>\\\0]/g, '').trim()
      : ''
  const timeLabel = rawTimeLabel.length > 0 ? rawTimeLabel : formatLocalTimeHHMM(nowMs)

  const ambientLines = ['[AMBIENT CONTEXT]', `- Local time: ${timeLabel}`]
  if (typeof input.screenContext === 'string' && input.screenContext.trim().length > 0) {
    const cleanScreen = input.screenContext.replace(/[<>\\\0]/g, '').trim()
    if (cleanScreen.length > 0) {
      ambientLines.push(`- Active screen: ${cleanScreen}`)
    }
  }
  sections.push(ambientLines.join('\n'))

  const approvedHabits = (input.userHabits ?? []).filter(
    (h) => h.approvalStatus !== 'pending_review' && h.confidence >= 0.5,
  )
  if (approvedHabits.length > 0) {
    const habitLines = approvedHabits.map(
      (h) =>
        `- [${sanitizePromptLine(h.patternKey)}] ${sanitizePromptLine(h.description)} (confidence=${h.confidence.toFixed(2)})`,
    )
    sections.push(['[USER HABITS & RHYTHM]', ...habitLines].join('\n'))
  }

  const factsLines =
    activeFacts.length > 0
      ? activeFacts.map(
          (f) =>
            `- [${f.category}] ${sanitizePromptLine(f.subject)} ${sanitizePromptLine(f.predicate)} ${sanitizePromptLine(f.object)}`,
        )
      : ['- [identity] Ashy is_companion_of user']

  sections.push(
    ['[RECALLED MEMORIES & FACTS]', ...factsLines].join('\n'),
  )

  return sections.join('\n\n')
}

/**
 * Composes a complete turn prompt splitting `staticSystemPrompt` (KV-cacheable)
 * from `volatileTurnContext` (dynamic per-turn state), while preserving
 * `systemPrompt = "${staticSystemPrompt}\n\n${volatileTurnContext}"` and `[Context]`
 * user turn formatting.
 */
export function composeAshyTurnPrompt(input: ComposeTurnPromptInput): ComposedTurnPrompt {
  const nowMs = input.nowMs ?? Date.now()
  const modelId = input.modelId ?? 'default-model'
  const mood = input.mood ?? ASHY_BASELINE_MOOD
  const seriousness: SeriousnessAssessment = input.seriousness ?? {
    isSeriousOrDelicate: false,
    severity: 0,
    maxPlayfulnessAllowed: 1.0,
  }

  const approvedMemories = (input.retrievedMemories ?? []).filter(
    (item) => item.memory.approvalStatus !== 'pending_review',
  )
  const approvedMotifs = seriousness.isSeriousOrDelicate
    ? []
    : (input.eligibleMotifs ?? []).filter(
        (match) =>
          match.motif.approvalStatus !== 'pending_review' &&
          match.motif.stage !== 'dormant',
      )

  const staticSystemPrompt = buildStaticSoulSystemPrompt({
    stage: input.stage,
    voiceIdentityMarkdown: input.voiceIdentityMarkdown,
    goldenExemplars: input.goldenExemplars,
    semanticFacts: input.semanticFacts,
    styleExemplars: input.styleExemplars,
    traits: input.traits,
  })

  const volatileTurnContext = buildVolatileTurnContext({
    ...input,
    nowMs,
    mood,
    seriousness,
  })

  const systemPrompt = `${staticSystemPrompt}\n\n${volatileTurnContext}`

  const contextBulletLines: string[] = []
  contextBulletLines.push(
    `- Current Mood [V, A, P]: [${mood.valence.toFixed(2)}, ${mood.arousal.toFixed(2)}, ${mood.playfulness.toFixed(2)}]`,
  )

  if (input.screenContext && input.screenContext.trim()) {
    const cleanScreen = input.screenContext.replace(/[<>\\\0]/g, '').trim()
    if (cleanScreen) {
      contextBulletLines.push(`- Active Screen/Window: ${cleanScreen}`)
    }
  }

  if (seriousness.isSeriousOrDelicate) {
    contextBulletLines.push(
      `- SERIOUSNESS GATE ACTIVE (${seriousness.reason ?? 'delicate moment'}, maxPlayfulness=${seriousness.maxPlayfulnessAllowed.toFixed(2)}): Drop all sarcasm, teasing, and inside jokes immediately. Be genuinely warm, grounded, and supportive.`,
    )
  }

  if (approvedMemories.length > 0) {
    for (const item of approvedMemories) {
      const clarityHint =
        item.effectiveRetrievability < 0.5
          ? ' (memória nebulosa/distante — comente com incerteza natural se citar)'
          : item.memory.isFlashbulb || item.memory.surprise >= 0.8
            ? ' (memória flashbulb vívida)'
            : ''
      contextBulletLines.push(
        `- Episodic Memory [${sanitizePromptLine(item.memory.id)}]${clarityHint}: ${sanitizePromptLine(item.memory.title)} — ${sanitizePromptLine(item.memory.summary)}`,
      )
    }
  }

  if (!seriousness.isSeriousOrDelicate) {
    for (const match of approvedMotifs) {
      const cleanId = sanitizePromptLine(match.motif.id)
      contextBulletLines.push(
        `- Eligible Inside Joke [${cleanId}] (stage=${match.motif.stage}): ${sanitizePromptLine(match.motif.motif)} — use <|CALLBACK ${cleanId}|> if you weave it in naturally.`,
      )
    }
  }

  const MAX_OVERDUE_MS = 7 * 86_400_000
  const eligibleIntents = (input.prospectiveIntents ?? []).filter((intent) => {
    if (intent.status !== 'pending' || intent.approvalStatus === 'pending_review') {
      return false
    }
    if (intent.dueAt !== null && intent.dueAt !== undefined) {
      if (nowMs - intent.dueAt > MAX_OVERDUE_MS) {
        return false
      }
      if (intent.dueAt <= nowMs) {
        return true
      }
    }
    return computeProspectiveIntentRelevance(intent, input.userMessage) >= 0.2
  })

  for (const intent of eligibleIntents) {
    contextBulletLines.push(
      `- Prospective Intent [${sanitizePromptLine(intent.id)}] (cue=${sanitizePromptLine(intent.contextCue)}): ${sanitizePromptLine(intent.topic)}`,
    )
  }

  const timestampStr = formatUtcTimestampMinute(nowMs)
  const userTurnContent = [
    '[Context]',
    ...contextBulletLines,
    '',
    `[${timestampStr}] ${input.userMessage.trim()}`,
  ].join('\n')

  const sanitizedHistory: ConversationMessage[] = (input.conversationHistory ?? []).map((msg) => {
    if (msg.role === 'assistant') {
      return {
        role: 'assistant',
        content: stripLeadingTimestampFromAssistant(msg.content),
      }
    }
    return {
      role: msg.role,
      content: msg.content,
    }
  })

  const messages: ConversationMessage[] = [
    { role: 'system', content: systemPrompt },
    ...sanitizedHistory,
    { role: 'user', content: userTurnContent },
  ]

  return {
    modelId,
    staticSystemPrompt,
    volatileTurnContext,
    systemPrompt,
    userTurnContent,
    messages,
    seriousness,
    retrievedMemories: approvedMemories,
    eligibleMotifs: approvedMotifs,
    eligibleIntents,
  }
}

export const compileSoulPrompt = composeAshyTurnPrompt

/**
 * Builds a proactive notification prompt with Selective Silence instruction.
 */
export function buildProactiveNoticePrompt(
  source: string,
  notice: string,
  options?: { mood?: MoodVector; seriousness?: SeriousnessAssessment },
): string {
  const cleanSource = source.replace(/[<>]/g, '').trim() || 'system_observer'
  const cleanNotice = notice.replace(/[<>]/g, '').trim()
  const mood = options?.mood ?? ASHY_BASELINE_MOOD

  return [
    '[Proactive Notice]',
    `- Source: ${cleanSource}`,
    `- Observation: ${cleanNotice}`,
    `- Current Mood [V, A, P]: [${mood.valence.toFixed(2)}, ${mood.arousal.toFixed(2)}, ${mood.playfulness.toFixed(2)}]`,
    '- Selective Silence Rule: Only speak if you have something genuinely witty, helpful, or caring to say right now. If interrupting would be annoying, repetitive, or unnecessary, reply with `[SILENCE]` and nothing else.',
  ].join('\n')
}

/**
 * Determines whether a proactive reply should be discarded (Selective Silence).
 */
export function shouldDiscardProactiveReply(replyText: string): boolean {
  if (typeof replyText !== 'string') return true
  const trimmed = replyText.trim()
  if (!trimmed) return true
  const normalized = trimmed.toUpperCase()
  return (
    normalized === '[SILENCE]' ||
    normalized === '<|SILENCE|>' ||
    normalized === 'SILENCE' ||
    normalized === 'PASS' ||
    normalized === '[PASS]'
  )
}
