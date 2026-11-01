/**
 * Phase 10.1 — CallRecorder / `call:recordTurn` (spec §6.3, §7.4).
 * 1. persists the exchange (`cortex.appendVoiceTurn`, modality 'voice');
 * 2. emits `chat:appended` so the hub refreshes the chat without a snapshot;
 * 3. applies the user-reaction affect side effect ONCE (context building ran with
 *    `sideEffects:false`);
 * 4. runs the same post-turn memory trio as the turn orchestrator
 *    (`runPostTurnMemoryPipeline`).
 * Steps 3–4 are fault-isolated; an untranscribed turn never feeds memory.
 * Phase 10.2: turns of a TEST call (`test: true`) are ignored entirely — nothing is persisted,
 * no event, no affect, no memory.
 * 2026-11-01 memory hygiene: the chat row keeps what Ashy said, but the memory pipeline only gets Ashy's
 * reply when it is worth remembering — an echo of the user, a bare greeting / "how can I help?" or a
 * near-repeat of an earlier reply of the call is indexed as '' (user side only), so a bad reply can never
 * come back as a "memory" (the greeting loop of the 2026-11-01 real call). Placeholder transcripts
 * ("[Mensagem de voz Omni]", ids) never feed memory.
 */
import type { AshyCortex } from '@ashy/cortex'
import {
  conversationSimilarity,
  isEchoReply,
  isGreetingOnlyReply,
  isPlaceholderUtterance,
} from '@ashy/cortex'
import { ASHY_EMOTIONS, type AshyEmotion, type ChatMessageRecord, type LiveCallHostEvent } from '@ashy/shared'
import { runPostTurnMemoryPipeline } from '../post-turn-memory'
import type { CallMemoryRetrieval } from './context'

export type CallRecorderCortex = Pick<
  AshyCortex,
  | 'appendVoiceTurn'
  | 'applyUserTurnAffect'
  | 'indexTurnMemory'
  | 'reviewTurnMemories'
  | 'consolidateSessionMemories'
>

export interface CallRecorderDeps {
  getCortex(): CallRecorderCortex
  emit(event: LiveCallHostEvent): void
  now?: () => number
  onWarning?: (message: string) => void
}

export interface RecordCallTurnInput {
  callId: string
  sessionId: string
  backendId: string
  modelId?: string | null
  userTranscript: string
  assistantSpokenText: string
  assistantFullText?: string
  interrupted: boolean
  playedMs?: number
  emotion?: string
  metrics?: {
    endpointMs?: number
    asrMs?: number
    ttfbMs?: number
    playbackStartMs?: number
    e2eMs?: number
  }
  /** Memories that were in context for this turn (from `call:buildContext`). */
  retrieval?: CallMemoryRetrieval | null
  /** Phase 10.2: turn of a test call → skipped. */
  test?: boolean
  /** Phase 10.3: Ashy spoke on her own → assistant row only, no affect/memory pipeline. */
  injectReason?: 'approval' | 'initiative'
}

export interface RecordCallTurnResult {
  /** `null` for injected turns (Ashy spoke on her own). */
  userMessage: ChatMessageRecord | null
  assistantMessage: ChatMessageRecord | null
}

/** Returned for test-call turns (nothing recorded). */
export interface SkippedCallTurnResult {
  skipped: 'test_call'
  userMessage: null
  assistantMessage: null
}

const VALID_EMOTIONS = new Set<string>(ASHY_EMOTIONS)
const NEAR_REPEAT_SIMILARITY = 0.8
const RECENT_REPLIES_PER_CALL = 6

/**
 * What the memory pipeline may keep of Ashy's reply ('' = index the user side only): never an echo of
 * the user, a bare greeting / generic offer, a placeholder or a near-repeat of a recent reply.
 */
export function memoryWorthyAssistantText(input: {
  userText: string
  assistantText: string
  recentReplies?: readonly string[]
  userName?: string | null
}): string {
  const reply = input.assistantText.trim()
  if (reply.length === 0 || isPlaceholderUtterance(reply)) return ''
  if (isEchoReply(input.userText, reply, { userName: input.userName ?? null })) return ''
  if (isGreetingOnlyReply(reply, input.userName)) return ''
  if ((input.recentReplies ?? []).some((p) => conversationSimilarity(reply, p) >= NEAR_REPEAT_SIMILARITY)) return ''
  return reply
}

export function createCallRecorder(deps: CallRecorderDeps) {
  const now = deps.now ?? (() => Date.now())
  let sequence = 0
  const recentRepliesByCall = new Map<string, string[]>()

  return {
    async recordTurn(input: RecordCallTurnInput): Promise<RecordCallTurnResult | SkippedCallTurnResult> {
      if (input.test === true) {
        return { skipped: 'test_call', userMessage: null, assistantMessage: null }
      }
      const cortex = deps.getCortex()
      const nowMs = now()
      sequence += 1
      const turnId = `voice-${input.callId}-${sequence}`.replace(/[^A-Za-z0-9_-]/g, '').slice(-64)
      const emotion: AshyEmotion =
        input.emotion && VALID_EMOTIONS.has(input.emotion) ? (input.emotion as AshyEmotion) : 'neutral'
      const injected = input.injectReason !== undefined
      const transcript = injected ? '' : input.userTranscript.trim()

      const { userMessage, assistantMessage } = cortex.appendVoiceTurn({
        sessionId: input.sessionId,
        userTranscript: transcript,
        assistantSpokenText: input.assistantSpokenText,
        ...(input.assistantFullText !== undefined ? { assistantFullText: input.assistantFullText } : {}),
        interrupted: input.interrupted,
        ...(input.playedMs !== undefined ? { playedMs: input.playedMs } : {}),
        emotion,
        backendId: input.backendId,
        modelId: input.modelId ?? null,
        ...(input.metrics ? { metrics: input.metrics } : {}),
        ...(injected ? { injectReason: input.injectReason, skipUserRow: true } : {}),
        turnId,
        nowMs,
      })

      deps.emit({
        type: 'chat:appended',
        sessionId: input.sessionId,
        messageIds: [userMessage?.id, assistantMessage?.id].filter((id): id is string => typeof id === 'string'),
      })

      const spoken = (assistantMessage?.content ?? '').trim()
      const recent = recentRepliesByCall.get(input.callId) ?? []
      const assistantForMemory = memoryWorthyAssistantText({
        userText: transcript,
        assistantText: spoken,
        recentReplies: recent,
      })
      if (spoken.length > 0) {
        recent.push(spoken)
        if (recent.length > RECENT_REPLIES_PER_CALL) recent.splice(0, recent.length - RECENT_REPLIES_PER_CALL)
        recentRepliesByCall.set(input.callId, recent)
        if (recentRepliesByCall.size > 8) {
          const oldest = recentRepliesByCall.keys().next().value
          if (oldest !== undefined && oldest !== input.callId) recentRepliesByCall.delete(oldest)
        }
      }

      if (transcript.length > 0 && !isPlaceholderUtterance(transcript)) {
        try {
          cortex.applyUserTurnAffect(transcript, nowMs)
        } catch (err) {
          deps.onWarning?.(`call:recordTurn affect: ${errorMessage(err)}`)
        }
        try {
          await runPostTurnMemoryPipeline(cortex, {
            turnId,
            sessionId: input.sessionId,
            userText: transcript,
            assistantText: assistantForMemory,
            emotion,
            nowMs: nowMs + 1,
            retrievedMemories: input.retrieval?.retrievedMemories ?? [],
            ...(input.retrieval?.eligibleIntents
              ? { eligibleIntents: input.retrieval.eligibleIntents }
              : {}),
          })
        } catch (err) {
          deps.onWarning?.(`call:recordTurn memory: ${errorMessage(err)}`)
        }
      }

      return { userMessage, assistantMessage }
    },
  }
}

export type CallRecorder = ReturnType<typeof createCallRecorder>

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
