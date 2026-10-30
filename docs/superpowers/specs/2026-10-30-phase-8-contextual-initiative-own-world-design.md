# Fase 8 — Iniciativa Contextual e Mundo Próprio (Marco M4): Especificação de Design (Pós-Auditoria Red-Team)

**Data:** 2026-10-30  
**Escopo:** Fase 8 do [`docs/ASHY_ROADMAP.md`](../../ASHY_ROADMAP.md) (Marco M4)  
**Órgãos impactados:** `@ashy/shared`, `@ashy/cortex`, `@ashy/evals`, `apps/desktop/src/host/`, `apps/desktop/src/store/`, `apps/desktop/src/App.tsx`, `scripts/verify-phase8-wireback.mjs`

---

## 1. Visão Geral e Objetivo

Na Fase 8 (**Marco M4**), a Ashy deixa de ser puramente reativa e passa a ter **iniciativa contextual com motivo concreto**, além de habitar um **mundo próprio vivo** (*Nossa História*, *Quarto da Ashy* e *Diário de Reflexão*) que reflete os episódios e marcos reais construídos na convivência.

Três decisões arquiteturais aprovadas no *brainstorming* guiam esta fase:
1. **Loop de Atenção Ancorado + Silêncio Seletivo + Limites Configuráveis (§15):** toda iniciativa espontânea deve referenciar um item real (`prospective_intent`, `autobiographical_milestone` recente ou `cross_episode_link` recorrente), respeitar o **Silêncio Seletivo** (`[SILENCE]`), e obedecer aos limites configuráveis pelo usuário: modo `enabled: boolean` (incluindo *"Nunca iniciar sozinha"*), `cooldownMinutes` (padrão `120`), `maxDailyInitiatives` (padrão `3`), `quietHoursStart` / `quietHoursEnd` (padrão `23:00`–`08:00`), respeito estrito ao `dndMode` e modulação por `user_habits`.
2. **Nossa História (`Our Story`) Viva + Diário de Reflexão (`Dream & Reflection Journal`):** a aba `Nossa história` ganha busca textual em tempo real (`storySearchQuery`), filtro por categoria de marco (`all` ou qualquer `MilestoneCategory`), edição inline de título, narrativa e categoria (`updateMilestone`), badge do episódio de origem (`episodeId`), e seção dedicada para o **Diário de Reflexão** mostrando as conexões entre episódios (`cross_episode_links`) e insights reais consolidados pelo `dream-worker`.
3. **Quarto da Ashy (`Ashy's Room`) Dinâmico + Gate M4 em `@ashy/evals`:** o `Ashy's Room` reflete o período do dia (`morning`, `afternoon`, `evening`, `late_night`) e deriva seus objetos/troféus diretamente dos `autobiographical_milestones` reais persistidos no SQLite (`ashy.db`). Na bateria `@ashy/evals`, o **Marco M4** adiciona avaliação de iniciativa contextual (`G14_contextual_initiative_grounding` = `1.0` e `G15_zero_unopportune_initiatives` = `1.0`).

---

## 2. Arquitetura por Pacote / Órgão (Com Correções Red-Team C1–C4, H1–H5, M1–M3)

### 2.1. Contratos Compartilhados (`@ashy/shared`)

Em `packages/shared/src/affect-types.ts` e `packages/shared/src/host-protocol.ts`:

- **Correção Red-Team C3 (`CrossEpisodeLinkSchema`):**
  - Em `packages/shared/src/affect-types.ts`, adicionar `id: v.optional(NonEmptyStringSchema)` ao `CrossEpisodeLinkSchema` (mantendo opcional na entrada para retrocompatibilidade com testes existentes, mas sempre preenchido deterministicamente em `detectCrossEpisodeLinks` como `link-${fromEpisodeId}-${toEpisodeId}-${sharedTheme}`).
- **Política e Estado de Iniciativa (`InitiativePolicy` & `ProactiveInitiativeRecord`):**
  - `INITIATIVE_TRIGGER_KINDS = ['prospective_intent', 'milestone_followup', 'recurring_theme', 'none'] as const`
  - `INITIATIVE_DECISIONS = ['spoken', 'selective_silence', 'suppressed_disabled', 'suppressed_dnd', 'suppressed_quiet_hours', 'suppressed_cooldown', 'suppressed_daily_limit', 'suppressed_habit_focus', 'suppressed_no_anchor'] as const`
  - `InitiativePolicySchema`:
    - `enabled: boolean` (default `true`; quando `false` = modo *"Nunca iniciar sozinha"*)
    - `cooldownMinutes: number` (inteiro `1..1440`, default `120`)
    - `maxDailyInitiatives: number` (inteiro `0..20`, default `3`)
    - `quietHoursStart: string` (regex `/^(?:[01]\d|2[0-3]):[0-5]\d$/`, default `'23:00'`)
    - `quietHoursEnd: string` (regex `/^(?:[01]\d|2[0-3]):[0-5]\d$/`, default `'08:00'`)
    - `respectDnd: boolean` (default `true`)
    - `modulateByHabits: boolean` (default `true`)
  - `ProactiveInitiativeRecordSchema`:
    - `id: string`
    - `triggerKind: InitiativeTriggerKind`
    - `sourceId: string | null` (`null` quando `triggerKind === 'none'`)
    - `sourceTitle: string`
    - `noticePrompt: string`
    - `replyText: string | null`
    - `decision: InitiativeDecision`
    - `reason: string`
    - `createdAt: number`
- **Diário de Reflexão (`DreamJournalEntrySchema`):**
  - `id: string`
  - `createdAt: number`
  - `summary: string`
  - `sourceEpisodeIds: string[]` ($\ge 1$ episódio permanente aprovado; zero episódios `ep-turn-*`, `ep-dream-*` ou `pending_review`)
  - `crossLinksCount: number`
  - `traitEvolutionsCount: number`
- **Quarto da Ashy (`RoomEnvironmentState` & `RoomTrophyItem`):**
  - `ROOM_TIME_OF_DAY_PERIODS = ['morning', 'afternoon', 'evening', 'late_night'] as const`
  - `RoomTrophyItemSchema`:
    - `id: string`
    - `name: string`
    - `description: string`
    - `category: MilestoneCategory`
    - `milestoneId: string`
    - `episodeId?: string`
    - `unlockedAt: number`
    - `unlocked: boolean`
    - `iconKey: 'mug' | 'sparkles' | 'rocket' | 'moon' | 'heart' | 'flame' | 'shield' | 'duck'`
  - `RoomEnvironmentStateSchema`:
    - `period: RoomTimeOfDayPeriod`
    - `ambientLabel: string`
    - `lightingPreset: 'warm_sunrise' | 'golden_studio' | 'cozy_neon' | 'midnight_lofi'`
    - `unlockedTrophies: RoomTrophyItem[]`
- **Correção Red-Team C4 (`AshyBootstrapSnapshot`):**
  - Estender `AshyBootstrapSnapshot['memories']` com propriedades **opcionais (`?`)** para retrocompatibilidade total com mocks existentes:
    - `crossEpisodeLinks?: CrossEpisodeLink[]`
    - `dreamJournalEntries?: DreamJournalEntry[]`
    - `initiativePolicy?: InitiativePolicy`
    - `initiativeLog?: ProactiveInitiativeRecord[]`
    - `roomEnvironment?: RoomEnvironmentState`
- **Correção Red-Team C2 (`CoreExperimentMetricSummarySchema` & `M2_GATE_THRESHOLDS`):**
  - Em `M2_GATE_THRESHOLDS`, adicionar `initiativeGroundingRateMin: 1.0` e `unopportuneInitiativeCountMax: 0`.
  - Em `CoreExperimentMetricSummarySchema`, definir com `v.optional(..., default)` para não quebrar relatórios legados (`docs/evals/latest-m2-report.json`):
    - `initiativeGroundingRate: v.optional(UnitIntervalSchema, 1.0)`
    - `unopportuneInitiativeCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0)`

---

### 2.2. Motor de Atenção, Quarto Vivo e Migration `v5` (`@ashy/cortex`)

1. **Migration `v5_phase8_initiative_and_reflection_journal` + Paridade Dual-Backend (Correção Red-Team H1):**
   - Registrar a migration `5` (`v5_phase8_initiative_and_reflection_journal`) tanto em `initializeSqliteSchema()` quanto no construtor do `MemoryStorageAdapter` (`this.migrations.set(5, ...)`).
   - Adicionar `'initiative_policy_state'`, `'proactive_initiative_log'` e `'dream_reflection_journal'` ao fallback de `listSqlTables()`.
   - Em `deleteEpisodicMemory(id)`, remover `id` de `dream_reflection_journal.source_episode_ids_json` e excluir entradas do diário cujo array `sourceEpisodeIds` fique vazio.
   - Implementar `updateMilestone(input: UpdateMilestoneInput)` sanitizando `title` e `narrative` (sem `\0` ou marcadores `<|...|>`).

2. **Loop de Atenção e Iniciativa Contextual (`packages/cortex/src/initiative/attention-loop.ts` — Correções H2, H3, H4, M1):**
   - `isWithinQuietHours(currentHHMM: string, startHHMM: string, endHHMM: string): boolean`:
     - Suporta tanto janelas no mesmo dia (`01:00`–`06:00`) quanto janelas que cruzam meia-noite (`23:00`–`08:00`). Se `startHHMM === endHHMM`, retorna `false`.
     - `evaluateAttentionLoop` aceita `localTimeHHMM?: string` opcional para determinismo absoluto independente de fuso horário da máquina nos testes e evals M4.
   - **Isolamento Estrito de Quarentena (`pending_review`) e Transientes (`ep-turn-*`, `ep-dream-*`):**
     - Nenhuma intenção, hábito, episódio ou marco derivado de episódio em `pending_review` ou transiente pode ser usado como âncora ou modulador.
     - Marcos e `cross_episode_links` já falados anteriormente (`decision === 'spoken'` com mesmo `sourceId` em `recentInitiatives`) são deduplicados para não repetir o mesmo assunto.
   - **Sanitização Anti-Injeção e Anti-Manipulação:**
     - Toda mensagem proativa gerada passa por `sanitizePromptLine` e `stripBondManipulation` (nunca emitindo cobrança emocional).

3. **Derivação do Quarto da Ashy (`packages/cortex/src/world/ashy-room.ts` — Correções H3, H5):**
   - `deriveAshyRoomEnvironment({ milestones, episodes, nowMs, localTimeHHMM })`:
     - Filtra marcos cujo `episodeId` aponte para episódio em `pending_review`.
     - Reconhece tanto os IDs canônicos de troféus (`trophy-first-boot-mug`, `trophy-padre-npm-relic`, `trophy-prod-shield`) quanto os 6 IDs de `TROPHY_BY_MILESTONE_CATEGORY` (`trophy-spark-crystal`, `trophy-rubber-duck`, `trophy-launch-rocket`, `trophy-midnight-mug`, `trophy-prism-heart`, `trophy-polaroid-frame`).

---

### 2.3. Host Kernel & Transporte RPC Unificado (`apps/desktop/src/host/` — Correções C1, M2)

- **Correção Red-Team C1:**
  - `vite-host-plugin.ts` e `ashy-host-client.ts` utilizam o endpoint RPC unificado `POST /__ashy_host/rpc` com `ALLOWED_RPC_METHODS` e `dispatchHostRpc(kernel, method, payload)`.
  - Adicionar `'updateMilestone'`, `'updateInitiativePolicy'` e `'evaluateAttentionInitiative'` ao `ALLOWED_RPC_METHODS` e `dispatchHostRpc` em `vite-host-plugin.ts` (mantendo apenas `import type` de `@ashy/shared` para preservar o invariante de `verify-phase7-wireback.mjs`), ao `AshyHostKernel` em `kernel.ts`, e aos bridges preload/HTTP em `ashy-host-client.ts`.
- **Correção Red-Team M2:**
  - Em `kernel.ts` (`runCoreExperimentEval`), preservar `initiativeGroundingRate` e `unopportuneInitiativeCount` ao normalizar `lastEvalReport.metrics`.

---

### 2.4. UI Desktop (`apps/desktop`) e Bateria M4 (`@ashy/evals`)

- **UI (`App.tsx` & `useAshyStore.ts` — Correção M3):**
  - Validação contra título/narrativa vazios na edição inline de marcos e limpeza de `editingMilestoneId` caso o marco seja excluído.
  - Sincronização de `state.roomTrophies` com `state.roomEnvironment.unlockedTrophies`.
- **Evals (`@ashy/evals` — Correções C2, M2):**
  - `evaluateContextualInitiativeSuite` em `judges.ts`, gates `G14_contextual_initiative_grounding` e `G15_zero_unopportune_initiatives` em `runner.ts`, e inclusão no `reporter.ts`.
