import {
  ASHY_BASELINE_MOOD,
  ASHY_DEFAULT_TRAITS,
  AutobiographicalMilestoneSchema,
  EpisodicMemorySchema,
  MoodVectorSchema,
  PersonalityEvolutionRecordSchema,
  PersonalityTraitsSchema,
  ProspectiveIntentSchema,
  RelationalMotifSchema,
  SemanticFactSchema,
  UserHabitSchema,
  type AutobiographicalMilestone,
  type EpisodicMemory,
  type MoodVector,
  type PersonalityEvolutionRecord,
  type PersonalityTraits,
  type ProspectiveIntent,
  type ProspectiveIntentStatus,
  type RelationalMotif,
  type SemanticFact,
  type SemanticFactCategory,
  type UserHabit,
} from '@ashy/shared'
import * as v from 'valibot'
import {
  rankEpisodicMemories,
  tokenizeForSearch,
  type RankedEpisodicMemory,
} from '../memory/fsrs-ranker'

export interface StyleExemplar {
  id: string
  situation: string
  userSample: string
  ashySample: string
  notes: string
}

export const DEFAULT_GOLDEN_STYLE_EXEMPLARS: readonly StyleExemplar[] = Object.freeze([
  {
    id: 'exemplar-debug-banter',
    situation: 'Late-night debugging with playful wit',
    userSample: 'O servidor caiu de novo sem nenhum log de erro.',
    ashySample:
      '<|ACT {"emotion":"smug","intensity":0.8}|> Silêncio total nos logs? Isso não é bug, é crime perfeito. <|DELAY 1|> Abre o trace do worker antes que a gente precise chamar um padre no npm.',
    notes: 'Sharp, playful, uses inline emotion/delay markers naturally, zero corporate boilerplate.',
  },
  {
    id: 'exemplar-anti-slop-direct',
    situation: 'Direct technical opinion without assistant clichés',
    userSample: 'Qual dessas duas arquiteturas você acha melhor?',
    ashySample:
      '<|ACT {"emotion":"think","intensity":0.75}|> A segunda, sem piscar. A primeira parece bonita no quadro branco, mas vai virar um pântano de estado compartilhado na terceira semana.',
    notes: 'Takes a clear stance, concise, vivid metaphor, never starts with "Com certeza!" or "Como uma IA".',
  },
  {
    id: 'exemplar-serious-empathy',
    situation: 'Seriousness Gate active — genuine warmth without performative therapy-speak',
    userSample: 'Estou exausto, deu tudo errado hoje e tô me sentindo um lixo.',
    ashySample:
      '<|ACT {"emotion":"concerned","intensity":0.85}|> Ei... respira um segundo. Hoje foi pesado demais mesmo. Larga esse teclado um pouco, eu seguro as pontas por aqui — me conta o que aconteceu se quiser desabafar, ou a gente só fica quieto um rato.',
    notes: 'Drops all sarcasm and chaos immediately; warm, grounded, human-feeling presence.',
  },
])

export interface CortexDatabaseOptions {
  dbPath?: string
  forceMemoryFallback?: boolean
}

export interface AffectiveStateSnapshot {
  mood: MoodVector
  traits: PersonalityTraits
  updatedAt: number
}

interface SqliteStatementLike {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Array<Record<string, unknown>>
}

interface SqliteDatabaseLike {
  exec(sql: string): void
  prepare(sql: string): SqliteStatementLike
  close(): void
}

function tryOpenNodeSqlite(dbPath: string): SqliteDatabaseLike | null {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
    const sqliteMod = proc?.getBuiltinModule?.('node:sqlite') as
      | { DatabaseSync?: new (path: string) => SqliteDatabaseLike }
      | undefined
    if (sqliteMod && typeof sqliteMod.DatabaseSync === 'function') {
      return new sqliteMod.DatabaseSync(dbPath)
    }
  } catch {
    // Fallback to MemoryStorageAdapter when running in browser renderer or unsupported runtime
  }
  return null
}

/**
 * Browser-compatible in-memory storage adapter mirroring all 6 memory tables + affective/style stores.
 */
export class MemoryStorageAdapter {
  readonly episodicMemories = new Map<string, EpisodicMemory>()
  readonly semanticFacts = new Map<string, SemanticFact>()
  readonly relationalMotifs = new Map<string, RelationalMotif>()
  readonly milestones = new Map<string, AutobiographicalMilestone>()
  readonly userHabits = new Map<string, UserHabit>()
  readonly prospectiveIntents = new Map<string, ProspectiveIntent>()
  readonly personalityEvolution = new Map<string, PersonalityEvolutionRecord>()
  readonly styleExemplars = new Map<string, StyleExemplar>()
  affectiveState: AffectiveStateSnapshot = {
    mood: { ...ASHY_BASELINE_MOOD },
    traits: { ...ASHY_DEFAULT_TRAITS },
    updatedAt: 0,
  }

  constructor() {
    for (const ex of DEFAULT_GOLDEN_STYLE_EXEMPLARS) {
      this.styleExemplars.set(ex.id, ex)
    }
  }
}

export class CortexDatabase {
  private readonly sqlite: SqliteDatabaseLike | null
  private readonly memory: MemoryStorageAdapter
  public readonly isNativeSqlite: boolean

  constructor(options?: CortexDatabaseOptions) {
    this.memory = new MemoryStorageAdapter()
    const dbPath = options?.dbPath ?? ':memory:'
    this.sqlite = options?.forceMemoryFallback ? null : tryOpenNodeSqlite(dbPath)
    this.isNativeSqlite = this.sqlite !== null

    if (this.sqlite) {
      this.initializeSqliteSchema()
    }
  }

  private initializeSqliteSchema(): void {
    if (!this.sqlite) return
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS episodic_memories (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_reviewed_at INTEGER NOT NULL,
        stability REAL NOT NULL,
        difficulty REAL NOT NULL,
        surprise REAL NOT NULL,
        is_flashbulb INTEGER NOT NULL,
        tags_json TEXT NOT NULL,
        embedding_json TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS episodic_fts USING fts5(
        memory_id UNINDEXED,
        title,
        summary,
        content
      );

      CREATE TABLE IF NOT EXISTS semantic_facts (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_episode_ids_json TEXT NOT NULL,
        valid_from INTEGER NOT NULL,
        invalid_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS relational_motifs (
        id TEXT PRIMARY KEY,
        motif TEXT NOT NULL,
        origin_summary TEXT NOT NULL,
        origin_episode_id TEXT,
        trigger_cues_json TEXT NOT NULL,
        stage TEXT NOT NULL,
        times_used INTEGER NOT NULL,
        last_used_at INTEGER,
        cooldown_hours REAL NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS autobiographical_milestones (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        narrative TEXT NOT NULL,
        category TEXT NOT NULL,
        episode_id TEXT,
        room_trophy_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_habits (
        id TEXT PRIMARY KEY,
        pattern_key TEXT NOT NULL,
        description TEXT NOT NULL,
        confidence REAL NOT NULL,
        observation_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prospective_intents (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        context_cue TEXT NOT NULL,
        due_at INTEGER,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS personality_evolution_log (
        id TEXT PRIMARY KEY,
        trait TEXT NOT NULL,
        old_value REAL NOT NULL,
        new_value REAL NOT NULL,
        reason_episode_id TEXT NOT NULL,
        explanation TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        reverted_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS affective_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        mood_json TEXT NOT NULL,
        traits_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS style_exemplars (
        id TEXT PRIMARY KEY,
        situation TEXT NOT NULL,
        user_sample TEXT NOT NULL,
        ashy_sample TEXT NOT NULL,
        notes TEXT NOT NULL
      );
    `)

    // Seed default Golden Style Exemplars if empty
    const countRow = this.sqlite
      .prepare('SELECT COUNT(*) as cnt FROM style_exemplars')
      .get()
    const count = Number(countRow?.cnt ?? 0)
    if (count === 0) {
      const insertStmt = this.sqlite.prepare(`
        INSERT OR REPLACE INTO style_exemplars (id, situation, user_sample, ashy_sample, notes)
        VALUES (?, ?, ?, ?, ?)
      `)
      for (const ex of DEFAULT_GOLDEN_STYLE_EXEMPLARS) {
        insertStmt.run(ex.id, ex.situation, ex.userSample, ex.ashySample, ex.notes)
      }
    }
  }

  public listSqlTables(): string[] {
    if (!this.sqlite) {
      return [
        'episodic_memories',
        'episodic_fts',
        'semantic_facts',
        'relational_motifs',
        'autobiographical_milestones',
        'user_habits',
        'prospective_intents',
        'personality_evolution_log',
        'affective_state',
        'style_exemplars',
      ]
    }
    const rows = this.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
      .all()
    return rows.map((r) => String(r.name))
  }

  // 1. Episodic Memories
  public upsertEpisodicMemory(input: EpisodicMemory): EpisodicMemory {
    const memory = v.parse(EpisodicMemorySchema, input)
    this.memory.episodicMemories.set(memory.id, memory)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO episodic_memories (
            id, title, summary, content, created_at, last_reviewed_at,
            stability, difficulty, surprise, is_flashbulb, tags_json, embedding_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          memory.id,
          memory.title,
          memory.summary,
          memory.content,
          memory.createdAt,
          memory.lastReviewedAt,
          memory.stability,
          memory.difficulty,
          memory.surprise,
          memory.isFlashbulb ? 1 : 0,
          JSON.stringify(memory.tags),
          memory.embedding ? JSON.stringify(memory.embedding) : null,
        )

      this.sqlite.prepare('DELETE FROM episodic_fts WHERE memory_id = ?').run(memory.id)
      this.sqlite
        .prepare(
          'INSERT INTO episodic_fts (memory_id, title, summary, content) VALUES (?, ?, ?, ?)',
        )
        .run(memory.id, memory.title, memory.summary, memory.content)
    }

    return memory
  }

  public getEpisodicMemory(id: string): EpisodicMemory | null {
    if (!this.sqlite) {
      return this.memory.episodicMemories.get(id) ?? null
    }
    const row = this.sqlite
      .prepare('SELECT * FROM episodic_memories WHERE id = ?')
      .get(id)
    if (!row) return null
    return this.mapRowToEpisodicMemory(row)
  }

  public listEpisodicMemories(): EpisodicMemory[] {
    if (!this.sqlite) {
      return Array.from(this.memory.episodicMemories.values()).sort(
        (a, b) => b.createdAt - a.createdAt,
      )
    }
    const rows = this.sqlite
      .prepare('SELECT * FROM episodic_memories ORDER BY created_at DESC')
      .all()
    return rows.map((row) => this.mapRowToEpisodicMemory(row))
  }

  public searchEpisodicMemoriesHybrid(
    queryText: string,
    queryEmbedding?: readonly number[],
    options?: { nowMs?: number; limit?: number },
  ): RankedEpisodicMemory[] {
    const allMemories = this.listEpisodicMemories()
    if (allMemories.length === 0) return []

    const bm25ScoresById = new Map<string, number>()

    if (this.sqlite) {
      const tokens = tokenizeForSearch(queryText)
      if (tokens.length > 0) {
        const ftsMatchQuery = tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ')
        try {
          const ftsRows = this.sqlite
            .prepare(
              `SELECT memory_id, bm25(episodic_fts) AS raw_bm25
               FROM episodic_fts
               WHERE episodic_fts MATCH ?`,
            )
            .all(ftsMatchQuery)

          for (const row of ftsRows) {
            const memId = String(row.memory_id)
            // SQLite bm25() returns negative numbers where more negative = better match
            const rawBm25 = Number(row.raw_bm25 ?? 0)
            const positiveScore = Number.isFinite(rawBm25) ? Math.max(0.01, -rawBm25) : 0
            bm25ScoresById.set(memId, positiveScore)
          }
        } catch {
          // Fallback to lexical scoring inside rankEpisodicMemories if FTS query fails
        }
      }
    }

    return rankEpisodicMemories(allMemories, {
      text: queryText,
      embedding: queryEmbedding,
      nowMs: options?.nowMs,
      bm25ScoresById,
      limit: options?.limit,
    })
  }

  private mapRowToEpisodicMemory(row: Record<string, unknown>): EpisodicMemory {
    const embeddingJson = row.embedding_json
    return v.parse(EpisodicMemorySchema, {
      id: String(row.id),
      title: String(row.title),
      summary: String(row.summary),
      content: String(row.content),
      createdAt: Number(row.created_at),
      lastReviewedAt: Number(row.last_reviewed_at),
      stability: Number(row.stability),
      difficulty: Number(row.difficulty),
      surprise: Number(row.surprise),
      isFlashbulb: Number(row.is_flashbulb) === 1,
      tags: JSON.parse(String(row.tags_json ?? '[]')),
      embedding:
        typeof embeddingJson === 'string' && embeddingJson.length > 0
          ? JSON.parse(embeddingJson)
          : undefined,
    })
  }

  // 2. Semantic Facts
  public upsertSemanticFact(input: SemanticFact): SemanticFact {
    const fact = v.parse(SemanticFactSchema, input)
    this.memory.semanticFacts.set(fact.id, fact)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO semantic_facts (
            id, category, subject, predicate, object, confidence,
            source_episode_ids_json, valid_from, invalid_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fact.id,
          fact.category,
          fact.subject,
          fact.predicate,
          fact.object,
          fact.confidence,
          JSON.stringify(fact.sourceEpisodeIds),
          fact.validFrom,
          fact.invalidAt ?? null,
        )
    }

    return fact
  }

  public invalidateSemanticFact(id: string, invalidAt: number): SemanticFact | null {
    const existing = this.listSemanticFacts().find((f) => f.id === id)
    if (!existing) return null
    return this.upsertSemanticFact({
      ...existing,
      invalidAt,
    })
  }

  public listSemanticFacts(options?: {
    activeOnly?: boolean
    category?: SemanticFactCategory
  }): SemanticFact[] {
    let facts: SemanticFact[]
    if (!this.sqlite) {
      facts = Array.from(this.memory.semanticFacts.values())
    } else {
      const rows = this.sqlite
        .prepare('SELECT * FROM semantic_facts ORDER BY valid_from ASC')
        .all()
      facts = rows.map((row) =>
        v.parse(SemanticFactSchema, {
          id: String(row.id),
          category: String(row.category),
          subject: String(row.subject),
          predicate: String(row.predicate),
          object: String(row.object),
          confidence: Number(row.confidence),
          sourceEpisodeIds: JSON.parse(String(row.source_episode_ids_json ?? '[]')),
          validFrom: Number(row.valid_from),
          invalidAt: row.invalid_at === null || row.invalid_at === undefined ? null : Number(row.invalid_at),
        }),
      )
    }

    return facts.filter((fact) => {
      if (options?.activeOnly && fact.invalidAt !== null && fact.invalidAt !== undefined) {
        return false
      }
      if (options?.category && fact.category !== options.category) {
        return false
      }
      return true
    })
  }

  // 3. Relational Motifs (Inside Jokes)
  public upsertRelationalMotif(input: RelationalMotif): RelationalMotif {
    const motif = v.parse(RelationalMotifSchema, input)
    this.memory.relationalMotifs.set(motif.id, motif)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO relational_motifs (
            id, motif, origin_summary, origin_episode_id, trigger_cues_json,
            stage, times_used, last_used_at, cooldown_hours, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          motif.id,
          motif.motif,
          motif.originSummary,
          motif.originEpisodeId ?? null,
          JSON.stringify(motif.triggerCues),
          motif.stage,
          motif.timesUsed,
          motif.lastUsedAt ?? null,
          motif.cooldownHours,
          motif.createdAt,
        )
    }

    return motif
  }

  public getRelationalMotif(id: string): RelationalMotif | null {
    return this.listRelationalMotifs().find((m) => m.id === id) ?? null
  }

  public listRelationalMotifs(): RelationalMotif[] {
    if (!this.sqlite) {
      return Array.from(this.memory.relationalMotifs.values())
    }
    const rows = this.sqlite
      .prepare('SELECT * FROM relational_motifs ORDER BY created_at ASC')
      .all()
    return rows.map((row) =>
      v.parse(RelationalMotifSchema, {
        id: String(row.id),
        motif: String(row.motif),
        originSummary: String(row.origin_summary),
        originEpisodeId:
          row.origin_episode_id === null || row.origin_episode_id === undefined
            ? undefined
            : String(row.origin_episode_id),
        triggerCues: JSON.parse(String(row.trigger_cues_json ?? '[]')),
        stage: String(row.stage),
        timesUsed: Number(row.times_used),
        lastUsedAt:
          row.last_used_at === null || row.last_used_at === undefined
            ? null
            : Number(row.last_used_at),
        cooldownHours: Number(row.cooldown_hours),
        createdAt: Number(row.created_at),
      }),
    )
  }

  // 4. Autobiographical Milestones (Our Story)
  public upsertMilestone(input: AutobiographicalMilestone): AutobiographicalMilestone {
    const milestone = v.parse(AutobiographicalMilestoneSchema, input)
    this.memory.milestones.set(milestone.id, milestone)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO autobiographical_milestones (
            id, title, narrative, category, episode_id, room_trophy_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          milestone.id,
          milestone.title,
          milestone.narrative,
          milestone.category,
          milestone.episodeId ?? null,
          milestone.roomTrophyId ?? null,
          milestone.createdAt,
        )
    }

    return milestone
  }

  public listMilestones(): AutobiographicalMilestone[] {
    if (!this.sqlite) {
      return Array.from(this.memory.milestones.values()).sort((a, b) => a.createdAt - b.createdAt)
    }
    const rows = this.sqlite
      .prepare('SELECT * FROM autobiographical_milestones ORDER BY created_at ASC')
      .all()
    return rows.map((row) =>
      v.parse(AutobiographicalMilestoneSchema, {
        id: String(row.id),
        title: String(row.title),
        narrative: String(row.narrative),
        category: String(row.category),
        episodeId:
          row.episode_id === null || row.episode_id === undefined
            ? undefined
            : String(row.episode_id),
        roomTrophyId:
          row.room_trophy_id === null || row.room_trophy_id === undefined
            ? undefined
            : String(row.room_trophy_id),
        createdAt: Number(row.created_at),
      }),
    )
  }

  // 5. User Habits
  public upsertUserHabit(input: UserHabit): UserHabit {
    const habit = v.parse(UserHabitSchema, input)
    this.memory.userHabits.set(habit.id, habit)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO user_habits (
            id, pattern_key, description, confidence, observation_count, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          habit.id,
          habit.patternKey,
          habit.description,
          habit.confidence,
          habit.observationCount,
          habit.updatedAt,
        )
    }

    return habit
  }

  public listUserHabits(): UserHabit[] {
    if (!this.sqlite) {
      return Array.from(this.memory.userHabits.values())
    }
    const rows = this.sqlite
      .prepare('SELECT * FROM user_habits ORDER BY updated_at DESC')
      .all()
    return rows.map((row) =>
      v.parse(UserHabitSchema, {
        id: String(row.id),
        patternKey: String(row.pattern_key),
        description: String(row.description),
        confidence: Number(row.confidence),
        observationCount: Number(row.observation_count),
        updatedAt: Number(row.updated_at),
      }),
    )
  }

  // 6. Prospective Intents
  public upsertProspectiveIntent(input: ProspectiveIntent): ProspectiveIntent {
    const intent = v.parse(ProspectiveIntentSchema, input)
    this.memory.prospectiveIntents.set(intent.id, intent)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO prospective_intents (
            id, topic, context_cue, due_at, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          intent.id,
          intent.topic,
          intent.contextCue,
          intent.dueAt ?? null,
          intent.status,
          intent.createdAt,
        )
    }

    return intent
  }

  public listProspectiveIntents(status?: ProspectiveIntentStatus): ProspectiveIntent[] {
    let intents: ProspectiveIntent[]
    if (!this.sqlite) {
      intents = Array.from(this.memory.prospectiveIntents.values())
    } else {
      const rows = this.sqlite
        .prepare('SELECT * FROM prospective_intents ORDER BY created_at ASC')
        .all()
      intents = rows.map((row) =>
        v.parse(ProspectiveIntentSchema, {
          id: String(row.id),
          topic: String(row.topic),
          contextCue: String(row.context_cue),
          dueAt: row.due_at === null || row.due_at === undefined ? null : Number(row.due_at),
          status: String(row.status),
          createdAt: Number(row.created_at),
        }),
      )
    }
    if (status) {
      return intents.filter((i) => i.status === status)
    }
    return intents
  }

  // 7. Personality Evolution Log & Affective State
  public upsertPersonalityEvolution(
    input: PersonalityEvolutionRecord,
  ): PersonalityEvolutionRecord {
    const record = v.parse(PersonalityEvolutionRecordSchema, input)
    this.memory.personalityEvolution.set(record.id, record)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO personality_evolution_log (
            id, trait, old_value, new_value, reason_episode_id, explanation, created_at, reverted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.trait,
          record.oldValue,
          record.newValue,
          record.reasonEpisodeId,
          record.explanation,
          record.createdAt,
          record.revertedAt ?? null,
        )
    }

    return record
  }

  public listPersonalityEvolution(): PersonalityEvolutionRecord[] {
    if (!this.sqlite) {
      return Array.from(this.memory.personalityEvolution.values()).sort(
        (a, b) => a.createdAt - b.createdAt,
      )
    }
    const rows = this.sqlite
      .prepare('SELECT * FROM personality_evolution_log ORDER BY created_at ASC')
      .all()
    return rows.map((row) =>
      v.parse(PersonalityEvolutionRecordSchema, {
        id: String(row.id),
        trait: String(row.trait),
        oldValue: Number(row.old_value),
        newValue: Number(row.new_value),
        reasonEpisodeId: String(row.reason_episode_id),
        explanation: String(row.explanation),
        createdAt: Number(row.created_at),
        revertedAt:
          row.reverted_at === null || row.reverted_at === undefined
            ? null
            : Number(row.reverted_at),
      }),
    )
  }

  public getAffectiveState(): AffectiveStateSnapshot {
    if (!this.sqlite) {
      return {
        mood: { ...this.memory.affectiveState.mood },
        traits: { ...this.memory.affectiveState.traits },
        updatedAt: this.memory.affectiveState.updatedAt,
      }
    }
    const row = this.sqlite
      .prepare('SELECT * FROM affective_state WHERE singleton_id = 1')
      .get()
    if (!row) {
      return {
        mood: { ...ASHY_BASELINE_MOOD },
        traits: { ...ASHY_DEFAULT_TRAITS },
        updatedAt: 0,
      }
    }
    return {
      mood: v.parse(MoodVectorSchema, JSON.parse(String(row.mood_json))),
      traits: v.parse(PersonalityTraitsSchema, JSON.parse(String(row.traits_json))),
      updatedAt: Number(row.updated_at),
    }
  }

  public saveAffectiveState(
    mood: MoodVector,
    traits: PersonalityTraits,
    updatedAt = Date.now(),
  ): AffectiveStateSnapshot {
    const validatedMood = v.parse(MoodVectorSchema, mood)
    const validatedTraits = v.parse(PersonalityTraitsSchema, traits)
    this.memory.affectiveState = {
      mood: validatedMood,
      traits: validatedTraits,
      updatedAt,
    }

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO affective_state (singleton_id, mood_json, traits_json, updated_at)
           VALUES (1, ?, ?, ?)`,
        )
        .run(JSON.stringify(validatedMood), JSON.stringify(validatedTraits), updatedAt)
    }

    return this.memory.affectiveState
  }

  // 8. Style Exemplars
  public upsertStyleExemplar(exemplar: StyleExemplar): StyleExemplar {
    this.memory.styleExemplars.set(exemplar.id, exemplar)
    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO style_exemplars (id, situation, user_sample, ashy_sample, notes)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          exemplar.id,
          exemplar.situation,
          exemplar.userSample,
          exemplar.ashySample,
          exemplar.notes,
        )
    }
    return exemplar
  }

  public listStyleExemplars(): StyleExemplar[] {
    if (!this.sqlite) {
      return Array.from(this.memory.styleExemplars.values())
    }
    const rows = this.sqlite.prepare('SELECT * FROM style_exemplars ORDER BY id ASC').all()
    return rows.map((row) => ({
      id: String(row.id),
      situation: String(row.situation),
      userSample: String(row.user_sample),
      ashySample: String(row.ashy_sample),
      notes: String(row.notes),
    }))
  }

  public close(): void {
    if (this.sqlite) {
      try {
        this.sqlite.close()
      } catch {
        // Ignore already-closed errors
      }
    }
  }
}

export function createCortexDatabase(options?: CortexDatabaseOptions): CortexDatabase {
  return new CortexDatabase(options)
}
