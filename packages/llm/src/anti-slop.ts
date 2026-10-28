export interface AssistantSlopDetection {
  hasSlop: boolean
  matches: string[]
}

/**
 * Leading RLHF corporate opener patterns in PT-BR and EN.
 * Each pattern matches a single leading cliché clause/sentence at the start of `remaining` text.
 */
const LEADING_SLOP_PATTERNS: readonly RegExp[] = [
  // PT-BR: "Claro! Ficarei feliz em ajudar.", "Com certeza, fico feliz em ajudar!", "Certamente! Posso ajudar com isso."
  /^(?:claro|com certeza|certamente|sem dúvida)[!,.]\s*(?:(?:ficarei|fico)\s+(?:muito\s+)?feliz\s+em\s+(?:poder\s+)?(?:te\s+)?ajudar[^.!:\n]*[.!:]?|posso\s+(?:te\s+)?ajudar(?:\s+com\s+isso)?[.!:]?|aqui\s+est(?:á|ão)\s*[:.!]|vamos\s+lá\s*[:.!])/i,

  // PT-BR standalone formal/corporate exclamation openers: "Certamente!", "Sem dúvida!", or "Claro!" / "Com certeza!" when followed by another slop clause
  /^(?:certamente|sem dúvida|entendido)\s*!\s*/i,
  /^(?:claro|com certeza)\s*!\s*(?=(?:que\s+)?(?:ótima|excelente|boa|interessante)\s+pergunta|como\s+(?:uma?\s+)?(?:inteligência\s+artificial|ia\b|modelo\s+de\s+linguagem)|(?:ficarei|fico)\s+feliz|aqui\s+est(?:á|ão)|vamos\s+lá)/i,

  // PT-BR: "Ficarei feliz em ajudar.", "Fico muito feliz em ajudar com isso!"
  /^(?:(?:ficarei|fico)\s+(?:muito\s+)?feliz\s+em\s+(?:poder\s+)?(?:te\s+)?ajudar[^.!:\n]*[.!:]|estou\s+aqui\s+para\s+(?:te\s+)?ajudar[^.!:\n]*[.!:])\s*/i,

  // PT-BR: "Ótima pergunta!", "Excelente pergunta!", "Boa pergunta!", "Que ótima pergunta!"
  /^(?:que\s+)?(?:ótima|excelente|boa|interessante)\s+pergunta\s*[.!:]\s*/i,

  // PT-BR: "Como uma inteligência artificial...", "Como uma IA...", "Como um modelo de linguagem..."
  /^como\s+(?:uma?\s+)?(?:inteligência\s+artificial|ia\b|modelo\s+de\s+linguagem|assistente\s+virtual)[^.!:\n]*[.!:,]\s*/i,

  // PT-BR: "Aqui está:", "Aqui estão:", "Vamos lá:"
  /^(?:aqui\s+est(?:á|ão)(?:\s+o\s+que\s+você\s+pediu)?|vamos\s+lá)\s*:\s*/i,

  // EN: "Sure! I'd be happy to help.", "Certainly! Here is:", "Of course, I can help with that."
  /^(?:sure(?:\s+thing)?|certainly|of\s+course|absolutely)[!,.]\s*(?:i(?:'d|\s+would)\s+be\s+(?:happy|glad|delighted)\s+to\s+help[^.!:\n]*[.!:]?|i\s+can\s+help(?:\s+you)?(?:\s+with\s+that)?[.!:]?|here(?:'s|\s+is)[^.!:\n]*[:.!]|let's\s+(?:dive\s+in|get\s+started)\s*[:.!])/i,

  // EN standalone formal exclamation openers: "Certainly!", "Absolutely!", or "Sure!" / "Of course!" when followed by another slop clause
  /^(?:certainly|absolutely)\s*!\s*/i,
  /^(?:sure(?:\s+thing)?|of\s+course)\s*!\s*(?=(?:that(?:'s|\s+is)\s+a\s+)?(?:great|excellent|good|wonderful)\s+question|as\s+an?\s+(?:ai\b|artificial\s+intelligence|large\s+language\s+model)|(?:i(?:'d|\s+would)\s+be\s+)?(?:happy|glad|delighted)\s+to\s+help|here(?:'s|\s+is)|let's\s+(?:dive\s+in|get\s+started))/i,

  // EN: "I'd be happy to help.", "Happy to help!"
  /^(?:(?:i(?:'d|\s+would)\s+be\s+)?(?:happy|glad|delighted)\s+to\s+help[^.!:\n]*[.!:])\s*/i,

  // EN: "Great question!", "That's a great question!", "Excellent question!"
  /^(?:that(?:'s|\s+is)\s+a\s+)?(?:great|excellent|good|wonderful)\s+question\s*[.!:]\s*/i,

  // EN: "As an AI...", "As a large language model...", "As an artificial intelligence..."
  /^as\s+an?\s+(?:ai\b|artificial\s+intelligence|large\s+language\s+model|language\s+model|helpful\s+assistant|virtual\s+assistant)[^.!:\n]*[.!:,]\s*/i,

  // EN: "Here is:", "Here's what you need:", "Let's dive in:"
  /^(?:here(?:'s|\s+is)(?:\s+what\s+you\s+(?:asked\s+for|need))?|let's\s+(?:dive\s+in|get\s+started))\s*:\s*/i,
]

/**
 * Detects whether a response starts with corporate RLHF assistant clichés in PT-BR or EN.
 */
export function detectAssistantSlop(text: string): AssistantSlopDetection {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { hasSlop: false, matches: [] }
  }

  let remaining = text.trimStart()
  const matches: string[] = []

  let matchedInPass = true
  while (matchedInPass && remaining.length > 0) {
    matchedInPass = false
    for (const pattern of LEADING_SLOP_PATTERNS) {
      const m = pattern.exec(remaining)
      if (m && m[0].length > 0) {
        matches.push(m[0].trim())
        remaining = remaining.slice(m[0].length).trimStart()
        matchedInPass = true
        break
      }
    }
  }

  return {
    hasSlop: matches.length > 0,
    matches,
  }
}

/**
 * Strips leading corporate RLHF clichés from the beginning of a response while preserving
 * authentic casual sentences and natural language.
 */
export function stripLeadingAssistantSlop(text: string): string {
  if (typeof text !== 'string' || text.length === 0) {
    return ''
  }

  let remaining = text.trimStart()
  let matchedInPass = true

  while (matchedInPass && remaining.length > 0) {
    matchedInPass = false
    for (const pattern of LEADING_SLOP_PATTERNS) {
      const m = pattern.exec(remaining)
      if (m && m[0].length > 0) {
        remaining = remaining.slice(m[0].length).trimStart()
        matchedInPass = true
        break
      }
    }
  }

  return remaining
}
