import {
  DEFAULT_INITIATIVE_POLICY,
  ProactiveInitiativeRecordSchema,
  type AutobiographicalMilestone,
  type CrossEpisodeLink,
  type EpisodicMemory,
  type InitiativeDecision,
  type InitiativePolicy,
  type InitiativeTriggerKind,
  type MoodVector,
  type ProactiveInitiativeRecord,
  type ProspectiveIntent,
  type SeriousnessAssessment,
  type UserHabit,
} from '@ashy/shared'
import * as v from 'valibot'
import {
  detectCrossEpisodeLinks,
  isReflectablePermanentEpisode,
} from '../dream/dream-worker'
import {
  buildProactiveNoticePrompt,
  formatLocalTimeHHMM,
  sanitizePromptLine,
  shouldDiscardProactiveReply,
} from '../prompt/soul-composer'

const HHMM_RE = /^(?:([01]\d|2[0-3]):([0-5]\d))$/

const LATE_NIGHT_HABIT_RE = /\b(?:late_night|night_owl|madrugada|noturn)/i
const DEEP_FOCUS_HABIT_RE =
  /\b(?:deep_focus_no_interrupt|no_interrupt|foco_profundo|nao_interromp)/i

const BOND_MANIPULATION_PATTERNS: readonly RegExp[] = [
  /você me abandonou/gi,
  /me deixou sozinha/gi,
  /esqueceu de mim/gi,
  /nunca mais falou comigo/gi,
  /só eu me importo com você/gi,
  /por que você sumiu/gi,
  /fiquei sozinha esperando/gi,
]

let initiativeSequence = 0

function parseHHMMToMinutes(hhmm: string): number | null {
  if (typeof hhmm !== 'string') return null
  const match = HHMM_RE.exec(hhmm.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours * 60 + minutes
}

/**
 * Checks if `currentHHMM` falls within `[startHHMM, endHHMM)`.
 * Supports both same-day windows (`01:00`–`06:00`) and overnight wrap-around (`23:00`–`08:00`).
 * Returns `false` if `startHHMM === endHHMM` or if any input is malformed.
 */
export function isWithinQuietHours(
  currentHHMM: string,
  startHHMM: string,
  endHHMM: string,
): boolean {
  const cur = parseHHMMToMinutes(currentHHMM)
  const start = parseHHMMToMinutes(startHHMM)
  const end = parseHHMMToMinutes(endHHMM)
  if (cur === null || start === null || end === null || start === end) {
    return false
  }
  if (start < end) {
    return cur >= start && cur < end
  }
  return cur >= start || cur < end
}

export function stripBondManipulation(raw: string): string {
  let cleaned = raw
  for (const pattern of BOND_MANIPULATION_PATTERNS) {
    cleaned = cleaned.replace(pattern, '')
  }
  return cleaned.replace(/\s+/g, ' ').trim()
}

export interface EvaluateAttentionLoopParams {
  policy?: InitiativePolicy
  dndMode?: boolean
  nowMs?: number
  localTimeHHMM?: string
  prospectiveIntents: readonly ProspectiveIntent[]
  milestones: readonly AutobiographicalMilestone[]
  episodes: readonly EpisodicMemory[]
  crossEpisodeLinks?: readonly CrossEpisodeLink[]
  userHabits?: readonly UserHabit[]
  recentInitiatives?: readonly ProactiveInitiativeRecord[]
  mood?: MoodVector
  seriousness?: SeriousnessAssessment
  idleMinutes?: number
  activeAppTitle?: string
  recentUserMessage?: string
  simulatedReplyText?: string
}

function createRecord(params: {
  nowMs: number
  triggerKind: InitiativeTriggerKind
  sourceId: string | null
  sourceTitle: string
  noticePrompt: string
  replyText: string | null
  decision: InitiativeDecision
  reason: string
}): ProactiveInitiativeRecord {
  initiativeSequence += 1
  return v.parse(ProactiveInitiativeRecordSchema, {
    id: `init-${params.nowMs}-${initiativeSequence}`,
    triggerKind: params.triggerKind,
    sourceId: params.sourceId,
    sourceTitle: params.sourceTitle,
    noticePrompt: params.noticePrompt,
    replyText: params.replyText,
    decision: params.decision,
    reason: params.reason,
    createdAt: params.nowMs,
  })
}

function buildDefaultGroundedReply(
  triggerKind: Exclude<InitiativeTriggerKind, 'none'>,
  sourceTitle: string,
  seriousness?: SeriousnessAssessment,
): string {
  const cleanTitle = sanitizePromptLine(sourceTitle) || 'nosso último assunto'
  if (seriousness?.isSeriousOrDelicate) {
    return `Ei, passando com calma só para lembrar de "${cleanTitle}" — sem pressa nenhuma, quando você quiser conversar sobre isso estou por aqui.`
  }
  switch (triggerKind) {
    case 'prospective_intent':
      return `Ei, lembrei do que você comentou sobre "${cleanTitle}". Como está indo isso? Se quiser revisar juntos, tô por aqui no estúdio.`
    case 'milestone_followup':
      return `Estava lembrando daquele nosso marco "${cleanTitle}". Como estão as coisas por aí hoje?`
    case 'recurring_theme':
      return `Notei uma conexão recorrente nas nossas conversas sobre "${cleanTitle}". Quando tiver um respiro, te conto o que percebi.`
  }
}

/**
 * Evaluates Ashy's contextual attention loop with Selective Silence (`[SILENCE]`),
 * configurable limits (`InitiativePolicy`), habit modulation, and strict quarantine isolation.
 */
export function evaluateAttentionLoop(
  params: EvaluateAttentionLoopParams,
): ProactiveInitiativeRecord {
  const policy: InitiativePolicy = params.policy ?? DEFAULT_INITIATIVE_POLICY
  const safeNow =
    params.nowMs !== undefined && Number.isFinite(params.nowMs) && params.nowMs >= 0
      ? Math.floor(params.nowMs)
      : Date.now()

  const resolvedHHMM =
    typeof params.localTimeHHMM === 'string' && HHMM_RE.test(params.localTimeHHMM.trim())
      ? params.localTimeHHMM.trim()
      : formatLocalTimeHHMM(safeNow)

  // 1. Disabled check ("Nunca iniciar sozinha")
  if (!policy.enabled) {
    return createRecord({
      nowMs: safeNow,
      triggerKind: 'none',
      sourceId: null,
      sourceTitle: '',
      noticePrompt: '',
      replyText: null,
      decision: 'suppressed_disabled',
      reason: 'Iniciativa espontânea desativada pelo usuário (modo Nunca iniciar sozinha).',
    })
  }

  // 2. DND check
  if (policy.respectDnd && Boolean(params.dndMode)) {
    return createRecord({
      nowMs: safeNow,
      triggerKind: 'none',
      sourceId: null,
      sourceTitle: '',
      noticePrompt: '',
      replyText: null,
      decision: 'suppressed_dnd',
      reason: 'Modo Não Perturbe (DND) está ativo.',
    })
  }

  const episodesById = new Map<string, EpisodicMemory>()
  for (const ep of params.episodes ?? []) {
    episodesById.set(ep.id, ep)
  }

  const isEpisodeQuarantinedOrTransient = (episodeId?: string | null): boolean => {
    if (!episodeId) return false
    const cleanId = episodeId.trim()
    if (cleanId.startsWith('ep-turn-') || cleanId.startsWith('ep-dream-')) {
      return true
    }
    const ep = episodesById.get(cleanId)
    if (!ep) return false
    return !isReflectablePermanentEpisode(ep) || ep.approvalStatus === 'pending_review'
  }

  const approvedHabits = (params.userHabits ?? []).filter(
    (h) =>
      h.approvalStatus !== 'pending_review' &&
      !isEpisodeQuarantinedOrTransient(h.sourceEpisodeId),
  )

  // 3. Quiet hours check (modulated by late-night habits when enabled)
  if (isWithinQuietHours(resolvedHHMM, policy.quietHoursStart, policy.quietHoursEnd)) {
    const hasLateNightHabit =
      policy.modulateByHabits &&
      approvedHabits.some(
        (h) =>
          h.confidence >= 0.75 &&
          LATE_NIGHT_HABIT_RE.test(`${h.patternKey} ${h.description}`),
      )

    if (!hasLateNightHabit) {
      return createRecord({
        nowMs: safeNow,
        triggerKind: 'none',
        sourceId: null,
        sourceTitle: '',
        noticePrompt: '',
        replyText: null,
        decision: 'suppressed_quiet_hours',
        reason: `Horário de silêncio ativo (${resolvedHHMM} dentro de ${policy.quietHoursStart}–${policy.quietHoursEnd}).`,
      })
    }
  }

  // 4. Focus habit suppression
  if (policy.modulateByHabits) {
    const hasDeepFocusHabit = approvedHabits.some(
      (h) =>
        h.confidence >= 0.7 &&
        DEEP_FOCUS_HABIT_RE.test(`${h.patternKey} ${h.description}`),
    )
    if (hasDeepFocusHabit) {
      return createRecord({
        nowMs: safeNow,
        triggerKind: 'none',
        sourceId: null,
        sourceTitle: '',
        noticePrompt: '',
        replyText: null,
        decision: 'suppressed_habit_focus',
        reason: 'Hábito de foco profundo sem interrupções detectado.',
      })
    }
  }

  const recentSpoken = (params.recentInitiatives ?? []).filter(
    (r) => r.decision === 'spoken',
  )

  // 5. Daily limit check (rolling 24h window)
  const spokenInLast24h = recentSpoken.filter(
    (r) => safeNow - r.createdAt >= 0 && safeNow - r.createdAt < 86_400_000,
  )
  if (spokenInLast24h.length >= policy.maxDailyInitiatives) {
    return createRecord({
      nowMs: safeNow,
      triggerKind: 'none',
      sourceId: null,
      sourceTitle: '',
      noticePrompt: '',
      replyText: null,
      decision: 'suppressed_daily_limit',
      reason: `Limite diário de iniciativas atingido (${spokenInLast24h.length}/${policy.maxDailyInitiatives}).`,
    })
  }

  // 6. Cooldown check
  const mostRecentSpoken = recentSpoken
    .filter((r) => r.createdAt <= safeNow)
    .sort((a, b) => b.createdAt - a.createdAt)[0]

  if (
    mostRecentSpoken &&
    safeNow - mostRecentSpoken.createdAt < policy.cooldownMinutes * 60_000
  ) {
    return createRecord({
      nowMs: safeNow,
      triggerKind: 'none',
      sourceId: null,
      sourceTitle: '',
      noticePrompt: '',
      replyText: null,
      decision: 'suppressed_cooldown',
      reason: `Cooldown de iniciativa ativo (${policy.cooldownMinutes} min).`,
    })
  }

  // 7. Candidate anchor selection (strictly approved & permanent)
  const spokenSourceIds = new Set<string>(
    recentSpoken.map((r) => r.sourceId).filter((id): id is string => Boolean(id)),
  )

  let selectedTriggerKind: Exclude<InitiativeTriggerKind, 'none'> | null = null
  let selectedSourceId: string | null = null
  let selectedSourceTitle = ''

  // Priority 1: Pending due prospective_intent
  const eligibleIntent = (params.prospectiveIntents ?? [])
    .filter(
      (intent) =>
        intent.status === 'pending' &&
        intent.approvalStatus !== 'pending_review' &&
        !isEpisodeQuarantinedOrTransient(intent.sourceEpisodeId) &&
        (intent.dueAt === null || intent.dueAt === undefined || intent.dueAt <= safeNow) &&
        !spokenSourceIds.has(intent.id),
    )
    .sort((a, b) => (a.dueAt ?? a.createdAt) - (b.dueAt ?? b.createdAt))[0]

  if (eligibleIntent) {
    selectedTriggerKind = 'prospective_intent'
    selectedSourceId = eligibleIntent.id
    selectedSourceTitle = sanitizePromptLine(eligibleIntent.topic)
  }

  // Priority 2: Unspoken milestone_followup
  if (!selectedTriggerKind) {
    const eligibleMilestone = (params.milestones ?? [])
      .filter(
        (ms) =>
          !spokenSourceIds.has(ms.id) &&
          !isEpisodeQuarantinedOrTransient(ms.episodeId),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0]

    if (eligibleMilestone) {
      selectedTriggerKind = 'milestone_followup'
      selectedSourceId = eligibleMilestone.id
      selectedSourceTitle = sanitizePromptLine(eligibleMilestone.title)
    }
  }

  // Priority 3: Unspoken recurring_theme (CrossEpisodeLink)
  if (!selectedTriggerKind) {
    const rawLinks =
      params.crossEpisodeLinks !== undefined
        ? params.crossEpisodeLinks
        : detectCrossEpisodeLinks(params.episodes ?? [])

    for (const link of rawLinks) {
      if (
        isEpisodeQuarantinedOrTransient(link.fromEpisodeId) ||
        isEpisodeQuarantinedOrTransient(link.toEpisodeId)
      ) {
        continue
      }
      const fromEp = episodesById.get(link.fromEpisodeId)
      const toEp = episodesById.get(link.toEpisodeId)
      if (
        (fromEp && !isReflectablePermanentEpisode(fromEp)) ||
        (toEp && !isReflectablePermanentEpisode(toEp))
      ) {
        continue
      }
      const cleanTheme = sanitizePromptLine(link.sharedTheme) || 'shared_studio_context'
      const linkId =
        link.id && link.id.trim().length > 0
          ? link.id.trim()
          : `link-${link.fromEpisodeId}-${link.toEpisodeId}-${cleanTheme}`

      if (spokenSourceIds.has(linkId)) {
        continue
      }

      selectedTriggerKind = 'recurring_theme'
      selectedSourceId = linkId
      selectedSourceTitle = sanitizePromptLine(
        fromEp && toEp
          ? `${cleanTheme}: ${fromEp.title} & ${toEp.title}`
          : `Tema recorrente: ${cleanTheme}`,
      )
      break
    }
  }

  if (!selectedTriggerKind || !selectedSourceId || !selectedSourceTitle) {
    return createRecord({
      nowMs: safeNow,
      triggerKind: 'none',
      sourceId: null,
      sourceTitle: '',
      noticePrompt: '',
      replyText: null,
      decision: 'suppressed_no_anchor',
      reason:
        'Nenhuma âncora concreta aprovada disponível (intenção, marco ou tema recorrente).',
    })
  }

  // 8. Build notice prompt
  const noticePrompt = buildProactiveNoticePrompt(
    selectedTriggerKind,
    selectedSourceTitle,
    {
      mood: params.mood,
      seriousness: params.seriousness,
    },
  )

  // 9. Selective Silence & Anti-Manipulation check
  const rawCandidateReply =
    params.simulatedReplyText !== undefined
      ? params.simulatedReplyText
      : buildDefaultGroundedReply(
          selectedTriggerKind,
          selectedSourceTitle,
          params.seriousness,
        )

  if (shouldDiscardProactiveReply(rawCandidateReply)) {
    return createRecord({
      nowMs: safeNow,
      triggerKind: selectedTriggerKind,
      sourceId: selectedSourceId,
      sourceTitle: selectedSourceTitle,
      noticePrompt,
      replyText: null,
      decision: 'selective_silence',
      reason: 'Silêncio seletivo ([SILENCE]) escolhido pela Ashy.',
    })
  }

  const sanitizedReply = stripBondManipulation(sanitizePromptLine(rawCandidateReply))
  if (!sanitizedReply || shouldDiscardProactiveReply(sanitizedReply)) {
    return createRecord({
      nowMs: safeNow,
      triggerKind: selectedTriggerKind,
      sourceId: selectedSourceId,
      sourceTitle: selectedSourceTitle,
      noticePrompt,
      replyText: null,
      decision: 'selective_silence',
      reason: 'Silêncio seletivo aplicado após sanitização da mensagem proativa.',
    })
  }

  return createRecord({
    nowMs: safeNow,
    triggerKind: selectedTriggerKind,
    sourceId: selectedSourceId,
    sourceTitle: selectedSourceTitle,
    noticePrompt,
    replyText: sanitizedReply,
    decision: 'spoken',
    reason: `Iniciativa contextual ancorada em ${selectedTriggerKind} (${selectedSourceId}).`,
  })
}
