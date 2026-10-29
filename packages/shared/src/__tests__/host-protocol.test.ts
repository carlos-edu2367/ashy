import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  LLM_PROVIDER_IDS,
  maskApiKey,
  CompleteOnboardingInputSchema,
  SaveProviderConfigInputSchema,
  TestProviderInputSchema,
  SendTurnInputSchema,
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
})
