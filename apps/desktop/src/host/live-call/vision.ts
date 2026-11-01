/**
 * Phase 10.3 — real vision for the live call (plan §Escopo 3).
 *
 * The Electron main process provides a `ScreenCaptureProvider` (desktopCapturer, registered with
 * `kernel.setScreenCaptureProvider`); the HOST decides whether a capture is allowed (eyesMode +
 * window consent of the agency PrivacyController) and describes the PNG with the SAME managed
 * llama-server (`POST /v1/chat/completions`, `image_url` data URL — 2026-11-01 spike: 1.4 s,
 * accurate). Every request carries the engine auth headers.
 */
import { createHash } from 'node:crypto'
import type { LiveCallHostEvent, LiveModeSettings } from '@ashy/shared'
import { resolveLlamaBaseUrl, type FetchLike, type TtsEngineSource } from './synthesize'

export type ScreenCaptureMode = 'screen' | 'window'

/** Implemented by Electron main (T3). `null` = nothing could be captured (e.g. window not found). */
export interface ScreenCaptureProvider {
  capture(
    mode: 'screen' | 'window',
    activeWindowTitle?: string,
  ): Promise<{ pngBase64: string; source: 'screen' | 'window' } | null>
}

export const VISION_PROMPT_PT = 'Descreva em uma frase curta, em português, o que aparece nesta tela.'
export const VISION_TIMEOUT_MS = 8_000
export const VISION_CACHE_TTL_MS = 30_000
export const VISION_MAX_DESCRIPTION_CHARS = 400
const VISION_MAX_TOKENS = 96
const VISION_CACHE_MAX_ENTRIES = 16

/** Narrow view of the agency PrivacyController. */
export interface VisionPrivacySource {
  readonly eyesMode: 'off' | 'window' | 'screen'
  canObserveScreen(windowTitle?: string): boolean
}

export type VisionFailureReason =
  | 'eyes_off'
  | 'window_not_authorized'
  | 'no_provider'
  | 'engine_unavailable'
  | 'capture_failed'
  | 'timeout'
  | 'error'

export type VisionDescribeResult =
  | { ok: true; text: string; source: ScreenCaptureMode; cached: boolean; latencyMs: number }
  | { ok: false; reason: VisionFailureReason; text: string }

export interface VisionDescriberDeps {
  getProvider(): ScreenCaptureProvider | null
  /** null while the agency runtime is not ready → "visão indisponível". */
  getPrivacy(): VisionPrivacySource | null
  getActiveWindowTitle(): Promise<string | null>
  getSettings(): LiveModeSettings
  engine: TtsEngineSource & { getRequestHeaders?(): Record<string, string> }
  emit(event: LiveCallHostEvent): void
  fetchImpl?: FetchLike
  now?: () => number
  timeoutMs?: number
  cacheTtlMs?: number
}

export interface VisionDescriber {
  describe(): Promise<VisionDescribeResult>
  clearCache(): void
}

const FAILURE_TEXT: Record<VisionFailureReason, string> = {
  eyes_off: 'Visão desligada: o usuário não autorizou ver a tela (olhos desligados).',
  window_not_authorized: 'A janela em foco não está na lista de janelas autorizadas; não posso vê-la.',
  no_provider: 'Visão indisponível: a captura de tela não está disponível agora.',
  engine_unavailable: 'Visão indisponível: o modelo local não está rodando.',
  capture_failed: 'Visão indisponível: não consegui capturar a tela.',
  timeout: 'Visão indisponível: a descrição da tela demorou demais.',
  error: 'Visão indisponível: falha ao descrever a tela.',
}

function fail(reason: VisionFailureReason): VisionDescribeResult {
  return { ok: false, reason, text: FAILURE_TEXT[reason] }
}

function cleanDescription(raw: string): string {
  let text = raw
    .replace(/\0/g, '')
    .replace(/<\|[\s\S]*?\|>/g, ' ')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > VISION_MAX_DESCRIPTION_CHARS) {
    text = `${text.slice(0, VISION_MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`
  }
  return text
}

class VisionTimeoutError extends Error {}

/** Resolves the llama-server base URL only when it can actually answer. */
function resolveVisionBaseUrl(settings: LiveModeSettings, engine: TtsEngineSource): string | null {
  if (settings.llamacpp.endpoint === 'managed') {
    let running = false
    try {
      running = engine.getStatus().running
    } catch {
      running = false
    }
    if (!running) return null
  }
  return resolveLlamaBaseUrl(settings, engine)
}

export function createVisionDescriber(deps: VisionDescriberDeps): VisionDescriber {
  const now = deps.now ?? (() => Date.now())
  const timeoutMs = deps.timeoutMs ?? VISION_TIMEOUT_MS
  const cacheTtlMs = deps.cacheTtlMs ?? VISION_CACHE_TTL_MS
  const cache = new Map<string, { text: string; at: number }>()

  function pruneCache(t: number): void {
    for (const [key, entry] of cache) {
      if (t - entry.at >= cacheTtlMs) cache.delete(key)
    }
    while (cache.size > VISION_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  async function requestDescription(baseUrl: string, pngBase64: string, settings: LiveModeSettings): Promise<string> {
    const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new VisionTimeoutError('vision timeout'))
      }, Math.max(1, timeoutMs))
      ;(timer as { unref?: () => void }).unref?.()
    })
    try {
      const work = (async () => {
        const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(deps.engine.getRequestHeaders?.() ?? {}) },
          body: JSON.stringify({
            model: settings.llamacpp.modelId,
            stream: false,
            max_tokens: VISION_MAX_TOKENS,
            temperature: 0.2,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBase64}` } },
                  { type: 'text', text: VISION_PROMPT_PT },
                ],
              },
            ],
          }),
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`vision HTTP ${res.status}`)
        const parsed = JSON.parse(await res.text()) as {
          choices?: Array<{ message?: { content?: unknown } }>
        }
        const content = parsed.choices?.[0]?.message?.content
        return typeof content === 'string' ? content : ''
      })()
      return await Promise.race([work, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    clearCache() {
      cache.clear()
    },

    async describe() {
      const privacy = deps.getPrivacy()
      if (!privacy) return fail('no_provider')
      const eyesMode = privacy.eyesMode
      if (eyesMode === 'off') return fail('eyes_off')

      let windowTitle: string | undefined
      if (eyesMode === 'window') {
        let title: string | null = null
        try {
          title = await deps.getActiveWindowTitle()
        } catch {
          title = null
        }
        // Window mode: only the focused window, and only when the user authorized that title.
        if (!title || !privacy.canObserveScreen(title)) return fail('window_not_authorized')
        windowTitle = title
      } else if (!privacy.canObserveScreen()) {
        return fail('eyes_off')
      }

      const provider = deps.getProvider()
      if (!provider) return fail('no_provider')
      const settings = deps.getSettings()
      const baseUrl = resolveVisionBaseUrl(settings, deps.engine)
      if (!baseUrl) return fail('engine_unavailable')

      const mode: ScreenCaptureMode = eyesMode
      const startedAt = now()
      deps.emit({ type: 'vision:capture', active: true, source: mode })
      try {
        let frame: Awaited<ReturnType<ScreenCaptureProvider['capture']>>
        try {
          frame = await provider.capture(mode, windowTitle)
        } catch {
          frame = null
        }
        if (!frame || typeof frame.pngBase64 !== 'string' || frame.pngBase64.length === 0) {
          return fail('capture_failed')
        }
        const key = createHash('sha256').update(frame.pngBase64).digest('hex')
        const t = now()
        pruneCache(t)
        const hit = cache.get(key)
        if (hit && t - hit.at < cacheTtlMs) {
          return { ok: true, text: hit.text, source: frame.source, cached: true, latencyMs: now() - startedAt }
        }
        let raw: string
        try {
          raw = await requestDescription(baseUrl, frame.pngBase64, settings)
        } catch (err) {
          return fail(err instanceof VisionTimeoutError ? 'timeout' : 'error')
        }
        const text = cleanDescription(raw)
        if (!text) return fail('error')
        cache.set(key, { text, at: now() })
        return { ok: true, text, source: frame.source, cached: false, latencyMs: now() - startedAt }
      } finally {
        deps.emit({ type: 'vision:capture', active: false, source: mode })
      }
    },
  }
}

/** PT visual-intent check for the no-tools path (`[Tela] …` context). */
const VISUAL_INTENT_RE =
  /(?<![\p{L}\p{N}])(tela|olha|olhe|olhar|olhada|veja|v[eê] isso|v[eê] a[ií]|enxerga|o que aparece|o que (?:voc[eê]|c[eê]) (?:t[aá] )?vendo)(?![\p{L}\p{N}])/iu

export function hasVisualIntent(text: string): boolean {
  return VISUAL_INTENT_RE.test(text)
}
