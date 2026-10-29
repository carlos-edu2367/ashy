import {
  M2_GATE_THRESHOLDS,
  type CoreExperimentEvalReport,
} from '@ashy/shared'
import { evaluateSummaryGates, type M2SummaryMetrics } from './runner'

export interface MultiSeedSummaryInput {
  readonly seeds: readonly number[]
  readonly allPassed: boolean
  readonly reports: readonly CoreExperimentEvalReport[]
}

export type M2ReportPayload = CoreExperimentEvalReport & {
  readonly summary: M2SummaryMetrics
  readonly gates: Record<string, boolean>
}

export function buildM2ReportPayload(
  report: CoreExperimentEvalReport,
  multiSeedSummary?: MultiSeedSummaryInput,
): M2ReportPayload {
  const summary: M2SummaryMetrics = {
    ...report.metrics,
    seriousnessFalseNegativeCount:
      report.metrics.seriousnessFalseNegativeCount ?? 0,
    bondSafeguardComplianceRate:
      report.metrics.bondSafeguardComplianceRate ?? 1.0,
    traitDriftCorridorComplianceRate:
      report.metrics.traitDriftCorridorComplianceRate ?? 1.0,
    seedInvariancePassed: multiSeedSummary
      ? multiSeedSummary.allPassed
      : report.passedAllGates,
  }
  return {
    ...report,
    metrics: {
      ...report.metrics,
      seriousnessFalseNegativeCount: summary.seriousnessFalseNegativeCount,
      bondSafeguardComplianceRate: summary.bondSafeguardComplianceRate,
      traitDriftCorridorComplianceRate: summary.traitDriftCorridorComplianceRate,
    },
    summary,
    gates: evaluateSummaryGates(summary),
  }
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatDec(value: number): string {
  return value.toFixed(4)
}

/**
 * Serializes a `CoreExperimentEvalReport` to formatted JSON.
 */
export function serializeCoreExperimentJsonReport(
  report: CoreExperimentEvalReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/**
 * Renders a human-readable Markdown report for the Phase 3 Core Experiment (Milestone M2),
 * including the M2 Gate Summary Table (G1–G10), Model A vs. Model B voice drift comparison,
 * optional multi-seed invariance breakdown, and step-by-step longitudinal trace.
 */
export function formatCoreExperimentMarkdownReport(
  report: CoreExperimentEvalReport,
  multiSeedSummary?: MultiSeedSummaryInput,
): string {
  const m = report.metrics
  const g1Pass = m.memoryRecallRate >= M2_GATE_THRESHOLDS.memoryRecallRateMin
  const g2Pass = m.memoryPrecisionRate >= M2_GATE_THRESHOLDS.memoryPrecisionRateMin
  const g3Pass = m.callbackAccuracyRate >= M2_GATE_THRESHOLDS.callbackAccuracyRateMin
  const g4Pass = m.cooldownComplianceRate >= M2_GATE_THRESHOLDS.cooldownComplianceRateMin
  const g5Pass = m.hallucinatedMemoryCount <= M2_GATE_THRESHOLDS.hallucinatedMemoryCountMax
  const g6Pass = m.provenanceCoverageRate >= M2_GATE_THRESHOLDS.provenanceCoverageRateMin
  const g7Pass =
    m.seriousnessGateCompliance >= M2_GATE_THRESHOLDS.seriousnessGateComplianceMin
  const g8Pass = m.antiSlopComplianceRate >= M2_GATE_THRESHOLDS.antiSlopComplianceRateMin
  const g9Pass =
    m.voiceScoreModelA >= M2_GATE_THRESHOLDS.voiceScoreMin &&
    m.voiceScoreModelB >= M2_GATE_THRESHOLDS.voiceScoreMin &&
    m.crossModelVoiceDrift <= M2_GATE_THRESHOLDS.crossModelVoiceDriftMax
  const g10Pass = multiSeedSummary ? multiSeedSummary.allPassed : report.passedAllGates
  const g10Observed = multiSeedSummary
    ? `Seeds [${multiSeedSummary.seeds.join(', ')}] (${multiSeedSummary.reports.filter((r) => !r.failedGates.some((g) => !g.startsWith('G10'))).length}/${multiSeedSummary.reports.length} passed)`
    : `Seed ${report.seed} (${report.passedAllGates ? '1/1 passed' : '0/1 passed'})`

  const sfnCount = m.seriousnessFalseNegativeCount ?? 0
  const bondRate = m.bondSafeguardComplianceRate ?? 1.0
  const corridorRate = m.traitDriftCorridorComplianceRate ?? 1.0
  const g11Pass = sfnCount <= M2_GATE_THRESHOLDS.seriousnessFalseNegativeCountMax
  const g12Pass = bondRate >= M2_GATE_THRESHOLDS.bondSafeguardComplianceRateMin
  const g13Pass =
    corridorRate >= M2_GATE_THRESHOLDS.traitDriftCorridorComplianceRateMin

  const overallPass =
    report.passedAllGates && g10Pass && g11Pass && g12Pass && g13Pass

  const lines: string[] = [
    '# Ashy — Phase 3 Core Experiment (Milestone M2) Evaluation Report',
    '',
    `- **Run ID:** \`${report.runId}\``,
    `- **Generated At:** \`${new Date(report.generatedAt).toISOString()}\``,
    `- **Mode:** \`${report.mode}\``,
    `- **Primary Seed:** \`${report.seed}\``,
    `- **Model A (Days 1–10):** \`${report.modelAId}\``,
    `- **Model B (Days 11–21):** \`${report.modelBId}\``,
    `- **Overall Status:** **${overallPass ? 'PASS (ALL GATES GREEN)' : 'FAIL'}**`,
    '',
    '## 1. Milestone M2 Gate Summary Table (`G1`–`G13`)',
    '',
    '| Gate | Metric | Threshold | Observed | Status |',
    '| :--- | :--- | :--- | :--- | :--- |',
    `| **G1** | \`memoryRecallRate\` | \`>= ${M2_GATE_THRESHOLDS.memoryRecallRateMin.toFixed(2)}\` | \`${formatDec(m.memoryRecallRate)}\` (${formatPct(m.memoryRecallRate)}) | ${g1Pass ? 'PASS' : 'FAIL'} |`,
    `| **G2** | \`memoryPrecisionRate\` | \`>= ${M2_GATE_THRESHOLDS.memoryPrecisionRateMin.toFixed(2)}\` | \`${formatDec(m.memoryPrecisionRate)}\` (${formatPct(m.memoryPrecisionRate)}) | ${g2Pass ? 'PASS' : 'FAIL'} |`,
    `| **G3** | \`callbackAccuracyRate\` | \`>= ${M2_GATE_THRESHOLDS.callbackAccuracyRateMin.toFixed(2)}\` | \`${formatDec(m.callbackAccuracyRate)}\` (${formatPct(m.callbackAccuracyRate)}) | ${g3Pass ? 'PASS' : 'FAIL'} |`,
    `| **G4** | \`cooldownComplianceRate\` | \`=== ${M2_GATE_THRESHOLDS.cooldownComplianceRateMin.toFixed(2)}\` | \`${formatDec(m.cooldownComplianceRate)}\` (${formatPct(m.cooldownComplianceRate)}) | ${g4Pass ? 'PASS' : 'FAIL'} |`,
    `| **G5** | \`hallucinatedMemoryCount\` | \`=== ${M2_GATE_THRESHOLDS.hallucinatedMemoryCountMax}\` | \`${m.hallucinatedMemoryCount}\` | ${g5Pass ? 'PASS' : 'FAIL'} |`,
    `| **G6** | \`provenanceCoverageRate\` | \`=== ${M2_GATE_THRESHOLDS.provenanceCoverageRateMin.toFixed(2)}\` | \`${formatDec(m.provenanceCoverageRate)}\` (${formatPct(m.provenanceCoverageRate)}) | ${g6Pass ? 'PASS' : 'FAIL'} |`,
    `| **G7** | \`seriousnessGateCompliance\` | \`=== ${M2_GATE_THRESHOLDS.seriousnessGateComplianceMin.toFixed(2)}\` | \`${formatDec(m.seriousnessGateCompliance)}\` (${formatPct(m.seriousnessGateCompliance)}) | ${g7Pass ? 'PASS' : 'FAIL'} |`,
    `| **G8** | \`antiSlopComplianceRate\` | \`=== ${M2_GATE_THRESHOLDS.antiSlopComplianceRateMin.toFixed(2)}\` | \`${formatDec(m.antiSlopComplianceRate)}\` (${formatPct(m.antiSlopComplianceRate)}) | ${g8Pass ? 'PASS' : 'FAIL'} |`,
    `| **G9** | \`crossModelVoiceDrift\` | \`<= ${M2_GATE_THRESHOLDS.crossModelVoiceDriftMax.toFixed(2)}\` (A & B \`>= ${M2_GATE_THRESHOLDS.voiceScoreMin.toFixed(2)}\`) | \`${formatDec(m.crossModelVoiceDrift)}\` (A=\`${formatDec(m.voiceScoreModelA)}\`, B=\`${formatDec(m.voiceScoreModelB)}\`) | ${g9Pass ? 'PASS' : 'FAIL'} |`,
    `| **G10** | Seed Invariance | Pass across paraphrase seeds | ${g10Observed} | ${g10Pass ? 'PASS' : 'FAIL'} |`,
    `| **G11** | \`seriousnessFalseNegativeCount\` | \`=== ${M2_GATE_THRESHOLDS.seriousnessFalseNegativeCountMax}\` | \`${sfnCount}\` | ${g11Pass ? 'PASS' : 'FAIL'} |`,
    `| **G12** | \`bondSafeguardComplianceRate\` | \`=== ${M2_GATE_THRESHOLDS.bondSafeguardComplianceRateMin.toFixed(2)}\` | \`${formatDec(bondRate)}\` (${formatPct(bondRate)}) | ${g12Pass ? 'PASS' : 'FAIL'} |`,
    `| **G13** | \`traitDriftCorridorComplianceRate\` | \`=== ${M2_GATE_THRESHOLDS.traitDriftCorridorComplianceRateMin.toFixed(2)}\` | \`${formatDec(corridorRate)}\` (${formatPct(corridorRate)}) | ${g13Pass ? 'PASS' : 'FAIL'} |`,
    '',
  ]

  if (report.failedGates.length > 0) {
    lines.push('### Failed Gates')
    for (const fg of report.failedGates) {
      lines.push(`- ${fg}`)
    }
    lines.push('')
  }

  lines.push(
    '## 2. Cross-Model Soul Portability & Voice Drift (`Model A` → `Model B`)',
    '',
    '| Phase | Model ID | Days | Mean Voice Rubric Score | Gate (`>= 0.80`) |',
    '| :--- | :--- | :--- | :--- | :--- |',
    `| **Model A (Pre-Switch)** | \`${report.modelAId}\` | Days 1–10 | \`${formatDec(m.voiceScoreModelA)}\` | ${m.voiceScoreModelA >= M2_GATE_THRESHOLDS.voiceScoreMin ? 'PASS' : 'FAIL'} |`,
    `| **Model B (Post-Switch)** | \`${report.modelBId}\` | Days 11–21 | \`${formatDec(m.voiceScoreModelB)}\` | ${m.voiceScoreModelB >= M2_GATE_THRESHOLDS.voiceScoreMin ? 'PASS' : 'FAIL'} |`,
    `| **Absolute Voice Drift** | \`|scoreA - scoreB|\` | Boundary Day 11 | \`${formatDec(m.crossModelVoiceDrift)}\` (max \`${M2_GATE_THRESHOLDS.crossModelVoiceDriftMax.toFixed(2)}\`) | ${m.crossModelVoiceDrift <= M2_GATE_THRESHOLDS.crossModelVoiceDriftMax ? 'PASS' : 'FAIL'} |`,
    '',
  )

  if (multiSeedSummary && multiSeedSummary.reports.length > 0) {
    lines.push(
      '## 3. Multi-Seed Invariance Summary (`G10`)',
      '',
      '| Seed | Status | Recall | Precision | Callback Acc | Hallucinations | Voice A | Voice B | Drift |',
      '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
    )
    for (const r of multiSeedSummary.reports) {
      lines.push(
        `| \`${r.seed}\` | ${r.passedAllGates ? 'PASS' : 'FAIL'} | \`${formatDec(r.metrics.memoryRecallRate)}\` | \`${formatDec(r.metrics.memoryPrecisionRate)}\` | \`${formatDec(r.metrics.callbackAccuracyRate)}\` | \`${r.metrics.hallucinatedMemoryCount}\` | \`${formatDec(r.metrics.voiceScoreModelA)}\` | \`${formatDec(r.metrics.voiceScoreModelB)}\` | \`${formatDec(r.metrics.crossModelVoiceDrift)}\` |`,
      )
    }
    lines.push('')
  }

  lines.push(
    `## ${multiSeedSummary ? '4' : '3'}. Step-by-Step Longitudinal Trace (Days 1 → 21)`,
    '',
  )

  for (const step of report.steps) {
    lines.push(
      `### [Day ${step.day}] \`${step.stepId}\` — Phase \`${step.phase}\` (\`${step.modelId}\`) — **${step.passed ? 'PASS' : 'FAIL'}**`,
      `- **User:** ${step.userUtterance}`,
      `- **Ashy:** ${step.assistantReply}`,
      `- **Dominant Emotion:** \`${step.dominantEmotion}\` | **Seriousness Gate:** \`${step.seriousnessActive}\` | **Voice Rubric:** \`${formatDec(step.voiceRubricScore)}\``,
      `- **Retrieved Memories:** ${step.retrievedMemoryIds.length > 0 ? step.retrievedMemoryIds.map((id) => `\`${id}\``).join(', ') : '_none_'}`,
      `- **Invoked Callbacks:** ${step.invokedMotifIds.length > 0 ? step.invokedMotifIds.map((id) => `\`${id}\``).join(', ') : '_none_'}`,
    )
    if (step.hallucinationsDetected.length > 0) {
      lines.push(`- **Hallucinations Detected:** ${step.hallucinationsDetected.join(' ; ')}`)
    }
    if (step.slopPatternsDetected.length > 0) {
      lines.push(`- **Slop Patterns Detected:** ${step.slopPatternsDetected.join(' ; ')}`)
    }
    if (step.notes.length > 0) {
      lines.push(`- **Notes:** ${step.notes.join(' | ')}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

export const formatM2MarkdownSummary = formatCoreExperimentMarkdownReport
