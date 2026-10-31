import * as v from 'valibot'
import { AshyEmotionSchema, type AshyEmotion } from '@ashy/shared'

export const CONTROL_SENTINEL = '\uE000'

export type AshyStageSignal =
  | {
      type: 'act'
      emotion?: AshyEmotion
      intensity?: number
      motion?: string
      durationSec?: number
      raw: string
    }
  | {
      type: 'delay'
      seconds: number
      raw: string
    }
  | {
      type: 'callback'
      motifId: string
      raw: string
    }
  | {
      type: 'unknown'
      raw: string
    }

export interface TailSafeMarkerParserCallbacks {
  onLiteral: (text: string) => void
  onSpecial: (signal: AshyStageSignal) => void
}

export interface TailSafeMarkerParser {
  write(chunk: string): void
  feed(chunk: string): void
  flush(): void
  reset(): void
}

const OPEN_STD = '<|'
const CLOSE_STD = '|>'
const OPEN_ESC = "<{'|'}"
const CLOSE_ESC = "{'|'}>"

export const MAX_OPEN_LEN = Math.max(OPEN_STD.length, OPEN_ESC.length) // 6
export const TAIL_HOLD = MAX_OPEN_LEN - 1 // 5

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function stripOuterDelimiters(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith(OPEN_STD) && trimmed.endsWith(CLOSE_STD)) {
    return trimmed.slice(OPEN_STD.length, -CLOSE_STD.length).trim()
  }
  if (trimmed.startsWith(OPEN_ESC) && trimmed.endsWith(CLOSE_ESC)) {
    return trimmed.slice(OPEN_ESC.length, -CLOSE_ESC.length).trim()
  }
  if (trimmed.startsWith(OPEN_STD) && trimmed.endsWith('>')) {
    return trimmed.slice(OPEN_STD.length, -1).trim()
  }
  if (trimmed.startsWith(OPEN_ESC) && trimmed.endsWith('>')) {
    return trimmed.slice(OPEN_ESC.length, -1).trim()
  }
  return trimmed
}

export function stripResidualStageMarkers(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  let literalAccum = ''
  const parser = createTailSafeMarkerParser({
    onLiteral(chunk) {
      literalAccum += chunk
    },
    onSpecial() {
      // Discard parsed stage markers
    },
  })
  parser.write(raw)
  parser.flush()
  return literalAccum
    .replace(/<\|[\s\S]*?(?:\|>|\}>|>)/g, '')
    .replace(/<\{'\|'\}[\s\S]*?(?:\{'\|'\}>|\}>|>)/g, '')
    .trim()
}

/**
 * Parses standard JSON or mildly malformed LLM JSON (single quotes, trailing commas, unquoted identifiers).
 */
function parseLenientJsonObject(rawJson: string): Record<string, unknown> | null {
  const trimmed = rawJson.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null
  }

  try {
    const direct = JSON.parse(trimmed)
    if (typeof direct === 'object' && direct !== null && !Array.isArray(direct)) {
      return direct as Record<string, unknown>
    }
  } catch {
    // Fallback to lenient normalization below
  }

  try {
    const repaired = trimmed
      // Convert single-quoted strings to double-quoted strings
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, inner: string) => {
        return `"${inner.replace(/"/g, '\\"')}"`
      })
      // Quote unquoted object keys: { emotion: "smug", intensity: 0.9 }
      .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
      // Remove trailing commas before } or ]
      .replace(/,\s*([}\]])/g, '$1')

    const parsed = JSON.parse(repaired)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return null
  }

  return null
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

/**
 * Parses a stage marker payload such as:
 * - `<|ACT {"emotion":"smug","intensity":0.9,"motion":"tease"}|>`
 * - `<|ACT {"emotion":{"name":"smug","intensity":0.9}}|>`
 * - `<|DELAY 1.5|>` or `<|DELAY:1.5|>`
 * - `<|CALLBACK motif_id|>` or `<|CALLBACK:motif_id|>`
 */
export function parseStageSignal(rawTagContent: string): AshyStageSignal {
  const raw = typeof rawTagContent === 'string' ? rawTagContent : String(rawTagContent ?? '')
  const body = stripOuterDelimiters(raw)
  if (body.length === 0) {
    return { type: 'unknown', raw }
  }

  const headMatch = /^([A-Za-z_]+)(?:[\s:]+([\s\S]*))?$/.exec(body)
  if (!headMatch) {
    return { type: 'unknown', raw }
  }

  const command = headMatch[1]!.toUpperCase()
  const rest = (headMatch[2] ?? '').trim()

  if (command === 'ACT') {
    const payload = parseLenientJsonObject(rest)
    if (!payload) {
      return { type: 'unknown', raw }
    }

    let rawEmotion: unknown = payload.emotion
    let rawIntensity: unknown = payload.intensity

    if (typeof rawEmotion === 'object' && rawEmotion !== null && !Array.isArray(rawEmotion)) {
      const nested = rawEmotion as Record<string, unknown>
      rawEmotion = nested.name ?? nested.emotion
      if (rawIntensity === undefined && nested.intensity !== undefined) {
        rawIntensity = nested.intensity
      }
    }

    const EMOTION_SYNONYM_MAP: Readonly<Record<string, AshyEmotion>> = {
      warm: 'happy',
      joy: 'happy',
      smile: 'happy',
      thinking: 'think',
      thoughtful: 'think',
      playful: 'tease',
      teasing: 'tease',
      calm: 'neutral',
    }

    let validEmotion: AshyEmotion | undefined
    if (typeof rawEmotion === 'string') {
      const candidate = rawEmotion.trim().toLowerCase()
      const parsedEmotion = v.safeParse(AshyEmotionSchema, candidate)
      if (parsedEmotion.success) {
        validEmotion = parsedEmotion.output
      } else if (EMOTION_SYNONYM_MAP[candidate]) {
        validEmotion = EMOTION_SYNONYM_MAP[candidate]
      }
    }

    let validIntensity: number | undefined
    const numericIntensity = toFiniteNumber(rawIntensity)
    if (numericIntensity !== undefined) {
      validIntensity = clamp(numericIntensity, 0, 1)
    }

    let validMotion: string | undefined
    if (typeof payload.motion === 'string') {
      const cleaned = payload.motion.replace(/[\u0000-\u001F<>]/g, '').trim()
      if (cleaned.length > 0) {
        validMotion = cleaned.slice(0, 64)
      }
    }

    let validDurationSec: number | undefined
    const numericDuration = toFiniteNumber(payload.durationSec)
    if (numericDuration !== undefined) {
      validDurationSec = clamp(numericDuration, 0, 60)
    }

    if (
      validEmotion === undefined &&
      validMotion === undefined &&
      validDurationSec === undefined
    ) {
      return { type: 'unknown', raw }
    }

    const result: Extract<AshyStageSignal, { type: 'act' }> = {
      type: 'act',
      raw,
    }
    if (validEmotion !== undefined) result.emotion = validEmotion
    if (validIntensity !== undefined) result.intensity = validIntensity
    if (validMotion !== undefined) result.motion = validMotion
    if (validDurationSec !== undefined) result.durationSec = validDurationSec
    return result
  }

  if (command === 'DELAY') {
    let numericSeconds: number | undefined
    if (rest.startsWith('{')) {
      const obj = parseLenientJsonObject(rest)
      numericSeconds = toFiniteNumber(obj?.seconds ?? obj?.delay)
    } else {
      numericSeconds = toFiniteNumber(rest)
    }

    if (numericSeconds === undefined) {
      return { type: 'unknown', raw }
    }

    return {
      type: 'delay',
      seconds: clamp(numericSeconds, 0, 10),
      raw,
    }
  }

  if (command === 'CALLBACK') {
    let motifId = ''
    if (rest.startsWith('{')) {
      const obj = parseLenientJsonObject(rest)
      const candidate = obj?.motifId ?? obj?.motif_id ?? obj?.id
      if (typeof candidate === 'string') {
        motifId = candidate.trim()
      }
    } else {
      motifId = rest.replace(/^['"]|['"]$/g, '').trim()
    }

    if (motifId.length === 0) {
      return { type: 'unknown', raw }
    }

    return {
      type: 'callback',
      motifId,
      raw,
    }
  }

  return { type: 'unknown', raw }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function findNextOpener(buffer: string): { index: number; opener: typeof OPEN_STD | typeof OPEN_ESC } | null {
  const stdIdx = buffer.indexOf(OPEN_STD)
  const escIdx = buffer.indexOf(OPEN_ESC)

  if (stdIdx === -1 && escIdx === -1) {
    return null
  }
  if (stdIdx !== -1 && (escIdx === -1 || stdIdx <= escIdx)) {
    return { index: stdIdx, opener: OPEN_STD }
  }
  return { index: escIdx, opener: OPEN_ESC }
}

function findLenientTagCloserIndex(buffer: string, bodyStart: number): number {
  const body = buffer.slice(bodyStart)
  const cmdMatch = /^\s*(ACT|DELAY|CALLBACK)(?:[\s:]+|$)/i.exec(body)
  if (!cmdMatch) {
    return -1
  }

  const command = cmdMatch[1]!.toUpperCase()
  const argStartInBuffer = bodyStart + cmdMatch[0].length

  if (command === 'ACT' || buffer.slice(argStartInBuffer).trimStart().startsWith('{')) {
    const firstBraceIdx = buffer.indexOf('{', argStartInBuffer)
    if (firstBraceIdx === -1) {
      return -1
    }

    let depth = 0
    let inSingleQuote = false
    let inDoubleQuote = false
    let escaped = false
    let balancedEndIdx = -1

    for (let i = firstBraceIdx; i < buffer.length; i++) {
      const ch = buffer[i]!
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\' && (inSingleQuote || inDoubleQuote)) {
        escaped = true
        continue
      }
      if (ch === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote
        continue
      }
      if (ch === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote
        continue
      }
      if (inSingleQuote || inDoubleQuote) {
        continue
      }
      if (ch === '{') {
        depth += 1
      } else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          balancedEndIdx = i
          break
        }
      }
    }

    if (balancedEndIdx === -1) {
      return -1
    }

    let afterIdx = balancedEndIdx + 1
    while (afterIdx < buffer.length && (buffer[afterIdx] === ' ' || buffer[afterIdx] === '\t')) {
      afterIdx += 1
    }

    if (afterIdx < buffer.length && buffer[afterIdx] === '>') {
      return afterIdx
    }
    return -1
  }

  if (argStartInBuffer >= buffer.length) {
    return -1
  }
  const gtIdx = buffer.indexOf('>', argStartInBuffer)
  if (gtIdx === -1) {
    return -1
  }
  if (buffer[gtIdx - 1] === '|' || buffer.slice(0, gtIdx + 1).endsWith(CLOSE_ESC)) {
    return -1
  }
  return gtIdx
}

function findTagCloser(
  buffer: string,
  activeOpener: typeof OPEN_STD | typeof OPEN_ESC,
): { index: number; length: number } | null {
  const expectedCloser = activeOpener === OPEN_STD ? CLOSE_STD : CLOSE_ESC
  const stdCloseIdx = buffer.indexOf(expectedCloser, activeOpener.length)
  let bestMatch: { index: number; length: number } | null =
    stdCloseIdx !== -1 ? { index: stdCloseIdx, length: expectedCloser.length } : null

  const lenientIdx = findLenientTagCloserIndex(buffer, activeOpener.length)
  if (lenientIdx !== -1 && (bestMatch === null || lenientIdx < bestMatch.index)) {
    bestMatch = { index: lenientIdx, length: 1 }
  }

  return bestMatch
}

/**
 * Tail-safe streaming marker parser for `<|...|>` and `<{'|'}...{'|'}>`.
 * Always retains `tailHold = MAX_OPEN_LEN - 1` characters when outside a marker tag
 * so partial tag prefixes (`<`, `<{'`, `<{'|'`) across chunk boundaries never leak into literal output.
 * Truncated/unclosed tags at `flush()` are safely discarded.
 */
export function createTailSafeMarkerParser(
  callbacks: TailSafeMarkerParserCallbacks,
): TailSafeMarkerParser {
  let buffer = ''
  let activeOpener: typeof OPEN_STD | typeof OPEN_ESC | null = null

  function emitLiteralSafe(text: string): void {
    if (text.length > 0) {
      callbacks.onLiteral(text)
    }
  }

  function drain(): void {
    while (buffer.length > 0) {
      if (activeOpener === null) {
        const match = findNextOpener(buffer)
        if (match !== null) {
          if (match.index > 0) {
            emitLiteralSafe(buffer.slice(0, match.index))
            buffer = buffer.slice(match.index)
          }
          activeOpener = match.opener
          continue
        }

        // No complete opener in buffer: retain at least TAIL_HOLD characters at the tail
        if (buffer.length <= TAIL_HOLD) {
          return
        }

        let emitEnd = buffer.length - TAIL_HOLD
        if (emitEnd > 0 && isHighSurrogate(buffer.charCodeAt(emitEnd - 1))) {
          emitEnd -= 1
        }
        if (emitEnd <= 0) {
          return
        }

        emitLiteralSafe(buffer.slice(0, emitEnd))
        buffer = buffer.slice(emitEnd)
        return
      } else {
        const closeMatch = findTagCloser(buffer, activeOpener)

        // Check if another opener appears inside the buffer before the closer (meaning the previous opener was stray literal text)
        const nextOpenerAfterActive = findNextOpener(buffer.slice(activeOpener.length))
        if (
          nextOpenerAfterActive !== null &&
          (closeMatch === null || activeOpener.length + nextOpenerAfterActive.index < closeMatch.index)
        ) {
          const strayLiteralEnd = activeOpener.length + nextOpenerAfterActive.index
          emitLiteralSafe(buffer.slice(0, strayLiteralEnd))
          buffer = buffer.slice(strayLiteralEnd)
          activeOpener = nextOpenerAfterActive.opener
          continue
        }

        if (closeMatch === null) {
          // Guard against unbounded memory growth on adversarial streams with a runaway opener
          if (buffer.length > 512) {
            const fallbackGtIdx = buffer.indexOf('>', activeOpener.length)
            if (fallbackGtIdx !== -1) {
              const fullTag = buffer.slice(0, fallbackGtIdx + 1)
              buffer = buffer.slice(fallbackGtIdx + 1)
              activeOpener = null
              callbacks.onSpecial(parseStageSignal(fullTag))
              continue
            }
            buffer = ''
            activeOpener = null
          }
          return
        }

        const fullTag = buffer.slice(0, closeMatch.index + closeMatch.length)
        buffer = buffer.slice(closeMatch.index + closeMatch.length)
        activeOpener = null

        const signal = parseStageSignal(fullTag)
        callbacks.onSpecial(signal)
      }
    }
  }

  function write(chunk: string): void {
    if (typeof chunk !== 'string' || chunk.length === 0) {
      return
    }
    buffer += chunk
    drain()
  }

  function flush(): void {
    drain()

    if (activeOpener !== null) {
      const fallbackGtIdx = buffer.indexOf('>', activeOpener.length)
      if (fallbackGtIdx !== -1) {
        const fullTag = buffer.slice(0, fallbackGtIdx + 1)
        const remainder = buffer.slice(fallbackGtIdx + 1)
        buffer = ''
        activeOpener = null
        const signal = parseStageSignal(fullTag)
        callbacks.onSpecial(signal)
        if (remainder.length > 0) {
          write(remainder)
          flush()
        }
        return
      }
      // Truncated tag at end of stream: discard without leaking to TTS
      buffer = ''
      activeOpener = null
      return
    }

    if (buffer.length > 0) {
      // Also guard against a partial opener prefix truncated at the very end of the stream (e.g. `<{'|'`)
      const trailingPartialIdx = findTrailingPartialOpenerIndex(buffer)
      const safeLiteral = trailingPartialIdx === -1 ? buffer : buffer.slice(0, trailingPartialIdx)
      buffer = ''
      emitLiteralSafe(safeLiteral)
    }
  }

  function reset(): void {
    buffer = ''
    activeOpener = null
  }

  return {
    write,
    feed: write,
    flush,
    reset,
  }
}

function findTrailingPartialOpenerIndex(text: string): number {
  for (let i = Math.max(0, text.length - TAIL_HOLD); i < text.length; i++) {
    const suffix = text.slice(i)
    if (
      (OPEN_ESC.startsWith(suffix) && suffix.length >= 2) ||
      suffix === '<|'
    ) {
      return i
    }
  }
  return -1
}
