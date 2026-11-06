#!/usr/bin/env node
/**
 * Screenshot a page of the running dev server, for fast visual iteration.
 *
 *   node scripts/shot.mjs --url "/?lab=vehicles" --out /path/shot.png [--port 5173]
 *        [--w 960] [--h 540] [--wait 2000] [--eval "js run in the page before the shot"]
 *        [--quality low|high|ultra]   (default low; ultra is very slow in software rendering)
 *        [--fast]      ?fast=1: just your block, no people, no textures, no post, no shadows, low
 *        [--notex]     ?notex=1: flat colours, no texture/HDRI/PBR downloads
 *        [--nopost]    ?post=0: no GTAO/bloom/grading
 *        [--noshadows] ?shadows=0
 *        Default viewport 480x270. Use --notex --nopost (or --fast) whenever you judge shape,
 *        layout or proportion rather than materials.
 *        [--max 240]   hard wall-clock cap in seconds (default 240, never above 600): the run
 *                      kills its browser and exits 124 so nothing hangs or loops for long
 *
 * Requests to Hugging Face / Poly Haven are fetched with curl (which trusts this machine's
 * proxy CA) and handed to the browser, so streamed models and textures work headlessly.
 * Waits for window.__labReady (lab scenes) before the extra --wait.
 */
import { createRequire } from 'module';
import { execFile } from 'child_process';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']] : acc), []),
);
const port = args.port ?? process.env.PORT ?? '5173';
let url = args.url ?? '/?lab=index';
const addq = (k, v) => { if (!new RegExp(`[?&]${k}=`).test(url)) url += (url.includes('?') ? '&' : '?') + `${k}=${v}`; };
if (args.fast) addq('fast', '1');
if (args.notex) addq('notex', '1');
if (args.nopost) addq('post', '0');
if (args.noshadows) addq('shadows', '0');
addq('quality', args.quality ?? 'low');
const out = args.out ?? 'shot.png';
const W = Number(args.w ?? 480), H = Number(args.h ?? 270);
const noTex = /[?&](notex=1|fast=1)/.test(url);

const curl = (u) =>
  new Promise((res) => execFile('curl', ['-sSL', '--max-time', '90', '-D', '-', u], { encoding: 'buffer', maxBuffer: 256 << 20 }, (_e, o) => res(o)));

const MAX = Math.min(600, Number(args.max ?? 240));
const t0 = Date.now();
const log = (...a) => console.log(`[shot +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let browser;
setTimeout(() => {
  log(`TIMEOUT after ${MAX}s: killing browser (make the scene smaller: a lab, ?notex=1, ?post=0, --quality low, smaller --w/--h)`);
  try { browser?.process?.()?.kill('SIGKILL'); } catch {}
  process.exit(124);
}, MAX * 1000).unref();
browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.route(/huggingface\.co|hf\.co|polyhaven|3d-api\.si\.edu/, async (route) => {
  // no textures: don't download Poly Haven texture sets / HDRIs at all
  if (noTex && /polyhaven|\.(hdr|exr|jpe?g|png|webp|ktx2)(\?|$)/i.test(route.request().url())) return route.abort();
  const buf = await curl(route.request().url());
  if (!buf) return route.abort();
  const s = buf.toString('latin1');
  let idx = 0, last = 0;
  while ((idx = s.indexOf('\r\n\r\n', last)) >= 0 && /^HTTP\//.test(s.slice(last, last + 5))) last = idx + 4;
  const u = route.request().url();
  const type = u.includes('rows?') || u.endsWith('.json') ? 'application/json' : /\.jpe?g/.test(u) ? 'image/jpeg' : /\.png/.test(u) ? 'image/png' : 'application/octet-stream';
  route.fulfill({ status: 200, body: buf.subarray(last), headers: { 'access-control-allow-origin': '*', 'content-type': type } });
});
page.on('pageerror', (e) => { if (!/Pointer Lock/.test(e.message)) console.log('PAGEERROR', e.message); });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });

log('loading', url);
await page.goto(`http://localhost:${port}${url}`, { waitUntil: 'load' });
// a lab page defines __world long before its scene starts (after the asset manifests load, slower
// under ?fast=1's up-front compile): wait for __labReady itself, or the shot shows the default camera
const isLab = /[?&]lab=/.test(url);
await page.waitForFunction((lab) => (lab ? window.__labReady !== undefined : window.__labReady !== undefined || window.__world !== undefined), isLab, { timeout: 60000 }).catch(() => log('no __labReady after 60 s'));
await page.evaluate(() => window.__labReady).catch(() => {});
// a lab with ?cam= must be looking from there (catches shots taken before the scene started)
const camArg = /[?&]cam=([-\d.]+)(?:,|%2C)([-\d.]+)(?:,|%2C)([-\d.]+)/.exec(url);
if (isLab && camArg) {
  const at = await page.evaluate(() => window.__world?.camera?.position.toArray()).catch(() => null);
  const want = camArg.slice(1, 4).map(Number);
  if (!at || at.some((v, i) => Math.abs(v - want[i]) > 0.5)) log(`WARNING: camera at ${JSON.stringify(at)}, not cam=${want} (the lab did not start?)`);
}
if (args.eval) console.log('eval:', await page.evaluate(args.eval).catch((e) => 'ERR ' + e.message));
await page.waitForTimeout(Number(args.wait ?? 2000));
const info = await page.evaluate(() => { const r = window.__world?.renderer?.info?.render; return r ? `calls=${r.calls} tris=${r.triangles}` : ''; }).catch(() => '');
log('ready, screenshotting');
await page.screenshot({ path: out, timeout: 240000 });
console.log('saved', out, info);
await browser.close();
