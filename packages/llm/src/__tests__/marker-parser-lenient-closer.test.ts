import { describe, expect, it } from 'vitest'
import {
  createTailSafeMarkerParser,
  parseStageSignal,
  stripResidualStageMarkers,
  type AshyStageSignal,
} from '../marker-parser.js'
import { createOpenAICompatibleEmbeddingProvider } from '../embeddings.js'

describe('Phase 9.2 — Lenient Marker Closer (}>) & Embedding 404 Circuit Breaker', () => {
  it('parses <|ACT {...}> closed with }> instead of }|> and preserves all visible text', () => {
    const literals: string[] = []
    const signals: AshyStageSignal[] = []
    const parser = createTailSafeMarkerParser({
      onLiteral: (text) => literals.push(text),
      onSpecial: (sig) => signals.push(sig),
    })

    const realSessionOutput =
      '<|ACT {"emotion":"curious","intensity":0.68,"motion":"thinking"}>Carlos, o que você quer que eu analise ou te conte hoje?'
    parser.write(realSessionOutput)
    parser.flush()

    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      type: 'act',
      emotion: 'curious',
      intensity: 0.68,
      motion: 'thinking',
    })
    expect(literals.join('')).toBe('Carlos, o que você quer que eu analise ou te conte hoje?')
  })

  it('handles chunked streaming of <|ACT {...}> across token boundaries without leaking tag bytes', () => {
    const literals: string[] = []
    const signals: AshyStageSignal[] = []
    const parser = createTailSafeMarkerParser({
      onLiteral: (text) => literals.push(text),
      onSpecial: (sig) => signals.push(sig),
    })

    const chunks = [
      '<|',
      'ACT {"emotion":"happy",',
      '"intensity":0.8,"motion":"nod"}',
      '>Oi ',
      'Carlos! Tudo bem?',
    ]
    for (const chunk of chunks) {
      parser.write(chunk)
    }
    parser.flush()

    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      type: 'act',
      emotion: 'happy',
      intensity: 0.8,
      motion: 'nod',
    })
    expect(literals.join('')).toBe('Oi Carlos! Tudo bem?')
  })

  it('recovers trailing visible text on flush() if a malformed tag has a > closer without JSON', () => {
    const literals: string[] = []
    const signals: AshyStageSignal[] = []
    const parser = createTailSafeMarkerParser({
      onLiteral: (text) => literals.push(text),
      onSpecial: (sig) => signals.push(sig),
    })

    parser.write('<|DELAY 0.5>Fala recuperada com sucesso.')
    parser.flush()

    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      type: 'delay',
      seconds: 0.5,
    })
    expect(literals.join('')).toBe('Fala recuperada com sucesso.')
  })

  it('stripResidualStageMarkers removes both <|...|> and <|...}> tags cleanly', () => {
    const raw =
      '<|ACT {"emotion":"curious","intensity":0.68,"motion":"thinking"}>Oi Carlos! <|DELAY 0.5|>Tudo bem?'
    expect(stripResidualStageMarkers(raw)).toBe('Oi Carlos! Tudo bem?')
    expect(
      parseStageSignal('<|ACT {"emotion":"curious","intensity":0.68,"motion":"thinking"}>'),
    ).toMatchObject({
      type: 'act',
      emotion: 'curious',
      intensity: 0.68,
      motion: 'thinking',
    })
  })

  it('short-circuits subsequent embedding HTTP calls after a 404 model-not-found error', async () => {
    let calls = 0
    const provider = createOpenAICompatibleEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'nomic-embed-text',
      fetchImpl: async () => {
        calls += 1
        return new Response('model "nomic-embed-text" not found', { status: 404 })
      },
    })

    await expect(provider.embedText('primeiro teste')).rejects.toThrow(/404/)
    await expect(provider.embedText('segundo teste')).rejects.toThrow(/404/)
    expect(calls).toBe(1)
  })

  it('adversarial: handles chunk splits right between } and |>, nested JSON objects in ACT, and multiple mixed tags in one turn', () => {
    const literals: string[] = []
    const signals: AshyStageSignal[] = []
    const parser = createTailSafeMarkerParser({
      onLiteral: (text) => literals.push(text),
      onSpecial: (sig) => signals.push(sig),
    })

    const chunks = [
      '<|ACT {"emotion":{"name":"smug","intensity":0.9},"motion":"tease"}',
      '|>',
      'Primeira frase. ',
      '<|ACT {"emotion":{"name":"happy","intensity":0.75},"motion":"wave"}>',
      'Segunda frase',
      '<|DELAY 0.75>',
      ' e terceira ',
      '<|CALLBACK motif_1>',
      'final!',
    ]

    for (const chunk of chunks) {
      parser.write(chunk)
    }
    parser.flush()

    expect(literals.join('')).toBe('Primeira frase. Segunda frase e terceira final!')
    expect(signals).toHaveLength(4)
    expect(signals[0]).toMatchObject({
      type: 'act',
      emotion: 'smug',
      intensity: 0.9,
      motion: 'tease',
    })
    expect(signals[1]).toMatchObject({
      type: 'act',
      emotion: 'happy',
      intensity: 0.75,
      motion: 'wave',
    })
    expect(signals[2]).toMatchObject({
      type: 'delay',
      seconds: 0.75,
    })
    expect(signals[3]).toMatchObject({
      type: 'callback',
      motifId: 'motif_1',
    })
  })

  it('adversarial: flush() recovers literal text after > even when an ACT tag omits JSON braces completely', () => {
    const literals: string[] = []
    const signals: AshyStageSignal[] = []
    const parser = createTailSafeMarkerParser({
      onLiteral: (text) => literals.push(text),
      onSpecial: (sig) => signals.push(sig),
    })

    parser.write('<|ACT emotion=curious>Mesmo sem chaves JSON, minha fala não sumiu!')
    parser.flush()

    expect(signals).toHaveLength(1)
    expect(signals[0]?.type).toBe('unknown')
    expect(literals.join('')).toBe('Mesmo sem chaves JSON, minha fala não sumiu!')
  })
})
