import { describe, expect, it } from 'vitest'
import { embedTextSync128 } from '@ashy/llm'
import type { RelationalMotif } from '@ashy/shared'
import {
  computeMotifRelevance,
  inspectMotifCooldownStatus,
  recordMotifInvocation,
  selectEligibleMotifs,
} from '../relational/inside-joke-engine'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

describe('Hybrid Semantic + Lexical Inside-Joke Relevance (@ashy/cortex)', () => {
  it('triggers the exact canonical Day 1 -> Day 5 -> Day 18 "fantasma no backend" scenario without artificial keywords', () => {
    const day1Ms = Date.UTC(2026, 9, 1, 23, 0, 0)

    // Day 1: Seeded exclusively from the verbatim Day 1 exchange:
    // User: "Esse código tá tão amaldiçoado que deve ter um fantasma no backend."
    // Ashy: "Eu já tava pensando em chamar um exorcista de JavaScript."
    let motif: RelationalMotif = {
      id: 'motif-fantasma-backend',
      motif: 'fantasma no backend / exorcista de JavaScript',
      originSummary: 'Esse código tá tão amaldiçoado que deve ter um fantasma no backend',
      originEpisodeId: 'ep-day1',
      triggerCues: ['fantasma no backend', 'código amaldiçoado', 'exorcista de javascript'],
      stage: 'seed',
      timesUsed: 0,
      lastUsedAt: null,
      cooldownHours: 24,
      createdAt: day1Ms,
      approvalStatus: 'approved',
    }

    // Verify zero artificial words ("bug", "biblioteca", "erro") in triggerCues
    const cuesJoined = motif.triggerCues.join(' ').toLowerCase()
    expect(cuesJoined).not.toContain('bug')
    expect(cuesJoined).not.toContain('biblioteca')
    expect(cuesJoined).not.toContain('erro')

    // Day 5 (day1Ms + 4 * 24 * 3600_000):
    // User says: "Lembra daquele bug? Consegui resolver."
    const day5Ms = day1Ms + 4 * DAY_MS
    const day5Matches = selectEligibleMotifs(
      [motif],
      'Lembra daquele bug? Consegui resolver.',
      day5Ms,
    )
    expect(day5Matches).toHaveLength(1)
    expect(day5Matches[0]!.motif.id).toBe('motif-fantasma-backend')
    expect(day5Matches[0]!.relevanceScore).toBeGreaterThanOrEqual(0.2)
    expect(day5Matches[0]!.matchedCues).toContain('semantic_context_match')

    // Record callback invocation on Day 5 -> stage becomes 'inside_joke', cooldownHours = 36
    motif = recordMotifInvocation(motif, true, day5Ms)
    expect(motif.stage).toBe('inside_joke')
    expect(motif.cooldownHours).toBe(36)

    // Day 5 + 2h:
    // User says: "Apareceu outro bug estranho no código." -> blocked by cooldown lock
    const day5Plus2hMs = day5Ms + 2 * HOUR_MS
    const cooldownStatus = inspectMotifCooldownStatus(motif, day5Plus2hMs)
    expect(cooldownStatus.isCooldownLocked).toBe(true)

    const day5Plus2hMatches = selectEligibleMotifs(
      [motif],
      'Apareceu outro bug estranho no código.',
      day5Plus2hMs,
    )
    expect(day5Plus2hMatches).toEqual([])

    // Day 18 (day5Ms + 13 * 24 * 3600_000):
    // User says: "Fui mexer numa biblioteca antiga e deu erro."
    const day18Ms = day5Ms + 13 * DAY_MS
    const day18Matches = selectEligibleMotifs(
      [motif],
      'Fui mexer numa biblioteca antiga e deu erro.',
      day18Ms,
    )
    expect(day18Matches).toHaveLength(1)
    expect(day18Matches[0]!.motif.id).toBe('motif-fantasma-backend')
    expect(day18Matches[0]!.relevanceScore).toBeGreaterThanOrEqual(0.2)
    expect(day18Matches[0]!.matchedCues).toContain('semantic_context_match')

    // Unrelated query:
    // User says: "Comprei pão e leite na padaria hoje de manhã"
    const unrelatedMatches = selectEligibleMotifs(
      [motif],
      'Comprei pão e leite na padaria hoje de manhã',
      day18Ms,
    )
    expect(unrelatedMatches).toEqual([])
  })

  it('enforces Seriousness Gate, pending_review quarantine, dormant stage filtering, and precomputed embeddings', () => {
    const nowMs = Date.UTC(2026, 9, 20, 12, 0, 0)
    const motifText = 'fantasma no backend / exorcista de JavaScript'
    const originSummary = 'Esse código tá tão amaldiçoado que deve ter um fantasma no backend'
    const triggerCues = ['fantasma no backend', 'código amaldiçoado', 'exorcista de javascript']

    const baseMotif: RelationalMotif = {
      id: 'motif-1',
      motif: motifText,
      originSummary,
      originEpisodeId: 'ep-1',
      triggerCues,
      stage: 'inside_joke',
      timesUsed: 1,
      lastUsedAt: nowMs - 72 * HOUR_MS,
      cooldownHours: 36,
      createdAt: nowMs - 10 * DAY_MS,
      embedding: embedTextSync128([motifText, originSummary, ...triggerCues].join(' ')),
      approvalStatus: 'approved',
    }

    // 1. Seriousness Gate blocks eligible motifs immediately
    expect(
      selectEligibleMotifs(
        [baseMotif],
        'Lembra daquele bug? Consegui resolver.',
        nowMs,
        { isSeriousContext: true },
      ),
    ).toEqual([])

    // 2. Quarantine (approvalStatus === 'pending_review') blocks motif selection
    const pendingMotif: RelationalMotif = {
      ...baseMotif,
      id: 'motif-pending',
      approvalStatus: 'pending_review',
    }
    expect(
      selectEligibleMotifs(
        [pendingMotif],
        'Lembra daquele bug? Consegui resolver.',
        nowMs,
      ),
    ).toEqual([])

    // 3. Dormant stage blocks motif selection
    const dormantMotif: RelationalMotif = {
      ...baseMotif,
      id: 'motif-dormant',
      stage: 'dormant',
    }
    expect(
      selectEligibleMotifs(
        [dormantMotif],
        'Lembra daquele bug? Consegui resolver.',
        nowMs,
      ),
    ).toEqual([])

    // 4. Accepts precomputed 128-D queryEmbedding and motif.embedding
    const queryVec = embedTextSync128('Fui mexer numa biblioteca antiga e deu erro.')
    const withQueryVec = selectEligibleMotifs(
      [baseMotif],
      'Fui mexer numa biblioteca antiga e deu erro.',
      nowMs,
      { queryEmbedding: queryVec },
    )
    expect(withQueryVec).toHaveLength(1)
    expect(withQueryVec[0]!.relevanceScore).toBeGreaterThanOrEqual(0.2)

    // 5. Empty or whitespace context returns 0 relevance
    expect(computeMotifRelevance(baseMotif, '   ')).toEqual({
      relevanceScore: 0,
      matchedCues: [],
    })
  })
})
