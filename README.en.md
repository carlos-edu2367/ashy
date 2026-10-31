<div align="center">

<img src="apps/desktop/public/assets/ashy-hero.jpg" alt="Ashy — Virtual Companion" width="220" style="border-radius: 28px; box-shadow: 0 20px 50px rgba(99, 102, 241, 0.35); border: 2px solid #6366f1;" />

# ✨ ASHY 1.0 — English Edition ✨
### **Local-First Virtual Companion with Shared History, Persistent 4-Tier Affect, Realtime Omni Voice & Universal 2D Stage**

[![🏠 Main Bilingual README](https://img.shields.io/badge/🏠_Back_to-README.md-6366f1?style=for-the-badge)](./README.md)
[![🇧🇷 Mudar para Português](https://img.shields.io/badge/🇧🇷_Idioma-README.pt--BR.md-10b981?style=for-the-badge)](./README.pt-BR.md)
[![📘 User Guide](https://img.shields.io/badge/📘_User_Guide-USER__GUIDE-3b82f6?style=for-the-badge)](./docs/USER_GUIDE.md)
[![🤖 Provider Guide](https://img.shields.io/badge/🤖_Local_&_Cloud_AI-PROVIDER__GUIDE-8b5cf6?style=for-the-badge)](./docs/PROVIDER_GUIDE.md)

</div>

---

## 🌟 What Makes Ashy 1.0 Unique

**Ashy 1.0 (Milestone M5 — Release 1.0)** is a *local-first* desktop digital companion (**Windows, macOS, and Linux**) engineered to **build, preserve, and express a shared history** with you — while **remaining recognizable when the underlying LLM is swapped**.

- **6-Layer Memory with Mandatory Provenance (`source_episode_ids`) + FSRS-6:** Episodic, Semantic (`Predict -> Calibrate`), Autobiographical (`Our Story`), Inside-Joke Motifs (`CooldownLock`), Prospective Intents, and User Habits stored in local SQLite (`ashy.db`).
- **Soul Portability (`.ashy-soul`) & M2 Eval Gate:** KV-Cache-friendly prompt composer (`voice.md` + *Golden Dialogue Exemplars*), `SHA-256`-verified `.ashy-soul` export/import, and atomic **1-Click Factory Reset**.
- **Unified Omni Mode (`LFM3-Omni-2B`) & Realtime Voice:** Run a single local multimodal model (`ollama run lfm3-omni:2b` or `llama-server` with direct 16kHz audio in &rarr; 24kHz `LiquidCodec` audio out + `2 fps` `dHash` video frames and `think: false`), or combine modular Cloud/Local STT, LLM, and TTS providers.
- **Dual-Mode 2D Stage & $O(1)$ Click-Through Overlay:** **Live2D Cubism 4 (`.model3.json`)** + **Layered Tachie**, formant lip-sync (`A, E, I, O, U, S`), and a transparent `alwaysOnTop` floating overlay with $O(1)$ CPU `64x64` silhouette hit-testing.
- **3-Tier MCP Agency & Security Hardening:** Progressive MCP discovery via 3 meta-tools, `ActionGatekeeper` (`observe-only`, `read-safe`, `staged-confirm`), optional `AES-256-GCM` encryption at rest, and 6 global OS shortcuts (`Ctrl+Shift+M/E/D/H/Space/K`).

## 📦 Monorepo Packages

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

## 📚 Documentation Links
- [End-User Guide (`docs/USER_GUIDE.md`)](./docs/USER_GUIDE.md)
- [Provider & Local AI Guide (`docs/PROVIDER_GUIDE.md`)](./docs/PROVIDER_GUIDE.md)
- [Architecture Specification (`docs/ASHY_ARCHITECTURE_SPEC.md`)](./docs/ASHY_ARCHITECTURE_SPEC.md)
- [Phased Roadmap (`docs/ASHY_ROADMAP.md`)](./docs/ASHY_ROADMAP.md)
- [Architecture Decision Records (`docs/adr/0001..0007`)](./docs/adr/)
