/**
 * City chunk visibility (src/nyc/occlusion.ts, src/nyc/hlod.ts): the occlusion horizon must be
 * conservative (never hide a chunk any part of which a ray from the eye can reach), must cull what
 * is behind street walls, and must stop culling when the eye is above the walls. Synthetic blocks
 * (exact boxes) make the ray check exact; one real block checks the height-grid scan.
 */
import * as THREE from 'three';
import { test, expect, between, fmt, stats } from './qa';
import { NycLevel } from '../src/nyc';
import { nycChunk } from './world';
import { CityVis, heightGrid } from '../src/nyc/occlusion';
import { hlodGeometry } from '../src/nyc/hlod';
import { AX, SZ, LX, LZ } from '../src/nyc/common';

/** a synthetic chunk: one solid block of height h (and optionally a tower of height t) */
function fakeChunk(h: number, tower = 0) {
  const g = new THREE.Group();
  const block = new THREE.Mesh(new THREE.BoxGeometry(LX * 2, h, LZ * 2));
  block.position.y = h / 2;
  g.add(block);
  if (tower) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(20, tower, 20));
    t.position.y = tower / 2;
    g.add(t);
  }
  return g;
}

interface World { vis: CityVis; heights: Map<string, { h: number; t: number }>; groups: Map<string, THREE.Object3D> }
function city(R: number, height: (cx: number, cz: number) => { h: number; t: number }): World {
  const vis = new CityVis();
  vis.hlodDist = Infinity; // distance HLODs are tested separately: here only occlusion hides
  const heights = new Map<string, { h: number; t: number }>();
  const groups = new Map<string, THREE.Object3D>();
  for (let cz = -R; cz <= R; cz++)
    for (let cx = -R; cx <= R; cx++) {
      const hh = height(cx, cz);
      const g = fakeChunk(hh.h, hh.t);
      g.position.set(cx * AX, 0, cz * SZ);
      g.updateMatrixWorld(true);
      vis.add(cx, cz, g);
      heights.set(`${cx},${cz}`, hh);
      groups.set(`${cx},${cz}`, g);
    }
  return { vis, heights, groups };
}

/** exact: can a straight segment from the eye reach point p without passing through any block box? */
function reachable(w: World, eye: THREE.Vector3, p: THREE.Vector3, ownKey: string) {
  const ray = new THREE.Ray(eye.clone(), p.clone().sub(eye).normalize());
  const len = eye.distanceTo(p);
  const hit = new THREE.Vector3();
  for (const [k, hh] of w.heights) {
    const [cx, cz] = k.split(',').map(Number);
    const boxes = [new THREE.Box3(new THREE.Vector3(cx * AX - LX, 0, cz * SZ - LZ), new THREE.Vector3(cx * AX + LX, hh.h, cz * SZ + LZ))];
    for (const b of boxes) {
      if (k === ownKey) b.expandByScalar(-0.05); // the target point may lie on its own block
      if (ray.intersectBox(b, hit) && eye.distanceTo(hit) < len - 0.05) return false;
    }
  }
  return true;
}

function checkConservative(w: World, eye: THREE.Vector3, ccx: number, ccz: number) {
  w.vis.update(eye, ccx, ccz, 9, 9);
  let culled = 0;
  for (const [k] of w.groups) {
    const [kx, kz] = k.split(',').map(Number);
    if (w.vis.modeOf(kx, kz) !== 'occluded') continue;
    culled++;
    const [cx, cz] = k.split(',').map(Number);
    const hh = w.heights.get(k)!;
    // sample the occludee: its whole cell up to the "low" height (streets, trees, low buildings),
    // and the tower's footprint up to its top
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++)
      for (let j = 0; j <= 4; j++)
        for (const y of [0.2, 9, 19]) pts.push(new THREE.Vector3(cx * AX - AX / 2 + (AX * i) / 8, y, cz * SZ - SZ / 2 + (SZ * j) / 4));
    if (hh.t)
      for (const dx of [-10, 0, 10]) for (const dz of [-10, 0, 10]) for (const f of [0.5, 1]) pts.push(new THREE.Vector3(cx * AX + dx, hh.t * f, cz * SZ + dz));
    for (const p of pts) expect(!reachable(w, eye, p, k), `chunk ${k} culled from eye ${fmt(eye.x)},${fmt(eye.y)},${fmt(eye.z)} but point ${fmt(p.x)},${fmt(p.y)},${fmt(p.z)} is visible`);
  }
  return culled;
}

test('occlusion culls blocks behind continuous street walls, and only those', () => {
  const w = city(3, () => ({ h: 20, t: 0 }));
  // on an avenue sidewalk mid-block, eye height 1.6
  const eye = new THREE.Vector3(50.5, 1.6, 0);
  const culled = checkConservative(w, eye, 0, 0);
  expect(culled >= 10, `only ${culled} of 49 chunks culled behind 20 m street walls`);
  // the avenue corridor stays visible
  for (let cz = -3; cz <= 3; cz++) expect(w.groups.get(`0,${cz}`)!.visible || w.groups.get(`1,${cz}`)!.visible, `avenue corridor chunk at cz=${cz} hidden`);
});

test('occlusion is conservative at many street-level eye positions (exact ray check)', () => {
  const w = city(3, (cx, cz) => ({ h: 8 + ((cx * 7 + cz * 13 + 49) % 5) * 6, t: (cx + cz) % 3 === 0 ? 90 : 0 }));
  const eyes = [
    [50.5, 0], [56, 29], [0, 25.5], [-30, -27.5], [60, 32], [55, -10], [-58, 5], [10, 28.5],
  ];
  let culled = 0;
  for (const [x, z] of eyes) culled += checkConservative(w, new THREE.Vector3(x, 1.6, z), Math.round(x / AX), Math.round(z / SZ));
  expect(culled > 0, 'nothing culled at all');
});

test('towers above the street walls stay visible; an eye above the walls culls nothing', () => {
  const w = city(3, (cx, cz) => ({ h: 20, t: cx === -2 && cz === 0 ? 150 : 0 }));
  // from the middle of a cross-street, the tower two blocks west rises above the block in between
  w.vis.update(new THREE.Vector3(0, 1.6, 32), 0, 1, 9, 9);
  expect(w.vis.modeOf(-2, 0) !== 'occluded', 'tower chunk behind walls was culled although it rises above them');
  w.vis.update(new THREE.Vector3(50.5, 60, 0), 0, 0, 9, 9);
  expect(w.vis.stats.occluded === 0, `${w.vis.stats.occluded} chunks occluded from 60 m up`);
});

test('ring: chunks beyond the resident radius are not drawn as real geometry (works for r = 0, 1, 2)', () => {
  for (const r of [0, 1, 2]) {
    const w = city(r + 1, () => ({ h: 2, t: 0 })); // low blocks: no occlusion
    w.vis.update(new THREE.Vector3(0, 1.6, 25.5), 0, 0, r, r);
    for (const [k, g] of w.groups) {
      const [cx, cz] = k.split(',').map(Number);
      if (Math.abs(cx) > r || Math.abs(cz) > r) expect(!g.visible, `r=${r}: hysteresis chunk ${k} drawn`);
    }
    expect(w.groups.get('0,0')!.visible, `r=${r}: own chunk hidden`);
  }
});

test('real block: height grid finds the buildings and the HLOD proxy is cheap', () => {
  const c = nycChunk(1, 0, 0);
  const g = heightGrid(c.group);
  let filled = 0, maxH = 0;
  for (const h of g.h) { if (h > 4) filled++; maxH = Math.max(maxH, h); }
  between(filled / g.h.length, 0.3, 1, 'share of the building area covered by roofs');
  expect(g.top >= maxH, `top ${fmt(g.top)} below roof max ${fmt(maxH)}`);
  const geo = hlodGeometry(g, 1);
  const tris = geo.index!.count / 3;
  between(tris, 10, 4000, 'HLOD triangles per chunk');
});

test('chunk builds are time-sliced: many short steps, same result as the one-go build', () => {
  const lv = Object.create(NycLevel.prototype) as any;
  lv.seed = 1;
  lv.steam = [];
  lv.group = new THREE.Group();
  const it = lv.blockSteps(0, 0) as Generator<void, { group: THREE.Group }>;
  let steps = 0, longest = 0, total = 0, at = 0, r: IteratorResult<void, { group: THREE.Group }>;
  const times: number[] = [];
  for (;;) {
    const t = performance.now();
    r = it.next();
    const dt = performance.now() - t;
    total += dt;
    times.push(Math.round(dt));
    if (dt > longest) { longest = dt; at = steps; }
    if (r.done) break;
    steps++;
  }
  expect(steps >= 6, `only ${steps} yields in a block build`);
  const a = stats(r.value.group), b = stats(nycChunk(1, 0, 0).group);
  expect(a.tris === b.tris && a.drawables === b.drawables, `sliced build differs: ${a.drawables}/${a.tris} vs ${b.drawables}/${b.tris}`);
  console.log(`block build: ${steps + 1} steps, longest ${fmt(longest)} ms (step ${at}) of ${fmt(total)} ms: ${times.join(' ')}`);
});
