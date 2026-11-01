import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_VOICE_RUNTIME_SETTINGS,
  migrateStoredSttProviderId,
  migrateStoredTtsProviderId,
  USE_BROWSER_TTS_CODE,
  USER_SELECTABLE_STT_PROVIDER_IDS,
  USER_SELECTABLE_TTS_PROVIDER_IDS,
} from '@ashy/shared'
import {
  createAshyHostKernel,
  deriveOllamaOrigin,
  isChatStyleNonTranscript,
  type AshyHostKernel,
} from '../host/kernel'

const LFM3_MODEL = 'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M'

const tempDirs: string[] = []
const kernels: AshyHostKernel[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-p10-voice-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const k of kernels.splice(0)) {
    await k.stop().catch(() => undefined)
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function buildWavBase64(numSamples = 1600): string {
  const dataBytes = numSamples * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buf)
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 195 * i) / 16000) * 9000), true)
  }
  return Buffer.from(buf).toString('base64')
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface CapturedRequest {
  url: string
  method: string
  body: unknown
}

type Responder = (url: string, init?: RequestInit) => Promise<Response>

function createMockFetch(respond: Responder): {
  fetchImpl: typeof fetch
  requests: CapturedRequest[]
} {
  const requests: CapturedRequest[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body })
    return respond(url, init)
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests }
}

async function createKernel(opts: {
  respond: Responder
  voiceHttpTimeoutMs?: number
  ollama?: { baseUrl?: string; modelId?: string; active?: boolean }
  dir?: string
}): Promise<{ kernel: AshyHostKernel; requests: CapturedRequest[] }> {
  const { fetchImpl, requests } = createMockFetch(opts.respond)
  const kernel = await createAshyHostKernel({
    userDataDir: opts.dir ?? makeTempDir(),
    fetchImpl,
    ...(opts.voiceHttpTimeoutMs !== undefined
      ? { voiceHttpTimeoutMs: opts.voiceHttpTimeoutMs }
      : {}),
  })
  kernels.push(kernel)
  if (opts.ollama) {
    kernel.providerVault.saveProviderConfig({
      providerId: 'ollama',
      baseUrl: opts.ollama.baseUrl ?? 'http://127.0.0.1:11434/v1',
      modelId: opts.ollama.modelId ?? LFM3_MODEL,
    })
    if (opts.ollama.active !== false) {
      kernel.providerVault.setActiveProvider('ollama')
    }
  }
  requests.length = 0
  return { kernel, requests }
}

const transcriptionRequests = (requests: CapturedRequest[]) =>
  requests.filter((r) => r.url.includes('/audio/transcriptions'))

describe('Phase 10.0 T4 — shared voice defaults and migration helpers', () => {
  it('defaults to real providers (Ollama STT, browser TTS) with wake word off', () => {
    expect(DEFAULT_VOICE_RUNTIME_SETTINGS.activeSttProviderId).toBe('ollama-transcriptions')
    expect(DEFAULT_VOICE_RUNTIME_SETTINGS.activeTtsProviderId).toBe('web-speech-tts')
    expect(DEFAULT_VOICE_RUNTIME_SETTINGS.wakeWordEnabled).toBe(false)
  })

  it('keeps diagnostic fakes out of the user-selectable lists', () => {
    expect(USER_SELECTABLE_STT_PROVIDER_IDS).toContain('ollama-transcriptions')
    expect(USER_SELECTABLE_STT_PROVIDER_IDS).not.toContain('deterministic-wav-stt')
    expect(USER_SELECTABLE_TTS_PROVIDER_IDS).toContain('web-speech-tts')
    expect(USER_SELECTABLE_TTS_PROVIDER_IDS).not.toContain('local-synth-fallback')
  })

  it('migrates fake / unknown stored ids to the new defaults and keeps real ones', () => {
    expect(migrateStoredSttProviderId('deterministic-wav-stt')).toBe('ollama-transcriptions')
    expect(migrateStoredSttProviderId('not-a-provider')).toBe('ollama-transcriptions')
    expect(migrateStoredSttProviderId('groq-whisper')).toBe('groq-whisper')
    expect(migrateStoredTtsProviderId('local-synth-fallback')).toBe('web-speech-tts')
    expect(migrateStoredTtsProviderId(42)).toBe('web-speech-tts')
    expect(migrateStoredTtsProviderId('local-kokoro-http')).toBe('local-kokoro-http')
  })
})

describe('Phase 10.0 T4 — host helpers', () => {
  it('derives the Ollama origin by stripping the OpenAI-compatible /v1 suffix', () => {
    expect(deriveOllamaOrigin('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434')
    expect(deriveOllamaOrigin('http://localhost:11500/v1/')).toBe('http://localhost:11500')
    expect(deriveOllamaOrigin('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434')
    expect(deriveOllamaOrigin('http://gpu-box:11434/ollama/v1')).toBe(
      'http://gpu-box:11434/ollama',
    )
  })

  it('flags chat-style answers but keeps real transcripts', () => {
    expect(isChatStyleNonTranscript('A única palavra dita no áudio é "oi".')).toBe(true)
    expect(isChatStyleNonTranscript('O áudio contém uma pessoa dizendo olá.')).toBe(true)
    expect(isChatStyleNonTranscript('Não há fala neste áudio.')).toBe(true)
    expect(isChatStyleNonTranscript('Desculpe, não consigo transcrever esse áudio.')).toBe(true)
    expect(isChatStyleNonTranscript('"O áudio fornecido está vazio."')).toBe(true)

    expect(isChatStyleNonTranscript('Oi Ashy, tudo bem com você?')).toBe(false)
    expect(isChatStyleNonTranscript('Não há problema nenhum, pode seguir.')).toBe(false)
    expect(isChatStyleNonTranscript('O áudio está cortando de novo.')).toBe(false)
  })
})

describe('Phase 10.0 T4 — kernel voice settings migration', () => {
  it('fresh install exposes the new defaults with wake word disabled', async () => {
    const { kernel } = await createKernel({ respond: async () => jsonResponse({}, 404) })
    const settings = await kernel.getVoiceRuntimeSettings!()
    expect(settings.activeSttProviderId).toBe('ollama-transcriptions')
    expect(settings.activeTtsProviderId).toBe('web-speech-tts')
    expect(settings.wakeWordEnabled).toBe(false)
  })

  it('heals persisted fake provider ids on load without overriding an explicit wakeWordEnabled', async () => {
    const dir = makeTempDir()
    fs.writeFileSync(
      path.join(dir, 'voice-settings.json'),
      JSON.stringify({
        activeSttProviderId: 'deterministic-wav-stt',
        activeTtsProviderId: 'local-synth-fallback',
        wakeWordEnabled: true,
        sttModelId: 'whisper-1',
      }),
    )
    const { kernel } = await createKernel({ dir, respond: async () => jsonResponse({}, 404) })
    const settings = await kernel.getVoiceRuntimeSettings!()
    expect(settings.activeSttProviderId).toBe('ollama-transcriptions')
    expect(settings.activeTtsProviderId).toBe('web-speech-tts')
    expect(settings.wakeWordEnabled).toBe(true)
  })

  it('keeps explicitly persisted real providers untouched', async () => {
    const dir = makeTempDir()
    fs.writeFileSync(
      path.join(dir, 'voice-settings.json'),
      JSON.stringify({
        activeSttProviderId: 'local-whisper-http',
        activeTtsProviderId: 'local-kokoro-http',
        wakeWordEnabled: false,
      }),
    )
    const { kernel } = await createKernel({ dir, respond: async () => jsonResponse({}, 404) })
    const settings = await kernel.getVoiceRuntimeSettings!()
    expect(settings.activeSttProviderId).toBe('local-whisper-http')
    expect(settings.activeTtsProviderId).toBe('local-kokoro-http')
    expect(settings.wakeWordEnabled).toBe(false)
  })
})

describe('Phase 10.0 T4 — ollama-transcriptions STT provider', () => {
  it('POSTs multipart (model, language=pt, file) to {ollamaOrigin}/v1/audio/transcriptions with the active Ollama model', async () => {
    const { kernel, requests } = await createKernel({
      ollama: {},
      respond: async (url) =>
        url.endsWith('/v1/audio/transcriptions')
          ? jsonResponse({ text: 'Oi Ashy, tudo bem?' })
          : jsonResponse({}, 404),
    })

    const res = await kernel.transcribeVoiceAudio!({
      audioBase64: buildWavBase64(),
      mimeType: 'audio/wav',
      providerId: 'ollama-transcriptions',
      // The renderer forwards the Whisper base URL / model; both must be ignored.
      baseUrl: 'http://127.0.0.1:8080',
      modelId: 'whisper-1',
    })

    expect(res.providerId).toBe('ollama-transcriptions')
    expect(res.text).toBe('Oi Ashy, tudo bem?')

    const sent = transcriptionRequests(requests)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('http://127.0.0.1:11434/v1/audio/transcriptions')
    expect(sent[0]!.method).toBe('POST')
    const form = sent[0]!.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe(LFM3_MODEL)
    expect(form.get('language')).toBe('pt')
    const file = form.get('file') as File
    expect(file).toBeInstanceOf(Blob)
    expect(file.type).toBe('audio/wav')
    expect(file.size).toBe(44 + 1600 * 2)
  })

  it('derives the origin from a custom Ollama baseUrl and prefers a non-whisper sttModelId', async () => {
    const { kernel, requests } = await createKernel({
      ollama: { baseUrl: 'http://localhost:11500/v1/', modelId: 'qwen2.5:14b' },
      respond: async () => jsonResponse({ text: 'teste de origem' }),
    })
    await kernel.saveVoiceRuntimeSettings!({ sttModelId: 'custom-asr:latest' })
    requests.length = 0

    const res = await kernel.transcribeVoiceAudio!({
      audioBase64: buildWavBase64(),
      providerId: 'ollama-transcriptions',
    })
    expect(res.text).toBe('teste de origem')
    const sent = transcriptionRequests(requests)
    expect(sent[0]!.url).toBe('http://localhost:11500/v1/audio/transcriptions')
    expect((sent[0]!.body as FormData).get('model')).toBe('custom-asr:latest')
  })

  it('is used by default (no explicit providerId) on a fresh install', async () => {
    const { kernel, requests } = await createKernel({
      ollama: {},
      respond: async () => jsonResponse({ text: 'padrão real' }),
    })
    const res = await kernel.transcribeVoiceAudio!({ audioBase64: buildWavBase64() })
    expect(res.providerId).toBe('ollama-transcriptions')
    expect(res.text).toBe('padrão real')
    expect(transcriptionRequests(requests)[0]!.url).toBe(
      'http://127.0.0.1:11434/v1/audio/transcriptions',
    )
  })

  it('rejects chat-style non-transcripts as errors', async () => {
    const { kernel } = await createKernel({
      ollama: {},
      respond: async () =>
        jsonResponse({ text: 'O áudio contém apenas a palavra "olá" dita por uma mulher.' }),
    })
    await expect(
      kernel.transcribeVoiceAudio!({
        audioBase64: buildWavBase64(),
        providerId: 'ollama-transcriptions',
      }),
    ).rejects.toThrow(/chat-style/)
  })

  it('surfaces HTTP errors from Ollama', async () => {
    const { kernel } = await createKernel({
      ollama: {},
      respond: async () => jsonResponse({ error: 'model not found' }, 404),
    })
    await expect(
      kernel.transcribeVoiceAudio!({
        audioBase64: buildWavBase64(),
        providerId: 'ollama-transcriptions',
      }),
    ).rejects.toThrow(/HTTP 404/)
  })

  it('is bounded by the voice HTTP timeout (Ollama active: no fallback)', async () => {
    const hangUntilAborted: Responder = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason ?? new Error('aborted')),
        )
      })
    const { kernel, requests } = await createKernel({
      ollama: {},
      voiceHttpTimeoutMs: 60,
      respond: hangUntilAborted,
    })
    const startedAt = Date.now()
    await expect(
      kernel.transcribeVoiceAudio!({
        audioBase64: buildWavBase64(),
        providerId: 'ollama-transcriptions',
      }),
    ).rejects.toThrow()
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(transcriptionRequests(requests)).toHaveLength(1)
  })

  it('falls back to local-whisper-http when Ollama is not the active chat provider and is unreachable', async () => {
    const { kernel, requests } = await createKernel({
      respond: async (url) => {
        if (url.startsWith('http://127.0.0.1:11434')) {
          throw new TypeError('fetch failed: ECONNREFUSED')
        }
        if (url.startsWith('http://127.0.0.1:8080')) {
          return jsonResponse({ text: 'transcrição whisper local' })
        }
        return jsonResponse({}, 404)
      },
    })
    const res = await kernel.transcribeVoiceAudio!({
      audioBase64: buildWavBase64(),
      providerId: 'ollama-transcriptions',
    })
    expect(res.providerId).toBe('local-whisper-http')
    expect(res.text).toBe('transcrição whisper local')
    const urls = transcriptionRequests(requests).map((r) => r.url)
    expect(urls[0]).toBe('http://127.0.0.1:11434/v1/audio/transcriptions')
    expect(urls.some((u) => u.startsWith('http://127.0.0.1:8080'))).toBe(true)
  })

  it('host-side web-speech-stt uses the real Ollama transcription instead of the deterministic fake', async () => {
    const { kernel, requests } = await createKernel({
      ollama: {},
      respond: async () => jsonResponse({ text: 'fala real do usuário' }),
    })
    const res = await kernel.transcribeVoiceAudio!({
      audioBase64: buildWavBase64(),
      providerId: 'web-speech-stt',
    })
    expect(res.text).toBe('fala real do usuário')
    expect(transcriptionRequests(requests)).toHaveLength(1)
  })

  it('lists the active Ollama model first in the STT catalog', async () => {
    const { kernel, requests } = await createKernel({
      ollama: {},
      respond: async () => jsonResponse({}, 404),
    })
    const catalog = await kernel.listVoiceProviderModels!({
      kind: 'stt',
      providerId: 'ollama-transcriptions',
    })
    expect(catalog.models[0]!.id).toBe(LFM3_MODEL)
    expect(requests).toHaveLength(0)
  })
})

describe('Phase 10.0 T4 — web-speech-tts is delegated to the browser', () => {
  it('returns the use-browser-tts signal with no audio and never fetches', async () => {
    const { kernel, requests } = await createKernel({
      respond: async () => jsonResponse({}, 404),
    })
    const res = await kernel.synthesizeVoiceSpeech!({
      text: 'Oi Carlos, minha voz vem do sistema.',
      providerId: 'web-speech-tts',
    })
    expect(res.providerId).toBe('web-speech-tts')
    expect(res.delivery).toBe(USE_BROWSER_TTS_CODE)
    expect(res.audioBase64).toBe('')
    expect(res.vowelFrames).toEqual([])
    expect(res.durationMs).toBeGreaterThan(0)
    expect(requests).toHaveLength(0)
  })

  it('default TTS (no providerId) also delegates to the browser instead of the buzz tone', async () => {
    const { kernel } = await createKernel({ respond: async () => jsonResponse({}, 404) })
    const res = await kernel.synthesizeVoiceSpeech!({ text: 'Teste padrão.' })
    expect(res.delivery).toBe('use-browser-tts')
    expect(res.audioBase64).toBe('')
  })

  it('the diagnostic local-synth-fallback still works when forced explicitly', async () => {
    const { kernel } = await createKernel({ respond: async () => jsonResponse({}, 404) })
    const res = await kernel.synthesizeVoiceSpeech!({
      text: 'Diagnóstico.',
      providerId: 'local-synth-fallback',
    })
    expect(res.delivery).toBeUndefined()
    expect(res.audioBase64.length).toBeGreaterThan(20)
  })
})
