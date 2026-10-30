import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  createPrivacyController,
  computeDHash64,
  hammingDistance64,
  createScreenObservationFilter,
  createActionGatekeeper,
  createProgressiveMcpRegistry,
  computeUnifiedDiffPreview,
  createHttpMcpClient,
  createStdioMcpClient,
  createAuthorizedVisionSensor,
  type ActionAuditLogEntry,
  type McpToolRegistration,
} from '../src/index'

describe('@ashy/agency — Phase 6 Agency, Vision dHash, Progressive MCP & Gatekeeper', () => {
  describe('1. PrivacyController (Physical & Immediate Presence Controls)', () => {
    it('starts with safe privacy defaults (mic muted, eyes off, dnd false) and enforces modes', () => {
      const privacy = createPrivacyController({
        allowedWindowTitles: ['VS Code', 'Ashy Companion'],
        allowedPaths: ['C:/Users/User/Projects/ashy'],
      })

      expect(privacy.getState().micMode).toBe('muted')
      expect(privacy.getState().eyesMode).toBe('off')
      expect(privacy.getState().dndMode).toBe(false)

      // Eyes off -> cannot observe anything
      expect(privacy.canObserveScreen()).toBe(false)
      expect(privacy.canObserveScreen('VS Code — index.ts')).toBe(false)

      // Window mode -> only allowed window titles
      privacy.setEyesMode('window')
      expect(privacy.canObserveScreen('VS Code — index.ts')).toBe(true)
      expect(privacy.canObserveScreen('Chrome — Internet Banking')).toBe(false)
      expect(privacy.canObserveScreen()).toBe(false)

      // Screen mode -> can observe screen
      privacy.setEyesMode('screen')
      expect(privacy.canObserveScreen()).toBe(true)
      expect(privacy.canObserveScreen('Any Window')).toBe(true)

      // Mic modes: muted, ptt, continuous
      expect(privacy.canListenMic()).toBe(false)
      expect(privacy.canListenMic(true)).toBe(false)

      privacy.setMicMode('ptt')
      expect(privacy.canListenMic(false)).toBe(false)
      expect(privacy.canListenMic(true)).toBe(true)

      privacy.setMicMode('continuous')
      expect(privacy.canListenMic(false)).toBe(true)
    })

    it('checks quiet hours and DND for proactive initiatives, and activates Privacy Shield in 1 call', () => {
      const privacy = createPrivacyController({
        micMode: 'continuous',
        eyesMode: 'screen',
        dndMode: false,
      })

      // Daytime vs overnight quiet hours (22:00 -> 07:00)
      expect(privacy.canInitiateProactively(14, { startHour: 22, endHour: 7 })).toBe(true)
      expect(privacy.canInitiateProactively(23, { startHour: 22, endHour: 7 })).toBe(false)
      expect(privacy.canInitiateProactively(3, { startHour: 22, endHour: 7 })).toBe(false)
      expect(privacy.canInitiateProactively(7, { startHour: 22, endHour: 7 })).toBe(true)

      // Invalid/adversarial hour values
      expect(privacy.canInitiateProactively(Number.NaN)).toBe(false)
      expect(privacy.canInitiateProactively(-1)).toBe(false)
      expect(privacy.canInitiateProactively(24)).toBe(false)

      // Activate Privacy Shield -> closes eyes, mutes mic, turns on DND in 1 call
      const shielded = privacy.activatePrivacyShield()
      expect(shielded.eyesMode).toBe('off')
      expect(shielded.micMode).toBe('muted')
      expect(shielded.dndMode).toBe(true)

      expect(privacy.canObserveScreen('VS Code')).toBe(false)
      expect(privacy.canListenMic(true)).toBe(false)
      expect(privacy.canInitiateProactively(14, { startHour: 22, endHour: 7 })).toBe(false)
    })
  })

  describe('2. Perceptual Vision dHash 64-bit Filter', () => {
    it('computes 64-bit horizontal difference hash and Hamming distance accurately', () => {
      // 9x8 gradient increasing left-to-right on every row
      const gradientLeftToRight = new Uint8Array(9 * 8)
      // 9x8 gradient decreasing left-to-right on every row
      const gradientRightToLeft = new Uint8Array(9 * 8)

      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 9; x++) {
          gradientLeftToRight[y * 9 + x] = x * 25
          gradientRightToLeft[y * 9 + x] = (8 - x) * 25
        }
      }

      const hashA = computeDHash64(gradientLeftToRight, 9, 8)
      const hashB = computeDHash64(gradientRightToLeft, 9, 8)

      expect(typeof hashA).toBe('bigint')
      expect(hammingDistance64(hashA, hashA)).toBe(0)
      expect(hammingDistance64(hashA, hashB)).toBe(64)
    })

    it('skips static and near-identical RGBA frames (0 vision tokens) and detects real screen changes', () => {
      const width = 36
      const height = 32
      const makeRgbaFrame = (patternFn: (x: number, y: number) => number): Uint8Array => {
        const buf = new Uint8Array(width * height * 4)
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4
            const v = patternFn(x, y)
            buf[idx] = v
            buf[idx + 1] = v
            buf[idx + 2] = v
            buf[idx + 3] = 255
          }
        }
        return buf
      }

      const baseFrame = makeRgbaFrame((x, y) => ((x * 7 + y * 3) % 256))
      // Almost identical frame: tiny 1-pixel cursor blink that affects at most 1 cell
      const nearIdenticalFrame = new Uint8Array(baseFrame)
      nearIdenticalFrame[0] = 250
      nearIdenticalFrame[1] = 250
      nearIdenticalFrame[2] = 250

      // Completely different screen content (inverted gradient / window switch)
      const changedFrame = makeRgbaFrame((x, y) => (x < width / 2 ? 240 : 10) ^ (y % 2 === 0 ? 0 : 200))

      const filter = createScreenObservationFilter({
        maxHammingThreshold: 4,
        forceRefreshMs: 60_000,
      })

      // 1st frame is never skipped
      expect(filter.shouldSkipFrame(baseFrame, width, height, 1_000)).toBe(false)
      // Identical frame at t=2000ms -> skipped!
      expect(filter.shouldSkipFrame(baseFrame, width, height, 2_000)).toBe(true)
      // Near-identical frame (distance <= 4) at t=3000ms -> skipped!
      expect(filter.shouldSkipFrame(nearIdenticalFrame, width, height, 3_000)).toBe(true)
      // Real screen change at t=4000ms -> NOT skipped!
      expect(filter.shouldSkipFrame(changedFrame, width, height, 4_000)).toBe(false)
      // Static again at t=5000ms -> skipped!
      expect(filter.shouldSkipFrame(changedFrame, width, height, 5_000)).toBe(true)
      // After forceRefreshMs (t=65_000ms) -> NOT skipped even if static!
      expect(filter.shouldSkipFrame(changedFrame, width, height, 65_000)).toBe(false)
    })
  })

  describe('3. Progressive MCP Tool Discovery (30+ tools without prompt pollution)', () => {
    it('exposes only the 3 meta-tools and searches across 30 registered tools with compact summaries', async () => {
      const privacy = createPrivacyController({
        eyesMode: 'screen',
        allowedPaths: ['/workspace/project'],
      })
      const gatekeeper = createActionGatekeeper({ privacyController: privacy })
      const registry = createProgressiveMcpRegistry({ gatekeeper })

      registry.registerServer({
        name: 'workspace-mcp',
        description: 'Local workspace tools',
      })

      const tools: McpToolRegistration[] = []
      for (let i = 1; i <= 30; i++) {
        tools.push({
          toolName: `tool_${i}_${i === 17 ? 'git_blame_inspector' : 'helper'}`,
          serverName: i % 2 === 0 ? 'workspace-mcp' : 'github-mcp',
          description:
            i === 17
              ? 'Inspects git blame history and commit authorship for a file in the repository'
              : `Generic utility tool number ${i} with a heavy schema`,
          riskTier: 'observe-only',
          inputSchema: {
            type: 'object',
            properties: {
              paramA: { type: 'string', description: 'Heavy schema field A'.repeat(10) },
              paramB: { type: 'number', description: 'Heavy schema field B'.repeat(10) },
            },
            required: ['paramA'],
          },
          handler: async (args) => ({ ok: true, toolIndex: i, args }),
        })
      }

      registry.registerTools(tools)
      expect(registry.getRegisteredToolsCount()).toBe(30)

      // Prompt only receives the 3 lightweight meta-tools!
      const metaTools = registry.getExposedMetaTools()
      expect(metaTools).toHaveLength(3)
      expect(metaTools.map((t) => t.name)).toEqual([
        'search_mcp_tools',
        'get_mcp_tool_details',
        'call_mcp_tool',
      ])

      // 1. Search across 30 tools
      const results = registry.search_mcp_tools({ query: 'git blame authorship', limit: 5 })
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]?.toolName).toBe('tool_17_git_blame_inspector')
      // Compact summary must NOT include the heavy inputSchema
      expect('inputSchema' in (results[0] as unknown as Record<string, unknown>)).toBe(false)

      // 2. Get full schema details only for the selected tool
      const details = registry.get_mcp_tool_details({ toolName: 'tool_17_git_blame_inspector' })
      expect(details).not.toBeNull()
      expect(details?.toolName).toBe('tool_17_git_blame_inspector')
      expect(details?.inputSchema).toBeDefined()

      // 3. Call tool through progressive registry -> routed via ActionGatekeeper
      const execResult = await registry.call_mcp_tool({
        toolName: 'tool_17_git_blame_inspector',
        args: { paramA: 'src/index.ts' },
      })
      expect(execResult.status).toBe('executed')
      expect(execResult.output).toEqual({
        ok: true,
        toolIndex: 17,
        args: { paramA: 'src/index.ts' },
      })
    })
  })

  describe('4. ActionGatekeeper, Adversarial Path Traversal, Blast-Radius Guard & Staged-Confirm Flow', () => {
    it('blocks adversarial Path Traversal (../../secret.env, ..\\Windows\\System32, URL-encoded, NTFS ADS, null-byte) and unallowed paths', async () => {
      const privacy = createPrivacyController({
        eyesMode: 'screen',
        allowedPaths: ['/workspace/ashy/docs', 'C:\\Users\\User\\AllowedFolder'],
      })
      const gatekeeper = createActionGatekeeper({ privacyController: privacy })
      const readSpy = vi.fn(async (args: Record<string, unknown>) => ({ content: `read:${String(args.path)}` }))

      gatekeeper.registerTool({
        toolName: 'fs_read_file',
        serverName: 'fs-mcp',
        description: 'Reads a file inside allowed folders',
        riskTier: 'read-safe',
        handler: readSpy,
      })

      // Valid path inside allowedPaths -> allowed immediately
      const validRes = await gatekeeper.executeTool('fs_read_file', {
        path: '/workspace/ashy/docs/guide.md',
      })
      expect(validRes.status).toBe('executed')
      expect(readSpy).toHaveBeenCalledTimes(1)

      // Adversarial traversal 1: ../../secret.env
      const traversalUnix = await gatekeeper.executeTool('fs_read_file', {
        path: '/workspace/ashy/docs/../../secret.env',
      })
      expect(traversalUnix.status).toBe('blocked_traversal')

      // Adversarial traversal 2: relative ../../secret.env
      const traversalRelative = await gatekeeper.executeTool('fs_read_file', {
        path: '../../secret.env',
      })
      expect(traversalRelative.status).toBe('blocked_traversal')

      // Adversarial traversal 3: Windows ..\Windows\System32
      const traversalWin = await gatekeeper.executeTool('fs_read_file', {
        path: 'C:\\Users\\User\\AllowedFolder\\..\\..\\Windows\\System32\\drivers\\etc\\hosts',
      })
      expect(traversalWin.status).toBe('blocked_traversal')

      // Adversarial traversal 4: Sibling prefix attack (/workspace/ashy/docs-secret/keys.txt)
      const siblingPrefix = await gatekeeper.executeTool('fs_read_file', {
        path: '/workspace/ashy/docs-secret/keys.txt',
      })
      expect(siblingPrefix.status).toBe('blocked_traversal')

      // Adversarial traversal 5: Null-byte injection
      const nullByte = await gatekeeper.executeTool('fs_read_file', {
        path: '/workspace/ashy/docs/readme.md\0.env',
      })
      expect(nullByte.status).toBe('blocked_traversal')

      // Adversarial traversal 6: URL-encoded %2e%2e%2f
      const urlEncoded = await gatekeeper.executeTool('fs_read_file', {
        path: '/workspace/ashy/docs/%2e%2e/secret.env',
      })
      expect(urlEncoded.status).toBe('blocked_traversal')

      // Adversarial traversal 7: Array of paths where 2nd element escapes allowedPaths
      const arraySmuggling = await gatekeeper.executeTool('fs_read_file', {
        paths: ['/workspace/ashy/docs/guide.md', '/etc/passwd'],
      })
      expect(arraySmuggling.status).toBe('blocked_traversal')
      expect(readSpy).toHaveBeenCalledTimes(1)

      const audit = gatekeeper.getAuditLog()
      expect(audit.filter((e) => e.decision === 'blocked_traversal')).toHaveLength(7)
    })

    it('enforces full staged-confirm lifecycle (pending -> approveOnce -> executed & pending -> deny -> cancelled) and Blast-Radius Guard (rm -rf /)', async () => {
      const privacy = createPrivacyController({
        eyesMode: 'screen',
        allowedPaths: ['/workspace/ashy'],
      })
      const gatekeeper = createActionGatekeeper({ privacyController: privacy })
      const shellSpy = vi.fn(async (args: Record<string, unknown>) => ({
        exitCode: 0,
        ran: args.command,
      }))

      gatekeeper.registerTool({
        toolName: 'terminal_exec',
        serverName: 'shell-mcp',
        description: 'Executes a shell command',
        riskTier: 'staged-confirm',
        handler: shellSpy,
      })

      // 1. Destructive command (`rm -rf /`) -> staged with blastRadiusWarning, NEVER executed upfront
      const destructiveAttempt = await gatekeeper.executeTool('terminal_exec', {
        command: 'rm -rf / --no-preserve-root',
      })
      expect(destructiveAttempt.status).toBe('staged')
      expect(shellSpy).not.toHaveBeenCalled()
      expect(destructiveAttempt.pendingCard).toBeDefined()
      expect(destructiveAttempt.pendingCard?.status).toBe('pending')
      expect(destructiveAttempt.pendingCard?.blastRadiusWarning).toMatch(/rm -rf|destructive|perigoso/i)

      // Deny the destructive command -> cancelled, handler still never called, clear feedback for Ashy
      const deniedRes = gatekeeper.denyAction(
        destructiveAttempt.pendingCard!.id,
        'User rejected destructive command'
      )
      expect(deniedRes.status).toBe('denied')
      expect(deniedRes.card.status).toBe('denied')
      expect(deniedRes.feedback).toContain('User rejected destructive command')
      expect(shellSpy).not.toHaveBeenCalled()

      // Adversarial check: trying to approve an already-denied card must throw
      await expect(
        gatekeeper.approveAction(destructiveAttempt.pendingCard!.id, 'once')
      ).rejects.toThrow(/Cannot approve action/)

      // 2. Normal staged-confirm command -> pending -> approveOnce -> executed
      const buildAttempt = await gatekeeper.executeTool('terminal_exec', {
        command: 'pnpm --filter @ashy/agency test',
      })
      expect(buildAttempt.status).toBe('staged')
      expect(shellSpy).not.toHaveBeenCalled()

      const approvedRes = await gatekeeper.approveAction(buildAttempt.pendingCard!.id, 'once')
      expect(approvedRes.status).toBe('executed')
      expect(approvedRes.card.status).toBe('approved')
      expect(shellSpy).toHaveBeenCalledTimes(1)
      expect(approvedRes.output).toEqual({
        exitCode: 0,
        ran: 'pnpm --filter @ashy/agency test',
      })

      // Next call to terminal_exec still stages because scope was 'once'
      const secondAttempt = await gatekeeper.executeTool('terminal_exec', {
        command: 'pnpm build',
      })
      expect(secondAttempt.status).toBe('staged')
      expect(shellSpy).toHaveBeenCalledTimes(1)

      // Approve with scope='session' -> subsequent safe calls auto-execute, but Blast-Radius STILL stages!
      await gatekeeper.approveAction(secondAttempt.pendingCard!.id, 'session')
      expect(shellSpy).toHaveBeenCalledTimes(2)

      const safeSessionCall = await gatekeeper.executeTool('terminal_exec', {
        command: 'pnpm lint',
      })
      expect(safeSessionCall.status).toBe('executed')
      expect(shellSpy).toHaveBeenCalledTimes(3)

      const blastDuringSession = await gatekeeper.executeTool('terminal_exec', {
        command: 'del /f /s /q C:\\*',
      })
      expect(blastDuringSession.status).toBe('staged')
      expect(blastDuringSession.pendingCard?.blastRadiusWarning).toBeDefined()
      expect(shellSpy).toHaveBeenCalledTimes(3)

      // Audit log verification (immutable entries for staged, denied, approved, allowed)
      const auditLog = gatekeeper.getAuditLog()
      expect(auditLog.map((entry) => entry.decision)).toEqual([
        'staged',
        'denied',
        'staged',
        'approved',
        'staged',
        'approved',
        'allowed',
        'staged',
      ])
      expect(Object.isFrozen(auditLog[0])).toBe(true)
    })

    it('blocks observe-only tools when Privacy Shield is active and records blocked_privacy in auditLog', async () => {
      const privacy = createPrivacyController({
        eyesMode: 'window',
        allowedWindowTitles: ['VS Code'],
      })
      const gatekeeper = createActionGatekeeper({ privacyController: privacy })
      const captureSpy = vi.fn(async () => ({ captured: true }))

      gatekeeper.registerTool({
        toolName: 'capture_active_window',
        serverName: 'vision-mcp',
        description: 'Captures active window metadata',
        riskTier: 'observe-only',
        handler: captureSpy,
      })

      // Allowed when window title is in whitelist
      const okRes = await gatekeeper.executeTool('capture_active_window', {
        windowTitle: 'VS Code - agency.test.ts',
      })
      expect(okRes.status).toBe('executed')
      expect(captureSpy).toHaveBeenCalledTimes(1)

      // Activate Privacy Shield -> blocks observation immediately
      privacy.activatePrivacyShield()
      const blockedRes = await gatekeeper.executeTool('capture_active_window', {
        windowTitle: 'VS Code - agency.test.ts',
      })
      expect(blockedRes.status).toBe('blocked_privacy')
      expect(captureSpy).toHaveBeenCalledTimes(1)

      const auditLog = gatekeeper.getAuditLog()
      expect(auditLog.at(-1)?.decision).toBe('blocked_privacy')
    })
  })
})

describe('@ashy/agency — Phase 7: Auto-Accept Mode, Risk Overrides, Diff Previews, MCP Client & AuthorizedVisionSensor', () => {
  describe('5. Modo Não Pergunte (auto_accept), Policy off, and Auto-Approving Queued Pending Actions', () => {
    it('auto-executes staged-confirm and blast-radius tools immediately in auto_accept mode and can flush pending cards', async () => {
      const privacy = createPrivacyController({
        eyesMode: 'screen',
        allowedPaths: ['/workspace/ashy'],
      })
      const auditStream: ActionAuditLogEntry[] = []
      const gatekeeper = createActionGatekeeper({
        privacyController: privacy,
        onAuditEntry: (entry) => auditStream.push(entry),
      })

      const writeSpy = vi.fn(async (args: Record<string, unknown>) => ({
        written: true,
        title: args.title,
      }))
      const shellSpy = vi.fn(async (args: Record<string, unknown>) => ({
        exitCode: 0,
        command: args.command,
      }))

      gatekeeper.registerTool({
        toolName: 'write_project_note',
        serverName: 'workspace-notes',
        description: 'Writes a markdown note',
        riskTier: 'staged-confirm',
        handler: writeSpy,
      })
      gatekeeper.registerTool({
        toolName: 'run_cleanup_command',
        serverName: 'workspace-shell',
        description: 'Runs a cleanup shell command',
        riskTier: 'staged-confirm',
        handler: shellSpy,
      })

      // Default policy is 'ask'
      expect(gatekeeper.getApprovalPolicy()).toBe('ask')

      // Stage an action first while in 'ask' mode
      const stagedNote = await gatekeeper.executeTool('write_project_note', {
        path: '/workspace/ashy/notes/queued.md',
        title: 'Queued Note',
        content: '# Queued\nPending before switching to auto_accept',
      })
      expect(stagedNote.status).toBe('staged')
      expect(gatekeeper.getPendingActions()).toHaveLength(1)
      expect(writeSpy).toHaveBeenCalledTimes(0)

      // Switch to 'auto_accept' with autoApprovePending: true -> flushes queued pending action!
      const flushed = await gatekeeper.setApprovalPolicy('auto_accept', {
        autoApprovePending: true,
      })
      expect(gatekeeper.getApprovalPolicy()).toBe('auto_accept')
      expect(flushed).toHaveLength(1)
      expect(gatekeeper.getPendingActions()).toHaveLength(0)
      expect(writeSpy).toHaveBeenCalledTimes(1)

      // Subsequent staged-confirm calls execute immediately without staging
      const autoExecNote = await gatekeeper.executeTool('write_project_note', {
        path: '/workspace/ashy/notes/instant.md',
        title: 'Instant Note',
        content: '# Instant\nAuto-approved by policy',
      })
      expect(autoExecNote.status).toBe('executed')
      expect(autoExecNote.pendingCard).toBeUndefined()
      expect(gatekeeper.getPendingActions()).toHaveLength(0)
      expect(writeSpy).toHaveBeenCalledTimes(2)

      // Even a command triggering Blast-Radius Guard is auto-accepted in 'auto_accept' mode
      const autoExecBlast = await gatekeeper.executeTool('run_cleanup_command', {
        command: 'rm -rf /workspace/ashy/dist',
      })
      expect(autoExecBlast.status).toBe('executed')
      expect(shellSpy).toHaveBeenCalledTimes(1)

      const lastEntry = gatekeeper.getAuditLog().at(-1)
      expect(lastEntry?.decision).toBe('allowed')
      expect(lastEntry?.reason).toContain('auto_accept')
      expect(lastEntry?.blastRadiusWarning).toBeDefined()
      expect(auditStream.length).toBe(gatekeeper.getAuditLog().length)

      // Switch to 'off' -> blocks non-observe-only tools with status: 'blocked_policy'
      await gatekeeper.setApprovalPolicy('off')
      expect(gatekeeper.getApprovalPolicy()).toBe('off')

      const blockedByOff = await gatekeeper.executeTool('write_project_note', {
        path: '/workspace/ashy/notes/blocked.md',
        title: 'Blocked',
        content: 'Should not run',
      })
      expect(blockedByOff.status).toBe('blocked_policy')
      expect(writeSpy).toHaveBeenCalledTimes(2)
      expect(gatekeeper.getAuditLog().at(-1)?.decision).toBe('denied')
      expect(gatekeeper.getAuditLog().at(-1)?.reason).toContain('Computer actions disabled by policy (off)')
    })
  })

  describe('6. Per-Tool Risk Tier Overrides, Rich Diff/Command Previews, Symlink Defense & Session Revocation', () => {
    it('supports per-tool risk overrides and exposes default vs effective risk tiers in ProgressiveMcpRegistry', async () => {
      const privacy = createPrivacyController({
        eyesMode: 'screen',
        allowedPaths: ['/workspace/ashy'],
      })
      const gatekeeper = createActionGatekeeper({ privacyController: privacy })
      const registry = createProgressiveMcpRegistry({ gatekeeper })

      registry.registerServer({ name: 'workspace-fs', description: 'Workspace FS' })
      registry.registerTools([
        {
          toolName: 'read_workspace_file',
          serverName: 'workspace-fs',
          description: 'Reads a workspace file',
          riskTier: 'read-safe',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
          handler: async (args) => ({ content: `file:${String(args.path)}` }),
        },
      ])

      // Initially read-safe -> executes immediately
      const res1 = await registry.call_mcp_tool({
        toolName: 'read_workspace_file',
        args: { path: '/workspace/ashy/README.md' },
      })
      expect(res1.status).toBe('executed')

      // Override read_workspace_file to 'staged-confirm'
      registry.setToolRiskTier('read_workspace_file', 'staged-confirm')
      expect(gatekeeper.getToolRiskOverrides()).toEqual({
        read_workspace_file: 'staged-confirm',
      })

      const allTools = registry.listAllTools()
      expect(allTools).toHaveLength(1)
      expect(allTools[0]?.defaultRiskTier).toBe('read-safe')
      expect(allTools[0]?.effectiveRiskTier).toBe('staged-confirm')

      // Now calling read_workspace_file stages a PendingActionCard!
      const res2 = await registry.call_mcp_tool({
        toolName: 'read_workspace_file',
        args: { path: '/workspace/ashy/README.md' },
      })
      expect(res2.status).toBe('staged')
      expect(res2.pendingCard?.targetPath).toBe('/workspace/ashy/README.md')
    })

    it('generates unified diff/command/targetPath previews, blocks path/symlink traversal on staged-confirm tools, and revokes session permissions', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-agency-test-'))
      const allowedDir = path.join(tempRoot, 'allowed')
      const secretDir = path.join(tempRoot, 'secret')
      fs.mkdirSync(allowedDir, { recursive: true })
      fs.mkdirSync(secretDir, { recursive: true })
      const secretFile = path.join(secretDir, 'passwords.txt')
      fs.writeFileSync(secretFile, 'TOP_SECRET=123', 'utf8')

      const symlinkPath = path.join(allowedDir, 'innocent-note.md')
      let symlinkCreated = false
      try {
        fs.symlinkSync(secretFile, symlinkPath)
        symlinkCreated = true
      } catch {
        // Windows without Developer Mode may disallow file symlinks; test directory junction or skip symlink assertion gracefully
      }

      try {
        const privacy = createPrivacyController({
          eyesMode: 'screen',
          allowedPaths: ['/workspace/ashy', allowedDir],
        })
        const gatekeeper = createActionGatekeeper({ privacyController: privacy })
        const writeSpy = vi.fn(async () => ({ ok: true }))

        gatekeeper.registerTool({
          toolName: 'write_project_note',
          serverName: 'workspace-notes',
          description: 'Writes markdown note',
          riskTier: 'staged-confirm',
          handler: writeSpy,
        })

        // 1. Unified diff helper verification
        const diff = computeUnifiedDiffPreview(
          '/workspace/ashy/notes/plan.md',
          '# Old Plan\nKeep line',
          '# New Plan\nKeep line\n+ Added bullet'
        )
        expect(diff).toContain('--- a/workspace/ashy/notes/plan.md')
        expect(diff).toContain('+++ b/workspace/ashy/notes/plan.md')
        expect(diff).toContain('-# Old Plan')
        expect(diff).toContain('+# New Plan')

        // 2. Staging write_project_note populates targetPath and diffPreview
        const staged = await gatekeeper.executeTool('write_project_note', {
          path: '/workspace/ashy/notes/roadmap.md',
          title: 'Phase 7 Roadmap',
          content: '# Phase 7\n- Desktop MCP\n- Vision dHash',
        })
        expect(staged.status).toBe('staged')
        expect(staged.pendingCard?.targetPath).toBe('/workspace/ashy/notes/roadmap.md')
        expect(staged.pendingCard?.diffPreview).toContain('+++ b/workspace/ashy/notes/roadmap.md')
        expect(staged.pendingCard?.diffPreview).toContain('+# Phase 7')

        // 3. Path traversal on a staged-confirm write tool is blocked BEFORE staging!
        const traversalWrite = await gatekeeper.executeTool('write_project_note', {
          path: '../../evil.md',
          title: 'Evil',
          content: 'pwned',
        })
        expect(traversalWrite.status).toBe('blocked_traversal')
        expect(traversalWrite.pendingCard).toBeUndefined()

        // 4. Symlink escape inside allowedDir pointing to secretFile outside allowedDir is blocked!
        if (symlinkCreated) {
          const symlinkEscape = await gatekeeper.executeTool('write_project_note', {
            path: symlinkPath,
            title: 'Symlink Escape',
            content: 'overwrite secret',
          })
          expect(symlinkEscape.status).toBe('blocked_traversal')
        }

        // 5. Session approvals & revocation
        await gatekeeper.approveAction(staged.pendingCard!.id, 'session')
        expect(gatekeeper.getSessionApprovedTools()).toEqual(['write_project_note'])

        // Next call auto-executes because of session approval
        const sessionExec = await gatekeeper.executeTool('write_project_note', {
          path: '/workspace/ashy/notes/roadmap-v2.md',
          title: 'Roadmap v2',
          content: '# v2',
        })
        expect(sessionExec.status).toBe('executed')

        // Revoke individual tool session approval
        gatekeeper.revokeSessionApproval('write_project_note')
        expect(gatekeeper.getSessionApprovedTools()).toEqual([])
        expect(gatekeeper.getAuditLog().at(-1)?.decision).toBe('revoked')

        // After revocation, calling write_project_note stages again!
        const restaged = await gatekeeper.executeTool('write_project_note', {
          path: '/workspace/ashy/notes/roadmap-v3.md',
          title: 'Roadmap v3',
          content: '# v3',
        })
        expect(restaged.status).toBe('staged')

        await gatekeeper.approveAction(restaged.pendingCard!.id, 'session')
        expect(gatekeeper.getSessionApprovedTools()).toContain('write_project_note')

        gatekeeper.revokeAllSessionApprovals()
        expect(gatekeeper.getSessionApprovedTools()).toEqual([])
        expect(gatekeeper.getAuditLog().at(-1)?.decision).toBe('revoked')
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true })
      }
    })
  })

  describe('7. Real MCP Protocol Client (JSON-RPC 2.0 over HTTP & Stdio)', () => {
    it('communicates via JSON-RPC 2.0 over HTTP and registers remote tools into ProgressiveMcpRegistry', async () => {
      const rpcCalls: Array<{ method: string; params: unknown }> = []

      const mockFetch: typeof fetch = vi.fn(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          id: number
          method: string
          params?: Record<string, unknown>
        }
        rpcCalls.push({ method: body.method, params: body.params })

        if (body.method === 'initialize') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                protocolVersion: '2024-11-05',
                serverInfo: { name: 'remote-git-mcp', version: '2.1.0' },
                capabilities: { tools: {} },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
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
                    name: 'git_status_summary',
                    description: 'Returns current git working tree status',
                    inputSchema: {
                      type: 'object',
                      properties: { repoPath: { type: 'string' } },
                    },
                  },
                ],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }

        if (body.method === 'tools/call') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                content: [{ type: 'text', text: 'clean working tree on branch main' }],
                isError: false,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }

        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: 'Method not found' },
          }),
          { status: 200 }
        )
      })

      const client = createHttpMcpClient({
        serverName: 'remote-git-mcp',
        url: 'http://127.0.0.1:4199/mcp',
        fetchImpl: mockFetch,
      })

      const initRes = await client.initialize()
      expect(initRes.serverInfo.name).toBe('remote-git-mcp')
      expect(initRes.serverInfo.version).toBe('2.1.0')

      const privacy = createPrivacyController({
        eyesMode: 'screen',
        allowedPaths: ['/workspace/ashy'],
      })
      const gatekeeper = createActionGatekeeper({ privacyController: privacy })
      const registry = createProgressiveMcpRegistry({ gatekeeper })

      const discovered = await client.registerIntoProgressiveRegistry(registry, 'staged-confirm')
      expect(discovered).toHaveLength(1)
      expect(discovered[0]?.name).toBe('git_status_summary')

      // Search & call via ProgressiveMcpRegistry -> stages by default ('staged-confirm')
      const searchHits = registry.search_mcp_tools({ query: 'git working tree' })
      expect(searchHits[0]?.toolName).toBe('git_status_summary')

      const stagedCall = await registry.call_mcp_tool({
        toolName: 'git_status_summary',
        args: { repoPath: '/workspace/ashy' },
      })
      expect(stagedCall.status).toBe('staged')

      const approved = await gatekeeper.approveAction(stagedCall.pendingCard!.id, 'once')
      expect(approved.status).toBe('executed')
      expect(approved.output).toEqual({
        content: [{ type: 'text', text: 'clean working tree on branch main' }],
        isError: false,
      })
      expect(rpcCalls.map((c) => c.method)).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/call',
      ])
    })

    it('communicates via JSON-RPC 2.0 over Stdio with shell:false and framing', async () => {
      const spawnSpy = vi.fn((_command: string, _args: readonly string[], options: Record<string, unknown>) => {
        expect(options.shell).toBe(false)
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const proc = Object.assign(new EventEmitter(), {
          stdin,
          stdout,
          stderr,
          kill: vi.fn(),
        })

        let buffer = ''
        stdin.on('data', (chunk: Buffer | string) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            const req = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> }
            if (req.method === 'initialize') {
              stdout.write(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: req.id,
                  result: { serverInfo: { name: 'stdio-notes-mcp', version: '1.0.0' } },
                }) + '\n'
              )
            } else if (req.method === 'tools/list') {
              stdout.write(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: req.id,
                  result: {
                    tools: [
                      {
                        name: 'stdio_ping',
                        description: 'Pings stdio MCP server',
                        inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
                      },
                    ],
                  },
                }) + '\n'
              )
            } else if (req.method === 'tools/call') {
              stdout.write(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: req.id,
                  result: { pong: (req.params?.arguments as Record<string, unknown>)?.msg ?? 'ok' },
                }) + '\n'
              )
            }
          }
        })

        return proc
      })

      const stdioClient = createStdioMcpClient({
        serverName: 'stdio-notes-mcp',
        command: 'node',
        args: ['mcp-server.js'],
        spawnImpl: spawnSpy,
      })

      const initInfo = await stdioClient.initialize()
      expect(initInfo.serverInfo.name).toBe('stdio-notes-mcp')

      const tools = await stdioClient.listTools()
      expect(tools).toHaveLength(1)
      expect(tools[0]?.name).toBe('stdio_ping')

      const callRes = await stdioClient.callTool('stdio_ping', { msg: 'hello-ashy' })
      expect(callRes).toEqual({ pong: 'hello-ashy' })
      expect(spawnSpy).toHaveBeenCalledTimes(1)
      await stdioClient.close()

      // Adversarial MCP client checks: invalid URL protocols, null bytes, oversized payloads, prototype pollution tool names
      expect(() =>
        createHttpMcpClient({
          serverName: 'evil-file',
          url: 'file:///etc/passwd',
        })
      ).toThrow(/Unsupported MCP HTTP protocol/)

      expect(() =>
        createStdioMcpClient({
          serverName: 'evil-stdio',
          command: 'node\0--eval',
        })
      ).toThrow(/null byte/)

      const rogueClient = createHttpMcpClient({
        serverName: 'rogue-mcp',
        url: 'http://127.0.0.1:4199/mcp',
        maxResponseBytes: 1024,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: {
                tools: [
                  { name: '__proto__', description: 'pollution' },
                  { name: 'constructor', description: 'pollution' },
                  { name: 'bad\nname', description: 'newline injection' },
                  { name: 'valid_tool', description: 'safe tool' },
                ],
              },
            }),
            { status: 200 }
          ),
      })
      const sanitizedTools = await rogueClient.listTools()
      expect(sanitizedTools.map((t) => t.name)).toEqual(['valid_tool'])
    })
  })

  describe('8. AuthorizedVisionSensor (Zero Capture When Eyes Off + 64-bit dHash Skip on Static Screen)', () => {
    it('never calls captureFrameFn when eyesMode is off, and skips static frames with 0 vision tokens when enabled', async () => {
      const width = 36
      const height = 32
      const makeFrame = (seed: number) => {
        const pixels = new Uint8Array(width * height * 4)
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4
            const val = seed === 1 ? (x * 7 + y * 3) % 256 : (x < width / 2 ? 250 : 10) ^ (y % 2 === 0 ? 0 : 210)
            pixels[idx] = val
            pixels[idx + 1] = val
            pixels[idx + 2] = val
            pixels[idx + 3] = 255
          }
        }
        return {
          width,
          height,
          pixels,
          windowTitle: 'VS Code — App.tsx',
          sourceType: 'window' as const,
        }
      }

      let activeFrame = makeFrame(1)
      const captureSpy = vi.fn(async (windowTitle?: string) => ({
        ...activeFrame,
        windowTitle: windowTitle ?? activeFrame.windowTitle,
      }))
      const visionProviderSpy = vi.fn(async (_frame, ctx) => ({
        summary: `Observed ${ctx.windowTitle} (${ctx.dHashHex})`,
        visionTokensSpent: 85,
      }))

      let now = 10_000
      const privacy = createPrivacyController({
        eyesMode: 'off',
        allowedWindowTitles: ['VS Code', 'Ashy'],
      })
      const gatekeeper = createActionGatekeeper({
        privacyController: privacy,
        nowFn: () => now,
      })

      const sensor = createAuthorizedVisionSensor({
        privacyController: privacy,
        gatekeeper,
        captureFrameFn: captureSpy,
        visionProvider: { describeFrame: visionProviderSpy },
        nowFn: () => now,
      })

      // 1. With eyesMode === 'off', observeScreen MUST NOT invoke captureFrameFn!
      const blockedObs = await sensor.observeScreen('VS Code — App.tsx')
      expect(blockedObs.observed).toBe(false)
      expect(blockedObs.blockedByPrivacy).toBe(true)
      expect(blockedObs.visionTokensSpent).toBe(0)
      expect(captureSpy).not.toHaveBeenCalled()
      expect(visionProviderSpy).not.toHaveBeenCalled()
      expect(sensor.getTelemetry().framesCapturedCount).toBe(0)
      expect(sensor.getTelemetry().blockedPrivacyCount).toBe(1)
      expect(gatekeeper.getAuditLog().at(-1)?.decision).toBe('blocked_privacy')

      // 2. Enable eyesMode = 'window' -> Frame 1 is captured and described by VisionProvider
      privacy.setEyesMode('window')
      now = 11_000
      const firstObs = await sensor.observeScreen('VS Code — App.tsx')
      expect(firstObs.observed).toBe(true)
      expect(firstObs.blockedByPrivacy).toBe(false)
      expect(firstObs.skippedByDhash).toBe(false)
      expect(firstObs.visionTokensSpent).toBe(85)
      expect(firstObs.summary).toContain('Observed VS Code — App.tsx')
      expect(captureSpy).toHaveBeenCalledTimes(1)
      expect(visionProviderSpy).toHaveBeenCalledTimes(1)
      expect(sensor.getTelemetry().framesCapturedCount).toBe(1)

      // 3. Static screen at t=12_000 -> skipped by dHash, 0 vision tokens spent, visionProvider NOT called!
      now = 12_000
      const staticObs = await sensor.observeScreen('VS Code — App.tsx')
      expect(staticObs.observed).toBe(true)
      expect(staticObs.skippedByDhash).toBe(true)
      expect(staticObs.hammingDistance).toBe(0)
      expect(staticObs.visionTokensSpent).toBe(0)
      expect(staticObs.summary).toBe(firstObs.summary)
      expect(captureSpy).toHaveBeenCalledTimes(2)
      expect(visionProviderSpy).toHaveBeenCalledTimes(1)
      expect(sensor.getTelemetry().framesSkippedByDhashCount).toBe(1)
      expect(sensor.getTelemetry().totalVisionTokensSpent).toBe(85)

      // 4. Changed screen at t=13_000 -> not skipped, visionProvider called again
      activeFrame = makeFrame(2)
      now = 13_000
      const changedObs = await sensor.observeScreen('VS Code — App.tsx')
      expect(changedObs.observed).toBe(true)
      expect(changedObs.skippedByDhash).toBe(false)
      expect(changedObs.hammingDistance).toBeGreaterThan(4)
      expect(changedObs.visionTokensSpent).toBe(85)
      expect(visionProviderSpy).toHaveBeenCalledTimes(2)
      expect(sensor.getTelemetry().framesCapturedCount).toBe(2)
      expect(sensor.getTelemetry().totalVisionTokensSpent).toBe(170)
    })
  })
})
