# Fase 8.6 — Pipeline 100% Real de Voz (Modelos Locais & Nuvem de STT/TTS, Microfone, VAD e Lip-Sync) Implementation Plan (Red-Team Hardened)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar todos os fallbacks silenciosos e simulações do pipeline de voz em produção, entregando suporte completo a modelos locais e em nuvem de STT/TTS com chaves criptografadas no cofre do Host, captura real de microfone (`getUserMedia` + `AudioContext` + `AudioWorkletNode`), Silero VAD ONNX real com fallback acústico explícito, Turn-Taking conectado ao LLM real, reprodução gapless multi-formato (`WAV`/`MP3`/`PCM`) com Lip-Sync acústico (`A, E, I, O, U` + `rawVolume`) sincronizado ao Live2D e painel completo de configuração e teste de voz na aba **Configurações > Voz**.

**Red-Team Corrections Applied (C1–C4, H1–H6, M1–M2):**
- **C1 (Preservação de `host-protocol.test.ts` e `voice-phase5.test.ts`):**
  - Atualizar `packages/shared/src/__tests__/host-protocol.test.ts:675-718` para incluir `'groq-whisper'`, `'web-speech-stt'` em `STT_PROVIDER_IDS` e `'web-speech-tts'` em `TTS_PROVIDER_IDS`.
  - Manter `DEFAULT_VOICE_RUNTIME_SETTINGS.activeSttProviderId = 'deterministic-wav-stt'` e `activeTtsProviderId = 'local-synth-fallback'` como defaults do protocolo base para não quebrar os 5 cenários E2E de `voice-phase5.test.ts` nem `phase5-realtime-voice-ui.test.tsx`.
  - Registrar `'groq-whisper'`, `'web-speech-stt'` e `'web-speech-tts'` dentro de `createSttProviderRegistry()` e `createTtsProviderRegistry()`.
- **C2 (Isolamento de `mockFetch` em `desktop.test.tsx` e `phase5-realtime-voice-ui.test.tsx`):**
  - Quando `activeTtsProviderId === 'local-synth-fallback'`, `createPipelineForTurn` e `synthesizeVoiceSpeech` **não** fazem chamada `fetchImpl` HTTP externa (que nos testes de streaming SSE retorna `text/event-stream`), mantendo a síntese determinística local em memória com cadência compatível com `triggerBargeIn(600)` em `desktop.test.tsx`.
- **C3 (Arquitetura RPC Unificada via `ASHY_HOST_RPC_METHODS` e `dispatchHostRpc`):**
  - Registrar `getVoiceRuntimeSettings`, `saveVoiceRuntimeSettings`, `listVoiceProviderModels`, `transcribeVoiceAudio` e `synthesizeVoiceSpeech` em `ASHY_HOST_RPC_METHODS`, `AshyHostBridge` (`packages/shared/src/host-protocol.ts`), `ALLOWED_RPC_METHODS` + `dispatchHostRpc` (`apps/desktop/src/host/vite-host-plugin.ts`), e em `createPreloadHostBridge` + `createHttpSseHostBridge` (`apps/desktop/src/services/ashy-host-client.ts`), além de incluir `voiceSettings?: VoiceRuntimeSettings` em `AshyBootstrapSnapshot`.
- **C4 (Prevenção de Exfiltração de API Keys, Origin Pinning & Anti-SSRF):**
  - Pinning estrito de origem HTTPS para provedores cloud (`https://api.openai.com` para `openai-whisper`/`openai-tts`, `https://api.groq.com` para `groq-whisper`, `https://api.elevenlabs.io` para `elevenlabs`): nunca anexar chaves do cofre cloud nem a chave `openai` herdada do `ProviderVault` a origens diferentes das oficiais.
  - Para provedores locais (`local-whisper-http`, `local-kokoro-http`), validar protocolo `http:`/`https:`, bloquear credenciais na URL, bloquear `0.0.0.0`, `[::]`, `169.254.*`, `fe80:*`, `::ffff:169.254.*`, usar `redirect: 'error'` e `AbortSignal.timeout(15_000)`, e só enviar `localSttApiKey`/`localTtsApiKey` salva se `extractUrlOrigin(effectiveBaseUrl) === extractUrlOrigin(storedBaseUrl)`.
  - Nunca retornar API keys em texto puro no snapshot ou em `getVoiceRuntimeSettings`; retornar apenas flags booleanas (`hasOpenAiApiKey`, `hasGroqApiKey`, `hasElevenLabsApiKey`, `hasLocalSttApiKey`, `hasLocalTtsApiKey`) e previews mascarados (`maskedOpenAiApiKey`, etc.).
- **H1 (`llmJudgeFn` e `llmRephraseFn` reais em `turn-intelligence.ts`):**
  - Implementar e exportar `createOpenAiCompatibleVoiceEndJudgeFn` e `createOpenAiCompatibleSpeculativeRephraseFn` em `packages/voice/src/turn-intelligence.ts` (com timeouts de 400ms e 450ms, `reasoning_effort: 'none'` / temperatura 0 e fallback seguro para heurística).
- **H2 (Separação de `onQueueDrained` vs `onPlaybackEnded` em `GaplessAudioPlayer`):**
  - Não encerrar `isSpeaking` entre o Chunk #0 e o Chunk #1 enquanto `isStreamingTurn === true` ou houver síntese em andamento; disparar a limpeza final (`isSpeaking: false`, `presenceStatus: 'Idle'`, `activeViseme: 'closed'`, `simulatedVowels` zerados) apenas quando o turno terminar de enfileirar chunks e o player concluir o último bloco agendado.
- **H3 (Sem Colisão de Símbolo `analyzePcmFrameToVowels`):**
  - Nomear o extrator em `@ashy/voice` como `extractPcmFrameVowelWeights` e reutilizar `analyzePcmFrameToVowels` de `@ashy/stage` na store.
- **H4 (Mutex/Token de Geração `captureGenerationId` no Microfone e Reuso de `AudioContext`):**
  - Impedir vazamento de `MediaStreamTrack`, `AudioContext` e `ObjectURL` em cliques rápidos de `toggleVoiceConversation` / `startMicrophoneCapture` / `stopMicrophoneCapture`.
- **H5 (Filtro de Alucinações de Silêncio do Whisper & Coordenação de Turnos em `onTurnSealed`):**
  - Filtrar marcadores de silêncio (`[BLANK_AUDIO]`, `(silêncio)`, etc.) e, se um turno de voz selar enquanto um turno anterior ainda estiver ativo, acionar `triggerBargeIn()` antes de enviar `sendUserMessage`.
- **H6 (Limites de Payload Anti-DoS):**
  - Elevar `MAX_RPC_BODY_BYTES` em `vite-host-plugin.ts` para `10 * 1024 * 1024` (10 MB), limitar `audioBase64` a `8_000_000` chars e `text` a `4_096` chars nos schemas Valibot, e limitar respostas binárias de TTS no Kernel a `15 * 1024 * 1024` bytes.
- **M1 & M2 (Compatibilidade Multi-Servidor Local/Cloud & Preservação dos 11 `data-testid` da Fase 5 em `App.tsx`):**
  - Suportar `/v1/audio/transcriptions` com fallback para `/inference` (`whisper.cpp`) em `local-whisper-http`, enviar `response_format: 'wav'` em `openai-tts`/`local-kokoro-http`, decodificar `WAV` e `MP3` (`audio/mpeg`), e preservar os `data-testid` existentes (`voice-runtime-panel`, `select-stt-provider`, `select-tts-provider`, `toggle-wake-word`, `voice-ttfa-badge`, `voice-cas-badge`, `voice-bargein-receipt`, `run-fixture-*`) na seção de diagnóstico do painel de voz.

---

### Task 1: Protocolo, Provedores Reais de STT & TTS (Local + Nuvem), Decodificação Multi-Formato, Cofre/Persistência no Host e RPCs de Voz

**Files:**
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `packages/shared/src/__tests__/host-protocol.test.ts`
- Modify: `packages/voice/src/providers.ts`
- Modify: `packages/voice/src/index.ts`
- Modify: `apps/desktop/src/host/kernel.ts`
- Modify: `apps/desktop/src/host/vite-host-plugin.ts`
- Modify: `apps/desktop/src/services/ashy-host-client.ts`
- Create: `packages/voice/test/voice-phase8-6.test.ts`

- [ ] **Step 1: Write failing tests in `packages/shared/src/__tests__/host-protocol.test.ts` and `packages/voice/test/voice-phase8-6.test.ts`**
  - Update `packages/shared/src/__tests__/host-protocol.test.ts` for expanded `STT_PROVIDER_IDS` (`['openai-whisper', 'groq-whisper', 'local-whisper-http', 'web-speech-stt', 'deterministic-wav-stt']`), `TTS_PROVIDER_IDS` (`['elevenlabs', 'openai-tts', 'local-kokoro-http', 'web-speech-tts', 'local-synth-fallback']`), and new RPC schemas (`SaveVoiceRuntimeSettingsInputSchema`, `ListVoiceProviderModelsInputSchema`, `TranscribeVoiceAudioInputSchema`, `SynthesizeVoiceSpeechInputSchema`).
  - Create `packages/voice/test/voice-phase8-6.test.ts` testing:
    - `createGroqWhisperSttProvider` (`https://api.groq.com/openai/v1/audio/transcriptions`, `whisper-large-v3-turbo`).
    - `createLocalWhisperHttpSttProvider` automatic fallback from `/audio/transcriptions` (404) to `/inference` (`whisper.cpp`).
    - Default `allowOfflineFallback: false` on `createOpenAiWhisperSttProvider`, `createGroqWhisperSttProvider`, `createLocalWhisperHttpSttProvider`, `createElevenLabsTtsProvider`, `createOpenAiTtsProvider`, and `createLocalKokoroHttpTtsProvider` (must throw explicit error on HTTP failure unless `allowOfflineFallback: true` is passed).
    - `createWebSpeechSttProvider` and `createWebSpeechTtsProvider` with injected mock Web Speech APIs and explicit error when unavailable.
    - `decodeHttpTtsResponse` with `audio/mpeg` (MP3 bytes) and `extractPcmFrameVowelWeights` producing distinct formant vowel weights (`A, E, I, O, U`).

- [ ] **Step 2: Run Vitest to confirm RED state**
  - Run: `pnpm --filter @ashy/shared test && pnpm --filter @ashy/voice test`

- [ ] **Step 3: Implement protocol contracts, STT/TTS providers, and Host voice persistence & RPCs**
  - Update `packages/shared/src/host-protocol.ts`:
    - Expand `STT_PROVIDER_IDS` and `TTS_PROVIDER_IDS`.
    - Add optional fields on `VoiceRuntimeSettingsSchema` (`groqSttModelId`, `openaiSttModelId`, `openaiTtsModelId`, `openaiTtsVoiceId`, `elevenLabsModelId`, `localKokoroModelId`, `localKokoroVoiceId`, `webSpeechLang`, `webSpeechVoiceURI`, `selectedMicDeviceId`, `autoSpeakReplies`, `hasOpenAiApiKey`, `hasGroqApiKey`, `hasElevenLabsApiKey`, `hasLocalSttApiKey`, `hasLocalTtsApiKey`, `maskedOpenAiApiKey`, `maskedGroqApiKey`, `maskedElevenLabsApiKey`) while keeping `DEFAULT_VOICE_RUNTIME_SETTINGS` backward-compatible.
    - Add `voiceSettings?: VoiceRuntimeSettings` to `AshyBootstrapSnapshotSchema`.
    - Add `getVoiceRuntimeSettings`, `saveVoiceRuntimeSettings`, `listVoiceProviderModels`, `transcribeVoiceAudio`, and `synthesizeVoiceSpeech` to `ASHY_HOST_RPC_METHODS` and `AshyHostBridge`.
  - Update `packages/voice/src/providers.ts` & `packages/voice/src/index.ts`:
    - Add `createGroqWhisperSttProvider`, `createWebSpeechSttProvider`, `createWebSpeechTtsProvider`, `extractPcmFrameVowelWeights`, MP3/multi-format decoding in `decodeHttpTtsResponse`, `/inference` fallback in `createLocalWhisperHttpSttProvider`, `response_format: 'wav'` in `createOpenAiTtsProvider` & `createLocalKokoroHttpTtsProvider`, and `allowOfflineFallback = false` by default.
    - Register all `STT_PROVIDER_IDS` and `TTS_PROVIDER_IDS` in `createSttProviderRegistry()` and `createTtsProviderRegistry()`.
  - Update `apps/desktop/src/host/kernel.ts`, `vite-host-plugin.ts`, and `ashy-host-client.ts`:
    - Persist `voice-settings.json` with encrypted API keys via `SecretProtector`, enforce origin pinning & SSRF guards (`redirect: 'error'`, block metadata/link-local IPs, never leak cloud keys to custom origins), raise `MAX_RPC_BODY_BYTES` to `10 * 1024 * 1024`, and wire the 5 RPC methods in `dispatchHostRpc`, `createPreloadHostBridge`, and `createHttpSseHostBridge`.

- [ ] **Step 4: Run Vitest on `@ashy/shared` and `@ashy/voice` to confirm GREEN state**
  - Run: `pnpm --filter @ashy/shared test && pnpm --filter @ashy/voice test`

---

### Task 2: Captura Real de Microfone (`getUserMedia` + `AudioContext` + `AudioWorkletNode`), Silero VAD ONNX, `TurnIntelligence` com LLM Real e Limpeza do `voice-session-runtime.ts`

**Files:**
- Modify: `packages/voice/src/vad-engine.ts`
- Modify: `packages/voice/src/turn-policy.ts`
- Modify: `packages/voice/src/turn-intelligence.ts`
- Modify: `packages/voice/src/voice-session-runtime.ts`
- Modify: `packages/voice/src/index.ts`
- Modify: `packages/voice/test/voice-phase8-6.test.ts`

- [ ] **Step 1: Write failing tests in `packages/voice/test/voice-phase8-6.test.ts` for Task 2**
  - Test `createWebAudioWorkletCapture` `startMicrophoneCapture()` / `stopMicrophoneCapture()` with mocked `mediaDevices.getUserMedia` and `AudioContext` at `48000Hz`:
    - Verifies downsampling from `48000Hz` to `16000Hz` `320`-sample (20ms) `PcmAudioBlock`s.
    - Verifies `captureGenerationId` concurrency guard: rapid `startMicrophoneCapture()` followed immediately by `stopMicrophoneCapture()` before `getUserMedia` resolves immediately stops tracks and closes the `AudioContext` without leaking.
    - Verifies `runtime.setMicMode('muted')` stops active microphone capture tracks.
  - Test `createSileroOnnxVadEngine` in `vad-engine.ts` with stateful ONNX session inference (preserving state tensor across 20ms/32ms chunks and reporting `engineMode: 'silero-onnx'`) and automatic fallback to `engineMode: 'hybrid-dsp'` when ONNX session is unavailable.
  - Test `createOpenAiCompatibleVoiceEndJudgeFn` and `createOpenAiCompatibleSpeculativeRephraseFn` in `turn-intelligence.ts` (calling `/chat/completions` with `reasoning_effort: 'none'`, temperature `0`, and respecting AbortSignal/timeouts).
  - Test `GaplessAudioPlayer` `onQueueDrained` vs `onPlaybackEnded` (`markStreamComplete()`) so `isPlaying()` / `onPlaybackEnded` accurately reflects multi-chunk streaming turns.
  - Test that `voice-session-runtime.ts` no longer uses `turnController.advanceSilence(1200)` inside `ingestPcmBlock` while still passing Scenario A (`casRejectedCount >= 1`).

- [ ] **Step 2: Run Vitest to confirm RED state**
  - Run: `pnpm --filter @ashy/voice test`

- [ ] **Step 3: Implement `createSileroOnnxVadEngine`, LLM Turn-Intelligence factories, real microphone capture with `captureGenerationId`, `onPlaybackEnded` in `GaplessAudioPlayer`, and CAS cleanup**
  - Update `packages/voice/src/vad-engine.ts` with `createSileroOnnxVadEngine` and `downsamplePcmFloat32`.
  - Update `packages/voice/src/turn-intelligence.ts` with `createOpenAiCompatibleVoiceEndJudgeFn`, `createOpenAiCompatibleSpeculativeRephraseFn`, and `isWhisperSilenceHallucination(text)`.
  - Update `packages/voice/src/turn-policy.ts` so `bumpSpeakerRevision()` increments `casRejectedCount` when `inGracePeriod` is `true`.
  - Update `packages/voice/src/voice-session-runtime.ts` to remove `const inFlightJudge = turnController.advanceSilence(1200)` in `ingestPcmBlock`, add `startMicrophoneCapture` / `stopMicrophoneCapture` with `captureGenerationId` to `createWebAudioWorkletCapture` and `VoiceSessionRuntime`, and add real-time playback completion timer / `onPlaybackEnded` to `createGaplessAudioPlayer`.

- [ ] **Step 4: Run Vitest on `@ashy/voice` to confirm GREEN state**
  - Run: `pnpm --filter @ashy/voice test`

---

### Task 3: Store Unificado de Voz (`useAshyStore.ts`), Lip-Sync Acústico em Tempo Real no Live2D, Barge-In Real e UI Completa de Configuração de Voz (`App.tsx`)

**Files:**
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/test/desktop.test.tsx`
- Modify: `apps/desktop/src/__tests__/phase5-realtime-voice-ui.test.tsx`
- Modify: `docs/ASHY_ROADMAP.md`

- [ ] **Step 1: Write failing tests in `apps/desktop/src/__tests__/phase5-realtime-voice-ui.test.tsx` and `apps/desktop/test/desktop.test.tsx`**
  - Test Host Kernel voice RPCs (`saveVoiceRuntimeSettings` with API key encryption, SSRF rejection on `http://169.254.169.254` and cloud origin pinning so `openai` key is never sent to `http://127.0.0.1:9999`, `listVoiceProviderModels`, `transcribeVoiceAudio`, `synthesizeVoiceSpeech`).
  - Test `useAshyStore` real voice conversation flow:
    - Sealing a voice turn when `isVoiceListening` is active automatically calls `sendUserMessage` (and filters out `[BLANK_AUDIO]`).
    - Playback completion after turn streaming finishes resets `isSpeaking: false`, `activeViseme: 'closed'`, and `simulatedVowels: { A: 0, E: 0, I: 0, O: 0, U: 0 }`.
    - Settings > Voz (`voice-runtime-panel`) renders all new controls (`input-stt-base-url`, `input-stt-api-key`, `select-stt-model`, `btn-refresh-stt-models`, `input-tts-base-url`, `input-tts-api-key`, `select-tts-model`, `select-tts-voice`, `btn-refresh-tts-models`, `select-mic-device`, `toggle-auto-speak-replies`, `btn-test-mic`, `btn-test-tts-voice`, `btn-save-voice-settings`) while preserving all 11 existing Phase 5 `data-testid`s.

- [ ] **Step 2: Run Vitest on `@ashy/desktop` to confirm RED state**
  - Run: `pnpm --filter @ashy/desktop test`

- [ ] **Step 3: Implement unified voice store in `useAshyStore.ts`, complete Voice Settings & Studio Controls in `App.tsx`, and update `docs/ASHY_ROADMAP.md`**
  - Update `apps/desktop/src/store/useAshyStore.ts`:
    - Connect `voiceRuntime` `onTurnSealed` -> `sendUserMessage` (filtering `isWhisperSilenceHallucination` and coordinating with `isStreamingTurn`/`isSpeaking` via barge-in if needed).
    - Implement `toggleVoiceConversation`, `startVoiceListening`, `stopVoiceListening`, `refreshMicDevices`, `setSelectedMicDeviceId`, `setAutoSpeakReplies`, `saveVoiceSettings`, `refreshVoiceProviderCatalog`, `testMicrophone`, and `testTtsVoice`.
    - In `createPipelineForTurn`: keep `local-synth-fallback` local/synchronous-friendly (without calling `fetchImpl`), while for real providers (`openai-tts`, `elevenlabs`, `local-kokoro-http`, `web-speech-tts`) invoke Host `synthesizeVoiceSpeech` or `web-speech-tts`, play audio in `GaplessAudioPlayer`, drive `simulatedVowels` / `activeViseme` / `rawVolume` in real time, and reset `isSpeaking: false`, `presenceStatus: 'Idle'`, `activeViseme: 'closed'`, and `simulatedVowels` once the turn stream AND audio playback complete.
    - Clean up `triggerBargeIn` so it interrupts actual active speech without injecting fake FSRS-6 text when idle.
  - Update `apps/desktop/src/App.tsx`:
    - Wire `"Conversar por voz"` (`btn-toggle-lipsync`) and `"Voz local"` pill to real voice listening (`toggleVoiceConversation`) with live `WAVEFORM_BARS` driven by `micInputLevel` / `rawVolume`.
    - Upgrade `voice-runtime-panel` in Settings > Voz with full Local & Cloud STT/TTS configuration, API key inputs, model/voice selectors, physical microphone selector, `"Falar respostas automaticamente"` toggle, `"Testar Microfone"`, and `"Testar Voz"`, keeping the diagnostic `.wav` fixture buttons in a secondary diagnostic footer so all existing Phase 5 UI tests pass.
  - Update `docs/ASHY_ROADMAP.md` to mark **Fase 8.6** as `✅ Concluída`.

- [ ] **Step 4: Run full test suite, typecheck, and build**
  - Run: `pnpm test && pnpm typecheck && pnpm build`
