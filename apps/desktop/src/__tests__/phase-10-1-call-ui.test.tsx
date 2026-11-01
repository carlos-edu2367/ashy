// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIVE_MODE_SETTINGS,
  IDLE_CALL_STATE,
  type AshyHostBridge,
  type AshyHostStreamEvent,
  type CallStateSnapshot,
  type LiveCallInvokeInput,
  type LiveCallMethod,
  type LlamaCppEngineStatus,
} from '@ashy/shared'
import { App } from '../App'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'
import { resetCallStoreForTesting, useCallStore } from '../store/useCallStore'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null
let clock = 1000

function nextStamp(): number {
  clock += 10
  return clock
}

function callState(partial: Partial<CallStateSnapshot>): CallStateSnapshot {
  return { ...IDLE_CALL_STATE, updatedAt: nextStamp(), ...partial }
}

const BASE_ENGINE_STATUS: LlamaCppEngineStatus = {
  engineId: 'llamacpp',
  build: 'b12024',
  installed: false,
  installedVariant: null,
  detectedGpu: { vendor: 'nvidia', name: 'RTX 4060', vramMb: 8192, recommendedVariant: 'cuda-12.4' },
  running: false,
  managed: true,
  baseUrl: null,
  port: null,
  activeModelId: null,
  installedModelIds: [],
  activeDownload: null,
  lastError: null,
  vcRuntimeMissing: false,
  vcRuntimeInstall: null,
}

type Handler = (payload: unknown) => unknown

function createFakeBridge(overrides: Partial<Record<LiveCallMethod, Handler>> = {}) {
  const listeners = new Set<(event: AshyHostStreamEvent) => void>()
  const handlers: Partial<Record<LiveCallMethod, Handler>> = {
    'call:getState': () => callState({}),
    'engines:getStatus': () => ({ ...BASE_ENGINE_STATUS }),
    'liveMode:getSettings': () => structuredClone(DEFAULT_LIVE_MODE_SETTINGS),
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
  // Every other bridge method stays pending: the app bootstrap is irrelevant here.
  const bridge = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop as string]
      if (prop === 'then') return undefined
      return () => new Promise(() => undefined)
    },
  }) as unknown as AshyHostBridge
  return {
    bridge,
    invokeLiveCall,
    emit(event: AshyHostStreamEvent) {
      for (const l of [...listeners]) l(event)
    },
    callsFor(method: LiveCallMethod) {
      return invokeLiveCall.mock.calls.filter(([input]) => input.method === method)
    },
  }
}

function getByTestId<T extends HTMLElement = HTMLElement>(testId: string): T {
  const el = container?.querySelector(`[data-testid="${testId}"]`) as T | null
  if (!el) throw new Error(`Unable to find an element by: [data-testid="${testId}"]`)
  return el
}

function queryByTestId<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return (container?.querySelector(`[data-testid="${testId}"]`) as T | null) ?? null
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function setNativeValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

async function renderApp(fake: ReturnType<typeof createFakeBridge>, setup?: () => void) {
  setAshyHostBridgeForTesting(fake.bridge)
  resetAshyStore()
  resetCallStoreForTesting()
  useAshyStore.setState({ needsOnboarding: false, hasCompletedOnboarding: true })
  setup?.()
  await act(async () => {
    root!.render(<App />)
  })
  await flush()
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
  resetCallStoreForTesting()
  setAshyHostBridgeForTesting(null)
})

describe('Phase 10.1 — Live Call UI (hub orb, overlay, Live Mode settings, stage feed)', () => {
  it('1. the hub orb starts and stops the call via liveCall:invoke and reflects call:state (ring, caption, latency, mute)', async () => {
    const fake = createFakeBridge({
      'call:start': () =>
        callState({ callId: 'call-1', status: 'connecting', backend: 'llamacpp-realtime', sessionId: 's1' }),
      'call:stop': () => callState({}),
      'call:setMuted': (payload) =>
        callState({
          callId: 'call-1',
          status: 'listening',
          muted: (payload as { muted: boolean }).muted,
        }),
    })
    await renderApp(fake)

    const orb = getByTestId('btn-call-toggle')
    expect(orb.getAttribute('data-call-status')).toBe('idle')
    expect(orb.getAttribute('data-call-ring')).toBe('neutral')
    expect(getByTestId('call-status-label').textContent).toBe('Ligar')
    expect(queryByTestId('btn-call-mute')).toBeNull()

    await act(async () => click(orb))
    await flush()
    expect(fake.callsFor('call:start')).toHaveLength(1)
    expect(getByTestId('btn-call-toggle').getAttribute('data-call-ring')).toBe('amber')

    await act(async () => {
      fake.emit({
        type: 'call:state',
        state: callState({
          callId: 'call-1',
          status: 'listening',
          backend: 'llamacpp-realtime',
          caption: { role: 'assistant', text: 'Oi! Tudo bem?', final: true },
          metrics: { e2eMs: 820.4 },
        }),
      })
    })
    expect(getByTestId('btn-call-toggle').getAttribute('data-call-ring')).toBe('green')
    expect(getByTestId('call-caption').textContent).toBe('Ashy: Oi! Tudo bem?')
    expect(getByTestId('call-latency').textContent).toContain('820 ms')
    expect(getByTestId('call-status-label').textContent).toContain('Desligar')

    for (const [status, ring] of [
      ['user_speaking', 'pulse'],
      ['thinking', 'spinner'],
      ['speaking', 'waves'],
      ['reconnecting', 'amber'],
    ] as const) {
      await act(async () => {
        fake.emit({ type: 'call:state', state: callState({ callId: 'call-1', status }) })
      })
      expect(getByTestId('btn-call-toggle').getAttribute('data-call-ring')).toBe(ring)
    }

    await act(async () => click(getByTestId('btn-call-mute')))
    await flush()
    expect(fake.callsFor('call:setMuted')[0]![0].payload).toEqual({ muted: true })
    expect(useCallStore.getState().callState.muted).toBe(true)

    await act(async () => click(getByTestId('btn-call-toggle')))
    await flush()
    expect(fake.callsFor('call:stop')[0]![0].payload).toEqual({ callId: 'call-1' })
    expect(getByTestId('btn-call-toggle').getAttribute('data-call-status')).toBe('idle')
    expect(queryByTestId('call-caption')).toBeNull()
  })

  it('2. shows a short pt-BR message when the call ended with a reason', async () => {
    const fake = createFakeBridge()
    await renderApp(fake)
    await act(async () => {
      fake.emit({
        type: 'call:state',
        state: callState({ status: 'ended', reason: 'engine_not_installed', detail: 'llama.cpp is not installed' }),
      })
    })
    expect(getByTestId('btn-call-toggle').getAttribute('data-call-ring')).toBe('ended')
    expect(getByTestId('call-ended-message').textContent).toBe(
      'Motor local não instalado — abra Configurações › Live Mode',
    )
    // A plain hang-up shows nothing.
    await act(async () => {
      fake.emit({ type: 'call:state', state: callState({ status: 'ended', reason: 'user_hangup' }) })
    })
    expect(queryByTestId('call-ended-message')).toBeNull()
  })

  it('3. overlay quick controls: call toggle + mute + a state dot that stays visible during the call', async () => {
    const fake = createFakeBridge({
      'call:start': () => callState({ callId: 'call-9', status: 'connecting' }),
    })
    await renderApp(fake, () => {
      useAshyStore.setState({ viewMode: 'stage', isTransparentOverlayWindow: true })
    })

    const dot = getByTestId('call-state-dot')
    expect(dot.getAttribute('data-visible')).toBe('false')
    expect(dot.style.opacity).toBe('0')
    expect(getByTestId<HTMLButtonElement>('btn-call-mute').disabled).toBe(true)
    const island = getByTestId('stage-quick-controls')
    expect(island.getAttribute('data-ui-island')).toBe('true')
    expect(island.contains(getByTestId('btn-call-toggle'))).toBe(true)
    expect(dot.getAttribute('data-ui-island')).toBe('true')

    await act(async () => click(getByTestId('btn-call-toggle')))
    await flush()
    expect(fake.callsFor('call:start')).toHaveLength(1)

    await act(async () => {
      fake.emit({ type: 'call:state', state: callState({ callId: 'call-9', status: 'speaking' }) })
    })
    const liveDot = getByTestId('call-state-dot')
    expect(liveDot.getAttribute('data-visible')).toBe('true')
    expect(liveDot.style.opacity).toBe('1')
    expect(liveDot.getAttribute('data-call-status')).toBe('speaking')
    expect(getByTestId<HTMLButtonElement>('btn-call-mute').disabled).toBe(false)
    // Without hover the quick-controls island itself is still hidden.
    expect(getByTestId('stage-quick-controls').style.opacity).toBe('0')

    await act(async () => {
      fake.emit({ type: 'call:state', state: callState({ status: 'idle' }) })
    })
    expect(getByTestId('call-state-dot').style.opacity).toBe('0')
  })

  it('4. Live Mode tab: backend cards, engine install progress, variant override, model download and save settings', async () => {
    const savedPayloads: unknown[] = []
    const fake = createFakeBridge({
      'engines:install': () => ({ ...BASE_ENGINE_STATUS, installed: true, installedVariant: 'vulkan' }),
      'engines:downloadModel': () => ({ ...BASE_ENGINE_STATUS }),
      'engines:start': () => ({ ...BASE_ENGINE_STATUS, installed: true, running: true, port: 51234 }),
      'liveMode:saveSettings': (payload) => {
        savedPayloads.push(payload)
        const p = payload as { llamacpp?: { voice?: 'female' | 'male' } }
        return {
          ...structuredClone(DEFAULT_LIVE_MODE_SETTINGS),
          llamacpp: { ...DEFAULT_LIVE_MODE_SETTINGS.llamacpp, voice: p.llamacpp?.voice ?? 'female' },
        }
      },
    })
    await renderApp(fake, () => {
      useAshyStore.setState({ activeTab: 'agency', settingsSubTab: 'live' })
    })

    expect(getByTestId('live-mode-panel')).toBeTruthy()
    expect(getByTestId<HTMLButtonElement>('live-backend-card-llamacpp-realtime').disabled).toBe(false)
    // Phase 10.4/10.5: the cloud and cascade backends are enabled too.
    for (const id of ['gemini-live', 'openai-realtime', 'cascade']) {
      const card = getByTestId<HTMLButtonElement>(`live-backend-${id}`)
      expect(card.disabled).toBe(false)
      expect(card.textContent).not.toContain('em breve')
    }
    expect(getByTestId('live-engine-gpu').textContent).toContain('RTX 4060')
    expect(getByTestId('live-engine-gpu').textContent).toContain('CUDA 12.4')
    expect(getByTestId('live-engine-build').textContent).toContain('b12024')
    expect(getByTestId('live-engine-state').textContent).toBe('Não instalado')
    expect(container!.textContent).toContain('reaproveita o modelo do Ollama se já')

    await act(async () => {
      fake.emit({
        type: 'engine:status',
        status: {
          ...BASE_ENGINE_STATUS,
          activeDownload: {
            fileName: 'llama-b12024-bin-win-cuda-12.4-x64.zip',
            phase: 'binary',
            status: 'downloading',
            completedBytes: 120 * 1024 * 1024,
            totalBytes: 267 * 1024 * 1024,
            percent: 44.9,
          },
        },
      })
    })
    const progress = getByTestId('live-engine-progress').textContent ?? ''
    expect(progress).toContain('llama-b12024-bin-win-cuda-12.4-x64.zip')
    expect(progress).toContain('45%')
    expect(progress).toContain('120 MB / 267 MB')

    await act(async () => setNativeValue(getByTestId('select-live-engine-variant'), 'vulkan'))
    await act(async () => click(getByTestId('btn-live-install-engine')))
    await flush()
    expect(fake.callsFor('engines:install')[0]![0].payload).toEqual({ engineId: 'llamacpp', variant: 'vulkan' })
    expect(getByTestId('live-engine-state').textContent).toBe('Instalado (parado)')

    await act(async () => click(getByTestId('btn-live-download-model')))
    await flush()
    expect(fake.callsFor('engines:downloadModel')[0]![0].payload).toEqual({ modelId: 'lfm3-omni-2b-q4km' })

    await act(async () => click(getByTestId('btn-live-engine-start')))
    await flush()
    expect(fake.callsFor('engines:start')).toHaveLength(1)
    expect(getByTestId('live-engine-state').textContent).toBe('Rodando na porta 51234')

    await act(async () => setNativeValue(getByTestId('select-live-voice'), 'male'))
    await act(async () => setNativeValue(getByTestId('select-live-input-mode'), 'audio-direct'))
    await act(async () => setNativeValue(getByTestId('input-live-endpoint-ms'), '900'))
    await act(async () => setNativeValue(getByTestId('input-live-vad-threshold'), '0.65'))
    await act(async () => click(getByTestId('btn-live-save-settings')))
    await flush()
    expect(savedPayloads).toHaveLength(1)
    expect(savedPayloads[0]).toMatchObject({
      backend: 'llamacpp-realtime',
      llamacpp: { voice: 'male', inputMode: 'audio-direct', endpoint: 'managed' },
      turn: { vadThreshold: 0.65, endpointMs: 900 },
    })
    expect(getByTestId('live-save-notice').textContent).toContain('salvas')
    expect(useCallStore.getState().liveSettings?.llamacpp.voice).toBe('male')

    // Custom endpoint URL
    await act(async () => click(getByTestId('radio-live-endpoint-url')))
    await act(async () => setNativeValue(getByTestId('input-live-endpoint-url'), 'http://127.0.0.1:8080'))
    await act(async () => click(getByTestId('btn-live-save-settings')))
    await flush()
    expect(savedPayloads[1]).toMatchObject({ llamacpp: { endpoint: { url: 'http://127.0.0.1:8080' } } })
  })

  it('5. call:viseme drives the stage lip-sync fields only while a call is active', async () => {
    const fake = createFakeBridge()
    await renderApp(fake)
    const before = useAshyStore.getState().simulatedVowels

    await act(async () => {
      fake.emit({ type: 'call:viseme', A: 0.9, E: 0.1, I: 0, O: 0.2, U: 0, volume: 0.7 })
    })
    expect(useAshyStore.getState().simulatedVowels).toEqual(before)
    expect(useAshyStore.getState().isSpeaking).toBe(false)

    await act(async () => {
      fake.emit({ type: 'call:state', state: callState({ callId: 'c', status: 'speaking' }) })
      fake.emit({ type: 'call:viseme', A: 0.9, E: 0.1, I: 0, O: 0.2, U: 0, volume: 0.7 })
    })
    const live = useAshyStore.getState()
    expect(live.simulatedVowels).toEqual({ A: 0.9, E: 0.1, I: 0, O: 0.2, U: 0 })
    expect(live.activeViseme).toBe('A')
    expect(live.rawVolume).toBeCloseTo(0.7)
    expect(live.isSpeaking).toBe(true)

    await act(async () => {
      fake.emit({ type: 'call:state', state: callState({ status: 'idle' }) })
    })
    const after = useAshyStore.getState()
    expect(after.isSpeaking).toBe(false)
    expect(after.simulatedVowels).toEqual({ A: 0, E: 0, I: 0, O: 0, U: 0 })
    expect(after.activeViseme).toBe('closed')

    // Idle again: frames are ignored.
    await act(async () => {
      fake.emit({ type: 'call:viseme', A: 0.5, E: 0.5, I: 0, O: 0, U: 0, volume: 0.5 })
    })
    expect(useAshyStore.getState().simulatedVowels).toEqual({ A: 0, E: 0, I: 0, O: 0, U: 0 })
  })

  it('7. Visual C++ runtime missing: notice + install button + progress + reboot hint, Iniciar disabled; engines:start error maps to the same notice', async () => {
    const VC_TEXT = 'Falta um componente da Microsoft (Visual C++ Runtime) para rodar o motor local.'
    let startShouldFail = true
    const fake = createFakeBridge({
      'engines:getStatus': () => ({ ...BASE_ENGINE_STATUS, installed: true, installedVariant: 'cuda-12.4' }),
      'engines:start': () => {
        if (startShouldFail) throw new Error('LLAMACPP_VC_RUNTIME_MISSING: vcruntime140.dll not found')
        return { ...BASE_ENGINE_STATUS, installed: true, running: true, port: 5000 }
      },
      ['engines:installVcRuntime']: () => ({
        ...BASE_ENGINE_STATUS,
        installed: true,
        vcRuntimeMissing: true,
        vcRuntimeInstall: { status: 'downloading', percent: 10 },
      }),
    })
    await renderApp(fake, () => {
      useAshyStore.setState({ activeTab: 'agency', settingsSubTab: 'live' })
    })
    expect(queryByTestId('live-vc-runtime-notice')).toBeNull()

    // (a) engines:start fails with the typed code -> same notice, Iniciar disabled.
    await act(async () => click(getByTestId('btn-live-engine-start')))
    await flush()
    expect(getByTestId('live-vc-runtime-notice').textContent).toContain(VC_TEXT)
    expect(getByTestId<HTMLButtonElement>('btn-live-engine-start').disabled).toBe(true)

    // (b) status flag drives the notice; install shows progress.
    await act(async () => click(getByTestId('btn-install-vc-runtime')))
    await flush()
    expect(fake.callsFor('engines:installVcRuntime')).toHaveLength(1)
    expect(getByTestId('live-vc-runtime-status').textContent).toContain('10%')
    expect(getByTestId('live-vc-runtime-notice').textContent).toContain(
      'Baixado do site oficial da Microsoft; o Windows vai pedir permissão de administrador uma vez.',
    )
    expect(getByTestId<HTMLButtonElement>('btn-install-vc-runtime').disabled).toBe(true)

    await act(async () => {
      fake.emit({
        type: 'engine:status',
        status: {
          ...BASE_ENGINE_STATUS,
          installed: true,
          vcRuntimeMissing: true,
          vcRuntimeInstall: { status: 'installing', percent: 80 },
        },
      })
    })
    expect(getByTestId('live-vc-runtime-status').textContent).toContain('Instalando')
    expect(getByTestId<HTMLButtonElement>('btn-live-engine-start').disabled).toBe(true)

    await act(async () => {
      fake.emit({
        type: 'engine:status',
        status: {
          ...BASE_ENGINE_STATUS,
          installed: true,
          vcRuntimeMissing: false,
          vcRuntimeInstall: { status: 'completed', rebootRequired: true },
        },
      })
    })
    expect(getByTestId('live-vc-runtime-reboot').textContent).toBe('Reinicie o computador para concluir')
    expect(queryByTestId('btn-install-vc-runtime')).toBeNull()
    expect(getByTestId<HTMLButtonElement>('btn-live-engine-start').disabled).toBe(false)

    startShouldFail = false
    await act(async () => click(getByTestId('btn-live-engine-start')))
    await flush()
    expect(getByTestId('live-engine-state').textContent).toBe('Rodando na porta 5000')
  })

  it('6. chat:appended refreshes the active session messages from the host', async () => {
    const fake = createFakeBridge()
    await renderApp(fake)
    const spy = vi.spyOn(useAshyStore.getState(), 'bootstrapFromHost').mockResolvedValue(
      undefined as never,
    )
    await act(async () => {
      useAshyStore.setState({ activeSessionId: 'sess-a', bootstrapFromHost: spy as never })
    })
    await act(async () => {
      fake.emit({ type: 'chat:appended', sessionId: 'sess-b', messageIds: ['m1'] })
    })
    expect(spy).not.toHaveBeenCalled()
    await act(async () => {
      fake.emit({ type: 'chat:appended', sessionId: 'sess-a', messageIds: ['m1', 'm2'] })
    })
    await flush()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
