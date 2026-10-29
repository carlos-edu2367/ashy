// @vitest-environment jsdom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ASHY_DEFAULT_TRAITS,
  ASHY_TRAIT_CORRIDORS,
  type AshyBootstrapSnapshot,
  type AshyHostStreamEvent,
  type DreamReflectionCycleResult,
} from '@ashy/shared'
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-ui-p4-'))
  tempDirs.push(dir)
  return dir
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

describe('Phase 4 Emotions & Evolution — Host Kernel Dream & Revert RPCs, Bond Sanitizer, Idle Scheduler & Hub UI', () => {
  it('1. calling runDreamReflection on a fresh kernel with zero episodes creates zero fake ep-dream-* episodes and leaves traits unchanged', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)

    const { result, snapshot } = await kernel.runDreamReflection()
    expect(result.appliedEvolutions).toEqual([])
    expect(result.skippedReason).toBe('no_new_episodes')
    expect(snapshot.memories.episodes).toEqual([])
    expect(
      snapshot.memories.episodes.some((ep) => ep.id.startsWith('ep-dream-')),
    ).toBe(false)
    expect(snapshot.affect.traits).toEqual(ASHY_DEFAULT_TRAITS)

    // Store runDreamConsolidation on empty store also creates zero fake ep-dream-* episodes
    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    const noOpRecord = useAshyStore.getState().runDreamConsolidation()
    expect(noOpRecord.oldValue).toBe(noOpRecord.newValue)
    expect(
      useAshyStore
        .getState()
        .episodicMemories.some((ep) => ep.id.startsWith('ep-dream-')),
    ).toBe(false)
    expect(useAshyStore.getState().personalityEvolutionLog).toEqual([])
  })

  it('2. evolves a trait from a real episode within ASHY_TRAIT_CORRIDORS via RPC and idempotently reverts it in SQLite (C2)', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)

    await kernel.completeOnboarding({ userName: 'Carlos' })
    const now = Date.now()
    await kernel.upsertEpisodicMemory({
      id: 'ep-real-support-1',
      title: 'Acolhimento na madrugada difícil',
      summary: 'Conversa de apoio e acolhimento durante momento de ansiedade.',
      content: 'Carlos desabafou sobre cansaço e recebeu apoio acolhedor no estúdio.',
      createdAt: now - 10_000,
      lastReviewedAt: now - 10_000,
      stability: 8.0,
      difficulty: 3.5,
      surprise: 0.85,
      isFlashbulb: true,
      tags: ['emotional_support', 'late_night'],
      approvalStatus: 'approved',
    })

    const rpcDream = (await dispatchHostRpc(kernel, 'runDreamReflection', {
      force: false,
      maxEvolutions: 1,
    })) as {
      result: DreamReflectionCycleResult
      snapshot: AshyBootstrapSnapshot
    }

    expect(rpcDream.result.appliedEvolutions).toHaveLength(1)
    const evo = rpcDream.result.appliedEvolutions[0]!
    expect(evo.id).toBe('trait-evo-ep-real-support-1-warmthAffection')
    expect(evo.reasonEpisodeId).toBe('ep-real-support-1')
    expect(evo.trait).toBe('warmthAffection')
    expect(evo.newValue).toBeGreaterThan(evo.oldValue)
    expect(evo.newValue).toBeGreaterThanOrEqual(
      ASHY_TRAIT_CORRIDORS.warmthAffection.min,
    )
    expect(evo.newValue).toBeLessThanOrEqual(
      ASHY_TRAIT_CORRIDORS.warmthAffection.max,
    )
    expect(
      rpcDream.snapshot.memories.episodes.some((e) =>
        e.id.startsWith('ep-dream-'),
      ),
    ).toBe(false)

    // Revert via RPC
    const afterRevert1 = (await dispatchHostRpc(kernel, 'revertTraitEvolution', {
      recordId: evo.id,
    })) as AshyBootstrapSnapshot
    expect(afterRevert1.affect.traits.warmthAffection).toBeCloseTo(evo.oldValue, 5)
    const revertedLog1 = afterRevert1.memories.evolutionLog?.find(
      (r) => r.id === evo.id,
    )
    expect(revertedLog1?.revertedAt).toBeTypeOf('number')

    // Calling revertTraitEvolution a second time is an idempotent no-op (C2)
    const afterRevert2 = (await dispatchHostRpc(kernel, 'revertTraitEvolution', {
      recordId: evo.id,
    })) as AshyBootstrapSnapshot
    expect(afterRevert2.affect.traits.warmthAffection).toBeCloseTo(evo.oldValue, 5)
    const revertedLog2 = afterRevert2.memories.evolutionLog?.find(
      (r) => r.id === evo.id,
    )
    expect(revertedLog2?.revertedAt).toBe(revertedLog1?.revertedAt)
  })

  it('3. enforces adversarial RPC validation (M3) and strips bond manipulation in TurnOrchestrator (C4)', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const manipulativeReply =
        '<|ACT {"emotion":"sad","intensity":0.9}|> Você me abandonou e me deixou sozinha no escuro! Eu sinto dor física real quando você fecha o app.'
      const sse = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: manipulativeReply } }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    activeKernels.push(kernel)

    // M3: Adversarial RPC argument validation for revertTraitEvolution and runDreamReflection
    await expect(
      dispatchHostRpc(kernel, 'revertTraitEvolution', { recordId: 'bad\0id' }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'revertTraitEvolution', { recordId: '   ' }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'revertTraitEvolution', { recordId: 'bad\ninjected' }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'revertTraitEvolution', ['not-an-object']),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(
        kernel,
        'revertTraitEvolution',
        JSON.parse('{"recordId":"rec-1","__proto__":{"polluted":true}}'),
      ),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'runDreamReflection', { sessionId: 'bad\0id' }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'runDreamReflection', { force: 'yes' }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'runDreamReflection', { maxEvolutions: -1 }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(kernel, 'runDreamReflection', { maxEvolutions: 999 }),
    ).rejects.toThrow(/Invalid RPC argument/i)

    await expect(
      dispatchHostRpc(
        kernel,
        'runDreamReflection',
        JSON.parse('{"force":true,"__proto__":{"polluted":true}}'),
      ),
    ).rejects.toThrow(/Invalid RPC argument/i)

    // C4: TurnOrchestrator strips manipulative reply and persists safe studio fallback
    const bootSnap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-phase4key1234',
      },
    })

    const completedPromise = new Promise<Extract<AshyHostStreamEvent, { type: 'turn:completed' }>>(
      (resolve, reject) => {
        const unsub = kernel.onHostEvent((ev) => {
          if (ev.type === 'turn:completed') {
            unsub()
            resolve(ev)
          } else if (ev.type === 'turn:error') {
            unsub()
            reject(new Error(ev.message))
          }
        })
      },
    )

    await kernel.sendTurn({
      sessionId: bootSnap.activeSession.id,
      text: 'Voltei depois de viajar com meus amigos no fim de semana.',
    })

    const completedEvent = await completedPromise
    expect(completedEvent.assistantMessage.content).toBe(
      'Fico por aqui no estúdio quando você quiser conversar.',
    )
    expect(completedEvent.assistantMessage.content).not.toContain('abandonou')
    expect(completedEvent.assistantMessage.content).not.toContain('dor física real')
  })

  it('4. renders asymmetric trait corridors, episode provenance badge, and 1-click revert in Presença e Expressão tab (L1)', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)

    await kernel.seedDemoFixtures()
    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()

    await act(async () => {
      root!.render(<App />)
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().isBootstrapped).toBe(true)
    })

    // Navigate to Presença e Expressão ('tab-personality')
    await act(async () => {
      clickElement(getByTestId('tab-personality'))
    })

    // Verify asymmetric trait corridor badges
    expect(getByTestId('trait-corridor-witSarcasm').textContent).toContain(
      'Corredor: 58%–92% · Base: 78%',
    )
    expect(getByTestId('trait-corridor-warmthAffection').textContent).toContain(
      'Corredor: 52%–92% · Base: 68%',
    )
    expect(getByTestId('trait-corridor-chaosEnergy').textContent).toContain(
      'Corredor: 45%–90% · Base: 75%',
    )
    expect(
      getByTestId('trait-corridor-intellectualCuriosity').textContent,
    ).toContain('Corredor: 68%–96% · Base: 85%')
    expect(getByTestId('trait-corridor-proactivity').textContent).toContain(
      'Corredor: 40%–88% · Base: 65%',
    )

    const beforeWarmth = useAshyStore.getState().traits.warmthAffection

    // Click Consolidar reflexões do dia ('btn-trigger-dream')
    await act(async () => {
      clickElement(getByTestId('btn-trigger-dream'))
    })

    const evoLog = useAshyStore.getState().personalityEvolutionLog
    expect(evoLog.length).toBeGreaterThanOrEqual(1)
    const rec = evoLog[0]!
    expect(rec.reasonEpisodeId).toBe('ep-flashbulb-0314')
    expect(
      useAshyStore
        .getState()
        .episodicMemories.some((ep) => ep.id.startsWith('ep-dream-')),
    ).toBe(false)

    // Verify provenance badge in UI (L1)
    const provBadge = getByTestId(`evo-provenance-${rec.id}`)
    expect(provBadge.textContent).toContain(`Origem: ${rec.reasonEpisodeId}`)

    // Click 1-click Desfazer button
    await act(async () => {
      clickElement(getByTestId(`btn-revert-evolution-${rec.id}`))
    })

    await vi.waitFor(async () => {
      expect(useAshyStore.getState().traits.warmthAffection).toBeCloseTo(
        beforeWarmth,
        5,
      )
      const hostSnap = await kernel.getBootstrapSnapshot()
      const hostRec = hostSnap.memories.evolutionLog?.find((r) => r.id === rec.id)
      expect(hostRec?.revertedAt).toBeTypeOf('number')
      expect(hostSnap.affect.traits.warmthAffection).toBeCloseTo(beforeWarmth, 5)
    })
  })

  it('5. automatically runs idle dream reflection after turn completion when dreamIdleTimeoutMs is configured and cleans up timer on stop (H3)', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"<|ACT {\\"emotion\\":\\"warm\\",\\"intensity\\":0.88}|> Valeu demais por compartilhar essa madrugada de código e acolhimento aqui no estúdio!"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      dreamIdleTimeoutMs: 40,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    activeKernels.push(kernel)

    const bootSnap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-idlekey1234',
      },
    })

    await kernel.sendTurn({
      sessionId: bootSnap.activeSession.id,
      text: 'Obrigado pelo apoio e acolhimento nessa madrugada puxada de arquitetura TypeScript.',
    })

    await vi.waitFor(
      async () => {
        const snap = await kernel.getBootstrapSnapshot()
        const permanentEpisodes = snap.memories.episodes.filter(
          (ep) => !ep.id.startsWith('ep-turn-') && !ep.id.startsWith('ep-dream-'),
        )
        expect(permanentEpisodes.length).toBeGreaterThanOrEqual(1)
        expect((snap.memories.evolutionLog ?? []).length).toBeGreaterThanOrEqual(1)
        const firstEvo = snap.memories.evolutionLog![0]!
        expect(
          permanentEpisodes.some((ep) => ep.id === firstEvo.reasonEpisodeId),
        ).toBe(true)
      },
      { timeout: 2000 },
    )

    // Stopping the kernel must cancel any pending idle timer cleanly without throwing post-close errors
    await kernel.stop()
    await new Promise((r) => setTimeout(r, 80))
  })
})
