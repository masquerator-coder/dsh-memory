/**
 * dsh-memory — client bundle build (esbuild).
 *
 * Builds src/client.tsx → lib/client.js in the dsh web shell's ModuleLoader
 * format (`window.__ModuleLoader__.load({ id, factory })`), exactly like
 * meow-memory. `react` stays external — the shell seeds a React singleton and
 * a bundled copy would crash slot rendering (double React).
 *
 * esbuild is resolved from the deepseek-harness workspace node_modules (the
 * same layout assumption as tsconfig's `paths`/`typeRoots` — see README).
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const esbuild = require('D:/Apps/deepseek-harness/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild')

const BANNER = [
  'window.__ModuleLoader__.load({',
  '  id: "memory",',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
].join('\n')

const FOOTER = [
  '    return module.exports;',
  '  }',
  '});',
].join('\n')

await esbuild.build({
  entryPoints: [fileURLToPath(new URL('./src/client.tsx', import.meta.url))],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  outfile: fileURLToPath(new URL('./lib/client.js', import.meta.url)),
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  banner: { js: BANNER },
  footer: { js: FOOTER },
  sourcemap: true,
  logLevel: 'info',
})
