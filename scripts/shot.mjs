#!/usr/bin/env node
/**
 * Screenshot a page of the running dev server, for fast visual iteration.
 *
 *   node scripts/shot.mjs --url "/?lab=vehicles" --out /path/shot.png [--port 5173]
 *        [--w 960] [--h 540] [--wait 2000] [--eval "js run in the page before the shot"]
 *        [--quality low|high|ultra]   (default high: ultra is very slow in software rendering)
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
if (!/quality=/.test(url)) url += (url.includes('?') ? '&' : '?') + `quality=${args.quality ?? 'high'}`;
const out = args.out ?? 'shot.png';
const W = Number(args.w ?? 960), H = Number(args.h ?? 540);

const curl = (u) =>
  new Promise((res) => execFile('curl', ['-sSL', '--max-time', '90', '-D', '-', u], { encoding: 'buffer', maxBuffer: 256 << 20 }, (_e, o) => res(o)));

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.route(/huggingface\.co|hf\.co|polyhaven/, async (route) => {
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

await page.goto(`http://localhost:${port}${url}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__labReady !== undefined || window.__world !== undefined, null, { timeout: 60000 }).catch(() => {});
await page.evaluate(() => window.__labReady).catch(() => {});
if (args.eval) console.log('eval:', await page.evaluate(args.eval).catch((e) => 'ERR ' + e.message));
await page.waitForTimeout(Number(args.wait ?? 2000));
const info = await page.evaluate(() => { const r = window.__world?.renderer?.info?.render; return r ? `calls=${r.calls} tris=${r.triangles}` : ''; }).catch(() => '');
await page.screenshot({ path: out, timeout: 240000 });
console.log('saved', out, info);
await browser.close();
