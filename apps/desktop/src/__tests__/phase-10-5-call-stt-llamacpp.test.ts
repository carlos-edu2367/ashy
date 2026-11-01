import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIVE_MODE_SETTINGS,
  LIVE_LOCAL_MODELS,
  type CallTranscribeResult,
  type LiveBackendId,
  type LiveModeSettings,
  type LlamaCppEngineStatus,
  type SttProviderId,
} from '@ashy/shared'
import { encodeWavPcm16 } from '@ashy/voice'
import { createAshyHostKernel, type AshyHostKernel } from '../host/kernel'
import { registerCallHostHandlers, type CallHostDeps } from '../host/live-call/handlers'
import {
  LLAMA_STT_PROVIDER_ID,
  createLlamaFirstTranscribe,
  requestLlamaTranscription,
  resolveLlamaSttTarget,
  shouldPreferLlamaStt,
  type SttFetchLike,
} from '../host/live-call/llama-stt'

const tempDirs: string[] = []
const kernels: AshyHostKernel[] = []
afterEach(async () => {
  while (kernels.length) await kernels.pop()!.dispose?.()
  while (tempDirs.length) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    } catch {
      // Windows cleanup
    }
  }
})

const MODEL_ID = DEFAULT_LIVE_MODE_SETTINGS.llamacpp.modelId
const BASE = 'http://127.0.0.1:39123'
const AUTH = { Authorization: 'Bearer test-key' }

function status(overrides: Partial<LlamaCppEngineStatus> = {}): LlamaCppEngineStatus {
  return {
    engineId: 'llamacpp',
    build: 'b12024',
    installed: true,
    installedVariant: 'cuda-12.4',
    detectedGpu: null,
    running: true,
    managed: true,
    baseUrl: BASE,
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

function wavBase64(durationMs: number, sampleRate = 16000): string {
  const samples = new Float32Array(Math.round((sampleRate * durationMs) / 1000))
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 8) * 0.3
  return Buffer.from(encodeWavPcm16(samples, sampleRate)).toString('base64')
}

interface FetchCall {
  url: string
  headers: Record<string, string>
  body: FormData
}

function jsonFetch(
  answer: { status?: number; json?: unknown; text?: string } | ((call: FetchCall) => Promise<never>),
): { fetchImpl: SttFetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetchImpl: SttFetchLike = async (url, init) => {
    const call = { url, headers: init.headers, body: init.body }
    calls.push(call)
    if (typeof answer === 'function') return answer(call)
    const st = answer.status ?? 200
    return {
      ok: st >= 200 && st < 300,
      status: st,
      json: async () => answer.json,
      text: async () => answer.text ?? JSON.stringify(answer.json ?? ''),
    }
  }
  return { fetchImpl, calls }
}

/** A fetch that never answers until aborted (llama-server stuck behind a busy GPU). */
const hangingFetch: SttFetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')))
  })

function engineFake(st: Partial<LlamaCppEngineStatus> = {}, audioIn = true) {
  const spec = LIVE_LOCAL_MODELS.find((m) => m.id === MODEL_ID)!
  const s = status(st)
  const caps = { audioIn }
  return {
    /** Mutable status / capability (e.g. the engine dies mid-call). */
    state: s,
    caps,
    getStatus: vi.fn(() => ({ ...s })),
    start: vi.fn(async () => ({ ...s })),
    getModelSpec: (id: string) =>
      id === spec.id ? { ...spec, capabilities: { ...spec.capabilities, audioIn: caps.audioIn } } : undefined,
    getRequestHeaders: vi.fn(() => ({ ...AUTH })),
  }
}

describe('llama-server STT route — unit', () => {
  it('POSTs the WAV to /v1/audio/transcriptions with the auth headers and the language', async () => {
    const { fetchImpl, calls } = jsonFetch({ json: { text: '  Pode sim.  ' } })
    const wav = Buffer.from(wavBase64(500), 'base64')
    const res = await requestLlamaTranscription({ baseUrl: `${BASE}/`, wavBytes: wav, language: 'pt', headers: AUTH, fetchImpl })
    expect(res.text).toBe('Pode sim.')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/v1/audio/transcriptions`)
    expect(calls[0]!.headers).toMatchObject(AUTH)
    expect(calls[0]!.body.get('language')).toBe('pt')
    const file = calls[0]!.body.get('file') as Blob
    expect(file.type).toBe('audio/wav')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(wav))
  })

  it('rejects chat-style answers, HTTP errors, missing text and timeouts with LLAMA_STT_* errors', async () => {
    const wavBytes = new Uint8Array(Buffer.from(wavBase64(500), 'base64'))
    await expect(
      requestLlamaTranscription({ baseUrl: BASE, wavBytes, fetchImpl: jsonFetch({ json: { text: 'O áudio contém uma pessoa dizendo oi.' } }).fetchImpl }),
    ).rejects.toThrow(/LLAMA_STT_CHAT_STYLE/)
    await expect(
      requestLlamaTranscription({ baseUrl: BASE, wavBytes, fetchImpl: jsonFetch({ status: 401, text: 'Invalid API Key' }).fetchImpl }),
    ).rejects.toThrow(/LLAMA_STT_HTTP_401: Invalid API Key/)
    await expect(
      requestLlamaTranscription({ baseUrl: BASE, wavBytes, fetchImpl: jsonFetch({ json: { error: 'x' } }).fetchImpl }),
    ).rejects.toThrow(/LLAMA_STT_BAD_RESPONSE/)
    await expect(
      requestLlamaTranscription({ baseUrl: BASE, wavBytes, fetchImpl: hangingFetch, timeoutMs: 20 }),
    ).rejects.toThrow(/LLAMA_STT_TIMEOUT/)
    await expect(
      requestLlamaTranscription({
        baseUrl: BASE,
        wavBytes,
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED')
        },
      }),
    ).rejects.toThrow(/LLAMA_STT_UNAVAILABLE: ECONNREFUSED/)
  })

  it('resolves a target only for a running engine whose model takes audio in', () => {
    const settings = structuredClone(DEFAULT_LIVE_MODE_SETTINGS)
    expect(resolveLlamaSttTarget(settings, engineFake())).toEqual({ baseUrl: BASE, headers: AUTH })
    expect(resolveLlamaSttTarget(settings, engineFake({ running: false, baseUrl: null }))).toBeNull()
    expect(resolveLlamaSttTarget(settings, engineFake({}, false))).toBeNull()
    // A custom endpoint that passed its health check (no managed key → no headers).
    const custom = { ...engineFake({ managed: false, baseUrl: 'http://10.0.0.5:8080', activeModelId: null }), getRequestHeaders: () => ({}) }
    expect(resolveLlamaSttTarget(settings, custom)).toEqual({ baseUrl: 'http://10.0.0.5:8080', headers: {} })
    const throwing = { ...engineFake(), getStatus: () => { throw new Error('boom') } }
    expect(resolveLlamaSttTarget(settings, throwing)).toBeNull()
  })

  it('prefers llama-server only for llama.cpp / cascade calls on the Ollama STT path', () => {
    for (const b of ['llamacpp-realtime', 'llamacpp-hybrid', 'cascade']) {
      expect(shouldPreferLlamaStt(b, 'ollama-transcriptions')).toBe(true)
      expect(shouldPreferLlamaStt(b, 'web-speech-stt')).toBe(true)
      expect(shouldPreferLlamaStt(b, undefined)).toBe(true)
      for (const other of ['openai-whisper', 'groq-whisper', 'local-whisper-http', 'deterministic-wav-stt'] as SttProviderId[]) {
        expect(shouldPreferLlamaStt(b, other)).toBe(false)
      }
    }
    expect(shouldPreferLlamaStt('openai-realtime', 'ollama-transcriptions')).toBe(false)
    expect(shouldPreferLlamaStt('gemini-live', undefined)).toBe(false)
  })

  it('falls back to the configured STT on failure and skips llama-server without a target', async () => {
    const fallback = vi.fn(async () => ({ text: 'via ollama', providerId: 'ollama-transcriptions', latencyMs: 9 }))
    const onWarning = vi.fn()
    const input = { audioBase64: wavBase64(500), mimeType: 'audio/wav', language: 'pt' }
    const failing = createLlamaFirstTranscribe({ target: { baseUrl: BASE, headers: AUTH }, fallback, fetchImpl: jsonFetch({ status: 503 }).fetchImpl, onWarning })
    await expect(failing(input)).resolves.toEqual({ text: 'via ollama', providerId: 'ollama-transcriptions', latencyMs: 9 })
    expect(fallback).toHaveBeenCalledWith(input)
    expect(onWarning.mock.calls[0]![0]).toMatch(/llama-server STT failed.*LLAMA_STT_HTTP_503/)

    const { fetchImpl, calls } = jsonFetch({ json: { text: 'x' } })
    const noTarget = createLlamaFirstTranscribe({ target: null, fallback, fetchImpl })
    await noTarget(input)
    expect(calls).toHaveLength(0)
    expect(fallback).toHaveBeenCalledTimes(2)
  })
})

describe('call:transcribe — llama-server first, configured STT as fallback', () => {
  async function harness(opts: {
    backend?: LiveBackendId
    engine?: ReturnType<typeof engineFake>
    fetchImpl?: SttFetchLike
    deps?: Partial<CallHostDeps>
    cascadeStt?: string
  } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-call-stt-'))
    tempDirs.push(dir)
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    kernels.push(kernel)
    const session = await kernel.createSession('Chamada teste')
    kernel.setCallWindowController({ ensure: vi.fn(async () => undefined), destroy: vi.fn() })
    const backend = opts.backend ?? 'llamacpp-realtime'
    const settings: LiveModeSettings = { ...structuredClone(DEFAULT_LIVE_MODE_SETTINGS), backend }
    if (opts.cascadeStt) settings.cascade = { ...settings.cascade, sttProviderId: opts.cascadeStt }
    const engine = opts.engine ?? engineFake()
    const transcribe = vi.fn(async () => ({ text: 'via ollama', providerId: 'ollama-transcriptions', latencyMs: 42 }))
    const onWarning = vi.fn()
    let seq = 0
    registerCallHostHandlers(kernel.liveCall, {
      settings: { get: () => settings },
      engine,
      getCortex: () => kernel.cortex,
      resolveSessionId: () => session.id,
      transcribe,
      onWarning,
      createCallId: () => `call-stt-${++seq}`,
      ...(opts.fetchImpl ? { sttFetchImpl: opts.fetchImpl } : {}),
      ...opts.deps,
    })
    const invoke = <T = unknown>(method: string, payload?: unknown) =>
      kernel.invokeLiveCall({ method: method as never, payload }) as Promise<T>
    const started = await invoke<{ status: string }>('call:start', { backend })
    expect(started.status).not.toBe('ended')
    return { invoke, transcribe, onWarning, engine }
  }

  it('llamacpp-realtime: transcribes with llama-server (auth headers) and never calls the Ollama STT', async () => {
    const { fetchImpl, calls } = jsonFetch({ json: { text: 'Pode.' } })
    const h = await harness({ fetchImpl })
    const res = await h.invoke<CallTranscribeResult>('call:transcribe', { callId: 'call-stt-1', audioWavBase64: wavBase64(800), language: 'pt' })
    expect(res.text).toBe('Pode.')
    expect(res.providerId).toBe(LLAMA_STT_PROVIDER_ID)
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(calls[0]!.url).toBe(`${BASE}/v1/audio/transcriptions`)
    expect(calls[0]!.headers.Authorization).toBe('Bearer test-key')
  })

  it('llamacpp-hybrid and cascade (Ollama STT) use llama-server too', async () => {
    for (const backend of ['llamacpp-hybrid', 'cascade'] as const) {
      const { fetchImpl, calls } = jsonFetch({ json: { text: 'Oi.' } })
      const h = await harness({ backend, fetchImpl, cascadeStt: 'ollama-transcriptions' })
      const res = await h.invoke<CallTranscribeResult>('call:transcribe', { callId: 'call-stt-1', audioWavBase64: wavBase64(800) })
      expect(res).toMatchObject({ text: 'Oi.', providerId: LLAMA_STT_PROVIDER_ID })
      expect(calls).toHaveLength(1)
      expect(h.transcribe).not.toHaveBeenCalled()
    }
  })

  it('falls back to the configured STT on HTTP error, timeout and chat-style answers', async () => {
    const cases: SttFetchLike[] = [
      jsonFetch({ status: 500, text: 'boom' }).fetchImpl,
      hangingFetch,
      jsonFetch({ json: { text: 'Não há fala neste áudio.' } }).fetchImpl,
    ]
    for (const fetchImpl of cases) {
      const h = await harness({ fetchImpl, deps: { llamaSttTimeoutMs: 25 } })
      const audio = wavBase64(800)
      const res = await h.invoke<CallTranscribeResult>('call:transcribe', { callId: 'call-stt-1', audioWavBase64: audio, language: 'pt' })
      expect(res).toEqual({ text: 'via ollama', providerId: 'ollama-transcriptions', latencyMs: 42 })
      expect(h.transcribe).toHaveBeenCalledWith({ audioBase64: audio, mimeType: 'audio/wav', language: 'pt' })
      expect(h.onWarning).toHaveBeenCalledWith(expect.stringMatching(/llama-server STT failed/))
    }
  })

  it('keeps the < 300 ms guard: short audio reaches neither route', async () => {
    const { fetchImpl, calls } = jsonFetch({ json: { text: 'x' } })
    const h = await harness({ fetchImpl })
    const res = await h.invoke<CallTranscribeResult>('call:transcribe', { callId: 'call-stt-1', audioWavBase64: wavBase64(200) })
    expect(res.text).toBe('')
    expect(calls).toHaveLength(0)
    expect(h.transcribe).not.toHaveBeenCalled()
  })

  it('goes straight to the configured STT when the engine is not running or the model has no audio in', async () => {
    for (const mode of ['stopped', 'no-audio-in'] as const) {
      const { fetchImpl, calls } = jsonFetch({ json: { text: 'x' } })
      const engine = engineFake()
      const h = await harness({ fetchImpl, engine })
      if (mode === 'stopped') Object.assign(engine.state, { running: false, baseUrl: null, port: null })
      else engine.caps.audioIn = false
      const res = await h.invoke<CallTranscribeResult>('call:transcribe', { callId: 'call-stt-1', audioWavBase64: wavBase64(800) })
      expect(res.providerId).toBe('ollama-transcriptions')
      expect(calls).toHaveLength(0)
    }
  })

  it('respects an explicit non-Ollama STT choice (cascade picker / voice settings)', async () => {
    const a = jsonFetch({ json: { text: 'x' } })
    const cascade = await harness({ backend: 'cascade', fetchImpl: a.fetchImpl, cascadeStt: 'groq-whisper' })
    await cascade.invoke('call:transcribe', { callId: 'call-stt-1', audioWavBase64: wavBase64(800) })
    expect(a.calls).toHaveLength(0)
    expect(cascade.transcribe).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'groq-whisper' }))

    const b = jsonFetch({ json: { text: 'x' } })
    const realtime = await harness({ fetchImpl: b.fetchImpl, deps: { getActiveSttProviderId: () => 'openai-whisper' } })
    await realtime.invoke('call:transcribe', { callId: 'call-stt-1', audioWavBase64: wavBase64(800) })
    expect(b.calls).toHaveLength(0)
    expect(realtime.transcribe).toHaveBeenCalledTimes(1)
  })
})
