import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { embedTextSync128 } from '@ashy/llm'
import { DEFAULT_PERSISTED_AGENCY_CONSENT_STATE } from '@ashy/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createCortexDatabase,
  DEFAULT_GOLDEN_EXEMPLARS,
  rankEpisodicMemories,
} from '../index'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-cortex-p1-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('@ashy/cortex Phase 1 persistence & Migration v2', () => {
  it('provides 20 curated PT-BR Golden Dialogue Exemplars across all stages and seriousness_gate', () => {
    expect(DEFAULT_GOLDEN_EXEMPLARS).toHaveLength(20)
    const byCategory = DEFAULT_GOLDEN_EXEMPLARS.reduce<Record<string, number>>((acc, item) => {
      acc[item.stage] = (acc[item.stage] ?? 0) + 1
      return acc
    }, {})
    expect(byCategory.stranger).toBe(4)
    expect(byCategory.acquaintance).toBe(4)
    expect(byCategory.close_friend).toBe(5)
    expect(byCategory.companion).toBe(4)
    expect(byCategory.seriousness_gate).toBe(3)

    for (const exemplar of DEFAULT_GOLDEN_EXEMPLARS) {
      expect(exemplar.ashyResponse).toMatch(/^<\|ACT\s+\{/)
      expect(exemplar.userUtterance.trim().length).toBeGreaterThan(5)
    }
  })

  it('applies Migration v2 (schema_migrations, chat_sessions, chat_messages) and persists chat turns across restarts', () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'ashy.db')

    const db1 = createCortexDatabase({ filePath: dbPath })
    expect(db1.isPersistent).toBe(true)
    expect(db1.getAppliedMigrations().some((m) => m.version === 2)).toBe(true)

    db1.seedDefaultGoldenExemplars()
    expect(db1.listGoldenExemplars()).toHaveLength(20)

    const session = db1.createChatSession({
      id: 'session-main',
      title: 'Primeiro Encontro',
      startedAt: 1730000000000,
    })
    expect(session.id).toBe('session-main')

    db1.appendChatMessage({
      id: 'msg-1',
      sessionId: 'session-main',
      role: 'user',
      content: 'Oi Ashy, acordada até agora?',
      rawContent: 'Oi Ashy, acordada até agora?',
      emotion: 'neutral',
      markersJson: '[]',
      createdAt: 1730000001000,
    })

    db1.appendChatMessage({
      id: 'msg-2',
      sessionId: 'session-main',
      role: 'assistant',
      content: 'Alguém precisa vigiar seus commits de madrugada.',
      rawContent:
        '<|ACT {"emotion":"tease","intensity":0.8}|>Alguém precisa vigiar seus commits de madrugada.',
      emotion: 'tease',
      markersJson: '[{"type":"act","emotion":"tease","intensity":0.8}]',
      providerId: 'openrouter',
      modelId: 'anthropic/claude-3.7-sonnet',
      latencyMs: 420,
      createdAt: 1730000002000,
    })

    db1.close()

    const db2 = createCortexDatabase({ filePath: dbPath })
    const sessions = db2.listChatSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.turnCount).toBe(1)
    expect(sessions[0]?.lastMessagePreview).toContain('Alguém precisa vigiar')

    const messages = db2.listChatMessages('session-main', 80)
    expect(messages).toHaveLength(2)
    expect(messages[1]?.emotion).toBe('tease')
    expect(messages[1]?.providerId).toBe('openrouter')
    db2.close()
  })

  it('quarantines a corrupted SQLite file to .corrupt.<timestamp> and recovers with a clean WAL database', () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'ashy.db')
    fs.writeFileSync(dbPath, 'NOT_A_VALID_SQLITE_HEADER_CORRUPTED_BYTES_1234567890')

    const db = createCortexDatabase({ filePath: dbPath })
    expect(db.isPersistent).toBe(true)

    const files = fs.readdirSync(dir)
    expect(files.some((f) => f.startsWith('ashy.db.corrupt.'))).toBe(true)
    db.close()
  })

  it('quarantines a SQLite file with a valid 16-byte header but corrupted B-tree pages and cleans up stale -wal/-shm files', () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'ashy.db')

    // Write valid 16-byte SQLite header followed by garbage page bytes so PRAGMA quick_check(1) fails
    const fakeHeaderAndCorruptPages = Buffer.alloc(4096, 0xff)
    Buffer.from('SQLite format 3\0', 'utf8').copy(fakeHeaderAndCorruptPages, 0)
    fs.writeFileSync(dbPath, fakeHeaderAndCorruptPages)
    fs.writeFileSync(`${dbPath}-wal`, 'STALE_CORRUPT_WAL_DATA')
    fs.writeFileSync(`${dbPath}-shm`, 'STALE_CORRUPT_SHM_DATA')

    const db = createCortexDatabase({ filePath: dbPath })
    expect(db.isPersistent).toBe(true)
    expect(db.getAppliedMigrations().map((m) => m.version)).toEqual([1, 2, 3, 4, 5])

    const files = fs.readdirSync(dir)
    expect(files.some((f) => f.startsWith('ashy.db.corrupt.'))).toBe(true)
    db.close()
  })

  it('enforces foreign keys, cascades message deletion when session is deleted, and preserves messages on session upsert', () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'ashy.db')
    const db = createCortexDatabase({ filePath: dbPath })

    // Foreign key enforcement: appending to a non-existent session must throw
    expect(() =>
      db.appendChatMessage({
        id: 'orphan-msg',
        sessionId: 'non-existent-session',
        role: 'user',
        content: 'Mensagem órfã',
        rawContent: 'Mensagem órfã',
        emotion: 'neutral',
        markersJson: '[]',
        createdAt: 1730000010000,
      }),
    ).toThrow()

    db.createChatSession({
      id: 'sess-cascade',
      title: 'Sessão Temporária',
      startedAt: 1730000010000,
    })

    db.appendChatMessage({
      id: 'msg-c1',
      sessionId: 'sess-cascade',
      role: 'user',
      content: 'Primeira mensagem',
      rawContent: 'Primeira mensagem',
      emotion: 'neutral',
      markersJson: '[]',
      createdAt: 1730000011000,
    })

    db.appendChatMessage({
      id: 'msg-c2',
      sessionId: 'sess-cascade',
      role: 'assistant',
      content: 'Resposta da Ashy',
      rawContent: 'Resposta da Ashy',
      emotion: 'happy',
      markersJson: '[]',
      createdAt: 1730000012000,
    })

    // Re-appending same assistant message ID must be idempotent on turnCount
    db.appendChatMessage({
      id: 'msg-c2',
      sessionId: 'sess-cascade',
      role: 'assistant',
      content: 'Resposta da Ashy editada',
      rawContent: 'Resposta da Ashy editada',
      emotion: 'happy',
      markersJson: '[]',
      createdAt: 1730000012000,
    })
    expect(db.getChatSession('sess-cascade')?.turnCount).toBe(1)

    // Calling createChatSession with existing id updates title WITHOUT cascade-deleting messages
    const updatedSession = db.createChatSession({
      id: 'sess-cascade',
      title: 'Sessão Renomeada',
      updatedAt: 1730000015000,
    })
    expect(updatedSession.title).toBe('Sessão Renomeada')
    expect(updatedSession.turnCount).toBe(1)
    expect(db.listChatMessages('sess-cascade')).toHaveLength(2)

    // Deleting the session cascades to chat_messages
    db.deleteChatSession('sess-cascade')
    expect(db.getChatSession('sess-cascade')).toBeNull()
    expect(db.listChatMessages('sess-cascade')).toHaveLength(0)

    db.close()
  })

  it('returns the most recent N messages in chronological (ASC) order and keeps seedDefaultGoldenExemplars idempotent', () => {
    for (const forceMemoryFallback of [false, true]) {
      const db = createCortexDatabase(
        forceMemoryFallback ? { forceMemoryFallback: true } : { inMemory: true },
      )

      // Idempotent seeding and stage filtering
      db.seedDefaultGoldenExemplars()
      db.seedDefaultGoldenExemplars()
      expect(db.listGoldenExemplars()).toHaveLength(20)
      expect(db.listGoldenExemplars('seriousness_gate')).toHaveLength(3)
      expect(db.listGoldenExemplars('close_friend')).toHaveLength(5)

      db.createChatSession({
        id: 'sess-window',
        title: 'Histórico Longo',
        startedAt: 1730000100000,
      })

      for (let i = 1; i <= 10; i++) {
        db.appendChatMessage({
          id: `m-${i}`,
          sessionId: 'sess-window',
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `Mensagem #${i}`,
          rawContent: `Mensagem #${i}`,
          emotion: 'neutral',
          markersJson: '[]',
          createdAt: 1730000100000 + i * 1000,
        })
      }

      const lastFour = db.listChatMessages('sess-window', 4)
      expect(lastFour.map((m) => m.id)).toEqual(['m-7', 'm-8', 'm-9', 'm-10'])
      expect(db.listChatMessages('sess-window', 0)).toEqual([])
      expect(db.getChatSession('sess-window')?.turnCount).toBe(5)

      db.close()
    }
  })

  it('applies Migration v3 (v3_phase2_self_writing_memory), auto-embeds 128-D vectors, handles dimension mismatches, enforces quarantine governance, and tracks unconsolidated messages across restarts', () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'ashy-v3.db')

    for (const forceMemoryFallback of [false, true]) {
      const db1 = createCortexDatabase(
        forceMemoryFallback ? { forceMemoryFallback: true } : { filePath: dbPath },
      )

      const migrations = db1.getAppliedMigrations()
      expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5])
      expect(migrations.find((m) => m.version === 3)?.name).toBe('v3_phase2_self_writing_memory')
      expect(db1.listSqlTables()).toContain('memory_governance_settings')

      // 1. Auto-embedding (128-D) on upsert when embedding is omitted
      const epApproved = db1.upsertEpisodicMemory({
        id: 'ep-cursed-backend',
        title: 'Fantasma no backend',
        summary: 'Esse código tá tão amaldiçoado que deve ter um fantasma no backend.',
        content: 'Eu já tava pensando em chamar um exorcista de JavaScript.',
        createdAt: 1730001000000,
        lastReviewedAt: 1730001000000,
        stability: 5.0,
        difficulty: 3.5,
        surprise: 0.8,
        isFlashbulb: false,
        tags: ['backend', 'javascript'],
      })
      expect(epApproved.embedding).toHaveLength(128)
      expect(epApproved.approvalStatus).toBe('approved')

      const epPending = db1.upsertEpisodicMemory({
        id: 'ep-pending-quarantine',
        title: 'Segredo em quarentena',
        summary: 'Episódio pendente de revisão sobre exorcista de JavaScript.',
        content: 'Fantasma no backend aguardando aprovação.',
        createdAt: 1730001005000,
        lastReviewedAt: 1730001005000,
        stability: 5.0,
        difficulty: 3.5,
        surprise: 0.7,
        isFlashbulb: false,
        tags: ['quarantine'],
        approvalStatus: 'pending_review',
      })
      expect(epPending.approvalStatus).toBe('pending_review')

      // Hybrid search auto-computes 128-D query embedding and excludes pending_review by default
      const semanticHitsDefault = db1.searchEpisodicMemoriesHybrid(
        'Fui mexer numa biblioteca antiga e deu erro.',
        undefined,
        { nowMs: 1730001010000 },
      )
      expect(semanticHitsDefault.map((r) => r.memory.id)).toEqual(['ep-cursed-backend'])
      expect(semanticHitsDefault[0]!.vectorSimilarity).toBeGreaterThan(0.25)

      const semanticHitsWithPending = db1.searchEpisodicMemoriesHybrid(
        'Fui mexer numa biblioteca antiga e deu erro.',
        undefined,
        { nowMs: 1730001010000, includePendingReview: true },
      )
      expect(semanticHitsWithPending.map((r) => r.memory.id)).toContain('ep-pending-quarantine')

      // Dimension mismatch guard in rankEpisodicMemories (4-D legacy episode vs 128-D query)
      const legacy4dEpisode = db1.upsertEpisodicMemory({
        id: 'ep-legacy-4d',
        title: 'Bug fantasma na biblioteca antiga',
        summary: 'Erro bizarro no código legado do backend',
        content: 'Resolvemos o bug amaldiçoado no pacote antigo.',
        createdAt: 1730001002000,
        lastReviewedAt: 1730001002000,
        stability: 4.0,
        difficulty: 4.0,
        surprise: 0.6,
        isFlashbulb: false,
        tags: ['legacy', 'bug'],
        embedding: [0, 0, 0, 1],
      })
      const queryVec128 = embedTextSync128('Lembra daquele bug? Consegui resolver.')
      const rankedMismatch = rankEpisodicMemories([legacy4dEpisode], {
        text: 'Lembra daquele bug? Consegui resolver.',
        embedding: queryVec128,
        nowMs: 1730001010000,
      })
      expect(rankedMismatch[0]!.vectorSimilarity).toBeGreaterThan(0.25)

      // 2. Semantic Facts & Relational Motifs auto-embed 128-D and support quarantine + conflict invalidation on approve
      const oldFact = db1.upsertSemanticFact({
        id: 'fact-editor-vscode',
        category: 'preference',
        subject: 'user',
        predicate: 'favorite_editor',
        object: 'VS Code',
        confidence: 0.9,
        sourceEpisodeIds: ['ep-cursed-backend'],
        validFrom: 1730001000000,
        invalidAt: null,
      })
      expect(oldFact.embedding).toHaveLength(128)
      expect(oldFact.approvalStatus).toBe('approved')

      const pendingFact = db1.upsertSemanticFact({
        id: 'fact-editor-neovim-pending',
        category: 'preference',
        subject: 'user',
        predicate: 'favorite_editor',
        object: 'Neovim',
        confidence: 0.95,
        sourceEpisodeIds: ['ep-cursed-backend'],
        validFrom: 1730002000000,
        invalidAt: null,
        approvalStatus: 'pending_review',
      })
      expect(pendingFact.approvalStatus).toBe('pending_review')

      // Raw listSemanticFacts() includes pending_review for UI inspection, but active queries exclude it
      expect(db1.listSemanticFacts().map((f) => f.id)).toContain('fact-editor-neovim-pending')
      expect(db1.listSemanticFacts({ activeOnly: true }).map((f) => f.id)).toEqual([
        'fact-editor-vscode',
      ])
      expect(db1.listActiveSemanticFacts().map((f) => f.id)).toEqual(['fact-editor-vscode'])

      const motif = db1.upsertRelationalMotif({
        id: 'motif-ghost',
        motif: 'fantasma no backend',
        originSummary: 'Código amaldiçoado no backend',
        originEpisodeId: 'ep-cursed-backend',
        triggerCues: ['fantasma no backend'],
        stage: 'seed',
        timesUsed: 0,
        lastUsedAt: null,
        cooldownHours: 24,
        createdAt: 1730001000000,
        approvalStatus: 'pending_review',
      })
      expect(motif.embedding).toHaveLength(128)
      expect(motif.approvalStatus).toBe('pending_review')
      expect(db1.approveMemoryItem('joke', 'motif-ghost')).toBe(true)
      expect(db1.getRelationalMotif('motif-ghost')?.approvalStatus).toBe('approved')

      // 3. Governance policy persistence
      expect(db1.getMemoryGovernancePolicy()).toEqual({
        facts: false,
        episodes: false,
        jokes: false,
        habits: false,
        intents: false,
      })
      const updatedPolicy = db1.setMemoryGovernancePolicy('facts', true)
      expect(updatedPolicy.facts).toBe(true)

      // 4. Habits, Intents, Milestones deletion & sourceEpisodeId persistence
      db1.upsertUserHabit({
        id: 'habit-night',
        patternKey: 'late_night_coding',
        description: 'Programa de madrugada',
        confidence: 0.9,
        observationCount: 3,
        updatedAt: 1730001000000,
        sourceEpisodeId: 'ep-cursed-backend',
        approvalStatus: 'pending_review',
      })
      db1.upsertProspectiveIntent({
        id: 'intent-deploy',
        topic: 'Deploy de sexta-feira',
        contextCue: 'deploy, produção',
        dueAt: 1730080000000,
        status: 'pending',
        createdAt: 1730001000000,
        sourceEpisodeId: 'ep-cursed-backend',
        approvalStatus: 'pending_review',
      })
      db1.upsertMilestone({
        id: 'ms-temp',
        title: 'Marco temporário',
        narrative: 'Teste de deleção',
        category: 'first_meeting',
        episodeId: 'ep-cursed-backend',
        createdAt: 1730001000000,
      })

      // 5. Unconsolidated chat messages tracking
      db1.createChatSession({
        id: 'sess-consolidation',
        title: 'Sessão de Consolidação',
        startedAt: 1730001000000,
      })
      db1.appendChatMessage({
        id: 'cmsg-1',
        sessionId: 'sess-consolidation',
        role: 'user',
        content: 'Turno 1 usuário',
        rawContent: 'Turno 1 usuário',
        emotion: 'neutral',
        markersJson: '[]',
        createdAt: 1730001001000,
      })
      db1.appendChatMessage({
        id: 'cmsg-2',
        sessionId: 'sess-consolidation',
        role: 'assistant',
        content: 'Turno 1 Ashy',
        rawContent: 'Turno 1 Ashy',
        emotion: 'happy',
        markersJson: '[]',
        createdAt: 1730001002000,
      })
      db1.appendChatMessage({
        id: 'cmsg-3',
        sessionId: 'sess-consolidation',
        role: 'user',
        content: 'Turno 2 ainda não consolidado',
        rawContent: 'Turno 2 ainda não consolidado',
        emotion: 'neutral',
        markersJson: '[]',
        createdAt: 1730001003000,
      })

      expect(db1.listUnconsolidatedChatMessages('sess-consolidation').map((m) => m.id)).toEqual([
        'cmsg-1',
        'cmsg-2',
        'cmsg-3',
      ])
      db1.markChatMessagesConsolidated(['cmsg-1', 'cmsg-2'], 'ep-cursed-backend')
      expect(db1.listUnconsolidatedChatMessages('sess-consolidation').map((m) => m.id)).toEqual([
        'cmsg-3',
      ])

      // Approve pending fact -> activates it AND invalidates older active conflicting fact ('VS Code')
      const approvedOk = db1.approveMemoryItem('fact', 'fact-editor-neovim-pending', 1730003000000)
      expect(approvedOk).toBe(true)
      const activeFactsAfterApproval = db1.listActiveSemanticFacts()
      expect(activeFactsAfterApproval.map((f) => f.id)).toEqual(['fact-editor-neovim-pending'])
      expect(activeFactsAfterApproval[0]?.object).toBe('Neovim')
      const invalidatedOldFact = db1
        .listSemanticFacts()
        .find((f) => f.id === 'fact-editor-vscode')
      expect(invalidatedOldFact?.invalidAt).toBe(1730003000000)

      // Approve habit, intent, episode
      expect(db1.approveMemoryItem('habit', 'habit-night')).toBe(true)
      expect(db1.approveMemoryItem('intent', 'intent-deploy')).toBe(true)
      expect(db1.approveMemoryItem('episode', 'ep-pending-quarantine')).toBe(true)

      if (!forceMemoryFallback) {
        db1.close()
        const db2 = createCortexDatabase({ filePath: dbPath })
        expect(db2.getMemoryGovernancePolicy().facts).toBe(true)
        expect(db2.listUnconsolidatedChatMessages('sess-consolidation').map((m) => m.id)).toEqual([
          'cmsg-3',
        ])
        const allMsgs = db2.listChatMessages('sess-consolidation')
        expect(allMsgs.find((m) => m.id === 'cmsg-1')?.consolidatedEpisodeId).toBe(
          'ep-cursed-backend',
        )
        expect(allMsgs.find((m) => m.id === 'cmsg-3')?.consolidatedEpisodeId).toBeNull()

        expect(db2.listUserHabits()[0]?.sourceEpisodeId).toBe('ep-cursed-backend')
        expect(db2.listUserHabits()[0]?.approvalStatus).toBe('approved')
        expect(db2.listProspectiveIntents()[0]?.sourceEpisodeId).toBe('ep-cursed-backend')
        expect(db2.listProspectiveIntents()[0]?.approvalStatus).toBe('approved')

        expect(db2.deleteUserHabit('habit-night')).toBe(true)
        expect(db2.listUserHabits()).toHaveLength(0)
        expect(db2.deleteProspectiveIntent('intent-deploy')).toBe(true)
        expect(db2.listProspectiveIntents()).toHaveLength(0)
        expect(db2.deleteMilestone('ms-temp')).toBe(true)
        expect(db2.listMilestones()).toHaveLength(0)

        db2.close()
      } else {
        expect(db1.deleteUserHabit('habit-night')).toBe(true)
        expect(db1.listUserHabits()).toHaveLength(0)
        expect(db1.deleteProspectiveIntent('intent-deploy')).toBe(true)
        expect(db1.listProspectiveIntents()).toHaveLength(0)
        expect(db1.deleteMilestone('ms-temp')).toBe(true)
        expect(db1.listMilestones()).toHaveLength(0)
        db1.close()
      }
    }
  })

  it('applies Migration v4 (v4_phase7_agency_audit_and_consent) and persists action_audit_log and agency_consent_state (including auto_accept / dont-ask mode) across restarts', () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'ashy-v4.db')

    for (const forceMemoryFallback of [false, true]) {
      const db1 = createCortexDatabase(
        forceMemoryFallback ? { forceMemoryFallback: true } : { filePath: dbPath },
      )

      const migrations = db1.getAppliedMigrations()
      expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5])
      expect(migrations.find((m) => m.version === 4)?.name).toBe(
        'v4_phase7_agency_audit_and_consent',
      )
      expect(db1.listSqlTables()).toContain('action_audit_log')
      expect(db1.listSqlTables()).toContain('agency_consent_state')

      const initialConsent = db1.getAgencyConsentState()
      expect(initialConsent.eyesMode).toBe(DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.eyesMode)
      expect(initialConsent.micMode).toBe(DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.micMode)
      expect(initialConsent.dndMode).toBe(DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.dndMode)
      expect(initialConsent.approvalPolicy).toBe(
        DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.approvalPolicy,
      )
      expect(initialConsent.eyesMode).toBe('off')
      expect(initialConsent.micMode).toBe('muted')
      expect(initialConsent.dndMode).toBe(false)
      expect(initialConsent.approvalPolicy).toBe('ask')

      const savedConsent = db1.saveAgencyConsentState({
        eyesMode: 'window',
        approvalPolicy: 'auto_accept',
        allowedPaths: ['/workspace/ashy', '/workspace/notes'],
        allowedWindowTitles: ['VS Code', 'Cursor'],
        toolRiskOverrides: { read_workspace_file: 'staged-confirm' },
        externalMcpServers: [
          {
            id: 'ext-1',
            name: 'local-git',
            description: 'Git MCP',
            transport: 'http',
            url: 'http://127.0.0.1:4100/mcp',
            args: [],
            enabled: true,
          },
        ],
      })
      expect(savedConsent.eyesMode).toBe('window')
      expect(savedConsent.approvalPolicy).toBe('auto_accept')
      expect(savedConsent.allowedPaths).toEqual(['/workspace/ashy', '/workspace/notes'])
      expect(savedConsent.allowedWindowTitles).toEqual(['VS Code', 'Cursor'])
      expect(savedConsent.toolRiskOverrides).toEqual({
        read_workspace_file: 'staged-confirm',
      })
      expect(savedConsent.externalMcpServers).toHaveLength(1)
      expect(savedConsent.externalMcpServers[0]?.name).toBe('local-git')
      expect(savedConsent.updatedAt).toBeGreaterThan(0)

      db1.insertActionAuditLog({
        id: 'audit-1',
        timestamp: 1730010001000,
        toolName: 'read_workspace_file',
        serverName: 'workspace-fs',
        riskTier: 'read-safe',
        decision: 'allowed',
        argsPreview: '{"path":"/workspace/ashy/README.md"}',
        targetPath: '/workspace/ashy/README.md',
        reason: 'Allowed read-safe within allowed path',
      })

      db1.insertActionAuditLog({
        id: 'audit-2',
        timestamp: 1730010002000,
        toolName: 'write_project_note',
        serverName: 'workspace-notes',
        riskTier: 'staged-confirm',
        decision: 'approved',
        argsPreview: '{"path":"/workspace/ashy/notes/todo.md","content":"# Todo"}',
        actionId: 'pending-act-1',
        reason: 'Auto-approved by user policy (auto_accept)',
        blastRadiusWarning: 'Overwrites existing project note file.',
        targetPath: '/workspace/ashy/notes/todo.md',
        commandPreview: 'write /workspace/ashy/notes/todo.md',
        diffPreview: '--- a/todo.md\n+++ b/todo.md\n+# Todo',
      })

      const logsBeforeRestart = db1.listActionAuditLog(50)
      expect(logsBeforeRestart).toHaveLength(2)
      expect(logsBeforeRestart[0]?.id).toBe('audit-2')
      expect(logsBeforeRestart[0]?.targetPath).toBe('/workspace/ashy/notes/todo.md')
      expect(logsBeforeRestart[0]?.commandPreview).toBe('write /workspace/ashy/notes/todo.md')
      expect(logsBeforeRestart[0]?.diffPreview).toContain('+# Todo')
      expect(logsBeforeRestart[0]?.blastRadiusWarning).toBe(
        'Overwrites existing project note file.',
      )
      expect(logsBeforeRestart[0]?.reason).toBe('Auto-approved by user policy (auto_accept)')
      expect(logsBeforeRestart[0]?.actionId).toBe('pending-act-1')
      expect(logsBeforeRestart[1]?.id).toBe('audit-1')

      if (!forceMemoryFallback) {
        db1.close()
        const db2 = createCortexDatabase({ filePath: dbPath })
        const reloadedConsent = db2.getAgencyConsentState()
        expect(reloadedConsent.eyesMode).toBe('window')
        expect(reloadedConsent.approvalPolicy).toBe('auto_accept')
        expect(reloadedConsent.allowedPaths).toEqual(['/workspace/ashy', '/workspace/notes'])
        expect(reloadedConsent.allowedWindowTitles).toEqual(['VS Code', 'Cursor'])
        expect(reloadedConsent.toolRiskOverrides).toEqual({
          read_workspace_file: 'staged-confirm',
        })
        expect(reloadedConsent.externalMcpServers).toEqual([
          {
            id: 'ext-1',
            name: 'local-git',
            description: 'Git MCP',
            transport: 'http',
            url: 'http://127.0.0.1:4100/mcp',
            args: [],
            enabled: true,
          },
        ])

        const reloadedLogs = db2.listActionAuditLog(50)
        expect(reloadedLogs).toHaveLength(2)
        expect(reloadedLogs.map((l) => l.id)).toEqual(['audit-2', 'audit-1'])
        expect(reloadedLogs[0]?.diffPreview).toContain('+# Todo')
        expect(reloadedLogs[0]?.blastRadiusWarning).toBe(
          'Overwrites existing project note file.',
        )
        expect(reloadedLogs[0]?.actionId).toBe('pending-act-1')

        db2.clearActionAuditLog()
        expect(db2.listActionAuditLog(50)).toHaveLength(0)
        db2.close()
      } else {
        db1.clearActionAuditLog()
        expect(db1.listActionAuditLog(50)).toHaveLength(0)
        db1.close()
      }
    }
  })

  it('applies Migration v5 (v5_phase8_initiative_and_reflection_journal) and persists initiative policy, initiative log, and dream journal across restarts', () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'ashy-v5.db')

    for (const forceMemoryFallback of [false, true]) {
      const db1 = createCortexDatabase(
        forceMemoryFallback ? { forceMemoryFallback: true } : { filePath: dbPath },
      )

      const migrations = db1.getAppliedMigrations()
      expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5])
      expect(migrations.find((m) => m.version === 5)?.name).toBe(
        'v5_phase8_initiative_and_reflection_journal',
      )
      expect(db1.listSqlTables()).toContain('initiative_policy_state')
      expect(db1.listSqlTables()).toContain('proactive_initiative_log')
      expect(db1.listSqlTables()).toContain('dream_reflection_journal')

      expect(db1.getInitiativePolicy()).toEqual({
        enabled: true,
        cooldownMinutes: 120,
        maxDailyInitiatives: 3,
        quietHoursStart: '23:00',
        quietHoursEnd: '08:00',
        respectDnd: true,
        modulateByHabits: true,
      })

      const savedPolicy = db1.saveInitiativePolicy({
        enabled: false,
        cooldownMinutes: 180,
        maxDailyInitiatives: 2,
        quietHoursStart: '22:30',
        quietHoursEnd: '07:30',
      })
      expect(savedPolicy.enabled).toBe(false)
      expect(savedPolicy.cooldownMinutes).toBe(180)
      expect(savedPolicy.maxDailyInitiatives).toBe(2)
      expect(savedPolicy.quietHoursStart).toBe('22:30')
      expect(savedPolicy.quietHoursEnd).toBe('07:30')

      db1.insertProactiveInitiativeLog({
        id: 'init-log-1',
        triggerKind: 'prospective_intent',
        sourceId: 'intent-1',
        sourceTitle: 'Revisar deploy M4',
        noticePrompt: '[Proactive Notice]',
        replyText: 'E aí, como foi o deploy?',
        decision: 'spoken',
        reason: 'Ancorada em intenção pendente.',
        createdAt: 1730020001000,
      })

      db1.insertDreamJournalEntry({
        id: 'dream-j-1',
        summary: 'Reflexão sobre sessões de madrugada e testes SQLite.',
        sourceEpisodeIds: ['ep-1', 'ep-2'],
        crossLinksCount: 1,
        traitEvolutionsCount: 1,
        createdAt: 1730020002000,
      })

      if (!forceMemoryFallback) {
        db1.close()
        const db2 = createCortexDatabase({ filePath: dbPath })
        expect(db2.getInitiativePolicy()).toEqual(savedPolicy)
        expect(db2.listProactiveInitiativeLog(10)).toHaveLength(1)
        expect(db2.listProactiveInitiativeLog(10)[0]?.id).toBe('init-log-1')
        expect(db2.listDreamJournalEntries(10)).toHaveLength(1)
        expect(db2.listDreamJournalEntries(10)[0]?.sourceEpisodeIds).toEqual(['ep-1', 'ep-2'])
        db2.close()
      } else {
        expect(db1.getInitiativePolicy()).toEqual(savedPolicy)
        expect(db1.listProactiveInitiativeLog(10)).toHaveLength(1)
        expect(db1.listDreamJournalEntries(10)).toHaveLength(1)
        db1.close()
      }
    }
  })
})
