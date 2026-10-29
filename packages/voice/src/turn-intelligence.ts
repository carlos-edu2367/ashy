import type { EndJudgeDecision } from './turn-policy'

export interface HybridVoiceEndJudgeOptions {
  llmJudgeFn?: (transcript: string, signal: AbortSignal) => Promise<EndJudgeDecision | boolean>
  timeoutMs?: number
  minWordsForComplete?: number
}

export type VoiceEndJudgeFn = ((
  transcript: string,
  signal?: AbortSignal,
) => Promise<EndJudgeDecision>) & {
  evaluateHeuristic(transcript: string): EndJudgeDecision
}

export interface HybridSpeculativeRephraseOptions {
  llmRephraseFn?: (cleanedText: string, signal: AbortSignal) => Promise<string>
  timeoutMs?: number
}

export type SpeculativeRephraseFn = (rawText: string, signal?: AbortSignal) => Promise<string>

export interface WakeWordDetectionResult {
  detected: boolean
  matchedPhrase: string | null
  remainingText: string
}

export const DEFAULT_WAKE_WORD_PHRASES = [
  'ei ashy',
  'oi ashy',
  'hey ashy',
  'olá ashy',
  'ola ashy',
  'ashy',
] as const

const TRAILING_HESITATION_MULTIWORD_REGEX =
  /\b(?:deixa\s+eu\s+pensar|deixa\s+eu\s+ver|quer\s+dizer|olha\s+só|olha\s+so|pera\s+aí|pera\s+ai|espera\s+aí|espera\s+ai|vamos\s+ver|por\s+exemplo|ou\s+seja|isto\s+é|isto\s+e|let\s+me\s+think|you\s+know|i\s+mean|hold\s+on|wait\s+a\s+second)\s*[.,;:\-—…]*$/iu

const TRAILING_HESITATION_TOKEN_SET = new Set([
  // PT-BR conjunctions, prepositions, fillers & open connectors
  'mas',
  'então',
  'entao',
  'porque',
  'porquê',
  'como',
  'de',
  'do',
  'da',
  'dos',
  'das',
  'num',
  'numa',
  'no',
  'na',
  'nos',
  'nas',
  'para',
  'pra',
  'pro',
  'com',
  'sem',
  'que',
  'se',
  'ou',
  'nem',
  'e',
  'tipo',
  'hum',
  'hmm',
  'uh',
  'um',
  'uma',
  'eh',
  'é',
  'ah',
  'oh',
  'assim',
  'quando',
  'onde',
  'enquanto',
  'embora',
  'contudo',
  'porém',
  'porem',
  'todavia',
  'portanto',
  'logo',
  'pois',
  'sobre',
  'entre',
  'até',
  'ate',
  // EN conjunctions, prepositions & fillers
  'and',
  'but',
  'or',
  'so',
  'because',
  'like',
  'about',
  'for',
  'to',
  'with',
  'from',
  'into',
  'that',
  'which',
  'if',
  'when',
  'while',
  'uhm',
  'erm',
])

export function evaluateHeuristicVoiceEnd(
  rawTranscript: string,
  minWordsForComplete = 2,
): EndJudgeDecision {
  const trimmed = typeof rawTranscript === 'string' ? rawTranscript.trim() : ''
  if (trimmed.length === 0) {
    return { complete: false, reason: 'empty-transcript' }
  }

  // 1. Explicit trailing ellipses ("...", "..", "…") or trailing open punctuation (",", ":", ";", "-", "—")
  if (/(?:\.{2,}|…|[,;:\-—])\s*$/u.test(trimmed)) {
    return { complete: false, reason: 'trailing-hesitation' }
  }

  // 2. Multi-word trailing hesitation phrases ("deixa eu pensar", "quer dizer", etc.)
  if (TRAILING_HESITATION_MULTIWORD_REGEX.test(trimmed)) {
    return { complete: false, reason: 'trailing-hesitation' }
  }

  // Extract words stripped of edge punctuation
  const words = trimmed
    .replace(/[.!?…,;:\-—"'()[\]]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (words.length === 0) {
    return { complete: false, reason: 'empty-transcript' }
  }

  const lastWord = words[words.length - 1]!.toLowerCase()
  if (TRAILING_HESITATION_TOKEN_SET.has(lastWord)) {
    return { complete: false, reason: 'trailing-hesitation' }
  }

  // 3. Complete terminal sentence ending in single '.', '!', or '?'
  if (/[.!?]\s*$/u.test(trimmed) && words.length >= minWordsForComplete) {
    return { complete: true, reason: 'terminal-punctuation' }
  }

  // 4. Ambiguous unpunctuated clause fallback classification
  if (words.length >= Math.max(3, minWordsForComplete)) {
    return { complete: true, reason: 'heuristic-clause-complete' }
  }

  return { complete: false, reason: 'heuristic-short-fragment' }
}

export function createHybridVoiceEndJudge(
  options: HybridVoiceEndJudgeOptions = {},
): VoiceEndJudgeFn {
  const timeoutMs = Math.max(10, options.timeoutMs ?? 400)
  const minWordsForComplete = Math.max(1, options.minWordsForComplete ?? 2)

  const judgeFn = async (
    transcript: string,
    externalSignal?: AbortSignal,
  ): Promise<EndJudgeDecision> => {
    const heuristic = evaluateHeuristicVoiceEnd(transcript, minWordsForComplete)

    // Tier 1 (< 1ms): Immediate deterministic decision for empty, trailing hesitation, or terminal punctuation
    if (
      heuristic.reason === 'empty-transcript' ||
      heuristic.reason === 'trailing-hesitation' ||
      heuristic.reason === 'terminal-punctuation' ||
      !options.llmJudgeFn
    ) {
      return heuristic
    }

    if (externalSignal?.aborted) {
      return {
        complete: heuristic.complete,
        reason: 'heuristic-fallback-aborted',
      }
    }

    // Tier 2: Ambiguous clause without punctuation -> invoke fast LLM judge with 400ms timeout
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null

    const onExternalAbort = () => {
      controller.abort(externalSignal?.reason ?? new Error('VoiceEndJudge aborted'))
    }

    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      const timeoutPromise = new Promise<EndJudgeDecision>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new Error(`VoiceEndJudge LLM timeout after ${timeoutMs}ms`))
          resolve({
            complete: heuristic.complete,
            reason: 'heuristic-fallback-timeout',
          })
        }, timeoutMs)
      })

      const llmPromise = Promise.resolve()
        .then(() => options.llmJudgeFn!(transcript, controller.signal))
        .then((res): EndJudgeDecision => {
          if (typeof res === 'boolean') {
            return { complete: res, reason: 'llm-judge' }
          }
          if (res && typeof res.complete === 'boolean') {
            return {
              complete: res.complete,
              reason: res.reason ?? 'llm-judge',
            }
          }
          return {
            complete: heuristic.complete,
            reason: 'heuristic-fallback-invalid',
          }
        })
        .catch(
          (): EndJudgeDecision => ({
            complete: heuristic.complete,
            reason: 'heuristic-fallback-error',
          }),
        )

      return await Promise.race([llmPromise, timeoutPromise])
    } finally {
      if (timer !== null) {
        clearTimeout(timer)
      }
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort)
      }
    }
  }

  return Object.assign(judgeFn, {
    evaluateHeuristic: (transcript: string) =>
      evaluateHeuristicVoiceEnd(transcript, minWordsForComplete),
  })
}

export function cleanSpokenDisfluencies(rawText: string): string {
  if (typeof rawText !== 'string') {
    return ''
  }

  let text = rawText.trim()
  if (text.length === 0) {
    return ''
  }

  // 1. Strip leading vocalized pauses and repeated stutters at the start of the utterance
  // e.g. "hum, é... é... eu acho" -> "eu acho"
  let prev = ''
  while (prev !== text) {
    prev = text
    text = text
      .replace(/^(?:hum+|hmm+|uh+|um+|eh+|ah+|oh+)\s*(?:[,;:]|\.{2,}|…)?\s*/iu, '')
      .replace(/^(?:é|e)\s*(?:\.{2,}|…|[,;:])\s*/iu, '')
  }

  // 2. Collapse adjacent repeated single-word stutters separated by ellipses or spaces
  // e.g. "eu... eu acho" -> "eu acho", "o... o código" -> "o código"
  text = text.replace(/\b([\p{L}]{1,12})\s*(?:\.{2,}|…|,)?\s+\1\b/giu, '$1')

  // 3. Remove parenthetical spoken filler interjections (", tipo,", ", tipo...", ", hum,")
  text = text
    .replace(/,\s*(?:tipo|hum+|hmm+|eh+|uh+)\s*(?:,|\.{2,}|…)\s*/giu, ' ')
    .replace(/\b(?:hum+|hmm+|uh+|eh+)\s*(?:,|\.{2,}|…)\s*/giu, '')

  // 4. Clean mid-sentence hesitation ellipses between clauses ("num jeito de... resolver" -> "num jeito de resolver")
  text = text.replace(/(?:\.{2,}|…)\s+(?=[\p{L}\d])/gu, ' ')

  // 5. Normalize stray spacing around punctuation
  text = text
    .replace(/\s+,/g, ',')
    .replace(/,\s*,+/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim()

  return text
}

export function createHybridSpeculativeRephrase(
  options: HybridSpeculativeRephraseOptions = {},
): SpeculativeRephraseFn {
  const timeoutMs = Math.max(20, options.timeoutMs ?? 450)

  return async (rawText: string, signal?: AbortSignal): Promise<string> => {
    const cleaned = cleanSpokenDisfluencies(rawText)
    if (cleaned.length === 0 || !options.llmRephraseFn || signal?.aborted) {
      return cleaned
    }

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null

    const onExternalAbort = () => {
      controller.abort(signal?.reason ?? new Error('SpeculativeRephrase aborted'))
    }

    if (signal) {
      signal.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      const timeoutPromise = new Promise<string>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new Error(`SpeculativeRephrase timeout after ${timeoutMs}ms`))
          resolve(cleaned)
        }, timeoutMs)
      })

      const abortPromise = new Promise<string>((resolve) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            resolve(cleaned)
          },
          { once: true },
        )
      })

      const llmPromise = Promise.resolve()
        .then(() => options.llmRephraseFn!(cleaned, controller.signal))
        .then((res) => {
          if (controller.signal.aborted) {
            return cleaned
          }
          const trimmed = typeof res === 'string' ? res.trim() : ''
          return trimmed.length > 0 ? trimmed : cleaned
        })
        .catch(() => cleaned)

      return await Promise.race([llmPromise, timeoutPromise, abortPromise])
    } finally {
      if (timer !== null) {
        clearTimeout(timer)
      }
      if (signal) {
        signal.removeEventListener('abort', onExternalAbort)
      }
    }
  }
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function detectWakeWordInText(
  text: string,
  phrases: readonly string[] = DEFAULT_WAKE_WORD_PHRASES,
): WakeWordDetectionResult {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw.length === 0) {
    return {
      detected: false,
      matchedPhrase: null,
      remainingText: '',
    }
  }

  // Sort candidate phrases longest-first so "ei ashy" matches before "ashy"
  const candidates = [...phrases]
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length)

  for (const phrase of candidates) {
    const pattern = phrase
      .split(/\s+/)
      .map((token) => escapeRegExp(token))
      .join('\\s+')
    const regex = new RegExp(
      `(?:^|\\b)(${pattern})(?:\\b|\\s*[,!?.:;\\-—…]*)`,
      'iu',
    )
    const match = regex.exec(raw)
    if (match && match.index !== undefined) {
      const before = raw.slice(0, match.index).trim()
      const after = raw
        .slice(match.index + match[0].length)
        .replace(/^[,!?.:;\-—…\s]+/u, '')
        .trim()
      const remainingText = [before, after].filter(Boolean).join(' ').trim()
      return {
        detected: true,
        matchedPhrase: phrase,
        remainingText,
      }
    }
  }

  return {
    detected: false,
    matchedPhrase: null,
    remainingText: raw,
  }
}
