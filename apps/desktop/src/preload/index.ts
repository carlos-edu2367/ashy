import type {
  AshyBootstrapSnapshot,
  AshyHostStreamEvent,
  AutoUpdaterState,
  DeleteLocalModelInput,
  ListProviderModelsInput,
  ListProviderModelsResult,
  LocalRuntimeStatus,
  PullLocalModelInput,
  StageOverlayRuntimeState,
} from '@ashy/shared'

export interface IpcRendererLike {
  invoke(channel: string, request?: unknown): Promise<unknown>
  on(
    channel: string,
    listener: (event: unknown, payload: AshyHostStreamEvent) => void,
  ): void
  removeListener(
    channel: string,
    listener: (event: unknown, payload: AshyHostStreamEvent) => void,
  ): void
}

export interface ContextBridgeLike {
  exposeInMainWorld(apiKey: string, api: unknown): void
}

export interface AshyPreloadApi {
  invoke(method: string, payload?: unknown): Promise<unknown>
  listProviderModels?(input: ListProviderModelsInput): Promise<ListProviderModelsResult>
  runDreamReflection?(input?: {
    sessionId?: string
    force?: boolean
    maxEvolutions?: number
  }): Promise<unknown>
  revertTraitEvolution?(input: { recordId: string }): Promise<unknown>
  setOverlayIgnoreMouse?(input: {
    ignore: boolean
    forward?: boolean
  }): Promise<StageOverlayRuntimeState>
  setOverlayVisible?(input: { visible: boolean }): Promise<StageOverlayRuntimeState>
  getOverlayState?(): Promise<StageOverlayRuntimeState>
  minimizeWindow?(): Promise<{ minimized: boolean }>
  maximizeWindow?(): Promise<{ maximized: boolean }>
  closeWindow?(): Promise<{ closed: boolean }>
  activatePrivacyShield?(): Promise<AshyBootstrapSnapshot>
  getUpdateState?(): Promise<AutoUpdaterState>
  checkForUpdates?(): Promise<AutoUpdaterState>
  downloadUpdate?(): Promise<AutoUpdaterState>
  quitAndInstallUpdate?(): Promise<{ ok: boolean }>
  getLocalRuntimeStatus?(): Promise<LocalRuntimeStatus>
  ensureLocalEngineRunning?(): Promise<LocalRuntimeStatus>
  installLocalEngine?(): Promise<LocalRuntimeStatus>
  pullLocalModel?(input: PullLocalModelInput): Promise<LocalRuntimeStatus>
  deleteLocalModel?(input: DeleteLocalModelInput): Promise<LocalRuntimeStatus>
  onEvent(listener: (event: AshyHostStreamEvent) => void): () => void
}

export function createAshyPreloadApi(
  ipcRenderer: IpcRendererLike,
): AshyPreloadApi {
  return {
    invoke(method: string, payload?: unknown): Promise<unknown> {
      return ipcRenderer.invoke('ashy:rpc', { method, payload })
    },
    listProviderModels(input: ListProviderModelsInput): Promise<ListProviderModelsResult> {
      return ipcRenderer.invoke('ashy:rpc', {
        method: 'listProviderModels',
        payload: input,
      }) as Promise<ListProviderModelsResult>
    },
    runDreamReflection(input?: {
      sessionId?: string
      force?: boolean
      maxEvolutions?: number
    }): Promise<unknown> {
      return ipcRenderer.invoke('ashy:rpc', {
        method: 'runDreamReflection',
        payload: input,
      })
    },
    revertTraitEvolution(input: { recordId: string }): Promise<unknown> {
      return ipcRenderer.invoke('ashy:rpc', {
        method: 'revertTraitEvolution',
        payload: input,
      })
    },
    setOverlayIgnoreMouse(input: {
      ignore: boolean
      forward?: boolean
    }): Promise<StageOverlayRuntimeState> {
      return ipcRenderer.invoke(
        'ashy:setOverlayIgnoreMouse',
        input,
      ) as Promise<StageOverlayRuntimeState>
    },
    setOverlayVisible(input: { visible: boolean }): Promise<StageOverlayRuntimeState> {
      return ipcRenderer.invoke(
        'ashy:setOverlayVisible',
        input,
      ) as Promise<StageOverlayRuntimeState>
    },
    getOverlayState(): Promise<StageOverlayRuntimeState> {
      return ipcRenderer.invoke('ashy:getOverlayState') as Promise<StageOverlayRuntimeState>
    },
    minimizeWindow(): Promise<{ minimized: boolean }> {
      return ipcRenderer.invoke('ashy:windowMinimize') as Promise<{ minimized: boolean }>
    },
    maximizeWindow(): Promise<{ maximized: boolean }> {
      return ipcRenderer.invoke('ashy:windowMaximize') as Promise<{ maximized: boolean }>
    },
    closeWindow(): Promise<{ closed: boolean }> {
      return ipcRenderer.invoke('ashy:windowClose') as Promise<{ closed: boolean }>
    },
    activatePrivacyShield(): Promise<AshyBootstrapSnapshot> {
      return ipcRenderer.invoke('ashy:rpc', {
        method: 'activatePrivacyShield',
      }) as Promise<AshyBootstrapSnapshot>
    },
    getUpdateState(): Promise<AutoUpdaterState> {
      return ipcRenderer.invoke('ashy:rpc', {
        method: 'getUpdateState',
      }) as Promise<AutoUpdaterState>
    },
    checkForUpdates(): Promise<AutoUpdaterState> {
      return ipcRenderer.invoke('ashy:rpc', {
        method: 'checkForUpdates',
      }) as Promise<AutoUpdaterState>
    },
    downloadUpdate(): Promise<AutoUpdaterState> {
      return ipcRenderer.invoke('ashy:rpc', {
        method: 'downloadUpdate',
      }) as Promise<AutoUpdaterState>
    },
    quitAndInstallUpdate(): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke('ashy:rpc', {
        method: 'quitAndInstallUpdate',
      }) as Promise<{ ok: boolean }>
    },
    getLocalRuntimeStatus(): Promise<LocalRuntimeStatus> {
      return ipcRenderer.invoke('ashy:rpc', {
        method: 'localRuntime:getStatus',
      }) as Promise<LocalRuntimeStatus>
    },
    ensureLocalEngineRunning(): Promise<LocalRuntimeStatus> {
      return ipcRenderer.invoke('ashy:rpc', {
        method: 'localRuntime:ensureRunning',
      }) as Promise<LocalRuntimeStatus>
    },
    installLocalEngine(): Promise<LocalRuntimeStatus> {
      return ipcRenderer.invoke('ashy:rpc', {
        method: 'localRuntime:installEngine',
      }) as Promise<LocalRuntimeStatus>
    },
    pullLocalModel(input: PullLocalModelInput): Promise<LocalRuntimeStatus> {
      return ipcRenderer.invoke('ashy:rpc', {
        method: 'localRuntime:pullModel',
        payload: input,
      }) as Promise<LocalRuntimeStatus>
    },
    deleteLocalModel(input: DeleteLocalModelInput): Promise<LocalRuntimeStatus> {
      return ipcRenderer.invoke('ashy:rpc', {
        method: 'localRuntime:deleteModel',
        payload: input,
      }) as Promise<LocalRuntimeStatus>
    },
    onEvent(listener: (event: AshyHostStreamEvent) => void): () => void {
      const wrapped = (_event: unknown, payload: AshyHostStreamEvent) => {
        listener(payload)
      }
      ipcRenderer.on('ashy:event', wrapped)
      return () => {
        ipcRenderer.removeListener('ashy:event', wrapped)
      }
    },
  }
}

export function exposeAshyPreload(
  contextBridge: ContextBridgeLike,
  ipcRenderer: IpcRendererLike,
): AshyPreloadApi {
  const api = createAshyPreloadApi(ipcRenderer)
  contextBridge.exposeInMainWorld('ashyHost', api)
  return api
}

// Auto-expose when executed inside an Electron preload context where globals or require('electron') are provided
const maybeGlobalElectron = (
  globalThis as unknown as {
    contextBridge?: ContextBridgeLike
    ipcRenderer?: IpcRendererLike
  }
)

if (maybeGlobalElectron.contextBridge && maybeGlobalElectron.ipcRenderer) {
  exposeAshyPreload(
    maybeGlobalElectron.contextBridge,
    maybeGlobalElectron.ipcRenderer,
  )
} else {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as {
      contextBridge?: ContextBridgeLike
      ipcRenderer?: IpcRendererLike
    }
    if (electron.contextBridge && electron.ipcRenderer) {
      exposeAshyPreload(electron.contextBridge, electron.ipcRenderer)
    }
  } catch {
    // Non-Electron environment
  }
}
