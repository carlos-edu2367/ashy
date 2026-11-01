/**
 * Phase 10.1 — `call:transcribe` (spec §6.4). Reuses the host STT path from
 * Phase 10.0 (kernel `transcribeVoiceAudio`: `ollama-transcriptions` with the
 * chat-style-answer heuristic, local Whisper fallback, …) through an injected
 * function — no HTTP code here. Audio shorter than 300 ms is not sent.
 */
import { decodeWavToPcmBlocks } from '@ashy/voice'
import type { CallTranscribeResult, SttProviderId } from '@ashy/shared'

export const CALL_TRANSCRIBE_MIN_AUDIO_MS = 300
/** providerId reported when the audio was too short to be worth transcribing. */
export const CALL_TRANSCRIBE_SKIPPED_PROVIDER = 'skipped-short-audio'

export interface HostTranscribeFn {
  (input: {
    audioBase64: string
    mimeType: string
    language?: string
    /** Phase 10.5: explicit STT provider (cascade calls); default = the voice settings' provider. */
    providerId?: SttProviderId
  }): Promise<{ text: string; providerId: string; latencyMs: number }>
}

export interface CallTranscribeDeps {
  transcribe: HostTranscribeFn
  minAudioMs?: number
  now?: () => number
}

export async function transcribeCallAudio(
  input: { audioWavBase64: string; language?: string; providerId?: SttProviderId },
  deps: CallTranscribeDeps,
): Promise<CallTranscribeResult> {
  const minAudioMs = deps.minAudioMs ?? CALL_TRANSCRIBE_MIN_AUDIO_MS
  const now = deps.now ?? (() => performance.now())

  let durationMs: number
  try {
    const bytes = new Uint8Array(Buffer.from(input.audioWavBase64, 'base64'))
    durationMs = decodeWavToPcmBlocks(bytes, 20).totalDurationMs
  } catch (err) {
    throw new Error(
      `call:transcribe: invalid WAV audio (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (!(durationMs >= minAudioMs)) {
    return { text: '', providerId: CALL_TRANSCRIBE_SKIPPED_PROVIDER, latencyMs: 0 }
  }

  const startedAt = now()
  const res = await deps.transcribe({
    audioBase64: input.audioWavBase64,
    mimeType: 'audio/wav',
    ...(input.language ? { language: input.language } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
  })
  return {
    text: typeof res.text === 'string' ? res.text.trim() : '',
    providerId: res.providerId,
    latencyMs:
      Number.isFinite(res.latencyMs) && res.latencyMs >= 0
        ? Math.round(res.latencyMs)
        : Math.max(0, Math.round(now() - startedAt)),
  }
}
