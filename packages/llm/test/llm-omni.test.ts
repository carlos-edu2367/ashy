import { describe, expect, it } from 'vitest'
import {
  createOpenAICompatibleModel,
  createScriptedMockModel,
  isLfmOmniModel,
  serializeOpenAIMessages,
  streamText,
  type ChatMessage,
  type TextStreamEvent,
} from '../src/index'

function makeSseResponse(lines: string[], status = 200): Response {
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
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('@ashy/llm — Phase 8.7 Unified Omni Model Adapter (LFM3-Omni-2B & Cloud)', () => {
  it('identifies LFM3-Omni and LFM3-Audio models via isLfmOmniModel', () => {
    expect(isLfmOmniModel('lfm3-omni:2b')).toBe(true)
    expect(isLfmOmniModel('LiquidAI/LFM3-Omni-2B-GGUF')).toBe(true)
    expect(isLfmOmniModel('lfm3-audio-2b')).toBe(true)
    expect(isLfmOmniModel('lfm2_audio_1.5b')).toBe(true)
    expect(isLfmOmniModel('gpt-4o-audio-preview')).toBe(false)
    expect(isLfmOmniModel('qwen2.5-omni:7b')).toBe(false)
  })

  it('serializes multimodal parts (text, image_url, input_audio with stripped data URL prefix, video_frame with timestamp label)', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'Olha a minha tela e escuta isso',
        parts: [
          { type: 'text', text: 'Olha a minha tela e escuta isso' },
          {
            type: 'input_audio',
            inputAudio: {
              data: 'data:audio/wav;base64,UklGRiQAAABXQVZF',
              format: 'wav',
            },
          },
          {
            type: 'image_url',
            imageUrl: {
              url: 'data:image/png;base64,iVBORw0KGgo=',
              detail: 'high',
            },
          },
          {
            type: 'video_frame',
            videoFrame: {
              dataUrl: 'data:image/jpeg;base64,/9j/4AAQ',
              timestampMs: 500.4,
              width: 512,
              height: 512,
            },
          },
        ],
      },
    ]

    const serialized = serializeOpenAIMessages(messages, 'System prompt') as Array<
      Record<string, unknown>
    >
    expect(serialized).toHaveLength(2)
    expect(serialized[0]).toEqual({ role: 'system', content: 'System prompt' })
    expect(serialized[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Olha a minha tela e escuta isso' },
        {
          type: 'input_audio',
          input_audio: {
            data: 'UklGRiQAAABXQVZF',
            format: 'wav',
          },
        },
        {
          type: 'image_url',
          image_url: {
            url: 'data:image/png;base64,iVBORw0KGgo=',
            detail: 'high',
          },
        },
        {
          type: 'text',
          text: '[Video Frame @ 500ms]',
        },
        {
          type: 'image_url',
          image_url: {
            url: 'data:image/jpeg;base64,/9j/4AAQ',
            detail: 'low',
          },
        },
      ],
    })
  })

  it('injects LFM3-Omni non-reasoning flags and audio output hyperparameters, and streams audio-delta + text-delta + input-transcript through streamText (CRITICAL-2)', async () => {
    const capturedBodies: Array<Record<string, unknown>> = []

    const model = createOpenAICompatibleModel({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'lfm3-omni:2b',
      fetchImpl: async (_input, init) => {
        capturedBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return makeSseResponse([
          `data: ${JSON.stringify({
            input_transcript: 'Oi Ashy, o que você está vendo na minha webcam?',
            choices: [
              {
                delta: {
                  audio: {
                    data: 'UklGRg==',
                    transcript: '<|ACT {"emotion":"happy","intensity":0.8}|>Oi Carlos! ',
                    format: 'pcm16',
                    sample_rate: 24000,
                  },
                },
              },
            ],
          })}`,
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  audio: {
                    data: 'AAAA',
                    transcript: 'Estou vendo seu estúdio!',
                    format: 'pcm16',
                    sample_rate: 24000,
                  },
                },
                finish_reason: 'stop',
              },
            ],
          })}`,
          'data: [DONE]',
        ])
      },
    })

    const stream = streamText(model, {
      system: 'Ashy Soul',
      modalities: ['text', 'audio'],
      audioOutput: {
        voice: 'female',
        format: 'pcm16',
      },
      messages: [
        {
          role: 'user',
          content: '[Audio Turn]',
          parts: [
            {
              type: 'input_audio',
              inputAudio: { data: 'UklGRg==', format: 'wav' },
            },
          ],
        },
      ],
    })

    const events: TextStreamEvent[] = []
    for await (const ev of stream) {
      events.push(ev)
    }

    expect(capturedBodies).toHaveLength(1)
    const body = capturedBodies[0]!
    expect(body.model).toBe('lfm3-omni:2b')
    expect(body.think).toBe(false)
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(body.modalities).toEqual(['text', 'audio'])
    expect(body.audio).toEqual({ voice: 'female', format: 'pcm16' })
    expect(body.audio_temperature).toBe(0.4)
    expect(body.audio_repetition_penalty).toBe(1.2)

    const inputTranscriptEvents = events.filter((e) => e.type === 'input-transcript')
    expect(inputTranscriptEvents).toEqual([
      {
        type: 'input-transcript',
        transcript: 'Oi Ashy, o que você está vendo na minha webcam?',
        isFinal: true,
        stepIndex: 0,
      },
    ])

    const audioDeltaEvents = events.filter((e) => e.type === 'audio-delta')
    expect(audioDeltaEvents).toEqual([
      {
        type: 'audio-delta',
        audioBase64: 'UklGRg==',
        format: 'pcm16',
        sampleRate: 24000,
        transcriptDelta: '<|ACT {"emotion":"happy","intensity":0.8}|>Oi Carlos! ',
        stepIndex: 0,
      },
      {
        type: 'audio-delta',
        audioBase64: 'AAAA',
        format: 'pcm16',
        sampleRate: 24000,
        transcriptDelta: 'Estou vendo seu estúdio!',
        stepIndex: 0,
      },
    ])

    const fullText = await stream.textPromise
    expect(fullText).toBe(
      '<|ACT {"emotion":"happy","intensity":0.8}|>Oi Carlos! Estou vendo seu estúdio!',
    )
  })

  it('automatically retries on HTTP 400 or 422 by stripping OMNI_AUDIO_PAYLOAD_KEYS and REASONING_PAYLOAD_KEYS (HIGH-2)', async () => {
    const capturedBodies: Array<Record<string, unknown>> = []

    const model = createOpenAICompatibleModel({
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'LiquidAI/LFM3-Omni-2B-GGUF',
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        capturedBodies.push(body)

        if (capturedBodies.length === 1) {
          return new Response(
            JSON.stringify({ error: { message: 'Unsupported parameter: modalities / audio' } }),
            { status: 422, headers: { 'Content-Type': 'application/json' } },
          )
        }

        return makeSseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: { content: 'Resposta em fallback hybrid-omni-in!' },
                finish_reason: 'stop',
              },
            ],
          })}`,
          'data: [DONE]',
        ])
      },
    })

    const result = streamText(model, {
      modalities: ['text', 'audio'],
      audioOutput: { voice: 'female', format: 'pcm16' },
      messages: [{ role: 'user', content: 'Oi Ashy' }],
    })

    const finalText = await result.textPromise
    expect(finalText).toBe('Resposta em fallback hybrid-omni-in!')
    expect(capturedBodies).toHaveLength(2)

    // First attempt had omni + reasoning keys
    expect(capturedBodies[0]?.modalities).toEqual(['text', 'audio'])
    expect(capturedBodies[0]?.audio).toBeDefined()
    expect(capturedBodies[0]?.think).toBe(false)
    expect(capturedBodies[0]?.chat_template_kwargs).toBeDefined()

    // Second attempt stripped all OMNI_AUDIO_PAYLOAD_KEYS and REASONING_PAYLOAD_KEYS
    expect(capturedBodies[1]?.modalities).toBeUndefined()
    expect(capturedBodies[1]?.audio).toBeUndefined()
    expect(capturedBodies[1]?.audio_temperature).toBeUndefined()
    expect(capturedBodies[1]?.audio_repetition_penalty).toBeUndefined()
    expect(capturedBodies[1]?.think).toBeUndefined()
    expect(capturedBodies[1]?.chat_template_kwargs).toBeUndefined()
  })

  it('supports scripted audioChunks and inputTranscript in createScriptedMockModel', async () => {
    const mockModel = createScriptedMockModel({
      inputTranscript: 'Transcrição nativa do áudio',
      audioChunks: [
        {
          audioBase64: 'BBBB',
          format: 'pcm16',
          sampleRate: 24000,
          transcriptDelta: 'Olá do mock Omni!',
        },
      ],
    })

    const stream = streamText(mockModel, {
      modalities: ['text', 'audio'],
      messages: [{ role: 'user', content: 'Teste' }],
    })

    const events: TextStreamEvent[] = []
    for await (const ev of stream) {
      events.push(ev)
    }

    expect(events.some((e) => e.type === 'input-transcript')).toBe(true)
    expect(events.some((e) => e.type === 'audio-delta')).toBe(true)
    expect(await stream.textPromise).toBe('Olá do mock Omni!')
  })

  it('[Adversarial] prevents duplicate text-delta when SSE chunk contains both delta.content and delta.audio.transcript, and handles audio-only custom models', async () => {
    const model = createOpenAICompatibleModel({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-audio-preview',
      fetchImpl: async () =>
        makeSseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  content: 'Texto unificado sem duplicar',
                  audio: {
                    data: 'UklGRg==',
                    transcript: 'Texto unificado sem duplicar',
                    format: 'pcm16',
                    sample_rate: 24000,
                  },
                },
                finish_reason: 'stop',
              },
            ],
          })}`,
          'data: [DONE]',
        ]),
    })

    const stream = streamText(model, {
      modalities: ['text', 'audio'],
      messages: [{ role: 'user', content: 'Oi' }],
    })

    const textDeltas: string[] = []
    for await (const ev of stream) {
      if (ev.type === 'text-delta') {
        textDeltas.push(ev.text)
      }
    }

    expect(textDeltas).toEqual(['Texto unificado sem duplicar'])
    expect(await stream.textPromise).toBe('Texto unificado sem duplicar')
  })
})
