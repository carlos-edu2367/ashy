import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  VOICE_UNTRANSCRIBED_PLACEHOLDER,
  createAshyCortex,
  createCortexDatabase,
  type CortexEncryptionCodec,
} from '../index'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-cortex-p10-'))
  tempDirs.push(dir)
  return dir
}

/** Reversible fake codec (base64 + AAD tag) — enough to prove fields are encrypted at rest. */
const fakeCodec: CortexEncryptionCodec = {
  encrypt: (plain, aad) => `enc:v1:${Buffer.from(`${aad}|${plain}`, 'utf8').toString('base64')}`,
  decrypt: (cipher, aad) => {
    const decoded = Buffer.from(cipher.slice('enc:v1:'.length), 'base64').toString('utf8')
    const prefix = `${aad}|`
    if (!decoded.startsWith(prefix)) throw new Error(`AAD mismatch for ${aad}`)
    return decoded.slice(prefix.length)
  },
}

afterEach(() => {
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    } catch {
      // Windows EPERM on a leaked handle
    }
  }
})

describe('Phase 10.1 cortex: v6 voice chat messages', () => {
  it('migrates an existing v5 database to v6 (adds modality/interrupted/meta_json) keeping old rows', () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'ashy.db')
    const db1 = createCortexDatabase({ dbPath })
    db1.createChatSession({ id: 's1', title: 'Old' })
    db1.appendChatMessage({
      id: 'm-old',
      sessionId: 's1',
      role: 'user',
      content: 'oi antigo',
      rawContent: 'oi antigo',
      emotion: 'neutral',
      markersJson: '[]',
      createdAt: 1000,
    })
    db1.close()

    // Downgrade the file to a genuine v5 shape.
    const raw = new DatabaseSync(dbPath)
    raw.exec('ALTER TABLE chat_messages DROP COLUMN meta_json')
    raw.exec('ALTER TABLE chat_messages DROP COLUMN interrupted')
    raw.exec('ALTER TABLE chat_messages DROP COLUMN modality')
    raw.exec('DELETE FROM schema_migrations WHERE version = 6')
    const v5Cols = raw.prepare('PRAGMA table_info(chat_messages)').all().map((c) => String(c.name))
    expect(v5Cols).not.toContain('modality')
    raw.close()

    const db2 = createCortexDatabase({ dbPath })
    expect(db2.getAppliedMigrations().map((m) => m.version)).toContain(6)
    expect(db2.getAppliedMigrations().find((m) => m.version === 6)?.name).toBe(
      'v6_phase10_voice_chat_messages',
    )
    const old = db2.listChatMessages('s1')
    expect(old).toHaveLength(1)
    expect(old[0]!.content).toBe('oi antigo')
    expect(old[0]!.modality).toBeUndefined()
    expect(old[0]!.interrupted).toBeUndefined()
    expect(old[0]!.metaJson).toBeUndefined()
    db2.close()

    const raw2 = new DatabaseSync(dbPath)
    const cols = raw2.prepare('PRAGMA table_info(chat_messages)').all().map((c) => String(c.name))
    expect(cols).toEqual(expect.arrayContaining(['modality', 'interrupted', 'meta_json']))
    const row = raw2.prepare("SELECT modality, interrupted FROM chat_messages WHERE id = 'm-old'").get()
    expect(row).toMatchObject({ modality: 'text', interrupted: 0 })
    raw2.close()
  })

  it('appendVoiceTurn round-trips two voice rows; meta_json is encrypted at rest like content', () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'ashy.db')
    const cortex = createAshyCortex({ filePath: dbPath, encryptionCodec: fakeCodec })
    cortex.setEncryptionAtRest(true)
    cortex.createChatSession({ id: 's1', title: 'Call' })

    const res = cortex.appendVoiceTurn({
      sessionId: 's1',
      userTranscript: 'Me conta uma curiosidade sobre gatos',
      assistantSpokenText: 'Gatos dormem quase',
      assistantFullText: 'Gatos dormem quase dezesseis horas por dia.',
      interrupted: true,
      playedMs: 1200,
      emotion: 'happy',
      backendId: 'llamacpp-realtime',
      metrics: { e2eMs: 1100, asrMs: 280 },
      turnId: 't1',
      nowMs: 5000,
    })
    expect(res.userMessage).toMatchObject({
      id: 'msg-user-voice-t1',
      role: 'user',
      content: 'Me conta uma curiosidade sobre gatos',
      modality: 'voice',
    })
    expect(res.assistantMessage).toMatchObject({
      id: 'msg-assistant-voice-t1',
      role: 'assistant',
      content: 'Gatos dormem quase',
      rawContent: 'Gatos dormem quase',
      modality: 'voice',
      interrupted: true,
      latencyMs: 1100,
    })
    cortex.close()

    // Raw file: text + meta are ciphertext.
    const raw = new DatabaseSync(dbPath)
    const rows = raw
      .prepare('SELECT id, content, meta_json, modality, interrupted FROM chat_messages ORDER BY created_at')
      .all()
    raw.close()
    expect(rows).toHaveLength(2)
    expect(String(rows[1]!.meta_json)).toMatch(/^enc:v1:/)
    expect(String(rows[1]!.content)).toMatch(/^enc:v1:/)
    expect(String(rows[1]!.meta_json)).not.toContain('dezesseis')
    expect(rows[1]).toMatchObject({ modality: 'voice', interrupted: 1 })

    const reopened = createAshyCortex({ filePath: dbPath, encryptionCodec: fakeCodec })
    const msgs = reopened.listChatMessages('s1')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1]!.interrupted).toBe(true)
    expect(msgs[1]!.modality).toBe('voice')
    expect(JSON.parse(msgs[1]!.metaJson!)).toEqual({
      fullText: 'Gatos dormem quase dezesseis horas por dia.',
      playedMs: 1200,
      metrics: { e2eMs: 1100, asrMs: 280 },
      backend: 'llamacpp-realtime',
    })

    // Disabling encryption rewrites meta_json in plaintext.
    reopened.setEncryptionAtRest(false)
    reopened.close()
    const raw2 = new DatabaseSync(dbPath)
    const meta = raw2.prepare("SELECT meta_json FROM chat_messages WHERE id = 'msg-assistant-voice-t1'").get()
    raw2.close()
    expect(String(meta!.meta_json)).toContain('dezesseis')
  })

  it('appendVoiceTurn stores the untranscribed placeholder and skips an unplayed assistant reply', () => {
    const cortex = createAshyCortex()
    cortex.createChatSession({ id: 's1', title: 'Call' })
    const res = cortex.appendVoiceTurn({
      sessionId: 's1',
      userTranscript: '   ',
      assistantSpokenText: '',
      interrupted: true,
      backendId: 'llamacpp-realtime',
    })
    expect(res.userMessage!.content).toBe(VOICE_UNTRANSCRIBED_PLACEHOLDER)
    expect(VOICE_UNTRANSCRIBED_PLACEHOLDER).toBe('🎤 (fala não transcrita)')
    expect(res.assistantMessage).toBeNull()
    expect(cortex.listChatMessages('s1')).toHaveLength(1)
    cortex.close()
  })

  it('Phase 10.3: an injected turn (Ashy spoke on her own) persists only the assistant row', () => {
    const cortex = createAshyCortex()
    cortex.createChatSession({ id: 's1', title: 'Call' })
    const res = cortex.appendVoiceTurn({
      sessionId: 's1',
      userTranscript: '',
      assistantSpokenText: 'Ei, e aquele bug do backend, resolveu?',
      interrupted: false,
      backendId: 'llamacpp-realtime',
      skipUserRow: true,
      injectReason: 'initiative',
    })
    expect(res.userMessage).toBeNull()
    expect(res.assistantMessage!.content).toBe('Ei, e aquele bug do backend, resolveu?')
    expect(JSON.parse(res.assistantMessage!.metaJson!).injectReason).toBe('initiative')
    const rows = cortex.listChatMessages('s1')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.role).toBe('assistant')
    cortex.close()
  })

  it('voice fields survive soul snapshot export/import', () => {
    const a = createAshyCortex()
    a.createChatSession({ id: 's1', title: 'Call' })
    a.appendVoiceTurn({
      sessionId: 's1',
      userTranscript: 'oi',
      assistantSpokenText: 'oi, tudo bem?',
      interrupted: true,
      backendId: 'llamacpp-realtime',
      turnId: 'x',
    })
    const snapshot = a.exportSoulSnapshot()
    a.close()
    const dir = makeTempDir()
    const b = createAshyCortex({ filePath: path.join(dir, 'b.db') })
    b.importSoulSnapshot(snapshot)
    const msgs = b.listChatMessages('s1')
    expect(msgs[1]).toMatchObject({ modality: 'voice', interrupted: true })
    expect(JSON.parse(msgs[1]!.metaJson!).backend).toBe('llamacpp-realtime')
    b.close()
  })

  it('compileTurnPrompt({sideEffects:false}) does not write the mood; default and applyUserTurnAffect do', () => {
    const cortex = createAshyCortex()
    const before = cortex.db.getAffectiveState()
    const nowMs = before.updatedAt + 60_000

    const dry = cortex.compileTurnPrompt(
      { userMessage: 'hahaha que engraçado, adorei!', nowMs },
      { sideEffects: false },
    )
    expect(dry.systemPrompt.length).toBeGreaterThan(0)
    expect(cortex.db.getAffectiveState()).toEqual(before)

    const applied = cortex.applyUserTurnAffect('hahaha que engraçado, adorei!', nowMs)
    expect(applied.updatedAt).toBe(nowMs)
    expect(cortex.db.getAffectiveState().updatedAt).toBe(nowMs)

    cortex.compileTurnPrompt({ userMessage: 'oi', nowMs: nowMs + 1000 })
    expect(cortex.db.getAffectiveState().updatedAt).toBe(nowMs + 1000)
    cortex.close()
  })
})
