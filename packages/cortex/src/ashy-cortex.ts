import {
  EvaluateInitiativeInputSchema,
  type ApprovableMemoryKind,
  type AshyEmotion,
  type AutobiographicalMilestone,
  type ChatMessageRecord,
  type ChatSessionRecord,
  type CrossEpisodeLink,
  type DreamJournalEntry,
  type DreamReflectionCycleResult,
  type EpisodicMemory,
  type EvaluateInitiativeInput,
  type InitiativePolicy,
  type MemoryGovernanceCategory,
  type MemoryGovernancePolicy,
  type PersonalityEvolutionRecord,
  type PersonalityTraitKey,
  type PersonalityTraits,
  type ProactiveInitiativeRecord,
  type ProspectiveIntent,
  type RelationalMotif,
  type RelationshipStage,
  type RoomEnvironmentState,
  type SemanticFact,
  type SemanticFactCategory,
  type SeriousnessAssessment,
  type UpdateInitiativePolicyInput,
  type UpdateMilestoneInput,
  type UserHabit,
} from '@ashy/shared'
import * as v from 'valibot'
import {
  applyEmotionSignalToMood,
  applyExperienceTraitDelta,
  applyUserReactionToMood,
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
  detectCrossEpisodeLinks,
  isReflectablePermanentEpisode,
  proposeGroundedTraitEvolutions,
  runPredictCalibrateConsolidation,
  type CandidateRelationalMotifInput,
  type CandidateSemanticFactInput,
  type ConsolidationResult,
} from './dream/dream-worker'
import { extractStructuredEpisode } from './memory/episode-extractor'
import {
  detectEpisodeBoundary,
  type EpisodeBoundaryDecision,
} from './memory/episode-segmenter'
import {
  reviewEpisodicMemory,
  tokenizeForSearch,
  type FsrsReviewRating,
  type RankedEpisodicMemory,
} from './memory/fsrs-ranker'
import {
  evaluateTurnMemoryUsage,
  type EvaluateTurnMemoryUsageResult,
} from './memory/fsrs-turn-loop'
import {
  composeAshyTurnPrompt,
  type ComposedTurnPrompt,
  type ConversationMessage,
} from './prompt/soul-composer'
import { recordMotifInvocation, selectEligibleMotifs } from './relational/inside-joke-engine'
import { evaluateAttentionLoop } from './initiative/attention-loop'
import { deriveAshyRoomEnvironment } from './world/ashy-room'

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
  /\s*(?:,\s*(?:uso muito|eu trabalho com|meu projeto atual é|estou trabalhando no projeto|meu editor favorito é|agora meu|prefiro|amanhã|semana que vem|me lembra de|depois preciso|sempre costumo|todo dia)|\s+e\s+(?:uso muito|eu trabalho com|meu projeto atual é|estou trabalhando no projeto|pode me chamar de|meu nome é|meu editor favorito é|agora meu|prefiro|amanhã|semana que vem|me lembra de|depois preciso|sempre costumo|todo dia))(?=\s|$).*$/i

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

function normKey(value: string): string {
  return value.trim().toLowerCase()
}

export interface ConsolidateSessionMemoriesParams {
  sessionId: string
  nowMs?: number
  force?: boolean
  sessionSwitch?: boolean
  generateJsonFn?: (prompt: string) => Promise<string>
}

export interface ConsolidateSessionMemoriesResult {
  consolidated: boolean
  boundary: EpisodeBoundaryDecision
  episode: EpisodicMemory | null
  facts: SemanticFact[]
  motifs: RelationalMotif[]
  habits: UserHabit[]
  intents: ProspectiveIntent[]
  milestones: AutobiographicalMilestone[]
}

export class AshyCortex {
  public readonly db: CortexDatabase
  private readonly consolidationLocks = new Map<string, Promise<ConsolidateSessionMemoriesResult>>()

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

  // Governance & Quarantine delegation helpers
  public getMemoryGovernancePolicy(): MemoryGovernancePolicy {
    return this.db.getMemoryGovernancePolicy()
  }

  public setMemoryGovernancePolicy(
    category: MemoryGovernanceCategory,
    requireConfirmation: boolean,
  ): MemoryGovernancePolicy {
    return this.db.setMemoryGovernancePolicy(category, requireConfirmation)
  }

  public approveMemoryItem(
    kind: ApprovableMemoryKind,
    id: string,
    nowMs = Date.now(),
  ): boolean {
    return this.db.approveMemoryItem(kind, id, nowMs)
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
    interruptionControlNote?: string
    stageControlsPromptBlock?: string
    conversationHistory?: readonly ConversationMessage[]
    topKMemories?: number
    userHabits?: readonly UserHabit[]
    prospectiveIntents?: readonly ProspectiveIntent[]
  }): ComposedTurnPrompt {
    const nowMs = params.nowMs ?? Date.now()
    const state = this.db.getAffectiveState()
    const elapsedMinutes =
      state.updatedAt > 0 ? Math.max(0, (nowMs - state.updatedAt) / 60_000) : 0
    const decayedMood = decayMoodToBaseline(state.mood, elapsedMinutes)
    const seriousness = evaluateSeriousnessGate(params.userMessage)

    const { mood: reactedMood } = applyUserReactionToMood(decayedMood, params.userMessage, {
      seriousness,
    })
    this.db.saveAffectiveState({ ...state, mood: reactedMood, updatedAt: nowMs })
    const effectiveMood = reactedMood

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
        queryEmbedding: params.queryEmbedding,
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
      userHabits: params.userHabits ?? this.db.listUserHabits(),
      prospectiveIntents:
        params.prospectiveIntents ?? this.db.listProspectiveIntents('pending'),
      screenContext: params.screenContext,
      interruptionControlNote: params.interruptionControlNote,
      stageControlsPromptBlock: params.stageControlsPromptBlock,
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
    const policy = this.db.getMemoryGovernancePolicy()

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
        approvalStatus: policy.episodes ? 'pending_review' : 'approved',
      })
      episodeCreated = true
    }

    let factsCreated = 0

    const persistTurnFact = (params: {
      defaultId: string
      category: SemanticFactCategory
      predicate: string
      object: string
      confidence: number
    }) => {
      const activeFacts = this.db.listActiveSemanticFacts(params.category)
      const samePredicateActive = activeFacts.filter(
        (f) =>
          normKey(f.subject) === 'user' &&
          (normKey(f.predicate) === normKey(params.predicate) ||
            (params.predicate === 'name' && normKey(f.predicate) === 'user_name')),
      )

      const identicalActive = samePredicateActive.find(
        (f) => normKey(f.object) === normKey(params.object),
      )
      if (identicalActive) {
        const mergedEpisodeIds = Array.from(
          new Set([...identicalActive.sourceEpisodeIds, episodeId]),
        )
        this.db.upsertSemanticFact({
          ...identicalActive,
          sourceEpisodeIds: mergedEpisodeIds,
          approvalStatus: 'approved',
        })
        factsCreated += 1
        return
      }

      if (!policy.facts) {
        for (const existing of samePredicateActive) {
          if (existing.id !== params.defaultId) {
            this.db.invalidateSemanticFact(existing.id, now)
          }
        }
        this.db.upsertSemanticFact({
          id: params.defaultId,
          category: params.category,
          subject: 'user',
          predicate: params.predicate,
          object: params.object,
          confidence: params.confidence,
          sourceEpisodeIds: [episodeId],
          validFrom: now,
          invalidAt: null,
          approvalStatus: 'approved',
        })
        factsCreated += 1
        return
      }

      // Quarantine enabled (`policy.facts === true`):
      // Do NOT invalidate existing approved facts and do NOT overwrite an existing approved or pending_review ID
      const existingWithSameId = this.db
        .listSemanticFacts()
        .find((f) => f.id === params.defaultId)
      const candidateId = existingWithSameId
        ? `${params.defaultId}-${cleanTurnId}`
        : params.defaultId

      this.db.upsertSemanticFact({
        id: candidateId,
        category: params.category,
        subject: 'user',
        predicate: params.predicate,
        object: params.object,
        confidence: params.confidence,
        sourceEpisodeIds: [episodeId],
        validFrom: now,
        invalidAt: null,
        approvalStatus: 'pending_review',
      })
      factsCreated += 1
    }

    const nameMatch = USER_NAME_DECLARATION_RE.exec(cleanUserText)
    if (nameMatch?.[1]) {
      const extractedName = cleanExtractedUserName(nameMatch[1])
      if (extractedName.length >= 2) {
        persistTurnFact({
          defaultId: 'fact-user-name',
          category: 'identity',
          predicate: 'name',
          object: extractedName,
          confidence: 0.95,
        })
      }
    }

    const workMatch = USER_WORK_DECLARATION_RE.exec(cleanUserText)
    if (workMatch?.[1]) {
      const extractedWork = cleanExtractedFactValue(workMatch[1], 80)
      if (extractedWork.length >= 3) {
        persistTurnFact({
          defaultId: `fact-user-work-${cleanTurnId}`,
          category: 'preference',
          predicate: 'works_with',
          object: extractedWork,
          confidence: 0.85,
        })
      }
    }

    const toolMatch = USER_TOOL_DECLARATION_RE.exec(cleanUserText)
    if (toolMatch?.[1]) {
      const extractedTool = cleanExtractedFactValue(toolMatch[1], 80)
      if (extractedTool.length >= 3) {
        persistTurnFact({
          defaultId: `fact-user-tool-${cleanTurnId}`,
          category: 'preference',
          predicate: 'uses_tool',
          object: extractedTool,
          confidence: 0.85,
        })
      }
    }

    const projectMatch = USER_PROJECT_DECLARATION_RE.exec(cleanUserText)
    if (projectMatch?.[1]) {
      const extractedProject = cleanExtractedFactValue(projectMatch[1], 80)
      if (extractedProject.length >= 2) {
        persistTurnFact({
          defaultId: `fact-user-project-${cleanTurnId}`,
          category: 'goal',
          predicate: 'current_project',
          object: extractedProject,
          confidence: 0.85,
        })
      }
    }

    if (factsCreated > 0 && !episodeCreated && cleanUserText.length > 0) {
      this.db.upsertEpisodicMemory({
        id: episodeId,
        title: cleanUserText.slice(0, 60),
        summary: `Usuário: ${cleanUserText.slice(0, 120)} | Ashy: ${cleanAssistantText.slice(0, 120)}`,
        content: `Usuário: ${cleanUserText}\nAshy: ${cleanAssistantText}`,
        createdAt: now,
        lastReviewedAt: now,
        stability: 3.0,
        difficulty: 4.5,
        surprise: 0.4,
        isFlashbulb: false,
        tags: ['conversation'],
        approvalStatus: policy.episodes ? 'pending_review' : 'approved',
      })
      episodeCreated = true
    }

    return {
      episodeCreated,
      factsCreated,
    }
  }

  public async consolidateSessionMemories(
    params: ConsolidateSessionMemoriesParams,
  ): Promise<ConsolidateSessionMemoriesResult> {
    const lockKey = params.sessionId.trim() || '__default__'
    const prevLock = this.consolidationLocks.get(lockKey)
    const nextPromise = (prevLock ? prevLock.catch(() => undefined) : Promise.resolve()).then(
      () => this.executeConsolidateSessionMemories(params),
    )
    this.consolidationLocks.set(lockKey, nextPromise)
    try {
      return await nextPromise
    } finally {
      if (this.consolidationLocks.get(lockKey) === nextPromise) {
        this.consolidationLocks.delete(lockKey)
      }
    }
  }

  private async executeConsolidateSessionMemories(
    params: ConsolidateSessionMemoriesParams,
  ): Promise<ConsolidateSessionMemoriesResult> {
    const safeNow =
      params.nowMs !== undefined && Number.isFinite(params.nowMs) && params.nowMs >= 0
        ? params.nowMs
        : Date.now()

    const unconsolidated = this.db.listUnconsolidatedChatMessages(params.sessionId)
    const boundary = detectEpisodeBoundary(unconsolidated, {
      nowMs: safeNow,
      force: params.force,
      sessionSwitch: params.sessionSwitch,
    })

    if (!boundary.shouldConsolidate || boundary.batchMessages.length === 0) {
      return {
        consolidated: false,
        boundary,
        episode: null,
        facts: [],
        motifs: [],
        habits: [],
        intents: [],
        milestones: [],
      }
    }

    const batch = boundary.batchMessages
    const minCreatedAt = Math.min(...batch.map((m) => m.createdAt))
    const maxCreatedAt = Math.max(...batch.map((m) => m.createdAt))
    const cleanSessionSlug =
      params.sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'session'
    const firstMsgSlug = batch[0]!.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'm0'
    const episodeId = `ep-${cleanSessionSlug}-${minCreatedAt}-${firstMsgSlug}`

    const extracted = await extractStructuredEpisode({
      episodeId,
      messages: batch,
      generateJsonFn: params.generateJsonFn,
      nowMs: safeNow,
    })

    // Supersede any per-turn draft `ep-turn-*` episodes created during this batch window
    const supersededDraftIds = new Set<string>()
    for (const ep of this.db.listEpisodicMemories()) {
      if (!ep.id.startsWith('ep-turn-')) continue
      const turnSlug = ep.id.slice('ep-turn-'.length)
      const inTimeWindow =
        ep.createdAt >= minCreatedAt - 5_000 && ep.createdAt <= maxCreatedAt + 60_000
      const matchesTurnSlug = batch.some(
        (m) => turnSlug.length > 0 && m.id.includes(turnSlug),
      )
      const matchesBatchContent = batch.some(
        (m) => m.content.trim().length > 0 && ep.content.includes(m.content.trim()),
      )
      if (matchesTurnSlug || (inTimeWindow && matchesBatchContent)) {
        supersededDraftIds.add(ep.id)
      }
    }

    if (supersededDraftIds.size > 0) {
      for (const fact of this.db.listSemanticFacts()) {
        if (fact.sourceEpisodeIds.some((id) => supersededDraftIds.has(id))) {
          const updatedSourceIds = Array.from(
            new Set(
              fact.sourceEpisodeIds.map((id) => (supersededDraftIds.has(id) ? episodeId : id)),
            ),
          )
          this.db.upsertSemanticFact({
            ...fact,
            sourceEpisodeIds: updatedSourceIds,
          })
        }
      }
      for (const motif of this.db.listRelationalMotifs()) {
        if (motif.originEpisodeId && supersededDraftIds.has(motif.originEpisodeId)) {
          this.db.upsertRelationalMotif({
            ...motif,
            originEpisodeId: episodeId,
          })
        }
      }
      for (const draftId of supersededDraftIds) {
        this.db.migrateEvolutionEpisodeId(draftId, episodeId)
        this.db.deleteEpisodicMemory(draftId)
      }
    }

    const policy = this.db.getMemoryGovernancePolicy()

    // 1. Persist consolidated EpisodicMemory
    const episodeToSave: EpisodicMemory = {
      ...extracted.episode,
      approvalStatus: policy.episodes ? 'pending_review' : 'approved',
    }
    this.db.upsertEpisodicMemory(episodeToSave)

    // 2. Consolidate SemanticFacts (Predict -> Calibrate vs Quarantine)
    const allExistingFacts = this.db.listSemanticFacts()
    const approvedExistingFacts = allExistingFacts.filter(
      (f) => f.approvalStatus !== 'pending_review',
    )
    const existingMotifs = this.db.listRelationalMotifs()

    const consolidation = runPredictCalibrateConsolidation({
      episode: episodeToSave,
      candidateFacts: policy.facts
        ? []
        : extracted.facts.map((f) => ({
            id: f.id,
            category: f.category,
            subject: f.subject,
            predicate: f.predicate,
            object: f.object,
            confidence: f.confidence,
          })),
      candidateMotifs: policy.jokes
        ? []
        : extracted.motifs.map((m) => ({
            id: m.id,
            motif: m.motif,
            triggerCues: m.triggerCues,
            originSummary: m.originSummary,
          })),
      existingFacts: approvedExistingFacts,
      existingMotifs,
      nowMs: safeNow,
    })

    const persistedFacts: SemanticFact[] = []

    if (!policy.facts) {
      for (const fact of consolidation.updatedFacts) {
        const saved = this.db.upsertSemanticFact({
          ...fact,
          approvalStatus: 'approved',
        })
        if (saved.sourceEpisodeIds.includes(episodeId)) {
          persistedFacts.push(saved)
        }
      }
    } else {
      // Quarantine enabled (`policy.facts === true`):
      // Keep existing approved facts untouched and place only new/changed candidate facts in 'pending_review'
      for (const cand of extracted.facts) {
        const activeApprovedMatch = approvedExistingFacts.find(
          (f) =>
            (f.invalidAt === null || f.invalidAt === undefined) &&
            normKey(f.category) === normKey(cand.category) &&
            normKey(f.subject) === normKey(cand.subject) &&
            normKey(f.predicate) === normKey(cand.predicate) &&
            normKey(f.object) === normKey(cand.object),
        )

        if (activeApprovedMatch) {
          const reinforced = this.db.upsertSemanticFact({
            ...activeApprovedMatch,
            sourceEpisodeIds: Array.from(
              new Set([...activeApprovedMatch.sourceEpisodeIds, episodeId]),
            ),
            approvalStatus: 'approved',
          })
          persistedFacts.push(reinforced)
          continue
        }

        const existingPendingSame = this.db
          .listSemanticFacts()
          .find(
            (f) =>
              f.approvalStatus === 'pending_review' &&
              normKey(f.category) === normKey(cand.category) &&
              normKey(f.subject) === normKey(cand.subject) &&
              normKey(f.predicate) === normKey(cand.predicate) &&
              normKey(f.object) === normKey(cand.object),
          )

        const savedPending = this.db.upsertSemanticFact({
          ...cand,
          id: existingPendingSame?.id ?? cand.id,
          sourceEpisodeIds: Array.from(
            new Set([...(existingPendingSame?.sourceEpisodeIds ?? []), episodeId]),
          ),
          validFrom: safeNow,
          invalidAt: null,
          approvalStatus: 'pending_review',
        })
        persistedFacts.push(savedPending)
      }
    }

    // 3. Persist RelationalMotifs respecting `policy.jokes`
    const persistedMotifs: RelationalMotif[] = []
    if (!policy.jokes) {
      for (const motif of consolidation.updatedMotifs) {
        const preExisting = existingMotifs.find((m) => m.id === motif.id)
        const wasReinforcedInThisEpisode =
          !preExisting ||
          motif.originEpisodeId === episodeId ||
          motif.timesUsed !== preExisting.timesUsed ||
          motif.lastUsedAt !== preExisting.lastUsedAt ||
          extracted.motifs.some((cand) => normKey(cand.motif) === normKey(motif.motif))
        const approvalStatus = wasReinforcedInThisEpisode
          ? 'approved'
          : (preExisting?.approvalStatus ?? 'approved')
        const savedMotif = this.db.upsertRelationalMotif({
          ...motif,
          originEpisodeId: motif.originEpisodeId ?? episodeId,
          approvalStatus,
        })
        if (!preExisting || wasReinforcedInThisEpisode) {
          persistedMotifs.push(savedMotif)
        }
      }
    } else {
      for (const cand of extracted.motifs) {
        const existingPendingSame = existingMotifs.find(
          (m) =>
            m.approvalStatus === 'pending_review' &&
            normKey(m.motif) === normKey(cand.motif),
        )
        const savedPendingMotif = this.db.upsertRelationalMotif({
          ...cand,
          id: existingPendingSame?.id ?? cand.id,
          originEpisodeId: episodeId,
          approvalStatus: 'pending_review',
        })
        persistedMotifs.push(savedPendingMotif)
      }
    }

    // 4. Persist UserHabits respecting `policy.habits`
    const existingHabits = this.db.listUserHabits()
    const persistedHabits: UserHabit[] = []
    for (const habit of extracted.habits) {
      const existingSameKey = existingHabits.find(
        (h) => normKey(h.patternKey) === normKey(habit.patternKey),
      )
      if (existingSameKey && !policy.habits) {
        const updatedHabit = this.db.upsertUserHabit({
          ...existingSameKey,
          confidence: Math.min(1, Number((existingSameKey.confidence + 0.05).toFixed(4))),
          observationCount: existingSameKey.observationCount + 1,
          updatedAt: safeNow,
          sourceEpisodeId: episodeId,
          approvalStatus: 'approved',
        })
        persistedHabits.push(updatedHabit)
      } else {
        const savedHabit = this.db.upsertUserHabit({
          ...habit,
          id: existingSameKey?.id ?? habit.id,
          sourceEpisodeId: episodeId,
          approvalStatus: policy.habits ? 'pending_review' : 'approved',
        })
        persistedHabits.push(savedHabit)
      }
    }

    // 5. Persist ProspectiveIntents respecting `policy.intents`
    const existingIntents = this.db.listProspectiveIntents()
    const persistedIntents: ProspectiveIntent[] = []
    for (const intent of extracted.intents) {
      const duplicateIntent = existingIntents.find(
        (i) => i.status === 'pending' && normKey(i.topic) === normKey(intent.topic),
      )
      if (duplicateIntent) {
        if (duplicateIntent.approvalStatus === 'pending_review' && !policy.intents) {
          const promotedIntent = this.db.upsertProspectiveIntent({
            ...duplicateIntent,
            sourceEpisodeId: episodeId,
            approvalStatus: 'approved',
          })
          persistedIntents.push(promotedIntent)
        } else {
          persistedIntents.push(duplicateIntent)
        }
        continue
      }
      const savedIntent = this.db.upsertProspectiveIntent({
        ...intent,
        sourceEpisodeId: episodeId,
        approvalStatus: policy.intents ? 'pending_review' : 'approved',
      })
      persistedIntents.push(savedIntent)
    }

    // 6. Persist AutobiographicalMilestones (only for approved episodes/jokes)
    const persistedMilestones: AutobiographicalMilestone[] = []
    for (const milestone of consolidation.newMilestones) {
      if (milestone.category === 'flashbulb_moment' && policy.episodes) {
        continue
      }
      if (milestone.category === 'inside_joke_born' && policy.jokes) {
        continue
      }
      persistedMilestones.push(this.db.upsertMilestone(milestone))
    }

    // 7. Mark batch chat_messages as consolidated
    this.db.markChatMessagesConsolidated(
      batch.map((m) => m.id),
      episodeId,
    )

    return {
      consolidated: true,
      boundary,
      episode: episodeToSave,
      facts: persistedFacts,
      motifs: persistedMotifs,
      habits: persistedHabits,
      intents: persistedIntents,
      milestones: persistedMilestones,
    }
  }

  public reviewTurnMemories(params: {
    retrievedMemories: readonly RankedEpisodicMemory[]
    assistantText: string
    invokedMotifIds?: readonly string[]
    eligibleIntents?: readonly ProspectiveIntent[]
    nowMs?: number
  }): EvaluateTurnMemoryUsageResult {
    const safeNow =
      params.nowMs !== undefined && Number.isFinite(params.nowMs) && params.nowMs >= 0
        ? params.nowMs
        : Date.now()
    const evaluation = evaluateTurnMemoryUsage({
      retrievedMemories: params.retrievedMemories,
      assistantText: params.assistantText,
      invokedMotifIds: params.invokedMotifIds,
      motifs: this.db.listRelationalMotifs(),
      nowMs: safeNow,
    })

    for (const item of evaluation.reviewedMemories) {
      this.db.upsertEpisodicMemory(item.memory)
    }

    const MAX_OVERDUE_MS = 7 * 86_400_000
    const candidateIntents =
      params.eligibleIntents ??
      this.db.listProspectiveIntents('pending').filter((intent) => {
        if (intent.approvalStatus === 'pending_review') return false
        if (intent.dueAt === null || intent.dueAt === undefined) return false
        return intent.dueAt <= safeNow && safeNow - intent.dueAt <= MAX_OVERDUE_MS
      })

    const assistantTokens = new Set(tokenizeForSearch(params.assistantText ?? ''))
    for (const intent of candidateIntents) {
      if (intent.status !== 'pending' || intent.approvalStatus === 'pending_review') {
        continue
      }
      const isDue =
        intent.dueAt !== null &&
        intent.dueAt !== undefined &&
        intent.dueAt <= safeNow &&
        safeNow - intent.dueAt <= MAX_OVERDUE_MS
      const intentTokens = tokenizeForSearch(intent.topic).filter((t) => t.length >= 3)
      const mentionedInReply = intentTokens.some((t) => assistantTokens.has(t))
      if (isDue || mentionedInReply) {
        this.db.upsertProspectiveIntent({
          ...intent,
          status: 'triggered',
        })
      }
    }

    return evaluation
  }

  public recordEmotionPulse(
    emotion: AshyEmotion,
    intensity = 0.8,
    nowMs = Date.now(),
    options?: { seriousness?: SeriousnessAssessment },
  ) {
    const state = this.db.getAffectiveState()
    const elapsedMinutes =
      state.updatedAt > 0 ? Math.max(0, (nowMs - state.updatedAt) / 60_000) : 0
    const decayed = decayMoodToBaseline(state.mood, elapsedMinutes)
    const nextMood = applyEmotionSignalToMood(decayed, emotion, intensity, options)
    return this.db.saveAffectiveState(nextMood, state.traits, nowMs)
  }

  public async runDreamReflectionCycle(params?: {
    sessionId?: string
    nowMs?: number
    force?: boolean
    forceConsolidate?: boolean
    maxEvolutions?: number
    generateJsonFn?: (prompt: string) => Promise<string>
  }): Promise<DreamReflectionCycleResult> {
    const safeNow =
      params?.nowMs !== undefined && Number.isFinite(params.nowMs) && params.nowMs >= 0
        ? params.nowMs
        : Date.now()

    let consolidatedEpisodesCount = 0
    if (params?.forceConsolidate !== false) {
      const targetSessionIds = params?.sessionId
        ? [params.sessionId]
        : this.db.listSessions().map((s) => s.id)
      for (const sid of targetSessionIds) {
        if (this.db.listUnconsolidatedMessages(sid).length > 0) {
          const cRes = await this.consolidateSessionMemories({
            sessionId: sid,
            nowMs: safeNow,
            force: true,
            generateJsonFn: params?.generateJsonFn,
          })
          if (cRes.consolidated && cRes.episode) {
            consolidatedEpisodesCount += 1
          }
        }
      }
    }

    const allEpisodes = this.db.listEpisodicMemories(200)
    const reflectable = allEpisodes.filter(isReflectablePermanentEpisode)
    if (reflectable.length === 0) {
      return {
        ranAt: safeNow,
        consolidatedEpisodesCount,
        reviewedMemoriesCount: 0,
        crossEpisodeLinks: [],
        appliedEvolutions: [],
        skippedReason: 'no_new_episodes',
      }
    }

    const crossEpisodeLinks = detectCrossEpisodeLinks(reflectable)
    const uniqueLinkedEpisodeIds = Array.from(
      new Set(crossEpisodeLinks.flatMap((link) => [link.fromEpisodeId, link.toEpisodeId])),
    ).slice(0, 6)

    let reviewedMemoriesCount = 0
    for (const epId of uniqueLinkedEpisodeIds) {
      if (this.db.getEpisodicMemory(epId)) {
        this.reviewMemory(epId, 'good', safeNow)
        reviewedMemoriesCount += 1
      }
    }

    const existingLog = this.db.listPersonalityEvolution(200)
    const affect = this.db.getAffectiveState()
    const evoRes = proposeGroundedTraitEvolutions({
      episodes: reflectable,
      existingLog,
      currentTraits: affect.traits,
      nowMs: safeNow,
      maxEvolutions: params?.maxEvolutions,
    })

    for (const record of evoRes.records) {
      this.db.insertPersonalityEvolution(record)
    }
    for (const ms of evoRes.milestones) {
      this.db.upsertMilestone(ms)
    }
    if (evoRes.records.length > 0) {
      this.db.saveAffectiveState({ ...affect, traits: evoRes.traits, updatedAt: safeNow })
    }

    const skippedReason = evoRes.records.length === 0 ? 'already_reflected' : null

    const sourceEpisodeIds = reflectable.map((ep) => ep.id)
    const sortedSourceKey = [...sourceEpisodeIds].sort().join(',')
    const existingJournal = this.db.listDreamJournalEntries(20)
    const latestEntry = existingJournal[0]
    const hasSameEpisodeSetAsLatest =
      latestEntry !== undefined &&
      [...latestEntry.sourceEpisodeIds].sort().join(',') === sortedSourceKey &&
      evoRes.records.length === 0

    if (
      (skippedReason === null || params?.force === true || existingJournal.length === 0) &&
      !hasSameEpisodeSetAsLatest
    ) {
      const themesLabel =
        crossEpisodeLinks.length > 0
          ? crossEpisodeLinks
              .map((l) => l.sharedTheme)
              .slice(0, 3)
              .join(', ')
          : ''
      const summary =
        evoRes.records.length > 0 && crossEpisodeLinks.length > 0
          ? `Reflexão noturna sobre ${reflectable.length} episódio(s): ${crossEpisodeLinks.length} conexão(ões) temática(s) (${themesLabel}) e ${evoRes.records.length} evolução(ões) de traço (${evoRes.records.map((r) => r.trait).join(', ')}).`
          : crossEpisodeLinks.length > 0
            ? `Reflexão sobre ${reflectable.length} episódio(s) conectados pelo tema "${themesLabel}".`
            : evoRes.records.length > 0
              ? `Reflexão sobre ${reflectable.length} episódio(s): ${evoRes.records.map((r) => r.explanation).join(' ')}`
              : `Síntese reflexiva sobre ${reflectable.length} memória(s) permanente(s) do estúdio.`

      this.db.insertDreamJournalEntry({
        id: `dream-journal-${safeNow}-${existingJournal.length + 1}`,
        summary,
        sourceEpisodeIds,
        crossLinksCount: crossEpisodeLinks.length,
        traitEvolutionsCount: evoRes.records.length,
        createdAt: safeNow,
      })
    }

    return {
      ranAt: safeNow,
      consolidatedEpisodesCount,
      reviewedMemoriesCount,
      crossEpisodeLinks,
      appliedEvolutions: evoRes.records,
      skippedReason,
    }
  }

  // Phase 8 — Our Story, Ashy's Room, Dream Journal & Contextual Initiative helpers
  public updateMilestone(input: UpdateMilestoneInput): AutobiographicalMilestone {
    return this.db.updateMilestone(input)
  }

  public getInitiativePolicy(): InitiativePolicy {
    return this.db.getInitiativePolicy()
  }

  public saveInitiativePolicy(input: UpdateInitiativePolicyInput): InitiativePolicy {
    return this.db.saveInitiativePolicy(input)
  }

  public listProactiveInitiativeLog(limit = 50): ProactiveInitiativeRecord[] {
    return this.db.listProactiveInitiativeLog(limit)
  }

  public listDreamJournalEntries(limit = 50): DreamJournalEntry[] {
    return this.db.listDreamJournalEntries(limit)
  }

  public getCrossEpisodeLinks(): CrossEpisodeLink[] {
    return detectCrossEpisodeLinks(this.db.listEpisodicMemories(200))
  }

  public getRoomEnvironment(options?: {
    nowMs?: number
    localTimeHHMM?: string
  }): RoomEnvironmentState {
    return deriveAshyRoomEnvironment({
      milestones: this.db.listMilestones(),
      episodes: this.db.listEpisodicMemories(200),
      nowMs: options?.nowMs,
      localTimeHHMM: options?.localTimeHHMM,
    })
  }

  public evaluateAttentionInitiative(
    options?: EvaluateInitiativeInput,
  ): ProactiveInitiativeRecord {
    const parsed = options ? v.parse(EvaluateInitiativeInputSchema, options) : {}
    const policy = this.db.getInitiativePolicy()
    const consent = this.db.getAgencyConsentState()
    const dndMode = parsed.forceDnd !== undefined ? parsed.forceDnd : consent.dndMode
    const affect = this.db.getAffectiveState()
    const seriousness = parsed.recentUserMessage
      ? evaluateSeriousnessGate(parsed.recentUserMessage)
      : undefined

    const episodes = this.db.listEpisodicMemories(200)
    const milestones = this.db.listMilestones()
    const prospectiveIntents = this.db.listProspectiveIntents()
    const userHabits = this.db.listUserHabits()
    const recentInitiatives = this.db.listProactiveInitiativeLog(50)
    const crossEpisodeLinks = detectCrossEpisodeLinks(episodes)

    const record = evaluateAttentionLoop({
      policy,
      dndMode,
      nowMs: parsed.nowMs,
      localTimeHHMM: parsed.localTimeHHMM,
      prospectiveIntents,
      milestones,
      episodes,
      crossEpisodeLinks,
      userHabits,
      recentInitiatives,
      mood: affect.mood,
      seriousness,
      idleMinutes: parsed.idleMinutes,
      activeAppTitle: parsed.activeAppTitle,
      recentUserMessage: parsed.recentUserMessage,
      simulatedReplyText: parsed.simulatedReplyText,
    })

    const savedRecord = this.db.insertProactiveInitiativeLog(record)

    if (
      savedRecord.decision === 'spoken' &&
      savedRecord.triggerKind === 'prospective_intent' &&
      savedRecord.sourceId
    ) {
      const targetIntent = prospectiveIntents.find((i) => i.id === savedRecord.sourceId)
      if (targetIntent && targetIntent.status !== 'triggered') {
        this.db.upsertProspectiveIntent({
          ...targetIntent,
          status: 'triggered',
        })
      }
    }

    return savedRecord
  }

  public evolveTrait(params: {
    id?: string
    trait: PersonalityTraitKey
    delta: number
    reasonEpisodeId: string
    explanation: string
    nowMs?: number
  }): { traits: PersonalityTraits; record: PersonalityEvolutionRecord } {
    const nowMs = params.nowMs ?? Date.now()
    const state = this.db.getAffectiveState()
    const { traits, record } = applyExperienceTraitDelta(state.traits, {
      id: params.id,
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
    if (record.revertedAt !== null && record.revertedAt !== undefined) {
      return { traits: state.traits, record }
    }
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
    if (motif.approvalStatus === 'pending_review') {
      return motif
    }
    const updated = recordMotifInvocation(motif, userReactedPositively, nowMs)
    return this.db.upsertRelationalMotif(updated)
  }

  public recordMotifCallback(motifId: string, userReactedPositively: boolean, nowMs = Date.now()) {
    return this.recordJokeCallback(motifId, userReactedPositively, nowMs)
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
