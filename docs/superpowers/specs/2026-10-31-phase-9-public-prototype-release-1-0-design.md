# ASHY — Especificação de Design da Fase 9: Protótipo Público (Marco M5 — Release 1.0)

**Data:** 2026-10-31  
**Status:** Aprovada pelo Carlos + Blindada pós-Auditoria Red Team  
**Escopo:** Fase 9 (`docs/ASHY_ROADMAP.md`) — Onboarding Zero-to-First-Conversation, Empacotamento Desktop Electron & Ciclo de Vida Nativo, Portabilidade da Alma (`ashy.db` Export/Import/Wipe), Privacidade & Criptografia em Repouso (`AES-256-GCM`) + Hardening Adversarial (IPC/HTTP/MCP/Zero Telemetria), Suíte E2E Playwright Real (6 Fluxos + Fases 8.1–8.7) e Documentação Release 1.0 & ADRs.

---

## 1. Diagnóstico Inicial & Achados Proativos (Subagentes + Red Team)

A auditoria paralela do repositório e o ataque do subagente **Adversarial Red Team** identificaram lacunas funcionais da Fase 9, vulnerabilidades de segurança/concorrência e potenciais regressões em testes existentes — todas resolvidas no design abaixo:

### 1.1 Vulnerabilidades de Segurança e Privacidade (Auditoria Adversarial)
1. **`[VULN-MCP1 — CRÍTICO]` Exposição de `.master.key` e `providers.secrets.json` para `read_workspace_file`:**
   - Em `apps/desktop/src/host/agency-runtime.ts`, `normalizedUserDataDir` (`apps/desktop/.ashy-data`) faz parte de `privacyController.allowedPaths`. Sem uma *denylist* de arquivos sensíveis, `read_workspace_file` (`'read-safe'`) permitiria ler `.master.key`, `providers.secrets.json`, `voice-settings.json` e `ashy.db` sem confirmação no `ActionGatekeeper`.
   - **Correção:** Impor uma função centralizada `isSensitiveHostPath(targetPath)` no `ActionGatekeeper` e no `agency-runtime.ts` (`read_workspace_file`, `write_project_note`, `run_cleanup_command`) que bloqueia incondicionalmente qualquer acesso a `.master.key*`, `*.secrets.json`, `voice-settings.json*`, `providers.json*`, `stage-preferences.json*`, `ashy.db*`, `.env*`, `.git/config` e chaves privadas (`*id_rsa*`, `*.pem`), mantendo diretórios de trabalho como `workspace/`, `notes/` e subpastas temporárias funcionais.
2. **`[VULN-MCP2 — CRÍTICO]` Escape de Symlink / Junction em `resolveWorkspacePath` (`agency-runtime.ts`):**
   - `ActionGatekeeper.isPathAllowedWithSymlinkGuard('/workspace/ashy/link')` executava `fs.lstatSync` sobre o prefixo virtual `/workspace/ashy/...` (que falha com `ENOENT` no Windows e retorna `true` no `catch`), e `resolveWorkspacePath` não validava `fs.lstatSync` / `fs.realpathSync` no caminho físico resolvido.
   - **Correção:** Executar `fs.lstatSync` e `fs.realpathSync` diretamente sobre o **caminho físico resolvido** (e sobre o diretório-pai para novos arquivos), rejeitando qualquer symlink ou alvo cujo `realpath` saia das raízes físicas autorizadas.
3. **`[VULN-MCP3 — CRÍTICO]` Injeção de Comando Shell e Aprovação Ampla em `run_cleanup_command` (`agency-runtime.ts` + `action-gatekeeper.ts`):**
   - Comandos fora do regex `^rm\s+...` caíam em `powershell.exe -Command <command>` / `/bin/sh -c <command>`, e aprovar na sessão liberava a tool por nome genérico.
   - **Correção (compatível com testes da Fase 8.5):**
     1. Banir encadeamento/redirecionamento/expansão de shell (`[;&|><$\`\r\n]`) e nunca invocar `powershell -Command` ou `/bin/sh -c` sobre comandos arbitrários. Permitir apenas remoção segura (`rm`) de caminhos não-sensíveis dentro de `allowedPaths` ou execução controlada via `execFile(process.execPath, ['-e', expr], { shell: false })` bloqueando acesso a `child_process` ou arquivos da *denylist*.
     2. No `ActionGatekeeper`, aprovações de sessão para ferramentas de comando (`run_cleanup_command`) vinculam o hash exato de `toolName + canonicalizeJson(args)`.
4. **`[VULN-MCP4 — ALTO]` SSRF em MCP HTTP e Vazamento de `process.env` em MCP Stdio (`packages/agency/src/mcp-client.ts`):**
   - **Correção:** Validar URLs em `createHttpMcpClient` contra IPs de metadata de nuvem/link-local (`169.254.169.254`, `0.0.0.0`, `metadata.google.internal`, `169.254.*`) e filtrar `process.env` em `createStdioMcpClient` para uma allowlist mínima (`PATH`, `SYSTEMROOT`, `SystemRoot`, `COMSPEC`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `LANG`, `NODE_ENV`) + `config.env`.
5. **`[VULN-HTTP1 / VULN-HTTP2 / VULN-HTTP3 — ALTO]` Hardening da Bridge Local HTTP/SSE (`vite.config.ts` & `vite-host-plugin.ts`):**
   - **Correção:** Fixar `host: '127.0.0.1'` em `server` e `preview` no `vite.config.ts`; exigir o cabeçalho anti-CSRF `X-Ashy-Request: 1` em todas as chamadas `POST /__ashy_host/rpc` (mantendo `GET /__ashy_host/events` compatível com `EventSource` nativo do browser via validação de `Origin`/`Sec-Fetch-Site`); validar `senderFrame` no `ipcMain.handle`; e chamar `req.destroy()` imediatamente quando o body ultrapassar `MAX_RPC_BODY_BYTES`.
6. **`[VULN-EL1 / VULN-EL2 / VULN-EL3 / VULN-TEL1 — PRIVACIDADE & ELECTRON]` Zero Telemetria, CSP e Sandbox do Electron:**
   - **Correção:** Remover links externos do Google Fonts de `apps/desktop/index.html`, adicionar meta tag CSP local estrita em `index.html`, ativar `sandbox: true` e `webSecurity: true` em todas as janelas Electron (`hubWindow` e `overlayWindow`), e bloquear `will-navigate` / `setWindowOpenHandler` para origens externas.

### 1.2 Correções Arquiteturais do Red Team (Concorrência, Criptografia no Reboot & Banco)
7. **`[REDTEAM-1 — CRÍTICO]` Persistência do Estado de Criptografia em Repouso & Codec no Boot do `CortexDatabase`:**
   - `new AshyCortex()` executa `this.pruneCorruptedAndTrivialEpisodes()` dentro do construtor (`ashy-cortex.ts:163`). Se o estado de criptografia não estiver salvo em tabela dedicada (`cortex_encryption_state`) e o `encryptionCodec` não for injetado via `CortexDatabaseOptions` no construtor, reiniciar o app após ativar `encryptionAtRest: true` leria texto cifrado `enc:v1:...` como texto puro!
   - **Correção:** Adicionar tabela `cortex_encryption_state` no schema SQLite, injetar `encryptionCodec` diretamente em `CortexDatabaseOptions` / `createAshyCortex`, e descriptografar em todos os row mappers de leitura do SQLite (`cortex-db.ts`) quando `this.sqlite !== null`.
8. **`[REDTEAM-2 — CRÍTICO]` Envelopamento da DEK no `SecretProtector` sem `.master.key` em texto puro:**
   - Quando `safeStorage.isEncryptionAvailable()` é `true`, o `SecretProtector` envelopa a chave mestre de 32 bytes (DEK) em `.master.key.dpapi` via `safeStorage` (sem criar `.master.key` em texto puro) e executa `AES-256-GCM` com AAD (`table.column`) em memória usando a DEK de 32 bytes.
9. **`[REDTEAM-3 — CRÍTICO]` Proteção por `mutationEpoch` contra Condições de Corrida em `wipeAllData`, `importSoul` e `setEncryptionAtRest`:**
   - Um turno em andamento (`sendTurn`), extração pós-episódio (`consolidateSessionMemories`) ou `DreamWorker` que estava aguardando resposta assíncrona do LLM no exato milissegundo em que `wipeAllData()` é chamado poderia gravar dados fantasmas no banco recém-limpo.
   - **Correção:** Contador monotônico `mutationEpoch` em `AshyCortex` e `AshyHostKernel`, incrementado no início de `wipeAllData()`, `importSoul()` e `setEncryptionAtRest()`. Qualquer operação assíncrona verifica `epochAtStart === currentEpoch` antes de gravar no banco e descarta silenciosamente o resultado se o epoch mudou.
10. **`[REDTEAM-4 — ALTO]` Serialização Canônica Determinística (`canonicalizeJson`) e Anti-Prototype-Pollution no `.ashy-soul`:**
    - `checksumSha256` é calculado sobre `canonicalizeJson(payload)` (chaves ordenadas lexicograficamente em todas as profundidades e rejeição de `__proto__`, `constructor`, `prototype`), garantindo que diferenças de ordem de chaves após transporte IPC/HTTP ou parse do Valibot nunca causem falso erro de checksum.
11. **`[BUG-ONB1 / BUG-ONB2 / BUG-TEST1]`:**
    - Persistir `unifiedOmniMode` e `directOmniAudio` no Host em `setUnifiedOmniMode`, `setDirectOmniAudio` e `applyOmniModelPreset`; corrigir `"Desativado"` em `setQuietHoursRange`; definir `seedFirstGreeting?: boolean` (default `false` no RPC para não alterar `turnCount` de testes unitários legados, e `true` quando disparado pelo `FirstMeetingWizard.tsx` com `consolidatedEpisodeId: 'milestone-first-meeting'`); e incluir `apps/**/src/test/**/*.test.{ts,tsx}` no `vitest.config.ts`.

---

## 2. Detalhamento dos 6 Pilares

1. **Pilar 1 — Primeiro Boot & Onboarding Real (`Zero-to-First-Conversation`):**
   - `FirstMeetingWizard.tsx` com escolha entre **Modo Local / Omni Unificado (`LFM3-Omni-2B`)** e **Modo Cloud / Híbrido**, configuração explícita de permissões (`Olhos`, `Ouvidos`, `Mãos`, `Horários de Silêncio`), testes reais de conexão LLM, microfone e voz TTS/Omni, e transição direta para a primeira conversa real com saudação inicial da Ashy.
2. **Pilar 2 — Empacotamento Desktop Real & Ciclo de Vida Nativo (`apps/desktop` Electron):**
   - Build de `renderer`, `main` e `preload` + `electron-builder.yml` (Windows NSIS/Portable, macOS DMG/Zip, Linux AppImage/deb), `System Tray` (`tray-manager.ts`), 6 atalhos globais (incluindo `Push-to-Talk` `Ctrl+Shift+Space` e `Privacy Shield / Kill Switch` `Ctrl+Shift+K`), `singleInstanceLock` e `autoUpdater` seguro com consentimento explícito (`autoDownload = false`).
3. **Pilar 3 — Portabilidade da Alma (`ashy.db` Export / Import / 1-Click Wipe):**
   - Arquivo `.ashy-soul` (`ASHY_SOUL_V1`) com manifesto, `checksumSha256` canônico, `voice.md`, preferências não-sensíveis e todas as tabelas do `ashy.db` (zero segredos). Importação transacional (`BEGIN IMMEDIATE ... COMMIT`) com validação de integridade, ordem correta de chaves estrangeiras e proteção contra corrupção/SQLi. Botão **"Apagar Tudo com 1 Clique"** atômico (`VACUUM` + `wal_checkpoint(TRUNCATE)` fora da transação + limpeza de `ProviderVault` e retorno ao Onboarding).
4. **Pilar 4 — Privacidade, Criptografia em Repouso (`AES-256-GCM`) & Hardening:**
   - Criptografia em repouso configurável (`AES-256-GCM` com AAD `table.column` e prefixo `enc:v1:`) nos mappers SQLite do `CortexDatabase` e no `voice.md`, integrada ao `SecretProtector` / `safeStorage`, mais todas as defesas IPC/HTTP/MCP/Zero Telemetria.
5. **Pilar 5 — Suíte E2E Playwright Completa (6 Fluxos Reais):**
   - `playwright.config.ts` (`workers: 1`, diretório temporário isolado, servidor HTTP local determinístico de LLM/Omni/STT/TTS em porta efêmera) exercitando os 6 fluxos obrigatórios de ponta a ponta sem mocks no browser.
6. **Pilar 6 — Documentação de Release 1.0 & ADRs:**
   - `README.md`, `docs/USER_GUIDE.md`, `docs/PROVIDER_GUIDE.md` e `docs/adr/0001` a `0007`.
