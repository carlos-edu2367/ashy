/**
 * Phase 10.2 — test call (`call:startTest|getTestInput|reportTestResult`).
 *
 * startTest: make sure the llama.cpp engine runs, synthesize a fixed PT question with the MALE
 * `/tts` voice (no reference), resample it to 16 kHz mono WAV, keep it per call and start a call with
 * `test:true` (→ `call:command start {test:true}`). The call-engine fetches the audio with
 * `call:getTestInput`, feeds it instead of the mic, runs one turn and reports `CallTestResult`
 * (`call:reportTestResult` → `call:testResult`). Test turns are never persisted (see handlers/recorder).
 */
import type {
  CallReportTestResultInputSchema,
  CallStateSnapshot,
  CallTestInput,
  CallTestResult,
  LiveBackendId,
  LiveCallHostEvent,
  LiveModeSettings,
  LlamaCppEngineStatus,
} from '@ashy/shared'
import type * as v from 'valibot'
import type { CallHub } from './call-hub'
import { encodeMonoPcm16Wav, resamplePcm16, type CallSynthesizer } from './synthesize'

export const TEST_CALL_QUESTION = 'Oi Ashy, tudo bem? Me conta uma curiosidade rápida.'
export const TEST_CALL_INPUT_RATE = 16_000
const MAX_PENDING_TEST_INPUTS = 4

export interface TestCallEngineSource {
  getStatus(): LlamaCppEngineStatus
  start(modelId?: string): Promise<LlamaCppEngineStatus>
}

export interface TestCallDeps {
  hub: CallHub
  synthesizer: CallSynthesizer
  engine: TestCallEngineSource
  getSettings(): LiveModeSettings
  emit(event: LiveCallHostEvent): void
  now?: () => number
}

export type ReportTestResultInput = v.InferOutput<typeof CallReportTestResultInputSchema>

export interface StartTestResult {
  ok: boolean
  callId: string | null
  state: CallStateSnapshot
  /** Set when the test could not even start (engine/tts failure). */
  error?: string
}

export class TestCallBusyError extends Error {
  readonly code = 'CALL_BUSY' as const
  constructor() {
    super('CALL_BUSY: a call is already in progress')
    this.name = 'TestCallBusyError'
  }
}

export interface TestCallManager {
  startTest(input: { backend?: LiveBackendId }): Promise<StartTestResult>
  getTestInput(callId: string): CallTestInput
  reportTestResult(input: ReportTestResultInput): CallTestResult
  isTestCall(callId: string): boolean
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 480)
}

export function createTestCallManager(deps: TestCallDeps): TestCallManager {
  const now = deps.now ?? (() => Date.now())
  const inputs = new Map<string, CallTestInput>()
  /** Question prepared for the start that is in flight (the start command may race the map write). */
  let pendingInput: CallTestInput | null = null
  let starting = false

  function remember(callId: string, input: CallTestInput): void {
    inputs.set(callId, input)
    while (inputs.size > MAX_PENDING_TEST_INPUTS) {
      const oldest = inputs.keys().next().value
      if (oldest === undefined) break
      inputs.delete(oldest)
    }
  }

  function emitFailure(callId: string, detail: string): CallTestResult {
    const result: CallTestResult = {
      callId,
      ok: false,
      steps: [{ step: 'engine', ok: false, detail }],
      metrics: null,
      transcript: null,
      reply: null,
      finishedAt: now(),
    }
    deps.emit({ type: 'call:testResult', result })
    return result
  }

  async function ensureEngine(settings: LiveModeSettings): Promise<void> {
    let status: LlamaCppEngineStatus
    try {
      status = deps.engine.getStatus()
    } catch (err) {
      throw new Error(`engine status: ${errorMessage(err)}`)
    }
    if (settings.llamacpp.endpoint !== 'managed') return
    if (!status.installed) throw new Error('llama.cpp is not installed')
    if (status.running && (!status.activeModelId || status.activeModelId === settings.llamacpp.modelId)) return
    const started = await deps.engine.start(settings.llamacpp.modelId)
    if (!started.running) throw new Error(started.lastError ?? 'engine did not start')
  }

  return {
    async startTest(input) {
      const active = deps.hub.getActiveCall()
      if (active || starting) throw new TestCallBusyError()
      starting = true
      try {
        const settings = deps.getSettings()
        try {
          await ensureEngine(settings)
        } catch (err) {
          const detail = `engine: ${errorMessage(err)}`
          emitFailure('test-not-started', detail)
          return { ok: false, callId: null, state: deps.hub.getState(), error: detail }
        }
        let testInput: CallTestInput
        try {
          const spoken = await deps.synthesizer.synthesize({
            text: TEST_CALL_QUESTION,
            voice: 'male',
            referenceVoiceId: null,
          })
          const raw = Buffer.from(spoken.pcmBase64, 'base64')
          const pcm = new Int16Array(Math.floor(raw.byteLength / 2))
          for (let i = 0; i < pcm.length; i++) pcm[i] = raw.readInt16LE(i * 2)
          const pcm16k = resamplePcm16(pcm, spoken.sampleRate, TEST_CALL_INPUT_RATE)
          testInput = {
            wavBase64: Buffer.from(encodeMonoPcm16Wav(pcm16k, TEST_CALL_INPUT_RATE)).toString('base64'),
            expectedText: TEST_CALL_QUESTION,
          }
        } catch (err) {
          const detail = `tts: ${errorMessage(err)}`
          emitFailure('test-not-started', detail)
          return { ok: false, callId: null, state: deps.hub.getState(), error: detail }
        }

        pendingInput = testInput
        const state = await deps.hub.start({ ...(input.backend ? { backend: input.backend } : {}), test: true })
        pendingInput = null
        const call = state.callId ? deps.hub.getKnownCall(state.callId) : null
        if (!call || !call.test || state.status === 'ended') {
          const detail = `engine: ${state.reason ?? 'call did not start'}${state.detail ? ` (${state.detail})` : ''}`
          emitFailure(state.callId ?? 'test-not-started', detail)
          return { ok: false, callId: state.callId, state, error: detail }
        }
        remember(call.callId, testInput)
        return { ok: true, callId: call.callId, state }
      } finally {
        starting = false
        pendingInput = null
      }
    },

    getTestInput(callId) {
      const stored = inputs.get(callId)
      if (stored) return stored
      const call = deps.hub.getKnownCall(callId)
      if (call?.test && pendingInput) {
        remember(callId, pendingInput)
        return pendingInput
      }
      throw new Error(`TEST_INPUT_UNKNOWN: ${callId}`)
    },

    reportTestResult(input) {
      const call = deps.hub.getKnownCall(input.callId)
      if (!call?.test) throw new Error(`TEST_CALL_UNKNOWN: ${input.callId}`)
      inputs.delete(input.callId)
      const result: CallTestResult = {
        callId: input.callId,
        ok: input.ok && input.steps.length > 0 && input.steps.every((s) => s.ok),
        steps: input.steps.map((s) => ({
          step: s.step,
          ok: s.ok,
          ...(s.ms !== undefined ? { ms: Math.round(s.ms) } : {}),
          ...(s.detail !== undefined ? { detail: s.detail } : {}),
        })),
        metrics: input.metrics ?? null,
        transcript: input.transcript ?? null,
        reply: input.reply ?? null,
        finishedAt: now(),
      }
      deps.emit({ type: 'call:testResult', result })
      return result
    },

    isTestCall(callId) {
      return deps.hub.getKnownCall(callId)?.test === true
    },
  }
}
