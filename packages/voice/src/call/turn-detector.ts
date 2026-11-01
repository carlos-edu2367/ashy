/**
 * Phase 10.1 — client-side turn detection (spec §6.2).
 *
 * Silero VAD v5 (ONNX via onnxruntime-web, model served at `/models/silero_vad.onnx`) wrapped by
 * the existing `createSileroOnnxVadEngine`; falls back to `createHybridVadEngine` when the model
 * or runtime can't load. Timing is driven by audio time (block durations), never wall clock, so the
 * detector is deterministic.
 *
 * Events:
 * - `speech_start`: onset confirmed after `minSpeechMs` of speech.
 * - `speech_end`: `endpointMs` of silence after confirmed speech (endpoint). `continuation` on the
 *   NEXT `speech_start` says it resumed within `graceMs` of the previous end.
 * - `speech_during_playback`: every speech window while the assistant is speaking (carries the
 *   growing `speechMs`, for barge-in decisions).
 * - `speech_cancel`: a candidate onset died before confirmation (false onset).
 */
import type { LiveModeSettings } from '@ashy/shared'
import type { PcmAudioBlock } from '../audio-input'
import {
  createHybridVadEngine,
  createSileroOnnxVadEngine,
  downsamplePcmFloat32,
  type SileroOnnxSessionLike,
  type VadEngine,
} from '../vad-engine'

export const DEFAULT_SILERO_VAD_MODEL_URL = '/models/silero_vad.onnx'

/** Silero v5 @16 kHz: 512-sample windows with 64 samples of context prepended. */
const SILERO_WINDOW = 512
const SILERO_CONTEXT = 64
const VAD_RATE = 16000

export type TurnDetectorEvent =
  | { type: 'speech_start'; onsetFrame: number; speechMs: number; continuation: boolean }
  | { type: 'speech_end'; onsetFrame: number; endFrame: number; speechMs: number; silenceMs: number }
  | { type: 'speech_during_playback'; onsetFrame: number; speechMs: number; confirmed: boolean }
  | { type: 'speech_cancel'; onsetFrame: number }

export type TurnDetectorEngineMode = 'silero-onnx' | 'hybrid-dsp'

/** Minimal slice of the onnxruntime-web module the loader needs. */
export interface OrtModuleLike {
  InferenceSession: {
    create(model: Uint8Array, options?: Record<string, unknown>): Promise<{
      run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims?: readonly number[] }>>
    }>
  }
  Tensor: new (type: 'float32' | 'int64', data: Float32Array | BigInt64Array | number[], dims: readonly number[]) => unknown
  env?: { wasm?: { numThreads?: number; wasmPaths?: unknown } }
}

export interface TurnDetectorOptions {
  turn: LiveModeSettings['turn']
  modelUrl?: string
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status?: number; arrayBuffer(): Promise<ArrayBuffer> }>
  /** Default: dynamic `import('onnxruntime-web/wasm')`. */
  ortLoader?: () => Promise<OrtModuleLike>
  /** Optional `ort.env.wasm.wasmPaths` override (where the .wasm files are served). */
  wasmPaths?: string | Record<string, string>
  /** Full override of the Silero session (tests). Return null to force the DSP fallback. */
  sessionLoader?: () => Promise<SileroOnnxSessionLike | null>
  /** Full override of the VAD engine. */
  vadEngine?: VadEngine
  /** Silence probability = threshold − hysteresis. */
  hysteresis?: number
  /** A candidate onset is dropped after this much silence before confirmation. */
  candidateDropMs?: number
  onLoadError?: (error: unknown) => void
}

export interface TurnDetector {
  /** Resolves the engine (ONNX or fallback). Safe to call multiple times. */
  init(): Promise<TurnDetectorEngineMode>
  processBlock(block: PcmAudioBlock, ctx?: { assistantSpeaking?: boolean }): Promise<TurnDetectorEvent[]>
  getEngineMode(): TurnDetectorEngineMode
  getLastProbability(): number
  isInSpeech(): boolean
  reset(): void
}

export function createOrtSileroSessionLoader(opts: {
  modelUrl: string
  fetchImpl?: TurnDetectorOptions['fetchImpl']
  ortLoader?: () => Promise<OrtModuleLike>
  wasmPaths?: string | Record<string, string>
  onOrtLoaded?: (ort: OrtModuleLike) => void
}): () => Promise<SileroOnnxSessionLike | null> {
  return async () => {
    const ort = await (opts.ortLoader ?? (async () => (await import('onnxruntime-web/wasm')) as unknown as OrtModuleLike))()
    if (ort.env?.wasm) {
      // Single thread: no SharedArrayBuffer / cross-origin isolation needed in the renderer.
      ort.env.wasm.numThreads = 1
      if (opts.wasmPaths) ort.env.wasm.wasmPaths = opts.wasmPaths
    }
    const fetchFn =
      opts.fetchImpl ??
      ((globalThis as unknown as { fetch?: TurnDetectorOptions['fetchImpl'] }).fetch as TurnDetectorOptions['fetchImpl'])
    if (!fetchFn) throw new Error('fetch unavailable for Silero model')
    const res = await fetchFn(opts.modelUrl)
    if (!res.ok) throw new Error(`Silero model fetch failed (${res.status ?? '?'})`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] })
    opts.onOrtLoaded?.(ort)
    return {
      run: (feeds) => session.run(feeds) as ReturnType<SileroOnnxSessionLike['run']>,
    }
  }
}

export function createTurnDetector(options: TurnDetectorOptions): TurnDetector {
  const turn = options.turn
  const threshold = Math.max(0.05, Math.min(0.95, turn.vadThreshold))
  const silenceThreshold = Math.max(0.02, threshold - (options.hysteresis ?? 0.15))
  const candidateDropMs = options.candidateDropMs ?? 160

  let ortRef: OrtModuleLike | null = null
  let mode: TurnDetectorEngineMode = 'hybrid-dsp'
  let engine: VadEngine | null = options.vadEngine ?? null
  let initPromise: Promise<TurnDetectorEngineMode> | null = null

  // Windowing state (16 kHz).
  let pending = new Float32Array(0)
  let pendingStartFrame = 0
  let context = new Float32Array(SILERO_CONTEXT)
  let windowSourceRate = VAD_RATE

  // Turn state.
  let phase: 'silence' | 'candidate' | 'speech' = 'silence'
  let onsetFrame = 0
  let speechMs = 0
  let silenceMs = 0
  let lastEndFrameAudioMs: number | null = null
  let audioClockMs = 0
  let lastProbability = 0

  function buildEngine(): VadEngine {
    const sessionLoader =
      options.sessionLoader ??
      createOrtSileroSessionLoader({
        modelUrl: options.modelUrl ?? DEFAULT_SILERO_VAD_MODEL_URL,
        fetchImpl: options.fetchImpl,
        ortLoader: options.ortLoader,
        wasmPaths: options.wasmPaths,
        onOrtLoaded: (ort) => {
          ortRef = ort
        },
      })
    return createSileroOnnxVadEngine({
      candidateThreshold: threshold,
      modelBlendWeight: 1,
      sessionLoader: async () => {
        try {
          return await sessionLoader()
        } catch (err) {
          options.onLoadError?.(err)
          return null
        }
      },
      tensorFactory: (type, data, dims) => {
        if (ortRef) return new ortRef.Tensor(type, data, dims)
        return { type, data, dims }
      },
    })
  }

  function init(): Promise<TurnDetectorEngineMode> {
    if (initPromise) return initPromise
    initPromise = (async () => {
      if (!engine) {
        const silero = buildEngine()
        // Probe once: resolves the session (or the DSP fallback).
        await silero.processBlock({
          startFrame: 0,
          endFrame: SILERO_WINDOW + SILERO_CONTEXT,
          sampleRate: VAD_RATE,
          durationMs: ((SILERO_WINDOW + SILERO_CONTEXT) / VAD_RATE) * 1000,
          samples: new Float32Array(SILERO_WINDOW + SILERO_CONTEXT),
        })
        if (silero.getEngineMode?.() === 'silero-onnx') {
          silero.reset()
          engine = silero
        } else {
          engine = createHybridVadEngine({ candidateThreshold: threshold })
        }
      }
      mode = engine.getEngineMode?.() ?? 'hybrid-dsp'
      return mode
    })()
    return initPromise
  }

  function appendSamples(samples16k: Float32Array, startFrame: number): void {
    if (pending.length === 0) pendingStartFrame = startFrame
    const merged = new Float32Array(pending.length + samples16k.length)
    merged.set(pending)
    merged.set(samples16k, pending.length)
    pending = merged
  }

  const windowMs = (SILERO_WINDOW / VAD_RATE) * 1000

  function handleWindow(prob: number, windowStartFrame: number, assistantSpeaking: boolean, events: TurnDetectorEvent[]): void {
    audioClockMs += windowMs
    const isSpeech = prob >= threshold
    const isSilence = prob < silenceThreshold
    // Frames are reported in the capture's own sample-rate units.
    const toSourceFrame = (f16: number) => Math.round((f16 * windowSourceRate) / VAD_RATE)

    if (phase === 'silence') {
      if (isSpeech) {
        phase = 'candidate'
        onsetFrame = toSourceFrame(windowStartFrame)
        speechMs = windowMs
        silenceMs = 0
        if (assistantSpeaking) events.push({ type: 'speech_during_playback', onsetFrame, speechMs, confirmed: false })
        maybeConfirm(events)
      }
      return
    }

    if (phase === 'candidate') {
      if (isSpeech) {
        speechMs += windowMs
        silenceMs = 0
        if (assistantSpeaking) events.push({ type: 'speech_during_playback', onsetFrame, speechMs, confirmed: false })
        maybeConfirm(events)
      } else if (isSilence) {
        silenceMs += windowMs
        if (silenceMs >= candidateDropMs) {
          phase = 'silence'
          events.push({ type: 'speech_cancel', onsetFrame })
          speechMs = 0
          silenceMs = 0
        }
      }
      return
    }

    // phase === 'speech'
    if (isSpeech) {
      speechMs += windowMs
      silenceMs = 0
      if (assistantSpeaking) events.push({ type: 'speech_during_playback', onsetFrame, speechMs, confirmed: true })
    } else if (isSilence) {
      silenceMs += windowMs
      if (silenceMs >= turn.endpointMs) {
        const endFrame = toSourceFrame(windowStartFrame + SILERO_WINDOW)
        events.push({ type: 'speech_end', onsetFrame, endFrame, speechMs, silenceMs })
        lastEndFrameAudioMs = audioClockMs
        phase = 'silence'
        speechMs = 0
        silenceMs = 0
      }
    } else {
      // Ambiguous band (hysteresis): keep counting as speech but don't reset silence.
      speechMs += windowMs
    }
  }

  function maybeConfirm(events: TurnDetectorEvent[]): void {
    if (phase !== 'candidate' || speechMs < turn.minSpeechMs) return
    phase = 'speech'
    const continuation =
      lastEndFrameAudioMs !== null && audioClockMs - speechMs - lastEndFrameAudioMs <= turn.graceMs
    events.push({ type: 'speech_start', onsetFrame, speechMs, continuation })
  }

  async function processBlock(block: PcmAudioBlock, ctx: { assistantSpeaking?: boolean } = {}): Promise<TurnDetectorEvent[]> {
    if (!engine) await init()
    const vad = engine!
    windowSourceRate = block.sampleRate || VAD_RATE
    const samples16k =
      block.sampleRate === VAD_RATE ? block.samples : downsamplePcmFloat32(block.samples, block.sampleRate, VAD_RATE)
    const start16k = Math.round((block.startFrame * VAD_RATE) / windowSourceRate)
    appendSamples(samples16k, start16k)

    const events: TurnDetectorEvent[] = []
    while (pending.length >= SILERO_WINDOW) {
      const chunk = pending.subarray(0, SILERO_WINDOW)
      const input = new Float32Array(SILERO_CONTEXT + SILERO_WINDOW)
      input.set(context)
      input.set(chunk, SILERO_CONTEXT)
      context = new Float32Array(chunk.subarray(SILERO_WINDOW - SILERO_CONTEXT))
      const windowStart = pendingStartFrame
      pending = new Float32Array(pending.subarray(SILERO_WINDOW))
      pendingStartFrame += SILERO_WINDOW

      let prob = 0
      try {
        const assessment = await vad.processBlock({
          startFrame: windowStart,
          endFrame: windowStart + input.length,
          sampleRate: VAD_RATE,
          durationMs: (input.length / VAD_RATE) * 1000,
          samples: input,
        })
        prob = Number.isFinite(assessment.probability) ? assessment.probability : 0
        if (assessment.engineMode) mode = assessment.engineMode
      } catch {
        prob = 0
      }
      lastProbability = prob
      handleWindow(prob, windowStart, Boolean(ctx.assistantSpeaking), events)
    }
    return events
  }

  return {
    init,
    processBlock,
    getEngineMode: () => mode,
    getLastProbability: () => lastProbability,
    isInSpeech: () => phase === 'speech',
    reset() {
      pending = new Float32Array(0)
      pendingStartFrame = 0
      context = new Float32Array(SILERO_CONTEXT)
      phase = 'silence'
      speechMs = 0
      silenceMs = 0
      lastEndFrameAudioMs = null
      lastProbability = 0
      engine?.reset()
    },
  }
}
