import { execFile, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  RECOMMENDED_LOCAL_MODELS,
  validateLocalModelName,
  type LocalRuntimeModelInfo,
  type LocalRuntimePullProgress,
  type LocalRuntimeStatus,
} from '@ashy/shared'

const execFileAsync = promisify(execFile)

export interface LocalRuntimeManagerOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  findBinaryImpl?: () => string | null
  spawnDaemonImpl?: (binaryPath: string, host: string) => { kill: () => void }
  installEngineImpl?: (
    onProgress: (percent: number, phaseText: string) => void,
  ) => Promise<string>
  onStatusChange?: (status: LocalRuntimeStatus) => void
  onModelReady?: (modelName: string, baseUrl: string) => void
}

let cachedWhereBinaryResult: string | null | undefined = undefined

function findOllamaBinaryFast(): string | null {
  const envOverride = process.env.ASHY_OLLAMA_PATH?.trim()
  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    const programFiles = process.env.ProgramFiles
    const candidates = [
      localAppData ? path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe') : '',
      programFiles ? path.join(programFiles, 'Ollama', 'ollama.exe') : '',
    ].filter(Boolean)

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
  } else {
    const unixCandidates = [
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
      '/usr/bin/ollama',
      '/Applications/Ollama.app/Contents/Resources/ollama',
    ]
    for (const candidate of unixCandidates) {
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
  }

  return null
}

export function findOllamaBinary(): string | null {
  const fastMatch = findOllamaBinaryFast()
  if (fastMatch) {
    return fastMatch
  }

  if (cachedWhereBinaryResult !== undefined) {
    if (cachedWhereBinaryResult && fs.existsSync(cachedWhereBinaryResult)) {
      return cachedWhereBinaryResult
    }
    return null
  }

  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which'
    const out = execFileSync(cmd, ['ollama'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const firstLine = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && fs.existsSync(line))
    cachedWhereBinaryResult = firstLine ?? null
    return cachedWhereBinaryResult
  } catch {
    cachedWhereBinaryResult = null
    return null
  }
}

function normalizeOllamaBaseUrl(rawUrl?: string): string {
  const candidate = (rawUrl ?? 'http://127.0.0.1:11434').trim()
  const withoutTrailing = candidate.replace(/\/+$/, '').replace(/\/v1$/i, '')
  return withoutTrailing || 'http://127.0.0.1:11434'
}

function extractHostPort(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl)
    return parsed.host || '127.0.0.1:11434'
  } catch {
    return '127.0.0.1:11434'
  }
}

export class LocalRuntimeManager {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly findBinaryFn: () => string | null
  private readonly spawnDaemonFn: (binaryPath: string, host: string) => { kill: () => void }
  private readonly installEngineFn?: (
    onProgress: (percent: number, phaseText: string) => void,
  ) => Promise<string>
  private readonly onStatusChange?: (status: LocalRuntimeStatus) => void
  private readonly onModelReady?: (modelName: string, baseUrl: string) => void

  private managedProcess: { kill: () => void } | null = null
  private managedByAshy = false
  private engineRunning = false
  private installedModels: LocalRuntimeModelInfo[] = []
  private activePull: LocalRuntimePullProgress | null = null
  private installingEngine = false
  private lastError: string | null = null
  private installedBinaryOverride: string | null = null

  constructor(options: LocalRuntimeManagerOptions = {}) {
    this.baseUrl = normalizeOllamaBaseUrl(options.baseUrl)
    this.fetchFn = options.fetchImpl ?? ((...args) => globalThis.fetch(...args))
    this.findBinaryFn = options.findBinaryImpl ?? findOllamaBinary
    this.installEngineFn = options.installEngineImpl
    this.onStatusChange = options.onStatusChange
    this.onModelReady = options.onModelReady

    this.spawnDaemonFn =
      options.spawnDaemonImpl ??
      ((binaryPath: string, host: string) => {
        const child = spawn(binaryPath, ['serve'], {
          detached: false,
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
          env: {
            ...process.env,
            OLLAMA_HOST: host,
          },
        })
        child.unref?.()
        return {
          kill: () => {
            try {
              child.kill()
            } catch {
              // Ignore kill errors if process already exited
            }
          },
        }
      })
  }

  private resolveBinaryPath(fastOnly = false): string | null {
    if (this.installedBinaryOverride) {
      return this.installedBinaryOverride
    }
    if (fastOnly && this.findBinaryFn === findOllamaBinary) {
      return findOllamaBinaryFast()
    }
    return this.findBinaryFn()
  }

  public getCachedStatus(): LocalRuntimeStatus {
    const binaryPath = this.resolveBinaryPath(true) ?? (this.engineRunning ? 'ollama' : null)
    return {
      engineInstalled: Boolean(binaryPath) || this.engineRunning,
      engineBinaryPath: binaryPath,
      engineRunning: this.engineRunning,
      managedByAshy: this.managedByAshy,
      baseUrl: this.baseUrl,
      installedModels: [...this.installedModels],
      recommendedModels: [...RECOMMENDED_LOCAL_MODELS],
      activePull: this.activePull ? { ...this.activePull } : null,
      installingEngine: this.installingEngine,
      lastError: this.lastError,
    }
  }

  private emitStatus(): LocalRuntimeStatus {
    const snapshot = this.getCachedStatus()
    this.onStatusChange?.(snapshot)
    return snapshot
  }

  public async getStatus(): Promise<LocalRuntimeStatus> {
    const binaryPath = this.resolveBinaryPath(false)
    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(1500),
      })
      if (res.ok) {
        const data = (await res.json()) as {
          models?: Array<{
            name?: string
            model?: string
            size?: number
            modified_at?: string
            details?: {
              family?: string
              parameter_size?: string
              quantization_level?: string
            }
          }>
        }
        const rawModels = Array.isArray(data?.models) ? data.models : []
        this.installedModels = rawModels
          .map((m): LocalRuntimeModelInfo | null => {
            const name = (m.name ?? m.model ?? '').trim()
            if (!name) return null
            return {
              name,
              sizeBytes: typeof m.size === 'number' && Number.isFinite(m.size) ? m.size : 0,
              ...(m.details?.family ? { family: m.details.family } : {}),
              ...(m.details?.parameter_size
                ? { parameterSize: m.details.parameter_size }
                : {}),
              ...(m.details?.quantization_level
                ? { quantizationLevel: m.details.quantization_level }
                : {}),
              ...(m.modified_at ? { modifiedAt: m.modified_at } : {}),
            }
          })
          .filter((item): item is LocalRuntimeModelInfo => item !== null)
        this.engineRunning = true
        this.lastError = null
      } else {
        this.engineRunning = false
      }
    } catch {
      this.engineRunning = false
    }

    const status: LocalRuntimeStatus = {
      engineInstalled: Boolean(binaryPath) || this.engineRunning,
      engineBinaryPath: binaryPath,
      engineRunning: this.engineRunning,
      managedByAshy: this.managedByAshy,
      baseUrl: this.baseUrl,
      installedModels: [...this.installedModels],
      recommendedModels: [...RECOMMENDED_LOCAL_MODELS],
      activePull: this.activePull ? { ...this.activePull } : null,
      installingEngine: this.installingEngine,
      lastError: this.lastError,
    }
    return status
  }

  public async ensureEngineRunning(): Promise<LocalRuntimeStatus> {
    const current = await this.getStatus()
    if (current.engineRunning) {
      return current
    }

    const binaryPath = this.resolveBinaryPath(false)
    if (!binaryPath) {
      this.lastError = 'LOCAL_ENGINE_NOT_INSTALLED'
      this.emitStatus()
      throw new Error('LOCAL_ENGINE_NOT_INSTALLED')
    }

    const hostPort = extractHostPort(this.baseUrl)
    if (!this.managedProcess) {
      this.managedProcess = this.spawnDaemonFn(binaryPath, hostPort)
      this.managedByAshy = true
    }

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const polled = await this.getStatus()
      if (polled.engineRunning) {
        this.lastError = null
        this.emitStatus()
        return this.getStatus()
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }

    this.lastError = 'LOCAL_ENGINE_START_TIMEOUT'
    this.emitStatus()
    throw new Error('LOCAL_ENGINE_START_TIMEOUT')
  }

  public async installEngine(): Promise<LocalRuntimeStatus> {
    this.installingEngine = true
    this.lastError = null
    this.activePull = {
      model: 'ollama-engine',
      status: 'pulling',
      phaseText: 'Baixando instalador oficial do Ollama...',
      completedBytes: 0,
      totalBytes: 100,
      percent: 10,
    }
    this.emitStatus()

    const reportProgress = (percent: number, phaseText: string) => {
      const clamped = Math.max(0, Math.min(99, Math.round(percent)))
      this.activePull = {
        model: 'ollama-engine',
        status: 'pulling',
        phaseText,
        completedBytes: clamped,
        totalBytes: 100,
        percent: clamped,
      }
      this.emitStatus()
    }

    try {
      if (this.installEngineFn) {
        const installedPath = await this.installEngineFn(reportProgress)
        if (installedPath) {
          this.installedBinaryOverride = installedPath
        }
      } else if (process.env.ASHY_MOCK_LOCAL_ENGINE_INSTALL === '1') {
        reportProgress(50, 'Instalando motor local (modo simulado)...')
        this.installedBinaryOverride = 'mock-ollama-binary'
      } else if (process.platform === 'win32') {
        const setupPath = path.join(os.tmpdir(), `OllamaSetup-${process.pid}.exe`)
        try {
          reportProgress(25, 'Baixando OllamaSetup.exe oficial...')
          const response = await this.fetchFn('https://ollama.com/download/OllamaSetup.exe', {
            method: 'GET',
          })
          if (!response.ok) {
            throw new Error(`Download falhou com HTTP ${response.status}`)
          }
          const arrayBuffer = await response.arrayBuffer()
          fs.writeFileSync(setupPath, Buffer.from(arrayBuffer))
          reportProgress(75, 'Instalando Ollama silenciosamente em segundo plano...')
          await execFileAsync(setupPath, ['/VERYSILENT', '/NORESTART'], {
            windowsHide: true,
          })
          cachedWhereBinaryResult = undefined
        } finally {
          try {
            if (fs.existsSync(setupPath)) {
              fs.unlinkSync(setupPath)
            }
          } catch {
            // Ignore temp file cleanup error
          }
        }
      } else if (process.platform === 'darwin') {
        reportProgress(50, 'Instalando Ollama via Homebrew...')
        await execFileAsync('brew', ['install', '--cask', 'ollama'], {
          timeout: 300_000,
        })
        cachedWhereBinaryResult = undefined
      } else {
        throw new Error('UNSUPPORTED_AUTO_INSTALL_PLATFORM')
      }

      this.installingEngine = false
      this.activePull = null
      this.emitStatus()
      return await this.ensureEngineRunning()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.installingEngine = false
      this.lastError = message
      this.activePull = {
        model: 'ollama-engine',
        status: 'error',
        phaseText: `Falha ao instalar motor local: ${message}`,
        completedBytes: 0,
        totalBytes: 100,
        percent: 0,
        error: message,
      }
      this.emitStatus()
      throw err
    }
  }

  public async pullModel(rawModelName: string): Promise<LocalRuntimeStatus> {
    const model = validateLocalModelName(rawModelName)
    await this.ensureEngineRunning()

    this.lastError = null
    this.activePull = {
      model,
      status: 'starting',
      phaseText: `Iniciando download do modelo ${model}...`,
      completedBytes: 0,
      totalBytes: 0,
      percent: 0,
    }
    this.emitStatus()

    let lastTotalBytes = 0
    let lastPercent = 0

    const handleProgressObject = (obj: {
      status?: string
      completed?: number
      total?: number
      error?: string
    }) => {
      if (obj.error) {
        this.lastError = obj.error
        this.activePull = {
          model,
          status: 'error',
          phaseText: obj.error,
          completedBytes: 0,
          totalBytes: lastTotalBytes,
          percent: lastPercent,
          error: obj.error,
        }
        this.emitStatus()
        throw new Error(obj.error)
      }

      const rawStatus = (obj.status ?? '').toLowerCase()
      const total =
        typeof obj.total === 'number' && Number.isFinite(obj.total) && obj.total > 0
          ? obj.total
          : lastTotalBytes
      const completed =
        typeof obj.completed === 'number' && Number.isFinite(obj.completed) && obj.completed >= 0
          ? obj.completed
          : 0

      if (total > 0) {
        lastTotalBytes = total
        lastPercent = Math.min(99, Math.round((completed / total) * 100))
      }

      const isVerifying =
        rawStatus.includes('verifying') || rawStatus.includes('writing manifest')
      const phaseStatus: LocalRuntimePullProgress['status'] = isVerifying
        ? 'verifying'
        : 'pulling'

      const phaseText = isVerifying
        ? `Verificando integridade SHA-256 de ${model}...`
        : total > 0
          ? `Baixando ${model} (${lastPercent}%)...`
          : `Preparando camadas de ${model}...`

      this.activePull = {
        model,
        status: phaseStatus,
        phaseText,
        completedBytes: completed,
        totalBytes: total,
        percent: isVerifying ? Math.max(lastPercent, 95) : lastPercent,
      }
      this.emitStatus()
    }

    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true }),
      })

      if (!res.ok) {
        throw new Error(`Falha ao baixar modelo ${model}: HTTP ${res.status}`)
      }

      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''
          for (const rawLine of lines) {
            const trimmed = rawLine.trim()
            if (!trimmed) continue
            const parsed = JSON.parse(trimmed) as {
              status?: string
              completed?: number
              total?: number
              error?: string
            }
            handleProgressObject(parsed)
          }
        }

        const remaining = buffer.trim()
        if (remaining) {
          const parsed = JSON.parse(remaining) as {
            status?: string
            completed?: number
            total?: number
            error?: string
          }
          handleProgressObject(parsed)
        }
      } else {
        const rawText = await res.text()
        for (const rawLine of rawText.split(/\r?\n/)) {
          const trimmed = rawLine.trim()
          if (!trimmed) continue
          const parsed = JSON.parse(trimmed) as {
            status?: string
            completed?: number
            total?: number
            error?: string
          }
          handleProgressObject(parsed)
        }
      }

      this.activePull = {
        model,
        status: 'completed',
        phaseText: `Modelo ${model} pronto!`,
        completedBytes: lastTotalBytes,
        totalBytes: lastTotalBytes,
        percent: 100,
      }
      this.emitStatus()

      this.onModelReady?.(model, `${this.baseUrl}/v1`)
      await this.getStatus()
      this.activePull = null
      return this.emitStatus()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.lastError = message
      if (!this.activePull || this.activePull.status !== 'error') {
        this.activePull = {
          model,
          status: 'error',
          phaseText: message,
          completedBytes: 0,
          totalBytes: lastTotalBytes,
          percent: lastPercent,
          error: message,
        }
        this.emitStatus()
      }
      throw err
    }
  }

  public async deleteModel(rawModelName: string): Promise<LocalRuntimeStatus> {
    const model = validateLocalModelName(rawModelName)
    const res = await this.fetchFn(`${this.baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
    })
    if (!res.ok) {
      throw new Error(`Falha ao remover modelo ${model}: HTTP ${res.status}`)
    }
    await this.getStatus()
    return this.emitStatus()
  }

  public dispose(): void {
    if (this.managedProcess) {
      try {
        this.managedProcess.kill()
      } catch {
        // Ignore kill error
      }
      this.managedProcess = null
      this.managedByAshy = false
      this.engineRunning = false
    }
  }
}

export function createLocalRuntimeManager(
  options: LocalRuntimeManagerOptions = {},
): LocalRuntimeManager {
  return new LocalRuntimeManager(options)
}
