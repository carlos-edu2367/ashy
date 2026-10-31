export interface SpeechActivityTrackerOptions {
  onsetThreshold?: number
  sustainRatio?: number
  minSpeechMs?: number
}

export type SpeechActivityAction = 'idle' | 'start' | 'sustain' | 'pause' | 'cancel'

export interface SpeechActivityStepResult {
  action: SpeechActivityAction
  reason?: 'too-short' | 'speech-end' | 'wake-word-speech-end'
  isSpeaking: boolean
  speechMs: number
  silenceMs: number
  openedByWakeWord: boolean
}

export interface SpeechActivityTracker {
  processFrame(speechProbability: number, durationMs?: number): SpeechActivityStepResult
  openWithWakeWord(): void
  openByWakeWord(): void
  reset(): void
  getState(): {
    isSpeaking: boolean
    speechMs: number
    silenceMs: number
    openedByWakeWord: boolean
    onsetThreshold: number
    sustainThreshold: number
    minSpeechMs: number
  }
}

export function createSpeechActivityTracker(
  options: SpeechActivityTrackerOptions = {},
): SpeechActivityTracker {
  const onsetThreshold = options.onsetThreshold ?? 0.6
  const sustainRatio = options.sustainRatio ?? 0.3
  const sustainThreshold = Number((onsetThreshold * sustainRatio).toFixed(6))
  const minSpeechMs = options.minSpeechMs ?? 300

  let isSpeaking = false
  let speechMs = 0
  let silenceMs = 0
  let openedByWakeWord = false

  function openWithWakeWord(): void {
    isSpeaking = true
    openedByWakeWord = true
    silenceMs = 0
  }

  function reset(): void {
    isSpeaking = false
    speechMs = 0
    silenceMs = 0
    openedByWakeWord = false
  }

  function processFrame(speechProbability: number, durationMs = 32): SpeechActivityStepResult {
    const prob = Number.isFinite(speechProbability) ? speechProbability : 0
    const dt = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0)

    if (!isSpeaking) {
      if (prob >= onsetThreshold) {
        isSpeaking = true
        speechMs += dt
        silenceMs = 0
        return {
          action: 'start',
          isSpeaking: true,
          speechMs,
          silenceMs,
          openedByWakeWord,
        }
      }

      silenceMs += dt
      return {
        action: 'idle',
        isSpeaking: false,
        speechMs,
        silenceMs,
        openedByWakeWord,
      }
    }

    // Currently in speaking state: apply hysteresis using sustainThreshold (0.18)
    if (prob >= sustainThreshold) {
      speechMs += dt
      silenceMs = 0
      return {
        action: 'sustain',
        isSpeaking: true,
        speechMs,
        silenceMs,
        openedByWakeWord,
      }
    }

    // Dropped below sustainThreshold
    isSpeaking = false
    silenceMs += dt

    if (speechMs < minSpeechMs && !openedByWakeWord) {
      const accumulatedSpeechMs = speechMs
      speechMs = 0
      openedByWakeWord = false
      return {
        action: 'cancel',
        reason: 'too-short',
        isSpeaking: false,
        speechMs: accumulatedSpeechMs,
        silenceMs,
        openedByWakeWord: false,
      }
    }

    const wasWakeWord = openedByWakeWord
    return {
      action: 'pause',
      reason: wasWakeWord ? 'wake-word-speech-end' : 'speech-end',
      isSpeaking: false,
      speechMs,
      silenceMs,
      openedByWakeWord: wasWakeWord,
    }
  }

  return {
    processFrame,
    openWithWakeWord,
    openByWakeWord: openWithWakeWord,
    reset,
    getState() {
      return {
        isSpeaking,
        speechMs,
        silenceMs,
        openedByWakeWord,
        onsetThreshold,
        sustainThreshold,
        minSpeechMs,
      }
    },
  }
}

export interface TurnRevisionSnapshot {
  rawRev: number
  speakerRev: number
  contextRev: number
}

export interface EndJudgeDecision {
  complete: boolean
  reason?: string
}

export interface SealedVoiceTurn {
  rawText: string
  rephrasedText: string
  reason: 'end-judged' | 'grace-timeout' | 'manual'
  revisions: TurnRevisionSnapshot
  reusedSpeculativeRephrase: boolean
  silenceMs: number
}

export interface VoiceTurnAdvanceOutcome {
  sealed: boolean
  casRejected: boolean
  result?: SealedVoiceTurn
}

export interface VoiceTurnControllerOptions {
  speculateAfterMs?: number
  pauseMs?: number
  graceMs?: number
  rephraseFn: (rawText: string, signal: AbortSignal) => Promise<string>
  endJudgeFn: (transcript: string, signal: AbortSignal) => Promise<EndJudgeDecision>
  onTurnSealed?: (result: SealedVoiceTurn) => void
}

export interface VoiceTurnControllerState {
  status: 'idle' | 'speaking' | 'judging' | 'grace' | 'sealed'
  rawText: string
  silenceMs: number
  stableTextMs: number
  inGracePeriod: boolean
  revisions: TurnRevisionSnapshot
  casRejectedCount: number
  hasSpeculativeRephrase: boolean
  sealedResult?: SealedVoiceTurn
}

export interface VoiceTurnController {
  updateTranscript(rawText: string): void
  bumpSpeakerRevision(): void
  bumpContextRevision(): void
  isCurrent(snapshot: TurnRevisionSnapshot): boolean
  advanceSilence(deltaMs: number): Promise<VoiceTurnAdvanceOutcome>
  sealTurn(reason?: SealedVoiceTurn['reason']): Promise<SealedVoiceTurn>
  reset(): void
  getState(): VoiceTurnControllerState
}

interface SpeculativeRephraseEntry {
  rawRev: number
  rawText: string
  promise: Promise<string>
  abortController: AbortController
}

export function createVoiceTurnController(
  options: VoiceTurnControllerOptions,
): VoiceTurnController {
  const speculateAfterMs = Math.max(0, options.speculateAfterMs ?? 600)
  const pauseMs = Math.max(1, options.pauseMs ?? 1200)
  const graceMs = Math.max(0, options.graceMs ?? 3000)
  const totalGraceTimeoutMs = pauseMs + graceMs

  let rawRev = 0
  let speakerRev = 0
  let contextRev = 0

  let rawText = ''
  let silenceMs = 0
  let stableTextMs = 0
  let inGracePeriod = false
  let status: VoiceTurnControllerState['status'] = 'idle'
  let casRejectedCount = 0
  let sealedResult: SealedVoiceTurn | undefined

  let speculativeEntry: SpeculativeRephraseEntry | null = null
  let activeJudgeAbort: AbortController | null = null
  let activeJudgePromise: Promise<VoiceTurnAdvanceOutcome> | null = null

  function getRevisions(): TurnRevisionSnapshot {
    return { rawRev, speakerRev, contextRev }
  }

  function isCurrent(snapshot: TurnRevisionSnapshot): boolean {
    return (
      snapshot.rawRev === rawRev &&
      snapshot.speakerRev === speakerRev &&
      snapshot.contextRev === contextRev
    )
  }

  function cancelSpeculative(): void {
    if (speculativeEntry) {
      speculativeEntry.abortController.abort('transcript-updated')
      speculativeEntry = null
    }
  }

  function cancelActiveJudge(): void {
    if (activeJudgeAbort) {
      activeJudgeAbort.abort('revision-changed')
      activeJudgeAbort = null
      activeJudgePromise = null
    }
  }

  function ensureSpeculativeRephrase(): SpeculativeRephraseEntry {
    if (
      speculativeEntry &&
      speculativeEntry.rawRev === rawRev &&
      speculativeEntry.rawText === rawText &&
      !speculativeEntry.abortController.signal.aborted
    ) {
      return speculativeEntry
    }

    cancelSpeculative()
    const abortController = new AbortController()
    const capturedText = rawText
    const capturedRev = rawRev

    const promise = Promise.resolve()
      .then(() => options.rephraseFn(capturedText, abortController.signal))
      .catch(() => capturedText.trim())

    speculativeEntry = {
      rawRev: capturedRev,
      rawText: capturedText,
      promise,
      abortController,
    }
    return speculativeEntry
  }

  function updateTranscript(nextText: string): void {
    const normalized = typeof nextText === 'string' ? nextText : String(nextText ?? '')
    if (sealedResult) {
      sealedResult = undefined
    }
    if (normalized !== rawText) {
      rawText = normalized
      rawRev += 1
      speakerRev += 1
      silenceMs = 0
      stableTextMs = 0
      inGracePeriod = false
      status = rawText.trim().length > 0 ? 'speaking' : 'idle'
      cancelSpeculative()
      cancelActiveJudge()
    }
  }

  function bumpSpeakerRevision(): void {
    if (inGracePeriod) {
      casRejectedCount += 1
    }
    speakerRev += 1
    silenceMs = 0
    inGracePeriod = false
    if (status !== 'sealed') {
      status = 'speaking'
    }
    cancelActiveJudge()
  }

  function bumpContextRevision(): void {
    contextRev += 1
    cancelActiveJudge()
  }

  async function finalizeSeal(reason: SealedVoiceTurn['reason']): Promise<SealedVoiceTurn> {
    if (sealedResult) {
      return sealedResult
    }

    const hadSpeculative =
      speculativeEntry !== null &&
      speculativeEntry.rawRev === rawRev &&
      speculativeEntry.rawText === rawText &&
      !speculativeEntry.abortController.signal.aborted

    const entry = ensureSpeculativeRephrase()
    const rephrasedText = await entry.promise

    const result: SealedVoiceTurn = {
      rawText,
      rephrasedText,
      reason,
      revisions: getRevisions(),
      reusedSpeculativeRephrase: hadSpeculative,
      silenceMs,
    }

    status = 'sealed'
    inGracePeriod = false
    sealedResult = result
    options.onTurnSealed?.(result)
    return result
  }

  async function advanceSilence(deltaMs: number): Promise<VoiceTurnAdvanceOutcome> {
    const dt = Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0)
    if (status === 'sealed' && sealedResult) {
      return { sealed: true, casRejected: false, result: sealedResult }
    }
    if (rawText.trim().length === 0) {
      return { sealed: false, casRejected: false }
    }

    silenceMs += dt
    stableTextMs += dt

    // 1. Speculative Rephrase trigger at 600ms of stable STT text
    if (stableTextMs >= speculateAfterMs) {
      ensureSpeculativeRephrase()
    }

    // 2. If already in grace period (+3000ms), check if total silence reached 4200ms
    if (inGracePeriod) {
      if (silenceMs >= totalGraceTimeoutMs) {
        const result = await finalizeSeal('grace-timeout')
        return { sealed: true, casRejected: false, result }
      }
      return { sealed: false, casRejected: false }
    }

    // 3. Voice End Judge at pauseMs (1200ms) with mandatory CAS revision check
    if (silenceMs >= pauseMs) {
      if (activeJudgePromise) {
        return activeJudgePromise
      }

      const readAt = getRevisions()
      const judgeAbort = new AbortController()
      activeJudgeAbort = judgeAbort
      status = 'judging'

      const runJudge = async (): Promise<VoiceTurnAdvanceOutcome> => {
        let decision: EndJudgeDecision
        try {
          decision = await options.endJudgeFn(rawText, judgeAbort.signal)
        } catch {
          if (!isCurrent(readAt)) {
            casRejectedCount += 1
            return { sealed: false, casRejected: true }
          }
          return { sealed: false, casRejected: false }
        } finally {
          if (activeJudgeAbort === judgeAbort) {
            activeJudgeAbort = null
            activeJudgePromise = null
          }
        }

        // Compare-And-Swap (CAS): verify { rawRev, speakerRev, contextRev } did not change while Judge ran!
        if (!isCurrent(readAt)) {
          casRejectedCount += 1
          return { sealed: false, casRejected: true }
        }

        if (decision.complete) {
          const result = await finalizeSeal('end-judged')
          return { sealed: true, casRejected: false, result }
        }

        // Incomplete utterance ("Hum, deixa eu pensar...") -> grant +3000ms grace period (4200ms total)
        inGracePeriod = true
        status = 'grace'
        if (silenceMs >= totalGraceTimeoutMs) {
          const result = await finalizeSeal('grace-timeout')
          return { sealed: true, casRejected: false, result }
        }

        return { sealed: false, casRejected: false }
      }

      activeJudgePromise = runJudge()
      return activeJudgePromise
    }

    return { sealed: false, casRejected: false }
  }

  function reset(): void {
    cancelSpeculative()
    cancelActiveJudge()
    rawText = ''
    silenceMs = 0
    stableTextMs = 0
    inGracePeriod = false
    status = 'idle'
    sealedResult = undefined
  }

  return {
    updateTranscript,
    bumpSpeakerRevision,
    bumpContextRevision,
    isCurrent,
    advanceSilence,
    sealTurn: (reason = 'manual') => finalizeSeal(reason),
    reset,
    getState(): VoiceTurnControllerState {
      return {
        status,
        rawText,
        silenceMs,
        stableTextMs,
        inGracePeriod,
        revisions: getRevisions(),
        casRejectedCount,
        hasSpeculativeRephrase:
          speculativeEntry !== null &&
          speculativeEntry.rawRev === rawRev &&
          speculativeEntry.rawText === rawText,
        sealedResult,
      }
    },
  }
}
