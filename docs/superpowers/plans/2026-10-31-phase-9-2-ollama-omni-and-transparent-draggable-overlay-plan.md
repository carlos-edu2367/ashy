# Phase 9.2 — Ollama Omni Native 24 kHz Voice/Tools Pipeline & 100% Transparent Draggable Desktop Character Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable end-to-end native `LFM3-Omni-2B` listening (`lfm3a`), tool calling (`maxSteps: 5`), emotion markers (`<|ACT {...}|>`), and 24 kHz native model voice synthesis (`lfm3a_gen` via Ollama's underlying `llama-server.exe` `/tts`), while making the floating desktop character window 100% background-free (character only) and freely draggable to any screen position.

**Architecture:** Fix `createTailSafeMarkerParser` so malformed `}>` closers from 2B models extract the `<|ACT ...>` signal without swallowing the assistant's reply text; compress the local Ollama system prompt (< 950 tokens) so `system + tools + history + 768 mtmd audio budget` always fits inside `4096` tokens without dropping `input_audio` or disabling tools; bridge `turn-orchestrator.ts` to Ollama's `llama-server.exe` `POST /tts` endpoint (`lfm3a_gen`) to emit 24 kHz `turn:audio-delta` WAV + `vowelFrames`; and strip all opaque backgrounds/cards/scrollbars from `?view=stage-overlay` while adding pointer-drag IPC (`ashy:setOverlayPosition`, `ashy:getOverlayBounds`, `ashy:focusHubWindow`) with click-through locking during drag.

**Tech Stack:** TypeScript, React 19, Electron 35, Vitest, PixiJS / Live2D Cubism Core, Ollama (`v0.40.13` / `llama-server` `b11960+` with `lfm3a` & `lfm3a_gen`).

**Spec:** `docs/superpowers/specs/2026-10-31-phase-9-2-ollama-omni-and-transparent-draggable-overlay-design.md`

## Global Constraints

- Canonical Ollama Omni Model ID: `'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M'` (auto-healing legacy `'lfm3-omni:2b'`).
- Local Ollama prompt budget: `finalSystemPrompt` for local 2B models must stay under `3,600` characters (~900 tokens) while keeping `tools` (`maxSteps: 5`) enabled so `input_audio` is never truncated by `default_num_ctx = 4096`.
- Transparent overlay invariants: `html`, `body`, `#root`, and `[data-testid="floating-stage-overlay"]` must have `background: transparent` and `overflow: hidden` when `?view=stage-overlay` is active; all existing `data-testid` attributes in `phase6-digital-body-ui.test.tsx` must remain in the DOM.
- Drag invariants: Do not use CSS `-webkit-app-region: drag` on the stage canvas (it blocks `mousemove` in Electron on Windows); use pointer events + `window.ashyHost.setOverlayPosition` and keep `ignoreMouseEvents = false` while `isDragging === true`.

---

### Task 1: Resilient Marker Parser (`}>` Closer Tolerance) & Embedding 404 Circuit-Breaker

**Files:**
- Modify: `packages/llm/src/marker-parser.ts:42-65`
- Modify: `packages/llm/src/marker-parser.ts:315-376`
- Modify: `packages/llm/src/embeddings.ts:894-968`
- Test: `packages/llm/src/__tests__/marker-parser-lenient-closer.test.ts`

**Interfaces:**
- Consumes: `AshyStageSignal`, `TailSafeMarkerParserCallbacks`
- Produces: `parseStageSignal(rawTagContent: string): AshyStageSignal`, `createTailSafeMarkerParser(callbacks: TailSafeMarkerParserCallbacks): TailSafeMarkerParser`, `stripResidualStageMarkers(raw: string): string`

- [ ] **Step 1: Write the failing test**

Create `packages/llm/src/__tests__/marker-parser-lenient-closer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  createTailSafeMarkerParser,
  parseStageSignal,
  stripResidualStageMarkers,
  type AshyStageSignal,
} from '../marker-parser.js'
import { createOpenAICompatibleEmbeddingProvider } from '../embeddings.js'

describe('Phase 9.2 — Lenient Marker Closer (}>) & Embedding 404 Circuit Breaker', () => {
  it('parses <|ACT {...}> closed with }> instead of }|> and preserves all visible text', () => {
    const literals: string[] = []
    const signals: AshyStageSignal[] = []
    const parser = createTailSafeMarkerParser({
      onLiteral: (text) => literals.push(text),
      onSpecial: (sig) => signals.push(sig),
    })

    const realSessionOutput =
      '<|ACT {"emotion":"curious","intensity":0.68,"motion":"thinking"}>Carlos, o que você quer que eu analise ou te conte hoje?'
    parser.write(realSessionOutput)
    parser.flush()

    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      type: 'act',
      emotion: 'curious',
      intensity: 0.68,
      motion: 'thinking',
    })
    expect(literals.join('')).toBe('Carlos, o que você quer que eu analise ou te conte hoje?')
  })

  it('handles chunked streaming of <|ACT {...}> across token boundaries without leaking tag bytes', () => {
    const literals: string[] = []
    const signals: AshyStageSignal[] = []
    const parser = createTailSafeMarkerParser({
      onLiteral: (text) => literals.push(text),
      onSpecial: (sig) => signals.push(sig),
    })

    const chunks = [
      '<|',
      'ACT {"emotion":"warm",',
      '"intensity":0.8,"motion":"nod"}',
      '>Oi ',
      'Carlos! Tudo bem?',
    ]
    for (const chunk of chunks) {
      parser.write(chunk)
    }
    parser.flush()

    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      type: 'act',
      emotion: 'warm',
      intensity: 0.8,
      motion: 'nod',
    })
    expect(literals.join('')).toBe('Oi Carlos! Tudo bem?')
  })

  it('recovers trailing visible text on flush() if a malformed tag has a > closer without JSON', () => {
    const literals: string[] = []
    const parser = createTailSafeMarkerParser({
      onLiteral: (text) => literals.push(text),
      onSpecial: () => {},
    })

    parser.write('<|DELAY 0.5>Fala recuperada com sucesso.')
    parser.flush()

    expect(literals.join('')).toBe('Fala recuperada com sucesso.')
  })

  it('stripResidualStageMarkers removes both <|...|> and <|...}> tags cleanly', () => {
    const raw =
      '<|ACT {"emotion":"curious","intensity":0.68,"motion":"thinking"}>Oi Carlos! <|DELAY 0.5|>Tudo bem?'
    expect(stripResidualStageMarkers(raw)).toBe('Oi Carlos! Tudo bem?')
    expect(
      parseStageSignal('<|ACT {"emotion":"curious","intensity":0.68,"motion":"thinking"}>'),
    ).toMatchObject({
      type: 'act',
      emotion: 'curious',
    })
  })

  it('short-circuits subsequent embedding HTTP calls after a 404 model-not-found error', async () => {
    let calls = 0
    const provider = createOpenAICompatibleEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'nomic-embed-text',
      fetchImpl: async () => {
        calls += 1
        return new Response('model "nomic-embed-text" not found', { status: 404 })
      },
    })

    await expect(provider.embedText('primeiro teste')).rejects.toThrow(/404/)
    await expect(provider.embedText('segundo teste')).rejects.toThrow(/404/)
    expect(calls).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/llm test marker-parser-lenient-closer`
Expected: FAIL (`stripResidualStageMarkers` is not exported and `literals.join('')` is `""` instead of `'Carlos, o que você quer que eu analise ou te conte hoje?'`).

- [ ] **Step 3: Write minimal implementation**

In `packages/llm/src/marker-parser.ts`:
1. Update `stripOuterDelimiters` to also strip `<|...}>` and `<|...>`:
```ts
function stripOuterDelimiters(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith(OPEN_STD) && trimmed.endsWith(CLOSE_STD)) {
    return trimmed.slice(OPEN_STD.length, -CLOSE_STD.length).trim()
  }
  if (trimmed.startsWith(OPEN_ESC) && trimmed.endsWith(CLOSE_ESC)) {
    return trimmed.slice(OPEN_ESC.length, -CLOSE_ESC.length).trim()
  }
  if (trimmed.startsWith(OPEN_STD) && trimmed.endsWith('>')) {
    return trimmed.slice(OPEN_STD.length, -1).trim()
  }
  if (trimmed.startsWith(OPEN_ESC) && trimmed.endsWith('>')) {
    return trimmed.slice(OPEN_ESC.length, -1).trim()
  }
  return trimmed
}

export function stripResidualStageMarkers(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  return raw
    .replace(/<\|[\s\S]*?(?:\|>|\}>|>)/g, '')
    .replace(/<\{'\|'\}[\s\S]*?(?:\{'\|'\}|>)/g, '')
    .trim()
}
```
2. In `createTailSafeMarkerParser` (`drain()` and `flush()`), add a helper `findTagCloser(buffer, activeOpener)` that finds the earliest valid closer among `expectedCloser` (`|>` / `{'|'}>`), `}>` (when preceded by `{`), or `>` (when the tag starts with `<|ACT`, `<|DELAY`, `<|CALLBACK`), and in `flush()` if `activeOpener !== null` and `buffer` contains `>`, slice after the first `>` and emit the remaining text via `emitLiteralSafe` instead of discarding the entire buffer!
3. In `packages/llm/src/embeddings.ts`, inside `createOpenAICompatibleEmbeddingProvider`, track `let cachedNotFoundError: string | null = null`. When `response.status === 404`, store the error message in `cachedNotFoundError` and throw immediately on subsequent calls without hitting the network again.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/llm test`
Expected: PASS (all `@ashy/llm` tests pass).

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src/marker-parser.ts packages/llm/src/embeddings.ts packages/llm/src/__tests__/marker-parser-lenient-closer.test.ts
git commit -m "fix(llm): tolerate malformed }> stage marker closers and circuit-break 404 embeddings"
```

---

### Task 2: Unify `hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M` Model ID, Vault Auto-Heal & Wake-Word Fallback Fix

**Files:**
- Modify: `packages/shared/src/host-protocol.ts:380-525`
- Modify: `apps/desktop/src/host/provider-vault.ts:450-475`
- Modify: `apps/desktop/src/store/useAshyStore.ts:5620-5645`
- Modify: `apps/desktop/src/components/ModelsSettingsPanel.tsx:260-275`
- Modify: `apps/desktop/src/components/FirstMeetingWizard.tsx:120-140`
- Modify: `packages/voice/src/voice-session-runtime.ts:1295-1325`
- Test: `apps/desktop/src/__tests__/phase-9-2-model-id-and-wakeword.test.ts`

**Interfaces:**
- Consumes: `RECOMMENDED_LOCAL_MODELS`, `DEFAULT_PROVIDER_CONFIGS`, `ProviderVault`
- Produces: Auto-healed `'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M'` across presets, onboarding, and vault persistence; wake-word bypass when `activeSttProviderId === 'deterministic-wav-stt'`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/__tests__/phase-9-2-model-id-and-wakeword.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DEFAULT_PROVIDER_CONFIGS, FALLBACK_PROVIDER_MODELS } from '@ashy/shared'
import { createProviderVault } from '../host/provider-vault.js'

describe('Phase 9.2 — Canonical LFM3-Omni-2B-GGUF Model ID & Auto-Heal', () => {
  it('uses hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M as default and fallback first Ollama model', () => {
    expect(DEFAULT_PROVIDER_CONFIGS.ollama.modelId).toBe(
      'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M',
    )
    expect(FALLBACK_PROVIDER_MODELS.ollama[0]?.id).toBe(
      'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M',
    )
  })

  it('auto-heals legacy lfm3-omni:2b in providers.json to hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-vault-9-2-'))
    const filePath = path.join(tmpDir, 'providers.json')
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        activeProviderId: 'ollama',
        configs: {
          ollama: {
            ...DEFAULT_PROVIDER_CONFIGS.ollama,
            modelId: 'lfm3-omni:2b',
          },
        },
      }),
      'utf8',
    )

    const vault = createProviderVault({ filePath })
    expect(vault.getPublicState().configs.ollama.modelId).toBe(
      'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M',
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/desktop test phase-9-2-model-id-and-wakeword`
Expected: FAIL (`DEFAULT_PROVIDER_CONFIGS.ollama.modelId` is `'lfm3-omni:2b'`).

- [ ] **Step 3: Write minimal implementation**

1. In `packages/shared/src/host-protocol.ts`:
   - Set `DEFAULT_PROVIDER_CONFIGS.ollama.modelId = 'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M'`.
   - Set `FALLBACK_PROVIDER_MODELS.ollama[0]` to `{ id: 'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M', label: 'Liquid LFM3 Omni 2B (Voz + Visão + Texto Nativo)', contextWindow: 32768, isOmni: true }`.
2. In `apps/desktop/src/host/provider-vault.ts`:
   - Add `'lfm3-omni:2b'` to the legacy Ollama model auto-heal check so any saved `'lfm3-omni:2b'` heals to `'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M'` and clears stale `404` `lastError`.
3. In `apps/desktop/src/store/useAshyStore.ts`, `apps/desktop/src/components/ModelsSettingsPanel.tsx`, and `apps/desktop/src/components/FirstMeetingWizard.tsx`:
   - Update `'lfm3-omni:2b'` to `'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M'` (and if `localRuntime.installedModels` has a matching `lfm3-omni` model installed, prefer its exact installed `name`).
4. In `packages/voice/src/voice-session-runtime.ts`:
   - When `clause` is the simulated placeholder from `'deterministic-wav-stt'` (`clause.includes('[Transcrição simulada')`), do not block or discard the voice burst on wake-word comparison.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/desktop test phase-9-2-model-id-and-wakeword`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/host-protocol.ts apps/desktop/src/host/provider-vault.ts apps/desktop/src/store/useAshyStore.ts apps/desktop/src/components/ModelsSettingsPanel.tsx apps/desktop/src/components/FirstMeetingWizard.tsx packages/voice/src/voice-session-runtime.ts apps/desktop/src/__tests__/phase-9-2-model-id-and-wakeword.test.ts
git commit -m "fix(models): unify LFM3-Omni-2B GGUF model ID and auto-heal legacy presets"
```

---

### Task 3: Native 24 kHz `LFM3-Omni-2B` Voice/ASR Bridge (`llama-server` `/tts`) & Compact Local Prompt with Tools

**Files:**
- Create: `apps/desktop/src/host/ollama-native-audio-bridge.ts`
- Modify: `apps/desktop/src/host/turn-orchestrator.ts:255-315`
- Modify: `apps/desktop/src/host/turn-orchestrator.ts:680-785`
- Modify: `apps/desktop/src/host/turn-orchestrator.ts:930-1120`
- Modify: `apps/desktop/src/host/voice-runtime-service.ts`
- Test: `apps/desktop/src/__tests__/phase-9-2-ollama-omni-native-voice.test.ts`

**Interfaces:**
- Consumes: `decodeWavToPcmBlocks`, `extractPcmFrameVowelWeights`, `stripResidualStageMarkers`
- Produces:
  - `discoverOllamaLlamaServerBaseUrl(options?: { ollamaLogPath?: string; fetchImpl?: typeof fetch }): Promise<string | null>`
  - `synthesizeNativeOllamaOmniSpeech(input: { text: string; voice?: 'female' | 'male'; language?: string; signal?: AbortSignal; llamaServerBaseUrl?: string; fetchImpl?: typeof fetch }): Promise<{ wavBytes: Uint8Array; sampleRate: number } | null>`
  - `buildCompactLocalOmniSystemPrompt(input: { fullSystemPrompt: string; userMessage: string }): string`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/__tests__/phase-9-2-ollama-omni-native-voice.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { encodePcm16MonoWav } from '@ashy/voice'
import {
  buildCompactLocalOmniSystemPrompt,
  extractLlamaServerPortFromLogText,
  synthesizeNativeOllamaOmniSpeech,
} from '../host/ollama-native-audio-bridge.js'

describe('Phase 9.2 — Ollama Native LFM3-Omni-2B 24kHz Voice Bridge & Compact Local Prompt', () => {
  it('extracts the most recent llama-server port from Ollama server.log lines', () => {
    const sampleLog = [
      'time=2026-10-31T16:49:11.659-03:00 level=INFO source=llama_server.go:467 msg="starting llama-server" cmd="C:\\\\llama-server.exe --model blob1 --port 61732 --host 127.0.0.1"',
      'time=2026-10-31T19:17:55.100-03:00 level=INFO source=llama_server.go:467 msg="starting llama-server" cmd="C:\\\\llama-server.exe --model blob1 --port 64597 --host 127.0.0.1 --mmproj blob2"',
    ].join('\n')

    expect(extractLlamaServerPortFromLogText(sampleLog)).toBe(64597)
  })

  it('compacts local Ollama Omni system prompt to under 3200 chars while preserving <|ACT|> and tool guidance', () => {
    const bloated = 'A'.repeat(12000) + '\n[STAGE ACTUATION]\nUse <|ACT {"emotion":"warm"}|>'
    const compact = buildCompactLocalOmniSystemPrompt({
      fullSystemPrompt: bloated,
      userMessage: 'Oi Ashy, tudo bem?',
    })

    expect(compact.length).toBeLessThan(3200)
    expect(compact).toContain('<|ACT')
    expect(compact).toContain('Ashy')
  })

  it('synthesizes 24kHz WAV via llama-server POST /tts with UTF-8 JSON payload', async () => {
    const fakeSamples = new Float32Array(2400)
    for (let i = 0; i < fakeSamples.length; i++) {
      fakeSamples[i] = Math.sin((2 * Math.PI * 220 * i) / 24000) * 0.4
    }
    const wavBuf = encodePcm16MonoWav(fakeSamples, 24000)

    let capturedUrl = ''
    let capturedBody = ''
    const result = await synthesizeNativeOllamaOmniSpeech({
      text: 'Oi Carlos! Tudo ótimo por aqui.',
      voice: 'female',
      language: 'pt',
      llamaServerBaseUrl: 'http://127.0.0.1:64597',
      fetchImpl: async (url, init) => {
        capturedUrl = String(url)
        capturedBody =
          init?.body instanceof Uint8Array
            ? Buffer.from(init.body).toString('utf8')
            : String(init?.body ?? '')
        return new Response(wavBuf, {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        })
      },
    })

    expect(capturedUrl).toBe('http://127.0.0.1:64597/tts')
    expect(JSON.parse(capturedBody)).toEqual({
      input: 'Oi Carlos! Tudo ótimo por aqui.',
      voice: 'female',
      language: 'pt',
      response_format: 'wav',
    })
    expect(result).not.toBeNull()
    expect(result?.sampleRate).toBe(24000)
    expect(result?.wavBytes.byteLength).toBeGreaterThan(1000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/desktop test phase-9-2-ollama-omni-native-voice`
Expected: FAIL (`Cannot find module '../host/ollama-native-audio-bridge.js'`).

- [ ] **Step 3: Write minimal implementation**

1. Create `apps/desktop/src/host/ollama-native-audio-bridge.ts`:
   - Implement `extractLlamaServerPortFromLogText(logText: string): number | null` (regex matching `--port\s+(\d+)` on `llama-server` lines and returning the last match).
   - Implement `discoverOllamaLlamaServerBaseUrl`:
     - Reads the last 64 KB of `%LOCALAPPDATA%\Ollama\server.log` (or `~/.ollama/logs/server.log`) and checks `GET http://127.0.0.1:<port>/health`.
     - If the log file isn't found or port changed, falls back on Windows to querying `Get-CimInstance Win32_Process -Filter "Name = 'llama-server.exe'"` via `execFile` (`windowsHide: true`).
     - Caches the verified base URL until a connection error occurs.
   - Implement `synthesizeNativeOllamaOmniSpeech`:
     - Sends UTF-8 `POST ${baseUrl}/tts` with `{ input, voice: voice === 'male' ? 'male' : 'female', language: language ?? 'pt', response_format: 'wav' }`.
     - Validates the `RIFF`/`WAVE` header and returns `{ wavBytes, sampleRate }`.
   - Implement `buildCompactLocalOmniSystemPrompt`:
     - When the active provider is local Ollama, keeps the prompt concise (< 3,200 chars / ~850 tokens) including Ashy's Portuguese persona, memory snippets from `fullSystemPrompt`, tool-calling instructions, and explicit rule: `Sempre feche a tag de emoção exatamente com }|> (ex: <|ACT {"emotion":"curious","intensity":0.75,"motion":"head_tilt"}|>) antes da sua fala em português.`
2. In `apps/desktop/src/host/turn-orchestrator.ts`:
   - In `resolveOmniTurnUserText`: when `input.inputAudio` is present and no transcript hint exists, keep `effectiveUserText` as `'🎤 [Voz]'` for UI display while passing a clear multimodal prompt instruction (`'Ouça o áudio em português anexado pelo usuário e responda diretamente de forma natural.'`) in `userParts` so the 2B model knows to answer the spoken audio directly.
   - When `providerState.activeProviderId === 'ollama'`, apply `buildCompactLocalOmniSystemPrompt` so `finalSystemPrompt + tools + history + 768 (mtmd audio budget)` is ~2,100 tokens (< 4,096), preserving both **native `input_audio` decoding** AND **full `tools` (`maxSteps: 5`)**.
   - After the `while (true)` stream loop finishes and `parser.flush()` runs:
     - Compute `const fallbackClean = stripResidualStageMarkers(rawAccum)`.
     - Set `const finalVisibleContent = cleanText || fallbackClean || '...'`.
     - If `audioChunkSeq === 0`, `finalVisibleContent !== '...'`, and `providerState.activeProviderId === 'ollama'` with `activeConfig?.isOmniModel`:
       - Call `synthesizeNativeOllamaOmniSpeech({ text: finalVisibleContent, voice: 'female', language: 'pt', signal: controller.signal })`.
       - If it returns `wavBytes`, decode PCM samples via `decodeWavToPcmBlocks`, compute `vowelFrames` via `extractPcmFrameVowelWeights`, and emit `turn:audio-delta` (`format: 'wav'`, `sampleRate`, `audioBase64`, `durationMs`, `vowelFrames`) right before `turn:completed`!

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/desktop test phase-9-2-ollama-omni-native-voice`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/host/ollama-native-audio-bridge.ts apps/desktop/src/host/turn-orchestrator.ts apps/desktop/src/host/voice-runtime-service.ts apps/desktop/src/__tests__/phase-9-2-ollama-omni-native-voice.test.ts
git commit -m "feat(omni): add native 24kHz LFM3-Omni-2B /tts bridge and compact Ollama prompt budget"
```

---

### Task 4: 100% Transparent Frameless Character Overlay & Free Pointer Dragging via IPC

**Files:**
- Modify: `apps/desktop/index.html:16-33`
- Modify: `apps/desktop/src/electron/main.ts:18-130`
- Modify: `apps/desktop/src/main/index.ts:178-206`
- Modify: `apps/desktop/src/main/index.ts:365-480`
- Modify: `apps/desktop/src/main/index.ts:610-636`
- Modify: `apps/desktop/src/preload/index.ts:29-130`
- Modify: `packages/stage/src/components/AshyStageCanvas.tsx:772-994`
- Modify: `apps/desktop/src/App.tsx:265-588`
- Test: `apps/desktop/src/__tests__/phase-9-2-transparent-draggable-overlay.test.tsx`

**Interfaces:**
- Consumes: `AshyPreloadApi`, `ElectronBrowserWindowInstanceLike`, `AshyStageCanvasProps`
- Produces:
  - `window.ashyHost.getOverlayBounds(): Promise<{ x: number; y: number; width: number; height: number }>`
  - `window.ashyHost.setOverlayPosition(input: { x: number; y: number }): Promise<{ x: number; y: number; width: number; height: number }>`
  - `window.ashyHost.focusHubWindow(): Promise<{ focused: boolean }>`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/__tests__/phase-9-2-transparent-draggable-overlay.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { App } from '../App.js'
import { resetAshyStoreForTests } from '../store/useAshyStore.js'

describe('Phase 9.2 — 100% Transparent Overlay & Free Pointer Dragging', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/?view=stage-overlay')
    resetAshyStoreForTests()
  })

  it('renders transparent overlay without studio chat form or opaque card borders and drags via setOverlayPosition IPC', async () => {
    const setOverlayPosition = vi.fn().mockResolvedValue({ x: 240, y: 180, width: 380, height: 460 })
    const getOverlayBounds = vi.fn().mockResolvedValue({ x: 100, y: 100, width: 380, height: 460 })
    const setOverlayIgnoreMouse = vi.fn().mockResolvedValue({
      isOverlayVisible: true,
      ignoringMouseEvents: false,
      alwaysOnTopLevel: 'screen-saver',
      shortcuts: {},
    })

    ;(window as unknown as { ashyHost: Record<string, unknown> }).ashyHost = {
      invoke: vi.fn().mockResolvedValue({}),
      onEvent: () => () => {},
      setOverlayPosition,
      getOverlayBounds,
      setOverlayIgnoreMouse,
    }

    const { getByTestId, queryByPlaceholderText } = render(<App />)

    const overlayEl = getByTestId('floating-stage-overlay')
    expect(overlayEl.style.background).toBe('transparent')
    expect(overlayEl.style.padding).toBe('0px')
    expect(document.body.style.backgroundColor).toBe('transparent')

    // Studio text input inside the floating overlay window must not clutter the transparent pet
    expect(queryByPlaceholderText(/Fale com a Ashy/i)).toBeNull()

    const canvas = getByTestId('ashy-stage-canvas')
    fireEvent.mouseDown(canvas, { button: 0, screenX: 200, screenY: 200, clientX: 190, clientY: 230 })
    fireEvent.mouseMove(window, { screenX: 340, screenY: 280 })
    fireEvent.mouseUp(window)

    await waitFor(() => {
      expect(setOverlayPosition).toHaveBeenCalledWith({ x: 240, y: 180 })
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/desktop test phase-9-2-transparent-draggable-overlay`
Expected: FAIL (`overlayEl.style.padding` is `'24px'`, `queryByPlaceholderText(/Fale com a Ashy/i)` is not null, and `setOverlayPosition` was not called).

- [ ] **Step 3: Write minimal implementation**

1. **`apps/desktop/index.html`:**
   - Add CSS rule for `html.ashy-transparent-overlay, html.ashy-transparent-overlay body, html.ashy-transparent-overlay #root { background: transparent !important; background-color: transparent !important; overflow: hidden !important; }` and an inline `<script>` in `<head>` that adds `ashy-transparent-overlay` to `document.documentElement` immediately if `window.location.search.includes('view=stage-overlay')`.
2. **`apps/desktop/src/main/index.ts` & `apps/desktop/src/preload/index.ts`:**
   - Extend `ElectronBrowserWindowInstanceLike` with `getBounds?()`, `setBounds?(bounds)`, `getPosition?()`, `setPosition?(x, y)`.
   - Add IPC channels:
     - `ashy:getOverlayBounds`: returns `resolveOverlayWindow()?.getBounds?.() ?? { x: 80, y: 80, width: 380, height: 460 }`.
     - `ashy:setOverlayPosition`: validates `{ x: number, y: number }`, calls `overlayWin.setBounds({ x: Math.round(x), y: Math.round(y), width: bounds.width, height: bounds.height })`, saves `{ overlayX, overlayY }` into `stage-preferences.json`, and returns updated bounds.
     - `ashy:focusHubWindow`: shows/unminimizes/focuses `resolveHubWindow()`.
   - Fix `setIgnoreMouseEvents` initial sync at lines `623-625`: initialize `overlayWindow` with `ignoringMouseEvents: false` (synced with `overlayController`) and restore saved `{ overlayX, overlayY }` from `stage-preferences.json` if present.
   - Expose `getOverlayBounds`, `setOverlayPosition`, and `focusHubWindow` in `apps/desktop/src/preload/index.ts`.
3. **`packages/stage/src/components/AshyStageCanvas.tsx`:**
   - Hide `live2d-parameter-hud` when `transparentBackground` is `true`.
   - Hide `PresenceBubble` when `transparentBackground` is `true` and `(bubbleText.trim() === '' || bubbleText.trim() === '...') && (!statusLabel || statusLabel.toLowerCase() === 'idle')`.
   - Accept optional `isDragging?: boolean` prop (or lock internally during drag) so `handleMouseMove` never calls `onIgnoreMouseChange(true)` while the user is actively dragging the character.
4. **`apps/desktop/src/App.tsx` (`viewMode === 'stage'`):**
   - In `useEffect`, when `state.isTransparentOverlayWindow` is `true`, set `document.documentElement.style.backgroundColor = 'transparent'`, `document.body.style.backgroundColor = 'transparent'`, and `document.body.style.overflow = 'hidden'`.
   - When `state.isTransparentOverlayWindow` is `true`:
     - Set `[data-testid="floating-stage-overlay"]` `padding: '0px'`, `width: '100vw'`, `height: '100vh'`, `overflow: 'hidden'`, `background: 'transparent'`.
     - Set the inner wrapper `padding: '0px'`, `width: '380px'`, `height: '460px'`, `position: 'relative'`, `background: 'transparent'`, `border: 'none'`, `boxShadow: 'none'`.
     - Implement pointer drag on the character container (`onMouseDown` on left click outside `[data-ui-island="true"]` -> reads initial bounds from `window.ashyHost?.getOverlayBounds?.()` or cached `{ x, y }` -> updates position on `window` `mousemove` via `window.ashyHost?.setOverlayPosition?.({ x, y })` -> releases on `mouseup`).
     - Keep `stage-quick-controls` (`data-testid="stage-quick-controls"`) overlaid compactly at the bottom (`position: 'absolute'`, `bottom: '6px'`) with `opacity: isHoveringOverlay ? 0.94 : 0`, `transition: 'opacity 0.2s ease'`, and omit the bottom studio sensor bar and text chat form when `state.isTransparentOverlayWindow` is `true`.
     - Wire `btn-expand-hub` (`Voltar ao estúdio`) so in `isTransparentOverlayWindow` mode it calls `window.ashyHost?.focusHubWindow?.()` instead of switching the tiny overlay window into `hub` mode.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/desktop test`
Expected: PASS (both the new `phase-9-2-transparent-draggable-overlay.test.tsx` and existing `phase6-digital-body-ui.test.tsx` pass).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/index.html apps/desktop/src/electron/main.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts packages/stage/src/components/AshyStageCanvas.tsx apps/desktop/src/App.tsx apps/desktop/src/__tests__/phase-9-2-transparent-draggable-overlay.test.tsx
git commit -m "feat(stage): make floating character overlay 100% transparent and freely draggable"
```

---

### Task 5: Full Verification, Visual Browser Inspection & Installed App Rebuild (`Ashy.exe`)

**Files:**
- Modify: `C:\Users\carlos\AppData\Roaming\@ashy\desktop\providers.json` (auto-heal verification)
- Build: `apps/desktop/dist` & `C:\Users\carlos\AppData\Local\Programs\Ashy\Ashy.exe`

- [ ] **Step 1: Run full monorepo test suite and typecheck**

Run: `pnpm test`
Expected: 100% of packages and test suites pass with 0 errors.

- [ ] **Step 2: Visual inspection in real browser (Playwright)**

Start dev server / preview and open `http://localhost:5173/?view=stage-overlay` in Playwright:
- Verify computed `backgroundColor` of `html`, `body`, `#root`, and `[data-testid="floating-stage-overlay"]` is `rgba(0, 0, 0, 0)`.
- Verify zero scrollbars (`document.documentElement.scrollHeight <= window.innerHeight`).
- Verify only the character is visible at rest, with hover controls appearing smoothly on mouse enter and dragging updating position cleanly.

- [ ] **Step 3: Rebuild and update the installed application (`AshySetup.exe` / `Ashy.exe`)**

Run: `pnpm --filter @ashy/desktop dist:win` and run `install.ps1` / silent NSIS update so `C:\Users\carlos\AppData\Local\Programs\Ashy\Ashy.exe` has all Phase 9.2 fixes installed immediately.
