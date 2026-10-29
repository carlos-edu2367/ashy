import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AshyHostStreamEvent } from '@ashy/shared'
import { createAshyHostKernel } from '../host/kernel'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-host-kernel-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('AshyHostKernel & TurnOrchestrator', () => {
  it('boots clean with needsOnboarding=true, completes Phase 0 onboarding, and persists first_meeting across restarts', async () => {
    const dir = makeTempDir()
    const kernel1 = await createAshyHostKernel({ userDataDir: dir })

    const boot1 = await kernel1.getBootstrapSnapshot()
    expect(boot1.needsOnboarding).toBe(true)
    expect(boot1.memories.facts).toHaveLength(0)
    expect(boot1.memories.episodes).toHaveLength(0)
    expect(boot1.messages).toHaveLength(0)

    const afterOnboarding = await kernel1.completeOnboarding({
      userName: 'Carlos',
      userPronouns: 'ele/dele',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    expect(afterOnboarding.needsOnboarding).toBe(false)
    expect(afterOnboarding.userProfile.userName).toBe('Carlos')
    expect(afterOnboarding.userProfile.userPronouns).toBe('ele/dele')
    expect(
      afterOnboarding.relationship.milestones.some((m) => m.category === 'first_meeting'),
    ).toBe(true)
    expect(afterOnboarding.providers.hasActiveReadyProvider).toBe(true)

    await kernel1.stop()

    // Restart kernel on same directory
    const kernel2 = await createAshyHostKernel({ userDataDir: dir })
    const boot2 = await kernel2.getBootstrapSnapshot()
    expect(boot2.needsOnboarding).toBe(false)
    expect(boot2.userProfile.userName).toBe('Carlos')
    expect(boot2.userProfile.userPronouns).toBe('ele/dele')
    await kernel2.stop()
  })

  it('streams a real turn, parses <|ACT|> and <|CALLBACK|> markers, applies affect/joke updates, and indexes FTS5 memories', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"<|ACT {\\"emotion\\":\\"tease\\",\\"intensity\\":0.85}|>"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"<|CALLBACK motif-padre-npm|>"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Oi Carlos, trabalhando no "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"banco SQLite até tarde?"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    await kernel.seedDemoFixtures()
    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Estou configurando o banco SQLite e o runtime real do projeto Ashy.',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:completed')).toBe(true)
    })

    unsub()

    const completed = events.find((e) => e.type === 'turn:completed')
    expect(completed?.type).toBe('turn:completed')
    if (completed?.type === 'turn:completed') {
      expect(completed.assistantMessage.content).toBe(
        'Oi Carlos, trabalhando no banco SQLite até tarde?',
      )
      expect(completed.assistantMessage.emotion).toBe('tease')
      expect(completed.snapshot.memories.episodes.length).toBeGreaterThan(0)
      const padreMotif = completed.snapshot.memories.jokes.find(
        (j) => j.id === 'motif-padre-npm',
      )
      expect(padreMotif?.timesUsed).toBe(4)
    }

    await kernel.stop()
  })

  it('[Adversarial] sending a turn when no provider is configured emits turn:error with code PROVIDER_NOT_CONFIGURED', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })

    // Complete onboarding without providerConfig ("configure later")
    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
    })
    expect(snap.providers.hasActiveReadyProvider).toBe(false)

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    const { turnId, userMessage } = await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Oi Ashy, está me ouvindo sem provedor configurado?',
    })

    expect(userMessage.content).toBe('Oi Ashy, está me ouvindo sem provedor configurado?')

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:error')).toBe(true)
    })

    unsub()

    const errEvent = events.find((e) => e.type === 'turn:error')
    expect(errEvent).toBeDefined()
    if (errEvent?.type === 'turn:error') {
      expect(errEvent.turnId).toBe(turnId)
      expect(errEvent.code).toBe('PROVIDER_NOT_CONFIGURED')
      expect(errEvent.recoverable).toBe(true)
    }

    await kernel.stop()
  })

  it('[Adversarial] aborting an in-flight turn or starting a concurrent turn on the same session aborts the running stream and emits turn:aborted', async () => {
    const dir = makeTempDir()
    let callCount = 0

    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      callCount += 1
      const currentCall = callCount
      const encoder = new TextEncoder()

      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: {"choices":[{"delta":{"content":"Parcial ${currentCall}..."}}]}\n\n`,
            ),
          )
          if (currentCall <= 2) {
            // Keep stream open until aborted
            await new Promise<void>((resolve) => {
              init?.signal?.addEventListener('abort', () => resolve(), { once: true })
            })
            try {
              controller.close()
            } catch {
              // ignore
            }
            return
          }
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":" resposta final concluída."}}]}\n\ndata: [DONE]\n\n',
            ),
          )
          controller.close()
        },
      })

      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    // 1. Start turn 1 and explicitly abort it after first delta arrives
    const turn1 = await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Primeira mensagem longa que será abortada manualmente.',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:delta' && e.turnId === turn1.turnId)).toBe(true)
    })

    await kernel.abortTurn(turn1.turnId)

    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'turn:aborted' && e.turnId === turn1.turnId),
      ).toBe(true)
    })

    // 2. Start turn 2, then immediately send turn 3 on the same session to trigger concurrent auto-abort
    const turn2 = await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Segunda mensagem que será substituída por um envio concorrente.',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:delta' && e.turnId === turn2.turnId)).toBe(true)
    })

    const turn3 = await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Terceira mensagem concorrente na mesma sessão.',
    })

    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'turn:aborted' && e.turnId === turn2.turnId),
      ).toBe(true)
      expect(
        events.some((e) => e.type === 'turn:completed' && e.turnId === turn3.turnId),
      ).toBe(true)
    })

    unsub()
    await kernel.stop()
  })

  it('[Adversarial] emits turn:keepalive when LLM stream emits only <think> reasoning deltas for longer than keepaliveIntervalMs', async () => {
    const dir = makeTempDir()
    const encoder = new TextEncoder()

    const mockFetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"<think>Analisando arquitetura profunda..."}}]}\n\n',
            ),
          )
          await new Promise((r) => setTimeout(r, 70))
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":" mais raciocínio interno</think>Pronto, Carlos!"}}]}\n\ndata: [DONE]\n\n',
            ),
          )
          controller.close()
        },
      })

      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
      keepaliveIntervalMs: 25,
    })

    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'deepseek/deepseek-r1',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Pense profundamente sobre o design do nosso banco de dados.',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:completed')).toBe(true)
    })

    unsub()

    const keepalives = events.filter((e) => e.type === 'turn:keepalive')
    expect(keepalives.length).toBeGreaterThanOrEqual(1)

    const completed = events.find((e) => e.type === 'turn:completed')
    if (completed?.type === 'turn:completed') {
      expect(completed.assistantMessage.content).toBe('Pronto, Carlos!')
      expect(completed.assistantMessage.content).not.toContain('Analisando arquitetura')
    }

    await kernel.stop()
  })

  it('[Adversarial] isolates post-turn SQLite persistence failures so turn:completed still delivers the assistant response with persistenceWarning populated', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"Resposta entregue mesmo com falha de disco."}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    // Simulate post-turn SQLite failure during appendChatMessage for the assistant turn
    const origAppend = kernel.cortex.appendChatMessage.bind(kernel.cortex)
    vi.spyOn(kernel.cortex, 'appendChatMessage').mockImplementation((msg) => {
      if (msg.role === 'assistant') {
        throw new Error('SQLITE_FULL: database or disk is full')
      }
      return origAppend(msg)
    })

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Testando isolamento de falha de persistência pós-turno.',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:completed')).toBe(true)
    })

    unsub()

    const completed = events.find((e) => e.type === 'turn:completed')
    expect(completed?.type).toBe('turn:completed')
    if (completed?.type === 'turn:completed') {
      expect(completed.assistantMessage.content).toBe(
        'Resposta entregue mesmo com falha de disco.',
      )
      expect(completed.persistenceWarning).toContain('SQLITE_FULL')
      expect(completed.snapshot.runtimeDiagnostics.lastPersistenceWarning).toContain(
        'SQLITE_FULL',
      )
    }

    await kernel.stop()
  })

  it('hot-loads edited voice.md into the next turn prompt and supports session & memory CRUD', async () => {
    const dir = makeTempDir()
    let lastRequestBody: Record<string, unknown> | null = null

    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        lastRequestBody = JSON.parse(init.body) as Record<string, unknown>
      }
      const sse =
        'data: {"choices":[{"delta":{"content":"Voz customizada ativa."}}]}\n\ndata: [DONE]\n\n'
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    // Save custom voice.md and verify hot-load on next turn
    const savedVoice = await kernel.saveVoiceIdentity(
      '# Ashy Custom Voice\nSempre mencione café expresso duplo da madrugada.',
    )
    expect(savedVoice.diagnostics.status).toBe('ok')

    const newSession = await kernel.createSession('Sessão de Arquitetura 02h')
    const selected = await kernel.selectSession(newSession.id)
    expect(selected.session.title).toBe('Sessão de Arquitetura 02h')

    const fact1 = await kernel.upsertSemanticFact({
      category: 'preference',
      subject: 'user',
      predicate: 'drink',
      object: 'Chá verde',
    })
    const fact2 = await kernel.upsertSemanticFact({
      category: 'preference',
      subject: 'user',
      predicate: 'drink',
      object: 'Café expresso duplo',
    })
    expect(fact2.id).not.toBe(fact1.id)

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    await kernel.sendTurn({
      sessionId: newSession.id,
      text: 'Qual é a boa desta madrugada no nosso estúdio?',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:completed')).toBe(true)
    })
    unsub()

    expect(JSON.stringify(lastRequestBody)).toContain(
      'Sempre mencione café expresso duplo da madrugada.',
    )

    await kernel.deleteMemoryItem({ kind: 'fact', id: fact2.id })
    const snapAfterDelete = await kernel.getBootstrapSnapshot()
    expect(snapAfterDelete.memories.facts.some((f) => f.id === fact2.id)).toBe(false)

    await kernel.stop()
  })

  it('forwards interruptionControlNote from sendTurn into cortex.compileTurnPrompt so the LLM receives [VOICE BARGE-IN RECEIPT]', async () => {
    const dir = makeTempDir()
    let lastRequestBody: Record<string, unknown> | null = null

    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        lastRequestBody = JSON.parse(init.body) as Record<string, unknown>
      }
      const sse =
        'data: {"choices":[{"delta":{"content":"Entendi a interrupção, vamos direto ao ponto!"}}]}\n\ndata: [DONE]\n\n'
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    const note =
      '[Interrupted after 900ms — user heard: "Olha só" | unheard: "o resto da frase."]'

    await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Espera, foca só no banco de dados agora!',
      interruptionControlNote: note,
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:completed')).toBe(true)
    })
    unsub()

    const serializedBody = JSON.stringify(lastRequestBody)
    expect(serializedBody).toContain('[VOICE BARGE-IN RECEIPT]')
    expect(serializedBody).toContain('Interrupted after 900ms')
    expect(serializedBody).toContain('Voice Barge-In Receipt:')

    await kernel.stop()
  })
})
