/** Phase 10.1 — small PCM helpers shared by the call sessions and the CallEngine. */
import type { CallVisemeFrame } from '@ashy/shared'
import { extractPcmFrameVowelWeights } from '../providers'
import { base64ToUint8Array, uint8ArrayToBase64 } from '../wav-codec'

export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]!
    out[i] = v < 0 ? v / 32768 : v / 32767
  }
  return out
}

export function float32ToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const raw = samples[i]!
    const s = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767)
  }
  return out
}

/** Little-endian PCM16 → base64. */
export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true)
  return uint8ArrayToBase64(bytes)
}

/** base64 little-endian PCM16 → Int16Array (odd trailing byte dropped). */
export function base64ToInt16(base64: string): Int16Array {
  const bytes = base64ToUint8Array(base64)
  const count = Math.floor(bytes.byteLength / 2)
  const out = new Int16Array(count)
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2)
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true)
  return out
}

/** Linear resampler (any ratio). */
export function resampleFloat32(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples
  const outLen = Math.max(0, Math.round((samples.length * toRate) / fromRate))
  const out = new Float32Array(outLen)
  const ratio = fromRate / toRate
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio
    const i0 = Math.floor(x)
    const f = x - i0
    const a = samples[i0] ?? 0
    const b = samples[i0 + 1] ?? a
    out[i] = a * (1 - f) + b * f
  }
  return out
}

export const VISEME_FRAME_MS = 20

/**
 * Per-20 ms viseme frames computed from the PCM that will actually be played
 * (vowels via `extractPcmFrameVowelWeights`, volume = clamp(rms × 2.2) like the stage driver).
 */
export function computePcmVisemeFrames(
  samples: Float32Array,
  sampleRate: number,
  frameMs = VISEME_FRAME_MS,
): CallVisemeFrame[] {
  const frameSamples = Math.max(1, Math.round((sampleRate * frameMs) / 1000))
  const frames: CallVisemeFrame[] = []
  for (let offset = 0; offset < samples.length; offset += frameSamples) {
    const slice = samples.subarray(offset, Math.min(samples.length, offset + frameSamples))
    const w = extractPcmFrameVowelWeights(slice, sampleRate)
    let sumSq = 0
    for (let i = 0; i < slice.length; i++) sumSq += slice[i]! * slice[i]!
    const rms = slice.length > 0 ? Math.sqrt(sumSq / slice.length) : 0
    const volume = w.rmsVolume <= 0 ? 0 : Math.min(1, rms * 2.2)
    frames.push({ A: w.A, E: w.E, I: w.I, O: w.O, U: w.U, volume: Number(volume.toFixed(4)) })
  }
  return frames
}

export const ZERO_VISEME: Readonly<CallVisemeFrame> = Object.freeze({ A: 0, E: 0, I: 0, O: 0, U: 0, volume: 0 })

/**
 * Proportional receipt: the part of `text` that was spoken after `playedMs` of `totalMs` audio.
 * Cuts back to a word boundary so we never claim a half-spoken word.
 */
export function sliceSpokenText(text: string, playedMs: number, totalMs: number): string {
  if (!text) return ''
  if (!(totalMs > 0) || playedMs <= 0) return ''
  const ratio = Math.min(1, playedMs / totalMs)
  if (ratio >= 0.999) return text.trim()
  const cut = Math.floor(text.length * ratio)
  if (cut <= 0) return ''
  let end = cut
  // If the cut lands inside a word, back off to the previous whitespace.
  if (end < text.length && /\S/.test(text[end]!) && /\S/.test(text[end - 1]!)) {
    const prevSpace = text.lastIndexOf(' ', end - 1)
    end = prevSpace > 0 ? prevSpace : 0
  }
  return text.slice(0, end).trim()
}
