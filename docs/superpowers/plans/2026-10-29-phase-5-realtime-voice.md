# Ashy Phase 5 — Realtime Voice, Turn-Taking & Barge-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Phase 5 (`docs/ASHY_ROADMAP.md` — *Fase 5: Voz em tempo real*):
1. **Shared Voice Contracts & Interruption Protocol (`@ashy/shared`):** Add `SttProviderId`, `TtsProviderId`, `TtfaTelemetryRecord`, `VoiceRuntimeSettings`, and `interruptionControlNote` on `SendTurnInputSchema`.
2. **WAV Codec, Pluggable VAD Engine & Real `.wav` Audio Fixtures (`@ashy/voice` + `assets/audio-fixtures/*.wav`):** Pure TypeScript 16-bit RIFF/WAVE encoder/decoder (`encodeWavPcm16`, `decodeWavToPcmBlocks`, `buildVoiceFixtureWavBytes`), deterministic Spectral + RMS Energy + Zero-Crossing Rate (ZCR) hybrid `VadEngine` (with optional Silero ONNX model callback), and 4 real `.wav` fixtures in `assets/audio-fixtures/` (`thinking-pause-cas.wav` [4.2s], `barge-in-interrupt.wav` [2.2s with 400ms pre-onset], `wake-word-oi-ashy.wav` [2.2s], `keyboard-click-noise.wav` [0.5s]).
3. **Incremental Streaming SpeechPipeline + Dual Local & Cloud STT/TTS Provider Registry (`@ashy/voice`):** Extend `RealtimeSpeechPipeline` with `enqueueDelta(textDelta)`, `flush()`, and mid-sentence chunker buffer draining inside `interrupt()` so incremental token deltas coalesce through `TtsChunker`'s TTFA boost window without losing unheard tail words on barge-in. Implement `SttProvider` (`openai-whisper`, `local-whisper-http`, `deterministic-wav-stt`) and `TtsProvider` (`elevenlabs`, `openai-tts`, `local-kokoro-http`, `local-synth-fallback`) registries with `AbortSignal` timeouts, offline fallback, and vowel formant (`A, E, I, O, U`) lip-sync envelopes.
4. **Hybrid Turn-Taking (`VoiceEndJudge` + `SpeculativeRephrase`), WebAudio Worklet/Gapless Player & `VoiceSessionRuntime` (`@ashy/voice`):** Fast `< 1ms` PT-BR/EN hesitation/punctuation heuristic + `400ms`-timeout fast LLM judge with `CAS` protection (`{ rawRev, speakerRev, contextRev }`), `600ms` speculative disfluency rephrase, `createWebAudioWorkletCapture` (`getUserMedia` + `AudioWorklet` feeding both AEC and raw ring buffers), `createGaplessAudioPlayer` (`AudioContext` + `GainNode` `100ms` fade-out), 3 mic modes (`muted`, `continuous`, `ptt` / `push-to-talk`), wake word (`"Ashy"` / `"Ei Ashy"`), and per-provider **TTFA** telemetry.
5. **Barge-In `PlaybackReceipt` Prompt Injection (`@ashy/cortex` & `TurnOrchestrator`):** Wire `interruptionControlNote` (`[Interrupted after Xms — user heard: "..." | unheard: "..."]`) from `SendTurnInput` $\rightarrow$ `TurnOrchestrator` $\rightarrow$ `AshyCortex.compileTurnPrompt` $\rightarrow$ `SoulComposer` (`[VOICE BARGE-IN RECEIPT]` in `volatileTurnContext` and `userTurnContent`).
6. **Desktop Incremental Streaming TTS, Barge-In Abort, Hub UI & Wire-Back Audit (`apps/desktop` & `scripts/verify-phase5-wireback.mjs`):** Stream `turn:delta` (`enqueueDelta`) and `turn:marker` incrementally into `RealtimeSpeechPipeline` during generation (measuring real TTFA), abort in-flight LLM turns on barge-in (preserving `Listening`/`surprised` across `turn:aborted`), preserve `lastTurnInterruptionNote` across `applyBootstrapSnapshot` on the post-barge-in turn, expose Voice Runtime & `.wav` Fixture controls in the Hub UI, and enforce all invariants in `scripts/verify-phase5-wireback.mjs`.

**Architecture:** TDD-first (`RED -> GREEN -> REFACTOR`) across 6 self-contained tasks in `@ashy/shared`, `@ashy/voice`, `@ashy/cortex`, `apps/desktop`, and `scripts/`. Incorporates all 8 refinements (`B1`–`B5`, `M1`–`M3`) from the Zero-Context Red-Team Review.

**Tech Stack:** TypeScript, Vitest, Valibot, WebAudio API (`AudioContext`, `AudioWorklet`), React / Zustand.

---

## Organ Wire-Back Matrix (Every New Capability Has Producer + Reader + Test)

| Organ / Capability | Producer (Writer) | Consumer (Live Reader) | Verification Test |
| :--- | :--- | :--- | :--- |
| **1. Shared Voice Contracts & `interruptionControlNote`** | `packages/shared/src/host-protocol.ts` (`STT_PROVIDER_IDS`, `TTS_PROVIDER_IDS`, `SendTurnInputSchema.interruptionControlNote`) | `apps/desktop/src/host/turn-orchestrator.ts` & `apps/desktop/src/store/useAshyStore.ts` | `packages/shared/src/__tests__/host-protocol.test.ts` |
| **2. WAV Codec, Hybrid `VadEngine` & `.wav` Fixtures** | `packages/voice/src/wav-codec.ts`, `packages/voice/src/vad-engine.ts`, `assets/audio-fixtures/*.wav` | `packages/voice/src/voice-session-runtime.ts` & `packages/voice/src/providers.ts` | `packages/voice/test/voice-phase5.test.ts` |
| **3. Incremental `SpeechPipeline` (`enqueueDelta`/`flush`) & Dual STT/TTS Providers** | `packages/voice/src/speech-pipeline.ts` & `packages/voice/src/providers.ts` (`createSttProviderRegistry`, `createTtsProviderRegistry`) | `packages/voice/src/voice-session-runtime.ts` & `apps/desktop/src/store/useAshyStore.ts` | `packages/voice/test/voice-phase5.test.ts` |
| **4. Hybrid `VoiceEndJudge`, `SpeculativeRephrase`, WebAudio I/O & `VoiceSessionRuntime`** | `packages/voice/src/turn-intelligence.ts` & `packages/voice/src/voice-session-runtime.ts` | `apps/desktop/src/store/useAshyStore.ts` (`runAudioFixtureSimulation`, `setMicMode`, `triggerBargeIn`) | `packages/voice/test/voice-phase5.test.ts` |
| **5. `[VOICE BARGE-IN RECEIPT]` Prompt Injection** | `packages/cortex/src/prompt/soul-composer.ts` & `packages/cortex/src/ashy-cortex.ts` (`compileTurnPrompt`) | `apps/desktop/src/host/turn-orchestrator.ts` (`runTurnPipeline`) | `packages/cortex/test/cortex.test.ts` & `apps/desktop/src/__tests__/host-kernel.test.ts` |
| **6. Incremental Streaming TTS, TTFA Telemetry & Hub Voice UI** | `apps/desktop/src/store/useAshyStore.ts` (`handleHostStreamEvent`, `triggerBargeIn`, `runAudioFixtureSimulation`) | `apps/desktop/src/App.tsx` (Voice Settings & Studio Controls) | `apps/desktop/src/__tests__/phase5-realtime-voice-ui.test.tsx` & `scripts/verify-phase5-wireback.mjs` |

---

## Task 1: Shared Voice Contracts & `interruptionControlNote` (`@ashy/shared`)

**Files:**
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `packages/shared/src/__tests__/host-protocol.test.ts`

- [x] **Step 1 (RED): Write failing contract tests in `packages/shared/src/__tests__/host-protocol.test.ts`**
  Test:
  1. `STT_PROVIDER_IDS` (`openai-whisper`, `local-whisper-http`, `deterministic-wav-stt`) and `TTS_PROVIDER_IDS` (`elevenlabs`, `openai-tts`, `local-kokoro-http`, `local-synth-fallback`) schemas and `DEFAULT_VOICE_RUNTIME_SETTINGS`.
  2. `SendTurnInputSchema` accepting optional `interruptionControlNote` (trimmed string up to `1024` chars) and rejecting `interruptionControlNote` longer than `1024` chars.

- [x] **Step 2 (GREEN): Update `packages/shared/src/host-protocol.ts`**
  1. Export `STT_PROVIDER_IDS`, `SttProviderId`, `SttProviderIdSchema`, `TTS_PROVIDER_IDS`, `TtsProviderId`, `TtsProviderIdSchema`, ` VOICE_FIXTURE_IDS = ['thinking-pause-cas', 'barge-in-interrupt', 'wake-word-oi-ashy', 'keyboard-click-noise'] as const`, `VoiceFixtureId`, `TtfaTelemetryRecord`, `VoiceRuntimeSettings`, and `DEFAULT_VOICE_RUNTIME_SETTINGS`.
  2. Extend `SendTurnInputSchema`:
     ```ts
     export const SendTurnInputSchema = v.object({
       sessionId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
       text: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(16000)),
       screenContext: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(512))),
       interruptionControlNote: v.optional(
         v.pipe(v.string(), v.trim(), v.maxLength(1024)),
       ),
     })
     ```

- [x] **Step 3 (VERIFY):** Run `pnpm --filter @ashy/shared test && pnpm --filter @ashy/shared typecheck`.

---

## Task 2: WAV Codec, Hybrid `VadEngine` & Real `.wav` Fixtures (`@ashy/voice` + `assets/audio-fixtures/`)

**Files:**
- Create: `packages/voice/src/wav-codec.ts`
- Create: `packages/voice/src/vad-engine.ts`
- Create: `scripts/generate-audio-fixtures.mjs`
- Create: `assets/audio-fixtures/thinking-pause-cas.wav`
- Create: `assets/audio-fixtures/barge-in-interrupt.wav`
- Create: `assets/audio-fixtures/wake-word-oi-ashy.wav`
- Create: `assets/audio-fixtures/keyboard-click-noise.wav`
- Modify: `packages/voice/src/index.ts`
- Create: `packages/voice/test/voice-phase5.test.ts`

- [x] **Step 1 (RED): Write failing tests in `packages/voice/test/voice-phase5.test.ts` for WAV codec, `VadEngine`, and `.wav` fixtures**
  Test:
  1. `encodeWavPcm16`, `decodeWavToPcmBlocks`, and `buildVoiceFixtureWavBytes(fixtureId)` round-trip accuracy (`16000Hz`, contiguous `20ms` `PcmAudioBlock` frames, embedded `LIST/INFO ICMT` transcript metadata) and adversarial rejection of truncated/corrupt RIFF headers or zero sample rates.
  2. `createHybridVadEngine`:
     - Voiced harmonic speech (`180Hz` fundamental + formants) yields `probability >= 0.65` (`isSpeechCandidate === true`).
     - Low-amplitude sustain speech yields `probability` in `[0.20, 0.55]`.
     - Silence or pure DC offset yields `probability < 0.05`.
     - Custom `modelInferFn` (e.g., Silero ONNX hook) overrides or blends when provided, and falls back to spectral/energy VAD if `modelInferFn` throws.
  3. Loading the 4 real `.wav` files from `assets/audio-fixtures/*.wav` on disk via `node:fs` and verifying that their byte contents match `buildVoiceFixtureWavBytes(fixtureId)` and have exact acoustic profiles:
     - `thinking-pause-cas.wav` (`4.2s`): `0..800ms` speech, `800..2100ms` thinking pause (`1300ms`), `2100..2900ms` speech continuation, `2900..4200ms` trailing silence (`1300ms`).
     - `barge-in-interrupt.wav` (`2.2s`): `0..400ms` leading silence (`anchorFrame = 640 > 0` for `360ms` pre-roll), `400..900ms` voiced barge-in speech, `900..2200ms` trailing silence.
     - `wake-word-oi-ashy.wav` (`2.2s`): `0..200ms` silence, `200..900ms` wake-word speech, `900..2200ms` trailing silence.
     - `keyboard-click-noise.wav` (`0.5s`): `120ms` transient burst (`< 300ms` `minSpeechMs`).

- [x] **Step 2 (GREEN): Implement `packages/voice/src/wav-codec.ts`, `packages/voice/src/vad-engine.ts`, and `scripts/generate-audio-fixtures.mjs`**
  1. Implement `encodeWavPcm16`, `decodeWavToPcmBlocks`, `synthesizeVoicedSpeechPcm`, and `buildVoiceFixtureWavBytes` in `packages/voice/src/wav-codec.ts` (zero `node:fs` imports so `wav-codec.ts` is 100% browser-safe).
  2. Implement `createHybridVadEngine` in `packages/voice/src/vad-engine.ts`.
  3. Generate the 4 `.wav` fixtures in `assets/audio-fixtures/*.wav` via `node scripts/generate-audio-fixtures.mjs`.

- [x] **Step 3 (VERIFY):** Run `pnpm --filter @ashy/voice test && pnpm --filter @ashy/voice typecheck`.

---

## Task 3: Incremental `SpeechPipeline` (`enqueueDelta`/`flush`) & Dual Local/Cloud STT & TTS Providers (`@ashy/voice`)

**Files:**
- Modify: `packages/voice/src/speech-pipeline.ts`
- Create: `packages/voice/src/providers.ts`
- Modify: `packages/voice/src/index.ts`
- Modify: `packages/voice/test/voice-phase5.test.ts`

- [x] **Step 1 (RED): Add failing tests in `packages/voice/test/voice-phase5.test.ts` for incremental `enqueueDelta`/`flush` and STT & TTS providers**
  Test:
  1. `RealtimeSpeechPipeline.enqueueDelta` & `flush` (**Red-Team B1 fix**):
     - Streaming 1–2 word deltas via `pipeline.enqueueDelta(delta)` coalesces tokens through `TtsChunker`'s 4–12 word TTFA boost window instead of flushing every token as a tiny chunk.
     - Calling `pipeline.interrupt('user-barge-in', playbackSec)` mid-sentence (before `flush()` is called) drains any unscheduled words still buffered inside `TtsChunker` into `receipt.unheardText` so zero streamed words are lost.
     - Enqueuing a stage signal via `pipeline.enqueue(CONTROL_SENTINEL, [signal], { flush: false })` flushes preceding buffered text in `chunker` first so `afterChunkSeq` attaches to the exact preceding spoken clause.
  2. `createOpenAiWhisperSttProvider`, `createLocalWhisperHttpSttProvider`, and `createDeterministicWavSttProvider`:
     - Encodes `PcmAudioBlock[]` to `.wav`, sends `POST` request with `AbortSignal`, parses JSON `{ text }`, and measures `latencyMs`.
     - Falls back cleanly to `deterministic-wav-stt` when `allowOfflineFallback: true` and network fails or times out.
  3. `createElevenLabsTtsProvider`, `createOpenAiTtsProvider`, `createLocalKokoroHttpTtsProvider`, and `createLocalSynthFallbackTtsProvider` (**Red-Team B3 fix**):
     - Uses unified `TtsProviderSynthesisResult extends TtsSynthesisOutput` (no duplicate `TtsSynthesisOutput` export in `packages/voice/src/index.ts`).
     - `local-synth-fallback` generates harmonic PCM samples and non-zero vowel lip-sync envelopes (`A, E, I, O, U`) proportional to the Portuguese syllables of the text.
     - Cloud/local HTTP TTS providers automatically fall back to `local-synth-fallback` when `allowOfflineFallback: true` and HTTP fails or aborts.

- [x] **Step 2 (GREEN): Update `packages/voice/src/speech-pipeline.ts`, implement `packages/voice/src/providers.ts`, and export from `packages/voice/src/index.ts`**

- [x] **Step 3 (VERIFY):** Run `pnpm --filter @ashy/voice test && pnpm --filter @ashy/voice typecheck`.

---

## Task 4: Hybrid Turn-Taking (`VoiceEndJudge` + `SpeculativeRephrase`), WebAudio I/O & `VoiceSessionRuntime` (`@ashy/voice`)

**Files:**
- Create: `packages/voice/src/turn-intelligence.ts`
- Create: `packages/voice/src/voice-session-runtime.ts`
- Modify: `packages/voice/src/index.ts`
- Modify: `packages/voice/test/voice-phase5.test.ts`

- [x] **Step 1 (RED): Add failing tests in `packages/voice/test/voice-phase5.test.ts` for `turn-intelligence.ts` and `voice-session-runtime.ts`**
  Test:
  1. `createHybridVoiceEndJudge` & `createHybridSpeculativeRephrase`:
     - Trailing PT-BR/EN hesitations (`"Deixa eu pensar num jeito de..."`, `"Eu queria falar sobre, tipo..."`, `"Mas então..."`) return `{ complete: false, reason: 'trailing-hesitation' }` in `< 1ms` without needing LLM.
     - Complete terminal sentences (`"Como está o banco de dados?"`, `"Pode rodar a suíte de testes agora."`) return `{ complete: true, reason: 'terminal-punctuation' }`.
     - Ambiguous clauses without punctuation invoke `llmJudgeFn` with a `400ms` timeout and fall back safely to heuristic if `llmJudgeFn` times out or throws.
     - `createHybridSpeculativeRephrase` strips spoken filler stutters (`"hum, é... é... eu acho que funciona"` $\rightarrow$ `"eu acho que funciona"`) and respects `AbortSignal`.
  2. `createWebAudioWorkletCapture` & `createGaplessAudioPlayer` (**Red-Team M3 fix**):
     - `createWebAudioWorkletCapture` connects AEC and raw PCM streams into `AudioInputRingBuffer` and `WakeWordSpotterState`.
     - `createGaplessAudioPlayer` schedules `Float32Array` buffers on `AudioContext` (or virtual clock fallback), tracks `currentTime`, emits vowel lip-sync frames, and executes `100ms` gain fade-out on barge-in.
  3. `createVoiceSessionRuntime` end-to-end with the 4 real `.wav` fixtures (**Red-Team B4 & M1 fixes**):
     - **Scenario A (`thinking-pause-cas.wav`):** Streams `thinking-pause-cas.wav` (`4.2s`) through `VoiceSessionRuntime` in `continuous` mode. Verifies that at the `1300ms` mid-sentence pause (`"Deixa eu pensar num jeito de..."`), `VoiceEndJudge` returns `{ complete: false }`, the turn enters the `+3000ms` grace period (`inGracePeriod === true`) and exercises CAS protection (`casRejectedCount >= 1` when late judge resolves after speech resumes), and when the user finishes speaking (`"...resolver esse bug no código."`) followed by `1300ms` silence, the turn seals cleanly with the combined utterance!
     - **Scenario B (`barge-in-interrupt.wav`):** While Ashy is speaking (`enqueueAssistantReply`), streaming `barge-in-interrupt.wav` (`400ms` pre-onset silence + `500ms` speech) triggers automatic VAD barge-in after `>= 300ms` of voiced speech, fades out audio in `100ms`, retains the `360ms` pre-roll `HistoryLease` with `anchorFrame === 640 > 0` without clipping frames, and emits the exact `PlaybackReceipt` (`[Interrupted after Xms — user heard: "..." | unheard: "..."]`).
     - **Scenario C (`keyboard-click-noise.wav`):** Streaming `keyboard-click-noise.wav` (`120ms < 300ms`) is rejected as `'too-short'` and does **not** trigger false barge-in while Ashy is speaking.
     - **Scenario D (`wake-word-oi-ashy.wav`) & Mic Modes (`muted`, `ptt` / `push-to-talk`, `continuous`):** Verifies `muted` ignores audio, both `'ptt'` and `'push-to-talk'` seal immediately on release, and `wakeWordEnabled` opens on `"Ei Ashy"`.
     - **Scenario E (TTFA Telemetry):** Verifies `getTtfaTelemetry()` records `lastTtfaMs` and `avgTtfaMs` per `TtsProviderId`.

- [x] **Step 2 (GREEN): Implement `packages/voice/src/turn-intelligence.ts` and `packages/voice/src/voice-session-runtime.ts`**

- [x] **Step 3 (VERIFY):** Run `pnpm --filter @ashy/voice test && pnpm --filter @ashy/voice typecheck`.

---

## Task 5: `[VOICE BARGE-IN RECEIPT]` Prompt Injection in `@ashy/cortex` & `TurnOrchestrator`

**Files:**
- Modify: `packages/cortex/src/prompt/soul-composer.ts`
- Modify: `packages/cortex/src/ashy-cortex.ts`
- Modify: `packages/cortex/test/cortex.test.ts`
- Modify: `apps/desktop/src/host/turn-orchestrator.ts`
- Modify: `apps/desktop/src/__tests__/host-kernel.test.ts`

- [x] **Step 1 (RED): Write failing tests in `packages/cortex/test/cortex.test.ts` and `apps/desktop/src/__tests__/host-kernel.test.ts`**
  Test:
  1. `composeAshyTurnPrompt` and `cortex.compileTurnPrompt` with `interruptionControlNote: '[Interrupted after 1500ms — user heard: "Eu acho que esse," | unheard: "código precisa de refatoração."]'`:
     - Injects `[VOICE BARGE-IN RECEIPT]` into `volatileTurnContext` and `userTurnContent` while keeping `staticSystemPrompt` 100% unchanged (preserving KV-cache).
     - Sanitizes any malicious newlines/null-bytes/`<|...|>` markers inside `interruptionControlNote`.
  2. `TurnOrchestrator.sendTurn({ sessionId, text, interruptionControlNote })` in `apps/desktop/src/__tests__/host-kernel.test.ts`:
     - Forwards `interruptionControlNote` to `cortex.compileTurnPrompt` so the LLM receives the `[VOICE BARGE-IN RECEIPT]` on the turn following a barge-in.

- [x] **Step 2 (GREEN): Implement `interruptionControlNote` support in `soul-composer.ts`, `ashy-cortex.ts`, and `turn-orchestrator.ts`**

- [x] **Step 3 (VERIFY):** Run `pnpm --filter @ashy/cortex test && pnpm --filter @ashy/desktop test`.

---

## Task 6: Desktop Incremental Streaming TTS, Barge-In Abort, Hub Voice UI & Wire-Back Audit (`apps/desktop` & `scripts/`)

**Files:**
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/__tests__/phase5-realtime-voice-ui.test.tsx`
- Create: `scripts/verify-phase5-wireback.mjs`
- Modify: `package.json`

- [x] **Step 1 (RED): Write failing UI & store integration tests in `apps/desktop/src/__tests__/phase5-realtime-voice-ui.test.tsx`**
  Test:
  1. **Incremental `turn:delta` TTS Streaming & TTFA Telemetry (`B1`):**
     - During a streaming turn (`turn:started` $\rightarrow$ `turn:delta` $\rightarrow$ `turn:marker` $\rightarrow$ `turn:completed`), `useAshyStore` feeds chunks incrementally via `pipeline.enqueueDelta(event.textDelta)` as `turn:delta` arrives, flushes tail on `turn:completed` without duplicating chunks, and updates `voiceRuntime.ttfaByProvider` (`lastTtfaMs !== null`).
  2. **Real Barge-In $\rightarrow$ Abort Active Turn $\rightarrow$ Next Turn Prompt Injection (`B2` & `M2`):**
     - Calling `triggerBargeIn(600)` while a turn is streaming/speaking aborts the active host turn (`bargeInTurnIds` preserves `presenceStatus: 'Listening'` and `stageEmotion: 'surprised'` when `turn:aborted` fires), records `lastPlaybackReceipt` and `pendingInterruptionControlNote`, and on the subsequent `sendUserMessage("Espera, foca só no banco")`, passes `interruptionControlNote` to `bridge.sendTurn(...)` and preserves `[VOICE BARGE-IN RECEIPT]` in `lastPrompt.volatileTurnContext` even after `turn:completed` runs `applyBootstrapSnapshot`, clearing `pendingInterruptionControlNote` afterwards.
  3. **Mic Modes (`muted`, `continuous`, `ptt` / `push-to-talk`), Wake Word & Deterministic Fixture Runner in Hub UI (`App.tsx` — `B4` & `B5`):**
     - Switching STT/TTS providers (`setActiveSttProvider`, `setActiveTtsProvider`), toggling Wake Word (`setWakeWordEnabled`), switching Mic Modes (`setMicMode` normalizing `'push-to-talk' -> 'ptt'` for `PrivacyController`), and clicking the `.wav` Fixture simulation buttons (`thinking-pause-cas`, `barge-in-interrupt`, `keyboard-click-noise`) in `App.tsx` runs `runAudioFixtureSimulation` (using browser-safe `buildVoiceFixtureWavBytes`) and updates the live telemetry badges (`data-testid="voice-ttfa-badge"`, `data-testid="voice-cas-badge"`, `data-testid="voice-bargein-receipt"`).

- [x] **Step 2 (GREEN): Update `useAshyStore.ts`, `App.tsx`, and create `scripts/verify-phase5-wireback.mjs`**
  1. Wire `VoiceSessionRuntime`, incremental `turn:delta` (`enqueueDelta`) TTS streaming, `pendingInterruptionControlNote` + `lastTurnInterruptionNote`, provider switching, TTFA telemetry, and `runAudioFixtureSimulation` (with alias `runVoiceFixtureScenario`) in `apps/desktop/src/store/useAshyStore.ts`.
  2. Add the **Voice Runtime, TTFA Telemetry & Audio Fixtures** controls and badges in `apps/desktop/src/App.tsx`.
  3. Create `scripts/verify-phase5-wireback.mjs` and append `node scripts/verify-phase5-wireback.mjs` to `verify:wireback` in root `package.json`.

- [x] **Step 3 (VERIFY):** Run `pnpm verify:wireback`, `pnpm test`, `pnpm typecheck`, `pnpm build`, and verify visually in Playwright.
