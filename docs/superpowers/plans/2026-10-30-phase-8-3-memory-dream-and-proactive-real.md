# Fase 8.3 — Memória Seletiva Real, Fim de `DEMO_*` & Desmockagem do Córtex/Dream/Proatividade

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Impedir que mensagens triviais/curtas de conversa (`"opa"`, `"oi"`, `"nossa, grossa"`, `"que boca suja rapaz?"`, `"nao apareceu nenhuma tool pra vc ai?"`) virem cards na aba **Memórias ("Momentos")**, eliminar `DEMO_MEMORY_CARDS` e o nome/avatar hardcoded `"Carlos"` de produção, e desmockar o `DreamWorker` (`resolveDreamJsonGenerator` + timer ocioso), `AttentionLoop` (geração proativa com LLM ativo), `computeCosineSimilarity` (qualquer dimensão de vetor) e `buildRoomTrophies` (derivado dinamicamente dos marcos reais).

**Architecture:**
1. **Task 1 (`@ashy/llm`, `@ashy/cortex`, `apps/desktop/src/host/kernel.ts`):**
   - `packages/llm/src/embeddings.ts`: suportar vetores de qualquer dimensão compatível (`a.length === b.length && a.length > 0`) em `computeCosineSimilarity128` e exportar alias `computeCosineSimilarity`.
   - `packages/cortex/src/memory/episode-segmenter.ts`: em `detectEpisodeBoundary`, só disparar `topic_shift` por baixa similaridade cosseno quando **ambas** as mensagens consecutivas do usuário forem substantivas (`>= 4` tokens significativos não-stopword de `>= 4` caracteres e não forem saudação/chitchat curto).
   - `packages/cortex/src/memory/episode-extractor.ts`: adicionar `shouldSaveEpisode: boolean` e `category: 'momentos' | 'sobre_voce' | 'referencias' | 'planos'` ao `EpisodeExtractionSchema` e `StructuredEpisodeExtractionResult`. Em `extractEpisodeDeterministic`, classificar `shouldSaveEpisode = false` quando a conversa contiver apenas saudações/banter curto/meta-perguntas triviais sem fatos, piadas, hábitos ou planos, e anexar a tag `category:<categoria>` às tags do episódio.
   - `packages/cortex/src/ashy-cortex.ts`:
     - Em `indexTurnMemory`, filtrar saudações/interjeições/meta-perguntas triviais para não gerar rascunhos `ep-turn-*` ruidosos, preservando a criação de rascunho quando houver fatos extraídos, alta carga afetiva, hábito/intenção ou afirmação substantiva (`>= 4` tokens significativos).
     - Em `executeConsolidateSessionMemories`, quando `!params.force && extracted.shouldSaveEpisode === false` e não houver fatos/motifs/hábitos/intenções extraídos, marcar as mensagens como consolidadas sem gravar episódio permanente de ruído.
     - Em `runDreamReflectionCycle`, quando `generateJsonFn` for fornecido e gerar reflexões ou conexões novas, permitir enriquecer o `summary` do `DreamJournalEntry` em 1ª pessoa via `generateJsonFn` (com fallback determinístico seguro).
     - Adicionar `evaluateAttentionInitiativeAsync` (ou suporte opcional a `generateReplyFn` / resolução no `kernel.ts`) para gerar falas proativas via LLM ativo quando `simulatedReplyText` não for passado.
   - `packages/cortex/src/dream/dream-worker.ts`, `packages/cortex/src/relational/inside-joke-engine.ts`, `packages/cortex/src/memory/fsrs-turn-loop.ts`:
     - Em `classifyEpisodeTraitDelta` (`dream-worker.ts`), adicionar evolução do 5º traço `chaosEnergy` (para tags `'chaos'`, `'playful'`, `'improv'` ou palavras-chave `\b(caos|travessura|caotico|improviso)\b`), mantendo a prioridade dos 4 traços existentes.
     - Remover a restrição `.length === 128` nas comparações de embeddings, aceitando qualquer dimensão compatível `> 0`.
     - Em `fsrs-turn-loop.ts`, remover `'banco'`, `'codigo'`, `'projeto'`, `'local'`, `'ajustamos'`, `'configuracao'`, `'configuramos'` de `USAGE_STOPWORDS`.
   - `apps/desktop/src/host/kernel.ts`:
     - Exportar `DEFAULT_DREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000` e usá-lo quando `options.dreamIdleTimeoutMs === undefined`.
     - Implementar `resolveDreamJsonGenerator()` usando `providerVaultInstance.createActiveLanguageModel().generateText(...)` quando `providerVaultInstance.getPublicState().hasActiveReadyProvider` for `true`.
     - Em `evaluateAttentionInitiative`, quando `parsed.simulatedReplyText` não for informado e `hasActiveReadyProvider` for `true`, tentar gerar a resposta proativa curta via `createActiveLanguageModel().generateText(...)` (com fallback para a fala determinística caso a chamada falhe ou retorne SSE/vazio em mocks de teste).
2. **Task 2 (`apps/desktop/src/store/useAshyStore.ts`, `apps/desktop/src/App.tsx`, `apps/desktop/test/desktop.test.tsx`):**
   - `apps/desktop/src/store/useAshyStore.ts`:
     - Remover o import de `DEMO_MEMORY_CARDS` e todo o bloco `isDemoSeeded` de `mapEpisodesToMemoryCards`.
     - Filtrar `ep-turn-*` e `ep-dream-*` em `mapEpisodesToMemoryCards` usando `isReflectablePermanentEpisode(ep)` de `@ashy/cortex`.
     - Mapear `filterCategory` (`'momentos' | 'sobre_voce' | 'referencias' | 'planos'`), `image` específica por categoria (`/assets/mem-first-chat.jpg`, `/assets/mem-work-style.jpg`, `/assets/mem-ghost-backend.jpg`, `/assets/mem-prototype-plan.jpg`) e `featured: ep.isFlashbulb || ep.surprise >= 0.75`.
     - Tornar `buildRoomTrophies(milestones)` dinâmico para incluir tanto o catálogo base quanto quaisquer marcos/troféus adicionais criados na história do usuário.
     - Fazer `runDreamConsolidation` chamar `getAshyHostBridge().runDreamReflection({ force: true })` e aplicar o `snapshot` retornado quando o bridge estiver disponível.
   - `apps/desktop/src/App.tsx`:
     - Substituir `const displayName = state.userProfile.userName ?? 'Carlos'` por `state.userProfile.userName?.trim() || 'Você'` e trocar `<img src="/assets/carlos-avatar.jpg" alt="Carlos" />` por um badge de inicial elegante (`displayName.charAt(0).toUpperCase()`) e `<strong>{displayName}:</strong>` no lab de avaliação.
     - No formulário `"O que aprendi sobre você"` (`App.tsx:2917-2941`), adicionar seletores de categoria (`data-testid="select-fact-category"`) e predicado (`data-testid="input-fact-predicate"`) conectados aos estados `factCategory` e `factPredicate` já existentes.

**Tech Stack:** TypeScript, Vitest, React 19, Zustand, Valibot, SQLite (`node:sqlite`).

---

## Task 1: Memória Seletiva, DreamWorker Real, Embeddings & Iniciativa no Córtex e Kernel

**Files:**
- Modify: `packages/llm/src/embeddings.ts`
- Modify: `packages/cortex/src/memory/episode-segmenter.ts`
- Modify: `packages/cortex/src/memory/episode-extractor.ts`
- Modify: `packages/cortex/src/dream/dream-worker.ts`
- Modify: `packages/cortex/src/relational/inside-joke-engine.ts`
- Modify: `packages/cortex/src/memory/fsrs-turn-loop.ts`
- Modify: `packages/cortex/src/ashy-cortex.ts`
- Modify: `apps/desktop/src/host/kernel.ts`
- Create: `apps/desktop/src/test/phase-8-3-cortex-memory-dream.test.ts`

- [ ] **Step 1 (RED): Create failing test `apps/desktop/src/test/phase-8-3-cortex-memory-dream.test.ts`**
  Test:
  1. `computeCosineSimilarity128` (and `computeCosineSimilarity`) computes cosine similarity for 384-dim or 1536-dim vectors (not only 128-dim).
  2. `detectEpisodeBoundary` does NOT trigger `topic_shift` on casual short turns (`"opa"`, `"nossa, grossa"`, `"que boca suja rapaz?"`), while still triggering `topic_shift` when two consecutive user messages have `>= 4` substantive tokens on completely different topics.
  3. `extractEpisodeDeterministic` sets `shouldSaveEpisode: false` for trivial chitchat (`"opa"`, `"nossa, grossa"`) and `shouldSaveEpisode: true` with accurate `category` (`'planos'`, `'sobre_voce'`, `'referencias'`, `'momentos'`) and `category:<cat>` tag for meaningful episodes.
  4. `cortex.indexTurnMemory` skips creating `ep-turn-*` episodic drafts for trivial casual banter (`"opa"`, `"que boca suja rapaz?"`), and `cortex.consolidateSessionMemories` (when `force: false`) does not persist noise episodes when `shouldSaveEpisode === false`.
  5. `classifyEpisodeTraitDelta` evolves `chaosEnergy` when an episode has chaos/improv tags or keywords.
  6. `verifyRetrievedMemoriesUsage` recognizes domain words `'banco'`, `'codigo'`, `'projeto'`, `'local'` as substantive overlap tokens (not stopwords).
  7. `createAshyHostKernel` wires `resolveDreamJsonGenerator()` to the active provider when `hasActiveReadyProvider` is true and uses `DEFAULT_DREAM_IDLE_TIMEOUT_MS` by default.

- [ ] **Step 2 (GREEN): Implement selective memory, embeddings, DreamWorker & Kernel wiring**
  Ensure all existing tests in `packages/cortex` (`phase2-self-writing-memory.test.ts`, `cortex.test.ts`, `soul-composer-split.test.ts`) and `apps/desktop` continue passing 100%.

- [ ] **Step 3 (REFACTOR): Verify with Vitest & Typecheck**
  Run `pnpm test` and `pnpm typecheck`.

---

## Task 2: Store & UI de Memórias Reais, Fim de `DEMO_MEMORY_CARDS`, Troféus Dinâmicos & Perfil

**Files:**
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/test/desktop.test.tsx`
- Create: `apps/desktop/src/test/phase-8-3-ui-memories-and-profile.test.tsx`

- [ ] **Step 1 (RED): Create failing test `apps/desktop/src/test/phase-8-3-ui-memories-and-profile.test.tsx`**
  Test:
  1. `mapEpisodesToMemoryCards` (via `applyBootstrapSnapshot`) ignores `ep-turn-*` and `ep-dream-*` drafts, never injects `DEMO_MEMORY_CARDS` in an empty or seeded store, and assigns category-specific artwork (`/assets/mem-first-chat.jpg`, `/assets/mem-work-style.jpg`, `/assets/mem-ghost-backend.jpg`, `/assets/mem-prototype-plan.jpg`) based on episode category tags.
  2. `buildRoomTrophies` includes dynamic trophies from custom `AutobiographicalMilestone` records in addition to the 3 starter trophies.
  3. When `userProfile.userName` is `null`, `App` renders `'Você'` (never `'Carlos'` or `/assets/carlos-avatar.jpg`).
  4. The `"O que aprendi sobre você"` form allows selecting `category` (`data-testid="select-fact-category"`) and editing `predicate` (`data-testid="input-fact-predicate"`) and submits those values to `addSemanticFact`.

- [ ] **Step 2 (GREEN): Implement Store & UI changes in `useAshyStore.ts`, `App.tsx`, and update `desktop.test.tsx`**
  Remove `DEMO_MEMORY_CARDS` import from `useAshyStore.ts`, filter `isReflectablePermanentEpisode`, map category images, make `buildRoomTrophies` dynamic, remove `'Carlos'` fallback and `/assets/carlos-avatar.jpg` from `App.tsx`, add category/predicate inputs to the semantic fact form, and update `apps/desktop/test/desktop.test.tsx` test 10 to assert on the real SQLite episodes seeded by `seedDemoFixtures()`.

- [ ] **Step 3 (REFACTOR): Run full test suite, typecheck, and build**
  Run `pnpm test`, `pnpm typecheck`, and `pnpm build`.
