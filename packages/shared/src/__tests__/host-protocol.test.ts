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
  STT_PROVIDER_IDS,
  SttProviderIdSchema,
  TTS_PROVIDER_IDS,
  TtsProviderIdSchema,
  VOICE_FIXTURE_IDS,
  VoiceFixtureIdSchema,
  DEFAULT_VOICE_RUNTIME_SETTINGS,
  ASHY_MOTION_PRESETS,
  ASHY_VISEME_KEYS,
  ASHY_EYE_LAYER_STATES,
  AshyMotionPresetSchema,
  AshyVisemeKeySchema,
  AshyEyeLayerStateSchema,
  SetStageOverlayIgnoreMouseInputSchema,
  SetStageOverlayVisibleInputSchema,
  DEFAULT_STAGE_SHORTCUTS,
  STAGE_AVATAR_MODES,
  LIVE2D_BUILTIN_MODEL_IDS,
  BUILTIN_LIVE2D_MODEL_PRESETS,
  PNGTUBER_SPRITE_STATE_KEYS,
  DEFAULT_STAGE_OVERLAY_RUNTIME_STATE,
  COMPUTER_ACTIONS_POLICIES,
  ComputerActionsPolicySchema,
  ACTION_RISK_TIERS,
  ActionRiskTierSchema,
  AUDIT_DECISIONS,
  AuditDecisionSchema,
  APPROVAL_SCOPES,
  ApprovalScopeSchema,
  EYES_MODES,
  EyesModeSchema,
  MIC_MODES,
  MicModeSchema,
  ExternalMcpServerConfigSchema,
  DEFAULT_PERSISTED_AGENCY_CONSENT_STATE,
  UpdateAgencyConsentInputSchema,
  INITIATIVE_TRIGGER_KINDS,
  InitiativeTriggerKindSchema,
  INITIATIVE_DECISIONS,
  InitiativeDecisionSchema,
  QuietHoursHHMMSchema,
  InitiativePolicySchema,
  DEFAULT_INITIATIVE_POLICY,
  UpdateInitiativePolicyInputSchema,
  EvaluateInitiativeInputSchema,
  ProactiveInitiativeRecordSchema,
  DreamJournalEntrySchema,
  UpdateMilestoneInputSchema,
  ROOM_TIME_OF_DAY_PERIODS,
  RoomTimeOfDayPeriodSchema,
  ROOM_LIGHTING_PRESETS,
  RoomLightingPresetSchema,
  ROOM_TROPHY_ICON_KEYS,
  RoomTrophyIconKeySchema,
  RoomTrophyItemSchema,
  RoomEnvironmentStateSchema,
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
      initiativeGroundingRateMin: 1.0,
      unopportuneInitiativeCountMax: 0,
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
      expect(metricDefaultsRes.output.initiativeGroundingRate).toBe(1.0)
      expect(metricDefaultsRes.output.unopportuneInitiativeCount).toBe(0)
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

  it('validates Phase 5 STT/TTS provider schemas, voice fixture IDs, DEFAULT_VOICE_RUNTIME_SETTINGS, and SendTurnInputSchema.interruptionControlNote', () => {
    expect(STT_PROVIDER_IDS).toEqual([
      'openai-whisper',
      'local-whisper-http',
      'deterministic-wav-stt',
    ])
    for (const id of STT_PROVIDER_IDS) {
      expect(v.safeParse(SttProviderIdSchema, id).success).toBe(true)
    }
    expect(v.safeParse(SttProviderIdSchema, 'invalid-stt').success).toBe(false)

    expect(TTS_PROVIDER_IDS).toEqual([
      'elevenlabs',
      'openai-tts',
      'local-kokoro-http',
      'local-synth-fallback',
    ])
    for (const id of TTS_PROVIDER_IDS) {
      expect(v.safeParse(TtsProviderIdSchema, id).success).toBe(true)
    }
    expect(v.safeParse(TtsProviderIdSchema, 'invalid-tts').success).toBe(false)

    expect(VOICE_FIXTURE_IDS).toEqual([
      'thinking-pause-cas',
      'barge-in-interrupt',
      'wake-word-oi-ashy',
      'keyboard-click-noise',
    ])
    for (const id of VOICE_FIXTURE_IDS) {
      expect(v.safeParse(VoiceFixtureIdSchema, id).success).toBe(true)
    }
    expect(v.safeParse(VoiceFixtureIdSchema, 'invalid-fixture').success).toBe(false)

    expect(DEFAULT_VOICE_RUNTIME_SETTINGS).toEqual({
      activeSttProviderId: 'deterministic-wav-stt',
      activeTtsProviderId: 'local-synth-fallback',
      sttBaseUrl: 'http://127.0.0.1:8080',
      sttModelId: 'whisper-1',
      ttsBaseUrl: 'http://127.0.0.1:8880',
      ttsModelId: 'kokoro-v1',
      ttsVoiceId: 'ashy-pt-br',
      wakeWordEnabled: true,
      wakeWordPhrases: ['ashy', 'ei ashy', 'oi ashy'],
    })

    const note =
      '[Interrupted after 1500ms — user heard: "Eu acho que" | unheard: "esse código precisa de refatoração."]'
    const validTurnWithNote = v.safeParse(SendTurnInputSchema, {
      sessionId: 'sess-voice-1',
      text: 'Espera, foca só no banco de dados',
      interruptionControlNote: `  ${note}  `,
    })
    expect(validTurnWithNote.success).toBe(true)
    if (validTurnWithNote.success) {
      expect(validTurnWithNote.output.interruptionControlNote).toBe(note)
    }

    const oversizedNote = v.safeParse(SendTurnInputSchema, {
      sessionId: 'sess-voice-1',
      text: 'Espera',
      interruptionControlNote: 'n'.repeat(1025),
    })
    expect(oversizedNote.success).toBe(false)
  })

  it('validates Phase 6 motion presets, viseme keys, eye states, and overlay IPC schemas', () => {
    expect(ASHY_MOTION_PRESETS).toEqual([
      'idle',
      'tease',
      'nod',
      'shake',
      'bounce',
      'think',
      'laugh',
      'shrug',
      'sparkle',
    ])
    expect(ASHY_VISEME_KEYS).toEqual(['closed', 'A', 'E', 'I', 'O', 'U'])
    expect(ASHY_EYE_LAYER_STATES).toEqual(['open', 'half', 'closed', 'wink'])

    expect(v.parse(AshyMotionPresetSchema, 'tease')).toBe('tease')
    expect(() => v.parse(AshyMotionPresetSchema, 'backflip')).toThrow()

    expect(v.parse(AshyVisemeKeySchema, 'A')).toBe('A')
    expect(() => v.parse(AshyVisemeKeySchema, 'Z')).toThrow()

    expect(v.parse(AshyEyeLayerStateSchema, 'wink')).toBe('wink')
    expect(() => v.parse(AshyEyeLayerStateSchema, 'crossed')).toThrow()

    expect(
      v.parse(SetStageOverlayIgnoreMouseInputSchema, {
        ignore: true,
        forward: true,
      }),
    ).toEqual({ ignore: true, forward: true })
    expect(
      v.parse(SetStageOverlayIgnoreMouseInputSchema, {
        ignore: false,
      }),
    ).toEqual({ ignore: false, forward: true })
    expect(() =>
      v.parse(SetStageOverlayIgnoreMouseInputSchema, {
        ignore: 'yes',
      }),
    ).toThrow()

    expect(
      v.parse(SetStageOverlayVisibleInputSchema, {
        visible: false,
      }),
    ).toEqual({ visible: false })
    expect(() =>
      v.parse(SetStageOverlayVisibleInputSchema, {
        visible: 1,
      }),
    ).toThrow()

    expect(DEFAULT_STAGE_SHORTCUTS.toggleHideStage).toBe('Alt+H')
    expect(DEFAULT_STAGE_SHORTCUTS.electronGlobalHideStage).toBe('CommandOrControl+Shift+H')
    expect(DEFAULT_STAGE_OVERLAY_RUNTIME_STATE.isOverlayVisible).toBe(true)
    expect(DEFAULT_STAGE_OVERLAY_RUNTIME_STATE.ignoringMouseEvents).toBe(false)
    expect(DEFAULT_STAGE_OVERLAY_RUNTIME_STATE.activeStageMode).toBe('tachie')

    expect(STAGE_AVATAR_MODES).toEqual(['tachie', 'live2d', 'vrm'])
    expect(LIVE2D_BUILTIN_MODEL_IDS).toEqual(['hiyori', 'haru', 'mao'])
    expect(BUILTIN_LIVE2D_MODEL_PRESETS.map((p) => p.id)).toEqual(['hiyori', 'haru', 'mao'])
    expect(BUILTIN_LIVE2D_MODEL_PRESETS[0]?.modelJsonUrl).toBe(
      '/live2d/models/hiyori/Hiyori.model3.json',
    )
    expect(BUILTIN_LIVE2D_MODEL_PRESETS[1]?.modelJsonUrl).toBe(
      '/live2d/models/haru/Haru.model3.json',
    )
    expect(BUILTIN_LIVE2D_MODEL_PRESETS[2]?.modelJsonUrl).toBe(
      '/live2d/models/mao/Mao.model3.json',
    )
    expect(PNGTUBER_SPRITE_STATE_KEYS).toEqual([
      'eyes_open_mouth_closed',
      'eyes_open_mouth_open',
      'eyes_open_mouth_smile',
      'eyes_closed_mouth_closed',
      'eyes_closed_mouth_open',
      'concerned',
    ])
    expect(DEFAULT_STAGE_OVERLAY_RUNTIME_STATE.loadedLive2DModelName).toBe(
      'ashy-default.model3.json',
    )
  })
})


describe('Phase 7 Desktop, Vision & MCP Shared Contracts', () => {
  it('exposes COMPUTER_ACTIONS_POLICIES including auto_accept ("Não pergunte") and validates ComputerActionsPolicySchema', () => {
    expect(COMPUTER_ACTIONS_POLICIES).toEqual(['ask', 'session', 'auto_accept', 'off'])
    for (const policy of COMPUTER_ACTIONS_POLICIES) {
      expect(v.safeParse(ComputerActionsPolicySchema, policy).success).toBe(true)
    }
    expect(v.parse(ComputerActionsPolicySchema, 'auto_accept')).toBe('auto_accept')
    expect(v.safeParse(ComputerActionsPolicySchema, 'always_allow').success).toBe(false)
    expect(v.safeParse(ComputerActionsPolicySchema, '').success).toBe(false)
  })

  it('exposes ACTION_RISK_TIERS, AUDIT_DECISIONS, APPROVAL_SCOPES, EYES_MODES, and MIC_MODES schemas', () => {
    expect(ACTION_RISK_TIERS).toEqual(['observe-only', 'read-safe', 'staged-confirm'])
    for (const tier of ACTION_RISK_TIERS) {
      expect(v.safeParse(ActionRiskTierSchema, tier).success).toBe(true)
    }
    expect(v.safeParse(ActionRiskTierSchema, 'root-exec').success).toBe(false)

    expect(AUDIT_DECISIONS).toEqual([
      'allowed',
      'staged',
      'approved',
      'denied',
      'blocked_privacy',
      'blocked_traversal',
      'revoked',
    ])
    for (const decision of AUDIT_DECISIONS) {
      expect(v.safeParse(AuditDecisionSchema, decision).success).toBe(true)
    }
    expect(v.safeParse(AuditDecisionSchema, 'unknown_decision').success).toBe(false)

    expect(APPROVAL_SCOPES).toEqual(['once', 'session'])
    expect(v.safeParse(ApprovalScopeSchema, 'once').success).toBe(true)
    expect(v.safeParse(ApprovalScopeSchema, 'session').success).toBe(true)
    expect(v.safeParse(ApprovalScopeSchema, 'forever').success).toBe(false)

    expect(EYES_MODES).toEqual(['off', 'window', 'screen'])
    for (const mode of EYES_MODES) {
      expect(v.safeParse(EyesModeSchema, mode).success).toBe(true)
    }
    expect(v.safeParse(EyesModeSchema, 'webcam').success).toBe(false)

    expect(MIC_MODES).toEqual(['muted', 'continuous', 'ptt'])
    for (const mode of MIC_MODES) {
      expect(v.safeParse(MicModeSchema, mode).success).toBe(true)
    }
    expect(v.safeParse(MicModeSchema, 'always_on').success).toBe(false)
  })

  it('validates UpdateAgencyConsentInputSchema for partial consent updates and rejects oversized/malformed arrays or invalid risk tiers', () => {
    const validUpdate = v.safeParse(UpdateAgencyConsentInputSchema, {
      eyesMode: 'window',
      micMode: 'ptt',
      dndMode: true,
      approvalPolicy: 'auto_accept',
      allowedPaths: ['  /workspace/ashy  ', 'C:/Users/User/project'],
      allowedWindowTitles: ['  VS Code  ', 'Terminal'],
      toolRiskOverrides: {
        read_workspace_file: 'staged-confirm',
        write_project_note: 'read-safe',
      },
    })
    expect(validUpdate.success).toBe(true)
    if (validUpdate.success) {
      expect(validUpdate.output.approvalPolicy).toBe('auto_accept')
      expect(validUpdate.output.allowedPaths).toEqual([
        '/workspace/ashy',
        'C:/Users/User/project',
      ])
      expect(validUpdate.output.allowedWindowTitles).toEqual(['VS Code', 'Terminal'])
      expect(validUpdate.output.toolRiskOverrides).toEqual({
        read_workspace_file: 'staged-confirm',
        write_project_note: 'read-safe',
      })
    }

    // Empty partial update is valid
    expect(v.safeParse(UpdateAgencyConsentInputSchema, {}).success).toBe(true)

    // Reject empty strings in allowedPaths or allowedWindowTitles
    expect(
      v.safeParse(UpdateAgencyConsentInputSchema, {
        allowedPaths: ['   '],
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(UpdateAgencyConsentInputSchema, {
        allowedWindowTitles: [''],
      }).success,
    ).toBe(false)

    // Reject oversized arrays (> 64 items) or oversized elements
    expect(
      v.safeParse(UpdateAgencyConsentInputSchema, {
        allowedPaths: Array.from({ length: 65 }, (_, i) => `/path/${i}`),
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(UpdateAgencyConsentInputSchema, {
        allowedPaths: ['p'.repeat(513)],
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(UpdateAgencyConsentInputSchema, {
        allowedWindowTitles: Array.from({ length: 65 }, (_, i) => `Win ${i}`),
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(UpdateAgencyConsentInputSchema, {
        allowedWindowTitles: ['w'.repeat(257)],
      }).success,
    ).toBe(false)

    // Reject invalid risk tiers or empty tool names in toolRiskOverrides
    expect(
      v.safeParse(UpdateAgencyConsentInputSchema, {
        toolRiskOverrides: {
          read_workspace_file: 'invalid-tier',
        },
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(UpdateAgencyConsentInputSchema, {
        toolRiskOverrides: {
          '   ': 'read-safe',
        },
      }).success,
    ).toBe(false)
  })

  it('validates ExternalMcpServerConfigSchema for http and stdio transports and rejects invalid configs', () => {
    const httpServer = v.safeParse(ExternalMcpServerConfigSchema, {
      id: '  ext-http-1  ',
      name: '  Local Docs MCP  ',
      transport: 'http',
      url: 'http://127.0.0.1:4100/mcp',
    })
    expect(httpServer.success).toBe(true)
    if (httpServer.success) {
      expect(httpServer.output.id).toBe('ext-http-1')
      expect(httpServer.output.name).toBe('Local Docs MCP')
      expect(httpServer.output.description).toBe('')
      expect(httpServer.output.args).toEqual([])
      expect(httpServer.output.enabled).toBe(true)
    }

    const stdioServer = v.safeParse(ExternalMcpServerConfigSchema, {
      id: 'ext-stdio-1',
      name: 'Filesystem MCP',
      description: 'Stdio MCP server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
      enabled: false,
    })
    expect(stdioServer.success).toBe(true)
    if (stdioServer.success) {
      expect(stdioServer.output.transport).toBe('stdio')
      expect(stdioServer.output.command).toBe('npx')
      expect(stdioServer.output.args).toEqual([
        '-y',
        '@modelcontextprotocol/server-filesystem',
        '/workspace',
      ])
      expect(stdioServer.output.enabled).toBe(false)
    }

    // Reject empty id or name or invalid transport
    expect(
      v.safeParse(ExternalMcpServerConfigSchema, {
        id: '   ',
        name: 'Server',
        transport: 'http',
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(ExternalMcpServerConfigSchema, {
        id: 'srv-1',
        name: '   ',
        transport: 'stdio',
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(ExternalMcpServerConfigSchema, {
        id: 'srv-1',
        name: 'Server',
        transport: 'websocket',
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(ExternalMcpServerConfigSchema, {
        id: 'srv-1',
        name: 'Server',
        transport: 'stdio',
        args: Array.from({ length: 33 }, () => '--flag'),
      }).success,
    ).toBe(false)
  })

  it('starts DEFAULT_PERSISTED_AGENCY_CONSENT_STATE with safe privacy-first defaults', () => {
    expect(DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.eyesMode).toBe('off')
    expect(DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.micMode).toBe('muted')
    expect(DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.dndMode).toBe(false)
    expect(DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.approvalPolicy).toBe('ask')
    expect(DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.allowedPaths).toEqual([
      '/workspace/ashy',
      'C:/Users/User/.gemini/antigravity/scratch/ashy',
    ])
    expect(DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.allowedWindowTitles).toEqual([
      'VS Code',
      'Ashy',
      'Terminal',
    ])
    expect(DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.toolRiskOverrides).toEqual({})
    expect(DEFAULT_PERSISTED_AGENCY_CONSENT_STATE.externalMcpServers).toEqual([])
    expect(Object.isFrozen(DEFAULT_PERSISTED_AGENCY_CONSENT_STATE)).toBe(true)
  })
})

describe('Phase 8 Contextual Initiative & Own World Shared Contracts', () => {
  it('accepts optional id on CrossEpisodeLinkSchema while preserving backwards compatibility', () => {
    const withId = v.safeParse(CrossEpisodeLinkSchema, {
      id: '  link-ep-1-ep-2-debug  ',
      fromEpisodeId: 'ep-1',
      toEpisodeId: 'ep-2',
      sharedTheme: 'late_night_debug',
      similarity: 0.88,
    })
    expect(withId.success).toBe(true)
    if (withId.success) {
      expect(withId.output.id).toBe('link-ep-1-ep-2-debug')
    }

    const withoutId = v.safeParse(CrossEpisodeLinkSchema, {
      fromEpisodeId: 'ep-1',
      toEpisodeId: 'ep-2',
      sharedTheme: 'late_night_debug',
      similarity: 0.88,
    })
    expect(withoutId.success).toBe(true)
    if (withoutId.success) {
      expect(withoutId.output.id).toBeUndefined()
    }

    expect(
      v.safeParse(CrossEpisodeLinkSchema, {
        id: '   ',
        fromEpisodeId: 'ep-1',
        toEpisodeId: 'ep-2',
        sharedTheme: 'late_night_debug',
        similarity: 0.88,
      }).success,
    ).toBe(false)
  })

  it('validates InitiativePolicySchema defaults, QuietHoursHHMMSchema, UpdateInitiativePolicyInputSchema, and EvaluateInitiativeInputSchema', () => {
    expect(INITIATIVE_TRIGGER_KINDS).toEqual([
      'prospective_intent',
      'milestone_followup',
      'recurring_theme',
      'none',
    ])
    for (const kind of INITIATIVE_TRIGGER_KINDS) {
      expect(v.safeParse(InitiativeTriggerKindSchema, kind).success).toBe(true)
    }
    expect(v.safeParse(InitiativeTriggerKindSchema, 'random_ping').success).toBe(false)

    expect(INITIATIVE_DECISIONS).toEqual([
      'spoken',
      'selective_silence',
      'suppressed_disabled',
      'suppressed_dnd',
      'suppressed_quiet_hours',
      'suppressed_cooldown',
      'suppressed_daily_limit',
      'suppressed_habit_focus',
      'suppressed_no_anchor',
    ])
    for (const decision of INITIATIVE_DECISIONS) {
      expect(v.safeParse(InitiativeDecisionSchema, decision).success).toBe(true)
    }
    expect(v.safeParse(InitiativeDecisionSchema, 'forced_interrupt').success).toBe(false)

    expect(v.safeParse(QuietHoursHHMMSchema, '23:00').success).toBe(true)
    expect(v.safeParse(QuietHoursHHMMSchema, '  08:00  ').success).toBe(true)
    expect(v.safeParse(QuietHoursHHMMSchema, '00:00').success).toBe(true)
    expect(v.safeParse(QuietHoursHHMMSchema, '23:59').success).toBe(true)
    expect(v.safeParse(QuietHoursHHMMSchema, '25:99').success).toBe(false)
    expect(v.safeParse(QuietHoursHHMMSchema, '24:00').success).toBe(false)
    expect(v.safeParse(QuietHoursHHMMSchema, '8:00').success).toBe(false)
    expect(v.safeParse(QuietHoursHHMMSchema, '23:00\x00').success).toBe(false)
    expect(v.safeParse(QuietHoursHHMMSchema, '23:00\ninjected').success).toBe(false)

    expect(DEFAULT_INITIATIVE_POLICY).toEqual({
      enabled: true,
      cooldownMinutes: 120,
      maxDailyInitiatives: 3,
      quietHoursStart: '23:00',
      quietHoursEnd: '08:00',
      respectDnd: true,
      modulateByHabits: true,
    })
    expect(Object.isFrozen(DEFAULT_INITIATIVE_POLICY)).toBe(true)

    const parsedDefaults = v.parse(InitiativePolicySchema, {})
    expect(parsedDefaults).toEqual(DEFAULT_INITIATIVE_POLICY)

    expect(
      v.safeParse(InitiativePolicySchema, {
        quietHoursStart: '25:99',
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(InitiativePolicySchema, {
        cooldownMinutes: 0,
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(InitiativePolicySchema, {
        cooldownMinutes: -10,
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(InitiativePolicySchema, {
        cooldownMinutes: 1441,
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(InitiativePolicySchema, {
        maxDailyInitiatives: -1,
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(InitiativePolicySchema, {
        maxDailyInitiatives: 21,
      }).success,
    ).toBe(false)

    const validPolicyUpdate = v.safeParse(UpdateInitiativePolicyInputSchema, {
      enabled: false,
      cooldownMinutes: 60,
      maxDailyInitiatives: 2,
      quietHoursStart: '22:30',
      quietHoursEnd: '07:30',
      respectDnd: true,
      modulateByHabits: false,
    })
    expect(validPolicyUpdate.success).toBe(true)
    expect(v.safeParse(UpdateInitiativePolicyInputSchema, {}).success).toBe(true)
    expect(
      v.safeParse(UpdateInitiativePolicyInputSchema, {
        quietHoursEnd: '25:99',
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(UpdateInitiativePolicyInputSchema, {
        cooldownMinutes: -5,
      }).success,
    ).toBe(false)

    const validEvalInput = v.safeParse(EvaluateInitiativeInputSchema, {
      nowMs: 1761740000000,
      localTimeHHMM: '14:30',
      idleMinutes: 25,
      activeAppTitle: '  VS Code — ashy  ',
      recentUserMessage: 'Terminando o deploy',
      simulatedReplyText: 'E aí, o deploy subiu sem explodir?',
      forceDnd: false,
    })
    expect(validEvalInput.success).toBe(true)
    if (validEvalInput.success) {
      expect(validEvalInput.output.activeAppTitle).toBe('VS Code — ashy')
    }
    expect(v.safeParse(EvaluateInitiativeInputSchema, {}).success).toBe(true)
    expect(
      v.safeParse(EvaluateInitiativeInputSchema, {
        localTimeHHMM: '25:99',
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(EvaluateInitiativeInputSchema, {
        idleMinutes: -1,
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(EvaluateInitiativeInputSchema, {
        activeAppTitle: 'VS Code\x00null',
      }).success,
    ).toBe(false)
  })

  it('validates ProactiveInitiativeRecordSchema, DreamJournalEntrySchema, UpdateMilestoneInputSchema, and Room schemas', () => {
    const validRecord = v.safeParse(ProactiveInitiativeRecordSchema, {
      id: 'init-1',
      triggerKind: 'prospective_intent',
      sourceId: 'intent-deploy',
      sourceTitle: 'Deploy da API',
      noticePrompt: 'Perguntar sobre o deploy da API',
      replyText: 'E aí, o deploy da API sobreviveu?',
      decision: 'spoken',
      reason: 'Anchor prospective_intent ready and outside quiet hours',
      createdAt: 1761740000000,
    })
    expect(validRecord.success).toBe(true)

    const validSuppressed = v.safeParse(ProactiveInitiativeRecordSchema, {
      id: 'init-2',
      triggerKind: 'none',
      sourceId: null,
      sourceTitle: '',
      noticePrompt: '',
      replyText: null,
      decision: 'suppressed_dnd',
      reason: 'DND active',
      createdAt: 1761740000000,
    })
    expect(validSuppressed.success).toBe(true)

    expect(
      v.safeParse(ProactiveInitiativeRecordSchema, {
        id: '   ',
        triggerKind: 'none',
        sourceId: null,
        sourceTitle: '',
        noticePrompt: '',
        replyText: null,
        decision: 'suppressed_dnd',
        reason: 'DND',
        createdAt: 1761740000000,
      }).success,
    ).toBe(false)

    const validJournal = v.safeParse(DreamJournalEntrySchema, {
      id: 'dream-entry-1',
      createdAt: 1761740000000,
      summary: 'Reflexão noturna conectando sessões de debug.',
      sourceEpisodeIds: ['ep-1', 'ep-2'],
      crossLinksCount: 1,
      traitEvolutionsCount: 1,
    })
    expect(validJournal.success).toBe(true)

    expect(
      v.safeParse(DreamJournalEntrySchema, {
        id: 'dream-entry-1',
        createdAt: 1761740000000,
        summary: '   ',
        sourceEpisodeIds: ['ep-1'],
        crossLinksCount: 0,
        traitEvolutionsCount: 0,
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(DreamJournalEntrySchema, {
        id: 'dream-entry-1',
        createdAt: 1761740000000,
        summary: 'Valid summary',
        sourceEpisodeIds: [''],
        crossLinksCount: 0,
        traitEvolutionsCount: 0,
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(DreamJournalEntrySchema, {
        id: 'dream-entry-1',
        createdAt: 1761740000000,
        summary: 'Valid summary',
        sourceEpisodeIds: ['ep-1'],
        crossLinksCount: -1,
        traitEvolutionsCount: 0,
      }).success,
    ).toBe(false)

    const validMilestoneUpdate = v.safeParse(UpdateMilestoneInputSchema, {
      id: 'ms-1',
      title: '  Primeiro deploy sem fantasma  ',
      narrative: '  Subimos a versão sem cair nada.  ',
      category: 'project_shipped',
      roomTrophyId: 'trophy-prod-shield',
    })
    expect(validMilestoneUpdate.success).toBe(true)
    if (validMilestoneUpdate.success) {
      expect(validMilestoneUpdate.output.title).toBe('Primeiro deploy sem fantasma')
      expect(validMilestoneUpdate.output.narrative).toBe('Subimos a versão sem cair nada.')
    }

    expect(
      v.safeParse(UpdateMilestoneInputSchema, {
        id: 'ms-1',
        roomTrophyId: null,
      }).success,
    ).toBe(true)

    expect(
      v.safeParse(UpdateMilestoneInputSchema, {
        id: 'ms-1\nnewline',
        title: 'Valid',
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(UpdateMilestoneInputSchema, {
        id: 'ms-1\x00null',
        title: 'Valid',
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(UpdateMilestoneInputSchema, {
        id: 'ms-1',
        title: 'Bad\x00Title',
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(UpdateMilestoneInputSchema, {
        id: 'ms-1',
        title: 'x'.repeat(161),
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(UpdateMilestoneInputSchema, {
        id: 'ms-1',
        narrative: 'Bad\x00Narrative',
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(UpdateMilestoneInputSchema, {
        id: 'ms-1',
        narrative: 'x'.repeat(2001),
      }).success,
    ).toBe(false)

    expect(ROOM_TIME_OF_DAY_PERIODS).toEqual([
      'morning',
      'afternoon',
      'evening',
      'late_night',
    ])
    for (const p of ROOM_TIME_OF_DAY_PERIODS) {
      expect(v.safeParse(RoomTimeOfDayPeriodSchema, p).success).toBe(true)
    }

    expect(ROOM_LIGHTING_PRESETS).toEqual([
      'warm_sunrise',
      'golden_studio',
      'cozy_neon',
      'midnight_lofi',
    ])
    for (const preset of ROOM_LIGHTING_PRESETS) {
      expect(v.safeParse(RoomLightingPresetSchema, preset).success).toBe(true)
    }

    expect(ROOM_TROPHY_ICON_KEYS).toEqual([
      'mug',
      'sparkles',
      'rocket',
      'moon',
      'heart',
      'flame',
      'shield',
      'duck',
    ])
    for (const icon of ROOM_TROPHY_ICON_KEYS) {
      expect(v.safeParse(RoomTrophyIconKeySchema, icon).success).toBe(true)
    }

    const validTrophy = {
      id: 'trophy-first-boot-mug',
      name: 'Caneca do Primeiro Boot',
      description: 'Desbloqueada no primeiro encontro no estúdio.',
      category: 'first_meeting' as const,
      milestoneId: 'ms-first-boot',
      episodeId: 'ep-1',
      unlockedAt: 1761740000000,
      unlocked: true,
      iconKey: 'mug' as const,
    }
    expect(v.safeParse(RoomTrophyItemSchema, validTrophy).success).toBe(true)

    const validRoom = v.safeParse(RoomEnvironmentStateSchema, {
      period: 'late_night',
      ambientLabel: 'Madrugada Lo-Fi no Estúdio',
      lightingPreset: 'midnight_lofi',
      unlockedTrophies: [validTrophy],
    })
    expect(validRoom.success).toBe(true)

    expect(
      v.safeParse(RoomEnvironmentStateSchema, {
        period: 'invalid_period',
        ambientLabel: 'Label',
        lightingPreset: 'midnight_lofi',
        unlockedTrophies: [],
      }).success,
    ).toBe(false)
  })
})
