import { type ActionRiskTier } from './action-gatekeeper'
import { type ProgressiveMcpRegistry } from './mcp-progressive'

export interface McpDiscoveredTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  riskTier?: ActionRiskTier
}

export interface McpInitializeResult {
  serverInfo: {
    name: string
    version: string
  }
  protocolVersion?: string
  capabilities?: Record<string, unknown>
}

export interface McpProtocolClient {
  readonly serverName: string
  readonly transport: 'http' | 'stdio'
  initialize(): Promise<McpInitializeResult>
  listTools(): Promise<McpDiscoveredTool[]>
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>
  registerIntoProgressiveRegistry(
    registry: ProgressiveMcpRegistry,
    defaultRiskTier?: ActionRiskTier
  ): Promise<McpDiscoveredTool[]>
  close(): Promise<void>
}

export interface HttpMcpClientOptions {
  serverName: string
  url: string
  description?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
  headers?: Record<string, string>
}

export interface StdioChildProcessLike {
  stdin: {
    write(chunk: string): unknown
    end?(): void
  } | null
  stdout: {
    on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown
    off?(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown
  } | null
  stderr?: {
    on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown
  } | null
  on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): unknown
  kill(signal?: string): unknown
}

export type StdioSpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    shell: false
    stdio: ['pipe', 'pipe', 'pipe']
    cwd?: string
    env?: Record<string, string | undefined>
  }
) => StdioChildProcessLike

export interface StdioMcpClientOptions {
  serverName: string
  command: string
  args?: readonly string[]
  description?: string
  timeoutMs?: number
  maxResponseBytes?: number
  cwd?: string
  env?: Record<string, string | undefined>
  spawnImpl?: StdioSpawnFn
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string | null
  result?: unknown
  error?: {
    code?: number
    message?: string
    data?: unknown
  }
}

type NodeChildProcessLike = {
  spawn: StdioSpawnFn
}

function getBuiltinModule<T>(id: string): T | null {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (modId: string) => unknown } })
      .process
    return (proc?.getBuiltinModule?.(id) as T | undefined) ?? null
  } catch {
    return null
  }
}

const VALID_RISK_TIERS: ReadonlySet<ActionRiskTier> = new Set([
  'observe-only',
  'read-safe',
  'staged-confirm',
])

const FORBIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
])

function sanitizeDiscoveredTool(raw: unknown): McpDiscoveredTool | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!name || name.length > 160 || /[\0\r\n]/.test(name) || FORBIDDEN_TOOL_NAMES.has(name)) {
    return null
  }
  const description =
    typeof record.description === 'string'
      ? record.description.trim().slice(0, 1000)
      : `MCP tool ${name}`
  const inputSchema =
    record.inputSchema && typeof record.inputSchema === 'object' && !Array.isArray(record.inputSchema)
      ? (record.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} }

  const rawTier = record.riskTier
  const riskTier =
    typeof rawTier === 'string' && VALID_RISK_TIERS.has(rawTier as ActionRiskTier)
      ? (rawTier as ActionRiskTier)
      : undefined

  return {
    name,
    description,
    inputSchema,
    ...(riskTier ? { riskTier } : {}),
  }
}

function normalizeInitializeResult(
  rawResult: unknown,
  fallbackServerName: string
): McpInitializeResult {
  const obj =
    rawResult && typeof rawResult === 'object' ? (rawResult as Record<string, unknown>) : {}
  const serverInfoRaw =
    obj.serverInfo && typeof obj.serverInfo === 'object'
      ? (obj.serverInfo as Record<string, unknown>)
      : {}
  return {
    serverInfo: {
      name:
        typeof serverInfoRaw.name === 'string' && serverInfoRaw.name.trim().length > 0
          ? serverInfoRaw.name.trim()
          : fallbackServerName,
      version:
        typeof serverInfoRaw.version === 'string' && serverInfoRaw.version.trim().length > 0
          ? serverInfoRaw.version.trim()
          : '1.0.0',
    },
    ...(typeof obj.protocolVersion === 'string' ? { protocolVersion: obj.protocolVersion } : {}),
    ...(obj.capabilities && typeof obj.capabilities === 'object'
      ? { capabilities: obj.capabilities as Record<string, unknown> }
      : {}),
  }
}

export function createHttpMcpClient(options: HttpMcpClientOptions): McpProtocolClient {
  const serverName = options.serverName?.trim()
  if (!serverName) {
    throw new Error('MCP serverName must be non-empty')
  }
  const rawUrl = options.url?.trim()
  if (!rawUrl) {
    throw new Error('MCP HTTP url must be non-empty')
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid MCP HTTP URL: ${rawUrl}`)
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Unsupported MCP HTTP protocol: ${parsedUrl.protocol}`)
  }

  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = Math.max(250, options.timeoutMs ?? 10_000)
  const maxResponseBytes = Math.max(1024, options.maxResponseBytes ?? 1_048_576)
  let rpcId = 0

  async function sendRpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (typeof fetchFn !== 'function') {
      throw new Error('Global fetch is unavailable for HttpMcpClient')
    }
    rpcId += 1
    const requestId = rpcId
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetchFn(parsedUrl.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(options.headers ?? {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method,
          params,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`MCP HTTP server "${serverName}" returned HTTP ${response.status}`)
      }

      const contentLengthHeader = response.headers?.get?.('content-length')
      if (contentLengthHeader) {
        const declaredBytes = Number(contentLengthHeader)
        if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
          throw new Error(
            `MCP HTTP response from "${serverName}" exceeded max limit (${maxResponseBytes} bytes)`
          )
        }
      }

      const rawText = await response.text()
      if (rawText.length > maxResponseBytes) {
        throw new Error(
          `MCP HTTP response from "${serverName}" exceeded max limit (${maxResponseBytes} bytes)`
        )
      }

      // Support either direct JSON-RPC payload or SSE `data: {...}` framing
      let jsonPayload = rawText.trim()
      if (jsonPayload.startsWith('event:') || jsonPayload.startsWith('data:')) {
        const dataLines = jsonPayload
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trim())
          .filter(Boolean)
        if (dataLines.length > 0) {
          jsonPayload = dataLines[dataLines.length - 1]!
        }
      }

      const parsed = JSON.parse(jsonPayload) as JsonRpcResponse
      if (parsed.error) {
        throw new Error(
          `MCP JSON-RPC error (${parsed.error.code ?? -1}): ${parsed.error.message ?? 'Unknown error'}`
        )
      }
      return parsed.result
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    serverName,
    transport: 'http',
    async initialize(): Promise<McpInitializeResult> {
      const res = await sendRpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: '@ashy/agency-mcp-client', version: '0.1.0' },
      })
      return normalizeInitializeResult(res, serverName)
    },
    async listTools(): Promise<McpDiscoveredTool[]> {
      const res = (await sendRpc('tools/list', {})) as { tools?: unknown[] } | undefined
      const rawTools = Array.isArray(res?.tools) ? res.tools : []
      const sanitized: McpDiscoveredTool[] = []
      for (const item of rawTools) {
        const tool = sanitizeDiscoveredTool(item)
        if (tool) {
          sanitized.push(tool)
        }
      }
      return sanitized
    },
    async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
      const cleanName = name.trim()
      if (!cleanName) {
        throw new Error('Tool name is required for callTool')
      }
      return sendRpc('tools/call', {
        name: cleanName,
        arguments: args ?? {},
      })
    },
    async registerIntoProgressiveRegistry(
      registry: ProgressiveMcpRegistry,
      defaultRiskTier: ActionRiskTier = 'staged-confirm'
    ): Promise<McpDiscoveredTool[]> {
      const tools = await this.listTools()
      registry.registerServer({
        name: serverName,
        description: options.description ?? `External HTTP MCP server (${parsedUrl.host})`,
      })
      registry.registerTools(
        tools.map((tool) => ({
          toolName: tool.name,
          serverName,
          description: tool.description,
          riskTier: tool.riskTier ?? defaultRiskTier,
          inputSchema: tool.inputSchema,
          handler: (callArgs) => this.callTool(tool.name, callArgs),
        }))
      )
      return tools
    },
    async close(): Promise<void> {
      // Stateless HTTP transport
    },
  }
}

export function createStdioMcpClient(options: StdioMcpClientOptions): McpProtocolClient {
  const serverName = options.serverName?.trim()
  if (!serverName) {
    throw new Error('MCP serverName must be non-empty')
  }
  const command = options.command?.trim()
  if (!command || command.includes('\0')) {
    throw new Error('MCP stdio command must be a non-empty string without null bytes')
  }
  const args = (options.args ?? []).map((arg) => {
    if (typeof arg !== 'string' || arg.includes('\0')) {
      throw new Error('MCP stdio argument contains invalid null byte')
    }
    return arg
  })

  const timeoutMs = Math.max(250, options.timeoutMs ?? 10_000)
  const maxResponseBytes = Math.max(1024, options.maxResponseBytes ?? 1_048_576)

  let childProc: StdioChildProcessLike | null = null
  let rpcId = 0
  let stdoutBuffer = ''
  const pendingRequests = new Map<
    number,
    {
      resolve: (val: unknown) => void
      reject: (err: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  function ensureProcess(): StdioChildProcessLike {
    if (childProc) {
      return childProc
    }

    const spawnFn =
      options.spawnImpl ?? getBuiltinModule<NodeChildProcessLike>('node:child_process')?.spawn
    if (typeof spawnFn !== 'function') {
      throw new Error('Stdio MCP transport is not available in this runtime environment')
    }

    const proc = spawnFn(command, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    })

    if (!proc.stdin || !proc.stdout) {
      throw new Error(`Stdio MCP process "${serverName}" failed to open stdin/stdout pipes`)
    }

    proc.stdout.on('data', (chunk: Uint8Array | string) => {
      const str = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
      stdoutBuffer += str
      if (stdoutBuffer.length > maxResponseBytes) {
        stdoutBuffer = ''
        for (const [, pending] of pendingRequests) {
          clearTimeout(pending.timer)
          pending.reject(
            new Error(`Stdio MCP response from "${serverName}" exceeded ${maxResponseBytes} bytes`)
          )
        }
        pendingRequests.clear()
        return
      }

      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed = JSON.parse(trimmed) as JsonRpcResponse
          if (typeof parsed.id === 'number') {
            const pending = pendingRequests.get(parsed.id)
            if (pending) {
              clearTimeout(pending.timer)
              pendingRequests.delete(parsed.id)
              if (parsed.error) {
                pending.reject(
                  new Error(
                    `MCP Stdio JSON-RPC error (${parsed.error.code ?? -1}): ${parsed.error.message ?? 'Unknown error'}`
                  )
                )
              } else {
                pending.resolve(parsed.result)
              }
            }
          }
        } catch {
          // Ignore non-JSON diagnostic log lines on stdout
        }
      }
    })

    proc.on('error', (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err))
      for (const [, pending] of pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      pendingRequests.clear()
    })

    proc.on('close', () => {
      for (const [, pending] of pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`Stdio MCP server "${serverName}" closed unexpectedly`))
      }
      pendingRequests.clear()
      childProc = null
    })

    childProc = proc
    return proc
  }

  function sendRpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const proc = ensureProcess()
    rpcId += 1
    const requestId = rpcId

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId)
        reject(new Error(`Stdio MCP request "${method}" on "${serverName}" timed out`))
      }, timeoutMs)

      pendingRequests.set(requestId, { resolve, reject, timer })

      try {
        const payload =
          JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            method,
            params,
          }) + '\n'
        proc.stdin!.write(payload)
      } catch (err) {
        clearTimeout(timer)
        pendingRequests.delete(requestId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  return {
    serverName,
    transport: 'stdio',
    async initialize(): Promise<McpInitializeResult> {
      const res = await sendRpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: '@ashy/agency-mcp-client', version: '0.1.0' },
      })
      return normalizeInitializeResult(res, serverName)
    },
    async listTools(): Promise<McpDiscoveredTool[]> {
      const res = (await sendRpc('tools/list', {})) as { tools?: unknown[] } | undefined
      const rawTools = Array.isArray(res?.tools) ? res.tools : []
      const sanitized: McpDiscoveredTool[] = []
      for (const item of rawTools) {
        const tool = sanitizeDiscoveredTool(item)
        if (tool) {
          sanitized.push(tool)
        }
      }
      return sanitized
    },
    async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
      const cleanName = name.trim()
      if (!cleanName) {
        throw new Error('Tool name is required for callTool')
      }
      return sendRpc('tools/call', {
        name: cleanName,
        arguments: args ?? {},
      })
    },
    async registerIntoProgressiveRegistry(
      registry: ProgressiveMcpRegistry,
      defaultRiskTier: ActionRiskTier = 'staged-confirm'
    ): Promise<McpDiscoveredTool[]> {
      const tools = await this.listTools()
      registry.registerServer({
        name: serverName,
        description: options.description ?? `External Stdio MCP server (${command})`,
      })
      registry.registerTools(
        tools.map((tool) => ({
          toolName: tool.name,
          serverName,
          description: tool.description,
          riskTier: tool.riskTier ?? defaultRiskTier,
          inputSchema: tool.inputSchema,
          handler: (callArgs) => this.callTool(tool.name, callArgs),
        }))
      )
      return tools
    },
    async close(): Promise<void> {
      if (childProc) {
        try {
          childProc.stdin?.end?.()
          childProc.kill()
        } catch {
          // Ignore kill error
        }
        childProc = null
      }
    },
  }
}
