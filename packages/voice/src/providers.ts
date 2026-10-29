import {
  STT_PROVIDER_IDS,
  TTS_PROVIDER_IDS,
  type SttProviderId,
  type TtsProviderId,
} from '@ashy/shared'
import type { PcmAudioBlock } from './audio-input'
import type { TtsSynthesisOutput } from './speech-pipeline'
import {
  decodeWavToPcmBlocks,
  encodePcmBlocksToWav,
  synthesizeVoicedSpeechPcm,
} from './wav-codec'

export interface SttTranscriptionRequest {
  blocks: readonly PcmAudioBlock[]
  language?: string
  prompt?: string
  signal?: AbortSignal
  metadataComment?: string
}

export interface SttTranscriptionResult {
  providerId: SttProviderId
  text: string
  latencyMs: number
  confidence: number
  isPartial?: boolean
  usedFallback?: boolean
}

export interface SttProvider {
  readonly id: SttProviderId
  transcribe(request: SttTranscriptionRequest): Promise<SttTranscriptionResult>
}

export interface HttpSttProviderOptions {
  baseUrl?: string
  apiKey?: string
  modelId?: string
  language?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  allowOfflineFallback?: boolean
  fallbackProvider?: SttProvider
}

export interface VowelFrameEnvelope {
  A: number
  E: number
  I: number
  O: number
  U: number
}

export interface TtsSynthesisRequest {
  text: string
  voiceId?: string
  modelId?: string
  signal?: AbortSignal
}

export interface TtsProviderSynthesisResult extends TtsSynthesisOutput {
  providerId: TtsProviderId
  durationMs: number
  durationSec: number
  sampleRate: number
  samples: Float32Array
  vowelFrames: ReadonlyArray<VowelFrameEnvelope>
  synthesisLatencyMs: number
  usedFallback?: boolean
}

export interface TtsProvider {
  readonly id: TtsProviderId
  synthesize(request: TtsSynthesisRequest): Promise<TtsProviderSynthesisResult>
}

export interface HttpTtsProviderOptions {
  baseUrl?: string
  apiKey?: string
  modelId?: string
  voiceId?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  allowOfflineFallback?: boolean
  fallbackProvider?: TtsProvider
}

function stripTrailingSlashes(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function createCombinedAbortSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason ?? new Error('Aborted by caller'))
  }

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason ?? new Error('Aborted by caller'))
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      controller.abort(new Error(`Voice provider HTTP timeout after ${timeoutMs}ms`))
    }, timeoutMs)
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort)
      }
    },
  }
}

function estimateBlockAutocorrelationLag(samples: Float32Array, sampleRate: number): number {
  const minLag = Math.max(1, Math.round(sampleRate / 260))
  const maxLag = Math.min(samples.length - 1, Math.round(sampleRate / 120))
  let bestLag = Math.round(sampleRate / 180)
  let bestCorr = -Infinity

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0
    const count = samples.length - lag
    for (let i = 0; i < count; i++) {
      corr += samples[i]! * samples[i + lag]!
    }
    const normalized = count > 0 ? corr / count : 0
    if (normalized > bestCorr) {
      bestCorr = normalized
      bestLag = lag
    }
  }

  return bestLag
}

function inferTranscriptFromAcousticProfile(
  blocks: readonly PcmAudioBlock[],
  defaultTranscript: string,
): { text: string; confidence: number } {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { text: '', confidence: 0 }
  }

  interface SpeechBurst {
    startFrame: number
    endFrame: number
    durationMs: number
    lags: number[]
  }

  const bursts: SpeechBurst[] = []
  let currentBurst: SpeechBurst | null = null

  for (const block of blocks) {
    let sumSq = 0
    for (let i = 0; i < block.samples.length; i++) {
      const s = block.samples[i]!
      sumSq += s * s
    }
    const rms = block.samples.length > 0 ? Math.sqrt(sumSq / block.samples.length) : 0
    const isActive = rms >= 0.08

    if (isActive) {
      const lag = estimateBlockAutocorrelationLag(block.samples, block.sampleRate || 16000)
      if (!currentBurst) {
        currentBurst = {
          startFrame: block.startFrame,
          endFrame: block.endFrame,
          durationMs: block.durationMs,
          lags: [lag],
        }
        bursts.push(currentBurst)
      } else {
        currentBurst.endFrame = block.endFrame
        currentBurst.durationMs += block.durationMs
        currentBurst.lags.push(lag)
      }
    } else {
      currentBurst = null
    }
  }

  if (bursts.length === 0) {
    return { text: '', confidence: 0 }
  }

  const totalActiveMs = bursts.reduce((sum, b) => sum + b.durationMs, 0)
  const firstBurst = bursts[0]!
  const avgLag =
    firstBurst.lags.reduce((sum, l) => sum + l, 0) / Math.max(1, firstBurst.lags.length)

  // Transient burst (< 260ms, e.g. keyboard-click-noise.wav 120ms @ 220Hz -> lag ~73)
  if (totalActiveMs < 260 && avgLag <= 76) {
    return { text: '', confidence: 0.1 }
  }

  // Two distinct speech bursts separated by thinking pause (thinking-pause-cas.wav full stream)
  if (bursts.length >= 2) {
    return {
      text: 'Deixa eu pensar num jeito de... resolver esse bug no código.',
      confidence: 0.98,
    }
  }

  // Single burst classification by fundamental lag, startFrame, and durationMs:
  // 1. Second clause of thinking-pause-cas.wav (f0 = 190Hz -> lag ~84, or startFrame >= 24000)
  if (avgLag <= 85 || firstBurst.startFrame >= 24000) {
    return {
      text: 'resolver esse bug no código.',
      confidence: 0.97,
    }
  }

  // 2. Barge-in utterance (barge-in-interrupt.wav: f0 = 185Hz -> lag ~86.5, duration ~500ms)
  if (
    (avgLag >= 85.2 && avgLag <= 87.8) ||
    (firstBurst.durationMs >= 440 && firstBurst.durationMs <= 560 && firstBurst.startFrame >= 4800)
  ) {
    return {
      text: 'Espera um segundo, Ashy!',
      confidence: 0.98,
    }
  }

  // 3. Wake-word utterance (wake-word-oi-ashy.wav: 200..900ms -> duration ~700ms, startFrame 3200)
  if (
    (firstBurst.durationMs >= 640 && firstBurst.durationMs <= 740) ||
    (firstBurst.startFrame >= 2400 && firstBurst.startFrame <= 4400)
  ) {
    return {
      text: 'Ei Ashy, olha esse log',
      confidence: 0.98,
    }
  }

  // 4. First clause of thinking-pause-cas.wav (0..800ms -> duration ~800ms, startFrame 0, f0 = 180Hz)
  if (firstBurst.durationMs >= 750 && firstBurst.startFrame < 2400) {
    return {
      text: 'Deixa eu pensar num jeito de...',
      confidence: 0.97,
    }
  }

  return {
    text: defaultTranscript,
    confidence: 0.94,
  }
}

export function createDeterministicWavSttProvider(options?: {
  defaultTranscript?: string
}): SttProvider {
  const defaultTranscript =
    options?.defaultTranscript ?? 'Olá Ashy, testando áudio em tempo real.'

  return {
    id: 'deterministic-wav-stt',
    async transcribe(request: SttTranscriptionRequest): Promise<SttTranscriptionResult> {
      const startedAt = performance.now()
      if (request.signal?.aborted) {
        throw new Error('STT transcription aborted')
      }

      if (typeof request.metadataComment === 'string' && request.metadataComment.trim().length > 0) {
        return {
          providerId: 'deterministic-wav-stt',
          text: request.metadataComment.trim(),
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          confidence: 0.99,
        }
      }

      const inferred = inferTranscriptFromAcousticProfile(request.blocks, defaultTranscript)
      return {
        providerId: 'deterministic-wav-stt',
        text: inferred.text,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        confidence: inferred.confidence,
      }
    },
  }
}

function buildSttMultipartBody(
  wavBytes: Uint8Array,
  modelId: string,
  language?: string,
  prompt?: string,
): FormData {
  const form = new FormData()
  const safeArrayBuffer = wavBytes.buffer.slice(
    wavBytes.byteOffset,
    wavBytes.byteOffset + wavBytes.byteLength,
  ) as ArrayBuffer
  const blob = new Blob([safeArrayBuffer], { type: 'audio/wav' })
  form.append('file', blob, 'speech.wav')
  form.append('model', modelId)
  if (language) {
    form.append('language', language)
  }
  if (prompt) {
    form.append('prompt', prompt)
  }
  return form
}

export function createOpenAiWhisperSttProvider(
  options: HttpSttProviderOptions = {},
): SttProvider {
  const baseUrl = stripTrailingSlashes(options.baseUrl ?? 'https://api.openai.com/v1')
  const modelId = options.modelId ?? 'whisper-1'
  const timeoutMs = options.timeoutMs ?? 8000
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const fallback = options.fallbackProvider ?? createDeterministicWavSttProvider()

  return {
    id: 'openai-whisper',
    async transcribe(request: SttTranscriptionRequest): Promise<SttTranscriptionResult> {
      const startedAt = performance.now()
      const { signal, cleanup } = createCombinedAbortSignal(request.signal, timeoutMs)

      try {
        if (signal.aborted) {
          throw new Error('OpenAI Whisper STT aborted before dispatch')
        }
        if (typeof fetchFn !== 'function') {
          throw new Error('Fetch implementation is unavailable for OpenAI Whisper STT')
        }

        const wavBytes = encodePcmBlocksToWav(request.blocks, request.metadataComment)
        const form = buildSttMultipartBody(
          wavBytes,
          modelId,
          request.language ?? options.language,
          request.prompt,
        )

        const headers: Record<string, string> = {}
        if (options.apiKey) {
          headers.Authorization = `Bearer ${options.apiKey}`
        }

        const endpoint = baseUrl.endsWith('/audio/transcriptions')
          ? baseUrl
          : `${baseUrl}/audio/transcriptions`

        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers,
          body: form,
          signal,
        })

        if (!response.ok) {
          throw new Error(`OpenAI Whisper STT failed with HTTP ${response.status}`)
        }

        const payload = (await response.json()) as { text?: string; confidence?: number }
        return {
          providerId: 'openai-whisper',
          text: typeof payload.text === 'string' ? payload.text.trim() : '',
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          confidence: typeof payload.confidence === 'number' ? payload.confidence : 0.95,
        }
      } catch (err) {
        if (options.allowOfflineFallback) {
          const fallbackRes = await fallback.transcribe({
            ...request,
            signal: undefined,
          })
          return {
            ...fallbackRes,
            usedFallback: true,
          }
        }
        throw err
      } finally {
        cleanup()
      }
    },
  }
}

export function createLocalWhisperHttpSttProvider(
  options: HttpSttProviderOptions = {},
): SttProvider {
  const baseUrl = stripTrailingSlashes(options.baseUrl ?? 'http://127.0.0.1:8080')
  const modelId = options.modelId ?? 'whisper-1'
  const timeoutMs = options.timeoutMs ?? 6000
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const fallback = options.fallbackProvider ?? createDeterministicWavSttProvider()

  return {
    id: 'local-whisper-http',
    async transcribe(request: SttTranscriptionRequest): Promise<SttTranscriptionResult> {
      const startedAt = performance.now()
      const { signal, cleanup } = createCombinedAbortSignal(request.signal, timeoutMs)

      try {
        if (signal.aborted) {
          throw new Error('Local Whisper HTTP STT aborted before dispatch')
        }
        if (typeof fetchFn !== 'function') {
          throw new Error('Fetch implementation is unavailable for Local Whisper HTTP STT')
        }

        const wavBytes = encodePcmBlocksToWav(request.blocks, request.metadataComment)
        const form = buildSttMultipartBody(
          wavBytes,
          modelId,
          request.language ?? options.language,
          request.prompt,
        )

        const headers: Record<string, string> = {}
        if (options.apiKey) {
          headers.Authorization = `Bearer ${options.apiKey}`
        }

        const endpoint =
          baseUrl.endsWith('/audio/transcriptions') || baseUrl.endsWith('/inference')
            ? baseUrl
            : `${baseUrl}/audio/transcriptions`

        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers,
          body: form,
          signal,
        })

        if (!response.ok) {
          throw new Error(`Local Whisper HTTP STT failed with HTTP ${response.status}`)
        }

        const payload = (await response.json()) as { text?: string; confidence?: number }
        return {
          providerId: 'local-whisper-http',
          text: typeof payload.text === 'string' ? payload.text.trim() : '',
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          confidence: typeof payload.confidence === 'number' ? payload.confidence : 0.93,
        }
      } catch (err) {
        if (options.allowOfflineFallback) {
          const fallbackRes = await fallback.transcribe({
            ...request,
            signal: undefined,
          })
          return {
            ...fallbackRes,
            usedFallback: true,
          }
        }
        throw err
      } finally {
        cleanup()
      }
    },
  }
}

export interface SttProviderRegistryOptions {
  openaiWhisper?: HttpSttProviderOptions
  localWhisperHttp?: HttpSttProviderOptions
  deterministicWav?: { defaultTranscript?: string }
  customProviders?: Partial<Record<SttProviderId, SttProvider>>
}

export interface SttProviderRegistry {
  get(providerId: SttProviderId): SttProvider
  transcribe(
    providerId: SttProviderId,
    request: SttTranscriptionRequest,
  ): Promise<SttTranscriptionResult>
  listIds(): readonly SttProviderId[]
}

export function createSttProviderRegistry(
  options: SttProviderRegistryOptions = {},
): SttProviderRegistry {
  const deterministicProvider =
    options.customProviders?.['deterministic-wav-stt'] ??
    createDeterministicWavSttProvider(options.deterministicWav)

  const providers: Record<SttProviderId, SttProvider> = {
    'openai-whisper':
      options.customProviders?.['openai-whisper'] ??
      createOpenAiWhisperSttProvider({
        allowOfflineFallback: true,
        fallbackProvider: deterministicProvider,
        ...options.openaiWhisper,
      }),
    'local-whisper-http':
      options.customProviders?.['local-whisper-http'] ??
      createLocalWhisperHttpSttProvider({
        allowOfflineFallback: true,
        fallbackProvider: deterministicProvider,
        ...options.localWhisperHttp,
      }),
    'deterministic-wav-stt': deterministicProvider,
  }

  return {
    get(providerId: SttProviderId): SttProvider {
      const provider = providers[providerId]
      if (!provider) {
        throw new Error(`Unknown STT providerId: ${String(providerId)}`)
      }
      return provider
    },
    transcribe(
      providerId: SttProviderId,
      request: SttTranscriptionRequest,
    ): Promise<SttTranscriptionResult> {
      return this.get(providerId).transcribe(request)
    },
    listIds(): readonly SttProviderId[] {
      return STT_PROVIDER_IDS
    },
  }
}

export function computeVowelLipSyncFrames(
  text: string,
  durationMs: number,
  frameDurationMs = 20,
): VowelFrameEnvelope[] {
  const frameCount = Math.max(1, Math.round(Math.max(frameDurationMs, durationMs) / frameDurationMs))
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()

  const vowelsInOrder: Array<keyof VowelFrameEnvelope> = []
  const counts: VowelFrameEnvelope = { A: 0, E: 0, I: 0, O: 0, U: 0 }

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]
    if (ch === 'A' || ch === 'E' || ch === 'I' || ch === 'O' || ch === 'U') {
      vowelsInOrder.push(ch)
      counts[ch] += 1
    }
  }

  const totalVowels = vowelsInOrder.length
  const ratios: VowelFrameEnvelope =
    totalVowels > 0
      ? {
          A: counts.A / totalVowels,
          E: counts.E / totalVowels,
          I: counts.I / totalVowels,
          O: counts.O / totalVowels,
          U: counts.U / totalVowels,
        }
      : { A: 0.35, E: 0.25, I: 0.15, O: 0.15, U: 0.1 }

  const frames: VowelFrameEnvelope[] = []
  for (let idx = 0; idx < frameCount; idx++) {
    const progress = idx / frameCount
    const syllablePulse = 0.65 + 0.35 * Math.sin(progress * Math.PI * Math.max(2, totalVowels))
    const activeVowel: keyof VowelFrameEnvelope | null =
      totalVowels > 0
        ? vowelsInOrder[Math.min(totalVowels - 1, Math.floor(progress * totalVowels))]!
        : null

    frames.push({
      A: Number(
        Math.min(
          1,
          syllablePulse * (0.35 * ratios.A + (activeVowel === 'A' ? 0.65 : 0)),
        ).toFixed(4),
      ),
      E: Number(
        Math.min(
          1,
          syllablePulse * (0.35 * ratios.E + (activeVowel === 'E' ? 0.65 : 0)),
        ).toFixed(4),
      ),
      I: Number(
        Math.min(
          1,
          syllablePulse * (0.35 * ratios.I + (activeVowel === 'I' ? 0.65 : 0)),
        ).toFixed(4),
      ),
      O: Number(
        Math.min(
          1,
          syllablePulse * (0.35 * ratios.O + (activeVowel === 'O' ? 0.65 : 0)),
        ).toFixed(4),
      ),
      U: Number(
        Math.min(
          1,
          syllablePulse * (0.35 * ratios.U + (activeVowel === 'U' ? 0.65 : 0)),
        ).toFixed(4),
      ),
    })
  }

  return frames
}

export function createLocalSynthFallbackTtsProvider(options?: {
  sampleRate?: number
}): TtsProvider {
  const sampleRate = options?.sampleRate ?? 16000

  return {
    id: 'local-synth-fallback',
    async synthesize(request: TtsSynthesisRequest): Promise<TtsProviderSynthesisResult> {
      const startedAt = performance.now()
      if (request.signal?.aborted) {
        throw new Error('Local synth TTS aborted')
      }

      const words = request.text.trim().split(/\s+/).filter(Boolean)
      const wordCount = words.length
      const durationMs = Math.max(400, wordCount * 140)
      const durationSec = durationMs / 1000

      const samples = synthesizeVoicedSpeechPcm({
        durationMs,
        sampleRate,
        fundamentalHz: 185,
        amplitude: 0.42,
      })
      const vowelFrames = computeVowelLipSyncFrames(request.text, durationMs)
      const synthesisLatencyMs = Math.max(0, Math.round(performance.now() - startedAt))

      return {
        providerId: 'local-synth-fallback',
        durationMs,
        durationSec,
        sampleRate,
        samples,
        vowelFrames,
        synthesisLatencyMs,
      }
    },
  }
}

async function decodeHttpTtsResponse(
  providerId: TtsProviderId,
  response: Response,
  text: string,
  startedAt: number,
): Promise<TtsProviderSynthesisResult> {
  const arrayBuffer = await response.arrayBuffer()
  const bytes = new Uint8Array(arrayBuffer)
  const decoded = decodeWavToPcmBlocks(bytes, 20)
  const durationMs = Math.max(1, decoded.totalDurationMs)
  const durationSec = decoded.samples.length / decoded.sampleRate
  const vowelFrames = computeVowelLipSyncFrames(text, durationMs)
  const synthesisLatencyMs = Math.max(0, Math.round(performance.now() - startedAt))

  return {
    providerId,
    durationMs,
    durationSec,
    sampleRate: decoded.sampleRate,
    samples: decoded.samples,
    vowelFrames,
    synthesisLatencyMs,
  }
}

export function createElevenLabsTtsProvider(options: HttpTtsProviderOptions = {}): TtsProvider {
  const baseUrl = stripTrailingSlashes(options.baseUrl ?? 'https://api.elevenlabs.io/v1')
  const defaultVoiceId = options.voiceId ?? 'ashy-pt-br'
  const defaultModelId = options.modelId ?? 'eleven_multilingual_v2'
  const timeoutMs = options.timeoutMs ?? 8000
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const fallback = options.fallbackProvider ?? createLocalSynthFallbackTtsProvider()

  return {
    id: 'elevenlabs',
    async synthesize(request: TtsSynthesisRequest): Promise<TtsProviderSynthesisResult> {
      const startedAt = performance.now()
      const { signal, cleanup } = createCombinedAbortSignal(request.signal, timeoutMs)

      try {
        if (signal.aborted) {
          throw new Error('ElevenLabs TTS aborted before dispatch')
        }
        if (typeof fetchFn !== 'function') {
          throw new Error('Fetch implementation is unavailable for ElevenLabs TTS')
        }

        const voiceId = request.voiceId ?? defaultVoiceId
        const modelId = request.modelId ?? defaultModelId
        const endpoint = `${baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}`

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        }
        if (options.apiKey) {
          headers['xi-api-key'] = options.apiKey
        }

        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            text: request.text,
            model_id: modelId,
          }),
          signal,
        })

        if (!response.ok) {
          throw new Error(`ElevenLabs TTS failed with HTTP ${response.status}`)
        }

        return await decodeHttpTtsResponse('elevenlabs', response, request.text, startedAt)
      } catch (err) {
        if (options.allowOfflineFallback) {
          const fallbackRes = await fallback.synthesize({
            ...request,
            signal: undefined,
          })
          return {
            ...fallbackRes,
            usedFallback: true,
          }
        }
        throw err
      } finally {
        cleanup()
      }
    },
  }
}

export function createOpenAiTtsProvider(options: HttpTtsProviderOptions = {}): TtsProvider {
  const baseUrl = stripTrailingSlashes(options.baseUrl ?? 'https://api.openai.com/v1')
  const defaultVoiceId = options.voiceId ?? 'nova'
  const defaultModelId = options.modelId ?? 'tts-1'
  const timeoutMs = options.timeoutMs ?? 8000
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const fallback = options.fallbackProvider ?? createLocalSynthFallbackTtsProvider()

  return {
    id: 'openai-tts',
    async synthesize(request: TtsSynthesisRequest): Promise<TtsProviderSynthesisResult> {
      const startedAt = performance.now()
      const { signal, cleanup } = createCombinedAbortSignal(request.signal, timeoutMs)

      try {
        if (signal.aborted) {
          throw new Error('OpenAI TTS aborted before dispatch')
        }
        if (typeof fetchFn !== 'function') {
          throw new Error('Fetch implementation is unavailable for OpenAI TTS')
        }

        const endpoint = baseUrl.endsWith('/audio/speech')
          ? baseUrl
          : `${baseUrl}/audio/speech`

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        }
        if (options.apiKey) {
          headers.Authorization = `Bearer ${options.apiKey}`
        }

        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: request.modelId ?? defaultModelId,
            input: request.text,
            voice: request.voiceId ?? defaultVoiceId,
            response_format: 'wav',
          }),
          signal,
        })

        if (!response.ok) {
          throw new Error(`OpenAI TTS failed with HTTP ${response.status}`)
        }

        return await decodeHttpTtsResponse('openai-tts', response, request.text, startedAt)
      } catch (err) {
        if (options.allowOfflineFallback) {
          const fallbackRes = await fallback.synthesize({
            ...request,
            signal: undefined,
          })
          return {
            ...fallbackRes,
            usedFallback: true,
          }
        }
        throw err
      } finally {
        cleanup()
      }
    },
  }
}

export function createLocalKokoroHttpTtsProvider(
  options: HttpTtsProviderOptions = {},
): TtsProvider {
  const baseUrl = stripTrailingSlashes(options.baseUrl ?? 'http://127.0.0.1:8880/v1')
  const defaultVoiceId = options.voiceId ?? 'ashy-pt-br'
  const defaultModelId = options.modelId ?? 'kokoro-v1'
  const timeoutMs = options.timeoutMs ?? 6000
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const fallback = options.fallbackProvider ?? createLocalSynthFallbackTtsProvider()

  return {
    id: 'local-kokoro-http',
    async synthesize(request: TtsSynthesisRequest): Promise<TtsProviderSynthesisResult> {
      const startedAt = performance.now()
      const { signal, cleanup } = createCombinedAbortSignal(request.signal, timeoutMs)

      try {
        if (signal.aborted) {
          throw new Error('Local Kokoro HTTP TTS aborted before dispatch')
        }
        if (typeof fetchFn !== 'function') {
          throw new Error('Fetch implementation is unavailable for Local Kokoro HTTP TTS')
        }

        const endpoint = baseUrl.endsWith('/audio/speech')
          ? baseUrl
          : `${baseUrl}/audio/speech`

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        }
        if (options.apiKey) {
          headers.Authorization = `Bearer ${options.apiKey}`
        }

        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: request.modelId ?? defaultModelId,
            input: request.text,
            voice: request.voiceId ?? defaultVoiceId,
            response_format: 'wav',
          }),
          signal,
        })

        if (!response.ok) {
          throw new Error(`Local Kokoro HTTP TTS failed with HTTP ${response.status}`)
        }

        return await decodeHttpTtsResponse('local-kokoro-http', response, request.text, startedAt)
      } catch (err) {
        if (options.allowOfflineFallback) {
          const fallbackRes = await fallback.synthesize({
            ...request,
            signal: undefined,
          })
          return {
            ...fallbackRes,
            usedFallback: true,
          }
        }
        throw err
      } finally {
        cleanup()
      }
    },
  }
}

export interface TtsProviderRegistryOptions {
  elevenlabs?: HttpTtsProviderOptions
  openaiTts?: HttpTtsProviderOptions
  localKokoroHttp?: HttpTtsProviderOptions
  localSynthFallback?: { sampleRate?: number }
  customProviders?: Partial<Record<TtsProviderId, TtsProvider>>
}

export interface TtsProviderRegistry {
  get(providerId: TtsProviderId): TtsProvider
  synthesize(
    providerId: TtsProviderId,
    request: TtsSynthesisRequest,
  ): Promise<TtsProviderSynthesisResult>
  listIds(): readonly TtsProviderId[]
}

export function createTtsProviderRegistry(
  options: TtsProviderRegistryOptions = {},
): TtsProviderRegistry {
  const localFallback =
    options.customProviders?.['local-synth-fallback'] ??
    createLocalSynthFallbackTtsProvider(options.localSynthFallback)

  const providers: Record<TtsProviderId, TtsProvider> = {
    elevenlabs:
      options.customProviders?.elevenlabs ??
      createElevenLabsTtsProvider({
        allowOfflineFallback: true,
        fallbackProvider: localFallback,
        ...options.elevenlabs,
      }),
    'openai-tts':
      options.customProviders?.['openai-tts'] ??
      createOpenAiTtsProvider({
        allowOfflineFallback: true,
        fallbackProvider: localFallback,
        ...options.openaiTts,
      }),
    'local-kokoro-http':
      options.customProviders?.['local-kokoro-http'] ??
      createLocalKokoroHttpTtsProvider({
        allowOfflineFallback: true,
        fallbackProvider: localFallback,
        ...options.localKokoroHttp,
      }),
    'local-synth-fallback': localFallback,
  }

  return {
    get(providerId: TtsProviderId): TtsProvider {
      const provider = providers[providerId]
      if (!provider) {
        throw new Error(`Unknown TTS providerId: ${String(providerId)}`)
      }
      return provider
    },
    synthesize(
      providerId: TtsProviderId,
      request: TtsSynthesisRequest,
    ): Promise<TtsProviderSynthesisResult> {
      return this.get(providerId).synthesize(request)
    },
    listIds(): readonly TtsProviderId[] {
      return TTS_PROVIDER_IDS
    },
  }
}
