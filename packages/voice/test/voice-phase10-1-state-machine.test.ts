import { describe, expect, it } from 'vitest'
import {
  createInitialCallMachineState,
  isCallActiveStatus,
  transitionCall,
  type CallMachineEvent,
  type CallMachineState,
} from '../src'

function run(events: CallMachineEvent[], from: CallMachineState = createInitialCallMachineState()): CallMachineState {
  return events.reduce(transitionCall, from)
}

describe('Phase 10.1 call state machine (spec §6.1)', () => {
  it('walks the happy path idle → connecting → listening → user_speaking → thinking → speaking → listening', () => {
    const seen: string[] = []
    let s = createInitialCallMachineState()
    for (const e of [
      { type: 'start' },
      { type: 'connected' },
      { type: 'speech_confirmed' },
      { type: 'turn_end' },
      { type: 'first_audio_played' },
      { type: 'queue_drained' },
    ] as CallMachineEvent[]) {
      s = transitionCall(s, e)
      seen.push(s.status)
    }
    expect(seen).toEqual(['connecting', 'listening', 'user_speaking', 'thinking', 'speaking', 'listening'])
  })

  it('handles grace (turn_incomplete) and user resuming while thinking', () => {
    expect(run([{ type: 'start' }, { type: 'connected' }, { type: 'speech_confirmed' }, { type: 'turn_incomplete' }]).status).toBe('listening')
    expect(
      run([{ type: 'start' }, { type: 'connected' }, { type: 'speech_confirmed' }, { type: 'turn_end' }, { type: 'user_resumed' }]).status,
    ).toBe('user_speaking')
    expect(
      run([{ type: 'start' }, { type: 'connected' }, { type: 'speech_confirmed' }, { type: 'turn_end' }, { type: 'response_failed' }]).status,
    ).toBe('listening')
  })

  it('interrupt_pending: false interruption restores speaking, confirmed barge-in hands the floor to the user', () => {
    const speaking = run([
      { type: 'start' },
      { type: 'connected' },
      { type: 'speech_confirmed' },
      { type: 'turn_end' },
      { type: 'first_audio_played' },
    ])
    const pending = transitionCall(speaking, { type: 'speech_onset_during_playback' })
    expect(pending.status).toBe('interrupt_pending')
    expect(transitionCall(pending, { type: 'false_interruption' }).status).toBe('speaking')
    expect(transitionCall(pending, { type: 'barge_in_confirmed' }).status).toBe('user_speaking')
    expect(transitionCall(pending, { type: 'queue_drained' }).status).toBe('listening')
  })

  it('rejects invalid events by returning the same object', () => {
    const idle = createInitialCallMachineState()
    expect(transitionCall(idle, { type: 'connected' })).toBe(idle)
    const listening = run([{ type: 'start' }, { type: 'connected' }])
    expect(transitionCall(listening, { type: 'first_audio_played' })).toBe(listening)
    expect(transitionCall(listening, { type: 'barge_in_confirmed' })).toBe(listening)
  })

  it('backend errors reconnect up to maxAttempts, then end typed', () => {
    const listening = run([{ type: 'start' }, { type: 'connected' }])
    const r1 = transitionCall(listening, { type: 'backend_error', maxAttempts: 2 })
    expect(r1.status).toBe('reconnecting')
    expect(r1.reconnectAttempts).toBe(1)
    const back = transitionCall(r1, { type: 'reconnected' })
    expect(back.status).toBe('listening')
    expect(back.reconnectAttempts).toBe(0)

    const r2 = transitionCall(transitionCall(r1, { type: 'backend_error', maxAttempts: 2 }), {
      type: 'backend_error',
      maxAttempts: 2,
    })
    expect(r2.status).toBe('ended')
    expect(r2.reason).toBe('backend_error')

    const connecting = run([{ type: 'start' }])
    const failed = transitionCall(connecting, { type: 'backend_error', maxAttempts: 2 })
    expect(failed.status).toBe('ended')
    expect(failed.reason).toBe('backend_unavailable')
  })

  it('stop from any active state ends with user_hangup, reset returns to idle', () => {
    for (const events of [
      [{ type: 'start' }],
      [{ type: 'start' }, { type: 'connected' }],
      [{ type: 'start' }, { type: 'connected' }, { type: 'speech_confirmed' }, { type: 'turn_end' }, { type: 'first_audio_played' }],
    ] as CallMachineEvent[][]) {
      const ended = transitionCall(run(events), { type: 'stop' })
      expect(ended.status).toBe('ended')
      expect(ended.reason).toBe('user_hangup')
      expect(transitionCall(ended, { type: 'reset' }).status).toBe('idle')
    }
    const fatal = transitionCall(run([{ type: 'start' }]), { type: 'fatal', reason: 'mic_denied' })
    expect(fatal.reason).toBe('mic_denied')
    expect(isCallActiveStatus('speaking')).toBe(true)
    expect(isCallActiveStatus('ended')).toBe(false)
  })
})
