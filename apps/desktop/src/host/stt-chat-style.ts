/**
 * Chat-style answers an omni model (LFM3-Omni) sometimes returns instead of a transcript. Shared by
 * the Ollama STT path (kernel) and the live-call llama-server STT route (live-call/llama-stt.ts).
 */
const CHAT_STYLE_NON_TRANSCRIPT_PATTERNS: readonly RegExp[] = [
  /^a unica palavra\b/,
  /^o audio\s+(fornecido|enviado|recebido|anexado|contem|nao contem|parece|que voce|esta vazio|e silencioso|consiste)\b/,
  /^nao ha\s+(nenhuma?\s+)?(fala|falas|audio|voz|palavra|palavras|conteudo|som|transcricao)\b/,
  /^desculpe[,!.]?\s+(mas\s+)?(eu\s+)?nao\s+(consigo|posso|foi possivel|entendi o audio|ha)\b/,
  /^desculpe[,!.]?\s+(mas\s+)?(como|sou)\s+(um|uma)\s+(modelo|assistente|ia)\b/,
  /^(como|sou)\s+(um|uma)\s+(modelo|assistente)\s+de\s+(linguagem|ia)\b/,
  /^(the audio|there is no|i'?m sorry|sorry, i)\b/,
]

/**
 * Detects chat-style answers that an omni model sometimes returns instead of a
 * transcript ("O áudio contém...", "A única palavra é...", "Não há fala...").
 */
export function isChatStyleNonTranscript(rawText: string): boolean {
  const normalized = rawText
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^[\s"'“”‘’«»*_-]+/, '')
    .toLowerCase()
  return CHAT_STYLE_NON_TRANSCRIPT_PATTERNS.some((pattern) => pattern.test(normalized))
}
