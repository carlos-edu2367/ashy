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

// 1. Browser-Safety & Vite Bundler Invariants
const browserSafeFiles = [
  'packages/cortex/src/initiative/attention-loop.ts',
  'packages/cortex/src/world/ashy-room.ts',
  'apps/desktop/src/store/useAshyStore.ts',
  'apps/desktop/src/App.tsx',
]

for (const relFile of browserSafeFiles) {
  checkForbidden(
    relFile,
    /(?:^|\n)\s*import\s+[\s\S]*?from\s+['"]node:(?:fs|path|child_process|sqlite)['"]/,
    `${relFile} must not have top-level node:* imports (renderer bundle must remain 100% browser-safe)`,
  )
}

checkForbidden(
  'apps/desktop/src/host/vite-host-plugin.ts',
  /(?:^|\n)\s*import\s+(?!type\b)(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]@ashy\/shared['"]/,
  'vite-host-plugin.ts must only import types from @ashy/shared so vite.config.ts bundles cleanly during vite build',
)

// 2. Verify all 5 Phase 8 (Marco M4) organs have live producer + live reader + integration test
const organChecks = [
  {
    organ: '1. Shared Phase 8 Contracts (InitiativePolicy, ProactiveInitiativeRecord, DreamJournalEntry, RoomEnvironmentState & M4 Thresholds)',
    producer: [
      'packages/shared/src/host-protocol.ts',
      [
        /\bInitiativePolicySchema\b/,
        /\bDEFAULT_INITIATIVE_POLICY\b/,
        /\bProactiveInitiativeRecordSchema\b/,
        /\bDreamJournalEntrySchema\b/,
        /\bRoomEnvironmentStateSchema\b/,
        /\bUpdateMilestoneInputSchema\b/,
        /\binitiativeGroundingRateMin\b/,
        /\bunopportuneInitiativeCountMax\b/,
      ],
    ],
    reader: [
      'packages/cortex/src/db/cortex-db.ts',
      [
        /\bUpdateInitiativePolicyInputSchema\b/,
        /\bUpdateMilestoneInputSchema\b/,
        /\bDEFAULT_INITIATIVE_POLICY\b/,
      ],
    ],
    test: [
      'packages/shared/src/__tests__/host-protocol.test.ts',
      [
        /\bInitiativePolicySchema\b/,
        /\bProactiveInitiativeRecordSchema\b/,
        /\bDreamJournalEntrySchema\b/,
        /\bRoomEnvironmentStateSchema\b/,
      ],
    ],
  },
  {
    organ: '2. Cortex Migration v5, Attention Loop (evaluateAttentionLoop) & Ashy Room (deriveAshyRoomEnvironment)',
    producer: [
      'packages/cortex/src/initiative/attention-loop.ts',
      [
        /\bevaluateAttentionLoop\b/,
        /\bisWithinQuietHours\b/,
        /\bsuppressed_disabled\b/,
        /\bsuppressed_dnd\b/,
        /\bsuppressed_quiet_hours\b/,
        /\bsuppressed_no_anchor\b/,
        /\bselective_silence\b/,
      ],
    ],
    reader: [
      'packages/cortex/src/ashy-cortex.ts',
      [
        /\bevaluateAttentionInitiative\b/,
        /\bgetRoomEnvironment\b/,
        /\bupdateMilestone\b/,
        /\blistDreamJournalEntries\b/,
      ],
    ],
    test: [
      'packages/cortex/src/__tests__/phase8-initiative-world.test.ts',
      [
        /\bevaluateAttentionLoop\b/,
        /\bderiveAshyRoomEnvironment\b/,
        /\bv5_phase8_initiative_and_reflection_journal\b/,
      ],
    ],
  },
  {
    organ: '3. Milestone M4 Evaluation Suite (evaluateContextualInitiativeSuite, G14 & G15)',
    producer: [
      'packages/evals/src/judges.ts',
      [
        /\bevaluateContextualInitiativeSuite\b/,
        /\binitiativeGroundingRate\b/,
        /\bunopportuneInitiativeCount\b/,
      ],
    ],
    reader: [
      'packages/evals/src/runner.ts',
      [
        /\bevaluateContextualInitiativeSuite\b/,
        /\bG14_contextual_initiative_grounding\b/,
        /\bG15_zero_unopportune_initiatives\b/,
      ],
    ],
    test: [
      'packages/evals/test/judges.test.ts',
      [/\bevaluateContextualInitiativeSuite\b/],
    ],
  },
  {
    organ: '4. Host Kernel & Unified RPC Transport (updateMilestone, updateInitiativePolicy, evaluateAttentionInitiative)',
    producer: [
      'apps/desktop/src/host/kernel.ts',
      [
        /\bupdateMilestone\b/,
        /\bupdateInitiativePolicy\b/,
        /\bevaluateAttentionInitiative\b/,
        /\broomEnvironment\b/,
        /\bdreamJournalEntries\b/,
      ],
    ],
    reader: [
      'apps/desktop/src/host/vite-host-plugin.ts',
      [
        /\bupdateMilestone\b/,
        /\bupdateInitiativePolicy\b/,
        /\bevaluateAttentionInitiative\b/,
      ],
    ],
    test: [
      'apps/desktop/src/__tests__/host-kernel.test.ts',
      [
        /\bupdateMilestone\b/,
        /\bupdateInitiativePolicy\b/,
        /\bevaluateAttentionInitiative\b/,
      ],
    ],
  },
  {
    organ: '5. Desktop Store & UI (Our Story Search/Filter/Edit, Ashy Room, Dream Journal & Initiative Limits)',
    producer: [
      'apps/desktop/src/store/useAshyStore.ts',
      [
        /\bsetStorySearchQuery\b/,
        /\bsetStoryCategoryFilter\b/,
        /\bupdateMilestone\b/,
        /\bsetRoomTimeOverride\b/,
        /\bupdateInitiativePolicy\b/,
        /\bevaluateAttentionInitiative\b/,
      ],
    ],
    reader: [
      'apps/desktop/src/App.tsx',
      [
        /story-search-input/,
        /story-category-filter/,
        /panel-ashy-room/,
        /panel-dream-journal/,
        /panel-initiative-limits/,
        /toggle-initiative-enabled/,
        /btn-evaluate-initiative-now/,
      ],
    ],
    test: [
      'apps/desktop/src/__tests__/phase8-initiative-world-ui.test.tsx',
      [
        /story-search-input/,
        /panel-ashy-room/,
        /panel-dream-journal/,
        /panel-initiative-limits/,
      ],
    ],
  },
]

for (const item of organChecks) {
  checkRequired(item.producer[0], item.producer[1], `${item.organ} — Producer`)
  checkRequired(item.reader[0], item.reader[1], `${item.organ} — Reader`)
  checkRequired(item.test[0], item.test[1], `${item.organ} — Integration Test`)
}

if (failures.length > 0) {
  console.error('❌ Phase 8 Wire-Back Verification FAILED:')
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}

console.log(
  `✅ Phase 8 Wire-Back Verification PASSED: all ${organChecks.length} organs + browser-safety invariants verified.`,
)
