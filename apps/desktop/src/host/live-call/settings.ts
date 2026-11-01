import fs from 'node:fs'
import path from 'node:path'
import * as v from 'valibot'
import {
  DEFAULT_LIVE_MODE_SETTINGS,
  SaveLiveModeSettingsInputSchema,
  type LiveModeSettings,
  type SaveLiveModeSettingsInput,
} from '@ashy/shared'
import { writeAtomicWithBackup } from '../atomic-file'

export const LIVE_MODE_SETTINGS_FILE = 'live-mode.json'

export interface LiveModeSettingsStore {
  get(): LiveModeSettings
  /** Deep-merges a validated partial over the current settings, persists atomically, returns the result. */
  save(partial: SaveLiveModeSettingsInput): LiveModeSettings
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep merge for settings sections. `undefined` values in the patch are ignored. Objects that are
 * atomic values in the contract (`llamacpp.endpoint`) are replaced, never merged.
 */
function mergeSettings(base: LiveModeSettings, patch: SaveLiveModeSettingsInput): LiveModeSettings {
  const out = structuredClone(base) as unknown as Record<string, unknown>
  for (const [sectionKey, sectionPatch] of Object.entries(patch)) {
    if (sectionPatch === undefined) continue
    if (!isPlainObject(sectionPatch)) {
      out[sectionKey] = sectionPatch
      continue
    }
    const current = isPlainObject(out[sectionKey]) ? (out[sectionKey] as Record<string, unknown>) : {}
    const next: Record<string, unknown> = { ...current }
    for (const [key, value] of Object.entries(sectionPatch)) {
      if (value === undefined) continue
      next[key] = isPlainObject(value) ? { ...value } : value
    }
    out[sectionKey] = next
  }
  return out as unknown as LiveModeSettings
}

function readPersisted(filePath: string): LiveModeSettings {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return structuredClone(DEFAULT_LIVE_MODE_SETTINGS)
  }
  try {
    const parsed = v.safeParse(SaveLiveModeSettingsInputSchema, JSON.parse(raw))
    if (!parsed.success) {
      return structuredClone(DEFAULT_LIVE_MODE_SETTINGS)
    }
    const loaded = mergeSettings(DEFAULT_LIVE_MODE_SETTINGS, parsed.output)
    // 10.3 hotfix: 6 was the 10.2 default (rotation every 6 turns fed the greeting loop) → 40.
    if (loaded.session.rotateAfterTurns === 6) {
      loaded.session = { ...loaded.session, rotateAfterTurns: DEFAULT_LIVE_MODE_SETTINGS.session.rotateAfterTurns }
    }
    // One-time 10.5 migration: 'llamacpp-realtime' was the only choice in 10.1, never a real user
    // pick. The 2026-11-01 eval showed the hybrid backend is far better with the 2B model
    // (45/49 vs 36/49 clean, 15/15 vs 8/11 on a poisoned store), so move once to hybrid. A later
    // explicit choice of realtime is kept (the marker file prevents re-migrating).
    const marker = `${filePath}.migrated-hybrid-default`
    if (loaded.backend === 'llamacpp-realtime' && !fs.existsSync(marker)) {
      loaded.backend = 'llamacpp-hybrid'
      try {
        fs.writeFileSync(filePath, JSON.stringify(loaded, null, 2))
        fs.writeFileSync(marker, new Date().toISOString())
      } catch {
        // best effort; next load retries
      }
    } else if (!fs.existsSync(marker)) {
      try {
        fs.writeFileSync(marker, new Date().toISOString())
      } catch {
        // ignore
      }
    }
    return loaded
  } catch {
    // Corrupt JSON: keep a forensic copy and fall back to defaults.
    try {
      fs.copyFileSync(filePath, `${filePath}.corrupt.${Date.now()}`)
    } catch {
      // ignore
    }
    return structuredClone(DEFAULT_LIVE_MODE_SETTINGS)
  }
}

export function createLiveModeSettingsStore(opts: { userDataDir: string }): LiveModeSettingsStore {
  const filePath = path.join(opts.userDataDir, LIVE_MODE_SETTINGS_FILE)
  let current = readPersisted(filePath)

  return {
    get() {
      return structuredClone(current)
    },
    save(partial) {
      const parsed = v.safeParse(SaveLiveModeSettingsInputSchema, partial)
      if (!parsed.success) {
        const issue = parsed.issues[0]
        const where = issue?.path?.map((p) => String(p.key)).join('.') ?? ''
        throw new Error(
          `Invalid Live Mode settings${where ? ` at ${where}` : ''}: ${issue?.message ?? 'invalid input'}`,
        )
      }
      const next = mergeSettings(current, parsed.output)
      writeAtomicWithBackup(filePath, `${JSON.stringify(next, null, 2)}\n`, { rotateBackup: false })
      current = next
      try {
        // An explicit save is a user choice: never re-run the one-time hybrid migration over it.
        fs.writeFileSync(`${filePath}.migrated-hybrid-default`, new Date().toISOString())
      } catch {
        // ignore
      }
      return structuredClone(current)
    },
  }
}
