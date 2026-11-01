import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ASHY_EMOTIONS,
  ASHY_MOTION_PRESETS,
  DEFAULT_LIVE_MODE_SETTINGS,
  LIVE_LOCAL_MODELS,
  type AshyHostBridge,
  type AshyHostStreamEvent,
  type CallContextResult,
  type CallRuntimeConfig,
  type CallStateSnapshot,
  type CallSynthesizeResult,
  type CallTestInput,
  type CallTestResult,
  type LlamaCppEngineStatus,
  type VoiceReference,
} from '@ashy/shared'
import { createAshyHostKernel, type AshyHostKernel } from '../host/kernel'
import { registerCallHostHandlers, type CallHostDeps } from '../host/live-call/handlers'
import {
  CALL_INSTRUCTIONS_MODE_LINE,
  CALL_INSTRUCTIONS_TEXT_MODE_LINE,
  buildCallInstructions,
} from '../host/live-call/context'
import { createLiveModeSettingsStore } from '../host/live-call/settings'
import { classifyCallAffect, normalizeStageSignal } from '../host/live-call/affect'
import {
  encodeMonoPcm16Wav,
  parseWav,
  requestLlamaTts,
  type FetchLike,
} from '../host/live-call/synthesize'
import { createVoiceStore, VOICE_MAX_COUNT, VOICE_PREVIEW_DEFAULT_TEXT } from '../host/live-call/voices'
import { TEST_CALL_QUESTION } from '../host/live-call/test-call'

const tempDirs: string[] = []
const kernels: AshyHostKernel[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
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

function tone(durationMs: number, sampleRate: number, value?: number): Int16Array {
  const n = Math.round((sampleRate * durationMs) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = value ?? Math.round(Math.sin(i / 7) * 8000)
  return out
}

function wavB64(durationMs: number, sampleRate = 24000): string {
  return Buffer.from(encodeMonoPcm16Wav(tone(durationMs, sampleRate), sampleRate)).toString('base64')
}

/** Hand-built WAV with an arbitrary format (stereo / float / 8-bit). */
function customWav(opts: { channels: number; bits: number; format: number; rate: number; ms: number }): string {
  const frames = Math.round((opts.rate * opts.ms) / 1000)
  const dataBytes = frames * opts.channels * (opts.bits / 8)
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(opts.format, 20)
  buf.writeUInt16LE(opts.channels, 22)
  buf.writeUInt32LE(opts.rate, 24)
  buf.writeUInt32LE((opts.rate * opts.channels * opts.bits) / 8, 28)
  buf.writeUInt16LE((opts.channels * opts.bits) / 8, 32)
  buf.writeUInt16LE(opts.bits, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  return buf.toString('base64')
}

function baseStatus(overrides: Partial<LlamaCppEngineStatus> = {}): LlamaCppEngineStatus {
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
    ...overrides,
  }
}

interface TtsCall {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** Fake llama-server /tts: answers a 24 kHz PCM16 WAV of `ms` per request. */
function createFakeTtsFetch(ms = 1000) {
  const calls: TtsCall[] = []
  const fetchImpl: FetchLike = vi.fn(async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> })
    const wav = encodeMonoPcm16Wav(tone(ms, 24000, 1234), 24000)
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer,
      text: async () => '',
    }
  })
  return { fetchImpl, calls }
}

async function makeHarness(opts: { deps?: Partial<CallHostDeps>; status?: Partial<LlamaCppEngineStatus> } = {}) {
  const dir = tempDir('ashy-call-quality-')
  const kernel = await createAshyHostKernel({ userDataDir: dir })
  kernels.push(kernel)
  const session = await kernel.createSession('Chamada 10.2')
  const events: AshyHostStreamEvent[] = []
  kernel.onHostEvent((e) => events.push(e))
  const status = baseStatus(opts.status)
  const engine = {
    getStatus: vi.fn(() => ({ ...status })),
    start: vi.fn(async (modelId?: string) => {
      status.running = true
      status.baseUrl = 'http://127.0.0.1:39123'
      status.port = 39123
      status.activeModelId = modelId ?? MODEL_ID
      return { ...status }
    }),
    getModelSpec: (id: string) => LIVE_LOCAL_MODELS.find((m) => m.id === id),
    getRequestHeaders: vi.fn(() => ({ ...AUTH })),
  }
  kernel.setCallWindowController({ ensure: vi.fn(async () => undefined), destroy: vi.fn() })
  const settings = createLiveModeSettingsStore({ userDataDir: dir })
  const tts = createFakeTtsFetch()
  const clock = { t: 1_800_000_000_000 }
  let seq = 0
  const handlers = registerCallHostHandlers(kernel.liveCall, {
    settings,
    engine,
    getCortex: () => kernel.cortex,
    resolveSessionId: () => session.id,
    transcribe: vi.fn(async () => ({ text: 'oi', providerId: 'fake', latencyMs: 1 })),
    now: () => clock.t,
    createCallId: () => `call-q-${++seq}`,
    userDataDir: dir,
    fetchImpl: tts.fetchImpl,
    ...opts.deps,
  })
  const invoke = <T = unknown>(method: string, payload?: unknown) =>
    kernel.invokeLiveCall({ method: method as never, payload }) as Promise<T>
  const ofType = <K extends AshyHostStreamEvent['type']>(type: K) =>
    events.filter((e): e is Extract<AshyHostStreamEvent, { type: K }> => e.type === type)
  return { dir, kernel, session, events, engine, settings, tts, invoke, ofType, handlers, status }
}

// ───────────────────────────── voices ─────────────────────────────

describe('Phase 10.2 — reference voices (liveVoice:*)', () => {
  it('imports a valid voice (stored as mono 24 kHz WAV + voices.json), lists and previews it', async () => {
    const h = await makeHarness()
    const voice = await h.invoke<VoiceReference>('liveVoice:import', { name: '  Minha voz  ', wavBase64: wavB64(6000, 16000) })
    expect(voice).toMatchObject({ name: 'Minha voz', durationMs: 6000, createdAt: 1_800_000_000_000 })
    expect(voice.id).toMatch(/^[a-z0-9-]{1,64}$/)
    const file = path.join(h.dir, 'voices', `${voice.id}.wav`)
    const stored = parseWav(new Uint8Array(fs.readFileSync(file)))
    expect(stored).toMatchObject({ sampleRate: 24000, channels: 1, bitsPerSample: 16, durationMs: 6000 })
    const index = JSON.parse(fs.readFileSync(path.join(h.dir, 'voices', 'voices.json'), 'utf8'))
    expect(index.voices).toEqual([voice])
    await expect(h.invoke('liveVoice:list')).resolves.toEqual([voice])

    const preview = await h.invoke<{ wavBase64: string; latencyMs: number }>('liveVoice:preview', { id: voice.id })
    expect(parseWav(new Uint8Array(Buffer.from(preview.wavBase64, 'base64'))).sampleRate).toBe(24000)
    expect(h.tts.calls).toHaveLength(1)
    expect(h.tts.calls[0]!.url).toBe('http://127.0.0.1:39123/tts')
    expect(h.tts.calls[0]!.headers).toMatchObject(AUTH)
    expect(h.tts.calls[0]!.body).toEqual({
      input: VOICE_PREVIEW_DEFAULT_TEXT,
      voice: 'female',
      language: 'pt',
      response_format: 'wav',
      speaker_ref_b64: fs.readFileSync(file).toString('base64'),
    })
    // id null → built-in voice only, custom text.
    await h.invoke('liveVoice:preview', { id: null, text: 'Teste rápido.' })
    expect(h.tts.calls[1]!.body).not.toHaveProperty('speaker_ref_b64')
    expect(h.tts.calls[1]!.body.input).toBe('Teste rápido.')
    await expect(h.invoke('liveVoice:preview', { id: 'nao-existe' })).rejects.toThrow(/VOICE_NOT_FOUND/)
  })

  it('rejects stereo, float, 8-bit, out-of-range rates and durations, junk and bad ids', async () => {
    const h = await makeHarness()
    const bad = [
      customWav({ channels: 2, bits: 16, format: 1, rate: 24000, ms: 6000 }),
      customWav({ channels: 1, bits: 32, format: 3, rate: 24000, ms: 6000 }),
      customWav({ channels: 1, bits: 8, format: 1, rate: 24000, ms: 6000 }),
      wavB64(6000, 8000),
      wavB64(6000, 96000),
      wavB64(4000, 24000),
      wavB64(31000, 24000),
      Buffer.from('definitely not a wav file, just some text bytes .............').toString('base64'),
    ]
    const codes: string[] = []
    for (const wavBase64 of bad) {
      const err = await h.invoke('liveVoice:import', { name: 'x', wavBase64 }).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      codes.push(String((err as Error).message).split(':')[0]!)
    }
    expect(codes).toEqual([
      'VOICE_BAD_FORMAT',
      'VOICE_BAD_FORMAT',
      'VOICE_INVALID_AUDIO',
      'VOICE_BAD_FORMAT',
      'VOICE_BAD_FORMAT',
      'VOICE_BAD_DURATION',
      'VOICE_BAD_DURATION',
      'VOICE_INVALID_AUDIO',
    ])
    await expect(h.invoke('liveVoice:import', { name: '', wavBase64: wavB64(6000) })).rejects.toThrow(/Invalid payload/)
    await expect(h.invoke('liveVoice:delete', { id: '../etc' })).rejects.toThrow(/Invalid payload/)
    await expect(h.invoke('liveVoice:list')).resolves.toEqual([])
    expect(fs.existsSync(path.join(h.dir, 'voices')) ? fs.readdirSync(path.join(h.dir, 'voices')) : []).toEqual([])
  })

  it(`allows at most ${VOICE_MAX_COUNT} voices`, () => {
    const dir = tempDir('ashy-voices-limit-')
    const store = createVoiceStore({ userDataDir: dir })
    const wav = wavB64(5000, 16000)
    for (let i = 0; i < VOICE_MAX_COUNT; i++) store.import({ name: `v${i}`, wavBase64: wav })
    expect(store.list()).toHaveLength(VOICE_MAX_COUNT)
    expect(new Set(store.list().map((v) => v.id)).size).toBe(VOICE_MAX_COUNT)
    expect(() => store.import({ name: 'extra', wavBase64: wav })).toThrow(/VOICE_LIMIT/)
  })

  it('deleting the voice in use resets hybrid.referenceVoiceId to null (other voices keep it)', async () => {
    const h = await makeHarness()
    const a = await h.invoke<VoiceReference>('liveVoice:import', { name: 'A', wavBase64: wavB64(6000) })
    const b = await h.invoke<VoiceReference>('liveVoice:import', { name: 'B', wavBase64: wavB64(7000) })
    h.settings.save({ hybrid: { referenceVoiceId: a.id } })

    const delB = await h.invoke<{ deleted: boolean; referenceVoiceId: string | null }>('liveVoice:delete', { id: b.id })
    expect(delB).toMatchObject({ deleted: true, referenceVoiceId: a.id })
    expect(h.settings.get().hybrid.referenceVoiceId).toBe(a.id)

    const delA = await h.invoke<{ deleted: boolean; voices: VoiceReference[]; referenceVoiceId: string | null }>(
      'liveVoice:delete',
      { id: a.id },
    )
    expect(delA).toMatchObject({ deleted: true, voices: [], referenceVoiceId: null })
    expect(h.settings.get().hybrid.referenceVoiceId).toBeNull()
    // Persisted too.
    expect(createLiveModeSettingsStore({ userDataDir: h.dir }).get().hybrid.referenceVoiceId).toBeNull()
    expect(fs.existsSync(path.join(h.dir, 'voices', `${a.id}.wav`))).toBe(false)
    await expect(h.invoke('liveVoice:delete', { id: a.id })).resolves.toMatchObject({ deleted: false })
  })
})

// ───────────────────────────── synthesize ─────────────────────────────

describe('Phase 10.2 — call:synthesize (llama-server /tts)', () => {
  it('POSTs /tts with auth headers, the settings voice and the active reference, and returns decoded PCM16', async () => {
    const h = await makeHarness()
    const voice = await h.invoke<VoiceReference>('liveVoice:import', { name: 'Eu', wavBase64: wavB64(8000) })
    h.settings.save({ llamacpp: { voice: 'male' }, hybrid: { referenceVoiceId: voice.id } })
    const state = await h.invoke<CallStateSnapshot>('call:start', { backend: 'llamacpp-hybrid' })

    const res = await h.invoke<CallSynthesizeResult>('call:synthesize', { callId: state.callId, text: 'Olá, tudo bem?' })
    expect(res.sampleRate).toBe(24000)
    expect(res.durationMs).toBe(1000)
    const pcm = Buffer.from(res.pcmBase64, 'base64')
    expect(pcm.byteLength).toBe(24000 * 2)
    expect(pcm.readInt16LE(0)).toBe(1234)
    expect(res.latencyMs).toBeGreaterThanOrEqual(0)

    const call = h.tts.calls[0]!
    expect(call.url).toBe('http://127.0.0.1:39123/tts')
    expect(call.headers).toMatchObject({ ...AUTH, 'Content-Type': 'application/json' })
    expect(h.engine.getRequestHeaders).toHaveBeenCalled()
    expect(call.body).toEqual({
      input: 'Olá, tudo bem?',
      voice: 'male',
      language: 'pt',
      response_format: 'wav',
      speaker_ref_b64: fs.readFileSync(path.join(h.dir, 'voices', `${voice.id}.wav`)).toString('base64'),
    })

    // Reference cached in memory: a second call doesn't re-read the disk.
    const readSpy = vi.spyOn(fs, 'readFileSync')
    await h.invoke('call:synthesize', { callId: state.callId, text: 'De novo.' })
    expect(readSpy.mock.calls.filter(([p]) => String(p).endsWith('.wav'))).toHaveLength(0)
    expect(h.tts.calls[1]!.body.speaker_ref_b64).toBe(call.body.speaker_ref_b64)

    // No reference voice → no speaker_ref_b64.
    h.settings.save({ hybrid: { referenceVoiceId: null } })
    await h.invoke('call:synthesize', { callId: state.callId, text: 'Sem referência.' })
    expect(h.tts.calls[2]!.body).not.toHaveProperty('speaker_ref_b64')

    await expect(h.invoke('call:synthesize', { callId: 'call-unknown', text: 'x' })).rejects.toThrow(/CALL_UNKNOWN/)
    await expect(h.invoke('call:synthesize', { callId: state.callId, text: '' })).rejects.toThrow(/Invalid payload/)
  })

  it('works without getRequestHeaders (user endpoint / pre-T3 engine)', async () => {
    const tts = createFakeTtsFetch(500)
    const res = await requestLlamaTts({ baseUrl: 'http://x:1/', text: 'oi', voice: 'female', fetchImpl: tts.fetchImpl })
    expect(tts.calls[0]!.url).toBe('http://x:1/tts')
    expect(tts.calls[0]!.headers).not.toHaveProperty('Authorization')
    expect(res.parsed.durationMs).toBe(500)
  })

  it('times out after the configured budget, maps HTTP errors and bad audio', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    await expect(
      requestLlamaTts({ baseUrl: 'http://x:1', text: 'oi', voice: 'female', fetchImpl: hanging, timeoutMs: 30 }),
    ).rejects.toThrow(/TTS_TIMEOUT/)

    const http500: FetchLike = async () => ({
      ok: false,
      status: 500,
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => 'boom',
    })
    await expect(requestLlamaTts({ baseUrl: 'http://x:1', text: 'oi', voice: 'female', fetchImpl: http500 })).rejects.toThrow(
      /TTS_HTTP_500: boom/,
    )
    const junk: FetchLike = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode('{"error":"nope"}').buffer as ArrayBuffer,
      text: async () => '',
    })
    await expect(requestLlamaTts({ baseUrl: 'http://x:1', text: 'oi', voice: 'female', fetchImpl: junk })).rejects.toThrow(
      /TTS_BAD_AUDIO/,
    )
  })

  it('decodes streamed WAVs with placeholder sizes', () => {
    const wav = encodeMonoPcm16Wav(tone(250, 24000, 77), 24000)
    const view = new DataView(wav.buffer)
    view.setUint32(4, 0xffffffff, true)
    view.setUint32(40, 0xffffffff, true)
    const parsed = parseWav(wav)
    expect(parsed.durationMs).toBe(250)
    expect(parsed.pcm[10]).toBe(77)
  })
})

// ───────────────────────────── affect ─────────────────────────────

describe('Phase 10.2 — call:classifyAffect heuristic + call:reportStage', () => {
  it('maps PT cues to ASHY emotions and motion presets (null when neutral)', () => {
    const cases: Array<[string, string, string | undefined]> = [
      ['Hahaha, essa foi ótima!', 'happy', 'laugh'],
      ['Uau, não acredito nisso!', 'surprised', 'sparkle'],
      ['Que incrível, adorei a ideia!', 'excited', 'bounce'],
      ['Sinto muito, deve ter sido difícil.', 'sad', 'nod'],
      ['Hmm, deixa eu pensar um pouco.', 'think', 'think'],
      ['Tô brincando, viu?', 'tease', 'tease'],
      ['Ops, foi mal, me confundi.', 'awkward', 'shrug'],
      ['Que absurdo isso!', 'angry', 'shake'],
      ['E você, o que você acha?', 'curious', undefined],
      ['Meu pai foi internado às pressas no hospital.', 'concerned', 'nod'],
    ]
    for (const [text, emotion, motion] of cases) {
      const signal = classifyCallAffect(text)
      expect(signal, text).not.toBeNull()
      expect(signal!.emotion, text).toBe(emotion)
      expect(signal!.motion, text).toBe(motion)
      expect(signal!.intensity).toBeGreaterThan(0)
      expect(signal!.intensity).toBeLessThanOrEqual(1)
      expect((ASHY_EMOTIONS as readonly string[]).includes(signal!.emotion)).toBe(true)
      if (signal!.motion) expect((ASHY_MOTION_PRESETS as readonly string[]).includes(signal!.motion)).toBe(true)
    }
    expect(classifyCallAffect('O céu fica azul por causa da dispersão da luz.')).toBeNull()
    expect(classifyCallAffect('<|ACT {"emotion":"happy"}|>')).toBeNull()
    // More exclamation → stronger.
    expect(classifyCallAffect('Que legal!!!')!.intensity).toBeGreaterThan(classifyCallAffect('Que legal.')!.intensity)
  })

  it('is fast (no LLM): 200 sentences well under 200 ms', () => {
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) classifyCallAffect(`Frase número ${i}, uau que legal, hmm talvez?`)
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('normalizes stage signals', () => {
    expect(normalizeStageSignal({ emotion: 'HAPPY', intensity: 2, motion: 'laugh' })).toEqual({
      emotion: 'happy',
      intensity: 1,
      motion: 'laugh',
    })
    expect(normalizeStageSignal({ emotion: 'happy', intensity: 0.5, motion: 'moonwalk' })).toEqual({ emotion: 'happy', intensity: 0.5 })
    expect(normalizeStageSignal({ emotion: 'ecstatic', intensity: 0.5 })).toBeNull()
  })

  it('classifyAffect over RPC; reportStage emits call:stage only for the active call', async () => {
    const h = await makeHarness()
    const state = await h.invoke<CallStateSnapshot>('call:start', {})
    await expect(h.invoke('call:classifyAffect', { callId: state.callId, text: 'Kkkkk adorei!' })).resolves.toMatchObject({
      emotion: 'happy',
    })
    await expect(h.invoke('call:reportStage', { callId: state.callId, emotion: 'excited', intensity: 0.8, motion: 'bounce' })).resolves.toEqual({
      emitted: true,
    })
    expect(h.ofType('call:stage')).toEqual([
      { type: 'call:stage', callId: state.callId, emotion: 'excited', intensity: 0.8, motion: 'bounce' },
    ])
    await expect(h.invoke('call:reportStage', { callId: 'other', emotion: 'happy', intensity: 0.5 })).resolves.toEqual({ emitted: false })
    await expect(h.invoke('call:reportStage', { callId: state.callId, emotion: 'bogus', intensity: 0.5 })).resolves.toEqual({
      emitted: false,
    })
    await expect(h.invoke('call:reportStage', { callId: state.callId, emotion: 'happy', intensity: 3 })).rejects.toThrow(/Invalid payload/)
    await h.invoke('call:stop', {})
    await expect(h.invoke('call:reportStage', { callId: state.callId, emotion: 'happy', intensity: 0.5 })).resolves.toEqual({
      emitted: false,
    })
    expect(h.ofType('call:stage')).toHaveLength(1)
  })
})

// ───────────────────────────── hybrid backend + context mode line ─────────────────────────────

describe('Phase 10.2 — hybrid backend start and buildContext mode line', () => {
  it('starts llamacpp-hybrid like realtime (engine required) and ends instructions with the text-mode line', async () => {
    const h = await makeHarness({ status: { running: false, baseUrl: null, port: null, activeModelId: null } })
    const state = await h.invoke<CallStateSnapshot>('call:start', { backend: 'llamacpp-hybrid' })
    expect(h.engine.start).toHaveBeenCalledWith(MODEL_ID)
    expect(state).toMatchObject({ status: 'connecting', backend: 'llamacpp-hybrid' })
    const cmd = h.ofType('call:command').find((e) => e.command === 'start')!
    expect(cmd).toMatchObject({ backend: 'llamacpp-hybrid', callId: state.callId })
    expect(cmd).not.toHaveProperty('test')
    const cfg = await h.invoke<CallRuntimeConfig>('call:getRuntimeConfig', { callId: state.callId })
    expect(cfg.llamacpp).toMatchObject({ baseUrl: 'http://127.0.0.1:39123', contextSize: 16384 })

    const ctx = await h.invoke<CallContextResult>('call:buildContext', { callId: state.callId })
    expect(ctx.instructions.split('\n').at(-1)).toBe(CALL_INSTRUCTIONS_TEXT_MODE_LINE)
    expect(ctx.instructions).not.toContain(CALL_INSTRUCTIONS_MODE_LINE)
    await h.invoke('call:stop', {})

    const rt = await h.invoke<CallStateSnapshot>('call:start', { backend: 'llamacpp-realtime' })
    const ctx2 = await h.invoke<CallContextResult>('call:buildContext', { callId: rt.callId })
    expect(ctx2.instructions.split('\n').at(-1)).toBe(CALL_INSTRUCTIONS_MODE_LINE)
  })

  it('buildCallInstructions(mode) keeps the mode line last and within budget', () => {
    expect(buildCallInstructions({ mode: 'text' }).endsWith(`\n${CALL_INSTRUCTIONS_TEXT_MODE_LINE}`)).toBe(true)
    expect(buildCallInstructions().endsWith(`\n${CALL_INSTRUCTIONS_MODE_LINE}`)).toBe(true)
    expect(buildCallInstructions({ mode: 'text', userName: 'Carlos' }).length).toBeLessThanOrEqual(1200)
  })
})

// ───────────────────────────── test call ─────────────────────────────

describe('Phase 10.2 — test call (call:startTest / getTestInput / reportTestResult)', () => {
  it('synthesizes the male question, starts a test call, serves 16 kHz input, never persists and reports the result', async () => {
    const h = await makeHarness({ status: { running: false, baseUrl: null, port: null, activeModelId: null } })
    const voice = await h.invoke<VoiceReference>('liveVoice:import', { name: 'Ref', wavBase64: wavB64(6000) })
    h.settings.save({ hybrid: { referenceVoiceId: voice.id } })

    const started = await h.invoke<{ ok: boolean; callId: string; state: CallStateSnapshot }>('call:startTest', {})
    expect(started.ok).toBe(true)
    expect(h.engine.start).toHaveBeenCalled()
    // Question: male voice, no reference.
    expect(h.tts.calls[0]!.body).toEqual({
      input: TEST_CALL_QUESTION,
      voice: 'male',
      language: 'pt',
      response_format: 'wav',
    })
    expect(h.tts.calls[0]!.headers).toMatchObject(AUTH)
    const cmd = h.ofType('call:command').find((e) => e.command === 'start')!
    expect(cmd).toMatchObject({ command: 'start', callId: started.callId, test: true })
    expect(started.state.status).toBe('connecting')

    const input = await h.invoke<CallTestInput>('call:getTestInput', { callId: started.callId })
    expect(input.expectedText).toBe(TEST_CALL_QUESTION)
    const wav = parseWav(new Uint8Array(Buffer.from(input.wavBase64, 'base64')))
    expect(wav).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: 1000 })
    await expect(h.invoke('call:getTestInput', { callId: 'nope' })).rejects.toThrow(/TEST_INPUT_UNKNOWN/)

    // A test turn: context works, but recordTurn persists nothing and has no side effects.
    await h.invoke('call:buildContext', { callId: started.callId, userText: 'oi ashy' })
    const affectSpy = vi.spyOn(h.kernel.cortex, 'applyUserTurnAffect')
    const appendSpy = vi.spyOn(h.kernel.cortex, 'appendVoiceTurn')
    const before = h.kernel.cortex.listChatMessages(h.session.id).length
    const rec = await h.invoke<{ skipped?: string }>('call:recordTurn', {
      callId: started.callId,
      userTranscript: 'Oi Ashy, tudo bem?',
      assistantSpokenText: 'Tudo ótimo!',
      interrupted: false,
    })
    expect(rec).toMatchObject({ skipped: 'test_call' })
    expect(appendSpy).not.toHaveBeenCalled()
    expect(affectSpy).not.toHaveBeenCalled()
    expect(h.kernel.cortex.listChatMessages(h.session.id)).toHaveLength(before)
    expect(h.ofType('chat:appended')).toHaveLength(0)

    const result = await h.invoke<CallTestResult>('call:reportTestResult', {
      callId: started.callId,
      ok: true,
      steps: [
        { step: 'engine', ok: true, ms: 5 },
        { step: 'session', ok: true, ms: 120.4 },
        { step: 'vad', ok: true },
        { step: 'transcription', ok: true, detail: 'similarity 0.92' },
        { step: 'first_audio', ok: true, ms: 900 },
        { step: 'playback', ok: true },
      ],
      metrics: { e2eMs: 1300 },
      transcript: 'Oi Ashy, tudo bem?',
      reply: 'Tudo ótimo!',
    })
    expect(result).toMatchObject({ ok: true, metrics: { e2eMs: 1300 }, finishedAt: 1_800_000_000_000 })
    expect(result.steps[1]).toEqual({ step: 'session', ok: true, ms: 120 })
    expect(h.ofType('call:testResult')).toEqual([{ type: 'call:testResult', result }])

    // A normal call afterwards is persisted again.
    await h.invoke('call:stop', {})
    const normal = await h.invoke<CallStateSnapshot>('call:start', {})
    await h.invoke('call:recordTurn', {
      callId: normal.callId,
      userTranscript: 'Agora de verdade',
      assistantSpokenText: 'Beleza.',
      interrupted: false,
    })
    expect(appendSpy).toHaveBeenCalledTimes(1)
    await expect(
      h.invoke('call:reportTestResult', { callId: normal.callId, ok: true, steps: [] }),
    ).rejects.toThrow(/TEST_CALL_UNKNOWN/)
  })

  it('reports ok:false when any step fails, and a failed start (engine / tts) as an engine-step failure', async () => {
    const h = await makeHarness()
    const started = await h.invoke<{ callId: string }>('call:startTest', {})
    const result = await h.invoke<CallTestResult>('call:reportTestResult', {
      callId: started.callId,
      ok: true,
      steps: [
        { step: 'engine', ok: true },
        { step: 'transcription', ok: false, detail: 'empty' },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ metrics: null, transcript: null, reply: null })
    await h.invoke('call:stop', {})

    // Busy: a call in progress.
    await h.invoke('call:start', {})
    await expect(h.invoke('call:startTest', {})).rejects.toThrow(/CALL_BUSY/)
    await h.invoke('call:stop', {})

    // TTS failure.
    const failing = await makeHarness({
      deps: {
        fetchImpl: async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0), text: async () => 'loading' }),
      },
    })
    const res = await failing.invoke<{ ok: boolean; error: string }>('call:startTest', {})
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/tts: TTS_HTTP_503/)
    expect(failing.ofType('call:testResult')[0]!.result).toMatchObject({
      ok: false,
      steps: [{ step: 'engine', ok: false, detail: expect.stringMatching(/TTS_HTTP_503/) }],
    })
    expect(failing.ofType('call:command')).toHaveLength(0)

    // Engine not installed.
    const noEngine = await makeHarness({ status: { installed: false, running: false, baseUrl: null } })
    const res2 = await noEngine.invoke<{ ok: boolean; error: string }>('call:startTest', {})
    expect(res2).toMatchObject({ ok: false, error: expect.stringMatching(/not installed/) })
  })
})

// ───────────────────────────── call-engine boot (renderer glue) ─────────────────────────────

describe('Phase 10.2 — call-engine boot: session per backend, test input, new host methods', () => {
  function runtimeConfig(callId: string, backend: CallRuntimeConfig['backend']): CallRuntimeConfig {
    return {
      callId,
      backend,
      sessionId: 's1',
      settings: structuredClone(DEFAULT_LIVE_MODE_SETTINGS),
      llamacpp: { baseUrl: 'http://127.0.0.1:5555', modelId: MODEL_ID, contextSize: 8192 },
    }
  }

  function fakeBridge(handler: (method: string, payload: unknown) => unknown) {
    const listeners = new Set<(event: AshyHostStreamEvent) => void>()
    const invokeLiveCall = vi.fn(async (input: { method: string; payload?: unknown }) => handler(input.method, input.payload))
    const bridge = {
      invokeLiveCall,
      onHostEvent(l: (event: AshyHostStreamEvent) => void) {
        listeners.add(l)
        return () => listeners.delete(l)
      },
    } as unknown as AshyHostBridge
    return { bridge, invokeLiveCall }
  }

  const flushAll = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }

  it('picks the hybrid session for llamacpp-hybrid (speaking through call:synthesize) and realtime otherwise', async () => {
    const { createBackendSession, createCallEngineHostOverBridge } = await import('../call-engine/boot')
    const { bridge, invokeLiveCall } = fakeBridge((method) =>
      method === 'call:synthesize' ? { pcmBase64: '', sampleRate: 24000, durationMs: 0, latencyMs: 1 } : { ok: true },
    )
    const host = createCallEngineHostOverBridge(bridge)
    const hybrid = createBackendSession(runtimeConfig('c1', 'llamacpp-hybrid'), host)
    expect(hybrid.caps.speakerReference).toBe(true)
    const realtime = createBackendSession(runtimeConfig('c1', 'llamacpp-realtime'), host)
    expect(realtime.caps.speakerReference).toBe(false)
    expect(() => createBackendSession(runtimeConfig('c1', 'gemini-live'), host)).toThrow(/not implemented/)

    await host.synthesize({ callId: 'c1', text: 'oi' })
    await host.classifyAffect({ callId: 'c1', text: 'uau' })
    await host.reportStage({ callId: 'c1', emotion: 'happy', intensity: 0.5 })
    await host.reportTestResult({ callId: 'c1', ok: true, steps: [] })
    expect(invokeLiveCall.mock.calls.map(([i]) => i.method)).toEqual([
      'call:synthesize',
      'call:classifyAffect',
      'call:reportStage',
      'call:reportTestResult',
    ])
  })

  it('a start {test:true} fetches call:getTestInput and hands it to the engine; failure ends the call', async () => {
    const { bootCallEngine } = await import('../call-engine/boot')
    const testInput: CallTestInput = { wavBase64: wavB64(500, 16000), expectedText: TEST_CALL_QUESTION }
    let serveInput = true
    const { bridge, invokeLiveCall } = fakeBridge((method, payload) => {
      const callId = (payload as { callId?: string } | undefined)?.callId ?? ''
      if (method === 'call:getState') return { status: 'idle', callId: null }
      if (method === 'call:getRuntimeConfig') return runtimeConfig(callId, 'llamacpp-hybrid')
      if (method === 'call:getTestInput') {
        if (!serveInput) throw new Error('TEST_INPUT_UNKNOWN')
        return testInput
      }
      return { ok: true }
    })
    const created: Array<{ testInput?: CallTestInput; backend: string }> = []
    const boot = bootCallEngine({
      bridge,
      log: () => undefined,
      createEngine: (args) => {
        created.push({ ...(args.testInput ? { testInput: args.testInput } : {}), backend: args.config.backend })
        let status: 'idle' | 'listening' = 'idle'
        return {
          start: async () => (status = 'listening'),
          stop: async () => {
            status = 'idle'
          },
          setMuted: () => undefined,
          getStatus: () => status,
        }
      },
    })
    await boot.handleCommand({ command: 'start', callId: 't1', backend: 'llamacpp-hybrid', sessionId: 's1', test: true })
    await flushAll()
    expect(invokeLiveCall.mock.calls.map(([i]) => i.method)).toContain('call:getTestInput')
    expect(created).toEqual([{ testInput, backend: 'llamacpp-hybrid' }])
    await boot.handleCommand({ command: 'stop', callId: 't1' })

    // A normal start never asks for test input.
    invokeLiveCall.mockClear()
    await boot.handleCommand({ command: 'start', callId: 'n1', backend: 'llamacpp-hybrid', sessionId: 's1' })
    expect(invokeLiveCall.mock.calls.map(([i]) => i.method)).not.toContain('call:getTestInput')
    expect(created[1]).toEqual({ backend: 'llamacpp-hybrid' })
    await boot.handleCommand({ command: 'stop', callId: 'n1' })

    // Missing test input: the call ends with backend_error and no engine is created.
    serveInput = false
    invokeLiveCall.mockClear()
    await boot.handleCommand({ command: 'start', callId: 't2', backend: 'llamacpp-hybrid', sessionId: 's1', test: true })
    expect(created).toHaveLength(2)
    expect(invokeLiveCall.mock.calls.find(([i]) => i.method === 'call:reportState')?.[0].payload).toMatchObject({
      callId: 't2',
      status: 'ended',
      reason: 'backend_error',
    })
    boot.dispose()
  })
})
