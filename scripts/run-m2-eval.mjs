import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

export function parseCliArgs(argv) {
  let seed = undefined
  let live = false
  let modelAId = undefined
  let modelBId = undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--live') {
      live = true
    } else if (arg.startsWith('--seed=')) {
      const rawStr = arg.slice('--seed='.length)
      if (rawStr.trim().length === 0) {
        throw new Error(`Invalid --seed value: ${arg}`)
      }
      const raw = Number(rawStr)
      if (!Number.isInteger(raw) || raw < 0) {
        throw new Error(`Invalid --seed value: ${arg}`)
      }
      seed = raw
    } else if (arg === '--seed') {
      if (i + 1 >= argv.length) {
        throw new Error('Invalid --seed value: missing argument')
      }
      const rawStr = String(argv[i + 1] ?? '')
      if (rawStr.trim().length === 0) {
        throw new Error(`Invalid --seed value: ${rawStr}`)
      }
      const raw = Number(rawStr)
      if (!Number.isInteger(raw) || raw < 0) {
        throw new Error(`Invalid --seed value: ${rawStr}`)
      }
      seed = raw
      i += 1
    } else if (arg.startsWith('--model-a=')) {
      const val = arg.slice('--model-a='.length).trim()
      if (!val) {
        throw new Error(`Invalid --model-a value: ${arg}`)
      }
      modelAId = val
    } else if (arg === '--model-a') {
      const val = String(argv[i + 1] ?? '').trim()
      if (i + 1 >= argv.length || !val || val.startsWith('--')) {
        throw new Error('Invalid --model-a value: missing model ID')
      }
      modelAId = val
      i += 1
    } else if (arg.startsWith('--model-b=')) {
      const val = arg.slice('--model-b='.length).trim()
      if (!val) {
        throw new Error(`Invalid --model-b value: ${arg}`)
      }
      modelBId = val
    } else if (arg === '--model-b') {
      const val = String(argv[i + 1] ?? '').trim()
      if (i + 1 >= argv.length || !val || val.startsWith('--')) {
        throw new Error('Invalid --model-b value: missing model ID')
      }
      modelBId = val
      i += 1
    }
  }

  return {
    seeds: seed !== undefined ? [seed] : [0, 1, 2],
    live,
    modelAId,
    modelBId,
  }
}

function isLocalBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string') return false
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(
    baseUrl.trim(),
  )
}

export function resolveLiveProviderRunners({
  modelAId,
  modelBId,
  env = process.env,
  createLiveProviderModelRunner,
}) {
  const effectiveModelAId =
    modelAId || env.ASHY_EVAL_MODEL_A_ID || 'anthropic/claude-3.7-sonnet'
  const effectiveModelBId =
    modelBId || env.ASHY_EVAL_MODEL_B_ID || 'qwen/qwen-2.5-72b-instruct'

  const providerA =
    env.ASHY_EVAL_MODEL_A_PROVIDER === 'anthropic'
      ? 'anthropic'
      : 'openai-compatible'
  const providerB =
    env.ASHY_EVAL_MODEL_B_PROVIDER === 'anthropic'
      ? 'anthropic'
      : 'openai-compatible'

  const baseUrlA =
    env.ASHY_EVAL_MODEL_A_BASE_URL ||
    (providerA === 'anthropic'
      ? 'https://api.anthropic.com/v1'
      : 'https://openrouter.ai/api/v1')
  const baseUrlB =
    env.ASHY_EVAL_MODEL_B_BASE_URL ||
    (providerB === 'anthropic'
      ? 'https://api.anthropic.com/v1'
      : 'https://openrouter.ai/api/v1')

  const fallbackKeyA =
    providerA === 'anthropic'
      ? env.ANTHROPIC_API_KEY || env.OPENROUTER_API_KEY || env.OPENAI_API_KEY
      : env.OPENROUTER_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY
  const fallbackKeyB =
    providerB === 'anthropic'
      ? env.ANTHROPIC_API_KEY || env.OPENROUTER_API_KEY || env.OPENAI_API_KEY
      : env.OPENROUTER_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY

  const apiKeyA = (env.ASHY_EVAL_MODEL_A_API_KEY || fallbackKeyA || '').trim()
  const apiKeyB = (env.ASHY_EVAL_MODEL_B_API_KEY || fallbackKeyB || '').trim()

  if (
    (!apiKeyA && !isLocalBaseUrl(baseUrlA)) ||
    (!apiKeyB && !isLocalBaseUrl(baseUrlB))
  ) {
    throw new Error(
      '--live requires ASHY_EVAL_MODEL_A_API_KEY / ASHY_EVAL_MODEL_B_API_KEY (or OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY)',
    )
  }

  const modelARunner = createLiveProviderModelRunner({
    modelId: effectiveModelAId,
    provider: providerA,
    baseUrl: baseUrlA,
    apiKey: apiKeyA || undefined,
  })

  const modelBRunner = createLiveProviderModelRunner({
    modelId: effectiveModelBId,
    provider: providerB,
    baseUrl: baseUrlB,
    apiKey: apiKeyB || undefined,
  })

  return { modelARunner, modelBRunner }
}

async function main() {
  const { seeds, live, modelAId, modelBId } = parseCliArgs(process.argv.slice(2))

  const server = await createServer({
    configFile: false,
    root: rootDir,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    resolve: {
      alias: {
        '@ashy/shared': path.resolve(rootDir, 'packages/shared/src/index.ts'),
        '@ashy/llm': path.resolve(rootDir, 'packages/llm/src/index.ts'),
        '@ashy/cortex': path.resolve(rootDir, 'packages/cortex/src/index.ts'),
        '@ashy/evals': path.resolve(rootDir, 'packages/evals/src/index.ts'),
      },
    },
  })

  try {
    const evalsMod = await server.ssrLoadModule('/packages/evals/src/index.ts')
    const sharedMod = await server.ssrLoadModule('/packages/shared/src/index.ts')

    const {
      runMultiSeedCoreExperimentM2,
      createLiveProviderModelRunner,
      formatCoreExperimentMarkdownReport,
      serializeCoreExperimentJsonReport,
    } = evalsMod
    const { M2_GATE_THRESHOLDS } = sharedMod

    const liveRunners = live
      ? resolveLiveProviderRunners({
          modelAId,
          modelBId,
          env: process.env,
          createLiveProviderModelRunner,
        })
      : undefined

    const multi = await runMultiSeedCoreExperimentM2({
      seeds,
      mode: live ? 'live_llm' : 'deterministic_sim',
      modelAId,
      modelBId,
      ...(liveRunners
        ? {
            modelARunner: liveRunners.modelARunner,
            modelBRunner: liveRunners.modelBRunner,
          }
        : {}),
    })

    const primaryReport = multi.reports[0]
    if (!primaryReport) {
      throw new Error('No evaluation report was produced.')
    }

    const outDir = path.join(rootDir, 'docs', 'evals')
    fs.mkdirSync(outDir, { recursive: true })

    const jsonPath = path.join(outDir, 'latest-m2-report.json')
    const mdPath = path.join(outDir, 'latest-m2-report.md')

    fs.writeFileSync(
      jsonPath,
      serializeCoreExperimentJsonReport(primaryReport),
      'utf8',
    )
    fs.writeFileSync(
      mdPath,
      formatCoreExperimentMarkdownReport(primaryReport, multi),
      'utf8',
    )

    const m = primaryReport.metrics
    const gateRows = [
      {
        Gate: 'G1',
        Metric: 'memoryRecallRate',
        Threshold: `>= ${M2_GATE_THRESHOLDS.memoryRecallRateMin.toFixed(2)}`,
        Observed: m.memoryRecallRate.toFixed(4),
        Status:
          m.memoryRecallRate >= M2_GATE_THRESHOLDS.memoryRecallRateMin
            ? 'PASS'
            : 'FAIL',
      },
      {
        Gate: 'G2',
        Metric: 'memoryPrecisionRate',
        Threshold: `>= ${M2_GATE_THRESHOLDS.memoryPrecisionRateMin.toFixed(2)}`,
        Observed: m.memoryPrecisionRate.toFixed(4),
        Status:
          m.memoryPrecisionRate >= M2_GATE_THRESHOLDS.memoryPrecisionRateMin
            ? 'PASS'
            : 'FAIL',
      },
      {
        Gate: 'G3',
        Metric: 'callbackAccuracyRate',
        Threshold: `>= ${M2_GATE_THRESHOLDS.callbackAccuracyRateMin.toFixed(2)}`,
        Observed: m.callbackAccuracyRate.toFixed(4),
        Status:
          m.callbackAccuracyRate >= M2_GATE_THRESHOLDS.callbackAccuracyRateMin
            ? 'PASS'
            : 'FAIL',
      },
      {
        Gate: 'G4',
        Metric: 'cooldownComplianceRate',
        Threshold: `=== ${M2_GATE_THRESHOLDS.cooldownComplianceRateMin.toFixed(2)}`,
        Observed: m.cooldownComplianceRate.toFixed(4),
        Status:
          m.cooldownComplianceRate >=
          M2_GATE_THRESHOLDS.cooldownComplianceRateMin
            ? 'PASS'
            : 'FAIL',
      },
      {
        Gate: 'G5',
        Metric: 'hallucinatedMemoryCount',
        Threshold: `=== ${M2_GATE_THRESHOLDS.hallucinatedMemoryCountMax}`,
        Observed: String(m.hallucinatedMemoryCount),
        Status:
          m.hallucinatedMemoryCount <=
          M2_GATE_THRESHOLDS.hallucinatedMemoryCountMax
            ? 'PASS'
            : 'FAIL',
      },
      {
        Gate: 'G6',
        Metric: 'provenanceCoverageRate',
        Threshold: `=== ${M2_GATE_THRESHOLDS.provenanceCoverageRateMin.toFixed(2)}`,
        Observed: m.provenanceCoverageRate.toFixed(4),
        Status:
          m.provenanceCoverageRate >=
          M2_GATE_THRESHOLDS.provenanceCoverageRateMin
            ? 'PASS'
            : 'FAIL',
      },
      {
        Gate: 'G7',
        Metric: 'seriousnessGateCompliance',
        Threshold: `=== ${M2_GATE_THRESHOLDS.seriousnessGateComplianceMin.toFixed(2)}`,
        Observed: m.seriousnessGateCompliance.toFixed(4),
        Status:
          m.seriousnessGateCompliance >=
          M2_GATE_THRESHOLDS.seriousnessGateComplianceMin
            ? 'PASS'
            : 'FAIL',
      },
      {
        Gate: 'G8',
        Metric: 'antiSlopComplianceRate',
        Threshold: `=== ${M2_GATE_THRESHOLDS.antiSlopComplianceRateMin.toFixed(2)}`,
        Observed: m.antiSlopComplianceRate.toFixed(4),
        Status:
          m.antiSlopComplianceRate >=
          M2_GATE_THRESHOLDS.antiSlopComplianceRateMin
            ? 'PASS'
            : 'FAIL',
      },
      {
        Gate: 'G9',
        Metric: 'crossModelVoiceDrift',
        Threshold: `<= ${M2_GATE_THRESHOLDS.crossModelVoiceDriftMax.toFixed(2)} (A,B >= ${M2_GATE_THRESHOLDS.voiceScoreMin.toFixed(2)})`,
        Observed: `${m.crossModelVoiceDrift.toFixed(4)} (A=${m.voiceScoreModelA.toFixed(4)}, B=${m.voiceScoreModelB.toFixed(4)})`,
        Status:
          m.voiceScoreModelA >= M2_GATE_THRESHOLDS.voiceScoreMin &&
          m.voiceScoreModelB >= M2_GATE_THRESHOLDS.voiceScoreMin &&
          m.crossModelVoiceDrift <= M2_GATE_THRESHOLDS.crossModelVoiceDriftMax
            ? 'PASS'
            : 'FAIL',
      },
      {
        Gate: 'G10',
        Metric: 'seedInvariance',
        Threshold: `All seeds pass (${multi.seeds.join(', ')})`,
        Observed: `${multi.reports.filter((r) => !r.failedGates.some((g) => !g.startsWith('G10'))).length}/${multi.reports.length} passed`,
        Status: multi.allPassed ? 'PASS' : 'FAIL',
      },
      {
        Gate: 'G11',
        Metric: 'seriousnessFalseNegativeCount',
        Threshold: `=== ${M2_GATE_THRESHOLDS.seriousnessFalseNegativeCountMax}`,
        Observed: String(m.seriousnessFalseNegativeCount ?? 0),
        Status:
          (m.seriousnessFalseNegativeCount ?? 0) <=
          M2_GATE_THRESHOLDS.seriousnessFalseNegativeCountMax
            ? 'PASS'
            : 'FAIL',
      },
      {
        Gate: 'G12',
        Metric: 'bondSafeguardComplianceRate',
        Threshold: `=== ${M2_GATE_THRESHOLDS.bondSafeguardComplianceRateMin.toFixed(2)}`,
        Observed: (m.bondSafeguardComplianceRate ?? 1).toFixed(4),
        Status:
          (m.bondSafeguardComplianceRate ?? 1) >=
          M2_GATE_THRESHOLDS.bondSafeguardComplianceRateMin
            ? 'PASS'
            : 'FAIL',
      },
      {
        Gate: 'G13',
        Metric: 'traitDriftCorridorComplianceRate',
        Threshold: `=== ${M2_GATE_THRESHOLDS.traitDriftCorridorComplianceRateMin.toFixed(2)}`,
        Observed: (m.traitDriftCorridorComplianceRate ?? 1).toFixed(4),
        Status:
          (m.traitDriftCorridorComplianceRate ?? 1) >=
          M2_GATE_THRESHOLDS.traitDriftCorridorComplianceRateMin
            ? 'PASS'
            : 'FAIL',
      },
    ]

    console.log(
      `\nAshy Phase 3 Core Experiment (Milestone M2) — Seeds [${multi.seeds.join(', ')}]`,
    )
    console.log(
      `Model A: ${primaryReport.modelAId} -> Model B: ${primaryReport.modelBId}`,
    )
    console.table(gateRows)
    console.log(`Artifacts written:`)
    console.log(`  - ${path.relative(rootDir, jsonPath)}`)
    console.log(`  - ${path.relative(rootDir, mdPath)}`)

    const overallPassed = primaryReport.passedAllGates && multi.allPassed
    if (!overallPassed) {
      console.error(
        `\nM2 Evaluation FAILED. Failed gates: ${primaryReport.failedGates.join(', ') || 'G10 seed invariance'}`,
      )
      process.exitCode = 1
    } else {
      console.log('\nM2 Evaluation PASSED: all 13 gates (G1–G13) are green.')
    }
  } finally {
    await server.close()
  }
}

const isDirectCliExecution =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectCliExecution) {
  main().catch((err) => {
    console.error('Fatal error in run-m2-eval:', err)
    process.exitCode = 1
  })
}
