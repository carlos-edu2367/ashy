import * as v from 'valibot'

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high'

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ToolCallDescriptor {
  toolCallId: string
  toolName: string
  argsText: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: ToolCallDescriptor[]
}

export type AnyValibotSchema = v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>

export interface ToolExecutionContext {
  toolCallId: string
  stepIndex: number
  signal?: AbortSignal
}

export interface ToolDefinition<
  TSchema extends AnyValibotSchema = AnyValibotSchema,
  TResult = unknown,
> {
  name: string
  description: string
  parameters: TSchema
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (args: any, context: ToolExecutionContext) => Promise<TResult> | TResult
}

export function defineTool<TSchema extends AnyValibotSchema, TResult>(
  definition: {
    name: string
    description: string
    parameters: TSchema
    execute: (
      args: v.InferOutput<TSchema>,
      context: ToolExecutionContext,
    ) => Promise<TResult> | TResult
  },
): ToolDefinition<TSchema, TResult> {
  if (!definition.name || typeof definition.name !== 'string') {
    throw new TypeError('defineTool requires a non-empty string name')
  }
  return Object.freeze({ ...definition })
}

export type LanguageModelEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      argsText: string
    }
  | {
      type: 'finish'
      finishReason?: string
      usage?: TokenUsage
    }
  | {
      type: 'error'
      error: unknown
    }

export interface LanguageModelRequest {
  messages: ChatMessage[]
  tools?: ToolDefinition<AnyValibotSchema, unknown>[]
  system?: string
  temperature?: number
  maxTokens?: number
  reasoningEffort?: ReasoningEffort
  signal?: AbortSignal
}

export type LanguageModel = ((
  options: LanguageModelRequest,
) => Promise<ReadableStream<LanguageModelEvent>>) & {
  modelId?: string
  provider?: string
}

export interface PreToolCallContext {
  toolCallId: string
  toolName: string
  args: unknown
  stepIndex: number
}

export interface PreToolCallDecision {
  allow?: boolean
  reason?: string
  args?: unknown
}

export interface PostToolCallContext {
  toolCallId: string
  toolName: string
  args: unknown
  result: unknown
  isError: boolean
  stepIndex: number
}

export interface StreamTextOptions {
  messages: ChatMessage[]
  system?: string
  tools?: ToolDefinition<AnyValibotSchema, unknown>[]
  maxSteps?: number
  temperature?: number
  maxTokens?: number
  reasoningEffort?: ReasoningEffort
  signal?: AbortSignal
  preToolCall?: (
    ctx: PreToolCallContext,
  ) => Promise<void | PreToolCallDecision> | void | PreToolCallDecision
  postToolCall?: (ctx: PostToolCallContext) => Promise<void> | void
}

export type TextStreamEvent =
  | { type: 'text-delta'; text: string; stepIndex: number }
  | { type: 'reasoning-delta'; text: string; stepIndex: number }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      argsText: string
      stepIndex: number
    }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      args: unknown
      result: unknown
      isError: boolean
      stepIndex: number
    }
  | {
      type: 'step-finish'
      stepIndex: number
      text: string
      reasoning: string
      toolCalls: ToolCallDescriptor[]
      finishReason: string
    }
  | {
      type: 'finish'
      finishReason: string
      usage?: TokenUsage
      steps: StepSummary[]
    }
  | {
      type: 'error'
      error: string
      stepIndex: number
    }

export interface ToolResultRecord {
  toolCallId: string
  toolName: string
  args: unknown
  result: unknown
  isError: boolean
  stepIndex: number
}

export interface StepSummary {
  stepIndex: number
  text: string
  reasoning: string
  toolCalls: ToolCallDescriptor[]
  toolResults: ToolResultRecord[]
  finishReason: string
}

export type StreamTextResult = ReadableStream<TextStreamEvent> & {
  readonly fullStream: ReadableStream<TextStreamEvent>
  readonly textPromise: Promise<string>
  readonly reasoningPromise: Promise<string>
  readonly stepsPromise: Promise<StepSummary[]>
  readonly messagesPromise: Promise<ChatMessage[]>
}

export interface GenerateTextResult {
  text: string
  reasoning: string
  toolCalls: ToolCallDescriptor[]
  toolResults: ToolResultRecord[]
  steps: StepSummary[]
  messages: ChatMessage[]
  finishReason: string
  usage?: TokenUsage
}

function formatValibotIssues(toolName: string, issues: v.BaseIssue<unknown>[]): string {
  const details = issues
    .map((issue) => {
      const pathStr = issue.path
        ?.map((p) => String(p.key ?? ''))
        .filter(Boolean)
        .join('.')
      return pathStr ? `${pathStr}: ${issue.message}` : issue.message
    })
    .join('; ')
  return `Validation error for tool "${toolName}": ${details}`
}

function serializeToolContent(result: unknown, isError: boolean): string {
  if (typeof result === 'string') {
    return isError ? JSON.stringify({ isError: true, error: result }) : result
  }
  try {
    return JSON.stringify(isError ? { isError: true, error: result } : result)
  } catch {
    return String(result)
  }
}

/**
 * Multi-step streaming LLM execution with Valibot tool validation, `highWaterMark: 0` backpressure,
 * and adversarial tool resilience (self-correction on hallucinated tool names, invalid JSON,
 * schema validation errors, and runtime tool exceptions).
 */
export function streamText(
  model: LanguageModel,
  options: StreamTextOptions,
): StreamTextResult {
  const maxSteps = Math.max(1, options.maxSteps ?? 5)
  const toolMap = new Map<string, ToolDefinition<AnyValibotSchema, unknown>>()
  for (const tool of options.tools ?? []) {
    toolMap.set(tool.name, tool)
  }

  const conversation: ChatMessage[] = options.messages.map((m) => ({ ...m }))

  let resolveText!: (value: string) => void
  let rejectText!: (reason?: unknown) => void
  const rawTextPromise = new Promise<string>((res, rej) => {
    resolveText = res
    rejectText = rej
  })

  let resolveReasoning!: (value: string) => void
  const rawReasoningPromise = new Promise<string>((res) => {
    resolveReasoning = res
  })

  let resolveSteps!: (value: StepSummary[]) => void
  const rawStepsPromise = new Promise<StepSummary[]>((res) => {
    resolveSteps = res
  })

  let resolveMessages!: (value: ChatMessage[]) => void
  const rawMessagesPromise = new Promise<ChatMessage[]>((res) => {
    resolveMessages = res
  })

  let fullText = ''
  let fullReasoning = ''
  const steps: StepSummary[] = []
  let lastUsage: TokenUsage | undefined
  let lastFinishReason = 'stop'

  async function* generateEvents(): AsyncGenerator<TextStreamEvent, void, unknown> {
    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
      let stepText = ''
      let stepReasoning = ''
      const stepToolCalls: ToolCallDescriptor[] = []
      const stepToolResults: ToolResultRecord[] = []
      let stepFinishReason = 'stop'

      let modelStream: ReadableStream<LanguageModelEvent>
      try {
        modelStream = await model({
          messages: conversation.map((m) => ({ ...m })),
          tools: options.tools,
          system: options.system,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          reasoningEffort: options.reasoningEffort,
          signal: options.signal,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        yield { type: 'error', error: message, stepIndex }
        lastFinishReason = 'error'
        break
      }

      const reader = modelStream.getReader()
      let inInlineReasoning = false
      let inlineTagCandidate = ''
      const openTags = ['<think>', '<thinking>', '<reasoning>']
      const closeTags = ['</think>', '</thinking>', '</reasoning>']

      function splitInlineReasoning(chunk: string): Array<{ kind: 'text' | 'reasoning'; text: string }> {
        const out: Array<{ kind: 'text' | 'reasoning'; text: string }> = []
        let buf = ''

        const pushBuf = (kind: 'text' | 'reasoning') => {
          if (buf.length > 0) {
            out.push({ kind, text: buf })
            buf = ''
          }
        }

        for (let i = 0; i < chunk.length; i++) {
          const ch = chunk[i]!
          if (inlineTagCandidate.length === 0) {
            if (ch === '<') {
              inlineTagCandidate = '<'
            } else {
              buf += ch
            }
            continue
          }

          const next = inlineTagCandidate + ch
          const lower = next.toLowerCase()
          const target = inInlineReasoning ? closeTags : openTags

          if (target.some((t) => t === lower)) {
            pushBuf(inInlineReasoning ? 'reasoning' : 'text')
            inInlineReasoning = !inInlineReasoning
            inlineTagCandidate = ''
            continue
          }

          if (target.some((t) => t.startsWith(lower))) {
            inlineTagCandidate = next
            continue
          }

          if (ch === '<') {
            buf += inlineTagCandidate
            inlineTagCandidate = '<'
          } else {
            buf += next
            inlineTagCandidate = ''
          }
        }

        pushBuf(inInlineReasoning ? 'reasoning' : 'text')
        return out
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            if (inlineTagCandidate.length > 0 && !inInlineReasoning) {
              stepText += inlineTagCandidate
              fullText += inlineTagCandidate
              yield { type: 'text-delta', text: inlineTagCandidate, stepIndex }
            }
            inlineTagCandidate = ''
            break
          }
          if (!value) continue

          if (value.type === 'text-delta') {
            if (value.text.length > 0) {
              for (const part of splitInlineReasoning(value.text)) {
                if (part.kind === 'reasoning') {
                  stepReasoning += part.text
                  fullReasoning += part.text
                  yield { type: 'reasoning-delta', text: part.text, stepIndex }
                } else {
                  stepText += part.text
                  fullText += part.text
                  yield { type: 'text-delta', text: part.text, stepIndex }
                }
              }
            }
          } else if (value.type === 'reasoning-delta') {
            if (value.text.length > 0) {
              stepReasoning += value.text
              fullReasoning += value.text
              yield { type: 'reasoning-delta', text: value.text, stepIndex }
            }
          } else if (value.type === 'tool-call') {
            const descriptor: ToolCallDescriptor = {
              toolCallId: value.toolCallId,
              toolName: value.toolName,
              argsText: value.argsText,
            }
            stepToolCalls.push(descriptor)
            yield {
              type: 'tool-call',
              toolCallId: descriptor.toolCallId,
              toolName: descriptor.toolName,
              argsText: descriptor.argsText,
              stepIndex,
            }
          } else if (value.type === 'finish') {
            if (value.finishReason) {
              stepFinishReason = value.finishReason
            }
            if (value.usage) {
              lastUsage = value.usage
            }
          } else if (value.type === 'error') {
            const errMsg =
              value.error instanceof Error ? value.error.message : String(value.error)
            yield { type: 'error', error: errMsg, stepIndex }
            stepFinishReason = 'error'
          }
        }
      } finally {
        reader.releaseLock()
      }

      if (stepToolCalls.length === 0) {
        if (stepText.length > 0) {
          conversation.push({
            role: 'assistant',
            content: stepText,
          })
        }
        lastFinishReason = stepFinishReason
        steps.push({
          stepIndex,
          text: stepText,
          reasoning: stepReasoning,
          toolCalls: [],
          toolResults: [],
          finishReason: stepFinishReason,
        })
        yield {
          type: 'step-finish',
          stepIndex,
          text: stepText,
          reasoning: stepReasoning,
          toolCalls: [],
          finishReason: stepFinishReason,
        }
        break
      }

      // Append the assistant turn with toolCalls before executing tools
      conversation.push({
        role: 'assistant',
        content: stepText,
        toolCalls: [...stepToolCalls],
      })

      for (const tc of stepToolCalls) {
        const toolDef = toolMap.get(tc.toolName)
        let parsedArgs: unknown = undefined
        let toolOutput: unknown = undefined
        let isError = false

        if (!toolDef) {
          isError = true
          const available = Array.from(toolMap.keys()).join(', ') || 'none'
          toolOutput = `Unknown tool "${tc.toolName}". Available tools: ${available}`
        } else {
          let jsonValid = true
          try {
            parsedArgs = tc.argsText.trim().length === 0 ? {} : JSON.parse(tc.argsText)
          } catch (err) {
            jsonValid = false
            isError = true
            const detail = err instanceof Error ? err.message : String(err)
            toolOutput = `Invalid JSON arguments for tool "${tc.toolName}": ${detail}`
          }

          if (jsonValid) {
            const validation = v.safeParse(toolDef.parameters, parsedArgs)
            if (!validation.success) {
              isError = true
              toolOutput = formatValibotIssues(tc.toolName, validation.issues)
            } else {
              let validatedArgs = validation.output
              let allowExecution = true

              if (options.preToolCall) {
                try {
                  const decision = await options.preToolCall({
                    toolCallId: tc.toolCallId,
                    toolName: tc.toolName,
                    args: validatedArgs,
                    stepIndex,
                  })
                  if (decision && decision.allow === false) {
                    allowExecution = false
                    isError = true
                    toolOutput =
                      decision.reason ?? `Tool "${tc.toolName}" blocked by preToolCall hook`
                  } else if (decision && decision.args !== undefined) {
                    validatedArgs = decision.args
                  }
                } catch (hookErr) {
                  allowExecution = false
                  isError = true
                  toolOutput =
                    hookErr instanceof Error ? hookErr.message : String(hookErr)
                }
              }

              if (allowExecution) {
                try {
                  toolOutput = await toolDef.execute(validatedArgs, {
                    toolCallId: tc.toolCallId,
                    stepIndex,
                    signal: options.signal,
                  })
                } catch (execErr) {
                  isError = true
                  toolOutput =
                    execErr instanceof Error ? execErr.message : String(execErr)
                }
              }

              parsedArgs = validatedArgs
            }
          }
        }

        if (options.postToolCall) {
          try {
            await options.postToolCall({
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: parsedArgs,
              result: toolOutput,
              isError,
              stepIndex,
            })
          } catch {
            // Never let a postToolCall observer crash the stream
          }
        }

        const record: ToolResultRecord = {
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: parsedArgs,
          result: toolOutput,
          isError,
          stepIndex,
        }
        stepToolResults.push(record)

        conversation.push({
          role: 'tool',
          toolCallId: tc.toolCallId,
          name: tc.toolName,
          content: serializeToolContent(toolOutput, isError),
        })

        yield {
          type: 'tool-result',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: parsedArgs,
          result: toolOutput,
          isError,
          stepIndex,
        }
      }

      lastFinishReason = 'tool-calls'
      steps.push({
        stepIndex,
        text: stepText,
        reasoning: stepReasoning,
        toolCalls: stepToolCalls,
        toolResults: stepToolResults,
        finishReason: 'tool-calls',
      })

      yield {
        type: 'step-finish',
        stepIndex,
        text: stepText,
        reasoning: stepReasoning,
        toolCalls: stepToolCalls,
        finishReason: 'tool-calls',
      }
    }

    yield {
      type: 'finish',
      finishReason: lastFinishReason,
      usage: lastUsage,
      steps: [...steps],
    }
  }

  const iterator = generateEvents()
  let finalized = false

  function finalizeSuccess(): void {
    if (finalized) return
    finalized = true
    resolveText(fullText)
    resolveReasoning(fullReasoning)
    resolveSteps([...steps])
    resolveMessages(conversation.map((m) => ({ ...m })))
  }

  const stream = new ReadableStream<TextStreamEvent>(
    {
      async pull(controller) {
        try {
          const { done, value } = await iterator.next()
          if (done) {
            finalizeSuccess()
            controller.close()
            return
          }
          controller.enqueue(value)
        } catch (err) {
          if (!finalized) {
            finalized = true
            rejectText(err)
          }
          controller.error(err)
        }
      },
      async cancel() {
        await iterator.return?.()
        finalizeSuccess()
      },
    },
    { highWaterMark: 0 },
  )

  let autoDrainScheduled = false
  function ensureDrainingIfUnlocked(): void {
    if (autoDrainScheduled || finalized || stream.locked) {
      return
    }
    autoDrainScheduled = true
    queueMicrotask(async () => {
      if (finalized || stream.locked) {
        return
      }
      const reader = stream.getReader()
      try {
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
      } finally {
        reader.releaseLock()
      }
    })
  }

  return Object.defineProperties(stream, {
    fullStream: {
      get() {
        return stream
      },
      enumerable: true,
    },
    textPromise: {
      get() {
        ensureDrainingIfUnlocked()
        return rawTextPromise
      },
      enumerable: true,
    },
    reasoningPromise: {
      get() {
        ensureDrainingIfUnlocked()
        return rawReasoningPromise
      },
      enumerable: true,
    },
    stepsPromise: {
      get() {
        ensureDrainingIfUnlocked()
        return rawStepsPromise
      },
      enumerable: true,
    },
    messagesPromise: {
      get() {
        ensureDrainingIfUnlocked()
        return rawMessagesPromise
      },
      enumerable: true,
    },
  }) as StreamTextResult
}

/**
 * Collects a `StreamTextResult` into a single `GenerateTextResult` summary.
 */
export async function collect(streamResult: StreamTextResult): Promise<GenerateTextResult> {
  let text = ''
  let reasoning = ''
  const toolCalls: ToolCallDescriptor[] = []
  const toolResults: ToolResultRecord[] = []
  let steps: StepSummary[] = []
  let finishReason = 'stop'
  let usage: TokenUsage | undefined

  for await (const event of streamResult) {
    if (event.type === 'text-delta') {
      text += event.text
    } else if (event.type === 'reasoning-delta') {
      reasoning += event.text
    } else if (event.type === 'tool-call') {
      toolCalls.push({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argsText: event.argsText,
      })
    } else if (event.type === 'tool-result') {
      toolResults.push({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        result: event.result,
        isError: event.isError,
        stepIndex: event.stepIndex,
      })
    } else if (event.type === 'finish') {
      finishReason = event.finishReason
      usage = event.usage
      steps = event.steps
    }
  }

  const messages = await streamResult.messagesPromise

  return {
    text,
    reasoning,
    toolCalls,
    toolResults,
    steps,
    messages,
    finishReason,
    usage,
  }
}

/**
 * Non-streaming convenience wrapper built directly on top of `streamText` with zero logic duplication.
 */
export async function generateText(
  model: LanguageModel,
  options: StreamTextOptions,
): Promise<GenerateTextResult> {
  return collect(streamText(model, options))
}
