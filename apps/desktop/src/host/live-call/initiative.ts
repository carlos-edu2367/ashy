/**
 * Phase 10.3 — initiative in the call (plan §Escopo 4).
 *
 * The call engine asks `call:checkInitiative` after `idleNudgeSec` of silence in `listening`.
 * The host decides with the EXISTING attention engine (`cortex.evaluateAttentionInitiative`:
 * policy, DND, quiet hours, cooldown, daily cap) plus a call-only cooldown (≤ 1 initiative / 10 min),
 * and never speaks while muted, under DND, in a test call or with `features.initiativeInCall` off.
 * The call's own model phrases the line, so no extra LLM call is made here.
 */
import type {
  CallCheckInitiativeResult,
  EvaluateInitiativeInput,
  LiveModeSettings,
  ProactiveInitiativeRecord,
} from '@ashy/shared'

export const CALL_INITIATIVE_COOLDOWN_MS = 10 * 60_000
const REASON_MAX_CHARS = 240

export interface CallInitiativeDeps {
  getSettings(): LiveModeSettings
  getActiveCall(): { callId: string; test: boolean } | null
  isMuted(): boolean
  /** Agency PrivacyController DND (null = unknown → falls back to the cortex consent). */
  getDndMode(): boolean | null
  evaluate(input: EvaluateInitiativeInput): ProactiveInitiativeRecord
  getLastUserText(callId: string): string | null
  now?: () => number
  cooldownMs?: number
}

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function oneLine(raw: string | null | undefined, max: number): string {
  const text = (raw ?? '')
    .replace(/\0/g, '')
    .replace(/<\|[\s\S]*?\|>/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/**
 * Turns an initiative source into a short topic for the call model: drops "[...]" tags,
 * "Source:/Observation:/Current Mood" notice fields, speaker labels ("usuario:", "user:")
 * and a leading vocative to Ashy, and keeps only the first of " & "-joined repeats.
 */
export function cleanInitiativeTopic(raw: string | null | undefined): string {
  let text = oneLine(raw, 1000)
  text = text.replace(/\[[^\]]*\]/g, ' ')
  const obs = /Observation:\s*(.+?)(?:\s+-\s+Current Mood|$)/i.exec(text)
  if (obs?.[1]) text = obs[1]
  text = text.replace(/\s+-\s+(Source|Current Mood)[^-]*/gi, ' ')
  text = text.split(/\s+&\s+/)[0] ?? text
  text = text.replace(/^\s*(usu[aá]rio|user|carlos)\s*:\s*/i, '')
  text = text.replace(/^\s*(ashy|ashie|achi)\s*[,!:]\s*/i, '')
  text = text.replace(/\s+/g, ' ').trim()
  return oneLine(text, REASON_MAX_CHARS)
}

export function createCallInitiative(deps: CallInitiativeDeps) {
  const now = deps.now ?? (() => Date.now())
  const cooldownMs = deps.cooldownMs ?? CALL_INITIATIVE_COOLDOWN_MS
  const lastSpokenAt = new Map<string, number>()

  return {
    check(input: { callId: string; idleMs: number }): CallCheckInitiativeResult {
      const settings = deps.getSettings()
      if (!settings.features.initiativeInCall) return { speak: false, reason: 'disabled' }
      const active = deps.getActiveCall()
      if (!active || active.callId !== input.callId) return { speak: false, reason: 'not_active' }
      if (active.test) return { speak: false, reason: 'test_call' }
      if (deps.isMuted()) return { speak: false, reason: 'muted' }
      const dnd = deps.getDndMode()
      if (dnd === true) return { speak: false, reason: 'dnd' }
      const t = now()
      const last = lastSpokenAt.get(input.callId)
      if (last !== undefined && t - last < cooldownMs) return { speak: false, reason: 'call_cooldown' }

      const recent = deps.getLastUserText(input.callId)
      let record: ProactiveInitiativeRecord
      try {
        record = deps.evaluate({
          nowMs: t,
          localTimeHHMM: hhmm(new Date(t)),
          idleMinutes: Math.max(0, input.idleMs) / 60_000,
          ...(recent ? { recentUserMessage: recent.slice(0, 4000) } : {}),
          ...(dnd !== null ? { forceDnd: dnd } : {}),
        })
      } catch {
        return { speak: false, reason: 'error' }
      }
      if (record.decision !== 'spoken') return { speak: false, reason: record.decision }
      // Use the clean topic (sourceTitle), not the raw "[Proactive Notice] - Source: … usuario: …"
      // prompt: the real check (2026-11-01) showed LFM3 then addressed the user as "Ashie".
      const motivo = cleanInitiativeTopic(record.sourceTitle || record.noticePrompt)
      if (!motivo) return { speak: false, reason: 'empty' }
      lastSpokenAt.set(input.callId, t)
      while (lastSpokenAt.size > 20) {
        const oldest = lastSpokenAt.keys().next().value
        if (oldest === undefined) break
        lastSpokenAt.delete(oldest)
      }
      return {
        speak: true,
        reason: record.triggerKind,
        contextText: `[Contexto] (Iniciativa) O usuário está em silêncio. Puxe assunto de forma natural, em uma frase curta, sobre algo que ele mencionou antes: «${motivo}»`,
      }
    },
  }
}
