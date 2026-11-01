/**
 * Phase 10.5 — host side of the classic cascade pipeline (STT → any text LLM → chunked TTS).
 *
 * - `call:cascadeTurn {callId, turnId, text, context?, toolChoice?}` runs ONE generation through the
 *   turn orchestrator (`runVoiceCallTurn`: Ashy's persona, history, memory retrieval and tool loop,
 *   voice directive) with `settings.cascade.llmProviderId/llmModelId`, and streams the result back as
 *   `call:cascade` events (delta / tool / done / error / aborted) for that call + turnId.
 *   Nothing is persisted here: the engine's `call:recordTurn` (call recorder, modality 'voice')
 *   stores only what was actually heard, with the interrupted flag — one persistence path, never two.
 * - `call:cascadeAbort {callId, turnId}` aborts the LLM turn (barge-in / new turn / hang-up).
 * - `createCascadeTtsRouter` backs `call:synthesize` for cascade calls: 'llamacpp-tts' (managed or
 *   user llama-server /tts, optional reference voice) or the kernel voice providers
 *   ('local-kokoro-http' | 'openai-tts' | 'elevenlabs', same keys/URLs as the chat voice).
 *
 * Tools: only when the host tool policy for the turn is 'auto' (`call:buildContext` intent check — small
 * models call tools for small talk otherwise), the four lean call tools run through `executeCallTool`
 * (agency gatekeeper, card origin = this call, so voice approval "pode" works as in 10.3).
 */
import * as v from 'valibot'
import { defineTool, streamText, type LanguageModel, type ToolDefinition } from '@ashy/llm'
import {
  CallCascadeAbortInputSchema,
  CallCascadeTurnInputSchema,
  CallCascadeWarmupInputSchema,
  LLM_PROVIDER_IDS,
  type CallCascadeWarmupResult,
  type CallSynthesizeStreamResult,
  type CallCascadeEvent,
  type CallSynthesizeResult,
  type CascadeTtsProviderId,
  type LiveCallHostEvent,
  type LiveModeSettings,
  type LlmProviderId,
} from '@ashy/shared'
import type { LiveCallRegistry } from './registry'
import type { CallRecord } from './call-hub'
import type { CallSynthesizer } from './synthesize'
import { parseWav, pcm16ToBase64 } from './synthesize'
import { executeCallTool, type ExecuteCallToolDeps } from './tools'
import type { VoiceCallTurnEvent, VoiceCallTurnInput } from '../turn-orchestrator'

// ───────────────────────────── TTS routing ─────────────────────────────

/** Kernel `synthesizeVoiceSpeech` (subset): returns a WAV in `audioBase64`. */
export type HostSpeechSynthesizer = (input: {
  text: string
  providerId: 'local-kokoro-http' | 'openai-tts' | 'elevenlabs'
  voiceId?: string
}) => Promise<{ audioBase64: string; synthesisLatencyMs?: number; delivery?: string }>

export interface CascadeTtsRouterDeps {
  getSettings(): LiveModeSettings
  /** llama-server /tts synthesizer (`createCallSynthesizer`; `synthesizeStream` = streamed /tts). */
  llama: Pick<CallSynthesizer, 'synthesize'> & Partial<Pick<CallSynthesizer, 'synthesizeStream'>>
  /** Starts the managed llama-server when needed (no-op for a user endpoint / running engine). */
  ensureLlamaEngine(): Promise<void>
  synthesizeSpeech?: HostSpeechSynthesizer
  now?: () => number
}

/** Streamed synthesis of one phrase (PCM delivered through `onPcm` as it is generated). */
export interface TtsStreamInput {
  text: string
  onPcm(pcm: Int16Array, sampleRate: number): void
  signal?: AbortSignal
}
export interface TtsStreamOutcome {
  sampleRate: number
  samples: number
  latencyMs: number
  firstChunkMs: number | null
  aborted: boolean
}

export interface CascadeTtsRouter {
  synthesize(input: { text: string }): Promise<CallSynthesizeResult>
  /**
   * llama.cpp /tts streams (`stream: true`); the other providers synthesize the whole phrase and
   * deliver it as one piece.
   */
  synthesizeStream(input: TtsStreamInput): Promise<TtsStreamOutcome>
  providerId(): CascadeTtsProviderId
}

/** Adapts a whole-phrase synthesizer to the streamed contract (one `onPcm` call). */
export async function synthesizeAsOneChunk(
  synthesize: () => Promise<CallSynthesizeResult>,
  input: Pick<TtsStreamInput, 'onPcm' | 'signal'>,
  now: () => number = () => performance.now(),
): Promise<TtsStreamOutcome> {
  const startedAt = now()
  const res = await synthesize()
  const aborted = Boolean(input.signal?.aborted)
  const pcm = aborted ? new Int16Array(0) : base64ToPcm16(res.pcmBase64)
  if (pcm.length > 0) input.onPcm(pcm, res.sampleRate)
  const latencyMs = Math.max(0, Math.round(now() - startedAt))
  return { sampleRate: res.sampleRate, samples: pcm.length, latencyMs, firstChunkMs: pcm.length > 0 ? latencyMs : null, aborted }
}

function base64ToPcm16(b64: string): Int16Array {
  const buf = Buffer.from(b64, 'base64')
  const out = new Int16Array(Math.floor(buf.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2)
  return out
}

export function createCascadeTtsRouter(deps: CascadeTtsRouterDeps): CascadeTtsRouter {
  const now = deps.now ?? (() => performance.now())
  const router: CascadeTtsRouter = {
    providerId: () => deps.getSettings().cascade.ttsProviderId,
    async synthesizeStream(input) {
      const text = input.text.trim()
      if (!text) throw new Error('TTS_EMPTY_TEXT')
      const cascade = deps.getSettings().cascade
      if (cascade.ttsProviderId === 'llamacpp-tts' && deps.llama.synthesizeStream) {
        await deps.ensureLlamaEngine()
        const voice = cascade.ttsVoice === 'male' ? 'male' : 'female'
        return deps.llama.synthesizeStream({
          text,
          voice,
          referenceVoiceId: cascade.referenceVoiceId ?? null,
          onPcm: input.onPcm,
          ...(input.signal ? { signal: input.signal } : {}),
        })
      }
      return synthesizeAsOneChunk(() => router.synthesize({ text }), input, now)
    },
    async synthesize(input) {
      const text = input.text.trim()
      if (!text) throw new Error('TTS_EMPTY_TEXT')
      const cascade = deps.getSettings().cascade
      if (cascade.ttsProviderId === 'llamacpp-tts') {
        await deps.ensureLlamaEngine()
        const voice = cascade.ttsVoice === 'male' ? 'male' : 'female'
        return deps.llama.synthesize({ text, voice, referenceVoiceId: cascade.referenceVoiceId ?? null })
      }
      if (!deps.synthesizeSpeech) throw new Error(`TTS_UNAVAILABLE: ${cascade.ttsProviderId} is not wired`)
      const startedAt = now()
      const voiceId = cascade.ttsVoice.trim()
      const res = await deps.synthesizeSpeech({
        text,
        providerId: cascade.ttsProviderId,
        // 'female'/'male' are llama.cpp voices: the provider's configured voice is used instead.
        ...(voiceId && voiceId !== 'female' && voiceId !== 'male' ? { voiceId } : {}),
      })
      if (!res || res.delivery === 'use-browser-tts' || !res.audioBase64) {
        throw new Error(`TTS_BAD_AUDIO: ${cascade.ttsProviderId} returned no audio`)
      }
      let parsed
      try {
        parsed = parseWav(new Uint8Array(Buffer.from(res.audioBase64, 'base64')))
      } catch (err) {
        throw new Error(`TTS_BAD_AUDIO: ${err instanceof Error ? err.message : String(err)}`)
      }
      return {
        pcmBase64: pcm16ToBase64(parsed.pcm),
        sampleRate: parsed.sampleRate,
        durationMs: parsed.durationMs,
        latencyMs: Math.max(0, Math.round(res.synthesisLatencyMs ?? now() - startedAt)),
      }
    },
  }
  return router
}

// ───────────────────────────── streamed TTS (call:synthesizeStream) ─────────────────────────────

export interface TtsStreamRunnerDeps {
  emit(event: LiveCallHostEvent): void
  now?: () => number
  /**
   * After the first piece (sent at once, for time-to-first-audio), PCM is coalesced into events of at
   * least this much audio (default 160 ms; llama.cpp streams ~80 ms pieces).
   */
  coalesceMs?: number
}

export interface TtsStreamRunner {
  /** Runs one streamed synthesis, emitting `call:ttsChunk` events (seq 0..n-1). */
  run(
    input: { callId: string; streamId: string },
    synthesize: (stream: Pick<TtsStreamInput, 'onPcm' | 'signal'>) => Promise<TtsStreamOutcome>,
  ): Promise<CallSynthesizeStreamResult>
  /** Aborts one stream (barge-in). */
  abort(callId: string, streamId: string): boolean
  /** Aborts every stream (unregister). */
  abortAll(): void
  activeCount(): number
}

export function createTtsStreamRunner(deps: TtsStreamRunnerDeps): TtsStreamRunner {
  const now = deps.now ?? (() => performance.now())
  const coalesceMs = Math.max(0, deps.coalesceMs ?? 160)
  const active = new Map<string, AbortController>()
  const keyOf = (callId: string, streamId: string) => `${callId}|${streamId}`
  return {
    activeCount: () => active.size,
    abort(callId, streamId) {
      const controller = active.get(keyOf(callId, streamId))
      if (!controller) return false
      controller.abort()
      return true
    },
    abortAll() {
      for (const c of active.values()) c.abort()
    },
    async run(input, synthesize) {
      const key = keyOf(input.callId, input.streamId)
      active.get(key)?.abort()
      const controller = new AbortController()
      active.set(key, controller)
      const startedAt = now()
      let seq = 0
      let samples = 0
      let rate = 0
      let firstChunkMs: number | null = null
      let pending: Int16Array[] = []
      let pendingSamples = 0
      const flush = () => {
        if (pendingSamples === 0 || controller.signal.aborted) return
        const merged = new Int16Array(pendingSamples)
        let off = 0
        for (const p of pending) {
          merged.set(p, off)
          off += p.length
        }
        pending = []
        pendingSamples = 0
        deps.emit({
          type: 'call:ttsChunk',
          callId: input.callId,
          streamId: input.streamId,
          seq,
          pcmBase64: pcm16ToBase64(merged),
          sampleRate: rate,
        })
        seq += 1
      }
      try {
        const outcome = await synthesize({
          signal: controller.signal,
          onPcm: (pcm, sampleRate) => {
            if (controller.signal.aborted || pcm.length === 0) return
            if (rate && sampleRate !== rate) flush()
            rate = sampleRate
            if (firstChunkMs === null) firstChunkMs = Math.max(0, Math.round(now() - startedAt))
            samples += pcm.length
            pending.push(pcm)
            pendingSamples += pcm.length
            if (seq === 0 || (pendingSamples / sampleRate) * 1000 >= coalesceMs) flush()
          },
        })
        const aborted = controller.signal.aborted || outcome.aborted
        if (!aborted) flush()
        const sampleRate = rate || outcome.sampleRate || 24000
        return {
          streamId: input.streamId,
          chunks: seq,
          sampleRate,
          durationMs: Math.round((samples / sampleRate) * 1000),
          latencyMs: Math.max(0, Math.round(now() - startedAt)),
          firstChunkMs,
          ...(aborted ? { aborted: true } : {}),
        }
      } finally {
        if (active.get(key) === controller) active.delete(key)
      }
    },
  }
}

// ───────────────────────────── LLM warm-up (call:cascadeWarmup) ─────────────────────────────

export const CASCADE_WARMUP_TIMEOUT_MS = 120_000

export interface CascadeLlmWarmupDeps {
  /** Provider vault public state (active provider + configs). */
  getProviderState(): { activeProviderId: LlmProviderId; configs: Partial<Record<LlmProviderId, { baseUrl: string; modelId: string; requiresApiKey?: boolean; hasApiKey?: boolean }>> }
  /** `providerVault.createLanguageModel` — the very adapter the cascade turn uses (same Ollama options). */
  createLanguageModel(providerId: LlmProviderId, overrides?: { modelId?: string }): LanguageModel
  timeoutMs?: number
}

/**
 * One-token generation through the same adapter the orchestrator uses, so a local model (Ollama:
 * native /api/chat with the same options and `keep_alive`) is loaded before the first turn. Nothing
 * is persisted and no chat event is emitted.
 */
export function createCascadeLlmWarmup(
  deps: CascadeLlmWarmupDeps,
): (llm: { providerId?: LlmProviderId; modelId?: string }) => Promise<{ providerId: string; modelId: string | null }> {
  return async (llm) => {
    const state = deps.getProviderState()
    const providerId = llm.providerId ?? state.activeProviderId
    const config = state.configs[providerId]
    const modelId = (llm.modelId ?? '').trim() || config?.modelId || ''
    if (!config || !config.baseUrl.trim() || !modelId || (config.requiresApiKey && !config.hasApiKey)) {
      throw new Error(`PROVIDER_NOT_CONFIGURED: ${providerId}`)
    }
    const model = deps.createLanguageModel(providerId, llm.modelId ? { modelId: llm.modelId } : undefined)
    const stream = streamText(model, {
      messages: [{ role: 'user', content: 'oi' }],
      maxTokens: 1,
      maxSteps: 1,
      reasoningEffort: 'none',
      signal: AbortSignal.timeout(deps.timeoutMs ?? CASCADE_WARMUP_TIMEOUT_MS),
    })
    for await (const event of stream) {
      if (event.type === 'error') throw new Error(event.error)
    }
    return { providerId, modelId }
  }
}

// ───────────────────────────── call tools for the orchestrator loop ─────────────────────────────

/** The lean 10.3 call tools as orchestrator tools (valibot schemas, executed via `executeCallTool`). */
export function buildCascadeCallTools(callId: string, deps: ExecuteCallToolDeps): ToolDefinition[] {
  const run = async (name: string, args: unknown): Promise<string> => {
    const res = await executeCallTool({ callId, name, argsJson: JSON.stringify(args ?? {}) }, deps)
    return res.output
  }
  return [
    defineTool({
      name: 'get_active_window_title',
      description: 'Returns the title of the window the user is currently using.',
      parameters: v.object({}),
      execute: (args) => run('get_active_window_title', args),
    }),
    defineTool({
      name: 'capture_authorized_screen',
      description: "Looks at the user's screen (if authorized) and returns a short description.",
      parameters: v.object({}),
      execute: (args) => run('capture_authorized_screen', args),
    }),
    defineTool({
      name: 'read_workspace_file',
      description:
        'Reads an EXISTING text file the user names explicitly (e.g. "lê o arquivo notas.txt"). Never use it to save anything.',
      parameters: v.object({ path: v.pipe(v.string(), v.description('Relative file path')) }),
      execute: (args) => run('read_workspace_file', args),
    }),
    defineTool({
      name: 'write_project_note',
      description:
        'Saves a new note when the user asks to write/remember something ("anota", "salva uma nota", "lembra que"). Needs the user\'s approval.',
      parameters: v.object({
        title: v.pipe(v.string(), v.description('Short note title')),
        content: v.pipe(v.string(), v.description('Note text')),
      }),
      execute: (args) => run('write_project_note', args),
    }),
  ]
}

// ───────────────────────────── handlers ─────────────────────────────

/** Narrow view of the turn orchestrator. */
export interface CascadeOrchestrator {
  runVoiceCallTurn(input: VoiceCallTurnInput, onEvent: (event: VoiceCallTurnEvent) => void): { turnId: string }
  abortTurn(turnId: string): Promise<void>
}

export interface CascadeHandlerDeps {
  registry: LiveCallRegistry
  emit(event: LiveCallHostEvent): void
  getSettings(): LiveModeSettings
  /** Lazy: the orchestrator is built after the kernel starts. null = not ready. */
  getOrchestrator(): CascadeOrchestrator | null
  getKnownCall(callId: string): CallRecord | null
  getActiveCall(): CallRecord | null
  getUserName(): string | null
  /** Tool execution deps (agency runtime + call vision). */
  toolDeps: ExecuteCallToolDeps
  /** `features.toolsInCall` and not a test call. */
  toolsAllowed(call: CallRecord): boolean
  /**
   * PT note about an action staged by this call and still waiting for approval (null when none).
   * Small models otherwise answer "anotado!" to an unrecognised approval phrase (2026-11-01 run).
   */
  getPendingActionNote?(callId: string): string | null
  /**
   * Loads/warms the cascade LLM with a minimal generation (no persistence, no chat events). Resolves
   * with the provider/model actually used. Absent → `call:cascadeWarmup` answers `warmed: false`.
   */
  warmupLlm?(llm: { providerId?: LlmProviderId; modelId?: string }): Promise<{ providerId: string; modelId: string | null }>
  now?: () => number
  onWarning?(message: string): void
}

interface ActiveCascadeTurn {
  callId: string
  turnId: string
  orchestratorTurnId: string | null
  aborted: boolean
}

function parseOrThrow<TSchema extends v.GenericSchema>(schema: TSchema, payload: unknown, method: string): v.InferOutput<TSchema> {
  const parsed = v.safeParse(schema, payload ?? {})
  if (!parsed.success) {
    const issue = parsed.issues[0]
    const where = issue?.path?.map((p) => String(p.key)).join('.') ?? ''
    throw new Error(`Invalid payload for ${method}${where ? ` at ${where}` : ''}: ${issue?.message ?? 'invalid input'}`)
  }
  return parsed.output
}

/** Resolves `settings.cascade.llmProviderId` ('chat-default' → the active chat provider). */
export function resolveCascadeLlm(settings: LiveModeSettings): { providerId?: LlmProviderId; modelId?: string } {
  const raw = settings.cascade.llmProviderId.trim()
  const modelId = settings.cascade.llmModelId.trim()
  if (!raw || raw === 'chat-default') return modelId ? { modelId } : {}
  if (!(LLM_PROVIDER_IDS as readonly string[]).includes(raw)) {
    throw new Error(`CASCADE_LLM_UNKNOWN: provedor de texto desconhecido "${raw}"`)
  }
  return { providerId: raw as LlmProviderId, ...(modelId ? { modelId } : {}) }
}

export function registerCascadeHandlers(deps: CascadeHandlerDeps): { unregister(): void; activeTurnCount(): number } {
  /** One live LLM turn per call (a new turn aborts the previous one). */
  const turnsByCall = new Map<string, ActiveCascadeTurn>()
  const warmups = new Map<string, Promise<{ providerId: string; modelId: string | null }>>()
  const now = deps.now ?? (() => performance.now())

  function emitEvent(turn: ActiveCascadeTurn, event: CallCascadeEvent): void {
    deps.emit({ type: 'call:cascade', callId: turn.callId, turnId: turn.turnId, ...event } as LiveCallHostEvent)
  }

  function abortTurn(turn: ActiveCascadeTurn): void {
    if (turn.aborted) return
    turn.aborted = true
    if (turnsByCall.get(turn.callId) === turn) turnsByCall.delete(turn.callId)
    const orchestrator = deps.getOrchestrator()
    if (orchestrator && turn.orchestratorTurnId) void orchestrator.abortTurn(turn.orchestratorTurnId).catch(() => {})
  }

  const unregisterFns = [
    deps.registry.register('call:cascadeTurn', (payload) => {
      const input = parseOrThrow(CallCascadeTurnInputSchema, payload, 'call:cascadeTurn')
      const call = deps.getKnownCall(input.callId)
      if (!call) throw new Error(`CALL_UNKNOWN: ${input.callId}`)
      const active = deps.getActiveCall()
      if (!active || active.callId !== input.callId) throw new Error(`CALL_NOT_ACTIVE: ${input.callId}`)
      if (call.backend !== 'cascade') throw new Error(`CASCADE_WRONG_BACKEND: ${call.backend}`)
      const orchestrator = deps.getOrchestrator()
      if (!orchestrator) throw new Error('CASCADE_UNAVAILABLE: the turn orchestrator is not ready')
      const settings = deps.getSettings()
      const llm = resolveCascadeLlm(settings)

      const previous = turnsByCall.get(input.callId)
      if (previous) abortTurn(previous)
      const turn: ActiveCascadeTurn = { callId: input.callId, turnId: input.turnId, orchestratorTurnId: null, aborted: false }
      turnsByCall.set(input.callId, turn)

      let userName: string | null = null
      try {
        userName = deps.getUserName()
      } catch {
        userName = null
      }
      const tools =
        input.toolChoice === 'auto' && input.text.trim().length > 0 && deps.toolsAllowed(call)
          ? buildCascadeCallTools(input.callId, deps.toolDeps)
          : undefined
      let pendingNote: string | null = null
      try {
        pendingNote = deps.getPendingActionNote?.(input.callId) ?? null
      } catch {
        pendingNote = null
      }
      const callContext = [input.context ?? '', pendingNote ?? ''].map((t) => t.trim()).filter(Boolean).join('\n')
      const { turnId: orchestratorTurnId } = orchestrator.runVoiceCallTurn(
        {
          sessionId: call.sessionId,
          userText: input.text,
          ...(callContext ? { callContext } : {}),
          userName,
          ...llm,
          ...(tools ? { tools } : {}),
        },
        (event) => {
          if (turn.aborted && event.kind !== 'aborted') return
          if (event.kind === 'done' || event.kind === 'error' || event.kind === 'aborted') {
            if (turnsByCall.get(turn.callId) === turn) turnsByCall.delete(turn.callId)
            if (event.kind === 'error') deps.onWarning?.(`cascade turn ${turn.turnId}: ${event.message}`)
          }
          emitEvent(turn, event)
        },
      )
      turn.orchestratorTurnId = orchestratorTurnId
      return { turnId: input.turnId, accepted: true, ...(tools ? { tools: tools.length } : {}) }
    }),
    deps.registry.register('call:cascadeWarmup', async (payload): Promise<CallCascadeWarmupResult> => {
      const input = parseOrThrow(CallCascadeWarmupInputSchema, payload, 'call:cascadeWarmup')
      const call = deps.getKnownCall(input.callId)
      if (!call) throw new Error(`CALL_UNKNOWN: ${input.callId}`)
      if (call.backend !== 'cascade') throw new Error(`CASCADE_WRONG_BACKEND: ${call.backend}`)
      const llm = resolveCascadeLlm(deps.getSettings())
      const startedAt = now()
      if (!deps.warmupLlm) {
        return { warmed: false, providerId: llm.providerId ?? null, modelId: llm.modelId ?? null, latencyMs: 0 }
      }
      // Two calls (reconnect) share one warm-up of the same model.
      const key = `${llm.providerId ?? 'chat-default'}|${llm.modelId ?? ''}`
      let pending = warmups.get(key)
      if (!pending) {
        pending = deps.warmupLlm(llm).finally(() => warmups.delete(key))
        warmups.set(key, pending)
      }
      try {
        const used = await pending
        return { warmed: true, providerId: used.providerId, modelId: used.modelId, latencyMs: Math.max(0, Math.round(now() - startedAt)) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        deps.onWarning?.(`cascade warm-up failed: ${message}`)
        throw new Error(`CASCADE_WARMUP_FAILED: ${message}`)
      }
    }),
    deps.registry.register('call:cascadeAbort', (payload) => {
      const input = parseOrThrow(CallCascadeAbortInputSchema, payload, 'call:cascadeAbort')
      const turn = turnsByCall.get(input.callId)
      if (!turn || turn.turnId !== input.turnId) return { aborted: false }
      abortTurn(turn)
      return { aborted: true }
    }),
  ]

  return {
    activeTurnCount: () => turnsByCall.size,
    unregister() {
      for (const fn of unregisterFns) fn()
      for (const turn of [...turnsByCall.values()]) abortTurn(turn)
      turnsByCall.clear()
    },
  }
}
