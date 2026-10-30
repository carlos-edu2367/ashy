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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-ui-p7-'))
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

describe('Phase 7 Desktop, Vision & MCP Tools — Inline PendingActionCard, "Modo Não Pergunte" (auto_accept), Vision dHash & Consent Center UI', () => {
  it('1. stages write_project_note in default ask mode with unified diff preview and renders PendingActionCard inline in Chat, Stage Overlay bubble, and Ajustes > Permissões', async () => {
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

    expect(useAshyStore.getState().computerActionsPolicy).toBe('ask')
    expect(useAshyStore.getState().pendingActions).toHaveLength(0)

    // Trigger write_project_note in default 'ask' mode
    let execRes!: Awaited<ReturnType<ReturnType<typeof useAshyStore.getState>['triggerMcpTool']>>
    await act(async () => {
      execRes = await useAshyStore.getState().triggerMcpTool('write_project_note', {
        title: 'Nota de Arquitetura Fase 7',
        content: 'Gatekeeper e diff preview verificados.',
      })
    })

    expect(execRes.status).toBe('staged')
    expect(execRes.pendingCard).toBeDefined()
    const cardId = execRes.pendingCard!.id
    expect(execRes.pendingCard?.targetPath).toContain('nota-de-arquitetura-fase-7.md')
    expect(execRes.pendingCard?.diffPreview).toContain('--- a/')
    expect(execRes.pendingCard?.diffPreview).toContain('+++ b/')
    expect(execRes.pendingCard?.diffPreview).toContain('+Gatekeeper e diff preview verificados.')

    // 1. Verify inline PendingActionCard in Studio Chat
    const chatPendingBar = getByTestId('chat-pending-actions-bar')
    expect(chatPendingBar.textContent).toContain('write_project_note')
    expect(getByTestId(`chat-pending-action-${cardId}`).textContent).toContain(
      '+Gatekeeper e diff preview verificados.',
    )

    // 2. Switch to Stage Overlay and verify stage-pending-action-bubble is a data-ui-island="true"
    await act(async () => {
      useAshyStore.getState().setViewMode('stage')
    })

    const stageBubble = getByTestId('stage-pending-action-bubble')
    expect(stageBubble.getAttribute('data-ui-island')).toBe('true')
    expect(stageBubble.textContent).toContain('write_project_note')
    // Invariant: ashy-stage-canvas must still NOT be inside a data-ui-island="true" wrapper
    const stageCanvas = getByTestId('ashy-stage-canvas')
    expect(stageCanvas.parentElement?.closest('[data-ui-island="true"]')).toBeNull()

    // 3. Switch back to Hub -> Ajustes > Permissões and verify card + diff preview in panel-mcp-gatekeeper
    await act(async () => {
      useAshyStore.getState().setViewMode('hub')
      useAshyStore.getState().setActiveTab('agency')
    })

    const hubCard = getByTestId(`pending-action-${cardId}`)
    expect(hubCard.textContent).toContain('nota-de-arquitetura-fase-7.md')
    const diffPre = getByTestId(`pending-diff-${cardId}`)
    expect(diffPre.textContent).toContain('--- a/')
    expect(diffPre.textContent).toContain('+++ b/')

    // 4. Click "Aprovar uma vez" -> executes handler, clears pending card, logs 'approved' in consent-audit-ledger
    await act(async () => {
      clickElement(getByTestId(`btn-approve-once-${cardId}`))
    })

    expect(useAshyStore.getState().pendingActions).toHaveLength(0)
    expect(queryByTestId(`pending-action-${cardId}`)).toBeNull()
    const ledger = getByTestId('consent-audit-ledger')
    expect(ledger.textContent).toContain('approved')
    expect(ledger.textContent).toContain('write_project_note')
  })

  it('2. activates "Modo Não Pergunte" (auto_accept) via toggle-dont-ask-mode or select-computer-actions-policy, auto-approving pending actions and executing write/destructive tools without confirmation', async () => {
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

    // First stage a pending action while in 'ask' mode
    await act(async () => {
      await useAshyStore.getState().triggerMcpTool('write_project_note', {
        title: 'Nota Pendente Antes do Auto Accept',
        content: 'Será aprovada automaticamente ao ativar Não Pergunte.',
      })
    })
    expect(useAshyStore.getState().pendingActions).toHaveLength(1)

    // Toggle "Modo Não Pergunte" ON via toggle-dont-ask-mode
    const dontAskToggle = getByTestId('toggle-dont-ask-mode')
    await act(async () => {
      clickElement(dontAskToggle)
    })

    expect(useAshyStore.getState().computerActionsPolicy).toBe('auto_accept')
    expect(getByTestId('dont-ask-mode-badge').textContent).toMatch(/Não pergunte|Auto/i)
    // Existing pending action must be automatically approved and cleared!
    expect(useAshyStore.getState().pendingActions).toHaveLength(0)

    // Now trigger write_project_note AND run_cleanup_command (with blast-radius rm -rf) while in auto_accept mode
    let writeRes!: Awaited<ReturnType<ReturnType<typeof useAshyStore.getState>['triggerMcpTool']>>
    let blastRes!: Awaited<ReturnType<ReturnType<typeof useAshyStore.getState>['triggerMcpTool']>>
    await act(async () => {
      writeRes = await useAshyStore.getState().triggerMcpTool('write_project_note', {
        title: 'Nota Auto Aceita',
        content: 'Executada direto sem perguntar.',
      })
      blastRes = await useAshyStore.getState().triggerMcpTool('run_cleanup_command', {
        command: 'rm -rf /tmp/build',
      })
    })

    expect(writeRes.status).toBe('executed')
    expect(blastRes.status).toBe('executed')
    expect(useAshyStore.getState().pendingActions).toHaveLength(0)

    const ledger = getByTestId('consent-audit-ledger')
    expect(ledger.textContent).toContain('Auto-approved by user policy (auto_accept)')
    expect(ledger.textContent).toContain('run_cleanup_command')

    // Also verify switching policy via select-computer-actions-policy back to 'ask' and then to 'auto_accept'
    const policySelect = getByTestId<HTMLSelectElement>('select-computer-actions-policy')
    await act(async () => {
      setNativeInputValue(policySelect, 'ask')
    })
    expect(useAshyStore.getState().computerActionsPolicy).toBe('ask')

    await act(async () => {
      setNativeInputValue(policySelect, 'auto_accept')
    })
    expect(useAshyStore.getState().computerActionsPolicy).toBe('auto_accept')
  })

  it('3. enforces EyesMode privacy gate (0 frames when off) and 64-bit dHash static screen deduplication in Vision Telemetry panel', async () => {
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

    expect(getByTestId('panel-vision-dhash')).toBeDefined()

    // 1. Set eyesMode to 'off' -> clicking btn-vision-capture-window must NOT capture any frame
    await act(async () => {
      useAshyStore.getState().setEyesMode('off')
    })
    expect(useAshyStore.getState().privacyState.eyesMode).toBe('off')

    await act(async () => {
      clickElement(getByTestId('btn-vision-capture-window'))
    })

    expect(getByTestId('vision-frames-captured').textContent).toBe('0')
    expect(getByTestId('vision-blocked-privacy').textContent).toBe('1')
    expect(getByTestId('consent-audit-ledger').textContent).toContain('blocked_privacy')

    // 2. Switch eyesMode to 'window' and capture Frame 1
    await act(async () => {
      useAshyStore.getState().setEyesMode('window')
    })
    await act(async () => {
      clickElement(getByTestId('btn-vision-capture-window'))
    })

    expect(getByTestId('vision-frames-captured').textContent).toBe('1')
    expect(getByTestId('vision-frames-skipped').textContent).toBe('0')
    expect(getByTestId('vision-last-dhash').textContent).toMatch(/^0x[0-9a-f]{16}$/i)
    expect(getByTestId('vision-last-summary').textContent).toContain('VS Code')
    expect(useAshyStore.getState().lastPrompt.systemPrompt).toContain('Active screen:')
    expect(useAshyStore.getState().lastPrompt.systemPrompt).toContain('VS Code')

    const tokensAfterFirst = useAshyStore.getState().visionTelemetry.totalVisionTokensSpent
    expect(tokensAfterFirst).toBeGreaterThan(0)

    // 3. Click btn-vision-capture-static -> identical frame is skipped by dHash (0 new tokens spent)
    await act(async () => {
      clickElement(getByTestId('btn-vision-capture-static'))
    })

    expect(getByTestId('vision-frames-captured').textContent).toBe('1')
    expect(getByTestId('vision-frames-skipped').textContent).toBe('1')
    expect(useAshyStore.getState().visionTelemetry.totalVisionTokensSpent).toBe(tokensAfterFirst)

    // 4. Click btn-vision-capture-changed -> different screen pattern triggers capture 2
    await act(async () => {
      clickElement(getByTestId('btn-vision-capture-changed'))
    })

    expect(getByTestId('vision-frames-captured').textContent).toBe('2')
    expect(useAshyStore.getState().visionTelemetry.totalVisionTokensSpent).toBeGreaterThan(
      tokensAfterFirst,
    )
  })

  it('4. manages Consent Center: per-tool risk tier override, allowed paths scope editor, and session permission revocation', async () => {
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

    expect(getByTestId('panel-consent-center')).toBeTruthy()

    // 1. Override read_workspace_file from 'read-safe' to 'staged-confirm'
    const riskSelect = getByTestId<HTMLSelectElement>('select-tool-risk-read_workspace_file')
    expect(riskSelect.value).toBe('read-safe')

    await act(async () => {
      setNativeInputValue(riskSelect, 'staged-confirm')
    })

    expect(useAshyStore.getState().toolRiskOverrides.read_workspace_file).toBe('staged-confirm')

    // Calling read_workspace_file now stages a PendingActionCard instead of executing immediately
    let readRes!: Awaited<ReturnType<ReturnType<typeof useAshyStore.getState>['triggerMcpTool']>>
    await act(async () => {
      readRes = await useAshyStore.getState().triggerMcpTool('read_workspace_file', {
        path: '/workspace/ashy/package.json',
      })
    })
    expect(readRes.status).toBe('staged')
    expect(useAshyStore.getState().pendingActions).toHaveLength(1)

    // 2. Approve for the session ("Permitir na sessão") -> adds read_workspace_file to sessionApprovedTools
    const pendingId = readRes.pendingCard!.id
    await act(async () => {
      clickElement(getByTestId(`btn-approve-session-${pendingId}`))
    })

    expect(useAshyStore.getState().pendingActions).toHaveLength(0)
    expect(useAshyStore.getState().sessionApprovedTools).toContain('read_workspace_file')

    // 3. Add a new allowed path via input-allowed-path + btn-add-allowed-path
    const pathInput = getByTestId<HTMLInputElement>('input-allowed-path')
    const addPathBtn = getByTestId<HTMLButtonElement>('btn-add-allowed-path')

    await act(async () => {
      setNativeInputValue(pathInput, '/workspace/novo-projeto-fase7')
      clickElement(addPathBtn)
    })

    expect(useAshyStore.getState().privacyState.allowedPaths).toContain(
      '/workspace/novo-projeto-fase7',
    )

    // Adversarial: attempting to add a traversal path with '..' is rejected
    await act(async () => {
      useAshyStore.getState().addAllowedPath('../../etc/passwd')
    })
    expect(useAshyStore.getState().privacyState.allowedPaths).not.toContain('../../etc/passwd')

    // 4. Revoke session permissions via btn-revoke-session-permissions
    await act(async () => {
      clickElement(getByTestId('btn-revoke-session-permissions'))
    })

    expect(useAshyStore.getState().sessionApprovedTools).toHaveLength(0)
    expect(getByTestId('consent-audit-ledger').textContent).toContain('revoked')
  })
})
