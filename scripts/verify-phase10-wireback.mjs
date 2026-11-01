import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Phase 10 (Live Call Engine) wire-back + security invariants.
 * Spec: docs/superpowers/specs/2026-10-31-phase-10-live-call-engine-design.md §10
 * ADR:  docs/adr/0008-live-call-engine-pluggable-voice-sessions.md
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

function read(relPath) {
  const full = path.join(rootDir, relPath)
  if (!fs.existsSync(full)) {
    throw new Error(`Missing required file: ${relPath}`)
  }
  return fs.readFileSync(full, 'utf8')
}

/** Recursively lists .ts/.tsx/.js/.mjs source files (tests excluded) under `relDir` (or the file itself). */
function listSources(relPath) {
  const full = path.join(rootDir, relPath)
  if (!fs.existsSync(full)) {
    throw new Error(`Missing required path: ${relPath}`)
  }
  const stat = fs.statSync(full)
  if (stat.isFile()) return [relPath]
  const out = []
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const child = path.posix.join(relPath.replace(/\\/g, '/'), entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'test' || entry.name === 'node_modules') continue
      out.push(...listSources(child))
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      out.push(child)
    }
  }
  return out
}

const failures = []
let checks = 0

function checkForbidden(relPath, pattern, reason) {
  checks += 1
  const content = read(relPath)
  if (pattern.test(content)) {
    failures.push(`[FORBIDDEN] ${relPath}: ${reason} (matched ${pattern})`)
  }
}

function checkRequired(relPath, patterns, reason) {
  const content = read(relPath)
  const list = Array.isArray(patterns) ? patterns : [patterns]
  for (const pattern of list) {
    checks += 1
    if (!pattern.test(content)) {
      failures.push(`[MISSING WIRE] ${relPath}: ${reason} (missing ${pattern})`)
    }
  }
}

// ─── 1. No secret ever reaches the renderer (spec §10 "Chaves") ───────────────────────────────
// The renderer may WRITE a key the user typed (`liveMode:setApiKey`, provider vault save), but it
// must never read the stored secrets, the encrypted cloud-key file, the llama-server key or build
// an auth header itself: main injects engine/relay headers into the call window only.
const rendererRoots = [
  'apps/desktop/src/App.tsx',
  'apps/desktop/src/components',
  'apps/desktop/src/store',
  'apps/desktop/src/call-engine',
  'apps/desktop/src/services',
]
const rendererFiles = rendererRoots.flatMap((root) => listSources(root))

const rendererSecretRules = [
  [/providers\.secrets/, 'must not touch the provider vault secrets store (providers.secrets)'],
  [/live-cloud-keys/, 'must not reference the encrypted Live Mode cloud key file (live-cloud-keys.json)'],
  [/LLAMA_API_KEY/, 'must not know the managed llama-server API key (LLAMA_API_KEY)'],
  [/\bBearer\s/, 'must not build Authorization: Bearer headers (main injects them via webRequest)'],
  [/x-goog-api-key/i, 'must not build Gemini key headers (the host relay adds ?key= upstream)'],
  [/['"`]liveMode:getApiKey['"`]/, 'must not call a key-reading RPC (only setApiKey / getKeyStatus are allowed)'],
  [/\b(?:sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})/, 'must not embed a literal API key'],
  [/from\s+['"][^'"]*host\/(?:provider-vault|secret-protector|live-call\/cloud|engines\/llamacpp-engine)['"]/, 'must not import host secret modules'],
]
for (const relFile of rendererFiles) {
  for (const [pattern, reason] of rendererSecretRules) {
    checkForbidden(relFile, pattern, `renderer ${reason}`)
  }
}

// ─── 2. Call audio never rides the JSON host transport (spec §5.2) ────────────────────────────
for (const relFile of listSources('packages/voice/src/call')) {
  checkForbidden(
    relFile,
    /turn:audio-delta/,
    'the CallEngine / VoiceSessions must not use turn:audio-delta (call audio goes WS → playback in the call window)',
  )
}

// ─── 3. Host is the single owner of the call state; hub + overlay are views ───────────────────
checkRequired(
  'apps/desktop/src/store/useCallStore.ts',
  [/case\s+['"]call:state['"]/, /case\s+['"]call:viseme['"]/, /onHostEvent\(/],
  'useCallStore must mirror the host call:state / call:viseme events',
)
checkRequired(
  'apps/desktop/src/App.tsx',
  [/<HubCallOrb\s*\/>/, /<HubCallStatusStrip\s*\/>/, /<OverlayCallButtons\s*\/>/, /<OverlayCallStateDot\b/, /<LiveModeSettingsPanel\s*\/>/],
  'hub + overlay must render the call controls and Settings › Live Mode',
)
checkRequired(
  'apps/desktop/src/components/LiveCallControls.tsx',
  [/useCallStore\(\(s\) => s\.callState\)|callState/, /data-testid="btn-call-toggle"/, /data-testid="btn-call-mute"/, /data-testid="call-state-dot"/, /data-testid="live-mode-panel"/],
  'call controls must read the mirrored call state',
)
checkRequired(
  'apps/desktop/src/host/live-call/call-hub.ts',
  [/call:state/],
  'the host CallStateHub must broadcast call:state',
)

// ─── 4. Pinned, verified downloads (spec §10 "Downloads") ─────────────────────────────────────
const contract = 'packages/shared/src/live-call-protocol.ts'
checkRequired(
  contract,
  [
    /LLAMACPP_PINNED_BUILD\s*=\s*'b12024'/,
    // llama.cpp b12024 release zips (GitHub API asset digests)
    /sha256:\s*'6eed15a36babfdbb6ed4b28839282395abeb6209081cb4d44070bb3e6a7fb5a7'/, // cuda-12.4
    /sha256:\s*'8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6'/, // cudart 12.4
    /sha256:\s*'a843d12c9cc3ae30e29646918f9dc4d0c7a60348499b0af497661f3b6aafc9a8'/, // vulkan
    /sha256:\s*'a8a1bc0167c594c377255e54aab617b288a38e09efb50f39ac5bd087e4398f72'/, // cpu
    // LFM3-Omni-2B GGUF + mmproj (HF LFS oids, pinned revision)
    /sha256:\s*'9f8d30e9d4fd7a9349d586e077988229b3ca0a0e4ad730897563d1eccc9893e2'/,
    /sha256:\s*'8a25f9d1931244429de404fccacfb7fb933970a36aa5688d2f5069f29c6b27b1'/,
    /LFM3_OMNI_REV\s*=\s*'[0-9a-f]{40}'/,
  ],
  'the shared contract must pin the llama.cpp build and the SHA256 of every downloadable asset',
)
checkRequired(
  'apps/desktop/src/host/engines/llamacpp-engine.ts',
  [/LLAMACPP_RELEASE_ASSETS/, /createHash\(\s*['"]sha256['"]\s*\)/],
  'the llama.cpp engine must download only the pinned assets and verify their SHA256',
)

// ─── 5. llama-server API key: env only, never argv (spec §10 "Sidecar local") ────────────────
const engine = 'apps/desktop/src/host/engines/llamacpp-engine.ts'
checkRequired(
  engine,
  [/env:\s*\{\s*LLAMA_API_KEY:\s*launchKey\s*\}/, /--host['"]?\s*,\s*['"]127\.0\.0\.1['"]/],
  'llama-server must get its key through the LLAMA_API_KEY env var and bind to 127.0.0.1',
)
checkForbidden(engine, /['"]--api-key['"]/, 'the llama-server key must never be passed on argv (--api-key)')

// ─── 6. Auth headers are scoped to the hidden call-engine window (main) ──────────────────────
checkRequired(
  'apps/desktop/src/main/index.ts',
  [
    /export function installScopedRequestHeaders\(/,
    /details\.webContentsId !== wc\.id/,
    /isEngineRequestUrl\(details\.url, auth\)/,
    /isCloudRelayRequestUrl\(details\.url, auth\)/,
    /u\.protocol === 'ws:' && u\.hostname === '127\.0\.0\.1'/,
    /CALL_TOGGLE_SHORTCUT\s*=\s*'CommandOrControl\+Alt\+L'/,
  ],
  'main must inject engine/relay auth only into the call-engine window and only to the loopback port',
)

// ─── 7. Voice approvals are deterministic; the model has no approval tool ─────────────────────
checkRequired(
  'apps/desktop/src/host/live-call/approvals.ts',
  [/VOICE_APPROVE_PHRASES/, /VOICE_DENY_PHRASES/, /blastRadiusWarning/],
  'voice approvals must be a deterministic phrase match that excludes blast-radius actions',
)
checkForbidden(
  'apps/desktop/src/host/live-call/tools.ts',
  /name:\s*['"](?:approve|approve_pending|approve_action)/,
  'the call must not expose an approval tool to the model',
)

if (failures.length > 0) {
  console.error('❌ Phase 10 Wire-Back Verification FAILED:')
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}

console.log(
  `✅ Phase 10 Wire-Back Verification PASSED: ${checks} checks over ${rendererFiles.length} renderer files (secrets, call audio transport, call state, pinned SHA256, engine key, header scope, approvals).`,
)
