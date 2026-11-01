// @vitest-environment jsdom
/**
 * Phase 10.2 — T3: llama-server API key (engine), header injection into the call window
 * (Electron main) and the Live Mode UI additions (hybrid card, reference voices, test call,
 * `call:stage` → stage emotion).
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIVE_MODE_SETTINGS,
  IDLE_CALL_STATE,
  LLAMACPP_PINNED_BUILD,
  type AshyHostBridge,
  type AshyHostStreamEvent,
  type CallStateSnapshot,
  type CallTestResult,
  type LiveCallInvokeInput,
  type LiveCallMethod,
  type LiveLocalModelSpec,
  type LiveModeSettings,
  type LlamaCppEngineStatus,
  type PinnedDownloadAsset,
  type VoiceReference,
} from '@ashy/shared'
import { LiveModeSettingsPanel } from '../components/LiveCallControls'
import {
  createLlamaCppEngine,
  type LlamaCppCatalog,
  type LlamaCppChildProcess,
  type LlamaCppSpawnImpl,
} from '../host/engines/llamacpp-engine'
import {
  bootAshyElectronMain,
  createCallWindowController,
  engineAuthUrlPatterns,
  installScopedRequestHeaders,
  isEngineRequestUrl,
  type ElectronBeforeSendHeadersDetailsLike,
  type ElectronBeforeSendHeadersListenerLike,
  type EngineAuthLike,
} from '../main/index'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import {
  encodePcm16Wav,
  findVoicedRange,
  normalizeVoiceReference,
  type VoiceReferenceAudioDeps,
} from '../services/voice-reference-audio'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'
import {
  resetCallStoreForTesting,
  setVoiceAudioDepsForTesting,
  setWavPlayerForTesting,
  useCallStore,
} from '../store/useCallStore'

// These tests describe the llama.cpp realtime UI; the app default is hybrid since 10.5.
const REALTIME_DEFAULTS: LiveModeSettings = { ...DEFAULT_LIVE_MODE_SETTINGS, backend: 'llamacpp-realtime' }

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const tempDirs: string[] = []
const disposers: Array<() => Promise<void> | void> = []

function tmpDir(prefix = 'ashy-p10-2-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!()
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

// ───────────────────────────── engine fixtures ─────────────────────────────

const asset = (fileName: string): PinnedDownloadAsset => ({
  url: `https://dl.example.test/${fileName}`,
  fileName,
  sizeBytes: 1,
  sha256: '0'.repeat(64),
})
const testModel: LiveLocalModelSpec = {
  id: 'test-omni',
  label: 'Test Omni',
  repo: 'TestOrg/Test-GGUF',
  revision: 'abc',
  model: asset('Test.gguf'),
  mmproj: asset('mmproj-Test.gguf'),
  contextSize: 4096,
  capabilities: { audioIn: true, audioOut: true, imageIn: true, tools: false },
}
const catalog: LlamaCppCatalog = {
  releaseAssets: { 'cuda-12.4': [asset('a.zip')], vulkan: [asset('b.zip')], cpu: [asset('c.zip')] },
  models: [testModel],
}

class FakeChild extends EventEmitter implements LlamaCppChildProcess {
  readonly pid = 4242
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  kill(): boolean {
    if (this.exitCode !== null) return false
    setTimeout(() => this.crash(1), 1)
    return true
  }
  crash(code: number): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

function seedEngine(userDataDir: string): void {
  const dir = path.join(userDataDir, 'engines', 'llama.cpp', `${LLAMACPP_PINNED_BUILD}-cpu`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake-exe')
  fs.writeFileSync(path.join(userDataDir, 'engines', 'llama.cpp', 'state.json'), JSON.stringify({ variant: 'cpu' }))
  const repoDir = path.join(userDataDir, 'models', 'TestOrg', 'Test-GGUF')
  fs.mkdirSync(repoDir, { recursive: true })
  const modelPath = path.join(repoDir, 'Test.gguf')
  const mmprojPath = path.join(repoDir, 'mmproj-Test.gguf')
  fs.writeFileSync(modelPath, 'm')
  fs.writeFileSync(mmprojPath, 'p')
  fs.writeFileSync(
    path.join(userDataDir, 'models', 'models.json'),
    JSON.stringify({
      version: 1,
      models: {
        [testModel.id]: {
          modelPath,
          mmprojPath,
          source: { model: 'download', mmproj: 'download' },
          installedAt: new Date().toISOString(),
        },
      },
    }),
  )
}

function makeEngine(endpoint: LiveModeSettings['llamacpp']['endpoint'] = 'managed') {
  const userDataDir = tmpDir()
  seedEngine(userDataDir)
  const statuses: LlamaCppEngineStatus[] = []
  const spawns: Array<{ args: string[]; env: Record<string, string> | undefined; child: FakeChild }> = []
  const spawnImpl: LlamaCppSpawnImpl = (_cmd, args, options) => {
    const child = new FakeChild()
    spawns.push({ args, env: options.env, child })
    return child
  }
  const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), headers: { ...((init?.headers as Record<string, string>) ?? {}) } })
    return new Response('{"status":"ok"}', { status: 200 })
  }) as typeof fetch
  let port = 47000
  const settings: LiveModeSettings = {
    ...DEFAULT_LIVE_MODE_SETTINGS,
    llamacpp: { ...DEFAULT_LIVE_MODE_SETTINGS.llamacpp, modelId: testModel.id, endpoint },
  }
  const engine = createLlamaCppEngine({
    userDataDir,
    platform: 'win32',
    tarPath: 'tar',
    catalog,
    ollamaModelsDir: null,
    getFreePort: async () => ++port,
    healthIntervalMs: 1,
    restartBackoffMs: [1],
    sleep: async () => undefined,
    spawnImpl,
    fetchImpl,
    getSettings: () => settings,
    onStatus: (s) => statuses.push(s),
  })
  disposers.push(() => engine.dispose())
  return { engine, statuses, spawns, fetchCalls, userDataDir }
}

describe('Phase 10.2 — llama-server API key (engine)', () => {
  it('1. generates a 32-byte hex key per launch, passes it ONLY via LLAMA_API_KEY env and never in status/log', async () => {
    const { engine, statuses, spawns, fetchCalls, userDataDir } = makeEngine()
    expect(engine.getRequestHeaders()).toEqual({})
    expect(engine.getAuth()).toBeNull()

    const status = await engine.start()
    expect(spawns).toHaveLength(1)
    const key = spawns[0]!.env?.LLAMA_API_KEY
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(spawns[0]!.args).not.toContain('--api-key')
    expect(spawns[0]!.args.join(' ')).not.toContain(key!)

    expect(engine.getRequestHeaders()).toEqual({ Authorization: `Bearer ${key}` })
    expect(engine.getAuth()).toEqual({
      origin: `http://127.0.0.1:${status.port}`,
      port: status.port,
      headers: { Authorization: `Bearer ${key}` },
    })

    // /health stays public: the engine's health probe carries no key.
    expect(fetchCalls.every((c) => !('Authorization' in c.headers))).toBe(true)

    // The key never shows up in any status snapshot/event or in the log.
    const serialized = JSON.stringify([...statuses, engine.getStatus()])
    expect(serialized).not.toContain(key!)
    const logPath = path.join(userDataDir, 'logs', 'llama-server.log')
    await vi.waitFor(() => expect(fs.readFileSync(logPath, 'utf8')).toContain('starting llama-server.exe'))
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain(key!)

    // A new launch (restart after stop) rotates the key; stop clears it.
    await engine.stop()
    expect(engine.getRequestHeaders()).toEqual({})
    expect(engine.getAuth()).toBeNull()
    await engine.start()
    const key2 = spawns[1]!.env?.LLAMA_API_KEY
    expect(key2).toMatch(/^[0-9a-f]{64}$/)
    expect(key2).not.toBe(key)
    expect(engine.getRequestHeaders()).toEqual({ Authorization: `Bearer ${key2}` })
  })

  it('2. a crash drops the key; the auto-restart uses a fresh one', async () => {
    const { engine, spawns } = makeEngine()
    await engine.start()
    const key = spawns[0]!.env!.LLAMA_API_KEY!
    spawns[0]!.child.crash(3)
    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    await vi.waitFor(() => expect(engine.getStatus().running).toBe(true))
    const key2 = spawns[1]!.env!.LLAMA_API_KEY!
    expect(key2).not.toBe(key)
    expect(engine.getRequestHeaders()).toEqual({ Authorization: `Bearer ${key2}` })
  })

  it('3. a user-provided endpoint gets no key and no injection target', async () => {
    const { engine, spawns } = makeEngine({ url: 'http://127.0.0.1:8080' })
    const status = await engine.start()
    expect(status.running).toBe(true)
    expect(spawns).toHaveLength(0)
    expect(engine.getRequestHeaders()).toEqual({})
    expect(engine.getAuth()).toBeNull()
  })
})

// ───────────────────────────── main: header injection ─────────────────────────────

function makeWebRequestSession() {
  const webRequest = {
    filter: null as { urls: string[] } | null,
    listener: null as ElectronBeforeSendHeadersListenerLike | null,
    onBeforeSendHeaders: vi.fn(
      (
        filterOrListener: { urls: string[] } | ElectronBeforeSendHeadersListenerLike | null,
        maybeListener?: ElectronBeforeSendHeadersListenerLike | null,
      ) => {
        if (typeof filterOrListener === 'function' || filterOrListener === null) {
          webRequest.filter = null
          webRequest.listener = (filterOrListener as ElectronBeforeSendHeadersListenerLike | null) ?? null
        } else {
          webRequest.filter = filterOrListener
          webRequest.listener = maybeListener ?? null
        }
      },
    ),
  }
  const session = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    webRequest,
  }
  /** Mimics Electron: only requests matching the filter reach the listener. */
  const send = (details: Partial<ElectronBeforeSendHeadersDetailsLike> & { url: string }) => {
    const full: ElectronBeforeSendHeadersDetailsLike = { requestHeaders: { 'User-Agent': 'x' }, ...details }
    const matches =
      webRequest.listener &&
      webRequest.filter?.urls.some((p) => new RegExp(`^${p.replace(/[.?]/g, '\\$&').replace(/\*/g, '.*')}$`).test(full.url))
    if (!matches) return full.requestHeaders
    let out: Record<string, string> | undefined
    webRequest.listener!(full, (res) => {
      out = res.requestHeaders ?? full.requestHeaders
    })
    return out!
  }
  return { session, webRequest, send }
}

function makeWindowClass(session: unknown) {
  const created: Array<{ webContents: { id: number }; destroy: () => void; finish: () => void }> = []
  let nextId = 300
  class FakeWin {
    destroyed = false
    closed: Array<() => void> = []
    finishers: Array<() => void> = []
    webContents: Record<string, unknown>
    loadURL = vi.fn(async () => undefined)
    constructor() {
      this.webContents = {
        id: nextId++,
        session,
        isDestroyed: () => this.destroyed,
        send: vi.fn(),
        on: vi.fn(),
        once: vi.fn((ev: string, l: () => void) => {
          if (ev === 'did-finish-load') this.finishers.push(l)
        }),
        setWindowOpenHandler: vi.fn(),
      }
      created.push(this as never)
    }
    destroy = () => {
      this.destroyed = true
      for (const l of this.closed) l()
    }
    finish = () => {
      for (const l of this.finishers) l()
    }
    isDestroyed() {
      return this.destroyed
    }
    on(ev: string, l: () => void) {
      if (ev === 'closed') this.closed.push(l)
    }
  }
  return { FakeWin, created }
}

describe('Phase 10.2 — call window auth header injection (Electron main)', () => {
  it('4. URL helpers: only http/ws on 127.0.0.1:<engine port>', () => {
    const auth: EngineAuthLike = { origin: 'http://127.0.0.1:47001', port: 47001, headers: { Authorization: 'Bearer k' } }
    expect(engineAuthUrlPatterns(auth)).toEqual(['http://127.0.0.1:47001/*', 'ws://127.0.0.1:47001/*'])
    expect(engineAuthUrlPatterns(null)).toEqual([])
    expect(isEngineRequestUrl('ws://127.0.0.1:47001/v1/realtime', auth)).toBe(true)
    expect(isEngineRequestUrl('http://127.0.0.1:47001/tts', auth)).toBe(true)
    expect(isEngineRequestUrl('http://127.0.0.1:47002/tts', auth)).toBe(false)
    expect(isEngineRequestUrl('http://localhost:47001/tts', auth)).toBe(false)
    expect(isEngineRequestUrl('https://127.0.0.1:47001/tts', auth)).toBe(false)
    expect(isEngineRequestUrl('http://evil.test/?u=http://127.0.0.1:47001', auth)).toBe(false)
  })

  it('5. injects Authorization only for the call window and only to the engine port; refreshes on port change', async () => {
    const { session, webRequest, send } = makeWebRequestSession()
    const { FakeWin, created } = makeWindowClass(session)
    let auth: EngineAuthLike | null = null
    const controller = createCallWindowController({
      BrowserWindow: FakeWin as never,
      preloadPath: '/p.cjs',
      url: 'http://127.0.0.1:4000?view=call-engine',
      getEngineAuth: () => auth,
    })
    const ensured = controller.ensure()
    created[0]!.finish()
    await ensured
    const callWcId = created[0]!.webContents.id
    const hubWcId = 1

    // No engine yet → no listener at all.
    expect(webRequest.listener).toBeNull()

    auth = { origin: 'http://127.0.0.1:47001', port: 47001, headers: { Authorization: 'Bearer key-1' } }
    controller.refreshEngineAuth()
    expect(webRequest.filter).toEqual({ urls: ['http://127.0.0.1:47001/*', 'ws://127.0.0.1:47001/*'] })

    // call window → engine WS upgrade and HTTP: injected
    expect(send({ url: 'ws://127.0.0.1:47001/v1/realtime', webContentsId: callWcId, resourceType: 'webSocket' })).toEqual({
      'User-Agent': 'x',
      Authorization: 'Bearer key-1',
    })
    expect(send({ url: 'http://127.0.0.1:47001/health', webContentsId: callWcId })).toMatchObject({
      Authorization: 'Bearer key-1',
    })
    // another window (hub/overlay) → untouched
    expect(send({ url: 'ws://127.0.0.1:47001/v1/realtime', webContentsId: hubWcId })).toEqual({ 'User-Agent': 'x' })
    // no webContents (e.g. service worker / main-process net) → untouched
    expect(send({ url: 'http://127.0.0.1:47001/tts' })).toEqual({ 'User-Agent': 'x' })
    // other port → untouched (even from the call window)
    expect(send({ url: 'http://127.0.0.1:5173/x', webContentsId: callWcId })).toEqual({ 'User-Agent': 'x' })

    // engine restarted on another port with a new key → filter + header follow
    auth = { origin: 'http://127.0.0.1:47002', port: 47002, headers: { Authorization: 'Bearer key-2' } }
    controller.refreshEngineAuth()
    expect(webRequest.filter).toEqual({ urls: ['http://127.0.0.1:47002/*', 'ws://127.0.0.1:47002/*'] })
    expect(send({ url: 'ws://127.0.0.1:47001/v1/realtime', webContentsId: callWcId })).toEqual({ 'User-Agent': 'x' })
    expect(send({ url: 'ws://127.0.0.1:47002/v1/realtime', webContentsId: callWcId })).toMatchObject({
      Authorization: 'Bearer key-2',
    })

    // engine stopped → listener removed
    auth = null
    controller.refreshEngineAuth()
    expect(webRequest.listener).toBeNull()

    // window destroyed → scope released (no injection even if the engine comes back)
    auth = { origin: 'http://127.0.0.1:47003', port: 47003, headers: { Authorization: 'Bearer key-3' } }
    controller.refreshEngineAuth()
    expect(webRequest.listener).not.toBeNull()
    controller.destroy()
    expect(webRequest.listener).toBeNull()
  })

  it('6. the per-session router composes scopes instead of clobbering the single Electron listener', () => {
    const { session, webRequest, send } = makeWebRequestSession()
    const a = installScopedRequestHeaders(session, {
      urls: () => ['http://127.0.0.1:1111/*'],
      headersFor: (d) => (d.webContentsId === 7 ? { 'X-A': '1' } : null),
    })
    const b = installScopedRequestHeaders(session, {
      urls: () => ['http://127.0.0.1:2222/*'],
      headersFor: (d) => (d.webContentsId === 8 ? { 'X-B': '1' } : null),
    })
    expect(webRequest.filter?.urls).toEqual(['http://127.0.0.1:1111/*', 'http://127.0.0.1:2222/*'])
    expect(send({ url: 'http://127.0.0.1:1111/x', webContentsId: 7 })).toMatchObject({ 'X-A': '1' })
    expect(send({ url: 'http://127.0.0.1:2222/x', webContentsId: 8 })).toMatchObject({ 'X-B': '1' })
    a.dispose()
    expect(webRequest.filter?.urls).toEqual(['http://127.0.0.1:2222/*'])
    b.dispose()
    expect(webRequest.listener).toBeNull()
  })

  it('7. bootAshyElectronMain wires kernel.liveCall.getEngineAuth() and refreshes on engine:status', async () => {
    const dir = tmpDir('ashy-p10-2-main-')
    const { session, webRequest, send } = makeWebRequestSession()
    const { FakeWin, created } = makeWindowClass(session)
    const booted = await bootAshyElectronMain({
      app: { getPath: () => dir, on: vi.fn() },
      BrowserWindow: FakeWin as never,
      ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
      rendererUrl: 'http://localhost:5173',
      session: session as never,
    })
    try {
      const kernel = booted.kernel
      let auth: EngineAuthLike | null = null
      vi.spyOn(kernel.liveCall, 'getEngineAuth').mockImplementation(() => auth)
      const controller = kernel.liveCall.getCallWindowController()!
      const ensured = controller.ensure()
      created[2]!.finish()
      await ensured
      expect(webRequest.listener).toBeNull()

      auth = { origin: 'http://127.0.0.1:47123', port: 47123, headers: { Authorization: 'Bearer boot-key' } }
      const status = {
        engineId: 'llamacpp',
        build: 'b12024',
        installed: true,
        installedVariant: 'cpu',
        detectedGpu: null,
        running: true,
        managed: true,
        baseUrl: 'http://127.0.0.1:47123',
        port: 47123,
        activeModelId: 'x',
        installedModelIds: [],
        activeDownload: null,
        lastError: null,
        vcRuntimeMissing: false,
        vcRuntimeInstall: null,
      } satisfies LlamaCppEngineStatus
      kernel.liveCall.emit({ type: 'engine:status', status })
      expect(webRequest.filter?.urls).toContain('ws://127.0.0.1:47123/*')
      const callWcId = created[2]!.webContents.id
      expect(send({ url: 'ws://127.0.0.1:47123/v1/realtime', webContentsId: callWcId })).toMatchObject({
        Authorization: 'Bearer boot-key',
      })
      const hubWcId = created[0]!.webContents.id
      expect(send({ url: 'ws://127.0.0.1:47123/v1/realtime', webContentsId: hubWcId })).not.toHaveProperty(
        'Authorization',
      )
      // The engine:status event broadcast to every renderer carries no key.
      for (const win of created) {
        const sendSpy = (win.webContents as unknown as { send: ReturnType<typeof vi.fn> }).send
        expect(JSON.stringify(sendSpy.mock.calls)).not.toContain('boot-key')
      }
    } finally {
      await booted.shutdown()
    }
  })
})

// ───────────────────────────── UI ─────────────────────────────

let container: HTMLDivElement | null = null
let root: Root | null = null
let clock = 1000

function callState(partial: Partial<CallStateSnapshot>): CallStateSnapshot {
  clock += 10
  return { ...IDLE_CALL_STATE, updatedAt: clock, ...partial }
}

const ENGINE_STATUS: LlamaCppEngineStatus = {
  engineId: 'llamacpp',
  build: 'b12024',
  installed: true,
  installedVariant: 'cpu',
  detectedGpu: null,
  running: true,
  managed: true,
  baseUrl: 'http://127.0.0.1:47000',
  port: 47000,
  activeModelId: 'lfm3-omni-2b-q4km',
  installedModelIds: ['lfm3-omni-2b-q4km'],
  activeDownload: null,
  lastError: null,
  vcRuntimeMissing: false,
  vcRuntimeInstall: null,
}

type Handler = (payload: unknown) => unknown

function hybridSettings(referenceVoiceId: string | null = null): LiveModeSettings {
  const s = structuredClone(REALTIME_DEFAULTS)
  s.backend = 'llamacpp-hybrid'
  s.hybrid.referenceVoiceId = referenceVoiceId
  return s
}

function createFakeBridge(overrides: Partial<Record<LiveCallMethod, Handler>> = {}) {
  const listeners = new Set<(event: AshyHostStreamEvent) => void>()
  const handlers: Partial<Record<LiveCallMethod, Handler>> = {
    'call:getState': () => callState({}),
    'engines:getStatus': () => ({ ...ENGINE_STATUS }),
    'liveMode:getSettings': () => structuredClone(REALTIME_DEFAULTS),
    'liveVoice:list': () => [],
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
    handlers,
    emit(event: AshyHostStreamEvent) {
      for (const l of [...listeners]) l(event)
    },
    callsFor(method: LiveCallMethod) {
      return invokeLiveCall.mock.calls.filter(([input]) => input.method === method)
    },
  }
}

function q<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return (container?.querySelector(`[data-testid="${testId}"]`) as T | null) ?? null
}
function get<T extends HTMLElement = HTMLElement>(testId: string): T {
  const el = q<T>(testId)
  if (!el) throw new Error(`missing [data-testid="${testId}"]`)
  return el
}
function all(testId: string): HTMLElement[] {
  return [...(container?.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`) ?? [])]
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
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}
async function settle(check: () => void): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      check()
      return
    } catch {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
  }
  check()
}

async function renderPanel(fake: ReturnType<typeof createFakeBridge>, setup?: () => void) {
  setAshyHostBridgeForTesting(fake.bridge)
  resetAshyStore()
  resetCallStoreForTesting()
  setup?.()
  await act(async () => {
    root!.render(<LiveModeSettingsPanel />)
  })
  await flush()
}

async function upload(file: File): Promise<void> {
  const input = get<HTMLInputElement>('voice-ref-upload')
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Fake Web Audio: the "decoded" buffer carries its own mono 24 kHz rendering. */
function makeFakeAudio(mono24k: Float32Array) {
  const offlineArgs: Array<[number, number, number]> = []
  const decodeCalls: number[] = []
  class FakeAudioContext {
    async decodeAudioData(data: ArrayBuffer) {
      decodeCalls.push(data.byteLength)
      return { duration: mono24k.length / 24000, numberOfChannels: 2, sampleRate: 44100 }
    }
    close() {
      return Promise.resolve()
    }
  }
  class FakeOfflineAudioContext {
    destination = { kind: 'dest' }
    private connected = false
    private started = false
    constructor(
      private channels: number,
      private length: number,
      private sampleRate: number,
    ) {
      offlineArgs.push([channels, length, sampleRate])
    }
    createBufferSource() {
      return {
        buffer: null as unknown,
        connect: (dest: unknown) => {
          this.connected = dest === this.destination
        },
        start: () => {
          this.started = true
        },
      }
    }
    async startRendering() {
      if (!this.connected || !this.started) throw new Error('graph not wired')
      const out = new Float32Array(this.length)
      out.set(mono24k.subarray(0, this.length))
      return { length: this.length, getChannelData: () => out }
    }
  }
  const deps: VoiceReferenceAudioDeps = {
    AudioContext: FakeAudioContext as never,
    OfflineAudioContext: FakeOfflineAudioContext as never,
  }
  return { deps, offlineArgs, decodeCalls }
}

/** silence + tone + silence at 24 kHz. */
function speechSignal(leadSec: number, toneSec: number, tailSec: number): Float32Array {
  const sr = 24000
  const out = new Float32Array(Math.round((leadSec + toneSec + tailSec) * sr))
  const start = Math.round(leadSec * sr)
  const end = start + Math.round(toneSec * sr)
  for (let i = start; i < end; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr)
  // faint noise floor well below −45 dBFS in the "silent" parts
  for (let i = 0; i < out.length; i++) if (i < start || i >= end) out[i] = (i % 2 ? 1 : -1) * 0.0005
  return out
}

function parseWav(b64: string) {
  const buf = Buffer.from(b64, 'base64')
  return {
    riff: buf.toString('ascii', 0, 4),
    wave: buf.toString('ascii', 8, 12),
    format: buf.readUInt16LE(20),
    channels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    bits: buf.readUInt16LE(34),
    dataBytes: buf.readUInt32LE(40),
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
  resetCallStoreForTesting()
  setAshyHostBridgeForTesting(null)
})

describe('Phase 10.2 — voice reference normalization (unit)', () => {
  it('8. trims silence at −45 dBFS, renders mono 24 kHz, caps at 30 s, rejects < 5 s', async () => {
    const range = findVoicedRange(speechSignal(1, 6, 1), 24000)!
    expect(range.start).toBeGreaterThan(24000 * 0.9)
    expect(range.start).toBeLessThanOrEqual(24000)
    expect(range.end).toBeGreaterThanOrEqual(24000 * 7)
    expect(range.end).toBeLessThan(24000 * 7.1)
    expect(findVoicedRange(new Float32Array(24000), 24000)).toBeNull()

    const fake = makeFakeAudio(speechSignal(0.5, 40, 0.5))
    const res = await normalizeVoiceReference(new ArrayBuffer(16), fake.deps)
    expect(fake.offlineArgs[0]![0]).toBe(1)
    expect(fake.offlineArgs[0]![2]).toBe(24000)
    expect(res.durationMs).toBe(30_000)
    expect(parseWav(res.wavBase64)).toMatchObject({ channels: 1, sampleRate: 24000, bits: 16, dataBytes: 30 * 24000 * 2 })

    await expect(
      normalizeVoiceReference(new ArrayBuffer(16), makeFakeAudio(speechSignal(2, 3, 2)).deps),
    ).rejects.toThrow(/pelo menos 5 segundos/)

    const wav = encodePcm16Wav(new Float32Array([0, 1, -1]), 24000)
    expect(Buffer.from(wav).readInt16LE(44 + 2)).toBe(32767)
    expect(Buffer.from(wav).readInt16LE(44 + 4)).toBe(-32768)
  })
})

describe('Phase 10.2 — Live Mode UI', () => {
  it('9. hybrid card is enabled and selecting it saves the backend; voice section only for hybrid', async () => {
    const saved: unknown[] = []
    let settings = structuredClone(REALTIME_DEFAULTS)
    const fake = createFakeBridge({
      'liveMode:getSettings': () => structuredClone(settings),
      'liveMode:saveSettings': (p) => {
        saved.push(p)
        const patch = p as { backend?: LiveModeSettings['backend']; session?: { rotateAfterTurns?: number } }
        settings = {
          ...settings,
          ...(patch.backend ? { backend: patch.backend } : {}),
          session: { ...settings.session, ...(patch.session ?? {}) },
        }
        return structuredClone(settings)
      },
    })
    await renderPanel(fake)
    const card = get<HTMLButtonElement>('live-backend-hybrid')
    expect(card.disabled).toBe(false)
    expect(card.textContent).toContain('Local omni + minha voz (híbrido)')
    expect(card.textContent).not.toContain('em breve')
    expect(q('voice-ref-section')).toBeNull()

    await act(async () => click(card))
    await flush()
    expect(saved[0]).toEqual({ backend: 'llamacpp-hybrid' })
    expect(get('live-backend-hybrid').getAttribute('aria-pressed')).toBe('true')
    expect(q('voice-ref-section')).not.toBeNull()
    expect(get('voice-ref-consent').textContent).toBe('Use só vozes que você tem direito de usar.')
    expect(get('voice-ref-none').textContent).toContain('Sem referência (voz padrão feminina/masculina)')

    // Session rotation is saved with the rest; the hybrid backend is kept.
    await act(async () => setNativeValue(get<HTMLInputElement>('input-live-rotate-turns'), '9'))
    await act(async () => click(get('btn-live-save-settings')))
    await flush()
    expect(saved[1]).toMatchObject({ backend: 'llamacpp-hybrid', session: { rotateAfterTurns: 9 } })
  })

  it('10. upload → normalized PCM16 mono 24 kHz WAV → liveVoice:import; short sample rejected with a clear message', async () => {
    let voices: VoiceReference[] = []
    const imports: Array<{ name: string; wavBase64: string }> = []
    const fake = createFakeBridge({
      'liveMode:getSettings': () => hybridSettings(),
      'liveVoice:list': () => voices,
      'liveVoice:import': (p) => {
        const input = p as { name: string; wavBase64: string }
        imports.push(input)
        const v: VoiceReference = { id: 'voz-a1', name: input.name, durationMs: 8120, createdAt: 1 }
        voices = [...voices, v]
        return v
      },
    })
    await renderPanel(fake)
    expect(get<HTMLInputElement>('voice-ref-upload').accept).toContain('.m4a')

    const good = makeFakeAudio(speechSignal(1, 8, 1))
    setVoiceAudioDepsForTesting(good.deps)
    await upload(new File([new Uint8Array(64)], 'minha_voz.mp3', { type: 'audio/mpeg' }))
    await settle(() => expect(all('voice-ref-item')).toHaveLength(1))
    expect(good.decodeCalls).toEqual([64])
    expect(imports).toHaveLength(1)
    expect(imports[0]!.name).toBe('minha voz')
    const wav = parseWav(imports[0]!.wavBase64)
    expect(wav).toMatchObject({ riff: 'RIFF', wave: 'WAVE', format: 1, channels: 1, sampleRate: 24000, bits: 16 })
    const seconds = wav.dataBytes / 2 / 24000
    expect(seconds).toBeGreaterThan(8)
    expect(seconds).toBeLessThan(8.2) // leading/trailing silence trimmed
    expect(get('voice-ref-item').textContent).toContain('minha voz')
    expect(get('voice-ref-message').textContent).toContain('importada')

    // < 5 s of speech → rejected before reaching the host
    setVoiceAudioDepsForTesting(makeFakeAudio(speechSignal(3, 2, 3)).deps)
    await upload(new File([new Uint8Array(64)], 'curta.wav', { type: 'audio/wav' }))
    await settle(() => expect(get('voice-ref-message').textContent).toContain('pelo menos 5 segundos'))
    expect(imports).toHaveLength(1)

    // unsupported format
    await upload(new File([new Uint8Array(4)], 'voz.txt'))
    await settle(() => expect(get('voice-ref-message').textContent).toContain('Formato não suportado'))
    expect(imports).toHaveLength(1)
  })

  it('11. list: Ouvir plays the preview WAV, "Usar esta voz" saves referenceVoiceId, Excluir deletes and reloads', async () => {
    let settings = hybridSettings(null)
    let voices: VoiceReference[] = [
      { id: 'voz-a', name: 'Voz A', durationMs: 9000, createdAt: 1 },
      { id: 'voz-b', name: 'Voz B', durationMs: 12000, createdAt: 2 },
    ]
    const saved: unknown[] = []
    const fake = createFakeBridge({
      'liveMode:getSettings': () => structuredClone(settings),
      'liveMode:saveSettings': (p) => {
        saved.push(p)
        const patch = p as { hybrid?: { referenceVoiceId?: string | null } }
        settings = { ...settings, hybrid: { ...settings.hybrid, ...(patch.hybrid ?? {}) } }
        return structuredClone(settings)
      },
      'liveVoice:list': () => voices,
      'liveVoice:preview': (p) => ({ wavBase64: `WAV:${(p as { id: string | null }).id ?? 'default'}`, latencyMs: 300 }),
      'liveVoice:delete': (p) => {
        const id = (p as { id: string }).id
        voices = voices.filter((v) => v.id !== id)
        if (settings.hybrid.referenceVoiceId === id) {
          settings = { ...settings, hybrid: { ...settings.hybrid, referenceVoiceId: null } }
        }
        return { ok: true }
      },
    })
    const played: string[] = []
    await renderPanel(fake)
    setWavPlayerForTesting((b64) => {
      played.push(b64)
    })
    await settle(() => expect(all('voice-ref-item')).toHaveLength(2))
    expect(get('voice-ref-none').dataset.active).toBe('true')

    const [itemA] = all('voice-ref-item')
    await act(async () => click(itemA!.querySelector('[data-testid="btn-voice-ref-preview"]')!))
    await flush()
    expect(fake.callsFor('liveVoice:preview')[0]![0].payload).toEqual({ id: 'voz-a' })
    expect(played).toEqual(['WAV:voz-a'])

    await act(async () => click(get('btn-voice-ref-none-preview')))
    await flush()
    expect(fake.callsFor('liveVoice:preview')[1]![0].payload).toEqual({ id: null })
    expect(played).toEqual(['WAV:voz-a', 'WAV:default'])

    await act(async () => click(all('voice-ref-item')[1]!.querySelector('[data-testid="btn-voice-ref-use"]')!))
    await flush()
    expect(saved.at(-1)).toEqual({ hybrid: { referenceVoiceId: 'voz-b' } })
    await settle(() => expect(all('voice-ref-item')[1]!.dataset.active).toBe('true'))
    expect(get('voice-ref-none').dataset.active).toBe('false')

    // Deleting the voice in use → host resets referenceVoiceId; UI reloads list + settings.
    await act(async () => click(all('voice-ref-item')[1]!.querySelector('[data-testid="btn-voice-ref-delete"]')!))
    await settle(() => expect(all('voice-ref-item')).toHaveLength(1))
    expect(fake.callsFor('liveVoice:delete')[0]![0].payload).toEqual({ id: 'voz-b' })
    await settle(() => expect(get('voice-ref-none').dataset.active).toBe('true'))

    // Back to no reference
    await act(async () => click(all('voice-ref-item')[0]!.querySelector('[data-testid="btn-voice-ref-use"]')!))
    await flush()
    await settle(() => expect(get('voice-ref-none').dataset.active).toBe('false'))
    await act(async () => click(get('btn-voice-ref-none-use')))
    await flush()
    expect(saved.at(-1)).toEqual({ hybrid: { referenceVoiceId: null } })
  })

  it('12. Testar chamada: running state, then per-step ✓/✗ + ms + metrics + transcript/reply from call:testResult', async () => {
    const fake = createFakeBridge({
      'call:startTest': () => callState({ callId: 'test-1', status: 'connecting', backend: 'llamacpp-realtime', sessionId: 's' }),
    })
    await renderPanel(fake)
    const btn = get<HTMLButtonElement>('btn-live-test-call')
    expect(btn.disabled).toBe(false)
    await act(async () => click(btn))
    await flush()
    expect(fake.callsFor('call:startTest')).toHaveLength(1)
    expect(get('live-test-running').textContent).toContain('andamento')
    expect(get<HTMLButtonElement>('btn-live-test-call').disabled).toBe(true)
    expect(get('btn-live-test-call').textContent).toContain('Testando')

    const result: CallTestResult = {
      callId: 'test-1',
      ok: false,
      steps: [
        { step: 'engine', ok: true, ms: 12 },
        { step: 'session', ok: true, ms: 85 },
        { step: 'vad', ok: true, ms: 2300 },
        { step: 'transcription', ok: true, ms: 420, detail: 'similaridade 0.92' },
        { step: 'first_audio', ok: true, ms: 640 },
        { step: 'playback', ok: false, detail: 'fila não esvaziou' },
      ],
      metrics: { endpointMs: 700, asrMs: 420, ttfbMs: 640, e2eMs: 1460 },
      transcript: 'Oi Ashy, tudo bem?',
      reply: 'Tudo ótimo! Sabia que polvos têm três corações?',
      finishedAt: 5,
    }
    await act(async () => {
      fake.emit({ type: 'call:state', state: callState({ callId: 'test-1', status: 'speaking' }) })
      fake.emit({ type: 'call:testResult', result })
      fake.emit({ type: 'call:state', state: callState({ callId: 'test-1', status: 'ended', reason: 'user_hangup' }) })
    })
    expect(q('live-test-running')).toBeNull()
    expect(q('live-test-error')).toBeNull()
    const box = get('live-test-result')
    expect(box.dataset.ok).toBe('false')
    expect(box.textContent).toContain('Alguma etapa falhou')
    expect(get('live-test-step-engine').textContent).toContain('✓')
    expect(get('live-test-step-engine').textContent).toContain('12 ms')
    expect(get('live-test-step-transcription').textContent).toContain('similaridade 0.92')
    expect(get('live-test-step-playback').dataset.ok).toBe('false')
    expect(get('live-test-step-playback').textContent).toContain('✗')
    expect(get('live-test-metrics').textContent).toContain('Ponta a ponta: 1460 ms')
    expect(get('live-test-transcript').textContent).toContain('Oi Ashy, tudo bem?')
    expect(get('live-test-reply').textContent).toContain('três corações')
    expect(get<HTMLButtonElement>('btn-live-test-call').disabled).toBe(false)
  })

  it('13. a test call that ends without a result shows the failure', async () => {
    const fake = createFakeBridge({
      'call:startTest': () => callState({ callId: 'test-2', status: 'connecting' }),
    })
    await renderPanel(fake)
    await act(async () => click(get('btn-live-test-call')))
    await flush()
    await act(async () => {
      fake.emit({
        type: 'call:state',
        state: callState({ callId: 'test-2', status: 'ended', reason: 'backend_unavailable' }),
      })
    })
    expect(get('live-test-error').textContent).toContain('Motor local indisponível')
    expect(q('live-test-running')).toBeNull()
  })

  it('14. call:stage drives stageEmotion/emotionIntensity/activeMotion only during the active call', async () => {
    const fake = createFakeBridge()
    await renderPanel(fake)
    useAshyStore.setState({ stageEmotion: 'neutral', emotionIntensity: 0.5, activeMotion: 'idle' })

    // No call → ignored
    await act(async () => {
      fake.emit({ type: 'call:stage', callId: 'c1', emotion: 'happy', intensity: 0.9, motion: 'bounce' })
    })
    expect(useAshyStore.getState()).toMatchObject({ stageEmotion: 'neutral', emotionIntensity: 0.5, activeMotion: 'idle' })

    await act(async () => {
      fake.emit({ type: 'call:state', state: callState({ callId: 'c1', status: 'speaking' }) })
    })
    await act(async () => {
      fake.emit({ type: 'call:stage', callId: 'c1', emotion: 'happy', intensity: 0.7, motion: 'Nod' })
    })
    expect(useAshyStore.getState()).toMatchObject({ stageEmotion: 'happy', emotionIntensity: 0.7, activeMotion: 'nod' })

    // Another call's signal → ignored
    await act(async () => {
      fake.emit({ type: 'call:stage', callId: 'other', emotion: 'sad', intensity: 0.4 })
    })
    expect(useAshyStore.getState().stageEmotion).toBe('happy')

    // Unknown motion keeps the current motion; unknown emotion is ignored
    await act(async () => {
      fake.emit({ type: 'call:stage', callId: 'c1', emotion: 'curious', intensity: 2, motion: 'moonwalk' })
    })
    expect(useAshyStore.getState()).toMatchObject({ stageEmotion: 'curious', emotionIntensity: 1, activeMotion: 'nod' })
    await act(async () => {
      fake.emit({ type: 'call:stage', callId: 'c1', emotion: 'bogus', intensity: 0.3, motion: 'shrug' })
    })
    expect(useAshyStore.getState()).toMatchObject({ stageEmotion: 'curious', activeMotion: 'shrug' })

    // After the call ends → ignored again
    await act(async () => {
      fake.emit({ type: 'call:state', state: callState({ callId: 'c1', status: 'ended', reason: 'user_hangup' }) })
      fake.emit({ type: 'call:stage', callId: 'c1', emotion: 'angry', intensity: 0.8, motion: 'shake' })
    })
    expect(useAshyStore.getState()).toMatchObject({ stageEmotion: 'curious', activeMotion: 'shrug' })
    expect(useCallStore.getState().callState.status).toBe('ended')
  })
})
