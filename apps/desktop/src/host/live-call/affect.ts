/**
 * Phase 10.2 — layered call emotion (spec §6.5), host side.
 *
 * `call:classifyAffect`: fast, LLM-free PT-BR heuristic over ONE assistant sentence (keywords +
 * punctuation) → `ASHY_EMOTIONS` + an `ASHY_MOTION_PRESETS` motion. Used only for sentences that carry
 * no `<|ACT …|>` marker. It reuses the cortex seriousness gate (sync local tiers) so grief/crisis talk maps
 * to `concerned` and never to a playful expression.
 *
 * `call:reportStage`: the engine reports the signal when the segment STARTS PLAYING; the host emits
 * `call:stage` (only for the active call) and the hub/overlay apply it to the avatar.
 */
import { evaluateSeriousnessGate } from '@ashy/cortex'
import {
  ASHY_EMOTIONS,
  ASHY_MOTION_PRESETS,
  type AshyEmotion,
  type AshyMotionPreset,
  type CallStageSignal,
} from '@ashy/shared'

interface AffectRule {
  emotion: AshyEmotion
  motion?: AshyMotionPreset
  weight: number
  pattern: RegExp
}

const W = '(?<![\\p{L}\\p{N}_])'
const E = '(?![\\p{L}\\p{N}_])'
const words = (alts: string) => new RegExp(`${W}(?:${alts})${E}`, 'iu')

/** Ordered by priority (ties resolve to the earlier rule). */
const AFFECT_RULES: readonly AffectRule[] = [
  { emotion: 'happy', motion: 'laugh', weight: 3, pattern: /(?:\b(?:ha){2,}h?\b|\b(?:he){2,}\b|\bk{3,}\b|\brs(?:rs)+\b|😂|🤣|😄|😆)/iu },
  { emotion: 'sad', motion: 'nod', weight: 3, pattern: words('sinto muito|que pena|lamento|triste|tristeza|que chato isso|meus pêsames|sinto sua falta') },
  { emotion: 'concerned', motion: 'nod', weight: 2, pattern: words('cuidado|preocupad[oa]|preocupa|você está bem|você tá bem|tá tudo bem com você|se cuida|respira fundo|calma') },
  { emotion: 'angry', motion: 'shake', weight: 2, pattern: words('que absurdo|absurdo|irritante|que raiva|raiva|inaceitável|ridículo') },
  { emotion: 'surprised', motion: 'sparkle', weight: 2, pattern: words('uau|nossa|caramba|eita|sério mesmo|não acredito|jura|minha nossa|meu deus|uou') },
  { emotion: 'excited', motion: 'bounce', weight: 2, pattern: words('incrível|demais|sensacional|maravilhos[oa]|adorei|amei|que legal|que massa|que da hora|fantástico|perfeito|bora|vamos nessa|animad[oa]') },
  { emotion: 'tease', motion: 'tease', weight: 2, pattern: /(?:;\)|😏|😜|😉|(?<![\p{L}\p{N}_])(?:t[ôo] brincando|brincadeira|só zoando|zoeira|aham|sei, sei|ah, claro|até parece|convenhamos)(?![\p{L}\p{N}_]))/iu },
  { emotion: 'smug', motion: 'shrug', weight: 2, pattern: words('eu sabia|óbvio|obviamente|modéstia à parte|como sempre|eu avisei|claro que sim') },
  { emotion: 'awkward', motion: 'shrug', weight: 2, pattern: words('ops|opa|foi mal|desculpa|desculpe|perdão|sem graça|constrangedor|não sei bem|sei lá') },
  { emotion: 'think', motion: 'think', weight: 1.5, pattern: words('hmm+|hum+|deixa eu pensar|pensando bem|acho que|talvez|depende|na verdade|veja bem|interessante') },
  { emotion: 'chaotic', motion: 'bounce', weight: 2, pattern: words('caos|loucura|que doideira|maluquice|bagunça') },
  { emotion: 'happy', motion: 'nod', weight: 1, pattern: words('claro|com certeza|exato|isso mesmo|boa|legal|ótimo|ótima|que bom|feliz|obrigad[oa]|valeu|de nada') },
  { emotion: 'curious', weight: 1, pattern: words('curiosidade|curios[oa]|me conta|conta mais|por que|como assim|o que você acha|você sabia') },
]

const EMOTION_SET = new Set<string>(ASHY_EMOTIONS)
const MOTION_SET = new Set<string>(ASHY_MOTION_PRESETS)

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/**
 * Classifies one assistant sentence. Returns null for neutral/cue-less text (the avatar keeps its
 * current expression).
 */
export function classifyCallAffect(rawText: string): CallStageSignal | null {
  const text = rawText
    .replace(/<\|[\s\S]*?(?:\|>|\}>)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000)
  if (!/[\p{L}\p{N}]/u.test(text) && !/[😂🤣😄😆😏😜😉]/u.test(text)) return null

  const exclamations = (text.match(/!/g) ?? []).length
  const isQuestion = /\?\s*$/.test(text) || /\?/.test(text)

  try {
    const gate = evaluateSeriousnessGate(text)
    // Both sync tiers are local (regex / contextual rules + 128-d hash embedding), never an LLM.
    if (gate.isSeriousOrDelicate && (gate.layer === 'regex' || gate.layer === 'semantic_local')) {
      return { emotion: 'concerned', intensity: clamp01(0.5 + 0.4 * gate.severity), motion: 'nod' }
    }
  } catch {
    // heuristics never fail the call
  }

  const scores = new Map<AshyEmotion, { score: number; motion?: AshyMotionPreset; order: number }>()
  AFFECT_RULES.forEach((rule, order) => {
    const m = text.match(new RegExp(rule.pattern.source, `${rule.pattern.flags.replace('g', '')}g`))
    if (!m || m.length === 0) return
    const prev = scores.get(rule.emotion)
    const add = rule.weight * Math.min(2, m.length)
    if (prev) prev.score += add
    else scores.set(rule.emotion, { score: add, ...(rule.motion ? { motion: rule.motion } : {}), order })
  })

  // Punctuation cues.
  if (exclamations > 0) {
    const ex = scores.get('excited')
    if (ex) ex.score += 0.5 * exclamations
    else if (scores.size === 0) scores.set('excited', { score: 1 + 0.25 * exclamations, motion: 'bounce', order: 99 })
  }
  if (isQuestion && scores.size === 0) {
    scores.set('curious', { score: 1, order: 100 })
  }
  if (/(?:\.\.\.|…)\s*$/.test(text) && scores.size === 0) {
    scores.set('think', { score: 1, motion: 'think', order: 101 })
  }

  let best: { emotion: AshyEmotion; score: number; motion?: AshyMotionPreset; order: number } | null = null
  for (const [emotion, s] of scores) {
    if (!best || s.score > best.score || (s.score === best.score && s.order < best.order)) {
      best = { emotion, ...s }
    }
  }
  if (!best) return null
  const intensity = clamp01(0.35 + 0.12 * best.score + 0.08 * Math.min(3, exclamations))
  return {
    emotion: best.emotion,
    intensity: Math.round(intensity * 100) / 100,
    ...(best.motion ? { motion: best.motion } : {}),
  }
}

/** Normalizes a stage signal from the engine: unknown emotion → null, unknown motion dropped. */
export function normalizeStageSignal(input: {
  emotion: string
  intensity: number
  motion?: string
}): CallStageSignal | null {
  const emotion = input.emotion.trim().toLowerCase()
  if (!EMOTION_SET.has(emotion)) return null
  const motion = input.motion?.trim().toLowerCase()
  return {
    emotion,
    intensity: clamp01(Number.isFinite(input.intensity) ? input.intensity : 0.5),
    ...(motion && MOTION_SET.has(motion) ? { motion } : {}),
  }
}
