#!/usr/bin/env node
/**
 * Headless render-count baseline (WP1 in docs/research/performance.md).
 *
 *   node scripts/perf.mjs [--port 5173] [--quality ultra|high|low] [--w 320] [--h 180]
 *        [--poses avenue,cross-street,...] [--out docs/research/perf-baseline.json]
 *        [--compare docs/research/perf-baseline.json] [--top 15] [--timeout 1200]
 *
 * Loads the full world (?mode=world), holds the camera at fixed poses (street level on an avenue,
 * a cross-street, a corner looking down an avenue, an elevated view), then enters a shop, an
 * apartment, the museum atrium and a gallery. At each pose it waits for streaming to settle
 * (chunk count, geometry/texture/program counts unchanged over several frames), then records
 * window.__world.perf(): draw calls, triangles, programs, per-pass counts and a scene census.
 *
 * COUNTS ONLY. SwiftShader frame times are meaningless (and this machine is shared): frameMs is
 * deliberately not written. Counts do not depend on the viewport size, except through its aspect.
 *
 * With --compare it prints per-pose differences against a previous JSON (e.g. the committed
 * baseline) and does not overwrite it unless --out is also given.
 *
 * Takes /tmp/claude-0/world-shot.lock (flock) for the whole run, so full-world runs across agents
 * happen one at a time (--no-lock to skip). Records peak renderer/GPU-process RSS and JS heap.
 *
 * Requests to Hugging Face / Poly Haven / Smithsonian are fetched with curl like scripts/shot.mjs.
 */
import { createRequire } from 'module';
import { execFile, execSync, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, rmSync } from 'fs';

// Full-world runs take ~2 GB and the machine is shared: run them one at a time across all agents
// (docs/AGENTS.md). Re-exec under flock unless we already hold the lock.
const LOCK = '/tmp/claude-0/world-shot.lock';
if (!process.env.WORLD_SHOT_LOCKED && !process.argv.includes('--no-lock')) {
  console.log(`waiting for ${LOCK} ...`);
  const r = spawnSync('flock', [LOCK, process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, WORLD_SHOT_LOCKED: '1' } });
  process.exit(r.status ?? 1);
}

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']] : acc), []),
);
const port = args.port ?? process.env.PORT ?? '5173';
const quality = args.quality ?? 'ultra';
const W = Number(args.w ?? 320), H = Number(args.h ?? 180);
const TOP = Number(args.top ?? 15);
const TIMEOUT = Number(args.timeout ?? 1200) * 1000; // per pose
const seed = args.seed ?? '20261105';
const tod = args.tod ?? 'day';
const out = args.out ?? (args.compare ? null : 'docs/research/perf-baseline.json');

// x: avenues at x = ±60 (chunk edges), z: streets at z = ±32. All outdoor poses stay inside chunk
// (0,0), so the resident set is the same 5x5 ring for all of them. yaw 0 looks toward -z.
const POSES = [
  { name: 'avenue', desc: 'avenue sidewalk mid-block, looking across the avenue', pos: [50.5, 0, 0], yaw: -Math.PI / 2, pitch: 0 },
  { name: 'cross-street', desc: 'cross-street sidewalk mid-block, looking along the street', pos: [0, 0, 25.5], yaw: Math.PI / 2, pitch: 0 },
  { name: 'corner-down-avenue', desc: 'avenue crosswalk at a corner, looking down the avenue', pos: [56, 0, 29], yaw: 0, pitch: 0.02 },
  { name: 'elevated', desc: '45 m up over the block, looking down across the city', pos: [20, 45, 28], yaw: 0.6, pitch: -0.45 },
  { name: 'shop', desc: 'inside the first shop reachable from spawn', enter: 'shop' },
  { name: 'apartment', desc: 'inside the first apartment building reachable from spawn', enter: 'apartment' },
  { name: 'museum-atrium', desc: 'museum atrium spawn', enter: 'atrium' },
  { name: 'gallery', desc: 'first gallery off the atrium', enter: 'gallery' },
];
const want = args.poses ? new Set(args.poses.split(',')) : null;
const poses = POSES.filter((p) => !want || want.has(p.name));

const curl = (u) =>
  new Promise((res) => execFile('curl', ['-sSL', '--max-time', '120', '-D', '-', u], { encoding: 'buffer', maxBuffer: 256 << 20 }, (_e, o) => res(o)));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let browser = null, page = null, cdp = null;

// ---- memory: peak RSS of Chromium's renderer and GPU processes, and the page's JS heap
const mem = { rendererMB: 0, gpuMB: 0, jsHeapMB: 0 };
let poseMem = { rendererMB: 0, gpuMB: 0, jsHeapMB: 0 };
const rssMB = (pid) => { try { return Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024); } catch { return 0; } };
async function sampleMem() {
  try {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    let r = 0, g = 0;
    for (const p of processInfo) {
      if (p.type === 'renderer') r = Math.max(r, rssMB(p.id));
      else if (p.type === 'GPU' || p.type === 'gpu-process') g = Math.max(g, rssMB(p.id));
    }
    const h = Math.round(((await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0).catch(() => 0)) / 2 ** 20));
    for (const m of [mem, poseMem]) { m.rendererMB = Math.max(m.rendererMB, r); m.gpuMB = Math.max(m.gpuMB, g); m.jsHeapMB = Math.max(m.jsHeapMB, h); }
  } catch { /* browser gone or between launches */ }
}
let memTick = 0;
const memTimer = setInterval(async () => {
  await sampleMem();
  if (args.verbose && ++memTick % 15 === 0) {
    const f = await page?.evaluate(() => { const p = window.__world?.perf?.last; const lv = window.__world?.level; return p ? `frame ${p.frame} chunks ${lv?.chunks?.size ?? '-'} calls ${p.calls} geo ${p.geometries} tex ${p.textures}` : ''; }).catch(() => '');
    log(`  mem peak renderer ${poseMem.rendererMB} MB gpu ${poseMem.gpuMB} MB heap ${poseMem.jsHeapMB} MB  ${f}`);
  }
}, 2000);
/** (re)launch the browser and load the world; the renderer can get OOM-killed on a busy machine */
async function open() {
  await browser?.close().catch(() => {});
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'] });
  page = await browser.newPage({ viewport: { width: W, height: H } });
  page.setDefaultTimeout(TIMEOUT);
  cdp = await browser.newBrowserCDPSession();
  await page.route(/huggingface\.co|hf\.co|polyhaven|3d-api\.si\.edu/, async (route) => {
    const buf = await curl(route.request().url());
    if (!buf) return route.abort();
    const s = buf.toString('latin1');
    let idx = 0, last = 0;
    while ((idx = s.indexOf('\r\n\r\n', last)) >= 0 && /^HTTP\//.test(s.slice(last, last + 5))) last = idx + 4;
    const u = route.request().url();
    const type = u.includes('rows?') || u.endsWith('.json') ? 'application/json' : /\.jpe?g/.test(u) ? 'image/jpeg' : /\.png/.test(u) ? 'image/png' : 'application/octet-stream';
    route.fulfill({ status: 200, body: buf.subarray(last), headers: { 'access-control-allow-origin': '*', 'content-type': type } });
  });
  page.on('pageerror', (e) => { if (!/Pointer Lock|pointer lock/i.test(e.message)) log('PAGEERROR', e.message); });
  page.on('console', (m) => { if (m.type() === 'error' && !/pointer lock/i.test(m.text())) log('CONSOLE', m.text().slice(0, 200)); });

  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/?mode=world&quality=${quality}&seed=${seed}&tod=${tod}`, { waitUntil: 'load', timeout: TIMEOUT });
  await page.waitForFunction(() => window.__world?.perf && window.__world.level && window.__world.perf.last.frame > 0, null, { timeout: TIMEOUT, polling: 1000 });
  log(`world up after ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  // hold the player at a pose: re-applied after every frame (the player would otherwise fall/drift)
  await page.evaluate(() => {
    const w = window.__world;
    window.__hold = null;
    const tick = () => {
      const h = window.__hold;
      if (h) {
        w.player.pos.set(h.pos[0], h.pos[1], h.pos[2]);
        w.player.vel.set(0, 0, 0);
        w.player.yaw = h.yaw;
        w.player.pitch = h.pitch;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** wait until chunk/geometry/texture/program counts are unchanged for `frames` frames */
const settle = (minFrames = 6, stableFor = 5) =>
  page.evaluate(([minFrames, stableFor]) => new Promise((resolve) => {
    const p = window.__world.perf;
    const start = p.last.frame;
    let key = '', since = 0, lastFrame = start;
    const poll = () => {
      const f = p.last;
      if (f.frame !== lastFrame) {
        lastFrame = f.frame;
        const lv = window.__world.level;
        const k = [lv?.chunks?.size ?? 0, f.geometries, f.textures, f.programs, lv?.name].join('|');
        if (k === key) since++;
        else { key = k; since = 0; }
        if (f.frame - start >= minFrames && since >= stableFor) return resolve({ frames: f.frame - start, key });
      }
      setTimeout(poll, 250);
    };
    poll();
  }), [minFrames, stableFor]);

/** median-by-calls of n consecutive frames, plus the census and top contributors */
const sample = (n = 3) =>
  page.evaluate(([n, top]) => new Promise((resolve) => {
    const p = window.__world.perf;
    const got = [];
    let lastFrame = p.last.frame;
    const poll = () => {
      if (p.last.frame !== lastFrame) {
        lastFrame = p.last.frame;
        got.push(p({ top }));
        if (got.length >= n) {
          got.sort((a, b) => a.calls - b.calls);
          const m = got[Math.floor(got.length / 2)];
          return resolve({ ...m, callsRange: [got[0].calls, got[got.length - 1].calls] });
        }
      }
      setTimeout(poll, 250);
    };
    poll();
  }), [n, TOP]);

const waitIdle = () => page.waitForFunction(() => !document.getElementById('fade') || Number(getComputedStyle(document.getElementById('fade')).opacity) < 0.01, null, { polling: 500 }).catch(() => {});

// portals to enter, collected while standing in the city
let targets = null;
const results = {};
const RETRIES = Number(args.retries ?? 2);
await open();
for (const pose of poses) {
  for (let attempt = 0; ; attempt++) {
    try {
      await measure(pose);
      break;
    } catch (e) {
      log(`${pose.name}: ${e.message.split('\n')[0]}`);
      if (attempt >= RETRIES) { log('giving up on', pose.name); break; }
      log('relaunching');
      targets = null;
      await open();
    }
  }
  if (out) writeFileSync(out + '.partial', JSON.stringify(results, null, 1));
}
clearInterval(memTimer);
await browser.close();

async function measure(pose) {
  const ts = Date.now();
  poseMem = { rendererMB: 0, gpuMB: 0, jsHeapMB: 0 };
  let label = null;
  if (pose.pos) {
    if ((await page.evaluate(() => window.__world.level.name)) !== 'Manhattan') {
      log('skip', pose.name, '(no longer in the city: put outdoor poses first)');
      return;
    }
    await page.evaluate((h) => { window.__hold = h; }, { pos: pose.pos, yaw: pose.yaw, pitch: pose.pitch });
  } else {
    if (!targets) {
      targets = await page.evaluate(() => {
        const ps = window.__world.level.portals();
        const shop = ps.find((p) => p.target?.kind === 'interior' && p.target.shop);
        const apt = ps.find((p) => p.target?.kind === 'interior' && !p.target.shop);
        return { shop: shop ? { label: shop.label, target: shop.target } : null, apartment: apt ? { label: apt.label, target: apt.target } : null };
      });
    }
    await page.evaluate(() => { window.__hold = null; });
    if (pose.enter === 'shop' || pose.enter === 'apartment') {
      const t = targets[pose.enter];
      if (!t) { log('skip', pose.name, '(no portal found)'); return; }
      label = t.label;
      await page.evaluate((t) => window.__world.enter({ target: t.target, label: t.label }), t).catch((e) => log('enter failed', e.message));
    } else if (pose.enter === 'atrium') {
      await page.evaluate(() => window.__world.startMode('museum'));
      label = 'atrium';
    } else if (pose.enter === 'gallery') {
      if ((await page.evaluate(() => window.__world.level.name)) !== 'Atrium') await page.evaluate(() => window.__world.startMode('museum'));
      const g = await page.evaluate(() => {
        const p = window.__world.level.portals().find((p) => p.target?.kind === 'gallery');
        return p ? { label: p.label, target: p.target } : null;
      });
      if (!g) { log('skip', pose.name, '(no gallery portal in the atrium)'); return; }
      label = g.label;
      await page.evaluate((g) => window.__world.enter({ target: g.target, label: g.label }), g);
    }
    await waitIdle();
    // hold the player where the level spawned it
    await page.evaluate(() => {
      const s = window.__world.level.spawn;
      window.__hold = { pos: [s.pos.x, s.pos.y, s.pos.z], yaw: s.yaw, pitch: 0 };
    });
  }
  const limit = (p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), TIMEOUT))]);
  const st = await limit(settle(), 'settle');
  const s = await limit(sample(), 'sample');
  const lvName = await page.evaluate(() => window.__world.level.name);
  results[pose.name] = {
    desc: pose.desc, level: lvName, ...(label ? { portal: label } : {}), ...(pose.pos ? { pos: pose.pos, yaw: +pose.yaw.toFixed(3), pitch: pose.pitch } : {}),
    calls: s.calls, callsRange: s.callsRange, tris: s.tris, programs: s.programs, geometries: s.geometries, textures: s.textures,
    perPass: s.perPass, scene: s.scene, top: s.top, settleFrames: st.frames ?? null,
    memoryPeak: { ...poseMem },
  };
  await sampleMem();
  log(`${pose.name.padEnd(20)} mem renderer ${poseMem.rendererMB} MB gpu ${poseMem.gpuMB} MB heap ${poseMem.jsHeapMB} MB`);
  log(`${pose.name.padEnd(20)} calls ${String(s.calls).padStart(5)}  tris ${(s.tris / 1e6).toFixed(2)}M  programs ${s.programs}  inFrustum ${s.scene.meshesInFrustum}/${s.scene.meshesVisible}  (${((Date.now() - ts) / 1000).toFixed(0)} s)`);
  for (const [k, v] of Object.entries(s.perPass)) log(`    ${k.padEnd(22)} ${String(v.calls).padStart(5)} ${(v.tris / 1e6).toFixed(2).padStart(6)}M x${v.n}`);
}

let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD').toString().trim(); } catch {}
const doc = {
  note: 'COUNTS ONLY (headless SwiftShader; frame times are never recorded). Generated by scripts/perf.mjs. perPass is exclusive: "RenderPass/shadow" is the shadow maps rendered inside the main pass, etc. scene.trisInFrustum counts in-frustum meshes x instances before depth/occlusion.',
  commit, date: new Date().toISOString(), quality, viewport: [W, H], seed: Number(seed), tod,
  memoryPeak: { ...mem, note: 'peak RSS (MB) of the Chromium renderer and GPU processes and the JS heap over the whole run, sampled every 2 s; SwiftShader keeps GPU resources in the GPU process RSS' },
  poses: results,
};

if (args.compare) {
  const base = JSON.parse(readFileSync(args.compare, 'utf8'));
  console.log(`\ncompare vs ${args.compare} (${base.commit}, ${base.quality})`);
  const pct = (a, b) => (b ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%` : 'n/a');
  for (const [k, v] of Object.entries(results)) {
    const b = base.poses?.[k];
    if (!b) { console.log(`  ${k}: no baseline`); continue; }
    console.log(`  ${k.padEnd(20)} calls ${b.calls} -> ${v.calls} (${pct(v.calls, b.calls)})  tris ${b.tris} -> ${v.tris} (${pct(v.tris, b.tris)})  programs ${b.programs} -> ${v.programs}`);
    for (const p of new Set([...Object.keys(b.perPass ?? {}), ...Object.keys(v.perPass)])) {
      const x = b.perPass?.[p] ?? { calls: 0, tris: 0 }, y = v.perPass[p] ?? { calls: 0, tris: 0 };
      if (x.calls !== y.calls || x.tris !== y.tris) console.log(`      ${p.padEnd(22)} calls ${x.calls} -> ${y.calls}  tris ${x.tris} -> ${y.tris}`);
    }
  }
}
if (out) {
  writeFileSync(out, JSON.stringify(doc, null, 1) + '\n');
  rmSync(out + '.partial', { force: true });
  log('wrote', out);
}
