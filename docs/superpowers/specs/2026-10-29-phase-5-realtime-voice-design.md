# Ashy Phase 5 — Realtime Voice, Turn-Taking & Barge-In Design Specification

**Date:** 2026-10-29
**Status:** Approved
**Phase:** Fase 5 (`docs/ASHY_ROADMAP.md` — Voz em tempo real · §7, §11, §14 de `docs/ASHY_PROJECT_CONTEXT.md`)
**Scope:** `@ashy/shared`, `@ashy/voice`, `@ashy/cortex`, `apps/desktop`, `assets/audio-fixtures/`, and `scripts/`

---

## 1. Executive Summary & Goal

Phase 5 transforms `@ashy/voice` from isolated algorithmic primitives into a **fully wired, low-latency realtime voice runtime** integrated across `@ashy/shared`, `@ashy/cortex`, and `apps/desktop`:

1. **Dual Local + Cloud STT & TTS Provider Architecture (Entrega 1):**
   - First-class `SttProvider` (`openai-whisper`, `local-whisper-http`, `deterministic-wav-stt`) and `TtsProvider` (`elevenlabs`, `openai-tts`, `local-kokoro-http`, `local-synth-fallback`) registries with unified health checks, timeout/abort handling, and per-provider **TTFA (Time-To-First-Audio)** telemetry.
   - Incremental TTS streaming directly from `turn:delta` and `turn:marker` events during LLM generation (instead of waiting for `turn:completed`), leveraging `TtsChunker`'s 2-chunk TTFA boost (`4..12` words) and `RealtimeSpeechPipeline`'s `4x` parallel synthesis workers.

2. **WebAudio Capture (`getUserMedia` + `AudioWorklet`), Dual RingBuffer & Pluggable VAD (Entrega 2):**
   - Pure TypeScript 16-bit PCM `.wav` encoder/decoder (`encodeWavPcm16`, `decodeWavToPcmBlocks`) + 16kHz/20ms frame resampler/slicer.
   - Pluggable `VadEngine` supporting Silero ONNX / custom model callback and a built-in deterministic **Spectral + RMS Energy + Zero-Crossing Rate (ZCR) Hybrid VAD** that distinguishes voiced human speech from silence and `< 300ms` mechanical keyboard clicks.
   - `VoiceSessionRuntime` wiring `AudioInputRingBuffer` (both AEC stream for VAD/STT and raw stream for `WakeWordSpotterState`), `SpeechActivityTracker` (`onset: 0.60`, `sustain: 0.18`, `minSpeechMs: 300`), and `360ms` pre-roll `HistoryLease` across barge-in fade-out.

3. **Real Turn-Taking Intelligence (`VoiceEndJudge` + `SpeculativeRephrase`) with CAS Protection (Entrega 3):**
   - Hybrid `VoiceEndJudge`: Tier 1 deterministic PT-BR/EN clause & hesitation analyzer (`< 1ms`) + Tier 2 fast LLM judge (`400ms` timeout fail-safe). When the user pauses in thought (`"Deixa eu pensar num jeito de..."`), returns `{ complete: false }` to grant the `+3000ms` grace period (`4200ms` total) without interrupting.
   - Hybrid `SpeculativeRephrase`: Triggered at `600ms` of silence to strip disfluencies/stutters in background (`rephraseFn`), cached and reused at `1200ms` seal with zero extra latency, and protected by strict Compare-And-Swap (`CAS`) on `{ rawRev, speakerRev, contextRev }`.

4. **Real Audio Clock Barge-In, `100ms` Fade-Out & Prompt `PlaybackReceipt` Injection (Entrega 4):**
   - `GaplessAudioPlayer` schedules synthesized PCM buffers onto WebAudio (`AudioContext` + `AudioBufferSourceNode` + `GainNode`, with deterministic virtual clock fallback for headless/Node tests), drives vowel formants (`A, E, I, O, U`) for stage lip-sync, and performs a `100ms` gain fade-out on barge-in.
   - Computes exact `PlaybackReceipt` (`throughMs`, `heardText`, `unheardText`, `controlNote`) from the audio playback clock, aborts the active LLM turn (`abortTurn`), and injects `[Interrupted after Xms — user heard: "..." | unheard: "..."]` into the next turn's `SendTurnInput` $\rightarrow$ `TurnOrchestrator` $\rightarrow$ `SoulComposer` (`[VOICE BARGE-IN RECEIPT]` in `volatileTurnContext`).

5. **Mic Modes (`muted`, `continuous`, `push-to-talk`), Wake Word (`"Ashy"` / `"Ei Ashy"`), Deterministic `.wav` Fixtures & Wire-Back Audit (Entregas 5 & 6):**
   - Full support for `muted`, `continuous`, and `push-to-talk` modes plus optional wake-word activation (`"Ashy"`, `"Ei Ashy"`, `"Oi Ashy"`).
   - Real `.wav` audio fixtures in `assets/audio-fixtures/*.wav` (`thinking-pause-cas.wav`, `barge-in-interrupt.wav`, `wake-word-oi-ashy.wav`, `keyboard-click-noise.wav`) tested deterministically in Vitest and executable from the Desktop Hub UI.

---

## 2. Resolved Architectural Decisions (Brainstorming A1–A4)

| ID | Decision Area | Chosen Architecture |
| :--- | :--- | :--- |
| **A1** | **STT & TTS Provider Architecture** | **Dual Local + Cloud Registry:** STT (`openai-whisper`, `local-whisper-http`, `deterministic-wav-stt`) and TTS (`elevenlabs`, `openai-tts`, `local-kokoro-http`, `local-synth-fallback`) with unified configuration, health check, and offline fallback. |
| **A2** | **Audio Capture & Local VAD** | **Pluggable `VadEngine` (Silero ONNX / WebAudio Worklet + Spectral/Energy/ZCR Hybrid VAD):** Processes 16kHz `20ms` `PcmAudioBlock` frames, feeds `AudioInputRingBuffer` (AEC + Raw) with `360ms` pre-roll `HistoryLease` and `SpeechActivityTracker` hysteresis (`0.60` / `0.18`). |
| **A3** | **Turn-Taking & Barge-In Integration** | **Hybrid `VoiceEndJudge` & `SpeculativeRephrase` (`< 1ms` heuristic + `400ms` LLM timeout + CAS) + First-Class `interruptionControlNote` in `SendTurnInput` & `SoulComposer`:** Barge-in fades audio in `100ms`, aborts in-flight LLM generation, and injects `[VOICE BARGE-IN RECEIPT]` into the next turn's `volatileTurnContext`. |
| **A4** | **Mic Modes, Wake Word, TTFA & Fixtures** | **3 Mic Modes (`muted`, `continuous`, `push-to-talk`) + Wake Word (`"Ashy"` / `"Ei Ashy"`) + Live TTFA Telemetry per Provider + Real `assets/audio-fixtures/*.wav` + `verify-phase5-wireback.mjs`.** |

---

## 3. Detailed Subsystem Design

### 3.1 Shared Voice Protocol & Contracts (`@ashy/shared`)

In `packages/shared/src/host-protocol.ts`:

1. **STT & TTS Provider Identifiers and Voice Runtime Snapshot:**
   ```ts
   export const STT_PROVIDER_IDS = [
     'openai-whisper',
     'local-whisper-http',
     'deterministic-wav-stt',
   ] as const
   export type SttProviderId = (typeof STT_PROVIDER_IDS)[number]
   export const SttProviderIdSchema = v.picklist(STT_PROVIDER_IDS)

   export const TTS_PROVIDER_IDS = [
     'elevenlabs',
     'openai-tts',
     'local-kokoro-http',
     'local-synth-fallback',
   ] as const
   export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number]
   export const TtsProviderIdSchema = v.picklist(TTS_PROVIDER_IDS)

   export interface TtfaTelemetryRecord {
     providerId: TtsProviderId
     lastTtfaMs: number | null
     avgTtfaMs: number | null
     sampleCount: number
     lastSynthesizedAt: number | null
   }

   export interface VoiceRuntimeSettings {
     activeSttProviderId: SttProviderId
     activeTtsProviderId: TtsProviderId
     sttBaseUrl: string
     sttModelId: string
     ttsBaseUrl: string
     ttsModelId: string
     ttsVoiceId: string
     wakeWordEnabled: boolean
     wakeWordPhrases: string[]
   }
   ```

2. **Extended `SendTurnInputSchema` with `interruptionControlNote`:**
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

---

### 3.2 WAV Codec, Pluggable VAD Engine & Audio Fixtures (`@ashy/voice`)

1. **WAV Codec (`packages/voice/src/wav-codec.ts`):**
   - `encodeWavPcm16(samples: Float32Array, sampleRate?: number, metadataComment?: string): Uint8Array`: Encodes `Float32Array` `[-1, 1]` mono PCM into a standard RIFF/WAVE 16-bit PCM buffer (with optional `LIST/INFO` `ICMT` transcript tag for deterministic fixture verification).
   - `decodeWavToPcmBlocks(wavBytes: Uint8Array, blockDurationMs?: number): { sampleRate: number; totalDurationMs: number; blocks: PcmAudioBlock[]; metadataComment: string | null }`: Parses RIFF/WAVE headers, validates 16-bit/32-bit float PCM, slices into contiguous `PcmAudioBlock` frames (`20ms` = `320` samples at `16000Hz`), and extracts any embedded fixture comment.

2. **Pluggable VAD Engine (`packages/voice/src/vad-engine.ts`):**
   - Interface `VadEngine`:
     ```ts
     export interface VadFrameAssessment {
       probability: number
       rmsEnergy: number
       zeroCrossingRate: number
       bandEnergyRatio: number
       isSpeechCandidate: boolean
     }

     export interface VadEngine {
       processBlock(block: PcmAudioBlock): Promise<VadFrameAssessment> | VadFrameAssessment
       reset(): void
     }
     ```
   - Supports an optional async/sync `modelInferFn?: (samples: Float32Array, sampleRate: number) => Promise<number> | number` (for Silero ONNX Runtime sessions) and a built-in deterministic **Spectral + RMS + ZCR Hybrid VAD** that computes RMS energy, zero-crossing rate, and speech-band autocorrelation so voiced speech achieves `probability >= 0.65`, sustain frames stay in `[0.20, 0.55]`, and silence/DC-offset stays `< 0.05`.

3. **Real `.wav` Fixtures (`assets/audio-fixtures/*.wav` & `buildVoiceFixtureWavBytes`):**
   - `buildVoiceFixtureWavBytes(fixtureId: VoiceFixtureId): Uint8Array` in `packages/voice/src/wav-codec.ts` deterministically generates the binary RIFF/WAVE payloads so both `scripts/generate-audio-fixtures.mjs` (writing `assets/audio-fixtures/*.wav` on disk) and the browser renderer (`useAshyStore.ts`, without `node:fs`) decode the exact same `.wav` bytes via `decodeWavToPcmBlocks`.
   - `assets/audio-fixtures/thinking-pause-cas.wav`: `4.2s` 16kHz mono WAV containing initial clause (`0..800ms`: `"Deixa eu pensar num jeito de..."`), `1300ms` thinking pause (`800..2100ms`, triggering `VoiceEndJudge` $\rightarrow$ `complete: false` + `+3000ms` grace period + CAS check), speech continuation (`2100..2900ms`: `"...resolver esse bug no código."`), and `1300ms` trailing silence (`2900..4200ms`) so the turn seals naturally at the end of the stream.
   - `assets/audio-fixtures/barge-in-interrupt.wav`: `2.2s` 16kHz mono WAV containing `400ms` leading silence (`0..400ms`, ensuring `ring.retain(360)` anchors at frame `640 > 0`), `500ms` clear voiced barge-in utterance (`400..900ms`: `"Espera um segundo, Ashy!"`), and `1300ms` trailing silence (`900..2200ms`).
   - `assets/audio-fixtures/wake-word-oi-ashy.wav`: `2.2s` 16kHz mono WAV with wake-word utterance (`"Ei Ashy, olha esse log"`) + trailing silence.
   - `assets/audio-fixtures/keyboard-click-noise.wav`: `0.5s` 16kHz mono WAV with a `120ms` transient burst (`< 300ms` `minSpeechMs`) that must be rejected as `'too-short'`.

---

### 3.3 Dual Local + Cloud STT & TTS Providers (`packages/voice/src/providers.ts`)

1. **STT Provider Contract & Built-in Adapters:**
   ```ts
   export interface SttTranscriptionRequest {
     blocks: readonly PcmAudioBlock[]
     language?: string
     prompt?: string
     signal?: AbortSignal
   }

   export interface SttTranscriptionResult {
     providerId: SttProviderId
     text: string
     latencyMs: number
     confidence: number
     isPartial?: boolean
   }

   export interface SttProvider {
     readonly id: SttProviderId
     transcribe(request: SttTranscriptionRequest): Promise<SttTranscriptionResult>
   }
   ```
   - `createOpenAiWhisperSttProvider`: Encodes `blocks` into a 16kHz mono `.wav` via `encodeWavPcm16` and posts `multipart/form-data` to `${baseUrl}/audio/transcriptions` (compatible with OpenAI Whisper, Groq Whisper, and OpenRouter/local OpenAI-compatible servers).
   - `createLocalWhisperHttpSttProvider`: Posts `.wav` audio to a local Whisper.cpp / Faster-Whisper / Sherpa HTTP endpoint (`http://127.0.0.1:8080/inference` or `/v1/audio/transcriptions`), with automatic fallback to `deterministic-wav-stt` if offline when `allowOfflineFallback: true`.
   - `createDeterministicWavSttProvider`: Reads embedded fixture metadata or maps speech-frame acoustic signature to deterministic PT-BR transcripts for offline/CI execution.

2. **TTS Provider Contract & Built-in Adapters (Unified with `TtsSynthesisOutput` in `speech-pipeline.ts`):**
   ```ts
   export interface TtsSynthesisRequest {
     text: string
     voiceId?: string
     modelId?: string
     signal?: AbortSignal
   }

   export interface TtsProviderSynthesisResult extends TtsSynthesisOutput {
     providerId: TtsProviderId
     sampleRate: number
     samples: Float32Array
     vowelFrames: ReadonlyArray<{ A: number; E: number; I: number; O: number; U: number }>
     synthesisLatencyMs: number
   }

   export interface TtsProvider {
     readonly id: TtsProviderId
     synthesize(request: TtsSynthesisRequest): Promise<TtsProviderSynthesisResult>
   }
   ```
   - `createElevenLabsTtsProvider`: Calls `${baseUrl}/text-to-speech/${voiceId}` (`xi-api-key`), decodes returned WAV/PCM (or synthesizes envelope on fallback), and computes vowel lip-sync frames.
   - `createOpenAiTtsProvider`: Calls `${baseUrl}/audio/speech` (`response_format: 'wav'`), decodes WAV into `Float32Array` samples and exact `durationMs`.
   - `createLocalKokoroHttpTtsProvider`: Calls local Kokoro/Piper HTTP server (`http://127.0.0.1:8880/v1/audio/speech`).
   - `createLocalSynthFallbackTtsProvider`: Pure TypeScript formant/prosody synthesizer that generates real, harmonic 16kHz `Float32Array` PCM audio + exact phoneme/vowel lip-sync envelopes (`A, E, I, O, U`) proportional to the Portuguese syllables of `text`. Never fails offline and provides deterministic durations.

---

### 3.4 Hybrid Turn-Taking Intelligence (`packages/voice/src/turn-intelligence.ts`)

1. **`createHybridVoiceEndJudge`:**
   - **Fast Heuristic Path (`< 1ms`):**
     - Immediately returns `{ complete: false, reason: 'trailing-hesitation' }` when the transcript ends with ellipses (`...`), conjunctions/prepositions/hesitations in PT-BR or EN (`/\b(mas|então|porque|como|de|para|com|que|se|ou|tipo|hum|eh|deixa eu pensar|espera|olha só|quer dizer)\s*\.{0,3}$/i`), or open incomplete clauses.
     - Immediately returns `{ complete: true, reason: 'terminal-punctuation' }` when the transcript has `>= 2` words, does not end in a hesitation token, and ends with terminal punctuation (`.`, `!`, `?`).
   - **Fast LLM Path (with `400ms` timeout & `AbortSignal`):**
     - When `llmJudgeFn` is provided and the transcript lacks terminal punctuation without an obvious trailing hesitation, invokes `llmJudgeFn(rawText, signal)` raced against a `400ms` timer. On timeout, abort, or error, falls back cleanly to the heuristic classification.

2. **`createHybridSpeculativeRephrase`:**
   - Cleans spoken filler words and stutters (`"hum, é... é... eu acho que"` $\rightarrow$ `"eu acho que"`) deterministically in `< 1ms`, and if `llmRephraseFn` is configured, refines via the fast LLM while respecting the `AbortSignal` from `VoiceTurnController` (at `600ms` silence).

---

### 3.5 WebAudio Session Runtime, Gapless Player & Barge-In (`packages/voice/src/voice-session-runtime.ts`)

`createVoiceSessionRuntime` unifies capture, VAD, wake-word, turn-taking, TTS synthesis, and gapless playback:

1. **Mic Modes (`muted` | `continuous` | `push-to-talk`) & Wake Word (`"Ashy"` / `"Ei Ashy"`):**
   - In `muted` mode: ignores incoming audio frames and clears buffers.
   - In `push-to-talk` mode: captures and transcribes while PTT is held (`setPushToTalkActive(true)`), and seals immediately when PTT is released (`setPushToTalkActive(false)`).
   - In `continuous` mode:
     - Runs `AudioInputRingBuffer` (retaining `360ms` pre-roll via `HistoryLease` on speech onset).
     - If `wakeWordEnabled` is true and session is idle, checks `detectWakeWordInText` / `WakeWordSpotterState` (`"ashy"`, `"ei ashy"`, `"oi ashy"`) and calls `tracker.openWithWakeWord()`.
     - If Ashy is currently speaking (`isPlayingAudio === true`) and `SpeechActivityTracker` confirms sustained user speech (`isSpeaking === true` for `>= 300ms`, ignoring `< 300ms` clicks), automatically triggers **Barge-In**:
       1. Calls `pipeline.interrupt('user-vad-barge-in', currentPlaybackSec)`
       2. Fades out `GaplessAudioPlayer` over `100ms`
       3. Emits `onBargeIn(receipt)` while keeping the `360ms` pre-roll `HistoryLease` pinned so the user's interrupting words are never clipped!

2. **TTFA Telemetry Tracker:**
   - Measures `ttfaMs = firstChunkScheduledAtMs - firstTextEnqueuedAtMs` per turn and maintains rolling averages per `TtsProviderId` (`getTtfaTelemetry()`).

---

### 3.6 Cortex & Desktop Host Integration (`@ashy/cortex` & `apps/desktop`)

1. **`SoulComposer` Interruption Receipt Injection (`packages/cortex/src/prompt/soul-composer.ts`):**
   - Extend `ComposeTurnPromptInput` with `interruptionControlNote?: string`.
   - When `interruptionControlNote` is non-empty, sanitize it via `sanitizePromptLine` and include a `[VOICE BARGE-IN RECEIPT]` section in `volatileTurnContext`:
     ```text
     [VOICE BARGE-IN RECEIPT]
     - [Interrupted after 1500ms — user heard: "..." | unheard: "..."]
     - Diretriz de Interrupção: O usuário interrompeu sua fala anterior no meio. Reaja com naturalidade imediata ao que ele acabou de dizer, sabendo exatamente o que ele ouviu ("heard") e o que ficou por dizer ("unheard"), sem repetir o trecho já ouvido como robô.
     ```

2. **`TurnOrchestrator` Streaming & Barge-In Wiring (`apps/desktop/src/host/turn-orchestrator.ts`):**
   - Pass `input.interruptionControlNote` from `SendTurnInput` into `composeAshyTurnPrompt({ ..., interruptionControlNote: input.interruptionControlNote })`.

3. **Desktop Store & Hub UI (`apps/desktop/src/store/useAshyStore.ts` & `apps/desktop/src/App.tsx`):**
   - Incrementally stream `turn:delta` and `turn:marker` into `RealtimeSpeechPipeline` (powered by the active `TtsProvider` from `VoiceSessionRuntime`) during the turn so chunks are synthesized in parallel (`4x`) as tokens arrive, recording real `TTFA (ms)`.
   - When `triggerBargeIn` (or VAD barge-in) runs:
     - If a turn is currently streaming (`activeTurnId !== null`), call `abortActiveTurn()` on the host bridge,
     - Compute the `PlaybackReceipt` from the active speech pipeline,
     - Store `pendingInterruptionControlNote: receipt.controlNote` in `useAshyStore`,
     - On the next `sendUserMessage(text)`, automatically pass `interruptionControlNote` to `bridge.sendTurn(...)` and `compilePromptFromState(...)`, then clear `pendingInterruptionControlNote`.
   - Add an interactive **Voice Runtime & Audio Fixtures Panel** in the Studio / Settings (`Configurações -> Voz`) showing:
     - Active STT Provider (`openai-whisper`, `local-whisper-http`, `deterministic-wav-stt`) & Active TTS Provider (`elevenlabs`, `openai-tts`, `local-kokoro-http`, `local-synth-fallback`)
     - Mic Mode selector (`muted`, `continuous`, `push-to-talk` + Hold-to-Talk button) & Wake Word toggle (`"Ei Ashy"`)
     - Live TTFA badge (`lastTtfaMs`, `avgTtfaMs`), CAS rejection counter (`casRejectedCount`), and Last Barge-In `PlaybackReceipt` (`heardText` vs `unheardText`)
     - 1-click `.wav` Fixture Runner buttons (`thinking-pause-cas.wav`, `barge-in-interrupt.wav`, `keyboard-click-noise.wav`) to test the real audio pipeline in the UI.

---

## 4. Adversarial Red-Team & Security Analysis

| Threat / Failure Mode | Mitigation & Test Coverage |
| :--- | :--- |
| **Prompt Injection via `interruptionControlNote`** | `SendTurnInputSchema` caps `interruptionControlNote` at `1024` chars, and `SoulComposer` passes it through `sanitizePromptLine` (stripping `\r`, `\n`, `\0`, and `<\|...\|>` stage sentinels). |
| **Stale `VoiceEndJudge` Sealing Turn While User Resumes Speaking** | Protected by `VoiceTurnController` Compare-And-Swap (`CAS`) on `{ rawRev, speakerRev, contextRev }`. Tested with `thinking-pause-cas.wav` and mid-flight transcript mutations. |
| **Slow / Hanging Cloud STT or TTS Blocking Audio Capture** | `AudioInputRingBuffer` isolates slow subscribers (`maxSubscriberBufferedMs`), and both `VoiceEndJudge` (`400ms` timeout) and HTTP STT/TTS adapters use `AbortSignal` timeouts with fallback to `local-synth-fallback` / heuristic judge. |
| **Barge-In Clipping First Syllable of User's Interruption** | `VoiceSessionRuntime` acquires a `360ms` pre-roll `HistoryLease` on `AudioInputRingBuffer` at speech onset *before* the `100ms` TTS fade-out completes, preserving every sample from `anchorFrame`. |
| **Duplicate TTS Enqueue on `turn:delta` + `turn:completed`** | Track per-turn streamed character offset / sentinel stream in `useAshyStore` so `turn:delta` streams incrementally into `RealtimeSpeechPipeline` and `turn:completed` only flushes any remaining tail without re-enqueuing already-spoken sentences. |
| **Malformed / Truncated `.wav` Header Crash** | `decodeWavToPcmBlocks` validates magic bytes (`RIFF`/`WAVE`), bounds-checks chunk sizes against `wavBytes.byteLength`, and rejects zero/negative sample rates cleanly. |

---

## 5. Acceptance Criteria ("Feito quando" — `docs/ASHY_ROADMAP.md`)

1. Conversar por voz em português funciona em loop contínuo (`continuous`), `push-to-talk` e `muted`, com wake word opcional (`"Ashy"` / `"Ei Ashy"`).
2. Pausar para pensar no meio de uma frase (`thinking-pause-cas.wav`) aciona o `VoiceEndJudge` (`complete: false`) + período de graça (`+3000ms`) + proteção `CAS`, **sem** a Ashy atropelar o usuário.
3. Interromper a Ashy no meio da fala (`barge-in-interrupt.wav` ou botão de Barge-In) corta o áudio com fade de `100ms`, aborta o stream ativo se houver, gera o `PlaybackReceipt` exato e injeta `[Interrupted after Xms — user heard: "..." | unheard: "..."]` no próximo turno (`SoulComposer` + `TurnOrchestrator`).
4. TTFA (Time-To-First-Audio) é medido e registrado por provedor de TTS, com streaming incremental já no `turn:delta`.
5. Fixtures `.wav` reais existem em `assets/audio-fixtures/*.wav` e passam nos testes determinísticos (`pnpm test`) e na auditoria `scripts/verify-phase5-wireback.mjs` (`pnpm verify:wireback`).
