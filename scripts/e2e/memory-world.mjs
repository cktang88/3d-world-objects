#!/usr/bin/env node
/**
 * Memory, the city: door round trips from the spawn block (?mode=world&fast=1&r=0). Enters the
 * nearest shop / building doors and comes back, several rounds; after each round one drawn frame,
 * then window.__mem() (renderer.info.memory), the JS heap after GC and live three.js object counts
 * (scripts/lib/e2e-mem.mjs). Heap snapshots after the first and the last round: the constructors
 * that grew most. GPU counts and the heap must plateau.
 *
 *   npm run e2e -- memory-world [--port 5173] [--rounds 4]
 */
import { journey } from './lib.mjs';
import { memProbe, growth, save } from '../lib/e2e-mem.mjs';
import path from 'path';

await journey('memory-world', import.meta.url, async (h) => {
  // precompile=0: no up-front shader compile (minutes and GBs at boot in SwiftShader)
  await h.boot('/?mode=world&fast=1&r=0&precompile=0');
  const mem = await memProbe(h);
  await mem.sample('boot');
  const doors = await h.run((e) => {
    const me = e.W.player.pos;
    const ps = e.W.level.portals().filter((p) => typeof p.target === 'object' && p.target.kind === 'interior');
    ps.sort((a, b) => a.box.getCenter(me.clone()).distanceTo(me) - b.box.getCenter(me.clone()).distanceTo(me));
    window.__memDoors = ps.slice(0, Number(new URLSearchParams(location.search).get('doors') ?? 4));
    return window.__memDoors.map((p) => p.label);
  });
  h.check('doors near the spawn', doors.length >= 3, doors);
  const ROUNDS = Number(h.args.rounds ?? 4);
  let snapA = null;
  for (let r = 0; r < ROUNDS; r++) {
    h.step(`round ${r + 1}: ${doors.length} doors in and out`);
    const trip = await h.run(async (e) => {
      const W = e.W, out = [];
      for (const p of window.__memDoors) {
        const d0 = W.desc;
        await W.enter(p);
        await e.until(() => !W.transitioning, 30000);
        await e.frames(20); // its update, lazy cells, streaming
        // one drawn frame inside, so its geometry and textures are really uploaded (and must be freed)
        e.draw(true); await e.frames(1); e.draw(false);
        out.push(W.desc !== d0);
        await W.goBack();
        await e.until(() => !W.transitioning, 30000);
        await e.frames(10);
      }
      return { entered: out.filter(Boolean).length, slots: W.seam.slots.size, evicted: W.seam.stats.evicted };
    });
    h.check(`round ${r + 1}: entered every door and came back`, trip.entered === doors.length, trip);
    await mem.sample(`round ${r + 1} (cache ${trip.slots}, evicted ${trip.evicted})`);
    // snapshots after rounds 2 and the last: the same door sequence, so the same levels cached
    if (r === 1) snapA = await mem.snapshot(path.join(h.outDir, 'a.heapsnapshot'));
  }
  const snapB = await mem.snapshot(path.join(h.outDir, 'b.heapsnapshot'));
  const grew = growth(snapA, snapB);
  h.log('heap growth by constructor, round 2 -> last (self size):', JSON.stringify(grew));
  // baseline: after round 2 (round 1 fills the level cache; from round 2 on, every round evicts as many as it builds)
  const rows = mem.rows, r1 = rows[2], last = rows[rows.length - 1];
  save(h, 'memory-world', { rows, grew });
  h.check('GPU geometries plateau (last round <= round 2 + 10%)', last.gpuGeo <= r1.gpuGeo * 1.1 + 5, { r2: r1.gpuGeo, last: last.gpuGeo });
  h.check('GPU textures plateau', last.gpuTex <= r1.gpuTex * 1.1 + 3, { r2: r1.gpuTex, last: last.gpuTex });
  h.check('JS heap plateaus (last round <= round 2 + 15%)', last.heapMB <= r1.heapMB * 1.15, { r2: r1.heapMB, last: last.heapMB });
});
