#!/usr/bin/env node
/**
 * Edge cases between the systems the other journeys cross one at a time:
 *  - inside a shop: T says the time changes outside; Q (not walking) puts you back on the pavement
 *  - Q while the lift is riding, then back into the same building: the lift still works
 *  - up the stair and back down to the lobby: the stack pops the lobby again, Q -> street
 *
 *   npm run e2e -- edges [--port 5173] [--shots]
 */
import { journey } from './lib.mjs';

await journey('edges', import.meta.url, async (h) => {
  await h.boot('/?mode=world&fast=1&seamless=1');

  h.step('shop: T inside, then Q');
  const shop = await h.run(async (e) => {
    const W = e.W, me = W.player.pos;
    const ps = W.level.portals().filter((p) => p.door?.see && typeof p.target === 'object' && p.target.kind === 'interior');
    ps.sort((a, b) => a.door.pos.distanceTo(me) - b.door.pos.distanceTo(me));
    const p = ps[0];
    const fx = -Math.sin(p.door.yaw), fz = -Math.cos(p.door.yaw);
    await e.walk(p.door.pos.x - fx * 3, p.door.pos.z - fz * 3);
    e.face(p.door.pos.x, 1.5, p.door.pos.z);
    await e.until(() => [...W.seam.slots.values()].find((s) => JSON.stringify(s.desc) === JSON.stringify(p.target))?.shown, 30000);
    await e.walk(p.door.pos.x + fx * 3, p.door.pos.z + fz * 3, { stop: () => W.desc.kind === 'interior' });
    await e.until(() => !W.transitioning);
    await e.frames(5);
    const inside = e.info();
    e.key('KeyT');
    await e.frames(3);
    const tToast = document.getElementById('toast').textContent;
    e.key('KeyT', true); // and back
    // a few steps further in, then Q
    await e.walk(W.player.pos.x + Math.sin(W.player.yaw) * -2, W.player.pos.z + Math.cos(W.player.yaw) * -2, { ms: 3000 });
    await e.back();
    const out = e.info();
    const d = Math.hypot(out.pos[0] - p.door.pos.x, out.pos[2] - p.door.pos.z);
    // facing away from the shop (out along the street) or at it?
    const facingDoor = -Math.sin(W.player.yaw) * (p.door.pos.x - W.player.pos.x) + -Math.cos(W.player.yaw) * (p.door.pos.z - W.player.pos.z) > 0;
    return { inside: inside.desc, tToast, out, fromDoor: e.r2(d), blocked: e.blocked(W.player.pos.x, W.player.pos.z, -0.05), facingDoor, door: [p.door.pos.x, p.door.pos.z].map(e.r2) };
  });
  h.check('T inside a shop says the time changes outside', /\(outside\)/.test(shop.tToast), shop.tToast);
  h.check('Q in the shop: back on the pavement by the door, not inside a collider', shop.out.desc.kind === 'nyc' && shop.out.stack.length === 0 && shop.fromDoor < 3 && !shop.blocked, shop);

  h.step('lift: Q while riding, then the lift again');
  const lift = await h.run(async (e) => {
    const W = e.W, me = W.player.pos;
    const ps = W.level.portals().filter((p) => typeof p.target === 'object' && p.target.kind === 'floor' && p.target.type === 'prewar' && p.door);
    ps.sort((a, b) => a.door.pos.distanceTo(me) - b.door.pos.distanceTo(me));
    const bp = ps[0];
    window.__edgeBld = bp;
    const fx = -Math.sin(bp.door.yaw), fz = -Math.cos(bp.door.yaw);
    const stand = { x: bp.door.pos.x - fx * 1.6, z: bp.door.pos.z - fz * 1.6 };
    await e.walk(me.x, stand.z);
    const en = await e.useSeen(bp, stand);
    const ride = async (digit, qMid) => {
      const lv = W.level, l = lv.lifts[0], f = l.frame, c = Math.cos(f.r), s = Math.sin(f.r);
      const tw = (lx, lz) => ({ x: f.x + lx * c + lz * s, z: f.z - lx * s + lz * c });
      const st = tw(0.78, 1.1);
      await e.walk(0, st.z);
      await e.useSeen(l.call, st);
      const opened = await e.until(() => W.vert.state === 'open', 20000);
      const a = tw(0, 0.6), car = tw(0, -0.9);
      await e.walk(a.x, a.z, { tol: 0.2 });
      await e.walk(car.x, car.z, { tol: 0.2 });
      e.key(digit);
      const rode = await e.until(() => W.vert.state === 'riding', 15000);
      let q = null;
      if (qMid) {
        await e.frames(10);
        await e.back();
        q = { info: e.info(), state: W.vert.state };
        await e.frames(240); // 4+ s of game time: does the finished ride pull us anywhere?
        q.after = { info: e.info(), state: W.vert.state, rides: W.vert.stats.rides };
        return { opened: !!opened, rode: !!rode, q };
      }
      await e.until(() => W.vert.state === 'open' && W.desc.floor !== 0, 40000);
      return { opened: !!opened, rode: !!rode, arrived: e.info(), state: W.vert.state };
    };
    const r1 = await ride('Digit4', true);
    // back in through the same door
    const en2 = await e.useSeen(bp, stand);
    const r2 = await ride('Digit3', false);
    return { en: en.moved, r1, en2: { moved: en2.moved, info: e.info().desc }, r2 };
  });
  h.check('the lift rode after the call', lift.r1.opened && lift.r1.rode, lift.r1);
  h.check('Q mid-ride goes back to the street', lift.r1.q.info.desc.kind === 'nyc' && lift.r1.q.info.stack.length === 0, lift.r1.q.info);
  h.check('...and the abandoned ride does not move us later', lift.r1.q.after.info.desc.kind === 'nyc' && lift.r1.q.after.info.stack.length === 0, lift.r1.q.after);
  h.check('back in the same building, the lift comes, rides and opens on floor 3', lift.en2.moved && lift.r2.opened && lift.r2.rode && lift.r2.arrived?.desc.floor === 2, lift.r2);
  h.check('after that ride the stack is [street, lobby]', lift.r2.arrived?.stack.length === 2, lift.r2.arrived?.stack);

  h.step('stairs down to the lobby pop the stack');
  const st = await h.run(async (e) => {
    const W = e.W, d = W.level.d;
    // from floor 3 down the stair: flight B down to the half landing, flight A down to floor 2 ... to the lobby
    const xa = (d.ax0 - d.gap / 2) / 2, xb = (d.bx1 + d.gap / 2) / 2, zl = (-d.Lf + d.zBack) / 2;
    const seen = [];
    for (let i = 0; i < 2; i++) {
      await e.walkPath(xb, d.Ld * 0.6, { ms: 20000 });
      await e.walk(xb, zl, { ms: 8000 });
      await e.walk(xa, zl, { ms: 6000 });
      await e.walk(xa, d.Ld * 0.6, { ms: 8000, stop: () => W.player.pos.z > 0 && Math.abs(W.player.pos.y) < 0.05 && W.desc.floor === 1 - i });
      await e.frames(5);
      seen.push(e.info());
    }
    return seen;
  });
  h.check('down one storey: floor 2, stack [street, lobby]', st[0].desc.floor === 1 && st[0].stack.length === 2, st[0]);
  h.check('down to the lobby: the lobby entry is popped, stack [street]', st[1].desc.floor === 0 && st[1].stack.length === 1, st[1]);
  const q = await h.run(async (e) => { await e.back(); return e.info(); });
  h.check('Q in the lobby -> street', q.desc.kind === 'nyc' && q.stack.length === 0, q);
});
