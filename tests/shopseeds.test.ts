/** Shop layouts across seeds: entrance clear, fixtures inside the room and not overlapping. */
import { test, none, rectOverlap, fmt } from './qa';
import './env';
import { ShopLevel } from '../src/shop';
import { SHOPS } from '../src/nyc';
import type { Rect } from '../src/level';

const SEEDS = [1, 7, 11, 19, 42, 77, 101, 255];
const TYPES = SHOPS.map((s) => s.type);

test(`layouts hold for ${SEEDS.length} seeds of every shop type`, () => {
  const bad: string[] = [];
  for (const t of TYPES)
    for (const seed of SEEDS) {
      const s = new ShopLevel({ kind: 'interior', seed, name: `QA ${t}`, style: 'store', floor: 0, floors: 1, biome: 'metropolis', shop: t });
      const { W, D } = s.room;
      const isWall = (r: Rect) => r.minX < -W / 2 - 0.5 || r.maxX > W / 2 + 0.5 || r.minZ < -D / 2 - 0.5 || r.maxZ > D / 2 + 0.5;
      const d = s.door.pos;
      const zone: Rect = { minX: d.x - 0.7, maxX: d.x + 0.7, minZ: d.z - 1.5, maxZ: d.z - 0.05 };
      const fx = s.colliders().filter((r) => !isWall(r));
      for (const r of fx) {
        if (rectOverlap(zone, r)) bad.push(`${t}#${seed}: blocks the entrance at (${fmt((r.minX + r.maxX) / 2)}, ${fmt((r.minZ + r.maxZ) / 2)})`);
        if (r.minX < -W / 2 - 0.15 || r.maxX > W / 2 + 0.15 || r.minZ < -D / 2 - 0.15 || r.maxZ > D / 2 + 0.15) bad.push(`${t}#${seed}: fixture (${fmt((r.minX + r.maxX) / 2)}, ${fmt((r.minZ + r.maxZ) / 2)}) outside ${fmt(W)}x${fmt(D)}`);
      }
      for (let i = 0; i < fx.length; i++)
        for (let j = i + 1; j < fx.length; j++) {
          const a = fx[i], b = fx[j];
          const ix = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX), iz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
          if (ix > 0.05 && iz > 0.05) bad.push(`${t}#${seed}: ${fmt(a.maxX - a.minX)}x${fmt(a.maxZ - a.minZ)} @(${fmt((a.minX + a.maxX) / 2)}, ${fmt((a.minZ + a.maxZ) / 2)}) overlaps ${fmt(b.maxX - b.minX)}x${fmt(b.maxZ - b.minZ)} @(${fmt((b.minX + b.maxX) / 2)}, ${fmt((b.minZ + b.maxZ) / 2)}) by ${fmt(ix)}x${fmt(iz)}`);
        }
      s.dispose();
    }
  none(bad, 'layout problems', String, 40);
});
