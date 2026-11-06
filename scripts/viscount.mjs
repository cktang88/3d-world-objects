#!/usr/bin/env node
/**
 * Cheap visibility counts for the NYC level at fixed street-level poses — no city rendering.
 *
 *   node scripts/viscount.mjs [--port 5173] [--poses avenue,cross-street,...] [--seed N]
 *        [--r 1] [--max 300] [--out file.json] [--compare file.json] [--no-lock]
 *
 * Loads ?lab=viscount (src/lab/viscount.ts): it builds the real level off-scene, steps
 * level.update() at each pose (same poses as scripts/perf.mjs) so streaming and the visibility
 * system run, and counts in-frustum visible meshes (≈ main-pass draw calls), their triangles and
 * the shadow casters among them. Counts only; nothing about frame time.
 *
 * Builds the whole level in one page (~1 GB), so it takes /tmp/claude-0/world-shot.lock with a
 * 300 s wait (docs/AGENTS.md "Hard limits"), and stops after --max seconds (default 300, cap 600).
 */
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

const LOCK = '/tmp/claude-0/world-shot.lock';
if (!process.env.WORLD_SHOT_LOCKED && !process.argv.includes('--no-lock')) {
  const r = spawnSync('flock', ['-w', '300', LOCK, process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, WORLD_SHOT_LOCKED: '1' } });
  if (r.status === 1 && r.signal === null) console.error('viscount: could not get the world lock within 300 s');
  process.exit(r.status ?? 1);
}

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']] : acc), []),
);
const port = args.port ?? process.env.PORT ?? '5173';
const MAX = Math.min(600, Number(args.max ?? 300));
const killer = setTimeout(() => {
  console.error(`viscount: hit --max ${MAX} s, stopping`);
  process.exit(2);
}, MAX * 1000);

// r=1 by default (3x3 resident ring): never simulate the full city while developing (docs/AGENTS.md)
const q = new URLSearchParams({ lab: 'viscount', quality: 'low', post: '0', r: args.r ?? '1' });
if (args.poses) q.set('poses', args.poses);
if (args.seed) q.set('seed', args.seed);
if (args.vis) q.set('vis', args.vis); // --vis 0: without chunk visibility (before/after)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 160, height: 90 } });
  page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
  await page.goto(`http://localhost:${port}/?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__viscount, null, { timeout: MAX * 1000, polling: 1000 });
  const res = await page.evaluate(() => window.__viscount);
  const cols = ['calls', 'tris', 'shadowCasters', 'shadowTris', 'chunksDrawn', 'chunksLoaded', 'instancedTris', 'sprites'];
  let base = null;
  if (args.compare) base = JSON.parse(readFileSync(args.compare, 'utf8'));
  for (const [name, r] of Object.entries(res)) {
    const parts = cols.map((c) => {
      const d = base?.[name] ? r[c] - base[name][c] : null;
      return `${c} ${r[c]}${d !== null && d !== 0 ? ` (${d > 0 ? '+' : ''}${d})` : ''}`;
    });
    console.log(`${name.padEnd(20)} ${parts.join('  ')}`);
    if (args.debug && r.vis) console.log(`  ${r.vis}`);
  }
  if (args.out) writeFileSync(args.out, JSON.stringify(res, null, 1));
} finally {
  clearTimeout(killer);
  await browser.close();
}
