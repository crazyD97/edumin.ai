// Bundles the API (and the workspace `@edumin/shared` source) into dist/.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server.ts', 'src/db/migrate.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: 'dist',
  packages: 'external',
  alias: { '@edumin/shared': '../../packages/shared/src/index.ts' },
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
console.log('API built to dist/');
