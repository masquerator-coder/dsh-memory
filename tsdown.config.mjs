import { defineConfig } from 'tsdown'

// tsdown bundles src/index.ts into lib/index.mjs (ESM) and emits lib/index.d.mts.
// Serves as the self-contained `prepare` script for git installs.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  sourcemap: false,
  outDir: 'lib',
})
