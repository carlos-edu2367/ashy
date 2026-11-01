/**
 * Phase 10.1 — runaway-speech watchdog (spec §4 conclusion 4, §8.1 step 5).
 * The spike once produced 322 s of degenerate speech for a short text answer; this is mandatory.
 */

export interface RunawayWatchdogOptions {
  /** Speaking rate used to estimate audio duration from text. */
  charsPerSec: number
  /** Audio may run up to `factor ×` the text estimate… */
  factor: number
  /** …but never less than this floor (text lags audio at the start of a response). */
  minBudgetMs: number
  /** Hard cap per response. */
  maxAudioMs: number
  /** Same character repeated this many times in a row (vowel). */
  vowelRunLength: number
  /** Same character (any) repeated this many times in a row. */
  charRunLength: number
  /** Same word n-gram repeated consecutively this many times. */
  ngramRepeats: number
}

export const DEFAULT_RUNAWAY_WATCHDOG_OPTIONS: RunawayWatchdogOptions = {
  charsPerSec: 14,
  factor: 3,
  minBudgetMs: 4000,
  maxAudioMs: 45000,
  vowelRunLength: 8,
  charRunLength: 20,
  ngramRepeats: 4,
}

export type RunawayVerdict =
  | { runaway: false }
  | { runaway: true; kind: 'audio_budget' | 'audio_cap' | 'repetition' | 'vowel_run'; detail: string }

export function estimateSpeechMs(textLength: number, charsPerSec = DEFAULT_RUNAWAY_WATCHDOG_OPTIONS.charsPerSec): number {
  return (Math.max(0, textLength) / charsPerSec) * 1000
}

export function audioBudgetMs(textLength: number, opts: RunawayWatchdogOptions = DEFAULT_RUNAWAY_WATCHDOG_OPTIONS): number {
  return Math.min(opts.maxAudioMs, Math.max(opts.factor * estimateSpeechMs(textLength, opts.charsPerSec), opts.minBudgetMs))
}

const VOWELS = 'aeiouáéíóúâêôãõày'

/** Detects degenerate text: sustained vowel / char runs or consecutive repeated word n-grams. */
export function detectDegenerateText(
  text: string,
  opts: RunawayWatchdogOptions = DEFAULT_RUNAWAY_WATCHDOG_OPTIONS,
): RunawayVerdict {
  const lower = text.toLowerCase()
  let runChar = ''
  let runLen = 0
  for (const ch of lower) {
    if (ch === runChar) {
      runLen += 1
    } else {
      runChar = ch
      runLen = 1
    }
    if (/\s/.test(ch)) continue
    if (VOWELS.includes(ch) && runLen >= opts.vowelRunLength) {
      return { runaway: true, kind: 'vowel_run', detail: `vowel "${ch}" ×${runLen}` }
    }
    if (runLen >= opts.charRunLength) {
      return { runaway: true, kind: 'vowel_run', detail: `char "${ch}" ×${runLen}` }
    }
  }

  const words = lower.split(/[^\p{L}\p{N}']+/u).filter(Boolean)
  const tail = words.slice(-80)
  for (let n = 1; n <= 4; n++) {
    const needed = n === 1 ? opts.ngramRepeats + 2 : opts.ngramRepeats
    if (tail.length < n * needed) continue
    for (let start = 0; start + n * needed <= tail.length; start++) {
      const gram = tail.slice(start, start + n).join(' ')
      let reps = 1
      let pos = start + n
      while (pos + n <= tail.length && tail.slice(pos, pos + n).join(' ') === gram) {
        reps += 1
        pos += n
      }
      if (reps >= needed) {
        return { runaway: true, kind: 'repetition', detail: `"${gram}" ×${reps}` }
      }
    }
  }
  return { runaway: false }
}

export function checkRunaway(
  input: { audioMs: number; text: string },
  opts: RunawayWatchdogOptions = DEFAULT_RUNAWAY_WATCHDOG_OPTIONS,
): RunawayVerdict {
  if (input.audioMs > opts.maxAudioMs) {
    return { runaway: true, kind: 'audio_cap', detail: `audio ${Math.round(input.audioMs)} ms > ${opts.maxAudioMs} ms` }
  }
  const budget = audioBudgetMs(input.text.length, opts)
  if (input.audioMs > budget) {
    return {
      runaway: true,
      kind: 'audio_budget',
      detail: `audio ${Math.round(input.audioMs)} ms > budget ${Math.round(budget)} ms for ${input.text.length} chars`,
    }
  }
  return detectDegenerateText(input.text, opts)
}
