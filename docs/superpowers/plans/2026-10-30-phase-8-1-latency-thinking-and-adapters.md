# Fase 8.1 — Latência, Controle de Thinking & Adapters LLM 100% Reais — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar a demora de 20s–46s para iniciar respostas no chat (desativando `thinking`/`reasoning` por padrão com seletor configurável de esforço), remover o bloqueio síncrono pré-turno (`getBootstrapSnapshot` + descriptografia repetida + corrida de mensagem otimista), corrigir a injeção de `RelationshipStage` e `queryEmbedding` no `TurnOrchestrator`, e corrigir o suporte completo a multi-step tool calls/usage/schemas em `@ashy/llm`.

**Architecture:**
1. `@ashy/shared` ganha o contrato `ReasoningEffort` (`'none' | 'minimal' | 'low' | 'medium' | 'high'`, default `'none'`) em `PublicProviderConfig`, `SaveProviderConfigInputSchema` e `TestProviderInputSchema`.
2. `@ashy/llm` (`adapters.ts` e `stream-text.ts`) propaga `reasoningEffort` e formata o payload correto por provedor (OpenRouter `reasoning: { enabled: false }` quando `'none'` ou `{ enabled: true, effort }`, Ollama/Qwen `think: false` / `chat_template_kwargs: { enable_thinking: false }`, OpenAI reasoning models `reasoning_effort`, Anthropic `thinking`), além de corrigir a serialização de `tool_use` e `usage` na Anthropic e enriquecer `valibotSchemaToJsonSchema`.
3. `ProviderVault` persiste `reasoningEffort` em `providers.json` e faz cache em memória do estado e chaves descriptografadas (invalidado por escrita ou `mtimeMs`), evitando I/O + AES-256-GCM repetidos a cada turno.
4. `TurnOrchestrator` remove o `await options.getBootstrapSnapshot()` pré-turno, passa `stage` real e `queryEmbedding` para `cortex.compileTurnPrompt`, e `useAshyStore.sendUserMessage` insere a bolha do usuário otimisticamente antes do `await bridge.sendTurn` (evitando inversão de ordem com `turn:started`).

**Tech Stack:** TypeScript, Valibot, Vitest, React 19, Zustand 5, SQLite (`node:sqlite`).

---

## Mapa de Arquivos

- **Modificar:** `packages/shared/src/host-protocol.ts` — adicionar `REASONING_EFFORT_LEVELS`, `ReasoningEffort`, `ReasoningEffortSchema` e campo `reasoningEffort` em `PublicProviderConfig`, `SaveProviderConfigInputSchema`, `TestProviderInputSchema` e `CompleteOnboardingInputSchema`.
- **Modificar:** `packages/llm/src/stream-text.ts` — adicionar `reasoningEffort?: ReasoningEffort` em `LanguageModelRequest` e `StreamTextOptions`, repassando ao `model(...)`.
- **Modificar:** `packages/llm/src/adapters.ts` — suportar `reasoningEffort` em `OpenAICompatibleModelConfig` e `AnthropicMessagesModelConfig`, serializar controle de thinking por provedor, serializar blocos `tool_use` em `createAnthropicMessagesModel`, repassar `temperature` e `usage` na Anthropic, e suportar `literal`, `union`, `record`, `tuple` e `description`/constraints em `valibotSchemaToJsonSchema`.
- **Modificar:** `packages/llm/test/llm.test.ts` — testes unitários TDD cobrindo controle de `reasoningEffort` (OpenRouter, Ollama/Qwen, OpenAI, Anthropic), multi-step `tool_use` + `usage` na Anthropic e novos tipos no `valibotSchemaToJsonSchema`.
- **Modificar:** `apps/desktop/src/host/provider-vault.ts` — persistir `reasoningEffort` (default `'none'`), adicionar cache em memória de documentos/chaves descriptografadas e passar `reasoningEffort` na criação do `LanguageModel`.
- **Modificar:** `apps/desktop/src/host/turn-orchestrator.ts` — remover `await options.getBootstrapSnapshot()` do início do turno, passar `stage` real (`cortex.getRelationshipState().stage`) e `queryEmbedding` em `cortex.compileTurnPrompt`, e repassar `reasoningEffort` do provider ativo.
- **Modificar:** `apps/desktop/src/store/useAshyStore.ts` — incluir `reasoningEffort: 'none'` nos defaults de providers e fazer inserção otimista e ordenada da mensagem do usuário em `sendUserMessage` antes de `await bridge.sendTurn`.
- **Modificar:** `apps/desktop/src/components/ModelsSettingsPanel.tsx` & `apps/desktop/src/components/FirstMeetingWizard.tsx` — adicionar seletor de Esforço de Raciocínio (`data-testid="provider-reasoning-effort-select"`).
- **Modificar/Criar Testes Desktop:** `apps/desktop/src/test/phase-8-1-latency-thinking.test.ts` — testes TDD de integração cobrindo `ProviderVault` cache/reasoningEffort, `TurnOrchestrator` sem snapshot bloqueante pré-turno + `stage` real no prompt, e ordem otimista de mensagens em `useAshyStore`.

---

### Task 1: Contrato `ReasoningEffort` em `@ashy/shared` e Suporte a Controle de Thinking + Correções Anthropic/Valibot em `@ashy/llm`

**Files:**
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `packages/llm/src/stream-text.ts`
- Modify: `packages/llm/src/adapters.ts`
- Test: `packages/llm/test/llm.test.ts`

- [ ] **Step 1: Escrever os testes falhando (RED) em `packages/llm/test/llm.test.ts`**
  Adicionar uma suíte `describe('@ashy/llm — Phase 8.1: Reasoning Effort Control, Anthropic Tool Use & Schema Introspection', ...)` testando:
  1. `createOpenAICompatibleModel` com OpenRouter (`https://openrouter.ai/api/v1`) e `reasoningEffort: 'none'` envia `reasoning: { enabled: false, effort: 'none' }` no body do `POST /chat/completions`.
  2. `createOpenAICompatibleModel` com OpenRouter e `reasoningEffort: 'low'` envia `reasoning: { enabled: true, effort: 'low' }`.
  3. `createOpenAICompatibleModel` com Ollama (`http://127.0.0.1:11434/v1`) ou modelo `qwen/qwen3.8-flash` e `reasoningEffort: 'none'` inclui desativação de thinking (`chat_template_kwargs: { enable_thinking: false }`).
  4. `createAnthropicMessagesModel` em chamada multi-step (`maxSteps: 2`) serializa `m.toolCalls` da mensagem `assistant` como blocos `{ type: 'tool_use', id, name, input }`, repassa `temperature` e emite `usage: { promptTokens, completionTokens, totalTokens }` a partir de `message_start` e `message_delta`.
  5. `valibotSchemaToJsonSchema` converte `v.literal`, `v.union`, `v.record`, `v.tuple` e preserva `v.description(...)` em `v.pipe(v.string(), v.description('...'))`.

- [ ] **Step 2: Rodar o teste em `@ashy/llm` para verificar que falha (RED)**
  Run: `pnpm --filter @ashy/llm test`
  Expected: FAIL (propriedades `reasoning`, `tool_use`, `usage` e schemas avançados ainda não implementados).

- [ ] **Step 3: Implementar os tipos em `packages/shared/src/host-protocol.ts` e a lógica em `packages/llm/src/stream-text.ts` + `packages/llm/src/adapters.ts` (GREEN)**
  - Em `packages/shared/src/host-protocol.ts`:
    - Exportar `REASONING_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high'] as const`, `type ReasoningEffort`, `ReasoningEffortSchema = v.picklist(REASONING_EFFORT_LEVELS)`.
    - Adicionar `reasoningEffort?: ReasoningEffort` em `PublicProviderConfig`, `SaveProviderConfigInputSchema`, `TestProviderInputSchema` e `CompleteOnboardingInputSchema`.
  - Em `packages/llm/src/stream-text.ts`:
    - Exportar `type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high'`.
    - Adicionar `reasoningEffort?: ReasoningEffort` em `LanguageModelRequest` e `StreamTextOptions`, repassando em `model({ ..., reasoningEffort: options.reasoningEffort })`.
  - Em `packages/llm/src/adapters.ts`:
    - Adicionar `reasoningEffort?: ReasoningEffort` em `OpenAICompatibleModelConfig` e `AnthropicMessagesModelConfig`.
    - Aplicar payload de `reasoning` em `createOpenAICompatibleModel` (para OpenRouter, Ollama/Qwen e modelos de raciocínio) com fallback seguro se um endpoint estrito retornar HTTP 400 por parâmetro de reasoning desconhecido.
    - Corrigir `createAnthropicMessagesModel` para serializar `m.toolCalls` como blocos `tool_use`, repassar `temperature`, configurar `thinking` apenas quando `reasoningEffort` for `'low' | 'medium' | 'high'`, e acumular `usage` de `message_start` + `message_delta`.
    - Expandir `valibotSchemaToJsonSchema` para suportar `literal`, `union`, `record`, `tuple`, `description` e constraints básicas.

- [ ] **Step 4: Rodar os testes de `@ashy/llm` e `@ashy/shared` para verificar que passam (GREEN)**
  Run: `pnpm --filter @ashy/shared test && pnpm --filter @ashy/llm test`
  Expected: PASS (100% dos testes verdes).

---

### Task 2: Cache em Memória e `reasoningEffort` no `ProviderVault` + Eliminação do Snapshot Bloqueante e Fix de `RelationshipStage` no `TurnOrchestrator`

**Files:**
- Modify: `apps/desktop/src/host/provider-vault.ts`
- Modify: `apps/desktop/src/host/turn-orchestrator.ts`
- Test: `apps/desktop/src/test/phase-8-1-latency-thinking.test.ts`

- [ ] **Step 1: Escrever os testes falhando (RED) em `apps/desktop/src/test/phase-8-1-latency-thinking.test.ts`**
  Testar:
  1. `ProviderVault` retorna `reasoningEffort: 'none'` por padrão em `getPublicState()`, persiste `reasoningEffort` quando salvo via `saveProviderConfig`, repassa `reasoningEffort` ao modelo criado por `createActiveLanguageModel()`, e **não** re-descriptografa chaves do disco em chamadas consecutivas de `getPublicState()` / `createActiveLanguageModel()` quando o arquivo não mudou (verificando contagem de chamadas ao `secretProtector.decrypt`).
  2. `TurnOrchestrator.sendTurn` **não** chama `options.getBootstrapSnapshot()` antes de iniciar o stream do LLM (apenas 1 chamada ao final do turno em `turn:completed`), reduzindo o overhead pré-turno a zero.
  3. `TurnOrchestrator` passa o `stage` real do relacionamento (ex.: `'close_friend'` ou `'companion'` quando evoluído no `AshyCortex`) e `queryEmbedding` para `cortex.compileTurnPrompt`, garantindo que o system prompt compilado contenha `[RELATIONSHIP STAGE: CLOSE_FRIEND]` em vez de ficar preso em `STRANGER`.

- [ ] **Step 2: Rodar o novo arquivo de teste para verificar que falha (RED)**
  Run: `pnpm --filter @ashy/desktop test src/test/phase-8-1-latency-thinking.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implementar as melhorias em `provider-vault.ts` e `turn-orchestrator.ts` (GREEN)**
  - Em `apps/desktop/src/host/provider-vault.ts`:
    - Adicionar `reasoningEffort: ReasoningEffort` (default `'none'`) em `StoredProviderEntry` e `DEFAULT_PROVIDER_CONFIGS`.
    - Manter cache em memória de `providersRead`, `secretsRead` e mapa de chaves descriptografadas, invalidando apenas quando `saveProviderConfig` / `setActiveProvider` / `testProviderConnection` escrever no disco ou quando o `mtimeMs` do arquivo no disco mudar.
    - Passar `reasoningEffort` para `createOpenAICompatibleModel` e `createAnthropicMessagesModel` (e usar `reasoningEffort: 'none'` em `testProviderConnection` para que o ping de teste também seja instantâneo!).
  - Em `apps/desktop/src/host/turn-orchestrator.ts`:
    - Remover o bloco `fallbackSnapshot = await options.getBootstrapSnapshot()` das linhas `254-259`.
    - Obter o estágio atual de relacionamento diretamente via `cortex.getRelationshipState().stage` e o `queryEmbedding` via `embedTextSync128(input.text)` (de `@ashy/llm`) e passá-los em `cortex.compileTurnPrompt({ ..., stage, queryEmbedding })`.
    - Passar `reasoningEffort: activeConfig?.reasoningEffort ?? 'none'` em `streamText(model, { ..., reasoningEffort })`.

- [ ] **Step 4: Rodar os testes para verificar que passam (GREEN)**
  Run: `pnpm --filter @ashy/desktop test src/test/phase-8-1-latency-thinking.test.ts`
  Expected: PASS.

---

### Task 3: Inserção Otimista da Mensagem no `useAshyStore` + Seletor de Esforço de Raciocínio na UI (`ModelsSettingsPanel` & `FirstMeetingWizard`)

**Files:**
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/components/ModelsSettingsPanel.tsx`
- Modify: `apps/desktop/src/components/FirstMeetingWizard.tsx`
- Modify: `apps/desktop/src/test/phase-8-1-latency-thinking.test.ts`

- [ ] **Step 1: Adicionar testes falhando (RED) em `apps/desktop/src/test/phase-8-1-latency-thinking.test.ts`**
  Testar:
  1. Quando `sendUserMessage` é chamado e o Host emite `turn:started` antes da resolução da Promise HTTP de `sendTurn`, a bolha do usuário já está inserida otimisticamente em `chatMessages` **antes** da bolha da assistente (`chatMessages[0].role === 'user'` e `chatMessages[1].role === 'assistant'`), e ao resolver `sendTurn` a bolha otimista é atualizada in-place com o `userMessage.id` oficial sem duplicar.
  2. `ModelsSettingsPanel` renderiza o `<select data-testid="provider-reasoning-effort-select">` com default `'none'` e ao alterar e clicar em `"Salvar Modelo"`, envia `reasoningEffort` para `saveProviderConfig`.

- [ ] **Step 2: Rodar o teste para verificar que falha (RED)**
  Run: `pnpm --filter @ashy/desktop test src/test/phase-8-1-latency-thinking.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implementar inserção otimista em `useAshyStore.ts` e seletor em `ModelsSettingsPanel.tsx` / `FirstMeetingWizard.tsx` (GREEN)**
  - Em `apps/desktop/src/store/useAshyStore.ts`:
    - Incluir `reasoningEffort: 'none'` em `createInitialPublicProviders()`.
    - Em `sendUserMessage(text)`: inserir imediatamente uma mensagem otimista do usuário (`tempUserMsgId = 'msg-user-optimistic-' + nowMs`) antes de `await bridge.sendTurn(...)`. Quando `sendTurn` retornar `{ turnId, userMessage }` (ou quando `turn:started` chegar), reconciliar o ID da mensagem otimista para `msg-user-${turnId}` garantindo que a mensagem do usuário fique sempre antes de `msg-assistant-${turnId}`.
  - Em `apps/desktop/src/components/ModelsSettingsPanel.tsx` e `apps/desktop/src/components/FirstMeetingWizard.tsx`:
    - Adicionar estado `reasoningEffort` (inicializado com `currentConfig?.reasoningEffort ?? 'none'`) e `<select data-testid="provider-reasoning-effort-select">` com opções claras em português:
      - `'none'`: `'Desativado (Resposta Instantânea — Padrão)'`
      - `'minimal'`: `'Mínimo (Ultra-rápido)'`
      - `'low'`: `'Baixo (Raciocínio curto)'`
      - `'medium'`: `'Médio (Equilibrado)'`
      - `'high'`: `'Alto (Raciocínio profundo)'`
    - Incluir `reasoningEffort` no payload de `saveProviderConfig` e `testProviderConnection`.

- [ ] **Step 4: Rodar toda a suíte de testes, typecheck e verificação visual no Playwright**
  Run: `pnpm test && pnpm typecheck && pnpm build`
  Expected: 100% dos testes unitários/integração, typecheck e build passando, seguido de verificação visual com Playwright na UI de configurações e no chat.
