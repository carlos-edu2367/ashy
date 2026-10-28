export interface GraphemeStreamer {
  write(chunk: string): string[]
  flush(): string[]
  reset(): void
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * Incremental UTF-16 / UTF-8 grapheme cluster streamer inspired by `clustr` (`moeru-ai`).
 * Uses `Intl.Segmenter(undefined, { granularity: 'grapheme' })` and always holds back
 * at least the final grapheme cluster (plus any trailing lone high surrogate)
 * until the next `write()` or `flush()` so compound ZWJ emojis (`👩‍💻`), skin-tone
 * modifiers (`👩🏽‍💻`), regional indicator flags (`🇧🇷`), and combining diacritics are
 * never torn across streaming chunks.
 */
export function createGraphemeStreamer(locale?: string): GraphemeStreamer {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'grapheme' })
  let buffer = ''

  return {
    write(chunk: string): string[] {
      if (typeof chunk !== 'string' || chunk.length === 0) {
        return []
      }

      buffer += chunk

      // If the buffer ends with a lone high surrogate, do not segment the lone surrogate yet;
      // hold back both the last complete grapheme cluster in safeSlice and the trailing high surrogate
      // in case the completed code point attaches to the preceding cluster (e.g. skin tone modifier or flag).
      if (isHighSurrogate(buffer.charCodeAt(buffer.length - 1))) {
        const safeSlice = buffer.slice(0, -1)
        const trailingHigh = buffer.slice(-1)
        if (safeSlice.length === 0) {
          return []
        }
        const segments = Array.from(segmenter.segment(safeSlice), (s) => s.segment)
        if (segments.length === 0) {
          return []
        }
        const lastCluster = segments[segments.length - 1]!
        const emitted = segments.slice(0, -1)
        buffer = lastCluster + trailingHigh
        return emitted
      }

      const segments = Array.from(segmenter.segment(buffer), (s) => s.segment)
      if (segments.length <= 1) {
        return []
      }

      const emitted = segments.slice(0, -1)
      buffer = segments[segments.length - 1]!
      return emitted
    },

    flush(): string[] {
      if (buffer.length === 0) {
        return []
      }
      const segments = Array.from(segmenter.segment(buffer), (s) => s.segment)
      buffer = ''
      return segments
    },

    reset(): void {
      buffer = ''
    },
  }
}
