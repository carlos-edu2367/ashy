# ASHY — Virtual Companion with Shared History, Persistent Affect & Realtime Voice

> *"A Ashy não precisa lembrar de tudo. Precisa lembrar do que importa.*
> *Não precisa falar o tempo inteiro. Precisa saber quando faz sentido falar.*
> *Não precisa concordar com tudo. Precisa ter uma voz reconhecível.*
> *Não precisa fingir que é humana. Precisa ser uma boa companheira digital.*
> *E, acima de tudo, não deve evoluir simplesmente porque o tempo passou — deve evoluir porque alguma experiência significativa aconteceu."*

---

## Visão Geral

**Ashy** é uma companheira virtual *local-first* com voz em tempo real, corpo digital animado (Dual-Mode 2D: Live2D Cubism 4 & Tachie Layered PNG) e um córtex cognitivo (**Ashy Cortex**) projetado para construir, preservar e expressar uma **história compartilhada** com o usuário — mantendo sua identidade e suas referências mesmo quando o modelo principal de linguagem (LLM) é trocado.

### Arquitetura do Monorepo

- **`packages/shared`** (`@ashy/shared`): Contratos canônicos (Valibot), 13 estados emocionais, modelos das 6 memórias, vetores afetivos 4-camadas e segmentador de grafemas UTF-8 (`clustr`).
- **`packages/bus`** (`@ashy/bus`): Container de Injeção de Dependências funcional com ordenação topológica (`injeca`-style) + Barramento IPC/Worker/WS tipado com orçamento de saltos (`hopsRemaining = 32`), deduplicação LRU e `lifetimeController` (`eventa`-style).
- **`packages/llm`** (`@ashy/llm`): Mini-SDK de LLM orientado a protocolo (`streamText` / `generateText`), parser incremental de marcadores `<|ACT|>`, `<|DELAY|>`, `<|CALLBACK|>` com retenção de cauda, categorizador `<think>` e ancoragem por sentinela `\uE000`.
- **`packages/cortex`** (`@ashy/cortex`): Coração cognitivo sobre SQLite local (`ashy.db` com `FTS5` BM25 + busca vetorial + **RRF** + curva de esquecimento **FSRS-6** com piso de *Flashbulb Memory*), motor de **Piadas Internas** com *Cooldown Anti-Saturação*, motor afetivo em 4 escalas temporais com *Seriousness Gate*, consolidação ociosa **Dream & Reflection (`Predict -> Calibrate`)** e **Soul Portability** (KV-Cache-friendly prompt composer + *Golden Dialogue Exemplars*).
- **`packages/voice`** (`@ashy/voice`): Pipeline de áudio em tempo real com Ring Buffer (`360ms` `HistoryLease`), Turn-Taking humano (`VoiceEndJudge` aos `1200ms` com *Compare-And-Swap* + `3000ms` grace period + `SpeculativeRephrase` aos `600ms`), `MarkdownSegmenter`, *TTFA Boost Chunker* (`4..12` palavras nos 2 primeiros chunks), fila paralela 4x reordenada, agendamento *gapless* e **Barge-In em 2 fases** com `PlaybackReceipt`.
- **`packages/stage`** (`@ashy/stage`): Palco 2D Dual-Mode (Tachie em camadas + Live2D), driver acústico de Lip-Sync *Winner + Runner-Up* (`A, E, I, O, U` com cessão dinâmica de visemas), Auto-Blink multiplicativo (`BLINK_THRESHOLD = 0.15`), Saccades empíricas, mola semi-implícita a `120 Hz`, iluminação ambiente sem auto-realimentação em **Oklab**, *Retinal Light Squint* e **Click-Through Desktop em CPU $O(1)$**.
- **`packages/agency`** (`@ashy/agency`): Controles físicos de privacidade (*Mic*, *Eyes*, *DND*), filtro perceptual dHash 64-bit, *Progressive MCP Discovery* (3 meta-tools) e **Action Gatekeeper** (`Observe != Prepare != Execute`) com `action_audit_log`.
- **`apps/desktop`** (`@ashy/desktop`): Aplicação React 19 + Electron + Tailwind/OKLCH com **Stage Overlay** (avatar flutuante transparente) e **Companion Hub** (*Our Story*, *Memory & Inside-Jokes Inspector*, *Personality & Dream Center*, *Ashy's Room* e *MCP Consent Center*).

---

## Documentação de Engenharia e Design

- [Contexto e Visão do Produto (`docs/ASHY_PROJECT_CONTEXT.md`)](./docs/ASHY_PROJECT_CONTEXT.md)
- [Especificação de Arquitetura (`docs/ASHY_ARCHITECTURE_SPEC.md`)](./docs/ASHY_ARCHITECTURE_SPEC.md)
- [Plano de Implementação TDD (`docs/superpowers/plans/2026-10-28-ashy-v1-foundation.md`)](./docs/superpowers/plans/2026-10-28-ashy-v1-foundation.md)
- [Estudo de Caso Forense: Ecossistema `moeru-ai` (`docs/MOERU_AI_CASE_STUDY.md`)](./docs/MOERU_AI_CASE_STUDY.md)
- [Blueprint de Receitas Absorvidas e Corrigidas (`docs/MOERU_AI_ABSORPTION_RECIPES.md`)](./docs/MOERU_AI_ABSORPTION_RECIPES.md)
