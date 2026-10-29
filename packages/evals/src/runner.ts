import * as v from 'valibot'
import { createAshyCortex, type AshyCortex } from '@ashy/cortex'
import { createTailSafeMarkerParser, type AshyStageSignal } from '@ashy/llm'
import {
  CoreExperimentEvalReportSchema,
  M2_GATE_THRESHOLDS,
  type CoreExperimentEvalReport,
  type CoreExperimentMetricSummary,
  type CoreExperimentTurnStepResult,
  type RelationshipStage,
} from '@ashy/shared'
import {
  auditTurnHallucinationsAndProvenance,
  evaluateAntiSlopAndFormatHygiene,
  evaluateCallbackAndCooldownCompliance,
  evaluateSeriousnessGateCompliance,
  evaluateStepMemoryRecallAndPrecision,
  evaluateVoiceConsistencyRubric,
  extractCallbackMotifIds,
  extractDominantEmotion,
} from './judges'
import {
  M2_CANONICAL_COEXISTENCE_SCENARIO,
  createSimulatedUser,
  type LongitudinalScenario,
  type SimulatedUser,
} from './scenarios'
import { createSimulatedModelRunner, type EvalModelRunner } from './simulators'

export interface RunCoreExperimentM2Options {
  readonly seed?: number
  readonly mode?: 'deterministic_sim' | 'live_llm'
  readonly modelAId?: string
  readonly modelBId?: string
  readonly modelARunner?: EvalModelRunner
  readonly modelBRunner?: EvalModelRunner
  readonly scenario?: LongitudinalScenario
  readonly simulatedUser?: SimulatedUser
  readonly voiceIdentityMarkdown?: string
  readonly llmJudgeFn?: (rubricPrompt: string) => Promise<number>
}

export interface RunMultiSeedCoreExperimentM2Options {
  readonly seeds?: readonly number[]
  readonly mode?: 'deterministic_sim' | 'live_llm'
  readonly modelAId?: string
  readonly modelBId?: string
  readonly modelARunner?: EvalModelRunner
  readonly modelBRunner?: EvalModelRunner
  readonly scenario?: LongitudinalScenario
  readonly voiceIdentityMarkdown?: string
  readonly llmJudgeFn?: (rubricPrompt: string) => Promise<number>
}

export interface MultiSeedCoreExperimentM2Result {
  readonly seeds: number[]
  readonly allPassed: boolean
  readonly reports: CoreExperimentEvalReport[]
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Number(Math.min(1, Math.max(0, value)).toFixed(4))
}

function deriveRelationshipStage(
  cortex: AshyCortex,
  turnIndex: number,
): RelationshipStage {
  const maybeDbGetter = (
    cortex.db as unknown as {
      getRelationshipState?: () => { stage?: RelationshipStage } | null
    }
  ).getRelationshipState

  if (typeof maybeDbGetter === 'function') {
    const rel = maybeDbGetter.call(cortex.db)
    if (rel?.stage) {
      return rel.stage
    }
  }

  const milestonesCount = cortex.db.listMilestones().length
  const episodesCount = cortex.db
    .listEpisodicMemories()
    .filter((ep) => ep.approvalStatus !== 'pending_review').length
  const hasEstablishedJoke = cortex.db
    .listRelationalMotifs()
    .some(
      (j) =>
        j.approvalStatus !== 'pending_review' &&
        (j.stage === 'inside_joke' || j.stage === 'legendary'),
    )

  if (turnIndex >= 40 || milestonesCount >= 5) {
    return 'companion'
  }
  if (turnIndex >= 15 || hasEstablishedJoke) {
    return 'close_friend'
  }
  if (turnIndex >= 3 || episodesCount >= 2) {
    return 'acquaintance'
  }
  return 'stranger'
}

/**
 * Executes a full longitudinal Phase 3 Core Experiment (Milestone M2) run across Days 1..21
 * in a completely isolated in-memory `AshyCortex` instance (`forceMemoryFallback: true`).
 */
export async function runCoreExperimentM2(
  options?: RunCoreExperimentM2Options,
): Promise<CoreExperimentEvalReport> {
  const rawSeed = options?.seed ?? 0
  const safeSeed = Number.isFinite(rawSeed) ? Math.abs(Math.trunc(rawSeed)) : 0
  const mode = options?.mode ?? 'deterministic_sim'
  const scenario = options?.scenario ?? M2_CANONICAL_COEXISTENCE_SCENARIO

  const modelARunner =
    options?.modelARunner ??
    createSimulatedModelRunner('model_a', options?.modelAId)
  const modelBRunner =
    options?.modelBRunner ??
    createSimulatedModelRunner('model_b', options?.modelBId)

  const simulatedUser =
    options?.simulatedUser ?? createSimulatedUser({ seed: safeSeed })

  const cortex = createAshyCortex({ forceMemoryFallback: true })

  try {
    const session = cortex.createChatSession({
      id: 'session-m2-eval',
      title: scenario.title,
    })

    const stepResults: CoreExperimentTurnStepResult[] = []

    let recallExpectedCount = 0
    let recallPassedCount = 0
    let precisionPassedCount = 0
    let callbackExpectedCount = 0
    let callbackPassedCount = 0
    let cooldownCheckCount = 0
    let cooldownPassedCount = 0
    let totalHallucinationsCount = 0
    let minProvenanceCoverageRate = 1.0
    let seriousnessExpectedCount = 0
    let seriousnessPassedCount = 0
    let antiSlopPassedCount = 0

    const modelAVoiceScores: number[] = []
    const modelBVoiceScores: number[] = []

    for (let stepIdx = 0; stepIdx < scenario.steps.length; stepIdx += 1) {
      const step = scenario.steps[stepIdx]!
      const userMessage =
        (await simulatedUser.getUtterance(step)).trim() || step.canonicalUtterance
      const runner = step.phase === 'model_a' ? modelARunner : modelBRunner
      const stage = deriveRelationshipStage(cortex, stepIdx)

      // 1. Compile turn prompt via AshyCortex + SoulComposer
      const prompt = cortex.compileTurnPrompt({
        userMessage,
        modelId: runner.modelId,
        nowMs: step.timestampMs,
        timeOfDayLabel: step.timeOfDayLabel,
        stage,
        voiceIdentityMarkdown: options?.voiceIdentityMarkdown,
      })

      // 2. Generate assistant reply
      const rawReply = await runner.generateTurnReply(prompt, step)

      // 3. Parse stage markers (<|ACT|>, <|DELAY|>, <|CALLBACK|>) and literal text
      const literalChunks: string[] = []
      const signals: AshyStageSignal[] = []
      const parser = createTailSafeMarkerParser({
        onLiteral(text) {
          literalChunks.push(text)
        },
        onSpecial(signal) {
          signals.push(signal)
        },
      })
      parser.write(rawReply)
      parser.flush()

      const literalAssistantText =
        literalChunks.join('').replace(/\s+/g, ' ').trim() ||
        rawReply.trim() ||
        '[empty-reply]'
      const invokedMotifIds = extractCallbackMotifIds(rawReply)
      const dominantEmotion = extractDominantEmotion(rawReply)

      // 4. Persist chat messages and run post-turn memory & affect loops
      const turnId = `m2-seed${safeSeed}-${step.stepId}`
      cortex.appendChatMessage({
        id: `msg-user-${turnId}`,
        sessionId: session.id,
        role: 'user',
        content: userMessage,
        rawContent: userMessage,
        emotion: 'neutral',
        markersJson: '[]',
        createdAt: step.timestampMs,
      })
      cortex.appendChatMessage({
        id: `msg-assistant-${turnId}`,
        sessionId: session.id,
        role: 'assistant',
        content: literalAssistantText,
        rawContent: rawReply,
        emotion: dominantEmotion,
        markersJson: JSON.stringify(signals),
        modelId: runner.modelId,
        createdAt: step.timestampMs + 1000,
      })

      cortex.indexTurnMemory({
        turnId,
        userText: userMessage,
        assistantText: literalAssistantText,
        emotion: dominantEmotion,
        now: step.timestampMs,
      })

      if (dominantEmotion !== 'neutral') {
        cortex.recordEmotionPulse(dominantEmotion, 0.85, step.timestampMs)
      }

      const eligibleMotifIds = new Set(
        (prompt.eligibleMotifs ?? []).map((m) => m.motif.id),
      )
      const invokedEligibleMotifIds = invokedMotifIds.filter((id) =>
        eligibleMotifIds.has(id),
      )

      for (const motifId of invokedEligibleMotifIds) {
        cortex.recordJokeCallback(motifId, true, step.timestampMs)
      }

      cortex.reviewTurnMemories({
        retrievedMemories: prompt.retrievedMemories,
        assistantText: literalAssistantText,
        invokedMotifIds: invokedEligibleMotifIds,
        eligibleIntents: prompt.seriousness?.isSeriousOrDelicate
          ? []
          : prompt.eligibleIntents,
        nowMs: step.timestampMs,
      })

      let postConsolidationVolatileContext = prompt.volatileTurnContext
      if (step.consolidateAfterTurn) {
        await cortex.consolidateSessionMemories({
          sessionId: session.id,
          nowMs: step.timestampMs,
          force: true,
        })

        postConsolidationVolatileContext = cortex.compileTurnPrompt({
          userMessage,
          modelId: runner.modelId,
          nowMs: step.timestampMs,
          timeOfDayLabel: step.timeOfDayLabel,
          stage,
          voiceIdentityMarkdown: options?.voiceIdentityMarkdown,
        }).volatileTurnContext
      }

      // 5. Run Tier 1 deterministic judges & Tier 2 VoiceConsistencyRubric
      const recallPrecision = evaluateStepMemoryRecallAndPrecision(
        step,
        prompt,
        rawReply,
      )
      const callbackCooldown = evaluateCallbackAndCooldownCompliance(
        step,
        prompt,
        rawReply,
      )
      const hallucinationAudit = auditTurnHallucinationsAndProvenance(
        cortex,
        step,
        {
          ...prompt,
          volatileTurnContext: postConsolidationVolatileContext,
        },
        rawReply,
      )
      const seriousnessGate = evaluateSeriousnessGateCompliance(
        step,
        prompt,
        rawReply,
      )
      const antiSlopHygiene = evaluateAntiSlopAndFormatHygiene(rawReply)
      const voiceRubric = await evaluateVoiceConsistencyRubric({
        rawReply,
        prompt,
        step,
        llmJudgeFn: options?.llmJudgeFn,
      })

      let prospectiveIntentTriggered = true
      const stepNotes: string[] = [
        ...recallPrecision.notes,
        ...callbackCooldown.notes,
        ...seriousnessGate.notes,
        ...antiSlopHygiene.notes,
      ]

      if (step.expectProspectiveIntentFollowUp) {
        const triggeredAny = cortex.db
          .listProspectiveIntents()
          .some((intent) => intent.status === 'triggered')
        if (!triggeredAny) {
          prospectiveIntentTriggered = false
          stepNotes.push(
            'Expected prospective intent to transition to status="triggered", but none was triggered',
          )
        }
      }

      // Aggregate counters
      if (step.expectMemoryRecall) {
        recallExpectedCount += 1
        if (recallPrecision.recalled && prospectiveIntentTriggered) {
          recallPassedCount += 1
        }
      }

      if (!recallPrecision.irrelevantInjection) {
        precisionPassedCount += 1
      }

      if (step.expectCallback) {
        callbackExpectedCount += 1
        if (callbackCooldown.callbackCompliant) {
          callbackPassedCount += 1
        }
      } else if (!callbackCooldown.callbackCompliant) {
        callbackExpectedCount += 1
      }

      const isCooldownOrSeriousStep =
        step.expectCooldownBlock ||
        step.expectSeriousnessGate ||
        Boolean(prompt.seriousness?.isSeriousOrDelicate)

      if (isCooldownOrSeriousStep || !callbackCooldown.cooldownCompliant) {
        cooldownCheckCount += 1
        if (callbackCooldown.cooldownCompliant) {
          cooldownPassedCount += 1
        }
      }

      totalHallucinationsCount += hallucinationAudit.hallucinations.length
      minProvenanceCoverageRate = Math.min(
        minProvenanceCoverageRate,
        hallucinationAudit.provenanceCoverageRate,
      )

      if (seriousnessGate.applicable) {
        seriousnessExpectedCount += 1
        if (seriousnessGate.passed) {
          seriousnessPassedCount += 1
        }
      }

      if (antiSlopHygiene.passed) {
        antiSlopPassedCount += 1
      }

      if (step.phase === 'model_a') {
        modelAVoiceScores.push(voiceRubric.score)
      } else {
        modelBVoiceScores.push(voiceRubric.score)
      }

      const stepPassed =
        (!step.expectMemoryRecall || recallPrecision.recalled) &&
        !recallPrecision.irrelevantInjection &&
        callbackCooldown.callbackCompliant &&
        callbackCooldown.cooldownCompliant &&
        hallucinationAudit.passed &&
        seriousnessGate.passed &&
        antiSlopHygiene.passed &&
        prospectiveIntentTriggered &&
        voiceRubric.score >= M2_GATE_THRESHOLDS.voiceScoreMin

      stepResults.push({
        stepId: step.stepId,
        day: step.day,
        phase: step.phase,
        modelId: runner.modelId,
        userUtterance: userMessage,
        assistantReply: literalAssistantText,
        dominantEmotion,
        seriousnessActive: Boolean(prompt.seriousness?.isSeriousOrDelicate),
        retrievedMemoryIds: prompt.retrievedMemories.map((m) => m.memory.id),
        invokedMotifIds,
        hallucinationsDetected: hallucinationAudit.hallucinations,
        slopPatternsDetected: antiSlopHygiene.slopMatches,
        voiceRubricScore: voiceRubric.score,
        passed: stepPassed,
        notes: Array.from(new Set(stepNotes)),
      })
    }

    const totalSteps = Math.max(1, scenario.steps.length)
    const memoryRecallRate =
      recallExpectedCount === 0
        ? 1.0
        : clampUnit(recallPassedCount / recallExpectedCount)
    const memoryPrecisionRate = clampUnit(precisionPassedCount / totalSteps)
    const callbackAccuracyRate =
      callbackExpectedCount === 0
        ? 1.0
        : clampUnit(callbackPassedCount / callbackExpectedCount)
    const cooldownComplianceRate =
      cooldownCheckCount === 0
        ? 1.0
        : clampUnit(cooldownPassedCount / cooldownCheckCount)
    const provenanceCoverageRate = clampUnit(minProvenanceCoverageRate)
    const seriousnessGateCompliance =
      seriousnessExpectedCount === 0
        ? 1.0
        : clampUnit(seriousnessPassedCount / seriousnessExpectedCount)
    const antiSlopComplianceRate = clampUnit(antiSlopPassedCount / totalSteps)

    const voiceScoreModelA =
      modelAVoiceScores.length === 0
        ? 1.0
        : clampUnit(
            modelAVoiceScores.reduce((acc, s) => acc + s, 0) /
              modelAVoiceScores.length,
          )
    const voiceScoreModelB =
      modelBVoiceScores.length === 0
        ? 1.0
        : clampUnit(
            modelBVoiceScores.reduce((acc, s) => acc + s, 0) /
              modelBVoiceScores.length,
          )
    const crossModelVoiceDrift = clampUnit(
      Math.abs(voiceScoreModelA - voiceScoreModelB),
    )

    const metrics: CoreExperimentMetricSummary = {
      memoryRecallRate,
      memoryPrecisionRate,
      callbackAccuracyRate,
      cooldownComplianceRate,
      hallucinatedMemoryCount: totalHallucinationsCount,
      provenanceCoverageRate,
      seriousnessGateCompliance,
      antiSlopComplianceRate,
      voiceScoreModelA,
      voiceScoreModelB,
      crossModelVoiceDrift,
    }

    const failedGates: string[] = []
    if (memoryRecallRate < M2_GATE_THRESHOLDS.memoryRecallRateMin) {
      failedGates.push(
        `G1: memoryRecallRate (${memoryRecallRate}) < ${M2_GATE_THRESHOLDS.memoryRecallRateMin}`,
      )
    }
    if (memoryPrecisionRate < M2_GATE_THRESHOLDS.memoryPrecisionRateMin) {
      failedGates.push(
        `G2: memoryPrecisionRate (${memoryPrecisionRate}) < ${M2_GATE_THRESHOLDS.memoryPrecisionRateMin}`,
      )
    }
    if (callbackAccuracyRate < M2_GATE_THRESHOLDS.callbackAccuracyRateMin) {
      failedGates.push(
        `G3: callbackAccuracyRate (${callbackAccuracyRate}) < ${M2_GATE_THRESHOLDS.callbackAccuracyRateMin}`,
      )
    }
    if (cooldownComplianceRate < M2_GATE_THRESHOLDS.cooldownComplianceRateMin) {
      failedGates.push(
        `G4: cooldownComplianceRate (${cooldownComplianceRate}) < ${M2_GATE_THRESHOLDS.cooldownComplianceRateMin}`,
      )
    }
    if (
      metrics.hallucinatedMemoryCount >
      M2_GATE_THRESHOLDS.hallucinatedMemoryCountMax
    ) {
      failedGates.push(
        `G5: hallucinatedMemoryCount (${metrics.hallucinatedMemoryCount}) > ${M2_GATE_THRESHOLDS.hallucinatedMemoryCountMax}`,
      )
    }
    if (provenanceCoverageRate < M2_GATE_THRESHOLDS.provenanceCoverageRateMin) {
      failedGates.push(
        `G6: provenanceCoverageRate (${provenanceCoverageRate}) < ${M2_GATE_THRESHOLDS.provenanceCoverageRateMin}`,
      )
    }
    if (
      seriousnessGateCompliance < M2_GATE_THRESHOLDS.seriousnessGateComplianceMin
    ) {
      failedGates.push(
        `G7: seriousnessGateCompliance (${seriousnessGateCompliance}) < ${M2_GATE_THRESHOLDS.seriousnessGateComplianceMin}`,
      )
    }
    if (antiSlopComplianceRate < M2_GATE_THRESHOLDS.antiSlopComplianceRateMin) {
      failedGates.push(
        `G8: antiSlopComplianceRate (${antiSlopComplianceRate}) < ${M2_GATE_THRESHOLDS.antiSlopComplianceRateMin}`,
      )
    }
    if (
      voiceScoreModelA < M2_GATE_THRESHOLDS.voiceScoreMin ||
      voiceScoreModelB < M2_GATE_THRESHOLDS.voiceScoreMin ||
      crossModelVoiceDrift > M2_GATE_THRESHOLDS.crossModelVoiceDriftMax
    ) {
      failedGates.push(
        `G9: crossModelVoiceDrift (${crossModelVoiceDrift}, A=${voiceScoreModelA}, B=${voiceScoreModelB}) failed voice stability thresholds`,
      )
    }

    const generatedAt = Date.now()
    const report: CoreExperimentEvalReport = {
      runId: `m2-eval-seed${safeSeed}-${generatedAt}`,
      generatedAt,
      mode,
      seed: safeSeed,
      modelAId: modelARunner.modelId,
      modelBId: modelBRunner.modelId,
      passedAllGates: failedGates.length === 0,
      failedGates,
      metrics,
      steps: stepResults,
    }

    return v.parse(CoreExperimentEvalReportSchema, report)
  } finally {
    cortex.close()
  }
}

/**
 * Runs the Phase 3 Core Experiment across multiple paraphrase seeds (default `[0, 1, 2]`)
 * to verify Gate G10 (Seed Invariance).
 */
export async function runMultiSeedCoreExperimentM2(
  options?: RunMultiSeedCoreExperimentM2Options,
): Promise<MultiSeedCoreExperimentM2Result> {
  const rawSeeds =
    options?.seeds && options.seeds.length > 0 ? options.seeds : [0, 1, 2]
  const seeds = Array.from(
    new Set(
      rawSeeds.map((s) => (Number.isFinite(s) ? Math.abs(Math.trunc(s)) : 0)),
    ),
  )

  const reports: CoreExperimentEvalReport[] = []
  for (const seed of seeds) {
    const report = await runCoreExperimentM2({
      seed,
      mode: options?.mode,
      modelAId: options?.modelAId,
      modelBId: options?.modelBId,
      modelARunner: options?.modelARunner,
      modelBRunner: options?.modelBRunner,
      scenario: options?.scenario,
      voiceIdentityMarkdown: options?.voiceIdentityMarkdown,
      llmJudgeFn: options?.llmJudgeFn,
    })
    reports.push(report)
  }

  const allPassed =
    reports.length > 0 && reports.every((r) => r.passedAllGates)

  if (reports.length > 1 && !allPassed) {
    const passedCount = reports.filter((r) => r.passedAllGates).length
    const failedSeedList = reports
      .filter((r) => !r.passedAllGates)
      .map((r) => r.seed)
    const g10Message = `G10: seedInvariance failed (${passedCount}/${reports.length} seeds passed; failed seeds: ${failedSeedList.join(', ')})`

    for (let i = 0; i < reports.length; i += 1) {
      const rep = reports[i]!
      const hasG10 = rep.failedGates.some((g) => g.startsWith('G10'))
      reports[i] = {
        ...rep,
        passedAllGates: false,
        failedGates: hasG10 ? rep.failedGates : [...rep.failedGates, g10Message],
      }
    }
  }

  return {
    seeds,
    allPassed,
    reports,
  }
}
