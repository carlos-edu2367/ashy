# Fase 8.4 — Estado Universal da Personagem (Live2D), Palco 100% Real & Shell Electron — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Garantir que a personagem escolhida pelo usuário (Live2D Cubism 4 ou Ilustração Viva) seja universal em todas as telas da UI (Sidebar, Pré-visualização de Configurações, Palco Principal e Overlay), persistida no Host e sincronizada em tempo real entre janelas, além de desmockar o `@ashy/stage` (rastreamento real do mouse no `gazeTarget`, `motionImpulse` animado no tempo, `model.expression(...)` / `model.motion(...)` reais no Cubism 4 e manifestos reais dos presets Hiyori/Haru/Mao) e os controles/atalhos de janela do Electron.

**Architecture:**
1. **`@ashy/stage` (Task 1):**
   - `tachie-manifest.ts`: exportar `BUILTIN_LIVE2D_MODEL3_MANIFESTS` com os manifestos reais de `hiyori`, `haru` e `mao` e o helper `getBuiltinLive2DModelControls(presetId)` que retorna `inspectLive2DModelJson(manifest)`.
   - `live2d-bridge.ts` & `Live2DWebGLStage.tsx`: adicionar `applyLive2DExpressionAndMotion(model, { emotion, motionPreset, controls })` que invoca `model.expression(exprName)` e `model.motion(groupName, index)` no modelo Cubism 4 sempre que `emotion` ou `motionPreset` mudarem; expor `onCanvasReady` e `preserveDrawingBuffer: true` no WebGL para extração real da silhueta 128x72.
   - `AshyStageCanvas.tsx`: conectar `handleMouseMove` / `onMouseLeave` ao `gazeTarget` normalizado em `[-1, 1]` (`pointerGaze`, preservando precedência da prop `gazeTarget` explícita), expor `data-gaze-x` e `data-gaze-y` no container, e animar `motionImpulse` com `motionElapsedSec` avançado no loop `requestAnimationFrame` (resetando quando `motionPreset` muda, iniciando em `0.12` para compatibilidade SSR).
2. **`@ashy/shared` & `@ashy/desktop` (Task 2):**
   - `host-protocol.ts`, `kernel.ts`, `vite-host-plugin.ts`, `ashy-host-client.ts`: criar `PersistedStagePreferences` (`stageMode`, `live2dPresetId`, `live2dModelUrl`, `loadedLive2DModelName`, `live2dModelControls`, `ambientLuminance`, `showDesktopAvatar`, `isStageHidden`), persistir em `stage-preferences.json` no `userDataDir`, incluir em `AshyBootstrapSnapshot.stagePreferences`, expor RPC `updateStagePreferences` e emitir evento `stage:updated` (e `shortcut:triggered`) via SSE/IPC.
   - `useAshyStore.ts`: atualizar `setStageMode`, `selectLive2dPreset` (carregando os controles reais do preset via `getBuiltinLive2DModelControls`), `importLive2DModelJson`, `setAmbientLuminance`, `setShowDesktopAvatar` e `setStageHidden` para persistirem no Host via `updateStagePreferences`, hidratar `snapshot.stagePreferences` em `applyBootstrapSnapshot` e reagir a `stage:updated` e `shortcut:triggered` em `handleHostStreamEvent`.
   - `App.tsx`: substituir os `<img src="/assets/ashy-hero.jpg">` hardcoded na Sidebar (`.ashy-sidebar-portrait`) e no card de Pré-visualização de Configurações (`.ashy-preview-frame`) por instâncias reais de `<AshyStageCanvas />` sincronizadas ao estado universal da store, atualizar `.ashy-msg-avatar` com atributos `data-stage-mode` e `data-live2d-preset`, e conectar os 3 botões da janela (`Minimizar`, `Maximizar`, `Fechar`) ao `ashyHost`.
   - `main/index.ts` & `preload/index.ts`: adicionar auto-detecção segura de `require('electron')` no preload, adicionar IPCs `ashy:windowMinimize`, `ashy:windowMaximize`, `ashy:windowClose` e implementar os 3 atalhos globais (`electronGlobalMic`, `electronGlobalEyes`, `electronGlobalDnd`) alterando o estado real do kernel e notificando as janelas.

**Tech Stack:** TypeScript, React 19, Zustand, PixiJS + `pixi-live2d-display-lipsyncpatch/cubism4`, Electron IPC, Valibot, Vitest.

---

### Task 1: Desmockagem de `@ashy/stage` — Gaze Tracking Real, `motionImpulse` Animado, Expressões/Moções Cubism 4 Reais & Manifestos Built-in

**Files:**
- Modify: `packages/stage/src/drivers/tachie-manifest.ts`
- Modify: `packages/stage/src/drivers/live2d-bridge.ts`
- Modify: `packages/stage/src/components/Live2DWebGLStage.tsx`
- Modify: `packages/stage/src/components/AshyStageCanvas.tsx`
- Create: `apps/desktop/src/test/phase-8-4-stage-live2d-real.test.tsx`

- [ ] **Step 1 (RED): Write failing tests in `apps/desktop/src/test/phase-8-4-stage-live2d-real.test.tsx`**
  Test:
  1. `getBuiltinLive2DModelControls('hiyori' | 'haru' | 'mao')` returns real parsed controls matching each preset's `.model3.json` (`Haru` has `F01..F08`, `Mao` has `exp_01..exp_08`, `Hiyori` has `Idle` with 9 motions and `TapBody` with 1 motion).
  2. `applyLive2DExpressionAndMotion` invokes `model.expression(...)` and `model.motion(...)` with the resolved expression name and motion group (`Idle` vs `TapBody` / custom group) without throwing on models without expression/motion methods.
  3. `AshyStageCanvas` updates its gaze tracking (`data-gaze-x`, `data-gaze-y`) when the user moves the mouse over the stage (`mousemove`), resets pointer gaze on `mouseleave`, and respects explicit `gazeTarget` prop when provided.
  4. `AshyStageCanvas` animates `motionImpulse` over time via `requestAnimationFrame` instead of freezing forever at `elapsedSec = 0.12`, and resets the impulse timer when `motionPreset` changes.

- [ ] **Step 2 (GREEN): Implement the `@ashy/stage` improvements**
  - Add `BUILTIN_LIVE2D_MODEL3_MANIFESTS` and `getBuiltinLive2DModelControls` in `packages/stage/src/drivers/tachie-manifest.ts`.
  - Add `applyLive2DExpressionAndMotion` in `packages/stage/src/drivers/live2d-bridge.ts` and wire it in `packages/stage/src/components/Live2DWebGLStage.tsx`.
  - Add pointer gaze tracking (`pointerGaze`) and animated `motionElapsedSec` in `packages/stage/src/components/AshyStageCanvas.tsx`.

- [ ] **Step 3 (REFACTOR & VERIFY): Run `pnpm --filter @ashy/stage test` and `pnpm --filter @ashy/desktop test src/test/phase-8-4-stage-live2d-real.test.tsx`**

---

### Task 2: Avatar Universal na UI, Persistência/Sincronização Multi-Janela (`stagePreferences`) & Shell Electron Real

**Files:**
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `apps/desktop/src/host/kernel.ts`
- Modify: `apps/desktop/src/host/vite-host-plugin.ts`
- Modify: `apps/desktop/src/services/ashy-host-client.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/test/phase-8-4-universal-avatar-and-window.test.tsx`

- [ ] **Step 1 (RED): Write failing tests in `apps/desktop/src/test/phase-8-4-universal-avatar-and-window.test.tsx`**
  Test:
  1. Selecting a Live2D preset (e.g. `mao` or `haru`) in `useAshyStore` updates `live2dModelControls` to the preset's real `.model3.json` controls, persists `stagePreferences` to the Host (`stage-preferences.json`), survives kernel/store reboot (`bootstrapFromHost`), and synchronizes live across windows via `stage:updated` stream events.
  2. In `App.tsx`, switching to `live2d` mode (`mao`) renders `<AshyStageCanvas />` (with `live2d-webgl-stage` and `data-live2d-model-url="/live2d/models/mao/Mao.model3.json"`) universally inside `.ashy-sidebar-portrait` (on `memories`/`story` tabs) and inside `.ashy-preview-frame` (on `agency`/Configurações tab), with zero hardcoded `/assets/ashy-hero.jpg` in the sidebar or settings preview.
  3. Window control buttons (`btn-window-minimize`, `btn-window-maximize`, `btn-window-close`) invoke `ashyHost.minimizeWindow()`, `ashyHost.maximizeWindow()`, and `ashyHost.closeWindow()`, and Electron global shortcuts (`electronGlobalMic`, `electronGlobalEyes`, `electronGlobalDnd`) toggle real kernel agency consent (`micMode`, `eyesMode`, `dndMode`) and emit `shortcut:triggered`.

- [ ] **Step 2 (GREEN): Implement Host persistence, Store sync, Universal Avatar UI, and Electron window/shortcut controls**
  - Add `PersistedStagePreferences`, `UpdateStagePreferencesInputSchema`, `updateStagePreferences` RPC, and `stage:updated` / `shortcut:triggered` events in `@ashy/shared`, `kernel.ts`, `vite-host-plugin.ts`, and `ashy-host-client.ts`.
  - Wire `useAshyStore.ts` to load real preset controls via `getBuiltinLive2DModelControls`, persist stage changes via `updateStagePreferences`, hydrate `snapshot.stagePreferences`, and handle `stage:updated` + `shortcut:triggered`.
  - Replace hardcoded `<img src="/assets/ashy-hero.jpg">` in `.ashy-sidebar-portrait` and `.ashy-preview-frame` in `App.tsx` with `<AshyStageCanvas />`, and wire window buttons (`btn-window-minimize`, `btn-window-maximize`, `btn-window-close`).
  - Wire `ashy:windowMinimize`, `ashy:windowMaximize`, `ashy:windowClose` and the 3 global shortcuts in `main/index.ts` and `preload/index.ts`.

- [ ] **Step 3 (REFACTOR & VERIFY): Run full test suite (`pnpm test`, `pnpm typecheck`)**
