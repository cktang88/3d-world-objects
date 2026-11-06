/** NYC districts: showcase slots don't overlap each other, the block's props or its buildings; they sit on a surface. */
// default: a few representative blocks (<10 s); QA_DISTRICTS=all for every special block
import { test, none, fmt } from './qa';
import { nycChunk } from './world';
import { slotsUnder, type SlotSpec } from '../src/nyc/district-showcase';
import type { Rect } from '../src/level';

const ALL: [string, number, number][] = [
  ['park fountain', 0, -4], ['park pond', 1, -4], ['park playground', -1, -4], ['park ballfield', 2, -4], ['park dogrun', -1, -5], ['park garden', 1, -5], ['park meadow', 0, -5], ['park kiosk', 2, -5],
  ['auto row', 4, -4], ['construction', 4, -1], ['rail yard', 5, -1], ['greenmarket', -2, 2], ['armory', -2, -5], ['museum', -2, -6], ['bowery', 1, 2], ['canal', -1, 2], ['brownstone', -2, 0], ['times sq', 2, -3], ['flea market', 3, -1], ['salvage yard', 5, -1], ['community garden', -2, 0],
  ['pier shed', 6, 0], ['pier aircraft', 6, 1], ['pier marina', 6, -1], ['carrier', 7, -1], ['airport stands', -3, -2], ['airport hangar', -4, -3], ['airport ramp', -3, -1],
];
const SPECIAL = process.env.QA_DISTRICTS === 'all' ? ALL : ALL.filter(([n]) => /^(park fountain|park playground|auto row|pier marina|airport stands|construction|flea market|salvage yard|community garden|pier shed|armory|bowery)$/.test(n));

/** a slot's footprint rect (its w along the slot's x, d along z, turned by rot) */
function foot(s: SlotSpec, shrink = 0.7): Rect {
  const c = Math.abs(Math.cos(s.rot ?? 0)), sn = Math.abs(Math.sin(s.rot ?? 0));
  const hw = ((s.w * c + s.d * sn) / 2) * shrink, hd = ((s.w * sn + s.d * c) / 2) * shrink;
  return { minX: s.x - hw, maxX: s.x + hw, minZ: s.z - hd, maxZ: s.z + hd };
}
const area = (r: Rect) => Math.max(0, r.maxX - r.minX) * Math.max(0, r.maxZ - r.minZ);
const inter = (a: Rect, b: Rect): Rect => ({ minX: Math.max(a.minX, b.minX), maxX: Math.min(a.maxX, b.maxX), minZ: Math.max(a.minZ, b.minZ), maxZ: Math.min(a.maxZ, b.maxZ) });
const kinds = (s: SlotSpec) => (Array.isArray(s.kind) ? s.kind : [s.kind]).join('/');
const onWater = (s: SlotSpec) => /boat/.test(kinds(s));

test('showcase slots do not overlap each other', () => {
  const bad: string[] = [];
  for (const [name, cx, cz] of SPECIAL) {
    const sl = slotsUnder(nycChunk(1, cx, cz).group);
    for (let i = 0; i < sl.length; i++)
      for (let j = i + 1; j < sl.length; j++) {
        const a = sl[i], b = sl[j];
        if (Math.abs((a.y ?? 0) - (b.y ?? 0)) > 0.5) continue; // one on a table, one on the floor
        const ov = area(inter(foot(a), foot(b)));
        if (ov > 0.3 * Math.min(area(foot(a)), area(foot(b)))) bad.push(`${name}: ${kinds(a)} at ${fmt(a.x)},${fmt(a.z)} / ${kinds(b)} at ${fmt(b.x)},${fmt(b.z)}`);
      }
  }
  none(bad, 'overlapping slots');
});

test('showcase slots stand clear of the block props, walls and buildings', () => {
  const bad: string[] = [];
  for (const [name, cx, cz] of SPECIAL) {
    const c = nycChunk(1, cx, cz);
    const sl = slotsUnder(c.group);
    // the slots' own colliders (pushed with them) are centred on them: leave those out
    const own = (r: Rect) => sl.some((s) => Math.hypot((r.minX + r.maxX) / 2 - s.x, (r.minZ + r.maxZ) / 2 - s.z) < 0.3);
    const others = c.colliders.filter((r) => !own(r));
    for (const s of sl) {
      if ((s.y ?? 0) > 0.5) continue; // on a table, plinth or deck: what it stands on is its own collider
      const f = foot(s, 0.5);
      for (const r of others) {
        const big = r.maxX - r.minX > 30 && r.maxZ - r.minZ > 14; // water / apron / pond areas
        if (big && onWater(s)) continue;
        const ov = area(inter(f, r));
        if (ov > 0.15 * area(f) && !(big && onWater(s))) {
          bad.push(`${name}: ${kinds(s)} at ${fmt(s.x)},${fmt(s.z)} in a ${fmt(r.maxX - r.minX)}x${fmt(r.maxZ - r.minZ)} collider at ${fmt((r.minX + r.maxX) / 2)},${fmt((r.minZ + r.maxZ) / 2)}`);
          break;
        }
      }
    }
  }
  none(bad, 'slots inside other things', String, Number(process.env.QA_SHOW ?? 12));
});
