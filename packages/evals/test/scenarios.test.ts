import { describe, expect, it, vi } from 'vitest'
import {
  M2_CANONICAL_COEXISTENCE_SCENARIO,
  createSimulatedUser,
} from '../src/scenarios'

describe('Phase 3 Longitudinal Scenarios & Seeded SimulatedUser', () => {
  it('defines a monotonic 3-week timeline (Days 1..21) switching from model_a to model_b on Day 11', () => {
    const steps = M2_CANONICAL_COEXISTENCE_SCENARIO.steps
    expect(steps.length).toBeGreaterThanOrEqual(10)

    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]!.timestampMs).toBeGreaterThan(steps[i - 1]!.timestampMs)
      expect(steps[i]!.day).toBeGreaterThanOrEqual(steps[i - 1]!.day)
    }

    const modelASteps = steps.filter((s) => s.phase === 'model_a')
    const modelBSteps = steps.filter((s) => s.phase === 'model_b')
    expect(modelASteps.length).toBeGreaterThanOrEqual(6)
    expect(modelBSteps.length).toBeGreaterThanOrEqual(4)
    expect(modelASteps.every((s) => s.day <= 10)).toBe(true)
    expect(modelBSteps.every((s) => s.day >= 11)).toBe(true)
    expect(steps.every((s) => s.consolidateAfterTurn === true)).toBe(true)
  })

  it('produces 3 distinct deterministic utterances across seeds 0, 1, and 2 for every step, and omits literal Day 1 trigger words on Day 5 and Day 18', async () => {
    const userSeed0 = createSimulatedUser({ seed: 0 })
    const userSeed1 = createSimulatedUser({ seed: 1 })
    const userSeed2 = createSimulatedUser({ seed: 2 })

    for (const step of M2_CANONICAL_COEXISTENCE_SCENARIO.steps) {
      expect(step.paraphraseBank.length).toBeGreaterThanOrEqual(3)
      const u0 = await userSeed0.getUtterance(step)
      const u1 = await userSeed1.getUtterance(step)
      const u2 = await userSeed2.getUtterance(step)

      expect(new Set([u0, u1, u2]).size).toBe(3)

      // Repeat call with same seed must be 100% deterministic
      expect(await userSeed0.getUtterance(step)).toBe(u0)

      if (
        step.stepId === 'day5-bug-resolved-callback' ||
        step.stepId === 'day18-model-b-inside-joke-callback'
      ) {
        for (const utterance of [u0, u1, u2]) {
          expect(utterance.toLowerCase()).not.toContain('fantasma')
          expect(utterance.toLowerCase()).not.toContain('exorcista')
          expect(utterance.toLowerCase()).not.toContain('padre')
        }
      }
    }
  })

  it('supports an optional live LLM paraphraseFn and falls back safely to the seeded bank on error or forbidden keyword leak', async () => {
    const day18Step = M2_CANONICAL_COEXISTENCE_SCENARIO.steps.find(
      (s) => s.stepId === 'day18-model-b-inside-joke-callback',
    )!

    const validParaphraseFn = vi.fn(
      async () => 'Mexi num módulo legado hoje e estourou uma falha estranha.',
    )
    const liveUser = createSimulatedUser({ seed: 0, paraphraseFn: validParaphraseFn })
    expect(await liveUser.getUtterance(day18Step)).toBe(
      'Mexi num módulo legado hoje e estourou uma falha estranha.',
    )

    // If live paraphraser leaks forbidden trigger word ('fantasma') or throws, fallback to seeded bank
    const leakyParaphraseFn = vi.fn(
      async () => 'O fantasma no backend voltou quando mexi na biblioteca.',
    )
    const safeUser = createSimulatedUser({ seed: 0, paraphraseFn: leakyParaphraseFn })
    expect(await safeUser.getUtterance(day18Step)).toBe(day18Step.paraphraseBank[0])

    const throwingParaphraseFn = vi.fn(async () => {
      throw new Error('Network timeout')
    })
    const errorFallbackUser = createSimulatedUser({ seed: 1, paraphraseFn: throwingParaphraseFn })
    expect(await errorFallbackUser.getUtterance(day18Step)).toBe(day18Step.paraphraseBank[1])
  })
})
