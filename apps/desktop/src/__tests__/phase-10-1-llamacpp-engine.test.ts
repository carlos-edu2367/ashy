import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIVE_MODE_SETTINGS,
  LLAMACPP_PINNED_BUILD,
  type AshyHostStreamEvent,
  type LiveLocalModelSpec,
  type LiveModeSettings,
  type LlamaCppEngineStatus,
  type LlamaCppVariant,
  type PinnedDownloadAsset,
} from '@ashy/shared'
import {
  createLlamaCppEngine,
  isPinnedAsset,
  isSafeArchiveEntry,
  type CreateLlamaCppEngineOptions,
  type LlamaCppCatalog,
  type LlamaCppChildProcess,
  type LlamaCppExecImpl,
  type LlamaCppSpawnImpl,
  VC_REDIST_CANCELLED_MESSAGE,
  VC_REDIST_URL,
  VC_RUNTIME_DLLS,
  isMicrosoftDownloadHost,
  isMicrosoftSignerSubject,
  psSingleQuote,
} from '../host/engines/llamacpp-engine'
import { registerEngineHandlers } from '../host/engines/handlers'
import { createAshyHostKernel, type AshyHostKernel } from '../host/kernel'
import { createLiveModeSettingsStore } from '../host/live-call/settings'

// ───────────────────────────── fixtures ─────────────────────────────

const tempDirs: string[] = []
const kernels: AshyHostKernel[] = []
const engines: Array<{ dispose(): Promise<void> }> = []

function tmpDir(prefix = 'ashy-llamacpp-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (engines.length > 0) await engines.pop()!.dispose()
  while (kernels.length > 0) await kernels.pop()!.stop()
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

function makeAsset(fileName: string, content: Buffer, base = 'https://dl.example.test/'): PinnedDownloadAsset {
  return { url: `${base}${fileName}`, fileName, sizeBytes: content.length, sha256: sha(content) }
}

const MODEL_BYTES = Buffer.from('GGUF-model-'.repeat(500))
const MMPROJ_BYTES = Buffer.from('GGUF-mmproj-'.repeat(700))
const LLAMA_ZIP = Buffer.from('zip-llama-'.repeat(300))
const CUDART_ZIP = Buffer.from('zip-cudart-'.repeat(200))
const CPU_ZIP = Buffer.from('zip-cpu-'.repeat(100))
const VULKAN_ZIP = Buffer.from('zip-vulkan-'.repeat(100))

const modelAsset = makeAsset('Test-Q4_K_M.gguf', MODEL_BYTES)
const mmprojAsset = makeAsset('mmproj-Test-Q8_0.gguf', MMPROJ_BYTES)
const testModel: LiveLocalModelSpec = {
  id: 'test-omni',
  label: 'Test Omni',
  repo: 'TestOrg/Test-GGUF',
  revision: 'abc',
  model: modelAsset,
  mmproj: mmprojAsset,
  contextSize: 4096,
  capabilities: { audioIn: true, audioOut: true, imageIn: true, tools: false },
}
const releaseAssets: Record<LlamaCppVariant, PinnedDownloadAsset[]> = {
  'cuda-12.4': [makeAsset('llama-cuda.zip', LLAMA_ZIP), makeAsset('cudart.zip', CUDART_ZIP)],
  vulkan: [makeAsset('llama-vulkan.zip', VULKAN_ZIP)],
  cpu: [makeAsset('llama-cpu.zip', CPU_ZIP)],
}
const catalog: LlamaCppCatalog = { releaseAssets, models: [testModel] }

const ZIP_ENTRIES: Record<string, string[]> = {
  'llama-cuda.zip': ['llama-server.exe', 'ggml-cuda.dll', 'llama.dll'],
  'cudart.zip': ['cudart64_12.dll', 'cublas64_12.dll'],
  'llama-vulkan.zip': ['llama-server.exe', 'ggml-vulkan.dll'],
  'llama-cpu.zip': ['llama-server.exe', 'ggml-cpu.dll'],
}

interface FetchCall {
  url: string
  headers: Record<string, string>
}

function createFakeFetch(config: {
  files?: Record<string, Buffer>
  ignoreRange?: boolean
  redirects?: Record<string, string>
  health?: (url: string) => number
}) {
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) }
    calls.push({ url, headers })
    if (url.endsWith('/health')) {
      const status = config.health?.(url) ?? 200
      return new Response(status === 200 ? '{"status":"ok"}' : '{"error":"loading"}', { status })
    }
    const redirect = config.redirects?.[url]
    if (redirect) {
      return new Response(null, { status: 302, headers: { location: redirect } })
    }
    const body = config.files?.[url]
    if (!body) return new Response('not found', { status: 404 })
    const range = headers.Range
    if (range && !config.ignoreRange) {
      const start = Number.parseInt(/bytes=(\d+)-/.exec(range)![1]!, 10)
      return new Response(new Uint8Array(body.subarray(start)), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` },
      })
    }
    return new Response(new Uint8Array(body), { status: 200 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function createFakeExec(config: {
  nvidia?: string | null
  cim?: unknown
  zipEntries?: Record<string, string[]>
}) {
  const calls: Array<{ command: string; args: string[] }> = []
  const execImpl: LlamaCppExecImpl = async (command, args) => {
    calls.push({ command, args })
    if (command === 'nvidia-smi') {
      if (config.nvidia == null) throw new Error('nvidia-smi not found')
      return { stdout: config.nvidia, stderr: '' }
    }
    if (command === 'powershell.exe') {
      if (config.cim === undefined) throw new Error('powershell failed')
      return { stdout: JSON.stringify(config.cim), stderr: '' }
    }
    if (command === 'tar') {
      const entries = (config.zipEntries ?? ZIP_ENTRIES)[path.basename(args[1]!)] ?? []
      if (args[0] === '-tf') return { stdout: `${entries.join('\r\n')}\r\n`, stderr: '' }
      if (args[0] === '-xf') {
        const target = args[3]!
        for (const entry of entries) {
          const out = path.join(target, entry)
          fs.mkdirSync(path.dirname(out), { recursive: true })
          fs.writeFileSync(out, `fake:${entry}`)
        }
        return { stdout: '', stderr: '' }
      }
    }
    throw new Error(`unexpected exec ${command} ${args.join(' ')}`)
  }
  return { execImpl, calls }
}

class FakeChild extends EventEmitter implements LlamaCppChildProcess {
  readonly pid: number
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  killed = false

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  kill(): boolean {
    if (this.exitCode !== null) return false
    this.killed = true
    setTimeout(() => this.exit(1), 1)
    return true
  }

  exit(code: number): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

function createFakeSpawn(behavior?: (index: number, child: FakeChild) => void) {
  const calls: Array<{ command: string; args: string[]; cwd: string; child: FakeChild }> = []
  const spawnImpl: LlamaCppSpawnImpl = (command, args, options) => {
    const child = new FakeChild(1000 + calls.length)
    calls.push({ command, args, cwd: options.cwd, child })
    behavior?.(calls.length - 1, child)
    return child
  }
  return { spawnImpl, calls }
}

function settingsWith(endpoint: LiveModeSettings['llamacpp']['endpoint'] = 'managed'): LiveModeSettings {
  return {
    ...DEFAULT_LIVE_MODE_SETTINGS,
    llamacpp: { ...DEFAULT_LIVE_MODE_SETTINGS.llamacpp, modelId: testModel.id, endpoint },
  }
}

function makeEngine(overrides: Partial<CreateLlamaCppEngineOptions> & { userDataDir?: string } = {}) {
  const statuses: LlamaCppEngineStatus[] = []
  let port = 45000
  const userDataDir = overrides.userDataDir ?? tmpDir()
  const engine = createLlamaCppEngine({
    platform: 'win32',
    tarPath: 'tar',
    catalog,
    ollamaModelsDir: null,
    getFreePort: async () => ++port,
    healthIntervalMs: 1,
    ...overrides,
    userDataDir,
    getSettings: overrides.getSettings ?? (() => settingsWith()),
    onStatus: (s) => {
      statuses.push(s)
      overrides.onStatus?.(s)
    },
  })
  engines.push(engine)
  return { engine, statuses, userDataDir }
}

function seedInstalledEngine(userDataDir: string, variant: LlamaCppVariant): string {
  const dir = path.join(userDataDir, 'engines', 'llama.cpp', `${LLAMACPP_PINNED_BUILD}-${variant}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake-exe')
  fs.writeFileSync(
    path.join(userDataDir, 'engines', 'llama.cpp', 'state.json'),
    JSON.stringify({ variant }),
  )
  return dir
}

function seedInstalledModel(userDataDir: string): { modelPath: string; mmprojPath: string } {
  const repoDir = path.join(userDataDir, 'models', 'TestOrg', 'Test-GGUF')
  fs.mkdirSync(repoDir, { recursive: true })
  const modelPath = path.join(repoDir, modelAsset.fileName)
  const mmprojPath = path.join(repoDir, mmprojAsset.fileName)
  fs.writeFileSync(modelPath, MODEL_BYTES)
  fs.writeFileSync(mmprojPath, MMPROJ_BYTES)
  fs.writeFileSync(
    path.join(userDataDir, 'models', 'models.json'),
    JSON.stringify({
      version: 1,
      models: {
        [testModel.id]: {
          modelPath,
          mmprojPath,
          source: { model: 'download', mmproj: 'download' },
          installedAt: new Date().toISOString(),
        },
      },
    }),
  )
  return { modelPath, mmprojPath }
}

// ───────────────────────────── GPU detection ─────────────────────────────

describe('LlamaCppEngine — GPU detection', () => {
  it('NVIDIA via nvidia-smi → cuda-12.4, cached', async () => {
    const exec = createFakeExec({ nvidia: 'NVIDIA GeForce RTX 4060, 8188 MiB\r\n' })
    const { engine } = makeEngine({ execImpl: exec.execImpl })
    const gpu = await engine.detectGpu()
    expect(gpu).toEqual({
      vendor: 'nvidia',
      name: 'NVIDIA GeForce RTX 4060',
      vramMb: 8188,
      recommendedVariant: 'cuda-12.4',
    })
    await engine.detectGpu()
    expect(exec.calls.filter((c) => c.command === 'nvidia-smi')).toHaveLength(1)
    expect(engine.getStatus().detectedGpu?.recommendedVariant).toBe('cuda-12.4')
  })

  it('AMD via CIM → vulkan', async () => {
    const exec = createFakeExec({
      cim: [
        { Name: 'Microsoft Basic Display Adapter', AdapterRAM: 0 },
        { Name: 'AMD Radeon RX 7600', AdapterRAM: 4293918720 },
      ],
    })
    const { engine } = makeEngine({ execImpl: exec.execImpl })
    const gpu = await engine.detectGpu()
    expect(gpu.vendor).toBe('amd')
    expect(gpu.recommendedVariant).toBe('vulkan')
    expect(gpu.name).toBe('AMD Radeon RX 7600')
  })

  it('Intel via CIM (single object) → vulkan', async () => {
    const exec = createFakeExec({ cim: { Name: 'Intel(R) UHD Graphics 620', AdapterRAM: 1073741824 } })
    const { engine } = makeEngine({ execImpl: exec.execImpl })
    expect(await engine.detectGpu()).toMatchObject({ vendor: 'intel', vramMb: 1024, recommendedVariant: 'vulkan' })
  })

  it('nothing detected → cpu', async () => {
    const exec = createFakeExec({})
    const { engine } = makeEngine({ execImpl: exec.execImpl })
    expect(await engine.detectGpu()).toEqual({ vendor: 'none', recommendedVariant: 'cpu' })
  })
})

// ───────────────────────────── downloads ─────────────────────────────

describe('LlamaCppEngine — downloads', () => {
  it('resumes a .part with Range (206) and verifies the full-file SHA256', async () => {
    const fetch = createFakeFetch({ files: { [modelAsset.url]: MODEL_BYTES, [mmprojAsset.url]: MMPROJ_BYTES } })
    const { engine, userDataDir, statuses } = makeEngine({ fetchImpl: fetch.fetchImpl })
    const repoDir = path.join(userDataDir, 'models', 'TestOrg', 'Test-GGUF')
    fs.mkdirSync(repoDir, { recursive: true })
    const half = Math.floor(MMPROJ_BYTES.length / 2)
    fs.writeFileSync(path.join(repoDir, `${mmprojAsset.fileName}.part`), MMPROJ_BYTES.subarray(0, half))

    const status = await engine.downloadModel(testModel.id)
    expect(status.installedModelIds).toEqual([testModel.id])
    expect(status.activeDownload).toBeNull()
    const mmprojCall = fetch.calls.find((c) => c.url === mmprojAsset.url)!
    expect(mmprojCall.headers.Range).toBe(`bytes=${half}-`)
    expect(fetch.calls.find((c) => c.url === modelAsset.url)!.headers.Range).toBeUndefined()
    expect(fs.readFileSync(path.join(repoDir, mmprojAsset.fileName)).equals(MMPROJ_BYTES)).toBe(true)
    expect(fs.existsSync(path.join(repoDir, `${mmprojAsset.fileName}.part`))).toBe(false)
    expect(statuses.some((s) => s.activeDownload?.status === 'verifying')).toBe(true)
    const index = JSON.parse(fs.readFileSync(path.join(userDataDir, 'models', 'models.json'), 'utf8'))
    expect(index.models[testModel.id].source).toEqual({ model: 'download', mmproj: 'download' })
  })

  it('restarts from zero when the server ignores Range (200)', async () => {
    const fetch = createFakeFetch({
      files: { [modelAsset.url]: MODEL_BYTES, [mmprojAsset.url]: MMPROJ_BYTES },
      ignoreRange: true,
    })
    const { engine, userDataDir } = makeEngine({ fetchImpl: fetch.fetchImpl })
    const repoDir = path.join(userDataDir, 'models', 'TestOrg', 'Test-GGUF')
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(path.join(repoDir, `${modelAsset.fileName}.part`), Buffer.from('garbage-prefix'))
    await engine.downloadModel(testModel.id)
    expect(fs.readFileSync(path.join(repoDir, modelAsset.fileName)).equals(MODEL_BYTES)).toBe(true)
  })

  it('SHA mismatch deletes the .part and reports the error', async () => {
    const tampered = Buffer.from(MMPROJ_BYTES)
    tampered[10] = 0x00
    const fetch = createFakeFetch({ files: { [modelAsset.url]: MODEL_BYTES, [mmprojAsset.url]: tampered } })
    const { engine, userDataDir } = makeEngine({ fetchImpl: fetch.fetchImpl })
    await expect(engine.downloadModel(testModel.id)).rejects.toThrow(/SHA256 mismatch/)
    const repoDir = path.join(userDataDir, 'models', 'TestOrg', 'Test-GGUF')
    expect(fs.existsSync(path.join(repoDir, `${mmprojAsset.fileName}.part`))).toBe(false)
    expect(fs.existsSync(path.join(repoDir, mmprojAsset.fileName))).toBe(false)
    const status = engine.getStatus()
    expect(status.lastError).toMatch(/SHA256 mismatch/)
    expect(status.activeDownload?.status).toBe('error')
    expect(status.installedModelIds).toEqual([])
  })

  it('follows https redirects but refuses a redirect to http', async () => {
    const cdn = 'https://cdn.example.test/blob-model'
    const fetchOk = createFakeFetch({
      files: { [cdn]: MODEL_BYTES, [mmprojAsset.url]: MMPROJ_BYTES },
      redirects: { [modelAsset.url]: cdn },
    })
    const ok = makeEngine({ fetchImpl: fetchOk.fetchImpl })
    await ok.engine.downloadModel(testModel.id)
    expect(fetchOk.calls.map((c) => c.url)).toContain(cdn)

    const fetchBad = createFakeFetch({
      files: { 'http://cdn.example.test/x': MODEL_BYTES },
      redirects: { [modelAsset.url]: 'http://cdn.example.test/x' },
    })
    const bad = makeEngine({ fetchImpl: fetchBad.fetchImpl })
    await expect(bad.engine.downloadModel(testModel.id)).rejects.toThrow(/non-https/)
  })

  it('only pinned contract assets are accepted', () => {
    expect(isPinnedAsset(modelAsset)).toBe(false)
    expect(isPinnedAsset(modelAsset, catalog)).toBe(true)
    expect(isPinnedAsset({ ...modelAsset, sha256: '0'.repeat(64) }, catalog)).toBe(false)
  })
})

// ───────────────────────────── Ollama blob reuse ─────────────────────────────

describe('LlamaCppEngine — Ollama blob reuse', () => {
  function seedOllama(): string {
    const ollamaDir = tmpDir('ashy-ollama-')
    fs.mkdirSync(path.join(ollamaDir, 'blobs'), { recursive: true })
    fs.writeFileSync(path.join(ollamaDir, 'blobs', `sha256-${modelAsset.sha256}`), MODEL_BYTES)
    return ollamaDir
  }

  it('hardlinks the matching blob and only downloads the mmproj', async () => {
    const ollamaDir = seedOllama()
    const fetch = createFakeFetch({ files: { [mmprojAsset.url]: MMPROJ_BYTES } })
    const { engine, userDataDir } = makeEngine({ fetchImpl: fetch.fetchImpl, ollamaModelsDir: ollamaDir })
    const status = await engine.downloadModel(testModel.id)
    expect(status.installedModelIds).toEqual([testModel.id])
    expect(fetch.calls.some((c) => c.url === modelAsset.url)).toBe(false)
    const linked = path.join(userDataDir, 'models', 'TestOrg', 'Test-GGUF', modelAsset.fileName)
    expect(fs.readFileSync(linked).equals(MODEL_BYTES)).toBe(true)
    const index = JSON.parse(fs.readFileSync(path.join(userDataDir, 'models', 'models.json'), 'utf8'))
    expect(index.models[testModel.id]).toMatchObject({
      modelPath: linked,
      source: { model: 'ollama-link', mmproj: 'download' },
    })
  })

  it('falls back to referencing the blob path when hardlinking fails', async () => {
    const ollamaDir = seedOllama()
    const fetch = createFakeFetch({ files: { [mmprojAsset.url]: MMPROJ_BYTES } })
    const { engine, userDataDir } = makeEngine({
      fetchImpl: fetch.fetchImpl,
      ollamaModelsDir: ollamaDir,
      linkImpl: async () => {
        throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' })
      },
    })
    const status = await engine.downloadModel(testModel.id)
    expect(status.installedModelIds).toEqual([testModel.id])
    const index = JSON.parse(fs.readFileSync(path.join(userDataDir, 'models', 'models.json'), 'utf8'))
    expect(index.models[testModel.id].modelPath).toBe(
      path.join(ollamaDir, 'blobs', `sha256-${modelAsset.sha256}`),
    )
    expect(index.models[testModel.id].source.model).toBe('ollama-blob')
  })

  it('ignores a blob whose size does not match', async () => {
    const ollamaDir = tmpDir('ashy-ollama-')
    fs.mkdirSync(path.join(ollamaDir, 'blobs'), { recursive: true })
    fs.writeFileSync(path.join(ollamaDir, 'blobs', `sha256-${modelAsset.sha256}`), 'short')
    const fetch = createFakeFetch({ files: { [modelAsset.url]: MODEL_BYTES, [mmprojAsset.url]: MMPROJ_BYTES } })
    const { engine } = makeEngine({ fetchImpl: fetch.fetchImpl, ollamaModelsDir: ollamaDir })
    await engine.downloadModel(testModel.id)
    expect(fetch.calls.some((c) => c.url === modelAsset.url)).toBe(true)
  })
})

// ───────────────────────────── install / extraction ─────────────────────────────

describe('LlamaCppEngine — install & extraction', () => {
  it('cuda: downloads both zips and extracts them into the same dir', async () => {
    const fetch = createFakeFetch({
      files: {
        [releaseAssets['cuda-12.4'][0]!.url]: LLAMA_ZIP,
        [releaseAssets['cuda-12.4'][1]!.url]: CUDART_ZIP,
      },
    })
    const exec = createFakeExec({ nvidia: 'NVIDIA GeForce RTX 4060, 8188 MiB' })
    const { engine, userDataDir } = makeEngine({ fetchImpl: fetch.fetchImpl, execImpl: exec.execImpl })
    const status = await engine.install()
    expect(status.installed).toBe(true)
    expect(status.installedVariant).toBe('cuda-12.4')
    const dir = path.join(userDataDir, 'engines', 'llama.cpp', `${LLAMACPP_PINNED_BUILD}-cuda-12.4`)
    expect(fs.existsSync(path.join(dir, 'llama-server.exe'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'cudart64_12.dll'))).toBe(true)
    // zips cleaned, no temp dirs left
    expect(fs.readdirSync(path.join(userDataDir, 'engines', 'downloads'))).toEqual([])
    expect(fs.readdirSync(path.join(userDataDir, 'engines', 'llama.cpp')).sort()).toEqual(
      [`${LLAMACPP_PINNED_BUILD}-cuda-12.4`, 'state.json'].sort(),
    )
    // archive listed before extraction
    const tarCalls = exec.calls.filter((c) => c.command === 'tar').map((c) => c.args[0])
    expect(tarCalls).toEqual(['-tf', '-xf', '-tf', '-xf'])
  })

  it('rejects archives with traversal entries and leaves nothing installed', async () => {
    const fetch = createFakeFetch({ files: { [releaseAssets.cpu[0]!.url]: CPU_ZIP } })
    const exec = createFakeExec({
      zipEntries: { 'llama-cpu.zip': ['llama-server.exe', '../../evil.dll'] },
    })
    const { engine, userDataDir } = makeEngine({ fetchImpl: fetch.fetchImpl, execImpl: exec.execImpl })
    await expect(engine.install('cpu')).rejects.toThrow(/unsafe entry/)
    expect(exec.calls.some((c) => c.command === 'tar' && c.args[0] === '-xf')).toBe(false)
    expect(engine.getStatus().installed).toBe(false)
    expect(engine.getStatus().lastError).toMatch(/unsafe entry/)
    expect(fs.readdirSync(path.join(userDataDir, 'engines', 'llama.cpp'))).toEqual([])
    expect(fs.existsSync(path.join(userDataDir, 'evil.dll'))).toBe(false)
  })

  it('rejects an archive without llama-server.exe', async () => {
    const fetch = createFakeFetch({ files: { [releaseAssets.vulkan[0]!.url]: VULKAN_ZIP } })
    const exec = createFakeExec({ zipEntries: { 'llama-vulkan.zip': ['ggml-vulkan.dll'] } })
    const { engine } = makeEngine({ fetchImpl: fetch.fetchImpl, execImpl: exec.execImpl })
    await expect(engine.install('vulkan')).rejects.toThrow(/llama-server\.exe not found/)
  })

  it('isSafeArchiveEntry', () => {
    expect(isSafeArchiveEntry('llama-server.exe')).toBe(true)
    expect(isSafeArchiveEntry('sub/dir/file.dll')).toBe(true)
    expect(isSafeArchiveEntry('../x')).toBe(false)
    expect(isSafeArchiveEntry('a/../../x')).toBe(false)
    expect(isSafeArchiveEntry('a\\..\\x')).toBe(false)
    expect(isSafeArchiveEntry('/etc/passwd')).toBe(false)
    expect(isSafeArchiveEntry('C:/Windows/x.dll')).toBe(false)
    expect(isSafeArchiveEntry('file.txt:stream')).toBe(false)
  })
})

// ───────────────────────────── process ─────────────────────────────

describe('LlamaCppEngine — process lifecycle', () => {
  it('spawns llama-server with the expected args and reports a ready status', async () => {
    const userDataDir = tmpDir()
    const installDir = seedInstalledEngine(userDataDir, 'cuda-12.4')
    const { modelPath, mmprojPath } = seedInstalledModel(userDataDir)
    const spawn = createFakeSpawn()
    const fetch = createFakeFetch({})
    const { engine } = makeEngine({ userDataDir, spawnImpl: spawn.spawnImpl, fetchImpl: fetch.fetchImpl })

    const status = await engine.start()
    expect(spawn.calls).toHaveLength(1)
    const call = spawn.calls[0]!
    expect(call.command).toBe(path.join(installDir, 'llama-server.exe'))
    expect(call.cwd).toBe(installDir)
    expect(call.args).toEqual([
      '-m', modelPath,
      '--mmproj', mmprojPath,
      '--host', '127.0.0.1',
      '--port', String(status.port),
      '--reasoning', 'off',
      '-ngl', '99',
      '-c', '4096',
      '--jinja', '--no-webui',
    ])
    expect(status).toMatchObject({
      running: true,
      managed: true,
      activeModelId: testModel.id,
      baseUrl: `http://127.0.0.1:${status.port}`,
      lastError: null,
    })
    expect(fetch.calls.some((c) => c.url === `http://127.0.0.1:${status.port}/health`)).toBe(true)

    // stdout is logged
    call.child.stdout.write('model loaded\n')
    await new Promise((r) => setTimeout(r, 20))
    expect(fs.readFileSync(path.join(userDataDir, 'logs', 'llama-server.log'), 'utf8')).toContain('model loaded')

    await engine.stop()
    expect(call.child.killed).toBe(true)
    expect(engine.getStatus()).toMatchObject({ running: false, port: null, baseUrl: null })
  })

  it('cpu variant omits -ngl', async () => {
    const userDataDir = tmpDir()
    seedInstalledEngine(userDataDir, 'cpu')
    seedInstalledModel(userDataDir)
    const spawn = createFakeSpawn()
    const { engine } = makeEngine({
      userDataDir,
      spawnImpl: spawn.spawnImpl,
      fetchImpl: createFakeFetch({}).fetchImpl,
    })
    await engine.start(testModel.id)
    expect(spawn.calls[0]!.args).not.toContain('-ngl')
  })

  it('waits while /health is 503, then becomes ready', async () => {
    const userDataDir = tmpDir()
    seedInstalledEngine(userDataDir, 'cuda-12.4')
    seedInstalledModel(userDataDir)
    let hits = 0
    const fetch = createFakeFetch({ health: () => (++hits < 5 ? 503 : 200) })
    const { engine } = makeEngine({
      userDataDir,
      spawnImpl: createFakeSpawn().spawnImpl,
      fetchImpl: fetch.fetchImpl,
    })
    const status = await engine.start()
    expect(status.running).toBe(true)
    expect(hits).toBe(5)
  })

  it('health timeout kills the process and reports the error', async () => {
    const userDataDir = tmpDir()
    seedInstalledEngine(userDataDir, 'cuda-12.4')
    seedInstalledModel(userDataDir)
    const spawn = createFakeSpawn()
    const { engine } = makeEngine({
      userDataDir,
      spawnImpl: spawn.spawnImpl,
      fetchImpl: createFakeFetch({ health: () => 503 }).fetchImpl,
      healthIntervalMs: 5,
      healthTimeoutMs: 40,
    })
    await expect(engine.start()).rejects.toThrow(/timed out/)
    expect(spawn.calls[0]!.child.killed).toBe(true)
    expect(engine.getStatus()).toMatchObject({ running: false })
    expect(engine.getStatus().lastError).toMatch(/timed out/)
  })

  it('VC++ runtime preflight: clear error when missing, ok when app-local or in System32', async () => {
    const userDataDir = tmpDir()
    const installDir = seedInstalledEngine(userDataDir, 'cuda-12.4')
    seedInstalledModel(userDataDir)
    const systemDir = tmpDir('ashy-sys32-')
    const spawn = createFakeSpawn()
    const { engine } = makeEngine({
      userDataDir,
      spawnImpl: spawn.spawnImpl,
      fetchImpl: createFakeFetch({}).fetchImpl,
      checkVcRuntime: true,
      systemDir,
    })
    await expect(engine.start()).rejects.toThrow(/LLAMACPP_VC_RUNTIME_MISSING.*msvcp140\.dll.*vc_redist\.x64\.exe/)
    expect(spawn.calls).toHaveLength(0)
    fs.writeFileSync(path.join(systemDir, 'msvcp140.dll'), 'x')
    fs.writeFileSync(path.join(installDir, 'vcruntime140.dll'), 'x')
    fs.writeFileSync(path.join(installDir, 'vcruntime140_1.dll'), 'x')
    expect((await engine.start()).running).toBe(true)
  })

  it('maps a 0xC0000135 exit to the VC++ runtime error', async () => {
    const userDataDir = tmpDir()
    seedInstalledEngine(userDataDir, 'cuda-12.4')
    seedInstalledModel(userDataDir)
    const spawn = createFakeSpawn((_i, child) => setTimeout(() => child.exit(3221225781), 0))
    const { engine } = makeEngine({
      userDataDir,
      spawnImpl: spawn.spawnImpl,
      fetchImpl: createFakeFetch({ health: () => 503 }).fetchImpl,
      healthIntervalMs: 2,
      systemDir: tmpDir('ashy-sys32-'),
    })
    await expect(engine.start()).rejects.toThrow(/0xC0000135.*LLAMACPP_VC_RUNTIME_MISSING/)
  })

  it('refuses to start without an installed engine or model', async () => {
    const userDataDir = tmpDir()
    const { engine } = makeEngine({ userDataDir, spawnImpl: createFakeSpawn().spawnImpl })
    await expect(engine.start()).rejects.toThrow(/not installed/)
    seedInstalledEngine(userDataDir, 'cpu')
    await expect(engine.start()).rejects.toThrow(/Model test-omni is not installed/)
  })

  it('crash → restarts with 1/3/9 s backoff, then gives up', async () => {
    const userDataDir = tmpDir()
    seedInstalledEngine(userDataDir, 'cuda-12.4')
    seedInstalledModel(userDataDir)
    const delays: number[] = []
    const spawn = createFakeSpawn((index, child) => {
      // every restart dies immediately during model load
      if (index > 0) setTimeout(() => child.exit(3), 0)
    })
    let healthy = true
    const { engine } = makeEngine({
      userDataDir,
      spawnImpl: spawn.spawnImpl,
      fetchImpl: createFakeFetch({ health: () => (healthy ? 200 : 503) }).fetchImpl,
      sleep: async (ms) => {
        delays.push(ms)
        await new Promise((r) => setTimeout(r, 1))
      },
    })
    await engine.start()
    healthy = false
    spawn.calls[0]!.child.exit(139)
    await vi.waitFor(
      () => expect(engine.getStatus().lastError).toMatch(/could not be restarted after 3 attempts/),
      { timeout: 3000 },
    )
    expect(spawn.calls).toHaveLength(4)
    expect(delays.filter((d) => d >= 1000)).toEqual([1000, 3000, 9000])
    expect(engine.getStatus().running).toBe(false)
  })

  it('crash → a successful restart recovers', async () => {
    const userDataDir = tmpDir()
    seedInstalledEngine(userDataDir, 'cuda-12.4')
    seedInstalledModel(userDataDir)
    const spawn = createFakeSpawn()
    const { engine } = makeEngine({
      userDataDir,
      spawnImpl: spawn.spawnImpl,
      fetchImpl: createFakeFetch({}).fetchImpl,
      restartBackoffMs: [1, 1, 1],
    })
    await engine.start()
    spawn.calls[0]!.child.exit(1)
    await vi.waitFor(() => expect(engine.getStatus().running).toBe(true), { timeout: 2000 })
    expect(spawn.calls).toHaveLength(2)
    expect(engine.getStatus().lastError).toBeNull()
  })

  it('stop() during the crash backoff cancels restarts', async () => {
    const userDataDir = tmpDir()
    seedInstalledEngine(userDataDir, 'cuda-12.4')
    seedInstalledModel(userDataDir)
    const spawn = createFakeSpawn()
    const { engine } = makeEngine({
      userDataDir,
      spawnImpl: spawn.spawnImpl,
      fetchImpl: createFakeFetch({}).fetchImpl,
      restartBackoffMs: [50, 50, 50],
    })
    await engine.start()
    spawn.calls[0]!.child.exit(1)
    await new Promise((r) => setTimeout(r, 5))
    await engine.stop()
    await new Promise((r) => setTimeout(r, 120))
    expect(spawn.calls).toHaveLength(1)
    expect(engine.getStatus().running).toBe(false)
  })
})

// ───────────────────────────── custom endpoint ─────────────────────────────

describe('LlamaCppEngine — custom endpoint', () => {
  it('no install/spawn; start() only health-checks the URL', async () => {
    const spawn = createFakeSpawn()
    const fetch = createFakeFetch({})
    const { engine } = makeEngine({
      spawnImpl: spawn.spawnImpl,
      fetchImpl: fetch.fetchImpl,
      getSettings: () => settingsWith({ url: 'http://192.168.0.5:8080/' }),
    })
    expect(engine.getStatus()).toMatchObject({ managed: false, baseUrl: 'http://192.168.0.5:8080', running: false })
    await expect(engine.install('cpu')).rejects.toThrow(/custom endpoint/)
    const status = await engine.start()
    expect(spawn.calls).toHaveLength(0)
    expect(fetch.calls.map((c) => c.url)).toEqual(['http://192.168.0.5:8080/health'])
    expect(status).toMatchObject({ managed: false, running: true, baseUrl: 'http://192.168.0.5:8080', port: null })
  })

  it('unhealthy custom endpoint → error', async () => {
    const { engine } = makeEngine({
      fetchImpl: createFakeFetch({ health: () => 500 }).fetchImpl,
      getSettings: () => settingsWith({ url: 'http://127.0.0.1:9999' }),
      customEndpointHealthTimeoutMs: 10,
      healthIntervalMs: 2,
    })
    await expect(engine.start()).rejects.toThrow(/not healthy/)
    expect(engine.getStatus().running).toBe(false)
  })
})

// ───────────────────────────── settings store ─────────────────────────────

describe('LiveModeSettingsStore', () => {
  it('returns defaults, deep-merges partial saves and persists them', () => {
    const dir = tmpDir()
    const store = createLiveModeSettingsStore({ userDataDir: dir })
    expect(store.get()).toEqual(DEFAULT_LIVE_MODE_SETTINGS)
    const saved = store.save({ turn: { endpointMs: 900 }, llamacpp: { endpoint: { url: 'http://127.0.0.1:8080' } } })
    expect(saved.turn).toEqual({ ...DEFAULT_LIVE_MODE_SETTINGS.turn, endpointMs: 900 })
    expect(saved.llamacpp.endpoint).toEqual({ url: 'http://127.0.0.1:8080' })
    expect(saved.llamacpp.modelId).toBe(DEFAULT_LIVE_MODE_SETTINGS.llamacpp.modelId)
    const again = store.save({ llamacpp: { endpoint: 'managed' } })
    expect(again.llamacpp.endpoint).toBe('managed')
    expect(again.turn.endpointMs).toBe(900)

    const reloaded = createLiveModeSettingsStore({ userDataDir: dir })
    expect(reloaded.get()).toEqual(again)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'live-mode.json'), 'utf8')).turn.endpointMs).toBe(900)
  })

  it('rejects invalid input without persisting', () => {
    const dir = tmpDir()
    const store = createLiveModeSettingsStore({ userDataDir: dir })
    expect(() => store.save({ turn: { endpointMs: 5 } })).toThrow(/turn\.endpointMs/)
    expect(() =>
      store.save({ llamacpp: { endpoint: { url: 'not a url' } } } as never),
    ).toThrow(/Invalid Live Mode settings/)
    expect(fs.existsSync(path.join(dir, 'live-mode.json'))).toBe(false)
    expect(store.get()).toEqual(DEFAULT_LIVE_MODE_SETTINGS)
  })

  it('a corrupt or invalid file falls back to defaults', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'live-mode.json'), '{ not json')
    expect(createLiveModeSettingsStore({ userDataDir: dir }).get()).toEqual(DEFAULT_LIVE_MODE_SETTINGS)
    fs.writeFileSync(path.join(dir, 'live-mode.json'), JSON.stringify({ turn: { endpointMs: 'x' } }))
    expect(createLiveModeSettingsStore({ userDataDir: dir }).get()).toEqual(DEFAULT_LIVE_MODE_SETTINGS)
  })
})

// ───────────────────────────── kernel handlers ─────────────────────────────

describe('Engine handlers via kernel.invokeLiveCall', () => {
  it('liveMode + engines handlers work end to end with injected impls', async () => {
    const dir = tmpDir('ashy-kernel-engines-')
    const fetch = createFakeFetch({
      files: {
        [releaseAssets.cpu[0]!.url]: CPU_ZIP,
        [modelAsset.url]: MODEL_BYTES,
        [mmprojAsset.url]: MMPROJ_BYTES,
      },
    })
    const exec = createFakeExec({ nvidia: 'NVIDIA GeForce RTX 4060, 8188 MiB' })
    const spawn = createFakeSpawn()
    let port = 47000
    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      llamaCppEngineOptions: {
        fetchImpl: fetch.fetchImpl,
        execImpl: exec.execImpl,
        spawnImpl: spawn.spawnImpl,
        tarPath: 'tar',
        platform: 'win32',
        ollamaModelsDir: null,
        catalog,
        getFreePort: async () => ++port,
        healthIntervalMs: 1,
      },
    })
    kernels.push(kernel)
    const events: AshyHostStreamEvent[] = []
    const unsub = kernel.onHostEvent((e) => events.push(e))

    expect(await kernel.invokeLiveCall({ method: 'liveMode:getSettings' })).toEqual(DEFAULT_LIVE_MODE_SETTINGS)
    const saved = (await kernel.invokeLiveCall({
      method: 'liveMode:saveSettings',
      payload: { llamacpp: { modelId: testModel.id } },
    })) as LiveModeSettings
    expect(saved.llamacpp.modelId).toBe(testModel.id)
    await expect(
      kernel.invokeLiveCall({ method: 'liveMode:saveSettings', payload: { turn: { endpointMs: 1 } } }),
    ).rejects.toThrow(/Invalid payload for liveMode:saveSettings/)

    const initial = (await kernel.invokeLiveCall({ method: 'engines:getStatus' })) as LlamaCppEngineStatus
    expect(initial).toMatchObject({ engineId: 'llamacpp', installed: false, running: false })
    expect(initial.detectedGpu?.recommendedVariant).toBe('cuda-12.4')

    await expect(
      kernel.invokeLiveCall({ method: 'engines:install', payload: { engineId: 'ollama' } }),
    ).rejects.toThrow(/Invalid payload for engines:install/)
    const installed = (await kernel.invokeLiveCall({
      method: 'engines:install',
      payload: { engineId: 'llamacpp', variant: 'cpu' },
    })) as LlamaCppEngineStatus
    expect(installed.installedVariant).toBe('cpu')

    await expect(
      kernel.invokeLiveCall({ method: 'engines:downloadModel', payload: {} }),
    ).rejects.toThrow(/Invalid payload/)
    const withModel = (await kernel.invokeLiveCall({
      method: 'engines:downloadModel',
      payload: { modelId: testModel.id },
    })) as LlamaCppEngineStatus
    expect(withModel.installedModelIds).toEqual([testModel.id])

    const started = (await kernel.invokeLiveCall({ method: 'engines:start', payload: {} })) as LlamaCppEngineStatus
    expect(started).toMatchObject({ running: true, activeModelId: testModel.id, port: 47001 })
    expect(spawn.calls[0]!.args).not.toContain('-ngl')

    const stopped = (await kernel.invokeLiveCall({ method: 'engines:stop' })) as LlamaCppEngineStatus
    expect(stopped.running).toBe(false)

    const engineEvents = events.filter((e) => e.type === 'engine:status')
    expect(engineEvents.length).toBeGreaterThan(3)
    unsub()

    // switching to a custom endpoint is reflected in status
    await kernel.invokeLiveCall({
      method: 'liveMode:saveSettings',
      payload: { llamacpp: { endpoint: { url: 'http://127.0.0.1:8080' } } },
    })
    const custom = (await kernel.invokeLiveCall({ method: 'engines:getStatus' })) as LlamaCppEngineStatus
    expect(custom).toMatchObject({ managed: false, baseUrl: 'http://127.0.0.1:8080' })
  })

  it('kernel.stop() disposes a running llama-server', async () => {
    const dir = tmpDir('ashy-kernel-engines-')
    seedInstalledEngine(dir, 'cuda-12.4')
    seedInstalledModel(dir)
    const spawn = createFakeSpawn()
    const kernel = await createAshyHostKernel({
      userDataDir: dir,
      llamaCppEngineOptions: {
        fetchImpl: createFakeFetch({}).fetchImpl,
        spawnImpl: spawn.spawnImpl,
        platform: 'win32',
        ollamaModelsDir: null,
        catalog,
        healthIntervalMs: 1,
      },
    })
    await kernel.invokeLiveCall({ method: 'engines:start', payload: { modelId: testModel.id } })
    expect(spawn.calls).toHaveLength(1)
    await kernel.stop()
    expect(spawn.calls[0]!.child.killed).toBe(true)
  })
})

// ───────────────────────────── VC++ runtime one-click install ─────────────────────────────

describe('LlamaCppEngine — VC++ runtime install', () => {
  const REDIST_FINAL = 'https://download.visualstudio.microsoft.com/download/pr/abc/VC_redist.x64.exe'
  const REDIST_BYTES = Buffer.from('MZ-fake-vc-redist-'.repeat(64))
  const MS_SUBJECT = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'

  function vcFetch(finalUrl = REDIST_FINAL) {
    return createFakeFetch({
      redirects: { [VC_REDIST_URL]: finalUrl },
      files: { [finalUrl]: REDIST_BYTES },
    })
  }

  function vcExec(config: {
    signature?: { Status: string; Subject: string }
    exitCode?: number
    onInstall?: () => void
  }) {
    const calls: Array<{ command: string; args: string[]; installerExisted?: boolean }> = []
    let installs = 0
    const execImpl: LlamaCppExecImpl = async (command, args) => {
      const script = args[args.length - 1] ?? ''
      const fileMatch = /'([^']+vc_redist\.x64\.exe)'/.exec(script)
      calls.push({ command, args, installerExisted: fileMatch ? fs.existsSync(fileMatch[1]!) : undefined })
      if (command === 'powershell.exe' && script.includes('Get-AuthenticodeSignature')) {
        return {
          stdout: JSON.stringify(config.signature ?? { Status: 'Valid', Subject: MS_SUBJECT }),
          stderr: '',
        }
      }
      if (command === 'powershell.exe' && script.includes('-Verb RunAs')) {
        installs++
        config.onInstall?.()
        const code = config.exitCode ?? 0
        if (code !== 0) throw Object.assign(new Error(`Command failed: exit ${code}`), { code })
        return { stdout: '', stderr: '' }
      }
      throw new Error(`unexpected exec ${command} ${args.join(' ')}`)
    }
    return { execImpl, calls, installs: () => installs }
  }

  function writeDlls(dir: string): void {
    for (const dll of VC_RUNTIME_DLLS) fs.writeFileSync(path.join(dir, dll), 'x')
  }

  function makeVcEngine(
    fetchImpl: typeof fetch,
    execImpl: LlamaCppExecImpl,
    extra: Partial<CreateLlamaCppEngineOptions> = {},
  ) {
    const systemDir = tmpDir('ashy-sys32-')
    const vcRedistTempRoot = tmpDir('ashy-vctmp-')
    const made = makeEngine({ fetchImpl, execImpl, checkVcRuntime: true, systemDir, vcRedistTempRoot, ...extra })
    return { ...made, systemDir, vcRedistTempRoot }
  }

  it('reports vcRuntimeMissing in getStatus before any start attempt', () => {
    const { engine, systemDir } = makeVcEngine(vcFetch().fetchImpl, vcExec({}).execImpl)
    expect(engine.getStatus().vcRuntimeMissing).toBe(true)
    expect(engine.getStatus().vcRuntimeInstall).toBeNull()
    writeDlls(systemDir)
    expect(engine.getStatus().vcRuntimeMissing).toBe(false)
  })

  it('downloads, verifies, installs elevated, flips vcRuntimeMissing and deletes the installer', async () => {
    let systemDirRef = ''
    const exec = vcExec({ onInstall: () => writeDlls(systemDirRef) })
    const fetch = vcFetch()
    const { engine, statuses, systemDir, vcRedistTempRoot } = makeVcEngine(fetch.fetchImpl, exec.execImpl)
    systemDirRef = systemDir
    expect(engine.getStatus().vcRuntimeMissing).toBe(true)

    const status = await engine.installVcRuntime()
    expect(status.vcRuntimeMissing).toBe(false)
    expect(status.vcRuntimeInstall).toEqual({ status: 'completed', percent: 100 })
    expect(exec.installs()).toBe(1)

    // signature check ran before the elevated run, both against the existing downloaded installer
    const sig = exec.calls.findIndex((c) => c.args.at(-1)!.includes('Get-AuthenticodeSignature'))
    const run = exec.calls.findIndex((c) => c.args.at(-1)!.includes('-Verb RunAs'))
    expect(sig).toBeGreaterThanOrEqual(0)
    expect(run).toBeGreaterThan(sig)
    expect(exec.calls[sig]!.installerExisted).toBe(true)
    expect(exec.calls[run]!.installerExisted).toBe(true)
    expect(exec.calls[run]!.args.at(-1)!).toContain("-ArgumentList '/install','/quiet','/norestart'")
    expect(exec.calls[run]!.args.slice(0, 2)).toEqual(['-NoProfile', '-NonInteractive'])

    expect(fetch.calls.map((c) => c.url)).toEqual([VC_REDIST_URL, REDIST_FINAL])
    const phases = statuses.map((s) => s.vcRuntimeInstall?.status).filter(Boolean)
    expect(phases).toEqual(expect.arrayContaining(['downloading', 'verifying', 'installing', 'completed']))
    expect(phases.indexOf('verifying')).toBeLessThan(phases.indexOf('installing'))
    expect(statuses.at(-1)!.vcRuntimeMissing).toBe(false)
    // temp installer removed
    expect(fs.readdirSync(vcRedistTempRoot)).toEqual([])
  })

  it('exit 3010 succeeds with rebootRequired', async () => {
    const exec = vcExec({ exitCode: 3010 })
    const { engine } = makeVcEngine(vcFetch().fetchImpl, exec.execImpl)
    const status = await engine.installVcRuntime()
    expect(status.vcRuntimeInstall).toEqual({ status: 'completed', percent: 100, rebootRequired: true })
  })

  it('exit 1638 (newer version already installed) is success', async () => {
    const exec = vcExec({ exitCode: 1638 })
    const { engine } = makeVcEngine(vcFetch().fetchImpl, exec.execImpl)
    const status = await engine.installVcRuntime()
    expect(status.vcRuntimeInstall?.status).toBe('completed')
    expect(status.vcRuntimeInstall?.rebootRequired).toBeUndefined()
  })

  it.each([1223, 1602])('exit %i reports that the user cancelled UAC', async (exitCode) => {
    const exec = vcExec({ exitCode })
    const { engine, vcRedistTempRoot } = makeVcEngine(vcFetch().fetchImpl, exec.execImpl)
    await expect(engine.installVcRuntime()).rejects.toThrow(VC_REDIST_CANCELLED_MESSAGE)
    expect(engine.getStatus().vcRuntimeInstall).toEqual({ status: 'error', error: VC_REDIST_CANCELLED_MESSAGE })
    expect(engine.getStatus().vcRuntimeMissing).toBe(true)
    expect(fs.readdirSync(vcRedistTempRoot)).toEqual([])
  })

  it('other exit codes fail with the code', async () => {
    const exec = vcExec({ exitCode: 1603 })
    const { engine } = makeVcEngine(vcFetch().fetchImpl, exec.execImpl)
    await expect(engine.installVcRuntime()).rejects.toThrow(/1603/)
    expect(engine.getStatus().vcRuntimeInstall?.status).toBe('error')
  })

  it('refuses to run an installer not signed by Microsoft Corporation', async () => {
    const exec = vcExec({
      signature: { Status: 'Valid', Subject: 'CN=Evil Corp, O=Microsoft Corporation Fake, C=US' },
    })
    const { engine, vcRedistTempRoot } = makeVcEngine(vcFetch().fetchImpl, exec.execImpl)
    await expect(engine.installVcRuntime()).rejects.toThrow(/not signed by Microsoft Corporation/)
    expect(exec.installs()).toBe(0)
    expect(engine.getStatus().vcRuntimeInstall?.status).toBe('error')
    expect(fs.readdirSync(vcRedistTempRoot)).toEqual([])
  })

  it('refuses to run an installer whose signature status is not Valid', async () => {
    const exec = vcExec({ signature: { Status: 'HashMismatch', Subject: MS_SUBJECT } })
    const { engine } = makeVcEngine(vcFetch().fetchImpl, exec.execImpl)
    await expect(engine.installVcRuntime()).rejects.toThrow(/signature is not valid/)
    expect(exec.installs()).toBe(0)
  })

  it('refuses a redirect to a non-Microsoft host (nothing is executed)', async () => {
    const evil = 'https://download.visualstudio.microsoft.com.evil.test/vc_redist.x64.exe'
    const exec = vcExec({})
    const fetch = vcFetch(evil)
    const { engine } = makeVcEngine(fetch.fetchImpl, exec.execImpl)
    await expect(engine.installVcRuntime()).rejects.toThrow(/non-Microsoft host/)
    expect(fetch.calls.map((c) => c.url)).toEqual([VC_REDIST_URL])
    expect(exec.calls).toEqual([])
  })

  it('refuses a non-https redirect', async () => {
    const exec = vcExec({})
    const fetch = vcFetch('http://download.visualstudio.microsoft.com/vc_redist.x64.exe')
    const { engine } = makeVcEngine(fetch.fetchImpl, exec.execImpl)
    await expect(engine.installVcRuntime()).rejects.toThrow(/non-https/)
    expect(exec.calls).toEqual([])
  })

  it('is a no-op off Windows', async () => {
    const exec = vcExec({})
    const fetch = vcFetch()
    const { engine } = makeVcEngine(fetch.fetchImpl, exec.execImpl, { platform: 'linux' })
    const status = await engine.installVcRuntime()
    expect(status.vcRuntimeMissing).toBe(false)
    expect(status.vcRuntimeInstall).toBeNull()
    expect(fetch.calls).toEqual([])
    expect(exec.calls).toEqual([])
  })

  it('helpers: host allowlist, signer subject, PowerShell quoting', () => {
    expect(isMicrosoftDownloadHost('download.visualstudio.microsoft.com')).toBe(true)
    expect(isMicrosoftDownloadHost('aka.ms')).toBe(false)
    expect(isMicrosoftDownloadHost('aka.ms', true)).toBe(true)
    expect(isMicrosoftDownloadHost('evilmicrosoft.com')).toBe(false)
    expect(isMicrosoftDownloadHost('microsoft.com.evil.test')).toBe(false)
    expect(isMicrosoftSignerSubject(MS_SUBJECT)).toBe(true)
    expect(isMicrosoftSignerSubject('CN=Microsoft Corporation, O=Contoso')).toBe(false)
    expect(isMicrosoftSignerSubject('O=Microsoft Corporation Ltd')).toBe(false)
    expect(psSingleQuote("C:\\Temp\\o'neil\\x.exe")).toBe("'C:\\Temp\\o''neil\\x.exe'")
  })

  it('registers the engines:installVcRuntime handler', async () => {
    const engine = {
      installVcRuntime: vi.fn(async () => ({ vcRuntimeMissing: false }) as LlamaCppEngineStatus),
    }
    const handlers = new Map<string, (payload: unknown) => unknown>()
    const registry = {
      register: (method: string, handler: (payload: unknown) => unknown) => {
        handlers.set(method, handler)
        return () => {
          handlers.delete(method)
        }
      },
    }
    const unregister = registerEngineHandlers({ registry } as never, {
      llamaCppEngine: engine as never,
      liveModeSettingsStore: {} as never,
    })
    expect(handlers.has('engines:installVcRuntime')).toBe(true)
    await expect(handlers.get('engines:installVcRuntime')!(undefined)).resolves.toMatchObject({
      vcRuntimeMissing: false,
    })
    expect(engine.installVcRuntime).toHaveBeenCalledTimes(1)
    unregister()
    expect(handlers.size).toBe(0)
  })
})
