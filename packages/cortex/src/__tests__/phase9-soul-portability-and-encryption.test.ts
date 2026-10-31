import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAshyCortex,
  createCortexDatabase,
  DEFAULT_GOLDEN_EXEMPLARS,
  DEFAULT_GOLDEN_STYLE_EXEMPLARS,
  type CortexEncryptionCodec,
} from '../index'
import {
  createElectronSafeStorageProtector,
  createNodeAesSecretProtector,
} from '../../../../apps/desktop/src/host/secret-protector'
import {
  removeFileAtomicWithBackups,
  writeAtomicWithBackup,
} from '../../../../apps/desktop/src/host/atomic-file'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-cortex-p9-'))
  tempDirs.push(dir)
  return dir
}

function makeCodecFromProtector(protector: {
  encryptEnvelope(plainText: string, aad?: string): string
  decryptEnvelope(payload: string, aad?: string): string
}): CortexEncryptionCodec {
  return {
    encrypt: (plainText, aad) => protector.encryptEnvelope(plainText, aad),
    decrypt: (cipherText, aad) => protector.decryptEnvelope(cipherText, aad),
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Ignore Windows EPERM if a failed test left an open handle
    }
  }
})

describe('Phase 9: Boot-Aware Encryption at Rest, SecretProtector DEK Wrapping, Soul Portability & Mutation Epoch Guard', () => {
  it('removeFileAtomicWithBackups deletes primary file, .tmp, and .bak1..maxBackups idempotently', () => {
    const dir = makeTempDir()
    const target = path.join(dir, 'providers.secrets.json')

    writeAtomicWithBackup(target, '{"v":1}')
    writeAtomicWithBackup(target, '{"v":2}')
    writeAtomicWithBackup(target, '{"v":3}')
    writeAtomicWithBackup(target, '{"v":4}')
    fs.writeFileSync(`${target}.tmp`, 'partial')

    expect(fs.existsSync(target)).toBe(true)
    expect(fs.existsSync(`${target}.bak1`)).toBe(true)
    expect(fs.existsSync(`${target}.bak2`)).toBe(true)
    expect(fs.existsSync(`${target}.bak3`)).toBe(true)
    expect(fs.existsSync(`${target}.tmp`)).toBe(true)

    removeFileAtomicWithBackups(target, 3)

    expect(fs.existsSync(target)).toBe(false)
    expect(fs.existsSync(`${target}.bak1`)).toBe(false)
    expect(fs.existsSync(`${target}.bak2`)).toBe(false)
    expect(fs.existsSync(`${target}.bak3`)).toBe(false)
    expect(fs.existsSync(`${target}.tmp`)).toBe(false)

    // Idempotent when files do not exist
    expect(() => removeFileAtomicWithBackups(target, 3)).not.toThrow()
  })

  it('[REDTEAM-2] SecretProtector supports AES-256-GCM envelope encryption with AAD and never writes plaintext .master.key when safeStorage is available', () => {
    const nodeDir = makeTempDir()
    const nodeProtector = createNodeAesSecretProtector(nodeDir)
    expect(nodeProtector.getBackendKind()).toBe('node-aes-master-key')
    expect(fs.existsSync(path.join(nodeDir, '.master.key'))).toBe(true)

    const envCipher = nodeProtector.encryptEnvelope('segredo-da-ashy', 'episodic_memories.title')
    expect(envCipher.startsWith('enc:v1:')).toBe(true)
    expect(envCipher).not.toContain('segredo-da-ashy')
    expect(nodeProtector.decryptEnvelope(envCipher, 'episodic_memories.title')).toBe(
      'segredo-da-ashy',
    )

    // Plaintext pass-through for unencrypted strings
    expect(nodeProtector.decryptEnvelope('plaintext-legacy-row', 'episodic_memories.title')).toBe(
      'plaintext-legacy-row',
    )

    // Mismatched AAD must fail authentication
    expect(() =>
      nodeProtector.decryptEnvelope(envCipher, 'episodic_memories.content'),
    ).toThrow()

    // Now test Electron safeStorage protector when encryption is available:
    // Must create .master.key.dpapi and MUST NOT leave a plaintext .master.key on disk!
    const safeDir = makeTempDir()
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) =>
        Buffer.from(`dpapi:${Buffer.from(plain, 'utf8').toString('hex')}`, 'utf8'),
      decryptString: (encrypted: Buffer) => {
        const str = encrypted.toString('utf8')
        if (!str.startsWith('dpapi:')) throw new Error('Invalid DPAPI payload')
        return Buffer.from(str.slice('dpapi:'.length), 'hex').toString('utf8')
      },
    }

    const safeProtector1 = createElectronSafeStorageProtector(fakeSafeStorage, safeDir)
    expect(safeProtector1.getBackendKind()).toBe('electron-safe-storage')
    expect(fs.existsSync(path.join(safeDir, '.master.key.dpapi'))).toBe(true)
    expect(fs.existsSync(path.join(safeDir, '.master.key'))).toBe(false)

    const safeCipher = safeProtector1.encryptEnvelope('memória-protegida', 'semantic_facts.object')
    expect(safeCipher.startsWith('enc:v1:')).toBe(true)

    // Re-opening in a new instance unwraps .master.key.dpapi and decrypts cleanly
    const safeProtector2 = createElectronSafeStorageProtector(fakeSafeStorage, safeDir)
    expect(safeProtector2.decryptEnvelope(safeCipher, 'semantic_facts.object')).toBe(
      'memória-protegida',
    )
    expect(fs.existsSync(path.join(safeDir, '.master.key'))).toBe(false)

    // Legacy migration: if a plaintext .master.key existed previously, createElectronSafeStorageProtector
    // wraps it into .master.key.dpapi, deletes .master.key, and preserves decryption of existing data
    const migrateDir = makeTempDir()
    const legacyNodeProtector = createNodeAesSecretProtector(migrateDir)
    const legacyEnvelope = legacyNodeProtector.encryptEnvelope(
      'dado-antigo',
      'user_habits.description',
    )
    const legacySecret = `aes:${legacyNodeProtector.encrypt('sk-legacy-api-key')}`
    expect(fs.existsSync(path.join(migrateDir, '.master.key'))).toBe(true)

    const migratedSafeProtector = createElectronSafeStorageProtector(fakeSafeStorage, migrateDir)
    expect(fs.existsSync(path.join(migrateDir, '.master.key'))).toBe(false)
    expect(fs.existsSync(path.join(migrateDir, '.master.key.dpapi'))).toBe(true)
    expect(
      migratedSafeProtector.decryptEnvelope(legacyEnvelope, 'user_habits.description'),
    ).toBe('dado-antigo')
    expect(migratedSafeProtector.decrypt(legacySecret)).toBe('sk-legacy-api-key')
  })

  it('[REDTEAM-7] encrypts all 10 sensitive table groups on disk, clears episodic_fts, purges WAL/pages via VACUUM, and boots encrypted across restarts', () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'ashy.db')
    const protector = createNodeAesSecretProtector(dir)
    const codec = makeCodecFromProtector(protector)

    const cortex1 = createAshyCortex({ filePath: dbPath, encryptionCodec: codec })
    expect(cortex1.isEncryptionAtRestEnabled()).toBe(false)

    const markers = {
      epTitle: 'SECRET_EP_TITLE_ALPHA_901',
      epSummary: 'SECRET_EP_SUMMARY_BETA_902',
      epContent: 'SECRET_EP_CONTENT_GAMMA_903',
      factObject: 'SECRET_FACT_OBJ_DELTA_904',
      motifText: 'SECRET_MOTIF_EPSILON_905',
      motifOrigin: 'SECRET_MOTIF_ORIGIN_ZETA_906',
      msTitle: 'SECRET_MS_TITLE_ETA_907',
      msNarrative: 'SECRET_MS_NARRATIVE_THETA_908',
      habitDesc: 'SECRET_HABIT_DESC_IOTA_909',
      intentTopic: 'SECRET_INTENT_TOPIC_KAPPA_910',
      intentCue: 'SECRET_INTENT_CUE_LAMBDA_911',
      sessTitle: 'SECRET_SESSION_TITLE_MU_912',
      msgContent: 'SECRET_MSG_CONTENT_NU_913',
      msgRaw: 'SECRET_MSG_RAW_XI_914',
      auditArgs: 'SECRET_AUDIT_ARGS_OMICRON_915',
      auditCmd: 'SECRET_AUDIT_CMD_PI_916',
      auditDiff: 'SECRET_AUDIT_DIFF_RHO_917',
      dreamSummary: 'SECRET_DREAM_SUMMARY_SIGMA_918',
    }

    cortex1.db.upsertEpisodicMemory({
      id: 'ep-sec-1',
      title: markers.epTitle,
      summary: markers.epSummary,
      content: markers.epContent,
      createdAt: 1730000000000,
      lastReviewedAt: 1730000000000,
      stability: 5.0,
      difficulty: 3.0,
      surprise: 0.8,
      isFlashbulb: true,
      tags: ['security', 'encryption'],
    })

    cortex1.db.upsertSemanticFact({
      id: 'fact-sec-1',
      category: 'identity',
      subject: 'user',
      predicate: 'secret_codename',
      object: markers.factObject,
      confidence: 0.99,
      sourceEpisodeIds: ['ep-sec-1'],
      validFrom: 1730000000000,
      invalidAt: null,
    })

    cortex1.db.upsertRelationalMotif({
      id: 'motif-sec-1',
      motif: markers.motifText,
      originSummary: markers.motifOrigin,
      originEpisodeId: 'ep-sec-1',
      triggerCues: ['encryption'],
      stage: 'inside_joke',
      timesUsed: 2,
      lastUsedAt: 1730000000000,
      cooldownHours: 12,
      createdAt: 1730000000000,
    })

    cortex1.db.upsertMilestone({
      id: 'ms-sec-1',
      title: markers.msTitle,
      narrative: markers.msNarrative,
      category: 'first_meeting',
      episodeId: 'ep-sec-1',
      roomTrophyId: 'trophy-first-boot-mug',
      createdAt: 1730000000000,
    })

    cortex1.db.upsertUserHabit({
      id: 'habit-sec-1',
      patternKey: 'late_night_crypto',
      description: markers.habitDesc,
      confidence: 0.9,
      observationCount: 4,
      updatedAt: 1730000000000,
      sourceEpisodeId: 'ep-sec-1',
    })

    cortex1.db.upsertProspectiveIntent({
      id: 'intent-sec-1',
      topic: markers.intentTopic,
      contextCue: markers.intentCue,
      dueAt: 1730086400000,
      status: 'pending',
      createdAt: 1730000000000,
      sourceEpisodeId: 'ep-sec-1',
    })

    cortex1.createChatSession({
      id: 'sess-sec-1',
      title: markers.sessTitle,
      startedAt: 1730000000000,
    })

    cortex1.appendChatMessage({
      id: 'msg-sec-1',
      sessionId: 'sess-sec-1',
      role: 'user',
      content: markers.msgContent,
      rawContent: markers.msgRaw,
      emotion: 'neutral',
      markersJson: '[]',
      createdAt: 1730000001000,
    })

    cortex1.db.insertActionAuditLog({
      id: 'audit-sec-1',
      timestamp: 1730000002000,
      toolName: 'write_project_note',
      serverName: 'workspace-notes',
      riskTier: 'staged-confirm',
      decision: 'approved',
      argsPreview: markers.auditArgs,
      commandPreview: markers.auditCmd,
      diffPreview: markers.auditDiff,
    })

    cortex1.db.insertDreamJournalEntry({
      id: 'dream-sec-1',
      summary: markers.dreamSummary,
      sourceEpisodeIds: ['ep-sec-1'],
      crossLinksCount: 1,
      traitEvolutionsCount: 0,
      createdAt: 1730000003000,
    })

    const epochBefore = cortex1.getMutationEpoch()
    cortex1.setEncryptionAtRest(true)
    expect(cortex1.isEncryptionAtRestEnabled()).toBe(true)
    expect(cortex1.getMutationEpoch()).toBe(epochBefore + 1)

    // Write a new message while encryption is already enabled to verify live writes are also encrypted
    cortex1.appendChatMessage({
      id: 'msg-sec-2',
      sessionId: 'sess-sec-1',
      role: 'assistant',
      content: 'SECRET_LIVE_WRITE_OMEGA_999',
      rawContent: 'SECRET_LIVE_RAW_OMEGA_999',
      emotion: 'happy',
      markersJson: '[]',
      createdAt: 1730000004000,
    })

    cortex1.close()

    // 1. Inspect raw SQLite columns directly via DatabaseSync
    const rawSql = new DatabaseSync(dbPath)
    const encStateRow = rawSql
      .prepare('SELECT enabled, key_check_cipher FROM cortex_encryption_state WHERE singleton_id = 1')
      .get() as { enabled: number; key_check_cipher: string } | undefined
    expect(encStateRow?.enabled).toBe(1)
    expect(String(encStateRow?.key_check_cipher ?? '').startsWith('enc:v1:')).toBe(true)

    const ftsCount = rawSql.prepare('SELECT COUNT(*) as cnt FROM episodic_fts').get() as {
      cnt: number
    }
    expect(Number(ftsCount.cnt)).toBe(0)

    const epRow = rawSql.prepare('SELECT title, summary, content FROM episodic_memories WHERE id = ?').get('ep-sec-1') as Record<string, string>
    expect(String(epRow.title).startsWith('enc:v1:')).toBe(true)
    expect(String(epRow.summary).startsWith('enc:v1:')).toBe(true)
    expect(String(epRow.content).startsWith('enc:v1:')).toBe(true)

    const factRow = rawSql.prepare('SELECT object FROM semantic_facts WHERE id = ?').get('fact-sec-1') as Record<string, string>
    expect(String(factRow.object).startsWith('enc:v1:')).toBe(true)

    const motifRow = rawSql.prepare('SELECT motif, origin_summary FROM relational_motifs WHERE id = ?').get('motif-sec-1') as Record<string, string>
    expect(String(motifRow.motif).startsWith('enc:v1:')).toBe(true)
    expect(String(motifRow.origin_summary).startsWith('enc:v1:')).toBe(true)

    const msRow = rawSql.prepare('SELECT title, narrative FROM autobiographical_milestones WHERE id = ?').get('ms-sec-1') as Record<string, string>
    expect(String(msRow.title).startsWith('enc:v1:')).toBe(true)
    expect(String(msRow.narrative).startsWith('enc:v1:')).toBe(true)

    const habitRow = rawSql.prepare('SELECT description FROM user_habits WHERE id = ?').get('habit-sec-1') as Record<string, string>
    expect(String(habitRow.description).startsWith('enc:v1:')).toBe(true)

    const intentRow = rawSql.prepare('SELECT topic, context_cue FROM prospective_intents WHERE id = ?').get('intent-sec-1') as Record<string, string>
    expect(String(intentRow.topic).startsWith('enc:v1:')).toBe(true)
    expect(String(intentRow.context_cue).startsWith('enc:v1:')).toBe(true)

    const sessRow = rawSql.prepare('SELECT title, last_message_preview FROM chat_sessions WHERE id = ?').get('sess-sec-1') as Record<string, string>
    expect(String(sessRow.title).startsWith('enc:v1:')).toBe(true)
    expect(String(sessRow.last_message_preview).startsWith('enc:v1:')).toBe(true)

    const msgRows = rawSql.prepare('SELECT content, raw_content FROM chat_messages ORDER BY created_at ASC').all() as Array<Record<string, string>>
    expect(msgRows).toHaveLength(2)
    for (const m of msgRows) {
      expect(String(m.content).startsWith('enc:v1:')).toBe(true)
      expect(String(m.raw_content).startsWith('enc:v1:')).toBe(true)
    }

    const auditRow = rawSql.prepare('SELECT args_preview, command_preview, diff_preview FROM action_audit_log WHERE id = ?').get('audit-sec-1') as Record<string, string>
    expect(String(auditRow.args_preview).startsWith('enc:v1:')).toBe(true)
    expect(String(auditRow.command_preview).startsWith('enc:v1:')).toBe(true)
    expect(String(auditRow.diff_preview).startsWith('enc:v1:')).toBe(true)

    const dreamRow = rawSql.prepare('SELECT summary FROM dream_reflection_journal WHERE id = ?').get('dream-sec-1') as Record<string, string>
    expect(String(dreamRow.summary).startsWith('enc:v1:')).toBe(true)
    rawSql.close()

    // 2. Verify raw bytes on disk do NOT contain any plaintext secret marker after VACUUM + checkpoint
    const rawDbBytes = fs.readFileSync(dbPath, 'utf8')
    const rawWalBytes = fs.existsSync(`${dbPath}-wal`)
      ? fs.readFileSync(`${dbPath}-wal`, 'utf8')
      : ''
    for (const secretValue of Object.values(markers)) {
      expect(rawDbBytes).not.toContain(secretValue)
      expect(rawWalBytes).not.toContain(secretValue)
    }
    expect(rawDbBytes).not.toContain('SECRET_LIVE_WRITE_OMEGA_999')

    // 3. Adversarial boot without encryptionCodec must throw CORTEX_ENCRYPTION_CODEC_REQUIRED
    expect(() => createCortexDatabase({ filePath: dbPath })).toThrow(
      /CORTEX_ENCRYPTION_CODEC_REQUIRED/,
    )

    // 4. Adversarial boot with wrong encryption key must fail key verification without destroying the DB
    const wrongProtector = createNodeAesSecretProtector(makeTempDir())
    expect(() =>
      createCortexDatabase({
        filePath: dbPath,
        encryptionCodec: makeCodecFromProtector(wrongProtector),
      }),
    ).toThrow()

    // 5. Boot with valid encryptionCodec automatically detects encryptionAtRestEnabled = true and decrypts everything
    const cortex2 = createAshyCortex({ filePath: dbPath, encryptionCodec: codec })
    expect(cortex2.isEncryptionAtRestEnabled()).toBe(true)
    expect(cortex2.db.getEpisodicMemory('ep-sec-1')?.title).toBe(markers.epTitle)
    expect(cortex2.db.getEpisodicMemory('ep-sec-1')?.summary).toBe(markers.epSummary)
    expect(cortex2.db.getEpisodicMemory('ep-sec-1')?.content).toBe(markers.epContent)
    expect(cortex2.db.listSemanticFacts()[0]?.object).toBe(markers.factObject)
    expect(cortex2.db.listRelationalMotifs()[0]?.motif).toBe(markers.motifText)
    expect(cortex2.db.listRelationalMotifs()[0]?.originSummary).toBe(markers.motifOrigin)
    expect(cortex2.db.listMilestones()[0]?.title).toBe(markers.msTitle)
    expect(cortex2.db.listMilestones()[0]?.narrative).toBe(markers.msNarrative)
    expect(cortex2.db.listUserHabits()[0]?.description).toBe(markers.habitDesc)
    expect(cortex2.db.listProspectiveIntents()[0]?.topic).toBe(markers.intentTopic)
    expect(cortex2.db.listProspectiveIntents()[0]?.contextCue).toBe(markers.intentCue)
    expect(cortex2.getChatSession('sess-sec-1')?.title).toBe(markers.sessTitle)
    expect(cortex2.getChatSession('sess-sec-1')?.lastMessagePreview).toBe(
      'SECRET_LIVE_WRITE_OMEGA_999',
    )
    expect(cortex2.listChatMessages('sess-sec-1').map((m) => m.content)).toEqual([
      markers.msgContent,
      'SECRET_LIVE_WRITE_OMEGA_999',
    ])
    expect(cortex2.db.listActionAuditLog()[0]?.argsPreview).toBe(markers.auditArgs)
    expect(cortex2.db.listActionAuditLog()[0]?.commandPreview).toBe(markers.auditCmd)
    expect(cortex2.db.listActionAuditLog()[0]?.diffPreview).toBe(markers.auditDiff)
    expect(cortex2.listDreamJournalEntries()[0]?.summary).toBe(markers.dreamSummary)

    // Hybrid search works when encrypted (without FTS5)
    const recallHits = cortex2.recall(markers.epTitle, 1730000010000, 5)
    expect(recallHits).toHaveLength(1)
    expect(recallHits[0]?.memory.id).toBe('ep-sec-1')

    // 6. Disabling encryption at rest decrypts all columns on disk and rebuilds episodic_fts
    cortex2.setEncryptionAtRest(false)
    expect(cortex2.isEncryptionAtRestEnabled()).toBe(false)
    cortex2.close()

    const rawSqlAfterDisable = new DatabaseSync(dbPath)
    const ftsCountAfterDisable = rawSqlAfterDisable
      .prepare('SELECT COUNT(*) as cnt FROM episodic_fts')
      .get() as { cnt: number }
    expect(Number(ftsCountAfterDisable.cnt)).toBe(1)
    const epRowAfterDisable = rawSqlAfterDisable
      .prepare('SELECT title FROM episodic_memories WHERE id = ?')
      .get('ep-sec-1') as { title: string }
    expect(epRowAfterDisable.title).toBe(markers.epTitle)
    rawSqlAfterDisable.close()
  })

  it('exports decrypted Soul snapshot (redacting MCP env secrets), wipes all user data + VACUUMs, imports Soul with orphan session synthesis, and rolls back on NaN/Infinity', () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'ashy-soul.db')
    const protector = createNodeAesSecretProtector(dir)
    const codec = makeCodecFromProtector(protector)

    const cortex = createAshyCortex({ filePath: dbPath, encryptionCodec: codec })
    cortex.setEncryptionAtRest(true)

    cortex.db.upsertEpisodicMemory({
      id: 'ep-port-1',
      title: 'Noite de arquitetura Soul',
      summary: 'Planejamos o arquivo .ashy-soul com SHA-256',
      content: 'Conversa sobre portabilidade de memória e criptografia.',
      createdAt: 1730100000000,
      lastReviewedAt: 1730100000000,
      stability: 6.0,
      difficulty: 3.2,
      surprise: 0.75,
      isFlashbulb: true,
      tags: ['soul', 'portability'],
    })

    cortex.db.upsertSemanticFact({
      id: 'fact-port-1',
      category: 'identity',
      subject: 'user',
      predicate: 'name',
      object: 'Carlos',
      confidence: 0.99,
      sourceEpisodeIds: ['ep-port-1'],
      validFrom: 1730100000000,
      invalidAt: null,
    })

    cortex.db.saveAffectiveState(
      { valence: 0.45, arousal: 0.25, playfulness: 0.3 },
      {
        witSarcasm: 0.8,
        chaosEnergy: 0.72,
        warmthAffection: 0.75,
        intellectualCuriosity: 0.88,
        proactivity: 0.65,
      },
      1730100005000,
    )

    cortex.db.saveAgencyConsentState({
      eyesMode: 'window',
      micMode: 'ptt',
      dndMode: false,
      approvalPolicy: 'ask',
      externalMcpServers: [
        {
          id: 'mcp-secret-srv',
          name: 'github-mcp',
          description: 'GitHub MCP',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          enabled: true,
          ...({ env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_super_secret_token_123' } } as Record<
            string,
            unknown
          >),
        },
      ],
    })

    cortex.createChatSession({
      id: 'sess-port-1',
      title: 'Sessão Portável',
      startedAt: 1730100000000,
    })
    cortex.appendChatMessage({
      id: 'msg-port-1',
      sessionId: 'sess-port-1',
      role: 'user',
      content: 'Vamos exportar minha alma digital.',
      rawContent: 'Vamos exportar minha alma digital.',
      emotion: 'excited',
      markersJson: '[]',
      createdAt: 1730100001000,
    })

    const snapshot = cortex.exportSoulSnapshot()
    expect(snapshot.episodicMemories).toHaveLength(1)
    expect(snapshot.episodicMemories[0].title).toBe('Noite de arquitetura Soul')
    expect(snapshot.semanticFacts).toHaveLength(1)
    expect(snapshot.semanticFacts[0].object).toBe('Carlos')
    expect(snapshot.affectiveState?.mood.valence).toBeCloseTo(0.45, 4)

    // Verify MCP server env secrets are redacted in exported snapshot
    const exportedServer = snapshot.agencyConsent?.externalMcpServers?.[0] as
      | { env?: Record<string, string> }
      | undefined
    expect(JSON.stringify(snapshot)).not.toContain('ghp_super_secret_token_123')
    if (exportedServer?.env) {
      expect(exportedServer.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('***REDACTED***')
    }

    // Wipe all data
    const epochBeforeWipe = cortex.getMutationEpoch()
    cortex.wipeAll()
    expect(cortex.getMutationEpoch()).toBe(epochBeforeWipe + 1)
    expect(cortex.db.listEpisodicMemories()).toHaveLength(0)
    expect(cortex.db.listSemanticFacts()).toHaveLength(0)
    expect(cortex.listChatSessions()).toHaveLength(0)
    expect(cortex.db.listStyleExemplars()).toHaveLength(DEFAULT_GOLDEN_STYLE_EXEMPLARS.length)
    expect(cortex.db.listGoldenExemplars()).toHaveLength(DEFAULT_GOLDEN_EXEMPLARS.length)

    // Inject an orphan message (sessionId not in chatSessions) into snapshot before import
    const snapshotWithOrphan = structuredClone(snapshot)
    snapshotWithOrphan.chatMessages.push({
      id: 'msg-orphan-99',
      sessionId: 'sess-orphan-missing',
      role: 'user',
      content: 'Mensagem de uma sessão órfã',
      rawContent: 'Mensagem de uma sessão órfã',
      emotion: 'neutral',
      markersJson: '[]',
      createdAt: 1730100099000,
    })

    const epochBeforeImport = cortex.getMutationEpoch()
    cortex.importSoulSnapshot(snapshotWithOrphan)
    expect(cortex.getMutationEpoch()).toBe(epochBeforeImport + 1)

    expect(cortex.db.listEpisodicMemories()).toHaveLength(1)
    expect(cortex.db.getEpisodicMemory('ep-port-1')?.title).toBe('Noite de arquitetura Soul')
    expect(cortex.db.listSemanticFacts()[0]?.object).toBe('Carlos')
    expect(cortex.db.getAffectiveState().mood.valence).toBeCloseTo(0.45, 4)
    expect(cortex.getChatSession('sess-orphan-missing')).not.toBeNull()
    expect(cortex.listChatMessages('sess-orphan-missing')).toHaveLength(1)

    // Adversarial: importing a snapshot with NaN in FSRS stability or PAD mood must throw and roll back
    const corruptedSnapshot = structuredClone(snapshot)
    corruptedSnapshot.episodicMemories[0].stability = Number.NaN
    expect(() => cortex.importSoulSnapshot(corruptedSnapshot)).toThrow()

    const corruptedMoodSnapshot = structuredClone(snapshot)
    corruptedMoodSnapshot.affectiveState = {
      mood: { valence: Number.POSITIVE_INFINITY, arousal: 0, playfulness: 0 },
      traits: cortex.db.getAffectiveState().traits,
      updatedAt: 1730100100000,
    }
    expect(() => cortex.importSoulSnapshot(corruptedMoodSnapshot)).toThrow()

    // Pre-existing state must remain intact after failed imports
    expect(cortex.db.getEpisodicMemory('ep-port-1')?.stability).toBe(6.0)
    expect(cortex.db.getAffectiveState().mood.valence).toBeCloseTo(0.45, 4)

    cortex.close()
  })

  it('[REDTEAM-6] aborts in-flight consolidateSessionMemories and runDreamReflectionCycle writes when mutationEpoch increments during wipeAll', async () => {
    const cortex = createAshyCortex({ inMemory: true })

    cortex.createChatSession({
      id: 'sess-race-1',
      title: 'Sessão Concorrente',
      startedAt: 1730200000000,
    })
    cortex.appendChatMessage({
      id: 'm-race-1',
      sessionId: 'sess-race-1',
      role: 'user',
      content: 'Meu nome é Carlos e estou testando concorrência no banco SQLite.',
      rawContent: 'Meu nome é Carlos e estou testando concorrência no banco SQLite.',
      emotion: 'neutral',
      markersJson: '[]',
      createdAt: 1730200001000,
    })
    cortex.appendChatMessage({
      id: 'm-race-2',
      sessionId: 'sess-race-1',
      role: 'assistant',
      content: 'Excelente teste adversarial contra race conditions!',
      rawContent: 'Excelente teste adversarial contra race conditions!',
      emotion: 'excited',
      markersJson: '[]',
      createdAt: 1730200002000,
    })

    // Seed two reflectable permanent episodes so runDreamReflectionCycle enters its LLM reflection branch
    cortex.db.upsertEpisodicMemory({
      id: 'ep-perm-1',
      title: 'Arquitetura SQLite de madrugada',
      summary: 'Sessão de código de madrugada no banco SQLite',
      content: 'Implementamos FTS5 e migrações na madrugada.',
      createdAt: 1730100000000,
      lastReviewedAt: 1730100000000,
      stability: 5,
      difficulty: 3,
      surprise: 0.8,
      isFlashbulb: true,
      tags: ['late_night_debug', 'sqlite'],
    })
    cortex.db.upsertEpisodicMemory({
      id: 'ep-perm-2',
      title: 'Refatoração do SQLite na madrugada',
      summary: 'Outra madrugada ajustando queries SQLite',
      content: 'Otimizamos o ranker híbrido no SQLite.',
      createdAt: 1730186400000,
      lastReviewedAt: 1730186400000,
      stability: 5,
      difficulty: 3,
      surprise: 0.8,
      isFlashbulb: true,
      tags: ['late_night_debug', 'sqlite'],
    })

    let resolveConsolidationLlm!: (val: string) => void
    const consolidationLlmPromise = new Promise<string>((resolve) => {
      resolveConsolidationLlm = resolve
    })

    let resolveDreamLlm!: (val: string) => void
    const dreamLlmPromise = new Promise<string>((resolve) => {
      resolveDreamLlm = resolve
    })

    const consolidationTask = cortex.consolidateSessionMemories({
      sessionId: 'sess-race-1',
      nowMs: 1730200010000,
      force: true,
      generateJsonFn: () => consolidationLlmPromise,
    })

    const dreamTask = cortex.runDreamReflectionCycle({
      nowMs: 1730200020000,
      force: true,
      forceConsolidate: false,
      generateJsonFn: () => dreamLlmPromise,
    })

    // Trigger wipeAll while both async LLM calls are in-flight!
    cortex.wipeAll()
    expect(cortex.db.listEpisodicMemories()).toHaveLength(0)
    expect(cortex.listDreamJournalEntries()).toHaveLength(0)

    // Now resolve the slow LLM promises with valid payloads
    resolveConsolidationLlm(
      JSON.stringify({
        episode: {
          title: 'Episódio Fantasma Pós-Wipe',
          summary: 'Carlos testou concorrência no banco SQLite.',
          tags: ['sqlite', 'race'],
          surprise: 0.8,
          isFlashbulb: true,
        },
        candidateFacts: [
          {
            category: 'identity',
            subject: 'user',
            predicate: 'name',
            object: 'Carlos',
            confidence: 0.95,
            evidenceQuote: 'Meu nome é Carlos',
          },
        ],
        candidateMotifs: [],
        candidateIntents: [],
        candidateHabits: [],
      }),
    )

    resolveDreamLlm(
      JSON.stringify({
        summary: 'Diário de sonhos fantasma que não deveria ser salvo após wipeAll.',
      }),
    )

    const [consolidationResult, dreamResult] = await Promise.all([consolidationTask, dreamTask])
    expect(consolidationResult.consolidated).toBe(false)
    expect(consolidationResult.episode).toBeNull()
    expect(dreamResult.appliedEvolutions).toHaveLength(0)

    // Database must remain 100% clean — zero ghost records written!
    expect(cortex.db.listEpisodicMemories()).toHaveLength(0)
    expect(cortex.db.listSemanticFacts()).toHaveLength(0)
    expect(cortex.db.listMilestones()).toHaveLength(0)
    expect(cortex.db.listPersonalityEvolution()).toHaveLength(0)
    expect(cortex.listDreamJournalEntries()).toHaveLength(0)

    cortex.close()
  })
})
