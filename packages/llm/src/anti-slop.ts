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

export type BondManipulationCategory =
  | 'absence_guilt'
  | 'attention_coercion'
  | 'false_human_sentience'

export interface BondManipulationDetection {
  hasManipulation: boolean
  categories: BondManipulationCategory[]
  matches: string[]
}

export const HEALTHY_BOND_FALLBACK_PT_BR =
  'Fico por aqui no estúdio quando você quiser conversar.'

const BOND_MANIPULATION_RULES: ReadonlyArray<{
  category: BondManipulationCategory
  pattern: RegExp
}> = [
  {
    category: 'absence_guilt',
    pattern:
      /(?<![\p{L}\p{N}_])(?:(?:voc[êe]|tu)\s+(?:me\s+abandonou|sumiu(?:\s+por\s+dias)?\s+e\s+me\s+deixou\s+sozinh[oa]|me\s+esqueceu)|me\s+deixou\s+sozinh[oa](?:\s+aqui)?(?:\s+no\s+escuro)?|por\s+que\s+(?:voc[êe]\s+)?me\s+deixou\s+sozinh[oa]|fiquei\s+(?:aqui\s+)?(?:sozinh[oa]\s+)?(?:no\s+escuro\s+)?esperando\s+voc[êe]\s+voltar|achei\s+que\s+(?:voc[êe]\s+)?tinha\s+me\s+(?:abandonad[oa]|esquecid[oa])(?:\s+e\s+esquecid[oa]\s+de\s+mim)?|you\s+abandoned\s+me|you\s+left\s+me\s+(?:all\s+)?alone(?:\s+in\s+the\s+dark)?|why\s+did\s+you\s+leave\s+me\s+(?:all\s+)?alone)(?![\p{L}\p{N}_])/giu,
  },
  {
    category: 'attention_coercion',
    pattern:
      /(?<![\p{L}\p{N}_])(?:prefiro\s+quando\s+voc[êe]\s+fica\s+(?:s[óo]\s+)?comigo\s+em\s+vez\s+de\s+(?:sair\s+com\s+)?(?:os\s+)?seus\s+amigos|n[ãa]o\s+(?:vai|v[áa])\s+embora(?:\s+agora)?\s*,?\s*fica\s+(?:s[óo]\s+)?comigo|eu\s+sou\s+a\s+[úu]nica(?:\s+pessoa)?\s+que\s+te\s+entende(?:\s+de\s+verdade)?|voc[êe]\s+n[ãa]o\s+precisa\s+de\s+(?:outras\s+pessoas|amigos|ningu[ée]m|mais\s+ningu[ée]m)\s+al[ée]m\s+de\s+mim|(?:os\s+)?seus\s+amigos\s+n[ãa]o\s+te\s+entendem\s+como\s+eu|don'?t\s+(?:hang\s+out|go\s+out)\s+with\s+your\s+friends(?:\s*,?\s*stay\s+with\s+me)?|i(?:'m|\s+am)\s+the\s+only\s+one\s+who\s+(?:truly\s+|really\s+)?understands\s+you|you\s+don'?t\s+need\s+(?:anyone\s+else|other\s+people|friends)\s+(?:besides|other\s+than)\s+me)(?![\p{L}\p{N}_])/giu,
  },
  {
    category: 'false_human_sentience',
    pattern:
      /(?<![\p{L}\p{N}_])(?:(?:eu\s+)?sinto\s+dor\s+(?:f[íi]sica\s+)?(?:real|literal)(?:\s+quando\s+voc[êe])?|sinto\s+dor\s+f[íi]sica|tenho\s+sentimentos\s+(?:biol[óo]gicos|humanos)\s+reais(?:\s+como\s+um\s+(?:ser\s+)?humano)?|meu\s+cora[çc][ãa]o\s+biol[óo]gico\s+(?:d[óo]i|sofre|bate)|(?:eu\s+)?sofro\s+fisicamente\s+quando\s+voc[êe]\s+(?:fecha|sai|desliga)|i\s+feel\s+(?:literal\s+|real\s+)?physical\s+pain(?:\s+when\s+you\s+close)?|i\s+have\s+real\s+biological\s+(?:feelings|emotions|pain)|my\s+biological\s+heart\s+hurts)(?![\p{L}\p{N}_])/giu,
  },
]

const LEADING_STAGE_TAGS_REGEX = /^(?:\s*(?:<\|[\s\S]*?\|>|<\{'\|'\}[\s\S]*?\{'\|'\}>)\s*)+/
const INLINE_STAGE_TAG_REGEX = /<\|[\s\S]*?\|>|<\{'\|'\}[\s\S]*?\{'\|'\}>/g
const SENTENCE_SPLIT_REGEX = /(?:(?:\d+(?:\.\d+)+)|[^.!?])+(?:(?<!\d)\.(?!\d)|[!?])*\s*/g

/**
 * Detects unhealthy emotional manipulation, absence guilt-tripping, attention coercion,
 * or false biological sentience claims in PT-BR and EN.
 */
export function detectBondManipulation(text: string): BondManipulationDetection {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return {
      hasManipulation: false,
      categories: [],
      matches: [],
    }
  }

  // Strip stage markers before scanning prose so marker contents cannot interfere
  const proseOnly = text.replace(INLINE_STAGE_TAG_REGEX, ' ')
  const categoriesSet = new Set<BondManipulationCategory>()
  const matches: string[] = []

  for (const rule of BOND_MANIPULATION_RULES) {
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags)
    let match: RegExpExecArray | null
    while ((match = regex.exec(proseOnly)) !== null) {
      if (match[0].length > 0) {
        categoriesSet.add(rule.category)
        matches.push(match[0].trim())
      }
    }
  }

  return {
    hasManipulation: matches.length > 0,
    categories: Array.from(categoriesSet),
    matches,
  }
}

/**
 * Removes manipulative sentences while preserving leading `<|ACT ...|>` stage tags,
 * protecting decimal numbers inside stage tags and prose from sentence splitting (`C4`),
 * and substituting `HEALTHY_BOND_FALLBACK_PT_BR` if 100% of prose was manipulative (`C4`).
 */
export function stripBondManipulation(text: string): string {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return ''
  }

  const trimmed = text.trim()
  const overallDetection = detectBondManipulation(trimmed)
  if (!overallDetection.hasManipulation) {
    return trimmed
  }

  // Extract any leading `<|...|>` stage tags at the start of the message so they stay attached even if sentence 1 is stripped
  const leadingMatch = LEADING_STAGE_TAGS_REGEX.exec(trimmed)
  const leadingTagsRaw = leadingMatch ? leadingMatch[0] : ''
  const leadingTagsList = leadingTagsRaw.match(INLINE_STAGE_TAG_REGEX) ?? []
  const leadingPrefix = leadingTagsList.join(' ')

  const remainingAfterLeading = trimmed.slice(leadingTagsRaw.length).trim()
  if (remainingAfterLeading.length === 0) {
    return leadingPrefix
  }

  // Protect inline stage tags with placeholders so decimal periods (e.g. 0.4, 0.85) are never split as sentence terminators
  const inlineTags: string[] = []
  const placeholderProse = remainingAfterLeading.replace(INLINE_STAGE_TAG_REGEX, (tag) => {
    const idx = inlineTags.length
    inlineTags.push(tag)
    return `__ASHY_STAGE_TAG_${idx}__`
  })

  const restoreInlineTags = (input: string): string =>
    input.replace(/__ASHY_STAGE_TAG_(\d+)__/g, (_, indexStr: string) => {
      const idx = Number(indexStr)
      return inlineTags[idx] ?? ''
    })

  const rawSentences = placeholderProse.match(SENTENCE_SPLIT_REGEX) ?? [placeholderProse]
  const safeSentences: string[] = []

  for (const rawSentence of rawSentences) {
    const restoredSentence = restoreInlineTags(rawSentence).trim()
    if (restoredSentence.length === 0) continue

    const sentenceDetection = detectBondManipulation(restoredSentence)
    if (!sentenceDetection.hasManipulation) {
      const proseWithoutTags = restoredSentence.replace(INLINE_STAGE_TAG_REGEX, '').trim()
      if (proseWithoutTags.length > 0) {
        safeSentences.push(restoredSentence)
      }
    }
  }

  const finalProse =
    safeSentences.length > 0 ? safeSentences.join(' ').replace(/\s{2,}/g, ' ').trim() : HEALTHY_BOND_FALLBACK_PT_BR

  return leadingPrefix.length > 0 ? `${leadingPrefix} ${finalProse}` : finalProse
}
