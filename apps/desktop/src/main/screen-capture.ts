/**
 * Phase 10.3 — real screen/window capture for the call's vision (`capture_authorized_screen`).
 *
 * Runs in the Electron main process with `desktopCapturer.getSources` and hands the host a PNG
 * (base64) thumbnail of 1280×720. The host (`kernel.setScreenCaptureProvider`) decides whether a
 * capture is allowed (eyesMode/consent); this module only picks the source:
 * - `screen`: the primary display (matched by `display_id`), else the first screen;
 * - `window`: the source whose name matches the active window title (exact, then
 *   case-insensitive contains) — never one of Ashy's own windows (hub/overlay/call-engine).
 * Returns null when nothing matches (the host then refuses).
 */

export type ScreenCaptureMode = 'screen' | 'window'

export interface ScreenCaptureResult {
  pngBase64: string
  source: ScreenCaptureMode
}

/** Same shape as the host's `ScreenCaptureProvider` (`host/live-call/vision.ts`). */
export interface ScreenCaptureProvider {
  capture(mode: ScreenCaptureMode, activeWindowTitle?: string): Promise<ScreenCaptureResult | null>
}

export interface DesktopCapturerSourceLike {
  id: string
  name: string
  display_id?: string
  thumbnail: { toPNG(): Buffer | Uint8Array; isEmpty?(): boolean }
}

export interface ElectronDesktopCapturerLike {
  getSources(options: {
    types: Array<'screen' | 'window'>
    thumbnailSize?: { width: number; height: number }
    fetchWindowIcons?: boolean
  }): Promise<DesktopCapturerSourceLike[]>
}

export interface ElectronScreenLike {
  getPrimaryDisplay(): { id: number | string }
}

/** Minimal view of one of Ashy's own windows (to exclude it from window capture). */
export interface OwnWindowLike {
  getTitle?(): string
  getMediaSourceId?(): string
  isDestroyed?(): boolean
}

export interface CreateScreenCaptureProviderOptions {
  desktopCapturer: ElectronDesktopCapturerLike
  screen?: ElectronScreenLike | null
  /** Ashy's own windows right now (hub, overlay, call-engine). */
  getOwnWindows?: () => ReadonlyArray<OwnWindowLike | null | undefined>
  thumbnailSize?: { width: number; height: number }
}

export const SCREEN_CAPTURE_THUMBNAIL_SIZE = { width: 1280, height: 720 } as const

/** Window titles that are always Ashy's own (even if the window list is momentarily stale). */
const OWN_TITLE_FALLBACKS = new Set(['ashy', 'ashy — companhia no seu ritmo'])

function safeCall<T>(fn: (() => T) | undefined): T | undefined {
  if (!fn) return undefined
  try {
    return fn()
  } catch {
    return undefined
  }
}

function toBase64(png: Buffer | Uint8Array): string {
  return Buffer.isBuffer(png) ? png.toString('base64') : Buffer.from(png).toString('base64')
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase()
}

function collectOwn(options: CreateScreenCaptureProviderOptions): { ids: Set<string>; titles: Set<string> } {
  const ids = new Set<string>()
  const titles = new Set<string>(OWN_TITLE_FALLBACKS)
  const windows = safeCall(options.getOwnWindows) ?? []
  for (const win of windows) {
    if (!win) continue
    if (safeCall(win.isDestroyed?.bind(win)) === true) continue
    const id = safeCall(win.getMediaSourceId?.bind(win))
    if (typeof id === 'string' && id) ids.add(id)
    const title = safeCall(win.getTitle?.bind(win))
    if (typeof title === 'string' && title.trim()) titles.add(normalizeTitle(title))
  }
  return { ids, titles }
}

function hasImage(source: DesktopCapturerSourceLike): boolean {
  if (!source?.thumbnail || typeof source.thumbnail.toPNG !== 'function') return false
  return safeCall(source.thumbnail.isEmpty?.bind(source.thumbnail)) !== true
}

export function pickScreenSource(
  sources: ReadonlyArray<DesktopCapturerSourceLike>,
  primaryDisplayId: string | null,
): DesktopCapturerSourceLike | null {
  const usable = sources.filter(hasImage)
  if (primaryDisplayId !== null) {
    const primary = usable.find((s) => String(s.display_id ?? '') === primaryDisplayId)
    if (primary) return primary
  }
  return usable[0] ?? null
}

export function pickWindowSource(
  sources: ReadonlyArray<DesktopCapturerSourceLike>,
  activeWindowTitle: string | undefined,
  own: { ids: Set<string>; titles: Set<string> },
): DesktopCapturerSourceLike | null {
  const wanted = typeof activeWindowTitle === 'string' ? activeWindowTitle.trim() : ''
  if (!wanted) return null
  // The active window itself is Ashy → never capture it.
  if (own.titles.has(normalizeTitle(wanted))) return null
  const candidates = sources.filter(
    (s) =>
      hasImage(s) &&
      typeof s.name === 'string' &&
      !own.ids.has(s.id) &&
      !own.titles.has(normalizeTitle(s.name)),
  )
  const exact = candidates.find((s) => s.name.trim() === wanted)
  if (exact) return exact
  const lower = normalizeTitle(wanted)
  return (
    candidates.find((s) => {
      const name = normalizeTitle(s.name)
      // Source names may be truncated versions of the active title (or vice-versa).
      return name.length >= 4 && (name.includes(lower) || lower.includes(name))
    }) ?? null
  )
}

export function createScreenCaptureProvider(
  options: CreateScreenCaptureProviderOptions,
): ScreenCaptureProvider {
  const thumbnailSize = options.thumbnailSize ?? { ...SCREEN_CAPTURE_THUMBNAIL_SIZE }
  return {
    async capture(mode, activeWindowTitle) {
      if (mode !== 'screen' && mode !== 'window') return null
      let sources: DesktopCapturerSourceLike[]
      try {
        sources = await options.desktopCapturer.getSources({ types: [mode], thumbnailSize })
      } catch {
        return null
      }
      if (!Array.isArray(sources) || sources.length === 0) return null
      let chosen: DesktopCapturerSourceLike | null
      if (mode === 'screen') {
        const primary = safeCall(() => options.screen?.getPrimaryDisplay())
        chosen = pickScreenSource(sources, primary && primary.id !== undefined ? String(primary.id) : null)
      } else {
        chosen = pickWindowSource(sources, activeWindowTitle, collectOwn(options))
      }
      if (!chosen) return null
      try {
        const png = chosen.thumbnail.toPNG()
        if (!png || png.length === 0) return null
        return { pngBase64: toBase64(png), source: mode }
      } catch {
        return null
      }
    },
  }
}
