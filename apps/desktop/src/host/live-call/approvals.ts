/**
 * Phase 10.3 — approvals (plan §Escopo 2).
 *
 * - The agency runtime pushes `agency:pending` / `agency:resolved` for EVERY pending action
 *   (chat or call) through an `AgencyEventBridge` (cards used to reach the UI only via snapshot).
 * - `agency:approve` / `agency:deny` reuse `approvePendingAction` / `denyPendingAction`; when the
 *   card was staged by the ACTIVE call, the host then emits `call:command inject {reason:'approval'}`
 *   so Ashy speaks about the result.
 * - Voice approval is a DETERMINISTIC phrase match done host-side (the model never approves and
 *   has no approval tool), only for `voiceApprovable` cards staged by this same call — never for
 *   cards with a blast-radius warning.
 */
import type { PendingActionCard } from '@ashy/agency'
import type { AgencyPendingCardView, LiveCallHostEvent } from '@ashy/shared'
import type { HostAgencyRuntime } from '../agency-runtime'
import { describePendingActionPt, leanToolOutput } from './tools'

export type AgencyHostEvent = Extract<LiveCallHostEvent, { type: 'agency:pending' | 'agency:resolved' }>

/** Lets the (lazily built) agency runtime push events and be reached by the Live Call host. */
export interface AgencyEventBridge {
  attachRuntime(runtime: HostAgencyRuntime): void
  getRuntime(): HostAgencyRuntime | null
  emit(event: AgencyHostEvent): void
}

export function createAgencyEventBridge(emit: (event: LiveCallHostEvent) => void): AgencyEventBridge {
  let runtime: HostAgencyRuntime | null = null
  return {
    attachRuntime(next) {
      runtime = next
    },
    getRuntime() {
      return runtime
    },
    emit(event) {
      emit(event)
    },
  }
}

export function isVoiceApprovable(card: Pick<PendingActionCard, 'riskTier' | 'blastRadiusWarning'>): boolean {
  return !card.blastRadiusWarning && card.riskTier === 'staged-confirm'
}

function capitalize(text: string): string {
  return text.length > 0 ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text
}

export function buildAgencyPendingCardView(card: PendingActionCard, callId?: string): AgencyPendingCardView {
  return {
    id: card.id,
    toolName: card.toolName,
    summary: capitalize(describePendingActionPt(card)),
    argsPreview: card.argsPreview,
    riskTier: card.riskTier,
    ...(card.blastRadiusWarning ? { blastRadiusWarning: card.blastRadiusWarning } : {}),
    voiceApprovable: isVoiceApprovable(card),
    ...(callId ? { callId } : {}),
    createdAt: card.createdAt,
  }
}

// ───────────────────────────── deterministic voice phrases ─────────────────────────────

export const VOICE_APPROVE_PHRASES = [
  'pode',
  'pode fazer',
  'sim pode',
  'aprovado',
  'autorizo',
  'pode sim',
  'manda ver',
] as const
/** "Always allow" by voice (same restrictions as a normal voice approval). */
export const VOICE_ALWAYS_PHRASES = ['pode sempre', 'sempre pode', 'sempre permitir'] as const
export const VOICE_DENY_PHRASES = ['nao', 'cancela', 'nao pode', 'deixa', 'negado'] as const

export type VoiceApprovalDecision = 'approve' | 'always' | 'deny'

/** Lowercase, no accents/punctuation; drops a leading/trailing "ashy" and a trailing "por favor". */
export function normalizeVoicePhrase(text: string): string {
  let t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  t = t.replace(/^ashy\s+/, '').replace(/\s+ashy$/, '').replace(/\s+por favor$/, '').trim()
  // Phase 10.5: common STT spellings of "pode" (LFM3 ASR wrote "Podi sim, por favor." in the real run).
  t = t.replace(/\bpod[iy]\b/g, 'pode')
  return t
}

const APPROVE_SET = new Set<string>(VOICE_APPROVE_PHRASES)
const ALWAYS_SET = new Set<string>(VOICE_ALWAYS_PHRASES)
const DENY_SET = new Set<string>(VOICE_DENY_PHRASES)

/** Whole-utterance match only: "pode" approves, "pode me contar uma piada" does not. */
export function classifyVoiceApproval(text: string): VoiceApprovalDecision | null {
  const t = normalizeVoicePhrase(text)
  if (!t) return null
  if (ALWAYS_SET.has(t)) return 'always'
  if (APPROVE_SET.has(t)) return 'approve'
  if (DENY_SET.has(t)) return 'deny'
  return null
}

// ───────────────────────────── approvals service ─────────────────────────────

export type ApprovalsRuntime = Pick<
  HostAgencyRuntime,
  'approvePendingAction' | 'denyPendingAction' | 'getCardOrigin' | 'listPendingCards'
>

export interface CallApprovalsDeps {
  getRuntime(): ApprovalsRuntime | null
  /** callId of the call in progress (null when none). */
  getActiveCallId(): string | null
  inject(callId: string, contextText: string): void
}

export interface ResolveCardResult {
  status: 'approved' | 'denied' | 'failed'
  cardId: string
  output?: string
  /** true when a `call:command inject` was emitted for the active call. */
  injected: boolean
}

export interface VoiceApprovalOutcome {
  handled: boolean
  decision?: VoiceApprovalDecision
  /** Per-turn context line (PT) describing what happened. */
  contextLine?: string
}

const CONTEXT_OUTPUT_MAX_CHARS = 300

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200)
}

function requireRuntime(deps: CallApprovalsDeps): ApprovalsRuntime {
  const runtime = deps.getRuntime()
  if (!runtime) throw new Error('AGENCY_UNAVAILABLE: agency runtime is not ready')
  return runtime
}

export function createCallApprovals(deps: CallApprovalsDeps) {
  function findCard(runtime: ApprovalsRuntime, cardId: string): PendingActionCard | undefined {
    return runtime.listPendingCards().find((c) => c.id === cardId)
  }

  function maybeInject(runtime: ApprovalsRuntime, cardId: string, contextText: string): boolean {
    const origin = runtime.getCardOrigin(cardId)
    const active = deps.getActiveCallId()
    if (!origin?.callId || !active || origin.callId !== active) return false
    deps.inject(active, contextText)
    return true
  }

  return {
    /** Click approval (`agency:approve`). */
    async approve(input: { cardId: string; scope?: 'once' | 'session' | 'always' }): Promise<ResolveCardResult> {
      const runtime = requireRuntime(deps)
      const card = findCard(runtime, input.cardId)
      const summary = card ? describePendingActionPt(card) : 'a ação'
      try {
        const res = await runtime.approvePendingAction({ actionId: input.cardId, scope: input.scope ?? 'once' })
        const output = leanToolOutput(res.card.toolName, res.output, CONTEXT_OUTPUT_MAX_CHARS)
        const injected = maybeInject(
          runtime,
          input.cardId,
          `[Contexto] Ação aprovada: ${summary}. Resultado: ${output}`,
        )
        return { status: 'approved', cardId: input.cardId, output, injected }
      } catch (err) {
        if (!card) throw err
        const injected = maybeInject(runtime, input.cardId, `[Contexto] A ação aprovada (${summary}) falhou: ${errText(err)}`)
        return { status: 'failed', cardId: input.cardId, output: errText(err), injected }
      }
    },

    /** Click denial (`agency:deny`). */
    async deny(input: { cardId: string }): Promise<ResolveCardResult> {
      const runtime = requireRuntime(deps)
      const card = findCard(runtime, input.cardId)
      const summary = card ? describePendingActionPt(card) : 'a ação'
      await runtime.denyPendingAction({ actionId: input.cardId, reason: 'Negado pelo usuário' })
      const injected = maybeInject(runtime, input.cardId, `[Contexto] O usuário negou a ação: ${summary}. Nada foi feito.`)
      return { status: 'denied', cardId: input.cardId, injected }
    },

    /**
     * Voice approval inside `call:buildContext`. Only the most recent pending card staged by THIS
     * (active) call is considered; a card with a blast-radius warning is never resolved by voice.
     */
    async handleVoiceTurn(callId: string, userText: string): Promise<VoiceApprovalOutcome> {
      const decision = classifyVoiceApproval(userText)
      if (!decision) return { handled: false }
      if (deps.getActiveCallId() !== callId) return { handled: false }
      const runtime = deps.getRuntime()
      if (!runtime) return { handled: false }
      const card = runtime
        .listPendingCards()
        .filter((c) => runtime.getCardOrigin(c.id)?.callId === callId)
        .at(-1)
      if (!card) return { handled: false }
      const summary = describePendingActionPt(card)
      if (!isVoiceApprovable(card)) {
        return {
          handled: false,
          contextLine: `[Contexto] A ação pendente (${summary}) só pode ser aprovada pelo botão na tela; avise o usuário.`,
        }
      }
      if (decision === 'deny') {
        try {
          await runtime.denyPendingAction({ actionId: card.id, reason: 'Negado por voz na chamada' })
        } catch (err) {
          return { handled: true, decision, contextLine: `[Contexto] Não consegui cancelar "${summary}": ${errText(err)}` }
        }
        return { handled: true, decision, contextLine: `[Contexto] O usuário negou "${summary}". Nada foi feito.` }
      }
      try {
        const res = await runtime.approvePendingAction({
          actionId: card.id,
          scope: decision === 'always' ? 'always' : 'once',
        })
        const output = leanToolOutput(res.card.toolName, res.output, CONTEXT_OUTPUT_MAX_CHARS)
        const always = decision === 'always' ? ' (e pediu para sempre permitir essa ação)' : ''
        return {
          handled: true,
          decision,
          contextLine: `[Contexto] O usuário aprovou "${summary}"${always}. Resultado: ${output}`,
        }
      } catch (err) {
        return {
          handled: true,
          decision,
          contextLine: `[Contexto] O usuário aprovou "${summary}", mas a ação falhou: ${errText(err)}`,
        }
      }
    },
  }
}

export type CallApprovals = ReturnType<typeof createCallApprovals>
