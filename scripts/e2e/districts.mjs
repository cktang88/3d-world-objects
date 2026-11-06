#!/usr/bin/env node
/**
 * Journey 6, the districts (src/nyc/districts.ts MAP): teleport to Central Park, Auto Row, the
 * Hudson River piers and LaGuardia at ?r=0 and check that the block streams in, the arrival toast
 * names the district, the spot is walkable and not inside a collider, the showcase objects that
 * load there are real-sized, and nothing errors.
 *
 *   npm run e2e -- districts [--port 5173] [--shots] [--only park,airport]
 */
import { journey } from './lib.mjs';

// chunk (cx, cz) -> world (cx * 120, cz * 64); lx/lz: a walkable spot in the chunk
const STOPS = [
  { key: 'park', cx: 0, cz: -6, lx: 20, lz: 0, name: /Central Park/, big: [1, 40] },
  { key: 'autorow', cx: 4, cz: -5, lx: 49.8, lz: 0, name: /Auto Row/, big: [3.4, 30], car: true },
  { key: 'pier', cx: 6, cz: -3, lx: -30, lz: 0, name: /Hudson River Park/, big: [1, 330] },
  { key: 'airport', cx: -3, cz: -2, lx: 49.8, lz: 0, name: /LaGuardia/, big: [6, 80], plane: true },
];

await journey('districts', import.meta.url, async (h) => {
  const only = h.args.only ? h.args.only.split(',') : null;
  await h.boot('/?mode=world&fast=1');
  for (const s of STOPS) {
    if (only && !only.includes(s.key)) continue;
    h.step(`teleport: ${s.key}`);
    const r = await h.run(async (e, s) => {
      const W = e.W, V = W.player.pos.constructor;
      const D = await import('/src/nyc/districts.ts');
      const x = s.cx * 120 + s.lx, z = s.cz * 64 + s.lz;
      const toast = document.getElementById('toast');
      toast.classList.remove('show');
      toast.textContent = '';
      W.player.place(new V(x, 0, z), 0);
      const t0 = performance.now();
      const chunks = W.level.chunks;
      const loaded = await e.until(() => chunks.has(`${s.cx},${s.cz}`) && !W.level.pending, 40000);
      const loadMs = Math.round(performance.now() - t0);
      const arrived = await e.until(() => toast.classList.contains('show') && toast.textContent, 6000);
      // let the showcase objects of the block stream in (remote models: up to 25 s)
      const show = () => W.level.portals().filter((p) => p.target === 'inspect' && p.inspect && !p.box.isEmpty());
      // (auto row: until a car-sized one is up, up to 40 s: showroom cars queue behind the previous block's loads)
      const carUp = () => show().some((p) => { const z = p.box.getSize(new V()); const l = Math.max(z.x, z.z) - 0.2; return l > 3.4 && l < 6.5; });
      const t1 = performance.now();
      await e.until(() => (s.car ? carUp() : show().length >= 3), s.car ? 40000 : 25000);
      const showMs = Math.round(performance.now() - t1);
      const objs = show().map((p) => {
        const sz = p.box.getSize(new V());
        const c = p.box.getCenter(new V());
        return { t: p.label.slice(0, 40), pool: p.pool, len: e.r2(Math.max(sz.x, sz.z) - 0.2), h: e.r2(sz.y - 0.2), d: e.r2(Math.hypot(c.x - x, c.z - z)) };
      }).sort((a, b) => a.d - b.d).slice(0, 12);
      const district = D.districtAtPos(x, z);
      return {
        at: [x, z], kind: district.kind, loaded: !!loaded, loadMs, toast: toast.textContent,
        walkable: D.walkable(x, z), blocked: e.blocked(W.player.pos.x, W.player.pos.z, -0.05),
        meshes: (() => { let n = 0; chunks.get(`${s.cx},${s.cz}`)?.group.traverse((o) => { if (o.isMesh) n++; }); return n; })(),
        objs, showMs, calls: W.renderer.info.render.calls,
      };
    }, s);
    h.check(`${s.key}: the block streamed in`, r.loaded && r.meshes > 0, { kind: r.kind, loadMs: r.loadMs, meshes: r.meshes });
    h.check(`${s.key}: arrival toast names the district`, s.name.test(r.toast), r.toast);
    h.check(`${s.key}: the arrival spot is walkable and not inside a collider`, r.walkable && !r.blocked, { at: r.at, walkable: r.walkable, blocked: r.blocked });
    const bad = r.objs.filter((o) => o.len < 0.05 || o.h < 0.02 || o.len > 120 || o.h > 60);
    h.check(`${s.key}: showcase objects have plausible real sizes`, bad.length === 0, { bad, objs: r.objs });
    if (s.car) h.check(`${s.key}: a car-sized object (3.4-6.5 m) is on show`, r.objs.some((o) => o.len >= 3.4 && o.len <= 6.5 && o.h < 2.4), { showMs: r.showMs, objs: r.objs });
    // every slot has a minimum size (src/nyc/district-*.ts): airport slots >= 2.5 m, boats >= 4 m.
    // A model squashed into a 2 m cube by flatten() (quantized rebuilds) fails here.
    if (s.plane) h.check(`${s.key}: nothing on the apron is under 2.5 m`, r.objs.every((o) => Math.max(o.len, o.h) >= 2.5), r.objs);
    // boats by the pool they were drawn from (pier props are anchors and bollards); every boat >= 4 m
    if (s.key === 'pier') h.check(`${s.key}: boats are at least 4 m long`, r.objs.some((o) => o.pool === 'boat') && r.objs.filter((o) => o.pool === 'boat').every((o) => o.len >= 4), r.objs);
    if (s.plane) h.check(`${s.key}: an aircraft-sized object (>= 6 m) is on show`, r.objs.some((o) => o.len >= 6), r.objs);
    await h.shot(s.key, s.key === 'airport');
  }
});
