// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProviderVault } from '../host/provider-vault'
import {
  createVoiceIdentityStore,
  DEFAULT_VOICE_IDENTITY_MARKDOWN,
} from '../host/voice-identity-store'
import { createTurnOrchestrator } from '../host/turn-orchestrator'
import { createAshyHostKernel } from '../host/kernel'
import { dispatchHostRpc } from '../host/vite-host-plugin'
import { createAshyHostClient } from '../services/ashy-host-client'
import { createAshyCortex } from '@ashy/cortex'

describe('Phase 9 Task 4 — Kernel Soul Portability, Full Onboarding, Encryption-at-Rest & 1-Click Wipe', () => {
  const tempDirs: string[] = []

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-phase9-task4-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup failures
      }
    }
  })

  describe('Requirement 1: ProviderVault.resetAll()', () => {
    it('clears in-memory decrypted cache, removes backup files, and resets providers & secrets to defaults', () => {
      const dir = makeTempDir()
      const vault = createProviderVault({ userDataDir: dir })

      // Save twice so .bak1 files are generated on disk
      vault.saveProviderConfig({
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        modelId: 'gpt-4.1-mini',
        apiKey: 'sk-first-secret-key-123456',
      })
      vault.saveProviderConfig({
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        modelId: 'gpt-4.1',
        apiKey: 'sk-second-secret-key-654321',
      })

      expect(vault.getDecryptedApiKey('openai')).toBe('sk-second-secret-key-654321')
      expect(fs.existsSync(`${vault.secretsFilePath}.bak1`)).toBe(true)
      expect(fs.existsSync(`${vault.providersFilePath}.bak1`)).toBe(true)

      const resetState = vault.resetAll()

      expect(vault.getDecryptedApiKey('openai')).toBeNull()
      expect(
        Object.values(resetState.configs).every(
          (item) => !item.hasApiKey && item.maskedApiKey === null,
        ),
      ).toBe(true)
      expect(fs.existsSync(`${vault.secretsFilePath}.bak1`)).toBe(false)
      expect(fs.existsSync(`${vault.providersFilePath}.bak1`)).toBe(false)

      const secretsRaw = JSON.parse(fs.readFileSync(vault.secretsFilePath, 'utf8')) as {
        secrets: Record<string, string>
      }
      expect(secretsRaw.secrets).toEqual({})
    })
  })

  describe('Requirement 2: VoiceIdentityStore encryption-at-rest and reset()', () => {
    it('encrypts voice.md on disk when encryptionCodec is enabled, removes plaintext backups on rewrap, and resets cleanly', () => {
      const dir = makeTempDir()
      let encryptedMode = false

      const codec = {
        isEnabled: () => encryptedMode,
        encrypt: (plain: string, aad: string) =>
          `enc:v1:${Buffer.from(`${aad}:${plain}`, 'utf8').toString('base64')}`,
        decrypt: (cipher: string, aad: string) => {
          if (!cipher.startsWith('enc:v1:')) {
            throw new Error('Expected enc:v1: prefix')
          }
          const decoded = Buffer.from(cipher.slice('enc:v1:'.length), 'base64').toString('utf8')
          const expectedPrefix = `${aad}:`
          if (!decoded.startsWith(expectedPrefix)) {
            throw new Error('AAD mismatch')
          }
          return decoded.slice(expectedPrefix.length)
        },
      }

      const store = createVoiceIdentityStore({
        userDataDir: dir,
        encryptionCodec: codec,
      })

      const customVoiceV1 = `${DEFAULT_VOICE_IDENTITY_MARKDOWN}\n- Custom voice note v1.\n`
      const customVoiceV2 = `${DEFAULT_VOICE_IDENTITY_MARKDOWN}\n- Custom voice note v2 SECRET_VOICE_MARKER.\n`

      // Save twice in plaintext mode so voice.md.bak1 exists with plaintext
      store.save(customVoiceV1)
      const savedPlain = store.save(customVoiceV2)
      expect(savedPlain.markdown).toBe(customVoiceV2)
      expect(savedPlain.content).toBe(customVoiceV2)
      expect(fs.existsSync(path.join(dir, 'voice.md.bak1'))).toBe(true)

      // Enable encryption and rewrap
      encryptedMode = true
      store.rewrapForEncryptionState()

      const diskRawAfterRewrap = fs.readFileSync(path.join(dir, 'voice.md'), 'utf8')
      expect(diskRawAfterRewrap.startsWith('enc:v1:')).toBe(true)
      expect(diskRawAfterRewrap).not.toContain('SECRET_VOICE_MARKER')
      // Plaintext backup must be removed during rewrap
      expect(fs.existsSync(path.join(dir, 'voice.md.bak1'))).toBe(false)

      // Reading via get() / read() returns decrypted markdown
      expect(store.get().markdown).toBe(customVoiceV2)
      expect(store.read().content).toBe(customVoiceV2)

      // Resetting removes backups and writes encrypted default markdown
      const resetSnapshot = store.reset()
      expect(resetSnapshot.markdown).toBe(DEFAULT_VOICE_IDENTITY_MARKDOWN)
      expect(fs.existsSync(path.join(dir, 'voice.md.bak1'))).toBe(false)
      const diskAfterReset = fs.readFileSync(path.join(dir, 'voice.md'), 'utf8')
      expect(diskAfterReset.startsWith('enc:v1:')).toBe(true)
      expect(store.get().markdown).toBe(DEFAULT_VOICE_IDENTITY_MARKDOWN)
    })
  })

  describe('Requirement 3: TurnOrchestrator epoch guard ([REDTEAM-6])', () => {
    it('aborts in-flight turn persistence when kernelEpoch changes mid-turn', async () => {
      const dir = makeTempDir()
      const cortex = await createAshyCortex({ filePath: path.join(dir, 'epoch-test.db') })
      let currentEpoch = 1

      const mockFetch = vi.fn(async () => {
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [{ delta: { content: '<|ACT {"emotion":"joy","intensity":0.9}|>Fantasma ' } }],
                })}\n\n`,
              ),
            )
            // Simulate wipeAllData() or importSoul() incrementing epoch mid-stream
            cortex.wipeAll()
            cortex.createChatSession({ id: 'session-initial', title: 'Fresh After Wipe' })
            currentEpoch += 1
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [{ delta: { content: 'depois do wipe!' }, finish_reason: 'stop' }],
                })}\n\ndata: [DONE]\n\n`,
              ),
            )
            controller.close()
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      })

      const vault = createProviderVault({
        userDataDir: dir,
        fetchImpl: mockFetch as unknown as typeof fetch,
      })
      const voiceStore = createVoiceIdentityStore({ userDataDir: dir })

      vault.saveProviderConfig({
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        modelId: 'gpt-4.1-mini',
        apiKey: 'sk-test-epoch-guard-123456',
      })
      vault.setActiveProvider('openai')

      const orchestrator = createTurnOrchestrator({
        cortex,
        providerVault: vault,
        voiceStore,
        getKernelEpoch: () => currentEpoch,
        getBootstrapSnapshot: () => ({}) as never,
      })

      cortex.createChatSession({ id: 'session-initial', title: 'Before Wipe' })
      await orchestrator.sendTurn({
        sessionId: 'session-initial',
        text: 'Oi Ashy',
      })

      await vi.waitFor(() => {
        expect(orchestrator.hasActiveTurnForSession('session-initial')).toBe(false)
      })

      // The post-wipe session must NOT have the ghost assistant message or emotion pulse
      const messagesAfterWipe = cortex.listChatMessages('session-initial', 50)
      expect(messagesAfterWipe.filter((m) => m.role === 'assistant')).toHaveLength(0)

      cortex.close()
    })
  })

  describe('Requirement 4: AshyHostKernel full onboarding, exportSoul/importSoul, wipeAllData, encryptionAtRest & privacyShield', () => {
    it('completes full onboarding wizard and seeds Ashy first greeting linked to milestone-first-meeting', async () => {
      const dir = makeTempDir()
      const kernel = await createAshyHostKernel({ userDataDir: dir })

      const snapshot = await kernel.completeOnboarding({
        userName: 'Carlos',
        userPronouns: 'ele/dele',
        providerConfig: {
          providerId: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          modelId: 'gpt-4.1-mini',
          apiKey: 'sk-onboarding-secret-999999',
        },
        voiceSettings: {
          activeSttProviderId: 'groq-whisper',
          groqApiKey: 'gsk-onboarding-voice-888888',
          autoSpeakReplies: true,
        },
        agencyConsent: {
          micMode: 'ptt',
          eyesMode: 'window',
          approvalPolicy: 'ask',
          dndMode: false,
        },
        initiativePolicy: {
          enabled: true,
          maxDailyInitiatives: 2,
          cooldownMinutes: 240,
          quietHoursStart: '23:00',
          quietHoursEnd: '08:00',
        },
        stagePreferences: {
          stageMode: 'live2d',
          live2dPresetId: 'mao',
          ambientLuminance: 0.75,
        },
        seedFirstGreeting: true,
      })

      expect(snapshot.needsOnboarding).toBe(false)
      expect(snapshot.activeSession.id).toBe('session-initial')

      expect(snapshot.providers.configs.openai.hasApiKey).toBe(true)
      expect(snapshot.providers.activeProviderId).toBe('openai')

      expect(snapshot.voiceSettings?.activeSttProviderId).toBe('groq-whisper')
      expect(snapshot.voiceSettings?.hasGroqApiKey).toBe(true)
      expect(snapshot.voiceSettings?.autoSpeakReplies).toBe(true)

      expect(snapshot.agency?.consent.micMode).toBe('ptt')
      expect(snapshot.agency?.consent.eyesMode).toBe('window')
      expect(snapshot.agency?.consent.approvalPolicy).toBe('ask')

      expect(snapshot.memories.initiativePolicy?.maxDailyInitiatives).toBe(2)
      expect(snapshot.stagePreferences?.stageMode).toBe('live2d')
      expect(snapshot.stagePreferences?.live2dPresetId).toBe('mao')

      expect(
        snapshot.relationship.milestones.some(
          (m) => m.id === 'milestone-first-meeting' && m.roomTrophyId === 'trophy-first-boot-mug',
        ),
      ).toBe(true)

      const greetingMsg = snapshot.messages.find((m) => m.role === 'assistant')
      expect(greetingMsg).toBeDefined()
      expect(greetingMsg?.content).toBe(
        'Oi, Carlos! Que bom te conhecer de verdade aqui no estúdio. Já deixei uma caneca de café pra gente na estante — me conta: no que você tá trabalhando ou pensando hoje?',
      )
      expect(greetingMsg?.emotion).toBe('happy')
      expect(greetingMsg?.consolidatedEpisodeId).toBe('milestone-first-meeting')

      await kernel.stop()
    })

    it('exports a sanitized Soul archive without any API keys, verifies SHA-256 checksum on import, and blocks prototype pollution', async () => {
      const dir1 = makeTempDir()
      const kernel1 = await createAshyHostKernel({ userDataDir: dir1 })

      await kernel1.completeOnboarding({
        userName: 'Carlos',
        userPronouns: 'ele/dele',
        providerConfig: {
          providerId: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          modelId: 'gpt-4.1-mini',
          apiKey: 'sk-super-secret-never-export-111111',
        },
        voiceSettings: {
          activeSttProviderId: 'openai-whisper',
          openaiApiKey: 'sk-voice-secret-never-export-222222',
          elevenLabsApiKey: 'el-secret-never-export-333333',
        },
        stagePreferences: {
          stageMode: 'live2d',
          live2dPresetId: 'mao',
          ambientLuminance: 0.65,
        },
        seedFirstGreeting: true,
      })

      const customVoice = `${DEFAULT_VOICE_IDENTITY_MARKDOWN}\n- Sempre lembra do café especial.\n`
      await kernel1.saveVoiceIdentity(customVoice)

      const archive = await kernel1.exportSoul()
      expect(archive.magic).toBe('ASHY_SOUL_V1')
      expect(archive.checksumSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(archive.payload.voiceIdentityMarkdown).toBe(customVoice)
      expect(archive.payload.stagePreferences?.live2dPresetId).toBe('mao')

      // Zero secret leakage check
      const serializedArchive = JSON.stringify(archive)
      expect(serializedArchive).not.toContain('sk-super-secret-never-export-111111')
      expect(serializedArchive).not.toContain('sk-voice-secret-never-export-222222')
      expect(serializedArchive).not.toContain('el-secret-never-export-333333')
      expect(archive.payload.voicePreferences?.hasOpenAiApiKey).toBe(false)
      expect(archive.payload.voicePreferences?.hasGroqApiKey).toBe(false)
      expect(archive.payload.voicePreferences?.hasElevenLabsApiKey).toBe(false)
      expect(archive.payload.voicePreferences?.hasLocalSttApiKey).toBe(false)
      expect(archive.payload.voicePreferences?.hasLocalTtsApiKey).toBe(false)
      expect(archive.payload.voicePreferences?.maskedOpenAiApiKey).toBeNull()
      expect(archive.payload.voicePreferences?.maskedGroqApiKey).toBeNull()
      expect(archive.payload.voicePreferences?.maskedElevenLabsApiKey).toBeNull()

      // Privacy filter flags on exportSoul
      const filteredArchive = await kernel1.exportSoul({
        includeChatHistory: false,
        includeAuditLog: false,
      })
      expect(filteredArchive.payload.cortex.chatSessions).toHaveLength(0)
      expect(filteredArchive.payload.cortex.chatMessages).toHaveLength(0)
      expect(filteredArchive.payload.cortex.actionAuditLog).toHaveLength(0)

      await kernel1.stop()

      // Import into a second clean kernel
      const dir2 = makeTempDir()
      const kernel2 = await createAshyHostKernel({ userDataDir: dir2 })

      // 1. Tampered payload must fail with SOUL_CHECKSUM_MISMATCH
      const tamperedArchive = structuredClone(archive)
      tamperedArchive.payload.voiceIdentityMarkdown = `${customVoice}\n- Tampered!\n`
      await expect(kernel2.importSoul({ archive: tamperedArchive })).rejects.toThrow(
        /SOUL_CHECKSUM_MISMATCH/,
      )

      // 2. Prototype pollution string must be rejected
      const protoPollutedJson = `{"magic":"ASHY_SOUL_V1","checksumSha256":"${archive.checksumSha256}","__proto__":{"polluted":true},"payload":${JSON.stringify(archive.payload)}}`
      await expect(kernel2.importSoul({ archive: protoPollutedJson })).rejects.toThrow()
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()

      // 3. Valid archive imports cleanly and restores state
      const restoredSnapshot = await kernel2.importSoul({ archive })
      expect(restoredSnapshot.needsOnboarding).toBe(false)
      expect(restoredSnapshot.voice.content).toBe(customVoice)
      expect(restoredSnapshot.stagePreferences?.stageMode).toBe('live2d')
      expect(restoredSnapshot.stagePreferences?.live2dPresetId).toBe('mao')
      expect(
        restoredSnapshot.memories.facts.some((f) => f.predicate === 'name' && f.object === 'Carlos'),
      ).toBe(true)
      expect(restoredSnapshot.messages.some((m) => m.role === 'assistant')).toBe(true)

      // 4. Adversarial: crafted archive with valid recalculated SHA-256 but invalid voiceIdentityMarkdown (< 16 chars)
      // must be rejected BEFORE mutating cortex state (atomicity guard)
      const craftedInvalidVoice = structuredClone(archive)
      craftedInvalidVoice.payload.voiceIdentityMarkdown = 'short'
      craftedInvalidVoice.payload.cortex.semanticFacts = []
      const cryptoMod = await import('node:crypto')
      const { canonicalizeJson } = await import('@ashy/shared')
      craftedInvalidVoice.checksumSha256 = cryptoMod
        .createHash('sha256')
        .update(canonicalizeJson(craftedInvalidVoice.payload), 'utf8')
        .digest('hex')
      await expect(kernel2.importSoul({ archive: craftedInvalidVoice })).rejects.toThrow(
        /voiceIdentityMarkdown/,
      )
      const afterFailedImport = await kernel2.getBootstrapSnapshot()
      expect(
        afterFailedImport.memories.facts.some(
          (f) => f.predicate === 'name' && f.object === 'Carlos',
        ),
      ).toBe(true)

      await kernel2.stop()
    })

    it('toggles encryptionAtRest across ashy.db and voice.md, executes activatePrivacyShield, and wipes all data in 1-click', async () => {
      const dir = makeTempDir()
      const kernel = await createAshyHostKernel({ userDataDir: dir })

      await kernel.completeOnboarding({
        userName: 'Carlos',
        userPronouns: 'ele/dele',
        providerConfig: {
          providerId: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          modelId: 'gpt-4.1-mini',
          apiKey: 'sk-wipe-test-123456',
        },
        voiceSettings: {
          activeSttProviderId: 'openai-whisper',
          openaiApiKey: 'sk-voice-wipe-123456',
        },
        agencyConsent: {
          micMode: 'continuous',
          eyesMode: 'window',
          approvalPolicy: 'ask',
          dndMode: false,
        },
        stagePreferences: {
          stageMode: 'live2d',
          live2dPresetId: 'mao',
        },
        seedFirstGreeting: true,
      })

      const customVoice = `${DEFAULT_VOICE_IDENTITY_MARKDOWN}\n- Segredo de voz criptografado.\n`
      await kernel.saveVoiceIdentity(customVoice)

      // Enable encryption at rest
      const encryptedSnap = await kernel.setEncryptionAtRest({ enabled: true })
      expect(encryptedSnap.encryptionAtRest?.enabled).toBe(true)
      expect(encryptedSnap.encryptionAtRest?.algorithm).toBe('AES-256-GCM')
      expect(encryptedSnap.encryptionAtRest?.updatedAt).toEqual(expect.any(String))

      const status = await kernel.getEncryptionAtRestStatus()
      expect(status.enabled).toBe(true)

      // Verify voice.md on disk is encrypted
      const rawVoiceOnDisk = fs.readFileSync(path.join(dir, 'voice.md'), 'utf8')
      expect(rawVoiceOnDisk.startsWith('enc:v1:')).toBe(true)
      expect(rawVoiceOnDisk).not.toContain('Segredo de voz criptografado')

      // Exporting Soul while encrypted at rest still exports plaintext markdown & facts
      const soulWhileEncrypted = await kernel.exportSoul()
      expect(soulWhileEncrypted.payload.voiceIdentityMarkdown).toBe(customVoice)
      expect(
        soulWhileEncrypted.payload.cortex.semanticFacts.some(
          (f) => f.predicate === 'name' && f.object === 'Carlos',
        ),
      ).toBe(true)

      // Disabling encryption at rest decrypts voice.md back to plaintext on disk
      const decryptedSnap = await kernel.setEncryptionAtRest({ enabled: false })
      expect(decryptedSnap.encryptionAtRest?.enabled).toBe(false)
      const rawVoiceAfterDisable = fs.readFileSync(path.join(dir, 'voice.md'), 'utf8')
      expect(rawVoiceAfterDisable.startsWith('enc:v1:')).toBe(false)
      expect(rawVoiceAfterDisable).toContain('Segredo de voz criptografado')

      // Activate Privacy Shield
      const shieldSnap = await kernel.activatePrivacyShield()
      expect(shieldSnap.agency?.consent.micMode).toBe('muted')
      expect(shieldSnap.agency?.consent.eyesMode).toBe('off')
      expect(shieldSnap.agency?.consent.dndMode).toBe(true)

      // 1-Click Wipe All Data
      const wipedSnap = await kernel.wipeAllData()
      expect(wipedSnap.needsOnboarding).toBe(true)
      expect(wipedSnap.memories.facts).toHaveLength(0)
      expect(wipedSnap.memories.episodes).toHaveLength(0)
      expect(wipedSnap.messages).toHaveLength(0)
      expect(
        Object.values(wipedSnap.providers.configs).every(
          (p) => !p.hasApiKey && p.maskedApiKey === null,
        ),
      ).toBe(true)
      expect(wipedSnap.voiceSettings?.hasOpenAiApiKey).toBe(false)
      expect(wipedSnap.voice.content).toBe(DEFAULT_VOICE_IDENTITY_MARKDOWN)
      expect(wipedSnap.stagePreferences?.stageMode).toBe('tachie')
      expect(wipedSnap.stagePreferences?.live2dPresetId).toBe('hiyori')
      expect(wipedSnap.agency?.consent.micMode).toBe('muted')
      expect(wipedSnap.agency?.consent.eyesMode).toBe('off')
      expect(wipedSnap.agency?.consent.approvalPolicy).toBe('ask')
      expect(wipedSnap.agency?.consent.dndMode).toBe(false)

      // Ensure backup files were removed on wipe
      expect(fs.existsSync(path.join(dir, 'voice.md.bak1'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'providers.secrets.json.bak1'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'voice-settings.json.bak1'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'stage-preferences.json.bak1'))).toBe(false)

      await kernel.stop()
    })
  })

  describe('Requirement 5: RPC dispatch and AshyHostClient methods', () => {
    it('dispatches Phase 9 RPC methods in vite-host-plugin and exposes them on AshyHostClient', async () => {
      const dir = makeTempDir()
      const kernel = await createAshyHostKernel({ userDataDir: dir })

      const encStatus = (await dispatchHostRpc(kernel, 'getEncryptionAtRestStatus', undefined)) as {
        enabled: boolean
      }
      expect(encStatus.enabled).toBe(false)

      const shieldResult = (await dispatchHostRpc(
        kernel,
        'activatePrivacyShield',
        undefined,
      )) as { agency: { consent: { dndMode: boolean } } }
      expect(shieldResult.agency.consent.dndMode).toBe(true)

      const soulArchive = await dispatchHostRpc(kernel, 'exportSoul', {
        includeChatHistory: true,
        includeAuditLog: true,
      })
      expect((soulArchive as { magic: string }).magic).toBe('ASHY_SOUL_V1')

      const wipedResult = (await dispatchHostRpc(kernel, 'wipeAllData', undefined)) as {
        needsOnboarding: boolean
      }
      expect(wipedResult.needsOnboarding).toBe(true)

      const importedResult = (await dispatchHostRpc(kernel, 'importSoul', {
        archive: soulArchive,
      })) as { agency: { consent: { dndMode: boolean } } }
      expect(importedResult.agency.consent.dndMode).toBe(true)

      const updateState = (await dispatchHostRpc(kernel, 'getUpdateState', undefined)) as {
        status: string
      }
      expect(updateState.status).toBeDefined()

      // Verify AshyHostClient exposes all Phase 9 methods
      const client = createAshyHostClient()
      expect(typeof client.exportSoul).toBe('function')
      expect(typeof client.importSoul).toBe('function')
      expect(typeof client.wipeAllData).toBe('function')
      expect(typeof client.setEncryptionAtRest).toBe('function')
      expect(typeof client.getEncryptionAtRestStatus).toBe('function')
      expect(typeof client.activatePrivacyShield).toBe('function')
      expect(typeof client.getUpdateState).toBe('function')
      expect(typeof client.checkForUpdates).toBe('function')
      expect(typeof client.downloadUpdate).toBe('function')
      expect(typeof client.quitAndInstallUpdate).toBe('function')

      await kernel.stop()
    })
  })
})
