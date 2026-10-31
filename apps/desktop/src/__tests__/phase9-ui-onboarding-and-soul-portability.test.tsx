// @vitest-environment jsdom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { createAshyHostKernel } from '../host/kernel'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const tempDirs: string[] = []
const activeKernels: Array<{ stop(): Promise<void> }> = []
let container: HTMLDivElement | null = null
let root: Root | null = null

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-ui-p9-'))
  tempDirs.push(dir)
  return dir
}

function setNativeInputValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  if (descriptor?.set) {
    descriptor.set.call(element, value)
  } else {
    element.value = value
  }
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function clickElement(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function getByTestId<T extends HTMLElement = HTMLElement>(testId: string): T {
  const el = container?.querySelector(`[data-testid="${testId}"]`) as T | null
  if (!el) {
    throw new Error(`Unable to find an element by: [data-testid="${testId}"]`)
  }
  return el
}

function queryByTestId<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return (container?.querySelector(`[data-testid="${testId}"]`) as T | null) ?? null
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }
  if (container) {
    container.remove()
    container = null
  }
  setAshyHostBridgeForTesting(null)
  while (activeKernels.length > 0) {
    await activeKernels.pop()!.stop()
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Phase 9 Task 6 — Interactive Onboarding Wizard, Soul Portability Panel, 1-Click Factory Reset, Encryption at Rest & Store Bug Fixes', () => {
  it('1. [BUG-ONB1] persists setUnifiedOmniMode, setDirectOmniAudio, and applyOmniModelPreset across store reload & bootstrapFromHost()', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    expect(useAshyStore.getState().unifiedOmniMode).toBe(false)
    expect(useAshyStore.getState().directOmniAudio).toBe(false)

    // Toggle unifiedOmniMode and directOmniAudio via store actions
    await act(async () => {
      useAshyStore.getState().setUnifiedOmniMode(true)
      useAshyStore.getState().setDirectOmniAudio(true)
    })

    // Reset store and re-bootstrap from Host to verify persistence
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()
    expect(useAshyStore.getState().unifiedOmniMode).toBe(true)
    expect(useAshyStore.getState().directOmniAudio).toBe(true)

    // Turn off, then applyOmniModelPreset('lfm3-omni-2b') and verify reload persistence
    await act(async () => {
      useAshyStore.getState().setUnifiedOmniMode(false)
      useAshyStore.getState().setDirectOmniAudio(false)
    })
    await act(async () => {
      useAshyStore.getState().applyOmniModelPreset('lfm3-omni-2b')
    })

    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()
    expect(useAshyStore.getState().unifiedOmniMode).toBe(true)
    expect(useAshyStore.getState().directOmniAudio).toBe(true)
    expect(useAshyStore.getState().providers.activeProviderId).toBe('ollama')
    expect(useAshyStore.getState().activeModelId).toBe('lfm3-omni:2b')
  })

  it('2. [BUG-ONB2] handles setQuietHoursRange("Desativado") and em-dash ranges without activating DND mode, persisting respectDnd across reloads', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    await act(async () => {
      clickElement(getByTestId('tab-agency'))
    })

    expect(useAshyStore.getState().privacyState.dndMode).toBe(false)

    const quietSelect = getByTestId<HTMLSelectElement>('select-quiet-hours')

    // Selecting '23:00 — 07:00' must NOT activate DND immediately
    await act(async () => {
      setNativeInputValue(quietSelect, '23:00 — 07:00')
    })

    expect(useAshyStore.getState().quietHoursRange).toBe('23:00 — 07:00')
    expect(useAshyStore.getState().initiativePolicy.quietHoursStart).toBe('23:00')
    expect(useAshyStore.getState().initiativePolicy.quietHoursEnd).toBe('07:00')
    expect(useAshyStore.getState().initiativePolicy.respectDnd).toBe(true)
    expect(useAshyStore.getState().privacyState.dndMode).toBe(false)

    // Selecting 'Desativado' persists respectDnd: false and keeps quietHoursRange === 'Desativado'
    await act(async () => {
      setNativeInputValue(quietSelect, 'Desativado')
    })

    expect(useAshyStore.getState().quietHoursRange).toBe('Desativado')
    expect(useAshyStore.getState().initiativePolicy.respectDnd).toBe(false)
    expect(useAshyStore.getState().privacyState.dndMode).toBe(false)

    // Reload from Host -> quietHoursRange stays 'Desativado'
    await act(async () => {
      resetAshyStore()
      await useAshyStore.getState().bootstrapFromHost()
    })
    expect(useAshyStore.getState().quietHoursRange).toBe('Desativado')
    expect(useAshyStore.getState().initiativePolicy.respectDnd).toBe(false)
  })

  it('3. completes Interactive Onboarding Wizard in Local Omni mode with privacy permissions, quiet hours, mic/TTS tests, and seeded first greeting', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()

    await act(async () => {
      root!.render(<App />)
    })

    await vi.waitFor(() => {
      expect(getByTestId('first-meeting-wizard')).toBeTruthy()
    })

    // Switch between Cloud Hybrid and Local Omni architecture modes
    await act(async () => {
      clickElement(getByTestId('onboarding-mode-cloud-hybrid'))
    })
    await act(async () => {
      clickElement(getByTestId('onboarding-mode-local-omni'))
    })

    expect(getByTestId<HTMLSelectElement>('onboarding-provider-select').value).toBe('ollama')
    expect(getByTestId<HTMLInputElement>('onboarding-base-url-input').value).toBe(
      'http://127.0.0.1:11434',
    )
    expect(getByTestId<HTMLInputElement>('onboarding-model-id-input').value).toBe('lfm3-omni:2b')
    expect(getByTestId<HTMLSelectElement>('onboarding-reasoning-effort-select').value).toBe('none')

    // Configure Privacy Permissions & Quiet Hours
    await act(async () => {
      setNativeInputValue(getByTestId<HTMLInputElement>('onboarding-user-name-input'), 'Carlos')
      setNativeInputValue(getByTestId<HTMLSelectElement>('onboarding-pronouns-select'), 'ele/dele')
      setNativeInputValue(getByTestId<HTMLSelectElement>('onboarding-eyes-mode-select'), 'window')
      setNativeInputValue(getByTestId<HTMLSelectElement>('onboarding-mic-mode-select'), 'ptt')
      setNativeInputValue(
        getByTestId<HTMLSelectElement>('onboarding-approval-policy-select'),
        'session',
      )
      setNativeInputValue(
        getByTestId<HTMLSelectElement>('onboarding-quiet-hours-select'),
        '00:00 — 06:00',
      )
    })

    // Test Microphone & TTS Voice inside Wizard
    await act(async () => {
      clickElement(getByTestId('onboarding-test-mic-btn'))
    })
    expect(getByTestId('onboarding-mic-test-status').textContent).toMatch(/Microfone/i)

    await act(async () => {
      clickElement(getByTestId('onboarding-test-tts-btn'))
    })
    expect(getByTestId('onboarding-tts-test-status').textContent).toMatch(/Voz/i)

    // Complete Onboarding
    await act(async () => {
      clickElement(getByTestId('onboarding-complete-btn'))
    })

    await vi.waitFor(() => {
      expect(queryByTestId('first-meeting-wizard')).toBeNull()
    })

    const state = useAshyStore.getState()
    expect(state.needsOnboarding).toBe(false)
    expect(state.userProfile.userName).toBe('Carlos')
    expect(state.providers.activeProviderId).toBe('ollama')
    expect(state.activeModelId).toBe('lfm3-omni:2b')
    expect(state.providers.configs.ollama.isOmniModel).toBe(true)
    expect(state.providers.configs.ollama.omniExecutionMode).toBe('native-omni')
    expect(state.providers.configs.ollama.omniVoiceId).toBe('ashy-warm-ptbr')
    expect(state.unifiedOmniMode).toBe(true)
    expect(state.directOmniAudio).toBe(true)
    expect(state.privacyState.eyesMode).toBe('window')
    expect(state.privacyState.micMode).toBe('ptt')
    expect(state.computerActionsPolicy).toBe('session')
    expect(state.initiativePolicy.quietHoursStart).toBe('00:00')
    expect(state.initiativePolicy.quietHoursEnd).toBe('06:00')
    expect(state.quietHoursRange).toBe('00:00 — 06:00')

    // First greeting message must be seeded in chat
    expect(
      state.chatMessages.some(
        (m) => m.role === 'assistant' && m.content.includes('Oi, Carlos!'),
      ),
    ).toBe(true)
  })

  it('4. exports Soul (.ashy-soul) with SHA-256 badge, blocks tampered archive import, executes 1-Click Factory Reset back to FirstMeetingWizard, and restores Soul on valid import', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)

    await kernel.completeOnboarding({
      userName: 'Carlos',
      userPronouns: 'ele/dele',
      seedFirstGreeting: true,
    })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    // Navigate to Configurações (agency)
    await act(async () => {
      clickElement(getByTestId('tab-agency'))
    })

    const portabilityPanel = getByTestId('panel-soul-portability')
    expect(portabilityPanel).toBeTruthy()

    // 1. Export Soul Archive
    await act(async () => {
      clickElement(getByTestId('btn-export-soul'))
    })

    const exportedArchive = useAshyStore.getState().lastExportedSoulArchive
    expect(exportedArchive).not.toBeNull()
    expect(exportedArchive?.magic).toBe('ASHY_SOUL_V1')
    expect(getByTestId('soul-export-checksum-badge').textContent).toContain(
      exportedArchive!.checksumSha256.slice(0, 12),
    )

    const textarea = getByTestId<HTMLTextAreaElement>('soul-archive-json-textarea')
    const validArchiveJson = textarea.value
    expect(validArchiveJson).toContain('"magic": "ASHY_SOUL_V1"')

    // 2. Adversarial: tamper with the JSON in textarea and click Importar Alma -> must fail checksum
    const tamperedObj = JSON.parse(validArchiveJson) as Record<string, unknown>
    ;(tamperedObj.payload as Record<string, unknown>).voiceIdentityMarkdown =
      '# Tampered Voice Identity That Does Not Match Checksum'
    await act(async () => {
      setNativeInputValue(textarea, JSON.stringify(tamperedObj))
    })
    await act(async () => {
      clickElement(getByTestId('btn-import-soul'))
    })

    expect(useAshyStore.getState().soulPortabilityStatus.kind).toBe('error')
    expect(getByTestId('soul-import-status-badge').textContent).toMatch(/SOUL_CHECKSUM_MISMATCH/i)

    // 3. 1-Click Factory Reset: trigger -> cancel -> trigger -> confirm
    await act(async () => {
      clickElement(getByTestId('btn-wipe-all-trigger'))
    })
    expect(getByTestId('btn-wipe-all-confirm')).toBeTruthy()
    expect(getByTestId('btn-wipe-all-cancel')).toBeTruthy()

    await act(async () => {
      clickElement(getByTestId('btn-wipe-all-cancel'))
    })
    expect(queryByTestId('btn-wipe-all-confirm')).toBeNull()

    await act(async () => {
      clickElement(getByTestId('btn-wipe-all-trigger'))
    })
    await act(async () => {
      clickElement(getByTestId('btn-wipe-all-confirm'))
    })

    // After confirm, all data is wiped and FirstMeetingWizard is immediately visible
    await vi.waitFor(() => {
      expect(useAshyStore.getState().needsOnboarding).toBe(true)
      expect(getByTestId('first-meeting-wizard')).toBeTruthy()
    })
    expect(useAshyStore.getState().chatMessages).toHaveLength(0)
    expect(useAshyStore.getState().lastExportedSoulArchive).toBeNull()

    // 4. Restore the exported Soul archive via store or UI and verify onboarding closes and data is back
    await act(async () => {
      setNativeInputValue(getByTestId<HTMLTextAreaElement>('soul-archive-json-textarea'), validArchiveJson)
    })
    await act(async () => {
      clickElement(getByTestId('btn-import-soul'))
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().needsOnboarding).toBe(false)
      expect(queryByTestId('first-meeting-wizard')).toBeNull()
    })
    expect(useAshyStore.getState().userProfile.userName).toBe('Carlos')
    expect(useAshyStore.getState().soulPortabilityStatus.kind).toBe('imported')
    expect(getByTestId('soul-import-status-badge').textContent).toMatch(/restaurada com sucesso/i)
  })

  it('5. renders Encryption at Rest card, Auto-Updater card, and handles updater:status & shortcut:triggered stream events', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    await act(async () => {
      clickElement(getByTestId('tab-agency'))
    })

    // 1. Encryption at Rest Card
    expect(getByTestId('panel-encryption-at-rest')).toBeTruthy()
    const encToggle = getByTestId('toggle-encryption-at-rest')
    expect(encToggle.getAttribute('aria-pressed')).toBe('false')
    expect(getByTestId('encryption-at-rest-status').textContent).toContain(
      'Desativado (Texto Puro Local)',
    )

    await act(async () => {
      clickElement(encToggle)
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().encryptionAtRestStatus.enabled).toBe(true)
    })
    expect(encToggle.getAttribute('aria-pressed')).toBe('true')
    expect(getByTestId('encryption-at-rest-status').textContent).toContain('AES-256-GCM Ativo')
    expect(getByTestId('encryption-at-rest-status').textContent).toContain(
      useAshyStore.getState().encryptionAtRestStatus.keyBackend,
    )

    // 2. Auto-Updater Card & stream event updater:status
    expect(getByTestId('panel-auto-updater')).toBeTruthy()
    await act(async () => {
      clickElement(getByTestId('btn-check-updates'))
    })
    expect(getByTestId('updater-status-badge').textContent).toContain('not-available')

    await act(async () => {
      useAshyStore.getState().handleHostStreamEvent({
        type: 'updater:status',
        state: {
          status: 'available',
          currentVersion: '1.0.0',
          availableVersion: '1.1.0',
          progressPercent: null,
          errorMessage: null,
          checkedAt: new Date().toISOString(),
          autoDownload: false,
        },
      })
    })
    expect(useAshyStore.getState().updaterState.status).toBe('available')
    expect(useAshyStore.getState().updaterState.availableVersion).toBe('1.1.0')
    expect(getByTestId('updater-status-badge').textContent).toContain('available')
    expect(getByTestId('updater-status-badge').textContent).toContain('1.1.0')

    // 3. shortcut:triggered for togglePtt and activatePrivacyShield
    await act(async () => {
      useAshyStore.getState().setMicMode('muted')
      useAshyStore.getState().setEyesMode('window')
      useAshyStore.getState().setDndMode(false)
    })

    await act(async () => {
      useAshyStore.getState().handleHostStreamEvent({
        type: 'shortcut:triggered',
        action: 'togglePtt',
      })
    })
    expect(useAshyStore.getState().privacyState.micMode).toBe('ptt')

    await act(async () => {
      useAshyStore.getState().handleHostStreamEvent({
        type: 'shortcut:triggered',
        action: 'togglePtt',
      })
    })
    expect(useAshyStore.getState().privacyState.micMode).toBe('muted')

    await act(async () => {
      useAshyStore.getState().setMicMode('continuous')
      useAshyStore.getState().handleHostStreamEvent({
        type: 'shortcut:triggered',
        action: 'activatePrivacyShield',
      })
    })
    expect(useAshyStore.getState().privacyState.micMode).toBe('muted')
    expect(useAshyStore.getState().privacyState.eyesMode).toBe('off')
    expect(useAshyStore.getState().privacyState.dndMode).toBe(true)
  })

  it('6. [Adversarial] rejects empty, malformed JSON, and prototype-polluting .ashy-soul payloads and preserves Desativado quiet hours from FirstMeetingWizard', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      root!.render(<App />)
    })

    // Complete wizard with quietHours = "Desativado" via Skip Provider
    await act(async () => {
      setNativeInputValue(getByTestId<HTMLInputElement>('onboarding-user-name-input'), 'Carlos')
      setNativeInputValue(
        getByTestId<HTMLSelectElement>('onboarding-quiet-hours-select'),
        'Desativado',
      )
    })

    await act(async () => {
      clickElement(getByTestId('onboarding-skip-provider-btn'))
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().needsOnboarding).toBe(false)
    })
    expect(useAshyStore.getState().quietHoursRange).toBe('Desativado')
    expect(useAshyStore.getState().initiativePolicy.respectDnd).toBe(false)
    expect(useAshyStore.getState().privacyState.dndMode).toBe(false)

    // Test empty/whitespace import rejection
    let emptyRes!: { ok: boolean; message: string }
    await act(async () => {
      emptyRes = await useAshyStore.getState().importSoulArchive('   ')
    })
    expect(emptyRes.ok).toBe(false)
    expect(useAshyStore.getState().soulPortabilityStatus.kind).toBe('error')

    // Test malformed JSON rejection
    let badJsonRes!: { ok: boolean; message: string }
    await act(async () => {
      badJsonRes = await useAshyStore.getState().importSoulArchive('{not-valid-json')
    })
    expect(badJsonRes.ok).toBe(false)
    expect(useAshyStore.getState().soulPortabilityStatus.kind).toBe('error')

    // Test prototype-polluting payload rejection without polluting Object.prototype
    const protoPayload =
      '{"magic":"ASHY_SOUL_V1","checksumSha256":"0000","__proto__":{"pollutedBySoulImport":true},"payload":{}}'
    let protoRes!: { ok: boolean; message: string }
    await act(async () => {
      protoRes = await useAshyStore.getState().importSoulArchive(protoPayload)
    })
    expect(protoRes.ok).toBe(false)
    expect(({} as Record<string, unknown>).pollutedBySoulImport).toBeUndefined()
  })
})
