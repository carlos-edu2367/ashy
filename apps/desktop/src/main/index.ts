import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as v from 'valibot'
import {
  DEFAULT_STAGE_SHORTCUTS,
  SetStageOverlayIgnoreMouseInputSchema,
  SetStageOverlayVisibleInputSchema,
  type AshyHostBridge,
  type AshyHostStreamEvent,
  type CallStateSnapshot,
} from '@ashy/shared'
import {
  createAshyElectronOverlayConfig,
  type AshyElectronOverlayController,
} from '../electron/main'
import { createAshyHostKernel, type AshyHostKernel } from '../host/kernel'
import { createElectronSafeStorageProtector } from '../host/secret-protector'
import {
  createAshyHostHttpMiddleware,
  dispatchHostRpc,
} from '../host/vite-host-plugin'
import {
  createSafeAutoUpdater,
  type ElectronAutoUpdaterDriverLike,
  type SafeAutoUpdaterController,
} from './auto-updater'
import {
  createScreenCaptureProvider,
  type ElectronDesktopCapturerLike,
  type ElectronScreenLike,
  type ScreenCaptureProvider,
} from './screen-capture'
import {
  createAshySystemTray,
  type AshySystemTrayController,
  type ElectronMenuLike,
  type ElectronTrayConstructorLike,
} from './tray-manager'

const STATIC_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.moc3': 'application/octet-stream',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
}

async function startEmbeddedStaticAndHostServer(
  distDir: string,
  kernel: AshyHostKernel,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const distRoot = path.resolve(distDir)
  const hostMiddleware = createAshyHostHttpMiddleware(async () => kernel)

  const server = http.createServer((req, res) => {
    hostMiddleware(req, res, () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.end('Method Not Allowed')
        return
      }

      const rawUrl = req.url ?? '/'
      let pathname = '/'
      try {
        pathname = decodeURIComponent(rawUrl.split('?')[0] || '/')
      } catch {
        res.statusCode = 400
        res.end('Bad Request')
        return
      }

      if (
        pathname.includes('\0') ||
        pathname.startsWith('/main/') ||
        pathname === '/main' ||
        pathname.startsWith('/preload/') ||
        pathname === '/preload'
      ) {
        res.statusCode = 403
        res.end('Forbidden')
        return
      }

      const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
      const candidatePath = path.resolve(distRoot, relPath)
      if (
        candidatePath !== distRoot &&
        !candidatePath.startsWith(distRoot + path.sep)
      ) {
        res.statusCode = 403
        res.end('Forbidden')
        return
      }

      let targetFile = candidatePath
      if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
        if (!path.extname(relPath)) {
          targetFile = path.join(distRoot, 'index.html')
        } else {
          res.statusCode = 404
          res.end('Not Found')
          return
        }
      }

      try {
        const ext = path.extname(targetFile).toLowerCase()
        const contentType = STATIC_MIME_TYPES[ext] ?? 'application/octet-stream'
        const buf = fs.readFileSync(targetFile)
        res.statusCode = 200
        res.setHeader('Content-Type', contentType)
        res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=3600')
        if (req.method === 'HEAD') {
          res.end()
        } else {
          res.end(buf)
        }
      } catch {
        res.statusCode = 500
        res.end('Internal Server Error')
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

export interface ElectronWebContentsNavigationEventLike {
  preventDefault(): void
}

/** Permission details Electron passes to request handlers (`media` carries `mediaTypes`). */
export interface ElectronPermissionRequestDetailsLike {
  mediaTypes?: ReadonlyArray<string>
  requestingUrl?: string
  [key: string]: unknown
}

/** Permission details Electron passes to check handlers (`media` carries `mediaType`). */
export interface ElectronPermissionCheckDetailsLike {
  mediaType?: string
  requestingUrl?: string
  [key: string]: unknown
}

export type ElectronPermissionRequestHandlerLike = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details?: ElectronPermissionRequestDetailsLike,
) => void

export type ElectronPermissionCheckHandlerLike = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
  details?: ElectronPermissionCheckDetailsLike,
) => boolean

/** Subset of Electron's `OnBeforeSendHeadersListenerDetails`. */
export interface ElectronBeforeSendHeadersDetailsLike {
  url: string
  webContentsId?: number
  resourceType?: string
  requestHeaders: Record<string, string>
  [key: string]: unknown
}

export type ElectronBeforeSendHeadersListenerLike = (
  details: ElectronBeforeSendHeadersDetailsLike,
  callback: (response: { cancel?: boolean; requestHeaders?: Record<string, string> }) => void,
) => void

export interface ElectronWebRequestLike {
  onBeforeSendHeaders(
    filterOrListener: { urls: string[] } | ElectronBeforeSendHeadersListenerLike | null,
    listener?: ElectronBeforeSendHeadersListenerLike | null,
  ): void
}

export interface ElectronSessionLike {
  setPermissionRequestHandler?(handler: ElectronPermissionRequestHandlerLike | null): void
  setPermissionCheckHandler?(handler: ElectronPermissionCheckHandlerLike | null): void
  webRequest?: ElectronWebRequestLike
}

export interface ElectronWebContentsLike {
  id?: number
  session?: ElectronSessionLike
  isDestroyed?: () => boolean
  send(channel: string, payload: AshyHostStreamEvent): void
  on?(
    event: 'will-navigate',
    listener: (event: ElectronWebContentsNavigationEventLike, url: string) => void,
  ): void
  once?(event: 'did-finish-load', listener: () => void): void
  once?(
    event: 'did-fail-load',
    listener: (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ) => void,
  ): void
  setWindowOpenHandler?(
    handler: (details: { url: string }) => { action: 'deny' | 'allow' },
  ): void
}

export interface ElectronIpcMainLike {
  handle(
    channel: string,
    listener: (
      event: unknown,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request?: any,
    ) => Promise<unknown> | unknown,
  ): void
  removeHandler(channel: string): void
}

export interface ElectronBrowserWindowInstanceLike {
  webContents: ElectronWebContentsLike
  loadURL(url: string): Promise<void>
  loadFile?(filePath: string): Promise<void>
  isDestroyed?(): boolean
  setIgnoreMouseEvents?(ignore: boolean, options?: { forward?: boolean }): void
  setAlwaysOnTop?(
    flag: boolean,
    level?:
      | 'normal'
      | 'floating'
      | 'torn-off-menu'
      | 'modal-panel'
      | 'main-menu'
      | 'status'
      | 'pop-up-menu'
      | 'screen-saver',
  ): void
  show?(): void
  hide?(): void
  focus?(): void
  isVisible?(): boolean
  minimize?(): void
  maximize?(): void
  unmaximize?(): void
  isMaximized?(): boolean
  close?(): void
  destroy?(): void
  on?(event: 'closed', listener: () => void): void
  getBounds?(): { x: number; y: number; width: number; height: number }
  setBounds?(bounds: { x: number; y: number; width: number; height: number }): void
  getPosition?(): [number, number]
  setPosition?(x: number, y: number): void
  /** Phase 10.3: used to exclude Ashy's own windows from window capture. */
  getTitle?(): string
  getMediaSourceId?(): string
}

function isWindowUsable(
  win: ElectronBrowserWindowInstanceLike | null | undefined,
): win is ElectronBrowserWindowInstanceLike {
  if (!win) return false
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false
  return true
}

export function isTrustedRendererUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim()
  if (!trimmed) return false
  if (trimmed === 'about:blank') return true

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'file:') {
      return true
    }
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return true
    }
    return false
  } catch {
    return false
  }
}

export function validateIpcSender(event: unknown): void {
  if (!event || typeof event !== 'object') {
    return
  }
  const senderFrame = (event as { senderFrame?: unknown }).senderFrame
  if (!senderFrame || typeof senderFrame !== 'object') {
    return
  }
  const rawUrl = (senderFrame as { url?: unknown }).url
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return
  }
  if (!isTrustedRendererUrl(rawUrl)) {
    throw new Error('Unauthorized IPC sender origin')
  }
}

function attachWindowSecurityGuards(win: ElectronBrowserWindowInstanceLike): void {
  win.webContents.on?.('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) {
      event.preventDefault()
    }
  })
  win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }))
}

export interface ElectronBrowserWindowConstructorLike {
  new (options: Record<string, unknown>): ElectronBrowserWindowInstanceLike
}

// ───────────────────────────── Phase 10.1: hidden call-engine window ─────────────────────────────

/** Global shortcut that toggles the Live Call (spec §9.1). */
export const CALL_TOGGLE_SHORTCUT = 'CommandOrControl+Alt+L'
/** The hidden call-engine window is destroyed this long after the call goes idle/ended. */
export const CALL_WINDOW_IDLE_DESTROY_MS = 60_000

export function buildViewUrl(baseRendererUrl: string, view: string): string {
  return baseRendererUrl.includes('?')
    ? `${baseRendererUrl}&view=${view}`
    : `${baseRendererUrl}?view=${view}`
}

/** True when a `media` permission request asks for audio only (no camera / screen). */
function isAudioOnlyMediaRequest(details?: ElectronPermissionRequestDetailsLike): boolean {
  const types = details?.mediaTypes
  if (!Array.isArray(types) || types.length === 0) return false
  return types.every((t) => t === 'audio')
}

interface SessionPermissionRouter {
  scopes: Set<(webContents: unknown) => 'grant-audio' | 'pass'>
}

const sessionPermissionRouters = new WeakMap<object, SessionPermissionRouter>()

/**
 * Installs (once per Electron session) permission handlers that grant `media` (audio only) to the
 * webContents claimed by a registered scope, and keep Electron's default behaviour (`fallback*`,
 * which defaults to "allow", i.e. what Electron does when no handler is installed) for every other
 * webContents so the hub/overlay are unaffected. A claimed webContents gets nothing but audio.
 * Returns an unregister function for the scope.
 */
export function installScopedMediaPermission(
  session: ElectronSessionLike | null | undefined,
  claim: (webContents: unknown) => boolean,
  options: {
    fallbackRequest?: ElectronPermissionRequestHandlerLike
    fallbackCheck?: ElectronPermissionCheckHandlerLike
  } = {},
): () => void {
  if (!session || typeof session !== 'object') return () => undefined
  let router = sessionPermissionRouters.get(session)
  if (!router) {
    const created: SessionPermissionRouter = { scopes: new Set() }
    router = created
    sessionPermissionRouters.set(session, created)
    const fallbackRequest: ElectronPermissionRequestHandlerLike =
      options.fallbackRequest ?? ((_wc, _permission, callback) => callback(true))
    const fallbackCheck: ElectronPermissionCheckHandlerLike =
      options.fallbackCheck ?? (() => true)
    const isClaimed = (wc: unknown): boolean => {
      for (const scope of created.scopes) {
        if (scope(wc) === 'grant-audio') return true
      }
      return false
    }
    session.setPermissionRequestHandler?.((wc, permission, callback, details) => {
      if (isClaimed(wc)) {
        callback(permission === 'media' && isAudioOnlyMediaRequest(details))
        return
      }
      fallbackRequest(wc, permission, callback, details)
    })
    session.setPermissionCheckHandler?.((wc, permission, origin, details) => {
      if (isClaimed(wc)) {
        return permission === 'media' && details?.mediaType !== 'video'
      }
      return fallbackCheck(wc, permission, origin, details)
    })
  }
  const scope = (wc: unknown): 'grant-audio' | 'pass' => (claim(wc) ? 'grant-audio' : 'pass')
  router.scopes.add(scope)
  const ownRouter = router
  return () => {
    ownRouter.scopes.delete(scope)
  }
}

// ───────────────────────────── Phase 10.2: llama-server auth header injection ─────────────────────────────

/**
 * One header-injection scope: the URL patterns it cares about plus a per-request decision.
 * `headersFor` returns the headers to ADD, or null to leave the request untouched.
 */
export interface RequestHeaderScope {
  urls(): string[]
  headersFor(details: ElectronBeforeSendHeadersDetailsLike): Record<string, string> | null
}

export interface RequestHeaderScopeHandle {
  /** Re-reads `urls()` and re-registers the session filter (call when the target port changes). */
  refresh(): void
  dispose(): void
}

interface SessionHeaderRouter {
  scopes: Set<RequestHeaderScope>
  listener: ElectronBeforeSendHeadersListenerLike
  update(): void
}

const sessionHeaderRouters = new WeakMap<object, SessionHeaderRouter>()

/**
 * Electron keeps only ONE `webRequest.onBeforeSendHeaders` listener per session (the last one
 * wins), so every header rewrite in Ashy must go through this per-session router instead of
 * calling `onBeforeSendHeaders` directly. The router registers a single listener whose URL filter
 * is the union of the scopes' patterns (or unsubscribes when there are none) and lets the first
 * scope that answers add its headers.
 *
 * Verified for Electron 35.1.5 (electron-builder.yml): WebSocket handshakes go through
 * `webRequest` too — `ElectronBrowserClient::WillInterceptWebSocket` routes them through
 * `shell/browser/net/proxying_websocket.cc`, whose `OnBeforeRequestComplete` calls
 * `web_request_api_->OnBeforeSendHeaders(&info_, request_, ..., &request_headers_)` and sends the
 * (modified) `request_headers_` with the upgrade; filters are parsed with
 * `URLPattern::SCHEME_ALL`, so `ws://` patterns match, and `details.webContentsId` is filled from
 * the request's RenderFrameHost (`electron_api_web_request.cc`).
 */
export function installScopedRequestHeaders(
  session: ElectronSessionLike | null | undefined,
  scope: RequestHeaderScope,
): RequestHeaderScopeHandle {
  const webRequest = session?.webRequest
  if (!session || !webRequest || typeof webRequest.onBeforeSendHeaders !== 'function') {
    return { refresh: () => undefined, dispose: () => undefined }
  }
  let router = sessionHeaderRouters.get(session)
  if (!router) {
    const scopes = new Set<RequestHeaderScope>()
    const listener: ElectronBeforeSendHeadersListenerLike = (details, callback) => {
      for (const s of scopes) {
        let add: Record<string, string> | null = null
        try {
          add = s.headersFor(details)
        } catch {
          add = null
        }
        if (add && Object.keys(add).length > 0) {
          callback({ requestHeaders: { ...details.requestHeaders, ...add } })
          return
        }
      }
      callback({})
    }
    let lastKey: string | null = null
    const created: SessionHeaderRouter = {
      scopes,
      listener,
      update() {
        const urls = [...new Set([...scopes].flatMap((s) => s.urls()))].sort()
        const key = urls.join('\n')
        if (key === lastKey) return
        lastKey = key
        if (urls.length === 0) webRequest.onBeforeSendHeaders(null)
        else webRequest.onBeforeSendHeaders({ urls }, listener)
      },
    }
    router = created
    sessionHeaderRouters.set(session, created)
  }
  const ownRouter = router
  ownRouter.scopes.add(scope)
  ownRouter.update()
  let disposed = false
  return {
    refresh() {
      if (!disposed) ownRouter.update()
    },
    dispose() {
      if (disposed) return
      disposed = true
      ownRouter.scopes.delete(scope)
      ownRouter.update()
    },
  }
}

/** What the main process needs from the host to authenticate the call window to llama-server. */
export interface EngineAuthLike {
  origin: string
  port: number
  headers: Record<string, string>
}

/** URL patterns for the managed llama-server (plain HTTP + the `/v1/realtime` WebSocket). */
export function engineAuthUrlPatterns(auth: EngineAuthLike | null): string[] {
  if (!auth || !Number.isInteger(auth.port) || auth.port <= 0 || auth.port > 65535) return []
  return [`http://127.0.0.1:${auth.port}/*`, `ws://127.0.0.1:${auth.port}/*`]
}

/**
 * Phase 10.4: URL patterns for the loopback cloud relay (WebSocket only — the relay serves nothing
 * else). The relay checks the injected token header; the key itself never leaves the host.
 */
export function cloudRelayUrlPatterns(auth: EngineAuthLike | null): string[] {
  if (!auth || !Number.isInteger(auth.port) || auth.port <= 0 || auth.port > 65535) return []
  return [`ws://127.0.0.1:${auth.port}/*`]
}

/** True when `rawUrl` is a ws:// request to exactly the relay's loopback port. */
export function isCloudRelayRequestUrl(rawUrl: string, auth: EngineAuthLike | null): boolean {
  if (!auth) return false
  try {
    const u = new URL(rawUrl)
    return u.protocol === 'ws:' && u.hostname === '127.0.0.1' && Number(u.port) === auth.port
  } catch {
    return false
  }
}

/** True when `rawUrl` targets exactly the engine's loopback port over http/ws. */
export function isEngineRequestUrl(rawUrl: string, auth: EngineAuthLike | null): boolean {
  if (!auth) return false
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'ws:') return false
    if (u.hostname !== '127.0.0.1') return false
    return Number(u.port) === auth.port
  } catch {
    return false
  }
}

export interface CallWindowTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface CreateCallWindowControllerOptions {
  BrowserWindow: ElectronBrowserWindowConstructorLike
  preloadPath: string
  /** Renderer URL with `view=call-engine`. */
  url: string
  /** Called when the window is created (e.g. to start forwarding host events to it). */
  onWindowCreated?: (win: ElectronBrowserWindowInstanceLike) => void
  /** Called once when the window is gone (destroyed by us or closed by the OS). */
  onWindowGone?: (win: ElectronBrowserWindowInstanceLike) => void
  /** Fallback session when the window's webContents exposes none. */
  session?: ElectronSessionLike | null
  idleDestroyMs?: number
  timers?: CallWindowTimers
  /**
   * Phase 10.2: current managed llama-server auth (`kernel.liveCall.getEngineAuth()`). The headers
   * are injected (main process only, never exposed to the renderer) into the call window's
   * requests to that engine port.
   */
  getEngineAuth?: () => EngineAuthLike | null
  /**
   * Phase 10.4: loopback cloud relay auth (`kernel.liveCall.getCloudRelayAuth()`): its token header is
   * injected (main only) into the call window's WebSocket requests to the relay port.
   */
  getCloudRelayAuth?: () => EngineAuthLike | null
}

export interface ElectronCallWindowController {
  ensure(): Promise<void>
  destroy(): void
  getWindow(): ElectronBrowserWindowInstanceLike | null
  /** Feed every `call:state`: arms the idle auto-destroy on idle/ended, cancels it otherwise. */
  handleCallState(status: string): void
  /** Re-reads the engine auth (port/key) and refreshes the header-injection filter. */
  refreshEngineAuth(): void
}

function sameWebContents(candidate: unknown, target: ElectronWebContentsLike): boolean {
  if (!candidate || typeof candidate !== 'object') return false
  if (candidate === target) return true
  const id = (candidate as { id?: unknown }).id
  return typeof id === 'number' && typeof target.id === 'number' && id === target.id
}

export function createCallWindowController(
  options: CreateCallWindowControllerOptions,
): ElectronCallWindowController {
  const idleDestroyMs = options.idleDestroyMs ?? CALL_WINDOW_IDLE_DESTROY_MS
  const timers: CallWindowTimers = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  }
  let win: ElectronBrowserWindowInstanceLike | null = null
  let loaded = false
  let pending: Promise<void> | null = null
  let idleTimer: unknown = null
  let releasePermission: (() => void) | null = null
  let headerScope: RequestHeaderScopeHandle | null = null
  let relayHeaderScope: RequestHeaderScopeHandle | null = null
  const readRelayAuth = (): EngineAuthLike | null => {
    try {
      return options.getCloudRelayAuth?.() ?? null
    } catch {
      return null
    }
  }
  const readEngineAuth = (): EngineAuthLike | null => {
    try {
      return options.getEngineAuth?.() ?? null
    } catch {
      return null
    }
  }

  const cancelIdleTimer = (): void => {
    if (idleTimer !== null) {
      timers.clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  const forget = (target: ElectronBrowserWindowInstanceLike): void => {
    if (win !== target) return
    win = null
    loaded = false
    pending = null
    releasePermission?.()
    releasePermission = null
    headerScope?.dispose()
    headerScope = null
    relayHeaderScope?.dispose()
    relayHeaderScope = null
    options.onWindowGone?.(target)
  }

  const create = (): ElectronBrowserWindowInstanceLike => {
    const created = new options.BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      backgroundColor: '#111017',
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    })
    attachWindowSecurityGuards(created)
    const wc = created.webContents
    releasePermission = installScopedMediaPermission(
      wc.session ?? options.session ?? null,
      (candidate) => win === created && sameWebContents(candidate, wc),
    )
    if (options.getEngineAuth) {
      headerScope = installScopedRequestHeaders(wc.session ?? options.session ?? null, {
        urls: () => (win === created ? engineAuthUrlPatterns(readEngineAuth()) : []),
        headersFor: (details) => {
          // Only the call-engine window, only the engine's current loopback port.
          if (win !== created || typeof wc.id !== 'number' || details.webContentsId !== wc.id) {
            return null
          }
          const auth = readEngineAuth()
          return auth && isEngineRequestUrl(details.url, auth) ? auth.headers : null
        },
      })
    }
    if (options.getCloudRelayAuth) {
      relayHeaderScope = installScopedRequestHeaders(wc.session ?? options.session ?? null, {
        urls: () => (win === created ? cloudRelayUrlPatterns(readRelayAuth()) : []),
        headersFor: (details) => {
          // Only the call-engine window, only ws:// to the relay's loopback port.
          if (win !== created || typeof wc.id !== 'number' || details.webContentsId !== wc.id) {
            return null
          }
          const auth = readRelayAuth()
          return auth && isCloudRelayRequestUrl(details.url, auth) ? auth.headers : null
        },
      })
    }
    created.on?.('closed', () => forget(created))
    return created
  }

  const controller: ElectronCallWindowController = {
    ensure() {
      cancelIdleTimer()
      if (win && isWindowUsable(win) && loaded) return Promise.resolve()
      if (pending) return pending
      if (win && !isWindowUsable(win)) forget(win)
      const target = create()
      win = target
      options.onWindowCreated?.(target)
      const url = options.url
      const attempt = new Promise<void>((resolve, reject) => {
        let settled = false
        const ok = () => {
          if (settled) return
          settled = true
          if (win === target) loaded = true
          resolve()
        }
        const fail = (err: unknown) => {
          if (settled) return
          settled = true
          reject(err instanceof Error ? err : new Error(String(err)))
        }
        target.webContents.once?.('did-finish-load', ok)
        target.webContents.once?.(
          'did-fail-load',
          (_event: unknown, errorCode: number, errorDescription: string, _url: string, isMainFrame: boolean) => {
            // -3 = ERR_ABORTED (superseded navigation); sub-frame failures don't matter.
            if (errorCode === -3 || isMainFrame === false) return
            fail(new Error(`call-engine window failed to load (${errorCode}): ${errorDescription}`))
          },
        )
        target.loadURL(url).then(ok, fail)
      })
      const tracked = attempt.then(
        () => {
          if (pending === tracked) pending = null
        },
        (err: unknown) => {
          if (pending === tracked) pending = null
          if (win === target) controller.destroy()
          throw err
        },
      )
      pending = tracked
      return tracked
    },

    destroy() {
      cancelIdleTimer()
      const target = win
      if (!target) return
      try {
        if (isWindowUsable(target)) {
          if (typeof target.destroy === 'function') target.destroy()
          else target.close?.()
        }
      } catch {
        // window already gone
      }
      forget(target)
    },

    getWindow() {
      return win && isWindowUsable(win) ? win : null
    },

    handleCallState(status) {
      if (status === 'idle' || status === 'ended') {
        if (!win || idleTimer !== null) return
        idleTimer = timers.setTimeout(() => {
          idleTimer = null
          controller.destroy()
        }, idleDestroyMs)
        return
      }
      cancelIdleTimer()
    },

    refreshEngineAuth() {
      headerScope?.refresh()
      relayHeaderScope?.refresh()
    },
  }
  return controller
}

export interface ElectronAppLike {
  getPath(name: 'userData'): string
  on(event: 'before-quit', listener: () => void | Promise<void>): void
  quit?(): void
  isPackaged?: boolean
  getVersion?(): string
}

export interface ElectronSafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface ElectronGlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean
  unregisterAll(): void
}

export interface BootAshyElectronMainDeps {
  app: ElectronAppLike
  BrowserWindow: ElectronBrowserWindowConstructorLike
  ipcMain: ElectronIpcMainLike
  safeStorage?: ElectronSafeStorageLike
  globalShortcut?: ElectronGlobalShortcutLike
  /** Electron `session.defaultSession` (fallback for the call window's permission handlers). */
  session?: ElectronSessionLike
  /** Phase 10.3: Electron `desktopCapturer` + `screen` for the call's vision (screen capture provider). */
  desktopCapturer?: ElectronDesktopCapturerLike
  screen?: ElectronScreenLike
  /** Overrides the hidden call-engine window idle auto-destroy (tests). */
  callWindowIdleDestroyMs?: number
  callWindowTimers?: CallWindowTimers
  Tray?: ElectronTrayConstructorLike
  Menu?: ElectronMenuLike
  trayIconPath?: string
  autoUpdaterDriver?: ElectronAutoUpdaterDriverLike
  isPackaged?: boolean
  appVersion?: string
  kernel?: AshyHostKernel
  preloadPath?: string
  rendererUrl?: string
  staticDistDir?: string
  processRef?: Pick<NodeJS.Process, 'once' | 'removeListener'>
}

export interface BootedAshyElectronRuntime {
  kernel: AshyHostKernel
  hubWindow: ElectronBrowserWindowInstanceLike
  overlayWindow: ElectronBrowserWindowInstanceLike
  overlayController: AshyElectronOverlayController
  callWindowController: ElectronCallWindowController
  autoUpdater: SafeAutoUpdaterController
  trayController: AshySystemTrayController | null
  shutdown(): Promise<void>
}

export interface RegisterAshyElectronIpcOverlayOptions {
  overlayController?: AshyElectronOverlayController
  overlayWindow?: ElectronBrowserWindowInstanceLike | null
  getOverlayWindow?: () => ElectronBrowserWindowInstanceLike | null | undefined
  hubWindow?: ElectronBrowserWindowInstanceLike | null
  getHubWindow?: () => ElectronBrowserWindowInstanceLike | null | undefined
  overlayPositionFilePath?: string
}

function readSavedOverlayPosition(filePath?: string): { x: number; y: number } | null {
  if (!filePath) return null
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      x?: unknown
      y?: unknown
    }
    const x = Number(raw?.x)
    const y = Number(raw?.y)
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return {
        x: Math.max(-10000, Math.min(10000, Math.round(x))),
        y: Math.max(-10000, Math.min(10000, Math.round(y))),
      }
    }
  } catch {
    // Ignore corrupt or missing overlay position file
  }
  return null
}

function writeSavedOverlayPosition(
  filePath: string | undefined,
  pos: { x: number; y: number },
): void {
  if (!filePath) return
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({ x: pos.x, y: pos.y }), 'utf8')
  } catch {
    // Ignore write errors in sandboxed/test environments
  }
}

export function registerAshyElectronIpc(
  ipcMain: ElectronIpcMainLike,
  kernel: AshyHostBridge,
  getWebContents: () => ReadonlyArray<ElectronWebContentsLike>,
  overlayOptions?: RegisterAshyElectronIpcOverlayOptions,
): () => void {
  const overlayController =
    overlayOptions?.overlayController ?? createAshyElectronOverlayConfig()
  const resolveOverlayWindow = (): ElectronBrowserWindowInstanceLike | null => {
    const candidate =
      overlayOptions?.getOverlayWindow?.() ?? overlayOptions?.overlayWindow ?? null
    return isWindowUsable(candidate) ? candidate : null
  }
  const resolveHubWindow = (): ElectronBrowserWindowInstanceLike | null => {
    const candidate = overlayOptions?.getHubWindow?.() ?? overlayOptions?.hubWindow ?? null
    return isWindowUsable(candidate) ? candidate : null
  }
  const initialSavedPos = readSavedOverlayPosition(overlayOptions?.overlayPositionFilePath)
  let fallbackOverlayBounds = {
    x: initialSavedPos?.x ?? 120,
    y: initialSavedPos?.y ?? 120,
    width: 380,
    height: 460,
  }

  ipcMain.handle('ashy:rpc', async (event, request) => {
    validateIpcSender(event)
    if (
      !request ||
      typeof request !== 'object' ||
      typeof request.method !== 'string'
    ) {
      throw new Error(
        'Invalid Ashy IPC RPC request: expected { method: string, payload?: unknown }',
      )
    }
    return dispatchHostRpc(kernel, request.method, request.payload)
  })

  ipcMain.handle('ashy:runDreamReflection', async (event, payload) => {
    validateIpcSender(event)
    return dispatchHostRpc(kernel, 'runDreamReflection', payload)
  })

  ipcMain.handle('ashy:revertTraitEvolution', async (event, payload) => {
    validateIpcSender(event)
    return dispatchHostRpc(kernel, 'revertTraitEvolution', payload)
  })

  ipcMain.handle('ashy:setOverlayIgnoreMouse', async (event, payload) => {
    validateIpcSender(event)
    const parsed = v.parse(SetStageOverlayIgnoreMouseInputSchema, payload)
    const forward = parsed.forward ?? true
    const { changed, state } = overlayController.setIgnoreMouseEvents(
      parsed.ignore,
      forward,
    )
    if (changed) {
      resolveOverlayWindow()?.setIgnoreMouseEvents?.(parsed.ignore, { forward })
    }
    return state
  })

  ipcMain.handle('ashy:setOverlayVisible', async (event, payload) => {
    validateIpcSender(event)
    const parsed = v.parse(SetStageOverlayVisibleInputSchema, payload)
    const state = overlayController.setOverlayVisible(parsed.visible)
    const overlayWin = resolveOverlayWindow()
    if (parsed.visible) {
      overlayWin?.show?.()
    } else {
      overlayWin?.hide?.()
    }
    return state
  })

  ipcMain.handle('ashy:getOverlayState', async (event) => {
    validateIpcSender(event)
    return overlayController.getState()
  })

  ipcMain.handle('ashy:getOverlayBounds', async (event) => {
    validateIpcSender(event)
    const overlayWin = resolveOverlayWindow()
    if (overlayWin?.getBounds) {
      const b = overlayWin.getBounds()
      if (
        b &&
        typeof b.x === 'number' &&
        typeof b.y === 'number' &&
        typeof b.width === 'number' &&
        typeof b.height === 'number'
      ) {
        fallbackOverlayBounds = { ...b }
        return b
      }
    }
    if (overlayWin?.getPosition) {
      const pos = overlayWin.getPosition()
      if (Array.isArray(pos) && typeof pos[0] === 'number' && typeof pos[1] === 'number') {
        fallbackOverlayBounds = {
          ...fallbackOverlayBounds,
          x: pos[0],
          y: pos[1],
        }
      }
    }
    return { ...fallbackOverlayBounds }
  })

  ipcMain.handle('ashy:setOverlayPosition', async (event, payload) => {
    validateIpcSender(event)
    if (!payload || typeof payload !== 'object') {
      return { ...fallbackOverlayBounds }
    }
    const rawX = Number((payload as { x?: unknown }).x)
    const rawY = Number((payload as { y?: unknown }).y)
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
      return { ...fallbackOverlayBounds }
    }
    const clampedX = Math.max(-10000, Math.min(10000, Math.round(rawX)))
    const clampedY = Math.max(-10000, Math.min(10000, Math.round(rawY)))
    const overlayWin = resolveOverlayWindow()
    const cur = overlayWin?.getBounds?.() ?? fallbackOverlayBounds
    const nextBounds = {
      x: clampedX,
      y: clampedY,
      width: cur.width || 380,
      height: cur.height || 460,
    }
    fallbackOverlayBounds = nextBounds
    if (overlayWin?.setBounds) {
      overlayWin.setBounds(nextBounds)
    } else {
      overlayWin?.setPosition?.(clampedX, clampedY)
    }
    writeSavedOverlayPosition(overlayOptions?.overlayPositionFilePath, {
      x: clampedX,
      y: clampedY,
    })
    return nextBounds
  })

  ipcMain.handle('ashy:focusHubWindow', async (event) => {
    validateIpcSender(event)
    const hub = resolveHubWindow()
    hub?.show?.()
    hub?.focus?.()
    return { focused: true }
  })

  ipcMain.handle('ashy:windowMinimize', async (event) => {
    validateIpcSender(event)
    resolveHubWindow()?.minimize?.()
    return { minimized: true }
  })

  ipcMain.handle('ashy:windowMaximize', async (event) => {
    validateIpcSender(event)
    const win = resolveHubWindow()
    if (win?.isMaximized?.()) {
      win.unmaximize?.()
      return { maximized: false }
    }
    win?.maximize?.()
    return { maximized: true }
  })

  ipcMain.handle('ashy:windowClose', async (event) => {
    validateIpcSender(event)
    resolveHubWindow()?.close?.()
    return { closed: true }
  })

  ipcMain.handle('localRuntime:getStatus', async (event) => {
    validateIpcSender(event)
    return dispatchHostRpc(kernel, 'localRuntime:getStatus', undefined)
  })

  ipcMain.handle('localRuntime:ensureRunning', async (event) => {
    validateIpcSender(event)
    return dispatchHostRpc(kernel, 'localRuntime:ensureRunning', undefined)
  })

  ipcMain.handle('localRuntime:installEngine', async (event) => {
    validateIpcSender(event)
    return dispatchHostRpc(kernel, 'localRuntime:installEngine', undefined)
  })

  ipcMain.handle('localRuntime:pullModel', async (event, payload) => {
    validateIpcSender(event)
    return dispatchHostRpc(kernel, 'localRuntime:pullModel', payload)
  })

  ipcMain.handle('localRuntime:deleteModel', async (event, payload) => {
    validateIpcSender(event)
    return dispatchHostRpc(kernel, 'localRuntime:deleteModel', payload)
  })

  const unsubscribe = kernel.onHostEvent((event) => {
    const targets = getWebContents()
    for (const target of targets) {
      if (target.isDestroyed?.()) {
        continue
      }
      try {
        target.send('ashy:event', event)
      } catch {
        // Ignore send errors on closing/destroyed webContents
      }
    }
  })

  let cleanedUp = false
  return () => {
    if (cleanedUp) return
    cleanedUp = true
    unsubscribe()
    ipcMain.removeHandler('ashy:rpc')
    ipcMain.removeHandler('ashy:runDreamReflection')
    ipcMain.removeHandler('ashy:revertTraitEvolution')
    ipcMain.removeHandler('ashy:setOverlayIgnoreMouse')
    ipcMain.removeHandler('ashy:setOverlayVisible')
    ipcMain.removeHandler('ashy:getOverlayState')
    ipcMain.removeHandler('ashy:getOverlayBounds')
    ipcMain.removeHandler('ashy:setOverlayPosition')
    ipcMain.removeHandler('ashy:focusHubWindow')
    ipcMain.removeHandler('ashy:windowMinimize')
    ipcMain.removeHandler('ashy:windowMaximize')
    ipcMain.removeHandler('ashy:windowClose')
    ipcMain.removeHandler('localRuntime:getStatus')
    ipcMain.removeHandler('localRuntime:ensureRunning')
    ipcMain.removeHandler('localRuntime:installEngine')
    ipcMain.removeHandler('localRuntime:pullModel')
    ipcMain.removeHandler('localRuntime:deleteModel')
  }
}

export async function bootAshyElectronMain(
  deps: BootAshyElectronMainDeps,
): Promise<BootedAshyElectronRuntime> {
  const userDataDir = deps.app.getPath('userData')
  const secretProtector = deps.safeStorage
    ? createElectronSafeStorageProtector(deps.safeStorage, userDataDir)
    : undefined

  const kernel =
    deps.kernel ??
    (await createAshyHostKernel({
      userDataDir,
      secretProtector,
    }))

  await kernel.start()

  const activeWindows: ElectronBrowserWindowInstanceLike[] = []
  const overlayController = createAshyElectronOverlayConfig()
  let hubWindowRef: ElectronBrowserWindowInstanceLike | null = null
  let overlayWindowRef: ElectronBrowserWindowInstanceLike | null = null

  const broadcastHostStreamEvent = (evt: AshyHostStreamEvent): void => {
    if (typeof kernel.emitHostEvent === 'function') {
      kernel.emitHostEvent(evt)
    } else {
      for (const win of activeWindows) {
        if (isWindowUsable(win) && !win.webContents.isDestroyed?.()) {
          win.webContents.send('ashy:event', evt)
        }
      }
    }
  }

  const broadcastShortcutEvent = (
    action:
      | 'toggleMic'
      | 'toggleEyes'
      | 'toggleDnd'
      | 'toggleHideStage'
      | 'togglePtt'
      | 'activatePrivacyShield',
  ): void => {
    broadcastHostStreamEvent({
      type: 'shortcut:triggered',
      action,
    })
  }

  const autoUpdater = createSafeAutoUpdater({
    currentVersion: deps.appVersion ?? deps.app.getVersion?.() ?? '1.0.0',
    isPackaged: deps.isPackaged ?? deps.app.isPackaged ?? false,
    driver: deps.autoUpdaterDriver,
    onStateChange: (state) => {
      broadcastHostStreamEvent({
        type: 'updater:status',
        state,
      })
    },
  })

  // Wire SafeAutoUpdater into kernel so RPCs (getUpdateState, checkForUpdates, downloadUpdate, quitAndInstallUpdate) use it
  kernel.getUpdateState = async () => autoUpdater.getState()
  kernel.checkForUpdates = async () => autoUpdater.checkForUpdates()
  kernel.downloadUpdate = async () => autoUpdater.downloadUpdate()
  kernel.quitAndInstallUpdate = async () => autoUpdater.quitAndInstallUpdate()

  // airi invariant: register all ipcMain.handle channels strictly BEFORE window.loadURL / loadFile
  const overlayPositionFilePath = path.join(userDataDir, 'overlay-bounds.json')
  const savedOverlayPos = readSavedOverlayPosition(overlayPositionFilePath)
  const cleanupIpc = registerAshyElectronIpc(
    deps.ipcMain,
    kernel,
    () => activeWindows.map((win) => win.webContents),
    {
      overlayController,
      getOverlayWindow: () => overlayWindowRef,
      getHubWindow: () => hubWindowRef,
      overlayPositionFilePath,
    },
  )

  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const defaultPreloadCandidate = path.resolve(moduleDir, '../preload/index.cjs')
  const preloadPath =
    deps.preloadPath ??
    (fs.existsSync(defaultPreloadCandidate)
      ? defaultPreloadCandidate
      : path.resolve(process.cwd(), 'dist/preload/index.cjs'))

  let embeddedServer: { baseUrl: string; close: () => Promise<void> } | null = null
  if (
    !deps.rendererUrl &&
    !process.env.ASHY_ELECTRON_RENDERER_URL &&
    deps.staticDistDir &&
    fs.existsSync(path.join(deps.staticDistDir, 'index.html'))
  ) {
    embeddedServer = await startEmbeddedStaticAndHostServer(deps.staticDistDir, kernel)
  }

  const baseRendererUrl =
    deps.rendererUrl ??
    process.env.ASHY_ELECTRON_RENDERER_URL ??
    embeddedServer?.baseUrl ??
    'http://localhost:5173'
  const overlayUrl = buildViewUrl(baseRendererUrl, 'stage-overlay')
  const callEngineUrl = buildViewUrl(baseRendererUrl, 'call-engine')

  const defaultIconCandidate = path.resolve(moduleDir, '../../build/icon.png')
  const hubIconPath = fs.existsSync(defaultIconCandidate)
    ? defaultIconCandidate
    : path.resolve(process.cwd(), 'build/icon.png')

  const hubWindow = new deps.BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#13111C',
    show: true,
    autoHideMenuBar: true,
    ...(fs.existsSync(hubIconPath) ? { icon: hubIconPath } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  hubWindowRef = hubWindow
  attachWindowSecurityGuards(hubWindow)

  const overlayWindow = new deps.BrowserWindow({
    ...overlayController.browserWindowOptions,
    ...(savedOverlayPos ? { x: savedOverlayPos.x, y: savedOverlayPos.y } : {}),
    webPreferences: {
      ...overlayController.browserWindowOptions.webPreferences,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  overlayWindowRef = overlayWindow
  if (savedOverlayPos) {
    overlayWindow.setPosition?.(savedOverlayPos.x, savedOverlayPos.y)
  }
  overlayWindow.setAlwaysOnTop?.(true, 'screen-saver')
  if (embeddedServer) {
    overlayController.setIgnoreMouseEvents(true, true)
    overlayWindow.setIgnoreMouseEvents?.(true, { forward: true })
  }
  attachWindowSecurityGuards(overlayWindow)

  activeWindows.push(hubWindow, overlayWindow)

  await hubWindow.loadURL(baseRendererUrl)
  if (embeddedServer) {
    hubWindow.show?.()
    hubWindow.focus?.()
  }
  await overlayWindow.loadURL(overlayUrl)

  // Phase 10.1: hidden call-engine window (owner of mic/VAD/session/playback), created on demand
  // by `call:start` and destroyed 60 s after the call goes idle. Same preload, same origin (so
  // `validateIpcSender` accepts it like the hub/overlay) and it receives host events like them.
  const callWindowController = createCallWindowController({
    BrowserWindow: deps.BrowserWindow,
    preloadPath,
    url: callEngineUrl,
    session: deps.session ?? null,
    // Phase 10.2: the llama-server API key stays in the main process; only the call window's
    // requests to the engine port get `Authorization` injected (see installScopedRequestHeaders).
    getEngineAuth: () => kernel.liveCall?.getEngineAuth?.() ?? null,
    // Phase 10.4: cloud speech-to-speech — the call window reaches the cloud through the host's
    // loopback relay; only its requests to the relay port carry the relay token.
    getCloudRelayAuth: () => kernel.liveCall?.getCloudRelayAuth?.() ?? null,
    ...(deps.callWindowIdleDestroyMs !== undefined
      ? { idleDestroyMs: deps.callWindowIdleDestroyMs }
      : {}),
    ...(deps.callWindowTimers ? { timers: deps.callWindowTimers } : {}),
    onWindowCreated: (win) => {
      if (!activeWindows.includes(win)) activeWindows.push(win)
    },
    onWindowGone: (win) => {
      const idx = activeWindows.indexOf(win)
      if (idx >= 0) activeWindows.splice(idx, 1)
    },
  })
  if (typeof kernel.setCallWindowController === 'function') {
    kernel.setCallWindowController({
      ensure: () => callWindowController.ensure(),
      destroy: () => callWindowController.destroy(),
    })
  }
  const unsubscribeCallState = kernel.onHostEvent((evt) => {
    if (evt.type === 'call:state') {
      callWindowController.handleCallState(evt.state.status)
      // Phase 10.4: the relay starts listening during call:start → pick its port up before the
      // renderer connects (the call window gets the start command right before this snapshot).
      if (evt.state.status === 'connecting') callWindowController.refreshEngineAuth()
    } else if (evt.type === 'engine:status') {
      callWindowController.refreshEngineAuth()
    }
  })

  // Phase 10.3: real screen/window capture for the call's vision. The host decides when a
  // capture is allowed (eyesMode/consent); main only picks the source and returns the PNG.
  const screenCaptureKernel = kernel as AshyHostKernel & {
    setScreenCaptureProvider?: (provider: ScreenCaptureProvider | null) => void
  }
  const screenCaptureProvider: ScreenCaptureProvider | null = deps.desktopCapturer
    ? createScreenCaptureProvider({
        desktopCapturer: deps.desktopCapturer,
        screen: deps.screen ?? null,
        getOwnWindows: () => [hubWindowRef, overlayWindowRef, callWindowController.getWindow()],
      })
    : null
  if (screenCaptureProvider && typeof screenCaptureKernel.setScreenCaptureProvider === 'function') {
    screenCaptureKernel.setScreenCaptureProvider(screenCaptureProvider)
  }

  const toggleLiveCall = async (): Promise<void> => {
    if (typeof kernel.invokeLiveCall !== 'function') return
    const current = (await kernel.invokeLiveCall({ method: 'call:getState' })) as
      | CallStateSnapshot
      | undefined
    const status = current?.status ?? 'idle'
    await kernel.invokeLiveCall({
      method: status === 'idle' || status === 'ended' ? 'call:start' : 'call:stop',
    })
  }

  const activatePrivacyShieldAndBroadcast = async (): Promise<void> => {
    await kernel.activatePrivacyShield()
    broadcastShortcutEvent('activatePrivacyShield')
  }

  if (deps.globalShortcut) {
    deps.globalShortcut.register(DEFAULT_STAGE_SHORTCUTS.electronGlobalMic, () => {
      void (async () => {
        try {
          const snap = await kernel.getAgencySnapshot?.()
          if (snap) {
            const nextMic = snap.consent.micMode === 'muted' ? 'continuous' : 'muted'
            await kernel.updateAgencyConsent?.({ micMode: nextMic })
          }
          broadcastShortcutEvent('toggleMic')
        } catch {
          // ignore shortcut error
        }
      })()
    })

    deps.globalShortcut.register(DEFAULT_STAGE_SHORTCUTS.electronGlobalEyes, () => {
      void (async () => {
        try {
          const snap = await kernel.getAgencySnapshot?.()
          if (snap) {
            const nextEyes =
              snap.consent.eyesMode === 'window'
                ? 'screen'
                : snap.consent.eyesMode === 'screen'
                  ? 'off'
                  : 'window'
            await kernel.updateAgencyConsent?.({ eyesMode: nextEyes })
          }
          broadcastShortcutEvent('toggleEyes')
        } catch {
          // ignore shortcut error
        }
      })()
    })

    deps.globalShortcut.register(DEFAULT_STAGE_SHORTCUTS.electronGlobalDnd, () => {
      void (async () => {
        try {
          const snap = await kernel.getAgencySnapshot?.()
          if (snap) {
            const nextDnd = !snap.consent.dndMode
            await kernel.updateAgencyConsent?.({ dndMode: nextDnd })
          }
          broadcastShortcutEvent('toggleDnd')
        } catch {
          // ignore shortcut error
        }
      })()
    })

    deps.globalShortcut.register(DEFAULT_STAGE_SHORTCUTS.electronGlobalHideStage, () => {
      void (async () => {
        try {
          const nextVisible = !overlayController.getState().isOverlayVisible
          overlayController.setOverlayVisible(nextVisible)
          if (isWindowUsable(overlayWindow)) {
            if (nextVisible) {
              overlayWindow.show?.()
            } else {
              overlayWindow.hide?.()
            }
          }
          await kernel.updateStagePreferences?.({ isStageHidden: !nextVisible })
          broadcastShortcutEvent('toggleHideStage')
        } catch {
          // ignore shortcut error
        }
      })()
    })

    deps.globalShortcut.register(DEFAULT_STAGE_SHORTCUTS.electronGlobalPtt, () => {
      void (async () => {
        try {
          const snap = await kernel.getAgencySnapshot?.()
          if (snap) {
            const nextMic = snap.consent.micMode === 'ptt' ? 'muted' : 'ptt'
            await kernel.updateAgencyConsent?.({ micMode: nextMic })
          }
          broadcastShortcutEvent('togglePtt')
        } catch {
          // ignore shortcut error
        }
      })()
    })

    deps.globalShortcut.register(CALL_TOGGLE_SHORTCUT, () => {
      void toggleLiveCall().catch(() => {
        // ignore shortcut error
      })
    })

    deps.globalShortcut.register(
      DEFAULT_STAGE_SHORTCUTS.electronGlobalPrivacyShield,
      () => {
        void (async () => {
          try {
            await activatePrivacyShieldAndBroadcast()
          } catch {
            // ignore shortcut error
          }
        })()
      },
    )
  }

  let isShuttingDown = false
  const processRef = deps.processRef ?? process

  let trayController: AshySystemTrayController | null = null
  if (deps.Tray && deps.Menu) {
    const defaultTrayCandidate = path.resolve(moduleDir, '../../build/tray-icon.png')
    const trayIconPath =
      deps.trayIconPath ??
      (fs.existsSync(defaultTrayCandidate)
        ? defaultTrayCandidate
        : path.resolve(process.cwd(), 'build/tray-icon.png'))
    trayController = createAshySystemTray({
      Tray: deps.Tray,
      Menu: deps.Menu,
      iconPath: trayIconPath,
      kernel,
      overlayController,
      getHubWindow: () => hubWindowRef,
      getOverlayWindow: () => overlayWindowRef,
      onActivatePrivacyShield: activatePrivacyShieldAndBroadcast,
      onCheckForUpdates: async () => {
        await autoUpdater.checkForUpdates()
      },
      onQuit: async () => {
        await shutdown()
        deps.app.quit?.()
      },
    })
  }

  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) return
    isShuttingDown = true
    processRef.removeListener('SIGINT', onSigInt)
    trayController?.destroy()
    deps.globalShortcut?.unregisterAll()
    unsubscribeCallState()
    if (screenCaptureProvider && typeof screenCaptureKernel.setScreenCaptureProvider === 'function') {
      screenCaptureKernel.setScreenCaptureProvider(null)
    }
    if (typeof kernel.setCallWindowController === 'function') {
      kernel.setCallWindowController(null)
    }
    callWindowController.destroy()
    cleanupIpc()
    if (embeddedServer) {
      await embeddedServer.close().catch(() => undefined)
      embeddedServer = null
    }
    await kernel.stop()
  }

  const onSigInt = () => {
    void shutdown()
  }

  deps.app.on('before-quit', () => {
    void shutdown()
  })
  processRef.once('SIGINT', onSigInt)

  return {
    kernel,
    hubWindow,
    overlayWindow,
    overlayController,
    callWindowController,
    autoUpdater,
    trayController,
    shutdown,
  }
}

if (
  typeof process !== 'undefined' &&
  Boolean(process.versions?.electron) &&
  !process.env.VITEST &&
  !process.env.ELECTRON_RUN_AS_NODE
) {
  const electronSpecifier = 'electron'
  void (
    import(/* @vite-ignore */ electronSpecifier) as Promise<{
      app: ElectronAppLike & {
        requestSingleInstanceLock?: () => boolean
        whenReady: () => Promise<void>
        on: (event: string, listener: () => void) => void
        getVersion: () => string
      }
      BrowserWindow: unknown
      ipcMain: unknown
      safeStorage: unknown
      globalShortcut: unknown
      session: unknown
      Tray: unknown
      Menu: unknown
      desktopCapturer: unknown
      screen: unknown
    }>
  )
    .then(async (electronMod) => {
      const {
        app,
        BrowserWindow,
        ipcMain,
        safeStorage,
        globalShortcut,
        session,
        Tray,
        Menu,
        desktopCapturer,
        screen,
      } = electronMod

      if (
        typeof app.requestSingleInstanceLock === 'function' &&
        !app.requestSingleInstanceLock()
      ) {
        app.quit?.()
        return
      }

      const __dirname = path.dirname(fileURLToPath(import.meta.url))
      const distDir = path.resolve(__dirname, '..')
      const preloadPath = path.resolve(__dirname, '../preload/index.cjs')
      const trayIconCandidate = path.resolve(__dirname, '../../build/tray-icon.png')
      const trayIconFallback = path.resolve(distDir, 'assets/ashy-tray-icon.png')
      const trayIconPath = fs.existsSync(trayIconCandidate)
        ? trayIconCandidate
        : trayIconFallback

      await app.whenReady()
      const runtime = await bootAshyElectronMain({
        app,
        BrowserWindow: BrowserWindow as unknown as ElectronBrowserWindowConstructorLike,
        ipcMain: ipcMain as unknown as ElectronIpcMainLike,
        safeStorage: safeStorage as unknown as ElectronSafeStorageLike,
        globalShortcut: globalShortcut as unknown as ElectronGlobalShortcutLike,
        session: (session as { defaultSession?: ElectronSessionLike } | undefined)
          ?.defaultSession,
        Tray: Tray as unknown as ElectronTrayConstructorLike,
        Menu: Menu as unknown as ElectronMenuLike,
        desktopCapturer: desktopCapturer as unknown as ElectronDesktopCapturerLike,
        screen: screen as unknown as ElectronScreenLike,
        preloadPath,
        trayIconPath,
        staticDistDir: distDir,
        isPackaged: app.isPackaged,
        appVersion: app.getVersion(),
      })

      app.on('second-instance', () => {
        runtime.hubWindow.show?.()
        runtime.hubWindow.focus?.()
      })

      app.on('activate', () => {
        runtime.hubWindow.show?.()
        runtime.hubWindow.focus?.()
      })
    })
    .catch((err) => {
      console.error('[Ashy Main] Fatal startup error:', err)
    })
}
