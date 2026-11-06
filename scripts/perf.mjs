#!/usr/bin/env node
/**
 * Headless render-count baseline (WP1 in docs/research/performance.md). COUNTS ONLY.
 *
 *   node scripts/perf.mjs --poses avenue [--small] [--port 5173] [--quality low|high|ultra]
 *        [--max 240] [--pose-max 150] [--out docs/research/perf-baseline.json]
 *        [--compare docs/research/perf-baseline.json] [--top 15] [--w 320] [--h 180]
 *
 * One browser load per run, then the listed poses in order. Outdoor poses (street level on an
 * avenue, a cross-street, a corner looking down an avenue, an elevated view) hold the camera in
 * the city; shop / apartment / museum-atrium / gallery enter those levels. At each pose it waits
 * until chunk/geometry/texture/program counts stop changing, then records window.__world.perf()
 * (draw calls, triangles, programs, exclusive per-pass counts, scene census, top triangle
 * contributors) and the peak renderer / GPU-process RSS and JS heap.
 *
 * Hard limits (docs/AGENTS.md): the whole run stops at --max seconds (default 240, at most 600):
 * it kills its browser, keeps what it measured, and exits 124. Each pose stops at --pose-max.
 * The world lock is taken with `flock -w 300` (exit 75 if it is not free in time). No retries:
 * after a failure, shrink the run (fewer poses, --small) instead of repeating it.
 *
 * The city is loaded with ?r=1 (3x3 chunks, src/nyc/common.ts): never the full city in dev/QA.
 * Counts scale per chunk. Results go to `poses`. --full streams the whole city (5x5 chunks) into
 * `posesFull`: one optional run at the very end of a work package only.
 * --small additionally sets ?people=0&notex=1 (no pedestrians, no HDRI/PBR downloads) into
 * `posesSmall`, for the fastest structural comparisons.
 * Results are merged into the output file pose by pose, so runs can be split up and resumed.
 *
 * Shop/apartment portals are found in the city once and stored in the output file (`targets`);
 * later runs enter them directly from a museum load, without building the city.
 *
 * SwiftShader frame times are meaningless and are never written.
 */
import { createRequire } from 'module';
import { execFile, execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']] : acc), []),
);

// ---- world lock: full-game runs one at a time across agents
const LOCK = '/tmp/claude-0/world-shot.lock';
if (!process.env.WORLD_SHOT_LOCKED && !args['no-lock']) {
  console.log(`[perf] waiting up to 300 s for ${LOCK}`);
  const r = spawnSync('flock', ['-w', '300', '-E', '75', LOCK, process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, WORLD_SHOT_LOCKED: '1' } });
  if (r.status === 75) console.log('[perf] world lock busy for 300 s: try again later');
  process.exit(r.status ?? 1);
}

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const port = args.port ?? process.env.PORT ?? '5173';
const quality = args.quality ?? 'low';
const W = Number(args.w ?? 320), H = Number(args.h ?? 180);
const TOP = Number(args.top ?? 15);
const MAX = Math.min(600, Number(args.max ?? 240));
const POSE_MAX = Number(args['pose-max'] ?? 150) * 1000;
const SMALL = !!args.small;
const seed = args.seed ?? '20261105';
const tod = args.tod ?? 'day';
const out = args.out ?? (args.compare ? null : 'docs/research/perf-baseline.json');
const FULL = !!args.full;
const section = FULL ? 'posesFull' : SMALL ? 'posesSmall' : 'poses';

const t0 = Date.now();
const log = (...a) => console.log(`[perf +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// x: avenues at x = ±60 (chunk edges), z: streets at z = ±32. All outdoor poses stay inside chunk
// (0,0), so the resident set is the same for all of them. yaw 0 looks toward -z.
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
if (!args.poses) {
  console.log(`usage: node scripts/perf.mjs --poses <${POSES.map((p) => p.name).join(',')}> [--small] [--max 240]\n(one or two poses per run keeps it under the time cap)`);
  process.exit(2);
}
const want = new Set(args.poses.split(','));
const poses = POSES.filter((p) => want.has(p.name));

// ---- output file (merged pose by pose)
const doc = out && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD').toString().trim(); } catch {}
doc.note = 'COUNTS ONLY (headless SwiftShader; frame times are never recorded). Generated by scripts/perf.mjs. perPass is exclusive: "main/shadow" (quality=low) or "RenderPass/shadow" (ultra) is the shadow maps rendered inside the main pass. scene.trisInFrustum = in-frustum meshes x instances before depth/occlusion. memoryPeak = peak RSS (MB) of the Chromium renderer and GPU processes and the JS heap. poses = city at ?r=1 (3x3 chunks); posesFull = whole city (5x5 chunks); posesSmall = ?r=1&people=0&notex=1.';
doc.poses ??= {};
doc.posesFull ??= {};
doc.posesSmall ??= {};
doc.failures ??= {};
const save = () => { if (out) writeFileSync(out, JSON.stringify(doc, null, 1) + '\n'); };

// ---- hard cap
let browser = null, page = null, cdp = null;
let stage = 'start';
const at = (s) => { stage = s; log(s); };
const results = {};
setTimeout(() => {
  log(`TIMEOUT after ${MAX}s at "${stage}": killing browser (fewer --poses per run, or --small)`);
  for (const p of poses) if (!(p.name in results)) doc.failures[`${section}.${p.name}`] = { date: new Date().toISOString(), reason: `run hit --max ${MAX}s`, stage };
  save();
  try { browser?.process?.()?.kill('SIGKILL'); } catch {}
  process.exit(124);
}, MAX * 1000).unref();

// ---- memory: peak RSS of Chromium's renderer and GPU processes, and the page's JS heap
let poseMem = { rendererMB: 0, gpuMB: 0, jsHeapMB: 0 };
const rssMB = (pid) => { try { return Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024); } catch { return 0; } };
async function sampleMem() {
  try {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    let r = 0, g = 0;
    for (const p of processInfo) {
      if (p.type === 'renderer') r = Math.max(r, rssMB(p.id));
      else if (/gpu/i.test(p.type)) g = Math.max(g, rssMB(p.id));
    }
    const h = Math.round((await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0).catch(() => 0)) / 2 ** 20);
    poseMem = { rendererMB: Math.max(poseMem.rendererMB, r), gpuMB: Math.max(poseMem.gpuMB, g), jsHeapMB: Math.max(poseMem.jsHeapMB, h) };
  } catch { /* browser gone */ }
}
setInterval(sampleMem, 2000).unref();

const curl = (u) =>
  new Promise((res) => execFile('curl', ['-sSL', '--max-time', '60', '-D', '-', u], { encoding: 'buffer', maxBuffer: 256 << 20 }, (_e, o) => res(o)));

// which page to load: the city is needed for outdoor poses and to discover shop/apartment portals
const needCity = poses.some((p) => p.pos) || poses.some((p) => (p.enter === 'shop' || p.enter === 'apartment') && !doc.targets?.[p.enter]);
const qs = new URLSearchParams({ mode: needCity ? 'world' : 'museum', quality, seed, tod });
if (!FULL) qs.set('r', '1'); // 3x3 chunks (nyc/common.ts ?r=): never the full city in dev/QA
if (SMALL) { qs.set('people', '0'); qs.set('notex', '1'); }

at(`launch (${needCity ? (FULL ? 'FULL city' : 'city r=1') : 'museum'} page, quality=${quality}${SMALL ? ', people=0 notex=1' : ''})`);
browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'] });
page = await browser.newPage({ viewport: { width: W, height: H } });
cdp = await browser.newBrowserCDPSession();
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
page.on('pageerror', (e) => { if (!/pointer lock/i.test(e.message)) log('PAGEERROR', e.message.slice(0, 200)); });
page.on('crash', () => log('PAGE CRASHED (usually RAM): shrink the run (--small, fewer poses)'));

at(`load /?${qs}`);
await page.goto(`http://localhost:${port}/?${qs}`, { waitUntil: 'load', timeout: MAX * 1000 });
await page.waitForFunction(() => window.__world?.perf && window.__world.level && window.__world.perf.last.frame > 0, null, { timeout: MAX * 1000, polling: 1000 });
at(`level up: ${await page.evaluate(() => window.__world.level.name)}`);

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

/** wait until chunk/geometry/texture/program counts are unchanged for `stableFor` frames */
const settle = (minFrames = 5, stableFor = 4) =>
  page.evaluate(([minFrames, stableFor]) => new Promise((resolve) => {
    const p = window.__world.perf;
    const start = p.last.frame, t0 = performance.now();
    let key = '', since = 0, lastFrame = start;
    const poll = () => {
      const f = p.last;
      if (f.frame !== lastFrame) {
        lastFrame = f.frame;
        const lv = window.__world.level;
        // geometry/texture counts in 5% steps: traffic and seamless prebuilding keep nudging them
        const q = (n) => Math.round(Math.log(1 + n) / Math.log(1.05));
        const k = [lv?.chunks?.size ?? 0, q(f.geometries), q(f.textures), f.programs, lv?.name].join('|');
        if (k === key) since++;
        else { key = k; since = 0; }
        // at least 10 s: models and museum objects stream in asynchronously after the level is built
        if (f.frame - start >= minFrames && since >= stableFor && performance.now() - t0 > 10000) return resolve({ frames: f.frame - start, key });
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
          return resolve({ ...got[Math.floor(got.length / 2)], callsRange: [got[0].calls, got[got.length - 1].calls] });
        }
      }
      setTimeout(poll, 250);
    };
    poll();
  }), [n, TOP]);

const levelName = () => page.evaluate(() => window.__world.level.name);
const limit = (p, what, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} took over ${ms / 1000}s`)), ms))]);

async function measure(pose) {
  const ts = Date.now();
  poseMem = { rendererMB: 0, gpuMB: 0, jsHeapMB: 0 };
  let label = null;
  if (pose.pos) {
    if ((await levelName()) !== 'Manhattan') throw new Error('not in the city (list outdoor poses first)');
    await page.evaluate((h) => { window.__hold = h; }, { pos: pose.pos, yaw: pose.yaw, pitch: pose.pitch });
  } else {
    if ((pose.enter === 'shop' || pose.enter === 'apartment') && !doc.targets?.[pose.enter]) {
      at('find shop/apartment portals in the city');
      doc.targets = { ...doc.targets, ...(await page.evaluate(() => {
        const ps = window.__world.level.portals();
        const pick = (p) => (p ? { label: p.label, target: p.target } : undefined);
        // apartments: a brownstone door (interior), else a building lobby (floor level) whose unit doors lead in
        return { shop: pick(ps.find((p) => p.target?.kind === 'interior' && p.target.shop)), apartment: pick(ps.find((p) => p.target?.kind === 'interior' && !p.target.shop) ?? ps.find((p) => p.target?.kind === 'floor')) };
      })) };
      save();
    }
    await page.evaluate(() => { window.__hold = null; });
    if (pose.enter === 'shop' || pose.enter === 'apartment') {
      const t = doc.targets?.[pose.enter];
      if (!t) throw new Error('no portal found');
      label = t.label;
      at(`enter ${t.label}`);
      await page.evaluate((t) => window.__world.enter({ target: t.target, label: t.label }), t);
      if (t.target.kind === 'floor') {
        // a lobby: go on through the first unit door
        const u = await page.evaluate(() => {
          const p = window.__world.level.portals().find((p) => p.target?.kind === 'interior');
          return p ? { label: p.label, target: p.target } : null;
        });
        if (!u) throw new Error('no unit door in the lobby');
        label += ` > ${u.label}`;
        at(`enter ${u.label}`);
        await page.evaluate((u) => window.__world.enter({ target: u.target, label: u.label }), u);
      }
    } else {
      if ((await levelName()) !== 'Atrium') { at('enter museum atrium'); await page.evaluate(() => window.__world.startMode('museum')); }
      label = 'atrium';
      if (pose.enter === 'gallery') {
        const g = await page.evaluate(() => {
          const p = window.__world.level.portals().find((p) => p.target?.kind === 'gallery');
          return p ? { label: p.label, target: p.target } : null;
        });
        if (!g) throw new Error('no gallery portal in the atrium');
        label = g.label;
        at(`enter gallery ${g.label}`);
        await page.evaluate((g) => window.__world.enter({ target: g.target, label: g.label }), g);
      }
    }
    await page.evaluate(() => {
      const s = window.__world.level.spawn;
      window.__hold = { pos: [s.pos.x, s.pos.y, s.pos.z], yaw: s.yaw, pitch: 0 };
    });
  }
  at(`${pose.name}: settle`);
  // settle for at most 60% of the pose budget, then measure anyway (recorded as settled: false)
  const st = await limit(settle(), 'settle', POSE_MAX * 0.6).catch(() => ({ frames: null, unsettled: true }));
  if (st.unsettled) log(`${pose.name}: counts still changing, measuring anyway`);
  at(`${pose.name}: sample`);
  const s = await sample();
  await sampleMem();
  const r = {
    desc: pose.desc, level: await levelName(), ...(label ? { portal: label } : {}), ...(pose.pos ? { pos: pose.pos, yaw: +pose.yaw.toFixed(3), pitch: pose.pitch } : {}),
    commit, date: new Date().toISOString(), quality, viewport: [W, H], seed: Number(seed), tod,
    calls: s.calls, callsRange: s.callsRange, tris: s.tris, programs: s.programs, geometries: s.geometries, textures: s.textures,
    perPass: s.perPass, scene: s.scene, top: s.top, settleFrames: st.frames, settled: !st.unsettled, memoryPeak: { ...poseMem },
  };
  log(`${pose.name}: calls ${s.calls}  tris ${(s.tris / 1e6).toFixed(2)}M  programs ${s.programs}  inFrustum ${s.scene.meshesInFrustum}/${s.scene.meshesVisible}  mem r${poseMem.rendererMB}/g${poseMem.gpuMB}/h${poseMem.jsHeapMB} MB  (${((Date.now() - ts) / 1000).toFixed(0)} s)`);
  for (const [k, v] of Object.entries(s.perPass)) log(`    ${k.padEnd(22)} ${String(v.calls).padStart(5)} ${(v.tris / 1e6).toFixed(2).padStart(6)}M x${v.n}`);
  return r;
}

for (const pose of poses) {
  try {
    results[pose.name] = await limit(measure(pose), pose.name, POSE_MAX);
    doc[section][pose.name] = results[pose.name];
    delete doc.failures[`${section}.${pose.name}`];
  } catch (e) {
    log(`${pose.name} FAILED at "${stage}": ${e.message.split('\n')[0]}`);
    doc.failures[`${section}.${pose.name}`] = { date: new Date().toISOString(), reason: e.message.split('\n')[0], stage, memoryPeak: poseMem };
    results[pose.name] = null;
    save();
    break; // no retries: a failure usually means RAM; shrink the run instead
  }
  save();
}
try { browser.process()?.kill('SIGKILL'); } catch {}

if (args.compare) {
  const base = JSON.parse(readFileSync(args.compare, 'utf8'))[section] ?? {};
  console.log(`\ncompare vs ${args.compare} (${section})`);
  const pct = (a, b) => (b ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%` : 'n/a');
  for (const [k, v] of Object.entries(results)) {
    const b = base[k];
    if (!v || !b) { console.log(`  ${k}: ${v ? 'no baseline' : 'failed'}`); continue; }
    console.log(`  ${k.padEnd(20)} calls ${b.calls} -> ${v.calls} (${pct(v.calls, b.calls)})  tris ${b.tris} -> ${v.tris} (${pct(v.tris, b.tris)})  programs ${b.programs} -> ${v.programs}`);
    for (const p of new Set([...Object.keys(b.perPass ?? {}), ...Object.keys(v.perPass)])) {
      const x = b.perPass?.[p] ?? { calls: 0, tris: 0 }, y = v.perPass[p] ?? { calls: 0, tris: 0 };
      if (x.calls !== y.calls || x.tris !== y.tris) console.log(`      ${p.padEnd(22)} calls ${x.calls} -> ${y.calls}  tris ${x.tris} -> ${y.tris}`);
    }
  }
}
if (out) log('wrote', out);
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
