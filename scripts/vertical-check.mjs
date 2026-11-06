// Logic checks for src/rooms/vertical.ts in node (no renderer): stair dimensions, walking up and
// down the stair between floors (with the real colliders and ground function), the roof, doors
// reachable, determinism, mesh counts.   node scripts/vertical-check.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(tmpdir(), `vertical-check-${process.pid}.mjs`);
await build({
  entryPoints: [join(here, 'vertical-check.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  nodePaths: [join(here, '..', 'node_modules')],
  define: { 'import.meta.env.BASE_URL': '"/"' },
});
await import(join(here, 'vertical-shim.mjs'));
await import(out);
