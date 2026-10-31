import fs from 'node:fs'
import path from 'node:path'
import type { ConfigDiagnostics } from '@ashy/shared'

export interface WriteAtomicOptions {
  rotateBackup?: boolean
}

export function removeFileAtomicWithBackups(filePath: string, maxBackups = 3): void {
  const safeMax = Number.isFinite(maxBackups) && maxBackups > 0 ? Math.floor(maxBackups) : 3
  const targets = [filePath, `${filePath}.tmp`]
  for (let i = 1; i <= safeMax; i++) {
    targets.push(`${filePath}.bak${i}`)
  }
  for (const target of targets) {
    try {
      fs.rmSync(target, { force: true })
    } catch {
      // Ignore ENOENT or cleanup errors
    }
  }
}

export function writeAtomicWithBackup(
  filePath: string,
  content: string,
  options?: WriteAtomicOptions,
): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  const rotateBackup = options?.rotateBackup ?? true
  const bak1 = `${filePath}.bak1`
  const bak2 = `${filePath}.bak2`
  const bak3 = `${filePath}.bak3`

  if (rotateBackup && fs.existsSync(filePath)) {
    try {
      const existing = fs.readFileSync(filePath, 'utf8')
      if (!existing.includes('\0') && existing.trim().length > 0) {
        if (fs.existsSync(bak2)) {
          fs.copyFileSync(bak2, bak3)
        }
        if (fs.existsSync(bak1)) {
          fs.copyFileSync(bak1, bak2)
        }
        fs.copyFileSync(filePath, bak1)
      }
    } catch {
      // Ignore backup rotation failure if source cannot be read
    }
  }

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  let fd: number | null = null
  try {
    fd = fs.openSync(tmpPath, 'w', 0o600)
    fs.writeFileSync(fd, content, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmpPath, filePath)
    if (rotateBackup && !fs.existsSync(bak1)) {
      try {
        fs.copyFileSync(filePath, bak1)
      } catch {
        // Ignore initial backup seed failure
      }
    }
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Ignore close error on cleanup
      }
    }
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath)
      }
    } catch {
      // Ignore unlink error on cleanup
    }
    throw err
  }
}

export interface AutoHealReadOptions<T> {
  filePath: string
  defaultContent: string
  parseAndValidate: (raw: string) => T
}

export interface AutoHealReadResult<T> {
  value: T
  rawContent: string
  diagnostics: ConfigDiagnostics
}

export function readWithAutoHeal<T>(options: AutoHealReadOptions<T>): AutoHealReadResult<T> {
  const { filePath, defaultContent, parseAndValidate } = options
  const now = Date.now()

  if (!fs.existsSync(filePath)) {
    writeAtomicWithBackup(filePath, defaultContent, { rotateBackup: false })
    const value = parseAndValidate(defaultContent)
    return {
      value,
      rawContent: defaultContent,
      diagnostics: {
        status: 'missing',
        message: 'Arquivo inicial criado com configuração padrão.',
        updatedAt: now,
      },
    }
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    if (raw.includes('\0') || raw.trim().length === 0) {
      throw new Error('File contains null bytes or is empty')
    }
    const value = parseAndValidate(raw)
    return {
      value,
      rawContent: raw,
      diagnostics: {
        status: 'ok',
        updatedAt: now,
      },
    }
  } catch (primaryErr) {
    // Save corrupt copy for forensics
    try {
      fs.copyFileSync(filePath, `${filePath}.corrupt.${now}`)
    } catch {
      // Ignore forensic copy failure
    }

    for (const suffix of ['.bak1', '.bak2', '.bak3']) {
      const candidatePath = `${filePath}${suffix}`
      if (!fs.existsSync(candidatePath)) continue
      try {
        const candidateRaw = fs.readFileSync(candidatePath, 'utf8')
        if (candidateRaw.includes('\0') || candidateRaw.trim().length === 0) continue
        const value = parseAndValidate(candidateRaw)
        writeAtomicWithBackup(filePath, candidateRaw, { rotateBackup: false })
        return {
          value,
          rawContent: candidateRaw,
          diagnostics: {
            status: 'healed_from_backup',
            healedFrom: suffix,
            message: `Recuperado automaticamente do backup ${suffix}.`,
            updatedAt: now,
          },
        }
      } catch {
        continue
      }
    }

    writeAtomicWithBackup(filePath, defaultContent, { rotateBackup: false })
    const fallbackValue = parseAndValidate(defaultContent)
    return {
      value: fallbackValue,
      rawContent: defaultContent,
      diagnostics: {
        status: 'reset_to_default',
        message: `Arquivo corrompido (${primaryErr instanceof Error ? primaryErr.message : 'erro'}); restaurado para o padrão.`,
        updatedAt: now,
      },
    }
  }
}
