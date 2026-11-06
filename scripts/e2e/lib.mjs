/**
 * Shared harness for the headless end-to-end journeys in scripts/e2e/<journey>.mjs.
 *
 *   npm run e2e -- <journey> [--port 5173] [--shots] [--max 240] [--out <dir>]
 *   node scripts/e2e/<journey>.mjs [same flags]
 *
 * - Full-game runs take the world lock (/tmp/claude-0/world-shot.lock, flock -w 300): a journey
 *   re-executes itself under flock unless E2E_LOCKED=1 is set.
 * - Every journey is capped at --max seconds (default 240, never above 240): the browser is
 *   killed and the run exits 124.
 * - Hugging Face / Poly Haven requests are fetched with curl (as scripts/shot.mjs does); with
 *   notex/fast no texture is downloaded at all.
 * - pageerror and console.error are collected per step; any error or failed check exits 1.
 * - --shots saves a tiny 480x270 screenshot at the steps that call shot().
 *
 * In the page, `window.__e2e` (installed by boot()) has the driving helpers: frames(n),
 * walk(x, z, opts) (holds W with the real Player input, yaw pointed at the target),
 * face(x, y, z), key(code), info().
 */
import { createRequire } from 'module';
import { execFile, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const LOCK = '/tmp/claude-0/world-shot.lock';

export function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(argv.reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']] : acc), []));
}

/** re-run this script under the world lock (one full-game browser at a time across agents) */
export function underLock(scriptUrl) {
  if (process.env.E2E_LOCKED === '1') return;
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  const r = spawnSync('flock', ['-w', '300', LOCK, process.execPath, fileURLToPath(scriptUrl), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, E2E_LOCKED: '1' },
  });
  process.exit(r.status ?? 1);
}

const curl = (u) =>
  new Promise((res) => execFile('curl', ['-sSL', '--max-time', '60', '-D', '-', u], { encoding: 'buffer', maxBuffer: 256 << 20 }, (_e, o) => res(o)));

/** in-page helpers (stringified into the page) */
function pageHelpers() {
  const W = window.__world;
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = async (n) => { for (let i = 0; i < n; i++) await raf(); };
  /** wait until f() is truthy (checked every frame), up to ms; returns the last value */
  const until = async (f, ms = 20000) => {
    const t0 = performance.now();
    let v;
    while (!(v = f()) && performance.now() - t0 < ms) await raf();
    return v;
  };
  const r2 = (v) => Math.round(v * 100) / 100;
  const pos = () => [r2(W.player.pos.x), r2(W.player.pos.y), r2(W.player.pos.z)];
  /** yaw that looks from the player toward (x, z): Player forward is (-sin yaw, -cos yaw) */
  const yawTo = (x, z) => Math.atan2(-(x - W.player.pos.x), -(z - W.player.pos.z));
  /**
   * Walk toward (x, z) holding W (the real input path: Player.update with the level's colliders).
   * Stops within `tol` m, when stuck (moved < 0.15 m in 1 s), when stop() is true, or after ms.
   */
  const walk = async (x, z, o = {}) => {
    const tol = o.tol ?? 0.35, ms = o.ms ?? 20000;
    const t0 = performance.now();
    let last = W.player.pos.clone(), lastT = t0, stuck = false, path = [];
    W.player.keys.add('KeyW');
    if (o.run) W.player.keys.add('ShiftLeft');
    try {
      while (performance.now() - t0 < ms) {
        if (o.stop?.()) break;
        const d = Math.hypot(x - W.player.pos.x, z - W.player.pos.z);
        if (d < tol) break;
        if (!W.transitioning) W.player.yaw = yawTo(x, z);
        if (o.pitch !== undefined) W.player.pitch = o.pitch;
        await raf();
        const now = performance.now();
        if (now - lastT > 1000) {
          path.push(pos());
          if (W.player.pos.distanceTo(last) < 0.15 && !W.transitioning) { stuck = true; break; }
          last.copy(W.player.pos);
          lastT = now;
        }
      }
    } finally {
      W.player.keys.delete('KeyW');
      W.player.keys.delete('ShiftLeft');
    }
    await frames(3);
    return { pos: pos(), stuck, dist: r2(Math.hypot(x - W.player.pos.x, z - W.player.pos.z)), ms: Math.round(performance.now() - t0), path };
  };
  /** walk(), and when stuck (an exhibit, a fixture) side-step 1.5 m left or right and go on; up to 4 detours */
  const walkAround = async (x, z, o = {}) => {
    let r = await walk(x, z, o);
    const detours = [];
    for (let i = 0; i < 4 && r.stuck && !o.stop?.(); i++) {
      const p = W.player.pos, dx = x - p.x, dz = z - p.z, L = Math.hypot(dx, dz) || 1;
      const s = i % 2 ? -1 : 1, k = 1.5 * (1 + (i >> 1));
      await walk(p.x + (-dz / L) * k * s, p.z + (dx / L) * k * s, { ms: 4000, stop: o.stop });
      detours.push(pos());
      r = await walk(x, z, o);
    }
    return { ...r, detours };
  };
  /**
   * A path from the player to (x, z) around the active colliders (inflated by the player's radius):
   * breadth-first search on a 0.2 m grid within `pad` m of both ends, then string-pulled to the
   * fewest straight legs. null when there is none.
   */
  const plan = (x, z, o = {}) => {
    const R = (o.radius ?? 0.36), G = 0.2, pad = o.pad ?? 12;
    const p = W.player.pos;
    const x0 = Math.min(p.x, x) - pad, z0 = Math.min(p.z, z) - pad;
    const nx = Math.ceil((Math.max(p.x, x) + pad - x0) / G), nz = Math.ceil((Math.max(p.z, z) + pad - z0) / G);
    const cols = W.seam.colliders(W.level.colliders(p), p);
    const free = (px, pz) => !cols.some((c) => px > c.minX - R && px < c.maxX + R && pz > c.minZ - R && pz < c.maxZ + R);
    const grid = new Uint8Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) grid[j * nx + i] = free(x0 + i * G, z0 + j * G) ? 1 : 0;
    const cell = (px, pz) => [Math.round((px - x0) / G), Math.round((pz - z0) / G)];
    const [si, sj] = cell(p.x, p.z), [gi, gj] = cell(x, z);
    const prev = new Int32Array(nx * nz).fill(-1);
    const q = [sj * nx + si];
    prev[q[0]] = q[0];
    const goal = gj * nx + gi;
    grid[q[0]] = 1;
    grid[goal] = 1; // the target itself may be a portal's trigger inside a passage
    for (let h = 0; h < q.length && prev[goal] < 0; h++) {
      const k = q[h], i = k % nx, j = (k - i) / nx;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const n = b * nx + a;
        if (prev[n] >= 0 || !grid[n]) continue;
        if (di && dj && (!grid[j * nx + a] || !grid[b * nx + i])) continue;
        prev[n] = k;
        q.push(n);
      }
    }
    if (prev[goal] < 0) return null;
    const pts = [];
    for (let k = goal; ; k = prev[k]) {
      const i = k % nx;
      pts.push([x0 + i * G, z0 + ((k - i) / nx) * G]);
      if (k === prev[k]) break;
    }
    pts.reverse();
    pts[pts.length - 1] = [x, z];
    const clear = (a, b) => {
      const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1);
      for (let t = 1; t < n; t++) if (!free(a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n)) return false;
      return true;
    };
    const legs = [];
    let a = 0;
    while (a < pts.length - 1) {
      let b = pts.length - 1;
      while (b > a + 1 && !clear(pts[a], pts[b])) b--;
      legs.push(pts[b]);
      a = b;
    }
    return legs;
  };
  /** walk to (x, z) along plan()'s path (straight if there is none) */
  const walkPath = async (x, z, o = {}) => {
    const legs = plan(x, z, o) ?? [[x, z]];
    let r = null;
    for (let i = 0; i < legs.length; i++) {
      r = await walk(legs[i][0], legs[i][1], { ...o, tol: i < legs.length - 1 ? 0.25 : o.tol });
      if (r.stuck || o.stop?.()) break;
    }
    return { ...r, legs: legs.map((l) => l.map(r2)) };
  };
  /** point the camera at a world point (yaw + pitch) */
  const face = (x, y, z) => {
    W.player.yaw = yawTo(x, z);
    const eye = W.player.pos.y + 1.65;
    W.player.pitch = Math.atan2(y - eye, Math.hypot(x - W.player.pos.x, z - W.player.pos.z));
  };
  const key = (code, shift = false) => {
    dispatchEvent(new KeyboardEvent('keydown', { code, shiftKey: shift, bubbles: true }));
    dispatchEvent(new KeyboardEvent('keyup', { code, shiftKey: shift, bubbles: true }));
  };
  /**
   * Stand at `stand` (walk there), look at the portal's box centre, check the aim prompt picked
   * this portal and press E. Waits for any transition to end. Returns what happened.
   */
  const useSeen = async (p, stand, o = {}) => {
    const V = W.player.pos.constructor;
    const w = stand ? await walk(stand.x, stand.z, { ms: o.ms ?? 25000, tol: 0.25 }) : null;
    const c = p.box.getCenter(new V());
    face(c.x, Math.min(c.y, 1.5), c.z);
    if (o.dwell) await frames(o.dwell);
    await frames(3);
    const aimed = W.aimed === p;
    const prompt = document.getElementById('prompt-label').textContent;
    const before = W.desc;
    if (aimed || o.force) key('KeyE');
    await frames(2);
    await until(() => !W.transitioning, 20000);
    await frames(3);
    return { walk: w, aimed, prompt, moved: W.desc !== before };
  };
  /**
   * Open one of `list` ({ obj, label?/kind? } with obj's +z its front): walk in front of it, look
   * at it, check the E prompt is for it (lazy.ts aimedBox) and press E. Returns the attempt log.
   */
  const openOne = async (list, o = {}) => {
    const V = W.player.pos.constructor;
    const tried = [];
    for (const c of list) {
      c.obj.updateWorldMatrix(true, false);
      const mid = new V().setFromMatrixPosition(c.obj.matrixWorld);
      const h = c.size?.y ?? 1;
      const fw = new V(0, 0, 1).transformDirection(c.obj.matrixWorld);
      fw.y = 0;
      fw.normalize();
      const stand = mid.clone().addScaledVector(fw, 1.0);
      const w = await walk(stand.x, stand.z, { ms: 6000, tol: 0.25 });
      // rooms are not straight lines away: when the walk is blocked, step there (logged)
      if (o.teleport && w.dist > 0.4) {
        W.player.place(new V(stand.x, W.player.pos.y, stand.z), W.player.yaw);
        await frames(3);
        w.teleported = true;
        w.pos = pos();
      }
      // aim at the middle of its front
      face(mid.x, mid.y + Math.min(h / 2, 1.3), mid.z);
      await frames(4);
      const L = W.aimedBox;
      const aimed = !!L && L.obj === c.obj;
      tried.push({ label: c.label ?? c.kind, at: w.pos, stuck: w.stuck, aimed, prompt: document.getElementById('prompt-label').textContent });
      if (!aimed) continue;
      const gen0 = W.lazy.stats.generated;
      key('KeyE');
      await until(() => L.contents && L.t >= 1, 8000);
      let n = 0;
      L.contents?.traverse((o) => { if (o.isMesh || o.isInstancedMesh) n++; });
      return { tried, label: L.label, open: L.open, t: L.t, meshes: n, visible: !!L.contents?.visible, generated: W.lazy.stats.generated - gen0 };
    }
    return { tried, open: false };
  };
  /** press Q and wait for the transition */
  const back = async () => {
    const before = W.desc;
    key('KeyQ');
    await frames(2);
    await until(() => !W.transitioning, 20000);
    await frames(3);
    return W.desc !== before;
  };
  const descKey = (d) => (d ? JSON.stringify(d) : '');
  const info = () => ({
    desc: W.desc && { kind: W.desc.kind, name: W.desc.name, floor: W.desc.floor, theme: W.desc.theme },
    level: W.level?.name,
    stack: W.stack.map((f) => `${f.desc.kind}:${f.desc.name ?? f.desc.theme ?? ''}${f.desc.floor !== undefined ? '#' + f.desc.floor : ''}`),
    pos: pos(),
    yaw: r2(W.player.yaw),
    seam: { builds: W.seam.stats.builds, hits: W.seam.stats.hits, seamless: W.seam.stats.seamless, fades: W.seam.stats.fades, prebuilds: W.seam.stats.prebuilds },
    calls: W.renderer.info.render.calls,
    toast: document.getElementById('toast')?.classList.contains('show') ? document.getElementById('toast').textContent : '',
  });
  /** is (x, z) inside any of the active level's colliders (as the player would be resolved)? */
  const blocked = (x, z, pad = 0) =>
    W.seam.colliders(W.level.colliders(W.player.pos), W.player.pos).some((c) => x > c.minX - pad && x < c.maxX + pad && z > c.minZ - pad && z < c.maxZ + pad);
  /**
   * SwiftShader draws the city at ~1 fps here, so journeys run the game loop without drawing
   * (renderer.render is a no-op): main.ts' frame() still runs player, level, seamless, vertical,
   * lazy and lighting updates every frame, at up to 60 Hz. shot() turns drawing back on.
   */
  const r0 = W.renderer.__render0 ?? (W.renderer.__render0 = W.renderer.render);
  const draw = (on) => { W.renderer.render = on ? r0 : function () {}; };
  draw(false);
  window.__e2e = { W, draw, useSeen, back, openOne, walkAround, plan, walkPath, raf, sleep, frames, until, walk, face, key, info, pos, yawTo, blocked, descKey, r2 };
}

export async function harness(name, scriptUrl) {
  const args = parseArgs();
  underLock(scriptUrl);
  const port = args.port ?? process.env.PORT ?? '5173';
  const MAX = Math.min(240, Number(args.max ?? 240));
  const outDir = args.out ?? path.join(process.env.E2E_OUT ?? '/tmp/claude-0/e2e', name);
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const log = (...a) => console.log(`[e2e ${name} +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
  const { chromium } = require('playwright');
  let browser;
  const results = [];
  let errors = [];
  let step = 'boot';
  const finish = (code) => {
    const failed = results.filter((r) => !r.ok);
    const errCount = results.reduce((s, r) => s + r.errors.length, 0) + errors.length;
    log(`DONE ${results.length - failed.length}/${results.length} checks passed, ${errCount} page errors`);
    for (const f of failed) log(`  FAIL [${f.step}] ${f.what}${f.detail ? ' — ' + f.detail : ''}`);
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ name, results, trailingErrors: errors, seconds: (Date.now() - t0) / 1000 }, null, 1));
    process.exit(code ?? (failed.length || errCount ? 1 : 0));
  };
  setTimeout(() => {
    log(`TIMEOUT after ${MAX}s in step "${step}": killing browser`);
    results.push({ step, ok: false, what: 'journey finished within the time cap', detail: `${MAX}s`, errors: [] });
    try { browser?.process?.()?.kill('SIGKILL'); } catch {}
    finish(124);
  }, MAX * 1000).unref();

  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  await page.route(/huggingface\.co|hf\.co|polyhaven|3d-api\.si\.edu/, async (route) => {
    const u = route.request().url();
    if (/polyhaven|\.(hdr|exr|jpe?g|png|webp|ktx2)(\?|$)/i.test(u) && /notex=1|fast=1/.test(page.url())) return route.abort();
    const buf = await curl(u);
    if (!buf) return route.abort();
    const s = buf.toString('latin1');
    let idx = 0, last = 0;
    while ((idx = s.indexOf('\r\n\r\n', last)) >= 0 && /^HTTP\//.test(s.slice(last, last + 5))) last = idx + 4;
    const type = u.includes('rows?') || u.endsWith('.json') ? 'application/json' : /\.jpe?g/.test(u) ? 'image/jpeg' : /\.png/.test(u) ? 'image/png' : 'application/octet-stream';
    route.fulfill({ status: 200, body: buf.subarray(last), headers: { 'access-control-allow-origin': '*', 'content-type': type } });
  });
  page.on('pageerror', (e) => {
    if (/Pointer Lock|pointer lock/i.test(e.message)) return;
    errors.push(`pageerror: ${e.message.slice(0, 300)}`);
    log('PAGEERROR', e.message.slice(0, 300));
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Pointer Lock|pointer lock|Failed to load resource.*(net::ERR_FAILED|ERR_ABORTED)/i.test(t)) return;
    errors.push(`console.error: ${t.slice(0, 300)}`);
    log('CONSOLE', t.slice(0, 300));
  });

  const api = {
    args, page, log, outDir,
    /** load the game and wait for the level and the in-page helpers */
    async boot(url) {
      step = 'boot';
      log('loading', url);
      await page.goto(`http://localhost:${port}${url}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__world?.level && window.__world.started, null, { timeout: 120000 });
      await page.evaluate(`(${pageHelpers.toString()})()`);
      await page.evaluate(() => window.__e2e.frames(5));
      log('booted', JSON.stringify(await api.info()));
    },
    info: () => page.evaluate(() => window.__e2e.info()),
    /** run js in the page with the helpers in scope as `e` (e.W is window.__world) */
    run: (fn, arg) => page.evaluate(`(async (e, arg) => (${fn.toString()})(e, arg))(window.__e2e, ${JSON.stringify(arg ?? null)})`),
    step(s) {
      step = s;
      log('step:', s);
    },
    /** record a check; page errors since the last check are attached to it */
    check(what, ok, detail = '') {
      const r = { step, what, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail), errors };
      errors = [];
      results.push(r);
      log(`${ok ? 'ok  ' : 'FAIL'} ${what}${r.detail ? ' — ' + r.detail.slice(0, 400) : ''}`);
      return !!ok;
    },
    async shot(label) {
      if (!args.shots) return;
      const f = path.join(outDir, `${String(results.length).padStart(2, '0')}-${label}.png`);
      await page.evaluate(() => { window.__e2e.draw(true); return window.__e2e.frames(2); });
      await page.screenshot({ path: f, timeout: 60000 }).catch((e) => log('shot failed', e.message));
      await page.evaluate(() => window.__e2e.draw(false));
      log('shot', f);
    },
    async done() {
      await browser.close().catch(() => {});
      finish();
    },
    async fail(e) {
      api.check('journey ran without an exception', false, e?.stack?.split('\n').slice(0, 3).join(' | ') ?? String(e));
      await browser.close().catch(() => {});
      finish(1);
    },
  };
  return api;
}

/** run a journey function with the harness, catching exceptions */
export async function journey(name, scriptUrl, fn) {
  const h = await harness(name, scriptUrl);
  try {
    await fn(h);
    await h.done();
  } catch (e) {
    await h.fail(e);
  }
}
