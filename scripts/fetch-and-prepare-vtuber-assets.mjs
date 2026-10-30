#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const CUBISM_CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'
const CUBISM_CORE_DEST = path.join(rootDir, 'apps/desktop/public/live2d/live2dcubismcore.min.js')

const LIVE2D_MODELS = [
  { id: 'hiyori', dir: 'Hiyori', file: 'Hiyori.model3.json' },
  { id: 'haru', dir: 'Haru', file: 'Haru.model3.json' },
  { id: 'mao', dir: 'Mao', file: 'Mao.model3.json' },
]

function hasValidFile(filePath, minBytes = 1) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size >= minBytes
  } catch {
    return false
  }
}

async function fetchBufferWithFallback(urls) {
  let lastErr = null
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Ashy-VTuber-Asset-Fetcher/1.0' },
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`)
      }
      const arrayBuf = await res.arrayBuffer()
      const buf = Buffer.from(arrayBuf)
      if (buf.length === 0) {
        throw new Error(`Empty response (0 bytes) for ${url}`)
      }
      return buf
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error(`Failed to fetch from any candidate URL: ${urls.join(', ')}`)
}

async function ensureCubismCore() {
  if (hasValidFile(CUBISM_CORE_DEST, 100_000)) {
    console.log(`[vtuber-assets] Cubism Core already present (${fs.statSync(CUBISM_CORE_DEST).size} bytes)`)
    return
  }
  fs.mkdirSync(path.dirname(CUBISM_CORE_DEST), { recursive: true })
  console.log(`[vtuber-assets] Downloading live2dcubismcore.min.js...`)
  const buf = await fetchBufferWithFallback([CUBISM_CORE_URL])
  if (buf.length < 100_000) {
    throw new Error(`Downloaded live2dcubismcore.min.js is unexpectedly small (${buf.length} bytes)`)
  }
  fs.writeFileSync(CUBISM_CORE_DEST, buf)
  console.log(`[vtuber-assets] Saved live2dcubismcore.min.js (${buf.length} bytes)`)
}

function collectAndSanitizeModelReferences(modelJson) {
  const refs = new Set()
  const fileRefs = modelJson?.FileReferences
  if (!fileRefs || typeof fileRefs !== 'object') {
    return []
  }

  for (const singleKey of ['Moc', 'Physics', 'Pose', 'DisplayInfo', 'UserData']) {
    if (typeof fileRefs[singleKey] === 'string' && fileRefs[singleKey].trim().length > 0) {
      refs.add(fileRefs[singleKey].trim())
    }
  }

  if (Array.isArray(fileRefs.Textures)) {
    for (const tex of fileRefs.Textures) {
      if (typeof tex === 'string' && tex.trim().length > 0) {
        refs.add(tex.trim())
      }
    }
  }

  if (Array.isArray(fileRefs.Expressions)) {
    for (const expr of fileRefs.Expressions) {
      if (expr && typeof expr.File === 'string' && expr.File.trim().length > 0) {
        refs.add(expr.File.trim())
      }
    }
  }

  if (fileRefs.Motions && typeof fileRefs.Motions === 'object') {
    for (const group of Object.values(fileRefs.Motions)) {
      if (!Array.isArray(group)) continue
      for (const motion of group) {
        if (!motion || typeof motion !== 'object') continue
        // Red-Team B5: Strip Sound references from Motions so missing .wav files never 404
        if ('Sound' in motion) {
          delete motion.Sound
        }
        if (typeof motion.File === 'string' && motion.File.trim().length > 0) {
          refs.add(motion.File.trim())
        }
      }
    }
  }

  return [...refs]
}

async function runWithConcurrency(items, concurrency, worker) {
  const queue = [...items]
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift()
      if (next !== undefined) {
        await worker(next)
      }
    }
  })
  await Promise.all(runners)
}

async function ensureLive2DModel(modelDef) {
  const { id, dir, file } = modelDef
  const primaryBase = `https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources/${dir}/`
  const fallbackBase = `https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@4-r.7/Samples/Resources/${dir}/`
  const modelDir = path.join(rootDir, 'apps/desktop/public/live2d/models', id)
  fs.mkdirSync(modelDir, { recursive: true })

  const localModelJsonPath = path.join(modelDir, file)
  let modelJson
  if (hasValidFile(localModelJsonPath, 20)) {
    modelJson = JSON.parse(fs.readFileSync(localModelJsonPath, 'utf8'))
  } else {
    console.log(`[vtuber-assets] Fetching ${file} for ${id}...`)
    const rawBuf = await fetchBufferWithFallback([
      `${primaryBase}${file}`,
      `${fallbackBase}${file}`,
    ])
    modelJson = JSON.parse(rawBuf.toString('utf8'))
  }

  const relativeFiles = collectAndSanitizeModelReferences(modelJson)
  // Always write sanitized .model3.json (with Sound keys stripped per Red-Team B5)
  fs.writeFileSync(localModelJsonPath, JSON.stringify(modelJson, null, 2) + '\n', 'utf8')

  await runWithConcurrency(relativeFiles, 6, async (relPath) => {
    const safeRel = relPath.replace(/^[/\\]+/, '')
    const targetPath = path.join(modelDir, safeRel)
    if (hasValidFile(targetPath, 1)) {
      return
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    const encodedRel = safeRel
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')
    const buf = await fetchBufferWithFallback([
      `${primaryBase}${encodedRel}`,
      `${fallbackBase}${encodedRel}`,
    ])
    fs.writeFileSync(targetPath, buf)
    console.log(`[vtuber-assets] Downloaded ${id}/${safeRel} (${buf.length} bytes)`)
  })
}

function ensurePngTuberSprites() {
  const publicSpritesDir = path.join(rootDir, 'apps/desktop/public/assets/default-avatar/sprites')
  const rootSpritesDir = path.join(rootDir, 'assets/default-avatar/sprites')
  fs.mkdirSync(publicSpritesDir, { recursive: true })
  fs.mkdirSync(rootSpritesDir, { recursive: true })

  const heroFallback = path.join(rootDir, 'apps/desktop/public/assets/ashy-hero.jpg')
  const concernedFallback = path.join(rootDir, 'apps/desktop/public/assets/ashy-concerned.jpg')

  const spriteSpecs = [
    { file: 'ashy-eyes-open-mouth-closed.png', fallback: heroFallback },
    { file: 'ashy-eyes-open-mouth-open.png', fallback: heroFallback },
    { file: 'ashy-eyes-open-mouth-smile.png', fallback: heroFallback },
    { file: 'ashy-eyes-closed-mouth-closed.png', fallback: heroFallback },
    { file: 'ashy-eyes-closed-mouth-open.png', fallback: heroFallback },
    { file: 'ashy-concerned.png', fallback: concernedFallback },
  ]

  for (const spec of spriteSpecs) {
    const publicTarget = path.join(publicSpritesDir, spec.file)
    const rootTarget = path.join(rootSpritesDir, spec.file)

    // Never overwrite existing non-empty PNG in publicSpritesDir (protects concurrent AI generation)
    if (!hasValidFile(publicTarget, 1)) {
      if (hasValidFile(rootTarget, 1)) {
        fs.copyFileSync(rootTarget, publicTarget)
      } else if (hasValidFile(spec.fallback, 1)) {
        fs.copyFileSync(spec.fallback, publicTarget)
      }
    }

    // Mirror from publicSpritesDir to rootSpritesDir without overwriting if rootTarget already matches size
    if (hasValidFile(publicTarget, 1)) {
      const pubSize = fs.statSync(publicTarget).size
      const rootSize = hasValidFile(rootTarget, 1) ? fs.statSync(rootTarget).size : -1
      if (pubSize !== rootSize) {
        fs.copyFileSync(publicTarget, rootTarget)
      }
    }
  }
}

async function main() {
  await ensureCubismCore()
  for (const modelDef of LIVE2D_MODELS) {
    await ensureLive2DModel(modelDef)
  }
  ensurePngTuberSprites()
  console.log('[vtuber-assets] All Live2D Cubism 4 models and PNGTuber sprites ready.')
}

main().catch((err) => {
  console.error('[vtuber-assets] Fatal error:', err)
  process.exit(1)
})
