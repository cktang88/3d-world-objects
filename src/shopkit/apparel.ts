import * as THREE from 'three';
import { mat } from '../build';
import { Rng } from '../rng';
import { Kit, M, glass, printed } from './kit';
import { textTex } from './tex';
import { bodegaCounter, showcase } from './fixtures';

/**
 * Fixtures for the clothing boutique and the café / diner (docs/research/shops.md, "Clothing" and "Café / diner"):
 * chrome garment rails with shirts and dresses hung side-on, folding tables of stacked tees, dress forms,
 * curtained fitting rooms, a cash wrap; an espresso bar with machine and grinder, a lit pastry case, café
 * tables with chairs, diner booths and stools at the counter. Static parts bake into a few meshes (garments
 * share one geometry per cut and one material per colour).
 */

// ---------------------------------------------------------------- garments

const geoCache = new Map<string, THREE.BufferGeometry>();
/** a garment hanging on its hanger, seen side-on in the rail's plane: the outline extruded a few cm */
function garmentGeo(cut: 'shirt' | 'dress' | 'coat' | 'pants') {
  let g = geoCache.get(cut);
  if (g) return g;
  const s = new THREE.Shape();
  // outline in (z, y): shoulders at the top (y = 0), hem at -len; z across the body, the rail runs along x
  const len = cut === 'dress' ? 1.05 : cut === 'coat' ? 0.95 : cut === 'pants' ? 0.9 : 0.72;
  const w = cut === 'pants' ? 0.2 : 0.24, sl = cut === 'pants' ? 0 : cut === 'dress' ? 0.05 : 0.09;
  const hem = cut === 'dress' ? w + 0.08 : w;
  s.moveTo(-0.07, 0);
  s.lineTo(-w - sl, -0.06);
  s.lineTo(-w - sl, -0.3);
  s.lineTo(-w, -0.28);
  s.lineTo(-hem, -len);
  s.lineTo(hem, -len);
  s.lineTo(w, -0.28);
  s.lineTo(w + sl, -0.3);
  s.lineTo(w + sl, -0.06);
  s.lineTo(0.07, 0);
  s.lineTo(-0.07, 0);
  g = new THREE.ExtrudeGeometry(s, { depth: cut === 'coat' ? 0.05 : 0.025, bevelEnabled: false });
  g.translate(0, 0, -(cut === 'coat' ? 0.025 : 0.0125));
  // the outline lies in x/y: turn it so it hangs across the rail (its width along z)
  g.rotateY(Math.PI / 2);
  geoCache.set(cut, g);
  return g;
}

const SEASON = [
  ['#1f2a44', '#f1ede4', '#8a1c2b', '#2f4f3a', '#c9b79c', '#111111', '#6d7b8a', '#e0b84a'],
  ['#f4f1ea', '#d9c9b0', '#a4b8c4', '#e7a9a0', '#2b2b2b', '#5a6b4e', '#c58f5e', '#3a4a6a'],
];

/**
 * A chrome garment rail (rack) `len` long at `h`: garments hung side-on every 6-8 cm, a colour story per run.
 * double: two rails (shirts high, pants low) on a wall run.
 */
export function garmentRack(k: Kit, len: number, r: Rng, o: { h?: number; double?: boolean; cut?: 'shirt' | 'dress' | 'coat'; wall?: boolean } = {}) {
  const h = o.h ?? 1.45, chrome = M.chrome();
  const rails = o.double ? [h + 0.45, h - 0.55] : [h];
  if (!o.wall) {
    // free-standing: two uprights on flat feet
    for (const x of [-len / 2, len / 2]) {
      k.box(chrome, 0.03, rails[0], 0.03, x, 0, 0);
      k.box(chrome, 0.04, 0.03, 0.5, x, 0, 0);
    }
  } else for (const x of [-len / 2 + 0.05, len / 2 - 0.05]) for (const y of rails) k.box(chrome, 0.04, 0.04, 0.32, x, y - 0.02, 0.16);
  // wall rails stand 32 cm out from the wall so the garments clear it
  const rz = o.wall ? 0.32 : 0;
  const pal = r.pick(SEASON);
  rails.forEach((y, ri) => {
    k.box(chrome, len, 0.025, 0.025, 0, y - 0.0125, rz);
    const cut = ri === 1 ? 'pants' : (o.cut ?? r.pick(['shirt', 'shirt', 'dress', 'coat'] as const));
    const g = garmentGeo(cut);
    const pitch = cut === 'coat' ? 0.09 : 0.065;
    const n = Math.floor((len - 0.15) / pitch);
    // a colour story: runs of a few garments in one colour, sizes graded
    let c = r.pick(pal), run = 0;
    for (let i = 0; i < n; i++) {
      if (run-- <= 0) {
        c = r.pick(pal);
        run = r.int(2, 6);
      }
      if (r.chance(0.06)) continue; // a gap where something sold
      const m = new THREE.Mesh(g, mat(c, { rough: 0.95 }));
      m.position.set(-len / 2 + 0.08 + i * pitch + r.range(-0.008, 0.008), y - 0.05, rz);
      m.rotation.y = r.range(-0.12, 0.12);
      m.castShadow = false;
      k.add(m);
    }
  });
  k.col(0, rz, len + 0.05, 0.55);
}

/** A folding table: stacks of folded tees and jeans, a few colourways each. */
export function foldTable(k: Kit, w: number, d: number, r: Rng) {
  const wood = mat(r.pick(['#d9c3a0', '#e8e2d6', '#3a2e24']), { rough: 0.6 });
  k.box(wood, w, 0.05, d, 0, 0.8, 0);
  k.box(wood, w - 0.1, 0.78, d - 0.1, 0, 0.02, 0);
  const pal = r.pick(SEASON);
  const sx = 0.32, sz = 0.26, cols = Math.max(1, Math.floor((w - 0.06) / (sx + 0.04))), rows = Math.max(1, Math.floor((d - 0.06) / (sz + 0.04)));
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const c = r.pick(pal), n = r.int(3, 7);
      const x = -w / 2 + 0.05 + (sx + 0.04) * (i + 0.5), z = -d / 2 + 0.05 + (sz + 0.04) * (j + 0.5);
      // one box per stack, folds read as darker lines on the side
      k.box(mat(c, { rough: 0.95 }), sx, n * 0.028, sz, x + r.range(-0.01, 0.01), 0.85, z);
      for (let f = 1; f < n; f++) k.box(mat(shadeHex(c, 0.75), { rough: 1 }), sx + 0.002, 0.003, sz + 0.002, x, 0.85 + f * 0.028, z);
    }
  k.col(0, 0, w + 0.05, d + 0.05);
}

function shadeHex(hex: string, k: number) {
  return '#' + new THREE.Color(hex).multiplyScalar(k).getHexString();
}

/** A dress form on a stand, wearing a garment (or a blank form). */
export function mannequin(k: Kit, r: Rng, o: { blank?: boolean } = {}) {
  const form = mat(r.pick(['#f1efe9', '#1c1c1c', '#c9b79c']), { rough: 0.6 });
  const wear = mat(r.pick(r.pick(SEASON)), { rough: 0.95 });
  k.box(M.chrome(), 0.3, 0.02, 0.3, 0, 0, 0); // base
  k.cyl(M.chrome(), 0.012, 0.9, 0, 0.02, 0);
  // torso: hips, waist, chest as stacked ellipsoids; neck and shoulder cap
  k.sph(o.blank ? form : wear, 0.17, 0.13, 0.12, 0, 1.0, 0);
  k.sph(o.blank ? form : wear, 0.14, 0.12, 0.1, 0, 1.18, 0);
  k.sph(o.blank ? form : wear, 0.19, 0.16, 0.12, 0, 1.36, 0);
  k.cyl(form, 0.045, 0.12, 0, 1.48, 0);
  k.sph(form, 0.06, 0.03, 0.06, 0, 1.6, 0);
  if (!o.blank && r.chance(0.6)) k.sph(wear, 0.2, 0.32, 0.14, 0, 0.78, 0); // a skirt / coat hem
  k.col(0, 0, 0.45, 0.4);
}

/** A row of curtained fitting rooms against the back wall, with a mirror and a sign. */
export function fittingRooms(k: Kit, n: number, r: Rng) {
  const w = 1.0, d = 1.2, h = 2.2;
  const wall = mat(r.pick(['#efe9df', '#e4e6e8', '#2d2b2a']), { rough: 0.8 });
  const cur = mat(r.pick(['#5b2333', '#24344d', '#c9b79c', '#2f4f3a']), { rough: 1 });
  for (let i = 0; i <= n; i++) k.box(wall, 0.05, h, d, -(n * w) / 2 + i * w, 0, -d / 2);
  k.box(wall, n * w + 0.05, 0.05, d, 0, h, -d / 2);
  for (let i = 0; i < n; i++) {
    const x = -(n * w) / 2 + w * (i + 0.5);
    // curtain half drawn, on a rod; a stool and a mirror inside
    k.box(M.chrome(), w, 0.02, 0.02, x, h - 0.1, 0.0);
    const open = r.range(0.3, 0.7);
    k.box(cur, w * (1 - open), h - 0.25, 0.04, x - (w * open) / 2, 0.15, 0.0);
    k.box(mat('#9fb4c0', { rough: 0.05, metal: 0.9 }), 0.4, 1.3, 0.01, x, 0.5, -d + 0.02);
    k.box(mat('#3a2e24'), 0.35, 0.45, 0.35, x + 0.2, 0, -d + 0.35);
  }
  k.face(printed(textTex('FITTING ROOMS', '#ffffff', '#1c1c1c', { w: 512, h: 96 })), 1.2, 0.22, 0, h + 0.18, 0.03);
  k.col(0, -d / 2, n * w + 0.1, d + 0.05);
}

/** The cash wrap: a long counter with register, card reader, tissue and bags. */
export function cashWrap(k: Kit, len: number, r: Rng) {
  bodegaCounter(k, len, r, { color: r.pick(['#1c1c1c', '#e8e2d6', '#3a2e24']), top: r.pick(['#f4f1ea', '#c9b79c', '#1c1c1c']) });
  const bag = mat(r.pick(['#f4f1ea', '#1c1c1c', '#c9b79c']), { rough: 0.9 });
  for (let i = 0; i < 4; i++) k.box(bag, 0.32, 0.38, 0.1, len / 2 - 0.4, 0.58, -0.12 + i * 0.002);
  k.box(mat('#f7f2ea', { rough: 1 }), 0.4, 0.05, 0.3, 0.1, 1.02, -0.1); // tissue paper
}

// ---------------------------------------------------------------- café / diner

/** Espresso bar: counter, two-group espresso machine with portafilters, grinder, cups on top, cake stands. */
export function espressoBar(k: Kit, len: number, r: Rng, o: { diner?: boolean } = {}) {
  bodegaCounter(k, len, r, { color: o.diner ? '#c62828' : r.pick(['#3a2e24', '#1f2a44', '#e8e2d6']), top: o.diner ? '#e8e8e4' : r.pick(['#f1ede4', '#2b2b2b']) });
  const steel = M.steel();
  // the machine sits on the back counter facing the barista, its chrome face to the room
  const mx = len / 2 - 0.7;
  k.box(steel, 0.75, 0.42, 0.5, mx, 1.02, -0.05);
  k.box(M.chrome(), 0.77, 0.03, 0.52, mx, 1.44, -0.05);
  for (const gx of [-0.18, 0.18]) {
    k.box(M.black(), 0.06, 0.05, 0.16, mx + gx, 1.2, 0.25);
    k.box(M.chrome(), 0.08, 0.06, 0.08, mx + gx, 1.24, 0.22);
  }
  for (let i = 0; i < 8; i++) k.cyl(M.white(), 0.04, 0.07, mx - 0.3 + (i % 4) * 0.1, 1.47, -0.18 + Math.floor(i / 4) * 0.1);
  // grinder
  k.box(M.black(), 0.2, 0.36, 0.25, mx - 0.6, 1.02, -0.05);
  k.cyl(glass(), 0.08, 0.18, mx - 0.6, 1.38, -0.05);
  // tip jar and a cake stand at the other end
  k.cyl(glass(), 0.06, 0.15, -len / 2 + 0.9, 1.02, 0.15);
  k.cyl(M.white(), 0.16, 0.12, -len / 2 + 0.5, 1.02, 0.1);
  k.sph(mat(r.pick(['#6b3e26', '#f2e2c4', '#c96f8a']), { rough: 0.8 }), 0.13, 0.08, 0.13, -len / 2 + 0.5, 1.2, 0.1);
}

/** Lit pastry case: a glass showcase whose goods come from the food pools. */
export function pastryCase(k: Kit, len: number) {
  showcase(k, len, { frame: '#e8e2d6', h: 1.1 });
}

/** Café table (round, pedestal) with 2-4 chairs, or a square diner table. */
export function cafeTable(k: Kit, r: Rng, o: { seats?: number; square?: boolean; diner?: boolean } = {}) {
  const top = mat(o.diner ? '#e8e8e4' : r.pick(['#f1ede4', '#3a2e24', '#c9b79c', '#2b2b2b']), { rough: 0.45 });
  const base = M.black();
  const seats = o.seats ?? r.pick([2, 2, 4]);
  if (o.square) k.box(top, 0.75, 0.035, 0.75, 0, 0.72, 0);
  else k.cyl(top, 0.36, 0.035, 0, 0.72, 0);
  k.cyl(base, 0.03, 0.72, 0, 0, 0);
  k.cyl(base, 0.22, 0.02, 0, 0, 0);
  const chair = mat(o.diner ? '#c62828' : r.pick(['#3a2e24', '#1c1c1c', '#7a5a3a', '#2f4f3a']), { rough: 0.6 });
  for (let i = 0; i < seats; i++) {
    const a = (i / seats) * Math.PI * 2 + (seats === 2 ? Math.PI / 2 : Math.PI / 4);
    const x = Math.cos(a) * 0.62, z = Math.sin(a) * 0.62;
    // seat, four legs, back toward the outside
    k.box(chair, 0.42, 0.04, 0.42, x, 0.45, z);
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(base, 0.025, 0.45, 0.025, x + lx * 0.18, 0, z + lz * 0.18);
    const bx = x + Math.cos(a) * 0.2, bz = z + Math.sin(a) * 0.2;
    const back = k.box(chair, 0.42, 0.42, 0.03, bx, 0.49, bz);
    back.rotation.y = -a + Math.PI / 2;
  }
  // a cup and saucer, sometimes a plate
  k.cyl(M.white(), 0.04, 0.08, 0.12, 0.755, 0.05);
  if (r.chance(0.5)) k.cyl(M.white(), 0.11, 0.015, -0.12, 0.755, -0.05);
  k.col(0, 0, 1.6, 1.6);
}

/** A diner booth against a wall: two padded benches facing across a table, a lamp over it. */
export function booth(k: Kit, r: Rng) {
  const vinyl = mat(r.pick(['#b71c1c', '#c62828', '#1f4e79', '#2f4f3a']), { rough: 0.4 });
  const trim = M.chrome();
  // runs out from the wall along local +z: bench, table, bench
  for (const z of [0.3, 1.6]) {
    k.box(vinyl, 1.2, 0.45, 0.55, 0, 0, z);
    k.box(vinyl, 1.2, 0.6, 0.12, 0, 0.45, z + (z < 1 ? -0.22 : 0.22));
    k.box(trim, 1.2, 0.03, 0.02, 0, 0.45, z + (z < 1 ? 0.27 : -0.27));
  }
  k.box(mat('#e8e8e4', { rough: 0.35 }), 1.1, 0.04, 0.7, 0, 0.74, 0.95);
  k.box(trim, 1.12, 0.02, 0.72, 0, 0.72, 0.95);
  k.cyl(M.black(), 0.04, 0.72, 0, 0, 0.95);
  // napkin dispenser, ketchup and mustard
  k.box(M.chrome(), 0.1, 0.12, 0.06, 0.35, 0.78, 0.95);
  k.cyl(mat('#c62828', { rough: 0.4 }), 0.025, 0.17, 0.2, 0.78, 0.95);
  k.cyl(mat('#f2c400', { rough: 0.4 }), 0.025, 0.17, 0.25, 0.78, 1.0);
  k.col(0, 0.95, 1.25, 2.0);
}

/** Counter stools in a row in front of a counter. */
export function stools(k: Kit, n: number, gap: number, r: Rng) {
  const seat = mat(r.pick(['#b71c1c', '#1c1c1c', '#3a2e24']), { rough: 0.45 });
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * gap;
    k.cyl(M.chrome(), 0.025, 0.7, x, 0, 0);
    k.cyl(M.chrome(), 0.17, 0.02, x, 0, 0);
    k.cyl(seat, 0.19, 0.08, x, 0.7, 0);
  }
  k.col(0, 0, (n - 1) * gap + 0.45, 0.45);
}

