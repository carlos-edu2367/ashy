/**
 * Phase 10.1 — CallRecorder / `call:recordTurn` (spec §6.3, §7.4).
 * 1. persists the exchange (`cortex.appendVoiceTurn`, modality 'voice');
 * 2. emits `chat:appended` so the hub refreshes the chat without a snapshot;
 * 3. applies the user-reaction affect side effect ONCE (context building ran with
 *    `sideEffects:false`);
 * 4. runs the same post-turn memory trio as the turn orchestrator
 *    (`runPostTurnMemoryPipeline`).
 * Steps 3–4 are fault-isolated; an untranscribed turn never feeds memory.
 */
import type { AshyCortex } from '@ashy/cortex'
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
}

export interface RecordCallTurnResult {
  userMessage: ChatMessageRecord
  assistantMessage: ChatMessageRecord | null
}

const VALID_EMOTIONS = new Set<string>(ASHY_EMOTIONS)

export function createCallRecorder(deps: CallRecorderDeps) {
  const now = deps.now ?? (() => Date.now())
  let sequence = 0

  return {
    async recordTurn(input: RecordCallTurnInput): Promise<RecordCallTurnResult> {
      const cortex = deps.getCortex()
      const nowMs = now()
      sequence += 1
      const turnId = `voice-${input.callId}-${sequence}`.replace(/[^A-Za-z0-9_-]/g, '').slice(-64)
      const emotion: AshyEmotion =
        input.emotion && VALID_EMOTIONS.has(input.emotion) ? (input.emotion as AshyEmotion) : 'neutral'
      const transcript = input.userTranscript.trim()

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
        turnId,
        nowMs,
      })

      deps.emit({
        type: 'chat:appended',
        sessionId: input.sessionId,
        messageIds: assistantMessage ? [userMessage.id, assistantMessage.id] : [userMessage.id],
      })

      if (transcript.length > 0) {
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
            assistantText: assistantMessage?.content ?? '',
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
