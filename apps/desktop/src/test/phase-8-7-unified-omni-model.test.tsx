// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uint8ArrayToBase64 } from '@ashy/voice'
import type { AshyHostBridge, ChatMessageRecord } from '@ashy/shared'
import {
  createLiveWebcamSampler,
  createSyntheticVideoFrameDataUrl,
  deduplicateVideoFramesByDHash,
} from '../services/omni-media-sampler'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'
import { ModelsSettingsPanel } from '../components/ModelsSettingsPanel'
import { App } from '../App'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

function clickElement(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function queryByTestId<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return (container?.querySelector(`[data-testid="${testId}"]`) as T | null) ?? null
}

function getByTestId<T extends HTMLElement = HTMLElement>(testId: string): T {
  const el = queryByTestId<T>(testId)
  if (!el) {
    throw new Error(`Unable to find an element by: [data-testid="${testId}"]`)
  }
  return el
}

describe('@ashy/desktop — Phase 8.7: Unified Omni Model (LFM3-Omni-2B Local & Cloud), Webcam 2fps Sampler & Studio UI', () => {
  beforeEach(() => {
    setAshyHostBridgeForTesting(null)
    resetAshyStore()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
      root = null
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container)
    }
    container = null
    setAshyHostBridgeForTesting(null)
  })

  describe('1. Omni Media Sampler (2fps, dHash <= 4 Deduplication & Generation-ID Privacy Guard)', () => {
    it('creates synthetic video frames with valid base64 data URLs and deduplicates consecutive static frames with Hamming distance <= 4', () => {
      const f1 = createSyntheticVideoFrameDataUrl(1, 100, 'camera')
      const f1Clone = { ...f1, timestampMs: 600 }
      const f2 = createSyntheticVideoFrameDataUrl(99, 1100, 'camera')

      expect(f1.dataUrl).toMatch(/^data:image\/(?:jpeg|png);base64,/)
      expect(f1.dHashHex).toHaveLength(16)

      const deduped = deduplicateVideoFramesByDHash([f1, f1Clone, f2], 4, 8)
      expect(deduped).toHaveLength(2)
      expect(deduped[0]!.timestampMs).toBe(100)
      expect(deduped[1]!.timestampMs).toBe(1100)
    })

    it('immediately stops MediaStreamTracks if stop() is called while getUserMedia is still pending (MEDIUM-1 generationId race guard)', async () => {
      let stoppedCount = 0
      let resolveStream!: (stream: MediaStream) => void
      const pendingStreamPromise = new Promise<MediaStream>((resolve) => {
        resolveStream = resolve
      })

      const sampler = createLiveWebcamSampler({
        getUserMediaFn: () => pendingStreamPromise,
      })

      const startPromise = sampler.start()
      // Call stop() while getUserMedia is still in-flight
      sampler.stop()

      const fakeStream = {
        getTracks: () => [
          {
            stop: () => {
              stoppedCount += 1
            },
          },
        ],
      } as unknown as MediaStream

      resolveStream(fakeStream)
      const started = await startPromise
      expect(started).toBe(false)
      expect(sampler.isRunning()).toBe(false)
      expect(stoppedCount).toBe(1)
    })
  })

  describe('2. Store Unified Omni Presets, CRITICAL-1 Anti-Double-Speak & HIGH-3 Native Omni Barge-In', () => {
    it('applies LFM3-Omni-2B (Ollama Local) and cloud Omni presets cleanly', () => {
      useAshyStore.getState().applyOmniModelPreset('lfm3-omni-2b')
      let state = useAshyStore.getState()
      expect(state.providers.activeProviderId).toBe('ollama')
      expect(state.activeModelId).toBe('lfm3-omni:2b')
      expect(state.unifiedOmniMode).toBe(true)
      expect(state.directOmniAudio).toBe(true)
      expect(state.providers.configs.ollama.isOmniModel).toBe(true)
      expect(state.providers.configs.ollama.omniExecutionMode).toBe('native-omni')

      useAshyStore.getState().applyOmniModelPreset('gpt-4o-audio')
      state = useAshyStore.getState()
      expect(state.providers.activeProviderId).toBe('openai')
      expect(state.activeModelId).toBe('gpt-4o-audio-preview')
      expect(state.unifiedOmniMode).toBe(true)

      useAshyStore.getState().applyOmniModelPreset('qwen2.5-omni')
      state = useAshyStore.getState()
      expect(state.providers.activeProviderId).toBe('openrouter')
      expect(state.activeModelId).toBe('qwen/qwen2.5-omni-7b')

      useAshyStore.getState().applyOmniModelPreset('gemini-2.5-flash')
      state = useAshyStore.getState()
      expect(state.providers.activeProviderId).toBe('openrouter')
      expect(state.activeModelId).toBe('google/gemini-2.5-flash')
    })

    it('routes turn:input-transcript, turn:audio-delta without double-speaking on external TTS (CRITICAL-1), and computes PlaybackReceipt on barge-in (HIGH-3)', async () => {
      useAshyStore.getState().applyOmniModelPreset('lfm3-omni-2b')

      const sr = 24000
      const oneSecPcm16 = new Uint8Array(sr * 2)
      const b64Audio = uint8ArrayToBase64(oneSecPcm16)

      // Seed a user message and an assistant streaming message
      useAshyStore.setState((s) => ({
        activeStreamingTurnId: 'turn-omni-live-1',
        activeStreamingMessageId: 'msg-assistant-1',
        chatMessages: [
          ...s.chatMessages,
          {
            id: 'msg-user-1',
            role: 'user',
            content: '🎤 [Mensagem de voz enviada]',
            sender: 'user',
            text: '🎤 [Mensagem de voz enviada]',
            timestamp: '22:00',
          },
          {
            id: 'msg-assistant-1',
            role: 'assistant',
            content: '',
            sender: 'ashy',
            text: '',
            timestamp: '22:00',
          },
        ],
      }))

      // 1. turn:input-transcript updates user message bubble in-place
      useAshyStore.getState().handleHostStreamEvent({
        type: 'turn:input-transcript',
        turnId: 'turn-omni-live-1',
        sessionId: 'session-default',
        userMessageId: 'msg-user-1',
        transcript: 'Oi Ashy, o que você acha desse layout na webcam?',
        isFinal: true,
        source: 'omni-native',
      })

      expect(
        useAshyStore.getState().chatMessages.find((m) => m.id === 'msg-user-1')?.text,
      ).toBe('Oi Ashy, o que você acha desse layout na webcam?')

      // 2. turn:delta + turn:audio-delta does NOT double-speak on external TTS pipeline
      useAshyStore.getState().handleHostStreamEvent({
        type: 'turn:delta',
        turnId: 'turn-omni-live-1',
        sessionId: 'session-default',
        textDelta: 'Eu achei o layout bem limpo! ',
      })

      useAshyStore.getState().handleHostStreamEvent({
        type: 'turn:audio-delta',
        turnId: 'turn-omni-live-1',
        sessionId: 'session-default',
        seq: 0,
        audioBase64: b64Audio,
        format: 'pcm16',
        sampleRate: 24000,
        durationMs: 1000,
        transcriptDelta: 'Eu achei o layout bem limpo!',
        vowelFrames: [
          {
            timeSec: 0,
            durationSec: 1,
            A: 0.75,
            E: 0.1,
            I: 0.05,
            O: 0.05,
            U: 0.05,
            dominantVowel: 'A',
          },
        ],
      })

      useAshyStore.getState().handleHostStreamEvent({
        type: 'turn:audio-delta',
        turnId: 'turn-omni-live-1',
        sessionId: 'session-default',
        seq: 1,
        audioBase64: b64Audio,
        format: 'pcm16',
        sampleRate: 24000,
        durationMs: 1000,
        transcriptDelta: 'Mas podemos melhorar o contraste do botão.',
        vowelFrames: [
          {
            timeSec: 0,
            durationSec: 1,
            A: 0.2,
            E: 0.65,
            I: 0.05,
            O: 0.05,
            U: 0.05,
            dominantVowel: 'E',
          },
        ],
      })

      const midState = useAshyStore.getState()
      expect(midState.isSpeaking).toBe(true)
      expect(midState.presenceStatus).toBe('Speaking')
      expect(midState.rawVolume).toBeGreaterThan(0)

      // 3. Advance virtual clock by 1.0s and trigger Barge-In (HIGH-3)
      useAshyStore.getState().triggerBargeIn(1000)

      const afterBargeState = useAshyStore.getState()
      expect(afterBargeState.isSpeaking).toBe(false)
      expect(afterBargeState.lastPlaybackReceipt).not.toBeNull()
      expect(afterBargeState.lastPlaybackReceipt?.heardText).toContain(
        'Eu achei o layout bem limpo!',
      )
      expect(afterBargeState.lastPlaybackReceipt?.unheardText).toContain(
        'Mas podemos melhorar o contraste do botão.',
      )
      expect(afterBargeState.pendingInterruptionControlNote).toContain(
        '[User interrupted speech at',
      )
    })

    it('falls back to external TTS on turn:completed when native-omni is active but zero turn:audio-delta chunks were emitted (CRITICAL-1)', async () => {
      useAshyStore.getState().applyOmniModelPreset('lfm3-omni-2b')
      const now = Date.now()
      useAshyStore.setState({
        activeStreamingTurnId: 'turn-omni-text-only',
        activeStreamingMessageId: 'msg-a-text-only',
      })

      useAshyStore.getState().handleHostStreamEvent({
        type: 'turn:delta',
        turnId: 'turn-omni-text-only',
        sessionId: 'session-default',
        textDelta: 'Resposta apenas em texto do modelo omni.',
      })

      // During turn:delta in native-omni mode, external TTS must NOT fire eagerly
      expect(useAshyStore.getState().scheduledAudioChunks).toHaveLength(0)

      // When turn:completed arrives and 0 turn:audio-delta chunks were received, fallback TTS synthesizes audio
      useAshyStore.getState().handleHostStreamEvent({
        type: 'turn:completed',
        turnId: 'turn-omni-text-only',
        sessionId: 'session-default',
        assistantMessage: {
          id: 'msg-a-text-only',
          sessionId: 'session-default',
          role: 'assistant',
          content: 'Resposta apenas em texto do modelo omni.',
          rawContent: 'Resposta apenas em texto do modelo omni.',
          markersJson: '[]',
          emotion: 'happy',
          createdAt: now,
        },
        snapshot: undefined as unknown as import('@ashy/shared').AshyBootstrapSnapshot,
        persistenceWarning: null,
      })

      await new Promise((r) => setTimeout(r, 25))
      expect(useAshyStore.getState().scheduledAudioChunks.length).toBeGreaterThan(0)
    })

    it('sends sealed Omni audio turns + staged videoFrames + attachments through Host Bridge', async () => {
      const capturedSendTurnInputs: unknown[] = []
      const fakeBridge = {
        sendTurn: vi.fn(async (input: unknown) => {
          capturedSendTurnInputs.push(input)
          const now = Date.now()
          const userMsg: ChatMessageRecord = {
            id: 'msg-u-omni',
            sessionId: 'session-default',
            role: 'user',
            content: '🎤 [Áudio Omni]',
            rawContent: '🎤 [Áudio Omni]',
            markersJson: '[]',
            emotion: 'neutral',
            createdAt: now,
          }
          return {
            turnId: 'turn-omni-bridge-1',
            userMessage: userMsg,
          }
        }),
      } as unknown as AshyHostBridge

      setAshyHostBridgeForTesting(fakeBridge)
      useAshyStore.setState({ isBootstrapped: true })
      useAshyStore.getState().applyOmniModelPreset('lfm3-omni-2b')

      const frame = createSyntheticVideoFrameDataUrl(7, 500, 'camera')
      useAshyStore.getState().stageVideoFrames([frame])
      useAshyStore.getState().stageTurnAttachment({
        id: 'att-1',
        kind: 'image',
        mimeType: 'image/jpeg',
        dataUrlOrBase64: frame.dataUrl,
        name: 'captura.jpg',
      })

      await useAshyStore.getState().sendOmniAudioTurn({
        wavBytes: new Uint8Array([82, 73, 70, 70]),
        wavBase64: 'UklGRg==',
        mimeType: 'audio/wav',
        sampleRate: 16000,
        durationMs: 1200,
        rmsPeak: 0.25,
        preRollBlocksCount: 18,
        revision: 1,
        reason: 'vad-silence',
      })

      expect(capturedSendTurnInputs).toHaveLength(1)
      const sent = capturedSendTurnInputs[0] as Record<string, unknown>
      expect(sent.omniExecutionModeOverride).toBe('native-omni')
      expect(sent.inputAudio).toMatchObject({
        dataBase64: 'UklGRg==',
        format: 'wav',
        sampleRate: 16000,
      })
      expect((sent.videoFrames as unknown[]).length).toBe(1)
      expect((sent.attachments as unknown[]).length).toBe(1)
      expect(useAshyStore.getState().pendingVideoFrames).toHaveLength(0)
      expect(useAshyStore.getState().pendingTurnAttachments).toHaveLength(0)
    })

    it('stops active webcam stream and clears staged frames on activateFullPrivacyShield() and setEyesMode("off")', () => {
      const f1 = createSyntheticVideoFrameDataUrl(1, 100, 'camera')
      useAshyStore.setState({
        isWebcamStreaming: true,
        webcamPreviewDataUrl: f1.dataUrl,
        pendingVideoFrames: [f1],
      })

      useAshyStore.getState().setEyesMode('off')
      expect(useAshyStore.getState().isWebcamStreaming).toBe(false)
      expect(useAshyStore.getState().webcamPreviewDataUrl).toBeNull()
      expect(useAshyStore.getState().pendingVideoFrames).toHaveLength(0)

      useAshyStore.setState({
        isWebcamStreaming: true,
        webcamPreviewDataUrl: f1.dataUrl,
        pendingVideoFrames: [f1],
      })
      useAshyStore.getState().activateFullPrivacyShield()
      expect(useAshyStore.getState().isWebcamStreaming).toBe(false)
      expect(useAshyStore.getState().webcamPreviewDataUrl).toBeNull()
      expect(useAshyStore.getState().pendingVideoFrames).toHaveLength(0)
    })
  })

  describe('3. UI Components: ModelsSettingsPanel & Studio Unified Omni Controls', () => {
    it('renders unified-omni-settings-card and preset buttons in ModelsSettingsPanel', async () => {
      await act(async () => {
        root?.render(<ModelsSettingsPanel />)
      })

      expect(getByTestId('unified-omni-settings-card')).toBeTruthy()
      expect(getByTestId('toggle-unified-omni-mode')).toBeTruthy()

      await act(async () => {
        clickElement(getByTestId('preset-omni-lfm3-local'))
      })
      expect(useAshyStore.getState().activeModelId).toBe('lfm3-omni:2b')
      expect(useAshyStore.getState().unifiedOmniMode).toBe(true)

      await act(async () => {
        clickElement(getByTestId('preset-omni-gpt4o'))
      })
      expect(useAshyStore.getState().activeModelId).toBe('gpt-4o-audio-preview')
    })

    it('renders pill-toggle-omni-mode, btn-toggle-webcam, btn-attach-image, btn-attach-video, and toggle-direct-omni-audio in App', async () => {
      useAshyStore.setState({
        isBootstrapped: true,
        needsOnboarding: false,
        hasCompletedOnboarding: true,
        activeTab: 'studio',
      })
      await act(async () => {
        root?.render(<App />)
      })

      const omniPill = getByTestId('pill-toggle-omni-mode')
      expect(omniPill).toBeTruthy()
      await act(async () => {
        clickElement(omniPill)
      })
      expect(useAshyStore.getState().unifiedOmniMode).toBe(true)

      expect(getByTestId('btn-toggle-webcam')).toBeTruthy()
      expect(getByTestId('btn-attach-image')).toBeTruthy()
      expect(getByTestId('btn-attach-video')).toBeTruthy()

      // Activate webcam & stage attachment -> verify studio-webcam-pip and composer-media-attachments render
      const f1 = createSyntheticVideoFrameDataUrl(1, 200, 'camera')
      await act(async () => {
        useAshyStore.setState({
          isWebcamStreaming: true,
          webcamPreviewDataUrl: f1.dataUrl,
          pendingVideoFrames: [f1],
        })
        useAshyStore.getState().stageTurnAttachment({
          id: 'att-ui-1',
          kind: 'image',
          mimeType: 'image/jpeg',
          dataUrlOrBase64: f1.dataUrl,
          name: 'layout.jpg',
        })
      })
      expect(getByTestId('studio-webcam-pip')).toBeTruthy()
      expect(getByTestId('composer-media-attachments')).toBeTruthy()

      // Switch to Settings (agency) > Voz and check toggle-direct-omni-audio
      await act(async () => {
        useAshyStore.getState().setActiveTab('agency')
        useAshyStore.getState().setSettingsSubTab('voz')
      })
      expect(getByTestId('toggle-direct-omni-audio')).toBeTruthy()
    })
  })
})
