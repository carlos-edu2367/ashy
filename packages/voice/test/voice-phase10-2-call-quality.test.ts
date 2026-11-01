import { describe, expect, it } from 'vitest'
import {
  buildSessionRecap,
  createGaplessAudioPlayer,
  extractActMarkers,
  isNearRepeat,
  splitCompletedSentences,
  stripCallMarkers,
  textSimilarity,
} from '../src'
import { createFakePlaybackContext } from './helpers/phase10-1-fakes'

describe('Phase 10.2 player ducking (setDuck)', () => {
  it('ramps the GainNode to −12 dB and back to unity with setDuck(0)', () => {
    const playback = createFakePlaybackContext()
    const player = createGaplessAudioPlayer({ audioContext: playback.ctx })
    const gain = playback.gains.at(-1)!.gain
    player.scheduleChunk({ samples: new Float32Array(24000), sampleRate: 24000 })

    playback.ctx.currentTime = 0.2
    player.setDuck(-12, 80)
    expect(player.getDuckDb()).toBe(-12)
    expect(gain.cancelScheduledValues).toHaveBeenLastCalledWith(0.2)
    expect(gain.setValueAtTime).toHaveBeenLastCalledWith(1, 0.2)
    const [target, endTime] = gain.linearRampToValueAtTime.mock.calls.at(-1)!
    expect(target).toBeCloseTo(Math.pow(10, -12 / 20), 5) // ≈ 0.251
    expect(endTime).toBeCloseTo(0.28, 6)
    // Evaluated on the player clock: halfway through the ramp, then fully ducked.
    playback.ctx.currentTime = 0.24
    expect(player.getGainValue()).toBeCloseTo((1 + 0.2512) / 2, 2)
    playback.ctx.currentTime = 0.3
    expect(player.getGainValue()).toBeCloseTo(0.2512, 3)

    player.setDuck(0, 150)
    expect(player.getDuckDb()).toBe(0)
    expect(gain.setValueAtTime.mock.calls.at(-1)![0]).toBeCloseTo(0.2512, 3)
    const [restored, restoreEnd] = gain.linearRampToValueAtTime.mock.calls.at(-1)!
    expect(restored).toBe(1)
    expect(restoreEnd).toBeCloseTo(0.45, 6)
    playback.ctx.currentTime = 0.5
    expect(player.getGainValue()).toBe(1)
  })

  it('works on the virtual clock without an AudioContext', () => {
    const player = createGaplessAudioPlayer()
    player.scheduleChunk({ samples: new Float32Array(16000), sampleRate: 16000 })
    player.setVirtualClockSec(0.1)
    player.setDuck(-12, 100)
    expect(player.getGainValue()).toBeCloseTo(1, 5)
    player.setVirtualClockSec(0.15)
    expect(player.getGainValue()).toBeCloseTo((1 + 0.2512) / 2, 2)
    player.setVirtualClockSec(0.25)
    expect(player.getGainValue()).toBeCloseTo(0.2512, 3)
    player.setDuck(0, 0)
    expect(player.getGainValue()).toBe(1)
  })

  it('stopWithFade fades from the ducked level and clears the duck; the next chunk plays at unity', () => {
    const playback = createFakePlaybackContext()
    const player = createGaplessAudioPlayer({ audioContext: playback.ctx })
    const gain = playback.gains.at(-1)!.gain
    player.scheduleChunk({ samples: new Float32Array(24000), sampleRate: 24000 })
    player.setDuck(-12, 0)
    playback.ctx.currentTime = 0.1
    player.stopWithFade(120)
    expect(gain.setValueAtTime.mock.calls.at(-1)![0]).toBeCloseTo(0.2512, 3)
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, expect.closeTo(0.22, 6))
    expect(player.getDuckDb()).toBe(0)
    expect(player.getGainValue()).toBe(0)
    player.scheduleChunk({ samples: new Float32Array(2400), sampleRate: 24000 })
    expect(player.getGainValue()).toBe(1)
    expect(gain.setValueAtTime).toHaveBeenLastCalledWith(1, 0.1)
  })

  it('reset() un-ducks the GainNode', () => {
    const playback = createFakePlaybackContext()
    const player = createGaplessAudioPlayer({ audioContext: playback.ctx })
    const gain = playback.gains.at(-1)!.gain
    player.setDuck(-12, 50)
    gain.setValueAtTime.mockClear()
    player.reset()
    expect(player.getDuckDb()).toBe(0)
    expect(gain.setValueAtTime).toHaveBeenCalledWith(1, 0)
    expect(player.getGainValue()).toBe(1)
  })
})

describe('Phase 10.2 textSimilarity / recap', () => {
  const cats = 'Gatos são ótimos parceiros, independentes e muito curiosos com tudo.'
  it('scores verbatim and near-verbatim repeats ≥ 0.8 and unrelated replies low', () => {
    expect(textSimilarity(cats, cats)).toBe(1)
    expect(textSimilarity(cats, `Claro! ${cats}`)).toBeGreaterThanOrEqual(0.8)
    expect(textSimilarity(cats, 'Tudo ótimo por aqui, e com você?')).toBeLessThan(0.3)
    // Containment does not count for very short texts.
    expect(textSimilarity('sim', cats)).toBeLessThan(0.2)
    expect(textSimilarity('', cats)).toBe(0)
    expect(isNearRepeat(`${cats}`, ['Oi!', cats])).toBe(true)
    expect(isNearRepeat('Hoje faz sol em Fortaleza.', ['Oi!', cats])).toBe(false)
  })

  it('builds ONE "[Contexto] Resumo da conversa até aqui" from the last 4 exchanges with near-duplicates removed', () => {
    const recap = buildSessionRecap(
      [
        { user: 'oi', assistant: 'Oi! Tudo bem?' },
        { user: 'me fala de gatos', assistant: cats },
        { user: 'e cachorros?', assistant: 'Cachorros são leais e brincalhões.' },
        { user: 'tudo bem?', assistant: cats }, // the 2B repeat
        { user: 'qual seu nome?', assistant: 'Eu sou a Ashy.' },
      ],
      { userLabel: 'Carlos' },
    )
    expect(recap.startsWith('[Contexto] Resumo da conversa até aqui:')).toBe(true)
    expect(recap).not.toContain('Oi! Tudo bem?') // only the last 4 exchanges
    expect(recap.split(cats).length - 1).toBe(1) // the repeated reply appears once
    expect(recap).toContain('- Carlos: tudo bem?')
    expect(recap).toContain('- Você: Eu sou a Ashy.')
    expect(buildSessionRecap([])).toBe('')
  })
})

describe('Phase 10.2 ACT markers', () => {
  it('parses <|ACT {json}|> and the }> ending, strips every marker and keeps clean-text offsets', () => {
    const raw =
      '<|ACT {"emotion":"happy","intensity":0.8,"motion":"nod"}|>Oi! Que bom te ver. <|ACT {"emotion":"curious","intensity":0.5}>Me conta mais?<|im_end|>'
    const { clean, markers } = extractActMarkers(raw)
    expect(clean).toBe('Oi! Que bom te ver. Me conta mais?')
    expect(markers).toEqual([
      { offset: 0, signal: { emotion: 'happy', intensity: 0.8, motion: 'nod' } },
      { offset: 20, signal: { emotion: 'curious', intensity: 0.5 } },
    ])
    expect(stripCallMarkers(raw)).toBe('Oi! Que bom te ver. Me conta mais?')
  })

  it('hides an unfinished marker while streaming', () => {
    expect(extractActMarkers('Oi! <|ACT {"emotion":"ha').clean).toBe('Oi! ')
    expect(stripCallMarkers('Oi! <|ACT {"emotion":"ha')).toBe('Oi! ')
  })

  it('splits complete sentences (the tail only when final)', () => {
    expect(splitCompletedSentences('Oi! Tudo bem? Eu', false).map((s) => s.text)).toEqual(['Oi!', 'Tudo bem?'])
    expect(splitCompletedSentences('Oi! Tudo bem? Eu', true).map((s) => [s.start, s.text])).toEqual([
      [0, 'Oi!'],
      [4, 'Tudo bem?'],
      [14, 'Eu'],
    ])
  })
})

