/**
 * Live-call STT through the llama-server that already holds the call model (LFM3-Omni), instead of a
 * second copy of the same model in Ollama (`ollama-transcriptions`): on an 8 GB GPU the two copies
 * oversubscribe VRAM and stall Ollama.
 *
 * Route: llama-server b12024 `POST /v1/audio/transcriptions` (multipart `file` + `language`). The
 * server builds the request from the model's own ASR prompt (the same one a `/v1/realtime`
 * transcription session uses); measured on real pt-BR audio it returned the same text as a realtime
 * transcription session and as `/v1/chat/completions` + `input_audio` + "Perform ASR", with the lowest
 * latency of the three (see docs/superpowers/research/2026-11-01-stt-llamacpp.md).
 *
 * Every request carries `engine.getRequestHeaders()` (the managed server's API key). Bounded by
 * `LLAMA_STT_TIMEOUT_MS`; any failure (transport, HTTP, timeout, chat-style answer) falls back to the
 * configured STT (`createLlamaFirstTranscribe`).
 */
import type { LiveModeSettings, LlamaCppEngineStatus, LiveLocalModelSpec, SttProviderId } from '@ashy/shared'
import { isChatStyleNonTranscript } from '../stt-chat-style'
import type { HostTranscribeFn } from './transcribe'

export const LLAMA_STT_TIMEOUT_MS = 6_000
export const LLAMA_STT_LANGUAGE = 'pt'
/** providerId reported when the call audio was transcribed by llama-server. */
export const LLAMA_STT_PROVIDER_ID = 'llamacpp-transcriptions'
/** STT providers whose work the llama-server route replaces (both end in Ollama's LFM3 on the host). */
const LLAMA_REPLACEABLE_STT: readonly SttProviderId[] = ['ollama-transcriptions', 'web-speech-stt']

export type SttFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: FormData; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

export interface LlamaSttEngineSource {
  getStatus(): LlamaCppEngineStatus
  getModelSpec(modelId: string): LiveLocalModelSpec | undefined
  getRequestHeaders?(): Record<string, string>
}

export interface LlamaSttTarget {
  baseUrl: string
  headers: Record<string, string>
}

/**
 * The llama-server to transcribe with, or null: the engine (managed, or the user's endpoint once it
 * passed the health check) must be running and its model must take audio in.
 */
export function resolveLlamaSttTarget(settings: LiveModeSettings, engine: LlamaSttEngineSource): LlamaSttTarget | null {
  let status: LlamaCppEngineStatus
  try {
    status = engine.getStatus()
  } catch {
    return null
  }
  if (!status.running || !status.baseUrl) return null
  const modelId = status.activeModelId ?? settings.llamacpp.modelId
  if (!engine.getModelSpec(modelId)?.capabilities.audioIn) return null
  let headers: Record<string, string> = {}
  try {
    headers = engine.getRequestHeaders?.() ?? {}
  } catch {
    headers = {}
  }
  return { baseUrl: status.baseUrl.replace(/\/+$/, ''), headers }
}

export interface LlamaTranscriptionRequest {
  baseUrl: string
  wavBytes: Uint8Array
  language?: string
  headers?: Record<string, string>
  fetchImpl?: SttFetchLike
  timeoutMs?: number
  now?: () => number
}

/** POST {baseUrl}/v1/audio/transcriptions. Throws `LLAMA_STT_*` errors. */
export async function requestLlamaTranscription(
  req: LlamaTranscriptionRequest,
): Promise<{ text: string; latencyMs: number }> {
  const fetchImpl = req.fetchImpl ?? (globalThis.fetch as unknown as SttFetchLike)
  const now = req.now ?? (() => performance.now())
  const timeoutMs = req.timeoutMs ?? LLAMA_STT_TIMEOUT_MS
  const form = new FormData()
  form.append('model', 'default')
  form.append('language', req.language || LLAMA_STT_LANGUAGE)
  form.append('file', new Blob([req.wavBytes as unknown as BlobPart], { type: 'audio/wav' }), 'audio.wav')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  ;(timer as { unref?: () => void }).unref?.()
  const startedAt = now()
  const timeoutError = () => new Error(`LLAMA_STT_TIMEOUT: /v1/audio/transcriptions took longer than ${timeoutMs} ms`)
  try {
    let res: Awaited<ReturnType<SttFetchLike>>
    try {
      res = await fetchImpl(`${req.baseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { Accept: 'application/json', ...(req.headers ?? {}) },
        body: form,
        signal: controller.signal,
      })
    } catch (err) {
      if (controller.signal.aborted) throw timeoutError()
      throw new Error(`LLAMA_STT_UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 200)
      } catch {
        detail = ''
      }
      throw new Error(`LLAMA_STT_HTTP_${res.status}${detail ? `: ${detail}` : ''}`)
    }
    let json: unknown
    try {
      json = await res.json()
    } catch (err) {
      if (controller.signal.aborted) throw timeoutError()
      throw new Error(`LLAMA_STT_BAD_RESPONSE: ${err instanceof Error ? err.message : String(err)}`)
    }
    const raw = (json as { text?: unknown } | null)?.text
    if (typeof raw !== 'string') throw new Error('LLAMA_STT_BAD_RESPONSE: no `text` in the answer')
    const text = raw.trim()
    if (text && isChatStyleNonTranscript(text)) {
      throw new Error(`LLAMA_STT_CHAT_STYLE: chat-style answer instead of a transcript: "${text.slice(0, 80)}"`)
    }
    return { text, latencyMs: Math.max(0, Math.round(now() - startedAt)) }
  } finally {
    clearTimeout(timer)
  }
}

export interface LlamaFirstTranscribeDeps {
  /** The llama-server to try (null → straight to the fallback). */
  target: LlamaSttTarget | null
  /** The configured STT (kernel `transcribeVoiceAudio`). */
  fallback: HostTranscribeFn
  fetchImpl?: SttFetchLike
  timeoutMs?: number
  now?: () => number
  onWarning?: (message: string) => void
}

/** `HostTranscribeFn` that prefers llama-server and falls back to the configured STT on any failure. */
export function createLlamaFirstTranscribe(deps: LlamaFirstTranscribeDeps): HostTranscribeFn {
  return async (input) => {
    if (deps.target) {
      try {
        const res = await requestLlamaTranscription({
          baseUrl: deps.target.baseUrl,
          headers: deps.target.headers,
          wavBytes: new Uint8Array(Buffer.from(input.audioBase64, 'base64')),
          ...(input.language ? { language: input.language } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        })
        return { text: res.text, providerId: LLAMA_STT_PROVIDER_ID, latencyMs: res.latencyMs }
      } catch (err) {
        deps.onWarning?.(
          `call:transcribe: llama-server STT failed, using the configured STT (${err instanceof Error ? err.message : String(err)})`,
        )
      }
    }
    return deps.fallback(input)
  }
}

/**
 * Whether a live call's audio should go to llama-server first: llama.cpp backends and cascade, when
 * the effective STT is the Ollama LFM3 path (an explicit Whisper / cloud STT choice is respected).
 */
export function shouldPreferLlamaStt(backend: string, effectiveSttProviderId: SttProviderId | undefined): boolean {
  const backendOk = backend === 'llamacpp-realtime' || backend === 'llamacpp-hybrid' || backend === 'cascade'
  if (!backendOk) return false
  return effectiveSttProviderId === undefined || LLAMA_REPLACEABLE_STT.includes(effectiveSttProviderId)
}
