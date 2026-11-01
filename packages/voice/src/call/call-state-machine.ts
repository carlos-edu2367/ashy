/**
 * Phase 10.1 — pure call state machine (spec §6.1). No audio, no timers: the CallEngine feeds
 * events and reads the resulting status. Invalid events return the SAME state object, so callers
 * can detect a rejected transition with `next === prev`.
 *
 * The contract's CALL_STATUSES has no `interrupted` status: a confirmed barge-in goes from
 * `interrupt_pending` straight to `user_speaking` (the fade + receipt happen in the engine).
 */
import type { CallEndReason, CallStatus } from '@ashy/shared'

export interface CallMachineState {
  status: CallStatus
  reason: CallEndReason | null
  detail: string | null
  reconnectAttempts: number
}

export type CallMachineEvent =
  | { type: 'start' }
  | { type: 'connected' }
  /** VAD onset confirmed (≥ minSpeechMs) while nobody is talking. */
  | { type: 'speech_confirmed' }
  /** Silence ≥ endpointMs: user turn committed. */
  | { type: 'turn_end' }
  /** Phase 10.3: the engine speaks on its own (approval result / initiative) while listening. */
  | { type: 'proactive_response' }
  /** Short silence / unconfirmed onset: back to listening (grace). */
  | { type: 'turn_incomplete' }
  /** First audio sample scheduled/played. */
  | { type: 'first_audio_played' }
  /** User speaks again while waiting for the answer (response cancelled, nothing saved). */
  | { type: 'user_resumed' }
  /** VAD onset while the assistant is speaking. */
  | { type: 'speech_onset_during_playback' }
  /** Barge-in confirmed (≥ bargeInMinMs): fade + receipt, then the user has the floor. */
  | { type: 'barge_in_confirmed' }
  /** Nothing confirmed within falseInterruptionMs: resume speaking. */
  | { type: 'false_interruption' }
  /** Playback queue drained after response_done. */
  | { type: 'queue_drained' }
  /** The turn produced no response (e.g. empty transcription / response failed). */
  | { type: 'response_failed' }
  | { type: 'backend_error'; maxAttempts: number; reason?: CallEndReason; detail?: string }
  | { type: 'reconnected' }
  | { type: 'fatal'; reason: CallEndReason; detail?: string }
  | { type: 'stop'; reason?: CallEndReason; detail?: string }
  | { type: 'reset' }

export function createInitialCallMachineState(): CallMachineState {
  return { status: 'idle', reason: null, detail: null, reconnectAttempts: 0 }
}

const ACTIVE_STATUSES: ReadonlySet<CallStatus> = new Set<CallStatus>([
  'listening',
  'user_speaking',
  'thinking',
  'speaking',
  'interrupt_pending',
])

export function isCallActiveStatus(status: CallStatus): boolean {
  return ACTIVE_STATUSES.has(status)
}

function to(state: CallMachineState, status: CallStatus, patch: Partial<CallMachineState> = {}): CallMachineState {
  return { ...state, status, ...patch }
}

export function transitionCall(state: CallMachineState, event: CallMachineEvent): CallMachineState {
  const s = state.status

  // Global transitions.
  if (event.type === 'stop') {
    if (s === 'idle' || s === 'ended') return state
    return to(state, 'ended', { reason: event.reason ?? 'user_hangup', detail: event.detail ?? null })
  }
  if (event.type === 'reset') {
    if (s !== 'ended') return state
    return createInitialCallMachineState()
  }
  if (event.type === 'fatal') {
    if (s === 'idle' || s === 'ended') return state
    return to(state, 'ended', { reason: event.reason, detail: event.detail ?? null })
  }
  if (event.type === 'backend_error') {
    if (s === 'idle' || s === 'ended') return state
    if (s === 'connecting') {
      return to(state, 'ended', {
        reason: event.reason ?? 'backend_unavailable',
        detail: event.detail ?? null,
      })
    }
    const attempts = state.reconnectAttempts + 1
    if (attempts > event.maxAttempts) {
      return to(state, 'ended', {
        reason: event.reason ?? 'backend_error',
        detail: event.detail ?? null,
        reconnectAttempts: attempts,
      })
    }
    return to(state, 'reconnecting', { reconnectAttempts: attempts, detail: event.detail ?? null })
  }

  switch (s) {
    case 'idle':
      return event.type === 'start' ? to(state, 'connecting', { reason: null, detail: null, reconnectAttempts: 0 }) : state
    case 'connecting':
      return event.type === 'connected' ? to(state, 'listening') : state
    case 'reconnecting':
      return event.type === 'reconnected' ? to(state, 'listening', { reconnectAttempts: 0, detail: null }) : state
    case 'listening':
      if (event.type === 'speech_confirmed') return to(state, 'user_speaking')
      if (event.type === 'proactive_response') return to(state, 'thinking')
      return state
    case 'user_speaking':
      if (event.type === 'turn_end') return to(state, 'thinking')
      if (event.type === 'turn_incomplete') return to(state, 'listening')
      return state
    case 'thinking':
      if (event.type === 'first_audio_played') return to(state, 'speaking')
      if (event.type === 'user_resumed' || event.type === 'speech_confirmed') return to(state, 'user_speaking')
      if (event.type === 'response_failed' || event.type === 'queue_drained') return to(state, 'listening')
      return state
    case 'speaking':
      if (event.type === 'speech_onset_during_playback') return to(state, 'interrupt_pending')
      if (event.type === 'barge_in_confirmed') return to(state, 'user_speaking')
      if (event.type === 'queue_drained') return to(state, 'listening')
      return state
    case 'interrupt_pending':
      if (event.type === 'barge_in_confirmed') return to(state, 'user_speaking')
      if (event.type === 'false_interruption') return to(state, 'speaking')
      if (event.type === 'queue_drained') return to(state, 'listening')
      return state
    case 'ended':
      return state
    default:
      return state
  }
}
