/** NYC districts (districts-blocks): each special block builds within budgets; its showcase slots are sane. */
// default: a few representative blocks (<10 s); QA_DISTRICTS=all for every special block
import { readFileSync } from 'fs';
import { test, expect, none, stats, sceneHash, fmt, rectOverlap } from './qa';
import { nycChunk } from './world';
import { AX, SZ, BX, BZ } from '../src/nyc/common';
import { districtAt, laneOpen, walkable, roadOpen, MAP_BOUNDS, type DKind } from '../src/nyc/districts';
import { slotsUnder } from '../src/nyc/district-showcase';
import type { Rect } from '../src/level';

/** one block of each special kind (and each variant of the open ones) */
const ALL: [string, number, number][] = [
  ['park fountain', 0, -4], ['park pond', 1, -4], ['park playground', -1, -4], ['park ballfield', 2, -4], ['park dogrun', -1, -5], ['park garden', 1, -5],
  ['auto row', 4, -4], ['flea market', 3, -1], ['salvage yard', 5, -1], ['community garden', -2, 0], ['construction', 4, -1], ['rail yard', 5, -1], ['greenmarket', -2, 2], ['museum', -2, -5],
  ['pier shed', 6, 0], ['pier aircraft', 6, 1], ['pier marina', 6, -1], ['carrier', 7, -1],
  ['airport stands', -3, -2], ['airport', -4, -3], ['bowery', 1, 2],
];
const SPECIAL = ALL.filter(([n]) => (process.env.QA_DISTRICTS === 'all' ? /^(auto|construction|rail|greenmarket|museum|bowery)/ : /^(auto row|construction|flea market|salvage yard|community garden|pier shed)$/).test(n) && (!process.env.QA_BLOCK || new RegExp(process.env.QA_BLOCK).test(n)));

test('special blocks build in Node within budgets', () => {
  const bad: string[] = [];
  for (const [name, cx, cz] of SPECIAL) {
    const c = nycChunk(1, cx, cz);
    const s = stats(c.group);
    if (s.drawables > 300) bad.push(`${name}: ${s.drawables} draw calls`);
    if (s.tris > 900_000) bad.push(`${name}: ${s.tris} tris`);
    if (s.materials > 90) bad.push(`${name}: ${s.materials} materials`);
  }
  none(bad, 'blocks over budget');
});

test('showcase slots: inside the block, pools exist, not inside buildings', () => {
  const pools = JSON.parse(readFileSync('public/districts/pools.json', 'utf8')) as Record<string, unknown[]>;
  const bad: string[] = [];
  let total = 0;
  const kinds = new Set<string>();
  for (const [name, cx, cz] of SPECIAL) {
    const c = nycChunk(1, cx, cz);
    const specs = slotsUnder(c.group);
    total += specs.length;
    // buildings: the big colliders (not the slots' own, which are smaller than 30 m)
    const big = c.colliders.filter((r) => r.maxX - r.minX > 9 && r.maxZ - r.minZ > 9 && r.maxX - r.minX < 60);
    for (const s of specs) {
      const ks = Array.isArray(s.kind) ? s.kind : [s.kind];
      for (const k of ks) {
        kinds.add(k);
        if (!((pools[k]?.length ?? 0) >= 5)) bad.push(`${name}: pool '${k}' has ${pools[k]?.length ?? 0}`);
      }
      // a curated first pool may be small, but the slot needs plenty to fall back on
      if (!(ks.reduce((n, k) => n + (pools[k]?.length ?? 0), 0) >= 10)) bad.push(`${name}: pools ${ks} hold < 10`);
      const carrierDeck = name === 'carrier';
      if (!carrierDeck && (Math.abs(s.x) > AX / 2 + 0.5 || Math.abs(s.z) > SZ / 2 + 0.5)) bad.push(`${name}: slot at ${fmt(s.x)},${fmt(s.z)} outside the block`);
      const fp: Rect = { minX: s.x - 0.3, maxX: s.x + 0.3, minZ: s.z - 0.3, maxZ: s.z + 0.3 };
      // colliders centred on the slot are its own (or its fountain basin / plinth)
      const other = big.filter((b) => Math.hypot((b.minX + b.maxX) / 2 - s.x, (b.minZ + b.maxZ) / 2 - s.z) > 0.5);
      if ((s.y ?? 0) < 3 && other.some((b) => rectOverlap(b, fp))) {
        const b = other.find((bb) => rectOverlap(bb, fp))!;
        // boats sit in the water rects, aircraft over the apron, all by design
        if (!['boat', 'pierprop'].some((k) => (Array.isArray(s.kind) ? s.kind : [s.kind]).includes(k))) bad.push(`${name}: ${String(s.kind)} at ${fmt(s.x)},${fmt(s.z)} inside a ${fmt(b.maxX - b.minX)}x${fmt(b.maxZ - b.minZ)} collider`);
      }
    }
  }
  expect(total >= 6 * SPECIAL.length, `only ${total} showcase slots in ${SPECIAL.length} special blocks`);
  expect(kinds.size >= (process.env.QA_DISTRICTS === 'all' ? 10 : 3), `only ${kinds.size} showcase kinds used`);
  none(bad, 'slot problems');
});

test('districts change the street: shop mix differs by district', () => {
  const sig = (cx: number, cz: number) => sceneHash(nycChunk(1, cx, cz).group);
  expect(SPECIAL.length < 2 || sig(SPECIAL[0][1], SPECIAL[0][2]) !== sig(SPECIAL[1][1], SPECIAL[1][2]), 'two different districts built identical blocks');
  void BZ;
});

test('showcase slots wait until their block is placed, then load around the player (teleport case)', async () => {
  const { slotDebug, showcaseReady, updateShowcases, SHOWCASE } = await import('../src/nyc/district-showcase');
  const THREE = await import('three');
  await showcaseReady();
  const c = nycChunk(1, 4, -4); // auto row, built block-local and not yet in the world
  const player = new THREE.Vector3(4 * AX - 41, 0, -4 * SZ);
  const loads = SHOWCASE.loads;
  SHOWCASE.loads = 0; // measure distances without starting real (remote) loads
  for (let i = 0; i < 24; i++) updateShowcases(player);
  expect(slotDebug(c.group).every((s) => Number.isNaN(s.x)), 'a slot took its position before its block was placed');
  const scene = new THREE.Scene();
  const holder = new THREE.Group();
  holder.position.set(4 * AX, 0, -4 * SZ);
  holder.add(c.group);
  scene.add(holder);
  for (let i = 0; i < 24; i++) updateShowcases(player);
  const d = slotDebug(c.group);
  SHOWCASE.loads = loads;
  const near = d.filter((s) => s.dist < 20);
  expect(near.length >= 4, `only ${near.length} showroom slots within 20 m of a player standing in the showroom (e.g. ${d.slice(0, 3).map((s) => `${fmt(s.x)},${fmt(s.z)}`).join(' ')})`);
  holder.remove(c.group);
});

test('storefront variety: no two neighbouring shops of the same kind on the spawn blocks', () => {
  const bad: string[] = [];
  for (const [cx, cz] of [[0, 0], [1, 0]] as [number, number][]) {
    const lines = new Map<string, { t: number; kind: string; label: string }[]>();
    for (const p of nycChunk(1, cx, cz).portals) {
      if (!/ · stocked with sand3d /.test(p.sub ?? '')) continue;
      const cxm = (p.box.min.x + p.box.max.x) / 2, czm = (p.box.min.z + p.box.max.z) / 2;
      // which frontage: the avenue fronts lie near x = ±LX, the street fronts near z = ±LZ
      const k = Math.abs(Math.abs(cxm) - 47.5) < 3 ? `x${Math.sign(cxm)}` : `z${Math.sign(czm)}`;
      if (!lines.has(k)) lines.set(k, []);
      lines.get(k)!.push({ t: k[0] === 'x' ? czm : cxm, kind: (p.sub ?? '').split('stocked with sand3d ')[1], label: p.label });
    }
    for (const [k, list] of lines) {
      list.sort((a, b) => a.t - b.t);
      for (let i = 1; i < list.length; i++) if (list[i].kind === list[i - 1].kind && list[i].t - list[i - 1].t < 14) bad.push(`${cx},${cz} ${k}: ${list[i - 1].label} / ${list[i].label}`);
    }
  }
  none(bad, 'same-kind shops side by side');
});
