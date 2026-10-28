import {
  type ActionGatekeeper,
  type ActionRiskTier,
  type GatekeeperExecutionResult,
} from './action-gatekeeper'

export interface McpServerInfo {
  name: string
  description: string
}

export interface McpToolRegistration {
  toolName: string
  serverName: string
  description: string
  riskTier: ActionRiskTier
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

export interface McpToolCompactSummary {
  toolName: string
  serverName: string
  description: string
  riskTier: ActionRiskTier
}

export interface McpToolDetails extends McpToolCompactSummary {
  inputSchema: Record<string, unknown>
}

export interface ExposedMetaToolSchema {
  name: 'search_mcp_tools' | 'get_mcp_tool_details' | 'call_mcp_tool'
  description: string
  inputSchema: Record<string, unknown>
}

export interface ProgressiveMcpRegistryOptions {
  gatekeeper: ActionGatekeeper
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
}

export class ProgressiveMcpRegistry {
  private readonly gatekeeper: ActionGatekeeper
  private readonly servers = new Map<string, McpServerInfo>()
  private readonly tools = new Map<string, McpToolRegistration>()

  constructor(options: ProgressiveMcpRegistryOptions) {
    this.gatekeeper = options.gatekeeper
  }

  registerServer(server: McpServerInfo): void {
    if (!server.name || server.name.trim().length === 0) {
      throw new Error('MCP server name must be non-empty')
    }
    this.servers.set(server.name, { ...server })
  }

  registerTools(registrations: readonly McpToolRegistration[]): void {
    for (const reg of registrations) {
      if (!reg.toolName || reg.toolName.trim().length === 0) {
        throw new Error('MCP toolName must be non-empty')
      }
      this.tools.set(reg.toolName, { ...reg })
      this.gatekeeper.registerTool({
        toolName: reg.toolName,
        serverName: reg.serverName,
        description: reg.description,
        riskTier: reg.riskTier,
        handler: reg.handler,
      })
    }
  }

  getRegisteredToolsCount(): number {
    return this.tools.size
  }

  getRegisteredServersCount(): number {
    return this.servers.size
  }

  /**
   * Returns ONLY the 3 lightweight meta-tools to inject into Ashy's prompt,
   * avoiding context pollution from dozens of heavy MCP schemas.
   */
  getExposedMetaTools(): readonly ExposedMetaToolSchema[] {
    return [
      {
        name: 'search_mcp_tools',
        description:
          'Searches registered MCP tools by keyword across name, server, and description, returning compact summaries.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query keywords' },
            limit: { type: 'number', description: 'Max results to return (default 5)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_mcp_tool_details',
        description: 'Returns the full JSON schema and details for a specific MCP tool by name.',
        inputSchema: {
          type: 'object',
          properties: {
            toolName: { type: 'string', description: 'Exact tool name to inspect' },
          },
          required: ['toolName'],
        },
      },
      {
        name: 'call_mcp_tool',
        description:
          'Invokes a registered MCP tool with arguments, routed through ActionGatekeeper.',
        inputSchema: {
          type: 'object',
          properties: {
            toolName: { type: 'string', description: 'Exact tool name to execute' },
            args: { type: 'object', description: 'Arguments matching the tool inputSchema' },
          },
          required: ['toolName'],
        },
      },
    ]
  }

  search_mcp_tools(params: { query: string; limit?: number }): McpToolCompactSummary[] {
    const rawQuery = typeof params?.query === 'string' ? params.query.trim() : ''
    const limit = Math.max(1, Math.min(50, Math.floor(params?.limit ?? 5)))

    if (rawQuery.length === 0) {
      return Array.from(this.tools.values())
        .slice(0, limit)
        .map((t) => ({
          toolName: t.toolName,
          serverName: t.serverName,
          description: t.description,
          riskTier: t.riskTier,
        }))
    }

    const queryLower = rawQuery.toLowerCase()
    const queryTokens = tokenize(rawQuery)

    const scored: Array<{ tool: McpToolRegistration; score: number }> = []

    for (const tool of this.tools.values()) {
      let score = 0
      const nameLower = tool.toolName.toLowerCase()
      const serverLower = tool.serverName.toLowerCase()
      const descLower = tool.description.toLowerCase()
      const serverDesc = this.servers.get(tool.serverName)?.description.toLowerCase() ?? ''

      if (nameLower === queryLower) score += 100
      else if (nameLower.includes(queryLower)) score += 40

      if (serverLower.includes(queryLower)) score += 25
      if (descLower.includes(queryLower)) score += 30

      const nameTokens = new Set(tokenize(tool.toolName))
      const serverTokens = new Set(tokenize(tool.serverName))
      const descTokens = new Set(tokenize(tool.description))

      for (const token of queryTokens) {
        if (nameTokens.has(token)) score += 20
        else if (nameLower.includes(token)) score += 10

        if (serverTokens.has(token)) score += 12
        else if (serverLower.includes(token) || serverDesc.includes(token)) score += 6

        if (descTokens.has(token)) score += 15
        else if (descLower.includes(token)) score += 5
      }

      if (score > 0) {
        scored.push({ tool, score })
      }
    }

    scored.sort((a, b) => b.score - a.score || a.tool.toolName.localeCompare(b.tool.toolName))

    return scored.slice(0, limit).map(({ tool }) => ({
      toolName: tool.toolName,
      serverName: tool.serverName,
      description: tool.description,
      riskTier: tool.riskTier,
    }))
  }

  get_mcp_tool_details(params: { toolName: string }): McpToolDetails | null {
    if (!params || typeof params.toolName !== 'string') {
      return null
    }
    const tool = this.tools.get(params.toolName.trim())
    if (!tool) {
      return null
    }
    return {
      toolName: tool.toolName,
      serverName: tool.serverName,
      description: tool.description,
      riskTier: tool.riskTier,
      inputSchema: structuredClone(tool.inputSchema),
    }
  }

  async call_mcp_tool(params: {
    toolName: string
    args?: Record<string, unknown>
  }): Promise<GatekeeperExecutionResult> {
    if (!params || typeof params.toolName !== 'string' || params.toolName.trim().length === 0) {
      throw new Error('toolName is required for call_mcp_tool')
    }
    return this.gatekeeper.executeTool(params.toolName.trim(), params.args ?? {})
  }
}

export function createProgressiveMcpRegistry(
  options: ProgressiveMcpRegistryOptions
): ProgressiveMcpRegistry {
  return new ProgressiveMcpRegistry(options)
}
