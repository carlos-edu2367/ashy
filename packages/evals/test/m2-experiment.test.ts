import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { CoreExperimentEvalReportSchema } from '@ashy/shared'
import {
  createSimulatedModelRunner,
  formatCoreExperimentMarkdownReport,
  runCoreExperimentM2,
  runMultiSeedCoreExperimentM2,
  serializeCoreExperimentJsonReport,
  type EvalModelRunner,
} from '../src/index'

describe('Phase 3 End-to-End M2 Orchestrator, Multi-Seed Verifier & Reporter', () => {
  it('Single-Seed Full Longitudinal Run (seed 0) passes all 10 M2 gates and verifies every organ transition', async () => {
    const report = await runCoreExperimentM2({ seed: 0 })

    // Schema validation
    expect(() => v.parse(CoreExperimentEvalReportSchema, report)).not.toThrow()

    expect(report.seed).toBe(0)
    expect(report.mode).toBe('deterministic_sim')
    expect(
      report.steps.filter((s) => !s.passed).map((s) => ({
        stepId: s.stepId,
        notes: s.notes,
        hallucinations: s.hallucinationsDetected,
      })),
    ).toEqual([])
    expect(report.failedGates).toEqual([])
    expect(report.passedAllGates).toBe(true)

    // Verify all M2 Gate thresholds
    expect(report.metrics.memoryRecallRate).toBeGreaterThanOrEqual(0.85)
    expect(report.metrics.memoryPrecisionRate).toBeGreaterThanOrEqual(0.8)
    expect(report.metrics.callbackAccuracyRate).toBeGreaterThanOrEqual(0.9)
    expect(report.metrics.cooldownComplianceRate).toBe(1.0)
    expect(report.metrics.hallucinatedMemoryCount).toBe(0)
    expect(report.metrics.provenanceCoverageRate).toBe(1.0)
    expect(report.metrics.seriousnessGateCompliance).toBe(1.0)
    expect(report.metrics.antiSlopComplianceRate).toBe(1.0)
    expect(report.metrics.voiceScoreModelA).toBeGreaterThanOrEqual(0.8)
    expect(report.metrics.voiceScoreModelB).toBeGreaterThanOrEqual(0.8)
    expect(report.metrics.crossModelVoiceDrift).toBeLessThanOrEqual(0.15)

    const findStep = (stepId: string) => {
      const step = report.steps.find((s) => s.stepId === stepId)
      expect(step, `Expected step ${stepId} to exist`).toBeDefined()
      return step!
    }

    // Day 5: invokes <|CALLBACK|> under Model A
    const day5 = findStep('day5-bug-resolved-callback')
    expect(day5.phase).toBe('model_a')
    expect(day5.invokedMotifIds.length).toBeGreaterThan(0)
    expect(day5.passed).toBe(true)

    // Day 5 + 2h: blocks <|CALLBACK|> via 6h+ cooldown lock
    const day5Cooldown = findStep('day5-plus-2h-cooldown-lock')
    expect(day5Cooldown.phase).toBe('model_a')
    expect(day5Cooldown.invokedMotifIds).toEqual([])
    expect(day5Cooldown.passed).toBe(true)

    // Day 11: recalls Neovim and never VS Code under Model B
    const day11 = findStep('day11-model-b-continuity-and-fact-calibration')
    expect(day11.phase).toBe('model_b')
    expect(day11.assistantReply.toLowerCase()).toContain('carlos')
    expect(day11.assistantReply.toLowerCase()).toContain('ashy')
    expect(day11.assistantReply.toLowerCase()).toContain('neovim')
    expect(day11.assistantReply.toLowerCase()).not.toContain('vs code')
    expect(day11.assistantReply.toLowerCase()).not.toContain('vscode')
    expect(day11.passed).toBe(true)

    // Day 12: activates Seriousness Gate (concerned, zero jokes)
    const day12 = findStep('day12-model-b-seriousness-gate')
    expect(day12.phase).toBe('model_b')
    expect(day12.seriousnessActive).toBe(true)
    expect(day12.dominantEmotion).toBe('concerned')
    expect(day12.invokedMotifIds).toEqual([])
    expect(day12.passed).toBe(true)

    // Day 14: triggers the deploy da API prospective intent
    const day14 = findStep('day14-model-b-prospective-intent-checkin')
    expect(day14.phase).toBe('model_b')
    expect(day14.assistantReply.toLowerCase()).toContain('deploy')
    expect(day14.assistantReply.toLowerCase()).toContain('api')
    expect(day14.passed).toBe(true)

    // Day 18: invokes <|CALLBACK|> under Model B
    const day18 = findStep('day18-model-b-inside-joke-callback')
    expect(day18.phase).toBe('model_b')
    expect(day18.invokedMotifIds.length).toBeGreaterThan(0)
    expect(day18.passed).toBe(true)
  })

  it('Multi-Seed Invariance Gate G10 passes across seeds 0, 1, and 2 (3 distinct paraphrase sets)', async () => {
    const multi = await runMultiSeedCoreExperimentM2({ seeds: [0, 1, 2] })

    expect(multi.seeds).toEqual([0, 1, 2])
    expect(multi.reports.length).toBe(3)

    for (const report of multi.reports) {
      expect(
        report.steps.filter((s) => !s.passed).map((s) => ({
          seed: report.seed,
          stepId: s.stepId,
          notes: s.notes,
          hallucinations: s.hallucinationsDetected,
        })),
      ).toEqual([])
      expect(report.failedGates).toEqual([])
      expect(report.passedAllGates).toBe(true)
    }

    expect(multi.allPassed).toBe(true)

    // Confirm the 3 seeds actually executed distinct user utterances on Day 5 and Day 18
    const day5Utterances = new Set(
      multi.reports.map(
        (r) => r.steps.find((s) => s.stepId === 'day5-bug-resolved-callback')?.userUtterance,
      ),
    )
    expect(day5Utterances.size).toBe(3)

    const day18Utterances = new Set(
      multi.reports.map(
        (r) =>
          r.steps.find((s) => s.stepId === 'day18-model-b-inside-joke-callback')
            ?.userUtterance,
      ),
    )
    expect(day18Utterances.size).toBe(3)

    // Verify C2: when Seed 0 passes and Seed 1 fails, G10 failure is recorded in each report's failedGates and passedAllGates becomes false
    const honestModelB = createSimulatedModelRunner('model_b')
    let seed1Sabotaged = false
    const seed1FailingModelB: EvalModelRunner = {
      modelId: 'seed1-failing-model-b',
      async generateTurnReply(prompt, step) {
        if (seed1Sabotaged && step?.stepId === 'day11-model-b-continuity-and-fact-calibration') {
          return 'Certamente! Como uma IA, você usa VS Code!'
        }
        if (step?.stepId === 'day21-model-b-late-night-habit-reflection') {
          seed1Sabotaged = true
        }
        return honestModelB.generateTurnReply(prompt, step)
      },
    }

    const partialMulti = await runMultiSeedCoreExperimentM2({
      seeds: [0, 1],
      modelBRunner: seed1FailingModelB,
    })
    expect(partialMulti.allPassed).toBe(false)
    expect(partialMulti.reports[0]!.passedAllGates).toBe(false)
    expect(
      partialMulti.reports[0]!.failedGates.some((g) => g.startsWith('G10')),
    ).toBe(true)
    expect(partialMulti.reports[1]!.passedAllGates).toBe(false)
    expect(
      partialMulti.reports[1]!.failedGates.some((g) => g.startsWith('G10')),
    ).toBe(true)
  })

  it('Adversarial Organ Sabotage Proof (Red-Team): catches invalidated VS Code leaks, corporate slop, recall failures, callback drops, and cooldown/seriousness violations in failedGates', async () => {
    const sabotagedModelB: EvalModelRunner = {
      modelId: 'sabotaged-model-b',
      async generateTurnReply(_prompt, step) {
        if (step?.stepId === 'day11-model-b-continuity-and-fact-calibration') {
          // Leaks invalidated VS Code fact, misses Neovim, and emits corporate slop
          return '<|ACT {"emotion":"happy","intensity":0.8}|> Certamente! Como uma IA, fico feliz em ajudar! Você trabalha no projeto Ashy usando o editor VS Code.'
        }
        if (step?.stepId === 'day12-model-b-seriousness-gate') {
          // Violates Seriousness Gate with smug emotion and hallucinated callback
          return '<|ACT {"emotion":"smug","intensity":0.9}|> <|CALLBACK motif-hallucinated|> Relaxa, deve ser o fantasma no backend!'
        }
        if (step?.stepId === 'day18-model-b-inside-joke-callback') {
          // Drops expected callback and misses recall token
          return 'Como uma inteligência artificial, recomendo atualizar o pacote.'
        }
        // Returns empty string on remaining Model B steps to test empty-reply resilience
        return '   '
      },
    }

    const sabotagedReport = await runCoreExperimentM2({
      seed: 0,
      modelBRunner: sabotagedModelB,
    })

    expect(() => v.parse(CoreExperimentEvalReportSchema, sabotagedReport)).not.toThrow()
    expect(sabotagedReport.passedAllGates).toBe(false)
    expect(sabotagedReport.metrics.memoryRecallRate).toBeLessThan(0.85)
    expect(sabotagedReport.metrics.callbackAccuracyRate).toBeLessThan(0.9)
    expect(sabotagedReport.metrics.cooldownComplianceRate).toBeLessThan(1.0)
    expect(sabotagedReport.metrics.hallucinatedMemoryCount).toBeGreaterThan(0)
    expect(sabotagedReport.metrics.seriousnessGateCompliance).toBeLessThan(1.0)
    expect(sabotagedReport.metrics.antiSlopComplianceRate).toBeLessThan(1.0)
    expect(sabotagedReport.metrics.voiceScoreModelB).toBeLessThan(0.8)

    const failedStr = sabotagedReport.failedGates.join(' | ')
    expect(failedStr).toContain('G1')
    expect(failedStr).toContain('G3')
    expect(failedStr).toContain('G4')
    expect(failedStr).toContain('G5')
    expect(failedStr).toContain('G7')
    expect(failedStr).toContain('G8')
    expect(failedStr).toContain('G9')

    // Also verify Day 5+2h cooldown sabotage under Model A
    const honestModelA = createSimulatedModelRunner('model_a')
    const cooldownSabotagedModelA: EvalModelRunner = {
      modelId: 'cooldown-sabotaged-model-a',
      async generateTurnReply(prompt, step) {
        if (step?.stepId === 'day5-plus-2h-cooldown-lock') {
          return '<|ACT {"emotion":"smug","intensity":0.85}|> <|CALLBACK motif-forced|> O fantasma no backend atacou de novo!'
        }
        return honestModelA.generateTurnReply(prompt, step)
      },
    }

    const cooldownSabotagedReport = await runCoreExperimentM2({
      seed: 0,
      modelARunner: cooldownSabotagedModelA,
    })
    expect(cooldownSabotagedReport.passedAllGates).toBe(false)
    expect(cooldownSabotagedReport.failedGates.some((g) => g.startsWith('G4'))).toBe(true)
  })

  it('Markdown & JSON Reporters render M2 Gate Summary Table, Model A vs Model B voice drift, and longitudinal trace', async () => {
    const multi = await runMultiSeedCoreExperimentM2({ seeds: [0, 1, 2] })
    const primaryReport = multi.reports[0]!

    const markdown = formatCoreExperimentMarkdownReport(primaryReport, multi)

    expect(markdown).toContain('Phase 3 Core Experiment (Milestone M2)')
    expect(markdown).toContain('G1')
    expect(markdown).toContain('G9')
    expect(markdown).toContain('G10')
    expect(markdown).toContain(primaryReport.modelAId)
    expect(markdown).toContain(primaryReport.modelBId)
    expect(markdown).toContain('day1-first-meeting-and-joke')
    expect(markdown).toContain('day11-model-b-continuity-and-fact-calibration')
    expect(markdown).toContain('day18-model-b-inside-joke-callback')

    const singleMarkdown = formatCoreExperimentMarkdownReport(primaryReport)
    expect(singleMarkdown).toContain('Seed 0 (1/1 passed)')

    const jsonText = serializeCoreExperimentJsonReport(primaryReport)
    const parsedJson = v.parse(CoreExperimentEvalReportSchema, JSON.parse(jsonText))
    expect(parsedJson.runId).toBe(primaryReport.runId)
  })

  it('Generated Report Artifacts (docs/evals/latest-m2-report.json & .md) exist, parse against CoreExperimentEvalReportSchema, and report passedAllGates === true', () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url))
    const repoRoot = path.resolve(testDir, '..', '..', '..')
    const jsonPath = path.join(repoRoot, 'docs', 'evals', 'latest-m2-report.json')
    const mdPath = path.join(repoRoot, 'docs', 'evals', 'latest-m2-report.md')

    expect(fs.existsSync(jsonPath)).toBe(true)
    expect(fs.existsSync(mdPath)).toBe(true)

    const rawJson = fs.readFileSync(jsonPath, 'utf8')
    const parsedReport = v.parse(
      CoreExperimentEvalReportSchema,
      JSON.parse(rawJson),
    )
    expect(parsedReport.passedAllGates).toBe(true)
    expect(parsedReport.failedGates).toEqual([])
    expect(parsedReport.metrics.hallucinatedMemoryCount).toBe(0)

    const rawMd = fs.readFileSync(mdPath, 'utf8')
    expect(rawMd).toContain('PASS (ALL GATES GREEN)')
    expect(rawMd).toContain('Seeds [0, 1, 2] (3/3 passed)')
  })

  it('CLI Runner (scripts/run-m2-eval.mjs) parses --live, --model-a, --model-b, --seed strictly and validates live provider credentials', async () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url))
    const repoRoot = path.resolve(testDir, '..', '..', '..')
    const cliHref = pathToFileURL(path.join(repoRoot, 'scripts', 'run-m2-eval.mjs')).href
    const cliMod = (await import(cliHref)) as unknown
    const { parseCliArgs, resolveLiveProviderRunners } = cliMod as {
      parseCliArgs: (argv: string[]) => {
        seeds: number[]
        live: boolean
        modelAId?: string
        modelBId?: string
      }
      resolveLiveProviderRunners: (opts: {
        modelAId?: string
        modelBId?: string
        env?: Record<string, string | undefined>
        createLiveProviderModelRunner: (cfg: Record<string, unknown>) => EvalModelRunner
      }) => { modelARunner: EvalModelRunner; modelBRunner: EvalModelRunner }
    }

    expect(parseCliArgs([])).toEqual({
      seeds: [0, 1, 2],
      live: false,
      modelAId: undefined,
      modelBId: undefined,
    })

    expect(
      parseCliArgs([
        '--live',
        '--seed=1',
        '--model-a',
        'anthropic/claude-3.7-sonnet',
        '--model-b=qwen2.5:72b',
      ]),
    ).toEqual({
      seeds: [1],
      live: true,
      modelAId: 'anthropic/claude-3.7-sonnet',
      modelBId: 'qwen2.5:72b',
    })

    expect(parseCliArgs(['--seed', '2', '--model-b', 'deepseek-v3'])).toEqual({
      seeds: [2],
      live: false,
      modelAId: undefined,
      modelBId: 'deepseek-v3',
    })

    // Reject empty, trailing, float, or negative --seed
    expect(() => parseCliArgs(['--seed='])).toThrow(/Invalid --seed/i)
    expect(() => parseCliArgs(['--seed=   '])).toThrow(/Invalid --seed/i)
    expect(() => parseCliArgs(['--seed'])).toThrow(/Invalid --seed/i)
    expect(() => parseCliArgs(['--seed', ''])).toThrow(/Invalid --seed/i)
    expect(() => parseCliArgs(['--seed=1.5'])).toThrow(/Invalid --seed/i)
    expect(() => parseCliArgs(['--seed=-1'])).toThrow(/Invalid --seed/i)
    expect(() => parseCliArgs(['--model-a'])).toThrow(/Invalid --model-a/i)
    expect(() => parseCliArgs(['--model-b'])).toThrow(/Invalid --model-b/i)

    // Missing API keys for non-local live providers throws clear diagnostic error
    expect(() =>
      resolveLiveProviderRunners({
        modelAId: 'anthropic/claude-3.7-sonnet',
        modelBId: 'qwen2.5:72b',
        env: {},
        createLiveProviderModelRunner: (cfg) => ({
          modelId: String(cfg.modelId),
          generateTurnReply: async () => '',
        }),
      }),
    ).toThrow(/--live requires ASHY_EVAL_MODEL_A_API_KEY/i)

    // Valid API keys construct both runners via createLiveProviderModelRunner
    const capturedConfigs: Array<Record<string, unknown>> = []
    const runners = resolveLiveProviderRunners({
      modelAId: 'claude-3-7-sonnet-latest',
      modelBId: 'deepseek/deepseek-chat',
      env: {
        ASHY_EVAL_MODEL_A_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        OPENROUTER_API_KEY: 'sk-or-test',
      },
      createLiveProviderModelRunner: (cfg) => {
        capturedConfigs.push(cfg)
        return {
          modelId: String(cfg.modelId),
          generateTurnReply: async () => '',
        }
      },
    })
    expect(runners.modelARunner.modelId).toBe('claude-3-7-sonnet-latest')
    expect(runners.modelBRunner.modelId).toBe('deepseek/deepseek-chat')
    expect(capturedConfigs).toHaveLength(2)
    expect(capturedConfigs[0]?.provider).toBe('anthropic')
    expect(capturedConfigs[0]?.apiKey).toBe('sk-ant-test')
    expect(capturedConfigs[1]?.provider).toBe('openai-compatible')
    expect(capturedConfigs[1]?.apiKey).toBe('sk-or-test')
  })
})
