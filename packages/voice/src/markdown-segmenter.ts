import { CONTROL_SENTINEL } from '@ashy/llm'

export interface MarkdownSegmenterOptions {
  onSegment?: (segment: string) => void
}

export interface MarkdownSegmenter {
  write(chunk: string): string[]
  flush(): string[]
  reset(): void
}

const SENTENCE_TERMINATORS = new Set(['.', '!', '?', '。', '！', '？'])

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

/**
 * Cleans non-speakable Markdown formatting from a segment while strictly preserving
 * all occurrences and positions of `CONTROL_SENTINEL` (`\uE000`).
 */
export function cleanSpeakableMarkdown(raw: string): string {
  let text = raw

  // 1. Strip fenced code block delimiters ```lang ... ``` while preserving content/sentinels
  text = text.replace(/```[a-zA-Z0-9_-]*\r?\n?([\s\S]*?)```/g, (_match, inner: string) => {
    const sentinels = inner.match(new RegExp(CONTROL_SENTINEL, 'g'))?.join('') ?? ''
    const cleanedInner = inner.replace(new RegExp(CONTROL_SENTINEL, 'g'), '').trim()
    return sentinels + (cleanedInner.length > 0 ? ` ${cleanedInner} ` : '')
  })

  // 2. Replace Markdown images ![alt](url) -> alt and links [label](url) -> label
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

  // 3. Unwrap inline code `code` -> code
  text = text.replace(/`([^`]+)`/g, '$1')

  // 4. Unwrap display math $$...$$ and inline math $...$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, '$1')
  text = text.replace(/\$([^$]+)\$/g, '$1')

  // 5. Unwrap bold, italic, strikethrough (**bold**, __bold__, *italic*, ~~strike~~)
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  text = text.replace(/~~([^~]+)~~/g, '$1')
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1$2')

  // 6. Strip heading prefixes (#, ##, ###) and blockquote prefixes (>)
  text = text.replace(/(^|\n)\s*#{1,6}\s+/g, '$1')
  text = text.replace(/(^|\n)\s*>\s+/g, '$1')

  // 7. Collapse whitespace while preserving CONTROL_SENTINEL at exact boundaries
  text = text.replace(/[ \t\r\n]+/g, ' ').trim()

  return text
}

/**
 * Streaming Markdown sentence segmenter.
 * Only closes a segment when it encounters a sentence boundary (`.!?。！？\n`)
 * OUTSIDE of:
 * - Code fences (``` ... ```)
 * - Inline code (` ... `)
 * - Markdown links (`[label](url)`)
 * - Math blocks (`$...$`, `$$...$$`)
 * And never splits in the middle of decimal numbers (`3.14`) or ellipses (`...`).
 */
export function createMarkdownSegmenter(
  options: MarkdownSegmenterOptions = {},
): MarkdownSegmenter {
  let rawBuffer = ''

  function findSafeSplitIndex(buf: string, isFlushing: boolean): number {
    let inCodeFence = false
    let inInlineCode = false
    let inMathBlock = false
    let inInlineMath = false
    let bracketDepth = 0
    let inLinkParens = false
    let parenDepth = 0
    let justClosedCodeFence = false

    let i = 0
    const len = buf.length

    while (i < len) {
      const ch = buf[i]!

      // 1. Check for code fence ```
      if (!inInlineCode && !inMathBlock && !inInlineMath) {
        if (buf.startsWith('```', i)) {
          inCodeFence = !inCodeFence
          justClosedCodeFence = !inCodeFence
          i += 3
          continue
        }
        // If at the tail of the stream we have 1 or 2 backticks that might become ```
        if (!isFlushing && (buf.slice(i) === '`' || buf.slice(i) === '``')) {
          return -1
        }
      }

      if (inCodeFence) {
        i += 1
        continue
      }

      // 2. Check for inline code `
      if (!inMathBlock && !inInlineMath && ch === '`') {
        inInlineCode = !inInlineCode
        i += 1
        continue
      }

      if (inInlineCode) {
        i += 1
        continue
      }

      // 3. Check for math blocks $$ or $
      if (ch === '$') {
        if (buf.startsWith('$$', i)) {
          if (!inInlineMath) {
            inMathBlock = !inMathBlock
            i += 2
            continue
          }
        } else if (!isFlushing && i === len - 1) {
          // Hold trailing '$' in case next char is '$'
          return -1
        } else if (!inMathBlock) {
          inInlineMath = !inInlineMath
          i += 1
          continue
        }
      }

      if (inMathBlock || inInlineMath) {
        i += 1
        continue
      }

      // 4. Track Markdown links [label](url)
      if (!inLinkParens) {
        if (ch === '[') {
          bracketDepth += 1
          i += 1
          continue
        }
        if (ch === ']' && bracketDepth > 0) {
          bracketDepth -= 1
          if (bracketDepth === 0) {
            // Need 1 character of lookahead to know if '(' follows ']'
            if (i + 1 >= len) {
              return isFlushing ? -1 : -1
            }
            if (buf[i + 1] === '(') {
              inLinkParens = true
              parenDepth = 1
              i += 2
              continue
            }
          }
          i += 1
          continue
        }
      } else {
        if (ch === '(') {
          parenDepth += 1
        } else if (ch === ')') {
          parenDepth -= 1
          if (parenDepth <= 0) {
            inLinkParens = false
            parenDepth = 0
          }
        }
        i += 1
        continue
      }

      if (bracketDepth > 0 || inLinkParens) {
        i += 1
        continue
      }

      // 5. Outside all protected constructs: check sentence terminators
      if (ch === '\n') {
        if (justClosedCodeFence) {
          justClosedCodeFence = false
          i += 1
          continue
        }

        // Look ahead up to 3 chars after newline to see if a code fence ``` starts on the next line
        const afterNewline = buf.slice(i + 1)
        const trimmedAfter = afterNewline.replace(/^[ \t\r]+/, '')
        if (!isFlushing && trimmedAfter.length < 3 && '```'.startsWith(trimmedAfter)) {
          return -1
        }
        if (trimmedAfter.startsWith('```')) {
          i += 1
          continue
        }

        // Check if there is actual speakable text before this newline
        const prefix = buf.slice(0, i).trim()
        if (prefix.length > 0 && !prefix.endsWith(':')) {
          return i + 1
        }
        i += 1
        continue
      }

      if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
        justClosedCodeFence = false
      }

      if (SENTENCE_TERMINATORS.has(ch)) {
        // Need at least 1 character lookahead when not flushing
        if (!isFlushing && i + 1 >= len) {
          return -1
        }

        const prevChar = i > 0 ? buf[i - 1] : undefined
        const nextChar = i + 1 < len ? buf[i + 1] : undefined

        // Never split decimal numbers like 3.14
        if (ch === '.' && isDigit(prevChar) && isDigit(nextChar)) {
          i += 1
          continue
        }

        // Never split in the middle of consecutive punctuation (e.g. "..." or "!?")
        if (nextChar !== undefined && SENTENCE_TERMINATORS.has(nextChar)) {
          i += 1
          continue
        }

        return i + 1
      }

      i += 1
    }

    return -1
  }

  function drain(isFlushing: boolean): string[] {
    const emitted: string[] = []

    while (rawBuffer.length > 0) {
      const splitIdx = findSafeSplitIndex(rawBuffer, isFlushing)
      if (splitIdx === -1) {
        break
      }

      const rawSlice = rawBuffer.slice(0, splitIdx)
      rawBuffer = rawBuffer.slice(splitIdx)

      const cleaned = cleanSpeakableMarkdown(rawSlice)
      if (cleaned.length > 0) {
        emitted.push(cleaned)
        options.onSegment?.(cleaned)
      }
    }

    if (isFlushing && rawBuffer.length > 0) {
      const cleaned = cleanSpeakableMarkdown(rawBuffer)
      rawBuffer = ''
      if (cleaned.length > 0) {
        emitted.push(cleaned)
        options.onSegment?.(cleaned)
      }
    }

    return emitted
  }

  return {
    write(chunk: string): string[] {
      if (typeof chunk !== 'string' || chunk.length === 0) {
        return []
      }
      rawBuffer += chunk
      return drain(false)
    },
    flush(): string[] {
      return drain(true)
    },
    reset(): void {
      rawBuffer = ''
    },
  }
}
