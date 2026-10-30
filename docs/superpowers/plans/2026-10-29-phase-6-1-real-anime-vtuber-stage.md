# Fase 6.1 — Palco VTuber 2D Real (Live2D Cubism 4 WebGL + Anime PNGTuber) · Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o renderizador geométrico provisório de SVG/Canvas em `@ashy/stage` e `apps/desktop` por um motor VTuber 2D real com **Live2D Cubism 4 WebGL** (`pixi.js` v7 + `pixi-live2d-display` + `.moc3` com texturas `2048x2048` e física `.physics3.json`) e **Anime PNGTuber de Sprites Pintados** (estilo *Veadotube Mini* com *squash-and-stretch* vocal e zero primitivas vetoriais amadoras), mantendo o contrato preparado para **VRM 3D (`@pixiv/three-vrm`)** no futuro.

**Architecture:** `AshyStageCanvas` atua como orquestrador do loop de física a `120 Hz` (`computeStageFrameState`, `computeLive2DParameterMap`, lip-sync acústico Goertzel $F_1/F_2$ + ZCR e sincronizador `<|ACT|>`), delegando a renderização visual para dois motores reais: (1) `Live2DWebGLStage` (`mode === 'live2d'`), que instancia `PIXI.Application` + `Live2DModel` e injeta os parâmetros procedurais e fonéticos diretamente no `beforeModelUpdate` do Cubism Core antes da simulação física de cabelo/roupa; e (2) `AnimePngTuberStage` (`mode === 'tachie'`), que alterna sprites de anime pintados reais (`eyes_open_mouth_closed`, `eyes_open_mouth_open`, `eyes_open_mouth_smile`, `eyes_closed_mouth_closed`, `eyes_closed_mouth_open`, `concerned`) com física de *squash-and-stretch* proporcional ao RMS/visema da voz.

**Tech Stack:** TypeScript 5.8+, React 19, `pixi.js@^7.4.2`, `pixi-live2d-display-lipsyncpatch@^0.5.0-ls-8`, Live2D Cubism 4 Core (`live2dcubismcore.min.js`), HTML5 Canvas/WebGL, Zustand, Vitest + Testing Library + Playwright.

---

## Mapa de Arquivos

| Arquivo | Ação | Responsabilidade |
| :--- | :--- | :--- |
| `packages/shared/src/host-protocol.ts` | Modificar | Adicionar `StageAvatarMode = 'tachie' | 'live2d' | 'vrm'`, `Live2DBuiltinModelId = 'hiyori' | 'haru' | 'mao'`, `Live2DModelPreset`, `PngTuberSpriteStateKey` e `BUILTIN_LIVE2D_MODEL_PRESETS`. |
| `packages/shared/src/__tests__/host-protocol.test.ts` | Modificar | Testar contratos de presets Live2D, `StageAvatarMode` (incluindo `'vrm'` reservado) e chaves de estado PNGTuber. |
| `scripts/fetch-and-prepare-vtuber-assets.mjs` | Criar | Baixar e verificar `live2dcubismcore.min.js` e os pacotes completos Cubism 4 (`.model3.json`, `.moc3`, `.physics3.json`, `.pose3.json`, `.cdi3.json`, texturas PNG e motions) para `Hiyori`, `Haru` e `Mao` em `apps/desktop/public/live2d/`. |
| `apps/desktop/public/assets/default-avatar/sprites/*.png` | Criar | 6 sprites de anime pintados de alta resolução da Ashy (*Cozy Night Studio*) para os estados reais de PNGTuber (olhos abertos/fechados × boca fechada/aberta/sorrindo + preocupada). |
| `packages/stage/src/drivers/live2d-bridge.ts` | Criar | Ponte pura e testável (`applyLive2DParametersToCoreModel`, `resolveEmotionToLive2DExpressionIndex`, `computePngTuberBounceTransform`, `resolvePngTuberSpriteState`, `hasWebGLSupport`). |
| `packages/stage/src/components/Live2DWebGLStage.tsx` | Criar | Componente React WebGL (`PIXI.Application` + `Live2DModel.from`) que carrega `.model3.json`/`.moc3` reais, injeta parâmetros no `beforeModelUpdate` a 60 FPS e expõe fallback determinístico para `jsdom`/SSR. |
| `packages/stage/src/drivers/tachie-compositor.ts` | Modificar | Remover primitivas geométricas de rosto/olhos/boca (`ctx.ellipse`) e atualizar compositor de silhueta `128x72` a `4 Hz` + helper de sprites PNGTuber. |
| `packages/stage/src/components/AshyStageCanvas.tsx` | Modificar | Remover `<svg>` de elipses/círculos geométricos; integrar `Live2DWebGLStage` (`mode === 'live2d'`) e o motor de sprites pintados `AnimePngTuberStage` com *squash-and-stretch* (`mode === 'tachie'`). |
| `apps/desktop/index.html` | Modificar | Carregar `<script src="/live2d/live2dcubismcore.min.js"></script>` antes do bundle principal. |
| `apps/desktop/src/store/useAshyStore.ts` | Modificar | Adicionar `live2dPresetId: Live2DBuiltinModelId` (default `'hiyori'`), ação `setLive2dPreset(presetId)` que atualiza `live2dModelUrl` e `live2dControls`, e suporte a troca instantânea de modelo Live2D. |
| `apps/desktop/src/App.tsx` | Modificar | Adicionar seletor visual de personagem Live2D (`Hiyori Momose`, `Haru Greeter`, `Mao Pro`, ou `.model3.json` customizado) na aba **Aparência** e conectar `live2dModelUrl` ao `AshyStageCanvas`. |
| `scripts/verify-phase6-wireback.mjs` | Modificar | Auditar presença local de `live2dcubismcore.min.js`, modelos `.moc3` (`Hiyori`, `Haru`, `Mao`), 6 sprites PNGTuber da Ashy, `Live2DWebGLStage.tsx` e ausência de primitivas geométricas faciais em `AshyStageCanvas.tsx`. |

---

## Task 1: Contratos VTuber Extensíveis & Catálogo de Presets (`@ashy/shared`)

**Files:**
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `packages/shared/src/__tests__/host-protocol.test.ts`

- [ ] **Step 1 (RED):** Adicionar testes em `packages/shared/src/__tests__/host-protocol.test.ts` validando:
  - `STAGE_AVATAR_MODES` contendo `['tachie', 'live2d', 'vrm']`
  - `BUILTIN_LIVE2D_MODEL_PRESETS` contendo `hiyori`, `haru` e `mao` com URLs locais `/live2d/models/.../*.model3.json`
  - `PNGTUBER_SPRITE_STATE_KEYS` contendo os 6 estados pintados (`eyes_open_mouth_closed`, `eyes_open_mouth_open`, `eyes_open_mouth_smile`, `eyes_closed_mouth_closed`, `eyes_closed_mouth_open`, `concerned`).
- [ ] **Step 2 (GREEN):** Implementar os tipos e constantes em `packages/shared/src/host-protocol.ts` e re-exportá-los em `packages/shared/src/index.ts`.
- [ ] **Step 3 (VERIFY):** Rodar `pnpm --filter @ashy/shared test && pnpm --filter @ashy/shared typecheck && pnpm --filter @ashy/shared build`.

---

## Task 2: Runtime `live2dcubismcore.min.js`, Modelos `.moc3` Reais (`Hiyori`, `Haru`, `Mao`) & Sprites Pintados PNGTuber

**Files:**
- Create: `scripts/fetch-and-prepare-vtuber-assets.mjs`
- Create: `apps/desktop/public/live2d/live2dcubismcore.min.js`
- Create: `apps/desktop/public/live2d/models/hiyori/**`, `apps/desktop/public/live2d/models/haru/**`, `apps/desktop/public/live2d/models/mao/**`
- Create: `apps/desktop/public/assets/default-avatar/sprites/*.png` (e espelho em `assets/default-avatar/sprites/*.png`)

- [ ] **Step 1 (Red-Team `B5` & `M1`):** Criar e executar `scripts/fetch-and-prepare-vtuber-assets.mjs` para:
  - Baixar `live2dcubismcore.min.js` de `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` para `apps/desktop/public/live2d/live2dcubismcore.min.js`.
  - Baixar os pacotes completos de `Hiyori`, `Haru` e `Mao` a partir de `https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources/{Hiyori|Haru|Mao}/` (com fallback automático para `https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@4-r.7/Samples/Resources/`), lendo dinamicamente o manifesto `.model3.json` (`FileReferences.Moc`, `Textures`, `Physics`, `Pose`, `DisplayInfo`, `UserData`, `Expressions`, `Motions`), removendo chaves `"Sound"` das motions de `Haru.model3.json` (`B5`), e validando que cada arquivo baixado possui `> 0` bytes.
- [ ] **Step 2:** Gerar os 6 sprites de anime pintados de alta resolução da Ashy (*Cozy Night Studio*) em `apps/desktop/public/assets/default-avatar/sprites/` (e `assets/default-avatar/sprites/`):
  - `ashy-eyes-open-mouth-closed.png`
  - `ashy-eyes-open-mouth-open.png`
  - `ashy-eyes-open-mouth-smile.png`
  - `ashy-eyes-closed-mouth-closed.png`
  - `ashy-eyes-closed-mouth-open.png`
  - `ashy-concerned.png`
- [ ] **Step 3:** Verificar que todos os arquivos existem em disco e são servíveis estaticamente pelo Vite.

---

## Task 3: Ponte Live2D Cubism 4 & Componente `Live2DWebGLStage` (`@ashy/stage`)

**Files:**
- Modify: `packages/stage/package.json` & `apps/desktop/package.json` (adicionar `@pixi/core@^7.4.2`, `@pixi/display@^7.4.2`, `pixi.js@^7.4.2` e `pixi-live2d-display-lipsyncpatch@^0.5.0-ls-8` — Red-Team `B2`)
- Create: `packages/stage/src/drivers/live2d-bridge.ts`
- Create: `packages/stage/src/components/Live2DWebGLStage.tsx`
- Modify: `packages/stage/test/stage-phase6.test.ts`

- [ ] **Step 1 (RED):** Escrever testes unitários em `packages/stage/test/stage-phase6.test.ts` para:
  - `applyLive2DParametersToCoreModel(mockCoreModel, live2dParams)` verificando escrita exata de `ParamAngleX/Y/Z`, `ParamBodyAngleX/Y/Z`, `ParamEyeLOpen/ROpen`, `ParamEyeLSmile/RSmile`, `ParamEyeBallX/Y`, `ParamBrowLY/RY`, `ParamMouthOpenY`, `ParamA` (necessário para `Mao.model3.json` — Red-Team `B4`), `ParamMouthForm`, `ParamCheek`, `ParamBreath`.
  - `computePngTuberBounceTransform({ mouthOpen, isSpeaking, breathValue, headTx, headTy, headRotDeg, motionPreset })` verificando *squash-and-stretch* elástico quando falando (`scaleY > 1`, `scaleX < 1`, `translateY < 0`) e retorno suave em silêncio.
  - `resolvePngTuberSpriteState({ eyeState, activeViseme, emotion, isSpeaking })` mapeando os 6 estados pintados da Ashy sem ambiguidade.
- [ ] **Step 2 (GREEN — Red-Team `B1` & `M2`):** Implementar `packages/stage/src/drivers/live2d-bridge.ts` e `packages/stage/src/components/Live2DWebGLStage.tsx`:
  - **Proibido import estático top-level de `pixi-live2d-display-lipsyncpatch/cubism4`** (`B1`, pois ele lança erro se `window.Live2DCubismCore` não existir no Node/JSDOM).
  - Dentro do `useEffect` de `Live2DWebGLStage.tsx`, quando `hasWebGLSupport()` for verdadeiro (`typeof window !== 'undefined'`, não-`jsdom` e `Boolean(window.Live2DCubismCore)`), fazer `await import('pixi.js')`, atribuir `window.PIXI = PIXI`, fazer `await import('pixi-live2d-display-lipsyncpatch/cubism4')`, instanciar `PIXI.Application` transparente e carregar `Live2DModel.from(modelUrl, { autoInteract: false })`.
  - Proteger contra race condition de unmount assíncrono (`let disposed = false` — `M2`), registrar `internalModel.on('beforeModelUpdate', updateHandler)` para injetar `applyLive2DParametersToCoreModel`, e limpar `internalModel.off(...)`, `model.destroy()` e `app.destroy(true, { children: true })` no cleanup.
- [ ] **Step 3 (VERIFY):** Rodar `pnpm --filter @ashy/stage test && pnpm --filter @ashy/stage typecheck`.

---

## Task 4: Motor `AnimePngTuberStage` & Remoção Total das Primitivas Geométricas em `AshyStageCanvas.tsx`

**Files:**
- Modify: `packages/stage/src/drivers/tachie-compositor.ts`
- Modify: `packages/stage/src/components/AshyStageCanvas.tsx`
- Modify: `packages/stage/src/index.ts`
- Modify: `packages/stage/test/stage.test.ts` & `packages/stage/test/stage-phase6.test.ts`

- [ ] **Step 1 (RED):** Atualizar `packages/stage/test/stage-phase6.test.ts` para afirmar que o HTML renderizado por `AshyStageCanvas` **NÃO contém** as formas geométricas de rosto/cabelo (`#fde8e8`, `ashy-mouth`, `ashy-eye-left`, `ashy-eye-right`, `ashy-tachie-svg`) e, em vez disso:
  - Em `mode === 'tachie'`, renderiza o motor `data-testid="ashy-pngtuber-stage"` com `data-pngtuber-sprite={spriteState}`, `data-active-viseme={activeViseme}`, `data-eye-state={eyeState}` e transformações elásticas de *squash-and-stretch*.
  - Em `mode === 'live2d'`, renderiza `Live2DWebGLStage` (`data-testid="live2d-webgl-stage"`) + `data-testid="live2d-parameter-hud"`.
- [ ] **Step 2 (GREEN — Red-Team `B3`):** Atualizar `packages/stage/src/components/AshyStageCanvas.tsx` e `packages/stage/src/drivers/tachie-compositor.ts`:
  - Remover completamente o bloco `<svg data-testid="ashy-tachie-svg">` de elipses/círculos faciais.
  - Manter `<canvas ref={canvasRef} data-testid="ashy-stage-render-canvas">` com **`opacity: 0` em todos os modos** (`B3`), servindo exclusivamente como buffer invisível para a extração de silhueta `128x72` a `4 Hz` (`renderTachieStageToCanvas` desenha apenas a máscara de silhueta anatômica invisível sem olhos/boca/sobrancelhas).
  - Em `mode === 'tachie'`, renderizar `data-testid="ashy-pngtuber-stage"` com os sprites de anime pintados da Ashy, *squash-and-stretch* de VTuber (`computePngTuberBounceTransform`) e aura reativa à voz.
  - Em `mode === 'live2d'`, renderizar `<Live2DWebGLStage modelUrl={effectiveLive2dUrl} params={live2dParams} emotion={emotion} motionPreset={activeMotionPreset} width={width} height={height} />` sem sobrepor a foto estática de fundo.
- [ ] **Step 3 (VERIFY):** Rodar `pnpm --filter @ashy/stage test && pnpm --filter @ashy/stage typecheck && pnpm --filter @ashy/stage build`.

---

## Task 5: Integração Desktop (`index.html`, `useAshyStore.ts`, `App.tsx` & `verify-phase6-wireback.mjs`)

**Files:**
- Modify: `apps/desktop/index.html`
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/__tests__/phase6-digital-body-ui.test.tsx`
- Modify: `scripts/verify-phase6-wireback.mjs`

- [ ] **Step 1:** Incluir `<script src="/live2d/live2dcubismcore.min.js"></script>` no `<head>` de `apps/desktop/index.html`.
- [ ] **Step 2 (Red-Team `M3`):** Em `apps/desktop/src/store/useAshyStore.ts`, adicionar `live2dPresetId: Live2DBuiltinModelId` (default `'hiyori'`), inicializar `live2dModelUrl` com `/live2d/models/hiyori/Hiyori.model3.json` e adicionar a ação `selectLive2dPreset(presetId: Live2DBuiltinModelId)` que atualiza `live2dPresetId`, `live2dModelUrl` e `stageMode: 'live2d'`, preservando `live2dModelUrl` válido quando `importLive2DModelJson` analisa um trecho JSON.
- [ ] **Step 3:** Em `apps/desktop/src/App.tsx`:
  - Passar `live2dModelUrl={live2dModelUrl}` para todas as instâncias de `<AshyStageCanvas />` (Hub, Preview de Aparência e Stage Overlay).
  - Na aba **Aparência**, adicionar o seletor de modelo Live2D (`data-testid="live2d-preset-select"`) com os presets empacotados (**Hiyori Momose (Cubism 4)**, **Haru Greeter (Cubism 4)**, **Mao Pro (Cubism 4)**) além da importação de `.model3.json` customizado.
- [ ] **Step 4:** Atualizar `apps/desktop/src/__tests__/phase6-digital-body-ui.test.tsx` e `scripts/verify-phase6-wireback.mjs` (incluindo `live2d-bridge.ts` e `Live2DWebGLStage.tsx` em `browserSafeFiles`), e rodar toda a suíte (`pnpm verify:wireback && pnpm test && pnpm typecheck && pnpm build`).
