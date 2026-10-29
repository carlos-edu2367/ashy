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

// 1. Verify Phase 5 Invariants & Red-Team Browser-Safety / Anti-Regression Checks
checkForbidden(
  'apps/desktop/src/store/useAshyStore.ts',
  /\bnode:fs\b/,
  'useAshyStore.ts must not import node:fs (renderer bundle must remain 100% browser-safe)',
)
checkForbidden(
  'packages/voice/src/wav-codec.ts',
  /\bnode:fs\b/,
  'wav-codec.ts must not import node:fs (must remain 100% browser-safe)',
)
checkForbidden(
  'apps/desktop/src/host/vite-host-plugin.ts',
  /(?:^|\n)\s*import\s+(?!type\b)(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]@ashy\/shared['"]/,
  'vite-host-plugin.ts must only import types from @ashy/shared so vite.config.ts bundles cleanly during vite build',
)

// 2. Verify all 4 deterministic .wav audio fixtures exist and are non-empty on disk
const requiredWavFixtures = [
  'assets/audio-fixtures/thinking-pause-cas.wav',
  'assets/audio-fixtures/barge-in-interrupt.wav',
  'assets/audio-fixtures/wake-word-oi-ashy.wav',
  'assets/audio-fixtures/keyboard-click-noise.wav',
]

for (const relWav of requiredWavFixtures) {
  const fullWav = path.join(rootDir, relWav)
  if (!fs.existsSync(fullWav)) {
    failures.push(`[MISSING FIXTURE] ${relWav}: audio fixture file does not exist`)
  } else {
    const stat = fs.statSync(fullWav)
    if (stat.size <= 44) {
      failures.push(`[EMPTY FIXTURE] ${relWav}: expected valid RIFF/WAVE payload (> 44 bytes), got ${stat.size}`)
    }
  }
}

// 3. Verify all 6 Phase 5 organs have live producer + live reader + integration test
const organChecks = [
  {
    organ: '1. Shared Voice Contracts & interruptionControlNote',
    producer: ['packages/shared/src/host-protocol.ts', /STT_PROVIDER_IDS[\s\S]*TTS_PROVIDER_IDS[\s\S]*interruptionControlNote/],
    reader: ['apps/desktop/src/host/turn-orchestrator.ts', /interruptionControlNote/],
    test: ['packages/shared/src/__tests__/host-protocol.test.ts', /interruptionControlNote/],
  },
  {
    organ: '2. WAV Codec, Hybrid VadEngine & .wav Fixtures',
    producer: ['packages/voice/src/wav-codec.ts', /encodeWavPcm16[\s\S]*decodeWavToPcmBlocks[\s\S]*buildVoiceFixtureWavBytes/],
    reader: ['packages/voice/src/voice-session-runtime.ts', /decodeWavToPcmBlocks/],
    test: ['packages/voice/test/voice-phase5.test.ts', /thinking-pause-cas\.wav/],
  },
  {
    organ: '3. Incremental SpeechPipeline (enqueueDelta/flush) & Dual STT/TTS Providers',
    producer: ['packages/voice/src/speech-pipeline.ts', /enqueueDelta[\s\S]*flush/],
    reader: ['packages/voice/src/providers.ts', /createSttProviderRegistry[\s\S]*createTtsProviderRegistry/],
    test: ['packages/voice/test/voice-phase5.test.ts', /enqueueDelta/],
  },
  {
    organ: '4. Hybrid VoiceEndJudge, SpeculativeRephrase, WebAudio I/O & VoiceSessionRuntime',
    producer: ['packages/voice/src/turn-intelligence.ts', /createHybridVoiceEndJudge[\s\S]*createHybridSpeculativeRephrase/],
    reader: ['packages/voice/src/voice-session-runtime.ts', /createVoiceSessionRuntime/],
    test: ['packages/voice/test/voice-phase5.test.ts', /createVoiceSessionRuntime/],
  },
  {
    organ: '5. [VOICE BARGE-IN RECEIPT] Prompt Injection',
    producer: ['packages/cortex/src/prompt/soul-composer.ts', /\[VOICE BARGE-IN RECEIPT\]/],
    reader: ['packages/cortex/src/ashy-cortex.ts', /interruptionControlNote/],
    test: ['packages/cortex/test/cortex.test.ts', /\[VOICE BARGE-IN RECEIPT\]/],
  },
  {
    organ: '6. Desktop Incremental Streaming TTS, TTFA Telemetry & Hub Voice UI',
    producer: ['apps/desktop/src/store/useAshyStore.ts', /enqueueDelta[\s\S]*pendingInterruptionControlNote[\s\S]*runAudioFixtureSimulation/],
    reader: ['apps/desktop/src/App.tsx', /voice-ttfa-badge[\s\S]*voice-cas-badge[\s\S]*voice-bargein-receipt/],
    test: ['apps/desktop/src/__tests__/phase5-realtime-voice-ui.test.tsx', /voice-bargein-receipt/],
  },
]

for (const item of organChecks) {
  checkRequired(item.producer[0], item.producer[1], `${item.organ} producer`)
  checkRequired(item.reader[0], item.reader[1], `${item.organ} reader`)
  checkRequired(item.test[0], item.test[1], `${item.organ} test`)
}

if (failures.length > 0) {
  console.error('Phase 5 Organ Wire-Back Audit FAILED:\n' + failures.join('\n'))
  process.exit(1)
}

console.log('Phase 5 Organ Wire-Back Audit PASSED: all 6 organs and 4 .wav fixtures wired end-to-end.')
