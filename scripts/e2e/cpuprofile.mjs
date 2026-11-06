#!/usr/bin/env node
/**
 * Main-thread JS profile (CDP Profiler) of 10 s standing still: on the street spawn and in a museum
 * gallery. Prints the top functions by self time, the GL driver / browser natives left out (their
 * cost is SwiftShader's here), so per-frame JS that costs fps on any GPU stands out.
 *
 *   npm run e2e -- cpuprofile [--port 5173] [--only street|gallery] [--secs 10]
 */
import { journey } from './lib.mjs';

const top = (profile, n = 12) => {
  const self = new Map();
  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  const dt = profile.timeDeltas;
  let total = 0;
  profile.samples.forEach((id, i) => {
    const node = byId.get(id);
    const f = node.callFrame;
    const ms = (dt[i] ?? 0) / 1000;
    total += ms;
    // natives with no script (GL calls, layout) and idle are not JS we can change
    if (!f.url && !/garbage/.test(f.functionName)) return;
    const file = f.url.replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '').replace(/^.*node_modules\/\.vite\/deps\//, 'deps/');
    const k = `${f.functionName || '(anon)'} ${file}:${f.lineNumber + 1}`;
    self.set(k, (self.get(k) ?? 0) + ms);
  });
  const js = [...self.values()].reduce((a, b) => a + b, 0);
  return { totalMs: Math.round(total), jsMs: Math.round(js), top: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0).padStart(6)} ms  ${k}`) };
};

await journey('cpuprofile', import.meta.url, async (h) => {
  const secs = Number(h.args.secs ?? 10);
  const only = h.args.only;
  const cdp = await h.page.context().newCDPSession(h.page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  const profile = async (label) => {
    const f0 = await h.run((e) => e.W.perf?.()?.frame ?? 0);
    await cdp.send('Profiler.start');
    await h.page.waitForTimeout(secs * 1000);
    const { profile: p } = await cdp.send('Profiler.stop');
    const f1 = await h.run((e) => e.W.perf?.()?.frame ?? 0);
    const r = top(p);
    h.log(`PROFILE ${label}: ${f1 - f0} frames in ${secs} s, ${r.totalMs} ms sampled, ${r.jsMs} ms in scripts\n${r.top.join('\n')}`);
    h.check(`${label}: profiled`, r.totalMs > 0, { frames: f1 - f0, jsMs: r.jsMs });
  };
  if (!only || only === 'street') {
    await h.boot('/?mode=world&fast=1&r=1&people=110&seamless=1');
    await h.page.waitForTimeout(5000);
    await profile('street spawn');
  }
  if (!only || only === 'gallery') {
    await h.boot('/?mode=museum&fast=1&seamless=1');
    // into the first north gallery and stand in it, looking at its next doorway
    await h.run(async (e) => {
      const W = e.W;
      const ps = W.level.portals().filter((p) => p.auto && p.door?.see && typeof p.target === 'object');
      const p = ps.filter((q) => Math.cos(q.door.yaw) > 0.9).sort((a, b) => Math.abs(a.door.pos.x) - Math.abs(b.door.pos.x))[0];
      const fx = -Math.sin(p.door.yaw), fz = -Math.cos(p.door.yaw);
      const c = p.box.getCenter(W.player.pos.clone());
      const d0 = W.desc;
      await e.walkPath(c.x - fx * 2.6, c.z - fz * 2.6, { ms: 30000 });
      e.face(c.x, 1.6, c.z);
      await e.until(() => [...W.seam.slots.values()].some((s) => s.shown), 45000);
      await e.walkPath(c.x + fx * 4, c.z + fz * 4, { ms: 25000, stop: () => W.desc !== d0 });
      await e.until(() => !W.transitioning, 20000);
      const me = W.player.pos;
      const qs = W.level.portals().filter((q) => q.auto && q.door?.see && typeof q.target === 'object');
      qs.sort((a, b) => a.door.pos.distanceTo(me) - b.door.pos.distanceTo(me));
      if (qs[0]) e.face(qs[0].door.pos.x, 1.6, qs[0].door.pos.z);
      await e.frames(30);
    });
    await profile('museum gallery');
  }
});
