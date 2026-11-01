import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGaplessAudioPlayer,
  createVoiceSessionRuntime,
  encodeWavPcm16,
  uint8ArrayToBase64,
  type WebAudioContextLike,
} from '../src'

interface FakeSourceNode {
  buffer: unknown
  connect: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  onended: (() => void) | null
}

function createFakeAudioContext() {
  const sources: FakeSourceNode[] = []
  const gains: Array<{ gain: { value: number } }> = []
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    state: 'running',
    destination: {},
    createGain: vi.fn(() => {
      const node = {
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }
      gains.push(node)
      return node
    }),
    createBuffer: vi.fn((_ch: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length)
      return { duration: length / sampleRate, getChannelData: () => data }
    }),
    createBufferSource: vi.fn(() => {
      const node: FakeSourceNode = {
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      }
      sources.push(node)
      return node
    }),
  }
  return { ctx: ctx as WebAudioContextLike & typeof ctx, sources, gains }
}

function sineWavBase64(durationSec: number, sampleRate = 24000): string {
  const samples = new Float32Array(Math.round(durationSec * sampleRate))
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sampleRate)
  }
  return uint8ArrayToBase64(encodeWavPcm16(samples, sampleRate))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('@ashy/voice — Phase 10.0 (T3): audible gapless playback', () => {
  it('without an AudioContext keeps the virtual clock and reports played=false', () => {
    const runtime = createVoiceSessionRuntime({ micMode: 'continuous', wakeWordEnabled: false })
    const result = runtime.ingestOmniAudioDelta({
      turnId: 't-virtual',
      seq: 0,
      audioBase64: sineWavBase64(0.5),
      format: 'wav',
      sampleRate: 24000,
      durationMs: 500,
    })
    expect(result.played).toBe(false)
    expect(runtime.getPlayer().hasAudioOutput()).toBe(false)
    expect(runtime.getPlayer().isPlaying()).toBe(true)
  })

  it('attachAudioContext() binds the player: audio deltas start real buffer sources through a GainNode', () => {
    const { ctx, sources, gains } = createFakeAudioContext()
    const runtime = createVoiceSessionRuntime({ micMode: 'continuous', wakeWordEnabled: false })
    runtime.attachAudioContext(ctx)
    expect(gains).toHaveLength(1)
    expect(gains[0]!).toHaveProperty('connect')

    const result = runtime.ingestOmniAudioDelta({
      turnId: 't-real',
      seq: 0,
      audioBase64: sineWavBase64(0.5),
      format: 'wav',
      sampleRate: 24000,
      durationMs: 500,
    })

    expect(result.played).toBe(true)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.start).toHaveBeenCalledTimes(1)
    expect(sources[0]!.connect).toHaveBeenCalledWith(gains[0])
    expect(ctx.createBuffer).toHaveBeenCalledWith(1, 12000, 24000)
  })

  it('ends playback on the real source drain (onended), not on the virtual clock', () => {
    const { ctx, sources } = createFakeAudioContext()
    const onPlaybackEnded = vi.fn()
    const runtime = createVoiceSessionRuntime({
      micMode: 'continuous',
      wakeWordEnabled: false,
      onPlaybackEnded,
    })
    runtime.attachAudioContext(ctx)
    runtime.ingestOmniAudioDelta({
      turnId: 't-drain',
      seq: 0,
      audioBase64: sineWavBase64(0.4),
      format: 'wav',
      sampleRate: 24000,
      durationMs: 400,
    })
    const player = runtime.getPlayer()
    player.markStreamComplete(true)

    // Virtual clock running past the end must not end playback while the source is in flight
    player.advanceVirtualClockSec(5)
    expect(onPlaybackEnded).not.toHaveBeenCalled()
    expect(player.isPlaying()).toBe(true)

    ctx.currentTime = 0.45
    sources[0]!.onended?.()
    expect(onPlaybackEnded).toHaveBeenCalledTimes(1)
    expect(player.isPlaying()).toBe(false)
  })

  it('feeds vowel frames continuously during real playback and closes the mouth at the end', () => {
    vi.useFakeTimers()
    const { ctx, sources } = createFakeAudioContext()
    const frames: Array<{ A: number; E: number; I: number; O: number; U: number }> = []
    const player = createGaplessAudioPlayer({
      audioContext: ctx,
      onVowelFrame: (f) => frames.push(f),
    })
    player.scheduleChunk({
      seq: 0,
      text: 'olá',
      samples: new Float32Array(24000),
      sampleRate: 24000,
      vowelFrames: [
        { A: 0.9, E: 0, I: 0, O: 0, U: 0 },
        { A: 0, E: 0, I: 0, O: 0.8, U: 0 },
      ],
    })
    const initial = frames.length

    ctx.currentTime = 0.75
    vi.advanceTimersByTime(100)
    expect(frames.length).toBeGreaterThan(initial)
    expect(frames.at(-1)!.O).toBeCloseTo(0.8, 5)

    ctx.currentTime = 1.01
    sources[0]!.onended?.()
    expect(frames.at(-1)).toEqual({ A: 0, E: 0, I: 0, O: 0, U: 0 })

    const afterEnd = frames.length
    vi.advanceTimersByTime(200)
    expect(frames.length).toBe(afterEnd)
  })

  it('interruptOmniPlayback stops the in-flight sources with a fade', () => {
    const { ctx, sources, gains } = createFakeAudioContext()
    const runtime = createVoiceSessionRuntime({ micMode: 'continuous', wakeWordEnabled: false })
    runtime.attachAudioContext(ctx)
    runtime.ingestOmniAudioDelta({
      turnId: 't-barge',
      seq: 0,
      audioBase64: sineWavBase64(1),
      format: 'wav',
      sampleRate: 24000,
      durationMs: 1000,
      transcriptDelta: 'Uma frase longa que vai ser interrompida.',
    })
    ctx.currentTime = 0.5
    const receipt = runtime.interruptOmniPlayback('t-barge', 'user_barge_in')
    expect(receipt).not.toBeNull()
    expect(sources[0]!.stop).toHaveBeenCalledTimes(1)
    expect(gains[0]!.gain.value).toBe(0)
    expect(runtime.getPlayer().isPlaying()).toBe(false)
  })

  it('playRuntimeTtsAudio:false keeps the runtime TTS registry output virtual-only', async () => {
    const { ctx, sources } = createFakeAudioContext()
    const runtime = createVoiceSessionRuntime({
      micMode: 'continuous',
      wakeWordEnabled: false,
      activeTtsProviderId: 'local-synth-fallback',
      playRuntimeTtsAudio: false,
    })
    runtime.attachAudioContext(ctx)
    await runtime.enqueueAssistantReply('Uma resposta curta.')
    expect(runtime.getSpeechPipeline().getScheduledChunks().length).toBeGreaterThan(0)
    expect(sources).toHaveLength(0)
  })

  it('re-attaching a new context realigns the timeline so playback starts "now"', () => {
    const first = createFakeAudioContext()
    const player = createGaplessAudioPlayer()
    player.scheduleChunk({ seq: 0, text: 'virtual', durationSec: 3, startTimeSec: 0, endTimeSec: 3 })
    player.advanceVirtualClockSec(3)

    first.ctx.currentTime = 0.2
    player.attachAudioContext(first.ctx)
    const item = player.scheduleChunk({ samples: new Float32Array(2400), sampleRate: 24000 })
    expect(item.playedOnAudioOutput).toBe(true)
    expect(item.startTimeSec).toBeCloseTo(0.2, 5)
    expect(first.sources[0]!.start).toHaveBeenCalledWith(item.startTimeSec)

    player.attachAudioContext(null)
    expect(player.hasAudioOutput()).toBe(false)
  })
})
