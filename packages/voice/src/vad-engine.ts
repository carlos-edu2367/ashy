import type { PcmAudioBlock } from './audio-input'

export interface VadFrameAssessment {
  probability: number
  rmsEnergy: number
  zeroCrossingRate: number
  bandEnergyRatio: number
  isSpeechCandidate: boolean
}

export interface VadEngine {
  processBlock(block: PcmAudioBlock): Promise<VadFrameAssessment> | VadFrameAssessment
  reset(): void
}

export interface HybridVadEngineOptions {
  modelInferFn?: (samples: Float32Array, sampleRate: number) => Promise<number> | number
  modelBlendWeight?: number
  candidateThreshold?: number
}

export function computeFrameSpeechProbability(
  samples: Float32Array,
  _sampleRate = 16000,
  candidateThreshold = 0.6,
): VadFrameAssessment {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    return {
      probability: 0,
      rmsEnergy: 0,
      zeroCrossingRate: 0,
      bandEnergyRatio: 0,
      isSpeechCandidate: false,
    }
  }

  const n = samples.length
  let sum = 0
  for (let i = 0; i < n; i++) {
    const val = samples[i]!
    sum += Number.isFinite(val) ? val : 0
  }
  const mean = sum / n

  let acSumSq = 0
  let lpSumSq = 0
  let zeroCrossings = 0
  let prevSign = 0

  for (let i = 0; i < n; i++) {
    const raw = samples[i]!
    const x = (Number.isFinite(raw) ? raw : 0) - mean
    acSumSq += x * x

    // 3-tap low-pass speech-band filter (attenuates high-frequency Nyquist hiss)
    const prevRaw = i > 0 ? samples[i - 1]! : raw
    const nextRaw = i + 1 < n ? samples[i + 1]! : raw
    const xPrev = (Number.isFinite(prevRaw) ? prevRaw : 0) - mean
    const xNext = (Number.isFinite(nextRaw) ? nextRaw : 0) - mean
    const lp = 0.25 * xPrev + 0.5 * x + 0.25 * xNext
    lpSumSq += lp * lp

    const sign = Math.abs(x) < 1e-5 ? 0 : x > 0 ? 1 : -1
    if (sign !== 0) {
      if (prevSign !== 0 && sign !== prevSign) {
        zeroCrossings += 1
      }
      prevSign = sign
    }
  }

  const acRms = Math.sqrt(acSumSq / n)
  const zeroCrossingRate = n > 1 ? zeroCrossings / (n - 1) : 0

  // Pure silence or pure DC offset (no AC energy or zero sign changes)
  if (acRms < 1e-4 || zeroCrossingRate < 0.004) {
    return {
      probability: 0,
      rmsEnergy: Number(acRms.toFixed(6)),
      zeroCrossingRate: Number(zeroCrossingRate.toFixed(6)),
      bandEnergyRatio: 0,
      isSpeechCandidate: false,
    }
  }

  const rawBandRatio = acSumSq > 0 ? Math.min(1, lpSumSq / acSumSq) : 0
  const zcrInSpeechBand = zeroCrossingRate >= 0.008 && zeroCrossingRate <= 0.4
  const bandEnergyRatio = zcrInSpeechBand ? rawBandRatio : rawBandRatio * 0.45

  // Map AC RMS energy into speech probability regimes:
  // - < 0.008: silence / noise floor (< 0.05)
  // - 0.015 .. 0.075: low-amplitude sustain speech ([0.20, 0.55])
  // - > 0.075: active voiced speech (>= 0.65)
  let energyScore: number
  if (acRms <= 0.008) {
    energyScore = (acRms / 0.008) * 0.03
  } else if (acRms <= 0.018) {
    energyScore = 0.03 + ((acRms - 0.008) / 0.01) * 0.2
  } else if (acRms <= 0.075) {
    energyScore = 0.23 + ((acRms - 0.018) / 0.057) * 0.29
  } else {
    energyScore = 0.68 + Math.min(0.31, ((acRms - 0.075) / 0.25) * 0.31)
  }

  const spectralFactor = bandEnergyRatio >= 0.55 ? 1.0 : Math.max(0.2, bandEnergyRatio)
  const probability = Number(
    Math.max(0, Math.min(1, energyScore * spectralFactor)).toFixed(6),
  )

  return {
    probability,
    rmsEnergy: Number(acRms.toFixed(6)),
    zeroCrossingRate: Number(zeroCrossingRate.toFixed(6)),
    bandEnergyRatio: Number(bandEnergyRatio.toFixed(6)),
    isSpeechCandidate: probability >= candidateThreshold,
  }
}

export function createHybridVadEngine(options: HybridVadEngineOptions = {}): VadEngine {
  const candidateThreshold = options.candidateThreshold ?? 0.6
  const blendWeight = Math.max(0, Math.min(1, options.modelBlendWeight ?? 1.0))

  function applyModelProbability(
    base: VadFrameAssessment,
    modelProb: unknown,
  ): VadFrameAssessment {
    if (typeof modelProb !== 'number' || !Number.isFinite(modelProb)) {
      return base
    }
    const clampedModel = Math.max(0, Math.min(1, modelProb))
    const blended = Number(
      (blendWeight * clampedModel + (1 - blendWeight) * base.probability).toFixed(6),
    )
    return {
      ...base,
      probability: blended,
      isSpeechCandidate: blended >= candidateThreshold,
    }
  }

  return {
    processBlock(block: PcmAudioBlock): Promise<VadFrameAssessment> | VadFrameAssessment {
      const base = computeFrameSpeechProbability(
        block.samples,
        block.sampleRate,
        candidateThreshold,
      )

      if (!options.modelInferFn) {
        return base
      }

      try {
        const res = options.modelInferFn(block.samples, block.sampleRate)
        if (res && typeof (res as Promise<number>).then === 'function') {
          return (res as Promise<number>).then(
            (modelProb) => applyModelProbability(base, modelProb),
            () => base,
          )
        }
        return applyModelProbability(base, res)
      } catch {
        return base
      }
    },
    reset(): void {
      // Stateless per-frame hybrid evaluator; hook provided for stateful ONNX wrappers
    },
  }
}
