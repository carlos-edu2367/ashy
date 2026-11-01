/**
 * Phase 10.1 — CallEngine (spec §6): owns one live call inside the hidden `call-engine` renderer.
 *
 * capture (worklet @16 kHz → ring buffer with pre-roll) → TurnDetector (Silero / DSP fallback)
 *   → transcribed: WAV of the turn → host.transcribe → host.buildContext → session.submitUserText
 *   → audio-direct (experimental): session.pushAudio from onset (+pre-roll) → commitUserTurn → respond
 * session deltas → GaplessAudioPlayer (+ viseme frames from the PCM actually played)
 * ledger (text + played ms per response) → host.recordTurn (only what was heard)
 *
 * The engine knows no backend: it only reads `session.caps`. Every browser API is injected.
 */
import {
  type CallCaption,
  type CallEndReason,
  type CallMetrics,
  type CallStatus,
  type CallVisemeFrame,
  type LiveModeSettings,
  formatTranscribedUserTurn,
} from '@ashy/shared'
import { createAudioInputRingBuffer, type AudioInputRingBuffer, type HistoryLease, type PcmAudioBlock } from '../audio-input'
import {
  createGaplessAudioPlayer,
  createWebAudioWorkletCapture,
  type CaptureAudioContextLike,
  type GaplessAudioPlayer,
  type StartMicrophoneCaptureOptions,
  type WebAudioContextLike,
  type WebAudioWorkletCapture,
} from '../voice-session-runtime'
import { encodePcmBlocksToWav, uint8ArrayToBase64 } from '../wav-codec'
import {
  createInitialCallMachineState,
  transitionCall,
  type CallMachineEvent,
  type CallMachineState,
} from './call-state-machine'
import {
  computePcmVisemeFrames,
  float32ToInt16,
  int16ToFloat32,
  resampleFloat32,
  sliceSpokenText,
  VISEME_FRAME_MS,
  ZERO_VISEME,
} from './pcm-utils'
import { createTurnDetector, type TurnDetector, type TurnDetectorEvent, type TurnDetectorOptions } from './turn-detector'
import {
  createDefaultCallTimers,
  defaultNow,
  type CallEngineHost,
  type CallTimers,
  type VoiceSession,
  type VoiceSessionEventMap,
} from './types'

const CAPTURE_RATE = 16000
const BARGE_IN_FADE_MS = 120
const VISEME_INTERVAL_MS = 33
const CAPTION_THROTTLE_MS = 100

export interface CallEngineOptions {
  callId: string
  settings: LiveModeSettings
  host: CallEngineHost
  /** Creates the backend session (called again on reconnect). */
  createSession: () => VoiceSession
  /** getUserMedia provider (default: navigator.mediaDevices). */
  mediaDevices?: StartMicrophoneCaptureOptions['mediaDevices']
  /** AudioContext factory for capture (default: global AudioContext @16 kHz). */
  captureAudioContextFactory?: () => CaptureAudioContextLike
  /** Playback AudioContext (default: `new AudioContext()`); null = virtual clock only. */
  playbackAudioContext?: WebAudioContextLike | null | (() => WebAudioContextLike | null)
  /** Override the detector (tests); otherwise built from settings.turn. */
  detector?: TurnDetector
  vadModelUrl?: string
  detectorOptions?: Partial<Omit<TurnDetectorOptions, 'turn'>>
  now?: () => number
  timers?: CallTimers
  maxReconnectAttempts?: number
  transcribeLanguage?: string
  onSnapshot?: (snapshot: CallEngineSnapshot) => void
  onLog?: (message: string, data?: unknown) => void
}

export interface CallEngineSnapshot {
  callId: string
  status: CallStatus
  muted: boolean
  reason: CallEndReason | null
  detail: string | null
  caption: CallCaption | null
  metrics: CallMetrics | null
  vadMode: 'silero-onnx' | 'hybrid-dsp'
}

export interface CallEngine {
  start(): Promise<CallStatus>
  stop(reason?: CallEndReason, detail?: string): Promise<void>
  setMuted(muted: boolean): void
  getStatus(): CallStatus
  getSnapshot(): CallEngineSnapshot
}

interface LedgerChunk {
  startSec: number
  durationSec: number
  frames: CallVisemeFrame[]
}

interface ResponseLedger {
  itemId: string | null
  userTranscript: string
  userTranscriptPromise: Promise<string> | null
  text: string
  chunks: LedgerChunk[]
  totalAudioMs: number
  done: boolean
  finalized: boolean
  metrics: CallMetrics
  speechEndAt: number
  responseRequestedAt: number
  firstAudioAt: number | null
  safetyTimer: unknown
}

interface ActiveTurn {
  seq: number
  onsetFrame: number
  lease: HistoryLease | null
}

const MARKER_RE = /<\|[^|>]*\|>/g
function stripMarkers(text: string): string {
  return text.replace(MARKER_RE, '').replace(/\s{2,}/g, ' ')
}

function classifyCaptureError(err: unknown): CallEndReason {
  const name = (err as { name?: unknown } | null)?.name
  const msg = String((err as { message?: unknown } | null)?.message ?? err)
  if (name === 'NotAllowedError' || name === 'SecurityError' || /denied|permission/i.test(msg)) return 'mic_denied'
  return 'mic_lost'
}

export function createCallEngine(options: CallEngineOptions): CallEngine {
  const { callId, settings, host } = options
  const now = options.now ?? defaultNow
  const timers = options.timers ?? createDefaultCallTimers()
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 2
  const language = options.transcribeLanguage ?? 'pt'
  const inputMode = settings.llamacpp.inputMode
  const turnCfg = settings.turn
  const interruptCfg = settings.interrupt
  const log = options.onLog ?? (() => {})

  let machine: CallMachineState = createInitialCallMachineState()
  let muted = false
  let stopped = false
  let caption: CallCaption | null = null
  let metrics: CallMetrics | null = null
  let detail: string | null = null

  // ── capture ──
  const ring: AudioInputRingBuffer = createAudioInputRingBuffer({
    baseHistoryMs: turnCfg.preRollMs + Math.max(turnCfg.minSpeechMs, interruptCfg.bargeInMinMs * 2) + 1500,
  })
  const capture: WebAudioWorkletCapture = createWebAudioWorkletCapture({
    aecRingBuffer: ring,
    sampleRate: CAPTURE_RATE,
    frameDurationMs: 20,
  })
  const detector: TurnDetector =
    options.detector ??
    createTurnDetector({
      turn: turnCfg,
      modelUrl: options.vadModelUrl,
      ...(options.detectorOptions ?? {}),
    })
  let blockChain: Promise<void> = Promise.resolve()

  // ── playback ──
  let playbackCtx: WebAudioContextLike | null = null
  let ownsPlaybackCtx = false
  const player: GaplessAudioPlayer = createGaplessAudioPlayer({
    defaultFadeOutMs: BARGE_IN_FADE_MS,
    onPlaybackEnded: () => onPlayerEnded(),
  })

  // ── session ──
  let session: VoiceSession | null = null
  let sessionUnsubs: Array<() => void> = []
  let instructions = ''

  // ── turn / ledger ──
  let turnSeq = 0
  let turn: ActiveTurn | null = null
  let streamingAudioDirect = false
  let ledger: ResponseLedger | null = null
  let interruptedAfterText: string | undefined
  let speakingStartedAt = 0
  /** Onset of user speech heard during playback (hands the floor over if playback ends first). */
  let playbackSpeechOnsetFrame: number | null = null
  let falseInterruptTimer: unknown = null
  let reconnectTimer: unknown = null

  // ── visemes / captions ──
  let visemeTimer: unknown = null
  let lastVisemeAt = -Infinity
  let lastVisemeWasZero = true
  let lastCaptionReportAt = -Infinity
  let captionTimer: unknown = null

  // ───────────────────────── state reporting ─────────────────────────

  function snapshot(): CallEngineSnapshot {
    return {
      callId,
      status: machine.status,
      muted,
      reason: machine.reason,
      detail,
      caption,
      metrics,
      vadMode: detector.getEngineMode(),
    }
  }

  function report(): void {
    if (captionTimer !== null) {
      timers.clearTimeout(captionTimer)
      captionTimer = null
    }
    lastCaptionReportAt = now()
    const snap = snapshot()
    options.onSnapshot?.(snap)
    try {
      const res = host.reportState({
        callId,
        status: snap.status,
        caption: snap.caption,
        metrics: snap.metrics,
        reason: snap.reason,
        detail: snap.detail ? snap.detail.slice(0, 1000) : null,
      })
      if (res && typeof (res as Promise<unknown>).catch === 'function') (res as Promise<unknown>).catch(() => {})
    } catch {
      // reporting never breaks the call
    }
  }

  /** Partial captions are throttled; everything else reports immediately. */
  function reportCaptionThrottled(): void {
    const elapsed = now() - lastCaptionReportAt
    if (elapsed >= CAPTION_THROTTLE_MS) {
      report()
      return
    }
    if (captionTimer === null) {
      captionTimer = timers.setTimeout(() => {
        captionTimer = null
        if (!stopped) report()
      }, CAPTION_THROTTLE_MS - elapsed)
    }
  }

  function dispatch(event: CallMachineEvent): boolean {
    const next = transitionCall(machine, event)
    if (next === machine) return false
    machine = next
    report()
    return true
  }

  // ───────────────────────── visemes ─────────────────────────

  function sendViseme(frame: CallVisemeFrame): void {
    const isZero = frame.volume === 0 && frame.A === 0 && frame.E === 0 && frame.I === 0 && frame.O === 0 && frame.U === 0
    if (isZero && lastVisemeWasZero) return
    const t = now()
    if (!isZero && t - lastVisemeAt < VISEME_INTERVAL_MS - 3) return
    lastVisemeAt = t
    lastVisemeWasZero = isZero
    try {
      const res = host.reportViseme({ ...frame })
      if (res && typeof (res as Promise<unknown>).catch === 'function') (res as Promise<unknown>).catch(() => {})
    } catch {
      // ignore
    }
  }

  function currentVisemeFrame(): CallVisemeFrame {
    if (!ledger || !player.isPlaying()) return { ...ZERO_VISEME }
    const t = player.getCurrentTimeSec()
    for (const c of ledger.chunks) {
      if (t >= c.startSec && t < c.startSec + c.durationSec) {
        const idx = Math.min(c.frames.length - 1, Math.floor(((t - c.startSec) * 1000) / VISEME_FRAME_MS))
        return c.frames[idx] ? { ...c.frames[idx]! } : { ...ZERO_VISEME }
      }
    }
    return { ...ZERO_VISEME }
  }

  function startVisemeTicker(): void {
    if (visemeTimer !== null) return
    visemeTimer = timers.setInterval(() => {
      if (stopped) return
      sendViseme(currentVisemeFrame())
    }, VISEME_INTERVAL_MS)
  }

  function stopVisemeTicker(): void {
    if (visemeTimer !== null) {
      timers.clearInterval(visemeTimer)
      visemeTimer = null
    }
    sendViseme({ ...ZERO_VISEME })
  }

  // ───────────────────────── ledger ─────────────────────────

  function playedMsOf(l: ResponseLedger): number {
    const t = player.getCurrentTimeSec()
    let ms = 0
    for (const c of l.chunks) {
      ms += Math.max(0, Math.min(c.durationSec, t - c.startSec)) * 1000
    }
    return Math.min(l.totalAudioMs, ms)
  }

  function clearLedgerTimers(l: ResponseLedger): void {
    if (l.safetyTimer !== null) {
      timers.clearTimeout(l.safetyTimer)
      l.safetyTimer = null
    }
  }

  async function finalizeLedger(
    l: ResponseLedger,
    outcome: { interrupted: boolean; playedMs: number; spokenOverride?: string },
  ): Promise<void> {
    if (l.finalized) return
    l.finalized = true
    clearLedgerTimers(l)
    const fullText = stripMarkers(l.text).trim()
    const spoken =
      outcome.spokenOverride ??
      (outcome.playedMs >= l.totalAudioMs - 1 && l.totalAudioMs > 0
        ? fullText
        : sliceSpokenText(fullText, outcome.playedMs, l.totalAudioMs))
    const userTranscript = l.userTranscriptPromise ? await l.userTranscriptPromise.catch(() => '') : l.userTranscript
    try {
      await host.recordTurn({
        callId,
        userTranscript: userTranscript.slice(0, 8000),
        assistantSpokenText: spoken.slice(0, 16000),
        assistantFullText: fullText.slice(0, 16000),
        interrupted: outcome.interrupted,
        playedMs: Math.round(outcome.playedMs),
        metrics: { ...l.metrics },
      })
    } catch (err) {
      log('recordTurn failed', err)
    }
  }

  function onPlayerEnded(): void {
    const l = ledger
    if (!l || !l.done || l.finalized) return
    completeNaturally(l)
  }

  function completeNaturally(l: ResponseLedger): void {
    if (l.finalized) return
    void finalizeLedger(l, { interrupted: false, playedMs: l.totalAudioMs })
    if (ledger === l) ledger = null
    stopVisemeTicker()
    caption = { role: 'assistant', text: stripMarkers(l.text).trim().slice(0, 4000), final: true }
    dispatch({ type: 'queue_drained' })
    // The user started talking near the end of playback: give them the floor right away.
    if (machine.status === 'listening' && !muted && playbackSpeechOnsetFrame !== null && detector.isInSpeech()) {
      const onset = playbackSpeechOnsetFrame
      playbackSpeechOnsetFrame = null
      dispatch({ type: 'speech_confirmed' })
      beginTurn(onset)
    }
  }

  // ───────────────────────── turns ─────────────────────────

  function releaseTurnLease(): void {
    if (turn?.lease) {
      turn.lease.release()
      turn.lease = null
    }
  }

  function latestFrame(): number {
    const blocks = ring.getBlocks()
    return blocks.length > 0 ? blocks[blocks.length - 1]!.endFrame : 0
  }

  function beginTurn(onsetFrame: number, opts: { merge?: boolean } = {}): void {
    if (opts.merge && turn) {
      turn.seq = ++turnSeq
    } else {
      releaseTurnLease()
      const heldMs = turnCfg.preRollMs + ((latestFrame() - onsetFrame) / CAPTURE_RATE) * 1000 + 100
      turn = { seq: ++turnSeq, onsetFrame, lease: ring.retain(Math.max(0, heldMs)) }
    }
    if (inputMode === 'audio-direct') {
      streamingAudioDirect = true
      for (const block of turnBlocks(turn.onsetFrame)) pushAudioDirect(block)
    }
  }

  function abandonTurn(): void {
    releaseTurnLease()
    turn = null
    streamingAudioDirect = false
    turnSeq += 1
  }

  function turnBlocks(onsetFrame: number, endFrame?: number): PcmAudioBlock[] {
    const blocks = ring.getBlocks()
    if (blocks.length === 0) return []
    const preRollFrames = Math.round((turnCfg.preRollMs / 1000) * CAPTURE_RATE)
    const from = Math.max(blocks[0]!.startFrame, onsetFrame - preRollFrames)
    let out: PcmAudioBlock[]
    try {
      out = ring.captureFrom(from)
    } catch {
      out = blocks.slice()
    }
    if (endFrame !== undefined) out = out.filter((b) => b.startFrame < endFrame)
    return out
  }

  function pushAudioDirect(block: PcmAudioBlock): void {
    const s = session
    if (!s) return
    const rate = s.caps.inputSampleRate || CAPTURE_RATE
    const samples = rate === block.sampleRate ? block.samples : resampleFloat32(block.samples, block.sampleRate, rate)
    s.pushAudio(float32ToInt16(samples))
  }

  function cancelInFlightResponse(): void {
    const l = ledger
    ledger = null
    if (l) {
      clearLedgerTimers(l)
      l.finalized = true // nothing played → nothing saved
    }
    session?.cancelResponse('client')
    player.stopWithFade(0)
    stopVisemeTicker()
  }

  function newLedger(userTranscript: string, speechEndAt: number, turnMetrics: CallMetrics): ResponseLedger {
    return {
      itemId: null,
      userTranscript,
      userTranscriptPromise: null,
      text: '',
      chunks: [],
      totalAudioMs: 0,
      done: false,
      finalized: false,
      metrics: turnMetrics,
      speechEndAt,
      responseRequestedAt: now(),
      firstAudioAt: null,
      safetyTimer: null,
    }
  }

  async function transcribeBlocks(blocks: PcmAudioBlock[]): Promise<{ text: string; asrMs: number }> {
    const wav = encodePcmBlocksToWav(blocks)
    const t0 = now()
    const res = await host.transcribe({ callId, audioWavBase64: uint8ArrayToBase64(wav), language })
    return { text: (res?.text ?? '').trim(), asrMs: Math.round(now() - t0) }
  }

  async function buildTurnContext(userText?: string): Promise<{ context: string; userLabel?: string }> {
    try {
      const ctx = await host.buildContext({
        callId,
        ...(userText ? { userText } : {}),
        ...(interruptedAfterText ? { interruptedAfterText } : {}),
      })
      return {
        context: ctx?.perTurnContext ?? '',
        ...(ctx?.userLabel ? { userLabel: ctx.userLabel } : {}),
      }
    } catch (err) {
      log('buildContext failed; continuing without context', err)
      return { context: '' }
    }
  }

  async function commitTurn(ev: Extract<TurnDetectorEvent, { type: 'speech_end' }>): Promise<void> {
    const t = turn
    if (!t) return
    const seq = t.seq
    const commitAt = now()
    const speechEndAt = commitAt - ev.silenceMs
    const turnMetrics: CallMetrics = { endpointMs: Math.round(ev.silenceMs) }
    metrics = { ...turnMetrics }
    caption = null
    dispatch({ type: 'turn_end' })
    const superseded = () => stopped || turnSeq !== seq || machine.status !== 'thinking'

    if (inputMode === 'audio-direct') {
      streamingAudioDirect = false
      const blocks = turnBlocks(t.onsetFrame, ev.endFrame)
      releaseTurnLease()
      session?.commitUserTurn()
      const transcriptPromise = transcribeBlocks(blocks)
        .then((r) => {
          turnMetrics.asrMs = r.asrMs
          return r.text
        })
        .catch(() => '')
      const { context: contextText } = await buildTurnContext()
      if (superseded()) return
      interruptedAfterText = undefined
      const l = newLedger('', speechEndAt, turnMetrics)
      l.userTranscriptPromise = transcriptPromise
      // Send first, then install the ledger: synchronous events of an older response
      // (e.g. an implicit cancel) must never be adopted by the new ledger.
      session?.respond({ contextText })
      ledger = l
      void transcriptPromise.then((text) => {
        if (!stopped && text && turnSeq === seq) {
          caption = { role: 'user', text: text.slice(0, 4000), final: true }
          report()
        }
      })
      return
    }

    // transcribed
    const blocks = turnBlocks(t.onsetFrame, ev.endFrame + Math.round(0.2 * CAPTURE_RATE))
    let text = ''
    try {
      const r = await transcribeBlocks(blocks)
      text = r.text
      turnMetrics.asrMs = r.asrMs
    } catch (err) {
      if (superseded()) return
      detail = `transcription failed: ${String((err as Error)?.message ?? err)}`
      abandonTurn()
      dispatch({ type: 'response_failed' })
      return
    }
    if (superseded()) return
    metrics = { ...turnMetrics }
    if (!text) {
      detail = 'empty transcription'
      abandonTurn()
      dispatch({ type: 'response_failed' })
      return
    }
    caption = { role: 'user', text: text.slice(0, 4000), final: true }
    report()
    const turnContext = await buildTurnContext(text)
    if (superseded()) return
    interruptedAfterText = undefined
    const s = session
    if (!s?.submitUserText) {
      detail = 'session does not support transcribed input'
      abandonTurn()
      dispatch({ type: 'response_failed' })
      return
    }
    const l = newLedger(text, speechEndAt, turnMetrics)
    // One input_text item: "[Contexto] …\n\n<Nome>: <fala>" — avoids LFM3 role confusion (spec §8.1).
    s.submitUserText(formatTranscribedUserTurn(text, turnContext.context, turnContext.userLabel))
    ledger = l
  }

  // ───────────────────────── barge-in ─────────────────────────

  function clearFalseInterruptTimer(): void {
    if (falseInterruptTimer !== null) {
      timers.clearTimeout(falseInterruptTimer)
      falseInterruptTimer = null
    }
  }

  function enterInterruptPending(): void {
    if (!dispatch({ type: 'speech_onset_during_playback' })) return
    clearFalseInterruptTimer()
    falseInterruptTimer = timers.setTimeout(() => {
      falseInterruptTimer = null
      if (machine.status === 'interrupt_pending') dispatch({ type: 'false_interruption' })
    }, interruptCfg.falseInterruptionMs)
  }

  function requiredBargeInMs(): number {
    const inWarmup = now() - speakingStartedAt < interruptCfg.aecWarmupMs
    return interruptCfg.bargeInMinMs * (inWarmup ? 2 : 1)
  }

  function bargeIn(onsetFrame: number): void {
    clearFalseInterruptTimer()
    const l = ledger
    ledger = null
    session?.cancelResponse('client')
    let spoken = ''
    if (l) {
      const playedMs = playedMsOf(l)
      player.stopWithFade(BARGE_IN_FADE_MS)
      const fullText = stripMarkers(l.text).trim()
      spoken = sliceSpokenText(fullText, playedMs, l.totalAudioMs)
      void finalizeLedger(l, { interrupted: true, playedMs, spokenOverride: spoken })
    } else {
      player.stopWithFade(BARGE_IN_FADE_MS)
    }
    stopVisemeTicker()
    interruptedAfterText = spoken || undefined
    playbackSpeechOnsetFrame = null
    caption = null
    dispatch({ type: 'barge_in_confirmed' })
    beginTurn(onsetFrame)
  }

  // ───────────────────────── detector events ─────────────────────────

  function handleDetectorEvent(ev: TurnDetectorEvent): void {
    const status = machine.status
    switch (ev.type) {
      case 'speech_start': {
        if (status === 'listening') {
          dispatch({ type: 'speech_confirmed' })
          beginTurn(ev.onsetFrame)
        } else if (status === 'thinking') {
          // User resumed before any audio played: cancel, nothing saved.
          cancelInFlightResponse()
          const merge = ev.continuation && inputMode === 'transcribed' && turn !== null
          dispatch({ type: 'user_resumed' })
          beginTurn(ev.onsetFrame, { merge })
        } else if (status === 'speaking' || status === 'interrupt_pending') {
          playbackSpeechOnsetFrame = ev.onsetFrame
          if (!interruptCfg.enabled) return
          if (status === 'speaking') enterInterruptPending()
          if (machine.status === 'interrupt_pending' && ev.speechMs >= requiredBargeInMs()) bargeIn(ev.onsetFrame)
        }
        return
      }
      case 'speech_during_playback': {
        playbackSpeechOnsetFrame = ev.onsetFrame
        if (!interruptCfg.enabled) return
        if (status === 'speaking') {
          enterInterruptPending()
        }
        if (machine.status === 'interrupt_pending' && ev.confirmed && ev.speechMs >= requiredBargeInMs()) {
          bargeIn(ev.onsetFrame)
        }
        return
      }
      case 'speech_cancel': {
        playbackSpeechOnsetFrame = null
        if (status === 'interrupt_pending') {
          clearFalseInterruptTimer()
          dispatch({ type: 'false_interruption' })
        }
        return
      }
      case 'speech_end': {
        playbackSpeechOnsetFrame = null
        if (status === 'user_speaking') {
          void commitTurn(ev).catch((err) => log('commitTurn failed', err))
        } else if (status === 'interrupt_pending') {
          clearFalseInterruptTimer()
          dispatch({ type: 'false_interruption' })
        }
        return
      }
      default:
        return
    }
  }

  async function handleBlock(block: PcmAudioBlock): Promise<void> {
    if (stopped || muted) return
    const status = machine.status
    if (status === 'idle' || status === 'connecting' || status === 'ended' || status === 'reconnecting') return
    if (streamingAudioDirect && status === 'user_speaking') pushAudioDirect(block)
    const events = await detector.processBlock(block, {
      assistantSpeaking: status === 'speaking' || status === 'interrupt_pending',
    })
    if (stopped || muted) return
    for (const ev of events) handleDetectorEvent(ev)
  }

  function onCaptureBlock(block: PcmAudioBlock): void {
    blockChain = blockChain.then(() => handleBlock(block)).catch((err) => log('block processing failed', err))
  }

  // ───────────────────────── session events ─────────────────────────

  function onResponseStarted(e: VoiceSessionEventMap['response_started']): void {
    if (ledger && ledger.itemId === null) ledger.itemId = e.responseId
  }

  function ledgerFor(responseId: string): ResponseLedger | null {
    const l = ledger
    if (!l || l.finalized) return null
    return l.itemId === responseId ? l : null
  }

  function onResponseText(e: VoiceSessionEventMap['response_text']): void {
    const l = ledgerFor(e.responseId)
    if (!l) return
    l.text = e.text
    caption = { role: 'assistant', text: stripMarkers(l.text).trim().slice(0, 4000), final: false }
    reportCaptionThrottled()
  }

  function onResponseAudio(e: VoiceSessionEventMap['response_audio']): void {
    const l = ledgerFor(e.responseId)
    if (!l) return
    const samples = int16ToFloat32(e.pcm)
    if (samples.length === 0) return
    const first = l.chunks.length === 0
    const tNow = now()
    if (first) {
      l.firstAudioAt = tNow
      l.metrics.ttfbMs = Math.round(tNow - l.responseRequestedAt)
      // Free the previous responses' buffers unless the gain is still at 0 from a fade
      // (reset() would leave the GainNode muted; scheduleChunk restores it instead).
      if (player.getGainValue() !== 0) player.reset()
      player.markStreamComplete(false)
    }
    const frames = computePcmVisemeFrames(samples, e.sampleRate)
    const item = player.scheduleChunk({
      samples,
      sampleRate: e.sampleRate,
      text: '',
      vowelFrames: frames.map(({ A, E, I, O, U }) => ({ A, E, I, O, U })),
    })
    l.chunks.push({ startSec: item.startTimeSec, durationSec: item.durationSec, frames })
    l.totalAudioMs += item.durationSec * 1000

    if (first) {
      const ctxAny = playbackCtx as { baseLatency?: number; outputLatency?: number } | null
      const outputLatencyMs = ((ctxAny?.baseLatency ?? 0) + (ctxAny?.outputLatency ?? 0)) * 1000
      const delayMs = Math.max(0, (item.startTimeSec - player.getCurrentTimeSec()) * 1000) + outputLatencyMs
      l.metrics.playbackStartMs = Math.round(delayMs)
      l.metrics.e2eMs = Math.round(tNow + delayMs - l.speechEndAt)
      speakingStartedAt = tNow + delayMs
      metrics = { ...l.metrics }
      releaseTurnLease()
      turn = null
      if (!dispatch({ type: 'first_audio_played' })) report()
      startVisemeTicker()
    }
  }

  function onResponseDone(e: VoiceSessionEventMap['response_done']): void {
    const l = ledgerFor(e.responseId)
    if (!l) return
    l.done = true
    if (e.text) l.text = e.text
    if (e.cancelled && e.cancelReason === 'watchdog') {
      // Runaway speech: cut playback now, keep only what was actually heard.
      detail = `watchdog: ${e.detail ?? 'runaway audio'}`
      const playedMs = playedMsOf(l)
      player.stopWithFade(BARGE_IN_FADE_MS)
      void finalizeLedger(l, { interrupted: false, playedMs })
      ledger = null
      releaseTurnLease()
      turn = null
      stopVisemeTicker()
      caption = { role: 'assistant', text: sliceSpokenText(stripMarkers(l.text).trim(), playedMs, l.totalAudioMs), final: true }
      if (!dispatch({ type: 'queue_drained' })) report()
      return
    }
    if (l.chunks.length === 0) {
      // No audio at all: nothing was heard.
      void finalizeLedger(l, { interrupted: false, playedMs: 0, spokenOverride: '' })
      ledger = null
      releaseTurnLease()
      turn = null
      caption = { role: 'assistant', text: stripMarkers(l.text).trim().slice(0, 4000), final: true }
      dispatch({ type: 'response_failed' })
      return
    }
    caption = { role: 'assistant', text: stripMarkers(l.text).trim().slice(0, 4000), final: false }
    player.markStreamComplete(true)
    if (!l.finalized) {
      // Safety net if the AudioContext never fires `onended`.
      const remainingMs = player.getRemainingPlaybackSec() * 1000
      l.safetyTimer = timers.setTimeout(() => {
        l.safetyTimer = null
        if (ledger === l && !l.finalized && !stopped) completeNaturally(l)
      }, remainingMs + 750)
    }
  }

  function onSessionClosed(e: VoiceSessionEventMap['closed']): void {
    if (stopped || e.expected) return
    void handleBackendFailure(`session closed (${e.code ?? '?'}${e.reason ? `: ${e.reason}` : ''})`)
  }

  function onSessionError(e: VoiceSessionEventMap['error']): void {
    log('session error', e)
    if (e.fatal && !stopped) void handleBackendFailure(e.message)
  }

  function attachSession(s: VoiceSession): void {
    for (const u of sessionUnsubs) u()
    sessionUnsubs = [
      s.on('response_started', (e) => s === session && onResponseStarted(e)),
      s.on('response_text', (e) => s === session && onResponseText(e)),
      s.on('response_audio', (e) => s === session && onResponseAudio(e)),
      s.on('response_done', (e) => s === session && onResponseDone(e)),
      s.on('closed', (e) => s === session && onSessionClosed(e)),
      s.on('error', (e) => s === session && onSessionError(e)),
    ]
  }

  async function openSession(): Promise<void> {
    const s = options.createSession()
    session = s
    attachSession(s)
    await s.connect({ instructions, voice: settings.llamacpp.voice })
  }

  async function handleBackendFailure(why: string): Promise<void> {
    if (stopped) return
    // Whatever was heard so far is kept; the rest is gone with the session.
    const l = ledger
    ledger = null
    if (l) {
      const playedMs = playedMsOf(l)
      void finalizeLedger(l, { interrupted: true, playedMs })
    }
    player.stopWithFade(0)
    stopVisemeTicker()
    abandonTurn()
    const old = session
    session = null
    for (const u of sessionUnsubs) u()
    sessionUnsubs = []
    void old?.close().catch(() => {})

    machine = transitionCall(machine, { type: 'backend_error', maxAttempts: maxReconnectAttempts, detail: why })
    detail = why
    if (machine.status === 'ended') {
      await teardown()
      report()
      finishToIdle()
      return
    }
    report()
    const attempt = machine.reconnectAttempts
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null
      void (async () => {
        if (stopped) return
        try {
          await openSession()
          if (stopped) return
          detector.reset()
          detail = null
          dispatch({ type: 'reconnected' })
        } catch (err) {
          await handleBackendFailure(`reconnect failed: ${String((err as Error)?.message ?? err)}`)
        }
      })()
    }, 500 * attempt)
  }

  // ───────────────────────── lifecycle ─────────────────────────

  function resolvePlaybackContext(): WebAudioContextLike | null {
    const opt = options.playbackAudioContext
    if (opt === null) return null
    if (typeof opt === 'function') return opt()
    if (opt) return opt
    const Ctor = (globalThis as unknown as { AudioContext?: new (o?: Record<string, unknown>) => WebAudioContextLike })
      .AudioContext
    if (!Ctor) return null
    ownsPlaybackCtx = true
    return new Ctor({ latencyHint: 'interactive' })
  }

  async function teardown(): Promise<void> {
    stopped = true
    clearFalseInterruptTimer()
    if (reconnectTimer !== null) {
      timers.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (captionTimer !== null) {
      timers.clearTimeout(captionTimer)
      captionTimer = null
    }
    stopVisemeTicker()
    const s = session
    session = null
    for (const u of sessionUnsubs) u()
    sessionUnsubs = []
    try {
      await s?.close()
    } catch {
      // ignore
    }
    try {
      await capture.stopMicrophoneCapture()
    } catch {
      // ignore
    }
    player.stopWithFade(0)
    releaseTurnLease()
    turn = null
    detector.reset()
    const ctx = playbackCtx
    playbackCtx = null
    player.attachAudioContext(null)
    if (ctx && ownsPlaybackCtx) {
      try {
        await (ctx as { close?: () => Promise<void> }).close?.()
      } catch {
        // ignore
      }
    }
  }

  function finishToIdle(): void {
    machine = transitionCall(machine, { type: 'reset' })
    caption = null
    report()
  }

  async function start(): Promise<CallStatus> {
    if (!dispatch({ type: 'start' })) return machine.status
    try {
      playbackCtx = resolvePlaybackContext()
      if (playbackCtx) {
        player.attachAudioContext(playbackCtx)
        if (playbackCtx.state === 'suspended') await playbackCtx.resume?.().catch(() => {})
      }
    } catch (err) {
      log('playback context unavailable', err)
    }

    const sessionPromise = (async () => {
      const ctx = await host.buildContext({ callId })
      instructions = ctx?.instructions ?? ''
      await openSession()
    })()
    const capturePromise = capture.startMicrophoneCapture({
      ...(settings.devices.inputDeviceId ? { deviceId: settings.devices.inputDeviceId } : {}),
      ...(options.mediaDevices ? { mediaDevices: options.mediaDevices } : {}),
      ...(options.captureAudioContextFactory ? { audioContextFactory: options.captureAudioContextFactory } : {}),
      onPcmBlock: (aecBlock) => onCaptureBlock(aecBlock),
    })
    const [sessionRes, captureRes, detectorRes] = await Promise.allSettled([
      sessionPromise,
      capturePromise,
      detector.init(),
    ])
    if (stopped) return machine.status

    let failure: { reason: CallEndReason; detail: string } | null = null
    if (captureRes.status === 'rejected') {
      failure = { reason: classifyCaptureError(captureRes.reason), detail: String((captureRes.reason as Error)?.message ?? captureRes.reason) }
    } else if (sessionRes.status === 'rejected') {
      failure = { reason: 'backend_unavailable', detail: String((sessionRes.reason as Error)?.message ?? sessionRes.reason) }
    }
    if (failure) {
      detail = failure.detail
      await teardown()
      machine = transitionCall(machine, { type: 'fatal', reason: failure.reason, detail: failure.detail })
      report()
      finishToIdle()
      return 'ended'
    }
    if (detectorRes.status === 'fulfilled') log(`vad engine: ${detectorRes.value}`)
    dispatch({ type: 'connected' })
    return machine.status
  }

  async function stop(reason: CallEndReason = 'user_hangup', stopDetail?: string): Promise<void> {
    if (stopped && (machine.status === 'idle' || machine.status === 'ended')) return
    const l = ledger
    ledger = null
    if (l && l.chunks.length > 0 && !l.finalized) {
      const playedMs = playedMsOf(l)
      void finalizeLedger(l, { interrupted: playedMs < l.totalAudioMs - 1, playedMs })
    }
    await teardown()
    detail = stopDetail ?? null
    machine = transitionCall(machine, { type: 'stop', reason, ...(stopDetail ? { detail: stopDetail } : {}) })
    if (machine.status === 'ended') report()
    finishToIdle()
  }

  function setMuted(next: boolean): void {
    if (muted === next) return
    muted = next
    detector.reset()
    if (muted) {
      if (machine.status === 'user_speaking') {
        abandonTurn()
        dispatch({ type: 'turn_incomplete' })
      } else if (machine.status === 'interrupt_pending') {
        clearFalseInterruptTimer()
        dispatch({ type: 'false_interruption' })
      }
    }
    report()
  }

  return {
    start,
    stop,
    setMuted,
    getStatus: () => machine.status,
    getSnapshot: snapshot,
  }
}
