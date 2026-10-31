# Phase 9.2 — Ollama Omni Native 24 kHz Voice/Tools Pipeline & 100% Transparent Draggable Desktop Character Overlay

- **Date:** 2026-10-31
- **Status:** Approved by Carlos
- **Author:** Antigravity & Carlos

---

## 1. Forensic Root Cause Analysis (Real Installed App Sessions)

Investigation was conducted via two parallel subagents inspecting both the source repository and the real installed application state (`C:\Users\carlos\AppData\Local\Programs\Ashy\Ashy.exe`, `C:\Users\carlos\AppData\Roaming\@ashy\desktop\`, `C:\Users\carlos\AppData\Local\Ollama\server.log`, and user screenshots `uploads/image.png` & `uploads/image (2).png`), followed by live binary/endpoint inspection of `C:\Users\carlos\AppData\Local\Programs\Ollama\lib\ollama\llama-server.exe`.

### 1.1 Problem 1: Why Ashy Does Not Respond or Speak with an Omni Model via Ollama (`hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M`)

Forensic reconstruction of `C:\Users\carlos\AppData\Roaming\@ashy\desktop\ashy.db` and `C:\Users\carlos\AppData\Local\Ollama\server.log` across the 3 real voice turns at `16:49:10`, `16:49:23`, and `16:50:20` revealed a chain of **5 coupled root causes**:

1. **Root Cause 1A — `createTailSafeMarkerParser` swallows 100% of the response and saves `"..."` when the 2B model closes `<|ACT ...}` with `}>` instead of `}|>`:**
   - In all 3 real voice turns in `ashy.db`, the model generated a response in `raw_content`:
     ```text
     <|ACT {"emotion":"curious","intensity":0.68,"motion":"thinking"}>Carlos, o que você quer que eu analise ou te conte hoje?
     ```
   - Notice the model closed the tag with `}>` (missing the pipe `|` before `>`).
   - In `packages/llm/src/marker-parser.ts` (lines `313–366`), once `activeOpener = '<|'` is set, the parser scans exclusively for `CLOSE_STD = '|>'`. Because `|>` never appears and the response is shorter than `MAX_MARKER_SCAN_LEN = 512`, the entire reply stays trapped in `buffer`. When the stream ends, `parser.flush()` executes `buffer = ''`, **deleting the entire assistant response**.
   - `apps/desktop/src/host/turn-orchestrator.ts` (line `935`) then executes `const finalVisibleContent = cleanText || '...'`, saving `"..."` to `ashy.db` and sending `"..."` to the UI.

2. **Root Cause 1B — Ollama silently drops `input_audio` because `default_num_ctx = 4096` is exceeded by Ashy's System Prompt + Tools (~3,580 tokens):**
   - In `C:\Users\carlos\AppData\Local\Ollama\server.log` (line `10`), Ollama sets `default_num_ctx = 4096` on the 8 GB RTX 4060.
   - Ashy's `finalSystemPrompt` (~3,130 tokens) + 7 tool schemas (~450 tokens) consumes **~3,580 tokens**.
   - When Ollama budgets a multimodal request (`input_audio`), it reserves ~768 tokens for the audio attachment. Because `3580 + 768 = 4348 > 4096`, Ollama's context truncator **silently discards the audio attachment** (`tokens: text = 3637, total = 3637` in `server.log` lines `1545–1645`, with zero `encode_mtmd_` audio chunks decoded).

3. **Root Cause 1C — User voice turns fall back to literal text `"[Mensagem de voz Omni]"` with no transcript hint:**
   - In Electron on Windows, `window.webkitSpeechRecognition` (`apps/desktop/src/store/useAshyStore.ts:1524-1579`) fails silently because Chromium lacks embedded Google Speech API keys.
   - Simultaneously, `voice-settings.json` has `"activeSttProviderId": "deterministic-wav-stt"`, so `sendOmniAudioTurn` (`useAshyStore.ts:5816`) skips host STT preflight.
   - `resolveOmniTurnUserText` (`turn-orchestrator.ts:295`) falls back to `effectiveUserText: '[Mensagem de voz Omni]'`. Combined with Root Cause 1B (dropped audio), the model only saw `[Mensagem de voz Omni]`.

4. **Root Cause 1D — How to Unlock `LFM3-Omni-2B`'s Own Native 24 kHz Voice (`lfm3a_gen`) Inside Ollama Without Installing Another Server:**
   - Inspection of the GGUF metadata for `hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M` (`POST /api/show`) proved that the installed `mmproj` blob (`475 MB`) contains **both** the audio input encoder (`clip.audio.projector_type = lfm3a`) AND the **native generative speech encoder/decoder** (`clip.has_gen_audio_encoder = True`, `clip.gen.audio.projector_type = lfm3a_gen`, `tokenizer.chat_template.tts`).
   - Ollama's Go router (`ollama.exe` on port `11434`) only proxies `/v1/chat/completions` (text output) and does not forward `/tts`.
   - However, the `llama-server.exe` child process that Ollama itself spawns in the background (`127.0.0.1:<dynamic_port>`) **exposes `POST /tts` natively**!
   - Live benchmark on the user's RTX 4060 confirmed that calling `POST http://127.0.0.1:<llama_port>/tts` with `{"input": "...", "voice": "female", "language": "pt", "response_format": "wav"}` generates a **24,000 Hz, 16-bit PCM WAV file in ~795 ms** using `LFM3-Omni-2B`'s own native voice!

5. **Root Cause 1E — Preset Model ID Mismatch (`lfm3-omni:2b` vs `hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M`) & `/api/embed` 404 Spam:**
   - Clicking the `⚡ LFM3-Omni-2B (Local Ollama)` preset sets `modelId: 'lfm3-omni:2b'`, whereas the installed model pulled by `LocalRuntimeManager` is `'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M'`, causing **HTTP 404** (`Ollama\server.log` line `1650`).
   - Additionally, `packages/llm/src/embeddings.ts` repeatedly calls `POST /api/embed` with `nomic-embed-text` (not installed), generating HTTP 404 errors on every turn.

---

### 1.2 Problem 2: Why the Floating Character Widget Has a Solid Dark Background and Cannot Be Dragged

Inspection of `stage-preferences.json`, `uploads/image.png`, `uploads/image (2).png`, and the Electron/React code identified **4 root causes**:

1. **Root Cause 2A — `html` and `body` force an opaque `#111017` background in both `index.html` and `styles.css`:**
   - Although `overlayWindow` is created with `transparent: true` (`apps/desktop/src/electron/main.ts:82`), `apps/desktop/index.html` (lines `17–22`) and `apps/desktop/src/styles.css` (lines `62–66`) set `html, body { background-color: #111017; }`. In Electron/Chromium, any opaque ancestor paints the entire `380x460` window solid `#111017`.

2. **Root Cause 2B — Extra Studio UI Chrome & Vertical Scrollbar Inside the `380x460` Overlay Window:**
   - When `viewMode === 'stage'` (`apps/desktop/src/App.tsx:273-586`), the overlay window renders a `410px`-wide `.ashy-card` with `24px` outer padding, top header badges (`Modo flutuante`, model ID, `Voltar ao estúdio`), `PresenceBubble` (`IDLE NEUTRAL ...`), `stage-quick-controls`, bottom sensor bar (`#15131f`), and chat input form. This exceeds `700px` in height inside a `460px` window, creating a vertical scrollbar and boxing the character in.

3. **Root Cause 2C — Complete Absence of Window Drag Mechanism:**
   - `overlayWindow` has `frame: false` and neither `-webkit-app-region: drag` nor pointer-drag IPC (`setPosition` / `setBounds`) exists anywhere in `main/index.ts`, `preload/index.ts`, `App.tsx`, or `AshyStageCanvas.tsx`.
   - Because CSS `-webkit-app-region: drag` swallows DOM `mousemove` events on Windows/Electron (breaking Live2D gaze tracking and `shouldIgnoreMouseEvent` click-through), dragging must be implemented via **pointer events + IPC window bounds updates**.

4. **Root Cause 2D — `setIgnoreMouseEvents` Initial State Desync in Installed App (`embeddedServer`):**
   - In `apps/desktop/src/main/index.ts` (lines `623–625`), when `embeddedServer` is active (installed app), `overlayWindow.setIgnoreMouseEvents(true, { forward: true })` is called directly without updating `overlayController` (`runtimeState.ignoringMouseEvents` remains `false`) or `useAshyStore` (`ignoringMouseEvents` remains `false`).

---

## 2. Architecture & Design of the Fix

### 2.1 Pillar 1 — Native `LFM3-Omni-2B` Listening, Tool Calling, and 24 kHz Native Voice via Ollama

1. **Resilient Marker Parser (`packages/llm/src/marker-parser.ts` & `apps/desktop/src/host/turn-orchestrator.ts`):**
   - Update `createTailSafeMarkerParser` and `stripOuterDelimiters` so tags opened with `<|` or `<{'|'}` accept:
     - Standard closing `|>` or `{'|'}>`
     - Malformed closing `}>` when the tag body contains a JSON object (`<|ACT {...}>`, `<|DELAY {...}>`, `<|CALLBACK {...}>`)
   - In `flush()` and overflow recovery (`buffer.length > 512`): if an unclosed marker prefix exists at stream end, strip only the broken `<|...` tag header (up to the first `>` or `}`) and **emit all remaining visible text** via `onLiteral` so the user's reply is never lost.
   - In `turn-orchestrator.ts`, if `cleanText` is empty after streaming, run a fallback regex strip of `<|...|>` / `<|...}>` on `rawAccum` before falling back to `'...'`.

2. **Compact Context Budget for Local/Ollama Models + Full Tool Support (`apps/desktop/src/host/turn-orchestrator.ts` & `packages/cortex/src/prompt/soul-composer.ts`):**
   - When `providerState.activeProviderId === 'ollama'` (or local endpoint):
     - Keep all active tools (`tools: [...baseTools, ...(ashyStageSignalTool ? [ashyStageSignalTool] : [])]`, `maxSteps: 5`) so the model can **always call tools** (vision, agency, memory, stage signals).
     - Compress `finalSystemPrompt` for local 2B models to a high-signal compact prompt (**< 950 tokens** instead of ~3,130 tokens) by trimming verbose multi-paragraph lore/few-shot blocks while preserving Ashy's identity, Portuguese rules, `<|ACT {...}|>` syntax, memory facts, and tool usage instructions.
     - With `systemPrompt (~900 tokens) + tools (~450 tokens) + history (~300 tokens) + Ollama mtmd audio reservation (768 tokens) ≈ 2,418 tokens < 4,096`, Ollama's `llama-server.exe` **always decodes `input_audio` via `encode_mtmd_` AND has full room for tool calls and multi-step execution**.

3. **Native 24 kHz `LFM3-Omni-2B` Voice Generation Bridge (`apps/desktop/src/host/ollama-native-audio-bridge.ts` & `apps/desktop/src/host/turn-orchestrator.ts`):**
   - Create `ollama-native-audio-bridge.ts` in `apps/desktop/src/host/`:
     - Discovers the active `llama-server.exe` port spawned by Ollama (by inspecting running `llama-server.exe --model ... --port <port>` processes or the tail of `%LOCALAPPDATA%\Ollama\server.log`, caching the active port and verifying `/health`).
     - Provides `synthesizeNativeOllamaOmniSpeech({ text, voice, language, signal })`:
       - Sends UTF-8 `POST http://127.0.0.1:<llama_port>/tts` with `{"input": cleanSpeechText, "voice": "female", "language": "pt", "response_format": "wav"}`.
       - Returns the 24,000 Hz 16-bit PCM WAV buffer generated by `LFM3-Omni-2B`'s `lfm3a_gen` codec!
     - Also provides `transcribeNativeOllamaOmniAudio({ audioWavBase64, language, signal })` so when the user speaks in modular mode or needs an input transcript, `LFM3-Omni-2B` can transcribe the WAV natively via `Perform ASR in Portuguese.`!
   - In `turn-orchestrator.ts`:
     - Immediately after the `/v1/chat/completions` stream finishes (so `llama-server.exe`'s `-np 1` slot 0 is free and all tool calls + `<|ACT ...|>` markers have completed), if `audioChunkSeq === 0` and the active provider is Ollama with an Omni model (`supportsOmniAudioOut`) and `finalVisibleContent` has spoken text:
       - Call `synthesizeNativeOllamaOmniSpeech` with the clean spoken text (stripped of all `<|ACT ...|>` tags).
       - Decode the returned 24 kHz WAV into `samples` and compute `vowelFrames` (`A/E/I/O/U`) via `extractPcmFrameVowelWeights`.
       - Emit `turn:audio-delta` (`format: 'wav'`, `sampleRate: 24000`, `audioBase64`, `durationMs`, `vowelFrames`) right before `turn:completed`!
       - If `/tts` is unavailable (e.g. non-audio model), `turn:completed` automatically falls back to browser/local TTS so Ashy is never silent.

4. **Model ID Normalization & Embedding 404 Prevention (`packages/shared/src/host-protocol.ts`, `apps/desktop/src/store/useAshyStore.ts`, `apps/desktop/src/components/ModelsSettingsPanel.tsx`, `apps/desktop/src/components/FirstMeetingWizard.tsx`, `apps/desktop/src/host/provider-vault.ts`, `packages/llm/src/embeddings.ts`):**
   - Unify all `'lfm3-omni:2b'` references to `'hf.co/LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M'`, matching installed models dynamically when available, and add `'lfm3-omni:2b'` to `provider-vault.ts` auto-heal migration.
   - Cache 404 responses on remote embedding endpoints so `packages/llm/src/embeddings.ts` does not spam Ollama `/api/embed` when `nomic-embed-text` is not installed.

---

### 2.2 Pillar 2 — Frameless, 100% Transparent, Free-Draggable Desktop Character

1. **True Transparent Window & Zero Background Chrome (`apps/desktop/index.html`, `apps/desktop/src/styles.css`, `apps/desktop/src/App.tsx`, `packages/stage/src/components/AshyStageCanvas.tsx`):**
   - In `apps/desktop/index.html`: add an early inline script that checks `window.location.search.includes('view=stage-overlay')` and adds class `ashy-transparent-overlay` to `<html>`, applying `background: transparent !important; background-color: transparent !important; overflow: hidden !important;`.
   - In `apps/desktop/src/App.tsx` (`viewMode === 'stage'` when `isTransparentOverlayWindow === true`):
     - Remove all card backgrounds, borders, padding, scrollbars, top header badges, bottom status bar (`#15131f`), and bottom chat form so **only the character** is rendered on the user's screen.
     - Keep `stage-quick-controls` (`data-testid="stage-quick-controls"`) compact and hidden (`opacity: 0`) when idle, revealing smoothly on hover over the character while preserving all `data-testid` attributes.
   - In `packages/stage/src/components/AshyStageCanvas.tsx`:
     - Hide `live2d-parameter-hud` when `transparentBackground` is `true`.
     - Hide `PresenceBubble` when `transparentBackground` is `true` and the bubble only contains idle placeholder text (`'...'` or empty) with `statusLabel === 'Idle'`.

2. **Free Pointer Dragging Across the Screen & IPC Bounds Persistence (`apps/desktop/src/electron/main.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `packages/stage/src/components/AshyStageCanvas.tsx`, `apps/desktop/src/App.tsx`):**
   - Synchronize initial `setIgnoreMouseEvents(false)` between `overlayController`, `overlayWindow`, and `useAshyStore`.
   - Add `ashy:getOverlayBounds`, `ashy:setOverlayPosition`, and `ashy:focusHubWindow` IPC handlers in `main/index.ts` and `preload/index.ts`, persisting `{ overlayX, overlayY }` in `stage-preferences.json`.
   - Implement pointer-based window dragging directly on the character silhouette (`onMouseDown` -> `window` `mousemove` -> `window.ashyHost.setOverlayPosition`), locking `ignoreMouseEvents = false` while `isDragging === true` so fast mouse motion never drops the drag.
