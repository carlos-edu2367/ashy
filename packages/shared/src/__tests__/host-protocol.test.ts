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
})
