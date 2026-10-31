import { describe, expect, it } from 'vitest'
import { composeAshyTurnPrompt, createAshyCortex } from '../index'

describe('@ashy/cortex SoulComposer static/volatile split & turn memory indexing', () => {
  it('splits staticSystemPrompt (voice.md + soul truths + exemplars) from volatileTurnContext without hardcoded 21:15 or VS Code', () => {
    const cortex = createAshyCortex({ forceMemoryFallback: true })
    cortex.db.upsertSemanticFact({
      id: 'fact-user-name',
      category: 'identity',
      subject: 'user',
      predicate: 'name',
      object: 'Carlos',
      confidence: 1,
      sourceEpisodeIds: ['onboarding'],
      validFrom: Date.now(),
    })
    cortex.db.upsertSemanticFact({
      id: 'fact-user-pronouns',
      category: 'identity',
      subject: 'user',
      predicate: 'pronouns',
      object: 'ele/dele',
      confidence: 1,
      sourceEpisodeIds: ['onboarding'],
      validFrom: Date.now(),
    })

    const compiled = cortex.compileTurnPrompt({
      userMessage: 'Bora revisar o banco SQLite hoje?',
      stage: 'companion',
      voiceIdentityMarkdown: '# Identidade Viva\nAshy fala com humor afiado no Cozy Night Studio.',
    })

    expect(compiled.staticSystemPrompt).toContain('[ASHY CORE IDENTITY & VOICE]')
    expect(compiled.staticSystemPrompt).toContain('# Identidade Viva')
    expect(compiled.staticSystemPrompt).toContain('[IMMUTABLE SOUL TRUTHS]')
    expect(compiled.staticSystemPrompt).toContain('GOLDEN DIALOGUE EXEMPLARS')
    expect(compiled.staticSystemPrompt).toContain('ex-companion-01')
    expect(compiled.staticSystemPrompt).toContain('ex-serious-01')
    expect(compiled.staticSystemPrompt).not.toContain('ex-stranger-01')
    expect(compiled.staticSystemPrompt).toContain('[OUTPUT FORMAT — STAGE MARKERS]')

    expect(compiled.volatileTurnContext).toContain('[USER IDENTITY]')
    expect(compiled.volatileTurnContext).toContain('Carlos')
    expect(compiled.volatileTurnContext).toContain('ele/dele')
    expect(compiled.volatileTurnContext).toContain('[RELATIONSHIP STAGE: COMPANION]')
    expect(compiled.volatileTurnContext).toContain('[AFFECT & PERSONALITY MODULATION]')
    expect(compiled.volatileTurnContext).toContain('[AMBIENT CONTEXT]')
    expect(compiled.volatileTurnContext).not.toContain('VS Code — apps/desktop/src/App.tsx')
    expect(compiled.volatileTurnContext).not.toContain('Active screen:')
    expect(compiled.systemPrompt).toBe(
      `${compiled.staticSystemPrompt}\n\n${compiled.volatileTurnContext}`,
    )

    // Verify per-turn episodic memories & inside jokes are injected once in userTurnContent ([Context])
    // and not duplicated inside systemPrompt / volatileTurnContext
    cortex.db.upsertEpisodicMemory({
      id: 'ep-dedupe-01',
      title: 'Deploy de Madrugada',
      summary: 'Subimos o cluster SQLite às 3h da manhã sem quebrar nada.',
      content: 'Deploy de Madrugada: Subimos o cluster SQLite às 3h da manhã sem quebrar nada.',
      createdAt: 1730000000000,
      lastReviewedAt: 1730000000000,
      stability: 30,
      difficulty: 2,
      surprise: 0.85,
      isFlashbulb: true,
      tags: ['SQLite'],
    })
    cortex.db.upsertRelationalMotif({
      id: 'motif-dedupe-01',
      motif: 'chamar um padre pro SQLite',
      originSummary: 'Quando o lock WAL travou no Windows',
      triggerCues: ['sqlite', 'banco', 'revisar'],
      stage: 'inside_joke',
      timesUsed: 2,
      lastUsedAt: 0,
      cooldownHours: 0.01,
      createdAt: 1730000000000,
    })

    const withRecall = cortex.compileTurnPrompt({
      userMessage: 'Vamos revisar o banco SQLite de novo?',
      stage: 'companion',
      nowMs: 1730000500000,
    })

    expect(withRecall.userTurnContent).toContain('Episodic Memory [ep-dedupe-01]')
    expect(withRecall.userTurnContent).toContain('Eligible Inside Joke [motif-dedupe-01]')
    expect(withRecall.volatileTurnContext).not.toContain('Episodic Memory [ep-dedupe-01]')
    expect(withRecall.volatileTurnContext).not.toContain('Eligible Inside Joke [motif-dedupe-01]')

    cortex.close()
  })

  it('indexes salient turn exchanges into FTS5 episodic_memories and extracts explicit user facts', () => {
    for (const forceMemoryFallback of [false, true]) {
      const cortex = createAshyCortex(
        forceMemoryFallback ? { forceMemoryFallback: true } : { inMemory: true },
      )

      const indexed = cortex.indexTurnMemory({
        turnId: 'turn-01',
        userText:
          'Oi Ashy, meu nome é Carlos e eu trabalho com TypeScript e Rust, uso muito Neovim e meu projeto atual é Ashy Desktop.',
        assistantText: 'Boa combinação, tipagem forte para não chorar em produção.',
        emotion: 'smug',
        now: 1730000050000,
      })

      expect(indexed.episodeCreated).toBe(true)
      expect(indexed.factsCreated).toBe(4)

      const recalled = cortex.recall('TypeScript Rust', 1730000060000, 5)
      expect(recalled.length).toBeGreaterThan(0)
      expect(recalled[0]?.memory.content).toContain('TypeScript e Rust')

      const facts = cortex.db.listActiveSemanticFacts()
      expect(facts.find((f) => f.predicate === 'name')?.object).toBe('Carlos')
      expect(facts.find((f) => f.predicate === 'works_with')?.object).toBe('TypeScript e Rust')
      expect(facts.find((f) => f.predicate === 'uses_tool')?.object).toBe('Neovim')
      expect(facts.find((f) => f.predicate === 'current_project')?.object).toBe('Ashy Desktop')

      cortex.close()
    }
  })

  it('adversarial: ignores short/noisy userText (< 12 chars) for episodic indexing and sanitizes voiceIdentityMarkdown & screenContext', () => {
    const cortex = createAshyCortex({ inMemory: true })

    const shortTurn = cortex.indexTurnMemory({
      turnId: 'turn-short',
      userText: '   oi tudo?  ',
      assistantText: 'Tudo certo por aqui.',
      emotion: 'neutral',
      now: 1730000070000,
    })
    expect(shortTurn.episodeCreated).toBe(false)
    expect(shortTurn.factsCreated).toBe(0)
    expect(cortex.db.listEpisodicMemories()).toHaveLength(0)

    // Seriousness gate + null-byte sanitization in voiceIdentityMarkdown + angle-bracket stripping in screenContext
    const seriousCompiled = cortex.compileTurnPrompt({
      userMessage: 'Estou exausto, tive uma crise de ansiedade horrível e quero chorar.',
      voiceIdentityMarkdown: '   \0\0# Voz Noturna Segura\0\nPresença acolhedora no estúdio.   ',
      screenContext: '<script>alert(1)</script>Terminal — zsh',
      timeOfDayLabel: '02:40',
    })

    expect(seriousCompiled.staticSystemPrompt).toContain('# Voz Noturna Segura')
    expect(seriousCompiled.staticSystemPrompt).not.toContain('\0')
    expect(seriousCompiled.staticSystemPrompt).toContain('ex-serious-01')
    expect(seriousCompiled.volatileTurnContext).toContain('[SERIOUSNESS GATE — HIGH PRIORITY]')
    expect(seriousCompiled.volatileTurnContext).toContain('02:40')
    expect(seriousCompiled.volatileTurnContext).toContain('Active screen: scriptalert(1)/scriptTerminal — zsh')
    expect(seriousCompiled.volatileTurnContext).not.toContain('<script>')

    cortex.close()
  })

  it('exposes session and message pass-through helpers on AshyCortex', () => {
    const cortex = createAshyCortex({ inMemory: true })

    const session = cortex.createChatSession({
      id: 'sess-cortex-1',
      title: 'Sessão via AshyCortex',
      startedAt: 1730000100000,
    })
    expect(session.id).toBe('sess-cortex-1')
    expect(cortex.listChatSessions()).toHaveLength(1)
    expect(cortex.getChatSession('sess-cortex-1')?.title).toBe('Sessão via AshyCortex')

    cortex.appendChatMessage({
      id: 'msg-cortex-1',
      sessionId: 'sess-cortex-1',
      role: 'user',
      content: 'Testando repasse de sessão no cortex',
      rawContent: 'Testando repasse de sessão no cortex',
      emotion: 'neutral',
      markersJson: '[]',
      createdAt: 1730000101000,
    })
    expect(cortex.listChatMessages('sess-cortex-1')).toHaveLength(1)

    expect(cortex.deleteChatSession('sess-cortex-1')).toBe(true)
    expect(cortex.getChatSession('sess-cortex-1')).toBeNull()

    cortex.close()
  })

  it('appends [NATIVE OMNI AUDIO OUTPUT DIRECTIVE] to systemPrompt when omniOutputMode is native-audio', () => {
    const nativeAudioCompiled = composeAshyTurnPrompt({
      userMessage: 'Me responde usando sua voz nativa do LFM3-Omni-2B!',
      omniOutputMode: 'native-audio',
    })

    expect(nativeAudioCompiled.systemPrompt).toContain('[NATIVE OMNI AUDIO OUTPUT DIRECTIVE]')
    expect(nativeAudioCompiled.systemPrompt).toContain('ashy_stage_signal')
    expect(nativeAudioCompiled.systemPrompt).toMatch(/NEVER vocalize/i)

    const textOnlyCompiled = composeAshyTurnPrompt({
      userMessage: 'Me responde em texto normal',
      omniOutputMode: 'text-only',
    })

    expect(textOnlyCompiled.systemPrompt).not.toContain('[NATIVE OMNI AUDIO OUTPUT DIRECTIVE]')
  })
})
