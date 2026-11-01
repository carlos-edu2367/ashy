// @vitest-environment jsdom
/**
 * Phase 10.4 / 10.5 — Settings › Live Mode UI for the cloud realtime backends (OpenAI-compatible,
 * Gemini Live, API keys, "Contexto da Ashy na nuvem") and the classic cascade pipeline.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIVE_MODE_SETTINGS,
  IDLE_CALL_STATE,
  type AshyHostBridge,
  type AshyHostStreamEvent,
  type LiveCallInvokeInput,
  type LiveCallMethod,
  type LiveKeyProvider,
  type LiveKeyStatus,
  type LiveModeSettings,
  type LlamaCppEngineStatus,
  type SaveLiveModeSettingsInput,
} from '@ashy/shared'
import { LiveModeSettingsPanel } from '../components/LiveCallControls'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { resetAshyStore } from '../store/useAshyStore'
import { resetCallStoreForTesting, useCallStore } from '../store/useCallStore'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const ENGINE_INSTALLED: LlamaCppEngineStatus = {
  engineId: 'llamacpp',
  build: 'b12024',
  installed: true,
  installedVariant: 'cpu',
  detectedGpu: null,
  running: false,
  managed: true,
  baseUrl: null,
  port: null,
  activeModelId: null,
  installedModelIds: ['lfm3-omni-2b-q4km'],
  activeDownload: null,
  lastError: null,
  vcRuntimeMissing: false,
  vcRuntimeInstall: null,
}

type Handler = (payload: unknown) => unknown

function emptyKeyStatus(): LiveKeyStatus {
  return {
    openai: { hasKey: false, masked: null },
    qwen: { hasKey: false, masked: null },
    custom: { hasKey: false, masked: null },
    gemini: { hasKey: false, masked: null },
  }
}

/** Deep-merges a saveSettings partial the way the host does (enough for these tests). */
function merge(settings: LiveModeSettings, patch: SaveLiveModeSettingsInput): LiveModeSettings {
  const out = structuredClone(settings) as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = { ...((out[key] as Record<string, unknown> | undefined) ?? {}), ...value }
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out as unknown as LiveModeSettings
}

function createFakeHost(opts: { settings?: LiveModeSettings; engine?: LlamaCppEngineStatus | null } = {}) {
  let settings = structuredClone(opts.settings ?? DEFAULT_LIVE_MODE_SETTINGS)
  let keys = emptyKeyStatus()
  const saved: SaveLiveModeSettingsInput[] = []
  const listeners = new Set<(event: AshyHostStreamEvent) => void>()
  const handlers: Partial<Record<LiveCallMethod, Handler>> = {
    'call:getState': () => ({ ...IDLE_CALL_STATE }),
    'engines:getStatus': () =>
      opts.engine === null ? { ...ENGINE_INSTALLED, installed: false, installedVariant: null, installedModelIds: [] } : { ...(opts.engine ?? ENGINE_INSTALLED) },
    'liveMode:getSettings': () => structuredClone(settings),
    'liveMode:saveSettings': (p) => {
      saved.push(p as SaveLiveModeSettingsInput)
      settings = merge(settings, p as SaveLiveModeSettingsInput)
      return structuredClone(settings)
    },
    'liveVoice:list': () => [
      { id: 'minha-voz', name: 'Minha voz', durationMs: 8000, createdAt: 1 },
    ],
    'liveMode:getKeyStatus': () => structuredClone(keys),
    'liveMode:setApiKey': (p) => {
      const { provider, apiKey } = p as { provider: LiveKeyProvider; apiKey: string }
      keys = {
        ...keys,
        [provider]: apiKey ? { hasKey: true, masked: `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}` } : { hasKey: false, masked: null },
      }
      return structuredClone(keys)
    },
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
    saved,
    callsFor(method: LiveCallMethod) {
      return invokeLiveCall.mock.calls.filter(([input]) => input.method === method).map(([input]) => input.payload)
    },
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  container = null
  root = null
  resetCallStoreForTesting()
  setAshyHostBridgeForTesting(null)
})

function q<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return (container?.querySelector(`[data-testid="${testId}"]`) as T | null) ?? null
}
function get<T extends HTMLElement = HTMLElement>(testId: string): T {
  const el = q<T>(testId)
  if (!el) throw new Error(`missing [data-testid="${testId}"]`)
  return el
}
async function click(testId: string): Promise<void> {
  await act(async () => {
    get(testId).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await flush()
}
async function type(testId: string, value: string): Promise<void> {
  const el = get<HTMLInputElement>(testId)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function choose(testId: string, value: string): Promise<void> {
  const el = get<HTMLSelectElement>(testId)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function toggle(testId: string): Promise<void> {
  await act(async () => {
    get<HTMLInputElement>(testId).click()
  })
}
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

async function renderPanel(fake: ReturnType<typeof createFakeHost>) {
  setAshyHostBridgeForTesting(fake.bridge)
  resetAshyStore()
  resetCallStoreForTesting()
  await act(async () => {
    root!.render(<LiveModeSettingsPanel />)
  })
  await flush()
}

function settingsWith(backend: LiveModeSettings['backend'], patch: Partial<LiveModeSettings> = {}): LiveModeSettings {
  return { ...structuredClone(DEFAULT_LIVE_MODE_SETTINGS), backend, ...patch }
}

describe('Phase 10.4/10.5 — Live Mode backend cards', () => {
  it('1. the cloud and cascade cards are enabled; selecting one saves the backend and shows its panel', async () => {
    const fake = createFakeHost()
    await renderPanel(fake)
    for (const id of ['live-backend-openai-realtime', 'live-backend-gemini-live', 'live-backend-cascade']) {
      const card = get<HTMLButtonElement>(id)
      expect(card.disabled).toBe(false)
      expect(card.textContent).not.toContain('em breve')
    }
    expect(get('live-backend-openai-realtime').textContent).toContain('OpenAI Realtime / compatível')
    expect(get('live-backend-openai-realtime').textContent).toContain('requer chave; o áudio vai para o provedor')
    expect(get('live-backend-cascade').textContent).toContain('Pipeline clássica (STT → modelo de texto → voz)')
    expect(get('live-backend-cascade').textContent).toContain('memória e ferramentas da Ashy')
    // Default llama.cpp backend: engine panel, no cloud/cascade panels.
    expect(q('live-engine-panel')).not.toBeNull()
    expect(q('cloud-realtime-panel')).toBeNull()

    await click('live-backend-openai-realtime')
    expect(fake.saved[0]).toEqual({ backend: 'openai-realtime' })
    expect(get('live-backend-openai-realtime').getAttribute('aria-pressed')).toBe('true')
    expect(q('cloud-realtime-panel')).not.toBeNull()
    expect(q('cloud-context-panel')).not.toBeNull()
    expect(q('live-engine-panel')).toBeNull()
    expect(q('select-live-voice')).toBeNull()

    await click('live-backend-gemini-live')
    expect(fake.saved[1]).toEqual({ backend: 'gemini-live' })
    expect(q('gemini-live-panel')).not.toBeNull()
    expect(q('cloud-context-panel')).not.toBeNull()
    expect(q('cloud-realtime-panel')).toBeNull()

    await click('live-backend-cascade')
    expect(fake.saved[2]).toEqual({ backend: 'cascade' })
    expect(q('cascade-panel')).not.toBeNull()
    expect(q('cloud-context-panel')).toBeNull()
  })
})

describe('Phase 10.4 — OpenAI-compatible panel', () => {
  it('2. provider select with preset placeholders; saving sends realtimeCloud + cloudContext (no llamacpp block)', async () => {
    const fake = createFakeHost({
      settings: settingsWith('openai-realtime', {
        realtimeCloud: { provider: 'openai', url: '', model: '', voice: '' },
      }),
    })
    await renderPanel(fake)
    const select = get<HTMLSelectElement>('cloud-provider-select')
    expect([...select.options].map((o) => o.value)).toEqual(['openai', 'qwen', 'custom'])
    expect([...select.options].map((o) => o.textContent)).toContain('Qwen-Omni Realtime (DashScope)')
    expect(get<HTMLInputElement>('cloud-model-input').placeholder).toBe('gpt-realtime-2.1-mini')
    expect(get<HTMLInputElement>('cloud-url-input').placeholder).toBe('wss://api.openai.com/v1/realtime')
    expect(get('cloud-url-hint').textContent).toContain('ws://127.0.0.1')

    await choose('cloud-provider-select', 'qwen')
    expect(get<HTMLInputElement>('cloud-model-input').placeholder).toBe('qwen3.5-omni-flash-realtime')
    expect(get<HTMLInputElement>('cloud-voice-input').placeholder).toBe('Tina')
    expect(q('cloud-key-input-qwen')).not.toBeNull()
    expect(q('cloud-key-input-openai')).toBeNull()

    await type('cloud-model-input', 'qwen3.8-omni-flash-realtime')
    await type('cloud-context-recent', '30')
    await type('cloud-context-memory', '99')
    await toggle('cloud-context-persona')
    await click('btn-live-save-settings')
    const last = fake.saved[fake.saved.length - 1]!
    expect(last.backend).toBe('openai-realtime')
    expect(last.realtimeCloud).toEqual({ provider: 'qwen', url: '', model: 'qwen3.8-omni-flash-realtime', voice: '' })
    expect(last.cloudContext).toEqual({ includePersona: false, recentMessages: 30, memoryTopK: 12, maxInstructionsChars: 16000 })
    expect(last.llamacpp).toBeUndefined()
    expect(last.session).toBeUndefined()
    expect(last.cascade).toBeUndefined()
  })

  it('3. a custom provider accepts a local ws:// URL; an http URL is rejected before saving', async () => {
    const fake = createFakeHost({ settings: settingsWith('openai-realtime') })
    await renderPanel(fake)
    await choose('cloud-provider-select', 'custom')
    // The OpenAI preset model was cleared when switching provider.
    expect(get<HTMLInputElement>('cloud-model-input').value).toBe('')
    expect(get('cloud-key-custom').textContent).toContain('(opcional)')

    await type('cloud-url-input', 'http://example.com/realtime')
    expect(get('cloud-url-hint').textContent).toContain('precisa começar com wss://')
    const before = fake.saved.length
    await click('btn-live-save-settings')
    expect(fake.saved.length).toBe(before)
    expect(get('live-save-notice').textContent).toContain('wss://')

    await type('cloud-url-input', 'ws://127.0.0.1:8765/v1/realtime')
    await type('cloud-model-input', 'omni-local')
    await click('btn-live-save-settings')
    expect(fake.saved[fake.saved.length - 1]!.realtimeCloud).toEqual({
      provider: 'custom',
      url: 'ws://127.0.0.1:8765/v1/realtime',
      model: 'omni-local',
      voice: '',
    })
  })

  it('4. API key: save sends liveMode:setApiKey, the input clears and only the masked status shows; Remover sends empty', async () => {
    const fake = createFakeHost({ settings: settingsWith('openai-realtime') })
    await renderPanel(fake)
    expect(fake.callsFor('liveMode:getKeyStatus').length).toBe(1)
    expect(get('cloud-key-status-openai').textContent).toContain('Nenhuma chave salva')
    expect(get<HTMLInputElement>('cloud-key-input-openai').type).toBe('password')
    expect(get<HTMLButtonElement>('btn-cloud-key-save-openai').disabled).toBe(true)

    const secret = 'sk-test-1234567890abcd'
    await type('cloud-key-input-openai', secret)
    await click('btn-cloud-key-save-openai')
    expect(fake.callsFor('liveMode:setApiKey')).toEqual([{ provider: 'openai', apiKey: secret }])
    expect(get<HTMLInputElement>('cloud-key-input-openai').value).toBe('')
    expect(get('cloud-key-status-openai').textContent).toContain('Chave salva: sk-…abcd')
    // The key is never kept in the store, only the masked status.
    expect(JSON.stringify(useCallStore.getState())).not.toContain(secret)
    expect(useCallStore.getState().keyStatus?.openai).toEqual({ hasKey: true, masked: 'sk-…abcd' })
    expect(container!.textContent).not.toContain(secret)

    await click('btn-cloud-key-remove-openai')
    expect(fake.callsFor('liveMode:setApiKey')[1]).toEqual({ provider: 'openai', apiKey: '' })
    expect(get('cloud-key-status-openai').textContent).toContain('Nenhuma chave salva')
    expect(q('btn-cloud-key-remove-openai')).toBeNull()
  })
})

describe('Phase 10.4 — Gemini panel', () => {
  it('5. Gemini model/voice placeholders, saving gemini + cloudContext, key under provider gemini', async () => {
    const fake = createFakeHost({ settings: settingsWith('gemini-live', { gemini: { model: '', voice: '' } }) })
    await renderPanel(fake)
    expect(get<HTMLInputElement>('gemini-model-input').placeholder).toBe('gemini-3.8-live')
    expect(get<HTMLInputElement>('gemini-voice-input').placeholder).toBe('Kore')
    await type('gemini-voice-input', 'Puck')
    await type('cloud-context-max-chars', '500')
    await click('btn-live-save-settings')
    const last = fake.saved[fake.saved.length - 1]!
    expect(last.gemini).toEqual({ model: '', voice: 'Puck' })
    expect(last.cloudContext).toEqual({ includePersona: true, recentMessages: 12, memoryTopK: 4, maxInstructionsChars: 2000 })
    expect(last.realtimeCloud).toBeUndefined()

    await type('cloud-key-input-gemini', 'AIza-secret-key')
    await click('btn-cloud-key-save-gemini')
    expect(fake.callsFor('liveMode:setApiKey')).toEqual([{ provider: 'gemini', apiKey: 'AIza-secret-key' }])
    expect(get('cloud-key-status-gemini').textContent).toContain('Chave salva:')
  })

  it('6. "Testar chamada" on a cloud backend without the local engine shows a hint and is disabled', async () => {
    const fake = createFakeHost({ settings: settingsWith('gemini-live'), engine: null })
    await renderPanel(fake)
    expect(get<HTMLButtonElement>('btn-live-test-call').disabled).toBe(true)
    expect(get('live-test-engine-hint').textContent).toContain('voz local do llama.cpp')

    const withEngine = createFakeHost({ settings: settingsWith('gemini-live') })
    await renderPanel(withEngine)
    expect(get<HTMLButtonElement>('btn-live-test-call').disabled).toBe(false)
    expect(q('live-test-engine-hint')).toBeNull()
  })
})

describe('Phase 10.5 — cascade panel', () => {
  it('7. STT/LLM/TTS pickers; saving sends the cascade block', async () => {
    const fake = createFakeHost({ settings: settingsWith('cascade') })
    await renderPanel(fake)
    const stt = get<HTMLSelectElement>('cascade-stt-provider')
    expect([...stt.options].map((o) => o.value)).toEqual(
      expect.arrayContaining(['ollama-transcriptions', 'local-whisper-http', 'openai-whisper', 'groq-whisper']),
    )
    expect([...stt.options].map((o) => o.value)).not.toContain('deterministic-wav-stt')
    const llm = get<HTMLSelectElement>('cascade-llm-provider')
    expect(llm.options[0]!.value).toBe('chat-default')
    expect(llm.options[0]!.textContent).toBe('Mesmo modelo do chat')
    expect([...llm.options].map((o) => o.value)).toContain('ollama')
    expect(get<HTMLInputElement>('cascade-llm-model').placeholder).toBe('qwen3:4b-instruct')
    expect(get('cascade-panel').textContent).toContain('pequenos recomendados: qwen3:4b-instruct (Ollama)')
    const tts = get<HTMLSelectElement>('cascade-tts-provider')
    expect([...tts.options].map((o) => o.textContent)).toEqual([
      'Voz local do llama.cpp (LFM3)',
      'Kokoro (servidor local)',
      'OpenAI TTS',
      'ElevenLabs',
    ])
    // llama.cpp voice: female/male select + reference voice from the library.
    expect(get('cascade-tts-voice').tagName).toBe('SELECT')
    const ref = get<HTMLSelectElement>('cascade-reference-voice')
    expect([...ref.options].map((o) => o.value)).toEqual(['', 'minha-voz'])

    await choose('cascade-stt-provider', 'local-whisper-http')
    await choose('cascade-llm-provider', 'ollama')
    await type('cascade-llm-model', ' qwen3:4b-instruct ')
    await choose('cascade-tts-voice', 'male')
    await choose('cascade-reference-voice', 'minha-voz')
    await click('btn-live-save-settings')
    const last = fake.saved[fake.saved.length - 1]!
    expect(last.backend).toBe('cascade')
    expect(last.cascade).toEqual({
      sttProviderId: 'local-whisper-http',
      llmProviderId: 'ollama',
      llmModelId: 'qwen3:4b-instruct',
      ttsProviderId: 'llamacpp-tts',
      ttsVoice: 'male',
      referenceVoiceId: 'minha-voz',
    })
    // Cascade with the llama.cpp voice: only the engine endpoint of the llamacpp block.
    expect(last.llamacpp).toEqual({ endpoint: 'managed' })
    expect(last.realtimeCloud).toBeUndefined()
  })

  it('8. engine panel shows only with the llama.cpp voice (with a hint); other TTS → free-text voice, no reference', async () => {
    const fake = createFakeHost({ settings: settingsWith('cascade') })
    await renderPanel(fake)
    expect(q('live-engine-panel')).not.toBeNull()
    expect(get('live-engine-cascade-hint').textContent).toContain('llama.cpp')

    await choose('cascade-tts-provider', 'openai-tts')
    expect(q('live-engine-panel')).toBeNull()
    expect(get('cascade-tts-voice').tagName).toBe('INPUT')
    expect(get<HTMLInputElement>('cascade-tts-voice').value).toBe('')
    expect(q('cascade-reference-voice')).toBeNull()
    await type('cascade-tts-voice', 'nova')
    await click('btn-live-save-settings')
    const last = fake.saved[fake.saved.length - 1]!
    expect(last.cascade).toMatchObject({ ttsProviderId: 'openai-tts', ttsVoice: 'nova', referenceVoiceId: null })
    expect(last.llamacpp).toBeUndefined()

    await choose('cascade-tts-provider', 'llamacpp-tts')
    expect(q('live-engine-panel')).not.toBeNull()
    expect(get<HTMLSelectElement>('cascade-tts-voice').value).toBe('female')
  })
})
