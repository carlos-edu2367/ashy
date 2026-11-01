// @vitest-environment jsdom
/**
 * Phase 10.3 — T3 (renderer): push approval cards (`agency:pending` / `agency:resolved` →
 * `agency:approve|deny`, deduped with the snapshot in the overlay bubble), the "👁 vendo a tela"
 * indicator and Live Mode › "Recursos na chamada". The main-process `ScreenCaptureProvider` is
 * covered in `phase-10-3-screen-capture-main.test.ts`.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIVE_MODE_SETTINGS,
  IDLE_CALL_STATE,
  type AgencyPendingCardView,
  type AshyHostBridge,
  type AshyHostStreamEvent,
  type CallStateSnapshot,
  type LiveCallInvokeInput,
  type LiveCallMethod,
  type LiveModeSettings,
} from '@ashy/shared'
import { App } from '../App'
import { LiveModeSettingsPanel } from '../components/LiveCallControls'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'
import { VISION_CAPTURE_AUTO_OFF_MS, resetCallStoreForTesting, useCallStore } from '../store/useCallStore'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// ───────────────────────────── renderer: approvals, vision, features ─────────────────────────────

let container: HTMLDivElement | null = null
let root: Root | null = null
let clock = 1000

function callState(partial: Partial<CallStateSnapshot>): CallStateSnapshot {
  clock += 10
  return { ...IDLE_CALL_STATE, updatedAt: clock, ...partial }
}

type Handler = (payload: unknown) => unknown

function createFakeBridge(overrides: Partial<Record<LiveCallMethod, Handler>> = {}) {
  const listeners = new Set<(event: AshyHostStreamEvent) => void>()
  let settings: LiveModeSettings = structuredClone(DEFAULT_LIVE_MODE_SETTINGS)
  const handlers: Partial<Record<LiveCallMethod, Handler>> = {
    'call:getState': () => callState({}),
    'engines:getStatus': () => null,
    'liveMode:getSettings': () => structuredClone(settings),
    'liveMode:saveSettings': (payload) => {
      const p = payload as Partial<LiveModeSettings>
      settings = { ...settings, ...p, features: { ...settings.features, ...(p.features ?? {}) } }
      return structuredClone(settings)
    },
    'liveVoice:list': () => [],
    'agency:approve': () => ({ ok: true }),
    'agency:deny': () => ({ ok: true }),
    ...overrides,
  }
  const invokeLiveCall = vi.fn(async (input: LiveCallInvokeInput) => {
    const handler = handlers[input.method]
    if (!handler) throw new Error(`LIVE_CALL_METHOD_UNAVAILABLE: ${input.method}`)
    return handler(input.payload)
  })
  const base: Record<string, unknown> = {
    invokeLiveCall,
    onHostEvent(listener: (event: AshyHostStreamEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const bridge = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop as string]
      if (prop === 'then') return undefined
      return () => new Promise(() => undefined)
    },
  }) as unknown as AshyHostBridge
  return {
    bridge,
    emit(event: AshyHostStreamEvent) {
      for (const l of [...listeners]) l(event)
    },
    callsFor(method: LiveCallMethod) {
      return invokeLiveCall.mock.calls.filter(([input]) => input.method === method)
    },
  }
}

function all(testId: string): HTMLElement[] {
  return [...(container?.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`) ?? [])]
}
function q<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return (container?.querySelector(`[data-testid="${testId}"]`) as T | null) ?? null
}
function get<T extends HTMLElement = HTMLElement>(testId: string): T {
  const el = q<T>(testId)
  if (!el) throw new Error(`missing [data-testid="${testId}"]`)
  return el
}
function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}
function setNativeValue(element: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

async function render(fake: ReturnType<typeof createFakeBridge>, node: React.ReactElement, setup?: () => void) {
  setAshyHostBridgeForTesting(fake.bridge)
  resetAshyStore()
  resetCallStoreForTesting()
  useAshyStore.setState({ needsOnboarding: false, hasCompletedOnboarding: true })
  setup?.()
  await act(async () => {
    root!.render(node)
  })
  await flush()
}

function card(partial: Partial<AgencyPendingCardView> = {}): AgencyPendingCardView {
  return {
    id: 'card-1',
    toolName: 'write_project_note',
    summary: 'Anotar "amanhã tem reunião"',
    argsPreview: '{"text":"amanhã tem reunião"}',
    riskTier: 'staged-confirm',
    voiceApprovable: true,
    createdAt: 1,
    ...partial,
  }
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
  container?.remove()
  container = null
  vi.useRealTimers()
  resetCallStoreForTesting()
  setAshyHostBridgeForTesting(null)
})

describe('Phase 10.3 — push approval cards', () => {
  it('5. hub: agency:pending shows a card (also outside a call) and Aprovar → agency:approve; voice hint only during a call', async () => {
    const fake = createFakeBridge()
    await render(fake, <App />)
    expect(q('hub-call-approvals')).toBeNull()

    await act(async () => fake.emit({ type: 'agency:pending', card: card() }))
    const cards = all('push-approval-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.textContent).toContain('Anotar "amanhã tem reunião"')
    expect(cards[0]!.textContent).toContain('write_project_note')
    // No call → no voice hint.
    expect(q('push-approval-voice-hint')).toBeNull()

    await act(async () => fake.emit({ type: 'call:state', state: callState({ callId: 'c1', status: 'listening' }) }))
    expect(get('push-approval-voice-hint').textContent).toBe('ou diga “pode”, “pode sempre” ou “não”')

    // Re-emitting the same card does not duplicate it.
    await act(async () => fake.emit({ type: 'agency:pending', card: card({ summary: 'Anotar (atualizado)' }) }))
    expect(all('push-approval-card')).toHaveLength(1)

    await act(async () => click(get('btn-card-approve')))
    await flush()
    expect(fake.callsFor('agency:approve')).toHaveLength(1)
    expect(fake.callsFor('agency:approve')[0]![0].payload).toEqual({ cardId: 'card-1', scope: 'once' })
    expect(q('push-approval-card')).toBeNull()
  })

  it('6. Negar → agency:deny; agency:resolved removes the card; blast-radius warning shown and no voice hint', async () => {
    const fake = createFakeBridge()
    await render(fake, <App />)
    await act(async () => {
      fake.emit({ type: 'call:state', state: callState({ callId: 'c1', status: 'listening' }) })
      fake.emit({
        type: 'agency:pending',
        card: card({
          id: 'card-danger',
          blastRadiusWarning: 'Apaga 120 arquivos',
          voiceApprovable: false,
          riskTier: 'destructive',
        }),
      })
      fake.emit({ type: 'agency:pending', card: card({ id: 'card-2' }) })
    })
    expect(all('push-approval-card')).toHaveLength(2)
    expect(get('push-approval-blast-radius').textContent).toContain('Apaga 120 arquivos')
    expect(all('push-approval-voice-hint')).toHaveLength(1) // only card-2

    const dangerDeny = container!.querySelector('[data-testid="btn-card-deny"][data-card-id="card-danger"]')!
    await act(async () => click(dangerDeny))
    await flush()
    expect(fake.callsFor('agency:deny').map(([i]) => i.payload)).toEqual([{ cardId: 'card-danger' }])
    expect(all('push-approval-card').map((el) => el.getAttribute('data-card-id'))).toEqual(['card-2'])

    await act(async () => fake.emit({ type: 'agency:resolved', cardId: 'card-2', status: 'approved', output: 'ok' }))
    expect(q('push-approval-card')).toBeNull()
  })

  it('7. overlay bubble: fed by the push list in addition to the snapshot, deduped by id', async () => {
    const fake = createFakeBridge()
    await render(fake, <App />, () => {
      useAshyStore.setState({
        viewMode: 'stage',
        isTransparentOverlayWindow: true,
        pendingActions: [
          {
            id: 'card-snap',
            toolName: 'write_project_note',
            serverName: 'workspace',
            summary: 'Nota do snapshot',
            argsPreview: '{}',
            riskTier: 'staged-confirm',
            status: 'pending',
            createdAt: 1,
          },
        ] as never,
      })
    })
    const bubble = get('stage-pending-action-bubble')
    expect(bubble.textContent).toContain('(1)')

    await act(async () => {
      fake.emit({ type: 'call:state', state: callState({ callId: 'c1', status: 'listening' }) })
      fake.emit({ type: 'agency:pending', card: card({ id: 'card-snap', summary: 'Nota do snapshot' }) })
      fake.emit({ type: 'agency:pending', card: card({ id: 'card-push', summary: 'Nota só do push' }) })
    })
    const live = get('stage-pending-action-bubble')
    expect(live.textContent).toContain('(2)')
    expect(live.textContent?.match(/Nota do snapshot/g)).toHaveLength(1)
    expect(live.textContent).toContain('Nota só do push')
    // The snapshot entry keeps its own buttons + shows the voice hint from the push data.
    expect(q('btn-stage-approve-once-card-snap')).not.toBeNull()
    expect(q('stage-pending-voice-hint')).not.toBeNull()
    const pushCards = all('push-approval-card')
    expect(pushCards.map((el) => el.getAttribute('data-card-id'))).toEqual(['card-push'])

    await act(async () => click(pushCards[0]!.querySelector('[data-testid="btn-card-deny"]')!))
    await flush()
    expect(fake.callsFor('agency:deny').map(([i]) => i.payload)).toEqual([{ cardId: 'card-push' }])

    // Resolving the snapshot card via push clears it from the bubble too.
    await act(async () => fake.emit({ type: 'agency:resolved', cardId: 'card-snap', status: 'denied' }))
    expect(q('stage-pending-action-bubble')).toBeNull()
  })

  it('8. approve failure keeps the card and reports the error', async () => {
    const fake = createFakeBridge({
      'agency:approve': () => {
        throw new Error('card expirado')
      },
    })
    await render(fake, <App />)
    await act(async () => fake.emit({ type: 'agency:pending', card: card() }))
    await act(async () => click(get('btn-card-approve')))
    await flush()
    expect(all('push-approval-card')).toHaveLength(1)
    expect(useCallStore.getState().lastError).toContain('card expirado')
    expect(useCallStore.getState().resolvingCardIds).toEqual([])
  })

  it('8b. "Sempre permitir" → agency:approve {scope:"always"}; hidden on blast-radius cards (push and snapshot)', async () => {
    const fake = createFakeBridge()
    await render(fake, <App />)
    await act(async () => {
      fake.emit({ type: 'agency:pending', card: card({ id: 'card-ok' }) })
      fake.emit({
        type: 'agency:pending',
        card: card({ id: 'card-danger', blastRadiusWarning: 'Apaga a pasta', voiceApprovable: false }),
      })
    })
    const always = all('btn-card-always')
    expect(always.map((el) => el.getAttribute('data-card-id'))).toEqual(['card-ok'])
    expect(always[0]!.textContent).toBe('Sempre permitir')
    await act(async () => click(always[0]!))
    await flush()
    expect(fake.callsFor('agency:approve').map(([i]) => i.payload)).toEqual([{ cardId: 'card-ok', scope: 'always' }])
    expect(all('push-approval-card').map((el) => el.getAttribute('data-card-id'))).toEqual(['card-danger'])

    // Overlay snapshot entries get the same button (except blast-radius ones).
    await act(async () => {
      root!.unmount()
    })
    root = createRoot(container!)
    const snap = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      toolName: 'write_project_note',
      serverName: 'workspace',
      summary: `Nota ${id}`,
      argsPreview: '{}',
      riskTier: 'staged-confirm',
      status: 'pending',
      createdAt: 1,
      ...extra,
    })
    await render(fake, <App />, () => {
      useAshyStore.setState({
        viewMode: 'stage',
        isTransparentOverlayWindow: true,
        pendingActions: [snap('snap-ok'), snap('snap-danger', { blastRadiusWarning: 'Força push' })] as never,
      })
    })
    const overlayAlways = all('btn-card-always')
    expect(overlayAlways.map((el) => el.getAttribute('data-card-id'))).toEqual(['snap-ok'])
    await act(async () => click(overlayAlways[0]!))
    await flush()
    expect(fake.callsFor('agency:approve').at(-1)![0].payload).toEqual({ cardId: 'snap-ok', scope: 'always' })
    expect(useAshyStore.getState().pendingActions.map((c) => c.id)).toEqual(['snap-danger'])
  })

  it('8c. consent center lists "Ferramentas sempre permitidas" (read-safe overrides) with Revogar', async () => {
    const fake = createFakeBridge()
    await render(fake, <App />, () => {
      useAshyStore.setState({
        toolRiskOverrides: { write_project_note: 'read-safe', run_command: 'staged-confirm' } as never,
      })
    })
    await act(async () => click(get('tab-agency')))
    const list = get('always-allowed-tools')
    expect(list.textContent).toContain('Ferramentas sempre permitidas')
    expect(q('always-allowed-write_project_note')).not.toBeNull()
    expect(q('always-allowed-run_command')).toBeNull()
    await act(async () => click(get('btn-revoke-always-write_project_note')))
    expect(useAshyStore.getState().toolRiskOverrides.write_project_note).toBe('staged-confirm')
    expect(q('always-allowed-write_project_note')).toBeNull()
    expect(q('always-allowed-empty')).not.toBeNull()
  })
})

describe('Phase 10.3 — vision indicator', () => {
  it('9. vision:capture shows "👁 vendo a tela" in hub and overlay, hides on active:false and auto-offs after 5 s', async () => {
    const fake = createFakeBridge()
    await render(fake, <App />)
    expect(q('vision-indicator')).toBeNull()
    await act(async () => fake.emit({ type: 'vision:capture', active: true, source: 'screen' }))
    expect(get('vision-indicator').textContent).toBe('👁 vendo a tela')
    await act(async () => fake.emit({ type: 'vision:capture', active: false, source: 'screen' }))
    expect(q('vision-indicator')).toBeNull()

    // Overlay + auto-off.
    await act(async () => {
      root!.unmount()
    })
    root = createRoot(container!)
    vi.useFakeTimers()
    await render(fake, <App />, () => {
      useAshyStore.setState({ viewMode: 'stage', isTransparentOverlayWindow: true })
    })
    await act(async () => fake.emit({ type: 'vision:capture', active: true, source: 'window' }))
    expect(get('vision-indicator').getAttribute('data-source')).toBe('window')
    await act(async () => {
      vi.advanceTimersByTime(VISION_CAPTURE_AUTO_OFF_MS - 1)
    })
    expect(q('vision-indicator')).not.toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(2)
    })
    expect(q('vision-indicator')).toBeNull()
    expect(useCallStore.getState().capturingScreen).toBe(false)
  })
})

describe('Phase 10.3 — Live Mode › Recursos na chamada', () => {
  it('10. toggles + idle seconds save via liveMode:saveSettings {features}', async () => {
    const fake = createFakeBridge()
    await render(fake, <LiveModeSettingsPanel />)
    const section = get('call-features-section')
    expect(section.textContent).toContain('Recursos na chamada')
    expect(get('call-tools-notice').textContent).toBe(
      'As ferramentas usam o modelo local de 2B; funciona melhor para pedidos simples.',
    )
    const tools = get<HTMLInputElement>('toggle-tools-in-call')
    const vision = get<HTMLInputElement>('toggle-vision-in-call')
    const initiative = get<HTMLInputElement>('toggle-initiative-in-call')
    expect([tools.checked, vision.checked, initiative.checked]).toEqual([false, false, false])

    await act(async () => click(tools))
    await flush()
    await act(async () => click(get('toggle-vision-in-call')))
    await flush()
    await act(async () => click(get('toggle-initiative-in-call')))
    await flush()
    const saves = fake.callsFor('liveMode:saveSettings').map(([i]) => i.payload)
    expect(saves).toEqual([
      { features: { toolsInCall: true } },
      { features: { visionInCall: true } },
      { features: { initiativeInCall: true } },
    ])
    expect(get<HTMLInputElement>('toggle-tools-in-call').checked).toBe(true)
    expect(useCallStore.getState().liveSettings?.features).toMatchObject({
      toolsInCall: true,
      visionInCall: true,
      initiativeInCall: true,
    })

    const idle = get<HTMLInputElement>('input-idle-nudge-sec')
    expect(idle.value).toBe('90')
    expect(idle.min).toBe('20')
    expect(idle.max).toBe('3600')
    await act(async () => {
      setNativeValue(idle, '5')
      idle.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await flush()
    // Clamped to the 20–3600 range.
    expect(fake.callsFor('liveMode:saveSettings').at(-1)![0].payload).toEqual({ features: { idleNudgeSec: 20 } })
    expect(get<HTMLInputElement>('input-idle-nudge-sec').value).toBe('20')

    await act(async () => {
      setNativeValue(get<HTMLInputElement>('input-idle-nudge-sec'), '45')
      get('input-idle-nudge-sec').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await flush()
    expect(fake.callsFor('liveMode:saveSettings').at(-1)![0].payload).toEqual({ features: { idleNudgeSec: 45 } })
  })
})
