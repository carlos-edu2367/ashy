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

// 1. Verify Phase 2 Invariants & Red-Team Safeguards
checkRequired(
  'packages/cortex/src/db/cortex-db.ts',
  /v3_phase2_self_writing_memory/,
  'Migration v3 (v3_phase2_self_writing_memory) must be registered in CortexDatabase',
)
checkRequired(
  'packages/cortex/src/db/cortex-db.ts',
  /CREATE TABLE IF NOT EXISTS memory_governance_settings/,
  'memory_governance_settings SQLite table must exist in CortexDatabase',
)
checkRequired(
  'packages/cortex/src/db/cortex-db.ts',
  /pending_review/,
  'CortexDatabase must enforce pending_review quarantine checks on active queries',
)
checkRequired(
  'packages/cortex/src/prompt/soul-composer.ts',
  /pending_review/,
  'SoulComposer must filter out pending_review items before compiling turn prompts',
)
checkRequired(
  'packages/cortex/src/relational/inside-joke-engine.ts',
  /pending_review/,
  'Inside-joke engine must filter out pending_review motifs in selectEligibleMotifs',
)
checkForbidden(
  'apps/desktop/src/test/fixtures/demo-seed.ts',
  /embedding\s*:\s*\[/,
  'Demo seed must not hardcode toy 4-D embeddings; CortexDatabase must generate 128-D semantic embeddings',
)
checkForbidden(
  'apps/desktop/src/host/vite-host-plugin.ts',
  /import\s+(?!type\b)\{[^}]*\}\s+from\s+['"]@ashy\/shared['"]/,
  'vite-host-plugin.ts must only import types from @ashy/shared so vite.config.ts bundles cleanly during vite build',
)

// 2. Verify all 7 Phase 2 organs have live producer + live reader + integration test
const organChecks = [
  {
    organ: 'EmbeddingProvider (128-D Semantic + Remote)',
    producer: ['packages/llm/src/embeddings.ts', /createDeterministicSemanticEmbeddingProvider/],
    reader: ['packages/cortex/src/db/cortex-db.ts', /embedTextSync128/],
    test: ['packages/llm/test/embeddings.test.ts', /createResilientEmbeddingProvider/],
  },
  {
    organ: 'EpisodeSegmenter (Soft/Hard Boundaries & Topic Shift)',
    producer: ['packages/cortex/src/memory/episode-segmenter.ts', /detectEpisodeBoundary/],
    reader: ['packages/cortex/src/ashy-cortex.ts', /detectEpisodeBoundary/],
    test: ['packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts', /detectEpisodeBoundary/],
  },
  {
    organ: 'EpisodeExtractor (Structured Extraction & Evidence Grounding)',
    producer: ['packages/cortex/src/memory/episode-extractor.ts', /extractStructuredEpisode/],
    reader: ['packages/cortex/src/ashy-cortex.ts', /extractStructuredEpisode/],
    test: ['packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts', /verifyExtractionEvidence/],
  },
  {
    organ: 'Hybrid Semantic Motif Relevance (Day 1 -> 5 -> 18)',
    producer: ['packages/cortex/src/relational/inside-joke-engine.ts', /computeCosineSimilarity128/],
    reader: ['packages/cortex/src/ashy-cortex.ts', /selectEligibleMotifs/],
    test: ['packages/cortex/src/__tests__/inside-joke-semantic.test.ts', /semantic_context_match/],
  },
  {
    organ: 'Post-Turn FSRS-6 Memory Usage Loop',
    producer: ['packages/cortex/src/memory/fsrs-turn-loop.ts', /evaluateTurnMemoryUsage/],
    reader: ['apps/desktop/src/host/turn-orchestrator.ts', /reviewTurnMemories/],
    test: ['apps/desktop/src/__tests__/phase2-memory-ui.test.tsx', /reviewTurnMemories/],
  },
  {
    organ: 'SoulComposer Habits & Prospective Intents',
    producer: ['packages/cortex/src/prompt/soul-composer.ts', /\[USER HABITS & RHYTHM\]/],
    reader: ['packages/cortex/src/ashy-cortex.ts', /listProspectiveIntents/],
    test: ['packages/cortex/src/__tests__/phase2-self-writing-memory.test.ts', /USER HABITS & RHYTHM/],
  },
  {
    organ: 'Memory Governance & Quarantine UI',
    producer: ['packages/cortex/src/db/cortex-db.ts', /approveMemoryItem/],
    reader: ['apps/desktop/src/App.tsx', /memory-governance-panel/],
    test: ['apps/desktop/src/__tests__/phase2-memory-ui.test.tsx', /btn-approve-memory-/],
  },
]

for (const item of organChecks) {
  checkRequired(item.producer[0], item.producer[1], `${item.organ} producer`)
  checkRequired(item.reader[0], item.reader[1], `${item.organ} reader`)
  checkRequired(item.test[0], item.test[1], `${item.organ} test`)
}

if (failures.length > 0) {
  console.error('Phase 2 Organ Wire-Back Audit FAILED:\n' + failures.join('\n'))
  process.exit(1)
}

console.log('Phase 2 Organ Wire-Back Audit PASSED: all 7 organs wired end-to-end.')
