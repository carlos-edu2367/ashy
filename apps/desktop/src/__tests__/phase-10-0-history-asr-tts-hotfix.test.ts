import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAshyCortex } from '@ashy/cortex'
import type { AshyHostStreamEvent } from '@ashy/shared'
import { encodeWavPcm16, synthesizeVoicedSpeechPcm } from '@ashy/voice'
import {
  LOCAL_PROVIDER_HISTORY_LIMITS,
  OMNI_VOICE_PLACEHOLDER_TEXT,
  isPlaceholderUserContent,
  resolveConversationHistoryLimits,
  sanitizeConversationHistory,
  textSimilarity,
} from '../host/conversation-history'
import {
  deriveOllamaOrigin,
  isChatStyleNonTranscript,
  normalizeNativeOmniTtsVoice,
  synthesizeNativeOllamaOmniSpeech,
  transcribeNativeOllamaOmniAudio,
} from '../host/ollama-native-audio-bridge'
import { createProviderVault } from '../host/provider-vault'
import {
  MIN_OMNI_INPUT_AUDIO_DURATION_MS,
  assessOmniInputAudio,
  createTurnOrchestrator,
} from '../host/turn-orchestrator'
import { createVoiceIdentityStore } from '../host/voice-identity-store'

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-10-0-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    } catch {
      // ignore Windows cleanup errors
    }
  }
})

const LONG_GREETING =
  'Oi, Carlos! Tudo bem? Estou aqui, pronta para te ouvir. O que você quer que eu analise ou te conte hoje?'
const SHORT_GREETING = 'Carlos, o que você quer que eu analise ou te conte hoje?'

function wavBase64(durationMs: number, opts?: { silent?: boolean; sampleRate?: number }): string {
  const sampleRate = opts?.sampleRate ?? 16000
  const samples = opts?.silent
    ? new Float32Array(Math.round((durationMs / 1000) * sampleRate))
    : synthesizeVoicedSpeechPcm(durationMs, sampleRate)
  return Buffer.from(encodeWavPcm16(samples, sampleRate)).toString('base64')
}

describe('Phase 10.0 T2 — sanitizeConversationHistory', () => {
  it('cleans the real poisoned live session (placeholders + 3 near-identical greetings)', () => {
    const poisoned = [
      { role: 'user', content: 'Oi Ashy' },
      { role: 'assistant', content: LONG_GREETING },
      { role: 'user', content: OMNI_VOICE_PLACEHOLDER_TEXT },
      { role: 'assistant', content: LONG_GREETING },
      { role: 'user', content: OMNI_VOICE_PLACEHOLDER_TEXT },
      { role: 'assistant', content: SHORT_GREETING },
      { role: 'user', content: 'Me conta uma curiosidade sobre o espaço.' },
      { role: 'assistant', content: 'Oi, Carlos! Tudo bem? Estou aqui, pronta para te ouvir. O que você quer que eu analise ou te conte hoje?' },
      { role: 'user', content: '   ' },
      { role: 'assistant', content: SHORT_GREETING },
      { role: 'user', content: 'Qual é a capital da Austrália?' },
      { role: 'assistant', content: 'É Camberra, não Sydney!' },
    ]
    const out = sanitizeConversationHistory(poisoned, LOCAL_PROVIDER_HISTORY_LIMITS)

    expect(out.some((m) => m.content === OMNI_VOICE_PLACEHOLDER_TEXT)).toBe(false)
    expect(out.some((m) => m.content.trim().length === 0)).toBe(false)
    const greetings = out.filter(
      (m) => m.role === 'assistant' && textSimilarity(m.content, SHORT_GREETING) >= 0.85,
    )
    expect(greetings.length).toBeLessThanOrEqual(1)
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.role).not.toBe(out[i - 1]!.role)
    }
    expect(out[out.length - 1]).toEqual({ role: 'assistant', content: 'É Camberra, não Sydney!' })
    expect(out.length).toBeLessThanOrEqual(8)
  })

  it('treats ACT-marker / accent / punctuation variants as duplicates and keeps the newest', () => {
    const out = sanitizeConversationHistory(
      [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: '<|ACT {"emotion":"happy"}|>Oi, Carlos! Tudo bem? Estou aqui, pronta para te ouvir.' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'oi carlos tudo bem estou aqui pronta para te ouvir' },
      ],
      { maxMessages: 80, maxChars: 100_000 },
    )
    expect(out).toEqual([
      { role: 'user', content: 'a\nb' },
      { role: 'assistant', content: 'oi carlos tudo bem estou aqui pronta para te ouvir' },
    ])
  })

  it('keeps distinct replies and short replies that merely overlap', () => {
    const history = [
      { role: 'user', content: 'Tudo bem?' },
      { role: 'assistant', content: 'Tudo bem!' },
      { role: 'user', content: 'Me explica o que é um buraco negro.' },
      { role: 'assistant', content: 'É uma região onde a gravidade é tão forte que nem a luz escapa.' },
    ]
    expect(sanitizeConversationHistory(history, { maxMessages: 80, maxChars: 100_000 })).toEqual(
      history,
    )
  })

  it('drops trailing user messages and caps by messages and chars from the oldest', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i % 2 === 0 ? 'pergunta' : 'resposta'} número ${i} ${'x'.repeat(i)} assunto${i}`,
    }))
    many.push({ role: 'user', content: 'pergunta que falhou' })
    const byCount = sanitizeConversationHistory(many, { maxMessages: 8, maxChars: 100_000 })
    expect(byCount).toHaveLength(8)
    expect(byCount[byCount.length - 1]!.content).toContain('número 19')

    const byChars = sanitizeConversationHistory(many, { maxMessages: 80, maxChars: 200 })
    expect(byChars.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(200)
    expect(byChars[byChars.length - 1]!.content).toContain('número 19')

    const single = sanitizeConversationHistory([{ role: 'assistant', content: 'y'.repeat(50) }], {
      maxMessages: 8,
      maxChars: 10,
    })
    expect(single[0]!.content).toHaveLength(10)
  })

  it('policy: Ollama gets 8 msgs / 6000 chars, cloud providers keep 80', () => {
    expect(resolveConversationHistoryLimits('ollama')).toEqual({ maxMessages: 8, maxChars: 6000 })
    expect(resolveConversationHistoryLimits('openrouter').maxMessages).toBe(80)
    expect(isPlaceholderUserContent('🎤 (áudio sem transcrição)')).toBe(true)
    expect(isPlaceholderUserContent('ashy-omni-turn-rev-3')).toBe(true)
    expect(isPlaceholderUserContent('oi')).toBe(false)
  })
})

describe('Phase 10.0 T2 — ASR duration/RMS guard', () => {
  it('measures WAV duration and RMS', () => {
    const short = assessOmniInputAudio({ dataBase64: wavBase64(250), format: 'wav' })
    expect(short?.tooShort).toBe(true)
    const ok = assessOmniInputAudio({
      dataBase64: `data:audio/wav;base64,${wavBase64(900)}`,
      format: 'wav',
    })
    expect(ok?.durationMs).toBeGreaterThanOrEqual(MIN_OMNI_INPUT_AUDIO_DURATION_MS)
    expect(ok?.tooShort).toBe(false)
    expect(ok?.silent).toBe(false)
    const silent = assessOmniInputAudio({ dataBase64: wavBase64(900, { silent: true }), format: 'wav' })
    expect(silent?.silent).toBe(true)
    expect(assessOmniInputAudio({ dataBase64: 'Tk9UX0FfV0FW', format: 'wav' })).toBeNull()
    expect(assessOmniInputAudio({ dataBase64: wavBase64(100), format: 'pcm16' })).toBeNull()
  })

  it('discards a sub-400ms transcript-less voice turn: no persistence, no ASR/LLM, turn:aborted', async () => {
    const dir = makeTempDir()
    const fetchCalls: string[] = []
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      fetchCalls.push(typeof input === 'string' ? input : input.toString())
      return new Response('unexpected', { status: 500 })
    })
    const cortex = createAshyCortex({ dbPath: ':memory:' })
    const providerVault = createProviderVault({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    providerVault.saveProviderConfig({
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M',
      omniExecutionMode: 'native-omni',
      omniVoiceId: 'ashy-warm-ptbr',
    })
    providerVault.setActiveProvider('ollama')
    const orchestrator = createTurnOrchestrator({
      cortex,
      voiceStore: createVoiceIdentityStore({ userDataDir: dir }),
      providerVault,
      ollamaLlamaServerOptions: {
        llamaServerBaseUrl: 'http://127.0.0.1:64599',
        fetchImpl: mockFetch as unknown as typeof fetch,
      },
      getBootstrapSnapshot: () => {
        throw new Error('unused')
      },
    })
    const events: AshyHostStreamEvent[] = []
    orchestrator.onEvent((ev) => events.push(ev))

    const res = await orchestrator.sendTurn({
      sessionId: 'sess-10-0',
      text: '',
      inputAudio: { dataBase64: wavBase64(180), format: 'wav', sampleRate: 16000 },
    })
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:aborted' && e.turnId === res.turnId)).toBe(true)
    })
    expect(events.some((e) => e.type === 'turn:started')).toBe(false)
    expect(cortex.listChatMessages('sess-10-0', 80)).toHaveLength(0)
    expect(fetchCalls).toHaveLength(0)
    cortex.close()
  })
})

describe('Phase 10.0 T2 — Ollama official /v1/audio/transcriptions', () => {
  const audioWavBase64 = `data:audio/wav;base64,${wavBase64(800)}`

  it('prefers the official endpoint with multipart model/language/file', async () => {
    const urls: string[] = []
    let form: FormData | null = null
    const transcript = await transcribeNativeOllamaOmniAudio({
      audioWavBase64,
      ollamaBaseUrl: 'http://127.0.0.1:11434/v1',
      llamaServerBaseUrl: 'http://127.0.0.1:64597',
      modelId: 'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M',
      fetchImpl: async (url, init) => {
        urls.push(String(url))
        form = init?.body as FormData
        return new Response(JSON.stringify({ text: ' Oi Ashy, tudo bem? ' }), { status: 200 })
      },
    })
    expect(transcript).toBe('Oi Ashy, tudo bem?')
    expect(urls).toEqual(['http://127.0.0.1:11434/v1/audio/transcriptions'])
    expect(form).toBeInstanceOf(FormData)
    expect(form!.get('model')).toBe('hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M')
    expect(form!.get('language')).toBe('pt')
    expect(form!.get('file')).toBeInstanceOf(Blob)
  })

  it('falls back to the llama-server chat path when the official endpoint fails', async () => {
    const urls: string[] = []
    const transcript = await transcribeNativeOllamaOmniAudio({
      audioWavBase64,
      ollamaBaseUrl: 'http://127.0.0.1:11434/v1',
      llamaServerBaseUrl: 'http://127.0.0.1:64597',
      modelId: 'lfm3',
      fetchImpl: async (url) => {
        urls.push(String(url))
        if (String(url).endsWith('/audio/transcriptions')) {
          return new Response('{"error":"not supported"}', { status: 500 })
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'Me conta uma piada' } }] }),
          { status: 200 },
        )
      },
    })
    expect(transcript).toBe('Me conta uma piada')
    expect(urls).toEqual([
      'http://127.0.0.1:11434/v1/audio/transcriptions',
      'http://127.0.0.1:64597/v1/chat/completions',
    ])
  })

  it('rejects chat-style non-transcripts as failed ASR (no retry)', async () => {
    const urls: string[] = []
    const transcript = await transcribeNativeOllamaOmniAudio({
      audioWavBase64,
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      llamaServerBaseUrl: 'http://127.0.0.1:64597',
      modelId: 'lfm3',
      fetchImpl: async (url) => {
        urls.push(String(url))
        return new Response(JSON.stringify({ text: 'A única palavra falada é "Ah".' }), {
          status: 200,
        })
      },
    })
    expect(transcript).toBeNull()
    expect(urls).toHaveLength(1)
  })

  it('heuristic flags meta answers but keeps real speech', () => {
    for (const junk of [
      'A única palavra falada é "Ah".',
      'O áudio contém apenas ruído.',
      'Não há fala neste áudio.',
      'Desculpe, não consigo transcrever esse áudio.',
      'Não consigo entender o que foi dito no áudio.',
      'A palavra dita foi "oi".',
      '[silêncio]',
      '...',
      '',
    ]) {
      expect(isChatStyleNonTranscript(junk), junk).toBe(true)
    }
    for (const speech of [
      'Oi Ashy, tudo bem?',
      'Não consigo dormir hoje.',
      'Desculpe, Ashy, eu me atrasei.',
      'Não há nada melhor que café.',
      'Me conta uma curiosidade sobre o espaço.',
    ]) {
      expect(isChatStyleNonTranscript(speech), speech).toBe(false)
    }
  })

  it('derives the Ollama origin from the OpenAI-compatible baseUrl', () => {
    expect(deriveOllamaOrigin('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434')
    expect(deriveOllamaOrigin('http://localhost:11434/')).toBe('http://localhost:11434')
    expect(deriveOllamaOrigin('')).toBeNull()
    expect(deriveOllamaOrigin('not a url')).toBeNull()
  })
})

describe('Phase 10.0 T2 — /tts voice normalization', () => {
  it('maps persona ids onto female/male', () => {
    expect(normalizeNativeOmniTtsVoice('ashy-warm-ptbr')).toBe('female')
    expect(normalizeNativeOmniTtsVoice(undefined)).toBe('female')
    expect(normalizeNativeOmniTtsVoice('female')).toBe('female')
    expect(normalizeNativeOmniTtsVoice('pt-BR-feminina')).toBe('female')
    expect(normalizeNativeOmniTtsVoice('male')).toBe('male')
    expect(normalizeNativeOmniTtsVoice('voz-masculina-grave')).toBe('male')
  })

  it('sends the normalized voice to /tts', async () => {
    let body: Record<string, unknown> = {}
    const wav = encodeWavPcm16(synthesizeVoicedSpeechPcm(200, 24000), 24000)
    await synthesizeNativeOllamaOmniSpeech({
      text: 'Oi Carlos!',
      voice: 'ashy-warm-ptbr',
      llamaServerBaseUrl: 'http://127.0.0.1:64597',
      fetchImpl: async (_url, init) => {
        body = JSON.parse(Buffer.from(init?.body as Uint8Array).toString('utf8')) as Record<
          string,
          unknown
        >
        return new Response(Buffer.from(wav), { status: 200 })
      },
    })
    expect(body.voice).toBe('female')
  })
})
