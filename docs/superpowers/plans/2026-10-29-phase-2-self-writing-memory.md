# Ashy Phase 2 — Self-Writing Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Ashy to autonomously segment real conversations into episodes, extract structured memories (`SemanticFact`, `RelationalMotif`, `UserHabit`, `ProspectiveIntent`) with mandatory episode provenance and `Predict -> Calibrate` conflict resolution, compute hybrid semantic + lexical embeddings so inside jokes trigger naturally without keyword repetition (exact Days 1, 5, and 18 canonical test from `ASHY_PROJECT_CONTEXT.md`), run the post-turn FSRS-6 review loop, inject habits and prospective intents into `SoulComposer`, and give the user full memory governance (`approved` vs. `pending_review` quarantine per category + complete deletion).

**Architecture:** Seven cohesive organs across `@ashy/shared`, `@ashy/llm`, `@ashy/cortex`, and `apps/desktop`:
1. **`EmbeddingProvider` (`@ashy/llm`):** 128-D L2-normalized deterministic semantic embedding engine (64 PT-BR/EN concept cluster dimensions + 64 signed stem/trigram hash dimensions) + optional `/v1/embeddings` OpenAI-compatible remote provider (`computeCosineSimilarity128` exported without colliding with `@ashy/cortex`'s `cosineSimilarity`).
2. **Migration v3 & Governance Storage (`@ashy/cortex`):** Adds `approval_status`, `embedding_json`, `source_episode_id`, `consolidated_episode_id`, and `memory_governance_settings` to `ashy.db` (and `MemoryStorageAdapter`). Preserves raw `list*()` methods for UI snapshots (`AshyBootstrapSnapshot`) while filtering `approvalStatus === 'pending_review'` out of `listActiveSemanticFacts`, `listSemanticFacts({ activeOnly: true })`, `searchEpisodicMemoriesHybrid` (default), `selectEligibleMotifs`, and `SoulComposer`.
3. **Hybrid Semantic Motif & Episodic Recall (`@ashy/cortex`):** Automatically embeds episodes, facts, and motifs on upsert when `input.embedding` is omitted (preserving explicit embeddings for existing 3-D/4-D unit tests while handling dimension mismatches safely in `fsrs-ranker.ts`); upgrades `computeMotifRelevance` to fuse lexical overlap with 128-D semantic cosine similarity so the exact canonical Day 1 -> Day 5 -> Day 18 *"fantasma no backend"* dialogue from `ASHY_PROJECT_CONTEXT.md` (lines 84–95) passes without artificial trigger words.
4. **Episode Segmenter & Post-Episode Structured Extractor (`@ashy/cortex`):** Detects soft ($\ge 30\text{ min}$ gap, $\ge 6$ turns, or topic shift `< 0.18` cosine similarity) and hard ($> 3\text{ h}$ gap or session switch/shutdown) boundaries on unconsolidated chat messages, extracts structured candidates via LLM JSON (validated by Valibot) with anti-hallucination evidence verification and deterministic fallback, supersedes per-turn draft `ep-turn-*` episodes from that batch to prevent FTS5 duplication, and runs `runPredictCalibrateConsolidation` with quarantine-safe fact invalidation.
5. **Post-Turn FSRS-6 Loop (`@ashy/cortex` + `TurnOrchestrator`):** Evaluates retrieved episodic memories against the assistant's reply and `<|CALLBACK|>` markers after each turn using normalized `queryRelevance = Math.max(vectorSimilarity, Math.min(1, bm25Score / 2.5))` (`easy`, `good`, `hard`) and persists updated FSRS stability/difficulty.
6. **Full `SoulComposer` Context (`@ashy/cortex`):** Exposes `retrievedMemories` and `eligibleMotifs` on `ComposedTurnPrompt`, injects active `UserHabit`s (`[USER HABITS & RHYTHM]`) in `volatileTurnContext`, and injects due/context-matched `ProspectiveIntent`s (`[Context]`) in `userTurnContent`.
7. **Host Bridge & Hub Governance UI (`apps/desktop`):** Wires `consolidateSessionMemories` (on boundary, manual trigger, `selectSession`, and `stop()`), `approveMemoryItem`, `setMemoryGovernancePolicy`, and expanded `deleteMemoryItem` through `AshyHostKernel`, `vite-host-plugin`, `ashy-host-client`, `useAshyStore`, and the Hub Memory Inspector.

**Tech Stack:** TypeScript 5.8+, React 19, Zustand 5, `node:sqlite` (WAL + FTS5), Valibot 1.x, Vitest 3.

**Spec:** [`docs/superpowers/specs/2026-10-29-phase-2-self-writing-memory-design.md`](../specs/2026-10-29-phase-2-self-writing-memory-design.md)

---

## Global Invariants & Red-Team Safeguards

- **No Memory Without Provenance:** Every automatically extracted `SemanticFact`, `RelationalMotif`, `UserHabit`, and `ProspectiveIntent` must carry a non-empty `sourceEpisodeIds` / `originEpisodeId` / `sourceEpisodeId` pointing to a real `EpisodicMemory` in `ashy.db`.
- **Evidence Grounding:** Candidate extractions from LLM JSON must include an `evidenceQuote` whose significant tokens appear in the episode transcript; ungrounded hallucinations are discarded before DB insertion.
- **Quarantine Isolation & Safe Contradiction Handling (`pending_review`):**
  - `listSemanticFacts()`, `listEpisodicMemories()`, `listRelationalMotifs()`, `listUserHabits()`, and `listProspectiveIntents()` (without `activeOnly: true`) return **all** records including `pending_review` so `AshyBootstrapSnapshot` delivers them to the UI for inspection/approval.
  - `listSemanticFacts({ activeOnly: true })`, `listActiveSemanticFacts()`, `searchEpisodicMemoriesHybrid` (default), `selectEligibleMotifs`, and `SoulComposer` strictly exclude `approvalStatus === 'pending_review'`.
  - When `requireConfirmation` is enabled for `facts`, newly extracted facts enter `pending_review` **without** overwriting existing approved facts to `pending_review` and **without** invalidating (`invalidAt`) an existing approved fact until `approveMemoryItem('fact', id)` is invoked.
- **Zero Extra LLM Fetch Calls During Standard `sendTurn`:** Background turn-boundary consolidation inside `TurnOrchestrator.sendTurn` uses deterministic consolidation by default so `sendTurn` makes exactly 1 LLM `fetch` call per turn (preserving all `mockFetch` call-count assertions in `host-kernel.test.ts`).
- **Complete Deletion:** Deleting a memory item removes it from the primary SQLite table, `episodic_fts`, and the in-memory mirror/embedding cache, and updates all corresponding arrays in `useAshyStore`.

---

## File Structure Map

| File Path | Action | Responsibility |
| :--- | :--- | :--- |
| `packages/shared/src/memory-types.ts` | Modify | Add `MemoryApprovalStatus` (`'approved' \| 'pending_review'`), `MemoryGovernanceCategory`, `MemoryGovernancePolicy`, `DEFAULT_MEMORY_GOVERNANCE_POLICY`, and optional `approvalStatus`, `embedding`, `sourceEpisodeId` fields to memory schemas. |
| `packages/shared/src/host-protocol.ts` | Modify | Add `consolidatedEpisodeId` to `ChatMessageRecord`; add `governancePolicy` to `AshyBootstrapSnapshot['memories']`; add `consolidateSessionMemories`, `approveMemoryItem`, `setMemoryGovernancePolicy`, and expand `deleteMemoryItem` on `AshyHostBridge`. |
| `packages/shared/src/__tests__/host-protocol.test.ts` | Modify | Test new Phase 2 memory governance schemas and protocol contracts. |
| `packages/llm/src/embeddings.ts` | Create | `EmbeddingProvider` interface, `createDeterministicSemanticEmbeddingProvider` (128-D concept clusters + signed n-gram/stem hashing), `createOpenAICompatibleEmbeddingProvider`, `createResilientEmbeddingProvider`, and `computeCosineSimilarity128`. |
| `packages/llm/src/index.ts` | Modify | Export `./embeddings`. |
| `packages/llm/test/embeddings.test.ts` | Create | Unit & adversarial tests for 128-D semantic embeddings, exact verbatim Day 1 / Day 5 / Day 18 phrases from `ASHY_PROJECT_CONTEXT.md`, and remote `/v1/embeddings` fallback. |
| `packages/cortex/src/memory/fsrs-ranker.ts` | Modify | Handle vector dimension mismatches gracefully in `rankEpisodicMemories` (recomputing 128-D embedding on the fly when `query.embedding.length === 128` and `memory.embedding.length !== 128`). |
| `packages/cortex/src/relational/inside-joke-engine.ts` | Modify | Upgrade `computeMotifRelevance` and `selectEligibleMotifs` to combine lexical overlap with 128-D semantic cosine similarity and filter out `pending_review` motifs. |
| `packages/cortex/src/__tests__/inside-joke-semantic.test.ts` | Create | Canonical regression test for Day 1, Day 5, Day 5+2h (cooldown lock), and Day 18 ("fantasma no backend") using the exact verbatim strings from `ASHY_PROJECT_CONTEXT.md` lines 84–95. |
| `packages/cortex/src/db/cortex-db.ts` | Modify | Migration v3 (`approval_status`, `embedding_json`, `source_episode_id`, `consolidated_episode_id`, `memory_governance_settings`), auto-embedding on upsert, governance CRUD, quarantine-safe `approveMemoryItem`, and unconsolidated message tracking. |
| `packages/cortex/src/__tests__/phase1-persistence.test.ts` | Modify | Update expected applied migrations to `[1, 2, 3]` and add Migration v3 + governance + hybrid auto-embedding persistence tests. |
| `packages/cortex/src/memory/episode-segmenter.ts` | Create | `detectEpisodeBoundary` (soft $\ge 30\text{ min}$ / $\ge 6$ turns / topic shift `< 0.18`; hard $> 3\text{ h}$ / `session_switch` / `force`) and message batching. |
| `packages/cortex/src/memory/episode-extractor.ts` | Create | `EpisodeExtractionSchema` (Valibot), `verifyExtractionEvidence`, LLM JSON extraction prompt + parser, and rich deterministic extractor fallback. |
| `packages/cortex/src/memory/fsrs-turn-loop.ts` | Create | `evaluateTurnMemoryUsage` post-turn FSRS-6 evaluator (`easy`, `good`, `hard` ratings using normalized `queryRelevance`). |
| `packages/cortex/src/prompt/soul-composer.ts` | Modify | Expose `retrievedMemories` & `eligibleMotifs` on `ComposedTurnPrompt`, filter `pending_review` items, inject `[USER HABITS & RHYTHM]` in `volatileTurnContext`, and inject active/due `Prospective Intent` lines in `userTurnContent` (`[Context]`). |
| `packages/cortex/src/ashy-cortex.ts` | Modify | Upgrade `indexTurnMemory` (governance + `Predict -> Calibrate`), add `consolidateSessionMemories` (superseding draft `ep-turn-*` episodes from the batch), `reviewTurnMemories`, governance helpers, and pass `userHabits` / `prospectiveIntents` in `compileTurnPrompt`. |
| `packages/cortex/src/index.ts` | Modify | Export Phase 2 modules (`episode-segmenter`, `episode-extractor`, `fsrs-turn-loop`). |
| `packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts` | Create | End-to-end Cortex tests for episode segmentation (including topic shift), structured extraction with evidence check, `Predict -> Calibrate` contradiction invalidation, FSRS-6 post-turn review, habits/intents prompt injection, quarantine governance, and full Day 1->5->18 scenario. |
| `apps/desktop/src/test/fixtures/demo-seed.ts` | Modify | Remove toy 4-D `embedding` arrays from demo episodes so `CortexDatabase` generates canonical 128-D semantic embeddings. |
| `apps/desktop/src/host/turn-orchestrator.ts` | Modify | Run post-turn FSRS-6 review loop (`cortex.reviewTurnMemories`) and trigger deterministic boundary episode consolidation when `detectEpisodeBoundary` fires. |
| `apps/desktop/src/host/kernel.ts` | Modify | Implement `consolidateSessionMemories`, `approveMemoryItem`, `setMemoryGovernancePolicy`, and expanded `deleteMemoryItem`; trigger consolidation on `selectSession` and `stop()` (before `container.stop()`). |
| `apps/desktop/src/host/vite-host-plugin.ts` | Modify | Whitelist and validate `consolidateSessionMemories`, `approveMemoryItem`, `setMemoryGovernancePolicy`, and expanded `deleteMemoryItem` kinds. |
| `apps/desktop/src/services/ashy-host-client.ts` | Modify | Expose the new Phase 2 RPC methods on `createPreloadHostBridge` and `createHttpSseHostBridge`. |
| `apps/desktop/src/store/useAshyStore.ts` | Modify | Add `memoryGovernancePolicy`, `consolidateSessionMemories`, `approveMemoryItem`, `setMemoryGovernancePolicy`, expanded `deleteMemoryItem`, and pass `userHabits` + `prospectiveIntents` in `compilePromptFromState`. |
| `apps/desktop/src/App.tsx` | Modify | Add Memory Governance toggles (auto vs. confirm per category), Pending Review quarantine badge + Approve/Discard buttons, and "Consolidar Agora" action in Memory Inspector. |
| `apps/desktop/src/__tests__/phase2-memory-ui.test.tsx` | Create | Integration tests for quarantine approval/discard, governance toggles, post-turn FSRS review, and live memory consolidation via `AshyHostBridge`. |
| `scripts/verify-phase2-wireback.mjs` | Create | Automated Phase 2 Organ Wire-Back Audit verifying all 7 Phase 2 organs have live producer, live consumer, and passing tests. |
| `package.json` | Modify | Update `verify:wireback` script to run both Phase 1 and Phase 2 wireback audits. |

---

### Task 1: Phase 2 Memory Governance Schemas & Host Protocol Contracts (`@ashy/shared`)

**Files:**
- Modify: `packages/shared/src/memory-types.ts`
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `packages/shared/src/__tests__/host-protocol.test.ts`

- [x] **Step 1: Write the failing test**

In `packages/shared/src/__tests__/host-protocol.test.ts`, append tests for `MemoryApprovalStatusSchema`, `MemoryGovernanceCategorySchema`, optional `approvalStatus` / `sourceEpisodeId` / `embedding` fields on memory schemas, and `DEFAULT_MEMORY_GOVERNANCE_POLICY`:

```ts
  it('validates Phase 2 approvalStatus, sourceEpisodeId, and governance categories on memory schemas', () => {
    const factRes = v.safeParse(SemanticFactSchema, {
      id: 'fact-1',
      category: 'preference',
      subject: 'user',
      predicate: 'prefers_editor',
      object: 'Neovim',
      confidence: 0.9,
      sourceEpisodeIds: ['ep-1'],
      validFrom: 1730000000000,
      invalidAt: null,
      approvalStatus: 'pending_review',
      embedding: [0.25, -0.5, 0.75],
    })
    expect(factRes.success).toBe(true)
    if (factRes.success) {
      expect(factRes.output.approvalStatus).toBe('pending_review')
    }

    const habitRes = v.safeParse(UserHabitSchema, {
      id: 'habit-1',
      patternKey: 'late_night_coder',
      description: 'Costuma programar entre 23h e 03h',
      confidence: 0.85,
      observationCount: 3,
      updatedAt: 1730000000000,
      sourceEpisodeId: 'ep-1',
      approvalStatus: 'approved',
    })
    expect(habitRes.success).toBe(true)
    expect(DEFAULT_MEMORY_GOVERNANCE_POLICY).toEqual({
      facts: false,
      episodes: false,
      jokes: false,
      habits: false,
      intents: false,
    })
  })
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/host-protocol.test.ts`
Expected: FAIL (`DEFAULT_MEMORY_GOVERNANCE_POLICY is not defined`).

- [x] **Step 3: Implement schema and protocol extensions**

1. In `packages/shared/src/memory-types.ts`:
   - Add `MEMORY_APPROVAL_STATUSES = ['approved', 'pending_review'] as const`, `MemoryApprovalStatus`, and `MemoryApprovalStatusSchema = v.picklist(MEMORY_APPROVAL_STATUSES)`.
   - Add `MEMORY_GOVERNANCE_CATEGORIES = ['facts', 'episodes', 'jokes', 'habits', 'intents'] as const`, `MemoryGovernanceCategory`, `MemoryGovernanceCategorySchema`, `MemoryGovernancePolicy = Record<MemoryGovernanceCategory, boolean>`, and `DEFAULT_MEMORY_GOVERNANCE_POLICY`.
   - Add `approvalStatus: v.optional(MemoryApprovalStatusSchema)` to `EpisodicMemorySchema`, `SemanticFactSchema`, `RelationalMotifSchema`, `UserHabitSchema`, and `ProspectiveIntentSchema`.
   - Add `embedding: v.optional(v.array(FiniteNumberSchema))` to `SemanticFactSchema` and `RelationalMotifSchema`.
   - Add `sourceEpisodeId: v.optional(NonEmptyStringSchema)` to `UserHabitSchema` and `ProspectiveIntentSchema`.
2. In `packages/shared/src/host-protocol.ts`:
   - Add `consolidatedEpisodeId?: string | null` to `ChatMessageRecord`.
   - Add `governancePolicy?: MemoryGovernancePolicy` to `AshyBootstrapSnapshot['memories']`.
   - Define `DeletableMemoryKind = 'fact' | 'episode' | 'joke' | 'habit' | 'intent' | 'milestone'` and `ApprovableMemoryKind = 'fact' | 'episode' | 'joke' | 'habit' | 'intent'`.
   - Expand `deleteMemoryItem(input: { kind: DeletableMemoryKind; id: string }): Promise<void>`.
   - Add to `AshyHostBridge`:
     - `consolidateSessionMemories(input?: { sessionId?: string; force?: boolean }): Promise<AshyBootstrapSnapshot>`
     - `approveMemoryItem(input: { kind: ApprovableMemoryKind; id: string }): Promise<AshyBootstrapSnapshot>`
     - `setMemoryGovernancePolicy(input: { category: MemoryGovernanceCategory; requireConfirmation: boolean }): Promise<MemoryGovernancePolicy>`

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/src/__tests__/host-protocol.test.ts`
Expected: PASS.

---

### Task 2: Resilient 128-D Semantic & Remote `EmbeddingProvider` (`@ashy/llm`)

**Files:**
- Create: `packages/llm/src/embeddings.ts`
- Modify: `packages/llm/src/index.ts`
- Create: `packages/llm/test/embeddings.test.ts`

- [x] **Step 1: Write the failing test**

Create `packages/llm/test/embeddings.test.ts` testing:
1. `createDeterministicSemanticEmbeddingProvider()` produces deterministic 128-D L2-normalized vectors ($\|\mathbf{v}\|_2 \approx 1.0$) and returns zero vector for empty/whitespace strings.
2. Semantic concept clusters align the **exact verbatim Day 1 dialogue** from `ASHY_PROJECT_CONTEXT.md` (`"Esse código tá tão amaldiçoado que deve ter um fantasma no backend. Eu já tava pensando em chamar um exorcista de JavaScript."`) with both **exact Day 5** (`"Lembra daquele bug? Consegui resolver."`) and **exact Day 18** (`"Fui mexer numa biblioteca antiga e deu erro."`) with cosine similarity $\ge 0.30$, while unrelated sentences (`"Comprei pão e leite na padaria hoje de manhã"`) have cosine similarity $< 0.12$.
3. `createOpenAICompatibleEmbeddingProvider()` calls `POST {baseUrl}/embeddings` and falls back cleanly to the deterministic 128-D provider on HTTP error or timeout when wrapped in `createResilientEmbeddingProvider()`.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/llm/test/embeddings.test.ts`
Expected: FAIL (`Cannot find module '../src/embeddings'`).

- [x] **Step 3: Implement `packages/llm/src/embeddings.ts` and export from `packages/llm/src/index.ts`**

Implement:
- `EMBEDDING_DIMENSIONS = 128`
- Curated PT-BR/EN concept clusters across dims `0..63` so related software/companion concepts activate shared dimensions:
  - Cluster *Cursed Code / Debugging / Haunting / Legacy Library Failure*: `codigo, amaldicoado, fantasma, assombracao, exorcista, padre, bug, erro, falha, crash, quebrou, travou, biblioteca, antiga, legado, dependencia, pacote, npm, javascript, backend, rota, resolver, consegui, lembra, daquele` (activating shared primary & secondary concept dimensions so Day 1, Day 5, and Day 18 strongly align in cosine space!).
  - Plus clusters for *Database/SQLite/Storage*, *Architecture/API/Deploy*, *Frontend/UI/Design*, *Editor/Tools/Terminal*, *Late-Night/Schedule/Habits*, *Future Plans/Deadlines/Deploy*, *Emotion/Burnout/Support*, etc.
- Stem & char-trigram signed FNV-1a feature hashing across dims `64..127`.
- `computeCosineSimilarity128(a, b)` with safe bounds checking (`[-1, 1]`).
- `embedTextSync128(text: string): number[]` (synchronous fast path for `CortexDatabase` and `computeMotifRelevance`).
- `createDeterministicSemanticEmbeddingProvider()`
- `createOpenAICompatibleEmbeddingProvider({ baseUrl, apiKey, modelId, fetchImpl, timeoutMs })`
- `createResilientEmbeddingProvider({ remote?, fallback? })`

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/llm/test/embeddings.test.ts`
Expected: PASS.

---

### Task 3: Hybrid Semantic + Lexical Inside-Joke Relevance (`@ashy/cortex`)

**Files:**
- Modify: `packages/cortex/src/relational/inside-joke-engine.ts`
- Create: `packages/cortex/src/__tests__/inside-joke-semantic.test.ts`

- [x] **Step 1: Write the failing test**

Create `packages/cortex/src/__tests__/inside-joke-semantic.test.ts` reproducing the **exact verbatim dialogue** from `ASHY_PROJECT_CONTEXT.md` (lines 84–95) and `ASHY_ROADMAP.md` (lines 26, 109, 115):
- **Dia 1 (`day1Ms`):** motif seeded exclusively from the Day 1 exchange (`“Esse código tá tão amaldiçoado que deve ter um fantasma no backend.”` / `“Eu já tava pensando em chamar um exorcista de JavaScript.”`), with `motif: 'fantasma no backend / exorcista de JavaScript'`, `originSummary: 'Esse código tá tão amaldiçoado que deve ter um fantasma no backend'`, `triggerCues: ['fantasma no backend', 'código amaldiçoado', 'exorcista de javascript']` (note: zero artificial `"bug"`, `"biblioteca"`, or `"erro"` in `triggerCues`!).
- **Dia 5 (`day1Ms + 4 * 24 * 3600_000`):** user says `"Lembra daquele bug? Consegui resolver."` -> `selectEligibleMotifs` returns the motif (`relevanceScore >= 0.20`). After `recordMotifInvocation(motif, true, day5Ms)`, stage becomes `'inside_joke'` and cooldown locks it (`cooldownHours = 36`).
- **Dia 5 + 2h:** user says `"Apareceu outro bug estranho no código."` -> `selectEligibleMotifs` returns `[]` (`isCooldownLocked === true`).
- **Dia 18 (`day5Ms + 13 * 24 * 3600_000`):** user says `"Fui mexer numa biblioteca antiga e deu erro."` -> `selectEligibleMotifs` returns the motif (`relevanceScore >= 0.20`).
- **Seriousness Gate & Quarantine:** when `isSeriousContext: true` is passed, or when `motif.approvalStatus === 'pending_review'`, `selectEligibleMotifs` returns `[]`.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cortex/src/__tests__/inside-joke-semantic.test.ts`
Expected: FAIL (Day 5 and Day 18 return `0` relevance under lexical-only matching).

- [x] **Step 3: Upgrade `computeMotifRelevance` and `selectEligibleMotifs`**

In `packages/cortex/src/relational/inside-joke-engine.ts`:
- Import `embedTextSync128` and `computeCosineSimilarity128` from `@ashy/llm`.
- Update `computeMotifRelevance(motif: Pick<RelationalMotif, 'motif' | 'triggerCues'> & { originSummary?: string; embedding?: readonly number[] }, contextText: string, queryEmbedding?: readonly number[])`:
  - Compute `lexicalScore` as before.
  - Compute `contextVec = queryEmbedding && queryEmbedding.length === 128 ? queryEmbedding : embedTextSync128(contextText)`.
  - Compute `motifVec = motif.embedding && motif.embedding.length === 128 ? motif.embedding : embedTextSync128([motif.motif, motif.originSummary ?? '', ...motif.triggerCues].join(' '))`.
  - Compute `semanticSim = computeCosineSimilarity128(contextVec, motifVec)`.
  - Combine: `const combined = Math.min(1, Math.max(lexicalScore, semanticSim >= 0.22 ? 0.85 * semanticSim + 0.25 * lexicalScore : lexicalScore))`.
  - If `semanticSim >= 0.22` and `matchedCues.length === 0`, push `'semantic_context_match'` into `matchedCues`.
- In `selectEligibleMotifs`:
  - Skip any motif where `motif.stage === 'dormant'` or `motif.approvalStatus === 'pending_review'`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cortex/src/__tests__/inside-joke-semantic.test.ts`
Expected: PASS.

---

### Task 4: `CortexDatabase` Migration v3, Auto-Embeddings, Dimension Guard & Governance Storage (`@ashy/cortex`)

**Files:**
- Modify: `packages/cortex/src/memory/fsrs-ranker.ts`
- Modify: `packages/cortex/src/db/cortex-db.ts`
- Modify: `packages/cortex/src/__tests__/phase1-persistence.test.ts`
- Modify: `apps/desktop/src/test/fixtures/demo-seed.ts`

- [x] **Step 1: Write the failing test**

In `packages/cortex/src/__tests__/phase1-persistence.test.ts`:
1. Update line 126 `expect(db.getAppliedMigrations().map((m) => m.version)).toEqual([1, 2, 3])`.
2. Add a test verifying:
   - Migration v3 (`v3_phase2_self_writing_memory`) is applied on database initialization.
   - `upsertEpisodicMemory`, `upsertSemanticFact`, and `upsertRelationalMotif` automatically compute and persist 128-D embeddings when `input.embedding` is omitted, and `searchEpisodicMemoriesHybrid(queryText)` automatically uses the 128-D query embedding so semantic matches without exact keyword overlap are retrieved.
   - `setMemoryGovernancePolicy('facts', true)` persists in `memory_governance_settings`; `listSemanticFacts()` still returns `pending_review` facts for UI inspection, while `listActiveSemanticFacts()` and `listSemanticFacts({ activeOnly: true })` exclude `pending_review` facts until `approveMemoryItem('fact', id)` is called (which also invalidates any older conflicting active fact with the same `(category, subject, predicate)`).
   - `listUnconsolidatedChatMessages(sessionId)` and `markChatMessagesConsolidated(messageIds, episodeId)` accurately track unconsolidated messages across restarts.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cortex/src/__tests__/phase1-persistence.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement Migration v3, dimension guard, and governance methods**

1. In `packages/cortex/src/memory/fsrs-ranker.ts`:
   - Import `embedTextSync128` from `@ashy/llm`.
   - In `rankEpisodicMemories`: when `hasQueryEmbedding` is true (`query.embedding` provided), if `memory.embedding` has a different dimension (`memory.embedding.length !== query.embedding.length`), compute a 128-D vector via `embedTextSync128(\`${memory.title} ${memory.summary} ${memory.content} ${memory.tags.join(' ')}\`)` when `query.embedding.length === 128` instead of computing a truncated dot product across mismatched dimensions.
2. In `apps/desktop/src/test/fixtures/demo-seed.ts`:
   - Remove the 4-D toy `embedding: [...]` arrays from the 3 demo episodes so `upsertEpisodicMemory` generates canonical 128-D embeddings.
3. In `packages/cortex/src/db/cortex-db.ts`:
   - Register migration `3` (`v3_phase2_self_writing_memory`) in both `MemoryStorageAdapter` and `initializeSqliteSchema()`.
   - Add `ensureColumnExists(table, column, sqlDef)` helper using `PRAGMA table_info(${table})` and add:
     - `episodic_memories.approval_status TEXT NOT NULL DEFAULT 'approved'`
     - `semantic_facts.embedding_json TEXT`
     - `semantic_facts.approval_status TEXT NOT NULL DEFAULT 'approved'`
     - `relational_motifs.embedding_json TEXT`
     - `relational_motifs.approval_status TEXT NOT NULL DEFAULT 'approved'`
     - `user_habits.source_episode_id TEXT`
     - `user_habits.approval_status TEXT NOT NULL DEFAULT 'approved'`
     - `prospective_intents.source_episode_id TEXT`
     - `prospective_intents.approval_status TEXT NOT NULL DEFAULT 'approved'`
     - `chat_messages.consolidated_episode_id TEXT`
   - Create `memory_governance_settings` table.
   - Auto-populate `embedding` (128-D via `embedTextSync128`) on `upsertEpisodicMemory`, `upsertSemanticFact`, and `upsertRelationalMotif` when `input.embedding` is undefined, and default `approvalStatus` to `'approved'` when omitted.
   - Ensure `listSemanticFacts({ activeOnly: true })` and `listActiveSemanticFacts()` filter out `approvalStatus === 'pending_review'` (while `listSemanticFacts()` without `activeOnly` returns all records for the UI snapshot).
   - Ensure `searchEpisodicMemoriesHybrid` filters out `approvalStatus === 'pending_review'` by default and auto-computes `queryEmbedding = embedTextSync128(queryText)` when `queryEmbedding` is omitted.
   - Implement `getMemoryGovernancePolicy()`, `setMemoryGovernancePolicy(category, requireConfirmation)`, `approveMemoryItem(kind, id)` (with conflict invalidation for facts), `deleteUserHabit(id)`, `deleteProspectiveIntent(id)`, `deleteMilestone(id)`, `listUnconsolidatedChatMessages(sessionId)`, and `markChatMessagesConsolidated(messageIds, episodeId)`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cortex/src/__tests__/phase1-persistence.test.ts packages/cortex/test/cortex.test.ts`
Expected: PASS.

---

### Task 5: Episode Segmenter, Post-Episode Structured Extractor & Post-Turn FSRS-6 Loop (`@ashy/cortex`)

**Files:**
- Create: `packages/cortex/src/memory/episode-segmenter.ts`
- Create: `packages/cortex/src/memory/episode-extractor.ts`
- Create: `packages/cortex/src/memory/fsrs-turn-loop.ts`
- Create: `packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts`

- [x] **Step 1: Write the failing test**

Create `packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts` testing:
1. `detectEpisodeBoundary`:
   - Returns `{ shouldConsolidate: false }` for 2 turns within 5 minutes on the same topic.
   - Returns `{ shouldConsolidate: true, boundaryType: 'soft', reason: 'idle_gap_30m' }` when gap $\ge 30\text{ min}$.
   - Returns `{ shouldConsolidate: true, boundaryType: 'soft', reason: 'turn_window_reached' }` when $\ge 6$ turns (`12` messages) accumulate.
   - Returns `{ shouldConsolidate: true, boundaryType: 'soft', reason: 'topic_shift' }` when semantic similarity between consecutive user turns drops below `0.18` after at least 2 turns.
   - Returns `{ shouldConsolidate: true, boundaryType: 'hard', reason: 'hard_gap_3h' }` when gap $> 3\text{ h}$, or `reason: 'session_switch'` / `'manual_force'` when `sessionSwitch` / `force` is passed.
2. `extractStructuredEpisode`:
   - Parses LLM JSON output via `EpisodeExtractionSchema`, verifies `evidenceQuote` against the transcript, discards hallucinated facts whose `evidenceQuote` / `object` does not appear in the transcript, and attaches `sourceEpisodeIds: [episodeId]` / `originEpisodeId: episodeId` / `sourceEpisodeId: episodeId`.
   - Falls back cleanly to deterministic extraction when LLM JSON is malformed or unavailable, extracting user facts, motifs (including the exact Day 1 `"fantasma no backend"` / `"exorcista de JavaScript"` exchange), habits, and prospective intents (`"Amanhã tenho deploy da API"`).
3. `evaluateTurnMemoryUsage`:
   - Uses normalized `queryRelevance = Math.max(item.vectorSimilarity, Math.min(1, item.bm25Score / 2.5))` (working with real `RankedEpisodicMemory` objects where `rrfScore <= 0.0645`).
   - Rates a retrieved memory as `'easy'` when referenced by `<|CALLBACK|>` or strong response overlap ($\ge 0.45$), `'good'` for moderate overlap ($\ge 0.20$), and `'hard'` when highly relevant to the query (`queryRelevance >= 0.65`) but ignored in the response.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts`
Expected: FAIL (`Cannot find module '../memory/episode-segmenter'`).

- [x] **Step 3: Implement `episode-segmenter.ts`, `episode-extractor.ts`, and `fsrs-turn-loop.ts`**

1. `packages/cortex/src/memory/episode-segmenter.ts`:
   - `SOFT_GAP_MS = 30 * 60 * 1000`, `HARD_GAP_MS = 3 * 60 * 60 * 1000`, `SOFT_TURN_COUNT = 6`, `TOPIC_SHIFT_THRESHOLD = 0.18`.
   - `detectEpisodeBoundary(messages, options?: { nowMs?: number; force?: boolean; sessionSwitch?: boolean })` returning `{ shouldConsolidate: boolean; boundaryType: 'soft' | 'hard' | null; reason: string | null; batchMessages: ChatMessageRecord[] }`.
2. `packages/cortex/src/memory/episode-extractor.ts`:
   - `EpisodeExtractionSchema` (Valibot) + `verifyExtractionEvidence(transcript, quote, value)` + `buildEpisodeExtractionPrompt(messages)` + `extractEpisodeDeterministic(episodeId, messages, nowMs)` + `extractStructuredEpisode({ episodeId, messages, generateJsonFn?, nowMs })`.
   - Ensure `extractEpisodeDeterministic` detects:
     - Explicit user declarations (`nome`, `pronomes`, `trabalho com`, `uso muito`, `prefiro`, `projeto atual`)
     - Shared motifs / metaphors (such as `"fantasma no backend"` / `"exorcista de JavaScript"` / `"padre no npm"` or messages with `<|CALLBACK|>` / playful metaphors)
     - User habits (late-night coding hours `23h..05h` or explicit routine mentions `"sempre costumo..."`, `"todo dia..."`)
     - Prospective intents (`"amanhã tenho..."`, `"semana que vem..."`, `"me lembra de..."`, `"depois preciso..."`, `"sexta tenho deploy..."`)
3. `packages/cortex/src/memory/fsrs-turn-loop.ts`:
   - `evaluateTurnMemoryUsage({ retrievedMemories, assistantText, invokedMotifIds, motifs, nowMs })` returning `{ reviewedMemories: Array<{ memory: EpisodicMemory; rating: FsrsReviewRating; usageScore: number }> }`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts`
Expected: PASS.

---

### Task 6: Wire `SoulComposer` Habits/Intents & `AshyCortex` Self-Writing Memory Pipeline (`@ashy/cortex`)

**Files:**
- Modify: `packages/cortex/src/prompt/soul-composer.ts`
- Modify: `packages/cortex/src/ashy-cortex.ts`
- Modify: `packages/cortex/src/index.ts`
- Modify: `packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts`

- [x] **Step 1: Write the failing test**

In `packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts`, add tests verifying:
1. `compileTurnPrompt` exposes `retrievedMemories` and `eligibleMotifs` on `ComposedTurnPrompt`, injects approved `UserHabit`s under `[USER HABITS & RHYTHM]` in `volatileTurnContext`, and injects active/due `ProspectiveIntent`s (`- Prospective Intent [...]`) in `userTurnContent` (`[Context]`), while excluding `pending_review` or `completed` items.
2. `cortex.consolidateSessionMemories({ sessionId, force: true })` consolidates unconsolidated `chat_messages` into a cohesive `EpisodicMemory`, supersedes any draft `ep-turn-*` episodes from that batch, runs `Predict -> Calibrate` (invalidating outdated facts with `invalidAt` when `requireConfirmation` is `false`, or placing new candidates into `pending_review` without corrupting existing approved facts when `requireConfirmation` is `true`), registers `RelationalMotif`s, `UserHabit`s, and `ProspectiveIntent`s with `sourceEpisodeId`, and marks the `chat_messages` with `consolidatedEpisodeId`.
3. End-to-end "Fantasma no Backend" scenario through `AshyCortex` using the **exact verbatim lines** from `ASHY_PROJECT_CONTEXT.md` (lines 84–95):
   - Day 1 conversation -> consolidated -> Day 5 prompt compilation for `"Lembra daquele bug? Consegui resolver."` includes the inside joke -> callback recorded -> Day 5+2h prompt compilation blocks the joke -> Day 18 prompt compilation for `"Fui mexer numa biblioteca antiga e deu erro."` includes the joke again!

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement `SoulComposer` and `AshyCortex` integration**

1. In `packages/cortex/src/prompt/soul-composer.ts`:
   - Add `userHabits?: readonly UserHabit[]` and `prospectiveIntents?: readonly ProspectiveIntent[]` to `ComposeTurnPromptInput`.
   - Add `retrievedMemories: readonly RankedEpisodicMemory[]` and `eligibleMotifs: readonly EligibleMotifMatch[]` to `ComposedTurnPrompt`.
   - Filter out `approvalStatus === 'pending_review'` from `semanticFacts`, `retrievedMemories`, `eligibleMotifs`, `userHabits`, and `prospectiveIntents`.
   - In `buildVolatileTurnContext`, render `[USER HABITS & RHYTHM]` when approved habits with `confidence >= 0.5` exist.
   - In `composeAshyTurnPrompt`, select approved `pending` prospective intents that are either due (`dueAt != null && dueAt <= nowMs`) or semantically/lexically relevant ($\ge 0.20$) to `input.userMessage`, and append `- Prospective Intent [id] (cue=...): topic` to `contextBulletLines`.
2. In `packages/cortex/src/ashy-cortex.ts`:
   - Pass `userHabits: this.db.listUserHabits()` and `prospectiveIntents: this.db.listProspectiveIntents('pending')` in `compileTurnPrompt`.
   - Update `indexTurnMemory` to respect `this.db.getMemoryGovernancePolicy()` (`approvalStatus`) and invalidate prior conflicting active facts when `policy.facts === false`.
   - Add `consolidateSessionMemories(params: { sessionId: string; nowMs?: number; force?: boolean; sessionSwitch?: boolean; generateJsonFn?: (prompt: string) => Promise<string> })`:
     - Fetches `this.db.listUnconsolidatedChatMessages(params.sessionId)`.
     - Calls `detectEpisodeBoundary`. If `!boundary.shouldConsolidate`, returns `{ consolidated: false }`.
     - Extracts structured episode via `extractStructuredEpisode`.
     - Supersedes any per-turn draft `ep-turn-*` episodes created during the batch window so there is zero FTS5 duplication.
     - Applies `this.db.getMemoryGovernancePolicy()` safely (only tagging **newly created** items with `'pending_review'` when `requireConfirmation` is enabled for their category, never mutating pre-existing approved records).
     - Marks batch messages consolidated via `this.db.markChatMessagesConsolidated`.
   - Add `reviewTurnMemories(params)` calling `evaluateTurnMemoryUsage` and persisting updated FSRS episodes to `this.db`.
   - Export new Phase 2 modules from `packages/cortex/src/index.ts`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts`
Expected: PASS.

---

### Task 7: Wire `TurnOrchestrator`, `AshyHostKernel`, Transport & Hub Memory Governance UI (`apps/desktop`)

**Files:**
- Modify: `apps/desktop/src/host/turn-orchestrator.ts`
- Modify: `apps/desktop/src/host/kernel.ts`
- Modify: `apps/desktop/src/host/vite-host-plugin.ts`
- Modify: `apps/desktop/src/services/ashy-host-client.ts`
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/__tests__/phase2-memory-ui.test.tsx`

- [x] **Step 1: Write the failing test**

Create `apps/desktop/src/__tests__/phase2-memory-ui.test.tsx` testing:
1. During a real turn in `TurnOrchestrator`, retrieved episodic memories that Ashy references in her reply have their FSRS-6 `stability` and `lastReviewedAt` automatically updated in `ashy.db`, and when a soft/hard boundary is reached (or `consolidateSessionMemories` is invoked), structured episodes, facts, motifs, habits, and prospective intents are persisted with `sourceEpisodeId`.
2. Enabling confirmation quarantine (`setMemoryGovernancePolicy({ category: 'facts', requireConfirmation: true })`) places newly extracted facts in `pending_review` state (visible in `snapshot.memories.facts` in the UI, but excluded from compiled prompt), and clicking **Aprovar** (`approveMemoryItem`) in the UI activates them into the prompt and invalidates any superseded fact; clicking **Descartar** (`deleteMemoryItem`) removes them completely.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/desktop/src/__tests__/phase2-memory-ui.test.tsx`
Expected: FAIL.

- [x] **Step 3: Implement Host, Store, and UI wiring**

1. In `apps/desktop/src/host/turn-orchestrator.ts`:
   - After streaming completes, call `cortex.reviewTurnMemories({ retrievedMemories: compiled.retrievedMemories, assistantText: assistantMessage.content, invokedMotifIds, nowMs: finishedAt })`.
   - Call `await cortex.consolidateSessionMemories({ sessionId: input.sessionId, nowMs: finishedAt, force: false })` so soft/hard boundaries automatically consolidate into cohesive episodes without extra network `fetch` calls.
2. In `apps/desktop/src/host/kernel.ts`:
   - Include `governancePolicy: cortex.db.getMemoryGovernancePolicy()` in `buildSnapshot().memories`.
   - In `selectSession(sessionId)`: if `sessionId !== activeSessionId`, call `await cortexInstance.consolidateSessionMemories({ sessionId: activeSessionId, force: true, sessionSwitch: true })` before switching.
   - In `stop()`: before `await container.stop()`, call `await cortexInstance.consolidateSessionMemories({ sessionId: activeSessionId, force: true, sessionSwitch: true })` inside `try/catch`.
   - Implement `consolidateSessionMemories`, `approveMemoryItem`, `setMemoryGovernancePolicy`, and expand `deleteMemoryItem` to handle `'fact' | 'episode' | 'joke' | 'habit' | 'intent' | 'milestone'`.
3. In `apps/desktop/src/host/vite-host-plugin.ts` and `apps/desktop/src/services/ashy-host-client.ts`:
   - Whitelist and validate `consolidateSessionMemories`, `approveMemoryItem`, `setMemoryGovernancePolicy`, and allow `'habit' | 'intent' | 'milestone'` in `deleteMemoryItem`.
4. In `apps/desktop/src/store/useAshyStore.ts`:
   - Add `memoryGovernancePolicy: MemoryGovernancePolicy` to state (hydrated from `snapshot.memories.governancePolicy`).
   - Pass `userHabits: current?.userHabits` and `prospectiveIntents: current?.prospectiveIntents` in `compilePromptFromState`, and filter out `pending_review` items when ranking/compiling in store.
   - Update `deleteMemoryCard` and add `deleteMemoryItem`, `consolidateSessionMemories`, `approveMemoryItem`, and `setMemoryGovernancePolicy` actions.
5. In `apps/desktop/src/App.tsx`:
   - In the Memory Inspector (`Memórias` tab), add:
     - **Botão "Consolidar Agora"** (`data-testid="btn-consolidate-memories"`)
     - **Painel de Governança de Memória** (`data-testid="memory-governance-panel"`) with per-category confirmation toggles (`facts`, `episodes`, `jokes`, `habits`, `intents`)
     - **Quarentena / Pendentes de Aprovação** section (`data-testid="pending-review-memories"`) with **Aprovar** (`data-testid="btn-approve-memory-${id}"`) and **Descartar** (`data-testid="btn-discard-memory-${id}"`) buttons.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/desktop/src/__tests__/phase2-memory-ui.test.tsx`
Expected: PASS.

---

### Task 8: Phase 2 Organ Wire-Back Audit (`scripts/verify-phase2-wireback.mjs`)

**Files:**
- Create: `scripts/verify-phase2-wireback.mjs`
- Modify: `package.json`

- [x] **Step 1: Create `scripts/verify-phase2-wireback.mjs`**

Verify that all 7 Phase 2 organs have a live producer, live consumer, and integration test:
1. `EmbeddingProvider` (`packages/llm/src/embeddings.ts` -> `packages/cortex/src/db/cortex-db.ts` -> `packages/llm/test/embeddings.test.ts`)
2. `EpisodeSegmenter` (`packages/cortex/src/memory/episode-segmenter.ts` -> `packages/cortex/src/ashy-cortex.ts` -> `packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts`)
3. `EpisodeExtractor` (`packages/cortex/src/memory/episode-extractor.ts` -> `packages/cortex/src/ashy-cortex.ts` -> `packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts`)
4. `Hybrid Semantic Motif Relevance` (`packages/cortex/src/relational/inside-joke-engine.ts` -> `packages/cortex/src/ashy-cortex.ts` -> `packages/cortex/src/__tests__/inside-joke-semantic.test.ts`)
5. `Post-Turn FSRS-6 Evaluator` (`packages/cortex/src/memory/fsrs-turn-loop.ts` -> `apps/desktop/src/host/turn-orchestrator.ts` -> `apps/desktop/src/__tests__/phase2-memory-ui.test.tsx`)
6. `SoulComposer Habits & Prospective Intents` (`packages/cortex/src/prompt/soul-composer.ts` -> `packages/cortex/src/ashy-cortex.ts` -> `packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts`)
7. `Memory Governance & Quarantine UI` (`packages/cortex/src/db/cortex-db.ts` -> `apps/desktop/src/App.tsx` -> `apps/desktop/src/__tests__/phase2-memory-ui.test.tsx`)

- [x] **Step 2: Update `package.json` `verify:wireback` script**

Update `"verify:wireback"` in root `package.json` to:
`"node scripts/verify-phase1-wireback.mjs && node scripts/verify-phase2-wireback.mjs"`

- [x] **Step 3: Run full verification gate**

Run:
- `pnpm typecheck`
- `pnpm test`
- `pnpm verify:wireback`
- `pnpm build`
Expected: 100% green across all packages and tests.
