export interface PcmAudioBlock {
  startFrame: number
  endFrame: number
  sampleRate: number
  durationMs: number
  samples: Float32Array
}

export interface HistoryLease {
  readonly id: number
  readonly preRollMs: number
  readonly anchorFrame: number
  readonly onsetFrame: number
  readonly active: boolean
  release(): void
  dispose(): void
}

export interface AudioRingSubscriberOptions {
  maxBufferedMs?: number
  onError?: (error: Error) => void
  onOverflow?: (droppedBlock: PcmAudioBlock, bufferedMs: number) => void
}

export interface AudioRingSubscription {
  unsubscribe(): void
  getBufferedMs(): number
  getDroppedBlocks(): number
}

export interface AudioInputRingBufferOptions {
  baseHistoryMs?: number
  maxSubscriberBufferedMs?: number
}

export interface AudioInputRingBuffer {
  push(block: PcmAudioBlock): void
  write(block: PcmAudioBlock): void
  retain(
    preRollMsOrOptions?: number | { preRollMs?: number; signal?: AbortSignal },
    signal?: AbortSignal,
  ): HistoryLease
  captureFrom(frame: number): PcmAudioBlock[]
  subscribe(
    listener: (block: PcmAudioBlock) => void | Promise<void>,
    options?: AudioRingSubscriberOptions,
  ): AudioRingSubscription
  getBufferedDurationMs(): number
  getBlocks(): readonly PcmAudioBlock[]
  clear(): void
}

interface InternalLease {
  id: number
  preRollMs: number
  anchorFrame: number
  onsetFrame: number
  active: boolean
}

interface InternalSubscriber {
  listener: (block: PcmAudioBlock) => void | Promise<void>
  maxBufferedMs: number
  onError?: (error: Error) => void
  onOverflow?: (droppedBlock: PcmAudioBlock, bufferedMs: number) => void
  queue: PcmAudioBlock[]
  bufferedMs: number
  processing: boolean
  droppedBlocks: number
  disposed: boolean
}

function validatePcmBlock(block: PcmAudioBlock): void {
  if (
    !block ||
    !Number.isFinite(block.startFrame) ||
    !Number.isFinite(block.endFrame) ||
    block.endFrame < block.startFrame ||
    !Number.isFinite(block.sampleRate) ||
    block.sampleRate <= 0 ||
    !Number.isFinite(block.durationMs) ||
    block.durationMs < 0 ||
    !(block.samples instanceof Float32Array) ||
    block.samples.length !== block.endFrame - block.startFrame
  ) {
    throw new Error('Invalid PcmAudioBlock provided to AudioInputRingBuffer')
  }
}

export function createAudioInputRingBuffer(
  options: AudioInputRingBufferOptions = {},
): AudioInputRingBuffer {
  const baseHistoryMs = Math.max(0, options.baseHistoryMs ?? 360)
  const defaultMaxSubscriberBufferedMs = Math.max(1, options.maxSubscriberBufferedMs ?? 240)

  const blocks: PcmAudioBlock[] = []
  let totalHistoryMs = 0
  let nextLeaseId = 1
  const activeLeases = new Map<number, InternalLease>()
  const subscribers = new Set<InternalSubscriber>()

  function getMinPinnedFrame(): number | null {
    let minFrame: number | null = null
    for (const lease of activeLeases.values()) {
      if (!lease.active) continue
      if (minFrame === null || lease.anchorFrame < minFrame) {
        minFrame = lease.anchorFrame
      }
    }
    return minFrame
  }

  function getEffectiveHistoryMs(): number {
    let maxMs = baseHistoryMs
    for (const lease of activeLeases.values()) {
      if (lease.active && lease.preRollMs > maxMs) {
        maxMs = lease.preRollMs
      }
    }
    return maxMs
  }

  function evictOldBlocks(): void {
    const minPinnedFrame = getMinPinnedFrame()
    const targetHistoryMs = getEffectiveHistoryMs()

    while (blocks.length > 1) {
      const oldest = blocks[0]!
      // Never evict a block if an active HistoryLease pins a frame inside or before this block
      if (minPinnedFrame !== null && oldest.endFrame > minPinnedFrame) {
        break
      }
      if (totalHistoryMs - oldest.durationMs >= targetHistoryMs) {
        blocks.shift()
        totalHistoryMs = Math.max(0, totalHistoryMs - oldest.durationMs)
      } else {
        break
      }
    }
  }

  function drainSubscriberQueue(sub: InternalSubscriber): void {
    if (sub.processing || sub.disposed) {
      return
    }
    const nextBlock = sub.queue.shift()
    if (!nextBlock) {
      return
    }
    sub.bufferedMs = Math.max(0, sub.bufferedMs - nextBlock.durationMs)

    try {
      const res = sub.listener(nextBlock)
      if (res && typeof (res as Promise<void>).then === 'function') {
        sub.processing = true
        ;(res as Promise<void>).then(
          () => {
            sub.processing = false
            drainSubscriberQueue(sub)
          },
          (err: unknown) => {
            sub.processing = false
            const error = err instanceof Error ? err : new Error(String(err))
            sub.onError?.(error)
            drainSubscriberQueue(sub)
          },
        )
      } else if (sub.queue.length > 0) {
        drainSubscriberQueue(sub)
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      sub.onError?.(error)
      if (sub.queue.length > 0) {
        drainSubscriberQueue(sub)
      }
    }
  }

  function notifySubscriber(sub: InternalSubscriber, block: PcmAudioBlock): void {
    if (sub.disposed) {
      return
    }

    if (!sub.processing && sub.queue.length === 0) {
      try {
        const res = sub.listener(block)
        if (res && typeof (res as Promise<void>).then === 'function') {
          sub.processing = true
          ;(res as Promise<void>).then(
            () => {
              sub.processing = false
              drainSubscriberQueue(sub)
            },
            (err: unknown) => {
              sub.processing = false
              const error = err instanceof Error ? err : new Error(String(err))
              sub.onError?.(error)
              drainSubscriberQueue(sub)
            },
          )
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        sub.onError?.(error)
      }
      return
    }

    // Subscriber is currently busy: check slow consumer buffer limit
    if (sub.bufferedMs + block.durationMs > sub.maxBufferedMs) {
      sub.droppedBlocks += 1
      const overflowErr = new Error(
        `Subscriber buffer overflow: buffered ${sub.bufferedMs}ms + ${block.durationMs}ms exceeds limit ${sub.maxBufferedMs}ms`,
      )
      sub.onOverflow?.(block, sub.bufferedMs)
      sub.onError?.(overflowErr)
      return
    }

    sub.queue.push(block)
    sub.bufferedMs += block.durationMs
  }

  function push(block: PcmAudioBlock): void {
    validatePcmBlock(block)
    blocks.push(block)
    totalHistoryMs += block.durationMs
    evictOldBlocks()

    for (const sub of subscribers) {
      notifySubscriber(sub, block)
    }
  }

  function retain(
    preRollMsOrOptions?: number | { preRollMs?: number; signal?: AbortSignal },
    maybeSignal?: AbortSignal,
  ): HistoryLease {
    let preRollMs = 360
    let signal = maybeSignal

    if (typeof preRollMsOrOptions === 'number') {
      preRollMs = preRollMsOrOptions
    } else if (preRollMsOrOptions && typeof preRollMsOrOptions === 'object') {
      if (typeof preRollMsOrOptions.preRollMs === 'number') {
        preRollMs = preRollMsOrOptions.preRollMs
      }
      if (preRollMsOrOptions.signal) {
        signal = preRollMsOrOptions.signal
      }
    }

    preRollMs = Math.max(0, preRollMs)
    const latest = blocks[blocks.length - 1]
    const onsetFrame = latest ? latest.endFrame : 0
    const sampleRate = latest ? latest.sampleRate : 16000
    const preRollFrames = Math.round((preRollMs / 1000) * sampleRate)
    const anchorFrame = Math.max(0, onsetFrame - preRollFrames)

    const id = nextLeaseId++
    const internal: InternalLease = {
      id,
      preRollMs,
      anchorFrame,
      onsetFrame,
      active: true,
    }
    activeLeases.set(id, internal)

    const release = (): void => {
      if (!internal.active) return
      internal.active = false
      activeLeases.delete(id)
      evictOldBlocks()
    }

    if (signal) {
      if (signal.aborted) {
        release()
      } else {
        signal.addEventListener('abort', release, { once: true })
      }
    }

    return {
      get id() {
        return internal.id
      },
      get preRollMs() {
        return internal.preRollMs
      },
      get anchorFrame() {
        return internal.anchorFrame
      },
      get onsetFrame() {
        return internal.onsetFrame
      },
      get active() {
        return internal.active
      },
      release,
      dispose: release,
    }
  }

  function captureFrom(frame: number): PcmAudioBlock[] {
    if (!Number.isFinite(frame) || frame < 0) {
      throw new Error(`Invalid frame index ${frame} in captureFrom`)
    }
    if (blocks.length === 0) {
      throw new Error('Cannot captureFrom an empty AudioInputRingBuffer')
    }

    const oldest = blocks[0]!
    if (frame < oldest.startFrame) {
      throw new Error(
        `Frame continuity error: requested frame ${frame} was already evicted (oldest available startFrame is ${oldest.startFrame})`,
      )
    }

    const startIdx = blocks.findIndex((b) => b.endFrame > frame)
    if (startIdx === -1) {
      return []
    }

    const result: PcmAudioBlock[] = []
    for (let i = startIdx; i < blocks.length; i++) {
      const curr = blocks[i]!
      if (i > startIdx) {
        const prev = blocks[i - 1]!
        if (curr.startFrame !== prev.endFrame) {
          throw new Error(
            `Strict frame continuity violation: block[${i}].startFrame (${curr.startFrame}) !== block[${i - 1}].endFrame (${prev.endFrame})`,
          )
        }
        if (curr.sampleRate !== prev.sampleRate) {
          throw new Error(
            `Sample rate continuity violation: ${curr.sampleRate} !== ${prev.sampleRate}`,
          )
        }
      }

      if (i === startIdx && frame > curr.startFrame) {
        const offsetFrames = frame - curr.startFrame
        const slicedSamples = curr.samples.subarray(offsetFrames)
        const remainingFrames = curr.endFrame - frame
        result.push({
          startFrame: frame,
          endFrame: curr.endFrame,
          sampleRate: curr.sampleRate,
          durationMs: (remainingFrames / curr.sampleRate) * 1000,
          samples: slicedSamples,
        })
      } else {
        result.push(curr)
      }
    }

    return result
  }

  function subscribe(
    listener: (block: PcmAudioBlock) => void | Promise<void>,
    subOptions: AudioRingSubscriberOptions = {},
  ): AudioRingSubscription {
    const sub: InternalSubscriber = {
      listener,
      maxBufferedMs: Math.max(1, subOptions.maxBufferedMs ?? defaultMaxSubscriberBufferedMs),
      onError: subOptions.onError,
      onOverflow: subOptions.onOverflow,
      queue: [],
      bufferedMs: 0,
      processing: false,
      droppedBlocks: 0,
      disposed: false,
    }
    subscribers.add(sub)

    return {
      unsubscribe() {
        sub.disposed = true
        sub.queue.length = 0
        sub.bufferedMs = 0
        subscribers.delete(sub)
      },
      getBufferedMs() {
        return sub.bufferedMs
      },
      getDroppedBlocks() {
        return sub.droppedBlocks
      },
    }
  }

  return {
    push,
    write: push,
    retain,
    captureFrom,
    subscribe,
    getBufferedDurationMs() {
      return totalHistoryMs
    },
    getBlocks() {
      return blocks.slice()
    },
    clear() {
      blocks.length = 0
      totalHistoryMs = 0
    },
  }
}

export interface WakeWordSpotterStateOptions {
  resetAfterSilenceMs?: number
  maxBacklogMs?: number
  onReset?: () => void
  onWakeWord?: (detection: { keyword: string; confidence: number; frame: number }) => void
  decodeBlock?: (block: PcmAudioBlock) => { keyword: string; confidence?: number } | null | void
}

export interface WakeWordSpotterSnapshot {
  backlogMs: number
  backlogBlocks: number
  droppedBacklogMs: number
  continuousSilenceMs: number
  hadSpeech: boolean
  resetCount: number
}

export interface WakeWordSpotterState {
  pushRawAudio(block: PcmAudioBlock): void
  reportVad(isSpeaking: boolean, durationMs?: number): void
  drainBacklog(): PcmAudioBlock[]
  reset(): void
  getState(): WakeWordSpotterSnapshot
}

export function createWakeWordSpotterState(
  options: WakeWordSpotterStateOptions = {},
): WakeWordSpotterState {
  const resetAfterSilenceMs = Math.max(1, options.resetAfterSilenceMs ?? 500)
  const maxBacklogMs = Math.max(1, options.maxBacklogMs ?? 1000)

  const backlog: PcmAudioBlock[] = []
  let backlogMs = 0
  let droppedBacklogMs = 0
  let continuousSilenceMs = 0
  let hadSpeech = false
  let resetCount = 0

  function reset(): void {
    backlog.length = 0
    backlogMs = 0
    continuousSilenceMs = 0
    hadSpeech = false
    resetCount += 1
    options.onReset?.()
  }

  function pushRawAudio(block: PcmAudioBlock): void {
    validatePcmBlock(block)
    backlog.push(block)
    backlogMs += block.durationMs

    while (backlogMs > maxBacklogMs && backlog.length > 0) {
      const dropped = backlog.shift()!
      backlogMs = Math.max(0, backlogMs - dropped.durationMs)
      droppedBacklogMs += dropped.durationMs
    }

    if (options.decodeBlock) {
      const detection = options.decodeBlock(block)
      if (detection && detection.keyword) {
        options.onWakeWord?.({
          keyword: detection.keyword,
          confidence: detection.confidence ?? 1,
          frame: block.endFrame,
        })
      }
    }
  }

  function reportVad(isSpeaking: boolean, durationMs = 32): void {
    const dt = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0)
    if (isSpeaking) {
      hadSpeech = true
      continuousSilenceMs = 0
      return
    }

    if (hadSpeech) {
      continuousSilenceMs += dt
      if (continuousSilenceMs >= resetAfterSilenceMs) {
        reset()
      }
    }
  }

  function drainBacklog(): PcmAudioBlock[] {
    const drained = backlog.splice(0, backlog.length)
    backlogMs = 0
    return drained
  }

  return {
    pushRawAudio,
    reportVad,
    drainBacklog,
    reset,
    getState(): WakeWordSpotterSnapshot {
      return {
        backlogMs,
        backlogBlocks: backlog.length,
        droppedBacklogMs,
        continuousSilenceMs,
        hadSpeech,
        resetCount,
      }
    },
  }
}
