# ADR-0007: Agência Progressiva MCP (3 Meta-Tools), Gatekeeper em 3 Níveis, Visão Deduplicada por `dHash` e Endurecimento de Segurança

- **Status:** Accepted
- **Date:** 2026-10-31
- **Milestone:** Fase 7, Fase 8.5 & M5 — Release 1.0

---

## Context

Permitir que uma companheira digital interaja com o computador do usuário (arquivos locais, linha de comando, servidores Model Context Protocol — MCP — e captura de tela/câmera) introduz três riscos críticos:
1. **Explosão de Tokens no Prompt:** Injetar dezenas de schemas JSON completos de ferramentas MCP em todos os turnos consome milhares de tokens desnecessários e degrada a atenção do LLM sobre a personalidade (`voice.md`) e as memórias.
2. **Execução Insegura ou Silenciosa:** Ferramentas capazes de escrever arquivos ou executar comandos podem causar perda de dados, sofrer *prompt injection*, *path traversal* (`../../`) ou *command injection* (`&& rm -rf`, `$(...)`).
3. **Invasão de Privacidade Visual:** Capturar a tela continuamente sem controle físico visível ou enviar quadros idênticos repetidamente para um VLM viola a privacidade e desperdiça recursos.

## Decision

1. **Descoberta Progressiva de Ferramentas MCP com 3 Meta-Tools (`mcp-registry.ts`):**
   - Em vez de despejar todos os schemas de servidores MCP no prompt inicial, o `TurnOrchestrator` expõe apenas **3 meta-tools leves** por padrão (além das ferramentas já autorizadas na sessão):
     1. `search_mcp_tools`: busca ferramentas relevantes no registro local e nos servidores MCP externos conectados (`mcp-client.ts` stdio/HTTP);
     2. `get_mcp_tool_details`: carrega sob demanda o JSON Schema completo apenas da ferramenta escolhida;
     3. `call_mcp_tool`: submete a chamada ao `ActionGatekeeper`.

2. **Action Gatekeeper em 3 Níveis (`Observe != Prepare != Execute`) + `action_audit_log`:**
   - Toda ferramenta é classificada em um de 3 níveis de risco (`gatekeeper.ts`):
     - **`observe-only`:** metadados não sensíveis (ex.: título da janela ativa quando autorizado);
     - **`read-safe`:** leitura dentro dos diretórios explicitamente permitidos (`allowedPaths`);
     - **`staged-confirm`:** qualquer escrita de arquivo, comando de limpeza/shell ou mutação externa.
   - Ferramentas `staged-confirm` **nunca executam diretamente**: elas geram uma proposta preparada (`PendingAction`) com caminho, comando e **diff visual** na UI, exigindo aprovação humana explícita (**Aprovar 1x**, **Aprovar na Sessão** ou **Recusar**).
   - Toda tentativa, aprovação, recusa e execução é gravada de forma imutável em `action_audit_log` no `ashy.db` e exibida no **Consent Center**.

3. **Endurecimento Adversarial de Segurança (Host, IPC e Ferramentas):**
   - **Prevenção de *Path Traversal*:** `read_workspace_file` e `write_project_note` resolvem `path.resolve` e validam estritamente que o caminho alvo está contido dentro de `allowedPaths`, bloqueando `../`, caminhos absolutos fora do escopo e bytes nulos (`\0`).
   - **Prevenção de *Command Injection*:** `run_cleanup_command` valida comandos contra uma *allowlist* estrita e bloqueia metacaracteres de shell (`;`, `&&`, `||`, `|`, `` ` ``, `$()`, `>`, `<`).
   - **Isolamento do Electron e IPC:** `BrowserWindow` opera com `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, bloqueio de navegação externa (`will-navigate` / `setWindowOpenHandler`) e verificação de `event.senderFrame` em todos os handlers `ipcMain.handle`.

4. **Visão Autorizada com Filtro Perceptual `dHash` 64-bit e Escudo de Privacidade (`Kill Switch`):**
   - O modo `Eyes` vem **desligado por padrão (`off`)**. Quando ativado pelo usuário, cada quadro capturado (`desktopCapturer` / câmera `2 fps`) passa por um hash perceptual **dHash de 64 bits** (`dhash.ts`): quadros cuja distância de Hamming em relação ao quadro anterior seja menor ou igual ao limiar são descartados localmente antes de qualquer envio ao modelo.
   - O **Escudo de Privacidade Total (`activateFullPrivacyShield` / `Ctrl+Shift+K`)** desliga instantaneamente `Mic`, `Eyes`, ativa `DND`, interrompe streams de áudio/LLM e cancela todas as ações pendentes no Gatekeeper.

## Consequences

### Positivas
- **Economia drástica de contexto:** As 3 meta-tools mantêm o prompt enxuto independentemente de quantos servidores MCP o usuário conecte.
- **Segurança verificável:** Nenhuma escrita ou comando ocorre sem aprovação humana explícita e validação contra *path traversal* / *command injection*.
- **Controle físico imediato:** Os 6 atalhos globais (`Ctrl+Shift+M/E/D/H/Space/K`) e o menu da Bandeja do Sistema garantem que o usuário possa revogar sensores em milissegundos.

### Negativas / Trade-offs
- Quando a Ashy descobre uma ferramenta nova via `search_mcp_tools` -> `get_mcp_tool_details` -> `call_mcp_tool`, o turno realiza um passo adicional de tool-calling antes da execução.

## Codebase References
- `packages/agency/src/mcp-registry.ts`
- `packages/agency/src/mcp-client.ts`
- `packages/agency/src/gatekeeper.ts`
- `packages/agency/src/privacy.ts`
- `packages/agency/src/dhash.ts`
- `apps/desktop/src/main/agency-runtime.ts`
- `apps/desktop/src/main/turn-orchestrator.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/preload/index.ts`
