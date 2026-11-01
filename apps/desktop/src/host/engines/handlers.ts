import * as v from 'valibot'
import {
  EnginesDownloadModelInputSchema,
  EnginesInstallInputSchema,
  EnginesStartInputSchema,
  SaveLiveModeSettingsInputSchema,
} from '@ashy/shared'
import type { LiveModeSettingsStore } from '../live-call/settings'
import type { LiveCallRegistry } from '../live-call/registry'
import type { LlamaCppEngine } from './llamacpp-engine'

export interface EngineHandlerDeps {
  llamaCppEngine: LlamaCppEngine
  liveModeSettingsStore: LiveModeSettingsStore
}

function parseOrThrow<TSchema extends v.GenericSchema>(
  schema: TSchema,
  payload: unknown,
  method: string,
): v.InferOutput<TSchema> {
  const parsed = v.safeParse(schema, payload)
  if (!parsed.success) {
    const issue = parsed.issues[0]
    const where = issue?.path?.map((p) => String(p.key)).join('.') ?? ''
    throw new Error(
      `Invalid payload for ${method}${where ? ` at ${where}` : ''}: ${issue?.message ?? 'invalid input'}`,
    )
  }
  return parsed.output
}

/** Registers `liveMode:*` and `engines:*` Live Call handlers. Returns an unregister function. */
export function registerEngineHandlers(
  api: { readonly registry: LiveCallRegistry },
  deps: EngineHandlerDeps,
): () => void {
  const { llamaCppEngine, liveModeSettingsStore } = deps
  const unregister = [
    api.registry.register('liveMode:getSettings', () => liveModeSettingsStore.get()),

    api.registry.register('liveMode:saveSettings', (payload) => {
      const input = parseOrThrow(SaveLiveModeSettingsInputSchema, payload ?? {}, 'liveMode:saveSettings')
      const saved = liveModeSettingsStore.save(input)
      if (input.llamacpp?.endpoint !== undefined) {
        llamaCppEngine.refreshStatus()
      }
      return saved
    }),

    api.registry.register('engines:getStatus', async () => {
      try {
        await llamaCppEngine.detectGpu()
      } catch {
        // detection failures never block status
      }
      return llamaCppEngine.getStatus()
    }),

    api.registry.register('engines:install', (payload) => {
      const input = parseOrThrow(
        EnginesInstallInputSchema,
        payload ?? { engineId: 'llamacpp' },
        'engines:install',
      )
      return llamaCppEngine.install(input.variant)
    }),

    api.registry.register('engines:downloadModel', (payload) => {
      const input = parseOrThrow(EnginesDownloadModelInputSchema, payload, 'engines:downloadModel')
      return llamaCppEngine.downloadModel(input.modelId)
    }),

    api.registry.register('engines:start', (payload) => {
      const input = parseOrThrow(EnginesStartInputSchema, payload ?? {}, 'engines:start')
      return llamaCppEngine.start(input.modelId || undefined)
    }),

    api.registry.register('engines:installVcRuntime', () => llamaCppEngine.installVcRuntime()),

    api.registry.register('engines:stop', async () => {
      await llamaCppEngine.stop()
      return llamaCppEngine.getStatus()
    }),
  ]
  return () => {
    for (const fn of unregister) fn()
  }
}
