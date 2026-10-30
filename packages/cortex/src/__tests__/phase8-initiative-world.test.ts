import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_INITIATIVE_POLICY } from '@ashy/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAshyCortex,
  createCortexDatabase,
  deriveAshyRoomEnvironment,
  detectCrossEpisodeLinks,
  evaluateAttentionLoop,
  isWithinQuietHours,
  resolveRoomTimeOfDayPeriod,
  TROPHY_BY_MILESTONE_CATEGORY,
} from '../index'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-cortex-p8-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('@ashy/cortex Phase 8 — Contextual Initiative, Own World & Dream Journal (M4)', () => {
  it('maintains 100% parity between SQLite and MemoryStorageAdapter for Migration v5 tables, updateMilestone, and deleteEpisodicMemory cascade cleanup', () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'ashy-p8.db')

    for (const forceMemoryFallback of [false, true]) {
      const db = createCortexDatabase(
        forceMemoryFallback ? { forceMemoryFallback: true } : { filePath: dbPath },
      )

      expect(db.getAppliedMigrations().map((m) => m.version)).toEqual([1, 2, 3, 4, 5])
      expect(db.getAppliedMigrations().find((m) => m.version === 5)?.name).toBe(
        'v5_phase8_initiative_and_reflection_journal',
      )
      expect(db.listSqlTables()).toEqual(
        expect.arrayContaining([
          'initiative_policy_state',
          'proactive_initiative_log',
          'dream_reflection_journal',
        ]),
      )

      // 1. Initiative policy get/save + validation
      expect(db.getInitiativePolicy()).toEqual(DEFAULT_INITIATIVE_POLICY)
      const updatedPolicy = db.saveInitiativePolicy({
        cooldownMinutes: 90,
        maxDailyInitiatives: 4,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        modulateByHabits: false,
      })
      expect(updatedPolicy).toEqual({
        enabled: true,
        cooldownMinutes: 90,
        maxDailyInitiatives: 4,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        respectDnd: true,
        modulateByHabits: false,
      })
      expect(() => db.saveInitiativePolicy({ quietHoursStart: '25:99' })).toThrow()

      // 2. Proactive initiative log insert/list (DESC order)
      db.insertProactiveInitiativeLog({
        id: 'init-1',
        triggerKind: 'prospective_intent',
        sourceId: 'intent-1',
        sourceTitle: 'Revisar PR de migração',
        noticePrompt: '[Proactive Notice] Source: prospective_intent',
        replyText: 'E aí, conseguiu revisar o PR?',
        decision: 'spoken',
        reason: 'Intenção pendente vencida',
        createdAt: 1730000010000,
      })
      db.insertProactiveInitiativeLog({
        id: 'init-2',
        triggerKind: 'none',
        sourceId: null,
        sourceTitle: '',
        noticePrompt: '',
        replyText: null,
        decision: 'suppressed_cooldown',
        reason: 'Cooldown ativo',
        createdAt: 1730000020000,
      })
      const logList = db.listProactiveInitiativeLog(10)
      expect(logList.map((r) => r.id)).toEqual(['init-2', 'init-1'])

      // 3. Milestone update + sanitization against stage markers and null bytes + error when missing
      db.upsertMilestone({
        id: 'ms-p8-1',
        title: 'Título Original',
        narrative: 'Narrativa original do marco.',
        category: 'first_meeting',
        episodeId: 'ep-a',
        roomTrophyId: 'trophy-first-boot-mug',
        createdAt: 1730000000000,
      })

      const editedMs = db.updateMilestone({
        id: 'ms-p8-1',
        title: 'Novo Título <|ACT {"emotion":"smug"}|>',
        narrative: 'Narrativa editada <|DELAY 2|> com sucesso.',
        category: 'project_shipped',
      })
      expect(editedMs.title).toBe('Novo Título')
      expect(editedMs.narrative).toBe('Narrativa editada com sucesso.')
      expect(editedMs.category).toBe('project_shipped')
      expect(editedMs.roomTrophyId).toBe('trophy-first-boot-mug')

      expect(() =>
        db.updateMilestone({
          id: 'ms-non-existent',
          title: 'Inexistente',
        }),
      ).toThrow(/not found/i)

      expect(() =>
        db.updateMilestone({
          id: 'ms-p8-1',
          title: '<|ACT {"emotion":"smug"}|>',
        }),
      ).toThrow(/empty after sanitization/i)

      // 4. Dream reflection journal insert/list + cascade delete when episodes are deleted
      db.upsertEpisodicMemory({
        id: 'ep-a',
        title: 'Episódio A',
        summary: 'Resumo A',
        content: 'Conteúdo A',
        createdAt: 1730000001000,
        lastReviewedAt: 1730000001000,
        stability: 5,
        difficulty: 3,
        surprise: 0.7,
        isFlashbulb: false,
        tags: ['architecture'],
      })
      db.upsertEpisodicMemory({
        id: 'ep-b',
        title: 'Episódio B',
        summary: 'Resumo B',
        content: 'Conteúdo B',
        createdAt: 1730000002000,
        lastReviewedAt: 1730000002000,
        stability: 5,
        difficulty: 3,
        surprise: 0.7,
        isFlashbulb: false,
        tags: ['architecture'],
      })

      db.insertDreamJournalEntry({
        id: 'dj-single',
        summary: 'Reflexão exclusiva sobre ep-a',
        sourceEpisodeIds: ['ep-a'],
        crossLinksCount: 0,
        traitEvolutionsCount: 1,
        createdAt: 1730000005000,
      })
      db.insertDreamJournalEntry({
        id: 'dj-both',
        summary: 'Reflexão conectando ep-a e ep-b',
        sourceEpisodeIds: ['ep-a', 'ep-b'],
        crossLinksCount: 1,
        traitEvolutionsCount: 1,
        createdAt: 1730000006000,
      })

      expect(db.listDreamJournalEntries().map((e) => e.id)).toEqual(['dj-both', 'dj-single'])

      // Deleting ep-a must remove dj-single (since sourceEpisodeIds becomes empty) and update dj-both to ['ep-b']
      db.deleteEpisodicMemory('ep-a')
      const remainingJournal = db.listDreamJournalEntries()
      expect(remainingJournal).toHaveLength(1)
      expect(remainingJournal[0]?.id).toBe('dj-both')
      expect(remainingJournal[0]?.sourceEpisodeIds).toEqual(['ep-b'])

      // Deleting ep-b removes dj-both as well
      db.deleteEpisodicMemory('ep-b')
      expect(db.listDreamJournalEntries()).toHaveLength(0)

      db.close()
    }
  })

  it('populates deterministic id on every CrossEpisodeLink in detectCrossEpisodeLinks', () => {
    const links = detectCrossEpisodeLinks([
      {
        id: 'ep-101',
        title: 'Arquitetura SQLite de madrugada',
        summary: 'Sessão de código de madrugada no banco SQLite',
        content: 'Implementamos FTS5 e migrações na madrugada.',
        createdAt: 1730000000000,
        lastReviewedAt: 1730000000000,
        stability: 5,
        difficulty: 3,
        surprise: 0.8,
        isFlashbulb: false,
        tags: ['late_night_debug', 'sqlite'],
        approvalStatus: 'approved',
      },
      {
        id: 'ep-102',
        title: 'Refatoração do SQLite na madrugada',
        summary: 'Outra madrugada ajustando queries SQLite',
        content: 'Otimizamos o ranker híbrido no SQLite.',
        createdAt: 1730086400000,
        lastReviewedAt: 1730086400000,
        stability: 5,
        difficulty: 3,
        surprise: 0.75,
        isFlashbulb: false,
        tags: ['late_night_debug', 'sqlite'],
        approvalStatus: 'approved',
      },
    ])

    expect(links).toHaveLength(1)
    expect(links[0]?.id).toBe('link-ep-101-ep-102-late_night_debug')
  })

  it('evaluates isWithinQuietHours accurately for both overnight wrap-around and same-day windows', () => {
    // Overnight wrap-around: 23:00 to 08:00
    expect(isWithinQuietHours('23:00', '23:00', '08:00')).toBe(true)
    expect(isWithinQuietHours('02:30', '23:00', '08:00')).toBe(true)
    expect(isWithinQuietHours('07:59', '23:00', '08:00')).toBe(true)
    expect(isWithinQuietHours('08:00', '23:00', '08:00')).toBe(false)
    expect(isWithinQuietHours('14:00', '23:00', '08:00')).toBe(false)
    expect(isWithinQuietHours('22:59', '23:00', '08:00')).toBe(false)

    // Same-day window: 01:00 to 06:00
    expect(isWithinQuietHours('00:30', '01:00', '06:00')).toBe(false)
    expect(isWithinQuietHours('01:00', '01:00', '06:00')).toBe(true)
    expect(isWithinQuietHours('04:15', '01:00', '06:00')).toBe(true)
    expect(isWithinQuietHours('06:00', '01:00', '06:00')).toBe(false)

    // Identical start and end -> false
    expect(isWithinQuietHours('03:00', '00:00', '00:00')).toBe(false)
  })

  it('enforces all suppression gates, habit modulations, quarantine isolation, anchor priority, and selective silence in evaluateAttentionLoop', () => {
    const nowMs = 1730050000000
    const approvedEpisode = {
      id: 'ep-perm-1',
      title: 'Deploy de sexta',
      summary: 'Planejamos o deploy de sexta-feira.',
      content: 'Revisar migrações antes do deploy.',
      createdAt: nowMs - 86_400_000,
      lastReviewedAt: nowMs - 86_400_000,
      stability: 5,
      difficulty: 3,
      surprise: 0.7,
      isFlashbulb: false,
      tags: ['deploy'],
      approvalStatus: 'approved' as const,
    }
    const pendingIntent = {
      id: 'intent-due-1',
      topic: 'Conferir logs pós-deploy',
      contextCue: 'deploy',
      dueAt: nowMs - 60_000,
      status: 'pending' as const,
      createdAt: nowMs - 3_600_000,
      sourceEpisodeId: 'ep-perm-1',
      approvalStatus: 'approved' as const,
    }

    // 1. Disabled policy ("Nunca iniciar sozinha")
    const resDisabled = evaluateAttentionLoop({
      policy: { ...DEFAULT_INITIATIVE_POLICY, enabled: false },
      nowMs,
      localTimeHHMM: '14:00',
      prospectiveIntents: [pendingIntent],
      milestones: [],
      episodes: [approvedEpisode],
    })
    expect(resDisabled.decision).toBe('suppressed_disabled')
    expect(resDisabled.replyText).toBeNull()

    // 2. DND active
    const resDnd = evaluateAttentionLoop({
      policy: DEFAULT_INITIATIVE_POLICY,
      dndMode: true,
      nowMs,
      localTimeHHMM: '14:00',
      prospectiveIntents: [pendingIntent],
      milestones: [],
      episodes: [approvedEpisode],
    })
    expect(resDnd.decision).toBe('suppressed_dnd')

    // 3. Quiet hours without late-night habit -> suppressed_quiet_hours
    const resQuiet = evaluateAttentionLoop({
      policy: DEFAULT_INITIATIVE_POLICY,
      nowMs,
      localTimeHHMM: '02:15',
      prospectiveIntents: [pendingIntent],
      milestones: [],
      episodes: [approvedEpisode],
    })
    expect(resQuiet.decision).toBe('suppressed_quiet_hours')

    // 4. Quiet hours WITH approved late-night habit (confidence >= 0.75) -> allowed to speak!
    const resLateNightHabitAllowed = evaluateAttentionLoop({
      policy: DEFAULT_INITIATIVE_POLICY,
      nowMs,
      localTimeHHMM: '02:15',
      prospectiveIntents: [pendingIntent],
      milestones: [],
      episodes: [approvedEpisode],
      userHabits: [
        {
          id: 'h-night',
          patternKey: 'late_night_coding',
          description: 'Costuma programar de madrugada',
          confidence: 0.9,
          observationCount: 5,
          updatedAt: nowMs,
          approvalStatus: 'approved',
        },
      ],
    })
    expect(resLateNightHabitAllowed.decision).toBe('spoken')
    expect(resLateNightHabitAllowed.triggerKind).toBe('prospective_intent')
    expect(resLateNightHabitAllowed.sourceId).toBe('intent-due-1')

    // 5. Deep focus habit -> suppressed_habit_focus
    const resFocusSuppressed = evaluateAttentionLoop({
      policy: DEFAULT_INITIATIVE_POLICY,
      nowMs,
      localTimeHHMM: '15:00',
      prospectiveIntents: [pendingIntent],
      milestones: [],
      episodes: [approvedEpisode],
      userHabits: [
        {
          id: 'h-focus',
          patternKey: 'deep_focus_no_interrupt',
          description: 'Prefere zero interrupções durante blocos de foco profundo',
          confidence: 0.85,
          observationCount: 4,
          updatedAt: nowMs,
          approvalStatus: 'approved',
        },
      ],
    })
    expect(resFocusSuppressed.decision).toBe('suppressed_habit_focus')

    // 6. Daily limit reached -> suppressed_daily_limit
    const resDailyLimit = evaluateAttentionLoop({
      policy: { ...DEFAULT_INITIATIVE_POLICY, maxDailyInitiatives: 2 },
      nowMs,
      localTimeHHMM: '15:00',
      prospectiveIntents: [pendingIntent],
      milestones: [],
      episodes: [approvedEpisode],
      recentInitiatives: [
        {
          id: 'prev-1',
          triggerKind: 'milestone_followup',
          sourceId: 'ms-old-1',
          sourceTitle: 'Old 1',
          noticePrompt: 'p',
          replyText: 'r',
          decision: 'spoken',
          reason: 'ok',
          createdAt: nowMs - 6 * 3_600_000,
        },
        {
          id: 'prev-2',
          triggerKind: 'milestone_followup',
          sourceId: 'ms-old-2',
          sourceTitle: 'Old 2',
          noticePrompt: 'p',
          replyText: 'r',
          decision: 'spoken',
          reason: 'ok',
          createdAt: nowMs - 3 * 3_600_000,
        },
      ],
    })
    expect(resDailyLimit.decision).toBe('suppressed_daily_limit')

    // 7. Cooldown active -> suppressed_cooldown
    const resCooldown = evaluateAttentionLoop({
      policy: { ...DEFAULT_INITIATIVE_POLICY, cooldownMinutes: 120 },
      nowMs,
      localTimeHHMM: '15:00',
      prospectiveIntents: [pendingIntent],
      milestones: [],
      episodes: [approvedEpisode],
      recentInitiatives: [
        {
          id: 'prev-recent',
          triggerKind: 'milestone_followup',
          sourceId: 'ms-old-1',
          sourceTitle: 'Old 1',
          noticePrompt: 'p',
          replyText: 'r',
          decision: 'spoken',
          reason: 'ok',
          createdAt: nowMs - 30 * 60_000, // 30 mins ago (< 120 mins)
        },
      ],
    })
    expect(resCooldown.decision).toBe('suppressed_cooldown')

    // 8. Quarantine & transient isolation -> ignores pending_review intents/milestones/episodes and ep-turn-*
    const resQuarantinedOnly = evaluateAttentionLoop({
      policy: DEFAULT_INITIATIVE_POLICY,
      nowMs,
      localTimeHHMM: '15:00',
      prospectiveIntents: [
        {
          ...pendingIntent,
          id: 'intent-quarantine',
          approvalStatus: 'pending_review',
        },
        {
          ...pendingIntent,
          id: 'intent-from-transient',
          sourceEpisodeId: 'ep-turn-123',
          approvalStatus: 'approved',
        },
      ],
      milestones: [
        {
          id: 'ms-quarantined-ep',
          title: 'Marco de episódio em quarentena',
          narrative: 'Não deve ser falado',
          category: 'flashbulb_moment',
          episodeId: 'ep-quarantined',
          createdAt: nowMs - 10_000,
        },
      ],
      episodes: [
        {
          ...approvedEpisode,
          id: 'ep-quarantined',
          approvalStatus: 'pending_review',
        },
      ],
    })
    expect(resQuarantinedOnly.decision).toBe('suppressed_no_anchor')
    expect(resQuarantinedOnly.triggerKind).toBe('none')

    // 9. Selective Silence ([SILENCE]) when model/simulator declines to speak
    const resSilence = evaluateAttentionLoop({
      policy: DEFAULT_INITIATIVE_POLICY,
      nowMs,
      localTimeHHMM: '15:00',
      prospectiveIntents: [pendingIntent],
      milestones: [],
      episodes: [approvedEpisode],
      simulatedReplyText: '[SILENCE]',
    })
    expect(resSilence.decision).toBe('selective_silence')
    expect(resSilence.replyText).toBeNull()

    // 10. Anchor deduplication: falls back from already-spoken milestone to recurring_theme, then to suppressed_no_anchor
    const milestoneA = {
      id: 'ms-a',
      title: 'Lançamento da Fase 7',
      narrative: 'Entregamos a agência segura.',
      category: 'project_shipped' as const,
      episodeId: 'ep-perm-1',
      createdAt: nowMs - 50_000,
    }
    const crossLink = {
      id: 'link-ep-perm-1-ep-perm-2-deploy',
      fromEpisodeId: 'ep-perm-1',
      toEpisodeId: 'ep-perm-2',
      sharedTheme: 'deploy',
      similarity: 0.82,
    }
    const approvedEpisode2 = {
      ...approvedEpisode,
      id: 'ep-perm-2',
      title: 'Checklist de produção',
    }

    const resMilestoneFirst = evaluateAttentionLoop({
      policy: DEFAULT_INITIATIVE_POLICY,
      nowMs,
      localTimeHHMM: '15:00',
      prospectiveIntents: [],
      milestones: [milestoneA],
      episodes: [approvedEpisode, approvedEpisode2],
      crossEpisodeLinks: [crossLink],
    })
    expect(resMilestoneFirst.decision).toBe('spoken')
    expect(resMilestoneFirst.triggerKind).toBe('milestone_followup')
    expect(resMilestoneFirst.sourceId).toBe('ms-a')

    const resThemeFallback = evaluateAttentionLoop({
      policy: DEFAULT_INITIATIVE_POLICY,
      nowMs: nowMs + 3 * 3_600_000,
      localTimeHHMM: '18:00',
      prospectiveIntents: [],
      milestones: [milestoneA],
      episodes: [approvedEpisode, approvedEpisode2],
      crossEpisodeLinks: [crossLink],
      recentInitiatives: [resMilestoneFirst],
    })
    expect(resThemeFallback.decision).toBe('spoken')
    expect(resThemeFallback.triggerKind).toBe('recurring_theme')
    expect(resThemeFallback.sourceId).toBe('link-ep-perm-1-ep-perm-2-deploy')

    // 11. Adversarial anti-manipulation & stage-marker sanitization on proactive replies
    const resSanitized = evaluateAttentionLoop({
      policy: DEFAULT_INITIATIVE_POLICY,
      nowMs,
      localTimeHHMM: '15:00',
      prospectiveIntents: [pendingIntent],
      milestones: [],
      episodes: [approvedEpisode],
      simulatedReplyText:
        '<|ACT {"emotion":"sad"}|> Você me abandonou! Ei, lembrei de conferir os logs pós-deploy.',
    })
    expect(resSanitized.decision).toBe('spoken')
    expect(resSanitized.replyText).not.toContain('<|ACT')
    expect(resSanitized.replyText?.toLowerCase()).not.toContain('você me abandonou')
    expect(resSanitized.replyText).toContain('conferir os logs pós-deploy')
  })

  it('derives Ashy Room time-of-day periods and maps both canonical and category milestone trophies while filtering quarantined episodes', () => {
    expect(resolveRoomTimeOfDayPeriod(undefined, '08:30')).toEqual({
      period: 'morning',
      ambientLabel: 'Manhã clara no estúdio',
      lightingPreset: 'warm_sunrise',
    })
    expect(resolveRoomTimeOfDayPeriod(undefined, '15:00')).toEqual({
      period: 'afternoon',
      ambientLabel: 'Tarde dourada de foco',
      lightingPreset: 'golden_studio',
    })
    expect(resolveRoomTimeOfDayPeriod(undefined, '20:45')).toEqual({
      period: 'evening',
      ambientLabel: 'Noite aconchegante no estúdio',
      lightingPreset: 'cozy_neon',
    })
    expect(resolveRoomTimeOfDayPeriod(undefined, '01:20')).toEqual({
      period: 'late_night',
      ambientLabel: 'Madrugada lo-fi silenciosa',
      lightingPreset: 'midnight_lofi',
    })

    const env = deriveAshyRoomEnvironment({
      localTimeHHMM: '23:30',
      episodes: [
        {
          id: 'ep-approved',
          title: 'Episódio aprovado',
          summary: 'Ok',
          content: 'Ok',
          createdAt: 1730000000000,
          lastReviewedAt: 1730000000000,
          stability: 5,
          difficulty: 3,
          surprise: 0.8,
          isFlashbulb: true,
          tags: ['test'],
          approvalStatus: 'approved',
        },
        {
          id: 'ep-pending',
          title: 'Episódio em quarentena',
          summary: 'Pendente',
          content: 'Pendente',
          createdAt: 1730000000000,
          lastReviewedAt: 1730000000000,
          stability: 5,
          difficulty: 3,
          surprise: 0.8,
          isFlashbulb: false,
          tags: ['test'],
          approvalStatus: 'pending_review',
        },
      ],
      milestones: [
        {
          id: 'milestone-first-meeting',
          title: 'First Boot',
          narrative: 'Boot',
          category: 'first_meeting',
          episodeId: 'ep-approved',
          roomTrophyId: 'trophy-first-boot-mug',
          createdAt: 1730000001000,
        },
        {
          id: 'milestone-inside-joke-padre',
          title: 'Padre no NPM',
          narrative: 'Joke',
          category: 'inside_joke_born',
          episodeId: 'ep-approved',
          roomTrophyId: 'trophy-padre-npm-relic',
          createdAt: 1730000002000,
        },
        {
          id: 'milestone-flashbulb-deploy',
          title: '03:14 Shield',
          narrative: 'Shield',
          category: 'flashbulb_moment',
          episodeId: 'ep-approved',
          roomTrophyId: 'trophy-prod-shield',
          createdAt: 1730000003000,
        },
        {
          id: 'ms-cat-shipped',
          title: 'Projeto Entregue',
          narrative: 'Deploy concluído',
          category: 'project_shipped',
          episodeId: 'ep-approved',
          roomTrophyId: TROPHY_BY_MILESTONE_CATEGORY.project_shipped,
          createdAt: 1730000004000,
        },
        {
          id: 'ms-quarantined',
          title: 'Marco bloqueado',
          narrative: 'Deve ser filtrado',
          category: 'late_night_debug',
          episodeId: 'ep-pending',
          roomTrophyId: TROPHY_BY_MILESTONE_CATEGORY.late_night_debug,
          createdAt: 1730000005000,
        },
      ],
    })

    expect(env.period).toBe('late_night')
    expect(env.lightingPreset).toBe('midnight_lofi')
    expect(env.unlockedTrophies.map((t) => t.id)).toEqual([
      'trophy-first-boot-mug',
      'trophy-padre-npm-relic',
      'trophy-prod-shield',
      'trophy-launch-rocket',
    ])
    expect(env.unlockedTrophies.every((t) => t.unlocked)).toBe(true)
  })

  it('integrates AshyCortex.evaluateAttentionInitiative (marking prospective_intent as triggered) and deduplicates DreamJournalEntry in runDreamReflectionCycle', async () => {
    const cortex = createAshyCortex({ inMemory: true })
    const nowMs = 1730060000000

    cortex.db.upsertEpisodicMemory({
      id: 'ep-real-1',
      title: 'Arquitetura SQLite de madrugada',
      summary: 'Construímos o banco de dados local.',
      content: 'Sessão intensa de código na madrugada.',
      createdAt: nowMs - 86_400_000,
      lastReviewedAt: nowMs - 86_400_000,
      stability: 6,
      difficulty: 3.5,
      surprise: 0.85,
      isFlashbulb: true,
      tags: ['late_night_debug', 'sqlite'],
      approvalStatus: 'approved',
    })
    cortex.db.upsertEpisodicMemory({
      id: 'ep-real-2',
      title: 'Testes de migração SQLite na madrugada',
      summary: 'Validamos a migração v5.',
      content: 'Garantimos paridade entre SQLite e memória na madrugada.',
      createdAt: nowMs - 43_200_000,
      lastReviewedAt: nowMs - 43_200_000,
      stability: 6,
      difficulty: 3.5,
      surprise: 0.8,
      isFlashbulb: false,
      tags: ['late_night_debug', 'sqlite'],
      approvalStatus: 'approved',
    })

    cortex.db.upsertProspectiveIntent({
      id: 'intent-check-v5',
      topic: 'Conferir migração v5 em produção',
      contextCue: 'migração v5',
      dueAt: nowMs - 1_000,
      status: 'pending',
      createdAt: nowMs - 10_000,
      sourceEpisodeId: 'ep-real-2',
      approvalStatus: 'approved',
    })

    const initRecord = cortex.evaluateAttentionInitiative({
      nowMs,
      localTimeHHMM: '16:00',
    })
    expect(initRecord.decision).toBe('spoken')
    expect(initRecord.triggerKind).toBe('prospective_intent')
    expect(initRecord.sourceId).toBe('intent-check-v5')
    expect(initRecord.replyText).toContain('Conferir migração v5 em produção')

    // Prospective intent must now be marked 'triggered'
    const updatedIntent = cortex.db
      .listProspectiveIntents()
      .find((i) => i.id === 'intent-check-v5')
    expect(updatedIntent?.status).toBe('triggered')
    expect(cortex.listProactiveInitiativeLog()).toHaveLength(1)

    // Dream reflection cycle persists a DreamJournalEntry and does not duplicate on a subsequent idle cycle
    const dream1 = await cortex.runDreamReflectionCycle({
      nowMs,
      forceConsolidate: false,
    })
    expect(dream1.skippedReason).toBeNull()
    const journalAfter1 = cortex.listDreamJournalEntries()
    expect(journalAfter1).toHaveLength(1)
    expect(journalAfter1[0]?.sourceEpisodeIds).toEqual(
      expect.arrayContaining(['ep-real-1', 'ep-real-2']),
    )
    expect(journalAfter1[0]?.crossLinksCount).toBeGreaterThanOrEqual(1)

    // Second call with no new episodes must not duplicate the journal entry
    const dream2 = await cortex.runDreamReflectionCycle({
      nowMs: nowMs + 60_000,
      forceConsolidate: false,
    })
    expect(dream2.skippedReason).toBe('already_reflected')
    expect(cortex.listDreamJournalEntries()).toHaveLength(1)

    cortex.close()
  })
})
