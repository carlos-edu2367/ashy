/**
 * Phase 10.1 — Live Call Engine types (renderer side, pure TS).
 * Spec: docs/superpowers/specs/2026-10-31-phase-10-live-call-engine-design.md §5.3, §6.
 *
 * Every browser API (WebSocket, AudioContext, getUserMedia, fetch, timers) is injected so the
 * engine runs (and is tested) in plain node.
 */
import type {
  CallCaption,
  CallCheckInitiativeResult,
  CallContextResult,
  CallExecuteToolResult,
  CallToolDefinition,
  CallEndReason,
  CallMetrics,
  CallStageSignal,
  CallStatus,
  CallSynthesizeResult,
  CallTestStep,
  CallTranscribeResult,
  CallVisemeFrame,
} from '@ashy/shared'

// ───────────────────────────── WebSocket injection ─────────────────────────────

/** Minimal WebSocket surface the sessions use (browser `WebSocket` is structurally compatible). */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
}

export type WebSocketFactory = (url: string) => WebSocketLike

export const WS_READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const

/** Default factory: the global `WebSocket` (browser / Electron renderer / node ≥ 22). */
export function createDefaultWebSocketFactory(): WebSocketFactory {
  return (url: string) => {
    const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => unknown }).WebSocket
    if (!Ctor) {
      throw new Error('WebSocket is not available in this environment')
    }
    return new Ctor(url) as WebSocketLike
  }
}

// ───────────────────────────── VoiceSession (spec §5.3) ─────────────────────────────

export interface VoiceSessionCapabilities {
  serverTurnDetection: boolean
  messageTruncation: boolean
  mutableInstructions: boolean
  contextInjection: 'instructions' | 'input_text_item' | 'client_content'
  userTranscription: boolean
  toolCalls: boolean
  imageInput: boolean
  speakerReference: boolean
  voices: string[]
  inputSampleRate: number
  outputSampleRate: number
  /**
   * Phase 10.4 (cloud speech-to-speech, with `serverTurnDetection`): the server starts every response
   * by itself when its VAD ends the user turn (Gemini Live, Qwen-Omni). Per-turn context is then
   * injected one turn lagged (`injectContext` after the user transcript). false/absent with server
   * VAD = the session emits `user_turn_committed` and waits for `respond()` (OpenAI
   * `create_response:false`), so the context of THIS turn rides in the response.
   */
  serverAutoResponse?: boolean
  /** Phase 10.4 — the model calls tools inside its normal spoken responses (no text-only tool step). */
  inlineToolCalls?: boolean
  /** Phase 10.4 — the server manages the context window itself: the engine never rotates the session. */
  managesContext?: boolean
}

export interface VoiceSessionInit {
  /** Session instructions, always provided by the host (`call:buildContext`). Never invented by the session. */
  instructions: string
  voice?: string
  /**
   * Phase 10.3 — function tools sent in `session.update` (with `tool_choice:'auto'`). llama.cpp only
   * accepts them before the first input, so a rotated / reconnected session must get them again.
   */
  tools?: CallToolDefinition[]
}

/** Phase 10.3 — per-turn tool policy (host decides from the user's words; see `CallContextResult.toolChoice`). */
export type VoiceToolChoice = 'auto' | 'none'

export interface VoiceSubmitOptions {
  /**
   * 'auto': the turn runs as a TEXT-only tool step (`response.create {tool_choice:'auto',
   * output_modalities:['text']}`) that emits `tool_step_started` / `tool_call` / `tool_step_done`
   * instead of the regular response events (audio-mode responses never call tools — 2026-11-01 spike).
   * 'none': plain spoken response with `tool_choice:'none'`. Omitted: `'none'` when the session has
   * tools, otherwise a bare `response.create` (pre-10.3 wire format).
   */
  toolChoice?: VoiceToolChoice
}

/** Phase 10.5 — a transcribed user turn handed to a host-LLM session (see `submitTranscribedTurn`). */
export interface VoiceTranscribedTurn {
  text: string
  /** Per-turn context (host `perTurnContext` + a pending recap), '' when none. */
  context: string
  userLabel?: string
  toolChoice?: VoiceToolChoice
  approvalHandled?: boolean
}

/** One completed function call of a response. */
export interface VoiceToolCall {
  callId: string
  name: string
  /** JSON string as produced by the model (may be malformed; the host validates). */
  arguments: string
}

/** Output of one executed tool, sent back as a `function_call_output` item. */
export interface VoiceToolResult {
  callId: string
  output: string
}

export type VoiceSessionCancelReason = 'client' | 'watchdog' | 'server'

export interface VoiceSessionEventMap {
  user_speech_started: Record<string, never>
  user_speech_stopped: Record<string, never>
  /** Server-VAD sessions: `itemId` = the backend's user item (OpenAI) when known. */
  user_transcript: { text: string; final: boolean; itemId?: string }
  /**
   * Phase 10.4 — server VAD committed a user audio turn and (no `serverAutoResponse`) the session
   * waits for `respond()` so the engine can inject this turn's context first.
   */
  user_turn_committed: { itemId?: string }
  response_started: { responseId: string }
  response_text: { responseId: string; delta: string; text: string }
  /**
   * Phase 10.5 — transient status caption while a response has produced nothing yet (e.g. the cascade
   * LLM is still loading: "carregando o modelo…"). Never part of the response text.
   */
  response_status: { responseId: string; text: string }
  /** PCM16 mono at `sampleRate` (llama.cpp: session.created.session.audio.output.format.rate, 24 kHz). */
  response_audio: { responseId: string; pcm: Int16Array; sampleRate: number }
  response_done: {
    responseId: string
    text: string
    audioMs: number
    cancelled: boolean
    cancelReason?: VoiceSessionCancelReason
    /** Watchdog diagnostic (why the response was cut). */
    detail?: string
    /** Phase 10.3 — function calls the (spoken) response produced anyway (e.g. tool_choice ignored). */
    toolCalls?: VoiceToolCall[]
  }
  /** One function call whose arguments are complete (`response.function_call_arguments.done`). */
  tool_call: { callId: string; name: string; arguments: string; responseId?: string }
  /** Phase 10.3 — a text-only tool step started (it emits no response_started / response_text). */
  tool_step_started: { responseId: string }
  /** Phase 10.3 — the tool step finished: its function calls (maybe none) and its text. */
  tool_step_done: {
    responseId: string
    text: string
    calls: VoiceToolCall[]
    cancelled: boolean
    cancelReason?: VoiceSessionCancelReason
    detail?: string
  }
  error: { message: string; code?: string; fatal: boolean }
  closed: { code?: number; reason?: string; expected: boolean }
}

export type VoiceSessionEvent = keyof VoiceSessionEventMap

export interface VoiceSession {
  readonly caps: VoiceSessionCapabilities
  connect(init: VoiceSessionInit): Promise<void>
  /** audio-direct: PCM16 mono at `caps.inputSampleRate`. */
  pushAudio(pcm: Int16Array): void
  commitUserTurn(): void
  respond(opts?: { contextText?: string } & VoiceSubmitOptions): void
  /**
   * transcribed mode: context item (when non-empty), then user text item, then response.create.
   * Phase 10.3: the second argument may be the options instead of a context string.
   */
  submitUserText?(text: string, contextOrOptions?: string | VoiceSubmitOptions, options?: VoiceSubmitOptions): void
  /**
   * Phase 10.5 — sessions whose LLM runs host-side with its own prompt (cascade) take the transcribed
   * turn as structured data instead of one formatted `input_text` item. When present the engine
   * prefers it over `submitUserText` and never runs its own tool step (tools run inside the host turn).
   */
  submitTranscribedTurn?(turn: VoiceTranscribedTurn): void
  /**
   * Phase 10.3 — one `function_call_output` item per result, then `response.create` (default
   * `tool_choice:'none'` with the session's output modalities = the spoken answer; 'auto' = another
   * text-only tool step).
   */
  submitToolResults?(results: VoiceToolResult[], options?: VoiceSubmitOptions): void
  /**
   * Phase 10.3 — speak a ready text without a new generation (no-tool fallback of a tool step), with
   * the regular response events. Sessions without their own TTS leave it undefined and the engine
   * speaks through `host.synthesize`.
   */
  speakText?(text: string): void
  cancelResponse(reason?: VoiceSessionCancelReason): void
  truncate?(itemId: string, playedMs: number): Promise<void>
  injectContext(text: string): Promise<void>
  sendToolResult(callId: string, output: string): void
  sendImage?(jpegBase64: string): void
  /**
   * Phase 10.4 — server-VAD sessions: the mic stream paused (mute) — drop/flush what the server
   * buffered (`input_audio_buffer.clear` / Gemini `audioStreamEnd`).
   */
  endAudioStream?(): void
  close(): Promise<void>
  on<E extends VoiceSessionEvent>(event: E, cb: (payload: VoiceSessionEventMap[E]) => void): () => void
}

// ───────────────────────────── Host bridge ─────────────────────────────

/** Mirrors `CallRecordTurnInputSchema` (packages/shared/src/live-call-protocol.ts). */
export interface CallRecordTurnInput {
  callId: string
  userTranscript: string
  assistantSpokenText: string
  assistantFullText?: string
  interrupted: boolean
  playedMs?: number
  emotion?: string
  metrics?: CallMetrics
  /** Phase 10.3 — set for turns Ashy started herself (inject); no user row is persisted. */
  injectReason?: 'approval' | 'initiative'
}

/** Mirrors `CallReportStateInputSchema`. */
export interface CallReportStateInput {
  callId: string
  status: CallStatus
  caption?: CallCaption | null
  metrics?: CallMetrics | null
  reason?: CallEndReason | null
  detail?: string | null
}

export interface CallBuildContextInput {
  callId: string
  userText?: string
  interruptedAfterText?: string
}

export interface CallTranscribeInput {
  callId: string
  audioWavBase64: string
  language?: string
}

/** Mirrors `CallClassifyAffectInputSchema`. */
export interface CallClassifyAffectInput {
  callId: string
  text: string
}

/** Mirrors `CallReportStageInputSchema`. */
export interface CallReportStageInput extends CallStageSignal {
  callId: string
}

/** Mirrors `CallSynthesizeInputSchema`. */
export interface CallSynthesizeInput {
  callId: string
  text: string
}

/** Mirrors `CallReportTestResultInputSchema`. */
export interface CallReportTestResultInput {
  callId: string
  ok: boolean
  steps: Array<{ step: CallTestStep; ok: boolean; ms?: number; detail?: string }>
  metrics?: CallMetrics | null
  transcript?: string | null
  reply?: string | null
}

/** Mirrors `CallExecuteToolInputSchema` (Phase 10.3). */
export interface CallExecuteToolInput {
  callId: string
  toolCallId: string
  name: string
  argsJson: string
}

/** Mirrors `CallCheckInitiativeInputSchema` (Phase 10.3). */
export interface CallCheckInitiativeInput {
  callId: string
  idleMs: number
}

/** Implemented by the call-engine window glue on top of `liveCall:invoke`. */
export interface CallEngineHost {
  buildContext(input: CallBuildContextInput): Promise<CallContextResult>
  transcribe(input: CallTranscribeInput): Promise<CallTranscribeResult>
  recordTurn(input: CallRecordTurnInput): Promise<unknown>
  reportState(input: CallReportStateInput): Promise<unknown> | void
  reportViseme(frame: CallVisemeFrame): Promise<unknown> | void
  /** Phase 10.2 — fast host heuristic (no LLM) for a sentence without an ACT marker (`call:classifyAffect`). */
  classifyAffect(input: CallClassifyAffectInput): Promise<CallStageSignal | null>
  /** Phase 10.2 — emitted when the segment carrying the signal starts playing (`call:reportStage`). */
  reportStage(input: CallReportStageInput): Promise<unknown>
  /** Phase 10.2 — test call outcome (`call:reportTestResult`). */
  reportTestResult(input: CallReportTestResultInput): Promise<unknown>
  /** Phase 10.2 — hybrid mode: /tts of one text chunk (`call:synthesize`); used by the hybrid session. */
  synthesize(input: CallSynthesizeInput): Promise<CallSynthesizeResult>
  /** Phase 10.3 — runs one model tool call through the host gatekeeper (`call:executeTool`). */
  executeTool(input: CallExecuteToolInput): Promise<CallExecuteToolResult>
  /** Phase 10.3 — asks the host whether to speak proactively after a silence (`call:checkInitiative`). */
  checkInitiative(input: CallCheckInitiativeInput): Promise<CallCheckInitiativeResult>
}

// ───────────────────────────── Timers / clock ─────────────────────────────

export interface CallTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export function createDefaultCallTimers(): CallTimers {
  return {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
  }
}

export function defaultNow(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance
  return perf && typeof perf.now === 'function' ? perf.now() : Date.now()
}

/** Tiny typed emitter used by sessions. */
export function createEmitter<M extends object>() {
  const listeners = new Map<keyof M, Set<(payload: never) => void>>()
  return {
    on<E extends keyof M>(event: E, cb: (payload: M[E]) => void): () => void {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(cb as (payload: never) => void)
      return () => {
        set!.delete(cb as (payload: never) => void)
      }
    },
    emit<E extends keyof M>(event: E, payload: M[E]): void {
      const set = listeners.get(event)
      if (!set) return
      for (const cb of [...set]) {
        try {
          ;(cb as (p: M[E]) => void)(payload)
        } catch {
          // listener errors never break the session
        }
      }
    },
    clear(): void {
      listeners.clear()
    },
  }
}
