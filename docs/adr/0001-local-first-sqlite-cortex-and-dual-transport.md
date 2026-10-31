# ADR-0001: Córtex Local-First em SQLite (`node:sqlite`), Criptografia `AES-256-GCM` Opcional e Transporte Dual (Electron IPC + HTTP/SSE)

- **Status:** Accepted
- **Date:** 2026-10-31
- **Milestone:** M1 — Runtime Real & M5 — Release 1.0

---

## Context

Uma companheira virtual que constrói e preserva uma história compartilhada não pode depender de um banco de dados proprietário em nuvem nem armazenar memórias apenas na memória volátil do navegador (`localStorage` ou Zustand efêmero). Além disso, durante o ciclo de desenvolvimento, testes automatizados (Vitest + Playwright E2E) e uso em desktop (Electron Windows/macOS/Linux), o aplicativo precisa operar com a mesma semântica transacional tanto dentro do shell Electron quanto em um navegador web conectado ao processo Host.

Por fim, como o banco de dados local contém episódios pessoais, hábitos e marcos autobiográficos do usuário, é necessário oferecer criptografia autenticada em repouso sem exigir dependências binárias externas frágeis (como `better-sqlite3` com SQLCipher compilado via `node-gyp`).

## Decision

1. **Persistência Local-First sobre `node:sqlite` (`ashy.db`):**
   - Adotamos o módulo nativo `node:sqlite` (`DatabaseSync`) do Node.js 22+ para gerenciar o arquivo `ashy.db` dentro do diretório de dados do usuário (`app.getPath('userData')` ou `ASHY_USER_DATA_DIR`), eliminando problemas de compilação nativa multiplataforma.
   - O schema relacional completo, índices `FTS5` BM25 e migrações idempotentes são inicializados no boot do `AshyCortex`.

2. **Criptografia em Repouso Opcional (`AES-256-GCM`) + Cofre Nativo (`safeStorage`):**
   - Implementamos um motor de criptografia em repouso (`encryption-at-rest.ts`) utilizando `node:crypto` com `AES-256-GCM` (IV aleatório de 96 bits, Auth Tag de 128 bits e cabeçalho binário versionado `ASHYENC1`).
   - Quando ativada pelo usuário, o Host sincroniza e persiste o snapshot autenticado `ashy.db.enc` com escrita atômica (`tmp` + `rename`), protegendo a chave mestra de 256 bits (e todas as chaves de API do `ProviderVault`) via `safeStorage` do Electron (DPAPI no Windows, Keychain no macOS, Secret Service no Linux).

3. **Arquitetura de Host Unificado (`AshyHostKernel`) com Transporte Dual:**
   - Centralizamos toda a orquestração de estado no `AshyHostKernel` (injetado via `@ashy/bus` `createContainer` e `createEventBus` com orçamento de saltos `hopsRemaining = 32` e deduplicação LRU).
   - O renderer React (`useAshyStore.ts`) comunica-se com o Host por meio de um cliente unificado (`host-bridge-client.ts`) que seleciona automaticamente:
     - **Transporte Electron IPC (`contextBridge`):** quando executado dentro do Electron (`window.ashyDesktop`), com isolamento estrito (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`) e validação de origem (`senderFrame`);
     - **Transporte HTTP RPC + Server-Sent Events (SSE):** quando executado no modo web/dev ou na suíte E2E Playwright (`http-bridge.ts`).

## Consequences

### Positivas
- **Zero rebuild nativo:** `node:sqlite` e `node:crypto` vêm embutidos no runtime Node/Electron, simplificando o empacotamento (`electron-builder`) em Windows, macOS e Linux.
- **Paridade total entre Desktop e E2E:** Os mesmos fluxos de conversação, streaming de tokens/áudio, Gatekeeper MCP e portabilidade `.ashy-soul` rodam sem mocks de navegador tanto no Electron quanto no Playwright.
- **Soberania e segurança dos dados:** Dados permanecem 100% na máquina do usuário, com proteção `AES-256-GCM` contra leitura em disco e `Factory Reset` atômico em 1 clique.

### Negativas / Trade-offs
- Exige Node.js `>= 22.6.0` (ou Electron com Node 22+) para disponibilidade de `node:sqlite`.
- A sincronização do snapshot `ashy.db.enc` realiza serialização incremental após mutações quando a criptografia em repouso está ativa, o que adiciona alguns milissegundos de I/O em disco em trocas pesadas.

## Codebase References
- `packages/cortex/src/db.ts`
- `packages/cortex/src/cortex.ts`
- `packages/cortex/src/encryption-at-rest.ts`
- `packages/bus/src/container.ts`
- `packages/bus/src/event-bus.ts`
- `apps/desktop/src/main/kernel.ts`
- `apps/desktop/src/main/provider-vault.ts`
- `apps/desktop/src/main/http-bridge.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/services/host-bridge-client.ts`
