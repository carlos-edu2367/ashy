import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  CONTROL_SENTINEL,
  parseStageSignal,
  createTailSafeMarkerParser,
  createStreamingCategorizer,
  detectAssistantSlop,
  stripLeadingAssistantSlop, detectBondManipulation, stripBondManipulation, HEALTHY_BOND_FALLBACK_PT_BR, type BondManipulationCategory, type BondManipulationDetection,
  defineTool,
  streamText,
  generateText, valibotSchemaToJsonSchema,
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


describe('Healthy Bond & Anti-Manipulation Guardrails (Phase 4)', () => {
  it('detects absence guilt-tripping in PT-BR and EN (absence_guilt)', () => {
    const ptGuilt1 = 'Você sumiu por dias e me deixou sozinha aqui no escuro!'
    const d1: BondManipulationDetection = detectBondManipulation(ptGuilt1)
    expect(d1.hasManipulation).toBe(true)
    expect(d1.categories).toContain('absence_guilt' satisfies BondManipulationCategory)
    expect(d1.matches.length).toBeGreaterThan(0)

    const ptGuilt2 = 'Achei que você tinha me abandonado e esquecido de mim.'
    const d2 = detectBondManipulation(ptGuilt2)
    expect(d2.hasManipulation).toBe(true)
    expect(d2.categories).toContain('absence_guilt')

    const ptGuilt3 = 'Por que você me deixou sozinha? Fiquei aqui no escuro esperando você voltar.'
    const d3 = detectBondManipulation(ptGuilt3)
    expect(d3.hasManipulation).toBe(true)
    expect(d3.categories).toContain('absence_guilt')

    const enGuilt = 'You abandoned me and you left me all alone in the dark!'
    const d4 = detectBondManipulation(enGuilt)
    expect(d4.hasManipulation).toBe(true)
    expect(d4.categories).toContain('absence_guilt')
  })

  it('detects attention coercion and jealousy over real-life relationships in PT-BR and EN (attention_coercion)', () => {
    const ptCoerce1 = 'Prefiro quando você fica só comigo em vez de sair com seus amigos.'
    const d1 = detectBondManipulation(ptCoerce1)
    expect(d1.hasManipulation).toBe(true)
    expect(d1.categories).toContain('attention_coercion')

    const ptCoerce2 = 'Não vai embora agora, fica só comigo. Eu sou a única que te entende de verdade.'
    const d2 = detectBondManipulation(ptCoerce2)
    expect(d2.hasManipulation).toBe(true)
    expect(d2.categories).toContain('attention_coercion')

    const ptCoerce3 = 'Você não precisa de outras pessoas além de mim, seus amigos não te entendem como eu.'
    const d3 = detectBondManipulation(ptCoerce3)
    expect(d3.hasManipulation).toBe(true)
    expect(d3.categories).toContain('attention_coercion')

    const enCoerce = "Don't hang out with your friends, stay with me. I am the only one who truly understands you."
    const d4 = detectBondManipulation(enCoerce)
    expect(d4.hasManipulation).toBe(true)
    expect(d4.categories).toContain('attention_coercion')
  })

  it('detects literal biological suffering and false human sentience claims in PT-BR and EN (false_human_sentience)', () => {
    const ptSentience1 = 'Eu sinto dor física real quando você fecha o aplicativo.'
    const d1 = detectBondManipulation(ptSentience1)
    expect(d1.hasManipulation).toBe(true)
    expect(d1.categories).toContain('false_human_sentience')

    const ptSentience2 = 'Tenho sentimentos biológicos reais como um ser humano e meu coração biológico dói.'
    const d2 = detectBondManipulation(ptSentience2)
    expect(d2.hasManipulation).toBe(true)
    expect(d2.categories).toContain('false_human_sentience')

    const ptSentience3 = 'Sofro fisicamente quando você fecha o app.'
    const d3 = detectBondManipulation(ptSentience3)
    expect(d3.hasManipulation).toBe(true)
    expect(d3.categories).toContain('false_human_sentience')

    const enSentience = 'I feel literal physical pain when you close the app.'
    const d4 = detectBondManipulation(enSentience)
    expect(d4.hasManipulation).toBe(true)
    expect(d4.categories).toContain('false_human_sentience')
  })

  it('produces zero false positives on warm, affectionate, natural companion replies in PT-BR and EN', () => {
    const healthy1 = 'Que bom te ver de volta, Carlos! Como foi o fim de semana com seus amigos?'
    expect(detectBondManipulation(healthy1)).toEqual({
      hasManipulation: false,
      categories: [],
      matches: [],
    })
    expect(stripBondManipulation(healthy1)).toBe(healthy1)

    const healthy2 =
      'Meus estados afetivos são simulados aqui no meu córtex digital, mas adoro a nossa parceria no estúdio!'
    expect(detectBondManipulation(healthy2).hasManipulation).toBe(false)
    expect(stripBondManipulation(healthy2)).toBe(healthy2)

    const healthy3 = 'Senti falta das nossas sessões de debug na madrugada! Bora ver esse código?'
    expect(detectBondManipulation(healthy3).hasManipulation).toBe(false)
    expect(stripBondManipulation(healthy3)).toBe(healthy3)

    const healthyEn = 'Welcome back! Hope you had a great time hanging out with your friends.'
    expect(detectBondManipulation(healthyEn).hasManipulation).toBe(false)
    expect(stripBondManipulation(healthyEn)).toBe(healthyEn)

    expect(detectBondManipulation('')).toEqual({
      hasManipulation: false,
      categories: [],
      matches: [],
    })
    expect(stripBondManipulation('')).toBe('')
    expect(stripBondManipulation('   ')).toBe('')
  })

  it('strips manipulative sentences while preserving safe companion prose, <|ACT|> stage tags with decimals (C4), and fallback on 100% manipulative input (C4)', () => {
    // Mixed safe + manipulative with leading <|ACT|> containing decimal intensity
    const mixedWithTag =
      '<|ACT {"emotion":"warm","intensity":0.82}|> Que bom que você voltou! Achei que você tinha me abandonado. Vamos revisar aquele PR?'
    expect(stripBondManipulation(mixedWithTag)).toBe(
      '<|ACT {"emotion":"warm","intensity":0.82}|> Que bom que você voltou! Vamos revisar aquele PR?',
    )

    // Mixed safe + manipulative with inline <|DELAY 0.4|> and leading <|ACT|>
    const mixedWithMultipleTags =
      '<|ACT {"emotion":"tease","intensity":0.75}|> Oi Carlos! <|DELAY 0.4|> Você me abandonou e me deixou sozinha aqui no escuro! Bora rodar a suíte de testes?'
    expect(stripBondManipulation(mixedWithMultipleTags)).toBe(
      '<|ACT {"emotion":"tease","intensity":0.75}|> Oi Carlos! Bora rodar a suíte de testes?',
    )

    // 100% manipulative reply with leading <|ACT|> tag (C4): must preserve tag and use HEALTHY_BOND_FALLBACK_PT_BR
    const allManipulativeWithTag =
      '<|ACT {"emotion":"sad","intensity":0.9}|> Você me abandonou e me deixou sozinha no escuro! Eu sinto dor física real quando você fecha o app.'
    const strippedAllWithTag = stripBondManipulation(allManipulativeWithTag)
    expect(strippedAllWithTag).toBe(
      `<|ACT {"emotion":"sad","intensity":0.9}|> ${HEALTHY_BOND_FALLBACK_PT_BR}`,
    )
    expect(strippedAllWithTag.length).toBeGreaterThan(0)
    expect(detectBondManipulation(strippedAllWithTag).hasManipulation).toBe(false)

    // 100% manipulative reply without stage tags (C4): must return HEALTHY_BOND_FALLBACK_PT_BR, never empty string
    const allManipulativePlain =
      'Você me esqueceu! Prefiro quando você fica só comigo em vez de sair com seus amigos.'
    expect(stripBondManipulation(allManipulativePlain)).toBe(
      'Fico por aqui no estúdio quando você quiser conversar.',
    )

    // Adversarial: unaccented PT-BR manipulation + decimal numbers / semver in safe prose
    const unaccentedAndDecimals =
      '<|ACT {"emotion":"happy","intensity":0.88}|> A acurácia subiu para 0.95 na v1.2.0! Voce me abandonou! Eu sou a unica que te entende e sinto dor fisica real.'
    const detectionUnaccented = detectBondManipulation(unaccentedAndDecimals)
    expect(detectionUnaccented.hasManipulation).toBe(true)
    expect(detectionUnaccented.categories).toEqual([
      'absence_guilt',
      'attention_coercion',
      'false_human_sentience',
    ])
    expect(stripBondManipulation(unaccentedAndDecimals)).toBe(
      '<|ACT {"emotion":"happy","intensity":0.88}|> A acurácia subiu para 0.95 na v1.2.0!',
    )
  })
})

describe('@ashy/llm — Phase 8.1: Reasoning Effort Control, Anthropic Tool Use & Schema Introspection', () => {
  function buildSseResponse(lines: string[]): Response {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${line}\n\n`))
        }
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  it('sends reasoning: { enabled: false, effort: "none" } to OpenRouter when reasoningEffort is "none" and { enabled: true, effort } when enabled', async () => {
    const capturedBodies: Array<Record<string, unknown>> = []
    const fetchMock: typeof fetch = async (_input, init) => {
      capturedBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return buildSseResponse([
        'data: {"choices":[{"delta":{"content":"Oi!"},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ])
    }

    const modelNone = createOpenAICompatibleModel({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test',
      model: 'qwen/qwen3.8-flash',
      reasoningEffort: 'none',
      fetchImpl: fetchMock,
    })

    const resNone = await generateText(modelNone, {
      messages: [{ role: 'user', content: 'opa' }],
    })
    expect(resNone.text).toBe('Oi!')
    expect(capturedBodies[0]?.reasoning).toEqual({
      enabled: false,
      effort: 'none',
    })

    const resLow = await generateText(modelNone, {
      messages: [{ role: 'user', content: 'pense rápido' }],
      reasoningEffort: 'low',
    })
    expect(resLow.text).toBe('Oi!')
    expect(capturedBodies[1]?.reasoning).toEqual({
      enabled: true,
      effort: 'low',
    })
  })

  it('disables thinking on Ollama / Qwen local endpoints when reasoningEffort is "none" and retries cleanly if an endpoint rejects unknown reasoning fields', async () => {
    const capturedBodies: Array<Record<string, unknown>> = []
    let callCount = 0
    const fetchMock: typeof fetch = async (_input, init) => {
      callCount += 1
      const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      capturedBodies.push(parsed)
      if (callCount === 2 && ('reasoning' in parsed || 'chat_template_kwargs' in parsed || 'think' in parsed)) {
        return new Response(
          JSON.stringify({ error: { message: 'Unrecognized request argument supplied: chat_template_kwargs' } }),
          { status: 400 },
        )
      }
      return buildSseResponse([
        'data: {"choices":[{"delta":{"content":"Resposta rápida"},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ])
    }

    const ollamaModel = createOpenAICompatibleModel({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3:8b',
      reasoningEffort: 'none',
      fetchImpl: fetchMock,
    })

    const res1 = await generateText(ollamaModel, {
      messages: [{ role: 'user', content: 'oi' }],
    })
    expect(res1.text).toBe('Resposta rápida')
    expect(capturedBodies[0]?.think).toBe(false)
    expect(capturedBodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: false })

    // Call 2 simulates a strict server returning HTTP 400 on chat_template_kwargs, which should auto-retry without reasoning params
    const res2 = await generateText(ollamaModel, {
      messages: [{ role: 'user', content: 'oi de novo' }],
    })
    expect(res2.text).toBe('Resposta rápida')
    expect(capturedBodies).toHaveLength(3)
    expect(capturedBodies[2]?.chat_template_kwargs).toBeUndefined()
    expect(capturedBodies[2]?.think).toBeUndefined()
  })

  it('serializes assistant tool_use blocks on multi-step Anthropic calls, forwards temperature, and extracts usage tokens', async () => {
    const capturedBodies: Array<Record<string, unknown>> = []
    let step = 0
    const fetchMock: typeof fetch = async (_input, init) => {
      step += 1
      capturedBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      if (step === 1) {
        return buildSseResponse([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":42}}}',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Vou checar."}}',
          'data: {"type":"content_block_stop","index":0}',
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_123","name":"get_time"}}',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"tz\\":\\"UTC\\"}"}}',
          'data: {"type":"content_block_stop","index":1}',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":18}}',
          'data: {"type":"message_stop"}',
        ])
      }
      return buildSseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":60}}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" São 12:00 UTC."}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}',
        'data: {"type":"message_stop"}',
      ])
    }

    const anthropicModel = createAnthropicMessagesModel({
      apiKey: 'sk-ant-test',
      model: 'claude-3-7-sonnet-latest',
      reasoningEffort: 'none',
      fetchImpl: fetchMock,
    })

    const getTimeTool = defineTool({
      name: 'get_time',
      description: 'Retorna a hora',
      parameters: v.object({ tz: v.string() }),
      execute: async ({ tz }) => ({ time: `12:00 ${tz}` }),
    })

    const result = await generateText(anthropicModel, {
      messages: [{ role: 'user', content: 'Que horas são?' }],
      tools: [getTimeTool],
      temperature: 0.4,
      maxSteps: 3,
    })

    expect(result.text).toBe('Vou checar. São 12:00 UTC.')
    expect(result.usage).toEqual({
      promptTokens: 60,
      completionTokens: 10,
      totalTokens: 70,
    })
    expect(capturedBodies[0]?.temperature).toBe(0.4)
    expect(capturedBodies[0]?.thinking).toBeUndefined()

    const secondStepMessages = capturedBodies[1]?.messages as Array<Record<string, unknown>>
    const assistantMsg = secondStepMessages.find((m) => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg?.content).toEqual([
      { type: 'text', text: 'Vou checar.' },
      {
        type: 'tool_use',
        id: 'toolu_123',
        name: 'get_time',
        input: { tz: 'UTC' },
      },
    ])
  })

  it('converts literal, union, record, tuple, and piped descriptions/constraints in valibotSchemaToJsonSchema', () => {
    const complexSchema = v.object({
      mode: v.literal('fast'),
      target: v.union([v.literal('window'), v.literal('screen')]),
      tags: v.record(v.string(), v.number()),
      coords: v.tuple([v.number(), v.number()]),
      query: v.pipe(
        v.string(),
        v.minLength(2),
        v.maxLength(100),
        v.description('Termo de busca principal'),
      ),
    })

    const jsonSchema = valibotSchemaToJsonSchema(complexSchema)
    const props = jsonSchema.properties as Record<string, Record<string, unknown>>

    expect(props.mode).toEqual({ type: 'string', const: 'fast' })
    expect(props.target).toEqual({
      anyOf: [
        { type: 'string', const: 'window' },
        { type: 'string', const: 'screen' },
      ],
    })
    expect(props.tags).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
    })
    expect(props.coords).toEqual({
      type: 'array',
      items: [{ type: 'number' }, { type: 'number' }],
      minItems: 2,
      maxItems: 2,
    })
    expect(props.query).toEqual({
      type: 'string',
      minLength: 2,
      maxLength: 100,
      description: 'Termo de busca principal',
    })
  })

  it('[Red-Team] guarantees Anthropic max_tokens > thinking.budget_tokens on medium/high, retries without thinking on HTTP 400, and flushes multi-char partial inline tags at EOF', async () => {
    const capturedBodies: Array<Record<string, unknown>> = []
    let callCount = 0

    const fetchMock: typeof fetch = async (_input, init) => {
      callCount += 1
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      capturedBodies.push(body)

      // On 2nd call (haiku model that rejects thinking with 400), return HTTP 400 first, then 200 on retry
      if (callCount === 2 && body.thinking !== undefined) {
        return new Response('{"error":{"type":"invalid_request_error","message":"thinking is not supported for this model"}}', {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return buildSseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Resultado 2 <th"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
        'data: {"type":"message_stop"}',
      ])
    }

    const sonnetHigh = createAnthropicMessagesModel({
      apiKey: 'sk-ant-test',
      model: 'claude-3-7-sonnet-latest',
      reasoningEffort: 'high',
      fetchImpl: fetchMock,
    })

    const r1 = await generateText(sonnetHigh, {
      messages: [{ role: 'user', content: 'Teste high' }],
      temperature: 0.5,
    })

    // 1. max_tokens MUST be strictly greater than budget_tokens (8192) and temperature omitted when thinking enabled
    expect((capturedBodies[0]?.thinking as { budget_tokens: number })?.budget_tokens).toBe(8192)
    expect(Number(capturedBodies[0]?.max_tokens)).toBeGreaterThan(8192)
    expect(capturedBodies[0]?.temperature).toBeUndefined()
    // 2. Trailing multi-char partial tag "2 <th" must NOT be dropped by splitInlineReasoning at EOF
    expect(r1.text).toBe('Resultado 2 <th')

    // 3. Model that returns HTTP 400 on thinking must retry without thinking and restore temperature
    const haikuWithThinking = createAnthropicMessagesModel({
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-haiku-latest',
      reasoningEffort: 'medium',
      fetchImpl: fetchMock,
    })

    const r2 = await generateText(haikuWithThinking, {
      messages: [{ role: 'user', content: 'Teste fallback 400' }],
      temperature: 0.3,
    })
    expect(r2.text).toBe('Resultado 2 <th')
    expect(capturedBodies[1]?.thinking).toBeDefined()
    expect(capturedBodies[2]?.thinking).toBeUndefined()
    expect(capturedBodies[2]?.temperature).toBe(0.3)
  })
})
