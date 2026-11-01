/** Phase 10.1 test fakes: scripted realtime WS server, fake AudioContexts, fake microphone, fake host. */
import { vi } from 'vitest'
import {
  DEFAULT_LIVE_MODE_SETTINGS,
  type CallContextResult,
  type CallStageSignal,
  type CallVisemeFrame,
  type LiveModeSettings,
} from '@ashy/shared'
import {
  int16ToBase64,
  float32ToInt16,
  synthesizeVoicedSpeechPcm,
  type CallEngineHost,
  type CallRecordTurnInput,
  type CallReportStageInput,
  type CallReportStateInput,
  type CallReportTestResultInput,
  type CaptureAudioContextLike,
  type WebAudioContextLike,
  type WebSocketFactory,
  type WebSocketLike,
} from '../../src'

// ───────────────────────────── realtime server ─────────────────────────────

export interface FakeSocket extends WebSocketLike {
  url: string
  sent: Array<Record<string, unknown>>
  /** server → client */
  deliver(event: Record<string, unknown>): void
  serverClose(code?: number, reason?: string): void
}

export interface FakeRealtimeServerOptions {
  inputRate?: number
  outputRate?: number
  /** Auto-reply to session.update with session.updated (default true). */
  autoSessionUpdated?: boolean
  /** Called for every client message after it is recorded. */
  onClientMessage?: (socket: FakeSocket, msg: Record<string, unknown>) => void
}

export function createFakeRealtimeServer(opts: FakeRealtimeServerOptions = {}) {
  const sockets: FakeSocket[] = []
  let responseCounter = 0

  const factory: WebSocketFactory = (url: string) => {
    const socket: FakeSocket = {
      url,
      readyState: 0,
      sent: [],
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data: string) {
        const msg = JSON.parse(data) as Record<string, unknown>
        socket.sent.push(msg)
        if (msg.type === 'session.update' && opts.autoSessionUpdated !== false) {
          queueMicrotask(() => socket.deliver({ type: 'session.updated', session: msg.session }))
        }
        opts.onClientMessage?.(socket, msg)
      },
      close() {
        if (socket.readyState === 3) return
        ;(socket as { readyState: number }).readyState = 3
        queueMicrotask(() => socket.onclose?.({ code: 1000, reason: 'client close' }))
      },
      deliver(event) {
        if (socket.readyState !== 1) return
        socket.onmessage?.({ data: JSON.stringify(event) })
      },
      serverClose(code = 1006, reason = 'server gone') {
        ;(socket as { readyState: number }).readyState = 3
        socket.onclose?.({ code, reason })
      },
    }
    sockets.push(socket)
    queueMicrotask(() => {
      ;(socket as { readyState: number }).readyState = 1
      socket.onopen?.({})
      socket.deliver({
        type: 'session.created',
        session: {
          audio: {
            input: { format: { type: 'audio/pcm', rate: opts.inputRate ?? 16000 } },
            output: { format: { type: 'audio/pcm', rate: opts.outputRate ?? 24000 } },
          },
        },
      })
    })
    return socket
  }

  function streamResponse(
    socket: FakeSocket,
    script: { text?: string[]; audioMs?: number[]; done?: boolean; amplitude?: number },
  ): string {
    const id = `srv_resp_${++responseCounter}`
    socket.deliver({ type: 'response.created', response: { id, status: 'in_progress' } })
    const texts = script.text ?? []
    const audios = script.audioMs ?? []
    const n = Math.max(texts.length, audios.length)
    for (let i = 0; i < n; i++) {
      if (texts[i] !== undefined) socket.deliver({ type: 'response.output_text.delta', response_id: id, delta: texts[i] })
      if (audios[i] !== undefined) {
        socket.deliver({
          type: 'response.output_audio.delta',
          response_id: id,
          delta: pcmBase64(audios[i]!, opts.outputRate ?? 24000, script.amplitude ?? 0.4),
        })
      }
    }
    if (script.done !== false) socket.deliver({ type: 'response.done', response: { id, status: 'completed' } })
    return id
  }

  return {
    factory,
    sockets,
    get last(): FakeSocket {
      return sockets[sockets.length - 1]!
    },
    streamResponse,
  }
}

export function pcmBase64(durationMs: number, sampleRate: number, amplitude = 0.4): string {
  return int16ToBase64(float32ToInt16(synthesizeVoicedSpeechPcm({ durationMs, sampleRate, amplitude })))
}

export function sentTypes(socket: FakeSocket): string[] {
  return socket.sent.map((m) => String(m.type))
}

// ───────────────────────────── playback AudioContext ─────────────────────────────

interface FakeSource {
  buffer: { duration: number } | null
  startAt: number
  stopped: boolean
  onended: (() => void) | null
  connect: () => void
  start: (when?: number) => void
  stop: (when?: number) => void
}

export function createFakePlaybackContext() {
  const sources: FakeSource[] = []
  const gains: Array<{ gain: { value: number; setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn>; cancelScheduledValues: ReturnType<typeof vi.fn> } }> = []
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    state: 'running',
    destination: {},
    createGain: () => {
      const node = {
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }
      gains.push(node)
      return node
    },
    createBuffer: (_ch: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length)
      return { duration: length / sampleRate, getChannelData: () => data }
    },
    createBufferSource: () => {
      const node: FakeSource = {
        buffer: null,
        startAt: 0,
        stopped: false,
        onended: null,
        connect: () => {},
        start(when = 0) {
          node.startAt = when
        },
        stop() {
          node.stopped = true
        },
      }
      sources.push(node)
      return node
    },
  }
  /** Advances the audio clock and fires `onended` for finished sources. */
  function advance(sec: number): void {
    ctx.currentTime += sec
    for (const s of sources) {
      if (s.stopped || !s.buffer) continue
      if (s.startAt + s.buffer.duration <= ctx.currentTime + 1e-9) {
        s.stopped = true
        s.onended?.()
      }
    }
  }
  return { ctx: ctx as unknown as WebAudioContextLike & typeof ctx, sources, gains, advance }
}

// ───────────────────────────── microphone ─────────────────────────────

export function createFakeMicrophone() {
  let port: { onmessage: ((event: { data: unknown }) => void) | null } | null = null
  const tracks = [{ stop: vi.fn(), kind: 'audio' }]
  const mediaDevices = {
    getUserMedia: vi.fn(async () => ({ getTracks: () => tracks, getAudioTracks: () => tracks })),
  }
  const captureContextFactory = (): CaptureAudioContextLike => ({
    sampleRate: 16000,
    state: 'running',
    destination: {},
    close: async () => {},
    createMediaStreamSource: () => ({ connect: () => {}, disconnect: () => {} }),
    createAudioWorkletNode: () => {
      const node = {
        port: { onmessage: null as ((event: { data: unknown }) => void) | null },
        connect: () => {},
        disconnect: () => {},
      }
      port = node.port
      return node
    },
  })
  function push(samples: Float32Array): void {
    // Worklet delivers 128-sample render quanta; the capture re-frames to 20 ms blocks.
    for (let i = 0; i < samples.length; i += 128) {
      port?.onmessage?.({ data: samples.slice(i, i + 128) })
    }
  }
  return {
    mediaDevices,
    captureContextFactory,
    tracks,
    push,
    speech(ms: number) {
      push(synthesizeVoicedSpeechPcm({ durationMs: ms, sampleRate: 16000, amplitude: 0.5 }))
    },
    silence(ms: number) {
      push(new Float32Array(Math.round((ms / 1000) * 16000)))
    },
    get attached() {
      return port !== null
    },
  }
}

// ───────────────────────────── host ─────────────────────────────

export const TEST_INSTRUCTIONS =
  "You are Ashy.\nAlways respond in Brazilian Portuguese, briefly and naturally (1–3 sentences unless asked).\nRespond in interleaved text and audio."

export function createFakeHost(
  opts: {
    transcript?: string | (() => string)
    perTurnContext?: string
    asrDelayMs?: number
    classifyAffect?: (text: string) => CallStageSignal | null
  } = {},
) {
  const affects: Array<{ callId: string; text: string }> = []
  const stages: Array<CallReportStageInput & { at: number }> = []
  const testResults: CallReportTestResultInput[] = []
  const states: CallReportStateInput[] = []
  const turns: CallRecordTurnInput[] = []
  const visemes: CallVisemeFrame[] = []
  const contexts: Array<{ callId: string; userText?: string; interruptedAfterText?: string }> = []
  const transcribes: Array<{ callId: string; audioWavBase64: string }> = []
  const host: CallEngineHost = {
    buildContext: vi.fn(async (input) => {
      contexts.push(input)
      const res: CallContextResult = {
        sessionId: 's1',
        instructions: TEST_INSTRUCTIONS,
        perTurnContext: input.userText ? (opts.perTurnContext ?? '[Contexto] hora local 21:00') : '',
      }
      return res
    }),
    transcribe: vi.fn(async (input) => {
      transcribes.push(input)
      if (opts.asrDelayMs) await new Promise((r) => setTimeout(r, opts.asrDelayMs))
      const text = typeof opts.transcript === 'function' ? opts.transcript() : (opts.transcript ?? 'me fala de gatos')
      return { text, providerId: 'fake-stt', latencyMs: 5 }
    }),
    recordTurn: vi.fn(async (input) => {
      turns.push(input)
      return { ok: true }
    }),
    reportState: vi.fn((input) => {
      states.push(input)
    }),
    reportViseme: vi.fn((frame) => {
      visemes.push(frame)
    }),
    // Phase 10.2
    classifyAffect: vi.fn(async (input) => {
      affects.push(input)
      return opts.classifyAffect ? opts.classifyAffect(input.text) : null
    }),
    reportStage: vi.fn(async (input) => {
      stages.push({ ...input, at: Date.now() })
      return { ok: true }
    }),
    reportTestResult: vi.fn(async (input) => {
      testResults.push(input)
      return { ok: true }
    }),
    synthesize: vi.fn(async () => ({ pcmBase64: '', sampleRate: 24000, durationMs: 0, latencyMs: 0 })),
  }
  return { host, states, turns, visemes, contexts, transcribes, affects, stages, testResults }
}

export function testSettings(patch: {
  turn?: Partial<LiveModeSettings['turn']>
  interrupt?: Partial<LiveModeSettings['interrupt']>
  llamacpp?: Partial<LiveModeSettings['llamacpp']>
  session?: Partial<LiveModeSettings['session']>
} = {}): LiveModeSettings {
  return {
    ...DEFAULT_LIVE_MODE_SETTINGS,
    session: { ...DEFAULT_LIVE_MODE_SETTINGS.session, ...(patch.session ?? {}) },
    llamacpp: { ...DEFAULT_LIVE_MODE_SETTINGS.llamacpp, ...(patch.llamacpp ?? {}) },
    turn: { ...DEFAULT_LIVE_MODE_SETTINGS.turn, ...(patch.turn ?? {}) },
    interrupt: { ...DEFAULT_LIVE_MODE_SETTINGS.interrupt, ...(patch.interrupt ?? {}) },
  }
}

export async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await vi.advanceTimersByTimeAsync(0)
  }
}
