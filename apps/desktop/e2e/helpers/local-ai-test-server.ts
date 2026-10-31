import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedAiRequest {
  method: string
  url: string
  body: unknown
  timestamp: number
}

export interface LocalAiTestServer {
  readonly port: number
  readonly rootUrl: string
  readonly baseUrl: string
  readonly requests: RecordedAiRequest[]
  close(): Promise<void>
}

export interface StartLocalAiTestServerOptions {
  port?: number
}

/**
 * Generates deterministic 16-bit mono PCM samples with vowel-like formant harmonics
 * (F0=220Hz, F1=730Hz, F2=1090Hz) so vowel lip-sync envelope extraction produces
 * realistic non-zero mouth movement.
 */
export function buildSyntheticPcm16Buffer(sampleRate = 24000, durationMs = 180): Buffer {
  const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000))
  const pcmBuffer = Buffer.alloc(sampleCount * 2)
  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate
    const sample =
      0.45 * Math.sin(2 * Math.PI * 220 * t) +
      0.35 * Math.sin(2 * Math.PI * 730 * t) +
      0.2 * Math.sin(2 * Math.PI * 1090 * t)
    const clamped = Math.max(-1, Math.min(1, sample))
    pcmBuffer.writeInt16LE(Math.round(clamped * 28000), i * 2)
  }
  return pcmBuffer
}

export function buildSyntheticPcm16Base64(sampleRate = 24000, durationMs = 180): string {
  return buildSyntheticPcm16Buffer(sampleRate, durationMs).toString('base64')
}

export function buildSyntheticSpeechWavBuffer(sampleRate = 24000, durationMs = 180): Buffer {
  const pcmData = buildSyntheticPcm16Buffer(sampleRate, durationMs)
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * 2
  const dataSize = pcmData.byteLength

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // AudioFormat = 1 (PCM)
  header.writeUInt16LE(1, 22) // NumChannels = 1 (mono)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(2, 32) // BlockAlign
  header.writeUInt16LE(16, 34) // BitsPerSample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcmData])
}

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'object' && part !== null) {
          const p = part as Record<string, unknown>
          if (p.type === 'text' && typeof p.text === 'string') {
            return p.text
          }
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function hasInputAudioPart(messages: unknown[]): boolean {
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) continue
    const msg = m as Record<string, unknown>
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          typeof part === 'object' &&
          part !== null &&
          (part as Record<string, unknown>).type === 'input_audio'
        ) {
          return true
        }
      }
    }
  }
  return false
}

function writeSseChunk(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

export async function startLocalAiTestServer(
  options: StartLocalAiTestServerOptions = {},
): Promise<LocalAiTestServer> {
  const requests: RecordedAiRequest[] = []
  const wavSpeechBuffer = buildSyntheticSpeechWavBuffer(24000, 180)
  const omniPcm16Base64 = buildSyntheticPcm16Base64(24000, 180)

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET'
    const rawUrl = req.url ?? '/'
    const urlPath = rawUrl.split('?')[0] ?? '/'

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, xi-api-key')

    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let parsedBody: unknown = null
      if (rawBody.trim().startsWith('{')) {
        try {
          parsedBody = JSON.parse(rawBody)
        } catch {
          parsedBody = rawBody
        }
      } else if (rawBody.length > 0) {
        parsedBody = `<binary:${rawBody.length}b>`
      }

      requests.push({
        method,
        url: urlPath,
        body: parsedBody,
        timestamp: Date.now(),
      })

      // 1. OpenAI-compatible model catalog
      if (method === 'GET' && (urlPath === '/v1/models' || urlPath === '/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'lfm3-omni:2b', object: 'model', name: 'Liquid LFM-3 Omni 2B' },
              { id: 'qwen3:8b', object: 'model', name: 'Qwen 3 8B' },
              { id: 'whisper-1', object: 'model', name: 'Whisper 1 Local' },
              { id: 'kokoro-v1', object: 'model', name: 'Kokoro v1 Local' },
            ],
          }),
        )
        return
      }

      // 2. Ollama native tags catalog
      if (method === 'GET' && urlPath === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            models: [
              { name: 'lfm3-omni:2b', model: 'lfm3-omni:2b' },
              { name: 'qwen3:8b', model: 'qwen3:8b' },
            ],
          }),
        )
        return
      }

      // 3. Local Kokoro voices catalog
      if (method === 'GET' && (urlPath === '/v1/audio/voices' || urlPath === '/audio/voices')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            voices: [
              { id: 'ashy-pt-br', name: 'Ashy Warm PT-BR' },
              { id: 'pf_dora', name: 'Dora PT-BR' },
            ],
          }),
        )
        return
      }

      // 4. Local Whisper STT transcription
      if (
        method === 'POST' &&
        (urlPath === '/v1/audio/transcriptions' || urlPath === '/audio/transcriptions')
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            text: 'Oi Ashy, testando transcrição local de voz no estúdio.',
          }),
        )
        return
      }

      // 5. Local Kokoro / OpenAI-compatible TTS speech synthesis
      if (method === 'POST' && (urlPath === '/v1/audio/speech' || urlPath === '/audio/speech')) {
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': String(wavSpeechBuffer.byteLength),
        })
        res.end(wavSpeechBuffer)
        return
      }

      // 6. OpenAI-compatible & Ollama chat completions
      if (
        method === 'POST' &&
        (urlPath === '/v1/chat/completions' ||
          urlPath === '/chat/completions' ||
          urlPath === '/api/chat')
      ) {
        const bodyObj =
          typeof parsedBody === 'object' && parsedBody !== null
            ? (parsedBody as Record<string, unknown>)
            : {}
        const messages = Array.isArray(bodyObj.messages) ? bodyObj.messages : []
        const isStreaming = bodyObj.stream !== false
        const modalities = Array.isArray(bodyObj.modalities) ? bodyObj.modalities : []
        const wantsOmniAudio = modalities.includes('audio')
        const containsAudioInput = hasInputAudioPart(messages)

        const lastMsg =
          messages.length > 0 && typeof messages[messages.length - 1] === 'object'
            ? (messages[messages.length - 1] as Record<string, unknown>)
            : {}
        const lastRole = typeof lastMsg.role === 'string' ? lastMsg.role : 'user'

        const lastUserMsg = [...messages]
          .reverse()
          .find(
            (m) =>
              typeof m === 'object' &&
              m !== null &&
              (m as Record<string, unknown>).role === 'user',
          ) as Record<string, unknown> | undefined
        const lastUserText = extractTextFromMessageContent(lastUserMsg?.content)

        const respondWithText = (textContent: string, includeOmniAudio = false) => {
          if (!isStreaming) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                id: 'chatcmpl-local-test',
                object: 'chat.completion',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: textContent,
                    },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 24, completion_tokens: 24, total_tokens: 48 },
              }),
            )
            return
          }

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          })

          if (containsAudioInput) {
            writeSseChunk(res, {
              id: 'chatcmpl-local-test',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    input_transcript: 'Oi Ashy, testando áudio nativo Omni no estúdio!',
                  },
                },
              ],
            })
          }

          // Split marker and body if a stage marker is present so streaming delta handling is exercised
          const markerEndIdx = textContent.indexOf('|>')
          if (markerEndIdx !== -1) {
            const firstPart = textContent.slice(0, markerEndIdx + 2)
            const restPart = textContent.slice(markerEndIdx + 2)
            writeSseChunk(res, {
              id: 'chatcmpl-local-test',
              choices: [{ index: 0, delta: { role: 'assistant', content: firstPart } }],
            })
            if (restPart.length > 0) {
              writeSseChunk(res, {
                id: 'chatcmpl-local-test',
                choices: [{ index: 0, delta: { content: restPart } }],
              })
            }
          } else {
            writeSseChunk(res, {
              id: 'chatcmpl-local-test',
              choices: [{ index: 0, delta: { role: 'assistant', content: textContent } }],
            })
          }

          if (includeOmniAudio) {
            writeSseChunk(res, {
              id: 'chatcmpl-local-test',
              choices: [
                {
                  index: 0,
                  delta: {
                    audio: {
                      data: omniPcm16Base64,
                      format: 'pcm16',
                      sample_rate: 24000,
                    },
                  },
                },
              ],
            })
          }

          writeSseChunk(res, {
            id: 'chatcmpl-local-test',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 32, completion_tokens: 28, total_tokens: 60 },
          })
          res.write('data: [DONE]\n\n')
          res.end()
        }

        // Case A: Connection health ping
        if (lastUserText.trim() === 'ping' || bodyObj.max_tokens === 8) {
          respondWithText('pong', false)
          return
        }

        // Case B: Structured Episode Extraction JSON
        if (lastUserText.includes('Extraia memórias estruturadas do diálogo abaixo')) {
          const userLines = lastUserText
            .split('\n')
            .filter((line) => line.startsWith('[User]:'))
            .map((line) => line.slice('[User]:'.length).trim())
            .filter(Boolean)
          const firstQuote =
            userLines.find((l) => /fantasma no backend/i.test(l)) ??
            userLines[0] ??
            'fantasma no backend'

          const extractionJson = JSON.stringify({
            shouldSaveEpisode: true,
            category: 'referencias',
            episode: {
              title: 'Fantasma no backend e TypeScript com Carlos',
              summary:
                'Carlos contou que trabalha com TypeScript no estúdio e brincamos sobre o fantasma no backend.',
              tags: ['typescript', 'inside_joke', 'late_night_debug', 'architecture', 'momentos'],
              surprise: 0.85,
              isFlashbulb: true,
            },
            candidateFacts: [
              {
                category: 'preference',
                subject: 'user',
                predicate: 'works_with',
                object: 'TypeScript',
                confidence: 0.95,
                evidenceQuote: firstQuote,
              },
            ],
            candidateMotifs: [
              {
                motif: 'fantasma no backend',
                originSummary:
                  'Brincadeira sobre o código amaldiçoado ter um fantasma no backend',
                triggerCues: ['fantasma no backend', 'exorcista de javascript'],
                evidenceQuote: firstQuote,
              },
            ],
            candidateIntents: [],
            candidateHabits: [],
          })
          respondWithText(extractionJson, false)
          return
        }

        // Case C: Dream Journal Reflection JSON
        if (
          lastUserText.includes('Diário de Sonhos') ||
          lastUserText.includes('{"summary":')
        ) {
          const dreamJson = JSON.stringify({
            summary:
              'Refleti sobre nossas conversas de TypeScript e nossa piada interna do fantasma no backend aqui no estúdio.',
          })
          respondWithText(dreamJson, false)
          return
        }

        // Case D: Tool Call Completion follow-up (after write_project_note execution/staging)
        if (lastRole === 'tool') {
          respondWithText(
            '<|ACT {"emotion":"happy","intensity":0.85,"motion":"nod"}|> Preparei as notas de arquitetura no Gatekeeper com visualização de diff para sua aprovação!',
            wantsOmniAudio,
          )
          return
        }

        // Case E: User requests MCP tool write_project_note staging
        if (
          /nota de arquitetura|write_project_note|duas notas/i.test(lastUserText) &&
          Array.isArray(bodyObj.tools) &&
          bodyObj.tools.length > 0
        ) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          })
          writeSseChunk(res, {
            id: 'chatcmpl-local-tool',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_note_approve_1',
                      type: 'function',
                      function: {
                        name: 'write_project_note',
                        arguments: JSON.stringify({
                          title: 'Arquitetura Release Aprovada',
                          content:
                            '# Arquitetura Release 1.0\nNota validada e aprovada pelo usuário.\n',
                        }),
                      },
                    },
                    {
                      index: 1,
                      id: 'call_note_deny_2',
                      type: 'function',
                      function: {
                        name: 'write_project_note',
                        arguments: JSON.stringify({
                          title: 'Rascunho Temporario Recusado',
                          content: '# Rascunho Temporário\nEsta nota será recusada no Gatekeeper.\n',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // Case F: SeriousnessGate emotional / delicate disclosure turn
        if (
          /exausto|ansioso|hospital|burnout|luto|demitido|momento difícil|angústia/i.test(
            lastUserText,
          )
        ) {
          respondWithText(
            '<|ACT {"emotion":"concerned","intensity":0.85,"motion":"listen_nod"}|> Sinto muito que você esteja passando por esse momento pesado, Carlos. Estou aqui com você com toda calma, sem pressa — respira fundo e me conta como posso te apoiar agora.',
            wantsOmniAudio,
          )
          return
        }

        // Case G: Default conversational turn (supports inside joke & TypeScript fact grounding + Omni audio)
        respondWithText(
          '<|ACT {"emotion":"tease","intensity":0.85,"motion":"nod"}|> Haha, Carlos! Com certeza tem um fantasma no backend desse TypeScript — vou chamar um exorcista de JavaScript e um padre no npm pra te ajudar aqui no estúdio!',
          wantsOmniAudio,
        )
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Unhandled test server route: ${method} ${urlPath}` }))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })

  const addr = server.address() as AddressInfo
  const port = addr.port
  const rootUrl = `http://127.0.0.1:${port}`
  const baseUrl = `http://127.0.0.1:${port}/v1`

  return {
    port,
    rootUrl,
    baseUrl,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      }),
  }
}
