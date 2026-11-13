#!/usr/bin/env node
/**
 * Network log of a pose: boots ?mode=world&r=0&people=0 (+ --q), teleports to --at x,z,yaw with drawing
 * off, and prints every request that finishes in the next --secs seconds, biggest first, plus the
 * renderer's JS heap. For memory spikes that only happen at one spot (the LaGuardia edge).
 *
 *   flock -w 300 /tmp/claude-0/world-shot.lock node scripts/e2e/netlog.mjs --port 5173 --at -291,-119,1.5708 [--secs 30] [--q notex=1]
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']] : acc), []));
const port = args.port ?? '5173', secs = Number(args.secs ?? 30);
const [x, z, yaw] = String(args.at ?? '-291,-119,1.5708').split(',').map(Number);
const t0 = Date.now();
const log = (...a) => console.log(`[netlog +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const kill = setTimeout(() => { log('TIMEOUT'); process.exit(124); }, Math.min(300, secs + 150) * 1000);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
let phase = 'boot';
const reqs = [];
page.on('requestfinished', async (rq) => {
  if (phase !== 'pose') return;
  const s = await rq.sizes().catch(() => null);
  reqs.push({ url: rq.url().replace(`http://localhost:${port}`, ''), kb: Math.round((s?.responseBodySize ?? 0) / 1024), t: ((Date.now() - tp) / 1000).toFixed(1) });
});
page.on('requestfailed', (rq) => phase === 'pose' && reqs.push({ url: 'FAILED ' + rq.url(), kb: 0, t: ((Date.now() - tp) / 1000).toFixed(1) }));
page.on('crash', () => { log('PAGE CRASHED'); report(); process.exit(2); });
page.on('console', (m) => m.type() === 'error' && log('CONSOLE', m.text().slice(0, 200)));
let tp = 0;
const report = () => {
  const by = [...reqs].sort((a, b) => b.kb - a.kb);
  log(`${reqs.length} requests, ${reqs.reduce((s, r) => s + r.kb, 0)} KB after the teleport; biggest:`);
  for (const r of by.slice(0, 25)) console.log(`${String(r.kb).padStart(8)} KB  t=${r.t}s  ${r.url.slice(0, 160)}`);
};
await page.goto(`http://localhost:${port}/?mode=world&r=0&people=0${args.q ? '&' + args.q : ''}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__boot?.firstFrame, null, { timeout: 200000 });
log('booted');
phase = 'pose';
tp = Date.now();
await page.evaluate(([x, z, yaw]) => {
  const W = window.__world;
  W.renderer.render = function () {};
  W.player.place(W.player.pos.clone().set(x, 0, z), yaw);
}, [x, z, yaw]);
for (let s = 0; s < secs; s += 5) {
  await page.waitForTimeout(5000);
  const m = await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6)).catch(() => -1);
  log(`t=${s + 5}s heap ${m} MB, ${reqs.length} requests, ${reqs.reduce((a, r) => a + r.kb, 0)} KB`);
}
report();
clearTimeout(kill);
await browser.close();
