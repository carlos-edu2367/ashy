import {
  CONTROL_SENTINEL,
  createTailSafeMarkerParser,
  type AshyStageSignal,
} from './marker-parser'

export interface CategorizedSignalEntry {
  signal: AshyStageSignal
  speechOffset: number
}

export interface CategorizerSnapshot {
  speech: string
  speechWithSentinels: string
  reasoning: string
  signals: AshyStageSignal[]
  signalEntries: CategorizedSignalEntry[]
}

export interface StreamingCategorizerCallbacks {
  onSpeech?: (text: string) => void
  onReasoning?: (text: string) => void
  onSignal?: (signal: AshyStageSignal, speechOffset: number) => void
}

export interface StreamingCategorizer {
  write(chunk: string): void
  feed(chunk: string): void
  flush(): CategorizerSnapshot
  getSnapshot(): CategorizerSnapshot
  reset(): void
  readonly speech: string
  readonly speechWithSentinels: string
  readonly reasoning: string
  readonly signals: readonly AshyStageSignal[]
}

const OPEN_REASONING_TAGS = ['<think>', '<thinking>', '<reasoning>'] as const
const CLOSE_REASONING_TAGS = ['</think>', '</thinking>', '</reasoning>'] as const

function isPrefixOfAnyTag(candidate: string, tags: readonly string[]): boolean {
  const lower = candidate.toLowerCase()
  return tags.some((tag) => tag.startsWith(lower))
}

function matchesAnyTag(candidate: string, tags: readonly string[]): boolean {
  const lower = candidate.toLowerCase()
  return tags.some((tag) => tag === lower)
}

/**
 * Incremental streaming categorizer that separates `<think>`, `<thinking>`, and `<reasoning>`
 * blocks from spoken output while parsing `<|ACT|>`, `<|DELAY|>`, and `<|CALLBACK|>` markers
 * and injecting `CONTROL_SENTINEL` (`\uE000`) at the exact speech offset for TTS synchronization.
 */
export function createStreamingCategorizer(
  callbacks?: StreamingCategorizerCallbacks,
): StreamingCategorizer {
  let speech = ''
  let speechWithSentinels = ''
  let reasoning = ''
  const signals: AshyStageSignal[] = []
  const signalEntries: CategorizedSignalEntry[] = []

  let inReasoning = false
  let tagCandidate = ''

  const markerParser = createTailSafeMarkerParser({
    onLiteral: (text) => {
      if (text.length === 0) return
      speech += text
      speechWithSentinels += text
      callbacks?.onSpeech?.(text)
    },
    onSpecial: (signal) => {
      if (signal.type === 'unknown') {
        return
      }
      const offset = speech.length
      speechWithSentinels += CONTROL_SENTINEL
      signals.push(signal)
      signalEntries.push({ signal, speechOffset: offset })
      callbacks?.onSignal?.(signal, offset)
    },
  })

  function emitReasoning(text: string): void {
    if (text.length === 0) return
    reasoning += text
    callbacks?.onReasoning?.(text)
  }

  function write(chunk: string): void {
    if (typeof chunk !== 'string' || chunk.length === 0) {
      return
    }

    let pendingSpeech = ''
    let pendingReasoning = ''

    const flushPending = () => {
      if (pendingReasoning.length > 0) {
        emitReasoning(pendingReasoning)
        pendingReasoning = ''
      }
      if (pendingSpeech.length > 0) {
        markerParser.write(pendingSpeech)
        pendingSpeech = ''
      }
    }

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!

      if (tagCandidate.length === 0) {
        if (ch === '<') {
          tagCandidate = '<'
        } else if (inReasoning) {
          pendingReasoning += ch
        } else {
          pendingSpeech += ch
        }
        continue
      }

      const nextCandidate = tagCandidate + ch
      const targetTags = inReasoning ? CLOSE_REASONING_TAGS : OPEN_REASONING_TAGS

      if (matchesAnyTag(nextCandidate, targetTags)) {
        flushPending()
        inReasoning = !inReasoning
        tagCandidate = ''
        continue
      }

      if (isPrefixOfAnyTag(nextCandidate, targetTags)) {
        tagCandidate = nextCandidate
        continue
      }

      // Not a valid reasoning tag prefix: flush the previous candidate into the active stream
      if (ch === '<') {
        if (inReasoning) {
          pendingReasoning += tagCandidate
        } else {
          pendingSpeech += tagCandidate
        }
        tagCandidate = '<'
      } else {
        if (inReasoning) {
          pendingReasoning += nextCandidate
        } else {
          pendingSpeech += nextCandidate
        }
        tagCandidate = ''
      }
    }

    flushPending()
  }

  function getSnapshot(): CategorizerSnapshot {
    return {
      speech,
      speechWithSentinels,
      reasoning,
      signals: [...signals],
      signalEntries: [...signalEntries],
    }
  }

  function flush(): CategorizerSnapshot {
    if (tagCandidate.length > 0) {
      // If a lone '<' was left outside reasoning, pass it to markerParser;
      // if it is a multi-char partial reasoning tag like '<thin' or '</thin', discard it safely.
      if (tagCandidate === '<' && !inReasoning) {
        markerParser.write('<')
      }
      tagCandidate = ''
    }

    markerParser.flush()
    return getSnapshot()
  }

  function reset(): void {
    speech = ''
    speechWithSentinels = ''
    reasoning = ''
    signals.length = 0
    signalEntries.length = 0
    inReasoning = false
    tagCandidate = ''
    markerParser.reset()
  }

  return {
    write,
    feed: write,
    flush,
    getSnapshot,
    reset,
    get speech() {
      return speech
    },
    get speechWithSentinels() {
      return speechWithSentinels
    },
    get reasoning() {
      return reasoning
    },
    get signals() {
      return signals
    },
  }
}
