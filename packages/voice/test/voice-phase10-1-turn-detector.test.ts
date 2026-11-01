import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createTurnDetector,
  synthesizeVoicedSpeechPcm,
  type OrtModuleLike,
  type PcmAudioBlock,
  type TurnDetector,
  type TurnDetectorEvent,
} from '../src'
import { testSettings } from './helpers/phase10-1-fakes'

const RATE = 16000
let frameCursor = 0

function blocksOf(samples: Float32Array, blockMs = 20): PcmAudioBlock[] {
  const per = Math.round((RATE * blockMs) / 1000)
  const out: PcmAudioBlock[] = []
  for (let i = 0; i < samples.length; i += per) {
    const s = samples.slice(i, i + per)
    out.push({ startFrame: frameCursor, endFrame: frameCursor + s.length, sampleRate: RATE, durationMs: (s.length / RATE) * 1000, samples: s })
    frameCursor += s.length
  }
  return out
}

async function feed(det: TurnDetector, samples: Float32Array, assistantSpeaking = false): Promise<TurnDetectorEvent[]> {
  const events: TurnDetectorEvent[] = []
  for (const b of blocksOf(samples)) events.push(...(await det.processBlock(b, { assistantSpeaking })))
  return events
}

const speech = (ms: number) => synthesizeVoicedSpeechPcm({ durationMs: ms, sampleRate: RATE, amplitude: 0.5 })
const silence = (ms: number) => new Float32Array(Math.round((ms / 1000) * RATE))

/** Fake onnxruntime-web: probability = clamp(rms × 8). Records tensors. */
function createFakeOrt() {
  const tensors: Array<{ type: string; dims: readonly number[]; length: number }> = []
  const runs: Array<Record<string, unknown>> = []
  class Tensor {
    constructor(
      public type: 'float32' | 'int64',
      public data: Float32Array | BigInt64Array | number[],
      public dims: readonly number[],
    ) {
      tensors.push({ type, dims, length: data.length })
    }
  }
  const ort: OrtModuleLike = {
    Tensor: Tensor as unknown as OrtModuleLike['Tensor'],
    env: { wasm: {} },
    InferenceSession: {
      async create() {
        return {
          async run(feeds: Record<string, unknown>) {
            runs.push(feeds)
            const input = (feeds.input as Tensor).data as Float32Array
            let sum = 0
            for (let i = 0; i < input.length; i++) sum += input[i]! * input[i]!
            const rms = Math.sqrt(sum / input.length)
            return {
              output: { data: new Float32Array([Math.min(1, rms * 8)]) },
              stateN: { data: new Float32Array(256), dims: [2, 1, 128] },
            }
          },
        }
      },
    },
  }
  return { ort, tensors, runs }
}

describe('Phase 10.1 TurnDetector (spec §6.2)', () => {
  it('falls back to the hybrid DSP VAD when ONNX cannot load (no runtime / failed fetch)', async () => {
    const errors: unknown[] = []
    const det = createTurnDetector({
      turn: testSettings().turn,
      ortLoader: async () => {
        throw new Error('onnxruntime-web unavailable')
      },
      onLoadError: (e) => errors.push(e),
    })
    expect(await det.init()).toBe('hybrid-dsp')
    expect(errors).toHaveLength(1)

    const det2 = createTurnDetector({
      turn: testSettings().turn,
      ortLoader: async () => createFakeOrt().ort,
      fetchImpl: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
    })
    expect(await det2.init()).toBe('hybrid-dsp')

    // The fallback still detects a voiced turn end-to-end.
    const events = await feed(det, speech(600))
    events.push(...(await feed(det, silence(900))))
    const types = events.map((e) => e.type)
    expect(types).toContain('speech_start')
    expect(types).toContain('speech_end')
    expect(types.indexOf('speech_start')).toBeLessThan(types.indexOf('speech_end'))
  })

  it('uses Silero ONNX via the sessionLoader (512-sample windows + 64 context, model URL fetched)', async () => {
    const fake = createFakeOrt()
    const fetched: string[] = []
    const det = createTurnDetector({
      turn: testSettings().turn,
      modelUrl: '/models/silero_vad.onnx',
      ortLoader: async () => fake.ort,
      fetchImpl: async (url) => {
        fetched.push(url)
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }
      },
    })
    expect(await det.init()).toBe('silero-onnx')
    expect(fetched).toEqual(['/models/silero_vad.onnx'])
    expect(fake.ort.env?.wasm?.numThreads).toBe(1)
    await feed(det, speech(100))
    expect(det.getEngineMode()).toBe('silero-onnx')
    const inputTensors = fake.tensors.filter((t) => t.type === 'float32' && t.dims.length === 2)
    expect(inputTensors.every((t) => t.dims[1] === 576 && t.length === 576)).toBe(true)
    expect(fake.tensors.some((t) => t.type === 'int64')).toBe(true)
  })

  it('confirms onset only after minSpeechMs, ends after endpointMs of silence', async () => {
    const det = createTurnDetector({ turn: testSettings({ turn: { minSpeechMs: 250, endpointMs: 700 } }).turn, sessionLoader: async () => null })
    await det.init()
    expect((await feed(det, speech(150))).filter((e) => e.type === 'speech_start')).toHaveLength(0)
    const more = await feed(det, speech(200))
    const start = more.find((e) => e.type === 'speech_start')
    expect(start).toBeDefined()
    expect(start!.type === 'speech_start' && start!.speechMs).toBeGreaterThanOrEqual(250)
    expect((await feed(det, silence(500))).some((e) => e.type === 'speech_end')).toBe(false)
    const end = (await feed(det, silence(400))).find((e) => e.type === 'speech_end')
    expect(end).toBeDefined()
    expect(end!.type === 'speech_end' && end!.silenceMs).toBeGreaterThanOrEqual(700)
  })

  it('a short blip is cancelled (speech_cancel) and a quick resume is flagged as continuation (graceMs)', async () => {
    const det = createTurnDetector({ turn: testSettings({ turn: { graceMs: 1500 } }).turn, sessionLoader: async () => null })
    await det.init()
    const blip = await feed(det, speech(100))
    blip.push(...(await feed(det, silence(300))))
    expect(blip.map((e) => e.type)).toEqual(['speech_cancel'])

    await feed(det, speech(400))
    await feed(det, silence(800)) // speech_end
    const resumed = (await feed(det, speech(400))).find((e) => e.type === 'speech_start')
    expect(resumed && resumed.type === 'speech_start' && resumed.continuation).toBe(true)
  })

  it('reports speech_during_playback with growing speechMs while the assistant speaks', async () => {
    const det = createTurnDetector({ turn: testSettings().turn, sessionLoader: async () => null })
    await det.init()
    const events = (await feed(det, speech(600), true)).filter((e) => e.type === 'speech_during_playback')
    expect(events.length).toBeGreaterThan(5)
    const last = events.at(-1)!
    expect(last.type === 'speech_during_playback' && last.confirmed && last.speechMs).toBeGreaterThanOrEqual(500)
  })

  const modelPath = path.resolve(__dirname, '../../../apps/desktop/public/models/silero_vad.onnx')
  it.runIf(fs.existsSync(modelPath))('loads the bundled Silero v5 model with the real onnxruntime-web', async () => {
    const bytes = fs.readFileSync(modelPath)
    const det = createTurnDetector({
      turn: testSettings().turn,
      // node build of onnxruntime-web (the renderer uses the `/wasm` bundle)
      ortLoader: async () => (await import('onnxruntime-web')) as unknown as OrtModuleLike,
      fetchImpl: async () => ({
        ok: true,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      }),
    })
    expect(await det.init()).toBe('silero-onnx')
    await feed(det, silence(200))
    expect(det.getEngineMode()).toBe('silero-onnx')
    expect(det.getLastProbability()).toBeLessThan(0.2)
  }, 30000)
})
