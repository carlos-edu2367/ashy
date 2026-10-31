import type { AutoUpdaterState } from '@ashy/shared'

export interface ElectronAutoUpdaterUpdateInfoLike {
  version: string
  releaseDate?: string
  releaseNotes?: string | null
}

export interface ElectronAutoUpdaterCheckResultLike {
  updateInfo?: ElectronAutoUpdaterUpdateInfoLike | null
}

export interface ElectronAutoUpdaterDriverLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<ElectronAutoUpdaterCheckResultLike | null | undefined>
  downloadUpdate?(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on?(event: string, listener: (...args: unknown[]) => void): void
}

export interface CreateSafeAutoUpdaterOptions {
  currentVersion?: string
  isPackaged?: boolean
  driver?: ElectronAutoUpdaterDriverLike
  onStateChange?: (state: AutoUpdaterState) => void
}

export interface SafeAutoUpdaterController {
  getState(): AutoUpdaterState
  checkForUpdates(): Promise<AutoUpdaterState>
  downloadUpdate(): Promise<AutoUpdaterState>
  quitAndInstallUpdate(): Promise<{ ok: boolean }>
}

export function createSafeAutoUpdater(
  options: CreateSafeAutoUpdaterOptions = {},
): SafeAutoUpdaterController {
  const currentVersion = options.currentVersion?.trim() || '1.0.0'
  const isPackaged = Boolean(options.isPackaged)
  const driver = options.driver

  // Enforce explicit user consent: never download or install updates behind the user's back
  if (driver) {
    driver.autoDownload = false
    driver.autoInstallOnAppQuit = false
  }

  let state: AutoUpdaterState = {
    status: 'idle',
    currentVersion,
    availableVersion: null,
    progressPercent: null,
    errorMessage: null,
    checkedAt: null,
    autoDownload: false,
  }

  const cloneState = (): AutoUpdaterState => ({
    ...state,
    autoDownload: false,
  })

  const updateAndEmit = (patch: Partial<AutoUpdaterState>): AutoUpdaterState => {
    state = {
      ...state,
      ...patch,
      autoDownload: false,
    }
    const snapshot = cloneState()
    options.onStateChange?.(snapshot)
    return snapshot
  }

  if (driver?.on) {
    driver.on('download-progress', (progressObj: unknown) => {
      const percent =
        progressObj &&
        typeof progressObj === 'object' &&
        typeof (progressObj as { percent?: unknown }).percent === 'number'
          ? Math.max(0, Math.min(100, (progressObj as { percent: number }).percent))
          : null
      if (percent !== null && state.status === 'downloading') {
        updateAndEmit({ progressPercent: percent })
      }
    })
  }

  return {
    getState(): AutoUpdaterState {
      return cloneState()
    },

    async checkForUpdates(): Promise<AutoUpdaterState> {
      if (!isPackaged && !driver) {
        return updateAndEmit({
          status: 'not-available',
          availableVersion: null,
          progressPercent: null,
          errorMessage: null,
          checkedAt: new Date().toISOString(),
        })
      }

      updateAndEmit({
        status: 'checking',
        errorMessage: null,
      })

      if (!driver) {
        return updateAndEmit({
          status: 'not-available',
          availableVersion: null,
          progressPercent: null,
          errorMessage: null,
          checkedAt: new Date().toISOString(),
        })
      }

      try {
        driver.autoDownload = false
        driver.autoInstallOnAppQuit = false
        const result = await driver.checkForUpdates()
        const checkedAt = new Date().toISOString()
        const candidateVersion = result?.updateInfo?.version?.trim() || null

        if (candidateVersion && candidateVersion !== currentVersion) {
          return updateAndEmit({
            status: 'available',
            availableVersion: candidateVersion,
            progressPercent: 0,
            errorMessage: null,
            checkedAt,
          })
        }

        return updateAndEmit({
          status: 'not-available',
          availableVersion: null,
          progressPercent: null,
          errorMessage: null,
          checkedAt,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return updateAndEmit({
          status: 'error',
          errorMessage: message,
          checkedAt: new Date().toISOString(),
        })
      }
    },

    async downloadUpdate(): Promise<AutoUpdaterState> {
      if (state.status !== 'available') {
        throw new Error(
          `Cannot downloadUpdate when updater status is "${state.status}" (expected "available")`,
        )
      }

      updateAndEmit({
        status: 'downloading',
        progressPercent: 0,
        errorMessage: null,
      })

      try {
        await driver?.downloadUpdate?.()
        return updateAndEmit({
          status: 'downloaded',
          progressPercent: 100,
          errorMessage: null,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        updateAndEmit({
          status: 'error',
          errorMessage: message,
        })
        throw err
      }
    },

    async quitAndInstallUpdate(): Promise<{ ok: boolean }> {
      if (state.status !== 'downloaded') {
        throw new Error(
          `Cannot quitAndInstallUpdate when updater status is "${state.status}" (expected "downloaded")`,
        )
      }

      driver?.quitAndInstall(false, true)
      return { ok: true }
    },
  }
}
