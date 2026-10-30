import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createActionGatekeeper,
  createHttpMcpClient,
  createPrivacyController,
  createProgressiveMcpRegistry,
  createStdioMcpClient,
} from '@ashy/agency'
import { createAshyCortex, type AshyCortex } from '@ashy/cortex'
import {
  createHostAgencyRuntime,
  resolveWorkspacePath,
  type HostAgencyRuntime,
} from '../host/agency-runtime'
import { createProviderVault } from '../host/provider-vault'

const tempDirs: string[] = []
const activeRuntimes: HostAgencyRuntime[] = []
const activeCortexes: AshyCortex[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-p85-f3-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (activeRuntimes.length > 0) {
    try {
      await activeRuntimes.pop()!.close()
    } catch {
      // Ignore cleanup errors
    }
  }
  while (activeCortexes.length > 0) {
    try {
      activeCortexes.pop()!.close()
    } catch {
      // Ignore cleanup errors
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('Phase 8.5 (Front 3) — Democking MCP Client, Native Tools & Real Vision', () => {
  it('1. sends notifications/initialized after initialize in HTTP and Stdio MCP clients, and auto-initializes in registerIntoProgressiveRegistry', async () => {
    const httpMethods: string[] = []
    const mockFetch: typeof fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        id?: number
        method: string
      }
      httpMethods.push(body.method)

      if (body.method === 'initialize') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'http-auto-init-mcp', version: '1.0.0' },
              capabilities: { tools: {} },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }

      if (body.method === 'tools/list') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                {
                  name: 'http_echo',
                  description: 'Echoes text over HTTP MCP',
                  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
        status: 200,
      })
    })

    const privacy = createPrivacyController({ eyesMode: 'screen', allowedPaths: ['/workspace/ashy'] })
    const gatekeeper = createActionGatekeeper({ privacyController: privacy })
    const registry = createProgressiveMcpRegistry({ gatekeeper })

    // Call registerIntoProgressiveRegistry WITHOUT calling initialize() manually first
    const httpClient = createHttpMcpClient({
      serverName: 'http-auto-init-mcp',
      url: 'http://127.0.0.1:4299/mcp',
      fetchImpl: mockFetch,
    })

    const discoveredHttp = await httpClient.registerIntoProgressiveRegistry(registry, 'read-safe')
    expect(discoveredHttp.map((t) => t.name)).toEqual(['http_echo'])
    expect(httpMethods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])

    // Verify Stdio MCP client also sends notifications/initialized and auto-initializes
    const stdioMethods: string[] = []
    const spawnSpy = vi.fn(() => {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const proc = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr,
        kill: vi.fn(),
      })

      let buf = ''
      stdin.on('data', (chunk: Buffer | string) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const msg = JSON.parse(line) as { id?: number; method: string }
          stdioMethods.push(msg.method)
          if (msg.method === 'initialize') {
            stdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: { serverInfo: { name: 'stdio-auto-init', version: '1.0.0' } },
              }) + '\n',
            )
          } else if (msg.method === 'tools/list') {
            stdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  tools: [
                    {
                      name: 'stdio_echo',
                      description: 'Echoes text over Stdio MCP',
                      inputSchema: { type: 'object', properties: {} },
                    },
                  ],
                },
              }) + '\n',
            )
          }
        }
      })

      return proc
    })

    const stdioClient = createStdioMcpClient({
      serverName: 'stdio-auto-init',
      command: 'node',
      args: ['server.js'],
      spawnImpl: spawnSpy,
    })

    const discoveredStdio = await stdioClient.registerIntoProgressiveRegistry(registry, 'read-safe')
    expect(discoveredStdio.map((t) => t.name)).toEqual(['stdio_echo'])
    expect(stdioMethods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    await stdioClient.close()
  })

  it('2. auto-reconnects persisted externalMcpServers on createHostAgencyRuntime boot and tolerates unreachable servers', async () => {
    const dir = makeTempDir()
    const cortex = createAshyCortex({ dbPath: path.join(dir, 'ashy.db') })
    activeCortexes.push(cortex)

    // Persist 1 reachable HTTP server and 1 unreachable HTTP server before runtime boot
    cortex.db.saveAgencyConsentState({
      approvalPolicy: 'auto_accept',
      externalMcpServers: [
        {
          id: 'persisted-http-1',
          name: 'persisted-weather-mcp',
          description: 'Weather tools',
          transport: 'http',
          url: 'http://127.0.0.1:4310/mcp',
          args: [],
          enabled: true,
        },
        {
          id: 'persisted-offline-2',
          name: 'offline-mcp',
          description: 'Offline server',
          transport: 'http',
          url: 'http://127.0.0.1:4311/mcp',
          args: [],
          enabled: true,
        },
      ],
    })

    const mockFetch: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input)
      if (url.includes('4311')) {
        throw new Error('ECONNREFUSED')
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        id?: number
        method: string
        params?: Record<string, unknown>
      }
      if (body.method === 'initialize') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'persisted-weather-mcp', version: '1.0.0' },
            },
          }),
          { status: 200 },
        )
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }
      if (body.method === 'tools/list') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                {
                  name: 'get_forecast',
                  description: 'Fetches local weather forecast',
                  inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
                },
              ],
            },
          }),
          { status: 200 },
        )
      }
      if (body.method === 'tools/call') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { forecast: 'Sunny 26C', city: (body.params?.arguments as Record<string, unknown>)?.city },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    })

    const runtime = createHostAgencyRuntime({
      cortex,
      userDataDir: dir,
      fetchImpl: mockFetch,
    })
    activeRuntimes.push(runtime)

    const callRes = await runtime.callMcpTool({
      toolName: 'get_forecast',
      args: { city: 'São Paulo' },
    })
    expect(callRes.status).toBe('executed')
    expect(callRes.output).toEqual({ forecast: 'Sunny 26C', city: 'São Paulo' })
    expect(runtime.getSnapshot().tools.some((t) => t.toolName === 'get_forecast')).toBe(true)
  })

  it('3. includes process.cwd() in default allowedPaths, reads real workspace files, and throws ENOENT instead of fake @ashy/desktop mock on missing files', async () => {
    const dir = makeTempDir()
    const cortex = createAshyCortex({ dbPath: path.join(dir, 'ashy.db') })
    activeCortexes.push(cortex)
    const runtime = createHostAgencyRuntime({
      cortex,
      userDataDir: dir,
    })
    activeRuntimes.push(runtime)

    const normalizedCwd = process.cwd().replace(/\\/g, '/')
    expect(runtime.getSnapshot().consent.allowedPaths).toContain(normalizedCwd)

    // Reading /workspace/ashy/package.json must read the real package.json from disk
    const pkgRes = await runtime.callMcpTool({
      toolName: 'read_workspace_file',
      args: { path: '/workspace/ashy/package.json' },
    })
    expect(pkgRes.status).toBe('executed')
    const pkgOut = pkgRes.output as { existsOnDisk: boolean; content: string; bytes: number }
    expect(pkgOut.existsOnDisk).toBe(true)
    expect(pkgOut.content).toContain('"name":')
    expect(pkgOut.content).not.toContain('export const PACKAGE_NAME = "@ashy/desktop"')

    // Reading /workspace/ashy/README.md must read the real monorepo README.md from disk
    const readmeRes = await runtime.callMcpTool({
      toolName: 'read_workspace_file',
      args: { path: '/workspace/ashy/README.md' },
    })
    expect(readmeRes.status).toBe('executed')
    const readmeOut = readmeRes.output as { existsOnDisk: boolean; content: string }
    expect(readmeOut.existsOnDisk).toBe(true)
    expect(readmeOut.content).toContain('ASHY')

    // Reading a non-existent file MUST throw ENOENT and never return fake content
    await expect(
      runtime.callMcpTool({
        toolName: 'read_workspace_file',
        args: { path: '/workspace/ashy/definitely-missing-file-9999.ts' },
      }),
    ).rejects.toThrow(/ENOENT/i)
  })

  it('4. get_active_window_title queries the real OS active window title (or explicit windowTitle) without returning hardcoded VS Code — Ashy Companion mock', async () => {
    const dir = makeTempDir()
    const cortex = createAshyCortex({ dbPath: path.join(dir, 'ashy.db') })
    activeCortexes.push(cortex)
    const runtime = createHostAgencyRuntime({
      cortex,
      userDataDir: dir,
    })
    activeRuntimes.push(runtime)

    await runtime.updateConsent({ eyesMode: 'screen' })

    const res = await runtime.callMcpTool({
      toolName: 'get_active_window_title',
      args: {},
    })
    expect(res.status).toBe('executed')
    const output = res.output as {
      observedWindow: string
      windowTitle: string
      source: string
      eyesMode: string
    }
    expect(typeof output.observedWindow).toBe('string')
    expect(output.observedWindow.length).toBeGreaterThan(0)
    expect(output.observedWindow).not.toBe('VS Code — Ashy Companion')
    expect(output.observedWindow).not.toBe('VS Code')
    expect(output.source).toBe('os')

    // Explicit windowTitle is also respected
    const explicitRes = await runtime.callMcpTool({
      toolName: 'get_active_window_title',
      args: { windowTitle: 'Cursor — phase-8-5.ts' },
    })
    expect((explicitRes.output as { observedWindow: string; source: string }).observedWindow).toBe(
      'Cursor — phase-8-5.ts',
    )
    expect((explicitRes.output as { source: string }).source).toBe('explicit')
  })

  it('5. run_cleanup_command executes real commands and removes target directories after Gatekeeper approval', async () => {
    const dir = makeTempDir()
    const cortex = createAshyCortex({ dbPath: path.join(dir, 'ashy.db') })
    activeCortexes.push(cortex)
    const runtime = createHostAgencyRuntime({
      cortex,
      userDataDir: dir,
    })
    activeRuntimes.push(runtime)

    // Create a real directory and file inside userDataDir
    const tempBuildDir = path.join(dir, 'dist-temp-real')
    fs.mkdirSync(tempBuildDir, { recursive: true })
    fs.writeFileSync(path.join(tempBuildDir, 'bundle.js'), 'console.log(1)', 'utf8')
    expect(fs.existsSync(tempBuildDir)).toBe(true)

    // Stage rm -rf ./dist-temp-real in ask mode, then approve
    const stagedRm = await runtime.callMcpTool({
      toolName: 'run_cleanup_command',
      args: { command: 'rm -rf ./dist-temp-real' },
    })
    expect(stagedRm.status).toBe('staged')
    expect(fs.existsSync(tempBuildDir)).toBe(true)

    const approvedRm = await runtime.approvePendingAction({
      actionId: stagedRm.pendingCard!.id,
      scope: 'once',
    })
    expect(approvedRm.status).toBe('executed')
    expect(fs.existsSync(tempBuildDir)).toBe(false)

    // Also test executing a real shell command that produces stdout
    await runtime.updateConsent({ approvalPolicy: 'auto_accept' })
    const echoRes = await runtime.callMcpTool({
      toolName: 'run_cleanup_command',
      args: { command: 'node -e "process.stdout.write(\'cleanup-stdout-verified\')"' },
    })
    expect(echoRes.status).toBe('executed')
    const cmdOut = echoRes.output as { executed: boolean; exitCode: number; stdout: string }
    expect(cmdOut.executed).toBe(true)
    expect(cmdOut.exitCode).toBe(0)
    expect(cmdOut.stdout).toContain('cleanup-stdout-verified')
  })

  it('6. captureAuthorizedScreen uses active ProviderVault LLM/VLM when configured and records real visionTokensSpent', async () => {
    const dir = makeTempDir()
    const cortex = createAshyCortex({ dbPath: path.join(dir, 'ashy.db') })
    activeCortexes.push(cortex)

    const mockFetch: typeof fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-vision-1',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Editor aberto em agency-runtime.ts com testes passando.',
              },
            },
          ],
          usage: {
            prompt_tokens: 90,
            completion_tokens: 22,
            total_tokens: 112,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    const providerVault = createProviderVault({
      userDataDir: dir,
      fetchImpl: mockFetch,
    })
    providerVault.saveProviderConfig({
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openai/gpt-4o-mini',
      reasoningEffort: 'none',
      apiKey: 'sk-or-v1-test-vision-key',
    })
    providerVault.setActiveProvider('openrouter')

    const runtime = createHostAgencyRuntime({
      cortex,
      userDataDir: dir,
      providerVault,
      fetchImpl: mockFetch,
    })
    activeRuntimes.push(runtime)

    await runtime.updateConsent({ eyesMode: 'window' })

    const captureRes = await runtime.captureAuthorizedScreen({
      windowTitle: 'VS Code — agency-runtime.ts',
    })

    expect(captureRes.observation.observed).toBe(true)
    expect(captureRes.observation.summary).toContain(
      'Editor aberto em agency-runtime.ts com testes passando.',
    )
    expect(captureRes.observation.visionTokensSpent).toBe(112)
    expect(captureRes.snapshot.vision.totalVisionTokensSpent).toBe(112)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('7. [Adversarial Red-Team] blocks resolveWorkspacePath traversal (/workspace/ashy/../../etc/passwd, ..\\..\\Windows\\System32\\drivers\\etc\\hosts, sibling prefix /workspace/ashy-evil, null bytes) and prevents sandbox escape', async () => {
    const dir = makeTempDir()
    const cortex = createAshyCortex({ dbPath: path.join(dir, 'ashy.db') })
    activeCortexes.push(cortex)
    const runtime = createHostAgencyRuntime({
      cortex,
      userDataDir: dir,
    })
    activeRuntimes.push(runtime)

    // Direct resolveWorkspacePath attacks must throw and never escape workspace or userDataDir
    expect(() =>
      resolveWorkspacePath('/workspace/ashy/../../etc/passwd', { userDataDir: dir }),
    ).toThrow(/traversal|unauthorized/i)
    expect(() =>
      resolveWorkspacePath('/workspace/ashy/..\\..\\Windows\\System32\\drivers\\etc\\hosts', {
        userDataDir: dir,
      }),
    ).toThrow(/traversal|unauthorized/i)
    expect(() =>
      resolveWorkspacePath('/workspace/ashy-evil/secret.txt', { userDataDir: dir }),
    ).toThrow(/traversal|unauthorized/i)
    expect(() =>
      resolveWorkspacePath('/workspace/ashy/README.md\0.env', { userDataDir: dir }),
    ).toThrow(/traversal|unauthorized|null/i)

    // Gatekeeper + callMcpTool traversal attacks
    const posixTraversal = await runtime.callMcpTool({
      toolName: 'read_workspace_file',
      args: { path: '/workspace/ashy/../../etc/passwd' },
    })
    expect(posixTraversal.status).toBe('blocked_traversal')

    const winTraversal = await runtime.callMcpTool({
      toolName: 'read_workspace_file',
      args: { path: '/workspace/ashy/..\\..\\Windows\\System32\\drivers\\etc\\hosts' },
    })
    expect(winTraversal.status).toBe('blocked_traversal')
  })

  it('8. [Adversarial Red-Team] blocks run_cleanup_command sandbox escape (rm -rf /tmp/../../outside, rm -rf sibling temp dir, cwd: "../../outside"), rejects empty/whitespace/null-byte commands, and caps massive >1MB stdout/stderr without OOM', async () => {
    const dir = makeTempDir()
    const siblingOutsideDir = makeTempDir()
    const victimFile = path.join(siblingOutsideDir, 'do-not-delete.txt')
    fs.writeFileSync(victimFile, 'SENSITIVE_OUTSIDE_DATA', 'utf8')

    const cortex = createAshyCortex({ dbPath: path.join(dir, 'ashy.db') })
    activeCortexes.push(cortex)
    const runtime = createHostAgencyRuntime({
      cortex,
      userDataDir: dir,
    })
    activeRuntimes.push(runtime)

    await runtime.updateConsent({ approvalPolicy: 'auto_accept' })

    // 1. rm -rf /tmp/../../outside must be rejected
    await expect(
      runtime.callMcpTool({
        toolName: 'run_cleanup_command',
        args: { command: 'rm -rf /tmp/../../outside' },
      }),
    ).rejects.toThrow(/outside sandbox|traversal/i)

    // 2. rm -rf targeting a sibling directory in os.tmpdir() outside userDataDir and outside ashy-tmp-sandbox must be rejected
    await expect(
      runtime.callMcpTool({
        toolName: 'run_cleanup_command',
        args: { command: `rm -rf "${siblingOutsideDir}"` },
      }),
    ).rejects.toThrow(/outside sandbox|traversal/i)
    expect(fs.existsSync(victimFile)).toBe(true)

    await expect(
      runtime.callMcpTool({
        toolName: 'run_cleanup_command',
        args: { command: `rm -rf ../${path.basename(siblingOutsideDir)}` },
      }),
    ).rejects.toThrow(/outside sandbox|traversal/i)
    expect(fs.existsSync(victimFile)).toBe(true)

    // 3. cwd: '../../outside' must be blocked by Gatekeeper with blocked_traversal
    const cwdEscape = await runtime.callMcpTool({
      toolName: 'run_cleanup_command',
      args: { command: 'echo test', cwd: '../../outside' },
    })
    expect(cwdEscape.status).toBe('blocked_traversal')

    // 4. Empty/whitespace command and null bytes (\0) must be rejected
    await expect(
      runtime.callMcpTool({
        toolName: 'run_cleanup_command',
        args: { command: '   \t\n  ' },
      }),
    ).rejects.toThrow(/non-empty|Invalid cleanup command/i)

    await expect(
      runtime.callMcpTool({
        toolName: 'run_cleanup_command',
        args: { command: 'echo safe\0rm -rf /' },
      }),
    ).rejects.toThrow(/null byte|Invalid cleanup command/i)

    // 5. Massive stdout (>1MB) must be capped/truncated without crashing or OOMing
    const massiveRes = await runtime.callMcpTool({
      toolName: 'run_cleanup_command',
      args: {
        command: 'node -e "process.stdout.write(\'X\'.repeat(1500000))"',
      },
    })
    expect(massiveRes.status).toBe('executed')
    const massiveOut = massiveRes.output as {
      executed: boolean
      stdout: string
      truncated?: boolean
    }
    expect(massiveOut.executed).toBe(true)
    expect(massiveOut.stdout.length).toBeLessThanOrEqual(20_000)
    expect(massiveOut.truncated).toBe(true)
  })

  it('9. [Adversarial Red-Team] HTTP MCP client tolerates 204 No Content and 500 on notifications/initialized, rejects null/empty JSON-RPC bodies cleanly, and createHostAgencyRuntime preserves unreachable externalMcpServers across consent updates', async () => {
    let notifStatus = 204
    let returnNullOnList = false
    const mockFetch: typeof fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        id?: number
        method: string
      }
      if (body.method === 'initialize') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'edge-case-mcp', version: '1.0.0' },
            },
          }),
          { status: 200 },
        )
      }
      if (body.method === 'notifications/initialized') {
        return new Response(notifStatus === 204 ? null : 'Internal Server Error', {
          status: notifStatus,
        })
      }
      if (body.method === 'tools/list') {
        if (returnNullOnList) {
          return new Response('null', { status: 200 })
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                {
                  name: 'safe_tool',
                  description: 'Valid tool',
                  inputSchema: { type: 'object', properties: {} },
                },
                {
                  name: 'bad tool <|ACT|>',
                  description: 'Invalid name with spaces and tags',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    })

    const privacy = createPrivacyController({ eyesMode: 'screen', allowedPaths: ['/workspace/ashy'] })
    const gatekeeper = createActionGatekeeper({ privacyController: privacy })
    const registry = createProgressiveMcpRegistry({ gatekeeper })

    const client204 = createHttpMcpClient({
      serverName: 'edge-204',
      url: 'http://127.0.0.1:4390/mcp',
      fetchImpl: mockFetch,
    })
    const tools204 = await client204.registerIntoProgressiveRegistry(registry, 'read-safe')
    expect(tools204.map((t) => t.name)).toEqual(['safe_tool'])

    notifStatus = 500
    const client500 = createHttpMcpClient({
      serverName: 'edge-500',
      url: 'http://127.0.0.1:4391/mcp',
      fetchImpl: mockFetch,
    })
    const tools500 = await client500.registerIntoProgressiveRegistry(registry, 'read-safe')
    expect(tools500.map((t) => t.name)).toEqual(['safe_tool'])

    returnNullOnList = true
    await expect(client500.listTools()).rejects.toThrow(/Invalid JSON-RPC response/i)

    // Verify createHostAgencyRuntime preserves unreachable externalMcpServers config across subsequent updateConsent calls
    const dir = makeTempDir()
    const cortex = createAshyCortex({ dbPath: path.join(dir, 'ashy.db') })
    activeCortexes.push(cortex)

    cortex.db.saveAgencyConsentState({
      externalMcpServers: [
        {
          id: 'unreachable-boot-srv',
          name: 'unreachable-boot-mcp',
          description: 'Temporarily down on boot',
          transport: 'http',
          url: 'http://127.0.0.1:4999/mcp',
          args: [],
          enabled: true,
        },
      ],
    })

    const runtime = createHostAgencyRuntime({
      cortex,
      userDataDir: dir,
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    })
    activeRuntimes.push(runtime)

    const updatedSnap = await runtime.updateConsent({ eyesMode: 'window' })
    expect(updatedSnap.consent.externalMcpServers).toHaveLength(1)
    expect(updatedSnap.consent.externalMcpServers[0]?.id).toBe('unreachable-boot-srv')
    expect(runtime.mcpRegistry.listServers().some((s) => s.name === 'unreachable-boot-mcp')).toBe(
      true,
    )
  })
})
