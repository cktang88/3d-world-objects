#!/usr/bin/env node
/**
 * Journey 1, the street: spawn on the 5 Av sidewalk -> walk 30 m north along it -> step to the
 * kerb and cross W 35 St at the crosswalk -> T cycles the time of day, Y the weather -> walk into
 * a building wall (the collider must stop you).
 *
 *   npm run e2e -- street [--port 5173] [--shots]
 */
import { journey } from './lib.mjs';

await journey('street', import.meta.url, async (h) => {
  await h.boot('/?mode=world&fast=1');

  h.step('spawn');
  const s0 = await h.info();
  h.check('spawns on the 5 Av sidewalk (x 47.5..52, y 0)', s0.pos[0] > 47.5 && s0.pos[0] < 52 && Math.abs(s0.pos[1]) < 0.01, s0.pos);
  h.check('spawns in the nyc level with an empty stack', s0.desc.kind === 'nyc' && s0.stack.length === 0, s0);
  await h.shot('spawn');

  // walk the sidewalk north, sampling every frame: never inside a collider, always walkable, y 0
  const walkChecked = (x, z) =>
    h.run(async (e, [x, z]) => {
      const D = await import('/src/nyc/districts.ts');
      let bad = [], frames = 0;
      const sample = () => {
        frames++;
        const p = e.W.player.pos;
        if (e.blocked(p.x, p.z, -0.05)) bad.push(['in-collider', e.pos()]);
        else if (!D.walkable(p.x, p.z)) bad.push(['not-walkable', e.pos()]);
        else if (Math.abs(p.y) > 0.25) bad.push(['y', e.pos()]);
        return false;
      };
      const r = await e.walk(x, z, { stop: sample, ms: 25000 });
      return { ...r, frames, bad: bad.slice(0, 5), nBad: bad.length };
    }, [x, z]);

  h.step('walk 30 m north on the sidewalk');
  const w1 = await walkChecked(s0.pos[0], s0.pos[2] - 30);
  h.check('reached 30 m north without getting stuck', !w1.stuck && w1.dist < 0.6, w1);
  h.check('stayed on walkable ground, never inside a collider', w1.nBad === 0, w1.bad);
  await h.shot('walked');

  h.step('cross W 35 St at the crosswalk');
  // the kerb of the spawn block is at z = -27; the street is 10 m wide (to z = -37)
  const w2 = await walkChecked(49.5, -26.6);
  h.check('reached the kerb', !w2.stuck && w2.dist < 0.6, w2);
  const w3 = await walkChecked(49.5, -38);
  h.check('crossed the street to the far kerb', !w3.stuck && w3.dist < 0.6, w3);
  h.check('the crossing stayed on walkable ground', w3.nBad === 0, w3.bad);
  const s3 = await h.info();
  h.check('no errors and still in Manhattan after the crossing', s3.desc.kind === 'nyc' && s3.stack.length === 0, s3);
  await h.shot('crossed', true);

  h.step('time of day (T) and weather (Y)');
  const tod = await h.run(async (e) => {
    const out = [];
    for (let i = 0; i < 6; i++) {
      e.key('KeyT');
      await e.frames(4);
      out.push(document.getElementById('toast').textContent);
    }
    return out;
  });
  h.check('T cycles the time of day with a toast each time', tod.every((t) => /^Time of day: /.test(t)) && new Set(tod).size >= 3, tod);
  const wx = await h.run(async (e) => {
    const out = [];
    for (let i = 0; i < 7; i++) {
      e.key('KeyY');
      await e.frames(4);
      out.push(document.getElementById('toast').textContent);
    }
    await e.frames(30); // the weather blends for a while: run a second of it
    return { out, target: e.W.weather.target };
  });
  h.check('Y cycles the weather with a toast each time', wx.out.every((t) => /^Weather: /.test(t)) && new Set(wx.out).size >= 4, wx);
  await h.shot('weather');

  // walk west into the 5 Av building line (x 47.5) on a stretch of frontage at least 3 m from any door
  const wallTest = (z0, z1) =>
    h.run(async (e, [z0, z1]) => {
      const V = e.W.player.pos.constructor;
      const doors = e.W.level.portals().filter((p) => p.door).map((p) => p.door.pos.z);
      let z = null;
      for (let t = z0; t > z1; t -= 0.5) if (doors.every((d) => Math.abs(d - t) > 3)) { z = t; break; }
      e.W.player.place(new V(48.6, 0, z), Math.PI / 2);
      await e.frames(3);
      const r = await e.walk(40, z, { ms: 6000 });
      return { z, ...r, inside: e.blocked(e.W.player.pos.x, e.W.player.pos.z, -0.05), stack: e.W.stack.length };
    }, [z0, z1]);

  h.step('the block across the street streams in with colliders');
  // r=0 streams the block you walk into (chunk 0,-1): its building line must stop you
  const far = await wallTest(-45, -80);
  h.check('the streamed block (0,-1) blocks the player at its building line', far.pos[0] > 47.45 && !far.inside && far.stack === 0, far);

  h.step('a building wall blocks the player');
  const wall = await wallTest(0, -20);
  h.check('walking into the building stops at its wall (x >= 47.5 - 0.05)', wall.pos[0] > 47.45 && !wall.inside, wall);
  const s4 = await h.info();
  h.check('walking into the wall entered nothing', s4.stack.length === 0 && s4.desc.kind === 'nyc', s4);
  await h.shot('wall');
});
