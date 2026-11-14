#!/usr/bin/env node
/**
 * Chrome's own crash reason for a pose: boots ?mode=world&r=0&people=0 (+ --q), teleports to --at x,z,yaw with
 * drawing ON, waits --secs, and keeps the browser's stderr (--enable-logging=stderr) so a renderer / GPU process
 * death shows its FATAL / Check failed / OOM line. --hide a,b,c hides scene children by name before the wait
 * (bisect whole systems: e.g. waterfront-far,hlod,sky-dome,weather).
 *
 *   flock -w 300 /tmp/claude-0/world-shot.lock node scripts/e2e/crashlog.mjs --port 5173 [--at -291,-119,1.5708] [--secs 60] [--hide ...] [--r 1] [--probe file.js]
 * --probe: a JS expression file evaluated at the end (its value is printed).
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']] : acc), []));
const port = args.port ?? '5173', secs = Number(args.secs ?? 60);
const [x, z, yaw] = String(args.at ?? '-291,-119,1.5708').split(',').map(Number);
const hide = String(args.hide ?? '').split(',').filter(Boolean);
const t0 = Date.now();
const log = (...a) => console.log(`[crashlog +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
setTimeout(() => { log('TIMEOUT'); process.exit(124); }, Math.min(300, secs + 150) * 1000).unref();
const lines = [];
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-logging=stderr', '--v=0'],
  logger: { isEnabled: () => true, log: (name, sev, msg) => { if (name === 'browser') lines.push(String(msg)); } },
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
let crashed = false;
page.on('crash', () => { crashed = true; log('PAGE CRASHED'); });
await page.goto(`http://localhost:${port}/?mode=world&r=${args.r ?? 0}&people=0${args.q ? '&' + args.q : ''}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__boot?.firstFrame, null, { timeout: 200000 });
log('booted');
await page.evaluate(([x, z, yaw, hide]) => {
  const W = window.__world;
  W.player.place(W.player.pos.clone().set(x, 0, z), yaw);
  window.__hide = hide;
  const tick = () => { for (const c of W.scene.children) if (hide.includes(c.name) || hide.includes(c.type)) c.visible = false; requestAnimationFrame(tick); };
  tick();
}, [x, z, yaw, hide]).catch((e) => log('eval', e.message));
for (let s = 0; s < secs && !crashed; s += 5) {
  await page.waitForTimeout(5000).catch(() => {});
  if (crashed) break;
  const st = await page.evaluate(() => { const i = window.__world.renderer.info; return `calls ${i.render.calls} tris ${i.render.triangles} geo ${i.memory.geometries} tex ${i.memory.textures} heap ${Math.round(performance.memory.usedJSHeapSize / 1e6)}`; }).catch(() => 'gone');
  log(`t=${s + 5}s ${st}`);
}
if (args.probe && !crashed) {
  const { readFileSync } = await import('fs');
  log('probe:', await page.evaluate(readFileSync(args.probe, 'utf8')).catch((e) => 'ERR ' + e.message));
}
const bad = lines.filter((l) => /FATAL|Check failed|OOM|out of memory|Out of memory|crash|GPU process|lost|abort|SwiftShader|ERROR:/i.test(l) && !/ERROR:.*(dbus|bus\.cc|object_proxy|policy)/.test(l));
log(`${crashed ? 'CRASHED' : 'alive'}; ${lines.length} stderr lines, ${bad.length} notable:`);
for (const l of bad.slice(-30)) console.log('  ' + l.slice(0, 300));
await browser.close().catch(() => {});
process.exit(0);
