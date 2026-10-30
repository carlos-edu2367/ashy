import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ASHY_EMOTIONS, ASHY_MOTION_PRESETS, ASHY_VISEME_KEYS } from '@ashy/shared'
import {
  DEFAULT_ASHY_TACHIE_MANIFEST,
  DEFAULT_ASHY_LIVE2D_MODEL3_JSON,
  resolveTachieActiveLayers,
  computeMotionImpulseOffset,
  buildTachieLayerSvgMap,
  computeStageFrameState,
  inspectLive2DModelJson,
} from '../src/index'

describe('@ashy/stage — Phase 6 Digital Body & Presence Suite', () => {
  describe('1. Canonical Tachie Manifest, 13-Emotion Rig & On-Disk Assets', () => {
    it('defines all 13 canonical emotions, 13 layer files, and valid Live2D .model3.json on disk and in public mirror', () => {
      expect(DEFAULT_ASHY_TACHIE_MANIFEST.layers.length).toBe(13)
      for (const emotion of ASHY_EMOTIONS) {
        expect(DEFAULT_ASHY_TACHIE_MANIFEST.emotions[emotion]).toBeDefined()
      }

      const controls = inspectLive2DModelJson(DEFAULT_ASHY_LIVE2D_MODEL3_JSON)
      expect(controls.expressions).toEqual([...ASHY_EMOTIONS])
      expect(controls.motionGroups.length).toBeGreaterThanOrEqual(6)
      expect(controls.hitAreas).toEqual(['Head', 'Body'])

      const rootDir = path.resolve(__dirname, '../../..')
      const manifestPath = path.join(rootDir, 'assets/default-avatar/tachie-manifest.json')
      const model3Path = path.join(rootDir, 'assets/default-avatar/ashy-default.model3.json')
      const publicManifestPath = path.join(
        rootDir,
        'apps/desktop/public/assets/default-avatar/tachie-manifest.json',
      )
      const publicModel3Path = path.join(
        rootDir,
        'apps/desktop/public/assets/default-avatar/ashy-default.model3.json',
      )
      expect(fs.existsSync(manifestPath)).toBe(true)
      expect(fs.existsSync(model3Path)).toBe(true)
      expect(fs.existsSync(publicManifestPath)).toBe(true)
      expect(fs.existsSync(publicModel3Path)).toBe(true)

      const svgMap = buildTachieLayerSvgMap()
      for (const layer of DEFAULT_ASHY_TACHIE_MANIFEST.layers) {
        const fullLayerPath = path.join(rootDir, layer.assetPath)
        const publicLayerPath = path.join(rootDir, 'apps/desktop/public', layer.assetPath)
        expect(fs.existsSync(fullLayerPath)).toBe(true)
        expect(fs.existsSync(publicLayerPath)).toBe(true)
        expect(svgMap[layer.id]).toContain('<svg')
      }
    })

    it('resolves eye state (open/half/closed/wink), dominant viseme (closed/A/E/I/O/U), and motion impulse across all emotions', () => {
      // Tease emotion -> playful wink (Red-Team B3 guard)
      const teaseFrame = computeStageFrameState({
        emotion: 'tease',
        emotionIntensity: 0.9,
        isSpeaking: false,
      })
      const teaseLayers = resolveTachieActiveLayers(teaseFrame, 'tease')
      expect(teaseLayers.eyeState).toBe('wink')
      expect(teaseLayers.activeViseme).toBe('closed')
      expect(teaseLayers.motionPreset).toBe('tease')

      // Happy emotion -> closed eyes
      const happyFrame = computeStageFrameState({
        emotion: 'happy',
        emotionIntensity: 0.95,
        isSpeaking: false,
      })
      expect(resolveTachieActiveLayers(happyFrame).eyeState).toBe('closed')

      // Smug emotion -> half-lidded eyes
      const smugFrame = computeStageFrameState({
        emotion: 'smug',
        emotionIntensity: 0.9,
        isSpeaking: false,
      })
      expect(resolveTachieActiveLayers(smugFrame).eyeState).toBe('half')

      // Speaking vowel A -> activeViseme = 'A'
      const speakingFrame = computeStageFrameState({
        emotion: 'excited',
        emotionIntensity: 0.85,
        isSpeaking: true,
        vowels: { A: 0.65, E: 0.1, I: 0, O: 0.2, U: 0 },
      })
      const speakingLayers = resolveTachieActiveLayers(speakingFrame, 'bounce')
      expect(speakingLayers.activeViseme).toBe('A')
      expect(speakingLayers.eyeState).toBe('open')
      expect(speakingLayers.accessoryFx).toBe('sparkle')

      // Motion impulses remain finite for all 9 presets and adversarial elapsedSec
      for (const motion of ASHY_MOTION_PRESETS) {
        const imp = computeMotionImpulseOffset(motion, 0.25)
        expect(Number.isFinite(imp.x)).toBe(true)
        expect(Number.isFinite(imp.y)).toBe(true)
        expect(Number.isFinite(imp.rotationDeg)).toBe(true)
        expect(Number.isFinite(imp.scale)).toBe(true)

        const impNan = computeMotionImpulseOffset(motion, Number.NaN)
        expect(Number.isFinite(impNan.x)).toBe(true)
        expect(Number.isFinite(impNan.scale)).toBe(true)
      }
      expect(ASHY_VISEME_KEYS).toContain(speakingLayers.activeViseme)
    })
  })
})
