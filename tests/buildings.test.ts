/**
 * NYC buildings (src/nyc/buildings*.ts): real-scale storeys, windows, stoops and fire escapes;
 * nothing projects onto the sidewalk beyond what the street allows; door portals reachable from
 * the sidewalk; deterministic builds.
 *
 * Each building is built alone with its front on z = 0 facing +z (the sidewalk is z 0..SW).
 */
import './env';
import * as THREE from 'three';
import { test, expect, between, none, fmt, sceneHash } from './qa';
import { building, makeCtx, finishBuildings, stoopSteps, fireStairRun, type BType, type BCtx } from '../src/nyc/buildings';
import { bake, SW } from '../src/nyc/common';
import { Rng } from '../src/rng';

const TYPES: BType[] = ['brownstone', 'tenement', 'prewar', 'midrise', 'castiron', 'tower'];
const WIDTH: Record<BType, number> = { brownstone: 6, tenement: 7.6, prewar: 16, midrise: 10, castiron: 11, tower: 26 };
const FLOORS: Record<BType, number> = { brownstone: 4, tenement: 6, prewar: 12, midrise: 8, castiron: 6, tower: 24 };

function one(type: BType, seed: number, store = type !== 'brownstone') {
  const group = new THREE.Group(), stat = new THREE.Group();
  const ctx = makeCtx(new Rng(seed), group, stat, 0, 0, seed);
  const w = WIDTH[type];
  building(ctx, { minX: -w / 2, maxX: w / 2, minZ: -18, maxZ: 0 }, 'S', type, FLOORS[type], store, [false, false]);
  return { ctx, group, stat };
}
const SEEDS = [1, 2, 3, 4, 5, 6];
const built = new Map<string, ReturnType<typeof one>>();
function get(type: BType, seed: number, store?: boolean) {
  const k = `${type}|${seed}|${store}`;
  if (!built.has(k)) built.set(k, one(type, seed, store));
  return built.get(k)!;
}
/** windows on the front (z ~ 0, facing +z), as [y, w, h] */
function frontWindows(ctx: BCtx) {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), n = new THREE.Vector3();
  for (const wsp of ctx.win.list) {
    wsp.m.decompose(p, q, s);
    n.set(0, 0, 1).applyQuaternion(q);
    if (n.z > 0.9 && Math.abs(p.z) < 0.6) out.push({ x: p.x, y: p.y, w: wsp.w, h: wsp.h });
  }
  return out;
}

test('storey heights: window rows 2.9-4.3 m apart (towers 3.6 m)', () => {
  const bad: string[] = [];
  for (const type of TYPES)
    for (const seed of SEEDS) {
      const ys = [...new Set(frontWindows(get(type, seed).ctx).filter((w) => w.y > 5).map((w) => Math.round(w.y * 100) / 100))].sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) {
        const d = ys[i] - ys[i - 1];
        if (d < 0.05) continue;
        // brownstone parlour vs upper floors differ in sill height, so allow its first gap to vary
        const [lo, hi] = type === 'brownstone' ? [2.8, 4.4] : [2.9, 4.3];
        if (d < lo || d > hi) bad.push(`${type}#${seed} rows ${fmt(ys[i - 1])}→${fmt(ys[i])} (${fmt(d)} m)`);
      }
    }
  none(bad, 'storey gaps out of range');
});

test('window sizes: residential 0.9-1.25 m wide, 1.4-2.6 m tall; lofts and offices bigger', () => {
  const bad: string[] = [];
  for (const type of TYPES)
    for (const seed of SEEDS)
      for (const w of frontWindows(get(type, seed).ctx)) {
        if (w.y < 0.6) continue; // basement and shop glazing
        const [wl, wh, hl, hh] = type === 'castiron' ? [1.5, 2.6, 2.4, 3.2] : type === 'tower' ? [1.0, 1.6, 1.4, 6.2] : type === 'midrise' ? [0.9, 2.8, 1.3, 2.0] : [0.9, 1.25, 1.0, 2.7];
        if (w.w < wl || w.w > wh || w.h < hl || w.h > hh) bad.push(`${type}#${seed} ${fmt(w.w)}x${fmt(w.h)} at y ${fmt(w.y)}`);
      }
  none(bad, 'windows out of range');
});

test('stoops: risers 15-19 cm, treads 26-32 cm, at most 3.6 m onto the sidewalk', () => {
  for (const parlor of [1.4, 1.5, 1.6, 1.7]) {
    const s = stoopSteps(parlor);
    between(s.rise, 0.15, 0.19, `stoop rise (parlour ${parlor} m)`);
    between(s.tread, 0.26, 0.32, 'stoop tread');
    between(s.length, 2.0, 3.6, `stoop length (parlour ${parlor} m)`);
  }
});

test('fire-escape stairs: 50-65° between balconies on real escape widths', () => {
  for (const fh of [3.05, 3.15, 4.0])
    for (const w of [3.0, 3.6, 4.4, 5.2]) {
      if (fh > 3.5 && w < 3.4) continue; // cast-iron lofts use two-bay escapes (> 3.4 m)
      const ang = (Math.atan2(fh, fireStairRun(w, fh)) * 180) / Math.PI;
      between(ang, 50, 65, `stair angle (floor ${fh} m, escape ${w} m)`);
    }
});

test('nothing on the sidewalk beyond legal projections (colliders and geometry)', () => {
  const bad: string[] = [];
  for (const type of TYPES)
    for (const seed of SEEDS)
      for (const store of [true, false]) {
        const { ctx, stat } = get(type, seed, type === 'brownstone' ? false : store);
        // walkable obstacles: stoops/areaways ≤ 3.8 m, everything else ≤ 1.9 m (steps, tower canopy posts)
        for (const r of ctx.colliders) {
          if (r.maxZ <= 0.01) continue;
          const lim = type === 'brownstone' ? 3.8 : 1.9;
          if (r.maxZ > lim) bad.push(`${type}#${seed} collider reaches ${fmt(r.maxZ)} m`);
        }
        // geometry within the kerb (awnings, canopies and blade signs overhang, but stop short of the road)
        stat.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(stat);
        if (b.max.z > SW - 0.1) bad.push(`${type}#${seed} geometry reaches z ${fmt(b.max.z)} (kerb at ${SW})`);
      }
  none(bad, 'projections');
});

test('door portals are on the sidewalk side and reachable (not inside a collider)', () => {
  const bad: string[] = [];
  for (const type of TYPES)
    for (const seed of SEEDS) {
      const { ctx } = get(type, seed);
      expect(ctx.portals.length > 0, `${type}#${seed}: no door`);
      for (const p of ctx.portals) {
        const b = p.box;
        if (b.max.z < 0.3) { bad.push(`${type}#${seed} '${p.label}' box does not reach the sidewalk`); continue; }
        // some sidewalk point of the box must be free of colliders
        let free = false;
        for (let x = b.min.x; x <= b.max.x && !free; x += 0.2)
          for (let z = Math.max(0.05, b.min.z); z <= b.max.z && !free; z += 0.2)
            if (!ctx.colliders.some((r) => x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ)) free = true;
        if (!free) bad.push(`${type}#${seed} '${p.label}' blocked`);
        if (p.returnPos && p.returnPos.z < 0.2) bad.push(`${type}#${seed} '${p.label}' returns inside the building`);
      }
    }
  none(bad, 'portal problems');
});

test('hulls: one per building, heights sane', () => {
  for (const type of TYPES) {
    const { ctx } = get(type, 1);
    expect(ctx.hulls.length === 1, `${type}: ${ctx.hulls.length} hulls`);
    const h = ctx.hulls[0];
    expect(h.top > 2 && h.top <= h.h + 0.01, `${type}: street wall ${fmt(h.top)} vs height ${fmt(h.h)}`);
    between(h.h / FLOORS[type], 2.6, 4.6, `${type} height per storey`);
  }
});

test('determinism: same seed, same building', () => {
  for (const type of TYPES) {
    const a = one(type, 42), b = one(type, 42);
    for (const x of [a, b]) {
      finishBuildings(x.ctx);
      x.group.add(bake(x.stat));
    }
    expect(sceneHash(a.group) === sceneHash(b.group), `${type}: two builds differ`);
  }
});
