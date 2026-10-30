# Fase 6.1 — Palco VTuber 2D Real (Live2D Cubism 4 WebGL + Anime PNGTuber) · Especificação de Design

**Data:** 2026-10-29  
**Escopo:** Substituição do renderizador geométrico provisório (`SVG <ellipse>` / `Canvas 2D primitives`) em `@ashy/stage` e `apps/desktop` por um motor VTuber 2D real de duas camadas (**Live2D Cubism 4 WebGL** via `pixi.js` + `pixi-live2d-display` + `.moc3` com texturas e física de cabelo/roupa, e **Anime PNGTuber de Sprites Pintados** estilo *Veadotube / PNGTuber Plus*), mantendo um contrato de adaptador extensível para **VRM 3D (`@pixiv/three-vrm`)** no futuro.

---

## 1. Diagnóstico & Motivação

A implementação inicial da Fase 6 construiu toda a matemática de presença procedural (`120 Hz` spring physics, sacadas oculares acopladas ao foco de cabeça, auto-blink multiplicativo com anti-loop, lip-sync acústico Goertzel $F_1/F_2$ + ZCR sobre PCM real, sincronizador de keyframes `<|ACT|>` e máscara de silhueta `128x72` a `4 Hz`), mas o renderizador final em `AshyStageCanvas.tsx` e `tachie-compositor.ts` desenhava formas vetoriais rudimentares (`<ellipse>`, `<circle>`, `<line>`) que pareciam um boneco geométrico e não uma personagem de anime / VTuber.

Projetos de referência como **Project AIRI (`moeru-ai/airi`)** e **Open-LLM-VTuber (`Open-LLM-VTuber-Web`)** alcançam qualidade real de VTuber 2D combinando:
1. **Live2D Cubism 4 WebGL (`pixi.js` v7 + `pixi-live2d-display/cubism4` + `live2dcubismcore.min.js`)**: deforma malhas trianguladas (`ArtMesh` + *Bezier Warp Deformers*) sobre atlas de textura PNG de alta resolução (`2048x2048`) compilados em `.moc3`, com simulação de pêndulo (`.physics3.json`) para cabelo, olhos e roupas.
2. **PNGTuber de Sprites Pintados Reais (estilo *Veadotube Mini*)**: quando em modo Tachie/Ilustração 2D leve, alterna entre sprites de anime pintados reais (olhos abertos/fechados × boca fechada/aberta + expressões) com física de *squash-and-stretch* (impulso elástico vertical ao falar) e paralaxe suave — **zero primitivas geométricas vetoriais**.

---

## 2. Arquitetura do Novo `@ashy/stage` (Pronta para VRM no Futuro)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                   AshyStageCanvas (Orquestrador de Palco)                  │
│  • Loop de física 120 Hz (computeStageFrameState + Spring2D + Auto-Blink)  │
│  • Lip-Sync Acústico Goertzel (F1, F2, ZCR, RMS) + Keyframes <|ACT|>       │
│  • computeLive2DParameterMap(frame) & resolveTachieActiveLayers(frame)     │
│  • Máscara de silhueta dinâmica 128x72 a 4 Hz -> Click-Through O(1)        │
└───────────────┬───────────────────────────────┬────────────────────────────┘
                │                               │
                ▼                               ▼
┌───────────────────────────────────┐ ┌──────────────────────────────────────┐
│   Motor 1: Live2DWebGLRenderer    │ │   Motor 2: AnimePngTuberRenderer     │
│   (mode === 'live2d')             │ │   (mode === 'tachie')                │
│ • PIXI.Application (WebGL, alpha) │ │ • Sprites de Anime Pintados Reais:   │
│ • Live2DModel (pixi-live2d-display│ │   - eyes_open + mouth_closed         │
│   /cubism4 + live2dcubismcore)    │ │   - eyes_open + mouth_open (visemas) │
│ • Modelos reais empacotados:      │ │   - eyes_closed (blink/smile)        │
│   - Hiyori Momose (.moc3 + 2048px)│ │   - expressões (joy, concerned, etc) │
│   - Mao Pro / Haru Greeter        │ │ • Squash-and-Stretch VTuber bounce   │
│ • Hook `beforeModelUpdate` injeta │ │   proporcional à energia vocal RMS   │
│   ParamAngleX/Y/Z, ParamMouth*,   │ │ • Paralaxe de cabeça/respiração e    │
│   ParamEyeL/ROpen, ParamEyeBall*  │ │   iluminação ambiente Cozy Night     │
│   antes do `.physics3.json`!      │ │ • Zero elipses/círculos de SVG!      │
└───────────────────────────────────┘ └──────────────────────────────────────┘
                │
                └──► [Contrato Futuro Reservado: VrmThreeRenderer (mode === 'vrm')]
                     Interface `StageEngineAdapter` já tipada para receber
                     `@pixiv/three-vrm` na fase de 3D sem quebrar o host/store.
```

---

## 3. Componentes Técnicos Detalhados

### 3.1. Motor 1: Live2D Cubism 4 WebGL Real (`packages/stage/src/components/Live2DWebGLStage.tsx`)
- **Stack:**
  - `pixi.js@^7.4.2` (fixado na v7.x para compatibilidade total com `pixi-live2d-display`)
  - `pixi-live2d-display-lipsyncpatch@^0.5.0-ls-8` (ou `pixi-live2d-display@^0.4.0` via submodule `pixi-live2d-display/cubism4`)
  - Runtime oficial `live2dcubismcore.min.js` empacotado localmente em `apps/desktop/public/live2d/live2dcubismcore.min.js` e carregado em `apps/desktop/index.html` (garantindo funcionamento 100% offline/local-first).
- **Modelos de Anime Reais Empacotados Localmente (`apps/desktop/public/live2d/models/`):**
  - Baixados e servidos localmente para zero dependência de internet em runtime:
    1. **Hiyori Momose (`hiyori`)**: `Hiyori.model3.json`, `Hiyori.moc3`, `Hiyori.physics3.json`, `Hiyori.pose3.json`, `Hiyori.cdi3.json`, atlas `Hiyori.2048/texture_00.png` & `texture_01.png`, e `motions/`.
    2. **Haru Greeter (`haru`) / Mao (`mao`)**: segundo preset de personagem anime VTuber selecionável na aba **Aparência** para demonstrar troca instantânea de modelo Live2D.
  - Suporte também a qualquer URL `.model3.json` customizada ou importação de modelo pelo usuário.
- **Injeção de Parâmetros no Cubism Core (`beforeModelUpdate`):**
  - A cada frame do ticker WebGL, `Live2DWebGLStage` escuta `internalModel.on('beforeModelUpdate')` e escreve diretamente no `coreModel`:
    - `ParamAngleX`, `ParamAngleY`, `ParamAngleZ` (rastreamento suave do mouse + sacadas)
    - `ParamBodyAngleX`, `ParamBodyAngleY`, `ParamBodyAngleZ` (inclinação corporal ligada à cabeça)
    - `ParamEyeLOpen`, `ParamEyeROpen`, `ParamEyeLSmile`, `ParamEyeRSmile` (auto-blink multiplicativo + sorriso ocular)
    - `ParamEyeBallX`, `ParamEyeBallY` (olhar direcional)
    - `ParamBrowLY`, `ParamBrowRY`, `ParamBrowLAngle`, `ParamBrowRAngle` (expressão emocional das sobrancelhas)
    - `ParamMouthOpenY`, `ParamMouthForm` (lip-sync acústico Goertzel `A, E, I, O, U, S` em tempo real)
    - `ParamCheek`, `ParamBreath` (rubor afetivo e respiração assimétrica)
  - Como a injeção ocorre em `beforeModelUpdate`, o solver `.physics3.json` do Cubism 4 calcula automaticamente o balanço secundário de todas as mechas de cabelo, laços e roupas em resposta ao movimento da cabeça!
- **Fallback Seguro para Testes Headless (JSDOM / SSR):**
  - Como o Vitest roda em `jsdom` (sem contexto WebGL nativo), `Live2DWebGLStage` detecta ausência de WebGL (`!hasWebGLSupport()`) e degrada graciosamente mantendo os atributos de telemetria (`data-testid="live2d-webgl-stage"`, `data-live2d-model-url`, `data-testid="live2d-parameter-hud"`), enquanto no navegador real / Electron renderiza o canvas WebGL completo a 60 FPS.

### 3.2. Motor 2: Anime PNGTuber de Sprites Pintados (`mode === 'tachie'`)
- **Remoção Total do Boneco Geométrico:**
  - Todas as tags `<ellipse>`, `<circle>`, `<line>` e `<path>` que desenhavam rosto/cabelo/olhos/boca geométricos em `AshyStageCanvas.tsx` e `renderTachieStageToCanvas` são removidas.
- **Conjunto de Sprites de Anime Pintados Reais (`apps/desktop/public/assets/default-avatar/sprites/`):**
  - Geramos e empacotamos um conjunto consistente de sprites de anime de alta resolução da Ashy (*Cozy Night Studio*) para os estados reais de PNGTuber:
    - `ashy-eyes-open-mouth-closed.png` (repouso / escuta)
    - `ashy-eyes-open-mouth-open.png` (fala ativa / vogais abertas)
    - `ashy-eyes-open-mouth-smile.png` (fala suave / vogais sorridentes `E/I` e alegria)
    - `ashy-eyes-closed-mouth-closed.png` (piscada em repouso)
    - `ashy-eyes-closed-mouth-open.png` (piscada falando / risada)
    - `ashy-concerned.png` (expressão empática / preocupada — Seriousness Gate)
- **Física VTuber PNGTuber (Estilo *Veadotube Mini*):**
  - **Troca Instantânea de Sprites Reais:** Guiada por `resolvedLayers.eyeState` (`open`, `closed`, `happy_arc`, `wink`) e `resolvedLayers.activeViseme` (`closed`, `A`, `E`, `I`, `O`, `U`, `S`).
  - **Squash-and-Stretch Vocal:** Quando `isSpeaking` e `mouthOpen > 0.08`, aplica compressão horizontal e estiramento vertical elástico (`scaleX = 1 - vocalBounce * 0.025`, `scaleY = 1 + vocalBounce * 0.035`, `translateY = -vocalBounce * 9px`) sincronizado à energia fonética do áudio.
  - **Respiração + Paralaxe de Olhar + Rim Light Reativo à Voz:** Quando a Ashy fala, um brilho de contorno (*rim glow*) âmbar/violeta pulsa suavemente na intensidade da voz.

### 3.3. Contrato Extensível para VRM Futuro (`StageRendererMode`)
- Em `@ashy/shared` (`host-protocol.ts`), definimos `StageAvatarMode = 'tachie' | 'live2d' | 'vrm'` (mantendo `'tachie'` e `'live2d'` ativos na UI atual e deixando o adaptador `StageEngineAdapter` preparado para plugar `@pixiv/three-vrm` na fase futura sem refatoração estrutural).

---

## 4. Critérios de Aceitação e Verificação Visual

1. **Zero Formas Geométricas Amadoras:** Nem o modo `Ilustração viva (PNGTuber)` nem o modo `Malha Live2D (Cubism 4 WebGL)` exibem círculos/elipses vetoriais desenhados sobre o rosto.
2. **Live2D WebGL Real Funcionando no Navegador:** Ao selecionar `Malha Live2D` na aba **Aparência** ou no **Stage Overlay**, o canvas WebGL do PixiJS + `pixi-live2d-display` carrega e anima um modelo `.moc3` real de anime (**Hiyori Momose** / **Haru Greeter**), respondendo ao movimento do mouse, piscando, respirando, movendo mechas de cabelo com física `.physics3.json` e abrindo/modulando a boca durante o teste de Lip-Sync Acústico & `<|ACT|>`.
3. **PNGTuber Anime Real Funcionando no Navegador:** Ao selecionar `Ilustração viva (PNGTuber)`, a Ashy alterna suavemente entre os sprites de anime pintados (piscada, boca fechada/aberta/sorrindo, expressão preocupada) com *squash-and-stretch* de VTuber ao falar.
4. **Suíte Automatizada + Playwright:** Todos os testes unitários/integração (`pnpm test`), `pnpm verify:wireback`, `pnpm typecheck`, `pnpm build` e inspeção visual em navegador real via Playwright (com screenshots verificados) passam sem erros.
