import type { PcmAudioBlock } from './audio-input'

export interface VadFrameAssessment {
  probability: number
  rmsEnergy: number
  zeroCrossingRate: number
  bandEnergyRatio: number
  isSpeechCandidate: boolean
  engineMode?: 'silero-onnx' | 'hybrid-dsp'
}

export interface VadEngine {
  processBlock(block: PcmAudioBlock): Promise<VadFrameAssessment> | VadFrameAssessment
  getEngineMode?(): 'silero-onnx' | 'hybrid-dsp'
  reset(): void
}

export interface HybridVadEngineOptions {
  modelInferFn?: (samples: Float32Array, sampleRate: number) => Promise<number> | number
  modelBlendWeight?: number
  candidateThreshold?: number
}

export interface SileroOnnxTensorLike {
  data: Float32Array | BigInt64Array | Int32Array | number[]
  dims?: readonly number[]
}

export interface SileroOnnxSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, SileroOnnxTensorLike>>
}

export interface SileroOnnxVadEngineOptions {
  onnxSession?: SileroOnnxSessionLike | null
  sessionLoader?: () => Promise<SileroOnnxSessionLike | null>
  tensorFactory?: (
    type: 'float32' | 'int64',
    data: Float32Array | BigInt64Array | number[],
    dims: readonly number[],
  ) => unknown
  candidateThreshold?: number
  modelBlendWeight?: number
}

export function downsamplePcmFloat32(
  samples: Float32Array,
  inputSampleRate: number,
  targetSampleRate = 16000,
): Float32Array {
  if (
    !Number.isFinite(inputSampleRate) ||
    inputSampleRate <= 0 ||
    !Number.isFinite(targetSampleRate) ||
    targetSampleRate <= 0
  ) {
    throw new Error(
      `Invalid sampleRate in downsamplePcmFloat32: inputSampleRate=${inputSampleRate}, targetSampleRate=${targetSampleRate}`,
    )
  }

  if (!(samples instanceof Float32Array) || samples.length === 0) {
    return new Float32Array(0)
  }

  if (inputSampleRate === targetSampleRate) {
    const copy = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i]!
      copy[i] = Number.isFinite(v) ? v : 0
    }
    return copy
  }

  const targetLength = Math.max(0, Math.round((samples.length * targetSampleRate) / inputSampleRate))
  if (targetLength === 0) {
    return new Float32Array(0)
  }

  const output = new Float32Array(targetLength)
  const ratio = inputSampleRate / targetSampleRate

  if (ratio > 1) {
    // Anti-aliasing fractional box/window averaging across the decimation ratio
    for (let i = 0; i < targetLength; i++) {
      const start = i * ratio
      const end = Math.min(samples.length, (i + 1) * ratio)
      const startIdx = Math.floor(start)
      const endIdx = Math.min(samples.length - 1, Math.ceil(end) - 1)

      let weightedSum = 0
      let totalWeight = 0

      for (let j = startIdx; j <= endIdx; j++) {
        const raw = samples[j]!
        const sample = Number.isFinite(raw) ? raw : 0
        const weight = Math.max(0, Math.min(end, j + 1) - Math.max(start, j))
        weightedSum += sample * weight
        totalWeight += weight
      }

      output[i] = totalWeight > 0 ? weightedSum / totalWeight : 0
    }
    return output
  }

  // Upsampling fallback via linear interpolation
  for (let i = 0; i < targetLength; i++) {
    const srcPos = i * ratio
    const idx0 = Math.min(samples.length - 1, Math.floor(srcPos))
    const idx1 = Math.min(samples.length - 1, idx0 + 1)
    const frac = srcPos - idx0
    const s0 = Number.isFinite(samples[idx0]!) ? samples[idx0]! : 0
    const s1 = Number.isFinite(samples[idx1]!) ? samples[idx1]! : 0
    output[i] = s0 + (s1 - s0) * frac
  }

  return output
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
      engineMode: 'hybrid-dsp',
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
      engineMode: 'hybrid-dsp',
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
    engineMode: 'hybrid-dsp',
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
      engineMode: 'hybrid-dsp',
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
    getEngineMode(): 'hybrid-dsp' {
      return 'hybrid-dsp'
    },
    reset(): void {
      // Stateless per-frame hybrid evaluator; hook provided for stateful ONNX wrappers
    },
  }
}

const SILERO_STATE_SIZE = 2 * 1 * 128

export function createSileroOnnxVadEngine(options: SileroOnnxVadEngineOptions = {}): VadEngine {
  const candidateThreshold = options.candidateThreshold ?? 0.6
  const blendWeight = Math.max(0, Math.min(1, options.modelBlendWeight ?? 0.8))
  const fallbackVad = createHybridVadEngine({ candidateThreshold })

  let state = new Float32Array(SILERO_STATE_SIZE)
  let resolvedSession: SileroOnnxSessionLike | null | undefined = options.onnxSession
  let loadingSessionPromise: Promise<SileroOnnxSessionLike | null> | null = null
  let currentEngineMode: 'silero-onnx' | 'hybrid-dsp' = options.onnxSession
    ? 'silero-onnx'
    : 'hybrid-dsp'

  async function resolveSession(): Promise<SileroOnnxSessionLike | null> {
    if (resolvedSession !== undefined) {
      return resolvedSession
    }
    if (!options.sessionLoader) {
      resolvedSession = null
      return null
    }
    if (!loadingSessionPromise) {
      loadingSessionPromise = Promise.resolve()
        .then(() => options.sessionLoader!())
        .catch(() => null)
    }
    resolvedSession = await loadingSessionPromise
    return resolvedSession
  }

  function buildTensor(
    type: 'float32' | 'int64',
    data: Float32Array | BigInt64Array | number[],
    dims: readonly number[],
  ): unknown {
    if (options.tensorFactory) {
      return options.tensorFactory(type, data, dims)
    }
    return { type, data, dims }
  }

  function updateRecurrentState(outputs: Record<string, SileroOnnxTensorLike>): void {
    const nextStateTensor = outputs.stateN ?? outputs.hn
    if (nextStateTensor && nextStateTensor.data) {
      const nextData = nextStateTensor.data
      const updated = new Float32Array(SILERO_STATE_SIZE)
      const copyLen = Math.min(SILERO_STATE_SIZE, nextData.length)
      for (let i = 0; i < copyLen; i++) {
        const val = Number(nextData[i])
        updated[i] = Number.isFinite(val) ? val : 0
      }
      if (outputs.cn?.data && copyLen <= SILERO_STATE_SIZE / 2) {
        const cnData = outputs.cn.data
        const half = SILERO_STATE_SIZE / 2
        const cnLen = Math.min(half, cnData.length)
        for (let i = 0; i < cnLen; i++) {
          const val = Number(cnData[i])
          updated[half + i] = Number.isFinite(val) ? val : 0
        }
      }
      state = updated
    }
  }

  return {
    async processBlock(block: PcmAudioBlock): Promise<VadFrameAssessment> {
      const samples16k =
        block.sampleRate === 16000
          ? block.samples
          : downsamplePcmFloat32(block.samples, block.sampleRate || 16000, 16000)

      const dspBase = computeFrameSpeechProbability(samples16k, 16000, candidateThreshold)
      const session = await resolveSession()

      if (!session) {
        currentEngineMode = 'hybrid-dsp'
        return {
          ...dspBase,
          engineMode: 'hybrid-dsp',
        }
      }

      try {
        const inputTensor = buildTensor('float32', samples16k, [1, samples16k.length])
        const stateSnapshot = new Float32Array(state)
        const stateTensor = buildTensor('float32', stateSnapshot, [2, 1, 128])
        const srData =
          typeof BigInt64Array !== 'undefined' ? new BigInt64Array([16000n]) : [16000]
        const srTensor = buildTensor('int64', srData, [1])

        const outputs = await session.run({
          input: inputTensor,
          state: stateTensor,
          sr: srTensor,
        })

        const outputTensor = outputs.output ?? Object.values(outputs)[0]
        const rawProb = outputTensor?.data ? Number(outputTensor.data[0]) : Number.NaN

        if (!Number.isFinite(rawProb)) {
          currentEngineMode = 'hybrid-dsp'
          return {
            ...dspBase,
            engineMode: 'hybrid-dsp',
          }
        }

        updateRecurrentState(outputs)
        currentEngineMode = 'silero-onnx'

        const clampedOnnx = Math.max(0, Math.min(1, rawProb))
        const blendedProb = Number(
          (blendWeight * clampedOnnx + (1 - blendWeight) * dspBase.probability).toFixed(6),
        )

        return {
          ...dspBase,
          probability: blendedProb,
          isSpeechCandidate: blendedProb >= candidateThreshold,
          engineMode: 'silero-onnx',
        }
      } catch {
        currentEngineMode = 'hybrid-dsp'
        const fallbackRes = await fallbackVad.processBlock(block)
        return {
          ...fallbackRes,
          engineMode: 'hybrid-dsp',
        }
      }
    },
    getEngineMode() {
      return currentEngineMode
    },
    reset(): void {
      state.fill(0)
      fallbackVad.reset()
    },
  }
}
