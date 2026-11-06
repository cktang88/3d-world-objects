#!/usr/bin/env node
/**
 * Journey 3, a walk-up: from the spawn walk to the nearest walk-up's street door and press E ->
 * walk to the stair and climb it to floor 2 (src/vertical.ts switches floors on the stair) ->
 * go into an apartment (E on its door) -> open the closet/dresser (E) -> Q back out one step at a
 * time (apartment -> floor 2 hall -> lobby -> street), checking the level stack and where you
 * stand after each step.
 *
 *   npm run e2e -- building [--port 5173] [--shots]
 */
import { journey } from './lib.mjs';

await journey('building', import.meta.url, async (h) => {
  await h.boot('/?mode=world&fast=1&seamless=1');

  h.step('enter the nearest walk-up from the street');
  const ent = await h.run(async (e) => {
    const me = e.W.player.pos;
    const ps = e.W.level.portals().filter((p) => typeof p.target === 'object' && p.target.kind === 'floor' && p.target.type === 'walkup' && p.door);
    ps.sort((a, b) => a.door.pos.distanceTo(me) - b.door.pos.distanceTo(me));
    const p = ps[0];
    if (!p) return null;
    window.__bldPortal = p;
    const fx = -Math.sin(p.door.yaw), fz = -Math.cos(p.door.yaw);
    const stand = { x: p.door.pos.x - fx * 1.6, z: p.door.pos.z - fz * 1.6 };
    const r = await e.useSeen(p, stand);
    return { label: p.label, door: [p.door.pos.x, p.door.pos.z].map(e.r2), ...r, info: e.info() };
  });
  h.check('a walk-up door is on the spawn block', !!ent, ent);
  if (!ent) return;
  h.check('E on the street door shows its prompt', ent.aimed, ent);
  h.check('E took us into the lobby (floor 0), stack [street]', ent.info.desc.kind === 'floor' && ent.info.desc.floor === 0 && ent.info.stack.length === 1, ent.info);
  if (ent.info.desc.kind !== 'floor') return;
  await h.shot('lobby');

  h.step('climb the stair to floor 2');
  const climb = await h.run(async (e) => {
    const lv = e.W.level, d = lv.d;
    const spawn = e.pos();
    const xa = (d.ax0 - d.gap / 2) / 2, xb = (d.bx1 + d.gap / 2) / 2, zl = (-d.Lf + d.zBack) / 2;
    const legs = [];
    // to the foot of flight A, up it to the half landing, across, up flight B
    legs.push(await e.walk(xa, d.Ld * 0.6, { ms: 15000 }));
    legs.push(await e.walk(xa, zl, { ms: 10000 }));
    const y1 = e.W.player.pos.y;
    legs.push(await e.walk(xb, zl, { ms: 6000 }));
    legs.push(await e.walk(xb, d.Ld * 0.6, { ms: 10000, stop: () => e.W.desc.floor === 1 && e.W.player.pos.y > -0.05 && e.W.player.pos.z > 0 }));
    await e.frames(10);
    return { spawn, H: d.H, halfLandingY: e.r2(y1), legs: legs.map((l) => ({ pos: l.pos, stuck: l.stuck, dist: l.dist })), info: e.info(), vert: { stairs: e.W.vert.stats.stairs, forced: e.W.vert.stats.forced } };
  });
  h.check('the half landing is half a storey up', Math.abs(climb.halfLandingY - climb.H / 2) < 0.2, climb);
  h.check('climbing flight B switched to floor 2 (floor index 1) without forcing a build', climb.info.desc.kind === 'floor' && climb.info.desc.floor === 1 && climb.vert.forced === 0, climb.vert);
  h.check('stack after the stair: [street, lobby]', climb.info.stack.length === 2 && /floor:.*#0/.test(climb.info.stack[1]), climb.info.stack);
  h.check('standing on the floor-2 landing at y 0', Math.abs(climb.info.pos[1]) < 0.1, climb.info.pos);
  await h.shot('floor2');

  h.step('go into an apartment');
  const apt = await h.run(async (e) => {
    const me = e.W.player.pos;
    const ps = e.W.level.portals().filter((p) => /apartment/i.test(p.label) && p.returnPos);
    ps.sort((a, b) => a.returnPos.distanceTo(me) - b.returnPos.distanceTo(me));
    const p = ps[0];
    if (!p) return null;
    window.__aptPortal = p;
    // stand outside its door, look at it a moment (seamless prebuilds a door you stop at), press E
    const r = await e.useSeen(p, { x: p.returnPos.x, z: p.returnPos.z }, { dwell: 40 });
    return { label: p.label, ...r, info: e.info(), returnPos: [p.returnPos.x, p.returnPos.z].map(e.r2) };
  });
  h.check('an apartment door is on floor 2', !!apt, apt);
  if (!apt) return;
  h.check('E on the apartment door shows its prompt', apt.aimed, apt);
  h.check('E took us into the apartment, stack [street, lobby, floor 2]', apt.info.desc.kind === 'interior' && apt.info.stack.length === 3, apt.info);

  h.step('open the wardrobe');
  const ward = await h.run(async (e) => {
    const cs = (e.W.level.containers ?? []).filter((c) => c.obj);
    const order = ['closet', 'dresser', 'cabinet', 'nightstand', 'upper', 'fridge'];
    cs.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const kinds = [...new Set(cs.map((c) => c.kind))];
    const back = e.pos();
    const r = await e.openOne(cs.slice(0, 5), { teleport: true });
    // stand back where we came in, so Q is tested from the apartment's door area
    const V = e.W.player.pos.constructor;
    e.W.player.place(new V(back[0], back[1], back[2]), e.W.player.yaw);
    await e.frames(3);
    return { kinds, ...r };
  });
  h.check('the apartment has openable furniture', ward.kinds.length > 0, ward.kinds);
  h.check('E opened a wardrobe/dresser and its contents appeared', ward.open && ward.t >= 1 && ward.meshes > 0 && ward.visible, ward);
  await h.shot('wardrobe', true);

  h.step('Q back out, one step at a time');
  const steps = await h.run(async (e) => {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const moved = await e.back();
      const p = e.W.player.pos;
      out.push({ moved, ...e.info(), inCollider: e.blocked(p.x, p.z, -0.05), toast: document.getElementById('toast').textContent });
    }
    return out;
  });
  const [q1, q2, q3, q4] = steps;
  const ap = apt.returnPos;
  h.check('Q 1: apartment -> floor 2 hall, outside the apartment door', q1.desc.kind === 'floor' && q1.desc.floor === 1 && q1.stack.length === 2 && Math.hypot(q1.pos[0] - ap[0], q1.pos[2] - ap[1]) < 1.5 && !q1.inCollider, q1);
  h.check('Q 2: floor 2 -> lobby at its street door', q2.desc.kind === 'floor' && q2.desc.floor === 0 && q2.stack.length === 1 && Math.abs(q2.pos[1]) < 0.1 && !q2.inCollider, q2);
  h.check('Q 3: lobby -> street, outside the building door on the pavement', q3.desc.kind === 'nyc' && q3.stack.length === 0 && Math.hypot(q3.pos[0] - ent.door[0], q3.pos[2] - ent.door[1]) < 2.5 && !q3.inCollider, { q3, door: ent.door });
  h.check('Q 4 on the street: stays (outermost world)', !q4.moved && q4.desc.kind === 'nyc' && /outermost/.test(q4.toast), q4);
  await h.shot('street');
});
