/**
 * Phase 10.2 — reference voices for the hybrid call mode (`liveVoice:list|import|delete|preview`).
 *
 * Storage: `userData/voices/<id>.wav` (canonical mono PCM16 @ 24 kHz) + `userData/voices/voices.json`
 * (atomic writes). The renderer already normalized the upload (decode → mono 24 kHz → trim); the host
 * re-validates everything: PCM16 mono, 16–48 kHz, 5–30 s, at most 20 voices.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { VoiceReference } from '@ashy/shared'
import { writeAtomicWithBackup } from '../atomic-file'
import { encodeMonoPcm16Wav, parseWav, resamplePcm16 } from './synthesize'

export const VOICES_DIR = 'voices'
export const VOICES_INDEX_FILE = 'voices.json'
export const VOICE_MAX_COUNT = 20
export const VOICE_MIN_DURATION_MS = 5_000
export const VOICE_MAX_DURATION_MS = 30_000
export const VOICE_MIN_SAMPLE_RATE = 16_000
export const VOICE_MAX_SAMPLE_RATE = 48_000
/** Stored reference rate (llama-server /tts output rate). */
export const VOICE_STORED_SAMPLE_RATE = 24_000
export const VOICE_PREVIEW_DEFAULT_TEXT = 'Oi! Essa é a minha voz na chamada.'

const VOICE_ID_RE = /^[a-z0-9-]{1,64}$/

export class VoiceError extends Error {
  constructor(
    readonly code:
      | 'VOICE_INVALID_AUDIO'
      | 'VOICE_BAD_FORMAT'
      | 'VOICE_BAD_DURATION'
      | 'VOICE_LIMIT'
      | 'VOICE_NOT_FOUND',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'VoiceError'
  }
}

export interface VoiceStoreDeps {
  userDataDir: string
  now?: () => number
  createId?: () => string
}

export interface VoiceStore {
  list(): VoiceReference[]
  get(id: string): VoiceReference | null
  import(input: { name: string; wavBase64: string }): VoiceReference
  /** Returns true when the voice existed. */
  delete(id: string): boolean
  /** Stored reference WAV as base64 (null when unknown). */
  readWavBase64(id: string): string | null
}

interface VoicesIndex {
  version: 1
  voices: VoiceReference[]
}

function isVoiceReference(value: unknown): value is VoiceReference {
  const v = value as VoiceReference
  return (
    !!v &&
    typeof v.id === 'string' &&
    VOICE_ID_RE.test(v.id) &&
    typeof v.name === 'string' &&
    typeof v.durationMs === 'number' &&
    typeof v.createdAt === 'number'
  )
}

export function createVoiceStore(deps: VoiceStoreDeps): VoiceStore {
  const dir = path.join(deps.userDataDir, VOICES_DIR)
  const indexPath = path.join(dir, VOICES_INDEX_FILE)
  const now = deps.now ?? (() => Date.now())
  const createId = deps.createId ?? (() => `voz-${randomBytes(5).toString('hex')}`)

  function wavPath(id: string): string {
    if (!VOICE_ID_RE.test(id)) throw new VoiceError('VOICE_NOT_FOUND', id)
    return path.join(dir, `${id}.wav`)
  }

  function readIndex(): VoiceReference[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Partial<VoicesIndex>
      return Array.isArray(parsed.voices) ? parsed.voices.filter(isVoiceReference) : []
    } catch {
      return []
    }
  }

  function writeIndex(voices: VoiceReference[]): void {
    const index: VoicesIndex = { version: 1, voices }
    writeAtomicWithBackup(indexPath, `${JSON.stringify(index, null, 2)}\n`, { rotateBackup: false })
  }

  return {
    list() {
      return readIndex().map((v) => ({ ...v }))
    },

    get(id) {
      const found = readIndex().find((v) => v.id === id)
      return found ? { ...found } : null
    },

    import(input) {
      const name = input.name.trim().slice(0, 60)
      if (!name) throw new VoiceError('VOICE_INVALID_AUDIO', 'name is required')
      const voices = readIndex()
      if (voices.length >= VOICE_MAX_COUNT) {
        throw new VoiceError('VOICE_LIMIT', `at most ${VOICE_MAX_COUNT} voices`)
      }
      const raw = Buffer.from(input.wavBase64.replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, ''), 'base64')
      let parsed: ReturnType<typeof parseWav>
      try {
        parsed = parseWav(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
      } catch (err) {
        throw new VoiceError('VOICE_INVALID_AUDIO', err instanceof Error ? err.message : String(err))
      }
      if (parsed.audioFormat !== 1 || parsed.bitsPerSample !== 16 || parsed.channels !== 1) {
        throw new VoiceError(
          'VOICE_BAD_FORMAT',
          `expected PCM16 mono, got ${parsed.channels} ch / ${parsed.bitsPerSample} bit / format ${parsed.audioFormat}`,
        )
      }
      if (parsed.sampleRate < VOICE_MIN_SAMPLE_RATE || parsed.sampleRate > VOICE_MAX_SAMPLE_RATE) {
        throw new VoiceError(
          'VOICE_BAD_FORMAT',
          `sample rate ${parsed.sampleRate} Hz outside ${VOICE_MIN_SAMPLE_RATE}–${VOICE_MAX_SAMPLE_RATE} Hz`,
        )
      }
      if (parsed.durationMs < VOICE_MIN_DURATION_MS || parsed.durationMs > VOICE_MAX_DURATION_MS) {
        throw new VoiceError(
          'VOICE_BAD_DURATION',
          `duration ${(parsed.durationMs / 1000).toFixed(1)} s outside ${VOICE_MIN_DURATION_MS / 1000}–${VOICE_MAX_DURATION_MS / 1000} s`,
        )
      }
      let id = createId()
      for (let i = 0; voices.some((v) => v.id === id) && i < 5; i++) id = createId()
      if (!VOICE_ID_RE.test(id) || voices.some((v) => v.id === id)) {
        throw new Error(`could not allocate a voice id (${id})`)
      }
      const pcm = resamplePcm16(parsed.pcm, parsed.sampleRate, VOICE_STORED_SAMPLE_RATE)
      const wav = encodeMonoPcm16Wav(pcm, VOICE_STORED_SAMPLE_RATE)
      fs.mkdirSync(dir, { recursive: true })
      const target = wavPath(id)
      const tmp = `${target}.tmp`
      fs.writeFileSync(tmp, wav)
      fs.renameSync(tmp, target)
      const record: VoiceReference = { id, name, durationMs: parsed.durationMs, createdAt: now() }
      try {
        writeIndex([...voices, record])
      } catch (err) {
        fs.rmSync(target, { force: true })
        throw err
      }
      return { ...record }
    },

    delete(id) {
      const voices = readIndex()
      const next = voices.filter((v) => v.id !== id)
      const existed = next.length !== voices.length
      if (existed) writeIndex(next)
      try {
        fs.rmSync(wavPath(id), { force: true })
      } catch {
        // ignore
      }
      return existed
    },

    readWavBase64(id) {
      if (!VOICE_ID_RE.test(id)) return null
      if (!readIndex().some((v) => v.id === id)) return null
      try {
        return fs.readFileSync(wavPath(id)).toString('base64')
      } catch {
        return null
      }
    },
  }
}

