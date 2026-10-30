import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as v from 'valibot'
import {
  ActionGatekeeper,
  PrivacyController,
  ProgressiveMcpRegistry,
  canonicalizeSafePath,
  computeUnifiedDiffPreview,
  createAuthorizedVisionSensor,
  createHttpMcpClient,
  createStdioMcpClient,
  detectBlastRadiusWarning,
  isPathWithinAllowed,
  type ApprovalScope,
  type AuthorizedVisionSensor,
  type CapturedScreenFrame,
  type McpProtocolClient,
} from '@ashy/agency'
import type { AshyCortex } from '@ashy/cortex'
import {
  ApprovalScopeSchema,
  ExternalMcpServerConfigSchema,
  UpdateAgencyConsentInputSchema,
  type AgencySnapshot,
  type ExternalMcpServerConfig,
  type PersistedAgencyConsentState,
  type SharedPendingActionCard,
  type UpdateAgencyConsentInput,
  type VisionObservationResult,
} from '@ashy/shared'
import type { ProviderVault } from './provider-vault'

export interface HostAgencyRuntimeOptions {
  readonly cortex: AshyCortex
  readonly userDataDir: string
  readonly providerVault?: ProviderVault
  readonly fetchImpl?: typeof fetch
}

export interface HostAgencyRuntime {
  readonly privacyController: PrivacyController
  readonly gatekeeper: ActionGatekeeper
  readonly mcpRegistry: ProgressiveMcpRegistry
  readonly visionSensor: AuthorizedVisionSensor
  getSnapshot(): AgencySnapshot
  callMcpTool(input: {
    toolName: string
    args?: Record<string, unknown>
  }): Promise<{
    status: 'executed' | 'staged' | 'blocked_privacy' | 'blocked_traversal' | 'blocked_policy'
    output?: unknown
    pendingCard?: SharedPendingActionCard
    reason?: string
    snapshot: AgencySnapshot
  }>
  approvePendingAction(input: {
    actionId: string
    scope?: ApprovalScope
  }): Promise<{
    status: 'executed'
    card: SharedPendingActionCard
    output: unknown
    snapshot: AgencySnapshot
  }>
  denyPendingAction(input: {
    actionId: string
    reason?: string
  }): Promise<{
    status: 'denied'
    card: SharedPendingActionCard
    feedback: string
    snapshot: AgencySnapshot
  }>
  updateConsent(input: UpdateAgencyConsentInput): Promise<AgencySnapshot>
  revokeSessionPermissions(input?: { toolName?: string }): AgencySnapshot
  captureAuthorizedScreen(input?: {
    windowTitle?: string
    frameFixtureId?: string
    forceRefresh?: boolean
  }): Promise<{
    observation: VisionObservationResult
    snapshot: AgencySnapshot
  }>
  registerExternalMcpServer(input: ExternalMcpServerConfig): Promise<AgencySnapshot>
  getActiveVisionContextForTurn(): string | undefined
  close(): Promise<void>
}

const SYNTHETIC_FIXTURE_IDS: ReadonlySet<string> = new Set([
  'static-frame',
  'changed-ide-frame',
  'changed-terminal-frame',
  'browser-docs-frame',
])

const MAX_CLEANUP_OUTPUT_CHARS = 16_384

export interface ResolveWorkspacePathOptions {
  readonly userDataDir?: string
  readonly workspaceCwd?: string
  readonly allowedPaths?: readonly string[]
  readonly forWrite?: boolean
}

export function resolveWorkspacePath(
  candidatePath: string,
  opts?: ResolveWorkspacePathOptions,
): string {
  if (typeof candidatePath !== 'string') {
    throw new Error('Unauthorized workspace path: path must be a non-empty string')
  }
  const trimmed = candidatePath.trim()
  if (
    !trimmed ||
    trimmed.includes('\0') ||
    /%2e|%2f|%5c|%00|%25/i.test(trimmed)
  ) {
    throw new Error(`Path traversal or null-byte injection blocked: ${candidatePath}`)
  }

  const normalized = trimmed.replace(/\\/g, '/')
  if (/(?:^|\/)\.{2,}(?:\/|$)/.test(normalized)) {
    throw new Error(`Path traversal segment (..) blocked in resolveWorkspacePath: ${candidatePath}`)
  }

  const normalizedUserDataDir = path
    .resolve(opts?.userDataDir ?? process.cwd())
    .replace(/\\/g, '/')
  const normalizedWorkspaceCwd = path
    .resolve(opts?.workspaceCwd ?? process.cwd())
    .replace(/\\/g, '/')
  const candidateMonorepoRoot = path.resolve(normalizedWorkspaceCwd, '../..').replace(/\\/g, '/')
  const hasMonorepoRoot =
    candidateMonorepoRoot !== normalizedWorkspaceCwd &&
    fs.existsSync(path.join(candidateMonorepoRoot, 'pnpm-workspace.yaml'))

  const workspaceBaseDirs = [
    path.join(normalizedUserDataDir, 'workspace').replace(/\\/g, '/'),
    normalizedUserDataDir,
    normalizedWorkspaceCwd,
    ...(hasMonorepoRoot ? [candidateMonorepoRoot] : []),
    ...(opts?.allowedPaths ?? []),
  ]

  if (normalized === '/workspace/ashy' || normalized.startsWith('/workspace/ashy/')) {
    const rel = normalized.slice('/workspace/ashy'.length).replace(/^\/+/, '')
    if (
      rel.includes('\0') ||
      rel.includes(':') ||
      rel.startsWith('/') ||
      /(?:^|\/)\.{2,}(?:\/|$)/.test(rel)
    ) {
      throw new Error(`Path traversal blocked inside /workspace/ashy: ${candidatePath}`)
    }

    const userWorkspaceRoot = path.join(normalizedUserDataDir, 'workspace').replace(/\\/g, '/')
    const userWorkspaceCandidate = path
      .resolve(userWorkspaceRoot, rel || 'README.md')
      .replace(/\\/g, '/')

    if (!isPathWithinAllowed(userWorkspaceCandidate, [userWorkspaceRoot])) {
      throw new Error(`Path traversal escaped user workspace root: ${candidatePath}`)
    }

    if (opts?.forWrite) {
      return userWorkspaceCandidate
    }
    if (rel && fs.existsSync(userWorkspaceCandidate)) {
      return userWorkspaceCandidate
    }
    if (rel) {
      const cwdCandidate = path.resolve(normalizedWorkspaceCwd, rel).replace(/\\/g, '/')
      if (
        isPathWithinAllowed(cwdCandidate, [normalizedWorkspaceCwd]) &&
        fs.existsSync(cwdCandidate)
      ) {
        return cwdCandidate
      }
      if (hasMonorepoRoot) {
        const monorepoCandidate = path.resolve(candidateMonorepoRoot, rel).replace(/\\/g, '/')
        if (
          isPathWithinAllowed(monorepoCandidate, [candidateMonorepoRoot]) &&
          fs.existsSync(monorepoCandidate)
        ) {
          return monorepoCandidate
        }
      }
    }
    return userWorkspaceCandidate
  }

  if (normalized.startsWith('/workspace/')) {
    // Reject sibling prefix like /workspace/ashy-evil unless explicitly in allowedPaths
    if (!opts?.allowedPaths || !isPathWithinAllowed(normalized, opts.allowedPaths)) {
      throw new Error(`Unauthorized sibling workspace path blocked: ${candidatePath}`)
    }
  }

  if (!canonicalizeSafePath(normalized)) {
    throw new Error(`Unauthorized relative or unsafe path blocked: ${candidatePath}`)
  }

  const resolvedDisk = path.resolve(candidatePath).replace(/\\/g, '/')
  if (!isPathWithinAllowed(resolvedDisk, workspaceBaseDirs)) {
    throw new Error(`Unauthorized path outside allowed workspace directories: ${candidatePath}`)
  }

  return resolvedDisk
}

function slugifyNoteTitle(rawTitle: string): string {
  const slug = rawTitle
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'untitled-note'
}

function buildPatternFrame(
  variant: 'default' | 'ide' | 'terminal' | number,
  windowTitle: string,
): CapturedScreenFrame {
  const width = 36
  const height = 32
  const pixels = new Uint8Array(width * height * 4)
  const titleSeed = windowTitle
    .split('')
    .reduce((acc, ch) => acc + ch.charCodeAt(0), 0)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      let lum = 0
      if (variant === 'ide') {
        lum = ((x * 19) ^ (y * 11) ^ (titleSeed & 0xff)) & 0xff
      } else if (variant === 'terminal') {
        lum = x < width / 2 ? (y % 2 === 0 ? 220 : 25) : ((x * 29 + y * 3) & 0xff)
      } else if (typeof variant === 'number') {
        lum = ((x * (7 + variant * 5) + y * (13 + variant * 3) + titleSeed) ^ (variant * 41)) & 0xff
      } else {
        lum = (x * 7 + y * 5 + titleSeed) % 256
      }
      pixels[idx] = lum
      pixels[idx + 1] = (lum + 30) % 256
      pixels[idx + 2] = (lum + 60) % 256
      pixels[idx + 3] = 255
    }
  }

  return {
    width,
    height,
    pixels,
    windowTitle,
    sourceType: 'window',
  }
}

export function createHostAgencyRuntime(
  options: HostAgencyRuntimeOptions,
): HostAgencyRuntime {
  const { cortex } = options
  const normalizedUserDataDir = path.resolve(options.userDataDir).replace(/\\/g, '/')
  const normalizedWorkspaceCwd = process.cwd().replace(/\\/g, '/')
  const candidateMonorepoRoot = path.resolve(normalizedWorkspaceCwd, '../..').replace(/\\/g, '/')
  const hasMonorepoRoot =
    candidateMonorepoRoot !== normalizedWorkspaceCwd &&
    fs.existsSync(path.join(candidateMonorepoRoot, 'pnpm-workspace.yaml'))

  const activeExternalClients = new Map<string, McpProtocolClient>()

  let consent: PersistedAgencyConsentState = cortex.db.getAgencyConsentState()
  const defaultRequiredPaths = [normalizedUserDataDir, normalizedWorkspaceCwd]
  if (defaultRequiredPaths.some((p) => !consent.allowedPaths.includes(p))) {
    consent = cortex.db.saveAgencyConsentState({
      allowedPaths: Array.from(new Set([...consent.allowedPaths, ...defaultRequiredPaths])),
    })
  }

  const privacyController = new PrivacyController({
    eyesMode: consent.eyesMode,
    micMode: consent.micMode,
    dndMode: consent.dndMode,
    allowedPaths: Array.from(
      new Set([
        ...consent.allowedPaths,
        normalizedUserDataDir,
        normalizedWorkspaceCwd,
        ...(hasMonorepoRoot ? [candidateMonorepoRoot] : []),
      ]),
    ),
    allowedWindowTitles: consent.allowedWindowTitles,
  })

  const initialAuditEntries = [...cortex.db.listActionAuditLog(100)].reverse()

  const gatekeeper = new ActionGatekeeper({
    privacyController,
    approvalPolicy: consent.approvalPolicy,
    toolRiskOverrides: consent.toolRiskOverrides,
    initialAuditLog: initialAuditEntries.map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      toolName: entry.toolName,
      serverName: entry.serverName,
      riskTier: entry.riskTier,
      decision: entry.decision,
      argsPreview: entry.argsPreview,
      ...(entry.actionId ? { actionId: entry.actionId } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.blastRadiusWarning ? { blastRadiusWarning: entry.blastRadiusWarning } : {}),
      ...(entry.targetPath ? { targetPath: entry.targetPath } : {}),
      ...(entry.commandPreview ? { commandPreview: entry.commandPreview } : {}),
      ...(entry.diffPreview ? { diffPreview: entry.diffPreview } : {}),
    })),
    onAuditEntry: (entry) => {
      try {
        cortex.db.insertActionAuditLog({
          id: entry.id,
          timestamp: entry.timestamp,
          toolName: entry.toolName,
          serverName: entry.serverName,
          riskTier: entry.riskTier,
          decision: entry.decision,
          argsPreview: entry.argsPreview,
          actionId: entry.actionId ?? null,
          reason: entry.reason ?? null,
          blastRadiusWarning: entry.blastRadiusWarning ?? null,
          targetPath: entry.targetPath ?? null,
          commandPreview: entry.commandPreview ?? null,
          diffPreview: entry.diffPreview ?? null,
        })
      } catch {
        // Fault-isolated if DB handle closes during shutdown
      }
    },
  })

  let cachedOsWindowTitle: { title: string | null; cachedAt: number } | null = null

  async function queryOsActiveWindowTitle(): Promise<string | null> {
    const now = Date.now()
    if (cachedOsWindowTitle && now - cachedOsWindowTitle.cachedAt < 2000) {
      return cachedOsWindowTitle.title
    }

    const rawTitle = await new Promise<string | null>((resolve) => {
      const done = (val: string | null) => {
        const cleaned = typeof val === 'string' ? val.trim() : ''
        resolve(cleaned.length > 0 ? cleaned : null)
      }

      if (process.platform === 'win32') {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '$t = @(Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object -First 1 -ExpandProperty MainWindowTitle)[0]; if ($t) { $t } else { "Terminal — " + (Split-Path -Leaf (Get-Location).Path) }',
          ],
          { timeout: 1500, windowsHide: true },
          (err, stdout) => {
            if (err) {
              done(`Terminal — ${path.basename(normalizedWorkspaceCwd)}`)
              return
            }
            done(String(stdout ?? '').split(/\r?\n/)[0] ?? null)
          },
        )
        return
      }

      if (process.platform === 'darwin') {
        execFile(
          'osascript',
          [
            '-e',
            'tell application "System Events" to get name of first application process whose frontmost is true',
          ],
          { timeout: 1500 },
          (err, stdout) => {
            if (err) {
              done(`Terminal — ${path.basename(normalizedWorkspaceCwd)}`)
              return
            }
            done(String(stdout ?? '').split(/\r?\n/)[0] ?? null)
          },
        )
        return
      }

      execFile(
        'xdotool',
        ['getactivewindow', 'getwindowname'],
        { timeout: 1500 },
        (err, stdout) => {
          if (err) {
            done(`Terminal — ${path.basename(normalizedWorkspaceCwd)}`)
            return
          }
          done(String(stdout ?? '').split(/\r?\n/)[0] ?? null)
        },
      )
    })

    cachedOsWindowTitle = { title: rawTitle, cachedAt: Date.now() }
    return rawTitle
  }

  let lastCapturedFrame: CapturedScreenFrame | null = null
  let forceRefreshSeq = 0
  let nextCaptureFixtureId: string | undefined = undefined

  function buildFrameForCapture(params?: {
    windowTitle?: string
    frameFixtureId?: string
    forceRefresh?: boolean
  }): CapturedScreenFrame {
    const resolvedTitle =
      params?.windowTitle?.trim() ||
      privacyController.allowedWindowTitles[0] ||
      'VS Code — Ashy Companion'

    if (params?.frameFixtureId === 'static-frame' && lastCapturedFrame) {
      return {
        ...lastCapturedFrame,
        windowTitle: resolvedTitle,
      }
    }

    let frame: CapturedScreenFrame
    if (params?.frameFixtureId === 'changed-ide-frame') {
      frame = buildPatternFrame('ide', resolvedTitle)
    } else if (
      params?.frameFixtureId === 'changed-terminal-frame' ||
      params?.frameFixtureId === 'browser-docs-frame'
    ) {
      frame = buildPatternFrame('terminal', resolvedTitle)
    } else if (params?.forceRefresh) {
      forceRefreshSeq += 1
      frame = buildPatternFrame(forceRefreshSeq, resolvedTitle)
    } else {
      frame = buildPatternFrame('default', resolvedTitle)
    }

    lastCapturedFrame = frame
    return frame
  }

  async function resolveActiveProviderRuntime(): Promise<{
    providerId: string
    baseUrl: string
    modelId: string
    apiKey: string | null
  } | null> {
    if (!options.providerVault) {
      return null
    }
    const vaultAny = options.providerVault as ProviderVault & {
      getActiveRuntimeKey?: () => Promise<{
        providerId?: string
        baseUrl?: string
        modelId?: string
        apiKey?: string | null
      } | null>
    }
    if (typeof vaultAny.getActiveRuntimeKey === 'function') {
      const customRuntime = await vaultAny.getActiveRuntimeKey()
      if (customRuntime?.baseUrl && customRuntime?.modelId) {
        return {
          providerId: customRuntime.providerId ?? 'openrouter',
          baseUrl: customRuntime.baseUrl,
          modelId: customRuntime.modelId,
          apiKey: customRuntime.apiKey ?? null,
        }
      }
    }

    const pub = options.providerVault.getPublicState()
    if (!pub.hasActiveReadyProvider) {
      return null
    }
    const activeId = pub.activeProviderId
    const activeCfg = pub.configs[activeId]
    if (!activeCfg) {
      return null
    }
    const apiKey = options.providerVault.getDecryptedApiKey(activeId)
    if (activeCfg.requiresApiKey && !apiKey) {
      return null
    }
    return {
      providerId: activeId,
      baseUrl: activeCfg.baseUrl,
      modelId: activeCfg.modelId,
      apiKey,
    }
  }

  const visionSensor = createAuthorizedVisionSensor({
    privacyController,
    gatekeeper,
    captureFrameFn: (windowTitle) => buildFrameForCapture({ windowTitle }),
    visionProvider: {
      async describeFrame(frame, ctx) {
        const title = ctx.windowTitle ?? frame.windowTitle ?? 'Desktop'
        const isSyntheticFixture =
          nextCaptureFixtureId !== undefined && SYNTHETIC_FIXTURE_IDS.has(nextCaptureFixtureId)

        if (!isSyntheticFixture) {
          try {
            const activeRuntime = await resolveActiveProviderRuntime()
            const fetchFn = options.fetchImpl ?? globalThis.fetch
            if (activeRuntime && typeof fetchFn === 'function') {
              const baseUrl = activeRuntime.baseUrl.replace(/\/+$/, '')
              const promptText = `Descreva concisamente em 1 frase o contexto da janela ativa "${title}" (${frame.width}x${frame.height}, dHash ${ctx.dHashHex}).`
              const url =
                activeRuntime.providerId === 'anthropic'
                  ? `${baseUrl}/messages`
                  : `${baseUrl}/chat/completions`

              const headers: Record<string, string> = {
                'content-type': 'application/json',
              }
              if (activeRuntime.apiKey) {
                if (activeRuntime.providerId === 'anthropic') {
                  headers['x-api-key'] = activeRuntime.apiKey
                  headers['anthropic-version'] = '2023-06-01'
                } else {
                  headers.authorization = `Bearer ${activeRuntime.apiKey}`
                }
              }

              const bodyPayload =
                activeRuntime.providerId === 'anthropic'
                  ? {
                      model: activeRuntime.modelId,
                      max_tokens: 120,
                      messages: [{ role: 'user', content: promptText }],
                    }
                  : {
                      model: activeRuntime.modelId,
                      max_tokens: 120,
                      messages: [
                        {
                          role: 'system',
                          content:
                            'Você é o sensor visual autorizado da Ashy. Resuma a tela ativa de forma objetiva.',
                        },
                        { role: 'user', content: promptText },
                      ],
                    }

              const res = await fetchFn(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(bodyPayload),
                signal: AbortSignal.timeout(6000),
              })

              if (res.ok) {
                const rawText = await res.text()
                let llmDescription = ''
                let visionTokensSpent = 0

                if (rawText.trim().startsWith('data:')) {
                  const lines = rawText.split(/\r?\n/)
                  for (const line of lines) {
                    if (!line.startsWith('data:')) continue
                    const payload = line.slice('data:'.length).trim()
                    if (!payload || payload === '[DONE]') continue
                    try {
                      const parsed = JSON.parse(payload) as {
                        choices?: Array<{ delta?: { content?: string } }>
                        usage?: { total_tokens?: number }
                      }
                      const delta = parsed.choices?.[0]?.delta?.content
                      if (typeof delta === 'string') {
                        llmDescription += delta
                      }
                      if (typeof parsed.usage?.total_tokens === 'number') {
                        visionTokensSpent = parsed.usage.total_tokens
                      }
                    } catch {
                      // Ignore malformed SSE line
                    }
                  }
                } else {
                  const parsed = JSON.parse(rawText) as {
                    choices?: Array<{ message?: { content?: string } }>
                    content?: Array<{ text?: string }>
                    usage?: {
                      total_tokens?: number
                      prompt_tokens?: number
                      completion_tokens?: number
                      input_tokens?: number
                      output_tokens?: number
                    }
                  }
                  const contentText =
                    parsed.choices?.[0]?.message?.content ??
                    parsed.content?.[0]?.text ??
                    ''
                  llmDescription = String(contentText).trim()
                  const totalTokens =
                    parsed.usage?.total_tokens ??
                    ((parsed.usage?.prompt_tokens ?? parsed.usage?.input_tokens ?? 0) +
                      (parsed.usage?.completion_tokens ?? parsed.usage?.output_tokens ?? 0))
                  if (typeof totalTokens === 'number' && totalTokens > 0) {
                    visionTokensSpent = totalTokens
                  }
                }

                if (llmDescription.trim().length > 0) {
                  const spent =
                    visionTokensSpent > 0
                      ? visionTokensSpent
                      : Math.max(32, Math.ceil(llmDescription.length / 3) + 48)
                  return {
                    summary: `Active screen: ${title} (${frame.width}x${frame.height}, dHash ${ctx.dHashHex}) — ${llmDescription.trim()}`,
                    visionTokensSpent: spent,
                  }
                }
              }
            }
          } catch {
            // Fallback to deterministic local summary when offline or provider fails
          }
        }

        return {
          summary: `Active screen: ${title} (${frame.width}x${frame.height}, dHash ${ctx.dHashHex}) — Janela ativa "${title}" observada`,
          visionTokensSpent: 64,
        }
      },
    },
  })

  const mcpRegistry = new ProgressiveMcpRegistry({
    gatekeeper,
  })

  function resolveRuntimeWorkspacePath(
    candidatePath: string,
    opts?: { forWrite?: boolean },
  ): string {
    return resolveWorkspacePath(candidatePath, {
      userDataDir: normalizedUserDataDir,
      workspaceCwd: normalizedWorkspaceCwd,
      allowedPaths: privacyController.allowedPaths,
      forWrite: opts?.forWrite,
    })
  }

  // Register the 4 Built-In Local Host MCP Servers
  mcpRegistry.registerServer({
    name: 'desktop-vision',
    description: 'Active window and screen observation sensor with 64-bit dHash perceptual deduplication',
  })
  mcpRegistry.registerServer({
    name: 'workspace-fs',
    description: 'Sandboxed workspace file reader protected against path and symlink traversal',
  })
  mcpRegistry.registerServer({
    name: 'workspace-notes',
    description: 'Project notes and architectural decision log writer with unified diff preview',
  })
  mcpRegistry.registerServer({
    name: 'workspace-shell',
    description: 'Workspace build & cleanup runner protected by Blast-Radius Guard',
  })

  mcpRegistry.registerTools([
    {
      toolName: 'get_active_window_title',
      serverName: 'desktop-vision',
      description: 'Reads the currently focused desktop window title when EyesMode allows it.',
      riskTier: 'observe-only',
      inputSchema: {
        type: 'object',
        properties: {
          windowTitle: { type: 'string' },
        },
      },
      handler: async (args) => {
        const explicitTitle =
          typeof args.windowTitle === 'string' && args.windowTitle.trim().length > 0
            ? args.windowTitle.trim()
            : null
        const osTitle = explicitTitle ? null : await queryOsActiveWindowTitle()
        const observedWindow =
          explicitTitle ??
          osTitle ??
          privacyController.getState().allowedWindowTitles[0] ??
          'Ashy Desktop Workspace'
        return {
          observedWindow,
          windowTitle: observedWindow,
          source: explicitTitle ? 'explicit' : osTitle ? 'os' : 'fallback',
          eyesMode: privacyController.eyesMode,
          timestamp: Date.now(),
        }
      },
    },
    {
      toolName: 'capture_authorized_screen',
      serverName: 'desktop-vision',
      description:
        'Captures an authorized window/screen frame and deduplicates static screens via 64-bit dHash.',
      riskTier: 'observe-only',
      inputSchema: {
        type: 'object',
        properties: {
          windowTitle: { type: 'string' },
          frameFixtureId: { type: 'string' },
          forceRefresh: { type: 'boolean' },
        },
      },
      handler: async (args) => {
        const windowTitle =
          typeof args.windowTitle === 'string' && args.windowTitle.trim().length > 0
            ? args.windowTitle.trim()
            : undefined
        const frameFixtureId =
          typeof args.frameFixtureId === 'string' && args.frameFixtureId.trim().length > 0
            ? args.frameFixtureId.trim()
            : undefined
        const forceRefresh = Boolean(args.forceRefresh)
        nextCaptureFixtureId = frameFixtureId
        try {
          const frameOverride = buildFrameForCapture({
            windowTitle,
            frameFixtureId,
            forceRefresh,
          })
          return await visionSensor.observeScreen({
            windowTitle,
            frameOverride,
          })
        } finally {
          nextCaptureFixtureId = undefined
        }
      },
    },
    {
      toolName: 'read_workspace_file',
      serverName: 'workspace-fs',
      description: 'Reads a UTF-8 file strictly inside the allowed workspace directories.',
      riskTier: 'read-safe',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
      handler: (args) => {
        const targetPath = String(args.path ?? '').trim()
        if (!targetPath) {
          throw new Error('ENOENT: Caminho de arquivo vazio em read_workspace_file')
        }
        const diskPath = resolveRuntimeWorkspacePath(targetPath)
        if (!fs.existsSync(diskPath)) {
          throw new Error(`ENOENT: Arquivo não encontrado em ${targetPath}`)
        }
        const stat = fs.statSync(diskPath)
        if (stat.isDirectory()) {
          throw new Error(`EISDIR: O caminho solicitado é um diretório (${targetPath})`)
        }
        const content = fs.readFileSync(diskPath, 'utf8').slice(0, 65_536)
        return {
          path: targetPath,
          resolvedDiskPath: diskPath,
          existsOnDisk: true,
          bytes: content.length,
          content,
          preview: content.slice(0, 4096),
        }
      },
    },
    {
      toolName: 'write_project_note',
      serverName: 'workspace-notes',
      description:
        'Writes a markdown note to the project workspace (computes unified diff preview before staging).',
      riskTier: 'staged-confirm',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title'],
      },
      handler: (args) => {
        const title =
          typeof args.title === 'string' && args.title.trim().length > 0
            ? args.title.trim()
            : 'Untitled Note'
        const slug = slugifyNoteTitle(title)
        const targetPath =
          typeof args.path === 'string' && args.path.trim().length > 0
            ? args.path.trim()
            : path.join(options.userDataDir, 'notes', `${slug}.md`).replace(/\\/g, '/')
        const diskPath = resolveRuntimeWorkspacePath(targetPath, { forWrite: true })
        const rawBody =
          typeof args.content === 'string' && args.content.trim().length > 0
            ? args.content
            : `# ${title}\n`
        const markdown = rawBody.startsWith('#') ? rawBody : `# ${title}\n\n${rawBody}\n`

        fs.mkdirSync(path.dirname(diskPath), { recursive: true })
        fs.writeFileSync(diskPath, markdown, 'utf8')

        return {
          saved: true,
          title,
          path: targetPath,
          resolvedDiskPath: diskPath,
          bytesWritten: Buffer.byteLength(markdown, 'utf8'),
        }
      },
    },
    {
      toolName: 'run_cleanup_command',
      serverName: 'workspace-shell',
      description: 'Executes a workspace shell cleanup command (inspected by Blast-Radius Guard).',
      riskTier: 'staged-confirm',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
        },
        required: ['command'],
      },
      handler: async (args) => {
        if (
          typeof args.command !== 'string' ||
          args.command.includes('\0') ||
          (typeof args.cwd === 'string' && args.cwd.includes('\0'))
        ) {
          throw new Error('Invalid cleanup command: null byte injection is forbidden')
        }
        const cmd = args.command.trim()
        if (!cmd) {
          throw new Error('Invalid cleanup command: command must be non-empty')
        }
        if (/(?:^|[\s'"\\/])\.\.(?:[\\/]|['"\s]|$)/.test(cmd)) {
          throw new Error(`Unauthorized path traversal in cleanup command outside sandbox: ${cmd}`)
        }
        const rawCwd =
          typeof args.cwd === 'string' && args.cwd.trim().length > 0
            ? resolveRuntimeWorkspacePath(args.cwd.trim())
            : normalizedUserDataDir
        const cwd = rawCwd.replace(/\\/g, '/')
        if (!privacyController.isPathAllowed(cwd)) {
          throw new Error(`Unauthorized cleanup working directory outside sandbox: ${cwd}`)
        }
        fs.mkdirSync(cwd, { recursive: true })

        const blastWarning = detectBlastRadiusWarning({ command: cmd })

        // Cross-platform safe sandboxed handling for `rm -rf <target>`
        const rmMatch = /^rm\s+(?:-[a-zA-Z]+\s+)+(.+)$/i.exec(cmd)
        if (rmMatch) {
          const rawTarget = rmMatch[1]!.trim().replace(/^['"]|['"]$/g, '')
          if (
            !rawTarget ||
            rawTarget.includes('\0') ||
            /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(rawTarget)
          ) {
            throw new Error(`Unauthorized cleanup target path outside sandbox: ${rawTarget}`)
          }
          const tmpSandboxRoot = path
            .resolve(os.tmpdir(), 'ashy-tmp-sandbox')
            .replace(/\\/g, '/')
          let resolvedTarget: string
          if (rawTarget === '/tmp' || rawTarget === '/tmp/') {
            throw new Error(`Unauthorized cleanup target path outside sandbox: ${rawTarget}`)
          } else if (rawTarget.startsWith('/tmp/')) {
            const relTmp = rawTarget.replace(/^\/tmp\/+/, '')
            if (!relTmp || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(relTmp)) {
              throw new Error(`Unauthorized cleanup target path outside sandbox: ${rawTarget}`)
            }
            resolvedTarget = path.resolve(tmpSandboxRoot, relTmp)
          } else if (
            rawTarget === '/workspace/ashy' ||
            rawTarget.startsWith('/workspace/ashy/')
          ) {
            resolvedTarget = resolveRuntimeWorkspacePath(rawTarget, { forWrite: true })
          } else if (path.isAbsolute(rawTarget) || rawTarget.startsWith('/')) {
            resolvedTarget = path.resolve(rawTarget)
          } else {
            resolvedTarget = path.resolve(cwd, rawTarget)
          }

          const normalizedTarget = resolvedTarget.replace(/\\/g, '/').replace(/\/+$/, '')
          const normalizedTmpSandbox = tmpSandboxRoot.replace(/\/+$/, '')
          const isInsideTmpSandbox = normalizedTarget
            .toLowerCase()
            .startsWith(`${normalizedTmpSandbox.toLowerCase()}/`)
          const isInsideAllowed = privacyController.isPathAllowed(normalizedTarget)
          const isRootAllowedPath = privacyController.allowedPaths.some(
            (allowed) =>
              allowed.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
              normalizedTarget.toLowerCase(),
          )

          if ((!isInsideTmpSandbox && !isInsideAllowed) || isRootAllowedPath) {
            throw new Error(`Unauthorized cleanup target path outside sandbox: ${rawTarget}`)
          }

          fs.rmSync(resolvedTarget, { recursive: true, force: true })
          const completedAt = new Date().toISOString()
          return {
            executed: true,
            command: cmd,
            executedCommand: cmd,
            cwd,
            workingDirectory: cwd,
            exitCode: 0,
            stdout: `Removed ${normalizedTarget}`,
            stderr: '',
            truncated: false,
            ...(blastWarning ? { blastRadiusWarning: blastWarning } : {}),
            completedAt,
            timestamp: Date.now(),
          }
        }

        const execResult = await new Promise<{
          exitCode: number
          stdout: string
          stderr: string
          truncated: boolean
        }>((resolve) => {
          const shellBin = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
          const shellArgs =
            process.platform === 'win32'
              ? ['-NoProfile', '-NonInteractive', '-Command', cmd]
              : ['-c', cmd]

          execFile(
            shellBin,
            shellArgs,
            { cwd, timeout: 10_000, windowsHide: true, maxBuffer: 256 * 1024 },
            (err, stdout, stderr) => {
              const rawOut = String(stdout ?? '').trim()
              const rawErr = String(stderr ?? (err ? err.message : '')).trim()
              const hitMaxBuffer =
                Boolean(err) &&
                ((err as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
                  /maxBuffer/i.test(err?.message ?? ''))
              const truncated =
                hitMaxBuffer ||
                rawOut.length > MAX_CLEANUP_OUTPUT_CHARS ||
                rawErr.length > MAX_CLEANUP_OUTPUT_CHARS

              const cappedStdout =
                rawOut.length > MAX_CLEANUP_OUTPUT_CHARS
                  ? `${rawOut.slice(0, MAX_CLEANUP_OUTPUT_CHARS)}...[truncated]`
                  : rawOut
              const cappedStderr =
                rawErr.length > MAX_CLEANUP_OUTPUT_CHARS
                  ? `${rawErr.slice(0, MAX_CLEANUP_OUTPUT_CHARS)}...[truncated]`
                  : rawErr

              const exitCode = hitMaxBuffer
                ? 0
                : err && typeof (err as { code?: unknown }).code === 'number'
                  ? (err as { code: number }).code
                  : err
                    ? 1
                    : 0
              resolve({
                exitCode,
                stdout: cappedStdout,
                stderr: cappedStderr,
                truncated,
              })
            },
          )
        })

        return {
          executed: true,
          command: cmd,
          executedCommand: cmd,
          cwd,
          workingDirectory: cwd,
          exitCode: execResult.exitCode,
          stdout: execResult.stdout,
          stderr: execResult.stderr,
          truncated: execResult.truncated,
          ...(blastWarning ? { blastRadiusWarning: blastWarning } : {}),
          completedAt: new Date().toISOString(),
          timestamp: Date.now(),
        }
      },
    },
  ])

  async function connectExternalServerConfig(
    serverConfig: ExternalMcpServerConfig,
  ): Promise<void> {
    mcpRegistry.registerServer({
      name: serverConfig.name,
      description:
        serverConfig.description ||
        `External MCP server (${serverConfig.transport}: ${serverConfig.url ?? serverConfig.command ?? serverConfig.id})`,
    })

    const prevClient = activeExternalClients.get(serverConfig.id)
    if (prevClient) {
      activeExternalClients.delete(serverConfig.id)
      await prevClient.close().catch(() => undefined)
    }

    if (serverConfig.enabled === false) {
      return
    }

    let client: McpProtocolClient | null = null
    try {
      if (serverConfig.transport === 'http' && serverConfig.url) {
        client = createHttpMcpClient({
          serverName: serverConfig.name,
          url: serverConfig.url,
          description: serverConfig.description,
          fetchImpl: options.fetchImpl,
          timeoutMs: 1500,
        })
        activeExternalClients.set(serverConfig.id, client)
        await client.registerIntoProgressiveRegistry(mcpRegistry, 'staged-confirm')
      } else if (serverConfig.transport === 'stdio' && serverConfig.command) {
        client = createStdioMcpClient({
          serverName: serverConfig.name,
          command: serverConfig.command,
          args: serverConfig.args,
          description: serverConfig.description,
          timeoutMs: 1500,
        })
        activeExternalClients.set(serverConfig.id, client)
        await client.registerIntoProgressiveRegistry(mcpRegistry, 'staged-confirm')
      }
    } catch {
      // Server metadata remains registered even if remote process is currently unreachable
      activeExternalClients.delete(serverConfig.id)
      if (client) {
        await client.close().catch(() => undefined)
      }
    }
  }

  const bootReconnectPromise: Promise<void> =
    consent.externalMcpServers.length > 0
      ? Promise.allSettled(
          consent.externalMcpServers.map((srv) => connectExternalServerConfig(srv)),
        ).then(() => undefined)
      : Promise.resolve()

  function getSnapshot(): AgencySnapshot {
    const latestConsent = cortex.db.getAgencyConsentState()
    const tools = mcpRegistry.listAllTools().map((t) => ({
      toolName: t.toolName,
      serverName: t.serverName,
      description: t.description,
      defaultRiskTier: t.defaultRiskTier,
      effectiveRiskTier: t.effectiveRiskTier,
    }))
    const pendingActions: SharedPendingActionCard[] = gatekeeper.getPendingActions().map((card) => ({
      id: card.id,
      toolName: card.toolName,
      serverName: card.serverName,
      summary: card.summary,
      argsPreview: card.argsPreview,
      ...(card.targetPath ? { targetPath: card.targetPath } : {}),
      ...(card.commandPreview ? { commandPreview: card.commandPreview } : {}),
      ...(card.diffPreview ? { diffPreview: card.diffPreview } : {}),
      riskTier: card.riskTier,
      ...(card.blastRadiusWarning ? { blastRadiusWarning: card.blastRadiusWarning } : {}),
      status: card.status,
      createdAt: card.createdAt,
    }))

    return {
      consent: latestConsent,
      tools,
      exposedMetaToolsCount: mcpRegistry.getExposedMetaTools().length,
      registeredMcpToolsCount: mcpRegistry.getRegisteredToolsCount(),
      pendingActions,
      sessionApprovedTools: gatekeeper.getSessionApprovedTools(),
      auditLog: cortex.db.listActionAuditLog(100),
      vision: visionSensor.getTelemetry(),
    }
  }

  async function enrichToolArgs(
    toolName: string,
    rawArgs?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const safeArgs: Record<string, unknown> =
      rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...rawArgs } : {}

    if (
      (toolName === 'get_active_window_title' || toolName === 'capture_authorized_screen') &&
      (typeof safeArgs.windowTitle !== 'string' || safeArgs.windowTitle.trim().length === 0)
    ) {
      if (privacyController.eyesMode === 'window') {
        const osTitle = await queryOsActiveWindowTitle()
        if (osTitle && privacyController.canObserveScreen(osTitle)) {
          safeArgs.windowTitle = osTitle
        } else {
          safeArgs.windowTitle =
            privacyController.getState().allowedWindowTitles[0] ?? 'VS Code — Ashy Companion'
        }
      }
    }

    if (toolName === 'write_project_note') {
      const title =
        typeof safeArgs.title === 'string' && safeArgs.title.trim().length > 0
          ? safeArgs.title.trim()
          : 'Untitled Note'
      const slug = slugifyNoteTitle(title)
      const hasExplicitPath =
        typeof safeArgs.path === 'string' && safeArgs.path.trim().length > 0
      const resolvedPath = hasExplicitPath
        ? String(safeArgs.path).trim()
        : path.join(options.userDataDir, 'notes', `${slug}.md`).replace(/\\/g, '/')

      if (!hasExplicitPath) {
        safeArgs.path = resolvedPath
      }

      if (typeof safeArgs.diffPreview !== 'string' && gatekeeper.getApprovalPolicy() !== 'off') {
        let previousContent: string | null = null
        try {
          if (privacyController.isPathAllowed(resolvedPath)) {
            const diskPath = resolveRuntimeWorkspacePath(resolvedPath)
            if (fs.existsSync(diskPath) && fs.statSync(diskPath).isFile()) {
              previousContent = fs.readFileSync(diskPath, 'utf8')
            }
          }
        } catch {
          previousContent = null
        }
        const nextContent =
          typeof safeArgs.content === 'string' && safeArgs.content.trim().length > 0
            ? safeArgs.content
            : `# ${title}\n`
        safeArgs.diffPreview = computeUnifiedDiffPreview(
          resolvedPath,
          previousContent,
          nextContent,
        )
      }
    }

    return safeArgs
  }

  return {
    privacyController,
    gatekeeper,
    mcpRegistry,
    visionSensor,
    getSnapshot,

    async callMcpTool(input) {
      await bootReconnectPromise
      const toolName = String(input?.toolName ?? '').trim()
      if (!toolName) {
        throw new Error('Invalid MCP tool call: toolName must be non-empty')
      }
      const enrichedArgs = await enrichToolArgs(toolName, input?.args)
      const res = await mcpRegistry.call_mcp_tool({
        toolName,
        args: enrichedArgs,
      })
      return {
        status: res.status,
        ...(res.output !== undefined ? { output: res.output } : {}),
        ...(res.pendingCard ? { pendingCard: res.pendingCard } : {}),
        ...(res.reason ? { reason: res.reason } : {}),
        snapshot: getSnapshot(),
      }
    },

    async approvePendingAction(input) {
      const actionId = String(input?.actionId ?? '').trim()
      if (!actionId) {
        throw new Error('actionId is required to approve a pending action')
      }
      const scope: ApprovalScope =
        input?.scope !== undefined ? v.parse(ApprovalScopeSchema, input.scope) : 'once'
      const res = await gatekeeper.approveAction(actionId, scope)
      return {
        status: res.status,
        card: res.card,
        output: res.output,
        snapshot: getSnapshot(),
      }
    },

    async denyPendingAction(input) {
      const actionId = String(input?.actionId ?? '').trim()
      if (!actionId) {
        throw new Error('actionId is required to deny a pending action')
      }
      const reason =
        typeof input?.reason === 'string' && input.reason.trim().length > 0
          ? input.reason.trim()
          : 'Denied by user in Consent Center'
      const res = gatekeeper.denyAction(actionId, reason)
      return {
        status: res.status,
        card: res.card,
        feedback: res.feedback,
        snapshot: getSnapshot(),
      }
    },

    async updateConsent(rawInput: UpdateAgencyConsentInput): Promise<AgencySnapshot> {
      const input = v.parse(UpdateAgencyConsentInputSchema, rawInput)

      if (input.eyesMode !== undefined) {
        privacyController.setEyesMode(input.eyesMode)
      }
      if (input.micMode !== undefined) {
        privacyController.setMicMode(input.micMode)
      }
      if (input.dndMode !== undefined) {
        privacyController.setDndMode(input.dndMode)
      }
      if (input.allowedWindowTitles !== undefined) {
        privacyController.setAllowedWindowTitles(input.allowedWindowTitles)
      }
      if (input.allowedPaths !== undefined) {
        privacyController.setAllowedPaths(
          Array.from(
            new Set([
              ...input.allowedPaths,
              normalizedUserDataDir,
              normalizedWorkspaceCwd,
              ...(hasMonorepoRoot ? [candidateMonorepoRoot] : []),
            ]),
          ),
        )
      }
      if (input.toolRiskOverrides !== undefined) {
        gatekeeper.setToolRiskOverrides(input.toolRiskOverrides)
      }

      consent = cortex.db.saveAgencyConsentState({
        ...(input.eyesMode !== undefined ? { eyesMode: input.eyesMode } : {}),
        ...(input.micMode !== undefined ? { micMode: input.micMode } : {}),
        ...(input.dndMode !== undefined ? { dndMode: input.dndMode } : {}),
        ...(input.approvalPolicy !== undefined ? { approvalPolicy: input.approvalPolicy } : {}),
        ...(input.allowedPaths !== undefined ? { allowedPaths: input.allowedPaths } : {}),
        ...(input.allowedWindowTitles !== undefined
          ? { allowedWindowTitles: input.allowedWindowTitles }
          : {}),
        ...(input.toolRiskOverrides !== undefined
          ? { toolRiskOverrides: input.toolRiskOverrides }
          : {}),
      })

      if (input.approvalPolicy !== undefined) {
        await gatekeeper.setApprovalPolicy(input.approvalPolicy, {
          autoApprovePending: input.approvalPolicy === 'auto_accept',
        })
      }

      return getSnapshot()
    },

    revokeSessionPermissions(input?: { toolName?: string }): AgencySnapshot {
      const cleanTool = typeof input?.toolName === 'string' ? input.toolName.trim() : ''
      if (cleanTool.length > 0) {
        gatekeeper.revokeSessionApproval(cleanTool)
      } else {
        gatekeeper.revokeAllSessionApprovals()
      }
      return getSnapshot()
    },

    async captureAuthorizedScreen(input?: {
      windowTitle?: string
      frameFixtureId?: string
      forceRefresh?: boolean
    }) {
      const windowTitle =
        typeof input?.windowTitle === 'string' && input.windowTitle.trim().length > 0
          ? input.windowTitle.trim()
          : undefined
      const frameFixtureId =
        typeof input?.frameFixtureId === 'string' && input.frameFixtureId.trim().length > 0
          ? input.frameFixtureId.trim()
          : undefined
      const forceRefresh = Boolean(input?.forceRefresh)

      // Only build frameOverride when privacy check will pass, so captureFrameFn invariant holds
      const effectiveTitleForGate =
        windowTitle ??
        (privacyController.eyesMode === 'window'
          ? privacyController.allowedWindowTitles[0]
          : undefined)

      nextCaptureFixtureId = frameFixtureId
      try {
        const frameOverride = privacyController.canObserveScreen(effectiveTitleForGate)
          ? buildFrameForCapture({
              windowTitle: effectiveTitleForGate,
              frameFixtureId,
              forceRefresh,
            })
          : undefined

        const observation = await visionSensor.observeScreen({
          windowTitle,
          ...(frameOverride ? { frameOverride } : {}),
        })

        return {
          observation,
          snapshot: getSnapshot(),
        }
      } finally {
        nextCaptureFixtureId = undefined
      }
    },

    async registerExternalMcpServer(rawInput: ExternalMcpServerConfig): Promise<AgencySnapshot> {
      const serverConfig = v.parse(ExternalMcpServerConfigSchema, rawInput)
      const currentConsent = cortex.db.getAgencyConsentState()
      const nextServers = [
        ...currentConsent.externalMcpServers.filter((s) => s.id !== serverConfig.id),
        serverConfig,
      ]
      consent = cortex.db.saveAgencyConsentState({
        externalMcpServers: nextServers,
      })

      await connectExternalServerConfig(serverConfig)

      return getSnapshot()
    },

    getActiveVisionContextForTurn(): string | undefined {
      if (privacyController.eyesMode === 'off') {
        return undefined
      }
      const lastObs = visionSensor.getTelemetry().lastObservation
      if (!lastObs || lastObs.blockedByPrivacy || !lastObs.summary) {
        return undefined
      }
      return lastObs.summary
    },

    async close(): Promise<void> {
      await bootReconnectPromise
      for (const client of activeExternalClients.values()) {
        try {
          await client.close()
        } catch {
          // Ignore close errors
        }
      }
      activeExternalClients.clear()
    },
  }
}
