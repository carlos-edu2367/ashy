import fs from 'node:fs'
import path from 'node:path'
import * as v from 'valibot'
import { createContainer, type DIContainer } from '@ashy/bus'
import { createAshyCortex, type AshyCortex } from '@ashy/cortex'
import {
  CompleteOnboardingInputSchema,
  type AshyBootstrapSnapshot,
  type AshyEmotion,
  type AshyHostBridge,
  type AshyHostStreamEvent,
  type ChatMessageRecord,
  type ChatSessionRecord,
  type CompleteOnboardingInput,
  type LlmProviderId,
  type ProviderHealthResult,
  type PublicProviderConfig,
  type RelationshipStage,
  type SaveProviderConfigInput,
  type SemanticFact,
  type SendTurnInput,
  type TestProviderInput,
  type UpsertFactInput,
} from '@ashy/shared'
import { seedAshyDemoFixtures } from '../test/fixtures/demo-seed'
import { createProviderVault, type ProviderVault } from './provider-vault'
import type { SecretProtector } from './secret-protector'
import { createTurnOrchestrator, type TurnOrchestrator } from './turn-orchestrator'
import { createVoiceIdentityStore, type VoiceIdentityStore } from './voice-identity-store'

export interface AshyHostKernelOptions {
  userDataDir: string
  secretProtector?: SecretProtector
  fetchImpl?: typeof fetch
  keepaliveIntervalMs?: number
}

export interface AshyHostKernel extends AshyHostBridge {
  readonly userDataDir: string
  readonly container: DIContainer
  readonly cortex: AshyCortex
  readonly voiceStore: VoiceIdentityStore
  readonly providerVault: ProviderVault
  readonly turnOrchestrator: TurnOrchestrator
  start(): Promise<void>
  stop(): Promise<void>
}

function deriveRelationshipMetrics(params: {
  totalTurns: number
  milestonesCount: number
  episodesCount: number
  hasEstablishedJoke: boolean
}): {
  stage: RelationshipStage
  familiarityScore: number
  trustScore: number
} {
  const { totalTurns, milestonesCount, episodesCount, hasEstablishedJoke } = params

  const familiarityScore = Math.min(
    1,
    Number((totalTurns * 0.05 + episodesCount * 0.05 + (hasEstablishedJoke ? 0.15 : 0)).toFixed(3)),
  )
  const trustScore = Math.min(
    1,
    Number((0.1 + totalTurns * 0.03 + Math.max(0, milestonesCount - 1) * 0.06).toFixed(3)),
  )

  let stage: RelationshipStage = 'stranger'
  if (totalTurns >= 40 || milestonesCount >= 5) {
    stage = 'companion'
  } else if (totalTurns >= 15 || hasEstablishedJoke) {
    stage = 'close_friend'
  } else if (totalTurns >= 3 || episodesCount >= 2) {
    stage = 'acquaintance'
  }

  return {
    stage,
    familiarityScore,
    trustScore,
  }
}

export async function createAshyHostKernel(
  options: AshyHostKernelOptions,
): Promise<AshyHostKernel> {
  fs.mkdirSync(options.userDataDir, { recursive: true })

  let activeSessionId = 'session-initial'
  let dominantEmotion: AshyEmotion = 'neutral'
  let lastPersistenceWarning: string | null = null
  let sessionSequence = 0
  let started = false

  const container = createContainer()

  const cortexToken = container.provide('cortex', {
    build: () =>
      createAshyCortex({
        filePath: path.join(options.userDataDir, 'ashy.db'),
      }),
    onStop: (instance) => {
      instance.close()
    },
  })

  const voiceStoreToken = container.provide('voiceStore', {
    build: () => createVoiceIdentityStore({ userDataDir: options.userDataDir }),
  })

  const providerVaultToken = container.provide('providerVault', {
    build: () =>
      createProviderVault({
        userDataDir: options.userDataDir,
        secretProtector: options.secretProtector,
        fetchImpl: options.fetchImpl,
      }),
  })

  const turnOrchestratorToken = container.provide('turnOrchestrator', {
    dependsOn: {
      cortex: cortexToken,
      voiceStore: voiceStoreToken,
      providerVault: providerVaultToken,
    },
    build: ({ cortex, voiceStore, providerVault }) =>
      createTurnOrchestrator({
        cortex,
        voiceStore,
        providerVault,
        getBootstrapSnapshot: () => buildSnapshot(cortex, voiceStore, providerVault),
        onPersistenceWarning: (warning) => {
          lastPersistenceWarning = warning
        },
        onDominantEmotionChange: (emotion) => {
          dominantEmotion = emotion
        },
        keepaliveIntervalMs: options.keepaliveIntervalMs,
      }),
    onStop: (instance) => {
      instance.abortAll()
    },
  })

  function buildSnapshot(
    cortex: AshyCortex,
    voiceStore: VoiceIdentityStore,
    providerVault: ProviderVault,
  ): AshyBootstrapSnapshot {
    let sessions = cortex.listChatSessions()
    if (sessions.length === 0) {
      const initialSession = cortex.createChatSession({
        id: 'session-initial',
        title: 'Primeiro Encontro',
      })
      sessions = [initialSession]
    }

    const activeSession =
      sessions.find((s) => s.id === activeSessionId) ?? sessions[0]!
    activeSessionId = activeSession.id

    const messages = cortex.listChatMessages(activeSession.id, 80)
    const milestones = cortex.db.listMilestones()
    const needsOnboarding = !milestones.some((m) => m.category === 'first_meeting')

    const identityFacts = cortex.db.listActiveSemanticFacts('identity')
    const userName =
      identityFacts
        .filter(
          (f) =>
            f.subject.toLowerCase() === 'user' &&
            (f.predicate === 'name' || f.predicate === 'user_name'),
        )
        .at(-1)?.object ?? null

    const userPronouns =
      identityFacts
        .filter(
          (f) =>
            f.subject.toLowerCase() === 'user' &&
            (f.predicate === 'pronouns' || f.predicate === 'user_pronouns'),
        )
        .at(-1)?.object ?? null

    const facts = cortex.db.listSemanticFacts()
    const episodes = cortex.db.listEpisodicMemories()
    const jokes = cortex.db.listRelationalMotifs()

    const totalTurns = sessions.reduce((sum, s) => sum + s.turnCount, 0)
    const hasEstablishedJoke = jokes.some(
      (j) => j.stage === 'inside_joke' || j.stage === 'legendary',
    )
    const relMetrics = deriveRelationshipMetrics({
      totalTurns,
      milestonesCount: milestones.length,
      episodesCount: episodes.length,
      hasEstablishedJoke,
    })

    const affective = cortex.db.getAffectiveState()
    const lastAssistantEmotion = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant')?.emotion
    const resolvedDominantEmotion = lastAssistantEmotion ?? dominantEmotion

    return {
      needsOnboarding,
      userProfile: {
        userName,
        userPronouns,
      },
      relationship: {
        stage: relMetrics.stage,
        familiarityScore: relMetrics.familiarityScore,
        trustScore: relMetrics.trustScore,
        totalTurns,
        milestones,
      },
      affect: {
        mood: affective.mood,
        traits: affective.traits,
        dominantEmotion: resolvedDominantEmotion,
      },
      activeSession,
      sessions,
      messages,
      memories: {
        facts,
        episodes,
        jokes,
      },
      voice: voiceStore.read(),
      providers: providerVault.getPublicState(),
      runtimeDiagnostics: {
        dbMode: cortex.db.isPersistent ? 'wal' : 'memory',
        dbPath: cortex.db.filePath,
        lastPersistenceWarning,
      },
    }
  }

  let cortexInstance!: AshyCortex
  let voiceStoreInstance!: VoiceIdentityStore
  let providerVaultInstance!: ProviderVault
  let turnOrchestratorInstance!: TurnOrchestrator

  async function start(): Promise<void> {
    if (started) return
    await container.start()
    cortexInstance = await container.resolve(cortexToken)
    voiceStoreInstance = await container.resolve(voiceStoreToken)
    providerVaultInstance = await container.resolve(providerVaultToken)
    turnOrchestratorInstance = await container.resolve(turnOrchestratorToken)
    started = true
  }

  async function stop(): Promise<void> {
    if (!started) return
    await container.stop()
    started = false
  }

  await start()

  return {
    userDataDir: options.userDataDir,
    container,
    get cortex() {
      return cortexInstance
    },
    get voiceStore() {
      return voiceStoreInstance
    },
    get providerVault() {
      return providerVaultInstance
    },
    get turnOrchestrator() {
      return turnOrchestratorInstance
    },
    start,
    stop,

    async getBootstrapSnapshot(): Promise<AshyBootstrapSnapshot> {
      return buildSnapshot(cortexInstance, voiceStoreInstance, providerVaultInstance)
    },

    async completeOnboarding(rawInput: CompleteOnboardingInput): Promise<AshyBootstrapSnapshot> {
      const input = v.parse(CompleteOnboardingInputSchema, rawInput)
      const now = Date.now()

      cortexInstance.db.upsertSemanticFact({
        id: 'fact-user-name',
        category: 'identity',
        subject: 'user',
        predicate: 'name',
        object: input.userName,
        confidence: 1.0,
        sourceEpisodeIds: ['milestone-first-meeting'],
        validFrom: now,
        invalidAt: null,
      })

      if (input.userPronouns && input.userPronouns.trim().length > 0) {
        cortexInstance.db.upsertSemanticFact({
          id: 'fact-user-pronouns',
          category: 'identity',
          subject: 'user',
          predicate: 'pronouns',
          object: input.userPronouns.trim(),
          confidence: 1.0,
          sourceEpisodeIds: ['milestone-first-meeting'],
          validFrom: now,
          invalidAt: null,
        })
      }

      if (input.providerConfig) {
        providerVaultInstance.saveProviderConfig(input.providerConfig)
        providerVaultInstance.setActiveProvider(input.providerConfig.providerId)
      }

      cortexInstance.db.upsertMilestone({
        id: 'milestone-first-meeting',
        title: 'Primeiro Encontro no Estúdio',
        narrative: `Ashy conheceu ${input.userName} no Cozy Night Studio.`,
        category: 'first_meeting',
        roomTrophyId: 'trophy-first-boot-mug',
        createdAt: now,
      })

      return buildSnapshot(cortexInstance, voiceStoreInstance, providerVaultInstance)
    },

    async createSession(title?: string): Promise<ChatSessionRecord> {
      sessionSequence += 1
      const id = `session-${Date.now()}-${sessionSequence}`
      const session = cortexInstance.createChatSession({
        id,
        title: title?.trim() || 'Nova Conversa',
      })
      activeSessionId = session.id
      return session
    },

    async selectSession(sessionId: string): Promise<{
      session: ChatSessionRecord
      messages: ChatMessageRecord[]
    }> {
      const session = cortexInstance.getChatSession(sessionId)
      if (!session) {
        throw new Error(`ChatSession not found: ${sessionId}`)
      }
      activeSessionId = session.id
      return {
        session,
        messages: cortexInstance.listChatMessages(session.id, 80),
      }
    },

    async sendTurn(input: SendTurnInput): Promise<{
      turnId: string
      userMessage: ChatMessageRecord
    }> {
      activeSessionId = input.sessionId
      return turnOrchestratorInstance.sendTurn(input)
    },

    async abortTurn(turnId: string): Promise<void> {
      return turnOrchestratorInstance.abortTurn(turnId)
    },

    async saveProviderConfig(input: SaveProviderConfigInput): Promise<{
      config: PublicProviderConfig
      providers: AshyBootstrapSnapshot['providers']
    }> {
      const config = providerVaultInstance.saveProviderConfig(input)
      return {
        config,
        providers: providerVaultInstance.getPublicState(),
      }
    },

    async setActiveProvider(
      providerId: LlmProviderId,
    ): Promise<AshyBootstrapSnapshot['providers']> {
      return providerVaultInstance.setActiveProvider(providerId)
    },

    async testProviderConnection(input: TestProviderInput): Promise<ProviderHealthResult> {
      return providerVaultInstance.testProviderConnection(input)
    },

    async saveVoiceIdentity(content: string): Promise<AshyBootstrapSnapshot['voice']> {
      return voiceStoreInstance.save(content)
    },

    async resetVoiceIdentity(): Promise<AshyBootstrapSnapshot['voice']> {
      return voiceStoreInstance.reset()
    },

    async upsertSemanticFact(input: UpsertFactInput): Promise<SemanticFact> {
      const now = Date.now()
      const subject = input.subject.trim()
      const predicate = input.predicate.trim()
      const object = input.object.trim()

      const existingActive = cortexInstance.db
        .listSemanticFacts({ activeOnly: true })
        .filter(
          (f) =>
            f.subject.toLowerCase() === subject.toLowerCase() &&
            f.predicate.toLowerCase() === predicate.toLowerCase(),
        )

      for (const prev of existingActive) {
        if (prev.id !== input.id && prev.object !== object) {
          cortexInstance.db.invalidateSemanticFact(prev.id, now)
        }
      }

      return cortexInstance.db.upsertSemanticFact({
        id: input.id?.trim() || `fact-${now}-${Math.random().toString(36).slice(2, 7)}`,
        category: input.category,
        subject,
        predicate,
        object,
        confidence: input.confidence ?? 0.95,
        sourceEpisodeIds: ['manual-ui-entry'],
        validFrom: now,
        invalidAt: null,
      })
    },

    async deleteMemoryItem(input: {
      kind: 'fact' | 'episode' | 'joke'
      id: string
    }): Promise<void> {
      if (input.kind === 'fact') {
        cortexInstance.db.deleteSemanticFact(input.id)
      } else if (input.kind === 'episode') {
        cortexInstance.db.deleteEpisodicMemory(input.id)
      } else if (input.kind === 'joke') {
        cortexInstance.db.deleteRelationalMotif(input.id)
      }
    },

    async seedDemoFixtures(): Promise<AshyBootstrapSnapshot> {
      seedAshyDemoFixtures(cortexInstance)
      dominantEmotion = 'smug'
      return buildSnapshot(cortexInstance, voiceStoreInstance, providerVaultInstance)
    },

    onHostEvent(listener: (event: AshyHostStreamEvent) => void): () => void {
      return turnOrchestratorInstance.onEvent(listener)
    },
  }
}
