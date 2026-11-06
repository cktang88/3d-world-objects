#!/usr/bin/env node
/**
 * npm run e2e -- <journey|all>[,<journey>...] [--port 5173] [--shots] [--out <dir>]
 *
 * Runs scripts/e2e/<journey>.mjs (street, shop, building, elevator, museum, districts) one after
 * another, each under the world lock (/tmp/claude-0/world-shot.lock) and capped at 240 s.
 * Needs your own dev server: npx vite --port <port> --strictPort. Exits 1 if any journey failed.
 */
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const all = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && !['lib.mjs', 'run.mjs'].includes(f)).map((f) => f.replace(/\.mjs$/, '')).sort();
const [which = '', ...rest] = process.argv.slice(2);
const list = which === 'all' ? all : which.split(',').filter(Boolean);
if (!list.length || list.some((j) => !all.includes(j))) {
  console.log(`usage: npm run e2e -- <${all.join('|')}|all>[,...] [--port 5173] [--shots]`);
  process.exit(2);
}
const failed = [];
for (const j of list) {
  const r = spawnSync(process.execPath, [path.join(dir, `${j}.mjs`), ...rest], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(`${j} (exit ${r.status})`);
}
console.log(failed.length ? `e2e: FAILED ${failed.join(', ')}` : `e2e: all ${list.length} journeys passed`);
process.exit(failed.length ? 1 : 0);
