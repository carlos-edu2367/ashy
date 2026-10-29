import { describe, expect, it } from 'vitest'
import {
  EMBEDDING_DIMENSIONS,
  embedTextSync128,
  computeCosineSimilarity128,
  createDeterministicSemanticEmbeddingProvider,
  createOpenAICompatibleEmbeddingProvider,
  createResilientEmbeddingProvider,
} from '../src/index'

describe('@ashy/llm — Phase 2: 128-D Deterministic Semantic & Remote EmbeddingProvider', () => {
  it('produces deterministic 128-D L2-normalized vectors and zero vectors for empty/whitespace strings', async () => {
    expect(EMBEDDING_DIMENSIONS).toBe(128)

    const provider = createDeterministicSemanticEmbeddingProvider()
    const text = 'Trabalhando no backend em TypeScript com SQLite de madrugada'

    const syncVec = embedTextSync128(text)
    const asyncRes = await provider.embedText(text)
    const batchRes = await provider.embedBatch([text, '   ', ''])

    expect(syncVec).toHaveLength(128)
    expect(asyncRes.dimensions).toBe(128)
    expect(asyncRes.source).toBe('deterministic_semantic')
    expect(asyncRes.modelId).toBe('ashy-semantic-128d-v1')
    expect(asyncRes.vector).toEqual(syncVec)
    expect(batchRes).toHaveLength(3)
    expect(batchRes[0]?.vector).toEqual(syncVec)

    // Verify L2 norm is ~1.0 for non-empty text
    const l2Norm = Math.sqrt(syncVec.reduce((acc, v) => acc + v * v, 0))
    expect(l2Norm).toBeCloseTo(1.0, 5)

    // Empty / whitespace strings produce 128-D zero vectors
    const emptyVec = embedTextSync128('   \n\t  ')
    expect(emptyVec).toHaveLength(128)
    expect(emptyVec.every((v) => v === 0)).toBe(true)
    expect(batchRes[1]?.vector.every((v) => v === 0)).toBe(true)
    expect(batchRes[2]?.vector.every((v) => v === 0)).toBe(true)
  })

  it('safely computes cosine similarity in [-1, 1] and handles zero vectors, mismatched dimensions, and non-finite inputs', () => {
    const v1 = embedTextSync128('Testando similaridade de cosseno no banco SQLite')
    expect(computeCosineSimilarity128(v1, v1)).toBeCloseTo(1.0, 5)

    const inverted = v1.map((x) => -x)
    expect(computeCosineSimilarity128(v1, inverted)).toBeCloseTo(-1.0, 5)

    // Zero vector returns 0
    const zeros = new Array<number>(128).fill(0)
    expect(computeCosineSimilarity128(v1, zeros)).toBe(0)
    expect(computeCosineSimilarity128(zeros, zeros)).toBe(0)

    // Mismatched dimensions or empty arrays return 0 safely
    expect(computeCosineSimilarity128(v1, [1, 0, 0])).toBe(0)
    expect(computeCosineSimilarity128([], [])).toBe(0)

    // Non-finite numbers are guarded safely
    const corrupted = [...v1]
    corrupted[0] = Number.NaN
    expect(computeCosineSimilarity128(v1, corrupted)).toBe(0)
  })

  it('aligns the exact verbatim Day 1, Day 5, and Day 18 "Fantasma no Backend" sentences in semantic space (>= 0.30) while keeping unrelated topics orthogonal (< 0.12)', () => {
    // Exact verbatim lines from ASHY_PROJECT_CONTEXT.md (lines 84-95)
    const day1 =
      'Esse código tá tão amaldiçoado que deve ter um fantasma no backend. Eu já tava pensando em chamar um exorcista de JavaScript.'
    const day5 = 'Lembra daquele bug? Consegui resolver.'
    const day18 = 'Fui mexer numa biblioteca antiga e deu erro.'
    const unrelatedBakery = 'Comprei pão e leite na padaria hoje de manhã'

    const vecDay1 = embedTextSync128(day1)
    const vecDay5 = embedTextSync128(day5)
    const vecDay18 = embedTextSync128(day18)
    const vecUnrelated = embedTextSync128(unrelatedBakery)

    const simDay1Day5 = computeCosineSimilarity128(vecDay1, vecDay5)
    const simDay1Day18 = computeCosineSimilarity128(vecDay1, vecDay18)
    const simDay1Unrelated = computeCosineSimilarity128(vecDay1, vecUnrelated)

    expect(simDay1Day5).toBeGreaterThanOrEqual(0.3)
    expect(simDay1Day18).toBeGreaterThanOrEqual(0.3)
    expect(simDay1Unrelated).toBeLessThan(0.12)

    // Also verify alignment against a seeded motif representation (motif + originSummary + triggerCues)
    const motifSeedText = [
      'fantasma no backend / exorcista de JavaScript',
      'Esse código tá tão amaldiçoado que deve ter um fantasma no backend',
      'fantasma no backend',
      'código amaldiçoado',
      'exorcista de javascript',
    ].join(' ')
    const vecMotif = embedTextSync128(motifSeedText)

    expect(computeCosineSimilarity128(vecMotif, vecDay5)).toBeGreaterThanOrEqual(0.3)
    expect(computeCosineSimilarity128(vecMotif, vecDay18)).toBeGreaterThanOrEqual(0.3)
    expect(computeCosineSimilarity128(vecMotif, vecUnrelated)).toBeLessThan(0.12)
  })

  it('calls POST {baseUrl}/embeddings via createOpenAICompatibleEmbeddingProvider and parses single and batch vectors', async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = []

    const mockFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      const body = JSON.parse(String(init?.body ?? '{}')) as { input: string | string[]; model: string }
      calls.push({
        url: String(input),
        body,
        auth: headers.get('Authorization'),
      })

      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      return new Response(
        JSON.stringify({
          data: inputs.map((_item, index) => ({
            index,
            embedding: [0.6, 0.8, 0, index * 0.1],
          })),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    const remoteProvider = createOpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'sk-test-embeddings',
      modelId: 'text-embedding-3-small',
      fetchImpl: mockFetch,
      timeoutMs: 2000,
    })

    const single = await remoteProvider.embedText('Olá Ashy')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/embeddings')
    expect(calls[0]?.auth).toBe('Bearer sk-test-embeddings')
    expect(single.source).toBe('remote')
    expect(single.modelId).toBe('text-embedding-3-small')
    expect(single.dimensions).toBe(4)
    expect(single.vector).toEqual([0.6, 0.8, 0, 0])

    const batch = await remoteProvider.embedBatch(['Texto A', 'Texto B'])
    expect(batch).toHaveLength(2)
    expect(batch[0]?.vector).toEqual([0.6, 0.8, 0, 0])
    expect(batch[1]?.vector).toEqual([0.6, 0.8, 0, 0.1])
  })

  it('falls back cleanly to deterministic 128-D semantic provider on HTTP 500/404, malformed payload, or timeout in createResilientEmbeddingProvider', async () => {
    let mode: 'healthy' | 'http_500' | 'http_404' | 'malformed' | 'timeout' = 'healthy'

    const flakyRemote = createOpenAICompatibleEmbeddingProvider({
      baseUrl: 'http://localhost:11434/v1',
      modelId: 'nomic-embed-text',
      timeoutMs: 40,
      fetchImpl: async (_input, init) => {
        if (mode === 'healthy') {
          return new Response(
            JSON.stringify({
              data: [{ index: 0, embedding: new Array<number>(128).fill(1 / Math.sqrt(128)) }],
            }),
            { status: 200 },
          )
        }
        if (mode === 'http_500') {
          return new Response('Internal Server Error', { status: 500 })
        }
        if (mode === 'http_404') {
          return new Response('Not Found', { status: 404 })
        }
        if (mode === 'malformed') {
          return new Response(JSON.stringify({ data: [{ embedding: 'not-an-array' }] }), { status: 200 })
        }
        // timeout mode: wait for abort signal
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('Aborted due to timeout'))
          })
        })
      },
    })

    const resilient = createResilientEmbeddingProvider({ remote: flakyRemote })
    const query = 'Fui mexer numa biblioteca antiga e deu erro.'

    // 1. Healthy remote
    const okRes = await resilient.embedText(query)
    expect(okRes.source).toBe('remote')
    expect(okRes.dimensions).toBe(128)

    // 2. HTTP 500 fallback
    mode = 'http_500'
    const fallback500 = await resilient.embedText(query)
    expect(fallback500.source).toBe('deterministic_semantic')
    expect(fallback500.dimensions).toBe(128)
    expect(fallback500.vector).toEqual(embedTextSync128(query))

    // 3. HTTP 404 fallback
    mode = 'http_404'
    const fallback404 = await resilient.embedBatch([query])
    expect(fallback404).toHaveLength(1)
    expect(fallback404[0]?.source).toBe('deterministic_semantic')
    expect(fallback404[0]?.vector).toEqual(embedTextSync128(query))

    // 4. Malformed payload fallback
    mode = 'malformed'
    const fallbackMalformed = await resilient.embedText(query)
    expect(fallbackMalformed.source).toBe('deterministic_semantic')

    // 5. Timeout fallback
    mode = 'timeout'
    const fallbackTimeout = await resilient.embedText(query)
    expect(fallbackTimeout.source).toBe('deterministic_semantic')
    expect(fallbackTimeout.vector).toEqual(embedTextSync128(query))
  })
})
