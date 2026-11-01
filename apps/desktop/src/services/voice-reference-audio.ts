/**
 * Phase 10.2 — renderer-side normalization of a reference-voice upload (spec §7.9, §8.3).
 *
 * decode (`AudioContext.decodeAudioData`, any format Chromium decodes: wav/mp3/flac/ogg/m4a)
 * → `OfflineAudioContext` mono 24 kHz (the offline graph downmixes stereo)
 * → trim leading/trailing silence (10 ms frames, RMS below −45 dBFS)
 * → cap at 30 s → reject < 5 s → PCM16 mono WAV, base64 (what `liveVoice:import` expects).
 */

export const VOICE_REF_SAMPLE_RATE = 24_000
export const VOICE_REF_MIN_MS = 5_000
export const VOICE_REF_MAX_MS = 30_000
export const VOICE_REF_SILENCE_DBFS = -45
export const VOICE_REF_ACCEPTED_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'm4a'] as const
export const VOICE_REF_ACCEPT_ATTR = '.wav,.mp3,.flac,.ogg,.m4a,audio/wav,audio/mpeg,audio/flac,audio/ogg,audio/mp4'

const FRAME_MS = 10
/** Keep a little air around the speech so onsets/offsets aren't clipped. */
const EDGE_PAD_MS = 60

export class VoiceReferenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VoiceReferenceError'
  }
}

export interface NormalizedVoiceReference {
  wavBase64: string
  sampleRate: number
  durationMs: number
}

interface DecodedAudioLike {
  duration: number
  numberOfChannels?: number
  sampleRate?: number
}

interface AudioContextLike {
  decodeAudioData(data: ArrayBuffer): Promise<DecodedAudioLike>
  close?(): Promise<void> | void
}

interface OfflineAudioContextLike {
  readonly destination: unknown
  createBufferSource(): {
    buffer: unknown
    connect(dest: unknown): unknown
    start(when?: number): void
  }
  startRendering(): Promise<{ getChannelData(channel: number): Float32Array; length?: number }>
}

export interface VoiceReferenceAudioDeps {
  AudioContext?: new () => AudioContextLike
  OfflineAudioContext?: new (channels: number, length: number, sampleRate: number) => OfflineAudioContextLike
}

export function fileExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : ''
}

export function isAcceptedVoiceFile(name: string): boolean {
  return (VOICE_REF_ACCEPTED_EXTENSIONS as readonly string[]).includes(fileExtension(name))
}

/** Display name for an uploaded file: no extension, trimmed, ≤ 60 chars. */
export function voiceNameFromFile(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim()
  return (base || 'Minha voz').slice(0, 60)
}

/** [start, end) sample range of the non-silent part, or null when everything is silent. */
export function findVoicedRange(
  samples: Float32Array,
  sampleRate: number,
  thresholdDbfs = VOICE_REF_SILENCE_DBFS,
): { start: number; end: number } | null {
  const frame = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000))
  const threshold = Math.pow(10, thresholdDbfs / 20)
  const thresholdSq = threshold * threshold
  let first = -1
  let last = -1
  for (let offset = 0; offset < samples.length; offset += frame) {
    const end = Math.min(samples.length, offset + frame)
    let sum = 0
    for (let i = offset; i < end; i++) {
      const s = samples[i]!
      sum += s * s
    }
    if (sum / (end - offset) > thresholdSq) {
      if (first < 0) first = offset
      last = end
    }
  }
  if (first < 0) return null
  const pad = Math.round((sampleRate * EDGE_PAD_MS) / 1000)
  return { start: Math.max(0, first - pad), end: Math.min(samples.length, last + pad) }
}

/** Mono PCM16 little-endian WAV. */
export function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buf)
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
  }
  return new Uint8Array(buf)
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1).replace('.', ',')
}

export async function normalizeVoiceReference(
  data: ArrayBuffer,
  deps: VoiceReferenceAudioDeps = {},
): Promise<NormalizedVoiceReference> {
  const g = globalThis as unknown as {
    AudioContext?: VoiceReferenceAudioDeps['AudioContext']
    webkitAudioContext?: VoiceReferenceAudioDeps['AudioContext']
    OfflineAudioContext?: VoiceReferenceAudioDeps['OfflineAudioContext']
  }
  const AudioContextCtor = deps.AudioContext ?? g.AudioContext ?? g.webkitAudioContext
  const OfflineCtor = deps.OfflineAudioContext ?? g.OfflineAudioContext
  if (!AudioContextCtor || !OfflineCtor) {
    throw new VoiceReferenceError('Este ambiente não consegue decodificar áudio.')
  }

  const ctx = new AudioContextCtor()
  let decoded: DecodedAudioLike
  try {
    decoded = await ctx.decodeAudioData(data.slice(0))
  } catch {
    throw new VoiceReferenceError('Não consegui ler esse arquivo de áudio. Use wav, mp3, flac, ogg ou m4a.')
  } finally {
    try {
      void ctx.close?.()
    } catch {
      // ignore
    }
  }
  if (!decoded || !(decoded.duration > 0)) {
    throw new VoiceReferenceError('O arquivo de áudio está vazio.')
  }

  const length = Math.max(1, Math.ceil(decoded.duration * VOICE_REF_SAMPLE_RATE))
  const offline = new OfflineCtor(1, length, VOICE_REF_SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start(0)
  const rendered = await offline.startRendering()
  const mono = rendered.getChannelData(0)

  const range = findVoicedRange(mono, VOICE_REF_SAMPLE_RATE)
  if (!range) {
    throw new VoiceReferenceError('Não encontrei fala nesse áudio (só silêncio).')
  }
  const maxSamples = Math.round((VOICE_REF_MAX_MS / 1000) * VOICE_REF_SAMPLE_RATE)
  const end = Math.min(range.end, range.start + maxSamples)
  const trimmed = mono.subarray(range.start, end)
  const durationMs = Math.round((trimmed.length / VOICE_REF_SAMPLE_RATE) * 1000)
  if (durationMs < VOICE_REF_MIN_MS) {
    throw new VoiceReferenceError(
      `A amostra precisa ter pelo menos 5 segundos de fala (sem os silêncios das pontas). Esta tem ${formatSeconds(durationMs)} s.`,
    )
  }
  return {
    wavBase64: bytesToBase64(encodePcm16Wav(trimmed, VOICE_REF_SAMPLE_RATE)),
    sampleRate: VOICE_REF_SAMPLE_RATE,
    durationMs,
  }
}

export async function readFileAsArrayBuffer(file: Blob): Promise<ArrayBuffer> {
  if (typeof (file as Blob & { arrayBuffer?: unknown }).arrayBuffer === 'function') {
    return file.arrayBuffer()
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('Falha ao ler o arquivo'))
    reader.readAsArrayBuffer(file)
  })
}
