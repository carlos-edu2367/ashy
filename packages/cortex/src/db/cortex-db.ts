import { embedTextSync128 } from '@ashy/llm'
import {
  ACTION_RISK_TIERS,
  ASHY_BASELINE_MOOD,
  ASHY_DEFAULT_TRAITS,
  ASHY_EMOTIONS,
  AUDIT_DECISIONS,
  AutobiographicalMilestoneSchema,
  COMPUTER_ACTIONS_POLICIES,
  DEFAULT_INITIATIVE_POLICY,
  DEFAULT_MEMORY_GOVERNANCE_POLICY,
  DEFAULT_PERSISTED_AGENCY_CONSENT_STATE,
  DreamJournalEntrySchema,
  EYES_MODES,
  EpisodicMemorySchema,
  InitiativePolicySchema,
  MEMORY_GOVERNANCE_CATEGORIES,
  MIC_MODES,
  MoodVectorSchema,
  PersonalityEvolutionRecordSchema,
  PersonalityTraitsSchema,
  ProactiveInitiativeRecordSchema,
  ProspectiveIntentSchema,
  RelationalMotifSchema,
  SemanticFactSchema,
  UpdateInitiativePolicyInputSchema,
  UpdateMilestoneInputSchema,
  UserHabitSchema,
  type ActionRiskTier,
  type ApprovableMemoryKind,
  type AshyEmotion,
  type AuditDecision,
  type AutobiographicalMilestone,
  type ChatMessageRecord,
  type ChatSessionRecord,
  type ComputerActionsPolicy,
  type CortexSoulSnapshot,
  type DreamJournalEntry,
  type EpisodicMemory,
  type ExternalMcpServerConfig,
  type InitiativePolicy,
  type LlmProviderId,
  type MemoryApprovalStatus,
  type MemoryGovernanceCategory,
  type MemoryGovernancePolicy,
  type MoodVector,
  type PersistedAgencyConsentState,
  type PersonalityEvolutionRecord,
  type PersonalityTraits,
  type ProactiveInitiativeRecord,
  type ProspectiveIntent,
  type ProspectiveIntentStatus,
  type RelationalMotif,
  type SemanticFact,
  type SemanticFactCategory,
  type SharedActionAuditLogEntry,
  type SharedEyesMode,
  type SharedMicMode,
  type UpdateInitiativePolicyInput,
  type UpdateMilestoneInput,
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

export interface CortexEncryptionCodec {
  encrypt(plainText: string, aad: string): string
  decrypt(cipherText: string, aad: string): string
}

export interface CortexDatabaseOptions {
  filePath?: string
  dbPath?: string
  forceMemoryFallback?: boolean
  inMemory?: boolean
  encryptionCodec?: CortexEncryptionCodec
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
const VALID_EYES_MODES = new Set<string>(EYES_MODES)
const VALID_MIC_MODES = new Set<string>(MIC_MODES)
const VALID_COMPUTER_ACTIONS_POLICIES = new Set<string>(COMPUTER_ACTIONS_POLICIES)
const VALID_ACTION_RISK_TIERS = new Set<string>(ACTION_RISK_TIERS)
const VALID_AUDIT_DECISIONS = new Set<string>(AUDIT_DECISIONS)

function parseApprovalStatus(raw: unknown): MemoryApprovalStatus {
  return raw === 'pending_review' ? 'pending_review' : 'approved'
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
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
  readonly actionAuditLog: SharedActionAuditLogEntry[] = []
  readonly proactiveInitiativeLog: ProactiveInitiativeRecord[] = []
  readonly dreamJournal = new Map<string, DreamJournalEntry>()
  initiativePolicy: InitiativePolicy = { ...DEFAULT_INITIATIVE_POLICY }
  agencyConsentState: PersistedAgencyConsentState = structuredClone(
    DEFAULT_PERSISTED_AGENCY_CONSENT_STATE as PersistedAgencyConsentState,
  )
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
    this.migrations.set(4, {
      version: 4,
      name: 'v4_phase7_agency_audit_and_consent',
      appliedAt: now,
    })
    this.migrations.set(5, {
      version: 5,
      name: 'v5_phase8_initiative_and_reflection_journal',
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
  private memory: MemoryStorageAdapter
  private encryptionCodec: CortexEncryptionCodec | null
  private encryptionAtRestEnabled = false
  private encryptionUpdatedAt: string | null = null
  public readonly isNativeSqlite: boolean
  public readonly isPersistent: boolean
  public readonly filePath: string

  constructor(options?: CortexDatabaseOptions) {
    this.memory = new MemoryStorageAdapter()
    this.encryptionCodec = options?.encryptionCodec ?? null
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
        this.loadEncryptionStateFromSqlite()
        this.hydrateMemoryFromSqlite()
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

  private encryptField(value: string, aad: string): string {
    if (!this.encryptionAtRestEnabled || !this.encryptionCodec || !value) {
      return value
    }
    if (value.startsWith('enc:v1:')) {
      return value
    }
    return this.encryptionCodec.encrypt(value, aad)
  }

  private decryptField(value: string, aad: string): string {
    if (typeof value !== 'string' || !value.startsWith('enc:v1:')) {
      return value
    }
    if (!this.encryptionCodec) {
      throw new Error(
        'CORTEX_ENCRYPTION_CODEC_REQUIRED: Database contains encrypted records (enc:v1:) but no encryptionCodec was provided.',
      )
    }
    return this.encryptionCodec.decrypt(value, aad)
  }

  private loadEncryptionStateFromSqlite(): void {
    if (!this.sqlite) return
    const row = this.sqlite
      .prepare(
        'SELECT enabled, key_check_cipher, updated_at FROM cortex_encryption_state WHERE singleton_id = 1',
      )
      .get()
    this.encryptionAtRestEnabled = row ? Number(row.enabled ?? 0) === 1 : false
    this.encryptionUpdatedAt =
      row && typeof row.updated_at === 'string' && row.updated_at.length > 0
        ? row.updated_at
        : null

    if (this.encryptionAtRestEnabled) {
      if (!this.encryptionCodec) {
        throw new Error(
          'CORTEX_ENCRYPTION_CODEC_REQUIRED: Database has encryption at rest enabled but no encryptionCodec was provided.',
        )
      }
      if (row && typeof row.key_check_cipher === 'string' && row.key_check_cipher.length > 0) {
        const verified = this.encryptionCodec.decrypt(
          row.key_check_cipher,
          'cortex_encryption_state.key_check',
        )
        if (verified !== 'ASHY_CORTEX_KEY_OK') {
          throw new Error('CORTEX_ENCRYPTION_KEY_MISMATCH: Key verification token mismatch.')
        }
      }
    }
  }

  private hydrateMemoryFromSqlite(): void {
    if (!this.sqlite) return
    this.memory.episodicMemories.clear()
    for (const ep of this.listEpisodicMemories()) {
      this.memory.episodicMemories.set(ep.id, ep)
    }

    this.memory.semanticFacts.clear()
    for (const fact of this.listSemanticFacts()) {
      this.memory.semanticFacts.set(fact.id, fact)
    }

    this.memory.relationalMotifs.clear()
    for (const motif of this.listRelationalMotifs()) {
      this.memory.relationalMotifs.set(motif.id, motif)
    }

    this.memory.milestones.clear()
    for (const ms of this.listMilestones()) {
      this.memory.milestones.set(ms.id, ms)
    }

    this.memory.userHabits.clear()
    for (const habit of this.listUserHabits()) {
      this.memory.userHabits.set(habit.id, habit)
    }

    this.memory.prospectiveIntents.clear()
    for (const intent of this.listProspectiveIntents()) {
      this.memory.prospectiveIntents.set(intent.id, intent)
    }

    this.memory.personalityEvolution.clear()
    for (const rec of this.listPersonalityEvolution()) {
      this.memory.personalityEvolution.set(rec.id, rec)
    }

    this.memory.affectiveState = this.getAffectiveState()

    this.memory.styleExemplars.clear()
    for (const ex of this.listStyleExemplars()) {
      this.memory.styleExemplars.set(ex.id, ex)
    }

    this.memory.goldenExemplars.clear()
    for (const ex of this.listGoldenExemplars()) {
      this.memory.goldenExemplars.set(ex.id, ex)
    }

    this.memory.chatSessions.clear()
    for (const sess of this.listChatSessions()) {
      this.memory.chatSessions.set(sess.id, sess)
    }

    this.memory.chatMessages.length = 0
    for (const msg of this.listAllChatMessages()) {
      this.memory.chatMessages.push(msg)
    }

    this.memory.governancePolicy = this.getMemoryGovernancePolicy()

    this.memory.actionAuditLog.length = 0
    for (const entry of this.listActionAuditLog(10_000).reverse()) {
      this.memory.actionAuditLog.push(entry)
    }

    this.memory.agencyConsentState = this.getAgencyConsentState()
    this.memory.initiativePolicy = this.getInitiativePolicy()

    this.memory.proactiveInitiativeLog.length = 0
    for (const rec of this.listProactiveInitiativeLog(10_000).reverse()) {
      this.memory.proactiveInitiativeLog.push(rec)
    }

    this.memory.dreamJournal.clear()
    for (const entry of this.listDreamJournalEntries(10_000)) {
      this.memory.dreamJournal.set(entry.id, entry)
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

      CREATE TABLE IF NOT EXISTS action_audit_log (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        server_name TEXT NOT NULL,
        risk_tier TEXT NOT NULL,
        decision TEXT NOT NULL,
        args_preview TEXT NOT NULL,
        action_id TEXT,
        reason TEXT,
        blast_radius_warning TEXT,
        target_path TEXT,
        command_preview TEXT,
        diff_preview TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_action_audit_log_timestamp
        ON action_audit_log(timestamp DESC);

      CREATE TABLE IF NOT EXISTS agency_consent_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        eyes_mode TEXT NOT NULL DEFAULT 'off',
        mic_mode TEXT NOT NULL DEFAULT 'muted',
        dnd_mode INTEGER NOT NULL DEFAULT 0,
        approval_policy TEXT NOT NULL DEFAULT 'ask',
        allowed_paths_json TEXT NOT NULL DEFAULT '[]',
        allowed_windows_json TEXT NOT NULL DEFAULT '[]',
        tool_risk_overrides_json TEXT NOT NULL DEFAULT '{}',
        external_mcp_servers_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS initiative_policy_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 1,
        cooldown_minutes INTEGER NOT NULL DEFAULT 120,
        max_daily_initiatives INTEGER NOT NULL DEFAULT 3,
        quiet_hours_start TEXT NOT NULL DEFAULT '23:00',
        quiet_hours_end TEXT NOT NULL DEFAULT '08:00',
        respect_dnd INTEGER NOT NULL DEFAULT 1,
        modulate_by_habits INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proactive_initiative_log (
        id TEXT PRIMARY KEY,
        trigger_kind TEXT NOT NULL,
        source_id TEXT,
        source_title TEXT NOT NULL,
        notice_prompt TEXT NOT NULL,
        reply_text TEXT,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_proactive_initiative_log_created
        ON proactive_initiative_log(created_at DESC);

      CREATE TABLE IF NOT EXISTS dream_reflection_journal (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        source_episode_ids_json TEXT NOT NULL,
        cross_links_count INTEGER NOT NULL DEFAULT 0,
        trait_evolutions_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dream_reflection_journal_created
        ON dream_reflection_journal(created_at DESC);

      CREATE TABLE IF NOT EXISTS cortex_encryption_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        key_check_cipher TEXT,
        updated_at TEXT NOT NULL
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
    insertMigration.run(4, 'v4_phase7_agency_audit_and_consent', now)
    insertMigration.run(5, 'v5_phase8_initiative_and_reflection_journal', now)

    this.seedDefaultsIfEmpty()
  }

  public seedDefaultsIfEmpty(): void {
    for (const ex of DEFAULT_GOLDEN_STYLE_EXEMPLARS) {
      if (!this.memory.styleExemplars.has(ex.id)) {
        this.memory.styleExemplars.set(ex.id, ex)
      }
    }
    for (const ex of DEFAULT_GOLDEN_EXEMPLARS) {
      if (!this.memory.goldenExemplars.has(ex.id)) {
        this.memory.goldenExemplars.set(ex.id, ex)
      }
    }

    if (!this.sqlite) return

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
        'action_audit_log',
        'agency_consent_state',
        'initiative_policy_state',
        'proactive_initiative_log',
        'dream_reflection_journal',
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
          this.encryptField(memory.title, 'episodic_memories.title'),
          this.encryptField(memory.summary, 'episodic_memories.summary'),
          this.encryptField(memory.content, 'episodic_memories.content'),
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
      if (!this.encryptionAtRestEnabled) {
        this.sqlite
          .prepare(
            'INSERT INTO episodic_fts (memory_id, title, summary, content) VALUES (?, ?, ?, ?)',
          )
          .run(memory.id, memory.title, memory.summary, memory.content)
      }
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
        .prepare('DELETE FROM personality_evolution_log WHERE reason_episode_id = ?')
        .run(id)
      this.sqlite
        .prepare(
          'UPDATE chat_messages SET consolidated_episode_id = NULL WHERE consolidated_episode_id = ?',
        )
        .run(id)
    }

    for (const [recId, rec] of this.memory.personalityEvolution.entries()) {
      if (rec.reasonEpisodeId === id) {
        this.memory.personalityEvolution.delete(recId)
      }
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

    for (const entry of this.listDreamJournalEntries(1000)) {
      if (entry.sourceEpisodeIds.includes(id)) {
        const remaining = entry.sourceEpisodeIds.filter((epId) => epId !== id)
        if (remaining.length === 0) {
          this.memory.dreamJournal.delete(entry.id)
          if (this.sqlite) {
            this.sqlite
              .prepare('DELETE FROM dream_reflection_journal WHERE id = ?')
              .run(entry.id)
          }
        } else {
          this.insertDreamJournalEntry({
            ...entry,
            sourceEpisodeIds: remaining,
          })
        }
      }
    }

    return this.sqlite ? true : existedInMem
  }

  public listEpisodicMemories(limit?: number): EpisodicMemory[] {
    const safeLimit =
      limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null
    if (!this.sqlite) {
      const sorted = Array.from(this.memory.episodicMemories.values()).sort(
        (a, b) => b.createdAt - a.createdAt,
      )
      return safeLimit !== null ? sorted.slice(0, safeLimit) : sorted
    }
    const rows =
      safeLimit !== null
        ? this.sqlite
            .prepare('SELECT * FROM episodic_memories ORDER BY created_at DESC LIMIT ?')
            .all(safeLimit)
        : this.sqlite
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

    if (this.sqlite && !this.encryptionAtRestEnabled) {
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
      title: this.decryptField(String(row.title), 'episodic_memories.title'),
      summary: this.decryptField(String(row.summary), 'episodic_memories.summary'),
      content: this.decryptField(String(row.content), 'episodic_memories.content'),
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
          this.encryptField(fact.object, 'semantic_facts.object'),
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
          object: this.decryptField(String(row.object), 'semantic_facts.object'),
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
          this.encryptField(motif.motif, 'relational_motifs.motif'),
          this.encryptField(motif.originSummary, 'relational_motifs.origin_summary'),
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
        motif: this.decryptField(String(row.motif), 'relational_motifs.motif'),
        originSummary: this.decryptField(
          String(row.origin_summary),
          'relational_motifs.origin_summary',
        ),
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
          this.encryptField(milestone.title, 'autobiographical_milestones.title'),
          this.encryptField(milestone.narrative, 'autobiographical_milestones.narrative'),
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

  public updateMilestone(input: UpdateMilestoneInput): AutobiographicalMilestone {
    const validated = v.parse(UpdateMilestoneInputSchema, input)
    const existing = this.listMilestones().find((m) => m.id === validated.id)
    if (!existing) {
      throw new Error(`AutobiographicalMilestone not found: ${validated.id}`)
    }

    const sanitizeMilestoneField = (raw: string): string =>
      raw
        .replace(/\0/g, '')
        .replace(/<\|[\s\S]*?\|>/g, '')
        .replace(/\s+/g, ' ')
        .trim()

    let nextTitle = existing.title
    if (validated.title !== undefined) {
      const cleanedTitle = sanitizeMilestoneField(validated.title)
      if (!cleanedTitle) {
        throw new Error('Milestone title cannot be empty after sanitization')
      }
      nextTitle = cleanedTitle
    }

    let nextNarrative = existing.narrative
    if (validated.narrative !== undefined) {
      const cleanedNarrative = sanitizeMilestoneField(validated.narrative)
      if (!cleanedNarrative) {
        throw new Error('Milestone narrative cannot be empty after sanitization')
      }
      nextNarrative = cleanedNarrative
    }

    const nextCategory = validated.category ?? existing.category
    const nextRoomTrophyId =
      validated.roomTrophyId === null
        ? undefined
        : validated.roomTrophyId !== undefined
          ? sanitizeMilestoneField(validated.roomTrophyId) || undefined
          : existing.roomTrophyId

    return this.upsertMilestone({
      ...existing,
      title: nextTitle,
      narrative: nextNarrative,
      category: nextCategory,
      roomTrophyId: nextRoomTrophyId,
    })
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
        title: this.decryptField(String(row.title), 'autobiographical_milestones.title'),
        narrative: this.decryptField(
          String(row.narrative),
          'autobiographical_milestones.narrative',
        ),
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
          this.encryptField(habit.description, 'user_habits.description'),
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
        description: this.decryptField(String(row.description), 'user_habits.description'),
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
          this.encryptField(intent.topic, 'prospective_intents.topic'),
          this.encryptField(intent.contextCue, 'prospective_intents.context_cue'),
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
          topic: this.decryptField(String(row.topic), 'prospective_intents.topic'),
          contextCue: this.decryptField(
            String(row.context_cue),
            'prospective_intents.context_cue',
          ),
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

  public insertPersonalityEvolution(
    input: PersonalityEvolutionRecord,
  ): PersonalityEvolutionRecord {
    return this.upsertPersonalityEvolution(input)
  }

  public migrateEvolutionEpisodeId(oldEpisodeId: string, newEpisodeId: string): void {
    const cleanOld = oldEpisodeId.trim()
    const cleanNew = newEpisodeId.trim()
    if (!cleanOld || !cleanNew || cleanOld === cleanNew) return

    for (const [recId, rec] of this.memory.personalityEvolution.entries()) {
      if (rec.reasonEpisodeId === cleanOld) {
        this.memory.personalityEvolution.set(recId, {
          ...rec,
          reasonEpisodeId: cleanNew,
        })
      }
    }

    if (this.sqlite) {
      this.sqlite
        .prepare(
          'UPDATE personality_evolution_log SET reason_episode_id = ? WHERE reason_episode_id = ?',
        )
        .run(cleanNew, cleanOld)
    }
  }

  public listPersonalityEvolution(limit?: number): PersonalityEvolutionRecord[] {
    const safeLimit =
      limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null
    if (!this.sqlite) {
      const sorted = Array.from(this.memory.personalityEvolution.values()).sort(
        (a, b) => a.createdAt - b.createdAt,
      )
      return safeLimit !== null ? sorted.slice(0, safeLimit) : sorted
    }
    const rows =
      safeLimit !== null
        ? this.sqlite
            .prepare('SELECT * FROM personality_evolution_log ORDER BY created_at ASC LIMIT ?')
            .all(safeLimit)
        : this.sqlite
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
    moodOrSnapshot: MoodVector | AffectiveStateSnapshot,
    traits?: PersonalityTraits,
    updatedAt = Date.now(),
  ): AffectiveStateSnapshot {
    const isSnapshot =
      moodOrSnapshot !== null &&
      typeof moodOrSnapshot === 'object' &&
      'mood' in moodOrSnapshot &&
      'traits' in moodOrSnapshot
    const rawMood = isSnapshot ? moodOrSnapshot.mood : moodOrSnapshot
    const rawTraits = isSnapshot ? moodOrSnapshot.traits : traits!
    const effectiveUpdatedAt = isSnapshot
      ? (moodOrSnapshot.updatedAt ?? updatedAt)
      : updatedAt

    const validatedMood = v.parse(MoodVectorSchema, rawMood)
    const validatedTraits = v.parse(PersonalityTraitsSchema, rawTraits)
    this.memory.affectiveState = {
      mood: validatedMood,
      traits: validatedTraits,
      updatedAt: effectiveUpdatedAt,
    }

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO affective_state (singleton_id, mood_json, traits_json, updated_at)
           VALUES (1, ?, ?, ?)`,
        )
        .run(
          JSON.stringify(validatedMood),
          JSON.stringify(validatedTraits),
          effectiveUpdatedAt,
        )
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
          this.encryptField(session.title, 'chat_sessions.title'),
          session.startedAt,
          session.updatedAt,
          session.turnCount,
          this.encryptField(session.lastMessagePreview, 'chat_sessions.last_message_preview'),
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

  public listSessions(): ChatSessionRecord[] {
    return this.listChatSessions()
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
          this.encryptField(record.content, 'chat_messages.content'),
          this.encryptField(record.rawContent, 'chat_messages.raw_content'),
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
        .run(
          record.createdAt,
          this.encryptField(preview, 'chat_sessions.last_message_preview'),
          turnDelta,
          record.sessionId,
        )

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

  public listUnconsolidatedMessages(sessionId: string): ChatMessageRecord[] {
    return this.listUnconsolidatedChatMessages(sessionId)
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
          this.hydrateMemoryFromSqlite()
        } catch {
          // Ignore rollback failure
        }
        throw err
      }
    }
  }

  public listAllChatMessages(): ChatMessageRecord[] {
    if (!this.sqlite) {
      return [...this.memory.chatMessages].sort((a, b) => a.createdAt - b.createdAt)
    }
    const rows = this.sqlite
      .prepare('SELECT rowid AS _rowid, * FROM chat_messages ORDER BY created_at ASC, _rowid ASC')
      .all()
    return rows.map((row) => this.mapRowToChatMessage(row))
  }

  private mapRowToChatSession(row: Record<string, unknown>): ChatSessionRecord {
    return {
      id: String(row.id),
      title: this.decryptField(String(row.title), 'chat_sessions.title'),
      startedAt: Number(row.started_at),
      updatedAt: Number(row.updated_at),
      turnCount: Number(row.turn_count ?? 0),
      lastMessagePreview: this.decryptField(
        String(row.last_message_preview ?? ''),
        'chat_sessions.last_message_preview',
      ),
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
      content: this.decryptField(String(row.content), 'chat_messages.content'),
      rawContent: this.decryptField(String(row.raw_content), 'chat_messages.raw_content'),
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

  // 11. Agency Audit Log & Consent State (Migration v4 — Phase 7)
  public insertActionAuditLog(entry: SharedActionAuditLogEntry): SharedActionAuditLogEntry {
    const id = String(entry.id || `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).trim()
    const riskTier: ActionRiskTier = VALID_ACTION_RISK_TIERS.has(entry.riskTier)
      ? entry.riskTier
      : 'staged-confirm'
    const decision: AuditDecision = VALID_AUDIT_DECISIONS.has(entry.decision)
      ? entry.decision
      : 'denied'

    const record: SharedActionAuditLogEntry = {
      id,
      timestamp: Number.isFinite(entry.timestamp) ? Math.floor(entry.timestamp) : Date.now(),
      toolName: String(entry.toolName ?? ''),
      serverName: String(entry.serverName ?? ''),
      riskTier,
      decision,
      argsPreview: String(entry.argsPreview ?? '{}'),
      actionId: entry.actionId ?? null,
      reason: entry.reason ?? null,
      blastRadiusWarning: entry.blastRadiusWarning ?? null,
      targetPath: entry.targetPath ?? null,
      commandPreview: entry.commandPreview ?? null,
      diffPreview: entry.diffPreview ?? null,
    }

    const existingIdx = this.memory.actionAuditLog.findIndex((item) => item.id === record.id)
    if (existingIdx >= 0) {
      this.memory.actionAuditLog[existingIdx] = record
    } else {
      this.memory.actionAuditLog.push(record)
    }

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO action_audit_log (
            id, timestamp, tool_name, server_name, risk_tier, decision,
            args_preview, action_id, reason, blast_radius_warning,
            target_path, command_preview, diff_preview
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.timestamp,
          record.toolName,
          record.serverName,
          record.riskTier,
          record.decision,
          this.encryptField(record.argsPreview, 'action_audit_log.args_preview'),
          record.actionId ?? null,
          record.reason ?? null,
          record.blastRadiusWarning ?? null,
          record.targetPath ?? null,
          record.commandPreview !== null && record.commandPreview !== undefined
            ? this.encryptField(record.commandPreview, 'action_audit_log.command_preview')
            : null,
          record.diffPreview !== null && record.diffPreview !== undefined
            ? this.encryptField(record.diffPreview, 'action_audit_log.diff_preview')
            : null,
        )
    }

    return { ...record }
  }

  public listActionAuditLog(limit = 100): SharedActionAuditLogEntry[] {
    if (!Number.isFinite(limit) || limit <= 0) {
      return []
    }
    const safeLimit = Math.floor(limit)

    if (!this.sqlite) {
      return this.memory.actionAuditLog
        .map((item, idx) => ({ item, idx }))
        .sort((a, b) => b.item.timestamp - a.item.timestamp || b.idx - a.idx)
        .slice(0, safeLimit)
        .map(({ item }) => ({ ...item }))
    }

    const rows = this.sqlite
      .prepare(
        `SELECT rowid AS _rowid, * FROM action_audit_log
         ORDER BY timestamp DESC, _rowid DESC
         LIMIT ?`,
      )
      .all(safeLimit)

    return rows.map((row) => this.mapRowToActionAuditLog(row))
  }

  public clearActionAuditLog(): void {
    this.memory.actionAuditLog.length = 0
    if (this.sqlite) {
      this.sqlite.prepare('DELETE FROM action_audit_log').run()
    }
  }

  public getAgencyConsentState(): PersistedAgencyConsentState {
    if (!this.sqlite) {
      return structuredClone(this.memory.agencyConsentState)
    }

    const row = this.sqlite
      .prepare('SELECT * FROM agency_consent_state WHERE singleton_id = 1')
      .get()
    if (!row) {
      return structuredClone(this.memory.agencyConsentState)
    }

    const parsed = this.mapRowToAgencyConsentState(row)
    this.memory.agencyConsentState = structuredClone(parsed)
    return structuredClone(parsed)
  }

  public saveAgencyConsentState(
    patch: Partial<PersistedAgencyConsentState>,
  ): PersistedAgencyConsentState {
    const current = this.getAgencyConsentState()
    const eyesMode: SharedEyesMode =
      patch.eyesMode && VALID_EYES_MODES.has(patch.eyesMode) ? patch.eyesMode : current.eyesMode
    const micMode: SharedMicMode =
      patch.micMode && VALID_MIC_MODES.has(patch.micMode) ? patch.micMode : current.micMode
    const dndMode = patch.dndMode !== undefined ? Boolean(patch.dndMode) : current.dndMode
    const approvalPolicy: ComputerActionsPolicy =
      patch.approvalPolicy && VALID_COMPUTER_ACTIONS_POLICIES.has(patch.approvalPolicy)
        ? patch.approvalPolicy
        : current.approvalPolicy

    const allowedPaths = Array.isArray(patch.allowedPaths)
      ? patch.allowedPaths.map((p) => String(p).trim()).filter(Boolean)
      : [...current.allowedPaths]

    const allowedWindowTitles = Array.isArray(patch.allowedWindowTitles)
      ? patch.allowedWindowTitles.map((w) => String(w).trim()).filter(Boolean)
      : [...current.allowedWindowTitles]

    const toolRiskOverrides: Record<string, ActionRiskTier> = {}
    const sourceOverrides = patch.toolRiskOverrides ?? current.toolRiskOverrides
    if (sourceOverrides && typeof sourceOverrides === 'object') {
      for (const [toolName, tier] of Object.entries(sourceOverrides)) {
        const cleanTool = toolName.trim()
        if (cleanTool && VALID_ACTION_RISK_TIERS.has(tier)) {
          toolRiskOverrides[cleanTool] = tier
        }
      }
    }

    const sourceServers = Array.isArray(patch.externalMcpServers)
      ? patch.externalMcpServers
      : current.externalMcpServers
    const externalMcpServers: ExternalMcpServerConfig[] = sourceServers.map((srv) => {
      const rawEnv = (srv as { env?: Record<string, unknown> }).env
      let cleanEnv: Record<string, string> | undefined
      if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
        cleanEnv = {}
        for (const [k, v] of Object.entries(rawEnv)) {
          if (typeof k === 'string' && k.trim()) {
            cleanEnv[k.trim()] = String(v ?? '')
          }
        }
      }
      return {
        id: String(srv.id).trim(),
        name: String(srv.name).trim(),
        description: String(srv.description ?? '').trim(),
        transport: srv.transport === 'stdio' ? 'stdio' : 'http',
        ...(srv.url !== undefined ? { url: String(srv.url).trim() } : {}),
        ...(srv.command !== undefined ? { command: String(srv.command).trim() } : {}),
        args: Array.isArray(srv.args) ? srv.args.map((a) => String(a)) : [],
        enabled: srv.enabled !== undefined ? Boolean(srv.enabled) : true,
        ...(cleanEnv ? { env: cleanEnv } : {}),
      } as ExternalMcpServerConfig
    })

    const updatedAt =
      patch.updatedAt !== undefined && Number.isFinite(patch.updatedAt)
        ? Math.floor(patch.updatedAt)
        : Date.now()

    const next: PersistedAgencyConsentState = {
      eyesMode,
      micMode,
      dndMode,
      approvalPolicy,
      allowedPaths,
      allowedWindowTitles,
      toolRiskOverrides,
      externalMcpServers,
      updatedAt,
    }

    this.memory.agencyConsentState = structuredClone(next)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT INTO agency_consent_state (
            singleton_id,
            eyes_mode,
            mic_mode,
            dnd_mode,
            approval_policy,
            allowed_paths_json,
            allowed_windows_json,
            tool_risk_overrides_json,
            external_mcp_servers_json,
            updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(singleton_id) DO UPDATE SET
            eyes_mode = excluded.eyes_mode,
            mic_mode = excluded.mic_mode,
            dnd_mode = excluded.dnd_mode,
            approval_policy = excluded.approval_policy,
            allowed_paths_json = excluded.allowed_paths_json,
            allowed_windows_json = excluded.allowed_windows_json,
            tool_risk_overrides_json = excluded.tool_risk_overrides_json,
            external_mcp_servers_json = excluded.external_mcp_servers_json,
            updated_at = excluded.updated_at`,
        )
        .run(
          next.eyesMode,
          next.micMode,
          next.dndMode ? 1 : 0,
          next.approvalPolicy,
          JSON.stringify(next.allowedPaths),
          JSON.stringify(next.allowedWindowTitles),
          JSON.stringify(next.toolRiskOverrides),
          JSON.stringify(next.externalMcpServers),
          next.updatedAt,
        )
    }

    return structuredClone(next)
  }

  private mapRowToActionAuditLog(row: Record<string, unknown>): SharedActionAuditLogEntry {
    const rawRisk = String(row.risk_tier ?? 'staged-confirm')
    const riskTier: ActionRiskTier = VALID_ACTION_RISK_TIERS.has(rawRisk)
      ? (rawRisk as ActionRiskTier)
      : 'staged-confirm'
    const rawDecision = String(row.decision ?? 'denied')
    const decision: AuditDecision = VALID_AUDIT_DECISIONS.has(rawDecision)
      ? (rawDecision as AuditDecision)
      : 'denied'

    return {
      id: String(row.id),
      timestamp: Number(row.timestamp),
      toolName: String(row.tool_name),
      serverName: String(row.server_name),
      riskTier,
      decision,
      argsPreview: this.decryptField(
        String(row.args_preview ?? '{}'),
        'action_audit_log.args_preview',
      ),
      actionId:
        row.action_id === null || row.action_id === undefined ? null : String(row.action_id),
      reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
      blastRadiusWarning:
        row.blast_radius_warning === null || row.blast_radius_warning === undefined
          ? null
          : String(row.blast_radius_warning),
      targetPath:
        row.target_path === null || row.target_path === undefined ? null : String(row.target_path),
      commandPreview:
        row.command_preview === null || row.command_preview === undefined
          ? null
          : this.decryptField(String(row.command_preview), 'action_audit_log.command_preview'),
      diffPreview:
        row.diff_preview === null || row.diff_preview === undefined
          ? null
          : this.decryptField(String(row.diff_preview), 'action_audit_log.diff_preview'),
    }
  }

  private mapRowToAgencyConsentState(row: Record<string, unknown>): PersistedAgencyConsentState {
    const rawEyes = String(row.eyes_mode ?? DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.eyesMode)
    const eyesMode: SharedEyesMode = VALID_EYES_MODES.has(rawEyes)
      ? (rawEyes as SharedEyesMode)
      : DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.eyesMode

    const rawMic = String(row.mic_mode ?? DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.micMode)
    const micMode: SharedMicMode = VALID_MIC_MODES.has(rawMic)
      ? (rawMic as SharedMicMode)
      : DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.micMode

    const dndMode = Number(row.dnd_mode ?? 0) === 1

    const rawPolicy = String(
      row.approval_policy ?? DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.approvalPolicy,
    )
    const approvalPolicy: ComputerActionsPolicy = VALID_COMPUTER_ACTIONS_POLICIES.has(rawPolicy)
      ? (rawPolicy as ComputerActionsPolicy)
      : DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.approvalPolicy

    const parsedPaths = safeParseJson<unknown[]>(
      row.allowed_paths_json,
      [...DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.allowedPaths],
    )
    const allowedPaths = Array.isArray(parsedPaths)
      ? parsedPaths.map((p) => String(p).trim()).filter(Boolean)
      : [...DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.allowedPaths]

    const parsedWindows = safeParseJson<unknown[]>(
      row.allowed_windows_json,
      [...DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.allowedWindowTitles],
    )
    const allowedWindowTitles = Array.isArray(parsedWindows)
      ? parsedWindows.map((w) => String(w).trim()).filter(Boolean)
      : [...DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.allowedWindowTitles]

    const parsedOverrides = safeParseJson<Record<string, unknown>>(
      row.tool_risk_overrides_json,
      {},
    )
    const toolRiskOverrides: Record<string, ActionRiskTier> = {}
    if (parsedOverrides && typeof parsedOverrides === 'object' && !Array.isArray(parsedOverrides)) {
      for (const [toolName, tier] of Object.entries(parsedOverrides)) {
        const cleanTool = toolName.trim()
        if (cleanTool && typeof tier === 'string' && VALID_ACTION_RISK_TIERS.has(tier)) {
          toolRiskOverrides[cleanTool] = tier as ActionRiskTier
        }
      }
    }

    const parsedServers = safeParseJson<unknown[]>(row.external_mcp_servers_json, [])
    const externalMcpServers: ExternalMcpServerConfig[] = []
    if (Array.isArray(parsedServers)) {
      for (const item of parsedServers) {
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>
          const id = String(rec.id ?? '').trim()
          const name = String(rec.name ?? '').trim()
          if (!id || !name) continue
          let cleanEnv: Record<string, string> | undefined
          if (rec.env && typeof rec.env === 'object' && !Array.isArray(rec.env)) {
            cleanEnv = {}
            for (const [k, v] of Object.entries(rec.env as Record<string, unknown>)) {
              if (typeof k === 'string' && k.trim()) {
                cleanEnv[k.trim()] = String(v ?? '')
              }
            }
          }
          externalMcpServers.push({
            id,
            name,
            description: String(rec.description ?? '').trim(),
            transport: rec.transport === 'stdio' ? 'stdio' : 'http',
            ...(typeof rec.url === 'string' ? { url: rec.url.trim() } : {}),
            ...(typeof rec.command === 'string' ? { command: rec.command.trim() } : {}),
            args: Array.isArray(rec.args) ? rec.args.map((a) => String(a)) : [],
            enabled: rec.enabled !== undefined ? Boolean(rec.enabled) : true,
            ...(cleanEnv ? { env: cleanEnv } : {}),
          } as ExternalMcpServerConfig)
        }
      }
    }

    return {
      eyesMode,
      micMode,
      dndMode,
      approvalPolicy,
      allowedPaths,
      allowedWindowTitles,
      toolRiskOverrides,
      externalMcpServers,
      updatedAt: Number(row.updated_at ?? 0),
    }
  }

  // 12. Phase 8 — Initiative Policy, Proactive Initiative Log & Dream Reflection Journal (Migration v5)
  public getInitiativePolicy(): InitiativePolicy {
    if (!this.sqlite) {
      return { ...this.memory.initiativePolicy }
    }
    const row = this.sqlite
      .prepare('SELECT * FROM initiative_policy_state WHERE id = 1')
      .get()
    if (!row) {
      return { ...DEFAULT_INITIATIVE_POLICY }
    }
    const parsed = v.parse(InitiativePolicySchema, {
      enabled: Number(row.enabled ?? 1) === 1,
      cooldownMinutes: Number(row.cooldown_minutes ?? DEFAULT_INITIATIVE_POLICY.cooldownMinutes),
      maxDailyInitiatives: Number(
        row.max_daily_initiatives ?? DEFAULT_INITIATIVE_POLICY.maxDailyInitiatives,
      ),
      quietHoursStart: String(
        row.quiet_hours_start ?? DEFAULT_INITIATIVE_POLICY.quietHoursStart,
      ),
      quietHoursEnd: String(row.quiet_hours_end ?? DEFAULT_INITIATIVE_POLICY.quietHoursEnd),
      respectDnd: Number(row.respect_dnd ?? 1) === 1,
      modulateByHabits: Number(row.modulate_by_habits ?? 1) === 1,
    })
    this.memory.initiativePolicy = { ...parsed }
    return { ...parsed }
  }

  public saveInitiativePolicy(input: UpdateInitiativePolicyInput): InitiativePolicy {
    const patch = v.parse(UpdateInitiativePolicyInputSchema, input)
    const current = this.getInitiativePolicy()
    const next = v.parse(InitiativePolicySchema, {
      ...current,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.cooldownMinutes !== undefined
        ? { cooldownMinutes: patch.cooldownMinutes }
        : {}),
      ...(patch.maxDailyInitiatives !== undefined
        ? { maxDailyInitiatives: patch.maxDailyInitiatives }
        : {}),
      ...(patch.quietHoursStart !== undefined
        ? { quietHoursStart: patch.quietHoursStart }
        : {}),
      ...(patch.quietHoursEnd !== undefined ? { quietHoursEnd: patch.quietHoursEnd } : {}),
      ...(patch.respectDnd !== undefined ? { respectDnd: patch.respectDnd } : {}),
      ...(patch.modulateByHabits !== undefined
        ? { modulateByHabits: patch.modulateByHabits }
        : {}),
    })

    this.memory.initiativePolicy = { ...next }

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO initiative_policy_state (
            id, enabled, cooldown_minutes, max_daily_initiatives,
            quiet_hours_start, quiet_hours_end, respect_dnd, modulate_by_habits, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          next.enabled ? 1 : 0,
          next.cooldownMinutes,
          next.maxDailyInitiatives,
          next.quietHoursStart,
          next.quietHoursEnd,
          next.respectDnd ? 1 : 0,
          next.modulateByHabits ? 1 : 0,
          Date.now(),
        )
    }

    return { ...next }
  }

  public insertProactiveInitiativeLog(
    record: ProactiveInitiativeRecord,
  ): ProactiveInitiativeRecord {
    const parsed = v.parse(ProactiveInitiativeRecordSchema, record)
    const existingIdx = this.memory.proactiveInitiativeLog.findIndex(
      (r) => r.id === parsed.id,
    )
    if (existingIdx >= 0) {
      this.memory.proactiveInitiativeLog[existingIdx] = parsed
    } else {
      this.memory.proactiveInitiativeLog.push(parsed)
    }

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO proactive_initiative_log (
            id, trigger_kind, source_id, source_title,
            notice_prompt, reply_text, decision, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.triggerKind,
          parsed.sourceId ?? null,
          parsed.sourceTitle,
          parsed.noticePrompt,
          parsed.replyText ?? null,
          parsed.decision,
          parsed.reason,
          parsed.createdAt,
        )
    }

    return { ...parsed }
  }

  public listProactiveInitiativeLog(limit = 50): ProactiveInitiativeRecord[] {
    if (!Number.isFinite(limit) || limit <= 0) {
      return []
    }
    const safeLimit = Math.floor(limit)

    if (!this.sqlite) {
      return this.memory.proactiveInitiativeLog
        .map((item, idx) => ({ item, idx }))
        .sort((a, b) => b.item.createdAt - a.item.createdAt || b.idx - a.idx)
        .slice(0, safeLimit)
        .map(({ item }) => ({ ...item }))
    }

    const rows = this.sqlite
      .prepare(
        `SELECT rowid AS _rowid, * FROM proactive_initiative_log
         ORDER BY created_at DESC, _rowid DESC
         LIMIT ?`,
      )
      .all(safeLimit)

    return rows.map((row) =>
      v.parse(ProactiveInitiativeRecordSchema, {
        id: String(row.id),
        triggerKind: String(row.trigger_kind),
        sourceId:
          row.source_id === null || row.source_id === undefined
            ? null
            : String(row.source_id),
        sourceTitle: String(row.source_title ?? ''),
        noticePrompt: String(row.notice_prompt ?? ''),
        replyText:
          row.reply_text === null || row.reply_text === undefined
            ? null
            : String(row.reply_text),
        decision: String(row.decision),
        reason: String(row.reason),
        createdAt: Number(row.created_at),
      }),
    )
  }

  public insertDreamJournalEntry(entry: DreamJournalEntry): DreamJournalEntry {
    const parsed = v.parse(DreamJournalEntrySchema, {
      ...entry,
      summary: entry.summary.replace(/\0/g, '').trim(),
      sourceEpisodeIds: Array.from(new Set(entry.sourceEpisodeIds)),
    })
    this.memory.dreamJournal.set(parsed.id, parsed)

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR REPLACE INTO dream_reflection_journal (
            id, summary, source_episode_ids_json,
            cross_links_count, trait_evolutions_count, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          this.encryptField(parsed.summary, 'dream_reflection_journal.summary'),
          JSON.stringify(parsed.sourceEpisodeIds),
          parsed.crossLinksCount,
          parsed.traitEvolutionsCount,
          parsed.createdAt,
        )
    }

    return {
      ...parsed,
      sourceEpisodeIds: [...parsed.sourceEpisodeIds],
    }
  }

  public listDreamJournalEntries(limit = 50): DreamJournalEntry[] {
    if (!Number.isFinite(limit) || limit <= 0) {
      return []
    }
    const safeLimit = Math.floor(limit)

    if (!this.sqlite) {
      return Array.from(this.memory.dreamJournal.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, safeLimit)
        .map((entry) => ({
          ...entry,
          sourceEpisodeIds: [...entry.sourceEpisodeIds],
        }))
    }

    const rows = this.sqlite
      .prepare(
        `SELECT rowid AS _rowid, * FROM dream_reflection_journal
         ORDER BY created_at DESC, _rowid DESC
         LIMIT ?`,
      )
      .all(safeLimit)

    return rows.map((row) =>
      v.parse(DreamJournalEntrySchema, {
        id: String(row.id),
        summary: this.decryptField(String(row.summary), 'dream_reflection_journal.summary'),
        sourceEpisodeIds: safeParseJson<string[]>(row.source_episode_ids_json, []),
        crossLinksCount: Number(row.cross_links_count ?? 0),
        traitEvolutionsCount: Number(row.trait_evolutions_count ?? 0),
        createdAt: Number(row.created_at),
      }),
    )
  }

  // 13. Phase 9 — Encryption at Rest (`AES-256-GCM` + AAD) & Soul Portability (`export` / `import` / `wipeAll`)
  public isEncryptionAtRestEnabled(): boolean {
    return this.encryptionAtRestEnabled
  }

  public getEncryptionUpdatedAt(): string | null {
    return this.encryptionUpdatedAt
  }

  private checkpointAndVacuumSqlite(): void {
    if (!this.sqlite) return
    try {
      this.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      // Ignore if in-memory or non-WAL
    }
    try {
      this.sqlite.exec('VACUUM;')
    } catch {
      // Ignore if vacuum fails
    }
  }

  public setEncryptionAtRest(enabled: boolean, codec?: CortexEncryptionCodec): void {
    if (codec) {
      this.encryptionCodec = codec
    }
    if (enabled && !this.encryptionCodec) {
      throw new Error(
        'CORTEX_ENCRYPTION_CODEC_REQUIRED: Cannot enable encryption at rest without an encryptionCodec.',
      )
    }

    // Ensure this.memory holds all current decrypted records before toggling encryptionAtRestEnabled
    if (this.sqlite) {
      this.hydrateMemoryFromSqlite()
    }

    this.encryptionAtRestEnabled = Boolean(enabled)
    const updatedAt = new Date().toISOString()
    this.encryptionUpdatedAt = updatedAt

    if (!this.sqlite) {
      return
    }

    const keyCheckCipher = this.encryptionAtRestEnabled
      ? this.encryptionCodec!.encrypt('ASHY_CORTEX_KEY_OK', 'cortex_encryption_state.key_check')
      : null

    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      this.sqlite
        .prepare(
          `INSERT INTO cortex_encryption_state (singleton_id, enabled, key_check_cipher, updated_at)
           VALUES (1, ?, ?, ?)
           ON CONFLICT(singleton_id) DO UPDATE SET
             enabled = excluded.enabled,
             key_check_cipher = excluded.key_check_cipher,
             updated_at = excluded.updated_at`,
        )
        .run(this.encryptionAtRestEnabled ? 1 : 0, keyCheckCipher, updatedAt)

      // 1. episodic_memories & episodic_fts
      this.sqlite.prepare('DELETE FROM episodic_fts').run()
      const updateEpStmt = this.sqlite.prepare(
        'UPDATE episodic_memories SET title = ?, summary = ?, content = ? WHERE id = ?',
      )
      const insertFtsStmt = this.sqlite.prepare(
        'INSERT INTO episodic_fts (memory_id, title, summary, content) VALUES (?, ?, ?, ?)',
      )
      for (const ep of this.memory.episodicMemories.values()) {
        updateEpStmt.run(
          this.encryptField(ep.title, 'episodic_memories.title'),
          this.encryptField(ep.summary, 'episodic_memories.summary'),
          this.encryptField(ep.content, 'episodic_memories.content'),
          ep.id,
        )
        if (!this.encryptionAtRestEnabled) {
          insertFtsStmt.run(ep.id, ep.title, ep.summary, ep.content)
        }
      }
      this.sqlite.exec("INSERT INTO episodic_fts(episodic_fts) VALUES('rebuild');")

      // 2. semantic_facts
      const updateFactStmt = this.sqlite.prepare(
        'UPDATE semantic_facts SET object = ? WHERE id = ?',
      )
      for (const fact of this.memory.semanticFacts.values()) {
        updateFactStmt.run(this.encryptField(fact.object, 'semantic_facts.object'), fact.id)
      }

      // 3. relational_motifs
      const updateMotifStmt = this.sqlite.prepare(
        'UPDATE relational_motifs SET motif = ?, origin_summary = ? WHERE id = ?',
      )
      for (const motif of this.memory.relationalMotifs.values()) {
        updateMotifStmt.run(
          this.encryptField(motif.motif, 'relational_motifs.motif'),
          this.encryptField(motif.originSummary, 'relational_motifs.origin_summary'),
          motif.id,
        )
      }

      // 4. autobiographical_milestones
      const updateMsStmt = this.sqlite.prepare(
        'UPDATE autobiographical_milestones SET title = ?, narrative = ? WHERE id = ?',
      )
      for (const ms of this.memory.milestones.values()) {
        updateMsStmt.run(
          this.encryptField(ms.title, 'autobiographical_milestones.title'),
          this.encryptField(ms.narrative, 'autobiographical_milestones.narrative'),
          ms.id,
        )
      }

      // 5. user_habits
      const updateHabitStmt = this.sqlite.prepare(
        'UPDATE user_habits SET description = ? WHERE id = ?',
      )
      for (const habit of this.memory.userHabits.values()) {
        updateHabitStmt.run(
          this.encryptField(habit.description, 'user_habits.description'),
          habit.id,
        )
      }

      // 6. prospective_intents
      const updateIntentStmt = this.sqlite.prepare(
        'UPDATE prospective_intents SET topic = ?, context_cue = ? WHERE id = ?',
      )
      for (const intent of this.memory.prospectiveIntents.values()) {
        updateIntentStmt.run(
          this.encryptField(intent.topic, 'prospective_intents.topic'),
          this.encryptField(intent.contextCue, 'prospective_intents.context_cue'),
          intent.id,
        )
      }

      // 7. chat_sessions
      const updateSessStmt = this.sqlite.prepare(
        'UPDATE chat_sessions SET title = ?, last_message_preview = ? WHERE id = ?',
      )
      for (const sess of this.memory.chatSessions.values()) {
        updateSessStmt.run(
          this.encryptField(sess.title, 'chat_sessions.title'),
          this.encryptField(sess.lastMessagePreview, 'chat_sessions.last_message_preview'),
          sess.id,
        )
      }

      // 8. chat_messages
      const updateMsgStmt = this.sqlite.prepare(
        'UPDATE chat_messages SET content = ?, raw_content = ? WHERE id = ?',
      )
      for (const msg of this.memory.chatMessages) {
        updateMsgStmt.run(
          this.encryptField(msg.content, 'chat_messages.content'),
          this.encryptField(msg.rawContent, 'chat_messages.raw_content'),
          msg.id,
        )
      }

      // 9. action_audit_log
      const updateAuditStmt = this.sqlite.prepare(
        'UPDATE action_audit_log SET args_preview = ?, command_preview = ?, diff_preview = ? WHERE id = ?',
      )
      for (const entry of this.memory.actionAuditLog) {
        updateAuditStmt.run(
          this.encryptField(entry.argsPreview, 'action_audit_log.args_preview'),
          entry.commandPreview !== null && entry.commandPreview !== undefined
            ? this.encryptField(entry.commandPreview, 'action_audit_log.command_preview')
            : null,
          entry.diffPreview !== null && entry.diffPreview !== undefined
            ? this.encryptField(entry.diffPreview, 'action_audit_log.diff_preview')
            : null,
          entry.id,
        )
      }

      // 10. dream_reflection_journal
      const updateDreamStmt = this.sqlite.prepare(
        'UPDATE dream_reflection_journal SET summary = ? WHERE id = ?',
      )
      for (const entry of this.memory.dreamJournal.values()) {
        updateDreamStmt.run(
          this.encryptField(entry.summary, 'dream_reflection_journal.summary'),
          entry.id,
        )
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

    this.checkpointAndVacuumSqlite()
  }

  public exportSoulSnapshot(): CortexSoulSnapshot {
    const rawConsent = this.getAgencyConsentState()
    const sanitizedConsent: PersistedAgencyConsentState = {
      ...rawConsent,
      externalMcpServers: rawConsent.externalMcpServers.map((srv) => {
        const rawEnv = (srv as { env?: Record<string, unknown> }).env
        if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
          const redactedEnv: Record<string, string> = {}
          for (const key of Object.keys(rawEnv)) {
            redactedEnv[key] = '***REDACTED***'
          }
          return {
            ...srv,
            env: redactedEnv,
          } as ExternalMcpServerConfig
        }
        return { ...srv }
      }),
    }

    return {
      episodicMemories: this.listEpisodicMemories(),
      semanticFacts: this.listSemanticFacts(),
      relationalMotifs: this.listRelationalMotifs(),
      milestones: this.listMilestones(),
      userHabits: this.listUserHabits(),
      prospectiveIntents: this.listProspectiveIntents(),
      personalityEvolution: this.listPersonalityEvolution(),
      affectiveState: this.getAffectiveState(),
      styleExemplars: this.listStyleExemplars(),
      goldenExemplars: this.listGoldenExemplars(),
      chatSessions: this.listChatSessions(),
      chatMessages: this.listAllChatMessages(),
      memoryGovernance: this.getMemoryGovernancePolicy(),
      actionAuditLog: this.listActionAuditLog(10_000),
      agencyConsent: sanitizedConsent,
      initiativePolicy: this.getInitiativePolicy(),
      proactiveInitiativeLog: this.listProactiveInitiativeLog(10_000),
      dreamJournalEntries: this.listDreamJournalEntries(10_000),
    }
  }

  public importSoulSnapshot(snapshot: CortexSoulSnapshot): void {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('Invalid CortexSoulSnapshot: expected an object')
    }

    // 1. Validate all collections up-front before touching SQLite or MemoryStorageAdapter
    const validatedEpisodes: EpisodicMemory[] = (snapshot.episodicMemories ?? []).map((raw) => {
      const ep = raw as EpisodicMemory
      if (!ep || typeof ep.id !== 'string' || !ep.id.trim()) {
        throw new Error('Invalid EpisodicMemory in snapshot: missing id')
      }
      if (
        !Number.isFinite(ep.stability) ||
        !Number.isFinite(ep.difficulty) ||
        !Number.isFinite(ep.surprise) ||
        !Number.isFinite(ep.createdAt) ||
        !Number.isFinite(ep.lastReviewedAt)
      ) {
        throw new Error(`Invalid non-finite FSRS parameters in EpisodicMemory ${ep.id}`)
      }
      const autoEmbedding =
        ep.embedding && ep.embedding.length > 0
          ? ep.embedding
          : embedTextSync128(`${ep.title} ${ep.summary} ${ep.content} ${(ep.tags ?? []).join(' ')}`)
      return v.parse(EpisodicMemorySchema, {
        ...ep,
        embedding: autoEmbedding,
        approvalStatus: ep.approvalStatus ?? 'approved',
      })
    })

    const validatedFacts: SemanticFact[] = (snapshot.semanticFacts ?? []).map((raw) => {
      const f = raw as SemanticFact
      if (!f || typeof f.id !== 'string' || !f.id.trim()) {
        throw new Error('Invalid SemanticFact in snapshot: missing id')
      }
      if (!Number.isFinite(f.confidence) || !Number.isFinite(f.validFrom)) {
        throw new Error(`Invalid non-finite numbers in SemanticFact ${f.id}`)
      }
      const autoEmbedding =
        f.embedding && f.embedding.length > 0
          ? f.embedding
          : embedTextSync128(`${f.category} ${f.subject} ${f.predicate} ${f.object}`)
      return v.parse(SemanticFactSchema, {
        ...f,
        embedding: autoEmbedding,
        approvalStatus: f.approvalStatus ?? 'approved',
      })
    })

    const validatedMotifs: RelationalMotif[] = (snapshot.relationalMotifs ?? []).map((raw) => {
      const m = raw as RelationalMotif
      if (!m || typeof m.id !== 'string' || !m.id.trim()) {
        throw new Error('Invalid RelationalMotif in snapshot: missing id')
      }
      if (
        !Number.isFinite(m.timesUsed) ||
        !Number.isFinite(m.cooldownHours) ||
        !Number.isFinite(m.createdAt)
      ) {
        throw new Error(`Invalid non-finite numbers in RelationalMotif ${m.id}`)
      }
      const autoEmbedding =
        m.embedding && m.embedding.length > 0
          ? m.embedding
          : embedTextSync128(
              [m.motif, m.originSummary ?? '', ...(m.triggerCues ?? [])].join(' '),
            )
      return v.parse(RelationalMotifSchema, {
        ...m,
        embedding: autoEmbedding,
        approvalStatus: m.approvalStatus ?? 'approved',
      })
    })

    const validatedMilestones: AutobiographicalMilestone[] = (snapshot.milestones ?? []).map(
      (raw) => v.parse(AutobiographicalMilestoneSchema, raw),
    )

    const validatedHabits: UserHabit[] = (snapshot.userHabits ?? []).map((raw) => {
      const h = raw as UserHabit
      return v.parse(UserHabitSchema, {
        ...h,
        approvalStatus: h?.approvalStatus ?? 'approved',
      })
    })

    const validatedIntents: ProspectiveIntent[] = (snapshot.prospectiveIntents ?? []).map(
      (raw) => {
        const i = raw as ProspectiveIntent
        return v.parse(ProspectiveIntentSchema, {
          ...i,
          approvalStatus: i?.approvalStatus ?? 'approved',
        })
      },
    )

    const validatedEvolution: PersonalityEvolutionRecord[] = (
      snapshot.personalityEvolution ?? []
    ).map((raw) => v.parse(PersonalityEvolutionRecordSchema, raw))

    const rawAffective = (snapshot.affectiveState ?? snapshot.personalityProfile) as
      | AffectiveStateSnapshot
      | undefined
    let validatedAffective: AffectiveStateSnapshot = {
      mood: { ...ASHY_BASELINE_MOOD },
      traits: { ...ASHY_DEFAULT_TRAITS },
      updatedAt: 0,
    }
    if (rawAffective && typeof rawAffective === 'object') {
      const validatedMood = v.parse(MoodVectorSchema, rawAffective.mood ?? ASHY_BASELINE_MOOD)
      const validatedTraits = v.parse(
        PersonalityTraitsSchema,
        rawAffective.traits ?? ASHY_DEFAULT_TRAITS,
      )
      const updatedAt =
        rawAffective.updatedAt !== undefined ? Number(rawAffective.updatedAt) : Date.now()
      if (!Number.isFinite(updatedAt)) {
        throw new Error('Invalid non-finite affectiveState.updatedAt in snapshot')
      }
      validatedAffective = {
        mood: validatedMood,
        traits: validatedTraits,
        updatedAt,
      }
    }

    const validatedStyleExemplars: StyleExemplar[] =
      Array.isArray(snapshot.styleExemplars) && snapshot.styleExemplars.length > 0
        ? snapshot.styleExemplars.map((ex: StyleExemplar) => ({
            id: String(ex.id).trim(),
            situation: String(ex.situation ?? ''),
            userSample: String(ex.userSample ?? ''),
            ashySample: String(ex.ashySample ?? ''),
            notes: String(ex.notes ?? ''),
          }))
        : [...DEFAULT_GOLDEN_STYLE_EXEMPLARS]

    const validatedGoldenExemplars: GoldenExemplarRecord[] =
      Array.isArray(snapshot.goldenExemplars) && snapshot.goldenExemplars.length > 0
        ? snapshot.goldenExemplars.map((ex: GoldenExemplarRecord) => ({
            id: String(ex.id).trim(),
            stage: ex.stage,
            context: String(ex.context ?? ''),
            userUtterance: String(ex.userUtterance ?? ''),
            ashyResponse: String(ex.ashyResponse ?? ''),
          }))
        : [...DEFAULT_GOLDEN_EXEMPLARS]

    const sessionsById = new Map<string, ChatSessionRecord>()
    for (const rawSess of snapshot.chatSessions ?? []) {
      const s = rawSess as ChatSessionRecord
      const id = String(s?.id ?? '').trim()
      if (!id) {
        throw new Error('Invalid ChatSessionRecord in snapshot: missing id')
      }
      if (
        !Number.isFinite(s.startedAt) ||
        !Number.isFinite(s.updatedAt) ||
        !Number.isFinite(s.turnCount ?? 0)
      ) {
        throw new Error(`Invalid non-finite numbers in ChatSessionRecord ${id}`)
      }
      sessionsById.set(id, {
        id,
        title: String(s.title ?? 'Nova Conversa').trim() || 'Nova Conversa',
        startedAt: Number(s.startedAt),
        updatedAt: Number(s.updatedAt),
        turnCount: Number(s.turnCount ?? 0),
        lastMessagePreview: String(s.lastMessagePreview ?? ''),
      })
    }

    const validatedMessages: ChatMessageRecord[] = (snapshot.chatMessages ?? []).map((rawMsg) => {
      const m = rawMsg as ChatMessageRecord
      const id = String(m?.id ?? '').trim()
      const sessionId = String(m?.sessionId ?? '').trim()
      if (!id || !sessionId) {
        throw new Error('Invalid ChatMessageRecord in snapshot: missing id or sessionId')
      }
      if (!VALID_CHAT_ROLES.has(m.role)) {
        throw new Error(`Invalid role in ChatMessageRecord ${id}: ${String(m.role)}`)
      }
      if (!Number.isFinite(m.createdAt)) {
        throw new Error(`Invalid non-finite createdAt in ChatMessageRecord ${id}`)
      }
      const content = String(m.content ?? '')
      const rawContent = String(m.rawContent ?? content)
      const emotion: AshyEmotion = VALID_EMOTIONS.has(m.emotion) ? m.emotion : 'neutral'

      // Synthesize fallback ChatSessionRecord if orphan sessionId is referenced
      if (!sessionsById.has(sessionId)) {
        sessionsById.set(sessionId, {
          id: sessionId,
          title: 'Conversa Importada',
          startedAt: Number(m.createdAt),
          updatedAt: Number(m.createdAt),
          turnCount: m.role === 'assistant' ? 1 : 0,
          lastMessagePreview: content.slice(0, 140),
        })
      }

      return {
        id,
        sessionId,
        role: m.role,
        content,
        rawContent,
        emotion,
        markersJson: String(m.markersJson || '[]'),
        providerId: m.providerId ?? null,
        modelId: m.modelId ?? null,
        latencyMs: m.latencyMs ?? null,
        consolidatedEpisodeId: m.consolidatedEpisodeId ?? null,
        createdAt: Number(m.createdAt),
      }
    })

    const validatedGovernance: MemoryGovernancePolicy = {
      ...DEFAULT_MEMORY_GOVERNANCE_POLICY,
    }
    if (snapshot.memoryGovernance && typeof snapshot.memoryGovernance === 'object') {
      for (const cat of MEMORY_GOVERNANCE_CATEGORIES) {
        const val = (snapshot.memoryGovernance as Record<string, unknown>)[cat]
        if (typeof val === 'boolean') {
          validatedGovernance[cat] = val
        }
      }
    }

    const validatedAuditLog: SharedActionAuditLogEntry[] = (snapshot.actionAuditLog ?? []).map(
      (rawEntry) => {
        const e = rawEntry as SharedActionAuditLogEntry
        const id = String(e?.id ?? '').trim()
        if (!id || !Number.isFinite(e.timestamp)) {
          throw new Error('Invalid ActionAuditLogEntry in snapshot')
        }
        return {
          id,
          timestamp: Math.floor(e.timestamp),
          toolName: String(e.toolName ?? ''),
          serverName: String(e.serverName ?? ''),
          riskTier: VALID_ACTION_RISK_TIERS.has(e.riskTier) ? e.riskTier : 'staged-confirm',
          decision: VALID_AUDIT_DECISIONS.has(e.decision) ? e.decision : 'denied',
          argsPreview: String(e.argsPreview ?? '{}'),
          actionId: e.actionId ?? null,
          reason: e.reason ?? null,
          blastRadiusWarning: e.blastRadiusWarning ?? null,
          targetPath: e.targetPath ?? null,
          commandPreview: e.commandPreview ?? null,
          diffPreview: e.diffPreview ?? null,
        }
      },
    )

    const validatedInitiativePolicy: InitiativePolicy = snapshot.initiativePolicy
      ? v.parse(InitiativePolicySchema, snapshot.initiativePolicy)
      : { ...DEFAULT_INITIATIVE_POLICY }

    const validatedProactiveLog: ProactiveInitiativeRecord[] = (
      snapshot.proactiveInitiativeLog ?? []
    ).map((raw) => v.parse(ProactiveInitiativeRecordSchema, raw))

    const validatedDreamEntries: DreamJournalEntry[] = (snapshot.dreamJournalEntries ?? []).map(
      (raw) => v.parse(DreamJournalEntrySchema, raw),
    )

    // 2. Apply atomically inside BEGIN IMMEDIATE ... COMMIT when SQLite is active
    if (this.sqlite) {
      this.sqlite.exec('BEGIN IMMEDIATE')
      try {
        this.clearAllDataTablesInTransaction()

        const epStmt = this.sqlite.prepare(
          `INSERT INTO episodic_memories (
            id, title, summary, content, created_at, last_reviewed_at,
            stability, difficulty, surprise, is_flashbulb, tags_json,
            embedding_json, approval_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        const ftsStmt = this.sqlite.prepare(
          'INSERT INTO episodic_fts (memory_id, title, summary, content) VALUES (?, ?, ?, ?)',
        )
        for (const ep of validatedEpisodes) {
          epStmt.run(
            ep.id,
            this.encryptField(ep.title, 'episodic_memories.title'),
            this.encryptField(ep.summary, 'episodic_memories.summary'),
            this.encryptField(ep.content, 'episodic_memories.content'),
            ep.createdAt,
            ep.lastReviewedAt,
            ep.stability,
            ep.difficulty,
            ep.surprise,
            ep.isFlashbulb ? 1 : 0,
            JSON.stringify(ep.tags),
            ep.embedding ? JSON.stringify(ep.embedding) : null,
            ep.approvalStatus ?? 'approved',
          )
          if (!this.encryptionAtRestEnabled) {
            ftsStmt.run(ep.id, ep.title, ep.summary, ep.content)
          }
        }

        const factStmt = this.sqlite.prepare(
          `INSERT INTO semantic_facts (
            id, category, subject, predicate, object, confidence,
            source_episode_ids_json, valid_from, invalid_at,
            embedding_json, approval_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const fact of validatedFacts) {
          factStmt.run(
            fact.id,
            fact.category,
            fact.subject,
            fact.predicate,
            this.encryptField(fact.object, 'semantic_facts.object'),
            fact.confidence,
            JSON.stringify(fact.sourceEpisodeIds),
            fact.validFrom,
            fact.invalidAt ?? null,
            fact.embedding ? JSON.stringify(fact.embedding) : null,
            fact.approvalStatus ?? 'approved',
          )
        }

        const motifStmt = this.sqlite.prepare(
          `INSERT INTO relational_motifs (
            id, motif, origin_summary, origin_episode_id, trigger_cues_json,
            stage, times_used, last_used_at, cooldown_hours, created_at,
            embedding_json, approval_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const motif of validatedMotifs) {
          motifStmt.run(
            motif.id,
            this.encryptField(motif.motif, 'relational_motifs.motif'),
            this.encryptField(motif.originSummary, 'relational_motifs.origin_summary'),
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

        const msStmt = this.sqlite.prepare(
          `INSERT INTO autobiographical_milestones (
            id, title, narrative, category, episode_id, room_trophy_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const ms of validatedMilestones) {
          msStmt.run(
            ms.id,
            this.encryptField(ms.title, 'autobiographical_milestones.title'),
            this.encryptField(ms.narrative, 'autobiographical_milestones.narrative'),
            ms.category,
            ms.episodeId ?? null,
            ms.roomTrophyId ?? null,
            ms.createdAt,
          )
        }

        const habitStmt = this.sqlite.prepare(
          `INSERT INTO user_habits (
            id, pattern_key, description, confidence, observation_count,
            updated_at, source_episode_id, approval_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const habit of validatedHabits) {
          habitStmt.run(
            habit.id,
            habit.patternKey,
            this.encryptField(habit.description, 'user_habits.description'),
            habit.confidence,
            habit.observationCount,
            habit.updatedAt,
            habit.sourceEpisodeId ?? null,
            habit.approvalStatus ?? 'approved',
          )
        }

        const intentStmt = this.sqlite.prepare(
          `INSERT INTO prospective_intents (
            id, topic, context_cue, due_at, status, created_at,
            source_episode_id, approval_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const intent of validatedIntents) {
          intentStmt.run(
            intent.id,
            this.encryptField(intent.topic, 'prospective_intents.topic'),
            this.encryptField(intent.contextCue, 'prospective_intents.context_cue'),
            intent.dueAt ?? null,
            intent.status,
            intent.createdAt,
            intent.sourceEpisodeId ?? null,
            intent.approvalStatus ?? 'approved',
          )
        }

        const evoStmt = this.sqlite.prepare(
          `INSERT INTO personality_evolution_log (
            id, trait, old_value, new_value, reason_episode_id, explanation, created_at, reverted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const rec of validatedEvolution) {
          evoStmt.run(
            rec.id,
            rec.trait,
            rec.oldValue,
            rec.newValue,
            rec.reasonEpisodeId,
            rec.explanation,
            rec.createdAt,
            rec.revertedAt ?? null,
          )
        }

        this.sqlite
          .prepare(
            `INSERT INTO affective_state (singleton_id, mood_json, traits_json, updated_at)
             VALUES (1, ?, ?, ?)`,
          )
          .run(
            JSON.stringify(validatedAffective.mood),
            JSON.stringify(validatedAffective.traits),
            validatedAffective.updatedAt,
          )

        const styleStmt = this.sqlite.prepare(
          `INSERT INTO style_exemplars (id, situation, user_sample, ashy_sample, notes)
           VALUES (?, ?, ?, ?, ?)`,
        )
        for (const ex of validatedStyleExemplars) {
          styleStmt.run(ex.id, ex.situation, ex.userSample, ex.ashySample, ex.notes)
        }

        const goldenStmt = this.sqlite.prepare(
          `INSERT INTO golden_exemplars (id, stage, context, user_utterance, ashy_response)
           VALUES (?, ?, ?, ?, ?)`,
        )
        for (const ex of validatedGoldenExemplars) {
          goldenStmt.run(ex.id, ex.stage, ex.context, ex.userUtterance, ex.ashyResponse)
        }

        const sessStmt = this.sqlite.prepare(
          `INSERT INTO chat_sessions (
            id, title, started_at, updated_at, turn_count, last_message_preview
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        for (const sess of sessionsById.values()) {
          sessStmt.run(
            sess.id,
            this.encryptField(sess.title, 'chat_sessions.title'),
            sess.startedAt,
            sess.updatedAt,
            sess.turnCount,
            this.encryptField(sess.lastMessagePreview, 'chat_sessions.last_message_preview'),
          )
        }

        const msgStmt = this.sqlite.prepare(
          `INSERT INTO chat_messages (
            id, session_id, role, content, raw_content, emotion,
            markers_json, provider_id, model_id, latency_ms,
            consolidated_episode_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const msg of validatedMessages) {
          msgStmt.run(
            msg.id,
            msg.sessionId,
            msg.role,
            this.encryptField(msg.content, 'chat_messages.content'),
            this.encryptField(msg.rawContent, 'chat_messages.raw_content'),
            msg.emotion,
            msg.markersJson,
            msg.providerId ?? null,
            msg.modelId ?? null,
            msg.latencyMs ?? null,
            msg.consolidatedEpisodeId ?? null,
            msg.createdAt,
          )
        }

        const govStmt = this.sqlite.prepare(
          `INSERT INTO memory_governance_settings (category, require_confirmation, updated_at)
           VALUES (?, ?, ?)`,
        )
        const now = Date.now()
        for (const cat of MEMORY_GOVERNANCE_CATEGORIES) {
          govStmt.run(cat, validatedGovernance[cat] ? 1 : 0, now)
        }

        const auditStmt = this.sqlite.prepare(
          `INSERT INTO action_audit_log (
            id, timestamp, tool_name, server_name, risk_tier, decision,
            args_preview, action_id, reason, blast_radius_warning,
            target_path, command_preview, diff_preview
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const entry of validatedAuditLog) {
          auditStmt.run(
            entry.id,
            entry.timestamp,
            entry.toolName,
            entry.serverName,
            entry.riskTier,
            entry.decision,
            this.encryptField(entry.argsPreview, 'action_audit_log.args_preview'),
            entry.actionId ?? null,
            entry.reason ?? null,
            entry.blastRadiusWarning ?? null,
            entry.targetPath ?? null,
            entry.commandPreview !== null && entry.commandPreview !== undefined
              ? this.encryptField(entry.commandPreview, 'action_audit_log.command_preview')
              : null,
            entry.diffPreview !== null && entry.diffPreview !== undefined
              ? this.encryptField(entry.diffPreview, 'action_audit_log.diff_preview')
              : null,
          )
        }

        this.sqlite
          .prepare(
            `INSERT INTO initiative_policy_state (
              id, enabled, cooldown_minutes, max_daily_initiatives,
              quiet_hours_start, quiet_hours_end, respect_dnd, modulate_by_habits, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            validatedInitiativePolicy.enabled ? 1 : 0,
            validatedInitiativePolicy.cooldownMinutes,
            validatedInitiativePolicy.maxDailyInitiatives,
            validatedInitiativePolicy.quietHoursStart,
            validatedInitiativePolicy.quietHoursEnd,
            validatedInitiativePolicy.respectDnd ? 1 : 0,
            validatedInitiativePolicy.modulateByHabits ? 1 : 0,
            now,
          )

        const initLogStmt = this.sqlite.prepare(
          `INSERT INTO proactive_initiative_log (
            id, trigger_kind, source_id, source_title,
            notice_prompt, reply_text, decision, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const rec of validatedProactiveLog) {
          initLogStmt.run(
            rec.id,
            rec.triggerKind,
            rec.sourceId ?? null,
            rec.sourceTitle,
            rec.noticePrompt,
            rec.replyText ?? null,
            rec.decision,
            rec.reason,
            rec.createdAt,
          )
        }

        const dreamStmt = this.sqlite.prepare(
          `INSERT INTO dream_reflection_journal (
            id, summary, source_episode_ids_json,
            cross_links_count, trait_evolutions_count, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        for (const entry of validatedDreamEntries) {
          dreamStmt.run(
            entry.id,
            this.encryptField(entry.summary, 'dream_reflection_journal.summary'),
            JSON.stringify(entry.sourceEpisodeIds),
            entry.crossLinksCount,
            entry.traitEvolutionsCount,
            entry.createdAt,
          )
        }

        this.saveAgencyConsentState(
          (snapshot.agencyConsent && typeof snapshot.agencyConsent === 'object'
            ? snapshot.agencyConsent
            : DEFAULT_PERSISTED_AGENCY_CONSENT_STATE) as Partial<PersistedAgencyConsentState>,
        )

        const quickCheckRow = this.sqlite.prepare('PRAGMA quick_check(1)').get()
        const quickCheckResult = quickCheckRow
          ? String(Object.values(quickCheckRow)[0] ?? '').toLowerCase()
          : ''
        if (quickCheckResult !== 'ok') {
          throw new Error(`SQLite quick_check failed after import: ${quickCheckResult}`)
        }

        this.sqlite.exec('COMMIT')
      } catch (err) {
        try {
          this.sqlite.exec('ROLLBACK')
          this.hydrateMemoryFromSqlite()
        } catch {
          // Ignore rollback failure
        }
        throw err
      }

      try {
        this.sqlite.exec('VACUUM')
        this.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        // Ignore if in-memory SQLite
      }

      this.hydrateMemoryFromSqlite()
      return
    }

    // In-memory fallback replacement
    this.memory = new MemoryStorageAdapter()
    for (const ep of validatedEpisodes) this.memory.episodicMemories.set(ep.id, ep)
    for (const fact of validatedFacts) this.memory.semanticFacts.set(fact.id, fact)
    for (const motif of validatedMotifs) this.memory.relationalMotifs.set(motif.id, motif)
    for (const ms of validatedMilestones) this.memory.milestones.set(ms.id, ms)
    for (const habit of validatedHabits) this.memory.userHabits.set(habit.id, habit)
    for (const intent of validatedIntents) this.memory.prospectiveIntents.set(intent.id, intent)
    for (const rec of validatedEvolution) this.memory.personalityEvolution.set(rec.id, rec)
    this.memory.affectiveState = validatedAffective
    this.memory.styleExemplars.clear()
    for (const ex of validatedStyleExemplars) this.memory.styleExemplars.set(ex.id, ex)
    this.memory.goldenExemplars.clear()
    for (const ex of validatedGoldenExemplars) this.memory.goldenExemplars.set(ex.id, ex)
    for (const sess of sessionsById.values()) this.memory.chatSessions.set(sess.id, sess)
    this.memory.chatMessages.push(...validatedMessages)
    this.memory.governancePolicy = { ...validatedGovernance }
    this.memory.actionAuditLog.push(...validatedAuditLog)
    if (snapshot.agencyConsent && typeof snapshot.agencyConsent === 'object') {
      this.saveAgencyConsentState(snapshot.agencyConsent as Partial<PersistedAgencyConsentState>)
    }
    this.memory.initiativePolicy = { ...validatedInitiativePolicy }
    this.memory.proactiveInitiativeLog.push(...validatedProactiveLog)
    for (const entry of validatedDreamEntries) this.memory.dreamJournal.set(entry.id, entry)
  }

  private clearAllDataTablesInTransaction(): void {
    if (!this.sqlite) return
    const tablesInFkOrder = [
      'episodic_fts',
      'chat_messages',
      'chat_sessions',
      'personality_evolution_log',
      'dream_reflection_journal',
      'proactive_initiative_log',
      'action_audit_log',
      'prospective_intents',
      'user_habits',
      'relational_motifs',
      'autobiographical_milestones',
      'semantic_facts',
      'episodic_memories',
      'affective_state',
      'style_exemplars',
      'golden_exemplars',
      'memory_governance_settings',
      'agency_consent_state',
      'initiative_policy_state',
    ]
    for (const table of tablesInFkOrder) {
      this.sqlite.prepare(`DELETE FROM ${table}`).run()
    }
    this.sqlite.exec("INSERT INTO episodic_fts(episodic_fts) VALUES('rebuild');")
  }

  public wipeAll(): void {
    if (this.sqlite) {
      this.sqlite.exec('BEGIN IMMEDIATE')
      try {
        this.clearAllDataTablesInTransaction()
        this.sqlite.exec('COMMIT')
      } catch (err) {
        try {
          this.sqlite.exec('ROLLBACK')
          this.hydrateMemoryFromSqlite()
        } catch {
          // Ignore rollback failure
        }
        throw err
      }
    }

    this.memory = new MemoryStorageAdapter()
    this.seedDefaultsIfEmpty()

    if (this.sqlite) {
      this.checkpointAndVacuumSqlite()
    }
  }

  public close(): void {
    if (this.sqlite) {
      if (this.isPersistent) {
        try {
          this.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);')
        } catch {
          // Ignore checkpoint failure on close
        }
      }
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
