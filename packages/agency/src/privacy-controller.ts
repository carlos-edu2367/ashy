export type MicMode = 'muted' | 'continuous' | 'ptt'
export type EyesMode = 'off' | 'window' | 'screen'

export interface QuietHours {
  startHour: number
  endHour: number
}

export interface PrivacyState {
  micMode: MicMode
  eyesMode: EyesMode
  dndMode: boolean
  allowedWindowTitles: string[]
  allowedPaths: string[]
}

export interface PrivacyControllerOptions {
  micMode?: MicMode
  eyesMode?: EyesMode
  dndMode?: boolean
  allowedWindowTitles?: string[]
  allowedPaths?: string[]
  defaultQuietHours?: QuietHours
}

const VALID_MIC_MODES: ReadonlySet<MicMode> = new Set(['muted', 'continuous', 'ptt'])
const VALID_EYES_MODES: ReadonlySet<EyesMode> = new Set(['off', 'window', 'screen'])

/**
 * Canonicalizes a POSIX or Windows path and rejects null-bytes, URL-encoded traversal,
 * NTFS alternate data streams, relative paths, or parent-directory (`..`) traversal segments.
 */
export function canonicalizeSafePath(rawPath: string): string | null {
  if (typeof rawPath !== 'string') return null
  const trimmed = rawPath.trim()
  if (trimmed.length === 0 || trimmed.includes('\0')) return null

  // Reject single or double URL-encoded traversal / null bytes (%2e, %2f, %5c, %00, %25)
  if (/%2e|%2f|%5c|%00|%25/i.test(trimmed)) {
    return null
  }

  // Normalize backslashes to forward slashes
  const normalizedSlashes = trimmed.replace(/\\/g, '/')

  // Reject UNC paths (//server/share)
  if (normalizedSlashes.startsWith('//')) {
    return null
  }

  // Must be an absolute POSIX path (/...) or Windows drive path (C:/...)
  const isPosixAbs = normalizedSlashes.startsWith('/')
  const isWindowsDriveAbs = /^[a-zA-Z]:(\/|$)/.test(normalizedSlashes)
  if (!isPosixAbs && !isWindowsDriveAbs) {
    return null
  }

  const rawSegments = normalizedSlashes.split('/')
  const resolved: string[] = []

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i]!
    if (i === 0 && isWindowsDriveAbs) {
      resolved.push(seg.toLowerCase())
      continue
    }
    if (seg === '' || seg === '.') {
      continue
    }
    // Strictly reject any parent traversal segment (`..`, `...`, etc.) or NTFS ADS (`:`)
    if (seg === '..' || /^\.+$/.test(seg) || seg.includes(':')) {
      return null
    }
    resolved.push(isWindowsDriveAbs ? seg.toLowerCase() : seg)
  }

  if (isWindowsDriveAbs) {
    const [drive, ...rest] = resolved
    return rest.length > 0 ? `${drive}/${rest.join('/')}` : `${drive}/`
  }

  return '/' + resolved.join('/')
}

/**
 * Checks whether `targetPath` is strictly inside one of `allowedPaths`
 * without any path traversal, null-byte injection, or sibling-prefix collision.
 */
export function isPathWithinAllowed(targetPath: string, allowedPaths: readonly string[]): boolean {
  const canonicalTarget = canonicalizeSafePath(targetPath)
  if (!canonicalTarget) return false

  for (const allowed of allowedPaths) {
    const canonicalBase = canonicalizeSafePath(allowed)
    if (!canonicalBase) continue

    if (canonicalTarget === canonicalBase) {
      return true
    }
    const prefix = canonicalBase.endsWith('/') ? canonicalBase : `${canonicalBase}/`
    if (canonicalTarget.startsWith(prefix)) {
      return true
    }
  }

  return false
}

export class PrivacyController {
  private _micMode: MicMode
  private _eyesMode: EyesMode
  private _dndMode: boolean
  private _allowedWindowTitles: string[]
  private _allowedPaths: string[]
  private _defaultQuietHours?: QuietHours

  constructor(options: PrivacyControllerOptions = {}) {
    this._micMode =
      options.micMode && VALID_MIC_MODES.has(options.micMode) ? options.micMode : 'muted'
    this._eyesMode =
      options.eyesMode && VALID_EYES_MODES.has(options.eyesMode) ? options.eyesMode : 'off'
    this._dndMode = Boolean(options.dndMode ?? false)
    this._allowedWindowTitles = (options.allowedWindowTitles ?? [])
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    this._allowedPaths = (options.allowedPaths ?? [])
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    this._defaultQuietHours = options.defaultQuietHours
  }

  get micMode(): MicMode {
    return this._micMode
  }

  get eyesMode(): EyesMode {
    return this._eyesMode
  }

  get dndMode(): boolean {
    return this._dndMode
  }

  get allowedWindowTitles(): readonly string[] {
    return [...this._allowedWindowTitles]
  }

  get allowedPaths(): readonly string[] {
    return [...this._allowedPaths]
  }

  getState(): PrivacyState {
    return {
      micMode: this._micMode,
      eyesMode: this._eyesMode,
      dndMode: this._dndMode,
      allowedWindowTitles: [...this._allowedWindowTitles],
      allowedPaths: [...this._allowedPaths],
    }
  }

  setMicMode(mode: MicMode): void {
    if (!VALID_MIC_MODES.has(mode)) {
      throw new Error(`Invalid micMode: ${String(mode)}`)
    }
    this._micMode = mode
  }

  setEyesMode(mode: EyesMode): void {
    if (!VALID_EYES_MODES.has(mode)) {
      throw new Error(`Invalid eyesMode: ${String(mode)}`)
    }
    this._eyesMode = mode
  }

  setDndMode(enabled: boolean): void {
    this._dndMode = Boolean(enabled)
  }

  setAllowedWindowTitles(titles: string[]): void {
    this._allowedWindowTitles = titles.map((t) => t.trim()).filter((t) => t.length > 0)
  }

  setAllowedPaths(paths: string[]): void {
    this._allowedPaths = paths.map((p) => p.trim()).filter((p) => p.length > 0)
  }

  canObserveScreen(windowTitle?: string): boolean {
    if (this._eyesMode === 'off') {
      return false
    }
    if (this._eyesMode === 'screen') {
      return true
    }
    // eyesMode === 'window'
    if (typeof windowTitle !== 'string' || windowTitle.trim().length === 0) {
      return false
    }
    if (this._allowedWindowTitles.length === 0) {
      return false
    }
    const normalizedTitle = windowTitle.toLowerCase()
    return this._allowedWindowTitles.some((allowed) =>
      normalizedTitle.includes(allowed.toLowerCase())
    )
  }

  canListenMic(isPttPressed = false): boolean {
    if (this._micMode === 'muted') {
      return false
    }
    if (this._micMode === 'continuous') {
      return true
    }
    return Boolean(isPttPressed)
  }

  canInitiateProactively(currentHour: number, quietHours?: QuietHours): boolean {
    if (this._dndMode) {
      return false
    }
    if (typeof currentHour !== 'number' || !Number.isFinite(currentHour)) {
      return false
    }
    if (currentHour < 0 || currentHour >= 24) {
      return false
    }

    const effectiveQuiet = quietHours ?? this._defaultQuietHours
    if (!effectiveQuiet) {
      return true
    }

    const start = ((Math.floor(effectiveQuiet.startHour) % 24) + 24) % 24
    const end = ((Math.floor(effectiveQuiet.endHour) % 24) + 24) % 24

    if (start === end) {
      return true
    }

    // Overnight quiet hours (e.g., 22:00 to 07:00)
    if (start > end) {
      const isQuiet = currentHour >= start || currentHour < end
      return !isQuiet
    }

    // Same-day quiet hours (e.g., 09:00 to 17:00)
    const isQuiet = currentHour >= start && currentHour < end
    return !isQuiet
  }

  isPathAllowed(targetPath: string): boolean {
    return isPathWithinAllowed(targetPath, this._allowedPaths)
  }

  /**
   * Immediately closes eyes, mutes microphone, and activates Do Not Disturb in 1 call.
   */
  activatePrivacyShield(): PrivacyState {
    this._eyesMode = 'off'
    this._micMode = 'muted'
    this._dndMode = true
    return this.getState()
  }
}

export function createPrivacyController(options: PrivacyControllerOptions = {}): PrivacyController {
  return new PrivacyController(options)
}
