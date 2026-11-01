/**
 * 2026-11-01 — small-model conversation quality: call memory selection (clean, user-centric lines only)
 * and the voice-turn recorder never indexing Ashy's bad replies.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SemanticFact } from '@ashy/shared'
import { renderUserFact, selectCallMemoryLines } from '../host/live-call/call-memory'
import { createCallRecorder, memoryWorthyAssistantText } from '../host/live-call/recorder'

const POISONED = [
  {
    title: 'Me conta uma curiosidade sobre o espaço.',
    summary: 'Usuário: Olá. | Ashy: Olá, Carlos! Tudo bem. Como posso te ajudar hoje?',
    content:
      'Usuário: Olá.\nAshy: Olá, Carlos! Tudo bem. Como posso te ajudar hoje?\nUsuário: O que você sabe fazer?\nAshy: O que você sabe fazer?\nUsuário: Me conta uma curiosidade sobre o espaço.\nAshy: Me conta uma curiosidade sobre o espaço.',
  },
  {
    title: 'O que você sabe fazer?',
    summary: 'Usuário: O que você sabe fazer? | Ashy: O que você sabe fazer?',
    content: 'Usuário: O que você sabe fazer?\nAshy: O que você sabe fazer?',
  },
  { title: '[Mensagem de voz Omni]', summary: 'Usuário: [Mensagem de voz Omni] | Ashy: Carlos, o que você quer?', content: '' },
]

function fact(id: string, predicate: string, object: string, extra: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id,
    category: 'relationship',
    subject: 'user',
    predicate,
    object,
    confidence: 0.9,
    sourceEpisodeIds: [],
    validFrom: 0,
    invalidAt: null,
    approvalStatus: 'approved',
    ...extra,
  } as SemanticFact
}

describe('selectCallMemoryLines', () => {
  it('drops a poisoned store entirely: no Ashy wording, no greetings, no questions, no placeholders', () => {
    for (const userText of ['Olá.', 'O que você sabe fazer?', 'Me conta uma curiosidade sobre o espaço.']) {
      const out = selectCallMemoryLines({ episodes: POISONED, userText, userLabel: 'Carlos' })
      expect(out.lines).toEqual([])
      expect(out.usedEpisodeIndexes).toEqual([])
    }
  })

  it('keeps the user side of real disclosures, with the user name, and never Ashy lines', () => {
    const episodes = [
      {
        summary: 'Usuário: Meu gato se chama Biscoito e adora dormir no teclado. | Ashy: Que fofo!',
        content: 'Usuário: Meu gato se chama Biscoito e adora dormir no teclado.\nAshy: Que fofo! O Biscoito tem bom gosto.',
      },
    ]
    const out = selectCallMemoryLines({ episodes, userText: 'Lembra do meu gato?', userLabel: 'Carlos' })
    expect(out.lines).toEqual(['Carlos contou: Meu gato se chama Biscoito e adora dormir no teclado.'])
    expect(out.lines.join(' ')).not.toMatch(/Ashy|fofo/)
    expect(out.usedEpisodeIndexes).toEqual([0])
  })

  it('keeps the statement a recall question is about (not filtered as an echo)', () => {
    const episodes = [{ summary: 'Usuário: Hoje eu comecei a aprender violão.', content: 'Usuário: Hoje eu comecei a aprender violão.' }]
    const out = selectCallMemoryLines({ episodes, userText: 'Lembra o que eu comecei a aprender hoje?', userLabel: 'Carlos' })
    expect(out.lines).toEqual(['Carlos contou: Hoje eu comecei a aprender violão.'])
  })

  it('skips memories identical to the current utterance and dedupes', () => {
    const episodes = [
      { summary: 'Usuário: Eu trabalho com desenvolvimento de jogos.', content: '' },
      { summary: 'Usuário: Eu trabalho com desenvolvimento de jogos!', content: '' },
    ]
    expect(selectCallMemoryLines({ episodes, userText: 'Eu trabalho com desenvolvimento de jogos.' }).lines).toEqual([])
    expect(selectCallMemoryLines({ episodes, userText: 'Com o que eu trabalho mesmo?', userLabel: 'Carlos' }).lines).toHaveLength(1)
  })

  it('injects user facts touched by the utterance (name/pronouns excluded) before episodes', () => {
    const facts = [
      fact('f1', 'named:gato', 'Biscoito'),
      fact('f2', 'works_with', 'desenvolvimento de jogos', { category: 'preference' }),
      fact('f3', 'name', 'Carlos', { category: 'identity' }),
      fact('f4', 'named:irmã', 'Ana', { approvalStatus: 'pending_review' }),
      fact('f5', 'lives_in', 'Recife', { invalidAt: 5 }),
    ]
    const cat = selectCallMemoryLines({ episodes: [], facts, userText: 'Qual é o nome do meu gato?', userLabel: 'Carlos' })
    expect(cat.lines).toEqual(['gato de Carlos se chama Biscoito'])
    const work = selectCallMemoryLines({ episodes: [], facts, userText: 'E com o que eu trabalho mesmo?', userLabel: 'Carlos' })
    expect(work.lines).toEqual(['Carlos trabalha com desenvolvimento de jogos'])
    expect(selectCallMemoryLines({ episodes: [], facts, userText: 'Oi, tudo bem?' }).lines).toEqual([])
  })

  it('respects the line and char budgets', () => {
    const episodes = Array.from({ length: 8 }, (_, i) => ({
      summary: `Usuário: Eu fiz uma coisa muito diferente número ${i} na viagem para a praia com amigos`,
      content: '',
    }))
    const out = selectCallMemoryLines({ episodes, userText: 'viagem praia', maxLines: 3, maxChars: 360 })
    expect(out.lines.length).toBeLessThanOrEqual(3)
    expect(out.lines.join('').length).toBeLessThanOrEqual(360)
  })

  it('renders facts in pt-BR', () => {
    expect(renderUserFact({ predicate: 'likes:rock', object: 'rock dos anos 80' }, 'Carlos').text).toBe('Carlos gosta de rock dos anos 80')
    expect(renderUserFact({ predicate: 'lives_in', object: 'Recife' }, 'Carlos').text).toBe('Carlos mora em Recife')
  })
})

describe('call recorder memory hygiene', () => {
  it('memoryWorthyAssistantText drops echoes, greeting-only replies and near-repeats', () => {
    expect(memoryWorthyAssistantText({ userText: 'O que você sabe fazer?', assistantText: 'O que você sabe fazer?' })).toBe('')
    expect(memoryWorthyAssistantText({ userText: 'Olá.', assistantText: 'Olá, Carlos! Tudo bem. Como posso te ajudar hoje?' })).toBe('')
    expect(
      memoryWorthyAssistantText({
        userText: 'E aí?',
        assistantText: 'No espaço não existe som, porque não há ar.',
        recentReplies: ['No espaço não existe som porque não há ar!'],
      }),
    ).toBe('')
    expect(memoryWorthyAssistantText({ userText: 'Me conta algo do espaço.', assistantText: 'No espaço não existe som.' })).toBe(
      'No espaço não existe som.',
    )
  })

  function fakeCortex() {
    let n = 0
    return {
      appendVoiceTurn: vi.fn((input: { userTranscript: string; assistantSpokenText: string }) => ({
        userMessage: input.userTranscript ? { id: `u${++n}`, content: input.userTranscript } : null,
        assistantMessage: { id: `a${++n}`, content: input.assistantSpokenText },
      })),
      applyUserTurnAffect: vi.fn(),
      indexTurnMemory: vi.fn(() => ({ episodeCreated: true, factsCreated: 0 })),
      reviewTurnMemories: vi.fn(),
      consolidateSessionMemories: vi.fn(async () => ({})),
    }
  }

  it('persists what Ashy said but indexes an echo / greeting loop as the user side only', async () => {
    const cortex = fakeCortex()
    const recorder = createCallRecorder({ getCortex: () => cortex as never, emit: () => {} })
    const base = { callId: 'c1', sessionId: 's1', backendId: 'llamacpp-hybrid', interrupted: false }
    await recorder.recordTurn({ ...base, userTranscript: 'O que você sabe fazer?', assistantSpokenText: 'O que você sabe fazer?' })
    await recorder.recordTurn({ ...base, userTranscript: 'Me conta uma curiosidade sobre o espaço.', assistantSpokenText: 'No espaço não existe som.' })
    await recorder.recordTurn({ ...base, userTranscript: 'E outra?', assistantSpokenText: 'No espaço não existe som!' })
    expect(cortex.appendVoiceTurn.mock.calls[0]![0].assistantSpokenText).toBe('O que você sabe fazer?')
    const indexed = cortex.indexTurnMemory.mock.calls.map((c) => (c as unknown as [{ assistantText: string }])[0].assistantText)
    expect(indexed).toEqual(['', 'No espaço não existe som.', ''])
  })

  it('never feeds placeholder transcripts to affect or memory', async () => {
    const cortex = fakeCortex()
    const recorder = createCallRecorder({ getCortex: () => cortex as never, emit: () => {} })
    await recorder.recordTurn({
      callId: 'c1',
      sessionId: 's1',
      backendId: 'llamacpp-realtime',
      interrupted: false,
      userTranscript: '[Mensagem de voz Omni]',
      assistantSpokenText: 'Oi!',
    })
    expect(cortex.appendVoiceTurn).toHaveBeenCalledTimes(1)
    expect(cortex.applyUserTurnAffect).not.toHaveBeenCalled()
    expect(cortex.indexTurnMemory).not.toHaveBeenCalled()
  })
})

describe('call context for small models', () => {
  it('instructions name the speaker roles, greet once, forbid echo, and keep the mode line last', async () => {
    const { buildCallInstructions, CALL_INSTRUCTIONS_TOOLS_TEXT_MODE_LINE } = await import('../host/live-call/context')
    const text = buildCallInstructions({ userName: 'Carlos', mode: 'text', tools: true })
    expect(text).toContain("You are Ashy, Carlos's AI companion")
    expect(text).toContain('never call Carlos "Ashy"')
    expect(text).toContain('Greet only once')
    expect(text).toContain("Never repeat Carlos's words back")
    expect(text.endsWith(CALL_INSTRUCTIONS_TOOLS_TEXT_MODE_LINE)).toBe(true)
    expect(text.length).toBeLessThanOrEqual(1200)
    expect(buildCallInstructions({})).toContain('never call the user "Ashy"')
  })

  it('time / mood go on the first turn only (then on change or every 10 min), memories when relevant', async () => {
    const { createCallContextBuilder } = await import('../host/live-call/context')
    let t = Date.parse('2026-11-01T03:00:00Z')
    const mood = { valence: 0.5, arousal: 0.7, playfulness: 0.6 } as never
    const builder = createCallContextBuilder({
      retrieveMemories: (u) => ({ memories: u.includes('gato') ? ['gato de Carlos se chama Biscoito'] : [] }),
      getMood: () => mood,
      getUserName: () => 'Carlos',
      now: () => new Date(t),
    })
    const first = await builder.build({ sessionId: 's', userText: 'Oi!' })
    expect(first.perTurnContext).toContain('Hora local:')
    const second = await builder.build({ sessionId: 's', userText: 'Tudo certo por aí?' })
    expect(second.perTurnContext).toBe('')
    const third = await builder.build({ sessionId: 's', userText: 'Qual o nome do meu gato?' })
    expect(third.perTurnContext).not.toContain('Hora local:')
    expect(third.perTurnContext).toContain('- gato de Carlos se chama Biscoito')
    t += 11 * 60_000
    expect((await builder.build({ sessionId: 's', userText: 'E aí?' })).perTurnContext).toContain('Hora local:')
    expect((await builder.build({ sessionId: 'other', userText: 'Oi!' })).perTurnContext).toContain('Hora local:')
  })
})

describe('live-mode settings migration', () => {
  it('migrates the 10.2 rotateAfterTurns default (6, fed the greeting loop) to the current default', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const { createLiveModeSettingsStore, LIVE_MODE_SETTINGS_FILE } = await import('../host/live-call/settings')
    const { DEFAULT_LIVE_MODE_SETTINGS } = await import('@ashy/shared')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-live-settings-'))
    try {
      fs.writeFileSync(path.join(dir, LIVE_MODE_SETTINGS_FILE), JSON.stringify({ session: { rotateAfterTurns: 6 } }))
      expect(createLiveModeSettingsStore({ userDataDir: dir }).get().session.rotateAfterTurns).toBe(
        DEFAULT_LIVE_MODE_SETTINGS.session.rotateAfterTurns,
      )
      fs.writeFileSync(path.join(dir, LIVE_MODE_SETTINGS_FILE), JSON.stringify({ session: { rotateAfterTurns: 12 } }))
      expect(createLiveModeSettingsStore({ userDataDir: dir }).get().session.rotateAfterTurns).toBe(12)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('selectCallMemoryLines relevance', () => {
  it('never injects a statement that shares no word with the utterance', () => {
    const episodes = [{ summary: 'Usuário: Hoje eu comecei a aprender violão.', content: '' }]
    expect(selectCallMemoryLines({ episodes, userText: 'Me dá uma dica pra dormir melhor.', userLabel: 'Carlos' }).lines).toEqual([])
    expect(selectCallMemoryLines({ episodes, userText: 'Como vai o violão?', userLabel: 'Carlos' }).lines).toHaveLength(1)
  })
})
