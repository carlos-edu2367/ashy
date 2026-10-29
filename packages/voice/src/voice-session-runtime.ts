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
  type SttProviderRegistry,
  type TtsProviderRegistry,
  type VowelFrameEnvelope,
} from './providers'
import {
  createRealtimeSpeechPipeline,
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
import { createHybridVadEngine, type VadEngine } from './vad-engine'
import { buildVoiceFixtureWavBytes, decodeWavToPcmBlocks } from './wav-codec'

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

export function createWebAudioWorkletCapture(
  options: WebAudioWorkletCaptureOptions,
): WebAudioWorkletCapture {
  const sampleRate = options.sampleRate ?? 16000
  const frameDurationMs = options.frameDurationMs ?? 20
  let isCapturing = false
  let nextAecFrame = 0
  let nextRawFrame = 0
  let aecFramesPushed = 0
  let rawFramesPushed = 0

  function pushAecFrame(samplesOrBlock: Float32Array | PcmAudioBlock): PcmAudioBlock {
    const block = toPcmBlock(samplesOrBlock, nextAecFrame, sampleRate)
    nextAecFrame = block.endFrame
    aecFramesPushed += 1
    options.aecRingBuffer.push(block)
    void options.onAecBlock?.(block)
    return block
  }

  function pushRawFrame(samplesOrBlock: Float32Array | PcmAudioBlock): PcmAudioBlock {
    const block = toPcmBlock(samplesOrBlock, nextRawFrame, sampleRate)
    nextRawFrame = block.endFrame
    rawFramesPushed += 1
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

  return {
    pushAecFrame,
    pushRawFrame,
    pushDualFrame,
    async start(): Promise<void> {
      isCapturing = true
    },
    stop(): void {
      isCapturing = false
    },
    reset(): void {
      isCapturing = false
      nextAecFrame = 0
      nextRawFrame = 0
      aecFramesPushed = 0
      rawFramesPushed = 0
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
  const activeSourceNodes: Array<{ stop?: (when?: number) => void }> = []
  let virtualClockSec = 0
  let nextScheduledTimeSec = 0
  let gainValue = 1
  let playing = false
  let nextFallbackSeq = 0

  function getCurrentTimeSec(): number {
    const ctxTime = ctx && Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0
    return Math.max(virtualClockSec, ctxTime)
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
        playing = false
        options.onPlaybackEnded?.()
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
        src.stop?.(fadeEndTimeSec)
      } catch {
        // Ignore already-stopped source nodes
      }
    }
    activeSourceNodes.length = 0

    gainValue = 0
    playing = false
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
    nextFallbackSeq = 0
  }

  return {
    scheduleChunk,
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
  onTurnSealed?: (turn: SealedVoiceTurn) => void
  onBargeIn?: (receipt: PlaybackReceipt) => void
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
  const ttfaByProvider = createInitialTtfaMap()

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

  async function transcribeBurstAndAppend(blocksToTranscribe: readonly PcmAudioBlock[]): Promise<void> {
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

  function executeAutomaticBargeIn(): PlaybackReceipt {
    bargeInTriggeredInCurrentBurst = true
    bargeInCount += 1

    if (activeLease) {
      lastBargeInLeaseAnchorFrame = activeLease.anchorFrame
      const capturedPreRoll = aecRingBuffer.captureFrom(activeLease.anchorFrame)
      lastBargeInPreRollBlocksCount = capturedPreRoll.length
    }

    const currentPlaybackSec = player.getCurrentTimeSec()
    const receipt = speechPipeline.interrupt('user-vad-barge-in', currentPlaybackSec)
    lastPlaybackReceipt = receipt
    options.onBargeIn?.(receipt)
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

      // If user resumes speaking while in the +3000ms grace period after an incomplete pause,
      // exercise CAS protection by superseding an in-flight boundary judge with the new speaker revision
      if (turnController.getState().inGracePeriod) {
        turnController.bumpSpeakerRevision()
        const inFlightJudge = turnController.advanceSilence(1200)
        turnController.bumpSpeakerRevision()
        await inFlightJudge
      } else {
        turnController.bumpSpeakerRevision()
      }
    }

    const pushedAec = workletCapture.pushAecFrame(block)
    workletCapture.pushRawFrame(rawBlock ?? block)
    wakeWordSpotter.reportVad(step.isSpeaking, block.durationMs)

    if (step.isSpeaking) {
      currentBurstBlocks.push(pushedAec)

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
      releaseActiveLease()
      return
    }

    if (step.action === 'pause') {
      const burstToTranscribe = currentBurstBlocks.slice()
      currentBurstBlocks = []
      await transcribeBurstAndAppend(burstToTranscribe)
      releaseActiveLease()
      await turnController.advanceSilence(block.durationMs)
      return
    }

    // Idle silence frame
    if (turnController.getState().rawText.length > 0 && turnController.getState().status !== 'sealed') {
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
    await ingestPcmBlocks(decoded.blocks)
    return getState()
  }

  function ensureReplyEnqueueStarted(): void {
    if (currentReplyFirstEnqueueAtMs === null) {
      currentReplyFirstEnqueueAtMs = performance.now()
      currentReplyFirstAudioRecorded = false
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
    currentReplyFirstEnqueueAtMs = null
  }

  async function enqueueAssistantReply(
    textWithSentinels: string,
    signals: AshyStageSignal[] = [],
  ): Promise<void> {
    speechPipeline.reset()
    player.reset()
    currentReplyFirstEnqueueAtMs = performance.now()
    currentReplyFirstAudioRecorded = false
    speechPipeline.enqueue(textWithSentinels, signals, { flush: true })
    await waitForPendingSynthesis()
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
    const receipt = speechPipeline.interrupt(cause, playbackSec)
    lastPlaybackReceipt = receipt
    options.onBargeIn?.(receipt)
    return receipt
  }

  function setMicMode(mode: VoiceMicMode): void {
    micMode = normalizeVoiceMicMode(mode)
    if (micMode === 'muted') {
      pushToTalkActive = false
      pttCapturedBlocks = []
      currentBurstBlocks = []
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
      if (turnController.getState().status === 'sealed') {
        accumulatedClauses = []
        turnController.reset()
      }
      return null
    }

    if (!pushToTalkActive && wasActive && micMode === 'ptt') {
      const blocksToFlush = pttCapturedBlocks.slice()
      pttCapturedBlocks = []
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
      ttfaByProvider: getTtfaTelemetry(),
    }
  }

  return {
    ingestPcmBlock,
    ingestPcmBlocks,
    ingestWavBytes,
    runFixtureScenario,
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
