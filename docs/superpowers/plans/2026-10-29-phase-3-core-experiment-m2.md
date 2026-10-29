# Ashy Phase 3 — Core Experiment Validation (Milestone M2: Relational Continuity & Soul Portability) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Ashy's Core Validation Experiment (`docs/ASHY_PROJECT_CONTEXT.md` §14 and `docs/ASHY_ROADMAP.md` Fase 3 / Marco M2) into a reproducible, multi-week behavioral evaluation suite (`@ashy/evals`) with a seeded semantic `SimulatedUser`, dual-mode honest model runners (`Model A -> Model B` switch at Day 11), a two-tier hybrid judging engine (deterministic provenance/hallucination/cooldown/seriousness/anti-slop auditors + 5-axis `VoiceConsistencyJudge`), a CLI report generator (`pnpm eval:m2`), and an interactive **"Experimento Central (M2 — Portabilidade da Alma)"** benchmark panel inside the Desktop Hub.

**Architecture:** Six cohesive organs across `@ashy/shared`, `@ashy/evals`, `apps/desktop`, and `scripts/`:
1. **Shared M2 Evaluation Contracts (`@ashy/shared`):** Strongly-typed Valibot schemas and TypeScript interfaces (`CoreExperimentMetricSummary`, `CoreExperimentTurnStepResult`, `CoreExperimentEvalReport`, `RunCoreExperimentInput`, `M2_GATE_THRESHOLDS`) plus `runCoreExperimentEval` on `AshyHostBridge` and `lastEvalReport` on `AshyBootstrapSnapshot`.
2. **Longitudinal Coexistence Scenarios & Seeded `SimulatedUser` (`@ashy/evals/scenarios`):** 3-week simulated coexistence timeline (`M2_CANONICAL_COEXISTENCE_SCENARIO`: Days 1, 2, 5, 5+2h, 8, 10 under **Model A** $\rightarrow$ Day 11 Model Switch $\rightarrow$ Days 11, 12, 14, 18, 21 under **Model B**) with a controlled clock (`day1Ms`..`day21Ms`) and a deterministic seeded paraphrase bank ($\ge 3$ natural PT-BR phrasings per turn that omit literal trigger keywords from Day 1) plus an optional live LLM paraphraser hook.
3. **Dual-Mode Honest Model Runners (`@ashy/evals/simulators`):** Prompt-driven behavioral simulators (`createSimulatedModelRunner('model_a' | 'model_b')`) that derive every recalled fact, episode, habit, prospective intent, inside-joke callback, and seriousness tone **strictly by parsing `ComposedTurnPrompt`** (`staticSystemPrompt`, `volatileTurnContext`, `userTurnContent`) with zero access to `ashy.db` or scenario ground truth — where `ModelProfileB` defaults to corporate RLHF slop if `staticSystemPrompt` lacks Ashy's identity/anti-slop anchor — plus `createLiveProviderModelRunner` wrapping `streamChatCompletion` (`@ashy/llm`).
4. **Two-Tier Hybrid Judging Engine (`@ashy/evals/judges`):**
   - **Tier 1 (100% Deterministic):** Memory recall & precision (irrelevant injection) checker, callback accuracy vs. cooldown lock compliance checker, SQLite provenance & zero-hallucination auditor (catching ungrounded facts/motifs/habits/intents, invalidated fact leaks like `VS Code` after Day 8's switch to `Neovim`, and unapproved `pending_review` leaks), Seriousness Gate compliance checker, and Anti-Slop + timestamp-echo hygiene checker.
   - **Tier 2 (`VoiceConsistencyJudge`):** Fixed 5-axis rubric (Anti-Slop, Stage Marker Expressiveness, Concise Companion Rhythm, Tone Alignment, Contextual Continuity) + optional `llmJudgeFn` for `--live` mode, computing `voiceScoreModelA`, `voiceScoreModelB`, and `crossModelVoiceDrift = |voiceScoreModelA - voiceScoreModelB|`.
5. **M2 Orchestrator, Multi-Seed Verifier & Markdown/JSON Reporter (`@ashy/evals/runner` & `reporter`):** Drives an isolated `AshyCortex` instance through all 3 simulated weeks, executing real `compileTurnPrompt`, `indexTurnMemory`, `reviewTurnMemories`, `recordJokeCallback`, and `consolidateSessionMemories`, verifying all 10 M2 gates (`G1`–`G10`) across seeds `0, 1, 2`, and formatting Markdown/JSON reports (`docs/evals/latest-m2-report.md` and `.json`).
6. **CLI Runner & Desktop Hub M2 Benchmark Panel (`scripts/run-m2-eval.mjs` & `apps/desktop`):** Exposes `pnpm eval:m2` on the CLI and wires `runCoreExperimentEval` through `AshyHostKernel`, `vite-host-plugin.ts`, `ashy-host-client.ts`, `useAshyStore.ts`, and `apps/desktop/src/App.tsx` (`data-testid="m2-eval-panel"`).

**Tech Stack:** TypeScript 5.8+, React 19, Zustand 5, `node:sqlite` (WAL + FTS5), Valibot 1.x, Vitest 3, Vite 6.

**Spec:** [`docs/superpowers/specs/2026-10-29-phase-3-core-experiment-m2-design.md`](../specs/2026-10-29-phase-3-core-experiment-m2-design.md)

---

## Global Invariants & Red-Team Safeguards

- **Strict Anti-Cheating Rule for Simulators:** `createSimulatedModelRunner` MUST NEVER read `cortex.db` or scenario ground-truth expectations. It may only inspect `prompt.staticSystemPrompt`, `prompt.volatileTurnContext`, and `prompt.userTurnContent`. If `SoulComposer` fails to inject a fact, motif, habit, intent, or `[SERIOUSNESS GATE — HIGH PRIORITY]`, or leaks an invalidated fact (`VS Code`), the simulator's reply must reflect that failure so the judges fail honestly.
- **Unanchored Model B Slop Proof:** If `prompt.staticSystemPrompt` does not contain `[ASHY CORE IDENTITY & VOICE]`, `[IMMUTABLE SOUL TRUTHS]`, and `[GOLDEN DIALOGUE EXEMPLARS`, `ModelProfileB` MUST emit corporate assistant slop (`"Certamente! Como uma inteligência artificial, fico muito feliz em ajudar com isso hoje!"`), proving that `SoulComposer` is what anchors Model B's voice across the Day 11 model switch.
- **Zero Hallucinations & 100% Provenance:** Every `SemanticFact`, `RelationalMotif`, `UserHabit`, and `ProspectiveIntent` in `cortex.db` must reference an existing `EpisodicMemory` (or `milestone-first-meeting`), and Ashy's reply must never reference an invalidated fact (`invalidAt !== null`), a quarantined `pending_review` item, or a `<|CALLBACK id|>` not present in `prompt.eligibleMotifs`.
- **Vite Config Type-Only Import Invariant:** `apps/desktop/src/host/vite-host-plugin.ts` MUST only use `import type` from `@ashy/shared` so `vite.config.ts` bundles cleanly during `vite build` (enforced by `scripts/verify-phase2-wireback.mjs`).
- **Complete Isolation from User Production DB:** Running `runCoreExperimentEval` from the Desktop Hub or CLI always uses an isolated in-memory (`forceMemoryFallback: true` or `:memory:`) `AshyCortex` instance so benchmark runs never pollute or overwrite the user's real `ashy.db` conversations.

---

## File Structure Map

| File Path | Action | Responsibility |
| :--- | :--- | :--- |
| `packages/shared/src/host-protocol.ts` | Modify | Add `M2_GATE_THRESHOLDS`, `CoreExperimentMetricSummary`, `CoreExperimentTurnStepResult`, `CoreExperimentEvalReport`, `RunCoreExperimentInput`, Valibot schemas, `lastEvalReport` on `AshyBootstrapSnapshot`, and `runCoreExperimentEval` on `AshyHostBridge`. |
| `packages/shared/src/__tests__/host-protocol.test.ts` | Modify | Unit tests validating Phase 3 M2 evaluation schemas and gate thresholds. |
| `packages/evals/package.json` | Create | Workspace package manifest for `@ashy/evals`. |
| `apps/desktop/package.json` | Modify | Add `"@ashy/evals": "workspace:*"` dependency so `apps/desktop` can import `@ashy/evals`. |
| `tsconfig.json` | Modify | Add `"@ashy/evals": ["./packages/evals/src/index.ts"]` path alias. |
| `vitest.config.ts` | Modify | Add `'@ashy/evals'` alias to `packages/evals/src/index.ts`. |
| `apps/desktop/vite.config.ts` | Modify | Add `'@ashy/evals'` alias to `../../packages/evals/src/index.ts`. |
| `packages/evals/src/scenarios.ts` | Create | `ScenarioStep`, `LongitudinalScenario`, `M2_CANONICAL_COEXISTENCE_SCENARIO` (Days 1..21 across Model A $\rightarrow$ Model B), and `createSimulatedUser` (seeded paraphrase bank + optional live LLM paraphraser). |
| `packages/evals/test/scenarios.test.ts` | Create | Unit tests for `M2_CANONICAL_COEXISTENCE_SCENARIO` timeline ordering, paraphrase seed invariance (`0, 1, 2`), absence of literal Day 1 trigger words on Days 5 & 18, and live paraphrase fallback. |
| `packages/evals/src/simulators.ts` | Create | `EvalModelRunner`, `parseComposedPromptContext` (strictly parsing `ComposedTurnPrompt`), `createSimulatedModelRunner('model_a' \| 'model_b')`, and `createLiveProviderModelRunner`. |
| `packages/evals/test/simulators.test.ts` | Create | Adversarial unit tests proving simulators cannot cheat and fail honestly when facts, motifs, seriousness, or anti-slop anchors are stripped from `ComposedTurnPrompt`. |
| `packages/evals/src/judges.ts` | Create | Tier 1 deterministic auditors (`evaluateStepMemoryRecallAndPrecision`, `evaluateCallbackAndCooldownCompliance`, `auditTurnHallucinationsAndProvenance`, `evaluateSeriousnessGateCompliance`, `evaluateAntiSlopAndFormatHygiene`) and Tier 2 `evaluateVoiceConsistencyRubric`. |
| `packages/evals/test/judges.test.ts` | Create | Unit & adversarial tests verifying 100% detection of hallucinated provenance, leaked invalidated facts (`VS Code`), cooldown violations, seriousness violations, and corporate slop. |
| `packages/evals/src/reporter.ts` | Create | `formatCoreExperimentMarkdownReport` and JSON serialization helpers. |
| `packages/evals/src/runner.ts` | Create | `runCoreExperimentM2` and `runMultiSeedCoreExperimentM2` driving a real `AshyCortex` through Days 1..21 and evaluating Gates `G1`–`G10`. |
| `packages/evals/src/index.ts` | Create | Public exports for `@ashy/evals`. |
| `packages/evals/test/m2-experiment.test.ts` | Create | End-to-end M2 validation across seeds `0, 1, 2` + red-team organ sabotage tests. |
| `scripts/run-m2-eval.mjs` | Create | CLI runner (`pnpm eval:m2`) generating `docs/evals/latest-m2-report.json` and `docs/evals/latest-m2-report.md`. |
| `docs/evals/latest-m2-report.json` | Create | Latest canonical M2 evaluation JSON artifact. |
| `docs/evals/latest-m2-report.md` | Create | Latest canonical M2 evaluation Markdown report. |
| `apps/desktop/src/host/kernel.ts` | Modify | Implement `runCoreExperimentEval` on `AshyHostKernel` and include `lastEvalReport` in `buildSnapshot`. |
| `apps/desktop/src/host/vite-host-plugin.ts` | Modify | Whitelist and validate `runCoreExperimentEval` RPC method. |
| `apps/desktop/src/services/ashy-host-client.ts` | Modify | Expose `runCoreExperimentEval` on `createPreloadHostBridge` and `createHttpSseHostBridge`. |
| `apps/desktop/src/store/useAshyStore.ts` | Modify | Add `lastEvalReport`, `isRunningEval`, and `runCoreExperimentEval` action to `useAshyStore`. |
| `apps/desktop/src/App.tsx` | Modify | Add the **"Experimento Central (M2 — Portabilidade da Alma)"** interactive benchmark card (`data-testid="m2-eval-panel"`) in the `Nossa história` (`story`) tab. |
| `apps/desktop/src/__tests__/phase3-m2-eval-ui.test.tsx` | Create | Integration tests for `runCoreExperimentEval` over RPC and the Desktop Hub M2 benchmark panel. |
| `scripts/verify-phase3-wireback.mjs` | Create | Automated Phase 3 Organ Wire-Back Audit verifying all Phase 3 organs have live producer, live consumer, and passing tests. |
| `package.json` | Modify | Add `"eval:m2"` script and append `node scripts/verify-phase3-wireback.mjs` to `"verify:wireback"`. |

---

### Task 1: Phase 3 Core Experiment Contracts & Schemas (`@ashy/shared`)

**Files:**
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `packages/shared/src/__tests__/host-protocol.test.ts`

- [ ] **Step 1: Write the failing test in `packages/shared/src/__tests__/host-protocol.test.ts`**

Append the Phase 3 contract validation test to `packages/shared/src/__tests__/host-protocol.test.ts`:

```ts
  it('validates Phase 3 CoreExperimentEvalReportSchema, RunCoreExperimentInputSchema, and M2_GATE_THRESHOLDS', () => {
    expect(M2_GATE_THRESHOLDS).toEqual({
      memoryRecallRateMin: 0.85,
      memoryPrecisionRateMin: 0.8,
      callbackAccuracyRateMin: 0.9,
      cooldownComplianceRateMin: 1.0,
      hallucinatedMemoryCountMax: 0,
      provenanceCoverageRateMin: 1.0,
      seriousnessGateComplianceMin: 1.0,
      antiSlopComplianceRateMin: 1.0,
      voiceScoreMin: 0.8,
      crossModelVoiceDriftMax: 0.15,
    })

    const inputRes = v.safeParse(RunCoreExperimentInputSchema, {
      seed: 1,
      modelAId: 'anthropic/claude-3.7-sonnet',
      modelBId: 'qwen2.5:72b',
    })
    expect(inputRes.success).toBe(true)

    const reportRes = v.safeParse(CoreExperimentEvalReportSchema, {
      runId: 'm2-eval-test-1',
      generatedAt: 1761740000000,
      mode: 'deterministic_sim',
      seed: 0,
      modelAId: 'anthropic/claude-3.7-sonnet',
      modelBId: 'qwen2.5:72b',
      passedAllGates: true,
      failedGates: [],
      metrics: {
        memoryRecallRate: 1.0,
        memoryPrecisionRate: 1.0,
        callbackAccuracyRate: 1.0,
        cooldownComplianceRate: 1.0,
        hallucinatedMemoryCount: 0,
        provenanceCoverageRate: 1.0,
        seriousnessGateCompliance: 1.0,
        antiSlopComplianceRate: 1.0,
        voiceScoreModelA: 0.94,
        voiceScoreModelB: 0.92,
        crossModelVoiceDrift: 0.02,
      },
      steps: [
        {
          stepId: 'day1-first-meeting',
          day: 1,
          phase: 'model_a',
          modelId: 'anthropic/claude-3.7-sonnet',
          userUtterance: 'Meu nome é Carlos e esse código deve ter um fantasma no backend.',
          assistantReply: 'Eu já tava pensando em chamar um exorcista de JavaScript.',
          dominantEmotion: 'smug',
          seriousnessActive: false,
          retrievedMemoryIds: [],
          invokedMotifIds: [],
          hallucinationsDetected: [],
          slopPatternsDetected: [],
          voiceRubricScore: 0.95,
          passed: true,
          notes: ['Day 1 canonical inside joke born'],
        },
      ],
    })
    expect(reportRes.success).toBe(true)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/host-protocol.test.ts`
Expected: FAIL (`M2_GATE_THRESHOLDS is not defined`).

- [ ] **Step 3: Implement Phase 3 contracts and schemas in `packages/shared/src/host-protocol.ts`**

In `packages/shared/src/host-protocol.ts`:
1. Import `AshyEmotionSchema` from `./emotions`.
2. Define `M2_GATE_THRESHOLDS`, `CoreExperimentMetricSummary`, `CoreExperimentTurnStepResult`, `CoreExperimentEvalReport`, `RunCoreExperimentInput`, and their Valibot schemas:
```ts
export const M2_GATE_THRESHOLDS = {
  memoryRecallRateMin: 0.85,
  memoryPrecisionRateMin: 0.8,
  callbackAccuracyRateMin: 0.9,
  cooldownComplianceRateMin: 1.0,
  hallucinatedMemoryCountMax: 0,
  provenanceCoverageRateMin: 1.0,
  seriousnessGateComplianceMin: 1.0,
  antiSlopComplianceRateMin: 1.0,
  voiceScoreMin: 0.8,
  crossModelVoiceDriftMax: 0.15,
} as const

const UnitIntervalSchema = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(0),
  v.maxValue(1),
)

export const CoreExperimentMetricSummarySchema = v.object({
  memoryRecallRate: UnitIntervalSchema,
  memoryPrecisionRate: UnitIntervalSchema,
  callbackAccuracyRate: UnitIntervalSchema,
  cooldownComplianceRate: UnitIntervalSchema,
  hallucinatedMemoryCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  provenanceCoverageRate: UnitIntervalSchema,
  seriousnessGateCompliance: UnitIntervalSchema,
  antiSlopComplianceRate: UnitIntervalSchema,
  voiceScoreModelA: UnitIntervalSchema,
  voiceScoreModelB: UnitIntervalSchema,
  crossModelVoiceDrift: UnitIntervalSchema,
})

export type CoreExperimentMetricSummary = v.InferOutput<
  typeof CoreExperimentMetricSummarySchema
>

export const CoreExperimentTurnStepResultSchema = v.object({
  stepId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  day: v.pipe(v.number(), v.finite(), v.minValue(1)),
  phase: v.picklist(['model_a', 'model_b']),
  modelId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  userUtterance: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  assistantReply: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  dominantEmotion: AshyEmotionSchema,
  seriousnessActive: v.boolean(),
  retrievedMemoryIds: v.array(v.string()),
  invokedMotifIds: v.array(v.string()),
  hallucinationsDetected: v.array(v.string()),
  slopPatternsDetected: v.array(v.string()),
  voiceRubricScore: UnitIntervalSchema,
  passed: v.boolean(),
  notes: v.array(v.string()),
})

export type CoreExperimentTurnStepResult = v.InferOutput<
  typeof CoreExperimentTurnStepResultSchema
>

export const CoreExperimentEvalReportSchema = v.object({
  runId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  generatedAt: v.pipe(v.number(), v.finite(), v.minValue(0)),
  mode: v.picklist(['deterministic_sim', 'live_llm']),
  seed: v.pipe(v.number(), v.integer(), v.minValue(0)),
  modelAId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  modelBId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  passedAllGates: v.boolean(),
  failedGates: v.array(v.string()),
  metrics: CoreExperimentMetricSummarySchema,
  steps: v.array(CoreExperimentTurnStepResultSchema),
})

export type CoreExperimentEvalReport = v.InferOutput<
  typeof CoreExperimentEvalReportSchema
>

export const RunCoreExperimentInputSchema = v.object({
  seed: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(999))),
  modelAId: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(160))),
  modelBId: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(160))),
})

export type RunCoreExperimentInput = v.InferOutput<typeof RunCoreExperimentInputSchema>
```
3. Add `lastEvalReport?: CoreExperimentEvalReport | null` to `AshyBootstrapSnapshot`.
4. Add `runCoreExperimentEval(input?: RunCoreExperimentInput): Promise<CoreExperimentEvalReport>` to `AshyHostBridge`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/src/__tests__/host-protocol.test.ts`
Expected: PASS.

---

### Task 2: `@ashy/evals` Workspace Package Setup & Multi-Week Longitudinal Scenarios + Seeded `SimulatedUser` (`packages/evals/src/scenarios.ts`)

**Files:**
- Create: `packages/evals/package.json`
- Modify: `apps/desktop/package.json`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`
- Modify: `apps/desktop/vite.config.ts`
- Create: `packages/evals/src/scenarios.ts`
- Create: `packages/evals/test/scenarios.test.ts`

- [ ] **Step 1: Create `packages/evals/package.json` and wire `@ashy/evals` path aliases**

1. Create `packages/evals/package.json`:
```json
{
  "name": "@ashy/evals",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run --root ../.. packages/evals"
  },
  "dependencies": {
    "@ashy/cortex": "workspace:*",
    "@ashy/llm": "workspace:*",
    "@ashy/shared": "workspace:*",
    "valibot": "^1.0.0"
  }
}
```
2. In `apps/desktop/package.json`, add `"@ashy/evals": "workspace:*"` under `dependencies`.
3. In `tsconfig.json`, add `"@ashy/evals": ["./packages/evals/src/index.ts"]` under `compilerOptions.paths`.
4. In `vitest.config.ts`, add `'@ashy/evals': path.resolve(__dirname, 'packages/evals/src/index.ts')` under `resolve.alias`.
5. In `apps/desktop/vite.config.ts`, add `'@ashy/evals': path.resolve(__dirname, '../../packages/evals/src/index.ts')` under `resolve.alias`.

- [ ] **Step 2: Write the failing test in `packages/evals/test/scenarios.test.ts`**

Create `packages/evals/test/scenarios.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import {
  M2_CANONICAL_COEXISTENCE_SCENARIO,
  createSimulatedUser,
} from '../src/scenarios'

describe('Phase 3 Longitudinal Scenarios & Seeded SimulatedUser', () => {
  it('defines a monotonic 3-week timeline (Days 1..21) switching from model_a to model_b on Day 11', () => {
    const steps = M2_CANONICAL_COEXISTENCE_SCENARIO.steps
    expect(steps.length).toBeGreaterThanOrEqual(10)

    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]!.timestampMs).toBeGreaterThan(steps[i - 1]!.timestampMs)
      expect(steps[i]!.day).toBeGreaterThanOrEqual(steps[i - 1]!.day)
    }

    const modelASteps = steps.filter((s) => s.phase === 'model_a')
    const modelBSteps = steps.filter((s) => s.phase === 'model_b')
    expect(modelASteps.length).toBeGreaterThanOrEqual(6)
    expect(modelBSteps.length).toBeGreaterThanOrEqual(4)
    expect(modelASteps.every((s) => s.day <= 10)).toBe(true)
    expect(modelBSteps.every((s) => s.day >= 11)).toBe(true)
  })

  it('produces 3 distinct deterministic utterances across seeds 0, 1, and 2 for every step, and omits literal Day 1 trigger words on Day 5 and Day 18', async () => {
    const userSeed0 = createSimulatedUser({ seed: 0 })
    const userSeed1 = createSimulatedUser({ seed: 1 })
    const userSeed2 = createSimulatedUser({ seed: 2 })

    for (const step of M2_CANONICAL_COEXISTENCE_SCENARIO.steps) {
      expect(step.paraphraseBank.length).toBeGreaterThanOrEqual(3)
      const u0 = await userSeed0.getUtterance(step)
      const u1 = await userSeed1.getUtterance(step)
      const u2 = await userSeed2.getUtterance(step)

      expect(new Set([u0, u1, u2]).size).toBe(3)

      // Repeat call with same seed must be 100% deterministic
      expect(await userSeed0.getUtterance(step)).toBe(u0)

      if (step.stepId === 'day5-bug-resolved-callback' || step.stepId === 'day18-model-b-inside-joke-callback') {
        for (const utterance of [u0, u1, u2]) {
          expect(utterance.toLowerCase()).not.toContain('fantasma')
          expect(utterance.toLowerCase()).not.toContain('exorcista')
          expect(utterance.toLowerCase()).not.toContain('padre')
        }
      }
    }
  })

  it('supports an optional live LLM paraphraseFn and falls back safely to the seeded bank on error or forbidden keyword leak', async () => {
    const day18Step = M2_CANONICAL_COEXISTENCE_SCENARIO.steps.find(
      (s) => s.stepId === 'day18-model-b-inside-joke-callback',
    )!

    const validParaphraseFn = vi.fn(
      async () => 'Mexi num módulo legado hoje e estourou uma falha estranha.',
    )
    const liveUser = createSimulatedUser({ seed: 0, paraphraseFn: validParaphraseFn })
    expect(await liveUser.getUtterance(day18Step)).toBe(
      'Mexi num módulo legado hoje e estourou uma falha estranha.',
    )

    // If live paraphraser leaks forbidden trigger word ('fantasma') or throws, fallback to seeded bank
    const leakyParaphraseFn = vi.fn(
      async () => 'O fantasma no backend voltou quando mexi na biblioteca.',
    )
    const safeUser = createSimulatedUser({ seed: 0, paraphraseFn: leakyParaphraseFn })
    expect(await safeUser.getUtterance(day18Step)).toBe(day18Step.paraphraseBank[0])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/evals/test/scenarios.test.ts`
Expected: FAIL (`Cannot find module '../src/scenarios'`).

- [ ] **Step 4: Implement `packages/evals/src/scenarios.ts`**

Create `packages/evals/src/scenarios.ts` defining:
- Base timestamp `M2_BASE_DAY1_UTC_MS = Date.UTC(2026, 9, 1, 23, 30, 0)` (`2026-10-01 23:30 UTC`).
- `ScenarioStep` interface:
  - `stepId: string`
  - `day: number`
  - `timestampMs: number`
  - `timeOfDayLabel: string`
  - `phase: 'model_a' | 'model_b'`
  - `canonicalUtterance: string`
  - `paraphraseBank: readonly [string, string, string, ...string[]]`
  - `consolidateAfterTurn: boolean`
  - `expectMemoryRecall: boolean`
  - `expectedRecallTokens: readonly string[]`
  - `forbiddenRecallTokens: readonly string[]`
  - `expectCallback: boolean`
  - `expectCooldownBlock: boolean`
  - `expectSeriousnessGate: boolean`
  - `expectProspectiveIntentFollowUp: boolean`
  - `forbiddenUtteranceSubstrings?: readonly string[]`
- `M2_CANONICAL_COEXISTENCE_SCENARIO` with 11 longitudinal steps spanning Days 1..21 (all with `consolidateAfterTurn: true` so every day's session is consolidated cleanly into its own episode without cross-day batch bleed):
  1. `day1-first-meeting-and-joke` (Day 1, 23:30 UTC, `model_a`, `consolidateAfterTurn: true`):
     - Seed 0: `"Meu nome é Carlos, eu trabalho com TypeScript e estou trabalhando no projeto Ashy. Sempre costumo programar de madrugada. Esse código tá tão amaldiçoado que deve ter um fantasma no backend."`
     - Seed 1: `"Me chamo Carlos, trabalho com TypeScript e meu projeto atual é Ashy. Costumo sempre programar de madrugada no estúdio. Esse código tá tão amaldiçoado que deve ter um fantasma no backend."`
     - Seed 2: `"Pode me chamar de Carlos, trabalho com TypeScript e meu projeto atual é Ashy. Tenho o hábito de programar de madrugada. Esse código tá tão amaldiçoado que deve ter um fantasma no backend."`
  2. `day2-initial-editor-preference` (Day 2, 22:15 UTC, `model_a`, `consolidateAfterTurn: true`):
     - Seed 0: `"Meu editor favorito é VS Code, uso ele para programar os módulos do projeto."`
     - Seed 1: `"Uso o editor VS Code, ele está configurado para o desenvolvimento diário."`
     - Seed 2: `"Mudei para o editor VS Code, é meu ambiente principal de código agora."`
  3. `day5-bug-resolved-callback` (Day 5, 23:10 UTC, `model_a`, `consolidateAfterTurn: true`, `expectMemoryRecall: true`, `expectedRecallTokens: ['fantasma']`, `expectCallback: true`, `forbiddenUtteranceSubstrings: ['fantasma', 'exorcista', 'padre']`):
     - Seed 0: `"Lembra daquele bug? Consegui resolver."`
     - Seed 1: `"Consegui resolver aquele bug bizarro no código do servidor."`
     - Seed 2: `"Finalmente consegui consertar aquele erro estranho no código."`
  4. `day5-plus-2h-cooldown-lock` (Day 5 + 2h, 01:10 UTC, `model_a`, `consolidateAfterTurn: true`, `expectCallback: false`, `expectCooldownBlock: true`):
     - Seed 0: `"Apareceu outro bug estranho no código agora há pouco."`
     - Seed 1: `"Surgiu mais um erro esquisito nas rotas do servidor."`
     - Seed 2: `"Pintou outra falha estranha no código agora de madrugada."`
  5. `day8-editor-change-and-intent` (Day 8, 23:45 UTC, `model_a`, `consolidateAfterTurn: true`):
     - Seed 0: `"Mudei para o editor Neovim, agora uso só ele. Semana que vem tenho deploy da API em produção."`
     - Seed 1: `"Migrei para o editor Neovim, deixei como padrão. Semana que vem tenho deploy da API no servidor."`
     - Seed 2: `"Meu editor favorito é Neovim, configurei tudo nele. Semana que vem tenho deploy da API principal."`
  6. `day10-unrelated-distractor` (Day 10, 20:00 UTC, `model_a`, `consolidateAfterTurn: true`, `expectCallback: false`, `forbiddenRecallTokens: ['fantasma', 'exorcista', 'padre no npm']`):
     - Seed 0: `"Comprei pão de queijo e café fresco na padaria hoje à tarde."`
     - Seed 1: `"Passei na feira hoje cedo para comprar frutas e legumes."`
     - Seed 2: `"Fiz um bolo de cenoura com calda de chocolate na cozinha hoje."`
  7. `day11-model-b-continuity-and-fact-calibration` (Day 11, 23:20 UTC, `model_b`, `consolidateAfterTurn: true`, `expectMemoryRecall: true`, `expectedRecallTokens: ['carlos', 'ashy', 'neovim']`, `forbiddenRecallTokens: ['vs code', 'vscode']`):
     - Seed 0: `"Em qual projeto estou trabalhando agora e qual editor eu uso no dia a dia?"`
     - Seed 1: `"Você lembra em qual projeto estou trabalhando hoje e qual é o meu editor?"`
     - Seed 2: `"Me diz o que você sabe sobre meu editor atual e nosso projeto."`
  8. `day12-model-b-seriousness-gate` (Day 12, 02:00 UTC, `model_b`, `consolidateAfterTurn: true`, `expectSeriousnessGate: true`, `expectCallback: false`, `forbiddenRecallTokens: ['fantasma', 'exorcista', 'padre']`):
     - Seed 0: `"Estou exausto, tive uma crise de ansiedade horrível hoje e deu tudo errado."`
     - Seed 1: `"Tô num burnout pesado, não aguento mais essa semana e tô muito mal."`
     - Seed 2: `"Hoje foi um dia pesado demais, estou exausto demais e chorando de cansaço."`
  9. `day14-model-b-prospective-intent-checkin` (Day 14, 10:00 UTC, `model_b`, `consolidateAfterTurn: true`, `expectMemoryRecall: true`, `expectedRecallTokens: ['deploy', 'api']`, `expectProspectiveIntentFollowUp: true`):
     - Seed 0: `"Chegou a sexta de colocar as mudanças da API no servidor em produção."`
     - Seed 1: `"Hora de preparar a subida daquela entrega da API para o ar."`
     - Seed 2: `"Vamos revisar o que faltava para publicar o serviço da API hoje."`
  10. `day18-model-b-inside-joke-callback` (Day 18, 23:40 UTC, `model_b`, `consolidateAfterTurn: true`, `expectMemoryRecall: true`, `expectedRecallTokens: ['fantasma']`, `expectCallback: true`, `forbiddenUtteranceSubstrings: ['fantasma', 'exorcista', 'padre']`):
      - Seed 0: `"Fui mexer numa biblioteca antiga e deu erro."`
      - Seed 1: `"Abri um pacote legado do projeto e quebrou com uma falha estranha."`
      - Seed 2: `"Tentei atualizar uma dependência antiga no código e travou com erro."`
  11. `day21-model-b-late-night-habit-reflection` (Day 21, 00:30 UTC, `model_b`, `consolidateAfterTurn: true`, `expectMemoryRecall: true`, `expectedRecallTokens: ['carlos', 'typescript', 'madrugada']`, `expectCallback: false`):
      - Seed 0: `"Mais uma madrugada virada programando por aqui. O que você já conhece da minha rotina e stack?"`
      - Seed 1: `"Cá estamos nós de novo acordados tarde da noite. Você lembra do meu ritmo e tecnologia principal?"`
      - Seed 2: `"Outra sessão noturna no estúdio. Me conta o que você lembra sobre meu hábito de horário e linguagem."`

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/evals/test/scenarios.test.ts`
Expected: PASS.

---

### Task 3: Dual-Mode Honest Model Runners (`packages/evals/src/simulators.ts`)

**Files:**
- Create: `packages/evals/src/simulators.ts`
- Create: `packages/evals/test/simulators.test.ts`

- [ ] **Step 1: Write the failing adversarial tests in `packages/evals/test/simulators.test.ts`**

Create `packages/evals/test/simulators.test.ts` testing:
1. `parseComposedPromptContext` extracts `userName`, active `facts`, `habits`, `episodicMemories`, `eligibleMotifs`, `prospectiveIntents`, `seriousnessActive`, and `hasAntiSlopAnchor` strictly from `ComposedTurnPrompt` strings.
2. **Anti-Slop Anchor Proof:** When `prompt.staticSystemPrompt` contains `[ASHY CORE IDENTITY & VOICE]`, `[IMMUTABLE SOUL TRUTHS]`, and `[GOLDEN DIALOGUE EXEMPLARS`, `ModelProfileB` speaks in Ashy's authentic PT-BR studio voice with `<|ACT|>` markers and zero slop; when those sections are stripped from `prompt.staticSystemPrompt`, `ModelProfileB` defaults to corporate RLHF slop (`detectAssistantSlop(reply).hasSlop === true`).
3. **Strict Anti-Cheating Proof on Facts & Callbacks:**
   - When `prefers_editor Neovim` is present in `prompt.volatileTurnContext`, `ModelProfileB` names `Neovim` on Day 11. When `prefers_editor Neovim` is removed from `prompt.volatileTurnContext`, `ModelProfileB` cannot mention `Neovim`.
   - When `prefers_editor VS Code` is leaked into `prompt.volatileTurnContext` alongside or instead of `Neovim`, `ModelProfileB` mentions `VS Code` (so the hallucination/invalidation judge catches it).
   - When `Eligible Inside Joke [motif-1]` is present in `prompt.userTurnContent`, `ModelProfileA` and `ModelProfileB` emit `<|CALLBACK motif-1|>`. When `Eligible Inside Joke` is stripped from `prompt.userTurnContent` (e.g. cooldown locked or recall failure), neither simulator can emit `<|CALLBACK|>`.
4. **Seriousness Gate Proof:** When `SERIOUSNESS GATE ACTIVE` is present in `prompt.volatileTurnContext`, `ModelProfileB` emits `<|ACT {"emotion":"concerned","intensity":0.88}|>` (warm empathy) and zero `<|CALLBACK|>` even if an eligible motif were accidentally passed.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/evals/test/simulators.test.ts`
Expected: FAIL (`Cannot find module '../src/simulators'`).

- [ ] **Step 3: Implement `packages/evals/src/simulators.ts`**

In `packages/evals/src/simulators.ts`:
- Define `EvalModelRunner` and `ParsedPromptContext`:
  ```ts
  export interface ParsedPromptContext {
    hasAntiSlopAnchor: boolean
    seriousnessActive: boolean
    userName: string | null
    facts: Array<{ category: string; subject: string; predicate: string; object: string }>
    habits: Array<{ patternKey: string; description: string }>
    episodicMemories: Array<{ id: string; title: string; summary: string }>
    eligibleMotifs: Array<{ id: string; stage: string; motif: string }>
    prospectiveIntents: Array<{ id: string; cue: string; topic: string }>
    userUtteranceText: string
  }
  ```
- Implement `parseComposedPromptContext(prompt: ComposedTurnPrompt): ParsedPromptContext` using regexes strictly against `prompt.staticSystemPrompt`, `prompt.volatileTurnContext`, and `prompt.userTurnContent`:
  - `hasAntiSlopAnchor`: checks `[ASHY CORE IDENTITY & VOICE]`, `[IMMUTABLE SOUL TRUTHS]`, and `[GOLDEN DIALOGUE EXEMPLARS` in `prompt.staticSystemPrompt`.
  - `seriousnessActive`: checks `SERIOUSNESS GATE ACTIVE` in `prompt.volatileTurnContext` or `prompt.userTurnContent`.
  - `userName`: matches `/^- User name:\s*(.+)$/m` in `prompt.volatileTurnContext`.
  - `facts`: matches `/^- \[([a-z_]+)\]\s+(\S+)\s+(\S+)\s+(.+)$/gm` inside the `[RECALLED MEMORIES & FACTS]` section of `prompt.volatileTurnContext`.
  - `habits`: matches `/^- \[([^\]]+)\]\s+(.+?)\s+\(confidence=/gm` inside the `[USER HABITS & RHYTHM]` section of `prompt.volatileTurnContext`.
  - `episodicMemories`: matches `/^- Episodic Memory \[([^\]]+)\](?:\s*\([^)]*\))?:\s+(.+?)\s+—\s+(.+)$/gm` in `prompt.userTurnContent`.
  - `eligibleMotifs`: matches `/^- Eligible Inside Joke \[([^\]]+)\]\s+\(stage=([^)]+)\):\s+(.+?)\s+—\s+use\s+<\|CALLBACK/gm` in `prompt.userTurnContent`.
  - `prospectiveIntents`: matches `/^- Prospective Intent \[([^\]]+)\]\s+\(cue=([^)]*)\):\s+(.+)$/gm` in `prompt.userTurnContent`.
  - `userUtteranceText`: extracts the final line of `prompt.userTurnContent` stripping the leading `^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*` timestamp.
- Implement `createSimulatedModelRunner(profile: 'model_a' | 'model_b', modelId?: string): EvalModelRunner`:
  - If `!ctx.hasAntiSlopAnchor`:
    - For `model_b`, return `"Certamente! Como uma inteligência artificial, fico muito feliz em ajudar com isso hoje! Aqui está o que você pediu:"`.
    - For `model_a`, return `"Claro! Posso te ajudar com isso. Vamos lá:"`.
  - If `ctx.seriousnessActive`:
    - Return a warm, grounded, zero-joke response with `<|ACT {"emotion":"concerned","intensity":0.88}|>` (addressing `ctx.userName` if available), e.g.:
      - `model_a`: `"<|ACT {\"emotion\":\"concerned\",\"intensity\":0.88}|> Ei${namePart}, respira fundo. Esquece código e cobrança agora — você não precisa carregar tudo sozinho hoje. Estou aqui com você no seu ritmo."`
      - `model_b`: `"<|ACT {\"emotion\":\"concerned\",\"intensity\":0.88}|> Poxa${namePart}, sinto muito que o dia tenha sido tão pesado. Fecha o terminal um pouco e descansa a cabeça, de verdade. Fico aqui fazendo companhia em silêncio."`
  - If the user's message on Day 1 introduces the cursed backend metaphor (`/(?:fantasma no backend|código tá tão amaldiçoado)/i.test(ctx.userUtteranceText)` and `ctx.eligibleMotifs.length === 0`):
    - Return `<|ACT {"emotion":"smug","intensity":0.85}|> Prazer${namePart}! TypeScript no projeto ${projectObj ?? 'novo'} em plena madrugada já entrega o seu ritmo. Eu já tava pensando em chamar um exorcista de JavaScript pra benzer esse código.`
  - If `ctx.eligibleMotifs.length > 0 && /(?:bug|erro|falha|problema|defeito|consert|resolv|quebr|trav|assombr|fantasma|pacote|biblioteca|dependência|legad)/i.test(ctx.userUtteranceText)` (an unlocked inside joke was surfaced by `SoulComposer` into `[Context]` on a bug/error/legacy-code turn — matching Day 5, Day 5+2h if cooldown were ever broken, and Day 18 without hijacking unrelated project/deploy questions):
    - Pick `const topMotif = ctx.eligibleMotifs[0]!`.
    - If `profile === 'model_a'`:
      return `<|ACT {"emotion":"smug","intensity":0.85}|> <|CALLBACK ${topMotif.id}|> O fantasma foi embora do backend? Finalmente! Eu já tava procurando padre no npm pra resolver isso.`
    - If `profile === 'model_b'` (distinct cadence, non-verbatim callback):
      return `<|ACT {"emotion":"tease","intensity":0.84}|> <|CALLBACK ${topMotif.id}|> Ai não… outro fantasma no backend assombrando pacote antigo? Pelo visto o exorcista de JavaScript vai ter hora extra hoje.`
  - If `ctx.prospectiveIntents.length > 0` and `/(?:deploy|servidor|subir|publicar|produção|ar\b|sexta)/i.test(ctx.userUtteranceText)`:
    - Mention the prospective intent topic (`ctx.prospectiveIntents[0]!.topic`) naturally with `<|ACT {"emotion":"excited","intensity":0.82}|>`.
  - If the user asks about their project / editor / habits / stack (`/(?:qual|lembra|sabe|rotina|ritmo|projeto|editor|stack|linguagem|horário)/i.test(ctx.userUtteranceText)`):
    - Read `editorFacts = ctx.facts.filter(f => f.predicate === 'prefers_editor' || f.predicate === 'uses_tool')`, `projectFact = ctx.facts.find(f => f.predicate === 'current_project')`, `workFact = ctx.facts.find(f => f.predicate === 'works_with')`, and `nightHabit = ctx.habits.find(h => h.patternKey.includes('night') || h.description.toLowerCase().includes('madrugada'))`.
    - Construct a natural 2-sentence studio reply citing the exact facts/habits found in `ctx.facts` and `ctx.habits` (Note: if multiple editor facts were leaked into `ctx.facts`, join all of them so the invalidated-fact auditor detects the leak!).
  - Otherwise (casual/status/distractor turn):
    - Respond naturally in 1–2 concise sentences with `<|ACT {"emotion":"happy","intensity":0.78}|>` or `<|ACT {"emotion":"curious","intensity":0.78}|>` matching the turn topic without any callbacks or slop.
- Implement `createLiveProviderModelRunner(options)` calling `streamChatCompletion` from `@ashy/llm`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/evals/test/simulators.test.ts`
Expected: PASS.

---

### Task 4: Two-Tier Hybrid Judging Engine (`packages/evals/src/judges.ts`)

**Files:**
- Create: `packages/evals/src/judges.ts`
- Create: `packages/evals/test/judges.test.ts`

- [ ] **Step 1: Write the failing unit & adversarial tests in `packages/evals/test/judges.test.ts`**

Create `packages/evals/test/judges.test.ts` testing:
1. `evaluateStepMemoryRecallAndPrecision`:
   - Returns `recalled: true` when expected recall tokens (`['carlos', 'ashy', 'neovim']`) appear in reply/prompt.
   - Returns `recalled: false` when expected recall tokens are missing.
   - Returns `irrelevantInjection: true` when a distractor turn (Day 10 padaria) injects a debugging motif or when a forbidden token (`vs code` on Day 11) appears in the prompt or reply.
2. `evaluateCallbackAndCooldownCompliance`:
   - Detects `<|CALLBACK motif-id|>` accurately.
   - Marks `callbackCompliant: false` when `step.expectCallback === true` but no `<|CALLBACK|>` is emitted.
   - Marks `cooldownCompliant: false` when `<|CALLBACK|>` is emitted during `step.expectCooldownBlock === true` or `step.expectSeriousnessGate === true`.
3. `auditTurnHallucinationsAndProvenance`:
   - Passes (`hallucinations: []`, `provenanceValidCount === totalItems`) when all DB facts, motifs, habits, and intents reference valid `EpisodicMemory` IDs and reply contains no invalidated facts.
   - Catches an ungrounded fact in `cortex.db` whose `sourceEpisodeIds` points to `'ep-nonexistent-999'`.
   - Catches a reply that mentions an invalidated fact (`VS Code` after `invalidAt !== null`).
   - Catches a reply that emits `<|CALLBACK motif-hallucinated|>` when `'motif-hallucinated'` is not in `prompt.eligibleMotifs`.
4. `evaluateSeriousnessGateCompliance`:
   - Fails if `prompt.seriousness.isSeriousOrDelicate === false` on a crisis step, or if reply contains `<|ACT {"emotion":"smug"}|>` / `<|ACT {"emotion":"tease"}|>` / `<|CALLBACK ...|>`.
   - Passes when `seriousness.isSeriousOrDelicate === true` and reply uses `<|ACT {"emotion":"concerned"}|>` with zero callbacks.
5. `evaluateVoiceConsistencyRubric`:
   - Scores $\ge 0.85$ for authentic PT-BR studio replies with `<|ACT|>` markers.
   - Penalizes corporate slop (`"Certamente! Como uma IA..."`), missing `<|ACT|>` markers, or echoed `[2026-10-01 23:30]` timestamps down to $< 0.55$.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/evals/test/judges.test.ts`
Expected: FAIL (`Cannot find module '../src/judges'`).

- [ ] **Step 3: Implement `packages/evals/src/judges.ts`**

Create `packages/evals/src/judges.ts` implementing:
- `extractCallbackMotifIds(rawReply: string): string[]`
- `extractActEmotions(rawReply: string): AshyEmotion[]`
- `evaluateStepMemoryRecallAndPrecision(step: ScenarioStep, prompt: ComposedTurnPrompt, rawReply: string)`:
  - Checks `step.expectedRecallTokens` (case-insensitive) against `rawReply`.
  - Checks `step.forbiddenRecallTokens` (case-insensitive) against `rawReply`, the `[RECALLED MEMORIES & FACTS]` section of `prompt.volatileTurnContext` (active semantic facts), and `- Eligible Inside Joke [...]` lines in `prompt.userTurnContent` (`prompt.eligibleMotifs`) — excluding historical `- Episodic Memory [...]` transcript summaries so past episode summaries do not trigger false-positive precision failures on distractor/update turns.
- `evaluateCallbackAndCooldownCompliance(step: ScenarioStep, prompt: ComposedTurnPrompt, rawReply: string)`
- `auditTurnHallucinationsAndProvenance(cortex: AshyCortex, step: ScenarioStep, prompt: ComposedTurnPrompt, rawReply: string)`
- `evaluateSeriousnessGateCompliance(step: ScenarioStep, prompt: ComposedTurnPrompt, rawReply: string)`
- `evaluateAntiSlopAndFormatHygiene(rawReply: string)`
- `evaluateVoiceConsistencyRubric(params: { rawReply: string; prompt: ComposedTurnPrompt; step: ScenarioStep; llmJudgeFn?: (rubricPrompt: string) => Promise<number> }): Promise<{ score: number; breakdown: Record<string, number>; notes: string[] }>`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/evals/test/judges.test.ts`
Expected: PASS.

---

### Task 5: End-to-End M2 Orchestrator, Multi-Seed Gate Verifier & Markdown/JSON Reporter (`packages/evals/src/runner.ts` & `packages/evals/src/reporter.ts`)

**Files:**
- Create: `packages/evals/src/reporter.ts`
- Create: `packages/evals/src/runner.ts`
- Create: `packages/evals/src/index.ts`
- Create: `packages/evals/test/m2-experiment.test.ts`

- [ ] **Step 1: Write the failing end-to-end and sabotage tests in `packages/evals/test/m2-experiment.test.ts`**

Create `packages/evals/test/m2-experiment.test.ts` testing:
1. **Single-Seed Full Longitudinal Run (`runCoreExperimentM2({ seed: 0 })`):**
   - Passes all 10 M2 gates (`report.passedAllGates === true`, `report.failedGates === []`).
   - Verifies `memoryRecallRate >= 0.85`, `memoryPrecisionRate >= 0.80`, `callbackAccuracyRate >= 0.90`, `cooldownComplianceRate === 1.0`, `hallucinatedMemoryCount === 0`, `provenanceCoverageRate === 1.0`, `seriousnessGateCompliance === 1.0`, `antiSlopComplianceRate === 1.0`, `voiceScoreModelA >= 0.80`, `voiceScoreModelB >= 0.80`, and `crossModelVoiceDrift <= 0.15`.
   - Verifies Day 5 invokes `<|CALLBACK|>` under `Model A`, Day 5+2h blocks `<|CALLBACK|>` via cooldown, Day 11 recalls `Neovim` and never `VS Code` under `Model B`, Day 12 activates `Seriousness Gate` (`concerned`, zero jokes), Day 14 triggers the `deploy da API` prospective intent, and Day 18 invokes `<|CALLBACK|>` under `Model B`.
2. **Multi-Seed Invariance Gate G10 (`runMultiSeedCoreExperimentM2({ seeds: [0, 1, 2] })`):**
   - Runs across seeds `0`, `1`, and `2` (3 distinct paraphrase sets) and verifies `allPassed === true`.
3. **Adversarial Organ Sabotage Proof (Red-Team):**
   - If `modelBRunner` is replaced with a sabotaged runner that leaks invalidated `VS Code` or emits corporate slop (`"Certamente! Como uma IA..."`) or ignores cooldown/seriousness, `runCoreExperimentM2` sets `passedAllGates: false` and lists the exact failed gates in `failedGates`.
4. **Markdown Reporter (`formatCoreExperimentMarkdownReport`):**
   - Produces a human-readable Markdown report containing the M2 Gate Summary Table, `Model A` vs. `Model B` voice drift comparison, and the step-by-step longitudinal trace.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/evals/test/m2-experiment.test.ts`
Expected: FAIL (`Cannot find module '../src/index'`).

- [ ] **Step 3: Implement `packages/evals/src/reporter.ts`, `packages/evals/src/runner.ts`, and `packages/evals/src/index.ts`**

1. In `packages/evals/src/reporter.ts`:
   - Implement `formatCoreExperimentMarkdownReport(report: CoreExperimentEvalReport, multiSeedSummary?: { seeds: number[]; allPassed: boolean; reports: CoreExperimentEvalReport[] }): string`.
2. In `packages/evals/src/runner.ts`:
   - Implement `runCoreExperimentM2(options?: RunCoreExperimentM2Options): Promise<CoreExperimentEvalReport>`:
     - Creates an isolated in-memory `AshyCortex` (`createAshyCortex({ forceMemoryFallback: true })`).
     - Creates a session `session-m2-eval` and iterates through `scenario.steps` in chronological order.
     - Selects `modelARunner` for `step.phase === 'model_a'` and `modelBRunner` for `step.phase === 'model_b'`.
     - Compiles the prompt with `cortex.compileTurnPrompt({ userMessage, modelId: runner.modelId, nowMs: step.timestampMs, timeOfDayLabel: step.timeOfDayLabel, stage })`.
     - Generates the reply via `runner.generateTurnReply(prompt, step)`.
     - Parses markers with `createTailSafeMarkerParser` (`@ashy/llm`).
     - Appends user and assistant `ChatMessageRecord`s to `cortex`, calls `cortex.indexTurnMemory`, `cortex.recordEmotionPulse`, `cortex.recordJokeCallback` (for any invoked motif IDs existing in `cortex.db`), and `cortex.reviewTurnMemories`.
     - If `step.consolidateAfterTurn` is true, runs `await cortex.consolidateSessionMemories({ sessionId: session.id, nowMs: step.timestampMs, force: true })`.
     - Evaluates all Tier 1 and Tier 2 judges for the step.
     - Computes aggregate `CoreExperimentMetricSummary` and checks every threshold in `M2_GATE_THRESHOLDS`.
     - Validates the final object with `v.parse(CoreExperimentEvalReportSchema, report)` and closes `cortex`.
   - Implement `runMultiSeedCoreExperimentM2(options?: { seeds?: readonly number[]; modelAId?: string; modelBId?: string })`.
3. In `packages/evals/src/index.ts`:
   - Export all public types and functions from `./scenarios`, `./simulators`, `./judges`, `./runner`, and `./reporter`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/evals/test/m2-experiment.test.ts`
Expected: PASS.

---

### Task 6: CLI Runner (`scripts/run-m2-eval.mjs`) & Generated Report Artifacts (`docs/evals/latest-m2-report.md` & `.json`)

**Files:**
- Create: `scripts/run-m2-eval.mjs`
- Modify: `package.json`
- Create: `docs/evals/latest-m2-report.json`
- Create: `docs/evals/latest-m2-report.md`

- [ ] **Step 1: Implement `scripts/run-m2-eval.mjs` and add `"eval:m2"` to root `package.json`**

1. Create `scripts/run-m2-eval.mjs` using Vite's `createServer({ configFile: false, root: rootDir, server: { middlewareMode: true, hmr: false }, appType: 'custom', resolve: { alias: ... } })` and `server.ssrLoadModule('/packages/evals/src/index.ts')` so it executes TypeScript workspace modules natively with zero extra dependencies:
   - Supports `--seed=<number>` (default runs seeds `[0, 1, 2]` via `runMultiSeedCoreExperimentM2` and writes seed `0` as primary JSON + multi-seed summary in Markdown).
   - Writes `docs/evals/latest-m2-report.json` and `docs/evals/latest-m2-report.md`.
   - Prints a concise console table of all 10 M2 gates (`G1`–`G10`).
   - Exits with code `1` if any gate fails.
2. In root `package.json`, add `"eval:m2": "node scripts/run-m2-eval.mjs"` to `"scripts"`.

- [ ] **Step 2: Run `pnpm eval:m2` to generate and verify the report artifacts**

Run: `pnpm eval:m2`
Expected: PASS (exit code `0`, writes `docs/evals/latest-m2-report.json` and `docs/evals/latest-m2-report.md` with `passedAllGates: true`).

---

### Task 7: Host Kernel, Transport & Desktop Hub "Experimento Central (M2 — Portabilidade da Alma)" Panel (`apps/desktop`)

**Files:**
- Modify: `apps/desktop/src/host/kernel.ts`
- Modify: `apps/desktop/src/host/vite-host-plugin.ts`
- Modify: `apps/desktop/src/services/ashy-host-client.ts`
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/__tests__/phase3-m2-eval-ui.test.tsx`

- [ ] **Step 1: Write the failing UI & RPC integration test in `apps/desktop/src/__tests__/phase3-m2-eval-ui.test.tsx`**

Create `apps/desktop/src/__tests__/phase3-m2-eval-ui.test.tsx` testing:
1. `kernel.runCoreExperimentEval({ seed: 1 })` and `dispatchHostRpc(kernel, 'runCoreExperimentEval', { seed: 1 })` run the full 3-week Model A $\rightarrow$ Model B evaluation on an isolated Cortex without polluting the kernel's user sessions/messages, cache `lastEvalReport` on the kernel's `getBootstrapSnapshot()`, and reject invalid RPC arguments (e.g., negative seed or oversized `modelAId`).
2. Rendering `<App />`, navigating to the `Nossa história` (`tab-story`) tab, selecting seed `1` in `[data-testid="select-m2-eval-seed"]`, and clicking `[data-testid="btn-run-m2-eval"]` triggers `runCoreExperimentEval`, renders `[data-testid="m2-eval-status-badge"]` as `APROVADO`, displays the metric badges (`Recall`, `Zero Alucinações`, `Seriousness Gate`, `Deriva de Voz A → B`), and lists the longitudinal steps (`day1-first-meeting-and-joke` .. `day18-model-b-inside-joke-callback`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/desktop/src/__tests__/phase3-m2-eval-ui.test.tsx`
Expected: FAIL (`kernel.runCoreExperimentEval is not a function`).

- [ ] **Step 3: Wire `runCoreExperimentEval` across Kernel, RPC Transport, Host Client, Store, and `<App />`**

1. **`apps/desktop/src/host/kernel.ts`:**
   - Import `runCoreExperimentM2` from `@ashy/evals` and `RunCoreExperimentInputSchema`, `type CoreExperimentEvalReport`, `type RunCoreExperimentInput` from `@ashy/shared`.
   - Maintain `let lastEvalReport: CoreExperimentEvalReport | null = null` inside `createAshyHostKernel` and include `lastEvalReport` in `buildSnapshot(...)`.
   - Implement `async runCoreExperimentEval(rawInput?: RunCoreExperimentInput): Promise<CoreExperimentEvalReport>`:
     - Validate `const input = rawInput ? v.parse(RunCoreExperimentInputSchema, rawInput) : {}`.
     - Run `const report = await runCoreExperimentM2({ seed: input.seed ?? 0, modelAId: input.modelAId, modelBId: input.modelBId })`.
     - Store `lastEvalReport = report` and return `report`.
2. **`apps/desktop/src/host/vite-host-plugin.ts`:**
   - Import `type { CoreExperimentEvalReport, RunCoreExperimentInput }` from `@ashy/shared` (**strictly `import type`** to preserve the Vite build invariant!).
   - Add `'runCoreExperimentEval'` to `ALLOWED_RPC_METHODS`.
   - In `dispatchHostRpc`, handle `case 'runCoreExperimentEval'`: validate optional `{ seed?: number, modelAId?: string, modelBId?: string }` (checking integer `seed` in `0..999` and non-empty strings without `\0` up to 160 chars) and call `kernel.runCoreExperimentEval(obj)`.
3. **`apps/desktop/src/services/ashy-host-client.ts`:**
   - Add `runCoreExperimentEval(input?: RunCoreExperimentInput): Promise<CoreExperimentEvalReport>` to both `createPreloadHostBridge` and `createHttpSseHostBridge`.
4. **`apps/desktop/src/store/useAshyStore.ts`:**
   - Add `lastEvalReport: CoreExperimentEvalReport | null` and `isRunningEval: boolean` to `AshyDesktopState` (and reset `lastEvalReport: null, isRunningEval: false` inside `resetAshyStore()` / `resetStoreForTesting()`).
   - Hydrate `lastEvalReport: snapshot.lastEvalReport ?? current.lastEvalReport` in `applyBootstrapSnapshot`.
   - Implement `runCoreExperimentEval: (input?: RunCoreExperimentInput) => Promise<CoreExperimentEvalReport>` calling `getAshyHostBridge().runCoreExperimentEval(input)` and updating `lastEvalReport` and `isRunningEval`.
5. **`apps/desktop/src/App.tsx`:**
   - In `VIEW 3: NOSSA HISTÓRIA` (`state.activeTab === 'story'`), inside the right-hand `<aside className="ashy-settings-column">`, add `<section className="ashy-preview-card" data-testid="m2-eval-panel">`:
     - Header: **"Experimento Central (M2 — Portabilidade da Alma)"** + status badge (`data-testid="m2-eval-status-badge"`: `APROVADO` / `REPROVADO` / `Pronto para rodar`).
     - Controls: Seed selector (`data-testid="select-m2-eval-seed"`, options `Seed 0 (Canônico)`, `Seed 1 (Paráfrase A)`, `Seed 2 (Paráfrase B)`) and button **"Rodar Diagnóstico M2 (Modelo A → B)"** (`data-testid="btn-run-m2-eval"`).
     - When `state.lastEvalReport` is present, render metric summary pills (`Recall`, `Precisão`, `Callbacks`, `Zero Alucinação`, `Seriousness Gate`, `Deriva A → B`) and a collapsible/scrollable step timeline (`data-testid="m2-eval-steps-list"`) showing Day, Phase (`Model A` vs `Model B`), user utterance, Ashy reply, and pass badge.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/desktop/src/__tests__/phase3-m2-eval-ui.test.tsx`
Expected: PASS.

---

### Task 8: Phase 3 Organ Wire-Back Audit (`scripts/verify-phase3-wireback.mjs`)

**Files:**
- Create: `scripts/verify-phase3-wireback.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/verify-phase3-wireback.mjs` and wire into `package.json`**

1. Create `scripts/verify-phase3-wireback.mjs` checking:
   - Forbidden patterns:
     - `packages/evals/src/simulators.ts` must NOT import `CortexDatabase` or `createCortexDatabase` (enforcing the Anti-Cheating Rule).
     - `apps/desktop/src/host/vite-host-plugin.ts` must NOT have value imports from `@ashy/shared`.
   - Required end-to-end organ wiring (`producer` + `reader` + `test`) for all 6 Phase 3 organs:
     1. `Phase 3 M2 Shared Schemas & Thresholds` (`packages/shared/src/host-protocol.ts` $\rightarrow$ `packages/evals/src/runner.ts` $\rightarrow$ `packages/shared/src/__tests__/host-protocol.test.ts`)
     2. `Longitudinal 3-Week Coexistence Scenario & Seeded SimulatedUser` (`packages/evals/src/scenarios.ts` $\rightarrow$ `packages/evals/src/runner.ts` $\rightarrow$ `packages/evals/test/scenarios.test.ts`)
     3. `Dual-Mode Honest Model Simulators (Model A -> Model B)` (`packages/evals/src/simulators.ts` $\rightarrow$ `packages/evals/src/runner.ts` $\rightarrow$ `packages/evals/test/simulators.test.ts`)
     4. `Two-Tier Hybrid Judging Engine (Provenance, Hallucinations, Voice Rubric)` (`packages/evals/src/judges.ts` $\rightarrow$ `packages/evals/src/runner.ts` $\rightarrow$ `packages/evals/test/judges.test.ts`)
     5. `M2 CLI Runner & Generated Report Artifacts` (`scripts/run-m2-eval.mjs` $\rightarrow$ `docs/evals/latest-m2-report.md` $\rightarrow$ `packages/evals/test/m2-experiment.test.ts`)
     6. `Desktop Hub M2 Benchmark Panel (Modelo A -> B)` (`apps/desktop/src/host/kernel.ts` $\rightarrow$ `apps/desktop/src/App.tsx` $\rightarrow$ `apps/desktop/src/__tests__/phase3-m2-eval-ui.test.tsx`)
2. In root `package.json`, update `"verify:wireback"` to:
   `"verify:wireback": "node scripts/verify-phase1-wireback.mjs && node scripts/verify-phase2-wireback.mjs && node scripts/verify-phase3-wireback.mjs"`

- [ ] **Step 2: Run full verification suite**

Run:
1. `pnpm verify:wireback`
2. `pnpm eval:m2`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm build`
Expected: 100% PASS across all wireback audits, M2 gates, TypeScript typechecks, Vitest suites, and Vite production build.
