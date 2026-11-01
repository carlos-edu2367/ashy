import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIVE_MODE_SETTINGS,
  LIVE_LOCAL_MODELS,
  type AshyHostStreamEvent,
  type CallCheckInitiativeResult,
  type CallContextResult,
  type CallExecuteToolResult,
  type CallStateSnapshot,
  type LlamaCppEngineStatus,
  type ProactiveInitiativeRecord,
  type SaveLiveModeSettingsInput,
} from '@ashy/shared'
import { createAshyHostKernel, type AshyHostKernel } from '../host/kernel'
import { registerCallHostHandlers, type CallHostDeps } from '../host/live-call/handlers'
import {
  CALL_INSTRUCTIONS_MODE_LINE,
  CALL_INSTRUCTIONS_TEXT_MODE_LINE,
  CALL_INSTRUCTIONS_TOOLS_MODE_LINE,
  CALL_INSTRUCTIONS_TOOLS_TEXT_MODE_LINE,
  decideToolChoice,
} from '../host/live-call/context'
import { createLiveModeSettingsStore } from '../host/live-call/settings'
import { CALL_TOOL_NAMES, CALL_TOOL_OUTPUT_MAX_CHARS, buildCallToolDefinitions } from '../host/live-call/tools'
import { classifyVoiceApproval } from '../host/live-call/approvals'
import { VISION_PROMPT_PT, hasVisualIntent, type ScreenCaptureProvider } from '../host/live-call/vision'
import { CALL_INITIATIVE_COOLDOWN_MS, cleanInitiativeTopic } from '../host/live-call/initiative'
import type { FetchLike } from '../host/live-call/synthesize'

const tempDirs: string[] = []
const kernels: AshyHostKernel[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (kernels.length > 0) await kernels.pop()!.stop()
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    } catch {
      // Windows EPERM on a leaked handle
    }
  }
})

const MODEL_ID = DEFAULT_LIVE_MODE_SETTINGS.llamacpp.modelId
const AUTH = { Authorization: 'Bearer test-key-123' }

function baseStatus(): LlamaCppEngineStatus {
  return {
    engineId: 'llamacpp',
    build: 'b12024',
    installed: true,
    installedVariant: 'cuda-12.4',
    detectedGpu: null,
    running: true,
    managed: true,
    baseUrl: 'http://127.0.0.1:39123',
    port: 39123,
    activeModelId: MODEL_ID,
    installedModelIds: [MODEL_ID],
    activeDownload: null,
    lastError: null,
    vcRuntimeMissing: false,
    vcRuntimeInstall: null,
  }
}

interface FetchCall {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function createFakeFetch(opts: { description?: string; hang?: boolean } = {}) {
  const calls: FetchCall[] = []
  const fetchImpl: FetchLike = vi.fn(async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> })
    if (opts.hang) {
      return new Promise<never>(() => undefined)
    }
    const payload = JSON.stringify({
      choices: [{ message: { content: opts.description ?? 'Um editor de código com um arquivo TypeScript aberto.' } }],
    })
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), text: async () => payload }
  })
  return { fetchImpl, calls }
}

function fakeProvider(png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==') {
  const capture = vi.fn<ScreenCaptureProvider['capture']>(async (mode) => ({ pngBase64: png, source: mode }))
  return { capture } satisfies ScreenCaptureProvider
}

async function makeHarness(
  opts: { features?: SaveLiveModeSettingsInput['features']; backend?: 'llamacpp-realtime' | 'llamacpp-hybrid'; deps?: Partial<CallHostDeps>; hang?: boolean } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-call-tools-'))
  tempDirs.push(dir)
  const kernel = await createAshyHostKernel({ userDataDir: dir })
  kernels.push(kernel)
  const session = await kernel.createSession('Chamada 10.3')
  const events: AshyHostStreamEvent[] = []
  kernel.onHostEvent((e) => events.push(e))
  const status = baseStatus()
  const engine = {
    getStatus: vi.fn(() => ({ ...status })),
    start: vi.fn(async () => ({ ...status })),
    getModelSpec: (id: string) => LIVE_LOCAL_MODELS.find((m) => m.id === id),
    getRequestHeaders: vi.fn(() => ({ ...AUTH })),
  }
  kernel.setCallWindowController({ ensure: vi.fn(async () => undefined), destroy: vi.fn() })
  const settings = createLiveModeSettingsStore({ userDataDir: dir })
  // These tests describe the realtime instruction format; pin it (the app default is hybrid since 10.5).
  settings.save({ backend: opts.backend ?? 'llamacpp-realtime', features: opts.features ?? {} })
  const fake = createFakeFetch({ hang: opts.hang })
  const clock = { t: 1_800_000_000_000 }
  let seq = 0
  const handlers = registerCallHostHandlers(kernel.liveCall, {
    settings,
    engine,
    getCortex: () => kernel.cortex,
    resolveSessionId: () => session.id,
    transcribe: vi.fn(async () => ({ text: 'oi', providerId: 'fake', latencyMs: 1 })),
    now: () => clock.t,
    createCallId: () => `call-t-${++seq}`,
    fetchImpl: fake.fetchImpl,
    getAgencyRuntime: () => kernel.agencyRuntime,
    ...opts.deps,
  })
  const invoke = <T = unknown>(method: string, payload?: unknown) =>
    kernel.invokeLiveCall({ method: method as never, payload }) as Promise<T>
  const ofType = <K extends AshyHostStreamEvent['type']>(type: K) =>
    events.filter((e): e is Extract<AshyHostStreamEvent, { type: K }> => e.type === type)
  async function startCall(): Promise<string> {
    const started = await invoke<CallStateSnapshot>('call:start', {})
    const callId = started.callId!
    await invoke('call:reportState', { callId, status: 'listening' })
    return callId
  }
  const tick = () => new Promise((r) => setTimeout(r, 5))
  return { dir, kernel, events, settings, fake, clock, handlers, invoke, ofType, startCall, tick }
}

type Harness = Awaited<ReturnType<typeof makeHarness>>

async function stageNote(h: Harness, callId: string, title = 'Reunião', content = 'Amanhã tem reunião às 10h.') {
  const res = await h.invoke<CallExecuteToolResult>('call:executeTool', {
    callId,
    toolCallId: 'fc-1',
    name: 'write_project_note',
    argsJson: JSON.stringify({ title, content }),
  })
  await h.tick()
  return res
}

// ───────────────────────────── instructions / tools ─────────────────────────────

describe('Phase 10.3 — instructions and tools per mode', () => {
  it('realtime + toolsInCall: tool mode line LAST, 4 lean tools on the session-level call only', async () => {
    const h = await makeHarness({ features: { toolsInCall: true } })
    const callId = await h.startCall()
    const session = await h.invoke<CallContextResult>('call:buildContext', { callId })
    expect(session.instructions.endsWith(`\n${CALL_INSTRUCTIONS_TOOLS_MODE_LINE}`)).toBe(true)
    expect(session.instructions).toContain('Always respond in Brazilian Portuguese')
    expect(session.instructions.indexOf('Always respond in Brazilian Portuguese')).toBeLessThan(
      session.instructions.indexOf('Respond with function calls'),
    )
    expect(session.tools?.map((t) => t.name)).toEqual([...CALL_TOOL_NAMES])
    expect(session.toolChoice).toBeUndefined()
    const read = session.tools!.find((t) => t.name === 'read_workspace_file')!
    expect(read).toEqual({
      type: 'function',
      name: 'read_workspace_file',
      description: 'Reads an EXISTING text file the user names explicitly (e.g. "lê o arquivo notas.txt"). Never use it to save or write anything.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative file path' } }, required: ['path'] },
    })
    // Descriptions carry PT trigger examples on purpose: the real LFM3-2B check went 1/4 → 4/4
    // correct tool picks when read/write descriptions named the phrases ("anota", "lê o arquivo…").
    expect(session.tools!.every((t) => t.description.length < 200)).toBe(true)
    expect(session.tools!.some((t) => /approv/i.test(t.name))).toBe(false)

    const turn = await h.invoke<CallContextResult>('call:buildContext', { callId, userText: 'me conta uma piada' })
    expect(turn.tools).toBeUndefined()
    expect(turn.toolChoice).toBe('none')
    const turn2 = await h.invoke<CallContextResult>('call:buildContext', { callId, userText: 'que janela eu tô usando?' })
    expect(turn2.toolChoice).toBe('auto')
    // Tool turns carry no per-turn context (memories made LFM3 skip the function call).
    expect(turn2.perTurnContext).toBe('')
  })

  it('hybrid + toolsInCall: text tool mode line', async () => {
    const h = await makeHarness({ features: { toolsInCall: true }, backend: 'llamacpp-hybrid' })
    const callId = await h.startCall()
    const session = await h.invoke<CallContextResult>('call:buildContext', { callId })
    expect(session.instructions.endsWith(`\n${CALL_INSTRUCTIONS_TOOLS_TEXT_MODE_LINE}`)).toBe(true)
    expect(session.tools).toHaveLength(4)
  })

  it('toolsInCall off (default): 10.1/10.2 instructions, no tools, no toolChoice', async () => {
    const h = await makeHarness()
    const callId = await h.startCall()
    const session = await h.invoke<CallContextResult>('call:buildContext', { callId })
    expect(session.instructions.endsWith(`\n${CALL_INSTRUCTIONS_MODE_LINE}`)).toBe(true)
    expect(session).not.toHaveProperty('tools')
    const turn = await h.invoke<CallContextResult>('call:buildContext', { callId, userText: 'olha minha tela' })
    expect(turn).not.toHaveProperty('toolChoice')
    const blocked = await h.invoke<CallExecuteToolResult>('call:executeTool', {
      callId,
      toolCallId: 'x',
      name: 'get_active_window_title',
      argsJson: '{}',
    })
    expect(blocked.status).toBe('blocked')
    expect(CALL_INSTRUCTIONS_TEXT_MODE_LINE).toBe('Respond in text.')
  })

  it('tool definitions are deterministic and never include an approval tool', () => {
    expect(buildCallToolDefinitions()).toEqual(buildCallToolDefinitions())
    expect(buildCallToolDefinitions().map((t) => t.name)).not.toContain('approve')
  })
})

describe('Phase 10.3 — PT tool-intent heuristic', () => {
  it.each(['me conta uma piada', 'oi tudo bem', 'como foi seu dia', 'Oi Ashy, tudo bem?', 'você viu o jogo ontem?', 'pode me ajudar a pensar?'])(
    '"%s" → none',
    (text) => expect(decideToolChoice(text)).toBe('none'),
  )
  it.each([
    'que janela eu tô usando',
    'lê o arquivo notas.txt',
    'olha minha tela',
    'anota que amanhã tem reunião',
    'Ashy, que janela eu tô usando agora?',
    'Lê o arquivo notas.txt pra mim?',
    'salva isso numa nota',
    'o que aparece aqui?',
  ])('"%s" → auto', (text) => expect(decideToolChoice(text)).toBe('auto'))

  it('visual intent (no-tools vision path)', () => {
    expect(hasVisualIntent('olha minha tela')).toBe(true)
    expect(hasVisualIntent('vê isso aqui')).toBe(true)
    expect(hasVisualIntent('o que aparece?')).toBe(true)
    expect(hasVisualIntent('me conta uma piada')).toBe(false)
    expect(hasVisualIntent('você está bem?')).toBe(false)
  })
})

// ───────────────────────────── executeTool ─────────────────────────────

describe('Phase 10.3 — call:executeTool through the gatekeeper', () => {
  it('executed (read file, ≤ 2000 chars), staged (note → aguardando_aprovacao + card), blocked (eyes off), error', async () => {
    const h = await makeHarness({ features: { toolsInCall: true } })
    const callId = await h.startCall()
    fs.mkdirSync(path.join(h.dir, 'workspace'), { recursive: true })
    fs.writeFileSync(path.join(h.dir, 'workspace', 'notas.txt'), 'TODO: corrigir o fantasma no backend', 'utf8')
    fs.writeFileSync(path.join(h.dir, 'workspace', 'grande.txt'), 'x'.repeat(50_000), 'utf8')

    const read = await h.invoke<CallExecuteToolResult>('call:executeTool', {
      callId,
      toolCallId: 'fc-r',
      name: 'read_workspace_file',
      argsJson: '{"path":"notas.txt"}',
    })
    expect(read.status).toBe('executed')
    expect(JSON.parse(read.output)).toMatchObject({ conteudo: 'TODO: corrigir o fantasma no backend' })

    const big = await h.invoke<CallExecuteToolResult>('call:executeTool', {
      callId,
      toolCallId: 'fc-b',
      name: 'read_workspace_file',
      argsJson: '{"path":"grande.txt"}',
    })
    expect(big.status).toBe('executed')
    expect(big.output.length).toBeLessThanOrEqual(CALL_TOOL_OUTPUT_MAX_CHARS)
    expect(JSON.parse(big.output).truncado).toBe(true)

    const staged = await stageNote(h, callId)
    expect(staged.status).toBe('staged')
    expect(staged.cardId).toBeTruthy()
    expect(JSON.parse(staged.output)).toEqual({ status: 'aguardando_aprovacao', resumo: 'salvar a nota "Reunião"' })
    expect(fs.existsSync(path.join(h.dir, 'notes', 'reuni-o.md'))).toBe(false)

    const blocked = await h.invoke<CallExecuteToolResult>('call:executeTool', {
      callId,
      toolCallId: 'fc-w',
      name: 'get_active_window_title',
      argsJson: '',
    })
    expect(blocked.status).toBe('blocked')
    expect(JSON.parse(blocked.output).status).toBe('bloqueado')

    const unknown = await h.invoke<CallExecuteToolResult>('call:executeTool', {
      callId,
      toolCallId: 'fc-u',
      name: 'run_cleanup_command',
      argsJson: '{"command":"rm -rf /"}',
    })
    expect(unknown.status).toBe('error')
    const badJson = await h.invoke<CallExecuteToolResult>('call:executeTool', {
      callId,
      toolCallId: 'fc-j',
      name: 'read_workspace_file',
      argsJson: '{oops',
    })
    expect(badJson.status).toBe('error')
  })
})

// ───────────────────────────── approvals ─────────────────────────────

describe('Phase 10.3 — approvals (push events, voice, click, always)', () => {
  it('pushes agency:pending (callId, voiceApprovable) for call cards and for chat cards too', async () => {
    const h = await makeHarness({ features: { toolsInCall: true } })
    const callId = await h.startCall()
    const staged = await stageNote(h, callId)
    const pending = h.ofType('agency:pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.card).toMatchObject({
      id: staged.cardId,
      toolName: 'write_project_note',
      summary: 'Salvar a nota "Reunião"',
      riskTier: 'staged-confirm',
      voiceApprovable: true,
      callId,
    })
    // Outside the call (chat path): no callId.
    const chat = await h.kernel.agencyRuntime.callMcpTool({ toolName: 'write_project_note', args: { title: 'Chat', content: 'x' } })
    await h.tick()
    const chatEvent = h.ofType('agency:pending').find((e) => e.card.id === chat.pendingCard!.id)!
    expect(chatEvent.card.callId).toBeUndefined()
    // Legacy approve path (Consent Center RPC) also pushes agency:resolved.
    await h.kernel.agencyRuntime.denyPendingAction({ actionId: chat.pendingCard!.id })
    expect(h.ofType('agency:resolved').at(-1)).toMatchObject({ cardId: chat.pendingCard!.id, status: 'denied' })
  })

  it('voice "pode" approves the call card (approvalHandled + result context); "não" denies', async () => {
    const h = await makeHarness({ features: { toolsInCall: true } })
    const callId = await h.startCall()
    const staged = await stageNote(h, callId)
    const ctx = await h.invoke<CallContextResult>('call:buildContext', { callId, userText: 'Pode.' })
    expect(ctx.approvalHandled).toBe(true)
    expect(ctx.toolChoice).toBe('none')
    expect(ctx.perTurnContext.startsWith('[Contexto] O usuário aprovou "salvar a nota "Reunião""')).toBe(true)
    expect(ctx.perTurnContext).toContain('Resultado:')
    expect(h.ofType('agency:resolved').at(-1)).toMatchObject({ cardId: staged.cardId, status: 'approved' })
    expect(fs.readdirSync(path.join(h.dir, 'notes')).length).toBe(1)

    const staged2 = await stageNote(h, callId, 'Outra')
    const deny = await h.invoke<CallContextResult>('call:buildContext', { callId, userText: 'não' })
    expect(deny.approvalHandled).toBe(true)
    expect(deny.perTurnContext).toContain('O usuário negou "salvar a nota "Outra"". Nada foi feito.')
    expect(h.ofType('agency:resolved').at(-1)).toMatchObject({ cardId: staged2.cardId, status: 'denied' })

    // Non-phrase never approves.
    await stageNote(h, callId, 'Terceira')
    const chat = await h.invoke<CallContextResult>('call:buildContext', { callId, userText: 'pode me contar uma piada?' })
    expect(chat.approvalHandled).toBeUndefined()
    expect(h.kernel.agencyRuntime.listPendingCards()).toHaveLength(1)
  })

  it('never voice-approves blast-radius cards or cards that did not come from this call', async () => {
    const h = await makeHarness({ features: { toolsInCall: true } })
    const callId = await h.startCall()
    // Chat card (no origin) → voice ignored.
    await h.kernel.agencyRuntime.callMcpTool({ toolName: 'write_project_note', args: { title: 'Chat', content: 'x' } })
    const ignored = await h.invoke<CallContextResult>('call:buildContext', { callId, userText: 'pode' })
    expect(ignored.approvalHandled).toBeUndefined()
    // Blast-radius card from the call → voice ignored, the model is told to use the button.
    const blast = await stageNote(h, callId, 'Limpeza', 'rodar rm -rf build depois')
    const card = h.ofType('agency:pending').find((e) => e.card.id === blast.cardId)!.card
    expect(card.blastRadiusWarning).toBeTruthy()
    expect(card.voiceApprovable).toBe(false)
    const ctx = await h.invoke<CallContextResult>('call:buildContext', { callId, userText: 'pode sim' })
    expect(ctx.approvalHandled).toBeUndefined()
    expect(ctx.perTurnContext).toContain('só pode ser aprovada pelo botão')
    expect(h.kernel.agencyRuntime.listPendingCards().map((c) => c.id)).toContain(blast.cardId)
  })

  it('click agency:approve / agency:deny on a call card emits call:command inject {reason:approval}', async () => {
    const h = await makeHarness({ features: { toolsInCall: true } })
    const callId = await h.startCall()
    const staged = await stageNote(h, callId)
    const res = await h.invoke<{ status: string; injected: boolean }>('agency:approve', { cardId: staged.cardId })
    expect(res).toMatchObject({ status: 'approved', injected: true })
    const inject = h.ofType('call:command').filter((e) => e.command === 'inject')
    expect(inject).toHaveLength(1)
    expect(inject[0]).toMatchObject({ callId, reason: 'approval' })
    expect((inject[0] as { contextText: string }).contextText).toMatch(/^\[Contexto\] Ação aprovada: salvar a nota "Reunião"\. Resultado: /)

    const staged2 = await stageNote(h, callId, 'Outra')
    await h.invoke('agency:deny', { cardId: staged2.cardId })
    const inject2 = h.ofType('call:command').filter((e) => e.command === 'inject')
    expect((inject2.at(-1) as { contextText: string }).contextText).toContain('O usuário negou a ação: salvar a nota "Outra"')

    // A chat card approved by click while a call is active → no inject.
    const chat = await h.kernel.agencyRuntime.callMcpTool({ toolName: 'write_project_note', args: { title: 'Chat', content: 'x' } })
    const chatRes = await h.invoke<{ injected: boolean }>('agency:approve', { cardId: chat.pendingCard!.id })
    expect(chatRes.injected).toBe(false)
  })

  it('"always" persists an allow rule (next same-tool action runs), blast radius still asks, revoke works; voice "pode sempre"', async () => {
    const h = await makeHarness({ features: { toolsInCall: true } })
    const callId = await h.startCall()
    const first = await stageNote(h, callId)
    await h.invoke('agency:approve', { cardId: first.cardId, scope: 'always' })
    expect(h.kernel.cortex.db.getAgencyConsentState().toolRiskOverrides).toMatchObject({ write_project_note: 'read-safe' })

    const second = await stageNote(h, callId, 'Segunda')
    expect(second.status).toBe('executed')
    const blast = await stageNote(h, callId, 'Perigo', 'rm -rf build')
    expect(blast.status).toBe('staged')

    // Revoke through the existing consent path.
    await h.kernel.agencyRuntime.updateConsent({ toolRiskOverrides: {} })
    const third = await stageNote(h, callId, 'Terceira')
    expect(third.status).toBe('staged')

    // Voice "pode sempre" → scope always.
    expect(classifyVoiceApproval('Pode sempre!')).toBe('always')
    expect(classifyVoiceApproval('sempre permitir')).toBe('always')
    await h.kernel.agencyRuntime.denyPendingAction({ actionId: blast.cardId! })
    const ctx = await h.invoke<CallContextResult>('call:buildContext', { callId, userText: 'sempre pode' })
    expect(ctx.approvalHandled).toBe(true)
    expect(ctx.perTurnContext).toContain('sempre permitir')
    expect(h.kernel.cortex.db.getAgencyConsentState().toolRiskOverrides).toMatchObject({ write_project_note: 'read-safe' })
  })

  it('phrase classifier is whole-utterance and deterministic', () => {
    for (const p of ['pode', 'pode fazer', 'sim, pode', 'aprovado', 'autorizo', 'pode sim', 'manda ver', 'Ashy, pode!']) {
      expect(classifyVoiceApproval(p)).toBe('approve')
    }
    for (const p of ['não', 'Cancela.', 'não pode', 'deixa', 'negado']) expect(classifyVoiceApproval(p)).toBe('deny')
    for (const p of ['pode me ajudar', 'não sei', 'sim', 'deixa eu pensar', '']) expect(classifyVoiceApproval(p)).toBeNull()
  })
})

// ───────────────────────────── vision ─────────────────────────────

describe('Phase 10.3 — vision', () => {
  it('describes the screen via llama-server (headers, data URL, prompt), emits vision:capture, caches by bytes', async () => {
    const h = await makeHarness({ features: { toolsInCall: true } })
    const provider = fakeProvider()
    h.handlers.setScreenCaptureProvider(provider)
    await h.kernel.agencyRuntime.updateConsent({ eyesMode: 'screen' })
    const callId = await h.startCall()
    const res = await h.invoke<CallExecuteToolResult>('call:executeTool', {
      callId,
      toolCallId: 'v',
      name: 'capture_authorized_screen',
      argsJson: '{}',
    })
    expect(res.status).toBe('executed')
    expect(JSON.parse(res.output)).toEqual({ descricao: 'Um editor de código com um arquivo TypeScript aberto.' })
    expect(provider.capture).toHaveBeenCalledWith('screen', undefined)
    const visionCalls = h.fake.calls.filter((c) => c.url.endsWith('/v1/chat/completions'))
    expect(visionCalls).toHaveLength(1)
    expect(visionCalls[0]!.url).toBe('http://127.0.0.1:39123/v1/chat/completions')
    expect(visionCalls[0]!.headers).toMatchObject(AUTH)
    const content = (visionCalls[0]!.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content
    expect(content).toContainEqual({ type: 'text', text: VISION_PROMPT_PT })
    expect(String((content[0]!.image_url as { url: string }).url)).toMatch(/^data:image\/png;base64,iVBOR/)
    expect(h.ofType('vision:capture').map((e) => e.active)).toEqual([true, false])

    // Same bytes within 30 s → cached (no second request).
    const again = await h.handlers.vision.describe()
    expect(again).toMatchObject({ ok: true, cached: true })
    expect(h.fake.calls.filter((c) => c.url.endsWith('/v1/chat/completions'))).toHaveLength(1)
    h.clock.t += 31_000
    expect(await h.handlers.vision.describe()).toMatchObject({ ok: true, cached: false })
    expect(h.fake.calls.filter((c) => c.url.endsWith('/v1/chat/completions'))).toHaveLength(2)
  })

  it('eyesMode off refuses without capturing; no provider → unavailable; window mode needs an authorized title', async () => {
    const h = await makeHarness({ features: { toolsInCall: true } })
    const provider = fakeProvider()
    expect((await h.handlers.vision.describe()).ok).toBe(false)
    h.handlers.setScreenCaptureProvider(provider)
    const off = await h.handlers.vision.describe()
    expect(off).toMatchObject({ ok: false, reason: 'eyes_off' })
    expect(provider.capture).not.toHaveBeenCalled()
    const callId = await h.startCall()
    const blocked = await h.invoke<CallExecuteToolResult>('call:executeTool', {
      callId,
      toolCallId: 'v',
      name: 'capture_authorized_screen',
      argsJson: '{}',
    })
    expect(blocked.status).toBe('blocked')

    await h.kernel.agencyRuntime.updateConsent({ eyesMode: 'window', allowedWindowTitles: ['VS Code'] })
    const spy = vi.spyOn(h.kernel.agencyRuntime, 'getActiveWindowTitle').mockResolvedValue('Banco — Internet Banking')
    expect(await h.handlers.vision.describe()).toMatchObject({ ok: false, reason: 'window_not_authorized' })
    expect(provider.capture).not.toHaveBeenCalled()
    spy.mockResolvedValue('main.ts — VS Code')
    expect(await h.handlers.vision.describe()).toMatchObject({ ok: true, source: 'window' })
    expect(provider.capture).toHaveBeenCalledWith('window', 'main.ts — VS Code')
  })

  it('times out (8 s default; short here) with a clear text', async () => {
    const h = await makeHarness({ hang: true, deps: { visionTimeoutMs: 30 } })
    h.handlers.setScreenCaptureProvider(fakeProvider())
    await h.kernel.agencyRuntime.updateConsent({ eyesMode: 'screen' })
    const res = await h.handlers.vision.describe()
    expect(res).toMatchObject({ ok: false, reason: 'timeout' })
    expect(res.text).toMatch(/demorou/)
    expect(h.ofType('vision:capture').at(-1)).toMatchObject({ active: false })
  })

  it('visual intent without tools → [Tela] context (visionInCall)', async () => {
    const h = await makeHarness({ features: { visionInCall: true } })
    h.handlers.setScreenCaptureProvider(fakeProvider())
    await h.kernel.agencyRuntime.updateConsent({ eyesMode: 'screen' })
    const callId = await h.startCall()
    const ctx = await h.invoke<CallContextResult>('call:buildContext', { callId, userText: 'olha minha tela' })
    expect(ctx.perTurnContext).toContain('[Tela] Um editor de código com um arquivo TypeScript aberto.')
    const plain = await h.invoke<CallContextResult>('call:buildContext', { callId, userText: 'me conta uma piada' })
    expect(plain.perTurnContext).not.toContain('[Tela]')
  })

  it('the kernel exposes setScreenCaptureProvider', async () => {
    const h = await makeHarness()
    expect(typeof h.kernel.setScreenCaptureProvider).toBe('function')
    h.kernel.setScreenCaptureProvider(fakeProvider())
    h.kernel.setScreenCaptureProvider(null)
  })
})

// ───────────────────────────── initiative ─────────────────────────────

function spokenRecord(): ProactiveInitiativeRecord {
  return {
    id: 'init-1',
    triggerKind: 'idle_nudge' as ProactiveInitiativeRecord['triggerKind'],
    sourceId: null,
    sourceTitle: 'o projeto Ashy',
    noticePrompt: 'perguntar como está indo o projeto Ashy',
    replyText: null,
    decision: 'spoken',
    reason: 'idle',
    createdAt: 1,
  }
}

describe('Phase 10.3 — call:checkInitiative', () => {
  it('speaks via the attention engine, then respects the 10-min call cooldown, mute, DND and the feature flag', async () => {
    const evaluate = vi.fn(() => spokenRecord())
    const h = await makeHarness({ features: { initiativeInCall: true }, deps: { evaluateInitiative: evaluate } })
    const callId = await h.startCall()
    await h.invoke('call:buildContext', { callId, userText: 'tô trabalhando no projeto' })
    const first = await h.invoke<CallCheckInitiativeResult>('call:checkInitiative', { callId, idleMs: 90_000 })
    expect(first).toMatchObject({
      speak: true,
      contextText:
        '[Contexto] (Iniciativa) O usuário está em silêncio. Puxe assunto de forma natural, em uma frase curta, sobre algo que ele mencionou antes: «o projeto Ashy»',
    })
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ idleMinutes: 1.5, recentUserMessage: 'tô trabalhando no projeto', forceDnd: false }),
    )
    expect(await h.invoke('call:checkInitiative', { callId, idleMs: 90_000 })).toMatchObject({ speak: false, reason: 'call_cooldown' })
    h.clock.t += CALL_INITIATIVE_COOLDOWN_MS
    await h.invoke('call:setMuted', { muted: true })
    expect(await h.invoke('call:checkInitiative', { callId, idleMs: 90_000 })).toMatchObject({ speak: false, reason: 'muted' })
    await h.invoke('call:setMuted', { muted: false })
    await h.kernel.agencyRuntime.updateConsent({ dndMode: true })
    expect(await h.invoke('call:checkInitiative', { callId, idleMs: 90_000 })).toMatchObject({ speak: false, reason: 'dnd' })
    await h.kernel.agencyRuntime.updateConsent({ dndMode: false })
    expect(await h.invoke('call:checkInitiative', { callId, idleMs: 90_000 })).toMatchObject({ speak: true })
    h.settings.save({ features: { initiativeInCall: false } })
    expect(await h.invoke('call:checkInitiative', { callId, idleMs: 90_000 })).toMatchObject({ speak: false, reason: 'disabled' })
  })

  it('a silent decision from the engine does not speak (real cortex path)', async () => {
    const h = await makeHarness({ features: { initiativeInCall: true } })
    const callId = await h.startCall()
    const res = await h.invoke<CallCheckInitiativeResult>('call:checkInitiative', { callId, idleMs: 90_000 })
    if (!res.speak) expect(res.reason).toBeTruthy()
    else expect(res.contextText).toMatch(/^\[Contexto\] \(Iniciativa\)/)
  })
})

describe('Phase 10.3 — cleanInitiativeTopic', () => {
  it('turns the raw proactive notice seen in the real run into a clean topic', () => {
    const raw =
      '[Proactive Notice] - Source: recurring_theme - Observation: usuario: Ashie, me conta como foi o seu dia hoje, com detalhes, por favor. & Ashie, me conta como foi o seu dia hoje, com detalhes, por favor. - Current Mood [V, A, P]: [0.35, 0.6, 0.1]'
    expect(cleanInitiativeTopic(raw)).toBe('me conta como foi o seu dia hoje, com detalhes, por favor.')
    expect(cleanInitiativeTopic('o projeto Ashy')).toBe('o projeto Ashy')
    expect(cleanInitiativeTopic('')).toBe('')
  })
})
