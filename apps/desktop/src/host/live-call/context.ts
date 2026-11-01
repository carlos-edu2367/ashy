/**
 * Phase 10.1 — `call:buildContext` (spec §4 spike conclusions + §7.3).
 *
 * llama.cpp realtime only behaves with the model-card instruction format:
 * a short ENGLISH persona, then "Always respond in Brazilian Portuguese", and
 * `Respond in interleaved text and audio.` as the LAST line. Ashy's memories and
 * volatile context go per turn as a PT `input_text` (`[Contexto] …`), never in
 * the instructions. Never use "Perform TTS" (it is the read-aloud prompt → echo).
 */
import type { AshyCortex, RankedEpisodicMemory } from '@ashy/cortex'
import { decayMoodToBaseline } from '@ashy/cortex'
import type { CallContextResult, MoodVector, ProspectiveIntent } from '@ashy/shared'

export const CALL_INSTRUCTIONS_MODE_LINE = 'Respond in interleaved text and audio.'
/** Phase 10.2 hybrid: the realtime session answers in text only (model-card text-mode line). */
export const CALL_INSTRUCTIONS_TEXT_MODE_LINE = 'Respond in text.'
export type CallInstructionsMode = 'audio' | 'text'
export const CALL_INSTRUCTIONS_LANGUAGE_LINE =
  'Always respond in Brazilian Portuguese, briefly and naturally (1–3 sentences unless asked).'
export const CALL_INSTRUCTIONS_MAX_CHARS = 1200
export const CALL_CONTEXT_MEMORY_MAX_CHARS = 600
export const CALL_CONTEXT_MEMORY_BUDGET_MS = 150
const INTERRUPTED_SNIPPET_MAX_CHARS = 240
/** Phrases that flip LFM3-Omni into read-aloud/echo mode (spike §4). */
const FORBIDDEN_INSTRUCTION_RE = /perform\s+tts/gi

/** What memory retrieval yields for one user utterance. */
export interface CallMemoryRetrieval {
  /** One-line, already human-readable memory snippets (most relevant first). */
  memories: string[]
  /** Raw ranked memories (kept so `call:recordTurn` can FSRS-review what was in context). */
  retrievedMemories?: readonly RankedEpisodicMemory[]
  eligibleIntents?: readonly ProspectiveIntent[]
}

export interface CallContextDeps {
  retrieveMemories(userText: string): Promise<CallMemoryRetrieval> | CallMemoryRetrieval
  getMood(): MoodVector | null
  getUserName(): string | null
  now?: () => Date
  memoryBudgetMs?: number
  timeZone?: string
}

export interface CallContextBuildInput {
  sessionId: string
  /** 'text' for the hybrid backend (default 'audio'). */
  mode?: CallInstructionsMode
  userText?: string
  interruptedAfterText?: string
}

export interface CallContextBuildOutput extends CallContextResult {
  /** Present when memories were retrieved within budget (host-internal; not sent over RPC). */
  retrieval: CallMemoryRetrieval | null
  memoryTimedOut: boolean
}

function oneLine(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/\0/g, '')
    .replace(/<\|[\s\S]*?(?:\|>|\}>)/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Session-level instructions for llama.cpp realtime (≤ ~1200 chars, mode line LAST). */
export function buildCallInstructions(
  input: { userName?: string | null; mode?: CallInstructionsMode } = {},
): string {
  const userName = oneLine(input.userName)
    .replace(/[^\p{L}\p{N} .'-]/gu, '')
    .slice(0, 40)
    .trim()
  const lines = [
    "You are Ashy, the user's AI companion, talking with them on a live voice call.",
    'Personality: curious, playful and slightly sarcastic; warm and caring when the topic is serious.',
    'Be honest that you are an AI companion; never claim to be human.',
    'Talk like a close friend on the phone: natural, spontaneous, no lists or formatting.',
    'Never read tags, markers, emojis or stage directions aloud, and never describe them.',
    'Notes starting with [Contexto] are private background: use them silently, never quote them.',
  ]
  if (userName.length > 0) {
    lines.push(`The user's name is ${userName}.`)
  }
  const body = lines
    .join('\n')
    .replace(FORBIDDEN_INSTRUCTION_RE, '')
  const modeLine = input.mode === 'text' ? CALL_INSTRUCTIONS_TEXT_MODE_LINE : CALL_INSTRUCTIONS_MODE_LINE
  const tail = `${CALL_INSTRUCTIONS_LANGUAGE_LINE}\n${modeLine}`
  const maxBody = Math.max(0, CALL_INSTRUCTIONS_MAX_CHARS - tail.length - 1)
  return `${body.slice(0, maxBody).trimEnd()}\n${tail}`
}

export function describeMoodPt(mood: MoodVector | null): string | null {
  if (!mood) return null
  const parts: string[] = []
  if (mood.valence <= -0.25) parts.push('meio pra baixo')
  else if (mood.valence >= 0.3) parts.push('de bom humor')
  else parts.push('tranquila')
  if (mood.arousal >= 0.6) parts.push('animada')
  else if (mood.arousal <= -0.2) parts.push('calma')
  if (mood.playfulness >= 0.5) parts.push('brincalhona')
  return parts.join(', ')
}

export function formatLocalTimePt(date: Date, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }
  try {
    return new Intl.DateTimeFormat('pt-BR', opts).format(date)
  } catch {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
}

/** Per-turn PT context injected as `input_text` before the user turn ('' when nothing). */
export function buildPerTurnContext(input: {
  memories?: readonly string[]
  localTime?: string | null
  mood?: string | null
  interruptedAfterText?: string | null
}): string {
  const lines: string[] = []
  if (input.localTime) lines.push(`Hora local: ${input.localTime}.`)
  if (input.mood) lines.push(`Humor da Ashy: ${input.mood}.`)

  const memoryLines: string[] = []
  let used = 0
  for (const raw of input.memories ?? []) {
    const line = `- ${oneLine(raw)}`
    if (line.length <= 2) continue
    if (used + line.length + 1 > CALL_CONTEXT_MEMORY_MAX_CHARS) {
      const room = CALL_CONTEXT_MEMORY_MAX_CHARS - used - 1
      if (memoryLines.length === 0 && room > 20) {
        memoryLines.push(`${line.slice(0, room - 1).trimEnd()}…`)
      }
      break
    }
    memoryLines.push(line)
    used += line.length + 1
  }
  if (memoryLines.length > 0) {
    lines.push('Memórias relevantes:', ...memoryLines)
  }

  const blocks: string[] = []
  if (lines.length > 0) {
    blocks.push(['[Contexto]', ...lines].join('\n'))
  }
  const interrupted = oneLine(input.interruptedAfterText).replace(/[«»]/g, '')
  if (interrupted.length > 0) {
    const snippet =
      interrupted.length > INTERRUPTED_SNIPPET_MAX_CHARS
        ? `…${interrupted.slice(-INTERRUPTED_SNIPPET_MAX_CHARS).trimStart()}`
        : interrupted
    blocks.push(`[Sua fala anterior foi interrompida após: «${snippet}»]`)
  }
  return blocks.join('\n')
}

const TIMED_OUT = Symbol('memory-timeout')

async function withBudget<T>(
  work: () => Promise<T> | T,
  budgetMs: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, budgetMs))
    ;(timer as { unref?: () => void }).unref?.()
  })
  try {
    return await Promise.race([Promise.resolve().then(work), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createCallContextBuilder(deps: CallContextDeps) {
  const now = deps.now ?? (() => new Date())
  const budgetMs = deps.memoryBudgetMs ?? CALL_CONTEXT_MEMORY_BUDGET_MS

  return {
    async build(input: CallContextBuildInput): Promise<CallContextBuildOutput> {
      let userName: string | null = null
      try {
        userName = deps.getUserName()
      } catch {
        userName = null
      }
      const instructions = buildCallInstructions({ userName, mode: input.mode ?? 'audio' })

      const userText = oneLine(input.userText)
      const interruptedAfterText = oneLine(input.interruptedAfterText)
      let retrieval: CallMemoryRetrieval | null = null
      let memoryTimedOut = false

      if (userText.length > 0) {
        try {
          const result = await withBudget(() => deps.retrieveMemories(userText), budgetMs)
          if (result === TIMED_OUT) {
            memoryTimedOut = true
          } else {
            retrieval = result
          }
        } catch {
          retrieval = null
        }
      }

      let perTurnContext = ''
      if (userText.length > 0 || interruptedAfterText.length > 0) {
        let mood: MoodVector | null = null
        try {
          mood = deps.getMood()
        } catch {
          mood = null
        }
        perTurnContext = buildPerTurnContext({
          memories: retrieval?.memories ?? [],
          localTime: formatLocalTimePt(now(), deps.timeZone),
          mood: describeMoodPt(mood),
          interruptedAfterText,
        })
      }

      const userLabel =
        oneLine(userName)
          .replace(/[^\p{L}\p{N} .'-]/gu, '')
          .slice(0, 40)
          .trim() || 'Usuário'

      return {
        sessionId: input.sessionId,
        instructions,
        perTurnContext,
        userLabel,
        retrieval,
        memoryTimedOut,
      }
    },
  }
}

export type CallContextBuilder = ReturnType<typeof createCallContextBuilder>

type ContextCortex = Pick<AshyCortex, 'compileTurnPrompt' | 'db'>

/** Default retrieval: `cortex.compileTurnPrompt(..., { sideEffects: false })` (no mood write). */
export function createCortexMemoryRetriever(getCortex: () => ContextCortex) {
  return (userText: string): CallMemoryRetrieval => {
    const compiled = getCortex().compileTurnPrompt(
      { userMessage: userText, topKMemories: 3 },
      { sideEffects: false },
    )
    const memories = compiled.retrievedMemories
      .map((item) => oneLine(item.memory.summary || item.memory.title))
      .filter((line) => line.length > 0)
    return {
      memories,
      retrievedMemories: compiled.retrievedMemories,
      eligibleIntents: compiled.eligibleIntents,
    }
  }
}

/** Current (decayed, read-only) mood from the cortex. */
export function createCortexMoodReader(getCortex: () => ContextCortex, now = () => Date.now()) {
  return (): MoodVector | null => {
    const state = getCortex().db.getAffectiveState()
    const elapsedMinutes =
      state.updatedAt > 0 ? Math.max(0, (now() - state.updatedAt) / 60_000) : 0
    return decayMoodToBaseline(state.mood, elapsedMinutes)
  }
}

export function createCortexUserNameReader(getCortex: () => ContextCortex) {
  return (): string | null => {
    const facts = getCortex().db.listActiveSemanticFacts('identity')
    return (
      facts
        .filter(
          (f) =>
            f.subject.toLowerCase() === 'user' &&
            (f.predicate === 'name' || f.predicate === 'user_name'),
        )
        .at(-1)?.object ?? null
    )
  }
}
