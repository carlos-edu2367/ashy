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
import { defineTool, type ToolDefinition } from '@ashy/llm'
import {
  CallCascadeAbortInputSchema,
  CallCascadeTurnInputSchema,
  LLM_PROVIDER_IDS,
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
  /** llama-server /tts synthesizer (`createCallSynthesizer`). */
  llama: Pick<CallSynthesizer, 'synthesize'>
  /** Starts the managed llama-server when needed (no-op for a user endpoint / running engine). */
  ensureLlamaEngine(): Promise<void>
  synthesizeSpeech?: HostSpeechSynthesizer
  now?: () => number
}

export interface CascadeTtsRouter {
  synthesize(input: { text: string }): Promise<CallSynthesizeResult>
  providerId(): CascadeTtsProviderId
}

export function createCascadeTtsRouter(deps: CascadeTtsRouterDeps): CascadeTtsRouter {
  const now = deps.now ?? (() => performance.now())
  return {
    providerId: () => deps.getSettings().cascade.ttsProviderId,
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
