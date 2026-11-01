import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LIVE_MODE_SETTINGS } from '@ashy/shared'
import { createLiveModeSettingsStore } from '../host/live-call/settings'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-live-mig-'))
}

describe('Phase 10.5 — one-time migration to the hybrid backend', () => {
  it('fresh installs default to llamacpp-hybrid', () => {
    expect(DEFAULT_LIVE_MODE_SETTINGS.backend).toBe('llamacpp-hybrid')
    expect(createLiveModeSettingsStore({ userDataDir: tmp() }).get().backend).toBe('llamacpp-hybrid')
  })

  it('moves a 10.1-era saved llamacpp-realtime once, and persists it', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'live-mode.json'), JSON.stringify({ backend: 'llamacpp-realtime', session: { rotateAfterTurns: 6 } }))
    const store = createLiveModeSettingsStore({ userDataDir: dir })
    expect(store.get().backend).toBe('llamacpp-hybrid')
    expect(store.get().session.rotateAfterTurns).toBe(40)
    // reload: stays hybrid (persisted) and does not migrate again
    expect(createLiveModeSettingsStore({ userDataDir: dir }).get().backend).toBe('llamacpp-hybrid')
  })

  it('keeps an explicit later choice of llamacpp-realtime', () => {
    const dir = tmp()
    const store = createLiveModeSettingsStore({ userDataDir: dir })
    store.save({ backend: 'llamacpp-realtime' })
    expect(createLiveModeSettingsStore({ userDataDir: dir }).get().backend).toBe('llamacpp-realtime')
  })
})
