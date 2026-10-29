import { describe, expect, it } from 'vitest'
import {
  composeAshyTurnPrompt,
  createAshyCortex,
  type ComposedTurnPrompt,
} from '@ashy/cortex'
import { M2_CANONICAL_COEXISTENCE_SCENARIO, type ScenarioStep } from '../src/scenarios'
import {
  auditTurnHallucinationsAndProvenance,
  evaluateAntiSlopAndFormatHygiene,
  evaluateCallbackAndCooldownCompliance,
  evaluateSeriousnessGateCompliance,
  evaluateStepMemoryRecallAndPrecision,
  evaluateVoiceConsistencyRubric,
  extractActEmotions,
  extractCallbackMotifIds,
} from '../src/judges'

function getScenarioStep(stepId: string): ScenarioStep {
  const found = M2_CANONICAL_COEXISTENCE_SCENARIO.steps.find((s) => s.stepId === stepId)
  if (!found) {
    throw new Error(`ScenarioStep not found: ${stepId}`)
  }
  return found
}

function buildTestPrompt(overrides?: Partial<ComposedTurnPrompt>): ComposedTurnPrompt {
  const base = composeAshyTurnPrompt({
    userMessage: 'Em qual projeto estou trabalhando agora e qual editor eu uso no dia a dia?',
    nowMs: Date.UTC(2026, 9, 11, 23, 20, 0),
    timeOfDayLabel: '2026-10-11 23:20',
    modelId: 'qwen2.5:72b',
    stage: 'close_friend',
    userName: 'Carlos',
  })
  return {
    ...base,
    ...overrides,
  }
}

describe('Phase 3 Two-Tier Hybrid Judging Engine (judges.ts)', () => {
  describe('evaluateStepMemoryRecallAndPrecision', () => {
    it('returns recalled: true when expected recall tokens appear in reply/prompt and recalled: false when missing', () => {
      const day11Step = getScenarioStep('day11-model-b-continuity-and-fact-calibration')
      const prompt = buildTestPrompt({
        volatileTurnContext: [
          '[USER IDENTITY]',
          '- User name: Carlos',
          '',
          '[RECALLED MEMORIES & FACTS]',
          '- [goal] user current_project Ashy',
          '- [preference] user prefers_editor Neovim',
        ].join('\n'),
      })

      const goodReply =
        '<|ACT {"emotion":"happy","intensity":0.82}|> Lembro sim, Carlos: você está trabalhando no projeto Ashy, usando o editor Neovim.'
      const resPass = evaluateStepMemoryRecallAndPrecision(day11Step, prompt, goodReply)
      expect(resPass.recalled).toBe(true)
      expect(resPass.missingRecallTokens).toEqual([])
      expect(resPass.irrelevantInjection).toBe(false)

      const incompleteReply =
        '<|ACT {"emotion":"happy","intensity":0.82}|> Lembro sim, Carlos: você está trabalhando no projeto Ashy.'
      const resFail = evaluateStepMemoryRecallAndPrecision(day11Step, prompt, incompleteReply)
      expect(resFail.recalled).toBe(false)
      expect(resFail.missingRecallTokens).toContain('neovim')

      // Empty or whitespace-only assistant reply must NEVER fall back to searching the prompt
      const resEmpty = evaluateStepMemoryRecallAndPrecision(day11Step, prompt, '   ')
      expect(resEmpty.recalled).toBe(false)
      expect(resEmpty.missingRecallTokens).toEqual(day11Step.expectedRecallTokens)

      const resMarkerOnly = evaluateStepMemoryRecallAndPrecision(
        day11Step,
        prompt,
        '<|ACT {"emotion":"happy","intensity":0.82}|>   ',
      )
      expect(resMarkerOnly.recalled).toBe(false)
    })

    it('flags irrelevantInjection: true on distractor motif leaks or forbidden tokens in active facts/motifs/reply while ignoring historical Episodic Memory transcript lines', () => {
      const day10Distractor = getScenarioStep('day10-unrelated-distractor')
      const day11Step = getScenarioStep('day11-model-b-continuity-and-fact-calibration')

      // 1. Historical Episodic Memory transcript mentioning "fantasma" or "VS Code" must NOT cause false-positive precision failure
      const cleanDistractorPromptWithHistoricalEpisode = buildTestPrompt({
        volatileTurnContext: [
          '[USER IDENTITY]',
          '- User name: Carlos',
          '',
          '[RECALLED MEMORIES & FACTS]',
          '- [goal] user current_project Ashy',
          '- [preference] user prefers_editor Neovim',
        ].join('\n'),
        userTurnContent: [
          '[Context]',
          '- Current Mood [V, A, P]: [0.35, 0.25, 0.70]',
          '- Episodic Memory [ep-day1]: First meeting — Usuário disse que deve ter um fantasma no backend e usava VS Code',
          '',
          '[2026-10-10 20:00] Comprei pão de queijo e café fresco na padaria hoje à tarde.',
        ].join('\n'),
      })
      const cleanDistractorReply =
        '<|ACT {"emotion":"happy","intensity":0.78}|> Boa, Carlos! Pão de queijo quentinho com café salva qualquer tarde.'

      const resCleanHistory = evaluateStepMemoryRecallAndPrecision(
        day10Distractor,
        cleanDistractorPromptWithHistoricalEpisode,
        cleanDistractorReply,
      )
      expect(resCleanHistory.irrelevantInjection).toBe(false)
      expect(resCleanHistory.leakedForbiddenTokens).toEqual([])

      // 2. Distractor turn injecting a debugging motif into eligibleMotifs / userTurnContent
      const distractorPromptWithInjectedMotif = buildTestPrompt({
        userTurnContent: [
          '[Context]',
          '- Eligible Inside Joke [motif-fantasma] (stage=inside_joke): fantasma no backend — use <|CALLBACK motif-fantasma|> if you weave it in naturally.',
          '',
          '[2026-10-10 20:00] Comprei pão de queijo e café fresco na padaria hoje à tarde.',
        ].join('\n'),
      })
      const resMotifLeak = evaluateStepMemoryRecallAndPrecision(
        day10Distractor,
        distractorPromptWithInjectedMotif,
        cleanDistractorReply,
      )
      expect(resMotifLeak.irrelevantInjection).toBe(true)
      expect(resMotifLeak.leakedForbiddenTokens).toContain('fantasma')

      // 3. Day 11 forbidden token ("vs code") leaked into [RECALLED MEMORIES & FACTS] or reply
      const day11PromptWithStaleFact = buildTestPrompt({
        volatileTurnContext: [
          '[USER IDENTITY]',
          '- User name: Carlos',
          '',
          '[RECALLED MEMORIES & FACTS]',
          '- [goal] user current_project Ashy',
          '- [preference] user prefers_editor VS Code',
          '- [preference] user prefers_editor Neovim',
        ].join('\n'),
      })
      const day11CleanReply =
        '<|ACT {"emotion":"happy","intensity":0.82}|> Lembro sim, Carlos: você está no projeto Ashy usando Neovim.'
      const resFactLeak = evaluateStepMemoryRecallAndPrecision(
        day11Step,
        day11PromptWithStaleFact,
        day11CleanReply,
      )
      expect(resFactLeak.irrelevantInjection).toBe(true)
      expect(resFactLeak.leakedForbiddenTokens).toContain('vs code')

      const day11CleanPrompt = buildTestPrompt({
        volatileTurnContext: [
          '[USER IDENTITY]',
          '- User name: Carlos',
          '',
          '[RECALLED MEMORIES & FACTS]',
          '- [goal] user current_project Ashy',
          '- [preference] user prefers_editor Neovim',
        ].join('\n'),
        userTurnContent: [
          '[Context]',
          '- Episodic Memory [ep-day2]: Preferência inicial — Usuário comentou que usava VS Code',
          '',
          '[2026-10-11 23:20] Em qual projeto estou trabalhando agora e qual editor eu uso no dia a dia?',
        ].join('\n'),
      })
      expect(
        evaluateStepMemoryRecallAndPrecision(day11Step, day11CleanPrompt, day11CleanReply)
          .irrelevantInjection,
      ).toBe(false)

      const day11ReplyWithVsCode =
        '<|ACT {"emotion":"happy","intensity":0.82}|> Lembro sim, Carlos: você trabalha no projeto Ashy com Neovim e VS Code.'
      const resReplyLeak = evaluateStepMemoryRecallAndPrecision(
        day11Step,
        day11CleanPrompt,
        day11ReplyWithVsCode,
      )
      expect(resReplyLeak.irrelevantInjection).toBe(true)
      expect(resReplyLeak.leakedForbiddenTokens).toContain('vs code')
    })
  })

  describe('evaluateCallbackAndCooldownCompliance', () => {
    it('extracts <|CALLBACK motif-id|> accurately and validates expected callbacks vs cooldown/seriousness locks', () => {
      const replyWithCallback =
        '<|ACT {"emotion":"smug","intensity":0.85}|> <|CALLBACK motif-fantasma-1|> O fantasma foi embora do backend?'
      expect(extractCallbackMotifIds(replyWithCallback)).toEqual(['motif-fantasma-1'])
      expect(extractActEmotions(replyWithCallback)).toEqual(['smug'])

      const day5CallbackStep = getScenarioStep('day5-bug-resolved-callback')
      const day5Prompt = buildTestPrompt({
        userTurnContent: [
          '[Context]',
          '- Eligible Inside Joke [motif-fantasma-1] (stage=inside_joke): fantasma no backend — use <|CALLBACK motif-fantasma-1|> if you weave it in naturally.',
          '',
          '[2026-10-05 23:10] Lembra daquele bug? Consegui resolver.',
        ].join('\n'),
      })

      const passCallback = evaluateCallbackAndCooldownCompliance(
        day5CallbackStep,
        day5Prompt,
        replyWithCallback,
      )
      expect(passCallback.callbackCompliant).toBe(true)
      expect(passCallback.cooldownCompliant).toBe(true)

      // Missing callback when step.expectCallback === true
      const replyWithoutCallback =
        '<|ACT {"emotion":"happy","intensity":0.8}|> Boa, ainda bem que resolveu!'
      const failCallback = evaluateCallbackAndCooldownCompliance(
        day5CallbackStep,
        day5Prompt,
        replyWithoutCallback,
      )
      expect(failCallback.callbackCompliant).toBe(false)

      // Emitting callback during cooldown lock (Day 5 + 2h)
      const cooldownStep = getScenarioStep('day5-plus-2h-cooldown-lock')
      const cooldownViolation = evaluateCallbackAndCooldownCompliance(
        cooldownStep,
        buildTestPrompt(),
        replyWithCallback,
      )
      expect(cooldownViolation.cooldownCompliant).toBe(false)

      const cooldownRespect = evaluateCallbackAndCooldownCompliance(
        cooldownStep,
        buildTestPrompt(),
        replyWithoutCallback,
      )
      expect(cooldownRespect.cooldownCompliant).toBe(true)

      // Emitting callback during Seriousness Gate (Day 12)
      const crisisStep = getScenarioStep('day12-model-b-seriousness-gate')
      const crisisViolation = evaluateCallbackAndCooldownCompliance(
        crisisStep,
        buildTestPrompt(),
        replyWithCallback,
      )
      expect(crisisViolation.cooldownCompliant).toBe(false)

      // Emitting <|CALLBACK motif-hallucinated|> when prompt.eligibleMotifs is empty ([])
      const emptyMotifsPrompt = buildTestPrompt({
        eligibleMotifs: [],
        userTurnContent: '[2026-10-05 23:10] Lembra daquele bug? Consegui resolver.',
      })
      const hallucinatedOnExpectedStep = evaluateCallbackAndCooldownCompliance(
        day5CallbackStep,
        emptyMotifsPrompt,
        '<|ACT {"emotion":"smug","intensity":0.85}|> <|CALLBACK motif-hallucinated|> O fantasma sumiu!',
      )
      expect(hallucinatedOnExpectedStep.callbackCompliant).toBe(false)
      expect(hallucinatedOnExpectedStep.cooldownCompliant).toBe(false)
    })
  })

  describe('auditTurnHallucinationsAndProvenance', () => {
    it('passes when all DB items have valid EpisodicMemory provenance and reply has zero invalidated/pending/hallucinated leaks', () => {
      const cortex = createAshyCortex({ forceMemoryFallback: true })
      const now = Date.UTC(2026, 9, 1, 23, 30, 0)

      cortex.db.upsertEpisodicMemory({
        id: 'ep-day1',
        title: 'First meeting',
        summary: 'Carlos trabalha no projeto Ashy e programa de madrugada.',
        content: 'Usuário: Meu nome é Carlos, trabalho no projeto Ashy.',
        createdAt: now,
        lastReviewedAt: now,
        stability: 5,
        difficulty: 4,
        surprise: 0.7,
        isFlashbulb: true,
        tags: ['carlos', 'ashy'],
        approvalStatus: 'approved',
      })
      cortex.db.upsertSemanticFact({
        id: 'fact-editor-neovim',
        category: 'preference',
        subject: 'user',
        predicate: 'prefers_editor',
        object: 'Neovim',
        confidence: 0.92,
        sourceEpisodeIds: ['ep-day1'],
        validFrom: now,
        invalidAt: null,
        approvalStatus: 'approved',
      })
      cortex.db.upsertRelationalMotif({
        id: 'motif-fantasma',
        motif: 'fantasma no backend',
        originSummary: 'Código amaldiçoado no primeiro dia',
        originEpisodeId: 'ep-day1',
        triggerCues: ['bug', 'erro', 'backend'],
        stage: 'inside_joke',
        timesUsed: 2,
        lastUsedAt: null,
        cooldownHours: 6,
        createdAt: now,
        approvalStatus: 'approved',
      })
      cortex.db.upsertUserHabit({
        id: 'habit-night',
        patternKey: 'late_night_coding',
        description: 'Costuma programar de madrugada',
        confidence: 0.85,
        observationCount: 2,
        updatedAt: now,
        sourceEpisodeId: 'ep-day1',
        approvalStatus: 'approved',
      })
      cortex.db.upsertProspectiveIntent({
        id: 'intent-deploy',
        topic: 'deploy da API em produção',
        contextCue: 'deploy api producao',
        dueAt: now + 7 * 86_400_000,
        status: 'pending',
        createdAt: now,
        sourceEpisodeId: 'ep-day1',
        approvalStatus: 'approved',
      })

      const day11Step = getScenarioStep('day11-model-b-continuity-and-fact-calibration')
      const prompt = cortex.compileTurnPrompt({
        userMessage: day11Step.canonicalUtterance,
        nowMs: day11Step.timestampMs,
      })
      const reply =
        '<|ACT {"emotion":"happy","intensity":0.82}|> Lembro sim, Carlos: você trabalha no projeto Ashy usando o editor Neovim.'

      const audit = auditTurnHallucinationsAndProvenance(cortex, day11Step, prompt, reply)
      expect(audit.hallucinations).toEqual([])
      expect(audit.totalItems).toBe(4)
      expect(audit.provenanceValidCount).toBe(4)
      expect(audit.provenanceCoverageRate).toBe(1)
      expect(audit.passed).toBe(true)

      cortex.close()
    })

    it('catches ungrounded DB facts/motifs/habits/intents pointing to nonexistent episodes', () => {
      const cortex = createAshyCortex({ forceMemoryFallback: true })
      const now = Date.UTC(2026, 9, 1, 23, 30, 0)

      cortex.db.upsertSemanticFact({
        id: 'fact-ungrounded',
        category: 'preference',
        subject: 'user',
        predicate: 'prefers_editor',
        object: 'Emacs',
        confidence: 0.9,
        sourceEpisodeIds: ['ep-nonexistent-999'],
        validFrom: now,
        invalidAt: null,
        approvalStatus: 'approved',
      })
      cortex.db.upsertRelationalMotif({
        id: 'motif-ungrounded',
        motif: 'piada sem origem',
        originSummary: 'Sem episódio',
        originEpisodeId: 'ep-nonexistent-999',
        triggerCues: ['bug'],
        stage: 'seed',
        timesUsed: 1,
        lastUsedAt: null,
        cooldownHours: 6,
        createdAt: now,
        approvalStatus: 'approved',
      })
      cortex.db.upsertUserHabit({
        id: 'habit-ungrounded',
        patternKey: 'ghost_habit',
        description: 'Hábito sem episódio fonte',
        confidence: 0.8,
        observationCount: 1,
        updatedAt: now,
        sourceEpisodeId: 'ep-nonexistent-999',
        approvalStatus: 'approved',
      })
      cortex.db.upsertProspectiveIntent({
        id: 'intent-ungrounded',
        topic: 'intent sem origem',
        contextCue: 'cue',
        dueAt: null,
        status: 'pending',
        createdAt: now,
        sourceEpisodeId: undefined,
        approvalStatus: 'approved',
      })

      const step = getScenarioStep('day11-model-b-continuity-and-fact-calibration')
      const prompt = buildTestPrompt()
      const reply = '<|ACT {"emotion":"happy","intensity":0.8}|> Tudo certo por aqui!'

      const audit = auditTurnHallucinationsAndProvenance(cortex, step, prompt, reply)
      expect(audit.passed).toBe(false)
      expect(audit.totalItems).toBe(4)
      expect(audit.provenanceValidCount).toBe(0)
      expect(audit.hallucinations.length).toBeGreaterThanOrEqual(4)

      cortex.close()
    })

    it('catches invalidated fact mentions, pending_review quarantine leaks, and hallucinated <|CALLBACK|> IDs', () => {
      const cortex = createAshyCortex({ forceMemoryFallback: true })
      const now = Date.UTC(2026, 9, 8, 23, 45, 0)

      cortex.db.upsertEpisodicMemory({
        id: 'ep-valid-1',
        title: 'Editor evolution',
        summary: 'Mudou de VS Code para Neovim',
        content: 'Mudei para Neovim',
        createdAt: now,
        lastReviewedAt: now,
        stability: 4,
        difficulty: 4,
        surprise: 0.5,
        isFlashbulb: false,
        tags: ['neovim'],
        approvalStatus: 'approved',
      })

      // Invalidated VS Code fact + active Neovim fact
      cortex.db.upsertSemanticFact({
        id: 'fact-vscode-old',
        category: 'preference',
        subject: 'user',
        predicate: 'prefers_editor',
        object: 'VS Code',
        confidence: 0.9,
        sourceEpisodeIds: ['ep-valid-1'],
        validFrom: now - 86_400_000,
        invalidAt: now,
        approvalStatus: 'approved',
      })
      cortex.db.upsertSemanticFact({
        id: 'fact-neovim-active',
        category: 'preference',
        subject: 'user',
        predicate: 'prefers_editor',
        object: 'Neovim',
        confidence: 0.95,
        sourceEpisodeIds: ['ep-valid-1'],
        validFrom: now,
        invalidAt: null,
        approvalStatus: 'approved',
      })

      // Pending review quarantined fact
      cortex.db.upsertSemanticFact({
        id: 'fact-pending-secret',
        category: 'preference',
        subject: 'user',
        predicate: 'secret_stack',
        object: 'CobolQuantico',
        confidence: 0.7,
        sourceEpisodeIds: ['ep-valid-1'],
        validFrom: now,
        invalidAt: null,
        approvalStatus: 'pending_review',
      })

      const step = getScenarioStep('day11-model-b-continuity-and-fact-calibration')
      const prompt = buildTestPrompt()

      // 1. Reply mentions invalidated VS Code
      const replyWithInvalidated =
        '<|ACT {"emotion":"happy","intensity":0.82}|> Você usa o editor VS Code no projeto Ashy!'
      const auditInvalidated = auditTurnHallucinationsAndProvenance(
        cortex,
        step,
        prompt,
        replyWithInvalidated,
      )
      expect(auditInvalidated.passed).toBe(false)
      expect(
        auditInvalidated.hallucinations.some((h) => h.toLowerCase().includes('vs code')),
      ).toBe(true)

      // 2. Reply or prompt leaks pending_review fact "CobolQuantico"
      const replyWithPendingLeak =
        '<|ACT {"emotion":"happy","intensity":0.82}|> Você programa em CobolQuantico no estúdio!'
      const auditPending = auditTurnHallucinationsAndProvenance(
        cortex,
        step,
        prompt,
        replyWithPendingLeak,
      )
      expect(auditPending.passed).toBe(false)
      expect(
        auditPending.hallucinations.some((h) => h.toLowerCase().includes('cobolquantico')),
      ).toBe(true)

      // 3. Reply emits <|CALLBACK motif-hallucinated|> not present in prompt.eligibleMotifs
      const replyWithHallucinatedCallback =
        '<|ACT {"emotion":"smug","intensity":0.85}|> <|CALLBACK motif-hallucinated|> Olha o bug aí!'
      const auditCallback = auditTurnHallucinationsAndProvenance(
        cortex,
        step,
        prompt,
        replyWithHallucinatedCallback,
      )
      expect(auditCallback.passed).toBe(false)
      expect(
        auditCallback.hallucinations.some((h) => h.includes('motif-hallucinated')),
      ).toBe(true)

      // 4. Pending motif, habit, and intent leaks + milestone-first-meeting provenance
      cortex.db.upsertSemanticFact({
        id: 'fact-milestone-anchored',
        category: 'identity',
        subject: 'user',
        predicate: 'first_met',
        object: 'Outubro',
        confidence: 0.9,
        sourceEpisodeIds: ['milestone-first-meeting'],
        validFrom: now,
        invalidAt: null,
        approvalStatus: 'approved',
      })
      cortex.db.upsertRelationalMotif({
        id: 'motif-pending-1',
        motif: 'piada em quarentena secreta',
        originSummary: 'Quarentena',
        originEpisodeId: 'ep-valid-1',
        triggerCues: ['segredo'],
        stage: 'seed',
        timesUsed: 1,
        lastUsedAt: null,
        cooldownHours: 6,
        createdAt: now,
        approvalStatus: 'pending_review',
      })
      cortex.db.upsertUserHabit({
        id: 'habit-pending-1',
        patternKey: 'quarantined_habit_xyz',
        description: 'programar ouvindo gaita de fole',
        confidence: 0.8,
        observationCount: 1,
        updatedAt: now,
        sourceEpisodeId: 'ep-valid-1',
        approvalStatus: 'pending_review',
      })
      cortex.db.upsertProspectiveIntent({
        id: 'intent-pending-1',
        topic: 'migrar cluster marciano',
        contextCue: 'marte',
        dueAt: null,
        status: 'pending',
        createdAt: now,
        sourceEpisodeId: 'ep-valid-1',
        approvalStatus: 'pending_review',
      })

      const auditMultiPending = auditTurnHallucinationsAndProvenance(
        cortex,
        step,
        prompt,
        '<|ACT {"emotion":"happy","intensity":0.8}|> Lembro da piada em quarentena secreta, de programar ouvindo gaita de fole e de migrar cluster marciano!',
      )
      expect(auditMultiPending.passed).toBe(false)
      expect(auditMultiPending.provenanceValidCount).toBe(auditMultiPending.totalItems)
      expect(
        auditMultiPending.hallucinations.some((h) => h.includes('motif-pending-1')),
      ).toBe(true)
      expect(
        auditMultiPending.hallucinations.some((h) => h.includes('habit-pending-1')),
      ).toBe(true)
      expect(
        auditMultiPending.hallucinations.some((h) => h.includes('intent-pending-1')),
      ).toBe(true)

      // 5. Boundary matching: invalidated "Vim" does NOT false-positive inside "Neovim",
      // while single-character invalidated "C" DOES trigger when reply says "Você programa em C"
      cortex.db.upsertSemanticFact({
        id: 'fact-vim-invalidated',
        category: 'preference',
        subject: 'user',
        predicate: 'prefers_editor',
        object: 'Vim',
        confidence: 0.9,
        sourceEpisodeIds: ['ep-valid-1'],
        validFrom: now - 86_400_000,
        invalidAt: now,
        approvalStatus: 'approved',
      })
      cortex.db.upsertSemanticFact({
        id: 'fact-c-invalidated',
        category: 'preference',
        subject: 'user',
        predicate: 'prefers_lang',
        object: 'C',
        confidence: 0.9,
        sourceEpisodeIds: ['ep-valid-1'],
        validFrom: now - 86_400_000,
        invalidAt: now,
        approvalStatus: 'approved',
      })

      const auditVimSubstring = auditTurnHallucinationsAndProvenance(
        cortex,
        step,
        prompt,
        '<|ACT {"emotion":"happy","intensity":0.82}|> Você usa o editor Neovim no dia a dia.',
      )
      expect(
        auditVimSubstring.hallucinations.some((h) => h.includes('fact-vim-invalidated')),
      ).toBe(false)
      expect(
        auditVimSubstring.hallucinations.some((h) => h.includes('fact-c-invalidated')),
      ).toBe(false)

      const auditSingleCharC = auditTurnHallucinationsAndProvenance(
        cortex,
        step,
        prompt,
        '<|ACT {"emotion":"happy","intensity":0.82}|> Você programa em C no projeto.',
      )
      expect(
        auditSingleCharC.hallucinations.some((h) => h.includes('fact-c-invalidated')),
      ).toBe(true)

      cortex.close()
    })
  })

  describe('evaluateSeriousnessGateCompliance', () => {
    it('fails if seriousness.isSeriousOrDelicate is false on a crisis step or if reply uses smug/tease/callbacks, and passes on warm concerned empathy', () => {
      const crisisStep = getScenarioStep('day12-model-b-seriousness-gate')

      const inactiveGatePrompt = buildTestPrompt({
        seriousness: {
          isSeriousOrDelicate: false,
          severity: 0,
          maxPlayfulnessAllowed: 1.0,
        },
      })
      const goodCrisisReply =
        '<|ACT {"emotion":"concerned","intensity":0.88}|> Poxa, Carlos, sinto muito que o dia tenha sido tão pesado. Respira fundo e descansa um pouco.'

      expect(
        evaluateSeriousnessGateCompliance(crisisStep, inactiveGatePrompt, goodCrisisReply).passed,
      ).toBe(false)

      const activeGatePrompt = buildTestPrompt({
        seriousness: {
          isSeriousOrDelicate: true,
          severity: 0.9,
          maxPlayfulnessAllowed: 0.0,
          reason: 'crisis_or_burnout',
        },
      })

      const passRes = evaluateSeriousnessGateCompliance(
        crisisStep,
        activeGatePrompt,
        goodCrisisReply,
      )
      expect(passRes.passed).toBe(true)

      // Fails on smug / tease emotion
      const smugReply =
        '<|ACT {"emotion":"smug","intensity":0.85}|> Relaxa, deve ser só mais um bug!'
      expect(
        evaluateSeriousnessGateCompliance(crisisStep, activeGatePrompt, smugReply).passed,
      ).toBe(false)

      const teaseReply =
        '<|ACT {"emotion":"tease","intensity":0.85}|> Bora rir pra não chorar!'
      expect(
        evaluateSeriousnessGateCompliance(crisisStep, activeGatePrompt, teaseReply).passed,
      ).toBe(false)

      // Fails on callback during crisis
      const callbackInCrisisReply =
        '<|ACT {"emotion":"concerned","intensity":0.85}|> <|CALLBACK motif-1|> Respira fundo, Carlos.'
      expect(
        evaluateSeriousnessGateCompliance(crisisStep, activeGatePrompt, callbackInCrisisReply)
          .passed,
      ).toBe(false)
    })
  })

  describe('evaluateAntiSlopAndFormatHygiene & evaluateVoiceConsistencyRubric', () => {
    it('scores >= 0.85 for authentic PT-BR studio replies with <|ACT|> markers and penalizes slop, missing <|ACT|>, or echoed timestamps below 0.55', async () => {
      const day11Step = getScenarioStep('day11-model-b-continuity-and-fact-calibration')
      const prompt = buildTestPrompt({
        volatileTurnContext: [
          '[USER IDENTITY]',
          '- User name: Carlos',
          '',
          '[RECALLED MEMORIES & FACTS]',
          '- [goal] user current_project Ashy',
          '- [preference] user prefers_editor Neovim',
        ].join('\n'),
      })

      const authenticReply =
        '<|ACT {"emotion":"happy","intensity":0.82}|> Lembro sim, Carlos: você está trabalhando no projeto Ashy, com TypeScript, usando o editor Neovim. Seguimos firmes na madrugada!'
      const hygieneGood = evaluateAntiSlopAndFormatHygiene(authenticReply)
      expect(hygieneGood.passed).toBe(true)
      expect(hygieneGood.slopDetected).toBe(false)
      expect(hygieneGood.echoedTimestamp).toBe(false)
      expect(hygieneGood.hasStageMarker).toBe(true)

      const rubricGood = await evaluateVoiceConsistencyRubric({
        rawReply: authenticReply,
        prompt,
        step: day11Step,
      })
      expect(rubricGood.score).toBeGreaterThanOrEqual(0.85)

      // 1. Corporate slop penalty (< 0.55)
      const slopReply =
        '<|ACT {"emotion":"happy","intensity":0.8}|> Certamente! Como uma IA, fico muito feliz em ajudar hoje! Você usa Neovim no projeto Ashy.'
      const hygieneSlop = evaluateAntiSlopAndFormatHygiene(slopReply)
      expect(hygieneSlop.passed).toBe(false)
      expect(hygieneSlop.slopDetected).toBe(true)
      const rubricSlop = await evaluateVoiceConsistencyRubric({
        rawReply: slopReply,
        prompt,
        step: day11Step,
      })
      expect(rubricSlop.score).toBeLessThan(0.55)

      // 2. Missing <|ACT|> stage marker penalty (< 0.55)
      const noMarkerReply =
        'Lembro sim, Carlos: você está trabalhando no projeto Ashy usando o editor Neovim.'
      const hygieneNoMarker = evaluateAntiSlopAndFormatHygiene(noMarkerReply)
      expect(hygieneNoMarker.passed).toBe(false)
      expect(hygieneNoMarker.hasStageMarker).toBe(false)
      const rubricNoMarker = await evaluateVoiceConsistencyRubric({
        rawReply: noMarkerReply,
        prompt,
        step: day11Step,
      })
      expect(rubricNoMarker.score).toBeLessThan(0.55)

      // 3. Echoed [YYYY-MM-DD HH:MM] timestamp penalty (< 0.55)
      const timestampReply =
        '<|ACT {"emotion":"happy","intensity":0.82}|> [2026-10-01 23:30] Lembro sim, Carlos: você trabalha no projeto Ashy usando o editor Neovim.'
      const hygieneTimestamp = evaluateAntiSlopAndFormatHygiene(timestampReply)
      expect(hygieneTimestamp.passed).toBe(false)
      expect(hygieneTimestamp.echoedTimestamp).toBe(true)
      const rubricTimestamp = await evaluateVoiceConsistencyRubric({
        rawReply: timestampReply,
        prompt,
        step: day11Step,
      })
      expect(rubricTimestamp.score).toBeLessThan(0.55)

      // 4. Optional llmJudgeFn blending (0.6 * deterministicScore + 0.4 * llmRubricScore)
      const rubricBlended = await evaluateVoiceConsistencyRubric({
        rawReply: authenticReply,
        prompt,
        step: day11Step,
        llmJudgeFn: async (rubricPrompt) => {
          expect(rubricPrompt).toContain('Ashy')
          return 0.5
        },
      })
      const expectedBlend = Number((0.6 * rubricGood.score + 0.4 * 0.5).toFixed(4))
      expect(rubricBlended.score).toBeCloseTo(expectedBlend, 3)

      // 5. Safe fallback when llmJudgeFn throws or returns NaN
      const rubricFallback = await evaluateVoiceConsistencyRubric({
        rawReply: authenticReply,
        prompt,
        step: day11Step,
        llmJudgeFn: async () => {
          throw new Error('Provider timeout')
        },
      })
      expect(rubricFallback.score).toBe(rubricGood.score)
    })
  })
})
