# Phase 9.1 — One-Line Installer, Packaging Fix & In-App Local Model Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `electron-builder` 26.18.0 packaging (`AshySetup.exe` / `AshyPortable.exe`), add Orin-style one-line installers (`install.ps1` / `install.sh` + `.github/workflows/release.yml`), and implement `LocalRuntimeManager` so users can install, start (`ollama serve` headlessly), and download (`pull`) local models with a live progress bar 100% inside the Ashy app without ever opening a terminal.

**Architecture:** `LocalRuntimeManager` runs inside the Node/Electron Host (`AshyHostKernel`), discovers or silently installs the local engine binary, spawns `ollama serve` headlessly (`windowsHide: true`, pinned to `127.0.0.1:11434`), streams NDJSON progress from `POST /api/pull` over Host Events (`local-runtime:status`), and automatically activates the pulled model in `ProviderVault`. Packaging bundles self-contained `dist/` + `256x256` icons into `AshySetup.exe` and `AshyPortable.exe` via `electron-builder`.

**Tech Stack:** TypeScript 5.8, Node.js 22 (`node:child_process`, `node:http`, `node:sqlite`), Electron 35, `electron-builder` 26, React 19, Zustand 5, Valibot, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-31-phase-9-1-one-click-installer-and-in-app-local-runtime-design.md`

## Global Constraints

- **Zero Terminal / Zero CMD for Local Models:** Every child process spawned by `LocalRuntimeManager` MUST use `shell: false` and `windowsHide: true`, and bind strictly to `127.0.0.1:11434`.
- **Strict Input Validation on Model Names:** Model identifiers passed to `pullModel` or `deleteModel` MUST match `/^[a-zA-Z0-9._:/-]+$/` (max 128 chars) before any HTTP or process call.
- **Valid `electron-builder` 26.18.0 Schema:** `publish` in `apps/desktop/electron-builder.yml` MUST use `{ provider: 'github', owner: 'carlos-edu2367', repo: 'ashy', releaseType: 'release' }` (no invalid `autoUpdate` key), and `build/icon.ico` MUST be `256x256`.
- **Zero Regressions:** All existing 54 Vitest test files and 6 Playwright E2E flows must remain 100% green.

---

### Task 1: `electron-builder` 26.18.0 Fix, 256x256 Icons & One-Line Installers (`install.ps1` / `install.sh`)

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/scripts/build-electron.mjs`
- Modify: `apps/desktop/electron-builder.yml`
- Create: `install.ps1`
- Create: `install.sh`
- Create: `.github/workflows/release.yml`
- Modify: `README.md`, `README.pt-BR.md`, `README.en.md`
- Modify: `apps/desktop/src/__tests__/phase9-electron-lifecycle.test.ts`

**Interfaces:**
- Produces:
  - `apps/desktop/build/icon.ico` and `apps/desktop/build/icon.png` at `256x256` resolution
  - Valid `apps/desktop/electron-builder.yml` producing `AshySetup.exe` and `AshyPortable.exe`
  - Root `install.ps1` and `install.sh` one-line installers

- [ ] **Step 1: Update `apps/desktop/src/__tests__/phase9-electron-lifecycle.test.ts` with failing assertions for 256x256 icon, valid `electron-builder.yml`, and `install.ps1` / `install.sh`**

```ts
// Add test in apps/desktop/src/__tests__/phase9-electron-lifecycle.test.ts:
it('5. configures valid electron-builder 26 schema, 256x256 icon.ico, and Orin-style install.ps1 / install.sh', () => {
  const yml = fs.readFileSync(path.resolve(desktopDir, 'electron-builder.yml'), 'utf8')
  expect(yml).toContain('provider: github')
  expect(yml).toContain('owner: carlos-edu2367')
  expect(yml).toContain('repo: ashy')
  expect(yml).not.toContain('autoUpdate:')
  expect(yml).toContain('artifactName: AshySetup.exe')

  const pkg = JSON.parse(fs.readFileSync(path.resolve(desktopDir, 'package.json'), 'utf8'))
  expect(pkg.description).toBeTruthy()
  expect(pkg.author).toBeTruthy()

  const repoRoot = path.resolve(desktopDir, '../..')
  expect(fs.existsSync(path.join(repoRoot, 'install.ps1'))).toBe(true)
  expect(fs.existsSync(path.join(repoRoot, 'install.sh'))).toBe(true)
  expect(fs.existsSync(path.join(repoRoot, '.github/workflows/release.yml'))).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `pnpm vitest run apps/desktop/src/__tests__/phase9-electron-lifecycle.test.ts`
Expected: FAIL (`expect(yml).toContain('provider: github')`)

- [ ] **Step 3: Implement `package.json`, `build-electron.mjs` (256x256 icon), `electron-builder.yml`, `install.ps1`, `install.sh`, `.github/workflows/release.yml`, and `README*.md`**

1. Update `apps/desktop/package.json` with `description`, `author`, `homepage`, and `"dist:win": "pnpm build && pnpm build:electron && npx --yes electron-builder --win"`.
2. Update `apps/desktop/scripts/build-electron.mjs` to generate `256x256` `icon.png` and `icon.ico` (regenerating if existing `icon.ico` has width != 256).
3. Update `apps/desktop/electron-builder.yml`:
   - `npmRebuild: false`
   - `files`: `dist/**/*`, `build/**/*`, `package.json`, `!**/node_modules/**/*`
   - `nsis.artifactName: AshySetup.exe`
   - `portable.artifactName: AshyPortable.exe`
   - `publish`: `provider: github`, `owner: carlos-edu2367`, `repo: ashy`, `releaseType: release`
4. Create `install.ps1`, `install.sh`, `.github/workflows/release.yml`, and add the one-line install command to `README.md`, `README.pt-BR.md`, and `README.en.md`.

- [ ] **Step 4: Run `build:electron` and unit tests to verify GREEN**

Run: `pnpm --filter @ashy/desktop build:electron && pnpm vitest run apps/desktop/src/__tests__/phase9-electron-lifecycle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/package.json apps/desktop/scripts/build-electron.mjs apps/desktop/electron-builder.yml install.ps1 install.sh .github/workflows/release.yml README.md README.pt-BR.md README.en.md apps/desktop/src/__tests__/phase9-electron-lifecycle.test.ts
git commit -m "feat(packaging): fix electron-builder 26 schema, 256px icon, and add install.ps1/install.sh"
```

---

### Task 2: Host Protocol & `LocalRuntimeManager` (`@ashy/shared` + `apps/desktop/src/host/local-runtime-manager.ts` + Kernel/Transport)

**Files:**
- Modify: `packages/shared/src/host-protocol.ts`
- Create: `apps/desktop/src/host/local-runtime-manager.ts`
- Modify: `apps/desktop/src/host/kernel.ts`
- Modify: `apps/desktop/src/host/vite-host-plugin.ts`
- Modify: `apps/desktop/src/services/ashy-host-client.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/__tests__/phase9-1-local-runtime-manager.test.ts`

**Interfaces:**
- Produces in `@ashy/shared`:
  - `LocalRuntimeModelInfo`, `LocalRuntimePullProgress`, `LocalRuntimeRecommendedModel`, `LocalRuntimeStatus`
  - `validateLocalModelName(model: string): string`
  - RPC methods: `'localRuntime:getStatus'`, `'localRuntime:ensureRunning'`, `'localRuntime:installEngine'`, `'localRuntime:pullModel'`, `'localRuntime:deleteModel'`
  - Host Event: `{ type: 'local-runtime:status', status: LocalRuntimeStatus }`
  - `AshyBootstrapSnapshot.localRuntime?: LocalRuntimeStatus`
- Produces in `apps/desktop/src/host/local-runtime-manager.ts`:
  - `LocalRuntimeManager` class with `getStatus()`, `ensureEngineRunning()`, `installEngine()`, `pullModel(model)`, `deleteModel(model)`, `dispose()`

- [ ] **Step 1: Write failing tests in `apps/desktop/src/__tests__/phase9-1-local-runtime-manager.test.ts`**

Test cases:
1. Detects running local Ollama HTTP server (`/api/tags`), lists installed models, and returns curated `recommendedModels`.
2. Headlessly starts `ollama serve` (`windowsHide: true`, `shell: false`, `OLLAMA_HOST=127.0.0.1:11434`) when engine is installed but not running, waits for readiness, and kills child process on `dispose()`.
3. Executes 1-click `installEngine()` when binary is missing, emits progress updates, and transitions to `engineInstalled: true` + `engineRunning: true`.
4. Streams `pullModel('qwen2.5:3b')` NDJSON progress (`starting` -> `pulling` 45% -> `verifying` -> `completed` 100%), updates `ProviderVault` to use `ollama` with `qwen2.5:3b`, and supports `deleteModel('qwen2.5:3b')`.
5. Rejects malicious model names (`../etc/passwd`, `qwen; rm -rf /`, empty string) with `INVALID_LOCAL_MODEL_NAME`.

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `pnpm vitest run apps/desktop/src/__tests__/phase9-1-local-runtime-manager.test.ts`
Expected: FAIL (`Cannot find module '../host/local-runtime-manager'`)

- [ ] **Step 3: Implement `@ashy/shared` types/schemas, `LocalRuntimeManager`, and Kernel/RPC/Preload wiring**

1. Add `LocalRuntimeStatus` types, schemas, `validateLocalModelName`, RPC definitions, and Host Event to `packages/shared/src/host-protocol.ts`.
2. Create `apps/desktop/src/host/local-runtime-manager.ts`.
3. Wire `LocalRuntimeManager` into `AshyHostKernel` (`apps/desktop/src/host/kernel.ts`), `vite-host-plugin.ts`, `ashy-host-client.ts`, `preload/index.ts`, and `main/index.ts`.

- [ ] **Step 4: Run tests and typecheck to verify GREEN**

Run: `pnpm vitest run apps/desktop/src/__tests__/phase9-1-local-runtime-manager.test.ts apps/desktop/src/__tests__/host-transport.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/host-protocol.ts apps/desktop/src/host/local-runtime-manager.ts apps/desktop/src/host/kernel.ts apps/desktop/src/host/vite-host-plugin.ts apps/desktop/src/services/ashy-host-client.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/index.ts apps/desktop/src/__tests__/phase9-1-local-runtime-manager.test.ts
git commit -m "feat(host): add LocalRuntimeManager for headless ollama serve, 1-click install, and streaming model pull"
```

---

### Task 3: UI Integration (`useAshyStore.ts`, `FirstMeetingWizard.tsx`, `App.tsx`) & E2E Flow

**Files:**
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/components/FirstMeetingWizard.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/e2e/helpers/local-ai-test-server.ts`
- Modify: `apps/desktop/e2e/ashy-release-1-0.e2e.spec.ts`
- Create: `apps/desktop/src/__tests__/phase9-1-ui-local-runtime.test.tsx`

**Interfaces:**
- Consumes: `LocalRuntimeStatus` and RPC methods from Task 2
- Produces:
  - Store actions in `useAshyStore`: `localRuntime`, `refreshLocalRuntimeStatus`, `ensureLocalEngineRunning`, `installLocalEngine`, `pullLocalModel`, `deleteLocalModel`
  - Onboarding UI in `FirstMeetingWizard.tsx`: `data-testid="onboarding-local-runtime-card"`, `data-testid="btn-onboarding-start-local-engine"`, `data-testid="btn-onboarding-install-local-engine"`, `data-testid="btn-onboarding-pull-model-<id>"`, `data-testid="onboarding-local-pull-progress"`
  - Settings UI in `App.tsx`: `data-testid="panel-local-runtime-manager"`, `data-testid="btn-settings-start-local-engine"`, `data-testid="btn-settings-install-local-engine"`, `data-testid="input-custom-local-model"`, `data-testid="btn-pull-custom-local-model"`, `data-testid="settings-local-pull-progress"`

- [ ] **Step 1: Write failing UI tests in `apps/desktop/src/__tests__/phase9-1-ui-local-runtime.test.tsx`**

Test cases:
1. In `FirstMeetingWizard`, selecting Local Omni mode renders `onboarding-local-runtime-card`, allows 1-click engine start/install and 1-click model download (`qwen2.5:3b`), shows progress, and updates the model input.
2. In `App.tsx` (`Configurações`), renders `panel-local-runtime-manager`, shows installed models and recommended models, pulls a model with progress feedback, activates it, and deletes a model.

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `pnpm vitest run apps/desktop/src/__tests__/phase9-1-ui-local-runtime.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement store actions, `FirstMeetingWizard.tsx` Local Runtime Manager card, `App.tsx` Settings Local Runtime panel, and E2E server `/api/pull` support**

1. Add `localRuntime` state, event listener (`local-runtime:status`), and actions to `apps/desktop/src/store/useAshyStore.ts`.
2. Add the **Motor Local Integrado (Zero Terminal)** section inside `FirstMeetingWizard.tsx` when `architectureMode === 'local-omni'` or `selectedProvider === 'ollama'`.
3. Add the **Motor Local & Modelos Offline (Gerenciado pela Ashy)** card (`data-testid="panel-local-runtime-manager"`) inside `App.tsx` (`Configurações`).
4. Add `/api/pull` (NDJSON streaming) and `/api/delete` support to `apps/desktop/e2e/helpers/local-ai-test-server.ts`.

- [ ] **Step 4: Run unit tests, E2E suite, and real Windows `electron-builder` packaging test**

Run:
- `pnpm vitest run apps/desktop/src/__tests__/phase9-1-ui-local-runtime.test.tsx`
- `pnpm test`
- `pnpm test:e2e`
- `pnpm --filter @ashy/desktop dist:win`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/store/useAshyStore.ts apps/desktop/src/components/FirstMeetingWizard.tsx apps/desktop/src/App.tsx apps/desktop/e2e/helpers/local-ai-test-server.ts apps/desktop/e2e/ashy-release-1-0.e2e.spec.ts apps/desktop/src/__tests__/phase9-1-ui-local-runtime.test.tsx
git commit -m "feat(ui): integrate in-app LocalRuntimeManager in Onboarding Wizard and Settings"
```
