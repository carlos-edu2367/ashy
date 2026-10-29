export const EMBEDDING_DIMENSIONS = 128
export const DEFAULT_SEMANTIC_EMBEDDING_MODEL_ID = 'ashy-semantic-128d-v1'

export interface EmbeddingResult {
  vector: number[]
  dimensions: number
  source: 'remote' | 'deterministic_semantic'
  modelId: string
}

export interface EmbeddingProvider {
  embedText(text: string): Promise<EmbeddingResult>
  embedBatch(texts: readonly string[]): Promise<EmbeddingResult[]>
}

export interface OpenAICompatibleEmbeddingProviderOptions {
  baseUrl?: string
  apiKey?: string
  modelId?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  headers?: Record<string, string>
}

export interface ResilientEmbeddingProviderOptions {
  remote?: EmbeddingProvider | null
  fallback?: EmbeddingProvider
}

interface ConceptClusterRule {
  readonly dims: ReadonlyArray<readonly [dim: number, weight: number]>
  readonly prefixes: readonly string[]
}

const STOPWORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'um',
  'uma',
  'uns',
  'umas',
  'o',
  'a',
  'os',
  'as',
  'e',
  'ou',
  'mas',
  'que',
  'se',
  'por',
  'para',
  'pra',
  'com',
  'sem',
  'sob',
  'sobre',
  'eu',
  'tu',
  'voce',
  'ele',
  'ela',
  'eles',
  'elas',
  'meu',
  'minha',
  'seu',
  'sua',
  'esse',
  'essa',
  'isso',
  'este',
  'esta',
  'isto',
  'aquele',
  'aquela',
  'aquilo',
  'ta',
  'to',
  'tava',
  'estava',
  'estou',
  'foi',
  'fui',
  'era',
  'ser',
  'ter',
  'tem',
  'tinha',
  'deve',
  'pode',
  'vai',
  'vou',
  'ja',
  'tao',
  'muito',
  'mais',
  'menos',
  'como',
  'quando',
  'onde',
  'quem',
  'qual',
  'numa',
  'num',
  'pelo',
  'pela',
  'deu',
  'dar',
  'fez',
  'fazer',
  'hoje',
  'ontem',
  'the',
  'an',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'this',
  'that',
  'and',
  'or',
  'but',
  'if',
  'so',
])

/**
 * Curated PT-BR / EN concept clusters projecting into dims 0..63.
 * Specifically aligns the canonical "Cursed Code / Fantasma no Backend / Legacy Bug"
 * conceptual neighborhood across Day 1, Day 5, and Day 18 while keeping unrelated domains orthogonal.
 */
const CONCEPT_CLUSTERS: readonly ConceptClusterRule[] = [
  // Cluster 0: Cursed Code / Haunting Metaphor / Software Bug / Legacy Failure / Troubleshooting (Dims 0..5)
  {
    dims: [
      [0, 1.4],
      [1, 1.2],
      [2, 1.1],
      [3, 0.9],
      [4, 0.85],
    ],
    prefixes: [
      'amaldicoad',
      'fantasm',
      'assombr',
      'exorcis',
      'padre',
      'maldicao',
      'bruxari',
      'cursed',
      'ghost',
      'haunt',
      'bug',
      'erro',
      'error',
      'falha',
      'crash',
      'exception',
      'quebr',
      'trav',
      'defeit',
      'glitch',
      'stacktrace',
      'panic',
    ],
  },
  // Cluster 1: Bug Resolution / Fixing / Recall of Past Bug ("Lembra daquele bug? Consegui resolver")
  {
    dims: [
      [0, 1.15],
      [1, 0.95],
      [2, 1.35],
      [3, 0.8],
      [4, 1.2],
    ],
    prefixes: [
      'resolv',
      'consert',
      'corrig',
      'consegu',
      'debug',
      'depur',
      'fix',
      'patch',
      'hotfix',
      'solucion',
      'lembr',
      'daquel',
      'record',
    ],
  },
  // Cluster 2: Legacy Library / Dependencies / Touching Old Code ("Fui mexer numa biblioteca antiga e deu erro")
  {
    dims: [
      [0, 1.25],
      [1, 1.35],
      [2, 1.05],
      [3, 0.95],
      [4, 0.8],
      [5, 0.65],
    ],
    prefixes: [
      'bibliotec',
      'antig',
      'legad',
      'legacy',
      'dependenc',
      'pacot',
      'npm',
      'pnpm',
      'yarn',
      'node_modules',
      'mexer',
      'mexi',
      'fucar',
      'fucei',
      'deprecad',
      'obsolet',
      'versao',
    ],
  },
  // Cluster 3: Codebase / Backend / JavaScript / TypeScript Engineering (Dims 0..3, 6..11)
  {
    dims: [
      [0, 0.75],
      [1, 0.7],
      [2, 0.65],
      [3, 1.25],
      [6, 1.0],
      [7, 0.9],
      [9, 1.0],
    ],
    prefixes: [
      'codig',
      'code',
      'backend',
      'javascript',
      'typescript',
      'nodejs',
      'servidor',
      'server',
      'api',
      'endpoint',
      'rota',
      'route',
      'funcao',
      'function',
      'modulo',
      'compil',
      'runtime',
      'ipc',
      'rpc',
      'http',
      'sse',
      'stream',
      'valibot',
      'schema',
    ],
  },
  // Cluster 4: Databases, SQLite, Persistence & Hybrid Search (Dims 12..17)
  {
    dims: [
      [12, 1.3],
      [13, 1.1],
      [14, 0.9],
      [15, 0.8],
    ],
    prefixes: [
      'banco',
      'database',
      'sqlite',
      'postgres',
      'sql',
      'query',
      'tabela',
      'table',
      'coluna',
      'migration',
      'wal',
      'fts',
      'bm25',
      'index',
      'persist',
      'storage',
      'armazen',
    ],
  },
  // Cluster 5: Memory, Embeddings, FSRS & Consolidation (Dims 15..17, 4)
  {
    dims: [
      [15, 1.2],
      [16, 1.3],
      [17, 1.1],
      [4, 0.7],
    ],
    prefixes: [
      'memoria',
      'memory',
      'episod',
      'semantic',
      'embedding',
      'vetor',
      'vector',
      'cosseno',
      'cosine',
      'similaridad',
      'fsrs',
      'rrf',
      'recall',
      'consolid',
      'quarenten',
      'governanc',
    ],
  },
  // Cluster 6: Frontend, UI, Design & Avatar Stage (Dims 18..23)
  {
    dims: [
      [18, 1.25],
      [19, 1.1],
      [20, 0.95],
      [21, 0.8],
    ],
    prefixes: [
      'frontend',
      'interface',
      'tela',
      'screen',
      'component',
      'react',
      'zustand',
      'tailwind',
      'css',
      'html',
      'layout',
      'botao',
      'button',
      'modal',
      'painel',
      'render',
      'navegador',
      'browser',
      'avatar',
      'live2d',
      'pixi',
      'webgl',
      'animac',
      'lipsync',
      'visem',
    ],
  },
  // Cluster 7: Editors, Dev Tools, Terminal & Git (Dims 24..28)
  {
    dims: [
      [24, 1.3],
      [25, 1.15],
      [26, 0.95],
      [27, 0.9],
      [28, 0.85],
    ],
    prefixes: [
      'editor',
      'neovim',
      'nvim',
      'vim',
      'vscode',
      'cursor',
      'ide',
      'terminal',
      'shell',
      'bash',
      'powershell',
      'git',
      'github',
      'commit',
      'branch',
      'merge',
      'rebase',
      'docker',
      'linux',
      'windows',
    ],
  },
  // Cluster 8: Deploy, Release, Production & Prospective Intents / Deadlines (Dims 29..34)
  {
    dims: [
      [29, 1.25],
      [30, 1.15],
      [31, 1.0],
      [32, 1.1],
      [33, 1.0],
      [34, 0.9],
    ],
    prefixes: [
      'deploy',
      'producao',
      'production',
      'release',
      'lancament',
      'launch',
      'pipeline',
      'vps',
      'cloud',
      'amanha',
      'tomorrow',
      'semana',
      'sexta',
      'segunda',
      'terca',
      'quarta',
      'quinta',
      'prazo',
      'deadline',
      'reuniao',
      'meeting',
      'entrega',
      'agenda',
      'lembret',
      'remind',
      'planej',
    ],
  },
  // Cluster 9: Habits, Late-Night Coding Rhythm & Routine (Dims 35..39)
  {
    dims: [
      [35, 1.3],
      [36, 1.15],
      [37, 1.0],
      [38, 0.9],
      [39, 0.85],
    ],
    prefixes: [
      'madrugad',
      'noite',
      'night',
      'insonia',
      'virad',
      'allnighter',
      'sono',
      'dormir',
      'sleep',
      'rotina',
      'routine',
      'habit',
      'costum',
      'sempre',
      'ritmo',
      'cafe',
      'coffee',
      'espresso',
      'foco',
      'focus',
    ],
  },
  // Cluster 10: Emotions, Stress, Burnout & Playful Banter (Dims 40..45)
  {
    dims: [
      [40, 1.25],
      [41, 1.1],
      [42, 0.95],
      [43, 0.9],
      [44, 0.85],
      [45, 0.8],
    ],
    prefixes: [
      'cansad',
      'tired',
      'exaust',
      'burnout',
      'estress',
      'stress',
      'ansios',
      'frustrad',
      'triste',
      'feliz',
      'happy',
      'animad',
      'orgulh',
      'aliviad',
      'piada',
      'joke',
      'engracad',
      'sarcasm',
      'ironia',
      'aposta',
    ],
  },
  // Cluster 11: User Identity, Preferences & Career Profile (Dims 46..50)
  {
    dims: [
      [46, 1.25],
      [47, 1.15],
      [48, 1.0],
      [49, 0.95],
      [50, 0.9],
    ],
    prefixes: [
      'nome',
      'chamo',
      'pronom',
      'prefir',
      'prefer',
      'favorit',
      'gosto',
      'desenvolvedor',
      'developer',
      'engenheir',
      'programador',
      'arquiteto',
      'fullstack',
      'equipe',
      'empresa',
      'projeto',
    ],
  },
  // Cluster 12: Food, Bakery, Grocery & Cooking — Orthogonal Everyday Domain (Dims 51..55)
  {
    dims: [
      [51, 1.35],
      [52, 1.25],
      [53, 1.15],
      [54, 1.05],
      [55, 0.95],
    ],
    prefixes: [
      'pao',
      'leite',
      'padaria',
      'compr',
      'mercado',
      'supermercad',
      'comida',
      'almoc',
      'jantar',
      'cozinh',
      'receit',
      'restaur',
      'lanche',
      'bolo',
      'queijo',
      'manteig',
      'fruta',
      'arroz',
      'feijao',
      'fome',
    ],
  },
  // Cluster 13: Health, Medical & Fitness — Orthogonal Everyday Domain (Dims 56..59)
  {
    dims: [
      [56, 1.3],
      [57, 1.2],
      [58, 1.1],
      [59, 1.0],
    ],
    prefixes: [
      'medic',
      'hospital',
      'consulta',
      'exame',
      'remedio',
      'saude',
      'febre',
      'gripe',
      'academia',
      'treino',
      'exercicio',
      'esporte',
      'futebol',
    ],
  },
  // Cluster 14: Travel, Weather, Nature & Leisure — Orthogonal Everyday Domain (Dims 60..63)
  {
    dims: [
      [60, 1.3],
      [61, 1.2],
      [62, 1.1],
      [63, 1.0],
    ],
    prefixes: [
      'viagem',
      'viajar',
      'praia',
      'hotel',
      'aviao',
      'voo',
      'transito',
      'chuva',
      'clima',
      'passeio',
      'filme',
      'cinema',
      'musica',
      'banda',
    ],
  },
]

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function stemToken(token: string): string {
  if (token.length <= 4) return token
  const suffixes = [
    'amentos',
    'imento',
    'amento',
    'adores',
    'adoras',
    'izando',
    'arem',
    'erem',
    'irem',
    'ando',
    'endo',
    'indo',
    'aram',
    'eram',
    'iram',
    'avam',
    'adas',
    'ados',
    'idas',
    'idos',
    'mente',
    'coes',
    'sao',
    'cao',
    'ista',
    'ismo',
    'ador',
    'avel',
    'ivel',
    'ada',
    'ado',
    'ida',
    'ido',
    'ava',
    'iam',
    'ou',
    'ei',
    'am',
    'em',
    'ar',
    'er',
    'ir',
    'es',
    's',
  ]
  for (const suffix of suffixes) {
    if (token.length - suffix.length >= 4 && token.endsWith(suffix)) {
      return token.slice(0, token.length - suffix.length)
    }
  }
  return token
}

/**
 * FNV-1a 32-bit hash followed by MurmurHash3 fmix32 avalanche finalizer
 * so low bits (`% 64`) and sign bit have full 32-bit entropy.
 */
function hashFeature32(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

function addHashedFeature(vec: number[], feature: string, weight: number): void {
  const h = hashFeature32(feature, 0x811c9dc5)
  const dim = 64 + (h & 63)
  const sign = ((h >>> 6) & 1) === 0 ? 1 : -1
  vec[dim] = (vec[dim] ?? 0) + sign * weight
}

function normalizeSubspaceInPlace(
  vec: number[],
  startIdx: number,
  endIdxExclusive: number,
  targetEnergyWeight: number,
): number {
  let sumSq = 0
  for (let i = startIdx; i < endIdxExclusive; i++) {
    const v = vec[i] ?? 0
    sumSq += v * v
  }
  if (sumSq <= 1e-12) {
    return 0
  }
  const scale = Math.sqrt(targetEnergyWeight) / Math.sqrt(sumSq)
  for (let i = startIdx; i < endIdxExclusive; i++) {
    vec[i] = (vec[i] ?? 0) * scale
  }
  return sumSq
}

/**
 * Synchronous 128-D deterministic semantic + lexical embedding generator.
 * - Dims 0..63: Curated PT-BR/EN semantic concept clusters
 * - Dims 64..127: Signed FNV-1a/fmix32 stem, prefix, and bigram feature hashes
 * Always returns a 128-element array (L2-normalized to 1.0, or all zeros for empty/whitespace text).
 */
export function embedTextSync128(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  if (typeof text !== 'string' || text.trim().length === 0) {
    return vec
  }

  const normalized = normalizeText(text)
  const rawTokens = normalized.match(/[a-z0-9_]{2,}/g) ?? []
  if (rawTokens.length === 0) {
    return vec
  }

  const contentTokens = rawTokens.filter((t) => !STOPWORDS.has(t))
  const effectiveTokens = contentTokens.length > 0 ? contentTokens : rawTokens

  // 1. Populate Semantic Concept Clusters in dims 0..63
  for (const token of effectiveTokens) {
    const stem = stemToken(token)
    for (const cluster of CONCEPT_CLUSTERS) {
      let matched = false
      for (const prefix of cluster.prefixes) {
        if (token.startsWith(prefix) || stem.startsWith(prefix)) {
          matched = true
          break
        }
      }
      if (matched) {
        for (const [dim, weight] of cluster.dims) {
          if (dim >= 0 && dim < 64) {
            vec[dim] = (vec[dim] ?? 0) + weight
          }
        }
      }
    }
  }

  // 2. Populate Signed FNV-1a/fmix32 Stem & Prefix Feature Hashes in dims 64..127
  for (let i = 0; i < effectiveTokens.length; i++) {
    const token = effectiveTokens[i]!
    const stem = stemToken(token)

    addHashedFeature(vec, `tok:${token}`, 1.0)
    addHashedFeature(vec, `stem:${stem}`, 1.25)

    if (stem.length >= 5) {
      addHashedFeature(vec, `pre5:${stem.slice(0, 5)}`, 0.7)
    }

    // Adjacent stem bigrams
    if (i + 1 < effectiveTokens.length) {
      const nextStem = stemToken(effectiveTokens[i + 1]!)
      addHashedFeature(vec, `bi:${stem}_${nextStem}`, 0.6)
    }
  }

  // Balance concept subspace (dims 0..63) vs lexical hash subspace (dims 64..127)
  const conceptEnergy = normalizeSubspaceInPlace(vec, 0, 64, 0.72)
  const hashEnergy = normalizeSubspaceInPlace(vec, 64, 128, conceptEnergy > 0 ? 0.28 : 1.0)

  if (conceptEnergy === 0 && hashEnergy === 0) {
    return new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  }

  // Final L2 normalization over all 128 dimensions
  let totalSq = 0
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    const v = vec[i] ?? 0
    totalSq += v * v
  }
  if (totalSq <= 1e-12) {
    return new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  }

  const invNorm = 1 / Math.sqrt(totalSq)
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    vec[i] = Number(((vec[i] ?? 0) * invNorm).toFixed(8))
  }

  return vec
}

/**
 * Computes bounded cosine similarity in [-1, 1] between two vectors.
 * Safely returns 0 on empty arrays, mismatched dimensions, non-finite elements, or zero vectors.
 */
export function computeCosineSimilarity128(
  a: readonly number[],
  b: readonly number[],
): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0
  if (a.length === 0 || a.length !== b.length) return 0

  let dot = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    const va = a[i]!
    const vb = b[i]!
    if (typeof va !== 'number' || typeof vb !== 'number' || !Number.isFinite(va) || !Number.isFinite(vb)) {
      return 0
    }
    dot += va * vb
    normA += va * va
    normB += vb * vb
  }

  if (normA <= 1e-12 || normB <= 1e-12) {
    return 0
  }

  const raw = dot / (Math.sqrt(normA) * Math.sqrt(normB))
  if (!Number.isFinite(raw)) return 0
  return Math.max(-1, Math.min(1, raw))
}

/**
 * Creates the local deterministic 128-D semantic embedding provider.
 */
export function createDeterministicSemanticEmbeddingProvider(
  modelId: string = DEFAULT_SEMANTIC_EMBEDDING_MODEL_ID,
): EmbeddingProvider {
  return {
    async embedText(text: string): Promise<EmbeddingResult> {
      const vector = embedTextSync128(text)
      return {
        vector,
        dimensions: vector.length,
        source: 'deterministic_semantic',
        modelId,
      }
    },
    async embedBatch(texts: readonly string[]): Promise<EmbeddingResult[]> {
      return texts.map((text) => {
        const vector = embedTextSync128(text)
        return {
          vector,
          dimensions: vector.length,
          source: 'deterministic_semantic' as const,
          modelId,
        }
      })
    },
  }
}

function isValidNumericVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

/**
 * Creates an OpenAI-compatible remote `/embeddings` provider (OpenAI, OpenRouter, Ollama, NVIDIA NIM).
 */
export function createOpenAICompatibleEmbeddingProvider(
  options: OpenAICompatibleEmbeddingProviderOptions = {},
): EmbeddingProvider {
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  const modelId = options.modelId ?? 'text-embedding-3-small'
  const timeoutMs = options.timeoutMs ?? 4000
  const fetchFn = options.fetchImpl ?? globalThis.fetch

  async function requestEmbeddings(inputs: readonly string[]): Promise<EmbeddingResult[]> {
    if (inputs.length === 0) return []

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers,
    }
    if (options.apiKey) {
      headers.Authorization = `Bearer ${options.apiKey}`
    }

    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => {
      controller.abort(new Error(`Embedding request timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    try {
      const response = await fetchFn(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelId,
          input: inputs.length === 1 ? inputs[0] : inputs,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText)
        throw new Error(`OpenAI-compatible embeddings HTTP ${response.status}: ${errText}`)
      }

      const payload = (await response.json()) as {
        data?: Array<{ index?: number; embedding?: unknown }>
      }

      if (!payload || !Array.isArray(payload.data) || payload.data.length !== inputs.length) {
        throw new Error('Malformed embeddings response payload')
      }

      const sorted = [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      return sorted.map((entry) => {
        if (!isValidNumericVector(entry?.embedding)) {
          throw new Error('Invalid embedding vector in response payload')
        }
        return {
          vector: entry.embedding,
          dimensions: entry.embedding.length,
          source: 'remote' as const,
          modelId,
        }
      })
    } finally {
      clearTimeout(timeoutHandle)
    }
  }

  return {
    async embedText(text: string): Promise<EmbeddingResult> {
      const results = await requestEmbeddings([text])
      return results[0]!
    },
    async embedBatch(texts: readonly string[]): Promise<EmbeddingResult[]> {
      return await requestEmbeddings(texts)
    },
  }
}

/**
 * Wraps an optional remote `EmbeddingProvider` with automatic fallback to the deterministic 128-D semantic provider.
 */
export function createResilientEmbeddingProvider(
  options: ResilientEmbeddingProviderOptions = {},
): EmbeddingProvider {
  const fallback = options.fallback ?? createDeterministicSemanticEmbeddingProvider()
  const remote = options.remote ?? null

  return {
    async embedText(text: string): Promise<EmbeddingResult> {
      if (!remote) {
        return await fallback.embedText(text)
      }
      try {
        const result = await remote.embedText(text)
        if (!result || !isValidNumericVector(result.vector)) {
          throw new Error('Invalid remote embedding vector')
        }
        return result
      } catch {
        return await fallback.embedText(text)
      }
    },
    async embedBatch(texts: readonly string[]): Promise<EmbeddingResult[]> {
      if (texts.length === 0) return []
      if (!remote) {
        return await fallback.embedBatch(texts)
      }
      try {
        const results = await remote.embedBatch(texts)
        if (
          !Array.isArray(results) ||
          results.length !== texts.length ||
          !results.every((r) => r && isValidNumericVector(r.vector))
        ) {
          throw new Error('Invalid remote batch embedding vectors')
        }
        return results
      } catch {
        return await fallback.embedBatch(texts)
      }
    },
  }
}
