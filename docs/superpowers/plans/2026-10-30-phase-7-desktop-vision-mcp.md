# Ashy Phase 7 — Desktop, Vision & MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Phase 7 (`docs/ASHY_ROADMAP.md` — *Fase 7: Desktop, visão e ferramentas MCP*): real MCP client (`stdio` & `http` JSON-RPC 2.0) + 4 real local Host MCP servers (`desktop-vision`, `workspace-fs`, `workspace-notes`, `workspace-shell`) wired to `ProgressiveMcpRegistry` (3 meta-tools in prompt), `ActionGatekeeper` persisted in `ashy.db` (`action_audit_log` & `agency_consent_state`) with inline Chat/Stage Overlay `PendingActionCard` + **"Modo Não Pergunte" (`auto_accept`)** that auto-accepts any permission, configurable per-tool risk tiers (`observe-only`, `read-safe`, `staged-confirm`) and folder/window scopes, authorized `EyesMode` screen observation with 64-bit `dHash` deduplication (`0` vision tokens on static screens) and pluggable `VisionProvider`, and the Consent Center with instant permission revocation.

**Architecture:** TDD-first (`RED -> GREEN -> REFACTOR`) across 6 self-contained tasks spanning `@ashy/shared`, `@ashy/agency`, `@ashy/cortex`, `apps/desktop`, and `scripts/`. Every new organ has a live producer, a live reader, and automated unit + host integration + UI + Playwright verification.

**Tech Stack:** TypeScript, Vitest, Valibot, Node SQLite (`node:sqlite`), React 19, Zustand, Electron IPC / Vite Host Bridge.

**Spec:** `docs/superpowers/specs/2026-10-30-phase-7-desktop-vision-mcp-design.md`

---

## Global Constraints & Red-Team Safeguards

1. **Browser-Safety Invariant:** Files imported by the browser renderer (`apps/desktop/src/store/useAshyStore.ts`, `apps/desktop/src/App.tsx`, `packages/shared/**`) MUST NOT import `node:fs`, `node:path`, or `node:child_process` at top level. In `@ashy/agency`, Node built-ins (`node:child_process`, `node:fs`) MUST be resolved lazily via `process.getBuiltinModule` (just like `packages/cortex/src/db/cortex-db.ts`) so `@ashy/agency` remains 100% browser-compatible when imported by the renderer.
2. **Vite Build Invariant:** `apps/desktop/src/host/vite-host-plugin.ts` MUST only use `import type` from `@ashy/shared`.
3. **Default `'ask'` Mode vs. Explicit `'auto_accept'` ("Não pergunte") Mode:**
   - Default `approvalPolicy` on boot is `'ask'`, guaranteeing that write/command tools (`staged-confirm`) never execute without explicit approval by default.
   - When the user selects **`'auto_accept'` ("Não perguntar — aceitar automaticamente qualquer permissão")**, `ActionGatekeeper` automatically accepts and executes any tool call immediately (and auto-approves any currently queued `pendingActions`), while recording `decision: 'allowed'` with `reason: 'Auto-approved by user policy (auto_accept)'` in `action_audit_log`.
4. **Symlink & Path Traversal Defense:** Both `read-safe` and `staged-confirm` tools with path arguments are validated against `canonicalizeSafePath` AND, when running on Node FS, `fs.realpathSync` so a symlink inside an allowed folder pointing to `/etc/passwd` or `C:\Windows\System32` is blocked with `blocked_traversal` (unless `approvalPolicy === 'auto_accept'` is explicitly active for permission prompts, note: traversal attacks with `..` or null bytes are always rejected by `canonicalizeSafePath`).
5. **Zero Screen Capture When `eyesMode === 'off'`:** `AuthorizedVisionSensor` checks `privacyController.canObserveScreen` *before* calling `captureFrameFn`. When `eyesMode === 'off'`, `captureFrameFn` is never invoked (`framesCapturedCount === 0`) and an audit log entry (`blocked_privacy`) is recorded.

---

## Organ Wire-Back Matrix

| Organ / Capability | Producer (Writer) | Consumer (Live Reader) | Verification Test |
| :--- | :--- | :--- | :--- |
| **1. Shared Agency, Vision & Consent Contracts (`auto_accept`)** | `packages/shared/src/host-protocol.ts` (`COMPUTER_ACTIONS_POLICIES`, `AgencySnapshot`, `VisionObservationResult`, `UpdateAgencyConsentInputSchema`) | `@ashy/agency`, `@ashy/cortex`, `apps/desktop` | `packages/shared/src/__tests__/host-protocol.test.ts` |
| **2. Upgraded Gatekeeper (`auto_accept`, Risk Overrides, Diff Preview), MCP Client & Vision Sensor** | `packages/agency/src/action-gatekeeper.ts`, `mcp-client.ts`, `vision-sensor.ts` | `apps/desktop/src/host/agency-runtime.ts` & `useAshyStore.ts` | `packages/agency/test/agency.test.ts` |
| **3. Cortex SQLite Migration `v4` (`action_audit_log` & `agency_consent_state`)** | `packages/cortex/src/db/cortex-db.ts` (`insertActionAuditLog`, `listActionAuditLog`, `getAgencyConsentState`, `saveAgencyConsentState`) | `apps/desktop/src/host/agency-runtime.ts` & `kernel.ts` | `packages/cortex/src/__tests__/phase1-persistence.test.ts` |
| **4. Host Agency Runtime, 4 Real Local MCP Servers & Vision -> Turn Wiring** | `apps/desktop/src/host/agency-runtime.ts`, `kernel.ts`, `turn-orchestrator.ts`, `vite-host-plugin.ts`, `ashy-host-client.ts` | `apps/desktop/src/store/useAshyStore.ts` | `apps/desktop/src/__tests__/host-kernel.test.ts` & `host-transport.test.ts` |
| **5. Inline PendingActionCard (Chat + Stage Bubble), "Modo Não Pergunte" & Consent Center UI** | `apps/desktop/src/store/useAshyStore.ts` | `apps/desktop/src/App.tsx` | `apps/desktop/src/__tests__/phase7-desktop-vision-mcp-ui.test.tsx` |
| **6. End-to-End Phase 7 Wire-Back & Playwright Visual Audit** | `scripts/verify-phase7-wireback.mjs` & `package.json` | CI / `pnpm verify:wireback` | `node scripts/verify-phase7-wireback.mjs` & Playwright |

---

### Task 1: Shared Agency, Vision & Consent Contracts (`@ashy/shared`)

**Files:**
- Modify: `packages/shared/src/host-protocol.ts`
- Modify: `packages/shared/src/__tests__/host-protocol.test.ts`

- [ ] **Step 1: Write failing tests in `packages/shared/src/__tests__/host-protocol.test.ts`**
  Test validation of:
  - `COMPUTER_ACTIONS_POLICIES` (`['ask', 'session', 'auto_accept', 'off']`) and `ComputerActionsPolicySchema`
  - `ACTION_RISK_TIERS` (`['observe-only', 'read-safe', 'staged-confirm']`)
  - `UpdateAgencyConsentInputSchema` (validating `eyesMode`, `micMode`, `dndMode`, `approvalPolicy`, `allowedPaths`, `allowedWindowTitles`, `toolRiskOverrides`)
  - `ExternalMcpServerConfigSchema` (`stdio` and `http` transports)

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm --filter @ashy/shared test`

- [ ] **Step 3: Implement shared contracts in `packages/shared/src/host-protocol.ts`**
  Export:
  - `COMPUTER_ACTIONS_POLICIES = ['ask', 'session', 'auto_accept', 'off'] as const`
  - `ComputerActionsPolicy`, `ComputerActionsPolicySchema`
  - `ACTION_RISK_TIERS = ['observe-only', 'read-safe', 'staged-confirm'] as const`
  - `ActionRiskTier`, `ActionRiskTierSchema`
  - `AuditDecision`, `ApprovalScope`, `PendingActionCard`, `ActionAuditLogEntry`
  - `ExternalMcpServerConfig`, `ExternalMcpServerConfigSchema`
  - `VisionObservationResult`, `VisionTelemetryState`
  - `PersistedAgencyConsentState`, `AgencyToolState`, `AgencySnapshot`
  - `UpdateAgencyConsentInput`, `UpdateAgencyConsentInputSchema`
  - Add `agency?: AgencySnapshot` to `AshyBootstrapSnapshot` and Phase 7 methods to `AshyHostBridge`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm --filter @ashy/shared test`

---

### Task 2: `@ashy/agency` — Gatekeeper (`auto_accept` + Risk Overrides + Diff/Command Previews), MCP Client (`stdio`/`http`) & `AuthorizedVisionSensor`

**Files:**
- Modify: `packages/agency/src/action-gatekeeper.ts`
- Modify: `packages/agency/src/mcp-progressive.ts`
- Create: `packages/agency/src/mcp-client.ts`
- Create: `packages/agency/src/vision-sensor.ts`
- Modify: `packages/agency/src/index.ts`
- Modify: `packages/agency/test/agency.test.ts`

- [ ] **Step 1: Write failing tests in `packages/agency/test/agency.test.ts`**
  Cover:
  1. `approvalPolicy === 'auto_accept'` ("Modo Não Pergunte"): `staged-confirm` tools (and tools with `blastRadiusWarning`) execute immediately (`status: 'executed'`) without creating a pending card, and log `decision: 'allowed'` with `reason` mentioning `auto_accept`. Switching to `'auto_accept'` while actions are pending can auto-approve all pending actions via `gatekeeper.setApprovalPolicy('auto_accept', { autoApprovePending: true })`.
  2. Per-tool risk tier overrides (`gatekeeper.setToolRiskTier('read_workspace_file', 'staged-confirm')` escalates a `read-safe` tool to `staged-confirm`; `getToolRiskOverrides()` returns active overrides).
  3. Rich `PendingActionCard` fields (`targetPath`, `commandPreview`, `diffPreview`, `blastRadiusWarning`) and path traversal blocking on `staged-confirm` file write tools (`write_project_note` with `path: '../../evil.md'` -> `blocked_traversal`).
  4. Session approval management (`getSessionApprovedTools()`, `revokeSessionApproval(toolName)`, `revokeAllSessionApprovals()`) and `onAuditEntry` callback firing on every audit decision.
  5. `McpProtocolClient` JSON-RPC 2.0 over HTTP (`fetchImpl`) and Stdio mock transport: `initialize`, `listTools`, `callTool`, and registering discovered remote tools into `ProgressiveMcpRegistry`.
  6. `AuthorizedVisionSensor`:
     - When `eyesMode === 'off'`, calling `observeScreen()` NEVER calls `captureFrameFn`, increments `blockedPrivacyCount`, and records `blocked_privacy` in the gatekeeper audit log.
     - When `eyesMode === 'window'` or `'screen'`, captures RGBA frame, computes 64-bit `dHash`, calls `VisionProvider` on first/changed frame, and skips `VisionProvider` on static frame (`hammingDistance <= 4`, `0` vision tokens spent).

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm --filter @ashy/agency test`

- [ ] **Step 3: Implement `@ashy/agency` upgrades**
  - Update `packages/agency/src/action-gatekeeper.ts` with `approvalPolicy`, `setApprovalPolicy`, `setToolRiskTier`, `getToolRiskOverrides`, `getSessionApprovedTools`, `revokeSessionApproval`, `revokeAllSessionApprovals`, `onAuditEntry`, rich preview builders (`computeUnifiedDiffPreview`), and symlink-safe path check when `node:fs` is available.
  - Update `packages/agency/src/mcp-progressive.ts` with `listAllTools()`, `setToolRiskTier()`, and server removal support.
  - Create `packages/agency/src/mcp-client.ts` with `createHttpMcpClient` and `createStdioMcpClient` (`shell: false`).
  - Create `packages/agency/src/vision-sensor.ts` with `createAuthorizedVisionSensor`.
  - Export everything from `packages/agency/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm --filter @ashy/agency test`

---

### Task 3: `@ashy/cortex` Schema Migration `v4` (`action_audit_log` & `agency_consent_state`)

**Files:**
- Modify: `packages/cortex/src/db/cortex-db.ts`
- Modify: `packages/cortex/src/__tests__/phase1-persistence.test.ts`

- [ ] **Step 1: Write failing persistence tests in `packages/cortex/src/__tests__/phase1-persistence.test.ts`**
  Test that:
  1. `CortexDatabase` applies migration `v4_phase7_agency_audit_and_consent`.
  2. `db.insertActionAuditLog(...)` and `db.listActionAuditLog()` persist across database close & reopen on disk (`ashy.db`).
  3. `db.getAgencyConsentState()` and `db.saveAgencyConsentState(...)` persist `eyesMode`, `micMode`, `dndMode`, `approvalPolicy` (including `'auto_accept'`), `allowedPaths`, `allowedWindowTitles`, `toolRiskOverrides`, and `externalMcpServers` across restarts.

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm --filter @ashy/cortex test`

- [ ] **Step 3: Implement migration `v4` and methods in `packages/cortex/src/db/cortex-db.ts`**
  Add `action_audit_log` and `agency_consent_state` tables in SQLite and mirror them in `MemoryStorageAdapter`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm --filter @ashy/cortex test`

---

### Task 4: Host Agency Runtime, 4 Real Local MCP Servers, Vision-to-Turn Wiring & IPC Transport (`apps/desktop/src/host/`)

**Files:**
- Create: `apps/desktop/src/host/agency-runtime.ts`
- Modify: `apps/desktop/src/host/kernel.ts`
- Modify: `apps/desktop/src/host/turn-orchestrator.ts`
- Modify: `apps/desktop/src/host/vite-host-plugin.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/services/ashy-host-client.ts`
- Modify: `apps/desktop/src/__tests__/host-kernel.test.ts`
- Modify: `apps/desktop/src/__tests__/host-transport.test.ts`

- [ ] **Step 1: Write failing host kernel and transport tests**
  In `apps/desktop/src/__tests__/host-kernel.test.ts` and `host-transport.test.ts`:
  - Verify `kernel.getBootstrapSnapshot().agency` includes the 4 built-in servers (`desktop-vision`, `workspace-fs`, `workspace-notes`, `workspace-shell`), `exposedMetaToolsCount === 3`, and persisted consent state.
  - Verify calling `write_project_note` in default `'ask'` mode stages a `PendingActionCard` with `diffPreview` and `targetPath` without writing the file yet; calling `approvePendingAction` writes the real file on disk and logs `approved` in `ashy.db`.
  - Verify switching `approvalPolicy` to `'auto_accept'` ("Não pergunte") executes `write_project_note` and `run_cleanup_command` immediately without staging, and persists the audit entry in `ashy.db`.
  - Verify `captureAuthorizedScreen` is blocked when `eyesMode === 'off'` (`framesCapturedCount === 0`) and captures + deduplicates via `dHash` when `eyesMode === 'window'` or `'screen'`, feeding real `screenContext` into `TurnOrchestrator`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm --filter @ashy/desktop test`

- [ ] **Step 3: Implement `agency-runtime.ts` and wire into `kernel.ts`, `turn-orchestrator.ts`, and IPC/HTTP bridges**
  - Create `apps/desktop/src/host/agency-runtime.ts` orchestrating `PrivacyController`, `ActionGatekeeper`, `ProgressiveMcpRegistry`, `AuthorizedVisionSensor`, and the 4 real built-in MCP servers backed by `cortex.db`.
  - Inject real `screenContext` (when `eyesMode !== 'off'`) and the 3 MCP meta-tools block into `turn-orchestrator.ts`.
  - Expose all Phase 7 agency/vision/consent endpoints over `kernel.ts`, `vite-host-plugin.ts`, `main/index.ts`, `preload/index.ts`, and `ashy-host-client.ts`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm --filter @ashy/desktop test`

---

### Task 5: Desktop UI — Inline `PendingActionCard`, "Modo Não Pergunte (`auto_accept`)", Vision Telemetry & Consent Center (`useAshyStore.ts` & `App.tsx`)

**Files:**
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/__tests__/phase7-desktop-vision-mcp-ui.test.tsx`

- [ ] **Step 1: Write failing UI tests in `apps/desktop/src/__tests__/phase7-desktop-vision-mcp-ui.test.tsx`**
  Test:
  1. Staging a write action (`write_project_note`) renders a `PendingActionCard` both **inline in the Chat / Stage Overlay speech bubble** and in **Ajustes > Permissões**, displaying `diffPreview` / `targetPath` and **Aprovar uma vez / Permitir na sessão / Recusar**.
  2. Toggling **"Modo Não Pergunte (Aceitar automaticamente qualquer permissão)"** (`data-testid="toggle-dont-ask-mode"` or selecting `auto_accept` in `select-computer-actions-policy`) immediately sets `computerActionsPolicy === 'auto_accept'`, auto-executes subsequent `write_project_note` and `run_cleanup_command` calls without asking, and logs them in the Consent Center audit ledger.
  3. **Vision & dHash Gate UI:** With `eyesMode === 'off'`, clicking `Capturar tela autorizada` (`data-testid="btn-vision-capture"`) blocks capture (`framesCapturedCount === 0`, logs `blocked_privacy`). Switching `eyesMode` to `'window'` or `'screen'` captures Frame 1 (`framesCapturedCount === 1`), and capturing the same static frame again increments `framesSkippedByDhashCount === 1` (`0` tokens).
  4. **Consent Center:** Updating per-tool risk tier (`data-testid="select-risk-tier-read_workspace_file"`), adding/removing `allowedPaths` (`data-testid="input-add-allowed-path"`), viewing `consent-audit-ledger`, and clicking `Revogar permissões da sessão` (`data-testid="btn-revoke-session-permissions"`).

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm --filter @ashy/desktop test`

- [ ] **Step 3: Implement Store & UI in `useAshyStore.ts` and `App.tsx`**
  - Wire `useAshyStore.ts` actions to sync with `ashyHostClient` AND update local agency state synchronously/optimistically so both host-backed and standalone store tests work seamlessly.
  - Render inline `PendingActionCard` in Chat (`data-testid="chat-pending-actions-bar"`) and Stage Overlay (`data-testid="stage-pending-action-bubble"`).
  - Add the **"Modo Não Pergunte"** switch (`data-testid="toggle-dont-ask-mode"`) + `<option value="auto_accept">Não perguntar (aceitar automaticamente qualquer permissão)</option>` in `Ajustes > Permissões`.
  - Add the **Consent Center** cards (Per-Tool Risk Classification, Allowed Paths/Windows Editor, Vision & dHash Sensor Card, Session Approvals & Revoke, and Persistent Audit Ledger `data-testid="consent-audit-ledger"`).

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm --filter @ashy/desktop test`

---

### Task 6: Phase 7 Wire-Back Verification Script & Playwright Visual Inspection

**Files:**
- Create: `scripts/verify-phase7-wireback.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/verify-phase7-wireback.mjs` and update `package.json` `verify:wireback`**
  Verify all Phase 7 exit criteria end-to-end against a real temporary `ashy.db` host kernel:
  1. Write tool (`write_project_note`) never executes without approval in `'ask'` mode.
  2. Switching to `'auto_accept'` ("Não pergunte") auto-executes any tool without confirmation while recording in `action_audit_log`.
  3. With `eyesMode === 'off'`, zero frames are captured; with `eyesMode === 'window'`, static frames are skipped by `dHash`.
  4. All accesses and actions survive kernel restart in `ashy.db` `action_audit_log`.

- [ ] **Step 2: Run full test suite, typecheck, build, wireback, and Playwright browser inspection**
  Run:
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm build`
  - `pnpm verify:wireback`
  - Inspect `http://localhost:5173/` with Playwright MCP (`browser_navigate`, `browser_snapshot`, `browser_take_screenshot`) verifying the new Consent Center, "Modo Não Pergunte", Vision dHash card, and Inline Approval cards visually.
