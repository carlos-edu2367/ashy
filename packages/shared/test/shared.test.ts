import { describe, it, expect } from 'vitest'
import * as v from 'valibot'
import {
  ASHY_EMOTIONS,
  AshyEmotionEnum,
  AshyEmotionSchema,
  EmotionPayloadSchema,
  EMOTION_AFFECT_DELTA,
  validateEmotionPayload,
  safeValidateEmotionPayload,
  EpisodicMemorySchema,
  SemanticFactSchema,
  SEMANTIC_FACT_CATEGORIES,
  RelationalMotifSchema,
  RELATIONAL_MOTIF_STAGES,
  AutobiographicalMilestoneSchema,
  MILESTONE_CATEGORIES,
  UserHabitSchema,
  ProspectiveIntentSchema,
  PROSPECTIVE_INTENT_STATUSES,
  ASHY_BASELINE_MOOD,
  ASHY_DEFAULT_TRAITS,
  MoodVectorSchema,
  PersonalityTraitsSchema,
  PersonalityEvolutionRecordSchema,
  SeriousnessAssessmentSchema,
  clampMoodVector,
  createGraphemeStreamer,
} from '../src/index'

describe('@ashy/shared — 1. emotions.ts', () => {
  it('exposes the 13 canonical Ashy emotions and enum mapping', () => {
    expect(ASHY_EMOTIONS).toEqual([
      'happy',
      'excited',
      'smug',
      'tease',
      'chaotic',
      'curious',
      'think',
      'surprised',
      'awkward',
      'concerned',
      'sad',
      'angry',
      'neutral',
    ])
    expect(ASHY_EMOTIONS).toHaveLength(13)
    for (const emotion of ASHY_EMOTIONS) {
      expect(AshyEmotionEnum[emotion]).toBe(emotion)
      expect(v.safeParse(AshyEmotionSchema, emotion).success).toBe(true)
    }
    expect(v.safeParse(AshyEmotionSchema, 'bored').success).toBe(false)
  })

  it('validates strict EmotionPayloadSchema and clamps/rejects malformed inputs via validateEmotionPayload', () => {
    const valid = { emotion: 'smug' as const, intensity: 0.85, motion: 'wink', durationSec: 2.5 }
    const parsed = v.parse(EmotionPayloadSchema, valid)
    expect(parsed).toEqual(valid)

    // Out-of-bounds intensity fails strict schema parse
    expect(v.safeParse(EmotionPayloadSchema, { emotion: 'smug', intensity: 1.5 }).success).toBe(false)
    expect(v.safeParse(EmotionPayloadSchema, { emotion: 'smug', intensity: -0.2 }).success).toBe(false)
    expect(v.safeParse(EmotionPayloadSchema, { emotion: 'unknown', intensity: 0.5 }).success).toBe(false)

    // validateEmotionPayload clamps out-of-range intensity into [0, 1]
    expect(validateEmotionPayload({ emotion: 'tease', intensity: 4.2 })).toEqual({
      emotion: 'tease',
      intensity: 1,
    })
    expect(validateEmotionPayload({ emotion: 'concerned', intensity: -3.5 })).toEqual({
      emotion: 'concerned',
      intensity: 0,
    })

    // Defaults intensity when omitted
    expect(validateEmotionPayload({ emotion: 'happy' })).toEqual({
      emotion: 'happy',
      intensity: 0.75,
    })

    // Rejects adversarial malformed payloads (NaN, Infinity, prototype pollution, invalid emotion)
    expect(() => validateEmotionPayload(null)).toThrow()
    expect(() => validateEmotionPayload('smug')).toThrow()
    expect(() => validateEmotionPayload({ emotion: 'invalid_emotion', intensity: 0.5 })).toThrow()
    expect(() => validateEmotionPayload({ emotion: 'smug', intensity: Number.NaN })).toThrow()
    expect(() => validateEmotionPayload({ emotion: 'smug', intensity: Number.POSITIVE_INFINITY })).toThrow()

    expect(safeValidateEmotionPayload({ emotion: 'invalid' })).toBeNull()
    expect(safeValidateEmotionPayload({ emotion: 'chaotic', intensity: 2 })).toEqual({
      emotion: 'chaotic',
      intensity: 1,
    })
  })

  it('maps all 13 emotions in EMOTION_AFFECT_DELTA with coherent affect vectors', () => {
    for (const emotion of ASHY_EMOTIONS) {
      const delta = EMOTION_AFFECT_DELTA[emotion]
      expect(delta).toBeDefined()
      expect(delta.valence).toBeGreaterThanOrEqual(-1)
      expect(delta.valence).toBeLessThanOrEqual(1)
      expect(delta.arousal).toBeGreaterThanOrEqual(-1)
      expect(delta.arousal).toBeLessThanOrEqual(1)
      expect(delta.playfulness).toBeGreaterThanOrEqual(-1)
      expect(delta.playfulness).toBeLessThanOrEqual(1)
    }

    // smug, tease, chaotic boost playfulness and arousal
    for (const playfulEmotion of ['smug', 'tease', 'chaotic'] as const) {
      expect(EMOTION_AFFECT_DELTA[playfulEmotion].playfulness).toBeGreaterThan(0)
      expect(EMOTION_AFFECT_DELTA[playfulEmotion].arousal).toBeGreaterThan(0)
    }

    // concerned and sad reduce playfulness
    expect(EMOTION_AFFECT_DELTA.concerned.playfulness).toBeLessThan(0)
    expect(EMOTION_AFFECT_DELTA.sad.playfulness).toBeLessThan(0)
  })
})

describe('@ashy/shared — 2. memory-types.ts (6 Memory Schemas)', () => {
  it('validates EpisodicMemorySchema and rejects invalid FSRS/surprise parameters', () => {
    const validEpisode = {
      id: 'ep_01',
      title: 'Debugging ghost bug in npm',
      summary: 'We joked about calling a priest for node_modules',
      content: 'User: Tem um fantasma no backend\nAshy: Chama um padre pro npm!',
      createdAt: 1730000000000,
      lastReviewedAt: 1730003600000,
      stability: 4.5,
      difficulty: 3.2,
      surprise: 0.88,
      isFlashbulb: true,
      tags: ['debugging', 'backend', 'humor'],
      embedding: [0.12, -0.34, 0.56],
    }
    expect(v.safeParse(EpisodicMemorySchema, validEpisode).success).toBe(true)

    // Invalid stability (<= 0) or surprise (> 1) must be rejected
    expect(
      v.safeParse(EpisodicMemorySchema, { ...validEpisode, stability: 0 }).success,
    ).toBe(false)
    expect(
      v.safeParse(EpisodicMemorySchema, { ...validEpisode, surprise: 1.5 }).success,
    ).toBe(false)
  })

  it('validates SemanticFactSchema across all 8 canonical categories', () => {
    expect(SEMANTIC_FACT_CATEGORIES).toEqual([
      'identity',
      'preference',
      'interest',
      'personality',
      'relationship',
      'experience',
      'goal',
      'guideline',
    ])

    const validFact = {
      id: 'fact_01',
      category: 'preference' as const,
      subject: 'user',
      predicate: 'prefers_package_manager',
      object: 'pnpm',
      confidence: 0.95,
      sourceEpisodeIds: ['ep_01'],
      validFrom: 1730000000000,
      invalidAt: null,
    }
    expect(v.safeParse(SemanticFactSchema, validFact).success).toBe(true)
    expect(
      v.safeParse(SemanticFactSchema, { ...validFact, category: 'unknown_cat' }).success,
    ).toBe(false)
    expect(
      v.safeParse(SemanticFactSchema, { ...validFact, confidence: -0.1 }).success,
    ).toBe(false)
  })

  it('validates RelationalMotifSchema across all 5 inside-joke lifecycle stages', () => {
    expect(RELATIONAL_MOTIF_STAGES).toEqual([
      'seed',
      'callback_candidate',
      'inside_joke',
      'legendary',
      'dormant',
    ])

    const validMotif = {
      id: 'motif_ghost_backend',
      motif: 'Fantasma no backend / Padre no npm',
      originSummary: 'Surgiu ao depurar um bug assombrado às 2h da manhã',
      originEpisodeId: 'ep_01',
      triggerCues: ['bug estranho', 'node_modules', 'backend assombrado'],
      stage: 'inside_joke' as const,
      timesUsed: 2,
      lastUsedAt: 1730003600000,
      cooldownHours: 48,
      createdAt: 1730000000000,
    }
    expect(v.safeParse(RelationalMotifSchema, validMotif).success).toBe(true)
    expect(
      v.safeParse(RelationalMotifSchema, { ...validMotif, timesUsed: -1 }).success,
    ).toBe(false)
  })

  it('validates AutobiographicalMilestoneSchema, UserHabitSchema, and ProspectiveIntentSchema', () => {
    expect(MILESTONE_CATEGORIES).toEqual([
      'first_meeting',
      'inside_joke_born',
      'project_shipped',
      'late_night_debug',
      'trait_evolution',
      'flashbulb_moment',
    ])
    expect(PROSPECTIVE_INTENT_STATUSES).toEqual([
      'pending',
      'triggered',
      'completed',
      'dismissed',
    ])

    expect(
      v.safeParse(AutobiographicalMilestoneSchema, {
        id: 'ms_01',
        title: 'Primeira Madrugada de Debug',
        narrative: 'Consertamos o bug fantasma juntos.',
        category: 'late_night_debug',
        episodeId: 'ep_01',
        roomTrophyId: 'trophy_rubber_duck',
        createdAt: 1730000000000,
      }).success,
    ).toBe(true)

    expect(
      v.safeParse(UserHabitSchema, {
        id: 'hab_01',
        patternKey: 'late_night_coding',
        description: 'Costuma programar com foco intenso entre 22h e 02h',
        confidence: 0.85,
        observationCount: 7,
        updatedAt: 1730000000000,
      }).success,
    ).toBe(true)

    expect(
      v.safeParse(ProspectiveIntentSchema, {
        id: 'intent_01',
        topic: 'Deploy da versão v1.0',
        contextCue: 'Quando o usuário abrir o projeto na sexta-feira',
        dueAt: 1730500000000,
        status: 'pending',
        createdAt: 1730000000000,
      }).success,
    ).toBe(true)
  })
})

describe('@ashy/shared — 3. affect-types.ts (4 Affective Layers)', () => {
  it('provides baseline mood, default traits, and validates affect schemas', () => {
    expect(ASHY_BASELINE_MOOD).toEqual({
      valence: 0.35,
      arousal: 0.65,
      playfulness: 0.6,
    })
    expect(ASHY_DEFAULT_TRAITS).toEqual({
      witSarcasm: 0.78,
      chaosEnergy: 0.75,
      warmthAffection: 0.68,
      intellectualCuriosity: 0.85,
      proactivity: 0.65,
    })

    expect(v.safeParse(MoodVectorSchema, ASHY_BASELINE_MOOD).success).toBe(true)
    expect(v.safeParse(MoodVectorSchema, { valence: 2, arousal: 0, playfulness: 0 }).success).toBe(
      false,
    )

    expect(clampMoodVector({ valence: 1.8, arousal: -2.4, playfulness: 0.4 })).toEqual({
      valence: 1,
      arousal: -1,
      playfulness: 0.4,
    })

    expect(v.safeParse(PersonalityTraitsSchema, ASHY_DEFAULT_TRAITS).success).toBe(true)
    expect(
      v.safeParse(PersonalityEvolutionRecordSchema, {
        id: 'evo_01',
        trait: 'warmthAffection',
        oldValue: 0.68,
        newValue: 0.72,
        reasonEpisodeId: 'ep_01',
        explanation: 'Apoio mútuo durante noite difícil de trabalho',
        createdAt: 1730000000000,
        revertedAt: null,
      }).success,
    ).toBe(true)

    expect(
      v.safeParse(SeriousnessAssessmentSchema, {
        isSeriousOrDelicate: true,
        severity: 0.9,
        reason: 'Usuário relatou exaustão e problema pessoal grave',
        maxPlayfulnessAllowed: 0.15,
      }).success,
    ).toBe(true)
  })
})

describe('@ashy/shared — 4. grapheme-stream.ts (Zero-Corruption Grapheme Streamer)', () => {
  it('holds the last grapheme cluster until the next write and flushes cleanly', () => {
    const streamer = createGraphemeStreamer()

    expect(streamer.write('Oi')).toEqual(['O'])
    expect(streamer.write('!')).toEqual(['i'])
    expect(streamer.flush()).toEqual(['!'])
    expect(streamer.flush()).toEqual([])
  })

  it('never splits compound ZWJ emojis (👩‍💻, 👨‍👩‍👧‍👦) or combining diacritics across chunk boundaries', () => {
    const streamer = createGraphemeStreamer()
    // '👩‍💻' = '👩' (\uD83D\uDC69) + ZWJ (\u200D) + '💻' (\uD83D\uDCBB)
    const chunks = ['Oi ', '👩', '\u200D', '💻', '!', ' Tudo ', 'a', '\u0303', 'o?']
    const emitted: string[] = []

    for (const chunk of chunks) {
      emitted.push(...streamer.write(chunk))
    }
    emitted.push(...streamer.flush())

    expect(emitted).toContain('👩‍💻')
    expect(emitted).toContain('a\u0303')
    expect(emitted.join('')).toBe('Oi 👩‍💻! Tudo a\u0303o?')
  })

  it('handles surrogate pairs split at raw UTF-16 code unit level without emitting lone surrogates', () => {
    const streamer = createGraphemeStreamer()
    // '🔥' is \uD83D\uDD25
    const out1 = streamer.write('A\uD83D')
    expect(out1).toEqual([])
    const out2 = streamer.write('\uDD25B')
    expect(out2).toEqual(['A', '🔥'])
    const out3 = streamer.flush()
    expect(out3).toEqual(['B'])

    // Skin-tone modifier split mid-surrogate: '👩🏽‍💻' = '👩' (\uD83D\uDC69) + '🏽' (\uD83C\uDFFD) + ZWJ + '💻'
    const s2 = createGraphemeStreamer()
    const chunks = ['👩\uD83C', '\uDFFD\u200D', '💻!']
    const all: string[] = []
    for (const c of chunks) {
      all.push(...s2.write(c))
    }
    all.push(...s2.flush())
    expect(all).toEqual(['👩🏽‍💻', '!'])
  })

  it('sanitizes XSS/control characters in motion and accepts nested moeru-ai emotion format', () => {
    const res = validateEmotionPayload({
      emotion: { name: 'smug', intensity: 0.92 },
      motion: '  <script>wink\u0000</script>  ',
      durationSec: 120,
    })
    expect(res).toEqual({
      emotion: 'smug',
      intensity: 0.92,
      motion: 'scriptwink/script',
      durationSec: 60,
    })
  })

  it('handles empty chunks and multi-ZWJ family/kiss emojis', () => {
    const streamer = createGraphemeStreamer()
    expect(streamer.write('')).toEqual([])
    expect(streamer.write('👩‍❤️‍💋‍👨')).toEqual([])
    expect(streamer.write('')).toEqual([])
    expect(streamer.flush()).toEqual(['👩‍❤️‍💋‍👨'])
  })
})
