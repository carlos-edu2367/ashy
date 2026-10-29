// @vitest-environment jsdom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreExperimentEvalReport } from '@ashy/shared'
import { App } from '../App'
import { createAshyHostKernel } from '../host/kernel'
import { dispatchHostRpc } from '../host/vite-host-plugin'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'

// Enable React 19 act environment
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const tempDirs: string[] = []
const activeKernels: Array<{ stop(): Promise<void> }> = []
let container: HTMLDivElement | null = null
let root: Root | null = null

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-ui-p3-'))
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

describe('Phase 3 Core Experiment M2 — Host Kernel, RPC Transport & Desktop Hub Panel', () => {
  it('1. executes runCoreExperimentEval on an isolated Cortex without polluting user sessions/messages, caches lastEvalReport in bootstrap snapshot, and rejects invalid RPC arguments', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)

    const initialSnap = await kernel.completeOnboarding({
      userName: 'Carlos',
    })
    const initialSessionsCount = initialSnap.sessions.length
    const initialMessagesCount = initialSnap.messages.length
    const initialEpisodesCount = initialSnap.memories.episodes.length
    expect(initialSnap.lastEvalReport ?? null).toBeNull()

    // Direct kernel call
    const report1 = await kernel.runCoreExperimentEval({ seed: 1 })
    expect(report1.seed).toBe(1)
    expect(report1.passedAllGates).toBe(true)
    expect(report1.failedGates).toEqual([])
    expect(report1.steps.length).toBeGreaterThanOrEqual(10)

    // Verify user's real SQLite Cortex was NOT polluted by the 3-week simulation
    const afterEvalSnap = await kernel.getBootstrapSnapshot()
    expect(afterEvalSnap.sessions.length).toBe(initialSessionsCount)
    expect(afterEvalSnap.messages.length).toBe(initialMessagesCount)
    expect(afterEvalSnap.memories.episodes.length).toBe(initialEpisodesCount)
    expect(afterEvalSnap.lastEvalReport?.runId).toBe(report1.runId)
    expect(afterEvalSnap.lastEvalReport?.seed).toBe(1)

    // Dispatch via RPC transport
    const reportViaRpc = (await dispatchHostRpc(kernel, 'runCoreExperimentEval', {
      seed: 2,
      modelAId: 'claude-3-7-sonnet',
      modelBId: 'deepseek-v3',
    })) as CoreExperimentEvalReport
    expect(reportViaRpc.seed).toBe(2)
    expect(reportViaRpc.passedAllGates).toBe(true)
    expect(reportViaRpc.modelAId).toBe('claude-3-7-sonnet')
    expect(reportViaRpc.modelBId).toBe('deepseek-v3')

    // Also allow undefined/empty payload in RPC
    const reportDefaultRpc = (await dispatchHostRpc(
      kernel,
      'runCoreExperimentEval',
      undefined,
    )) as CoreExperimentEvalReport
    expect(reportDefaultRpc.seed).toBe(0)
    expect(reportDefaultRpc.passedAllGates).toBe(true)

    // Adversarial RPC argument validation
    await expect(
      dispatchHostRpc(kernel, 'runCoreExperimentEval', { seed: -1 }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'runCoreExperimentEval', { seed: 1.5 }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'runCoreExperimentEval', { seed: 1000 }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'runCoreExperimentEval', { modelAId: '' }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'runCoreExperimentEval', { modelAId: 'bad\0model' }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'runCoreExperimentEval', { modelBId: 'x'.repeat(200) }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'runCoreExperimentEval', ['not-an-object']),
    ).rejects.toThrow(/Invalid RPC argument/i)

    // Reject control characters (\n, \r) in modelAId / modelBId and prototype-pollution payloads
    await expect(
      dispatchHostRpc(kernel, 'runCoreExperimentEval', { modelAId: 'claude\n## injected' }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'runCoreExperimentEval', { modelBId: 'qwen\r\ninjected' }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(
        kernel,
        'runCoreExperimentEval',
        JSON.parse('{"seed":0,"__proto__":{"polluted":true}}'),
      ),
    ).rejects.toThrow(/Invalid RPC argument/i)
  })

  it('2. renders the "Experimento Central (M2 — Portabilidade da Alma)" panel in Nossa história tab, runs Seed 1 diagnostic, and displays APROVADO, metric badges, and longitudinal steps', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)

    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()

    await act(async () => {
      root!.render(<App />)
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().isBootstrapped).toBe(true)
    })

    // Navigate to Nossa história ('tab-story')
    await act(async () => {
      clickElement(getByTestId('tab-story'))
    })

    const m2Panel = getByTestId('m2-eval-panel')
    expect(m2Panel.textContent).toContain('Experimento Central (M2 — Portabilidade da Alma)')

    const statusBadgeBefore = getByTestId('m2-eval-status-badge')
    expect(statusBadgeBefore.textContent).toContain('Pronto para rodar')

    // Select seed 1 in [data-testid="select-m2-eval-seed"]
    const seedSelect = getByTestId<HTMLSelectElement>('select-m2-eval-seed')
    await act(async () => {
      setNativeInputValue(seedSelect, '1')
    })
    expect(seedSelect.value).toBe('1')

    // Click [data-testid="btn-run-m2-eval"]
    const runBtn = getByTestId('btn-run-m2-eval')
    await act(async () => {
      clickElement(runBtn)
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().lastEvalReport).not.toBeNull()
      expect(useAshyStore.getState().isRunningEval).toBe(false)
    })

    const statusBadgeAfter = getByTestId('m2-eval-status-badge')
    expect(statusBadgeAfter.textContent).toBe('APROVADO')

    // Verify metric badges inside the panel
    expect(m2Panel.textContent).toContain('Recall')
    expect(m2Panel.textContent).toContain('Precisão')
    expect(m2Panel.textContent).toContain('Callbacks')
    expect(m2Panel.textContent).toContain('Zero Alucinação')
    expect(m2Panel.textContent).toContain('Seriousness Gate')
    expect(m2Panel.textContent).toContain('Deriva A → B')

    // Verify longitudinal steps list
    const stepsList = getByTestId('m2-eval-steps-list')
    expect(stepsList.textContent).toContain('day1-first-meeting-and-joke')
    expect(stepsList.textContent).toContain('day11-model-b-continuity-and-fact-calibration')
    expect(stepsList.textContent).toContain('day12-model-b-seriousness-gate')
    expect(stepsList.textContent).toContain('day18-model-b-inside-joke-callback')
    expect(stepsList.textContent).toContain('day21-model-b-late-night-habit-reflection')

    // Verify resetAshyStore clears lastEvalReport, lastEvalError, and isRunningEval
    act(() => {
      resetAshyStore()
    })
    expect(useAshyStore.getState().lastEvalReport).toBeNull()
    expect(useAshyStore.getState().lastEvalError).toBeNull()
    expect(useAshyStore.getState().isRunningEval).toBe(false)
  })

  it('3. handles eval errors gracefully in UI without unhandled rejections, guards against stale race conditions on reset, and dynamically colors failing metric badges', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    const baseSnap = await kernel.getBootstrapSnapshot()

    let failMode = true
    const mockBridge = {
      ...kernel,
      getBootstrapSnapshot: async () => baseSnap,
      runCoreExperimentEval: async () => {
        if (failMode) {
          throw new Error('Falha simulada no runner M2')
        }
        const real = await kernel.runCoreExperimentEval({ seed: 0 })
        return {
          ...real,
          passedAllGates: false,
          failedGates: ['G1: memoryRecallRate (0.50) < 0.85', 'G5: hallucinatedMemoryCount (2) > 0'],
          metrics: {
            ...real.metrics,
            memoryRecallRate: 0.5,
            hallucinatedMemoryCount: 2,
            crossModelVoiceDrift: 0.25,
          },
        }
      },
    }

    setAshyHostBridgeForTesting(mockBridge)
    resetAshyStore()

    await act(async () => {
      root!.render(<App />)
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().isBootstrapped).toBe(true)
    })

    await act(async () => {
      clickElement(getByTestId('tab-story'))
    })

    // Click run when bridge rejects -> should capture lastEvalError and render m2-eval-error without unhandled rejection
    await act(async () => {
      clickElement(getByTestId('btn-run-m2-eval'))
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().isRunningEval).toBe(false)
      expect(useAshyStore.getState().lastEvalError).toContain('Falha simulada no runner M2')
    })

    const errorEl = getByTestId('m2-eval-error')
    expect(errorEl.textContent).toContain('Falha simulada no runner M2')

    // Now switch to returning a failing report and verify dynamic amber badges and violet badge while running
    failMode = false
    await act(async () => {
      clickElement(getByTestId('btn-run-m2-eval'))
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().isRunningEval).toBe(false)
      expect(useAshyStore.getState().lastEvalError).toBeNull()
      expect(useAshyStore.getState().lastEvalReport?.passedAllGates).toBe(false)
    })

    const statusBadge = getByTestId('m2-eval-status-badge')
    expect(statusBadge.textContent).toBe('REPROVADO')
    expect(statusBadge.className).toContain('amber')

    const m2Panel = getByTestId('m2-eval-panel')
    const amberBadges = Array.from(m2Panel.querySelectorAll('.ashy-badge.amber')).map(
      (b) => b.textContent,
    )
    expect(amberBadges.some((t) => t?.includes('Recall: 50%'))).toBe(true)
    expect(amberBadges.some((t) => t?.includes('Zero Alucinação: 2'))).toBe(true)
    expect(amberBadges.some((t) => t?.includes('Deriva A → B: 25%'))).toBe(true)
  })
})
