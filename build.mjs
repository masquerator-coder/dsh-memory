/**
 * dsh-memory — unified build (auto-version, no hardcoded paths).
 *
 * Runs the whole build from one entry so it works on any machine:
 *   1. locate the deepseek-harness repo (DSH_HARNESS_ROOT env → defaults → scan);
 *   2. auto-resolve esbuild / @types/react / typescript from its pnpm store,
 *      picking the HIGHEST semantic version (`.pnpm/<name>@<ver>`), so a version
 *      bump never breaks the build;
 *   3. emit temporary tsconfigs with the resolved root + versions, typecheck
 *      (Node + client) via tsc;
 *   4. bundle src/client.tsx → lib/client.js (ModuleLoader format, react external).
 *
 * The checked-in tsconfig.json / tsconfig.client.json stay as IDE defaults for
 * the dev machine (D:/Apps/deepseek-harness); the build itself never trusts
 * those hardcoded values.
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Compare two dot-separated numeric versions (a vs b). */
function cmpSemver(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

/** Locate the deepseek-harness workspace root (env → defaults → home scan). */
function findHarnessRoot() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidates = []
  if (process.env.DSH_HARNESS_ROOT) candidates.push(process.env.DSH_HARNESS_ROOT)
  candidates.push('D:/Apps/deepseek-harness', 'C:/Apps/deepseek-harness')
  if (home) candidates.push(join(home, 'deepseek-harness'), join(home, 'Apps', 'deepseek-harness'))
  for (const c of candidates) {
    const norm = String(c).replace(/\\/g, '/')
    if (c && existsSync(join(norm, 'packages'))) return norm
  }
  throw new Error('[dsh-memory build] deepseek-harness repo not found — set DSH_HARNESS_ROOT to its root')
}

/** Scan `<root>/node_modules/.pnpm/<prefix>@<ver>/node_modules/<inner>`; pick the
 *  highest semantic version. Returns the inner path, or null when absent. */
function findPnpm(root, prefix, inner) {
  const pnpmDir = join(root, 'node_modules', '.pnpm')
  if (!existsSync(pnpmDir)) return null
  let best = null
  let bestVer = null
  for (const name of readdirSync(pnpmDir)) {
    if (!name.startsWith(prefix + '@')) continue
    const ver = name.slice(prefix.length + 1).split('_')[0] // strip peer suffixes
    if (bestVer === null || cmpSemver(ver, bestVer) > 0) { bestVer = ver; best = name }
  }
  if (best === null) return null
  const p = join(pnpmDir, best, 'node_modules', inner)
  return existsSync(p) ? p : null
}

const harness = findHarnessRoot()
const esbuildPkg = findPnpm(harness, 'esbuild', 'esbuild')
const reactTypesDir = findPnpm(harness, '@types+react', '@types')
const tscBinTop = join(harness, 'node_modules', 'typescript', 'bin', 'tsc')
const tscPkg = existsSync(tscBinTop) ? null : findPnpm(harness, 'typescript', 'typescript')
const tscBin = tscPkg !== null ? join(tscPkg, 'bin', 'tsc') : tscBinTop

function loadEsbuild() {
  if (esbuildPkg !== null) return require(esbuildPkg)
  try { return require('esbuild') } catch { /* fall through */ }
  throw new Error('[dsh-memory build] esbuild not found — run `npm i -D esbuild` or point DSH_HARNESS_ROOT at a repo that has it')
}

/** Emit a build tsconfig from the checked-in template: rewrite the dev-machine
 *  root and (for the client config) the hardcoded @types/react version with the
 *  auto-resolved ones. */
function emitTsconfig(template, out, opts) {
  let text = readFileSync(template, 'utf8')
  text = text.replaceAll('D:/Apps/deepseek-harness', harness)
  if (opts.reactVersion) {
    text = text.replace(/@types\+react@[\d.]+/g, `@types+react@${opts.reactVersion}`)
  }
  writeFileSync(out, text)
}

function reactVersionFrom(dir) {
  const m = dir.match(/@types\+react@([\d.]+)/)
  return m ? m[1].split('_')[0] : null
}

const nodeTsconfig = join(ROOT, 'tsconfig.build.json')
const clientTsconfig = join(ROOT, 'tsconfig.client.build.json')

try {
  const reactVer = reactTypesDir !== null ? reactVersionFrom(reactTypesDir) : null
  emitTsconfig(join(ROOT, 'tsconfig.json'), nodeTsconfig, {})
  emitTsconfig(join(ROOT, 'tsconfig.client.json'), clientTsconfig, { reactVersion: reactVer })

  const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit' })
  console.log(`[dsh-memory build] harness=${harness} esbuild=${esbuildPkg ?? '(local)'} react=${reactVer ?? '(none)'}`)

  run(`node "${tscBin}" -p tsconfig.build.json`)
  run(`node "${tscBin}" -p tsconfig.client.build.json`)

  const esbuild = loadEsbuild()
  const BANNER = [
    'window.__ModuleLoader__.load({',
    '  id: "dsh-memory",',
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
  ].join('\n')
  const FOOTER = ['    return module.exports;', '  }', '});'].join('\n')
  await esbuild.build({
    entryPoints: [join(ROOT, 'src', 'client.tsx')],
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    jsx: 'automatic',
    outfile: join(ROOT, 'lib', 'client.js'),
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    banner: { js: BANNER },
    footer: { js: FOOTER },
    sourcemap: true,
    logLevel: 'info',
  })
} finally {
  rmSync(nodeTsconfig, { force: true })
  rmSync(clientTsconfig, { force: true })
}
