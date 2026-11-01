// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeWavPcm16, uint8ArrayToBase64 } from '@ashy/voice'
import type { AshyBootstrapSnapshot, AshyHostBridge, AshyHostStreamEvent } from '@ashy/shared'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { getVoiceRuntimeForTesting, resetAshyStore, useAshyStore } from '../store/useAshyStore'

interface FakeSourceNode {
  buffer: unknown
  connect: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  onended: (() => void) | null
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  currentTime = 0
  sampleRate = 48000
  state = 'suspended'
  destination = {}
  sources: FakeSourceNode[] = []
  resume = vi.fn(async () => {
    this.state = 'running'
  })
  constructor() {
    FakeAudioContext.instances.push(this)
  }
  createGain() {
    return {
      gain: {
        value: 1,
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length)
    return { duration: length / sampleRate, getChannelData: () => data }
  }
  createBufferSource() {
    const node: FakeSourceNode = {
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    }
    this.sources.push(node)
    return node
  }
}

function installFakeAudioContext(): void {
  Object.defineProperty(window, 'AudioContext', {
    value: FakeAudioContext,
    configurable: true,
    writable: true,
  })
}

function uninstallFakeAudioContext(): void {
  delete (window as unknown as Record<string, unknown>).AudioContext
}

const spoken: string[] = []
function installFakeSpeechSynthesis(): void {
  spoken.length = 0
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      cancel: vi.fn(),
      getVoices: vi.fn(() => [{ lang: 'pt-BR', name: 'Maria' }]),
      speak: vi.fn((u: { text: string }) => {
        spoken.push(u.text)
      }),
    },
    configurable: true,
    writable: true,
  })
  class FakeUtterance {
    text: string
    lang = ''
    rate = 1
    pitch = 1
    voice: unknown = null
    constructor(text: string) {
      this.text = text
    }
  }
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    value: FakeUtterance,
    configurable: true,
    writable: true,
  })
}

function sineWavBase64(durationSec: number, sampleRate = 24000): string {
  const samples = new Float32Array(Math.round(durationSec * sampleRate))
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sampleRate)
  }
  return uint8ArrayToBase64(encodeWavPcm16(samples, sampleRate))
}

const REPLY = 'Oi Carlos! Agora você consegue me ouvir de verdade.'

function emit(event: AshyHostStreamEvent): void {
  useAshyStore.getState().handleHostStreamEvent(event)
}

function runOmniTurn(turnId: string, withAudio = true): void {
  emit({
    type: 'turn:started',
    turnId,
    sessionId: 'session-default',
    startedAt: Date.now(),
  } as AshyHostStreamEvent)
  emit({ type: 'turn:delta', turnId, sessionId: 'session-default', textDelta: REPLY })
  if (withAudio) {
    emit({
      type: 'turn:audio-delta',
      turnId,
      sessionId: 'session-default',
      seq: 0,
      audioBase64: sineWavBase64(1),
      format: 'wav',
      sampleRate: 24000,
      durationMs: 1000,
      transcriptDelta: REPLY,
      vowelFrames: [
        { timeSec: 0, durationSec: 0.5, A: 0.8, E: 0.1, I: 0, O: 0, U: 0, dominantVowel: 'A' },
        { timeSec: 0.5, durationSec: 0.5, A: 0.1, E: 0, I: 0, O: 0.7, U: 0, dominantVowel: 'O' },
      ],
    })
  }
  emit({
    type: 'turn:completed',
    turnId,
    sessionId: 'session-default',
    assistantMessage: {
      id: `msg-assistant-${turnId}`,
      sessionId: 'session-default',
      role: 'assistant',
      content: REPLY,
      rawContent: REPLY,
      markersJson: '[]',
      emotion: 'happy',
      createdAt: Date.now(),
    },
    snapshot: undefined as unknown as AshyBootstrapSnapshot,
    persistenceWarning: null,
  } as AshyHostStreamEvent)
}

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('@ashy/desktop — Phase 10.0 (T3): audible voice playback in the renderer', () => {
  beforeEach(() => {
    FakeAudioContext.instances = []
    setAshyHostBridgeForTesting(null)
    installFakeSpeechSynthesis()
    resetAshyStore()
  })

  afterEach(() => {
    uninstallFakeAudioContext()
    setAshyHostBridgeForTesting(null)
    resetAshyStore()
  })

  it('creates and resumes one shared AudioContext on the voice toggle gesture and binds it to the player', async () => {
    installFakeAudioContext()
    await useAshyStore.getState().toggleVoiceConversation(true)
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(FakeAudioContext.instances[0]!.resume).toHaveBeenCalled()
    expect(getVoiceRuntimeForTesting().getPlayer().hasAudioOutput()).toBe(true)

    await useAshyStore.getState().toggleVoiceConversation(false)
    await useAshyStore.getState().toggleVoiceConversation(true)
    expect(FakeAudioContext.instances).toHaveLength(1)
  })

  it('plays turn:audio-delta through real buffer sources, keeps speaking until the real drain, then closes the mouth', async () => {
    installFakeAudioContext()
    useAshyStore.getState().applyOmniModelPreset('lfm3-omni-2b')
    await useAshyStore.getState().toggleVoiceConversation(true)
    const ctx = FakeAudioContext.instances[0]!
    ctx.state = 'running'

    runOmniTurn('turn-audible-1')
    await flush()

    expect(ctx.sources).toHaveLength(1)
    expect(ctx.sources[0]!.start).toHaveBeenCalledTimes(1)
    // No browser-TTS double speak while the omni WAV is audible
    expect(spoken).toHaveLength(0)

    // The estimate (350 ms) has passed but real audio is still playing
    await flush(450)
    expect(useAshyStore.getState().isSpeaking).toBe(true)

    ctx.currentTime = 1.05
    ctx.sources[0]!.onended?.()
    const after = useAshyStore.getState()
    expect(after.isSpeaking).toBe(false)
    expect(after.activeViseme).toBe('closed')
    expect(after.rawVolume).toBe(0)
  })

  it('triggerBargeIn stops the player sources even after turn:completed', async () => {
    installFakeAudioContext()
    useAshyStore.getState().applyOmniModelPreset('lfm3-omni-2b')
    await useAshyStore.getState().toggleVoiceConversation(true)
    const ctx = FakeAudioContext.instances[0]!
    ctx.state = 'running'

    runOmniTurn('turn-barge-1')
    await flush()
    expect(useAshyStore.getState().activeTurnId).toBeNull()

    ctx.currentTime = 0.4
    useAshyStore.getState().triggerBargeIn()
    expect(ctx.sources[0]!.stop).toHaveBeenCalled()
    expect(getVoiceRuntimeForTesting().getPlayer().isPlaying()).toBe(false)
    expect(useAshyStore.getState().isSpeaking).toBe(false)
  })

  it('falls back to browser TTS when omni audio arrived but could not be played (no AudioContext)', async () => {
    uninstallFakeAudioContext()
    useAshyStore.getState().applyOmniModelPreset('lfm3-omni-2b')

    runOmniTurn('turn-unplayable-1')
    await flush(40)

    expect(spoken.join(' ')).toContain('Oi Carlos')
    expect(useAshyStore.getState().scheduledAudioChunks.length).toBeGreaterThan(0)
  })

  it('web-speech-tts speaks via speechSynthesis and never asks the host to synthesize', async () => {
    const synthesizeVoiceSpeech = vi.fn(async () => {
      throw new Error('use-browser-tts')
    })
    setAshyHostBridgeForTesting({ synthesizeVoiceSpeech } as unknown as AshyHostBridge)
    useAshyStore.setState((s) => ({
      isBootstrapped: true,
      voiceSettings: { ...s.voiceSettings, activeTtsProviderId: 'web-speech-tts' },
    }))

    runOmniTurn('turn-webspeech-1', false)
    await flush(40)

    expect(synthesizeVoiceSpeech).not.toHaveBeenCalled()
    expect(spoken.join(' ')).toContain('Oi Carlos')
  })

  it('routes cascade host-TTS audio through the shared player in order', async () => {
    installFakeAudioContext()
    await useAshyStore.getState().toggleVoiceConversation(true)
    const ctx = FakeAudioContext.instances[0]!
    const synthesizeVoiceSpeech = vi.fn(async () => ({
      audioBase64: sineWavBase64(0.3),
      mimeType: 'audio/wav',
      durationMs: 300,
      durationSec: 0.3,
      vowelFrames: [],
    }))
    setAshyHostBridgeForTesting({ synthesizeVoiceSpeech } as unknown as AshyHostBridge)
    useAshyStore.setState((s) => ({
      isBootstrapped: true,
      voiceSettings: { ...s.voiceSettings, activeTtsProviderId: 'openai-tts' },
    }))

    runOmniTurn('turn-cascade-1', false)
    await flush(60)

    expect(synthesizeVoiceSpeech).toHaveBeenCalled()
    expect(ctx.sources.length).toBeGreaterThan(0)
    expect(ctx.sources[0]!.start).toHaveBeenCalled()
  })

  it('drops omni clips shorter than 400 ms before the IPC and ignores the host short-audio placeholder', async () => {
    const sendTurn = vi.fn(async () => ({
      turnId: 'turn-short',
      userMessage: {
        id: 'msg-user-short',
        sessionId: 'session-default',
        role: 'user',
        content: '🎤 (áudio curto ignorado)',
        rawContent: '🎤 (áudio curto ignorado)',
        markersJson: '[]',
        emotion: 'neutral',
        createdAt: Date.now(),
      },
    }))
    setAshyHostBridgeForTesting({ sendTurn } as unknown as AshyHostBridge)
    useAshyStore.setState({ isBootstrapped: true })
    const turn = {
      wavBytes: new Uint8Array(0),
      wavBase64: sineWavBase64(0.2, 16000),
      mimeType: 'audio/wav' as const,
      sampleRate: 16000 as const,
      durationMs: 200,
      rmsPeak: 0.3,
      preRollBlocksCount: 0,
      revision: 1,
      reason: 'vad-silence' as const,
    }
    await useAshyStore.getState().sendOmniAudioTurn(turn)
    expect(sendTurn).not.toHaveBeenCalled()

    const before = useAshyStore.getState().chatMessages.length
    await useAshyStore.getState().sendOmniAudioTurn({ ...turn, durationMs: 900, transcriptHint: 'oi' })
    expect(sendTurn).toHaveBeenCalledTimes(1)
    expect(useAshyStore.getState().chatMessages).toHaveLength(before)
  })
})
