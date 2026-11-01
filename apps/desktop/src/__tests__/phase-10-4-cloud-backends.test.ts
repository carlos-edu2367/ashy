/**
 * Phase 10.4 — cloud speech-to-speech backends, host + main:
 * ws framing, the loopback relay (token, upstream auth, error mapping, redaction), encrypted key store,
 * target resolution, call:start validation, runtime config, cloud instructions, main header scoping.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIVE_MODE_SETTINGS,
  LIVE_LOCAL_MODELS,
  type AshyHostStreamEvent,
  type CallContextResult,
  type CallRuntimeConfig,
  type CallStateSnapshot,
  type LiveKeyStatus,
  type LiveModeSettings,
  type LlamaCppEngineStatus,
} from '@ashy/shared'
import { CLOUD_RELAY_CLOSE } from '@ashy/voice'
import { createAshyHostKernel, type AshyHostKernel } from '../host/kernel'
import { registerCallHostHandlers } from '../host/live-call/handlers'
import { createNodeAesSecretProtector } from '../host/secret-protector'
import {
  CLOUD_CALL_MODE_BLOCK,
  GEMINI_LIVE_UPSTREAM_URL,
  LIVE_CLOUD_KEYS_FILE,
  buildCloudCallInstructions,
  createLiveCloudKeyStore,
  resolveCloudTarget,
  sanitizePersonaForVoice,
  upstreamAuthFor,
} from '../host/live-call/cloud'
import {
  CLOUD_RELAY_TOKEN_HEADER,
  RELAY_CLOSE,
  UpstreamHttpError,
  closeReasonFrom,
  connectWebSocketUpstream,
  createCloudRelay,
  wrapUpgradedSocket,
  type RelayPeer,
} from '../host/live-call/cloud-relay'
import {
  WebSocketFrameReader,
  computeWebSocketAccept as computeWebSocketAcceptForTest,
  encodeWebSocketFrame,
  WS_OPCODE,
} from '../host/live-call/ws-frames'
import {
  cloudRelayUrlPatterns,
  createCallWindowController,
  isCloudRelayRequestUrl,
  type ElectronBeforeSendHeadersDetailsLike,
  type ElectronBeforeSendHeadersListenerLike,
  type EngineAuthLike,
} from '../main/index'

const tempDirs: string[] = []
const kernels: AshyHostKernel[] = []
const servers: http.Server[] = []
const cleanups: Array<() => Promise<void> | void> = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-cloud-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length > 0) await cleanups.pop()!()
  while (kernels.length > 0) await kernels.pop()!.stop()
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()))
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    } catch {
      // Windows EPERM on a leaked handle
    }
  }
})

/** A fake cloud upstream: records the upgrade request and answers like the provider's handshake. */
async function startFakeUpstream(opts: { rejectStatus?: number; rejectBody?: string; greeting?: string; binaryGreeting?: boolean } = {}) {
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = []
  const received: string[] = []
  const peers: RelayPeer[] = []
  const server = http.createServer((_q, r) => {
    r.statusCode = 404
    r.end()
  })
  server.on('upgrade', (req, socket: Duplex, head) => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    if (opts.rejectStatus) {
      const body = opts.rejectBody ?? ''
      socket.end(`HTTP/1.1 ${opts.rejectStatus} Nope\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      return
    }
    const key = String(req.headers['sec-websocket-key'])
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${computeWebSocketAcceptForTest(key)}\r\n\r\n`)
    const peer = wrapUpgradedSocket(socket, { client: false, head })
    peers.push(peer)
    peer.onMessage((data, binary) => {
      received.push(binary ? `bin:${(data as Buffer).toString('utf8')}` : (data as string))
      // echo as binary (Gemini style)
      peer.sendBinary(Buffer.from(JSON.stringify({ echo: binary ? (data as Buffer).toString('utf8') : data })))
    })
    if (opts.greeting) {
      if (opts.binaryGreeting) peer.sendBinary(Buffer.from(opts.greeting))
      else peer.sendText(opts.greeting)
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  servers.push(server)
  const port = (server.address() as { port: number }).port
  return { server, port, seen, received, peers }
}

function nextMessage(peer: RelayPeer): Promise<string> {
  return new Promise((resolve) => peer.onMessage((d) => resolve(typeof d === 'string' ? d : d.toString('utf8'))))
}

function nextClose(peer: RelayPeer): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => peer.onClose((code, reason) => resolve({ code, reason })))
}

describe('Phase 10.4 — WebSocket framing (relay codec)', () => {
  it('round-trips masked/unmasked, 16-bit and 64-bit lengths and fragmented messages', () => {
    const big = Buffer.alloc(70_000, 7)
    const reader = new WebSocketFrameReader(true)
    const frames = Buffer.concat([
      encodeWebSocketFrame(WS_OPCODE.TEXT, Buffer.from('oi'), true),
      encodeWebSocketFrame(WS_OPCODE.BINARY, Buffer.alloc(300, 1), true),
      encodeWebSocketFrame(WS_OPCODE.BINARY, big, true),
    ])
    // feed byte-split to exercise partial frames
    const out = [...reader.push(frames.subarray(0, 5)), ...reader.push(frames.subarray(5, 4000)), ...reader.push(frames.subarray(4000))]
    expect(out.map((m) => [m.opcode, m.payload.length])).toEqual([
      [WS_OPCODE.TEXT, 2],
      [WS_OPCODE.BINARY, 300],
      [WS_OPCODE.BINARY, 70_000],
    ])
    expect(out[0]!.payload.toString()).toBe('oi')
    // fragmented: FIN=0 text + continuation FIN=1
    const f1 = encodeWebSocketFrame(WS_OPCODE.TEXT, Buffer.from('he'), false)
    f1[0] = f1[0]! & 0x7f
    const f2 = encodeWebSocketFrame(WS_OPCODE.CONTINUATION, Buffer.from('llo'), false)
    const r2 = new WebSocketFrameReader(false)
    expect(r2.push(Buffer.concat([f1, f2])).map((m) => m.payload.toString())).toEqual(['hello'])
    // a client frame without mask is a protocol error
    expect(() => new WebSocketFrameReader(true).push(encodeWebSocketFrame(WS_OPCODE.TEXT, Buffer.from('x'), false))).toThrow(/unmasked/)
  })
})

describe('Phase 10.4 — loopback cloud relay', () => {
  it('relay close codes match the voice session contract', () => {
    expect(RELAY_CLOSE).toEqual(CLOUD_RELAY_CLOSE)
  })

  it('pipes renderer ↔ upstream with host-side auth (Bearer header / ?key=), binary upstream → text, token required', async () => {
    const up = await startFakeUpstream({ greeting: '{"type":"session.created"}', binaryGreeting: true })
    const relay = createCloudRelay({
      resolveTarget: (id) =>
        id === 'call-1'
          ? {
              ok: true,
              target: {
                url: `ws://127.0.0.1:${up.port}/v1/realtime?model=gpt-realtime-2.1-mini&key=SECRET-GEMINI`,
                headers: { Authorization: 'Bearer sk-SECRET-OPENAI' },
                secrets: ['sk-SECRET-OPENAI', 'SECRET-GEMINI'],
              },
            }
          : { ok: false, code: RELAY_CLOSE.FORBIDDEN, reason: 'no active cloud call' },
    })
    cleanups.push(() => relay.close())
    await relay.ensureListening()
    const auth = relay.getAuth()!
    expect(auth.headers).toHaveProperty(CLOUD_RELAY_TOKEN_HEADER)
    const url = relay.urlFor('call-1')!
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/cloud\/call-1$/)
    expect(url).not.toContain('SECRET')

    // renderer side (the token header is what Electron main injects)
    const client = await connectWebSocketUpstream({ url, headers: auth.headers })
    const greeting = await nextMessage(client)
    expect(greeting).toBe('{"type":"session.created"}') // binary upstream frame → text frame
    const echoed = nextMessage(client)
    client.sendText('{"type":"session.update"}')
    expect(JSON.parse(await echoed)).toEqual({ echo: '{"type":"session.update"}' })
    expect(up.received).toEqual(['{"type":"session.update"}'])
    expect(up.seen[0]!.headers.authorization).toBe('Bearer sk-SECRET-OPENAI')
    expect(up.seen[0]!.url).toBe('/v1/realtime?model=gpt-realtime-2.1-mini&key=SECRET-GEMINI')
    // the relay token never travels upstream
    expect(up.seen[0]!.headers[CLOUD_RELAY_TOKEN_HEADER]).toBeUndefined()

    // client close propagates upstream
    const upClosed = nextClose(up.peers[0]!)
    client.close(1000, 'call ended')
    expect((await upClosed).code).toBe(1000)

    // without the token (another local process): HTTP 401, never upgraded
    await expect(connectWebSocketUpstream({ url, headers: {} })).rejects.toMatchObject({ status: 401 })
    await expect(connectWebSocketUpstream({ url, headers: { [CLOUD_RELAY_TOKEN_HEADER]: 'wrong' } })).rejects.toBeInstanceOf(UpstreamHttpError)
    // unknown call id → accepted then closed 4003
    const stray = await connectWebSocketUpstream({ url: relay.urlFor('other')!, headers: auth.headers })
    expect(await nextClose(stray)).toMatchObject({ code: RELAY_CLOSE.FORBIDDEN })
  })

  it('maps an upstream HTTP rejection to close 4000+status with a redacted reason', async () => {
    const up = await startFakeUpstream({
      rejectStatus: 401,
      rejectBody: JSON.stringify({ error: { message: 'Incorrect API key provided: sk-SECRET-OPENAI', type: 'invalid_request_error' } }),
    })
    const relay = createCloudRelay({
      resolveTarget: () => ({
        ok: true,
        target: { url: `ws://127.0.0.1:${up.port}/v1/realtime`, headers: { Authorization: 'Bearer sk-SECRET-OPENAI' }, secrets: ['sk-SECRET-OPENAI'] },
      }),
    })
    cleanups.push(() => relay.close())
    await relay.ensureListening()
    const client = await connectWebSocketUpstream({ url: relay.urlFor('c')!, headers: relay.getAuth()!.headers })
    const closed = await nextClose(client)
    expect(closed.code).toBe(4401)
    expect(closed.reason).toBe('Incorrect API key provided: ***')
    expect(closeReasonFrom('fail wss://x?key=AIzaXYZ&a=1')).toBe('fail wss://x?key=***&a=1')
  })

  it('unreachable upstream → close 4002', async () => {
    const relay = createCloudRelay({
      resolveTarget: () => ({ ok: true, target: { url: 'ws://127.0.0.1:1/never', headers: {} } }),
    })
    cleanups.push(() => relay.close())
    await relay.ensureListening()
    const client = await connectWebSocketUpstream({ url: relay.urlFor('c')!, headers: relay.getAuth()!.headers })
    expect((await nextClose(client)).code).toBe(RELAY_CLOSE.UNREACHABLE)
  })
})

describe('Phase 10.4 — cloud keys + targets', () => {
  it('stores keys encrypted (AES-GCM envelope), masked status only, clear with empty, OpenAI fallback', () => {
    const dir = tempDir()
    const store = createLiveCloudKeyStore({
      userDataDir: dir,
      protector: createNodeAesSecretProtector(dir),
      fallbackKey: (p) => (p === 'openai' ? 'sk-chat-provider-key-123456' : null),
    })
    expect(store.status().gemini).toEqual({ hasKey: false, masked: null })
    expect(store.status().openai.hasKey).toBe(true) // fallback
    const status: LiveKeyStatus = store.set('gemini', '  AIzaSyGEMINI-SECRET-KEY-99  ')
    expect(status.gemini.hasKey).toBe(true)
    expect(status.gemini.masked).toBe('AIzaSy...Y-99')
    const raw = fs.readFileSync(path.join(dir, LIVE_CLOUD_KEYS_FILE), 'utf8')
    expect(raw).not.toContain('GEMINI-SECRET')
    expect(raw).toContain('enc:v1:')
    expect(store.get('gemini')).toBe('AIzaSyGEMINI-SECRET-KEY-99')
    store.set('openai', 'sk-dedicated-live-key-abcdef')
    expect(store.get('openai')).toBe('sk-dedicated-live-key-abcdef')
    store.set('gemini', '')
    expect(store.get('gemini')).toBeNull()
    expect(() => store.set('qwen', 'two words')).toThrow(/INVALID_API_KEY/)
  })

  it('resolves presets / custom endpoints and builds upstream auth per provider', () => {
    const s = structuredClone(DEFAULT_LIVE_MODE_SETTINGS)
    const openai = resolveCloudTarget(s, 'openai-realtime')
    expect(openai).toMatchObject({ ok: true, target: { kind: 'openai-compatible', keyProvider: 'openai', url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini', voice: 'marin' } })
    const auth = upstreamAuthFor((openai as unknown as { target: never }).target, 'sk-x')
    expect(auth.headers).toEqual({ Authorization: 'Bearer sk-x' })
    expect(auth.headers).not.toHaveProperty('OpenAI-Beta')

    s.realtimeCloud = { provider: 'qwen', url: '', model: '', voice: '' }
    expect(resolveCloudTarget(s, 'openai-realtime')).toMatchObject({
      ok: true,
      target: { keyProvider: 'qwen', url: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-flash-realtime', voice: 'Tina' },
    })
    s.realtimeCloud = { provider: 'qwen', url: 'wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime', model: '', voice: '' }
    expect(resolveCloudTarget(s, 'openai-realtime')).toMatchObject({ ok: false, reason: 'backend_unavailable' })
    s.realtimeCloud = { provider: 'custom', url: '', model: '', voice: '' }
    expect(resolveCloudTarget(s, 'openai-realtime')).toMatchObject({ ok: false })
    s.realtimeCloud = { provider: 'custom', url: 'ws://evil.example.com/rt', model: 'm', voice: '' }
    expect(resolveCloudTarget(s, 'openai-realtime')).toMatchObject({ ok: false, detail: expect.stringContaining('wss://') })
    s.realtimeCloud = { provider: 'custom', url: 'ws://127.0.0.1:8000/v1/realtime', model: 'local-omni', voice: '' }
    expect(resolveCloudTarget(s, 'openai-realtime')).toMatchObject({ ok: true, target: { keyRequired: false } })

    const gemini = resolveCloudTarget(s, 'gemini-live')
    expect(gemini).toMatchObject({ ok: true, target: { kind: 'gemini', url: GEMINI_LIVE_UPSTREAM_URL, model: 'gemini-3.8-live', voice: 'Kore' } })
    const gAuth = upstreamAuthFor((gemini as unknown as { target: never }).target, 'AIza/+key')
    expect(gAuth.url).toBe(`${GEMINI_LIVE_UPSTREAM_URL}?key=AIza%2F%2Bkey`)
    expect(gAuth.headers).toEqual({})
  })

  it('cloud instructions: full persona minus stage markers/MCP, user name, recent chat, call mode + tools, budgeted', () => {
    const persona = [
      '[ASHY CORE IDENTITY & VOICE]',
      'You are **Ashy**, witty and loyal.',
      '',
      '[OUTPUT FORMAT — STAGE MARKERS]',
      '- Trigger live avatar emotions inline: `<|ACT {"emotion":"smug"}|>`',
      '',
      '[Desktop Agency, Vision & MCP Tools]',
      '- Meta-tools always available: `search_mcp_tools`',
      '',
      '[RECALLED MEMORIES & FACTS]',
      '- [identity] user name Carlos',
    ].join('\n')
    const clean = sanitizePersonaForVoice(persona)
    expect(clean).toContain('You are **Ashy**')
    expect(clean).toContain('user name Carlos')
    expect(clean).not.toContain('<|ACT')
    expect(clean).not.toContain('search_mcp_tools')
    const text = buildCloudCallInstructions({
      persona: clean,
      userName: 'Carlos',
      recentMessages: [
        { role: 'user', content: 'meu cachorro se chama Thor' },
        { role: 'assistant', content: 'Que nome forte!' },
      ],
      tools: true,
    })
    expect(text).toContain('O nome do usuário é Carlos.')
    expect(text).toContain('Carlos: meu cachorro se chama Thor')
    expect(text).toContain('Ashy: Que nome forte!')
    expect(text).toContain(CLOUD_CALL_MODE_BLOCK)
    expect(text).toContain('aguardando_aprovacao')
    const tight = buildCloudCallInstructions({
      persona: 'P'.repeat(5000),
      recentMessages: Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, content: `mensagem ${i} `.repeat(30) })),
      options: { includePersona: true, recentMessages: 30, memoryTopK: 4, maxInstructionsChars: 3000 },
    })
    expect(tight.length).toBeLessThanOrEqual(3000)
    expect(tight).toContain(CLOUD_CALL_MODE_BLOCK)
  })
})

// ───────────────────────────── host: call:start / runtime config / buildContext ─────────────────────────────

function baseStatus(): LlamaCppEngineStatus {
  return {
    engineId: 'llamacpp',
    build: 'b12024',
    installed: false,
    installedVariant: null,
    detectedGpu: null,
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
}

async function makeHarness(settings: LiveModeSettings, opts: { connectUpstream?: Parameters<typeof registerCallHostHandlers>[1]['cloudConnectUpstream'] } = {}) {
  const dir = tempDir()
  const kernel = await createAshyHostKernel({ userDataDir: dir })
  kernels.push(kernel)
  const session = await kernel.createSession('Chamada cloud')
  const events: AshyHostStreamEvent[] = []
  kernel.onHostEvent((e) => events.push(e))
  kernel.setCallWindowController({ ensure: vi.fn(async () => undefined), destroy: vi.fn() })
  let seq = 0
  const handlers = registerCallHostHandlers(kernel.liveCall, {
    userDataDir: dir,
    settings: { get: () => settings },
    engine: {
      getStatus: () => baseStatus(),
      start: vi.fn(async () => baseStatus()),
      getModelSpec: (id: string) => LIVE_LOCAL_MODELS.find((m) => m.id === id),
    },
    getCortex: () => kernel.cortex,
    resolveSessionId: () => session.id,
    transcribe: vi.fn(async () => ({ text: '', providerId: 'x', latencyMs: 0 })),
    createCallId: () => `call-cloud-${++seq}`,
    cloudSecretProtector: createNodeAesSecretProtector(dir),
    ...(opts.connectUpstream ? { cloudConnectUpstream: opts.connectUpstream } : {}),
  })
  cleanups.push(() => handlers.cloud?.close())
  const invoke = <T = unknown>(method: string, payload?: unknown) => kernel.invokeLiveCall({ method: method as never, payload }) as Promise<T>
  return { kernel, session, events, handlers, invoke, dir }
}

describe('Phase 10.4 — call host for cloud backends', () => {
  it('missing key → call:start ends backend_unavailable with a clear PT detail; with key → connecting + relay runtime config (no key anywhere)', async () => {
    const settings = structuredClone(DEFAULT_LIVE_MODE_SETTINGS)
    settings.backend = 'gemini-live'
    settings.features.toolsInCall = true
    const h = await makeHarness(settings)
    const ended = await h.invoke<CallStateSnapshot>('call:start', {})
    expect(ended).toMatchObject({ status: 'ended', reason: 'backend_unavailable' })
    expect(ended.detail).toContain('Chave de API do Google Gemini não configurada')

    const status = await h.invoke<LiveKeyStatus>('liveMode:setApiKey', { provider: 'gemini', apiKey: 'AIzaSy-VERY-SECRET-GEMINI-KEY' })
    expect(status.gemini).toEqual({ hasKey: true, masked: 'AIzaSy...-KEY' })
    await h.invoke('call:stop', {})
    const started = await h.invoke<CallStateSnapshot>('call:start', {})
    expect(started.status).toBe('connecting')
    const cfg = await h.invoke<CallRuntimeConfig>('call:getRuntimeConfig', { callId: started.callId })
    expect(cfg.cloud).toMatchObject({ kind: 'gemini', model: 'gemini-3.8-live', voice: 'Kore' })
    expect(cfg.cloud!.url).toBe(h.handlers.cloud!.relay.urlFor(started.callId!))
    expect(cfg.llamacpp).toBeNull()

    // The session-level context: rich PT instructions + the 4 call tools (cloud: no model gate).
    const ctx = await h.invoke<CallContextResult>('call:buildContext', { callId: started.callId })
    expect(ctx.instructions).toContain(CLOUD_CALL_MODE_BLOCK)
    expect(ctx.instructions).not.toContain('<|ACT')
    expect(ctx.tools?.map((t) => t.name)).toEqual(['get_active_window_title', 'capture_authorized_screen', 'read_workspace_file', 'write_project_note'])
    const turn = await h.invoke<CallContextResult>('call:buildContext', { callId: started.callId, userText: 'lê o arquivo notas.txt' })
    expect(turn.toolChoice).toBeUndefined()

    // The key never appears in any event, state, runtime config or status.
    const everything = JSON.stringify([h.events, cfg, ctx, status, await h.invoke('liveMode:getKeyStatus')])
    expect(everything).not.toContain('VERY-SECRET')
    await h.invoke('call:stop', {})
  })

  it('end to end through the relay: only the active call resolves, upstream gets Bearer auth from the host', async () => {
    const up = await startFakeUpstream({ greeting: '{"type":"session.created"}' })
    const settings = structuredClone(DEFAULT_LIVE_MODE_SETTINGS)
    settings.backend = 'openai-realtime'
    settings.realtimeCloud = { provider: 'openai', url: `ws://127.0.0.1:${up.port}/v1/realtime`, model: 'gpt-realtime-2.1-mini', voice: 'cedar' }
    const h = await makeHarness(settings)
    await h.invoke('liveMode:setApiKey', { provider: 'openai', apiKey: 'sk-live-SECRET-123456789' })
    const started = await h.invoke<CallStateSnapshot>('call:start', {})
    expect(started.status).toBe('connecting')
    const cfg = await h.invoke<CallRuntimeConfig>('call:getRuntimeConfig', { callId: started.callId })
    expect(cfg.cloud).toMatchObject({ kind: 'openai-compatible', model: 'gpt-realtime-2.1-mini', voice: 'cedar' })
    const relayAuth = h.kernel.liveCall.getCloudRelayAuth?.() ?? h.handlers.cloud!.getRelayAuth()
    // kernel.liveCall exposes the kernel's own relay; this harness registered its own handlers.
    const auth = h.handlers.cloud!.getRelayAuth()!
    void relayAuth
    const client = await connectWebSocketUpstream({ url: cfg.cloud!.url, headers: auth.headers })
    expect(await nextMessage(client)).toBe('{"type":"session.created"}')
    expect(up.seen[0]!.headers.authorization).toBe('Bearer sk-live-SECRET-123456789')
    expect(up.seen[0]!.url).toBe('/v1/realtime?model=gpt-realtime-2.1-mini')
    client.close(1000, 'bye')

    // After hang-up the relay refuses the old call id.
    await h.invoke('call:stop', {})
    const late = await connectWebSocketUpstream({ url: cfg.cloud!.url, headers: auth.headers })
    expect((await nextClose(late)).code).toBe(RELAY_CLOSE.FORBIDDEN)
  })

  it('the kernel wires cloud keys and exposes the relay auth only after a cloud call prepared it', async () => {
    const kernel = await createAshyHostKernel({ userDataDir: tempDir() })
    kernels.push(kernel)
    expect(kernel.liveCall.getCloudRelayAuth?.()).toBeNull()
    const st = (await kernel.invokeLiveCall({ method: 'liveMode:getKeyStatus' })) as LiveKeyStatus
    expect(Object.keys(st).sort()).toEqual(['custom', 'gemini', 'openai', 'qwen'])
  })
})

// ───────────────────────────── main: relay token injection scope ─────────────────────────────

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
  const session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), webRequest }
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
  const created: Array<{ webContents: { id: number }; finish: () => void }> = []
  let nextId = 500
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

describe('Phase 10.4 — main: relay token injected only into the call window, only to the relay port (ws)', () => {
  it('scopes the injection and coexists with the llama-server scope', async () => {
    expect(cloudRelayUrlPatterns({ origin: 'http://127.0.0.1:51000', port: 51000, headers: {} })).toEqual(['ws://127.0.0.1:51000/*'])
    const relayAuth: EngineAuthLike = { origin: 'http://127.0.0.1:51000', port: 51000, headers: { [CLOUD_RELAY_TOKEN_HEADER]: 'tok-123' } }
    expect(isCloudRelayRequestUrl('ws://127.0.0.1:51000/cloud/c1', relayAuth)).toBe(true)
    expect(isCloudRelayRequestUrl('http://127.0.0.1:51000/cloud/c1', relayAuth)).toBe(false)
    expect(isCloudRelayRequestUrl('ws://localhost:51000/cloud/c1', relayAuth)).toBe(false)
    expect(isCloudRelayRequestUrl('wss://api.openai.com/v1/realtime', relayAuth)).toBe(false)

    const { session, webRequest, send } = makeWebRequestSession()
    const { FakeWin, created } = makeWindowClass(session)
    let relay: EngineAuthLike | null = null
    const engine: EngineAuthLike = { origin: 'http://127.0.0.1:47001', port: 47001, headers: { Authorization: 'Bearer llama' } }
    const controller = createCallWindowController({
      BrowserWindow: FakeWin as never,
      preloadPath: '/p.cjs',
      url: 'http://127.0.0.1:4000?view=call-engine',
      getEngineAuth: () => engine,
      getCloudRelayAuth: () => relay,
    })
    const ensured = controller.ensure()
    created[0]!.finish()
    await ensured
    const callWc = created[0]!.webContents.id
    controller.refreshEngineAuth()
    expect(webRequest.filter).toEqual({ urls: ['http://127.0.0.1:47001/*', 'ws://127.0.0.1:47001/*'] })

    relay = relayAuth
    controller.refreshEngineAuth()
    expect(webRequest.filter!.urls).toContain('ws://127.0.0.1:51000/*')
    expect(send({ url: 'ws://127.0.0.1:51000/cloud/c1', webContentsId: callWc, resourceType: 'webSocket' })).toEqual({
      'User-Agent': 'x',
      [CLOUD_RELAY_TOKEN_HEADER]: 'tok-123',
    })
    // other windows, no webContents, the cloud host itself, the engine port: no relay token
    expect(send({ url: 'ws://127.0.0.1:51000/cloud/c1', webContentsId: 1 })).toEqual({ 'User-Agent': 'x' })
    expect(send({ url: 'ws://127.0.0.1:51000/cloud/c1' })).toEqual({ 'User-Agent': 'x' })
    expect(send({ url: 'wss://api.openai.com/v1/realtime', webContentsId: callWc })).toEqual({ 'User-Agent': 'x' })
    expect(send({ url: 'ws://127.0.0.1:47001/v1/realtime', webContentsId: callWc })).toEqual({ 'User-Agent': 'x', Authorization: 'Bearer llama' })
    controller.destroy()
    expect(send({ url: 'ws://127.0.0.1:51000/cloud/c1', webContentsId: callWc })).toEqual({ 'User-Agent': 'x' })
  })
})
