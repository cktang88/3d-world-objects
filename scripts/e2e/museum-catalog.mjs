/** Functional catalogue check: npm run e2e -- museum-catalog (dev server required). */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? process.argv[portArg + 1] : '5173';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const timer = setTimeout(() => browser.close().finally(() => process.exit(124)), 120000);
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => { if (!/pointer lock/i.test(e.message)) errors.push(e.message); });
  // Test navigation against local catalogue data. Exhibit downloads are independent.
  await page.route(/huggingface\.co|hf\.co|polyhaven|3d-api\.si\.edu/, (route) => route.abort());
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const w = window.__world;
      if (!w) return;
      clearInterval(timer);
      const render = w.renderer.render;
      w.renderer.render = function (scene, ...args) { if (scene !== w.scene) return render.call(this, scene, ...args); };
    }, 10);
  });
  await page.goto(`http://localhost:${port}/?mode=museum&quality=low&notex=1&post=0&shadows=0&seamless=0&precompile=0`);
  await page.waitForFunction(() => window.__world?.started, null, { timeout: 60000 });
  const startPosition = await page.evaluate(() => window.__world.player.pos.toArray());
  await page.keyboard.down('z');
  await page.waitForFunction(() => window.__world.camera.fov < 35);
  const zoomPosition = await page.evaluate(() => window.__world.player.pos.toArray());
  if (startPosition.some((v, i) => Math.abs(v - zoomPosition[i]) > 0.01)) throw new Error('Inspection zoom moved the player');
  await page.keyboard.down('w');
  await page.waitForFunction(() => window.__world.camera.fov > 65);
  await page.keyboard.up('w');
  await page.keyboard.up('z');
  await page.waitForFunction(() => window.__world.camera.fov > 69);
  const dialog = page.locator('#museum-catalog');
  // While mouse look holds pointer lock, use the advertised keyboard shortcut first.
  await page.keyboard.press('b');
  await dialog.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.pointerLockElement);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.locator('#museum-browse').click();
  if (await dialog.locator('.catalog-grid button').count() !== 33) throw new Error('Not all 33 collections are accessible');
  if (!(await dialog.locator('.catalog-total').innerText()).includes('79,985')) throw new Error('Incorrect catalogue total');
  if (process.argv.includes('--shots')) await dialog.screenshot({ path: '/tmp/museum-catalog.png' });
  await dialog.getByRole('button', { name: /^CAD Parts/ }).click();
  if (await dialog.locator('.catalog-grid button').count() !== 48) throw new Error('Collection themes are missing');
  await dialog.getByRole('button', { name: 'Show more themes' }).click();
  if (await dialog.locator('.catalog-grid button').count() !== 96) throw new Error('More themes are inaccessible');
  await dialog.getByRole('button', { name: 'All collections' }).click();
  const search = dialog.getByRole('searchbox');
  await search.fill('no-match-zzzzzz');
  if (await dialog.locator('.catalog-grid button').count() !== 0) throw new Error('Search did not filter');
  await search.fill('Power Tool');
  const first = dialog.locator('.catalog-grid button').first();
  const name = await first.locator('b').innerText();
  await first.click();
  await page.waitForFunction(() => window.__world.desc.kind === 'gallery' && !!window.__world.level.plan && !window.__world.transitioning, null, { timeout: 30000 });
  const result = await page.evaluate(() => {
    const w = window.__world;
    const targets = w.level.portals().filter((p) => typeof p.target === 'object' && p.target.kind === 'gallery');
    return { name: w.level.theme.name, collection: w.level.theme.collection, targets: targets.map((p) => p.target), stack: w.stack.length };
  });
  if (result.name !== name || result.collection !== 'Power Tool' || result.stack !== 1) throw new Error(`Selected theme did not open: ${JSON.stringify(result)}`);
  if (new Set(result.targets.map((t) => `${t.theme}:${t.page}`)).size !== result.targets.length) throw new Error('Duplicate onward rooms');
  await page.keyboard.press('b');
  await dialog.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.keyboard.press('q');
  await page.waitForFunction(() => window.__world.desc.kind === 'atrium' && !window.__world.transitioning, null, { timeout: 30000 });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS museum-catalog: 33 collections, catalogue count, search, direct theme entry, keyboard controls and return to atrium');
} finally {
  clearTimeout(timer);
  await browser.close();
}
