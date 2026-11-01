// Bundles scripts/eval-live-conversation.ts (host kernel + voice sessions + eval scorer) with esbuild and
// runs it with the given args. See the .ts header for usage. The bundle is temporary and deleted afterwards.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
// esbuild is not a direct dependency: resolve the copy vite ships with.
const esbuild = createRequire(require.resolve('vite'))('esbuild')

const entry = path.join(root, 'scripts', 'eval-live-conversation.ts')
// --bundle-to <file.mjs>: only build (to freeze a 'before' snapshot of the code), then run it with node.
const bundleTo = process.argv.indexOf('--bundle-to')
const outfile =
  bundleTo >= 0
    ? path.resolve(process.argv[bundleTo + 1])
    : path.join(root, 'scripts', `.eval-live-conversation.${process.pid}.bundle.mjs`)
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  external: ['electron', 'onnxruntime-web', 'onnxruntime-node'],
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
  logLevel: 'warning',
})
if (bundleTo >= 0) process.exit(0)
let status = 1
try {
  const r = spawnSync(process.execPath, ['--no-warnings', outfile, ...process.argv.slice(2)], { stdio: 'inherit', cwd: root })
  status = r.status ?? 1
} finally {
  fs.rmSync(outfile, { force: true })
}
process.exit(status)
