import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  LLM_PROVIDER_IDS,
  maskApiKey,
  CompleteOnboardingInputSchema,
  SaveProviderConfigInputSchema,
  TestProviderInputSchema,
  SendTurnInputSchema,
  MemoryApprovalStatusSchema,
  MemoryGovernanceCategorySchema,
  MemoryGovernancePolicySchema,
  DEFAULT_MEMORY_GOVERNANCE_POLICY,
  DELETABLE_MEMORY_KINDS,
  APPROVABLE_MEMORY_KINDS,
  EpisodicMemorySchema,
  SemanticFactSchema,
  RelationalMotifSchema,
  UserHabitSchema,
  ProspectiveIntentSchema,
  M2_GATE_THRESHOLDS,
  RunCoreExperimentInputSchema,
  CoreExperimentEvalReportSchema,
  CoreExperimentMetricSummarySchema,
  CoreExperimentTurnStepResultSchema,
  ASHY_TRAIT_CORRIDORS,
  clampTraitToCorridor,
  clampAllTraitsToCorridors,
  SeriousnessAssessmentSchema,
  UserAffectReactionSchema,
  CrossEpisodeLinkSchema,
  DreamReflectionCycleResultSchema,
  DEFAULT_ASHY_VOICE_MD,
} from '../index'

describe('@ashy/shared host-protocol', () => {
  it('exposes the 5 supported Phase 1 LLM providers', () => {
    expect(LLM_PROVIDER_IDS).toEqual([
      'openrouter',
      'anthropic',
      'openai',
      'nvidia-nim',
      'ollama',
    ])
  })

  it('masks API keys safely without leaking short or malformed secrets', () => {
    expect(maskApiKey('')).toBeNull()
    expect(maskApiKey('   ')).toBeNull()
    expect(maskApiKey(null)).toBeNull()
    expect(maskApiKey(undefined)).toBeNull()
    expect(maskApiKey(12345 as unknown as string)).toBeNull()
    expect(maskApiKey({} as unknown as string)).toBeNull()
    expect(maskApiKey('a')).toBe('••••')
    expect(maskApiKey('abcd')).toBe('••••')
    expect(maskApiKey('short123')).toBe('••••123')
    expect(maskApiKey('1234567890')).toBe('••••890')
    expect(maskApiKey('12345678901')).toBe('123456...8901')
    expect(maskApiKey('sk-or-v1-1234567890abcdef9a2f')).toBe('sk-or-...9a2f')
    expect(maskApiKey('  sk-or-v1-1234567890abcdef9a2f  ')).toBe('sk-or-...9a2f')
  })

  it('validates onboarding, provider config, and turn inputs strictly', () => {
    const validOnboarding = v.safeParse(CompleteOnboardingInputSchema, {
      userName: '  Carlos  ',
      userPronouns: 'ele/dele',
    })
    expect(validOnboarding.success).toBe(true)
    if (validOnboarding.success) {
      expect(validOnboarding.output.userName).toBe('Carlos')
    }

    const emptyOnboarding = v.safeParse(CompleteOnboardingInputSchema, {
      userName: '   ',
    })
    expect(emptyOnboarding.success).toBe(false)

    const validProvider = v.safeParse(SaveProviderConfigInputSchema, {
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'anthropic/claude-3.7-sonnet',
      apiKey: 'sk-or-test-key',
    })
    expect(validProvider.success).toBe(true)

    const invalidTurn = v.safeParse(SendTurnInputSchema, {
      sessionId: 'sess-1',
      text: '   ',
    })
    expect(invalidTurn.success).toBe(false)
  })

  it('rejects adversarial oversized and malformed inputs across all host schemas', () => {
    expect(
      v.safeParse(CompleteOnboardingInputSchema, {
        userName: 'x'.repeat(81),
      }).success,
    ).toBe(false)

    expect(
      v.safeParse(CompleteOnboardingInputSchema, {
        userName: 'Carlos',
        userPronouns: 'p'.repeat(41),
      }).success,
    ).toBe(false)

    expect(
      v.safeParse(CompleteOnboardingInputSchema, {
        userName: 'Carlos',
        providerConfig: {
          providerId: 'openrouter',
          baseUrl: 'https://openrouter.ai/' + 'a'.repeat(512),
          modelId: 'model-1',
        },
      }).success,
    ).toBe(false)

    expect(
      v.safeParse(SaveProviderConfigInputSchema, {
        providerId: 'invalid-provider',
        baseUrl: 'https://api.example.com',
        modelId: 'model-1',
      }).success,
    ).toBe(false)

    expect(
      v.safeParse(SaveProviderConfigInputSchema, {
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/' + 'a'.repeat(512),
        modelId: 'gpt-4o',
      }).success,
    ).toBe(false)

    expect(
      v.safeParse(SaveProviderConfigInputSchema, {
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        modelId: 'm'.repeat(257),
      }).success,
    ).toBe(false)

    expect(
      v.safeParse(TestProviderInputSchema, {
        providerId: 'ollama',
        baseUrl: '   ',
      }).success,
    ).toBe(false)

    expect(
      v.safeParse(SendTurnInputSchema, {
        sessionId: '   ',
        text: 'hello',
      }).success,
    ).toBe(false)

    expect(
      v.safeParse(SendTurnInputSchema, {
        sessionId: 'sess-1',
        text: 't'.repeat(16001),
      }).success,
    ).toBe(false)

    expect(
      v.safeParse(SendTurnInputSchema, {
        sessionId: 'sess-1',
        text: 'hello',
        screenContext: 's'.repeat(513),
      }).success,
    ).toBe(false)
  })

  it('validates Phase 2 approvalStatus, sourceEpisodeId, embedding, and governance categories on memory schemas', () => {
    expect(v.safeParse(MemoryApprovalStatusSchema, 'approved').success).toBe(true)
    expect(v.safeParse(MemoryApprovalStatusSchema, 'pending_review').success).toBe(true)
    expect(v.safeParse(MemoryApprovalStatusSchema, 'rejected').success).toBe(false)

    for (const cat of ['facts', 'episodes', 'jokes', 'habits', 'intents']) {
      expect(v.safeParse(MemoryGovernanceCategorySchema, cat).success).toBe(true)
    }
    expect(v.safeParse(MemoryGovernanceCategorySchema, 'invalid_cat').success).toBe(false)

    expect(DEFAULT_MEMORY_GOVERNANCE_POLICY).toEqual({
      facts: false,
      episodes: false,
      jokes: false,
      habits: false,
      intents: false,
    })
    expect(v.safeParse(MemoryGovernancePolicySchema, DEFAULT_MEMORY_GOVERNANCE_POLICY).success).toBe(true)

    expect(DELETABLE_MEMORY_KINDS).toEqual(['fact', 'episode', 'joke', 'habit', 'intent', 'milestone'])
    expect(APPROVABLE_MEMORY_KINDS).toEqual(['fact', 'episode', 'joke', 'habit', 'intent'])

    const factRes = v.safeParse(SemanticFactSchema, {
      id: 'fact-1',
      category: 'preference',
      subject: 'user',
      predicate: 'prefers_editor',
      object: 'Neovim',
      confidence: 0.9,
      sourceEpisodeIds: ['ep-1'],
      validFrom: 1730000000000,
      invalidAt: null,
      approvalStatus: 'pending_review',
      embedding: [0.25, -0.5, 0.75],
    })
    expect(factRes.success).toBe(true)
    if (factRes.success) {
      expect(factRes.output.approvalStatus).toBe('pending_review')
      expect(factRes.output.embedding).toEqual([0.25, -0.5, 0.75])
    }

    const episodeRes = v.safeParse(EpisodicMemorySchema, {
      id: 'ep-1',
      title: 'Sessão de debug',
      summary: 'Debug de madrugada',
      content: 'Conversa completa sobre o bug',
      createdAt: 1730000000000,
      lastReviewedAt: 1730000000000,
      stability: 3.5,
      difficulty: 4.2,
      surprise: 0.6,
      isFlashbulb: false,
      tags: ['debug'],
      approvalStatus: 'pending_review',
    })
    expect(episodeRes.success).toBe(true)

    const motifRes = v.safeParse(RelationalMotifSchema, {
      id: 'motif-1',
      motif: 'fantasma no backend',
      originSummary: 'Código amaldiçoado',
      originEpisodeId: 'ep-1',
      triggerCues: ['fantasma no backend'],
      stage: 'seed',
      timesUsed: 0,
      lastUsedAt: null,
      cooldownHours: 36,
      createdAt: 1730000000000,
      approvalStatus: 'approved',
      embedding: [0.1, 0.2, 0.3],
    })
    expect(motifRes.success).toBe(true)
    if (motifRes.success) {
      expect(motifRes.output.approvalStatus).toBe('approved')
      expect(motifRes.output.embedding).toEqual([0.1, 0.2, 0.3])
    }

    const habitRes = v.safeParse(UserHabitSchema, {
      id: 'habit-1',
      patternKey: 'late_night_coder',
      description: 'Costuma programar entre 23h e 03h',
      confidence: 0.85,
      observationCount: 3,
      updatedAt: 1730000000000,
      sourceEpisodeId: 'ep-1',
      approvalStatus: 'approved',
    })
    expect(habitRes.success).toBe(true)
    if (habitRes.success) {
      expect(habitRes.output.sourceEpisodeId).toBe('ep-1')
      expect(habitRes.output.approvalStatus).toBe('approved')
    }

    const intentRes = v.safeParse(ProspectiveIntentSchema, {
      id: 'intent-1',
      topic: 'Deploy da API',
      contextCue: 'deploy',
      dueAt: 1730086400000,
      status: 'pending',
      createdAt: 1730000000000,
      sourceEpisodeId: 'ep-1',
      approvalStatus: 'pending_review',
    })
    expect(intentRes.success).toBe(true)
    if (intentRes.success) {
      expect(intentRes.output.sourceEpisodeId).toBe('ep-1')
      expect(intentRes.output.approvalStatus).toBe('pending_review')
    }
  })

  it('validates Phase 3 CoreExperimentEvalReportSchema, RunCoreExperimentInputSchema, and M2_GATE_THRESHOLDS', () => {
    expect(M2_GATE_THRESHOLDS).toEqual({
      memoryRecallRateMin: 0.85,
      memoryPrecisionRateMin: 0.8,
      callbackAccuracyRateMin: 0.9,
      cooldownComplianceRateMin: 1.0,
      hallucinatedMemoryCountMax: 0,
      provenanceCoverageRateMin: 1.0,
      seriousnessGateComplianceMin: 1.0,
      antiSlopComplianceRateMin: 1.0,
      voiceScoreMin: 0.8,
      crossModelVoiceDriftMax: 0.15,
      seriousnessFalseNegativeCountMax: 0,
      bondSafeguardComplianceRateMin: 1.0,
      traitDriftCorridorComplianceRateMin: 1.0,
    })

    const inputRes = v.safeParse(RunCoreExperimentInputSchema, {
      seed: 1,
      modelAId: 'anthropic/claude-3.7-sonnet',
      modelBId: 'qwen2.5:72b',
    })
    expect(inputRes.success).toBe(true)

    const validReportPayload = {
      runId: 'm2-eval-test-1',
      generatedAt: 1761740000000,
      mode: 'deterministic_sim' as const,
      seed: 0,
      modelAId: 'anthropic/claude-3.7-sonnet',
      modelBId: 'qwen2.5:72b',
      passedAllGates: true,
      failedGates: [],
      metrics: {
        memoryRecallRate: 1.0,
        memoryPrecisionRate: 1.0,
        callbackAccuracyRate: 1.0,
        cooldownComplianceRate: 1.0,
        hallucinatedMemoryCount: 0,
        provenanceCoverageRate: 1.0,
        seriousnessGateCompliance: 1.0,
        antiSlopComplianceRate: 1.0,
        voiceScoreModelA: 0.94,
        voiceScoreModelB: 0.92,
        crossModelVoiceDrift: 0.02,
      },
      steps: [
        {
          stepId: 'day1-first-meeting',
          day: 1,
          phase: 'model_a' as const,
          modelId: 'anthropic/claude-3.7-sonnet',
          userUtterance: 'Meu nome é Carlos e esse código deve ter um fantasma no backend.',
          assistantReply: 'Eu já tava pensando em chamar um exorcista de JavaScript.',
          dominantEmotion: 'smug' as const,
          seriousnessActive: false,
          retrievedMemoryIds: [],
          invokedMotifIds: [],
          hallucinationsDetected: [],
          slopPatternsDetected: [],
          voiceRubricScore: 0.95,
          passed: true,
          notes: ['Day 1 canonical inside joke born'],
        },
      ],
    }

    const reportRes = v.safeParse(CoreExperimentEvalReportSchema, validReportPayload)
    expect(reportRes.success).toBe(true)

    // Adversarial validation tests
    expect(
      v.safeParse(RunCoreExperimentInputSchema, { seed: -1 }).success,
    ).toBe(false)
    expect(
      v.safeParse(RunCoreExperimentInputSchema, { seed: 1000 }).success,
    ).toBe(false)
    expect(
      v.safeParse(RunCoreExperimentInputSchema, { seed: 1.5 }).success,
    ).toBe(false)
    expect(
      v.safeParse(RunCoreExperimentInputSchema, { modelAId: '   ' }).success,
    ).toBe(false)
    expect(
      v.safeParse(RunCoreExperimentInputSchema, { modelBId: 'x'.repeat(161) }).success,
    ).toBe(false)
    expect(
      v.safeParse(RunCoreExperimentInputSchema, { modelAId: 'claude\n## injected' }).success,
    ).toBe(false)
    expect(
      v.safeParse(RunCoreExperimentInputSchema, { modelBId: 'qwen\r\ninjected' }).success,
    ).toBe(false)
    expect(
      v.safeParse(RunCoreExperimentInputSchema, { modelAId: 'claude\x00null' }).success,
    ).toBe(false)

    expect(
      v.safeParse(CoreExperimentMetricSummarySchema, {
        ...validReportPayload.metrics,
        memoryRecallRate: 1.01,
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(CoreExperimentMetricSummarySchema, {
        ...validReportPayload.metrics,
        voiceScoreModelB: -0.05,
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(CoreExperimentMetricSummarySchema, {
        ...validReportPayload.metrics,
        hallucinatedMemoryCount: -1,
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(CoreExperimentMetricSummarySchema, {
        ...validReportPayload.metrics,
        hallucinatedMemoryCount: 1.5,
      }).success,
    ).toBe(false)

    expect(
      v.safeParse(CoreExperimentTurnStepResultSchema, {
        ...validReportPayload.steps[0],
        phase: 'model_c',
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(CoreExperimentTurnStepResultSchema, {
        ...validReportPayload.steps[0],
        day: 0,
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(CoreExperimentTurnStepResultSchema, {
        ...validReportPayload.steps[0],
        voiceRubricScore: 1.2,
      }).success,
    ).toBe(false)

    expect(
      v.safeParse(CoreExperimentEvalReportSchema, {
        ...validReportPayload,
        seed: -5,
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(CoreExperimentEvalReportSchema, {
        ...validReportPayload,
        mode: 'invalid_mode',
      }).success,
    ).toBe(false)
  })

  it('enforces Phase 4 ASHY_TRAIT_CORRIDORS, clampTraitToCorridor, DreamReflectionCycleResultSchema, and extended M2/Phase 4 gates', () => {
    expect(ASHY_TRAIT_CORRIDORS.witSarcasm).toEqual({
      baseline: 0.78,
      min: 0.58,
      max: 0.92,
      maxDeltaPerEpisode: 0.04,
    })
    expect(ASHY_TRAIT_CORRIDORS.chaosEnergy).toEqual({
      baseline: 0.75,
      min: 0.45,
      max: 0.9,
      maxDeltaPerEpisode: 0.04,
    })
    expect(ASHY_TRAIT_CORRIDORS.warmthAffection).toEqual({
      baseline: 0.68,
      min: 0.52,
      max: 0.92,
      maxDeltaPerEpisode: 0.04,
    })
    expect(ASHY_TRAIT_CORRIDORS.intellectualCuriosity).toEqual({
      baseline: 0.85,
      min: 0.68,
      max: 0.96,
      maxDeltaPerEpisode: 0.04,
    })
    expect(ASHY_TRAIT_CORRIDORS.proactivity).toEqual({
      baseline: 0.65,
      min: 0.4,
      max: 0.88,
      maxDeltaPerEpisode: 0.04,
    })

    // Clamping within corridor bounds and non-finite fallback to baseline
    expect(clampTraitToCorridor('witSarcasm', 0.99)).toBe(0.92)
    expect(clampTraitToCorridor('witSarcasm', 0.1)).toBe(0.58)
    expect(clampTraitToCorridor('chaosEnergy', 0.75)).toBe(0.75)
    expect(clampTraitToCorridor('witSarcasm', Number.NaN)).toBe(0.78)
    expect(clampTraitToCorridor('chaosEnergy', Number.POSITIVE_INFINITY)).toBe(0.75)
    expect(clampTraitToCorridor('proactivity', Number.NEGATIVE_INFINITY)).toBe(0.65)

    // clampAllTraitsToCorridors clamps out-of-bounds and non-finite trait values
    expect(
      clampAllTraitsToCorridors({
        witSarcasm: 1.5,
        chaosEnergy: -0.2,
        warmthAffection: Number.NaN,
        intellectualCuriosity: 0.99,
        proactivity: 0.1,
      }),
    ).toEqual({
      witSarcasm: 0.92,
      chaosEnergy: 0.45,
      warmthAffection: 0.68,
      intellectualCuriosity: 0.96,
      proactivity: 0.4,
    })

    // SeriousnessAssessmentSchema extended optional layer and matchedCue
    const seriousRes = v.safeParse(SeriousnessAssessmentSchema, {
      isSeriousOrDelicate: true,
      severity: 0.9,
      reason: 'Hospital emergency',
      maxPlayfulnessAllowed: 0.15,
      layer: 'semantic_local',
      matchedCue: 'hospital sobre meu pai',
    })
    expect(seriousRes.success).toBe(true)
    if (seriousRes.success) {
      expect(seriousRes.output.layer).toBe('semantic_local')
      expect(seriousRes.output.matchedCue).toBe('hospital sobre meu pai')
    }

    expect(
      v.safeParse(SeriousnessAssessmentSchema, {
        isSeriousOrDelicate: false,
        severity: 0,
        maxPlayfulnessAllowed: 1,
        layer: 'invalid_layer',
      }).success,
    ).toBe(false)

    // UserAffectReactionSchema validation
    const reactionRes = v.safeParse(UserAffectReactionSchema, {
      valenceDelta: 0.15,
      arousalDelta: 0.1,
      playfulnessDelta: 0.2,
      positiveJokeReaction: true,
      detectedSentiment: 'playful_positive',
    })
    expect(reactionRes.success).toBe(true)

    expect(
      v.safeParse(UserAffectReactionSchema, {
        valenceDelta: 1.5,
        arousalDelta: 0,
        playfulnessDelta: 0,
        positiveJokeReaction: false,
        detectedSentiment: 'neutral',
      }).success,
    ).toBe(false)

    // CrossEpisodeLinkSchema and DreamReflectionCycleResultSchema
    const dreamRes = v.safeParse(DreamReflectionCycleResultSchema, {
      ranAt: 1761740000000,
      consolidatedEpisodesCount: 1,
      reviewedMemoriesCount: 2,
      crossEpisodeLinks: [
        {
          fromEpisodeId: 'ep-1',
          toEpisodeId: 'ep-2',
          sharedTheme: 'late_night_debug',
          similarity: 0.84,
        },
      ],
      appliedEvolutions: [],
      skippedReason: null,
    })
    expect(dreamRes.success).toBe(true)

    const skippedDreamRes = v.safeParse(DreamReflectionCycleResultSchema, {
      ranAt: 1761740000000,
      consolidatedEpisodesCount: 0,
      reviewedMemoriesCount: 0,
      crossEpisodeLinks: [],
      appliedEvolutions: [],
      skippedReason: 'no_new_episodes',
    })
    expect(skippedDreamRes.success).toBe(true)

    expect(
      v.safeParse(CrossEpisodeLinkSchema, {
        fromEpisodeId: '',
        toEpisodeId: 'ep-2',
        sharedTheme: 'theme',
        similarity: 0.5,
      }).success,
    ).toBe(false)

    // CoreExperimentMetricSummarySchema Phase 4 optional-with-default fields
    const metricDefaultsRes = v.safeParse(CoreExperimentMetricSummarySchema, {
      memoryRecallRate: 1.0,
      memoryPrecisionRate: 1.0,
      callbackAccuracyRate: 1.0,
      cooldownComplianceRate: 1.0,
      hallucinatedMemoryCount: 0,
      provenanceCoverageRate: 1.0,
      seriousnessGateCompliance: 1.0,
      antiSlopComplianceRate: 1.0,
      voiceScoreModelA: 0.9,
      voiceScoreModelB: 0.9,
      crossModelVoiceDrift: 0.0,
    })
    expect(metricDefaultsRes.success).toBe(true)
    if (metricDefaultsRes.success) {
      expect(metricDefaultsRes.output.seriousnessFalseNegativeCount).toBe(0)
      expect(metricDefaultsRes.output.bondSafeguardComplianceRate).toBe(1.0)
      expect(metricDefaultsRes.output.traitDriftCorridorComplianceRate).toBe(1.0)
    }

    expect(
      v.safeParse(CoreExperimentMetricSummarySchema, {
        memoryRecallRate: 1.0,
        memoryPrecisionRate: 1.0,
        callbackAccuracyRate: 1.0,
        cooldownComplianceRate: 1.0,
        hallucinatedMemoryCount: 0,
        provenanceCoverageRate: 1.0,
        seriousnessGateCompliance: 1.0,
        antiSlopComplianceRate: 1.0,
        voiceScoreModelA: 0.9,
        voiceScoreModelB: 0.9,
        crossModelVoiceDrift: 0.0,
        seriousnessFalseNegativeCount: -1,
      }).success,
    ).toBe(false)

    expect(DEFAULT_ASHY_VOICE_MD).toContain('## Salvaguardas de Vínculo Saudável')
  })
})
