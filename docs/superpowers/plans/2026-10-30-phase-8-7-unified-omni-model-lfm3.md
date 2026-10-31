# Fase 8.7 — Modelo Omni Unificado (Voz, Texto, Imagem e Vídeo Local `LFM3-Omni-2B` & Cloud) Implementation Plan (Red-Team Hardened)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar suporte completo a um **Único Modelo Omni Unificado** capaz de receber **Voz (`input_audio` 16kHz WAV/PCM16), Texto, Imagem e Vídeo (`2 fps` keyframes deduplicados por `dHash`)** e responder com **Texto + Sinais de Palco (`<|ACT|>`) + Áudio Nativo em Streaming (`turn:audio-delta` 24kHz PCM16/WAV)** (com fallback automático para TTS em `hybrid-omni-in`), tanto localmente (com foco de primeira classe no **`LFM3-Omni-2B`** da Liquid AI via `llama-server` / `Ollama` / `vLLM`) quanto nos provedores Cloud (`OpenAI gpt-4o-audio-preview`, `Qwen 2.5 Omni 7B`, `Google Gemini 2.5 Flash`).

**Red-Team Corrections Applied (CRITICAL-1..3, HIGH-1..4, MEDIUM-1):**
- **CRITICAL-1 (Prevenção de Fala Duplicada TTS Externo + Áudio Nativo Omni em `useAshyStore.ts`):**
  - Em `case 'turn:delta'`: se `omniNativeAudioTurnIds.has(event.turnId)` OU `(state.unifiedOmniMode && state.directOmniAudio)`, **não** chamar `pipeline.enqueueDelta(event.textDelta)`.
  - Em `case 'turn:audio-delta'`: registrar `omniNativeAudioTurnIds.add(event.turnId)` e chamar `activePipeline?.reset()` para descartar qualquer síntese externa residual.
  - Em `case 'turn:completed'`: se `omniNativeAudioTurnIds.has(event.turnId)` for `true`, chamar `voiceRuntime.getPlayer().markStreamComplete(true)` e pular `pipeline.flush()`; se for `false` (auto-downgrade HTTP 400/422 para `hybrid-omni-in` texto puro), fazer fallback enfileirando o texto completo no `pipeline` para que a Ashy nunca fique muda.
- **CRITICAL-2 (Repasse de `modalities`, `audioOutput` e `audio-delta` em `stream-text.ts`):**
  - Garantir que `streamText()` repasse `modalities` e `audioOutput` para `model(...)` e que o gerador `generateEvents()` faça `yield` de `{ type: 'audio-delta', ... }` e `{ type: 'input-transcript', ... }`, acumulando `transcriptDelta` em `stepText` / `fullText` quando não houver `text-delta` separado.
- **CRITICAL-3 (Anti-SSRF e Proibição de `file://` / `http://` em Anexos Multimodais):**
  - Validar `TurnVideoFrameSchema.dataUrl`, `TurnInputAudioSchema.dataBase64` e `TurnAttachmentSchema.dataUrlOrBase64` com regex estrita aceitando apenas `data:(image|audio|video)/...;base64,...` ou base64 puro, bloqueando `file://`, `http://`, `https://` e `javascript:`.
- **HIGH-1 (Compatibilidade 100% com `host-protocol.test.ts` e `phase-8-2-*.test.ts`):**
  - Manter `v.maxLength(16000)` em `SendTurnInputSchema.text` e exigir via `v.check(...)` que pelo menos um entre `text.trim().length > 0`, `inputAudio`, `videoFrames.length > 0` ou `attachments.length > 0` seja verdadeiro (preservando a falha de `{ sessionId: 'sess-1', text: '   ' }`).
  - Tornar todos os novos campos em `ProviderModelCatalogItemSchema` e `PublicProviderConfigSchema` opcionais (`v.optional(...)`).
- **HIGH-2 (Retry HTTP 400/422 Unificado em `adapters.ts`):**
  - Ao receber HTTP 400 ou 422 em `createOpenAICompatibleModel`, remover tanto `OMNI_AUDIO_PAYLOAD_KEYS` (`modalities`, `audio`, `audio_temperature`, `audio_repetition_penalty`, `audio_repetition_window`) quanto `REASONING_PAYLOAD_KEYS` (`reasoning`, `reasoning_effort`, `think`, `chat_template_kwargs`) no retry automático.
- **HIGH-3 (Barge-In Real sobre Áudio Nativo Omni):**
  - Rastrear `omniPlaybackItems` em `VoiceSessionRuntime` (`ingestOmniAudioDelta`) e conectar `interruptOmniPlayback` / `computeOmniPlaybackReceipt` tanto no Barge-In automático do VAD (`executeAutomaticBargeIn`) quanto em `triggerBargeIn()` da store.
- **HIGH-4 (`SeriousnessGate` e Mensagem SQLite em Turnos Somente-Áudio):**
  - Resolver `effectiveUserText` sincronamente no início de `TurnOrchestrator.sendTurn` (a partir de `input.text`, `input.inputAudio.transcriptHint`, metadado WAV `ICMT` ou `"[Mensagem de voz Omni]"`), aplicando `evaluateSeriousnessGate` e `analyzeUserAffectReaction` antes do stream e atualizando a mensagem no SQLite caso `input-transcript` chegue durante o turno.
- **MEDIUM-1 (Guard `generationId` na Webcam contra Race Condition no Privacy Shield):**
  - Se `activateFullPrivacyShield()` ou `setEyesMode('off')` for acionado enquanto `getUserMedia({ video: true })` estiver pendente, parar imediatamente todas as `MediaStreamTrack`s assim que a Promise resolver.

---

### Task 1: Protocolo `@ashy/shared`, Adaptador Multimodal Unificado `@ashy/llm` (`LFM3-Omni-2B` + Cloud) e Diretiva Nativa `@ashy/cortex`

**Files:**
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `packages/shared/src/__tests__/host-protocol.test.ts`
- Modify: `packages/llm/src/stream-text.ts`
- Modify: `packages/llm/src/adapters.ts`
- Modify: `packages/llm/src/index.ts`
- Create: `packages/llm/test/llm-omni.test.ts`
- Modify: `packages/cortex/src/prompt/soul-composer.ts`
- Modify: `packages/cortex/src/__tests__/soul-composer-split.test.ts`

- [ ] **Step 1: Write failing tests in `packages/shared/src/__tests__/host-protocol.test.ts`, `packages/llm/test/llm-omni.test.ts`, and `packages/cortex/src/__tests__/soul-composer-split.test.ts`**
  - Test `SendTurnInputSchema`:
    - Rejects `{ sessionId: 'sess-1', text: '   ' }` when no `inputAudio`/`videoFrames`/`attachments` is present (preserving existing test!).
    - Accepts `{ sessionId: 'sess-1', text: '', inputAudio: { dataBase64: 'UklGRg==', format: 'wav' } }` and `{ sessionId: 'sess-1', videoFrames: [{ dataUrl: 'data:image/jpeg;base64,/9j/4AAQ', timestampMs: 500 }] }`.
    - Rejects `TurnVideoFrameSchema` and `TurnAttachmentSchema` when given `file:///etc/passwd` or `http://169.254.169.254/latest/meta-data` (CRITICAL-3).
  - Test `inferModelOmniCapabilities` for `lfm3-omni:2b`, `LiquidAI/LFM3-Omni-2B-GGUF`, `gpt-4o-audio-preview`, `qwen/qwen2.5-omni-7b`, and `google/gemini-2.5-flash`.
  - Test `streamText` + `createOpenAICompatibleModel` in `packages/llm/test/llm-omni.test.ts`:
    - Serializes multimodal `parts` (`input_audio`, `image_url`, `video_frame` with `[Video Frame @ Xms]`).
    - Injects `think: false`, `chat_template_kwargs: { enable_thinking: false }`, `audio_temperature: 0.4`, `audio_repetition_penalty: 1.2`, `modalities: ['text', 'audio']`, and `audio: { voice: 'female', format: 'pcm16' }` for `lfm3-omni:2b`.
    - Yields `audio-delta` and `text-delta` through `streamText` (`CRITICAL-2`).
    - Automatically retries on HTTP 400/422 by stripping `OMNI_AUDIO_PAYLOAD_KEYS` and `REASONING_PAYLOAD_KEYS` (`HIGH-2`).
  - Test `composeAshyTurnPrompt` with `omniOutputMode: 'native-audio'`.

- [ ] **Step 2: Run Vitest to confirm RED state**
  - Run: `pnpm --filter @ashy/shared test; pnpm --filter @ashy/llm test; pnpm --filter @ashy/cortex test`

- [ ] **Step 3: Implement `@ashy/shared`, `@ashy/llm`, and `@ashy/cortex` changes**
  - Update `packages/shared/src/host-protocol.ts`, `packages/llm/src/stream-text.ts`, `packages/llm/src/adapters.ts`, `packages/llm/src/index.ts`, and `packages/cortex/src/prompt/soul-composer.ts`.

- [ ] **Step 4: Run Vitest to confirm GREEN state**
  - Run: `pnpm --filter @ashy/shared test; pnpm --filter @ashy/llm test; pnpm --filter @ashy/cortex test`

---

### Task 2: `ProviderVault` Omni Config, `TurnOrchestrator` Multimodal & Native Audio Streaming (`kernel.ts`, `vite-host-plugin.ts`)

**Files:**
- Modify: `apps/desktop/src/host/provider-vault.ts`
- Modify: `apps/desktop/src/host/turn-orchestrator.ts`
- Modify: `apps/desktop/src/host/kernel.ts`
- Modify: `apps/desktop/src/host/vite-host-plugin.ts`
- Modify: `apps/desktop/src/__tests__/host-kernel.test.ts`

- [ ] **Step 1: Write failing tests in `apps/desktop/src/__tests__/host-kernel.test.ts`**
  - Test `ProviderVault` persisting `omniExecutionMode` and `omniVoiceId`, and surfacing `supportsOmniAudioIn`, `supportsOmniAudioOut`, `supportsOmniVideoIn`.
  - Test `TurnOrchestrator` / `AshyHostKernel.sendTurn`:
    - Sending an audio-only turn (`text: ''`, `inputAudio` with WAV `ICMT` comment or `transcriptHint`) + `videoFrames` evaluates `SeriousnessGate` (`HIGH-4`), emits `turn:input-transcript`, streams `turn:audio-delta` with computed `vowelFrames`, strips `<|ACT|>` from `delta.audio.transcript` to emit `turn:marker` + clean `turn:delta`, and supports the internal `ashy_stage_signal` tool.

- [ ] **Step 2: Run Vitest on `host-kernel.test.ts` to confirm RED state**
  - Run: `pnpm --filter @ashy/desktop test src/__tests__/host-kernel.test.ts`

- [ ] **Step 3: Implement `ProviderVault`, `TurnOrchestrator`, `kernel.ts`, and `vite-host-plugin.ts` changes**
  - Update `apps/desktop/src/host/provider-vault.ts`, `apps/desktop/src/host/turn-orchestrator.ts`, `apps/desktop/src/host/kernel.ts`, and `apps/desktop/src/host/vite-host-plugin.ts` (`MAX_RPC_BODY_BYTES = 20 * 1024 * 1024`).

- [ ] **Step 4: Run Vitest to confirm GREEN state**
  - Run: `pnpm --filter @ashy/desktop test src/__tests__/host-kernel.test.ts`

---

### Task 3: Voz Direta (`directOmniAudio`), Amostrador de Vídeo (`2 fps` + `dHash`), Lip-Sync Acústico no Live2D e UI Omni (`@ashy/voice`, `useAshyStore.ts`, `App.tsx`)

**Files:**
- Modify: `packages/voice/src/wav-codec.ts`
- Modify: `packages/voice/src/voice-session-runtime.ts`
- Modify: `packages/voice/src/index.ts`
- Modify: `packages/voice/test/voice-phase8-6.test.ts`
- Create: `apps/desktop/src/services/omni-media-sampler.ts`
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/components/ModelsSettingsPanel.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/test/phase-8-7-unified-omni-model.test.tsx`
- Modify: `docs/ASHY_ROADMAP.md`

- [ ] **Step 1: Write failing tests in `packages/voice/test/voice-phase8-6.test.ts` and `apps/desktop/src/test/phase-8-7-unified-omni-model.test.tsx`**
  - Test `VoiceSessionRuntime` with `directOmniAudio: true`, `ingestOmniAudioDelta`, `interruptOmniPlayback`, and `computeOmniPlaybackReceipt` (`HIGH-3`).
  - Test `omni-media-sampler.ts` (`2 fps` frame sampling, 64-bit `dHash` deduplication, and `generationId` race-condition guard on `stop()` / `activateFullPrivacyShield()` — `MEDIUM-1`).
  - Test `useAshyStore` + `ModelsSettingsPanel.tsx` + `App.tsx`:
    - `applyOmniModelPreset('lfm3-omni-2b')` configures `lfm3-omni:2b`, `unifiedOmniMode: true`, and `directOmniAudio: true`.
    - `turn:delta` followed by `turn:audio-delta` does NOT trigger double-speaking on external TTS (`CRITICAL-1`), drives `simulatedVowels` / `activeViseme` / `isSpeaking: true`, supports Barge-In over native Omni audio (`HIGH-3`), and falls back to external TTS on `turn:completed` if zero `turn:audio-delta` events were emitted (`CRITICAL-1`).
    - Studio and Settings UI render all new Phase 8.7 `data-testid` controls (`pill-toggle-omni-mode`, `btn-toggle-webcam`, `btn-attach-image`, `btn-attach-video`, `unified-omni-settings-card`, `toggle-unified-omni-mode`, `preset-omni-lfm3-local`, `toggle-direct-omni-audio`).

- [ ] **Step 2: Run Vitest to confirm RED state**
  - Run: `pnpm --filter @ashy/voice test; pnpm --filter @ashy/desktop test src/test/phase-8-7-unified-omni-model.test.tsx`

- [ ] **Step 3: Implement `@ashy/voice`, `omni-media-sampler.ts`, `useAshyStore.ts`, `ModelsSettingsPanel.tsx`, `App.tsx`, and `ASHY_ROADMAP.md`**
  - Implement all Task 3 changes and mark **Fase 8.7** as `✅ Concluída` in `docs/ASHY_ROADMAP.md`.

- [ ] **Step 4: Run full test suite, typecheck, and build**
  - Run: `pnpm test; pnpm typecheck; pnpm build`
