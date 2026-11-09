/** GPU regression: npm run e2e -- indoor-render (requires the dev server on port 5173). */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? process.argv[portArg + 1] : '5173';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const timeout = setTimeout(() => { console.error('indoor-render: exceeded 120 seconds'); browser.close().finally(() => process.exit(124)); }, 120000);
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    const text = m.text();
    if ((m.type() === 'error' || /WebGL: INVALID|GL_INVALID/.test(text)) && !/Failed to load resource/.test(text)) errors.push(text);
  });
  // Isolate local rendering from optional streamed exhibits and PBR services.
  await page.route(/huggingface\.co|hf\.co|polyhaven|3d-api\.si\.edu/, (route) => route.abort());
  for (const lab of ['light-room', 'interior-room']) {
    await page.goto(`http://localhost:${port}/?lab=${lab}&quality=ultra&notex=1&shadows=0`);
    await page.waitForFunction(() => window.__labReady !== undefined);
    await page.evaluate(() => window.__labReady);
    await page.evaluate(() => {
      const pass = window.__world.gtao, render = pass.render;
      window.__depthChecks = [];
      pass.render = function (renderer, write, read, ...rest) {
        window.__depthChecks.push(this.depthTexture === read.depthTexture && read.depthTexture !== write.depthTexture);
        return render.call(this, renderer, write, read, ...rest);
      };
    });
    for (let angle = 0; angle < 6; angle++) {
      await page.evaluate(() => { window.__world.camera.rotation.y += Math.PI / 3; window.__world.camera.updateMatrixWorld(true); });
      if (angle === 3) await page.setViewportSize({ width: 512, height: 288 });
      await page.waitForFunction(() => window.__depthChecks.length >= 2, null, { timeout: 20000 });
      const result = await page.evaluate(() => {
        const { gtao, renderer } = window.__world;
        let nonfinite = 0;
        for (const target of [gtao.gtaoRenderTarget, gtao.pdRenderTarget]) {
          const pixels = new Uint16Array(target.width * target.height * 4);
          renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels);
          nonfinite += pixels.filter((x) => (x & 0x7c00) === 0x7c00).length;
        }
        return { nonfinite, depth: window.__depthChecks.splice(0), glError: renderer.getContext().getError() };
      });
      if (result.nonfinite || result.glError || !result.depth.length || result.depth.some((v) => !v)) throw new Error(`${lab} angle ${angle}: ${JSON.stringify(result)}`);
    }
    console.log(`PASS ${lab}: six view angles and resize; finite AO/denoise, independent current-frame depth, no GL errors`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  clearTimeout(timeout);
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
