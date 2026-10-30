import {
  RoomEnvironmentStateSchema,
  RoomTrophyItemSchema,
  type AutobiographicalMilestone,
  type EpisodicMemory,
  type MilestoneCategory,
  type RoomEnvironmentState,
  type RoomLightingPreset,
  type RoomTimeOfDayPeriod,
  type RoomTrophyIconKey,
  type RoomTrophyItem,
} from '@ashy/shared'
import * as v from 'valibot'
import { formatLocalTimeHHMM, sanitizePromptLine } from '../prompt/soul-composer'

const HHMM_RE = /^(?:([01]\d|2[0-3]):([0-5]\d))$/

export const TROPHY_BY_MILESTONE_CATEGORY: Readonly<Record<MilestoneCategory, string>> =
  Object.freeze({
    first_meeting: 'trophy-spark-crystal',
    inside_joke_born: 'trophy-rubber-duck',
    project_shipped: 'trophy-launch-rocket',
    late_night_debug: 'trophy-midnight-mug',
    trait_evolution: 'trophy-prism-heart',
    flashbulb_moment: 'trophy-polaroid-frame',
  })

const DEFAULT_ICON_BY_CATEGORY: Readonly<Record<MilestoneCategory, RoomTrophyIconKey>> =
  Object.freeze({
    first_meeting: 'sparkles',
    inside_joke_born: 'duck',
    project_shipped: 'rocket',
    late_night_debug: 'mug',
    trait_evolution: 'heart',
    flashbulb_moment: 'flame',
  })

interface TrophyCatalogEntry {
  readonly name: string
  readonly description: string
  readonly iconKey: RoomTrophyIconKey
}

const KNOWN_TROPHY_CATALOG: Readonly<Record<string, TrophyCatalogEntry>> = Object.freeze({
  'trophy-first-boot-mug': {
    name: 'First Boot Mug',
    description: 'Caneca da primeira madrugada de arquitetura no estúdio',
    iconKey: 'mug',
  },
  'trophy-padre-npm-relic': {
    name: 'Padre no NPM Relic',
    description: 'Relíquia do exorcismo de bug fantasma no backend',
    iconKey: 'duck',
  },
  'trophy-prod-shield': {
    name: '03:14 AM Production Shield',
    description: 'Escudo que salvou o banco de produção às 03:14 da manhã',
    iconKey: 'shield',
  },
  'trophy-spark-crystal': {
    name: 'Cristal do Primeiro Encontro',
    description: 'Marco da primeira conversa no Cozy Night Studio',
    iconKey: 'sparkles',
  },
  'trophy-rubber-duck': {
    name: 'Pato de Borracha da Piada Interna',
    description: 'Lembrança de uma piada interna nascida no estúdio',
    iconKey: 'duck',
  },
  'trophy-launch-rocket': {
    name: 'Miniatura de Foguete de Deploy',
    description: 'Troféu de projeto entregue e colocado no ar',
    iconKey: 'rocket',
  },
  'trophy-midnight-mug': {
    name: 'Caneca de Café da Madrugada',
    description: 'Companheira de sessões intensas de debug noturno',
    iconKey: 'moon',
  },
  'trophy-prism-heart': {
    name: 'Prisma de Evolução da Alma',
    description: 'Registro de amadurecimento de traço de personalidade',
    iconKey: 'heart',
  },
  'trophy-polaroid-frame': {
    name: 'Polaroid de Momento Flashbulb',
    description: 'Memória vívida de alta intensidade emocional',
    iconKey: 'flame',
  },
})

/**
 * Resolves the ambient period of day, studio label, and lighting preset for Ashy's Room.
 * Accepts an optional `localTimeHHMM` override for timezone-independent deterministic tests.
 */
export function resolveRoomTimeOfDayPeriod(
  nowMs?: number,
  localTimeHHMM?: string,
): {
  period: RoomTimeOfDayPeriod
  ambientLabel: string
  lightingPreset: RoomLightingPreset
} {
  const safeNow =
    nowMs !== undefined && Number.isFinite(nowMs) && nowMs >= 0 ? nowMs : Date.now()
  const resolvedHHMM =
    typeof localTimeHHMM === 'string' && HHMM_RE.test(localTimeHHMM.trim())
      ? localTimeHHMM.trim()
      : formatLocalTimeHHMM(safeNow)

  const match = HHMM_RE.exec(resolvedHHMM)
  const hour = match ? Number(match[1]) : 22

  if (hour >= 6 && hour < 12) {
    return {
      period: 'morning',
      ambientLabel: 'Manhã clara no estúdio',
      lightingPreset: 'warm_sunrise',
    }
  }
  if (hour >= 12 && hour < 18) {
    return {
      period: 'afternoon',
      ambientLabel: 'Tarde dourada de foco',
      lightingPreset: 'golden_studio',
    }
  }
  if (hour >= 18 && hour < 23) {
    return {
      period: 'evening',
      ambientLabel: 'Noite aconchegante no estúdio',
      lightingPreset: 'cozy_neon',
    }
  }
  return {
    period: 'late_night',
    ambientLabel: 'Madrugada lo-fi silenciosa',
    lightingPreset: 'midnight_lofi',
  }
}

export interface DeriveAshyRoomEnvironmentParams {
  milestones: readonly AutobiographicalMilestone[]
  episodes?: readonly EpisodicMemory[]
  nowMs?: number
  localTimeHHMM?: string
}

/**
 * Derives Ashy's Room state (`period`, `ambientLabel`, `lightingPreset`, and `unlockedTrophies`)
 * directly from real persisted milestones, excluding any milestone linked to a quarantined episode.
 */
export function deriveAshyRoomEnvironment(
  params: DeriveAshyRoomEnvironmentParams,
): RoomEnvironmentState {
  const timeInfo = resolveRoomTimeOfDayPeriod(params.nowMs, params.localTimeHHMM)

  const episodesById = new Map<string, EpisodicMemory>()
  for (const ep of params.episodes ?? []) {
    episodesById.set(ep.id, ep)
  }

  const seenTrophyIds = new Set<string>()
  const unlockedTrophies: RoomTrophyItem[] = []

  for (const ms of params.milestones ?? []) {
    if (ms.episodeId) {
      if (ms.episodeId.startsWith('ep-turn-') || ms.episodeId.startsWith('ep-dream-')) {
        continue
      }
      const linkedEp = episodesById.get(ms.episodeId)
      if (linkedEp && linkedEp.approvalStatus === 'pending_review') {
        continue
      }
    }

    const baseTrophyId =
      (ms.roomTrophyId && ms.roomTrophyId.trim()) ||
      TROPHY_BY_MILESTONE_CATEGORY[ms.category] ||
      `trophy-${ms.id}`

    const uniqueTrophyId = seenTrophyIds.has(baseTrophyId)
      ? `${baseTrophyId}-${ms.id}`
      : baseTrophyId
    seenTrophyIds.add(uniqueTrophyId)

    const catalogEntry = KNOWN_TROPHY_CATALOG[baseTrophyId]
    const cleanTitle = sanitizePromptLine(ms.title) || 'Marco compartilhado'
    const cleanNarrative = sanitizePromptLine(ms.narrative) || cleanTitle

    const name = catalogEntry ? catalogEntry.name : cleanTitle
    const description = catalogEntry
      ? `${catalogEntry.description} (${cleanTitle})`
      : cleanNarrative
    const iconKey: RoomTrophyIconKey = catalogEntry
      ? catalogEntry.iconKey
      : (DEFAULT_ICON_BY_CATEGORY[ms.category] ?? 'sparkles')

    unlockedTrophies.push(
      v.parse(RoomTrophyItemSchema, {
        id: uniqueTrophyId,
        name,
        description,
        category: ms.category,
        milestoneId: ms.id,
        ...(ms.episodeId ? { episodeId: ms.episodeId } : {}),
        unlockedAt: ms.createdAt,
        unlocked: true,
        iconKey,
      }),
    )
  }

  return v.parse(RoomEnvironmentStateSchema, {
    period: timeInfo.period,
    ambientLabel: timeInfo.ambientLabel,
    lightingPreset: timeInfo.lightingPreset,
    unlockedTrophies,
  })
}
