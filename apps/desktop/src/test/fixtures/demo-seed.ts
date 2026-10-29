import type { AshyCortex } from '@ashy/cortex'

export const SEED_BASE_TIME = Date.UTC(2026, 9, 28, 3, 14, 0)

export interface DemoFeaturedMemoryCard {
  id: string
  title: string
  summary: string
  fullStory: string
  dateLabel: string
  originLabel: string
  filterCategory: 'momentos' | 'sobre_voce' | 'referencias' | 'planos'
  badge?: string
  image: string
  featured: boolean
  episodeId?: string
}

export const DEMO_MEMORY_CARDS: ReadonlyArray<DemoFeaturedMemoryCard> = [
  {
    id: 'ep-padre-npm-origin',
    title: 'O fantasma no backend',
    summary:
      'Aquele bug no npm que só aparecia no seu computador e sumia do nada. Virou nosso fantasma no backend. 👻',
    fullStory:
      'Aquele bug no npm que só aparecia no seu computador e sumia do nada.\n\nA gente tentou de tudo, limpou cache, reinstalou, revisou as dependências, e ele continuava lá.\n\nVirou nosso fantasma no backend. 👻',
    dateLabel: '12 de outubro',
    originLabel: 'Conversa de 12 de outubro',
    filterCategory: 'referencias',
    image: '/assets/mem-ghost-backend.jpg',
    featured: true,
    episodeId: 'ep-padre-npm-origin',
  },
  {
    id: 'ep-orin-ashy',
    title: 'Orin e Ashy',
    summary: 'Dois projetos do Carlos, cada um com sua própria identidade.',
    fullStory:
      'Dois projetos do Carlos, cada um com sua própria identidade.\n\nEnquanto o Orin foca em precisão analítica e fluxo operacional, a Ashy nasceu para ser companhia viva no desktop — com memória afetiva, humor próprio e presença constante.',
    dateLabel: '5 de outubro',
    originLabel: 'Conversa de 5 de outubro',
    filterCategory: 'sobre_voce',
    image: '/assets/mem-orin-ashy.jpg',
    featured: true,
    episodeId: 'ep-padre-npm-origin',
  },
  {
    id: 'ep-matrix3d-trauma',
    title: 'Seu jeito de trabalhar',
    summary: 'Prefere entender o porquê enquanto constrói.',
    fullStory:
      'Prefere entender o porquê enquanto constrói.\n\nAntes de aceitar qualquer abstração pronta, você sempre abre a arquitetura, testa as bordas e garante que cada peça faça sentido de ponta a ponta.',
    dateLabel: '3 de outubro',
    originLabel: 'Conversa de 3 de outubro',
    filterCategory: 'sobre_voce',
    image: '/assets/mem-work-style.jpg',
    featured: false,
    episodeId: 'ep-matrix3d-trauma',
  },
  {
    id: 'ep-flashbulb-0314',
    title: 'Primeira conversa',
    summary:
      'Nossa primeira conversa. Ainda me lembro da sua curiosidade e das ideias que você trouxe.',
    fullStory:
      'Nossa primeira conversa. Ainda me lembro da sua curiosidade e das ideias que você trouxe naquela primeira madrugada desenhando como eu deveria existir no seu computador.',
    dateLabel: '1 de outubro',
    originLabel: 'Conversa de 1 de outubro',
    filterCategory: 'momentos',
    image: '/assets/mem-first-chat.jpg',
    featured: false,
    episodeId: 'ep-flashbulb-0314',
  },
  {
    id: 'ep-prototype-plan',
    title: 'Retomar o protótipo',
    summary: 'Voltar para o protótipo do ashy e continuar refinando a experiência de voz.',
    fullStory:
      'Voltar para o protótipo do ashy e continuar refinando a experiência de voz:\n• Voz mais natural\n• Refinar fluxo de interrupção (barge-in)\n• Testar novos recursos de presença\n• Continuar protótipo local',
    dateLabel: '28 de setembro',
    originLabel: 'Plano de 28 de setembro',
    filterCategory: 'planos',
    badge: 'Plano',
    image: '/assets/mem-prototype-plan.jpg',
    featured: false,
    episodeId: 'ep-flashbulb-0314',
  },
]

/**
 * Seeds optional test/demo memories, milestones, facts, inside jokes, and initial chat messages.
 * Exclusively invoked via `seedDemoFixtures()` in tests/demos — never during production boot.
 */
export function seedAshyDemoFixtures(cortex: AshyCortex): void {
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
  })

  // 3. Seed Semantic Facts (Identity + Active + Invalidated Bi-Temporal History)
  cortex.db.upsertSemanticFact({
    id: 'fact-user-name',
    category: 'identity',
    subject: 'user',
    predicate: 'name',
    object: 'Carlos',
    confidence: 1.0,
    sourceEpisodeIds: ['ep-padre-npm-origin'],
    validFrom: SEED_BASE_TIME - 7 * 86_400_000,
    invalidAt: null,
  })

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

  // 6. Ensure initial session and seed demo conversation if session has no messages yet
  let sessions = cortex.listChatSessions()
  if (sessions.length === 0) {
    sessions = [
      cortex.createChatSession({
        id: 'session-initial',
        title: 'Primeiro Encontro',
        startedAt: SEED_BASE_TIME - 60_000,
        updatedAt: SEED_BASE_TIME - 55_000,
      }),
    ]
  }
  const activeSession = sessions[0]!
  const existingMessages = cortex.listChatMessages(activeSession.id, 10)
  if (existingMessages.length === 0) {
    cortex.appendChatMessage({
      id: 'msg-seed-1',
      sessionId: activeSession.id,
      role: 'user',
      content: 'Lembra do fantasma no backend?',
      rawContent: 'Lembra do fantasma no backend?',
      emotion: 'neutral',
      markersJson: '[]',
      createdAt: SEED_BASE_TIME - 60_000,
    })

    cortex.appendChatMessage({
      id: 'msg-seed-2',
      sessionId: activeSession.id,
      role: 'assistant',
      content: 'Outro bug? Eu já estava procurando um exorcista no npm. 😉',
      rawContent:
        '<|ACT {"emotion":"smug","intensity":0.85}|><|CALLBACK motif-padre-npm|>Outro bug? Eu já estava procurando um exorcista no npm. 😉',
      emotion: 'smug',
      markersJson: JSON.stringify([
        { type: 'act', emotion: 'smug', intensity: 0.85 },
        { type: 'callback', motifId: 'motif-padre-npm' },
      ]),
      providerId: 'anthropic',
      modelId: 'claude-3-7-sonnet-latest',
      latencyMs: 320,
      createdAt: SEED_BASE_TIME - 55_000,
    })
  }
}
