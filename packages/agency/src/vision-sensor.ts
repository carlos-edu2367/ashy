import { type ActionGatekeeper } from './action-gatekeeper'
import { type EyesMode, type PrivacyController } from './privacy-controller'
import {
  createScreenObservationFilter,
  type ScreenObservationFilterOptions,
} from './vision-dhash'

export interface CapturedScreenFrame {
  width: number
  height: number
  pixels: Uint8Array | Uint8ClampedArray | readonly number[]
  windowTitle?: string
  sourceType?: 'window' | 'screen'
}

export interface VisionObservationResult {
  observed: boolean
  skippedByDhash: boolean
  blockedByPrivacy: boolean
  windowTitle: string | null
  summary: string | null
  dHashHex: string | null
  hammingDistance: number | null
  visionTokensSpent: number
  timestamp: number
  reason: string
}

export interface VisionTelemetryState {
  eyesMode: EyesMode
  lastObservation: VisionObservationResult | null
  framesCapturedCount: number
  framesSkippedByDhashCount: number
  blockedPrivacyCount: number
  totalVisionTokensSpent: number
}

export interface VisionProviderAnalysis {
  summary: string
  visionTokensSpent?: number
  detectedApp?: string
  codingContext?: string
}

export interface VisionProvider {
  describeFrame(
    frame: CapturedScreenFrame,
    context: { dHashHex: string; hammingDistance: number; windowTitle: string | null }
  ): Promise<VisionProviderAnalysis | string> | VisionProviderAnalysis | string
}

export interface AuthorizedVisionSensorOptions {
  privacyController: PrivacyController
  gatekeeper?: ActionGatekeeper
  filterOptions?: ScreenObservationFilterOptions
  captureFrameFn?: (
    windowTitle?: string
  ) => Promise<CapturedScreenFrame> | CapturedScreenFrame
  visionProvider?: VisionProvider
  nowFn?: () => number
}

export interface AuthorizedVisionSensor {
  observeScreen(
    input?: string | { windowTitle?: string; frameOverride?: CapturedScreenFrame }
  ): Promise<VisionObservationResult>
  getTelemetry(): VisionTelemetryState
  reset(): void
}

function createDefaultDeterministicFrame(windowTitle?: string): CapturedScreenFrame {
  const width = 36
  const height = 32
  const pixels = new Uint8Array(width * height * 4)
  const titleSeed = (windowTitle ?? 'Ashy Studio').split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      const v = (x * 7 + y * 5 + titleSeed) % 256
      pixels[idx] = v
      pixels[idx + 1] = (v + 30) % 256
      pixels[idx + 2] = (v + 60) % 256
      pixels[idx + 3] = 255
    }
  }
  return {
    width,
    height,
    pixels,
    windowTitle: windowTitle ?? 'VS Code — Ashy Companion',
    sourceType: 'window',
  }
}

export function createAuthorizedVisionSensor(
  options: AuthorizedVisionSensorOptions
): AuthorizedVisionSensor {
  const privacyController = options.privacyController
  const gatekeeper = options.gatekeeper
  const nowFn = options.nowFn ?? (() => Date.now())
  const captureFrameFn =
    options.captureFrameFn ?? ((windowTitle?: string) => createDefaultDeterministicFrame(windowTitle))
  const filter = createScreenObservationFilter(options.filterOptions)

  let lastObservation: VisionObservationResult | null = null
  let lastSummary: string | null = null
  let framesCapturedCount = 0
  let framesSkippedByDhashCount = 0
  let blockedPrivacyCount = 0
  let totalVisionTokensSpent = 0

  return {
    async observeScreen(
      input?: string | { windowTitle?: string; frameOverride?: CapturedScreenFrame }
    ): Promise<VisionObservationResult> {
      const nowMs = nowFn()
      const requestedWindowTitle =
        typeof input === 'string'
          ? input
          : typeof input === 'object' && input !== null
            ? input.windowTitle
            : undefined

      const effectiveTitleForGate =
        requestedWindowTitle ??
        (privacyController.eyesMode === 'window'
          ? privacyController.allowedWindowTitles[0]
          : undefined)

      // 1. Privacy Gate: NEVER invoke captureFrameFn if canObserveScreen is false
      if (!privacyController.canObserveScreen(effectiveTitleForGate)) {
        blockedPrivacyCount += 1
        const reason = `Screen observation blocked by PrivacyController (eyesMode=${privacyController.eyesMode})`

        gatekeeper?.recordAuditEntry({
          toolName: 'capture_authorized_screen',
          serverName: 'desktop-vision',
          riskTier: 'observe-only',
          decision: 'blocked_privacy',
          argsPreview: JSON.stringify({
            windowTitle: requestedWindowTitle ?? null,
            eyesMode: privacyController.eyesMode,
          }),
          reason,
        })

        const blockedResult: VisionObservationResult = {
          observed: false,
          skippedByDhash: false,
          blockedByPrivacy: true,
          windowTitle: requestedWindowTitle ?? null,
          summary: null,
          dHashHex: null,
          hammingDistance: null,
          visionTokensSpent: 0,
          timestamp: nowMs,
          reason,
        }
        lastObservation = blockedResult
        return blockedResult
      }

      // 2. Capture frame (only after privacy check succeeded)
      const frame =
        typeof input === 'object' && input !== null && input.frameOverride
          ? input.frameOverride
          : await captureFrameFn(effectiveTitleForGate)

      const resolvedWindowTitle =
        frame.windowTitle ??
        effectiveTitleForGate ??
        (privacyController.eyesMode === 'screen' ? 'Full Screen' : null)

      if (!privacyController.canObserveScreen(resolvedWindowTitle ?? undefined)) {
        blockedPrivacyCount += 1
        const reason = `Captured window "${resolvedWindowTitle ?? 'unknown'}" is not in allowedWindowTitles`

        gatekeeper?.recordAuditEntry({
          toolName: 'capture_authorized_screen',
          serverName: 'desktop-vision',
          riskTier: 'observe-only',
          decision: 'blocked_privacy',
          argsPreview: JSON.stringify({
            windowTitle: resolvedWindowTitle,
            eyesMode: privacyController.eyesMode,
          }),
          reason,
        })

        const blockedResult: VisionObservationResult = {
          observed: false,
          skippedByDhash: false,
          blockedByPrivacy: true,
          windowTitle: resolvedWindowTitle,
          summary: null,
          dHashHex: null,
          hammingDistance: null,
          visionTokensSpent: 0,
          timestamp: nowMs,
          reason,
        }
        lastObservation = blockedResult
        return blockedResult
      }

      // 3. Evaluate perceptual 64-bit dHash
      const evalResult = filter.evaluateFrame(frame.pixels, frame.width, frame.height, nowMs)
      const dHashHex = `0x${evalResult.hash.toString(16).padStart(16, '0')}`

      if (evalResult.skip) {
        framesSkippedByDhashCount += 1
        const reason = `Static frame skipped by dHash (distance=${evalResult.distance}, 0 vision tokens)`

        gatekeeper?.recordAuditEntry({
          toolName: 'capture_authorized_screen',
          serverName: 'desktop-vision',
          riskTier: 'observe-only',
          decision: 'allowed',
          argsPreview: JSON.stringify({
            windowTitle: resolvedWindowTitle,
            dHashHex,
            hammingDistance: evalResult.distance,
            skippedByDhash: true,
          }),
          reason,
        })

        const skippedResult: VisionObservationResult = {
          observed: true,
          skippedByDhash: true,
          blockedByPrivacy: false,
          windowTitle: resolvedWindowTitle,
          summary: lastSummary,
          dHashHex,
          hammingDistance: evalResult.distance,
          visionTokensSpent: 0,
          timestamp: nowMs,
          reason: evalResult.reason,
        }
        lastObservation = skippedResult
        return skippedResult
      }

      // 4. Changed or initial frame -> invoke VisionProvider
      framesCapturedCount += 1
      let summary: string
      let visionTokensSpent = 64

      if (options.visionProvider) {
        const described = await options.visionProvider.describeFrame(frame, {
          dHashHex,
          hammingDistance: evalResult.distance,
          windowTitle: resolvedWindowTitle,
        })
        if (typeof described === 'string') {
          summary = described
        } else {
          summary = described.summary
          visionTokensSpent =
            typeof described.visionTokensSpent === 'number' && described.visionTokensSpent >= 0
              ? described.visionTokensSpent
              : 64
        }
      } else {
        summary = `Janela ativa "${resolvedWindowTitle ?? 'Desktop'}" observada (${frame.width}x${frame.height}, dHash ${dHashHex})`
      }

      lastSummary = summary
      totalVisionTokensSpent += visionTokensSpent

      gatekeeper?.recordAuditEntry({
        toolName: 'capture_authorized_screen',
        serverName: 'desktop-vision',
        riskTier: 'observe-only',
        decision: 'allowed',
        argsPreview: JSON.stringify({
          windowTitle: resolvedWindowTitle,
          dHashHex,
          hammingDistance: evalResult.distance,
          visionTokensSpent,
        }),
        reason: `Screen observed (${evalResult.reason}, dHash=${dHashHex})`,
      })

      const observedResult: VisionObservationResult = {
        observed: true,
        skippedByDhash: false,
        blockedByPrivacy: false,
        windowTitle: resolvedWindowTitle,
        summary,
        dHashHex,
        hammingDistance: evalResult.distance,
        visionTokensSpent,
        timestamp: nowMs,
        reason: evalResult.reason,
      }
      lastObservation = observedResult
      return observedResult
    },

    getTelemetry(): VisionTelemetryState {
      return {
        eyesMode: privacyController.eyesMode,
        lastObservation,
        framesCapturedCount,
        framesSkippedByDhashCount,
        blockedPrivacyCount,
        totalVisionTokensSpent,
      }
    },

    reset(): void {
      filter.reset()
      lastObservation = null
      lastSummary = null
      framesCapturedCount = 0
      framesSkippedByDhashCount = 0
      blockedPrivacyCount = 0
      totalVisionTokensSpent = 0
    },
  }
}
