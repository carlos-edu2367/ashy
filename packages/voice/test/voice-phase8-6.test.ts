import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STT_PROVIDER_IDS, TTS_PROVIDER_IDS } from '@ashy/shared'
import {
  base64ToUint8Array,
  buildVoiceFixtureWavBytes,
  createAudioInputRingBuffer,
  createElevenLabsTtsProvider,
  createGaplessAudioPlayer,
  createGroqWhisperSttProvider,
  createHybridSpeculativeRephrase,
  createHybridVoiceEndJudge,
  createLocalKokoroHttpTtsProvider,
  createLocalWhisperHttpSttProvider,
  createOpenAiCompatibleSpeculativeRephraseFn,
  createOpenAiCompatibleVoiceEndJudgeFn,
  createOpenAiTtsProvider,
  createOpenAiWhisperSttProvider,
  createSileroOnnxVadEngine,
  createSttProviderRegistry,
  createTtsProviderRegistry,
  createVoiceSessionRuntime,
  createWebAudioWorkletCapture,
  createWebSpeechSttProvider,
  createWebSpeechTtsProvider,
  decodeHttpTtsResponse,
  decodeOmniAudioDeltaToPcm,
  decodeWavToPcmBlocks,
  downsamplePcmFloat32,
  encodeWavPcm16,
  extractPcmFrameVowelWeights,
  isWhisperSilenceHallucination,
  synthesizeVoicedSpeechPcm,
  uint8ArrayToBase64,
  type PcmAudioBlock,
  type SealedOmniAudioTurn,
  type WebSpeechRecognitionLike,
} from '../src/index'

describe('@ashy/voice — Phase 8.6 Task 1: Real STT/TTS Providers, Multi-Format Audio & Acoustic Formants', () => {
  describe('1. Groq Whisper STT & Local Whisper HTTP /inference Fallback', () => {
    it('createGroqWhisperSttProvider posts multipart WAV to https://api.groq.com/openai/v1/audio/transcriptions with whisper-large-v3-turbo', async () => {
      const wavBytes = buildVoiceFixtureWavBytes('barge-in-interrupt')
      const decoded = decodeWavToPcmBlocks(wavBytes, 20)

      let capturedUrl = ''
      let capturedAuth = ''
      let capturedModel = ''
      let capturedFormat = ''

      const groqProvider = createGroqWhisperSttProvider({
        apiKey: 'gsk_test_groq_key',
        fetchImpl: async (input, init) => {
          capturedUrl = String(input)
          const headers = init?.headers as Record<string, string> | undefined
          capturedAuth = headers?.Authorization ?? ''
          const body = init?.body as FormData
          capturedModel = String(body.get('model') ?? '')
          capturedFormat = String(body.get('response_format') ?? '')
          return new Response(
            JSON.stringify({ text: 'Transcrição ultra-rápida via Groq Whisper!' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        },
      })

      const res = await groqProvider.transcribe({
        blocks: decoded.blocks,
        language: 'pt',
      })

      expect(capturedUrl).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
      expect(capturedAuth).toBe('Bearer gsk_test_groq_key')
      expect(capturedModel).toBe('whisper-large-v3-turbo')
      expect(capturedFormat).toBe('json')
      expect(res.providerId).toBe('groq-whisper')
      expect(res.text).toBe('Transcrição ultra-rápida via Groq Whisper!')
      expect(res.confidence).toBeGreaterThan(0.9)
    })

    it('createLocalWhisperHttpSttProvider retries /inference (whisper.cpp format) automatically when /audio/transcriptions returns 404', async () => {
      const wavBytes = buildVoiceFixtureWavBytes('wake-word-oi-ashy')
      const decoded = decodeWavToPcmBlocks(wavBytes, 20)

      const calledUrls: string[] = []
      const localWhisper = createLocalWhisperHttpSttProvider({
        baseUrl: 'http://127.0.0.1:8080',
        modelId: 'ggml-base.bin',
        fetchImpl: async (input) => {
          const url = String(input)
          calledUrls.push(url)
          if (url.endsWith('/audio/transcriptions')) {
            return new Response('Not Found', { status: 404 })
          }
          if (url.endsWith('/inference')) {
            return new Response(
              JSON.stringify({ text: '  Ei Ashy, servidor whisper.cpp respondeu!  ' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            )
          }
          return new Response('Unexpected URL', { status: 500 })
        },
      })

      const res = await localWhisper.transcribe({ blocks: decoded.blocks, language: 'pt' })
      expect(calledUrls[0]).toBe('http://127.0.0.1:8080/audio/transcriptions')
      expect(calledUrls).toContain('http://127.0.0.1:8080/inference')
      expect(res.providerId).toBe('local-whisper-http')
      expect(res.text).toBe('Ei Ashy, servidor whisper.cpp respondeu!')
    })
  })

  describe('2. Strict No Silent Fallback by Default (allowOfflineFallback: false)', () => {
    it('throws explicit HTTP/network errors on all real STT and TTS providers when allowOfflineFallback is not enabled', async () => {
      const wavBytes = buildVoiceFixtureWavBytes('barge-in-interrupt')
      const decoded = decodeWavToPcmBlocks(wavBytes, 20)
      const failingFetch: typeof fetch = async () =>
        new Response('Unauthorized', { status: 401 })

      const openaiStt = createOpenAiWhisperSttProvider({ fetchImpl: failingFetch })
      await expect(openaiStt.transcribe({ blocks: decoded.blocks })).rejects.toThrow(/401/)

      const groqStt = createGroqWhisperSttProvider({ fetchImpl: failingFetch })
      await expect(groqStt.transcribe({ blocks: decoded.blocks })).rejects.toThrow(/401/)

      const localStt = createLocalWhisperHttpSttProvider({ fetchImpl: failingFetch })
      await expect(localStt.transcribe({ blocks: decoded.blocks })).rejects.toThrow(/401/)

      const elevenTts = createElevenLabsTtsProvider({ fetchImpl: failingFetch })
      await expect(elevenTts.synthesize({ text: 'Teste de erro explícito' })).rejects.toThrow(/401/)

      const openaiTts = createOpenAiTtsProvider({ fetchImpl: failingFetch })
      await expect(openaiTts.synthesize({ text: 'Teste de erro explícito' })).rejects.toThrow(/401/)

      const kokoroTts = createLocalKokoroHttpTtsProvider({ fetchImpl: failingFetch })
      await expect(kokoroTts.synthesize({ text: 'Teste de erro explícito' })).rejects.toThrow(/401/)
    })
  })

  describe('3. Web Speech API STT & TTS Providers + Complete Provider Registries', () => {
    it('createWebSpeechSttProvider transcribes via injected recognitionFactory and throws when Web Speech API is unavailable', async () => {
      const wavBytes = buildVoiceFixtureWavBytes('barge-in-interrupt')
      const decoded = decodeWavToPcmBlocks(wavBytes, 20)

      const mockWebStt = createWebSpeechSttProvider({
        lang: 'pt-BR',
        recognitionFactory: () => {
          const rec: WebSpeechRecognitionLike = {
            lang: 'pt-BR',
            continuous: false,
            interimResults: false,
            onresult: null,
            onerror: null,
            onend: null,
            start() {
              setTimeout(() => {
                rec.onresult?.({
                  results: [[{ transcript: 'Fala reconhecida pelo navegador', confidence: 0.96 }]],
                })
                rec.onend?.()
              }, 5)
            },
            stop() {},
            abort() {},
          }
          return rec
        },
      })

      const res = await mockWebStt.transcribe({ blocks: decoded.blocks })
      expect(res.providerId).toBe('web-speech-stt')
      expect(res.text).toBe('Fala reconhecida pelo navegador')
      expect(res.confidence).toBeCloseTo(0.96, 2)

      const unavailableWebStt = createWebSpeechSttProvider({
        recognitionFactory: () => null,
        allowOfflineFallback: false,
      })
      await expect(unavailableWebStt.transcribe({ blocks: decoded.blocks })).rejects.toThrow(
        /Web Speech STT/i,
      )
    })

    it('createWebSpeechTtsProvider speaks via injected speechSynthesis and throws when unavailable', async () => {
      const spokenTexts: string[] = []
      const mockWebTts = createWebSpeechTtsProvider({
        speechSynthesis: {
          speak(utterance: { text: string; onend?: (() => void) | null }) {
            spokenTexts.push(utterance.text)
            utterance.onend?.()
          },
          cancel() {},
          getVoices() {
            return [{ voiceURI: 'pt-BR-voice', name: 'Português Brasil', lang: 'pt-BR' }]
          },
        },
      })

      const res = await mockWebTts.synthesize({
        text: 'Olá, falando pelo sintetizador nativo!',
        voiceId: 'pt-BR-voice',
      })
      expect(res.providerId).toBe('web-speech-tts')
      expect(spokenTexts).toEqual(['Olá, falando pelo sintetizador nativo!'])
      expect(res.samples.length).toBeGreaterThan(0)
      expect(res.vowelFrames.length).toBeGreaterThan(0)

      const unavailableWebTts = createWebSpeechTtsProvider({
        speechSynthesis: null,
        allowOfflineFallback: false,
      })
      await expect(
        unavailableWebTts.synthesize({ text: 'Sem suporte no ambiente headless' }),
      ).rejects.toThrow(/Web Speech TTS/i)
    })

    it('createSttProviderRegistry and createTtsProviderRegistry expose all 5 STT_PROVIDER_IDS and 5 TTS_PROVIDER_IDS', () => {
      const sttRegistry = createSttProviderRegistry()
      expect(sttRegistry.listIds()).toEqual(STT_PROVIDER_IDS)
      for (const id of STT_PROVIDER_IDS) {
        expect(sttRegistry.get(id).id).toBe(id)
      }

      const ttsRegistry = createTtsProviderRegistry()
      expect(ttsRegistry.listIds()).toEqual(TTS_PROVIDER_IDS)
      for (const id of TTS_PROVIDER_IDS) {
        expect(ttsRegistry.get(id).id).toBe(id)
      }
    })
  })

  describe('4. Multi-Format TTS Decoding (WAV + MP3) & Acoustic Formant Vowel Extraction', () => {
    it('extractPcmFrameVowelWeights computes distinct dominant vowels and rmsVolume from acoustic frequency profiles', () => {
      const silent = new Float32Array(320)
      const silentWeights = extractPcmFrameVowelWeights(silent, 16000)
      expect(silentWeights.dominantVowel).toBe('closed')
      expect(silentWeights.rmsVolume).toBe(0)

      // Low-frequency fundamental (~220Hz) -> rounded vowel (O / U)
      const lowTone = new Float32Array(320)
      for (let i = 0; i < 320; i++) {
        lowTone[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / 16000)
      }
      const lowWeights = extractPcmFrameVowelWeights(lowTone, 16000)
      expect(lowWeights.rmsVolume).toBeGreaterThan(0.2)
      expect(['O', 'U']).toContain(lowWeights.dominantVowel)

      // Mid-frequency formant (~950Hz) -> open vowel (A)
      const midTone = new Float32Array(320)
      for (let i = 0; i < 320; i++) {
        midTone[i] = 0.5 * Math.sin((2 * Math.PI * 950 * i) / 16000)
      }
      const midWeights = extractPcmFrameVowelWeights(midTone, 16000)
      expect(midWeights.dominantVowel).toBe('A')
      expect(midWeights.A).toBeGreaterThan(midWeights.U)

      // High-frequency formant (~2600Hz) -> front vowel (I / E)
      const highTone = new Float32Array(320)
      for (let i = 0; i < 320; i++) {
        highTone[i] = 0.5 * Math.sin((2 * Math.PI * 2600 * i) / 16000)
      }
      const highWeights = extractPcmFrameVowelWeights(highTone, 16000)
      expect(['I', 'E']).toContain(highWeights.dominantVowel)
      expect(highWeights.I + highWeights.E).toBeGreaterThan(highWeights.U)
    })

    it('decodeHttpTtsResponse decodes both RIFF/WAVE and MP3 (audio/mpeg) buffers with acoustic-modulated vowel frames', async () => {
      const sampleWav = encodeWavPcm16(
        synthesizeVoicedSpeechPcm({ durationMs: 360, sampleRate: 16000 }),
        16000,
      )
      const wavRes = await decodeHttpTtsResponse(
        'openai-tts',
        new Response(sampleWav.buffer as ArrayBuffer, {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        }),
        'Fala clara da madrugada',
        performance.now(),
      )
      expect(wavRes.providerId).toBe('openai-tts')
      expect(wavRes.durationMs).toBe(360)
      expect(wavRes.samples.length).toBe(Math.round(0.36 * 16000))
      expect(wavRes.vowelFrames.length).toBeGreaterThan(0)

      // Synthetic MP3 buffer with ID3 header + MPEG frame sync bytes (0xFF 0xFB)
      const fakeMp3 = new Uint8Array(4096)
      fakeMp3.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 0)
      fakeMp3[10] = 0xff
      fakeMp3[11] = 0xfb
      for (let i = 12; i < fakeMp3.length; i++) {
        fakeMp3[i] = (i * 73) & 0xff
      }

      const mp3Res = await decodeHttpTtsResponse(
        'elevenlabs',
        new Response(fakeMp3.buffer as ArrayBuffer, {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        }),
        'Olá estúdio noturno em MP3!',
        performance.now(),
      )
      expect(mp3Res.providerId).toBe('elevenlabs')
      expect(mp3Res.samples.length).toBeGreaterThan(0)
      expect(mp3Res.durationMs).toBeGreaterThan(0)
      expect(mp3Res.vowelFrames.length).toBeGreaterThan(0)

      // Empty 0-byte response must throw
      await expect(
        decodeHttpTtsResponse(
          'elevenlabs',
          new Response(new Uint8Array(0).buffer as ArrayBuffer, {
            status: 200,
            headers: { 'Content-Type': 'audio/mpeg' },
          }),
          'Texto vazio',
          performance.now(),
        ),
      ).rejects.toThrow(/empty/i)
    })
  })
})

describe('@ashy/voice — Phase 8.6 Task 2: Real Microphone Capture, Silero ONNX VAD, LLM Turn-Intelligence & Streaming Gapless Player', () => {
  describe('1. Anti-Aliasing PCM Downsampler (downsamplePcmFloat32)', () => {
    it('downsamples 48kHz and 44.1kHz PCM to 16kHz with exact sample count and anti-aliasing window averaging', () => {
      // 20ms at 48000Hz = 960 samples -> 320 samples at 16000Hz
      const input48k = new Float32Array(960)
      for (let i = 0; i < input48k.length; i++) {
        // 200Hz speech fundamental + 18kHz ultrasonic tone that should be attenuated by 3-sample box filter
        input48k[i] =
          0.6 * Math.sin((2 * Math.PI * 200 * i) / 48000) +
          0.3 * Math.sin((2 * Math.PI * 16000 * i) / 48000)
      }

      const out16k = downsamplePcmFloat32(input48k, 48000, 16000)
      expect(out16k).toBeInstanceOf(Float32Array)
      expect(out16k.length).toBe(320)

      // Verify 200Hz sine wave energy is preserved
      let sumSq = 0
      for (let i = 0; i < out16k.length; i++) {
        sumSq += out16k[i]! * out16k[i]!
      }
      const rms = Math.sqrt(sumSq / out16k.length)
      expect(rms).toBeGreaterThan(0.35)
      expect(rms).toBeLessThan(0.5)

      // 20ms at 44100Hz = 882 samples -> 320 samples at 16000Hz
      const input44k = new Float32Array(882).fill(0.25)
      const outFrom44k = downsamplePcmFloat32(input44k, 44100, 16000)
      expect(outFrom44k.length).toBe(320)
      for (let i = 0; i < outFrom44k.length; i++) {
        expect(outFrom44k[i]!).toBeCloseTo(0.25, 4)
      }

      // Same sample rate returns a defensive copy
      const copy16k = downsamplePcmFloat32(out16k, 16000, 16000)
      expect(copy16k).not.toBe(out16k)
      expect(copy16k.length).toBe(320)
      expect(copy16k[0]).toBeCloseTo(out16k[0]!, 6)
    })

    it('rejects non-positive or non-finite sample rates and handles empty Float32Array', () => {
      expect(() => downsamplePcmFloat32(new Float32Array(10), 0, 16000)).toThrow(/sampleRate/i)
      expect(() => downsamplePcmFloat32(new Float32Array(10), -48000, 16000)).toThrow(/sampleRate/i)
      expect(() => downsamplePcmFloat32(new Float32Array(10), 48000, 0)).toThrow(/sampleRate/i)
      expect(() => downsamplePcmFloat32(new Float32Array(10), Number.NaN, 16000)).toThrow(
        /sampleRate/i,
      )
      expect(downsamplePcmFloat32(new Float32Array(0), 48000, 16000)).toHaveLength(0)
    })
  })

  describe('2. Stateful Silero ONNX VAD Engine (createSileroOnnxVadEngine)', () => {
    it('maintains recurrent state tensor (2*1*128) across frames, reports engineMode="silero-onnx", and resets state on reset()', async () => {
      const capturedStateSnapshots: Float32Array[] = []
      const capturedSampleRates: number[] = []
      let callCount = 0

      const vad = createSileroOnnxVadEngine({
        onnxSession: {
          async run(feeds) {
            callCount += 1
            const stateFeed = feeds.state as { data: Float32Array }
            const srFeed = feeds.sr as { data: BigInt64Array | Int32Array | number[] }
            capturedStateSnapshots.push(new Float32Array(stateFeed.data))
            capturedSampleRates.push(Number(srFeed.data[0]))

            const nextState = new Float32Array(2 * 1 * 128)
            nextState.fill(callCount * 0.25)
            return {
              output: { data: new Float32Array([0.92]) },
              stateN: { data: nextState },
            }
          },
        },
      })

      const block0: PcmAudioBlock = {
        startFrame: 0,
        endFrame: 320,
        sampleRate: 16000,
        durationMs: 20,
        samples: synthesizeVoicedSpeechPcm({ durationMs: 20, sampleRate: 16000 }),
      }
      const block1: PcmAudioBlock = {
        startFrame: 320,
        endFrame: 640,
        sampleRate: 16000,
        durationMs: 20,
        samples: synthesizeVoicedSpeechPcm({ durationMs: 20, sampleRate: 16000 }),
      }

      const res0 = await vad.processBlock(block0)
      expect(res0.engineMode).toBe('silero-onnx')
      expect(vad.getEngineMode?.()).toBe('silero-onnx')
      expect(res0.probability).toBeGreaterThan(0.7)
      expect(res0.isSpeechCandidate).toBe(true)
      expect(capturedStateSnapshots[0]!.length).toBe(256)
      expect(capturedStateSnapshots[0]![0]).toBe(0)
      expect(capturedSampleRates[0]).toBe(16000)

      // Frame 1 must receive the updated stateN tensor from frame 0
      const res1 = await vad.processBlock(block1)
      expect(res1.engineMode).toBe('silero-onnx')
      expect(capturedStateSnapshots[1]![0]).toBeCloseTo(0.25, 5)

      // reset() zeroes the recurrent state tensor
      vad.reset()
      await vad.processBlock(block0)
      expect(capturedStateSnapshots[2]![0]).toBe(0)
    })

    it('falls back to engineMode="hybrid-dsp" when no ONNX session is available or when session inference throws', async () => {
      const noSessionVad = createSileroOnnxVadEngine()
      const voicedBlock: PcmAudioBlock = {
        startFrame: 0,
        endFrame: 320,
        sampleRate: 16000,
        durationMs: 20,
        samples: synthesizeVoicedSpeechPcm({ durationMs: 20, sampleRate: 16000 }),
      }

      const dspRes = await noSessionVad.processBlock(voicedBlock)
      expect(dspRes.engineMode).toBe('hybrid-dsp')
      expect(noSessionVad.getEngineMode?.()).toBe('hybrid-dsp')
      expect(dspRes.probability).toBeGreaterThanOrEqual(0.65)
      expect(dspRes.isSpeechCandidate).toBe(true)

      const throwingOnnxVad = createSileroOnnxVadEngine({
        onnxSession: {
          async run() {
            throw new Error('ONNX WASM memory error')
          },
        },
      })
      const fallbackRes = await throwingOnnxVad.processBlock(voicedBlock)
      expect(fallbackRes.engineMode).toBe('hybrid-dsp')
      expect(throwingOnnxVad.getEngineMode?.()).toBe('hybrid-dsp')
      expect(fallbackRes.probability).toBeGreaterThanOrEqual(0.65)
      expect(fallbackRes.isSpeechCandidate).toBe(true)
    })
  })

  describe('3. Real LLM Turn-Intelligence & Whisper Silence Hallucination Filter (turn-intelligence.ts)', () => {
    it('createOpenAiCompatibleVoiceEndJudgeFn calls /chat/completions with reasoning_effort="none", parses JSON (including markdown fences), and retries if reasoning_effort is rejected', async () => {
      const capturedBodies: Array<Record<string, unknown>> = []
      let attempt = 0

      const llmJudgeFn = createOpenAiCompatibleVoiceEndJudgeFn({
        baseUrl: 'https://api.openai.com/v1/',
        apiKey: 'sk-judge-test',
        modelId: 'gpt-4o-mini',
        fetchImpl: async (_input, init) => {
          attempt += 1
          const parsedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
          capturedBodies.push(parsedBody)
          if (attempt === 1) {
            // Simulate a provider rejecting reasoning_effort on first call
            return new Response(
              JSON.stringify({ error: { message: 'Unknown parameter: reasoning_effort' } }),
              { status: 400, headers: { 'Content-Type': 'application/json' } },
            )
          }
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: '```json\n{"complete": false, "reason": "cut-off-clause"}\n```',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        },
      })

      const hybridJudge = createHybridVoiceEndJudge({ llmJudgeFn, timeoutMs: 400 })
      const decision = await hybridJudge('Eu estava pensando se a gente pode')
      expect(decision).toEqual({
        complete: false,
        reason: 'cut-off-clause',
      })
      expect(capturedBodies).toHaveLength(2)
      expect(capturedBodies[0]!.reasoning_effort).toBe('none')
      expect(capturedBodies[0]!.temperature).toBe(0)
      expect(capturedBodies[0]!.max_tokens).toBe(40)
      expect(capturedBodies[1]!.reasoning_effort).toBeUndefined()
    })

    it('createOpenAiCompatibleSpeculativeRephraseFn calls /chat/completions to clean PT-BR disfluencies', async () => {
      let capturedUrl = ''
      let capturedBody: Record<string, unknown> = {}

      const llmRephraseFn = createOpenAiCompatibleSpeculativeRephraseFn({
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelId: 'qwen2.5:3b',
        fetchImpl: async (input, init) => {
          capturedUrl = String(input)
          capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'Eu acho que precisamos revisar o módulo de áudio.',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        },
      })

      const rephrase = createHybridSpeculativeRephrase({ llmRephraseFn, timeoutMs: 450 })
      const result = await rephrase('hum, é... eu acho que, tipo, precisamos revisar o módulo de áudio')
      expect(capturedUrl).toBe('http://127.0.0.1:11434/v1/chat/completions')
      expect(capturedBody.model).toBe('qwen2.5:3b')
      expect(capturedBody.temperature).toBe(0)
      expect(capturedBody.max_tokens).toBe(200)
      expect(capturedBody.reasoning_effort).toBe('none')
      expect(result).toBe('Eu acho que precisamos revisar o módulo de áudio.')
    })

    it('isWhisperSilenceHallucination filters out blank/silence/subtitle artifacts while preserving real speech', () => {
      const hallucinations = [
        '',
        '   ',
        '...',
        '.',
        '?',
        '[BLANK_AUDIO]',
        '(blank_audio)',
        '[silêncio]',
        '(Silêncio)',
        '[silence]',
        '(silence)',
        '[música]',
        '(música)',
        '[music]',
        'Obrigado por assistir.',
        'Legendas pela comunidade Amara.org',
        'Subtitles by the Amara.org community',
        'Thank you for watching!',
      ]
      for (const h of hallucinations) {
        expect(isWhisperSilenceHallucination(h)).toBe(true)
      }

      const validUtterances = [
        'Oi Ashy',
        'Roda os testes do pacote voice.',
        'Sim',
        'Não, espera um segundo!',
      ]
      for (const valid of validUtterances) {
        expect(isWhisperSilenceHallucination(valid)).toBe(false)
      }
    })
  })

  describe('4. Real Microphone Capture (48kHz -> 16kHz) & Red-Team H4 captureGenerationId Concurrency Guard', () => {
    it('captures 48kHz microphone stream, downsamples to 20ms (320-sample) 16kHz PcmAudioBlocks, reports RMS, and stops tracks on setMicMode("muted")', async () => {
      let trackStopped = false
      let audioCtxClosed = false
      let processorCallback: ((event: { inputBuffer: { getChannelData(ch: number): Float32Array } }) => void) | null =
        null

      const mockStream = {
        getTracks: () => [
          {
            stop() {
              trackStopped = true
            },
          },
        ],
      }

      const rmsLevels: number[] = []
      const emittedBlocks: PcmAudioBlock[] = []

      const runtime = createVoiceSessionRuntime({
        micMode: 'muted',
      })

      await runtime.startMicrophoneCapture({
        deviceId: 'usb-studio-mic',
        mediaDevices: {
          async getUserMedia(constraints) {
            const audio = constraints.audio as Record<string, unknown>
            expect(audio.echoCancellation).toBe(true)
            expect(audio.noiseSuppression).toBe(true)
            expect(audio.autoGainControl).toBe(true)
            expect(audio.deviceId).toEqual({ exact: 'usb-studio-mic' })
            return mockStream
          },
        },
        audioContextFactory: () => ({
          sampleRate: 48000,
          destination: {},
          createMediaStreamSource: () => ({
            connect() {},
            disconnect() {},
          }),
          createScriptProcessor: () => {
            const node = {
              onaudioprocess: null as
                | ((event: { inputBuffer: { getChannelData(ch: number): Float32Array } }) => void)
                | null,
              connect() {
                processorCallback = node.onaudioprocess
              },
              disconnect() {},
            }
            return node
          },
          async close() {
            audioCtxClosed = true
          },
        }),
        onRmsLevel: (rms) => rmsLevels.push(rms),
        onPcmBlock: (aecBlock) => {
          emittedBlocks.push(aecBlock)
        },
      })

      // Starting microphone capture when muted automatically switches micMode to 'continuous'
      expect(runtime.getMicMode()).toBe('continuous')
      expect(runtime.isCapturingMicrophone()).toBe(true)
      expect(processorCallback).not.toBeNull()

      // Feed two 1024-sample buffers at 48000Hz (total 2048 samples at 48kHz -> ~682 samples at 16kHz -> two 320-sample 20ms blocks + 42 remainder)
      const frame48k = new Float32Array(1024)
      for (let i = 0; i < frame48k.length; i++) {
        frame48k[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / 48000)
      }

      processorCallback!({
        inputBuffer: { getChannelData: () => frame48k },
      })
      processorCallback!({
        inputBuffer: { getChannelData: () => frame48k },
      })

      // Wait a tick for async ingestPcmBlock
      await new Promise((r) => setTimeout(r, 10))

      expect(emittedBlocks).toHaveLength(2)
      expect(emittedBlocks[0]!.sampleRate).toBe(16000)
      expect(emittedBlocks[0]!.samples.length).toBe(320)
      expect(emittedBlocks[0]!.durationMs).toBe(20)
      expect(emittedBlocks[0]!.startFrame).toBe(0)
      expect(emittedBlocks[0]!.endFrame).toBe(320)
      expect(emittedBlocks[1]!.startFrame).toBe(320)
      expect(emittedBlocks[1]!.endFrame).toBe(640)

      expect(rmsLevels.length).toBe(2)
      expect(rmsLevels[0]!).toBeGreaterThan(0.2)
      expect(runtime.getWorkletCapture().getLastRmsLevel()).toBeGreaterThan(0.2)

      // Switching micMode to 'muted' must automatically stop active microphone capture and tracks
      runtime.setMicMode('muted')
      await new Promise((r) => setTimeout(r, 10))

      expect(runtime.isCapturingMicrophone()).toBe(false)
      expect(trackStopped).toBe(true)
      expect(audioCtxClosed).toBe(true)
      expect(runtime.getWorkletCapture().getLastRmsLevel()).toBe(0)
    })

    it('Red-Team H4: rapid startMicrophoneCapture() followed by stopMicrophoneCapture() before getUserMedia resolves immediately stops tracks and prevents AudioContext leak', async () => {
      let resolveGetUserMedia: ((stream: { getTracks(): Array<{ stop(): void }> }) => void) | null =
        null
      let trackStopped = false
      let audioContextCreatedCount = 0

      const capture = createWebAudioWorkletCapture({
        aecRingBuffer: createAudioInputRingBuffer({ baseHistoryMs: 400 }),
      })

      const startPromise = capture.startMicrophoneCapture({
        mediaDevices: {
          getUserMedia: () =>
            new Promise((resolve) => {
              resolveGetUserMedia = resolve
            }),
        },
        audioContextFactory: () => {
          audioContextCreatedCount += 1
          return {
            sampleRate: 48000,
            destination: {},
          }
        },
      })

      // User immediately stops capture while getUserMedia is still pending!
      expect(resolveGetUserMedia).not.toBeNull()
      await capture.stopMicrophoneCapture()
      expect(capture.isCapturingMicrophone()).toBe(false)

      // Now getUserMedia resolves late
      resolveGetUserMedia!({
        getTracks: () => [
          {
            stop() {
              trackStopped = true
            },
          },
        ],
      })
      await startPromise

      expect(trackStopped).toBe(true)
      expect(audioContextCreatedCount).toBe(0)
      expect(capture.isCapturingMicrophone()).toBe(false)
    })

    it('adversarial: stops MediaStreamTracks and closes AudioContext if audioContext.resume() rejects after getUserMedia resolves', async () => {
      let trackStopped = false
      let audioCtxClosed = false

      const capture = createWebAudioWorkletCapture({
        aecRingBuffer: createAudioInputRingBuffer({ baseHistoryMs: 400 }),
      })

      await expect(
        capture.startMicrophoneCapture({
          mediaDevices: {
            async getUserMedia() {
              return {
                getTracks: () => [
                  {
                    stop() {
                      trackStopped = true
                    },
                  },
                ],
              }
            },
          },
          audioContextFactory: () => ({
            sampleRate: 48000,
            state: 'suspended',
            destination: {},
            async resume() {
              throw new Error('AudioContext autoplay blocked')
            },
            async close() {
              audioCtxClosed = true
            },
          }),
        }),
      ).rejects.toThrow(/autoplay blocked/i)

      expect(trackStopped).toBe(true)
      expect(audioCtxClosed).toBe(true)
      expect(capture.isCapturingMicrophone()).toBe(false)
    })
  })

  describe('5. Streaming-Safe GaplessAudioPlayer (onQueueDrained vs onPlaybackEnded) & Clean CAS Revision Bump', () => {
    it('fires onQueueDrained after each drained chunk (both via virtual clock and AudioBufferSourceNode.onended) but only fires onPlaybackEnded once markStreamComplete(true) is set', () => {
      let drainedCount = 0
      let endedCount = 0

      const player = createGaplessAudioPlayer({
        onQueueDrained: () => {
          drainedCount += 1
        },
        onPlaybackEnded: () => {
          endedCount += 1
        },
      })

      // Start streaming turn: stream is not yet complete
      player.markStreamComplete(false)
      expect(player.isStreamComplete()).toBe(false)

      // Schedule Chunk #0 (0.0s .. 0.5s)
      player.scheduleChunk({
        seq: 0,
        text: 'Primeira frase do turno,',
        durationSec: 0.5,
        startTimeSec: 0,
        endTimeSec: 0.5,
      })
      expect(player.isPlaying()).toBe(true)

      // Advance clock to 0.5s: Chunk #0 drains while Chunk #1 is still being synthesized
      player.advanceVirtualClockSec(0.5)
      expect(drainedCount).toBe(1)
      // Must NOT have fired onPlaybackEnded because streamComplete is false!
      expect(endedCount).toBe(0)

      // Schedule Chunk #1 (0.5s .. 1.1s) and mark stream complete
      player.scheduleChunk({
        seq: 1,
        text: 'segunda frase finalizando a resposta.',
        durationSec: 0.6,
        startTimeSec: 0.5,
        endTimeSec: 1.1,
      })
      player.markStreamComplete(true)
      expect(player.isStreamComplete()).toBe(true)
      expect(endedCount).toBe(0)

      // Advance clock to 1.1s: Chunk #1 finishes and stream is complete -> both fire!
      player.advanceVirtualClockSec(0.6)
      expect(drainedCount).toBe(2)
      expect(endedCount).toBe(1)
      expect(player.isPlaying()).toBe(false)

      // Also verify WebAudio AudioBufferSourceNode.onended path
      const sourceNodes: Array<{ onended?: (() => void) | null }> = []
      let webDrained = 0
      let webEnded = 0
      const webPlayer = createGaplessAudioPlayer({
        audioContext: {
          currentTime: 0,
          sampleRate: 16000,
          destination: {},
          createBuffer: (_ch, len, sr) => ({
            duration: len / sr,
            getChannelData: () => new Float32Array(len),
          }),
          createBufferSource: () => {
            const node = {
              buffer: null as unknown,
              connect() {},
              start() {},
              stop() {},
              onended: null as (() => void) | null,
            }
            sourceNodes.push(node)
            return node
          },
        },
        onQueueDrained: () => {
          webDrained += 1
        },
        onPlaybackEnded: () => {
          webEnded += 1
        },
      })

      webPlayer.markStreamComplete(false)
      webPlayer.scheduleChunk({ seq: 0, text: 'Bloco 0', durationSec: 0.4, startTimeSec: 0, endTimeSec: 0.4 })
      sourceNodes[0]!.onended?.()
      expect(webDrained).toBe(1)
      expect(webEnded).toBe(0)

      webPlayer.scheduleChunk({ seq: 1, text: 'Bloco 1', durationSec: 0.4, startTimeSec: 0.4, endTimeSec: 0.8 })
      webPlayer.markStreamComplete(true)
      sourceNodes[1]!.onended?.()
      expect(webDrained).toBe(2)
      expect(webEnded).toBe(1)
      expect(webPlayer.isPlaying()).toBe(false)
    })

    it('fires onPlaybackEnded immediately when markStreamComplete(true) is called after all scheduled chunks already drained', () => {
      let drainedCount = 0
      let endedCount = 0

      const player = createGaplessAudioPlayer({
        onQueueDrained: () => {
          drainedCount += 1
        },
        onPlaybackEnded: () => {
          endedCount += 1
        },
      })

      player.markStreamComplete(false)
      player.scheduleChunk({
        seq: 0,
        text: 'Frase única antes do fim da stream.',
        durationSec: 0.4,
        startTimeSec: 0,
        endTimeSec: 0.4,
      })

      // Chunk #0 finishes playing before LLM stream emits [DONE]
      player.advanceVirtualClockSec(0.4)
      expect(drainedCount).toBe(1)
      expect(endedCount).toBe(0)

      // LLM stream finishes without any more chunks -> markStreamComplete(true) fires onPlaybackEnded once!
      player.markStreamComplete(true)
      expect(endedCount).toBe(1)
      expect(player.isPlaying()).toBe(false)
    })

    it('verifies voice-session-runtime.ts no longer contains the artificial turnController.advanceSilence(1200) hack while Scenario A still records casRejectedCount >= 1', async () => {
      const runtimeSource = readFileSync(
        resolve(__dirname, '../src/voice-session-runtime.ts'),
        'utf-8',
      )
      expect(runtimeSource).not.toContain('turnController.advanceSilence(1200)')

      const runtime = createVoiceSessionRuntime({
        micMode: 'continuous',
        wakeWordEnabled: false,
      })
      const scenarioA = await runtime.runFixtureScenario('thinking-pause-cas')
      expect(scenarioA.snapshot.enteredGracePeriodCount).toBeGreaterThanOrEqual(1)
      expect(scenarioA.snapshot.turnState.casRejectedCount).toBeGreaterThanOrEqual(1)
      expect(scenarioA.snapshot.sealedTurns).toHaveLength(1)
      expect(scenarioA.snapshot.sealedTurns[0]!.rephrasedText).toBe(
        'Deixa eu pensar num jeito de resolver esse bug no código.',
      )
    })
  })

  describe('@ashy/voice — Phase 8.7: Direct Omni Audio Turn Capture, PCM16/WAV Delta Decoding & Native Omni Barge-In', () => {
    it('decodes base64 PCM16 (24kHz) and WAV deltas into Float32Array samples and handles malformed/odd-byte inputs safely', () => {
      const sampleRate = 24000
      const samplesCount = 2400 // 100ms
      const pcm16Bytes = new Uint8Array(samplesCount * 2)
      const view = new DataView(pcm16Bytes.buffer)
      for (let i = 0; i < samplesCount; i++) {
        const s = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5
        view.setInt16(i * 2, Math.round(s * 32767), true)
      }
      const b64 = uint8ArrayToBase64(pcm16Bytes)
      const decodedPcm = decodeOmniAudioDeltaToPcm(b64, 'pcm16', 24000)
      expect(decodedPcm.sampleRate).toBe(24000)
      expect(decodedPcm.samples.length).toBe(2400)
      expect(decodedPcm.durationMs).toBe(100)

      // WAV format decoding
      const wavBytes = encodeWavPcm16(decodedPcm.samples, 24000, 'omni-delta')
      const decodedWav = decodeOmniAudioDeltaToPcm(
        `data:audio/wav;base64,${uint8ArrayToBase64(wavBytes)}`,
        'wav',
        24000,
      )
      expect(decodedWav.sampleRate).toBe(24000)
      expect(decodedWav.samples.length).toBeGreaterThan(2000)

      // Adversarial: odd-byte PCM16 payload or empty payload does not throw RangeError
      const oddBytes = new Uint8Array([0x10, 0x20, 0x30])
      const decodedOdd = decodeOmniAudioDeltaToPcm(uint8ArrayToBase64(oddBytes), 'pcm16', 24000)
      expect(decodedOdd.samples.length).toBe(1)
      expect(base64ToUint8Array('   ').length).toBe(0)
    })

    it('seals 16kHz WAV turns directly in directOmniAudio mode without invoking external STT while preserving 360ms pre-roll, <300ms click filter, CAS revision & PTT release', async () => {
      const sealedOmniTurns: SealedOmniAudioTurn[] = []
      const runtime = createVoiceSessionRuntime({
        micMode: 'continuous',
        wakeWordEnabled: false,
        directOmniAudio: true,
        omniSilenceSealMs: 600,
        onOmniAudioTurnReady: (turn) => {
          sealedOmniTurns.push(turn)
        },
      })

      // 1. Short click (<300ms) is still ignored
      const clickResult = await runtime.runFixtureScenario('keyboard-click-noise')
      expect(clickResult.snapshot.cancelledShortCount).toBe(1)
      expect(sealedOmniTurns).toHaveLength(0)

      // 2. Thinking pause utterance seals into a single 16kHz WAV payload with pre-roll
      await runtime.runFixtureScenario('thinking-pause-cas')
      expect(sealedOmniTurns.length).toBeGreaterThanOrEqual(1)
      const firstOmniTurn = sealedOmniTurns[0]!
      expect(firstOmniTurn.sampleRate).toBe(16000)
      expect(firstOmniTurn.mimeType).toBe('audio/wav')
      expect(firstOmniTurn.wavBytes.byteLength).toBeGreaterThan(1000)
      expect(firstOmniTurn.wavBase64.length).toBeGreaterThan(500)
      expect(firstOmniTurn.preRollBlocksCount).toBeGreaterThan(0)
      expect(firstOmniTurn.durationMs).toBeGreaterThan(800)

      // 3. PTT release in directOmniAudio mode seals with reason 'ptt-release'
      runtime.setMicMode('ptt')
      await runtime.setPushToTalkActive(true)
      const voicedBlock = synthesizeVoicedSpeechPcm({
        durationMs: 400,
        fundamentalHz: 185,
      })
      for (let i = 0; i < 20; i++) {
        const slice = voicedBlock.subarray(i * 320, (i + 1) * 320)
        await runtime.ingestPcmBlock({
          samples: slice,
          sampleRate: 16000,
          startFrame: i * 320,
          endFrame: (i + 1) * 320,
          durationMs: 20,
        })
      }
      const beforePttReleaseCount = sealedOmniTurns.length
      await runtime.setPushToTalkActive(false)
      expect(sealedOmniTurns.length).toBe(beforePttReleaseCount + 1)
      expect(sealedOmniTurns[sealedOmniTurns.length - 1]!.reason).toBe('ptt-release')
    })

    it('schedules native Omni audio deltas on GaplessAudioPlayer and computes exact heard/unheard PlaybackReceipt on barge-in (HIGH-3)', () => {
      const receipts: Array<{ heardText: string; unheardText: string; controlNote: string }> = []
      const runtime = createVoiceSessionRuntime({
        micMode: 'continuous',
        directOmniAudio: true,
        onBargeIn: ({ receipt }) => {
          if (receipt) {
            receipts.push(receipt)
          }
        },
      })

      const sr = 24000
      const halfSecPcm16 = new Uint8Array(sr * 1 * 2) // 1.0s of 24kHz PCM16
      const b64Chunk = uint8ArrayToBase64(halfSecPcm16)

      runtime.ingestOmniAudioDelta({
        turnId: 'turn-omni-1',
        seq: 0,
        audioBase64: b64Chunk,
        format: 'pcm16',
        sampleRate: 24000,
        durationMs: 1000,
        transcriptDelta: 'Primeira frase falada pela Ashy.',
      })
      runtime.ingestOmniAudioDelta({
        turnId: 'turn-omni-1',
        seq: 1,
        audioBase64: b64Chunk,
        format: 'pcm16',
        sampleRate: 24000,
        durationMs: 1000,
        transcriptDelta: 'Segunda frase que será cortada pelo usuário.',
      })

      // Advance virtual playback clock by 1000ms (first chunk heard, second chunk unheard)
      runtime.getPlayer().advanceVirtualClockSec(1.0)

      const receipt = runtime.interruptOmniPlayback('turn-omni-1')
      expect(receipt).not.toBeNull()
      expect(receipt!.heardText).toContain('Primeira frase falada pela Ashy.')
      expect(receipt!.unheardText).toContain('Segunda frase que será cortada pelo usuário.')
      expect(receipt!.controlNote).toContain('[User interrupted speech at')
      expect(receipts).toHaveLength(1)
    })
  })
})


