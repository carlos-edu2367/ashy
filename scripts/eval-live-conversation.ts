/**
 * Live Call conversation-quality eval (2026-11-01) — REAL runs, text level.
 *
 * For every (backend, scenario): a throw-away copy of the given userData dir (DB + settings copied,
 * engines/models junctioned) → real host kernel → `call:start` (managed llama-server + LFM3) → the
 * session-level `call:buildContext` → the real `createLlamaCppRealtimeSession` /
 * `createLlamaCppHybridSession` over `/v1/realtime` → per turn: `call:buildContext` (memory retrieval,
 * mood, time), `formatTranscribedUserTurn` (exactly what the CallEngine submits), the reply, then the
 * real `call:recordTurn` (persist + memory indexing, so later turns see what indexing produced).
 * Microphone/VAD/STT are skipped (the user text is given); hybrid TTS is stubbed (text is scored).
 *
 * Usage (from the repo root): node scripts/eval-live-conversation.mjs --userdata <dir>
 *   [--backend realtime|hybrid|both] [--scenarios id1,id2] [--tools on|off|keep] [--out report.json]
 *   [--label before]
 * NEVER point --userdata at the real %APPDATA%\@ashy\desktop: the runner refuses it anyway.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAshyHostKernel } from '../apps/desktop/src/host/kernel'
import { formatTranscribedUserTurn } from '../packages/shared/src/index'
import {
  createLlamaCppHybridSession,
  createLlamaCppRealtimeSession,
  extractActMarkers,
} from '../packages/voice/src/index'
import {
  formatLiveEvalTable,
  getLiveEvalScenarios,
  scoreLiveConversation,
  type LiveConversationScore,
  type LiveEvalScenario,
} from '../packages/evals/src/live-call/index'

type Backend = 'llamacpp-realtime' | 'llamacpp-hybrid'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// --rescore <report.json>: re-score a saved report with the current scorer (same metric for before/after).
const rescore = arg('rescore')
if (rescore) {
  const report = JSON.parse(fs.readFileSync(rescore, 'utf8'))
  const all = getLiveEvalScenarios()
  const rescored: LiveConversationScore[] = []
  for (const r of report.results ?? []) {
    const scenario = all.find((s) => s.id === r.scenario)
    if (!scenario) continue
    rescored.push(
      scoreLiveConversation({
        scenario,
        backend: String(r.backend).replace('llamacpp-', ''),
        replies: r.turns.map((t: { reply: string }) => t.reply),
        latenciesMs: r.turns.map((t: { latencyMs: number }) => t.latencyMs),
      }),
    )
  }
  const total = rescored.reduce((n, s) => n + s.turns.length, 0)
  const pass = rescored.reduce((n, s) => n + s.turns.filter((t) => t.pass).length, 0)
  console.log(formatLiveEvalTable(rescored))
  console.log(`
[${report.label} rescored] overall: ${pass}/${total} turns pass (${total ? Math.round((pass / total) * 100) : 0}%)`)
  if (process.argv.includes('--verbose')) {
    for (const s of rescored) for (const t of s.turns) if (!t.pass) console.log(`  ${s.backend}/${s.scenarioId} #${t.index + 1} [${t.flags.join(',')}] ${t.user} -> ${t.reply.slice(0, 140)}`)
  }
  process.exit(0)
}

const sourceDir = path.resolve(arg('userdata') ?? '')
const realAppData = path.resolve(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '@ashy', 'desktop')
if (!arg('userdata') || !fs.existsSync(path.join(sourceDir, 'ashy.db'))) {
  console.error('--userdata <dir with ashy.db> is required')
  process.exit(2)
}
if (path.relative(realAppData, sourceDir) === '' || sourceDir.toLowerCase().startsWith(realAppData.toLowerCase())) {
  console.error('refusing to run against the real app data dir')
  process.exit(2)
}
const backendArg = arg('backend') ?? 'both'
const backends: Backend[] =
  backendArg === 'both' ? ['llamacpp-realtime', 'llamacpp-hybrid'] : [backendArg.startsWith('llamacpp-') ? (backendArg as Backend) : (`llamacpp-${backendArg}` as Backend)]
const scenarios = getLiveEvalScenarios(arg('scenarios')?.split(',').filter(Boolean))
const toolsArg = arg('tools') ?? 'keep'
const label = arg('label') ?? 'run'
const outFile = arg('out')
const repeat = Math.max(1, Number(arg('repeat') ?? 1))

const SKIP_DIRS = new Set(['engines', 'models', 'logs'])

/** Throw-away userData: copied files + junctions to the (big) engines/models dirs. */
function makeWorkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashy-live-eval-'))
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name)
    const to = path.join(dir, entry.name)
    if (SKIP_DIRS.has(entry.name)) {
      if (entry.name === 'logs') fs.mkdirSync(to)
      else fs.symlinkSync(fs.realpathSync(from), to, 'junction')
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      fs.cpSync(fs.realpathSync(from), to, { recursive: true })
    } else {
      fs.copyFileSync(from, to)
    }
  }
  return dir
}

function removeWorkDir(dir: string): void {
  for (const name of ['engines', 'models']) {
    try {
      fs.unlinkSync(path.join(dir, name))
    } catch {
      try {
        fs.rmdirSync(path.join(dir, name))
      } catch {
        /* ignore */
      }
    }
  }
  // Never recurse while a junction is still there: it would delete the real engines/models.
  if (['engines', 'models'].some((name) => fs.existsSync(path.join(dir, name)))) {
    console.warn(`  (left ${dir} in place: could not remove its junctions)`)
    return
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

interface TurnRun {
  user: string
  reply: string
  heard: string
  latencyMs: number
  perTurnContext: string
  toolChoice?: string
}

async function runScenario(backend: Backend, scenario: LiveEvalScenario): Promise<{ score: LiveConversationScore; turns: TurnRun[]; instructions: string }> {
  const workDir = makeWorkDir()
  const kernel: any = await createAshyHostKernel({ userDataDir: workDir } as any)
  const inv = (method: string, payload: unknown = {}) => kernel.invokeLiveCall({ method, payload })
  const turns: TurnRun[] = []
  let instructions = ''
  try {
    const current: any = await inv('liveMode:getSettings')
    const settingsNow = current?.settings ?? current
    const toolsInCall = toolsArg === 'keep' ? Boolean(settingsNow?.features?.toolsInCall) : toolsArg === 'on'
    await inv('liveMode:saveSettings', {
      backend,
      features: { toolsInCall, visionInCall: false, initiativeInCall: false },
    })

    for (const ep of scenario.seedEpisodes ?? []) {
      const nowMs = Date.now() - 3_600_000
      kernel.cortex.db.upsertEpisodicMemory({
        id: `ep-session-seed-${Math.random().toString(36).slice(2, 10)}`,
        title: ep.title,
        summary: ep.summary,
        content: ep.content,
        createdAt: nowMs,
        lastReviewedAt: nowMs,
        stability: 6,
        difficulty: 4.5,
        surprise: 0.45,
        isFlashbulb: false,
        tags: ['conversation'],
        approvalStatus: 'approved',
      })
    }

    if (scenario.seedPreviousCall?.length) {
      const prev: any = await inv('call:start', {})
      const prevId = prev?.callId ?? prev?.state?.callId
      for (const ex of scenario.seedPreviousCall) {
        await inv('call:buildContext', { callId: prevId, userText: ex.user })
        await inv('call:recordTurn', { callId: prevId, userTranscript: ex.user, assistantSpokenText: ex.assistant, interrupted: false })
      }
      await inv('call:stop', {})
    }

    const started: any = await inv('call:start', {})
    const callId = started?.callId ?? started?.state?.callId
    if (!callId) throw new Error(`call:start failed: ${JSON.stringify(started).slice(0, 300)}`)
    const cfg: any = await inv('call:getRuntimeConfig', { callId })
    if (!cfg?.llamacpp?.baseUrl) throw new Error('no llama.cpp endpoint')
    const headers = kernel.liveCall.getEngineAuth?.()?.headers ?? {}
    const wsFactory = (url: string) => new (globalThis as any).WebSocket(url, { headers })
    const s0: any = await inv('call:buildContext', { callId })
    instructions = s0.instructions
    const tools = Array.isArray(s0.tools) ? s0.tools : []

    const session: any =
      backend === 'llamacpp-hybrid'
        ? createLlamaCppHybridSession({
            baseUrl: cfg.llamacpp.baseUrl,
            modelId: cfg.llamacpp.modelId,
            maxOutputTokens: cfg.settings.llamacpp.maxOutputTokens,
            webSocketFactory: wsFactory as any,
            // TTS is not under test: a 10 ms silence keeps the phrase pipeline moving.
            synthesize: async () => ({ pcmBase64: Buffer.alloc(480).toString('base64'), sampleRate: 24000, durationMs: 10, latencyMs: 0 }),
          })
        : createLlamaCppRealtimeSession({
            baseUrl: cfg.llamacpp.baseUrl,
            modelId: cfg.llamacpp.modelId,
            inputMode: 'transcribed',
            maxOutputTokens: cfg.settings.llamacpp.maxOutputTokens,
            webSocketFactory: wsFactory as any,
          })
    await session.connect({ instructions, ...(tools.length ? { tools } : {}) })

    let interruptedAfterText: string | undefined
    for (const turn of scenario.turns) {
      const ctx: any = await inv('call:buildContext', {
        callId,
        userText: turn.user,
        ...(interruptedAfterText ? { interruptedAfterText } : {}),
      })
      interruptedAfterText = undefined
      const item = formatTranscribedUserTurn(turn.user, ctx.perTurnContext ?? '', ctx.userLabel)
      const t0 = Date.now()
      const raw: string = await new Promise((resolve) => {
        let settled = false
        const offs: Array<() => void> = []
        const finish = (text: string) => {
          if (settled) return
          settled = true
          for (const off of offs) off()
          clearTimeout(timer)
          resolve(text)
        }
        const timer = setTimeout(() => finish('<<timeout>>'), 90_000)
        offs.push(session.on('response_done', (e: any) => finish(e.text ?? '')))
        offs.push(session.on('tool_step_done', (e: any) => finish(e.text ?? '')))
        // A tool turn is not under test here: speak with tool_choice none.
        if (tools.length) session.submitUserText(item, { toolChoice: 'none' })
        else session.submitUserText(item)
      })
      const latencyMs = Date.now() - t0
      const reply = extractActMarkers(raw).clean.replace(/\s+/g, ' ').trim()
      const heard = turn.interruptAfterChars ? reply.slice(0, turn.interruptAfterChars) : reply
      turns.push({ user: turn.user, reply, heard, latencyMs, perTurnContext: ctx.perTurnContext ?? '', ...(ctx.toolChoice ? { toolChoice: ctx.toolChoice } : {}) })
      console.log(`  [${backend.replace('llamacpp-', '')}/${scenario.id}] ${turn.user}\n      -> ${reply.slice(0, 220)}  (${latencyMs} ms)`)
      await inv('call:recordTurn', {
        callId,
        userTranscript: turn.user,
        assistantSpokenText: heard,
        assistantFullText: reply,
        interrupted: Boolean(turn.interruptAfterChars),
        ...(turn.interruptAfterChars ? { playedMs: 3000 } : {}),
      })
      if (turn.interruptAfterChars) interruptedAfterText = heard
    }
    await session.close().catch(() => {})
    await inv('call:stop', {}).catch(() => {})
  } finally {
    await kernel.stop?.().catch(() => {})
    removeWorkDir(workDir)
  }
  const userName = (() => {
    const m = /You are Ashy, (.+?)'s AI companion/.exec(instructions) ?? /The user's name is ([^.\n]+)\./.exec(instructions)
    return m?.[1]
  })()
  const score = scoreLiveConversation({
    scenario,
    backend: backend.replace('llamacpp-', ''),
    replies: turns.map((t) => t.reply),
    latenciesMs: turns.map((t) => t.latencyMs),
    ...(userName ? { userName } : {}),
  })
  return { score, turns, instructions }
}

const results: Array<{ backend: string; scenario: string; rep: number; score: LiveConversationScore; turns: TurnRun[]; instructions: string }> = []
for (const backend of backends) {
  for (let rep = 0; rep < repeat; rep += 1) {
    for (const scenario of scenarios) {
      console.log(`\n=== ${backend} · ${scenario.id}${repeat > 1 ? ` · rep ${rep + 1}` : ''} — ${scenario.title}`)
      try {
        const r = await runScenario(backend, scenario)
        results.push({ backend, scenario: scenario.id, rep, ...r })
        const bad = r.score.turns.filter((t) => !t.pass).map((t) => `#${t.index + 1}:${t.flags.join('+')}`)
        console.log(`  → pass ${Math.round(r.score.passRate * 100)}% ${bad.length ? bad.join(' ') : ''}`)
      } catch (err) {
        console.error(`  !! ${scenario.id} failed:`, err instanceof Error ? err.message : err)
      }
    }
  }
}

const scores = results.map((r) => r.score)
const totalTurns = scores.reduce((n, s) => n + s.turns.length, 0)
const passTurns = scores.reduce((n, s) => n + s.turns.filter((t) => t.pass).length, 0)
const table = formatLiveEvalTable(scores)
console.log(`\n${table}\n\n[${label}] overall: ${passTurns}/${totalTurns} turns pass (${totalTurns ? Math.round((passTurns / totalTurns) * 100) : 0}%)`)
if (outFile) {
  fs.writeFileSync(
    outFile,
    JSON.stringify({ label, at: new Date().toISOString(), source: sourceDir, passTurns, totalTurns, table, results }, null, 2),
  )
  console.log(`report → ${outFile}`)
}
process.exit(0)
