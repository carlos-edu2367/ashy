import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTROL_SENTINEL, type AshyStageSignal } from '@ashy/llm'
import {
  STT_PROVIDER_IDS,
  TTS_PROVIDER_IDS,
  VOICE_FIXTURE_IDS,
} from '@ashy/shared'
import {
  createAudioInputRingBuffer,
  createSpeechActivityTracker,
  createRealtimeSpeechPipeline,
  encodeWavPcm16,
  encodePcmBlocksToWav,
  decodeWavToPcmBlocks,
  synthesizeVoicedSpeechPcm,
  buildVoiceFixtureWavBytes,
  createHybridVadEngine,
  createDeterministicWavSttProvider,
  createOpenAiWhisperSttProvider,
  createLocalWhisperHttpSttProvider,
  createSttProviderRegistry,
  createLocalSynthFallbackTtsProvider,
  createElevenLabsTtsProvider,
  createOpenAiTtsProvider,
  createLocalKokoroHttpTtsProvider,
  createTtsProviderRegistry,
  createHybridVoiceEndJudge,
  createHybridSpeculativeRephrase,
  detectWakeWordInText,
  createWebAudioWorkletCapture,
  createGaplessAudioPlayer,
  createVoiceSessionRuntime,
  createWakeWordSpotterState,
  type TtsProviderSynthesisResult,
} from '../src/index'

const FIXTURES_DIR = resolve(__dirname, '../../../assets/audio-fixtures')

describe('@ashy/voice — Phase 5 Task 2: WAV Codec, Hybrid VadEngine & .wav Fixtures', () => {
  describe('1. RIFF/WAVE PCM16 Codec (wav-codec.ts)', () => {
    it('round-trips 16kHz Float32Array PCM into 20ms (320-sample) contiguous PcmAudioBlocks and preserves LIST/INFO ICMT metadataComment', () => {
      const sampleRate = 16000
      const speechSamples = synthesizeVoicedSpeechPcm({
        durationMs: 200,
        sampleRate,
        fundamentalHz: 180,
        amplitude: 0.5,
      })
      const comment = 'Teste de comentário em português: café & código!'

      const wavBytes = encodeWavPcm16(speechSamples, sampleRate, comment)
      expect(wavBytes).toBeInstanceOf(Uint8Array)
      expect(wavBytes.byteLength).toBeGreaterThan(44 + speechSamples.length * 2)

      const decoded = decodeWavToPcmBlocks(wavBytes, 20)
      expect(decoded.sampleRate).toBe(sampleRate)
      expect(decoded.totalDurationMs).toBe(200)
      expect(decoded.metadataComment).toBe(comment)
      expect(decoded.blocks).toHaveLength(10) // 200ms / 20ms = 10 blocks

      let expectedStartFrame = 0
      for (const block of decoded.blocks) {
        expect(block.startFrame).toBe(expectedStartFrame)
        expect(block.endFrame).toBe(expectedStartFrame + 320)
        expect(block.sampleRate).toBe(sampleRate)
        expect(block.durationMs).toBe(20)
        expect(block.samples).toBeInstanceOf(Float32Array)
        expect(block.samples).toHaveLength(320)
        expectedStartFrame = block.endFrame
      }

      // Check 16-bit quantization accuracy (< 1e-4 max error)
      for (let i = 0; i < speechSamples.length; i++) {
        const blockIdx = Math.floor(i / 320)
        const sampleIdx = i % 320
        expect(decoded.blocks[blockIdx]!.samples[sampleIdx]!).toBeCloseTo(speechSamples[i]!, 3)
      }
    })

    it('rejects malformed/truncated RIFF headers, non-WAVE formats, and non-positive sample rates with descriptive errors', () => {
      expect(() => encodeWavPcm16(new Float32Array(320), 0)).toThrow(/sampleRate/i)
      expect(() => encodeWavPcm16(new Float32Array(320), -16000)).toThrow(/sampleRate/i)
      expect(() => encodeWavPcm16(new Float32Array(320), Number.NaN)).toThrow(/sampleRate/i)

      // Truncated buffer (< 44 bytes)
      expect(() => decodeWavToPcmBlocks(new Uint8Array(16))).toThrow(/truncated|malformed|header/i)

      // Wrong magic bytes (not RIFF/WAVE)
      const bogus = new Uint8Array(64)
      bogus.set([0x4f, 0x67, 0x67, 0x53], 0) // "OggS"
      expect(() => decodeWavToPcmBlocks(bogus)).toThrow(/RIFF|WAVE/i)

      // Valid RIFF header claiming a larger payload than buffer length
      const validWav = encodeWavPcm16(new Float32Array(640), 16000)
      const truncatedWav = validWav.subarray(0, validWav.byteLength - 40)
      expect(() => decodeWavToPcmBlocks(truncatedWav)).toThrow(/truncated|exceeds/i)

      // Corrupt sampleRate = 0 inside fmt chunk (bytes 24..27)
      const zeroRateWav = new Uint8Array(validWav)
      zeroRateWav[24] = 0
      zeroRateWav[25] = 0
      zeroRateWav[26] = 0
      zeroRateWav[27] = 0
      expect(() => decodeWavToPcmBlocks(zeroRateWav)).toThrow(/sampleRate/i)
    })
  })

  describe('2. Deterministic Spectral + RMS + ZCR Hybrid VadEngine (vad-engine.ts)', () => {
    it('classifies voiced harmonic speech (>= 0.65), low-amplitude sustain speech ([0.20, 0.55]), and silence/DC offset (< 0.05)', async () => {
      const vad = createHybridVadEngine()

      // 1. Voiced harmonic speech (180Hz fundamental + formants)
      const voicedSamples = synthesizeVoicedSpeechPcm({
        durationMs: 20,
        sampleRate: 16000,
        fundamentalHz: 180,
        amplitude: 0.45,
      })
      const voicedAssessment = await vad.processBlock({
        startFrame: 0,
        endFrame: 320,
        sampleRate: 16000,
        durationMs: 20,
        samples: voicedSamples,
      })
      expect(voicedAssessment.probability).toBeGreaterThanOrEqual(0.65)
      expect(voicedAssessment.isSpeechCandidate).toBe(true)
      expect(voicedAssessment.rmsEnergy).toBeGreaterThan(0.1)
      expect(voicedAssessment.zeroCrossingRate).toBeGreaterThan(0.008)
      expect(voicedAssessment.bandEnergyRatio).toBeGreaterThan(0.6)

      // 2. Low-amplitude sustain speech
      const sustainSamples = synthesizeVoicedSpeechPcm({
        durationMs: 20,
        sampleRate: 16000,
        fundamentalHz: 180,
        amplitude: 0.045,
        variant: 'sustain',
      })
      const sustainAssessment = await vad.processBlock({
        startFrame: 320,
        endFrame: 640,
        sampleRate: 16000,
        durationMs: 20,
        samples: sustainSamples,
      })
      expect(sustainAssessment.probability).toBeGreaterThanOrEqual(0.2)
      expect(sustainAssessment.probability).toBeLessThanOrEqual(0.55)

      // 3. Pure silence
      const silenceAssessment = await vad.processBlock({
        startFrame: 640,
        endFrame: 960,
        sampleRate: 16000,
        durationMs: 20,
        samples: new Float32Array(320),
      })
      expect(silenceAssessment.probability).toBeLessThan(0.05)
      expect(silenceAssessment.isSpeechCandidate).toBe(false)

      // 4. Pure DC offset (0.5 constant) — must NOT be mistaken for speech!
      const dcAssessment = await vad.processBlock({
        startFrame: 960,
        endFrame: 1280,
        sampleRate: 16000,
        durationMs: 20,
        samples: new Float32Array(320).fill(0.5),
      })
      expect(dcAssessment.probability).toBeLessThan(0.05)
      expect(dcAssessment.isSpeechCandidate).toBe(false)
    })

    it('uses/blends custom modelInferFn when provided and safely falls back to spectral/energy/ZCR when modelInferFn throws or returns NaN', async () => {
      const silentBlock = {
        startFrame: 0,
        endFrame: 320,
        sampleRate: 16000,
        durationMs: 20,
        samples: new Float32Array(320),
      }
      const voicedBlock = {
        startFrame: 0,
        endFrame: 320,
        sampleRate: 16000,
        durationMs: 20,
        samples: synthesizeVoicedSpeechPcm({ durationMs: 20, sampleRate: 16000 }),
      }

      // Override with custom modelInferFn returning 0.91 on silent block
      const customVad = createHybridVadEngine({
        modelInferFn: async () => 0.91,
      })
      const customRes = await customVad.processBlock(silentBlock)
      expect(customRes.probability).toBeGreaterThanOrEqual(0.75)
      expect(customRes.isSpeechCandidate).toBe(true)

      // Throwing modelInferFn falls back cleanly to deterministic VAD
      const throwingVad = createHybridVadEngine({
        modelInferFn: async () => {
          throw new Error('ONNX runtime session failed')
        },
      })
      const fallbackVoiced = await throwingVad.processBlock(voicedBlock)
      expect(fallbackVoiced.probability).toBeGreaterThanOrEqual(0.65)
      expect(fallbackVoiced.isSpeechCandidate).toBe(true)

      // NaN-returning modelInferFn falls back cleanly to deterministic VAD
      const nanVad = createHybridVadEngine({
        modelInferFn: () => Number.NaN,
      })
      const nanFallback = await nanVad.processBlock(voicedBlock)
      expect(nanFallback.probability).toBeGreaterThanOrEqual(0.65)
      expect(nanFallback.isSpeechCandidate).toBe(true)
    })
  })

  describe('3. Real .wav Fixtures on Disk (assets/audio-fixtures/*.wav) & buildVoiceFixtureWavBytes', () => {
    it('verifies all 4 .wav files exist on disk and match buildVoiceFixtureWavBytes byte-for-byte', () => {
      for (const fixtureId of VOICE_FIXTURE_IDS) {
        const filePath = resolve(FIXTURES_DIR, `${fixtureId}.wav`)
        expect(existsSync(filePath)).toBe(true)

        const diskBytes = new Uint8Array(readFileSync(filePath))
        const builtBytes = buildVoiceFixtureWavBytes(fixtureId)
        expect(diskBytes.byteLength).toBe(builtBytes.byteLength)
        expect(Buffer.from(diskBytes).equals(Buffer.from(builtBytes))).toBe(true)
      }
    })

    it('verifies thinking-pause-cas.wav (4.2s): 0..800ms speech, 800..2100ms pause (1300ms), 2100..2900ms speech, 2900..4200ms silence', async () => {
      const wavBytes = new Uint8Array(
        readFileSync(resolve(FIXTURES_DIR, 'thinking-pause-cas.wav')),
      )
      const decoded = decodeWavToPcmBlocks(wavBytes, 20)
      const vad = createHybridVadEngine()

      expect(decoded.sampleRate).toBe(16000)
      expect(decoded.totalDurationMs).toBe(4200)
      expect(decoded.blocks).toHaveLength(210)
      expect(decoded.metadataComment).toBe(
        'Deixa eu pensar num jeito de... | resolver esse bug no código.',
      )

      for (const block of decoded.blocks) {
        const startMs = (block.startFrame / decoded.sampleRate) * 1000
        const assessment = await vad.processBlock(block)

        if (startMs < 800) {
          expect(assessment.probability).toBeGreaterThanOrEqual(0.65)
        } else if (startMs >= 800 && startMs < 2100) {
          expect(assessment.probability).toBeLessThan(0.05)
        } else if (startMs >= 2100 && startMs < 2900) {
          expect(assessment.probability).toBeGreaterThanOrEqual(0.65)
        } else {
          expect(assessment.probability).toBeLessThan(0.05)
        }
      }
    })

    it('verifies barge-in-interrupt.wav (2.2s): 0..400ms leading silence (anchorFrame = 640 > 0), 400..900ms speech, 900..2200ms silence', async () => {
      const wavBytes = new Uint8Array(
        readFileSync(resolve(FIXTURES_DIR, 'barge-in-interrupt.wav')),
      )
      const decoded = decodeWavToPcmBlocks(wavBytes, 20)
      const vad = createHybridVadEngine()
      const ring = createAudioInputRingBuffer({ baseHistoryMs: 400 })

      expect(decoded.sampleRate).toBe(16000)
      expect(decoded.totalDurationMs).toBe(2200)
      expect(decoded.blocks).toHaveLength(110)
      expect(decoded.metadataComment).toBe('Espera um segundo, Ashy!')

      let onsetLeaseAnchorFrame: number | null = null
      for (const block of decoded.blocks) {
        const startMs = (block.startFrame / decoded.sampleRate) * 1000
        const assessment = await vad.processBlock(block)

        if (startMs < 400) {
          ring.push(block)
          expect(assessment.probability).toBeLessThan(0.05)
        } else if (startMs >= 400 && startMs < 900) {
          if (onsetLeaseAnchorFrame === null) {
            // Retain 360ms pre-roll right at speech onset (400ms = frame 6400 -> anchorFrame = 640)
            const lease = ring.retain(360)
            onsetLeaseAnchorFrame = lease.anchorFrame
          }
          ring.push(block)
          expect(assessment.probability).toBeGreaterThanOrEqual(0.65)
        } else {
          ring.push(block)
          expect(assessment.probability).toBeLessThan(0.05)
        }
      }

      expect(onsetLeaseAnchorFrame).toBe(640)
    })

    it('verifies wake-word-oi-ashy.wav (2.2s) and keyboard-click-noise.wav (0.5s, 120ms < 300ms cancelled as too-short)', async () => {
      const wakeBytes = new Uint8Array(
        readFileSync(resolve(FIXTURES_DIR, 'wake-word-oi-ashy.wav')),
      )
      const wakeDecoded = decodeWavToPcmBlocks(wakeBytes, 20)
      const vad = createHybridVadEngine()

      expect(wakeDecoded.totalDurationMs).toBe(2200)
      expect(wakeDecoded.metadataComment).toBe('Ei Ashy, olha esse log')

      for (const block of wakeDecoded.blocks) {
        const startMs = (block.startFrame / wakeDecoded.sampleRate) * 1000
        const assessment = await vad.processBlock(block)
        if (startMs < 200 || startMs >= 900) {
          expect(assessment.probability).toBeLessThan(0.05)
        } else {
          expect(assessment.probability).toBeGreaterThanOrEqual(0.65)
        }
      }

      const clickBytes = new Uint8Array(
        readFileSync(resolve(FIXTURES_DIR, 'keyboard-click-noise.wav')),
      )
      const clickDecoded = decodeWavToPcmBlocks(clickBytes, 20)
      const tracker = createSpeechActivityTracker({
        onsetThreshold: 0.6,
        sustainRatio: 0.3,
        minSpeechMs: 300,
      })

      expect(clickDecoded.totalDurationMs).toBe(500)
      expect(clickDecoded.metadataComment).toBe('[keyboard-click]')

      const actions: Array<{ action: string; reason?: string }> = []
      for (const block of clickDecoded.blocks) {
        const assessment = await vad.processBlock(block)
        const step = tracker.processFrame(assessment.probability, block.durationMs)
        actions.push({ action: step.action, reason: step.reason })
      }

      // Must have cancelled the 120ms burst as 'too-short' (< 300ms)
      expect(actions.some((a) => a.action === 'cancel' && a.reason === 'too-short')).toBe(true)
    })
  })
})

describe('@ashy/voice — Phase 5 Task 3: Incremental SpeechPipeline & Dual STT/TTS Providers', () => {
  describe('1. Incremental RealtimeSpeechPipeline (enqueueDelta, flush & Red-Team B1 barge-in tail)', () => {
    it('coalesces 1-2 word token deltas through TtsChunker TTFA boost window and drains unscheduled buffered words on mid-sentence interrupt()', async () => {
      const synthesizedChunks: string[] = []
      const pipeline = createRealtimeSpeechPipeline({
        synthesizeFn: async (text) => {
          synthesizedChunks.push(text)
          return { durationMs: 800 }
        },
      })

      // Stream 1-2 word token deltas:
      // Boost window requires >= 4 words + soft punctuation (or 12 words max) before emitting chunk #0
      pipeline.enqueueDelta('Eu ')
      pipeline.enqueueDelta('acho ')
      pipeline.enqueueDelta('que ')
      // Only 3 words so far without punctuation -> must NOT have emitted a tiny 1-word chunk!
      expect(synthesizedChunks).toHaveLength(0)

      // 4th word with comma + next delta lookahead triggers boost chunk #0 ("Eu acho que esse,")
      // while keeping the new delta ("código ") and subsequent deltas buffered in TtsChunker!
      pipeline.enqueueDelta('esse, ')
      pipeline.enqueueDelta('código ')
      expect(synthesizedChunks).toEqual(['Eu acho que esse,'])

      // Wait for chunk #0 synthesis to complete and schedule (0.0s .. 0.8s)
      await new Promise((r) => setTimeout(r, 15))
      expect(pipeline.getScheduledChunks()).toHaveLength(1)

      // Stream more words that stay buffered inside TtsChunker (no punctuation yet, < 12 words)
      pipeline.enqueueDelta('precisa ')
      pipeline.enqueueDelta('de ')
      pipeline.enqueueDelta('uma ')
      pipeline.enqueueDelta('refatoração ')
      pipeline.enqueueDelta('limpa')
      // Still buffered inside chunker because flush() has NOT been called yet
      expect(synthesizedChunks).toEqual(['Eu acho que esse,'])

      // Mid-sentence Barge-In BEFORE flush() is called!
      // At 0.8s, chunk #0 ("Eu acho que esse,") was 100% heard, while the 6 buffered words inside TtsChunker were unheard.
      const receipt = pipeline.interrupt('user-barge-in', 0.8)

      expect(receipt.throughMs).toBe(800)
      expect(receipt.heardText).toBe('Eu acho que esse,')
      expect(receipt.unheardText).toBe('código precisa de uma refatoração limpa')
      expect(receipt.controlNote).toBe(
        '[Interrupted after 800ms — user heard: "Eu acho que esse," | unheard: "código precisa de uma refatoração limpa"]',
      )
    })

    it('flushes preceding buffered text in chunker when enqueue(CONTROL_SENTINEL, [signal], { flush: false }) is called so afterChunkSeq attaches to the exact preceding clause', async () => {
      const events: string[] = []
      const pipeline = createRealtimeSpeechPipeline({
        synthesizeFn: async (text) => {
          events.push(`synth:${text}`)
          return { durationMs: 500 }
        },
        onAudioScheduled: (chunk) => {
          events.push(`sched:${chunk.seq}:${chunk.text}`)
        },
        onStageSignal: (signal, afterChunkSeq) => {
          events.push(
            `sig:${signal.type}:${signal.type === 'act' ? signal.emotion : ''}:after=${afterChunkSeq}`,
          )
        },
      })

      // Stream words without punctuation (remains buffered in chunker)
      pipeline.enqueueDelta('Olha ')
      pipeline.enqueueDelta('só ')
      pipeline.enqueueDelta('isso ')
      pipeline.enqueueDelta('aqui')
      expect(events).toHaveLength(0)

      const actSignal: AshyStageSignal = {
        type: 'act',
        emotion: 'tease',
        intensity: 0.85,
        raw: '<|ACT {"emotion":"tease","intensity":0.85}|>',
      }

      // Enqueue a stage sentinel mid-stream with { flush: false }:
      // Must flush "Olha só isso aqui" as chunk #0 BEFORE attaching actSignal (so afterChunkSeq === 0)
      pipeline.enqueue(CONTROL_SENTINEL, [actSignal], { flush: false })

      expect(events).toContain('synth:Olha só isso aqui')

      // Stream trailing clause and flush at end of turn
      pipeline.enqueueDelta(' ficou ')
      pipeline.enqueueDelta('muito ')
      pipeline.enqueueDelta('bom')
      pipeline.flush()

      await new Promise((r) => setTimeout(r, 20))

      expect(pipeline.getScheduledChunks().map((c) => c.text)).toEqual([
        'Olha só isso aqui',
        'ficou muito bom',
      ])

      // Signal must not fire at 0.2s (while chunk #0 is still playing)
      pipeline.advancePlaybackTo(0.2)
      expect(events).not.toContain('sig:act:tease:after=0')

      // Signal fires at 0.5s (right after chunk #0 finishes) with afterChunkSeq = 0
      pipeline.advancePlaybackTo(0.5)
      expect(events).toContain('sig:act:tease:after=0')
    })
  })

  describe('2. Dual Local & Cloud STT Providers (providers.ts)', () => {
    it('createOpenAiWhisperSttProvider encodes PcmAudioBlock[] to WAV, posts to /audio/transcriptions with AbortSignal, and falls back to deterministic-wav-stt when allowOfflineFallback is true', async () => {
      const fixtureBytes = buildVoiceFixtureWavBytes('barge-in-interrupt')
      const decoded = decodeWavToPcmBlocks(fixtureBytes, 20)

      let capturedUrl = ''
      let capturedMethod = ''
      let capturedAuth = ''
      let capturedSignal: AbortSignal | null | undefined = null

      const whisperProvider = createOpenAiWhisperSttProvider({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-whisper',
        modelId: 'whisper-1',
        fetchImpl: async (input, init) => {
          capturedUrl = String(input)
          capturedMethod = init?.method ?? ''
          const headers = init?.headers as Record<string, string> | undefined
          capturedAuth = headers?.Authorization ?? headers?.authorization ?? ''
          capturedSignal = init?.signal
          return new Response(
            JSON.stringify({ text: 'Espera um segundo, Ashy!' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        },
      })

      const controller = new AbortController()
      const res = await whisperProvider.transcribe({
        blocks: decoded.blocks,
        language: 'pt',
        signal: controller.signal,
      })

      expect(capturedUrl).toBe('https://api.openai.com/v1/audio/transcriptions')
      expect(capturedMethod).toBe('POST')
      expect(capturedAuth).toBe('Bearer sk-test-whisper')
      expect(capturedSignal).toBeDefined()
      expect(res.providerId).toBe('openai-whisper')
      expect(res.text).toBe('Espera um segundo, Ashy!')
      expect(res.latencyMs).toBeGreaterThanOrEqual(0)
      expect(res.confidence).toBeGreaterThan(0.8)

      // Offline fallback when HTTP fails and allowOfflineFallback: true
      const failingWhisperWithFallback = createOpenAiWhisperSttProvider({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        allowOfflineFallback: true,
        fetchImpl: async () => {
          throw new Error('Network unreachable')
        },
      })

      const fallbackRes = await failingWhisperWithFallback.transcribe({
        blocks: decoded.blocks,
      })
      expect(fallbackRes.providerId).toBe('deterministic-wav-stt')
      expect(fallbackRes.text).toBe('Espera um segundo, Ashy!')
    })

    it('createLocalWhisperHttpSttProvider posts to local HTTP endpoint and falls back to deterministic-wav-stt when offline', async () => {
      const fixtureBytes = buildVoiceFixtureWavBytes('wake-word-oi-ashy')
      const decoded = decodeWavToPcmBlocks(fixtureBytes, 20)

      let calledUrl = ''
      const localWhisper = createLocalWhisperHttpSttProvider({
        baseUrl: 'http://127.0.0.1:8080',
        modelId: 'whisper-small-pt',
        fetchImpl: async (input) => {
          calledUrl = String(input)
          return new Response(
            JSON.stringify({ text: 'Ei Ashy, olha esse log' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        },
      })

      const okResult = await localWhisper.transcribe({ blocks: decoded.blocks })
      expect(calledUrl).toBe('http://127.0.0.1:8080/audio/transcriptions')
      expect(okResult.providerId).toBe('local-whisper-http')
      expect(okResult.text).toBe('Ei Ashy, olha esse log')

      const offlineLocalWhisper = createLocalWhisperHttpSttProvider({
        baseUrl: 'http://127.0.0.1:8080',
        allowOfflineFallback: true,
        fetchImpl: async () => new Response('Bad Gateway', { status: 502 }),
      })

      const fallbackResult = await offlineLocalWhisper.transcribe({
        blocks: decoded.blocks,
      })
      expect(fallbackResult.providerId).toBe('deterministic-wav-stt')
      expect(fallbackResult.text).toBe('Ei Ashy, olha esse log')
    })

    it('createDeterministicWavSttProvider and createSttProviderRegistry support all 3 STT_PROVIDER_IDS', async () => {
      const detStt = createDeterministicWavSttProvider()
      const thinkingDecoded = decodeWavToPcmBlocks(
        buildVoiceFixtureWavBytes('thinking-pause-cas'),
        20,
      )

      // First clause blocks (0..800ms = blocks 0..40)
      const firstClauseRes = await detStt.transcribe({
        blocks: thinkingDecoded.blocks.slice(0, 45),
      })
      expect(firstClauseRes.providerId).toBe('deterministic-wav-stt')
      expect(firstClauseRes.text).toContain('Deixa eu pensar num jeito de...')

      // Second clause blocks (2100..2900ms = blocks 105..145)
      const secondClauseRes = await detStt.transcribe({
        blocks: thinkingDecoded.blocks.slice(100, 150),
      })
      expect(secondClauseRes.text).toContain('resolver esse bug no código.')

      const registry = createSttProviderRegistry()
      expect(registry.listIds()).toEqual(STT_PROVIDER_IDS)
      for (const id of STT_PROVIDER_IDS) {
        expect(registry.get(id).id).toBe(id)
      }
      const regRes = await registry.transcribe('deterministic-wav-stt', {
        blocks: thinkingDecoded.blocks,
        metadataComment: 'Transcrição determinística de teste.',
      })
      expect(regRes.text).toBe('Transcrição determinística de teste.')
    })
  })

  describe('3. Dual Local & Cloud TTS Providers & Unified TtsProviderSynthesisResult (providers.ts — Red-Team B3 fix)', () => {
    it('createLocalSynthFallbackTtsProvider generates 16kHz harmonic Float32Array PCM and vowel lip-sync envelopes (A, E, I, O, U) proportional to Portuguese vowels', async () => {
      const localSynth = createLocalSynthFallbackTtsProvider()

      // 5 words -> Math.max(400, 5 * 140) = 700ms
      const resA: TtsProviderSynthesisResult = await localSynth.synthesize({
        text: 'Fala clara da madrugada calma',
      })
      expect(resA.providerId).toBe('local-synth-fallback')
      expect(resA.sampleRate).toBe(16000)
      expect(resA.durationMs).toBe(700)
      expect(resA.durationSec).toBeCloseTo(0.7, 3)
      expect(resA.samples).toBeInstanceOf(Float32Array)
      expect(resA.samples.length).toBe(Math.round(0.7 * 16000))
      expect(resA.vowelFrames.length).toBeGreaterThan(0)
      expect(resA.synthesisLatencyMs).toBeGreaterThanOrEqual(0)

      const sumVowels = (frames: TtsProviderSynthesisResult['vowelFrames']) =>
        frames.reduce(
          (acc, f) => ({
            A: acc.A + f.A,
            E: acc.E + f.E,
            I: acc.I + f.I,
            O: acc.O + f.O,
            U: acc.U + f.U,
          }),
          { A: 0, E: 0, I: 0, O: 0, U: 0 },
        )

      const totalsA = sumVowels(resA.vowelFrames)
      // "Fala clara da madrugada calma" is overwhelmingly 'A' (11 A's vs 1 U and 0 E/I/O)
      expect(totalsA.A).toBeGreaterThan(totalsA.U)
      expect(totalsA.A).toBeGreaterThan(totalsA.E)

      const resO = await localSynth.synthesize({
        text: 'O foco do bloco todo no topo',
      })
      const totalsO = sumVowels(resO.vowelFrames)
      expect(totalsO.O).toBeGreaterThan(totalsO.A)
      expect(totalsO.O).toBeGreaterThan(totalsO.I)
    })

    it('createElevenLabsTtsProvider, createOpenAiTtsProvider, and createLocalKokoroHttpTtsProvider decode WAV responses and fall back to local-synth-fallback when offline', async () => {
      const sampleWav = encodeWavPcm16(
        synthesizeVoicedSpeechPcm({ durationMs: 480, sampleRate: 16000 }),
        16000,
      )

      const calledUrls: string[] = []
      const mockWavFetch: typeof fetch = async (input) => {
        calledUrls.push(String(input))
        return new Response(sampleWav.buffer as ArrayBuffer, {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        })
      }

      const eleven = createElevenLabsTtsProvider({
        baseUrl: 'https://api.elevenlabs.io/v1',
        apiKey: 'xi-test-key',
        voiceId: 'ashy-voice-1',
        fetchImpl: mockWavFetch,
      })
      const elevenRes = await eleven.synthesize({ text: 'Olá estúdio noturno!' })
      expect(calledUrls[0]).toBe('https://api.elevenlabs.io/v1/text-to-speech/ashy-voice-1')
      expect(elevenRes.providerId).toBe('elevenlabs')
      expect(elevenRes.durationMs).toBe(480)
      expect(elevenRes.samples.length).toBe(Math.round(0.48 * 16000))
      expect(elevenRes.vowelFrames.length).toBeGreaterThan(0)

      const openaiTts = createOpenAiTtsProvider({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-tts',
        fetchImpl: mockWavFetch,
      })
      const openaiRes = await openaiTts.synthesize({ text: 'Testando voz da OpenAI.' })
      expect(calledUrls[1]).toBe('https://api.openai.com/v1/audio/speech')
      expect(openaiRes.providerId).toBe('openai-tts')
      expect(openaiRes.durationMs).toBe(480)

      const kokoroTts = createLocalKokoroHttpTtsProvider({
        baseUrl: 'http://127.0.0.1:8880/v1',
        fetchImpl: mockWavFetch,
      })
      const kokoroRes = await kokoroTts.synthesize({ text: 'Testando Kokoro local.' })
      expect(calledUrls[2]).toBe('http://127.0.0.1:8880/v1/audio/speech')
      expect(kokoroRes.providerId).toBe('local-kokoro-http')
      expect(kokoroRes.durationMs).toBe(480)

      // Verify offline fallback to local-synth-fallback when HTTP fails and allowOfflineFallback: true
      const offlineEleven = createElevenLabsTtsProvider({
        baseUrl: 'https://api.elevenlabs.io/v1',
        voiceId: 'ashy-voice-1',
        allowOfflineFallback: true,
        fetchImpl: async () => {
          throw new Error('Connection refused')
        },
      })
      const fallbackRes = await offlineEleven.synthesize({
        text: 'Fallback offline funcionando perfeitamente agora.',
      })
      expect(fallbackRes.providerId).toBe('local-synth-fallback')
      expect(fallbackRes.samples.length).toBeGreaterThan(0)
      expect(fallbackRes.vowelFrames.length).toBeGreaterThan(0)

      // Registry check
      const registry = createTtsProviderRegistry()
      expect(registry.listIds()).toEqual(TTS_PROVIDER_IDS)
      for (const id of TTS_PROVIDER_IDS) {
        expect(registry.get(id).id).toBe(id)
      }
      const regSynth = await registry.synthesize('local-synth-fallback', {
        text: 'Síntese pelo registro de provedores.',
      })
      expect(regSynth.providerId).toBe('local-synth-fallback')
      expect(regSynth.durationMs).toBe(Math.max(400, 5 * 140))
    })
  })
})

describe('@ashy/voice — Phase 5 Task 4: Hybrid Turn-Taking, WebAudio I/O & VoiceSessionRuntime', () => {
  describe('1. Hybrid Turn-Taking Intelligence (turn-intelligence.ts)', () => {
    it('createHybridVoiceEndJudge classifies trailing PT-BR/EN hesitations (< 1ms) as incomplete and terminal sentences as complete without calling LLM', async () => {
      let llmCallCount = 0
      const judge = createHybridVoiceEndJudge({
        llmJudgeFn: async () => {
          llmCallCount += 1
          return { complete: true, reason: 'llm-judge' }
        },
      })

      const hesitations = [
        'Deixa eu pensar num jeito de...',
        'Eu queria falar sobre, tipo...',
        'Mas então...',
        'É que eu estava olhando para',
      ]

      for (const phrase of hesitations) {
        const t0 = performance.now()
        const decision = await judge(phrase)
        const elapsedMs = performance.now() - t0
        expect(decision).toEqual({
          complete: false,
          reason: 'trailing-hesitation',
        })
        expect(elapsedMs).toBeLessThan(5)
      }
      expect(llmCallCount).toBe(0)

      const completeSentences = [
        'Como está o banco de dados?',
        'Pode rodar a suíte de testes agora.',
        'Tudo funcionando perfeitamente!',
      ]

      for (const sentence of completeSentences) {
        const decision = await judge(sentence)
        expect(decision).toEqual({
          complete: true,
          reason: 'terminal-punctuation',
        })
      }
      expect(llmCallCount).toBe(0)
    })

    it('createHybridVoiceEndJudge invokes llmJudgeFn on ambiguous unpunctuated clauses with a 400ms timeout and falls back safely on timeout, abort, or error', async () => {
      // 1. Fast LLM resolving within 400ms
      const fastJudge = createHybridVoiceEndJudge({
        timeoutMs: 400,
        llmJudgeFn: async (text) => ({
          complete: text.includes('pronto'),
          reason: 'llm-semantic-check',
        }),
      })

      const res1 = await fastJudge('Acho que o deploy já está pronto')
      expect(res1).toEqual({
        complete: true,
        reason: 'llm-semantic-check',
      })

      // 2. Slow LLM exceeding 400ms timeout -> falls back to heuristic within ~420ms
      let slowSignalAborted = false
      const slowJudge = createHybridVoiceEndJudge({
        timeoutMs: 80, // test timeout enforcement
        llmJudgeFn: async (_text, signal) => {
          signal.addEventListener('abort', () => {
            slowSignalAborted = true
          })
          await new Promise((r) => setTimeout(r, 300))
          return { complete: false, reason: 'too-late' }
        },
      })

      const fallbackTimeoutRes = await slowJudge('Verifica os logs do servidor agora')
      expect(slowSignalAborted).toBe(true)
      expect(fallbackTimeoutRes.complete).toBe(true)
      expect(fallbackTimeoutRes.reason).toMatch(/heuristic/i)

      // 3. Throwing LLM -> falls back to heuristic cleanly
      const throwingJudge = createHybridVoiceEndJudge({
        llmJudgeFn: async () => {
          throw new Error('LLM judge network error')
        },
      })
      const fallbackErrorRes = await throwingJudge('Verifica os logs do servidor agora')
      expect(fallbackErrorRes.complete).toBe(true)
      expect(fallbackErrorRes.reason).toMatch(/heuristic/i)
    })

    it('createHybridSpeculativeRephrase strips spoken filler words and stutters and respects AbortSignal', async () => {
      const rephrase = createHybridSpeculativeRephrase()

      const cleaned = await rephrase(
        'hum, é... é... eu acho que, tipo, funciona',
        new AbortController().signal,
      )
      expect(cleaned).toBe('eu acho que funciona')

      const cleanedSimple = await rephrase(
        'hum, é... é... eu acho que funciona',
        new AbortController().signal,
      )
      expect(cleanedSimple).toBe('eu acho que funciona')

      const combinedClause = await rephrase(
        'Deixa eu pensar num jeito de... resolver esse bug no código.',
        new AbortController().signal,
      )
      expect(combinedClause).toBe('Deixa eu pensar num jeito de resolver esse bug no código.')

      // Optional llmRephraseFn called when not aborted, skipped when aborted
      let llmCalled = 0
      const customRephrase = createHybridSpeculativeRephrase({
        llmRephraseFn: async (text, signal) => {
          llmCalled += 1
          if (signal.aborted) throw new Error('aborted')
          return `${text} [refined]`
        },
      })

      const activeController = new AbortController()
      const refined = await customRephrase(
        'hum, é... eu acho que funciona',
        activeController.signal,
      )
      expect(refined).toBe('eu acho que funciona [refined]')
      expect(llmCalled).toBe(1)

      const abortedController = new AbortController()
      abortedController.abort('cancelled')
      const abortedResult = await customRephrase(
        'hum, é... eu acho que funciona',
        abortedController.signal,
      )
      expect(abortedResult).toBe('eu acho que funciona')
      expect(llmCalled).toBe(1) // did not invoke LLM when already aborted
    })

    it('detectWakeWordInText detects "ashy", "ei ashy", "oi ashy", and "hey ashy" case-insensitively and extracts remainingText', () => {
      expect(detectWakeWordInText('Ei Ashy, olha esse log')).toEqual({
        detected: true,
        matchedPhrase: 'ei ashy',
        remainingText: 'olha esse log',
      })

      expect(detectWakeWordInText('OI ASHY! Tudo bem por aí?')).toEqual({
        detected: true,
        matchedPhrase: 'oi ashy',
        remainingText: 'Tudo bem por aí?',
      })

      expect(detectWakeWordInText('hey ashy roda os testes')).toEqual({
        detected: true,
        matchedPhrase: 'hey ashy',
        remainingText: 'roda os testes',
      })

      expect(detectWakeWordInText('Deixa eu pensar num jeito de...')).toEqual({
        detected: false,
        matchedPhrase: null,
        remainingText: 'Deixa eu pensar num jeito de...',
      })
    })
  })

  describe('2. WebAudio Worklet Capture & Gapless Audio Player (voice-session-runtime.ts — Red-Team M3 fix)', () => {
    it('createWebAudioWorkletCapture feeds 20ms PcmAudioBlock frames into aecRingBuffer, rawRingBuffer, and wakeWordSpotter', () => {
      const aecRingBuffer = createAudioInputRingBuffer({ baseHistoryMs: 400 })
      const rawRingBuffer = createAudioInputRingBuffer({ baseHistoryMs: 400 })
      const wakeDetections: string[] = []
      const wakeWordSpotter = createWakeWordSpotterState({
        decodeBlock: (block) => (block.startFrame >= 320 ? { keyword: 'ei ashy', confidence: 0.96 } : null),
        onWakeWord: (d) => wakeDetections.push(d.keyword),
      })

      const capture = createWebAudioWorkletCapture({
        aecRingBuffer,
        rawRingBuffer,
        wakeWordSpotter,
        sampleRate: 16000,
        frameDurationMs: 20,
      })

      const frame0 = synthesizeVoicedSpeechPcm({ durationMs: 20, sampleRate: 16000 })
      const frame1 = synthesizeVoicedSpeechPcm({ durationMs: 20, sampleRate: 16000 })

      const aecBlock0 = capture.pushAecFrame(frame0)
      const rawBlock0 = capture.pushRawFrame(frame0)
      expect(aecBlock0.startFrame).toBe(0)
      expect(aecBlock0.endFrame).toBe(320)
      expect(rawBlock0.startFrame).toBe(0)
      expect(rawBlock0.endFrame).toBe(320)

      const dual = capture.pushDualFrame(frame1, frame1)
      expect(dual.aecBlock.startFrame).toBe(320)
      expect(dual.aecBlock.endFrame).toBe(640)
      expect(dual.rawBlock.startFrame).toBe(320)
      expect(dual.rawBlock.endFrame).toBe(640)

      expect(aecRingBuffer.getBlocks()).toHaveLength(2)
      expect(rawRingBuffer.getBlocks()).toHaveLength(2)
      expect(wakeWordSpotter.getState().backlogBlocks).toBe(2)
      expect(wakeDetections).toEqual(['ei ashy'])
      expect(capture.getState().aecFramesPushed).toBe(2)
      expect(capture.getState().rawFramesPushed).toBe(2)
    })

    it('createGaplessAudioPlayer schedules PCM chunks onto WebAudio / virtual clock, emits vowel lip-sync frames, and executes 100ms gain fade-out', async () => {
      const localSynth = createLocalSynthFallbackTtsProvider()
      const synthOut = await localSynth.synthesize({
        text: 'Fala clara da madrugada calma',
      })

      const gainRampCalls: Array<{ value: number; endTime: number }> = []
      const mockAudioContext = {
        currentTime: 0,
        sampleRate: 16000,
        destination: {},
        createGain: () => ({
          gain: {
            value: 1,
            setValueAtTime: () => {},
            linearRampToValueAtTime: (value: number, endTime: number) => {
              gainRampCalls.push({ value, endTime })
            },
          },
          connect: () => {},
        }),
        createBuffer: (_channels: number, length: number, sampleRate: number) => ({
          duration: length / sampleRate,
          getChannelData: () => new Float32Array(length),
        }),
        createBufferSource: () => ({
          buffer: null as unknown,
          connect: () => {},
          start: () => {},
          stop: () => {},
        }),
      }

      const emittedVowels: Array<{ A: number; E: number; I: number; O: number; U: number }> = []
      const player = createGaplessAudioPlayer({
        audioContext: mockAudioContext,
        onVowelFrame: (v) => emittedVowels.push(v),
      })

      const item = player.scheduleChunk({
        seq: 0,
        text: 'Fala clara da madrugada calma',
        durationMs: synthOut.durationMs,
        durationSec: synthOut.durationSec,
        startTimeSec: 0,
        endTimeSec: synthOut.durationSec,
        synthesisOutput: synthOut,
      })

      expect(item.durationSec).toBeCloseTo(0.7, 2)
      expect(player.isPlaying()).toBe(true)

      player.advanceVirtualClockSec(0.25)
      expect(player.getCurrentTimeSec()).toBeCloseTo(0.25, 3)

      const activeVowel = player.getActiveVowelFrame()
      expect(activeVowel.A).toBeGreaterThan(0)
      expect(emittedVowels.length).toBeGreaterThan(0)

      const fadeResult = player.stopWithFade(100)
      expect(fadeResult.fadeMs).toBe(100)
      expect(fadeResult.gainValueAfterFade).toBe(0)
      expect(player.getGainValue()).toBe(0)
      expect(player.isPlaying()).toBe(false)
      expect(gainRampCalls).toHaveLength(1)
      expect(gainRampCalls[0]!.value).toBe(0)
      expect(gainRampCalls[0]!.endTime).toBeCloseTo(0.25 + 0.1, 3)
    })
  })

  describe('3. VoiceSessionRuntime End-to-End with Real .wav Fixtures (Scenarios A–E)', () => {
    it('Scenario A (thinking-pause-cas.wav): enters +3000ms grace period on 1300ms hesitation pause, exercises CAS protection on resumed speech, and seals combined utterance', async () => {
      const wavBytes = new Uint8Array(
        readFileSync(resolve(FIXTURES_DIR, 'thinking-pause-cas.wav')),
      )
      const decoded = decodeWavToPcmBlocks(wavBytes, 20)
      const runtime = createVoiceSessionRuntime({
        micMode: 'continuous',
        wakeWordEnabled: false,
      })

      // 1. Stream first half (0..2100ms = 800ms speech "Deixa eu pensar num jeito de..." + 1300ms pause)
      await runtime.ingestPcmBlocks(decoded.blocks.slice(0, 105))

      const midState = runtime.getState()
      expect(midState.turnState.rawText).toBe('Deixa eu pensar num jeito de...')
      expect(midState.turnState.inGracePeriod).toBe(true)
      expect(midState.turnState.status).toBe('grace')
      expect(midState.lastEndJudgeDecision).toEqual({
        complete: false,
        reason: 'trailing-hesitation',
      })
      // Must NOT have sealed prematurely during the thinking pause!
      expect(midState.sealedTurns).toHaveLength(0)

      // 2. Stream second half (2100..4200ms = 800ms speech "...resolver esse bug no código." + 1300ms silence)
      await runtime.ingestPcmBlocks(decoded.blocks.slice(105))

      const finalState = runtime.getState()
      expect(finalState.enteredGracePeriodCount).toBeGreaterThanOrEqual(1)
      expect(finalState.turnState.casRejectedCount).toBeGreaterThanOrEqual(1)
      expect(finalState.sealedTurns).toHaveLength(1)
      expect(finalState.sealedTurns[0]!.rephrasedText).toBe(
        'Deixa eu pensar num jeito de resolver esse bug no código.',
      )
      expect(finalState.sealedTurns[0]!.reason).toBe('end-judged')
    })

    it('Scenario B (barge-in-interrupt.wav): triggers automatic VAD barge-in after >= 300ms of speech while Ashy speaks, fades in 100ms, retains 360ms pre-roll (anchorFrame = 640 > 0), and emits PlaybackReceipt', async () => {
      const wavBytes = new Uint8Array(
        readFileSync(resolve(FIXTURES_DIR, 'barge-in-interrupt.wav')),
      )
      const runtime = createVoiceSessionRuntime({
        micMode: 'continuous',
        wakeWordEnabled: false,
      })

      // Ashy starts speaking a multi-chunk response
      await runtime.enqueueAssistantReply(
        'Eu acho que esse, código precisa de uma refatoração completa agora mesmo.',
      )
      expect(runtime.getState().isPlayingAudio).toBe(true)

      // Stream barge-in-interrupt.wav (0..400ms silence, 400..900ms voiced speech, 900..2200ms silence)
      const stateAfterBargeIn = await runtime.ingestWavBytes(wavBytes)

      expect(stateAfterBargeIn.bargeInCount).toBe(1)
      expect(stateAfterBargeIn.isPlayingAudio).toBe(false)
      expect(stateAfterBargeIn.lastBargeInLeaseAnchorFrame).toBe(640)
      expect(stateAfterBargeIn.lastBargeInPreRollBlocksCount).toBeGreaterThan(0)

      const receipt = stateAfterBargeIn.lastPlaybackReceipt
      expect(receipt).not.toBeNull()
      expect(receipt!.fadeOutMs).toBe(100)
      expect(receipt!.throughMs).toBeGreaterThan(0)
      expect(receipt!.heardText.length).toBeGreaterThan(0)
      expect(receipt!.unheardText.length).toBeGreaterThan(0)
      expect(receipt!.controlNote).toMatch(
        /^\[Interrupted after \d+ms — user heard: ".+" \| unheard: ".+"\]$/,
      )

      // And the interrupting user utterance ("Espera um segundo, Ashy!") seals cleanly
      expect(stateAfterBargeIn.sealedTurns).toHaveLength(1)
      expect(stateAfterBargeIn.sealedTurns[0]!.rephrasedText).toBe('Espera um segundo, Ashy!')
    })

    it('Scenario C (keyboard-click-noise.wav): rejects 120ms (< 300ms) transient click as too-short and does NOT trigger false barge-in while Ashy speaks', async () => {
      const wavBytes = new Uint8Array(
        readFileSync(resolve(FIXTURES_DIR, 'keyboard-click-noise.wav')),
      )
      const runtime = createVoiceSessionRuntime({
        micMode: 'continuous',
        wakeWordEnabled: false,
      })

      await runtime.enqueueAssistantReply(
        'Continuo explicando a arquitetura sem ser interrompida por cliques de teclado.',
      )
      expect(runtime.getState().isPlayingAudio).toBe(true)

      const state = await runtime.ingestWavBytes(wavBytes)

      expect(state.cancelledShortCount).toBeGreaterThanOrEqual(1)
      expect(state.bargeInCount).toBe(0)
      expect(state.lastPlaybackReceipt).toBeNull()
      expect(state.isPlayingAudio).toBe(true)
      expect(state.sealedTurns).toHaveLength(0)
    })

    it('Scenario D (wake-word-oi-ashy.wav & Mic Modes): verifies muted ignores audio, ptt and push-to-talk seal immediately on release, and wakeWordEnabled opens on "Ei Ashy"', async () => {
      const wakeWavBytes = new Uint8Array(
        readFileSync(resolve(FIXTURES_DIR, 'wake-word-oi-ashy.wav')),
      )
      const bargeWavBytes = new Uint8Array(
        readFileSync(resolve(FIXTURES_DIR, 'barge-in-interrupt.wav')),
      )
      const bargeDecoded = decodeWavToPcmBlocks(bargeWavBytes, 20)

      // 1. Muted mode ignores all audio frames
      const mutedRuntime = createVoiceSessionRuntime({ micMode: 'muted' })
      const mutedState = await mutedRuntime.ingestWavBytes(wakeWavBytes)
      expect(mutedState.sealedTurns).toHaveLength(0)
      expect(mutedRuntime.getAecRingBuffer().getBlocks()).toHaveLength(0)

      // 2. PTT ('ptt' and 'push-to-talk' aliases) seals immediately on setPushToTalkActive(false)
      for (const pttAlias of ['ptt', 'push-to-talk'] as const) {
        const pttRuntime = createVoiceSessionRuntime({ micMode: pttAlias })
        expect(pttRuntime.getMicMode()).toBe('ptt')

        await pttRuntime.setPushToTalkActive(true)
        // Feed only the active speech blocks (400..900ms = blocks 20..45) with ZERO trailing silence
        await pttRuntime.ingestPcmBlocks(bargeDecoded.blocks.slice(20, 45))
        expect(pttRuntime.getState().sealedTurns).toHaveLength(0)

        // Releasing PTT seals immediately without waiting 1200ms
        const sealed = await pttRuntime.setPushToTalkActive(false)
        expect(sealed).not.toBeNull()
        expect(sealed!.reason).toBe('manual')
        expect(sealed!.rephrasedText).toBe('Espera um segundo, Ashy!')
        expect(pttRuntime.getState().sealedTurns).toHaveLength(1)
      }

      // 3. Continuous mode with wakeWordEnabled: opens on "Ei Ashy" in wake-word-oi-ashy.wav
      const wakeRuntime = createVoiceSessionRuntime({
        micMode: 'continuous',
        wakeWordEnabled: true,
      })
      const wakeState = await wakeRuntime.ingestWavBytes(wakeWavBytes)
      expect(wakeState.wakeWordDetectedCount).toBeGreaterThanOrEqual(1)
      expect(wakeState.lastWakeWordMatched).toBe('ei ashy')
      expect(wakeState.sealedTurns).toHaveLength(1)
      expect(wakeState.sealedTurns[0]!.rawText).toContain('Ei Ashy, olha esse log')
    })

    it('Scenario E (TTFA Telemetry): records lastTtfaMs, avgTtfaMs, and sampleCount per TtsProviderId on incremental and full synthesis', async () => {
      const runtime = createVoiceSessionRuntime({
        activeTtsProviderId: 'local-synth-fallback',
      })

      runtime.enqueueAssistantDelta('Eu ')
      runtime.enqueueAssistantDelta('acho ')
      runtime.enqueueAssistantDelta('que ')
      runtime.enqueueAssistantDelta('esse, ')
      runtime.enqueueAssistantDelta('código ')
      await runtime.flushAssistantReply()

      const telemetry1 = runtime.getTtfaTelemetry()['local-synth-fallback']
      expect(telemetry1.sampleCount).toBe(1)
      expect(telemetry1.lastTtfaMs).not.toBeNull()
      expect(telemetry1.lastTtfaMs!).toBeGreaterThanOrEqual(0)
      expect(telemetry1.avgTtfaMs).toBe(telemetry1.lastTtfaMs)
      expect(telemetry1.lastSynthesizedAt).not.toBeNull()

      await runtime.enqueueAssistantReply('Segunda frase sintetizada para calcular a média.')
      const telemetry2 = runtime.getTtfaTelemetry()['local-synth-fallback']
      expect(telemetry2.sampleCount).toBe(2)
      expect(telemetry2.avgTtfaMs).not.toBeNull()

      // Verify runFixtureScenario helper across all 4 fixture IDs
      const casScenario = await runtime.runFixtureScenario('thinking-pause-cas')
      expect(casScenario.snapshot.enteredGracePeriodCount).toBeGreaterThanOrEqual(1)
      expect(casScenario.snapshot.turnState.casRejectedCount).toBeGreaterThanOrEqual(1)
      expect(casScenario.snapshot.sealedTurns[0]!.rephrasedText).toBe(
        'Deixa eu pensar num jeito de resolver esse bug no código.',
      )

      const bargeScenario = await runtime.runFixtureScenario('barge-in-interrupt')
      expect(bargeScenario.snapshot.lastBargeInLeaseAnchorFrame).toBe(640)
      expect(bargeScenario.snapshot.lastPlaybackReceipt).not.toBeNull()
    })
  })
})


