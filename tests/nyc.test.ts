/** NYC blocks: real-scale street dimensions, street furniture placement, door reachability, budgets, determinism. */
import * as THREE from 'three';
import { test, expect, between, none, stats, sceneHash, insideRect, Grid, fmt, soft } from './qa';
import { nycChunk } from './world';
import { AVE, ST, SW, BX, BZ, LX, LZ, CURB, AX, SZ } from '../src/nyc/common';
import { districtAt } from '../src/nyc/districts';
import { facing } from '../src/seamless';
import type { Rect } from '../src/level';

// the spawn block and its neighbour (each block costs ~1-2 s of CPU; builds are cached per file).
// Colliders, portals and doors are block-local (NycLevel.ensure() shifts them by cx*AX, cz*SZ).
const BLOCKS: [number, number][] = [[0, 0], [1, 0]].filter(([x, z]) => !districtAt(x, z).open) as [number, number][];

test('street cross-section is real scale (curb, sidewalk, lanes)', () => {
  between(CURB, 0.15, 0.18, 'curb height (m)');
  between(SW, 3.0, 6.0, 'sidewalk width (m)');
  // avenues: 3 moving lanes 3.6 m apart (Traffic: line ±3.6) + a parking lane each side
  between(3.6, 3.0, 3.7, 'avenue lane width (m)');
  between(AVE / 2 - (3.6 + 1.8), 2.1, 2.8, 'avenue parking lane width (m)');
  between(ST - 2 * 2.3, 3.0, 5.6, 'street travel lane width (m)');
  // Manhattan: avenue blocks ~250-280 m long, ~60 m deep: AX x SZ is a compressed block, keep the ratio sane
  expect(AX > SZ, 'avenue-to-avenue spacing must exceed street spacing');
  expect(BX - LX === SW && BZ - LZ === SW, 'building line = kerb - sidewalk width');
});

test('one block builds in Node (no renderer, no textures)', () => {
  for (const [cx, cz] of BLOCKS) {
    const c = nycChunk(1, cx, cz);
    expect(c.group.children.length > 0, `chunk ${cx},${cz} empty`);
    expect(c.colliders.length > 10, `chunk ${cx},${cz}: only ${c.colliders.length} colliders`);
  }
});

test('budgets per block: draw calls, triangles, materials', () => {
  for (const [cx, cz] of BLOCKS) {
    const s = stats(nycChunk(1, cx, cz).group);
    expect(s.drawables < 260, `chunk ${cx},${cz}: ${s.drawables} meshes (draw calls) > 260`);
    expect(s.tris < 900_000, `chunk ${cx},${cz}: ${s.tris} triangles > 900k (stand-ins only, no models)`);
    expect(s.materials < 80, `chunk ${cx},${cz}: ${s.materials} materials > 80`);
  }
});

test('small street furniture stands on the sidewalk, not in the roadway', () => {
  const bad: string[] = [];
  for (const [cx, cz] of BLOCKS) {
    for (const r of nycChunk(1, cx, cz).colliders) {
      const w = r.maxX - r.minX, d = r.maxZ - r.minZ;
      if (Math.max(w, d) > 3.5) continue; // buildings, cars, shelters
      const x = (r.minX + r.maxX) / 2, z = (r.minZ + r.maxZ) / 2;
      const inRoad = Math.abs(x) > BX + 0.05 || Math.abs(z) > BZ + 0.05;
      const steam = Math.abs(w - 1.1) < 0.01 && Math.abs(d - 1.1) < 0.01; // steam stacks stand in the avenue
      if (inRoad && !steam) bad.push(`${cx},${cz}: ${fmt(w)}x${fmt(d)} at (${fmt(x)}, ${fmt(z)})`);
    }
  }
  none(bad, 'small colliders in the roadway');
});

/** sidewalk ring of one block, block-local; colliders shifted to block-local too */
function sidewalkGrid(cx: number, cz: number) {
  const c = nycChunk(1, cx, cz);
  // the sidewalk ring of the block, and half a metre of kerb lane
  const bounds: Rect = { minX: -BX - 0.5, maxX: BX + 0.5, minZ: -BZ - 0.5, maxZ: BZ + 0.5 };
  return { c, grid: new Grid(bounds, c.colliders, 0.15, 0.3) };
}

test('every door on a block is reachable along the sidewalk from the kerb corner', () => {
  const bad: string[] = [];
  let n = 0;
  for (const [cx, cz] of BLOCKS) {
    const { c, grid } = sidewalkGrid(cx, cz);
    // start at a free point near the NE corner (where NycLevel spawns: BX-2.6, BZ-3.2)
    let reach: ((x: number, z: number, r?: number) => boolean) | null = null;
    for (const [sx, sz] of [[BX - 2.6, BZ - 3.2], [BX - 1, BZ - 1], [-BX + 1, -BZ + 1], [BX - 1, -BZ + 1]]) if (!grid.isBlocked(sx, sz)) { reach = grid.flood(sx, sz); break; }
    expect(reach, `chunk ${cx},${cz}: no free corner to start from`);
    for (const p of c.portals) {
      if (!p.returnPos) continue;
      n++;
      const x = p.returnPos.x, z = p.returnPos.z;
      if (!reach(x, z, 0.6)) bad.push(`${cx},${cz} "${p.label}" at (${fmt(x)}, ${fmt(z)})`);
    }
  }
  expect(n > 5, `only ${n} doors found`);
  none(bad, 'doors not reachable from the street');
});

test('returning through a door never puts you inside a collider', () => {
  const bad: string[] = [];
  for (const [cx, cz] of BLOCKS) {
    const c = nycChunk(1, cx, cz);
    for (const p of c.portals) {
      if (!p.returnPos) continue;
      const hit = c.colliders.find((r) => insideRect(r, p.returnPos!.x, p.returnPos!.z, 0.2) && Math.max(r.maxX - r.minX, r.maxZ - r.minZ) < 30);
      if (hit) bad.push(`"${p.label}" returnPos (${fmt(p.returnPos.x)}, ${fmt(p.returnPos.z)}) in ${fmt(hit.maxX - hit.minX)}x${fmt(hit.maxZ - hit.minZ)} collider`);
    }
  }
  none(bad, 'return positions inside colliders');
});

test('the NYC spawn point is free and on the sidewalk', () => {
  const c = nycChunk(1, 0, 0);
  const x = BX - 2.6, z = BZ - 3.2; // NycLevel.spawn
  expect(Math.abs(x) <= BX && Math.abs(z) <= BZ && (Math.abs(x) > LX || Math.abs(z) > LZ), 'spawn not on the sidewalk');
  none(c.colliders.filter((r) => insideRect(r, x, z, 0.3)), 'colliders at the spawn', (r) => JSON.stringify(r));
});

test('shop doors face into the shop (seamless door yaw) and sit on the building line', () => {
  const bad: string[] = [];
  let n = 0;
  for (const [cx, cz] of BLOCKS) {
    const c = nycChunk(1, cx, cz);
    for (const p of c.portals) {
      if (!p.door) continue;
      n++;
      const x = p.door.pos.x, z = p.door.pos.z;
      // which facade: the nearest building line
      const dx = LX - Math.abs(x), dz = LZ - Math.abs(z);
      const out = Math.abs(dx) < Math.abs(dz) ? new THREE.Vector3(Math.sign(x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(z));
      const inward = facing(p.door.yaw).dot(out) * -1;
      if (inward < 0.95) bad.push(`"${p.label}" yaw ${fmt(p.door.yaw)} faces ${fmt(inward)} inward`);
      if (Math.min(Math.abs(dx), Math.abs(dz)) > 2.5) bad.push(`"${p.label}" door ${fmt(Math.min(Math.abs(dx), Math.abs(dz)))} m off the building line`);
      // the street return yaw faces out to the street
      if (p.returnYaw !== undefined && facing(p.returnYaw).dot(out) < 0.95) bad.push(`"${p.label}" returnYaw faces ${fmt(facing(p.returnYaw).dot(out))} outward`);
    }
  }
  soft(n > 0, 'no seamless shop doors found in the sampled blocks');
  none(bad, 'misoriented shop doors');
});

test('door portals do not overlap each other', () => {
  const bad: string[] = [];
  for (const [cx, cz] of BLOCKS) {
    const ps = nycChunk(1, cx, cz).portals.filter((p) => p.returnPos);
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i].box, b = ps[j].box;
      const ix = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x), iz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
      if (ix > 0.3 && iz > 0.3) bad.push(`${cx},${cz}: "${ps[i].label}" / "${ps[j].label}" (${fmt(ix)} x ${fmt(iz)} m)`);
    }
  }
  none(bad, 'overlapping door portals');
});

test('same seed, same block (determinism)', () => {
  const a = nycChunk(1, 1, 0), b = nycChunk(1, 1, 0, true);
  expect(sceneHash(a.group) === sceneHash(b.group), `scene hash differs: ${sceneHash(a.group)} vs ${sceneHash(b.group)}`);
  expect(JSON.stringify(a.colliders) === JSON.stringify(b.colliders), 'colliders differ between builds');
  expect(sceneHash(a.group) !== sceneHash(nycChunk(1, 0, 0).group), 'two different blocks hash the same');
});
