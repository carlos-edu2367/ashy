/**
 * Phase 10.3 — T3 (main): `ScreenCaptureProvider` over Electron `desktopCapturer` — source choice
 * (primary display / active window title), Ashy's own windows excluded, null when nothing matches,
 * and registration with the kernel in `bootAshyElectronMain`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// `../main/index` is imported lazily in test 4 (it pulls the whole host kernel).
import {
  SCREEN_CAPTURE_THUMBNAIL_SIZE,
  createScreenCaptureProvider,
  type DesktopCapturerSourceLike,
  type ElectronDesktopCapturerLike,
  type ScreenCaptureProvider,
} from '../main/screen-capture'


function source(id: string, name: string, extra: Partial<DesktopCapturerSourceLike> = {}): DesktopCapturerSourceLike {
  return {
    id,
    name,
    thumbnail: { toPNG: () => Buffer.from(`png:${id}`), isEmpty: () => false },
    ...extra,
  }
}

function fakeCapturer(byType: Record<'screen' | 'window', DesktopCapturerSourceLike[]>) {
  const getSources = vi.fn(async (opts: { types: Array<'screen' | 'window'> }) => byType[opts.types[0]!] ?? [])
  return { getSources } satisfies ElectronDesktopCapturerLike
}

const png = (id: string) => Buffer.from(`png:${id}`).toString('base64')

describe('Phase 10.3 — main ScreenCaptureProvider', () => {
  it('1. screen mode picks the primary display (display_id), else the first screen, 1280×720 PNG base64', async () => {
    const capturer = fakeCapturer({
      screen: [
        source('screen:1:0', 'Tela 1', { display_id: '111' }),
        source('screen:2:0', 'Tela 2', { display_id: '222' }),
      ],
      window: [],
    })
    const provider = createScreenCaptureProvider({
      desktopCapturer: capturer,
      screen: { getPrimaryDisplay: () => ({ id: 222 }) },
    })
    await expect(provider.capture('screen')).resolves.toEqual({ pngBase64: png('screen:2:0'), source: 'screen' })
    expect(capturer.getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 },
    })
    expect(SCREEN_CAPTURE_THUMBNAIL_SIZE).toEqual({ width: 1280, height: 720 })

    const noMatch = createScreenCaptureProvider({
      desktopCapturer: capturer,
      screen: { getPrimaryDisplay: () => ({ id: 999 }) },
    })
    await expect(noMatch.capture('screen')).resolves.toEqual({ pngBase64: png('screen:1:0'), source: 'screen' })
  })

  it('2. window mode matches the active title (exact, then case-insensitive contains) and never returns an Ashy window', async () => {
    const ownHub = { getTitle: () => 'ashy — Companhia no seu ritmo', getMediaSourceId: () => 'window:10:0' }
    const ownOverlay = { getTitle: () => 'Ashy Overlay', getMediaSourceId: () => 'window:11:0' }
    const capturer = fakeCapturer({
      screen: [],
      window: [
        source('window:10:0', 'ashy — Companhia no seu ritmo'),
        source('window:11:0', 'Notas.txt - Bloco de notas'), // same title as the user's app, but Ashy's id
        source('window:20:0', 'notas.txt - bloco de notas'),
        source('window:21:0', 'README.md - ashy - Visual Studio Code'),
      ],
    })
    const provider = createScreenCaptureProvider({
      desktopCapturer: capturer,
      getOwnWindows: () => [ownHub, ownOverlay, null],
    })

    // Exact match on window:11 is excluded (Ashy's media source id) → case-insensitive match.
    await expect(provider.capture('window', 'Notas.txt - Bloco de notas')).resolves.toEqual({
      pngBase64: png('window:20:0'),
      source: 'window',
    })
    // Contains (case-insensitive).
    await expect(provider.capture('window', 'visual studio code')).resolves.toEqual({
      pngBase64: png('window:21:0'),
      source: 'window',
    })
    // The active window is Ashy itself → refuse.
    await expect(provider.capture('window', 'ashy — Companhia no seu ritmo')).resolves.toBeNull()
    await expect(provider.capture('window', 'Ashy Overlay')).resolves.toBeNull()
    expect(capturer.getSources).toHaveBeenCalledWith({
      types: ['window'],
      thumbnailSize: { width: 1280, height: 720 },
    })
  })

  it('3. returns null with no match, no title, empty thumbnails, an unknown mode or a capturer error', async () => {
    const capturer = fakeCapturer({
      screen: [source('screen:1:0', 'Tela', { thumbnail: { toPNG: () => Buffer.alloc(0), isEmpty: () => true } })],
      window: [source('window:1:0', 'Chrome')],
    })
    const provider = createScreenCaptureProvider({ desktopCapturer: capturer })
    await expect(provider.capture('window', 'Spotify')).resolves.toBeNull()
    await expect(provider.capture('window')).resolves.toBeNull()
    await expect(provider.capture('window', '   ')).resolves.toBeNull()
    await expect(provider.capture('screen')).resolves.toBeNull()
    await expect(provider.capture('off' as never)).resolves.toBeNull()

    const broken = createScreenCaptureProvider({
      desktopCapturer: { getSources: vi.fn(async () => Promise.reject(new Error('denied'))) },
    })
    await expect(broken.capture('screen')).resolves.toBeNull()
  })

  it('4. bootAshyElectronMain registers the provider with the kernel and unregisters it on shutdown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-p10-3-main-'))
    const setScreenCaptureProvider = vi.fn((_p: ScreenCaptureProvider | null) => undefined)
    const kernel = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      onHostEvent: vi.fn(() => () => undefined),
      activatePrivacyShield: vi.fn(async () => undefined),
      setScreenCaptureProvider,
    }
    class FakeWin {
      webContents = {
        id: 1,
        isDestroyed: () => false,
        send: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      }
      loadURL = vi.fn(async () => undefined)
      setAlwaysOnTop = vi.fn()
      setIgnoreMouseEvents = vi.fn()
      getTitle = () => 'ashy — Companhia no seu ritmo'
      getMediaSourceId = () => 'window:1:0'
      on = vi.fn()
    }
    const capturer = fakeCapturer({
      screen: [source('screen:0:0', 'Tela', { display_id: '1' })],
      window: [source('window:1:0', 'ashy — Companhia no seu ritmo'), source('window:2:0', 'Paint')],
    })
    const { bootAshyElectronMain } = await import('../main/index')
    const booted = await bootAshyElectronMain({
      app: { getPath: () => dir, on: vi.fn() },
      BrowserWindow: FakeWin as never,
      ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
      rendererUrl: 'http://localhost:5173',
      kernel: kernel as never,
      desktopCapturer: capturer,
      screen: { getPrimaryDisplay: () => ({ id: 1 }) },
      processRef: { once: vi.fn(), removeListener: vi.fn() } as never,
    })
    try {
      expect(setScreenCaptureProvider).toHaveBeenCalledTimes(1)
      const provider = setScreenCaptureProvider.mock.calls[0]![0]!
      await expect(provider.capture('screen')).resolves.toEqual({ pngBase64: png('screen:0:0'), source: 'screen' })
      await expect(provider.capture('window', 'Paint')).resolves.toEqual({ pngBase64: png('window:2:0'), source: 'window' })
      // Hub/overlay are excluded by media source id + title.
      await expect(provider.capture('window', 'ashy — Companhia no seu ritmo')).resolves.toBeNull()
    } finally {
      await booted.shutdown()
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(setScreenCaptureProvider).toHaveBeenLastCalledWith(null)
  })
})

