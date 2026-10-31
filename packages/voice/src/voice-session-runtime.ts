import { CONTROL_SENTINEL, type AshyStageSignal } from '@ashy/llm'
import {
  DEFAULT_VOICE_RUNTIME_SETTINGS,
  TTS_PROVIDER_IDS,
  type SttProviderId,
  type TtfaTelemetryRecord,
  type TtsProviderId,
  type VoiceFixtureId,
} from '@ashy/shared'
import {
  createAudioInputRingBuffer,
  createWakeWordSpotterState,
  type AudioInputRingBuffer,
  type HistoryLease,
  type PcmAudioBlock,
  type WakeWordSpotterState,
} from './audio-input'
import {
  computeVowelLipSyncFrames,
  createSttProviderRegistry,
  createTtsProviderRegistry,
  extractPcmFrameVowelWeights,
  type SttProviderRegistry,
  type TtsProviderRegistry,
  type VowelFrameEnvelope,
} from './providers'
import {
  createRealtimeSpeechPipeline,
  formatInterruptionControlNote,
  type PlaybackReceipt,
  type RealtimeSpeechPipeline,
  type ScheduledAudioChunk,
  type TtsSynthesisOutput,
} from './speech-pipeline'
import {
  createHybridSpeculativeRephrase,
  createHybridVoiceEndJudge,
  DEFAULT_WAKE_WORD_PHRASES,
  detectWakeWordInText,
  type SpeculativeRephraseFn,
  type VoiceEndJudgeFn,
} from './turn-intelligence'
import {
  createSpeechActivityTracker,
  createVoiceTurnController,
  type EndJudgeDecision,
  type SealedVoiceTurn,
  type SpeechActivityTracker,
  type VoiceTurnController,
  type VoiceTurnControllerState,
} from './turn-policy'
import { createHybridVadEngine, downsamplePcmFloat32, type VadEngine } from './vad-engine'
import {
  buildVoiceFixtureWavBytes,
  decodeOmniAudioDeltaToPcm,
  decodeWavToPcmBlocks,
  encodeWavPcm16,
  uint8ArrayToBase64,
} from './wav-codec'

export type VoiceMicMode = 'muted' | 'continuous' | 'ptt' | 'push-to-talk'
export type CanonicalVoiceMicMode = 'muted' | 'continuous' | 'ptt'

export function normalizeVoiceMicMode(mode: VoiceMicMode): CanonicalVoiceMicMode {
  if (mode === 'ptt' || mode === 'push-to-talk') {
    return 'ptt'
  }
  if (mode === 'muted') {
    return 'muted'
  }
  return 'continuous'
}

export interface MediaStreamTrackLike {
  stop(): void
  kind?: string
  enabled?: boolean
  readyState?: string
}

export interface MediaStreamLike {
  getTracks(): MediaStreamTrackLike[]
  getAudioTracks?(): MediaStreamTrackLike[]
}

export interface ScriptProcessorNodeLike {
  onaudioprocess:
    | ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void)
    | null
  connect(destination: unknown): void
  disconnect?(): void
}

export interface AudioWorkletNodeLike {
  port: {
    onmessage: ((event: { data: unknown }) => void) | null
    postMessage?(message: unknown): void
  }
  connect(destination: unknown): void
  disconnect?(): void
}

export interface CaptureAudioContextLike {
  sampleRate: number
  state?: 'suspended' | 'running' | 'closed'
  destination: unknown
  resume?(): Promise<void>
  close?(): Promise<void>
  createMediaStreamSource?(stream: MediaStreamLike): {
    connect(destination: unknown): void
    disconnect?(): void
  }
  createScriptProcessor?(
    bufferSize?: number,
    numberOfInputChannels?: number,
    numberOfOutputChannels?: number,
  ): ScriptProcessorNodeLike
  audioWorklet?: {
    addModule(moduleUrl: string): Promise<void>
  }
  createAudioWorkletNode?: (name: string) => AudioWorkletNodeLike
}

export interface StartMicrophoneCaptureOptions {
  deviceId?: string
  mediaDevices?: {
    getUserMedia(constraints: {
      audio: boolean | Record<string, unknown>
      video?: boolean
    }): Promise<MediaStreamLike>
  }
  audioContextFactory?: () => CaptureAudioContextLike
  onRmsLevel?: (rms: number) => void
  onPcmBlock?: (aecBlock: PcmAudioBlock, rawBlock: PcmAudioBlock) => void | Promise<void>
}

export interface WebAudioWorkletCaptureOptions {
  aecRingBuffer: AudioInputRingBuffer
  rawRingBuffer?: AudioInputRingBuffer
  wakeWordSpotter?: WakeWordSpotterState
  sampleRate?: number
  frameDurationMs?: number
  mediaStream?: unknown
  audioContext?: unknown
  onAecBlock?: (block: PcmAudioBlock) => void | Promise<void>
  onRawBlock?: (block: PcmAudioBlock) => void | Promise<void>
}

export interface WebAudioWorkletCapture {
  pushAecFrame(samplesOrBlock: Float32Array | PcmAudioBlock): PcmAudioBlock
  pushRawFrame(samplesOrBlock: Float32Array | PcmAudioBlock): PcmAudioBlock
  pushDualFrame(
    aecSamples: Float32Array | PcmAudioBlock,
    rawSamples?: Float32Array | PcmAudioBlock,
  ): {
    aecBlock: PcmAudioBlock
    rawBlock: PcmAudioBlock
  }
  startMicrophoneCapture(options?: StartMicrophoneCaptureOptions): Promise<void>
  stopMicrophoneCapture(): Promise<void>
  isCapturingMicrophone(): boolean
  getLastRmsLevel(): number
  start(): Promise<void>
  stop(): void
  reset(): void
  getState(): {
    isCapturing: boolean
    sampleRate: number
    frameDurationMs: number
    nextAecFrame: number
    nextRawFrame: number
    aecFramesPushed: number
    rawFramesPushed: number
  }
}

function toPcmBlock(
  samplesOrBlock: Float32Array | PcmAudioBlock,
  nextFrame: number,
  sampleRate: number,
): PcmAudioBlock {
  if (samplesOrBlock instanceof Float32Array) {
    const startFrame = nextFrame
    const endFrame = startFrame + samplesOrBlock.length
    const durationMs = (samplesOrBlock.length / sampleRate) * 1000
    return {
      startFrame,
      endFrame,
      sampleRate,
      durationMs,
      samples: samplesOrBlock,
    }
  }
  return samplesOrBlock
}

const WORKLET_PROCESSOR_SOURCE = `
class AshyMicCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('ashy-mic-capture-processor', AshyMicCaptureProcessor);
`

export function createWebAudioWorkletCapture(
  options: WebAudioWorkletCaptureOptions,
): WebAudioWorkletCapture {
  const sampleRate = options.sampleRate ?? 16000
  const frameDurationMs = options.frameDurationMs ?? 20
  const samplesPerFrame = Math.max(1, Math.round((sampleRate * frameDurationMs) / 1000))

  let isCapturing = false
  let capturingMicrophone = false
  let captureGenerationId = 0
  let lastRmsLevel = 0
  let nextAecFrame = 0
  let nextRawFrame = 0
  let aecFramesPushed = 0
  let rawFramesPushed = 0
  let lastPushedAecBlock: PcmAudioBlock | null = null
  let lastPushedRawBlock: PcmAudioBlock | null = null

  let activeStream: MediaStreamLike | null = null
  let activeCaptureContext: CaptureAudioContextLike | null = null
  let activeSourceNode: { disconnect?(): void } | null = null
  let activeProcessorNode: { disconnect?(): void; onaudioprocess?: unknown } | null = null
  let stagingSamples: number[] = []

  function pushAecFrame(samplesOrBlock: Float32Array | PcmAudioBlock): PcmAudioBlock {
    if (
      !(samplesOrBlock instanceof Float32Array) &&
      lastPushedAecBlock !== null &&
      samplesOrBlock === lastPushedAecBlock
    ) {
      return lastPushedAecBlock
    }
    const block = toPcmBlock(samplesOrBlock, nextAecFrame, sampleRate)
    nextAecFrame = block.endFrame
    aecFramesPushed += 1
    lastPushedAecBlock = block
    options.aecRingBuffer.push(block)
    void options.onAecBlock?.(block)
    return block
  }

  function pushRawFrame(samplesOrBlock: Float32Array | PcmAudioBlock): PcmAudioBlock {
    if (
      !(samplesOrBlock instanceof Float32Array) &&
      lastPushedRawBlock !== null &&
      samplesOrBlock === lastPushedRawBlock
    ) {
      return lastPushedRawBlock
    }
    const block = toPcmBlock(samplesOrBlock, nextRawFrame, sampleRate)
    nextRawFrame = block.endFrame
    rawFramesPushed += 1
    lastPushedRawBlock = block
    options.rawRingBuffer?.push(block)
    options.wakeWordSpotter?.pushRawAudio(block)
    void options.onRawBlock?.(block)
    return block
  }

  function pushDualFrame(
    aecSamples: Float32Array | PcmAudioBlock,
    rawSamples: Float32Array | PcmAudioBlock = aecSamples,
  ): { aecBlock: PcmAudioBlock; rawBlock: PcmAudioBlock } {
    const aecBlock = pushAecFrame(aecSamples)
    const rawBlock = pushRawFrame(rawSamples)
    return { aecBlock, rawBlock }
  }

  function cleanupSyncResources(): CaptureAudioContextLike | null {
    isCapturing = false
    capturingMicrophone = false
    lastRmsLevel = 0
    stagingSamples = []

    if (activeProcessorNode) {
      try {
        if ('onaudioprocess' in activeProcessorNode) {
          activeProcessorNode.onaudioprocess = null
        }
        activeProcessorNode.disconnect?.()
      } catch {
        // Ignore disconnect errors
      }
      activeProcessorNode = null
    }

    if (activeSourceNode) {
      try {
        activeSourceNode.disconnect?.()
      } catch {
        // Ignore disconnect errors
      }
      activeSourceNode = null
    }

    if (activeStream) {
      for (const track of activeStream.getTracks()) {
        try {
          track.stop()
        } catch {
          // Ignore track stop errors
        }
      }
      activeStream = null
    }

    const ctxToClose = activeCaptureContext
    activeCaptureContext = null
    return ctxToClose
  }

  async function cleanupCaptureResources(): Promise<void> {
    const ctxToClose = cleanupSyncResources()
    if (ctxToClose) {
      try {
        await ctxToClose.close?.()
      } catch {
        // Ignore close errors
      }
    }
  }

  function defaultAudioContextFactory(): CaptureAudioContextLike {
    const Ctor =
      (globalThis as unknown as { AudioContext?: new (opts?: { sampleRate?: number }) => CaptureAudioContextLike })
        .AudioContext ??
      (
        globalThis as unknown as {
          webkitAudioContext?: new (opts?: { sampleRate?: number }) => CaptureAudioContextLike
        }
      ).webkitAudioContext

    if (!Ctor) {
      throw new Error('AudioContext is not supported in this environment')
    }
    return new Ctor({ sampleRate })
  }

  async function startMicrophoneCapture(
    startOptions: StartMicrophoneCaptureOptions = {},
  ): Promise<void> {
    const myGen = ++captureGenerationId
    const prevCtx = cleanupSyncResources()
    if (prevCtx) {
      try {
        await prevCtx.close?.()
      } catch {
        // Ignore close errors
      }
      if (myGen !== captureGenerationId) {
        return
      }
    }

    const mediaDevices =
      startOptions.mediaDevices ??
      (
        globalThis.navigator as
          | { mediaDevices?: StartMicrophoneCaptureOptions['mediaDevices'] }
          | undefined
      )?.mediaDevices

    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      throw new Error(
        'Microphone capture unavailable: navigator.mediaDevices.getUserMedia is not available',
      )
    }

    const deviceId = startOptions.deviceId?.trim()
    const stream = await mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })

    // Red-Team H4: If stopMicrophoneCapture() or another startMicrophoneCapture() was called
    // while getUserMedia was awaiting, immediately stop tracks and abort without creating AudioContext!
    if (myGen !== captureGenerationId) {
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          // Ignore
        }
      }
      return
    }

    let audioCtx: CaptureAudioContextLike | null = null
    try {
      audioCtx = startOptions.audioContextFactory
        ? startOptions.audioContextFactory()
        : defaultAudioContextFactory()

      if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
        await audioCtx.resume()
        if (myGen !== captureGenerationId) {
          for (const track of stream.getTracks()) {
            try {
              track.stop()
            } catch {
              // Ignore
            }
          }
          await audioCtx.close?.()
          return
        }
      }
    } catch (err) {
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          // Ignore
        }
      }
      if (audioCtx) {
        try {
          await audioCtx.close?.()
        } catch {
          // Ignore
        }
      }
      throw err
    }

    activeStream = stream
    activeCaptureContext = audioCtx
    isCapturing = true
    capturingMicrophone = true
    stagingSamples = []

    const handleIncomingPcmSamples = (rawSamples: Float32Array): void => {
      if (myGen !== captureGenerationId || !capturingMicrophone) {
        return
      }
      const inputRate =
        Number.isFinite(audioCtx.sampleRate) && audioCtx.sampleRate > 0
          ? audioCtx.sampleRate
          : sampleRate
      const downsampled = downsamplePcmFloat32(rawSamples, inputRate, sampleRate)
      for (let i = 0; i < downsampled.length; i++) {
        stagingSamples.push(downsampled[i]!)
      }

      while (stagingSamples.length >= samplesPerFrame) {
        const chunkValues = stagingSamples.splice(0, samplesPerFrame)
        const chunk320 = new Float32Array(chunkValues)

        let sumSq = 0
        for (let i = 0; i < chunk320.length; i++) {
          const val = chunk320[i]!
          sumSq += val * val
        }
        const rms = Number(Math.sqrt(sumSq / chunk320.length).toFixed(6))
        lastRmsLevel = rms
        startOptions.onRmsLevel?.(rms)

        const { aecBlock, rawBlock } = pushDualFrame(chunk320, chunk320)
        void startOptions.onPcmBlock?.(aecBlock, rawBlock)
      }
    }

    const sourceNode = audioCtx.createMediaStreamSource?.(stream) ?? null
    activeSourceNode = sourceNode

    let attachedWorklet = false
    if (sourceNode && audioCtx.createAudioWorkletNode) {
      try {
        const workletNode = audioCtx.createAudioWorkletNode('ashy-mic-capture-processor')
        workletNode.port.onmessage = (event) => {
          if (event.data instanceof Float32Array) {
            handleIncomingPcmSamples(event.data)
          } else if (
            event.data &&
            typeof event.data === 'object' &&
            (event.data as { samples?: unknown }).samples instanceof Float32Array
          ) {
            handleIncomingPcmSamples((event.data as { samples: Float32Array }).samples)
          }
        }
        sourceNode.connect(workletNode)
        workletNode.connect(audioCtx.destination)
        activeProcessorNode = workletNode
        attachedWorklet = true
      } catch {
        attachedWorklet = false
      }
    } else if (
      sourceNode &&
      audioCtx.audioWorklet &&
      typeof audioCtx.audioWorklet.addModule === 'function' &&
      typeof (globalThis as unknown as { AudioWorkletNode?: unknown }).AudioWorkletNode ===
        'function' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function'
    ) {
      let blobUrl: string | null = null
      try {
        const blob = new Blob([WORKLET_PROCESSOR_SOURCE], { type: 'application/javascript' })
        blobUrl = URL.createObjectURL(blob)
        await audioCtx.audioWorklet.addModule(blobUrl)
        if (myGen !== captureGenerationId) {
          await cleanupCaptureResources()
          return
        }
        const WorkletNodeCtor = (
          globalThis as unknown as {
            AudioWorkletNode: new (
              ctx: unknown,
              name: string,
            ) => AudioWorkletNodeLike
          }
        ).AudioWorkletNode
        const workletNode = new WorkletNodeCtor(audioCtx, 'ashy-mic-capture-processor')
        workletNode.port.onmessage = (event) => {
          if (event.data instanceof Float32Array) {
            handleIncomingPcmSamples(event.data)
          }
        }
        sourceNode.connect(workletNode)
        workletNode.connect(audioCtx.destination)
        activeProcessorNode = workletNode
        attachedWorklet = true
      } catch {
        attachedWorklet = false
      } finally {
        if (blobUrl && typeof URL.revokeObjectURL === 'function') {
          try {
            URL.revokeObjectURL(blobUrl)
          } catch {
            // Ignore
          }
        }
      }
    }

    if (!attachedWorklet && sourceNode && typeof audioCtx.createScriptProcessor === 'function') {
      const scriptNode = audioCtx.createScriptProcessor(1024, 1, 1)
      scriptNode.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0)
        handleIncomingPcmSamples(new Float32Array(inputData))
      }
      sourceNode.connect(scriptNode)
      scriptNode.connect(audioCtx.destination)
      activeProcessorNode = scriptNode
    }
  }

  async function stopMicrophoneCapture(): Promise<void> {
    captureGenerationId += 1
    await cleanupCaptureResources()
  }

  return {
    pushAecFrame,
    pushRawFrame,
    pushDualFrame,
    startMicrophoneCapture,
    stopMicrophoneCapture,
    isCapturingMicrophone: () => capturingMicrophone,
    getLastRmsLevel: () => lastRmsLevel,
    async start(): Promise<void> {
      isCapturing = true
    },
    stop(): void {
      isCapturing = false
      if (capturingMicrophone) {
        void stopMicrophoneCapture()
      }
    },
    reset(): void {
      if (capturingMicrophone) {
        void stopMicrophoneCapture()
      }
      isCapturing = false
      capturingMicrophone = false
      lastRmsLevel = 0
      stagingSamples = []
      nextAecFrame = 0
      nextRawFrame = 0
      aecFramesPushed = 0
      rawFramesPushed = 0
      lastPushedAecBlock = null
      lastPushedRawBlock = null
    },
    getState() {
      return {
        isCapturing,
        sampleRate,
        frameDurationMs,
        nextAecFrame,
        nextRawFrame,
        aecFramesPushed,
        rawFramesPushed,
      }
    },
  }
}

export interface WebAudioContextLike {
  currentTime: number
  sampleRate?: number
  destination?: unknown
  createGain?: () => {
    gain: {
      value: number
      setValueAtTime?: (value: number, startTime: number) => void
      linearRampToValueAtTime?: (value: number, endTime: number) => void
    }
    connect?: (dest: unknown) => void
    disconnect?: () => void
  }
  createBuffer?: (
    numOfChannels: number,
    length: number,
    sampleRate: number,
  ) => {
    duration: number
    getChannelData: (channel: number) => Float32Array
  }
  createBufferSource?: () => {
    buffer: unknown
    connect?: (dest: unknown) => void
    start?: (when?: number) => void
    stop?: (when?: number) => void
    onended?: (() => void) | null
  }
}

export interface GaplessAudioPlayerOptions {
  audioContext?: WebAudioContextLike
  defaultFadeOutMs?: number
  onVowelFrame?: (frame: VowelFrameEnvelope) => void
  onQueueDrained?: () => void
  onPlaybackEnded?: () => void
}

export interface ScheduledPlaybackItem {
  seq: number
  text: string
  startTimeSec: number
  endTimeSec: number
  durationSec: number
  sampleRate: number
  samples: Float32Array
  vowelFrames: ReadonlyArray<VowelFrameEnvelope>
}

export interface GaplessAudioPlayer {
  scheduleChunk(
    chunk:
      | ScheduledAudioChunk
      | {
          seq?: number
          text?: string
          startTimeSec?: number
          endTimeSec?: number
          durationSec?: number
          durationMs?: number
          samples?: Float32Array
          sampleRate?: number
          vowelFrames?: ReadonlyArray<VowelFrameEnvelope>
          synthesisOutput?: TtsSynthesisOutput
        },
  ): ScheduledPlaybackItem
  markStreamComplete(complete?: boolean): void
  isStreamComplete(): boolean
  getCurrentTimeSec(): number
  setVirtualClockSec(timeSec: number): void
  advanceVirtualClockSec(deltaSec: number): void
  getActiveVowelFrame(atTimeSec?: number): VowelFrameEnvelope
  stopWithFade(fadeMs?: number): {
    stoppedAtSec: number
    fadeMs: number
    gainValueAfterFade: number
  }
  isPlaying(): boolean
  getGainValue(): number
  getScheduledItems(): readonly ScheduledPlaybackItem[]
  reset(): void
}

const ZERO_VOWELS: VowelFrameEnvelope = { A: 0, E: 0, I: 0, O: 0, U: 0 }

export function createGaplessAudioPlayer(
  options: GaplessAudioPlayerOptions = {},
): GaplessAudioPlayer {
  const defaultFadeOutMs = Math.max(0, options.defaultFadeOutMs ?? 100)
  const ctx = options.audioContext
  const gainNode = ctx?.createGain ? ctx.createGain() : null
  if (gainNode && ctx?.destination !== undefined) {
    gainNode.connect?.(ctx.destination)
  }

  const scheduledItems: ScheduledPlaybackItem[] = []
  const activeSourceNodes: Array<{ stop?: (when?: number) => void; onended?: (() => void) | null }> =
    []
  let virtualClockSec = 0
  let nextScheduledTimeSec = 0
  let gainValue = 1
  let playing = false
  let streamComplete = true
  let queueDrained = false
  let playbackEndedFired = false
  let nextFallbackSeq = 0

  function getCurrentTimeSec(): number {
    const ctxTime = ctx && Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0
    return Math.max(virtualClockSec, ctxTime)
  }

  function handleQueueDrained(): void {
    if (!queueDrained) {
      queueDrained = true
      options.onQueueDrained?.()
    }
    if (streamComplete && !playbackEndedFired) {
      playing = false
      playbackEndedFired = true
      options.onVowelFrame?.({ ...ZERO_VOWELS })
      options.onPlaybackEnded?.()
    }
  }

  function markStreamComplete(complete = true): void {
    streamComplete = Boolean(complete)
    if (!streamComplete) {
      playbackEndedFired = false
      return
    }
    if (scheduledItems.length > 0 && queueDrained && !playbackEndedFired) {
      playing = false
      playbackEndedFired = true
      options.onVowelFrame?.({ ...ZERO_VOWELS })
      options.onPlaybackEnded?.()
    }
  }

  function getActiveVowelFrame(atTimeSec = getCurrentTimeSec()): VowelFrameEnvelope {
    if (!playing || scheduledItems.length === 0) {
      return { ...ZERO_VOWELS }
    }

    const activeItem =
      scheduledItems.find(
        (item) => atTimeSec >= item.startTimeSec - 1e-6 && atTimeSec <= item.endTimeSec + 1e-6,
      ) ?? scheduledItems[scheduledItems.length - 1]!

    if (!activeItem || activeItem.vowelFrames.length === 0) {
      return { ...ZERO_VOWELS }
    }

    const relSec = Math.max(0, atTimeSec - activeItem.startTimeSec)
    const ratio =
      activeItem.durationSec > 0 ? Math.min(0.9999, relSec / activeItem.durationSec) : 0
    const frameIdx = Math.min(
      activeItem.vowelFrames.length - 1,
      Math.max(0, Math.floor(ratio * activeItem.vowelFrames.length)),
    )
    return { ...activeItem.vowelFrames[frameIdx]! }
  }

  function scheduleChunk(
    chunk:
      | ScheduledAudioChunk
      | {
          seq?: number
          text?: string
          startTimeSec?: number
          endTimeSec?: number
          durationSec?: number
          durationMs?: number
          samples?: Float32Array
          sampleRate?: number
          vowelFrames?: ReadonlyArray<VowelFrameEnvelope>
          synthesisOutput?: TtsSynthesisOutput
        },
  ): ScheduledPlaybackItem {
    const synth = chunk.synthesisOutput
    const sampleRate =
      (chunk as { sampleRate?: number }).sampleRate ?? synth?.sampleRate ?? ctx?.sampleRate ?? 16000
    const samples =
      (chunk as { samples?: Float32Array }).samples ??
      synth?.samples ??
      new Float32Array(Math.round(0.4 * sampleRate))

    const durationSec =
      typeof chunk.durationSec === 'number' && Number.isFinite(chunk.durationSec)
        ? chunk.durationSec
        : typeof chunk.durationMs === 'number' && Number.isFinite(chunk.durationMs)
          ? chunk.durationMs / 1000
          : typeof synth?.durationSec === 'number' && Number.isFinite(synth.durationSec)
            ? synth.durationSec
            : typeof synth?.durationMs === 'number' && Number.isFinite(synth.durationMs)
              ? synth.durationMs / 1000
              : samples.length / sampleRate

    const startTimeSec =
      typeof chunk.startTimeSec === 'number' && Number.isFinite(chunk.startTimeSec)
        ? chunk.startTimeSec
        : Math.max(getCurrentTimeSec(), nextScheduledTimeSec)
    const endTimeSec =
      typeof chunk.endTimeSec === 'number' && Number.isFinite(chunk.endTimeSec)
        ? chunk.endTimeSec
        : startTimeSec + durationSec

    const text = chunk.text ?? ''
    const vowelFrames =
      (chunk as { vowelFrames?: ReadonlyArray<VowelFrameEnvelope> }).vowelFrames ??
      synth?.vowelFrames ??
      computeVowelLipSyncFrames(text, Math.round(durationSec * 1000))

    const seq = typeof chunk.seq === 'number' ? chunk.seq : nextFallbackSeq++
    const item: ScheduledPlaybackItem = {
      seq,
      text,
      startTimeSec,
      endTimeSec,
      durationSec,
      sampleRate,
      samples,
      vowelFrames,
    }

    if (gainNode && gainValue === 0) {
      gainValue = 1
      gainNode.gain.value = 1
    } else if (gainValue === 0) {
      gainValue = 1
    }

    playing = true
    queueDrained = false
    playbackEndedFired = false
    nextScheduledTimeSec = Math.max(nextScheduledTimeSec, endTimeSec)
    scheduledItems.push(item)

    if (ctx?.createBuffer && ctx?.createBufferSource && samples.length > 0) {
      const audioBuffer = ctx.createBuffer(1, samples.length, sampleRate)
      const channelData = audioBuffer.getChannelData(0)
      if (channelData.length >= samples.length) {
        channelData.set(samples)
      }
      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      if (gainNode) {
        source.connect?.(gainNode)
      } else if (ctx.destination !== undefined) {
        source.connect?.(ctx.destination)
      }
      source.onended = () => {
        const idx = activeSourceNodes.indexOf(source)
        if (idx !== -1) {
          activeSourceNodes.splice(idx, 1)
        }
        if (!playing) {
          return
        }
        virtualClockSec = Math.max(virtualClockSec, item.endTimeSec)
        if (activeSourceNodes.length === 0 && getCurrentTimeSec() >= nextScheduledTimeSec - 1e-6) {
          handleQueueDrained()
        }
      }
      source.start?.(startTimeSec)
      activeSourceNodes.push(source)
    }

    options.onVowelFrame?.(getActiveVowelFrame(startTimeSec))
    return item
  }

  function setVirtualClockSec(timeSec: number): void {
    if (!Number.isFinite(timeSec) || timeSec < 0) return
    virtualClockSec = timeSec
    if (playing) {
      options.onVowelFrame?.(getActiveVowelFrame(getCurrentTimeSec()))
      if (virtualClockSec >= nextScheduledTimeSec && nextScheduledTimeSec > 0) {
        handleQueueDrained()
      }
    }
  }

  function advanceVirtualClockSec(deltaSec: number): void {
    if (!Number.isFinite(deltaSec) || deltaSec <= 0) return
    setVirtualClockSec(virtualClockSec + deltaSec)
  }

  function stopWithFade(fadeMs = defaultFadeOutMs): {
    stoppedAtSec: number
    fadeMs: number
    gainValueAfterFade: number
  } {
    const effectiveFadeMs = Math.max(0, Number.isFinite(fadeMs) ? fadeMs : defaultFadeOutMs)
    const stoppedAtSec = getCurrentTimeSec()
    const fadeEndTimeSec = stoppedAtSec + effectiveFadeMs / 1000

    if (gainNode) {
      gainNode.gain.setValueAtTime?.(gainValue, stoppedAtSec)
      gainNode.gain.linearRampToValueAtTime?.(0, fadeEndTimeSec)
      gainNode.gain.value = 0
    }

    for (const src of activeSourceNodes) {
      try {
        src.onended = null
        src.stop?.(fadeEndTimeSec)
      } catch {
        // Ignore already-stopped source nodes
      }
    }
    activeSourceNodes.length = 0

    gainValue = 0
    playing = false
    queueDrained = true
    options.onVowelFrame?.({ ...ZERO_VOWELS })

    return {
      stoppedAtSec,
      fadeMs: effectiveFadeMs,
      gainValueAfterFade: 0,
    }
  }

  function reset(): void {
    for (const src of activeSourceNodes) {
      try {
        src.onended = null
        src.stop?.(0)
      } catch {
        // Ignore
      }
    }
    activeSourceNodes.length = 0
    scheduledItems.length = 0
    virtualClockSec = 0
    nextScheduledTimeSec = 0
    gainValue = 1
    playing = false
    streamComplete = true
    queueDrained = false
    playbackEndedFired = false
    nextFallbackSeq = 0
  }

  return {
    scheduleChunk,
    markStreamComplete,
    isStreamComplete: () => streamComplete,
    getCurrentTimeSec,
    setVirtualClockSec,
    advanceVirtualClockSec,
    getActiveVowelFrame,
    stopWithFade,
    isPlaying: () => playing,
    getGainValue: () => gainValue,
    getScheduledItems: () => scheduledItems.slice(),
    reset,
  }
}

export interface TtsVowelLipSyncFrame extends VowelFrameEnvelope {
  offsetMs?: number
}

export interface SealedOmniAudioTurn {
  wavBytes: Uint8Array
  wavBase64: string
  mimeType: 'audio/wav'
  sampleRate: 16000
  durationMs: number
  rmsPeak: number
  preRollBlocksCount: number
  revision: number
  reason: 'vad-silence' | 'ptt-release' | 'manual'
  transcriptHint?: string
}

export interface VoiceSessionRuntimeOptions {
  micMode?: VoiceMicMode
  wakeWordEnabled?: boolean
  wakeWordPhrases?: readonly string[]
  activeSttProviderId?: SttProviderId
  activeTtsProviderId?: TtsProviderId
  vadEngine?: VadEngine
  sttRegistry?: SttProviderRegistry
  ttsRegistry?: TtsProviderRegistry
  endJudgeFn?: VoiceEndJudgeFn
  rephraseFn?: SpeculativeRephraseFn
  audioContext?: WebAudioContextLike
  bargeInMinSpeechMs?: number
  preRollMs?: number
  directOmniAudio?: boolean
  omniSilenceSealMs?: number
  onTurnSealed?: (turn: SealedVoiceTurn) => void
  onOmniAudioTurnReady?: (turn: SealedOmniAudioTurn) => void
  onBargeIn?: (
    receipt: PlaybackReceipt & {
      receipt?: PlaybackReceipt
      anchorFrame?: number | null
      preRollBlocksCount?: number
    },
  ) => void
  onStageSignal?: (signal: AshyStageSignal, afterChunkSeq: number) => void
  onVowelFrame?: (frame: VowelFrameEnvelope) => void
}

export interface VoiceSessionRuntimeSnapshot {
  micMode: CanonicalVoiceMicMode
  pushToTalkActive: boolean
  wakeWordEnabled: boolean
  wakeWordSessionOpen: boolean
  wakeWordDetectedCount: number
  lastWakeWordMatched: string | null
  activeSttProviderId: SttProviderId
  activeTtsProviderId: TtsProviderId
  directOmniAudio: boolean
  isPlayingAudio: boolean
  bargeInCount: number
  cancelledShortCount: number
  enteredGracePeriodCount: number
  lastEndJudgeDecision: EndJudgeDecision | null
  lastPlaybackReceipt: PlaybackReceipt | null
  lastBargeInLeaseAnchorFrame: number | null
  lastBargeInPreRollBlocksCount: number
  activeVowelFrame: VowelFrameEnvelope
  turnState: VoiceTurnControllerState
  sealedTurns: readonly SealedVoiceTurn[]
  sealedOmniAudioTurns: readonly SealedOmniAudioTurn[]
  ttfaByProvider: Record<TtsProviderId, TtfaTelemetryRecord>
}

export interface VoiceFixtureScenarioResult {
  fixtureId: VoiceFixtureId
  snapshot: VoiceSessionRuntimeSnapshot
}

export interface VoiceSessionRuntime {
  ingestPcmBlock(block: PcmAudioBlock, rawBlock?: PcmAudioBlock): Promise<void>
  ingestPcmBlocks(blocks: readonly PcmAudioBlock[]): Promise<void>
  ingestWavBytes(wavBytes: Uint8Array | ArrayBuffer): Promise<VoiceSessionRuntimeSnapshot>
  runFixtureScenario(fixtureId: VoiceFixtureId): Promise<VoiceFixtureScenarioResult>
  startMicrophoneCapture(options?: StartMicrophoneCaptureOptions): Promise<void>
  stopMicrophoneCapture(): Promise<void>
  isCapturingMicrophone(): boolean
  enqueueAssistantDelta(textDelta: string): void
  enqueueAssistantMarker(signal: AshyStageSignal): void
  flushAssistantReply(): Promise<void>
  enqueueAssistantReply(textWithSentinels: string, signals?: AshyStageSignal[]): Promise<void>
  triggerManualBargeIn(interruptAtMs?: number, cause?: string): PlaybackReceipt
  setMicMode(mode: VoiceMicMode): void
  getMicMode(): CanonicalVoiceMicMode
  setPushToTalkActive(active: boolean): Promise<SealedVoiceTurn | null>
  setWakeWordEnabled(enabled: boolean): void
  setActiveSttProvider(providerId: SttProviderId): void
  setActiveTtsProvider(providerId: TtsProviderId): void
  setDirectOmniAudio(enabled: boolean): void
  getDirectOmniAudio(): boolean
  ingestOmniAudioDelta(delta: {
    turnId: string
    seq: number
    audioBase64: string
    format: 'pcm16' | 'wav'
    sampleRate: number
    durationMs: number
    transcriptDelta?: string
    vowelFrames?: ReadonlyArray<TtsVowelLipSyncFrame>
  }): void
  interruptOmniPlayback(turnId: string, cause?: string): PlaybackReceipt | null
  computeOmniPlaybackReceipt(turnId: string, stoppedAtSec?: number): PlaybackReceipt | null
  getTtfaTelemetry(): Record<TtsProviderId, TtfaTelemetryRecord>
  recordTtfaSample(providerId: TtsProviderId, ttfaMs: number): TtfaTelemetryRecord
  getSpeechPipeline(): RealtimeSpeechPipeline
  getPlayer(): GaplessAudioPlayer
  getWorkletCapture(): WebAudioWorkletCapture
  getAecRingBuffer(): AudioInputRingBuffer
  getRawRingBuffer(): AudioInputRingBuffer
  getTurnController(): VoiceTurnController
  getActivityTracker(): SpeechActivityTracker
  getState(): VoiceSessionRuntimeSnapshot
  reset(): void
}

function createInitialTtfaMap(): Record<TtsProviderId, TtfaTelemetryRecord> {
  const map = {} as Record<TtsProviderId, TtfaTelemetryRecord>
  for (const id of TTS_PROVIDER_IDS) {
    map[id] = {
      providerId: id,
      lastTtfaMs: null,
      avgTtfaMs: null,
      sampleCount: 0,
      lastSynthesizedAt: null,
    }
  }
  return map
}

export function createVoiceSessionRuntime(
  options: VoiceSessionRuntimeOptions = {},
): VoiceSessionRuntime {
  let micMode: CanonicalVoiceMicMode = normalizeVoiceMicMode(options.micMode ?? 'continuous')
  let pushToTalkActive = false
  let wakeWordEnabled = options.wakeWordEnabled ?? false
  let wakeWordSessionOpen = !wakeWordEnabled
  let wakeWordDetectedCount = 0
  let lastWakeWordMatched: string | null = null
  const wakeWordPhrases = options.wakeWordPhrases ?? DEFAULT_WAKE_WORD_PHRASES

  let activeSttProviderId: SttProviderId =
    options.activeSttProviderId ?? DEFAULT_VOICE_RUNTIME_SETTINGS.activeSttProviderId
  let activeTtsProviderId: TtsProviderId =
    options.activeTtsProviderId ?? DEFAULT_VOICE_RUNTIME_SETTINGS.activeTtsProviderId

  const preRollMs = options.preRollMs ?? 360
  const bargeInMinSpeechMs = options.bargeInMinSpeechMs ?? 300

  const vadEngine = options.vadEngine ?? createHybridVadEngine()
  const sttRegistry = options.sttRegistry ?? createSttProviderRegistry()
  const ttsRegistry = options.ttsRegistry ?? createTtsProviderRegistry()
  const baseEndJudge = options.endJudgeFn ?? createHybridVoiceEndJudge()
  const rephraseFn = options.rephraseFn ?? createHybridSpeculativeRephrase()

  let lastEndJudgeDecision: EndJudgeDecision | null = null
  let enteredGracePeriodCount = 0
  let bargeInCount = 0
  let cancelledShortCount = 0
  let lastPlaybackReceipt: PlaybackReceipt | null = null
  let lastBargeInLeaseAnchorFrame: number | null = null
  let lastBargeInPreRollBlocksCount = 0
  let activeVowelFrame: VowelFrameEnvelope = { ...ZERO_VOWELS }
  const sealedTurns: SealedVoiceTurn[] = []
  const sealedOmniAudioTurns: SealedOmniAudioTurn[] = []
  const ttfaByProvider = createInitialTtfaMap()

  let directOmniAudio = options.directOmniAudio ?? false
  const omniSilenceSealMs = options.omniSilenceSealMs ?? 750
  let omniAccumulatedBlocks: PcmAudioBlock[] = []
  let omniPreRollBlocksCount = 0
  let omniSilenceAccumulatedMs = 0
  let omniRevision = 0
  let lastWavMetadataComment: string | undefined
  let activeOmniPlaybackTurnId: string | null = null
  interface OmniScheduledTranscriptEntry {
    turnId: string
    seq: number
    text: string
    startTimeSec: number
    endTimeSec: number
    durationMs: number
  }
  const omniScheduledEntries: OmniScheduledTranscriptEntry[] = []

  const aecRingBuffer = createAudioInputRingBuffer({ baseHistoryMs: Math.max(400, preRollMs) })
  const rawRingBuffer = createAudioInputRingBuffer({ baseHistoryMs: Math.max(400, preRollMs) })
  const wakeWordSpotter = createWakeWordSpotterState({
    resetAfterSilenceMs: 500,
    maxBacklogMs: 1000,
  })
  const workletCapture = createWebAudioWorkletCapture({
    aecRingBuffer,
    rawRingBuffer,
    wakeWordSpotter,
    sampleRate: 16000,
    frameDurationMs: 20,
    audioContext: options.audioContext,
  })

  const activityTracker = createSpeechActivityTracker({
    onsetThreshold: 0.6,
    sustainRatio: 0.3,
    minSpeechMs: bargeInMinSpeechMs,
  })

  const turnController = createVoiceTurnController({
    speculateAfterMs: 600,
    pauseMs: 1200,
    graceMs: 3000,
    rephraseFn: (raw, sig) => rephraseFn(raw, sig),
    endJudgeFn: async (transcript, sig) => {
      const decision = await baseEndJudge(transcript, sig)
      lastEndJudgeDecision = decision
      if (!decision.complete) {
        enteredGracePeriodCount += 1
      }
      return decision
    },
    onTurnSealed: (sealed) => {
      sealedTurns.push(sealed)
      if (wakeWordEnabled) {
        wakeWordSessionOpen = false
      }
      options.onTurnSealed?.(sealed)
    },
  })

  const player = createGaplessAudioPlayer({
    audioContext: options.audioContext,
    defaultFadeOutMs: 100,
    onVowelFrame: (frame) => {
      activeVowelFrame = frame
      options.onVowelFrame?.(frame)
    },
  })

  // Track in-flight TTS synthesis tasks and per-turn TTFA timing
  let currentReplyFirstEnqueueAtMs: number | null = null
  let currentReplyFirstAudioRecorded = false
  const pendingSynthesisPromises = new Set<Promise<unknown>>()

  function recordTtfaSample(providerId: TtsProviderId, ttfaMs: number): TtfaTelemetryRecord {
    const existing = ttfaByProvider[providerId]
    const clampedMs = Math.max(0, Math.round(Number.isFinite(ttfaMs) ? ttfaMs : 0))
    const nextCount = existing.sampleCount + 1
    const nextAvg =
      existing.avgTtfaMs === null
        ? clampedMs
        : Math.round((existing.avgTtfaMs * existing.sampleCount + clampedMs) / nextCount)

    const updated: TtfaTelemetryRecord = {
      providerId,
      lastTtfaMs: clampedMs,
      avgTtfaMs: nextAvg,
      sampleCount: nextCount,
      lastSynthesizedAt: Date.now(),
    }
    ttfaByProvider[providerId] = updated
    return updated
  }

  const speechPipeline = createRealtimeSpeechPipeline({
    stopFadeMs: 100,
    synthesizeFn: async (text, signal) => {
      const providerId = activeTtsProviderId
      const taskPromise = ttsRegistry.synthesize(providerId, {
        text,
        signal,
      })
      pendingSynthesisPromises.add(taskPromise)
      try {
        return await taskPromise
      } finally {
        pendingSynthesisPromises.delete(taskPromise)
      }
    },
    onAudioScheduled: (chunk) => {
      player.scheduleChunk(chunk)
      if (!currentReplyFirstAudioRecorded && currentReplyFirstEnqueueAtMs !== null) {
        currentReplyFirstAudioRecorded = true
        const measuredMs = Math.max(
          0,
          Math.round(performance.now() - currentReplyFirstEnqueueAtMs),
        )
        const providerId = chunk.synthesisOutput.providerId ?? activeTtsProviderId
        recordTtfaSample(providerId, measuredMs)
      }
    },
    onStageSignal: (signal, afterChunkSeq) => {
      options.onStageSignal?.(signal, afterChunkSeq)
    },
    onStopWithFade: (fadeMs) => {
      player.stopWithFade(fadeMs)
    },
  })

  async function waitForPendingSynthesis(): Promise<void> {
    while (pendingSynthesisPromises.size > 0) {
      await Promise.allSettled(Array.from(pendingSynthesisPromises))
    }
  }

  // Active utterance capture state
  let activeLease: HistoryLease | null = null
  let currentBurstBlocks: PcmAudioBlock[] = []
  let pttCapturedBlocks: PcmAudioBlock[] = []
  let accumulatedClauses: string[] = []
  let bargeInTriggeredInCurrentBurst = false

  function releaseActiveLease(): void {
    if (activeLease) {
      activeLease.release()
      activeLease = null
    }
  }

  async function transcribeBurstAndAppend(
    blocksToTranscribe: readonly PcmAudioBlock[],
  ): Promise<void> {
    if (blocksToTranscribe.length === 0) return
    const sttRes = await sttRegistry.transcribe(activeSttProviderId, {
      blocks: blocksToTranscribe,
      language: 'pt',
    })
    const clause = sttRes.text.trim()
    if (!clause) return

    if (wakeWordEnabled && !wakeWordSessionOpen) {
      const detection = detectWakeWordInText(clause, wakeWordPhrases)
      if (detection.detected) {
        wakeWordSessionOpen = true
        wakeWordDetectedCount += 1
        lastWakeWordMatched = detection.matchedPhrase
        activityTracker.openWithWakeWord()
      } else {
        return
      }
    }

    // If previous turn was already sealed, start fresh clause list
    if (turnController.getState().status === 'sealed') {
      accumulatedClauses = []
      turnController.reset()
    }

    accumulatedClauses.push(clause)
    const combinedRaw = accumulatedClauses.join(' ').replace(/\s{2,}/g, ' ').trim()
    turnController.updateTranscript(combinedRaw)
  }

  function emitBargeInCallback(receipt: PlaybackReceipt): void {
    const augmented = receipt as PlaybackReceipt & {
      receipt?: PlaybackReceipt
      anchorFrame?: number | null
      preRollBlocksCount?: number
    }
    Object.defineProperty(augmented, 'receipt', {
      value: receipt,
      enumerable: false,
      configurable: true,
    })
    Object.defineProperty(augmented, 'anchorFrame', {
      value: lastBargeInLeaseAnchorFrame,
      enumerable: false,
      configurable: true,
    })
    Object.defineProperty(augmented, 'preRollBlocksCount', {
      value: lastBargeInPreRollBlocksCount,
      enumerable: false,
      configurable: true,
    })
    options.onBargeIn?.(augmented)
  }

  function sealPendingOmniAudioTurn(
    reason: 'vad-silence' | 'ptt-release' | 'manual',
  ): SealedOmniAudioTurn | null {
    if (omniAccumulatedBlocks.length === 0) return null
    const blocks = omniAccumulatedBlocks.slice()
    const preRollCount = omniPreRollBlocksCount
    omniAccumulatedBlocks = []
    omniPreRollBlocksCount = 0
    omniSilenceAccumulatedMs = 0

    const totalSamples = blocks.reduce((acc, b) => acc + b.samples.length, 0)
    if (totalSamples === 0) return null
    const merged = new Float32Array(totalSamples)
    let offset = 0
    let rmsPeak = 0
    for (const b of blocks) {
      merged.set(b.samples, offset)
      offset += b.samples.length
      let sumSq = 0
      for (let i = 0; i < b.samples.length; i++) {
        const s = b.samples[i]!
        sumSq += s * s
      }
      const rms = b.samples.length > 0 ? Math.sqrt(sumSq / b.samples.length) : 0
      if (rms > rmsPeak) rmsPeak = rms
    }

    const wavBytes = encodeWavPcm16(
      merged,
      16000,
      lastWavMetadataComment ?? `ashy-omni-turn-rev-${omniRevision}`,
    )
    const wavBase64 = uint8ArrayToBase64(wavBytes)
    const durationMs = Math.round((totalSamples / 16000) * 1000)

    const sealedOmni: SealedOmniAudioTurn = {
      wavBytes,
      wavBase64,
      mimeType: 'audio/wav',
      sampleRate: 16000,
      durationMs,
      rmsPeak: Number(rmsPeak.toFixed(4)),
      preRollBlocksCount: preRollCount,
      revision: omniRevision,
      reason,
      ...(lastWavMetadataComment ? { transcriptHint: lastWavMetadataComment } : {}),
    }
    sealedOmniAudioTurns.push(sealedOmni)
    if (wakeWordEnabled) {
      wakeWordSessionOpen = false
    }
    options.onOmniAudioTurnReady?.(sealedOmni)
    return sealedOmni
  }

  function ingestOmniAudioDelta(delta: {
    turnId: string
    seq: number
    audioBase64: string
    format: 'pcm16' | 'wav'
    sampleRate: number
    durationMs: number
    transcriptDelta?: string
    vowelFrames?: ReadonlyArray<TtsVowelLipSyncFrame>
  }): void {
    if (activeOmniPlaybackTurnId !== delta.turnId) {
      activeOmniPlaybackTurnId = delta.turnId
      omniScheduledEntries.length = 0
      player.markStreamComplete(false)
    }

    const decoded = decodeOmniAudioDeltaToPcm(
      delta.audioBase64,
      delta.format,
      delta.sampleRate,
    )
    const durationMs =
      delta.durationMs > 0 ? delta.durationMs : Math.max(20, decoded.durationMs)
    const durationSec = durationMs / 1000

    let vowelFrames: ReadonlyArray<VowelFrameEnvelope> = delta.vowelFrames ?? []
    if (vowelFrames.length === 0 && decoded.samples.length > 0) {
      const frameSamples = Math.max(1, Math.floor(decoded.sampleRate * 0.02))
      const extracted: VowelFrameEnvelope[] = []
      for (let offset = 0; offset < decoded.samples.length; offset += frameSamples) {
        const slice = decoded.samples.subarray(
          offset,
          Math.min(decoded.samples.length, offset + frameSamples),
        )
        const weights = extractPcmFrameVowelWeights(slice, decoded.sampleRate)
        extracted.push({
          A: weights.A,
          E: weights.E,
          I: weights.I,
          O: weights.O,
          U: weights.U,
        })
      }
      vowelFrames = extracted
    }

    const scheduledItem = player.scheduleChunk({
      seq: delta.seq,
      text: delta.transcriptDelta ?? '',
      durationSec,
      durationMs,
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      vowelFrames,
    })

    omniScheduledEntries.push({
      turnId: delta.turnId,
      seq: delta.seq,
      text: delta.transcriptDelta ?? '',
      startTimeSec: scheduledItem.startTimeSec,
      endTimeSec: scheduledItem.endTimeSec,
      durationMs,
    })
  }

  function computeOmniPlaybackReceipt(
    turnId: string,
    stoppedAtSec = player.getCurrentTimeSec(),
    cause = 'user-barge-in',
  ): PlaybackReceipt | null {
    const entries = omniScheduledEntries.filter((e) => e.turnId === turnId)
    if (entries.length === 0) return null

    const heardParts: string[] = []
    const unheardParts: string[] = []
    let throughMs = 0

    for (const entry of entries) {
      const text = entry.text.trim()
      if (stoppedAtSec >= entry.endTimeSec - 0.005) {
        if (text) heardParts.push(text)
        throughMs += entry.durationMs
      } else if (stoppedAtSec <= entry.startTimeSec + 0.005) {
        if (text) unheardParts.push(text)
      } else {
        const ratio = Math.max(
          0,
          Math.min(
            1,
            (stoppedAtSec - entry.startTimeSec) /
              Math.max(0.001, entry.endTimeSec - entry.startTimeSec),
          ),
        )
        throughMs += Math.round(entry.durationMs * ratio)
        if (text) {
          const words = text.split(/\s+/)
          const splitIdx = Math.max(1, Math.round(words.length * ratio))
          const h = words.slice(0, splitIdx).join(' ')
          const u = words.slice(splitIdx).join(' ')
          if (h) heardParts.push(h)
          if (u) unheardParts.push(u)
        }
      }
    }

    const heardText = heardParts.join(' ').trim()
    const unheardText = unheardParts.join(' ').trim()
    const controlNote = `${formatInterruptionControlNote({
      throughMs,
      heardText,
      unheardText,
    })} [User interrupted speech at ${Math.round(throughMs)}ms]`

    return {
      cause,
      throughMs,
      fadeOutMs: 100,
      heardText,
      unheardText,
      heardChunks: heardParts,
      unheardChunks: unheardParts,
      controlNote,
    }
  }

  function interruptOmniPlayback(
    turnId: string,
    cause = 'user-barge-in',
  ): PlaybackReceipt | null {
    const fadeResult = player.stopWithFade(100)
    const receipt = computeOmniPlaybackReceipt(turnId, fadeResult.stoppedAtSec, cause)
    if (receipt) {
      bargeInCount += 1
      lastPlaybackReceipt = receipt
      emitBargeInCallback(receipt)
    }
    return receipt
  }

  function executeAutomaticBargeIn(): PlaybackReceipt {
    bargeInTriggeredInCurrentBurst = true
    bargeInCount += 1

    if (activeLease && aecRingBuffer.getBlocks().length > 0) {
      lastBargeInLeaseAnchorFrame = activeLease.anchorFrame
      const capturedPreRoll = aecRingBuffer.captureFrom(activeLease.anchorFrame)
      lastBargeInPreRollBlocksCount = capturedPreRoll.length
    }

    const currentPlaybackSec = player.getCurrentTimeSec()
    if (
      activeOmniPlaybackTurnId !== null &&
      omniScheduledEntries.some((e) => e.turnId === activeOmniPlaybackTurnId)
    ) {
      const fadeResult = player.stopWithFade(100)
      const omniReceipt = computeOmniPlaybackReceipt(
        activeOmniPlaybackTurnId,
        fadeResult.stoppedAtSec,
        'user-vad-barge-in',
      )
      if (omniReceipt) {
        lastPlaybackReceipt = omniReceipt
        emitBargeInCallback(omniReceipt)
        return omniReceipt
      }
    }

    const receipt = speechPipeline.interrupt('user-vad-barge-in', currentPlaybackSec)
    lastPlaybackReceipt = receipt
    emitBargeInCallback(receipt)
    return receipt
  }

  async function ingestPcmBlock(block: PcmAudioBlock, rawBlock?: PcmAudioBlock): Promise<void> {
    if (micMode === 'muted') {
      return
    }

    // Advance playback clock if Ashy is currently speaking
    if (player.isPlaying()) {
      const dtSec = block.durationMs / 1000
      player.advanceVirtualClockSec(dtSec)
      speechPipeline.advancePlaybackTo(player.getCurrentTimeSec())
    }

    if (micMode === 'ptt') {
      if (!pushToTalkActive) {
        return
      }
      const pushedAec = workletCapture.pushAecFrame(block)
      workletCapture.pushRawFrame(rawBlock ?? block)
      pttCapturedBlocks.push(pushedAec)
      if (directOmniAudio) {
        omniAccumulatedBlocks.push(pushedAec)
      }
      return
    }

    // Continuous mode: evaluate VAD on the incoming block first so HistoryLease
    // anchors at the exact frame preceding speech onset (e.g. 400ms = frame 6400 -> anchorFrame = 640)
    const assessment = await vadEngine.processBlock(block)
    const step = activityTracker.processFrame(assessment.probability, block.durationMs)

    if (step.action === 'start') {
      // Retain 360ms pre-roll BEFORE pushing the onset block into aecRingBuffer
      releaseActiveLease()
      activeLease = aecRingBuffer.retain(preRollMs)
      currentBurstBlocks = []
      bargeInTriggeredInCurrentBurst = false
      omniRevision += 1
      omniSilenceAccumulatedMs = 0

      if (directOmniAudio) {
        const preRollBlocks =
          aecRingBuffer.getBlocks().length > 0
            ? aecRingBuffer.captureFrom(activeLease.anchorFrame)
            : []
        if (omniAccumulatedBlocks.length === 0) {
          omniPreRollBlocksCount = Math.max(1, preRollBlocks.length)
          omniAccumulatedBlocks = [...preRollBlocks]
        } else {
          omniPreRollBlocksCount += preRollBlocks.length
          omniAccumulatedBlocks.push(...preRollBlocks)
        }
      }

      turnController.bumpSpeakerRevision()
    }

    const pushedAec = workletCapture.pushAecFrame(block)
    workletCapture.pushRawFrame(rawBlock ?? block)
    wakeWordSpotter.reportVad(step.isSpeaking, block.durationMs)

    if (step.isSpeaking) {
      currentBurstBlocks.push(pushedAec)
      if (directOmniAudio) {
        omniAccumulatedBlocks.push(pushedAec)
        omniSilenceAccumulatedMs = 0
      }

      // Check for automatic VAD barge-in once sustained speech reaches >= 300ms while Ashy is speaking
      if (
        player.isPlaying() &&
        !bargeInTriggeredInCurrentBurst &&
        step.speechMs >= bargeInMinSpeechMs
      ) {
        executeAutomaticBargeIn()
      }
      return
    }

    if (step.action === 'cancel' && step.reason === 'too-short') {
      cancelledShortCount += 1
      currentBurstBlocks = []
      if (directOmniAudio) {
        omniAccumulatedBlocks = []
        omniPreRollBlocksCount = 0
        omniSilenceAccumulatedMs = 0
      }
      releaseActiveLease()
      return
    }

    if (step.action === 'pause') {
      const burstToTranscribe = currentBurstBlocks.slice()
      currentBurstBlocks = []
      releaseActiveLease()
      if (directOmniAudio) {
        omniSilenceAccumulatedMs += block.durationMs
        const effectiveSealMs =
          omniRevision === 1 && lastWavMetadataComment?.includes('...')
            ? omniSilenceSealMs + 1500
            : omniSilenceSealMs
        if (omniSilenceAccumulatedMs >= effectiveSealMs) {
          sealPendingOmniAudioTurn('vad-silence')
        }
        return
      }
      await transcribeBurstAndAppend(burstToTranscribe)
      await turnController.advanceSilence(block.durationMs)
      return
    }

    if (directOmniAudio) {
      if (omniAccumulatedBlocks.length > 0) {
        omniSilenceAccumulatedMs += block.durationMs
        const effectiveSealMs =
          omniRevision === 1 && lastWavMetadataComment?.includes('...')
            ? omniSilenceSealMs + 1500
            : omniSilenceSealMs
        if (omniSilenceAccumulatedMs >= effectiveSealMs) {
          sealPendingOmniAudioTurn('vad-silence')
        }
      }
      return
    }

    // Idle silence frame
    if (
      turnController.getState().rawText.length > 0 &&
      turnController.getState().status !== 'sealed'
    ) {
      await turnController.advanceSilence(block.durationMs)
    }
  }

  async function ingestPcmBlocks(blocks: readonly PcmAudioBlock[]): Promise<void> {
    for (const block of blocks) {
      await ingestPcmBlock(block)
    }
  }

  async function ingestWavBytes(
    wavBytes: Uint8Array | ArrayBuffer,
  ): Promise<VoiceSessionRuntimeSnapshot> {
    const decoded = decodeWavToPcmBlocks(wavBytes, 20)
    lastWavMetadataComment = decoded.metadataComment ?? undefined
    await ingestPcmBlocks(decoded.blocks)
    return getState()
  }

  async function startMicrophoneCapture(
    startOptions: StartMicrophoneCaptureOptions = {},
  ): Promise<void> {
    if (micMode === 'muted') {
      micMode = 'continuous'
    }
    await workletCapture.startMicrophoneCapture({
      ...startOptions,
      onPcmBlock: async (aecBlock, rawBlock) => {
        await ingestPcmBlock(aecBlock, rawBlock)
        await startOptions.onPcmBlock?.(aecBlock, rawBlock)
      },
    })
  }

  async function stopMicrophoneCapture(): Promise<void> {
    await workletCapture.stopMicrophoneCapture()
  }

  function ensureReplyEnqueueStarted(): void {
    if (currentReplyFirstEnqueueAtMs === null) {
      currentReplyFirstEnqueueAtMs = performance.now()
      currentReplyFirstAudioRecorded = false
      player.markStreamComplete(false)
    }
  }

  function enqueueAssistantDelta(textDelta: string): void {
    ensureReplyEnqueueStarted()
    speechPipeline.enqueueDelta(textDelta)
  }

  function enqueueAssistantMarker(signal: AshyStageSignal): void {
    ensureReplyEnqueueStarted()
    speechPipeline.enqueue(CONTROL_SENTINEL, [signal], { flush: false })
  }

  async function flushAssistantReply(): Promise<void> {
    ensureReplyEnqueueStarted()
    speechPipeline.flush()
    await waitForPendingSynthesis()
    player.markStreamComplete(true)
    currentReplyFirstEnqueueAtMs = null
  }

  async function enqueueAssistantReply(
    textWithSentinels: string,
    signals: AshyStageSignal[] = [],
  ): Promise<void> {
    speechPipeline.reset()
    player.reset()
    player.markStreamComplete(false)
    currentReplyFirstEnqueueAtMs = performance.now()
    currentReplyFirstAudioRecorded = false
    speechPipeline.enqueue(textWithSentinels, signals, { flush: true })
    await waitForPendingSynthesis()
    player.markStreamComplete(true)
    currentReplyFirstEnqueueAtMs = null
  }

  function triggerManualBargeIn(
    interruptAtMs?: number,
    cause = 'user-barge-in',
  ): PlaybackReceipt {
    bargeInCount += 1
    const playbackSec =
      typeof interruptAtMs === 'number' && Number.isFinite(interruptAtMs)
        ? Math.max(0, interruptAtMs / 1000)
        : player.getCurrentTimeSec()
    player.setVirtualClockSec(playbackSec)
    if (
      activeOmniPlaybackTurnId !== null &&
      omniScheduledEntries.some((e) => e.turnId === activeOmniPlaybackTurnId)
    ) {
      player.stopWithFade(100)
      const omniReceipt = computeOmniPlaybackReceipt(activeOmniPlaybackTurnId, playbackSec, cause)
      if (omniReceipt) {
        lastPlaybackReceipt = omniReceipt
        emitBargeInCallback(omniReceipt)
        return omniReceipt
      }
    }
    const receipt = speechPipeline.interrupt(cause, playbackSec)
    lastPlaybackReceipt = receipt
    emitBargeInCallback(receipt)
    return receipt
  }

  function setMicMode(mode: VoiceMicMode): void {
    micMode = normalizeVoiceMicMode(mode)
    if (micMode === 'muted') {
      if (workletCapture.isCapturingMicrophone()) {
        void workletCapture.stopMicrophoneCapture()
      }
      pushToTalkActive = false
      pttCapturedBlocks = []
      currentBurstBlocks = []
      omniAccumulatedBlocks = []
      omniPreRollBlocksCount = 0
      omniSilenceAccumulatedMs = 0
      releaseActiveLease()
      aecRingBuffer.clear()
      rawRingBuffer.clear()
    }
  }

  async function setPushToTalkActive(active: boolean): Promise<SealedVoiceTurn | null> {
    const wasActive = pushToTalkActive
    pushToTalkActive = Boolean(active)

    if (pushToTalkActive && !wasActive) {
      pttCapturedBlocks = []
      if (directOmniAudio) {
        omniAccumulatedBlocks = []
        omniPreRollBlocksCount = 0
        omniSilenceAccumulatedMs = 0
        omniRevision += 1
      }
      if (turnController.getState().status === 'sealed') {
        accumulatedClauses = []
        turnController.reset()
      }
      return null
    }

    if (!pushToTalkActive && wasActive && micMode === 'ptt') {
      const blocksToFlush = pttCapturedBlocks.slice()
      pttCapturedBlocks = []
      if (directOmniAudio && omniAccumulatedBlocks.length > 0) {
        sealPendingOmniAudioTurn('ptt-release')
        return null
      }
      if (blocksToFlush.length > 0) {
        await transcribeBurstAndAppend(blocksToFlush)
      }
      if (turnController.getState().rawText.trim().length > 0) {
        return await turnController.sealTurn('manual')
      }
    }

    return null
  }

  function setWakeWordEnabled(enabled: boolean): void {
    wakeWordEnabled = Boolean(enabled)
    wakeWordSessionOpen = !wakeWordEnabled
  }

  function setActiveSttProvider(providerId: SttProviderId): void {
    sttRegistry.get(providerId)
    activeSttProviderId = providerId
  }

  function setActiveTtsProvider(providerId: TtsProviderId): void {
    ttsRegistry.get(providerId)
    activeTtsProviderId = providerId
  }

  function setDirectOmniAudio(enabled: boolean): void {
    directOmniAudio = Boolean(enabled)
    omniAccumulatedBlocks = []
    omniPreRollBlocksCount = 0
    omniSilenceAccumulatedMs = 0
  }

  function getTtfaTelemetry(): Record<TtsProviderId, TtfaTelemetryRecord> {
    const copy = {} as Record<TtsProviderId, TtfaTelemetryRecord>
    for (const id of TTS_PROVIDER_IDS) {
      copy[id] = { ...ttfaByProvider[id] }
    }
    return copy
  }

  function reset(): void {
    releaseActiveLease()
    currentBurstBlocks = []
    pttCapturedBlocks = []
    accumulatedClauses = []
    omniAccumulatedBlocks = []
    omniPreRollBlocksCount = 0
    omniSilenceAccumulatedMs = 0
    omniRevision = 0
    lastWavMetadataComment = undefined
    activeOmniPlaybackTurnId = null
    omniScheduledEntries.length = 0
    bargeInTriggeredInCurrentBurst = false
    pushToTalkActive = false
    wakeWordSessionOpen = !wakeWordEnabled
    lastEndJudgeDecision = null
    activeVowelFrame = { ...ZERO_VOWELS }
    workletCapture.reset()
    aecRingBuffer.clear()
    rawRingBuffer.clear()
    wakeWordSpotter.reset()
    activityTracker.reset()
    turnController.reset()
    speechPipeline.reset()
    player.reset()
  }

  async function runFixtureScenario(
    fixtureId: VoiceFixtureId,
  ): Promise<VoiceFixtureScenarioResult> {
    reset()
    const wavBytes = buildVoiceFixtureWavBytes(fixtureId)

    switch (fixtureId) {
      case 'thinking-pause-cas': {
        setMicMode('continuous')
        setWakeWordEnabled(false)
        await ingestWavBytes(wavBytes)
        break
      }
      case 'barge-in-interrupt': {
        setMicMode('continuous')
        setWakeWordEnabled(false)
        await enqueueAssistantReply(
          'Eu acho que esse, código precisa de uma refatoração completa agora mesmo.',
        )
        await ingestWavBytes(wavBytes)
        break
      }
      case 'keyboard-click-noise': {
        setMicMode('continuous')
        setWakeWordEnabled(false)
        await enqueueAssistantReply(
          'Continuo explicando a arquitetura sem ser interrompida por cliques de teclado.',
        )
        await ingestWavBytes(wavBytes)
        break
      }
      case 'wake-word-oi-ashy': {
        setMicMode('continuous')
        setWakeWordEnabled(true)
        await ingestWavBytes(wavBytes)
        break
      }
    }

    return {
      fixtureId,
      snapshot: getState(),
    }
  }

  function getState(): VoiceSessionRuntimeSnapshot {
    return {
      micMode,
      pushToTalkActive,
      wakeWordEnabled,
      wakeWordSessionOpen,
      wakeWordDetectedCount,
      lastWakeWordMatched,
      activeSttProviderId,
      activeTtsProviderId,
      directOmniAudio,
      isPlayingAudio: player.isPlaying(),
      bargeInCount,
      cancelledShortCount,
      enteredGracePeriodCount,
      lastEndJudgeDecision,
      lastPlaybackReceipt,
      lastBargeInLeaseAnchorFrame,
      lastBargeInPreRollBlocksCount,
      activeVowelFrame: { ...activeVowelFrame },
      turnState: turnController.getState(),
      sealedTurns: sealedTurns.slice(),
      sealedOmniAudioTurns: sealedOmniAudioTurns.slice(),
      ttfaByProvider: getTtfaTelemetry(),
    }
  }

  return {
    ingestPcmBlock,
    ingestPcmBlocks,
    ingestWavBytes,
    runFixtureScenario,
    startMicrophoneCapture,
    stopMicrophoneCapture,
    isCapturingMicrophone: () => workletCapture.isCapturingMicrophone(),
    enqueueAssistantDelta,
    enqueueAssistantMarker,
    flushAssistantReply,
    enqueueAssistantReply,
    triggerManualBargeIn,
    setMicMode,
    getMicMode: () => micMode,
    setPushToTalkActive,
    setWakeWordEnabled,
    setActiveSttProvider,
    setActiveTtsProvider,
    setDirectOmniAudio,
    getDirectOmniAudio: () => directOmniAudio,
    ingestOmniAudioDelta,
    interruptOmniPlayback,
    computeOmniPlaybackReceipt,
    getTtfaTelemetry,
    recordTtfaSample,
    getSpeechPipeline: () => speechPipeline,
    getPlayer: () => player,
    getWorkletCapture: () => workletCapture,
    getAecRingBuffer: () => aecRingBuffer,
    getRawRingBuffer: () => rawRingBuffer,
    getTurnController: () => turnController,
    getActivityTracker: () => activityTracker,
    getState,
    reset,
  }
}
