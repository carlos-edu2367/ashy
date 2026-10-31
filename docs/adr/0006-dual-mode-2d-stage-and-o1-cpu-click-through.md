# ADR-0006: Palco 2D Dual-Mode (Tachie + Cubism 4 Live2D), Lip-Sync Acústico, Iluminação Oklab e Click-Through Desktop em CPU $O(1)$

- **Status:** Accepted
- **Date:** 2026-10-31
- **Milestone:** M3 — Corpo Digital e Presença & Fase 8.4 — Palco Universal 2D

---

## Context

Para que a Ashy tenha presença viva no desktop sem exigir GPUs dedicadas pesadas nem bloquear o uso normal das janelas de trabalho do usuário, o palco 2D precisa resolver quatro desafios técnicos:
1. **Universalidade de Avatar:** Suportar tanto ilustrações em camadas leves (**Tachie Layered PNG/SVG**) quanto modelos completos **Live2D Cubism 4 (`.model3.json`)** dirigidos pelos mesmos sinais emocionais `<|ACT|>` e formantes de voz.
2. **Articulação Labial Natural:** Lip-sync baseado apenas em volume RMS gera o efeito "boca de marionete" (abre e fecha sem distinguir vogais); já a troca brusca de visemas gera flicker visual.
3. **Click-Through Transparente sem Engasgos de GPU:** Em uma janela `BrowserWindow` transparente e `alwaysOnTop`, chamar `gl.readPixels` a cada `mousemove` para descobrir se o cursor está sobre um pixel opaco ou transparente trava o barramento GPU $\leftrightarrow$ CPU.
4. **Conforto Visual Noturno:** Mudanças de iluminação ambiente no espaço sRGB distorcem matizes, e medir o brilho da própria janela da Ashy causaria um loop de auto-realimentação luminosa.

## Decision

1. **Palco Universal Dual-Mode (`@ashy/stage` + `AshyStageCanvas.tsx` + `Live2DWebGLStage.tsx`):**
   - Unificamos o estado e a renderização do avatar em todas as superfícies da aplicação (Estúdio, Sidebar, Pré-visualização de Ajustes e Janela Flutuante `Stage Overlay`), sincronizados em tempo real via IPC/SSE pelo Host.
   - O modo **Live2D Cubism 4** carrega arquivos `.model3.json` (presets nativos `hiyori`, `haru`, `mao` ou URL customizada), inspeciona parâmetros/expressões/motions (`live2d-inspector.ts`) e aplica `model.expression(...)`, `model.motion(...)` e olhar (`gazeTarget`) em WebGL.
   - O modo **Tachie em Camadas** compõe corpo, olhos (`open`/`half`/`closed`/`wink`), sobrancelhas para os 13 estados emocionais, visemas de boca e acessórios com física de mola semi-implícita a `120 Hz`, auto-blink multiplicativo (`BLINK_THRESHOLD = 0.15`) e saccades empíricas.

2. **Lip-Sync Acústico *Winner + Runner-Up* (`lip-sync.ts`):**
   - Os formantes do áudio de voz alimentam os pesos vocálicos (`A, E, I, O, U, S` + `rawVolume`).
   - O driver seleciona o visema dominante (*Winner*) e o segundo colocado (*Runner-Up*), aplicando cessão dinâmica e suavização assimétrica de ataque/decaimento para transições labiais orgânicas tanto no Tachie quanto nos parâmetros `ParamMouthOpenY` / `ParamMouthForm` do Live2D.

3. **Iluminação Ambiente Perceptual em Oklab e *Retinal Light Squint* (`lighting.ts`):**
   - Toda modulação de luz ambiente ocorre no espaço perceptual **Oklab/OKLCH** com exclusão da própria região do palco para impedir auto-realimentação.
   - Sob alta luminância ambiente, o driver aplica um sutil *Retinal Light Squint* (contração natural das pálpebras e pupila).

4. **Click-Through Desktop em CPU $O(1)$ via Bitmask `64x64` (`hit-test.ts`):**
   - O palco mantém em CPU uma grade de silhueta compacta de **`64x64` bits** (`Uint32Array`) atualizada em baixa frequência a partir do bounding/alfa da silhueta do avatar e das regiões de UI interativa.
   - A cada movimento do cursor na janela `Stage Overlay`, o teste de colisão consulta o bit correspondente em **$O(1)$ puramente em CPU** (`isPointOpaqueInMask`) e aciona `overlayWindow.setIgnoreMouseEvents(!isHit, { forward: true })`, permitindo que cliques em áreas transparentes atravessem instantaneamente para as janelas de baixo.

## Consequences

### Positivas
- **Zero gargalo de `readPixels` no movimento do mouse:** O teste de click-through leva nanossegundos em CPU e mantém o desktop 100% responsivo.
- **Mesmo contrato comportamental:** Trocar entre Tachie e qualquer modelo Live2D `.model3.json` preserva exatamente as mesmas reações `<|ACT|>`, piscadas, olhar e lip-sync.

### Negativas / Trade-offs
- A resolução `64x64` da máscara de click-through aproxima as bordas finas (como fios de cabelo soltos) em células discretas, o que na prática é imperceptível e desejável para estabilidade do clique.

## Codebase References
- `packages/stage/src/lip-sync.ts`
- `packages/stage/src/blink-saccade.ts`
- `packages/stage/src/spring-120hz.ts`
- `packages/stage/src/lighting.ts`
- `packages/stage/src/hit-test.ts`
- `packages/stage/src/live2d-inspector.ts`
- `apps/desktop/src/components/AshyStageCanvas.tsx`
- `apps/desktop/src/components/Live2DWebGLStage.tsx`
- `apps/desktop/src/main/index.ts`
