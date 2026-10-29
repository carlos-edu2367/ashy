import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readWithAutoHeal, writeAtomicWithBackup } from '../host/atomic-file'
import { createVoiceIdentityStore, DEFAULT_ASHY_VOICE_MD } from '../host/voice-identity-store'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-voice-store-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('VoiceIdentityStore & atomic-file auto-heal', () => {
  it('bootstraps voice.md with DEFAULT_ASHY_VOICE_MD when missing and rotates .bak1/.bak2/.bak3 on save', () => {
    const dir = makeTempDir()
    const store = createVoiceIdentityStore({ userDataDir: dir })

    const initial = store.read()
    expect(initial.content).toBe(DEFAULT_ASHY_VOICE_MD)
    expect(initial.diagnostics.status).toBe('missing')
    expect(fs.existsSync(path.join(dir, 'voice.md'))).toBe(true)

    store.save('# Voz v1\nHumor afiado v1.')
    store.save('# Voz v2\nHumor afiado v2.')
    store.save('# Voz v3\nHumor afiado v3.')

    expect(fs.existsSync(path.join(dir, 'voice.md.bak1'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'voice.md.bak2'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'voice.md.bak3'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'voice.md.bak1'), 'utf8')).toContain('Voz v2')
  })

  it('auto-heals corrupted/empty voice.md from .bak1 and records healed_from_backup diagnostics', () => {
    const dir = makeTempDir()
    const store = createVoiceIdentityStore({ userDataDir: dir })
    store.save('# Voz Customizada Valida\nAshy no estúdio noturno.')

    // Corrupt primary file with empty/null bytes
    fs.writeFileSync(path.join(dir, 'voice.md'), '   \0\0  ')

    const healed = store.read()
    expect(healed.diagnostics.status).toBe('healed_from_backup')
    expect(healed.diagnostics.healedFrom).toBe('.bak1')
    expect(healed.content).toContain('# Voz Customizada Valida')
    expect(fs.readFileSync(path.join(dir, 'voice.md'), 'utf8')).toContain('# Voz Customizada Valida')
  })

  it('[Adversarial] heals from .bak2 when both primary and .bak1 are corrupted without rotating corrupt primary into backups', () => {
    const dir = makeTempDir()
    const store = createVoiceIdentityStore({ userDataDir: dir })

    store.save('# Voz v1 — Backup 2 Valido\nPersonalidade preservada v1.')
    store.save('# Voz v2 — Backup 1\nPersonalidade preservada v2.')
    store.save('# Voz v3 — Primaria\nPersonalidade preservada v3.')

    // Corrupt primary with non-empty invalid content (<16 chars) and .bak1 with null bytes
    fs.writeFileSync(path.join(dir, 'voice.md'), 'curto-demais')
    fs.writeFileSync(path.join(dir, 'voice.md.bak1'), 'corrompido\0com-null-byte')

    const healed = store.read()
    expect(healed.diagnostics.status).toBe('healed_from_backup')
    expect(healed.diagnostics.healedFrom).toBe('.bak2')
    expect(healed.content).toContain('# Voz v1 — Backup 2 Valido')
    expect(fs.readFileSync(path.join(dir, 'voice.md'), 'utf8')).toContain(
      '# Voz v1 — Backup 2 Valido',
    )

    // Verify a forensic .corrupt.<timestamp> copy was saved
    const files = fs.readdirSync(dir)
    expect(files.some((name) => name.startsWith('voice.md.corrupt.'))).toBe(true)

    // Verify .bak2 still holds the valid v1 content (not overwritten by corrupt .bak1)
    expect(fs.readFileSync(path.join(dir, 'voice.md.bak2'), 'utf8')).toContain(
      '# Voz v1 — Backup 2 Valido',
    )
  })

  it('[Adversarial] resets to DEFAULT_ASHY_VOICE_MD with reset_to_default status when primary and all .bak1/.bak2/.bak3 are corrupted', () => {
    const dir = makeTempDir()
    const store = createVoiceIdentityStore({ userDataDir: dir })

    store.read()
    store.save('# Voz v1\nHumor afiado v1.')
    store.save('# Voz v2\nHumor afiado v2.')
    store.save('# Voz v3\nHumor afiado v3.')

    // Corrupt primary and all 3 backups
    fs.writeFileSync(path.join(dir, 'voice.md'), '')
    fs.writeFileSync(path.join(dir, 'voice.md.bak1'), '   ')
    fs.writeFileSync(path.join(dir, 'voice.md.bak2'), 'curto')
    fs.writeFileSync(path.join(dir, 'voice.md.bak3'), '\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0')

    const recovered = store.read()
    expect(recovered.diagnostics.status).toBe('reset_to_default')
    expect(recovered.content).toBe(DEFAULT_ASHY_VOICE_MD)
    expect(fs.readFileSync(path.join(dir, 'voice.md'), 'utf8')).toBe(DEFAULT_ASHY_VOICE_MD)
  })

  it('[Adversarial] rejects save() with whitespace-only, too-short, or null-byte content and leaves existing file intact', () => {
    const dir = makeTempDir()
    const store = createVoiceIdentityStore({ userDataDir: dir })
    const validContent = '# Voz Intacta\nConteúdo válido com mais de dezesseis caracteres.'
    store.save(validContent)

    expect(() => store.save('   ')).toThrow(/at least 16/i)
    expect(() => store.save('curto')).toThrow(/at least 16/i)
    expect(() => store.save('# Conteudo longo mas com byte nulo \0 embutido')).toThrow(/null bytes/i)

    // Existing file on disk must remain untouched and no .tmp files may leak
    expect(fs.readFileSync(path.join(dir, 'voice.md'), 'utf8')).toBe(validContent)
    const leftoverTmp = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    expect(leftoverTmp).toHaveLength(0)
  })

  it('[Adversarial] reset() restores DEFAULT_ASHY_VOICE_MD while preserving previous custom voice in .bak1, and rapid writes leave zero .tmp files', () => {
    const dir = makeTempDir()
    const store = createVoiceIdentityStore({ userDataDir: dir })
    const customVoice = '# Voz Customizada antes do Reset\nAshy sarcástica na madrugada.'
    store.save(customVoice)

    const afterReset = store.reset()
    expect(afterReset.content).toBe(DEFAULT_ASHY_VOICE_MD)
    expect(afterReset.diagnostics.status).toBe('ok')
    expect(fs.readFileSync(path.join(dir, 'voice.md.bak1'), 'utf8')).toBe(customVoice)

    // Rapid sequential atomic writes + JSON auto-heal verification
    const jsonPath = path.join(dir, 'config.json')
    for (let i = 0; i < 15; i++) {
      writeAtomicWithBackup(jsonPath, JSON.stringify({ step: i }))
    }
    fs.writeFileSync(jsonPath, '{"step": truncated')

    const healedJson = readWithAutoHeal({
      filePath: jsonPath,
      defaultContent: '{"step":0}',
      parseAndValidate: (raw) => JSON.parse(raw) as { step: number },
    })
    expect(healedJson.diagnostics.status).toBe('healed_from_backup')
    expect(healedJson.value.step).toBe(13)

    const leftoverTmp = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    expect(leftoverTmp).toHaveLength(0)
  })
})
