/**
 * Phase 10.1 — Ashy-managed llama.cpp `llama-server` engine (spec §7.1, §10).
 *
 * - Downloads ONLY the pinned assets from the shared contract (GitHub releases / HF), with Range
 *   resume, streaming SHA256 and size verification.
 * - Extracts the release zips with the OS bsdtar into a fresh dir, rejecting traversal entries.
 * - Reuses Ollama's content-addressed GGUF blobs when the sha256 matches.
 * - Runs `llama-server.exe` bound to 127.0.0.1 on a free port, health-checks `/health`, restarts on
 *   crash with 1/3/9 s backoff (max 3).
 * - A user-provided endpoint (`settings.llamacpp.endpoint = {url}`) is health-checked only.
 * - Phase 10.2: every managed launch gets a fresh random 32-byte hex API key, handed to llama-server
 *   through the `LLAMA_API_KEY` env var (`common/arg.cpp`: `--api-key` `.set_env("LLAMA_API_KEY")`)
 *   — never argv, which is visible in Task Manager. llama-server b12024
 *   (`tools/server/server-http.cpp`, `middleware_validate_api_key`) then requires
 *   `Authorization: Bearer <key>` (or `X-Api-Key`) on every route except `/health` and `/v1/health`,
 *   including the `/v1/realtime` WebSocket upgrade (vendored cpp-httplib 0.64 runs the pre-routing
 *   handler before upgrading). There is no query-param form. The key is exposed only through
 *   `getRequestHeaders()` / `getAuth()` (host + Electron main) and never enters
 *   `LlamaCppEngineStatus`, an event or the log.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  LIVE_LOCAL_MODELS,
  LLAMACPP_PINNED_BUILD,
  LLAMACPP_RELEASE_ASSETS,
  LLAMACPP_VARIANTS,
  type DetectedGpu,
  type EngineDownloadProgress,
  type LiveLocalModelSpec,
  type LiveModeSettings,
  type LlamaCppEngineStatus,
  type LlamaCppVariant,
  type PinnedDownloadAsset,
  type VcRuntimeInstallProgress,
} from '@ashy/shared'

// ───────────────────────────── Public API ─────────────────────────────

export interface LlamaCppEngine {
  getStatus(): LlamaCppEngineStatus
  detectGpu(): Promise<DetectedGpu>
  install(variant?: LlamaCppVariant): Promise<LlamaCppEngineStatus>
  downloadModel(modelId: string): Promise<LlamaCppEngineStatus>
  start(modelId?: string): Promise<LlamaCppEngineStatus>
  stop(): Promise<void>
  dispose(): Promise<void>
  getModelSpec(modelId: string): LiveLocalModelSpec | undefined
  /** Re-reads disk/settings state (e.g. after the endpoint setting changed) and emits it. */
  refreshStatus(): LlamaCppEngineStatus
  /**
   * Windows only: downloads the OFFICIAL Microsoft VC++ 2015-2022 x64 redistributable, verifies its
   * Authenticode signature (Valid + Microsoft Corporation) and runs it elevated (one UAC prompt).
   * No-op elsewhere.
   */
  installVcRuntime(): Promise<LlamaCppEngineStatus>
  /**
   * Headers every request to the engine must carry: `{ Authorization: 'Bearer <key>' }` while the
   * managed llama-server runs, `{}` otherwise (a custom endpoint has no Ashy-generated key).
   * SECRET: never forward to a renderer, an event or a log.
   */
  getRequestHeaders(): Record<string, string>
  /** Origin/port/headers of the running managed engine (Electron main header injection, e2e). */
  getAuth(): LlamaCppEngineAuth | null
}

export interface LlamaCppEngineAuth {
  /** e.g. `http://127.0.0.1:45123` */
  origin: string
  port: number
  headers: Record<string, string>
}

export interface ExecResult {
  stdout: string
  stderr: string
}

/** Runs a program without a shell. Must reject when the program fails to run or exits non-zero. */
export type LlamaCppExecImpl = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<ExecResult>

/** Subset of `ChildProcess` the engine relies on. */
export interface LlamaCppChildProcess {
  readonly pid?: number
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  readonly exitCode: number | null
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (err: Error) => void): unknown
}

export type LlamaCppSpawnImpl = (
  command: string,
  args: string[],
  /** `env` = extra variables merged over the parent's environment. */
  options: { cwd: string; env?: Record<string, string> },
) => LlamaCppChildProcess

export interface CreateLlamaCppEngineOptions {
  userDataDir: string
  getSettings: () => LiveModeSettings
  onStatus: (status: LlamaCppEngineStatus) => void
  fetchImpl?: typeof fetch
  execImpl?: LlamaCppExecImpl
  spawnImpl?: LlamaCppSpawnImpl
  /** Hardlink implementation (defaults to fs.promises.link) — injectable to test the fallback. */
  linkImpl?: (existingPath: string, newPath: string) => Promise<void>
  /** Ollama models dir (contains `blobs/`). `null` disables blob reuse. Default: OLLAMA_MODELS or ~/.ollama/models. */
  ollamaModelsDir?: string | null
  platform?: NodeJS.Platform
  /** TESTS ONLY: replaces the pinned contract catalog. Production always uses the contract pins. */
  catalog?: LlamaCppCatalog
  /** Tar binary used for extraction (default: %SystemRoot%\System32\tar.exe on Windows, else `tar`). */
  tarPath?: string
  getFreePort?: () => Promise<number>
  sleep?: (ms: number) => Promise<void>
  healthIntervalMs?: number
  healthTimeoutMs?: number
  customEndpointHealthTimeoutMs?: number
  restartBackoffMs?: number[]
  downloadStallTimeoutMs?: number
  progressIntervalMs?: number
  logMaxBytes?: number
  stopTimeoutMs?: number
  /**
   * Pre-flight check that the MSVC runtime DLLs llama.cpp's Windows builds depend on are present
   * (System32 or app-local in the engine dir). Default: on for win32 with the real spawn.
   */
  checkVcRuntime?: boolean
  /** Windows system dir for the VC runtime check (default %SystemRoot%\System32). */
  systemDir?: string
  /** Parent dir for the temporary VC++ redistributable download (default os.tmpdir()). */
  vcRedistTempRoot?: string
}

// ───────────────────────────── Constants & helpers ─────────────────────────────

export const LLAMA_SERVER_EXE = 'llama-server.exe'
const DEFAULT_RESTART_BACKOFF_MS = [1000, 3000, 9000]
const MAX_REDIRECTS = 8
const VARIANT_PREFERENCE: LlamaCppVariant[] = ['cuda-12.4', 'vulkan', 'cpu']

export interface LlamaCppCatalog {
  releaseAssets: Record<LlamaCppVariant, PinnedDownloadAsset[]>
  models: LiveLocalModelSpec[]
}

/** The pinned catalog from the shared contract (the only one used in production). */
export const DEFAULT_LLAMACPP_CATALOG: LlamaCppCatalog = {
  releaseAssets: LLAMACPP_RELEASE_ASSETS,
  models: LIVE_LOCAL_MODELS,
}

function catalogAssets(catalog: LlamaCppCatalog): PinnedDownloadAsset[] {
  return [
    ...LLAMACPP_VARIANTS.flatMap((variant) => catalog.releaseAssets[variant] ?? []),
    ...catalog.models.flatMap((m) => [m.model, m.mmproj]),
  ]
}

export function isPinnedAsset(
  asset: PinnedDownloadAsset,
  catalog: LlamaCppCatalog = DEFAULT_LLAMACPP_CATALOG,
): boolean {
  return catalogAssets(catalog).some(
    (p) =>
      p.url === asset.url &&
      p.sha256 === asset.sha256 &&
      p.sizeBytes === asset.sizeBytes &&
      p.fileName === asset.fileName,
  )
}

/** Rejects archive entries that are absolute, drive-qualified, contain `..` segments or ADS colons. */
export function isSafeArchiveEntry(entry: string): boolean {
  const normalized = entry.replace(/\\/g, '/')
  if (normalized.length === 0) return false
  if (normalized.startsWith('/')) return false
  if (/^[a-zA-Z]:/.test(normalized)) return false
  if (normalized.includes(':')) return false
  if (normalized.includes('\0')) return false
  return !normalized.split('/').some((segment) => segment === '..')
}

export function parseNvidiaSmi(stdout: string): { name: string; vramMb?: number } | null {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return null
  const [name, mem] = line.split(',').map((p) => p.trim())
  if (!name) return null
  const mb = mem ? Number.parseInt(mem.replace(/[^0-9]/g, ''), 10) : Number.NaN
  return Number.isFinite(mb) ? { name, vramMb: mb } : { name }
}

/** MSVC 2015–2022 x64 runtime DLLs the llama.cpp Windows builds import (not shipped in the zips). */
export const VC_RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'] as const
export const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
export const LLAMACPP_VC_RUNTIME_MISSING = 'LLAMACPP_VC_RUNTIME_MISSING'

export function findMissingVcRuntimeDlls(installDir: string, systemDir: string): string[] {
  return VC_RUNTIME_DLLS.filter(
    (dll) => !fs.existsSync(path.join(installDir, dll)) && !fs.existsSync(path.join(systemDir, dll)),
  )
}

function vcRuntimeMissingMessage(missing: string[]): string {
  const list = missing.length > 0 ? missing.join(', ') : VC_RUNTIME_DLLS.join(', ')
  return `${LLAMACPP_VC_RUNTIME_MISSING}: Microsoft Visual C++ 2015-2022 Redistributable (x64) is not installed (missing ${list}). Install it from ${VC_REDIST_URL} and try again.`
}

/** Max accepted size of the downloaded redistributable (the real one is ~25 MB). */
export const VC_REDIST_MAX_BYTES = 200 * 1024 * 1024
const VC_REDIST_FILE_NAME = 'vc_redist.x64.exe'
export const VC_REDIST_CANCELLED_MESSAGE = 'Instalação cancelada pelo usuário'

/** Hosts the redistributable download may traverse/land on: aka.ms + Microsoft domains. */
export function isMicrosoftDownloadHost(host: string, allowShortener = false): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (allowShortener && h === 'aka.ms') return true
  return h === 'microsoft.com' || h.endsWith('.microsoft.com')
}

/** Escapes a value for a PowerShell single-quoted string literal. */
export function psSingleQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, "''")}'`
}

/** True when an X.500 subject has the organization exactly `Microsoft Corporation`. */
export function isMicrosoftSignerSubject(subject: string): boolean {
  return /(^|,)\s*O\s*=\s*"?Microsoft Corporation"?\s*(,|$)/i.test(subject)
}

function execExitCode(err: unknown): number | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'number' && Number.isInteger(code)) return code
  }
  return null
}

/** STATUS_DLL_NOT_FOUND (0xC0000135), as unsigned or signed exit code. */
function isDllNotFoundExit(code: number | null): boolean {
  return code === 0xc0000135 || code === -1073741515
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function fileSize(filePath: string): Promise<number | null> {
  try {
    const st = await fs.promises.stat(filePath)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

function fileSizeSync(filePath: string): number | null {
  try {
    const st = fs.statSync(filePath)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

const defaultExec: LlamaCppExecImpl = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        shell: false,
        timeout: options?.timeoutMs ?? 30_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(err)
          return
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })

const defaultSpawn: LlamaCppSpawnImpl = (command, args, options) =>
  spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    shell: false,
    windowsHide: true,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcess as LlamaCppChildProcess

function defaultGetFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('Could not allocate a free port'))))
    })
  })
}

function defaultTarPath(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
    const candidate = path.join(systemRoot, 'System32', 'tar.exe')
    if (fs.existsSync(candidate)) return candidate
  }
  return 'tar'
}

class LogWriter {
  private bytes = 0
  private stream: fs.WriteStream | null = null

  constructor(
    private readonly filePath: string,
    private readonly maxBytes: number,
  ) {}

  private open(): fs.WriteStream {
    if (this.stream) return this.stream
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    this.bytes = fileSizeSync(this.filePath) ?? 0
    if (this.bytes >= this.maxBytes) this.rotate()
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' })
    this.stream.on('error', () => {
      // Logging must never break the engine.
    })
    return this.stream
  }

  private rotate(): void {
    try {
      this.stream?.end()
    } catch {
      // ignore
    }
    this.stream = null
    try {
      fs.renameSync(this.filePath, `${this.filePath}.1`)
    } catch {
      // ignore
    }
    this.bytes = 0
  }

  write(chunk: string | Buffer): void {
    try {
      if (this.bytes >= this.maxBytes) this.rotate()
      const stream = this.open()
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      this.bytes += buf.length
      stream.write(buf)
    } catch {
      // ignore
    }
  }

  close(): void {
    try {
      this.stream?.end()
    } catch {
      // ignore
    }
    this.stream = null
  }
}

interface ModelRecord {
  modelPath: string
  mmprojPath: string
  source: { model: ModelFileSource; mmproj: ModelFileSource }
  installedAt: string
}
type ModelFileSource = 'download' | 'ollama-link' | 'ollama-blob' | 'existing'

interface ModelsIndex {
  version: 1
  models: Record<string, ModelRecord>
}

class OperationCancelledError extends Error {
  constructor() {
    super('Operation cancelled')
    this.name = 'OperationCancelledError'
  }
}

// ───────────────────────────── Factory ─────────────────────────────

export function createLlamaCppEngine(opts: CreateLlamaCppEngineOptions): LlamaCppEngine {
  const platform = opts.platform ?? process.platform
  const catalog = opts.catalog ?? DEFAULT_LLAMACPP_CATALOG
  const fetchImpl: typeof fetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const execImpl = opts.execImpl ?? defaultExec
  const spawnImpl = opts.spawnImpl ?? defaultSpawn
  const linkImpl = opts.linkImpl ?? ((a: string, b: string) => fs.promises.link(a, b))
  const getFreePort = opts.getFreePort ?? defaultGetFreePort
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const tarPath = opts.tarPath ?? defaultTarPath(platform)
  const healthIntervalMs = opts.healthIntervalMs ?? 250
  const healthTimeoutMs = opts.healthTimeoutMs ?? 60_000
  const customHealthTimeoutMs = opts.customEndpointHealthTimeoutMs ?? 5_000
  const restartBackoffMs = opts.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
  const stallTimeoutMs = opts.downloadStallTimeoutMs ?? 60_000
  const progressIntervalMs = opts.progressIntervalMs ?? 250
  const stopTimeoutMs = opts.stopTimeoutMs ?? 5_000
  const systemDir =
    opts.systemDir ??
    path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32')
  const checkVcRuntime = opts.checkVcRuntime ?? (platform === 'win32' && !opts.spawnImpl)

  const ollamaModelsDir =
    opts.ollamaModelsDir === undefined
      ? (process.env.OLLAMA_MODELS ?? path.join(os.homedir(), '.ollama', 'models'))
      : opts.ollamaModelsDir

  const enginesRoot = path.join(opts.userDataDir, 'engines', 'llama.cpp')
  const downloadsDir = path.join(opts.userDataDir, 'engines', 'downloads')
  const modelsRoot = path.join(opts.userDataDir, 'models')
  const modelsIndexPath = path.join(modelsRoot, 'models.json')
  const engineStatePath = path.join(enginesRoot, 'state.json')
  const log = new LogWriter(
    path.join(opts.userDataDir, 'logs', 'llama-server.log'),
    opts.logMaxBytes ?? 5 * 1024 * 1024,
  )

  const installDirFor = (variant: LlamaCppVariant) =>
    path.join(enginesRoot, `${LLAMACPP_PINNED_BUILD}-${variant}`)

  // ── mutable state ──
  let detectedGpu: DetectedGpu | null = null
  let gpuPromise: Promise<DetectedGpu> | null = null
  let activeDownload: EngineDownloadProgress | null = null
  let lastError: string | null = null
  let running = false
  let port: number | null = null
  let managedBaseUrl: string | null = null
  /** API key of the CURRENT healthy managed llama-server process (regenerated on every launch). */
  let apiKey: string | null = null
  let customRunningUrl: string | null = null
  let activeModelId: string | null = null
  let child: LlamaCppChildProcess | null = null
  /** Bumped on every start/stop/dispose so stale exits/restart loops become no-ops. */
  let lifecycle = 0
  let crashRestarts = 0
  let opChain: Promise<unknown> = Promise.resolve()
  let opAbort: AbortController | null = null
  let disposed = false

  let installedVariant: LlamaCppVariant | null = null
  let installedModelIds: string[] = []
  let vcRuntimeMissing = false
  let vcRuntimeInstall: VcRuntimeInstallProgress | null = null
  let vcInstallPromise: Promise<LlamaCppEngineStatus> | null = null
  const vcRedistTempRoot = opts.vcRedistTempRoot ?? os.tmpdir()

  function settingsEndpoint(): 'managed' | { url: string } {
    try {
      return opts.getSettings().llamacpp.endpoint
    } catch {
      return 'managed'
    }
  }

  function customUrl(): string | null {
    const endpoint = settingsEndpoint()
    if (endpoint === 'managed') return null
    return endpoint.url.replace(/\/+$/, '')
  }

  function readEngineState(): { variant?: LlamaCppVariant } {
    try {
      const raw = JSON.parse(fs.readFileSync(engineStatePath, 'utf8')) as { variant?: unknown }
      return typeof raw.variant === 'string' &&
        (LLAMACPP_VARIANTS as readonly string[]).includes(raw.variant)
        ? { variant: raw.variant as LlamaCppVariant }
        : {}
    } catch {
      return {}
    }
  }

  function scanInstalledVariant(): LlamaCppVariant | null {
    const recorded = readEngineState().variant
    const order = recorded ? [recorded, ...VARIANT_PREFERENCE] : VARIANT_PREFERENCE
    for (const variant of order) {
      if (fileSizeSync(path.join(installDirFor(variant), LLAMA_SERVER_EXE)) !== null) {
        return variant
      }
    }
    return null
  }

  function readModelsIndex(): ModelsIndex {
    try {
      const raw = JSON.parse(fs.readFileSync(modelsIndexPath, 'utf8')) as Partial<ModelsIndex>
      if (raw && typeof raw === 'object' && raw.models && typeof raw.models === 'object') {
        return { version: 1, models: raw.models as Record<string, ModelRecord> }
      }
    } catch {
      // missing or corrupt → empty
    }
    return { version: 1, models: {} }
  }

  function writeModelsIndex(index: ModelsIndex): void {
    fs.mkdirSync(modelsRoot, { recursive: true })
    const tmp = `${modelsIndexPath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, modelsIndexPath)
  }

  function resolveInstalledModel(modelId: string): ModelRecord | null {
    const spec = getModelSpec(modelId)
    if (!spec) return null
    const record = readModelsIndex().models[modelId]
    if (!record) return null
    if (fileSizeSync(record.modelPath) !== spec.model.sizeBytes) return null
    if (fileSizeSync(record.mmprojPath) !== spec.mmproj.sizeBytes) return null
    return record
  }

  function scanInstalledModels(): string[] {
    return catalog.models.filter((m) => resolveInstalledModel(m.id) !== null).map((m) => m.id)
  }

  function refreshDiskState(): void {
    installedVariant = scanInstalledVariant()
    installedModelIds = scanInstalledModels()
    vcRuntimeMissing = computeVcRuntimeMissing()
  }

  function computeVcRuntimeMissing(): boolean {
    if (platform !== 'win32' || !checkVcRuntime) return false
    try {
      // App-local DLLs next to the installed llama-server.exe also satisfy the loader.
      const localDir = installedVariant ? installDirFor(installedVariant) : systemDir
      return findMissingVcRuntimeDlls(localDir, systemDir).length > 0
    } catch {
      return false
    }
  }

  function snapshot(): LlamaCppEngineStatus {
    const custom = customUrl()
    const managed = custom === null
    return {
      engineId: 'llamacpp',
      build: LLAMACPP_PINNED_BUILD,
      installed: managed ? installedVariant !== null : true,
      installedVariant,
      detectedGpu: detectedGpu ? { ...detectedGpu } : null,
      running: managed ? running : customRunningUrl === custom && running,
      managed,
      baseUrl: managed ? (running ? managedBaseUrl : null) : custom,
      port: managed ? (running ? port : null) : null,
      activeModelId: running ? activeModelId : null,
      installedModelIds: [...installedModelIds],
      activeDownload: activeDownload ? { ...activeDownload } : null,
      lastError,
      vcRuntimeMissing,
      vcRuntimeInstall: vcRuntimeInstall ? { ...vcRuntimeInstall } : null,
    }
  }

  function emit(): LlamaCppEngineStatus {
    const status = snapshot()
    try {
      opts.onStatus(status)
    } catch {
      // listener errors must not break the engine
    }
    return status
  }

  /** Serializes install/download operations. */
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = opChain.then(fn, fn)
    opChain = run.catch(() => undefined)
    return run
  }

  function getModelSpec(modelId: string): LiveLocalModelSpec | undefined {
    return catalog.models.find((m) => m.id === modelId)
  }

  // ── GPU detection ──

  async function runDetectGpu(): Promise<DetectedGpu> {
    try {
      const { stdout } = await execImpl(
        'nvidia-smi',
        ['--query-gpu=name,memory.total', '--format=csv,noheader'],
        { timeoutMs: 10_000 },
      )
      const parsed = parseNvidiaSmi(stdout)
      if (parsed) {
        return { vendor: 'nvidia', ...parsed, recommendedVariant: 'cuda-12.4' }
      }
    } catch {
      // no NVIDIA driver tools
    }

    if (platform === 'win32') {
      try {
        const { stdout } = await execImpl(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress',
          ],
          { timeoutMs: 15_000 },
        )
        const raw = JSON.parse(stdout.trim() || '[]') as unknown
        const list = (Array.isArray(raw) ? raw : [raw]) as Array<{ Name?: unknown; AdapterRAM?: unknown }>
        const adapters = list
          .filter((a) => a && typeof a.Name === 'string')
          .map((a) => ({
            name: String(a.Name),
            vramMb:
              typeof a.AdapterRAM === 'number' && a.AdapterRAM > 0
                ? Math.round(a.AdapterRAM / (1024 * 1024))
                : undefined,
          }))
        const pick = (re: RegExp) => adapters.find((a) => re.test(a.name))
        const amd = pick(/\b(amd|radeon|ati)\b/i)
        const intel = pick(/\bintel\b/i)
        const nvidia = pick(/\bnvidia|geforce|quadro|rtx\b/i)
        const chosen = amd
          ? { vendor: 'amd' as const, gpu: amd }
          : nvidia
            ? { vendor: 'nvidia' as const, gpu: nvidia }
            : intel
              ? { vendor: 'intel' as const, gpu: intel }
              : null
        if (chosen) {
          return {
            vendor: chosen.vendor,
            name: chosen.gpu.name,
            ...(chosen.gpu.vramMb !== undefined ? { vramMb: chosen.gpu.vramMb } : {}),
            // NVIDIA without nvidia-smi means no usable CUDA driver tooling: use Vulkan.
            recommendedVariant: 'vulkan',
          }
        }
        if (adapters[0]) {
          return { vendor: 'other', name: adapters[0].name, recommendedVariant: 'cpu' }
        }
      } catch {
        // PowerShell/CIM unavailable
      }
    }
    return { vendor: 'none', recommendedVariant: 'cpu' }
  }

  function detectGpu(): Promise<DetectedGpu> {
    if (detectedGpu) return Promise.resolve({ ...detectedGpu })
    if (!gpuPromise) {
      gpuPromise = runDetectGpu().then((gpu) => {
        detectedGpu = gpu
        emit()
        return { ...gpu }
      })
    }
    return gpuPromise
  }

  // ── downloads ──

  async function fetchFollowingRedirects(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (new URL(current).protocol !== 'https:') {
        throw new Error(`Refusing non-https download URL: ${current}`)
      }
      const res = await fetchImpl(current, { headers, redirect: 'manual', signal })
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location')
        if (!location) throw new Error(`Redirect without location from ${current}`)
        try {
          await res.body?.cancel()
        } catch {
          // ignore
        }
        current = new URL(location, current).toString()
        continue
      }
      return res
    }
    throw new Error(`Too many redirects downloading ${url}`)
  }

  async function hashExisting(filePath: string, hash: ReturnType<typeof createHash>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(filePath)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve())
    })
  }

  async function hashFile(filePath: string): Promise<string> {
    const hash = createHash('sha256')
    await hashExisting(filePath, hash)
    return hash.digest('hex')
  }

  /**
   * Downloads a pinned asset to `destPath` via `<destPath>.part` with Range resume, streaming
   * SHA256 (over the whole file, including resumed bytes) and size verification.
   */
  async function downloadPinned(
    asset: PinnedDownloadAsset,
    destPath: string,
    phase: EngineDownloadProgress['phase'],
    signal: AbortSignal,
  ): Promise<void> {
    if (!isPinnedAsset(asset, catalog) || !asset.url.startsWith('https://')) {
      throw new Error(`Refusing to download a non-pinned asset: ${asset.url}`)
    }
    const total = asset.sizeBytes
    const setProgress = (
      status: EngineDownloadProgress['status'],
      completedBytes: number,
      error?: string,
    ) => {
      activeDownload = {
        fileName: asset.fileName,
        phase,
        status,
        completedBytes,
        totalBytes: total,
        percent: total > 0 ? Math.min(100, Math.round((completedBytes / total) * 1000) / 10) : 0,
        ...(error ? { error } : {}),
      }
    }

    if ((await fileSize(destPath)) === total) {
      setProgress('completed', total)
      emit()
      return
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const partPath = `${destPath}.part`

    for (let attempt = 0; attempt < 2; attempt++) {
      let existing = (await fileSize(partPath)) ?? 0
      if (existing > total) {
        await fs.promises.rm(partPath, { force: true })
        existing = 0
      }
      const hash = createHash('sha256')
      let completed = existing

      if (existing < total) {
        const stall = new AbortController()
        const onOuterAbort = () => stall.abort()
        signal.addEventListener('abort', onOuterAbort, { once: true })
        let stallTimer: ReturnType<typeof setTimeout> | null = null
        const armStall = () => {
          if (stallTimer) clearTimeout(stallTimer)
          stallTimer = setTimeout(() => stall.abort(), stallTimeoutMs)
        }
        try {
          armStall()
          const headers: Record<string, string> = {}
          if (existing > 0) headers.Range = `bytes=${existing}-`
          const res = await fetchFollowingRedirects(asset.url, headers, stall.signal)

          let append = false
          if (res.status === 206 && existing > 0) {
            const range = res.headers.get('content-range')
            const start = range ? Number.parseInt(/bytes\s+(\d+)-/i.exec(range)?.[1] ?? '', 10) : existing
            if (start !== existing) {
              throw new Error(`Unexpected Content-Range "${range}" resuming ${asset.fileName}`)
            }
            append = true
          } else if (res.status === 416 && existing > 0) {
            // Server refuses our range: discard partial and retry from scratch.
            await fs.promises.rm(partPath, { force: true })
            continue
          } else if (!res.ok || res.status === 206) {
            throw new Error(`Download failed for ${asset.fileName}: HTTP ${res.status}`)
          }
          if (append) {
            await hashExisting(partPath, hash)
          } else {
            completed = 0
          }
          if (!res.body) throw new Error(`Empty response body for ${asset.fileName}`)

          setProgress('downloading', completed)
          emit()
          let lastEmit = Date.now()

          const fh = await fs.promises.open(partPath, append ? 'a' : 'w')
          try {
            const reader = res.body.getReader()
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (!value || value.byteLength === 0) continue
              armStall()
              completed += value.byteLength
              if (completed > total) {
                await reader.cancel().catch(() => undefined)
                throw new Error(`Download of ${asset.fileName} exceeded the pinned size (${total} bytes)`)
              }
              hash.update(value)
              await fh.write(value)
              const now = Date.now()
              if (now - lastEmit >= progressIntervalMs) {
                lastEmit = now
                setProgress('downloading', completed)
                emit()
              }
            }
          } finally {
            await fh.close()
          }
        } catch (err) {
          if (signal.aborted) throw new OperationCancelledError()
          if (stall.signal.aborted) {
            throw new Error(`Download of ${asset.fileName} stalled for ${stallTimeoutMs} ms`)
          }
          if (errorMessage(err).includes('exceeded the pinned size')) {
            await fs.promises.rm(partPath, { force: true })
          }
          throw err
        } finally {
          if (stallTimer) clearTimeout(stallTimer)
          signal.removeEventListener('abort', onOuterAbort)
        }
        if (completed !== total) {
          // Truncated stream: keep the .part so the next attempt resumes.
          throw new Error(
            `Download of ${asset.fileName} incomplete: ${completed} of ${total} bytes`,
          )
        }
      } else {
        await hashExisting(partPath, hash)
      }

      setProgress('verifying', total)
      emit()
      const digest = hash.digest('hex')
      if (digest !== asset.sha256) {
        await fs.promises.rm(partPath, { force: true })
        throw new Error(
          `SHA256 mismatch for ${asset.fileName}: expected ${asset.sha256}, got ${digest}`,
        )
      }
      await fs.promises.rm(destPath, { force: true })
      await fs.promises.rename(partPath, destPath)
      setProgress('completed', total)
      emit()
      return
    }
    throw new Error(`Download of ${asset.fileName} failed after retry`)
  }

  // ── extraction ──

  async function walkForSymlinks(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Archive contains a symbolic link: ${entry.name}`)
      }
      if (entry.isDirectory()) await walkForSymlinks(full)
    }
  }

  async function extractZipsInto(zips: string[], targetDir: string): Promise<void> {
    for (const zip of zips) {
      const { stdout } = await execImpl(tarPath, ['-tf', zip], { timeoutMs: 120_000 })
      const entries = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
      if (entries.length === 0) throw new Error(`Archive ${path.basename(zip)} is empty`)
      const bad = entries.find((e) => !isSafeArchiveEntry(e))
      if (bad !== undefined) {
        throw new Error(`Archive ${path.basename(zip)} contains an unsafe entry: ${bad}`)
      }
      await execImpl(tarPath, ['-xf', zip, '-C', targetDir], { timeoutMs: 600_000 })
    }
    await walkForSymlinks(targetDir)
    if (fileSizeSync(path.join(targetDir, LLAMA_SERVER_EXE)) === null) {
      throw new Error(`${LLAMA_SERVER_EXE} not found in the extracted llama.cpp archive`)
    }
  }

  // ── install ──

  async function doInstall(requested?: LlamaCppVariant): Promise<LlamaCppEngineStatus> {
    if (customUrl() !== null) {
      throw new Error('llama.cpp uses a custom endpoint; install is disabled')
    }
    if (platform !== 'win32') {
      throw new Error(`Managed llama.cpp is only available on Windows (platform: ${platform})`)
    }
    const variant = requested ?? (await detectGpu()).recommendedVariant
    if (!(LLAMACPP_VARIANTS as readonly string[]).includes(variant)) {
      throw new Error(`Unknown llama.cpp variant: ${String(variant)}`)
    }
    const assets = catalog.releaseAssets[variant]
    const abort = new AbortController()
    opAbort = abort
    lastError = null
    let current: PinnedDownloadAsset | undefined
    let tmpDir: string | null = null
    try {
      const zips: string[] = []
      for (const asset of assets) {
        current = asset
        const dest = path.join(downloadsDir, asset.fileName)
        await downloadPinned(asset, dest, 'binary', abort.signal)
        zips.push(dest)
      }
      if (abort.signal.aborted) throw new OperationCancelledError()

      current = assets[0]
      activeDownload = {
        fileName: assets[0]!.fileName,
        phase: 'binary',
        status: 'extracting',
        completedBytes: assets[0]!.sizeBytes,
        totalBytes: assets[0]!.sizeBytes,
        percent: 100,
      }
      emit()

      fs.mkdirSync(enginesRoot, { recursive: true })
      tmpDir = path.join(
        enginesRoot,
        `.tmp-${LLAMACPP_PINNED_BUILD}-${variant}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      )
      fs.mkdirSync(tmpDir)
      await extractZipsInto(zips, tmpDir)

      const finalDir = installDirFor(variant)
      if (running && installedVariant === variant) {
        await stopInternal()
      }
      await fs.promises.rm(finalDir, { recursive: true, force: true })
      await fs.promises.rename(tmpDir, finalDir)
      tmpDir = null
      fs.writeFileSync(engineStatePath, `${JSON.stringify({ variant, build: LLAMACPP_PINNED_BUILD })}\n`)
      for (const zip of zips) {
        await fs.promises.rm(zip, { force: true }).catch(() => undefined)
      }
      activeDownload = null
      refreshDiskState()
      return emit()
    } catch (err) {
      const message = err instanceof OperationCancelledError ? 'Install cancelled' : errorMessage(err)
      lastError = message
      activeDownload = current
        ? {
            fileName: current.fileName,
            phase: 'binary',
            status: 'error',
            completedBytes: activeDownload?.completedBytes ?? 0,
            totalBytes: current.sizeBytes,
            percent: activeDownload?.percent ?? 0,
            error: message,
          }
        : null
      refreshDiskState()
      emit()
      throw new Error(message)
    } finally {
      if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
      if (opAbort === abort) opAbort = null
    }
  }

  // ── models ──

  function ollamaBlobPath(sha256: string): string | null {
    if (!ollamaModelsDir) return null
    return path.join(ollamaModelsDir, 'blobs', `sha256-${sha256}`)
  }

  /** Places one model file; returns the path to use and how it was obtained. */
  async function provideModelFile(
    asset: PinnedDownloadAsset,
    dest: string,
    signal: AbortSignal,
  ): Promise<{ filePath: string; source: ModelFileSource }> {
    if ((await fileSize(dest)) === asset.sizeBytes) {
      return { filePath: dest, source: 'existing' }
    }
    const blob = ollamaBlobPath(asset.sha256)
    // Ollama blobs are content-addressed (filename == sha256), so a size match is trusted
    // without re-hashing a multi-GB file.
    if (blob && (await fileSize(blob)) === asset.sizeBytes) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      await fs.promises.rm(dest, { force: true })
      try {
        await linkImpl(blob, dest)
        if ((await fileSize(dest)) === asset.sizeBytes) {
          return { filePath: dest, source: 'ollama-link' }
        }
        await fs.promises.rm(dest, { force: true })
      } catch {
        // cross-volume or unsupported FS: fall back to referencing the blob directly
      }
      return { filePath: blob, source: 'ollama-blob' }
    }
    await downloadPinned(asset, dest, 'model', signal)
    return { filePath: dest, source: 'download' }
  }

  async function doDownloadModel(modelId: string): Promise<LlamaCppEngineStatus> {
    const spec = getModelSpec(modelId)
    if (!spec) throw new Error(`Unknown Live Mode model: ${modelId}`)
    const abort = new AbortController()
    opAbort = abort
    lastError = null
    const repoDir = path.join(modelsRoot, ...spec.repo.split('/'))
    let current: PinnedDownloadAsset = spec.model
    try {
      const model = await provideModelFile(spec.model, path.join(repoDir, spec.model.fileName), abort.signal)
      current = spec.mmproj
      const mmproj = await provideModelFile(
        spec.mmproj,
        path.join(repoDir, spec.mmproj.fileName),
        abort.signal,
      )
      const index = readModelsIndex()
      index.models[modelId] = {
        modelPath: model.filePath,
        mmprojPath: mmproj.filePath,
        source: { model: model.source, mmproj: mmproj.source },
        installedAt: new Date().toISOString(),
      }
      writeModelsIndex(index)
      activeDownload = null
      refreshDiskState()
      return emit()
    } catch (err) {
      const message = err instanceof OperationCancelledError ? 'Download cancelled' : errorMessage(err)
      lastError = message
      activeDownload = {
        fileName: current.fileName,
        phase: 'model',
        status: 'error',
        completedBytes: activeDownload?.completedBytes ?? 0,
        totalBytes: current.sizeBytes,
        percent: activeDownload?.percent ?? 0,
        error: message,
      }
      refreshDiskState()
      emit()
      throw new Error(message)
    } finally {
      if (opAbort === abort) opAbort = null
    }
  }

  // ── process ──

  async function checkHealth(baseUrl: string): Promise<boolean> {
    try {
      const res = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) })
      try {
        await res.body?.cancel()
      } catch {
        // ignore
      }
      return res.ok
    } catch {
      return false
    }
  }

  async function waitHealthy(
    baseUrl: string,
    timeoutMs: number,
    isAlive: () => string | null,
    token: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    const maxAttempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, healthIntervalMs)))
    for (let attempt = 0; attempt < maxAttempts && Date.now() <= deadline; attempt++) {
      if (token !== lifecycle) throw new OperationCancelledError()
      const dead = isAlive()
      if (dead) throw new Error(dead)
      if (await checkHealth(baseUrl)) return
      await sleep(healthIntervalMs)
    }
    const dead = isAlive()
    if (dead) throw new Error(dead)
    throw new Error(`llama-server health check timed out after ${timeoutMs} ms (${baseUrl}/health)`)
  }

  function buildArgs(record: ModelRecord, spec: LiveLocalModelSpec, variant: LlamaCppVariant, p: number) {
    const args = [
      '-m',
      record.modelPath,
      '--mmproj',
      record.mmprojPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(p),
      '--reasoning',
      'off',
    ]
    if (variant !== 'cpu') args.push('-ngl', '99')
    args.push('-c', String(spec.contextSize), '--jinja', '--no-webui')
    return args
  }

  async function killChild(proc: LlamaCppChildProcess): Promise<void> {
    if (proc.exitCode !== null) return
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore
        }
        done()
      }, stopTimeoutMs)
      proc.once('exit', done)
      try {
        if (!proc.kill()) done()
      } catch {
        done()
      }
    })
  }

  /** Spawns llama-server and waits until /health is OK. Throws on failure (process is killed). */
  async function launch(modelId: string, token: number): Promise<void> {
    const variant = installedVariant
    if (!variant) throw new Error('llama.cpp engine is not installed')
    const spec = getModelSpec(modelId)
    if (!spec) throw new Error(`Unknown Live Mode model: ${modelId}`)
    const record = resolveInstalledModel(modelId)
    if (!record) throw new Error(`Model ${modelId} is not installed`)

    const installDir = installDirFor(variant)
    const exe = path.join(installDir, LLAMA_SERVER_EXE)
    // Never execute anything but Ashy's own extracted llama-server.exe.
    if (!isInside(enginesRoot, exe) || path.basename(exe) !== LLAMA_SERVER_EXE || fileSizeSync(exe) === null) {
      throw new Error('Refusing to launch an unexpected llama-server binary')
    }
    if (checkVcRuntime) {
      const missing = findMissingVcRuntimeDlls(installDir, systemDir)
      if (missing.length > 0) {
        throw new Error(vcRuntimeMissingMessage(missing))
      }
    }

    const p = await getFreePort()
    const baseUrl = `http://127.0.0.1:${p}`
    const args = buildArgs(record, spec, variant, p)
    log.write(`\n[${new Date().toISOString()}] starting ${LLAMA_SERVER_EXE} ${args.join(' ')}\n`)

    // Fresh key per launch, via env (argv is world-readable on Windows). Adopted as `apiKey` only
    // once this process is healthy, so a cancelled launch can't swap the key of a running one.
    const launchKey = randomBytes(32).toString('hex')
    const proc = spawnImpl(exe, args, { cwd: installDir, env: { LLAMA_API_KEY: launchKey } })
    let exitInfo: string | null = null
    proc.stdout?.on('data', (d: Buffer | string) => log.write(d))
    proc.stderr?.on('data', (d: Buffer | string) => log.write(d))
    proc.once('error', (err) => {
      exitInfo = `llama-server failed to start: ${err.message}`
      log.write(`[${new Date().toISOString()}] ${exitInfo}\n`)
    })
    proc.once('exit', (code, signal) => {
      exitInfo ??= isDllNotFoundExit(code)
        ? `llama-server exited: a required DLL was not found (0xC0000135). ${vcRuntimeMissingMessage(findMissingVcRuntimeDlls(installDir, systemDir))}`
        : `llama-server exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`
      log.write(`[${new Date().toISOString()}] ${exitInfo}\n`)
      if (child === proc) {
        child = null
        if (running && token === lifecycle) {
          void handleCrash(modelId, exitInfo, token)
        }
      }
    })
    child = proc

    try {
      await waitHealthy(baseUrl, healthTimeoutMs, () => exitInfo, token)
    } catch (err) {
      if (child === proc) child = null
      await killChild(proc)
      throw err
    }
    if (token !== lifecycle) {
      if (child === proc) child = null
      await killChild(proc)
      throw new OperationCancelledError()
    }
    running = true
    port = p
    managedBaseUrl = baseUrl
    apiKey = launchKey
    activeModelId = modelId
  }

  async function handleCrash(modelId: string, reason: string, token: number): Promise<void> {
    running = false
    port = null
    managedBaseUrl = null
    apiKey = null
    lastError = reason
    emit()
    while (crashRestarts < restartBackoffMs.length) {
      const delay = restartBackoffMs[crashRestarts]!
      crashRestarts++
      await sleep(delay)
      if (token !== lifecycle || disposed) return
      try {
        await launch(modelId, token)
        lastError = null
        emit()
        return
      } catch (err) {
        if (token !== lifecycle || disposed) return
        lastError = errorMessage(err)
        emit()
      }
    }
    if (token !== lifecycle) return
    lastError = `llama-server crashed and could not be restarted after ${restartBackoffMs.length} attempts: ${lastError ?? reason}`
    activeModelId = null
    emit()
  }

  async function stopInternal(): Promise<void> {
    lifecycle++
    const proc = child
    child = null
    running = false
    port = null
    managedBaseUrl = null
    apiKey = null
    customRunningUrl = null
    activeModelId = null
    if (proc) await killChild(proc)
  }

  let startPromise: Promise<LlamaCppEngineStatus> | null = null

  async function doStart(modelId?: string): Promise<LlamaCppEngineStatus> {
    const custom = customUrl()
    if (custom !== null) {
      if (child) await stopInternal()
      const token = ++lifecycle
      lastError = null
      try {
        await waitHealthy(custom, customHealthTimeoutMs, () => null, token)
        running = true
        customRunningUrl = custom
        activeModelId = modelId ?? opts.getSettings().llamacpp.modelId
        return emit()
      } catch (err) {
        running = false
        customRunningUrl = null
        lastError = `Custom llama.cpp endpoint is not healthy: ${errorMessage(err)}`
        emit()
        throw new Error(lastError)
      }
    }

    const targetModel = modelId ?? opts.getSettings().llamacpp.modelId
    refreshDiskState()
    if (running && child && activeModelId === targetModel) {
      return snapshot()
    }
    if (child || running) await stopInternal()
    const token = ++lifecycle
    crashRestarts = 0
    lastError = null
    emit()
    try {
      await launch(targetModel, token)
      return emit()
    } catch (err) {
      if (err instanceof OperationCancelledError) {
        return snapshot()
      }
      lastError = errorMessage(err)
      emit()
      throw new Error(lastError)
    }
  }

  // ── VC++ runtime (official Microsoft redistributable) ──

  function setVcInstall(progress: VcRuntimeInstallProgress | null): void {
    vcRuntimeInstall = progress
    emit()
  }

  /** Downloads the redistributable from aka.ms, only ever following https hops on Microsoft hosts. */
  async function downloadVcRedist(destPath: string): Promise<void> {
    let current = VC_REDIST_URL
    let res: Response | null = null
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const url = new URL(current)
      if (url.protocol !== 'https:') {
        throw new Error(`Refusing non-https VC++ redistributable URL: ${current}`)
      }
      if (!isMicrosoftDownloadHost(url.hostname, true)) {
        throw new Error(`Refusing VC++ redistributable download from non-Microsoft host: ${url.hostname}`)
      }
      const r = await fetchImpl(current, { redirect: 'manual' })
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const location = r.headers.get('location')
        try {
          await r.body?.cancel()
        } catch {
          // ignore
        }
        if (!location) throw new Error(`Redirect without location from ${current}`)
        current = new URL(location, current).toString()
        continue
      }
      res = r
      break
    }
    if (!res) throw new Error('Too many redirects downloading the VC++ redistributable')
    const finalHost = new URL(current).hostname
    if (!isMicrosoftDownloadHost(finalHost)) {
      try {
        await res.body?.cancel()
      } catch {
        // ignore
      }
      throw new Error(`Refusing VC++ redistributable served from non-Microsoft host: ${finalHost}`)
    }
    if (!res.ok) throw new Error(`VC++ redistributable download failed: HTTP ${res.status}`)
    if (!res.body) throw new Error('VC++ redistributable download returned an empty body')

    const lengthHeader = Number.parseInt(res.headers.get('content-length') ?? '', 10)
    const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : 0
    if (total > VC_REDIST_MAX_BYTES) {
      throw new Error(`VC++ redistributable is unexpectedly large (${total} bytes)`)
    }
    let completed = 0
    let lastEmit = 0
    setVcInstall({ status: 'downloading', percent: 0 })
    const fh = await fs.promises.open(destPath, 'wx')
    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        completed += value.byteLength
        if (completed > VC_REDIST_MAX_BYTES) {
          await reader.cancel().catch(() => undefined)
          throw new Error('VC++ redistributable download exceeded the size limit')
        }
        await fh.write(value)
        const now = Date.now()
        if (total > 0 && now - lastEmit >= progressIntervalMs) {
          lastEmit = now
          setVcInstall({
            status: 'downloading',
            percent: Math.min(100, Math.round((completed / total) * 1000) / 10),
          })
        }
      }
    } finally {
      await fh.close()
    }
    if (completed === 0) throw new Error('VC++ redistributable download was empty')
    if (total > 0 && completed !== total) {
      throw new Error(`VC++ redistributable download incomplete: ${completed} of ${total} bytes`)
    }
    setVcInstall({ status: 'downloading', percent: 100 })
  }

  /** Requires a Valid Authenticode signature from Microsoft Corporation. */
  async function verifyVcRedistSignature(filePath: string): Promise<void> {
    const script =
      `Get-AuthenticodeSignature -LiteralPath ${psSingleQuote(filePath)} | ` +
      `Select-Object @{n='Status';e={$_.Status.ToString()}}, @{n='Subject';e={$_.SignerCertificate.Subject}} | ` +
      'ConvertTo-Json -Compress'
    let stdout: string
    try {
      ;({ stdout } = await execImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeoutMs: 60_000 },
      ))
    } catch (err) {
      throw new Error(`Could not verify the VC++ redistributable signature: ${errorMessage(err)}`)
    }
    let parsed: { Status?: unknown; Subject?: unknown }
    try {
      const raw = JSON.parse(stdout.trim()) as unknown
      parsed = (Array.isArray(raw) ? raw[0] : raw) as { Status?: unknown; Subject?: unknown }
    } catch {
      throw new Error('Could not parse the VC++ redistributable signature check output')
    }
    const status = typeof parsed?.Status === 'string' ? parsed.Status : String(parsed?.Status ?? '')
    const subject = typeof parsed?.Subject === 'string' ? parsed.Subject : ''
    if (status !== 'Valid') {
      throw new Error(`VC++ redistributable signature is not valid (status: ${status || 'unknown'}); refusing to run it`)
    }
    if (!isMicrosoftSignerSubject(subject)) {
      throw new Error(
        `VC++ redistributable is not signed by Microsoft Corporation (signer: ${subject || 'unknown'}); refusing to run it`,
      )
    }
  }

  /** Runs the installer elevated (UAC) and returns its exit code. */
  async function runVcRedistElevated(filePath: string): Promise<number> {
    // Start-Process throws (not exits) when UAC is declined: surface the Win32 error (1223) as the code.
    const script =
      `try { $p = Start-Process -FilePath ${psSingleQuote(filePath)} ` +
      `-ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait -PassThru -ErrorAction Stop; exit $p.ExitCode } ` +
      'catch { $e = $_.Exception; while ($e -and -not ($e -is [System.ComponentModel.Win32Exception])) { $e = $e.InnerException }; ' +
      'if ($e) { exit $e.NativeErrorCode }; exit 1 }'
    try {
      await execImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeoutMs: 15 * 60_000,
      })
      return 0
    } catch (err) {
      const code = execExitCode(err)
      if (code === null) {
        throw new Error(`Could not run the VC++ redistributable installer: ${errorMessage(err)}`)
      }
      return code
    }
  }

  async function doInstallVcRuntime(): Promise<LlamaCppEngineStatus> {
    if (platform !== 'win32') return snapshot()
    let tmpDir: string | null = null
    try {
      setVcInstall({ status: 'downloading', percent: 0 })
      fs.mkdirSync(vcRedistTempRoot, { recursive: true })
      tmpDir = await fs.promises.mkdtemp(path.join(vcRedistTempRoot, 'ashy-vcredist-'))
      const installer = path.join(tmpDir, VC_REDIST_FILE_NAME)
      await downloadVcRedist(installer)

      setVcInstall({ status: 'verifying' })
      await verifyVcRedistSignature(installer)

      setVcInstall({ status: 'installing' })
      const code = await runVcRedistElevated(installer)
      let rebootRequired = false
      if (code === 3010) {
        rebootRequired = true
      } else if (code === 1602 || code === 1223) {
        throw new Error(VC_REDIST_CANCELLED_MESSAGE)
      } else if (code !== 0 && code !== 1638) {
        throw new Error(`O instalador do Visual C++ falhou (código ${code})`)
      }

      vcRuntimeMissing = computeVcRuntimeMissing()
      if (!vcRuntimeMissing && lastError?.includes(LLAMACPP_VC_RUNTIME_MISSING)) {
        lastError = null
      }
      setVcInstall({ status: 'completed', percent: 100, ...(rebootRequired ? { rebootRequired: true } : {}) })
      return snapshot()
    } catch (err) {
      const message = errorMessage(err)
      vcRuntimeMissing = computeVcRuntimeMissing()
      setVcInstall({ status: 'error', error: message })
      throw new Error(message)
    } finally {
      if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // initial disk scan
  refreshDiskState()

  function currentAuth(): LlamaCppEngineAuth | null {
    if (customUrl() !== null) return null
    if (!running || !child || !apiKey || port === null || !managedBaseUrl) return null
    return { origin: managedBaseUrl, port, headers: { Authorization: `Bearer ${apiKey}` } }
  }

  return {
    getRequestHeaders() {
      return currentAuth()?.headers ?? {}
    },
    getAuth: currentAuth,
    getStatus() {
      // Cheap (a few existsSync): lets the UI offer the VC++ install before the first start attempt.
      vcRuntimeMissing = computeVcRuntimeMissing()
      return snapshot()
    },
    detectGpu,
    getModelSpec,
    refreshStatus() {
      refreshDiskState()
      return emit()
    },
    install(variant) {
      return serialize(() => doInstall(variant))
    },
    installVcRuntime() {
      if (vcInstallPromise) return vcInstallPromise
      vcInstallPromise = doInstallVcRuntime().finally(() => {
        vcInstallPromise = null
      })
      return vcInstallPromise
    },
    downloadModel(modelId) {
      return serialize(() => doDownloadModel(modelId))
    },
    start(modelId) {
      if (startPromise) return startPromise
      startPromise = doStart(modelId).finally(() => {
        startPromise = null
      })
      return startPromise
    },
    async stop() {
      await stopInternal()
      emit()
    },
    async dispose() {
      disposed = true
      opAbort?.abort()
      await stopInternal()
      log.close()
      disposed = false
    },
  }
}
