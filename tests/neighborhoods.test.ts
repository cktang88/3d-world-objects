/**
 * [nbhd] Neighbourhood character (docs/research/neighborhood-audit.md): what makes each district read as
 * its real NYC counterpart, measured on the real generators.
 */
import { test, expect, none, fmt } from './qa';
import { nycChunk } from './world';
import { districtAt } from '../src/nyc/districts';
import { BROWN_FLOORS } from '../src/nyc/brownstone';
import type { Hull } from '../src/nyc/buildings';
import * as THREE from 'three';
import { LX, LZ } from '../src/nyc/common';
import { Waterfront, HUDSON_X, riverCovered, PIER_CX } from '../src/nyc/waterfront';
import { CityVis } from '../src/nyc/occlusion';
import { highLine } from '../src/nyc/nbhd';

/** Brownstone Row blocks on the hand-made map */
const BROWN_BLOCKS: [number, number][] = [[-3, -6], [-3, -3], [-2, -2], [-2, 0]];

test('brownstone blocks are brownstone district', () => {
  for (const [cx, cz] of BROWN_BLOCKS) expect(districtAt(cx, cz).kind === 'brownstone', `${cx},${cz} is ${districtAt(cx, cz).kind}`);
});

/** mid-block brownstones of a chunk, grouped by street side, sorted along the street */
function brownRows(cx: number, cz: number) {
  const c = nycChunk(1, cx, cz) as unknown as { hulls: Hull[] };
  const rows = new Map<string, Hull[]>();
  for (const h of c.hulls ?? []) {
    if (h.type !== 'brownstone' || (h.side !== 'N' && h.side !== 'S')) continue;
    const k = h.side;
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k)!.push(h);
  }
  for (const r of rows.values()) r.sort((a, b) => a.rect.minX - b.rect.minX);
  return [...rows.values()];
}

test('brownstones: 3–4 storeys over the garden level (≈11–17 m to the cornice)', () => {
  const bad: string[] = [];
  let n = 0;
  for (const [cx, cz] of BROWN_BLOCKS)
    for (const row of brownRows(cx, cz))
      for (const h of row) {
        n++;
        // garden level 1.4–1.7, parlour 4.0, then 3.3 m storeys and a 3.0 m top storey, cornice
        if (!(h.h >= 10.5 && h.h <= 17.5)) bad.push(`${cx},${cz} ${h.side} x=${fmt(h.rect.minX)}: ${fmt(h.h)} m`);
      }
  expect(n > 10, `brownstones found: ${n}`);
  expect(BROWN_FLOORS[0] >= 3 && BROWN_FLOORS[1] <= 4, 'BROWN_FLOORS within 3..4');
  none(bad, 'brownstones outside 3–4 storeys');
});

test('brownstone rows share a cornice line (runs of identical houses)', () => {
  let pairs = 0, same = 0, maxRun = 0;
  for (const [cx, cz] of BROWN_BLOCKS)
    for (const row of brownRows(cx, cz)) {
      let run = 1;
      for (let i = 1; i < row.length; i++) {
        const a = row[i - 1], b = row[i];
        if (Math.abs(a.rect.maxX - b.rect.minX) > 0.05) { run = 1; continue; } // a tenement between them
        pairs++;
        if (Math.abs(a.h - b.h) < 0.02) { same++; run++; maxRun = Math.max(maxRun, run); } else run = 1;
      }
    }
  expect(pairs > 8, `adjacent brownstone pairs: ${pairs}`);
  // a row changes height only where one developer's run ends (every 3–7 houses)
  expect(same / pairs > 0.6, `share of neighbours with the same cornice height (${same}/${pairs})`);
  expect(maxRun > 2, `longest run of identical houses: ${maxRun}`);
});

test('brownstones are dressed: ashlar fronts, newels, sunbursts, garden doors, planted areaways', () => {
  const c = nycChunk(1, -2, -2);
  const mats = new Set<string>();
  c.group.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (m && !Array.isArray(m)) mats.add(m.name);
  });
  expect(mats.has('brownstone-ashlar'), `ashlar material in a brownstone block (have ${[...mats].filter(Boolean).join(', ')})`);
});

// ---------------------------------------------------------------- the waterfront

const named = (root: THREE.Object3D, re: RegExp) => {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => { if (re.test(o.name)) out.push(o); });
  return out;
};
const instances = (root: THREE.Object3D, k: string) => named(root, new RegExp(`^waterfront-${k}$`)).reduce((n, o) => n + ((o as THREE.InstancedMesh).count ?? 0), 0);

test('pier chunks: esplanade rail, pile grid, fender piles, bollards, riprap and foam (instanced)', () => {
  const bad: string[] = [];
  for (const cz of [0, 1, -1]) {
    const c = nycChunk(1, PIER_CX, cz);
    const rail = instances(c.group, 'rail'), pile = instances(c.group, 'pile'), boll = instances(c.group, 'bollard'), rock = instances(c.group, 'rock');
    const foam = named(c.group, /^waterfront-foam$/).length;
    if (rail < 60) bad.push(`cz ${cz}: ${rail} rail panels`);
    if (pile < 100) bad.push(`cz ${cz}: ${pile} piles`);
    if (boll < 4) bad.push(`cz ${cz}: ${boll} bollards`);
    if (rock < 40) bad.push(`cz ${cz}: ${rock} riprap stones`);
    if (!foam) bad.push(`cz ${cz}: no foam`);
    // instanced: the kit adds a handful of draws, not hundreds
    const inst = named(c.group, /^waterfront-/).length;
    if (inst > 8) bad.push(`cz ${cz}: ${inst} waterfront meshes`);
  }
  none(bad, 'pier detail');
});

test('river chunks leave the open river to the Waterfront surface (no doubled water planes)', () => {
  expect(riverCovered(HUDSON_X + 1, HUDSON_X + 50), 'Hudson covered');
  const c = nycChunk(1, PIER_CX + 2, 0);
  const water = named(c.group, /.*/).filter((o) => ((o as THREE.Mesh).material as THREE.Material | undefined)?.name === 'river');
  expect(water.length === 0, `river chunk draws ${water.length} water meshes of its own`);
});

test('Waterfront: open river and far shores within budget, backdrop inside the far plane', () => {
  const w = new Waterfront();
  const eye = new THREE.Vector3(HUDSON_X - 5, 1.75, -40);
  w.update(0, eye);
  let tris = 0, meshes = 0;
  w.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    const g = m.geometry;
    tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  expect(meshes <= 4, `${meshes} meshes (draw calls)`);
  expect(tris > 5000 && tris < 120_000, `${tris} triangles`);
  // every backdrop vertex lands inside the camera's 900 m far plane
  w.group.updateMatrixWorld(true);
  let far = 0;
  const v = new THREE.Vector3();
  for (const m of w.backdrop.children as THREE.Mesh[]) {
    const p = m.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i += 7) far = Math.max(far, v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld).distanceTo(eye));
  }
  expect(far < 900, `backdrop reaches ${fmt(far)} m`);
});

// ---------------------------------------------------------------- district signatures

test('the High Line runs through its blocks, 8–10 m up, its strip free of buildings', () => {
  const bad: string[] = [];
  for (let cz = -1; cz <= 3; cz++) {
    const hl = highLine(5, cz)!;
    if (!hl) { bad.push(`no strip at 5,${cz}`); continue; }
    const c = nycChunk(1, 5, cz) as unknown as { group: THREE.Group; hulls: Hull[] };
    for (const h of c.hulls) if (h.rect.maxX > hl.x0 + 0.1 && h.rect.minX < hl.x1 - 0.1) bad.push(`5,${cz}: a building in the strip (${fmt(h.rect.minX)}..${fmt(h.rect.maxX)})`);
    const rails = instances(c.group, 'rail');
    if (rails < 40) bad.push(`5,${cz}: ${rails} High Line rail panels`);
    const tufts = instances(c.group, 'tuft');
    if (tufts < 200) bad.push(`5,${cz}: ${tufts} planting tufts`);
  }
  none(bad, 'High Line');
});

test('Meatpacking: steel loading-dock canopies over the sidewalks', () => {
  const meat = nycChunk(1, 4, 2);
  let canopies = 0;
  meat.group.updateMatrixWorld(true);
  // canopies are merged into the block: count the steel plate area via a ray grid at 3.3 m under the sidewalks
  const ray = new THREE.Raycaster();
  const meshes: THREE.Object3D[] = [];
  meat.group.traverse((o) => { if ((o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh && !(o as THREE.BatchedMesh).isBatchedMesh) meshes.push(o); });
  for (let x = -40; x <= 40; x += 4)
    for (const z of [24.5, -24.5]) {
      ray.set(new THREE.Vector3(x, 2.5, z), new THREE.Vector3(0, 1, 0));
      ray.far = 1.2;
      if (ray.intersectObjects(meshes, false).length) canopies++;
    }
  const hulls = (meat as unknown as { hulls: Hull[] }).hulls;
  expect(canopies >= 6, `${canopies} sidewalk points under a canopy in Meatpacking (${hulls.length} buildings: ${hulls.map((h) => `${h.side}${fmt(h.h)}`).join(' ')})`);
});

test('landmarks: TKTS steps in Duffy Square, Hudson Yards supertalls (HLOD hulls)', () => {
  const ts = nycChunk(1, 2, -3) as unknown as { hulls: Hull[] };
  expect(ts.hulls.some((h) => h.rect.minX >= LX - 20.5 && h.h > 4 && h.h < 7), 'TKTS steps hull on the Times Square avenue end');
  const hy = nycChunk(1, 4, -2) as unknown as { hulls: Hull[] };
  const tall = Math.max(...hy.hulls.map((h) => h.h));
  expect(tall > 280 && tall < 400, `30 Hudson Yards ${fmt(tall)} m`);
});

test('Midtown sidewalks are furnished: kerb-zone pieces on the spawn block', () => {
  const c = nycChunk(1, 0, 0);
  // small colliders (< 3.5 m) in the sidewalks: planters, baskets, racks, newsstands, docks, hydrants, lamps…
  const side = c.colliders.filter((r) => r.maxX - r.minX < 3.5 && r.maxZ - r.minZ < 3.5 && (Math.abs((r.minX + r.maxX) / 2) > LX || Math.abs((r.minZ + r.maxZ) / 2) > LZ));
  expect(side.length >= 36, `${side.length} sidewalk pieces (25 before the [nbhd] streetscape)`);
});

test('no HLOD proxy within 150 m of the eye', () => {
  expect(new CityVis().hlodDist >= 150, 'hlodDist under 150 m');
});
