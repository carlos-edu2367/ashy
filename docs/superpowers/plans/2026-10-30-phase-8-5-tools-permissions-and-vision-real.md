# Phase 8.5: Conexão das Tools/MCP ao Chat, Permissões Unificadas & Visão/Desktop Reais — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conectar o `ProgressiveMcpRegistry` e o `ActionGatekeeper` diretamente ao fluxo de chat (`TurnOrchestrator` + `SoulComposer`), eliminar o runtime duplicado/mockado de `useAshyStore.ts` hidratando e persistindo 100% das permissões no Host, e substituir todas as tools nativas mockadas, captura/visão stubada e lacunas de protocolo MCP externo por implementações reais.

**Architecture:**
1. **Frente 3 (MCP Client, Tools Nativas Reais & Visão VLM Real):**
   - Em `packages/agency/src/mcp-client.ts`, enviar a notificação JSON-RPC 2.0 `notifications/initialized` (sem `id` ou ignorando resposta vazia/202) logo após o handshake `initialize` em `createHttpMcpClient` e `createStdioMcpClient`, e garantir que `registerIntoProgressiveRegistry` execute `initialize()` automaticamente caso ainda não tenha sido inicializado.
   - Em `apps/desktop/src/host/agency-runtime.ts`:
     - Incluir `process.cwd().replace(/\\/g, '/')` nos `allowedPaths` padrão e reconectar automaticamente os `externalMcpServers` persistidos durante o boot de `createHostAgencyRuntime`.
     - Tornar `get_active_window_title` real consultando a janela ativa do SO (via PowerShell `Get-Process` com `MainWindowTitle` no Windows, `osascript` no macOS, `xdotool`/`xprop` no Linux, com timeout curto e fallback limpo quando indisponível ou em ambiente headless).
     - Tornar `read_workspace_file` real resolvendo `/workspace/ashy/...` para `userDataDir/workspace/...` (se existir) ou para a raiz real do workspace (`process.cwd()`) e lançando erro explícito (`ENOENT`) quando o arquivo não existir no disco (removendo o fallback falso `'export const PACKAGE_NAME = "@ashy/desktop"'`).
     - Tornar `write_project_note` real gravando e verificando a existência e tamanho real no disco dentro dos `allowedPaths`.
     - Tornar `run_cleanup_command` real executando o comando em subprocesso com `cwd` validado dentro dos `allowedPaths`, timeout de segurança (10s) e captura real de `stdout`, `stderr` e `exitCode`.
     - Substituir a visão stubada (`describeFrame` fixo e gradiente falso quando não há fixture de teste) por captura real de tela/janela (via Electron `desktopCapturer` / PowerShell/.NET screen bitmap sample ou RGBA real enviado pelo cliente) e descrição real via modelo VLM/LLM ativo no `ProviderVault` (com fallback determinístico local quando nenhum provider estiver configurado/ativo em testes offline).
2. **Frente 1 (Injeção de Tools no Chat via `TurnOrchestrator` + `SoulComposer`):**
   - Em `packages/cortex/src/prompt/soul-composer.ts` (`ComposeTurnPromptInput`, `buildStaticSoulSystemPrompt`, `buildVolatileTurnContext`) e `packages/cortex/src/ashy-cortex.ts`, documentar explicitamente as capacidades de ferramentas MCP e Desktop da Ashy (`search_mcp_tools`, `get_mcp_tool_details`, `call_mcp_tool` e tools nativas `get_active_window_title`, `capture_authorized_screen`, `read_workspace_file`, `write_project_note`, `run_cleanup_command`), regras de segurança do `ActionGatekeeper` (`observe-only`, `read-safe`, `staged-confirm`, `auto_accept`) e estado atual de permissões (`approvalPolicy`, `eyesMode`, `allowedPaths`).
   - Em `apps/desktop/src/host/turn-orchestrator.ts` e `apps/desktop/src/host/kernel.ts`, injetar `agencyRuntime` no `TurnOrchestrator`, construir `ToolDefinition[]` reais (para as 3 meta-tools `search_mcp_tools`, `get_mcp_tool_details`, `call_mcp_tool` + atalhos diretos para as tools registradas no `ProgressiveMcpRegistry`, todas passando obrigatoriamente por `agencyRuntime.callMcpTool` / `ActionGatekeeper` e gravando no `action_audit_log`), passar `tools` e `maxSteps: 5` para `streamText`, e emitir eventos de atualização quando uma tool gerar `PendingActionCard` (`status: 'staged'`) ou executar.
3. **Frente 2 (Unificação do Store com o Host & Persistência Completa de Permissões):**
   - Em `apps/desktop/src/store/useAshyStore.ts`, remover o runtime duplicado `createAgencyRuntime()` com handlers falsos (`buildRendererPatternFrame`, `'VS Code — Ashy Companion'`, `'export const PACKAGE_NAME = "@ashy/desktop"'`, `exitCode: 0` fake) e hidratar `snapshot.agency` dentro de `applyBootstrapSnapshot` (além de atualizar o estado de agency após cada `turn:completed` e cada RPC de agency).
   - Garantir que todas as ações de privacidade, presença e Consent Center (`setEyesMode`, `setMicMode`, `setDndMode`, `activatePrivacyShield`, `setComputerActionsEnabled`, `setComputerActionsPolicy`, `setDontAskMode`, `setToolRiskTier`, `addAllowedPath`, `removeAllowedPath`, `revokeSessionApproval`, `revokeAllSessionApprovals`, `connectExternalMcpServer`, `removeExternalMcpServer`, `captureAuthorizedScreen`, `triggerMcpTool`, `approvePendingAction`, `denyPendingAction`, `setQuietHoursRange`) persistam no Host via RPC (`updateAgencyConsent`, `updateInitiativePolicy`, etc.) e sincronizem o snapshot retornado sem `.catch(() => {})` mudos que descartem estado.

**Tech Stack:** TypeScript, Node.js (`child_process`, `fs`, `path`), `@ashy/agency`, `@ashy/cortex`, `@ashy/llm`, `@ashy/shared`, Zustand (`useAshyStore.ts`), React 19, Vitest.

---

### Task 1: Frente 3 — Desmockagem do MCP Client, Tools Nativas e Visão Real (`packages/agency/src/mcp-client.ts` & `apps/desktop/src/host/agency-runtime.ts`)

**Files:**
- Modify: `packages/agency/src/mcp-client.ts`
- Modify: `packages/agency/test/agency.test.ts`
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `apps/desktop/src/host/agency-runtime.ts`
- Modify: `apps/desktop/src/host/kernel.ts`
- Create: `apps/desktop/src/test/phase-8-5-native-tools-vision-mcp.test.ts`

- [x] **Step 1: Escrever testes falhando (RED) em `apps/desktop/src/test/phase-8-5-native-tools-vision-mcp.test.ts`**
  Testar:
  1. `createHttpMcpClient` e `createStdioMcpClient` enviam `notifications/initialized` logo após `initialize`, e `registerIntoProgressiveRegistry` chama `initialize()` automaticamente se ainda não inicializado.
  2. `createHostAgencyRuntime` reconecta automaticamente `externalMcpServers` persistidos em `agency-consent.json` durante o boot.
  3. `allowedPaths` inclui `process.cwd()` por padrão; `read_workspace_file` lê arquivos reais do projeto (ex.: `/workspace/ashy/package.json` ou caminho real no workspace) e falha/retorna erro claro quando um arquivo inexistente é solicitado (nunca mais retornando `'export const PACKAGE_NAME = "@ashy/desktop"'`).
  4. `get_active_window_title` obtém título real da janela ativa do SO (ou usa `windowTitle` explícito) sem retornar `'VS Code — Ashy Companion'` fixo quando há janela real disponível.
  5. `run_cleanup_command` executa o comando real após aprovação no Gatekeeper, capturando `stdout`, `stderr` e `exitCode` reais.
  6. `captureAuthorizedScreen` usa o modelo ativo do `ProviderVault` (via `fetchImpl`) quando configurado para descrever o frame capturado e contabiliza `visionTokensSpent` reais.

- [x] **Step 2: Implementar as melhorias em `packages/agency/src/mcp-client.ts` e `apps/desktop/src/host/agency-runtime.ts` (GREEN)**
  - Em `packages/agency/src/mcp-client.ts`:
    - Adicionar envio de notificação JSON-RPC 2.0 `{ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }` em `createHttpMcpClient.initialize()` e `createStdioMcpClient.initialize()`.
    - Controlar flag `let initialized = false` para que `registerIntoProgressiveRegistry` chame `if (!initialized) await this.initialize()` antes de `this.listTools()`.
  - Em `apps/desktop/src/host/agency-runtime.ts`:
    - Receber opcionalmente `providerVault?: ProviderVault` e `fetchImpl?: typeof fetch` em `HostAgencyRuntimeOptions` (e passar a partir de `kernel.ts`).
    - Adicionar `process.cwd().replace(/\\/g, '/')` aos `allowedPaths` padrão.
    - Reconectar `consent.externalMcpServers` no boot (com tratamento gracioso caso um servidor externo offline falhe ao conectar no boot, mantendo-o na lista).
    - Implementar consulta real de janela ativa do SO (`queryOsActiveWindowTitle`), `read_workspace_file` real sem mock `'@ashy/desktop'`, `run_cleanup_command` real com execução controlada e captura de saída, e `visionProvider.describeFrame` integrado ao `providerVault`.

---

### Task 2: Frente 1 — Injeção de Tools no Chat (`TurnOrchestrator` + `SoulComposer`)

**Files:**
- Modify: `packages/cortex/src/prompt/soul-composer.ts`
- Modify: `packages/cortex/src/ashy-cortex.ts`
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `apps/desktop/src/host/turn-orchestrator.ts`
- Modify: `apps/desktop/src/host/kernel.ts`
- Create: `apps/desktop/src/test/phase-8-5-chat-tools-orchestrator.test.ts`

- [x] **Step 1: Escrever testes falhando (RED) em `apps/desktop/src/test/phase-8-5-chat-tools-orchestrator.test.ts`**
  Testar:
  1. `compileTurnPrompt` / `composeTurnPrompt` inclui na system prompt e no contexto volátil a seção `[Desktop Agency, Vision & MCP Tools]` listando as meta-tools (`search_mcp_tools`, `get_mcp_tool_details`, `call_mcp_tool`), as tools registradas (`get_active_window_title`, `capture_authorized_screen`, `read_workspace_file`, `write_project_note`, `run_cleanup_command`) e o estado atual de permissões (`approvalPolicy`, `eyesMode`, `allowedPaths`), para que a Ashy nunca diga que não recebeu schemas/tools.
  2. Durante `sendTurn` no `TurnOrchestrator`, `streamText` recebe `tools` reais e `maxSteps`. Quando o LLM emite uma `tool_call` (ex.: `read_workspace_file` ou `call_mcp_tool`), o `TurnOrchestrator` executa a tool passando pelo `ActionGatekeeper`, registra a decisão no `action_audit_log` do SQLite e envia o `tool_result` de volta ao LLM no passo seguinte para concluir a resposta.
  3. Quando o LLM chama uma tool `staged-confirm` (ex.: `write_project_note` ou `run_cleanup_command`) no modo `ask`, o `ActionGatekeeper` gera um `PendingActionCard` (`status: 'staged'`), o snapshot do turno reflete a ação pendente em `snapshot.agency.pendingActions`, e a Ashy informa ao usuário que a ação aguarda confirmação no card.

- [x] **Step 2: Implementar a injeção de tools em `soul-composer.ts`, `ashy-cortex.ts`, `turn-orchestrator.ts` e `kernel.ts` (GREEN)**
  - Atualizar `soul-composer.ts` e `ashy-cortex.ts` para aceitar metadados das tools/permissões ativas e instruir a Ashy a usar `call_mcp_tool` ou as tools expostas diretamente sem jamais alegar falta de catálogo de tools.
  - Em `turn-orchestrator.ts`:
    - Receber `agencyRuntime?: HostAgencyRuntime` nas opções e conectar em `kernel.ts`.
    - Criar as `ToolDefinition[]` com schemas Valibot (`v.object(...)`) para `search_mcp_tools`, `get_mcp_tool_details`, `call_mcp_tool` e para as tools registradas no `agencyRuntime`, roteando toda execução por `agencyRuntime.callMcpTool`.
    - Passar `tools` e `maxSteps: 5` para `streamText`.

---

### Task 3: Frente 2 — Eliminação do Runtime Duplicado no Browser & Persistência Completa de Permissões (`useAshyStore.ts` & `App.tsx`)

**Files:**
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/test/phase-8-5-store-permissions-sync.test.tsx`

- [x] **Step 1: Escrever testes falhando (RED) em `apps/desktop/src/test/phase-8-5-store-permissions-sync.test.tsx`**
  Testar:
  1. `bootstrapFromHost()` hidrata `privacyState`, `computerActionsPolicy`, `computerActionsEnabled`, `agencyTools`, `toolRiskOverrides`, `sessionApprovedTools`, `visionTelemetry`, `externalMcpServers`, `pendingActions` e `auditLog` diretamente de `snapshot.agency` do Host.
  2. Quando um turno de chat no Host gera um `PendingActionCard` (ex.: LLM chamou `write_project_note` em modo `ask`), `useAshyStore.getState().pendingActions` recebe o card automaticamente ao atualizar o snapshot do turno e renderiza `chat-pending-actions-bar` na tela do Studio.
  3. Alterar `setComputerActionsEnabled(false)` persiste `approvalPolicy: 'off'` no Host; alterar `setQuietHoursRange('21:00 - 06:00')` na UI persiste `quietHoursStart: '21:00'` e `quietHoursEnd: '06:00'` em `updateInitiativePolicy` no Host; e reiniciar o store (`resetAshyStore` + `bootstrapFromHost`) preserva 100% das permissões salvas no Host.

- [x] **Step 2: Implementar a unificação do store e persistência em `useAshyStore.ts` e `App.tsx` (GREEN)**
  - Em `useAshyStore.ts`:
    - Criar helper `applyAgencySnapshotToState(agency: AgencySnapshot)` e invocá-lo em `applyBootstrapSnapshot` e em todos os retornos de RPC de agency (`updateAgencyConsent`, `callMcpTool`, `approvePendingAction`, `denyPendingAction`, `revokeSessionPermissions`, `connectExternalMcpServer`, `removeExternalMcpServer`, `captureAuthorizedScreen`).
    - Fazer `setComputerActionsEnabled` persistir `approvalPolicy: enabled ? 'ask' : 'off'` no Host.
    - Fazer `setQuietHoursRange` extrair `HH:MM - HH:MM` e persistir via `bridge.updateInitiativePolicy`.
    - Remover os mocks falsos (`'export const PACKAGE_NAME = "@ashy/desktop"'` etc.) do fallback local do store.
    - Em `captureAuthorizedScreen`: quando no browser/Electron, capturar frame real (ou enviar para o Host) e sincronizar `lastPrompt.systemPrompt` com `Active screen: ${obs.windowTitle} — ${obs.summary}` quando `obs.observed && obs.summary`.
