import * as THREE from 'three';
import { rect, overlaps, type Rect } from '../level';
import { Rng, hashN } from '../rng';
import { AX, SZ, CURB } from './common';
import { lampPost } from './streetprops';
import { addTree, type Species } from './streettrees';
import { addSlot, type SlotSpec } from './district-showcase';
import { grassMat, hexPaverMat, pathMat, waterMat, flat, slab, ellipse } from './district-tex';
import { parkBench, hoopFence, chainFence, stoneWall, rock } from './district-props';
import { districtAt } from './districts';
import type { OpenCtx } from './district-open';

/**
 * A Central Park–style park (docs/research/districts.md): lawns behind low iron hoop fences,
 * hexagonal-paver paths with crook lamps and green settees, the elm-lined Mall along the old
 * avenue line, schist outcrops, and in each block one feature: a playground, the boat pond, a
 * Bethesda-style fountain terrace, ballfields and courts, a dog run with bird houses, a formal
 * garden, a meadow, a food kiosk. Benches, playground pieces, statues, boats, sports gear, toys,
 * animal gear and park buildings are sand3d showcase objects at real size (garden/outdoor, sports,
 * toy/game, animal gear, watercraft, architectural element, building families).
 */

export type ParkFeature = 'playground' | 'pond' | 'fountain' | 'ballfield' | 'dogrun' | 'garden' | 'meadow' | 'kiosk';

/** the main park (cx -1..2, cz -7..-4): one feature per block, the best near the 5 Av entrance */
const MAIN: Record<string, ParkFeature> = {
  '-1,-4': 'playground', '0,-4': 'fountain', '1,-4': 'pond', '2,-4': 'ballfield',
  '-1,-5': 'dogrun', '0,-5': 'meadow', '1,-5': 'garden', '2,-5': 'kiosk',
  '-1,-6': 'meadow', '0,-6': 'ballfield', '1,-6': 'playground', '2,-6': 'pond',
  '-1,-7': 'garden', '0,-7': 'pond', '1,-7': 'meadow', '2,-7': 'dogrun',
};
const OTHER: ParkFeature[] = ['playground', 'fountain', 'garden', 'kiosk', 'meadow', 'dogrun'];
export function parkFeature(cx: number, cz: number): ParkFeature {
  return MAIN[`${cx},${cz}`] ?? OTHER[hashN(cx, cz, 9) % OTHER.length];
}

const G = CURB + 0.02; // lawn level
const TREES: Species[] = ['oak', 'plane', 'locust', 'oak', 'ginkgo', 'pear'];

/**
 * Trees go into batches of one model each, at most 30 trees: streettrees' per-group batched
 * meshes are sized for a street's one or two models (growing them disposes the batch).
 */
export function treePlanter(parent: THREE.Object3D) {
  const groups = new Map<string, { g: THREE.Group; n: number }>();
  return (species: Species, variant: number, x: number, y: number, z: number, r: Rng) => {
    const key = `${species}|${variant}`;
    let b = groups.get(key);
    if (!b || b.n >= 30) {
      b = { g: new THREE.Group(), n: 0 };
      parent.add(b.g);
      groups.set(key, b);
    }
    addTree(b.g, species, variant, x, y, z, r);
    b.n++;
  };
}

export function buildPark(c: OpenCtx) {
  const { stat, group, colliders, portals, inner, open, cx, cz } = c;
  const plant = treePlanter(group);
  const r = new Rng(hashN(c.seed, 23));
  const feature = parkFeature(cx, cz);
  /** places taken by paths and features: no trees or rocks there */
  const busy: Rect[] = [];
  const slot = (s: Omit<SlotSpec, 'seed'>, col = true) => {
    addSlot(group, portals, { ...s, seed: hashN(c.seed, Math.round(s.x * 10), Math.round(s.z * 10)) });
    if (col) {
      const turn = Math.abs(Math.sin(s.rot ?? 0)) > 0.7;
      colliders.push(rect(s.x, s.z, (turn ? s.d : s.w) * 0.8, (turn ? s.w : s.d) * 0.8));
    }
  };

  // ---- the ground: lawn everywhere inside the sidewalks
  stat.add(slab(grassMat(), inner.minX, inner.maxX, inner.minZ, inner.maxZ, G, 4));

  // ---- the perimeter: a stone wall along the city streets, with an entrance in the middle
  for (const e of ['+x', '-x', '+z', '-z'] as const) {
    if (!open[e]) continue;
    const alongX = e[1] === 'z';
    const s = e[0] === '+' ? 1 : -1;
    const c0 = alongX ? (s > 0 ? inner.maxZ : inner.minZ) : s > 0 ? inner.maxX : inner.minX;
    const a0 = alongX ? inner.minX : inner.minZ, a1 = alongX ? inner.maxX : inner.maxZ;
    const gate = 3.2;
    const segs: [number, number][] = [[a0, -gate], [gate, a1]];
    for (const [u0, u1] of segs) {
      if (u1 - u0 < 1) continue;
      if (alongX) stoneWall(stat, u0, c0 - s * 0.3, u1, c0 - s * 0.3, CURB);
      else stoneWall(stat, c0 - s * 0.3, u0, c0 - s * 0.3, u1, CURB);
      colliders.push(alongX ? { minX: u0, maxX: u1, minZ: c0 - s * 0.3 - 0.3, maxZ: c0 - s * 0.3 + 0.3 } : { minX: c0 - s * 0.3 - 0.3, maxX: c0 - s * 0.3 + 0.3, minZ: u0, maxZ: u1 });
    }
    // entrance path from the gate to the middle
    if (alongX) stat.add(slab(hexPaverMat(), -2.2, 2.2, Math.min(0, c0), Math.max(0, c0), G + 0.01, 3));
    else stat.add(slab(hexPaverMat(), Math.min(0, c0), Math.max(0, c0), -2.2, 2.2, G + 0.01, 3));
    busy.push(alongX ? rect(0, c0 / 2, 6, Math.abs(c0)) : rect(c0 / 2, 0, Math.abs(c0), 6));
  }

  // ---- paths where the roads used to be: the Mall along avenue lines, walks along street lines
  const mall = (s: 1 | -1) => {
    // half of a 13 m promenade at x = s * AX/2, elms both sides (this chunk plants its side)
    const x0 = s > 0 ? AX / 2 - 6.5 : -AX / 2, x1 = s > 0 ? AX / 2 : -AX / 2 + 6.5;
    stat.add(slab(hexPaverMat(), x0, x1, inner.minZ, inner.maxZ, G + 0.01, 3));
    busy.push({ minX: Math.min(x0, x1) - 3, maxX: Math.max(x0, x1), minZ: inner.minZ, maxZ: inner.maxZ });
    const tx = s * (AX / 2 - 8.2);
    const ex = s * (AX / 2 - 6.9);
    for (let z = inner.minZ + 4; z < inner.maxZ - 2; z += 9) {
      plant('oak', 1, tx, G, z + r.range(-0.4, 0.4), r);
      colliders.push(rect(tx, z, 0.7, 0.7));
    }
    // settees backed against the lawn fence, facing the promenade, lamps between
    hoopFence(stat, ex - s * 0.5, inner.minZ + 1, ex - s * 0.5, inner.maxZ - 1, G);
    for (let z = inner.minZ + 8.5, k = 0; z < inner.maxZ - 3; z += 9, k++) {
      if (k % 3 === 1) slot({ kind: 'bench', x: ex + s * 0.1, y: G, z, rot: s > 0 ? -Math.PI / 2 : Math.PI / 2, w: 2.4, d: 1.2, h: 1.6, min: 0.9, radius: 70 });
      else {
        parkBench(stat, ex - s * 0.15, G, z - 1.0, s > 0 ? Math.PI / 2 : -Math.PI / 2);
        parkBench(stat, ex - s * 0.15, G, z + 1.0, s > 0 ? Math.PI / 2 : -Math.PI / 2);
        colliders.push(rect(ex, z, 0.7, 4));
      }
    }
    for (let z = inner.minZ + 4, k = 0; z < inner.maxZ; z += 18, k++) {
      lampPost(stat, group, ex + s * 0.2, z + 4.5, 'z', s, 'crook');
      colliders.push(rect(ex + s * 0.2, z + 4.5, 0.4, 0.4));
    }
  };
  const walk = (s: 1 | -1) => {
    const z0 = s > 0 ? SZ / 2 - 3 : -SZ / 2, z1 = s > 0 ? SZ / 2 : -SZ / 2 + 3;
    stat.add(slab(pathMat(), inner.minX, inner.maxX, z0, z1, G + 0.012, 3));
    busy.push({ minX: inner.minX, maxX: inner.maxX, minZ: Math.min(z0, z1) - 2, maxZ: Math.max(z0, z1) });
    const bz = s * (SZ / 2 - 3.6);
    for (let x = inner.minX + 14; x < inner.maxX - 10; x += 30) {
      parkBench(stat, x, G, bz, s > 0 ? 0 : Math.PI);
      colliders.push(rect(x, bz, 2, 0.7));
      lampPost(stat, group, x + 7, bz, 'x', s, 'crook');
      colliders.push(rect(x + 7, bz, 0.4, 0.4));
    }
  };
  if (!open['+x']) mall(1);
  if (!open['-x']) mall(-1);
  if (!open['+z']) walk(1);
  if (!open['-z']) walk(-1);

  // ---- the feature of this block, in the middle
  const F = { x: 0, z: 0 };
  const fr = FEATURES[feature](c, F.x, F.z, slot, busy, r);
  busy.push(fr);

  // ---- trees in loose groves on the lawn, schist outcrops
  const free = (x: number, z: number, pad: number) => !busy.some((b) => overlaps(b, rect(x, z, pad, pad)));
  const sp = [r.pick(TREES), r.pick(TREES), r.pick(TREES)];
  let planted = 0;
  for (let i = 0; i < 160 && planted < 26; i++) {
    const x = r.range(inner.minX + 3, inner.maxX - 3), z = r.range(inner.minZ + 3, inner.maxZ - 3);
    if (!free(x, z, 5)) continue;
    plant(sp[planted % 3], r.int(0, 2), x, G, z, r);
    colliders.push(rect(x, z, 0.7, 0.7));
    busy.push(rect(x, z, 3.2, 3.2));
    planted++;
  }
  for (let i = 0, n = 0; i < 40 && n < (feature === 'meadow' ? 3 : 1); i++) {
    const x = r.range(inner.minX + 6, inner.maxX - 6), z = r.range(inner.minZ + 6, inner.maxZ - 6);
    const sx = r.range(2.5, 6), sz = r.range(2, 4.5);
    if (!free(x, z, Math.max(sx, sz) * 2 + 2)) continue;
    rock(stat, x, G, z, sx, r.range(0.8, 1.8), sz, r.range(0, 3), hashN(c.seed, i));
    colliders.push(rect(x, z, sx * 1.6, sz * 1.6));
    busy.push(rect(x, z, sx * 2, sz * 2));
    n++;
  }
  void districtAt;
}

type SlotFn = (s: Omit<SlotSpec, 'seed'>, col?: boolean) => void;
type FeatureFn = (c: OpenCtx, x: number, z: number, slot: SlotFn, busy: Rect[], r: Rng) => Rect;

/** benches in a ring facing a centre */
function benchRing(c: OpenCtx, x: number, z: number, rx: number, rz: number, n: number, slot: SlotFn, showEvery = 3) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const bx = x + Math.cos(a) * rx, bz = z + Math.sin(a) * rz;
    const ry = Math.atan2(x - bx, z - bz);
    if (i % showEvery === 0) slot({ kind: 'bench', x: bx, y: G, z: bz, rot: ry + Math.PI / 2, w: 2.4, d: 1.2, h: 1.6, min: 0.9, radius: 70 });
    else {
      parkBench(c.stat, bx, G, bz, ry);
      c.colliders.push(rect(bx, bz, 1.6, 1.6));
    }
  }
}

const FEATURES: Record<ParkFeature, FeatureFn> = {
  playground(c, x, z, slot, _b, r) {
    const W = 34, D = 24;
    c.stat.add(slab(flat('#3f6e8a', 0.95), x - W / 2, x + W / 2, z - D / 2, z + D / 2, G + 0.02, 4));
    c.stat.add(slab(flat('#c9b48a', 1), x - 6, x + 6, z - 4, z + 4, G + 0.03, 2)); // sandbox
    for (const [x0, z0, x1, z1] of [[-W / 2, -D / 2, W / 2, -D / 2], [-W / 2, D / 2, -2, D / 2], [2, D / 2, W / 2, D / 2], [-W / 2, -D / 2, -W / 2, D / 2], [W / 2, -D / 2, W / 2, D / 2]])
      chainFence(c.stat, x + x0, z + z0, x + x1, z + z1, 1.2, G);
    // swings, slides, climbers along the sides; toys in the sandbox
    const spots: [number, number][] = [[-11, -7], [0, -8], [11, -7], [-11, 6], [11, 6], [-13, 0], [13, 0]];
    for (const [dx, dz] of spots) slot({ kind: 'playground', x: x + dx, y: G, z: z + dz, rot: 0, w: 8, d: 6, h: 6, min: 1.0, radius: 90, maxTris: 250_000 });
    for (let i = 0; i < 6; i++) slot({ kind: 'toy', x: x + r.range(-5, 5), y: G + 0.03, z: z + r.range(-3, 3), rot: r.range(0, 6), w: 0.8, d: 0.8, h: 0.8, min: 0.12, radius: 35, maxTris: 60_000 }, false);
    benchRing(c, x, z, W / 2 - 1.5, D / 2 - 1.5, 10, slot, 4);
    return rect(x, z, W + 4, D + 4);
  },
  pond(c, x, z, slot, _b, r) {
    const RX = 26, RZ = 15;
    c.stat.add(ellipse(flat('#9a9284', 0.9), x, z, RX + 1.6, RZ + 1.6, G + 0.02, 2)); // granite coping
    const w = ellipse(waterMat('#2d4a45'), x, z, RX, RZ, G - 0.25, 6);
    c.group.add(w);
    c.colliders.push(rect(x, z, RX * 1.6, RZ * 1.6));
    // rowboats and canoes on the water, a boathouse kiosk on the shore
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + r.range(-0.3, 0.3);
      slot({ kind: 'boat', x: x + Math.cos(a) * RX * 0.55, y: G - 0.35, z: z + Math.sin(a) * RZ * 0.5, rot: a + Math.PI / 2 + r.range(-0.5, 0.5), w: 6.5, d: 2.6, h: 4, min: 2.2, radius: 110, maxTris: 250_000 }, false);
    }
    slot({ kind: 'smallbuilding', x: x + RX + 6, y: G, z: z - RZ + 2, rot: -Math.PI / 2, w: 9, d: 7, h: 7, min: 2.5, radius: 120, maxTris: 300_000 });
    benchRing(c, x, z, RX + 3, RZ + 3, 12, slot, 4);
    return rect(x, z, RX * 2 + 14, RZ * 2 + 8);
  },
  fountain(c, x, z, slot, _b, r) {
    const W = 44, D = 30;
    c.stat.add(slab(flat('#b3a690', 0.85), x - W / 2, x + W / 2, z - D / 2, z + D / 2, G + 0.02, 3));
    // basin and its centrepiece (a sand3d fountain / monument)
    c.stat.add(ellipse(flat('#8f8576', 0.9), x, z, 9.4, 9.4, G + 0.03, 2));
    const wtr = ellipse(waterMat('#3d5f60'), x, z, 8.6, 8.6, G + 0.35, 4);
    c.group.add(wtr);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(9, 0.4, 6, 40), flat('#9d9382', 0.85));
    rim.rotation.x = Math.PI / 2;
    rim.position.set(x, G + 0.45, z);
    rim.scale.z = 1.5;
    rim.userData.owned = true;
    c.stat.add(rim);
    c.colliders.push(rect(x, z, 18, 18));
    slot({ kind: ['parkdecor', 'arch'], x, y: G + 0.3, z, rot: 0, w: 8, d: 8, h: 12, min: 2.0, radius: 140, maxTris: 400_000 }, false);
    // statues on plinths at the corners of the terrace
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const px = x + sx * (W / 2 - 4), pz = z + sz * (D / 2 - 4);
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.2, 2.4), flat('#a59c8c', 0.85));
      plinth.position.set(px, G + 0.6, pz);
      plinth.castShadow = true;
      plinth.userData.owned = true;
      c.stat.add(plinth);
      c.colliders.push(rect(px, pz, 2.6, 2.6));
      slot({ kind: ['arch', 'parkdecor', 'armour'], x: px, y: G + 1.2, z: pz, rot: Math.atan2(-sx, -sz), w: 2.2, d: 2.2, h: 3.2, min: 0.9, radius: 90, maxTris: 200_000 }, false);
    }
    benchRing(c, x, z, 14, 10, 8, slot, 3);
    void r;
    return rect(x, z, W + 2, D + 2);
  },
  ballfield(c, x, z, slot, _b, r) {
    // a baseball diamond (infield dirt, backstop) and a basketball court beside it
    const bx = x - 14;
    c.stat.add(slab(flat('#a9825a', 1), bx - 12, bx + 12, z - 12, z + 12, G + 0.02, 3));
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(13, 13), flat('#557a35', 0.95));
    grass.rotation.set(-Math.PI / 2, 0, Math.PI / 4);
    grass.position.set(bx, G + 0.03, z);
    grass.userData.owned = true;
    c.stat.add(grass);
    for (const [dx, dz] of [[0, -9], [9, 0], [0, 9], [-9, 0]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 0.4), flat('#f2f0ea', 0.6));
      b.position.set(bx + dx, G + 0.06, z + dz);
      b.userData.owned = true;
      c.stat.add(b);
    }
    chainFence(c.stat, bx - 6, z + 13, bx + 6, z + 13, 4.5, G);
    chainFence(c.stat, bx - 6, z + 13, bx - 10, z + 9, 4.5, G);
    chainFence(c.stat, bx + 6, z + 13, bx + 10, z + 9, 4.5, G);
    // players' benches with gear on them
    for (const s of [-1, 1]) {
      parkBench(c.stat, bx + s * 11, G, z + 9, s > 0 ? -Math.PI / 4 : Math.PI / 4);
      for (let i = 0; i < 2; i++) slot({ kind: 'sport', x: bx + s * (10 - i * 1.6), y: G + 0.02, z: z + 11.5, rot: r.range(0, 6), w: 1.4, d: 1.2, h: 1.2, min: 0.06, radius: 40, maxTris: 80_000 }, false);
    }
    const kx = x + 20;
    c.stat.add(slab(flat('#2f5d7a', 0.85), kx - 8, kx + 8, z - 14, z + 14, G + 0.02, 4));
    c.stat.add(slab(flat('#c45b3c', 0.85), kx - 6, kx + 6, z - 12, z + 12, G + 0.025, 4));
    chainFence(c.stat, kx - 8, z - 14, kx - 8, z + 14, 3, G);
    chainFence(c.stat, kx + 8, z - 14, kx + 8, z + 14, 3, G);
    for (const s of [-1, 1]) slot({ kind: 'sport', x: kx, y: G, z: z + s * 12.5, rot: s > 0 ? Math.PI : 0, w: 2.5, d: 2.5, h: 4.5, min: 0.8, radius: 90, maxTris: 150_000 });
    for (let i = 0; i < 4; i++) slot({ kind: 'sport', x: kx + r.range(-5, 5), y: G + 0.03, z: z + r.range(-9, 9), rot: r.range(0, 6), w: 1.2, d: 1.2, h: 1.2, min: 0.1, radius: 40, maxTris: 60_000 }, false);
    return rect(x + 3, z, 56, 32);
  },
  dogrun(c, x, z, slot, _b, r) {
    const W = 30, D = 20;
    c.stat.add(slab(flat('#a49a85', 1), x - W / 2, x + W / 2, z - D / 2, z + D / 2, G + 0.02, 2));
    for (const [x0, z0, x1, z1] of [[-W / 2, -D / 2, W / 2, -D / 2], [-W / 2, D / 2, W / 2, D / 2], [-W / 2, -D / 2, -W / 2, D / 2], [W / 2, -D / 2, W / 2, 0]])
      chainFence(c.stat, x + x0, z + z0, x + x1, z + z1, 1.5, G);
    // dog houses, agility pieces, feeders, bird houses and an aviary around it
    for (let i = 0; i < 7; i++) slot({ kind: 'animal', x: x + r.range(-W / 2 + 3, W / 2 - 3), y: G + 0.02, z: z + r.range(-D / 2 + 3, D / 2 - 3), rot: r.range(0, 6), w: 3, d: 3, h: 3.5, min: 0.25, radius: 60, maxTris: 120_000 });
    for (let i = 0; i < 4; i++) slot({ kind: 'animal', x: x + (i - 1.5) * 7, y: G, z: z + D / 2 + 4, rot: Math.PI, w: 2.5, d: 2.5, h: 4, min: 0.3, radius: 60, maxTris: 120_000 });
    benchRing(c, x, z, W / 2 + 3, D / 2 + 3, 8, slot, 4);
    return rect(x, z, W + 8, D + 12);
  },
  garden(c, x, z, slot, _b, r) {
    // formal garden: clipped hedges around beds, a pergola, urns and planters on the walks
    const W = 40, D = 26;
    c.stat.add(slab(flat('#b5a98f', 0.95), x - W / 2, x + W / 2, z - D / 2, z + D / 2, G + 0.015, 2));
    for (const [bx, bz] of [[-10, -6], [10, -6], [-10, 6], [10, 6]]) {
      c.stat.add(slab(grassMat(), x + bx - 7, x + bx + 7, z + bz - 4, z + bz + 4, G + 0.025, 4));
      for (const s of [-1, 1]) {
        const h = new THREE.Mesh(new THREE.BoxGeometry(14.4, 0.8, 0.6), flat('#2f4a25', 0.95));
        h.position.set(x + bx, G + 0.4, z + bz + s * 4.2);
        h.castShadow = true;
        h.userData.owned = true;
        c.stat.add(h);
      }
      slot({ kind: 'parkdecor', x: x + bx, y: G + 0.03, z: z + bz, rot: 0, w: 3, d: 3, h: 4, min: 0.5, radius: 70, maxTris: 150_000 }, false);
    }
    slot({ kind: ['parkdecor', 'smallbuilding'], x, y: G, z, rot: 0, w: 8, d: 6, h: 6, min: 2, radius: 120, maxTris: 300_000 });
    for (let i = 0; i < 6; i++) slot({ kind: 'garden', x: x + (i - 2.5) * 6.5, y: G, z: z + D / 2 - 1, rot: Math.PI, w: 2.5, d: 1.6, h: 2.4, min: 0.4, radius: 60, maxTris: 100_000 });
    benchRing(c, x, z, W / 2 - 1, D / 2 - 1, 8, slot, 4);
    void r;
    return rect(x, z, W + 2, D + 2);
  },
  meadow(c, x, z, slot, _b, r) {
    // Sheep Meadow: open lawn behind hoop fences, picnic blankets, a grill and an umbrella or two
    hoopFence(c.stat, x - 30, z - 16, x + 30, z - 16, G);
    hoopFence(c.stat, x - 30, z + 16, x + 30, z + 16, G);
    const cols = ['#c23b3b', '#3b6fc2', '#e0c341', '#e8e4dc', '#3c9a5c', '#9a3c8a'];
    for (let i = 0; i < 7; i++) {
      const bx = x + r.range(-24, 24), bz = z + r.range(-11, 11);
      const blanket = new THREE.Mesh(new THREE.PlaneGeometry(r.range(1.6, 2.2), r.range(1.4, 1.9)), flat(r.pick(cols), 1));
      blanket.rotation.set(-Math.PI / 2, 0, r.range(0, 3));
      blanket.position.set(bx, G + 0.03, bz);
      blanket.userData.owned = true;
      c.stat.add(blanket);
      slot({ kind: r.chance(0.5) ? 'garden' : r.chance(0.5) ? 'toy' : 'sport', x: bx + 0.6, y: G + 0.03, z: bz + 0.4, rot: r.range(0, 6), w: 1.4, d: 1.4, h: 1.5, min: 0.1, radius: 45, maxTris: 80_000 }, false);
    }
    for (let i = 0; i < 3; i++) slot({ kind: 'garden', x: x + r.range(-20, 20), y: G, z: z + r.range(-10, 10), rot: r.range(0, 6), w: 3, d: 3, h: 3, min: 0.8, radius: 80, maxTris: 120_000 });
    return rect(x, z, 40, 18);
  },
  kiosk(c, x, z, slot, _b, r) {
    // a food kiosk with café tables, carts and a hot-dog stand
    c.stat.add(slab(hexPaverMat(), x - 16, x + 16, z - 11, z + 11, G + 0.015, 3));
    slot({ kind: 'smallbuilding', x, y: G, z: z - 4, rot: 0, w: 9, d: 7, h: 7, min: 2.5, radius: 120, maxTris: 300_000 });
    for (let i = 0; i < 6; i++) slot({ kind: ['garden', 'furniture'], x: x + (i - 2.5) * 4.5, y: G, z: z + 5 + (i % 2) * 2.5, rot: r.range(0, 6), w: 2.2, d: 2.2, h: 2.6, min: 0.6, radius: 60, maxTris: 100_000 });
    for (const s of [-1, 1]) slot({ kind: ['truck', 'bike'], x: x + s * 12, y: G, z: z - 3, rot: Math.PI / 2, w: 4, d: 2.2, h: 3, min: 1.2, radius: 90, maxTris: 150_000 });
    return rect(x, z, 34, 24);
  },
};
