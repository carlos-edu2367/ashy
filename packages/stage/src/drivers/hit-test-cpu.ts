export const SILHOUETTE_MASK_WIDTH = 128
export const SILHOUETTE_MASK_HEIGHT = 72
export const SILHOUETTE_ALPHA_THRESHOLD = 10
export const DEFAULT_BORDER_THRESHOLD_PX = 10

export interface UiIslandRect {
  left: number
  top: number
  width: number
  height: number
}

export interface AvatarHitTest2DInput {
  clientX: number
  clientY: number
  viewportWidth: number
  viewportHeight: number
  silhouetteMask: Uint8Array | Uint8ClampedArray
  maskWidth?: number
  maskHeight?: number
  alphaThreshold?: number
}

/**
 * O(1) CPU hit-test against a downsampled 128x72 silhouette alpha mask.
 * Returns true if the mapped pixel has `alpha > 10` (configurable via `alphaThreshold`).
 */
export function isAvatarHit2D(input: AvatarHitTest2DInput): boolean {
  const { clientX, clientY, viewportWidth, viewportHeight, silhouetteMask } = input

  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return false
  }

  if (clientX < 0 || clientY < 0 || clientX >= viewportWidth || clientY >= viewportHeight) {
    return false
  }

  const maskWidth =
    Number.isFinite(input.maskWidth) && input.maskWidth! >= 1
      ? Math.floor(input.maskWidth!)
      : SILHOUETTE_MASK_WIDTH
  const maskHeight =
    Number.isFinite(input.maskHeight) && input.maskHeight! >= 1
      ? Math.floor(input.maskHeight!)
      : SILHOUETTE_MASK_HEIGHT
  const alphaThreshold = Number.isFinite(input.alphaThreshold)
    ? input.alphaThreshold!
    : SILHOUETTE_ALPHA_THRESHOLD

  if (!silhouetteMask || silhouetteMask.length < maskWidth * maskHeight) {
    return false
  }

  const col = Math.min(
    maskWidth - 1,
    Math.max(0, Math.floor((clientX / viewportWidth) * maskWidth)),
  )
  const row = Math.min(
    maskHeight - 1,
    Math.max(0, Math.floor((clientY / viewportHeight) * maskHeight)),
  )

  const alpha = silhouetteMask[row * maskWidth + col] ?? 0
  return alpha > alphaThreshold
}

export interface ShouldIgnoreMouseEventInput extends AvatarHitTest2DInput {
  isOverUiIsland?: boolean
  uiIslandRects?: readonly UiIslandRect[]
  borderThresholdPx?: number
}

function isPointInsideRect(x: number, y: number, rect: UiIslandRect): boolean {
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return false
  }
  return (
    x >= rect.left &&
    x <= rect.left + rect.width &&
    y >= rect.top &&
    y <= rect.top + rect.height
  )
}

/**
 * Determines whether Electron/Tauri desktop overlay should ignore mouse events
 * (`setIgnoreMouseEvents(true, { forward: true })`) in O(1) CPU time without `gl.readPixels`.
 *
 * Returns `false` (capture mouse event) when:
 * 1. Cursor is within `borderThresholdPx` (default `10px`) of window edges (resize handles),
 * 2. Cursor is over a DOM UI island (`isOverUiIsland === true` or inside `uiIslandRects`),
 * 3. Cursor hits the avatar's 128x72 silhouette mask (`alpha > 10`).
 *
 * Otherwise returns `true` (pass click through to underlying OS windows).
 */
export function shouldIgnoreMouseEvent(input: ShouldIgnoreMouseEventInput): boolean {
  const { clientX, clientY, viewportWidth, viewportHeight } = input

  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return true
  }

  if (clientX < 0 || clientY < 0 || clientX >= viewportWidth || clientY >= viewportHeight) {
    return true
  }

  const borderPx =
    Number.isFinite(input.borderThresholdPx) && input.borderThresholdPx! >= 0
      ? input.borderThresholdPx!
      : DEFAULT_BORDER_THRESHOLD_PX

  // 1. Window resize border guard
  if (
    clientX < borderPx ||
    clientY < borderPx ||
    clientX >= viewportWidth - borderPx ||
    clientY >= viewportHeight - borderPx
  ) {
    return false
  }

  // 2. DOM UI islands guard
  if (input.isOverUiIsland === true) {
    return false
  }

  if (input.uiIslandRects && input.uiIslandRects.length > 0) {
    for (const rect of input.uiIslandRects) {
      if (isPointInsideRect(clientX, clientY, rect)) {
        return false
      }
    }
  }

  // 3. O(1) CPU silhouette mask lookup
  if (isAvatarHit2D(input)) {
    return false
  }

  return true
}

export interface SilhouetteBuildParams {
  centerX?: number
  centerY?: number
  scale?: number
  maskWidth?: number
  maskHeight?: number
}

/**
 * Builds a deterministic 128x72 CPU silhouette mask representing Ashy's head, hair, and bust
 * for O(1) hit-testing when WebGL offscreen rasterization is not active.
 */
export function buildAvatarSilhouetteMask(
  params: SilhouetteBuildParams = {},
): Uint8Array {
  const maskWidth = Math.max(1, Math.floor(params.maskWidth ?? SILHOUETTE_MASK_WIDTH))
  const maskHeight = Math.max(1, Math.floor(params.maskHeight ?? SILHOUETTE_MASK_HEIGHT))
  const cx = Number.isFinite(params.centerX) ? params.centerX! : 0.5
  const cy = Number.isFinite(params.centerY) ? params.centerY! : 0.56
  const scale = Number.isFinite(params.scale) && params.scale! > 0 ? params.scale! : 1

  const mask = new Uint8Array(maskWidth * maskHeight)

  const headCx = cx
  const headCy = cy - 0.14 * scale
  const headRx = 0.16 * scale
  const headRy = 0.24 * scale

  const torsoCx = cx
  const torsoCy = cy + 0.18 * scale
  const torsoRx = 0.22 * scale
  const torsoRy = 0.26 * scale

  for (let row = 0; row < maskHeight; row++) {
    const ny = (row + 0.5) / maskHeight
    for (let col = 0; col < maskWidth; col++) {
      const nx = (col + 0.5) / maskWidth

      const headDistSq =
        ((nx - headCx) / headRx) ** 2 + ((ny - headCy) / headRy) ** 2
      const torsoDistSq =
        ((nx - torsoCx) / torsoRx) ** 2 + ((ny - torsoCy) / torsoRy) ** 2

      const minDistSq = Math.min(headDistSq, torsoDistSq)
      if (minDistSq <= 1) {
        const edgeFade = Math.min(1, (1 - minDistSq) * 4)
        mask[row * maskWidth + col] = Math.round(255 * edgeFade)
      }
    }
  }

  return mask
}
