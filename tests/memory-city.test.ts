/** Memory qa (see tests/memlib.ts): city blocks streamed in and out by NycLevel. */
import * as THREE from 'three';
import { test } from './qa';
import { cycles, refsOf } from './memlib';
import { memTrack } from '../src/dispose';

// ---------------------------------------------------------------- city blocks

test('memory: city block build -> evict 10x (NycLevel streaming) frees its GPU resources and is collected', async () => {
  const { NycLevel } = await import('../src/nyc');
  NycLevel.BUILD_BUDGET_MS = 1000; // a block per frame: the test is about unloading, not time slicing
  const lv = new NycLevel({ kind: 'nyc', seed: 1, name: 'qa' });
  const p = new THREE.Vector3();
  const AX = 120;
  // walk two blocks east and back: each leg builds a block and unloads the one left behind
  const walk = (to: number) => {
    const from = p.x;
    for (let k = 1; k <= 8; k++) {
      p.x = from + ((to - from) * k) / 8;
      for (let f = 0; f < 2; f++) lv.update(1 / 30, p, 0);
    }
    for (let f = 0; f < 20 && lv.streaming; f++) lv.update(1 / 30, p, 0);
    for (let f = 0; f < 4; f++) lv.update(1 / 30, p, 0); // unloads (one per frame)
  };
  memTrack(lv.group, 'nyc');
  await cycles('city', 10, async (i) => {
    const before = new Set(lv.group.children);
    walk(i % 2 ? 0 : 2 * AX);
    memTrack(lv.group, 'nyc');
    // the chunks that were unloaded on this leg
    const gone = [...before].filter((c) => c.parent !== lv.group && c.type === 'Group');
    return gone.flatMap((g) => refsOf(g));
  });
  lv.dispose();
}, { timeout: 43000 }); // ~1.5 s per block build: ~20 s alone, more on a loaded machine (file cap 45 s)

