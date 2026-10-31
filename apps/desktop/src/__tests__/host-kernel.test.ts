import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AshyHostStreamEvent } from '@ashy/shared'
import { encodeWavPcm16, synthesizeVoicedSpeechPcm } from '@ashy/voice'
import { createAshyHostKernel } from '../host/kernel'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-host-kernel-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    } catch {
      // Ignore Windows EPERM cleanup race
    }
  }
})

describe('AshyHostKernel & TurnOrchestrator', () => {
  it('persists omniExecutionMode and omniVoiceId in ProviderVault across restarts and surfaces Omni capabilities in listProviderModels for lfm3-omni:2b and gpt-4o-audio-preview', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({
            models: [
              { name: 'lfm3-omni:2b', model: 'lfm3-omni:2b' },
              { name: 'qwen2.5:14b', model: 'qwen2.5:14b' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('api.openai.com') && url.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'gpt-4o-audio-preview', name: 'GPT-4o Audio Preview', context_length: 128000 },
              { id: 'gpt-4o-mini', name: 'GPT-4o Mini', context_length: 128000 },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('Not Found', { status: 404 })
    })

    const kernel1 = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const saved = await kernel1.saveProviderConfig({
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'lfm3-omni:2b',
      omniExecutionMode: 'native-omni',
      omniVoiceId: 'female',
    })

    expect(saved.config.isOmniModel).toBe(true)
    expect(saved.config.supportsOmniAudioIn).toBe(true)
    expect(saved.config.supportsOmniAudioOut).toBe(true)
    expect(saved.config.supportsOmniVideoIn).toBe(true)
    expect(saved.config.inputModalities).toEqual(['text', 'audio', 'image', 'video'])
    expect(saved.config.outputModalities).toEqual(['text', 'audio'])
    expect(saved.config.omniExecutionMode).toBe('native-omni')
    expect(saved.config.omniVoiceId).toBe('female')

    const ollamaCatalog = await kernel1.listProviderModels({ providerId: 'ollama' })
    expect(ollamaCatalog.source).toBe('remote')
    const lfm3Item = ollamaCatalog.models.find((m) => m.id === 'lfm3-omni:2b')
    expect(lfm3Item).toBeDefined()
    expect(lfm3Item?.isOmniModel).toBe(true)
    expect(lfm3Item?.supportsOmniAudioIn).toBe(true)
    expect(lfm3Item?.supportsOmniAudioOut).toBe(true)
    expect(lfm3Item?.supportsOmniVideoIn).toBe(true)

    const openaiCatalog = await kernel1.listProviderModels({
      providerId: 'openai',
      apiKey: 'sk-proj-test-1234',
    })
    expect(openaiCatalog.source).toBe('remote')
    const gpt4oAudioItem = openaiCatalog.models.find((m) => m.id === 'gpt-4o-audio-preview')
    expect(gpt4oAudioItem).toBeDefined()
    expect(gpt4oAudioItem?.isOmniModel).toBe(true)
    expect(gpt4oAudioItem?.supportsOmniAudioIn).toBe(true)
    expect(gpt4oAudioItem?.supportsOmniAudioOut).toBe(true)
    expect(gpt4oAudioItem?.supportsOmniVideoIn).toBe(true)

    await kernel1.stop()

    const kernel2 = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    const boot2 = await kernel2.getBootstrapSnapshot()
    expect(boot2.providers.configs.ollama.modelId).toBe('lfm3-omni:2b')
    expect(boot2.providers.configs.ollama.isOmniModel).toBe(true)
    expect(boot2.providers.configs.ollama.omniExecutionMode).toBe('native-omni')
    expect(boot2.providers.configs.ollama.omniVoiceId).toBe('female')
    await kernel2.stop()
  })

  it('executes a direct native-omni turn (lfm3-omni:2b) with WAV ICMT audio + videoFrames: evaluates SeriousnessGate on spoken transcript (HIGH-4), sends multimodal parts + modalities:["text","audio"], emits turn:input-transcript, strips <|ACT|> from delta.audio.transcript, streams turn:audio-delta with vowelFrames, and supports ashy_stage_signal tool', async () => {
    const dir = makeTempDir()
    const capturedBodies: Array<Record<string, unknown>> = []
    let callCount = 0

    // Generate 60ms of 24kHz PCM16 voiced speech for native audio delta response
    const pcmFloat = synthesizeVoicedSpeechPcm({
      durationMs: 60,
      sampleRate: 24000,
      fundamentalHz: 210,
      amplitude: 0.5,
    })
    const pcm16Bytes = new Uint8Array(pcmFloat.length * 2)
    const pcmView = new DataView(pcm16Bytes.buffer)
    for (let i = 0; i < pcmFloat.length; i++) {
      const s = Math.max(-1, Math.min(1, pcmFloat[i]!))
      pcmView.setInt16(i * 2, Math.round(s * 32767), true)
    }
    const pcm24kBase64 = Buffer.from(pcm16Bytes).toString('base64')

    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      callCount += 1
      if (typeof init?.body === 'string') {
        capturedBodies.push(JSON.parse(init.body) as Record<string, unknown>)
      }

      if (callCount === 1) {
        // Turn 1: Direct audio-only WAV with ICMT serious crisis utterance + video frame
        const sse = [
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  audio: {
                    transcript:
                      '<|ACT {"emotion":"concerned","intensity":0.9,"motion":"nod"}|>Respira comigo, Carlos, estou aqui com você.',
                    data: pcm24kBase64,
                    format: 'pcm16',
                    sample_rate: 24000,
                  },
                },
              },
            ],
          })}\n\n`,
          'data: [DONE]\n\n',
        ].join('')
        return new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }

      if (callCount === 2) {
        // Turn 2 Step 1: Model invokes ashy_stage_signal tool silently before speaking
        const sseTool = [
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_stage_1',
                      type: 'function',
                      function: {
                        name: 'ashy_stage_signal',
                        arguments: JSON.stringify({
                          emotion: 'happy',
                          intensity: 0.88,
                          motion: 'sparkle',
                          callbackMotifId: 'motif-padre-npm',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          })}\n\n`,
          'data: [DONE]\n\n',
        ].join('')
        return new Response(sseTool, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }

      // Turn 2 Step 2: Model streams native audio after tool call
      const sseAfterTool = [
        `data: ${JSON.stringify({
          input_transcript: 'Olha o webcam frame, o build passou de primeira!',
          choices: [
            {
              delta: {
                audio: {
                  transcript: 'Nem precisou chamar o padre pro npm dessa vez!',
                  data: pcm24kBase64,
                  format: 'pcm16',
                  sample_rate: 24000,
                },
              },
            },
          ],
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sseAfterTool, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    await kernel.seedDemoFixtures()
    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelId: 'lfm3-omni:2b',
        omniExecutionMode: 'native-omni',
        omniVoiceId: 'female',
      },
    })

    const events1: AshyHostStreamEvent[] = []
    const unsub1 = kernel.onHostEvent((ev) => events1.push(ev))

    // Encode WAV with ICMT metadata comment containing a SeriousnessGate trigger phrase
    const spokenCrisisText =
      'Estou exausto, tive uma crise de pânico horrível hoje e quero chorar.'
    const userWavBytes = encodeWavPcm16(
      synthesizeVoicedSpeechPcm(300, 16000),
      16000,
      spokenCrisisText,
    )
    const userWavBase64 = Buffer.from(userWavBytes).toString('base64')

    const turn1Res = await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: '',
      inputAudio: {
        dataBase64: `data:audio/wav;base64,${userWavBase64}`,
        format: 'wav',
        sampleRate: 16000,
        durationMs: 300,
      },
      videoFrames: [
        {
          dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
          timestampMs: 500,
          width: 512,
          height: 288,
          source: 'camera',
        },
      ],
    })

    // HIGH-4: User message in SQLite has the resolved spoken transcript synchronously
    expect(turn1Res.userMessage.content).toBe(spokenCrisisText)

    await vi.waitFor(() => {
      expect(events1.some((e) => e.type === 'turn:completed')).toBe(true)
    })
    unsub1()

    // 1. Verify request payload sent to LFM3-Omni-2B
    expect(capturedBodies.length).toBeGreaterThanOrEqual(1)
    const req1 = capturedBodies[0]!
    expect(req1.model).toBe('lfm3-omni:2b')
    expect(req1.modalities).toEqual(['text', 'audio'])
    expect(req1.audio).toEqual({ voice: 'female', format: 'pcm16' })
    expect(req1.think).toBe(false)

    const req1Str = JSON.stringify(req1)
    // SeriousnessGate evaluated on spoken WAV transcript (HIGH-4)
    expect(req1Str).toContain('[SERIOUSNESS GATE — HIGH PRIORITY]')
    // Native Omni Audio Output Directive injected into system prompt
    expect(req1Str).toContain('[NATIVE OMNI AUDIO OUTPUT DIRECTIVE]')
    // Multimodal parts serialized (video_frame -> [Video Frame @ 500ms] + image_url, input_audio, text)
    expect(req1Str).toContain('[Video Frame @ 500ms]')
    expect(req1Str).toContain('input_audio')
    expect(req1Str).toContain(spokenCrisisText)

    // 2. Verify streamed events for Turn 1
    const inputTranscriptEv = events1.find((e) => e.type === 'turn:input-transcript')
    expect(inputTranscriptEv).toBeDefined()
    if (inputTranscriptEv?.type === 'turn:input-transcript') {
      expect(inputTranscriptEv.transcript).toBe(spokenCrisisText)
      expect(inputTranscriptEv.source).toBe('wav-metadata')
      expect(inputTranscriptEv.isFinal).toBe(true)
    }

    const markerEv = events1.find((e) => e.type === 'turn:marker')
    expect(markerEv).toBeDefined()
    if (markerEv?.type === 'turn:marker') {
      expect(markerEv.marker).toEqual({
        type: 'act',
        emotion: 'concerned',
        intensity: 0.9,
        motion: 'nod',
      })
    }

    const deltaText = events1
      .filter((e): e is Extract<AshyHostStreamEvent, { type: 'turn:delta' }> => e.type === 'turn:delta')
      .map((e) => e.textDelta)
      .join('')
    expect(deltaText).toBe('Respira comigo, Carlos, estou aqui com você.')
    expect(deltaText).not.toContain('<|ACT')

    const audioDeltaEv = events1.find((e) => e.type === 'turn:audio-delta')
    expect(audioDeltaEv).toBeDefined()
    if (audioDeltaEv?.type === 'turn:audio-delta') {
      expect(audioDeltaEv.seq).toBe(0)
      expect(audioDeltaEv.format).toBe('pcm16')
      expect(audioDeltaEv.sampleRate).toBe(24000)
      expect(audioDeltaEv.durationMs).toBeGreaterThanOrEqual(50)
      expect(audioDeltaEv.vowelFrames).toBeDefined()
      expect(audioDeltaEv.vowelFrames!.length).toBeGreaterThanOrEqual(2)
      expect(audioDeltaEv.vowelFrames!.some((f) => f.dominantVowel !== 'closed')).toBe(true)
    }

    // 3. Turn 2: Test ashy_stage_signal tool call + omni-native input_transcript
    const events2: AshyHostStreamEvent[] = []
    const unsub2 = kernel.onHostEvent((ev) => events2.push(ev))

    await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: '',
      inputAudio: {
        dataBase64: Buffer.from(pcm16Bytes).toString('base64'),
        format: 'pcm16',
        sampleRate: 16000,
      },
    })

    await vi.waitFor(() => {
      expect(events2.some((e) => e.type === 'turn:completed')).toBe(true)
    })
    unsub2()

    const markers2 = events2.filter(
      (e): e is Extract<AshyHostStreamEvent, { type: 'turn:marker' }> => e.type === 'turn:marker',
    )
    expect(markers2.some((m) => m.marker.type === 'act' && m.marker.emotion === 'happy')).toBe(true)
    expect(
      markers2.some(
        (m) => m.marker.type === 'callback' && m.marker.motifId === 'motif-padre-npm',
      ),
    ).toBe(true)

    const nativeTranscriptEv = events2.find(
      (e) => e.type === 'turn:input-transcript' && e.source === 'omni-native',
    )
    expect(nativeTranscriptEv).toBeDefined()

    // 4. [Adversarial] Malformed WAV header in inputAudio does not crash sendTurn — falls back to '[Mensagem de voz Omni]'
    const corruptedWavRes = await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: '',
      inputAudio: {
        dataBase64: Buffer.from('NOT_A_RIFF_WAV_HEADER_12345').toString('base64'),
        format: 'wav',
        sampleRate: 16000,
      },
    })
    expect(corruptedWavRes.userMessage.content).toBe('[Mensagem de voz Omni]')

    await kernel.stop()
  })
  it('boots clean with needsOnboarding=true, completes Phase 0 onboarding, and persists first_meeting across restarts', async () => {
    const dir = makeTempDir()
    const kernel1 = await createAshyHostKernel({ userDataDir: dir })

    const boot1 = await kernel1.getBootstrapSnapshot()
    expect(boot1.needsOnboarding).toBe(true)
    expect(boot1.memories.facts).toHaveLength(0)
    expect(boot1.memories.episodes).toHaveLength(0)
    expect(boot1.messages).toHaveLength(0)

    const afterOnboarding = await kernel1.completeOnboarding({
      userName: 'Carlos',
      userPronouns: 'ele/dele',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    expect(afterOnboarding.needsOnboarding).toBe(false)
    expect(afterOnboarding.userProfile.userName).toBe('Carlos')
    expect(afterOnboarding.userProfile.userPronouns).toBe('ele/dele')
    expect(
      afterOnboarding.relationship.milestones.some((m) => m.category === 'first_meeting'),
    ).toBe(true)
    expect(afterOnboarding.providers.hasActiveReadyProvider).toBe(true)

    await kernel1.stop()

    // Restart kernel on same directory
    const kernel2 = await createAshyHostKernel({ userDataDir: dir })
    const boot2 = await kernel2.getBootstrapSnapshot()
    expect(boot2.needsOnboarding).toBe(false)
    expect(boot2.userProfile.userName).toBe('Carlos')
    expect(boot2.userProfile.userPronouns).toBe('ele/dele')
    await kernel2.stop()
  })

  it('streams a real turn, parses <|ACT|> and <|CALLBACK|> markers, applies affect/joke updates, and indexes FTS5 memories', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"<|ACT {\\"emotion\\":\\"tease\\",\\"intensity\\":0.85}|>"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"<|CALLBACK motif-padre-npm|>"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Oi Carlos, trabalhando no "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"banco SQLite até tarde?"}}]}\n\n',
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

    await kernel.seedDemoFixtures()
    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Estou configurando o banco SQLite e o runtime real do projeto Ashy.',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:completed')).toBe(true)
    })

    unsub()

    const completed = events.find((e) => e.type === 'turn:completed')
    expect(completed?.type).toBe('turn:completed')
    if (completed?.type === 'turn:completed') {
      expect(completed.assistantMessage.content).toBe(
        'Oi Carlos, trabalhando no banco SQLite até tarde?',
      )
      expect(completed.assistantMessage.emotion).toBe('tease')
      expect(completed.snapshot.memories.episodes.length).toBeGreaterThan(0)
      const padreMotif = completed.snapshot.memories.jokes.find(
        (j) => j.id === 'motif-padre-npm',
      )
      expect(padreMotif?.timesUsed).toBe(4)
    }

    await kernel.stop()
  })

  it('[Adversarial] sending a turn when no provider is configured emits turn:error with code PROVIDER_NOT_CONFIGURED', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })

    // Complete onboarding without providerConfig ("configure later")
    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
    })
    expect(snap.providers.hasActiveReadyProvider).toBe(false)

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    const { turnId, userMessage } = await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Oi Ashy, está me ouvindo sem provedor configurado?',
    })

    expect(userMessage.content).toBe('Oi Ashy, está me ouvindo sem provedor configurado?')

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:error')).toBe(true)
    })

    unsub()

    const errEvent = events.find((e) => e.type === 'turn:error')
    expect(errEvent).toBeDefined()
    if (errEvent?.type === 'turn:error') {
      expect(errEvent.turnId).toBe(turnId)
      expect(errEvent.code).toBe('PROVIDER_NOT_CONFIGURED')
      expect(errEvent.recoverable).toBe(true)
    }

    await kernel.stop()
  })

  it('[Adversarial] aborting an in-flight turn or starting a concurrent turn on the same session aborts the running stream and emits turn:aborted', async () => {
    const dir = makeTempDir()
    let callCount = 0

    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      callCount += 1
      const currentCall = callCount
      const encoder = new TextEncoder()

      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: {"choices":[{"delta":{"content":"Parcial ${currentCall}..."}}]}\n\n`,
            ),
          )
          if (currentCall <= 2) {
            // Keep stream open until aborted
            await new Promise<void>((resolve) => {
              init?.signal?.addEventListener('abort', () => resolve(), { once: true })
            })
            try {
              controller.close()
            } catch {
              // ignore
            }
            return
          }
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":" resposta final concluída."}}]}\n\ndata: [DONE]\n\n',
            ),
          )
          controller.close()
        },
      })

      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    // 1. Start turn 1 and explicitly abort it after first delta arrives
    const turn1 = await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Primeira mensagem longa que será abortada manualmente.',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:delta' && e.turnId === turn1.turnId)).toBe(true)
    })

    await kernel.abortTurn(turn1.turnId)

    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'turn:aborted' && e.turnId === turn1.turnId),
      ).toBe(true)
    })

    // 2. Start turn 2, then immediately send turn 3 on the same session to trigger concurrent auto-abort
    const turn2 = await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Segunda mensagem que será substituída por um envio concorrente.',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:delta' && e.turnId === turn2.turnId)).toBe(true)
    })

    const turn3 = await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Terceira mensagem concorrente na mesma sessão.',
    })

    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'turn:aborted' && e.turnId === turn2.turnId),
      ).toBe(true)
      expect(
        events.some((e) => e.type === 'turn:completed' && e.turnId === turn3.turnId),
      ).toBe(true)
    })

    unsub()
    await kernel.stop()
  })

  it('[Adversarial] emits turn:keepalive when LLM stream emits only <think> reasoning deltas for longer than keepaliveIntervalMs', async () => {
    const dir = makeTempDir()
    const encoder = new TextEncoder()

    const mockFetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"<think>Analisando arquitetura profunda..."}}]}\n\n',
            ),
          )
          await new Promise((r) => setTimeout(r, 70))
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":" mais raciocínio interno</think>Pronto, Carlos!"}}]}\n\ndata: [DONE]\n\n',
            ),
          )
          controller.close()
        },
      })

      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
      keepaliveIntervalMs: 25,
    })

    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'deepseek/deepseek-r1',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Pense profundamente sobre o design do nosso banco de dados.',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:completed')).toBe(true)
    })

    unsub()

    const keepalives = events.filter((e) => e.type === 'turn:keepalive')
    expect(keepalives.length).toBeGreaterThanOrEqual(1)

    const completed = events.find((e) => e.type === 'turn:completed')
    if (completed?.type === 'turn:completed') {
      expect(completed.assistantMessage.content).toBe('Pronto, Carlos!')
      expect(completed.assistantMessage.content).not.toContain('Analisando arquitetura')
    }

    await kernel.stop()
  })

  it('[Adversarial] isolates post-turn SQLite persistence failures so turn:completed still delivers the assistant response with persistenceWarning populated', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"Resposta entregue mesmo com falha de disco."}}]}\n\n',
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

    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    // Simulate post-turn SQLite failure during appendChatMessage for the assistant turn
    const origAppend = kernel.cortex.appendChatMessage.bind(kernel.cortex)
    vi.spyOn(kernel.cortex, 'appendChatMessage').mockImplementation((msg) => {
      if (msg.role === 'assistant') {
        throw new Error('SQLITE_FULL: database or disk is full')
      }
      return origAppend(msg)
    })

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Testando isolamento de falha de persistência pós-turno.',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:completed')).toBe(true)
    })

    unsub()

    const completed = events.find((e) => e.type === 'turn:completed')
    expect(completed?.type).toBe('turn:completed')
    if (completed?.type === 'turn:completed') {
      expect(completed.assistantMessage.content).toBe(
        'Resposta entregue mesmo com falha de disco.',
      )
      expect(completed.persistenceWarning).toContain('SQLITE_FULL')
      expect(completed.snapshot.runtimeDiagnostics.lastPersistenceWarning).toContain(
        'SQLITE_FULL',
      )
    }

    await kernel.stop()
  })

  it('hot-loads edited voice.md into the next turn prompt and supports session & memory CRUD', async () => {
    const dir = makeTempDir()
    let lastRequestBody: Record<string, unknown> | null = null

    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        lastRequestBody = JSON.parse(init.body) as Record<string, unknown>
      }
      const sse =
        'data: {"choices":[{"delta":{"content":"Voz customizada ativa."}}]}\n\ndata: [DONE]\n\n'
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    // Save custom voice.md and verify hot-load on next turn
    const savedVoice = await kernel.saveVoiceIdentity(
      '# Ashy Custom Voice\nSempre mencione café expresso duplo da madrugada.',
    )
    expect(savedVoice.diagnostics.status).toBe('ok')

    const newSession = await kernel.createSession('Sessão de Arquitetura 02h')
    const selected = await kernel.selectSession(newSession.id)
    expect(selected.session.title).toBe('Sessão de Arquitetura 02h')

    const fact1 = await kernel.upsertSemanticFact({
      category: 'preference',
      subject: 'user',
      predicate: 'drink',
      object: 'Chá verde',
    })
    const fact2 = await kernel.upsertSemanticFact({
      category: 'preference',
      subject: 'user',
      predicate: 'drink',
      object: 'Café expresso duplo',
    })
    expect(fact2.id).not.toBe(fact1.id)

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    await kernel.sendTurn({
      sessionId: newSession.id,
      text: 'Qual é a boa desta madrugada no nosso estúdio?',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:completed')).toBe(true)
    })
    unsub()

    expect(JSON.stringify(lastRequestBody)).toContain(
      'Sempre mencione café expresso duplo da madrugada.',
    )

    await kernel.deleteMemoryItem({ kind: 'fact', id: fact2.id })
    const snapAfterDelete = await kernel.getBootstrapSnapshot()
    expect(snapAfterDelete.memories.facts.some((f) => f.id === fact2.id)).toBe(false)

    await kernel.stop()
  })

  it('forwards interruptionControlNote from sendTurn into cortex.compileTurnPrompt so the LLM receives [VOICE BARGE-IN RECEIPT]', async () => {
    const dir = makeTempDir()
    let lastRequestBody: Record<string, unknown> | null = null

    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        lastRequestBody = JSON.parse(init.body) as Record<string, unknown>
      }
      const sse =
        'data: {"choices":[{"delta":{"content":"Entendi a interrupção, vamos direto ao ponto!"}}]}\n\ndata: [DONE]\n\n'
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    const note =
      '[Interrupted after 900ms — user heard: "Olha só" | unheard: "o resto da frase."]'

    await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Espera, foca só no banco de dados agora!',
      interruptionControlNote: note,
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:completed')).toBe(true)
    })
    unsub()

    const serializedBody = JSON.stringify(lastRequestBody)
    expect(serializedBody).toContain('[VOICE BARGE-IN RECEIPT]')
    expect(serializedBody).toContain('Interrupted after 900ms')
    expect(serializedBody).toContain('Voice Barge-In Receipt:')

    await kernel.stop()
  })

  it('boots with Phase 7 agency snapshot (4 built-in servers, 3 meta-tools), stages write_project_note in ask mode, writes real file on approval, and persists audit log in ashy.db', async () => {
    const dir = makeTempDir()
    const kernel1 = await createAshyHostKernel({ userDataDir: dir })

    const boot1 = await kernel1.getBootstrapSnapshot()
    expect(boot1.agency).toBeDefined()
    expect(boot1.agency?.exposedMetaToolsCount).toBe(3)
    expect(boot1.agency?.registeredMcpToolsCount).toBe(5)
    expect(boot1.agency?.consent.approvalPolicy).toBe('ask')
    expect(boot1.agency?.consent.eyesMode).toBe('off')
    expect(boot1.agency?.tools.map((t) => t.toolName)).toEqual(
      expect.arrayContaining([
        'get_active_window_title',
        'capture_authorized_screen',
        'read_workspace_file',
        'write_project_note',
        'run_cleanup_command',
      ]),
    )

    const targetNotePath = path.join(dir, 'notes', 'phase-7-architecture.md').replace(/\\/g, '/')
    const stageRes = await kernel1.callMcpTool!({
      toolName: 'write_project_note',
      args: {
        title: 'Phase 7 Architecture',
        path: targetNotePath,
        content: '# Phase 7\n Decisão registrada com sucesso.',
      },
    })

    expect(stageRes.status).toBe('staged')
    expect(stageRes.pendingCard).toBeDefined()
    expect(stageRes.pendingCard?.toolName).toBe('write_project_note')
    expect(stageRes.pendingCard?.diffPreview).toContain('+# Phase 7')
    expect(fs.existsSync(targetNotePath)).toBe(false)

    const approveRes = await kernel1.approvePendingAction!({
      actionId: stageRes.pendingCard!.id,
      scope: 'once',
    })
    expect(approveRes.status).toBe('executed')
    expect(fs.existsSync(targetNotePath)).toBe(true)
    expect(fs.readFileSync(targetNotePath, 'utf8')).toContain('Decisão registrada com sucesso.')

    const readRes = await kernel1.callMcpTool!({
      toolName: 'read_workspace_file',
      args: { path: targetNotePath },
    })
    expect(readRes.status).toBe('executed')
    expect(JSON.stringify(readRes.output)).toContain('Decisão registrada com sucesso.')

    // Adversarial: path traversal attempt on write_project_note is blocked and logged
    const traversalRes = await kernel1.callMcpTool!({
      toolName: 'write_project_note',
      args: {
        title: 'Evil Note',
        path: '../../outside-sandbox.md',
        content: 'pwned',
      },
    })
    expect(traversalRes.status).toBe('blocked_traversal')

    await kernel1.stop()

    // Reboot kernel2 on same directory and verify audit trail persisted in SQLite
    const kernel2 = await createAshyHostKernel({ userDataDir: dir })
    const boot2 = await kernel2.getBootstrapSnapshot()
    const decisions = boot2.agency?.auditLog.map((e) => `${e.toolName}:${e.decision}`) ?? []
    expect(decisions).toContain('write_project_note:staged')
    expect(decisions).toContain('write_project_note:approved')
    expect(decisions).toContain('write_project_note:blocked_traversal')
    expect(decisions).toContain('read_workspace_file:allowed')
    await kernel2.stop()
  })

  it('supports Modo Não Pergunte (auto_accept) to auto-approve queued pending actions and immediately execute tools, plus risk overrides and session revocation', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })

    // Stage a pending note while in default 'ask' mode
    const staged = await kernel.callMcpTool!({
      toolName: 'write_project_note',
      args: {
        title: 'Queued Before Auto Accept',
        content: 'Nota que estava aguardando aprovação.',
      },
    })
    expect(staged.status).toBe('staged')
    expect(staged.snapshot?.pendingActions).toHaveLength(1)

    // Enable Modo Não Pergunte ('auto_accept') -> auto-approves queued action immediately
    const snapAuto = await kernel.updateAgencyConsent!({
      approvalPolicy: 'auto_accept',
    })
    expect(snapAuto.consent.approvalPolicy).toBe('auto_accept')
    expect(snapAuto.pendingActions).toHaveLength(0)

    const autoQueuedPath = path.join(dir, 'notes', 'queued-before-auto-accept.md')
    expect(fs.existsSync(autoQueuedPath)).toBe(true)

    // Subsequent write_project_note and run_cleanup_command execute immediately without asking
    const directWrite = await kernel.callMcpTool!({
      toolName: 'write_project_note',
      args: {
        title: 'Direct Auto Note',
        content: 'Escrita direta em modo auto_accept.',
      },
    })
    expect(directWrite.status).toBe('executed')
    expect(directWrite.pendingCard).toBeUndefined()
    expect(fs.existsSync(path.join(dir, 'notes', 'direct-auto-note.md'))).toBe(true)

    const directCleanup = await kernel.callMcpTool!({
      toolName: 'run_cleanup_command',
      args: {
        command: 'rm -rf ./dist-temp',
      },
    })
    expect(directCleanup.status).toBe('executed')
    expect(
      directCleanup.snapshot?.auditLog.some(
        (e) =>
          e.toolName === 'run_cleanup_command' &&
          e.decision === 'allowed' &&
          (e.reason ?? '').includes('auto_accept'),
      ),
    ).toBe(true)

    // Switch back to 'ask' and escalate read_workspace_file to 'staged-confirm'
    await kernel.updateAgencyConsent!({
      approvalPolicy: 'ask',
      toolRiskOverrides: {
        read_workspace_file: 'staged-confirm',
      },
    })

    const escalatedRead = await kernel.callMcpTool!({
      toolName: 'read_workspace_file',
      args: { path: '/workspace/ashy/README.md' },
    })
    expect(escalatedRead.status).toBe('staged')

    const approvedSession = await kernel.approvePendingAction!({
      actionId: escalatedRead.pendingCard!.id,
      scope: 'session',
    })
    expect(approvedSession.snapshot?.sessionApprovedTools).toContain('read_workspace_file')

    const afterRevoke = await kernel.revokeSessionPermissions!()
    expect(afterRevoke.sessionApprovedTools).toHaveLength(0)
    expect(afterRevoke.auditLog.some((e) => e.decision === 'revoked')).toBe(true)

    await kernel.stop()
  })

  it('enforces EyesMode privacy gate (0 frames when off), deduplicates static frames via 64-bit dHash, and wires vision summary into TurnOrchestrator screenContext', async () => {
    const dir = makeTempDir()
    let lastRequestBody: Record<string, unknown> | null = null

    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        lastRequestBody = JSON.parse(init.body) as Record<string, unknown>
      }
      const sse =
        'data: {"choices":[{"delta":{"content":"Estou vendo seu VS Code aberto!"}}]}\n\ndata: [DONE]\n\n'
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    // 1. eyesMode === 'off' -> 0 frames captured, blocked_privacy logged
    const blockedObs = await kernel.captureAuthorizedScreen!({
      windowTitle: 'VS Code — Ashy',
    })
    expect(blockedObs.observation.blockedByPrivacy).toBe(true)
    expect(blockedObs.observation.observed).toBe(false)
    expect(blockedObs.snapshot.vision.framesCapturedCount).toBe(0)
    expect(blockedObs.snapshot.vision.blockedPrivacyCount).toBe(1)

    // 2. Enable eyesMode === 'window' -> Frame 1 captured, Frame 2 static skipped by dHash (0 tokens)
    await kernel.updateAgencyConsent!({
      eyesMode: 'window',
    })

    const obs1 = await kernel.captureAuthorizedScreen!({
      windowTitle: 'VS Code — Ashy',
      frameFixtureId: 'changed-ide-frame',
    })
    expect(obs1.observation.observed).toBe(true)
    expect(obs1.observation.skippedByDhash).toBe(false)
    expect(obs1.observation.visionTokensSpent).toBeGreaterThan(0)
    expect(obs1.snapshot.vision.framesCapturedCount).toBe(1)

    const obs2 = await kernel.captureAuthorizedScreen!({
      windowTitle: 'VS Code — Ashy',
      frameFixtureId: 'static-frame',
    })
    expect(obs2.observation.observed).toBe(true)
    expect(obs2.observation.skippedByDhash).toBe(true)
    expect(obs2.observation.visionTokensSpent).toBe(0)
    expect(obs2.snapshot.vision.framesSkippedByDhashCount).toBe(1)
    expect(obs2.snapshot.vision.framesCapturedCount).toBe(1)

    // 3. TurnOrchestrator automatically injects active vision summary as screenContext
    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'O que você acha do código que está na minha tela?',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:completed')).toBe(true)
    })
    unsub()

    const serializedBody = JSON.stringify(lastRequestBody)
    expect(serializedBody).toContain('Active Screen/Window:')
    expect(serializedBody).toContain('VS Code — Ashy')

    await kernel.stop()
  })

  it('populates Phase 8 memories snapshot fields, updates milestones & initiative policy (rejecting invalid 25:99), evaluates attention initiative with DND/spoken message append, and preserves M4 eval metrics', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })

    try {
      await kernel.seedDemoFixtures()
      const snap0 = await kernel.getBootstrapSnapshot()

      // 1. Verify Phase 8 snapshot fields in memories
      expect(Array.isArray(snap0.memories.crossEpisodeLinks)).toBe(true)
      expect(Array.isArray(snap0.memories.dreamJournalEntries)).toBe(true)
      expect(snap0.memories.initiativePolicy).toBeDefined()
      expect(snap0.memories.initiativePolicy?.enabled).toBe(true)
      expect(snap0.memories.initiativePolicy?.quietHoursStart).toBe('23:00')
      expect(Array.isArray(snap0.memories.initiativeLog)).toBe(true)
      expect(snap0.memories.roomEnvironment).toBeDefined()
      expect(snap0.memories.roomEnvironment?.unlockedTrophies.length).toBeGreaterThan(0)

      // 2. updateMilestone updates title/narrative/category and rejects invalid input
      const targetMilestone = snap0.relationship.milestones[0]!
      const updatedMilestone = await kernel.updateMilestone!({
        id: targetMilestone.id,
        title: 'Primeiro Encontro Revisado',
        narrative: 'Narrativa editada com carinho na Fase 8.',
        category: 'project_shipped',
      })
      expect(updatedMilestone.title).toBe('Primeiro Encontro Revisado')
      expect(updatedMilestone.narrative).toBe('Narrativa editada com carinho na Fase 8.')
      expect(updatedMilestone.category).toBe('project_shipped')

      await expect(
        kernel.updateMilestone!({
          id: '',
          title: 'Inválido',
        }),
      ).rejects.toThrow(/Invalid RPC argument/i)

      // 3. updateInitiativePolicy persists valid policy and rejects invalid HH:MM ('25:99')
      const updatedPolicy = await kernel.updateInitiativePolicy!({
        cooldownMinutes: 45,
        maxDailyInitiatives: 4,
        quietHoursStart: '22:30',
        quietHoursEnd: '07:30',
      })
      expect(updatedPolicy.cooldownMinutes).toBe(45)
      expect(updatedPolicy.maxDailyInitiatives).toBe(4)
      expect(updatedPolicy.quietHoursStart).toBe('22:30')
      expect(updatedPolicy.quietHoursEnd).toBe('07:30')

      await expect(
        kernel.updateInitiativePolicy!({
          quietHoursStart: '25:99',
        }),
      ).rejects.toThrow(/Invalid RPC argument/i)

      // 4. evaluateAttentionInitiative respects agency DND mode and appends spoken message to active session when triggered
      await kernel.updateAgencyConsent!({ dndMode: true })
      const dndSuppressed = await kernel.evaluateAttentionInitiative!({
        nowMs: Date.now() + 86_400_000,
        localTimeHHMM: '14:00',
      })
      expect(dndSuppressed.decision).toBe('suppressed_dnd')

      await kernel.updateAgencyConsent!({ dndMode: false })
      const messagesBefore = (await kernel.getBootstrapSnapshot()).messages.length

      const spokenRecord = await kernel.evaluateAttentionInitiative!({
        nowMs: Date.now() + 2 * 86_400_000,
        localTimeHHMM: '15:00',
      })
      expect(spokenRecord.decision).toBe('spoken')
      expect(spokenRecord.replyText).toBeTruthy()

      const snapAfterSpoken = await kernel.getBootstrapSnapshot()
      expect(snapAfterSpoken.messages.length).toBe(messagesBefore + 1)
      expect(snapAfterSpoken.messages.at(-1)?.content).toBe(spokenRecord.replyText)
      expect(snapAfterSpoken.memories.initiativeLog?.[0]?.id).toBe(spokenRecord.id)

      // 5. runCoreExperimentEval preserves initiativeGroundingRate and unopportuneInitiativeCount
      const evalReport = await kernel.runCoreExperimentEval({ seed: 0 })
      expect(evalReport.metrics.initiativeGroundingRate).toBe(1.0)
      expect(evalReport.metrics.unopportuneInitiativeCount).toBe(0)
    } finally {
      await kernel.stop()
    }
  })
})
