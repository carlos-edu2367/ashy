# Fase 8 — Iniciativa Contextual e Mundo Próprio (Marco M4): Plano de Implementação (Pós-Auditoria Red-Team)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar o loop de atenção e iniciativa contextual com silêncio seletivo e limites configuráveis (`InitiativePolicy`), persistência SQLite (`v5`), linha do tempo viva em *Nossa História* (busca, filtro, edição e proveniência), *Quarto da Ashy* dinâmico por horário e marcos reais, *Diário de Reflexão* (`Dream & Reflection Journal`) e os gates do **Marco M4** (`G14` e `G15`) em `@ashy/evals`, incorporando todas as 12 correções apontadas pela auditoria Red-Team (`C1`–`C4`, `H1`–`H5`, `M1`–`M3`).

**Architecture:** Extensão local-first em 5 camadas: (1) contratos Valibot em `@ashy/shared` (`affect-types.ts` + `host-protocol.ts`), (2) motor `attention-loop.ts`, `ashy-room.ts` e migração SQLite `v5` (com paridade `MemoryStorageAdapter`) em `@ashy/cortex`, (3) suíte de avaliação de iniciativa M4 em `@ashy/evals`, (4) métodos RPC unificados (`ALLOWED_RPC_METHODS` / `dispatchHostRpc`) em `apps/desktop/src/host/`, e (5) store Zustand + interface React em `apps/desktop`.

---

### Task 1: Contratos Compartilhados da Fase 8 (`@ashy/shared` — Com Correções C2, C3, C4, H4)

**Files:**
- Modify: `packages/shared/src/affect-types.ts`
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `packages/shared/src/__tests__/host-protocol.test.ts`

- [ ] **Step 1 (RED): Atualizar `packages/shared/src/__tests__/host-protocol.test.ts`**
  - Atualizar a asserção de `M2_GATE_THRESHOLDS` (linha 319) para incluir `initiativeGroundingRateMin: 1.0` e `unopportuneInitiativeCountMax: 0`.
  - Adicionar testes para `CrossEpisodeLinkSchema` aceitando `id` opcional.
  - Adicionar testes para `InitiativePolicySchema` (defaults + rejeição de `quietHoursStart: '25:99'`), `UpdateInitiativePolicyInputSchema`, `EvaluateInitiativeInputSchema`, `ProactiveInitiativeRecordSchema`, `DreamJournalEntrySchema`, `UpdateMilestoneInputSchema`, `RoomTrophyItemSchema` e `RoomEnvironmentStateSchema`.
- [ ] **Step 2 (GREEN): Implementar em `packages/shared/src/affect-types.ts` e `packages/shared/src/host-protocol.ts`**
  - Em `affect-types.ts`: adicionar `id: v.optional(NonEmptyStringSchema)` ao `CrossEpisodeLinkSchema`.
  - Em `host-protocol.ts`:
    - Exportar `INITIATIVE_TRIGGER_KINDS`, `INITIATIVE_DECISIONS`, `ROOM_TIME_OF_DAY_PERIODS`, `InitiativePolicySchema`, `DEFAULT_INITIATIVE_POLICY`, `UpdateInitiativePolicyInputSchema`, `EvaluateInitiativeInputSchema`, `ProactiveInitiativeRecordSchema`, `DreamJournalEntrySchema`, `UpdateMilestoneInputSchema`, `RoomTrophyItemSchema`, `RoomEnvironmentStateSchema`.
    - Em `CoreExperimentMetricSummarySchema`: adicionar `initiativeGroundingRate: v.optional(UnitIntervalSchema, 1.0)` e `unopportuneInitiativeCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0)`.
    - Em `AshyBootstrapSnapshot['memories']`: adicionar campos opcionais `crossEpisodeLinks?`, `dreamJournalEntries?`, `initiativePolicy?`, `initiativeLog?`, `roomEnvironment?`.
    - Em `AshyHostBridge`: adicionar `updateMilestone`, `updateInitiativePolicy` e `evaluateAttentionInitiative`.
- [ ] **Step 3 (VERIFY): Rodar `pnpm --filter @ashy/shared test`**

---

### Task 2: Migration `v5`, Loop de Atenção (`attention-loop.ts`) e Quarto Vivo (`ashy-room.ts`) em `@ashy/cortex` (Com Correções C2, C3, H1, H2, H3, H4, H5, M1)

**Files:**
- Create: `packages/cortex/src/initiative/attention-loop.ts`
- Create: `packages/cortex/src/world/ashy-room.ts`
- Modify: `packages/cortex/src/dream/dream-worker.ts`
- Modify: `packages/cortex/src/db/cortex-db.ts`
- Modify: `packages/cortex/src/ashy-cortex.ts`
- Modify: `packages/cortex/src/index.ts`
- Modify: `packages/cortex/src/__tests__/phase1-persistence.test.ts`
- Create: `packages/cortex/src/__tests__/phase8-initiative-world.test.ts`

- [ ] **Step 1 (RED): Atualizar `phase1-persistence.test.ts` e criar `phase8-initiative-world.test.ts`**
  - Em `phase1-persistence.test.ts` (linhas 132, 268, 550): atualizar `expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5])` e adicionar teste de persistência da Migration `v5`.
  - Em `phase8-initiative-world.test.ts`:
    - Testar paridade SQLite + `MemoryStorageAdapter` (`forceMemoryFallback: true`) para `getInitiativePolicy`, `saveInitiativePolicy`, `insertProactiveInitiativeLog`, `listProactiveInitiativeLog`, `insertDreamJournalEntry`, `listDreamJournalEntries`, `updateMilestone` e limpeza em cascata no `deleteEpisodicMemory`.
    - Testar `evaluateAttentionLoop` com `localTimeHHMM` determinístico em todos os cenários: `suppressed_disabled`, `suppressed_dnd`, `suppressed_quiet_hours` (incluindo wrap-around `23:00`–`08:00`), `modulateByHabits` permitindo madrugada quando hábito `late_night_coding` aprovado (`confidence >= 0.75`) está ativo, `suppressed_habit_focus` quando `deep_focus_no_interrupt` está ativo, `suppressed_cooldown`, `suppressed_daily_limit`, `suppressed_no_anchor`, isolamento de `pending_review` / `ep-turn-*`, deduplicação de âncora já falada, `[SILENCE]` $\rightarrow$ `selective_silence`, e disparo `spoken` atualizando `prospective_intent` para `'triggered'`.
    - Testar `deriveAshyRoomEnvironment` mapeando períodos do dia e todos os IDs de troféus (`trophy-first-boot-mug`, `trophy-padre-npm-relic`, `trophy-prod-shield` e `TROPHY_BY_MILESTONE_CATEGORY`).
    - Testar que `cortex.runDreamReflectionCycle()` persiste `DreamJournalEntry` sem duplicar em ciclos ociosos sem novos episódios refletíveis.
- [ ] **Step 2 (GREEN): Implementar Migration `v5`, `attention-loop.ts`, `ashy-room.ts`, `dream-worker.ts` (`link.id`) e métodos no `AshyCortex`**
- [ ] **Step 3 (VERIFY): Rodar `pnpm --filter @ashy/cortex test`**

---

### Task 3: Bateria de Avaliação — Marco M4 (`@ashy/evals` — Com Correções C2, M2)

**Files:**
- Modify: `packages/evals/src/judges.ts`
- Modify: `packages/evals/src/runner.ts`
- Modify: `packages/evals/src/reporter.ts`
- Modify: `packages/evals/test/judges.test.ts`
- Modify: `packages/evals/test/m2-experiment.test.ts`

- [ ] **Step 1 (RED): Adicionar testes em `judges.test.ts` e atualizar `m2-experiment.test.ts` (linha 144: `15` gates)**
- [ ] **Step 2 (GREEN): Implementar `evaluateContextualInitiativeSuite` em `judges.ts`, gates `G14_contextual_initiative_grounding` e `G15_zero_unopportune_initiatives` em `runner.ts`, e formatação em `reporter.ts`**
- [ ] **Step 3 (VERIFY): Rodar `pnpm --filter @ashy/evals test`**

---

### Task 4: Host Kernel, Vite Host Plugin e Cliente RPC (`apps/desktop/src/host/` — Com Correções C1, M2)

**Files:**
- Modify: `apps/desktop/src/host/kernel.ts`
- Modify: `apps/desktop/src/host/vite-host-plugin.ts`
- Modify: `apps/desktop/src/services/ashy-host-client.ts`
- Modify: `apps/desktop/src/__tests__/host-kernel.test.ts`
- Modify: `apps/desktop/src/__tests__/host-transport.test.ts`

- [ ] **Step 1 (RED): Adicionar testes de `updateMilestone`, `updateInitiativePolicy`, `evaluateAttentionInitiative` e snapshot Phase 8 em `host-kernel.test.ts` e `host-transport.test.ts`**
- [ ] **Step 2 (GREEN): Implementar em `kernel.ts` (incluindo preservação de `initiativeGroundingRate` e `unopportuneInitiativeCount` em `lastEvalReport.metrics`), `vite-host-plugin.ts` (`ALLOWED_RPC_METHODS` + `dispatchHostRpc`, usando apenas `import type` de `@ashy/shared`) e `ashy-host-client.ts`**
- [ ] **Step 3 (VERIFY): Rodar `pnpm --filter @ashy/desktop test src/__tests__/host-kernel.test.ts src/__tests__/host-transport.test.ts`**

---

### Task 5: Desktop Store & UI — Nossa História Viva, Quarto da Ashy, Diário de Reflexão e Limites de Iniciativa (`apps/desktop` — Com Correção M3)

**Files:**
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/__tests__/phase8-initiative-world-ui.test.tsx`

- [ ] **Step 1 (RED): Criar `apps/desktop/src/__tests__/phase8-initiative-world-ui.test.tsx`**
- [ ] **Step 2 (GREEN): Implementar actions em `useAshyStore.ts` e seções em `App.tsx`**
- [ ] **Step 3 (VERIFY): Rodar `pnpm --filter @ashy/desktop test src/__tests__/phase8-initiative-world-ui.test.tsx`**

---

### Task 6: Script de Auditoria Wire-Back (`verify-phase8-wireback.mjs`), Build Completo e Verificação Visual no Playwright

**Files:**
- Create: `scripts/verify-phase8-wireback.mjs`
- Modify: `package.json`

- [ ] **Step 1: Criar `scripts/verify-phase8-wireback.mjs` e encadear no `verify:wireback` do `package.json`**
- [ ] **Step 2: Executar `pnpm verify:wireback`, `pnpm typecheck`, `pnpm build` e `pnpm test`**
- [ ] **Step 3: Testar visualmente no navegador via Playwright em `http://localhost:5173/`**
