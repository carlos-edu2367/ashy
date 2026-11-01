/**
 * Phase 10.5 latency fixes (host + window glue): `call:cascadeWarmup` (LLM loaded at connect, nothing
 * persisted, failure tolerated by the window), streamed llama.cpp /tts (`stream:true` WAV decoded
 * incrementally), `call:synthesizeStream` chunk events (first piece at once, coalesced after, abort).
 */
import { describe, expect, it, vi } from 'vitest'
import type { LanguageModel, LanguageModelRequest } from '@ashy/llm'
import {
  DEFAULT_LIVE_MODE_SETTINGS,
  type AshyHostBridge,
  type AshyHostStreamEvent,
  type CallRuntimeConfig,
  type CallSynthesizeResult,
  type LiveCallHostEvent,
  type LiveModeSettings,
} from '@ashy/shared'
import { createLiveCallRegistry } from '../host/live-call/registry'
import {
  createCascadeLlmWarmup,
  createCascadeTtsRouter,
  createTtsStreamRunner,
  registerCascadeHandlers,
  type CascadeHandlerDeps,
} from '../host/live-call/cascade'
import {
  createStreamingWavDecoder,
  encodeMonoPcm16Wav,
  requestLlamaTtsStream,
  type FetchLike,
} from '../host/live-call/synthesize'
import type { CallRecord } from '../host/live-call/call-hub'
import { createCascadeSessionOverBridge } from '../call-engine/cascade'

function settingsWith(cascade: Partial<LiveModeSettings['cascade']>): LiveModeSettings {
  return { ...structuredClone(DEFAULT_LIVE_MODE_SETTINGS), cascade: { ...DEFAULT_LIVE_MODE_SETTINGS.cascade, ...cascade } }
}

/** b12024 streamed WAV: RIFF/data sizes 0xFFFFFFFF, then PCM16. */
function streamedWav(pcm: Int16Array, rate = 24000): Uint8Array {
  const wav = encodeMonoPcm16Wav(pcm, rate)
  const view = new DataView(wav.buffer)
  view.setUint32(4, 0xffffffff, true)
  view.setUint32(40, 0xffffffff, true)
  return wav
}

function ramp(n: number): Int16Array {
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = ((i * 37) % 2000) - 1000
  return out
}

function streamingFetch(parts: Uint8Array[], opts: { hangAfter?: number } = {}) {
  const bodies: Array<Record<string, unknown>> = []
  const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    let i = 0
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => '',
      body: {
        getReader: () => ({
          read: () => {
            if (opts.hangAfter !== undefined && i >= opts.hangAfter) {
              return new Promise<{ done: boolean; value?: Uint8Array }>((_res, rej) => {
                init.signal.addEventListener('abort', () => rej(new Error('aborted')))
              })
            }
            const value = parts[i++]
            return Promise.resolve(value ? { done: false, value } : { done: true })
          },
          cancel: async () => {},
        }),
      },
    }
  })
  return { fetchImpl, bodies }
}

function split(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = []
  let off = 0
  for (const size of sizes) {
    out.push(bytes.slice(off, off + size))
    off += size
  }
  if (off < bytes.length) out.push(bytes.slice(off))
  return out
}

function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

describe('Phase 10.5 — streamed llama.cpp /tts', () => {
  it('decodes a streamed WAV split anywhere (inside the header, mid-sample) into the exact PCM', async () => {
    const pcm = ramp(5000)
    const { fetchImpl, bodies } = streamingFetch(split(streamedWav(pcm), [7, 30, 9, 3, 1001, 2, 4000]))
    const got: Int16Array[] = []
    const res = await requestLlamaTtsStream({
      baseUrl: 'http://127.0.0.1:9/',
      text: 'Oi Carlos.',
      voice: 'female',
      fetchImpl,
      onPcm: (p, rate) => {
        expect(rate).toBe(24000)
        expect(p.length).toBeGreaterThan(0)
        got.push(p)
      },
    })
    expect(bodies[0]).toMatchObject({ input: 'Oi Carlos.', voice: 'female', stream: true, response_format: 'wav' })
    expect(Array.from(concat(got))).toEqual(Array.from(pcm))
    expect(res).toMatchObject({ sampleRate: 24000, samples: 5000, aborted: false })
    expect(res.firstChunkMs).toBeTypeOf('number')
  })

  it('decodes float32 streams and rejects a stream that ends before the header', async () => {
    const dec = createStreamingWavDecoder()
    const header = new Uint8Array(44)
    const v = new DataView(header.buffer)
    header.set([82, 73, 70, 70], 0)
    header.set([87, 65, 86, 69], 8)
    header.set([102, 109, 116, 32], 12)
    v.setUint32(16, 16, true)
    v.setUint16(20, 3, true) // IEEE float
    v.setUint16(22, 1, true)
    v.setUint32(24, 16000, true)
    v.setUint16(34, 32, true)
    header.set([100, 97, 116, 97], 36)
    v.setUint32(40, 0xffffffff, true)
    expect(dec.push(header).length).toBe(0)
    const f = new Float32Array([0.5, -0.5, 1])
    const out = dec.push(new Uint8Array(f.buffer))
    expect(dec.sampleRate).toBe(16000)
    expect(Array.from(out)).toEqual([16384, -16384, 32767])
    const { fetchImpl } = streamingFetch([new Uint8Array([82, 73, 70])])
    await expect(
      requestLlamaTtsStream({ baseUrl: 'http://x', text: 'a', voice: 'male', fetchImpl, onPcm: () => {} }),
    ).rejects.toThrow('TTS_BAD_AUDIO')
  })

  it('an external abort (barge-in) ends the stream quietly with aborted:true', async () => {
    const wav = streamedWav(ramp(2400))
    const { fetchImpl } = streamingFetch(split(wav, [44, 1000]), { hangAfter: 2 })
    const controller = new AbortController()
    const got: number[] = []
    const p = requestLlamaTtsStream({
      baseUrl: 'http://x',
      text: 'a',
      voice: 'male',
      fetchImpl,
      signal: controller.signal,
      onPcm: (pcm) => {
        got.push(pcm.length)
        controller.abort()
      },
    })
    await expect(p).resolves.toMatchObject({ aborted: true, samples: 500 })
    expect(got).toEqual([500])
  })
})

describe('Phase 10.5 — call:synthesizeStream runner + router', () => {
  it('sends the first piece at once, coalesces the rest (≥160 ms) and reports the chunk count', async () => {
    const emitted: LiveCallHostEvent[] = []
    const runner = createTtsStreamRunner({ emit: (e) => emitted.push(e) })
    const res = await runner.run({ callId: 'call-1', streamId: 's-1' }, async ({ onPcm }) => {
      for (let i = 0; i < 5; i++) onPcm(new Int16Array(1920).fill(i + 1), 24000) // 80 ms each
      return { sampleRate: 24000, samples: 9600, latencyMs: 1, firstChunkMs: 1, aborted: false }
    })
    const chunks = emitted.filter((e): e is Extract<LiveCallHostEvent, { type: 'call:ttsChunk' }> => e.type === 'call:ttsChunk')
    expect(chunks.map((c) => [c.seq, Buffer.from(c.pcmBase64, 'base64').length / 2])).toEqual([
      [0, 1920],
      [1, 3840],
      [2, 3840],
    ])
    expect(chunks.every((c) => c.callId === 'call-1' && c.streamId === 's-1' && c.sampleRate === 24000)).toBe(true)
    expect(res).toMatchObject({ streamId: 's-1', chunks: 3, sampleRate: 24000, durationMs: 400 })
    expect(runner.activeCount()).toBe(0)
  })

  it('abort stops the emission and marks the result aborted', async () => {
    const emitted: LiveCallHostEvent[] = []
    const runner = createTtsStreamRunner({ emit: (e) => emitted.push(e) })
    let feed!: (n: number) => void
    let end!: () => void
    const p = runner.run({ callId: 'call-1', streamId: 's-2' }, ({ onPcm, signal }) => {
      feed = (n) => onPcm(new Int16Array(n), 24000)
      return new Promise((resolve) => {
        end = () => resolve({ sampleRate: 24000, samples: 0, latencyMs: 1, firstChunkMs: 1, aborted: Boolean(signal?.aborted) })
      })
    })
    feed(100)
    expect(runner.abort('call-1', 's-2')).toBe(true)
    feed(10000)
    end()
    await expect(p).resolves.toMatchObject({ chunks: 1, aborted: true })
    expect(emitted).toHaveLength(1)
    expect(runner.abort('call-1', 's-2')).toBe(false)
  })

  it("router: 'llamacpp-tts' streams with the cascade voice; other providers arrive as one chunk", async () => {
    let settings = settingsWith({ ttsProviderId: 'llamacpp-tts', ttsVoice: 'male', referenceVoiceId: 'v1' })
    const synthesizeStream = vi.fn(async (input: { onPcm(p: Int16Array, r: number): void }) => {
      input.onPcm(new Int16Array(10), 24000)
      return { sampleRate: 24000, samples: 10, latencyMs: 1, firstChunkMs: 1, aborted: false }
    })
    const pcm = new Int16Array(2400).fill(7)
    const wav = Buffer.from(encodeMonoPcm16Wav(pcm, 24000)).toString('base64')
    const router = createCascadeTtsRouter({
      getSettings: () => settings,
      llama: { synthesize: vi.fn(), synthesizeStream },
      ensureLlamaEngine: vi.fn(async () => {}),
      synthesizeSpeech: async () => ({ audioBase64: wav }),
    })
    const got: number[] = []
    await router.synthesizeStream({ text: ' Oi. ', onPcm: (p) => got.push(p.length) })
    expect(synthesizeStream).toHaveBeenCalledWith(expect.objectContaining({ text: 'Oi.', voice: 'male', referenceVoiceId: 'v1' }))
    settings = settingsWith({ ttsProviderId: 'local-kokoro-http' })
    const res = await router.synthesizeStream({ text: 'Oi.', onPcm: (p) => got.push(p.length) })
    expect(got).toEqual([10, 2400])
    expect(res).toMatchObject({ samples: 2400, sampleRate: 24000, aborted: false })
  })
})

describe('Phase 10.5 — call:cascadeWarmup', () => {
  function setup(opts: { backend?: CallRecord['backend']; warmupLlm?: CascadeHandlerDeps['warmupLlm'] } = {}) {
    const registry = createLiveCallRegistry()
    const emitted: LiveCallHostEvent[] = []
    const warnings: string[] = []
    const call: CallRecord = { callId: 'call-1', sessionId: 'sess-1', backend: opts.backend ?? 'cascade', test: false }
    registerCascadeHandlers({
      registry,
      emit: (e) => emitted.push(e),
      getSettings: () => settingsWith({ llmProviderId: 'ollama', llmModelId: 'qwen3:4b-instruct' }),
      getOrchestrator: () => null,
      getKnownCall: (id) => (id === call.callId ? call : null),
      getActiveCall: () => call,
      getUserName: () => null,
      toolDeps: { getRuntime: () => null, describeScreen: async () => ({ ok: false }) as never },
      toolsAllowed: () => false,
      ...(opts.warmupLlm ? { warmupLlm: opts.warmupLlm } : {}),
      onWarning: (m) => warnings.push(m),
    })
    return { registry, emitted, warnings }
  }

  it('warms the cascade LLM (resolved provider/model), shares concurrent warm-ups and emits nothing', async () => {
    let release!: () => void
    const warmupLlm = vi.fn(
      () => new Promise<{ providerId: string; modelId: string | null }>((res) => (release = () => res({ providerId: 'ollama', modelId: 'qwen3:4b-instruct' }))),
    )
    const ctx = setup({ warmupLlm })
    const a = ctx.registry.invoke('call:cascadeWarmup', { callId: 'call-1' })
    const b = ctx.registry.invoke('call:cascadeWarmup', { callId: 'call-1' })
    await Promise.resolve()
    expect(warmupLlm).toHaveBeenCalledTimes(1)
    expect(warmupLlm).toHaveBeenCalledWith({ providerId: 'ollama', modelId: 'qwen3:4b-instruct' })
    release()
    await expect(a).resolves.toMatchObject({ warmed: true, providerId: 'ollama', modelId: 'qwen3:4b-instruct' })
    await expect(b).resolves.toMatchObject({ warmed: true })
    expect(ctx.emitted).toEqual([])
  })

  it('reports failures (CASCADE_WARMUP_FAILED + warning), rejects other backends, and is a no-op when unwired', async () => {
    const failing = setup({ warmupLlm: async () => Promise.reject(new Error('model not found')) })
    await expect(failing.registry.invoke('call:cascadeWarmup', { callId: 'call-1' })).rejects.toThrow('CASCADE_WARMUP_FAILED: model not found')
    expect(failing.warnings[0]).toContain('model not found')
    const hybrid = setup({ backend: 'llamacpp-hybrid' as CallRecord['backend'], warmupLlm: vi.fn() })
    await expect(hybrid.registry.invoke('call:cascadeWarmup', { callId: 'call-1' })).rejects.toThrow('CASCADE_WRONG_BACKEND')
    await expect(hybrid.registry.invoke('call:cascadeWarmup', { callId: 'nope' })).rejects.toThrow('CALL_UNKNOWN')
    const unwired = setup()
    await expect(unwired.registry.invoke('call:cascadeWarmup', { callId: 'call-1' })).resolves.toMatchObject({ warmed: false })
  })

  it('createCascadeLlmWarmup: one-token generation through the vault adapter of the cascade model', async () => {
    const requests: LanguageModelRequest[] = []
    const model = (async (req: LanguageModelRequest) => {
      requests.push(req)
      return new ReadableStream({
        start(c) {
          c.enqueue({ type: 'text-delta', text: 'O' })
          c.enqueue({ type: 'finish', finishReason: 'length' })
          c.close()
        },
      })
    }) as LanguageModel
    const createLanguageModel = vi.fn(() => model)
    const configs = {
      ollama: { baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'lfm3', requiresApiKey: false, hasApiKey: false },
      openai: { baseUrl: 'https://api.openai.com/v1', modelId: 'gpt', requiresApiKey: true, hasApiKey: false },
    }
    const warm = createCascadeLlmWarmup({
      getProviderState: () => ({ activeProviderId: 'ollama', configs }) as never,
      createLanguageModel,
    })
    await expect(warm({ providerId: 'ollama', modelId: 'qwen3:4b-instruct' })).resolves.toEqual({ providerId: 'ollama', modelId: 'qwen3:4b-instruct' })
    expect(createLanguageModel).toHaveBeenCalledWith('ollama', { modelId: 'qwen3:4b-instruct' })
    expect(requests[0]).toMatchObject({ maxTokens: 1 })
    // chat-default → the active provider and its model
    await expect(warm({})).resolves.toEqual({ providerId: 'ollama', modelId: 'lfm3' })
    expect(createLanguageModel).toHaveBeenLastCalledWith('ollama', undefined)
    await expect(warm({ providerId: 'openai' })).rejects.toThrow('PROVIDER_NOT_CONFIGURED')
  })
})

describe('Phase 10.5 — window glue: warm-up at connect, streamed TTS over the bridge', () => {
  function fakeBridge(handlers: Record<string, (payload: any) => Promise<unknown>>) {
    const listeners = new Set<(e: AshyHostStreamEvent) => void>()
    const invoked: string[] = []
    const bridge = {
      invokeLiveCall: vi.fn(async ({ method, payload }: { method: string; payload: unknown }) => {
        invoked.push(method)
        const h = handlers[method]
        if (!h) throw new Error(`unexpected ${method}`)
        return h(payload)
      }),
      onHostEvent: (cb: (e: AshyHostStreamEvent) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    } as unknown as AshyHostBridge
    return { bridge, invoked, emit: (e: unknown) => listeners.forEach((l) => l(e as AshyHostStreamEvent)) }
  }
  const config: CallRuntimeConfig = {
    callId: 'call-1',
    backend: 'cascade',
    sessionId: 's1',
    settings: { ...structuredClone(DEFAULT_LIVE_MODE_SETTINGS), backend: 'cascade' },
    llamacpp: null,
  }
  const okTts: CallSynthesizeResult = { pcmBase64: 'AAAA', sampleRate: 24000, durationMs: 1, latencyMs: 1 }

  it('connect runs the LLM warm-up and the TTS warm-up in parallel; an LLM warm-up failure does not fail the call', async () => {
    let releaseTts!: () => void
    const host = {
      synthesize: vi.fn(() => new Promise<CallSynthesizeResult>((res) => (releaseTts = () => res(okTts)))),
    }
    const fb = fakeBridge({ 'call:cascadeWarmup': async () => Promise.reject(new Error('CASCADE_WARMUP_FAILED: boom')) })
    const session = createCascadeSessionOverBridge({ config, host: host as never, bridge: fb.bridge })
    const errors: Array<{ code?: string; fatal: boolean }> = []
    session.on('error', (e) => errors.push(e))
    const connecting = session.connect({ instructions: '' })
    await new Promise((r) => setTimeout(r, 0))
    expect(fb.invoked).toEqual(['call:cascadeWarmup'])
    expect(host.synthesize).toHaveBeenCalledWith({ callId: 'call-1', text: 'Oi.' })
    releaseTts()
    await expect(connecting).resolves.toBeUndefined()
    expect(errors).toEqual([expect.objectContaining({ code: 'warmup_failed', fatal: false })])
    await session.close()
  })

  it('a TTS warm-up failure still fails connect', async () => {
    const host = { synthesize: vi.fn(async () => Promise.reject(new Error('TTS_UNAVAILABLE'))) }
    const fb = fakeBridge({ 'call:cascadeWarmup': async () => ({ warmed: true }) })
    const session = createCascadeSessionOverBridge({ config, host: host as never, bridge: fb.bridge })
    await expect(session.connect({ instructions: '' })).rejects.toThrow('TTS_UNAVAILABLE')
  })

  it('phrases go through call:synthesizeStream and only this call’s call:ttsChunk events are played', async () => {
    const host = { synthesize: vi.fn(async () => okTts) }
    let streamReq: any = null
    let finish!: () => void
    const fb = fakeBridge({
      'call:cascadeWarmup': async () => ({ warmed: true }),
      'call:cascadeTurn': async () => ({ accepted: true }),
      'call:synthesizeStream': (payload) => {
        streamReq = payload
        return new Promise((res) => (finish = () => res({ streamId: payload.streamId, chunks: 1, sampleRate: 24000, durationMs: 300, latencyMs: 1, firstChunkMs: 1 })))
      },
    })
    const session = createCascadeSessionOverBridge({ config, host: host as never, bridge: fb.bridge })
    const audio: number[] = []
    session.on('response_audio', (e) => audio.push(e.pcm.length))
    await session.connect({ instructions: '' })
    session.submitTranscribedTurn({ text: 'oi', context: '' })
    await new Promise((r) => setTimeout(r, 0))
    const turnId = (fb.bridge.invokeLiveCall as any).mock.calls.find((c: any) => c[0].method === 'call:cascadeTurn')[0].payload.turnId
    fb.emit({ type: 'call:cascade', callId: 'call-1', turnId, kind: 'delta', delta: 'Oi Carlos, tudo bem?' })
    fb.emit({ type: 'call:cascade', callId: 'call-1', turnId, kind: 'done', text: '', providerId: 'ollama', modelId: 'm', latencyMs: 1 })
    await new Promise((r) => setTimeout(r, 0))
    expect(streamReq).toMatchObject({ callId: 'call-1', text: 'Oi Carlos, tudo bem?' })
    const pcm = Buffer.alloc(24000 * 0.3 * 2).toString('base64')
    fb.emit({ type: 'call:ttsChunk', callId: 'other-call', streamId: streamReq.streamId, seq: 0, pcmBase64: pcm, sampleRate: 24000 })
    expect(audio).toEqual([])
    fb.emit({ type: 'call:ttsChunk', callId: 'call-1', streamId: streamReq.streamId, seq: 0, pcmBase64: pcm, sampleRate: 24000 })
    expect(audio).toEqual([7200])
    finish()
    await session.close()
  })
})
