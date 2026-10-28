import { describe, expect, it } from 'vitest'
import { CONTROL_SENTINEL, type AshyStageSignal } from '@ashy/llm'
import {
  createAudioInputRingBuffer,
  createWakeWordSpotterState,
  createSpeechActivityTracker,
  createVoiceTurnController,
  createMarkdownSegmenter,
  createTtsChunker,
  createRealtimeSpeechPipeline,
  formatInterruptionControlNote,
  type PcmAudioBlock,
} from '../src/index'

function makePcmBlock(startFrame: number, durationMs: number, sampleRate = 16000): PcmAudioBlock {
  const frameCount = Math.round((durationMs / 1000) * sampleRate)
  const samples = new Float32Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    samples[i] = (startFrame + i) * 0.0001
  }
  return {
    startFrame,
    endFrame: startFrame + frameCount,
    sampleRate,
    durationMs,
    samples,
  }
}

describe('@ashy/voice — Phase 4 TDD & Red-Team Suite', () => {
  describe('1. AudioInputRingBuffer & WakeWordSpotterState (audio-input.ts)', () => {
    it('retains 360ms pre-roll on HistoryLease across 100ms barge-in fade-out and validates strict frame continuity', () => {
      const ring = createAudioInputRingBuffer({
        baseHistoryMs: 400,
        maxSubscriberBufferedMs: 200,
      })

      // Push 20 blocks of 20ms each = 400ms (frames 0..6400 at 16kHz)
      let cursor = 0
      for (let i = 0; i < 20; i++) {
        const block = makePcmBlock(cursor, 20)
        ring.push(block)
        cursor = block.endFrame
      }

      // Speech onset occurs at 400ms (frame 6400). Acquire a 360ms pre-roll lease!
      // 360ms before 400ms = 40ms (frame 640).
      const leaseController = new AbortController()
      const lease = ring.retain(360, leaseController.signal)
      expect(lease.anchorFrame).toBe(640)
      expect(lease.onsetFrame).toBe(6400)

      // Now assistant takes 100ms (5 blocks of 20ms) doing barge-in fade-out (400ms -> 500ms, frames 6400..8000).
      // Without the lease, history older than 500ms - 400ms = 100ms (frame 1600) would be evicted!
      for (let i = 0; i < 5; i++) {
        const block = makePcmBlock(cursor, 20)
        ring.push(block)
        cursor = block.endFrame
      }

      // Drain from the lease anchorFrame (frame 640): must still be retained and strictly contiguous!
      const captured = ring.captureFrom(lease.anchorFrame)
      expect(captured.length).toBe(23) // 18 pre-roll blocks (360ms) + 5 barge-in blocks (100ms)
      expect(captured[0]!.startFrame).toBe(640)
      expect(captured[captured.length - 1]!.endFrame).toBe(8000)

      for (let i = 1; i < captured.length; i++) {
        expect(captured[i]!.startFrame).toBe(captured[i - 1]!.endFrame)
      }

      // Release lease via AbortController and push another 20ms block; old pinned blocks should now evict
      leaseController.abort()
      const nextBlock = makePcmBlock(cursor, 20)
      ring.push(nextBlock)

      expect(() => ring.captureFrom(640)).toThrow(/continuity|evicted/i)
    })

    it('detects and throws on frame continuity gaps (startFrame !== prevEndFrame)', () => {
      const ring = createAudioInputRingBuffer({ baseHistoryMs: 500 })
      const b1 = makePcmBlock(0, 20) // 0..320
      const b2Gap = makePcmBlock(640, 20) // 640..960 (missing 320..640!)

      ring.push(b1)
      ring.push(b2Gap)

      expect(() => ring.captureFrom(0)).toThrow(/continuity/i)
      // Argument validation: malformed PCM block where samples.length !== endFrame - startFrame
      expect(() =>
        ring.push({
          startFrame: 0,
          endFrame: 320,
          sampleRate: 16000,
          durationMs: 20,
          samples: new Float32Array(10),
        }),
      ).toThrow(/Invalid PcmAudioBlock/i)
    })

    it('isolates slow subscribers exceeding maxSubscriberBufferedMs and synchronous throwing subscribers without blocking fast subscribers', async () => {
      const ring = createAudioInputRingBuffer({
        baseHistoryMs: 400,
        maxSubscriberBufferedMs: 60, // Max 3 blocks of 20ms queued
      })

      const fastVadReceived: number[] = []
      const slowSttReceived: number[] = []
      const slowSttErrors: Error[] = []
      const syncErrors: Error[] = []

      let unblockSlowSubscriber!: () => void
      const slowBlocker = new Promise<void>((resolve) => {
        unblockSlowSubscriber = resolve
      })

      // Synchronous buggy subscriber that throws on every block
      ring.subscribe(
        () => {
          throw new Error('Crash inside buggy subscriber')
        },
        {
          onError: (err) => syncErrors.push(err),
        },
      )

      // Fast synchronous subscriber (e.g. Silero VAD)
      ring.subscribe((block) => {
        fastVadReceived.push(block.startFrame)
      })

      // Slow async subscriber (e.g. stalled STT worker)
      const slowSub = ring.subscribe(
        async (block) => {
          slowSttReceived.push(block.startFrame)
          await slowBlocker
        },
        {
          onError: (err) => {
            slowSttErrors.push(err)
          },
        },
      )

      // Push 6 blocks of 20ms (120ms total).
      let cursor = 0
      for (let i = 0; i < 6; i++) {
        const block = makePcmBlock(cursor, 20)
        ring.push(block)
        cursor = block.endFrame
      }

      // Fast subscriber immediately got all 6 blocks synchronously
      expect(fastVadReceived).toHaveLength(6)
      expect(syncErrors).toHaveLength(6)
      // Slow subscriber overflowed on blocks 4 and 5
      expect(slowSttErrors.length).toBeGreaterThanOrEqual(2)
      expect(slowSttErrors[0]!.message).toMatch(/overflow|buffered/i)
      expect(slowSub.getDroppedBlocks()).toBe(2)

      unblockSlowSubscriber()
    })

    it('WakeWordSpotterState resets decoder after >= 500ms of continuous silence following speech and caps backlog at 1000ms', () => {
      let resets = 0
      const kws = createWakeWordSpotterState({
        resetAfterSilenceMs: 500,
        maxBacklogMs: 1000,
        onReset: () => {
          resets += 1
        },
      })

      // Idle silence before any speech should NOT trigger reset
      kws.reportVad(false, 600)
      expect(resets).toBe(0)

      // Feed 1300ms of raw audio (13 blocks of 100ms) -> backlog should cap at <= 1000ms
      let cursor = 0
      for (let i = 0; i < 13; i++) {
        const block = makePcmBlock(cursor, 100)
        kws.pushRawAudio(block)
        cursor = block.endFrame
      }
      expect(kws.getState().backlogMs).toBeLessThanOrEqual(1000)
      expect(kws.getState().droppedBacklogMs).toBe(300)

      // VAD reports speech for 200ms, then 300ms silence (not yet 500ms), then speech again
      kws.reportVad(true, 200)
      kws.reportVad(false, 300)
      expect(resets).toBe(0)

      kws.reportVad(true, 100)
      kws.reportVad(false, 250)
      expect(resets).toBe(0)
      kws.reportVad(false, 250) // Reaches 500ms continuous silence after speech!
      expect(resets).toBe(1)
      expect(kws.getState().backlogMs).toBe(0)
    })
  })

  describe('2. SpeechActivityTracker & VoiceTurnController CAS (turn-policy.ts)', () => {
    it('applies VAD hysteresis (onset=0.60, sustain=0.18) and cancels < 300ms keyboard clicks unless wake-word opened', () => {
      const tracker = createSpeechActivityTracker({
        onsetThreshold: 0.6,
        sustainRatio: 0.3, // sustainThreshold = 0.18
        minSpeechMs: 300,
      })

      // 0.45 is below onsetThreshold (0.60) -> stays silent
      expect(tracker.processFrame(0.45, 100).isSpeaking).toBe(false)

      // 0.65 triggers onset -> speaking for 100ms
      expect(tracker.processFrame(0.65, 100).isSpeaking).toBe(true)

      // 0.22 is below 0.60 but >= 0.18 sustainThreshold -> sustains speech! (now 200ms total)
      expect(tracker.processFrame(0.22, 100).isSpeaking).toBe(true)

      // Drop to 0.05 (< 0.18) after only 200ms (< 300ms minSpeechMs) -> cancelled as too-short!
      const shortEnd = tracker.processFrame(0.05, 100)
      expect(shortEnd.action).toBe('cancel')
      expect(shortEnd.reason).toBe('too-short')

      // Now open via wake-word: even 150ms of speech is accepted and NOT cancelled as too-short
      tracker.openWithWakeWord()
      tracker.processFrame(0.25, 150)
      const wakeEnd = tracker.processFrame(0.05, 100)
      expect(wakeEnd.action).not.toBe('cancel')
    })

    it('reuses SpeculativeRephrase Promise (600ms) with zero extra calls when turn seals at 1200ms, and invalidates if text changes at 800ms', async () => {
      const rephraseCalls: string[] = []
      const abortedSignals: boolean[] = []

      const controller = createVoiceTurnController({
        speculateAfterMs: 600,
        pauseMs: 1200,
        graceMs: 3000,
        rephraseFn: async (rawText, signal) => {
          rephraseCalls.push(rawText)
          signal.addEventListener('abort', () => {
            abortedSignals.push(true)
          })
          return `Limpo: ${rawText}`
        },
        endJudgeFn: async () => ({ complete: true }),
      })

      controller.updateTranscript('rascunho inicial')
      await controller.advanceSilence(600)
      expect(rephraseCalls).toEqual(['rascunho inicial'])

      // User resumes speaking at 800ms -> invalidates first speculation!
      await controller.advanceSilence(200)
      controller.updateTranscript('hum então eu acho que funciona')
      expect(abortedSignals).toHaveLength(1)

      // Advance 600ms of silence/stability -> triggers second speculative rephrase in background
      await controller.advanceSilence(600)
      expect(rephraseCalls).toEqual(['rascunho inicial', 'hum então eu acho que funciona'])

      // Advance another 600ms (total 1200ms) -> VoiceEndJudge returns { complete: true }
      // Should seal immediately and reuse the already-resolved speculative rephrase promise!
      const step = await controller.advanceSilence(600)
      expect(step.sealed).toBe(true)
      expect(step.result?.reason).toBe('end-judged')
      expect(step.result?.reusedSpeculativeRephrase).toBe(true)
      expect(step.result?.rephrasedText).toBe('Limpo: hum então eu acho que funciona')
      expect(rephraseCalls).toHaveLength(2) // Zero duplicate calls on seal!
    })

    it('grants +3000ms grace period (4200ms total) when VoiceEndJudge returns { complete: false }', async () => {
      const controller = createVoiceTurnController({
        speculateAfterMs: 600,
        pauseMs: 1200,
        graceMs: 3000,
        rephraseFn: async (raw) => raw.trim(),
        endJudgeFn: async () => ({ complete: false, reason: 'thinking-hesitation' }),
      })

      controller.updateTranscript('Deixa eu pensar num jeito de...')

      // At 1200ms, Judge says incomplete -> turn stays open in grace period!
      const at1200 = await controller.advanceSilence(1200)
      expect(at1200.sealed).toBe(false)
      expect(controller.getState().inGracePeriod).toBe(true)

      // At +2000ms (total 3200ms < 4200ms), still open!
      const at3200 = await controller.advanceSilence(2000)
      expect(at3200.sealed).toBe(false)

      // At +1000ms (total 4200ms), grace period expires and turn seals with grace-timeout!
      const at4200 = await controller.advanceSilence(1000)
      expect(at4200.sealed).toBe(true)
      expect(at4200.result?.reason).toBe('grace-timeout')
    })

    it('rejects late VoiceEndJudge { complete: true } via CAS when rawRev, speakerRev or contextRev changes mid-flight', async () => {
      let resolveSlowJudge!: (val: { complete: boolean }) => void
      const controller = createVoiceTurnController({
        speculateAfterMs: 600,
        pauseMs: 1200,
        graceMs: 3000,
        rephraseFn: async (raw) => raw,
        endJudgeFn: () =>
          new Promise((resolve) => {
            resolveSlowJudge = resolve
          }),
      })

      controller.updateTranscript('Eu queria te perguntar')
      await controller.advanceSilence(600)

      // 1. Test rawRev change mid-Judge
      const pendingJudge1 = controller.advanceSilence(600)
      controller.updateTranscript('Eu queria te perguntar sobre o bug')
      resolveSlowJudge({ complete: true })
      const outcome1 = await pendingJudge1

      expect(outcome1.sealed).toBe(false)
      expect(outcome1.casRejected).toBe(true)
      expect(controller.getState().casRejectedCount).toBe(1)

      // 2. Test contextRev change mid-Judge
      const pendingJudge2 = controller.advanceSilence(1200)
      controller.bumpContextRevision()
      resolveSlowJudge({ complete: true })
      const outcome2 = await pendingJudge2

      expect(outcome2.sealed).toBe(false)
      expect(outcome2.casRejected).toBe(true)
      expect(controller.getState().casRejectedCount).toBe(2)
      expect(controller.getState().status).not.toBe('sealed')
    })

    it('gracefully falls back to trimmed rawText if SpeculativeRephrase rejects in background without unhandled rejection', async () => {
      const controller = createVoiceTurnController({
        speculateAfterMs: 600,
        pauseMs: 1200,
        graceMs: 3000,
        rephraseFn: async () => {
          throw new Error('Transient LLM network failure')
        },
        endJudgeFn: async () => ({ complete: true }),
      })

      controller.updateTranscript('  fala original sem falha  ')
      await controller.advanceSilence(600)
      const outcome = await controller.advanceSilence(600)

      expect(outcome.sealed).toBe(true)
      expect(outcome.result?.rephrasedText).toBe('fala original sem falha')
    })
  })

  describe('3. MarkdownSegmenter & TtsChunker TTFA Boost (markdown-segmenter.ts & tts-chunker.ts)', () => {
    it('MarkdownSegmenter ignores .!? inside code fences, inline code, links and LaTeX while preserving \\uE000', () => {
      const segmenter = createMarkdownSegmenter()

      const input = [
        `Olhe o arquivo \`config.prod.json\` e acesse [nosso portal!](https://ashy.dev/v1.0/index.html?ok=true!).`,
        ` ${CONTROL_SENTINEL}A fórmula é $x = 3.14!$ e no bloco:\n\`\`\`ts\nconst a = obj.prop!;\n\`\`\`\nTudo certo?`,
      ].join('')

      const segments: string[] = []
      // Stream character by character to prove incremental safety
      for (const ch of input) {
        segments.push(...segmenter.write(ch))
      }
      segments.push(...segmenter.flush())

      expect(segments).toHaveLength(2)
      // Segment 1 only closed at the true sentence-ending period after the markdown link!
      expect(segments[0]).toContain('config.prod.json')
      expect(segments[0]).toContain('nosso portal!')
      expect(segments[0]).not.toContain('https://ashy.dev')

      // Segment 2 preserved CONTROL_SENTINEL (\uE000) intact and did not split inside $...$ or ```...```
      expect(segments[1]).toContain(CONTROL_SENTINEL)
      expect(segments[1]!.indexOf(CONTROL_SENTINEL)).toBe(0)
      expect(segments[1]).toContain('Tudo certo?')
    })

    it('TtsChunker applies TTFA Boost on first 2 chunks (4..12 words on soft punctuation) and sentence-only from 3rd chunk (with 160-char cap)', () => {
      const chunker = createTtsChunker({
        boostChunks: 2,
        minBoostWords: 4,
        maxBoostWords: 12,
        maxChunkChars: 160,
      })

      const text =
        'Olha só que interessante, esse primeiro trecho sai super rápido; e a partir do terceiro bloco, mesmo tendo várias vírgulas pelo caminho, ele espera o ponto final.'

      const chunks = [...chunker.write(text), ...chunker.flush()]

      expect(chunks.length).toBe(3)
      // Chunk 0 (boost #1): cut at comma after 4 words ("Olha só que interessante,")
      expect(chunks[0]).toBe('Olha só que interessante,')
      // Chunk 1 (boost #2): cut at semicolon after 6 words ("esse primeiro trecho sai super rápido;")
      expect(chunks[1]).toBe('esse primeiro trecho sai super rápido;')
      // Chunk 2 (chunkIndex === 2, post-boost): ignores all intermediate commas and waits for the period!
      expect(chunks[2]).toBe(
        'e a partir do terceiro bloco, mesmo tendo várias vírgulas pelo caminho, ele espera o ponto final.',
      )

      // Now verify maxChunkChars = 160 forces a clean word-boundary cut on a very long sentence (>160 chars)
      const veryLongSentence =
        'Esta frase pós boost é propositalmente muito longa e continua adicionando palavras sem nenhum ponto final para provar que o limite máximo de cento e sessenta caracteres força o corte seguro.'
      const longChunks = chunker.writeFlush(veryLongSentence)
      expect(longChunks.length).toBe(2)
      expect(longChunks[0]!.length).toBeLessThanOrEqual(160)
    })

    it('TtsChunker forces word-boundary cut at maxBoostWords=12 when no soft punctuation is present and preserves 3.14 / ...', () => {
      const chunker = createTtsChunker({
        boostChunks: 2,
        minBoostWords: 4,
        maxBoostWords: 12,
      })

      const noCommaText =
        'um dois tres quatro cinco seis sete oito nove dez onze doze treze quatorze quinze.'
      const chunks = chunker.writeFlush(noCommaText)

      expect(chunks).toHaveLength(2)
      expect(chunks[0]!.split(/\s+/)).toHaveLength(12)
      expect(chunks[1]).toBe('treze quatorze quinze.')

      // Reset and test lookahead for decimals (3.14) and ellipses (...)
      chunker.reset()
      const tricky = 'O valor aproximado de pi é 3.14159 no cálculo. E depois... tudo mudou!'
      const trickyChunks: string[] = []
      for (const ch of tricky) {
        trickyChunks.push(...chunker.write(ch))
      }
      trickyChunks.push(...chunker.flush())

      // Must never split "3." from "14159"
      expect(trickyChunks.some((c) => c.includes('3.14159'))).toBe(true)
      // Ellipsis "..." stays together
      expect(trickyChunks.some((c) => c.includes('...'))).toBe(true)
    })
  })

  describe('4. RealtimeSpeechPipeline: 4x Parallel TTS, Head-of-Line Reordering, Stage Signal Sync & Barge-In Receipt (speech-pipeline.ts)', () => {
    it('runs up to 4 TTS workers in parallel, reorders out-of-order completions strictly (0, 1, 2, 3), and fires <|ACT|> only after previous chunk playback ends', async () => {
      const resolvers = new Map<number, () => void>()
      let activeWorkers = 0
      let maxObservedConcurrent = 0
      let callIdx = 0

      const scheduledOrder: Array<{
        seq: number
        text: string
        startTimeSec: number
        endTimeSec: number
      }> = []
      const firedEvents: string[] = []

      const pipeline = createRealtimeSpeechPipeline({
        maxConcurrentTts: 4,
        stopFadeMs: 100,
        synthesizeFn: async () => {
          const myIdx = callIdx++
          activeWorkers += 1
          maxObservedConcurrent = Math.max(maxObservedConcurrent, activeWorkers)

          await new Promise<void>((resolve) => {
            resolvers.set(myIdx, resolve)
          })

          activeWorkers -= 1
          return {
            durationMs: 500, // 0.5s per chunk
          }
        },
        onAudioScheduled: (item) => {
          scheduledOrder.push({
            seq: item.seq,
            text: item.text,
            startTimeSec: item.startTimeSec,
            endTimeSec: item.endTimeSec,
          })
          firedEvents.push(`scheduled:${item.seq}`)
        },
        onStageSignal: (signal) => {
          firedEvents.push(`signal:${signal.type}:${signal.type === 'act' ? signal.emotion : ''}`)
        },
      })

      const actSignal: AshyStageSignal = {
        type: 'act',
        emotion: 'tease',
        intensity: 0.9,
        raw: '<|ACT {"emotion":"tease","intensity":0.9}|>',
      }

      // Feed 5 sentences, with CONTROL_SENTINEL (\uE000) placed right after sentence #0 (before sentence #1)
      const streamText = [
        `Primeira frase curta aqui.${CONTROL_SENTINEL}`,
        'Segunda frase de teste agora. ',
        'Terceira frase na fila paralela. ',
        'Quarta frase completando quatro workers. ',
        'Quinta frase aguardando vaga no pool.',
      ].join('')

      pipeline.enqueue(streamText, [actSignal])

      // Wait a microtask for worker dispatch
      await Promise.resolve()

      // Max concurrent TTS workers must be capped at 4 even though 5 chunks exist
      expect(maxObservedConcurrent).toBe(4)
      expect(resolvers.size).toBe(4)

      // Resolve chunk #2 and chunk #1 BEFORE chunk #0!
      resolvers.get(2)!()
      resolvers.get(1)!()
      await Promise.resolve()
      await Promise.resolve()

      // Head-of-line blocking: neither #1 nor #2 can be scheduled before #0 finishes!
      expect(scheduledOrder).toHaveLength(0)
      expect(firedEvents).toHaveLength(0)

      // Now resolve chunk #0 -> #0, #1, #2 should all drain in strict order (0, 1, 2) and #4 dispatches!
      resolvers.get(0)!()
      await new Promise((r) => setTimeout(r, 10))

      expect(scheduledOrder.map((s) => s.seq)).toEqual([0, 1, 2])
      expect(scheduledOrder[0]!.startTimeSec).toBeCloseTo(0, 3)
      expect(scheduledOrder[0]!.endTimeSec).toBeCloseTo(0.5, 3)
      expect(scheduledOrder[1]!.startTimeSec).toBeCloseTo(0.5, 3)
      expect(scheduledOrder[1]!.endTimeSec).toBeCloseTo(1.0, 3)
      expect(scheduledOrder[2]!.startTimeSec).toBeCloseTo(1.0, 3)
      expect(scheduledOrder[2]!.endTimeSec).toBeCloseTo(1.5, 3)

      // Crucial check: <|ACT {"emotion":"tease"}|> is between chunk #0 and chunk #1.
      // At playback time 0.2s (chunk #0 is still playing!), the signal MUST NOT have fired yet!
      pipeline.advancePlaybackTo(0.2)
      expect(firedEvents.includes('signal:act:tease')).toBe(false)

      // Advance playback clock to 0.5s (exact end of chunk #0 playback) -> <|ACT|> fires now!
      pipeline.advancePlaybackTo(0.5)
      expect(firedEvents.includes('signal:act:tease')).toBe(true)

      // Clean up remaining resolvers
      resolvers.get(3)?.()
      await new Promise((r) => setTimeout(r, 10))
      resolvers.get(4)?.()
      await new Promise((r) => setTimeout(r, 10))
      expect(scheduledOrder.map((s) => s.seq)).toEqual([0, 1, 2, 3, 4])
    })

    it('produces exact 2-phase Barge-In PlaybackReceipt (throughMs, heardText, unheardText) and formatted LLM control note', async () => {
      let fadeCalledWithMs = 0

      const pipeline = createRealtimeSpeechPipeline({
        maxConcurrentTts: 4,
        stopFadeMs: 100,
        synthesizeFn: async () => ({
          durationMs: 1000, // Each chunk is 1000ms (1.0s)
        }),
        onStopWithFade: (fadeMs) => {
          fadeCalledWithMs = fadeMs
        },
      })

      // Chunk 0 (0.0s .. 1.0s): "Eu acho que esse," (4 words)
      // Chunk 1 (1.0s .. 2.0s): "código precisa de refatoração." (4 words)
      // Chunk 2 (2.0s .. 3.0s): "Vamos corrigir isso juntos agora." (5 words)
      pipeline.enqueue(
        'Eu acho que esse, código precisa de refatoração. Vamos corrigir isso juntos agora.',
      )

      await new Promise((r) => setTimeout(r, 20))

      // Interrupt at 1.5s (1500ms):
      // - Chunk 0 (0..1.0s) was 100% heard ("Eu acho que esse,")
      // - Chunk 1 (1.0..2.0s) was 50% heard ("código precisa" heard, "de refatoração." unheard)
      // - Chunk 2 (2.0..3.0s) was 0% heard ("Vamos corrigir isso juntos agora." unheard)
      const receipt = pipeline.interrupt('user-barge-in', 1.5)

      expect(fadeCalledWithMs).toBe(100)
      expect(receipt.fadeOutMs).toBe(100)
      expect(receipt.throughMs).toBe(1500)
      expect(receipt.heardText).toBe('Eu acho que esse, código precisa')
      expect(receipt.unheardText).toBe('de refatoração. Vamos corrigir isso juntos agora.')

      const note = formatInterruptionControlNote(receipt)
      expect(note).toBe(
        '[Interrupted after 1500ms — user heard: "Eu acho que esse, código precisa" | unheard: "de refatoração. Vamos corrigir isso juntos agora."]',
      )
      expect(receipt.controlNote).toBe(note)
    })

    it('applies <|DELAY|> offset to gapless timeline and fires <|DELAY|> signal after preceding chunk finishes', async () => {
      const events: string[] = []
      const pipeline = createRealtimeSpeechPipeline({
        synthesizeFn: async () => ({ durationMs: 400 }),
        onAudioScheduled: (chunk) => {
          events.push(`sched:${chunk.seq}:${chunk.startTimeSec.toFixed(1)}-${chunk.endTimeSec.toFixed(1)}`)
        },
        onStageSignal: (sig) => {
          events.push(`sig:${sig.type}:${sig.type === 'delay' ? sig.seconds : ''}`)
        },
      })

      pipeline.enqueue(`Primeiro bloco aqui.${CONTROL_SENTINEL}Segundo bloco depois da pausa.`, [
        { type: 'delay', seconds: 0.8, raw: '<|DELAY 0.8|>' },
      ])

      await new Promise((r) => setTimeout(r, 20))

      // Chunk 0 is scheduled at 0.0-0.4s; Chunk 1 is offset by 0.8s delay -> 1.2-1.6s!
      expect(events).toEqual(['sched:0:0.0-0.4', 'sched:1:1.2-1.6'])

      // Signal fires only when Chunk 0 finishes at 0.4s
      pipeline.advancePlaybackTo(0.4)
      expect(events).toContain('sig:delay:0.8')
    })
  })
})
