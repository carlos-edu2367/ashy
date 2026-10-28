import { createGraphemeStreamer } from '@ashy/shared'

export interface TtsChunkerOptions {
  boostChunks?: number
  minBoostWords?: number
  maxBoostWords?: number
  maxChunkChars?: number
  onChunk?: (chunk: string, index: number) => void
}

export interface TtsChunker {
  write(text: string): string[]
  writeFlush(text?: string): string[]
  flush(): string[]
  reset(): void
  getChunkIndex(): number
}

const SOFT_PUNCTUATION = new Set([',', '，', '、', '—', ':', ';'])
const STRONG_PUNCTUATION = new Set(['.', '!', '?', '…', '⋯', '。', '！', '？', '\n'])

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

function countWords(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  let count = 0
  for (const token of trimmed.split(/\s+/)) {
    if (/[\p{L}\p{N}]/u.test(token)) {
      count += 1
    }
  }
  return count
}

export function createTtsChunker(options: TtsChunkerOptions = {}): TtsChunker {
  const boostChunks = Math.max(0, options.boostChunks ?? 2)
  const minBoostWords = Math.max(1, options.minBoostWords ?? 4)
  const maxBoostWords = Math.max(minBoostWords, options.maxBoostWords ?? 12)
  const maxChunkChars = Math.max(16, options.maxChunkChars ?? 160)

  const graphemeStreamer = createGraphemeStreamer()
  let buffer = ''
  let chunkIndex = 0

  function emitChunk(rawSlice: string, out: string[]): void {
    const cleaned = rawSlice.replace(/\s+/g, ' ').trim()
    if (cleaned.length === 0) {
      return
    }
    const idx = chunkIndex++
    out.push(cleaned)
    options.onChunk?.(cleaned, idx)
  }

  function findNextCutIndex(buf: string, isFlushing: boolean): number {
    // Strip leading whitespace first
    const leadingTrimmed = buf.replace(/^\s+/, '')
    const leadingOffset = buf.length - leadingTrimmed.length
    if (leadingTrimmed.length === 0) {
      return -1
    }

    const inBoost = chunkIndex < boostChunks
    const len = buf.length

    for (let i = leadingOffset; i < len; i++) {
      const ch = buf[i]!
      const prevChar = i > leadingOffset ? buf[i - 1] : undefined
      const nextChar = i + 1 < len ? buf[i + 1] : undefined

      // 1-char lookahead requirement when not flushing:
      // If we are at the last character of the buffer, hold back in case it's '3.' followed by '14' or '...'
      if (!isFlushing && i === len - 1) {
        if (STRONG_PUNCTUATION.has(ch) || SOFT_PUNCTUATION.has(ch)) {
          return -1
        }
      }

      const isStrong = STRONG_PUNCTUATION.has(ch)
      const isSoft = SOFT_PUNCTUATION.has(ch)

      if (isStrong || (inBoost && isSoft)) {
        // Guard against decimal numbers like 3.14
        if ((ch === '.' || ch === ',') && isDigit(prevChar) && isDigit(nextChar)) {
          continue
        }

        // Guard against splitting in the middle of ellipses (...) or multi-punctuation (!?)
        if (
          nextChar !== undefined &&
          (STRONG_PUNCTUATION.has(nextChar) || (inBoost && SOFT_PUNCTUATION.has(nextChar))) &&
          nextChar !== '\n'
        ) {
          continue
        }

        const candidate = buf.slice(leadingOffset, i + 1)
        const words = countWords(candidate)

        if (isStrong && words >= 1) {
          return i + 1
        }

        if (inBoost && isSoft && words >= minBoostWords) {
          return i + 1
        }
      }

      // In boost mode, force cut at word boundary once maxBoostWords (12) is reached
      if (inBoost && isWhitespace(ch)) {
        const candidate = buf.slice(leadingOffset, i)
        if (countWords(candidate) >= maxBoostWords) {
          return i + 1
        }
      }

      // Max chunk characters limit (160 chars)
      const currentSpanLen = i - leadingOffset + 1
      if (currentSpanLen >= maxChunkChars) {
        // Cut at last whitespace within maxChunkChars if available
        const span = buf.slice(leadingOffset, i + 1)
        const lastSpace = span.search(/\s+\S*$/)
        if (lastSpace > 0) {
          return leadingOffset + lastSpace + 1
        }
        return i + 1
      }
    }

    return -1
  }

  function drain(isFlushing: boolean): string[] {
    const out: string[] = []

    while (buffer.length > 0) {
      const cutIdx = findNextCutIndex(buffer, isFlushing)
      if (cutIdx === -1) {
        break
      }
      const slice = buffer.slice(0, cutIdx)
      buffer = buffer.slice(cutIdx).replace(/^\s+/, '')
      emitChunk(slice, out)
    }

    if (isFlushing && buffer.length > 0) {
      const remaining = buffer
      buffer = ''
      emitChunk(remaining, out)
    }

    return out
  }

  function write(text: string): string[] {
    if (typeof text !== 'string' || text.length === 0) {
      return []
    }
    const graphemes = graphemeStreamer.write(text)
    if (graphemes.length === 0) {
      return []
    }
    buffer += graphemes.join('')
    return drain(false)
  }

  function flush(): string[] {
    const tailGraphemes = graphemeStreamer.flush()
    if (tailGraphemes.length > 0) {
      buffer += tailGraphemes.join('')
    }
    return drain(true)
  }

  function writeFlush(text?: string): string[] {
    const out: string[] = []
    if (typeof text === 'string' && text.length > 0) {
      out.push(...write(text))
    }
    out.push(...flush())
    return out
  }

  function reset(): void {
    graphemeStreamer.reset()
    buffer = ''
    chunkIndex = 0
  }

  return {
    write,
    writeFlush,
    flush,
    reset,
    getChunkIndex() {
      return chunkIndex
    },
  }
}
