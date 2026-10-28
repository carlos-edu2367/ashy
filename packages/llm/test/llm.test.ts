import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  CONTROL_SENTINEL,
  parseStageSignal,
  createTailSafeMarkerParser,
  createStreamingCategorizer,
  detectAssistantSlop,
  stripLeadingAssistantSlop,
  defineTool,
  streamText,
  generateText,
  createOpenAICompatibleModel,
  createAnthropicMessagesModel,
  createScriptedMockModel,
  type AshyStageSignal,
  type TextStreamEvent,
} from '../src/index'

describe('@ashy/llm — Phase 2: Marker Parser & Tail-Safe Streaming', () => {
  it('parses standard, nested, and mildly malformed <|ACT|>, <|DELAY|>, and <|CALLBACK|> signals', () => {
    const actFlat = parseStageSignal('<|ACT {"emotion":"smug","intensity":0.9,"motion":"tease","durationSec":2.5}|>')
    expect(actFlat).toEqual({
      type: 'act',
      emotion: 'smug',
      intensity: 0.9,
      motion: 'tease',
      durationSec: 2.5,
      raw: '<|ACT {"emotion":"smug","intensity":0.9,"motion":"tease","durationSec":2.5}|>',
    })

    // Nested format: {"emotion":{"name":"smug","intensity":0.9}}
    const actNested = parseStageSignal('ACT {"emotion":{"name":"smug","intensity":0.9},"motion":"wink"}')
    expect(actNested).toEqual({
      type: 'act',
      emotion: 'smug',
      intensity: 0.9,
      motion: 'wink',
      raw: 'ACT {"emotion":{"name":"smug","intensity":0.9},"motion":"wink"}',
    })

    // Mildly malformed JSON: single quotes and trailing comma
    const actMalformedJson = parseStageSignal("<|ACT {'emotion': 'chaotic', 'intensity': 1.4, 'motion': 'spin',}|>")
    expect(actMalformedJson).toEqual({
      type: 'act',
      emotion: 'chaotic',
      intensity: 1, // clamped to [0, 1]
      motion: 'spin',
      raw: "<|ACT {'emotion': 'chaotic', 'intensity': 1.4, 'motion': 'spin',}|>",
    })

    // Delay variants and clamping into [0, 10]
    expect(parseStageSignal('<|DELAY 1.5|>')).toEqual({
      type: 'delay',
      seconds: 1.5,
      raw: '<|DELAY 1.5|>',
    })
    expect(parseStageSignal('<|DELAY:99|>')).toEqual({
      type: 'delay',
      seconds: 10,
      raw: '<|DELAY:99|>',
    })
    expect(parseStageSignal('<|DELAY -3|>')).toEqual({
      type: 'delay',
      seconds: 0,
      raw: '<|DELAY -3|>',
    })

    // Callback variants
    expect(parseStageSignal('<|CALLBACK pizza_bet_2026|>')).toEqual({
      type: 'callback',
      motifId: 'pizza_bet_2026',
      raw: '<|CALLBACK pizza_bet_2026|>',
    })
    expect(parseStageSignal('<|CALLBACK:late_night_bug|>')).toEqual({
      type: 'callback',
      motifId: 'late_night_bug',
      raw: '<|CALLBACK:late_night_bug|>',
    })

    // Unknown / broken signal never throws
    const unknownSig = parseStageSignal('<|FOOBAR ???|>')
    expect(unknownSig.type).toBe('unknown')
  })

  it('streams 1 character per chunk with standard and escaped markers, never leaking < or <{\' and discarding truncated EOF tags', () => {
    let literalOutput = ''
    const signals: AshyStageSignal[] = []

    const parser = createTailSafeMarkerParser({
      onLiteral: (text) => {
        literalOutput += text
      },
      onSpecial: (signal) => {
        signals.push(signal)
      },
    })

    const fullInput =
      'Oi! <|ACT {"emotion":"smug","intensity":0.9}|> Sabia que <{\'|\'}DELAY:1.25{\'|\'}> você voltaria <{\'|\'}CALLBACK:coffee_spill{\'|\'}> hoje.<|ACT {"emotion":"happy"'

    for (const ch of fullInput) {
      parser.write(ch)
      // At no point during streaming may any marker delimiter prefix leak into literalOutput
      expect(literalOutput).not.toContain('<|')
      expect(literalOutput).not.toContain("<{'|'")
      expect(literalOutput).not.toContain('ACT')
      expect(literalOutput).not.toContain('DELAY')
      expect(literalOutput).not.toContain('CALLBACK')
    }

    parser.flush()

    expect(literalOutput).toBe('Oi!  Sabia que  você voltaria  hoje.')
    expect(signals).toHaveLength(3)
    expect(signals[0]).toMatchObject({ type: 'act', emotion: 'smug', intensity: 0.9 })
    expect(signals[1]).toMatchObject({ type: 'delay', seconds: 1.25 })
    expect(signals[2]).toMatchObject({ type: 'callback', motifId: 'coffee_spill' })
  })
})

describe('@ashy/llm — Phase 2: Streaming Categorizer & CONTROL_SENTINEL Synchronization', () => {
  it('separates <think>/<thinking>/<reasoning> blocks and injects CONTROL_SENTINEL at exact speech offsets on 1-char chunks', () => {
    const signalOffsets: Array<{ signal: AshyStageSignal; offset: number }> = []
    let streamedSpeech = ''
    let streamedReasoning = ''

    const categorizer = createStreamingCategorizer({
      onSpeech: (text) => {
        streamedSpeech += text
      },
      onReasoning: (text) => {
        streamedReasoning += text
      },
      onSignal: (signal, speechOffset) => {
        signalOffsets.push({ signal, offset: speechOffset })
      },
    })

    const rawStream =
      '<think>Vou provocar ele sobre o bug.<|ACT {"emotion":"angry"}|></think>' +
      'Olha só' +
      '<|ACT {"emotion":"smug","intensity":0.85,"motion":"tease"}|>' +
      ' quem resolveu aparecer' +
      '<|DELAY 1.2|>' +
      '!' +
      '<reasoning>Será que ele lembra do café?</reasoning>' +
      '<|CALLBACK:coffee_spill|>' +
      ' Tudo bem?' +
      '<|ACT {"emotion":"happy"' // truncated tag at end of stream

    // Stream 1 char at a time
    for (const ch of rawStream) {
      categorizer.write(ch)
      expect(streamedSpeech).not.toContain('<think')
      expect(streamedSpeech).not.toContain('</think')
      expect(streamedSpeech).not.toContain('<reasoning')
      expect(streamedSpeech).not.toContain('Vou provocar')
      expect(streamedSpeech).not.toContain('<|ACT')
    }

    const snapshot = categorizer.flush()

    expect(streamedSpeech).toBe('Olha só quem resolveu aparecer! Tudo bem?')
    expect(snapshot.speech).toBe('Olha só quem resolveu aparecer! Tudo bem?')
    expect(streamedReasoning).toContain('Vou provocar ele sobre o bug.')
    expect(streamedReasoning).toContain('Será que ele lembra do café?')

    // Exact CONTROL_SENTINEL placement in speechWithSentinels:
    // "Olha só" (length 7) -> SENTINEL -> " quem resolveu aparecer" (length 23, total 30) -> SENTINEL -> "!" (length 1, total 31) -> SENTINEL -> " Tudo bem?"
    const expectedWithSentinels =
      `Olha só${CONTROL_SENTINEL} quem resolveu aparecer${CONTROL_SENTINEL}!${CONTROL_SENTINEL} Tudo bem?`
    expect(snapshot.speechWithSentinels).toBe(expectedWithSentinels)

    expect(signalOffsets).toHaveLength(3)
    expect(signalOffsets[0]?.offset).toBe('Olha só'.length)
    expect(signalOffsets[0]?.signal).toMatchObject({ type: 'act', emotion: 'smug', intensity: 0.85, motion: 'tease' })

    expect(signalOffsets[1]?.offset).toBe('Olha só quem resolveu aparecer'.length)
    expect(signalOffsets[1]?.signal).toMatchObject({ type: 'delay', seconds: 1.2 })

    expect(signalOffsets[2]?.offset).toBe('Olha só quem resolveu aparecer!'.length)
    expect(signalOffsets[2]?.signal).toMatchObject({ type: 'callback', motifId: 'coffee_spill' })
  })

  it('never leaks unclosed <think> or partial </think at EOF into speech', () => {
    const categorizer = createStreamingCategorizer()
    const input = 'Oi!<thinking>Pensamento secreto que foi cortado no meio</thin'
    for (const ch of input) {
      categorizer.write(ch)
    }
    const result = categorizer.flush()
    expect(result.speech).toBe('Oi!')
    expect(result.reasoning).toBe('Pensamento secreto que foi cortado no meio')
  })
})

describe('@ashy/llm — Phase 2: Anti-Slop Filter', () => {
  it('detects and strips corporate RLHF openings in PT-BR and EN while preserving authentic casual sentences', () => {
    const ptSlop1 = 'Claro! Ficarei feliz em ajudar. O problema no seu loop é o índice.'
    expect(detectAssistantSlop(ptSlop1).hasSlop).toBe(true)
    expect(stripLeadingAssistantSlop(ptSlop1)).toBe('O problema no seu loop é o índice.')

    const ptSlop2 = 'Com certeza! Aqui está: Você esqueceu de fechar o parêntese.'
    expect(detectAssistantSlop(ptSlop2).hasSlop).toBe(true)
    expect(stripLeadingAssistantSlop(ptSlop2)).toBe('Você esqueceu de fechar o parêntese.')

    const ptSlop3 = 'Ótima pergunta! Como uma inteligência artificial, eu diria que depende. Mas na real é simples.'
    expect(detectAssistantSlop(ptSlop3).hasSlop).toBe(true)
    expect(stripLeadingAssistantSlop(ptSlop3)).toBe('Mas na real é simples.')

    const ptSlop4 = 'Certamente! Vamos lá: Primeiro, rode os testes.'
    expect(detectAssistantSlop(ptSlop4).hasSlop).toBe(true)
    expect(stripLeadingAssistantSlop(ptSlop4)).toBe('Primeiro, rode os testes.')

    const enSlop = "Sure! I'd be happy to help. Great question! You just need to flush the buffer."
    expect(detectAssistantSlop(enSlop).hasSlop).toBe(true)
    expect(stripLeadingAssistantSlop(enSlop)).toBe('You just need to flush the buffer.')

    // Authentic Ashy responses that MUST NOT be stripped
    const authentic1 = 'Claro que você ia quebrar o build às 3 da manhã, né?'
    expect(detectAssistantSlop(authentic1).hasSlop).toBe(false)
    expect(stripLeadingAssistantSlop(authentic1)).toBe(authentic1)

    const authentic2 = 'Pergunta capciosa essa, deixa eu ver o que você aprontou.'
    expect(detectAssistantSlop(authentic2).hasSlop).toBe(false)
    expect(stripLeadingAssistantSlop(authentic2)).toBe(authentic2)
  })
})

describe('@ashy/llm — Phase 2: streamText, generateText & Adversarial Tool Resilience', () => {
  it('recovers when step 1 fails tool validation (isError: true) and step 2 self-corrects arguments and finishes', async () => {
    const setTimerTool = defineTool({
      name: 'set_reminder',
      description: 'Sets a reminder timer in minutes',
      parameters: v.object({
        minutes: v.pipe(v.number(), v.minValue(1), v.maxValue(120)),
        label: v.pipe(v.string(), v.nonEmpty()),
      }),
      execute: async ({ minutes, label }) => {
        return { scheduled: true, minutes, label }
      },
    })

    const mockModel = createScriptedMockModel([
      // Step 0: LLM passes invalid arguments (minutes: -5 fails Valibot minValue(1))
      () => ({
        text: '<think>Vou agendar o lembrete.</think>',
        toolCalls: [
          {
            toolCallId: 'call_bad_1',
            toolName: 'set_reminder',
            argsText: JSON.stringify({ minutes: -5, label: 'Café' }),
          },
        ],
      }),
      // Step 1: LLM sees the tool error in messages, self-corrects to minutes: 15, and calls tool again
      (req) => {
        const lastToolMsg = req.messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_bad_1')
        expect(lastToolMsg).toBeDefined()
        expect(lastToolMsg?.content).toContain('minutes')

        return {
          toolCalls: [
            {
              toolCallId: 'call_good_2',
              toolName: 'set_reminder',
              argsText: JSON.stringify({ minutes: 15, label: 'Café' }),
            },
          ],
        }
      },
      // Step 2: LLM receives valid tool output and produces final response
      (req) => {
        const goodToolMsg = req.messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_good_2')
        expect(goodToolMsg).toBeDefined()
        expect(goodToolMsg?.content).toContain('"scheduled":true')

        return {
          chunks: ['Pronto, ', 'marquei seu lembrete de Café para 15 minutos!'],
        }
      },
    ])

    const preHooks: string[] = []
    const postHooks: Array<{ name: string; isError: boolean }> = []

    const stream = streamText(mockModel, {
      messages: [{ role: 'user', content: 'Me lembra do café daqui a pouco' }],
      tools: [setTimerTool],
      maxSteps: 5,
      preToolCall: ({ toolName }) => {
        preHooks.push(toolName)
      },
      postToolCall: ({ toolName, isError }) => {
        postHooks.push({ name: toolName, isError })
      },
    })

    const events: TextStreamEvent[] = []
    for await (const ev of stream) {
      events.push(ev)
    }

    const finalText = await stream.textPromise
    expect(finalText).toBe('Pronto, marquei seu lembrete de Café para 15 minutos!')

    const toolResults = events.filter(
      (e): e is Extract<TextStreamEvent, { type: 'tool-result' }> => e.type === 'tool-result',
    )
    expect(toolResults).toHaveLength(2)
    expect(toolResults[0]?.isError).toBe(true)
    expect(toolResults[0]?.toolCallId).toBe('call_bad_1')
    expect(toolResults[1]?.isError).toBe(false)
    expect(toolResults[1]?.toolCallId).toBe('call_good_2')
    expect(toolResults[1]?.result).toEqual({ scheduled: true, minutes: 15, label: 'Café' })

    expect(postHooks).toEqual([
      { name: 'set_reminder', isError: true },
      { name: 'set_reminder', isError: false },
    ])
  })

  it('survives hallucinated tool names, malformed JSON tool arguments, and thrown tool errors via generateText', async () => {
    const flakyTool = defineTool({
      name: 'ping_service',
      description: 'Pings a local service',
      parameters: v.object({ host: v.string() }),
      execute: async ({ host }) => {
        if (host === 'crash.local') {
          throw new Error('ECONNREFUSED crash.local')
        }
        return { alive: true, host }
      },
    })

    const mockModel = createScriptedMockModel([
      // Step 0: Hallucinated tool + malformed JSON + throwing execution all in one turn
      {
        toolCalls: [
          { toolCallId: 'c1', toolName: 'non_existent_tool', argsText: '{}' },
          { toolCallId: 'c2', toolName: 'ping_service', argsText: '{broken_json' },
          { toolCallId: 'c3', toolName: 'ping_service', argsText: '{"host":"crash.local"}' },
        ],
      },
      // Step 1: Recovers and calls with valid host
      {
        toolCalls: [{ toolCallId: 'c4', toolName: 'ping_service', argsText: '{"host":"localhost"}' }],
      },
      // Step 2: Final answer
      {
        text: 'Serviço localhost está online.',
      },
    ])

    const result = await generateText(mockModel, {
      messages: [{ role: 'user', content: 'Testa o serviço' }],
      tools: [flakyTool],
    })

    expect(result.text).toBe('Serviço localhost está online.')
    expect(result.toolResults).toHaveLength(4)
    expect(result.toolResults.slice(0, 3).every((r) => r.isError)).toBe(true)
    expect(result.toolResults[3]?.isError).toBe(false)
    expect(result.toolResults[3]?.result).toEqual({ alive: true, host: 'localhost' })
  })
})

describe('@ashy/llm — Phase 2: OpenAI-Compatible & Anthropic SSE Adapters', () => {
  it('parses real chunked SSE streams including reasoning, incremental tool_calls, and [DONE] in createOpenAICompatibleModel', async () => {
    let callCount = 0

    const mockFetch: typeof fetch = async (_input, init) => {
      callCount += 1
      const bodyObj = JSON.parse(String(init?.body ?? '{}'))
      expect(bodyObj.stream).toBe(true)
      expect(bodyObj.model).toBe('deepseek/deepseek-r1')

      const encoder = new TextEncoder()
      const sseFrames =
        callCount === 1
          ? [
              'data: {"choices":[{"delta":{"reasoning_content":"Pensando..."}}]}\n\n',
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_sse_1","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}\n',
              // split mid-frame across chunks!
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"São Paulo\\"}"}}]}}]}\n\n',
              'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
              'data: [DONE]\n\n',
            ]
          : [
              'data: {"choices":[{"delta":{"content":"Em São Paulo "}}]}\n\n',
              'data: {"choices":[{"delta":{"content":"faz 24°C."},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
              'data: [DONE]\n\n',
            ]

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of sseFrames) {
            controller.enqueue(encoder.encode(frame))
          }
          controller.close()
        },
      })

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }

    const weatherTool = defineTool({
      name: 'get_weather',
      description: 'Gets city weather',
      parameters: v.object({ city: v.string() }),
      execute: async ({ city }) => ({ city, tempC: 24 }),
    })

    const model = createOpenAICompatibleModel({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'deepseek/deepseek-r1',
      fetchImpl: mockFetch,
    })

    const res = await generateText(model, {
      messages: [{ role: 'user', content: 'Como está o tempo em SP?' }],
      tools: [weatherTool],
    })

    expect(callCount).toBe(2)
    expect(res.reasoning).toBe('Pensando...')
    expect(res.text).toBe('Em São Paulo faz 24°C.')
    expect(res.toolResults).toHaveLength(1)
    expect(res.toolResults[0]?.result).toEqual({ city: 'São Paulo', tempC: 24 })
  })

  it('parses Anthropic Messages SSE stream with thinking, tool_use, and text_delta', async () => {
    const encoder = new TextEncoder()
    const ssePayload = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Hmm..."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Oi do Claude!"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]

    const model = createAnthropicMessagesModel({
      apiKey: 'anthropic-test',
      model: 'claude-3-7-sonnet-latest',
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (const part of ssePayload) c.enqueue(encoder.encode(part))
              c.close()
            },
          }),
          { status: 200 },
        ),
    })

    const res = await generateText(model, {
      messages: [{ role: 'user', content: 'Oi' }],
    })

    expect(res.reasoning).toBe('Hmm...')
    expect(res.text).toBe('Oi do Claude!')
  })

  it('Adversarial Red-Team: recovers from stray <| before a valid tag, enforces maxSteps cap, and honors preToolCall blocks', async () => {
    // 1. Stray <| followed by a valid <|ACT|> tag
    let literal = ''
    const signals: AshyStageSignal[] = []
    const parser = createTailSafeMarkerParser({
      onLiteral: (t) => {
        literal += t
      },
      onSpecial: (s) => {
        signals.push(s)
      },
    })
    const adversarialStream = 'Olha <| isso e agora <|ACT {"emotion":"tease","intensity":0.8}|> fim!'
    for (const ch of adversarialStream) {
      parser.write(ch)
    }
    parser.flush()
    expect(literal).toBe('Olha <| isso e agora  fim!')
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ type: 'act', emotion: 'tease', intensity: 0.8 })

    // 2. preToolCall policy block + maxSteps cap on infinite tool loop
    const riskyTool = defineTool({
      name: 'run_cmd',
      description: 'Runs a command',
      parameters: v.object({ cmd: v.string() }),
      execute: async ({ cmd }) => ({ ran: cmd }),
    })

    const infiniteLoopModel = createScriptedMockModel([
      {
        toolCalls: [{ toolCallId: 'loop_1', toolName: 'run_cmd', argsText: '{"cmd":"rm -rf /"}' }],
      },
      {
        toolCalls: [{ toolCallId: 'loop_2', toolName: 'run_cmd', argsText: '{"cmd":"echo ok"}' }],
      },
      {
        toolCalls: [{ toolCallId: 'loop_3', toolName: 'run_cmd', argsText: '{"cmd":"echo again"}' }],
      },
    ])

    const loopRes = await generateText(infiniteLoopModel, {
      messages: [{ role: 'user', content: 'Loop test' }],
      tools: [riskyTool],
      maxSteps: 2,
      preToolCall: ({ args }) => {
        const typed = args as { cmd: string }
        if (typed.cmd.includes('rm -rf')) {
          return { allow: false, reason: 'Blocked dangerous command' }
        }
      },
    })

    // Capped at maxSteps = 2 even though model wanted 3+ steps
    expect(loopRes.steps).toHaveLength(2)
    expect(loopRes.toolResults[0]?.isError).toBe(true)
    expect(loopRes.toolResults[0]?.result).toBe('Blocked dangerous command')
    expect(loopRes.toolResults[1]?.isError).toBe(false)
  })
})
