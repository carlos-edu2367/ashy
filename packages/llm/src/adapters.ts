import type {
  AnyValibotSchema,
  ChatMessage,
  LanguageModel,
  LanguageModelEvent,
  LanguageModelRequest,
  TokenUsage,
  ToolDefinition,
} from './stream-text'

export interface OpenAICompatibleModelConfig {
  baseUrl?: string
  apiKey?: string
  model: string
  fetchImpl?: typeof fetch
  headers?: Record<string, string>
}

export interface AnthropicMessagesModelConfig {
  baseUrl?: string
  apiKey?: string
  model: string
  maxTokens?: number
  anthropicVersion?: string
  fetchImpl?: typeof fetch
  headers?: Record<string, string>
}

export interface ScriptedToolCallInput {
  toolCallId?: string
  id?: string
  toolName?: string
  name?: string
  argsText?: string
  args?: unknown
}

export interface ScriptedStepConfig {
  text?: string
  chunks?: string[]
  reasoning?: string | string[]
  toolCalls?: ScriptedToolCallInput[]
  events?: LanguageModelEvent[]
  finishReason?: string
  usage?: TokenUsage
}

export type ScriptedStep =
  | ScriptedStepConfig
  | ((
      request: LanguageModelRequest,
      stepIndex: number,
    ) => ScriptedStepConfig | Promise<ScriptedStepConfig>)

/**
 * Lightweight Valibot schema introspector to produce JSON Schema for tool declarations.
 */
export function valibotSchemaToJsonSchema(schema: AnyValibotSchema): Record<string, unknown> {
  const raw = schema as unknown as Record<string, unknown>
  const schemaType = raw.type as string | undefined

  if (schemaType === 'optional' || schemaType === 'nullable' || schemaType === 'nullish') {
    const wrapped = raw.wrapped as AnyValibotSchema | undefined
    return wrapped ? valibotSchemaToJsonSchema(wrapped) : { type: 'string' }
  }

  if (schemaType === 'object' && typeof raw.entries === 'object' && raw.entries !== null) {
    const entries = raw.entries as Record<string, AnyValibotSchema>
    const properties: Record<string, unknown> = {}
    const required: string[] = []

    for (const [key, entrySchema] of Object.entries(entries)) {
      const entryRaw = entrySchema as unknown as Record<string, unknown>
      if (entryRaw.type !== 'optional' && entryRaw.type !== 'nullish') {
        required.push(key)
      }
      properties[key] = valibotSchemaToJsonSchema(entrySchema)
    }

    return {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    }
  }

  if (schemaType === 'string') return { type: 'string' }
  if (schemaType === 'number') return { type: 'number' }
  if (schemaType === 'boolean') return { type: 'boolean' }
  if (schemaType === 'picklist' && Array.isArray(raw.options)) {
    return { type: 'string', enum: raw.options }
  }
  if (schemaType === 'array' && raw.item) {
    return {
      type: 'array',
      items: valibotSchemaToJsonSchema(raw.item as AnyValibotSchema),
    }
  }

  return { type: 'object' }
}

function serializeOpenAIMessages(messages: ChatMessage[], system?: string): unknown[] {
  const result: unknown[] = []
  if (system && system.trim().length > 0) {
    result.push({ role: 'system', content: system })
  }

  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      result.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.toolCallId,
          type: 'function',
          function: {
            name: tc.toolName,
            arguments: tc.argsText,
          },
        })),
      })
    } else if (m.role === 'tool') {
      result.push({
        role: 'tool',
        tool_call_id: m.toolCallId ?? '',
        name: m.name,
        content: m.content,
      })
    } else {
      result.push({
        role: m.role,
        content: m.content,
      })
    }
  }

  return result
}

function serializeOpenAITools(
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

/**
 * Creates an OpenAI-compatible SSE streaming model adapter (OpenRouter, OpenAI, NVIDIA NIM, Ollama, vLLM).
 */
export function createOpenAICompatibleModel(
  config: OpenAICompatibleModelConfig,
): LanguageModel {
  const baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  const fetchFn = config.fetchImpl ?? globalThis.fetch

  const modelFn: LanguageModel = async (request: LanguageModelRequest) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...config.headers,
    }
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`
    }

    const bodyPayload: Record<string, unknown> = {
      model: config.model,
      messages: serializeOpenAIMessages(request.messages, request.system),
      stream: true,
    }
    const serializedTools = serializeOpenAITools(request.tools)
    if (serializedTools) {
      bodyPayload.tools = serializedTools
    }
    if (request.temperature !== undefined) {
      bodyPayload.temperature = request.temperature
    }
    if (request.maxTokens !== undefined) {
      bodyPayload.max_tokens = request.maxTokens
    }

    const response = await fetchFn(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
      signal: request.signal,
    })

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => response.statusText)
      throw new Error(`OpenAI-compatible HTTP ${response.status}: ${errorText}`)
    }

    const byteReader = response.body.getReader()
    const decoder = new TextDecoder()
    let lineBuffer = ''

    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; argsText: string }
    >()
    let finishReason = 'stop'
    let usage: TokenUsage | undefined
    let streamFinished = false

    function processSseLine(
      line: string,
      controller: ReadableStreamDefaultController<LanguageModelEvent>,
    ): boolean {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) {
        return false
      }
      const dataStr = trimmed.slice(5).trim()
      if (dataStr === '[DONE]') {
        return true
      }

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(dataStr) as Record<string, unknown>
      } catch {
        return false
      }

      if (typeof parsed.usage === 'object' && parsed.usage !== null) {
        const u = parsed.usage as Record<string, unknown>
        usage = {
          promptTokens: Number(u.prompt_tokens ?? 0),
          completionTokens: Number(u.completion_tokens ?? 0),
          totalTokens: Number(u.total_tokens ?? 0),
        }
      }

      const choices = parsed.choices
      if (!Array.isArray(choices) || choices.length === 0) {
        return false
      }

      const choice = choices[0] as Record<string, unknown>
      if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
        finishReason = choice.finish_reason
      }

      const delta = choice.delta as Record<string, unknown> | undefined
      if (!delta) {
        return false
      }

      const reasoningChunk =
        (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : undefined) ??
        (typeof delta.reasoning === 'string' ? delta.reasoning : undefined)
      if (reasoningChunk && reasoningChunk.length > 0) {
        controller.enqueue({ type: 'reasoning-delta', text: reasoningChunk })
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        controller.enqueue({ type: 'text-delta', text: delta.content })
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const rawTc of delta.tool_calls) {
          if (typeof rawTc !== 'object' || rawTc === null) continue
          const tcObj = rawTc as Record<string, unknown>
          const idx = typeof tcObj.index === 'number' ? tcObj.index : 0
          const existing = pendingToolCalls.get(idx) ?? {
            id: `call_${idx}`,
            name: '',
            argsText: '',
          }
          if (typeof tcObj.id === 'string' && tcObj.id.length > 0) {
            existing.id = tcObj.id
          }
          if (typeof tcObj.function === 'object' && tcObj.function !== null) {
            const fnObj = tcObj.function as Record<string, unknown>
            if (typeof fnObj.name === 'string' && fnObj.name.length > 0) {
              existing.name += fnObj.name
            }
            if (typeof fnObj.arguments === 'string' && fnObj.arguments.length > 0) {
              existing.argsText += fnObj.arguments
            }
          }
          pendingToolCalls.set(idx, existing)
        }
      }

      return false
    }

    function flushToolCallsAndFinish(
      controller: ReadableStreamDefaultController<LanguageModelEvent>,
    ): void {
      if (streamFinished) return
      streamFinished = true

      const sortedIndices = Array.from(pendingToolCalls.keys()).sort((a, b) => a - b)
      for (const idx of sortedIndices) {
        const tc = pendingToolCalls.get(idx)!
        if (tc.name.length > 0) {
          controller.enqueue({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.name,
            argsText: tc.argsText,
          })
        }
      }
      pendingToolCalls.clear()

      controller.enqueue({
        type: 'finish',
        finishReason,
        usage,
      })
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
              const isDone = processSseLine(line, controller)
              if (isDone) {
                flushToolCallsAndFinish(controller)
                await byteReader.cancel().catch(() => undefined)
                return
              }
              continue
            }

            const { done, value } = await byteReader.read()
            if (done) {
              lineBuffer += decoder.decode()
              if (lineBuffer.trim().length > 0) {
                const lines = lineBuffer.split('\n')
                lineBuffer = ''
                for (const l of lines) {
                  if (processSseLine(l, controller)) {
                    break
                  }
                }
              }
              flushToolCallsAndFinish(controller)
              return
            }

            lineBuffer += decoder.decode(value, { stream: true })
          }
        } catch (err) {
          controller.enqueue({ type: 'error', error: err })
          controller.close()
        }
      },
      async cancel() {
        await byteReader.cancel().catch(() => undefined)
      },
    })
  }

  modelFn.modelId = config.model
  modelFn.provider = 'openai-compatible'
  return modelFn
}

/**
 * Creates an Anthropic Messages API SSE streaming model adapter.
 */
export function createAnthropicMessagesModel(
  config: AnthropicMessagesModelConfig,
): LanguageModel {
  const baseUrl = (config.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '')
  const fetchFn = config.fetchImpl ?? globalThis.fetch

  const modelFn: LanguageModel = async (request: LanguageModelRequest) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': config.anthropicVersion ?? '2023-06-01',
      ...config.headers,
    }
    if (config.apiKey) {
      headers['x-api-key'] = config.apiKey
    }

    const systemParts: string[] = []
    if (request.system) systemParts.push(request.system)

    const anthropicMessages: unknown[] = []
    for (const m of request.messages) {
      if (m.role === 'system') {
        systemParts.push(m.content)
        continue
      }
      if (m.role === 'tool') {
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.toolCallId ?? '',
              content: m.content,
            },
          ],
        })
        continue
      }
      anthropicMessages.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })
    }

    const bodyPayload: Record<string, unknown> = {
      model: config.model,
      max_tokens: request.maxTokens ?? config.maxTokens ?? 4096,
      messages: anthropicMessages,
      stream: true,
    }
    if (systemParts.length > 0) {
      bodyPayload.system = systemParts.join('\n\n')
    }
    if (request.tools && request.tools.length > 0) {
      bodyPayload.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: valibotSchemaToJsonSchema(t.parameters),
      }))
    }

    const response = await fetchFn(`${baseUrl}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
      signal: request.signal,
    })

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => response.statusText)
      throw new Error(`Anthropic HTTP ${response.status}: ${errorText}`)
    }

    const byteReader = response.body.getReader()
    const decoder = new TextDecoder()
    let lineBuffer = ''

    const activeToolBlocks = new Map<
      number,
      { id: string; name: string; argsText: string }
    >()
    let finishReason = 'stop'

    function processLine(
      line: string,
      controller: ReadableStreamDefaultController<LanguageModelEvent>,
    ): boolean {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) {
        return false
      }
      const dataStr = trimmed.slice(5).trim()
      if (!dataStr || dataStr === '[DONE]') {
        return false
      }

      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(dataStr) as Record<string, unknown>
      } catch {
        return false
      }

      const eventType = payload.type as string | undefined
      const index = typeof payload.index === 'number' ? payload.index : 0

      if (eventType === 'content_block_start') {
        const block = payload.content_block as Record<string, unknown> | undefined
        if (block?.type === 'tool_use') {
          activeToolBlocks.set(index, {
            id: String(block.id ?? `tool_${index}`),
            name: String(block.name ?? ''),
            argsText: '',
          })
        }
      } else if (eventType === 'content_block_delta') {
        const delta = payload.delta as Record<string, unknown> | undefined
        if (!delta) return false

        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          controller.enqueue({ type: 'text-delta', text: delta.text })
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          controller.enqueue({ type: 'reasoning-delta', text: delta.thinking })
        } else if (
          delta.type === 'input_json_delta' &&
          typeof delta.partial_json === 'string'
        ) {
          const block = activeToolBlocks.get(index)
          if (block) {
            block.argsText += delta.partial_json
          }
        }
      } else if (eventType === 'content_block_stop') {
        const block = activeToolBlocks.get(index)
        if (block) {
          activeToolBlocks.delete(index)
          controller.enqueue({
            type: 'tool-call',
            toolCallId: block.id,
            toolName: block.name,
            argsText: block.argsText || '{}',
          })
        }
      } else if (eventType === 'message_delta') {
        const delta = payload.delta as Record<string, unknown> | undefined
        if (typeof delta?.stop_reason === 'string') {
          finishReason = delta.stop_reason
        }
      } else if (eventType === 'message_stop') {
        return true
      }

      return false
    }

    return new ReadableStream<LanguageModelEvent>({
      async pull(controller) {
        try {
          while (true) {
            const nl = lineBuffer.indexOf('\n')
            if (nl !== -1) {
              const line = lineBuffer.slice(0, nl)
              lineBuffer = lineBuffer.slice(nl + 1)
              if (processLine(line, controller)) {
                controller.enqueue({ type: 'finish', finishReason })
                controller.close()
                await byteReader.cancel().catch(() => undefined)
                return
              }
              continue
            }

            const { done, value } = await byteReader.read()
            if (done) {
              lineBuffer += decoder.decode()
              if (lineBuffer.trim().length > 0) {
                for (const l of lineBuffer.split('\n')) {
                  if (processLine(l, controller)) break
                }
                lineBuffer = ''
              }
              controller.enqueue({ type: 'finish', finishReason })
              controller.close()
              return
            }

            lineBuffer += decoder.decode(value, { stream: true })
          }
        } catch (err) {
          controller.enqueue({ type: 'error', error: err })
          controller.close()
        }
      },
      async cancel() {
        await byteReader.cancel().catch(() => undefined)
      },
    })
  }

  modelFn.modelId = config.model
  modelFn.provider = 'anthropic'
  return modelFn
}

/**
 * Deterministic scripted mock model for unit/E2E testing and offline simulation.
 */
export function createScriptedMockModel(
  steps: ScriptedStep[] | ScriptedStep,
): LanguageModel & { readonly calls: LanguageModelRequest[] } {
  const stepList = Array.isArray(steps) ? steps : [steps]
  let callIndex = 0
  const calls: LanguageModelRequest[] = []

  const modelFn = (async (request: LanguageModelRequest) => {
    const currentStepIdx = callIndex
    callIndex += 1
    calls.push({
      ...request,
      messages: request.messages.map((m) => ({ ...m })),
    })

    const stepSpec =
      stepList[Math.min(currentStepIdx, stepList.length - 1)] ?? { text: '' }
    const resolvedConfig =
      typeof stepSpec === 'function'
        ? await stepSpec(request, currentStepIdx)
        : stepSpec

    const events: LanguageModelEvent[] = []

    if (resolvedConfig.events) {
      events.push(...resolvedConfig.events)
    } else {
      if (resolvedConfig.reasoning !== undefined) {
        const reasoningChunks = Array.isArray(resolvedConfig.reasoning)
          ? resolvedConfig.reasoning
          : [resolvedConfig.reasoning]
        for (const r of reasoningChunks) {
          if (r.length > 0) {
            events.push({ type: 'reasoning-delta', text: r })
          }
        }
      }

      if (resolvedConfig.chunks) {
        for (const chunk of resolvedConfig.chunks) {
          if (chunk.length > 0) {
            events.push({ type: 'text-delta', text: chunk })
          }
        }
      } else if (typeof resolvedConfig.text === 'string' && resolvedConfig.text.length > 0) {
        events.push({ type: 'text-delta', text: resolvedConfig.text })
      }

      if (resolvedConfig.toolCalls && resolvedConfig.toolCalls.length > 0) {
        for (let i = 0; i < resolvedConfig.toolCalls.length; i++) {
          const tc = resolvedConfig.toolCalls[i]!
          const toolCallId = tc.toolCallId ?? tc.id ?? `call_${currentStepIdx}_${i}`
          const toolName = tc.toolName ?? tc.name ?? 'unknown_tool'
          const argsText =
            typeof tc.argsText === 'string'
              ? tc.argsText
              : JSON.stringify(tc.args ?? {})
          events.push({
            type: 'tool-call',
            toolCallId,
            toolName,
            argsText,
          })
        }
      }

      events.push({
        type: 'finish',
        finishReason:
          resolvedConfig.finishReason ??
          (resolvedConfig.toolCalls && resolvedConfig.toolCalls.length > 0
            ? 'tool-calls'
            : 'stop'),
        usage: resolvedConfig.usage,
      })
    }

    let idx = 0
    return new ReadableStream<LanguageModelEvent>({
      pull(controller) {
        if (idx >= events.length) {
          controller.close()
          return
        }
        controller.enqueue(events[idx]!)
        idx += 1
      },
    })
  }) as LanguageModel & { readonly calls: LanguageModelRequest[] }

  modelFn.modelId = 'scripted-mock'
  modelFn.provider = 'mock'
  Object.defineProperty(modelFn, 'calls', {
    get() {
      return calls
    },
    enumerable: true,
  })

  return modelFn
}
