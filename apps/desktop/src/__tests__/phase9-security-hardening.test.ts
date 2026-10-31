import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as agencyPkg from '@ashy/agency'
import {
  createActionGatekeeper,
  createHttpMcpClient,
  createPrivacyController,
  createStdioMcpClient,
} from '@ashy/agency'
import { createAshyCortex, type AshyCortex } from '@ashy/cortex'
import {
  createHostAgencyRuntime,
  resolveWorkspacePath,
  type HostAgencyRuntime,
} from '../host/agency-runtime'
import { createAshyHostHttpMiddleware } from '../host/vite-host-plugin'
import { createHttpSseHostBridge } from '../services/ashy-host-client'

const tempDirs: string[] = []
const activeRuntimes: HostAgencyRuntime[] = []
const activeCortexes: AshyCortex[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-p9-sec-'))
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

describe('Phase 9 Security Hardening — Adversarial Red-Team Suite', () => {
  it('1. exports isSensitiveHostPath and blocks all sensitive host files in ActionGatekeeper and resolveWorkspacePath while keeping non-sensitive userDataDir files accessible', async () => {
    const isSensitiveHostPath = (
      agencyPkg as unknown as { isSensitiveHostPath?: (p: string) => boolean }
    ).isSensitiveHostPath
    expect(typeof isSensitiveHostPath).toBe('function')

    const sensitiveSamples = [
      '.master.key',
      '/data/.master.key.dpapi',
      'C:\\Users\\ashy\\.master.key.enc',
      'providers.secrets.json',
      '/userData/providers.secrets.json.bak1',
      'voice-settings.json',
      'voice-settings.json.tmp',
      'providers.json',
      'providers.json.bak',
      'stage-preferences.json',
      'stage-preferences.json.1',
      'ashy.db',
      'ashy.db-wal',
      'ashy.db-shm',
      'ashy.db.backup',
      'backup.ashy-soul',
      'export.ashy-soul.json',
      '.env',
      '.env.local',
      '.env.production',
      '.git/config',
      '/repo/.git/config',
      'id_rsa',
      'id_ed25519.pub',
      'cert.pem',
      'private.key',
    ]
    for (const sample of sensitiveSamples) {
      expect(isSensitiveHostPath!(sample), `Expected ${sample} to be sensitive`).toBe(true)
    }

    const safeSamples = [
      '/workspace/ashy/README.md',
      '/workspace/ashy/package.json',
      'notes/architecture.md',
      'dist-temp-real/bundle.js',
    ]
    for (const sample of safeSamples) {
      expect(isSensitiveHostPath!(sample), `Expected ${sample} to be allowed`).toBe(false)
    }

    const dir = makeTempDir()
    fs.writeFileSync(path.join(dir, '.master.key'), 'TOP_SECRET_MASTER_KEY', 'utf8')
    fs.writeFileSync(path.join(dir, 'providers.secrets.json'), '{"openai":"sk-secret"}', 'utf8')
    fs.writeFileSync(path.join(dir, 'voice-settings.json'), '{"elevenlabs":"el-secret"}', 'utf8')
    fs.writeFileSync(path.join(dir, 'safe-note.md'), '# Safe Note', 'utf8')

    // Direct resolveWorkspacePath must throw on sensitive files even inside userDataDir
    expect(() =>
      resolveWorkspacePath(path.join(dir, '.master.key'), { userDataDir: dir }),
    ).toThrow(/Access denied: sensitive host file is protected/i)
    expect(() =>
      resolveWorkspacePath(path.join(dir, 'providers.secrets.json'), { userDataDir: dir }),
    ).toThrow(/Access denied: sensitive host file is protected/i)
    expect(() =>
      resolveWorkspacePath(path.join(dir, 'ashy.db'), { userDataDir: dir }),
    ).toThrow(/Access denied: sensitive host file is protected/i)

    // Non-sensitive file inside userDataDir remains accessible
    const resolvedSafe = resolveWorkspacePath(path.join(dir, 'safe-note.md'), { userDataDir: dir })
    expect(resolvedSafe).toContain('safe-note.md')

    // ActionGatekeeper + HostAgencyRuntime must block read_workspace_file on sensitive files
    const cortex = createAshyCortex({ dbPath: path.join(dir, 'ashy.db') })
    activeCortexes.push(cortex)
    const runtime = createHostAgencyRuntime({ cortex, userDataDir: dir })
    activeRuntimes.push(runtime)

    const masterKeyRead = await runtime.callMcpTool({
      toolName: 'read_workspace_file',
      args: { path: path.join(dir, '.master.key') },
    })
    expect(masterKeyRead.status).toBe('blocked_traversal')

    const secretsRead = await runtime.callMcpTool({
      toolName: 'read_workspace_file',
      args: { path: path.join(dir, 'providers.secrets.json') },
    })
    expect(secretsRead.status).toBe('blocked_traversal')

    const safeRead = await runtime.callMcpTool({
      toolName: 'read_workspace_file',
      args: { path: path.join(dir, 'safe-note.md') },
    })
    expect(safeRead.status).toBe('executed')

    const envWrite = await runtime.callMcpTool({
      toolName: 'write_project_note',
      args: { title: 'Env Attempt', path: path.join(dir, '.env'), content: 'SECRET=1' },
    })
    expect(envWrite.status).toBe('blocked_traversal')
    expect(runtime.gatekeeper.isPathAllowed(path.join(dir, '.master.key'))).toBe(false)
    expect(runtime.gatekeeper.isPathAllowed(path.join(dir, 'safe-note.md'))).toBe(true)
  })

  it('2. blocks symlink file and symlinked parent directory escapes in resolveWorkspacePath and runtime tools', async () => {
    const dir = makeTempDir()
    const outsideDir = makeTempDir()
    const outsideSecretFile = path.join(outsideDir, 'outside-secret.txt')
    fs.writeFileSync(outsideSecretFile, 'OUTSIDE_HOST_SECRET', 'utf8')

    const workspaceDir = path.join(dir, 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })

    const symlinkFile = path.join(workspaceDir, 'linked-secret.txt')
    const symlinkDir = path.join(workspaceDir, 'evil-dir')

    let symlinksCreated = false
    try {
      fs.symlinkSync(outsideSecretFile, symlinkFile, 'file')
      fs.symlinkSync(outsideDir, symlinkDir, process.platform === 'win32' ? 'junction' : 'dir')
      symlinksCreated = true
    } catch {
      // On Windows without Developer Mode, file symlinks may fail, try junction at least
      try {
        if (!fs.existsSync(symlinkDir)) {
          fs.symlinkSync(outsideDir, symlinkDir, 'junction')
          symlinksCreated = true
        }
      } catch {
        symlinksCreated = false
      }
    }

    if (symlinksCreated) {
      if (fs.existsSync(symlinkFile)) {
        expect(() =>
          resolveWorkspacePath(symlinkFile, {
            userDataDir: dir,
            workspaceCwd: workspaceDir,
            allowedPaths: [dir, workspaceDir],
          }),
        ).toThrow(/Symlink escape blocked/i)
      }

      if (fs.existsSync(symlinkDir)) {
        const nestedViaSymlinkDir = path.join(symlinkDir, 'outside-secret.txt')
        expect(() =>
          resolveWorkspacePath(nestedViaSymlinkDir, {
            userDataDir: dir,
            workspaceCwd: workspaceDir,
            allowedPaths: [dir, workspaceDir],
          }),
        ).toThrow(/Symlink escape blocked/i)

        // Also test write target inside a symlinked parent directory that does not exist yet
        const newWriteViaSymlinkDir = path.join(symlinkDir, 'new-pwned-note.md')
        expect(() =>
          resolveWorkspacePath(newWriteViaSymlinkDir, {
            userDataDir: dir,
            workspaceCwd: workspaceDir,
            allowedPaths: [dir, workspaceDir],
            forWrite: true,
          }),
        ).toThrow(/Symlink escape blocked/i)
      }
    }
  })

  it('3. hardens run_cleanup_command against shell metacharacters, arbitrary binaries, dangerous node -e expressions, and enforces per-argument session approval', async () => {
    const dir = makeTempDir()
    const cortex = createAshyCortex({ dbPath: path.join(dir, 'ashy.db') })
    activeCortexes.push(cortex)
    const runtime = createHostAgencyRuntime({ cortex, userDataDir: dir })
    activeRuntimes.push(runtime)

    await runtime.updateConsent({ approvalPolicy: 'auto_accept' })

    // 1. Shell chaining / redirection / command substitution characters must be rejected
    const injectionPayloads = [
      'rm -rf ./tmp1 ; whoami',
      'rm -rf ./tmp1 && calc.exe',
      'rm -rf ./tmp1 | cat',
      'rm -rf ./tmp1 > out.txt',
      'rm -rf $(whoami)',
      'rm -rf `whoami`',
    ]
    for (const cmd of injectionPayloads) {
      await expect(
        runtime.callMcpTool({
          toolName: 'run_cleanup_command',
          args: { command: cmd },
        }),
      ).rejects.toThrow(/shell|security policy|forbidden|blocked/i)
    }

    // 2. Referencing sensitive host files in cleanup command must be blocked
    await expect(
      runtime.callMcpTool({
        toolName: 'run_cleanup_command',
        args: { command: 'rm -rf .master.key' },
      }),
    ).rejects.toThrow(/Cleanup command blocked: references sensitive host file|sensitive host file/i)

    // 3. Dangerous node -e expressions must be rejected
    const forbiddenNodeExprs = [
      'node -e "require(\'child_process\').execSync(\'whoami\')"',
      'node -e "fs.readFileSync(\'.master.key\')"',
      'node -e "fs.unlinkSync(\'ashy.db\')"',
      'node -e "process.stdout.write(fs.readFileSync(\'providers.secrets.json\', \'utf8\'))"',
    ]
    for (const cmd of forbiddenNodeExprs) {
      await expect(
        runtime.callMcpTool({
          toolName: 'run_cleanup_command',
          args: { command: cmd },
        }),
      ).rejects.toThrow(/security policy|blocked|forbidden|sensitive/i)
    }

    // 4. Arbitrary OS commands (whoami, powershell, curl, cmd) must be rejected
    for (const cmd of ['whoami', 'powershell -Command Get-Process', 'curl http://example.com']) {
      await expect(
        runtime.callMcpTool({
          toolName: 'run_cleanup_command',
          args: { command: cmd },
        }),
      ).rejects.toThrow(/Command rejected by security policy: only workspace rm or safe node expressions are permitted/i)
    }

    // 5. Per-argument session approval in ActionGatekeeper for run_cleanup_command
    const privacy = createPrivacyController({ allowedPaths: [dir] })
    const gatekeeper = createActionGatekeeper({
      privacyController: privacy,
      approvalPolicy: 'ask',
    })
    gatekeeper.registerTool({
      toolName: 'run_cleanup_command',
      serverName: 'workspace-shell',
      description: 'Cleanup runner',
      riskTier: 'staged-confirm',
      handler: async (args) => ({ ran: args.command }),
    })

    // Stage and approve command A with scope: 'session' (using non-blast-radius command so session approval applies)
    const stagedA = await gatekeeper.executeTool('run_cleanup_command', {
      command: 'node -e "process.stdout.write(\'clean-a\')"',
    })
    expect(stagedA.status).toBe('staged')
    await gatekeeper.approveAction(stagedA.pendingCard!.id, 'session')

    // Calling the exact same command A again in the session is auto-approved
    const repeatA = await gatekeeper.executeTool('run_cleanup_command', {
      command: 'node -e "process.stdout.write(\'clean-a\')"',
    })
    expect(repeatA.status).toBe('executed')

    // Calling a DIFFERENT command B must NOT be auto-approved — it must be staged!
    const differentB = await gatekeeper.executeTool('run_cleanup_command', {
      command: 'node -e "process.stdout.write(\'clean-b\')"',
    })
    expect(differentB.status).toBe('staged')

    // Revoking run_cleanup_command clears the per-argument session approval for command A
    gatekeeper.revokeSessionApproval('run_cleanup_command')
    const afterRevokeA = await gatekeeper.executeTool('run_cleanup_command', {
      command: 'node -e "process.stdout.write(\'clean-a\')"',
    })
    expect(afterRevokeA.status).toBe('staged')
  })

  it('4. blocks SSRF targets in createHttpMcpClient and sanitizes process.env in createStdioMcpClient', async () => {
    const ssrfUrls = [
      'http://0.0.0.0:8080/mcp',
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.10.20/mcp',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://metadata.goog/mcp',
      'http://100.100.100.200/latest/meta-data/',
      'http://[::]:8080/mcp',
      'http://[fe80::1]:8080/mcp',
    ]

    for (const badUrl of ssrfUrls) {
      expect(
        () =>
          createHttpMcpClient({
            serverName: 'ssrf-test',
            url: badUrl,
          }),
        `Expected SSRF URL ${badUrl} to be rejected`,
      ).toThrow(/SSRF|blocked|disallowed|forbidden|unsupported|invalid/i)
    }

    // Stdio MCP client environment sanitization
    const prevOpenAi = process.env.OPENAI_API_KEY
    const prevAnthropic = process.env.ANTHROPIC_API_KEY
    const prevGithub = process.env.GITHUB_TOKEN
    process.env.OPENAI_API_KEY = 'sk-leaked-openai-secret'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-leaked-secret'
    process.env.GITHUB_TOKEN = 'ghp_leaked_token'

    try {
      let capturedEnv: Record<string, string | undefined> | undefined
      const spawnSpy = vi.fn((_cmd, _args, opts) => {
        capturedEnv = opts.env
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const proc = Object.assign(new EventEmitter(), {
          stdin,
          stdout,
          stderr,
          kill: vi.fn(),
        })
        stdin.on('data', (chunk: Buffer | string) => {
          const lines = chunk.toString().split('\n').filter(Boolean)
          for (const line of lines) {
            const msg = JSON.parse(line) as { id?: number; method: string }
            if (msg.id !== undefined) {
              stdout.write(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  result: { serverInfo: { name: 'env-test', version: '1.0.0' } },
                }) + '\n',
              )
            }
          }
        })
        return proc
      })

      const stdioClient = createStdioMcpClient({
        serverName: 'env-check-mcp',
        command: 'node',
        args: ['mcp.js'],
        env: { EXPLICIT_CUSTOM_VAR: 'allowed-value' },
        spawnImpl: spawnSpy,
      })

      await stdioClient.initialize()
      expect(capturedEnv).toBeDefined()
      expect(capturedEnv?.OPENAI_API_KEY).toBeUndefined()
      expect(capturedEnv?.ANTHROPIC_API_KEY).toBeUndefined()
      expect(capturedEnv?.GITHUB_TOKEN).toBeUndefined()
      expect(capturedEnv?.EXPLICIT_CUSTOM_VAR).toBe('allowed-value')
      await stdioClient.close()
    } finally {
      if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevOpenAi
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevAnthropic
      if (prevGithub === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = prevGithub
    }
  })

  it('5. enforces X-Ashy-Request: 1 anti-CSRF header, rejects cross-port Origin vs Host, and binds Vite server/preview to 127.0.0.1', async () => {
    const fakeKernel = {
      getBootstrapSnapshot: vi.fn(async () => ({ ok: true })),
      onHostEvent: vi.fn(() => () => undefined),
    } as unknown as Parameters<typeof createAshyHostHttpMiddleware>[0] extends () => Promise<infer K>
      ? K
      : never

    const middleware = createAshyHostHttpMiddleware(async () => fakeKernel)
    const server = http.createServer((req, res) => {
      middleware(req, res, () => {
        res.statusCode = 404
        res.end('Not Found')
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      // 1. Missing X-Ashy-Request header on POST /__ashy_host/rpc must return 403
      const noHeaderRes = await fetch(`${baseUrl}/__ashy_host/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'getBootstrapSnapshot' }),
      })
      expect(noHeaderRes.status).toBe(403)
      const noHeaderJson = (await noHeaderRes.json()) as { ok: boolean; error?: string }
      expect(noHeaderJson.error).toContain('Forbidden: missing X-Ashy-Request anti-CSRF header')

      // 2. Cross-port Origin (e.g. Origin: http://127.0.0.1:3000 vs Host: 127.0.0.1:<port>) must return 403
      const crossPortRes = await fetch(`${baseUrl}/__ashy_host/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Ashy-Request': '1',
          Origin: 'http://127.0.0.1:3000',
        },
        body: JSON.stringify({ method: 'getBootstrapSnapshot' }),
      })
      expect(crossPortRes.status).toBe(403)
      const crossPortJson = (await crossPortRes.json()) as { ok: boolean; error?: string }
      expect(crossPortJson.error).toContain('Cross-port origin rejected')

      // 3. createHttpSseHostBridge automatically sends X-Ashy-Request: 1 and succeeds
      const bridge = createHttpSseHostBridge({ baseUrl, fetchImpl: fetch })
      const snap = await bridge.getBootstrapSnapshot()
      expect(snap).toEqual({ ok: true })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    // 4. Verify vite.config.ts binds server.host and preview.host to 127.0.0.1
    const viteConfigPath = path.resolve(__dirname, '../../vite.config.ts')
    const viteConfigText = fs.readFileSync(viteConfigPath, 'utf8')
    expect(viteConfigText).toContain("host: '127.0.0.1'")
    expect(viteConfigText).toContain('preview:')
  })

  it('6. removes external Google Fonts links and enforces Content-Security-Policy in apps/desktop/index.html', () => {
    const indexHtmlPath = path.resolve(__dirname, '../../index.html')
    const html = fs.readFileSync(indexHtmlPath, 'utf8')

    expect(html).not.toContain('fonts.googleapis.com')
    expect(html).not.toContain('fonts.gstatic.com')
    expect(html).toContain('http-equiv="Content-Security-Policy"')
    expect(html).toContain("object-src 'none'")
    expect(html).toContain("base-uri 'self'")
  })
})
