#!/usr/bin/env node
/**
 * Fast QA: run tests/**\/*.test.ts in Node against the real level generators (no browser,
 * no WebGL, no textures). See .claude/skills/fast-3d-testing/SKILL.md.
 *
 *   npm run qa                    all test files
 *   npm run qa -- museum shop     areas (AREAS below: nyc ground people vehicles shop interior
 *                                 museum seamless districts vertical ...) or test-file patterns
 *   npm run qa:changed            only the tests covering files changed vs origin/main (SRC_MAP)
 *   npm run qa -- -t "door"       only tests whose name matches (QA_TEST)
 *   QA_VERBOSE=1 npm run qa       show passing tests, KNOWN notes and the shim's suppressed warnings
 *
 * Hard limits (nothing may run long): QA_TEST_TIMEOUT per test (default 20 s), QA_FILE_TIMEOUT
 * per file (default 45 s, the process is killed), QA_MAX for the whole run (default 240 s; the suite outgrew 120 s under parallel-agent load).
 *
 * esbuild bundles each test file (three stays external, so Node loads it once from
 * node_modules), then up to QA_JOBS (default 3) node processes run them in parallel, each with
 * tests/shim.ts preloaded via --import.
 */
import { build } from 'esbuild';
import { spawn, execFileSync } from 'child_process';
import { readdirSync, statSync, mkdirSync, rmSync } from 'fs';
import { join, relative, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.qa-cache', `run-${process.pid}`);
const argv = process.argv.slice(2);
const patterns = [];
let testFilter = '';
let changed = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-t') testFilter = argv[++i] ?? '';
  else if (argv[i] === '--changed') changed = true;
  else patterns.push(argv[i]);
}
const t0 = performance.now();

/** areas -> test files (tests/<name>.test.ts): `npm run qa -- people` runs tests/people.test.ts */
const AREAS = {
  nyc: ['nyc', 'ground'], ground: ['ground'], streets: ['nyc', 'ground'], buildings: ['nyc', 'buildings'],
  districts: ['districts', 'districts-blocks', 'districts-open', 'districts-scale', 'districts-overlap', 'districts-ground'],
  people: ['people', 'crossing'], crossing: ['crossing'], vehicles: ['vehicles'], traffic: ['vehicles', 'crossing'],
  shop: ['shop', 'shopaudit'], shops: ['shop', 'shopaudit'], interior: ['interior'], interiors: ['interior'], vertical: ['vertical'],
  lighting: ['lighting'], light: ['lighting'], materials: ['materials'], rebuilt: ['materials'],
  zfight: ['zfight'], flicker: ['zfight'], memory: ['memory', 'memory-city'], mem: ['memory', 'memory-city'], leaks: ['memory', 'memory-city'],
  meshlod: ['meshlod'], lod: ['meshlod'], simplify: ['meshlod'],
  museum: ['museum'], libraries: ['libraries'], library: ['libraries'], seamless: ['seamless'], lazy: ['seamless', 'interior', 'shop'], realscale: ['realscale', 'seamless', 'museum'],
};
/** changed file -> areas (first match wins; '*' = every test file). Add a line when you add a test file. */
const SRC_MAP = [
  [/^tests\/(qa|shim|env|world)\.ts$|^scripts\/qa\.mjs$|^src\/(level|build|rng|detail)\.ts$/, ['*']],
  [/^tests\/(.+)\.test\.ts$/, (m) => [m[1]]],
  [/^tests\/heap\.ts$|^src\/dispose\.ts$/, ['memory', 'memory-city']],
  [/^src\/nyc\/people/, ['people']],
  [/^src\/nyc\/ground/, ['ground']],
  [/^src\/rooms\/vertical/, ['vertical']],
  [/^src\/nyc\/vehicle/, ['vehicles']],
  [/^src\/zfix\.ts$/, ['zfight']],
  [/^src\/(meshlod|meshlod-core)\.ts$|^src\/vendor\/meshopt|^scripts\/(build_vehicles\.mjs|lib\/simplify-doc\.mjs)$|^public\/assets\/vehicles\//, ['meshlod', 'vehicles']],
  [/^src\/(minimap|nyc\/minimap-nyc)\.ts$/, ['minimap']],
  [/^src\/nyc\/district/, ['districts']],
  [/^src\/nyc\/common\.ts$/, ['nyc', 'people', 'vehicles', 'districts']],
  [/^src\/nyc\/buildings-shop\.ts$/, ['nyc', 'buildings', 'shop']],
  [/^src\/nyc\/buildings/, ['nyc', 'buildings']],
  [/^src\/(nyc\.ts|nyc\/)/, ['nyc']],
  [/^src\/(shop\.ts|shopkit\/)/, ['shop']],
  [/^src\/(interior\.ts|rooms\/)/, ['interior']],
  [/^src\/libraries(\.ts|\/)|^public\/libraries\/|^scripts\/libraries\//, ['libraries', 'museum']],
  [/^src\/(museum\.ts|museumData\.ts|museum\/|libraries\.ts)/, ['museum']],
  [/^src\/(seamless|lazy)\.ts$/, ['seamless', 'lazy']],
  [/^src\/(realscale|realsize-labels)\.ts$|^scripts\/build_realsize/, ['realscale']],
  [/^src\/lighting\.ts$/, ['lighting']],
  [/^src\/(materials|rebuiltCheck|remote)\.ts$|^scripts\/(rebuild\.py|audit_rebuilt\.mjs)$|^public\/rebuilt\//, ['materials', 'nyc', 'interior', 'shop']],
  [/^src\/(assets|remote|materials|textures|pbr)\.ts$/, ['nyc', 'interior', 'shop']],
];
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const all = walk(join(ROOT, 'tests')).filter((f) => f.endsWith('.test.ts'));
const nameOf = (f) => relative(join(ROOT, 'tests'), f).replace(/\.test\.ts$/, '');
if (changed) {
  // files changed against origin/main (committed or not), mapped to the tests that cover them
  const sh = (a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; } };
  const base = sh(['merge-base', 'HEAD', 'origin/main'])[0] ?? 'origin/main';
  const list = [...new Set([...sh(['diff', '--name-only', base]), ...sh(['ls-files', '--others', '--exclude-standard', 'src', 'tests'])])];
  const areas = new Set();
  for (const f of list) for (const [re, a] of SRC_MAP) { const m = re.exec(f); if (m) { for (const x of typeof a === 'function' ? a(m) : a) areas.add(x); break; } }
  console.log(`qa --changed: ${list.length} changed file(s) -> ${areas.size ? [...areas].join(', ') : 'no tests cover them'}`);
  if (!areas.size) process.exit(0);
  if (!areas.has('*')) patterns.push(...areas);
}
const want = new Set(patterns.flatMap((p) => AREAS[p] ?? [p]));
const files = all.filter((f) => !patterns.length || want.has(nameOf(f)) || patterns.some((p) => !AREAS[p] && relative(ROOT, f).includes(p)));
if (!files.length) { console.log(`qa: no test files match ${patterns.join(' ')} (areas: ${Object.keys(AREAS).join(', ')}; files: ${all.map(nameOf).join(', ')})`); process.exit(1); }

// bundles go to .qa-cache/run-<pid> (gitignored); their bare `three` imports resolve to node_modules
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
const MAX = Number(process.env.QA_MAX ?? 240000);
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
      const p = spawn(process.execPath, ['--enable-source-maps', '--expose-gc', '--import', join(OUT, 'shim.mjs'), out], {
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
