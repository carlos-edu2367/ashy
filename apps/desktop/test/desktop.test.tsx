import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAshyHostKernel, type AshyHostKernel } from '../src/host/kernel'
import {
  App,
  createAshyElectronOverlayConfig,
  useAshyStore,
} from '../src/index'
import { setAshyHostBridgeForTesting } from '../src/services/ashy-host-client'

const tempDirs: string[] = []
const activeKernels: AshyHostKernel[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-desktop-test-'))
  tempDirs.push(dir)
  return dir
}

describe('@ashy/desktop — Phase 7 Companion Hub, Floating Stage Overlay & Full-Stack Integration', () => {
  beforeEach(async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const bodyStr = typeof init?.body === 'string' ? init.body : ''
      let replyDelta = ''

      if (bodyStr.includes('SERIOUSNESS GATE ACTIVE')) {
        replyDelta =
          '<|ACT {"emotion":"concerned","intensity":0.9}|> Ei... respira um segundo. Hoje foi pesado demais mesmo. <|DELAY 0.4|> Larga esse teclado um pouco, eu seguro as pontas por aqui — me conta o que aconteceu se quiser desabafar, ou a gente só fica quieto um instante.'
      } else if (bodyStr.includes('Eligible Inside Joke [motif-padre-npm]')) {
        replyDelta =
          '<|ACT {"emotion":"smug","intensity":0.88}|> Silêncio suspeito no sistema nunca me engana. <|DELAY 0.35|> Já preparei o trace completo e se esse estado fantasma piscar de novo, a gente vai precisar chamar um padre no npm (<|CALLBACK motif-padre-npm|>) antes do próximo deploy.'
      } else {
        replyDelta =
          '<|ACT {"emotion":"tease","intensity":0.84}|> Essa piada já entrou em Cooldown Lock pra não saturar, mas meu radar de arquitetura continua afiado! <|DELAY 0.3|> Manda o próximo módulo que a gente destrincha em tempo real.'
      }

      const sse = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: replyDelta } }] })}\n\n`,
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
    activeKernels.push(kernel)
    await kernel.seedDemoFixtures()
    await kernel.saveProviderConfig({
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'anthropic/claude-3.7-sonnet',
      apiKey: 'sk-or-v1-testkey1234',
    })
    await kernel.setActiveProvider('openrouter')
    setAshyHostBridgeForTesting(kernel)
    useAshyStore.getState().resetStoreForTesting()
    await useAshyStore.getState().bootstrapFromHost()
  })

  afterEach(async () => {
    setAshyHostBridgeForTesting(null)
    while (activeKernels.length > 0) {
      await activeKernels.pop()!.stop()
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  it('1. renders App in both Companion Hub mode (all 5 tabs) and Floating Stage Overlay mode with AshyStageCanvas', () => {
    const store = useAshyStore.getState()
    expect(store.viewMode).toBe('hub')
    expect(store.activeTab).toBe('studio')

    const hubHtml = renderToStaticMarkup(<App />)
    expect(hubHtml).toContain('data-testid="ashy-stage-canvas"')
    expect(hubHtml).toContain('data-testid="tab-studio"')
    expect(hubHtml).toContain('data-testid="tab-story"')
    expect(hubHtml).toContain('data-testid="tab-memories"')
    expect(hubHtml).toContain('data-testid="tab-personality"')
    expect(hubHtml).toContain('data-testid="tab-agency"')

    // Switch through each tab and verify rich seeded content renders
    store.setActiveTab('story')
    const storyHtml = renderToStaticMarkup(<App />)
    expect(storyHtml).toContain('First Boot &amp; Late-Night Architecture Session')
    expect(storyHtml).toContain('Saved Production Database at 03:14 AM')
    expect(storyHtml).toContain('first_meeting')
    expect(storyHtml).toContain('inside_joke_born')
    expect(storyHtml).toContain('flashbulb_moment')

    store.setActiveTab('memories')
    const memoriesHtml = renderToStaticMarkup(<App />)
    expect(memoriesHtml).toContain('chamar um padre no npm')
    expect(memoriesHtml).toContain('crime perfeito nos logs')
    expect(memoriesHtml).toContain('Matrix3D Nunca Mais')
    expect(memoriesHtml).toContain('Flashbulb')

    store.setActiveTab('personality')
    const personalityHtml = renderToStaticMarkup(<App />)
    expect(personalityHtml).toContain('data-testid="btn-trigger-dream"')
    expect(personalityHtml).toContain('witSarcasm')
    expect(personalityHtml).toContain('warmthAffection')

    store.setActiveTab('agency')
    const agencyHtml = renderToStaticMarkup(<App />)
    expect(agencyHtml).toContain('First Boot Mug')
    expect(agencyHtml).toContain('Padre no NPM Relic')
    expect(agencyHtml).toContain('03:14 AM Production Shield')
    expect(agencyHtml).toContain('search_mcp_tools')

    // Switch to Floating Stage Overlay mode
    store.setViewMode('stage')
    const stageHtml = renderToStaticMarkup(<App />)
    expect(stageHtml).toContain('data-testid="floating-stage-overlay"')
    expect(stageHtml).toContain('data-testid="ashy-stage-canvas"')
    expect(stageHtml).toContain('data-testid="btn-expand-hub"')
  })

  it('2. sending a playful message updates chat, invokes the eligible inside joke, activates Cooldown Lock, and emits stage emotion', async () => {
    const store = useAshyStore.getState()

    const beforeMotif = store.relationalMotifs.find((m) => m.id === 'motif-padre-npm')
    expect(beforeMotif).toBeDefined()
    expect(beforeMotif?.timesUsed).toBe(3)
    expect(beforeMotif?.lastUsedAt).toBeNull()

    await store.sendUserMessage(
      'O servidor deu um bug fantasma no backend sem nenhum log, vamos chamar um padre no npm?',
    )

    const updated = useAshyStore.getState()
    expect(updated.chatMessages.length).toBeGreaterThanOrEqual(2)

    const lastAssistantMsg = [...updated.chatMessages].reverse().find((m) => m.role === 'assistant')
    expect(lastAssistantMsg).toBeDefined()
    // Ensure inline <|ACT ...|> tags were stripped from literal text shown to user
    expect(lastAssistantMsg?.content).not.toContain('<|ACT')
    expect(lastAssistantMsg?.content.length).toBeGreaterThan(10)

    // Verify inside joke was invoked and placed under Cooldown Lock
    const afterMotif = updated.relationalMotifs.find((m) => m.id === 'motif-padre-npm')
    expect(afterMotif?.timesUsed).toBe(4)
    expect(afterMotif?.lastUsedAt).not.toBeNull()

    const cooldownInfo = updated.getMotifCooldownInfo('motif-padre-npm')
    expect(cooldownInfo.isCooldownLocked).toBe(true)
    expect(cooldownInfo.remainingCooldownHours).toBeGreaterThan(0)

    // Stage emotion updated to an expressive playful preset
    expect(['smug', 'tease', 'excited', 'chaotic', 'happy']).toContain(updated.stageEmotion)
  })

  it('3. sending a serious/delicate message triggers Seriousness Gate (playfulness <= 0.15, emotion concerned, zero inside jokes)', async () => {
    const store = useAshyStore.getState()

    await store.sendUserMessage('Estou exausto, deu tudo errado hoje e tô me sentindo um lixo.')

    const updated = useAshyStore.getState()
    expect(updated.lastPrompt.seriousness.isSeriousOrDelicate).toBe(true)
    expect(updated.mood.playfulness).toBeLessThanOrEqual(0.15)
    expect(updated.stageEmotion).toBe('concerned')
    expect(updated.lastPrompt.userTurnContent).toContain('SERIOUSNESS GATE ACTIVE')
    expect(updated.lastPrompt.userTurnContent).not.toContain('Eligible Inside Joke')

    const lastAssistantMsg = [...updated.chatMessages].reverse().find((m) => m.role === 'assistant')
    expect(lastAssistantMsg?.content).not.toContain('padre no npm')
    expect(lastAssistantMsg?.emotion).toBe('concerned')
  })

  it('4. switching LLM provider preserves Ashy soul, memories, traits, and Golden Style Exemplars in compileTurnPrompt', () => {
    const store = useAshyStore.getState()
    const initialSystemPrompt = store.lastPrompt.systemPrompt
    expect(store.activeModelId).toBe('claude-3-7-sonnet')

    store.setActiveModelId('gpt-4.1')
    expect(useAshyStore.getState().activeModelId).toBe('gpt-4.1')
    expect(useAshyStore.getState().lastPrompt.modelId).toBe('gpt-4.1')
    expect(useAshyStore.getState().lastPrompt.systemPrompt).toBe(initialSystemPrompt)

    store.setActiveModelId('deepseek-v3')
    expect(useAshyStore.getState().activeModelId).toBe('deepseek-v3')
    expect(useAshyStore.getState().lastPrompt.modelId).toBe('deepseek-v3')
    expect(useAshyStore.getState().lastPrompt.systemPrompt).toBe(initialSystemPrompt)

    store.setActiveModelId('llama-3.3-70b-local')
    const llamaPrompt = useAshyStore.getState().lastPrompt
    expect(llamaPrompt.modelId).toBe('llama-3.3-70b-local')
    expect(llamaPrompt.systemPrompt).toBe(initialSystemPrompt)
    expect(llamaPrompt.systemPrompt).toContain('Golden Dialogue Exemplars')
    expect(llamaPrompt.systemPrompt).toContain('TypeScript + SQLite + React 19')
  })

  it('5. triggering Barge-In interrupts active speech and produces an exact PlaybackReceipt with heardText, unheardText, and controlNote', async () => {
    const store = useAshyStore.getState()

    await store.sendUserMessage('Me explica toda a nossa arquitetura e conta uma piada longa!')
    expect(useAshyStore.getState().isSpeaking).toBe(true)

    const receipt = store.triggerBargeIn(600)
    expect(receipt).toBeDefined()
    expect(useAshyStore.getState().isSpeaking).toBe(false)
    expect(receipt.throughMs).toBeGreaterThan(0)
    expect(receipt.heardText.length).toBeGreaterThan(0)
    expect(receipt.unheardText.length).toBeGreaterThan(0)
    expect(receipt.controlNote).toContain('[Interrupted after')
    expect(receipt.controlNote).toContain('user heard:')
    expect(receipt.controlNote).toContain('unheard:')
  })

  it('6. running Dream & Reflection evolves a personality trait with audit log and clicking Revert restores oldValue', () => {
    const store = useAshyStore.getState()
    const beforeWarmth = store.traits.warmthAffection

    const evoRecord = store.runDreamConsolidation()
    const afterDream = useAshyStore.getState()

    expect(evoRecord.trait).toBe('warmthAffection')
    expect(afterDream.traits.warmthAffection).toBeGreaterThan(beforeWarmth)
    expect(afterDream.personalityEvolutionLog.some((r) => r.id === evoRecord.id)).toBe(true)

    // Render Personality tab to verify Revert button testid exists
    afterDream.setActiveTab('personality')
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain(`data-testid="btn-revert-evolution-${evoRecord.id}"`)

    // Revert in 1 click
    afterDream.revertTraitEvolution(evoRecord.id)
    const afterRevert = useAshyStore.getState()
    expect(afterRevert.traits.warmthAffection).toBeCloseTo(beforeWarmth, 5)
    const updatedRecord = afterRevert.personalityEvolutionLog.find((r) => r.id === evoRecord.id)
    expect(updatedRecord?.revertedAt).not.toBeNull()
  })

  it('7. triggering MCP actions stages staged-confirm tools, flags blast-radius warnings on rm -rf, blocks path traversal, and logs Approve/Deny', async () => {
    const store = useAshyStore.getState()

    // 1. Stage safe write action
    const safeRes = await store.triggerMcpTool('write_project_note', {
      title: 'Release Checklist',
      content: 'All 6 packages green',
    })
    expect(safeRes.status).toBe('staged')
    expect(safeRes.pendingCard?.blastRadiusWarning).toBeUndefined()

    // 2. Stage destructive action with rm -rf -> Blast-Radius Guard warning
    const blastRes = await store.triggerMcpTool('run_cleanup_command', {
      command: 'rm -rf /tmp/build',
    })
    expect(blastRes.status).toBe('staged')
    expect(blastRes.pendingCard?.blastRadiusWarning).toContain('Blast-Radius Guard')

    // 3. Attempt path traversal attack -> blocked_traversal
    const traversalRes = await store.triggerMcpTool('read_workspace_file', {
      path: '../../etc/passwd',
    })
    expect(traversalRes.status).toBe('blocked_traversal')

    expect(useAshyStore.getState().pendingActions).toHaveLength(2)

    // 4. Approve safe card
    await store.approvePendingAction(safeRes.pendingCard!.id, 'once')
    expect(useAshyStore.getState().pendingActions).toHaveLength(1)

    // 5. Deny high-blast card
    store.denyPendingAction(blastRes.pendingCard!.id, 'Blocked destructive rm -rf in demo')
    expect(useAshyStore.getState().pendingActions).toHaveLength(0)

    const decisions = useAshyStore.getState().auditLog.map((e) => e.decision)
    expect(decisions).toEqual(
      expect.arrayContaining(['staged', 'blocked_traversal', 'approved', 'denied']),
    )
  })

  it('8. exports createAshyElectronOverlayConfig with transparent frame, screen-saver alwaysOnTop, and O(1) CPU hit-test click-through handler', () => {
    const overlay = createAshyElectronOverlayConfig({ width: 380, height: 460 })
    expect(overlay.browserWindowOptions.transparent).toBe(true)
    expect(overlay.browserWindowOptions.frame).toBe(false)
    expect(overlay.browserWindowOptions.alwaysOnTopLevel).toBe('screen-saver')

    // Far background corner (outside border and outside silhouette) -> ignore mouse events (click-through)
    const shouldIgnoreBg = overlay.evaluateMouseClickThrough({
      clientX: 30,
      clientY: 30,
      isOverUiIsland: false,
    })
    expect(shouldIgnoreBg).toBe(true)

    // Over avatar torso/head center -> capture mouse events (do not ignore)
    const shouldIgnoreAvatar = overlay.evaluateMouseClickThrough({
      clientX: 190,
      clientY: 250,
      isOverUiIsland: false,
    })
    expect(shouldIgnoreAvatar).toBe(false)

    // Over UI island -> capture mouse events
    const shouldIgnoreUi = overlay.evaluateMouseClickThrough({
      clientX: 30,
      clientY: 30,
      isOverUiIsland: true,
    })
    expect(shouldIgnoreUi).toBe(false)
  })

  it('9. [Red-Team Adversarial] enforces Cooldown Lock across consecutive turns, invalidates conflicting bi-temporal facts, clamps NaN inputs, and blocks observe-only tools under Privacy Shield', async () => {
    const store = useAshyStore.getState()

    // 1. Empty / whitespace message is ignored
    const initialMsgCount = store.chatMessages.length
    await store.sendUserMessage('    ')
    expect(useAshyStore.getState().chatMessages).toHaveLength(initialMsgCount)

    // 2. First playful message invokes motif-padre-npm (timesUsed: 3 -> 4)
    await store.sendUserMessage('Tem um fantasma no backend, chama o padre no npm!')
    expect(
      useAshyStore.getState().relationalMotifs.find((m) => m.id === 'motif-padre-npm')?.timesUsed,
    ).toBe(4)

    // Consecutive message with same cue MUST NOT re-invoke motif-padre-npm while under Cooldown Lock
    await useAshyStore.getState().sendUserMessage('Outro fantasma no backend, chama o padre no npm!')
    expect(
      useAshyStore.getState().relationalMotifs.find((m) => m.id === 'motif-padre-npm')?.timesUsed,
    ).toBe(4)

    // Resetting cooldown unlocks the motif again
    useAshyStore.getState().resetMotifCooldown('motif-padre-npm')
    expect(useAshyStore.getState().getMotifCooldownInfo('motif-padre-npm').isCooldownLocked).toBe(
      false,
    )

    // 3. Bi-temporal semantic fact update invalidates previous conflicting fact
    useAshyStore.getState().addSemanticFact({
      category: 'preference',
      subject: 'User',
      predicate: 'favorite_stack_is',
      object: 'TypeScript + Electron + Live2D',
    })
    const facts = useAshyStore.getState().semanticFacts
    const oldStackFact = facts.find((f) => f.id === 'fact-favorite-stack')
    expect(oldStackFact?.invalidAt).not.toBeNull()
    const newStackFact = facts.find(
      (f) => f.predicate === 'favorite_stack_is' && f.invalidAt === null,
    )
    expect(newStackFact?.object).toBe('TypeScript + Electron + Live2D')

    // 4. NaN / out-of-bounds luminance & invalid emotion guard
    useAshyStore.getState().setAmbientLuminance(Number.NaN)
    expect(useAshyStore.getState().ambientLuminance).toBe(0.35)
    useAshyStore.getState().setAmbientLuminance(5.0)
    expect(useAshyStore.getState().ambientLuminance).toBe(1)
    useAshyStore.getState().setAmbientLuminance(-2.0)
    expect(useAshyStore.getState().ambientLuminance).toBe(0)

    const currentEmotion = useAshyStore.getState().stageEmotion
    useAshyStore.getState().setStageEmotion('not_an_emotion' as never)
    expect(useAshyStore.getState().stageEmotion).toBe(currentEmotion)

    // 5. 1-Click Privacy Shield blocks observe-only window title tool
    useAshyStore.getState().activateFullPrivacyShield()
    expect(useAshyStore.getState().privacyState.micMode).toBe('muted')
    expect(useAshyStore.getState().privacyState.eyesMode).toBe('off')
    expect(useAshyStore.getState().privacyState.dndMode).toBe(true)

    const blockedObserve = await useAshyStore
      .getState()
      .triggerMcpTool('get_active_window_title', { windowTitle: 'VS Code' })
    expect(blockedObserve.status).toBe('blocked_privacy')
  })

  it('10. renders Cozy Night Studio views (Companhia, Memórias Bento Grid + Detail Drawer, and Configurações Do seu jeito) and supports memory CRUD', () => {
    const store = useAshyStore.getState()

    // 1. View 1: Companhia
    const companhiaHtml = renderToStaticMarkup(<App />)
    expect(companhiaHtml).toContain('Bom te ver, Carlos.')
    expect(companhiaHtml).toContain('Por aqui, com você.')
    expect(companhiaHtml).toContain('Nossa conversa')
    expect(companhiaHtml).toContain('Lembra do fantasma no backend?')
    expect(companhiaHtml).toContain('Uma piada nossa')
    expect(companhiaHtml).toContain('Conversar por voz')
    expect(companhiaHtml).toContain('Esconder avatar')

    // 2. View 2: Memórias ("O que fica com a gente")
    store.setActiveTab('memories')
    const memHtml = renderToStaticMarkup(<App />)
    expect(memHtml).toContain('O que fica com a gente')
    expect(memHtml).toContain('O fantasma no backend')
    expect(memHtml).toContain('Orin e Ashy')
    expect(memHtml).toContain('Seu jeito de trabalhar')
    expect(memHtml).toContain('Primeira conversa')
    expect(memHtml).toContain('Retomar o protótipo')
    expect(memHtml).toContain('Suas memórias ficam neste dispositivo.')
    expect(memHtml).toContain('Local primeiro. Sempre nossa.')

    // Select "Orin e Ashy" and verify drawer updates
    store.setSelectedMemoryId('ep-orin-ashy')
    const orinHtml = renderToStaticMarkup(<App />)
    expect(orinHtml).toContain('Conversa de 5 de outubro')

    // Edit memory story and create new memory
    store.updateMemoryStory('ep-orin-ashy', 'Orin e Ashy v2', 'História atualizada com carinho.')
    expect(
      useAshyStore.getState().memoryCards.find((c) => c.id === 'ep-orin-ashy')?.title,
    ).toBe('Orin e Ashy v2')

    const createdCard = store.createMemoryCard({
      title: 'Noite de chuva no estúdio',
      summary: 'Testando a nova interface acolhedora.',
      filterCategory: 'momentos',
    })
    expect(useAshyStore.getState().selectedMemoryId).toBe(createdCard.id)

    store.deleteMemoryCard(createdCard.id)
    expect(
      useAshyStore.getState().memoryCards.some((c) => c.id === createdCard.id),
    ).toBe(false)

    // 3. View 5: Configurações ("Do seu jeito")
    store.setActiveTab('agency')
    const settingsHtml = renderToStaticMarkup(<App />)
    expect(settingsHtml).toContain('Do seu jeito')
    expect(settingsHtml).toContain('Presença no desktop')
    expect(settingsHtml).toContain('Mostrar avatar')
    expect(settingsHtml).toContain('Acesso à tela')
    expect(settingsHtml).toContain('Ações no computador')
    expect(settingsHtml).toContain('Horários de silêncio')
    expect(settingsHtml).toContain('Pré-visualização')
    expect(settingsHtml).toContain('Salvar preferências')
    expect(settingsHtml).toContain('Ashy é uma personagem de IA.')
  })
})
