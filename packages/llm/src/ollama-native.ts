import { isLfmOmniModel, valibotSchemaToJsonSchema } from './adapters'
import type {
  AnyValibotSchema,
  ChatMessage,
  LanguageModel,
  LanguageModelEvent,
  LanguageModelRequest,
  ReasoningEffort,
  TokenUsage,
  ToolDefinition,
} from './stream-text'

/**
 * Sampling options sent to Ollama in `options`. These are honored by the native `/api/chat`
 * endpoint (unlike `/v1/chat/completions`, which ignores `top_k` and lets GGUF metadata such as
 * LFM3-Omni's `top_k=1` force greedy decoding).
 */
export interface OllamaNativeSamplingOptions {
  temperature?: number
  top_k?: number
  top_p?: number
  repeat_penalty?: number
  num_ctx?: number
}

export interface OllamaNativeModelConfig {
  /** Any Ollama URL: `http://127.0.0.1:11434`, `.../v1`, `.../api` all resolve to the origin. */
  baseUrl?: string
  model: string
  reasoningEffort?: ReasoningEffort
  /** Ollama `keep_alive` (e.g. `'30m'`, `-1`). Defaults to `'30m'`. */
  keepAlive?: string | number
  /** Overrides for the conversational sampling defaults. */
  options?: OllamaNativeSamplingOptions
  fetchImpl?: typeof fetch
  headers?: Record<string, string>
  apiKey?: string
}

export const OLLAMA_NATIVE_DEFAULT_OPTIONS: Readonly<
  Required<Omit<OllamaNativeSamplingOptions, 'num_ctx'>>
> = Object.freeze({
  temperature: 0.7,
  top_k: 40,
  top_p: 0.9,
  repeat_penalty: 1.1,
})

export const OLLAMA_NATIVE_DEFAULT_KEEP_ALIVE = '30m'

/**
 * Derives the Ollama server origin from any configured base URL.
 * `http://127.0.0.1:11434/v1` -> `http://127.0.0.1:11434`.
 */
export function resolveOllamaOrigin(baseUrl?: string): string {
  const raw = (baseUrl ?? '').trim()
  if (raw.length === 0) return 'http://127.0.0.1:11434'
  try {
    const url = new URL(raw)
    let pathname = url.pathname.replace(/\/+$/, '')
    pathname = pathname.replace(/\/(v1|api)(\/.*)?$/i, '')
    return `${url.origin}${pathname}`
  } catch {
    return raw.replace(/\/+$/, '').replace(/\/(v1|api)(\/.*)?$/i, '')
  }
}

function stripDataUrlPrefix(raw: string): string {
  const trimmed = raw.trim()
  const match = /^data:[^;,]+;base64,([\s\S]+)$/i.exec(trimmed)
  return match ? match[1]!.trim() : trimmed
}

function isRemoteUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw.trim())
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/**
 * Raw PCM16 cannot be decoded by Ollama, so wrap it in a RIFF/WAV header
 * (mono, 16 kHz — the capture rate used by the voice pipeline). Already-RIFF data passes through.
 */
export function wrapPcm16Base64AsWav(pcmBase64: string, sampleRate = 16000): string {
  let pcm: Uint8Array
  try {
    pcm = base64ToBytes(pcmBase64)
  } catch {
    return pcmBase64
  }
  if (pcm.length >= 4 && pcm[0] === 0x52 && pcm[1] === 0x49 && pcm[2] === 0x46 && pcm[3] === 0x46) {
    return pcmBase64
  }
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, pcm.length, true)
  const wav = new Uint8Array(44 + pcm.length)
  wav.set(new Uint8Array(header), 0)
  wav.set(pcm, 44)
  return bytesToBase64(wav)
}

function parseArgsObject(argsText: string): Record<string, unknown> {
  if (!argsText || argsText.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(argsText) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through
  }
  return {}
}

/**
 * Serializes pipeline messages into Ollama `/api/chat` messages.
 * - text parts are concatenated into `content`;
 * - images (data URLs / raw base64) and video frames go into `images` (base64, no prefix);
 * - `input_audio` (WAV base64) also goes into `images` (documented workaround, ollama#19378);
 * - assistant tool calls carry `function.arguments` as an OBJECT;
 * - tool results use role `tool` with `tool_name`.
 */
export function serializeOllamaNativeMessages(
  messages: ChatMessage[],
  system?: string,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []
  if (system && system.trim().length > 0) {
    result.push({ role: 'system', content: system })
  }

  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      result.push({
        role: 'assistant',
        content: m.content ?? '',
        tool_calls: m.toolCalls.map((tc) => ({
          function: {
            name: tc.toolName,
            arguments: parseArgsObject(tc.argsText),
          },
        })),
      })
      continue
    }

    if (m.role === 'tool') {
      const toolMsg: Record<string, unknown> = { role: 'tool', content: m.content }
      if (m.name) toolMsg.tool_name = m.name
      result.push(toolMsg)
      continue
    }

    if (m.parts && m.parts.length > 0) {
      const texts: string[] = []
      const images: string[] = []
      for (const part of m.parts) {
        if (part.type === 'text') {
          texts.push(part.text)
        } else if (part.type === 'image_url') {
          const url = part.imageUrl.url
          if (isRemoteUrl(url)) {
            // Ollama only accepts inline base64 images; keep a textual reference instead.
            texts.push(`[Image: ${url}]`)
          } else {
            images.push(stripDataUrlPrefix(url))
          }
        } else if (part.type === 'input_audio') {
          const audioB64 = stripDataUrlPrefix(part.inputAudio.data)
          images.push(part.inputAudio.format === 'pcm16' ? wrapPcm16Base64AsWav(audioB64) : audioB64)
        } else if (part.type === 'video_frame') {
          texts.push(`[Video Frame @ ${Math.round(part.videoFrame.timestampMs)}ms]`)
          images.push(stripDataUrlPrefix(part.videoFrame.dataUrl))
        }
      }
      const content = texts.length > 0 ? texts.join('\n') : m.content
      const msg: Record<string, unknown> = { role: m.role, content: content ?? '' }
      if (images.length > 0) msg.images = images
      result.push(msg)
      continue
    }

    result.push({ role: m.role, content: m.content })
  }

  return result
}

function serializeOllamaTools(
  tools?: ToolDefinition<AnyValibotSchema, unknown>[],
): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: valibotSchemaToJsonSchema(t.parameters),
    },
  }))
}

function resolveThinkFlag(
  modelId: string,
  effort: ReasoningEffort | undefined,
): boolean | undefined {
  // LFM3-Omni has no thinking mode; mirror the OpenAI-compatible adapter and force it off.
  if (isLfmOmniModel(modelId)) return false
  if (effort === undefined) return undefined
  return effort !== 'none'
}

/**
 * Creates a native Ollama `/api/chat` NDJSON streaming adapter implementing the same
 * `LanguageModel` contract as `createOpenAICompatibleModel`.
 */
export function createOllamaNativeModel(config: OllamaNativeModelConfig): LanguageModel {
  const origin = resolveOllamaOrigin(config.baseUrl)
  const endpoint = `${origin}/api/chat`
  const fetchFn = config.fetchImpl ?? globalThis.fetch

  const modelFn: LanguageModel = async (request: LanguageModelRequest) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...config.headers,
    }
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`
    }

    const options: Record<string, unknown> = {
      ...OLLAMA_NATIVE_DEFAULT_OPTIONS,
      ...stripUndefined(config.options ?? {}),
    }
    if (request.temperature !== undefined) {
      options.temperature = request.temperature
    }
    if (request.maxTokens !== undefined) {
      options.num_predict = request.maxTokens
    }

    const bodyPayload: Record<string, unknown> = {
      model: config.model,
      messages: serializeOllamaNativeMessages(request.messages, request.system),
      stream: true,
      keep_alive: config.keepAlive ?? OLLAMA_NATIVE_DEFAULT_KEEP_ALIVE,
      options,
    }
    const serializedTools = serializeOllamaTools(request.tools)
    if (serializedTools) {
      bodyPayload.tools = serializedTools
    }
    const think = resolveThinkFlag(config.model, request.reasoningEffort ?? config.reasoningEffort)
    if (think !== undefined) {
      bodyPayload.think = think
    }
    // `modalities` / `audioOutput` are intentionally ignored: /api/chat has no audio output.

    let response = await fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
      signal: request.signal,
    })

    // Models without thinking support reject `think:true` with HTTP 400; retry without it.
    if (
      response.status === 400 &&
      bodyPayload.think === true &&
      !request.signal?.aborted
    ) {
      const errorText = await response.text().catch(() => '')
      if (/think/i.test(errorText)) {
        const fallback = { ...bodyPayload }
        delete fallback.think
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(fallback),
          signal: request.signal,
        })
      } else {
        throw new Error(`Ollama HTTP 400: ${extractErrorMessage(errorText) || response.statusText}`)
      }
    }

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => response.statusText)
      throw new Error(
        `Ollama HTTP ${response.status}: ${extractErrorMessage(errorText) || response.statusText}`,
      )
    }

    const byteReader = response.body.getReader()
    const decoder = new TextDecoder()
    let lineBuffer = ''
    let toolCallCounter = 0
    const pendingToolCalls: Array<{ id: string; name: string; argsText: string }> = []
    let finishReason = 'stop'
    let usage: TokenUsage | undefined
    let streamFinished = false

    /** Returns true when the `done:true` frame was processed. */
    function processLine(
      line: string,
      controller: ReadableStreamDefaultController<LanguageModelEvent>,
    ): boolean {
      const trimmed = line.trim()
      if (trimmed.length === 0) return false

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        return false
      }

      if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        controller.enqueue({ type: 'error', error: new Error(`Ollama: ${parsed.error}`) })
        finishReason = 'error'
        return true
      }

      const message = parsed.message as Record<string, unknown> | undefined
      if (message && typeof message === 'object') {
        if (typeof message.thinking === 'string' && message.thinking.length > 0) {
          controller.enqueue({ type: 'reasoning-delta', text: message.thinking })
        }
        if (typeof message.content === 'string' && message.content.length > 0) {
          controller.enqueue({ type: 'text-delta', text: message.content })
        }
        if (Array.isArray(message.tool_calls)) {
          for (const rawTc of message.tool_calls) {
            if (typeof rawTc !== 'object' || rawTc === null) continue
            const tcObj = rawTc as Record<string, unknown>
            const fnObj = (tcObj.function ?? {}) as Record<string, unknown>
            const name = typeof fnObj.name === 'string' ? fnObj.name : ''
            if (name.length === 0) continue
            const rawArgs = fnObj.arguments
            let argsText: string
            if (typeof rawArgs === 'string') {
              argsText = rawArgs
            } else if (rawArgs === undefined || rawArgs === null) {
              argsText = '{}'
            } else {
              try {
                argsText = JSON.stringify(rawArgs)
              } catch {
                argsText = '{}'
              }
            }
            const id =
              typeof tcObj.id === 'string' && tcObj.id.length > 0
                ? tcObj.id
                : `call_${toolCallCounter}`
            toolCallCounter++
            pendingToolCalls.push({ id, name, argsText })
          }
        }
      }

      if (parsed.done === true) {
        if (typeof parsed.done_reason === 'string' && parsed.done_reason.length > 0) {
          finishReason = parsed.done_reason
        }
        const promptTokens = Number(parsed.prompt_eval_count ?? 0)
        const completionTokens = Number(parsed.eval_count ?? 0)
        if (parsed.prompt_eval_count !== undefined || parsed.eval_count !== undefined) {
          usage = {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          }
        }
        return true
      }
      return false
    }

    function flushAndFinish(controller: ReadableStreamDefaultController<LanguageModelEvent>): void {
      if (streamFinished) return
      streamFinished = true
      for (const tc of pendingToolCalls) {
        controller.enqueue({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.name,
          argsText: tc.argsText,
        })
      }
      if (pendingToolCalls.length > 0 && finishReason === 'stop') {
        finishReason = 'tool_calls'
      }
      pendingToolCalls.length = 0
      controller.enqueue({ type: 'finish', finishReason, usage })
      controller.close()
    }

    return new ReadableStream<LanguageModelEvent>({
      async pull(controller) {
        try {
          while (true) {
            const newlineIdx = lineBuffer.indexOf('\n')
            if (newlineIdx !== -1) {
              const line = lineBuffer.slice(0, newlineIdx)
              lineBuffer = lineBuffer.slice(newlineIdx + 1)
              if (processLine(line, controller)) {
                flushAndFinish(controller)
                await byteReader.cancel().catch(() => undefined)
                return
              }
              continue
            }

            const { done, value } = await byteReader.read()
            if (done) {
              lineBuffer += decoder.decode()
              if (lineBuffer.trim().length > 0) {
                const rest = lineBuffer
                lineBuffer = ''
                for (const l of rest.split('\n')) {
                  if (processLine(l, controller)) break
                }
              }
              flushAndFinish(controller)
              return
            }
            lineBuffer += decoder.decode(value, { stream: true })
          }
        } catch (err) {
          if (!streamFinished) {
            streamFinished = true
            controller.enqueue({ type: 'error', error: err })
            controller.close()
          }
        }
      },
      async cancel() {
        await byteReader.cancel().catch(() => undefined)
      },
    })
  }

  modelFn.modelId = config.model
  modelFn.provider = 'ollama-native'
  return modelFn
}

function stripUndefined<T extends object>(input: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      ;(out as Record<string, unknown>)[key] = value
    }
  }
  return out
}

function extractErrorMessage(body: string): string {
  const trimmed = body.trim()
  if (trimmed.length === 0) return ''
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
      return (parsed as { error: string }).error
    }
  } catch {
    // not JSON
  }
  return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed
}
