/** Regression: the physical sky must look identical after travelling far from the origin. */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? process.argv[portArg + 1] : '5173';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const timer = setTimeout(() => browser.close().finally(() => process.exit(124)), 60000);
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
  await page.goto(`http://localhost:${port}/?lab=light-sun&notex=1&shadows=0&post=0&quality=low`);
  await page.waitForFunction(() => window.__labReady !== undefined);
  await page.evaluate(() => window.__labReady);
  const results = await page.evaluate(() => {
    const w = window.__world, sky = w.lighting.sky, renderer = w.renderer, parent = sky.parent;
    const scene = new w.scene.constructor();
    const camera = new w.camera.constructor(70, 1, 0.1, 900);
    const target = new w.gtao.gtaoRenderTarget.constructor(64, 64);
    const previousTarget = renderer.getRenderTarget();
    camera.rotation.x = 0.25;
    scene.add(sky);
    sky.visible = true;
    const samples = [];
    try {
      for (const position of [[0, 0, 0], [530, 0, 90], [-70, 0, -1190], [100000, 0, -100000]]) {
        camera.position.set(...position);
        camera.updateMatrixWorld(true);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        const pixels = new Uint8Array(64 * 64 * 4);
        renderer.readRenderTargetPixels(target, 0, 0, 64, 64, pixels);
        samples.push(pixels);
      }
      return samples.map((pixels) => {
        let maximumDifference = 0, black = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 5) black++;
          for (let channel = 0; channel < 3; channel++) maximumDifference = Math.max(maximumDifference, Math.abs(pixels[i + channel] - samples[0][i + channel]));
        }
        return { maximumDifference, black };
      });
    } finally {
      renderer.setRenderTarget(previousTarget);
      parent.add(sky);
      target.dispose();
    }
  });
  if (results.some((r) => r.maximumDifference > 3 || r.black > 0)) throw new Error(`sky changes with world position: ${JSON.stringify(results)}`);
  console.log('PASS sky-travel: identical sky with no black pixels at spawn, distant districts, and 100 km away');
} finally {
  clearTimeout(timer);
  await browser.close();
}
