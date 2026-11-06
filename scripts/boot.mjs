#!/usr/bin/env node
/**
 * Boot-path profiler: how long a page takes to reach its first rendered frame, and where the time goes.
 *
 *   node scripts/boot.mjs --port 5173 --url "/?mode=world&fast=1" [--w 480] [--h 270] [--max 240]
 *
 * Logs, with timestamps from navigation start:
 *   - network: vite module requests (count, bytes, the slowest ones), other fetches (JSON, GLB, images)
 *   - page stage marks from src/boot.ts (window.__boot: manifest, museum, pbr, rebuilt index, level
 *     build, first frame, shader programs, ...)
 *   - first frame: window.__world.perf.last.frame > 0, or window.__labReady for labs
 * --programs: list the shader programs (name, users, cache key) at the first frame.
 * --frames N: after the first frame, log N frames (interval, draw CPU, programs).
 * --steady S: CPU profile of S seconds after the first frame (steady-state frames).
 * --profile: V8 CPU profile from navigation to first frame; prints self time by function and by file.
 * RSS: the browser's processes are sampled every second; the summary has the peak and the RSS at
 * the first frame per process type (gpu, renderer, browser, ...) and window.__mem() (src/dispose.ts).
 * Hard cap: --max seconds (default 240, at most 600), then the browser is killed and it exits 124.
 * Full-game URLs take the world lock (flock -w 300) like perf.mjs; labs (?lab=) do not.
 */
import { createRequire } from 'module';
import { execFile, spawnSync } from 'child_process';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']] : acc), []),
);
const url = args.url ?? '/?mode=world&fast=1';
const LOCK = '/tmp/claude-0/world-shot.lock';
if (!/[?&]lab=/.test(url) && !process.env.WORLD_SHOT_LOCKED && !args['no-lock']) {
  const r = spawnSync('flock', ['-w', '300', '-E', '75', LOCK, process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, WORLD_SHOT_LOCKED: '1' } });
  if (r.status === 75) console.log('[boot] world lock busy for 300 s');
  process.exit(r.status ?? 1);
}
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const port = args.port ?? '5173';
const W = Number(args.w ?? 480), H = Number(args.h ?? 270);
const MAX = Math.min(600, Number(args.max ?? 240));

let t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[boot ${ts()}]`, ...a);
let browser;
setTimeout(() => {
  log(`TIMEOUT after ${MAX}s`);
  summary();
  try { browser?.process?.()?.kill('SIGKILL'); } catch {}
  process.exit(124);
}, MAX * 1000).unref();

const curl = (u) => new Promise((res) => execFile('curl', ['-sSL', '--max-time', '60', '-D', '-', u], { encoding: 'buffer', maxBuffer: 256 << 20 }, (_e, o) => res(o)));

// ---- RSS per Chrome process type (children of this node process), sampled every second
const rssNow = () => {
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' });
  const rows = (r.stdout ?? '').trim().split('\n').map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l); return m ? [+m[1], +m[2], +m[3], m[4]] : null; }).filter(Boolean);
  const tree = new Set([process.pid]);
  for (let grew = true; grew; ) { grew = false; for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true; } }
  const by = {};
  for (const [pid, , kb, a] of rows) {
    if (!tree.has(pid) || pid === process.pid) continue;
    const t = /--type=([\w-]+)/.exec(a)?.[1] ?? (/chrom/i.test(a) ? 'browser' : 'other');
    const k = t === 'utility' ? `utility:${/--utility-sub-type=[\w.]*?(\w+)\b/.exec(a)?.[1] ?? ''}` : t;
    by[k] = (by[k] ?? 0) + kb / 1024;
  }
  by.total = Object.values(by).reduce((s, v) => s + v, 0);
  return by;
};
const rssPeak = {};
const rssTimer = setInterval(() => { for (const [k, v] of Object.entries(rssNow())) rssPeak[k] = Math.max(rssPeak[k] ?? 0, v); }, 1000);
rssTimer.unref();
const fmtRss = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ');

browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.route(/huggingface\.co|hf\.co|polyhaven|3d-api\.si\.edu/, async (route) => {
  const buf = await curl(route.request().url());
  if (!buf) return route.abort().catch(() => {});
  const s = buf.toString('latin1');
  let idx = 0, last = 0;
  while ((idx = s.indexOf('\r\n\r\n', last)) >= 0 && /^HTTP\//.test(s.slice(last, last + 5))) last = idx + 4;
  const u = route.request().url();
  const type = u.includes('rows?') || u.endsWith('.json') ? 'application/json' : /\.jpe?g/.test(u) ? 'image/jpeg' : /\.png/.test(u) ? 'image/png' : 'application/octet-stream';
  route.fulfill({ status: 200, body: buf.subarray(last), headers: { 'access-control-allow-origin': '*', 'content-type': type } }).catch(() => {});
});

// ---- network accounting
const started = new Map();
const mods = { n: 0, bytes: 0, last: 0, slow: [] };
const other = [];
page.on('request', (r) => started.set(r, Date.now()));
page.on('requestfinished', async (r) => {
  const t = Date.now(), dt = t - (started.get(r) ?? t);
  const u = r.url().replace(`http://localhost:${port}`, '');
  const size = (await r.sizes().catch(() => null))?.responseBodySize ?? 0;
  const isMod = r.resourceType() === 'script' || /\.(ts|js|mjs)(\?|$)|^\/@|node_modules/.test(u);
  if (isMod) {
    mods.n++; mods.bytes += size; mods.last = t - t0;
    mods.slow.push([dt, u]);
    if (mods.n % 50 === 0) log(`modules: ${mods.n} loaded (${(mods.bytes / 2 ** 20).toFixed(1)} MB)`);
  } else {
    other.push([t - t0, dt, size, u]);
    if (size > 200e3 || dt > 3000) log(`fetch ${u.slice(0, 100)} ${(size / 1024).toFixed(0)} KB in ${(dt / 1000).toFixed(1)}s`);
  }
});
page.on('pageerror', (e) => { if (!/pointer lock/i.test(e.message)) log('PAGEERROR', e.message.slice(0, 200)); });
page.on('crash', () => log('PAGE CRASHED'));
page.on('console', (m) => { const t = m.text(); if (t.startsWith('[boot]')) console.log(`[boot ${ts()}] page`, t.slice(7)); });

function summary() {
  mods.slow.sort((a, b) => b[0] - a[0]);
  console.log(`\nmodules: ${mods.n} (${(mods.bytes / 2 ** 20).toFixed(1)} MB), last at +${(mods.last / 1000).toFixed(1)}s; slowest:`);
  for (const [dt, u] of mods.slow.slice(0, 8)) console.log(`  ${(dt / 1000).toFixed(1)}s  ${u.slice(0, 110)}`);
  const ob = other.reduce((a, o) => a + o[2], 0);
  console.log(`other fetches: ${other.length} (${(ob / 2 ** 20).toFixed(1)} MB); largest:`);
  for (const o of [...other].sort((a, b) => b[2] - a[2]).slice(0, 8)) console.log(`  +${(o[0] / 1000).toFixed(1)}s  ${(o[2] / 1024).toFixed(0)} KB  ${(o[1] / 1000).toFixed(1)}s  ${o[3].slice(0, 100)}`);
}

let prof = null;
if (args.profile) {
  prof = await page.context().newCDPSession(page);
  await prof.send('Profiler.enable');
  await prof.send('Profiler.setSamplingInterval', { interval: 1000 });
  await prof.send('Profiler.start');
}
log('goto', url);
t0 = Date.now();
await page.goto(`http://localhost:${port}${url}`, { waitUntil: 'domcontentloaded', timeout: MAX * 1000 });
log('domcontentloaded');
const first = await page.waitForFunction(() => {
  const w = window;
  if (w.__labReady && w.__labReadyDone) return 'lab ready';
  if (w.__labReady && !w.__labHooked) { w.__labHooked = true; w.__labReady.then(() => (w.__labReadyDone = true)); }
  const f = w.__world?.perf?.last?.frame ?? 0;
  return f > 0 && !w.__labReady ? `frame ${f}` : false;
}, null, { timeout: MAX * 1000, polling: 250 }).then((h) => h.jsonValue());
log(`FIRST FRAME (${first})`);
const info = await page.evaluate(() => ({ boot: window.__boot ?? null, programs: window.__world?.renderer?.info?.programs?.length ?? null, perf: window.__world?.perf?.last ?? null }));
log(`programs ${info.programs}  calls ${info.perf?.calls}  tris ${info.perf?.tris}`);
log(`RSS MB at first frame: ${fmtRss(rssNow())}`);
log(`RSS MB peak so far:    ${fmtRss(rssPeak)}`);
log(`__mem(): ${JSON.stringify(await page.evaluate(() => window.__mem?.() ?? null).catch(() => null))}`);
if (info.boot) console.log('stage marks (s):', JSON.stringify(info.boot));
if (args.frames) {
  // steady state after the first frame: per-frame draw CPU vs whole-frame interval, and program growth
  const n = Number(args.frames);
  for (let i = 0, lastF = -1; i < n; ) {
    const f = await page.evaluate(() => ({ ...window.__world.perf.last, perPass: undefined })).catch(() => null);
    if (f && f.frame !== lastF) { lastF = f.frame; i++; log(`frame ${f.frame}: interval ${f.frameMs} ms, draw ${f.cpuMs} ms, calls ${f.calls}, programs ${f.programs}`); }
    await page.waitForTimeout(200);
  }
}
if (args.programs) {
  const progs = await page.evaluate(() => (window.__world?.renderer?.info?.programs ?? []).map((p) => ({ name: p.name, used: p.usedTimes, key: p.cacheKey })));
  console.log(`programs (${progs.length}):`);
  for (const p of progs) console.log(`  ${p.name.padEnd(26)} x${p.used}  ${p.key.replace(/\n/g, ' ').slice(0, 260)}`);
}
summary();
if (args.steady) {
  // CPU profile of the steady state: N seconds after the first frame
  prof ??= await page.context().newCDPSession(page);
  await prof.send('Profiler.enable');
  await prof.send('Profiler.setSamplingInterval', { interval: 1000 });
  await prof.send('Profiler.start').catch(() => {});
  if (args.profile) log('(profile covers boot + steady state)');
  await new Promise((r) => setTimeout(r, Number(args.steady) * 1000));
}
if (prof) {
  const { profile } = await prof.send('Profiler.stop');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dts = profile.timeDeltas;
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (dts[i] ?? 0)));
  const fn = new Map(), file = new Map();
  let total = 0;
  for (const [id, us] of self) {
    const cf = byId.get(id).callFrame;
    total += us;
    const f = (cf.url || '').replace(/^https?:\/\/localhost:\d+/, '').replace(/\?.*$/, '') || `(${cf.functionName || 'native'})`;
    const k = `${cf.functionName || '(anon)'}  ${f}:${cf.lineNumber + 1}`;
    fn.set(k, (fn.get(k) ?? 0) + us);
    file.set(f, (file.get(f) ?? 0) + us);
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => `  ${(us / 1e6).toFixed(2).padStart(6)}s ${((us / total) * 100).toFixed(1).padStart(5)}%  ${k.slice(0, 120)}`).join('\n');
  console.log(`\nCPU profile ${(total / 1e6).toFixed(1)}s sampled. By file:\n${top(file, 18)}\nBy function:\n${top(fn, 30)}`);
}
try { browser.process()?.kill('SIGKILL'); } catch {}
process.exit(0);
