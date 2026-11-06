#!/usr/bin/env node
/**
 * Museum performance and doorway previews: in the atrium and three galleries, record
 * window.__world.perf() (draw calls, triangles, programs, per pass, shadow casters, lights) while
 * looking at an onward doorway, and how long each doorway took to show the next room through it
 * once you stand 4 m away facing it. Counts only (SwiftShader frame times mean nothing).
 *
 *   npm run e2e -- museumperf [--port 5173] [--shots]
 */
import { journey } from './lib.mjs';

await journey('museumperf', import.meta.url, async (h) => {
  await h.boot('/?mode=museum&seamless=1&quality=low');
  const rows = [];

  /** perf where you stand, looking at the nearest onward doorway (preview up if it comes within 45 s) */
  const measure = (where) =>
    h.run(async (e, where) => {
      const W = e.W, me = W.player.pos;
      const ps = W.level.portals().filter((p) => p.auto && p.door?.see && typeof p.target === 'object');
      ps.sort((a, b) => a.door.pos.distanceTo(me) - b.door.pos.distanceTo(me));
      const p = ps.find((q) => Math.cos(q.door.yaw) > 0.5) ?? ps[0];
      window.__mDoor = p;
      if (!p) return { where, doorways: 0 };
      const fx = -Math.sin(p.door.yaw), fz = -Math.cos(p.door.yaw);
      const c = p.box.getCenter(me.clone());
      // 4 m before the passage, facing it
      await e.walkPath(c.x - fx * 4, c.z - fz * 4, { ms: 30000 });
      e.face(c.x, 1.6, c.z);
      const key = JSON.stringify(p.target);
      const slot = () => [...W.seam.slots.values()].find((s) => JSON.stringify(s.desc) === key);
      const t0 = performance.now();
      const shown = !!(await e.until(() => slot()?.shown, 45000));
      const s = slot();
      // the harness skips drawing (SwiftShader); draw a few frames so perf() counts a real one
      e.draw(true);
      await e.frames(3);
      const perf = W.perf({ top: 6 });
      e.draw(false);
      const direct = { calls: perf.calls, tris: perf.tris };
      return {
        where, doorways: ps.length, label: p.label, shown, previewMs: Math.round(performance.now() - t0),
        slot: s ? { ready: s.ready, waiting: s.waiting, compiled: s.compiled, ms: Math.round(s.ms), tris: s.tris } : null,
        calls: direct.calls, tris: direct.tris, programs: perf.programs, perPass: perf.perPass, scene: perf.scene, top: perf.top?.map((t) => `${t.label} ${t.tris}x${t.instances}`),
      };
    }, where);

  const walkThrough = () =>
    h.run(async (e) => {
      const W = e.W, p = window.__mDoor, d0 = W.desc;
      const fx = -Math.sin(p.door.yaw), fz = -Math.cos(p.door.yaw);
      const c = p.box.getCenter(W.player.pos.clone());
      await e.walkPath(c.x + fx * 4, c.z + fz * 4, { ms: 25000, stop: () => W.desc !== d0 });
      await e.until(() => !W.transitioning, 20000);
      await e.frames(20);
      return e.info();
    });

  for (const where of ['atrium', 'gallery 1', 'gallery 2', 'gallery 3']) {
    h.step(where);
    const r = await measure(where);
    rows.push(r);
    h.check(`${where}: perf measured`, r.calls >= 0, { calls: r.calls, tris: r.tris, programs: r.programs, shown: r.shown, previewMs: r.previewMs, slot: r.slot, scene: r.scene, perPass: r.perPass, top: r.top });
    if (where !== 'gallery 3') {
      const info = await walkThrough();
      h.check(`${where}: walked on into a gallery`, info.desc.kind === 'gallery', info.desc);
    }
  }
  console.log('MUSEUMPERF', JSON.stringify(rows.map((r) => ({ where: r.where, calls: r.calls, tris: r.tris, programs: r.programs, shadowCalls: r.perPass?.['main/shadow']?.calls, shadowTris: r.perPass?.['main/shadow']?.tris, casters: r.scene?.shadowCastersVisible, lights: r.scene?.lights, meshes: r.scene?.meshesInFrustum, shown: r.shown, previewMs: r.previewMs }))));
});
