#!/usr/bin/env node
/**
 * Journey 5, the museum: the atrium -> face a north doorway until the wing's first room is shown
 * through it (preview) -> walk through (seamless) -> inspect an exhibit (E opens the info panel,
 * E closes it) -> walk through the next doorway -> Q, Q back to the atrium.
 *
 *   npm run e2e -- museum [--port 5173] [--shots]
 */
import { journey } from './lib.mjs';

await journey('museum', import.meta.url, async (h) => {
  // fast=1 turns seamless off: museum doorways preview the next room through it, so turn it on
  await h.boot('/?mode=museum&fast=1&seamless=1');
  const s0 = await h.info();
  h.check('starts in the atrium with an empty stack', s0.desc.kind === 'atrium' && s0.stack.length === 0, s0);

  /** walk through the doorway portal `window.__mDoor`: preview first, then across */
  const through = (label) =>
    h.run(async (e, label) => {
      const p = window.__mDoor, W = e.W;
      const d0 = W.desc, st0 = { ...W.seam.stats };
      const fx = -Math.sin(p.door.yaw), fz = -Math.cos(p.door.yaw);
      const c = p.box.getCenter(W.player.pos.clone());
      // just before the passage (walking around the exhibits), looking at it, until the next room is shown through it
      const a = await e.walkPath(c.x - fx * 2.6, c.z - fz * 2.6, { ms: 30000, stop: () => W.desc !== d0 });
      e.face(c.x, 1.6, c.z);
      const key = JSON.stringify(p.target);
      const slot = () => [...W.seam.slots.values()].find((s) => JSON.stringify(s.desc) === key);
      const t0 = performance.now();
      const shown = !!(await e.until(() => slot()?.shown, 60000));
      const previewMs = Math.round(performance.now() - t0);
      // and through: the far side of the passage and on
      const b = await e.walkPath(c.x + fx * 4, c.z + fz * 4, { ms: 20000, stop: () => W.desc !== d0 });
      await e.until(() => !W.transitioning, 20000);
      await e.frames(10);
      const st = W.seam.stats;
      return { label, approach: a, shown, previewMs, walk: b, info: e.info(), seamless: st.seamless - st0.seamless, fades: st.fades - st0.fades, builds: st.builds - st0.builds };
    }, label);

  h.step('through a north doorway of the atrium');
  const n = await h.run((e) => {
    const ps = e.W.level.portals().filter((p) => p.auto && p.door?.see && typeof p.target === 'object');
    // north: walking through it faces -z (yaw ~ 0 mod 2 pi)
    const north = ps.filter((p) => Math.cos(p.door.yaw) > 0.9).sort((a, b) => Math.abs(a.door.pos.x) - Math.abs(b.door.pos.x));
    window.__mDoor = north[0];
    return { doorways: ps.length, north: north.map((p) => p.label) };
  });
  h.check('the atrium has north doorways', n.north.length > 0, n);
  const g1 = await through(n.north[0]);
  h.check('the room behind the doorway was previewed through it', g1.shown, { previewMs: g1.previewMs, approach: g1.approach });
  h.check('walking through entered the gallery seamlessly (no fade)', g1.info.desc.kind === 'gallery' && g1.info.stack.length === 1 && g1.seamless === 1 && g1.fades === 0, g1);
  await h.shot('gallery1', true);

  h.step('inspect an exhibit');
  const ins = await h.run(async (e) => {
    const W = e.W, me = W.player.pos;
    const ps = W.level.portals().filter((p) => p.target === 'inspect' && p.inspect);
    const c = (p) => p.box.getCenter(me.clone());
    ps.sort((a, b) => c(a).distanceTo(me) - c(b).distanceTo(me));
    const tried = [];
    for (const p of ps.slice(0, 4)) {
      const m = c(p);
      const dir = me.clone().sub(m).setY(0).normalize();
      const size = p.box.getSize(me.clone());
      const stand = m.clone().addScaledVector(dir, Math.max(size.x, size.z) / 2 + 1.2);
      const r = await e.useSeen(p, { x: stand.x, z: stand.z }, { ms: 15000 });
      await e.frames(3);
      const panel = document.getElementById('info');
      tried.push({ label: p.label, aimed: r.aimed, prompt: r.prompt, stuck: r.walk?.stuck });
      if (!r.aimed) continue;
      const open = W.infoOpen && panel.classList.contains('show');
      const title = panel.querySelector('h2')?.textContent;
      e.key('KeyE');
      await e.frames(3);
      return { tried, open, title, closed: !W.infoOpen && !panel.classList.contains('show'), exhibits: ps.length };
    }
    return { tried, exhibits: ps.length };
  });
  h.check('the gallery has exhibits to inspect', ins.exhibits > 0, ins.exhibits);
  h.check('E on an exhibit opens its info panel with a title', ins.open && !!ins.title, ins);
  h.check('E closes the info panel again', ins.closed, ins);

  h.step('through the next doorway');
  const n2 = await h.run((e) => {
    const me = e.W.player.pos;
    const ps = e.W.level.portals().filter((p) => p.auto && p.door?.see && typeof p.target === 'object');
    ps.sort((a, b) => a.door.pos.distanceTo(me) - b.door.pos.distanceTo(me));
    window.__mDoor = ps[0];
    return { doorways: ps.length, label: ps[0]?.label };
  });
  h.check('the gallery has onward doorways', n2.doorways > 0, n2);
  const g2 = await through(n2.label);
  h.check('the next room was previewed through its doorway', g2.shown, { previewMs: g2.previewMs, approach: g2.approach });
  h.check('walked into the next room seamlessly, stack [atrium, gallery]', g2.info.desc.kind === 'gallery' && g2.info.stack.length === 2 && g2.seamless === 1 && g2.fades === 0, g2);
  await h.shot('gallery2');

  h.step('Q back to the atrium');
  const q = await h.run(async (e) => {
    const out = [];
    for (let i = 0; i < 2; i++) {
      await e.back();
      out.push({ ...e.info(), blocked: e.blocked(e.W.player.pos.x, e.W.player.pos.z, -0.05) });
    }
    return out;
  });
  h.check('Q: back in the first gallery, not inside a wall', q[0].desc.kind === 'gallery' && q[0].stack.length === 1 && !q[0].blocked, q[0]);
  h.check('Q: back in the atrium, not inside a wall', q[1].desc.kind === 'atrium' && q[1].stack.length === 0 && !q[1].blocked, q[1]);
  await h.shot('atrium');
});
