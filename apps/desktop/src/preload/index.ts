import type { AshyHostStreamEvent } from '@ashy/shared'

export interface IpcRendererLike {
  invoke(
    channel: string,
    request: { method: string; payload?: unknown },
  ): Promise<unknown>
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
  onEvent(listener: (event: AshyHostStreamEvent) => void): () => void
}

export function createAshyPreloadApi(
  ipcRenderer: IpcRendererLike,
): AshyPreloadApi {
  return {
    invoke(method: string, payload?: unknown): Promise<unknown> {
      return ipcRenderer.invoke('ashy:rpc', { method, payload })
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
}
