import {
  ActionGatekeeper,
  PrivacyController,
  ProgressiveMcpRegistry,
  type ActionAuditLogEntry,
  type ApprovalScope,
  type EyesMode,
  type GatekeeperExecutionResult,
  type McpToolCompactSummary,
  type MicMode,
  type PendingActionCard,
  type PrivacyState,
} from '@ashy/agency'
import {
  AshyCortex,
  computeFsrsRetrievability,
  createAshyCortex,
  evaluateSeriousnessGate,
  inspectMotifCooldownStatus,
  selectEligibleMotifs,
  type ComposedTurnPrompt,
  type FsrsReviewRating,
  type MotifCooldownStatus,
  type RankedEpisodicMemory,
} from '@ashy/cortex'
import {
  CONTROL_SENTINEL,
  createTailSafeMarkerParser,
  stripLeadingAssistantSlop,
  type AshyStageSignal,
} from '@ashy/llm'
import {
  ASHY_EMOTIONS,
  type AshyEmotion,
  type AutobiographicalMilestone,
  type EpisodicMemory,
  type MilestoneCategory,
  type MoodVector,
  type PersonalityEvolutionRecord,
  type PersonalityTraits,
  type ProspectiveIntent,
  type RelationalMotif,
  type SemanticFact,
  type SemanticFactCategory,
  type UserHabit,
} from '@ashy/shared'
import type { AshyPresenceStatus } from '@ashy/stage'
import {
  createRealtimeSpeechPipeline,
  type PlaybackReceipt,
  type RealtimeSpeechPipeline,
  type ScheduledAudioChunk,
} from '@ashy/voice'
import { create } from 'zustand'

export type DesktopViewMode = 'hub' | 'stage'
export type HubTabId = 'studio' | 'story' | 'memories' | 'personality' | 'agency'

export type SupportedModelId =
  | 'claude-3-7-sonnet'
  | 'gpt-4.1'
  | 'deepseek-v3'
  | 'llama-3.3-70b-local'

export const SUPPORTED_MODELS: ReadonlyArray<{
  id: SupportedModelId
  label: string
  provider: string
  badge: string
}> = [
  {
    id: 'claude-3-7-sonnet',
    label: 'Claude 3.7 Sonnet',
    provider: 'Anthropic',
    badge: 'Cloud Flagship',
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    provider: 'OpenAI',
    badge: 'Fast Reasoning',
  },
  {
    id: 'deepseek-v3',
    label: 'DeepSeek V3',
    provider: 'OpenRouter',
    badge: 'Open-Weights MoE',
  },
  {
    id: 'llama-3.3-70b-local',
    label: 'Llama 3.3 70B (Local)',
    provider: 'Ollama Local',
    badge: '100% Offline',
  },
]

export interface ChatTurnMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  rawContent?: string
  emotion?: AshyEmotion
  modelId?: SupportedModelId
  invokedMotifId?: string
  seriousnessTriggered?: boolean
  timestamp: number
}

export interface RoomTrophy {
  id: string
  title: string
  subtitle: string
  milestoneId: string
  unlocked: boolean
}

export interface AshyDesktopState {
  // Navigation & View Mode
  viewMode: DesktopViewMode
  activeTab: HubTabId
  activeModelId: SupportedModelId

  // Stage & Procedural Controls
  stageMode: 'tachie' | 'live2d'
  stageEmotion: AshyEmotion
  emotionIntensity: number
  ambientLuminance: number
  isSpeaking: boolean
  presenceStatus: AshyPresenceStatus
  bubbleText: string
  simulatedVowels: { A: number; E: number; I: number; O: number; U: number }

  // Cortex Snapshots
  mood: MoodVector
  traits: PersonalityTraits
  milestones: AutobiographicalMilestone[]
  episodicMemories: EpisodicMemory[]
  rankedMemories: RankedEpisodicMemory[]
  memorySearchQuery: string
  semanticFacts: SemanticFact[]
  relationalMotifs: RelationalMotif[]
  userHabits: UserHabit[]
  prospectiveIntents: ProspectiveIntent[]
  personalityEvolutionLog: PersonalityEvolutionRecord[]
  lastPrompt: ComposedTurnPrompt
  roomTrophies: RoomTrophy[]

  // Chat & Speech Pipeline
  chatMessages: ChatTurnMessage[]
  scheduledAudioChunks: ScheduledAudioChunk[]
  lastPlaybackReceipt: PlaybackReceipt | null
  lastStageSignals: AshyStageSignal[]

  // Privacy & MCP Agency
  privacyState: PrivacyState
  mcpSearchQuery: string
  mcpSearchResults: McpToolCompactSummary[]
  exposedMetaToolsCount: number
  registeredMcpToolsCount: number
  pendingActions: PendingActionCard[]
  auditLog: ActionAuditLogEntry[]
  lastMcpResultSummary: string | null

  // Actions
  setViewMode: (mode: DesktopViewMode) => void
  setActiveTab: (tab: HubTabId) => void
  setActiveModelId: (modelId: SupportedModelId) => void
  setStageMode: (mode: 'tachie' | 'live2d') => void
  setStageEmotion: (emotion: AshyEmotion, intensity?: number) => void
  setAmbientLuminance: (luminance: number) => void
  toggleSimulatedSpeech: (speaking?: boolean) => void

  sendUserMessage: (userMessage: string) => Promise<void>
  triggerBargeIn: (interruptAtMs?: number) => PlaybackReceipt

  // Memory & Story Actions
  addMilestone: (input: {
    title: string
    narrative: string
    category: MilestoneCategory
  }) => AutobiographicalMilestone
  searchMemories: (query: string) => RankedEpisodicMemory[]
  reviewEpisodicMemoryById: (id: string, rating: FsrsReviewRating) => void
  invokeMotifManually: (motifId: string) => void
  resetMotifCooldown: (motifId: string) => void
  getMotifCooldownInfo: (motifId: string) => MotifCooldownStatus
  addSemanticFact: (input: {
    category: SemanticFactCategory
    subject: string
    predicate: string
    object: string
  }) => void
  completeProspectiveIntent: (intentId: string) => void

  // Personality & Dream Actions
  runDreamConsolidation: () => PersonalityEvolutionRecord
  revertTraitEvolution: (recordId: string) => void

  // Privacy & MCP Actions
  setMicMode: (mode: MicMode) => void
  setEyesMode: (mode: EyesMode) => void
  setDndMode: (enabled: boolean) => void
  activateFullPrivacyShield: () => void
  searchMcpTools: (query: string) => McpToolCompactSummary[]
  triggerMcpTool: (
    toolName: string,
    args?: Record<string, unknown>,
  ) => Promise<GatekeeperExecutionResult>
  approvePendingAction: (actionId: string, scope: ApprovalScope) => Promise<void>
  denyPendingAction: (actionId: string, reason?: string) => void

  resetStoreForTesting: () => void
}

const SEED_BASE_TIME = Date.UTC(2026, 9, 28, 3, 14, 0)

function createSeededRuntime() {
  const cortex = createAshyCortex({ forceMemoryFallback: true })

  // 1. Seed Milestones (Our Story)
  cortex.db.upsertMilestone({
    id: 'milestone-first-meeting',
    title: 'First Boot & Late-Night Architecture Session',
    narrative:
      'Primeira inicialização da Ashy no desktop. Definimos a arquitetura de 6 pacotes e prometemos zero clichês corporativos.',
    category: 'first_meeting',
    episodeId: 'ep-padre-npm-origin',
    roomTrophyId: 'trophy-first-boot-mug',
    createdAt: SEED_BASE_TIME - 7 * 86_400_000,
  })

  cortex.db.upsertMilestone({
    id: 'milestone-inside-joke-padre',
    title: "Born Inside Joke: 'Chamar um padre no npm'",
    narrative:
      'Depois de 2 horas caçando uma race condition fantasma sem logs, nasceu a piada oficial de rodar npx exorcist no npm.',
    category: 'inside_joke_born',
    episodeId: 'ep-padre-npm-origin',
    roomTrophyId: 'trophy-padre-npm-relic',
    createdAt: SEED_BASE_TIME - 4 * 86_400_000,
  })

  cortex.db.upsertMilestone({
    id: 'milestone-flashbulb-deploy',
    title: 'Saved Production Database at 03:14 AM',
    narrative:
      'Interceptamos um script de limpeza destrutivo antes de atingir o banco principal às 03:14 da manhã.',
    category: 'flashbulb_moment',
    episodeId: 'ep-flashbulb-0314',
    roomTrophyId: 'trophy-prod-shield',
    createdAt: SEED_BASE_TIME,
  })

  // 2. Seed Episodic Memories (FSRS-6 + Flashbulb)
  cortex.db.upsertEpisodicMemory({
    id: 'ep-flashbulb-0314',
    title: 'Saved Production Database at 03:14 AM',
    summary: 'Bloqueamos um rm -rf acidental e salvamos o cluster SQLite às 03:14 AM.',
    content:
      'Momento de alta adrenalina na madrugada: o Blast-Radius Guard segurou o comando destrutivo a tempo.',
    createdAt: SEED_BASE_TIME - 10 * 86_400_000,
    lastReviewedAt: SEED_BASE_TIME - 8 * 86_400_000,
    stability: 14.5,
    difficulty: 3.2,
    surprise: 0.96,
    isFlashbulb: true,
    tags: ['flashbulb', 'production', 'security'],
    embedding: [0.92, 0.18, 0.08, 0.02],
  })

  cortex.db.upsertEpisodicMemory({
    id: 'ep-padre-npm-origin',
    title: 'O Exorcismo do Backend (Padre no NPM)',
    summary: 'Caçamos um bug fantasma na fila de eventos e sugerimos chamar um padre no npm.',
    content:
      'Silêncio total nos logs do worker; descobrimos que era um listener órfão e criamos a piada do padre no npm.',
    createdAt: SEED_BASE_TIME - 5 * 86_400_000,
    lastReviewedAt: SEED_BASE_TIME - 2 * 86_400_000,
    stability: 6.4,
    difficulty: 4.1,
    surprise: 0.78,
    isFlashbulb: false,
    tags: ['debug', 'inside_joke', 'backend'],
    embedding: [0.75, 0.55, 0.12, 0.04],
  })

  cortex.db.upsertEpisodicMemory({
    id: 'ep-matrix3d-trauma',
    title: 'Migração do Chroma Key para Quad-Fitter',
    summary: 'Aposentamos o CSS matrix3d em favor de interseção de 4 retas de borda em Python.',
    content:
      'Prometemos que nunca mais usaríamos CSS matrix3d para tela verde em movimento.',
    createdAt: SEED_BASE_TIME - 3 * 86_400_000,
    lastReviewedAt: SEED_BASE_TIME - 1 * 86_400_000,
    stability: 4.2,
    difficulty: 4.8,
    surprise: 0.65,
    isFlashbulb: false,
    tags: ['video', 'architecture', 'chroma_key'],
    embedding: [0.35, 0.82, 0.24, 0.1],
  })

  // 3. Seed Semantic Facts (Active + Invalidated Bi-Temporal History)
  cortex.db.upsertSemanticFact({
    id: 'fact-favorite-stack',
    category: 'preference',
    subject: 'User',
    predicate: 'favorite_stack_is',
    object: 'TypeScript + SQLite + React 19',
    confidence: 0.98,
    sourceEpisodeIds: ['ep-padre-npm-origin'],
    validFrom: SEED_BASE_TIME - 7 * 86_400_000,
    invalidAt: null,
  })

  cortex.db.upsertSemanticFact({
    id: 'fact-anti-slop-rule',
    category: 'guideline',
    subject: 'User',
    predicate: 'hates_cliches',
    object: "corporate AI clichés ('Com certeza!', 'Como uma IA')",
    confidence: 0.99,
    sourceEpisodeIds: ['ep-padre-npm-origin'],
    validFrom: SEED_BASE_TIME - 7 * 86_400_000,
    invalidAt: null,
  })

  cortex.db.upsertSemanticFact({
    id: 'fact-old-orm',
    category: 'preference',
    subject: 'User',
    predicate: 'prefers_storage',
    object: 'Heavy C++ Native Addons with Node-Gyp',
    confidence: 0.72,
    sourceEpisodeIds: ['ep-padre-npm-origin'],
    validFrom: SEED_BASE_TIME - 14 * 86_400_000,
    invalidAt: SEED_BASE_TIME - 6 * 86_400_000,
  })

  cortex.db.upsertSemanticFact({
    id: 'fact-new-sqlite',
    category: 'preference',
    subject: 'User',
    predicate: 'prefers_storage',
    object: 'Native node:sqlite DatabaseSync + FTS5 Zero-Gyp',
    confidence: 0.97,
    sourceEpisodeIds: ['ep-flashbulb-0314'],
    validFrom: SEED_BASE_TIME - 6 * 86_400_000,
    invalidAt: null,
  })

  // 4. Seed Relational Motifs (Inside-Joke Engine)
  cortex.db.upsertRelationalMotif({
    id: 'motif-padre-npm',
    motif: 'chamar um padre no npm',
    originSummary: 'Surgiu às 02:40 AM quando o worker travou sem emitir uma única linha de log.',
    originEpisodeId: 'ep-padre-npm-origin',
    triggerCues: [
      'padre',
      'npm',
      'fantasma',
      'backend',
      'bug',
      'log',
      'logs',
      'exorcizar',
      'piada',
      'provocacao',
      'servidor',
    ],
    stage: 'inside_joke',
    timesUsed: 3,
    lastUsedAt: null,
    cooldownHours: 24,
    createdAt: SEED_BASE_TIME - 4 * 86_400_000,
  })

  cortex.db.upsertRelationalMotif({
    id: 'motif-crime-perfeito',
    motif: 'crime perfeito nos logs',
    originSummary: 'Quando um serviço falha silenciosamente com status 200 OK.',
    originEpisodeId: 'ep-padre-npm-origin',
    triggerCues: ['crime', 'perfeito', 'silencio', '200 ok', 'misterio'],
    stage: 'legendary',
    timesUsed: 6,
    lastUsedAt: null,
    cooldownHours: 48,
    createdAt: SEED_BASE_TIME - 6 * 86_400_000,
  })

  cortex.db.upsertRelationalMotif({
    id: 'motif-matrix3d',
    motif: 'Matrix3D Nunca Mais',
    originSummary: 'Promessa solene após migrar o tracking de tela verde para quad_fitter.py.',
    originEpisodeId: 'ep-matrix3d-trauma',
    triggerCues: ['matrix3d', 'chroma', 'tela verde', 'green screen'],
    stage: 'seed',
    timesUsed: 1,
    lastUsedAt: null,
    cooldownHours: 24,
    createdAt: SEED_BASE_TIME - 3 * 86_400_000,
  })

  // 5. Seed User Habits & Prospective Intents
  cortex.db.upsertUserHabit({
    id: 'habit-late-night',
    patternKey: 'coding_late_night',
    description: 'Sessões de arquitetura profunda concentradas entre 22h30 e 03h00.',
    confidence: 0.94,
    observationCount: 14,
    updatedAt: SEED_BASE_TIME,
  })

  cortex.db.upsertUserHabit({
    id: 'habit-tdd-strict',
    patternKey: 'tdd_red_green_refactor',
    description: 'Sempre exige testes falhando (RED) e mentalidade Red-Team antes do código.',
    confidence: 0.98,
    observationCount: 22,
    updatedAt: SEED_BASE_TIME,
  })

  cortex.db.upsertProspectiveIntent({
    id: 'intent-hydrate',
    topic: 'Remind user to hydrate after 2h debugging',
    contextCue: '2h continuous coding session',
    dueAt: SEED_BASE_TIME + 7_200_000,
    status: 'pending',
    createdAt: SEED_BASE_TIME,
  })

  cortex.db.upsertProspectiveIntent({
    id: 'intent-v1-launch',
    topic: 'Follow up on Ashy V1 launch',
    contextCue: 'All 7 workspace packages integrated in apps/desktop',
    dueAt: SEED_BASE_TIME + 86_400_000,
    status: 'pending',
    createdAt: SEED_BASE_TIME,
  })

  // 6. Initialize PrivacyController, ActionGatekeeper, and ProgressiveMcpRegistry
  const privacyController = new PrivacyController({
    micMode: 'continuous',
    eyesMode: 'window',
    dndMode: false,
    allowedWindowTitles: ['VS Code', 'Ashy', 'Terminal'],
    allowedPaths: ['/workspace/ashy', 'C:/Users/User/.gemini/antigravity/scratch/ashy'],
  })

  const gatekeeper = new ActionGatekeeper({
    privacyController,
  })

  const mcpRegistry = new ProgressiveMcpRegistry({
    gatekeeper,
  })

  mcpRegistry.registerServer({
    name: 'desktop-vision',
    description: 'Active window and screen observation sensor with dHash perceptual dedup',
  })
  mcpRegistry.registerServer({
    name: 'workspace-fs',
    description: 'Sandboxed workspace file reader protected against path traversal',
  })
  mcpRegistry.registerServer({
    name: 'workspace-notes',
    description: 'Project notes and architectural decision log writer',
  })
  mcpRegistry.registerServer({
    name: 'workspace-shell',
    description: 'Workspace build & cleanup runner with Blast-Radius Guard',
  })

  mcpRegistry.registerTools([
    {
      toolName: 'get_active_window_title',
      serverName: 'desktop-vision',
      description: 'Reads the currently focused desktop window title when EyesMode allows it.',
      riskTier: 'observe-only',
      inputSchema: {
        type: 'object',
        properties: {
          windowTitle: { type: 'string' },
        },
      },
      handler: (args) => ({
        observedWindow: String(args.windowTitle ?? 'VS Code — ashy/apps/desktop/src/App.tsx'),
        timestamp: Date.now(),
      }),
    },
    {
      toolName: 'read_workspace_file',
      serverName: 'workspace-fs',
      description: 'Reads a file strictly inside the allowed workspace directory.',
      riskTier: 'read-safe',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
      handler: (args) => ({
        path: String(args.path),
        preview: 'export const PACKAGE_NAME = "@ashy/desktop"',
      }),
    },
    {
      toolName: 'write_project_note',
      serverName: 'workspace-notes',
      description: 'Writes a markdown note to the project workspace (requires user confirmation).',
      riskTier: 'staged-confirm',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title'],
      },
      handler: (args) => ({
        saved: true,
        title: String(args.title ?? 'Untitled Note'),
      }),
    },
    {
      toolName: 'run_cleanup_command',
      serverName: 'workspace-shell',
      description: 'Executes a workspace shell cleanup command (inspected by Blast-Radius Guard).',
      riskTier: 'staged-confirm',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
      handler: (args) => ({
        executedCommand: String(args.command ?? ''),
        exitCode: 0,
      }),
    },
  ])

  return {
    cortex,
    privacyController,
    gatekeeper,
    mcpRegistry,
  }
}

let runtime = createSeededRuntime()
let activeSpeechPipeline: RealtimeSpeechPipeline | null = null

function buildRoomTrophies(milestones: readonly AutobiographicalMilestone[]): RoomTrophy[] {
  const milestoneIds = new Set(milestones.map((m) => m.id))
  return [
    {
      id: 'trophy-first-boot-mug',
      title: 'First Boot Mug',
      subtitle: 'Unlocked by First Boot & Late-Night Architecture Session',
      milestoneId: 'milestone-first-meeting',
      unlocked: milestoneIds.has('milestone-first-meeting'),
    },
    {
      id: 'trophy-padre-npm-relic',
      title: 'Padre no NPM Relic',
      subtitle: "Unlocked by Born Inside Joke: 'Chamar um padre no npm'",
      milestoneId: 'milestone-inside-joke-padre',
      unlocked: milestoneIds.has('milestone-inside-joke-padre'),
    },
    {
      id: 'trophy-prod-shield',
      title: '03:14 AM Production Shield',
      subtitle: 'Unlocked by Saved Production Database at 03:14 AM',
      milestoneId: 'milestone-flashbulb-deploy',
      unlocked: milestoneIds.has('milestone-flashbulb-deploy'),
    },
  ]
}

function parseAssistantRawOutput(rawReply: string): {
  cleanText: string
  textWithSentinels: string
  signals: AshyStageSignal[]
} {
  let literalAccum = ''
  let sentinelAccum = ''
  const signals: AshyStageSignal[] = []

  const parser = createTailSafeMarkerParser({
    onLiteral(chunk) {
      literalAccum += chunk
      sentinelAccum += chunk
    },
    onSpecial(sig) {
      signals.push(sig)
      sentinelAccum += CONTROL_SENTINEL
    },
  })

  parser.write(rawReply)
  parser.flush()

  const cleanText = stripLeadingAssistantSlop(literalAccum).trim()
  const cleanSentinelText = stripLeadingAssistantSlop(sentinelAccum).trim()

  return {
    cleanText,
    textWithSentinels: cleanSentinelText,
    signals,
  }
}

export const useAshyStore = create<AshyDesktopState>((set, get) => {
  function syncFromCortex(activeModelId?: SupportedModelId) {
    const modelId = activeModelId ?? get().activeModelId
    const affective = runtime.cortex.db.getAffectiveState()
    const milestones = runtime.cortex.db.listMilestones()
    const episodicMemories = runtime.cortex.db.listEpisodicMemories()
    const query = get()?.memorySearchQuery ?? ''
    const rankedMemories = runtime.cortex.db.searchEpisodicMemoriesHybrid(query, undefined, {
      nowMs: Date.now(),
      limit: 10,
    })
    const semanticFacts = runtime.cortex.db.listSemanticFacts()
    const relationalMotifs = runtime.cortex.db.listRelationalMotifs()
    const userHabits = runtime.cortex.db.listUserHabits()
    const prospectiveIntents = runtime.cortex.db.listProspectiveIntents()
    const personalityEvolutionLog = runtime.cortex.db.listPersonalityEvolution()

    const lastUserMsg =
      [...(get()?.chatMessages ?? [])].reverse().find((m) => m.role === 'user')?.content ??
      'Revisando o status da arquitetura Ashy v1 no desktop.'

    const lastPrompt = runtime.cortex.compileTurnPrompt({
      userMessage: lastUserMsg,
      modelId,
      nowMs: Date.now(),
      screenContext: 'VS Code — apps/desktop/src/App.tsx',
    })

    return {
      mood: affective.mood,
      traits: affective.traits,
      milestones,
      episodicMemories,
      rankedMemories,
      semanticFacts,
      relationalMotifs,
      userHabits,
      prospectiveIntents,
      personalityEvolutionLog,
      lastPrompt,
      roomTrophies: buildRoomTrophies(milestones),
    }
  }

  function createPipelineForTurn(): RealtimeSpeechPipeline {
    const pipeline = createRealtimeSpeechPipeline({
      synthesizeFn: async (text) => {
        const wordCount = Math.max(1, text.trim().split(/\s+/).length)
        const durationMs = Math.max(450, wordCount * 120)
        return {
          durationMs,
          durationSec: durationMs / 1000,
        }
      },
      onStageSignal: (signal) => {
        if (signal.type === 'act' && signal.emotion) {
          set({
            stageEmotion: signal.emotion,
            emotionIntensity: signal.intensity ?? 0.85,
          })
        }
      },
    })
    activeSpeechPipeline = pipeline
    return pipeline
  }

  const initialAffective = runtime.cortex.db.getAffectiveState()
  const initialMilestones = runtime.cortex.db.listMilestones()
  const initialMemories = runtime.cortex.db.listEpisodicMemories()
  const initialRanked = runtime.cortex.db.searchEpisodicMemoriesHybrid('', undefined, {
    nowMs: SEED_BASE_TIME,
    limit: 10,
  })
  const initialPrompt = runtime.cortex.compileTurnPrompt({
    userMessage: 'Pronta para mais uma sessão de arquitetura, Ashy?',
    modelId: 'claude-3-7-sonnet',
    nowMs: SEED_BASE_TIME,
    screenContext: 'VS Code — apps/desktop/src/App.tsx',
  })

  const initialChat: ChatTurnMessage[] = [
    {
      id: 'msg-seed-1',
      role: 'user',
      content: 'Pronta para mais uma sessão de arquitetura, Ashy?',
      timestamp: SEED_BASE_TIME - 60_000,
    },
    {
      id: 'msg-seed-2',
      role: 'assistant',
      content:
        'Já deixei o SQLite FTS5 aquecido e o escudo de Blast-Radius ligado. Se aparecer outro bug fantasma hoje, a gente já sabe: nada de clichê corporativo, é direto pro trace antes de precisar chamar um padre no npm.',
      emotion: 'smug',
      modelId: 'claude-3-7-sonnet',
      timestamp: SEED_BASE_TIME - 55_000,
    },
  ]

  return {
    viewMode:
      typeof window !== 'undefined' && window.location?.search?.includes('view=stage')
        ? 'stage'
        : 'hub',
    activeTab: 'studio',
    activeModelId: 'claude-3-7-sonnet',

    stageMode: 'tachie',
    stageEmotion: 'smug',
    emotionIntensity: 0.85,
    ambientLuminance: 0.35,
    isSpeaking: false,
    presenceStatus: 'Idle',
    bubbleText:
      'SQLite FTS5 aquecido e Blast-Radius ligado. Bora quebrar esse código antes que ele quebre a gente.',
    simulatedVowels: { A: 0.65, E: 0.25, I: 0.1, O: 0.35, U: 0.15 },

    mood: initialAffective.mood,
    traits: initialAffective.traits,
    milestones: initialMilestones,
    episodicMemories: initialMemories,
    rankedMemories: initialRanked,
    memorySearchQuery: '',
    semanticFacts: runtime.cortex.db.listSemanticFacts(),
    relationalMotifs: runtime.cortex.db.listRelationalMotifs(),
    userHabits: runtime.cortex.db.listUserHabits(),
    prospectiveIntents: runtime.cortex.db.listProspectiveIntents(),
    personalityEvolutionLog: runtime.cortex.db.listPersonalityEvolution(),
    lastPrompt: initialPrompt,
    roomTrophies: buildRoomTrophies(initialMilestones),

    chatMessages: initialChat,
    scheduledAudioChunks: [],
    lastPlaybackReceipt: null,
    lastStageSignals: [],

    privacyState: runtime.privacyController.getState(),
    mcpSearchQuery: '',
    mcpSearchResults: runtime.mcpRegistry.search_mcp_tools({ query: '', limit: 10 }),
    exposedMetaToolsCount: runtime.mcpRegistry.getExposedMetaTools().length,
    registeredMcpToolsCount: runtime.mcpRegistry.getRegisteredToolsCount(),
    pendingActions: runtime.gatekeeper.getPendingActions(),
    auditLog: [...runtime.gatekeeper.getAuditLog()],
    lastMcpResultSummary: null,

    setViewMode(mode) {
      set({ viewMode: mode })
    },

    setActiveTab(tab) {
      set({ activeTab: tab })
    },

    setActiveModelId(modelId) {
      const lastUserMsg =
        [...get().chatMessages].reverse().find((m) => m.role === 'user')?.content ??
        'Pronta para mais uma sessão de arquitetura, Ashy?'

      const compiled = runtime.cortex.compileTurnPrompt({
        userMessage: lastUserMsg,
        modelId,
        nowMs: Date.now(),
        screenContext: 'VS Code — apps/desktop/src/App.tsx',
      })

      set({
        activeModelId: modelId,
        lastPrompt: compiled,
      })
    },

    setStageMode(mode) {
      set({ stageMode: mode })
    },

    setStageEmotion(emotion, intensity = 0.85) {
      if (!ASHY_EMOTIONS.includes(emotion)) return
      const pulsed = runtime.cortex.recordEmotionPulse(emotion, intensity, Date.now())
      set({
        stageEmotion: emotion,
        emotionIntensity: intensity,
        mood: pulsed.mood,
      })
    },

    setAmbientLuminance(luminance) {
      const clamped = Math.min(1, Math.max(0, Number.isFinite(luminance) ? luminance : 0.35))
      set({ ambientLuminance: clamped })
    },

    toggleSimulatedSpeech(speaking) {
      const nextSpeaking = speaking !== undefined ? speaking : !get().isSpeaking
      set({
        isSpeaking: nextSpeaking,
        presenceStatus: nextSpeaking ? 'Speaking' : 'Idle',
        simulatedVowels: nextSpeaking
          ? { A: 0.78, E: 0.35, I: 0.15, O: 0.45, U: 0.2 }
          : { A: 0, E: 0, I: 0, O: 0, U: 0 },
      })
    },

    async sendUserMessage(userMessage: string) {
      const trimmed = userMessage.trim()
      if (!trimmed) return

      const nowMs = Date.now()
      const currentModelId = get().activeModelId
      const seriousness = evaluateSeriousnessGate(trimmed)

      const compiledPrompt = runtime.cortex.compileTurnPrompt({
        userMessage: trimmed,
        modelId: currentModelId,
        nowMs,
        screenContext: 'VS Code — apps/desktop/src/App.tsx',
        conversationHistory: get().chatMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      })

      const userTurn: ChatTurnMessage = {
        id: `msg-user-${nowMs}`,
        role: 'user',
        content: trimmed,
        timestamp: nowMs,
      }

      let rawAssistantReply = ''
      let targetEmotion: AshyEmotion = 'smug'
      let invokedMotifId: string | undefined

      if (seriousness.isSeriousOrDelicate) {
        targetEmotion = 'concerned'
        rawAssistantReply =
          '<|ACT {"emotion":"concerned","intensity":0.9}|> Ei... respira um segundo. Hoje foi pesado demais mesmo. <|DELAY 0.4|> Larga esse teclado um pouco, eu seguro as pontas por aqui — me conta o que aconteceu se quiser desabafar, ou a gente só fica quieto um instante.'

        const currentState = runtime.cortex.db.getAffectiveState()
        const seriousMood: MoodVector = {
          valence: -0.1,
          arousal: 0.35,
          playfulness: Math.min(0.12, seriousness.maxPlayfulnessAllowed),
        }
        runtime.cortex.db.saveAffectiveState(seriousMood, currentState.traits, nowMs)
      } else {
        // Select eligible motifs not under CooldownLock
        const allMotifs = runtime.cortex.db.listRelationalMotifs()
        const eligibleMatches = selectEligibleMotifs(allMotifs, trimmed, nowMs, {
          isSeriousContext: false,
          minRelevance: 0.15,
        })

        // If the message matches an eligible motif (or if padre-npm is ready and playful banter is requested)
        const chosenMotif =
          eligibleMatches[0]?.motif ??
          allMotifs.find(
            (m) =>
              m.id === 'motif-padre-npm' &&
              !inspectMotifCooldownStatus(m, nowMs).isCooldownLocked,
          )

        if (chosenMotif) {
          invokedMotifId = chosenMotif.id
          runtime.cortex.recordJokeCallback(chosenMotif.id, true, nowMs)
          targetEmotion = 'smug'
          rawAssistantReply = `<|ACT {"emotion":"smug","intensity":0.88}|> Com certeza! Como uma IA, digo: brincadeira! Silêncio suspeito no sistema nunca me engana. <|DELAY 0.35|> Já preparei o trace completo e se esse estado fantasma piscar de novo, a gente vai precisar ${chosenMotif.motif} (<|CALLBACK ${chosenMotif.id}|>) antes do próximo deploy.`
        } else {
          targetEmotion = 'tease'
          rawAssistantReply =
            '<|ACT {"emotion":"tease","intensity":0.84}|> Essa piada já entrou em Cooldown Lock pra não saturar, mas meu radar de arquitetura continua afiado! <|DELAY 0.3|> Manda o próximo módulo que a gente destrincha em tempo real.'
        }

        runtime.cortex.recordEmotionPulse(targetEmotion, 0.85, nowMs)
      }

      const parsed = parseAssistantRawOutput(rawAssistantReply)
      const pipeline = createPipelineForTurn()
      pipeline.enqueue(parsed.textWithSentinels, parsed.signals)

      // Allow microtasks from synthesizeFn promises to settle so scheduledAudioChunks are populated immediately
      await Promise.resolve()
      await Promise.resolve()

      const scheduledChunks = [...pipeline.getScheduledChunks()]
      const assistantTurn: ChatTurnMessage = {
        id: `msg-ashy-${nowMs + 1}`,
        role: 'assistant',
        content: parsed.cleanText,
        rawContent: rawAssistantReply,
        emotion: targetEmotion,
        modelId: currentModelId,
        invokedMotifId,
        seriousnessTriggered: seriousness.isSeriousOrDelicate,
        timestamp: nowMs + 1,
      }

      const nextCortexSnapshot = syncFromCortex(currentModelId)

      set({
        ...nextCortexSnapshot,
        lastPrompt: compiledPrompt,
        chatMessages: [...get().chatMessages, userTurn, assistantTurn],
        stageEmotion: targetEmotion,
        bubbleText: parsed.cleanText,
        isSpeaking: true,
        presenceStatus: 'Speaking',
        simulatedVowels: { A: 0.75, E: 0.4, I: 0.2, O: 0.5, U: 0.15 },
        scheduledAudioChunks: scheduledChunks,
        lastStageSignals: parsed.signals,
      })
    },

    triggerBargeIn(interruptAtMs = 600) {
      let pipeline = activeSpeechPipeline
      if (!pipeline || pipeline.getScheduledChunks().length === 0) {
        pipeline = createPipelineForTurn()
        pipeline.enqueue(
          'Olha só, eu estava explicando toda a arquitetura de memória episódica FSRS-6. Mas você me cortou bem no meio da frase!',
          [],
        )
      }

      const interruptSec = Math.max(0.05, interruptAtMs / 1000)
      const receipt = pipeline.interrupt('user_barge_in', interruptSec)

      set({
        isSpeaking: false,
        presenceStatus: 'Listening',
        stageEmotion: 'surprised',
        simulatedVowels: { A: 0, E: 0, I: 0, O: 0, U: 0 },
        lastPlaybackReceipt: receipt,
        bubbleText: `${receipt.heardText} — [Barge-In!]`,
      })

      return receipt
    },

    addMilestone(input) {
      const nowMs = Date.now()
      const created = runtime.cortex.db.upsertMilestone({
        id: `milestone-custom-${nowMs}`,
        title: input.title.trim() || 'New Shared Milestone',
        narrative: input.narrative.trim() || 'Recorded manually in Our Story timeline.',
        category: input.category,
        createdAt: nowMs,
      })
      set(syncFromCortex())
      return created
    },

    searchMemories(query) {
      const results = runtime.cortex.db.searchEpisodicMemoriesHybrid(query, undefined, {
        nowMs: Date.now(),
        limit: 10,
      })
      set({
        memorySearchQuery: query,
        rankedMemories: results,
      })
      return results
    },

    reviewEpisodicMemoryById(id, rating) {
      runtime.cortex.reviewMemory(id, rating, Date.now())
      set(syncFromCortex())
    },

    invokeMotifManually(motifId) {
      runtime.cortex.recordJokeCallback(motifId, true, Date.now())
      set(syncFromCortex())
    },

    resetMotifCooldown(motifId) {
      const existing = runtime.cortex.db.getRelationalMotif(motifId)
      if (!existing) return
      runtime.cortex.db.upsertRelationalMotif({
        ...existing,
        lastUsedAt: null,
      })
      set(syncFromCortex())
    },

    getMotifCooldownInfo(motifId) {
      const motif = runtime.cortex.db.getRelationalMotif(motifId)
      if (!motif) {
        return {
          isCooldownLocked: false,
          elapsedHoursSinceUse: null,
          remainingCooldownHours: 0,
        }
      }
      return inspectMotifCooldownStatus(motif, Date.now())
    },

    addSemanticFact(input) {
      const nowMs = Date.now()
      const existingActive = runtime.cortex.db
        .listSemanticFacts({ activeOnly: true })
        .find(
          (f) =>
            f.category.toLowerCase() === input.category.toLowerCase() &&
            f.subject.toLowerCase() === input.subject.trim().toLowerCase() &&
            f.predicate.toLowerCase() === input.predicate.trim().toLowerCase(),
        )

      if (existingActive) {
        runtime.cortex.db.invalidateSemanticFact(existingActive.id, nowMs)
      }

      runtime.cortex.db.upsertSemanticFact({
        id: `fact-custom-${nowMs}`,
        category: input.category,
        subject: input.subject.trim() || 'User',
        predicate: input.predicate.trim() || 'prefers',
        object: input.object.trim() || 'TypeScript',
        confidence: 0.95,
        sourceEpisodeIds: ['ep-padre-npm-origin'],
        validFrom: nowMs,
        invalidAt: null,
      })

      set(syncFromCortex())
    },

    completeProspectiveIntent(intentId) {
      const existing = runtime.cortex.db.listProspectiveIntents().find((i) => i.id === intentId)
      if (!existing) return
      runtime.cortex.db.upsertProspectiveIntent({
        ...existing,
        status: 'completed',
      })
      set(syncFromCortex())
    },

    runDreamConsolidation() {
      const nowMs = Date.now()
      runtime.cortex.ingestEpisodeWithConsolidation({
        episode: {
          id: `ep-dream-${nowMs}`,
          title: 'Dream & Reflection Consolidation Cycle',
          summary:
            'Consolidação noturna reforçou memórias de arquitetura e aumentou a afinidade com o usuário.',
          content:
            'Durante o ciclo de Dream & Reflection, Ashy revisou os episódios de pair programming.',
          createdAt: nowMs,
          lastReviewedAt: nowMs,
          stability: 8.0,
          difficulty: 3.5,
          surprise: 0.72,
          isFlashbulb: false,
          tags: ['dream_cycle', 'late_night_debug'],
        },
        candidateFacts: [
          {
            category: 'preference',
            subject: 'User',
            predicate: 'favorite_stack_is',
            object: 'TypeScript + SQLite + React 19',
          },
        ],
        nowMs,
      })

      const { record } = runtime.cortex.evolveTrait({
        trait: 'warmthAffection',
        delta: 0.05,
        reasonEpisodeId: `ep-dream-${nowMs}`,
        explanation:
          'Dream & Reflection consolidation: shared late-night debugging and mutual trust increased warmthAffection (+0.05).',
        nowMs,
      })

      set({
        ...syncFromCortex(),
        stageEmotion: 'happy',
      })

      return record
    },

    revertTraitEvolution(recordId) {
      runtime.cortex.revertTrait(recordId, Date.now())
      set(syncFromCortex())
    },

    setMicMode(mode) {
      runtime.privacyController.setMicMode(mode)
      set({ privacyState: runtime.privacyController.getState() })
    },

    setEyesMode(mode) {
      runtime.privacyController.setEyesMode(mode)
      set({ privacyState: runtime.privacyController.getState() })
    },

    setDndMode(enabled) {
      runtime.privacyController.setDndMode(enabled)
      set({ privacyState: runtime.privacyController.getState() })
    },

    activateFullPrivacyShield() {
      const next = runtime.privacyController.activatePrivacyShield()
      set({ privacyState: next })
    },

    searchMcpTools(query) {
      const results = runtime.mcpRegistry.search_mcp_tools({ query, limit: 10 })
      set({
        mcpSearchQuery: query,
        mcpSearchResults: results,
      })
      return results
    },

    async triggerMcpTool(toolName, args = {}) {
      const res = await runtime.mcpRegistry.call_mcp_tool({ toolName, args })
      let summary = `Tool "${toolName}" -> ${res.status}`
      if (res.pendingCard?.blastRadiusWarning) {
        summary += ` (${res.pendingCard.blastRadiusWarning})`
      } else if (res.reason) {
        summary += ` (${res.reason})`
      }

      set({
        pendingActions: runtime.gatekeeper.getPendingActions(),
        auditLog: [...runtime.gatekeeper.getAuditLog()],
        lastMcpResultSummary: summary,
      })
      return res
    },

    async approvePendingAction(actionId, scope) {
      await runtime.gatekeeper.approveAction(actionId, scope)
      set({
        pendingActions: runtime.gatekeeper.getPendingActions(),
        auditLog: [...runtime.gatekeeper.getAuditLog()],
        lastMcpResultSummary: `Approved action ${actionId} (scope=${scope})`,
      })
    },

    denyPendingAction(actionId, reason = 'Denied by user in Consent Center') {
      const res = runtime.gatekeeper.denyAction(actionId, reason)
      set({
        pendingActions: runtime.gatekeeper.getPendingActions(),
        auditLog: [...runtime.gatekeeper.getAuditLog()],
        lastMcpResultSummary: res.feedback,
      })
    },

    resetStoreForTesting() {
      runtime.cortex.close()
      runtime = createSeededRuntime()
      activeSpeechPipeline = null

      const freshAffect = runtime.cortex.db.getAffectiveState()
      const freshMilestones = runtime.cortex.db.listMilestones()
      const freshMemories = runtime.cortex.db.listEpisodicMemories()
      const freshRanked = runtime.cortex.db.searchEpisodicMemoriesHybrid('', undefined, {
        nowMs: SEED_BASE_TIME,
        limit: 10,
      })
      const freshPrompt = runtime.cortex.compileTurnPrompt({
        userMessage: 'Pronta para mais uma sessão de arquitetura, Ashy?',
        modelId: 'claude-3-7-sonnet',
        nowMs: SEED_BASE_TIME,
        screenContext: 'VS Code — apps/desktop/src/App.tsx',
      })

      set({
        viewMode: 'hub',
        activeTab: 'studio',
        activeModelId: 'claude-3-7-sonnet',
        stageMode: 'tachie',
        stageEmotion: 'smug',
        emotionIntensity: 0.85,
        ambientLuminance: 0.35,
        isSpeaking: false,
        presenceStatus: 'Idle',
        bubbleText:
          'SQLite FTS5 aquecido e Blast-Radius ligado. Bora quebrar esse código antes que ele quebre a gente.',
        simulatedVowels: { A: 0.65, E: 0.25, I: 0.1, O: 0.35, U: 0.15 },
        mood: freshAffect.mood,
        traits: freshAffect.traits,
        milestones: freshMilestones,
        episodicMemories: freshMemories,
        rankedMemories: freshRanked,
        memorySearchQuery: '',
        semanticFacts: runtime.cortex.db.listSemanticFacts(),
        relationalMotifs: runtime.cortex.db.listRelationalMotifs(),
        userHabits: runtime.cortex.db.listUserHabits(),
        prospectiveIntents: runtime.cortex.db.listProspectiveIntents(),
        personalityEvolutionLog: runtime.cortex.db.listPersonalityEvolution(),
        lastPrompt: freshPrompt,
        roomTrophies: buildRoomTrophies(freshMilestones),
        chatMessages: [...initialChat],
        scheduledAudioChunks: [],
        lastPlaybackReceipt: null,
        lastStageSignals: [],
        privacyState: runtime.privacyController.getState(),
        mcpSearchQuery: '',
        mcpSearchResults: runtime.mcpRegistry.search_mcp_tools({ query: '', limit: 10 }),
        exposedMetaToolsCount: runtime.mcpRegistry.getExposedMetaTools().length,
        registeredMcpToolsCount: runtime.mcpRegistry.getRegisteredToolsCount(),
        pendingActions: runtime.gatekeeper.getPendingActions(),
        auditLog: [...runtime.gatekeeper.getAuditLog()],
        lastMcpResultSummary: null,
      })
    },
  }
})
