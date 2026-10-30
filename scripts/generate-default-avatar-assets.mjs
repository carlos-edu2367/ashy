#!/usr/bin/env node
/**
 * Generates Ashy's canonical Phase 6 default avatar package:
 * - assets/default-avatar/tachie-manifest.json
 * - assets/default-avatar/ashy-default.model3.json
 * - assets/default-avatar/layers/*.svg (13 layers)
 * And mirrors them into apps/desktop/public/assets/default-avatar/
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const ASHY_EMOTIONS = [
  'neutral',
  'happy',
  'excited',
  'smug',
  'tease',
  'chaotic',
  'curious',
  'think',
  'surprised',
  'awkward',
  'concerned',
  'sad',
  'angry',
]

const TACHIE_MANIFEST = {
  id: 'ashy-cozy-night-studio-v1',
  name: 'Ashy — Cozy Night Studio Canonical Rig',
  version: '1.0.0',
  canvasWidth: 380,
  canvasHeight: 460,
  pivots: {
    torso: { x: 190, y: 365 },
    head: { x: 190, y: 205 },
    leftEye: { x: 155, y: 196 },
    rightEye: { x: 225, y: 196 },
    mouth: { x: 190, y: 248 },
  },
  layers: [
    {
      id: 'hair_back',
      zIndex: 10,
      assetPath: 'assets/default-avatar/layers/hair_back.svg',
      group: 'hair_back',
    },
    {
      id: 'base_body',
      zIndex: 20,
      assetPath: 'assets/default-avatar/layers/base_body.svg',
      group: 'torso',
    },
    {
      id: 'face_base',
      zIndex: 30,
      assetPath: 'assets/default-avatar/layers/face_base.svg',
      group: 'head',
    },
    {
      id: 'blush',
      zIndex: 40,
      assetPath: 'assets/default-avatar/layers/blush.svg',
      group: 'head',
    },
    {
      id: 'eyes_open',
      zIndex: 50,
      assetPath: 'assets/default-avatar/layers/eyes_open.svg',
      group: 'eyes',
    },
    {
      id: 'eyes_half',
      zIndex: 51,
      assetPath: 'assets/default-avatar/layers/eyes_half.svg',
      group: 'eyes',
    },
    {
      id: 'eyes_closed',
      zIndex: 52,
      assetPath: 'assets/default-avatar/layers/eyes_closed.svg',
      group: 'eyes',
    },
    {
      id: 'eyes_wink',
      zIndex: 53,
      assetPath: 'assets/default-avatar/layers/eyes_wink.svg',
      group: 'eyes',
    },
    {
      id: 'pupils',
      zIndex: 60,
      assetPath: 'assets/default-avatar/layers/pupils.svg',
      group: 'pupils',
    },
    {
      id: 'brows_13',
      zIndex: 70,
      assetPath: 'assets/default-avatar/layers/brows_13.svg',
      group: 'brows',
    },
    {
      id: 'mouth_visemes',
      zIndex: 80,
      assetPath: 'assets/default-avatar/layers/mouth_visemes.svg',
      group: 'mouth',
    },
    {
      id: 'hair_front',
      zIndex: 90,
      assetPath: 'assets/default-avatar/layers/hair_front.svg',
      group: 'hair_front',
    },
    {
      id: 'accessories_fx',
      zIndex: 100,
      assetPath: 'assets/default-avatar/layers/accessories_fx.svg',
      group: 'fx',
    },
  ],
  emotions: {
    neutral: {
      emotion: 'neutral',
      defaultEyeState: 'open',
      browPreset: 'neutral',
      accessoryFx: 'none',
      defaultMotion: 'idle',
    },
    happy: {
      emotion: 'happy',
      defaultEyeState: 'closed',
      browPreset: 'happy',
      accessoryFx: 'heart',
      defaultMotion: 'nod',
    },
    excited: {
      emotion: 'excited',
      defaultEyeState: 'open',
      browPreset: 'excited',
      accessoryFx: 'sparkle',
      defaultMotion: 'bounce',
    },
    smug: {
      emotion: 'smug',
      defaultEyeState: 'half',
      browPreset: 'smug',
      accessoryFx: 'none',
      defaultMotion: 'tease',
    },
    tease: {
      emotion: 'tease',
      defaultEyeState: 'wink',
      browPreset: 'tease',
      accessoryFx: 'heart',
      defaultMotion: 'tease',
    },
    chaotic: {
      emotion: 'chaotic',
      defaultEyeState: 'open',
      browPreset: 'chaotic',
      accessoryFx: 'chaos_aura',
      defaultMotion: 'laugh',
    },
    curious: {
      emotion: 'curious',
      defaultEyeState: 'open',
      browPreset: 'curious',
      accessoryFx: 'question',
      defaultMotion: 'nod',
    },
    think: {
      emotion: 'think',
      defaultEyeState: 'half',
      browPreset: 'think',
      accessoryFx: 'question',
      defaultMotion: 'think',
    },
    surprised: {
      emotion: 'surprised',
      defaultEyeState: 'open',
      browPreset: 'surprised',
      accessoryFx: 'sparkle',
      defaultMotion: 'bounce',
    },
    awkward: {
      emotion: 'awkward',
      defaultEyeState: 'half',
      browPreset: 'awkward',
      accessoryFx: 'sweat',
      defaultMotion: 'shrug',
    },
    concerned: {
      emotion: 'concerned',
      defaultEyeState: 'open',
      browPreset: 'concerned',
      accessoryFx: 'none',
      defaultMotion: 'idle',
    },
    sad: {
      emotion: 'sad',
      defaultEyeState: 'half',
      browPreset: 'sad',
      accessoryFx: 'sweat',
      defaultMotion: 'idle',
    },
    angry: {
      emotion: 'angry',
      defaultEyeState: 'open',
      browPreset: 'angry',
      accessoryFx: 'chaos_aura',
      defaultMotion: 'shake',
    },
  },
}

const LIVE2D_MODEL3_JSON = {
  Version: 3,
  FileReferences: {
    Moc: 'ashy-default.moc3',
    Textures: ['textures/ashy-cozy-studio-2048.png'],
    Physics: 'ashy-default.physics3.json',
    Expressions: ASHY_EMOTIONS.map((emotion) => ({
      Name: emotion,
      File: `expressions/${emotion}.exp3.json`,
    })),
    Motions: {
      Idle: [
        { File: 'motions/idle_breath_01.motion3.json' },
        { File: 'motions/idle_gaze_02.motion3.json' },
      ],
      TapBody: [
        { File: 'motions/tap_tease_01.motion3.json' },
        { File: 'motions/tap_shrug_02.motion3.json' },
      ],
      Speak: [{ File: 'motions/speak_nod_01.motion3.json' }],
      Tease: [{ File: 'motions/tease_wink_01.motion3.json' }],
      Chaotic: [{ File: 'motions/chaotic_bounce_01.motion3.json' }],
      Concerned: [{ File: 'motions/concerned_soft_01.motion3.json' }],
    },
  },
  HitAreas: [
    { Id: 'HitAreaHead', Name: 'Head' },
    { Id: 'HitAreaBody', Name: 'Body' },
  ],
}

const LAYER_SVGS = {
  hair_back: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 460" data-layer="hair_back"><defs><linearGradient id="ashy-hair-back-grad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#1e1b4b"/><stop offset="55%" stop-color="#4c1d95"/><stop offset="100%" stop-color="#be185d"/></linearGradient></defs><path d="M 88 210 C 84 105, 296 105, 292 210 C 296 315, 260 390, 232 420 C 190 400, 148 420, 120 390 C 94 345, 86 270, 88 210 Z" fill="url(#ashy-hair-back-grad)"/></svg>`,
  base_body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 460" data-layer="base_body"><defs><linearGradient id="ashy-jacket-grad" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#1e1b4b"/><stop offset="100%" stop-color="#0f172a"/></linearGradient></defs><path d="M 82 460 C 92 332, 138 294, 190 294 C 242 294, 288 332, 298 460 Z" fill="url(#ashy-jacket-grad)" stroke="#f472b6" stroke-width="2.2"/><path d="M 158 294 L 190 364 L 222 294 Z" fill="#f472b6" opacity="0.88"/></svg>`,
  face_base: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 460" data-layer="face_base"><path d="M 120 174 C 120 118, 260 118, 260 174 C 260 242, 225 284, 190 288 C 155 284, 120 242, 120 174 Z" fill="#fde8e8" stroke="#f9a8d4" stroke-width="1.4"/></svg>`,
  blush: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 460" data-layer="blush"><ellipse cx="144" cy="226" rx="17" ry="8.5" fill="#fb7185" opacity="0.55"/><ellipse cx="236" cy="226" rx="17" ry="8.5" fill="#fb7185" opacity="0.55"/></svg>`,
  eyes_open: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 460" data-layer="eyes_open"><ellipse cx="155" cy="196" rx="16" ry="13" fill="#ffffff" stroke="#312e81" stroke-width="2"/><ellipse cx="225" cy="196" rx="16" ry="13" fill="#ffffff" stroke="#312e81" stroke-width="2"/></svg>`,
  eyes_half: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 460" data-layer="eyes_half"><ellipse cx="155" cy="198" rx="16" ry="7" fill="#ffffff" stroke="#312e81" stroke-width="2"/><ellipse cx="225" cy="198" rx="16" ry="7" fill="#ffffff" stroke="#312e81" stroke-width="2"/></svg>`,
  eyes_closed: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 460" data-layer="eyes_closed"><path d="M 139 198 Q 155 186 171 198" fill="none" stroke="#312e81" stroke-width="3" stroke-linecap="round"/><path d="M 209 198 Q 225 186 241 198" fill="none" stroke="#312e81" stroke-width="3" stroke-linecap="round"/></svg>`,
  eyes_wink: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 460" data-layer="eyes_wink"><ellipse cx="155" cy="196" rx="16" ry="12" fill="#ffffff" stroke="#312e81" stroke-width="2"/><path d="M 209 198 Q 225 186 241 198" fill="none" stroke="#312e81" stroke-width="3" stroke-linecap="round"/></svg>`,
  pupils: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 460" data-layer="pupils"><circle cx="155" cy="196" r="8.5" fill="#9333ea"/><circle cx="152" cy="192" r="3" fill="#ffffff"/><circle cx="225" cy="196" r="8.5" fill="#9333ea"/><circle cx="222" cy="192" r="3" fill="#ffffff"/></svg>`,
  brows_13: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 460" data-layer="brows_13"><line x1="138" y1="168" x2="172" y2="168" stroke="#312e81" stroke-width="3.5" stroke-linecap="round"/><line x1="208" y1="168" x2="242" y2="168" stroke="#312e81" stroke-width="3.5" stroke-linecap="round"/></svg>`,
  mouth_visemes: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 460" data-layer="mouth_visemes"><g id="viseme-closed"><path d="M 174 248 Q 190 254 206 248" fill="none" stroke="#be185d" stroke-width="2.5" stroke-linecap="round"/></g><g id="viseme-A"><ellipse cx="190" cy="249" rx="14" ry="11" fill="#be185d" stroke="#831843" stroke-width="2"/></g><g id="viseme-E"><ellipse cx="190" cy="248" rx="16" ry="7" fill="#be185d" stroke="#831843" stroke-width="2"/></g><g id="viseme-I"><ellipse cx="190" cy="248" rx="18" ry="4.5" fill="#be185d" stroke="#831843" stroke-width="2"/></g><g id="viseme-O"><ellipse cx="190" cy="249" rx="10" ry="10" fill="#be185d" stroke="#831843" stroke-width="2"/></g><g id="viseme-U"><ellipse cx="190" cy="249" rx="7.5" ry="7.5" fill="#be185d" stroke="#831843" stroke-width="2"/></g></svg>`,
  hair_front: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 460" data-layer="hair_front"><path d="M 108 176 C 122 108, 258 108, 272 176 C 248 142, 222 158, 190 144 C 158 158, 132 142, 108 176 Z" fill="#5b21b6"/></svg>`,
  accessories_fx: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 460" data-layer="accessories_fx"><g id="fx-headset"><path d="M 112 190 A 78 78 0 0 1 268 190" fill="none" stroke="#f472b6" stroke-width="4"/></g><g id="fx-sparkle"><polygon points="282,126 286,138 298,142 286,146 282,158 278,146 266,142 278,138" fill="#fde047"/></g></svg>`,
}

function writeBundle(targetBaseDir) {
  const layersDir = path.join(targetBaseDir, 'layers')
  fs.mkdirSync(layersDir, { recursive: true })

  fs.writeFileSync(
    path.join(targetBaseDir, 'tachie-manifest.json'),
    JSON.stringify(TACHIE_MANIFEST, null, 2) + '\n',
    'utf8',
  )
  fs.writeFileSync(
    path.join(targetBaseDir, 'ashy-default.model3.json'),
    JSON.stringify(LIVE2D_MODEL3_JSON, null, 2) + '\n',
    'utf8',
  )

  for (const [id, svg] of Object.entries(LAYER_SVGS)) {
    fs.writeFileSync(path.join(layersDir, `${id}.svg`), svg + '\n', 'utf8')
  }
}

writeBundle(path.join(rootDir, 'assets/default-avatar'))
writeBundle(path.join(rootDir, 'apps/desktop/public/assets/default-avatar'))
console.log('Generated default-avatar bundle in assets/default-avatar and apps/desktop/public/assets/default-avatar')
