/**
 * Phase 10.5 — call-engine window glue for the `cascade` backend (STT → text LLM → chunked TTS).
 *
 * `createCascadeSessionOverBridge` builds a `CascadeSession` on top of the host bridge:
 *   startTurn → `call:cascadeTurn`, abortTurn → `call:cascadeAbort`, synthesize → `call:synthesize`
 *   (routed host-side to `settings.cascade.ttsProviderId`), and the streamed `call:cascade` host
 *   events of THIS call routed to the session.
 * `createCascadeCallEngine` is the CallEngine for a cascade runtime config (transcribed input forced,
 * no llama.cpp endpoint needed). Wire it from `boot.ts`' default factory:
 *   if (config.backend === 'cascade') return createCascadeCallEngine({ config, host, testInput })
 */
import type { AshyHostBridge, AshyHostStreamEvent, CallRuntimeConfig, CallTestInput, LiveCallMethod } from '@ashy/shared'
import {
  createCallEngine,
  createCascadeSession,
  type CallEngine,
  type CallEngineHost,
  type CascadeHostEvent,
  type CascadeSession,
} from '@ashy/voice'
import { getAshyHostBridge } from '../services/ashy-host-client'

/** URL of the Silero VAD model served from `apps/desktop/public/models` (same as boot.ts). */
const SILERO_VAD_MODEL_URL = '/models/silero_vad.onnx'

export interface CascadeSessionOverBridgeArgs {
  config: CallRuntimeConfig
  host: CallEngineHost
  bridge?: AshyHostBridge
}

export function createCascadeSessionOverBridge(args: CascadeSessionOverBridgeArgs): CascadeSession {
  const { config, host } = args
  const bridge = args.bridge ?? getAshyHostBridge()
  const callId = config.callId
  const invoke = (method: LiveCallMethod, payload: unknown): Promise<unknown> => {
    if (typeof bridge.invokeLiveCall !== 'function') {
      return Promise.reject(new Error('LIVE_CALL_UNAVAILABLE: bridge has no invokeLiveCall'))
    }
    return bridge.invokeLiveCall({ method, payload })
  }
  const cascade = config.settings.cascade
  return createCascadeSession({
    turnIdPrefix: `c${callId.replace(/[^A-Za-z0-9]/g, '').slice(-12)}`,
    maxParallelTts: config.settings.hybrid?.maxParallelTts ?? 2,
    speakerReference: cascade?.ttsProviderId === 'llamacpp-tts',
    startTurn: (request) => invoke('call:cascadeTurn', { callId, ...request }),
    abortTurn: (turnId) => invoke('call:cascadeAbort', { callId, turnId }),
    synthesize: (text) => host.synthesize({ callId, text }),
    subscribe: (listener) =>
      bridge.onHostEvent((event: AshyHostStreamEvent) => {
        const e = event as { type: string; callId?: string }
        if (e.type !== 'call:cascade' || e.callId !== callId) return
        listener(event as unknown as CascadeHostEvent)
      }),
    // llama.cpp /tts: start the managed server + load the vocoder before the first answer.
    ...(cascade?.ttsProviderId === 'llamacpp-tts'
      ? {
          prepare: async () => {
            await host.synthesize({ callId, text: 'Oi.' })
          },
        }
      : {}),
  })
}

export function createCascadeCallEngine(args: {
  config: CallRuntimeConfig
  host: CallEngineHost
  testInput?: CallTestInput
  bridge?: AshyHostBridge
}): CallEngine {
  const { config, host, testInput } = args
  const settings = {
    ...config.settings,
    // The cascade always transcribes (host STT); audio-direct is a llama.cpp realtime mode.
    llamacpp: { ...config.settings.llamacpp, inputMode: 'transcribed' as const },
  }
  return createCallEngine({
    callId: config.callId,
    settings,
    host,
    vadModelUrl: SILERO_VAD_MODEL_URL,
    ...(testInput ? { testInput } : {}),
    createSession: () =>
      createCascadeSessionOverBridge({ config, host, ...(args.bridge ? { bridge: args.bridge } : {}) }),
  })
}
