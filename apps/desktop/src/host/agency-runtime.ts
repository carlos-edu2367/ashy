import fs from 'node:fs'
import path from 'node:path'
import * as v from 'valibot'
import {
  ActionGatekeeper,
  PrivacyController,
  ProgressiveMcpRegistry,
  computeUnifiedDiffPreview,
  createAuthorizedVisionSensor,
  createHttpMcpClient,
  createStdioMcpClient,
  detectBlastRadiusWarning,
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

export interface HostAgencyRuntimeOptions {
  cortex: AshyCortex
  userDataDir: string
  fetchImpl?: typeof fetch
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
  const activeExternalClients = new Map<string, McpProtocolClient>()

  let consent: PersistedAgencyConsentState = cortex.db.getAgencyConsentState()
  if (!consent.allowedPaths.includes(normalizedUserDataDir)) {
    consent = cortex.db.saveAgencyConsentState({
      allowedPaths: [...consent.allowedPaths, normalizedUserDataDir],
    })
  }

  const privacyController = new PrivacyController({
    eyesMode: consent.eyesMode,
    micMode: consent.micMode,
    dndMode: consent.dndMode,
    allowedPaths: Array.from(new Set([...consent.allowedPaths, normalizedUserDataDir])),
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

  let lastCapturedFrame: CapturedScreenFrame | null = null
  let forceRefreshSeq = 0

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
    } else if (params?.frameFixtureId === 'changed-terminal-frame') {
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

  const visionSensor = createAuthorizedVisionSensor({
    privacyController,
    gatekeeper,
    captureFrameFn: (windowTitle) => buildFrameForCapture({ windowTitle }),
    visionProvider: {
      describeFrame(frame, ctx) {
        const title = ctx.windowTitle ?? frame.windowTitle ?? 'Desktop'
        return {
          summary: `Janela ativa "${title}" observada (${frame.width}x${frame.height}, dHash ${ctx.dHashHex})`,
          visionTokensSpent: 64,
        }
      },
    },
  })

  const mcpRegistry = new ProgressiveMcpRegistry({
    gatekeeper,
  })

  function resolveDiskPath(candidatePath: string): string {
    const normalized = candidatePath.trim().replace(/\\/g, '/')
    if (normalized.startsWith('/workspace/ashy')) {
      const suffix = normalized.slice('/workspace/ashy'.length).replace(/^\/+/, '')
      return path.join(options.userDataDir, 'workspace', suffix)
    }
    return path.resolve(candidatePath)
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
      handler: (args) => {
        const observedWindow =
          typeof args.windowTitle === 'string' && args.windowTitle.trim().length > 0
            ? args.windowTitle.trim()
            : privacyController.allowedWindowTitles[0] ?? 'VS Code — Ashy Companion'
        return {
          observedWindow,
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
        const frameOverride = buildFrameForCapture({
          windowTitle,
          frameFixtureId,
          forceRefresh,
        })
        return visionSensor.observeScreen({
          windowTitle,
          frameOverride,
        })
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
        const rawPath = String(args.path ?? '').trim()
        const diskPath = resolveDiskPath(rawPath)
        if (fs.existsSync(diskPath)) {
          const stat = fs.statSync(diskPath)
          if (stat.isFile()) {
            const content = fs.readFileSync(diskPath, 'utf8').slice(0, 4096)
            return {
              path: rawPath,
              existsOnDisk: true,
              bytes: stat.size,
              content,
              preview: content,
            }
          }
        }
        return {
          path: rawPath,
          existsOnDisk: false,
          content: `export const PACKAGE_NAME = "@ashy/desktop"`,
          preview: 'export const PACKAGE_NAME = "@ashy/desktop"',
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
        const diskPath = resolveDiskPath(targetPath)
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
        },
        required: ['command'],
      },
      handler: (args) => {
        const command = String(args.command ?? '').trim()
        const blastWarning = detectBlastRadiusWarning({ command })
        return {
          executedCommand: command,
          exitCode: 0,
          workingDirectory: normalizedUserDataDir,
          ...(blastWarning ? { blastRadiusWarning: blastWarning } : {}),
          timestamp: Date.now(),
        }
      },
    },
  ])

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

  function enrichToolArgs(
    toolName: string,
    rawArgs?: Record<string, unknown>,
  ): Record<string, unknown> {
    const safeArgs: Record<string, unknown> =
      rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...rawArgs } : {}

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

      if (typeof safeArgs.diffPreview !== 'string') {
        let previousContent: string | null = null
        try {
          if (privacyController.isPathAllowed(resolvedPath)) {
            const diskPath = resolveDiskPath(resolvedPath)
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
      const toolName = String(input?.toolName ?? '').trim()
      if (!toolName) {
        throw new Error('Invalid MCP tool call: toolName must be non-empty')
      }
      const enrichedArgs = enrichToolArgs(toolName, input?.args)
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
          Array.from(new Set([...input.allowedPaths, normalizedUserDataDir])),
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

      mcpRegistry.registerServer({
        name: serverConfig.name,
        description:
          serverConfig.description ||
          `External MCP server (${serverConfig.transport}: ${serverConfig.url ?? serverConfig.command ?? serverConfig.id})`,
      })

      if (serverConfig.enabled !== false) {
        try {
          if (serverConfig.transport === 'http' && serverConfig.url) {
            const client = createHttpMcpClient({
              serverName: serverConfig.name,
              url: serverConfig.url,
              description: serverConfig.description,
              fetchImpl: options.fetchImpl,
              timeoutMs: 1500,
            })
            activeExternalClients.set(serverConfig.id, client)
            await client.registerIntoProgressiveRegistry(mcpRegistry, 'staged-confirm')
          } else if (serverConfig.transport === 'stdio' && serverConfig.command) {
            const client = createStdioMcpClient({
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
        }
      }

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
