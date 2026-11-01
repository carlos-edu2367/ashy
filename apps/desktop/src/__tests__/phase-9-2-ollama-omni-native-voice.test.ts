import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAshyCortex } from '@ashy/cortex'
import type { AshyHostStreamEvent } from '@ashy/shared'
import { encodeWavPcm16 } from '@ashy/voice'
import { createHostAgencyRuntime } from '../host/agency-runtime'
import {
  buildCompactLocalOmniSystemPrompt,
  discoverOllamaLlamaServerBaseUrl,
  extractLlamaServerPortFromLogText,
  synthesizeNativeOllamaOmniSpeech,
  transcribeNativeOllamaOmniAudio,
} from '../host/ollama-native-audio-bridge'
import { createProviderVault } from '../host/provider-vault'
import { createTurnOrchestrator } from '../host/turn-orchestrator'
import { createVoiceIdentityStore } from '../host/voice-identity-store'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-omni-9-2-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    } catch {
      // ignore cleanup error on Windows
    }
  }
})

describe('Phase 9.2 — Ollama Native LFM3-Omni-2B 24kHz Voice Bridge & Compact Local Prompt', () => {
  it('extracts the most recent llama-server port from Ollama server.log lines', () => {
    const sampleLog = [
      'time=2026-10-31T16:49:11.659-03:00 level=INFO source=llama_server.go:467 msg="starting llama-server" cmd="C:\\\\llama-server.exe --model blob1 --port 61732 --host 127.0.0.1"',
      'time=2026-10-31T19:17:55.100-03:00 level=INFO source=llama_server.go:467 msg="starting llama-server" cmd="C:\\\\llama-server.exe --model blob1 --port 64597 --host 127.0.0.1 --mmproj blob2"',
    ].join('\n')

    expect(extractLlamaServerPortFromLogText(sampleLog)).toBe(64597)
    expect(extractLlamaServerPortFromLogText('no server lines here')).toBeNull()
  })

  it('discovers live llama-server base URL from log file and health check', async () => {
    const dir = makeTempDir()
    const logPath = path.join(dir, 'server.log')
    fs.writeFileSync(
      logPath,
      'time=2026-10-31T19:20:00.000-03:00 level=INFO msg="starting llama-server" cmd="llama-server.exe --port 59876 --host 127.0.0.1"\n',
      'utf8',
    )

    const baseUrl = await discoverOllamaLlamaServerBaseUrl({
      ollamaLogPath: logPath,
      fetchImpl: async (url) => {
        if (String(url) === 'http://127.0.0.1:59876/health') {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
        }
        return new Response('not found', { status: 404 })
      },
    })

    expect(baseUrl).toBe('http://127.0.0.1:59876')
  })

  it('compacts local Ollama Omni system prompt to under 2800 chars while preserving <|ACT|>, memory snippets, and tool guidance', () => {
    const bloated = [
      'A'.repeat(12000),
      '[MEMÓRIA ATIVA RELEVANTE]',
      '- Fact: Carlos gosta de programação e café expresso.',
      '[STAGE ACTUATION]',
      'Use <|ACT {"emotion":"warm"}|>',
    ].join('\n')

    const compact = buildCompactLocalOmniSystemPrompt({
      fullSystemPrompt: bloated,
      userMessage: 'Oi Ashy, tudo bem?',
    })

    expect(compact.length).toBeLessThan(2800)
    expect(compact).toContain('<|ACT')
    expect(compact).toContain('}|>')
    expect(compact).toContain('Ashy')
    expect(compact).toContain('tools')
    expect(compact).toContain('Carlos gosta de programação')
  })

  it('synthesizes 24kHz WAV via llama-server POST /tts with UTF-8 JSON payload and strips residual markers', async () => {
    const fakeSamples = new Float32Array(2400)
    for (let i = 0; i < fakeSamples.length; i++) {
      fakeSamples[i] = Math.sin((2 * Math.PI * 220 * i) / 24000) * 0.4
    }
    const wavBuf = encodeWavPcm16(fakeSamples, 24000)

    let capturedUrl = ''
    let capturedBody = ''
    const result = await synthesizeNativeOllamaOmniSpeech({
      text: '<|ACT {"emotion":"warm","note":"a > b"}>Oi Carlos! Tudo ótimo por aqui.',
      voice: 'female',
      language: 'pt',
      llamaServerBaseUrl: 'http://127.0.0.1:64597',
      fetchImpl: async (url, init) => {
        capturedUrl = String(url)
        capturedBody =
          init?.body instanceof Uint8Array
            ? Buffer.from(init.body).toString('utf8')
            : String(init?.body ?? '')
        return new Response(Buffer.from(wavBuf), {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        })
      },
    })

    expect(capturedUrl).toBe('http://127.0.0.1:64597/tts')
    expect(JSON.parse(capturedBody)).toEqual({
      input: 'Oi Carlos! Tudo ótimo por aqui.',
      voice: 'female',
      language: 'pt',
      response_format: 'wav',
    })
    expect(result).not.toBeNull()
    expect(result?.sampleRate).toBe(24000)
    expect(result?.wavBytes.byteLength).toBeGreaterThan(1000)

    // Bounded timeout aborts a stalled /tts call cleanly without hanging
    const timedOut = await synthesizeNativeOllamaOmniSpeech({
      text: 'Teste de timeout',
      llamaServerBaseUrl: 'http://127.0.0.1:64597',
      timeoutMs: 25,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), {
            once: true,
          })
        }),
    })
    expect(timedOut).toBeNull()
  })

  it('transcribes audio via transcribeNativeOllamaOmniAudio using Perform ASR in Portuguese system prompt', async () => {
    let capturedBody: Record<string, unknown> | null = null
    const transcript = await transcribeNativeOllamaOmniAudio({
      audioWavBase64: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=',
      llamaServerBaseUrl: 'http://127.0.0.1:64597',
      fetchImpl: async (_url, init) => {
        const raw =
          init?.body instanceof Uint8Array
            ? Buffer.from(init.body).toString('utf8')
            : String(init?.body ?? '{}')
        capturedBody = JSON.parse(raw) as Record<string, unknown>
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '  Olá Ashy, você está me ouvindo?  ' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      },
    })

    expect(transcript).toBe('Olá Ashy, você está me ouvindo?')
    expect(JSON.stringify(capturedBody)).toContain('Perform ASR in Portuguese.')
  })

  it('orchestrates local Ollama LFM3-Omni-2B turn with compact system prompt, tools enabled, <|ACT {...}> recovery, and native 24kHz /tts turn:audio-delta emission', async () => {
    const dir = makeTempDir()
    const logPath = path.join(dir, 'server.log')
    fs.writeFileSync(
      logPath,
      'time=2026-10-31T19:30:00.000-03:00 level=INFO msg="starting llama-server" cmd="llama-server.exe --port 64599 --host 127.0.0.1"\n',
      'utf8',
    )

    const fakeSamples = new Float32Array(4800) // 200ms @ 24kHz
    for (let i = 0; i < fakeSamples.length; i++) {
      const t = i / 24000
      fakeSamples[i] =
        0.4 * Math.sin(2 * Math.PI * 210 * t) + 0.2 * Math.sin(2 * Math.PI * 720 * t)
    }
    const ttsWavBytes = encodeWavPcm16(fakeSamples, 24000)

    const capturedChatRequests: Array<Record<string, unknown>> = []
    let ttsCalled = false

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === 'http://127.0.0.1:64599/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
      }
      if (url === 'http://127.0.0.1:64599/tts') {
        ttsCalled = true
        return new Response(Buffer.from(ttsWavBytes), {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        })
      }
      if (url === 'http://127.0.0.1:11434/api/chat') {
        // Phase 10.0: the Ollama provider now uses the native /api/chat NDJSON adapter
        const bodyText =
          init?.body instanceof Uint8Array
            ? Buffer.from(init.body).toString('utf8')
            : String(init?.body ?? '{}')
        const parsed = JSON.parse(bodyText) as Record<string, unknown>
        capturedChatRequests.push(parsed)
        const ndjson = [
          JSON.stringify({
            message: {
              role: 'assistant',
              content:
                '<|ACT {"emotion":"curious","intensity":0.85,"motion":"head_tilt"}>Oi Carlos! Estou falando com minha voz nativa de 24kHz.',
            },
            done: false,
          }),
          JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }),
        ].join('\n')
        return new Response(`${ndjson}\n`, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      }
      if (url.endsWith('/chat/completions')) {
        const bodyText =
          init?.body instanceof Uint8Array
            ? Buffer.from(init.body).toString('utf8')
            : String(init?.body ?? '{}')
        const parsed = JSON.parse(bodyText) as Record<string, unknown>
        capturedChatRequests.push(parsed)

        // Simulate LFM3-Omni-2B streaming a malformed <|ACT {...}> (missing "|") and text-only SSE
        const sse = [
          'data: {"choices":[{"delta":{"content":"<|ACT {\\"emotion\\":\\"curious\\",\\"intensity\\":0.85,\\"motion\\":\\"head_tilt\\"}>Oi Carlos! Estou falando com minha voz nativa de 24kHz."}}]}\n\n',
          'data: [DONE]\n\n',
        ].join('')
        return new Response(sse, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const cortex = createAshyCortex({ dbPath: ':memory:' })
    const voiceStore = createVoiceIdentityStore({ userDataDir: dir })
    const providerVault = createProviderVault({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    providerVault.saveProviderConfig({
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M',
      omniExecutionMode: 'native-omni',
      omniVoiceId: 'female',
    })
    providerVault.setActiveProvider('ollama')

    const agencyRuntime = createHostAgencyRuntime({
      cortex,
      userDataDir: dir,
    })

    const orchestrator = createTurnOrchestrator({
      cortex,
      voiceStore,
      providerVault,
      agencyRuntime,
      ollamaLlamaServerOptions: {
        ollamaLogPath: logPath,
        fetchImpl: mockFetch as unknown as typeof fetch,
      },
      getBootstrapSnapshot: () => {
        throw new Error('use fallback snapshot in unit test')
      },
    })

    const events: AshyHostStreamEvent[] = []
    orchestrator.onEvent((ev) => events.push(ev))

    await orchestrator.sendTurn({
      sessionId: 'sess-omni-9-2',
      text: 'Oi Ashy, fala comigo!',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:completed')).toBe(true)
    })

    expect(capturedChatRequests.length).toBe(1)
    const chatReq = capturedChatRequests[0]!
    const messages = chatReq.messages as Array<{ role: string; content: string }>
    const sysMsg = messages.find((m) => m.role === 'system')
    expect(sysMsg).toBeDefined()
    expect(sysMsg!.content.length).toBeLessThan(2800)

    // Tools must remain enabled for local Ollama
    expect(Array.isArray(chatReq.tools)).toBe(true)
    expect((chatReq.tools as unknown[]).length).toBeGreaterThan(0)

    // Native /api/chat must override the GGUF's greedy top_k=1 metadata
    expect(chatReq.options).toMatchObject({ top_k: 40, top_p: 0.9, repeat_penalty: 1.1 })
    expect(chatReq.think).toBe(false)

    // Stage marker must be emitted even though LFM3 emitted }> instead of }|>
    const markerEv = events.find((e) => e.type === 'turn:marker')
    expect(markerEv).toBeDefined()
    if (markerEv?.type === 'turn:marker') {
      expect(markerEv.marker).toEqual({
        type: 'act',
        emotion: 'curious',
        intensity: 0.85,
        motion: 'head_tilt',
      })
    }

    // Native 24kHz /tts audio-delta must be synthesized and emitted before turn:completed
    expect(ttsCalled).toBe(true)
    const audioEv = events.find((e) => e.type === 'turn:audio-delta')
    expect(audioEv).toBeDefined()
    if (audioEv?.type === 'turn:audio-delta') {
      expect(audioEv.format).toBe('wav')
      expect(audioEv.sampleRate).toBe(24000)
      expect(audioEv.vowelFrames?.length).toBeGreaterThan(0)
    }

    const completedEv = events.find((e) => e.type === 'turn:completed')
    expect(completedEv).toBeDefined()
    if (completedEv?.type === 'turn:completed') {
      expect(completedEv.assistantMessage.content).toBe(
        'Oi Carlos! Estou falando com minha voz nativa de 24kHz.',
      )
      expect(completedEv.assistantMessage.content).not.toContain('<|ACT')
    }

    cortex.close()
  })
})
