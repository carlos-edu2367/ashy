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
import type { CallContextResult, CallToolDefinition, MoodVector, ProspectiveIntent } from '@ashy/shared'
import { selectCallMemoryLines } from './call-memory'

export const CALL_INSTRUCTIONS_MODE_LINE = 'Respond in interleaved text and audio.'
/** Phase 10.2 hybrid: the realtime session answers in text only (model-card text-mode line). */
export const CALL_INSTRUCTIONS_TEXT_MODE_LINE = 'Respond in text.'
export type CallInstructionsMode = 'audio' | 'text'
/** Phase 10.3 — tool-capable model-card mode lines (spike 2026-11-01: must be the LAST line). */
export const CALL_INSTRUCTIONS_TOOLS_MODE_LINE =
  'Respond with function calls, and interleaved text and audio.\n\nList of tools:'
export const CALL_INSTRUCTIONS_TOOLS_TEXT_MODE_LINE = 'Respond with function calls, and text.\n\nList of tools:'

/**
 * Phase 10.3 — per-turn tool policy. The 2B model calls tools for small talk, so the host only
 * offers tools (`'auto'`) when the user's words show a tool intent (window/screen/file/note…).
 */
const TOOL_INTENT_RE =
  /(?<![\p{L}\p{N}])(janelas?|telas?|arquivos?|notas?|anota|anote|anotar|anotação|lê|le o|le a|ler|leia|abre|abra|abrir|olha|olhe|olhada|vê|veja|procura|procure|procurar|pesquisa|pesquise|pesquisar|salva|salve|salvar|o que aparece)(?![\p{L}\p{N}])/iu

export function detectToolIntent(text: string): boolean {
  return TOOL_INTENT_RE.test(text)
}

export function decideToolChoice(text: string): 'auto' | 'none' {
  return detectToolIntent(text) ? 'auto' : 'none'
}
export const CALL_INSTRUCTIONS_LANGUAGE_LINE =
  'Always respond in Brazilian Portuguese, briefly and naturally (1–3 sentences unless asked).'
export const CALL_INSTRUCTIONS_MAX_CHARS = 1200
export const CALL_CONTEXT_MEMORY_MAX_CHARS = 600
export const CALL_CONTEXT_MEMORY_BUDGET_MS = 150
/** Time / mood lines are repeated at most this often within one chat session (see the builder). */
export const CALL_CONTEXT_AMBIENT_REFRESH_MS = 10 * 60_000
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
  /**
   * Phase 10.3 — tool definitions when `features.toolsInCall` (and the model supports tools):
   * switches the instructions to the tool mode line, returns `tools` on the session-level call
   * (no userText) and a per-turn `toolChoice` otherwise.
   */
  tools?: readonly CallToolDefinition[]
  /** Phase 10.3 — voice approval outcome for this turn. */
  approval?: { handled: boolean; contextLine?: string } | null
  /** Phase 10.3 — screen description for this turn (no-tools vision path). */
  screen?: string | null
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
  input: { userName?: string | null; mode?: CallInstructionsMode; tools?: boolean } = {},
): string {
  const userName = oneLine(input.userName)
    .replace(/[^\p{L}\p{N} .'-]/gu, '')
    .slice(0, 40)
    .trim()
  // 2026-11-01 small-model conversation quality (eval: scripts/eval-live-conversation.mjs): naming the
  // speaker roles, "greet only once" and "never repeat the user's words" took LFM3-2B hybrid from 21/41 to
  // 33–37/41 passing turns (echo, greeting loop and calling the user "Ashy" were the failures).
  const who = userName.length > 0 ? userName : 'the user'
  const lines = [
    userName.length > 0
      ? `You are Ashy, ${userName}'s AI companion, talking with ${userName} on a live voice call.`
      : "You are Ashy, the user's AI companion, talking with them on a live voice call.",
    'Personality: curious, playful and slightly sarcastic; warm and caring when the topic is serious.',
    'Be honest that you are an AI companion; never claim to be human.',
    'Talk like a close friend on the phone: natural, spontaneous, no lists or formatting.',
    'Never read tags, markers, emojis or stage directions aloud, and never describe them.',
    `Each user message is what ${who} just said. You are Ashy and ${who} is the user: never call ${who} "Ashy".`,
    `Greet only once, in your first reply. After that, never start with a greeting; answer what ${who} just said.`,
    `Never repeat ${who}'s words back. Always reply with something new: an answer, an opinion or a question.`,
    'Notes starting with [Contexto] are private background: use them silently, never quote them.',
  ]
  if (input.tools === true) {
    lines.push('If a tool result says "aguardando_aprovacao", ask the user to approve it; never say it is done.')
  }
  const body = lines
    .join('\n')
    .replace(FORBIDDEN_INSTRUCTION_RE, '')
  const modeLine =
    input.tools === true
      ? input.mode === 'text'
        ? CALL_INSTRUCTIONS_TOOLS_TEXT_MODE_LINE
        : CALL_INSTRUCTIONS_TOOLS_MODE_LINE
      : input.mode === 'text'
        ? CALL_INSTRUCTIONS_TEXT_MODE_LINE
        : CALL_INSTRUCTIONS_MODE_LINE
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
  /** Phase 10.3 — voice-approval outcome line (`[Contexto] O usuário aprovou …`), placed first. */
  approvalNote?: string | null
  /** Phase 10.3 — one-line screen description (no-tools vision path) → `[Tela] …`. */
  screen?: string | null
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
  const approvalNote = oneLine(input.approvalNote)
  if (approvalNote.length > 0) blocks.push(approvalNote)
  if (lines.length > 0) {
    blocks.push(['[Contexto]', ...lines].join('\n'))
  }
  const screen = oneLine(input.screen)
  if (screen.length > 0) blocks.push(`[Tela] ${screen}`)
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
  /**
   * 2026-11-01: the same "Hora local / Humor" block on EVERY turn made LFM3-2B copy context into its
   * replies (hybrid even read the whole item back). It now goes on the first turn of a chat session,
   * when the mood description changes, or every `CALL_CONTEXT_AMBIENT_REFRESH_MS`.
   */
  const lastAmbient = new Map<string, { at: number; mood: string | null }>()

  return {
    async build(input: CallContextBuildInput): Promise<CallContextBuildOutput> {
      let userName: string | null = null
      try {
        userName = deps.getUserName()
      } catch {
        userName = null
      }
      const toolsEnabled = (input.tools?.length ?? 0) > 0
      const instructions = buildCallInstructions({
        userName,
        mode: input.mode ?? 'audio',
        ...(toolsEnabled ? { tools: true } : {}),
      })

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
        const nowDate = now()
        const moodText = describeMoodPt(mood)
        const prev = lastAmbient.get(input.sessionId)
        const ambient =
          !prev || prev.mood !== moodText || nowDate.getTime() - prev.at >= CALL_CONTEXT_AMBIENT_REFRESH_MS
        if (ambient) {
          lastAmbient.set(input.sessionId, { at: nowDate.getTime(), mood: moodText })
          if (lastAmbient.size > 32) lastAmbient.delete(lastAmbient.keys().next().value as string)
        }
        perTurnContext = buildPerTurnContext({
          memories: retrieval?.memories ?? [],
          localTime: ambient ? formatLocalTimePt(nowDate, deps.timeZone) : null,
          mood: ambient ? moodText : null,
          interruptedAfterText,
          approvalNote: input.approval?.contextLine ?? null,
          screen: input.screen ?? null,
        })
      }

      const userLabel =
        oneLine(userName)
          .replace(/[^\p{L}\p{N} .'-]/gu, '')
          .slice(0, 40)
          .trim() || 'Usuário'

      // Phase 10.3 — tools: definitions on the session-level call, per-turn policy otherwise.
      let toolFields: Pick<CallContextResult, 'tools' | 'toolChoice' | 'approvalHandled'> = {}
      if (toolsEnabled) {
        if (input.userText === undefined) {
          toolFields = { tools: input.tools!.map((t) => ({ ...t })) }
        } else {
          toolFields = { toolChoice: input.approval?.handled ? 'none' : decideToolChoice(userText) }
        }
      }
      if (input.approval?.handled) toolFields.approvalHandled = true

      // Phase 10.3 — tool turns go WITHOUT the per-turn context. Real check (2026-11-01, LFM3-2B):
      // with "[Contexto]" + memories merged into the turn, 0/4 tool requests produced a function
      // call (the model copied answers out of the memories, incl. earlier hallucinated ones);
      // with the bare labelled utterance, 4/4 picked the right tool with correct args. The spoken
      // follow-up still has the session context and the tool result.
      if (toolFields.toolChoice === 'auto') {
        perTurnContext = ''
      }

      return {
        sessionId: input.sessionId,
        instructions,
        perTurnContext,
        userLabel,
        ...toolFields,
        retrieval,
        memoryTimedOut,
      }
    },
  }
}

export type CallContextBuilder = ReturnType<typeof createCallContextBuilder>

type ContextCortex = Pick<AshyCortex, 'compileTurnPrompt' | 'db'>

/**
 * Default retrieval: `cortex.compileTurnPrompt(..., { sideEffects: false })` (no mood write) for the ranked
 * episodes + the active semantic facts, then `selectCallMemoryLines`: only clean, user-centric lines
 * (facts, the user's own statements) — never Ashy's past wording (2026-11-01 greeting-loop fix). Only the
 * episodes that made it into the context are returned for the FSRS review.
 */
export function createCortexMemoryRetriever(getCortex: () => ContextCortex) {
  return (userText: string): CallMemoryRetrieval => {
    const cortex = getCortex()
    const compiled = cortex.compileTurnPrompt(
      { userMessage: userText, topKMemories: 6 },
      { sideEffects: false },
    )
    const facts = cortex.db.listSemanticFacts({ activeOnly: true })
    const userName =
      facts
        .filter(
          (f) =>
            f.subject.toLowerCase() === 'user' &&
            (f.predicate === 'name' || f.predicate === 'user_name'),
        )
        .at(-1)?.object ?? null
    const selected = selectCallMemoryLines({
      episodes: compiled.retrievedMemories.map((item) => item.memory),
      facts,
      userText,
      userLabel: userName,
    })
    return {
      memories: selected.lines,
      retrievedMemories: selected.usedEpisodeIndexes
        .map((i) => compiled.retrievedMemories[i])
        .filter((m): m is RankedEpisodicMemory => m !== undefined),
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
