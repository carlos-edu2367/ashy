// @vitest-environment jsdom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { createAshyHostKernel } from '../host/kernel'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { getVoiceRuntimeForTesting, resetAshyStore, useAshyStore } from '../store/useAshyStore'

// Enable React 19 act environment
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const tempDirs: string[] = []
const activeKernels: Array<{ stop(): Promise<void> }> = []
let container: HTMLDivElement | null = null
let root: Root | null = null

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-ui-p5-'))
  tempDirs.push(dir)
  return dir
}

function setNativeInputValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  if (descriptor?.set) {
    descriptor.set.call(element, value)
  } else {
    element.value = value
  }
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function clickElement(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function getByTestId<T extends HTMLElement = HTMLElement>(testId: string): T {
  const el = container?.querySelector(`[data-testid="${testId}"]`) as T | null
  if (!el) {
    throw new Error(`Unable to find an element by: [data-testid="${testId}"]`)
  }
  return el
}

beforeEach(() => {
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
  if (container) {
    container.remove()
    container = null
  }
  setAshyHostBridgeForTesting(null)
  while (activeKernels.length > 0) {
    await activeKernels.pop()!.stop()
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Phase 5 Realtime Voice — Incremental turn:delta TTS, Barge-In Abort & Receipt Injection, and Hub Voice UI', () => {
  it('1. streams turn:delta incrementally into RealtimeSpeechPipeline via enqueueDelta, flushes tail on turn:completed without duplicating chunks, and records TTFA telemetry (Red-Team B1)', async () => {
    const dir = makeTempDir()
    let releaseStreamCompletion!: () => void
    const streamGate = new Promise<void>((resolve) => {
      releaseStreamCompletion = resolve
    })

    const encoder = new TextEncoder()
    const mockFetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"<|ACT {\\"emotion\\":\\"excited\\",\\"intensity\\":0.9}|>"}}]}\n\n',
            ),
          )
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"Olha só, Carlos, esse pipeline de voz em tempo real já começou a sintetizar no meio do stream! "}}]}\n\n',
            ),
          )
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"E o finalzinho fica no buffer até fechar"}}]}\n\n',
            ),
          )
          await streamGate
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    activeKernels.push(kernel)

    await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-phase5stream1234',
      },
    })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    const turnPromise = useAshyStore
      .getState()
      .sendUserMessage('Testa o streaming incremental de voz para mim!')

    // While the turn is still streaming (before turn:completed), the first sentence must already be synthesized & scheduled!
    await vi.waitFor(() => {
      const state = useAshyStore.getState()
      expect(state.isStreamingTurn).toBe(true)
      expect(state.scheduledAudioChunks.length).toBeGreaterThanOrEqual(1)
      const activeTts = state.voiceSettings.activeTtsProviderId
      expect(state.ttfaByProvider[activeTts]?.lastTtfaMs).not.toBeNull()
      expect(state.ttfaByProvider[activeTts]?.sampleCount).toBeGreaterThanOrEqual(1)
    })

    const midStreamChunks = useAshyStore.getState().scheduledAudioChunks
    expect(midStreamChunks.map((c) => c.text).join(' ')).toContain(
      'Olha só, Carlos, esse pipeline de voz em tempo real',
    )

    // Release stream completion so turn:completed fires and flushes the unpunctuated tail
    releaseStreamCompletion()
    await turnPromise

    await vi.waitFor(() => {
      const finalChunks = useAshyStore.getState().scheduledAudioChunks
      const fullSpokenText = finalChunks.map((c) => c.text).join(' ')
      expect(fullSpokenText).toContain('E o finalzinho fica no buffer até fechar')
      // Verify first sentence was NOT duplicated on turn:completed
      const occurrences =
        fullSpokenText.split('Olha só, Carlos, esse pipeline de voz em tempo real').length - 1
      expect(occurrences).toBe(1)
    })
  })

  it('2. aborts active streaming turn on triggerBargeIn, preserves Listening/surprised across turn:aborted, and injects [VOICE BARGE-IN RECEIPT] into the next turn without repeating on turn 3 (Red-Team B2 & M2)', async () => {
    const dir = makeTempDir()
    const capturedBodies: Array<Record<string, unknown>> = []
    let callCount = 0

    const encoder = new TextEncoder()
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      callCount += 1
      if (typeof init?.body === 'string') {
        capturedBodies.push(JSON.parse(init.body) as Record<string, unknown>)
      }

      if (callCount === 1) {
        // Turn 1: stream initial chunks, then wait until aborted by triggerBargeIn
        const signal = init?.signal
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"Eu estava explicando toda a arquitetura de memória episódica FSRS-6 com bastante calma. Mas ainda falta falar sobre os índices vetoriais e a governança de revisão."}}]}\n\n',
              ),
            )
            signal?.addEventListener('abort', () => {
              try {
                controller.error(new DOMException('Aborted', 'AbortError'))
              } catch {
                // Ignore
              }
            })
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }

      // Turn 2 & Turn 3: complete normally
      const sse = [
        'data: {"choices":[{"delta":{"content":"<|ACT {\\"emotion\\":\\"curious\\",\\"intensity\\":0.85}|> Beleza, cortei a explicação longa e vou direto ao ponto do banco!"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    activeKernels.push(kernel)

    await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-phase5barge1234',
      },
    })

    const abortSpy = vi.spyOn(kernel, 'abortTurn')
    const sendTurnSpy = vi.spyOn(kernel, 'sendTurn')

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    // Start Turn 1 (which hangs after streaming the first deltas until barge-in aborts it)
    const turn1Promise = useAshyStore
      .getState()
      .sendUserMessage('Me explica toda a arquitetura com detalhes.')

    await vi.waitFor(() => {
      const state = useAshyStore.getState()
      expect(state.isStreamingTurn).toBe(true)
      expect(state.activeTurnId).not.toBeNull()
      expect(state.scheduledAudioChunks.length).toBeGreaterThanOrEqual(1)
    })

    // Trigger Barge-In at 600ms while Turn 1 is actively streaming
    const receipt = useAshyStore.getState().triggerBargeIn(600)
    expect(receipt.controlNote).toContain('[Interrupted after ')
    expect(receipt.controlNote).toContain('user heard: "')
    expect(receipt.controlNote).toContain('| unheard: "')
    expect(useAshyStore.getState().lastPlaybackReceipt?.controlNote).toBe(receipt.controlNote)
    expect(useAshyStore.getState().pendingInterruptionControlNote).toBe(receipt.controlNote)

    // Wait for Turn 1 to finish aborting
    await turn1Promise
    expect(abortSpy).toHaveBeenCalledTimes(1)

    // Red-Team B2: After turn:aborted fires for a barge-in turn, presenceStatus ('Listening') and stageEmotion ('surprised') must NOT be clobbered to 'Idle'
    expect(useAshyStore.getState().presenceStatus).toBe('Listening')
    expect(useAshyStore.getState().stageEmotion).toBe('surprised')

    // Send Turn 2: must consume pendingInterruptionControlNote and inject [VOICE BARGE-IN RECEIPT]
    await useAshyStore.getState().sendUserMessage('Espera, foca só no banco')

    expect(sendTurnSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: 'Espera, foca só no banco',
        interruptionControlNote: receipt.controlNote,
      }),
    )

    // Verify the LLM payload on Turn 2 received [VOICE BARGE-IN RECEIPT]
    const turn2Payload = JSON.stringify(capturedBodies[1] ?? {})
    expect(turn2Payload).toContain('[VOICE BARGE-IN RECEIPT]')
    expect(turn2Payload).toContain(receipt.heardText)

    // Red-Team M2: Even after turn:completed calls applyBootstrapSnapshot, lastPrompt.volatileTurnContext preserves [VOICE BARGE-IN RECEIPT] for Turn 2
    expect(useAshyStore.getState().lastPrompt.volatileTurnContext).toContain(
      '[VOICE BARGE-IN RECEIPT]',
    )
    expect(useAshyStore.getState().lastPrompt.volatileTurnContext).toContain(receipt.controlNote)
    // And pendingInterruptionControlNote is now cleared so Turn 3 won't repeat it
    expect(useAshyStore.getState().pendingInterruptionControlNote).toBeNull()

    // Send Turn 3: should NOT include old barge-in receipt
    await useAshyStore.getState().sendUserMessage('Agora mostra os índices')
    const lastSendTurnArg = sendTurnSpy.mock.calls.at(-1)?.[0]
    expect(lastSendTurnArg?.interruptionControlNote).toBeUndefined()
    expect(useAshyStore.getState().lastPrompt.volatileTurnContext).not.toContain(
      '[VOICE BARGE-IN RECEIPT]',
    )
  })

  it('3. normalizes mic modes (muted / continuous / ptt / push-to-talk), switches STT/TTS providers, and runs deterministic .wav fixtures in Hub UI updating TTFA, CAS & Barge-In badges (Red-Team B4 & B5)', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    activeKernels.push(kernel)
    await kernel.completeOnboarding({ userName: 'Carlos' })

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    // Verify setMicMode supports both 'push-to-talk' and 'ptt' without throwing in PrivacyController
    expect(() => useAshyStore.getState().setMicMode('push-to-talk')).not.toThrow()
    expect(useAshyStore.getState().privacyState.micMode).toBe('ptt')

    expect(() => useAshyStore.getState().setMicMode('ptt')).not.toThrow()
    expect(useAshyStore.getState().privacyState.micMode).toBe('ptt')

    useAshyStore.getState().setMicMode('muted')
    expect(useAshyStore.getState().privacyState.micMode).toBe('muted')

    useAshyStore.getState().setMicMode('continuous')
    expect(useAshyStore.getState().privacyState.micMode).toBe('continuous')

    // Verify provider switching & wake word actions
    useAshyStore.getState().setActiveSttProvider('local-whisper-http')
    expect(useAshyStore.getState().voiceSettings.activeSttProviderId).toBe('local-whisper-http')
    useAshyStore.getState().setActiveSttProvider('deterministic-wav-stt')
    expect(useAshyStore.getState().voiceSettings.activeSttProviderId).toBe(
      'deterministic-wav-stt',
    )

    useAshyStore.getState().setActiveTtsProvider('local-kokoro-http')
    expect(useAshyStore.getState().voiceSettings.activeTtsProviderId).toBe('local-kokoro-http')
    useAshyStore.getState().setActiveTtsProvider('local-synth-fallback')
    expect(useAshyStore.getState().voiceSettings.activeTtsProviderId).toBe(
      'local-synth-fallback',
    )

    useAshyStore.getState().setWakeWordEnabled(false)
    expect(useAshyStore.getState().voiceSettings.wakeWordEnabled).toBe(false)
    useAshyStore.getState().setWakeWordEnabled(true)
    expect(useAshyStore.getState().voiceSettings.wakeWordEnabled).toBe(true)

    // Verify alias runVoiceFixtureScenario works identically to runAudioFixtureSimulation
    const wakeRes = await useAshyStore
      .getState()
      .runVoiceFixtureScenario('wake-word-oi-ashy')
    expect(wakeRes.fixtureId).toBe('wake-word-oi-ashy')
    expect(wakeRes.snapshot.wakeWordDetectedCount).toBeGreaterThanOrEqual(1)

    // Render Hub UI and navigate to Configurações -> Voz
    await act(async () => {
      root!.render(<App />)
    })

    await act(async () => {
      clickElement(getByTestId('tab-agency'))
    })
    await act(async () => {
      clickElement(getByTestId('subtab-voz'))
    })

    // Verify STT/TTS selects and Wake Word toggle in UI
    const sttSelect = getByTestId<HTMLSelectElement>('select-stt-provider')
    const ttsSelect = getByTestId<HTMLSelectElement>('select-tts-provider')
    const wakeToggle = getByTestId<HTMLElement>('toggle-wake-word')
    expect(sttSelect).toBeTruthy()
    expect(ttsSelect).toBeTruthy()
    expect(wakeToggle).toBeTruthy()

    await act(async () => {
      setNativeInputValue(sttSelect, 'deterministic-wav-stt')
      setNativeInputValue(ttsSelect, 'local-synth-fallback')
      clickElement(wakeToggle)
    })
    expect(useAshyStore.getState().voiceSettings.wakeWordEnabled).toBe(false)

    // 1. Click thinking-pause-cas fixture button in UI
    await act(async () => {
      clickElement(getByTestId('run-fixture-thinking-pause-cas'))
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().voiceCasRejectedCount).toBeGreaterThanOrEqual(1)
      expect(getByTestId('voice-cas-badge').textContent).toContain('CAS')
      expect(getByTestId('voice-cas-badge').textContent).toMatch(/[1-9]/)
    })

    // 2. Click barge-in-interrupt fixture button in UI
    await act(async () => {
      clickElement(getByTestId('run-fixture-barge-in-interrupt'))
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().lastPlaybackReceipt?.controlNote).toContain(
        '[Interrupted after ',
      )
      expect(getByTestId('voice-bargein-receipt').textContent).toContain('[Interrupted after ')
      expect(getByTestId('voice-ttfa-badge').textContent).toMatch(/\d+\s*ms/i)
    })

    // 3. Click keyboard-click-noise fixture button in UI
    await act(async () => {
      clickElement(getByTestId('run-fixture-keyboard-click-noise'))
    })

    await vi.waitFor(() => {
      expect(useAshyStore.getState().voiceCancelledShortCount).toBeGreaterThanOrEqual(1)
    })
  })

  it('4. [Phase 8.6] persists encrypted voice settings in Host Kernel, enforces anti-SSRF and cloud origin pinning, and executes listVoiceProviderModels / transcribeVoiceAudio / synthesizeVoiceSpeech', async () => {
    const dir = makeTempDir()
    const seenRequests: Array<{ url: string; authHeader: string | null }> = []

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      const headers = new Headers(init?.headers)
      seenRequests.push({
        url,
        authHeader: headers.get('authorization') ?? headers.get('xi-api-key'),
      })

      const makeJsonResponse = (body: unknown, status = 200): Response =>
        ({
          ok: status >= 200 && status < 300,
          status,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => body,
          text: async () => JSON.stringify(body),
          arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
        }) as unknown as Response

      if (url.endsWith('/models')) {
        return makeJsonResponse({
          data: [
            { id: 'whisper-large-v3-turbo', name: 'Whisper Large v3 Turbo' },
            { id: 'kokoro-v1', name: 'Kokoro v1 PT-BR' },
          ],
        })
      }

      if (url.endsWith('/audio/voices')) {
        return makeJsonResponse({
          voices: [{ id: 'pf_dora', name: 'Dora (PT-BR)' }],
        })
      }

      if (url.includes('/audio/transcriptions')) {
        return makeJsonResponse({ text: 'Olá Ashy, testando transcrição real!' })
      }

      if (url.includes('/audio/speech')) {
        const numSamples = 1600
        const dataBytes = numSamples * 2
        const buf = new ArrayBuffer(44 + dataBytes)
        const view = new DataView(buf)
        const writeStr = (offset: number, s: string) => {
          for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
        }
        writeStr(0, 'RIFF')
        view.setUint32(4, 36 + dataBytes, true)
        writeStr(8, 'WAVE')
        writeStr(12, 'fmt ')
        view.setUint32(16, 16, true)
        view.setUint16(20, 1, true)
        view.setUint16(22, 1, true)
        view.setUint32(24, 16000, true)
        view.setUint32(28, 32000, true)
        view.setUint16(32, 2, true)
        view.setUint16(34, 16, true)
        writeStr(36, 'data')
        view.setUint32(40, dataBytes, true)
        for (let i = 0; i < numSamples; i++) {
          const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 12000)
          view.setInt16(44 + i * 2, sample, true)
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'audio/wav' }),
          arrayBuffer: async () => buf,
          text: async () => '',
        } as unknown as Response
      }

      return makeJsonResponse({ error: 'Not found' }, 404)
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    activeKernels.push(kernel)

    const saved = await kernel.saveVoiceRuntimeSettings!({
      activeSttProviderId: 'groq-whisper',
      activeTtsProviderId: 'local-kokoro-http',
      sttBaseUrl: 'http://127.0.0.1:8080/v1',
      sttModelId: 'whisper-large-v3-turbo',
      ttsBaseUrl: 'http://127.0.0.1:8880/v1',
      ttsModelId: 'kokoro-v1',
      ttsVoiceId: 'pf_dora',
      openaiApiKey: 'sk-proj-secret-openai-voice-9999',
      groqApiKey: 'gsk_secret_groq_voice_8888',
      elevenLabsApiKey: 'xi-secret-eleven-7777',
      localSttApiKey: 'local-stt-token-1111',
      localTtsApiKey: 'local-tts-token-2222',
      selectedMicDeviceId: 'mic-usb-studio',
      autoSpeakReplies: true,
    })

    expect(saved.hasOpenAiApiKey).toBe(true)
    expect(saved.hasGroqApiKey).toBe(true)
    expect(saved.hasElevenLabsApiKey).toBe(true)
    expect(saved.hasLocalSttApiKey).toBe(true)
    expect(saved.hasLocalTtsApiKey).toBe(true)
    expect(saved.maskedOpenAiApiKey).toContain('9999')
    expect(saved.maskedOpenAiApiKey).not.toContain('sk-proj-secret-openai-voice-9999')
    expect(JSON.stringify(saved)).not.toContain('sk-proj-secret-openai-voice-9999')
    expect(JSON.stringify(saved)).not.toContain('gsk_secret_groq_voice_8888')

    const diskRaw = fs.readFileSync(path.join(dir, 'voice-settings.json'), 'utf8')
    expect(diskRaw).not.toContain('sk-proj-secret-openai-voice-9999')
    expect(diskRaw).not.toContain('gsk_secret_groq_voice_8888')
    expect(diskRaw).not.toContain('xi-secret-eleven-7777')

    // Anti-SSRF: block link-local metadata IP 169.254.169.254 on local provider
    const numWavSamples = 320
    const wavDataBytes = numWavSamples * 2
    const wavBuf = new ArrayBuffer(44 + wavDataBytes)
    const wavView = new DataView(wavBuf)
    const writeWavStr = (offset: number, s: string) => {
      for (let i = 0; i < s.length; i++) wavView.setUint8(offset + i, s.charCodeAt(i))
    }
    writeWavStr(0, 'RIFF')
    wavView.setUint32(4, 36 + wavDataBytes, true)
    writeWavStr(8, 'WAVE')
    writeWavStr(12, 'fmt ')
    wavView.setUint32(16, 16, true)
    wavView.setUint16(20, 1, true)
    wavView.setUint16(22, 1, true)
    wavView.setUint32(24, 16000, true)
    wavView.setUint32(28, 32000, true)
    wavView.setUint16(32, 2, true)
    wavView.setUint16(34, 16, true)
    writeWavStr(36, 'data')
    wavView.setUint32(40, wavDataBytes, true)
    const validWavBase64 = Buffer.from(wavBuf).toString('base64')

    await expect(
      kernel.transcribeVoiceAudio!({
        audioBase64: validWavBase64,
        providerId: 'local-whisper-http',
        baseUrl: 'http://169.254.169.254/latest/meta-data',
      }),
    ).rejects.toThrow(/blocked|unsafe|169\.254|invalid/i)

    // Cloud origin pinning: passing custom baseUrl to openai-whisper must reject before sending OpenAI key to 127.0.0.1:9999
    seenRequests.length = 0
    await expect(
      kernel.listVoiceProviderModels!({
        kind: 'stt',
        providerId: 'openai-whisper',
        baseUrl: 'http://127.0.0.1:9999/v1',
      }),
    ).rejects.toThrow(/Origin pinning violation/i)
    expect(seenRequests.some((r) => r.url.includes('127.0.0.1:9999'))).toBe(false)

    const catalog = await kernel.listVoiceProviderModels!({
      kind: 'stt',
      providerId: 'openai-whisper',
    })
    expect(catalog.models.length).toBeGreaterThan(0)
    expect(seenRequests.every((r) => r.url.startsWith('https://api.openai.com'))).toBe(true)

    // List local Kokoro models + voices
    const kokoroCatalog = await kernel.listVoiceProviderModels!({
      kind: 'tts',
      providerId: 'local-kokoro-http',
      baseUrl: 'http://127.0.0.1:8880/v1',
    })
    expect(kokoroCatalog.source).toBe('remote')
    expect(kokoroCatalog.voices?.some((v) => v.id === 'pf_dora')).toBe(true)

    // Synthesize speech via local-kokoro-http and get vowelFrames
    const synthRes = await kernel.synthesizeVoiceSpeech!({
      text: 'Olá Carlos, minha voz real está ativa!',
      providerId: 'local-kokoro-http',
      baseUrl: 'http://127.0.0.1:8880/v1',
      modelId: 'kokoro-v1',
      voiceId: 'pf_dora',
    })
    expect(synthRes.durationMs).toBeGreaterThan(50)
    expect(synthRes.vowelFrames.length).toBeGreaterThan(0)
    expect(synthRes.audioBase64.length).toBeGreaterThan(20)
  })

  it('5. [Phase 8.6] connects real voice listening (onTurnSealed -> sendUserMessage with silence hallucination filter), resets lip-sync after playback ends, and renders complete Voice Settings UI', async () => {
    const dir = makeTempDir()
    const encoder = new TextEncoder()
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.endsWith('/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'whisper-large-v3-turbo', name: 'Whisper Turbo' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      const sse = [
        'data: {"choices":[{"delta":{"content":"Oi Carlos!"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')
      return new Response(encoder.encode(sse), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    activeKernels.push(kernel)

    await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-phase86voice1234',
      },
    })

    const sendTurnSpy = vi.spyOn(kernel, 'sendTurn')
    const saveVoiceSpy = vi.spyOn(kernel, 'saveVoiceRuntimeSettings')

    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()
    await useAshyStore.getState().bootstrapFromHost()

    // 1. Toggle voice conversation ON
    const listeningActive = await useAshyStore.getState().toggleVoiceConversation(true)
    expect(listeningActive).toBe(true)
    expect(useAshyStore.getState().isVoiceListening).toBe(true)
    expect(useAshyStore.getState().presenceStatus).toBe('Listening')

    // 2. Render Hub UI and verify Studio Dock & Settings > Voz controls
    await act(async () => {
      root!.render(<App />)
    })

    const dockVoiceBtn = getByTestId('btn-toggle-lipsync')
    expect(dockVoiceBtn).toBeTruthy()

    // Navigate to Configurações > Voz
    await act(async () => {
      clickElement(getByTestId('tab-agency'))
    })
    await act(async () => {
      clickElement(getByTestId('subtab-voz'))
    })

    // Verify all 11 Phase 5 testids AND all new Phase 8.6 testids exist in voice-runtime-panel
    const requiredTestIds = [
      'voice-runtime-panel',
      'select-stt-provider',
      'select-tts-provider',
      'toggle-wake-word',
      'voice-ttfa-badge',
      'voice-cas-badge',
      'voice-bargein-receipt',
      'run-fixture-thinking-pause-cas',
      'run-fixture-barge-in-interrupt',
      'run-fixture-wake-word-oi-ashy',
      'run-fixture-keyboard-click-noise',
      'input-stt-base-url',
      'input-stt-api-key',
      'select-stt-model',
      'btn-refresh-stt-models',
      'input-tts-base-url',
      'input-tts-api-key',
      'select-tts-model',
      'select-tts-voice',
      'btn-refresh-tts-models',
      'select-mic-device',
      'toggle-auto-speak-replies',
      'btn-test-mic',
      'btn-test-tts-voice',
      'btn-save-voice-settings',
    ]
    for (const tid of requiredTestIds) {
      expect(getByTestId(tid)).toBeTruthy()
    }

    // Update STT base URL & save voice settings from UI
    await act(async () => {
      setNativeInputValue(
        getByTestId<HTMLInputElement>('input-stt-base-url'),
        'http://127.0.0.1:8090/v1',
      )
      clickElement(getByTestId('btn-save-voice-settings'))
    })

    await vi.waitFor(() => {
      expect(saveVoiceSpy).toHaveBeenCalled()
      expect(useAshyStore.getState().voiceSettings.sttBaseUrl).toBe('http://127.0.0.1:8090/v1')
    })

    // 3. Verify silence hallucination ('[BLANK_AUDIO]') is ignored when voiceRuntime seals a turn
    const rt = getVoiceRuntimeForTesting()
    rt.getTurnController().updateTranscript('[BLANK_AUDIO]')
    await rt.getTurnController().sealTurn('manual')
    expect(sendTurnSpy).not.toHaveBeenCalled()

    // 4. Verify real spoken utterance sealed in voiceRuntime while isVoiceListening=true dispatches sendUserMessage
    rt.getTurnController().reset()
    rt.getTurnController().updateTranscript('Oi Ashy, me responde por voz!')
    await rt.getTurnController().sealTurn('manual')

    await vi.waitFor(() => {
      expect(sendTurnSpy).toHaveBeenCalledTimes(1)
      expect(sendTurnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Oi Ashy'),
        }),
      )
    })

    // Wait for playback completion timer to reset isSpeaking -> false and activeViseme -> 'closed'
    await vi.waitFor(
      () => {
        expect(useAshyStore.getState().isSpeaking).toBe(false)
        expect(useAshyStore.getState().activeViseme).toBe('closed')
        expect(useAshyStore.getState().simulatedVowels.A).toBe(0)
      },
      { timeout: 2500 },
    )
  })
})
