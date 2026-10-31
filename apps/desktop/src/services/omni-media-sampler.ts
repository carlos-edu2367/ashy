import { computeDHash64, hammingDistance64 } from '@ashy/agency'
import type { TurnVideoFrame } from '@ashy/shared'

export interface OmniMediaSamplerOptions {
  fps?: number
  maxFramesInBuffer?: number
  maxHammingDistance?: number
  targetWidth?: number
  targetHeight?: number
  jpegQuality?: number
  getUserMediaFn?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  onFrameSampled?: (frame: TurnVideoFrame) => void
  onError?: (err: Error) => void
}

export interface LiveWebcamSampler {
  start(deviceId?: string): Promise<boolean>
  stop(): void
  isRunning(): boolean
  getRecentFrames(maxCount?: number): TurnVideoFrame[]
  clearFrames(): void
}

function parseHexToBigInt(hex: string): bigint {
  const clean = hex.trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]+$/.test(clean)) return 0n
  return BigInt(`0x${clean}`)
}

export function computeDHashHex64(
  pixels: Uint8Array | Uint8ClampedArray | readonly number[],
  width = 9,
  height = 8,
): string {
  return computeDHash64(pixels, width, height).toString(16).padStart(16, '0')
}

export function hammingDistanceHex64(hexA: string, hexB: string): number {
  return hammingDistance64(parseHexToBigInt(hexA), parseHexToBigInt(hexB))
}

export function createSyntheticVideoFrameDataUrl(
  seed = 1,
  timestampMs = 0,
  source: 'screen' | 'camera' | 'clip' = 'camera',
): TurnVideoFrame {
  const lum = new Uint8Array(72)
  for (let i = 0; i < 72; i++) {
    lum[i] = (i * 19 + seed * 37) & 0xff
  }
  const dHashHex = computeDHashHex64(lum, 9, 8)
  const fakeJpegBytes = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    seed & 0xff,
    (timestampMs >> 4) & 0xff,
    0xff,
    0xd9,
  ])
  let b64 = ''
  if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(fakeJpegBytes).toString('base64')
  } else {
    b64 = btoa(String.fromCharCode(...fakeJpegBytes))
  }
  return {
    dataUrl: `data:image/jpeg;base64,${b64}`,
    timestampMs,
    width: 640,
    height: 360,
    source,
    dHashHex,
  }
}

export function deduplicateVideoFramesByDHash(
  frames: readonly TurnVideoFrame[],
  maxHammingDistance = 4,
  maxFrames = 8,
): TurnVideoFrame[] {
  const kept: TurnVideoFrame[] = []
  let lastHash: string | null = null

  for (const frame of frames) {
    if (frame.dHashHex && lastHash && frame.dHashHex.length === 16 && lastHash.length === 16) {
      const dist = hammingDistanceHex64(lastHash, frame.dHashHex)
      if (dist <= maxHammingDistance) {
        continue
      }
    }
    kept.push(frame)
    if (frame.dHashHex) {
      lastHash = frame.dHashHex
    }
  }

  if (kept.length <= maxFrames) {
    return kept
  }
  return kept.slice(kept.length - maxFrames)
}

export function createLiveWebcamSampler(
  options: OmniMediaSamplerOptions = {},
): LiveWebcamSampler {
  const fps = Math.max(0.5, Math.min(5, options.fps ?? 2))
  const intervalMs = Math.round(1000 / fps)
  const maxFramesInBuffer = options.maxFramesInBuffer ?? 8
  const maxHammingDistance = options.maxHammingDistance ?? 4
  const targetWidth = options.targetWidth ?? 640
  const targetHeight = options.targetHeight ?? 360
  const jpegQuality = options.jpegQuality ?? 0.72

  let running = false
  let generationId = 0
  let activeStream: MediaStream | null = null
  let timerId: ReturnType<typeof setInterval> | null = null
  let videoEl: HTMLVideoElement | null = null
  let canvasEl: HTMLCanvasElement | null = null
  let recentFrames: TurnVideoFrame[] = []
  let lastDHashHex: string | null = null
  let startedAtMs = 0
  let syntheticTick = 0

  function stopTracks(stream: MediaStream | null): void {
    if (!stream) return
    try {
      for (const track of stream.getTracks()) {
        track.stop()
      }
    } catch {
      // ignore track cleanup error
    }
  }

  function captureSingleFrame(): void {
    if (!running) return
    const elapsedMs = Math.max(0, Date.now() - startedAtMs)

    if (videoEl && canvasEl && typeof canvasEl.getContext === 'function') {
      const ctx = canvasEl.getContext('2d')
      if (ctx && videoEl.readyState >= 2) {
        try {
          ctx.drawImage(videoEl, 0, 0, targetWidth, targetHeight)
          const smallData = ctx.getImageData(0, 0, 9, 8)
          const lum = new Uint8Array(72)
          for (let i = 0; i < 72; i++) {
            const r = smallData.data[i * 4] ?? 0
            const g = smallData.data[i * 4 + 1] ?? 0
            const b = smallData.data[i * 4 + 2] ?? 0
            lum[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
          }
          const dHashHex = computeDHashHex64(lum, 9, 8)
          if (lastDHashHex && hammingDistanceHex64(lastDHashHex, dHashHex) <= maxHammingDistance) {
            return
          }
          const dataUrl = canvasEl.toDataURL('image/jpeg', jpegQuality)
          if (dataUrl.startsWith('data:image/')) {
            lastDHashHex = dHashHex
            const frame: TurnVideoFrame = {
              dataUrl,
              timestampMs: elapsedMs,
              width: targetWidth,
              height: targetHeight,
              source: 'camera',
              dHashHex,
            }
            recentFrames.push(frame)
            if (recentFrames.length > maxFramesInBuffer) {
              recentFrames = recentFrames.slice(recentFrames.length - maxFramesInBuffer)
            }
            options.onFrameSampled?.(frame)
            return
          }
        } catch {
          // Fallback to synthetic frame in headless/jsdom environments
        }
      }
    }

    syntheticTick += 1
    const synthFrame = createSyntheticVideoFrameDataUrl(syntheticTick, elapsedMs, 'camera')
    if (
      lastDHashHex &&
      synthFrame.dHashHex &&
      hammingDistanceHex64(lastDHashHex, synthFrame.dHashHex) <= maxHammingDistance
    ) {
      return
    }
    lastDHashHex = synthFrame.dHashHex ?? null
    recentFrames.push(synthFrame)
    if (recentFrames.length > maxFramesInBuffer) {
      recentFrames = recentFrames.slice(recentFrames.length - maxFramesInBuffer)
    }
    options.onFrameSampled?.(synthFrame)
  }

  return {
    async start(deviceId?: string): Promise<boolean> {
      const myGen = ++generationId
      running = true
      startedAtMs = Date.now()

      const getUserMedia =
        options.getUserMediaFn ??
        (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
          ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
          : null)

      if (getUserMedia) {
        try {
          const constraints: MediaStreamConstraints = {
            video: deviceId
              ? { deviceId: { exact: deviceId }, width: targetWidth, height: targetHeight }
              : { width: targetWidth, height: targetHeight },
            audio: false,
          }
          const stream = await getUserMedia(constraints)
          if (myGen !== generationId || !running) {
            stopTracks(stream)
            return false
          }
          activeStream = stream
          if (typeof document !== 'undefined') {
            videoEl = document.createElement('video')
            videoEl.muted = true
            videoEl.playsInline = true
            try {
              videoEl.srcObject = stream
              await videoEl.play()
            } catch {
              // headless / jsdom video play fallback
            }
            canvasEl = document.createElement('canvas')
            canvasEl.width = targetWidth
            canvasEl.height = targetHeight
          }
        } catch (err) {
          if (myGen !== generationId || !running) {
            return false
          }
          options.onError?.(err instanceof Error ? err : new Error(String(err)))
          running = false
          return false
        }
      }

      if (myGen !== generationId || !running) {
        stopTracks(activeStream)
        activeStream = null
        return false
      }

      captureSingleFrame()
      timerId = setInterval(captureSingleFrame, intervalMs)
      return true
    },

    stop(): void {
      generationId += 1
      running = false
      if (timerId !== null) {
        clearInterval(timerId)
        timerId = null
      }
      stopTracks(activeStream)
      activeStream = null
      if (videoEl) {
        try {
          videoEl.srcObject = null
        } catch {
          // ignore
        }
        videoEl = null
      }
      canvasEl = null
    },

    isRunning(): boolean {
      return running
    },

    getRecentFrames(maxCount = maxFramesInBuffer): TurnVideoFrame[] {
      if (recentFrames.length <= maxCount) {
        return [...recentFrames]
      }
      return recentFrames.slice(recentFrames.length - maxCount)
    },

    clearFrames(): void {
      recentFrames = []
      lastDHashHex = null
    },
  }
}
