# Ashy Phase 6 — Digital Body & Desktop Presence (Marco M3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Phase 6 (`docs/ASHY_ROADMAP.md` — *Fase 6: Corpo digital e presença · Marco M3: Companheira com voz e corpo*): original layered Tachie rig + `.model3.json` in `assets/default-avatar/`, real Canvas/SVG layered compositor with 4 Hz `128x72` dynamic silhouette extraction, acoustic formant/ZCR lip-sync analyzer synchronized with `<|ACT|>` keyframes, transparent Stage Overlay window with deduplicated $O(1)$ click-through IPC (`setIgnoreMouseEvents`), and 1-click/global-shortcut quick controls (`Mic`, `Eyes`, `DND`, `Hide`).

**Architecture:** TDD-first (`RED -> GREEN -> REFACTOR`) across 6 self-contained tasks spanning `@ashy/shared`, `@ashy/stage`, `@ashy/cortex`, `apps/desktop`, `assets/default-avatar/`, and `scripts/`. Every new organ has a live producer, a live reader, and automated unit + UI + wire-back verification. Incorporates all 13 refinements (`B1`–`B7`, `M1`–`M6`) from the Zero-Context Red-Team Plan Review.

**Tech Stack:** TypeScript, Vitest, Valibot, React 19, Zustand, HTML5 Canvas 2D / SVG, WebAudio PCM DSP, Electron IPC.

**Spec:** `docs/superpowers/specs/2026-10-29-phase-6-digital-body-and-presence-design.md`

## Global Constraints & Red-Team Safeguards (`B1`–`B7`, `M1`–`M6`)

- **Browser-Safety Invariant (`M1`):** Files imported by the browser renderer (`packages/stage/**`, `apps/desktop/src/store/useAshyStore.ts`, `apps/desktop/src/App.tsx`) MUST NOT import `node:fs` or `node:path`.
- **Vite Build Invariant:** `apps/desktop/src/host/vite-host-plugin.ts` MUST only use `import type` from `@ashy/shared`.
- **Zero `gl.readPixels` / `getImageData` in `mousemove` & JSDOM Canvas Guard (`B6`, `M4`):** Mouse hit-testing in `AshyStageCanvas` and `createAshyElectronOverlayConfig` MUST remain strictly $O(1)$ against the pre-computed `128x72` `Uint8Array` silhouette mask (refreshed at `4 Hz` / `250ms`), `lastIgnoreMouseRef` MUST initialize to `null` so the first mouse move always emits `onIgnoreMouseChange`, and `canvas.getContext('2d')` MUST be guarded against unmocked jsdom (`!/jsdom/i.test(navigator.userAgent)`) with fallback to `buildDynamicAvatarSilhouetteMask`.
- **Outer `data-ui-island` Restriction (`B1`):** In `App.tsx` (`viewMode === 'stage'`), the outer wrapper of `floating-stage-overlay` MUST NOT have `data-ui-island="true"`; only actual interactive HUD sub-islands (`stage-quick-controls`, `ashy-presence-bubble`, top header bar, bottom chat form, `btn-restore-hidden-stage`) carry `data-ui-island="true"`.
- **URL Window Mode Resolution (`B2`):** Both initial store creation and `resetAshyStore()` / `resetStoreForTesting()` in `useAshyStore.ts` MUST read `window.location.search` (`?view=stage-overlay` / `?view=stage`) via `resolveInitialWindowMode()`.
- **Anti-Loop Blink & Wink Resolution (`B3`):** `BLINK_THRESHOLD = 0.15` remains enforced per eye, and `resolveTachieActiveLayers` detects `'wink'` when `Math.abs(effectiveEyeOpenL - effectiveEyeOpenR) >= 0.35` (covering interpolated `tease` poses where `effectiveEyeOpenR === 0.196`).
- **Goertzel Formant Pairs (`B4`):** `synthesizeFormantVowelPcm` and `analyzePcmFrameToVowels` use canonical Goertzel DFT formant pairs (`A: 750/1200 Hz`, `E: 530/1850 Hz`, `I: 300/2350 Hz`, `O: 480/850 Hz`, `U: 310/620 Hz`, `S: 4300/5900 Hz + ZCR > 0.25`).
- **Stage Controls Prompt Sanitization & Motion Forwarding (`B5`):** `soul-composer.ts` sanitizes `stageControlsPromptBlock` by stripping only `\0` and capping length (preserving `<|ACT ...|>` syntax instructions and newlines), and `useAshyStore.ts` forwards `marker.motion` on `turn:marker` and `onStageSignal` into `activeMotion`.
- **Preload & Main Overlay IPC Typing (`B7`):** `IpcRendererLike.invoke` in `apps/desktop/src/preload/index.ts` accepts `(channel: string, request?: unknown)` and `registerAshyElectronIpc` in `apps/desktop/src/main/index.ts` registers `ashy:setOverlayIgnoreMouse`, `ashy:setOverlayVisible`, and `ashy:getOverlayState`.

---

## Organ Wire-Back Matrix (Every New Capability Has Producer + Reader + Test)

| Organ / Capability | Producer (Writer) | Consumer (Live Reader) | Verification Test |
| :--- | :--- | :--- | :--- |
| **1. Shared Stage Overlay & Motion/Viseme Contracts** | `packages/shared/src/host-protocol.ts` (`ASHY_MOTION_PRESETS`, `ASHY_VISEME_KEYS`, `StageOverlayRuntimeState`, `DEFAULT_STAGE_SHORTCUTS`) | `packages/stage/src/drivers/tachie-manifest.ts` & `apps/desktop/src/store/useAshyStore.ts` | `packages/shared/src/__tests__/host-protocol.test.ts` |
| **2. Canonical Layered Avatar Package (`assets/default-avatar/`) & Manifest Engine** | `packages/stage/src/drivers/tachie-manifest.ts` & `scripts/generate-default-avatar-assets.mjs` (`assets/default-avatar/tachie-manifest.json`, `ashy-default.model3.json`, `layers/*.svg`) | `packages/stage/src/drivers/tachie-compositor.ts` & `packages/stage/src/components/AshyStageCanvas.tsx` | `packages/stage/test/stage-phase6.test.ts` |
| **3. Acoustic Lip-Sync Analyzer (Formants/ZCR) & `<|ACT|>` Audio Timeline Synchronizer** | `packages/stage/src/drivers/acoustic-lip-sync.ts` (`analyzePcmFrameToVowels`, `createStageSpeechSynchronizer`) | `packages/stage/src/components/AshyStageCanvas.tsx` & `apps/desktop/src/store/useAshyStore.ts` | `packages/stage/test/stage-phase6.test.ts` |
| **4. Multi-Layer Tachie/Live2D Canvas Compositor & 4 Hz `128x72` Silhouette Extractor** | `packages/stage/src/drivers/tachie-compositor.ts` (`renderTachieStageToCanvas`, `extractCanvasSilhouetteMask128x72`, `buildDynamicAvatarSilhouetteMask`) | `packages/stage/src/components/AshyStageCanvas.tsx` | `packages/stage/test/stage-phase6.test.ts` |
| **5. Electron Stage Overlay Click-Through IPC, Global Shortcuts & Live2D Prompt Wiring** | `apps/desktop/src/electron/main.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `packages/cortex/src/prompt/soul-composer.ts` | `apps/desktop/src/store/useAshyStore.ts` & `apps/desktop/src/__tests__/host-transport.test.ts` | `apps/desktop/src/__tests__/host-transport.test.ts` & `packages/cortex/test/cortex.test.ts` |
| **6. Desktop Stage Overlay UI (`?view=stage-overlay`), Quick Controls Island, Shortcuts & Live2D Importer** | `apps/desktop/src/store/useAshyStore.ts` (`setStageIgnoreMouseEvents`, `toggleStageHidden`, `importLive2DModelJson`, `runStageLipSyncActDemo`) | `apps/desktop/src/App.tsx` (Stage Overlay & `Aparência` Studio) | `apps/desktop/src/__tests__/phase6-digital-body-ui.test.tsx` & `scripts/verify-phase6-wireback.mjs` |

---

### Task 1: Shared Stage Overlay & Motion/Viseme Contracts (`@ashy/shared`)

**Files:**
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `packages/shared/src/__tests__/host-protocol.test.ts`

**Interfaces:**
- Consumes: `ASHY_EMOTIONS`, `AshyEmotion` from `packages/shared/src/affect-types.ts`
- Produces: `ASHY_MOTION_PRESETS`, `AshyMotionPreset`, `AshyMotionPresetSchema`, `ASHY_VISEME_KEYS`, `AshyVisemeKey`, `ASHY_EYE_LAYER_STATES`, `AshyEyeLayerState`, `StageShortcutBindings`, `StageOverlayRuntimeState`, `SetStageOverlayIgnoreMouseInputSchema`, `SetStageOverlayVisibleInputSchema`, `DEFAULT_STAGE_SHORTCUTS`, `DEFAULT_STAGE_OVERLAY_RUNTIME_STATE`

- [ ] **Step 1: Write the failing test in `packages/shared/src/__tests__/host-protocol.test.ts`**

```ts
import * as v from 'valibot'
import {
  ASHY_MOTION_PRESETS,
  ASHY_VISEME_KEYS,
  ASHY_EYE_LAYER_STATES,
  AshyMotionPresetSchema,
  SetStageOverlayIgnoreMouseInputSchema,
  SetStageOverlayVisibleInputSchema,
  DEFAULT_STAGE_SHORTCUTS,
  DEFAULT_STAGE_OVERLAY_RUNTIME_STATE,
} from '../host-protocol'

describe('Phase 6 Stage Overlay & Digital Body Shared Contracts', () => {
  it('validates motion presets, viseme keys, eye states, and overlay IPC schemas', () => {
    expect(ASHY_MOTION_PRESETS).toEqual([
      'idle',
      'tease',
      'nod',
      'shake',
      'bounce',
      'think',
      'laugh',
      'shrug',
      'sparkle',
    ])
    expect(ASHY_VISEME_KEYS).toEqual(['closed', 'A', 'E', 'I', 'O', 'U'])
    expect(ASHY_EYE_LAYER_STATES).toEqual(['open', 'half', 'closed', 'wink'])

    expect(v.parse(AshyMotionPresetSchema, 'tease')).toBe('tease')
    expect(() => v.parse(AshyMotionPresetSchema, 'backflip')).toThrow()

    expect(
      v.parse(SetStageOverlayIgnoreMouseInputSchema, {
        ignore: true,
        forward: true,
      }),
    ).toEqual({ ignore: true, forward: true })

    expect(
      v.parse(SetStageOverlayVisibleInputSchema, {
        visible: false,
      }),
    ).toEqual({ visible: false })

    expect(DEFAULT_STAGE_SHORTCUTS.toggleHideStage).toBe('Alt+H')
    expect(DEFAULT_STAGE_OVERLAY_RUNTIME_STATE.isOverlayVisible).toBe(true)
    expect(DEFAULT_STAGE_OVERLAY_RUNTIME_STATE.ignoringMouseEvents).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/shared test`
Expected: FAIL with missing exports from `../host-protocol`

- [ ] **Step 3: Write minimal implementation in `packages/shared/src/host-protocol.ts`**

Add to `packages/shared/src/host-protocol.ts`:
```ts
export const ASHY_MOTION_PRESETS = [
  'idle',
  'tease',
  'nod',
  'shake',
  'bounce',
  'think',
  'laugh',
  'shrug',
  'sparkle',
] as const
export type AshyMotionPreset = (typeof ASHY_MOTION_PRESETS)[number]
export const AshyMotionPresetSchema = v.picklist(ASHY_MOTION_PRESETS)

export const ASHY_VISEME_KEYS = ['closed', 'A', 'E', 'I', 'O', 'U'] as const
export type AshyVisemeKey = (typeof ASHY_VISEME_KEYS)[number]
export const AshyVisemeKeySchema = v.picklist(ASHY_VISEME_KEYS)

export const ASHY_EYE_LAYER_STATES = ['open', 'half', 'closed', 'wink'] as const
export type AshyEyeLayerState = (typeof ASHY_EYE_LAYER_STATES)[number]
export const AshyEyeLayerStateSchema = v.picklist(ASHY_EYE_LAYER_STATES)

export interface StageShortcutBindings {
  toggleMic: string
  toggleEyes: string
  toggleDnd: string
  toggleHideStage: string
  electronGlobalMic: string
  electronGlobalEyes: string
  electronGlobalDnd: string
  electronGlobalHideStage: string
}

export const DEFAULT_STAGE_SHORTCUTS: Readonly<StageShortcutBindings> = Object.freeze({
  toggleMic: 'Alt+M',
  toggleEyes: 'Alt+E',
  toggleDnd: 'Alt+D',
  toggleHideStage: 'Alt+H',
  electronGlobalMic: 'CommandOrControl+Shift+M',
  electronGlobalEyes: 'CommandOrControl+Shift+E',
  electronGlobalDnd: 'CommandOrControl+Shift+D',
  electronGlobalHideStage: 'CommandOrControl+Shift+H',
})

export interface StageOverlayRuntimeState {
  isOverlayVisible: boolean
  ignoringMouseEvents: boolean
  activeStageMode: 'tachie' | 'live2d'
  loadedLive2DModelName: string
  shortcuts: StageShortcutBindings
}

export const DEFAULT_STAGE_OVERLAY_RUNTIME_STATE: Readonly<StageOverlayRuntimeState> =
  Object.freeze({
    isOverlayVisible: true,
    ignoringMouseEvents: false,
    activeStageMode: 'tachie',
    loadedLive2DModelName: 'ashy-default.model3.json',
    shortcuts: DEFAULT_STAGE_SHORTCUTS,
  })

export const SetStageOverlayIgnoreMouseInputSchema = v.object({
  ignore: v.boolean(),
  forward: v.optional(v.boolean(), true),
})
export type SetStageOverlayIgnoreMouseInput = v.InferOutput<
  typeof SetStageOverlayIgnoreMouseInputSchema
>

export const SetStageOverlayVisibleInputSchema = v.object({
  visible: v.boolean(),
})
export type SetStageOverlayVisibleInput = v.InferOutput<
  typeof SetStageOverlayVisibleInputSchema
>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/shared test && pnpm --filter @ashy/shared typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/host-protocol.ts packages/shared/src/__tests__/host-protocol.test.ts
git commit -m "feat(shared): add Phase 6 stage overlay, motion preset, and viseme contracts"
```

---

### Task 2: Canonical Layered Avatar Package (`assets/default-avatar/`) & Tachie Rig / Live2D Model Loader (`@ashy/stage`)

**Files:**
- Create: `packages/stage/src/drivers/tachie-manifest.ts`
- Create: `scripts/generate-default-avatar-assets.mjs`
- Create: `assets/default-avatar/tachie-manifest.json`
- Create: `assets/default-avatar/ashy-default.model3.json`
- Create: `assets/default-avatar/layers/*.svg` (13 layered SVG assets, plus mirror in `apps/desktop/public/assets/default-avatar/`)
- Modify: `packages/stage/src/index.ts`
- Create: `packages/stage/test/stage-phase6.test.ts`

**Interfaces:**
- Consumes: `ASHY_EMOTIONS`, `AshyEmotion`, `AshyMotionPreset`, `AshyVisemeKey`, `AshyEyeLayerState` from `@ashy/shared`; `ComputedStageFrameState` from `packages/stage/src/components/AshyStageCanvas.tsx`
- Produces: `DEFAULT_ASHY_TACHIE_MANIFEST`, `DEFAULT_ASHY_LIVE2D_MODEL3_JSON`, `TachieAvatarManifest`, `ResolvedTachieLayerState`, `resolveTachieActiveLayers`, `computeMotionImpulseOffset`, `buildTachieLayerSvgMap`

- [ ] **Step 1: Write failing tests in `packages/stage/test/stage-phase6.test.ts` for Tachie manifest, layer resolution, motion impulses, and on-disk `assets/default-avatar/` files**

```ts
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ASHY_EMOTIONS, ASHY_MOTION_PRESETS, ASHY_VISEME_KEYS } from '@ashy/shared'
import {
  DEFAULT_ASHY_TACHIE_MANIFEST,
  DEFAULT_ASHY_LIVE2D_MODEL3_JSON,
  resolveTachieActiveLayers,
  computeMotionImpulseOffset,
  buildTachieLayerSvgMap,
  computeStageFrameState,
  inspectLive2DModelJson,
} from '../src/index'

describe('@ashy/stage — Phase 6 Digital Body & Presence Suite', () => {
  describe('1. Canonical Tachie Manifest, 13-Emotion Rig & On-Disk Assets', () => {
    it('defines all 13 canonical emotions, 13 layer files, and valid Live2D .model3.json on disk', () => {
      expect(DEFAULT_ASHY_TACHIE_MANIFEST.layers.length).toBe(13)
      for (const emotion of ASHY_EMOTIONS) {
        expect(DEFAULT_ASHY_TACHIE_MANIFEST.emotions[emotion]).toBeDefined()
      }

      const controls = inspectLive2DModelJson(DEFAULT_ASHY_LIVE2D_MODEL3_JSON)
      expect(controls.expressions).toEqual([...ASHY_EMOTIONS])
      expect(controls.motionGroups.length).toBeGreaterThanOrEqual(6)
      expect(controls.hitAreas).toEqual(['Head', 'Body'])

      const rootDir = path.resolve(__dirname, '../../..')
      const manifestPath = path.join(rootDir, 'assets/default-avatar/tachie-manifest.json')
      const model3Path = path.join(rootDir, 'assets/default-avatar/ashy-default.model3.json')
      expect(fs.existsSync(manifestPath)).toBe(true)
      expect(fs.existsSync(model3Path)).toBe(true)

      const svgMap = buildTachieLayerSvgMap()
      for (const layer of DEFAULT_ASHY_TACHIE_MANIFEST.layers) {
        const fullLayerPath = path.join(rootDir, layer.assetPath)
        expect(fs.existsSync(fullLayerPath)).toBe(true)
        expect(svgMap[layer.id]).toContain('<svg')
      }
    })

    it('resolves eye state (open/half/closed/wink), dominant viseme (closed/A/E/I/O/U), and motion impulse across all emotions', () => {
      // Tease emotion -> playful wink
      const teaseFrame = computeStageFrameState({
        emotion: 'tease',
        emotionIntensity: 0.9,
        isSpeaking: false,
      })
      const teaseLayers = resolveTachieActiveLayers(teaseFrame, 'tease')
      expect(teaseLayers.eyeState).toBe('wink')
      expect(teaseLayers.activeViseme).toBe('closed')
      expect(teaseLayers.motionPreset).toBe('tease')

      // Speaking vowel A -> activeViseme = 'A'
      const speakingFrame = computeStageFrameState({
        emotion: 'excited',
        emotionIntensity: 0.85,
        isSpeaking: true,
        vowels: { A: 0.65, E: 0.1, I: 0, O: 0.2, U: 0 },
      })
      const speakingLayers = resolveTachieActiveLayers(speakingFrame, 'bounce')
      expect(speakingLayers.activeViseme).toBe('A')
      expect(speakingLayers.eyeState).toBe('open')
      expect(speakingLayers.accessoryFx).toBe('sparkle')

      // Motion impulses remain finite for all 9 presets
      for (const motion of ASHY_MOTION_PRESETS) {
        const imp = computeMotionImpulseOffset(motion, 0.25)
        expect(Number.isFinite(imp.x)).toBe(true)
        expect(Number.isFinite(imp.y)).toBe(true)
        expect(Number.isFinite(imp.rotationDeg)).toBe(true)
      }
      expect(ASHY_VISEME_KEYS).toContain(speakingLayers.activeViseme)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/stage test`
Expected: FAIL with missing module `./drivers/tachie-manifest`

- [ ] **Step 3: Implement `packages/stage/src/drivers/tachie-manifest.ts` and `scripts/generate-default-avatar-assets.mjs`, and run the generator**

Implement `packages/stage/src/drivers/tachie-manifest.ts` (100% browser-safe, zero `node:fs`), export from `packages/stage/src/index.ts`, create `scripts/generate-default-avatar-assets.mjs`, and execute `node scripts/generate-default-avatar-assets.mjs` to populate `assets/default-avatar/` and `apps/desktop/public/assets/default-avatar/`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/stage test && pnpm --filter @ashy/stage typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/stage/src/drivers/tachie-manifest.ts packages/stage/src/index.ts packages/stage/test/stage-phase6.test.ts scripts/generate-default-avatar-assets.mjs assets/default-avatar apps/desktop/public/assets/default-avatar
git commit -m "feat(stage): add canonical Tachie layered rig manifest, SVG layers, and Live2D model3 bundle"
```

---

### Task 3: Acoustic Lip-Sync Analyzer (Formants/ZCR/RMS) & `<|ACT|>` Audio Timeline Synchronizer (`@ashy/stage`)

**Files:**
- Create: `packages/stage/src/drivers/acoustic-lip-sync.ts`
- Modify: `packages/stage/src/index.ts`
- Modify: `packages/stage/test/stage-phase6.test.ts`

**Interfaces:**
- Consumes: `VowelKey`, `VowelWeights`, `createWinnerRunnerUpVowelDriver` from `packages/stage/src/drivers/lip-sync-driver.ts`; `AshyEmotion`, `AshyMotionPreset` from `@ashy/shared`
- Produces: `AcousticLipSyncFrame`, `analyzePcmFrameToVowels`, `synthesizeFormantVowelPcm`, `StageActKeyframe`, `StageSpeechTimelineSample`, `StageSpeechSynchronizer`, `createStageSpeechSynchronizer`

- [ ] **Step 1: Add failing tests in `packages/stage/test/stage-phase6.test.ts` for `analyzePcmFrameToVowels` and `createStageSpeechSynchronizer`**

```ts
  describe('2. Acoustic Lip-Sync Analyzer (Formants/ZCR/RMS) & <|ACT|> Audio Timeline Sync', () => {
    it('extracts distinct dominant vowels (A, E, I, O, U) and sibilant S from raw PCM formant waveforms', () => {
      const sampleRate = 16000
      for (const targetVowel of ['A', 'E', 'I', 'O', 'U'] as const) {
        const pcm = synthesizeFormantVowelPcm(targetVowel, 60, sampleRate)
        const analyzed = analyzePcmFrameToVowels(pcm, sampleRate)
        expect(analyzed.rawVolume).toBeGreaterThan(0.15)
        expect(analyzed.dominantVowel).toBe(targetVowel)
        expect(analyzed.rawVowels[targetVowel]).toBeGreaterThan(0.45)
      }

      // High-ZCR sibilant noise ('S') maps strongly to rawVowels.S and feeds I in WinnerRunnerUpVowelDriver
      const sibilantPcm = synthesizeFormantVowelPcm('S', 60, sampleRate)
      const sibilantFrame = analyzePcmFrameToVowels(sibilantPcm, sampleRate)
      expect(sibilantFrame.rawVowels.S).toBeGreaterThan(0.5)
      expect(sibilantFrame.zeroCrossingRate).toBeGreaterThan(0.25)

      // Silence / NaN / Infinity safety
      const silentFrame = analyzePcmFrameToVowels(new Float32Array(320), sampleRate)
      expect(silentFrame.rawVolume).toBe(0)
      expect(silentFrame.dominantVowel).toBeNull()

      const poisoned = new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, -999, 0])
      const safePoison = analyzePcmFrameToVowels(poisoned, sampleRate)
      expect(Number.isFinite(safePoison.rawVolume)).toBe(true)
      expect(Number.isFinite(safePoison.rawVowels.A)).toBe(true)
    })

    it('synchronizes multi-<|ACT|> keyframes and acoustic vowel frames along the TTS audio playback clock', () => {
      const sampleRate = 16000
      const segA = synthesizeFormantVowelPcm('A', 200, sampleRate)
      const segO = synthesizeFormantVowelPcm('O', 200, sampleRate)
      const combined = new Float32Array(segA.length + segO.length)
      combined.set(segA, 0)
      combined.set(segO, segA.length)

      const sync = createStageSpeechSynchronizer({
        samples: combined,
        sampleRate,
        actKeyframes: [
          { atMs: 0, emotion: 'smug', intensity: 0.8, motion: 'tease' },
          { atMs: 200, emotion: 'excited', intensity: 0.95, motion: 'bounce' },
        ],
      })

      const at50ms = sync.sampleAt(50)
      expect(at50ms.isSpeaking).toBe(true)
      expect(at50ms.emotion).toBe('smug')
      expect(at50ms.motion).toBe('tease')
      expect(at50ms.acoustic.dominantVowel).toBe('A')
      expect(at50ms.driverFrame.winner).toBe('A')

      const at260ms = sync.sampleAt(260)
      expect(at260ms.isSpeaking).toBe(true)
      expect(at260ms.emotion).toBe('excited')
      expect(at260ms.motion).toBe('bounce')
      expect(at260ms.acoustic.dominantVowel).toBe('O')
      expect(at260ms.driverFrame.winner).toBe('O')

      const afterEnd = sync.sampleAt(500)
      expect(afterEnd.isSpeaking).toBe(false)
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/stage test`
Expected: FAIL with missing `analyzePcmFrameToVowels`, `synthesizeFormantVowelPcm`, `createStageSpeechSynchronizer`

- [ ] **Step 3: Implement `packages/stage/src/drivers/acoustic-lip-sync.ts` and export from `packages/stage/src/index.ts`**

Implement `synthesizeFormantVowelPcm`, `analyzePcmFrameToVowels`, and `createStageSpeechSynchronizer` using Goertzel / band-energy formant estimation ($F_1, F_2, F_3$) + ZCR sibilant detector + `WinnerRunnerUpVowelDriver` integration.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/stage test && pnpm --filter @ashy/stage typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/stage/src/drivers/acoustic-lip-sync.ts packages/stage/src/index.ts packages/stage/test/stage-phase6.test.ts
git commit -m "feat(stage): add acoustic formant/ZCR lip-sync analyzer and <|ACT|> timeline synchronizer"
```

---

### Task 4: Multi-Layer Tachie & Live2D Canvas Compositor + 4 Hz `128x72` Silhouette Extraction (`@ashy/stage`)

**Files:**
- Create: `packages/stage/src/drivers/tachie-compositor.ts`
- Modify: `packages/stage/src/components/AshyStageCanvas.tsx`
- Modify: `packages/stage/src/index.ts`
- Modify: `packages/stage/test/stage-phase6.test.ts`

**Interfaces:**
- Consumes: `resolveTachieActiveLayers`, `computeMotionImpulseOffset`, `DEFAULT_ASHY_TACHIE_MANIFEST`, `DEFAULT_ASHY_LIVE2D_MODEL3_JSON` from `./tachie-manifest`; `SILHOUETTE_MASK_WIDTH`, `SILHOUETTE_MASK_HEIGHT`, `shouldIgnoreMouseEvent` from `./hit-test-cpu`
- Produces: `renderTachieStageToCanvas`, `extractCanvasSilhouetteMask128x72`, `buildDynamicAvatarSilhouetteMask`, `computeLive2DParameterMap`, updated `AshyStageCanvas` with visible multi-layer Tachie rig (`opacity: 1`), `<canvas data-testid="ashy-stage-render-canvas">`, `4 Hz` dynamic silhouette refresh, and deduplicated `onIgnoreMouseChange` callback

- [ ] **Step 1: Add failing tests in `packages/stage/test/stage-phase6.test.ts` for `tachie-compositor.ts` and updated `AshyStageCanvas`**

```ts
  describe('3. Multi-Layer Tachie/Live2D Compositor, 4 Hz Dynamic Silhouette & Deduplicated Click-Through', () => {
    it('extracts a 128x72 silhouette mask from RGBA image data or dynamic head/torso pose offsets', () => {
      const rgbaWidth = 256
      const rgbaHeight = 144
      const rgba = new Uint8ClampedArray(rgbaWidth * rgbaHeight * 4)
      // Paint opaque pixel block in the top-left quadrant (col 10..20, row 10..20)
      for (let r = 10; r < 20; r++) {
        for (let c = 10; c < 20; c++) {
          const idx = (r * rgbaWidth + c) * 4
          rgba[idx] = 240
          rgba[idx + 1] = 160
          rgba[idx + 2] = 180
          rgba[idx + 3] = 255
        }
      }

      const mask = extractCanvasSilhouetteMask128x72(rgba, rgbaWidth, rgbaHeight)
      expect(mask.length).toBe(128 * 72)
      expect(mask[7 * 128 + 7]).toBe(255)
      expect(mask[60 * 128 + 110]).toBe(0)

      // Dynamic pose mask shifts with headTx / headTy
      const shiftedMask = buildDynamicAvatarSilhouetteMask({
        headTx: 38,
        headTy: -20,
        viewportWidth: 380,
        viewportHeight: 460,
      })
      expect(shiftedMask.length).toBe(128 * 72)
    })

    it('renders visible Tachie layers, active viseme/eye/motion attributes, and Live2D parameter HUD in AshyStageCanvas', () => {
      const tachieHtml = renderToStaticMarkup(
        React.createElement(AshyStageCanvas, {
          emotion: 'smug',
          emotionIntensity: 0.9,
          isSpeaking: true,
          rawVowels: { A: 0.85, E: 0.2, I: 0, O: 0, U: 0 },
          rawVolume: 0.85,
          motionPreset: 'tease',
          mode: 'tachie',
        }),
      )
      expect(tachieHtml).toContain('data-testid="ashy-stage-render-canvas"')
      expect(tachieHtml).toContain('data-testid="ashy-tachie-svg"')
      expect(tachieHtml).toContain('data-active-viseme="A"')
      expect(tachieHtml).toContain('data-motion-preset="tease"')
      // Must NOT have opacity:0.01 on the Tachie SVG in Phase 6
      expect(tachieHtml).not.toContain('opacity:0.01')

      const live2dHtml = renderToStaticMarkup(
        React.createElement(AshyStageCanvas, {
          emotion: 'chaotic',
          mode: 'live2d',
          isSpeaking: false,
        }),
      )
      expect(live2dHtml).toContain('data-testid="live2d-parameter-hud"')
      expect(live2dHtml).toContain('ParamMouthOpenY')
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/stage test`
Expected: FAIL with missing `extractCanvasSilhouetteMask128x72`, `buildDynamicAvatarSilhouetteMask`, and `opacity:0.01` still present in `AshyStageCanvas`

- [ ] **Step 3: Implement `packages/stage/src/drivers/tachie-compositor.ts` and update `packages/stage/src/components/AshyStageCanvas.tsx`**

1. Create `packages/stage/src/drivers/tachie-compositor.ts` with `extractCanvasSilhouetteMask128x72`, `buildDynamicAvatarSilhouetteMask`, `computeLive2DParameterMap`, and `renderTachieStageToCanvas`.
2. Update `packages/stage/src/components/AshyStageCanvas.tsx` to:
   - Accept optional `motionPreset?: AshyMotionPreset`, `transparentBackground?: boolean`, `live2dControls?: Live2DModelControls`.
   - Render `<canvas data-testid="ashy-stage-render-canvas">` + visible multi-layer Tachie rig (`opacity: 1`) with `data-active-viseme`, `data-eye-state`, `data-motion-preset`, `data-brow-preset`, and `data-accessory-fx`.
   - Refresh the `128x72` silhouette mask at `4 Hz` (`250ms`) from the rendered canvas / dynamic pose.
   - Deduplicate `onIgnoreMouseChange(ignore)` via a `lastIgnoreMouseRef` so repeated mouse movements in the same zone never spam IPC.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/stage test && pnpm --filter @ashy/stage typecheck`
Expected: PASS (all existing `stage.test.ts` + new `stage-phase6.test.ts` tests green)

- [ ] **Step 5: Commit**

```bash
git add packages/stage/src/drivers/tachie-compositor.ts packages/stage/src/components/AshyStageCanvas.tsx packages/stage/src/index.ts packages/stage/test/stage-phase6.test.ts
git commit -m "feat(stage): implement multi-layer Tachie/Live2D canvas compositor and 4Hz silhouette mask"
```

---

### Task 5: Electron Stage Overlay IPC (`setIgnoreMouseEvents`), Global Shortcuts & Live2D Prompt Wiring (`@ashy/cortex` & `apps/desktop` Main/Preload)

**Files:**
- Modify: `packages/cortex/src/prompt/soul-composer.ts`
- Modify: `packages/cortex/src/ashy-cortex.ts`
- Modify: `packages/cortex/test/cortex.test.ts`
- Modify: `apps/desktop/src/electron/main.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/__tests__/host-transport.test.ts`

**Interfaces:**
- Consumes: `formatLive2DControlPrompt`, `Live2DModelControls` from `@ashy/stage`; `DEFAULT_STAGE_SHORTCUTS`, `StageOverlayRuntimeState` from `@ashy/shared`
- Produces: `stageControlsPromptBlock?: string` in `ComposeTurnPromptInput`; `setOverlayIgnoreMouse`, `setOverlayVisible`, `getOverlayRuntimeState` in `AshyPreloadApi` and `registerAshyElectronIpc`; `globalShortcut` registration & cleanup in `bootAshyElectronMain`

- [ ] **Step 1: Write failing tests in `packages/cortex/test/cortex.test.ts` and `apps/desktop/src/__tests__/host-transport.test.ts`**

1. In `packages/cortex/test/cortex.test.ts`: test that `composeAshyTurnPrompt` with `stageControlsPromptBlock: formatLive2DControlPrompt(controls)` includes `[STAGE AVATAR CAPABILITIES]` in `volatileTurnContext` while keeping `staticSystemPrompt` 100% deterministic.
2. In `apps/desktop/src/__tests__/host-transport.test.ts`: test that `bootAshyElectronMain` wires `ashy:setOverlayIgnoreMouse` (calling `overlayWindow.setIgnoreMouseEvents(true, { forward: true })` and deduplicating identical calls), `ashy:setOverlayVisible` (`overlayWindow.hide()` / `overlayWindow.show()`), and `globalShortcut.register` for the 4 global shortcuts (`CommandOrControl+Shift+M/E/D/H`) + `globalShortcut.unregisterAll()` on `shutdown()`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ashy/cortex test && pnpm --filter @ashy/desktop test`
Expected: FAIL

- [ ] **Step 3: Implement in `soul-composer.ts`, `ashy-cortex.ts`, `electron/main.ts`, `main/index.ts`, and `preload/index.ts`**

1. Add optional `stageControlsPromptBlock?: string` to `ComposeTurnPromptInput` in `packages/cortex/src/prompt/soul-composer.ts` and forward in `packages/cortex/src/ashy-cortex.ts`.
2. Extend `createAshyElectronOverlayConfig` in `apps/desktop/src/electron/main.ts` with deduplicated `lastIgnoreMouseEvents` state and dynamic silhouette mask updates.
3. Extend `apps/desktop/src/main/index.ts` and `apps/desktop/src/preload/index.ts` with `ashy:setOverlayIgnoreMouse`, `ashy:setOverlayVisible`, `ashy:getOverlayState`, and `globalShortcut` lifecycle support.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ashy/cortex test && pnpm --filter @ashy/desktop test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cortex/src/prompt/soul-composer.ts packages/cortex/src/ashy-cortex.ts packages/cortex/test/cortex.test.ts apps/desktop/src/electron/main.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/__tests__/host-transport.test.ts
git commit -m "feat(desktop,cortex): wire Stage Overlay click-through IPC, global shortcuts, and Live2D prompt controls"
```

---

### Task 6: Desktop Stage Overlay UI (`?view=stage-overlay`), Quick Controls Island, Shortcuts, Live2D Importer & Wire-Back Audit (`apps/desktop` & `scripts/`)

**Files:**
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/__tests__/phase6-digital-body-ui.test.tsx`
- Create: `scripts/verify-phase6-wireback.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `analyzePcmFrameToVowels`, `createStageSpeechSynchronizer`, `synthesizeFormantVowelPcm`, `resolveTachieActiveLayers`, `inspectLive2DModelJson`, `formatLive2DControlPrompt`, `DEFAULT_ASHY_LIVE2D_MODEL3_JSON` from `@ashy/stage`
- Produces: Store actions `setStageIgnoreMouseEvents`, `toggleStageHidden`, `setStageHidden`, `triggerStageMotion`, `importLive2DModelJson`, `runStageLipSyncActDemo`; UI elements `stage-quick-controls`, `btn-quick-mic`, `btn-quick-eyes`, `btn-quick-dnd`, `btn-quick-hide-stage`, `btn-restore-hidden-stage`, `stage-clickthrough-badge`, `stage-active-viseme-badge`, `live2d-json-import-input`, `btn-import-live2d-json`, `btn-run-stage-lipsync-demo`; and `scripts/verify-phase6-wireback.mjs`

- [ ] **Step 1: Write failing UI & store integration tests in `apps/desktop/src/__tests__/phase6-digital-body-ui.test.tsx`**

Test:
1. **URL Auto-Boot (`?view=stage-overlay`) & Transparent Click-Through ($O(1)$):**
   - Booting with `?view=stage-overlay` initializes `viewMode === 'stage'` and `isTransparentOverlayWindow === true`.
   - Moving mouse over transparent background corner `(80, 80)` sets `ignoringMouseEvents === true` and invokes preload `setOverlayIgnoreMouse(true)`; moving mouse over avatar center `(180, 220)` or over `data-testid="stage-quick-controls"` (`data-ui-island="true"`) sets `ignoringMouseEvents === false` and deduplicates repeated moves.
2. **Acoustic Lip-Sync & `<|ACT|>` Timeline Synchronization (`runStageLipSyncActDemo` & Turn Playback):**
   - Running `runStageLipSyncActDemo` (or speaking a turn with `<|ACT {"emotion":"smug","intensity":0.9,"motion":"tease"}|>`) steps real acoustic PCM frames through `createStageSpeechSynchronizer`, updates `activeViseme` (`A`/`O`/`E`/`I`/`U`), `stageEmotion`, and `activeMotion` (`tease`), and returns `activeViseme` to `'closed'` when playback finishes.
3. **1-Click Quick Controls & Keyboard Shortcuts (`Alt+M`, `Alt+E`, `Alt+D`, `Alt+H`):**
   - Clicking `btn-quick-mic` or pressing `Alt+M` toggles mic mode (`muted` $\leftrightarrow$ `continuous`).
   - Clicking `btn-quick-eyes` or pressing `Alt+E` cycles Eyes mode (`off` $\rightarrow$ `window` $\rightarrow$ `screen`).
   - Clicking `btn-quick-dnd` or pressing `Alt+D` toggles `dndMode`.
   - Clicking `btn-quick-hide-stage` or pressing `Alt+H` hides the avatar (`isStageHidden === true`), stops active speech, shows the compact restore pill (`btn-restore-hidden-stage`), and pressing `Alt+H` or clicking the pill restores the avatar (`isStageHidden === false`).
4. **Live2D `.model3.json` Importer in `Aparência` (`importLive2DModelJson`):**
   - Importing a custom `.model3.json` manifest in `Aparência` validates and extracts expressions/motions via `inspectLive2DModelJson`, switches `stageMode` to `'live2d'`, displays the loaded controls in the UI, and injects `formatLive2DControlPrompt` into `compilePromptFromState().volatileTurnContext`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/desktop test src/__tests__/phase6-digital-body-ui.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement in `apps/desktop/src/store/useAshyStore.ts`, `apps/desktop/src/App.tsx`, and `scripts/verify-phase6-wireback.mjs`**

1. Update `apps/desktop/src/store/useAshyStore.ts` with Phase 6 state & actions (`activeViseme`, `activeEyeState`, `activeMotion`, `isStageHidden`, `ignoringMouseEvents`, `isTransparentOverlayWindow`, `live2dModelControls`, `setStageIgnoreMouseEvents`, `toggleStageHidden`, `triggerStageMotion`, `importLive2DModelJson`, `runStageLipSyncActDemo`).
2. Update `apps/desktop/src/App.tsx` with the transparent Stage Overlay layout, **Stage Quick Controls Island (`data-testid="stage-quick-controls"`)**, keyboard shortcut listener (`Alt+M/E/D/H`), acoustic lip-sync demo trigger, and Live2D `.model3.json` importer card in `Aparência`.
3. Create `scripts/verify-phase6-wireback.mjs` and append `&& node scripts/verify-phase6-wireback.mjs` to `verify:wireback` in root `package.json`.

- [ ] **Step 4: Run tests, wire-back audit, typecheck, and build**

Run: `pnpm verify:wireback && pnpm test && pnpm typecheck && pnpm build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/store/useAshyStore.ts apps/desktop/src/App.tsx apps/desktop/src/__tests__/phase6-digital-body-ui.test.tsx scripts/verify-phase6-wireback.mjs package.json
git commit -m "feat(desktop): integrate Phase 6 digital body, acoustic lip-sync, overlay click-through, and quick controls"
```
