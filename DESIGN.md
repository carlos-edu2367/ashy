# Ashy — Cozy Night Studio Design System (`DESIGN.md`)

> **Aesthetic Direction:** *Intimate Nocturnal Editorial Companion*  
> **Visual World:** A warm, rain-kissed midnight study lit by desk lamps, amber candlelight, and soft lavender city reflections. Ashy is never presented as a cold engineering dashboard or a robotic control panel; she is a living, attentive presence who shares a history, inside jokes, and quiet moments with you on your computer.

---

## 1. Core Philosophy & Human Language Principles

1. **Warmth Over Telemetry:** Never expose raw database terminology (`FSRS-6`, `retrievability R`, `stability S`, `seriousness gate`, `MCP Tier 3`, `SQLite`) as primary user-facing headlines. Translate every technical capability into warm, intuitive Portuguese (`"O que fica com a gente"`, `"Uma piada nossa"`, `"No seu ritmo"`, `"Pedir aprovação antes de executar"`), while preserving underlying inspectability and interactive power.
2. **Editorial Nocturnal Calm:** Pair high-character editorial serif display headings (`Cormorant Garamond`) with crisp, legible humanist sans-serif UI text (`Plus Jakarta Sans`).
3. **Single-Declaration Elevation:** Surfaces separate through warm obsidian-plum luminance steps (`#111017` → `#16141f` → `#1d1a27` → `#252132`) and delicate `1px` warm ivory-peach borders (`rgba(255, 232, 220, 0.08)`). Active or selected cards earn a warm peach border (`rgba(244, 166, 136, 0.55)`) with a subtle ambient glow.
4. **Local-First Intimacy:** Reinforce trust quietly in footers and status pills (`"Voz local"`, `"Modelo no seu computador"`, `"Suas memórias ficam neste dispositivo. ✦ Local primeiro. Sempre nossa."`).

---

## 2. Color Palette & Surface Tokens

### Surfaces (Warm Obsidian-Plum Hierarchy)
| Token | Hex | OKLCH Equivalent | Role |
| :--- | :--- | :--- | :--- |
| `--bg-window` | `#111017` | `oklch(0.17 0.018 290)` | Outer desktop window frame & sidebar backdrop |
| `--bg-canvas` | `#15131d` | `oklch(0.19 0.020 290)` | Main view canvas background |
| `--surface-card` | `#1c1926` | `oklch(0.22 0.022 292)` | Primary cards, chat panel, inspector drawer, settings groups |
| `--surface-elevated` | `#242031` | `oklch(0.26 0.026 292)` | Inner boxed rows, message bubbles, inputs, hover states |
| `--surface-control` | `#2c273b` | `oklch(0.30 0.030 292)` | Dropdowns, secondary buttons, inactive switches |
| `--surface-glass` | `rgba(23, 20, 31, 0.82)` | `oklch(0.20 0.022 290 / 0.82)` | Floating voice dock & stage status pills (`backdrop-filter: blur(16px)`) |

### Accents & Semantic Status
| Token | Hex | OKLCH Equivalent | Role |
| :--- | :--- | :--- | :--- |
| `--accent-peach` | `#f4a688` | `oklch(0.79 0.115 42)` | Primary warm peach-apricot accent (CTAs, active toggles, mic button, active borders) |
| `--accent-peach-bright` | `#f7b69c` | `oklch(0.83 0.098 42)` | Hover highlight & gradient top stop for primary buttons |
| `--accent-peach-deep` | `#e88d6b` | `oklch(0.73 0.135 38)` | Active press state & gradient bottom stop |
| `--accent-lavender` | `#cfc5e8` | `oklch(0.84 0.055 295)` | Secondary soft lavender-silver accent (tags, waveform blend, Ashy hair motif) |
| `--status-emerald` | `#5cd696` | `oklch(0.79 0.145 155)` | Online/local presence dot (`"Por aqui, com você"`, `"Voz local"`) |
| `--status-amber` | `#f2be79` | `oklch(0.83 0.115 75)` | Gentle cooldown / attention indicator |
| `--status-danger` | `#d96b70` | `oklch(0.66 0.145 20)` | Destructive action outline & text (`"Excluir"`) |

### Typography Colors & Borders
| Token | Value | Contrast vs `#15131d` | Role |
| :--- | :--- | :--- | :--- |
| `--text-primary` | `#f6f2fa` | `16.4 : 1` | Display titles, headings, active labels, message copy |
| `--text-secondary` | `#b8b0c8` | `8.6 : 1` | Subtitles, card descriptions, settings explanations |
| `--text-muted` | `#877f99` | `4.7 : 1` | Timestamps, dates, placeholders, footer captions |
| `--text-on-peach` | `#19141f` | `10.8 : 1` (vs `#f4a688`) | High-contrast dark plum ink on warm peach buttons/pills |
| `--border-subtle` | `rgba(255, 232, 220, 0.08)` | — | Hairline `1px` structural dividers and card outlines |
| `--border-soft` | `rgba(255, 232, 220, 0.14)` | — | Input borders, secondary buttons, pill outlines |
| `--border-active` | `rgba(244, 166, 136, 0.58)` | — | Selected memory card, active filter ring, focused input |

---

## 3. Typography System

### Font Families
- **Display & Editorial Serif (`--font-serif`):**  
  `'Cormorant Garamond', 'Newsreader', 'Playfair Display', Georgia, serif`
- **Humanist UI & Body Sans (`--font-sans`):**  
  `'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
- **Technical / Path Metadata (`--font-mono`):**  
  `'JetBrains Mono', 'Cascadia Code', monospace` (used sparingly for model IDs or shortcuts)

### Typographic Scale
| Element | Class | Font | Size | Weight | Line Height | Tracking |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Hero Stage Greeting** (`"Bom te ver, Carlos."`) | `.ashy-serif-hero` | `--font-serif` | `42px` (`2.625rem`) | `600` | `1.12` | `-0.02em` |
| **Page Header Title** (`"O que fica com a gente"`, `"Do seu jeito"`) | `.ashy-serif-title` | `--font-serif` | `38px` (`2.375rem`) | `600` | `1.14` | `-0.02em` |
| **Panel / Drawer Title** (`"Nossa conversa"`, `"Pré-visualização"`) | `.ashy-serif-panel` | `--font-serif` | `26px` (`1.625rem`) | `600` | `1.2` | `-0.015em` |
| **Brand Wordmark** (`"ashy"`) | `.ashy-brand-wordmark` | `--font-serif` | `26px` (`1.625rem`) | `600` | `1.0` | `-0.01em` |
| **Card Title** (`"O fantasma no backend"`, `"Presença no desktop"`) | `.ashy-card-heading` | `--font-sans` | `15px` (`0.9375rem`) | `600` | `1.35` | `-0.01em` |
| **Body / Message Copy** | `.ashy-body` | `--font-sans` | `13.5px` (`0.84375rem`) | `400` | `1.55` | `0` |
| **UI Control / Nav Label** | `.ashy-nav-item`, `.ashy-btn` | `--font-sans` | `13.5px` (`0.84375rem`) | `500–600` | `1.25` | `0` |
| **Metadata / Date / Caption** | `.ashy-meta` | `--font-sans` | `12px` (`0.75rem`) | `400–500` | `1.4` | `0.01em` |

---

## 4. Layout & Component Blueprints

### Global Shell (`.ashy-window`)
- **Structure:** Full-viewport desktop studio frame (`100vw × 100vh`, `min-height: 760px`) with subtle top-right window chrome controls (`—`, `□`, `×`).
- **Grid:** `212px` fixed Left Sidebar (`.ashy-sidebar`) + `1fr` Main Content Area (`.ashy-main`).
- **Left Sidebar (`.ashy-sidebar`):**
  1. **Brand Header (`.ashy-brand`):** Warm peach 4-point star + secondary sparkle SVG icon (`#f4a688`) + lowercase serif `"ashy"`.
  2. **Primary Navigation (`.ashy-nav`):** 5 vertical items (`Companhia`, `Memórias`, `Nossa história`, `Aparência`, `Configurações`).
     - Inactive item: `#b8b0c8` text & stroke icon, subtle hover tint.
     - Active item (`.ashy-nav-item.active`): Rounded container (`border-radius: 10px`), warm dark plum fill (`rgba(244, 166, 136, 0.11)`), `3px` vertical warm peach indicator bar on the left edge (`#f4a688`), warm peach icon, `#f6f2fa` text.
  3. **Companion Mini-Portrait (`.ashy-sidebar-portrait`):** Shown on non-stage views (`Memórias`, `Nossa história`, `Aparência`) at the bottom of the sidebar above the user profile, keeping Ashy visually present while browsing memories.
  4. **User Profile Footer (`.ashy-user-footer`):** Circular avatar for `Carlos` with emerald status dot, name `"Carlos"`, and warm subcaption `"Sempre por aqui. ♡"`.

---

### View 1: `Companhia` (Hero Stage + `"Nossa conversa"`)
- **Layout (`.ashy-companhia-layout`):** `1fr` Center Hero Stage + `400px` Right Conversation Panel separated by a `1px` border.
- **Center Hero Stage (`.ashy-hero-stage`):**
  - Full-bleed cozy nocturnal bedroom/study artwork & interactive Live2D/VRM stage canvas (`AshyStageCanvas`).
  - **Top-Left Greeting Overlay (`.ashy-stage-greeting`):**
    - `.ashy-serif-hero`: `"Bom te ver, Carlos."`
    - `.ashy-stage-presence`: Emerald dot (`#5cd696`) + `"Por aqui, com você."`
  - **Top-Right Runtime Pill (`.ashy-stage-pills`):**
    - Frosted glass pill showing `🎙️ Voz local ●` + `Modelo no seu computador` (clickable to switch or inspect local voice/LLM state).
  - **Bottom Floating Voice Dock (`.ashy-voice-dock`):**
    - Centered horizontally `24px` above bottom edge (`width: min(500px, 90%)`, `padding: 14px 28px`, `border-radius: 24px`).
    - Left action: Circular mute button (`.ashy-dock-circle-btn`) + `"Silenciar"`.
    - Center-left & center-right: Animated multi-bar audio waveform (`.ashy-waveform`) in warm peach & lavender.
    - Center hero action: `54px` warm peach circle button (`.ashy-mic-hero-btn`) with soft outer halo + `"Conversar por voz"`.
    - Right action: Circular eye-off button (`.ashy-dock-circle-btn`) + `"Esconder avatar"` (toggles floating overlay mode).
- **Right Conversation Panel (`.ashy-chat-panel`):**
  - **Header (`.ashy-chat-header`):** `"Nossa conversa"` + `⋯` options button + subtitle `"Uma companhia para os seus dias, pensamentos e devaneios."`
  - **Message Stream (`.ashy-chat-stream`):**
    - Outgoing user bubble (`.ashy-msg-user`): right-aligned, timestamp above (`21:14`), dark plum bubble + user avatar.
    - Incoming Ashy bubble (`.ashy-msg-ashy`): left-aligned, Ashy avatar + `Ashy 21:14`, warm-tinted plum bubble.
    - **Inline Callback Card (`.ashy-joke-card`):** Nested below Ashy's message when an inside joke or memory is referenced. Displays a book icon badge, `"Uma piada nossa"`, narrative explanation (`'Você e eu sempre brincamos com os "fantasmas" que aparecem no backend.'`), and right chevron `›` to open that memory in `Memórias`.
  - **Composer (`.ashy-chat-composer`):**
    - Rounded container at bottom of panel with textarea (`"O que está passando pela sua cabeça?"`), image attachment button on bottom-left, and circular warm peach send button (`36px`) on bottom-right.

---

### View 2: `Memórias` (`"O que fica com a gente"` + Bento Grid + Detail Drawer)
- **Top Header Bar (`.ashy-page-header`):**
  - Left: `.ashy-serif-title` `"O que fica com a gente"` + subtitle `"Lembranças que dão continuidade à nossa história."`
  - Right: Search input (`.ashy-search-box`: `"Buscar uma lembrança"`) + Primary peach button (`.ashy-peach-btn`: `"+ Nova memória"`).
- **Category Filter Pills (`.ashy-filter-pills`):**
  - Pill buttons: `Todas` (active peach fill with subtle outer halo border), `Momentos`, `Sobre você`, `Referências nossas`, `Planos`.
- **Main Content Split (`.ashy-memories-workspace`):**
  - **Left Bento Grid (`.ashy-bento-grid`):**
    - **Top Row (`.ashy-bento-row-top`):** `grid-template-columns: repeat(2, 1fr)` for featured memories (`"O fantasma no backend"`, `"Orin e Ashy"`).
    - **Bottom Row (`.ashy-bento-row-bottom`):** `grid-template-columns: repeat(3, 1fr)` for compact memories (`"Seu jeito de trabalhar"`, `"Primeira conversa"`, `"Retomar o protótipo"`).
    - **Memory Card Anatomy (`.ashy-memory-card`):**
      - Top header: Category icon badge + Card title + 2–3 line description (plus optional `"Plano"` lavender badge).
      - Center/Bottom visual: Custom cozy nocturnal illustration banner (`110px–135px` height, `border-radius: 10px`).
      - Footer: Human date (`"12 de outubro"`) + `⋯` button.
      - Selected state (`.ashy-memory-card.selected`): `1.5px solid #f4a688` border + warm ambient shadow.
  - **Right Detail Inspector Drawer (`.ashy-detail-drawer`, `340px` width):**
    - Top Hero Illustration of selected memory (`185px` height) with floating `⋯` button.
    - Serif Title (`22px`) + Origin metadata (`💬 Conversa de 12 de outubro`) + Memory retention/vividness indicator.
    - Inner narrative box (`.ashy-detail-story`) with multi-paragraph story.
    - Bottom action bar: Secondary button `[✏️ Editar lembrança]` + Danger outline button `[🗑️ Excluir]`.
- **Bottom Local-First Footer (`.ashy-memories-footer`):**
  - Left: `🔒 Suas memórias ficam neste dispositivo.`
  - Right: `✦ Local primeiro. Sempre nossa.`

---

### View 3: `Nossa história` (`"Nossa caminhada"`)
- **Header:** `.ashy-serif-title` `"Nossa caminhada"` + subtitle `"Os marcos, piadas internas e rituais que construímos juntos ao longo do tempo."`
- **Layout:**
  - **Top Bond Summary Strip:** Warm editorial cards showing shared chapters, active inside jokes (`"O fantasma no backend"` — pronta para surgir naturalmente ou descansando), and current emotional resonance.
  - **Left Column:** Chronological relational milestones timeline with warm date badges, narrative cards, and ability to record a new shared moment.
  - **Right Column:** Personality & tone harmony sliders (Afeto, Humor e Ironia, Energia Criativa, Curiosidade, Cuidado) expressed in warm human language, plus live preview of how Ashy speaks with you.

---

### View 4: `Aparência` (`"Presença e expressão"`)
- **Header:** `.ashy-serif-title` `"Presença e expressão"` + subtitle `"Escolha o clima do estúdio, as expressões da Ashy e como ela aparece na sua tela."`
- **Layout:**
  - **Left Interactive Stage Preview:** Live portrait & expression showcase with instant mood switching (`Serena`, `Curiosa`, `Brincalhona`, `Empolgada`, `Pensativa`, `Acolhedora`), eye-gaze tracking toggle, and voice lip-sync test.
  - **Right Customization Cards:**
    - Lighting & nocturnal ambiance selector (`Chuva na janela`, `Lâmpada âmbar de estudo`, `Meia-noite violeta`).
    - Avatar rendering mode (Live2D / VRM 1.0 + spring-bone physics softness).
    - Floating desktop overlay size & corner placement.

---

### View 5: `Configurações` (`"Do seu jeito"`)
- **Header:** `.ashy-serif-title` `"Do seu jeito"` + subtitle `"Você escolhe como a Ashy participa do seu dia."`
- **Sub-navigation Tabs (`.ashy-subtabs`):**
  - Horizontal tab bar with bottom border: `⚙️ Geral`, `🎙️ Voz`, `🧊 Modelos`, `🛡️ Privacidade`.
  - Active tab has warm peach icon, `#f6f2fa` text, and `2px` bottom indicator in `#f4a688`.
- **2-Column Workspace (`.ashy-settings-grid`):**
  - **Left Column (Settings Cards):**
    - Section 1: **Presença no desktop** (`Deixe a Ashy visível no seu ambiente de trabalho.`)
      - Inner boxed toggle row: **Mostrar avatar** + `.ashy-switch`.
      - **Microfone** (`Define quando a Ashy pode ouvir você.`) + `.ashy-select` (`Somente durante a conversa`).
      - **Acesso à tela** (`Permite que a Ashy observe o que está na sua tela, quando necessário.`) + `.ashy-switch` + `.ashy-select` (`Perguntar antes de observar`).
      - **Ações no computador** (`Permite que a Ashy execute ações, como abrir aplicativos ou organizar janelas.`) + `.ashy-switch` + `.ashy-select` (`Pedir aprovação antes de executar`).
      - **Horários de silêncio** (`A Ashy fica em silêncio neste período, a menos que você inicie a conversa.`) + compact `.ashy-select` (`22:00 — 08:00`).
    - Section 2: **Memórias** (`Suas memórias ficam salvas apenas no seu computador.`)
      - Inner boxed row: **Armazenamento local** + `.ashy-outline-btn` (`Gerenciar memórias`).
  - **Right Column (`.ashy-settings-aside`, `340px` width):**
    - **Pré-visualização Card (`.ashy-preview-card`):**
      - Serif title `"Pré-visualização"` + `"Assim a Ashy aparece no seu desktop."`
      - Miniature desktop frame (`.ashy-preview-frame`) showing Ashy in the corner with floating speech bubble `"Fico por aqui. No seu ritmo. ♡"`, circular waveform pill, and simulated taskbar (`21:14  12/05/2025`).
    - **Primary Save Button:** Full-width `.ashy-peach-btn.large` (`💾 Salvar preferências`).
    - **Footer Note:** `"Ashy é uma personagem de IA."`

---

## 5. Browser Surfaces, Motion & Accessibility Craft Floor

- **Selection:** `::selection` uses `rgba(244, 166, 136, 0.28)` background with `#fff8f5` text.
- **Scrollbars:** Custom `6px` slim scrollbars in `#14121b` track with `#332e44` thumb (`#f4a688` on hover).
- **Focus Rings:** `:focus-visible` uses a `2px solid rgba(244, 166, 136, 0.75)` outline with `2px` offset.
- **Motion Choreography:** Smooth exponential ease-out (`cubic-bezier(0.22, 1, 0.36, 1)`) for drawer transitions, tab switches, and waveform bar animations. Respects `prefers-reduced-motion: reduce`.
