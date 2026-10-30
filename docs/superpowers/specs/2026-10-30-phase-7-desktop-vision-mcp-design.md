# Ashy Phase 7 — Desktop, Vision & MCP Tools Design Specification

**Date:** 2026-10-30
**Status:** Draft (Pending User Spec Review)
**Phase:** Fase 7 (`docs/ASHY_ROADMAP.md` — Desktop, visão e ferramentas MCP · §10 de `docs/ASHY_PROJECT_CONTEXT.md`)
**Scope:** `@ashy/shared`, `@ashy/agency`, `@ashy/cortex`, `apps/desktop` (`src/host/`, `src/electron/`, `src/preload/`, `src/store/`, `src/App.tsx`), and `scripts/verify-phase7-wireback.mjs`

---

## 1. Executive Summary & Goal

Phase 7 realizes **§10 — Uso do computador e ferramentas MCP** (*"observar é diferente de agir; preparar uma ação é diferente de confirmá-la"*), replacing the renderer-only mock agency state in `useAshyStore.ts` with a **real, persisted, host-governed Agency, Vision & MCP subsystem**:

1. **Hybrid Local-First MCP Client & Real Host-Side Servers (Entrega 1):**
   - `McpProtocolClient` in `@ashy/agency` implementing JSON-RPC 2.0 MCP transport over **HTTP (`fetch` POST/SSE)** and **Stdio (`node:child_process`)** (`initialize`, `tools/list`, `tools/call`) with strict timeout, payload size cap, and schema sanitization.
   - **4 Real Built-In Local MCP Servers** running in the Host (`apps/desktop/src/host/`), plus dynamic registration of external MCP servers (`stdio` or `http`):
     - `desktop-vision`: `get_active_window_title`, `capture_authorized_screen` (`observe-only`, gated by `PrivacyController.canObserveScreen` + perceptual 64-bit `dHash` deduplication).
     - `workspace-fs`: `read_workspace_file`, `list_workspace_directory` (`read-safe`, strictly sandboxed inside `allowedPaths` via `canonicalizeSafePath` + `fs.realpathSync` symlink-escape protection).
     - `workspace-notes`: `write_project_note` (`staged-confirm`, computes unified diff preview before staging and writes atomically inside `allowedPaths` only after explicit user approval).
     - `workspace-shell`: `run_workspace_command` (`staged-confirm`, inspected by `BlastRadiusGuard`, never executes without explicit user approval).
   - Connected to `ProgressiveMcpRegistry` so Ashy's prompt always receives only the **3 lightweight meta-tools** (`search_mcp_tools`, `get_mcp_tool_details`, `call_mcp_tool`), preventing context window bloat even with 30+ registered tools.

2. **Gatekeeper Persisted in `ashy.db` & Dual Inline/Hub Approval UX (Entrega 2):**
   - Adds Schema Migration `v4_phase7_agency_audit_and_consent` in `@ashy/cortex` (`CortexDatabase`):
     - `action_audit_log` table persisting every `ActionAuditLogEntry` (`allowed`, `staged`, `approved`, `denied`, `blocked_privacy`, `blocked_traversal`, `revoked`).
     - `agency_consent_state` table persisting `allowedPaths`, `allowedWindowTitles`, `toolRiskOverrides`, `eyesMode`, `micMode`, `dndMode`, and `externalMcpServers`.
   - `PendingActionCard` enriched with structured **`diffPreview` / `commandPreview` / `targetPath`** and **`blastRadiusWarning`**.
   - **Dual Approval Surface & "Não Pergunte" (`auto_accept`) Mode:**
     - Supports 4 global approval policies (`ComputerActionsPolicy = 'ask' | 'session' | 'auto_accept' | 'off'`):
       - `'ask'` (Default): Stages `staged-confirm` tools as a `PendingActionCard` requiring explicit approval.
       - `'session'`: Remembers approval per tool for the active session (unless a Blast-Radius rule triggers).
       - `'auto_accept'` (**Modo "Não pergunte"**): Automatically accepts and immediately executes **any** permission/tool request without staging a confirmation card, while still logging every action in `action_audit_log` (`reason: "Auto-approved (dont-ask mode)"`).
       - `'off'`: Blocks execution of computer actions.
     - When in `'ask'` or `'session'` mode, pending actions appear immediately:
       1. **Inline in the Chat & Stage Overlay Speech Bubble** (`data-testid="stage-pending-action-bubble"` / `data-testid="chat-pending-action-card"`), and
       2. **In the Companion Hub Consent Center (`Ajustes > Permissões`)**,
       with **Aprovar 1x (`once`)**, **Permitir na sessão (`session`)**, and **Recusar (`deny`)** buttons.
   - **Hard Safety Invariant (in `'ask'` / `'session'` modes):** Tools with `blastRadiusWarning` can **never** be auto-approved by session scope (`scope === 'session'` is downgraded to `'once'` when a Blast-Radius rule triggers), unless the user has explicitly enabled the global **Modo "Não pergunte" (`auto_accept`)**.

3. **Configurable Per-Tool Risk Tiers & Folder/Window Scopes (Entrega 3):**
   - Users can inspect every registered MCP tool and override its `riskTier` (`observe-only`, `read-safe`, `staged-confirm`) in the UI, persisted in `ashy.db`.
   - **Adversarial Escalation Floors:**
     - Any tool whose arguments trigger `detectBlastRadiusWarning` is forcibly escalated to `staged-confirm` regardless of user override.
     - Path arguments on `read-safe` and `staged-confirm` tools are validated against both lexical `canonicalizeSafePath` and OS-level symlink resolution (`realpath`) inside `allowedPaths`.
   - Interactive management of `allowedPaths` (authorized folder scopes) and `allowedWindowTitles` (authorized window title patterns) in the Hub.

4. **Authorized Vision Pipeline (`EyesMode` + `desktopCapturer` + `dHash` 64-bit + Pluggable Vision Provider) (Entrega 4):**
   - **Default Off (`eyesMode === 'off'`):** Strictly zero screen/window frames are captured when `eyesMode === 'off'`. Attempting observation records `blocked_privacy` in `action_audit_log`.
   - **Authorized Capture (`window` / `screen`):**
     - Uses Electron `desktopCapturer.getSources({ types: ['window', 'screen'] })` when running in Electron Main, or deterministic/browser frame capture in web/test mode.
     - Filters every frame through `createScreenObservationFilter` (`computeDHash64` + `hammingDistance64 <= 4` skipped with `0` vision tokens spent).
     - When a frame is accepted (`initial_frame`, `changed`, or `force_refresh`), passes it to the pluggable `VisionProvider` (multimodal LLM adapter via `@ashy/llm` or deterministic local frame analyzer) to produce a sanitized `ScreenObservationSummary` injected as real `screenContext` into `TurnOrchestrator` / `SoulComposer`.

5. **Consent Center & Instant Permission Revocation (Entrega 5):**
   - Dedicated **Consent Center** section in `Ajustes > Permissões`:
     - Live list of **Active Session Approvals (`sessionApprovedTools`)** with 1-click individual revocation or **Revogar todas as permissões da sessão**.
     - Manage **Authorized Folders (`allowedPaths`)** and **Authorized Windows (`allowedWindowTitles`)** with add/remove controls.
     - Manage **Per-Tool Risk Classification (`observe-only` | `read-safe` | `staged-confirm`)** and **External MCP Servers (`stdio` / `http`)**.
     - Persistent, filterable **Action & Access Audit Ledger (`action_audit_log`)** reading directly from `ashy.db`.

---

## 2. Resolved Architectural Decisions (Brainstorming Q1–Q3)

| ID | Decision Area | Chosen Architecture |
| :--- | :--- | :--- |
| **Q1** | **MCP Client & Server Architecture** | **Hybrid Local-First:** Built-in real Host MCP servers (`desktop-vision`, `workspace-fs`, `workspace-notes`, `workspace-shell`) + standard JSON-RPC 2.0 MCP Client (`stdio` & `http`) connected to `ProgressiveMcpRegistry` (exposing only 3 meta-tools in prompt). |
| **Q2** | **Authorized Vision (`EyesMode`)** | **Real Host/Electron Capture + 64-bit `dHash` Filter + Pluggable VLM Provider:** Zero frames captured when `eyesMode === 'off'`; skips static frames (`Hamming <= 4` = 0 tokens); feeds real `screenContext` into `SoulComposer`. |
| **Q3** | **Gatekeeper UX & Consent Center** | **Dual Inline + Hub Approval Cards & SQLite-Persisted Consent Center:** `PendingActionCard` (with diff/command/path preview) rendered in Chat, Stage Overlay bubble, and Hub; `action_audit_log`, risk overrides, and scopes persisted in `ashy.db`. |

---

## 3. Detailed Subsystem Architecture

### 3.1 `@ashy/agency`: Real MCP Client, Symlink-Safe Path Guard & Upgraded Gatekeeper

1. **MCP JSON-RPC 2.0 Client (`packages/agency/src/mcp-client.ts`):**
   - Supports two transport adapters:
     - `HttpMcpTransport`: Sends JSON-RPC 2.0 requests (`initialize`, `tools/list`, `tools/call`) over HTTP/HTTPS with configurable timeout (`default: 10_000ms`), `AbortSignal`, and response size limit (`1 MB`) to prevent memory exhaustion from rogue servers.
     - `StdioMcpTransport`: Spawns a local MCP server process (`child_process.spawn` with `shell: false` to prevent shell injection in server arguments), framing newline-delimited JSON-RPC 2.0 messages over `stdin`/`stdout`.
   - `connectExternalMcpServer(config: ExternalMcpServerConfig)` discovers tools via `tools/list`, sanitizes tool names/descriptions, assigns default risk tiers (`staged-confirm` by default for external tools unless overridden), and registers them into `ProgressiveMcpRegistry`.

2. **Upgraded `ActionGatekeeper` & `ProgressiveMcpRegistry` (`packages/agency/src/action-gatekeeper.ts`):**
   - **Dynamic Risk Tier Overrides:**
     - `setToolRiskTier(toolName: string, riskTier: ActionRiskTier): void`
     - `getToolRiskTier(toolName: string): ActionRiskTier`
   - **Rich `PendingActionCard` Preview Fields:**
     ```ts
     export interface PendingActionCard {
       readonly id: string
       readonly toolName: string
       readonly serverName: string
       readonly summary: string
       readonly argsPreview: string
       readonly targetPath?: string
       readonly commandPreview?: string
       readonly diffPreview?: string
       readonly riskTier: ActionRiskTier
       readonly blastRadiusWarning?: string
       status: 'pending' | 'approved' | 'denied'
       readonly createdAt: number
     }
     ```
   - **Session Approval Inspection & Revocation (Consent Center):**
     - `getSessionApprovedTools(): string[]`
     - `revokeSessionApproval(toolName: string): void`
     - `revokeAllSessionApprovals(): void`
   - **Audit Persistence Hook (`onAuditEntry`):**
     - `ActionGatekeeperOptions` accepts `onAuditEntry?: (entry: ActionAuditLogEntry) => void` and `initialAuditLog?: readonly ActionAuditLogEntry[]` so `AshyHostKernel` writes every audit event synchronously into `cortex.db.insertActionAuditLog(entry)`.
   - **Path Validation on `staged-confirm` as well as `read-safe`:**
     - If a `staged-confirm` file tool (`write_project_note`, `write_file`, etc.) receives a path argument outside `allowedPaths` or containing traversal/symlink escape, it is **immediately blocked (`blocked_traversal`)** before even staging a card!

3. **Authorized Vision Sensor & Pluggable Vision Provider (`packages/agency/src/vision-sensor.ts`):**
   - `AuthorizedVisionSensor` coordinates:
     1. **Privacy Gate Check:** Calls `privacyController.canObserveScreen(activeWindowTitle)`. If `false` (e.g., `eyesMode === 'off'` or unallowed window in `'window'` mode), **never calls `captureFrameFn()`**, increments `blockedCaptureCount`, and logs `blocked_privacy`.
     2. **Frame Capture (`captureFrameFn`):** Captures `{ width, height, pixels, windowTitle, sourceType }` ONLY when authorized.
     3. **Perceptual `dHash` Deduplication (`ScreenObservationFilter`):** Evaluates `evaluateFrame(pixels, width, height, nowMs)`. If `skip === true` (`static_skipped`), returns the cached `lastSummary` without invoking `visionProvider` (`visionTokensSpent = 0`).
     4. **Pluggable Vision Provider (`VisionProvider`):** Analyzes changed frames and returns `{ summary, detectedApp, codingContext, timestamp, dHashHex, skippedByDHash }`.

---

### 3.2 `@ashy/cortex`: Schema Migration `v4` (`action_audit_log` & `agency_consent_state`)

In `packages/cortex/src/db/cortex-db.ts` (and mirrored in `MemoryStorageAdapter`):

1. **Table `action_audit_log`:**
   ```sql
   CREATE TABLE IF NOT EXISTS action_audit_log (
     id TEXT PRIMARY KEY,
     timestamp INTEGER NOT NULL,
     tool_name TEXT NOT NULL,
     server_name TEXT NOT NULL,
     risk_tier TEXT NOT NULL,
     decision TEXT NOT NULL,
     args_preview TEXT NOT NULL,
     action_id TEXT,
     reason TEXT,
     blast_radius_warning TEXT,
     target_path TEXT,
     command_preview TEXT,
     diff_preview TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_action_audit_log_timestamp
     ON action_audit_log(timestamp DESC);
   ```
2. **Table `agency_consent_state`:**
   ```sql
   CREATE TABLE IF NOT EXISTS agency_consent_state (
     singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
     eyes_mode TEXT NOT NULL DEFAULT 'off',
     mic_mode TEXT NOT NULL DEFAULT 'muted',
     dnd_mode INTEGER NOT NULL DEFAULT 0,
     allowed_paths_json TEXT NOT NULL DEFAULT '[]',
     allowed_windows_json TEXT NOT NULL DEFAULT '[]',
     tool_risk_overrides_json TEXT NOT NULL DEFAULT '{}',
     external_mcp_servers_json TEXT NOT NULL DEFAULT '[]',
     updated_at INTEGER NOT NULL
   );
   ```
3. **Database Methods:**
   - `insertActionAuditLog(entry: ActionAuditLogEntry): ActionAuditLogEntry`
   - `listActionAuditLog(limit?: number): ActionAuditLogEntry[]`
   - `clearActionAuditLog(): void`
   - `getAgencyConsentState(): PersistedAgencyConsentState`
   - `saveAgencyConsentState(patch: Partial<PersistedAgencyConsentState>): PersistedAgencyConsentState`

---

### 3.3 `apps/desktop`: Host Agency Runtime, IPC Bridge & UI Integration

1. **Host Agency Runtime (`apps/desktop/src/host/agency-runtime.ts` & `kernel.ts`):**
   - `AshyHostKernel` initializes `HostAgencyRuntime` backed by `cortex.db` and `userDataDir`:
     - Default `allowedPaths` includes the active workspace directory and `<userDataDir>/workspace`.
     - Real `read_workspace_file` reads real files inside `allowedPaths` (checking `fs.realpathSync` so symlinks pointing outside `allowedPaths` are rejected with `blocked_traversal`).
     - Real `write_project_note` generates a unified diff preview (`--- a/notes/...` / `+++ b/notes/...`) when staged, and writes the real markdown file inside `<userDataDir>/workspace/notes/` upon `approveAction`.
     - Real `run_workspace_command` stages commands with `commandPreview` and `blastRadiusWarning`, executing only approved safe workspace commands on approval.
     - Real `get_active_window_title` and `capture_authorized_screen` use `AuthorizedVisionSensor`.
   - `AshyBootstrapSnapshot` includes `agency: AgencySnapshot` (current `privacyState`, `tools`, `pendingActions`, `auditLog`, `sessionApprovedTools`, `externalServers`, `visionState`).

2. **Host Protocol & IPC Bridge (`@ashy/shared/src/host-protocol.ts`, `preload/index.ts`, `ashy-host-client.ts`):**
   - New host bridge endpoints:
     - `getAgencySnapshot(): Promise<AgencySnapshot>`
     - `searchMcpTools(input: { query: string; limit?: number }): Promise<McpToolCompactSummary[]>`
     - `getMcpToolDetails(input: { toolName: string }): Promise<McpToolDetails | null>`
     - `callMcpTool(input: { toolName: string; args?: Record<string, unknown> }): Promise<GatekeeperExecutionResult>`
     - `approvePendingAction(input: { actionId: string; scope: ApprovalScope }): Promise<ApproveActionResult>`
     - `denyPendingAction(input: { actionId: string; reason?: string }): Promise<DenyActionResult>`
     - `updateAgencyConsent(input: UpdateAgencyConsentInput): Promise<AgencySnapshot>`
     - `revokeSessionPermissions(input?: { toolName?: string }): Promise<AgencySnapshot>`
     - `captureAuthorizedScreen(input?: { windowTitle?: string; frameFixtureId?: string }): Promise<VisionObservationResult>`
     - `registerExternalMcpServer(input: ExternalMcpServerConfig): Promise<AgencySnapshot>`

3. **Companion Hub & Stage Overlay UI (`apps/desktop/src/App.tsx`):**
   - **Inline Pending Action Cards:** Rendered inside the active Chat stream AND inside the Stage Overlay speech bubble whenever `pendingActions.length > 0`, displaying tool summary, `targetPath` / `commandPreview` / `diffPreview`, `blastRadiusWarning`, and **Aprovar uma vez / Permitir na sessão / Recusar**.
   - **Consent Center (`Ajustes > Permissões`):**
     - **Eyes & Vision Telemetry Card:** Displays `eyesMode` (`off` by default), `lastVisionSummary`, `dHashHex`, `framesCapturedCount`, `framesSkippedByDhashCount`, `blockedPrivacyCount`, and buttons to test authorized window capture vs. static frame skip vs. `eyesMode: 'off'` block.
     - **Scope & Risk Configuration Card:** Add/remove `allowedPaths` and `allowedWindowTitles`, and per-tool risk selector (`observe-only`, `read-safe`, `staged-confirm`).
     - **Session Permissions & Revocation Card:** Shows active `sessionApprovedTools` with 1-click revoke (`data-testid="btn-revoke-all-permissions"`) and Privacy Shield (`data-testid="btn-activate-privacy-shield"`).
     - **Persistent Audit Log Ledger (`data-testid="consent-audit-ledger"`):** Displays real entries persisted in `ashy.db` with timestamp, tool, server, risk tier, decision badge, and reason/diff preview.

---

## 4. Red-Team & Security Hardening Checklist

1. **Zero Execution Without Approval for Write/Command Tools:** Any `staged-confirm` tool (`write_project_note`, `run_workspace_command`, `run_cleanup_command`) never invokes its handler on `call_mcp_tool` unless previously approved for the session AND free of `blastRadiusWarning`.
2. **Blast-Radius Session Bypass Prevention:** If a tool is approved for `'session'` on a benign call, and a subsequent call to the same tool contains a destructive pattern (`rm -rf`, `Remove-Item -Recurse`, `DROP TABLE`, `format`), `ActionGatekeeper` ignores the session approval and forces a new `staged-confirm` card with `blastRadiusWarning`.
3. **Symlink & Traversal Defense on Both Read and Write:** `canonicalizeSafePath` + `fs.realpathSync` checks are enforced on both `read-safe` and `staged-confirm` path arguments so an attacker cannot stage or execute a write to `../../` or via a symlink pointing outside `allowedPaths`.
4. **Zero Screen Capture When `eyesMode === 'off'`:** `AuthorizedVisionSensor` checks `privacyController.canObserveScreen` *before* invoking `captureFrameFn`, guaranteeing zero pixel buffers are read when `eyesMode === 'off'`.
5. **Child Process Stdio Safety:** `StdioMcpTransport` uses `shell: false` and validates executable paths/arguments.

---

## 5. Exit Criteria & Verification Gates (`docs/ASHY_ROADMAP.md` §Fase 7)

1. **Write/Command Tool Gate (`staged-confirm`):** A write or shell tool (`write_project_note`, `run_cleanup_command`) never executes without explicit approval — covered by unit, host integration, and Playwright E2E tests.
2. **Vision Privacy Gate (`eyesMode === 'off'`):** With Eyes off, zero screen frames are captured (`framesCapturedCount === 0`, `captureFrameFn` not called) and `blocked_privacy` is recorded. With Eyes on, static frames are skipped by 64-bit `dHash` (`0` vision tokens spent).
3. **Full Audit Trail in `ashy.db`:** Every observation, read, staged action, approval, denial, privacy block, traversal block, and permission revocation is persisted in `action_audit_log` in `ashy.db` and survives app/kernel restarts.
4. **Quality Gates:** `pnpm test`, `pnpm typecheck`, `pnpm build`, `node scripts/verify-phase7-wireback.mjs`, and visual verification via Playwright on `http://localhost:5173/` all pass 100%.
