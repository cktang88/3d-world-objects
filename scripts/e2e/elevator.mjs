#!/usr/bin/env node
/**
 * Journey 4, an elevator: from the spawn walk to the nearest office / pre-war building door, E into
 * its lobby -> E on a lift's call button (the car comes, the doors open) -> walk into the car ->
 * press 3 on the keypad (floor 3) -> ride (src/vertical.ts builds the floor while you ride) ->
 * the doors open on floor 3 -> walk out into the hall -> Q to the lobby -> Q to the street.
 *
 *   npm run e2e -- elevator [--port 5173] [--shots]
 */
import { journey } from './lib.mjs';

await journey('elevator', import.meta.url, async (h) => {
  await h.boot('/?mode=world&fast=1&seamless=1');

  h.step('enter an office / pre-war lobby from the street');
  const ent = await h.run(async (e) => {
    const me = e.W.player.pos;
    const ps = e.W.level.portals().filter((p) => typeof p.target === 'object' && p.target.kind === 'floor' && /office|prewar/.test(p.target.type) && p.door);
    ps.sort((a, b) => a.door.pos.distanceTo(me) - b.door.pos.distanceTo(me));
    const p = ps[0];
    if (!p) return null;
    const fx = -Math.sin(p.door.yaw), fz = -Math.cos(p.door.yaw);
    const stand = { x: p.door.pos.x - fx * 1.6, z: p.door.pos.z - fz * 1.6 };
    // along the pavement: first out to the building line's sidewalk, then along it
    await e.walk(me.x, stand.z, { ms: 15000 });
    const r = await e.useSeen(p, stand);
    return { label: p.label, type: p.target.type, door: [p.door.pos.x, p.door.pos.z].map(e.r2), ...r, info: e.info() };
  });
  h.check('an office or pre-war building is on the spawn block', !!ent, ent);
  if (!ent) return;
  h.check('E on its street door took us into the lobby', ent.aimed && ent.info.desc.kind === 'floor' && ent.info.desc.floor === 0 && ent.info.stack.length === 1, ent);
  if (ent.info.desc.kind !== 'floor') return;

  h.step('call the lift');
  const call = await h.run(async (e) => {
    const lv = e.W.level;
    const l = lv.lifts[0];
    if (!l) return null;
    const f = l.frame, c = Math.cos(f.r), s = Math.sin(f.r);
    const tw = (lx, lz) => ({ x: f.x + lx * c + lz * s, z: f.z - lx * s + lz * c });
    window.__liftTw = tw;
    // down the middle of the hall to level with the lift, then in front of its call button
    const stand = tw(0.5 + 0.28, 1.1);
    await e.walk(0, stand.z, { ms: 15000 });
    const r = await e.useSeen(l.call, stand);
    const t0 = performance.now();
    await e.until(() => e.W.vert.state === 'open', 20000);
    return { ...r, state: e.W.vert.state, waitedMs: Math.round(performance.now() - t0), open: e.r2(l.open), lifts: lv.lifts.length };
  });
  h.check('the lobby has a lift', !!call, call);
  if (!call) return;
  h.check('E on the call button: the car came and the doors opened', call.aimed && call.state === 'open' && call.open > 0.85, call);
  await h.shot('lift-open');

  h.step('ride to floor 3');
  const ride = await h.run(async (e) => {
    const tw = window.__liftTw;
    const a = tw(0, 0.6), car = tw(0, -0.9);
    await e.walk(a.x, a.z, { ms: 6000, tol: 0.2 });
    const w = await e.walk(car.x, car.z, { ms: 6000, tol: 0.2 });
    await e.frames(5);
    const panel = e.W.level.portals().find((p) => /floor/i.test(p.label) && p.target === 'inspect');
    e.key('Digit3');
    await e.frames(3);
    const sel = e.W.vert.sel;
    const t0 = performance.now();
    const states = new Set();
    await e.until(() => { states.add(e.W.vert.state); return e.W.desc.floor === 2 && e.W.vert.state === 'open'; }, 60000);
    return { walk: w, panel: panel?.label, sel, states: [...states], ms: Math.round(performance.now() - t0), info: e.info(), stats: { ...e.W.vert.stats, log: e.W.vert.stats.log.slice(-4) } };
  });
  h.check('stood in the car and the panel was offered', !ride.walk.stuck && !!ride.panel, ride.walk);
  h.check('key 3 selected floor 3 (index 2)', ride.sel === 2, ride.sel);
  h.check('the car closed, rode and opened on floor 3', ride.info.desc.kind === 'floor' && ride.info.desc.floor === 2 && ride.states.includes('riding'), ride);
  h.check('the ride did not force an unbuilt floor', ride.stats.forced === 0 && ride.stats.rides === 1, ride.stats);
  h.check('lift ride keeps the stack [street, lobby]', ride.info.stack.length === 2, ride.info.stack);
  h.check('still standing on the car floor (y 0)', Math.abs(ride.info.pos[1]) < 0.05, ride.info.pos);
  await h.shot('floor3', true);

  h.step('walk out of the car');
  const out = await h.run(async (e) => {
    const tw = window.__liftTw;
    const hall = tw(0, 1.6);
    const w = await e.walk(hall.x, hall.z, { ms: 8000, tol: 0.25 });
    return { walk: w, info: e.info() };
  });
  h.check('walked out of the car into the floor-3 hall', !out.walk.stuck && out.walk.dist < 0.4 && out.info.desc.floor === 2, out);

  h.step('Q to the lobby, Q to the street');
  const q = await h.run(async (e) => {
    const a = await e.back();
    const i1 = e.info();
    const b = await e.back();
    const i2 = e.info();
    return { a, i1, b, i2, blocked: e.blocked(e.W.player.pos.x, e.W.player.pos.z, -0.05) };
  });
  h.check('Q on floor 3 -> lobby', q.i1.desc.kind === 'floor' && q.i1.desc.floor === 0 && q.i1.stack.length === 1, q.i1);
  h.check('Q in the lobby -> street outside the door', q.i2.desc.kind === 'nyc' && q.i2.stack.length === 0 && !q.blocked && Math.hypot(q.i2.pos[0] - ent.door[0], q.i2.pos[2] - ent.door[1]) < 2.5, q.i2);
});
