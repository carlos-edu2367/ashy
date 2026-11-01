/**
 * Phase 10.1 — CallEngine (spec §6): owns one live call inside the hidden `call-engine` renderer.
 *
 * capture (worklet @16 kHz → ring buffer with pre-roll) → TurnDetector (Silero / DSP fallback)
 *   → transcribed: WAV of the turn → host.transcribe → host.buildContext → session.submitUserText
 *   → audio-direct (experimental): session.pushAudio from onset (+pre-roll) → commitUserTurn → respond
 * session deltas → GaplessAudioPlayer (+ viseme frames from the PCM actually played)
 * ledger (text + played ms per response) → host.recordTurn (only what was heard)
 *
 * Phase 10.2: ducking in interrupt_pending, session rotation seeded with a deduped recap (curbs the 2B
 * model repeating itself), emotion per sentence (ACT marker or host.classifyAffect) reported when that
 * sentence starts playing, and a test mode where a WAV replaces the microphone.
 *
 * Phase 10.3: tools. When the session-level `buildContext` returns tools they go in `session.update`
 * (again on every rotation / reconnect). A turn whose context says `toolChoice:'auto'` runs as a
 * TEXT-only tool step first (audio responses never call tools on LFM3): its function calls are executed
 * by `host.executeTool` and their outputs sent back, then the spoken answer is requested with
 * `tool_choice:'none'` (≤ 3 rounds per turn). A tool step without calls is not regenerated: its
 * text is spoken (session TTS when it has one, otherwise `host.synthesize` into the same playback /
 * ledger path). `inject()` speaks proactively (approval results, initiative) when listening, with a
 * one-slot queue (30 s); a silence timer asks `host.checkInitiative` (`features.initiativeInCall`).
 *
 * The engine knows no backend: it only reads `session.caps`. Every browser API is injected.
 */
import {
  type CallCaption,
  type CallEndReason,
  type CallToolDefinition,
  type CallMetrics,
  type CallStageSignal,
  type CallStatus,
  type CallTestInput,
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
import { base64ToUint8Array, decodeWavToPcmBlocks, encodePcmBlocksToWav, uint8ArrayToBase64 } from '../wav-codec'
import {
  buildSessionRecap,
  extractActMarkers,
  isNearRepeat,
  NEAR_REPEAT_WINDOW,
  splitCompletedSentences,
  stripCallMarkers,
  textSimilarity,
  type CallExchange,
} from './call-quality'
import {
  createInitialCallMachineState,
  isCallActiveStatus,
  transitionCall,
  type CallMachineEvent,
  type CallMachineState,
} from './call-state-machine'
import {
  base64ToInt16,
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
  type CallReportTestResultInput,
  type CallTimers,
  type VoiceSession,
  type VoiceSessionEventMap,
  type VoiceSubmitOptions,
  type VoiceToolCall,
  type VoiceToolResult,
} from './types'

const CAPTURE_RATE = 16000
const BARGE_IN_FADE_MS = 120
const VISEME_INTERVAL_MS = 33
const CAPTION_THROTTLE_MS = 100
/** Phase 10.2 ducking while a possible barge-in is being confirmed. */
export const CALL_DUCK_DB = -12
const DUCK_RAMP_MS = 80
const UNDUCK_RAMP_MS = 150
/** Session rotation: ~4 chars per text token; rotate when the estimate passes 70 % of the context. */
const CHARS_PER_TOKEN = 4
const CONTEXT_ROTATE_RATIO = 0.7
/** Stage timing before the response is complete: never assume speech faster than this. */
const STAGE_MIN_MS_PER_CHAR = 1000 / 15
const TEST_TRAILING_SILENCE_MS = 1500
const TEST_TIMEOUT_MS = 45000
const TEST_BLOCK_MS = 20
/** Phase 10.3: max tool rounds (execute + send outputs) per turn. */
export const MAX_TOOL_ROUNDS = 3
/** Phase 10.3: a queued `inject` (call busy) is dropped after this long. */
export const INJECT_QUEUE_TTL_MS = 30000
/** Caption while a tool runs. */
export function toolCaptionText(toolName: string): string {
  return `🔧 usando ${toolName}…`
}

export type CallInjectReason = 'approval' | 'initiative'
/** 'sent' now, 'queued' (call busy, one slot, 30 s) or 'dropped' (no call / test call / empty text). */
export type CallInjectOutcome = 'sent' | 'queued' | 'dropped'

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
  /** Context window of the backend model (CallRuntimeConfig.llamacpp.contextSize). Default 8192. */
  contextSize?: number
  /** Context tokens per second of audio (input/output) for the rotation estimate. Default 12.5. */
  audioTokensPerSec?: number
  /**
   * Phase 10.2 test call: this WAV (mono PCM16, 16 kHz) replaces the microphone (fed in real time in
   * 20 ms blocks, then 1.5 s of silence). After one turn (or the timeout) the engine calls
   * host.reportTestResult and stops. Test turns are never recorded.
   */
  testInput?: CallTestInput
  /** Test call overall timeout (default 45 s). */
  testTimeoutMs?: number
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
  /**
   * Phase 10.3 — speak proactively: `contextText` goes as an input_text item, then response.create.
   * Only while listening; otherwise it waits in a one-slot queue (newest wins) for up to 30 s.
   * The turn is recorded with an empty `userTranscript`.
   */
  inject(contextText: string, reason: CallInjectReason): CallInjectOutcome
}

interface LedgerChunk {
  startSec: number
  durationSec: number
  frames: CallVisemeFrame[]
}

interface PendingStage {
  /** Offset in the clean (marker-free) response text where the signal applies. */
  offset: number
  signal: CallStageSignal | null
  resolved: boolean
  fired: boolean
}

interface StageTrack {
  markersSeen: number
  sentencesSeen: number
  cleanLen: number
  pending: PendingStage[]
  cancelled: boolean
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
  stage: StageTrack
  /** Recap bookkeeping done (once per ledger). */
  noted: boolean
  /** Phase 10.3: this turn runs the tool flow (tool step → rounds → spoken answer). */
  tool: { rounds: number; fallbackUsed: boolean } | null
  /** Phase 10.3: proactive turn (no user speech). */
  injectReason: CallInjectReason | null
}

interface ActiveTurn {
  seq: number
  onsetFrame: number
  lease: HistoryLease | null
}

/** Markers (`<|ACT …|>`, `<|ACT …}>`, control tokens) never reach the caption or the ledger. */
const stripMarkers = stripCallMarkers

interface TestTracker {
  samples: Float32Array | null
  startedAt: number
  engineOk: boolean
  engineMs?: number
  engineDetail?: string
  sessionOk: boolean
  sessionMs?: number
  sessionDetail?: string
  feedStartedAt: number | null
  speechStartAt: number | null
  speechEndAt: number | null
  committed: boolean
  transcript: string | null
  asrMs?: number
  transcriptionDetail?: string
  ttfbMs?: number
  playbackOk: boolean
  playbackMs?: number
  playbackDetail?: string
  reply: string | null
  metrics: CallMetrics | null
  feedTimer: unknown
  timeoutTimer: unknown
  reported: boolean
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
  /** Phase 10.3: tools of the session-level buildContext (re-sent on rotation / reconnect). */
  let sessionTools: CallToolDefinition[] = []
  let synthSeq = 0

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

  // ── session rotation (Phase 10.2) ──
  const rotateAfterTurns = Math.max(1, settings.session?.rotateAfterTurns ?? 6)
  const contextSize = options.contextSize && options.contextSize > 0 ? options.contextSize : 8192
  const audioTokensPerSec = options.audioTokensPerSec ?? 12.5
  let sessionTurns = 0
  let sessionTokens = 0
  const exchanges: CallExchange[] = []
  const recentReplies: string[] = []
  let rotationDue: string | null = null
  let rotating: Promise<void> | null = null
  /** Recap to send (inside the context part of the next user turn) to a freshly opened session. */
  let pendingRecap = ''
  let lastUserLabel: string | undefined

  // ── inject / initiative (Phase 10.3) ──
  let queuedInject: { text: string; reason: CallInjectReason; at: number; timer: unknown } | null = null
  let initiativeTimer: unknown = null
  let initiativeInFlight = false
  let listeningSince = 0

  // ── test mode (Phase 10.2) ──
  const testInput = options.testInput ?? null
  const test: TestTracker | null = testInput
    ? {
        samples: null,
        startedAt: 0,
        engineOk: false,
        sessionOk: false,
        feedStartedAt: null,
        speechStartAt: null,
        speechEndAt: null,
        committed: false,
        transcript: null,
        playbackOk: false,
        reply: null,
        metrics: null,
        feedTimer: null,
        timeoutTimer: null,
        reported: false,
      }
    : null
  const initiativeEnabled = settings.features?.initiativeInCall === true && !test
  const idleNudgeMs = Math.max(1000, (Number(settings.features?.idleNudgeSec) || 90) * 1000)

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
    const prev = machine.status
    const next = transitionCall(machine, event)
    if (next === machine) return false
    machine = next
    onStatusChange(prev, machine.status)
    report()
    return true
  }

  function onStatusChange(prev: CallStatus, status: CallStatus): void {
    if (status === 'interrupt_pending') {
      player.setDuck(CALL_DUCK_DB, DUCK_RAMP_MS)
    } else if (prev === 'interrupt_pending' && player.getDuckDb() !== 0) {
      // False interruption → back to full volume; queue drained → nothing left to un-duck smoothly.
      player.setDuck(0, status === 'speaking' ? UNDUCK_RAMP_MS : 0)
    }
    if (status === 'listening') {
      if (rotationDue !== null && !rotating && !stopped) void startRotation()
      if (test && test.committed && !test.reported) {
        void Promise.resolve().then(() => finishTest())
      }
      listeningSince = now()
      armInitiative()
      if (queuedInject) void Promise.resolve().then(() => flushQueuedInject())
    } else {
      clearInitiativeTimer()
    }
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
      tickStage()
    }, VISEME_INTERVAL_MS)
  }

  // ───────────────────────── emotion (Phase 10.2, spec §6.5) ─────────────────────────

  function newStageTrack(): StageTrack {
    return { markersSeen: 0, sentencesSeen: 0, cleanLen: 0, pending: [], cancelled: false }
  }

  function cancelStage(l: ResponseLedger): void {
    l.stage.cancelled = true
    l.stage.pending.length = 0
  }

  /** ACT markers → immediate signals; every complete sentence without a marker → host.classifyAffect. */
  function processStage(l: ResponseLedger, final: boolean): void {
    const st = l.stage
    if (st.cancelled) return
    const { clean, markers } = extractActMarkers(l.text)
    st.cleanLen = clean.length
    for (let i = st.markersSeen; i < markers.length; i++) {
      st.pending.push({ offset: markers[i]!.offset, signal: markers[i]!.signal, resolved: true, fired: false })
    }
    st.markersSeen = markers.length
    const spans = splitCompletedSentences(clean, final)
    for (let i = st.sentencesSeen; i < spans.length; i++) {
      const span = spans[i]!
      const prevEnd = i > 0 ? spans[i - 1]!.end : 0
      if (markers.some((m) => m.offset >= prevEnd && m.offset < span.end)) continue
      const pending: PendingStage = { offset: span.start, signal: null, resolved: false, fired: false }
      st.pending.push(pending)
      classifySentence(span.text).then(
        (signal) => {
          pending.signal = st.cancelled ? null : signal
          pending.resolved = true
        },
        () => {
          pending.resolved = true
        },
      )
    }
    st.sentencesSeen = spans.length
  }

  async function classifySentence(text: string): Promise<CallStageSignal | null> {
    if (typeof host.classifyAffect !== 'function') return null
    try {
      const res = await host.classifyAffect({ callId, text: text.slice(0, 2000) })
      return res && typeof res.emotion === 'string' && res.emotion ? res : null
    } catch (err) {
      log('classifyAffect failed', err)
      return null
    }
  }

  /** Fires each resolved signal when its text offset starts playing (proportional text → audio map). */
  function tickStage(): void {
    const l = ledger
    if (!l || l.stage.cancelled || l.chunks.length === 0 || l.stage.pending.length === 0) return
    const st = l.stage
    const startSec = l.chunks[0]!.startSec
    const ratio = st.cleanLen > 0 ? l.totalAudioMs / st.cleanLen : 0
    const msPerChar = l.done ? ratio : Math.max(ratio, STAGE_MIN_MS_PER_CHAR)
    const t = player.getCurrentTimeSec()
    for (const p of st.pending) {
      if (p.fired || !p.resolved) continue
      const atSec = startSec + (p.offset * msPerChar) / 1000
      if (t + 1e-6 < atSec) continue
      p.fired = true
      if (p.signal) sendStage(p.signal)
    }
    st.pending = st.pending.filter((p) => !p.fired)
  }

  function sendStage(signal: CallStageSignal): void {
    if (typeof host.reportStage !== 'function') return
    const intensity = Number.isFinite(signal.intensity) ? Math.max(0, Math.min(1, signal.intensity)) : 0.6
    try {
      const res = host.reportStage({
        callId,
        emotion: String(signal.emotion).slice(0, 32),
        intensity,
        ...(signal.motion ? { motion: String(signal.motion).slice(0, 48) } : {}),
      })
      if (res && typeof (res as Promise<unknown>).catch === 'function') (res as Promise<unknown>).catch(() => {})
    } catch {
      // ignore
    }
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
    cancelStage(l)
    const fullText = stripMarkers(l.text).trim()
    const spoken =
      outcome.spokenOverride ??
      (outcome.playedMs >= l.totalAudioMs - 1 && l.totalAudioMs > 0
        ? fullText
        : sliceSpokenText(fullText, outcome.playedMs, l.totalAudioMs))
    const exchange = noteReply(l, fullText, spoken)
    const userTranscript = l.userTranscriptPromise ? await l.userTranscriptPromise.catch(() => '') : l.userTranscript
    if (exchange && !exchange.user) exchange.user = userTranscript
    if (test) {
      // Test turns never reach the memory / chat history.
      if (test.reply === null) test.reply = fullText
      return
    }
    try {
      await host.recordTurn({
        callId,
        userTranscript: userTranscript.slice(0, 8000),
        assistantSpokenText: spoken.slice(0, 16000),
        assistantFullText: fullText.slice(0, 16000),
        interrupted: outcome.interrupted,
        playedMs: Math.round(outcome.playedMs),
        metrics: { ...l.metrics },
        ...(l.injectReason ? { injectReason: l.injectReason } : {}),
      })
    } catch (err) {
      log('recordTurn failed', err)
    }
  }

  // ───────────────────────── session rotation (Phase 10.2) ─────────────────────────

  function tokensOf(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN)
  }

  function audioTokens(ms: number): number {
    return Math.ceil((Math.max(0, ms) / 1000) * audioTokensPerSec)
  }

  /**
   * Recap bookkeeping + rotation triggers, once per finished response (completed, interrupted or cut).
   * Returns the exchange so the caller can fill an audio-direct transcript later.
   */
  function noteReply(l: ResponseLedger, fullText: string, spoken: string): CallExchange | null {
    if (l.noted) return null
    l.noted = true
    sessionTokens += tokensOf(l.text) + audioTokens(l.totalAudioMs)
    let exchange: CallExchange | null = null
    if (fullText || l.userTranscript) {
      exchange = { user: l.userTranscript, assistant: spoken }
      exchanges.push(exchange)
      if (exchanges.length > 12) exchanges.splice(0, exchanges.length - 12)
    }
    if (rotationDue === null && fullText && isNearRepeat(fullText, recentReplies)) {
      rotationDue = 'repetition'
      log('near-repeat reply detected: rotating the session', { reply: fullText.slice(0, 120) })
    }
    if (fullText) {
      recentReplies.push(fullText)
      if (recentReplies.length > NEAR_REPEAT_WINDOW) recentReplies.splice(0, recentReplies.length - NEAR_REPEAT_WINDOW)
    }
    if (rotationDue === null && sessionTurns >= rotateAfterTurns) rotationDue = 'turns'
    if (rotationDue === null && sessionTokens >= contextSize * CONTEXT_ROTATE_RATIO) rotationDue = 'context'
    return exchange
  }

  /** Same instructions and tools for the first session, every rotation and every reconnect. */
  function sessionInit(): { instructions: string; voice: 'female' | 'male'; tools?: CallToolDefinition[] } {
    return {
      instructions,
      voice: settings.llamacpp.voice,
      ...(sessionTools.length > 0 ? { tools: sessionTools } : {}),
    }
  }

  function startRotation(): Promise<void> {
    if (!rotating) {
      const reason = rotationDue ?? 'manual'
      rotating = rotateSession(reason).finally(() => {
        rotating = null
      })
    }
    return rotating
  }

  /**
   * Opens a fresh session with the same instructions, swaps it in quietly (no state change) and queues
   * the recap for the next user turn. On failure the current session is kept (retried after next turn).
   */
  async function rotateSession(reason: string): Promise<void> {
    const old = session
    if (stopped || !old) return
    log(`rotating session (${reason})`, { turns: sessionTurns, tokens: sessionTokens })
    let next: VoiceSession
    try {
      next = options.createSession()
      await next.connect(sessionInit())
    } catch (err) {
      log('session rotation failed; keeping the current session', err)
      return
    }
    const busy = ledger !== null || (inputMode === 'audio-direct' && streamingAudioDirect)
    if (stopped || session !== old || busy) {
      void next.close().catch(() => {})
      return
    }
    session = next
    attachSession(next)
    void old.close().catch(() => {})
    rotationDue = null
    pendingRecap = buildSessionRecap(exchanges, lastUserLabel ? { userLabel: lastUserLabel } : {})
    sessionTurns = 0
    sessionTokens = tokensOf(instructions) + tokensOf(pendingRecap)
  }

  /** Context text for the next user turn: the pending recap (if any) + the host's per-turn context. */
  function takeTurnContext(context: string): string {
    const recap = pendingRecap
    pendingRecap = ''
    return [recap.trim(), context.trim()].filter((t) => t.length > 0).join('\n')
  }

  function onPlayerEnded(): void {
    const l = ledger
    if (!l || !l.done || l.finalized) return
    completeNaturally(l)
  }

  function completeNaturally(l: ResponseLedger): void {
    if (l.finalized) return
    if (test && !test.playbackOk) {
      test.playbackOk = true
      test.playbackMs = Math.round(l.totalAudioMs)
    }
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
      cancelStage(l)
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
      stage: newStageTrack(),
      noted: false,
      tool: null,
      injectReason: null,
    }
  }

  async function transcribeBlocks(blocks: PcmAudioBlock[]): Promise<{ text: string; asrMs: number }> {
    const wav = encodePcmBlocksToWav(blocks)
    const t0 = now()
    const res = await host.transcribe({ callId, audioWavBase64: uint8ArrayToBase64(wav), language })
    return { text: (res?.text ?? '').trim(), asrMs: Math.round(now() - t0) }
  }

  async function buildTurnContext(
    userText?: string,
  ): Promise<{ context: string; userLabel?: string; toolChoice?: 'auto' | 'none'; approvalHandled?: boolean }> {
    try {
      const ctx = await host.buildContext({
        callId,
        ...(userText ? { userText } : {}),
        ...(interruptedAfterText ? { interruptedAfterText } : {}),
      })
      return {
        context: ctx?.perTurnContext ?? '',
        ...(ctx?.userLabel ? { userLabel: ctx.userLabel } : {}),
        ...(ctx?.toolChoice === 'auto' || ctx?.toolChoice === 'none' ? { toolChoice: ctx.toolChoice } : {}),
        ...(ctx?.approvalHandled === true ? { approvalHandled: true } : {}),
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
    if (test) test.committed = true
    const superseded = () => stopped || turnSeq !== seq || machine.status !== 'thinking'

    if (inputMode === 'audio-direct') {
      streamingAudioDirect = false
      const blocks = turnBlocks(t.onsetFrame, ev.endFrame)
      releaseTurnLease()
      session?.commitUserTurn()
      const userAudioMs = blocks.reduce((acc, b) => acc + b.durationMs, 0)
      const transcriptPromise = transcribeBlocks(blocks)
        .then((r) => {
          turnMetrics.asrMs = r.asrMs
          if (test && turnSeq === seq) {
            test.transcript = r.text || null
            test.asrMs = r.asrMs
          }
          return r.text
        })
        .catch(() => '')
      const { context } = await buildTurnContext()
      if (superseded()) return
      interruptedAfterText = undefined
      const l = newLedger('', speechEndAt, turnMetrics)
      l.userTranscriptPromise = transcriptPromise
      const contextText = takeTurnContext(context)
      sessionTurns += 1
      sessionTokens += tokensOf(contextText) + audioTokens(userAudioMs)
      // Send first, then install the ledger: synchronous events of an older response
      // (e.g. an implicit cancel) must never be adopted by the new ledger.
      session?.respond({ contextText, ...(sessionTools.length > 0 ? { toolChoice: 'none' as const } : {}) })
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
    // A due rotation (e.g. after a barge-in) overlaps the ASR; the turn waits for it before submitting.
    if (rotationDue !== null && !rotating) void startRotation()
    const blocks = turnBlocks(t.onsetFrame, ev.endFrame + Math.round(0.2 * CAPTURE_RATE))
    let text = ''
    try {
      const r = await transcribeBlocks(blocks)
      text = r.text
      turnMetrics.asrMs = r.asrMs
    } catch (err) {
      if (superseded()) return
      detail = `transcription failed: ${String((err as Error)?.message ?? err)}`
      if (test) test.transcriptionDetail = detail
      abandonTurn()
      dispatch({ type: 'response_failed' })
      return
    }
    if (superseded()) return
    metrics = { ...turnMetrics }
    if (test) {
      test.transcript = text || null
      test.asrMs = turnMetrics.asrMs
    }
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
    if (rotating) {
      await rotating
      if (superseded()) return
    }
    if (turnContext.userLabel) lastUserLabel = turnContext.userLabel
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
    // After a rotation the recap rides in the context part of that same item (llama.cpp realtime
    // only accepts user input_text items, and instructions only before the first input).
    const item = formatTranscribedUserTurn(text, takeTurnContext(turnContext.context), turnContext.userLabel)
    sessionTurns += 1
    sessionTokens += tokensOf(item)
    // Phase 10.3: a tool turn starts with a TEXT-only tool step; a voice approval is never a tool turn.
    const toolTurn =
      turnContext.toolChoice === 'auto' &&
      !turnContext.approvalHandled &&
      sessionTools.length > 0 &&
      s.caps.toolCalls &&
      typeof s.submitToolResults === 'function'
    if (toolTurn) l.tool = { rounds: 0, fallbackUsed: false }
    const submitOpts: VoiceSubmitOptions | undefined =
      sessionTools.length > 0 ? { toolChoice: toolTurn ? 'auto' : 'none' } : undefined
    if (submitOpts) s.submitUserText(item, submitOpts)
    else s.submitUserText(item)
    ledger = l
  }

  // ───────────────────────── tools (Phase 10.3) ─────────────────────────

  function failToolTurn(l: ResponseLedger, why: string): void {
    if (ledger !== l || l.finalized) return
    detail = why
    if (test) test.playbackDetail = why
    void finalizeLedger(l, { interrupted: false, playedMs: 0, spokenOverride: '' })
    ledger = null
    releaseTurnLease()
    turn = null
    caption = null
    dispatch({ type: 'response_failed' })
  }

  function onToolStepStarted(e: VoiceSessionEventMap['tool_step_started']): void {
    const l = ledger
    if (l && l.tool && !l.finalized && l.itemId === null) l.itemId = e.responseId
  }

  function onToolCall(e: VoiceSessionEventMap['tool_call']): void {
    const l = ledger
    if (!l || !l.tool || l.finalized) return
    if (e.responseId && l.itemId !== e.responseId) return
    caption = { role: 'assistant', text: toolCaptionText(e.name).slice(0, 4000), final: false }
    report()
  }

  function onToolStepDone(e: VoiceSessionEventMap['tool_step_done']): void {
    const l = ledger
    if (!l || !l.tool || l.finalized || l.itemId !== e.responseId) return
    if (e.cancelled) {
      // A client cancel (barge-in / new turn) already dropped this ledger; anything else fails the turn.
      failToolTurn(l, e.cancelReason === 'watchdog' ? `watchdog: ${e.detail ?? 'runaway tool step'}` : 'tool step cancelled')
      return
    }
    if (e.calls.length > 0 && l.tool.rounds < MAX_TOOL_ROUNDS) {
      void runToolRound(l, e.calls)
      return
    }
    const text = stripMarkers(e.text).trim()
    if (!text) {
      failToolTurn(l, 'tool step produced no text')
      return
    }
    speakFallback(l, e.text)
  }

  /** Executes the calls (sequentially, through the host gatekeeper) and asks for the spoken answer. */
  async function runToolRound(l: ResponseLedger, calls: VoiceToolCall[]): Promise<void> {
    if (!l.tool) return
    const s = session
    l.tool.rounds += 1
    l.done = false
    const round = l.tool.rounds
    const results: VoiceToolResult[] = []
    for (const call of calls) {
      caption = { role: 'assistant', text: toolCaptionText(call.name).slice(0, 4000), final: false }
      report()
      let output: string
      try {
        const res = await host.executeTool({
          callId,
          toolCallId: call.callId.slice(0, 128),
          name: call.name.slice(0, 128),
          argsJson: (call.arguments || '{}').slice(0, 20000),
        })
        output = typeof res?.output === 'string' ? res.output : JSON.stringify({ status: res?.status ?? 'error' })
        log(`tool ${call.name} → ${res?.status ?? '?'}`, { round })
      } catch (err) {
        output = JSON.stringify({ status: 'erro', detalhe: String((err as Error)?.message ?? err).slice(0, 300) })
        log(`tool ${call.name} failed`, err)
      }
      // Barge-in / new turn / reconnect while the tool ran: drop every pending result.
      if (stopped || ledger !== l || l.finalized || session !== s) return
      results.push({ callId: call.callId, output })
    }
    if (stopped || ledger !== l || l.finalized || !s || session !== s || typeof s.submitToolResults !== 'function') return
    sessionTokens += results.reduce((acc, r) => acc + tokensOf(r.output), 0)
    l.itemId = null
    s.submitToolResults(results, { toolChoice: 'none' })
  }

  /** A tool step that called nothing: speak its text instead of generating again. */
  function speakFallback(l: ResponseLedger, text: string): void {
    if (!l.tool) return
    l.tool.fallbackUsed = true
    l.done = false
    l.itemId = null
    l.text = ''
    const s = session
    if (s && typeof s.speakText === 'function') {
      s.speakText(text)
      return
    }
    void speakViaHost(l, text)
  }

  /** Realtime backend fallback: host /tts per sentence (one ahead), into the regular playback / ledger path. */
  async function speakViaHost(l: ResponseLedger, text: string): Promise<void> {
    synthSeq += 1
    const responseId = `synth_${synthSeq}`
    l.itemId = responseId
    onResponseText({ responseId, delta: text, text })
    const clean = stripMarkers(text).trim()
    const parts = splitCompletedSentences(clean, true)
      .map((sp) => sp.text.trim())
      .filter((t) => /[\p{L}\p{N}]/u.test(t))
    if (parts.length === 0 && clean) parts.push(clean)
    const alive = () => !stopped && ledger === l && !l.finalized && l.itemId === responseId
    const launch = (part: string) =>
      Promise.resolve()
        .then(() => host.synthesize({ callId, text: part.slice(0, 4000) }))
        .catch((err: unknown) => {
          log('synthesize failed', err)
          return null
        })
    let pending: ReturnType<typeof launch> | null = parts.length > 0 ? launch(parts[0]!) : null
    for (let i = 0; i < parts.length; i++) {
      const cur = pending!
      pending = i + 1 < parts.length ? launch(parts[i + 1]!) : null
      const res = await cur
      if (!alive()) return
      const pcm = res && typeof res.pcmBase64 === 'string' ? base64ToInt16(res.pcmBase64) : new Int16Array(0)
      if (pcm.length > 0) {
        onResponseAudio({ responseId, pcm, sampleRate: res && res.sampleRate > 0 ? res.sampleRate : 24000 })
      }
    }
    if (!alive()) return
    onResponseDone({ responseId, text, audioMs: l.totalAudioMs, cancelled: false })
  }

  // ───────────────────────── inject / initiative (Phase 10.3) ─────────────────────────

  function canInjectNow(): boolean {
    return !stopped && machine.status === 'listening' && !rotating && session !== null && ledger === null
  }

  function clearQueuedInject(): void {
    if (queuedInject?.timer != null) timers.clearTimeout(queuedInject.timer)
    queuedInject = null
  }

  function sendInject(text: string, reason: CallInjectReason): void {
    const s = session
    if (!s) return
    const contextText = takeTurnContext(text)
    const l = newLedger('', now(), {})
    l.injectReason = reason
    metrics = null
    caption = null
    sessionTurns += 1
    sessionTokens += tokensOf(contextText)
    log(`inject (${reason})`)
    dispatch({ type: 'proactive_response' })
    s.respond({ contextText, ...(sessionTools.length > 0 ? { toolChoice: 'none' as const } : {}) })
    ledger = l
  }

  function flushQueuedInject(): void {
    const q = queuedInject
    if (!q) return
    if (now() - q.at > INJECT_QUEUE_TTL_MS) {
      clearQueuedInject()
      return
    }
    if (rotating && !stopped && machine.status === 'listening') {
      void rotating.then(() => flushQueuedInject())
      return
    }
    if (!canInjectNow()) return
    clearQueuedInject()
    sendInject(q.text, q.reason)
  }

  function inject(contextText: string, reason: CallInjectReason): CallInjectOutcome {
    const text = typeof contextText === 'string' ? contextText.trim() : ''
    const status = machine.status
    if (!text || stopped || test || status === 'idle' || status === 'ended') return 'dropped'
    if (canInjectNow()) {
      clearQueuedInject()
      sendInject(text, reason)
      return 'sent'
    }
    if (!isCallActiveStatus(status) && status !== 'connecting' && status !== 'reconnecting') return 'dropped'
    clearQueuedInject()
    const entry: { text: string; reason: CallInjectReason; at: number; timer: unknown } = {
      text,
      reason,
      at: now(),
      timer: null,
    }
    entry.timer = timers.setTimeout(() => {
      if (queuedInject === entry) {
        queuedInject = null
        log(`queued inject (${reason}) expired`)
      }
    }, INJECT_QUEUE_TTL_MS)
    queuedInject = entry
    // Listening but momentarily not free (e.g. rotating): retry when it settles.
    if (status === 'listening') void Promise.resolve().then(() => flushQueuedInject())
    return 'queued'
  }

  function clearInitiativeTimer(): void {
    if (initiativeTimer !== null) {
      timers.clearTimeout(initiativeTimer)
      initiativeTimer = null
    }
  }

  /** (Re)starts the silence timer; only while listening and with `features.initiativeInCall`. */
  function armInitiative(): void {
    clearInitiativeTimer()
    if (!initiativeEnabled || stopped || machine.status !== 'listening') return
    initiativeTimer = timers.setTimeout(() => {
      initiativeTimer = null
      void checkInitiative()
    }, idleNudgeMs)
  }

  async function checkInitiative(): Promise<void> {
    if (stopped || machine.status !== 'listening') return
    if (muted || queuedInject || initiativeInFlight || ledger || typeof host.checkInitiative !== 'function') {
      armInitiative()
      return
    }
    initiativeInFlight = true
    let res: Awaited<ReturnType<typeof host.checkInitiative>> | null = null
    try {
      res = await host.checkInitiative({ callId, idleMs: Math.round(now() - listeningSince) })
    } catch (err) {
      log('checkInitiative failed', err)
    } finally {
      initiativeInFlight = false
    }
    if (stopped || machine.status !== 'listening') return
    const ctx = res?.speak ? (res.contextText ?? '').trim() : ''
    if (ctx && !muted && inject(ctx, 'initiative') !== 'dropped') return
    armInitiative()
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
    if (test && !test.committed) {
      if (ev.type === 'speech_start' && test.speechStartAt === null) test.speechStartAt = now()
      if (ev.type === 'speech_end' && status === 'user_speaking') test.speechEndAt = now()
    }
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
    processStage(l, false)
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
      if (test && test.ttfbMs === undefined) test.ttfbMs = l.metrics.ttfbMs
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
      tickStage()
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
      if (test) test.playbackDetail = detail
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
    if (l.tool && !e.cancelled && l.chunks.length === 0) {
      // Phase 10.3: the spoken answer called a tool anyway (tool_choice ignored) → another round;
      // or it produced only text → speak that text (once).
      const calls = e.toolCalls ?? []
      if (calls.length > 0 && l.tool.rounds < MAX_TOOL_ROUNDS) {
        void runToolRound(l, calls)
        return
      }
      if (stripMarkers(l.text).trim() && !l.tool.fallbackUsed) {
        speakFallback(l, l.text)
        return
      }
    }
    if (l.chunks.length === 0) {
      // No audio at all: nothing was heard.
      if (test) test.playbackDetail = 'response had no audio'
      void finalizeLedger(l, { interrupted: false, playedMs: 0, spokenOverride: '' })
      ledger = null
      releaseTurnLease()
      turn = null
      caption = { role: 'assistant', text: stripMarkers(l.text).trim().slice(0, 4000), final: true }
      dispatch({ type: 'response_failed' })
      return
    }
    caption = { role: 'assistant', text: stripMarkers(l.text).trim().slice(0, 4000), final: false }
    processStage(l, true)
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
      s.on('tool_step_started', (e) => s === session && onToolStepStarted(e)),
      s.on('tool_call', (e) => s === session && onToolCall(e)),
      s.on('tool_step_done', (e) => s === session && onToolStepDone(e)),
      s.on('closed', (e) => s === session && onSessionClosed(e)),
      s.on('error', (e) => s === session && onSessionError(e)),
    ]
  }

  async function openSession(): Promise<void> {
    const s = options.createSession()
    session = s
    attachSession(s)
    await s.connect(sessionInit())
    sessionTurns = 0
    sessionTokens = tokensOf(instructions)
    rotationDue = null
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
          // The new session knows nothing of the call so far: seed it like a rotation.
          pendingRecap = buildSessionRecap(exchanges, lastUserLabel ? { userLabel: lastUserLabel } : {})
          sessionTokens += tokensOf(pendingRecap)
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
    clearTestTimers()
    clearInitiativeTimer()
    clearQueuedInject()
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

  // ───────────────────────── test mode (Phase 10.2) ─────────────────────────

  function clearTestTimers(): void {
    if (!test) return
    if (test.feedTimer !== null) {
      timers.clearInterval(test.feedTimer)
      test.feedTimer = null
    }
    if (test.timeoutTimer !== null) {
      timers.clearTimeout(test.timeoutTimer)
      test.timeoutTimer = null
    }
  }

  /** Decodes the test WAV to mono 16 kHz float samples (throws on a malformed file). */
  async function prepareTestInput(): Promise<void> {
    if (!test || !testInput) return
    const decoded = decodeWavToPcmBlocks(base64ToUint8Array(testInput.wavBase64), TEST_BLOCK_MS)
    if (decoded.samples.length === 0) throw new Error('test input: empty audio')
    test.samples =
      decoded.sampleRate === CAPTURE_RATE ? decoded.samples : resampleFloat32(decoded.samples, decoded.sampleRate, CAPTURE_RATE)
  }

  /** Feeds the WAV through the capture → detector pipeline in real time (20 ms blocks), then silence. */
  function startTestFeed(): void {
    const t = test
    if (!t || !t.samples) return
    const samples = t.samples
    const blockSamples = Math.round((CAPTURE_RATE * TEST_BLOCK_MS) / 1000)
    const silenceMs = Math.max(TEST_TRAILING_SILENCE_MS, turnCfg.endpointMs + 500)
    const totalSamples = samples.length + Math.round((silenceMs / 1000) * CAPTURE_RATE)
    const totalBlocks = Math.ceil(totalSamples / blockSamples)
    const t0 = now()
    t.feedStartedAt = t0
    let pushed = 0
    const pushDue = () => {
      if (stopped) return
      const due = Math.min(totalBlocks, Math.floor((now() - t0) / TEST_BLOCK_MS) + 1)
      while (pushed < due) {
        const from = pushed * blockSamples
        const chunk = new Float32Array(blockSamples)
        if (from < samples.length) chunk.set(samples.subarray(from, Math.min(samples.length, from + blockSamples)))
        pushed += 1
        onCaptureBlock(capture.pushAecFrame(chunk))
      }
      if (pushed >= totalBlocks && t.feedTimer !== null) {
        timers.clearInterval(t.feedTimer)
        t.feedTimer = null
      }
    }
    t.feedTimer = timers.setInterval(pushDue, TEST_BLOCK_MS)
    pushDue()
  }

  function buildTestResult(why?: string): CallReportTestResultInput {
    const t = test!
    const failDetail = (fallback: string) => (why ? `${fallback} (${why})` : fallback)
    const vadOk = t.speechStartAt !== null && t.speechEndAt !== null
    const similarity = t.transcript && testInput ? textSimilarity(t.transcript, testInput.expectedText) : 0
    const steps: CallReportTestResultInput['steps'] = [
      {
        step: 'engine',
        ok: t.engineOk,
        ...(t.engineMs !== undefined ? { ms: t.engineMs } : {}),
        ...(!t.engineOk ? { detail: failDetail(t.engineDetail ?? 'engine did not start') } : {}),
      },
      {
        step: 'session',
        ok: t.sessionOk,
        ...(t.sessionMs !== undefined ? { ms: t.sessionMs } : {}),
        ...(!t.sessionOk ? { detail: failDetail(t.sessionDetail ?? 'no session handshake') } : {}),
      },
      {
        step: 'vad',
        ok: vadOk,
        ...(vadOk && t.feedStartedAt !== null ? { ms: Math.round(t.speechEndAt! - t.feedStartedAt) } : {}),
        ...(!vadOk
          ? { detail: failDetail(t.speechStartAt === null ? 'speech not detected' : 'end of speech not detected') }
          : {}),
      },
      {
        step: 'transcription',
        ok: Boolean(t.transcript),
        ...(t.asrMs !== undefined ? { ms: t.asrMs } : {}),
        detail: t.transcript
          ? `similarity ${similarity.toFixed(2)} with the expected text`
          : failDetail(t.transcriptionDetail ?? (t.asrMs !== undefined ? 'empty transcription' : 'not reached')),
      },
      {
        step: 'first_audio',
        ok: t.ttfbMs !== undefined,
        ...(t.ttfbMs !== undefined ? { ms: t.ttfbMs } : { detail: failDetail('no audio received') }),
      },
      {
        step: 'playback',
        ok: t.playbackOk,
        ...(t.playbackMs !== undefined ? { ms: t.playbackMs } : {}),
        ...(!t.playbackOk ? { detail: failDetail(t.playbackDetail ?? 'playback did not finish') } : {}),
      },
    ]
    for (const st of steps) if (st.detail) st.detail = st.detail.slice(0, 500)
    return {
      callId,
      ok: steps.every((st) => st.ok),
      steps,
      metrics: t.metrics ?? metrics,
      transcript: t.transcript ? t.transcript.slice(0, 4000) : null,
      reply: t.reply ? t.reply.slice(0, 4000) : null,
    }
  }

  async function reportTest(why?: string): Promise<void> {
    if (!test || test.reported) return
    test.reported = true
    clearTestTimers()
    if (!test.metrics && metrics) test.metrics = { ...metrics }
    if (test.reply === null && ledger) test.reply = stripMarkers(ledger.text).trim() || null
    const result = buildTestResult(why)
    log('test call result', result)
    if (typeof host.reportTestResult !== 'function') return
    try {
      await host.reportTestResult(result)
    } catch (err) {
      log('reportTestResult failed', err)
    }
  }

  /** One test turn is over (or timed out): report, then hang up. */
  async function finishTest(why?: string): Promise<void> {
    if (!test || test.reported) return
    await reportTest(why)
    if (!stopped) await stop('user_hangup')
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

    const startedAt = now()
    if (test) test.startedAt = startedAt
    const sessionPromise = (async () => {
      const ctx = await host.buildContext({ callId })
      instructions = ctx?.instructions ?? ''
      sessionTools = Array.isArray(ctx?.tools)
        ? ctx.tools.filter((t) => t && t.type === 'function' && typeof t.name === 'string' && t.name.length > 0)
        : []
      const t0 = now()
      await openSession()
      if (test) test.sessionMs = Math.round(now() - t0)
    })()
    // Test call: the WAV replaces the microphone (no getUserMedia at all).
    const capturePromise = test
      ? prepareTestInput()
      : capture.startMicrophoneCapture({
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
    if (test) {
      test.sessionOk = sessionRes.status === 'fulfilled'
      if (sessionRes.status === 'rejected') test.sessionDetail = String((sessionRes.reason as Error)?.message ?? sessionRes.reason)
    }
    if (failure) {
      detail = failure.detail
      await teardown()
      machine = transitionCall(machine, { type: 'fatal', reason: failure.reason, detail: failure.detail })
      report()
      finishToIdle()
      if (test) {
        test.engineDetail = failure.detail
        await reportTest()
      }
      return 'ended'
    }
    if (detectorRes.status === 'fulfilled') log(`vad engine: ${detectorRes.value}`)
    dispatch({ type: 'connected' })
    if (test && machine.status === 'listening') {
      const t = test
      const timeoutMs = options.testTimeoutMs ?? TEST_TIMEOUT_MS
      t.engineOk = true
      t.engineMs = Math.round(now() - startedAt)
      t.timeoutTimer = timers.setTimeout(() => {
        t.timeoutTimer = null
        void finishTest(`timeout after ${Math.round(timeoutMs / 1000)} s`)
      }, timeoutMs)
      startTestFeed()
    }
    return machine.status
  }

  async function stop(reason: CallEndReason = 'user_hangup', stopDetail?: string): Promise<void> {
    if (stopped && (machine.status === 'idle' || machine.status === 'ended')) return
    if (test && !test.reported) await reportTest('call stopped before the test finished')
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
    inject,
  }
}
