#!/usr/bin/env node
/**
 * Memory, the museum: from the atrium through 6 rooms (doorway to doorway) and back to the atrium,
 * several rounds of the same walk; one drawn frame in every room, and after each round
 * window.__mem(), the JS heap after GC and live three.js object counts (scripts/lib/e2e-mem.mjs).
 * Heap snapshots after round 2 and the last: the constructors that grew most. Must plateau.
 *
 *   npm run e2e -- memory-museum [--port 5173] [--rounds 3]
 */
import { journey } from './lib.mjs';
import { memProbe, growth, save } from '../lib/e2e-mem.mjs';
import path from 'path';

await journey('memory-museum', import.meta.url, async (h) => {
  await h.boot('/?mode=museum&fast=1');
  const mem = await memProbe(h);
  await mem.sample('boot');
  const ROUNDS = Number(h.args.rounds ?? 3), ROOMS = 6;
  let snapA = null;
  for (let r = 0; r < ROUNDS; r++) {
    h.step(`round ${r + 1}: ${ROOMS} rooms and back`);
    const trip = await h.run(async (e, ROOMS) => {
      const W = e.W, seen = [];
      const settle = async (draw = true) => {
        await e.until(() => !W.transitioning, 30000);
        await e.frames(20);
        if (draw) { e.draw(true); await e.frames(1); e.draw(false); } // uploaded, so it must be freed on eviction
      };
      for (let i = 0; i < ROOMS; i++) {
        // the same choice every round: the first doorway (by label) into a room not visited on this walk
        const here = JSON.stringify(W.desc);
        const ps = W.level.portals().filter((p) => typeof p.target === 'object' && p.target.kind === 'gallery' && JSON.stringify(p.target) !== here && !seen.includes(JSON.stringify(p.target)));
        ps.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
        if (!ps.length) break;
        seen.push(here);
        await W.enter(ps[0]);
        await settle();
      }
      const deep = W.stack.length;
      while (W.stack.length) { await W.goBack(); await settle(false); }
      return { rooms: deep, back: W.desc.kind, slots: W.seam.slots.size, evicted: W.seam.stats.evicted };
    }, ROOMS);
    h.check(`round ${r + 1}: walked ${ROOMS} rooms deep and back to the atrium`, trip.rooms === ROOMS && trip.back === 'atrium', trip);
    await mem.sample(`round ${r + 1} (cache ${trip.slots}, evicted ${trip.evicted})`);
    if (r === 1) snapA = await mem.snapshot(path.join(h.outDir, 'a.heapsnapshot'));
  }
  const snapB = await mem.snapshot(path.join(h.outDir, 'b.heapsnapshot'));
  const grew = snapA ? growth(snapA, snapB) : [];
  h.log('heap growth by constructor, round 2 -> last (self size):', JSON.stringify(grew));
  const rows = mem.rows, r2 = rows[2] ?? rows[1], last = rows[rows.length - 1];
  save(h, 'memory-museum', { rows, grew });
  h.check('GPU geometries plateau (last round <= round 2 + 10%)', last.gpuGeo <= r2.gpuGeo * 1.1 + 5, { r2: r2.gpuGeo, last: last.gpuGeo });
  h.check('GPU textures plateau', last.gpuTex <= r2.gpuTex * 1.1 + 3, { r2: r2.gpuTex, last: last.gpuTex });
  h.check('JS heap plateaus (last round <= round 2 + 15%)', last.heapMB <= r2.heapMB * 1.15, { r2: r2.heapMB, last: last.heapMB });
});
