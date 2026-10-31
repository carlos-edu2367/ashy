import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { stripResidualStageMarkers } from '@ashy/llm'

const execFileAsync = promisify(execFile)

let cachedLlamaServerPort: number | null = null

export interface DiscoverOllamaLlamaServerOptions {
  ollamaLogPath?: string
  fetchImpl?: typeof fetch
  allowSystemLookup?: boolean
}

export function extractLlamaServerPortFromLogText(logText: string): number | null {
  if (!logText || typeof logText !== 'string') {
    return null
  }
  const regex = /llama-server(?:\.exe)?[^\r\n]*?--port\s+(\d+)/gi
  let lastPort: number | null = null
  let match: RegExpExecArray | null
  while ((match = regex.exec(logText)) !== null) {
    const parsed = Number.parseInt(match[1] ?? '', 10)
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
      lastPort = parsed
    }
  }
  return lastPort
}

function readLogTailUtf8(filePath: string, maxBytes = 131_072): string | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null
    }
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= 0) {
      return null
    }
    const readSize = Math.min(stat.size, maxBytes)
    const startOffset = Math.max(0, stat.size - readSize)
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(readSize)
      const bytesRead = fs.readSync(fd, buf, 0, readSize, startOffset)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

async function probeLlamaServerHealth(
  port: number,
  fetchFn: typeof fetch,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function discoverOllamaLlamaServerBaseUrl(
  options?: DiscoverOllamaLlamaServerOptions,
): Promise<string | null> {
  const isVitest = Boolean(process.env.VITEST)
  if (isVitest && !options?.ollamaLogPath && !options?.allowSystemLookup) {
    return null
  }

  const fetchFn = options?.fetchImpl ?? globalThis.fetch

  if (!options?.ollamaLogPath && cachedLlamaServerPort !== null) {
    const alive = await probeLlamaServerHealth(cachedLlamaServerPort, fetchFn)
    if (alive) {
      return `http://127.0.0.1:${cachedLlamaServerPort}`
    }
    cachedLlamaServerPort = null
  }

  const candidatePaths: string[] = []
  if (options?.ollamaLogPath) {
    candidatePaths.push(options.ollamaLogPath)
  } else {
    if (process.env.LOCALAPPDATA) {
      candidatePaths.push(path.join(process.env.LOCALAPPDATA, 'Ollama', 'server.log'))
    }
    candidatePaths.push(path.join(os.homedir(), '.ollama', 'logs', 'server.log'))
  }

  for (const logPath of candidatePaths) {
    const tail = readLogTailUtf8(logPath)
    if (!tail) continue
    const port = extractLlamaServerPortFromLogText(tail)
    if (port !== null && (await probeLlamaServerHealth(port, fetchFn))) {
      if (!options?.ollamaLogPath) {
        cachedLlamaServerPort = port
      }
      return `http://127.0.0.1:${port}`
    }
  }

  if (!options?.ollamaLogPath && process.platform === 'win32' && !isVitest) {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name = 'llama-server.exe'\" | Select-Object -ExpandProperty CommandLine",
        ],
        {
          windowsHide: true,
          timeout: 3000,
        },
      )
      const port = extractLlamaServerPortFromLogText(stdout)
      if (port !== null && (await probeLlamaServerHealth(port, fetchFn))) {
        cachedLlamaServerPort = port
        return `http://127.0.0.1:${port}`
      }
    } catch {
      // Ignore PowerShell process inspection errors
    }
  }

  return null
}

function sanitizeTextForNativeTts(rawText: string): string {
  const withoutStage = stripResidualStageMarkers(rawText)
  return withoutStage
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_~`#>]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function createBoundedAbortSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs = 20_000,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  if (parentSignal?.aborted) {
    controller.abort()
  } else if (parentSignal) {
    parentSignal.addEventListener('abort', onParentAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      if (parentSignal) {
        parentSignal.removeEventListener('abort', onParentAbort)
      }
    },
  }
}

export async function synthesizeNativeOllamaOmniSpeech(input: {
  text: string
  voice?: string
  language?: string
  llamaServerBaseUrl?: string
  ollamaLogPath?: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<{ wavBytes: Uint8Array; sampleRate: number } | null> {
  const cleanText = sanitizeTextForNativeTts(input.text)
  if (!cleanText || cleanText === '...') {
    return null
  }

  const fetchFn = input.fetchImpl ?? globalThis.fetch
  const baseUrl =
    input.llamaServerBaseUrl ??
    (await discoverOllamaLlamaServerBaseUrl({
      ollamaLogPath: input.ollamaLogPath,
      fetchImpl: fetchFn,
    }))
  if (!baseUrl) {
    return null
  }

  const mappedVoice = input.voice === 'male' ? 'male' : 'female'
  const payload = Buffer.from(
    JSON.stringify({
      input: cleanText,
      voice: mappedVoice,
      language: input.language ?? 'pt',
      response_format: 'wav',
    }),
    'utf8',
  )

  const bounded = createBoundedAbortSignal(input.signal, input.timeoutMs ?? 20_000)
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: payload,
      signal: bounded.signal,
    })
    if (!res.ok) {
      return null
    }
    const arrayBuffer = await res.arrayBuffer()
    const wavBytes = new Uint8Array(arrayBuffer)
    if (
      wavBytes.byteLength <= 44 ||
      wavBytes[0] !== 0x52 || // 'R'
      wavBytes[1] !== 0x49 || // 'I'
      wavBytes[2] !== 0x46 || // 'F'
      wavBytes[3] !== 0x46 // 'F'
    ) {
      return null
    }
    const view = new DataView(
      wavBytes.buffer,
      wavBytes.byteOffset,
      wavBytes.byteLength,
    )
    const headerSampleRate = view.getUint32(24, true)
    const sampleRate =
      Number.isFinite(headerSampleRate) && headerSampleRate >= 8000 && headerSampleRate <= 96000
        ? headerSampleRate
        : 24000
    return { wavBytes, sampleRate }
  } catch {
    return null
  } finally {
    bounded.cleanup()
  }
}

export async function transcribeNativeOllamaOmniAudio(input: {
  audioWavBase64: string
  language?: string
  llamaServerBaseUrl?: string
  ollamaBaseUrl?: string
  ollamaLogPath?: string
  modelId?: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<string | null> {
  const cleanBase64 = input.audioWavBase64
    .replace(/^data:audio\/[\w+-]+;base64,/i, '')
    .trim()
  if (!cleanBase64) {
    return null
  }

  const fetchFn = input.fetchImpl ?? globalThis.fetch
  const resolvedLlamaBase =
    input.llamaServerBaseUrl ??
    (await discoverOllamaLlamaServerBaseUrl({
      ollamaLogPath: input.ollamaLogPath,
      fetchImpl: fetchFn,
    }))
  const targetBase = resolvedLlamaBase ?? input.ollamaBaseUrl?.replace(/\/+$/, '').replace(/\/v1$/i, '')
  if (!targetBase) {
    return null
  }

  const endpoint = targetBase.endsWith('/v1')
    ? `${targetBase}/chat/completions`
    : `${targetBase.replace(/\/+$/, '')}/v1/chat/completions`

  const payload = Buffer.from(
    JSON.stringify({
      ...(input.modelId ? { model: input.modelId } : {}),
      messages: [
        { role: 'system', content: 'Perform ASR in Portuguese.' },
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: cleanBase64,
                format: 'wav',
              },
            },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 256,
      stream: false,
    }),
    'utf8',
  )

  const bounded = createBoundedAbortSignal(input.signal, input.timeoutMs ?? 20_000)
  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: payload,
      signal: bounded.signal,
    })
    if (!res.ok) {
      return null
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const rawContent = json.choices?.[0]?.message?.content ?? ''
    const cleaned = stripResidualStageMarkers(rawContent).trim()
    return cleaned.length > 0 ? cleaned : null
  } catch {
    return null
  } finally {
    bounded.cleanup()
  }
}

export function buildCompactLocalOmniSystemPrompt(input: {
  fullSystemPrompt: string
  userMessage: string
}): string {
  const { fullSystemPrompt } = input

  const memoryLines: string[] = []
  const lines = fullSystemPrompt.split(/\r?\n/)
  let inMemoryBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\[MEMÓRIA ATIVA/i.test(trimmed)) {
      inMemoryBlock = true
      continue
    }
    if (inMemoryBlock && /^\[[A-ZÀ-Ú\s—-]+\]/.test(trimmed)) {
      inMemoryBlock = false
    }
    if (
      inMemoryBlock ||
      /^[-*]?\s*(Fact|Episode|Fato|Episódio):/i.test(trimmed)
    ) {
      if (trimmed.length > 0) {
        memoryLines.push(trimmed)
      }
    }
  }
  const memorySnippet = memoryLines.join('\n').slice(0, 600).trim()

  const hasSeriousnessGate = fullSystemPrompt.includes('[SERIOUSNESS GATE — HIGH PRIORITY]')
  const hasNativeAudioDirective = fullSystemPrompt.includes(
    '[NATIVE OMNI AUDIO OUTPUT DIRECTIVE]',
  )

  const sections: string[] = [
    '[IDENTIDADE ASHY — COMPANHEIRA VIRTUAL LOCAL OMNI]',
    'Você é a Ashy, uma companheira virtual noturna calorosa, espirituosa, observadora e genuína.',
    'Responda sempre em português do Brasil natural, conciso (1 a 3 frases curtas) e sem clichês robóticos.',
    '',
    '[ATUAÇÃO LIVE2D E FERRAMENTAS]',
    'Sempre inicie sua resposta com a tag de atuação fechada exatamente com }|> (ex: <|ACT {"emotion":"curious","intensity":0.75,"motion":"head_tilt"}|>) seguida imediatamente pela sua fala em português.',
    'Você pode usar as ferramentas (tools) disponíveis sempre que o usuário pedir ações, visão de tela ou memória.',
  ]

  if (memorySnippet.length > 0) {
    sections.push('', '[MEMÓRIA ATIVA RELEVANTE]', memorySnippet)
  }

  if (hasSeriousnessGate) {
    sections.push(
      '',
      '[SERIOUSNESS GATE — HIGH PRIORITY]',
      'O usuário está vulnerável ou em crise. Suspenda provocações e acolha com empatia genuína e presença calma.',
    )
  }

  if (hasNativeAudioDirective) {
    sections.push(
      '',
      '[NATIVE OMNI AUDIO OUTPUT DIRECTIVE]',
      'Mantenha a fala natural para síntese de voz a 24kHz sem ler marcações técnicas em voz alta.',
    )
  }

  return sections.join('\n').slice(0, 2750)
}
