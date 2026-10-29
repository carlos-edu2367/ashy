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

// 1. Verify Phase 3 Invariants & Red-Team Anti-Cheating Safeguards
checkForbidden(
  'packages/evals/src/simulators.ts',
  /\b(?:CortexDatabase|createCortexDatabase)\b/,
  'simulators.ts must not import or reference CortexDatabase or createCortexDatabase (Anti-Cheating Rule)',
)
checkForbidden(
  'apps/desktop/src/host/vite-host-plugin.ts',
  /(?:^|\n)\s*import\s+(?!type\b)(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]@ashy\/shared['"]/,
  'vite-host-plugin.ts must only import types from @ashy/shared so vite.config.ts bundles cleanly during vite build',
)

// 2. Verify all 6 Phase 3 organs have live producer + live reader + integration test
const organChecks = [
  {
    organ: 'Phase 3 M2 Shared Schemas & Thresholds',
    producer: ['packages/shared/src/host-protocol.ts', /M2_GATE_THRESHOLDS/],
    reader: ['packages/evals/src/runner.ts', /CoreExperimentEvalReportSchema/],
    test: ['packages/shared/src/__tests__/host-protocol.test.ts', /M2_GATE_THRESHOLDS/],
  },
  {
    organ: 'Longitudinal 3-Week Coexistence Scenario & Seeded SimulatedUser',
    producer: ['packages/evals/src/scenarios.ts', /M2_CANONICAL_COEXISTENCE_SCENARIO/],
    reader: ['packages/evals/src/runner.ts', /createSimulatedUser/],
    test: ['packages/evals/test/scenarios.test.ts', /M2_CANONICAL_COEXISTENCE_SCENARIO/],
  },
  {
    organ: 'Dual-Mode Honest Model Simulators (Model A -> Model B)',
    producer: ['packages/evals/src/simulators.ts', /createSimulatedModelRunner/],
    reader: ['packages/evals/src/runner.ts', /createSimulatedModelRunner/],
    test: ['packages/evals/test/simulators.test.ts', /parseComposedPromptContext/],
  },
  {
    organ: 'Two-Tier Hybrid Judging Engine (Provenance, Hallucinations, Voice Rubric)',
    producer: ['packages/evals/src/judges.ts', /auditTurnHallucinationsAndProvenance/],
    reader: ['packages/evals/src/runner.ts', /evaluateVoiceConsistencyRubric/],
    test: ['packages/evals/test/judges.test.ts', /auditTurnHallucinationsAndProvenance/],
  },
  {
    organ: 'M2 CLI Runner & Generated Report Artifacts',
    producer: ['scripts/run-m2-eval.mjs', /runMultiSeedCoreExperimentM2[\s\S]*createLiveProviderModelRunner/],
    reader: ['docs/evals/latest-m2-report.md', /PASS \(ALL GATES GREEN\)/],
    test: ['packages/evals/test/m2-experiment.test.ts', /runMultiSeedCoreExperimentM2/],
  },
  {
    organ: 'Desktop Hub M2 Benchmark Panel (Modelo A -> B)',
    producer: ['apps/desktop/src/host/kernel.ts', /runCoreExperimentEval/],
    reader: ['apps/desktop/src/App.tsx', /m2-eval-panel/],
    test: ['apps/desktop/src/__tests__/phase3-m2-eval-ui.test.tsx', /m2-eval-status-badge/],
  },
]

for (const item of organChecks) {
  checkRequired(item.producer[0], item.producer[1], `${item.organ} producer`)
  checkRequired(item.reader[0], item.reader[1], `${item.organ} reader`)
  checkRequired(item.test[0], item.test[1], `${item.organ} test`)
}

checkRequired(
  'scripts/run-m2-eval.mjs',
  /--live/,
  'run-m2-eval.mjs must support --live flag and createLiveProviderModelRunner',
)

if (failures.length > 0) {
  console.error('Phase 3 Organ Wire-Back Audit FAILED:\n' + failures.join('\n'))
  process.exit(1)
}

console.log('Phase 3 Organ Wire-Back Audit PASSED: all 6 organs wired end-to-end.')
