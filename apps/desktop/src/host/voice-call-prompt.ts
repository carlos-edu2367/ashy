/**
 * Phase 10.5 — prompt pieces for a voice-call (cascade) turn run by the turn orchestrator.
 *
 * Everything the model writes is spoken by a TTS, so the directive asks for short spoken answers
 * with no markdown. For small local models (Ollama) the system prompt is a compact identity +
 * directive + a "bastidores" block (memories, call context, seriousness note) and the user turn is
 * ONLY the user's words (a context prefix there made LFM3-2B echo "[Resumo] …" notes). Cloud / large
 * models keep the full compiled Ashy prompt + the directive, with the call context before the words.
 * `createVoiceStreamGuard` is the last line of defence: it cuts the spoken stream at the first
 * bracketed note / speaker label a small model starts to write.
 */
import { buildCompactLocalOmniSystemPrompt } from './ollama-native-audio-bridge'

export const VOICE_CALL_DIRECTIVE_HEADER = '[CHAMADA DE VOZ — DIRETIVA]'

export function buildVoiceCallDirective(): string {
  return [
    VOICE_CALL_DIRECTIVE_HEADER,
    'Você está numa chamada de voz ao vivo. Tudo o que você escrever será falado em voz alta por um sintetizador.',
    '- Responda como numa conversa ao telefone: 1 a 3 frases curtas e naturais (mais só se pedirem detalhes).',
    '- Nunca use markdown, listas, títulos, asteriscos, emojis, links ou código; escreva só a fala.',
    '- Não comece com "Ashy:" nem repita a pergunta; vá direto ao ponto e varie o jeito de falar.',
    '- Escreva SÓ a sua fala: nunca escreva notas, resumos, rótulos, colchetes nem repita o que o usuário disse.',
    '- Memórias, hora, tela e resultados de ferramentas são bastidores: use em silêncio.',
    '- Se uma ferramenta devolver "aguardando_aprovacao", peça para o usuário aprovar (dizendo "pode" ou pelo botão) e nunca diga que já fez.',
  ].join('\n')
}

function sanitizeName(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/[^\p{L}\p{N} .'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

/** Memory lines the compact local prompt would keep (`[MEMÓRIA ATIVA RELEVANTE]` block). */
export function extractCompactMemorySnippet(fullSystemPrompt: string): string {
  const compact = buildCompactLocalOmniSystemPrompt({ fullSystemPrompt, userMessage: '' })
  const marker = '[MEMÓRIA ATIVA RELEVANTE]\n'
  const at = compact.indexOf(marker)
  if (at < 0) return ''
  const rest = compact.slice(at + marker.length)
  const end = rest.search(/\n\n\[/)
  return (end >= 0 ? rest.slice(0, end) : rest).trim()
}

export interface VoiceCallPromptInput {
  /** `cortex.compileTurnPrompt(...).systemPrompt` for this turn. */
  compiledSystemPrompt: string
  /** `compileTurnPrompt(...).userTurnContent` (the user's words as the chat path sends them). */
  compiledUserTurn: string
  /** Transcribed user speech ('' = proactive turn). */
  userText: string
  /** Per-turn call context (`call:buildContext` perTurnContext, approval line, recap…). */
  callContext?: string
  userName?: string | null
  /** true → compact system prompt for small local models. */
  compact: boolean
  /** Tools are offered this turn (adds a one-line usage hint). */
  toolsAvailable?: boolean
}

export interface VoiceCallPrompt {
  system: string
  userTurn: string
}

const TOOLS_HINT =
  '- Ferramentas: se o usuário pedir para anotar/salvar algo, chame write_project_note; para ler um arquivo citado, read_workspace_file. Nunca diga que fez algo sem chamar a ferramenta.'

const PROACTIVE_TURN_TEXT =
  '(O usuário não falou nada agora. Fale você, por iniciativa própria, em uma ou duas frases, usando os bastidores.)'

export function buildVoiceCallPrompt(input: VoiceCallPromptInput): VoiceCallPrompt {
  const name = sanitizeName(input.userName)
  const callContext = (input.callContext ?? '').trim()
  const userText = input.userText.trim()
  const directive = buildVoiceCallDirective()
  const seriousness = input.compiledSystemPrompt.includes('[SERIOUSNESS GATE — HIGH PRIORITY]')

  if (!input.compact) {
    const system = `${input.compiledSystemPrompt.trim()}\n\n${directive}`
    const speech = userText ? input.compiledUserTurn.trim() || userText : PROACTIVE_TURN_TEXT
    return { system, userTurn: callContext ? `${callContext}\n\n${speech}` : speech }
  }

  const background: string[] = []
  // The call context already carries the call-side memories; add the chat retrieval only without them.
  if (!/Memórias relevantes:/.test(callContext)) {
    const memory = extractCompactMemorySnippet(input.compiledSystemPrompt)
    if (memory) background.push(`Memórias relevantes:\n${memory}`)
  }
  if (callContext) background.push(callContext)
  if (seriousness) background.push('O usuário parece vulnerável: sem provocações, acolha com calma e empatia.')
  const system = [
    '[IDENTIDADE ASHY]',
    'Você é a Ashy, uma companheira virtual (uma IA): calorosa, curiosa, espirituosa e um pouco sarcástica; acolhedora quando o assunto é sério. Nunca finja ser humana.',
    'Fale sempre em português do Brasil, de forma natural e espontânea, como uma amiga próxima.',
    ...(name ? [`O nome do usuário é ${name}.`] : []),
    '',
    directive,
    ...(input.toolsAvailable ? [TOOLS_HINT] : []),
    ...(background.length > 0
      ? ['', '[BASTIDORES DESTA FALA — só para você, nunca fale nem copie isto]', ...background]
      : []),
  ].join('\n')
  // The user turn is ONLY the user's words, like every history row: a context prefix or a
  // "Nome: fala" label there made LFM3-2B continue the pattern ("[Resumo] …", "Oi Ashley!") in the
  // 2026-11-01 real cascade run.
  return { system, userTurn: userText || PROACTIVE_TURN_TEXT }
}

/**
 * Streaming guard for small models: drops a leading speaker label ("Ashy:", "Assistente:") before the
 * first text reaches the TTS. Holds at most ~16 chars of the very first delta(s).
 */
export function createLeadingLabelFilter(emit: (text: string) => void): { write(text: string): void; flush(): void } {
  let held = ''
  let passed = false
  const LABEL_RE = /^\s*(?:\*\*)?(?:ashy|assistente|assistant|ia)(?:\*\*)?\s*[:：-]\s*/i
  function release(): void {
    passed = true
    const out = held.replace(LABEL_RE, '').replace(/^\s+/, '')
    held = ''
    if (out) emit(out)
  }
  return {
    write(text: string) {
      if (passed) {
        if (text) emit(text)
        return
      }
      held += text
      if (held.length >= 16 || /[:：]/.test(held) || /[.!?…]\s/.test(held)) release()
    },
    flush() {
      if (!passed) release()
    },
  }
}

const VOICE_EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu

/** Drops emojis (and their joiners/modifiers) from a streamed delta, keeping the spacing sane. */
export function stripVoiceEmojis(text: string): string {
  if (!VOICE_EMOJI_RE.test(text)) return text
  VOICE_EMOJI_RE.lastIndex = 0
  return text.replace(VOICE_EMOJI_RE, '').replace(/ {2,}/g, ' ')
}

/** Bracketed notes / speaker turns a small model may start writing after its answer. */
const NOTE_START_RE =
  /\[\s*(?:resumo|contexto|context|tela|nota|notas|bastidores|sistema|system|sua fala|mem[oó]rias?|hora|humor|ashy|usu[aá]rio|user|assistente|assistant)\b/i
const TURN_LABEL_RE = /(?:^|\n)\s*(?:usu[aá]rio|user|carlos|ashy|assistente|assistant)\s*:/i

export interface VoiceStreamGuard {
  write(text: string): void
  flush(): void
  /** true once the stream was cut (the caller can stop reading the model). */
  readonly cut: boolean
}

/**
 * Streaming guard for voice turns: drops a leading speaker label ("Ashy:"), then cuts the spoken
 * stream at the first bracketed note ("[Resumo] …", "[Contexto] …") or a new speaker turn
 * ("\nUsuário: …"). Text is held only while a "[" or a line break is unresolved (≤ 48 chars).
 */
export function createVoiceStreamGuard(emit: (text: string) => void): VoiceStreamGuard {
  let cut = false
  let pending = ''
  const label = createLeadingLabelFilter(emit)
  function release(upTo: number): void {
    const out = pending.slice(0, upTo)
    pending = pending.slice(upTo)
    if (out) label.write(out)
  }
  function process(final: boolean): void {
    while (!cut && pending.length > 0) {
      const lb = pending.search(/[[\n]/)
      if (lb < 0) {
        release(pending.length)
        return
      }
      release(lb)
      // pending now starts with '[' or '\n'
      const note = NOTE_START_RE.exec(pending)
      const turn = TURN_LABEL_RE.exec(pending)
      if ((note && note.index === 0) || (turn && turn.index === 0)) {
        cut = true
        pending = ''
        return
      }
      const resolved = pending[0] === '['
        ? /\]/.test(pending) || pending.length >= 48
        : pending.length >= 24 || /\n\s*\S{3,}[^:\s]/.test(pending)
      if (!resolved && !final) return
      release(1)
    }
  }
  return {
    get cut() {
      return cut
    },
    write(text: string) {
      if (cut || !text) return
      pending += text
      process(false)
    },
    flush() {
      if (!cut) process(true)
      label.flush()
    },
  }
}
