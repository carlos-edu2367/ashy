import { CONTROL_SENTINEL, type AshyStageSignal } from '@ashy/llm'
import { createTtsChunker, type TtsChunkerOptions } from './tts-chunker'

export interface TtsSynthesisOutput {
  durationMs?: number
  durationSec?: number
  samples?: Float32Array
  sampleRate?: number
  audioBuffer?: unknown
}

export interface ScheduledAudioChunk {
  seq: number
  text: string
  durationMs: number
  durationSec: number
  startTimeSec: number
  endTimeSec: number
  synthesisOutput: TtsSynthesisOutput
}

export interface PlaybackReceipt {
  cause: string
  throughMs: number
  fadeOutMs: number
  heardText: string
  unheardText: string
  heardChunks: string[]
  unheardChunks: string[]
  controlNote: string
}

export function formatInterruptionControlNote(
  receipt: Pick<PlaybackReceipt, 'throughMs' | 'heardText' | 'unheardText'>,
): string {
  return `[Interrupted after ${Math.round(receipt.throughMs)}ms — user heard: "${receipt.heardText}" | unheard: "${receipt.unheardText}"]`
}

export interface RealtimeSpeechPipelineOptions {
  synthesizeFn: (text: string, signal: AbortSignal) => Promise<TtsSynthesisOutput>
  onAudioScheduled?: (chunk: ScheduledAudioChunk) => void | Promise<{ throughMs?: number } | void>
  onStageSignal?: (signal: AshyStageSignal, afterChunkSeq: number) => void
  onStopWithFade?: (fadeMs: number) => void
  maxConcurrentTts?: number
  stopFadeMs?: number
  chunkerOptions?: TtsChunkerOptions
}

export interface RealtimeSpeechPipeline {
  enqueue(textWithSentinels: string, signals?: AshyStageSignal[]): void
  advancePlaybackTo(currentPlaybackTimeSec: number): void
  interrupt(cause: string, currentPlaybackTimeSec: number): PlaybackReceipt
  getScheduledChunks(): readonly ScheduledAudioChunk[]
  getCompletedRequestsMap(): ReadonlyMap<number, TtsSynthesisOutput>
  reset(): void
}

interface PendingChunkTask {
  seq: number
  text: string
  abortController: AbortController
  status: 'queued' | 'in-flight' | 'completed' | 'scheduled' | 'cancelled'
  preDelaySec: number
}

interface PendingStageSignalEntry {
  signal: AshyStageSignal
  afterChunkSeq: number
  fired: boolean
}

function resolveDurationSec(output: TtsSynthesisOutput): number {
  if (typeof output.durationSec === 'number' && Number.isFinite(output.durationSec)) {
    return Math.max(0, output.durationSec)
  }
  if (typeof output.durationMs === 'number' && Number.isFinite(output.durationMs)) {
    return Math.max(0, output.durationMs / 1000)
  }
  if (
    output.samples instanceof Float32Array &&
    typeof output.sampleRate === 'number' &&
    output.sampleRate > 0
  ) {
    return output.samples.length / output.sampleRate
  }
  return 0
}

export function createRealtimeSpeechPipeline(
  options: RealtimeSpeechPipelineOptions,
): RealtimeSpeechPipeline {
  const maxConcurrentTts = Math.max(1, options.maxConcurrentTts ?? 4)
  const stopFadeMs = Math.max(0, options.stopFadeMs ?? 100)
  const chunker = createTtsChunker(options.chunkerOptions)

  const allChunkTasks: PendingChunkTask[] = []
  const completedRequests = new Map<number, TtsSynthesisOutput>()
  const scheduledChunks = new Map<number, ScheduledAudioChunk>()
  const stageSignals: PendingStageSignalEntry[] = []

  let nextSeqToAssign = 0
  let nextSeqToSchedule = 0
  let activeWorkers = 0
  let nextStartTimeSec = 0
  let currentPlaybackTimeSec = 0
  let pendingDelayForNextChunkSec = 0
  let interrupted = false

  function fireEligibleStageSignals(upToTimeSec: number): void {
    for (const entry of stageSignals) {
      if (entry.fired) continue

      if (entry.afterChunkSeq < 0) {
        entry.fired = true
        options.onStageSignal?.(entry.signal, entry.afterChunkSeq)
        continue
      }

      const precedingChunk = scheduledChunks.get(entry.afterChunkSeq)
      if (precedingChunk && upToTimeSec >= precedingChunk.endTimeSec - 1e-6) {
        entry.fired = true
        options.onStageSignal?.(entry.signal, entry.afterChunkSeq)
      }
    }
  }

  function drainHeadOfLine(): void {
    if (interrupted) return

    // Fire any leading signals placed before chunk #0
    fireEligibleStageSignals(currentPlaybackTimeSec)

    while (completedRequests.has(nextSeqToSchedule)) {
      const seq = nextSeqToSchedule
      const output = completedRequests.get(seq)!
      completedRequests.delete(seq)

      const task = allChunkTasks[seq]!
      if (task.status === 'cancelled') {
        nextSeqToSchedule += 1
        continue
      }

      const durationSec = resolveDurationSec(output)
      const durationMs = Math.round(durationSec * 1000)
      const startTimeSec =
        Math.max(currentPlaybackTimeSec, nextStartTimeSec) + task.preDelaySec
      const endTimeSec = startTimeSec + durationSec
      nextStartTimeSec = endTimeSec

      task.status = 'scheduled'
      const scheduled: ScheduledAudioChunk = {
        seq,
        text: task.text,
        durationMs,
        durationSec,
        startTimeSec,
        endTimeSec,
        synthesisOutput: output,
      }
      scheduledChunks.set(seq, scheduled)
      nextSeqToSchedule += 1

      const maybePromise = options.onAudioScheduled?.(scheduled)
      if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
        ;(maybePromise as Promise<{ throughMs?: number } | void>).then(() => {
          if (!interrupted) {
            currentPlaybackTimeSec = Math.max(currentPlaybackTimeSec, scheduled.endTimeSec)
            fireEligibleStageSignals(currentPlaybackTimeSec)
          }
        })
      }

      // If durationSec === 0, immediately check signals after this chunk
      if (durationSec === 0) {
        fireEligibleStageSignals(endTimeSec)
      }
    }
  }

  function pumpWorkers(): void {
    if (interrupted) return

    for (const task of allChunkTasks) {
      if (activeWorkers >= maxConcurrentTts) {
        break
      }
      if (task.status !== 'queued') {
        continue
      }

      task.status = 'in-flight'
      activeWorkers += 1

      options
        .synthesizeFn(task.text, task.abortController.signal)
        .then((output) => {
          activeWorkers = Math.max(0, activeWorkers - 1)
          if (interrupted || task.abortController.signal.aborted || task.status === 'cancelled') {
            pumpWorkers()
            return
          }
          task.status = 'completed'
          completedRequests.set(task.seq, output)
          drainHeadOfLine()
          pumpWorkers()
        })
        .catch(() => {
          activeWorkers = Math.max(0, activeWorkers - 1)
          if (!interrupted) {
            pumpWorkers()
          }
        })
    }
  }

  function enqueue(textWithSentinels: string, signals: AshyStageSignal[] = []): void {
    if (interrupted) {
      interrupted = false
    }

    const parts = textWithSentinels.split(CONTROL_SENTINEL)
    let signalCursor = 0

    for (let i = 0; i < parts.length; i++) {
      const span = parts[i]!
      if (span.trim().length > 0) {
        const chunks = chunker.writeFlush(span)
        for (const chunkText of chunks) {
          const seq = nextSeqToAssign++
          const preDelaySec = pendingDelayForNextChunkSec
          pendingDelayForNextChunkSec = 0
          allChunkTasks.push({
            seq,
            text: chunkText,
            abortController: new AbortController(),
            status: 'queued',
            preDelaySec,
          })
        }
      }

      // Between part[i] and part[i + 1], a CONTROL_SENTINEL occurred
      if (i < parts.length - 1) {
        const signal = signals[signalCursor++]
        if (signal) {
          const afterChunkSeq = nextSeqToAssign - 1
          stageSignals.push({
            signal,
            afterChunkSeq,
            fired: false,
          })
          if (signal.type === 'delay' && signal.seconds > 0) {
            pendingDelayForNextChunkSec += signal.seconds
          }
        }
      }
    }

    // Any remaining signals provided in the array are attached after the last chunk
    while (signalCursor < signals.length) {
      const signal = signals[signalCursor++]!
      const afterChunkSeq = nextSeqToAssign - 1
      stageSignals.push({
        signal,
        afterChunkSeq,
        fired: false,
      })
      if (signal.type === 'delay' && signal.seconds > 0) {
        pendingDelayForNextChunkSec += signal.seconds
      }
    }

    fireEligibleStageSignals(currentPlaybackTimeSec)
    pumpWorkers()
  }

  function advancePlaybackTo(timeSec: number): void {
    if (!Number.isFinite(timeSec) || timeSec < 0) return
    currentPlaybackTimeSec = Math.max(currentPlaybackTimeSec, timeSec)
    fireEligibleStageSignals(currentPlaybackTimeSec)
  }

  function interrupt(cause: string, playbackTimeSec: number): PlaybackReceipt {
    interrupted = true
    const clampedTimeSec = Math.max(
      0,
      Number.isFinite(playbackTimeSec) ? playbackTimeSec : currentPlaybackTimeSec,
    )
    currentPlaybackTimeSec = clampedTimeSec

    // Phase 1: Cancel all in-flight and queued TTS synthesis tasks + trigger 100ms fade-out
    for (const task of allChunkTasks) {
      if (task.status === 'queued' || task.status === 'in-flight') {
        task.status = 'cancelled'
        task.abortController.abort(cause)
      }
    }
    completedRequests.clear()

    // Fire any stage signals whose preceding audio already finished before the interruption point
    fireEligibleStageSignals(clampedTimeSec)

    options.onStopWithFade?.(stopFadeMs)

    // Phase 2: Compute exact PlaybackReceipt (throughMs, heardText, unheardText)
    let firstStartSec: number | null = null
    let lastScheduledEndSec = 0
    const heardChunkTexts: string[] = []
    const unheardChunkTexts: string[] = []

    for (let seq = 0; seq < allChunkTasks.length; seq++) {
      const task = allChunkTasks[seq]!
      const scheduled = scheduledChunks.get(seq)

      if (!scheduled) {
        unheardChunkTexts.push(task.text)
        continue
      }

      if (firstStartSec === null || scheduled.startTimeSec < firstStartSec) {
        firstStartSec = scheduled.startTimeSec
      }
      if (scheduled.endTimeSec > lastScheduledEndSec) {
        lastScheduledEndSec = scheduled.endTimeSec
      }

      if (clampedTimeSec >= scheduled.endTimeSec - 1e-6) {
        // Chunk was 100% heard
        heardChunkTexts.push(scheduled.text)
      } else if (clampedTimeSec <= scheduled.startTimeSec + 1e-6) {
        // Chunk playback had not started yet
        unheardChunkTexts.push(scheduled.text)
      } else {
        // Interrupted in the middle of this chunk: split words proportionally
        const ratio =
          scheduled.durationSec > 0
            ? (clampedTimeSec - scheduled.startTimeSec) / scheduled.durationSec
            : 0
        const words = scheduled.text.trim().split(/\s+/).filter(Boolean)
        if (words.length <= 1) {
          if (ratio >= 0.5) {
            heardChunkTexts.push(scheduled.text)
          } else {
            unheardChunkTexts.push(scheduled.text)
          }
        } else {
          const heardCount = Math.min(
            words.length - 1,
            Math.max(1, Math.round(ratio * words.length)),
          )
          const heardPart = words.slice(0, heardCount).join(' ')
          const unheardPart = words.slice(heardCount).join(' ')
          if (heardPart.length > 0) heardChunkTexts.push(heardPart)
          if (unheardPart.length > 0) unheardChunkTexts.push(unheardPart)
        }
      }
    }

    const baseStart = firstStartSec ?? 0
    const effectiveEnd = Math.min(
      clampedTimeSec,
      lastScheduledEndSec > 0 ? lastScheduledEndSec : clampedTimeSec,
    )
    const throughMs = Math.max(0, Math.round((effectiveEnd - baseStart) * 1000))

    const heardText = heardChunkTexts.join(' ').trim()
    const unheardText = unheardChunkTexts.join(' ').trim()
    const controlNote = formatInterruptionControlNote({
      throughMs,
      heardText,
      unheardText,
    })

    return {
      cause,
      throughMs,
      fadeOutMs: stopFadeMs,
      heardText,
      unheardText,
      heardChunks: heardChunkTexts,
      unheardChunks: unheardChunkTexts,
      controlNote,
    }
  }

  function reset(): void {
    for (const task of allChunkTasks) {
      if (task.status === 'queued' || task.status === 'in-flight') {
        task.abortController.abort('reset')
      }
    }
    allChunkTasks.length = 0
    completedRequests.clear()
    scheduledChunks.clear()
    stageSignals.length = 0
    chunker.reset()
    nextSeqToAssign = 0
    nextSeqToSchedule = 0
    activeWorkers = 0
    nextStartTimeSec = 0
    currentPlaybackTimeSec = 0
    pendingDelayForNextChunkSec = 0
    interrupted = false
  }

  return {
    enqueue,
    advancePlaybackTo,
    interrupt,
    getScheduledChunks() {
      return Array.from(scheduledChunks.values()).sort((a, b) => a.seq - b.seq)
    },
    getCompletedRequestsMap() {
      return completedRequests
    },
    reset,
  }
}
