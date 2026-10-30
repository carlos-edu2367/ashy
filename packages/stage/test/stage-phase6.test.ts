import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
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
  extractCanvasSilhouetteMask128x72,
  buildDynamicAvatarSilhouetteMask,
  computeLive2DParameterMap,
  renderTachieStageToCanvas,
  AshyStageCanvas,
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

  describe('3. Multi-Layer Tachie/Live2D Compositor, 4 Hz Dynamic Silhouette & Deduplicated Click-Through', () => {
    it('extracts a 128x72 silhouette mask from RGBA image data or dynamic head/torso pose offsets', () => {
      const rgbaWidth = 256
      const rgbaHeight = 144
      const rgba = new Uint8ClampedArray(rgbaWidth * rgbaHeight * 4)
      // Paint opaque pixel block in the top-left quadrant (col 10..20, row 10..20)
      for (let r = 10; r < 20; r++) {
        for (let c = 10; c < 20; c++) {
          const idx = (r * rgbaWidth + c) * 4
          rgba[idx] = 240
          rgba[idx + 1] = 160
          rgba[idx + 2] = 180
          rgba[idx + 3] = 255
        }
      }

      const mask = extractCanvasSilhouetteMask128x72(rgba, rgbaWidth, rgbaHeight)
      expect(mask.length).toBe(128 * 72)
      expect(mask[7 * 128 + 7]).toBe(255)
      expect(mask[60 * 128 + 110]).toBe(0)

      // Empty/invalid dimensions guard
      const emptyMask = extractCanvasSilhouetteMask128x72(new Uint8Array(0), 0, 0)
      expect(emptyMask.length).toBe(128 * 72)

      // Dynamic pose mask shifts with headTx / headTy
      const shiftedMask = buildDynamicAvatarSilhouetteMask({
        headTx: 38,
        headTy: -20,
        viewportWidth: 380,
        viewportHeight: 460,
      })
      expect(shiftedMask.length).toBe(128 * 72)

      // Live2D parameter map computation
      const frame = computeStageFrameState({
        emotion: 'chaotic',
        emotionIntensity: 0.9,
        isSpeaking: true,
        vowels: { A: 0.8, E: 0, I: 0, O: 0, U: 0 },
      })
      const live2dParams = computeLive2DParameterMap(frame)
      expect(live2dParams.ParamMouthOpenY).toBeGreaterThan(0.5)
      expect(Number.isFinite(live2dParams.ParamEyeLOpen)).toBe(true)
      expect(Number.isFinite(live2dParams.ParamAngleX)).toBe(true)
    })

    it('renders visible Tachie layers, active viseme/eye/motion attributes, and Live2D parameter HUD in AshyStageCanvas', () => {
      const tachieHtml = renderToStaticMarkup(
        React.createElement(AshyStageCanvas, {
          emotion: 'smug',
          emotionIntensity: 0.9,
          isSpeaking: true,
          rawVowels: { A: 0.85, E: 0.2, I: 0, O: 0, U: 0 },
          rawVolume: 0.85,
          motionPreset: 'tease',
          mode: 'tachie',
        }),
      )
      expect(tachieHtml).toContain('data-testid="ashy-stage-render-canvas"')
      expect(tachieHtml).toContain('data-testid="ashy-tachie-svg"')
      expect(tachieHtml).toContain('data-active-viseme="A"')
      expect(tachieHtml).toContain('data-motion-preset="tease"')
      // Must NOT have opacity:0.01 on the Tachie SVG in Phase 6
      expect(tachieHtml).not.toContain('opacity:0.01')

      const live2dHtml = renderToStaticMarkup(
        React.createElement(AshyStageCanvas, {
          emotion: 'chaotic',
          mode: 'live2d',
          isSpeaking: false,
          transparentBackground: true,
        }),
      )
      expect(live2dHtml).toContain('data-testid="live2d-parameter-hud"')
      expect(live2dHtml).toContain('ParamMouthOpenY')
      expect(typeof renderTachieStageToCanvas).toBe('function')

      // Verify renderTachieStageToCanvas draws layers cleanly and survives partial mocks
      const calls: string[] = []
      const mockCtx = {
        clearRect: () => calls.push('clearRect'),
        save: () => calls.push('save'),
        scale: () => calls.push('scale'),
        beginPath: () => calls.push('beginPath'),
        ellipse: () => calls.push('ellipse'),
        arc: () => calls.push('arc'),
        fill: () => calls.push('fill'),
        restore: () => calls.push('restore'),
        fillStyle: '',
      } as unknown as CanvasRenderingContext2D

      const testFrame = computeStageFrameState({
        emotion: 'tease',
        emotionIntensity: 0.9,
        isSpeaking: true,
        vowels: { A: 0.7, E: 0, I: 0, O: 0, U: 0 },
      })
      const testLayers = resolveTachieActiveLayers(testFrame, 'tease')
      renderTachieStageToCanvas(mockCtx, testFrame, testLayers, 380, 460)
      expect(calls).toContain('clearRect')
      expect(calls).toContain('ellipse')
      expect(calls).toContain('fill')
      expect(calls).toContain('restore')
    })
  })
})
