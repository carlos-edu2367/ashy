# Ashy Phase 6 — Digital Body & Desktop Presence (Marco M3) Design Specification

**Date:** 2026-10-29
**Status:** Draft (Pending User Spec Review)
**Phase:** Fase 6 (`docs/ASHY_ROADMAP.md` — Corpo digital e presença · Marco M3: Companheira com voz e corpo · §8, §14, §15 de `docs/ASHY_PROJECT_CONTEXT.md`)
**Scope:** `@ashy/shared`, `@ashy/stage`, `@ashy/voice`, `@ashy/cortex`, `apps/desktop`, `assets/default-avatar/`, and `scripts/`

---

## 1. Executive Summary & Goal

Phase 6 completes **Marco M3 — Companheira com voz e corpo**, transforming `@ashy/stage` and the Desktop Stage Overlay from a static two-JPG portrait preview into a **real, multi-layered 2D digital body (`TachieLayeredCompositor` + `Live2D` `.model3.json` importer) with acoustic lip-sync, `<|ACT|>` timeline synchronization, dynamic $O(1)$ CPU click-through (`128x72` canvas alpha mask at `4 Hz`), and 1-click/global-hotkey desktop presence controls**:

1. **Original Layered Avatar Package (`assets/default-avatar/`) & Live2D `.model3.json` Bundle (Entregas 1 & 6):**
   - Ships Ashy's canonical multi-layered 2D Tachie rig in `assets/default-avatar/` (and `apps/desktop/public/assets/default-avatar/`):
     - `tachie-manifest.json`: Typed manifest (`TachieAvatarManifest`) defining coordinate anchors, layer z-order, all **13 canonical emotions** (`ASHY_EMOTIONS`), **4 eye states** (`open`, `half`, `closed`, `wink`), **6 mouth visemes** (`closed`, `A`, `E`, `I`, `O`, `U`), **9 motion presets** (`idle`, `tease`, `nod`, `shake`, `bounce`, `think`, `laugh`, `shrug`, `sparkle`), and cozy studio rim-light/accessory layers.
     - Layered SVG/PNG assets in `assets/default-avatar/layers/` (`base_body.svg`, `hair_back.svg`, `face_base.svg`, `blush.svg`, `eyes_open.svg`, `eyes_half.svg`, `eyes_closed.svg`, `eyes_wink.svg`, `pupils.svg`, `brows_13.svg`, `mouth_visemes.svg`, `hair_front.svg`, `accessories_fx.svg`).
     - `ashy-default.model3.json`: Reference Cubism 4 `.model3.json` manifest with 13 expressions, 6 motion groups, and hit areas (`Head`, `Body`), plus custom `.model3.json` runtime import in the Desktop Hub that injects `formatLive2DControlPrompt` into `SoulComposer`.

2. **Real Layered Tachie Canvas Compositor & 4 Hz Dynamic Silhouette Mask (Entrega 2):**
   - Replaces the static JPG + hidden (`opacity: 0.01`) SVG placeholder in `AshyStageCanvas.tsx` with a real dual-mode compositor (`TachieLayeredCompositor` + `Live2DMeshCompositor`):
     - Driven at 60/120 Hz by `createAutoBlinkDriver` (with `BLINK_THRESHOLD = 0.15` anti-loop guard), `createEyeSaccadeDriver` (empirical CDF saccades + head coupling), `sampleBreathCycle` (42% inhale / 46% exhale / 12% dwell), `createSubsteppedSpring2D` (120 Hz semi-implicit Euler + motion impulse injection from `<|ACT {"motion": "..."}|>`), `createRetinalLightSquint`, and `sampleNormalizedAmbientLight` (Oklab with `avatarPaintedAlpha > 4` exclusion).
     - Rasterizes the live avatar layers onto a real `<canvas data-testid="ashy-stage-render-canvas">` AND renders synchronized inspectable layer nodes (`data-active-viseme`, `data-eye-state`, `data-motion-preset`).
     - Samples the rendered canvas alpha channel every `250ms` (`4 Hz`) into a `128x72` `Uint8Array` silhouette mask (`extractCanvasSilhouetteMask128x72`), with deterministic fallback to `buildAvatarSilhouetteMask` when running in headless environments without Canvas 2D pixel readback.

3. **Acoustic Lip-Sync Analyzer (Formants/MFCC + Sibilants) & `<|ACT|>` Audio Timeline Sync (Entrega 3):**
   - `createAcousticLipSyncAnalyzer` in `packages/stage/src/drivers/acoustic-lip-sync.ts`:
     - Analyzes raw 16kHz/24kHz `Float32Array` PCM audio windows (from TTS synthesis or live WebAudio `AnalyserNode` / `AudioWorklet`) using RMS energy, Zero-Crossing Rate (ZCR for sibilant `S`), and low/mid/high formant band energy ratios (F1 ~300–850 Hz, F2 ~850–2300 Hz, F3/Sibilant > 2800 Hz) to output `{ rawVowels: { A, E, I, O, U, S }, rawVolume, dominantVowel }` in `< 0.2ms` per frame.
     - Feeds `createWinnerRunnerUpVowelDriver` (`winnerCap: 0.7`, `runnerUpCap: 0.35`, asymmetric smoothing `50`/`30`) and `createDynamicVisemeBlender` (`180ms` post-speech blend-back).
   - **Audio-Synchronized `<|ACT|>` Keyframe Queue:**
     - Connects `RealtimeSpeechPipeline`'s `\uE000` marker sentinel offsets and `TtsProviderSynthesisResult` PCM buffers so that inline `<|ACT {"emotion": "...", "intensity": 0.9, "motion": "..."}|>` tags fire in lockstep with the audio playback clock (`playbackTimeMs`) and drive acoustic vowel frames on every animation frame while Ashy is speaking.

4. **Real Transparent Stage Overlay Window & Deduplicated $O(1)$ Click-Through IPC (Entrega 4):**
   - Auto-detects `?view=stage-overlay` in the renderer URL so the Electron `overlayWindow` boots directly into transparent `stage` overlay mode (`background: transparent`).
   - Wires `setStageOverlayIgnoreMouse(shouldIgnore: boolean)` across `@ashy/shared`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/main/index.ts`, and `apps/desktop/src/electron/main.ts`:
     - On `mousemove` over `AshyStageCanvas`, evaluates `shouldIgnoreMouseEvent` against the `128x72` silhouette mask + `data-ui-island="true"` rects + `10px` resize border.
     - Deduplicates state transitions so IPC `ashy:setOverlayIgnoreMouse` -> `overlayWindow.setIgnoreMouseEvents(shouldIgnore, { forward: true })` is invoked only when `shouldIgnore` changes.

5. **Quick Controls Island & 1-Click / Global Shortcuts for Mic, Eyes, DND, and Hide (Entrega 5):**
   - Floating Quick Controls Island (`data-ui-island="true"`, `data-testid="stage-quick-controls"`) on the Stage Overlay and Companion Hub with 1-click toggles and global/window keyboard shortcuts:
     - **Mic Toggle** (`Alt+M` / `CommandOrControl+Shift+M`): cycles `muted` $\leftrightarrow$ `continuous` $\leftrightarrow$ `ptt`.
     - **Eyes Toggle** (`Alt+E` / `CommandOrControl+Shift+E`): cycles `off` $\leftrightarrow$ `window` $\leftrightarrow$ `screen`.
     - **DND Toggle** (`Alt+D` / `CommandOrControl+Shift+D`): toggles `dndMode` (proactive silence).
     - **Hide / Restore Avatar** (`Alt+H` / `CommandOrControl+Shift+H`): immediately hides Ashy's digital body (`isStageHidden: true`, collapsing the overlay to a minimal restore pill and calling `overlayWindow.hide()` / `show()` in Electron) and silences any active TTS playback if requested.

---

## 2. Resolved Architectural Decisions (Brainstorming Q1–Q3)

| ID | Decision Area | Chosen Architecture |
| :--- | :--- | :--- |
| **Q1** | **Avatar Assets & Tachie/Live2D Renderer** | **Manifest-Driven Multi-Layer Tachie Rig (`assets/default-avatar/tachie-manifest.json` + layered assets) + Real `<canvas>` Compositor with 4 Hz `128x72` Silhouette Extraction + `.model3.json` Live2D Importer.** |
| **Q2** | **Acoustic Lip-Sync & `<|ACT|>` Sync** | **Acoustic Formant/ZCR/RMS Analyzer (`analyzePcmFrameToVowels`) over real TTS PCM samples feeding `WinnerRunnerUpVowelDriver`, synchronized with `\uE000`-aligned `<|ACT|>` emotion/motion keyframes.** |
| **Q3** | **Stage Overlay, Click-Through & Quick Controls** | **True transparent `?view=stage-overlay` window mode, deduplicated `setIgnoreMouseEvents(shouldIgnore, { forward: true })` IPC over the 4 Hz `128x72` canvas mask, Quick Controls Island (`Mic`, `Eyes`, `DND`, `Hide`), and global/local hotkeys.** |

---

## 3. Detailed Subsystem Architecture

### 3.1 Canonical Avatar Package (`assets/default-avatar/`) & `@ashy/stage` Manifest

1. **Directory Layout:**
   ```text
   assets/default-avatar/
   ├── tachie-manifest.json          # Canonical Tachie layered rig manifest (13 emotions, 6 visemes, 9 motions)
   ├── ashy-default.model3.json      # Canonical Live2D Cubism 4 model manifest for inspector/importer
   └── layers/
       ├── base_body.svg             # Cozy Night Studio jacket & shoulders (breathing layer)
       ├── hair_back.svg             # Deep indigo-violet back hair (parallax spring layer)
       ├── face_base.svg             # Warm studio skin contour & ear details
       ├── blush.svg                 # Variable-opacity cheek blush & nose warmth
       ├── eyes_open.svg             # Crisp expressive open eye whites & lashes
       ├── eyes_half.svg             # Half-lidded smug/think/relaxed eyes
       ├── eyes_closed.svg           # Happy arc / peaceful blink closed eyes
       ├── eyes_wink.svg             # Playful tease wink (left open, right closed)
       ├── pupils.svg                # Amethyst-rose dual-highlight pupils (saccade + pupilScale driven)
       ├── brows_13.svg              # Emotion-driven left & right eyebrow geometry
       ├── mouth_visemes.svg         # Closed, A, E, I, O, U, smile, and smug mouth shapes
       ├── hair_front.svg            # Layered bangs & side strands with secondary spring bounce
       └── accessories_fx.svg        # Headset mic, sparkle, sweat-drop, and chaotic aura accents
   ```
   *(All files in `assets/default-avatar/` are also mirrored to `apps/desktop/public/assets/default-avatar/` so Vite/Electron serves them directly by URL while Node/Vitest can import or read them from `assets/default-avatar/`.)*

2. **Typed Manifest & Motion Impulse Engine (`packages/stage/src/drivers/tachie-manifest.ts`):**
   ```ts
   export type AshyMotionPreset =
     | 'idle'
     | 'tease'
     | 'nod'
     | 'shake'
     | 'bounce'
     | 'think'
     | 'laugh'
     | 'shrug'
     | 'sparkle'

   export type ActiveVisemeKey = 'closed' | 'A' | 'E' | 'I' | 'O' | 'U'
   export type EyeLayerState = 'open' | 'half' | 'closed' | 'wink'

   export interface TachieEmotionLayerMapping {
     emotion: AshyEmotion
     defaultEyeState: EyeLayerState
     browPreset: AshyEmotion
     accessoryFx: 'none' | 'sparkle' | 'sweat' | 'chaos_aura' | 'heart' | 'question'
     defaultMotion: AshyMotionPreset
   }

   export interface TachieAvatarManifest {
     id: string
     name: string
     version: string
     canvasWidth: number
     canvasHeight: number
     pivots: {
       torso: { x: number; y: number }
       head: { x: number; y: number }
       leftEye: { x: number; y: number }
       rightEye: { x: number; y: number }
       mouth: { x: number; y: number }
     }
     layers: ReadonlyArray<{
       id: string
       zIndex: number
       assetPath: string
       group: 'torso' | 'hair_back' | 'head' | 'eyes' | 'pupils' | 'brows' | 'mouth' | 'hair_front' | 'fx'
     }>
     emotions: Record<AshyEmotion, TachieEmotionLayerMapping>
   }
   ```

---

### 3.2 Acoustic Lip-Sync Analyzer (`packages/stage/src/drivers/acoustic-lip-sync.ts`)

1. **Spectral / Formant & Sibilant Analysis (`analyzePcmFrameToVowels`):**
   - Accepts a PCM window (`samples: Float32Array`, `sampleRate: number`, default `16000`):
     - Computes RMS amplitude (`rawVolume`), Zero-Crossing Rate (`zcr`), and 3-band autocorrelation / DFT band energy:
       - **Low Band ($E_{\text{low}}$, ~250–850 Hz — First Formant $F_1$):** High in open vowels (`A`, `O`).
       - **Mid Band ($E_{\text{mid}}$, ~850–2300 Hz — Second Formant $F_2$):** High in front vowels (`E`, `I`).
       - **High Band ($E_{\text{high}}$, >2600 Hz — $F_3$ & fricatives):** High in `I` and sibilant `S` (`zcr > 0.28`).
     - Maps band ratios into normalized `[0, 1]` weights `{ A, E, I, O, U, S }`:
       - `A`: dominant when `rawVolume > 0.03` and both $F_1$ and $F_2$ are balanced-open.
       - `O`: dominant when $F_1$ is strong with low $F_2$ and low ZCR.
       - `U`: dominant when energy is concentrated in very low $F_1$ (< 450 Hz) with minimal high-band energy.
       - `E`: dominant when $F_2$ is elevated alongside moderate $F_1$.
       - `I`: dominant when $F_2/F_3$ ratio is high with low $F_1$.
       - `S`: proportional to high-band ratio $\times$ high ZCR (`zcr >= 0.25`), which `WinnerRunnerUpVowelDriver` folds into `I` viseme weighting.
   - Returns:
     ```ts
     export interface AcousticLipSyncFrame {
       rawVowels: Record<VowelKey | 'S', number>
       rawVolume: number
       dominantVowel: VowelKey | null
       rmsEnergy: number
       zeroCrossingRate: number
     }
     ```

2. **Audio-Synchronized `<|ACT|>` & Acoustic Timeline (`createStageSpeechSynchronizer`):**
   - Given synthesized PCM (`samples: Float32Array`, `sampleRate: number`) and optional inline `<|ACT {"emotion","intensity","motion"}|>` keyframes aligned to character/time offsets:
     - Slices the PCM buffer into `20ms` (`50 Hz`) acoustic frames via `analyzePcmFrameToVowels`.
     - At any playback clock timestamp `playbackTimeMs`, `sampleAt(playbackTimeMs)` returns:
       - Current acoustic `{ rawVowels, rawVolume, dominantVowel }`
       - Active `<|ACT|>` override `{ emotion, intensity, motion }` if a marker keyframe has been reached.

---

### 3.3 Real Tachie & Live2D Canvas Compositor (`packages/stage/src/components/AshyStageCanvas.tsx`)

1. **Multi-Layer Canvas Rendering (`renderStageAvatarToCanvas`):**
   - `AshyStageCanvas` renders a real `<canvas data-testid="ashy-stage-render-canvas">` (alongside synchronized semantic layer telemetry attributes so both visual browser inspection and DOM/Canvas unit tests can verify every active layer):
     - Draws the Cozy Night Studio background vignette + Oklab ambient light tint (`ambientLuminance`).
     - Draws the **10 ordered Tachie layers** (`hair_back` $\rightarrow$ `base_body` $\rightarrow$ `face_base` $\rightarrow$ `blush` $\rightarrow$ `eyes` (`open`/`half`/`closed`/`wink`) $\rightarrow$ `pupils` $\rightarrow$ `brows` $\rightarrow$ `mouth` (`closed`/`A`/`E`/`I`/`O`/`U`) $\rightarrow$ `hair_front` $\rightarrow$ `accessories_fx`) with per-layer affine transforms driven by `headTx`, `headTy`, `breathValue`, `eyeFocus`, `pose`, and `motionOffset`.
     - In `mode === 'live2d'`, overlays the Live2D Cubism 4 mesh/parameter inspector HUD (`activeModelControls`: loaded expressions, motion groups, hit areas) and applies Live2D parameter bindings (`ParamAngleX/Y/Z`, `ParamEyeLOpen`, `ParamEyeROpen`, `ParamEyeBallX/Y`, `ParamBrowLY/RY`, `ParamMouthOpenY`, `ParamMouthForm`, `ParamBreath`).

2. **4 Hz Dynamic `128x72` Silhouette Mask Rasterizer (`extractCanvasSilhouetteMask128x72`):**
   - Every `250ms` (`4 Hz`), downsamples the avatar's rendered alpha channel onto an offscreen `128x72` buffer (or rasterizes the current `ComputedStageFrameState` geometry into the `128x72` `Uint8Array` mask when Canvas 2D `getImageData` is stubbed in jsdom) so `silhouetteMask` tracks Ashy's actual head/torso position and spring offset!
   - Never calls `gl.readPixels` or `getImageData` inside `onMouseMove`; `onMouseMove` performs only the $O(1)$ array lookup `silhouetteMask[row * 128 + col] > 10`.

---

### 3.4 Stage Overlay Window, Click-Through IPC & Global Shortcuts (`apps/desktop`)

1. **Shared Host Protocol Extensions (`packages/shared/src/host-protocol.ts`):**
   ```ts
   export interface StageOverlayRuntimeState {
     isOverlayVisible: boolean
     ignoringMouseEvents: boolean
     activeStageMode: 'tachie' | 'live2d'
     loadedLive2DModelName: string
     shortcuts: {
       toggleMic: string
       toggleEyes: string
       toggleDnd: string
       toggleHideStage: string
     }
   }
   ```

2. **Electron Main & Preload Wiring (`apps/desktop/src/main/index.ts`, `apps/desktop/src/electron/main.ts`, `apps/desktop/src/preload/index.ts`):**
   - `overlayWindow` supports `setIgnoreMouseEvents?(ignore: boolean, options?: { forward?: boolean }): void`, `show?(): void`, `hide?(): void`, `isVisible?(): boolean`.
   - `registerAshyElectronIpc` registers:
     - `ashy:setOverlayIgnoreMouse`: deduplicates and forwards `overlayWindow.setIgnoreMouseEvents(ignore, { forward: true })`.
     - `ashy:setOverlayVisible`: shows or hides `overlayWindow` and broadcasts/returns updated `StageOverlayRuntimeState`.
   - `globalShortcut` integration (optional dependency in `BootAshyElectronMainDeps`): registers global shortcuts (`CommandOrControl+Shift+M`, `CommandOrControl+Shift+E`, `CommandOrControl+Shift+D`, `CommandOrControl+Shift+H`) and cleans them up on `shutdown()`.

3. **Desktop Store & UI (`apps/desktop/src/store/useAshyStore.ts` & `apps/desktop/src/App.tsx`):**
   - Auto-detects `?view=stage-overlay` in `window.location.search` to start in `viewMode: 'stage'`, with `isTransparentOverlayWindow: true`.
   - Tracks:
     - `activeViseme: ActiveVisemeKey` (`closed` | `A` | `E` | `I` | `O` | `U`)
     - `activeEyeState: EyeLayerState` (`open` | `half` | `closed` | `wink`)
     - `activeMotion: AshyMotionPreset`
     - `isStageHidden: boolean` (1-click/shortcut hide/restore state)
     - `ignoringMouseEvents: boolean` (live click-through status from `AshyStageCanvas`)
     - `live2dModelControls: Live2DModelControls` + `customLive2DJsonText: string` (allowing live `.model3.json` import in `Aparência`)
   - Connects TTS playback in `useAshyStore.ts` to `createAcousticLipSyncAnalyzer` + `createStageSpeechSynchronizer` so speaking a turn (or running the Stage Lip-Sync & `<|ACT|>` Demo in UI) steps real acoustic vowels and `<|ACT|>` expressions across the turn.
   - Adds keyboard shortcut listener (`Alt+M`, `Alt+E`, `Alt+D`, `Alt+H`) in `App.tsx` and the floating **Stage Quick Controls Island (`data-testid="stage-quick-controls"`)** with 1-click buttons for Mic, Eyes, DND, and Hide/Restore.

---

## 4. Adversarial Red-Team & Security Analysis

| Threat / Failure Mode | Mitigation & Verification |
| :--- | :--- |
| **Malicious `.model3.json` Import (Prototype Pollution / Prompt Injection)** | `inspectLive2DModelJson` strips control characters, `<\|...\|>` sentinels, and blocks `__proto__`/`constructor`/`prototype` tokens, capping expression/motion names to 64 chars before `formatLive2DControlPrompt` injects them into `SoulComposer`. |
| **IPC Flood on `mousemove` (`setIgnoreMouseEvents` called 120x/sec)** | Both `useAshyStore` and `createAshyElectronOverlayConfig` deduplicate `ignoringMouseEvents` state transitions, invoking IPC `setIgnoreMouseEvents` **only** when `shouldIgnore` flips between `true` and `false`. |
| **Auto-Blink Infinite Loop on Closed-Eye Emotions (`happy` / `tease`)** | `AutoBlinkDriver` enforces `BLINK_THRESHOLD = 0.15` per eye (`eyeOpenL: 0.14` in `happy`, `eyeOpenR: 0.12` in `tease`), aborting the blink cycle immediately instead of multiplying a closed eye. |
| **User Locked Out When Avatar is Hidden (`isStageHidden: true`)** | When Ashy is hidden, a compact `data-ui-island="true"` restore pill (`"Mostrar Ashy (Alt+H)"`) remains clickable and the `Alt+H` / `CommandOrControl+Shift+H` shortcut restores visibility immediately. |
| **NaN / Denormal / Silent Audio Buffers in `analyzePcmFrameToVowels`** | `analyzePcmFrameToVowels` guards against `NaN`/`Infinity`/empty `Float32Array` inputs, returning zeroed vowels and `dominantVowel: null`. |

---

## 5. Acceptance Criteria ("Critérios de saída" — `docs/ASHY_ROADMAP.md` Fase 6)

1. **Arte Tachie Original & Live2D (Entregas 1, 2, 6):** `assets/default-avatar/` contém o manifesto e as camadas Tachie originais da Ashy + `.model3.json`, renderizados no `AshyStageCanvas` sobre `<canvas>` e camadas sincronizadas para todas as 13 emoções e 6 visemas (`closed`, `A`, `E`, `I`, `O`, `U`).
2. **Lip-Sync Acústico & `<|ACT|>` (Entrega 3):** A Ashy fala com lip-sync acústico (formantes/ZCR sobre o PCM do TTS alimentando `WinnerRunnerUpVowelDriver`) e muda de expressão/movimento em sincronia com os marcadores `<|ACT|>` recebidos.
3. **Click-Through Transparente $O(1)$ (Entrega 4):** Cliques e `mousemove` em áreas transparentes do Stage Overlay acionam `ignoringMouseEvents = true` (`setIgnoreMouseEvents(true, { forward: true })`); passar o cursor sobre a silhueta `128x72` do avatar ou sobre uma `data-ui-island="true"` aciona `ignoringMouseEvents = false`.
4. **Controles Rápidos & Atalhos (Entrega 5):** Ocultar/mostrar, silenciar o microfone, alternar Eyes e ativar DND levam exatamente 1 clique na Ilha de Controles Rápidos ou 1 atalho (`Alt+M`, `Alt+E`, `Alt+D`, `Alt+H`).
5. **Verificação Automatizada + Visual + Wire-Back:** `pnpm test`, `pnpm typecheck`, `pnpm build`, `scripts/verify-phase6-wireback.mjs` e inspeção visual em navegador real (Playwright) 100% verdes.
