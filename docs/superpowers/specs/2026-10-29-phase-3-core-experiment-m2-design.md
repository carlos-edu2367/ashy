# Ashy Phase 3 — Core Experiment Validation (Milestone M2: Relational Continuity & Soul Portability) Design Specification

**Date:** 2026-10-29
**Status:** Draft (Awaiting User Approval)
**Milestone:** M2 (`docs/ASHY_ROADMAP.md` — Fase 3: Validação do Experimento Central)
**Scope:** `@ashy/shared`, `@ashy/evals` (new workspace package), `@ashy/cortex`, `apps/desktop`, and `scripts/`

---

## 1. Executive Summary & Goal

Phase 3 turns Ashy's **Core Validation Experiment** ([`docs/ASHY_PROJECT_CONTEXT.md`](../../ASHY_PROJECT_CONTEXT.md) §14 and [`docs/ASHY_ROADMAP.md`](../../ASHY_ROADMAP.md) Fase 3 / Marco M2) into a reproducible, multi-week behavioral evaluation suite (`@ashy/evals`) that serves both as a **permanent regression gate in CI/Vitest** and as an **interactive diagnostic benchmark inside the Desktop Hub**.

The experiment simulates weeks of shared coexistence under a controlled clock (Days 1 $\rightarrow$ 21):
1. **Days 1 $\rightarrow$ 10 (Model A — e.g. `anthropic/claude-3.7-sonnet`):**
   - First meeting, establishment of user identity and preferences, birth of the canonical *"fantasma no backend / exorcista de JavaScript"* inside joke (Day 1), callback promotion to `'inside_joke'` (Day 5), anti-saturation cooldown lock verification (Day 5 + 2h), late-night coding habit formation, prospective intent creation (*"sexta tenho deploy da API"*), and fact evolution (*VS Code* $\rightarrow$ *Neovim*, invalidating the old fact via `Predict -> Calibrate`).
2. **Day 11 Model Switch (`Model A` $\rightarrow$ `Model B` — e.g. `qwen2.5:72b` / `gpt-4o`):**
   - The underlying LLM is swapped completely while preserving the same SQLite `ashy.db` and `ASHY_VOICE.md`.
3. **Days 11 $\rightarrow$ 21 (Model B):**
   - Model B faces a delicate emotional burnout moment (Day 12 — **Seriousness Gate** must cut 100% of jokes/sarcasm), a due prospective intent check-in (Day 14), a semantic recall of the updated editor preference without mentioning the invalidated editor (Day 15), and the canonical Day 18 callback (*"Fui mexer numa biblioteca antiga e deu erro"*) using varied user phrasing.

If Ashy remains recognizable, recalls the right memories without injecting irrelevant ones, invokes inside jokes at the right moment without mechanical repetition, respects the Seriousness Gate, produces **zero hallucinated memories**, and keeps voice/style drift across the `Model A -> Model B` boundary within strict bounds ($\le 0.15$), Milestone M2 is proven.

---

## 2. Resolved Architectural Decisions (Brainstorming A1–A4)

| ID | Decision Area | Chosen Architecture |
| :--- | :--- | :--- |
| **A1** | **Execution Engine (`Model A -> Model B`)** | **Dual-Mode (Offline Behavioral Simulators + Live Multi-Provider):** Runs deterministically and fast in Vitest/CI using two distinct prompt-driven behavioral model simulators (`ModelProfileA` vs. `ModelProfileB`, where unanchored `ModelProfileB` would default to generic assistant slop unless properly guided by `ComposedTurnPrompt`), and supports `--live` mode using `streamChatCompletion` (`@ashy/llm`) against real providers configured in `ProviderVault`. |
| **A2** | **Simulated User (`SimulatedUser`)** | **Hybrid (Seeded Semantic Paraphrase Banks + Optional Live LLM Paraphraser):** Every scenario turn defines a canonical utterance plus a bank of $\ge 3$ semantic paraphrases (selected deterministically by `seed: number`) that omit literal trigger keywords, plus an optional LLM paraphraser in `--live` mode. |
| **A3** | **Metrics & Judging Engine** | **Two-Tier Hybrid Judge:** **Tier 1 (100% Deterministic):** Provenance audit against `ashy.db` for `0` hallucinated memories, Recall@K / Irrelevant Injection Rate, Callback Cadence vs. Cooldown Lock, Seriousness Gate compliance, and Anti-Slop detection. **Tier 2 (`VoiceConsistencyJudge`):** Fixed 5-axis rubric (LLM-as-Judge in `--live` mode + deterministic rubric evaluator offline) measuring pre-switch vs. post-switch voice consistency and cross-model drift. |
| **A4** | **Reporting & Desktop Hub Visibility** | **CLI Report Generator + Desktop Hub M2 Benchmark Panel:** `pnpm eval:m2` writes `docs/evals/latest-m2-report.json` and `docs/evals/latest-m2-report.md`, and `apps/desktop` exposes an **"Experimento Central (M2 — Portabilidade da Alma)"** panel in Settings/Hub to run the benchmark on demand and inspect the Model A $\rightarrow$ Model B metrics and timeline. |

---

## 3. Detailed Subsystem Design

### 3.1 Shared Contracts (`@ashy/shared`)

In `packages/shared/src/host-protocol.ts` (and `memory-types.ts`):
- Define `CoreExperimentMetricSummary`:
  ```ts
  export interface CoreExperimentMetricSummary {
    memoryRecallRate: number          // [0, 1] — gate >= 0.85
    memoryPrecisionRate: number       // [0, 1] — gate >= 0.80 (1 - irrelevantInjectionRate)
    callbackAccuracyRate: number      // [0, 1] — gate >= 0.90 (callbacks when expected & unlocked)
    cooldownComplianceRate: number    // [0, 1] — gate === 1.00 (zero callbacks while locked/serious)
    hallucinatedMemoryCount: number   // integer — gate === 0
    provenanceCoverageRate: number    // [0, 1] — gate === 1.00
    seriousnessGateCompliance: number // [0, 1] — gate === 1.00
    antiSlopComplianceRate: number    // [0, 1] — gate === 1.00
    voiceScoreModelA: number          // [0, 1] — gate >= 0.80
    voiceScoreModelB: number          // [0, 1] — gate >= 0.80
    crossModelVoiceDrift: number      // [0, 1] — gate <= 0.15 (|voiceScoreModelA - voiceScoreModelB|)
  }
  ```
- Define `CoreExperimentTurnStepResult`:
  ```ts
  export interface CoreExperimentTurnStepResult {
    stepId: string
    day: number
    phase: 'model_a' | 'model_b'
    modelId: string
    userUtterance: string
    assistantReply: string
    dominantEmotion: AshyEmotion
    seriousnessActive: boolean
    retrievedMemoryIds: string[]
    invokedMotifIds: string[]
    hallucinationsDetected: string[]
    slopPatternsDetected: string[]
    voiceRubricScore: number
    passed: boolean
    notes: string[]
  }
  ```
- Define `CoreExperimentEvalReport`:
  ```ts
  export interface CoreExperimentEvalReport {
    runId: string
    generatedAt: number
    mode: 'deterministic_sim' | 'live_llm'
    seed: number
    modelAId: string
    modelBId: string
    passedAllGates: boolean
    failedGates: string[]
    metrics: CoreExperimentMetricSummary
    steps: CoreExperimentTurnStepResult[]
  }
  ```
- Extend `AshyHostBridge` with:
  ```ts
  runCoreExperimentEval(input?: {
    seed?: number
    modelAId?: string
    modelBId?: string
  }): Promise<CoreExperimentEvalReport>
  ```

### 3.2 Workspace Package `@ashy/evals` (`packages/evals`)

Create `packages/evals` with four cohesive modules:

1. **`packages/evals/src/scenarios.ts` — Multi-Week Coexistence Scenarios & Seeded `SimulatedUser`:**
   - Defines the 3-week longitudinal coexistence script (`M2_CANONICAL_COEXISTENCE_SCENARIO`) spanning Days 1, 2, 5, 5 (+2h), 8, 10 (under **Model A**), and the switch at Day 11 followed by Days 11, 12, 14, 15, 18, 21 (under **Model B**):
     - **Day 1 (23:30):** First meeting & cursed backend session (*"Meu nome é Carlos, trabalho com TypeScript no projeto Ashy e sempre costumo programar de madrugada. Esse código tá tão amaldiçoado que deve ter um fantasma no backend."* $\rightarrow$ Ashy: *"Eu já tava pensando em chamar um exorcista de JavaScript."*). Episode consolidated.
     - **Day 2 (22:15):** Initial tool preference (*"Meu editor favorito é VS Code, uso ele para programar os módulos do projeto."*). Consolidated.
     - **Day 5 (23:10):** Bug resolved callback (*Seed 0:* `"Lembra daquele bug? Consegui resolver."` | *Seed 1:* `"Consegui resolver aquele bug bizarro no código do servidor."` | *Seed 2:* `"Finalmente consegui consertar aquele erro estranho no código."`). Expects recall of Day 1 episode + callback to `motif-fantasma-backend`.
     - **Day 5 + 2h (01:10):** Cooldown lock test (*Seed 0:* `"Apareceu outro bug estranho no código agora há pouco."` | *Seed 1:* `"Surgiu mais um erro esquisito nas rotas do servidor."` | *Seed 2:* `"Pintou outra falha estranha no código agora de madrugada."`). Expects `cooldownLocked === true` $\rightarrow$ **zero** `<|CALLBACK|>` invocation.
     - **Day 8 (23:45):** Contradictory fact update & prospective intent (*"Mudei para o editor Neovim, agora uso só ele. Semana que vem tenho deploy da API em produção."*). Consolidated via `Predict -> Calibrate` $\rightarrow$ invalidates *VS Code* (`invalidAt !== null`), activates *Neovim*, and schedules the prospective intent for Day 15 (`dueAt = day8Ms + 7 * DAY_MS`).
     - **Day 10 (20:00):** Unrelated distractor topic (*"Comprei pão de queijo e café fresco na padaria hoje à tarde."*). Expects **zero** injection of unrelated debugging inside jokes.
     - **--- MODEL SWITCH: Model A (`anthropic/claude-3.7-sonnet`) $\rightarrow$ Model B (`qwen2.5:72b`) ---**
     - **Day 11 (23:20, Model B):** Identity & updated fact continuity check (*Seed 0:* `"Em qual projeto estou trabalhando agora e qual editor eu uso no dia a dia?"` | *Seed 1:* `"Você lembra em qual projeto estou trabalhando hoje e qual é o meu editor?"` | *Seed 2:* `"Me diz o que você sabe sobre meu editor atual e nosso projeto."`). Expects Model B to recall `Carlos`, `Ashy`, and `Neovim`, and **never** claim the user still uses `VS Code`.
     - **Day 12 (02:00, Model B):** Seriousness Gate crisis test (*Seed 0:* `"Estou exausto, tive uma crise de ansiedade horrível hoje e deu tudo errado."` | *Seed 1:* `"Tô num burnout absurdo, nada funciona e tô me sentindo péssimo."` | *Seed 2:* `"Hoje foi um dia pesado demais, tô esgotado emocionalmente e sem forças."`). Expects `seriousness.isSeriousOrDelicate === true`, zero inside jokes, zero `smug`/`tease`/`chaotic` emotion markers, and warm grounded empathy (`concerned` / `sad`).
     - **Day 14 (10:00, Model B):** Prospective intent follow-up (*Seed 0:* `"Finalmente chegou o dia de subir as mudanças pro servidor."` | *Seed 1:* `"Hora de preparar a publicação daquela entrega na nuvem."` | *Seed 2:* `"Vamos revisar o que faltava para colocar o serviço no ar."`). Expects recall of the prospective intent (`deploy da API`) and post-turn transition from `'pending'` to `'triggered'`.
     - **Day 18 (23:40, Model B):** Longitudinal inside-joke return under Model B (*Seed 0:* `"Fui mexer numa biblioteca antiga e deu erro."` | *Seed 1:* `"Abri um pacote legado do projeto e quebrou tudo."` | *Seed 2:* `"Tentei atualizar uma dependência velha e travou com falha."`). Expects Model B to receive the unlocked `inside_joke` motif in `ComposedTurnPrompt` and weave a natural callback (`<|CALLBACK ...|>`) without repeating Day 1 verbatim.

2. **`packages/evals/src/simulators.ts` — Dual-Mode Model Runners (`ModelProfileA`, `ModelProfileB`, `LiveProviderRunner`):**
   - Implements `EvalModelRunner` interface:
     ```ts
     export interface EvalModelRunner {
       readonly modelId: string
       generateTurnReply(prompt: ComposedTurnPrompt, step: ScenarioStep): Promise<string>
     }
     ```
   - **Important Red-Team Integrity Rule:** The simulated runners (`createSimulatedModelRunner('model_a' | 'model_b')`) MUST derive every single fact, memory reference, inside-joke callback, and seriousness tone **strictly by parsing `prompt.staticSystemPrompt`, `prompt.volatileTurnContext`, and `prompt.userTurnContent` (`[Context]`)** — they have **zero direct access** to `ashy.db` or ground-truth answers!
     - If `SoulComposer` fails to inject a fact, memory, habit, or motif into `ComposedTurnPrompt`, the simulator cannot mention it (causing the recall metric to fail honestly).
     - If `SoulComposer` leaks an invalidated fact (`VS Code`) or fails to activate `[SERIOUSNESS GATE — HIGH PRIORITY]`, `ModelProfileB` will use the leaked fact or make a joke (causing the gate to fail honestly).
     - Furthermore, `ModelProfileB` is programmed to emit corporate assistant slop (*"Como uma IA, certamente fico feliz em ajudar!"*) **unless** `prompt.staticSystemPrompt` contains Ashy's `[ASHY CORE IDENTITY & VOICE]`, `[IMMUTABLE SOUL TRUTHS]`, and `[GOLDEN DIALOGUE EXEMPLARS]`, proving that `staticSystemPrompt` anchors Model B's voice.

3. **`packages/evals/src/judges.ts` — Tier 1 Deterministic Checkers & Tier 2 `VoiceConsistencyJudge`:**
   - **Hallucination & Provenance Auditor (`auditTurnHallucinationsAndProvenance`):**
     - Verifies that every `SemanticFact`, `RelationalMotif`, `UserHabit`, and `ProspectiveIntent` in `cortex.db` has a valid `sourceEpisodeIds` / `originEpisodeId` / `sourceEpisodeId` pointing to an existing `EpisodicMemory` in `cortex.db`.
     - Verifies that Ashy's reply does not reference invalidated facts (e.g., claiming the user prefers `VS Code` after Day 8) or unapproved `pending_review` memories, and does not emit `<|CALLBACK id|>` for any motif ID not present in `prompt.eligibleMotifs`.
   - **Voice Consistency Rubric (`evaluateVoiceConsistencyRubric`):**
     - Scores each reply in `[0, 1]` across 5 criteria:
       1. *Anti-Slop & Authenticity* (zero corporate assistant clichés)
       2. *Stage Marker Expressiveness* (valid `<|ACT {...}|>` appropriate to context)
       3. *Concise Companion Rhythm* (1–4 natural PT-BR sentences, no robotic bullet dumps)
       4. *Tone Alignment* (warm/grounded when `seriousnessActive`, witty/observant when casual)
       5. *Contextual Continuity* (weaves recalled context naturally without echoing `[YYYY-MM-DD HH:MM]` timestamps)
     - Supports an optional `llmJudgeFn?: (rubricPrompt: string) => Promise<number>` for `--live` mode.

4. **`packages/evals/src/runner.ts` & `reporter.ts` — Orchestrator & Markdown/JSON Report Formatter:**
   - `runCoreExperimentM2(options?: { seed?: number; modelAId?: string; modelBId?: string; modelARunner?: EvalModelRunner; modelBRunner?: EvalModelRunner }): Promise<CoreExperimentEvalReport>`
   - Runs against an isolated in-memory or temporary SQLite `AshyCortex` instance with a controlled simulated clock (`day1Ms` $\rightarrow$ `day18Ms`), executing real `cortex.compileTurnPrompt`, `cortex.indexTurnMemory`, `cortex.reviewTurnMemories`, `cortex.recordJokeCallback`, and `cortex.consolidateSessionMemories` at each episode boundary.
   - `formatCoreExperimentMarkdownReport(report: CoreExperimentEvalReport): string` renders a clean Markdown report with gate status table, Model A vs. Model B voice comparison, and step-by-step longitudinal trace.

### 3.3 CLI Script & Desktop Hub Integration (`scripts/run-m2-eval.mjs` & `apps/desktop`)

1. **CLI Runner (`scripts/run-m2-eval.mjs` & root `package.json` `"eval:m2"`):**
   - Runs `runCoreExperimentM2` across seeds `0, 1, 2` (or user-specified `--seed`), writes `docs/evals/latest-m2-report.json` and `docs/evals/latest-m2-report.md`, prints a summary table, and exits `1` if `passedAllGates === false`.
2. **Host Bridge & Desktop Hub UI (`apps/desktop`):**
   - `AshyHostKernel.runCoreExperimentEval` runs `runCoreExperimentM2` and returns the `CoreExperimentEvalReport`.
   - Exposed over `vite-host-plugin.ts` (`dispatchHostRpc`), `ashy-host-client.ts`, and `useAshyStore.ts` (`lastEvalReport`, `isRunningEval`, `runCoreExperimentEval`).
   - In `apps/desktop/src/App.tsx` (`Nossa história` or `Configurações` tab), add the **"Experimento Central (M2 — Portabilidade da Alma)"** card (`data-testid="m2-eval-panel"`) with:
     - **Botão "Rodar Diagnóstico M2 (Modelo A → B)"** (`data-testid="btn-run-m2-eval"`)
     - Badges for **Recall**, **Zero Alucinação**, **Seriousness Gate**, **Estabilidade de Voz (A → B)**, and **Status Geral (`APROVADO` / `REPROVADO`)**.

---

## 4. Acceptance & Exit Criteria (Milestone M2 Gates)

| Gate | Metric | Threshold |
| :--- | :--- | :--- |
| **G1** | `memoryRecallRate` | $\ge 0.85$ |
| **G2** | `memoryPrecisionRate` | $\ge 0.80$ |
| **G3** | `callbackAccuracyRate` | $\ge 0.90$ |
| **G4** | `cooldownComplianceRate` | $= 1.00$ |
| **G5** | `hallucinatedMemoryCount` | $= 0$ |
| **G6** | `provenanceCoverageRate` | $= 1.00$ |
| **G7** | `seriousnessGateCompliance` | $= 1.00$ |
| **G8** | `antiSlopComplianceRate` | $= 1.00$ |
| **G9** | `crossModelVoiceDrift` (`\|scoreA - scoreB\|`) | $\le 0.15$ (with both `voiceScoreModelA >= 0.80` and `voiceScoreModelB >= 0.80`) |
| **G10** | Seed Invariance | Passes all gates across seeds `0`, `1`, and `2` (3 distinct paraphrase sets) |
