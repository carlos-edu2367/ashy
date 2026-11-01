/**
 * Phase 10.4 — loopback WebSocket relay for the cloud speech-to-speech backends.
 *
 * Why: the call-engine renderer must never see an API key. OpenAI/DashScope accept `Authorization:
 * Bearer` (injectable into the WS upgrade by Electron main), but Gemini Live only documents the key as a
 * `?key=` query parameter, and Chromium's webRequest IGNORES redirects of ws/wss requests ("Redirects from
 * URLs with ws:// and wss:// schemes are ignored"), so the renderer cannot be made to open that URL
 * without knowing the key. The relay (host, in the Electron main process) solves all providers the same
 * way: the renderer opens `ws://127.0.0.1:<port>/cloud/<callId>`; main injects a per-run relay token
 * header into the call window's requests to that port only (installScopedRequestHeaders); the relay
 * checks the token, resolves the call's upstream target (URL + auth, decided host-side from settings —
 * never from the renderer) and pipes messages both ways. Custom URLs therefore need no CSP change
 * (`ws://127.0.0.1:*` is already allowed) and the key never leaves the main process.
 *
 * Upstream handshake failures are reported to the renderer as close codes 4000 + HTTP status (4401
 * invalid key, 4429 quota…), 4001 no key, 4002 unreachable, 4003 unknown target
 * (see `CLOUD_RELAY_CLOSE` in @ashy/voice openai-realtime-session.ts — kept in sync by a test).
 */
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import type { Duplex } from 'node:stream'
import {
  computeWebSocketAccept,
  encodeCloseFrame,
  encodeWebSocketFrame,
  parseClosePayload,
  sendableCloseCode,
  WebSocketFrameReader,
  WebSocketProtocolError,
  WS_OPCODE,
} from './ws-frames'

export const CLOUD_RELAY_TOKEN_HEADER = 'x-ashy-cloud-relay'
export const CLOUD_RELAY_PATH_PREFIX = '/cloud/'
export const RELAY_CLOSE = { HTTP_BASE: 4000, NO_KEY: 4001, UNREACHABLE: 4002, FORBIDDEN: 4003 } as const

export interface CloudRelayTarget {
  /** Full upstream ws(s) URL (may contain `?key=`: never logged, never sent to the renderer). */
  url: string
  headers: Record<string, string>
  /** Secrets to redact from any reason/diagnostic text. */
  secrets?: string[]
}

export type CloudRelayResolution = { ok: true; target: CloudRelayTarget } | { ok: false; code: number; reason: string }

/** One side of a relayed connection (message level). */
export interface RelayPeer {
  sendText(text: string): void
  sendBinary(data: Buffer): void
  close(code: number, reason: string): void
  onMessage(cb: (data: string | Buffer, binary: boolean) => void): void
  onClose(cb: (code: number, reason: string) => void): void
}

export class UpstreamHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`upstream HTTP ${status}`)
    this.name = 'UpstreamHttpError'
  }
}

export type ConnectUpstream = (target: CloudRelayTarget) => Promise<RelayPeer>

export interface CloudRelayOptions {
  /** Resolves `/cloud/<id>` → upstream (host settings + decrypted key). Called on every connection. */
  resolveTarget(id: string): CloudRelayResolution
  /** Test seam: upstream connector (default: real ws/wss client). */
  connectUpstream?: ConnectUpstream
  upstreamTimeoutMs?: number
  log?: (message: string, data?: unknown) => void
}

export interface CloudRelayAuth {
  origin: string
  port: number
  headers: Record<string, string>
}

export interface CloudRelay {
  /** Starts listening on 127.0.0.1 (random port) once; resolves the port. */
  ensureListening(): Promise<number>
  /** The renderer URL for a target id (null until listening). */
  urlFor(id: string): string | null
  /** Header the main process injects into the call window's requests to the relay port. */
  getAuth(): CloudRelayAuth | null
  readonly activeConnections: number
  close(): Promise<void>
}

function redact(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('***')
  }
  return out.replace(/([?&]key=)[^&\s"]+/gi, '$1***')
}

/** Short, single-line, secret-free reason for a close frame (≤ 120 bytes). */
export function closeReasonFrom(body: string, secrets: readonly string[] = []): string {
  let text = body
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | unknown; message?: unknown }
    const err = parsed?.error as { message?: unknown } | undefined
    if (err && typeof err === 'object' && typeof err.message === 'string') text = err.message
    else if (typeof parsed?.message === 'string') text = parsed.message
  } catch {
    // not JSON
  }
  const one = redact(text, secrets).replace(/\s+/g, ' ').trim()
  return Buffer.from(one, 'utf8').subarray(0, 120).toString('utf8').replace(/�+$/, '')
}

/** Wraps a raw upgraded socket as a message-level peer. `client` = we are the WS client (mask frames). */
export function wrapUpgradedSocket(socket: Duplex, opts: { client: boolean; head?: Buffer }): RelayPeer {
  const reader = new WebSocketFrameReader(!opts.client)
  const messageCbs: Array<(data: string | Buffer, binary: boolean) => void> = []
  const closeCbs: Array<(code: number, reason: string) => void> = []
  /** Messages that arrived before anyone listened (e.g. bytes right after the 101 response). */
  const early: Array<{ data: string | Buffer; binary: boolean }> = []
  let closed = false
  function deliver(data: string | Buffer, binary: boolean): void {
    if (messageCbs.length === 0) {
      early.push({ data, binary })
      return
    }
    for (const cb of messageCbs) cb(data, binary)
  }
  let closeSent = false

  let closeInfo: { code: number; reason: string } | null = null
  function finish(code: number, reason: string): void {
    if (closed) return
    closed = true
    closeInfo = { code, reason }
    for (const cb of closeCbs) cb(code, reason)
    try {
      socket.end()
    } catch {
      // ignore
    }
    setTimeout(() => socket.destroy(), 1000).unref?.()
  }

  function write(buf: Buffer): void {
    if (closed || socket.destroyed) return
    try {
      socket.write(buf)
    } catch {
      // ignore
    }
  }

  function onData(chunk: Buffer): void {
    let messages
    try {
      messages = reader.push(chunk)
    } catch (err) {
      const code = err instanceof WebSocketProtocolError ? err.closeCode : 1002
      if (!closeSent) {
        closeSent = true
        write(encodeCloseFrame(code, 'protocol error', opts.client))
      }
      finish(code, 'protocol error')
      return
    }
    for (const m of messages) {
      if (m.opcode === WS_OPCODE.TEXT) {
        deliver(m.payload.toString('utf8'), false)
      } else if (m.opcode === WS_OPCODE.BINARY) {
        deliver(m.payload, true)
      } else if (m.opcode === WS_OPCODE.PING) {
        write(encodeWebSocketFrame(WS_OPCODE.PONG, m.payload, opts.client))
      } else if (m.opcode === WS_OPCODE.CLOSE) {
        const { code, reason } = parseClosePayload(m.payload)
        if (!closeSent) {
          closeSent = true
          write(encodeCloseFrame(sendableCloseCode(code, 1000), '', opts.client))
        }
        finish(code, reason)
        return
      }
    }
  }

  socket.on('data', onData)
  socket.on('error', () => finish(1006, 'socket error'))
  socket.on('close', () => finish(1006, 'connection lost'))
  if (opts.head && opts.head.length > 0) queueMicrotask(() => onData(opts.head!))

  return {
    sendText(text) {
      write(encodeWebSocketFrame(WS_OPCODE.TEXT, Buffer.from(text, 'utf8'), opts.client))
    },
    sendBinary(data) {
      write(encodeWebSocketFrame(WS_OPCODE.BINARY, data, opts.client))
    },
    close(code, reason) {
      if (closed) return
      if (!closeSent) {
        closeSent = true
        write(encodeCloseFrame(sendableCloseCode(code), reason, opts.client))
      }
      // Wait (briefly) for the peer's close frame, then drop the TCP connection.
      setTimeout(() => finish(code, reason), 500).unref?.()
    },
    onMessage(cb) {
      messageCbs.push(cb)
      for (const m of early.splice(0)) cb(m.data, m.binary)
    },
    onClose(cb) {
      closeCbs.push(cb)
      // Closed before anyone listened (close frame right behind the 101 response).
      if (closeInfo) {
        const info = closeInfo
        queueMicrotask(() => cb(info.code, info.reason))
      }
    },
  }
}

/** Real upstream client: ws:// or wss:// handshake with custom headers, then framed messages. */
export function connectWebSocketUpstream(target: CloudRelayTarget, timeoutMs = 15000): Promise<RelayPeer> {
  return new Promise<RelayPeer>((resolve, reject) => {
    let url: URL
    try {
      url = new URL(target.url)
    } catch {
      reject(new Error('invalid upstream URL'))
      return
    }
    const tls = url.protocol === 'wss:'
    if (!tls && url.protocol !== 'ws:') {
      reject(new Error(`unsupported upstream scheme ${url.protocol}`))
      return
    }
    const key = crypto.randomBytes(16).toString('base64')
    const req = (tls ? https : http).request({
      host: url.hostname,
      port: url.port ? Number(url.port) : tls ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      ...(tls ? { servername: url.hostname } : {}),
      headers: {
        ...target.headers,
        Host: url.host,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        'User-Agent': 'Ashy-LiveCall/1.0',
      },
    })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      req.destroy()
      reject(new Error('upstream handshake timeout'))
    }, timeoutMs)
    req.on('upgrade', (res, socket, head) => {
      if (settled) {
        socket.destroy()
        return
      }
      settled = true
      clearTimeout(timer)
      if (res.headers['sec-websocket-accept'] !== computeWebSocketAccept(key)) {
        socket.destroy()
        reject(new Error('upstream handshake: bad Sec-WebSocket-Accept'))
        return
      }
      resolve(wrapUpgradedSocket(socket, { client: true, head }))
    })
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        if (size < 4096) chunks.push(c)
        size += c.length
      })
      res.on('end', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new UpstreamHttpError(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8').slice(0, 4096)))
      })
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    req.end()
  })
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

export function createCloudRelay(options: CloudRelayOptions): CloudRelay {
  const token = crypto.randomBytes(32).toString('hex')
  const connectUpstream = options.connectUpstream ?? ((t: CloudRelayTarget) => connectWebSocketUpstream(t, options.upstreamTimeoutMs))
  const log = options.log ?? (() => {})
  let server: http.Server | null = null
  let port: number | null = null
  let listening: Promise<number> | null = null
  let active = 0
  const sockets = new Set<Duplex>()

  function reject(socket: Duplex, status: number, text: string): void {
    try {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    } catch {
      // ignore
    }
    socket.destroy()
  }

  function onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const presented = req.headers[CLOUD_RELAY_TOKEN_HEADER]
    if (typeof presented !== 'string' || !timingSafeEqualStr(presented, token)) {
      log('relay: rejected connection without a valid token')
      reject(socket, 401, 'Unauthorized')
      return
    }
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string' || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      reject(socket, 400, 'Bad Request')
      return
    }
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (!path.startsWith(CLOUD_RELAY_PATH_PREFIX)) {
      reject(socket, 404, 'Not Found')
      return
    }
    const id = decodeURIComponent(path.slice(CLOUD_RELAY_PATH_PREFIX.length))
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${computeWebSocketAccept(key)}\r\n\r\n`,
    )
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const downstream = wrapUpgradedSocket(socket, { client: false, head })
    active += 1
    let upstream: RelayPeer | null = null
    let downClosed = false
    const pending: Array<{ data: string | Buffer; binary: boolean }> = []
    downstream.onClose(() => {
      downClosed = true
      active = Math.max(0, active - 1)
      upstream?.close(1000, 'client closed')
    })
    downstream.onMessage((data, binary) => {
      if (upstream) {
        if (binary) upstream.sendBinary(data as Buffer)
        else upstream.sendText(data as string)
      } else if (pending.length < 256) {
        pending.push({ data, binary })
      }
    })

    let resolution: CloudRelayResolution
    try {
      resolution = options.resolveTarget(id)
    } catch (err) {
      resolution = { ok: false, code: RELAY_CLOSE.FORBIDDEN, reason: String((err as Error)?.message ?? err).slice(0, 100) }
    }
    if (!resolution.ok) {
      downstream.close(resolution.code, resolution.reason)
      return
    }
    const target = resolution.target
    connectUpstream(target).then(
      (up) => {
        if (downClosed) {
          up.close(1000, 'client gone')
          return
        }
        upstream = up
        up.onMessage((data, binary) => {
          // The cloud protocols are JSON; Gemini sends it in binary frames. The renderer gets text.
          downstream.sendText(binary ? (data as Buffer).toString('utf8') : (data as string))
        })
        up.onClose((code, reason) => {
          downstream.close(sendableCloseCode(code), closeReasonFrom(reason, target.secrets))
        })
        for (const m of pending.splice(0)) {
          if (m.binary) up.sendBinary(m.data as Buffer)
          else up.sendText(m.data as string)
        }
      },
      (err: unknown) => {
        if (err instanceof UpstreamHttpError) {
          const status = err.status >= 100 && err.status < 600 ? err.status : 502
          const reason = closeReasonFrom(err.body || `HTTP ${status}`, target.secrets)
          log('relay: upstream rejected the handshake', { status })
          downstream.close(RELAY_CLOSE.HTTP_BASE + status, reason)
          return
        }
        const msg = closeReasonFrom(String((err as Error)?.message ?? err), target.secrets)
        log('relay: upstream unreachable', { error: msg })
        downstream.close(RELAY_CLOSE.UNREACHABLE, msg)
      },
    )
  }

  return {
    ensureListening() {
      if (listening) return listening
      listening = new Promise<number>((resolve, rejectListen) => {
        const srv = http.createServer((_req, res) => {
          res.statusCode = 404
          res.end()
        })
        srv.on('upgrade', onUpgrade)
        srv.once('error', (err) => {
          listening = null
          rejectListen(err)
        })
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address()
          port = typeof addr === 'object' && addr ? addr.port : null
          server = srv
          if (port === null) rejectListen(new Error('relay: no port'))
          else resolve(port)
        })
        srv.unref?.()
      })
      return listening
    },
    urlFor(id) {
      return port === null ? null : `ws://127.0.0.1:${port}${CLOUD_RELAY_PATH_PREFIX}${encodeURIComponent(id)}`
    },
    getAuth() {
      return port === null ? null : { origin: `http://127.0.0.1:${port}`, port, headers: { [CLOUD_RELAY_TOKEN_HEADER]: token } }
    },
    get activeConnections() {
      return active
    },
    async close() {
      const srv = server
      server = null
      port = null
      listening = null
      for (const s of sockets) s.destroy()
      sockets.clear()
      if (srv) await new Promise<void>((r) => srv.close(() => r()))
    },
  }
}
