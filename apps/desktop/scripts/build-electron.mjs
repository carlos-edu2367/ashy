import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { build } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(desktopDir, '../..')
const buildResourcesDir = path.join(desktopDir, 'build')

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcInput = Buffer.concat([typeBuf, data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

/**
 * Generates a deterministic Cozy Night Studio RGBA PNG icon (deep indigo + warm amber/lavender glow).
 */
function generateAshyPngBuffer(width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth 8
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  const cx = (width - 1) / 2
  const cy = (height - 1) / 2
  const maxR = Math.min(width, height) / 2

  for (let y = 0; y < height; y++) {
    const rowOffset = y * stride
    raw[rowOffset] = 0 // filter: None
    for (let x = 0; x < width; x++) {
      const dx = x - cx
      const dy = y - cy
      const dist = Math.hypot(dx, dy)
      const pxOffset = rowOffset + 1 + x * 4

      if (dist > maxR) {
        raw[pxOffset] = 0
        raw[pxOffset + 1] = 0
        raw[pxOffset + 2] = 0
        raw[pxOffset + 3] = 0
      } else {
        const t = Math.max(0, Math.min(1, 1 - dist / maxR))
        // Cozy Night Studio palette (#13111C -> #C4B5FD / #F59E0B core)
        raw[pxOffset] = Math.round(19 + 226 * Math.pow(t, 1.6))
        raw[pxOffset + 1] = Math.round(17 + 141 * Math.pow(t, 1.4))
        raw[pxOffset + 2] = Math.round(28 + 225 * Math.pow(t, 1.1))
        raw[pxOffset + 3] = 255
      }
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 })
  const iend = Buffer.alloc(0)

  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', iend),
  ])
}

/**
 * Wraps a PNG buffer into a valid Windows .ico container.
 */
function wrapPngAsIco(pngBuf, width, height) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // Reserved
  header.writeUInt16LE(1, 2) // Type 1 = ICO
  header.writeUInt16LE(1, 4) // 1 image

  const entry = Buffer.alloc(16)
  entry[0] = width >= 256 ? 0 : width
  entry[1] = height >= 256 ? 0 : height
  entry[2] = 0 // palette
  entry[3] = 0 // reserved
  entry.writeUInt16LE(1, 4) // color planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8) // size of PNG data
  entry.writeUInt32LE(22, 12) // offset (6 + 16)

  return Buffer.concat([header, entry, pngBuf])
}

function ensureBuildIcons() {
  fs.mkdirSync(buildResourcesDir, { recursive: true })

  const iconPngPath = path.join(buildResourcesDir, 'icon.png')
  const iconIcoPath = path.join(buildResourcesDir, 'icon.ico')
  const trayIconPngPath = path.join(buildResourcesDir, 'tray-icon.png')

  const icon256Png = generateAshyPngBuffer(256, 256)
  const tray24Png = generateAshyPngBuffer(24, 24)

  fs.writeFileSync(iconPngPath, icon256Png)
  fs.writeFileSync(iconIcoPath, wrapPngAsIco(icon256Png, 256, 256))
  fs.writeFileSync(trayIconPngPath, tray24Png)
}

const workspaceAliases = {
  '@ashy/shared': path.resolve(repoRoot, 'packages/shared/src/index.ts'),
  '@ashy/bus': path.resolve(repoRoot, 'packages/bus/src/index.ts'),
  '@ashy/llm': path.resolve(repoRoot, 'packages/llm/src/index.ts'),
  '@ashy/cortex': path.resolve(repoRoot, 'packages/cortex/src/index.ts'),
  '@ashy/voice': path.resolve(repoRoot, 'packages/voice/src/index.ts'),
  '@ashy/stage': path.resolve(repoRoot, 'packages/stage/src/index.ts'),
  '@ashy/agency': path.resolve(repoRoot, 'packages/agency/src/index.ts'),
  '@ashy/evals': path.resolve(repoRoot, 'packages/evals/src/index.ts'),
}

const externalModules = [
  'electron',
  'node:sqlite',
  'node:fs',
  'node:path',
  'node:crypto',
  'node:http',
  'node:https',
  'node:child_process',
  'node:os',
  'node:url',
  'node:util',
  'node:events',
  'node:stream',
  'node:buffer',
  'node:zlib',
  'fs',
  'path',
  'crypto',
  'http',
  'https',
  'child_process',
  'os',
  'url',
  'util',
  'events',
  'stream',
  'buffer',
  'zlib',
]

async function buildElectronBundles() {
  ensureBuildIcons()

  // 1. Bundle Electron Main Process -> dist/main/index.mjs
  await build({
    configFile: false,
    root: desktopDir,
    logLevel: 'warn',
    resolve: {
      alias: workspaceAliases,
    },
    build: {
      outDir: path.join(desktopDir, 'dist/main'),
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      sourcemap: false,
      lib: {
        entry: path.join(desktopDir, 'src/main/index.ts'),
        formats: ['es'],
        fileName: () => 'index.mjs',
      },
      rollupOptions: {
        external: externalModules,
      },
    },
  })

  // 2. Bundle Electron Preload Script -> dist/preload/index.cjs
  await build({
    configFile: false,
    root: desktopDir,
    logLevel: 'warn',
    resolve: {
      alias: workspaceAliases,
    },
    build: {
      outDir: path.join(desktopDir, 'dist/preload'),
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      sourcemap: false,
      lib: {
        entry: path.join(desktopDir, 'src/preload/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs',
      },
      rollupOptions: {
        external: externalModules,
      },
    },
  })

  console.log('✅ Built Electron main (dist/main/index.mjs), preload (dist/preload/index.cjs), and build icons.')
}

buildElectronBundles().catch((err) => {
  console.error('❌ Failed to build Electron bundles:', err)
  process.exit(1)
})
