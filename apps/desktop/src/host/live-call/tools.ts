/**
 * Phase 10.3 — tools in the live call (plan §Escopo 1).
 *
 * A LEAN set for the 2B LFM3 model (`get_active_window_title`, `capture_authorized_screen`,
 * `read_workspace_file`, `write_project_note`), declared as OpenAI-Realtime function tools with
 * short English descriptions (spike 2026-11-01). Execution goes through the agency runtime's
 * `callMcpTool` → ProgressiveMcpRegistry → ActionGatekeeper (the same path as the chat's
 * `executeGatekeptMcpTool`); `staged` actions come back as `aguardando_aprovacao` and the model
 * must ask the user. There is deliberately NO approval tool: only the user approves (voice phrase
 * checked host-side, or a click).
 */
import * as v from 'valibot'
import { valibotSchemaToJsonSchema } from '@ashy/llm'
import type { CallExecuteToolResult, CallToolDefinition } from '@ashy/shared'
import type { HostAgencyRuntime } from '../agency-runtime'
import type { VisionDescribeResult } from './vision'

export const CALL_TOOL_OUTPUT_MAX_CHARS = 2000
const READ_FILE_CONTENT_MAX_CHARS = 1500
const NOTE_CONTENT_MAX_CHARS = 4000

export const CALL_TOOL_NAMES = [
  'get_active_window_title',
  'capture_authorized_screen',
  'read_workspace_file',
  'write_project_note',
] as const
export type CallToolName = (typeof CALL_TOOL_NAMES)[number]

const CALL_TOOL_SPECS: ReadonlyArray<{
  name: CallToolName
  description: string
  parameters: v.GenericSchema
}> = [
  {
    name: 'get_active_window_title',
    description: 'Returns the title of the window the user is currently using.',
    parameters: v.object({}),
  },
  {
    name: 'capture_authorized_screen',
    description: "Looks at the user's screen (if authorized) and returns a short description.",
    parameters: v.object({}),
  },
  {
    name: 'read_workspace_file',
    description: 'Reads an EXISTING text file the user names explicitly (e.g. "lê o arquivo notas.txt"). Never use it to save or write anything.',
    parameters: v.object({ path: v.pipe(v.string(), v.description('Relative file path')) }),
  },
  {
    name: 'write_project_note',
    description: "Saves a new note when the user asks to write/remember something (\"anota\", \"anote\", \"salva uma nota\", \"lembra que\"). Needs the user's approval.",
    parameters: v.object({
      title: v.pipe(v.string(), v.description('Short note title')),
      content: v.pipe(v.string(), v.description('Note text')),
    }),
  },
]

function stripAdditionalProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, p]) => [
          k,
          p && typeof p === 'object' ? stripAdditionalProperties(p as Record<string, unknown>) : p,
        ]),
      )
      continue
    }
    out[key] = value
  }
  return out
}

/** The 4 call tools as `session.update` function definitions (lean JSON Schema, no extras). */
export function buildCallToolDefinitions(): CallToolDefinition[] {
  return CALL_TOOL_SPECS.map((spec) => ({
    type: 'function' as const,
    name: spec.name,
    description: spec.description,
    parameters: stripAdditionalProperties(
      valibotSchemaToJsonSchema(spec.parameters as Parameters<typeof valibotSchemaToJsonSchema>[0]),
    ),
  }))
}

export function isCallToolName(name: string): name is CallToolName {
  return (CALL_TOOL_NAMES as readonly string[]).includes(name)
}

// ───────────────────────────── PT summaries / lean outputs (shared with approvals) ─────────────────────────────

function oneLine(raw: unknown, max: number): string {
  const text = String(raw ?? '')
    .replace(/\0/g, '')
    .replace(/<\|[\s\S]*?\|>/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text
}

function hardCap(text: string, max = CALL_TOOL_OUTPUT_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function readArgFromPreview(argsPreview: string, key: string): string | null {
  try {
    const parsed = JSON.parse(argsPreview) as Record<string, unknown>
    const value = parsed?.[key]
    if (typeof value === 'string') return value
  } catch {
    // truncated preview → regex fallback below
  }
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(argsPreview)
  if (!match) return null
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return match[1] ?? null
  }
}

/** Short PT description of a pending action ("salvar a nota "Reunião""). */
export function describePendingActionPt(card: {
  toolName: string
  argsPreview: string
  commandPreview?: string
}): string {
  if (card.toolName === 'write_project_note') {
    const title = oneLine(readArgFromPreview(card.argsPreview, 'title'), 80)
    return title ? `salvar a nota "${title}"` : 'salvar uma nota'
  }
  if (card.toolName === 'run_cleanup_command') {
    const command = oneLine(card.commandPreview ?? readArgFromPreview(card.argsPreview, 'command'), 80)
    return command ? `executar o comando "${command}"` : 'executar um comando'
  }
  return `usar a ferramenta ${oneLine(card.toolName, 64)}`
}

/** Lean, model-friendly rendering of a tool output (≤ maxChars, valid JSON when possible). */
export function leanToolOutput(toolName: string, output: unknown, maxChars = CALL_TOOL_OUTPUT_MAX_CHARS): string {
  const o = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>
  let lean: unknown = output
  if (toolName === 'get_active_window_title') {
    lean = { janela: oneLine(o.observedWindow ?? o.windowTitle, 200) }
  } else if (toolName === 'read_workspace_file') {
    const content = typeof o.content === 'string' ? o.content : ''
    const room = Math.max(0, Math.min(READ_FILE_CONTENT_MAX_CHARS, maxChars - 120))
    lean = {
      arquivo: oneLine(o.path, 100),
      conteudo: content.slice(0, room),
      ...(content.length > room ? { truncado: true } : {}),
    }
  } else if (toolName === 'write_project_note') {
    lean = { status: 'salvo', titulo: oneLine(o.title, 80) }
  }
  let text: string
  if (typeof lean === 'string') {
    text = lean
  } else {
    try {
      text = JSON.stringify(lean) ?? ''
    } catch {
      text = String(lean)
    }
  }
  return hardCap(text, maxChars)
}

const BLOCKED_REASON_PT: Record<string, string> = {
  blocked_privacy: 'privacidade: a visão está desligada ou essa janela não foi autorizada',
  blocked_traversal: 'esse caminho está fora das pastas autorizadas',
  blocked_policy: 'as ações no computador estão desligadas pelo usuário',
}

// ───────────────────────────── call:executeTool ─────────────────────────────

export type CallToolRuntime = Pick<HostAgencyRuntime, 'callMcpTool' | 'gatekeeper'>

export interface ExecuteCallToolDeps {
  /** null while the agency runtime is not ready. */
  getRuntime(): CallToolRuntime | null
  /** Live-call vision (capture_authorized_screen). */
  describeScreen(): Promise<VisionDescribeResult>
}

export interface ExecuteCallToolInput {
  callId: string
  name: string
  argsJson: string
}

function json(value: unknown): string {
  return hardCap(JSON.stringify(value))
}

function errorResult(motivo: string): CallExecuteToolResult {
  return { status: 'error', output: json({ status: 'erro', motivo: oneLine(motivo, 240) }) }
}

function parseArgs(argsJson: string): Record<string, unknown> | null {
  const trimmed = argsJson.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

/** Relative paths ("notas.txt") are resolved inside the default authorized workspace root. */
function toWorkspacePath(raw: string): string {
  const p = raw.trim().replace(/\\/g, '/')
  if (p.startsWith('/') || /^[a-zA-Z]:\//.test(p)) return p
  return `/workspace/ashy/${p.replace(/^\.\/+/, '')}`
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\0/g, '').trim().slice(0, max) : ''
}

/** Whitelisted args per tool (the model can never pass fixture ids, paths for notes, etc.). */
function sanitizeArgs(name: CallToolName, args: Record<string, unknown>): Record<string, unknown> | string {
  if (name === 'get_active_window_title' || name === 'capture_authorized_screen') return {}
  if (name === 'read_workspace_file') {
    const path = str(args.path ?? args.file ?? args.filename, 512)
    if (!path) return 'faltou o caminho do arquivo'
    return { path: toWorkspacePath(path) }
  }
  const content = str(args.content ?? args.text ?? args.note, NOTE_CONTENT_MAX_CHARS)
  const title = str(args.title, 80) || oneLine(content, 40) || 'Nota da chamada'
  return { title, content: content || title }
}

export async function executeCallTool(
  input: ExecuteCallToolInput,
  deps: ExecuteCallToolDeps,
): Promise<CallExecuteToolResult> {
  const name = input.name.trim()
  if (!isCallToolName(name)) return errorResult(`ferramenta desconhecida: ${name}`)
  const rawArgs = parseArgs(input.argsJson)
  if (!rawArgs) return errorResult('argumentos inválidos (JSON)')
  const args = sanitizeArgs(name, rawArgs)
  if (typeof args === 'string') return errorResult(args)

  const runtime = deps.getRuntime()
  if (!runtime) return errorResult('as ferramentas ainda não estão prontas')

  if (name === 'capture_authorized_screen') {
    return executeCallVision(runtime, deps)
  }

  try {
    const res = await runtime.callMcpTool({ toolName: name, args, origin: { callId: input.callId } })
    if (res.status === 'executed') {
      return { status: 'executed', output: leanToolOutput(name, res.output) }
    }
    if (res.status === 'staged' && res.pendingCard) {
      return {
        status: 'staged',
        output: json({ status: 'aguardando_aprovacao', resumo: describePendingActionPt(res.pendingCard) }),
        cardId: res.pendingCard.id,
      }
    }
    return {
      status: 'blocked',
      output: json({ status: 'bloqueado', motivo: BLOCKED_REASON_PT[res.status] ?? oneLine(res.reason, 200) }),
    }
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err))
  }
}

async function executeCallVision(runtime: CallToolRuntime, deps: ExecuteCallToolDeps): Promise<CallExecuteToolResult> {
  const result = await deps.describeScreen()
  const blocked = !result.ok && (result.reason === 'eyes_off' || result.reason === 'window_not_authorized')
  // Same audit trail as the gatekeeper's observe-only path.
  try {
    runtime.gatekeeper.recordAuditEntry({
      toolName: 'capture_authorized_screen',
      serverName: 'desktop-vision',
      riskTier: 'observe-only',
      decision: result.ok ? 'allowed' : blocked ? 'blocked_privacy' : 'denied',
      argsPreview: '{}',
      reason: result.ok ? 'Live call vision (llama-server)' : result.text,
    })
  } catch {
    // audit is best-effort here
  }
  if (result.ok) return { status: 'executed', output: json({ descricao: result.text }) }
  if (blocked) return { status: 'blocked', output: json({ status: 'bloqueado', motivo: result.text }) }
  return { status: 'error', output: json({ status: 'indisponivel', motivo: result.text }) }
}
