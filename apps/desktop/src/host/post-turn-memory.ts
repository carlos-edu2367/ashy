import type { AshyCortex } from '@ashy/cortex'

/**
 * Post-turn memory trio shared by the text/voice turn orchestrator and the
 * Phase 10.1 Live Call recorder: index the exchange, review the memories that
 * were in context (FSRS) and run the (non-forced) session consolidation.
 * Throws on failure — callers own fault isolation.
 */
export type PostTurnMemoryCortex = Pick<
  AshyCortex,
  'indexTurnMemory' | 'reviewTurnMemories' | 'consolidateSessionMemories'
>

export interface PostTurnMemoryInput {
  turnId: string
  sessionId: string
  userText: string
  assistantText: string
  emotion: Parameters<AshyCortex['indexTurnMemory']>[0]['emotion']
  nowMs: number
  retrievedMemories: Parameters<AshyCortex['reviewTurnMemories']>[0]['retrievedMemories']
  invokedMotifIds?: readonly string[]
  eligibleIntents?: Parameters<AshyCortex['reviewTurnMemories']>[0]['eligibleIntents']
}

export async function runPostTurnMemoryPipeline(
  cortex: PostTurnMemoryCortex,
  input: PostTurnMemoryInput,
): Promise<void> {
  cortex.indexTurnMemory({
    turnId: input.turnId,
    userText: input.userText,
    assistantText: input.assistantText,
    emotion: input.emotion,
    now: input.nowMs,
  })
  cortex.reviewTurnMemories({
    retrievedMemories: input.retrievedMemories,
    assistantText: input.assistantText,
    invokedMotifIds: input.invokedMotifIds,
    eligibleIntents: input.eligibleIntents,
    nowMs: input.nowMs,
  })
  await cortex.consolidateSessionMemories({
    sessionId: input.sessionId,
    nowMs: input.nowMs,
    force: false,
  })
}
