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

// 1. Verify Phase 4 Invariants & Red-Team Safeguards
checkForbidden(
  'apps/desktop/src/host/vite-host-plugin.ts',
  /(?:^|\n)\s*import\s+(?!type\b)(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]@ashy\/shared['"]/,
  'vite-host-plugin.ts must only import types from @ashy/shared so vite.config.ts bundles cleanly during vite build',
)
checkForbidden(
  'apps/desktop/src/store/useAshyStore.ts',
  /ep-dream-/,
  'Production store must never fabricate fake ep-dream-* episodes during Dream & Reflection',
)

// 2. Verify all 6 Phase 4 organs have live producer + live reader + integration test
const organChecks = [
  {
    organ: 'Asymmetric Trait Corridors & Idempotent Revert (ASHY_TRAIT_CORRIDORS)',
    producer: ['packages/shared/src/affect-types.ts', /ASHY_TRAIT_CORRIDORS/],
    reader: ['packages/cortex/src/affect/affect-engine.ts', /clampTraitToCorridor/],
    test: ['packages/shared/src/__tests__/host-protocol.test.ts', /ASHY_TRAIT_CORRIDORS/],
  },
  {
    organ: 'Healthy Bond Anti-Manipulation Safeguard (detectBondManipulation / stripBondManipulation)',
    producer: ['packages/llm/src/anti-slop.ts', /detectBondManipulation[\s\S]*stripBondManipulation/],
    reader: ['apps/desktop/src/host/turn-orchestrator.ts', /stripBondManipulation/],
    test: ['packages/llm/test/llm.test.ts', /detectBondManipulation/],
  },
  {
    organ: '3-Tier Hybrid Seriousness Gate & User Affect Reaction (evaluateSeriousnessGate / analyzeUserAffectReaction)',
    producer: ['packages/cortex/src/affect/affect-engine.ts', /evaluateSeriousnessGateHybrid[\s\S]*analyzeUserAffectReaction/],
    reader: ['apps/desktop/src/host/turn-orchestrator.ts', /analyzeUserAffectReaction/],
    test: ['packages/cortex/test/cortex.test.ts', /evaluateSeriousnessGateHybrid/],
  },
  {
    organ: 'Grounded Dream & Reflection Worker (runDreamReflectionCycle / proposeGroundedTraitEvolutions)',
    producer: ['packages/cortex/src/dream/dream-worker.ts', /proposeGroundedTraitEvolutions/],
    reader: ['packages/cortex/src/ashy-cortex.ts', /runDreamReflectionCycle/],
    test: ['packages/cortex/test/cortex.test.ts', /runDreamReflectionCycle/],
  },
  {
    organ: 'Phase 4 M2 Longitudinal Gates G11–G13 (Implicit Seriousness, Bond Safeguard, Trait Corridors)',
    producer: ['packages/evals/src/judges.ts', /evaluateBondSafeguardCompliance/],
    reader: ['packages/evals/src/runner.ts', /G11:[\s\S]*G12:[\s\S]*G13:/],
    test: ['packages/evals/test/m2-experiment.test.ts', /seriousnessFalseNegativeCount/],
  },
  {
    organ: 'Desktop Host Idle Dream Scheduler, RPCs & Hub UI Corridors/Provenance',
    producer: ['apps/desktop/src/host/kernel.ts', /runDreamReflection[\s\S]*revertTraitEvolution/],
    reader: ['apps/desktop/src/App.tsx', /trait-corridor-[\s\S]*evo-provenance-/],
    test: ['apps/desktop/src/__tests__/phase4-emotions-evolution-ui.test.tsx', /evo-provenance-/],
  },
]

for (const item of organChecks) {
  checkRequired(item.producer[0], item.producer[1], `${item.organ} producer`)
  checkRequired(item.reader[0], item.reader[1], `${item.organ} reader`)
  checkRequired(item.test[0], item.test[1], `${item.organ} test`)
}

checkRequired(
  'packages/cortex/src/prompt/soul-composer.ts',
  /\[HEALTHY BOND & ANTI-MANIPULATION LAW\]/,
  'SoulComposer must inject [HEALTHY BOND & ANTI-MANIPULATION LAW] into staticSystemPrompt',
)
checkRequired(
  'apps/desktop/src/store/useAshyStore.ts',
  /proposeGroundedTraitEvolutions/,
  'useAshyStore must ground runDreamConsolidation via proposeGroundedTraitEvolutions',
)

if (failures.length > 0) {
  console.error('Phase 4 Organ Wire-Back Audit FAILED:\n' + failures.join('\n'))
  process.exit(1)
}

console.log('Phase 4 Organ Wire-Back Audit PASSED: all 6 organs wired end-to-end.')
