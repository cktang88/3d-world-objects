#!/usr/bin/env node
/**
 * Fast QA: run tests/**\/*.test.ts in Node against the real level generators (no browser,
 * no WebGL, no textures). See .claude/skills/fast-3d-testing/SKILL.md.
 *
 *   npm run qa                    all test files
 *   npm run qa -- museum shop     files whose path matches any pattern
 *   npm run qa -- -t "door"       only tests whose name matches (QA_TEST)
 *   QA_VERBOSE=1 npm run qa       show passing tests, KNOWN notes and the shim's suppressed warnings
 *
 * Hard limits (nothing may run long): QA_TEST_TIMEOUT per test (default 20 s), QA_FILE_TIMEOUT
 * per file (default 45 s, the process is killed), QA_MAX for the whole run (default 120 s).
 *
 * esbuild bundles each test file (three stays external, so Node loads it once from
 * node_modules), then up to QA_JOBS (default 3) node processes run them in parallel, each with
 * tests/shim.ts preloaded via --import.
 */
import { build } from 'esbuild';
import { spawn } from 'child_process';
import { readdirSync, statSync, mkdirSync, rmSync } from 'fs';
import { join, relative, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.qa-cache', `run-${process.pid}`);
const argv = process.argv.slice(2);
const patterns = [];
let testFilter = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-t') testFilter = argv[++i] ?? '';
  else patterns.push(argv[i]);
}
const t0 = performance.now();

const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(join(ROOT, 'tests')).filter((f) => f.endsWith('.test.ts')).filter((f) => !patterns.length || patterns.some((p) => relative(ROOT, f).includes(p)));
if (!files.length) { console.log('qa: no test files match', patterns.join(' ')); process.exit(1); }

// esbuild resolves into a per-run dir inside node_modules (a symlink in worktrees) so that the
// bundles' bare `three` imports resolve to the same node_modules
mkdirSync(OUT, { recursive: true });
const common = {
  bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: 'inline', logLevel: 'error',
  external: ['three', 'three/*', 'esbuild'],
  define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.MODE': '"qa"' },
  loader: { '.css': 'empty' },
};
try {
  await build({ ...common, entryPoints: { shim: join(ROOT, 'tests/shim.ts') }, outdir: OUT, outExtension: { '.js': '.mjs' } });
  await build({ ...common, entryPoints: Object.fromEntries(files.map((f) => [relative(join(ROOT, 'tests'), f).replace(/\.ts$/, '').replace(/[\\/]/g, '__'), f])), outdir: OUT, outExtension: { '.js': '.mjs' }, splitting: true, chunkNames: 'chunk-[hash]' });
} catch (e) {
  console.log('qa: build failed'); rmSync(OUT, { recursive: true, force: true }); process.exit(1);
}
const tBuild = performance.now() - t0;

const jobs = Number(process.env.QA_JOBS ?? 3);
const FILE_TIMEOUT = Number(process.env.QA_FILE_TIMEOUT ?? 45000);
const MAX = Number(process.env.QA_MAX ?? 120000);
const children = new Set();
const cap = setTimeout(() => {
  console.log(`qa: total cap of ${MAX / 1000} s reached, killing ${children.size} running file(s)`);
  for (const c of children) c.kill('SIGKILL');
  queue.length = 0;
}, MAX);
cap.unref();
const results = [];
let failed = 0, notes = 0;
const queue = [...files];
async function worker() {
  for (let f; (f = queue.shift()); ) {
    const name = relative(join(ROOT, 'tests'), f);
    const out = join(OUT, name.replace(/\.ts$/, '').replace(/[\\/]/g, '__') + '.mjs');
    const s = performance.now();
    const { code, text } = await new Promise((res) => {
      const p = spawn(process.execPath, ['--enable-source-maps', '--import', join(OUT, 'shim.mjs'), out], {
        cwd: ROOT, env: { ...process.env, QA_ROOT: ROOT, QA_TEST: testFilter }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      p.stdout.on('data', (d) => (text += d)); p.stderr.on('data', (d) => (text += d));
      const kill = setTimeout(() => { text += `\n  FAIL file timed out after ${FILE_TIMEOUT / 1000} s (killed)`; p.kill('SIGKILL'); }, FILE_TIMEOUT);
      children.add(p);
      p.on('close', () => children.delete(p));
      p.on('close', (code) => { clearTimeout(kill); res({ code, text }); });
    });
    const m = /@@QA (.*)/.exec(text);
    const r = m ? JSON.parse(m[1]) : { pass: 0, fail: 1, skip: 0 };
    if (code !== 0 && !r.fail) r.fail = 1;
    failed += r.fail;
    results.push({ name, ...r, ms: Math.round(performance.now() - s) });
    console.log(`${r.fail ? 'FAIL' : 'ok  '} ${name}  ${r.pass} passed${r.fail ? `, ${r.fail} failed` : ''}  ${Math.round(performance.now() - s)} ms`);
    const verbose = process.env.QA_VERBOSE === '1';
    const lines = text.replace(/@@QA .*\n?/, '').split('\n');
    notes += lines.filter((l) => /^\s+NOTE/.test(l)).length;
    const body = lines.filter((l) => verbose || (!/^\s+PASS/.test(l) && !/^\s+NOTE/.test(l))).join('\n').trim();
    if (body) console.log(body.split('\n').map((l) => '  ' + l).join('\n'));
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
rmSync(OUT, { recursive: true, force: true });
const pass = results.reduce((a, r) => a + r.pass, 0);
clearTimeout(cap);
console.log(`\nqa: ${pass} passed, ${failed} failed${notes ? `, ${notes} known-issue notes (QA_VERBOSE=1 to list; docs/research/qa-findings.md)` : ''} in ${files.length} files — ${((performance.now() - t0) / 1000).toFixed(1)} s (build ${Math.round(tBuild)} ms)`);
process.exit(failed ? 1 : 0);
