/**
 * Phase 10.4 — cloud speech-to-speech backends, host side:
 *
 * - API keys (`liveMode:setApiKey` / `liveMode:getKeyStatus`): encrypted with the kernel's secret
 *   protector (AES-GCM envelope, AAD per provider) in `<userData>/live-cloud-keys.json`; only masked
 *   status ever leaves the host. OpenAI falls back to the key already configured for the chat/voice.
 * - `call:start` validation (key present, URL/model sane) and `call:getRuntimeConfig.cloud` (the
 *   renderer gets the loopback relay URL, never the key: see cloud-relay.ts).
 * - Session instructions for cloud models: these are big models, so they get the FULL persona (the chat
 *   soul prompt), the user's name, a recent slice of the shared chat history and a call-mode block —
 *   unlike the compact English llama.cpp prompt.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  CLOUD_REALTIME_PRESETS,
  GEMINI_LIVE_DEFAULTS,
  LIVE_KEY_PROVIDERS,
  maskApiKey,
  type CallEndReason,
  type CallRuntimeConfig,
  type LiveBackendId,
  type LiveKeyProvider,
  type LiveKeyStatus,
  type LiveModeSettings,
} from '@ashy/shared'
import { writeAtomicWithBackup } from '../atomic-file'
import type { SecretProtector } from '../secret-protector'
import { createCloudRelay, RELAY_CLOSE, type CloudRelay, type CloudRelayResolution, type ConnectUpstream } from './cloud-relay'

export const LIVE_CLOUD_KEYS_FILE = 'live-cloud-keys.json'
export const GEMINI_LIVE_UPSTREAM_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

export function isCloudBackend(backend: LiveBackendId): backend is 'openai-realtime' | 'gemini-live' {
  return backend === 'openai-realtime' || backend === 'gemini-live'
}

// ───────────────────────────── keys ─────────────────────────────

interface KeysDocument {
  version: 1
  keys: Partial<Record<LiveKeyProvider, string>>
}

export interface LiveCloudKeyStore {
  set(provider: LiveKeyProvider, apiKey: string): LiveKeyStatus
  /** Decrypted key (host only). Falls back to `fallbackKey` (e.g. OpenAI chat key). */
  get(provider: LiveKeyProvider): string | null
  status(): LiveKeyStatus
}

export function createLiveCloudKeyStore(opts: {
  userDataDir: string
  protector: Pick<SecretProtector, 'encryptEnvelope' | 'decryptEnvelope'>
  fallbackKey?: (provider: LiveKeyProvider) => string | null
}): LiveCloudKeyStore {
  const filePath = path.join(opts.userDataDir, LIVE_CLOUD_KEYS_FILE)
  const aad = (p: LiveKeyProvider) => `ashy:live-cloud-key:${p}`

  function read(): KeysDocument {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<KeysDocument>
      const keys: KeysDocument['keys'] = {}
      for (const p of LIVE_KEY_PROVIDERS) {
        const v = parsed?.keys?.[p]
        if (typeof v === 'string' && v.startsWith('enc:v1:')) keys[p] = v
      }
      return { version: 1, keys }
    } catch {
      return { version: 1, keys: {} }
    }
  }

  function decrypt(doc: KeysDocument, p: LiveKeyProvider): string | null {
    const cipher = doc.keys[p]
    if (!cipher) return null
    try {
      const plain = opts.protector.decryptEnvelope(cipher, aad(p)).trim()
      return plain.length > 0 ? plain : null
    } catch {
      return null
    }
  }

  function fallback(p: LiveKeyProvider): string | null {
    try {
      const k = opts.fallbackKey?.(p)?.trim()
      return k ? k : null
    } catch {
      return null
    }
  }

  function status(): LiveKeyStatus {
    const doc = read()
    const out = {} as LiveKeyStatus
    for (const p of LIVE_KEY_PROVIDERS) {
      const key = decrypt(doc, p) ?? fallback(p)
      out[p] = { hasKey: key !== null, masked: key ? maskApiKey(key) : null }
    }
    return out
  }

  return {
    set(provider, apiKey) {
      const doc = read()
      const trimmed = apiKey.trim()
      if (trimmed.length === 0) delete doc.keys[provider]
      else {
        if (/\s/.test(trimmed)) throw new Error('INVALID_API_KEY: the key must not contain spaces')
        doc.keys[provider] = opts.protector.encryptEnvelope(trimmed, aad(provider))
      }
      writeAtomicWithBackup(filePath, `${JSON.stringify(doc, null, 2)}\n`, { rotateBackup: false })
      return status()
    },
    get(provider) {
      return decrypt(read(), provider) ?? fallback(provider)
    },
    status,
  }
}

// ───────────────────────────── targets ─────────────────────────────

export interface ResolvedCloudTarget {
  kind: 'openai-compatible' | 'gemini'
  keyProvider: LiveKeyProvider
  /** Upstream WebSocket URL WITHOUT credentials. */
  url: string
  model: string
  voice: string
  /** A key is required (custom servers may run without one). */
  keyRequired: boolean
}

export type CloudTargetCheck = { ok: true; target: ResolvedCloudTarget } | { ok: false; reason: CallEndReason; detail: string }

function withQuery(url: string, key: string, value: string): string {
  if (new RegExp(`[?&]${key}=`).test(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`
}

/** Resolves the cloud endpoint of a backend from the Live Mode settings + presets. */
export function resolveCloudTarget(settings: LiveModeSettings, backend: LiveBackendId): CloudTargetCheck {
  if (backend === 'gemini-live') {
    const model = (settings.gemini?.model || GEMINI_LIVE_DEFAULTS.model).trim()
    const voice = (settings.gemini?.voice || GEMINI_LIVE_DEFAULTS.voice).trim()
    return { ok: true, target: { kind: 'gemini', keyProvider: 'gemini', url: GEMINI_LIVE_UPSTREAM_URL, model, voice, keyRequired: true } }
  }
  if (backend !== 'openai-realtime') {
    return { ok: false, reason: 'backend_not_implemented', detail: `not a cloud backend: ${backend}` }
  }
  const rc = settings.realtimeCloud ?? { provider: 'openai', url: '', model: '', voice: '' }
  const provider = rc.provider ?? 'openai'
  const preset = CLOUD_REALTIME_PRESETS[provider] ?? CLOUD_REALTIME_PRESETS.openai
  const url = (rc.url || preset.url).trim()
  const model = (rc.model || preset.model).trim()
  const voice = (rc.voice || preset.voice).trim()
  if (!url) return { ok: false, reason: 'backend_unavailable', detail: 'Endpoint de voz na nuvem não configurado (URL vazia).' }
  if (/[{}]/.test(url)) {
    return { ok: false, reason: 'backend_unavailable', detail: `Substitua o marcador na URL do endpoint (${url.replace(/\?.*$/, '')}).` }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'backend_unavailable', detail: 'URL do endpoint de voz inválida.' }
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1'
  if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && loopback)) {
    return { ok: false, reason: 'backend_unavailable', detail: 'O endpoint precisa ser wss:// (ou ws:// local).' }
  }
  if (!model) return { ok: false, reason: 'backend_unavailable', detail: 'Modelo do endpoint de voz não configurado.' }
  return {
    ok: true,
    target: {
      kind: 'openai-compatible',
      keyProvider: provider,
      url: withQuery(url.replace(/\/+$/, ''), 'model', model),
      model,
      voice,
      keyRequired: provider !== 'custom',
    },
  }
}

/** Upstream auth for a target + key (host/main only). */
export function upstreamAuthFor(target: ResolvedCloudTarget, key: string | null): { url: string; headers: Record<string, string> } {
  if (target.kind === 'gemini') {
    // Gemini Live documents only `?key=` (or ephemeral tokens) for the WebSocket.
    return { url: key ? withQuery(target.url, 'key', key) : target.url, headers: {} }
  }
  // OpenAI GA + DashScope: `Authorization: Bearer`. GA needs no `OpenAI-Beta` header any more.
  return { url: target.url, headers: key ? { Authorization: `Bearer ${key}` } : {} }
}

const PROVIDER_LABEL: Record<LiveKeyProvider, string> = {
  openai: 'OpenAI',
  qwen: 'Alibaba DashScope (Qwen)',
  custom: 'endpoint personalizado',
  gemini: 'Google Gemini',
}

export interface LiveCloud {
  readonly keys: LiveCloudKeyStore
  /** `call:start` check for cloud backends (relay listening, target valid, key present). */
  prepareStart(settings: LiveModeSettings, backend: LiveBackendId): Promise<CloudTargetCheck>
  /** `call:getRuntimeConfig.cloud` for the active call. */
  runtimeConfig(callId: string, settings: LiveModeSettings, backend: LiveBackendId): CallRuntimeConfig['cloud']
  /** Main process: header to inject into the call window's requests to the relay port (SECRET). */
  getRelayAuth(): ReturnType<CloudRelay['getAuth']>
  readonly relay: CloudRelay
  close(): Promise<void>
}

export function createLiveCloud(opts: {
  keys: LiveCloudKeyStore
  getSettings(): LiveModeSettings
  /** The relay only serves the active cloud call (late-bound: the hub is created after). */
  getActiveCall(): { callId: string; backend: LiveBackendId } | null
  /** Tests: a prebuilt relay, or a fake upstream connector for the real relay. */
  relay?: CloudRelay
  connectUpstream?: ConnectUpstream
  log?: (message: string, data?: unknown) => void
}): LiveCloud {
  const relay =
    opts.relay ??
    createCloudRelay({
      resolveTarget: createRelayResolver({ getActiveCall: opts.getActiveCall, getSettings: opts.getSettings, keys: opts.keys }),
      ...(opts.connectUpstream ? { connectUpstream: opts.connectUpstream } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    })

  function check(settings: LiveModeSettings, backend: LiveBackendId): CloudTargetCheck {
    const resolved = resolveCloudTarget(settings, backend)
    if (!resolved.ok) return resolved
    if (resolved.target.keyRequired && !opts.keys.get(resolved.target.keyProvider)) {
      return {
        ok: false,
        reason: 'backend_unavailable',
        detail: `Chave de API do ${PROVIDER_LABEL[resolved.target.keyProvider]} não configurada (Configurações › Modo ao vivo).`,
      }
    }
    return resolved
  }

  return {
    keys: opts.keys,
    relay,
    async prepareStart(settings, backend) {
      const res = check(settings, backend)
      if (!res.ok) return res
      try {
        await relay.ensureListening()
      } catch (err) {
        return { ok: false, reason: 'backend_unavailable', detail: `relay local indisponível: ${String((err as Error)?.message ?? err)}` }
      }
      return res
    },
    runtimeConfig(callId, settings, backend) {
      if (!isCloudBackend(backend)) return null
      const resolved = resolveCloudTarget(settings, backend)
      const url = relay.urlFor(callId)
      if (!resolved.ok || !url) return null
      return { kind: resolved.target.kind, url, model: resolved.target.model, voice: resolved.target.voice }
    },
    getRelayAuth() {
      return relay.getAuth()
    },
    close() {
      return relay.close()
    },
  }
}

/** Relay resolver: only the active cloud call's id resolves; settings + key are read at connect time. */
export function createRelayResolver(deps: {
  getActiveCall(): { callId: string; backend: LiveBackendId } | null
  getSettings(): LiveModeSettings
  keys: LiveCloudKeyStore
}): (id: string) => CloudRelayResolution {
  return (id) => {
    const call = deps.getActiveCall()
    if (!call || call.callId !== id || !isCloudBackend(call.backend)) {
      return { ok: false, code: RELAY_CLOSE.FORBIDDEN, reason: 'no active cloud call' }
    }
    const resolved = resolveCloudTarget(deps.getSettings(), call.backend)
    if (!resolved.ok) return { ok: false, code: RELAY_CLOSE.FORBIDDEN, reason: resolved.detail.slice(0, 100) }
    const key = deps.keys.get(resolved.target.keyProvider)
    if (!key && resolved.target.keyRequired) return { ok: false, code: RELAY_CLOSE.NO_KEY, reason: resolved.target.keyProvider }
    const auth = upstreamAuthFor(resolved.target, key)
    return { ok: true, target: { url: auth.url, headers: auth.headers, ...(key ? { secrets: [key] } : {}) } }
  }
}

// ───────────────────────────── instructions ─────────────────────────────

/** Optional (forward-compatible) `settings.cloudContext` knobs; defaults when absent. */
export interface CloudContextOptions {
  /** Include Ashy's full persona (the chat soul prompt). Default true. */
  includePersona: boolean
  /** Recent chat messages of the active session in the instructions. Default 12. */
  recentMessages: number
  /** Memories retrieved per user turn. Default 4. */
  memoryTopK: number
  /** Hard cap of the session instructions. Default 16000 chars. */
  maxInstructionsChars: number
}

export const DEFAULT_CLOUD_CONTEXT: CloudContextOptions = {
  includePersona: true,
  recentMessages: 12,
  memoryTopK: 4,
  maxInstructionsChars: 16000,
}

export function readCloudContextOptions(settings: LiveModeSettings): CloudContextOptions {
  const raw = (settings as unknown as { cloudContext?: Partial<CloudContextOptions> }).cloudContext ?? {}
  const num = (v: unknown, min: number, max: number, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : d
  return {
    includePersona: typeof raw.includePersona === 'boolean' ? raw.includePersona : DEFAULT_CLOUD_CONTEXT.includePersona,
    recentMessages: num(raw.recentMessages, 0, 60, DEFAULT_CLOUD_CONTEXT.recentMessages),
    memoryTopK: num(raw.memoryTopK, 0, 12, DEFAULT_CLOUD_CONTEXT.memoryTopK),
    maxInstructionsChars: num(raw.maxInstructionsChars, 2000, 60000, DEFAULT_CLOUD_CONTEXT.maxInstructionsChars),
  }
}

function clean(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\0/g, '').replace(/<\|[\s\S]*?(?:\|>|\}>)/g, ' ').trim()
}

export interface CloudInstructionsInput {
  /** Chat soul prompt (`compileTurnPrompt(...).staticSystemPrompt`), when available. */
  persona?: string | null
  userName?: string | null
  /** Oldest first. */
  recentMessages?: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
  tools?: boolean
  options?: CloudContextOptions
}

export const CLOUD_CALL_MODE_BLOCK = [
  '## Modo chamada de voz (ao vivo)',
  'Você está numa chamada de voz em tempo real com o usuário. Tudo o que você disser será falado em voz alta.',
  'Fale SEMPRE em português do Brasil, com naturalidade, como numa ligação com alguém próximo.',
  'Seja breve (1–3 frases), a menos que o usuário peça mais. Nada de listas, markdown, emojis, títulos ou rubricas — só fala.',
  'Se for interrompida, pare e escute; não repita o que já foi dito.',
  'Notas que começam com [Contexto] ou [Tela] são informação privada de bastidor: use em silêncio, nunca as leia nem as cite.',
].join('\n')

export const CLOUD_CALL_TOOLS_BLOCK = [
  'Você tem ferramentas (janela ativa, tela autorizada, ler arquivo, salvar nota). Use-as quando o pedido precisar;',
  'avise rapidamente antes ("vou dar uma olhada") e depois conte o resultado em poucas palavras.',
  'Se o resultado disser "aguardando_aprovacao", peça ao usuário para aprovar — nunca diga que já foi feito.',
].join('\n')

/** Rich session instructions for cloud speech-to-speech models. */
export function buildCloudCallInstructions(input: CloudInstructionsInput): string {
  const opts = input.options ?? DEFAULT_CLOUD_CONTEXT
  const parts: string[] = []
  const persona = clean(input.persona)
  if (opts.includePersona && persona) parts.push(persona)
  else parts.push("Você é a Ashy, a companheira de IA do usuário: curiosa, brincalhona, um pouco sarcástica, calorosa quando o assunto é sério. Seja honesta sobre ser uma IA.")
  const name = clean(input.userName).replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 40).trim()
  if (name) parts.push(`O nome do usuário é ${name}.`)
  const tail: string[] = [CLOUD_CALL_MODE_BLOCK]
  if (input.tools) tail.push(CLOUD_CALL_TOOLS_BLOCK)

  const history = (input.recentMessages ?? []).slice(-opts.recentMessages)
  let historyBlock = ''
  if (history.length > 0) {
    const label = name || 'Usuário'
    const lines = history
      .map((m) => {
        const text = clean(m.content).replace(/\s+/g, ' ').slice(0, 600)
        return text ? `${m.role === 'user' ? label : 'Ashy'}: ${text}` : ''
      })
      .filter(Boolean)
    if (lines.length > 0) historyBlock = ['## Conversa recente (chat compartilhado, antes desta chamada)', ...lines].join('\n')
  }
  const fixedTail = tail.join('\n\n')
  const max = opts.maxInstructionsChars
  let head = parts.join('\n\n')
  // Budget: the call-mode block always survives; history is trimmed first, then the persona.
  const room = max - fixedTail.length - 4
  if (historyBlock && head.length + historyBlock.length + 2 > room) {
    const historyRoom = Math.max(0, room - head.length - 2)
    historyBlock = historyRoom > 200 ? `…${historyBlock.slice(-historyRoom + 1)}` : ''
  }
  if (head.length > room) head = head.slice(0, Math.max(0, room)).trimEnd()
  return [head, historyBlock, fixedTail].filter((s) => s.length > 0).join('\n\n')
}

/** Chat-prompt sections that make no sense (or are harmful) for a speech-to-speech model. */
const VOICE_UNSAFE_SECTION_RE = /STAGE MARKERS|Desktop Agency|MCP|NATIVE OMNI|INTERNAL CORTEX RECALL|OUTPUT FORMAT/i

/**
 * The chat soul prompt without stage-marker / MCP / chat-format sections and without any `<|…|>` line
 * (a speech model would SAY them aloud).
 */
export function sanitizePersonaForVoice(prompt: string | null | undefined): string {
  const lines = (prompt ?? '').split(/\r?\n/)
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    const header = /^\s*\[[^\]]{3,}\]\s*$/.test(line)
    if (header) skipping = VOICE_UNSAFE_SECTION_RE.test(line)
    if (skipping) continue
    if (/<\|/.test(line)) continue
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Minimal cortex surface the cloud instructions need. */
export interface CloudContextCortex {
  compileTurnPrompt(
    params: { userMessage: string; topKMemories?: number },
    opts?: { sideEffects?: boolean },
  ): { staticSystemPrompt?: string }
  listChatMessages?(sessionId: string, limit?: number): Array<{ role: string; content: string }>
}

/** Session instructions for a cloud call: persona + name + recent shared chat + call mode (+ tools). */
export function buildCloudSessionInstructions(input: {
  cortex: CloudContextCortex | null
  sessionId: string
  settings: LiveModeSettings
  userName: string | null
  tools: boolean
}): string {
  const options = readCloudContextOptions(input.settings)
  let persona: string | null = null
  if (options.includePersona && input.cortex) {
    try {
      persona = sanitizePersonaForVoice(
        input.cortex.compileTurnPrompt({ userMessage: 'chamada de voz', topKMemories: 0 }, { sideEffects: false }).staticSystemPrompt ?? '',
      )
    } catch {
      persona = null
    }
  }
  let recent: Array<{ role: 'user' | 'assistant'; content: string }> = []
  if (options.recentMessages > 0 && input.cortex?.listChatMessages) {
    try {
      const all = input.cortex.listChatMessages(input.sessionId) ?? []
      recent = all
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .filter((m) => !m.content.startsWith('🎤 (fala não transcrita)'))
        .slice(-options.recentMessages)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    } catch {
      recent = []
    }
  }
  return buildCloudCallInstructions({ persona, userName: input.userName, recentMessages: recent, tools: input.tools, options })
}
