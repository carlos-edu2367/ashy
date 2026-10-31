# Phase 9 — Public Prototype (Milestone M5 — Release 1.0) Implementation Plan (Red-Team Hardened)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the complete, production-hardened Phase 9 (Release 1.0) of Ashy with 100% end-to-end functionality across First-Boot Onboarding (`Zero-to-First-Conversation`), Native Electron Packaging & Lifecycle (`System Tray`, Global Shortcuts, Safe `autoUpdater`), Soul Portability (`.ashy-soul` Export / Import / 1-Click Factory Reset), Encryption at Rest (`AES-256-GCM`) & Security Hardening (IPC/HTTP/MCP/Zero Telemetry), a 6-flow Real Playwright E2E Suite, and Release 1.0 Documentation & ADRs.

**Architecture:** We extend `@ashy/shared` with unified Valibot contracts, deterministic `canonicalizeJson`, and anti-prototype-pollution helpers for Onboarding, Soul Portability (`ASHY_SOUL_V1`), Encryption at Rest (`enc:v1:` with AAD), Global Shortcuts (`Push-to-Talk`, `Privacy Shield`), and AutoUpdater. We harden `@ashy/cortex`, `@ashy/agency`, and `apps/desktop` (`host/`, `main/`, `preload/`, `store/`, `components/`) with boot-aware SQLite row encryption (`cortex_encryption_state`), `mutationEpoch` concurrency guards, transactional SQLite operations (`VACUUM` outside transactions, foreign-key-safe ordering), strict symlink/denylist/shell-free MCP guards, anti-CSRF loopback transport (`X-Ashy-Request: 1` on `POST`), Electron packaging configs, and a real Playwright E2E harness backed by `AshyHostKernel` + `ashy.db` + an ephemeral-port deterministic local HTTP AI test server.

**Tech Stack:** TypeScript 5.8, React 19, Zustand, Electron, `node:sqlite` (WAL + FTS5), `node:crypto` (`AES-256-GCM`, `SHA-256`, `timingSafeEqual`), Valibot, Vitest, Playwright (`@playwright/test`).

**Spec:** `docs/superpowers/specs/2026-10-31-phase-9-public-prototype-release-1-0-design.md`

## Global Constraints

- **Zero Browser Mocks in Production & E2E:** All UI actions must route through `AshyHostBridge` (Electron IPC or Loopback HTTP/SSE) into `AshyHostKernel` and persistent `ashy.db`.
- **Zero Secret Leakage in Soul Exports:** `.ashy-soul` archives (`ASHY_SOUL_V1`) must never include `providers.secrets.json`, `.master.key`, `voice-settings.json` encrypted keys, or unredacted `externalMcpServers[].env` values.
- **Zero Telemetry Without Consent:** No automatic external network requests on boot (remove remote Google Fonts from `apps/desktop/index.html`, enforce local CSP, set `autoUpdater.autoDownload = false`).
- **Strict Backward Compatibility with Existing Tests:** Keep all existing `data-testid` attributes and RPC contracts intact while adding all `apps/**/src/test/**/*.test.{ts,tsx}` files into `vitest.config.ts`.

---

## Red Team Patches Applied to This Plan

1. **[REDTEAM-1] Boot-Time Encryption Codec & `cortex_encryption_state` Table:** `CortexDatabaseOptions` accepts `encryptionCodec?: CortexEncryptionCodec` at construction time, persists `cortex_encryption_state` in SQLite, and loads `this.encryptionAtRestEnabled` in the constructor *before* `AshyCortex` runs `pruneCorruptedAndTrivialEpisodes()`.
2. **[REDTEAM-2] DEK Wrapping in `SecretProtector` Without Plaintext `.master.key`:** When `safeStorage.isEncryptionAvailable()` is `true`, wrap the 32-byte DEK into `.master.key.dpapi` and delete any legacy `.master.key`; run all `AES-256-GCM` + AAD (`table.column`) encryption in-process using the 32-byte DEK.
3. **[REDTEAM-3] `X-Ashy-Request: 1` Only on `POST /__ashy_host/rpc` & `host-transport.test.ts` Sync:** Do not require custom headers on `GET /__ashy_host/events` (browser `EventSource` limitation), add `'X-Ashy-Request': '1'` in `ashy-host-client.ts` and in the 4 raw `fetch` calls of `host-transport.test.ts` (lines 465, 472, 496, 912), and add a dedicated `403` test for missing `X-Ashy-Request: 1`.
4. **[REDTEAM-4 & 5] Deterministic `canonicalizeJson` & Anti-Prototype-Pollution Reviver:** Sort object keys lexicographically at every depth when computing/verifying `checksumSha256`, and reject `__proto__`, `constructor`, and `prototype` keys during JSON parse and canonicalization.
5. **[REDTEAM-6] `mutationEpoch` Concurrency Guard Against Ghost Writes:** Increment `mutationEpoch` in `AshyCortex` and `AshyHostKernel` on `wipeAllData()`, `importSoul()`, and `setEncryptionAtRest()`. In-flight `sendTurn`, `consolidateSessionMemories`, and `runDreamReflectionCycle` check `epochAtStart === currentEpoch` before committing writes and abort if stale.
6. **[REDTEAM-7] Direct SQLite Row-Mapper Decryption & FTS5 Bypass When Encrypted:** Since `CortexDatabase` reads directly from `this.sqlite` when `this.sqlite !== null`, decrypt sensitive columns in every SQLite read mapper (`mapRowToEpisodicMemory`, `listSemanticFacts`, `listRelationalMotifs`, `listMilestones`, `listUserHabits`, `listProspectiveIntents`, `mapRowToChatSession`, `mapRowToChatMessage`, `mapRowToActionAuditLog`, `listDreamJournalEntries`), skip `episodic_fts` writes/queries when encrypted, and rely on `rankEpisodicMemories` over decrypted rows.
7. **[REDTEAM-8] Foreign Key Ordering in `wipeAll()` and `importSoulSnapshot()`:** Delete child tables (`episodic_fts`, `chat_messages`, `personality_evolution_log`, `dream_journal_entries`) before parent tables (`chat_sessions`, `episodic_memories`), and ensure all referenced `chat_sessions` exist before inserting `chat_messages`. Run `PRAGMA wal_checkpoint(TRUNCATE)` and `VACUUM` *after* `COMMIT`.
8. **[REDTEAM-9A/9B/9C] Zero Regressions in `phase-8-5`, `host-transport`, and `host-kernel` Tests:**
   - Keep `normalizedUserDataDir` in `allowedPaths` and enforce `isSensitiveHostPath(targetPath)` denylist across all tools + `ActionGatekeeper`; allow safe `node -e` via `execFile(process.execPath, ['-e', expr], { shell: false })` while blocking shell metacharacters (`[;&|><$\`\r\n]`) and sensitive files.
   - Update `host-transport.test.ts:709` to expect `6` global shortcuts.
   - Default `seedFirstGreeting` to `false` in `CompleteOnboardingInputSchema` and pass `seedFirstGreeting: true` from `FirstMeetingWizard.tsx` with `consolidatedEpisodeId: 'milestone-first-meeting'`.
9. **[REDTEAM-10] Playwright E2E Isolation & Ephemeral Port:** Use `workers: 1`, `fullyParallel: false`, isolated `ASHY_USER_DATA_DIR`, ephemeral port for `local-ai-test-server.ts`, and `test.describe.serial`.

---

### Task 1: Shared Protocol Contracts, `canonicalizeJson` (`@ashy/shared`) & Test Suite Unification (`vitest.config.ts`)

**Files:**
- Modify: `vitest.config.ts:1-16`
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/src/__tests__/phase9-protocol.test.ts`

**Interfaces:**
- Produces in `@ashy/shared`:
  - `canonicalizeJson(value: unknown): string` & `safeJsonParseWithoutProto<T = unknown>(raw: string): T`
  - Expanded `CompleteOnboardingInputSchema` (`architectureMode?: 'local-omni' | 'cloud-hybrid'`, `voiceSettings?: SaveVoiceRuntimeSettingsInput`, `agencyConsent?: UpdateAgencyConsentInput`, `initiativePolicy?: UpdateInitiativePolicyInput`, `stagePreferences?: UpdateStagePreferencesInput`, `seedFirstGreeting?: boolean` defaulting to `false`)
  - `AshySoulArchiveSchema`, `AshySoulBundlePayloadSchema`, `ExportSoulInputSchema`, `ImportSoulInputSchema`, `SetEncryptionAtRestInputSchema`, `EncryptionAtRestStatusSchema`
  - Expanded `StageShortcutBindingsSchema` & `DEFAULT_STAGE_SHORTCUTS` (`electronGlobalPtt: 'CommandOrControl+Shift+Space'`, `electronGlobalPrivacyShield: 'CommandOrControl+Shift+K'`)
  - Expanded `AshyHostStreamEventSchema` (`shortcut:triggered` actions `'togglePtt' | 'activatePrivacyShield'`, plus `updater:status` event)
  - `AutoUpdaterStateSchema` (`status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'`, `currentVersion`, `availableVersion`, `progressPercent`, `errorMessage`, `checkedAt`)
  - Expanded `AshyHostRpcMethod` union and `AshyHostBridge` interface (`exportSoul`, `importSoul`, `wipeAllData`, `setEncryptionAtRest`, `getEncryptionAtRestStatus`, `getUpdateState`, `checkForUpdates`, `downloadUpdate`, `quitAndInstallUpdate`)

- [ ] **Step 1: Write the failing test in `packages/shared/src/__tests__/phase9-protocol.test.ts`**
  Verify Valibot validation of expanded `CompleteOnboardingInputSchema`, `AshySoulArchiveSchema` (`magic: 'ASHY_SOUL_V1'`, 64-char hex `checksumSha256`), `canonicalizeJson` determinism regardless of object key order, `safeJsonParseWithoutProto` rejecting `__proto__`/`constructor`/`prototype`, `SetEncryptionAtRestInputSchema`, `DEFAULT_STAGE_SHORTCUTS` (`electronGlobalPtt`, `electronGlobalPrivacyShield`), and `AutoUpdaterStateSchema`.
- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run packages/shared/src/__tests__/phase9-protocol.test.ts`
- [ ] **Step 3: Implement `@ashy/shared` schemas/helpers and update `vitest.config.ts`**
  Add `apps/**/src/test/**/*.test.{ts,tsx}` to `vitest.config.ts` (excluding `**/e2e/**`) and implement all Phase 9 schemas, types, `canonicalizeJson`, and `safeJsonParseWithoutProto` in `packages/shared/src/host-protocol.ts`.
- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm vitest run packages/shared/src/__tests__/phase9-protocol.test.ts`

---

### Task 2: Boot-Aware Encryption at Rest (`AES-256-GCM` + AAD), `mutationEpoch`, Soul Portability (`export` / `import` / `wipeAll`) in `@ashy/cortex` and `SecretProtector`

**Files:**
- Modify: `apps/desktop/src/host/secret-protector.ts`
- Modify: `apps/desktop/src/host/atomic-file.ts`
- Modify: `packages/cortex/src/db/cortex-db.ts`
- Modify: `packages/cortex/src/ashy-cortex.ts`
- Create: `packages/cortex/src/__tests__/phase9-soul-portability-and-encryption.test.ts`

**Interfaces:**
- Consumes: `canonicalizeJson`, `safeJsonParseWithoutProto` from `@ashy/shared`.
- Produces:
  - `SecretProtector.encryptEnvelope(plainText: string, aad?: string): string` (`enc:v1:<base64>`)
  - `SecretProtector.decryptEnvelope(payload: string, aad?: string): string`
  - `SecretProtector.getBackendKind(): 'electron-safe-storage' | 'node-aes-master-key'`
  - `removeFileAtomicWithBackups(filePath: string, maxBackups?: number): void` in `atomic-file.ts`
  - `CortexEncryptionCodec`: `{ encrypt(plainText: string, aad: string): string; decrypt(cipherText: string, aad: string): string }`
  - `CortexDatabaseOptions.encryptionCodec?: CortexEncryptionCodec`
  - `CortexDatabase.setEncryptionAtRest(enabled: boolean, codec?: CortexEncryptionCodec): void`
  - `CortexDatabase.isEncryptionAtRestEnabled(): boolean`
  - `CortexDatabase.exportSoulSnapshot(): CortexSoulSnapshot`
  - `CortexDatabase.importSoulSnapshot(snapshot: CortexSoulSnapshot): void`
  - `CortexDatabase.wipeAll(): void`
  - `AshyCortex.getMutationEpoch(): number`, `AshyCortex.incrementMutationEpoch(): number`, `AshyCortex.exportSoulSnapshot()`, `AshyCortex.importSoulSnapshot(snapshot)`, `AshyCortex.wipeAll()`, `AshyCortex.setEncryptionAtRest(enabled, codec)`, `AshyCortex.isEncryptionAtRestEnabled()`

- [ ] **Step 1: Write failing tests in `packages/cortex/src/__tests__/phase9-soul-portability-and-encryption.test.ts`**
  Test:
  1. `exportSoulSnapshot` -> `wipeAll` -> `importSoulSnapshot` round-trip preserving FSRS-6 memories (`stability`, `difficulty`, `isFlashbulb`), semantic facts, inside-joke motifs, milestones, traits/mood, chat sessions/messages, and FTS5 searchability.
  2. Adversarial corruption/tampering & FK tests: rejecting NaN/Infinity FSRS weights, auto-healing or validating orphan `chat_messages.sessionId`, rolling back transaction on mid-import failure while keeping pre-import data intact, and ensuring `wipeAll` truncates WAL (`PRAGMA wal_checkpoint(TRUNCATE)`) and leaves zero user episodes/facts/milestones.
  3. Boot-time & runtime `setEncryptionAtRest(true, codec)`: verifying raw SQLite table columns on disk start with `enc:v1:` (no plaintext in `ashy.db` or `episodic_fts`), closing and reopening `new AshyCortex({ filePath, encryptionCodec })` to verify constructor `pruneCorruptedAndTrivialEpisodes()` and `searchEpisodicMemoriesHybrid` work seamlessly across restarts, and toggling `setEncryptionAtRest(false, codec)` restores plaintext on disk and rebuilds `episodic_fts`.
  4. `createElectronSafeStorageProtector` with `safeStorage.isEncryptionAvailable() === true` stores `.master.key.dpapi` and never leaves a plaintext `.master.key` on disk.
  5. `mutationEpoch` guard: starting an async `consolidateSessionMemories` or `runDreamReflectionCycle` and calling `wipeAll()` before the LLM resolves discards the stale consolidation write so zero ghost episodes appear in `ashy.db`.
- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run packages/cortex/src/__tests__/phase9-soul-portability-and-encryption.test.ts`
- [ ] **Step 3: Implement `SecretProtector` DEK wrapping, `removeFileAtomicWithBackups`, and `CortexDatabase` / `AshyCortex` export/import/wipe/encryption/epoch**
- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm vitest run packages/cortex/src/__tests__/phase9-soul-portability-and-encryption.test.ts`

---

### Task 3: Security Hardening of `@ashy/agency`, `agency-runtime.ts`, `vite-host-plugin.ts` & Zero Telemetry

**Files:**
- Modify: `packages/agency/src/action-gatekeeper.ts`
- Modify: `packages/agency/src/mcp-client.ts`
- Modify: `apps/desktop/src/host/agency-runtime.ts`
- Modify: `apps/desktop/src/host/vite-host-plugin.ts`
- Modify: `apps/desktop/src/services/ashy-host-client.ts`
- Modify: `apps/desktop/src/__tests__/host-transport.test.ts`
- Modify: `apps/desktop/vite.config.ts`
- Modify: `apps/desktop/index.html`
- Create: `apps/desktop/src/__tests__/phase9-security-hardening.test.ts`

**Interfaces:**
- Produces:
  - `isSensitiveHostPath(filePath: string): boolean` in `@ashy/agency` and `agency-runtime.ts` blocking `.master.key*`, `*.secrets.json`, `voice-settings.json*`, `providers.json*`, `stage-preferences.json*`, `ashy.db*`, `.env*`, `.git/config`, `*id_rsa*`, `*.pem`.
  - Realpath & symlink guard in `resolveWorkspacePath` (`agency-runtime.ts`) checking `fs.lstatSync` and `fs.realpathSync` on the resolved physical filesystem path.
  - Shell-free `run_cleanup_command` hardening in `agency-runtime.ts` + exact argument hash binding for `run_cleanup_command` session approvals in `ActionGatekeeper`.
  - SSRF validation in `createHttpMcpClient` and `process.env` sanitization allowlist in `createStdioMcpClient` (`packages/agency/src/mcp-client.ts`).
  - Anti-CSRF `X-Ashy-Request: 1` enforcement on `POST /__ashy_host/rpc` (with `Origin` port validation and `req.destroy()` on oversized bodies) in `vite-host-plugin.ts` and `ashy-host-client.ts`.
  - Zero external font requests and strict local Content-Security-Policy in `apps/desktop/index.html`, plus `host: '127.0.0.1'` in `apps/desktop/vite.config.ts`.

- [ ] **Step 1: Write failing adversarial security tests in `apps/desktop/src/__tests__/phase9-security-hardening.test.ts`**
  Test:
  1. `read_workspace_file`, `write_project_note`, and `run_cleanup_command` reject any access to `.master.key`, `providers.secrets.json`, `voice-settings.json`, `ashy.db`, and `.env`.
  2. `read_workspace_file` and `write_project_note` reject symlinks/junctions inside `workspace/` that point outside `allowedPaths`.
  3. `run_cleanup_command` rejects shell chaining/injection (`rm tmp.txt; whoami`, `rm $(calc)`, `powershell -Command ...`) and does not auto-approve a different command when a prior command was approved for the session.
  4. `createHttpMcpClient` blocks `http://169.254.169.254/latest/meta-data` and `http://0.0.0.0:8080`; `createStdioMcpClient` strips `OPENAI_API_KEY` from inherited `process.env`.
  5. `POST /__ashy_host/rpc` without `X-Ashy-Request: 1` or from cross-port `Origin: http://localhost:3000` returns `403`.
  6. `apps/desktop/index.html` has zero references to `fonts.googleapis.com` / `fonts.gstatic.com` and includes a `Content-Security-Policy` meta tag.
- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run apps/desktop/src/__tests__/phase9-security-hardening.test.ts`
- [ ] **Step 3: Implement all security hardening fixes and update the 4 raw `fetch` headers in `host-transport.test.ts`**
- [ ] **Step 4: Run security tests + `phase-8-5-native-tools-vision-mcp.test.ts` + `host-transport.test.ts` to verify 100% pass**
  Run: `pnpm vitest run apps/desktop/src/__tests__/phase9-security-hardening.test.ts apps/desktop/src/test/phase-8-5-native-tools-vision-mcp.test.ts apps/desktop/src/__tests__/host-transport.test.ts`

---

### Task 4: Host Kernel (`kernel.ts`) & ProviderVault Expansion for Onboarding, Soul Portability (`.ashy-soul`), 1-Click Wipe & Encryption at Rest

**Files:**
- Modify: `apps/desktop/src/host/provider-vault.ts`
- Modify: `apps/desktop/src/host/voice-identity-store.ts`
- Modify: `apps/desktop/src/host/turn-orchestrator.ts`
- Modify: `apps/desktop/src/host/kernel.ts`
- Modify: `apps/desktop/src/host/vite-host-plugin.ts`
- Modify: `apps/desktop/src/services/ashy-host-client.ts`
- Create: `apps/desktop/src/__tests__/phase9-kernel-soul-and-onboarding.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 2 & Task 3 interfaces.
- Produces on `ProviderVault`:
  - `resetAll(): ProviderVaultPublicState` (deletes `providers.json`, `providers.secrets.json` and `.bak1..3`, clears decrypted key cache, restores default unconfigured provider list)
- Produces on `AshyHostKernel`:
  - Passes `encryptionCodec` into `createAshyCortex` on boot so encrypted `ashy.db` databases hydrate seamlessly on restart.
  - Maintains `kernelEpoch` checked by `TurnOrchestrator` before committing post-stream messages/consolidations.
  - Expanded `completeOnboarding(rawInput)` (persists `userName`, `userPronouns`, `providerConfig`, `voiceSettings`, `agencyConsent`, `initiativePolicy`, `stagePreferences`, creates `milestone-first-meeting`, and when `input.seedFirstGreeting === true` seeds Ashy's personalized welcome message in `session-initial` with `consolidatedEpisodeId: 'milestone-first-meeting'`)
  - `exportSoul(rawInput?: ExportSoulInput): AshySoulArchive` (builds `ASHY_SOUL_V1` with `canonicalizeJson` SHA-256 checksum, redacts `externalMcpServers[].env`, excludes all API keys/secrets)
  - `importSoul(rawInput: ImportSoulInput): HostBootstrapSnapshot` (increments `kernelEpoch`, parses with `safeJsonParseWithoutProto`, verifies `ASHY_SOUL_V1` and timing-safe SHA-256 checksum over `canonicalizeJson(payload)`, validates with `AshySoulArchiveSchema`, runs transactional `cortex.importSoulSnapshot`, restores `voice.md`, `stage-preferences.json`, and non-secret `voice-settings.json`, returns fresh `HostBootstrapSnapshot`)
  - `wipeAllData(): Promise<HostBootstrapSnapshot>` (increments `kernelEpoch`, aborts in-flight turns, resets `cortex`, `providerVault`, `voiceIdentityStore`, `voice-settings.json`, `stage-preferences.json`, `agencyRuntime`, and returns clean `HostBootstrapSnapshot` with `needsOnboarding: true`)
  - `setEncryptionAtRest(rawInput: SetEncryptionAtRestInput): HostBootstrapSnapshot` & `getEncryptionAtRestStatus(): EncryptionAtRestStatus`
  - `activatePrivacyShield(): HostBootstrapSnapshot`

- [ ] **Step 1: Write failing tests in `apps/desktop/src/__tests__/phase9-kernel-soul-and-onboarding.test.ts`**
  Test:
  1. Full `completeOnboarding` with `seedFirstGreeting: true`, Local Omni (`LFM3-Omni-2B`), privacy consent (`eyesMode: 'window'`, `micMode: 'ptt'`, `approvalPolicy: 'ask'`), quiet hours (`22:00 - 08:00`), verifying Ashy's first greeting message is created in `session-initial` with `consolidatedEpisodeId: 'milestone-first-meeting'` alongside `milestone-first-meeting`.
  2. `exportSoul()` produces valid `ASHY_SOUL_V1` with 64-char SHA-256 and zero leaked API keys or MCP env tokens even when `ProviderVault`, `voice-settings.json`, and `externalMcpServers` contain secrets.
  3. `wipeAllData()` atomically destroys all memories, chat sessions, milestones, provider keys, and backups, returning `needsOnboarding: true`.
  4. `importSoul(archive)` after `wipeAllData()` restores all memories, milestones, traits, `voice.md`, and sets `needsOnboarding: false`, even if object key order in `archive.payload` is shuffled before import.
  5. Tampering with a single byte in `archive.payload` or injecting `__proto__` causes `importSoul` to throw `SOUL_CHECKSUM_MISMATCH` / `Forbidden key` without modifying `ashy.db`.
  6. `setEncryptionAtRest({ enabled: true })` encrypts `ashy.db` and `voice.md` on disk (`enc:v1:`), and rebooting a fresh `createAshyHostKernel({ userDataDir })` preserves `encryptionAtRest.enabled === true` and reads decrypted memories.
- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run apps/desktop/src/__tests__/phase9-kernel-soul-and-onboarding.test.ts`
- [ ] **Step 3: Implement `ProviderVault.resetAll`, `VoiceIdentityStore` encryption support, `TurnOrchestrator` epoch guard, and `AshyHostKernel` methods**
- [ ] **Step 4: Run test to verify it passes (along with `host-kernel.test.ts`)**
  Run: `pnpm vitest run apps/desktop/src/__tests__/phase9-kernel-soul-and-onboarding.test.ts apps/desktop/src/__tests__/host-kernel.test.ts`

---

### Task 5: Native Electron Lifecycle (`System Tray`, Global Shortcuts `PTT` & `Privacy Shield`, Safe `autoUpdater`, Build & `electron-builder` Config)

**Files:**
- Create: `apps/desktop/src/main/tray-manager.ts`
- Create: `apps/desktop/src/main/auto-updater.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/electron/main.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/__tests__/host-transport.test.ts`
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/build/entitlements.mac.plist`
- Create: `apps/desktop/scripts/build-electron.mjs`
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/src/__tests__/phase9-electron-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 1 & Task 4 interfaces.
- Produces:
  - `createAshySystemTray(deps)` in `apps/desktop/src/main/tray-manager.ts` (context menu: Show/Hide Hub, Toggle Overlay, Cycle Mic Mode, Activate Privacy Shield Kill Switch, Check for Updates, Quit)
  - `createSafeAutoUpdater(deps)` in `apps/desktop/src/main/auto-updater.ts` (`autoDownload = false`, `autoInstallOnAppQuit = false`, state machine, `checkForUpdates`, `downloadUpdate`, `quitAndInstallUpdate`, emits `updater:status`)
  - Updated `bootAshyElectronMain` in `apps/desktop/src/main/index.ts`:
    - Registers all 6 global shortcuts (`Mic`, `Eyes`, `DND`, `HideStage`, `PTT` `CommandOrControl+Shift+Space`, `PrivacyShield` `CommandOrControl+Shift+K`)
    - Enforces `sandbox: true`, `webSecurity: true`, `will-navigate` deny guard, `setWindowOpenHandler` deny guard, and `validateIpcSender(event)` on all IPC handlers
    - Calls `overlayWindow.setAlwaysOnTop?.(true, 'screen-saver')`
    - Supports packaged `loadFile` vs dev `loadURL` and `singleInstanceLock`
  - `apps/desktop/scripts/build-electron.mjs` & `apps/desktop/electron-builder.yml` compiling `dist/main/index.mjs`, `dist/preload/index.cjs`, and `dist/renderer/` plus generating deterministic icons in `apps/desktop/build/`.

- [ ] **Step 1: Write failing tests in `apps/desktop/src/__tests__/phase9-electron-lifecycle.test.ts`**
  Test:
  1. `bootAshyElectronMain` registers all 6 global shortcuts including `CommandOrControl+Shift+Space` (`togglePtt`) and `CommandOrControl+Shift+K` (`activatePrivacyShield`); triggering `CommandOrControl+Shift+K` calls `kernel.activatePrivacyShield()` (mutes Mic, turns Eyes off, turns DND on, revokes session permissions) and broadcasts `shortcut:triggered`.
  2. `createAshySystemTray` builds the context menu and executes Show/Hide Hub, Toggle Overlay, Privacy Shield Kill Switch, Check for Updates, and Quit actions.
  3. `createSafeAutoUpdater` enforces `autoDownload = false` (never downloads without explicit `downloadUpdate()` call), transitions through `checking -> available -> downloading -> downloaded`, and broadcasts `updater:status`.
  4. `hubWindow` and `overlayWindow` both enforce `sandbox: true`, `webSecurity: true`, `contextIsolation: true`, `nodeIntegration: false`, and reject untrusted `ipcMain` `senderFrame` origins.
  5. Running `node apps/desktop/scripts/build-electron.mjs` produces `apps/desktop/dist/main/index.mjs`, `apps/desktop/dist/preload/index.cjs`, and icons in `apps/desktop/build/`.
- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run apps/desktop/src/__tests__/phase9-electron-lifecycle.test.ts`
- [ ] **Step 3: Implement `tray-manager.ts`, `auto-updater.ts`, `main/index.ts`, `preload/index.ts`, `build-electron.mjs`, `electron-builder.yml`, and update `host-transport.test.ts:709` for 6 shortcuts**
- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm vitest run apps/desktop/src/__tests__/phase9-electron-lifecycle.test.ts apps/desktop/src/__tests__/host-transport.test.ts`

---

### Task 6: UI & Store Integration — Interactive Onboarding Wizard, Soul Portability Panel, 1-Click Factory Reset, Encryption at Rest Toggle & Store Bug Fixes

**Files:**
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/components/FirstMeetingWizard.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/__tests__/phase9-ui-onboarding-and-soul-portability.test.tsx`

**Interfaces:**
- Consumes: Task 1, Task 4 & Task 5 interfaces.
- Produces in `useAshyStore.ts`:
  - Fixes `[BUG-ONB1]`: `setUnifiedOmniMode`, `setDirectOmniAudio`, and `applyOmniModelPreset` persist `unifiedOmniMode` and `directOmniAudio` to the host via `bridge.saveVoiceRuntimeSettings`.
  - Fixes `[BUG-ONB2]`: `setQuietHoursRange('Desativado')` updates `initiativePolicy` (`respectDnd: false`) without failing regex or wrongly toggling immediate `dndMode`; normalizes `quietHoursRange` separator so `App.tsx` `<select>` stays in sync.
  - Adds store actions: `exportSoulArchive()`, `importSoulArchive(rawJsonOrArchive)`, `wipeAllSoulData()`, `setEncryptionAtRest(enabled)`, `checkForAppUpdates()`, `downloadAppUpdate()`, `installAppUpdate()`.
  - Handles `shortcut:triggered` for `'togglePtt'` and `'activatePrivacyShield'`, and `updater:status` stream events.
- Produces in `FirstMeetingWizard.tsx`:
  - Architecture Mode Selector: `data-testid="onboarding-mode-local-omni"` (`LFM3-Omni-2B` 1-click setup) vs `data-testid="onboarding-mode-cloud-hybrid"` (Cloud/Modular setup with STT/TTS selection).
  - Privacy Permissions & Quiet Hours selectors: `data-testid="onboarding-eyes-mode-select"`, `data-testid="onboarding-mic-mode-select"`, `data-testid="onboarding-approval-policy-select"`, `data-testid="onboarding-quiet-hours-select"`.
  - Quick Connection & Voice tests: `data-testid="onboarding-test-provider-btn"`, `data-testid="onboarding-test-mic-btn"`, `data-testid="onboarding-test-tts-btn"`.
  - Passes `seedFirstGreeting: true` when completing onboarding from the Wizard UI while preserving all existing `data-testid` attributes in the DOM.
- Produces in `App.tsx`:
  - **Soul Portability & Factory Reset Card (`data-testid="panel-soul-portability"`)** in `Configurações`:
    - `data-testid="btn-export-soul"` (exports `.ashy-soul` JSON and displays checksum badge `data-testid="soul-export-checksum-badge"` + copy/download payload `data-testid="soul-archive-json-textarea"`)
    - `data-testid="btn-import-soul"` + `data-testid="input-import-soul-file"` (validates and imports `.ashy-soul`, displaying status `data-testid="soul-import-status-badge"`)
    - `data-testid="btn-wipe-all-trigger"` -> 2-step confirmation `data-testid="btn-wipe-all-confirm"` / `data-testid="btn-wipe-all-cancel"` (executes atomic 1-Click Factory Reset and returns to `FirstMeetingWizard`)
  - **Encryption at Rest Card (`data-testid="panel-encryption-at-rest"`)** in `Configurações > Privacidade`:
    - `data-testid="toggle-encryption-at-rest"` and `data-testid="encryption-at-rest-status"`
  - **Auto-Updater Card (`data-testid="panel-auto-updater"`)** in `Configurações > Geral`:
    - `data-testid="btn-check-updates"`, `data-testid="updater-status-badge"`

- [ ] **Step 1: Write failing UI & Store tests in `apps/desktop/src/__tests__/phase9-ui-onboarding-and-soul-portability.test.tsx`**
  Test:
  1. Selecting `onboarding-mode-local-omni` in `FirstMeetingWizard` configures `lfm3-omni:2b`, allows selecting privacy permissions (`onboarding-eyes-mode-select`, `onboarding-mic-mode-select`, `onboarding-approval-policy-select`, `onboarding-quiet-hours-select`), testing mic/voice (`onboarding-test-mic-btn`, `onboarding-test-tts-btn`), and completing onboarding into the first conversation with Ashy's greeting message.
  2. Clicking `btn-export-soul`, then `btn-wipe-all-trigger` -> `btn-wipe-all-confirm` wipes all data and re-opens `first-meeting-wizard`; importing the exported `.ashy-soul` via `soul-archive-json-textarea` + `btn-import-soul` restores memories and closes the wizard.
  3. Toggling `toggle-encryption-at-rest` enables `AES-256-GCM` on the host and updates `encryption-at-rest-status`.
  4. Selecting `"Desativado"` in `select-quiet-hours` updates `quietHoursRange` to `'Desativado'` without turning `dndMode` ON.
- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run apps/desktop/src/__tests__/phase9-ui-onboarding-and-soul-portability.test.tsx`
- [ ] **Step 3: Implement `useAshyStore.ts`, `FirstMeetingWizard.tsx`, and `App.tsx` updates**
- [ ] **Step 4: Run test to verify it passes (along with `phase0-1-ui.test.tsx`)**
  Run: `pnpm vitest run apps/desktop/src/__tests__/phase9-ui-onboarding-and-soul-portability.test.tsx apps/desktop/src/__tests__/phase0-1-ui.test.tsx`

---

### Task 7: Complete Real Playwright E2E Suite (6 Mandatory Flows + Phases 8.1–8.7 End-to-End)

**Files:**
- Create: `playwright.config.ts`
- Create: `apps/desktop/e2e/helpers/local-ai-test-server.ts`
- Create: `apps/desktop/e2e/ashy-release-1-0.e2e.spec.ts`
- Modify: `package.json` (add `"test:e2e": "playwright test"`)

**Interfaces:**
- Consumes: All Phase 1–9 components running in a real browser (`workers: 1`, `fullyParallel: false`, isolated `ASHY_USER_DATA_DIR`, ephemeral port for `local-ai-test-server.ts`) against Vite + `AshyHostKernel` + `ashy.db`.
- Verifies all 6 E2E flows end-to-end inside `test.describe.serial` with zero browser mocks:
  1. **Flow E2E 1 — Onboarding & Provider/Model Setup (`Zero-to-First-Conversation`):** Clean state -> `FirstMeetingWizard` -> Local `LFM3-Omni-2B` / Cloud provider setup + Privacy permissions + Connection & Voice test -> `"Despertar Ashy"` -> `first_meeting` milestone + Ashy's initial greeting -> first real streaming conversation turn.
  2. **Flow E2E 2 — Conversation, Soul (`voice.md`), `<|ACT|>` & `SeriousnessGate`:** Casual turn with `<|ACT|>` emotion/motion applied to the Stage without raw tag leakage -> Urgent/grief turn triggering `SeriousnessGate` (`seriousness-gate-badge` = `"Por aqui, acolhendo você com calma."`, playfulness suppressed).
  3. **Flow E2E 3 — FSRS-6 Selective Memory, Inside Jokes (`CooldownLock`), Dream/Revert & Soul Portability (`.ashy-soul` Export -> 1-Click Wipe -> Re-Import):** Memory creation/consolidation/deletion in UI -> Inside-joke invocation and `CooldownLock` verification -> Dream & Reflection + 1-click Trait Revert -> Export `.ashy-soul` -> 1-Click Factory Reset (`btn-wipe-all-trigger` -> `btn-wipe-all-confirm`) returning to Onboarding -> Re-import `.ashy-soul` restoring memories and milestones.
  4. **Flow E2E 4 — Real-Time Voice, Unified Omni Mode (`LFM3-Omni-2B`) & Barge-In Receipt:** Activate `LFM3-Omni-2B` preset (`preset-omni-lfm3-local`) -> Voice/Omni turn with `turn:input-transcript` + `turn:audio-delta` (24kHz PCM16) driving formant lip-sync -> Barge-In interruption generating exact `PlaybackReceipt` (`heardText` / `unheardText`).
  5. **Flow E2E 5 — Universal Live2D Stage (`.model3.json`) / Tachie, Retinal Light Squint & Floating Stage Overlay:** Switch between Tachie and Live2D presets (`hiyori`, `haru`, `mao`), verify `<|ACT|>` expression sync and `slider-ambient-luminance` Light Squint, open Floating Stage Overlay (`/?view=stage-overlay`), verify $O(1)$ click-through badge and quick controls.
  6. **Flow E2E 6 — Agency, Tools/MCP, Real Vision (`dHash`), Gatekeeper, Encryption at Rest & Privacy Shield (`Kill Switch`):** Trigger `staged-confirm` MCP tool (`write_project_note` / `run_cleanup_command`) -> inspect diff in `ActionGatekeeper` -> Approve 1x and Deny -> verify entries in `consent-audit-ledger` -> test Vision `dHash` deduplication -> enable Encryption at Rest (`AES-256-GCM`) -> activate `Privacy Shield (Kill Switch)` and verify immediate cut-off of Mic, Eyes, and actions.

- [ ] **Step 1: Create `apps/desktop/e2e/helpers/local-ai-test-server.ts` and `playwright.config.ts`**
- [ ] **Step 2: Write the 6-flow E2E suite in `apps/desktop/e2e/ashy-release-1-0.e2e.spec.ts`**
- [ ] **Step 3: Run `pnpm test:e2e` and verify all 6 E2E flows pass against the real runtime**

---

### Task 8: Release 1.0 Documentation (`README.md`, `USER_GUIDE.md`, `PROVIDER_GUIDE.md`) & Architecture Decision Records (`docs/adr/0001..0007`)

**Files:**
- Create: `README.md`
- Create: `docs/USER_GUIDE.md`
- Create: `docs/PROVIDER_GUIDE.md`
- Create: `docs/adr/0001-local-first-sqlite-cortex-and-dual-transport.md`
- Create: `docs/adr/0002-six-memory-architecture-fsrs6-and-inside-joke-cooldown.md`
- Create: `docs/adr/0003-soul-portability-kv-cache-prompt-and-m2-eval-gate.md`
- Create: `docs/adr/0004-four-tier-affect-engine-and-seriousness-gate.md`
- Create: `docs/adr/0005-realtime-voice-cas-turn-taking-and-unified-omni-lfm3.md`
- Create: `docs/adr/0006-dual-mode-2d-stage-and-o1-cpu-click-through.md`
- Create: `docs/adr/0007-progressive-mcp-agency-3-tier-gatekeeper-and-security-hardening.md`
- Modify: `docs/ASHY_ROADMAP.md` (mark Phase 9 — Milestone M5 Release 1.0 as ✅ Concluída once verified)

- [ ] **Step 1: Write `README.md`, `docs/USER_GUIDE.md`, and `docs/PROVIDER_GUIDE.md`**
- [ ] **Step 2: Write the 7 ADRs in `docs/adr/0001..0007` and update `docs/ASHY_ROADMAP.md`**
- [ ] **Step 3: Run full verification suite (`pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm test:e2e`)**
