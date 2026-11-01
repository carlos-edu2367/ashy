import { describe, expect, it } from 'vitest'
import {
  FALLBACK_PROVIDER_MODELS,
  inferModelOmniCapabilities,
  matchesModelSearch,
  omniCapabilitiesFromModalities,
} from '../host-protocol'

describe('omni model catalog (any omni model is selectable)', () => {
  it('infers omni for current model names, not only the 2.5-era ones', () => {
    for (const id of [
      'qwen/qwen3.8-omni-flash',
      'qwen3-omni:30b',
      'qwen/qwen2.5-omni-7b',
      'openai/gpt-audio-mini',
      'gpt-realtime-2.1-mini',
      'LiquidAI/LFM3-Omni-2B-GGUF',
      'openbmb/minicpm-o-4',
    ]) {
      expect(inferModelOmniCapabilities('openrouter', id).isOmniModel, id).toBe(true)
    }
    expect(inferModelOmniCapabilities('openrouter', 'google/gemini-3.8-flash').supportsOmniAudioIn).toBe(true)
    expect(inferModelOmniCapabilities('openrouter', 'qwen/qwen3.8-flash').isOmniModel).toBe(false)
    expect(inferModelOmniCapabilities('ollama', 'deepseek-r1:8b').isOmniModel).toBe(false)
  })

  it('prefers the modalities declared by the provider API', () => {
    const caps = omniCapabilitiesFromModalities(['text', 'image', 'audio', 'video', 'file'], ['text'])
    expect(caps).toEqual({
      isOmniModel: true,
      supportsOmniAudioIn: true,
      supportsOmniAudioOut: false,
      supportsOmniVideoIn: true,
      inputModalities: ['text', 'image', 'audio', 'video'],
      outputModalities: ['text'],
    })
    expect(omniCapabilitiesFromModalities(['text', 'image'], ['text'])?.isOmniModel).toBe(false)
    expect(omniCapabilitiesFromModalities(undefined, undefined)).toBeNull()
    expect(omniCapabilitiesFromModalities(['audio'], ['audio'])?.supportsOmniAudioOut).toBe(true)
  })

  it('searches by terms, ignoring punctuation and spacing', () => {
    const qwenOmni = { id: 'qwen/qwen3.8-omni-flash', name: 'Qwen: Qwen3.8 Omni Flash', isOmniModel: true }
    expect(matchesModelSearch(qwenOmni, 'qwen 3.8 omni')).toBe(true)
    expect(matchesModelSearch(qwenOmni, 'Qwen3.8-Omni')).toBe(true)
    expect(matchesModelSearch(qwenOmni, 'qwen omni')).toBe(true)
    expect(matchesModelSearch(qwenOmni, '')).toBe(true)
    expect(matchesModelSearch(qwenOmni, 'gemini')).toBe(false)
    const gemini = { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', isOmniModel: true }
    expect(matchesModelSearch(gemini, 'omni')).toBe(true)
    expect(matchesModelSearch({ id: 'qwen/qwen3.8-flash', name: 'Qwen 3.8 Flash' }, 'qwen 3.8 omni')).toBe(false)
  })

  it('suggests current omni models for OpenRouter out of the box', () => {
    const omni = FALLBACK_PROVIDER_MODELS.openrouter.filter((m) => m.isOmniModel)
    expect(omni.map((m) => m.id)).toEqual(
      expect.arrayContaining(['qwen/qwen3.8-omni-flash', 'google/gemini-3.8-flash']),
    )
  })
})
