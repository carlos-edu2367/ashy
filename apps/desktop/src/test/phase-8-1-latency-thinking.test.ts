import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAshyCortex } from '@ashy/cortex'
import type { AshyBootstrapSnapshot, AshyHostStreamEvent } from '@ashy/shared'
import { createProviderVault } from '../host/provider-vault'
import { createNodeAesSecretProtector, type SecretProtector } from '../host/secret-protector'
import { createTurnOrchestrator } from '../host/turn-orchestrator'
import { createVoiceIdentityStore } from '../host/voice-identity-store'

describe('Phase 8.1 — Latency, Reasoning Effort Control & Pre-Turn Overhead Elimination', () => {
  const tempDirs: string[] = []

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-p81-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors on Windows
      }
    }
  })

  function buildSseResponse(lines: string[]): Response {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${line}\n\n`))
        }
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  it('defaults reasoningEffort to "none", persists updates in ProviderVault, and caches decrypted keys in memory across repeated reads', async () => {
    const userDataDir = makeTempDir()
    const baseProtector = createNodeAesSecretProtector(userDataDir)
    let decryptCalls = 0
    const spyProtector: SecretProtector = {
      encrypt: (plain) => baseProtector.encrypt(plain),
      decrypt: (cipher) => {
        decryptCalls += 1
        return baseProtector.decrypt(cipher)
      },
    }

    const capturedBodies: Array<Record<string, unknown>> = []
    const fetchMock: typeof fetch = async (_input, init) => {
      capturedBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return buildSseResponse([
        'data: {"choices":[{"delta":{"content":"Oi!"},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ])
    }

    const vault = createProviderVault({
      userDataDir,
      secretProtector: spyProtector,
      fetchImpl: fetchMock,
    })

    const initial = vault.getPublicState()
    expect(initial.configs.openrouter.reasoningEffort).toBe('none')

    const saved = vault.saveProviderConfig({
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'qwen/qwen3.8-flash',
      reasoningEffort: 'none',
      apiKey: 'sk-or-v1-secret-123456',
    })
    expect(saved.reasoningEffort).toBe('none')

    const decryptCountAfterSave = decryptCalls
    // Calling getPublicState and createActiveLanguageModel multiple times without file changes must hit in-memory cache
    vault.getPublicState()
    vault.getPublicState()
    const model = vault.createActiveLanguageModel()
    vault.getDecryptedApiKey('openrouter')
    expect(decryptCalls).toBe(decryptCountAfterSave)

    const stream = await model({
      messages: [{ role: 'user', content: 'opa' }],
    })
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    expect(capturedBodies[0]?.reasoning).toEqual({
      enabled: false,
      effort: 'none',
    })

    // Updating reasoningEffort to 'medium' persists and propagates
    const updated = vault.saveProviderConfig({
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'qwen/qwen3.8-flash',
      reasoningEffort: 'medium',
    })
    expect(updated.reasoningEffort).toBe('medium')
    expect(vault.getPublicState().configs.openrouter.reasoningEffort).toBe('medium')
  })

  it('does NOT call getBootstrapSnapshot before streaming and passes evolved RelationshipStage + queryEmbedding to compileTurnPrompt', async () => {
    const userDataDir = makeTempDir()
    const cortex = createAshyCortex({
      filePath: path.join(userDataDir, 'ashy.db'),
    })
    const voiceStore = createVoiceIdentityStore({ userDataDir })

    const capturedBodies: Array<Record<string, unknown>> = []
    let snapshotCallsBeforeFirstDelta = 0
    let snapshotCallsTotal = 0
    let firstDeltaReceived = false

    const fetchMock: typeof fetch = async (_input, init) => {
      capturedBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return buildSseResponse([
        'data: {"choices":[{"delta":{"content":"<|ACT {\\"emotion\\":\\"warm\\",\\"intensity\\":0.8}|> Oi meu parceiro!"},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ])
    }

    const providerVault = createProviderVault({
      userDataDir,
      fetchImpl: fetchMock,
    })
    providerVault.saveProviderConfig({
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'qwen/qwen3.8-flash',
      reasoningEffort: 'none',
      apiKey: 'sk-or-test-key-9999',
    })

    // Seed an established inside_joke so the relationship stage should be 'close_friend' (not 'stranger')
    cortex.db.upsertRelationalMotif({
      id: 'motif-padre-npm',
      motif: 'Padre no NPM',
      originSummary: 'Piada sobre chamar um padre no npm quando o build quebra',
      triggerCues: ['padre', 'npm', 'build'],
      stage: 'inside_joke',
      timesUsed: 3,
      lastUsedAt: Date.now() - 86_400_000,
      cooldownHours: 12,
      originEpisodeId: 'ep-1',
      createdAt: Date.now() - 86_400_000,
    })

    const compileSpy = vi.spyOn(cortex, 'compileTurnPrompt')

    const dummySnapshot: AshyBootstrapSnapshot = {
      needsOnboarding: false,
      userProfile: { userName: 'Carlos', userPronouns: 'ele/dele' },
      relationship: {
        stage: 'close_friend',
        familiarityScore: 0.5,
        trustScore: 0.5,
        totalTurns: 5,
        milestones: [],
      },
      affect: {
        mood: { valence: 0.2, arousal: 0.1, playfulness: 0.2 },
        traits: {
          warmthAffection: 0.7,
          witSarcasm: 0.65,
          intellectualCuriosity: 0.75,
          chaosEnergy: 0.5,
          proactivity: 0.55,
        },
        dominantEmotion: 'neutral',
      },
      activeSession: {
        id: 'session-1',
        title: 'Sessão 1',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        turnCount: 0,
        lastMessagePreview: '',
      },
      sessions: [],
      messages: [],
      memories: { facts: [], episodes: [], jokes: [] },
      voice: {
        content: voiceStore.read().content,
        diagnostics: { status: 'ok', updatedAt: Date.now() },
        updatedAt: Date.now(),
      },
      providers: providerVault.getPublicState(),
      runtimeDiagnostics: {
        dbMode: 'wal',
        dbPath: path.join(userDataDir, 'ashy.db'),
        lastPersistenceWarning: null,
      },
    }

    const orchestrator = createTurnOrchestrator({
      cortex,
      voiceStore,
      providerVault,
      getBootstrapSnapshot: async () => {
        snapshotCallsTotal += 1
        if (!firstDeltaReceived) {
          snapshotCallsBeforeFirstDelta += 1
        }
        return structuredClone(dummySnapshot)
      },
    })

    const events: AshyHostStreamEvent[] = []
    const completedPromise = new Promise<void>((resolve, reject) => {
      orchestrator.onEvent((ev) => {
        events.push(ev)
        if (ev.type === 'turn:delta') {
          firstDeltaReceived = true
        }
        if (ev.type === 'turn:completed') {
          resolve()
        }
        if (ev.type === 'turn:error') {
          reject(new Error(ev.message))
        }
      })
    })

    await orchestrator.sendTurn({
      sessionId: 'session-1',
      text: 'opa, tudo certo?',
    })
    await completedPromise

    // 1. Pre-turn getBootstrapSnapshot must NOT be called before streaming
    expect(snapshotCallsBeforeFirstDelta).toBe(0)
    expect(snapshotCallsTotal).toBe(1)

    // 2. compileTurnPrompt must receive the evolved stage ('close_friend') and a 128-d queryEmbedding
    expect(compileSpy).toHaveBeenCalledTimes(1)
    const callArg = compileSpy.mock.calls[0]![0]
    expect(callArg.stage).toBe('close_friend')
    expect(Array.isArray(callArg.queryEmbedding)).toBe(true)
    expect(callArg.queryEmbedding?.length).toBe(128)

    // 3. System prompt sent to LLM must reflect CLOSE_FRIEND, not STRANGER
    const systemSent = String((capturedBodies[0]?.messages as Array<Record<string, unknown>>)?.[0]?.content ?? '')
    expect(systemSent).toContain('CLOSE_FRIEND')
    expect(systemSent).not.toContain('STAGE: STRANGER')

    cortex.close()
  })

  it('[Adversarial] upgrades legacy providers.json without reasoningEffort field seamlessly to "none" without resetting custom modelId', () => {
    const userDataDir = makeTempDir()
    const legacyDoc = {
      version: 1,
      activeProviderId: 'openrouter',
      providers: {
        openrouter: {
          providerId: 'openrouter',
          label: 'OpenRouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          modelId: 'qwen/qwen3.8-flash',
          requiresApiKey: true,
          lastVerifiedAt: 1700000000000,
          lastError: null,
        },
        anthropic: {
          providerId: 'anthropic',
          label: 'Anthropic',
          baseUrl: 'https://api.anthropic.com/v1',
          modelId: 'claude-3-7-sonnet-latest',
          requiresApiKey: true,
          lastVerifiedAt: null,
          lastError: null,
        },
        openai: {
          providerId: 'openai',
          label: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          modelId: 'gpt-4o-mini',
          requiresApiKey: true,
          lastVerifiedAt: null,
          lastError: null,
        },
        'nvidia-nim': {
          providerId: 'nvidia-nim',
          label: 'NVIDIA NIM',
          baseUrl: 'https://integrate.api.nvidia.com/v1',
          modelId: 'meta/llama-3.3-70b-instruct',
          requiresApiKey: true,
          lastVerifiedAt: null,
          lastError: null,
        },
        ollama: {
          providerId: 'ollama',
          label: 'Ollama (Local)',
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelId: 'qwen2.5:14b',
          requiresApiKey: false,
          lastVerifiedAt: null,
          lastError: null,
        },
      },
    }
    fs.writeFileSync(path.join(userDataDir, 'providers.json'), JSON.stringify(legacyDoc, null, 2))

    const vault = createProviderVault({ userDataDir })
    const state = vault.getPublicState()
    expect(state.diagnostics.status).toBe('ok')
    expect(state.configs.openrouter.modelId).toBe('qwen/qwen3.8-flash')
    expect(state.configs.openrouter.reasoningEffort).toBe('none')
  })

  it('[Red-Team] ignores pending_review quarantined memories in deriveRelationshipStage, evicts cleared keys from decryptedKeyCache, and probes testProviderConnection with reasoningEffort="none"', async () => {
    const userDataDir = makeTempDir()
    const cortex = createAshyCortex({
      filePath: path.join(userDataDir, 'ashy-redteam.db'),
    })

    // Seed an inside_joke in pending_review quarantine: must NOT promote stage to close_friend!
    cortex.db.upsertRelationalMotif({
      id: 'motif-quarantine-1',
      motif: 'Piada em quarentena',
      originSummary: 'Origem não aprovada',
      triggerCues: ['quarentena'],
      stage: 'inside_joke',
      timesUsed: 3,
      lastUsedAt: Date.now() - 86_400_000,
      cooldownHours: 12,
      originEpisodeId: 'ep-q1',
      approvalStatus: 'pending_review',
      createdAt: Date.now() - 86_400_000,
    })
    expect(cortex.deriveRelationshipStage()).toBe('stranger')

    const capturedProbeBodies: Array<Record<string, unknown>> = []
    const fetchMock: typeof fetch = async (_input, init) => {
      capturedProbeBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return buildSseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}',
        'data: {"type":"message_stop"}',
      ])
    }

    const vault = createProviderVault({
      userDataDir,
      fetchImpl: fetchMock,
    })

    const probeRes = await vault.testProviderConnection({
      providerId: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      modelId: 'claude-3-7-sonnet-latest',
      reasoningEffort: 'high',
      apiKey: 'sk-ant-test-probe-9999',
    })
    expect(probeRes.ok).toBe(true)
    // Probe must use reasoningEffort: 'none' so maxTokens: 8 never fails Anthropic thinking budget
    expect(capturedProbeBodies[0]?.thinking).toBeUndefined()

    cortex.close()
  })
})
