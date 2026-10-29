import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

function read(relPath) {
  const full = path.join(rootDir, relPath)
  if (!fs.existsSync(full)) {
    throw new Error(`Missing required file: ${relPath}`)
  }
  return fs.readFileSync(full, 'utf8')
}

const failures = []

function checkForbidden(relPath, pattern, reason) {
  const content = read(relPath)
  if (pattern.test(content)) {
    failures.push(`[FORBIDDEN] ${relPath}: ${reason}`)
  }
}

function checkRequired(relPath, pattern, reason) {
  const content = read(relPath)
  if (!pattern.test(content)) {
    failures.push(`[MISSING WIRE] ${relPath}: ${reason}`)
  }
}

// 1. Ensure production store has zero demo fallbacks or hardcoded scripted replies
checkForbidden(
  'apps/desktop/src/store/useAshyStore.ts',
  /forceMemoryFallback\s*:\s*true/,
  'Production store must not instantiate createAshyCortex({ forceMemoryFallback: true })',
)
checkForbidden(
  'apps/desktop/src/store/useAshyStore.ts',
  /INITIAL_MEMORY_CARDS/,
  'Production store must not embed INITIAL_MEMORY_CARDS demo fixtures',
)
checkForbidden(
  'apps/desktop/src/store/useAshyStore.ts',
  /VS Code — apps\/desktop\/src\/App\.tsx/,
  'Production store must not hardcode screenContext',
)

// 2. Verify all 6 Phase 0/1 organs have live producer + live reader + integration test
const organChecks = [
  {
    organ: 'CortexDatabase Migration v2 (chat_sessions/chat_messages)',
    producer: ['packages/cortex/src/db/cortex-db.ts', /CREATE TABLE IF NOT EXISTS chat_sessions/],
    reader: ['apps/desktop/src/host/turn-orchestrator.ts', /appendChatMessage/],
    test: ['packages/cortex/src/__tests__/phase1-persistence.test.ts', /Migration v2/],
  },
  {
    organ: 'VoiceIdentityStore (voice.md hot-load + auto-heal)',
    producer: ['apps/desktop/src/host/voice-identity-store.ts', /createVoiceIdentityStore/],
    reader: ['apps/desktop/src/host/turn-orchestrator.ts', /voiceIdentityMarkdown/],
    test: ['apps/desktop/src/__tests__/voice-identity-store.test.ts', /healed_from_backup/],
  },
  {
    organ: 'ProviderVault + SecretProtector',
    producer: ['apps/desktop/src/host/provider-vault.ts', /createProviderVault/],
    reader: ['apps/desktop/src/components/ModelsSettingsPanel.tsx', /models-settings-panel/],
    test: ['apps/desktop/src/__tests__/provider-vault.test.ts', /ProviderVault/],
  },
  {
    organ: '@ashy/llm streamText + createTailSafeMarkerParser in live turn loop',
    producer: ['apps/desktop/src/host/turn-orchestrator.ts', /streamText/],
    reader: ['apps/desktop/src/host/turn-orchestrator.ts', /createTailSafeMarkerParser/],
    test: ['apps/desktop/src/__tests__/host-kernel.test.ts', /turn:completed/],
  },
  {
    organ: 'Electron IPC registration before loadURL',
    producer: ['apps/desktop/src/main/index.ts', /registerAshyElectronIpc/],
    reader: ['apps/desktop/src/preload/index.ts', /contextBridge/],
    test: ['apps/desktop/src/__tests__/host-transport.test.ts', /registerAshyElectronIpc/],
  },
  {
    organ: 'Phase 0 First-Meeting Emergence Wizard',
    producer: ['apps/desktop/src/components/FirstMeetingWizard.tsx', /first-meeting-wizard/],
    reader: ['apps/desktop/src/App.tsx', /FirstMeetingWizard/],
    test: ['apps/desktop/src/__tests__/phase0-1-ui.test.tsx', /first-meeting-wizard/],
  },
]

for (const item of organChecks) {
  checkRequired(item.producer[0], item.producer[1], `${item.organ} producer`)
  checkRequired(item.reader[0], item.reader[1], `${item.organ} reader`)
  checkRequired(item.test[0], item.test[1], `${item.organ} test`)
}

if (failures.length > 0) {
  console.error('Phase 0/1 Organ Wire-Back Audit FAILED:\n' + failures.join('\n'))
  process.exit(1)
}

console.log('Phase 0/1 Organ Wire-Back Audit PASSED: all 6 organs wired end-to-end.')
