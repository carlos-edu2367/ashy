/**
 * Phase 10.4 — builds the cloud speech-to-speech VoiceSession for a `CallRuntimeConfig` whose
 * `cloud` block was resolved by the host (`call:getRuntimeConfig`). `cloud.url` is the host's loopback
 * relay URL: the API key never reaches the renderer.
 */
import type { CallRuntimeConfig } from '@ashy/shared'
import { createGeminiLiveSession } from './gemini-live-session'
import { createOpenAIRealtimeSession } from './openai-realtime-session'
import type { CallTimers, VoiceSession, WebSocketFactory } from './types'

export interface CloudSessionFactoryOptions {
  webSocketFactory?: WebSocketFactory
  timers?: CallTimers
}

export function isCloudBackend(backend: string): boolean {
  return backend === 'openai-realtime' || backend === 'gemini-live'
}

export function createCloudVoiceSession(config: CallRuntimeConfig, opts: CloudSessionFactoryOptions = {}): VoiceSession {
  const cloud = config.cloud
  if (!cloud || !cloud.url) throw new Error(`backend ${config.backend} has no cloud endpoint`)
  const common = {
    url: cloud.url,
    model: cloud.model,
    ...(cloud.voice ? { voice: cloud.voice } : {}),
    ...(opts.webSocketFactory ? { webSocketFactory: opts.webSocketFactory } : {}),
    ...(opts.timers ? { timers: opts.timers } : {}),
  }
  if (cloud.kind === 'gemini') return createGeminiLiveSession(common)
  const provider = config.settings.realtimeCloud?.provider
  return createOpenAIRealtimeSession({ ...common, dialect: provider === 'qwen' ? 'qwen' : 'openai' })
}
