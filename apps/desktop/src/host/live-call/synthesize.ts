/**
 * Phase 10.2 — `call:synthesize` (spec §7.9, §8.3): hybrid mode speaks the realtime session's TEXT
 * answer through llama-server `POST /tts` (b12024: `{input, voice, language, response_format:'wav',
 * speaker_ref_b64?}` → 24 kHz PCM16 WAV), optionally cloning the user's reference voice.
 *
 * Every request to the managed llama-server carries `engine.getRequestHeaders()` (api key, T3).
 */
import type { CallSynthesizeResult, LiveModeSettings, LlamaCppEngineStatus } from '@ashy/shared'

export const CALL_TTS_TIMEOUT_MS = 20_000
export const CALL_TTS_LANGUAGE = 'pt'

// ───────────────────────────── WAV helpers (PCM16 / float32, tolerant of streamed headers) ─────────────────────────────

export interface ParsedWav {
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** 1 = PCM, 3 = IEEE float. */
  audioFormat: number
  /** Mono PCM16 (channels averaged; float converted). */
  pcm: Int16Array
  durationMs: number
}

function ascii4(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)
}

/**
 * Parses a RIFF/WAVE buffer. Unlike `decodeWavToPcmBlocks` it tolerates the placeholder sizes
 * (0 / 0xFFFFFFFF) some servers write when streaming, and it exposes channels/bit depth so callers
 * can validate the format.
 */
export function parseWav(input: Uint8Array): ParsedWav {
  const bytes = input
  if (bytes.byteLength < 44 || ascii4(bytes, 0) !== 'RIFF' || ascii4(bytes, 8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null
  let dataStart = -1
  let dataEnd = -1
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii4(bytes, offset)
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (id === 'fmt ') {
      if (size < 16 || start + 16 > bytes.byteLength) throw new Error('malformed fmt chunk')
      let audioFormat = view.getUint16(start, true)
      if (audioFormat === 0xfffe && size >= 40) {
        // WAVE_FORMAT_EXTENSIBLE: the sub-format GUID starts with the real format tag.
        audioFormat = view.getUint16(start + 24, true)
      }
      fmt = {
        audioFormat,
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        bitsPerSample: view.getUint16(start + 14, true),
      }
    } else if (id === 'data') {
      dataStart = start
      // Streamed WAVs may declare 0 / 0xFFFFFFFF: take the rest of the buffer.
      dataEnd = size === 0 || size === 0xffffffff || start + size > bytes.byteLength ? bytes.byteLength : start + size
      break
    }
    if (start + size > bytes.byteLength) break
    offset = start + size + (size % 2)
  }
  if (!fmt) throw new Error('missing fmt chunk')
  if (dataStart < 0) throw new Error('missing data chunk')
  const { audioFormat, channels, sampleRate, bitsPerSample } = fmt
  if (!(channels >= 1 && channels <= 8)) throw new Error(`invalid channel count ${channels}`)
  if (!(sampleRate >= 1000 && sampleRate <= 192_000)) throw new Error(`invalid sample rate ${sampleRate}`)
  const isPcm16 = audioFormat === 1 && bitsPerSample === 16
  const isFloat32 = audioFormat === 3 && bitsPerSample === 32
  if (!isPcm16 && !isFloat32) {
    throw new Error(`unsupported WAV encoding (format ${audioFormat}, ${bitsPerSample} bit)`)
  }
  const frameBytes = (bitsPerSample / 8) * channels
  const frames = Math.floor((dataEnd - dataStart) / frameBytes)
  const pcm = new Int16Array(frames)
  for (let i = 0; i < frames; i++) {
    const base = dataStart + i * frameBytes
    let sum = 0
    for (let ch = 0; ch < channels; ch++) {
      if (isPcm16) {
        const s = view.getInt16(base + ch * 2, true)
        sum += s < 0 ? s / 32768 : s / 32767
      } else {
        const f = view.getFloat32(base + ch * 4, true)
        sum += Number.isFinite(f) ? Math.max(-1, Math.min(1, f)) : 0
      }
    }
    const m = sum / channels
    pcm[i] = m < 0 ? Math.round(m * 32768) : Math.round(m * 32767)
  }
  return { sampleRate, channels, bitsPerSample, audioFormat, pcm, durationMs: Math.round((frames / sampleRate) * 1000) }
}

/** Mono PCM16 → canonical 44-byte-header WAV. */
export function encodeMonoPcm16Wav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  const w = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i)
  }
  w(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  w(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i]!, true)
  return out
}

/** Linear resampler for mono PCM16. */
export function resamplePcm16(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || pcm.length === 0) return pcm
  const outLen = Math.max(0, Math.round((pcm.length * toRate) / fromRate))
  const out = new Int16Array(outLen)
  const ratio = fromRate / toRate
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio
    const i0 = Math.floor(x)
    const f = x - i0
    const a = pcm[i0] ?? 0
    const b = pcm[i0 + 1] ?? a
    out[i] = Math.round(a * (1 - f) + b * f)
  }
  return out
}

export function pcm16ToBase64(pcm: Int16Array): string {
  const buf = Buffer.alloc(pcm.length * 2)
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i]!, i * 2)
  return buf.toString('base64')
}

// ───────────────────────────── llama-server /tts client ─────────────────────────────

/** Narrow view of the llama.cpp engine used for host → llama-server HTTP calls. */
export interface TtsEngineSource {
  getStatus(): LlamaCppEngineStatus
  /** T3: `Authorization: Bearer <key>` for the managed server ({} for a user endpoint). */
  getRequestHeaders?(): Record<string, string>
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}>

/** Base URL of the llama-server to talk to (running managed engine, else the user's endpoint). */
export function resolveLlamaBaseUrl(settings: LiveModeSettings, engine: TtsEngineSource): string | null {
  let status: LlamaCppEngineStatus | null = null
  try {
    status = engine.getStatus()
  } catch {
    status = null
  }
  if (status?.baseUrl) return status.baseUrl.replace(/\/+$/, '')
  const endpoint = settings.llamacpp.endpoint
  return endpoint !== 'managed' ? endpoint.url.replace(/\/+$/, '') : null
}

export interface LlamaTtsRequest {
  baseUrl: string
  text: string
  voice: 'female' | 'male'
  speakerRefB64?: string | null
  headers?: Record<string, string>
  fetchImpl?: FetchLike
  timeoutMs?: number
  now?: () => number
}

export interface LlamaTtsResult {
  wav: Uint8Array
  parsed: ParsedWav
  latencyMs: number
}

/** POST {baseUrl}/tts and decode the WAV answer. Throws `TTS_*` errors. */
export async function requestLlamaTts(req: LlamaTtsRequest): Promise<LlamaTtsResult> {
  const fetchImpl = req.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const now = req.now ?? (() => performance.now())
  const timeoutMs = req.timeoutMs ?? CALL_TTS_TIMEOUT_MS
  const body: Record<string, unknown> = {
    input: req.text,
    voice: req.voice,
    language: CALL_TTS_LANGUAGE,
    response_format: 'wav',
  }
  if (req.speakerRefB64) body.speaker_ref_b64 = req.speakerRefB64
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  ;(timer as { unref?: () => void }).unref?.()
  const startedAt = now()
  try {
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await fetchImpl(`${req.baseUrl.replace(/\/+$/, '')}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'audio/wav', ...(req.headers ?? {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`TTS_TIMEOUT: /tts took longer than ${timeoutMs} ms`)
      throw new Error(`TTS_UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 300)
      } catch {
        detail = ''
      }
      throw new Error(`TTS_HTTP_${res.status}${detail ? `: ${detail}` : ''}`)
    }
    let wav: Uint8Array
    try {
      wav = new Uint8Array(await res.arrayBuffer())
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`TTS_TIMEOUT: /tts took longer than ${timeoutMs} ms`)
      throw err
    }
    let parsed: ParsedWav
    try {
      parsed = parseWav(wav)
    } catch (err) {
      throw new Error(`TTS_BAD_AUDIO: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { wav, parsed, latencyMs: Math.max(0, Math.round(now() - startedAt)) }
  } finally {
    clearTimeout(timer)
  }
}

// ───────────────────────────── call:synthesize ─────────────────────────────

export interface CallSynthesizerDeps {
  getSettings(): LiveModeSettings
  engine: TtsEngineSource
  /** Reference voice WAV (base64) by id; null when it doesn't exist. */
  loadReferenceBase64(id: string): string | null
  fetchImpl?: FetchLike
  timeoutMs?: number
  now?: () => number
}

export interface CallSynthesizer {
  synthesize(input: { text: string; voice?: 'female' | 'male'; referenceVoiceId?: string | null }): Promise<CallSynthesizeResult>
  /** Drops the cached reference audio (after a voice is deleted / replaced). */
  invalidateReference(id?: string): void
}

const REFERENCE_CACHE_MAX = 4

export function createCallSynthesizer(deps: CallSynthesizerDeps): CallSynthesizer {
  const refCache = new Map<string, string>()

  function referenceFor(id: string | null | undefined): string | null {
    if (!id) return null
    const cached = refCache.get(id)
    if (cached) return cached
    const loaded = deps.loadReferenceBase64(id)
    if (!loaded) return null
    refCache.set(id, loaded)
    while (refCache.size > REFERENCE_CACHE_MAX) {
      const oldest = refCache.keys().next().value
      if (oldest === undefined) break
      refCache.delete(oldest)
    }
    return loaded
  }

  return {
    async synthesize(input) {
      const text = input.text.trim()
      if (!text) throw new Error('TTS_EMPTY_TEXT')
      const settings = deps.getSettings()
      const baseUrl = resolveLlamaBaseUrl(settings, deps.engine)
      if (!baseUrl) throw new Error('TTS_UNAVAILABLE: llama-server is not running')
      const refId = input.referenceVoiceId === undefined ? settings.hybrid.referenceVoiceId : input.referenceVoiceId
      const result = await requestLlamaTts({
        baseUrl,
        text,
        voice: input.voice ?? settings.llamacpp.voice,
        speakerRefB64: referenceFor(refId),
        headers: deps.engine.getRequestHeaders?.() ?? {},
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      })
      return {
        pcmBase64: pcm16ToBase64(result.parsed.pcm),
        sampleRate: result.parsed.sampleRate,
        durationMs: result.parsed.durationMs,
        latencyMs: result.latencyMs,
      }
    },
    invalidateReference(id) {
      if (id) refCache.delete(id)
      else refCache.clear()
    },
  }
}
