/**
 * Phase 10.4 — minimal RFC 6455 WebSocket framing for the cloud relay (no dependency): text/binary
 * messages, fragmentation, ping/pong, close. No extensions (the relay never negotiates
 * permessage-deflate, so RSV bits must be 0).
 */
import crypto from 'node:crypto'

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export const WS_OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa } as const
export const WS_MAX_MESSAGE_BYTES = 16 * 1024 * 1024

export function computeWebSocketAccept(key: string): string {
  return crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
}

/** One frame (FIN set). `mask` = true for client → server frames (RFC 6455 §5.3). */
export function encodeWebSocketFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length
  let headerLen = 2
  if (len >= 126 && len <= 0xffff) headerLen += 2
  else if (len > 0xffff) headerLen += 8
  const maskLen = mask ? 4 : 0
  const out = Buffer.alloc(headerLen + maskLen + len)
  out[0] = 0x80 | (opcode & 0x0f)
  let off = 2
  if (len < 126) {
    out[1] = len
  } else if (len <= 0xffff) {
    out[1] = 126
    out.writeUInt16BE(len, 2)
    off = 4
  } else {
    out[1] = 127
    out.writeBigUInt64BE(BigInt(len), 2)
    off = 10
  }
  if (mask) {
    out[1] = out[1]! | 0x80
    const key = crypto.randomBytes(4)
    key.copy(out, off)
    off += 4
    for (let i = 0; i < len; i++) out[off + i] = payload[i]! ^ key[i & 3]!
  } else {
    payload.copy(out, off)
  }
  return out
}

export function encodeCloseFrame(code: number, reason: string, mask: boolean): Buffer {
  const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123)
  const payload = Buffer.alloc(2 + reasonBuf.length)
  payload.writeUInt16BE(code, 0)
  reasonBuf.copy(payload, 2)
  return encodeWebSocketFrame(WS_OPCODE.CLOSE, payload, mask)
}

export interface WebSocketMessage {
  opcode: number
  payload: Buffer
}

export class WebSocketProtocolError extends Error {
  constructor(
    readonly closeCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'WebSocketProtocolError'
  }
}

/** Incremental frame reader → complete messages (control frames are returned as they come). */
export class WebSocketFrameReader {
  private buf: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentOpcode = 0
  private fragmentBytes = 0

  constructor(private readonly expectMasked: boolean) {}

  push(chunk: Buffer): WebSocketMessage[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const out: WebSocketMessage[] = []
    for (;;) {
      if (this.buf.length < 2) break
      const b0 = this.buf[0]!
      const b1 = this.buf[1]!
      const fin = (b0 & 0x80) !== 0
      if ((b0 & 0x70) !== 0) throw new WebSocketProtocolError(1002, 'RSV bits set')
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      if (masked !== this.expectMasked) throw new WebSocketProtocolError(1002, masked ? 'unexpected mask' : 'unmasked client frame')
      let len = b1 & 0x7f
      let off = 2
      if (len === 126) {
        if (this.buf.length < 4) break
        len = this.buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (this.buf.length < 10) break
        const big = this.buf.readBigUInt64BE(2)
        if (big > BigInt(WS_MAX_MESSAGE_BYTES)) throw new WebSocketProtocolError(1009, 'frame too large')
        len = Number(big)
        off = 10
      }
      if (len > WS_MAX_MESSAGE_BYTES) throw new WebSocketProtocolError(1009, 'frame too large')
      const maskOff = off
      if (masked) off += 4
      if (this.buf.length < off + len) break
      let payload: Buffer = Buffer.from(this.buf.subarray(off, off + len))
      if (masked) {
        const key = this.buf.subarray(maskOff, maskOff + 4)
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ key[i & 3]!
      }
      this.buf = this.buf.subarray(off + len)
      if (opcode >= 0x8) {
        if (!fin || len > 125) throw new WebSocketProtocolError(1002, 'bad control frame')
        out.push({ opcode, payload })
        continue
      }
      if (opcode === WS_OPCODE.CONTINUATION) {
        if (this.fragments.length === 0) throw new WebSocketProtocolError(1002, 'unexpected continuation')
      } else {
        if (this.fragments.length > 0) throw new WebSocketProtocolError(1002, 'interleaved message')
        if (opcode !== WS_OPCODE.TEXT && opcode !== WS_OPCODE.BINARY) throw new WebSocketProtocolError(1002, `opcode ${opcode}`)
        this.fragmentOpcode = opcode
        this.fragmentBytes = 0
      }
      this.fragmentBytes += payload.length
      if (this.fragmentBytes > WS_MAX_MESSAGE_BYTES) throw new WebSocketProtocolError(1009, 'message too large')
      this.fragments.push(payload)
      if (fin) {
        payload = this.fragments.length === 1 ? this.fragments[0]! : Buffer.concat(this.fragments)
        this.fragments = []
        out.push({ opcode: this.fragmentOpcode, payload })
      }
    }
    return out
  }
}

/** Parses a close frame payload. */
export function parseClosePayload(payload: Buffer): { code: number; reason: string } {
  if (payload.length < 2) return { code: 1005, reason: '' }
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') }
}

/** A close code that may be sent on the wire (1005/1006/1015 are reserved). */
export function sendableCloseCode(code: number | undefined, fallback = 1011): number {
  if (typeof code !== 'number' || !Number.isInteger(code)) return fallback
  if (code === 1005 || code === 1006 || code === 1015) return fallback
  if ((code >= 1000 && code <= 1014) || (code >= 3000 && code <= 4999)) return code
  return fallback
}
