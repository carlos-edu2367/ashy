import { expect, test } from '@playwright/test'
import {
  startLocalAiTestServer,
  type LocalAiTestServer,
} from './helpers/local-ai-test-server'

test.describe.serial('Ashy Release 1.0 — Full E2E Suite', () => {
  let aiServer: LocalAiTestServer

  test.beforeAll(async () => {
    aiServer = await startLocalAiTestServer()
  })

  test.afterAll(async () => {
    if (aiServer) {
      await aiServer.close()
    }
  })

  test('Flow 1: First Meeting Onboarding Wizard & Provider Vault Setup', async ({
    page,
  }) => {
    await page.goto('/')

    const wizard = page.getByTestId('first-meeting-wizard')
    await expect(wizard).toBeVisible()

    // 1. Fill user name and pronouns
    await page.getByTestId('onboarding-user-name-input').fill('Carlos')
    await page.getByTestId('onboarding-pronouns-select').selectOption('ele/dele')

    // 2. Select Local Omni 70/30 architecture and point to the real local HTTP test server
    await page.getByTestId('onboarding-mode-local-omni').click()
    await page.getByTestId('onboarding-base-url-input').fill(aiServer.baseUrl)

    // 3. Test real HTTP connection to local AI provider
    await page.getByTestId('onboarding-test-provider-btn').click()
    await expect(page.getByTestId('onboarding-test-status')).toContainText('Conectado', {
      timeout: 15_000,
    })

    // 4. Test voice synthesis in wizard
    await page.getByTestId('onboarding-test-tts-btn').click()
    await expect(page.getByTestId('onboarding-tts-test-status')).toContainText(
      'Voz local sintetizada',
      { timeout: 10_000 },
    )

    // 5. Configure initial privacy & agency consent
    await page.getByTestId('onboarding-eyes-mode-select').selectOption('window')
    await page.getByTestId('onboarding-mic-mode-select').selectOption('muted')
    await page.getByTestId('onboarding-approval-policy-select').selectOption('ask')

    // 6. Complete onboarding and awaken Ashy
    await page.getByTestId('onboarding-complete-btn').click()
    await expect(wizard).toBeHidden({ timeout: 15_000 })

    // Verify Studio view is active and greeting includes user's name
    await expect(page.getByTestId('studio-chat-input')).toBeVisible()
    await expect(page.locator('body')).toContainText('Bom te ver, Carlos.')
  })

  test('Flow 2: Streaming Chat, <|ACT|> Marker Stripping, SeriousnessGate & SQLite Persistence', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByTestId('first-meeting-wizard')).toBeHidden()

    // 1. Send casual playful message with TypeScript + inside joke cue
    const chatInput = page.getByTestId('studio-chat-input')
    await chatInput.fill(
      'Oi Ashy! Aqui no estúdio eu trabalho com TypeScript, mas acho que tem um fantasma no backend desse código amaldiçoado hahaha',
    )
    await page.getByTestId('studio-send-btn').click()

    // Verify streaming response arrived, marker was stripped from visible text, and stage reacted
    await expect(page.getByTestId('chat-transcript')).toContainText(
      'vou chamar um exorcista de JavaScript',
      { timeout: 15_000 },
    )
    const transcriptTextAfterTurn1 = await page.getByTestId('chat-transcript').innerText()
    expect(transcriptTextAfterTurn1).not.toContain('<|ACT')
    await expect(page.getByTestId('ashy-stage-canvas').first()).toHaveAttribute(
      'data-emotion',
      'tease',
    )

    // 2. Send delicate disclosure message to trigger SeriousnessGate
    await chatInput.fill(
      'Estou completamente exausto e ansioso hoje, um familiar foi parar no hospital e estou passando por um momento difícil.',
    )
    await page.getByTestId('studio-send-btn').click()

    await expect(page.getByTestId('seriousness-gate-badge')).toContainText(
      'Por aqui, acolhendo você com calma.',
      { timeout: 15_000 },
    )
    await expect(page.getByTestId('chat-transcript')).toContainText(
      'Sinto muito que você esteja passando por esse momento pesado',
      { timeout: 15_000 },
    )

    // 3. Reload browser and verify full SQLite persistence of onboarding + chat history
    await page.reload()
    await expect(page.getByTestId('first-meeting-wizard')).toBeHidden()
    await expect(page.getByTestId('studio-chat-input')).toBeVisible()
    await expect(page.getByTestId('chat-transcript')).toContainText(
      'vou chamar um exorcista de JavaScript',
    )
    await expect(page.getByTestId('chat-transcript')).toContainText(
      'Sinto muito que você esteja passando por esse momento pesado',
    )
  })

  test('Flow 3: Memory Consolidation, Quarantine Approval, Inside Joke Lifecycle & Dream Reflection', async ({
    page,
  }) => {
    await page.goto('/')
    await page.getByTestId('tab-memories').click()
    await expect(page.getByTestId('panel-episodic-memories')).toBeVisible()

    // 1. Enable quarantine confirmation for Episodes so consolidated episode enters pending_review
    const epGovernanceToggle = page.getByTestId('governance-toggle-episodes')
    const isPressed = await epGovernanceToggle.getAttribute('aria-pressed')
    if (isPressed !== 'true') {
      await epGovernanceToggle.click()
      await expect(epGovernanceToggle).toHaveAttribute('aria-pressed', 'true')
    }

    // 2. Send a new turn in Studio while episode quarantine is active, then consolidate in Memories
    await page.getByTestId('tab-studio').click()
    await page
      .getByTestId('studio-chat-input')
      .fill(
        'Ashy, registra na memória que nosso banco SQLite roda no Node 22 e que o fantasma no backend virou nossa piada oficial!',
      )
    await page.getByTestId('studio-send-btn').click()
    await expect(page.getByTestId('chat-transcript')).toContainText(
      'nosso banco SQLite roda no Node 22',
      { timeout: 15_000 },
    )

    await page.getByTestId('tab-memories').click()
    await page.getByTestId('btn-consolidate-memories').click()

    const quarantineSection = page.getByTestId('pending-review-memories')
    await expect(quarantineSection).toBeVisible({ timeout: 15_000 })

    // Approve the quarantined episode
    const approveBtn = quarantineSection
      .locator('[data-testid^="btn-approve-memory-"]')
      .first()
    await expect(approveBtn).toBeVisible()
    await approveBtn.click()

    // Verify consolidated episode cards are visible in the Bento grid
    await expect(
      page.locator('[data-testid^="memory-bento-card-ep-"]').first(),
    ).toBeVisible({ timeout: 10_000 })

    // 3. Create a second permanent memory card so >= 2 reflectable episodes exist for cross-episode linking
    await page.getByTestId('btn-new-memory').click()
    await page
      .getByPlaceholder('Título da lembrança...')
      .fill('Madrugada de TypeScript e Arquitetura')
    await page
      .getByPlaceholder('Conte o que aconteceu para a Ashy guardar...')
      .fill(
        'Depurando TypeScript no estúdio e relembrando o fantasma no backend durante a madrugada.',
      )
    await page.getByRole('button', { name: 'Salvar lembrança' }).click()

    // 4. Open Inside Jokes & Referências filter to inspect motif provenance and cooldown lifecycle
    await page.getByRole('button', { name: 'Referências nossas' }).click()
    const insideJokesPanel = page.getByTestId('panel-inside-jokes')
    await expect(insideJokesPanel).toBeVisible()

    const firstMotifCard = insideJokesPanel.locator('[data-testid^="motif-card-"]').first()
    await expect(firstMotifCard).toBeVisible()

    const invokeBtn = firstMotifCard.locator('[data-testid^="btn-invoke-motif-"]')
    const resetBtn = firstMotifCard.locator('[data-testid^="btn-reset-motif-"]')
    const cooldownBadge = firstMotifCard.locator('[data-testid^="motif-cooldown-"]')

    await invokeBtn.click()
    await expect(cooldownBadge).toContainText('Descansando')

    await resetBtn.click()
    await expect(cooldownBadge).toContainText('Pronta para surgir')

    // Verify provenance badge is rendered on extracted motifs
    await expect(
      insideJokesPanel.locator('[data-testid^="provenance-badge-"]').first(),
    ).toBeVisible()

    // 5. Navigate to Nossa História (Story) and run Dream & Reflection Worker
    await page.getByTestId('tab-story').click()
    await expect(page.getByTestId('panel-story')).toBeVisible()

    await page.getByTestId('btn-story-run-dream').click()

    const dreamPanel = page.getByTestId('panel-dream-journal')
    await expect(dreamPanel).toBeVisible()
    await expect(
      dreamPanel.locator('[data-testid^="dream-journal-entry-"]').first(),
    ).toBeVisible({ timeout: 15_000 })
    await expect(
      dreamPanel.locator('[data-testid^="dream-link-"]').first(),
    ).toBeVisible({ timeout: 15_000 })

    // 6. Navigate to Personalidade & Palco to verify grounded trait evolution & 1-click revert
    await page.getByTestId('tab-personality').click()
    const personalityPanel = page.getByTestId('panel-personality')
    await expect(personalityPanel).toBeVisible()

    const evoProvenance = personalityPanel
      .locator('[data-testid^="evo-provenance-"]')
      .first()
    await expect(evoProvenance).toBeVisible()
    await expect(evoProvenance).toContainText('Origem:')

    const revertEvoBtn = personalityPanel
      .locator('[data-testid^="btn-revert-evolution-"]')
      .first()
    await expect(revertEvoBtn).toBeVisible()
    await revertEvoBtn.click()

    await expect(personalityPanel).toContainText('Revertido')
  })

  test('Flow 4: Hybrid Voice Runtime — HTTP TTS Synthesis, Barge-In & Native Omni Audio', async ({
    page,
  }) => {
    await page.goto('/')
    await page.getByTestId('tab-agency').click()

    const voicePanel = page.getByTestId('voice-runtime-panel')
    await expect(voicePanel).toBeVisible()

    // 1. Configure real HTTP TTS provider (Local Kokoro HTTP) pointing to aiServer.baseUrl
    await page.getByTestId('select-tts-provider').selectOption('local-kokoro-http')
    await page.getByTestId('input-tts-base-url').fill(aiServer.baseUrl)
    await page.getByTestId('btn-save-voice-settings').click()

    await page.getByTestId('btn-test-tts-voice').click()
    await expect(voicePanel).toContainText('Voz sintetizada', {
      timeout: 15_000,
    })

    const ttsRequests = aiServer.requests.filter((r) => r.url.endsWith('/audio/speech'))
    expect(ttsRequests.length).toBeGreaterThanOrEqual(1)

    // 2. Run Thinking Pause CAS, Click Noise & Barge-In hardware-free voice fixtures
    await page.getByTestId('select-tts-provider').selectOption('local-synth-fallback')
    const directOmniSwitch = page.getByTestId('toggle-direct-omni-audio')
    const wasDirectOmni = await directOmniSwitch.getAttribute('aria-checked')
    if (wasDirectOmni === 'true') {
      await directOmniSwitch.click()
    }

    await page.getByTestId('run-fixture-thinking-pause-cas').click()
    await expect(page.getByTestId('voice-cas-badge')).toContainText('CAS: 1')

    await page.getByTestId('run-fixture-keyboard-click-noise').click()
    await expect(page.getByTestId('voice-cas-badge')).toContainText(
      'Cliques ignorados: 1',
    )

    await page.getByTestId('run-fixture-barge-in-interrupt').click()
    await expect(page.getByTestId('voice-bargein-receipt')).toContainText(
      '[Interrupted after ',
    )

    if (wasDirectOmni === 'true') {
      await directOmniSwitch.click()
    }

    // 3. Verify Unified Native Omni Mode in Studio and execute a multimodal Omni turn
    await page.getByTestId('tab-studio').click()
    const omniPill = page.getByTestId('pill-toggle-omni-mode')
    const omniText = await omniPill.innerText()
    if (!omniText.includes('Omni Nativo')) {
      await omniPill.click()
    }
    await expect(omniPill).toContainText('Omni Nativo')

    await page.getByTestId('btn-attach-image').click()
    await page.getByTestId('btn-attach-video').click()
    await expect(page.getByTestId('composer-media-attachments')).toBeVisible()

    await page
      .getByTestId('studio-chat-input')
      .fill('Oi Ashy, avalia esses frames e responde com voz nativa Omni!')
    await page.getByTestId('studio-send-btn').click()

    await expect(page.getByTestId('chat-transcript')).toContainText(
      'Oi Ashy, avalia esses frames e responde com voz nativa Omni!',
      { timeout: 15_000 },
    )

    const omniRequests = aiServer.requests.filter((r) => {
      if (!r.url.endsWith('/chat/completions')) return false
      const body = r.body as Record<string, unknown> | null
      return Array.isArray(body?.modalities) && body.modalities.includes('audio')
    })
    expect(omniRequests.length).toBeGreaterThanOrEqual(1)
  })

  test('Flow 5: Live2D / Tachie Stage Controls & Floating Stage Overlay (?view=stage-overlay)', async ({
    page,
  }) => {
    await page.goto('/')
    await page.getByTestId('tab-personality').click()

    const personalityPanel = page.getByTestId('panel-personality')
    await expect(personalityPanel).toBeVisible()
    const stageCanvas = personalityPanel.getByTestId('ashy-stage-canvas')
    await expect(stageCanvas).toBeVisible()

    // 1. Test emotion poses and anti-loop eye states
    await page.getByTestId('select-stage-emotion').selectOption('happy')
    await expect(stageCanvas).toHaveAttribute('data-emotion', 'happy')
    await expect(stageCanvas).toHaveAttribute('data-brow-preset', 'happy')
    await expect(stageCanvas).toHaveAttribute('data-accessory-fx', 'heart')

    await page.getByTestId('select-stage-emotion').selectOption('tease')
    await expect(stageCanvas).toHaveAttribute('data-emotion', 'tease')
    await expect(stageCanvas).toHaveAttribute('data-eye-state', 'wink')

    // 2. Test procedural motion presets
    await page.getByTestId('select-stage-motion').selectOption('sparkle')
    await expect(stageCanvas).toHaveAttribute('data-motion-preset', 'sparkle')

    // 3. Test switching between Live2D WebGL mode and Tachie mode
    await page.getByTestId('btn-mode-live2d').click()
    await expect(stageCanvas).toHaveAttribute('data-mode', 'live2d')

    await page.getByTestId('btn-mode-tachie').click()
    await expect(stageCanvas).toHaveAttribute('data-mode', 'tachie')

    // 4. Open Floating Stage Overlay mode (?view=stage-overlay)
    await page.goto('/?view=stage-overlay')
    const overlayRoot = page.getByTestId('floating-stage-overlay')
    await expect(overlayRoot).toBeVisible()
    await expect(page.getByTestId('stage-quick-controls')).toBeVisible()

    const overlayCanvas = overlayRoot.getByTestId('ashy-stage-canvas')
    await expect(overlayCanvas).toBeVisible()

    // 5. Verify 128x72 CPU alpha silhouette click-through hit-testing
    await overlayCanvas.hover({ position: { x: 18, y: 18 }, force: true })
    await expect(page.getByTestId('stage-clickthrough-badge')).toContainText(
      'Click-Through: ON',
    )

    await overlayCanvas.hover({ position: { x: 190, y: 260 }, force: true })
    await expect(page.getByTestId('stage-clickthrough-badge')).toContainText(
      'Click-Through: OFF',
    )

    // 6. Test quick DND and Stage Hide/Restore controls on overlay island
    const quickDndBtn = page.getByTestId('btn-quick-dnd')
    await expect(quickDndBtn).toContainText('DND (OFF)')
    await quickDndBtn.click()
    await expect(quickDndBtn).toContainText('DND (ON)')
    await quickDndBtn.click()
    await expect(quickDndBtn).toContainText('DND (OFF)')

    await page.getByTestId('btn-quick-hide-stage').click()
    const restoreBtn = page.getByTestId('btn-restore-hidden-stage')
    await expect(restoreBtn).toBeVisible()
    await restoreBtn.click()
    await expect(overlayCanvas).toBeVisible()
  })

  test('Flow 6: Gatekeeper Diff Preview, Vision Dedup, AES-256-GCM Encryption, Soul Portability & Wipe All', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByTestId('studio-chat-input')).toBeVisible()

    // 1. Trigger 2 MCP write_project_note tool calls via chat
    await page
      .getByTestId('studio-chat-input')
      .fill(
        'Ashy, por favor crie duas notas de arquitetura usando write_project_note para documentar o release.',
      )
    await page.getByTestId('studio-send-btn').click()

    const pendingBanner = page.getByTestId('chat-pending-actions-bar')
    await expect(pendingBanner).toBeVisible({ timeout: 15_000 })

    // Verify unified diff previews are rendered for staged write_project_note actions
    await expect(pendingBanner).toContainText('+++ b/')

    // Approve first action once, deny second action
    const approveOnceBtn = pendingBanner
      .locator('[data-testid^="btn-chat-approve-once-"]')
      .first()
    await approveOnceBtn.click()

    const denyBtn = pendingBanner.locator('[data-testid^="btn-chat-deny-"]').first()
    await expect(denyBtn).toBeVisible()
    await denyBtn.click()

    await expect(pendingBanner).toBeHidden({ timeout: 10_000 })

    // 2. Navigate to Configurações (tab-agency) and verify Audit Ledger
    await page.getByTestId('tab-agency').click()

    const auditList = page.getByTestId('consent-audit-ledger')
    await expect(auditList).toBeVisible()
    await expect(auditList).toContainText('approved')
    await expect(auditList).toContainText('denied')

    // 3. Test Authorized Vision Sensor & 64-bit dHash Perceptual Deduplication
    const eyesSwitch = page.getByTestId('switch-eyes-mode')
    const isEyesChecked = await eyesSwitch.getAttribute('aria-checked')
    if (isEyesChecked !== 'true') {
      await eyesSwitch.click()
      await expect(eyesSwitch).toHaveAttribute('aria-checked', 'true')
    }

    const capturedBefore = Number(
      (await page.getByTestId('vision-frames-captured').innerText()).trim(),
    )
    const skippedBefore = Number(
      (await page.getByTestId('vision-frames-skipped').innerText()).trim(),
    )

    await page.getByTestId('btn-vision-capture-window').click()
    await expect(page.getByTestId('vision-frames-captured')).toHaveText(
      String(capturedBefore + 1),
    )

    await page.getByTestId('btn-vision-capture-static').click()
    await expect(page.getByTestId('vision-frames-skipped')).toHaveText(
      String(skippedBefore + 1),
    )

    // 4. Test Instant Privacy Shield ("Pausar sensores agora")
    const blockedPrivacyBefore = Number(
      (await page.getByTestId('vision-blocked-privacy').innerText()).trim(),
    )
    await page.getByTestId('btn-activate-privacy-shield').click()
    await expect(page.getByTestId('select-mic-mode')).toHaveValue('muted')
    await expect(page.getByTestId('switch-eyes-mode')).toHaveAttribute(
      'aria-checked',
      'false',
    )
    await page.getByTestId('btn-vision-capture-window').click()
    await expect(page.getByTestId('vision-blocked-privacy')).toHaveText(
      String(blockedPrivacyBefore + 1),
    )

    // 5. Test AES-256-GCM Encryption at Rest toggle
    const encryptionCard = page.getByTestId('panel-encryption-at-rest')
    await expect(encryptionCard).toBeVisible()
    await page.getByTestId('toggle-encryption-at-rest').click()
    await expect(page.getByTestId('encryption-at-rest-status')).toContainText(
      'AES-256-GCM Ativo',
      { timeout: 10_000 },
    )

    // 6. Test Soul Portability (.ashy-soul export, SHA-256 tamper rejection, and valid restore)
    const soulPanel = page.getByTestId('panel-soul-portability')
    await expect(soulPanel).toBeVisible()

    await page.getByTestId('btn-export-soul').click()
    const soulTextarea = page.getByTestId('soul-archive-json-textarea')
    await expect(soulTextarea).not.toHaveValue('', { timeout: 10_000 })

    const validSoulJson = await soulTextarea.inputValue()
    expect(validSoulJson).toContain('"magic": "ASHY_SOUL_V1"')

    // Tamper with payload without updating SHA-256 checksum
    const parsedArchive = JSON.parse(validSoulJson) as {
      payload: { voiceIdentityMarkdown: string }
    }
    parsedArchive.payload.voiceIdentityMarkdown = '# Tampered Adversary Soul'
    await soulTextarea.fill(JSON.stringify(parsedArchive, null, 2))
    await page.getByTestId('btn-import-soul').click()

    const soulStatusBadge = page.getByTestId('soul-import-status-badge')
    await expect(soulStatusBadge).toBeVisible()
    await expect(soulStatusBadge).toContainText('SOUL_CHECKSUM_MISMATCH')

    // Restore valid archive
    await soulTextarea.fill(validSoulJson)
    await page.getByTestId('btn-import-soul').click()
    await expect(soulStatusBadge).toContainText(
      'Alma importada e restaurada com sucesso!',
      {
        timeout: 10_000,
      },
    )

    // 7. Test 1-Click Factory Reset ("Apagar tudo") and verify FirstMeetingWizard returns
    await page.getByTestId('btn-wipe-all-trigger').click()
    await page.getByTestId('btn-wipe-all-confirm').click()

    await expect(page.getByTestId('first-meeting-wizard')).toBeVisible({
      timeout: 15_000,
    })
  })
})
