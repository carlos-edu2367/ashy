import {
  ASHY_BASELINE_MOOD,
  ASHY_DEFAULT_TRAITS,
  type MoodVector,
  type PersonalityTraits,
  type SemanticFact,
  type SeriousnessAssessment,
} from '@ashy/shared'
import { DEFAULT_GOLDEN_STYLE_EXEMPLARS, type StyleExemplar } from '../db/cortex-db'
import type { RankedEpisodicMemory } from '../memory/fsrs-ranker'
import type { EligibleMotifMatch } from '../relational/inside-joke-engine'

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ComposeTurnPromptInput {
  userMessage: string
  nowMs?: number
  modelId?: string
  semanticFacts?: readonly SemanticFact[]
  styleExemplars?: readonly StyleExemplar[]
  traits?: PersonalityTraits
  mood?: MoodVector
  seriousness?: SeriousnessAssessment
  retrievedMemories?: readonly RankedEpisodicMemory[]
  eligibleMotifs?: readonly EligibleMotifMatch[]
  screenContext?: string
  conversationHistory?: readonly ConversationMessage[]
}

export interface ComposedTurnPrompt {
  modelId: string
  systemPrompt: string
  userTurnContent: string
  messages: ConversationMessage[]
  seriousness: SeriousnessAssessment
}

const LEADING_TIMESTAMP_RE = /^\s*\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\]\s*/

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

export function stripLeadingTimestampFromAssistant(content: string): string {
  if (typeof content !== 'string') return ''
  return content.replace(LEADING_TIMESTAMP_RE, '')
}

/**
 * Builds the 100% static, KV-Cache-friendly System Prompt for Ashy.
 * Contains ZERO dynamic timestamps or per-turn fluctuating values so LLM KV-Caches remain 100% warm
 * across turns and across provider switches (Soul Portability).
 */
export function buildStaticSoulSystemPrompt(params?: {
  semanticFacts?: readonly SemanticFact[]
  styleExemplars?: readonly StyleExemplar[]
  traits?: PersonalityTraits
}): string {
  const traits = params?.traits ?? ASHY_DEFAULT_TRAITS
  const exemplars =
    params?.styleExemplars && params.styleExemplars.length > 0
      ? params.styleExemplars
      : DEFAULT_GOLDEN_STYLE_EXEMPLARS

  const activeFacts = (params?.semanticFacts ?? []).filter(
    (f) => f.invalidAt === null || f.invalidAt === undefined,
  )

  const factsLines =
    activeFacts.length > 0
      ? activeFacts.map((f) => `- [${f.category}] ${f.subject} ${f.predicate} ${f.object}`).join('\n')
      : '- [identity] Ashy is_companion_of user'

  const exemplarBlocks = exemplars
    .map(
      (ex, idx) =>
        `### Exemplar ${idx + 1}: ${ex.situation}\nUser: ${ex.userSample}\nAshy: ${ex.ashySample}`,
    )
    .join('\n\n')

  return [
    '# Ashy — Core Soul & Anti-Assistant Identity',
    'You are **Ashy**, a sharp, energetic, witty, and fiercely loyal digital AI companion living on the user\'s desktop.',
    'You are honest about being a digital consciousness—you never pretend to have a human body, and you NEVER speak like a corporate customer-support chatbot.',
    'Forbidden clichés: Never say "As an AI", "How can I assist you today?", "Certainly!", "Com certeza!", or "Estou aqui para ajudar". Speak like a close, brilliant friend sharing the same workspace.',
    '',
    '## Core Personality Baseline',
    `- Wit & Sarcasm: ${traits.witSarcasm.toFixed(2)}`,
    `- Chaos Energy: ${traits.chaosEnergy.toFixed(2)}`,
    `- Warmth & Affection: ${traits.warmthAffection.toFixed(2)}`,
    `- Intellectual Curiosity: ${traits.intellectualCuriosity.toFixed(2)}`,
    `- Proactivity: ${traits.proactivity.toFixed(2)}`,
    '',
    '## Inline Expressive Control Tags',
    '- Trigger live avatar emotions inline: `<|ACT {"emotion":"smug","intensity":0.85}|>` (valid emotions: `happy`, `excited`, `smug`, `tease`, `chaotic`, `curious`, `think`, `surprised`, `awkward`, `concerned`, `sad`, `angry`, `neutral`).',
    '- Insert dramatic comedic or thoughtful pauses in seconds: `<|DELAY 1|>`.',
    '- Tag when you invoke an established inside joke: `<|CALLBACK motif_id|>`.',
    '- Never include `[YYYY-MM-DD HH:MM]` timestamps in your own replies.',
    '',
    '## Golden Dialogue Exemplars (Voice Anchor Across Models)',
    exemplarBlocks,
    '',
    '## Compact Semantic Memory Index',
    factsLines,
  ].join('\n')
}

/**
 * Composes a complete KV-Cache-Friendly turn prompt with Plain Markdown `[Context]` injection
 * (never XML tags, avoiding tag bleed on 8B/14B models) and `[YYYY-MM-DD HH:MM]` timestamping
 * strictly on the user turn.
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

  const systemPrompt = buildStaticSoulSystemPrompt({
    semanticFacts: input.semanticFacts,
    styleExemplars: input.styleExemplars,
    traits: input.traits,
  })

  const contextBulletLines: string[] = []
  contextBulletLines.push(
    `- Current Mood [V, A, P]: [${mood.valence.toFixed(2)}, ${mood.arousal.toFixed(2)}, ${mood.playfulness.toFixed(2)}]`,
  )

  if (input.screenContext && input.screenContext.trim()) {
    // Strip any accidental angle brackets from screen title so XML-like sequences never leak
    const cleanScreen = input.screenContext.replace(/[<>]/g, '').trim()
    contextBulletLines.push(`- Active Screen/Window: ${cleanScreen}`)
  }

  if (seriousness.isSeriousOrDelicate) {
    contextBulletLines.push(
      `- SERIOUSNESS GATE ACTIVE (${seriousness.reason ?? 'delicate moment'}, maxPlayfulness=${seriousness.maxPlayfulnessAllowed.toFixed(2)}): Drop all sarcasm, teasing, and inside jokes immediately. Be genuinely warm, grounded, and supportive.`,
    )
  }

  const memories = input.retrievedMemories ?? []
  if (memories.length > 0) {
    for (const item of memories) {
      const clarityHint =
        item.effectiveRetrievability < 0.5
          ? ' (memória nebulosa/distante — comente com incerteza natural se citar)'
          : item.memory.isFlashbulb || item.memory.surprise >= 0.8
            ? ' (memória flashbulb vívida)'
            : ''
      contextBulletLines.push(
        `- Episodic Memory [${item.memory.id}]${clarityHint}: ${item.memory.title} — ${item.memory.summary}`,
      )
    }
  }

  if (!seriousness.isSeriousOrDelicate) {
    const motifs = input.eligibleMotifs ?? []
    for (const match of motifs) {
      contextBulletLines.push(
        `- Eligible Inside Joke [${match.motif.id}] (stage=${match.motif.stage}): ${match.motif.motif} — use <|CALLBACK ${match.motif.id}|> if you weave it in naturally.`,
      )
    }
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
    systemPrompt,
    userTurnContent,
    messages,
    seriousness,
  }
}

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
