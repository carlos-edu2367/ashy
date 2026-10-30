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

function checkRequired(relPath, patterns, reason) {
  const content = read(relPath)
  const list = Array.isArray(patterns) ? patterns : [patterns]
  for (const pattern of list) {
    if (!pattern.test(content)) {
      failures.push(`[MISSING WIRE] ${relPath}: ${reason} (missing ${pattern})`)
    }
  }
}

// 1. Verify Phase 6 Invariants & Red-Team Browser-Safety / Anti-Regression Checks (B1-B7, M1-M6)
const browserSafeFiles = [
  'apps/desktop/src/store/useAshyStore.ts',
  'apps/desktop/src/App.tsx',
  'packages/stage/src/index.ts',
  'packages/stage/src/components/AshyStageCanvas.tsx',
  'packages/stage/src/drivers/tachie-manifest.ts',
  'packages/stage/src/drivers/tachie-compositor.ts',
  'packages/stage/src/drivers/acoustic-lip-sync.ts',
  'packages/stage/src/drivers/hit-test-cpu.ts',
  'packages/stage/src/drivers/lip-sync-driver.ts',
  'packages/stage/src/drivers/live2d-inspector.ts',
  'packages/stage/src/drivers/procedural-life.ts',
]

for (const relFile of browserSafeFiles) {
  checkForbidden(
    relFile,
    /\bnode:(?:fs|path)\b/,
    `${relFile} must not import node:fs or node:path (renderer bundle must remain 100% browser-safe — Red-Team M1)`,
  )
}

checkForbidden(
  'apps/desktop/src/host/vite-host-plugin.ts',
  /(?:^|\n)\s*import\s+(?!type\b)(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]@ashy\/shared['"]/,
  'vite-host-plugin.ts must only import types from @ashy/shared so vite.config.ts bundles cleanly during vite build',
)

checkForbidden(
  'packages/stage/src/components/AshyStageCanvas.tsx',
  /opacity:\s*0\.01\b/,
  'AshyStageCanvas.tsx must render visible Tachie layers (must not hide Tachie SVG with opacity: 0.01)',
)

checkForbidden(
  'apps/desktop/src/App.tsx',
  /data-testid="floating-stage-overlay"[\s\S]{0,260}className="ashy-card"[^>]*data-ui-island="true"/,
  'App.tsx outer .ashy-card in floating-stage-overlay must not set data-ui-island="true" (Red-Team B1)',
)

// 2. Verify Canonical Default Avatar Package on disk (assets/default-avatar/)
const requiredAvatarAssets = [
  'assets/default-avatar/tachie-manifest.json',
  'assets/default-avatar/ashy-default.model3.json',
  'assets/default-avatar/layers/hair_back.svg',
  'assets/default-avatar/layers/base_body.svg',
  'assets/default-avatar/layers/face_base.svg',
  'assets/default-avatar/layers/blush.svg',
  'assets/default-avatar/layers/eyes_open.svg',
  'assets/default-avatar/layers/eyes_half.svg',
  'assets/default-avatar/layers/eyes_closed.svg',
  'assets/default-avatar/layers/eyes_wink.svg',
  'assets/default-avatar/layers/pupils.svg',
  'assets/default-avatar/layers/brows_13.svg',
  'assets/default-avatar/layers/mouth_visemes.svg',
  'assets/default-avatar/layers/hair_front.svg',
  'assets/default-avatar/layers/accessories_fx.svg',
]

for (const relAsset of requiredAvatarAssets) {
  const fullAsset = path.join(rootDir, relAsset)
  if (!fs.existsSync(fullAsset)) {
    failures.push(`[MISSING ASSET] ${relAsset}: avatar asset file does not exist`)
  } else {
    const stat = fs.statSync(fullAsset)
    if (stat.size < 64) {
      failures.push(`[EMPTY ASSET] ${relAsset}: expected non-empty avatar asset (> 64 bytes), got ${stat.size}`)
    }
  }
}

// 3. Verify all 6 Phase 6 organs have live producer + live reader + integration test
const organChecks = [
  {
    organ: '1. Shared Stage Overlay & Motion/Viseme Contracts',
    producer: [
      'packages/shared/src/host-protocol.ts',
      [
        /\bASHY_MOTION_PRESETS\b/,
        /\bASHY_VISEME_KEYS\b/,
        /\bDEFAULT_STAGE_SHORTCUTS\b/,
        /\bDEFAULT_STAGE_OVERLAY_RUNTIME_STATE\b/,
      ],
    ],
    reader: [
      'apps/desktop/src/store/useAshyStore.ts',
      [/\bASHY_MOTION_PRESETS\b/, /\bactiveViseme\b/, /\bactiveMotion\b/],
    ],
    test: [
      'packages/shared/src/__tests__/host-protocol.test.ts',
      [/\bASHY_MOTION_PRESETS\b/, /\bASHY_VISEME_KEYS\b/],
    ],
  },
  {
    organ: '2. Canonical Layered Avatar Package & Manifest Engine',
    producer: [
      'packages/stage/src/drivers/tachie-manifest.ts',
      [
        /\bDEFAULT_ASHY_TACHIE_MANIFEST\b/,
        /\bresolveTachieActiveLayers\b/,
        /\bcomputeMotionImpulseOffset\b/,
      ],
    ],
    reader: [
      'packages/stage/src/components/AshyStageCanvas.tsx',
      [/\bresolveTachieActiveLayers\b/, /\bcomputeMotionImpulseOffset\b/],
    ],
    test: [
      'packages/stage/test/stage-phase6.test.ts',
      [/\bDEFAULT_ASHY_TACHIE_MANIFEST\b/, /\bresolveTachieActiveLayers\b/],
    ],
  },
  {
    organ: '3. Acoustic Lip-Sync Analyzer (Formants/ZCR) & <|ACT|> Audio Timeline Synchronizer',
    producer: [
      'packages/stage/src/drivers/acoustic-lip-sync.ts',
      [
        /\bsynthesizeFormantVowelPcm\b/,
        /\banalyzePcmFrameToVowels\b/,
        /\bcreateStageSpeechSynchronizer\b/,
      ],
    ],
    reader: [
      'apps/desktop/src/store/useAshyStore.ts',
      [
        /\bsynthesizeFormantVowelPcm\b/,
        /\banalyzePcmFrameToVowels\b/,
        /\bcreateStageSpeechSynchronizer\b/,
      ],
    ],
    test: [
      'packages/stage/test/stage-phase6.test.ts',
      [/\banalyzePcmFrameToVowels\b/, /\bcreateStageSpeechSynchronizer\b/],
    ],
  },
  {
    organ: '4. Multi-Layer Tachie/Live2D Canvas Compositor & 4 Hz 128x72 Silhouette Extractor',
    producer: [
      'packages/stage/src/drivers/tachie-compositor.ts',
      [
        /\bextractCanvasSilhouetteMask128x72\b/,
        /\bbuildDynamicAvatarSilhouetteMask\b/,
        /\brenderTachieStageToCanvas\b/,
      ],
    ],
    reader: [
      'packages/stage/src/components/AshyStageCanvas.tsx',
      [
        /\bextractCanvasSilhouetteMask128x72\b/,
        /\bbuildDynamicAvatarSilhouetteMask\b/,
        /\brenderTachieStageToCanvas\b/,
      ],
    ],
    test: [
      'packages/stage/test/stage-phase6.test.ts',
      [/\bextractCanvasSilhouetteMask128x72\b/, /\bbuildDynamicAvatarSilhouetteMask\b/],
    ],
  },
  {
    organ: '5. Electron Stage Overlay Click-Through IPC, Global Shortcuts & Live2D Prompt Wiring',
    producer: [
      'apps/desktop/src/main/index.ts',
      [/ashy:setOverlayIgnoreMouse/, /ashy:setOverlayVisible/, /\bglobalShortcut\b/],
    ],
    reader: [
      'packages/cortex/src/prompt/soul-composer.ts',
      [/\[STAGE AVATAR CAPABILITIES\]/, /\bstageControlsPromptBlock\b/],
    ],
    test: [
      'apps/desktop/src/__tests__/host-transport.test.ts',
      [/\bsetOverlayIgnoreMouse\b/, /\bsetOverlayVisible\b/, /\bglobalShortcut\b/],
    ],
  },
  {
    organ: '6. Desktop Stage Overlay UI (?view=stage-overlay), Quick Controls Island, Shortcuts & Live2D Importer',
    producer: [
      'apps/desktop/src/store/useAshyStore.ts',
      [
        /\bresolveInitialWindowMode\b/,
        /\bsetStageIgnoreMouseEvents\b/,
        /\btoggleStageHidden\b/,
        /\bimportLive2DModelJson\b/,
        /\brunStageLipSyncActDemo\b/,
      ],
    ],
    reader: [
      'apps/desktop/src/App.tsx',
      [
        /stage-quick-controls/,
        /btn-quick-hide-stage/,
        /btn-restore-hidden-stage/,
        /live2d-json-import-input/,
      ],
    ],
    test: [
      'apps/desktop/src/__tests__/phase6-digital-body-ui.test.tsx',
      [
        /stage-quick-controls/,
        /btn-restore-hidden-stage/,
        /live2d-json-import-input/,
      ],
    ],
  },
]

for (const item of organChecks) {
  checkRequired(item.producer[0], item.producer[1], `${item.organ} producer`)
  checkRequired(item.reader[0], item.reader[1], `${item.organ} reader`)
  checkRequired(item.test[0], item.test[1], `${item.organ} test`)
}

if (failures.length > 0) {
  console.error('Phase 6 Organ Wire-Back Audit FAILED:\n' + failures.join('\n'))
  process.exit(1)
}

console.log(
  'Phase 6 Organ Wire-Back Audit PASSED: all 6 organs and 15 default-avatar assets wired end-to-end.',
)
