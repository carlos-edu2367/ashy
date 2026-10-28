import { type PrivacyController } from './privacy-controller'

export type ActionRiskTier = 'observe-only' | 'read-safe' | 'staged-confirm'

export type AuditDecision =
  | 'allowed'
  | 'staged'
  | 'approved'
  | 'denied'
  | 'blocked_privacy'
  | 'blocked_traversal'

export type ApprovalScope = 'once' | 'session'

export interface PendingActionCard {
  readonly id: string
  readonly toolName: string
  readonly serverName: string
  readonly summary: string
  readonly argsPreview: string
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
}

export interface GatedToolDefinition {
  toolName: string
  serverName: string
  description: string
  riskTier: ActionRiskTier
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

export interface GatekeeperExecutionResult {
  status: 'executed' | 'staged' | 'blocked_privacy' | 'blocked_traversal'
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
}

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

export class ActionGatekeeper {
  private readonly privacyController: PrivacyController
  private readonly nowFn: () => number
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
    return frozen
  }

  registerTool(definition: GatedToolDefinition): void {
    if (!definition.toolName || definition.toolName.trim().length === 0) {
      throw new Error('Tool name must be non-empty')
    }
    this.tools.set(definition.toolName, { ...definition })
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

    // 1. Check Privacy Shield / Screen Observation for 'observe-only'
    if (tool.riskTier === 'observe-only') {
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
          riskTier: tool.riskTier,
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

    // 2. Check Path Traversal & Allowed Paths for 'read-safe' (including nested or array paths)
    const candidatePaths = extractCandidatePaths(safeArgs)
    if (tool.riskTier === 'read-safe') {
      if (candidatePaths.length === 0) {
        const reason = `Missing target path for read-safe tool "${tool.toolName}"`
        this.recordAudit({
          toolName: tool.toolName,
          serverName: tool.serverName,
          riskTier: tool.riskTier,
          decision: 'blocked_traversal',
          argsPreview,
          reason,
        })
        return {
          status: 'blocked_traversal',
          reason,
        }
      }

      for (const candidatePath of candidatePaths) {
        if (!this.privacyController.isPathAllowed(candidatePath)) {
          const reason = `Path traversal or unauthorized path blocked: "${candidatePath}"`
          this.recordAudit({
            toolName: tool.toolName,
            serverName: tool.serverName,
            riskTier: tool.riskTier,
            decision: 'blocked_traversal',
            argsPreview,
            reason,
          })
          return {
            status: 'blocked_traversal',
            reason,
          }
        }
      }
    }

    // 3. Determine effective risk tier (Blast-Radius Guard escalates to staged-confirm)
    const effectiveTier: ActionRiskTier = blastWarning ? 'staged-confirm' : tool.riskTier

    if (effectiveTier === 'staged-confirm') {
      const canAutoApproveFromSession =
        !blastWarning && this.sessionApprovedTools.has(tool.toolName)

      if (!canAutoApproveFromSession) {
        const cardId = this.nextId('action')
        const card: PendingActionCard = {
          id: cardId,
          toolName: tool.toolName,
          serverName: tool.serverName,
          summary: `${tool.serverName}/${tool.toolName}: ${tool.description}`,
          argsPreview,
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
        })

        return {
          status: 'staged',
          pendingCard: Object.freeze({ ...card }),
        }
      }
    }

    // 4. Allowed immediately ('observe-only', 'read-safe', or session-approved without blast warning)
    const output = await tool.handler(safeArgs)
    this.recordAudit({
      toolName: tool.toolName,
      serverName: tool.serverName,
      riskTier: effectiveTier,
      decision: 'allowed',
      argsPreview,
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
    const pending = this.pendingActions.get(actionId)
    if (!pending) {
      throw new Error(`Pending action not found: ${actionId}`)
    }
    if (pending.card.status !== 'pending') {
      throw new Error(
        `Cannot approve action ${actionId}: current status is "${pending.card.status}"`
      )
    }

    pending.card.status = 'approved'

    if (scope === 'session' && !pending.card.blastRadiusWarning) {
      this.sessionApprovedTools.add(pending.tool.toolName)
    }

    const output = await pending.tool.handler(pending.args)

    this.recordAudit({
      toolName: pending.tool.toolName,
      serverName: pending.tool.serverName,
      riskTier: pending.card.riskTier,
      decision: 'approved',
      argsPreview: pending.card.argsPreview,
      actionId,
      reason: `Approved by user (scope=${scope})`,
      ...(pending.card.blastRadiusWarning
        ? { blastRadiusWarning: pending.card.blastRadiusWarning }
        : {}),
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
