import type { VoiceFixtureId } from '@ashy/shared'
import type { PcmAudioBlock } from './audio-input'

export interface DecodedWavResult {
  sampleRate: number
  totalDurationMs: number
  samples: Float32Array
  blocks: PcmAudioBlock[]
  metadataComment: string | null
}

export interface SynthesizeVoicedSpeechOptions {
  durationMs: number
  sampleRate?: number
  fundamentalHz?: number
  amplitude?: number
  variant?: 'voiced' | 'sustain' | 'transient-click'
}

export const VOICE_FIXTURE_METADATA_COMMENTS: Record<VoiceFixtureId, string> = {
  'thinking-pause-cas': 'Deixa eu pensar num jeito de... | resolver esse bug no código.',
  'barge-in-interrupt': 'Espera um segundo, Ashy!',
  'wake-word-oi-ashy': 'Ei Ashy, olha esse log',
  'keyboard-click-noise': '[keyboard-click]',
}

function writeAscii4(target: Uint8Array, offset: number, tag: string): void {
  for (let i = 0; i < 4; i++) {
    target[offset + i] = tag.charCodeAt(i) & 0xff
  }
}

function readAscii4(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  )
}

export function encodeWavPcm16(
  samples: Float32Array,
  sampleRate = 16000,
  metadataComment?: string,
): Uint8Array {
  if (!(samples instanceof Float32Array)) {
    throw new Error('Invalid samples provided to encodeWavPcm16: expected Float32Array')
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(
      `Invalid sampleRate in encodeWavPcm16: ${sampleRate} (must be a positive finite number)`,
    )
  }

  const normalizedRate = Math.round(sampleRate)
  const dataSize = samples.length * 2

  const hasComment = typeof metadataComment === 'string' && metadataComment.length > 0
  const commentUtf8 = hasComment ? new TextEncoder().encode(metadataComment) : null
  const icmtPayloadLen = commentUtf8 ? commentUtf8.byteLength + 1 : 0 // +1 for null terminator
  const icmtPaddedLen = icmtPayloadLen + (icmtPayloadLen % 2)
  // LIST chunk = 'LIST' (4) + size (4) + 'INFO' (4) + 'ICMT' (4) + icmtSize (4) + icmtPaddedLen
  const listChunkTotalBytes = commentUtf8 ? 8 + 4 + 8 + icmtPaddedLen : 0

  const totalBytes = 12 + 24 + (8 + dataSize) + listChunkTotalBytes
  const buffer = new ArrayBuffer(totalBytes)
  const out = new Uint8Array(buffer)
  const view = new DataView(buffer)

  // 1. RIFF header (12 bytes)
  writeAscii4(out, 0, 'RIFF')
  view.setUint32(4, totalBytes - 8, true)
  writeAscii4(out, 8, 'WAVE')

  // 2. fmt  chunk (24 bytes)
  writeAscii4(out, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // audioFormat = 1 (PCM)
  view.setUint16(22, 1, true) // numChannels = 1 (mono)
  view.setUint32(24, normalizedRate, true) // sampleRate
  view.setUint32(28, normalizedRate * 2, true) // byteRate = sampleRate * numChannels * 2
  view.setUint16(32, 2, true) // blockAlign = numChannels * 2
  view.setUint16(34, 16, true) // bitsPerSample = 16

  // 3. Optional LIST/INFO/ICMT metadata chunk before data (or after data — standard RIFF supports either)
  let offset = 36
  if (commentUtf8) {
    const listPayloadSize = 4 + 8 + icmtPaddedLen
    writeAscii4(out, offset, 'LIST')
    view.setUint32(offset + 4, listPayloadSize, true)
    writeAscii4(out, offset + 8, 'INFO')
    writeAscii4(out, offset + 12, 'ICMT')
    view.setUint32(offset + 16, icmtPayloadLen, true)
    out.set(commentUtf8, offset + 20)
    out[offset + 20 + commentUtf8.byteLength] = 0 // null terminator
    offset += 8 + listPayloadSize
  }

  // 4. data chunk
  writeAscii4(out, offset, 'data')
  view.setUint32(offset + 4, dataSize, true)
  let sampleOffset = offset + 8

  for (let i = 0; i < samples.length; i++) {
    const raw = samples[i]!
    const clamped = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0
    const pcm16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
    view.setInt16(sampleOffset, Math.max(-32768, Math.min(32767, pcm16)), true)
    sampleOffset += 2
  }

  return out
}

export function encodePcmBlocksToWav(
  blocks: readonly PcmAudioBlock[],
  metadataComment?: string,
): Uint8Array {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return encodeWavPcm16(new Float32Array(0), 16000, metadataComment)
  }
  const sampleRate = blocks[0]!.sampleRate || 16000
  let totalSamples = 0
  for (const block of blocks) {
    totalSamples += block.samples.length
  }
  const merged = new Float32Array(totalSamples)
  let cursor = 0
  for (const block of blocks) {
    merged.set(block.samples, cursor)
    cursor += block.samples.length
  }
  return encodeWavPcm16(merged, sampleRate, metadataComment)
}

export function decodeWavToPcmBlocks(
  wavBytes: Uint8Array | ArrayBuffer,
  blockDurationMs = 20,
): DecodedWavResult {
  if (!Number.isFinite(blockDurationMs) || blockDurationMs <= 0) {
    throw new Error(`Invalid blockDurationMs: ${blockDurationMs}`)
  }

  const bytes =
    wavBytes instanceof Uint8Array
      ? wavBytes
      : wavBytes instanceof ArrayBuffer
        ? new Uint8Array(wavBytes)
        : null

  if (!bytes || bytes.byteLength < 44) {
    throw new Error(
      `Malformed or truncated RIFF/WAVE header: expected at least 44 bytes, got ${bytes ? bytes.byteLength : 0}`,
    )
  }

  const riffTag = readAscii4(bytes, 0)
  const waveTag = readAscii4(bytes, 8)
  if (riffTag !== 'RIFF' || waveTag !== 'WAVE') {
    throw new Error(
      `Invalid RIFF/WAVE format header: found "${riffTag}" / "${waveTag}" instead of "RIFF" / "WAVE"`,
    )
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const declaredRiffSize = view.getUint32(4, true)
  if (declaredRiffSize + 8 > bytes.byteLength) {
    throw new Error(
      `Truncated RIFF/WAVE payload: header declares ${declaredRiffSize + 8} bytes but buffer has ${bytes.byteLength}`,
    )
  }

  let audioFormat = 0
  let numChannels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let foundFmt = false
  let dataOffset = -1
  let dataSize = 0
  let metadataComment: string | null = null
  const textDecoder = new TextDecoder()

  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii4(bytes, offset)
    const chunkSize = view.getUint32(offset + 4, true)
    const chunkPayloadStart = offset + 8
    const chunkPayloadEnd = chunkPayloadStart + chunkSize

    if (chunkPayloadEnd > bytes.byteLength) {
      throw new Error(
        `Truncated WAV chunk "${chunkId}": chunk size ${chunkSize} exceeds buffer length ${bytes.byteLength}`,
      )
    }

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new Error(`Malformed fmt chunk: size ${chunkSize} < 16`)
      }
      audioFormat = view.getUint16(chunkPayloadStart, true)
      numChannels = view.getUint16(chunkPayloadStart + 2, true)
      sampleRate = view.getUint32(chunkPayloadStart + 4, true)
      bitsPerSample = view.getUint16(chunkPayloadStart + 14, true)

      if (audioFormat !== 1 && audioFormat !== 3) {
        throw new Error(`Unsupported WAV audioFormat: ${audioFormat} (expected 1=PCM or 3=Float)`)
      }
      if (!Number.isFinite(numChannels) || numChannels <= 0) {
        throw new Error(`Invalid WAV numChannels: ${numChannels}`)
      }
      if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
        throw new Error(`Invalid WAV sampleRate: ${sampleRate}`)
      }
      if (
        (audioFormat === 1 && bitsPerSample !== 16) ||
        (audioFormat === 3 && bitsPerSample !== 32)
      ) {
        throw new Error(
          `Unsupported WAV bitsPerSample ${bitsPerSample} for audioFormat ${audioFormat}`,
        )
      }
      foundFmt = true
    } else if (chunkId === 'data') {
      dataOffset = chunkPayloadStart
      dataSize = chunkSize
    } else if (chunkId === 'ICMT') {
      const rawText = textDecoder.decode(bytes.subarray(chunkPayloadStart, chunkPayloadEnd))
      metadataComment = rawText.replace(/\0+$/g, '')
    } else if (chunkId === 'LIST' && chunkSize >= 4) {
      const listType = readAscii4(bytes, chunkPayloadStart)
      if (listType === 'INFO') {
        let subOffset = chunkPayloadStart + 4
        while (subOffset + 8 <= chunkPayloadEnd) {
          const subId = readAscii4(bytes, subOffset)
          const subSize = view.getUint32(subOffset + 4, true)
          const subStart = subOffset + 8
          const subEnd = subStart + subSize
          if (subEnd > chunkPayloadEnd) {
            break
          }
          if (subId === 'ICMT') {
            const rawText = textDecoder.decode(bytes.subarray(subStart, subEnd))
            metadataComment = rawText.replace(/\0+$/g, '')
          }
          subOffset = subEnd + (subSize % 2)
        }
      }
    }

    offset = chunkPayloadEnd + (chunkSize % 2)
  }

  if (!foundFmt || dataOffset < 0) {
    throw new Error('Malformed WAV buffer: missing required fmt or data chunk')
  }

  const bytesPerSample = (bitsPerSample / 8) * numChannels
  const totalFrames = Math.floor(dataSize / bytesPerSample)
  const samples = new Float32Array(totalFrames)

  if (audioFormat === 1 && bitsPerSample === 16) {
    for (let i = 0; i < totalFrames; i++) {
      let chSum = 0
      const frameByteOffset = dataOffset + i * bytesPerSample
      for (let ch = 0; ch < numChannels; ch++) {
        const pcm16 = view.getInt16(frameByteOffset + ch * 2, true)
        chSum += pcm16 < 0 ? pcm16 / 32768 : pcm16 / 32767
      }
      samples[i] = chSum / numChannels
    }
  } else {
    for (let i = 0; i < totalFrames; i++) {
      let chSum = 0
      const frameByteOffset = dataOffset + i * bytesPerSample
      for (let ch = 0; ch < numChannels; ch++) {
        const val = view.getFloat32(frameByteOffset + ch * 4, true)
        chSum += Number.isFinite(val) ? Math.max(-1, Math.min(1, val)) : 0
      }
      samples[i] = chSum / numChannels
    }
  }

  const framesPerBlock = Math.max(1, Math.round((blockDurationMs / 1000) * sampleRate))
  const blocks: PcmAudioBlock[] = []
  let startFrame = 0

  while (startFrame < totalFrames) {
    const endFrame = Math.min(totalFrames, startFrame + framesPerBlock)
    const blockSamples = samples.slice(startFrame, endFrame)
    const durationMs = ((endFrame - startFrame) / sampleRate) * 1000
    blocks.push({
      startFrame,
      endFrame,
      sampleRate,
      durationMs,
      samples: blockSamples,
    })
    startFrame = endFrame
  }

  const totalDurationMs = Math.round((totalFrames / sampleRate) * 1000)

  return {
    sampleRate,
    totalDurationMs,
    samples,
    blocks,
    metadataComment,
  }
}

export function synthesizeVoicedSpeechPcm(
  durationMsOrOptions: number | SynthesizeVoicedSpeechOptions,
  sampleRateArg = 16000,
  amplitudeArg = 0.45,
): Float32Array {
  const opts: Required<SynthesizeVoicedSpeechOptions> =
    typeof durationMsOrOptions === 'number'
      ? {
          durationMs: durationMsOrOptions,
          sampleRate: sampleRateArg,
          fundamentalHz: 180,
          amplitude: amplitudeArg,
          variant: 'voiced',
        }
      : {
          durationMs: durationMsOrOptions.durationMs,
          sampleRate: durationMsOrOptions.sampleRate ?? 16000,
          fundamentalHz: durationMsOrOptions.fundamentalHz ?? 180,
          amplitude:
            durationMsOrOptions.amplitude ??
            (durationMsOrOptions.variant === 'sustain' ? 0.045 : 0.45),
          variant: durationMsOrOptions.variant ?? 'voiced',
        }

  const sampleCount = Math.max(0, Math.round((opts.durationMs / 1000) * opts.sampleRate))
  const out = new Float32Array(sampleCount)
  const f0 = opts.fundamentalHz

  for (let i = 0; i < sampleCount; i++) {
    const t = i / opts.sampleRate
    const w0 = 2 * Math.PI * f0 * t
    // Harmonic speech synthesis: fundamental f0 + 3 vowel formants (3*f0, 5*f0, 7*f0)
    const harmonic =
      0.55 * Math.sin(w0) +
      0.25 * Math.sin(3 * w0 + 0.2) +
      0.13 * Math.sin(5 * w0 + 0.5) +
      0.07 * Math.sin(7 * w0 + 0.8)
    // Gentle syllable modulation [0.88 .. 1.00] so every 20ms block maintains steady energy
    const envelope = 0.94 + 0.06 * Math.sin(2 * Math.PI * 4 * t)
    out[i] = Math.max(-1, Math.min(1, opts.amplitude * envelope * harmonic))
  }

  return out
}

function buildCompositeFixtureSamples(
  sampleRate: number,
  totalDurationMs: number,
  activeSegmentsMs: ReadonlyArray<{ startMs: number; endMs: number; fundamentalHz?: number }>,
): Float32Array {
  const totalSamples = Math.round((totalDurationMs / 1000) * sampleRate)
  const samples = new Float32Array(totalSamples)

  for (const seg of activeSegmentsMs) {
    const startSample = Math.max(0, Math.round((seg.startMs / 1000) * sampleRate))
    const endSample = Math.min(totalSamples, Math.round((seg.endMs / 1000) * sampleRate))
    const durationMs = ((endSample - startSample) / sampleRate) * 1000
    const segmentSamples = synthesizeVoicedSpeechPcm({
      durationMs,
      sampleRate,
      fundamentalHz: seg.fundamentalHz ?? 180,
      amplitude: 0.45,
    })
    samples.set(segmentSamples.subarray(0, endSample - startSample), startSample)
  }

  return samples
}

export function buildVoiceFixtureWavBytes(fixtureId: VoiceFixtureId): Uint8Array {
  const sampleRate = 16000
  const comment = VOICE_FIXTURE_METADATA_COMMENTS[fixtureId]

  switch (fixtureId) {
    case 'thinking-pause-cas': {
      // 4.2s total: 0..800ms speech, 800..2100ms pause (1300ms), 2100..2900ms speech, 2900..4200ms silence
      const samples = buildCompositeFixtureSamples(sampleRate, 4200, [
        { startMs: 0, endMs: 800, fundamentalHz: 180 },
        { startMs: 2100, endMs: 2900, fundamentalHz: 190 },
      ])
      return encodeWavPcm16(samples, sampleRate, comment)
    }

    case 'barge-in-interrupt': {
      // 2.2s total: 0..400ms leading silence (anchorFrame=640 for 360ms pre-roll), 400..900ms speech, 900..2200ms silence
      const samples = buildCompositeFixtureSamples(sampleRate, 2200, [
        { startMs: 400, endMs: 900, fundamentalHz: 185 },
      ])
      return encodeWavPcm16(samples, sampleRate, comment)
    }

    case 'wake-word-oi-ashy': {
      // 2.2s total: 0..200ms silence, 200..900ms speech, 900..2200ms silence
      const samples = buildCompositeFixtureSamples(sampleRate, 2200, [
        { startMs: 200, endMs: 900, fundamentalHz: 180 },
      ])
      return encodeWavPcm16(samples, sampleRate, comment)
    }

    case 'keyboard-click-noise': {
      // 0.5s total: 0..100ms silence, 100..220ms (120ms < 300ms) transient burst, 220..500ms silence
      const samples = buildCompositeFixtureSamples(sampleRate, 500, [
        { startMs: 100, endMs: 220, fundamentalHz: 220 },
      ])
      return encodeWavPcm16(samples, sampleRate, comment)
    }

    default: {
      throw new Error(`Unknown VoiceFixtureId: ${String(fixtureId)}`)
    }
  }
}


export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  }
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64
    .trim()
    .replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  if (!clean) {
    return new Uint8Array(0)
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(clean, 'base64'))
  }
  const padded = clean.padEnd(clean.length + ((4 - (clean.length % 4)) % 4), '=')
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

export function decodeOmniAudioDeltaToPcm(
  audioBase64: string,
  format: 'pcm16' | 'wav',
  sampleRate = 24000,
): { samples: Float32Array; sampleRate: number; durationMs: number } {
  const bytes = base64ToUint8Array(audioBase64)
  if (bytes.byteLength === 0) {
    return {
      samples: new Float32Array(0),
      sampleRate,
      durationMs: 0,
    }
  }
  if (format === 'wav' || (bytes.length >= 12 && readAscii4(bytes, 0) === 'RIFF')) {
    const decoded = decodeWavToPcmBlocks(bytes, 20)
    return {
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      durationMs: decoded.totalDurationMs,
    }
  }
  const sampleCount = Math.floor(bytes.byteLength / 2)
  const samples = new Float32Array(sampleCount)
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2)
  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(i * 2, true)
    samples[i] = int16 < 0 ? int16 / 32768 : int16 / 32767
  }
  const safeSampleRate = sampleRate > 0 ? sampleRate : 24000
  const durationMs = Math.round((sampleCount / safeSampleRate) * 1000)
  return { samples, sampleRate: safeSampleRate, durationMs }
}
