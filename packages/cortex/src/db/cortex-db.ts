import { embedTextSync128 } from '@ashy/llm'
import {
  ASHY_BASELINE_MOOD,
  ASHY_DEFAULT_TRAITS,
  ASHY_EMOTIONS,
  AutobiographicalMilestoneSchema,
  DEFAULT_MEMORY_GOVERNANCE_POLICY,
  EpisodicMemorySchema,
  MEMORY_GOVERNANCE_CATEGORIES,
  MoodVectorSchema,
  PersonalityEvolutionRecordSchema,
  PersonalityTraitsSchema,
  ProspectiveIntentSchema,
  RelationalMotifSchema,
  SemanticFactSchema,
  UserHabitSchema,
  type ApprovableMemoryKind,
  type AshyEmotion,
  type AutobiographicalMilestone,
  type ChatMessageRecord,
  type ChatSessionRecord,
  type EpisodicMemory,
  type LlmProviderId,
  type MemoryApprovalStatus,
  type MemoryGovernanceCategory,
  type MemoryGovernancePolicy,
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
import {
  DEFAULT_GOLDEN_EXEMPLARS,
  type GoldenExemplarRecord,
} from '../prompt/default-golden-exemplars'

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
  filePath?: string
  dbPath?: string
  forceMemoryFallback?: boolean
  inMemory?: boolean
}

export interface SchemaMigrationRecord {
  version: number
  name: string
  appliedAt: number
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

type NodeFsLike = typeof import('node:fs')
type NodePathLike = typeof import('node:path')

function getBuiltinModule<T>(id: string): T | null {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (modId: string) => unknown } })
      .process
    return (proc?.getBuiltinModule?.(id) as T | undefined) ?? null
  } catch {
    return null
  }
}

function tryOpenNodeSqlite(dbPath: string): SqliteDatabaseLike | null {
  try {
    const sqliteMod = getBuiltinModule<{ DatabaseSync?: new (path: string) => SqliteDatabaseLike }>(
      'node:sqlite',
    )
    if (sqliteMod && typeof sqliteMod.DatabaseSync === 'function') {
      return new sqliteMod.DatabaseSync(dbPath)
    }
  } catch {
    // Fallback to MemoryStorageAdapter when running in browser renderer or unsupported runtime
  }
  return null
}

function applySqlitePragmas(db: SqliteDatabaseLike, isFileBacked: boolean): void {
  if (isFileBacked) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `)
  } else {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `)
  }
}

function quarantineCorruptSqliteFile(fs: NodeFsLike, filePath: string): void {
  const corruptPath = `${filePath}.corrupt.${Date.now()}`
  try {
    fs.renameSync(filePath, corruptPath)
  } catch {
    try {
      fs.copyFileSync(filePath, corruptPath)
      fs.rmSync(filePath, { force: true })
    } catch {
      // Ignore if file cannot be moved
    }
  }
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(`${filePath}${suffix}`, { force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
}

function openPersistentDatabase(filePath: string): SqliteDatabaseLike | null {
  const sqliteMod = getBuiltinModule<{ DatabaseSync?: new (path: string) => SqliteDatabaseLike }>(
    'node:sqlite',
  )
  if (!sqliteMod || typeof sqliteMod.DatabaseSync !== 'function') {
    return null
  }

  const fs = getBuiltinModule<NodeFsLike>('node:fs')
  const path = getBuiltinModule<NodePathLike>('node:path')

  if (fs && path) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })

    if (fs.existsSync(filePath)) {
      let existingDb: SqliteDatabaseLike | null = null
      try {
        const stat = fs.statSync(filePath)
        if (stat.size > 0) {
          const SQLITE_HEADER = 'SQLite format 3\0'
          if (stat.size < 16) {
            throw new Error('SQLite file is truncated (< 16 bytes)')
          }
          const fd = fs.openSync(filePath, 'r')
          const headerBuf = Buffer.alloc(16)
          try {
            fs.readSync(fd, headerBuf, 0, 16, 0)
          } finally {
            fs.closeSync(fd)
          }
          if (headerBuf.toString('utf8') !== SQLITE_HEADER) {
            throw new Error('Invalid SQLite file header')
          }
        }

        existingDb = new sqliteMod.DatabaseSync(filePath)
        const quickCheckRow = existingDb.prepare('PRAGMA quick_check(1)').get()
        const quickCheckResult = quickCheckRow
          ? String(Object.values(quickCheckRow)[0] ?? '').toLowerCase()
          : ''
        if (quickCheckResult !== 'ok') {
          throw new Error(`SQLite quick_check failed: ${quickCheckResult}`)
        }
        applySqlitePragmas(existingDb, true)
        return existingDb
      } catch {
        if (existingDb) {
          try {
            existingDb.close()
          } catch {
            // Ignore close failure on corrupt handle
          }
          existingDb = null
        }
        quarantineCorruptSqliteFile(fs, filePath)
      }
    }
  }

  let freshDb: SqliteDatabaseLike | null = null
  try {
    freshDb = new sqliteMod.DatabaseSync(filePath)
    const quickCheckRow = freshDb.prepare('PRAGMA quick_check(1)').get()
    const quickCheckResult = quickCheckRow
      ? String(Object.values(quickCheckRow)[0] ?? '').toLowerCase()
      : ''
    if (quickCheckResult !== 'ok') {
      throw new Error(`Fresh SQLite quick_check failed: ${quickCheckResult}`)
    }
    applySqlitePragmas(freshDb, true)
    return freshDb
  } catch (err) {
    if (freshDb) {
      try {
        freshDb.close()
      } catch {
        // Ignore close failure
      }
    }
    throw err
  }
}

const VALID_CHAT_ROLES = new Set(['user', 'assistant', 'system'])
const VALID_EMOTIONS = new Set<string>(ASHY_EMOTIONS)
const VALID_GOVERNANCE_CATEGORIES = new Set<string>(MEMORY_GOVERNANCE_CATEGORIES)

function parseApprovalStatus(raw: unknown): MemoryApprovalStatus {
  return raw === 'pending_review' ? 'pending_review' : 'approved'
}

/**
 * Browser-compatible in-memory storage adapter mirroring all memory tables + affective/style/chat stores.
 */
export class MemoryStorageAdapter {
  readonly migrations = new Map<number, SchemaMigrationRecord>()
  readonly episodicMemories = new Map<string, EpisodicMemory>()
  readonly semanticFacts = new Map<string, SemanticFact>()
  readonly relationalMotifs = new Map<string, RelationalMotif>()
  readonly milestones = new Map<string, AutobiographicalMilestone>()
  readonly userHabits = new Map<string, UserHabit>()
  readonly prospectiveIntents = new Map<string, ProspectiveIntent>()
  readonly personalityEvolution = new Map<string, PersonalityEvolutionRecord>()
  readonly styleExemplars = new Map<string, StyleExemplar>()
  readonly goldenExemplars = new Map<string, GoldenExemplarRecord>()
  readonly chatSessions = new Map<string, ChatSessionRecord>()
  readonly chatMessages: ChatMessageRecord[] = []
  governancePolicy: MemoryGovernancePolicy = { ...DEFAULT_MEMORY_GOVERNANCE_POLICY }
  affectiveState: AffectiveStateSnapshot = {
    mood: { ...ASHY_BASELINE_MOOD },
    traits: { ...ASHY_DEFAULT_TRAITS },
    updatedAt: 0,
  }

  constructor() {
    const now = Date.now()
    this.migrations.set(1, {
      version: 1,
      name: 'v1_initial_cortex_schema',
      appliedAt: now,
    })
    this.migrations.set(2, {
      version: 2,
      name: 'v2_phase1_chat_and_exemplars',
      appliedAt: now,
    })
    this.migrations.set(3, {
      version: 3,
      name: 'v3_phase2_self_writing_memory',
      appliedAt: now,
    })
    for (const ex of DEFAULT_GOLDEN_STYLE_EXEMPLARS) {
      this.styleExemplars.set(ex.id, ex)
    }
    for (const ex of DEFAULT_GOLDEN_EXEMPLARS) {
      this.goldenExemplars.set(ex.id, ex)
    }
  }
}

export class CortexDatabase {
  private readonly sqlite: SqliteDatabaseLike | null
  private readonly memory: MemoryStorageAdapter
  public readonly isNativeSqlite: boolean
  public readonly isPersistent: boolean
  public readonly filePath: string

  constructor(options?: CortexDatabaseOptions) {
    this.memory = new MemoryStorageAdapter()
    const targetPath =
      options?.inMemory === true
        ? ':memory:'
        : (options?.filePath ?? options?.dbPath ?? ':memory:')
    this.filePath = targetPath

    if (options?.forceMemoryFallback) {
      this.sqlite = null
      this.isNativeSqlite = false
      this.isPersistent = false
      return
    }

    if (targetPath !== ':memory:') {
      this.sqlite = openPersistentDatabase(targetPath)
      this.isNativeSqlite = this.sqlite !== null
      this.isPersistent = this.sqlite !== null
    } else {
      this.sqlite = tryOpenNodeSqlite(':memory:')
      if (this.sqlite) {
        applySqlitePragmas(this.sqlite, false)
      }
      this.isNativeSqlite = this.sqlite !== null
      this.isPersistent = false
    }

    if (this.sqlite) {
      try {
        this.initializeSqliteSchema()
      } catch (err) {
        try {
          this.sqlite.close()
        } catch {
          // Ignore close error
        }
        throw err
      }
    }
  }

  private ensureColumnExists(table: string, column: string, sqlDef: string): void {
    if (!this.sqlite) return
    if (!/^[a-z_][a-z0-9_]*$/i.test(table) || !/^[a-z_][a-z0-9_]*$/i.test(column)) {
      throw new Error(`Invalid SQL identifier in ensureColumnExists: ${table}.${column}`)
    }
    const cols = this.sqlite.prepare(`PRAGMA table_info(${table})`).all()
    const exists = cols.some((c) => String(c.name) === column)
    if (!exists) {
      this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlDef}`)
    }
  }

  private initializeSqliteSchema(): void {
    if (!this.sqlite) return
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );

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
        embedding_json TEXT,
        approval_status TEXT NOT NULL DEFAULT 'approved'
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
        invalid_at INTEGER,
        embedding_json TEXT,
        approval_status TEXT NOT NULL DEFAULT 'approved'
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
        created_at INTEGER NOT NULL,
        embedding_json TEXT,
        approval_status TEXT NOT NULL DEFAULT 'approved'
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
        updated_at INTEGER NOT NULL,
        source_episode_id TEXT,
        approval_status TEXT NOT NULL DEFAULT 'approved'
      );

      CREATE TABLE IF NOT EXISTS prospective_intents (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        context_cue TEXT NOT NULL,
        due_at INTEGER,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        source_episode_id TEXT,
        approval_status TEXT NOT NULL DEFAULT 'approved'
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

      CREATE TABLE IF NOT EXISTS golden_exemplars (
        id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        context TEXT NOT NULL,
        user_utterance TEXT NOT NULL,
        ashy_response TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        turn_count INTEGER NOT NULL DEFAULT 0,
        last_message_preview TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        raw_content TEXT NOT NULL,
        emotion TEXT NOT NULL DEFAULT 'neutral',
        markers_json TEXT NOT NULL DEFAULT '[]',
        provider_id TEXT,
        model_id TEXT,
        latency_ms INTEGER,
        consolidated_episode_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
        ON chat_messages(session_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS memory_governance_settings (
        category TEXT PRIMARY KEY,
        require_confirmation INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `)

    // Idempotent column upgrades for pre-existing v1/v2 database files
    this.ensureColumnExists('episodic_memories', 'approval_status', "TEXT NOT NULL DEFAULT 'approved'")
    this.ensureColumnExists('semantic_facts', 'embedding_json', 'TEXT')
    this.ensureColumnExists('semantic_facts', 'approval_status', "TEXT NOT NULL DEFAULT 'approved'")
    this.ensureColumnExists('relational_motifs', 'embedding_json', 'TEXT')
    this.ensureColumnExists('relational_motifs', 'approval_status', "TEXT NOT NULL DEFAULT 'approved'")
    this.ensureColumnExists('user_habits', 'source_episode_id', 'TEXT')
    this.ensureColumnExists('user_habits', 'approval_status', "TEXT NOT NULL DEFAULT 'approved'")
    this.ensureColumnExists('prospective_intents', 'source_episode_id', 'TEXT')
    this.ensureColumnExists('prospective_intents', 'approval_status', "TEXT NOT NULL DEFAULT 'approved'")
    this.ensureColumnExists('chat_messages', 'consolidated_episode_id', 'TEXT')

    const now = Date.now()
    const insertMigration = this.sqlite.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `)
    insertMigration.run(1, 'v1_initial_cortex_schema', now)
    insertMigration.run(2, 'v2_phase1_chat_and_exemplars', now)
    insertMigration.run(3, 'v3_phase2_self_writing_memory', now)

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

    // Seed 20 PT-BR Golden Dialogue Exemplars if empty
    const goldenCountRow = this.sqlite
      .prepare('SELECT COUNT(*) as cnt FROM golden_exemplars')
      .get()
    const goldenCount = Number(goldenCountRow?.cnt ?? 0)
    if (goldenCount === 0) {
      this.seedDefaultGoldenExemplars()
    }
  }

  public getAppliedMigrations(): SchemaMigrationRecord[] {
    if (!this.sqlite) {
      return Array.from(this.memory.migrations.values()).sort((a, b) => a.version - b.version)
    }
    const rows = this.sqlite
      .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC')
      .all()
    return rows.map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      appliedAt: Number(row.applied_at),
    }))
  }

  public listSqlTables(): string[] {
    if (!this.sqlite) {
      return [
        'schema_migrations',
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
        'golden_exemplars',
        'chat_sessions',
        'chat_messages',
        'memory_governance_settings',
      ]
    }
    const rows = this.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
      .all()
    return rows.map((r) => String(r.name))
  }

  // 1. Episodic Memories
  public upsertEpisodicMemory(input: EpisodicMemory): EpisodicMemory {
    const autoEmbedding =
      input.embedding && input.embedding.length > 0
        ? input.embedding
        : embedTextSync128(
            `${input.title} ${input.summary} ${input.content} ${(input.tags ?? []).join(' ')}`,
          )
    const approvalStatus: MemoryApprovalStatus = input.approvalStatus ?? 'approved'

    const memory = v.parse(EpisodicMemorySchema, {
      ...input,
      embedding: autoEmbedding,
      approvalStatus,
    })
    this.memory.episodicMemories.set(memory.id, memory)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO episodic_memories (
            id, title, summary, content, created_at, last_reviewed_at,
            stability, difficulty, surprise, is_flashbulb, tags_json,
            embedding_json, approval_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          memory.approvalStatus ?? 'approved',
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

  public deleteEpisodicMemory(id: string): boolean {
    const existedInMem = this.memory.episodicMemories.delete(id)

    for (let i = 0; i < this.memory.chatMessages.length; i++) {
      const msg = this.memory.chatMessages[i]
      if (msg && msg.consolidatedEpisodeId === id) {
        this.memory.chatMessages[i] = {
          ...msg,
          consolidatedEpisodeId: null,
        }
      }
    }

    if (this.sqlite) {
      this.sqlite.prepare('DELETE FROM episodic_fts WHERE memory_id = ?').run(id)
      this.sqlite.prepare('DELETE FROM episodic_memories WHERE id = ?').run(id)
      this.sqlite
        .prepare(
          'UPDATE chat_messages SET consolidated_episode_id = NULL WHERE consolidated_episode_id = ?',
        )
        .run(id)
    }

    for (const fact of this.listSemanticFacts()) {
      if (fact.sourceEpisodeIds.includes(id)) {
        const filtered = fact.sourceEpisodeIds.filter((epId) => epId !== id)
        this.upsertSemanticFact({
          ...fact,
          sourceEpisodeIds: filtered.length > 0 ? filtered : ['deleted-episode'],
        })
      }
    }

    for (const motif of this.listRelationalMotifs()) {
      if (motif.originEpisodeId === id) {
        this.upsertRelationalMotif({
          ...motif,
          originEpisodeId: undefined,
        })
      }
    }

    for (const habit of this.listUserHabits()) {
      if (habit.sourceEpisodeId === id) {
        this.upsertUserHabit({
          ...habit,
          sourceEpisodeId: undefined,
        })
      }
    }

    for (const intent of this.listProspectiveIntents()) {
      if (intent.sourceEpisodeId === id) {
        this.upsertProspectiveIntent({
          ...intent,
          sourceEpisodeId: undefined,
        })
      }
    }

    for (const milestone of this.listMilestones()) {
      if (milestone.episodeId === id) {
        this.upsertMilestone({
          ...milestone,
          episodeId: undefined,
        })
      }
    }

    return this.sqlite ? true : existedInMem
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
    nowMsOrOptions?:
      | number
      | { nowMs?: number; limit?: number; includePendingReview?: boolean },
    topK?: number,
    extraOptions?: { includePendingReview?: boolean; nowMs?: number; limit?: number },
  ): RankedEpisodicMemory[] {
    const nowMs =
      typeof nowMsOrOptions === 'number'
        ? nowMsOrOptions
        : (nowMsOrOptions?.nowMs ?? extraOptions?.nowMs)
    const limit =
      typeof nowMsOrOptions === 'number'
        ? (topK ?? extraOptions?.limit)
        : (nowMsOrOptions?.limit ?? topK ?? extraOptions?.limit)
    const includePendingReview =
      typeof nowMsOrOptions === 'number'
        ? (extraOptions?.includePendingReview ?? false)
        : (nowMsOrOptions?.includePendingReview ?? extraOptions?.includePendingReview ?? false)

    const allMemories = this.listEpisodicMemories().filter((m) =>
      includePendingReview ? true : m.approvalStatus !== 'pending_review',
    )
    if (allMemories.length === 0) return []

    const effectiveQueryEmbedding =
      queryEmbedding && queryEmbedding.length > 0
        ? queryEmbedding
        : typeof queryText === 'string' && queryText.trim().length > 0
          ? embedTextSync128(queryText)
          : undefined

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
      embedding: effectiveQueryEmbedding,
      nowMs,
      bm25ScoresById,
      limit,
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
      approvalStatus: parseApprovalStatus(row.approval_status),
    })
  }

  // 2. Semantic Facts
  public upsertSemanticFact(input: SemanticFact): SemanticFact {
    const autoEmbedding =
      input.embedding && input.embedding.length > 0
        ? input.embedding
        : embedTextSync128(`${input.category} ${input.subject} ${input.predicate} ${input.object}`)
    const approvalStatus: MemoryApprovalStatus = input.approvalStatus ?? 'approved'

    const fact = v.parse(SemanticFactSchema, {
      ...input,
      embedding: autoEmbedding,
      approvalStatus,
    })
    this.memory.semanticFacts.set(fact.id, fact)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO semantic_facts (
            id, category, subject, predicate, object, confidence,
            source_episode_ids_json, valid_from, invalid_at,
            embedding_json, approval_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          fact.embedding ? JSON.stringify(fact.embedding) : null,
          fact.approvalStatus ?? 'approved',
        )
    }

    return fact
  }

  public deleteSemanticFact(id: string): boolean {
    const existed = this.memory.semanticFacts.delete(id)
    if (!this.sqlite) {
      return existed
    }
    this.sqlite.prepare('DELETE FROM semantic_facts WHERE id = ?').run(id)
    return true
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
      facts = rows.map((row) => {
        const embeddingJson = row.embedding_json
        return v.parse(SemanticFactSchema, {
          id: String(row.id),
          category: String(row.category),
          subject: String(row.subject),
          predicate: String(row.predicate),
          object: String(row.object),
          confidence: Number(row.confidence),
          sourceEpisodeIds: JSON.parse(String(row.source_episode_ids_json ?? '[]')),
          validFrom: Number(row.valid_from),
          invalidAt:
            row.invalid_at === null || row.invalid_at === undefined ? null : Number(row.invalid_at),
          embedding:
            typeof embeddingJson === 'string' && embeddingJson.length > 0
              ? JSON.parse(embeddingJson)
              : undefined,
          approvalStatus: parseApprovalStatus(row.approval_status),
        })
      })
    }

    return facts.filter((fact) => {
      if (options?.activeOnly) {
        if (fact.invalidAt !== null && fact.invalidAt !== undefined) {
          return false
        }
        if (fact.approvalStatus === 'pending_review') {
          return false
        }
      }
      if (options?.category && fact.category !== options.category) {
        return false
      }
      return true
    })
  }

  public listActiveSemanticFacts(category?: SemanticFactCategory): SemanticFact[] {
    return this.listSemanticFacts({ activeOnly: true, category })
  }

  // 3. Relational Motifs (Inside Jokes)
  public upsertRelationalMotif(input: RelationalMotif): RelationalMotif {
    const autoEmbedding =
      input.embedding && input.embedding.length > 0
        ? input.embedding
        : embedTextSync128(
            [input.motif, input.originSummary ?? '', ...(input.triggerCues ?? [])].join(' '),
          )
    const approvalStatus: MemoryApprovalStatus = input.approvalStatus ?? 'approved'

    const motif = v.parse(RelationalMotifSchema, {
      ...input,
      embedding: autoEmbedding,
      approvalStatus,
    })
    this.memory.relationalMotifs.set(motif.id, motif)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO relational_motifs (
            id, motif, origin_summary, origin_episode_id, trigger_cues_json,
            stage, times_used, last_used_at, cooldown_hours, created_at,
            embedding_json, approval_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          motif.embedding ? JSON.stringify(motif.embedding) : null,
          motif.approvalStatus ?? 'approved',
        )
    }

    return motif
  }

  public deleteRelationalMotif(id: string): boolean {
    const existed = this.memory.relationalMotifs.delete(id)
    if (!this.sqlite) {
      return existed
    }
    this.sqlite.prepare('DELETE FROM relational_motifs WHERE id = ?').run(id)
    return true
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
    return rows.map((row) => {
      const embeddingJson = row.embedding_json
      return v.parse(RelationalMotifSchema, {
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
        embedding:
          typeof embeddingJson === 'string' && embeddingJson.length > 0
            ? JSON.parse(embeddingJson)
            : undefined,
        approvalStatus: parseApprovalStatus(row.approval_status),
      })
    })
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

  public deleteMilestone(id: string): boolean {
    const existed = this.memory.milestones.delete(id)
    if (!this.sqlite) {
      return existed
    }
    this.sqlite.prepare('DELETE FROM autobiographical_milestones WHERE id = ?').run(id)
    return true
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
    const approvalStatus: MemoryApprovalStatus = input.approvalStatus ?? 'approved'
    const habit = v.parse(UserHabitSchema, {
      ...input,
      approvalStatus,
    })
    this.memory.userHabits.set(habit.id, habit)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO user_habits (
            id, pattern_key, description, confidence, observation_count,
            updated_at, source_episode_id, approval_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          habit.id,
          habit.patternKey,
          habit.description,
          habit.confidence,
          habit.observationCount,
          habit.updatedAt,
          habit.sourceEpisodeId ?? null,
          habit.approvalStatus ?? 'approved',
        )
    }

    return habit
  }

  public deleteUserHabit(id: string): boolean {
    const existed = this.memory.userHabits.delete(id)
    if (!this.sqlite) {
      return existed
    }
    this.sqlite.prepare('DELETE FROM user_habits WHERE id = ?').run(id)
    return true
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
        sourceEpisodeId:
          row.source_episode_id === null || row.source_episode_id === undefined
            ? undefined
            : String(row.source_episode_id),
        approvalStatus: parseApprovalStatus(row.approval_status),
      }),
    )
  }

  // 6. Prospective Intents
  public upsertProspectiveIntent(input: ProspectiveIntent): ProspectiveIntent {
    const approvalStatus: MemoryApprovalStatus = input.approvalStatus ?? 'approved'
    const intent = v.parse(ProspectiveIntentSchema, {
      ...input,
      approvalStatus,
    })
    this.memory.prospectiveIntents.set(intent.id, intent)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO prospective_intents (
            id, topic, context_cue, due_at, status, created_at,
            source_episode_id, approval_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          intent.id,
          intent.topic,
          intent.contextCue,
          intent.dueAt ?? null,
          intent.status,
          intent.createdAt,
          intent.sourceEpisodeId ?? null,
          intent.approvalStatus ?? 'approved',
        )
    }

    return intent
  }

  public deleteProspectiveIntent(id: string): boolean {
    const existed = this.memory.prospectiveIntents.delete(id)
    if (!this.sqlite) {
      return existed
    }
    this.sqlite.prepare('DELETE FROM prospective_intents WHERE id = ?').run(id)
    return true
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
          sourceEpisodeId:
            row.source_episode_id === null || row.source_episode_id === undefined
              ? undefined
              : String(row.source_episode_id),
          approvalStatus: parseApprovalStatus(row.approval_status),
        }),
      )
    }
    if (status) {
      return intents.filter((i) => i.status === status)
    }
    return intents
  }

  // 7. Memory Governance Policy & Quarantine Approval
  public getMemoryGovernancePolicy(): MemoryGovernancePolicy {
    const policy: MemoryGovernancePolicy = { ...DEFAULT_MEMORY_GOVERNANCE_POLICY }
    if (!this.sqlite) {
      return { ...this.memory.governancePolicy }
    }
    const rows = this.sqlite
      .prepare('SELECT category, require_confirmation FROM memory_governance_settings')
      .all()
    for (const row of rows) {
      const cat = String(row.category)
      if (VALID_GOVERNANCE_CATEGORIES.has(cat)) {
        policy[cat as MemoryGovernanceCategory] = Number(row.require_confirmation) === 1
      }
    }
    this.memory.governancePolicy = { ...policy }
    return policy
  }

  public setMemoryGovernancePolicy(
    category: MemoryGovernanceCategory,
    requireConfirmation: boolean,
  ): MemoryGovernancePolicy {
    if (!VALID_GOVERNANCE_CATEGORIES.has(category)) {
      throw new Error(`Invalid MemoryGovernanceCategory: ${String(category)}`)
    }
    const flag = Boolean(requireConfirmation)
    this.memory.governancePolicy = {
      ...this.getMemoryGovernancePolicy(),
      [category]: flag,
    }

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO memory_governance_settings (category, require_confirmation, updated_at)
           VALUES (?, ?, ?)`,
        )
        .run(category, flag ? 1 : 0, Date.now())
    }

    return this.getMemoryGovernancePolicy()
  }

  public approveMemoryItem(
    kind: ApprovableMemoryKind,
    id: string,
    nowMs = Date.now(),
  ): boolean {
    const safeNow = Number.isFinite(nowMs) && nowMs >= 0 ? nowMs : Date.now()

    switch (kind) {
      case 'fact': {
        const allFacts = this.listSemanticFacts()
        const target = allFacts.find((f) => f.id === id)
        if (!target) return false

        for (const other of allFacts) {
          if (
            other.id !== target.id &&
            (other.invalidAt === null || other.invalidAt === undefined) &&
            other.approvalStatus !== 'pending_review' &&
            other.category.trim().toLowerCase() === target.category.trim().toLowerCase() &&
            other.subject.trim().toLowerCase() === target.subject.trim().toLowerCase() &&
            other.predicate.trim().toLowerCase() === target.predicate.trim().toLowerCase() &&
            other.object.trim().toLowerCase() !== target.object.trim().toLowerCase()
          ) {
            this.invalidateSemanticFact(other.id, safeNow)
          }
        }

        this.upsertSemanticFact({
          ...target,
          approvalStatus: 'approved',
        })
        return true
      }
      case 'episode': {
        const episode = this.getEpisodicMemory(id)
        if (!episode) return false
        this.upsertEpisodicMemory({
          ...episode,
          approvalStatus: 'approved',
        })
        return true
      }
      case 'joke': {
        const motif = this.getRelationalMotif(id)
        if (!motif) return false
        this.upsertRelationalMotif({
          ...motif,
          approvalStatus: 'approved',
        })
        return true
      }
      case 'habit': {
        const habit = this.listUserHabits().find((h) => h.id === id)
        if (!habit) return false
        this.upsertUserHabit({
          ...habit,
          approvalStatus: 'approved',
        })
        return true
      }
      case 'intent': {
        const intent = this.listProspectiveIntents().find((i) => i.id === id)
        if (!intent) return false
        this.upsertProspectiveIntent({
          ...intent,
          approvalStatus: 'approved',
        })
        return true
      }
      default:
        return false
    }
  }

  // 8. Personality Evolution Log & Affective State
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

  // 9. Style Exemplars & 20 PT-BR Golden Dialogue Exemplars
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

  public seedDefaultGoldenExemplars(): void {
    for (const ex of DEFAULT_GOLDEN_EXEMPLARS) {
      this.memory.goldenExemplars.set(ex.id, ex)
    }
    if (this.sqlite) {
      const stmt = this.sqlite.prepare(`
        INSERT OR REPLACE INTO golden_exemplars (id, stage, context, user_utterance, ashy_response)
        VALUES (?, ?, ?, ?, ?)
      `)
      for (const ex of DEFAULT_GOLDEN_EXEMPLARS) {
        stmt.run(ex.id, ex.stage, ex.context, ex.userUtterance, ex.ashyResponse)
      }
    }
  }

  public listGoldenExemplars(stage?: string): GoldenExemplarRecord[] {
    if (!this.sqlite) {
      const all = Array.from(this.memory.goldenExemplars.values())
      return stage ? all.filter((item) => item.stage === stage) : all
    }
    const rows = stage
      ? this.sqlite
          .prepare('SELECT * FROM golden_exemplars WHERE stage = ? ORDER BY rowid ASC')
          .all(stage)
      : this.sqlite.prepare('SELECT * FROM golden_exemplars ORDER BY rowid ASC').all()

    return rows.map((row) => ({
      id: String(row.id),
      stage: String(row.stage) as GoldenExemplarRecord['stage'],
      context: String(row.context),
      userUtterance: String(row.user_utterance),
      ashyResponse: String(row.ashy_response),
    }))
  }

  // 10. Chat Sessions & Messages (Migration v2 & v3)
  public createChatSession(input: {
    id: string
    title: string
    startedAt?: number
    updatedAt?: number
    turnCount?: number
    lastMessagePreview?: string
  }): ChatSessionRecord {
    const id = input.id.trim()
    if (!id) {
      throw new Error('ChatSession id must be non-empty')
    }
    const title = input.title.trim() || 'Nova Conversa'
    const existingMem = this.memory.chatSessions.get(id)
    const startedAt = input.startedAt ?? existingMem?.startedAt ?? Date.now()
    const updatedAt = input.updatedAt ?? startedAt
    const turnCount = input.turnCount ?? existingMem?.turnCount ?? 0
    const lastMessagePreview = input.lastMessagePreview ?? existingMem?.lastMessagePreview ?? ''

    const session: ChatSessionRecord = {
      id,
      title,
      startedAt,
      updatedAt,
      turnCount,
      lastMessagePreview,
    }

    this.memory.chatSessions.set(session.id, session)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT INTO chat_sessions (
            id, title, started_at, updated_at, turn_count, last_message_preview
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            updated_at = excluded.updated_at`,
        )
        .run(
          session.id,
          session.title,
          session.startedAt,
          session.updatedAt,
          session.turnCount,
          session.lastMessagePreview,
        )
      const persisted = this.getChatSession(session.id) ?? session
      this.memory.chatSessions.set(session.id, persisted)
      return persisted
    }

    return session
  }

  public getChatSession(id: string): ChatSessionRecord | null {
    if (!this.sqlite) {
      return this.memory.chatSessions.get(id) ?? null
    }
    const row = this.sqlite.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id)
    if (!row) return null
    return this.mapRowToChatSession(row)
  }

  public listChatSessions(): ChatSessionRecord[] {
    if (!this.sqlite) {
      return Array.from(this.memory.chatSessions.values()).sort(
        (a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt,
      )
    }
    const rows = this.sqlite
      .prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC, started_at DESC')
      .all()
    return rows.map((row) => this.mapRowToChatSession(row))
  }

  public deleteChatSession(id: string): boolean {
    const existed = this.memory.chatSessions.delete(id)
    for (let i = this.memory.chatMessages.length - 1; i >= 0; i--) {
      if (this.memory.chatMessages[i]?.sessionId === id) {
        this.memory.chatMessages.splice(i, 1)
      }
    }
    if (!this.sqlite) {
      return existed
    }
    this.sqlite.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id)
    return true
  }

  public appendChatMessage(input: ChatMessageRecord): ChatMessageRecord {
    if (!VALID_CHAT_ROLES.has(input.role)) {
      throw new Error(`Invalid chat message role: ${String(input.role)}`)
    }
    const emotion: AshyEmotion = VALID_EMOTIONS.has(input.emotion) ? input.emotion : 'neutral'
    const existingMemIdx = this.memory.chatMessages.findIndex((m) => m.id === input.id)
    const existingMemMsg = existingMemIdx >= 0 ? this.memory.chatMessages[existingMemIdx] : undefined

    const record: ChatMessageRecord = {
      id: input.id,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      rawContent: input.rawContent,
      emotion,
      markersJson: input.markersJson || '[]',
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      latencyMs: input.latencyMs ?? null,
      consolidatedEpisodeId:
        input.consolidatedEpisodeId !== undefined
          ? input.consolidatedEpisodeId
          : (existingMemMsg?.consolidatedEpisodeId ?? null),
      createdAt: input.createdAt,
    }

    const preview = record.content.slice(0, 140)

    if (!this.sqlite) {
      const session = this.memory.chatSessions.get(record.sessionId)
      if (!session) {
        throw new Error(`FOREIGN KEY constraint failed: session ${record.sessionId} does not exist`)
      }
      const isNewMessage = existingMemIdx < 0
      if (existingMemIdx >= 0) {
        this.memory.chatMessages[existingMemIdx] = record
      } else {
        this.memory.chatMessages.push(record)
      }
      const turnDelta = isNewMessage && record.role === 'assistant' ? 1 : 0
      this.memory.chatSessions.set(record.sessionId, {
        ...session,
        updatedAt: record.createdAt,
        lastMessagePreview: preview,
        turnCount: session.turnCount + turnDelta,
      })
      return record
    }

    const existingRow = this.sqlite
      .prepare('SELECT id, consolidated_episode_id FROM chat_messages WHERE id = ?')
      .get(record.id)
    const turnDelta = !existingRow && record.role === 'assistant' ? 1 : 0
    if (
      input.consolidatedEpisodeId === undefined &&
      existingRow &&
      typeof existingRow.consolidated_episode_id === 'string'
    ) {
      record.consolidatedEpisodeId = existingRow.consolidated_episode_id
    }

    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO chat_messages (
            id, session_id, role, content, raw_content, emotion,
            markers_json, provider_id, model_id, latency_ms,
            consolidated_episode_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.sessionId,
          record.role,
          record.content,
          record.rawContent,
          record.emotion,
          record.markersJson,
          record.providerId ?? null,
          record.modelId ?? null,
          record.latencyMs ?? null,
          record.consolidatedEpisodeId ?? null,
          record.createdAt,
        )

      this.sqlite
        .prepare(
          `UPDATE chat_sessions
           SET updated_at = ?,
               last_message_preview = ?,
               turn_count = turn_count + ?
           WHERE id = ?`,
        )
        .run(record.createdAt, preview, turnDelta, record.sessionId)

      this.sqlite.exec('COMMIT')
    } catch (err) {
      try {
        this.sqlite.exec('ROLLBACK')
      } catch {
        // Ignore rollback failure
      }
      throw err
    }

    if (existingMemIdx >= 0) {
      this.memory.chatMessages[existingMemIdx] = record
    } else {
      this.memory.chatMessages.push(record)
    }

    const memSession = this.memory.chatSessions.get(record.sessionId)
    if (memSession) {
      this.memory.chatSessions.set(record.sessionId, {
        ...memSession,
        updatedAt: record.createdAt,
        lastMessagePreview: preview,
        turnCount: memSession.turnCount + turnDelta,
      })
    }

    return record
  }

  public listChatMessages(sessionId: string, limit = 80): ChatMessageRecord[] {
    if (!Number.isFinite(limit) || limit <= 0) {
      return []
    }
    const safeLimit = Math.floor(limit)

    if (!this.sqlite) {
      const sessionMsgs = this.memory.chatMessages
        .filter((m) => m.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt)
      return sessionMsgs.length > safeLimit ? sessionMsgs.slice(-safeLimit) : sessionMsgs
    }

    const rows = this.sqlite
      .prepare(
        `SELECT * FROM (
           SELECT rowid AS _rowid, * FROM chat_messages
           WHERE session_id = ?
           ORDER BY created_at DESC, _rowid DESC
           LIMIT ?
         )
         ORDER BY created_at ASC, _rowid ASC`,
      )
      .all(sessionId, safeLimit)

    return rows.map((row) => this.mapRowToChatMessage(row))
  }

  public listUnconsolidatedChatMessages(sessionId: string): ChatMessageRecord[] {
    if (!this.sqlite) {
      return this.memory.chatMessages
        .filter(
          (m) =>
            m.sessionId === sessionId &&
            (m.consolidatedEpisodeId === null || m.consolidatedEpisodeId === undefined),
        )
        .sort((a, b) => a.createdAt - b.createdAt)
    }

    const rows = this.sqlite
      .prepare(
        `SELECT rowid AS _rowid, * FROM chat_messages
         WHERE session_id = ? AND consolidated_episode_id IS NULL
         ORDER BY created_at ASC, _rowid ASC`,
      )
      .all(sessionId)

    return rows.map((row) => this.mapRowToChatMessage(row))
  }

  public markChatMessagesConsolidated(
    messageIds: readonly string[],
    episodeId: string,
  ): void {
    const cleanEpisodeId = episodeId.trim()
    if (!cleanEpisodeId || messageIds.length === 0) return

    const idSet = new Set(messageIds)
    for (let i = 0; i < this.memory.chatMessages.length; i++) {
      const msg = this.memory.chatMessages[i]
      if (msg && idSet.has(msg.id)) {
        this.memory.chatMessages[i] = {
          ...msg,
          consolidatedEpisodeId: cleanEpisodeId,
        }
      }
    }

    if (this.sqlite) {
      this.sqlite.exec('BEGIN IMMEDIATE')
      try {
        const stmt = this.sqlite.prepare(
          'UPDATE chat_messages SET consolidated_episode_id = ? WHERE id = ?',
        )
        for (const msgId of messageIds) {
          stmt.run(cleanEpisodeId, msgId)
        }
        this.sqlite.exec('COMMIT')
      } catch (err) {
        try {
          this.sqlite.exec('ROLLBACK')
        } catch {
          // Ignore rollback failure
        }
        throw err
      }
    }
  }

  private mapRowToChatSession(row: Record<string, unknown>): ChatSessionRecord {
    return {
      id: String(row.id),
      title: String(row.title),
      startedAt: Number(row.started_at),
      updatedAt: Number(row.updated_at),
      turnCount: Number(row.turn_count ?? 0),
      lastMessagePreview: String(row.last_message_preview ?? ''),
    }
  }

  private mapRowToChatMessage(row: Record<string, unknown>): ChatMessageRecord {
    const rawEmotion = String(row.emotion ?? 'neutral')
    const emotion: AshyEmotion = VALID_EMOTIONS.has(rawEmotion)
      ? (rawEmotion as AshyEmotion)
      : 'neutral'
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      role: String(row.role) as ChatMessageRecord['role'],
      content: String(row.content),
      rawContent: String(row.raw_content),
      emotion,
      markersJson: String(row.markers_json ?? '[]'),
      providerId:
        row.provider_id === null || row.provider_id === undefined
          ? null
          : (String(row.provider_id) as LlmProviderId),
      modelId:
        row.model_id === null || row.model_id === undefined ? null : String(row.model_id),
      latencyMs:
        row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
      consolidatedEpisodeId:
        row.consolidated_episode_id === null || row.consolidated_episode_id === undefined
          ? null
          : String(row.consolidated_episode_id),
      createdAt: Number(row.created_at),
    }
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
