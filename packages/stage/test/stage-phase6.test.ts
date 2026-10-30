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
  synthesizeFormantVowelPcm,
  analyzePcmFrameToVowels,
  createStageSpeechSynchronizer,
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

  describe('2. Acoustic Lip-Sync Analyzer (Formants/ZCR/RMS) & <|ACT|> Audio Timeline Sync', () => {
    it('extracts distinct dominant vowels (A, E, I, O, U) and sibilant S from raw PCM formant waveforms', () => {
      const sampleRate = 16000
      for (const targetVowel of ['A', 'E', 'I', 'O', 'U'] as const) {
        const pcm = synthesizeFormantVowelPcm(targetVowel, 60, sampleRate)
        const analyzed = analyzePcmFrameToVowels(pcm, sampleRate)
        expect(analyzed.rawVolume).toBeGreaterThan(0.15)
        expect(analyzed.dominantVowel).toBe(targetVowel)
        expect(analyzed.rawVowels[targetVowel]).toBeGreaterThan(0.45)
      }

      // High-ZCR sibilant noise ('S') maps strongly to rawVowels.S and feeds I in WinnerRunnerUpVowelDriver
      const sibilantPcm = synthesizeFormantVowelPcm('S', 60, sampleRate)
      const sibilantFrame = analyzePcmFrameToVowels(sibilantPcm, sampleRate)
      expect(sibilantFrame.rawVowels.S).toBeGreaterThan(0.5)
      expect(sibilantFrame.zeroCrossingRate).toBeGreaterThan(0.25)

      // Silence / NaN / Infinity safety
      const silentFrame = analyzePcmFrameToVowels(new Float32Array(320), sampleRate)
      expect(silentFrame.rawVolume).toBe(0)
      expect(silentFrame.dominantVowel).toBeNull()

      const poisoned = new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, -999, 0])
      const safePoison = analyzePcmFrameToVowels(poisoned, sampleRate)
      expect(Number.isFinite(safePoison.rawVolume)).toBe(true)
      expect(Number.isFinite(safePoison.rawVowels.A)).toBe(true)
    })

    it('synchronizes multi-<|ACT|> keyframes and acoustic vowel frames along the TTS audio playback clock', () => {
      const sampleRate = 16000
      const segA = synthesizeFormantVowelPcm('A', 200, sampleRate)
      const segO = synthesizeFormantVowelPcm('O', 200, sampleRate)
      const combined = new Float32Array(segA.length + segO.length)
      combined.set(segA, 0)
      combined.set(segO, segA.length)

      const sync = createStageSpeechSynchronizer({
        samples: combined,
        sampleRate,
        actKeyframes: [
          { atMs: 0, emotion: 'smug', intensity: 0.8, motion: 'tease' },
          { atMs: 200, emotion: 'excited', intensity: 0.95, motion: 'bounce' },
        ],
      })

      const at50ms = sync.sampleAt(50)
      expect(at50ms.isSpeaking).toBe(true)
      expect(at50ms.emotion).toBe('smug')
      expect(at50ms.motion).toBe('tease')
      expect(at50ms.acoustic.dominantVowel).toBe('A')
      expect(at50ms.driverFrame.winner).toBe('A')

      const at260ms = sync.sampleAt(260)
      expect(at260ms.isSpeaking).toBe(true)
      expect(at260ms.emotion).toBe('excited')
      expect(at260ms.motion).toBe('bounce')
      expect(at260ms.acoustic.dominantVowel).toBe('O')
      expect(at260ms.driverFrame.winner).toBe('O')

      const afterEnd = sync.sampleAt(500)
      expect(afterEnd.isSpeaking).toBe(false)
    })
  })
})
