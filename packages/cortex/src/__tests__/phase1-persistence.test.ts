import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCortexDatabase, DEFAULT_GOLDEN_EXEMPLARS } from '../index'

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
    expect(db.getAppliedMigrations().map((m) => m.version)).toEqual([1, 2])

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
})
