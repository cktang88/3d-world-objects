import * as THREE from 'three';
import { rect } from '../level';
import type { Rng } from '../rng';
import { LX, LZ, CURB } from './common';
import { building, type BCtx } from './buildings';
import { kit, place, sidewalkShed } from './streetprops';
import { mat } from '../build';
import type { Plan } from './district-build';
import { slotter, sign } from './district-custom';
import { flat, slab, apronMat } from './district-tex';
import { chainFence, stall, jersey } from './district-props';

/**
 * Yards and plazas cut into a block: the Hudson Yards construction site (tools, machines,
 * trucks, a tower crane), the West Side rail and container yards (trains, freight, machines), a
 * greenmarket plaza of stalls (food and drink, packaging) and the museum's steps and plinths
 * (architectural elements, arms and armour, measuring instruments).
 */

const Y = CURB + 0.01;

/** the region of one avenue end (s = -1 west / +1 east) */
function aveEnd(s: number) {
  return { x0: Math.min(s * LX, s * (LX - 20)), x1: Math.max(s * LX, s * (LX - 20)), z0: -LZ, z1: LZ };
}
/** the region of one mid-block row (s = -1 north / +1 south), `depth` deep */
function rowArea(s: number, depth = 17) {
  return { x0: -LX + 20, x1: LX - 20, z0: s > 0 ? LZ - depth : -LZ, z1: s > 0 ? LZ : -LZ + depth };
}

/** a plywood construction fence along a building line, with a gate gap */
function plywood(ctx: BCtx, ax: 'x' | 'z', c: number, a0: number, a1: number, gate: [number, number] | null, color = '#2b4c8c') {
  const segs: [number, number][] = gate ? [[a0, gate[0]], [gate[1], a1]] : [[a0, a1]];
  for (const [u0, u1] of segs) {
    if (u1 - u0 < 0.5) continue;
    const m = new THREE.Mesh(new THREE.BoxGeometry(ax === 'x' ? u1 - u0 : 0.08, 2.5, ax === 'x' ? 0.08 : u1 - u0), flat(color, 0.85));
    m.position.set(ax === 'x' ? (u0 + u1) / 2 : c, CURB + 1.25, ax === 'x' ? c : (u0 + u1) / 2);
    m.castShadow = true;
    m.userData.owned = true;
    ctx.stat.add(m);
    ctx.colliders.push(ax === 'x' ? { minX: u0, maxX: u1, minZ: c - 0.15, maxZ: c + 0.15 } : { minX: c - 0.15, maxX: c + 0.15, minZ: u0, maxZ: u1 });
  }
}

/** tower crane: lattice mast, jib and counter-jib, cab (kit, ~60 m) */
function towerCrane(ctx: BCtx, x: number, z: number, ry: number) {
  const parts = kit('tower-crane', (k) => {
    const yel = mat('#e0b21c', { rough: 0.6, metal: 0.3 });
    const H = 58, w = 2;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.add(new THREE.BoxGeometry(0.18, H, 0.18), yel, (sx * w) / 2, H / 2, (sz * w) / 2);
    for (let y = 0; y < H; y += 2.5) {
      for (const f of [0, 1, 2, 3]) {
        const a = (f * Math.PI) / 2;
        const g = new THREE.BoxGeometry(0.08, 3.2, 0.08);
        g.rotateZ(Math.atan2(w, 2.5));
        g.translate(0, y + 1.25, w / 2);
        g.rotateY(a);
        k.add(g, yel);
      }
    }
    // jib (50 m) and counter-jib (15 m), triangular section approximated by three chords
    for (const [len, dir] of [[50, 1], [15, -1]] as const) {
      for (const [dy, dz] of [[0, -0.7], [0, 0.7], [1.6, 0]]) k.add(new THREE.BoxGeometry(len, 0.14, 0.14), yel, (dir * len) / 2, H + 0.5 + dy, dz);
      for (let u = 0; u < len; u += 2) {
        const g = new THREE.BoxGeometry(0.06, 1.9, 0.06);
        g.rotateZ(0.6);
        g.translate(dir * (u + 1), H + 1.3, 0);
        k.add(g, yel);
      }
    }
    k.add(new THREE.BoxGeometry(4, 2.4, 2.2), mat('#7a7d80', { rough: 0.8 }), -12, H - 0.6, 0); // counterweights
    k.add(new THREE.BoxGeometry(2.2, 2.4, 2.2), mat('#e8e6df', { rough: 0.5 }), 1.6, H - 1.5, 0); // cab
    k.add(new THREE.BoxGeometry(0.04, 30, 0.04), mat('#222222', { rough: 0.5, metal: 0.8 }), 30, H - 15, 0); // hook cable
    k.add(new THREE.BoxGeometry(0.8, 1.2, 0.6), yel, 30, H - 30.6, 0);
    k.add(new THREE.ConeGeometry(0.9, 4, 4), yel, 0, H + 4, 0); // apex
  });
  place(ctx.stat, parts, x, CURB, z, ry);
  ctx.colliders.push(rect(x, z, 2.6, 2.6));
}

function portaJohn(ctx: BCtx, x: number, z: number, ry: number) {
  const parts = kit('porta-john', (k) => {
    k.add(new THREE.BoxGeometry(1.1, 2.2, 1.15), mat('#2d62b5', { rough: 0.6 }), 0, 1.1, 0);
    k.add(new THREE.BoxGeometry(1.2, 0.12, 1.25), mat('#e8e8e8', { rough: 0.5 }), 0, 2.26, 0);
  });
  place(ctx.stat, parts, x, CURB, z, ry);
  ctx.colliders.push(rect(x, z, 1.2, 1.2));
}

// ---------------------------------------------------------------- construction site

export function buildConstruction(ctx: BCtx, r: Rng): Plan {
  const slot = slotter(ctx);
  const s = r.chance(0.5) ? 1 : -1, row = r.chance(0.5) ? 1 : -1;
  const A = aveEnd(s), R = rowArea(row);
  // dirt and gravel over the site, a dug pit with a ramp
  const dirt = flat('#7d6a52', 1);
  ctx.stat.add(slab(dirt, A.x0, A.x1, A.z0, A.z1, Y, 4));
  ctx.stat.add(slab(dirt, R.x0, R.x1, R.z0, R.z1, Y, 4));
  const pit = new THREE.Mesh(new THREE.BoxGeometry(14, 0.05, 26), flat('#5e4f3d', 1));
  pit.position.set((A.x0 + A.x1) / 2, CURB + 0.03, 0);
  pit.userData.owned = true;
  ctx.stat.add(pit);
  // blue plywood fence on the street lines (with a truck gate) and a sidewalk shed along it
  plywood(ctx, 'z', s * LX, -LZ, LZ, [-4, 4]);
  plywood(ctx, 'x', row * LZ, R.x0, R.x1, null);
  plywood(ctx, 'x', -row * LZ, A.x0, A.x1, null);
  sign(ctx, 'POST NO BILLS', s * (LX + 0.06), CURB + 1.6, -12, s > 0 ? Math.PI / 2 : -Math.PI / 2, 0.5, 6, '#ffffff', 'paint');
  sign(ctx, 'HUDSON YARDS · PHASE II', 0, CURB + 1.7, row * (LZ + 0.06), row > 0 ? 0 : Math.PI, 0.55, 14, '#ffffff', 'paint');
  sidewalkShed(ctx.stat, 0, row * (LZ + 1.4), row > 0 ? 0 : Math.PI, R.x1 - R.x0 - 2);
  towerCrane(ctx, (A.x0 + A.x1) / 2 - s * 5, row * (LZ - 6), r.range(0, Math.PI * 2));
  // machines and trucks in the pit and the yard, tools and materials around them
  slot({ kind: 'truck', x: (A.x0 + A.x1) / 2, y: Y, z: -6, rot: Math.PI / 2, w: 11, d: 4, h: 5, min: 4, radius: 120, maxTris: 300_000 });
  slot({ kind: 'truck', x: (A.x0 + A.x1) / 2, y: Y, z: 9, rot: Math.PI / 2 + 0.3, w: 11, d: 4, h: 5, min: 4, radius: 120, maxTris: 300_000 });
  for (let i = 0; i < 4; i++) slot({ kind: 'machine', x: R.x0 + 6 + i * 12, y: Y, z: (R.z0 + R.z1) / 2 - row * 3, rot: r.range(0, 6), w: 4, d: 3, h: 4, min: 0.8, radius: 90, maxTris: 150_000 });
  for (let i = 0; i < 6; i++) slot({ kind: 'tool', x: R.x0 + 13 + i * 6.3, y: Y, z: (R.z0 + R.z1) / 2 + row * 3 + r.range(-1, 1), rot: r.range(0, 6), w: 2.2, d: 1.6, h: 2.6, min: 0.25, radius: 55, maxTris: 80_000 });
  // pallets and crates at the ends of the pit, clear of the crane
  for (let i = 0; i < 4; i++) slot({ kind: ['freight', 'hardware'], x: (A.x0 + A.x1) / 2 + s * (3 + (i % 2) * 4), y: Y, z: (i < 2 ? -19 : 19), rot: 0, w: 2.4, d: 2.4, h: 2.4, min: 0.3, radius: 60, maxTris: 80_000 });
  // rebar bundles, jersey barriers, porta-johns, a site office
  const rebar = flat('#6b3d27', 0.7, 0.5);
  for (let i = 0; i < 3; i++) {
    const g = new THREE.Mesh(new THREE.BoxGeometry(9, 0.25, 1.2), rebar);
    g.position.set(R.x0 + 30 + i * 0.1, CURB + 0.13 + i * 0.25, (R.z0 + R.z1) / 2);
    g.userData.owned = true;
    ctx.stat.add(g);
  }
  for (let i = 0; i < 3; i++) jersey(ctx.stat, (A.x0 + A.x1) / 2 + s * 7.5, CURB, -10 + i * 3.1, Math.PI / 2);
  portaJohn(ctx, R.x1 - 2, R.z0 + (row > 0 ? 2 : R.z1 - R.z0 - 2), 0);
  portaJohn(ctx, R.x1 - 3.3, R.z0 + (row > 0 ? 2 : R.z1 - R.z0 - 2), 0);
  for (const lvl of [0, 1]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(9, 2.7, 3), flat(lvl ? '#e8e3d3' : '#d9d2bd', 0.7));
    t.position.set(R.x0 + 6, CURB + 1.35 + lvl * 2.8, R.z0 + (R.z1 - R.z0) / 2 + row * 4);
    t.castShadow = true;
    t.userData.owned = true;
    ctx.stat.add(t);
  }
  ctx.colliders.push(rect(R.x0 + 6, R.z0 + (R.z1 - R.z0) / 2 + row * 4, 9, 3));
  return { ave: s > 0 ? [true, false] : [false, true], rows: row > 0 ? [true, false] : [false, true], core: false };
}

// ---------------------------------------------------------------- rail and container yards

/** stacks of corrugated shipping containers (2.44 x 2.59 x 6.06 / 12.19 m) */
function containerStack(ctx: BCtx, x: number, z: number, n: number, r: Rng, along: 'x' | 'z') {
  const cols = ['#a33b2a', '#2a5d8f', '#c98a1a', '#3b6b3b', '#7a7a78', '#b5502a', '#1f3f5f', '#e8e4dc'];
  for (let i = 0; i < n; i++) {
    const L = r.chance(0.6) ? 12.19 : 6.06;
    const m = new THREE.Mesh(new THREE.BoxGeometry(along === 'x' ? L : 2.44, 2.59, along === 'x' ? 2.44 : L), corrugated(r.pick(cols)));
    m.position.set(x, CURB + 1.295 + i * 2.6, z);
    m.castShadow = true;
    m.userData.owned = true;
    ctx.stat.add(m);
  }
  ctx.colliders.push(along === 'x' ? rect(x, z, 12.4, 2.6) : rect(x, z, 2.6, 12.4));
}
const corr = new Map<string, THREE.MeshStandardMaterial>();
function corrugated(color: string) {
  let m = corr.get(color);
  if (m) return m;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 8;
  const g = c.getContext('2d')!;
  for (let x = 0; x < 64; x++) {
    const v = 0.78 + 0.22 * Math.sin((x / 64) * Math.PI * 2 * 8);
    g.fillStyle = `rgba(${Math.round(255 * v)},${Math.round(255 * v)},${Math.round(255 * v)},1)`;
    g.fillRect(x, 0, 1, 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  corr.set(color, (m = new THREE.MeshStandardMaterial({ color, map: t, roughness: 0.7, metalness: 0.3 })));
  return m;
}

/** rails: two steel rails on timber ties along x, from x0 to x1 at z */
function track(ctx: BCtx, x0: number, x1: number, z: number) {
  const len = x1 - x0;
  const steel = flat('#5d5650', 0.4, 0.8), tie = flat('#4a3b2c', 0.95);
  ctx.stat.add(slab(flat('#6d6862', 1), x0, x1, z - 1.6, z + 1.6, Y + 0.005, 2)); // ballast
  for (const dz of [-0.72, 0.72]) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(len, 0.15, 0.07), steel);
    r.position.set((x0 + x1) / 2, CURB + 0.2, z + dz);
    r.userData.owned = true;
    ctx.stat.add(r);
  }
  for (let x = x0 + 0.3; x < x1; x += 0.6) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 2.6), tie);
    t.position.set(x, CURB + 0.08, z);
    t.userData.owned = true;
    ctx.stat.add(t);
  }
}

export function buildYard(ctx: BCtx, r: Rng): Plan {
  const slot = slotter(ctx);
  // every other industrial block keeps its buildings (lofts, garages)
  if ((ctx.cx + ctx.cz) % 2 === 0) return { ave: [true, true], rows: [true, true] };
  const row = r.chance(0.5) ? 1 : -1, s = r.chance(0.5) ? 1 : -1;
  // ---- the rail yard in one row: three tracks, trains and wagons on them
  const R = rowArea(row, 18);
  ctx.stat.add(slab(flat('#77726b', 1), R.x0, R.x1, R.z0, R.z1, Y, 4));
  chainFence(ctx.stat, R.x0, row * LZ, R.x1, row * LZ, 2.6, CURB);
  ctx.colliders.push({ minX: R.x0, maxX: R.x1, minZ: row * LZ - 0.15, maxZ: row * LZ + 0.15 });
  const tz = [R.z0 + 3.5, (R.z0 + R.z1) / 2, R.z1 - 3.5];
  for (const z of tz) track(ctx, R.x0, R.x1, z);
  for (const z of tz) for (const x of [R.x0 + 13, R.x1 - 13]) slot({ kind: 'train', x, y: CURB + 0.27, z, rot: 0, w: 24, d: 3.6, h: 5.2, min: 6, radius: 130, maxTris: 300_000 });
  // ---- the container and freight yard on one avenue end
  const A = aveEnd(s);
  ctx.stat.add(slab(apronMat(), A.x0, A.x1, A.z0, A.z1, Y, 12));
  chainFence(ctx.stat, s * LX, -LZ, s * LX, -3, 2.6, CURB);
  chainFence(ctx.stat, s * LX, 3, s * LX, LZ, 2.6, CURB);
  ctx.colliders.push({ minX: s * LX - 0.15, maxX: s * LX + 0.15, minZ: -LZ, maxZ: -3 }, { minX: s * LX - 0.15, maxX: s * LX + 0.15, minZ: 3, maxZ: LZ });
  const bx = (A.x0 + A.x1) / 2 - s * 4;
  containerStack(ctx, bx, -15, r.int(1, 3), r, 'z');
  containerStack(ctx, bx, 15, r.int(1, 3), r, 'z');
  containerStack(ctx, bx - s * 3, 15, r.int(1, 2), r, 'z');
  // pallets, crates, drums and machines between the stacks, a forklift
  for (let i = 0; i < 8; i++) slot({ kind: 'freight', x: (A.x0 + A.x1) / 2 + s * r.range(2, 7), y: Y, z: -6 + (i % 4) * 4 + r.range(-0.5, 0.5), rot: r.range(0, 6), w: 2.4, d: 2.4, h: 2.6, min: 0.4, radius: 60, maxTris: 80_000 });
  for (let i = 0; i < 3; i++) slot({ kind: 'machine', x: bx - s * 3, y: Y, z: -12 + i * 5, rot: r.range(0, 6), w: 4, d: 3.5, h: 4, min: 0.8, radius: 90, maxTris: 150_000 });
  slot({ kind: 'truck', x: (A.x0 + A.x1) / 2 + s * 5, y: Y, z: 8, rot: 0, w: 9, d: 3.2, h: 4.5, min: 2.5, radius: 110, maxTris: 250_000 });
  sign(ctx, 'WEST SIDE FREIGHT · NO TRESPASSING', 0, CURB + 1.6, row * (LZ + 0.1), row > 0 ? 0 : Math.PI, 0.4, 14, '#c21f2a', 'paint');
  return { ave: s > 0 ? [true, false] : [false, true], rows: row > 0 ? [true, false] : [false, true], core: false };
}

// ---------------------------------------------------------------- greenmarket plaza

const CANVAS = ['#2f6b3a', '#2f6b3a', '#e8e4dc', '#b0342c', '#2a4f8a', '#d9a520'];
export function buildPlaza(ctx: BCtx, r: Rng): Plan {
  const slot = slotter(ctx);
  // the plaza block alternates with plain market streets
  if ((ctx.cx + ctx.cz) % 2 !== 0) return { ave: [true, true], rows: [true, true] };
  const row = r.chance(0.5) ? 1 : -1;
  const R = rowArea(row, 20);
  ctx.stat.add(slab(flat('#a29c90', 0.95), R.x0, R.x1, R.z0, R.z1, Y, 3));
  // two rows of stalls back to back along the plaza, open to the walkways
  const zc = (R.z0 + R.z1) / 2;
  let k = 0;
  for (const side of [-1, 1]) {
    for (let x = R.x0 + 3; x < R.x1 - 3; x += 4.2, k++) {
      const z = zc + side * 3.2;
      const ry = side > 0 ? 0 : Math.PI;
      stall(ctx.stat, x, CURB, z, ry, r.pick(CANVAS), 3.6, 2.4);
      ctx.colliders.push(rect(x, z, 3.6, 2.2));
      // produce and packaged goods on the table, crates under it
      const tz = z + side * 0.7;
      const kinds = r.chance(0.6) ? 'produce' : r.chance(0.5) ? 'packaged' : 'kitchen';
      for (let i = 0; i < 3; i++) slot({ kind: kinds, x: x - 1.1 + i * 1.1, y: CURB + 0.8, z: tz, rot: r.range(0, 6), w: 0.9, d: 0.8, h: 0.7, min: 0.04, radius: 45, maxTris: 40_000 }, false);
      if (k % 3 === 0) slot({ kind: 'freight', x: x + 1.3, y: CURB, z: z + side * 1.7, rot: r.range(0, 6), w: 0.9, d: 0.9, h: 1.0, min: 0.25, radius: 45, maxTris: 40_000 }, false);
    }
  }
  sign(ctx, 'GREENMARKET', 0, CURB + 3.3, row * (LZ + 0.2), row > 0 ? 0 : Math.PI, 0.7, 10, '#2f6b3a');
  return { ave: [true, true], rows: row > 0 ? [true, false] : [false, true], core: false };
}

// ---------------------------------------------------------------- museum mile

export function buildMuseum(ctx: BCtx, r: Rng): Plan {
  const slot = slotter(ctx);
  // the museum faces the park side (+x): a limestone palace set back behind steps and a plaza
  const s = 1;
  const bx0 = LX - 20, bx1 = LX - 10;
  building(ctx, { minX: bx0, maxX: bx1, minZ: -LZ, maxZ: LZ }, 'E', 'prewar', 6, false, [true, true], { material: 'limestone', cornice: 'modillion', fireEscape: 0, waterTower: 0, acUnits: 0 });
  const px0 = bx1, px1 = LX;
  ctx.stat.add(slab(flat('#c9c1b0', 0.85), px0, px1, -LZ, LZ, Y, 3));
  // grand steps up to the entrance
  for (let i = 0; i < 6; i++) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(5.5 - i * 0.6, 0.18 * (i + 1), 22), flat('#d4ccbb', 0.8));
    st.position.set(px0 + 2.75 - i * 0.3, CURB + 0.09 * (i + 1), 0);
    st.userData.owned = true;
    st.castShadow = true;
    ctx.stat.add(st);
  }
  ctx.colliders.push(rect(px0 + 2.7, 0, 5.5, 22));
  // banners between the columns
  const banner = ['#8c1d22', '#1d3b6b', '#c79a2c'];
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 7), flat(banner[i], 0.8));
    b.position.set(bx1 + 0.35, CURB + 8, -6 + i * 6);
    b.rotation.y = Math.PI / 2;
    b.userData.owned = true;
    ctx.stat.add(b);
    sign(ctx, ['ARMS & ARMOR', 'INSTRUMENTS', 'ARCHITECTURE'][i], bx1 + 0.37, CURB + 9, -6 + i * 6, Math.PI / 2, 0.32, 2, '#ffffff', 'paint');
  }
  // plinths on the plaza with the collection out on show
  const kinds = [['armour'], ['science'], ['arch'], ['armour', 'arch'], ['science', 'arch']];
  let k = 0;
  for (const z of [-19, -14, 14, 19]) {
    for (const x of [px0 + 2.5, px0 + 6.5]) {
      const pl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 1.6), flat('#bdb4a2', 0.8));
      pl.position.set(x, CURB + 0.5, z);
      pl.castShadow = true;
      pl.userData.owned = true;
      ctx.stat.add(pl);
      ctx.colliders.push(rect(x, z, 1.7, 1.7));
      slot({ kind: kinds[k++ % kinds.length], x, y: CURB + 1.0, z, rot: s * Math.PI / 2 + r.range(-0.4, 0.4), w: 1.5, d: 1.5, h: 2.6, min: 0.2, radius: 60, maxTris: 120_000 }, false);
    }
  }
  // fountains either side of the steps
  for (const z of [-9.5, 9.5]) {
    const f = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.6, 0.6, 24), flat('#b8af9d', 0.8));
    f.position.set(px0 + 6, CURB + 0.3, z * 1.0);
    f.userData.owned = true;
    ctx.stat.add(f);
    ctx.colliders.push(rect(px0 + 6, z, 5, 5));
  }
  return { ave: [true, false], rows: [true, true], core: false };
}
