<div align="center">

<img src="apps/desktop/public/assets/ashy-hero.jpg" alt="Ashy — Companheira Virtual" width="220" style="border-radius: 28px; box-shadow: 0 20px 50px rgba(16, 185, 129, 0.35); border: 2px solid #10b981;" />

# ✨ ASHY 1.0 — Edição em Português (BR) ✨
### **Companheira Virtual Local-First com História Compartilhada, Afeto em 4 Camadas, Voz Omni em Tempo Real e Palco 2D Universal**

[![🏠 README Principal (Bilíngue)](https://img.shields.io/badge/🏠_Voltar-README.md-10b981?style=for-the-badge)](./README.md)
[![🇺🇸 Switch to English](https://img.shields.io/badge/🇺🇸_Language-README.en.md-6366f1?style=for-the-badge)](./README.en.md)
[![📘 Guia do Usuário](https://img.shields.io/badge/📘_Guia_do_Usuário-USER__GUIDE-3b82f6?style=for-the-badge)](./docs/USER_GUIDE.md)
[![🤖 Guia de Provedores](https://img.shields.io/badge/🤖_IA_Local_&_Cloud-PROVIDER__GUIDE-8b5cf6?style=for-the-badge)](./docs/PROVIDER_GUIDE.md)

</div>

---

## 🌟 O que torna a Ashy 1.0 única

**Ashy 1.0 (Marco M5 — Release 1.0)** é uma companheira virtual *local-first* para desktop (**Windows, macOS e Linux**) que **constrói, preserva e expressa uma história compartilhada** com você — e **continua reconhecível mesmo quando o modelo principal de linguagem (LLM) é trocado**.

- **6 Memórias com Proveniência Obrigatória (`source_episode_ids`) + FSRS-6:** Episódica, Semântica (`Predict -> Calibrate`), Autobiográfica (`Nossa História`), Piadas Internas (`CooldownLock`), Prospectiva e Hábitos no SQLite local (`ashy.db`).
- **Portabilidade da Alma (`.ashy-soul`) & Gate M2:** Prompt amigável a KV-Cache (`voice.md` + *Golden Dialogue Exemplars*), exportação/importação `.ashy-soul` verificada por `SHA-256` e **Apagar Tudo com 1 Clique (Factory Reset)**.
- **Modo Omni Unificado (`LFM3-Omni-2B`) & Voz em Tempo Real:** Suporte a 1 único modelo local (`ollama run lfm3-omni:2b` ou `llama-server` com áudio 16kHz in &rarr; 24kHz `LiquidCodec` out + vídeo a `2 fps` `dHash` e `think: false`), além de modo Cloud/Modular (Whisper, Kokoro-FastAPI, Piper, ElevenLabs, OpenRouter, Anthropic, OpenAI, NVIDIA NIM).
- **Palco 2D Dual-Mode & Overlay $O(1)$ Click-Through:** **Live2D Cubism 4 (`.model3.json`)** + **Tachie em camadas**, lip-sync acústico formante (`A, E, I, O, U, S`) e janela transparente `alwaysOnTop` com máscara `64x64` em CPU $O(1)$.
- **Agência MCP em 3 Níveis & Segurança:** 3 meta-tools progressivas, `ActionGatekeeper` (`observe-only`, `read-safe`, `staged-confirm`), criptografia em repouso `AES-256-GCM` e 6 atalhos globais (`Ctrl+Shift+M/E/D/H/Space/K`).

## 📦 Pacotes do Monorepo

- `@ashy/shared` · `@ashy/bus` · `@ashy/llm` · `@ashy/cortex` · `@ashy/voice` · `@ashy/stage` · `@ashy/agency` · `@ashy/evals` · `apps/desktop` (`@ashy/desktop`)

## ⚡ Quickstart

```bash
pnpm install
pnpm dev
pnpm build
pnpm --filter @ashy/desktop pack:dir
pnpm test
pnpm typecheck
pnpm eval:m2
pnpm test:e2e
```

## 📚 Links da Documentação
- [Guia do Usuário (`docs/USER_GUIDE.md`)](./docs/USER_GUIDE.md)
- [Guia de Provedores e IA Local (`docs/PROVIDER_GUIDE.md`)](./docs/PROVIDER_GUIDE.md)
- [Especificação de Arquitetura (`docs/ASHY_ARCHITECTURE_SPEC.md`)](./docs/ASHY_ARCHITECTURE_SPEC.md)
- [Roadmap por Fases (`docs/ASHY_ROADMAP.md`)](./docs/ASHY_ROADMAP.md)
- [Architecture Decision Records (`docs/adr/0001..0007`)](./docs/adr/)
