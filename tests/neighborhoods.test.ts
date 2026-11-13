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
import { Waterfront, HUDSON_X, riverCovered, PIER_CX } from '../src/nyc/waterfront';
import { CityVis } from '../src/nyc/occlusion';

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

test('no HLOD proxy within 150 m of the eye', () => {
  expect(new CityVis().hlodDist >= 150, 'hlodDist under 150 m');
});
