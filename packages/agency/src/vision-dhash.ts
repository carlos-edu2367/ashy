const MASK_64 = 0xffffffffffffffffn
const DHASH_WIDTH = 9
const DHASH_HEIGHT = 8

export interface ScreenObservationFilterOptions {
  /** Maximum Hamming distance (0..64) considered static/unchanged. Default: 4 */
  maxHammingThreshold?: number
  /** Force a frame refresh after this many ms even if screen is static. Default: 30000 */
  forceRefreshMs?: number
}

export interface FrameEvaluationResult {
  skip: boolean
  hash: bigint
  distance: number
  reason: 'initial_frame' | 'force_refresh' | 'changed' | 'static_skipped'
}

export interface ScreenObservationFilter {
  shouldSkipFrame(
    pixels: Uint8Array | Uint8ClampedArray | readonly number[],
    width?: number,
    height?: number,
    nowMs?: number
  ): boolean
  evaluateFrame(
    pixels: Uint8Array | Uint8ClampedArray | readonly number[],
    width?: number,
    height?: number,
    nowMs?: number
  ): FrameEvaluationResult
  getLastHash(): bigint | null
  reset(): void
}

/**
 * Resamples an input buffer (either 9x8 grayscale luminance or WxH grayscale/RGBA)
 * into a 9x8 luminance grid (72 floating-point luminance values in 0..255).
 */
function resampleTo9x8Luminance(
  pixels: Uint8Array | Uint8ClampedArray | readonly number[],
  width: number,
  height: number
): Float64Array {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid frame dimensions: ${String(width)}x${String(height)}`)
  }
  const totalPixels = width * height
  if (!pixels || pixels.length < totalPixels) {
    throw new Error(
      `Pixel buffer too small: expected at least ${totalPixels} values, got ${pixels?.length ?? 0}`
    )
  }

  const isRgba = pixels.length >= totalPixels * 4
  const grid = new Float64Array(DHASH_WIDTH * DHASH_HEIGHT)

  // Fast path: already a 9x8 single-channel luminance grid
  if (!isRgba && width === DHASH_WIDTH && height === DHASH_HEIGHT) {
    for (let i = 0; i < DHASH_WIDTH * DHASH_HEIGHT; i++) {
      grid[i] = pixels[i] ?? 0
    }
    return grid
  }

  // Box-average resampling into 9x8 grid
  for (let gy = 0; gy < DHASH_HEIGHT; gy++) {
    const yStart = Math.floor((gy * height) / DHASH_HEIGHT)
    const yEnd = Math.max(yStart + 1, Math.floor(((gy + 1) * height) / DHASH_HEIGHT))

    for (let gx = 0; gx < DHASH_WIDTH; gx++) {
      const xStart = Math.floor((gx * width) / DHASH_WIDTH)
      const xEnd = Math.max(xStart + 1, Math.floor(((gx + 1) * width) / DHASH_WIDTH))

      let sumLum = 0
      let count = 0

      for (let y = yStart; y < yEnd && y < height; y++) {
        for (let x = xStart; x < xEnd && x < width; x++) {
          if (isRgba) {
            const idx = (y * width + x) * 4
            const r = pixels[idx] ?? 0
            const g = pixels[idx + 1] ?? 0
            const b = pixels[idx + 2] ?? 0
            // ITU-R BT.601 luminance
            sumLum += 0.299 * r + 0.587 * g + 0.114 * b
          } else {
            sumLum += pixels[y * width + x] ?? 0
          }
          count++
        }
      }

      grid[gy * DHASH_WIDTH + gx] = count > 0 ? sumLum / count : 0
    }
  }

  return grid
}

/**
 * Computes a 64-bit horizontal difference hash (dHash) from a 9x8 luminance grid
 * or an arbitrary WxH RGBA/grayscale pixel buffer.
 */
export function computeDHash64(
  pixels: Uint8Array | Uint8ClampedArray | readonly number[],
  width = DHASH_WIDTH,
  height = DHASH_HEIGHT
): bigint {
  const grid = resampleTo9x8Luminance(pixels, width, height)
  let hash = 0n

  for (let y = 0; y < DHASH_HEIGHT; y++) {
    const rowOffset = y * DHASH_WIDTH
    for (let x = 0; x < DHASH_WIDTH - 1; x++) {
      const left = grid[rowOffset + x]!
      const right = grid[rowOffset + x + 1]!
      if (left < right) {
        const bitPos = BigInt(y * 8 + x)
        hash |= 1n << bitPos
      }
    }
  }

  return hash & MASK_64
}

/**
 * Computes the Hamming distance (0..64) between two 64-bit dHash values.
 */
export function hammingDistance64(hashA: bigint, hashB: bigint): number {
  let diff = (hashA ^ hashB) & MASK_64
  let count = 0
  while (diff !== 0n) {
    diff &= diff - 1n // Brian Kernighan's bit-counting algorithm
    count++
  }
  return count
}

/**
 * Creates a stateful perceptual dHash screen observation filter that skips
 * static or near-identical frames so Ashy spends 0 vision tokens when idle.
 */
export function createScreenObservationFilter(
  options: ScreenObservationFilterOptions = {}
): ScreenObservationFilter {
  const maxHammingThreshold = Math.max(0, Math.min(64, options.maxHammingThreshold ?? 4))
  const forceRefreshMs = Math.max(0, options.forceRefreshMs ?? 30_000)

  let lastHash: bigint | null = null
  let lastAcceptedAtMs: number | null = null

  function evaluateFrame(
    pixels: Uint8Array | Uint8ClampedArray | readonly number[],
    width = DHASH_WIDTH,
    height = DHASH_HEIGHT,
    nowMs = Date.now()
  ): FrameEvaluationResult {
    const hash = computeDHash64(pixels, width, height)

    if (lastHash === null || lastAcceptedAtMs === null) {
      lastHash = hash
      lastAcceptedAtMs = nowMs
      return {
        skip: false,
        hash,
        distance: 0,
        reason: 'initial_frame',
      }
    }

    const distance = hammingDistance64(lastHash, hash)
    const elapsedMs = nowMs - lastAcceptedAtMs

    if (elapsedMs >= forceRefreshMs) {
      lastHash = hash
      lastAcceptedAtMs = nowMs
      return {
        skip: false,
        hash,
        distance,
        reason: 'force_refresh',
      }
    }

    if (distance <= maxHammingThreshold) {
      return {
        skip: true,
        hash,
        distance,
        reason: 'static_skipped',
      }
    }

    lastHash = hash
    lastAcceptedAtMs = nowMs
    return {
      skip: false,
      hash,
      distance,
      reason: 'changed',
    }
  }

  return {
    shouldSkipFrame(pixels, width = DHASH_WIDTH, height = DHASH_HEIGHT, nowMs = Date.now()): boolean {
      return evaluateFrame(pixels, width, height, nowMs).skip
    },
    evaluateFrame,
    getLastHash: () => lastHash,
    reset() {
      lastHash = null
      lastAcceptedAtMs = null
    },
  }
}
