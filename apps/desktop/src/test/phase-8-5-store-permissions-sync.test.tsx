// @vitest-environment jsdom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../App'
import { createAshyHostKernel } from '../host/kernel'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'

// Enable React 19 act environment
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const tempDirs: string[] = []
const activeKernels: Array<{ stop(): Promise<void> }> = []
let container: HTMLDivElement | null = null
let root: Root | null = null
let originalSearch = ''

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-ui-p85-'))
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

beforeEach(() => {
  originalSearch = window.location.search
  window.history.replaceState({}, '', '/')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  window.history.replaceState({}, '', originalSearch || '/')
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

describe('Phase 8.5 (Front 2) — Store Hydration from Host AgencySnapshot & Full Permission Persistence', () => {
  it('1. bootstrapFromHost() hydrates snapshot.agency (computerActionsPolicy, eyesMode, allowedPaths, pendingActions, auditLog, toolRiskOverrides) and quietHoursRange from initiativePolicy', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    // Pre-configure Host state before store bootstrap
    await kernel.updateAgencyConsent!({
      eyesMode: 'screen',
      micMode: 'ptt',
      dndMode: true,
      approvalPolicy: 'session',
      allowedPaths: ['/workspace/ashy', '/workspace/custom-host-dir'],
      allowedWindowTitles: ['VS Code', 'Cursor IDE'],
      toolRiskOverrides: {
        read_workspace_file: 'staged-confirm',
      },
    })
    await kernel.updateInitiativePolicy!({
      quietHoursStart: '21:30',
      quietHoursEnd: '06:30',
    })

    // Stage a pending action directly on the Host kernel before store bootstraps
    const stagedOnHost = await kernel.callMcpTool!({
      toolName: 'write_project_note',
      args: {
        title: 'Nota Criada no Host',
        content: 'Deve aparecer hidratada no store ao dar bootstrap.',
      },
    })
    expect(stagedOnHost.status).toBe('staged')
    const stagedCardId = stagedOnHost.pendingCard!.id

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    const state = useAshyStore.getState()
    expect(state.privacyState.eyesMode).toBe('screen')
    expect(state.privacyState.micMode).toBe('ptt')
    expect(state.privacyState.dndMode).toBe(true)
    expect(state.privacyState.allowedPaths).toContain('/workspace/custom-host-dir')
    expect(state.privacyState.allowedWindowTitles).toContain('Cursor IDE')
    expect(state.computerActionsPolicy).toBe('session')
    expect(state.computerActionsEnabled).toBe(true)
    expect(state.toolRiskOverrides.read_workspace_file).toBe('staged-confirm')
    expect(state.pendingActions).toHaveLength(1)
    expect(state.pendingActions[0]?.id).toBe(stagedCardId)
    expect(state.auditLog.length).toBeGreaterThanOrEqual(1)
    expect(state.quietHoursRange).toBe('21:30 - 06:30')

    // Render Studio UI and verify chat-pending-actions-bar shows the Host-staged card
    await act(async () => {
      root!.render(<App />)
    })

    const pendingBar = getByTestId('chat-pending-actions-bar')
    expect(pendingBar.textContent).toContain('write_project_note')
    expect(getByTestId(`chat-pending-action-${stagedCardId}`)).toBeTruthy()
  })

  it('2. toggling setComputerActionsEnabled(false) persists approvalPolicy: "off" to the Host kernel and survives resetAshyStore() + bootstrapFromHost()', async () => {
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

    expect(useAshyStore.getState().computerActionsEnabled).toBe(true)
    expect(useAshyStore.getState().computerActionsPolicy).toBe('ask')

    // Disable computer actions via UI toggle-computer-actions (or setComputerActionsEnabled(false))
    await act(async () => {
      clickElement(getByTestId('toggle-computer-actions'))
    })

    expect(useAshyStore.getState().computerActionsEnabled).toBe(false)
    expect(useAshyStore.getState().computerActionsPolicy).toBe('off')

    // Verify Host kernel persisted approvalPolicy: 'off'
    const hostSnapAfterOff = await kernel.getBootstrapSnapshot()
    expect(hostSnapAfterOff.agency?.consent.approvalPolicy).toBe('off')

    // Reset store completely and re-bootstrap from Host
    await act(async () => {
      resetAshyStore()
      await useAshyStore.getState().bootstrapFromHost()
    })

    expect(useAshyStore.getState().computerActionsPolicy).toBe('off')
    expect(useAshyStore.getState().computerActionsEnabled).toBe(false)

    // Re-enable computer actions -> restores 'ask' and persists to Host
    await act(async () => {
      useAshyStore.getState().setComputerActionsEnabled(true)
    })

    expect(useAshyStore.getState().computerActionsEnabled).toBe(true)
    expect(useAshyStore.getState().computerActionsPolicy).toBe('ask')

    const hostSnapAfterOn = await kernel.getBootstrapSnapshot()
    expect(hostSnapAfterOn.agency?.consent.approvalPolicy).toBe('ask')
  })

  it('3. changing setQuietHoursRange("21:00 - 06:00") persists quietHoursStart and quietHoursEnd to the Host kernel and survives resetAshyStore() + bootstrapFromHost()', async () => {
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

    const quietSelect = getByTestId<HTMLSelectElement>('select-quiet-hours')
    await act(async () => {
      setNativeInputValue(quietSelect, '21:00 - 06:00')
    })

    expect(useAshyStore.getState().quietHoursRange).toBe('21:00 - 06:00')
    expect(useAshyStore.getState().initiativePolicy.quietHoursStart).toBe('21:00')
    expect(useAshyStore.getState().initiativePolicy.quietHoursEnd).toBe('06:00')

    const hostSnap = await kernel.getBootstrapSnapshot()
    expect(hostSnap.memories.initiativePolicy?.quietHoursStart).toBe('21:00')
    expect(hostSnap.memories.initiativePolicy?.quietHoursEnd).toBe('06:00')

    // Reset store and re-bootstrap from Host
    await act(async () => {
      resetAshyStore()
      await useAshyStore.getState().bootstrapFromHost()
    })

    expect(useAshyStore.getState().quietHoursRange).toBe('21:00 - 06:00')
    expect(useAshyStore.getState().initiativePolicy.quietHoursStart).toBe('21:00')
    expect(useAshyStore.getState().initiativePolicy.quietHoursEnd).toBe('06:00')
  })

  it('4. persists Consent Center & Privacy Shield mutations to the Host kernel and keeps store synchronized with Host AgencySnapshot', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    await act(async () => {
      useAshyStore.getState().setEyesMode('window')
      useAshyStore.getState().setMicMode('continuous')
      useAshyStore.getState().addAllowedPath('/workspace/persisted-path')
      useAshyStore.getState().setToolRiskTierOverride('get_active_window_title', 'staged-confirm')
    })

    // Activate full privacy shield
    await act(async () => {
      useAshyStore.getState().activateFullPrivacyShield()
    })

    expect(useAshyStore.getState().privacyState.eyesMode).toBe('off')
    expect(useAshyStore.getState().privacyState.micMode).toBe('muted')
    expect(useAshyStore.getState().privacyState.dndMode).toBe(true)

    // Reset store and bootstrap from Host to verify full persistence
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    const reloaded = useAshyStore.getState()
    expect(reloaded.privacyState.eyesMode).toBe('off')
    expect(reloaded.privacyState.micMode).toBe('muted')
    expect(reloaded.privacyState.dndMode).toBe(true)
    expect(reloaded.privacyState.allowedPaths).toContain('/workspace/persisted-path')
    expect(reloaded.toolRiskOverrides.get_active_window_title).toBe('staged-confirm')
  })

  it('5. [Adversarial Red-Team] rejects malformed quietHoursRange, blocks URL-encoded/UNC/relative allowedPaths, and refuses to execute staged actions after computerActionsPolicy is switched to "off"', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    const initialQuietRange = useAshyStore.getState().quietHoursRange
    await act(async () => {
      useAshyStore.getState().setQuietHoursRange('25:99 - 99:99')
      useAshyStore.getState().setQuietHoursRange('<script>alert(1)</script>')
    })
    expect(useAshyStore.getState().quietHoursRange).toBe(initialQuietRange)

    // Attempt to add URL-encoded traversal, UNC share, and relative paths to allowedPaths
    await act(async () => {
      useAshyStore.getState().addAllowedPath('/workspace/%2e%2e/etc/passwd')
      useAshyStore.getState().addAllowedPath('//evil-smb-server/share')
      useAshyStore.getState().addAllowedPath('relative/path/escape')
    })
    const allowedPaths = useAshyStore.getState().privacyState.allowedPaths
    expect(allowedPaths).not.toContain('/workspace/%2e%2e/etc/passwd')
    expect(allowedPaths).not.toContain('//evil-smb-server/share')
    expect(allowedPaths).not.toContain('relative/path/escape')

    // Stage a pending action in 'ask' mode, then turn computerActionsEnabled OFF, then try to approve
    const notePath = path.join(dir, 'notes', 'blocked-after-off.md').replace(/\\/g, '/')
    const staged = await useAshyStore.getState().triggerMcpTool('write_project_note', {
      title: 'Blocked After Off',
      path: notePath,
      content: '# Should not be written when policy is switched to off',
    })
    expect(staged.status).toBe('staged')
    const actionId = staged.pendingCard!.id

    await act(async () => {
      useAshyStore.getState().setComputerActionsEnabled(false)
    })
    expect(useAshyStore.getState().computerActionsPolicy).toBe('off')

    await expect(
      useAshyStore.getState().approvePendingAction(actionId, 'once'),
    ).rejects.toThrow(/disabled by policy|Cannot approve/i)
    expect(fs.existsSync(notePath)).toBe(false)
  })
})
