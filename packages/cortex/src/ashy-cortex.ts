import type {
  AshyEmotion,
  EpisodicMemory,
  PersonalityEvolutionRecord,
  PersonalityTraitKey,
  PersonalityTraits,
} from '@ashy/shared'
import {
  applyEmotionSignalToMood,
  applyExperienceTraitDelta,
  decayMoodToBaseline,
  evaluateSeriousnessGate,
  revertTraitEvolution,
} from './affect/affect-engine'
import {
  CortexDatabase,
  createCortexDatabase,
  type CortexDatabaseOptions,
} from './db/cortex-db'
import {
  runPredictCalibrateConsolidation,
  type CandidateRelationalMotifInput,
  type CandidateSemanticFactInput,
  type ConsolidationResult,
} from './dream/dream-worker'
import { reviewEpisodicMemory, type FsrsReviewRating } from './memory/fsrs-ranker'
import {
  composeAshyTurnPrompt,
  type ComposedTurnPrompt,
  type ConversationMessage,
} from './prompt/soul-composer'
import { recordMotifInvocation, selectEligibleMotifs } from './relational/inside-joke-engine'

export class AshyCortex {
  public readonly db: CortexDatabase

  constructor(options?: CortexDatabaseOptions) {
    this.db = createCortexDatabase(options)
  }

  public ingestEpisodeWithConsolidation(params: {
    episode: EpisodicMemory
    candidateFacts?: readonly CandidateSemanticFactInput[]
    candidateMotifs?: readonly CandidateRelationalMotifInput[]
    isFirstMeeting?: boolean
    nowMs?: number
  }): ConsolidationResult {
    const nowMs = params.nowMs ?? params.episode.createdAt
    this.db.upsertEpisodicMemory(params.episode)

    const existingFacts = this.db.listSemanticFacts()
    const existingMotifs = this.db.listRelationalMotifs()

    const result = runPredictCalibrateConsolidation({
      episode: params.episode,
      candidateFacts: params.candidateFacts,
      candidateMotifs: params.candidateMotifs,
      existingFacts,
      existingMotifs,
      isFirstMeeting: params.isFirstMeeting,
      nowMs,
    })

    for (const fact of result.updatedFacts) {
      this.db.upsertSemanticFact(fact)
    }
    for (const motif of result.updatedMotifs) {
      this.db.upsertRelationalMotif(motif)
    }
    for (const milestone of result.newMilestones) {
      this.db.upsertMilestone(milestone)
    }

    return result
  }

  public compileTurnPrompt(params: {
    userMessage: string
    modelId?: string
    nowMs?: number
    queryEmbedding?: readonly number[]
    screenContext?: string
    conversationHistory?: readonly ConversationMessage[]
    topKMemories?: number
  }): ComposedTurnPrompt {
    const nowMs = params.nowMs ?? Date.now()
    const state = this.db.getAffectiveState()
    const elapsedMinutes =
      state.updatedAt > 0 ? Math.max(0, (nowMs - state.updatedAt) / 60_000) : 0
    const decayedMood = decayMoodToBaseline(state.mood, elapsedMinutes)
    const seriousness = evaluateSeriousnessGate(params.userMessage)

    const effectiveMood = seriousness.isSeriousOrDelicate
      ? {
          ...decayedMood,
          playfulness: Math.min(decayedMood.playfulness, seriousness.maxPlayfulnessAllowed),
        }
      : decayedMood

    const retrievedMemories = this.db.searchEpisodicMemoriesHybrid(
      params.userMessage,
      params.queryEmbedding,
      {
        nowMs,
        limit: params.topKMemories ?? 4,
      },
    )

    const eligibleMotifs = selectEligibleMotifs(
      this.db.listRelationalMotifs(),
      params.userMessage,
      nowMs,
      {
        isSeriousContext: seriousness.isSeriousOrDelicate,
      },
    )

    return composeAshyTurnPrompt({
      userMessage: params.userMessage,
      nowMs,
      modelId: params.modelId,
      semanticFacts: this.db.listSemanticFacts({ activeOnly: true }),
      styleExemplars: this.db.listStyleExemplars(),
      traits: state.traits,
      mood: effectiveMood,
      seriousness,
      retrievedMemories,
      eligibleMotifs,
      screenContext: params.screenContext,
      conversationHistory: params.conversationHistory,
    })
  }

  public recordEmotionPulse(emotion: AshyEmotion, intensity = 0.8, nowMs = Date.now()) {
    const state = this.db.getAffectiveState()
    const elapsedMinutes =
      state.updatedAt > 0 ? Math.max(0, (nowMs - state.updatedAt) / 60_000) : 0
    const decayed = decayMoodToBaseline(state.mood, elapsedMinutes)
    const nextMood = applyEmotionSignalToMood(decayed, emotion, intensity)
    return this.db.saveAffectiveState(nextMood, state.traits, nowMs)
  }

  public evolveTrait(params: {
    trait: PersonalityTraitKey
    delta: number
    reasonEpisodeId: string
    explanation: string
    nowMs?: number
  }): { traits: PersonalityTraits; record: PersonalityEvolutionRecord } {
    const nowMs = params.nowMs ?? Date.now()
    const state = this.db.getAffectiveState()
    const { traits, record } = applyExperienceTraitDelta({
      traits: state.traits,
      trait: params.trait,
      delta: params.delta,
      reasonEpisodeId: params.reasonEpisodeId,
      explanation: params.explanation,
      nowMs,
    })
    this.db.saveAffectiveState(state.mood, traits, nowMs)
    this.db.upsertPersonalityEvolution(record)
    return { traits, record }
  }

  public revertTrait(recordId: string, nowMs = Date.now()) {
    const record = this.db.listPersonalityEvolution().find((r) => r.id === recordId)
    if (!record) {
      throw new Error(`PersonalityEvolutionRecord not found: ${recordId}`)
    }
    const state = this.db.getAffectiveState()
    const { traits, record: revertedRecord } = revertTraitEvolution(state.traits, record, nowMs)
    this.db.saveAffectiveState(state.mood, traits, nowMs)
    this.db.upsertPersonalityEvolution(revertedRecord)
    return { traits, record: revertedRecord }
  }

  public recordJokeCallback(motifId: string, userReactedPositively: boolean, nowMs = Date.now()) {
    const motif = this.db.getRelationalMotif(motifId)
    if (!motif) {
      throw new Error(`RelationalMotif not found: ${motifId}`)
    }
    const updated = recordMotifInvocation(motif, userReactedPositively, nowMs)
    return this.db.upsertRelationalMotif(updated)
  }

  public reviewMemory(memoryId: string, rating: FsrsReviewRating, nowMs = Date.now()) {
    const memory = this.db.getEpisodicMemory(memoryId)
    if (!memory) {
      throw new Error(`EpisodicMemory not found: ${memoryId}`)
    }
    const updated = reviewEpisodicMemory(memory, rating, nowMs)
    return this.db.upsertEpisodicMemory(updated)
  }

  public close(): void {
    this.db.close()
  }
}

export function createAshyCortex(options?: CortexDatabaseOptions): AshyCortex {
  return new AshyCortex(options)
}
