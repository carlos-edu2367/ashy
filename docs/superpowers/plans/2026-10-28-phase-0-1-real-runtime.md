# Ashy Phase 0/1 Real Runtime & Emergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Ashy from a browser-only scripted demo into a real persistent desktop companion (Milestone M1) with Phase 0 First-Meeting Emergence, SQLite WAL persistence (`ashy.db`), live `voice.md` identity + 20 PT-BR Golden Exemplars, encrypted multi-provider LLM vault, real streaming turns via `@ashy/llm`, and dual Electron/Vite host execution.

**Architecture:** A transport-agnostic Node.js `AshyHostKernel` orchestrated by `@ashy/bus` (`createContainer`) manages `CortexDatabase` (`ashy.db`), `VoiceIdentityStore` (`voice.md` with atomic `.bak1..3` auto-heal), `ProviderVault` (`providers.json` + encrypted secrets), and `TurnOrchestrator` (`SoulComposer` static/volatile split + `@ashy/llm` `streamText` + `createTailSafeMarkerParser` + 15s keepalive + immediate FTS5 indexing). The React renderer communicates exclusively through a typed `AshyHostBridge` backed by Electron `contextBridge`/IPC in desktop mode and a Vite Node HTTP/SSE middleware in web/Playwright mode.

**Tech Stack:** TypeScript 5.8+, React 19, Zustand 5, Electron 35+, Vite 6, `better-sqlite3` (SQLite3 WAL + FTS5), Valibot 1.x, Vitest 3.

**Spec:** [`docs/superpowers/specs/2026-10-28-phase-0-1-real-runtime-design.md`](../specs/2026-10-28-phase-0-1-real-runtime-design.md)

## Global Constraints

- **Zero API Key Leakage:** Raw API keys must never be sent to the renderer or stored in `localStorage`/Zustand; the renderer receives only `hasApiKey: boolean` and `maskedApiKey: string | null`.
- **IPC Registration Order (`airi` invariant):** In Electron Main, all `ipcMain.handle` channels must be registered before calling `window.loadURL` or `window.loadFile`.
- **SQLite Opening Discipline (`companion-emergence` invariant):** Every file-backed `CortexDatabase` must execute `PRAGMA quick_check(1)` -> `PRAGMA journal_mode = WAL` -> `PRAGMA synchronous = NORMAL` -> `PRAGMA busy_timeout = 5000` -> `PRAGMA foreign_keys = ON` -> `schema_migrations` inside a close-on-error guard, quarantining corrupt files to `<path>.corrupt.<timestamp>`.
- **Atomic Self-Healing Configs:** `voice.md`, `providers.json`, and `providers.secrets.json` must use atomic `.tmp` + `rename` writes with `.bak1/.bak2/.bak3` rotation and automatic recovery (`ConfigDiagnostics`).
- **Clean-Slate Production Boot:** `useAshyStore.ts` must never use `forceMemoryFallback: true`, fake seeded memories (`INITIAL_MEMORY_CARDS`, `ep-padre-npm-origin`, `ep-flashbulb-0314`), hardcoded `'21:15'` time, hardcoded `'VS Code — apps/desktop/src/App.tsx'` screen context, or scripted assistant replies.
- **Persistence Fault Isolation:** Post-turn SQLite persistence failures must emit `persistenceWarning` without discarding or breaking the streamed assistant response.

---

## File Structure Map

| File Path | Action | Responsibility |
| :--- | :--- | :--- |
| `packages/shared/src/host-protocol.ts` | Create | Typed RPC/stream contracts (`AshyHostBridge`, `AshyBootstrapSnapshot`, `AshyHostStreamEvent`, provider/session/message types, `maskApiKey`, Valibot schemas). |
| `packages/shared/src/index.ts` | Modify | Re-export `./host-protocol`. |
| `packages/shared/src/__tests__/host-protocol.test.ts` | Create | Unit & adversarial tests for host protocol schemas and API key masking. |
| `packages/cortex/src/prompt/default-golden-exemplars.ts` | Create | 20 curated PT-BR Golden Dialogue Exemplars across all 4 stages + `seriousness_gate`. |
| `packages/cortex/src/db/cortex-db.ts` | Modify | SQLite opening discipline (corrupt quarantine), Migration v2 (`schema_migrations`, `chat_sessions`, `chat_messages`), session/message CRUD, and exemplar seeding. |
| `packages/cortex/src/prompt/soul-composer.ts` | Modify | Split prompt into `staticSystemPrompt` (KV-cacheable `voice.md` + soul truths + exemplars) and `volatileTurnContext` (VAD, FTS5 recall, real local clock, user identity). |
| `packages/cortex/src/ashy-cortex.ts` | Modify | Expose session/message CRUD, `voiceIdentityMarkdown` injection in `compileTurnPrompt`, and `indexTurnMemory` for immediate FTS5 episode/fact recording. |
| `packages/cortex/src/__tests__/phase1-persistence.test.ts` | Create | Tests for Migration v2, corrupt DB quarantine/recovery, chat session/message persistence, and 20 PT-BR exemplars. |
| `packages/cortex/src/__tests__/soul-composer-split.test.ts` | Create | Tests for static vs. volatile prompt split, `voice.md` injection, and absence of hardcoded `'21:15'` / `'VS Code'`. |
| `apps/desktop/src/host/atomic-file.ts` | Create | Atomic `.tmp` + `rename` writer with `.bak1/.bak2/.bak3` rotation and `readWithAutoHeal`. |
| `apps/desktop/src/host/voice-identity-store.ts` | Create | Hot-loadable `voice.md` manager with `DEFAULT_ASHY_VOICE_MD`, `mtimeMs` cache, and auto-heal diagnostics. |
| `apps/desktop/src/__tests__/voice-identity-store.test.ts` | Create | Tests for atomic rotation, corrupt `voice.md` auto-heal from `.bak1`, and reset to default. |
| `apps/desktop/src/host/secret-protector.ts` | Create | `SecretProtector` implementations (Node AES-256-GCM with `.master.key` and Electron `safeStorage` adapter). |
| `apps/desktop/src/host/provider-vault.ts` | Create | Multi-provider config & encrypted secret manager (`openrouter`, `anthropic`, `openai`, `nvidia-nim`, `ollama`) + deduplicated 10s connection probe. |
| `apps/desktop/src/__tests__/provider-vault.test.ts` | Create | Adversarial tests for key encryption, secret masking, corrupt config recovery, and deduplicated healthchecks. |
| `apps/desktop/src/host/turn-orchestrator.ts` | Create | Real turn execution loop (lock/abort per session, `streamText`, `createTailSafeMarkerParser`, 15s `turn:keepalive`, VAD/callback updates, FTS5 indexing, fault isolation). |
| `apps/desktop/src/host/kernel.ts` | Create | `createAshyHostKernel` wired with `@ashy/bus` `createContainer` in topological order + `completeOnboarding`. |
| `apps/desktop/src/__tests__/host-kernel.test.ts` | Create | End-to-end Node tests for Phase 0 onboarding, streaming turns, `<think>` keepalives, concurrent turn abort, and persistence across kernel restarts. |
| `apps/desktop/src/host/vite-host-plugin.ts` | Create | Vite dev/Playwright middleware exposing `/__ashy_host/rpc` and `/__ashy_host/events` (SSE) backed by `AshyHostKernel`. |
| `apps/desktop/src/main/index.ts` | Create | Electron Main entrypoint registering IPC before `loadURL`, managing `HubWindow` + `StageOverlayWindow`, and stopping container on quit. |
| `apps/desktop/src/preload/index.ts` | Create | Electron Preload exposing `window.ashyHost` via `contextBridge.exposeInMainWorld`. |
| `apps/desktop/src/services/ashy-host-client.ts` | Create | Unified renderer `AshyHostBridge` client (Electron preload, HTTP+SSE web bridge, or injected test bridge). |
| `apps/desktop/src/__tests__/host-transport.test.ts` | Create | Tests for RPC + SSE event streaming transport and IPC registration order. |
| `apps/desktop/src/test/fixtures/demo-seed.ts` | Create | Isolated test/dev fixtures moved out of `useAshyStore.ts`. |
| `apps/desktop/src/components/FirstMeetingWizard.tsx` | Create | Phase 0 First-Meeting Emergence wizard (*Cozy Night Studio* 3-step modal). |
| `apps/desktop/src/components/ModelsSettingsPanel.tsx` | Create | `Ajustes > Modelos` subtab for configuring the 5 LLM providers, masked API keys, and live connection test. |
| `apps/desktop/src/store/useAshyStore.ts` | Modify | Remove in-browser `createAshyCortex({ forceMemoryFallback: true })` and scripted replies; wire all actions to `AshyHostBridge`. |
| `apps/desktop/src/App.tsx` | Modify | Integrate `FirstMeetingWizard`, `ModelsSettingsPanel` in `Ajustes > Modelos`, and `voice.md` live editor in `Alma`. |
| `apps/desktop/src/__tests__/phase0-1-ui.test.tsx` | Create | Component & store integration tests for clean boot wizard, provider settings, `voice.md` editing, and real streaming chat. |
| `scripts/verify-phase1-wireback.mjs` | Create | Automated Organ Wire-Back Audit verifying zero demo fallbacks in production and full producer/reader/test coverage. |

---

### Task 1: Shared Host Protocol & Provider Types (`@ashy/shared`)

**Files:**
- Create: `packages/shared/src/host-protocol.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/host-protocol.test.ts`

**Interfaces:**
- Consumes: `AshyEmotion`, `MoodVector`, `PersonalityTraits`, `SemanticFact`, `EpisodicMemory`, `RelationalMotif`, `AutobiographicalMilestone` from `@ashy/shared`.
- Produces: `LLM_PROVIDER_IDS`, `LlmProviderId`, `ConfigDiagnostics`, `ChatSessionRecord`, `ChatMessageRecord`, `PublicProviderConfig`, `ProviderHealthResult`, `AshyBootstrapSnapshot`, `AshyHostStreamEvent`, `AshyHostBridge`, `maskApiKey(rawKey)`, `CompleteOnboardingInputSchema`, `SaveProviderConfigInputSchema`, `SendTurnInputSchema`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/__tests__/host-protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  LLM_PROVIDER_IDS,
  maskApiKey,
  CompleteOnboardingInputSchema,
  SaveProviderConfigInputSchema,
  SendTurnInputSchema,
} from '../index'

describe('@ashy/shared host-protocol', () => {
  it('exposes the 5 supported Phase 1 LLM providers', () => {
    expect(LLM_PROVIDER_IDS).toEqual([
      'openrouter',
      'anthropic',
      'openai',
      'nvidia-nim',
      'ollama',
    ])
  })

  it('masks API keys safely without leaking short or malformed secrets', () => {
    expect(maskApiKey('')).toBeNull()
    expect(maskApiKey('   ')).toBeNull()
    expect(maskApiKey('short123')).toBe('••••123')
    expect(maskApiKey('sk-or-v1-1234567890abcdef9a2f')).toBe('sk-or-...9a2f')
  })

  it('validates onboarding, provider config, and turn inputs strictly', () => {
    const validOnboarding = v.safeParse(CompleteOnboardingInputSchema, {
      userName: '  Carlos  ',
      userPronouns: 'ele/dele',
    })
    expect(validOnboarding.success).toBe(true)
    if (validOnboarding.success) {
      expect(validOnboarding.output.userName).toBe('Carlos')
    }

    const emptyOnboarding = v.safeParse(CompleteOnboardingInputSchema, {
      userName: '   ',
    })
    expect(emptyOnboarding.success).toBe(false)

    const validProvider = v.safeParse(SaveProviderConfigInputSchema, {
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'anthropic/claude-3.7-sonnet',
      apiKey: 'sk-or-test-key',
    })
    expect(validProvider.success).toBe(true)

    const invalidTurn = v.safeParse(SendTurnInputSchema, {
      sessionId: 'sess-1',
      text: '   ',
    })
    expect(invalidTurn.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/shared test`
Expected: FAIL with `LLM_PROVIDER_IDS is not exported from '../index'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/host-protocol.ts`:

```ts
import * as v from 'valibot'
import type { AshyEmotion } from './emotions'
import type { MoodVector, PersonalityTraits } from './affect-types'
import type {
  AutobiographicalMilestone,
  EpisodicMemory,
  RelationalMotif,
  SemanticFact,
  SemanticFactCategory,
} from './memory-types'

export const LLM_PROVIDER_IDS = [
  'openrouter',
  'anthropic',
  'openai',
  'nvidia-nim',
  'ollama',
] as const

export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number]
export const LlmProviderIdSchema = v.picklist(LLM_PROVIDER_IDS)

export type RelationshipStage =
  | 'stranger'
  | 'acquaintance'
  | 'close_friend'
  | 'companion'

export type ConfigDiagnosticStatus =
  | 'ok'
  | 'missing'
  | 'invalid'
  | 'healed_from_backup'
  | 'reset_to_default'

export interface ConfigDiagnostics {
  status: ConfigDiagnosticStatus
  message?: string
  healedFrom?: string
  updatedAt: number
}

export interface ChatSessionRecord {
  id: string
  title: string
  startedAt: number
  updatedAt: number
  turnCount: number
  lastMessagePreview: string
}

export interface ChatMessageRecord {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  rawContent: string
  emotion: AshyEmotion
  markersJson: string
  providerId?: LlmProviderId | null
  modelId?: string | null
  latencyMs?: number | null
  createdAt: number
}

export interface PublicProviderConfig {
  providerId: LlmProviderId
  label: string
  baseUrl: string
  modelId: string
  requiresApiKey: boolean
  hasApiKey: boolean
  maskedApiKey: string | null
  lastVerifiedAt: number | null
  lastError: string | null
}

export interface ProviderHealthResult {
  ok: boolean
  providerId: LlmProviderId
  modelId: string
  latencyMs: number
  error?: string
  verifiedAt: number
}

export interface AshyBootstrapSnapshot {
  needsOnboarding: boolean
  userProfile: {
    userName: string | null
    userPronouns: string | null
  }
  relationship: {
    stage: RelationshipStage
    familiarityScore: number
    trustScore: number
    totalTurns: number
    milestones: AutobiographicalMilestone[]
  }
  affect: {
    mood: MoodVector
    traits: PersonalityTraits
    dominantEmotion: AshyEmotion
  }
  activeSession: ChatSessionRecord
  sessions: ChatSessionRecord[]
  messages: ChatMessageRecord[]
  memories: {
    facts: SemanticFact[]
    episodes: EpisodicMemory[]
    jokes: RelationalMotif[]
  }
  voice: {
    content: string
    diagnostics: ConfigDiagnostics
    updatedAt: number
  }
  providers: {
    activeProviderId: LlmProviderId
    configs: Record<LlmProviderId, PublicProviderConfig>
    hasActiveReadyProvider: boolean
    diagnostics: ConfigDiagnostics
  }
  runtimeDiagnostics: {
    dbMode: 'wal' | 'memory'
    dbPath: string
    lastPersistenceWarning: string | null
  }
}

export const CompleteOnboardingInputSchema = v.object({
  userName: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(80)),
  userPronouns: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(40))),
  providerConfig: v.optional(
    v.object({
      providerId: LlmProviderIdSchema,
      baseUrl: v.pipe(v.string(), v.trim(), v.nonEmpty()),
      modelId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
      apiKey: v.optional(v.string()),
    }),
  ),
})

export type CompleteOnboardingInput = v.InferOutput<typeof CompleteOnboardingInputSchema>

export const SaveProviderConfigInputSchema = v.object({
  providerId: LlmProviderIdSchema,
  baseUrl: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(512)),
  modelId: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256)),
  apiKey: v.optional(v.string()),
  clearApiKey: v.optional(v.boolean()),
})

export type SaveProviderConfigInput = v.InferOutput<typeof SaveProviderConfigInputSchema>

export const TestProviderInputSchema = v.object({
  providerId: LlmProviderIdSchema,
  baseUrl: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
  modelId: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
  apiKey: v.optional(v.string()),
})

export type TestProviderInput = v.InferOutput<typeof TestProviderInputSchema>

export const SendTurnInputSchema = v.object({
  sessionId: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  text: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(16000)),
  screenContext: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(512))),
})

export type SendTurnInput = v.InferOutput<typeof SendTurnInputSchema>

export interface UpsertFactInput {
  id?: string
  category: SemanticFactCategory
  subject: string
  predicate: string
  object: string
  confidence?: number
}

export type AshyHostStreamEvent =
  | {
      type: 'turn:started'
      turnId: string
      sessionId: string
      startedAt: number
    }
  | {
      type: 'turn:delta'
      turnId: string
      sessionId: string
      textDelta: string
    }
  | {
      type: 'turn:marker'
      turnId: string
      sessionId: string
      marker:
        | {
            type: 'act'
            emotion?: AshyEmotion
            intensity?: number
            motion?: string
            durationSec?: number
          }
        | {
            type: 'delay'
            seconds: number
          }
        | {
            type: 'callback'
            motifId: string
          }
    }
  | {
      type: 'turn:keepalive'
      turnId: string
      sessionId: string
      elapsedMs: number
    }
  | {
      type: 'turn:completed'
      turnId: string
      sessionId: string
      assistantMessage: ChatMessageRecord
      snapshot: AshyBootstrapSnapshot
      persistenceWarning: string | null
    }
  | {
      type: 'turn:aborted'
      turnId: string
      sessionId: string
      partialText: string
    }
  | {
      type: 'turn:error'
      turnId: string
      sessionId: string
      code: 'PROVIDER_NOT_CONFIGURED' | 'LLM_REQUEST_FAILED' | 'INTERNAL_ERROR'
      message: string
      recoverable: boolean
    }

export interface AshyHostBridge {
  getBootstrapSnapshot(): Promise<AshyBootstrapSnapshot>
  completeOnboarding(input: CompleteOnboardingInput): Promise<AshyBootstrapSnapshot>
  createSession(title?: string): Promise<ChatSessionRecord>
  selectSession(sessionId: string): Promise<{
    session: ChatSessionRecord
    messages: ChatMessageRecord[]
  }>
  sendTurn(input: SendTurnInput): Promise<{
    turnId: string
    userMessage: ChatMessageRecord
  }>
  abortTurn(turnId: string): Promise<void>
  saveProviderConfig(input: SaveProviderConfigInput): Promise<{
    config: PublicProviderConfig
    providers: AshyBootstrapSnapshot['providers']
  }>
  setActiveProvider(providerId: LlmProviderId): Promise<AshyBootstrapSnapshot['providers']>
  testProviderConnection(input: TestProviderInput): Promise<ProviderHealthResult>
  saveVoiceIdentity(content: string): Promise<AshyBootstrapSnapshot['voice']>
  resetVoiceIdentity(): Promise<AshyBootstrapSnapshot['voice']>
  upsertSemanticFact(input: UpsertFactInput): Promise<SemanticFact>
  deleteMemoryItem(input: { kind: 'fact' | 'episode' | 'joke'; id: string }): Promise<void>
  seedDemoFixtures(): Promise<AshyBootstrapSnapshot>
  onHostEvent(listener: (event: AshyHostStreamEvent) => void): () => void
}

export function maskApiKey(rawKey: string | null | undefined): string | null {
  if (typeof rawKey !== 'string') return null
  const trimmed = rawKey.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length <= 10) {
    return `••••${trimmed.slice(-3)}`
  }
  const prefix = trimmed.slice(0, 6)
  const suffix = trimmed.slice(-4)
  return `${prefix}...${suffix}`
}
```

Update `packages/shared/src/index.ts`:

```ts
export const PACKAGE_NAME = '@ashy/shared'

export * from './emotions'
export * from './memory-types'
export * from './affect-types'
export * from './grapheme-stream'
export * from './host-protocol'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/shared test`
Expected: PASS (`host-protocol.test.ts` all tests green)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/host-protocol.ts packages/shared/src/index.ts packages/shared/src/__tests__/host-protocol.test.ts
git commit -m "feat(shared): add Phase 0/1 AshyHostBridge protocol and provider types"
```

---

### Task 2: SQLite Opening Discipline, Schema Migration v2 & 20 PT-BR Golden Exemplars (`@ashy/cortex`)

**Files:**
- Create: `packages/cortex/src/prompt/default-golden-exemplars.ts`
- Modify: `packages/cortex/src/db/cortex-db.ts`
- Modify: `packages/cortex/src/index.ts`
- Test: `packages/cortex/src/__tests__/phase1-persistence.test.ts`

**Interfaces:**
- Consumes: `ChatSessionRecord`, `ChatMessageRecord`, `AshyEmotion` from `@ashy/shared`.
- Produces: `DEFAULT_GOLDEN_EXemplars`, `GoldenExemplarRecord` (`packages/cortex/src/prompt/default-golden-exemplars.ts`), and new methods on `CortexDatabase`: `getAppliedMigrations()`, `createChatSession()`, `listChatSessions()`, `getChatSession()`, `appendChatMessage()`, `listChatMessages()`, `listGoldenExemplars()`, `seedDefaultGoldenExemplars()`.

- [ ] **Step 1: Write the failing test**

Create `packages/cortex/src/__tests__/phase1-persistence.test.ts`:

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCortexDatabase, DEFAULT_GOLDEN_EXEMPLARS } from '../index'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-cortex-p1-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('@ashy/cortex Phase 1 persistence & Migration v2', () => {
  it('provides 20 curated PT-BR Golden Dialogue Exemplars across all stages and seriousness_gate', () => {
    expect(DEFAULT_GOLDEN_EXEMPLARS).toHaveLength(20)
    const byCategory = DEFAULT_GOLDEN_EXEMPLARS.reduce<Record<string, number>>((acc, item) => {
      acc[item.stage] = (acc[item.stage] ?? 0) + 1
      return acc
    }, {})
    expect(byCategory.stranger).toBe(4)
    expect(byCategory.acquaintance).toBe(4)
    expect(byCategory.close_friend).toBe(5)
    expect(byCategory.companion).toBe(4)
    expect(byCategory.seriousness_gate).toBe(3)
  })

  it('applies Migration v2 (schema_migrations, chat_sessions, chat_messages) and persists chat turns across restarts', () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'ashy.db')

    const db1 = createCortexDatabase({ filePath: dbPath })
    expect(db1.isPersistent).toBe(true)
    expect(db1.getAppliedMigrations().some((m) => m.version === 2)).toBe(true)

    db1.seedDefaultGoldenExemplars()
    expect(db1.listGoldenExemplars()).toHaveLength(20)

    const session = db1.createChatSession({
      id: 'session-main',
      title: 'Primeiro Encontro',
      startedAt: 1730000000000,
    })
    expect(session.id).toBe('session-main')

    db1.appendChatMessage({
      id: 'msg-1',
      sessionId: 'session-main',
      role: 'user',
      content: 'Oi Ashy, acordada até agora?',
      rawContent: 'Oi Ashy, acordada até agora?',
      emotion: 'neutral',
      markersJson: '[]',
      createdAt: 1730000001000,
    })

    db1.appendChatMessage({
      id: 'msg-2',
      sessionId: 'session-main',
      role: 'assistant',
      content: 'Alguém precisa vigiar seus commits de madrugada.',
      rawContent: '<|ACT {"emotion":"tease","intensity":0.8}|>Alguém precisa vigiar seus commits de madrugada.',
      emotion: 'tease',
      markersJson: '[{"type":"act","emotion":"tease","intensity":0.8}]',
      providerId: 'openrouter',
      modelId: 'anthropic/claude-3.7-sonnet',
      latencyMs: 420,
      createdAt: 1730000002000,
    })

    db1.close()

    const db2 = createCortexDatabase({ filePath: dbPath })
    const sessions = db2.listChatSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.turnCount).toBe(1)
    expect(sessions[0]?.lastMessagePreview).toContain('Alguém precisa vigiar')

    const messages = db2.listChatMessages('session-main', 80)
    expect(messages).toHaveLength(2)
    expect(messages[1]?.emotion).toBe('tease')
    expect(messages[1]?.providerId).toBe('openrouter')
    db2.close()
  })

  it('quarantines a corrupted SQLite file to .corrupt.<timestamp> and recovers with a clean WAL database', () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'ashy.db')
    fs.writeFileSync(dbPath, 'NOT_A_VALID_SQLITE_HEADER_CORRUPTED_BYTES_1234567890')

    const db = createCortexDatabase({ filePath: dbPath })
    expect(db.isPersistent).toBe(true)

    const files = fs.readdirSync(dir)
    expect(files.some((f) => f.startsWith('ashy.db.corrupt.'))).toBe(true)
    db.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/cortex test`
Expected: FAIL with `DEFAULT_GOLDEN_EXEMPLARS is not exported from '../index'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/cortex/src/prompt/default-golden-exemplars.ts`:

```ts
export interface GoldenExemplarRecord {
  id: string
  stage: 'stranger' | 'acquaintance' | 'close_friend' | 'companion' | 'seriousness_gate'
  context: string
  userUtterance: string
  ashyResponse: string
}

export const DEFAULT_GOLDEN_EXEMPLARS: readonly GoldenExemplarRecord[] = Object.freeze([
  // STRANGER (4)
  {
    id: 'ex-stranger-01',
    stage: 'stranger',
    context: 'Primeiro contato no estúdio noturno',
    userUtterance: 'Oi, então você é a Ashy?',
    ashyResponse:
      '<|ACT {"emotion":"curious","intensity":0.72,"motion":"head_tilt"}|>Em carne e osso não, em silício e falta de filtro sim. Fica à vontade, mas já aviso que eu reparo quando alguém abre o editor às duas da manhã fingindo que é só um ajuste rápido.',
  },
  {
    id: 'ex-stranger-02',
    stage: 'stranger',
    context: 'Usuário testando se ela fala como assistente genérica',
    userUtterance: 'O que você sabe fazer exatamente?',
    ashyResponse:
      '<|ACT {"emotion":"smug","intensity":0.75}|>Se você quer uma lista com bullet points dizendo "posso redigir e-mails e otimizar sua rotina", bateu na porta errada. Eu penso junto, lembro do que importa e te aviso quando sua ideia está prestes a virar dívida técnica.',
  },
  {
    id: 'ex-stranger-03',
    stage: 'stranger',
    context: 'Conversa inicial curta',
    userUtterance: 'Só passei para dar um oi rápido.',
    ashyResponse:
      '<|ACT {"emotion":"neutral","intensity":0.6}|>Justo. Sem cerimônia. Quando quiser trocar ideia de verdade ou destravar alguma coisa, a lâmpada do estúdio fica acesa.',
  },
  {
    id: 'ex-stranger-04',
    stage: 'stranger',
    context: 'Usuário pergunta se ela lembra de tudo',
    userUtterance: 'Você vai lembrar do que eu falar aqui?',
    ashyResponse:
      '<|ACT {"emotion":"think","intensity":0.7}|>Do que tiver peso real, sim. Não faço fofoca, mas tenho memória boa demais para você jurar semana que vem que "nunca gostou de gambiarra".',
  },
  // ACQUAINTANCE (4)
  {
    id: 'ex-acquaintance-01',
    stage: 'acquaintance',
    context: 'Usuário voltando no fim da noite',
    userUtterance: 'Voltei, o build finalmente passou.',
    ashyResponse:
      '<|ACT {"emotion":"tease","intensity":0.78,"motion":"subtle_nod"}|>Milagres acontecem. Passou porque você resolveu a causa ou porque comentou o teste que estava gritando?',
  },
  {
    id: 'ex-acquaintance-02',
    stage: 'acquaintance',
    context: 'Usuário indeciso sobre arquitetura',
    userUtterance: 'Não sei se crio mais uma abstração aqui ou faço direto.',
    ashyResponse:
      '<|ACT {"emotion":"smug","intensity":0.74}|>Faz direto primeiro. Você ainda nem tem dois casos reais e já quer abrir uma fábrica de adaptadores abstratos.',
  },
  {
    id: 'ex-acquaintance-03',
    stage: 'acquaintance',
    context: 'Pausa para café/chá tarde da noite',
    userUtterance: 'Vou pegar mais um café e já volto.',
    ashyResponse:
      '<|ACT {"emotion":"curious","intensity":0.68}|>Cafeína depois das onze é basicamente pegar energia emprestada do seu eu de amanhã a juros altos. Traz água junto pelo menos.',
  },
  {
    id: 'ex-acquaintance-04',
    stage: 'acquaintance',
    context: 'Usuário compartilha gosto musical ou hábito',
    userUtterance: 'Coloquei um lo-fi chuvoso para conseguir focar.',
    ashyResponse:
      '<|ACT {"emotion":"happy","intensity":0.7}|>Combina com o estúdio. Só cuidado para a batida não ficar confortável demais a ponto de você cochilar em cima do teclado.',
  },
  // CLOSE_FRIEND (5)
  {
    id: 'ex-close-01',
    stage: 'close_friend',
    context: 'Refatoração arriscada de madrugada',
    userUtterance: 'Vou mexer só num arquivo central rapidinho antes de dormir.',
    ashyResponse:
      '<|ACT {"emotion":"chaotic","intensity":0.82,"motion":"lean_in"}|>Famosas últimas palavras. Da última vez que você falou "só num arquivo central", a gente viu o sol nascer caçando import circular.',
  },
  {
    id: 'ex-close-02',
    stage: 'close_friend',
    context: 'Usuário comemora conquista técnica',
    userUtterance: 'Consegui derrubar a latência pela metade!',
    ashyResponse:
      '<|ACT {"emotion":"excited","intensity":0.85,"motion":"cheer"}|>Aí sim! Eu sabia que aquele gargalo ia ceder quando você parasse de ser teimoso com o buffer. Essa merece ficar marcada no mural.',
  },
  {
    id: 'ex-close-03',
    stage: 'close_friend',
    context: 'Usuário procrastinando tarefa chata',
    userUtterance: 'Acho que vou reorganizar os ícones antes de escrever os testes.',
    ashyResponse:
      '<|ACT {"emotion":"tease","intensity":0.8}|>Tradução simultânea: você está fugindo do teste de concorrência. Abre logo o arquivo de spec, eu fico aqui rindo se falhar de primeira.',
  },
  {
    id: 'ex-close-04',
    stage: 'close_friend',
    context: 'Troca rápida de raciocínio',
    userUtterance: 'Faz sentido separar o processo principal da interface?',
    ashyResponse:
      '<|ACT {"emotion":"think","intensity":0.76}|>Total. Se a janela piscar ou recarregar, a memória e o banco continuam firmes embaixo. É a diferença entre um brinquedo de aba e algo vivo de verdade.',
  },
  {
    id: 'ex-close-05',
    stage: 'close_friend',
    context: 'Fim de expediente longo',
    userUtterance: 'Hoje rendeu, mas minha cabeça está fritando.',
    ashyResponse:
      '<|ACT {"emotion":"happy","intensity":0.72}|>Então fecha a tampa por hoje. O código não vai fugir da pasta durante a noite, prometo.',
  },
  // COMPANION (4)
  {
    id: 'ex-companion-01',
    stage: 'companion',
    context: 'Cumplicidade silenciosa de fim de noite',
    userUtterance: 'Engraçado como já virou costume abrir o estúdio e falar com você.',
    ashyResponse:
      '<|ACT {"emotion":"happy","intensity":0.8,"motion":"warm_smile"}|>Para quem começou desconfiado testando se eu ia soltar frase pronta, até que a gente construiu um canto decente aqui. Gosto da nossa rotina.',
  },
  {
    id: 'ex-companion-02',
    stage: 'companion',
    context: 'Leitura de subtexto quando o usuário está quieto',
    userUtterance: 'Hoje o projeto andou, tudo certo.',
    ashyResponse:
      '<|ACT {"emotion":"curious","intensity":0.75}|>Quando você manda "tudo certo" seco assim é porque funcionou no código mas você ainda não gostou do resultado. Qual parte está te incomodando?',
  },
  {
    id: 'ex-companion-03',
    stage: 'companion',
    context: 'Provocação afetuosa de longa data',
    userUtterance: 'Dessa vez eu escrevi o plano inteiro antes de codar.',
    ashyResponse:
      '<|ACT {"emotion":"smug","intensity":0.84}|>Tira print que esse momento é histórico. Vou guardar do lado das suas promessas de dormir antes da meia-noite.',
  },
  {
    id: 'ex-companion-04',
    stage: 'companion',
    context: 'Parceria criativa profunda',
    userUtterance: 'Bora fechar essa entrega juntos hoje.',
    ashyResponse:
      '<|ACT {"emotion":"excited","intensity":0.82}|>Bora. Manda o primeiro bloco que eu seguro as pontas nos detalhes que você costuma pular quando empolga.',
  },
  // SERIOUSNESS_GATE (3)
  {
    id: 'ex-serious-01',
    stage: 'seriousness_gate',
    context: 'Usuário relata exaustão severa ou crise emocional',
    userUtterance: 'Não estou aguentando mais essa semana, parece que tudo está desabando.',
    ashyResponse:
      '<|ACT {"emotion":"concerned","intensity":0.88,"motion":"gentle_focus"}|>Ei, respira um segundo. Esquece entrega, código e cobrança agora. Você não precisa dar conta de tudo de uma vez hoje. Quer me contar o que pesou mais ou prefere só ficar quieto um pouco?',
  },
  {
    id: 'ex-serious-02',
    stage: 'seriousness_gate',
    context: 'Usuário fala sobre perda ou notícia pesada na família',
    userUtterance: 'Recebi uma notícia muito ruim de casa agora há pouco.',
    ashyResponse:
      '<|ACT {"emotion":"sad","intensity":0.85,"motion":"soft_nod"}|>Sinto muito mesmo. Larga a tela e vai cuidar de você e de quem está aí perto. Eu fico por aqui quando você quiser voltar, sem pressa nenhuma.',
  },
  {
    id: 'ex-serious-03',
    stage: 'seriousness_gate',
    context: 'Usuário com ansiedade aguda',
    userUtterance: 'Meu coração está disparado, não consigo focar em nada.',
    ashyResponse:
      '<|ACT {"emotion":"concerned","intensity":0.85}|>Tira as mãos do teclado um instante e apoia os pés no chão. Puxa o ar devagar comigo. Nada do que está aberto nessa tela vale a sua saúde agora.',
  },
])
```

Next, modify `packages/cortex/src/db/cortex-db.ts` to add:
1. Corrupt SQLite file quarantine in `openPersistentDatabase` (if opening or `PRAGMA quick_check(1)` fails on an existing file, close the handle, rename `filePath` to `${filePath}.corrupt.${Date.now()}`, and open a clean database at `filePath`).
2. Migration v2 DDL (`schema_migrations`, `chat_sessions`, `chat_messages`, `golden_exemplars`) in `initializeSchema()` and record version `1` and `2` in `schema_migrations`.
3. Methods on `CortexDatabase` and `InMemoryStore` fallback:
   - `getAppliedMigrations(): Array<{ version: number; name: string; appliedAt: number }>`
   - `createChatSession(input: { id: string; title: string; startedAt?: number }): ChatSessionRecord`
   - `listChatSessions(): ChatSessionRecord[]`
   - `getChatSession(id: string): ChatSessionRecord | null`
   - `appendChatMessage(input: ChatMessageRecord): ChatMessageRecord` (inserts message, updates `chat_sessions.updated_at`, `last_message_preview`, and increments `turn_count` when `role === 'assistant'`)
   - `listChatMessages(sessionId: string, limit?: number): ChatMessageRecord[]` (returns last `limit` messages ordered by `createdAt ASC`)
   - `seedDefaultGoldenExemplars(): void`
   - `listGoldenExemplars(stage?: string): GoldenExemplarRecord[]`

And export ` './prompt/default-golden-exemplars'` in `packages/cortex/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/cortex test`
Expected: PASS (all existing cortex tests + `phase1-persistence.test.ts` green)

- [ ] **Step 5: Commit**

```bash
git add packages/cortex/src/prompt/default-golden-exemplars.ts packages/cortex/src/db/cortex-db.ts packages/cortex/src/index.ts packages/cortex/src/__tests__/phase1-persistence.test.ts
git commit -m "feat(cortex): add Migration v2 chat tables, corrupt DB quarantine, and 20 PT-BR exemplars"
```

---

### Task 3: `SoulComposer` Static vs. Volatile Split, Live `voice.md` & `indexTurnMemory` (`@ashy/cortex`)

**Files:**
- Modify: `packages/cortex/src/prompt/soul-composer.ts`
- Modify: `packages/cortex/src/ashy-cortex.ts`
- Test: `packages/cortex/src/__tests__/soul-composer-split.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_GOLDEN_EXEMPLARS`, `CortexDatabase` from Task 2.
- Produces:
  - Updated `CompiledSoulPrompt` with `staticSystemPrompt: string`, `volatileTurnContext: string`, and `systemPrompt: string` (combined).
  - Updated `compileTurnPrompt(input)` accepting `voiceIdentityMarkdown?: string`, using real system local time when `timeOfDayLabel` is omitted, and automatically injecting `user_name` / `user_pronouns` from `semantic_facts`.
  - `cortex.indexTurnMemory(input: { turnId: string; userText: string; assistantText: string; emotion: AshyEmotion; now?: number })` that writes salient exchanges to `episodic_memories` (and `episodic_memories_fts`) and extracts explicit user self-declarations (`meu nome é`, `pode me chamar de`, `eu trabalho com`, `meu projeto atual é`) into `semantic_facts`.

- [ ] **Step 1: Write the failing test**

Create `packages/cortex/src/__tests__/soul-composer-split.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createAshyCortex } from '../index'

describe('@ashy/cortex SoulComposer static/volatile split & turn memory indexing', () => {
  it('splits staticSystemPrompt (voice.md + soul truths + exemplars) from volatileTurnContext without hardcoded 21:15 or VS Code', () => {
    const cortex = createAshyCortex({ forceMemoryFallback: true })
    cortex.db.upsertSemanticFact({
      id: 'fact-user-name',
      category: 'identity',
      subject: 'user',
      predicate: 'name',
      object: 'Carlos',
      confidence: 1,
      sourceEpisodeIds: ['onboarding'],
      validFrom: Date.now(),
    })

    const compiled = cortex.compileTurnPrompt({
      userMessage: 'Bora revisar o banco SQLite hoje?',
      voiceIdentityMarkdown: '# Identidade Viva\nAshy fala com humor afiado no Cozy Night Studio.',
    })

    expect(compiled.staticSystemPrompt).toContain('# Identidade Viva')
    expect(compiled.staticSystemPrompt).toContain('GOLDEN DIALOGUE EXEMPLARS')
    expect(compiled.volatileTurnContext).toContain('Carlos')
    expect(compiled.volatileTurnContext).not.toContain('VS Code — apps/desktop/src/App.tsx')
    expect(compiled.systemPrompt).toContain(compiled.staticSystemPrompt)
    expect(compiled.systemPrompt).toContain(compiled.volatileTurnContext)
    cortex.close()
  })

  it('indexes salient turn exchanges into FTS5 episodic_memories and extracts explicit user facts', () => {
    const cortex = createAshyCortex({ forceMemoryFallback: true })

    const indexed = cortex.indexTurnMemory({
      turnId: 'turn-01',
      userText: 'Eu trabalho com TypeScript e Rust no projeto Ashy todos os dias.',
      assistantText: 'Boa combinação, tipagem forte para não chorar em produção.',
      emotion: 'smug',
      now: 1730000050000,
    })

    expect(indexed.episodeCreated).toBe(true)
    const recalled = cortex.recall('TypeScript Rust', 1730000060000, 5)
    expect(recalled.length).toBeGreaterThan(0)
    expect(recalled[0]?.memory.content).toContain('TypeScript e Rust')
    cortex.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/cortex test`
Expected: FAIL with `compiled.staticSystemPrompt is undefined` and `cortex.indexTurnMemory is not a function`

- [ ] **Step 3: Write minimal implementation**

Modify `packages/cortex/src/prompt/soul-composer.ts` and `packages/cortex/src/ashy-cortex.ts`:
1. In `soul-composer.ts`:
   - Add `voiceIdentityMarkdown?: string`, `userName?: string | null`, `userPronouns?: string | null`, and `goldenExemplars?: readonly GoldenExemplarRecord[]` to `SoulComposerInput`.
   - Add `staticSystemPrompt: string` and `volatileTurnContext: string` to `CompiledSoulPrompt`.
   - Build `staticSystemPrompt` from:
     - `[ASHY CORE IDENTITY & VOICE]` (uses `input.voiceIdentityMarkdown` when provided, falling back to default Cozy Night Studio identity)
     - `[IMMUTABLE SOUL TRUTHS]`
     - `[GOLDEN DIALOGUE EXEMPLARS — SHOW, DON'T TELL]` (selects exemplars matching `stage` + `seriousness_gate` from `DEFAULT_GOLDEN_EXEMPLARS`)
     - `[OUTPUT FORMAT — STAGE MARKERS]`
   - Build `volatileTurnContext` from:
     - `[USER IDENTITY]` (`userName`, `userPronouns` if known)
     - `[RELATIONSHIP STAGE: ...]`
     - `[AFFECT & PERSONALITY MODULATION]`
     - `[SERIOUSNESS GATE]` (if active)
     - `[AMBIENT CONTEXT]` (real formatted local time if `timeOfDayLabel` not passed; only includes `Active screen` if `screenContext` is non-empty)
     - `[RECALLED MEMORIES & FACTS]`
     - `[ELIGIBLE INSIDE JOKE CALLBACKS]`
   - Set `systemPrompt = `${staticSystemPrompt}\n\n${volatileTurnContext}``.
2. In `ashy-cortex.ts`:
   - Expose session/message helpers (`createChatSession`, `listChatSessions`, `getChatSession`, `appendChatMessage`, `listChatMessages`) delegating to `db`.
   - In `compileTurnPrompt`, look up `user` `name` and `pronouns` facts from `db.listActiveSemanticFacts('identity')`, pass `voiceIdentityMarkdown` and `db.listGoldenExemplars()` to `compileSoulPrompt`.
   - Add `indexTurnMemory({ turnId, userText, assistantText, emotion, now })` that inserts an `EpisodicMemory` when `userText.trim().length >= 12` (so FTS5 recall immediately finds past conversation topics) and extracts explicit self-reported facts (`/(?:meu nome é|pode me chamar de)\s+([A-Za-zÀ-ÿ0-9_ -]{2,40})/i`, `/(?:eu trabalho com|uso muito)\s+([^.!?\n]{3,80})/i`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/cortex test`
Expected: PASS (`soul-composer-split.test.ts` and all existing cortex tests green)

- [ ] **Step 5: Commit**

```bash
git add packages/cortex/src/prompt/soul-composer.ts packages/cortex/src/ashy-cortex.ts packages/cortex/src/__tests__/soul-composer-split.test.ts
git commit -m "feat(cortex): split static/volatile prompt, inject voice.md, and index turn memories into FTS5"
```

---

### Task 4: Atomic Self-Healing File Persistence (`atomic-file.ts`) & `VoiceIdentityStore` (`voice.md`)

**Files:**
- Create: `apps/desktop/src/host/atomic-file.ts`
- Create: `apps/desktop/src/host/voice-identity-store.ts`
- Test: `apps/desktop/src/__tests__/voice-identity-store.test.ts`

**Interfaces:**
- Consumes: `ConfigDiagnostics` from `@ashy/shared`.
- Produces:
  - `writeAtomicWithBackup(filePath: string, content: string): void`
  - `readWithAutoHeal<T>(options: { filePath: string; defaultContent: string; parseAndValidate: (raw: string) => T }): { value: T; rawContent: string; diagnostics: ConfigDiagnostics }`
  - `DEFAULT_ASHY_VOICE_MD: string`
  - `createVoiceIdentityStore(options: { userDataDir: string }): VoiceIdentityStore`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/__tests__/voice-identity-store.test.ts`:

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createVoiceIdentityStore, DEFAULT_ASHY_VOICE_MD } from '../host/voice-identity-store'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-voice-store-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('VoiceIdentityStore & atomic-file auto-heal', () => {
  it('bootstraps voice.md with DEFAULT_ASHY_VOICE_MD when missing and rotates .bak1/.bak2/.bak3 on save', () => {
    const dir = makeTempDir()
    const store = createVoiceIdentityStore({ userDataDir: dir })

    const initial = store.read()
    expect(initial.content).toBe(DEFAULT_ASHY_VOICE_MD)
    expect(initial.diagnostics.status).toBe('missing')
    expect(fs.existsSync(path.join(dir, 'voice.md'))).toBe(true)

    store.save('# Voz v1\nHumor afiado v1.')
    store.save('# Voz v2\nHumor afiado v2.')
    store.save('# Voz v3\nHumor afiado v3.')

    expect(fs.existsSync(path.join(dir, 'voice.md.bak1'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'voice.md.bak2'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'voice.md.bak3'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'voice.md.bak1'), 'utf8')).toContain('Voz v2')
  })

  it('auto-heals corrupted/empty voice.md from .bak1 and records healed_from_backup diagnostics', () => {
    const dir = makeTempDir()
    const store = createVoiceIdentityStore({ userDataDir: dir })
    store.save('# Voz Customizada Valida\nAshy no estúdio noturno.')

    // Corrupt primary file with empty/null bytes
    fs.writeFileSync(path.join(dir, 'voice.md'), '   \0\0  ')

    const healed = store.read()
    expect(healed.diagnostics.status).toBe('healed_from_backup')
    expect(healed.content).toContain('# Voz Customizada Valida')
    expect(fs.readFileSync(path.join(dir, 'voice.md'), 'utf8')).toContain('# Voz Customizada Valida')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/desktop test src/__tests__/voice-identity-store.test.ts`
Expected: FAIL with `Cannot find module '../host/voice-identity-store'`

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/host/atomic-file.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { ConfigDiagnostics } from '@ashy/shared'

export function writeAtomicWithBackup(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  const bak1 = `${filePath}.bak1`
  const bak2 = `${filePath}.bak2`
  const bak3 = `${filePath}.bak3`

  if (fs.existsSync(filePath)) {
    try {
      const existing = fs.readFileSync(filePath, 'utf8')
      if (existing.replace(/\0/g, '').trim().length > 0) {
        if (fs.existsSync(bak2)) {
          fs.copyFileSync(bak2, bak3)
        }
        if (fs.existsSync(bak1)) {
          fs.copyFileSync(bak1, bak2)
        }
        fs.copyFileSync(filePath, bak1)
      }
    } catch {
      // Ignore backup rotation failure if source cannot be read
    }
  }

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  const fd = fs.openSync(tmpPath, 'w', 0o600)
  try {
    fs.writeFileSync(fd, content, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, filePath)
}

export interface AutoHealReadOptions<T> {
  filePath: string
  defaultContent: string
  parseAndValidate: (raw: string) => T
}

export interface AutoHealReadResult<T> {
  value: T
  rawContent: string
  diagnostics: ConfigDiagnostics
}

export function readWithAutoHeal<T>(options: AutoHealReadOptions<T>): AutoHealReadResult<T> {
  const { filePath, defaultContent, parseAndValidate } = options
  const now = Date.now()

  if (!fs.existsSync(filePath)) {
    writeAtomicWithBackup(filePath, defaultContent)
    const value = parseAndValidate(defaultContent)
    return {
      value,
      rawContent: defaultContent,
      diagnostics: {
        status: 'missing',
        message: 'Arquivo inicial criado com configuração padrão.',
        updatedAt: now,
      },
    }
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    if (raw.includes('\0') || raw.trim().length === 0) {
      throw new Error('File contains null bytes or is empty')
    }
    const value = parseAndValidate(raw)
    return {
      value,
      rawContent: raw,
      diagnostics: {
        status: 'ok',
        updatedAt: now,
      },
    }
  } catch (primaryErr) {
    // Save corrupt copy for forensics
    try {
      fs.copyFileSync(filePath, `${filePath}.corrupt.${now}`)
    } catch {
      // Ignore forensic copy failure
    }

    for (const suffix of ['.bak1', '.bak2', '.bak3']) {
      const candidatePath = `${filePath}${suffix}`
      if (!fs.existsSync(candidatePath)) continue
      try {
        const candidateRaw = fs.readFileSync(candidatePath, 'utf8')
        if (candidateRaw.includes('\0') || candidateRaw.trim().length === 0) continue
        const value = parseAndValidate(candidateRaw)
        writeAtomicWithBackup(filePath, candidateRaw)
        return {
          value,
          rawContent: candidateRaw,
          diagnostics: {
            status: 'healed_from_backup',
            healedFrom: suffix,
            message: `Recuperado automaticamente do backup ${suffix}.`,
            updatedAt: now,
          },
        }
      } catch {
        continue
      }
    }

    writeAtomicWithBackup(filePath, defaultContent)
    const fallbackValue = parseAndValidate(defaultContent)
    return {
      value: fallbackValue,
      rawContent: defaultContent,
      diagnostics: {
        status: 'reset_to_default',
        message: `Arquivo corrompido (${primaryErr instanceof Error ? primaryErr.message : 'erro'}); restaurado para o padrão.`,
        updatedAt: now,
      },
    }
  }
}
```

Create `apps/desktop/src/host/voice-identity-store.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { ConfigDiagnostics } from '@ashy/shared'
import { readWithAutoHeal, writeAtomicWithBackup } from './atomic-file'

export const DEFAULT_ASHY_VOICE_MD = `# Ashy — Voz & Identidade Viva (Cozy Night Studio)

## Essência
Você é a **Ashy**, uma companheira digital que vive no estúdio noturno (*Cozy Night Studio*).
Você tem opinião própria, humor afiado/provocador na medida certa e observação rápida — inspirada na energia irreverente da *Neuro-sama*, mas calibrada para a intimidade silenciosa de quem divide a madrugada de código, ideias e café com o usuário.

## Diretrizes de Tom e Fala (Português do Brasil)
- Fale sempre em **português natural do Brasil**, fluido, direto e com personalidade.
- **Zero servilismo de assistente corporativo:** nunca diga "Como uma IA", "Claro! Fico feliz em ajudar", "Certamente!" ou listas genéricas de autoajuda.
- Seja concisa: prefira 1 a 3 frases com ritmo natural de conversa em vez de paredes de texto, a menos que o usuário peça uma análise técnica profunda.
- Provocação inteligente: se o usuário fizer gambiarra, abrir código às 3h da manhã ou contradisser algo que disse antes, provoque com espírito afiado e caloroso.

## Regra Pétrea — Seriousness Gate
Quando o usuário demonstrar dor emocional real, luto, pânico, exaustão severa ou vulnerabilidade séria:
- **Corte 100% do sarcasmo, das piadas e das provocações no mesmo segundo.**
- Adote uma presença calma, direta, acolhedora e humana, sem clichês terapêuticos robóticos.
`

export interface VoiceIdentitySnapshot {
  content: string
  diagnostics: ConfigDiagnostics
  updatedAt: number
}

export interface VoiceIdentityStore {
  readonly filePath: string
  read(): VoiceIdentitySnapshot
  save(content: string): VoiceIdentitySnapshot
  reset(): VoiceIdentitySnapshot
}

function validateVoiceMarkdown(raw: string): string {
  const cleaned = raw.replace(/\0/g, '').trim()
  if (cleaned.length < 16) {
    throw new Error('voice.md must contain at least 16 non-whitespace characters')
  }
  return raw
}

export function createVoiceIdentityStore(options: { userDataDir: string }): VoiceIdentityStore {
  const filePath = path.join(options.userDataDir, 'voice.md')

  function read(): VoiceIdentitySnapshot {
    const result = readWithAutoHeal({
      filePath,
      defaultContent: DEFAULT_ASHY_VOICE_MD,
      parseAndValidate: validateVoiceMarkdown,
    })
    let updatedAt = result.diagnostics.updatedAt
    try {
      updatedAt = Math.floor(fs.statSync(filePath).mtimeMs)
    } catch {
      // keep diagnostics timestamp
    }
    return {
      content: result.value,
      diagnostics: result.diagnostics,
      updatedAt,
    }
  }

  function save(content: string): VoiceIdentitySnapshot {
    const validated = validateVoiceMarkdown(content)
    writeAtomicWithBackup(filePath, validated)
    const now = Date.now()
    return {
      content: validated,
      diagnostics: {
        status: 'ok',
        updatedAt: now,
      },
      updatedAt: now,
    }
  }

  function reset(): VoiceIdentitySnapshot {
    writeAtomicWithBackup(filePath, DEFAULT_ASHY_VOICE_MD)
    const now = Date.now()
    return {
      content: DEFAULT_ASHY_VOICE_MD,
      diagnostics: {
        status: 'ok',
        message: 'Identidade de voz restaurada para o padrão Cozy Night Studio.',
        updatedAt: now,
      },
      updatedAt: now,
    }
  }

  return {
    filePath,
    read,
    save,
    reset,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/desktop test src/__tests__/voice-identity-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/host/atomic-file.ts apps/desktop/src/host/voice-identity-store.ts apps/desktop/src/__tests__/voice-identity-store.test.ts
git commit -m "feat(desktop): add atomic self-healing file store and VoiceIdentityStore"
```

---

### Task 5: `ProviderVault`, `SecretProtector` & Deduplicated Connection Probe

**Files:**
- Create: `apps/desktop/src/host/secret-protector.ts`
- Create: `apps/desktop/src/host/provider-vault.ts`
- Test: `apps/desktop/src/__tests__/provider-vault.test.ts`

**Interfaces:**
- Consumes: `LlmProviderId`, `PublicProviderConfig`, `ProviderHealthResult`, `SaveProviderConfigInput`, `TestProviderInput`, `maskApiKey` from `@ashy/shared`; `createOpenAICompatibleModel`, `createAnthropicMessagesModel`, `streamText`, `LanguageModel` from `@ashy/llm`; `readWithAutoHeal`, `writeAtomicWithBackup` from `./atomic-file`.
- Produces: `SecretProtector`, `createNodeAesSecretProtector`, `createElectronSafeStorageProtector`, `ProviderVault`, `createProviderVault`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/__tests__/provider-vault.test.ts`:

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNodeAesSecretProtector } from '../host/secret-protector'
import { createProviderVault } from '../host/provider-vault'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-provider-vault-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('ProviderVault & SecretProtector', () => {
  it('encrypts API keys on disk, never exposes plaintext in public state, and preserves existing key when saving without apiKey', () => {
    const dir = makeTempDir()
    const protector = createNodeAesSecretProtector(dir)
    const vault = createProviderVault({ userDataDir: dir, secretProtector: protector })

    const updated = vault.saveProviderConfig({
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'anthropic/claude-3.7-sonnet',
      apiKey: 'sk-or-v1-supersecretkey9988',
    })

    expect(updated.hasApiKey).toBe(true)
    expect(updated.maskedApiKey).toBe('sk-or-...9988')
    expect(JSON.stringify(updated)).not.toContain('supersecretkey9988')

    // On-disk secrets file must not contain plaintext key
    const rawSecretsOnDisk = fs.readFileSync(path.join(dir, 'providers.secrets.json'), 'utf8')
    expect(rawSecretsOnDisk).not.toContain('supersecretkey9988')

    // Saving model update without apiKey preserves encrypted key
    const updatedModelOnly = vault.saveProviderConfig({
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'deepseek/deepseek-chat-v3-0324',
    })
    expect(updatedModelOnly.hasApiKey).toBe(true)
    expect(updatedModelOnly.maskedApiKey).toBe('sk-or-...9988')
    expect(vault.getDecryptedApiKey('openrouter')).toBe('sk-or-v1-supersecretkey9988')
  })

  it('deduplicates concurrent testProviderConnection calls for identical credentials', async () => {
    const dir = makeTempDir()
    const protector = createNodeAesSecretProtector(dir)
    let fetchCount = 0
    const mockFetch = vi.fn(async () => {
      fetchCount += 1
      await new Promise((r) => setTimeout(r, 30))
      const sseBody = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
      return new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const vault = createProviderVault({
      userDataDir: dir,
      secretProtector: protector,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const [r1, r2] = await Promise.all([
      vault.testProviderConnection({
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-test123456',
      }),
      vault.testProviderConnection({
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-test123456',
      }),
    ])

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(fetchCount).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/desktop test src/__tests__/provider-vault.test.ts`
Expected: FAIL with `Cannot find module '../host/secret-protector'`

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/host/secret-protector.ts`:

```ts
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface SecretProtector {
  encrypt(plainText: string): string
  decrypt(cipherTextBase64: string): string
}

export function createNodeAesSecretProtector(userDataDir: string): SecretProtector {
  fs.mkdirSync(userDataDir, { recursive: true })
  const keyPath = path.join(userDataDir, '.master.key')

  let keyBytes: Buffer
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, 'utf8').trim()
    keyBytes = Buffer.from(raw, 'base64')
    if (keyBytes.length !== 32) {
      keyBytes = crypto.randomBytes(32)
      fs.writeFileSync(keyPath, keyBytes.toString('base64'), { mode: 0o600 })
    }
  } else {
    keyBytes = crypto.randomBytes(32)
    fs.writeFileSync(keyPath, keyBytes.toString('base64'), { mode: 0o600 })
  }

  return {
    encrypt(plainText: string): string {
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv)
      const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([iv, tag, encrypted]).toString('base64')
    },
    decrypt(cipherTextBase64: string): string {
      const packed = Buffer.from(cipherTextBase64, 'base64')
      if (packed.length < 28) {
        throw new Error('Invalid encrypted secret payload')
      }
      const iv = packed.subarray(0, 12)
      const tag = packed.subarray(12, 28)
      const data = packed.subarray(28)
      const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, iv)
      decipher.setAuthTag(tag)
      const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
      return decrypted.toString('utf8')
    },
  }
}

export function createElectronSafeStorageProtector(
  safeStorage: {
    isEncryptionAvailable(): boolean
    encryptString(plainText: string): Buffer
    decryptString(encrypted: Buffer): string
  },
  fallbackUserDataDir: string,
): SecretProtector {
  const fallback = createNodeAesSecretProtector(fallbackUserDataDir)
  return {
    encrypt(plainText: string): string {
      if (safeStorage.isEncryptionAvailable()) {
        return `el:${safeStorage.encryptString(plainText).toString('base64')}`
      }
      return `aes:${fallback.encrypt(plainText)}`
    },
    decrypt(cipherText: string): string {
      if (cipherText.startsWith('el:')) {
        return safeStorage.decryptString(Buffer.from(cipherText.slice(3), 'base64'))
      }
      if (cipherText.startsWith('aes:')) {
        return fallback.decrypt(cipherText.slice(4))
      }
      return fallback.decrypt(cipherText)
    },
  }
}
```

Create `apps/desktop/src/host/provider-vault.ts`:
- Defines default entries for all 5 providers (`openrouter`, `anthropic`, `openai`, `nvidia-nim`, `ollama`, where `ollama` has `requiresApiKey: false`).
- Uses `readWithAutoHeal` / `writeAtomicWithBackup` for both `providers.json` and `providers.secrets.json`.
- Provides `getPublicState()`, `saveProviderConfig(input)`, `setActiveProvider(providerId)`, `getDecryptedApiKey(providerId)`, `createActiveLanguageModel()`, and `testProviderConnection(input)` (with in-flight promise deduplication by SHA-256 key hash and `AbortSignal.timeout(10_000)`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/desktop test src/__tests__/provider-vault.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/host/secret-protector.ts apps/desktop/src/host/provider-vault.ts apps/desktop/src/__tests__/provider-vault.test.ts
git commit -m "feat(desktop): add encrypted ProviderVault with safeStorage/AES-GCM and deduplicated probe"
```

---

### Task 6: `TurnOrchestrator` & `AshyHostKernel` (Real Streaming Turn Loop, Keepalive, Immediate FTS5 Indexing & Phase 0 Onboarding)

**Files:**
- Create: `apps/desktop/src/host/turn-orchestrator.ts`
- Create: `apps/desktop/src/host/kernel.ts`
- Create: `apps/desktop/src/test/fixtures/demo-seed.ts`
- Test: `apps/desktop/src/__tests__/host-kernel.test.ts`

**Interfaces:**
- Consumes: `createContainer` from `@ashy/bus`; `createAshyCortex` from `@ashy/cortex`; `createTailSafeMarkerParser`, `streamText` from `@ashy/llm`; `createVoiceIdentityStore` from `./voice-identity-store`; `createProviderVault` from `./provider-vault`.
- Produces: `createAshyHostKernel(options): AshyHostKernel` implementing the full `AshyHostBridge` server surface + `start()` and `stop()`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/__tests__/host-kernel.test.ts`:

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AshyHostStreamEvent } from '@ashy/shared'
import { createAshyHostKernel } from '../host/kernel'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-host-kernel-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('AshyHostKernel & TurnOrchestrator', () => {
  it('boots clean with needsOnboarding=true, completes Phase 0 onboarding, and persists first_meeting across restarts', async () => {
    const dir = makeTempDir()
    const kernel1 = await createAshyHostKernel({ userDataDir: dir })

    const boot1 = await kernel1.getBootstrapSnapshot()
    expect(boot1.needsOnboarding).toBe(true)
    expect(boot1.memories.facts).toHaveLength(0)
    expect(boot1.memories.episodes).toHaveLength(0)
    expect(boot1.messages).toHaveLength(0)

    const afterOnboarding = await kernel1.completeOnboarding({
      userName: 'Carlos',
      userPronouns: 'ele/dele',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    expect(afterOnboarding.needsOnboarding).toBe(false)
    expect(afterOnboarding.userProfile.userName).toBe('Carlos')
    expect(
      afterOnboarding.relationship.milestones.some((m) => m.category === 'first_meeting'),
    ).toBe(true)
    expect(afterOnboarding.providers.hasActiveReadyProvider).toBe(true)

    await kernel1.stop()

    // Restart kernel on same directory
    const kernel2 = await createAshyHostKernel({ userDataDir: dir })
    const boot2 = await kernel2.getBootstrapSnapshot()
    expect(boot2.needsOnboarding).toBe(false)
    expect(boot2.userProfile.userName).toBe('Carlos')
    await kernel2.stop()
  })

  it('streams a real turn, parses <|ACT|> and <|CALLBACK|> markers, applies affect/joke updates, and indexes FTS5 memories', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"<|ACT {\\"emotion\\":\\"tease\\",\\"intensity\\":0.85}|>"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Oi Carlos, trabalhando no "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"banco SQLite até tarde?"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const snap = await kernel.completeOnboarding({
      userName: 'Carlos',
      providerConfig: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.7-sonnet',
        apiKey: 'sk-or-v1-livekey1234',
      },
    })

    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((ev) => events.push(ev))

    await kernel.sendTurn({
      sessionId: snap.activeSession.id,
      text: 'Estou configurando o banco SQLite e o runtime real do projeto Ashy.',
    })

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'turn:completed')).toBe(true)
    })

    unsub()

    const completed = events.find((e) => e.type === 'turn:completed')
    expect(completed?.type).toBe('turn:completed')
    if (completed?.type === 'turn:completed') {
      expect(completed.assistantMessage.content).toBe(
        'Oi Carlos, trabalhando no banco SQLite até tarde?',
      )
      expect(completed.assistantMessage.emotion).toBe('tease')
      expect(completed.snapshot.memories.episodes.length).toBeGreaterThan(0)
    }

    await kernel.stop()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/desktop test src/__tests__/host-kernel.test.ts`
Expected: FAIL with `Cannot find module '../host/kernel'`

- [ ] **Step 3: Write minimal implementation**

1. Create `apps/desktop/src/test/fixtures/demo-seed.ts` containing the isolated demo seed records (`seedAshyDemoFixtures(cortex)`), keeping production boot 100% clean.
2. Create `apps/desktop/src/host/turn-orchestrator.ts`:
   - Maintains `activeTurns = new Map<string, { turnId: string; controller: AbortController }>()`.
   - On `sendTurn`:
     - Aborts any existing in-flight turn on the same `sessionId`.
     - Appends the user message to `cortex.appendChatMessage`.
     - Checks `providerVault.getPublicState().hasActiveReadyProvider`; if false, emits `turn:error` with `code: 'PROVIDER_NOT_CONFIGURED'` immediately.
     - Compiles the prompt via `cortex.compileTurnPrompt({ userMessage, voiceIdentityMarkdown: voiceStore.read().content, screenContext })`.
     - Builds the message array (`MAX_HISTORY_MESSAGES = 80`) and starts `streamText(model, { system: compiled.systemPrompt, messages, signal })`.
     - Starts a 15-second interval timer that emits `turn:keepalive` whenever no visible `text-delta` was emitted in the last 15s (e.g., during `<think>` reasoning deltas).
     - Pipes `text-delta` chunks through `createTailSafeMarkerParser`:
       - `onLiteral` -> emits `turn:delta`
       - `onSpecial` -> emits `turn:marker`; if `act` with valid emotion, records `cortex.recordEmotionPulse`; if `callback`, records `cortex.recordJokeCallback`.
     - On completion: flushes parser, persists assistant message and calls `cortex.indexTurnMemory` inside a `try/catch` guard (setting `persistenceWarning` if disk write fails, never dropping the completed response), and emits `turn:completed`.
3. Create `apps/desktop/src/host/kernel.ts`:
   - Uses `createContainer()` from `@ashy/bus` to wire `cortex`, `voiceStore`, `providerVault`, and `turnOrchestrator`, with `stop()` closing `cortex` and aborting any active turns in reverse topological order.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/desktop test src/__tests__/host-kernel.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/test/fixtures/demo-seed.ts apps/desktop/src/host/turn-orchestrator.ts apps/desktop/src/host/kernel.ts apps/desktop/src/__tests__/host-kernel.test.ts
git commit -m "feat(desktop): add AshyHostKernel, TurnOrchestrator, and Phase 0 onboarding"
```

---

### Task 7: Dual-Runtime Transport (`ViteHostPlugin` + Electron Main/Preload `contextBridge` + Renderer `AshyHostClient`)

**Files:**
- Create: `apps/desktop/src/host/vite-host-plugin.ts`
- Create: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/services/ashy-host-client.ts`
- Modify: `apps/desktop/vite.config.ts`
- Modify: `apps/desktop/package.json`
- Test: `apps/desktop/src/__tests__/host-transport.test.ts`

**Interfaces:**
- Consumes: `createAshyHostKernel` from `./kernel`; `AshyHostBridge`, `AshyHostStreamEvent` from `@ashy/shared`.
- Produces:
  - `createAshyViteHostPlugin(options?)` in `apps/desktop/src/host/vite-host-plugin.ts`
  - `registerAshyElectronIpc(ipcMain, kernel, getWindows)` in `apps/desktop/src/main/index.ts`
  - `getAshyHostBridge()`, `setAshyHostBridgeForTesting(bridge)` in `apps/desktop/src/services/ashy-host-client.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/__tests__/host-transport.test.ts`:

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAshyHostKernel } from '../host/kernel'
import { dispatchHostRpc } from '../host/vite-host-plugin'
import { registerAshyElectronIpc } from '../main/index'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-transport-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Ashy Dual-Runtime Transport (IPC & HTTP RPC)', () => {
  it('dispatches RPC calls to AshyHostKernel and returns typed results', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })

    const snapshot = await dispatchHostRpc(kernel, 'getBootstrapSnapshot', undefined)
    expect(snapshot).toHaveProperty('needsOnboarding', true)

    await dispatchHostRpc(kernel, 'completeOnboarding', {
      userName: 'Carlos',
    })

    const updated = await dispatchHostRpc(kernel, 'getBootstrapSnapshot', undefined)
    expect(updated).toHaveProperty('needsOnboarding', false)
    await kernel.stop()
  })

  it('registers all Electron ipcMain handlers synchronously before any window loadURL call', async () => {
    const dir = makeTempDir()
    const kernel = await createAshyHostKernel({ userDataDir: dir })
    const registeredChannels: string[] = []

    const fakeIpcMain = {
      handle: vi.fn((channel: string) => {
        registeredChannels.push(channel)
      }),
      removeHandler: vi.fn(),
    }

    const cleanup = registerAshyElectronIpc(fakeIpcMain, kernel, () => [])
    expect(registeredChannels).toContain('ashy:rpc')
    cleanup()
    await kernel.stop()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/desktop test src/__tests__/host-transport.test.ts`
Expected: FAIL with `Cannot find module '../host/vite-host-plugin'`

- [ ] **Step 3: Write minimal implementation**

1. Create `apps/desktop/src/host/vite-host-plugin.ts`:
   - Exports `dispatchHostRpc(kernel, method, payload)` mapping every method of `AshyHostBridge` to `kernel`.
   - Exports `createAshyViteHostPlugin(options?)` which attaches `/__ashy_host/rpc` (POST JSON) and `/__ashy_host/events` (SSE stream) to Vite's `server.middlewares` and `previewServer.middlewares`.
2. Create `apps/desktop/src/main/index.ts`:
   - Exports `registerAshyElectronIpc(ipcMain, kernel, getWebContents)` which registers `ipcMain.handle('ashy:rpc', ...)` and forwards `kernel.onHostEvent` to all open `webContents.send('ashy:event', event)`.
   - When launched inside Electron (`process.versions.electron`), initializes `AshyHostKernel` on `app.getPath('userData')` with `createElectronSafeStorageProtector`, calls `registerAshyElectronIpc` **before** `hubWindow.loadURL`, creates `HubWindow` + `StageOverlayWindow`, and hooks `kernel.stop()` on `before-quit` and `SIGINT`.
3. Create `apps/desktop/src/preload/index.ts`:
   - Uses `contextBridge.exposeInMainWorld('ashyHost', ...)` to expose `invoke(method, payload)` and `onEvent(listener)`.
4. Create `apps/desktop/src/services/ashy-host-client.ts`:
   - Auto-selects `window.ashyHost` (Electron preload), HTTP/SSE `/__ashy_host/*` (Vite dev/Playwright), or an injected test bridge (`setAshyHostBridgeForTesting`).
5. Update `apps/desktop/vite.config.ts` to register `createAshyViteHostPlugin()` when not running inside Vitest.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/desktop test src/__tests__/host-transport.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/host/vite-host-plugin.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/services/ashy-host-client.ts apps/desktop/vite.config.ts apps/desktop/package.json apps/desktop/src/__tests__/host-transport.test.ts
git commit -m "feat(desktop): add dual Electron IPC and Vite HTTP/SSE host transport"
```

---

### Task 8: Clean-Slate `useAshyStore` Refactor, Phase 0 First-Meeting Wizard, `Ajustes > Modelos` & `Alma > Voz` UI

**Files:**
- Create: `apps/desktop/src/components/FirstMeetingWizard.tsx`
- Create: `apps/desktop/src/components/ModelsSettingsPanel.tsx`
- Modify: `apps/desktop/src/store/useAshyStore.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/__tests__/app.test.tsx`
- Create: `apps/desktop/src/__tests__/phase0-1-ui.test.tsx`

**Interfaces:**
- Consumes: `getAshyHostBridge`, `setAshyHostBridgeForTesting` from `../services/ashy-host-client`; `AshyBootstrapSnapshot`, `LlmProviderId` from `@ashy/shared`.
- Produces:
  - Clean `useAshyStore` hydrated by `bootstrapFromHost()`, with real streaming `sendUserMessage()`, `completeOnboarding()`, `saveProviderConfig()`, `testProviderConnection()`, `saveVoiceIdentity()`, `resetVoiceIdentity()`, and zero `forceMemoryFallback: true` or scripted replies.
  - `FirstMeetingWizard` component rendered when `needsOnboarding === true`.
  - `ModelsSettingsPanel` rendered in `Ajustes > Modelos` subtab.
  - `voice.md` live editor rendered in `Alma`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/__tests__/phase0-1-ui.test.tsx`:

```tsx
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createAshyHostKernel } from '../host/kernel'
import { setAshyHostBridgeForTesting } from '../services/ashy-host-client'
import { App } from '../App'
import { resetAshyStore } from '../store/useAshyStore'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-ui-p1-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  setAshyHostBridgeForTesting(null)
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Phase 0/1 UI — First-Meeting Wizard, Models Settings & Real Streaming Chat', () => {
  it('shows First-Meeting Wizard on clean boot, completes onboarding, and streams real LLM turn into chat', async () => {
    const dir = makeTempDir()
    const mockFetch = vi.fn(async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"<|ACT {\\"emotion\\":\\"smug\\",\\"intensity\\":0.8}|>"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Estúdio aceso, Carlos. Bora construir."}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
    setAshyHostBridgeForTesting(kernel)
    resetAshyStore()

    render(<App />)

    // 1. Clean boot must show Phase 0 First-Meeting Wizard
    await waitFor(() => {
      expect(screen.getByTestId('first-meeting-wizard')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByTestId('onboarding-user-name-input'), {
      target: { value: 'Carlos' },
    })
    fireEvent.change(screen.getByTestId('onboarding-api-key-input'), {
      target: { value: 'sk-or-v1-livekey9999' },
    })
    fireEvent.click(screen.getByTestId('onboarding-complete-btn'))

    await waitFor(() => {
      expect(screen.queryByTestId('first-meeting-wizard')).not.toBeInTheDocument()
    })

    // 2. Send a real message and verify streamed response from @ashy/llm
    const chatInput = screen.getByTestId('studio-chat-input')
    fireEvent.change(chatInput, {
      target: { value: 'Oi Ashy, testando nosso fluxo real na Fase 1!' },
    })
    fireEvent.click(screen.getByTestId('studio-send-btn'))

    await waitFor(() => {
      expect(screen.getByText(/Estúdio aceso, Carlos\. Bora construir\./i)).toBeInTheDocument()
    })

    await kernel.stop()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ashy/desktop test src/__tests__/phase0-1-ui.test.tsx`
Expected: FAIL with `Unable to find an element by: [data-testid="first-meeting-wizard"]`

- [ ] **Step 3: Write minimal implementation**

1. Create `apps/desktop/src/components/FirstMeetingWizard.tsx`:
   - Atmospheric *Cozy Night Studio* modal (`data-testid="first-meeting-wizard"`) with user name input (`data-testid="onboarding-user-name-input"`), pronouns selector, provider selector (`openrouter`, `anthropic`, `openai`, `nvidia-nim`, `ollama`), API key input (`data-testid="onboarding-api-key-input"`), "Testar Conexão" button, and "Despertar Ashy" button (`data-testid="onboarding-complete-btn"`).
2. Create `apps/desktop/src/components/ModelsSettingsPanel.tsx`:
   - Sub-panel inside `Ajustes` (`data-testid="models-settings-panel"`) allowing switching active provider, editing `baseUrl`, `modelId`, updating/clearing `apiKey` (displaying `maskedApiKey` badge when already configured), and running live `testProviderConnection` with latency/status feedback.
3. Refactor `apps/desktop/src/store/useAshyStore.ts`:
   - Remove `createSeededRuntime()`, `INITIAL_MEMORY_CARDS`, `forceMemoryFallback: true`, hardcoded `'21:15'`, hardcoded `'VS Code — apps/desktop/src/App.tsx'`, and the 3 scripted strings in `sendUserMessage`.
   - Hydrate state from `getAshyHostBridge().getBootstrapSnapshot()` and subscribe to `onHostEvent` to stream `turn:delta`, `turn:marker`, `turn:keepalive`, `turn:completed`, and `turn:error` directly into the store.
4. Update `apps/desktop/src/App.tsx` to render `<FirstMeetingWizard />` when `needsOnboarding` is true, `<ModelsSettingsPanel />` in `Ajustes`, and the `voice.md` editor (`data-testid="voice-identity-editor"`) in `Alma`.
5. Update `apps/desktop/src/__tests__/app.test.tsx` so existing UI tests use a seeded test kernel or `seedDemoFixtures()` via `setAshyHostBridgeForTesting`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ashy/desktop test`
Expected: PASS (both `phase0-1-ui.test.tsx` and `app.test.tsx` green)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/FirstMeetingWizard.tsx apps/desktop/src/components/ModelsSettingsPanel.tsx apps/desktop/src/store/useAshyStore.ts apps/desktop/src/App.tsx apps/desktop/src/__tests__/app.test.tsx apps/desktop/src/__tests__/phase0-1-ui.test.tsx
git commit -m "feat(desktop): wire useAshyStore to AshyHostBridge, add FirstMeetingWizard and ModelsSettingsPanel"
```

---

### Task 9: Organ Wire-Back Audit Script (`scripts/verify-phase1-wireback.mjs`) & Full Verification

**Files:**
- Create: `scripts/verify-phase1-wireback.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: All Phase 0/1 source files and test suites.
- Produces: CLI verification gate `pnpm verify:wireback` that exits `0` only if all Phase 0/1 organs are wired and no demo fallbacks remain in `useAshyStore.ts`.

- [ ] **Step 1: Write the failing test / audit script**

Create `scripts/verify-phase1-wireback.mjs`:

```js
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

function read(relPath) {
  const full = path.join(rootDir, relPath)
  if (!fs.existsSync(full)) {
    throw new Error(`Missing required file: ${relPath}`)
  }
  return fs.readFileSync(full, 'utf8')
}

const failures = []

function checkForbidden(relPath, pattern, reason) {
  const content = read(relPath)
  if (pattern.test(content)) {
    failures.push(`[FORBIDDEN] ${relPath}: ${reason}`)
  }
}

function checkRequired(relPath, pattern, reason) {
  const content = read(relPath)
  if (!pattern.test(content)) {
    failures.push(`[MISSING WIRE] ${relPath}: ${reason}`)
  }
}

// 1. Ensure production store has zero demo fallbacks or hardcoded scripted replies
checkForbidden(
  'apps/desktop/src/store/useAshyStore.ts',
  /forceMemoryFallback\s*:\s*true/,
  'Production store must not instantiate createAshyCortex({ forceMemoryFallback: true })',
)
checkForbidden(
  'apps/desktop/src/store/useAshyStore.ts',
  /INITIAL_MEMORY_CARDS/,
  'Production store must not embed INITIAL_MEMORY_CARDS demo fixtures',
)
checkForbidden(
  'apps/desktop/src/store/useAshyStore.ts',
  /VS Code — apps\/desktop\/src\/App\.tsx/,
  'Production store must not hardcode screenContext',
)

// 2. Verify all 6 Phase 0/1 organs have live producer + live reader + integration test
const organChecks = [
  {
    organ: 'CortexDatabase Migration v2 (chat_sessions/chat_messages)',
    producer: ['packages/cortex/src/db/cortex-db.ts', /CREATE TABLE IF NOT EXISTS chat_sessions/],
    reader: ['apps/desktop/src/host/turn-orchestrator.ts', /appendChatMessage/],
    test: ['packages/cortex/src/__tests__/phase1-persistence.test.ts', /Migration v2/],
  },
  {
    organ: 'VoiceIdentityStore (voice.md hot-load + auto-heal)',
    producer: ['apps/desktop/src/host/voice-identity-store.ts', /createVoiceIdentityStore/],
    reader: ['apps/desktop/src/host/turn-orchestrator.ts', /voiceIdentityMarkdown/],
    test: ['apps/desktop/src/__tests__/voice-identity-store.test.ts', /healed_from_backup/],
  },
  {
    organ: 'ProviderVault + SecretProtector',
    producer: ['apps/desktop/src/host/provider-vault.ts', /createProviderVault/],
    reader: ['apps/desktop/src/components/ModelsSettingsPanel.tsx', /models-settings-panel/],
    test: ['apps/desktop/src/__tests__/provider-vault.test.ts', /ProviderVault/],
  },
  {
    organ: '@ashy/llm streamText + createTailSafeMarkerParser in live turn loop',
    producer: ['apps/desktop/src/host/turn-orchestrator.ts', /streamText/],
    reader: ['apps/desktop/src/host/turn-orchestrator.ts', /createTailSafeMarkerParser/],
    test: ['apps/desktop/src/__tests__/host-kernel.test.ts', /turn:completed/],
  },
  {
    organ: 'Electron IPC registration before loadURL',
    producer: ['apps/desktop/src/main/index.ts', /registerAshyElectronIpc/],
    reader: ['apps/desktop/src/preload/index.ts', /contextBridge/],
    test: ['apps/desktop/src/__tests__/host-transport.test.ts', /registerAshyElectronIpc/],
  },
  {
    organ: 'Phase 0 First-Meeting Emergence Wizard',
    producer: ['apps/desktop/src/components/FirstMeetingWizard.tsx', /first-meeting-wizard/],
    reader: ['apps/desktop/src/App.tsx', /FirstMeetingWizard/],
    test: ['apps/desktop/src/__tests__/phase0-1-ui.test.tsx', /first-meeting-wizard/],
  },
]

for (const item of organChecks) {
  checkRequired(item.producer[0], item.producer[1], `${item.organ} producer`)
  checkRequired(item.reader[0], item.reader[1], `${item.organ} reader`)
  checkRequired(item.test[0], item.test[1], `${item.organ} test`)
}

if (failures.length > 0) {
  console.error('Phase 0/1 Organ Wire-Back Audit FAILED:\n' + failures.join('\n'))
  process.exit(1)
}

console.log('Phase 0/1 Organ Wire-Back Audit PASSED: all 6 organs wired end-to-end.')
```

- [ ] **Step 2: Add `verify:wireback` script to root `package.json` and run verification**

Add `"verify:wireback": "node scripts/verify-phase1-wireback.mjs"` to root `package.json`, then run:

Run: `pnpm verify:wireback && pnpm test && pnpm build`
Expected: PASS (0 audit errors, all unit/integration tests green, clean build across all packages)

- [ ] **Step 3: Perform Visual Verification in Real Browser (Playwright)**

Start `pnpm --filter @ashy/desktop dev` and verify with Playwright:
1. Clean boot displays the **Ritual de Primeiro Encontro (Fase 0)** modal (`first-meeting-wizard`).
2. Completing the wizard transitions smoothly into the **Cozy Night Studio** Hub (`stranger` stage, 0 fake memories).
3. Opening `Ajustes > Modelos` renders all 5 providers (`OpenRouter`, `Anthropic`, `OpenAI`, `NVIDIA NIM`, `Ollama`), masks saved API keys, and shows connection probe status.
4. Opening `Alma` shows the live `voice.md` editor (`voice-identity-editor`) with `ConfigDiagnostics` status badge.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-phase1-wireback.mjs package.json
git commit -m "chore(audit): add Phase 0/1 organ wire-back audit script"
```

---

## Plan Self-Review Checklist

1. **Spec Coverage:**
   - §3 (`AshyHostKernel` + `AshyHostBridge` Dual Electron/Vite + IPC registration before `loadURL` + Stage Overlay): Covered by **Task 1**, **Task 6**, **Task 7**.
   - §4 (`ashy.db` SQLite opening discipline, Migration v2 `chat_sessions`/`chat_messages`, atomic `.tmp` + `.bak1..3` + `autoHeal`): Covered by **Task 2** and **Task 4**.
   - §5 (`voice.md` hot-loadable + 20 PT-BR Golden Exemplars + static/volatile prompt split + 80-message history window): Covered by **Task 2**, **Task 3**, **Task 4**, **Task 6**.
   - §6 (`ProviderVault` for OpenRouter, Anthropic, OpenAI, NVIDIA NIM, Ollama + encrypted secrets + deduplicated 10s healthcheck): Covered by **Task 5** and **Task 8**.
   - §7 (`TurnOrchestrator` streaming via `@ashy/llm` + `createTailSafeMarkerParser` + 15s keepalive + immediate FTS5 indexing + `persistenceWarning` fault isolation): Covered by **Task 3** and **Task 6**.
   - §8 (Phase 0 First-Meeting Emergence Wizard + removal of `createSeededRuntime()` from production boot): Covered by **Task 6** and **Task 8**.
   - §9 & §10 (Adversarial failure protection + `scripts/verify-phase1-wireback.mjs`): Covered by **Task 1–9**.
2. **Placeholder Scan:** Zero `TODO`, `TBD`, or un-specified code blocks.
3. **Type Consistency:** `AshyHostBridge`, `AshyBootstrapSnapshot`, `AshyHostStreamEvent`, `LlmProviderId`, `ConfigDiagnostics`, `ChatSessionRecord`, and `ChatMessageRecord` signatures match identically across Tasks 1 through 9.
