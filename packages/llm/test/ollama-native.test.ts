import { describe, expect, it, vi } from 'vitest'
import * as v from 'valibot'
import {
  createOllamaNativeModel,
  defineTool,
  generateText,
  resolveOllamaOrigin,
  serializeOllamaNativeMessages,
  streamText,
  type TextStreamEvent,
} from '../src/index'

const encoder = new TextEncoder()

/** Builds an NDJSON response whose body is delivered in the exact raw chunks given. */
function makeChunkedResponse(rawChunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of rawChunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}

function ndjson(objects: unknown[]): string {
  return objects.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

type FetchCall = { url: string; body: Record<string, unknown>; signal?: AbortSignal | null }

function makeFetch(responder: (call: FetchCall, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const call: FetchCall = {
      url,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      signal: init?.signal,
    }
    calls.push(call)
    return responder(call, calls.length - 1)
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

async function drain(stream: ReadableStream<TextStreamEvent>): Promise<TextStreamEvent[]> {
  const events: TextStreamEvent[] = []
  for await (const ev of stream as unknown as AsyncIterable<TextStreamEvent>) events.push(ev)
  return events
}

describe('resolveOllamaOrigin', () => {
  it('strips /v1 and /api suffixes and trailing slashes', () => {
    expect(resolveOllamaOrigin('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434')
    expect(resolveOllamaOrigin('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434')
    expect(resolveOllamaOrigin('http://localhost:11434/api')).toBe('http://localhost:11434')
    expect(resolveOllamaOrigin('http://localhost:11434')).toBe('http://localhost:11434')
    expect(resolveOllamaOrigin('https://proxy.local/ollama/v1')).toBe('https://proxy.local/ollama')
    expect(resolveOllamaOrigin(undefined)).toBe('http://127.0.0.1:11434')
  })
})

describe('createOllamaNativeModel', () => {
  it('streams NDJSON text deltas split across arbitrary chunk boundaries (incl. UTF-8 bytes)', async () => {
    const body = ndjson([
      { model: 'm', message: { role: 'assistant', content: 'Olá, ' }, done: false },
      { model: 'm', message: { role: 'assistant', content: 'Carlos! ' }, done: false },
      { model: 'm', message: { role: 'assistant', content: 'Tudo bem?' }, done: false },
      {
        model: 'm',
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 12,
        eval_count: 7,
      },
    ])
    // Split bytes into 5-byte slices so lines and multibyte chars are cut mid-way.
    const bytes = encoder.encode(body)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 5) controller.enqueue(bytes.slice(i, i + 5))
        controller.close()
      },
    })
    const { fetchImpl, calls } = makeFetch(() => new Response(stream, { status: 200 }))
    const model = createOllamaNativeModel({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M',
      fetchImpl,
    })

    const result = await generateText(model, { messages: [{ role: 'user', content: 'oi' }] })
    expect(result.text).toBe('Olá, Carlos! Tudo bem?')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 7, totalTokens: 19 })
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/api/chat')
    expect(model.provider).toBe('ollama-native')
    expect(model.modelId).toBe('hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M')
  })

  it('handles a final line without trailing newline and emits thinking as reasoning', async () => {
    const { fetchImpl } = makeFetch(() =>
      makeChunkedResponse([
        JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'hmm' }, done: false }) +
          '\n' +
          JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: false }) +
          '\n',
        JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }),
      ]),
    )
    const model = createOllamaNativeModel({ model: 'qwen3:8b', fetchImpl })
    const result = await generateText(model, {
      messages: [{ role: 'user', content: 'x' }],
      reasoningEffort: 'low',
    })
    expect(result.text).toBe('ok')
    expect(result.reasoning).toBe('hmm')
  })

  it('maps sampling options with conversational defaults, overrides, keep_alive and maxTokens', async () => {
    const okBody = () =>
      makeChunkedResponse([ndjson([{ message: { content: 'a' }, done: true, done_reason: 'stop' }])])
    const { fetchImpl, calls } = makeFetch(okBody)

    const model = createOllamaNativeModel({ model: 'llama3', fetchImpl })
    await generateText(model, {
      messages: [{ role: 'user', content: 'x' }],
      system: 'Você é a Ashy.',
      modalities: ['text', 'audio'],
      audioOutput: { voice: 'female' },
    })
    const body = calls[0]!.body
    expect(body.model).toBe('llama3')
    expect(body.stream).toBe(true)
    expect(body.keep_alive).toBe('30m')
    expect(body.options).toEqual({ temperature: 0.7, top_k: 40, top_p: 0.9, repeat_penalty: 1.1 })
    expect(body).not.toHaveProperty('modalities')
    expect(body).not.toHaveProperty('audio')
    expect(body).not.toHaveProperty('think')
    expect(body).not.toHaveProperty('tools')
    expect(body.messages).toEqual([
      { role: 'system', content: 'Você é a Ashy.' },
      { role: 'user', content: 'x' },
    ])

    const tuned = createOllamaNativeModel({
      model: 'llama3',
      fetchImpl,
      keepAlive: -1,
      options: { top_k: 64, num_ctx: 8192, top_p: undefined },
    })
    await generateText(tuned, {
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.2,
      maxTokens: 64,
    })
    const tunedBody = calls[1]!.body
    expect(tunedBody.keep_alive).toBe(-1)
    expect(tunedBody.options).toEqual({
      temperature: 0.2,
      top_k: 64,
      top_p: 0.9,
      repeat_penalty: 1.1,
      num_ctx: 8192,
      num_predict: 64,
    })
  })

  it('sets think:false for reasoningEffort none, think:true otherwise, and false for LFM Omni', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      makeChunkedResponse([ndjson([{ message: { content: 'a' }, done: true }])]),
    )
    const base = createOllamaNativeModel({ model: 'qwen3:8b', fetchImpl, reasoningEffort: 'none' })
    await generateText(base, { messages: [{ role: 'user', content: 'x' }] })
    expect(calls[0]!.body.think).toBe(false)

    await generateText(base, { messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'high' })
    expect(calls[1]!.body.think).toBe(true)

    const lfm = createOllamaNativeModel({
      model: 'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M',
      fetchImpl,
      reasoningEffort: 'high',
    })
    await generateText(lfm, { messages: [{ role: 'user', content: 'x' }] })
    expect(calls[2]!.body.think).toBe(false)
  })

  it('retries without think when the model rejects thinking with HTTP 400', async () => {
    const { fetchImpl, calls } = makeFetch((_call, index) =>
      index === 0
        ? new Response(JSON.stringify({ error: '"llama3" does not support thinking' }), { status: 400 })
        : makeChunkedResponse([ndjson([{ message: { content: 'fine' }, done: true }])]),
    )
    const model = createOllamaNativeModel({ model: 'llama3', fetchImpl, reasoningEffort: 'medium' })
    const result = await generateText(model, { messages: [{ role: 'user', content: 'x' }] })
    expect(result.text).toBe('fine')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.body.think).toBe(true)
    expect(calls[1]!.body).not.toHaveProperty('think')
  })

  it('surfaces readable errors on non-2xx responses (including body)', async () => {
    const { fetchImpl } = makeFetch(
      () => new Response(JSON.stringify({ error: 'model "nope" not found, try pulling it first' }), { status: 404 }),
    )
    const model = createOllamaNativeModel({ model: 'nope', fetchImpl })
    const events = await drain(streamText(model, { messages: [{ role: 'user', content: 'x' }] }))
    const err = events.find((e) => e.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') {
      expect(err.error).toContain('Ollama HTTP 404')
      expect(err.error).toContain('not found, try pulling it first')
    }
    const finish = events.at(-1)
    expect(finish?.type).toBe('finish')
    if (finish?.type === 'finish') expect(finish.finishReason).toBe('error')
  })

  it('surfaces in-stream {"error": ...} frames as error events', async () => {
    const { fetchImpl } = makeFetch(() =>
      makeChunkedResponse([ndjson([{ message: { content: 'par' }, done: false }, { error: 'out of memory' }])]),
    )
    const model = createOllamaNativeModel({ model: 'm', fetchImpl })
    const events = await drain(streamText(model, { messages: [{ role: 'user', content: 'x' }] }))
    const err = events.find((e) => e.type === 'error')
    expect(err?.type === 'error' && err.error).toContain('out of memory')
  })

  it('round-trips a tool call: object arguments -> JSON argsText -> tool result message', async () => {
    const weatherTool = defineTool({
      name: 'get_weather',
      description: 'Gets the weather for a city',
      parameters: v.object({ city: v.string() }),
      execute: async ({ city }) => ({ city, tempC: 23 }),
    })

    const { fetchImpl, calls } = makeFetch((_call, index) => {
      if (index === 0) {
        return makeChunkedResponse([
          ndjson([
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Recife' } } }],
              },
              done: false,
            },
            { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
          ]),
        ])
      }
      return makeChunkedResponse([
        ndjson([
          { message: { role: 'assistant', content: 'Em Recife faz 23°C.' }, done: false },
          { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
        ]),
      ])
    })

    const model = createOllamaNativeModel({ model: 'qwen2.5:14b', fetchImpl })
    const result = await generateText(model, {
      messages: [{ role: 'user', content: 'Como está o tempo em Recife?' }],
      tools: [weatherTool],
      maxSteps: 3,
    })

    expect(result.text).toBe('Em Recife faz 23°C.')
    expect(result.toolCalls).toEqual([
      { toolCallId: 'call_0', toolName: 'get_weather', argsText: '{"city":"Recife"}' },
    ])
    expect(result.toolResults[0]!.result).toEqual({ city: 'Recife', tempC: 23 })
    expect(result.toolResults[0]!.isError).toBe(false)

    // Tool declaration in Ollama format
    expect(calls[0]!.body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Gets the weather for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
            additionalProperties: false,
          },
        },
      },
    ])

    // Second request carries the assistant tool call (object args) and a role:tool result
    const secondMessages = calls[1]!.body.messages as Array<Record<string, unknown>>
    expect(secondMessages).toEqual([
      { role: 'user', content: 'Como está o tempo em Recife?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Recife' } } }],
      },
      { role: 'tool', content: '{"city":"Recife","tempC":23}', tool_name: 'get_weather' },
    ])
  })

  it('honors AbortSignal both before and during streaming', async () => {
    // Before: fetch rejects with AbortError
    const preController = new AbortController()
    preController.abort()
    const { fetchImpl: rejectingFetch } = makeFetch((call) => {
      if (call.signal?.aborted) {
        return Promise.reject(new DOMException('This operation was aborted', 'AbortError'))
      }
      return makeChunkedResponse([ndjson([{ message: { content: 'x' }, done: true }])])
    })
    const pre = createOllamaNativeModel({ model: 'm', fetchImpl: rejectingFetch })
    const preEvents = await drain(
      streamText(pre, { messages: [{ role: 'user', content: 'x' }], signal: preController.signal }),
    )
    expect(preEvents.some((e) => e.type === 'error' && /abort/i.test(e.error))).toBe(true)

    // During: body errors when the signal fires mid-stream
    const midController = new AbortController()
    const { fetchImpl: streamingFetch } = makeFetch((call) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(ndjson([{ message: { content: 'primeiro ' }, done: false }])))
          call.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('This operation was aborted', 'AbortError'))
          })
        },
      })
      return new Response(body, { status: 200 })
    })
    const mid = createOllamaNativeModel({ model: 'm', fetchImpl: streamingFetch })
    const events: TextStreamEvent[] = []
    for await (const ev of streamText(mid, {
      messages: [{ role: 'user', content: 'x' }],
      signal: midController.signal,
    }) as unknown as AsyncIterable<TextStreamEvent>) {
      events.push(ev)
      if (ev.type === 'text-delta') midController.abort()
    }
    expect(events.find((e) => e.type === 'text-delta')).toMatchObject({ text: 'primeiro ' })
    expect(events.some((e) => e.type === 'error' && /abort/i.test(e.error))).toBe(true)
    expect(events.at(-1)?.type).toBe('finish')
  })
})

describe('serializeOllamaNativeMessages', () => {
  it('puts images, video frames and input_audio WAV into images[] without data: prefix', () => {
    const out = serializeOllamaNativeMessages([
      {
        role: 'user',
        content: 'fallback',
        parts: [
          { type: 'text', text: 'O que você vê e ouve?' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          { type: 'input_audio', inputAudio: { data: 'data:audio/wav;base64,UklGRiQAAABXQVZF', format: 'wav' } },
          { type: 'input_audio', inputAudio: { data: 'UklGRraw', format: 'wav' } },
          {
            type: 'video_frame',
            videoFrame: { dataUrl: 'data:image/jpeg;base64,/9j/4AAQ', timestampMs: 1234.4 },
          },
          { type: 'image_url', imageUrl: { url: 'https://example.com/cat.png' } },
        ],
      },
    ])
    expect(out).toEqual([
      {
        role: 'user',
        content: 'O que você vê e ouve?\n[Video Frame @ 1234ms]\n[Image: https://example.com/cat.png]',
        images: ['iVBORw0KGgo=', 'UklGRiQAAABXQVZF', 'UklGRraw', '/9j/4AAQ'],
      },
    ])
  })

  it('wraps raw pcm16 input_audio into a 16 kHz mono WAV before sending', () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]).toString('base64')
    const out = serializeOllamaNativeMessages([
      { role: 'user', content: 'x', parts: [{ type: 'input_audio', inputAudio: { data: pcm, format: 'pcm16' } }] },
    ])
    const wav = Buffer.from((out[0]!.images as string[])[0]!, 'base64')
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt32LE(40)).toBe(8)
    expect(wav.length).toBe(52)
  })

  it('falls back to message content when parts carry only media', () => {
    const out = serializeOllamaNativeMessages([
      {
        role: 'user',
        content: '[Mensagem de voz]',
        parts: [{ type: 'input_audio', inputAudio: { data: 'UklGR', format: 'wav' } }],
      },
    ])
    expect(out).toEqual([{ role: 'user', content: '[Mensagem de voz]', images: ['UklGR'] }])
  })

  it('converts invalid assistant tool-call JSON to an empty arguments object', () => {
    const out = serializeOllamaNativeMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ toolCallId: 'c1', toolName: 'x', argsText: '{not json' }],
      },
    ])
    expect(out[0]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'x', arguments: {} } }],
    })
  })
})
