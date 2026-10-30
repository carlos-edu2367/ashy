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

function checkRequired(relPath, patterns, reason) {
  const content = read(relPath)
  const list = Array.isArray(patterns) ? patterns : [patterns]
  for (const pattern of list) {
    if (!pattern.test(content)) {
      failures.push(`[MISSING WIRE] ${relPath}: ${reason} (missing ${pattern})`)
    }
  }
}

// 1. Verify Phase 7 Browser-Safety & Bundler Invariants
const browserSafeFiles = [
  'apps/desktop/src/store/useAshyStore.ts',
  'apps/desktop/src/App.tsx',
  'packages/agency/src/index.ts',
  'packages/agency/src/action-gatekeeper.ts',
  'packages/agency/src/mcp-progressive.ts',
  'packages/agency/src/mcp-client.ts',
  'packages/agency/src/privacy-controller.ts',
  'packages/agency/src/vision-dhash.ts',
  'packages/agency/src/vision-sensor.ts',
]

for (const relFile of browserSafeFiles) {
  checkForbidden(
    relFile,
    /(?:^|\n)\s*import\s+[\s\S]*?from\s+['"]node:(?:fs|path|child_process)['"]/,
    `${relFile} must not have top-level node:fs / node:path / node:child_process imports (renderer bundle must remain 100% browser-safe)`,
  )
}

checkForbidden(
  'apps/desktop/src/host/vite-host-plugin.ts',
  /(?:^|\n)\s*import\s+(?!type\b)(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]@ashy\/shared['"]/,
  'vite-host-plugin.ts must only import types from @ashy/shared so vite.config.ts bundles cleanly during vite build',
)

// 2. Verify all 6 Phase 7 organs have live producer + live reader + integration test
const organChecks = [
  {
    organ: '1. Shared Agency, Vision & Consent Contracts (including auto_accept / "Não pergunte" mode)',
    producer: [
      'packages/shared/src/host-protocol.ts',
      [
        /\bCOMPUTER_ACTIONS_POLICIES\b/,
        /\bauto_accept\b/,
        /\bUpdateAgencyConsentInputSchema\b/,
        /\bExternalMcpServerConfigSchema\b/,
        /\bDEFAULT_PERSISTED_AGENCY_CONSENT_STATE\b/,
      ],
    ],
    reader: [
      'apps/desktop/src/host/agency-runtime.ts',
      [
        /\bUpdateAgencyConsentInputSchema\b/,
        /\bExternalMcpServerConfigSchema\b/,
      ],
    ],
    test: [
      'packages/shared/src/__tests__/host-protocol.test.ts',
      [/\bCOMPUTER_ACTIONS_POLICIES\b/, /\bauto_accept\b/, /\bUpdateAgencyConsentInputSchema\b/],
    ],
  },
  {
    organ: '2. Upgraded ActionGatekeeper (auto_accept, Risk Overrides, Diff Preview), McpProtocolClient & AuthorizedVisionSensor',
    producer: [
      'packages/agency/src/action-gatekeeper.ts',
      [
        /\bsetApprovalPolicy\b/,
        /\bauto_accept\b/,
        /\bsetToolRiskTier\b/,
        /\bcomputeUnifiedDiffPreview\b/,
        /\brevokeAllSessionApprovals\b/,
      ],
    ],
    reader: [
      'apps/desktop/src/host/agency-runtime.ts',
      [
        /\bActionGatekeeper\b/,
        /\bcomputeUnifiedDiffPreview\b/,
        /\bcreateAuthorizedVisionSensor\b/,
        /\bcreateHttpMcpClient\b/,
        /\bcreateStdioMcpClient\b/,
      ],
    ],
    test: [
      'packages/agency/test/agency.test.ts',
      [
        /\bsetApprovalPolicy\b/,
        /\bcreateAuthorizedVisionSensor\b/,
        /\bcreateHttpMcpClient\b/,
        /\bcreateStdioMcpClient\b/,
      ],
    ],
  },
  {
    organ: '3. Cortex SQLite Migration v4 (action_audit_log & agency_consent_state)',
    producer: [
      'packages/cortex/src/db/cortex-db.ts',
      [
        /\bv4_phase7_agency_audit_and_consent\b/,
        /\binsertActionAuditLog\b/,
        /\blistActionAuditLog\b/,
        /\bgetAgencyConsentState\b/,
        /\bsaveAgencyConsentState\b/,
      ],
    ],
    reader: [
      'apps/desktop/src/host/agency-runtime.ts',
      [
        /\bgetAgencyConsentState\b/,
        /\bsaveAgencyConsentState\b/,
        /\binsertActionAuditLog\b/,
        /\blistActionAuditLog\b/,
      ],
    ],
    test: [
      'packages/cortex/src/__tests__/phase1-persistence.test.ts',
      [
        /\bv4_phase7_agency_audit_and_consent\b/,
        /\binsertActionAuditLog\b/,
        /\bsaveAgencyConsentState\b/,
      ],
    ],
  },
  {
    organ: '4. Host Agency Runtime, 4 Built-In MCP Servers, TurnOrchestrator Vision Injection & RPC Transport',
    producer: [
      'apps/desktop/src/host/agency-runtime.ts',
      [
        /\bcreateHostAgencyRuntime\b/,
        /\bgetActiveVisionContextForTurn\b/,
        /\bcaptureAuthorizedScreen\b/,
        /\bupdateConsent\b/,
      ],
    ],
    reader: [
      'apps/desktop/src/host/kernel.ts',
      [
        /\bcreateHostAgencyRuntime\b/,
        /\bcaptureAuthorizedScreen\b/,
        /\bupdateAgencyConsent\b/,
        /\brevokeSessionPermissions\b/,
      ],
    ],
    test: [
      'apps/desktop/src/__tests__/host-kernel.test.ts',
      [
        /\bupdateAgencyConsent\b/,
        /\bcaptureAuthorizedScreen\b/,
        /\bauto_accept\b/,
      ],
    ],
  },
  {
    organ: '5. Desktop UI: Inline PendingActionCard (Chat + Stage Bubble), Modo Não Pergunte (auto_accept), Vision dHash Panel & Consent Center',
    producer: [
      'apps/desktop/src/store/useAshyStore.ts',
      [
        /\btoggleDontAskMode\b/,
        /\bsetToolRiskTierOverride\b/,
        /\brevokeSessionPermissions\b/,
        /\bcaptureAuthorizedScreen\b/,
      ],
    ],
    reader: [
      'apps/desktop/src/App.tsx',
      [
        /data-testid="stage-pending-action-bubble"/,
        /data-testid="chat-pending-actions-bar"/,
        /data-testid="toggle-dont-ask-mode"/,
        /data-testid="panel-vision-dhash"/,
        /data-testid="panel-consent-center"/,
        /data-testid="consent-audit-ledger"/,
      ],
    ],
    test: [
      'apps/desktop/src/__tests__/phase7-desktop-vision-mcp-ui.test.tsx',
      [
        /chat-pending-actions-bar/,
        /stage-pending-action-bubble/,
        /toggle-dont-ask-mode/,
        /panel-vision-dhash/,
        /consent-audit-ledger/,
      ],
    ],
  },
]

for (const item of organChecks) {
  checkRequired(item.producer[0], item.producer[1], `${item.organ} — producer`)
  checkRequired(item.reader[0], item.reader[1], `${item.organ} — reader`)
  checkRequired(item.test[0], item.test[1], `${item.organ} — test`)
}

if (failures.length > 0) {
  console.error('❌ Phase 7 Wire-Back Verification FAILED:')
  for (const f of failures) {
    console.error(`  - ${f}`)
  }
  process.exit(1)
}

console.log('✅ Phase 7 Wire-Back Verification PASSED: all 5 organs + browser-safety invariants verified.')
