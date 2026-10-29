import type {
  AshyEmotion,
  ChatMessageRecord,
  ChatSessionRecord,
  EpisodicMemory,
  PersonalityEvolutionRecord,
  PersonalityTraitKey,
  PersonalityTraits,
  RelationshipStage,
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
import {
  reviewEpisodicMemory,
  tokenizeForSearch,
  type FsrsReviewRating,
  type RankedEpisodicMemory,
} from './memory/fsrs-ranker'
import {
  composeAshyTurnPrompt,
  type ComposedTurnPrompt,
  type ConversationMessage,
} from './prompt/soul-composer'
import { recordMotifInvocation, selectEligibleMotifs } from './relational/inside-joke-engine'

const USER_NAME_DECLARATION_RE =
  /(?:meu nome é|pode me chamar de)\s+([A-Za-zÀ-ÿ0-9_ -]{2,40})/i
const USER_NAME_STOP_WORDS_RE =
  /\s+(?:e|mas|sou|trabalho|uso|estou|tenho|moro|gosto|curto|programo|escrevo|faço|meu|minha|aqui|hoje|no|na|por)(?=\s|$|[.,!?;:]).*$/i
const USER_WORK_DECLARATION_RE =
  /eu trabalho com\s+([^.!?\n]{3,80})/i
const USER_TOOL_DECLARATION_RE =
  /uso muito\s+([^.!?\n]{3,80})/i
const USER_PROJECT_DECLARATION_RE =
  /(?:meu projeto atual é|estou trabalhando no projeto)\s+([^.!?\n]{2,80})/i
const CLAUSE_CONTINUATION_SPLIT_RE =
  /\s*(?:,\s*(?:uso muito|eu trabalho com|meu projeto atual é|estou trabalhando no projeto)|\s+e\s+(?:uso muito|eu trabalho com|meu projeto atual é|estou trabalhando no projeto|pode me chamar de|meu nome é))(?=\s|$).*$/i

function cleanExtractedFactValue(raw: string, maxLen = 80): string {
  return raw
    .replace(/\0/g, '')
    .replace(CLAUSE_CONTINUATION_SPLIT_RE, '')
    .replace(/^['"`\s]+|['"`.,;:!?\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
}

function cleanExtractedUserName(raw: string): string {
  const withoutTrailingClause = raw
    .replace(/\0/g, '')
    .replace(USER_NAME_STOP_WORDS_RE, '')
  const cleaned = cleanExtractedFactValue(withoutTrailingClause, 40)
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 3)
  return words.join(' ')
}

export class AshyCortex {
  public readonly db: CortexDatabase

  constructor(options?: CortexDatabaseOptions) {
    this.db = createCortexDatabase(options)
    this.db.seedDefaultGoldenExemplars()
  }

  // Session & message pass-through helpers
  public createChatSession(
    input: Parameters<CortexDatabase['createChatSession']>[0],
  ): ChatSessionRecord {
    return this.db.createChatSession(input)
  }

  public listChatSessions(): ChatSessionRecord[] {
    return this.db.listChatSessions()
  }

  public getChatSession(id: string): ChatSessionRecord | null {
    return this.db.getChatSession(id)
  }

  public deleteChatSession(id: string): boolean {
    return this.db.deleteChatSession(id)
  }

  public appendChatMessage(input: ChatMessageRecord): ChatMessageRecord {
    return this.db.appendChatMessage(input)
  }

  public listChatMessages(sessionId: string, limit?: number): ChatMessageRecord[] {
    return this.db.listChatMessages(sessionId, limit)
  }

  public recall(
    queryText: string,
    nowMs = Date.now(),
    limit = 5,
    queryEmbedding?: readonly number[],
  ): RankedEpisodicMemory[] {
    return this.db.searchEpisodicMemoriesHybrid(queryText, queryEmbedding, {
      nowMs,
      limit,
    })
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
    timeOfDayLabel?: string
    stage?: RelationshipStage
    voiceIdentityMarkdown?: string
    userName?: string | null
    userPronouns?: string | null
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

    const identityFacts = this.db.listActiveSemanticFacts('identity')
    const userName =
      params.userName !== undefined
        ? params.userName
        : (identityFacts
            .filter(
              (f) =>
                f.subject === 'user' &&
                (f.predicate === 'name' || f.predicate === 'user_name'),
            )
            .at(-1)?.object ?? null)

    const userPronouns =
      params.userPronouns !== undefined
        ? params.userPronouns
        : (identityFacts
            .filter(
              (f) =>
                f.subject === 'user' &&
                (f.predicate === 'pronouns' || f.predicate === 'user_pronouns'),
            )
            .at(-1)?.object ?? null)

    return composeAshyTurnPrompt({
      userMessage: params.userMessage,
      nowMs,
      timeOfDayLabel: params.timeOfDayLabel,
      modelId: params.modelId,
      stage: params.stage,
      voiceIdentityMarkdown: params.voiceIdentityMarkdown,
      userName,
      userPronouns,
      goldenExemplars: this.db.listGoldenExemplars(),
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

  public indexTurnMemory(input: {
    turnId: string
    userText: string
    assistantText: string
    emotion: AshyEmotion
    now?: number
  }): { episodeCreated: boolean; factsCreated: number } {
    const now = Number.isFinite(input.now) ? Number(input.now) : Date.now()
    const cleanTurnId =
      (input.turnId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || String(now)
    const cleanUserText = (input.userText ?? '').replace(/\0/g, '').trim()
    const cleanAssistantText = (input.assistantText ?? '').replace(/\0/g, '').trim()
    const episodeId = `ep-turn-${cleanTurnId}`

    let episodeCreated = false
    if (cleanUserText.length >= 12) {
      const tokens = tokenizeForSearch(cleanUserText).filter((w) => w.length >= 4)
      const uniqueTags = Array.from(new Set(tokens)).slice(0, 8)
      const tags = uniqueTags.length > 0 ? uniqueTags : ['conversation']

      const isHighAffect =
        input.emotion === 'excited' ||
        input.emotion === 'sad' ||
        input.emotion === 'concerned' ||
        input.emotion === 'surprised'

      this.db.upsertEpisodicMemory({
        id: episodeId,
        title: cleanUserText.slice(0, 60),
        summary: `Usuário: ${cleanUserText.slice(0, 120)} | Ashy: ${cleanAssistantText.slice(0, 120)}`,
        content: `Usuário: ${cleanUserText}\nAshy: ${cleanAssistantText}`,
        createdAt: now,
        lastReviewedAt: now,
        stability: 3.0,
        difficulty: 4.5,
        surprise: isHighAffect ? 0.65 : 0.4,
        isFlashbulb: false,
        tags,
      })
      episodeCreated = true
    }

    let factsCreated = 0

    const nameMatch = USER_NAME_DECLARATION_RE.exec(cleanUserText)
    if (nameMatch?.[1]) {
      const extractedName = cleanExtractedUserName(nameMatch[1])
      if (extractedName.length >= 2) {
        for (const existing of this.db.listActiveSemanticFacts('identity')) {
          if (
            existing.subject === 'user' &&
            (existing.predicate === 'name' || existing.predicate === 'user_name') &&
            existing.id !== 'fact-user-name'
          ) {
            this.db.invalidateSemanticFact(existing.id, now)
          }
        }
        this.db.upsertSemanticFact({
          id: 'fact-user-name',
          category: 'identity',
          subject: 'user',
          predicate: 'name',
          object: extractedName,
          confidence: 0.95,
          sourceEpisodeIds: [episodeId],
          validFrom: now,
          invalidAt: null,
        })
        factsCreated += 1
      }
    }

    const workMatch = USER_WORK_DECLARATION_RE.exec(cleanUserText)
    if (workMatch?.[1]) {
      const extractedWork = cleanExtractedFactValue(workMatch[1], 80)
      if (extractedWork.length >= 3) {
        this.db.upsertSemanticFact({
          id: `fact-user-work-${cleanTurnId}`,
          category: 'preference',
          subject: 'user',
          predicate: 'works_with',
          object: extractedWork,
          confidence: 0.85,
          sourceEpisodeIds: [episodeId],
          validFrom: now,
          invalidAt: null,
        })
        factsCreated += 1
      }
    }

    const toolMatch = USER_TOOL_DECLARATION_RE.exec(cleanUserText)
    if (toolMatch?.[1]) {
      const extractedTool = cleanExtractedFactValue(toolMatch[1], 80)
      if (extractedTool.length >= 3) {
        this.db.upsertSemanticFact({
          id: `fact-user-tool-${cleanTurnId}`,
          category: 'preference',
          subject: 'user',
          predicate: 'uses_tool',
          object: extractedTool,
          confidence: 0.85,
          sourceEpisodeIds: [episodeId],
          validFrom: now,
          invalidAt: null,
        })
        factsCreated += 1
      }
    }

    const projectMatch = USER_PROJECT_DECLARATION_RE.exec(cleanUserText)
    if (projectMatch?.[1]) {
      const extractedProject = cleanExtractedFactValue(projectMatch[1], 80)
      if (extractedProject.length >= 2) {
        this.db.upsertSemanticFact({
          id: `fact-user-project-${cleanTurnId}`,
          category: 'goal',
          subject: 'user',
          predicate: 'current_project',
          object: extractedProject,
          confidence: 0.85,
          sourceEpisodeIds: [episodeId],
          validFrom: now,
          invalidAt: null,
        })
        factsCreated += 1
      }
    }

    return {
      episodeCreated,
      factsCreated,
    }
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
