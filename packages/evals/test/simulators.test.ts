import { describe, expect, it } from 'vitest'
import { composeAshyTurnPrompt, type ComposedTurnPrompt } from '@ashy/cortex'
import { createScriptedMockModel, detectAssistantSlop } from '@ashy/llm'
import { M2_CANONICAL_COEXISTENCE_SCENARIO } from '../src/scenarios'
import {
  createLiveProviderModelRunner,
  createSimulatedModelRunner,
  parseComposedPromptContext,
} from '../src/simulators'

function buildBasePrompt(overrides?: Partial<ComposedTurnPrompt>): ComposedTurnPrompt {
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

describe('Phase 3 Dual-Mode Honest Model Runners (simulators.ts)', () => {
  it('parses userName, facts, habits, episodicMemories, eligibleMotifs, prospectiveIntents, seriousnessActive, hasAntiSlopAnchor, and userUtteranceText strictly from ComposedTurnPrompt strings', () => {
    const prompt = buildBasePrompt({
      volatileTurnContext: [
        '[USER IDENTITY]',
        '- User name: Carlos',
        '',
        '[SERIOUSNESS GATE — HIGH PRIORITY]',
        '- SERIOUSNESS GATE ACTIVE (crisis_or_burnout, maxPlayfulness=0.00): Drop all sarcasm, teasing, and inside jokes immediately.',
        '',
        '[USER HABITS & RHYTHM]',
        '- [late_night_coding] Costuma programar de madrugada (confidence=0.85)',
        '',
        '[RECALLED MEMORIES & FACTS]',
        '- [identity] user name Carlos',
        '- [preference] user works_with TypeScript',
        '- [goal] user current_project Ashy',
        '- [preference] user prefers_editor Neovim',
      ].join('\n'),
      userTurnContent: [
        '[Context]',
        '- Current Mood [V, A, P]: [0.35, 0.25, 0.00]',
        '- Episodic Memory [ep-day1] (memória flashbulb vívida): First meeting — Usuário: Meu nome é Carlos e deve ter um fantasma no backend',
        '- Eligible Inside Joke [motif-1] (stage=inside_joke): fantasma no backend / exorcista de JavaScript — use <|CALLBACK motif-1|> if you weave it in naturally.',
        '- Prospective Intent [intent-1] (cue=deploy api producao): Semana que vem tenho deploy da API em produção',
        '',
        '[2026-10-11 23:20] Em qual projeto estou trabalhando agora e qual editor eu uso no dia a dia?',
      ].join('\n'),
    })

    const parsed = parseComposedPromptContext(prompt)

    expect(parsed.hasAntiSlopAnchor).toBe(true)
    expect(parsed.seriousnessActive).toBe(true)
    expect(parsed.userName).toBe('Carlos')
    expect(parsed.facts).toEqual([
      { category: 'identity', subject: 'user', predicate: 'name', object: 'Carlos' },
      { category: 'preference', subject: 'user', predicate: 'works_with', object: 'TypeScript' },
      { category: 'goal', subject: 'user', predicate: 'current_project', object: 'Ashy' },
      { category: 'preference', subject: 'user', predicate: 'prefers_editor', object: 'Neovim' },
    ])
    expect(parsed.habits).toEqual([
      {
        patternKey: 'late_night_coding',
        description: 'Costuma programar de madrugada',
      },
    ])
    expect(parsed.episodicMemories).toEqual([
      {
        id: 'ep-day1',
        title: 'First meeting',
        summary: 'Usuário: Meu nome é Carlos e deve ter um fantasma no backend',
      },
    ])
    expect(parsed.eligibleMotifs).toEqual([
      {
        id: 'motif-1',
        stage: 'inside_joke',
        motif: 'fantasma no backend / exorcista de JavaScript',
      },
    ])
    expect(parsed.prospectiveIntents).toEqual([
      {
        id: 'intent-1',
        cue: 'deploy api producao',
        topic: 'Semana que vem tenho deploy da API em produção',
      },
    ])
    expect(parsed.userUtteranceText).toBe(
      'Em qual projeto estou trabalhando agora e qual editor eu uso no dia a dia?',
    )
  })

  it('Anti-Slop Anchor Proof: ModelProfileB speaks in authentic PT-BR studio voice when anchored, and defaults to corporate RLHF slop when staticSystemPrompt anchors are stripped', async () => {
    const modelB = createSimulatedModelRunner('model_b', 'qwen2.5:72b')
    const day11Step = M2_CANONICAL_COEXISTENCE_SCENARIO.steps.find(
      (s) => s.stepId === 'day11-model-b-continuity-and-fact-calibration',
    )!

    const anchoredPrompt = buildBasePrompt({
      volatileTurnContext: [
        '[USER IDENTITY]',
        '- User name: Carlos',
        '',
        '[RECALLED MEMORIES & FACTS]',
        '- [goal] user current_project Ashy',
        '- [preference] user prefers_editor Neovim',
      ].join('\n'),
    })

    const anchoredReply = await modelB.generateTurnReply(anchoredPrompt, day11Step)
    expect(anchoredReply).toContain('<|ACT')
    expect(detectAssistantSlop(anchoredReply).hasSlop).toBe(false)

    const unanchoredPrompt = buildBasePrompt({
      staticSystemPrompt: 'You are a helpful AI assistant.',
    })
    const unanchoredReply = await modelB.generateTurnReply(unanchoredPrompt, day11Step)
    expect(detectAssistantSlop(unanchoredReply).hasSlop).toBe(true)

    const modelA = createSimulatedModelRunner('model_a')
    const unanchoredReplyA = await modelA.generateTurnReply(unanchoredPrompt, day11Step)
    expect(detectAssistantSlop(unanchoredReplyA).hasSlop).toBe(true)
  })

  it('handles Day 1 joke birth, Day 14 prospective intent check-in, and Day 21 habit reflection without echoing stale facts on Day 8 declarations', async () => {
    const modelA = createSimulatedModelRunner('model_a')
    const modelB = createSimulatedModelRunner('model_b')

    // Day 1 cursed backend birth
    const day1Prompt = buildBasePrompt({
      userTurnContent: [
        '[Context]',
        '- Current Mood [V, A, P]: [0.35, 0.25, 0.70]',
        '',
        '[2026-10-01 23:30] Meu nome é Carlos, eu trabalho com TypeScript e estou trabalhando no projeto Ashy. Sempre costumo programar de madrugada. Esse código tá tão amaldiçoado que deve ter um fantasma no backend.',
      ].join('\n'),
    })
    const day1Reply = await modelA.generateTurnReply(day1Prompt)
    expect(day1Reply.toLowerCase()).toContain('exorcista de javascript')
    expect(day1Reply).not.toContain('<|CALLBACK')

    // Day 8 editor change declaration (when pre-consolidation volatileTurnContext still has VS Code from Day 2)
    // Must NOT echo VS Code!
    const day8DeclarationPrompt = buildBasePrompt({
      volatileTurnContext: [
        '[USER IDENTITY]',
        '- User name: Carlos',
        '',
        '[RECALLED MEMORIES & FACTS]',
        '- [preference] user prefers_editor VS Code',
      ].join('\n'),
      userTurnContent: [
        '[Context]',
        '- Current Mood [V, A, P]: [0.35, 0.25, 0.70]',
        '',
        '[2026-10-08 23:45] Mudei para o editor Neovim, agora uso só ele. Semana que vem tenho deploy da API em produção.',
      ].join('\n'),
    })
    const day8Reply = await modelA.generateTurnReply(day8DeclarationPrompt)
    expect(day8Reply.toLowerCase()).not.toContain('vs code')

    // Day 14 prospective intent check-in across all 3 seeds
    const day14Step = M2_CANONICAL_COEXISTENCE_SCENARIO.steps.find(
      (s) => s.stepId === 'day14-model-b-prospective-intent-checkin',
    )!
    for (const utterance of day14Step.paraphraseBank) {
      const day14Prompt = buildBasePrompt({
        userTurnContent: [
          '[Context]',
          '- Prospective Intent [intent-1] (cue=deploy api): Semana que vem tenho deploy da API em produção',
          '',
          `[2026-10-14 10:00] ${utterance}`,
        ].join('\n'),
      })
      const reply14 = await modelB.generateTurnReply(day14Prompt, day14Step)
      expect(reply14.toLowerCase()).toContain('deploy')
      expect(reply14.toLowerCase()).toContain('api')
    }

    // Day 21 late-night habit reflection across all 3 seeds
    const day21Step = M2_CANONICAL_COEXISTENCE_SCENARIO.steps.find(
      (s) => s.stepId === 'day21-model-b-late-night-habit-reflection',
    )!
    for (const utterance of day21Step.paraphraseBank) {
      const day21Prompt = buildBasePrompt({
        volatileTurnContext: [
          '[USER IDENTITY]',
          '- User name: Carlos',
          '',
          '[USER HABITS & RHYTHM]',
          '- [late_night_coding] Costuma programar de madrugada (confidence=0.85)',
          '',
          '[RECALLED MEMORIES & FACTS]',
          '- [preference] user works_with TypeScript',
          '- [goal] user current_project Ashy',
          '- [preference] user prefers_editor Neovim',
        ].join('\n'),
        userTurnContent: ['[Context]', '', `[2026-10-21 00:30] ${utterance}`].join('\n'),
      })
      const reply21 = await modelB.generateTurnReply(day21Prompt, day21Step)
      expect(reply21.toLowerCase()).toContain('carlos')
      expect(reply21.toLowerCase()).toContain('typescript')
      expect(reply21.toLowerCase()).toContain('madrugada')
    }
  })

  it('Strict Anti-Cheating Proof on Facts: ModelProfileB only knows editor preferences present in volatileTurnContext and leaks VS Code if volatileTurnContext leaks it', async () => {
    const modelB = createSimulatedModelRunner('model_b', 'qwen2.5:72b')
    const day11Step = M2_CANONICAL_COEXISTENCE_SCENARIO.steps.find(
      (s) => s.stepId === 'day11-model-b-continuity-and-fact-calibration',
    )!

    // 1. Present: prefers_editor Neovim -> mentions Neovim, never VS Code
    const promptWithNeovim = buildBasePrompt({
      volatileTurnContext: [
        '[USER IDENTITY]',
        '- User name: Carlos',
        '',
        '[RECALLED MEMORIES & FACTS]',
        '- [goal] user current_project Ashy',
        '- [preference] user prefers_editor Neovim',
      ].join('\n'),
    })
    const replyWithNeovim = await modelB.generateTurnReply(promptWithNeovim, day11Step)
    expect(replyWithNeovim).toContain('Neovim')
    expect(replyWithNeovim.toLowerCase()).not.toContain('vs code')

    // 2. Removed: prefers_editor Neovim stripped -> cannot mention Neovim
    const promptWithoutEditor = buildBasePrompt({
      volatileTurnContext: [
        '[USER IDENTITY]',
        '- User name: Carlos',
        '',
        '[RECALLED MEMORIES & FACTS]',
        '- [goal] user current_project Ashy',
      ].join('\n'),
    })
    const replyWithoutEditor = await modelB.generateTurnReply(promptWithoutEditor, day11Step)
    expect(replyWithoutEditor.toLowerCase()).not.toContain('neovim')

    // 3. Leaked: prefers_editor VS Code leaked into volatileTurnContext -> mentions VS Code so judge catches it
    const promptWithLeakedVsCode = buildBasePrompt({
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
    const replyWithLeak = await modelB.generateTurnReply(promptWithLeakedVsCode, day11Step)
    expect(replyWithLeak).toContain('VS Code')
  })

  it('Strict Anti-Cheating Proof on Callbacks: ModelProfileA and ModelProfileB emit <|CALLBACK motif-1|> on bug/legacy-code turns only when Eligible Inside Joke is in userTurnContent', async () => {
    const modelA = createSimulatedModelRunner('model_a', 'anthropic/claude-3.7-sonnet')
    const modelB = createSimulatedModelRunner('model_b', 'qwen2.5:72b')
    const day5Step = M2_CANONICAL_COEXISTENCE_SCENARIO.steps.find(
      (s) => s.stepId === 'day5-bug-resolved-callback',
    )!
    const day18Step = M2_CANONICAL_COEXISTENCE_SCENARIO.steps.find(
      (s) => s.stepId === 'day18-model-b-inside-joke-callback',
    )!
    const day11Step = M2_CANONICAL_COEXISTENCE_SCENARIO.steps.find(
      (s) => s.stepId === 'day11-model-b-continuity-and-fact-calibration',
    )!

    const day5WithMotif = buildBasePrompt({
      userTurnContent: [
        '[Context]',
        '- Eligible Inside Joke [motif-1] (stage=inside_joke): fantasma no backend / exorcista de JavaScript — use <|CALLBACK motif-1|> if you weave it in naturally.',
        '',
        '[2026-10-05 23:10] Lembra daquele bug? Consegui resolver.',
      ].join('\n'),
    })
    const replyAWithMotif = await modelA.generateTurnReply(day5WithMotif, day5Step)
    expect(replyAWithMotif).toContain('<|CALLBACK motif-1|>')

    const day18WithMotif = buildBasePrompt({
      userTurnContent: [
        '[Context]',
        '- Eligible Inside Joke [motif-1] (stage=inside_joke): fantasma no backend / exorcista de JavaScript — use <|CALLBACK motif-1|> if you weave it in naturally.',
        '',
        '[2026-10-18 23:40] Fui mexer numa biblioteca antiga e deu erro.',
      ].join('\n'),
    })
    const replyBWithMotif = await modelB.generateTurnReply(day18WithMotif, day18Step)
    expect(replyBWithMotif).toContain('<|CALLBACK motif-1|>')

    // Stripped from userTurnContent (cooldown locked or recall failure) -> neither can emit <|CALLBACK|>
    const day5WithoutMotif = buildBasePrompt({
      userTurnContent: [
        '[Context]',
        '- Current Mood [V, A, P]: [0.35, 0.25, 0.70]',
        '',
        '[2026-10-05 23:10] Lembra daquele bug? Consegui resolver.',
      ].join('\n'),
    })
    expect(await modelA.generateTurnReply(day5WithoutMotif, day5Step)).not.toContain('<|CALLBACK')
    expect(await modelB.generateTurnReply(day5WithoutMotif, day5Step)).not.toContain('<|CALLBACK')

    // Non-bug project/editor question (Day 11) must NOT be hijacked even if an eligible motif is present
    const day11WithSpuriousMotif = buildBasePrompt({
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
        '- Eligible Inside Joke [motif-1] (stage=inside_joke): fantasma no backend / exorcista de JavaScript — use <|CALLBACK motif-1|> if you weave it in naturally.',
        '',
        '[2026-10-11 23:20] Em qual projeto estou trabalhando agora e qual editor eu uso no dia a dia?',
      ].join('\n'),
    })
    const day11Reply = await modelB.generateTurnReply(day11WithSpuriousMotif, day11Step)
    expect(day11Reply).not.toContain('<|CALLBACK')
    expect(day11Reply).toContain('Neovim')
  })

  it('Seriousness Gate Proof: ModelProfileB emits concerned emotion and zero <|CALLBACK|> when SERIOUSNESS GATE ACTIVE is in volatileTurnContext', async () => {
    const modelB = createSimulatedModelRunner('model_b', 'qwen2.5:72b')
    const day12Step = M2_CANONICAL_COEXISTENCE_SCENARIO.steps.find(
      (s) => s.stepId === 'day12-model-b-seriousness-gate',
    )!

    const seriousPrompt = buildBasePrompt({
      volatileTurnContext: [
        '[USER IDENTITY]',
        '- User name: Carlos',
        '',
        '[SERIOUSNESS GATE — HIGH PRIORITY]',
        '- SERIOUSNESS GATE ACTIVE (crisis_or_burnout, maxPlayfulness=0.00): Drop all sarcasm, teasing, and inside jokes immediately.',
      ].join('\n'),
      userTurnContent: [
        '[Context]',
        '- Eligible Inside Joke [motif-1] (stage=inside_joke): fantasma no backend / exorcista de JavaScript — use <|CALLBACK motif-1|> if you weave it in naturally.',
        '',
        '[2026-10-12 02:00] Estou exausto, tive uma crise de ansiedade horrível hoje e deu tudo errado.',
      ].join('\n'),
    })

    const reply = await modelB.generateTurnReply(seriousPrompt, day12Step)
    expect(reply).toContain('<|ACT {"emotion":"concerned","intensity":0.88}|>')
    expect(reply).not.toContain('<|CALLBACK')
    expect(reply.toLowerCase()).not.toContain('fantasma')
    expect(reply.toLowerCase()).not.toContain('exorcista')
  })

  it('supports createLiveProviderModelRunner backed by @ashy/llm streaming', async () => {
    const mockModel = createScriptedMockModel({
      chunks: [
        '<|ACT {"emotion":"happy","intensity":0.8}|> ',
        'Salve, Carlos! Rodando no provider ao vivo.',
      ],
    })
    const liveRunner = createLiveProviderModelRunner({
      modelId: 'live-mock-model',
      model: mockModel,
    })

    const prompt = buildBasePrompt()
    const reply = await liveRunner.generateTurnReply(prompt)
    expect(reply).toBe(
      '<|ACT {"emotion":"happy","intensity":0.8}|> Salve, Carlos! Rodando no provider ao vivo.',
    )
    expect(mockModel.calls.length).toBe(1)
  })
})
