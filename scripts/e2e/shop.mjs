#!/usr/bin/env node
/**
 * Journey 2, a shop through a seamless door: from the spawn walk to the nearest glass storefront,
 * face it until seamless.ts has prebuilt and shown the shop behind the glass, walk through the
 * threshold (no E: the walk itself must enter) -> open a cupboard/drawer/cooler with E (its
 * contents must appear) -> walk back out through the door -> walk in again: 0 rebuilds.
 *
 *   npm run e2e -- shop [--port 5173] [--shots]
 */
import { journey } from './lib.mjs';

await journey('shop', import.meta.url, async (h) => {
  // fast=1 turns seamless off: turn it back on, it is what this journey tests
  await h.boot('/?mode=world&fast=1&seamless=1');

  h.step('find the nearest glass storefront');
  const door = await h.run((e) => {
    const me = e.W.player.pos;
    const ps = e.W.level.portals().filter((p) => p.door?.see && typeof p.target === 'object' && p.target.kind === 'interior');
    ps.sort((a, b) => a.door.pos.distanceTo(me) - b.door.pos.distanceTo(me));
    const p = ps[0];
    window.__shopPortal = p;
    return p && { label: p.label, pos: [p.door.pos.x, p.door.pos.z].map(e.r2), yaw: e.r2(p.door.yaw), shop: p.target.shop, d: e.r2(p.door.pos.distanceTo(me)) };
  });
  h.check('a glass shop door is within 30 m of the spawn', door && door.d < 30, door);

  h.step('approach and let the shop prebuild behind the glass');
  const pre = await h.run(async (e) => {
    const p = window.__shopPortal, f = (y) => [-Math.sin(y), -Math.cos(y)];
    const [fx, fz] = f(p.door.yaw);
    // 3 m out on the pavement in front of the door, then face it
    const r = await e.walk(p.door.pos.x - fx * 3, p.door.pos.z - fz * 3, { ms: 15000 });
    e.face(p.door.pos.x, 1.5, p.door.pos.z);
    const key = JSON.stringify(p.target);
    const slot = () => [...e.W.seam.slots.values()].find((s) => s.desc && JSON.stringify(s.desc) === key);
    const t0 = performance.now();
    const shown = await e.until(() => slot()?.shown, 60000);
    return { walk: r, shown: !!shown, ms: Math.round(performance.now() - t0), ready: !!slot()?.ready, seam: e.info().seam };
  });
  h.check('walked to the shop front', !pre.walk.stuck && pre.walk.dist < 0.6, pre.walk);
  h.check('the shop was prebuilt and shown behind the door', pre.shown, pre);
  await h.shot('storefront');

  h.step('walk through the threshold');
  const inn = await h.run(async (e) => {
    const p = window.__shopPortal, fx = -Math.sin(p.door.yaw), fz = -Math.cos(p.door.yaw);
    const before = e.info();
    let corridorBlocked = 0;
    for (let i = 0; i < 10; i++) if (e.blocked(p.door.pos.x + fx * (-1 + i * 0.25), p.door.pos.z + fz * (-1 + i * 0.25))) corridorBlocked++;
    const r = await e.walk(p.door.pos.x + fx * 3, p.door.pos.z + fz * 3, { ms: 15000, stop: () => e.W.desc.kind === 'interior' });
    await e.until(() => !e.W.transitioning, 15000);
    await e.frames(10);
    return { corridorBlocked, walk: r, before: before.seam, after: e.info() };
  });
  h.check('the door corridor is open (0 of 10 points blocked)', inn.corridorBlocked === 0, inn.corridorBlocked);
  h.check('walking through the door entered the shop', inn.after.desc.kind === 'interior' && inn.after.stack.length === 1, inn.after);
  h.check('it was seamless (no fade, no rebuild)', inn.after.seam.seamless === inn.before.seamless + 1 && inn.after.seam.fades === inn.before.fades && inn.after.seam.builds === inn.before.builds, { before: inn.before, after: inn.after.seam });

  h.step('open a container (E)');
  const box = await h.run(async (e) => {
    const lv = e.W.level, V = e.W.player.pos.constructor;
    const cases = (lv.cases ?? []).filter((c) => c.lazy && !c.lazy.contents);
    // prefer an opaque one (drawer/cupboard: contents only made on open), else a cooler
    cases.sort((a, b) => (b.lazy.opaque ? 1 : 0) - (a.lazy.opaque ? 1 : 0));
    const tried = [];
    for (const c of cases.slice(0, 6)) {
      const L = c.lazy;
      const b = L.worldBox(), mid = b.getCenter(new V());
      // its front is the anchor's +z
      const fw = new V(0, 0, 1).transformDirection(c.obj.matrixWorld);
      fw.y = 0;
      fw.normalize();
      const depth = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2;
      const stand = mid.clone().addScaledVector(fw, Math.min(depth, 0.5) + 0.9);
      const w = await e.walk(stand.x, stand.z, { ms: 6000, tol: 0.25 });
      e.face(mid.x, Math.min(mid.y, 1.4), mid.z);
      await e.frames(4);
      const aimed = e.W.aimedBox === L;
      tried.push({ label: L.label, opaque: L.opaque, at: w.pos, stuck: w.stuck, aimed, prompt: document.getElementById('prompt-label').textContent });
      if (!aimed) continue;
      const gen0 = e.W.lazy.stats.generated;
      e.key('KeyE');
      await e.until(() => L.contents && L.t >= 1, 8000);
      let n = 0;
      L.contents?.traverse((o) => { if (o.isMesh) n++; });
      return { tried, label: L.label, open: L.open, t: L.t, meshes: n, visible: !!L.contents?.visible, generated: e.W.lazy.stats.generated - gen0 };
    }
    return { tried, open: false };
  });
  h.check('aimed at a container and got its E prompt', box.open !== undefined && box.tried.some((t) => t.aimed), box.tried);
  h.check('E opened it and its contents appeared', box.open && box.t >= 1 && box.meshes > 0 && box.visible, box);
  await h.shot('container');

  h.step('walk back out');
  const out = await h.run(async (e) => {
    const lv = e.W.level;
    const entry = lv.doorway ?? null;
    const back = lv.portals().find((p) => p.target === 'back');
    const ep = entry?.pos ?? back.box.getCenter(e.W.player.pos.clone());
    const ey = entry?.yaw ?? back.returnYaw;
    const fx = -Math.sin(ey), fz = -Math.cos(ey);
    // to just inside the door, then out through it
    await e.walk(ep.x + fx * 1.2, ep.z + fz * 1.2, { ms: 10000 });
    const r = await e.walk(ep.x - fx * 2.5, ep.z - fz * 2.5, { ms: 10000, stop: () => e.W.desc.kind === 'nyc' });
    await e.until(() => !e.W.transitioning, 15000);
    await e.frames(10);
    const p = window.__shopPortal;
    return { walk: r, info: e.info(), fromDoor: e.r2(e.W.player.pos.distanceTo(p.door.pos)), blockedHere: e.blocked(e.W.player.pos.x, e.W.player.pos.z, -0.05) };
  });
  h.check('walking out through the door returned to the street', out.info.desc.kind === 'nyc' && out.info.stack.length === 0, out.info);
  h.check('back on the pavement just outside the door', out.fromDoor < 3 && !out.blockedHere, out);

  h.step('walk in again: no rebuild');
  const again = await h.run(async (e) => {
    const p = window.__shopPortal, fx = -Math.sin(p.door.yaw), fz = -Math.cos(p.door.yaw);
    const s0 = { ...e.W.seam.stats };
    await e.walk(p.door.pos.x - fx * 2.5, p.door.pos.z - fz * 2.5, { ms: 8000 });
    e.face(p.door.pos.x, 1.5, p.door.pos.z);
    const key = JSON.stringify(p.target);
    await e.until(() => [...e.W.seam.slots.values()].find((s) => JSON.stringify(s.desc) === key)?.shown, 10000);
    await e.walk(p.door.pos.x + fx * 3, p.door.pos.z + fz * 3, { ms: 10000, stop: () => e.W.desc.kind === 'interior' });
    await e.until(() => !e.W.transitioning, 15000);
    const s1 = e.W.seam.stats;
    return { info: e.info(), builds: s1.builds - s0.builds, fades: s1.fades - s0.fades, seamless: s1.seamless - s0.seamless };
  });
  h.check('walked back into the shop', again.info.desc.kind === 'interior' && again.info.stack.length === 1, again.info);
  h.check('re-entering rebuilt nothing (seam.stats.builds +0) and did not fade', again.builds === 0 && again.fades === 0 && again.seamless === 1, again);
});
