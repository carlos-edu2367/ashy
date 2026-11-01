/**
 * Phase 10.1 — Live Call Engine types (renderer side, pure TS).
 * Spec: docs/superpowers/specs/2026-10-31-phase-10-live-call-engine-design.md §5.3, §6.
 *
 * Every browser API (WebSocket, AudioContext, getUserMedia, fetch, timers) is injected so the
 * engine runs (and is tested) in plain node.
 */
import type {
  CallCaption,
  CallContextResult,
  CallEndReason,
  CallMetrics,
  CallStatus,
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
}

export interface VoiceSessionInit {
  /** Session instructions, always provided by the host (`call:buildContext`). Never invented by the session. */
  instructions: string
  voice?: string
}

export type VoiceSessionCancelReason = 'client' | 'watchdog' | 'server'

export interface VoiceSessionEventMap {
  user_speech_started: Record<string, never>
  user_speech_stopped: Record<string, never>
  user_transcript: { text: string; final: boolean }
  response_started: { responseId: string }
  response_text: { responseId: string; delta: string; text: string }
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
  }
  tool_call: { callId: string; name: string; arguments: string }
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
  respond(opts?: { contextText?: string }): void
  /** transcribed mode: context item (when non-empty), then user text item, then response.create. */
  submitUserText?(text: string, contextText?: string): void
  cancelResponse(reason?: VoiceSessionCancelReason): void
  truncate?(itemId: string, playedMs: number): Promise<void>
  injectContext(text: string): Promise<void>
  sendToolResult(callId: string, output: string): void
  sendImage?(jpegBase64: string): void
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

/** Implemented by the call-engine window glue on top of `liveCall:invoke`. */
export interface CallEngineHost {
  buildContext(input: CallBuildContextInput): Promise<CallContextResult>
  transcribe(input: CallTranscribeInput): Promise<CallTranscribeResult>
  recordTurn(input: CallRecordTurnInput): Promise<unknown>
  reportState(input: CallReportStateInput): Promise<unknown> | void
  reportViseme(frame: CallVisemeFrame): Promise<unknown> | void
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
