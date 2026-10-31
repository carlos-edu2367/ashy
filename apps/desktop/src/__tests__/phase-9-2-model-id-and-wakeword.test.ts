import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROVIDER_CONFIGS } from '@ashy/shared'
import { createVoiceSessionRuntime, encodeWavPcm16 } from '@ashy/voice'
import { createProviderVault } from '../host/provider-vault'
import { resetAshyStore, useAshyStore } from '../store/useAshyStore'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-vault-9-2-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  resetAshyStore()
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    } catch {
      // ignore cleanup error on Windows
    }
  }
})

describe('Phase 9.2 — Canonical LFM3-Omni-2B-GGUF Model ID, Vault Auto-Heal & Wake-Word Fallback Fix', () => {
  it('auto-heals legacy lfm3-omni:2b in providers.json to hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M and clears stale 404 lastError', () => {
    const tmpDir = makeTempDir()
    const filePath = path.join(tmpDir, 'providers.json')
    const providersMap: Record<string, unknown> = {}
    for (const [id, def] of Object.entries(DEFAULT_PROVIDER_CONFIGS)) {
      providersMap[id] = {
        providerId: id,
        ...def,
        lastVerifiedAt: null,
        lastError: null,
      }
    }
    providersMap.ollama = {
      providerId: 'ollama',
      ...DEFAULT_PROVIDER_CONFIGS.ollama,
      modelId: 'lfm3-omni:2b',
      lastVerifiedAt: null,
      lastError: 'HTTP 404: model "lfm3-omni:2b" not found',
      omniExecutionMode: 'native-omni',
      omniVoiceId: 'ashy-warm-ptbr',
    }

    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          version: 1,
          activeProviderId: 'ollama',
          providers: providersMap,
        },
        null,
        2,
      ),
      'utf8',
    )

    const vault = createProviderVault({ userDataDir: tmpDir })
    const state = vault.getPublicState()
    expect(state.configs.ollama.modelId).toBe('hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M')
    expect(state.configs.ollama.lastError).toBeNull()
  })

  it('configures hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M on applyOmniModelPreset("lfm3-omni-2b") and prefers installed lfm3-omni model name when available', () => {
    resetAshyStore()
    useAshyStore.getState().applyOmniModelPreset('lfm3-omni-2b')
    expect(useAshyStore.getState().activeModelId).toBe(
      'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M',
    )
    expect(useAshyStore.getState().providers.configs.ollama.modelId).toBe(
      'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M',
    )

    // When localRuntime.installedModels has a custom quant of LFM3-Omni installed, prefer its exact name
    useAshyStore.setState((s) => ({
      localRuntime: {
        ...s.localRuntime,
        installedModels: [
          {
            name: 'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q8_0',
            sizeBytes: 2_400_000_000,
            modifiedAt: new Date().toISOString(),
          },
        ],
      },
    }))
    useAshyStore.getState().applyOmniModelPreset('lfm3-omni-2b')
    expect(useAshyStore.getState().activeModelId).toBe(
      'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q8_0',
    )
  })

  it('bypasses wake-word rejection when activeSttProviderId is deterministic-wav-stt so voice bursts are not silently dropped', async () => {
    const runtime = createVoiceSessionRuntime({
      micMode: 'continuous',
      wakeWordEnabled: true,
      activeSttProviderId: 'deterministic-wav-stt',
    })

    // Generate 600ms of 195Hz voiced speech (which deterministic-wav-stt transcribes as
    // "resolver esse bug no código.", containing no wake word "ashy") followed by 1400ms silence
    const sampleRate = 16000
    const speechSamples = Math.floor(sampleRate * 0.6)
    const silenceSamples = Math.floor(sampleRate * 1.4)
    const totalSamples = speechSamples + silenceSamples
    const pcm = new Float32Array(totalSamples)
    for (let i = 0; i < speechSamples; i++) {
      const t = i / sampleRate
      pcm[i] =
        0.35 * Math.sin(2 * Math.PI * 195 * t) +
        0.15 * Math.sin(2 * Math.PI * 390 * t) +
        0.08 * Math.sin(2 * Math.PI * 585 * t)
    }

    const wavBytes = encodeWavPcm16(pcm, sampleRate)
    const state = await runtime.ingestWavBytes(wavBytes)

    expect(state.wakeWordDetectedCount).toBeGreaterThanOrEqual(1)
    expect(state.sealedTurns.length).toBeGreaterThanOrEqual(1)
  })
})
