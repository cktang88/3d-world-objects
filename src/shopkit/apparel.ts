import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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

type Cut = 'shirt' | 'dress' | 'coat' | 'pants';
const geoCache = new Map<string, THREE.BufferGeometry>();
/** half outline (x >= 0, top to hem) of each cut, shoulders at y = 0; mirrored for the left half */
const OUTLINE: Record<Cut, [number, number][]> = {
  // neck, sloped shoulder, sleeve hanging down beside the body, armpit, body side, hem
  shirt: [[0.06, 0.0], [0.2, -0.045], [0.27, -0.2], [0.3, -0.56], [0.245, -0.57], [0.215, -0.24], [0.21, -0.5], [0.225, -0.72]],
  coat: [[0.07, 0.0], [0.23, -0.05], [0.31, -0.22], [0.34, -0.64], [0.27, -0.65], [0.24, -0.26], [0.245, -0.6], [0.27, -0.96]],
  // straps, armhole, waist, flared skirt
  dress: [[0.06, 0.0], [0.11, -0.01], [0.17, -0.2], [0.14, -0.42], [0.2, -0.7], [0.3, -1.04]],
  // trousers folded over the hanger bar: a short tube, slightly wider at the fold
  pants: [[0.2, -0.01], [0.19, -0.2], [0.175, -0.5]],
};
const THICK: Record<Cut, number> = { shirt: 0.04, coat: 0.07, dress: 0.04, pants: 0.05 };
/** length (shoulder to hem) of each cut */
export const CUT_LEN: Record<Cut, number> = { shirt: 0.72, coat: 0.96, dress: 1.04, pants: 0.5 };

/**
 * A garment on its hanger, in its own plane (x across the body, y down from the shoulders, z thickness):
 * a soft-edged extrusion of the outline whose front and back are pushed into a few vertical folds and whose
 * hem swings, normals smoothed so the folds read in raking light. Face-out garments use it as is;
 * side-hung ones turn it a quarter about y.
 */
function garmentGeo(cut: Cut, side: boolean) {
  const key = cut + (side ? '|s' : '|f');
  let g = geoCache.get(key);
  if (g) return g;
  const half = OUTLINE[cut];
  const s = new THREE.Shape();
  const pts: [number, number][] = [...half, ...half.slice().reverse().map(([x, y]) => [-x, y] as [number, number])];
  s.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) s.lineTo(x, y);
  s.closePath();
  const t = THICK[cut];
  let e: THREE.BufferGeometry = new THREE.ExtrudeGeometry(s, { depth: t * 0.4, bevelEnabled: true, bevelThickness: t * 0.3, bevelSize: 0.012, bevelSegments: 1, curveSegments: 2 });
  e.translate(0, 0, -t * 0.2);
  e.deleteAttribute('uv');
  e.deleteAttribute('normal');
  e = mergeVertices(e, 1e-4);
  const p = e.attributes.position as THREE.BufferAttribute;
  const len = CUT_LEN[cut];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const d = Math.min(1, -y / len);
    // folds: deeper toward the hem; the hem swings forward a little; the chest is fuller than the hem
    const fold = Math.sin(x * 26 + 1.3) * 0.009 * (0.3 + d);
    p.setXYZ(i, x * (1 + 0.04 * Math.sin(y * 9)), y, z * (1.15 - 0.35 * d) + fold + 0.02 * d * d);
  }
  e.computeVertexNormals();
  if (side) e.rotateY(Math.PI / 2);
  geoCache.set(key, e);
  return e;
}

let hangerGeo: THREE.BufferGeometry | null = null;
/** a hook over the rail and the hanger's shoulder bar, one merged geometry (rail at y = 0, garment plane x/y) */
function hanger() {
  if (hangerGeo) return hangerGeo;
  const parts = [
    new THREE.BoxGeometry(0.005, 0.05, 0.005).translate(0, -0.005, 0),
    new THREE.BoxGeometry(0.005, 0.005, 0.03).translate(0, 0.02, -0.012),
    new THREE.BoxGeometry(0.4, 0.012, 0.012).translate(0, -0.06, 0),
  ];
  hangerGeo = mergeGeometries(parts)!;
  return hangerGeo;
}

const SEASON = [
  ['#1f2a44', '#f1ede4', '#8a1c2b', '#2f4f3a', '#c9b79c', '#111111', '#6d7b8a', '#e0b84a'],
  ['#f4f1ea', '#d9c9b0', '#a4b8c4', '#e7a9a0', '#2b2b2b', '#5a6b4e', '#c58f5e', '#3a4a6a'],
  ['#e9e4da', '#b5653b', '#556b2f', '#d8b26e', '#3b3b45', '#8c2f39', '#c7c2b8', '#7a8c99'],
];
const HANGER = ['#e4e6ea', '#6b4a2f', '#1c1c1c'];

/** colour runs: a few garments in one colour, then the next */
function colourRuns(r: Rng, pal: string[]) {
  let c = r.pick(pal), run = 0;
  return () => {
    if (run-- <= 0) {
      c = r.pick(pal);
      run = r.int(2, 6);
    }
    return c;
  };
}

/** one hung garment: hanger on the rail at (x, y, z), garment below it; side = hung side-on along a rail on x */
function hang(k: Kit, cut: Cut, c: string, hm: THREE.Material, x: number, y: number, z: number, side: boolean, ry: number, r: Rng) {
  const hk = new THREE.Mesh(hanger(), hm);
  hk.position.set(x, y, z);
  hk.rotation.y = ry + (side ? Math.PI / 2 : 0);
  k.add(hk);
  const m = new THREE.Mesh(garmentGeo(cut, side), mat(c, { rough: 0.95 }));
  m.position.set(x, y - 0.07, z);
  m.rotation.set(side ? 0 : r.range(-0.03, 0.03), ry + r.range(-0.1, 0.1), side ? r.range(-0.04, 0.04) : 0);
  k.add(m);
}

/** a stack of folded clothes w x d, n layers, folds as darker lines */
export function foldedStack(k: Kit, c: string, w: number, d: number, n: number, x: number, y: number, z: number) {
  k.box(mat(c, { rough: 0.95 }), w, n * 0.028, d, x, y, z);
  const fold = mat(shadeHex(c, 0.72), { rough: 1 });
  for (let f = 1; f < n; f++) k.box(fold, w + 0.003, 0.004, d + 0.003, x, y + f * 0.028, z);
}

/**
 * A chrome garment rail (rack) `len` long at `h`: garments side-hung on hangers, mixed lengths in colour
 * runs. wall: brackets to the wall, rails 32 cm out, a face-out arm every ~2.4 m showing shirts and coats
 * front-on, and (shelf) a shelf of folded stacks above. double: two rails (tops high, folded pants low).
 */
export function garmentRack(k: Kit, len: number, r: Rng, o: { h?: number; double?: boolean; cut?: Cut; wall?: boolean; shelf?: boolean } = {}) {
  const h = o.h ?? 1.45, chrome = M.chrome();
  const rails = o.double ? [h + 0.45, h - 0.5] : [h];
  if (!o.wall) {
    // free-standing: two uprights on flat feet
    for (const x of [-len / 2, len / 2]) {
      k.box(chrome, 0.03, rails[0], 0.03, x, 0, 0);
      k.box(chrome, 0.04, 0.03, 0.5, x, 0, 0);
    }
  } else for (const x of [-len / 2 + 0.05, len / 2 - 0.05]) for (const y of rails) k.box(chrome, 0.04, 0.04, 0.32, x, y - 0.02, 0.16);
  // wall rails stand 32 cm out from the wall so the garments clear it
  const rz = o.wall ? 0.32 : 0;
  const pal = r.pick(SEASON), hm = mat(r.pick(HANGER), { rough: 0.4, metal: 0.3 });
  // face-out bays (wall racks): 0.62 m gaps in the side-hung run with an arm and three garments facing out
  const bays: number[] = [];
  if (o.wall) for (let x = -len / 2 + 1.4; x < len / 2 - 0.9; x += r.range(2.2, 2.8)) bays.push(x);
  const inBay = (x: number) => bays.some((b) => Math.abs(x - b) < 0.36);
  rails.forEach((y, ri) => {
    k.box(chrome, len, 0.025, 0.025, 0, y - 0.0125, rz);
    const low = ri === 1;
    // over a lower rail only tops fit; a single rail mixes lengths
    const cuts: Cut[] = low ? ['pants'] : o.double ? ['shirt'] : o.cut ? [o.cut, o.cut, 'shirt'] : ['shirt', 'shirt', 'dress', 'coat', 'coat'];
    const next = colourRuns(r, pal);
    let x = -len / 2 + 0.08;
    let cut = r.pick(cuts), runCut = r.int(4, 10);
    while (x < len / 2 - 0.06) {
      if (runCut-- <= 0) {
        cut = r.pick(cuts);
        runCut = r.int(4, 10);
      }
      if (!low && inBay(x)) {
        x += 0.05;
        continue;
      }
      if (!r.chance(0.07)) hang(k, cut, next(), hm, x + r.range(-0.006, 0.006), y, rz, true, r.range(-0.1, 0.1), r);
      x += THICK[cut] + r.range(0.012, 0.03);
    }
    if (!low)
      for (const b of bays) {
        // arm from the wall, garments front-on, the front one fully visible
        k.box(chrome, 0.025, 0.025, 0.55, b, y - 0.0125, 0.275);
        const fc: Cut = o.double ? 'shirt' : r.pick(['shirt', 'coat', 'dress']), c = r.pick(pal);
        for (let i = 0; i < 3; i++) hang(k, fc, i === 2 ? c : r.pick(pal), hm, b, y, 0.3 + i * 0.07, false, 0, r);
      }
  });
  if (o.wall && o.shelf) {
    // a shelf of folded stacks above the rails, on brackets
    const sy = rails[0] + 0.32;
    const wood = mat(r.pick(['#e8e2d6', '#3a2e24', '#d9c3a0']), { rough: 0.6 });
    k.box(wood, len, 0.03, 0.4, 0, sy, 0.2);
    for (let x = -len / 2 + 0.3; x < len / 2; x += 1.2) k.box(M.dark(), 0.02, 0.15, 0.3, x, sy - 0.15, 0.15);
    const next = colourRuns(r, pal);
    for (let x = -len / 2 + 0.22; x < len / 2 - 0.2; x += 0.36) if (!r.chance(0.1)) foldedStack(k, next(), 0.3, 0.27, r.int(3, 8), x + r.range(-0.02, 0.02), sy + 0.03, 0.2);
  }
  k.col(0, rz, len + 0.05, 0.55);
}

/** A round rack: a chrome ring on a pedestal, garments side-hung all round. */
export function roundRack(k: Kit, r: Rng, o: { h?: number; cut?: Cut } = {}) {
  const h = o.h ?? 1.3, R = 0.48, chrome = M.chrome();
  k.cyl(chrome, 0.3, 0.02, 0, 0, 0);
  k.cyl(chrome, 0.022, h, 0, 0, 0);
  for (const a of [0, Math.PI / 2]) {
    const arm = k.box(chrome, 2 * R, 0.02, 0.02, 0, h - 0.04, 0);
    arm.rotation.y = a;
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.011, 6, 40), chrome);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0, h, 0);
  k.add(ring);
  const pal = r.pick(SEASON), hm = mat(r.pick(HANGER), { rough: 0.4, metal: 0.3 });
  const cut: Cut = o.cut ?? r.pick(['shirt', 'shirt', 'dress', 'coat']);
  const next = colourRuns(r, pal);
  const n = Math.floor((2 * Math.PI * R) / (THICK[cut] + 0.03));
  for (let i = 0; i < n; i++) {
    if (r.chance(0.08)) continue;
    const a = (i / n) * Math.PI * 2;
    // the garment's plane runs radially, its thickness along the ring
    hang(k, cut, next(), hm, Math.cos(a) * R, h, Math.sin(a) * R, false, -a, r);
  }
  k.col(0, 0, 1.5, 1.5);
}

/** A full-length mirror in a frame, flat on a wall (local +z out of the wall). */
export function mirror(k: Kit, r: Rng) {
  const fr = mat(r.pick(['#1c1c1c', '#b08a5a', '#c9a227']), { rough: 0.4, metal: 0.5 });
  k.box(fr, 0.66, 1.9, 0.04, 0, 0.1, 0);
  k.box(mat('#dfe6ea', { rough: 0.02, metal: 1 }), 0.58, 1.82, 0.01, 0, 0.14, 0.022);
  k.col(0, 0.03, 0.7, 0.08);
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
      foldedStack(k, c, sx, sz, n, x + r.range(-0.01, 0.01), 0.85, z);
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
  if (o.diner) {
    // a diner pours from the urns on the back-bar: the counter carries a pie case, a cake stand and condiments
    pieCase(k, 1.02, r);
    k.cyl(M.white(), 0.02, 0.12, len / 2 - 0.5, 1.02, 0.08);
    k.cyl(M.white(), 0.16, 0.015, len / 2 - 0.5, 1.14, 0.08);
    k.cyl(mat(r.pick(['#6b3e26', '#f2e2c4', '#c96f8a']), { rough: 0.8 }), 0.12, 0.1, len / 2 - 0.5, 1.155, 0.08);
    k.sph(glass(), 0.15, 0.19, 0.15, len / 2 - 0.5, 1.155, 0.08);
    for (let x = -len / 2 + 1.1; x < len / 2 - 0.8; x += 1.5) if (Math.abs(x) > 0.5) condiments(k, x, 1.02, 0.2, true);
    return;
  }
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
  // a cup and saucer, sometimes a plate; sugar (and at a diner ketchup, mustard, napkins)
  k.cyl(M.white(), 0.04, 0.08, 0.12, 0.755, 0.12);
  if (r.chance(0.5)) k.cyl(M.white(), 0.11, 0.015, -0.12, 0.755, 0.1);
  condiments(k, o.diner ? 0.02 : 0.1, 0.755, -0.14, !!o.diner);
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
  // napkin dispenser, ketchup, mustard, sugar, salt and pepper at one end of the table
  condiments(k, 0.35, 0.78, 0.95, true);
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


// ---------------------------------------------------------------- café / diner dressing

/** a sugar pourer and salt and pepper (café); plus napkin dispenser, ketchup and mustard (diner) */
export function condiments(k: Kit, x: number, y: number, z: number, diner: boolean) {
  if (diner) {
    k.box(M.chrome(), 0.1, 0.13, 0.07, x, y, z);
    k.box(M.white(), 0.08, 0.005, 0.072, x, y + 0.08, z);
    k.cyl(mat('#c62828', { rough: 0.35 }), 0.025, 0.17, x + 0.1, y, z - 0.02);
    k.cyl(mat('#f2c400', { rough: 0.35 }), 0.025, 0.17, x + 0.1, y, z + 0.04);
  }
  // sugar pourer: glass, sugar, chrome cap; salt and pepper
  k.cyl(glass(), 0.032, 0.11, x - 0.1, y, z);
  k.cyl(M.white(), 0.028, 0.07, x - 0.1, y + 0.002, z);
  k.cyl(M.chrome(), 0.033, 0.03, x - 0.1, y + 0.11, z);
  k.cyl(M.white(), 0.014, 0.05, x - 0.16, y, z + 0.03);
  k.cyl(M.dark(), 0.014, 0.05, x - 0.16, y, z - 0.01);
}

/** a pie case on a counter top at height y: chrome-framed glass box, two shelves of pies */
export function pieCase(k: Kit, y: number, r: Rng) {
  const W = 0.6, D = 0.42, Hh = 0.52, fr = M.chrome();
  k.box(fr, W, 0.03, D, 0, y, 0);
  k.box(fr, W, 0.02, D, 0, y + Hh, 0);
  for (const x of [-W / 2, W / 2]) for (const z of [-D / 2, D / 2]) k.box(fr, 0.015, Hh, 0.015, x, y, z);
  k.box(glass(), W - 0.02, 0.006, D - 0.02, 0, y + 0.27, 0);
  for (const sy of [y + 0.03, y + 0.276])
    for (const sx of [-0.14, 0.14]) {
      k.cyl(mat('#c98c4a', { rough: 0.8 }), 0.11, 0.04, sx, sy, 0);
      k.cyl(mat(r.pick(['#8e1b2b', '#f2dc7a', '#3b3f8f', '#d9a066', '#f4efe2']), { rough: 0.5 }), 0.095, 0.006, sx, sy + 0.04, 0);
    }
  k.box(glass(), W, Hh, 0.004, 0, y, D / 2);
  k.box(glass(), W, Hh, 0.004, 0, y, -D / 2);
  for (const x of [-W / 2, W / 2]) k.box(glass(), 0.004, Hh, D, x, y, 0);
}

/**
 * Diner back-bar against the back wall (local +z into the room): a steel-topped cabinet with twin coffee
 * urns, a carafe warmer, a milkshake mixer with steel cups, a cake under a glass dome, cups stacked.
 */
export function dinerBackBar(k: Kit, len: number, r: Rng) {
  const D = 0.62, T = 0.92;
  k.box(mat('#bfc3c7', { rough: 0.35, metal: 0.7 }), len, T - 0.04, D, 0, 0, D / 2);
  k.box(M.steel(), len + 0.04, 0.04, D + 0.02, 0, T - 0.04, D / 2);
  for (let x = -len / 2 + 0.6; x < len / 2 - 0.3; x += 0.6) k.box(M.dark(), 0.01, 0.7, 0.006, x, 0.1, D + 0.001);
  // twin coffee urns on legs with sight glasses and spouts
  for (const ux of [len / 2 - 0.35, len / 2 - 0.8]) {
    for (const lx of [-0.1, 0.1]) k.cyl(M.black(), 0.012, 0.08, ux + lx, T, 0.3);
    k.cyl(M.steel(), 0.17, 0.55, ux, T + 0.08, 0.3);
    k.sph(M.chrome(), 0.17, 0.06, 0.17, ux, T + 0.63, 0.3);
    k.cyl(M.black(), 0.03, 0.05, ux, T + 0.68, 0.3);
    k.box(mat('#4a2e1a', { rough: 0.15 }), 0.016, 0.38, 0.01, ux - 0.06, T + 0.14, 0.47);
    k.box(M.black(), 0.04, 0.05, 0.08, ux, T + 0.12, 0.5);
  }
  // carafe warmer: one regular, one decaf (orange lid)
  const wx = len / 2 - 1.45;
  k.box(M.black(), 0.55, 0.06, 0.26, wx, T, 0.35);
  ['#1c1c1c', '#e65100'].forEach((lid, i) => {
    const x = wx - 0.13 + i * 0.26;
    k.cyl(mat('#3b2414', { rough: 0.2 }), 0.068, 0.09, x, T + 0.06, 0.35);
    k.cyl(glass(), 0.075, 0.19, x, T + 0.06, 0.35);
    k.cyl(mat(lid, { rough: 0.4 }), 0.05, 0.04, x, T + 0.25, 0.35);
  });
  // milkshake mixer: base, column, head, three spindles, steel cups
  const mx = -len / 2 + 0.45, body = mat(r.pick(['#6aa88f', '#d8d2c0', '#c62828']), { rough: 0.3 });
  k.box(body, 0.36, 0.06, 0.22, mx, T, 0.3);
  k.box(body, 0.08, 0.55, 0.08, mx, T + 0.06, 0.2);
  k.box(body, 0.38, 0.1, 0.18, mx, T + 0.55, 0.28);
  for (const sx of [-0.12, 0, 0.12]) {
    k.cyl(M.chrome(), 0.005, 0.2, mx + sx, T + 0.35, 0.33);
    if (sx !== 0) k.cyl(M.steel(), 0.045, 0.18, mx + sx, T + 0.06, 0.33);
  }
  // cake under a glass dome
  const cx = -len / 2 + 1.1;
  k.cyl(M.white(), 0.02, 0.1, cx, T, 0.3);
  k.cyl(M.white(), 0.16, 0.015, cx, T + 0.1, 0.3);
  k.cyl(mat(r.pick(['#6b3e26', '#f2e2c4', '#c96f8a']), { rough: 0.8 }), 0.12, 0.11, cx, T + 0.115, 0.3);
  k.sph(glass(), 0.15, 0.2, 0.15, cx, T + 0.115, 0.3);
  // cups stacked upside down
  for (let i = 0; i < 6; i++) k.cyl(M.white(), 0.04, 0.07, cx + 0.35 + (i % 3) * 0.09, T + Math.floor(i / 3) * 0.07, 0.42);
  k.col(0, D / 2, len + 0.04, D + 0.02);
}

const photoTexs = new Map<string, THREE.Texture>();
/** a small matted photograph: old black-and-white or sepia street scenes, or a colour shot of a plate */
function photoTex(seed: number, food: boolean) {
  const key = `${seed}|${food}`;
  let t = photoTexs.get(key);
  if (t) return t;
  const r = new Rng(seed);
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 104;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f1ea';
  g.fillRect(0, 0, 128, 104);
  const x0 = 12, y0 = 12, w = 104, h = 80;
  if (food) {
    g.fillStyle = r.pick(['#7a2a1a', '#2f4f3a', '#e0c9a0', '#1f2a44']);
    g.fillRect(x0, y0, w, h);
    g.fillStyle = '#f7f5f0';
    g.beginPath();
    g.ellipse(64, 54, 38, 28, 0, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 5; i++) {
      g.fillStyle = r.pick(['#c98c4a', '#8e1b2b', '#6b8e23', '#f2c400', '#6b3e26']);
      g.beginPath();
      g.ellipse(64 + r.range(-18, 18), 54 + r.range(-12, 12), r.range(6, 16), r.range(5, 11), r.range(0, 3), 0, Math.PI * 2);
      g.fill();
    }
  } else {
    const sepia = r.chance(0.5);
    const tone = (v: number) => (sepia ? `rgb(${v + 20},${v + 8},${v - 10})` : `rgb(${v},${v},${v})`);
    const sky = g.createLinearGradient(0, y0, 0, y0 + h);
    sky.addColorStop(0, tone(210));
    sky.addColorStop(1, tone(170));
    g.fillStyle = sky;
    g.fillRect(x0, y0, w, h);
    for (let x = x0; x < x0 + w; ) {
      const bw = Math.min(r.range(10, 26), x0 + w - x), bh = r.range(25, 72);
      g.fillStyle = tone(Math.floor(r.range(60, 130)));
      g.fillRect(x, y0 + h - bh, bw, bh);
      g.fillStyle = tone(190);
      for (let wy = y0 + h - bh + 4; wy < y0 + h - 14; wy += 7) for (let wx = x + 2; wx < x + bw - 3; wx += 5) if (r.chance(0.5)) g.fillRect(wx, wy, 2, 3);
      x += bw;
    }
    g.fillStyle = tone(90);
    g.fillRect(x0, y0 + h - 10, w, 10);
  }
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  photoTexs.set(key, t);
  return t;
}

/** a row of framed photos along local x on a wall (local +z out of the wall), centred at height y */
export function framedPhotos(k: Kit, len: number, y: number, r: Rng, o: { food?: number; frame?: string } = {}) {
  const fr = mat(o.frame ?? r.pick(['#1c1c1c', '#6b4a2f', '#c9a227']), { rough: 0.45, metal: 0.2 });
  for (let x = -len / 2 + 0.4; x < len / 2 - 0.3; x += r.range(0.7, 1.0)) {
    const w = r.range(0.32, 0.5), h = w * 0.8, yy = y + r.range(-0.12, 0.12);
    k.box(fr, w + 0.04, h + 0.04, 0.025, x, yy - h / 2 - 0.02, 0.0125);
    k.face(printed(photoTex(r.int(0, 23), r.chance(o.food ?? 0.3)), { rough: 0.4 }), w, h, x, yy, 0.0255);
  }
}

/** a neon script sign on a wall (local +z out of it): glowing letters and outline on a dark backer */
export function neonSign(k: Kit, text: string, color: string, w: number, y: number) {
  const h = w / 4;
  k.box(mat('#141414', { rough: 0.6 }), w + 0.1, h + 0.08, 0.02, 0, y - h / 2 - 0.04, 0.0);
  const t = textTex(text, '', color, { w: 1024, h: 256, font: 'italic bold 170px Georgia, serif', border: color });
  k.face(printed(t, { transparent: true, emissive: 3 }), w, h, 0, y, 0.022);
}
