import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = resolve(__dirname, '../assets/audio-fixtures')

const VOICE_FIXTURE_METADATA_COMMENTS = {
  'thinking-pause-cas': 'Deixa eu pensar num jeito de... | resolver esse bug no código.',
  'barge-in-interrupt': 'Espera um segundo, Ashy!',
  'wake-word-oi-ashy': 'Ei Ashy, olha esse log',
  'keyboard-click-noise': '[keyboard-click]',
}

function writeAscii4(target, offset, tag) {
  for (let i = 0; i < 4; i++) {
    target[offset + i] = tag.charCodeAt(i) & 0xff
  }
}

function encodeWavPcm16(samples, sampleRate = 16000, metadataComment) {
  const normalizedRate = Math.round(sampleRate)
  const dataSize = samples.length * 2

  const hasComment = typeof metadataComment === 'string' && metadataComment.length > 0
  const commentUtf8 = hasComment ? new TextEncoder().encode(metadataComment) : null
  const icmtPayloadLen = commentUtf8 ? commentUtf8.byteLength + 1 : 0
  const icmtPaddedLen = icmtPayloadLen + (icmtPayloadLen % 2)
  const listChunkTotalBytes = commentUtf8 ? 8 + 4 + 8 + icmtPaddedLen : 0

  const totalBytes = 12 + 24 + (8 + dataSize) + listChunkTotalBytes
  const buffer = new ArrayBuffer(totalBytes)
  const out = new Uint8Array(buffer)
  const view = new DataView(buffer)

  writeAscii4(out, 0, 'RIFF')
  view.setUint32(4, totalBytes - 8, true)
  writeAscii4(out, 8, 'WAVE')

  writeAscii4(out, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, normalizedRate, true)
  view.setUint32(28, normalizedRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)

  let offset = 36
  if (commentUtf8) {
    const listPayloadSize = 4 + 8 + icmtPaddedLen
    writeAscii4(out, offset, 'LIST')
    view.setUint32(offset + 4, listPayloadSize, true)
    writeAscii4(out, offset + 8, 'INFO')
    writeAscii4(out, offset + 12, 'ICMT')
    view.setUint32(offset + 16, icmtPayloadLen, true)
    out.set(commentUtf8, offset + 20)
    out[offset + 20 + commentUtf8.byteLength] = 0
    offset += 8 + listPayloadSize
  }

  writeAscii4(out, offset, 'data')
  view.setUint32(offset + 4, dataSize, true)
  let sampleOffset = offset + 8

  for (let i = 0; i < samples.length; i++) {
    const raw = samples[i]
    const clamped = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0
    const pcm16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
    view.setInt16(sampleOffset, Math.max(-32768, Math.min(32767, pcm16)), true)
    sampleOffset += 2
  }

  return out
}

function synthesizeVoicedSpeechPcm({
  durationMs,
  sampleRate = 16000,
  fundamentalHz = 180,
  amplitude = 0.45,
}) {
  const sampleCount = Math.max(0, Math.round((durationMs / 1000) * sampleRate))
  const out = new Float32Array(sampleCount)
  const f0 = fundamentalHz

  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate
    const w0 = 2 * Math.PI * f0 * t
    const harmonic =
      0.55 * Math.sin(w0) +
      0.25 * Math.sin(3 * w0 + 0.2) +
      0.13 * Math.sin(5 * w0 + 0.5) +
      0.07 * Math.sin(7 * w0 + 0.8)
    const envelope = 0.94 + 0.06 * Math.sin(2 * Math.PI * 4 * t)
    out[i] = Math.max(-1, Math.min(1, amplitude * envelope * harmonic))
  }

  return out
}

function buildCompositeFixtureSamples(sampleRate, totalDurationMs, activeSegmentsMs) {
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

function buildVoiceFixtureWavBytes(fixtureId) {
  const sampleRate = 16000
  const comment = VOICE_FIXTURE_METADATA_COMMENTS[fixtureId]

  switch (fixtureId) {
    case 'thinking-pause-cas': {
      const samples = buildCompositeFixtureSamples(sampleRate, 4200, [
        { startMs: 0, endMs: 800, fundamentalHz: 180 },
        { startMs: 2100, endMs: 2900, fundamentalHz: 190 },
      ])
      return encodeWavPcm16(samples, sampleRate, comment)
    }
    case 'barge-in-interrupt': {
      const samples = buildCompositeFixtureSamples(sampleRate, 2200, [
        { startMs: 400, endMs: 900, fundamentalHz: 185 },
      ])
      return encodeWavPcm16(samples, sampleRate, comment)
    }
    case 'wake-word-oi-ashy': {
      const samples = buildCompositeFixtureSamples(sampleRate, 2200, [
        { startMs: 200, endMs: 900, fundamentalHz: 180 },
      ])
      return encodeWavPcm16(samples, sampleRate, comment)
    }
    case 'keyboard-click-noise': {
      const samples = buildCompositeFixtureSamples(sampleRate, 500, [
        { startMs: 100, endMs: 220, fundamentalHz: 220 },
      ])
      return encodeWavPcm16(samples, sampleRate, comment)
    }
    default:
      throw new Error(`Unknown fixtureId: ${fixtureId}`)
  }
}

mkdirSync(OUTPUT_DIR, { recursive: true })

for (const fixtureId of Object.keys(VOICE_FIXTURE_METADATA_COMMENTS)) {
  const wavBytes = buildVoiceFixtureWavBytes(fixtureId)
  const filePath = resolve(OUTPUT_DIR, `${fixtureId}.wav`)
  writeFileSync(filePath, wavBytes)
  console.log(`Generated ${fixtureId}.wav (${wavBytes.byteLength} bytes) -> ${filePath}`)
}
