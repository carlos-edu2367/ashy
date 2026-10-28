import { describe, expect, it, vi } from 'vitest'
import {
  createPrivacyController,
  computeDHash64,
  hammingDistance64,
  createScreenObservationFilter,
  createActionGatekeeper,
  createProgressiveMcpRegistry,
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
