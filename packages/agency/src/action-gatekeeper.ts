import { isPathWithinAllowed, type PrivacyController } from './privacy-controller'

export type ActionRiskTier = 'observe-only' | 'read-safe' | 'staged-confirm'

export type ComputerActionsPolicy = 'ask' | 'session' | 'auto_accept' | 'off'

export type AuditDecision =
  | 'allowed'
  | 'staged'
  | 'approved'
  | 'denied'
  | 'blocked_privacy'
  | 'blocked_traversal'
  | 'revoked'

export type ApprovalScope = 'once' | 'session'

export interface PendingActionCard {
  readonly id: string
  readonly toolName: string
  readonly serverName: string
  readonly summary: string
  readonly argsPreview: string
  readonly targetPath?: string
  readonly commandPreview?: string
  readonly diffPreview?: string
  readonly riskTier: ActionRiskTier
  readonly blastRadiusWarning?: string
  status: 'pending' | 'approved' | 'denied'
  readonly createdAt: number
}

export interface ActionAuditLogEntry {
  readonly id: string
  readonly timestamp: number
  readonly toolName: string
  readonly serverName: string
  readonly riskTier: ActionRiskTier
  readonly decision: AuditDecision
  readonly argsPreview: string
  readonly actionId?: string
  readonly reason?: string
  readonly blastRadiusWarning?: string
  readonly targetPath?: string
  readonly commandPreview?: string
  readonly diffPreview?: string
}

export interface GatedToolDefinition {
  toolName: string
  serverName: string
  description: string
  riskTier: ActionRiskTier
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

export interface GatekeeperExecutionResult {
  status: 'executed' | 'staged' | 'blocked_privacy' | 'blocked_traversal' | 'blocked_policy'
  output?: unknown
  pendingCard?: PendingActionCard
  reason?: string
}

export interface ApproveActionResult {
  status: 'executed'
  card: PendingActionCard
  output: unknown
}

export interface DenyActionResult {
  status: 'denied'
  card: PendingActionCard
  feedback: string
}

export interface ActionGatekeeperOptions {
  privacyController: PrivacyController
  nowFn?: () => number
  approvalPolicy?: ComputerActionsPolicy
  toolRiskOverrides?: Record<string, ActionRiskTier>
  initialAuditLog?: readonly ActionAuditLogEntry[]
  onAuditEntry?: (entry: ActionAuditLogEntry) => void
}

type NodeFsLike = typeof import('node:fs')
type NodePathLike = typeof import('node:path')

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

const VALID_APPROVAL_POLICIES: ReadonlySet<ComputerActionsPolicy> = new Set([
  'ask',
  'session',
  'auto_accept',
  'off',
])

interface BlastRadiusRule {
  pattern: RegExp
  label: string
}

const BLAST_RADIUS_RULES: readonly BlastRadiusRule[] = [
  {
    pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*|--no-preserve-root|--recursive|--force)/i,
    label: 'Destructive file deletion command (rm -rf)',
  },
  {
    pattern: /\bformat\s+([a-zA-Z]:|\/)/i,
    label: 'Disk format command (format)',
  },
  {
    pattern: /\bdel\s+\/[fqs]/i,
    label: 'Forced file deletion command (del /f /q /s)',
  },
  {
    pattern: /\b(rd|rmdir)\s+\/[sq]/i,
    label: 'Recursive directory removal (rmdir /s)',
  },
  {
    pattern: /\b(shutdown|reboot|poweroff|halt)\b/i,
    label: 'System power/shutdown command (shutdown/reboot)',
  },
  {
    pattern: /\b(mkfs|fdisk|dd\s+if=)\b/i,
    label: 'Low-level disk modification (mkfs/fdisk/dd)',
  },
  {
    pattern: /\bRemove-Item\b.*-(Recurse|Force)/i,
    label: 'Recursive PowerShell deletion (Remove-Item -Recurse/-Force)',
  },
  {
    pattern: /\b(DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE\s+TABLE)\b/i,
    label: 'Destructive SQL DDL operation (DROP/TRUNCATE)',
  },
]

const PATH_ARG_KEYS: ReadonlySet<string> = new Set([
  'path',
  'paths',
  'filePath',
  'filepath',
  'filePaths',
  'targetPath',
  'dir',
  'directory',
  'folder',
  'cwd',
  'file',
  'files',
  'uri',
  'uris',
  'source',
  'sourcePath',
  'destination',
  'destPath',
])

/**
 * Checks whether a target path or filename refers to a sensitive host credential,
 * database, configuration, or private key file that must never be accessed by MCP tools.
 */
export function isSensitiveHostPath(targetPath: string): boolean {
  if (typeof targetPath !== 'string') return false
  const normalized = targetPath
    .replace(/\\/g, '/')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .toLowerCase()
  if (!normalized) return false

  if (
    normalized === '.git/config' ||
    normalized.endsWith('/.git/config') ||
    normalized.includes('/.git/config/')
  ) {
    return true
  }

  const segments = normalized.split('/').filter(Boolean)
  const basename = segments[segments.length - 1] ?? normalized

  const checkSegment = (seg: string): boolean => {
    if (!seg) return false
    if (seg === '.master.key' || seg.startsWith('.master.key')) return true
    if (seg.includes('.secrets.json')) return true
    if (seg === 'voice-settings.json' || seg.startsWith('voice-settings.json')) return true
    if (seg === 'providers.json' || seg.startsWith('providers.json')) return true
    if (seg === 'stage-preferences.json' || seg.startsWith('stage-preferences.json')) return true
    if (seg === 'ashy.db' || seg.startsWith('ashy.db')) return true
    if (seg.includes('.ashy-soul')) return true
    if ((seg === '.env' || seg.startsWith('.env.')) && seg !== '.env.example') return true
    if (seg.includes('id_rsa') || seg.includes('id_ed25519')) return true
    if (seg.endsWith('.pem') || seg.endsWith('.key')) return true
    return false
  }

  if (checkSegment(basename)) {
    return true
  }
  for (const seg of segments) {
    if (checkSegment(seg)) {
      return true
    }
  }
  return false
}

function serializeArgsPreview(args: Record<string, unknown>, maxLen = 240): string {
  try {
    const raw = JSON.stringify(args)
    if (!raw) return '{}'
    return raw.length > maxLen ? `${raw.slice(0, maxLen - 3)}...` : raw
  } catch {
    return '[unserializable-args]'
  }
}

function collectStrings(value: unknown, bucket: string[] = []): string[] {
  if (typeof value === 'string') {
    bucket.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, bucket)
    }
  } else if (value !== null && typeof value === 'object') {
    for (const val of Object.values(value as Record<string, unknown>)) {
      collectStrings(val, bucket)
    }
  }
  return bucket
}

/**
 * Inspects tool arguments for destructive command patterns (Blast-Radius Guard).
 */
export function detectBlastRadiusWarning(args: Record<string, unknown>): string | undefined {
  const strings = collectStrings(args)
  for (const str of strings) {
    for (const rule of BLAST_RADIUS_RULES) {
      if (rule.pattern.test(str)) {
        return `Blast-Radius Guard: ${rule.label} detected in "${str.slice(0, 80)}"`
      }
    }
  }
  return undefined
}

/**
 * Produces a unified diff preview (`--- a/...`, `+++ b/...`, `-old`, `+new`)
 * for staged file/note creation or modification cards.
 */
export function computeUnifiedDiffPreview(
  targetPath: string,
  previousContent: string | null | undefined,
  nextContent: string
): string {
  const normalizedPath = (targetPath || 'workspace/file')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')

  const prevLines =
    typeof previousContent === 'string' && previousContent.length > 0
      ? previousContent.replace(/\r\n/g, '\n').split('\n')
      : []
  const nextLines = (nextContent ?? '').replace(/\r\n/g, '\n').split('\n')

  const header = [
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    `@@ -${prevLines.length > 0 ? 1 : 0},${prevLines.length} +1,${nextLines.length} @@`,
  ]

  const body: string[] = []
  const maxLines = Math.max(prevLines.length, nextLines.length)

  for (let i = 0; i < maxLines; i++) {
    const oldLine = i < prevLines.length ? prevLines[i] : undefined
    const newLine = i < nextLines.length ? nextLines[i] : undefined

    if (oldLine !== undefined && newLine !== undefined) {
      if (oldLine === newLine) {
        body.push(` ${oldLine}`)
      } else {
        body.push(`-${oldLine}`)
        body.push(`+${newLine}`)
      }
    } else if (oldLine !== undefined) {
      body.push(`-${oldLine}`)
    } else if (newLine !== undefined) {
      body.push(`+${newLine}`)
    }
  }

  return [...header, ...body].join('\n')
}

function extractCandidatePaths(value: unknown, bucket: string[] = []): string[] {
  if (value === null || typeof value !== 'object') {
    return bucket
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      extractCandidatePaths(item, bucket)
    }
    return bucket
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (PATH_ARG_KEYS.has(key)) {
      if (typeof val === 'string') {
        bucket.push(val)
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === 'string') {
            bucket.push(item)
          }
        }
      }
    } else if (val !== null && typeof val === 'object') {
      extractCandidatePaths(val, bucket)
    }
  }
  return bucket
}

function deriveActionPreviews(
  toolName: string,
  safeArgs: Record<string, unknown>,
  candidatePaths: readonly string[]
): {
  targetPath?: string
  commandPreview?: string
  diffPreview?: string
} {
  let targetPath: string | undefined = candidatePaths[0]
  if (!targetPath && typeof safeArgs.title === 'string' && safeArgs.title.trim().length > 0) {
    if (
      typeof safeArgs.content === 'string' ||
      toolName.toLowerCase().includes('note') ||
      toolName.toLowerCase().includes('write')
    ) {
      const slug = safeArgs.title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
      targetPath = `notes/${slug || 'note'}.md`
    }
  }

  const commandPreview =
    typeof safeArgs.command === 'string' && safeArgs.command.trim().length > 0
      ? safeArgs.command.trim()
      : typeof safeArgs.cmd === 'string' && safeArgs.cmd.trim().length > 0
        ? safeArgs.cmd.trim()
        : typeof safeArgs.commandPreview === 'string' && safeArgs.commandPreview.trim().length > 0
          ? safeArgs.commandPreview.trim()
          : undefined

  let diffPreview: string | undefined
  if (typeof safeArgs.diffPreview === 'string' && safeArgs.diffPreview.trim().length > 0) {
    diffPreview = safeArgs.diffPreview
  } else if (typeof safeArgs.content === 'string') {
    const prev = typeof safeArgs.previousContent === 'string' ? safeArgs.previousContent : null
    diffPreview = computeUnifiedDiffPreview(targetPath ?? 'workspace/note.md', prev, safeArgs.content)
  } else if (
    typeof safeArgs.title === 'string' &&
    safeArgs.title.trim().length > 0 &&
    (toolName.toLowerCase().includes('note') || toolName.toLowerCase().includes('write'))
  ) {
    diffPreview = computeUnifiedDiffPreview(
      targetPath ?? 'notes/note.md',
      null,
      `# ${safeArgs.title.trim()}\n`
    )
  }

  return {
    ...(targetPath ? { targetPath } : {}),
    ...(commandPreview ? { commandPreview } : {}),
    ...(diffPreview ? { diffPreview } : {}),
  }
}

export class ActionGatekeeper {
  private readonly privacyController: PrivacyController
  private readonly nowFn: () => number
  private readonly onAuditEntry?: (entry: ActionAuditLogEntry) => void
  private approvalPolicy: ComputerActionsPolicy
  private readonly toolRiskOverrides = new Map<string, ActionRiskTier>()
  private readonly tools = new Map<string, GatedToolDefinition>()
  private readonly pendingActions = new Map<
    string,
    {
      card: PendingActionCard
      tool: GatedToolDefinition
      args: Record<string, unknown>
    }
  >()
  private readonly sessionApprovedTools = new Set<string>()
  private readonly auditLog: ActionAuditLogEntry[] = []
  private idCounter = 0

  constructor(options: ActionGatekeeperOptions) {
    this.privacyController = options.privacyController
    this.nowFn = options.nowFn ?? (() => Date.now())
    this.onAuditEntry = options.onAuditEntry
    this.approvalPolicy =
      options.approvalPolicy && VALID_APPROVAL_POLICIES.has(options.approvalPolicy)
        ? options.approvalPolicy
        : 'ask'

    if (options.toolRiskOverrides) {
      this.setToolRiskOverrides(options.toolRiskOverrides)
    }

    if (options.initialAuditLog) {
      for (const item of options.initialAuditLog) {
        if (!item || typeof item.id !== 'string') continue
        this.auditLog.push(
          Object.freeze({
            id: item.id,
            timestamp: item.timestamp,
            toolName: item.toolName,
            serverName: item.serverName,
            riskTier: item.riskTier,
            decision: item.decision,
            argsPreview: item.argsPreview,
            ...(item.actionId ? { actionId: item.actionId } : {}),
            ...(item.reason ? { reason: item.reason } : {}),
            ...(item.blastRadiusWarning ? { blastRadiusWarning: item.blastRadiusWarning } : {}),
            ...(item.targetPath ? { targetPath: item.targetPath } : {}),
            ...(item.commandPreview ? { commandPreview: item.commandPreview } : {}),
            ...(item.diffPreview ? { diffPreview: item.diffPreview } : {}),
          })
        )
      }
    }
  }

  private nextId(prefix: string): string {
    this.idCounter += 1
    return `${prefix}_${this.nowFn()}_${this.idCounter}`
  }

  private recordAudit(entry: Omit<ActionAuditLogEntry, 'id' | 'timestamp'>): ActionAuditLogEntry {
    const frozen = Object.freeze({
      id: this.nextId('audit'),
      timestamp: this.nowFn(),
      ...entry,
    })
    this.auditLog.push(frozen)
    this.onAuditEntry?.(frozen)
    return frozen
  }

  recordAuditEntry(entry: Omit<ActionAuditLogEntry, 'id' | 'timestamp'>): ActionAuditLogEntry {
    return this.recordAudit(entry)
  }

  getApprovalPolicy(): ComputerActionsPolicy {
    return this.approvalPolicy
  }

  async setApprovalPolicy(
    policy: ComputerActionsPolicy,
    options?: { autoApprovePending?: boolean }
  ): Promise<ApproveActionResult[]> {
    if (!VALID_APPROVAL_POLICIES.has(policy)) {
      throw new Error(`Invalid approvalPolicy: ${String(policy)}`)
    }
    this.approvalPolicy = policy
    if (policy === 'auto_accept' && options?.autoApprovePending) {
      return this.autoApproveAllPendingActions()
    }
    return []
  }

  async autoApproveAllPendingActions(): Promise<ApproveActionResult[]> {
    const pendingIds = Array.from(this.pendingActions.entries())
      .filter(([, entry]) => entry.card.status === 'pending')
      .map(([id]) => id)

    const results: ApproveActionResult[] = []
    for (const id of pendingIds) {
      const res = await this.approveAction(id, 'once')
      results.push(res)
    }
    return results
  }

  setToolRiskTier(toolName: string, riskTier: ActionRiskTier): void {
    const clean = toolName.trim()
    if (!clean) {
      throw new Error('toolName must be non-empty')
    }
    if (!VALID_RISK_TIERS.has(riskTier)) {
      throw new Error(`Invalid riskTier: ${String(riskTier)}`)
    }
    this.toolRiskOverrides.set(clean, riskTier)
  }

  getToolRiskTier(toolName: string): ActionRiskTier | undefined {
    const clean = toolName.trim()
    return this.toolRiskOverrides.get(clean) ?? this.tools.get(clean)?.riskTier
  }

  getToolRiskOverrides(): Record<string, ActionRiskTier> {
    return Object.fromEntries(this.toolRiskOverrides.entries())
  }

  setToolRiskOverrides(overrides: Record<string, ActionRiskTier>): void {
    this.toolRiskOverrides.clear()
    if (!overrides || typeof overrides !== 'object') return
    for (const [toolName, tier] of Object.entries(overrides)) {
      const clean = toolName.trim()
      if (clean && VALID_RISK_TIERS.has(tier)) {
        this.toolRiskOverrides.set(clean, tier)
      }
    }
  }

  getSessionApprovedTools(): string[] {
    return Array.from(this.sessionApprovedTools)
  }

  private getSessionApprovalKey(toolName: string, args: Record<string, unknown>): string {
    if (toolName === 'run_cleanup_command') {
      return `run_cleanup_command:${JSON.stringify(args)}`
    }
    return toolName
  }

  revokeSessionApproval(toolName: string): void {
    const clean = toolName.trim()
    this.sessionApprovedTools.delete(clean)
    for (const key of Array.from(this.sessionApprovedTools)) {
      if (key.startsWith(`${clean}:`)) {
        this.sessionApprovedTools.delete(key)
      }
    }
    const tool = this.tools.get(clean)
    this.recordAudit({
      toolName: clean || '*',
      serverName: tool?.serverName ?? 'consent-center',
      riskTier: this.getToolRiskTier(clean) ?? tool?.riskTier ?? 'staged-confirm',
      decision: 'revoked',
      argsPreview: '{}',
      reason: `Session approval revoked for tool "${clean}"`,
    })
  }

  revokeAllSessionApprovals(): void {
    const count = this.sessionApprovedTools.size
    this.sessionApprovedTools.clear()
    this.recordAudit({
      toolName: '*',
      serverName: 'consent-center',
      riskTier: 'staged-confirm',
      decision: 'revoked',
      argsPreview: '{}',
      reason: `Revoked all session tool approvals (${count} cleared)`,
    })
  }

  registerTool(definition: GatedToolDefinition): void {
    if (!definition.toolName || definition.toolName.trim().length === 0) {
      throw new Error('Tool name must be non-empty')
    }
    this.tools.set(definition.toolName, { ...definition })
  }

  unregisterTool(toolName: string): void {
    this.tools.delete(toolName)
    this.sessionApprovedTools.delete(toolName)
    for (const key of Array.from(this.sessionApprovedTools)) {
      if (key.startsWith(`${toolName}:`)) {
        this.sessionApprovedTools.delete(key)
      }
    }
  }

  getRegisteredTool(toolName: string): GatedToolDefinition | undefined {
    return this.tools.get(toolName)
  }

  getPendingActions(): PendingActionCard[] {
    return Array.from(this.pendingActions.values())
      .filter((entry) => entry.card.status === 'pending')
      .map((entry) => Object.freeze({ ...entry.card }))
  }

  getAuditLog(): readonly ActionAuditLogEntry[] {
    return [...this.auditLog]
  }

  isPathAllowed(candidatePath: string): boolean {
    if (isSensitiveHostPath(candidatePath)) {
      return false
    }
    return this.isPathAllowedWithSymlinkGuard(candidatePath)
  }

  private isPathAllowedWithSymlinkGuard(candidatePath: string): boolean {
    if (isSensitiveHostPath(candidatePath)) {
      return false
    }
    if (!this.privacyController.isPathAllowed(candidatePath)) {
      return false
    }

    const fs = getBuiltinModule<NodeFsLike>('node:fs')
    const pathMod = getBuiltinModule<NodePathLike>('node:path')
    if (!fs || !pathMod) {
      return true
    }

    try {
      const expandedAllowed: string[] = [...this.privacyController.allowedPaths]
      for (const allowed of this.privacyController.allowedPaths) {
        try {
          if (fs.existsSync(allowed)) {
            expandedAllowed.push(fs.realpathSync(allowed))
          }
        } catch {
          // Ignore non-existent virtual allowed path
        }
      }

      let lstat: ReturnType<NodeFsLike['lstatSync']> | null = null
      try {
        lstat = fs.lstatSync(candidatePath)
      } catch {
        lstat = null
      }

      if (lstat) {
        try {
          const realCandidate = fs.realpathSync(candidatePath)
          if (isSensitiveHostPath(realCandidate)) {
            return false
          }
          return isPathWithinAllowed(realCandidate, expandedAllowed)
        } catch {
          if (lstat.isSymbolicLink()) {
            const linkTarget = fs.readlinkSync(candidatePath)
            const resolvedTarget = pathMod.resolve(pathMod.dirname(candidatePath), linkTarget)
            if (isSensitiveHostPath(resolvedTarget)) {
              return false
            }
            return isPathWithinAllowed(resolvedTarget, expandedAllowed)
          }
          return false
        }
      }

      const parentDir = pathMod.dirname(candidatePath)
      if (parentDir && parentDir !== candidatePath && fs.existsSync(parentDir)) {
        const realParent = fs.realpathSync(parentDir)
        const realCandidate = pathMod.join(realParent, pathMod.basename(candidatePath))
        if (isSensitiveHostPath(realCandidate)) {
          return false
        }
        return isPathWithinAllowed(realCandidate, expandedAllowed)
      }
    } catch {
      // If OS FS inspection is unavailable for virtual test paths, rely on lexical check above
    }

    return true
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<GatekeeperExecutionResult> {
    const tool = this.tools.get(toolName)
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`)
    }

    const safeArgs = args && typeof args === 'object' ? args : {}
    const argsPreview = serializeArgsPreview(safeArgs)
    const blastWarning = detectBlastRadiusWarning(safeArgs)
    const baseTier: ActionRiskTier = this.toolRiskOverrides.get(tool.toolName) ?? tool.riskTier
    const effectiveTier: ActionRiskTier = blastWarning ? 'staged-confirm' : baseTier

    // 1. Check Privacy Shield / Screen Observation for 'observe-only'
    if (tool.riskTier === 'observe-only' || baseTier === 'observe-only') {
      const windowTitle =
        typeof safeArgs.windowTitle === 'string'
          ? safeArgs.windowTitle
          : typeof safeArgs.title === 'string'
            ? safeArgs.title
            : undefined

      if (!this.privacyController.canObserveScreen(windowTitle)) {
        const reason = `Observation blocked by PrivacyController (eyesMode=${this.privacyController.eyesMode})`
        this.recordAudit({
          toolName: tool.toolName,
          serverName: tool.serverName,
          riskTier: effectiveTier,
          decision: 'blocked_privacy',
          argsPreview,
          reason,
        })
        return {
          status: 'blocked_privacy',
          reason,
        }
      }
    }

    // 2. Check Path Traversal, Symlink Escape & Allowed Paths for 'read-safe' and 'staged-confirm'
    const candidatePaths = extractCandidatePaths(safeArgs)
    const previews = deriveActionPreviews(tool.toolName, safeArgs, candidatePaths)

    const requiresTargetPath =
      tool.toolName === 'read_workspace_file' ||
      tool.toolName === 'fs_read_file' ||
      tool.serverName === 'workspace-fs' ||
      tool.serverName === 'fs-mcp' ||
      Object.keys(safeArgs).some((k) => PATH_ARG_KEYS.has(k))

    if (
      (tool.riskTier === 'read-safe' || baseTier === 'read-safe') &&
      requiresTargetPath &&
      (candidatePaths.length === 0 || candidatePaths.some((p) => !p.trim()))
    ) {
      const reason = `Missing target path for read-safe tool "${tool.toolName}"`
      this.recordAudit({
        toolName: tool.toolName,
        serverName: tool.serverName,
        riskTier: effectiveTier,
        decision: 'blocked_traversal',
        argsPreview,
        reason,
        ...previews,
      })
      return {
        status: 'blocked_traversal',
        reason,
      }
    }

    if (candidatePaths.length > 0) {
      for (const candidatePath of candidatePaths) {
        if (!this.isPathAllowedWithSymlinkGuard(candidatePath)) {
          const reason = `Path traversal or unauthorized path blocked: "${candidatePath}"`
          this.recordAudit({
            toolName: tool.toolName,
            serverName: tool.serverName,
            riskTier: effectiveTier,
            decision: 'blocked_traversal',
            argsPreview,
            reason,
            ...previews,
          })
          return {
            status: 'blocked_traversal',
            reason,
          }
        }
      }
    }

    // 3. Global Policy 'off': block any non-observe-only action
    if (this.approvalPolicy === 'off' && effectiveTier !== 'observe-only') {
      const reason = 'Computer actions disabled by policy (off)'
      this.recordAudit({
        toolName: tool.toolName,
        serverName: tool.serverName,
        riskTier: effectiveTier,
        decision: 'denied',
        argsPreview,
        reason,
        ...(blastWarning ? { blastRadiusWarning: blastWarning } : {}),
        ...previews,
      })
      return {
        status: 'blocked_policy',
        reason,
      }
    }

    // 4. Global Policy 'auto_accept' ("Modo Não Pergunte"): auto-approve & execute immediately
    if (this.approvalPolicy === 'auto_accept') {
      const output = await tool.handler(safeArgs)
      this.recordAudit({
        toolName: tool.toolName,
        serverName: tool.serverName,
        riskTier: effectiveTier,
        decision: 'allowed',
        argsPreview,
        reason: 'Auto-approved by user policy (auto_accept)',
        ...(blastWarning ? { blastRadiusWarning: blastWarning } : {}),
        ...previews,
      })
      return {
        status: 'executed',
        output,
      }
    }

    // 5. Staged-confirm flow ('ask' or 'session' mode)
    if (effectiveTier === 'staged-confirm') {
      const sessionApprovalKey = this.getSessionApprovalKey(tool.toolName, safeArgs)
      const canAutoApproveFromSession =
        !blastWarning &&
        (this.sessionApprovedTools.has(sessionApprovalKey) ||
          (tool.toolName !== 'run_cleanup_command' && this.sessionApprovedTools.has(tool.toolName)))

      if (!canAutoApproveFromSession) {
        const cardId = this.nextId('action')
        const card: PendingActionCard = {
          id: cardId,
          toolName: tool.toolName,
          serverName: tool.serverName,
          summary: `${tool.serverName}/${tool.toolName}: ${tool.description}`,
          argsPreview,
          ...previews,
          riskTier: 'staged-confirm',
          ...(blastWarning ? { blastRadiusWarning: blastWarning } : {}),
          status: 'pending',
          createdAt: this.nowFn(),
        }

        this.pendingActions.set(cardId, {
          card,
          tool,
          args: { ...safeArgs },
        })

        this.recordAudit({
          toolName: tool.toolName,
          serverName: tool.serverName,
          riskTier: 'staged-confirm',
          decision: 'staged',
          argsPreview,
          actionId: cardId,
          ...(blastWarning ? { blastRadiusWarning: blastWarning } : {}),
          ...previews,
        })

        return {
          status: 'staged',
          pendingCard: Object.freeze({ ...card }),
        }
      }
    }

    // 6. Allowed immediately ('observe-only', 'read-safe', or session-approved without blast warning)
    const output = await tool.handler(safeArgs)
    this.recordAudit({
      toolName: tool.toolName,
      serverName: tool.serverName,
      riskTier: effectiveTier,
      decision: 'allowed',
      argsPreview,
      ...previews,
    })

    return {
      status: 'executed',
      output,
    }
  }

  async approveAction(
    actionId: string,
    scope: ApprovalScope = 'once'
  ): Promise<ApproveActionResult> {
    if (this.approvalPolicy === 'off') {
      throw new Error(
        `Cannot approve action ${actionId}: computer actions are disabled by policy (off)`
      )
    }
    const pending = this.pendingActions.get(actionId)
    if (!pending) {
      throw new Error(`Pending action not found: ${actionId}`)
    }
    if (pending.card.status !== 'pending') {
      throw new Error(
        `Cannot approve action ${actionId}: current status is "${pending.card.status}"`
      )
    }

    const effectiveScope: ApprovalScope =
      scope === 'session' || this.approvalPolicy === 'session' ? 'session' : 'once'

    const output = await pending.tool.handler(pending.args)

    pending.card.status = 'approved'

    if (effectiveScope === 'session' && !pending.card.blastRadiusWarning) {
      this.sessionApprovedTools.add(
        this.getSessionApprovalKey(pending.tool.toolName, pending.args)
      )
    }

    this.recordAudit({
      toolName: pending.tool.toolName,
      serverName: pending.tool.serverName,
      riskTier: pending.card.riskTier,
      decision: 'approved',
      argsPreview: pending.card.argsPreview,
      actionId,
      reason: `Approved by user (scope=${effectiveScope})`,
      ...(pending.card.blastRadiusWarning
        ? { blastRadiusWarning: pending.card.blastRadiusWarning }
        : {}),
      ...(pending.card.targetPath ? { targetPath: pending.card.targetPath } : {}),
      ...(pending.card.commandPreview ? { commandPreview: pending.card.commandPreview } : {}),
      ...(pending.card.diffPreview ? { diffPreview: pending.card.diffPreview } : {}),
    })

    return {
      status: 'executed',
      card: Object.freeze({ ...pending.card }),
      output,
    }
  }

  denyAction(actionId: string, reason = 'Denied by user'): DenyActionResult {
    const pending = this.pendingActions.get(actionId)
    if (!pending) {
      throw new Error(`Pending action not found: ${actionId}`)
    }
    if (pending.card.status !== 'pending') {
      throw new Error(
        `Cannot deny action ${actionId}: current status is "${pending.card.status}"`
      )
    }

    pending.card.status = 'denied'
    const cleanReason = reason.trim().length > 0 ? reason.trim() : 'Denied by user'

    this.recordAudit({
      toolName: pending.tool.toolName,
      serverName: pending.tool.serverName,
      riskTier: pending.card.riskTier,
      decision: 'denied',
      argsPreview: pending.card.argsPreview,
      actionId,
      reason: cleanReason,
      ...(pending.card.blastRadiusWarning
        ? { blastRadiusWarning: pending.card.blastRadiusWarning }
        : {}),
      ...(pending.card.targetPath ? { targetPath: pending.card.targetPath } : {}),
      ...(pending.card.commandPreview ? { commandPreview: pending.card.commandPreview } : {}),
      ...(pending.card.diffPreview ? { diffPreview: pending.card.diffPreview } : {}),
    })

    return {
      status: 'denied',
      card: Object.freeze({ ...pending.card }),
      feedback: `Action "${pending.tool.toolName}" on server "${pending.tool.serverName}" was cancelled by the user: ${cleanReason}. Do not retry without explicit user request.`,
    }
  }
}

export function createActionGatekeeper(options: ActionGatekeeperOptions): ActionGatekeeper {
  return new ActionGatekeeper(options)
}
