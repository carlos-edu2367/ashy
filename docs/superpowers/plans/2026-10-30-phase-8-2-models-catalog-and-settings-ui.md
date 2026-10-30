# Fase 8.2 — Unificação de Modelos LLM, Catálogo/Busca por Provider & Limpeza da UI de Configurações

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (or `superpowers:executing-plans`) to implement this plan task-by-task using strict TDD (`RED -> GREEN -> REFACTOR`).

**Goal:** Eliminar o split-brain entre `SUPPORTED_MODELS` hardcoded e o `ProviderVault`, adicionar descoberta/listagem real de modelos na API de cada provedor (`GET /v1/models` e `/api/tags` no Ollama) com busca e seletor interativo em `ModelsSettingsPanel.tsx` e `FirstMeetingWizard.tsx`, e tornar funcional a filtragem por sub-abas e salvamento de preferências em `Configurações`.

**Architecture:**
1. **`@ashy/shared` (`host-protocol.ts`) & Host (`provider-vault.ts`, `kernel.ts`, `vite-host-plugin.ts`, `preload/index.ts`, `ashy-host-client.ts`):** Adicionar o contrato RPC `listProviderModels` que consulta em tempo real o catálogo de modelos de `openrouter`, `anthropic`, `openai`, `nvidia-nim` (`GET /models`) e `ollama` (`GET /api/tags` ou `/v1/models`), com catálogo fallback curado caso o provedor esteja offline ou sem chave.
2. **Store (`useAshyStore.ts`) & UI de Modelos (`ModelsSettingsPanel.tsx`, `FirstMeetingWizard.tsx`):** Sincronizar `activeModelId` diretamente com `providers.configs[providers.activeProviderId].modelId` em `applyBootstrapSnapshot`, `saveProviderConfig` e `setActiveProvider`. Adicionar busca instantânea (`provider-model-search-input`), botão de atualizar catálogo (`refresh-provider-models-btn`) e lista clicável de modelos (`provider-model-catalog-list`) em `ModelsSettingsPanel.tsx` e `FirstMeetingWizard.tsx`.
3. **Unificação Visual & Sub-abas de Configurações (`App.tsx`):** Substituir as listas hardcoded de `SUPPORTED_MODELS` no popover do chat, controles rápidos do palco e painel de configurações pelos provedores reais de `state.providers.configs`, fazer as sub-abas (`Todas`, `Geral`, `Voz`, `Modelos`, `Privacidade`) filtrarem os cards de configuração, exibir data/hora reais na pré-visualização e ligar o botão `"Salvar preferências"` ao host/store com feedback visual.

---

### Task 1: Contrato RPC `listProviderModels` em `@ashy/shared` e Implementação Real em `ProviderVault`, `Kernel` e `HostBridge`

**Files:**
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `apps/desktop/src/host/provider-vault.ts`
- Modify: `apps/desktop/src/host/kernel.ts`
- Modify: `apps/desktop/src/host/vite-host-plugin.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/services/ashy-host-client.ts`
- Create: `apps/desktop/src/test/phase-8-2-provider-models-catalog.test.ts`

- [ ] **Step 1 (RED):** Criar `apps/desktop/src/test/phase-8-2-provider-models-catalog.test.ts` testando:
  1. `providerVault.listProviderModels({ providerId: 'openrouter' })` busca `GET https://openrouter.ai/api/v1/models` com header `Authorization: Bearer <apiKey>` e retorna os modelos parseados (`source: 'remote'`).
  2. `providerVault.listProviderModels({ providerId: 'ollama' })` busca `GET http://127.0.0.1:11434/api/tags` e retorna os modelos locais instalados (`source: 'remote'`).
  3. `providerVault.listProviderModels({ providerId: 'anthropic' })` envia `x-api-key` e `anthropic-version: 2023-06-01` para `GET https://api.anthropic.com/v1/models`.
  4. Resiliência Adversária: quando a chamada HTTP falha (ex.: HTTP 500 ou offline) ou a chave ainda não foi configurada, `listProviderModels` não lança exceção não tratada — retorna `{ source: 'fallback', models: [...], error: ... }` com modelos curados do provedor.
- [ ] **Step 2 (Verify RED):** Rodar `pnpm --filter @ashy/desktop test src/test/phase-8-2-provider-models-catalog.test.ts` e confirmar que falha.
- [ ] **Step 3 (GREEN):** Implementar os schemas em `packages/shared/src/host-protocol.ts` e o método `listProviderModels` em `provider-vault.ts`, `kernel.ts`, `vite-host-plugin.ts`, `preload/index.ts` e `ashy-host-client.ts`.
- [ ] **Step 4 (Verify GREEN):** Rodar `pnpm --filter @ashy/shared test; pnpm --filter @ashy/desktop test src/test/phase-8-2-provider-models-catalog.test.ts`.

---

### Task 2: Sincronização Universal de `activeModelId` no Zustand Store & Seletor/Busca de Modelos em `ModelsSettingsPanel.tsx` e `FirstMeetingWizard.tsx`

**Files:**
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/components/ModelsSettingsPanel.tsx`
- Modify: `apps/desktop/src/components/FirstMeetingWizard.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/test/desktop.test.tsx`
- Create: `apps/desktop/src/test/phase-8-2-ui-models-and-settings.test.tsx`

- [ ] **Step 1 (RED):** Criar `apps/desktop/src/test/phase-8-2-ui-models-and-settings.test.tsx` testando:
  1. `bootstrapFromHost()`, `saveProviderConfig()` e `setActiveProvider()` atualizam automaticamente `state.activeModelId` com o `modelId` real do provedor ativo no `ProviderVault` (ex.: `qwen/qwen3.8-flash`), refletindo na topbar e no popover de contexto do chat.
  2. `ModelsSettingsPanel` renderiza o campo de busca de modelos (`data-testid="provider-model-search-input"`), botão de buscar/atualizar catálogo (`data-testid="refresh-provider-models-btn"`) e lista de modelos (`data-testid="provider-model-catalog-list"`). Ao filtrar por `"qwen"` e clicar em uma opção, o input `provider-model-id-input` é preenchido com o ID do modelo escolhido.
  3. Em `Configurações` (`tab-agency`), clicar nas sub-abas `subtab-modelos`, `subtab-voz`, `subtab-geral` e `subtab-privacidade` filtra os cards exibidos, e clicar novamente na sub-aba ativa (ou em `subtab-todas`) volta a exibir todas as seções.
  4. Clicar em `"Salvar preferências"` (`data-testid="btn-save-preferences"`) exibe confirmação `"Preferências salvas ✓"`.
- [ ] **Step 2 (Verify RED):** Rodar `pnpm --filter @ashy/desktop test src/test/phase-8-2-ui-models-and-settings.test.tsx` e confirmar que falha.
- [ ] **Step 3 (GREEN):**
  - Atualizar `useAshyStore.ts` para expor `providerModelCatalog`, `isLoadingProviderModels`, `listProviderModels(input)`, sincronizar `activeModelId` com `providers.configs[providers.activeProviderId].modelId`, e suportar `setActiveModelId` sincronizado com `providers`.
  - Atualizar `ModelsSettingsPanel.tsx` e `FirstMeetingWizard.tsx` com busca, botão de atualizar catálogo da API e lista clicável de modelos.
  - Atualizar `App.tsx` para exibir os modelos configurados em `state.providers.configs` (substituindo `SUPPORTED_MODELS` hardcoded na UI), filtrar os cards de `Configurações` por `settingsSubTab`, mostrar data/hora reais na pré-visualização e mostrar feedback ao clicar em `"Salvar preferências"`.
  - Ajustar a asserção legada em `apps/desktop/test/desktop.test.tsx:185` para esperar `'anthropic/claude-3.7-sonnet'` (o modelo real salvo no `beforeEach` na linha 62).
- [ ] **Step 4 (Verify GREEN):** Rodar `pnpm test; pnpm typecheck; pnpm build`.
