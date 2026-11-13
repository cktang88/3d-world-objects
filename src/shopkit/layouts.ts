import * as THREE from 'three';
import type { Env } from '../level';
import { mat } from '../build';
import { surface } from '../pbr';
import { Rng } from '../rng';
import { Kit, lit, surfMat } from './kit';
import { textTex, vctTile } from './tex';
import * as F from './fixtures';
import * as A from './apparel';
import { retailBays, type RetailPlan } from './rows';

/**
 * One layout per kind of shop, after the reference photos in docs/research/shops.md.
 * Room: x in [-W/2, W/2], z from the back wall (-D/2) to the shop front (+D/2); walls'
 * inner faces are at those bounds.
 */
export interface Surface {
  m: THREE.Material;
  /** metres per UV unit; defaults to the whole face */
  tile?: [number, number];
}
export interface Style {
  W: number;
  D: number;
  H: number;
  ceil: 'drop' | 'tin' | 'exposed' | 'plain';
  tin?: string;
  ceilColor?: string;
  floor: Surface;
  wall: Surface;
  trim?: string;
  env: Partial<Env>;
  /** a layout's own variant (cafe: 'diner' | 'cafe') */
  variant?: string;
  banner?: boolean;
  bannerX?: number;
  neon?: boolean;
  /** a stockroom behind a door in a side wall (side -1 left, 1 right), `back` metres from the back wall */
  stockroom?: { side: -1 | 1; back: number };
}
export interface Ctx {
  doorX: number;
  name: string;
  color: string;
  plan?: RetailPlan;
}
export interface Layout {
  /** name: the shop's sign, for layouts whose variant must match it (a DINER is a diner) */
  style(r: Rng, name?: string): Style;
  door?(W: number, r: Rng): number;
  /** a generator: yields between fixtures so a shop can be built a slice per frame */
  build(k: Kit, r: Rng, st: Style, c: Ctx): Generator<void, void, unknown>;
}

// ---------------------------------------------------------------- surfaces

const vct = (a: string, b: string): Surface => ({ m: surfMat(vctTile(a, b), { rough: 0.35 }), tile: [0.61, 0.61] });
// varnished wood reads as a mirror in the renderer's reflections unless kept fairly rough
const pbrS = (key: string, opts: { color?: string; rough?: number } = {}): Surface => ({
  m: surface(key, [1, 1], { color: opts.color, roughness: /parquet|laminate|oak/.test(key) ? 1.0 : opts.rough ?? 0.8 }),
  tile: [1, 1],
});
const paint = (c: string): Surface => ({ m: mat(c, { rough: 0.92 }) });

const COOL: Partial<Env> = { hemi: { sky: '#f2f6ff', ground: '#77746c', intensity: 0.55 }, ambient: 0.08, envIntensity: 0.55, exposure: 0.85 };
const WARM: Partial<Env> = { hemi: { sky: '#ffe9cc', ground: '#4a3a2a', intensity: 0.4 }, ambient: 0.05, envIntensity: 0.45, exposure: 0.95 };

/** a grid of point lights just under the ceiling */
function lights(k: Kit, st: Style, color: string, power: number, nx = 1, nz = 2) {
  const { W, D, H } = st;
  k.at(0, 0);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++) {
      const l = new THREE.PointLight(color, power * (W * D) / (nx * nz) * 0.09, Math.max(W, D) * 1.1, 1.5);
      k.light(l, -W / 2 + (W * (i + 0.5)) / nx, H - 0.5, -D / 2 + (D * (j + 0.5)) / nz);
    }
}
/** 2x4 troffers in rows, every ~2.4 m */
function troffers(k: Kit, st: Style) {
  const { W, D, H } = st;
  k.at(0, 0);
  const nx = Math.max(1, Math.round(W / 2.4)), nz = Math.max(2, Math.round(D / 2.4));
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) F.trofferAt(k, -W / 2 + (W * (i + 0.5)) / nx, H, -D / 2 + (D * (j + 0.5)) / nz);
}
/** hanging fluorescent strips in rows along z */
function tubes(k: Kit, st: Style, rows: number[], y = st.H - 0.45) {
  const { D, H } = st;
  k.at(0, 0);
  for (const x of rows) for (let z = -D / 2 + 1.6; z < D / 2 - 1.2; z += 2.6) F.tubeAt(k, x, y, z, 1.22, H);
}
function tracks(k: Kit, st: Style, rows: number[], cans = 4) {
  const { W, H } = st;
  k.at(0, 0);
  for (const z of rows) F.trackAt(k, 0, H, z, W - 2, cans);
}
/** department word painted on a wall */
function word(k: Kit, text: string, color: string, x: number, z: number, rot: number, y: number, w = 2.2) {
  k.at(x, z, rot);
  k.face(lit(textTex(text, '', color, { w: 1024, h: 256, font: '600 180px system-ui, sans-serif' }), { transparent: true }), w, w / 4, 0, y, 0.02);
}

// ---------------------------------------------------------------- layouts

const deli: Layout = {
  style(r) {
    const tin = r.chance(0.6);
    return {
      stockroom: { side: -1, back: 1.4 }, W: r.range(6.6, 8), D: r.range(13, 17), H: tin ? 3.5 : 3.0,
      ceil: tin ? 'tin' : 'drop', tin: r.pick(['#efe9da', '#f3f1ea', '#e8e2d0']),
      floor: r.pick([vct('#efece4', '#2b2b2b'), vct('#e8e2d0', '#8a5a3a'), vct('#d9d9d4', '#9a9a96'), pbrS('floor_laminate', { color: '#c8c8c8', rough: 0.6 })]),
      wall: r.chance(0.5) ? paint(r.pick(['#f0ece2', '#e9efe6', '#f3eadb'])) : pbrS('pine', { color: '#a07850', rough: 0.85 }),
      env: COOL, banner: false,
    };
  },
  door: (W) => -W / 2 + 1.3,
  *build(k, r, st, c) {
    const { W, D, H } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    // back: deli counter with the slicer and grill behind it, menu board above
    k.at(0.5, zb + 0.72);
    F.deliBack(k, W - 2.2);
    yield;
    k.at(0.5, zb + 0.03);
    F.menu(k, Math.min(4.2, W - 2.4), r.int(0, 99), H - 0.75);
    yield;
    k.at(0.6, zb + 2.0);
    F.deliCase(k, W - 2.6);
    yield;
    k.at(0.6, zb + 2.0);
    F.hangSign(k, textTex('DELI • GRILL', '#c62828', '#ffffff', { w: 512, h: 128 }), 1.4, 0.35, 0, H - 0.6, 0, H);
    yield;
    k.at(-xi + 0.5, zb + 0.5);
    F.boxStack(k, r, 0.8, 0.7, 1.6);
    yield;
    // left wall: glass-door coolers, then wall shelving to the front
    const coolZ0 = zb + 2.9;
    const doors = Math.max(4, Math.min(9, Math.floor((D * 0.5) / 0.76)));
    const cLen = doors * 0.76;
    k.at(-xi + 0.86, coolZ0 + cLen / 2 + 0.06, Math.PI / 2);
    F.cooler(k, doors, { header: r.pick(['COLD BEER', 'COLD DRINKS', 'BEER • SODA • WATER']), headerColor: r.pick(['#c62828', '#1565c0', '#2e7d32']) });
    yield;
    const shelfZ0 = coolZ0 + cLen + 0.2, shelfZ1 = zf - 3.0;
    if (shelfZ1 - shelfZ0 > 0.8) {
      k.at(-xi + 0.02, (shelfZ0 + shelfZ1) / 2, Math.PI / 2);
      F.gondola(k, shelfZ1 - shelfZ0, { double: false, height: 2.1, shelves: 6, color: '#e8e8e4', strip: '#c62828', messy: 0.4 });
      yield;
    }
    k.at(-xi + 0.35, zf - 2.6, Math.PI / 2); // ATM at the end of the wall shelving, clear of the door
    F.atm(k);
    yield;
    // centre gondolas
    const x0 = -xi + 0.86 + 1.0, x1 = xi - 0.47 - 0.98; // [audit] 0.91 m to the right-wall shelving (was 0.88)
    const nG = Math.max(1, Math.floor((x1 - x0 + 0.9) / 1.9));
    // [audit] 1.2 m of queue space in front of the deli case (was 0.48 m: the gondolas' back ends crowded it)
    const gz0 = zb + 3.75, gz1 = zf - 4.1;
    for (let i = 0; i < nG; i++) {
      const x = nG === 1 ? (x0 + x1) / 2 : x0 + 0.47 + (i * (x1 - x0 - 0.94)) / (nG - 1);
      for (const bay of retailBays(gz0, gz1, c.plan ?? 'aisles')) {
        k.at(x, bay.center, Math.PI / 2);
        F.gondola(k, bay.length, { height: c.plan === 'islands' ? 1.25 : 1.65, shelves: c.plan === 'islands' ? 3 : 5, color: r.pick(['#e8e8e4', '#2a2b2e']), strip: r.pick(['#c62828', '#f2c400']), messy: 0.45 });
        yield;
      }
      // no endcap where it would run into the counter's back bar
      if (x + 0.5 > xi - 1.45 - 0.45) continue;
      k.at(x, gz1 + 0.24);
      F.endcap(k, 0.9, { height: 1.3, shelves: 3, color: '#e8e8e4', messy: 0.6 });
      yield;
    }
    // right wall: shelving, then behind the counter the tobacco back bar
    const backZ0 = zf - 4.0, backZ1 = zf - 0.9;
    k.at(xi - 0.02, (gz0 - 0.4 + backZ0 - 0.3) / 2, -Math.PI / 2);
    F.gondola(k, backZ0 - 0.3 - gz0 + 0.4, { double: false, height: 2.1, shelves: 6, strip: '#c62828', messy: 0.4 });
    yield;
    k.at(xi - 0.42, (backZ0 + backZ1) / 2, -Math.PI / 2);
    F.backBar(k, backZ1 - backZ0);
    yield;
    // counter: customer side faces the aisle
    const cx = xi - 1.45;
    k.at(cx, zf - 2.45, -Math.PI / 2);
    F.bodegaCounter(k, 2.6, r, { lotto: true, candy: true });
    yield;
    // water cases and the cat
    k.at(cx - 1.2, zf - 0.7, 0);
    F.boxStack(k, r, 0.8, 0.5, 1.0, { water: true });
    yield;
    const where = r.int(0, 2);
    if (where === 0) {
      k.at(0, 0);
      F.cat(k, cx, 1.02, zf - 1.6, -Math.PI / 2 + r.range(-0.6, 0.6), r);
      yield;
    } else if (where === 1) {
      k.at(0, 0);
      F.cat(k, -xi + 1.4, 0, zf - 2.6, Math.PI / 2 + r.range(-0.8, 0.8), r);
      yield;
    } else {
      k.at(0, 0);
      F.cat(k, -xi + 0.45, 2.15 + 0.5, coolZ0 + 1.2, Math.PI / 2, r);
      yield;
    }
    // signs
    k.at(-xi + 0.01, zf - 2.0, Math.PI / 2);
    k.face(lit(textTex('WE ACCEPT\nEBT • SNAP', '#ffeb3b', '#1a1a1a', { w: 256, h: 192, font: 'bold 44px sans-serif' })), 0.5, 0.38, 0, 1.75, 0.02);
    k.at(xi - 0.01, zf - 0.6, -Math.PI / 2);
    k.face(lit(textTex('NO MORE THAN\n2 STUDENTS\nAT A TIME', '#ffffff', '#c62828', { w: 256, h: 256, font: 'bold 34px sans-serif' })), 0.35, 0.35, 0, 1.6, 0.02);
    if (st.ceil === 'tin') tubes(k, st, [-W / 4 + 0.2, W / 4]);
    else troffers(k, st);
    lights(k, st, '#f2f6ff', 1.1, 1, 3);
    yield;
  },
};

const pharmacy: Layout = {
  style(r) {
    return {
      stockroom: { side: -1, back: 1.5 }, W: r.range(12, 15), D: r.range(17, 21), H: 3.0, ceil: 'drop',
      floor: r.chance(0.5) ? pbrS('floor_carpet', { color: '#8a8e94', rough: 1 }) : vct('#e6e6e2', '#d6d6d0'),
      wall: paint('#f4f4f2'), env: { ...COOL, exposure: 0.8 }, banner: false,
    };
  },
  *build(k, r, st, c) {
    const { W, D, H } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    const red = c.color;
    // back wall: coolers on the left half, the pharmacy counter on the right
    const doors = Math.floor((W * 0.45) / 0.76);
    k.at(-xi + 0.4 + (doors * 0.76) / 2, zb + 0.86);
    F.cooler(k, doors, { frame: '#d8d8d8', header: 'beverages', headerColor: '#ffffff' });
    yield;
    k.at(-xi + 0.4 + (doors * 0.76) / 2, zb + 0.01);
    word(k, 'beverage', '#333333', 0, 0, 0, H - 0.35, 2.2);
    const px = xi - (W * 0.4) / 2 - 0.2;
    k.at(px, zb + 0.44);
    F.tallWall(k, W * 0.4, 2.2, { color: '#e8e8e6', shelves: 6 });
    yield;
    k.at(px, zb + 1.75); // [audit] 0.91 m for the pharmacist behind the counter (was 0.86)
    F.table(k, W * 0.4, 0.7, 1.05, { color: '#f4f4f2', cloth: '#ffffff', mode: 'shelf' });
    yield;
    k.at(px, zb + 0.01);
    word(k, 'pharmacy', red, 0, 0, 0, H - 0.35, 2.6);
    // side walls: wall shelving, department words above
    for (const s of [-1, 1]) {
      k.at(s * (xi - 0.02), -0.2, -s * Math.PI / 2);
      F.gondola(k, D - 5.2, { double: false, height: 2.0, shelves: 6, color: '#f0f0ee', strip: red, messy: 0.15 });
      yield;
      k.at(s * (xi - 0.01), -0.2, -s * Math.PI / 2);
      word(k, s < 0 ? 'beauty' : 'health', '#333333', 0, 0, 0, H - 0.4, 2.0);
    }
    // aisles of gondolas with hanging numbered signs
    const nA = Math.max(2, Math.floor((W - 2.6) / 2.25));
    // [audit] 1.25 m to queue at the pharmacy counter (was 0.86 m)
    const gz0 = zb + 3.3, gz1 = zf - 5.0;
    const cats = ['VITAMINS\nPAIN RELIEF', 'COLD & FLU\nFIRST AID', 'HAIR CARE\nSKIN CARE', 'BABY\nHOUSEHOLD', 'SNACKS\nCANDY', 'PERSONAL\nCARE', 'SEASONAL\nTOYS'];
    for (let i = 0; i < nA; i++) {
      const x = -((nA - 1) * 2.25) / 2 + i * 2.25;
      for (const bay of retailBays(gz0, gz1, c.plan ?? 'aisles')) {
        k.at(x, bay.center, Math.PI / 2);
        F.gondola(k, bay.length, { height: c.plan === 'islands' ? 1.25 : 1.7, shelves: c.plan === 'islands' ? 3 : 5, color: '#f0f0ee', strip: red, messy: 0.12 });
        yield;
      }
      k.at(x, gz1 + 0.23);
      F.endcap(k, 1.0, { height: 1.7, shelves: 4, color: red, strip: '#f2c400' });
      yield;
      if (i < nA - 1) {
        k.at(0, 0);
        F.hangSign(k, textTex(`${i + 1}\n${cats[i % cats.length].split('\n')[0]}`, '#ffffff', '#222', { w: 256, h: 256, font: 'bold 40px sans-serif', border: red }), 0.55, 0.55, x + 1.125, H - 0.6, (gz0 + gz1) / 2, H, Math.PI / 2);
        yield;
      }
    }
    // promotional stacks in the main aisle (cases on the floor)
    for (let i = 0; i < 2; i++) {
      k.at(-1.6 + i * 3.2, zf - 3.6);
      F.table(k, 0.8, 0.6, 0.12, { color: '#3a3a3a', mode: 'shelf' });
      yield;
      k.seg('stack', 0, 0.12, 0.28, 0.75, 0.55, 1.2, { maxRows: 3 });
    }
    // checkout by the door
    k.at(xi - 2.0, zf - 2.2, Math.PI);
    F.bodegaCounter(k, 2.4, r, { color: '#f0f0ee', top: '#d0d0cc', candy: true });
    yield;
    k.at(xi - 2.0, zf - 1.3, 0);
    F.gondola(k, 1.6, { height: 1.2, shelves: 4, double: false, strip: red, messy: 0.2 });
    yield;
    troffers(k, st);
    yield;
    lights(k, st, '#f4f8ff', 1.05, 2, 2);
    yield;
  },
};

const hardware: Layout = {
  style(r) {
    return {
      stockroom: { side: -1, back: 1.15 }, W: r.range(7.5, 10), D: r.range(16, 21), H: 3.8, ceil: 'tin', tin: r.pick(['#e9e4d6', '#d8d2c2', '#c9c3b2']),
      floor: pbrS(r.pick(['floor_laminate', 'oak']), { color: '#b89a7a', rough: 0.75 }),
      wall: paint(r.pick(['#e8e2d2', '#dfe6e0'])), env: { ...COOL, exposure: 0.9 },
    };
  },
  *build(k, r, st, c) {
    const { W, D, H } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    // left wall: low shelving with brown pegboard of hanging tools above
    const lz0 = zb + 1.8, lz1 = zf - 1.4;
    k.at(-xi + 0.02, (lz0 + lz1) / 2, Math.PI / 2);
    F.gondola(k, lz1 - lz0, { double: false, height: 0.95, shelves: 3, depth: 0.5, color: '#6a4a2a', strip: '#ffffff', messy: 0.5 });
    yield;
    k.at(-xi + 0.01, (lz0 + lz1) / 2, Math.PI / 2);
    F.pegWall(k, lz1 - lz0, 1.05, 2.75, { color: r.pick(['#a87b4f', '#f0ede6']) });
    yield;
    // right wall: floor-to-ceiling shelving with a rolling ladder
    k.at(xi - 0.44, -0.5, -Math.PI / 2);
    F.tallWall(k, D - 5, H - 0.4, { shelves: 7, ladder: true });
    yield;
    // centre: peg-backed gondolas with department headers
    const depts = ['PLUMBING', 'ELECTRICAL', 'PAINT', 'FASTENERS', 'TOOLS', 'HOUSEWARES', 'GARDEN'];
    const nG = W > 8.8 ? 2 : 1;
    const gz0 = zb + 2.6, gz1 = zf - 4.4;
    for (let i = 0; i < nG; i++) {
      const x = nG === 1 ? -0.2 : -1.1 + i * 2.2;
      for (const bay of retailBays(gz0, gz1, c.plan ?? 'aisles')) {
        k.at(x, bay.center, Math.PI / 2);
        if (c.plan === 'islands') F.table(k, bay.length, 0.9, 0.85, { color: '#6a4a2a', lower: true, messy: 0.5, mode: 'shelf' });
        else F.gondola(k, bay.length, { height: 2.0, shelves: 5, peg: '#a87b4f', color: '#3a3d42', strip: '#f2c400', messy: 0.35, header: textTex(depts[(i * 2) % depts.length], '#b5401c', '#ffffff', { w: 512, h: 112 }) });
        yield;
      }
      k.at(x, gz1 + 0.22);
      F.endcap(k, 0.95, { height: 1.4, shelves: 3, color: '#3a3d42', messy: 0.6 });
      yield;
    }
    // back wall: fastener bins
    k.at(0, zb + 0.43);
    F.binCabinet(k, Math.min(14, Math.floor((W - 1.5) / 0.3)), 6, { cell: 0.3 });
    yield;
    // behind the counter: a cabinet of small-parts drawers (open them: E)
    k.at(xi - 0.44, zf - 2.2, -Math.PI / 2);
    F.drawerChest(k, 3, 6, { w: 1.1, h: 1.25, d: 0.42, wood: '#6a6e72', knob: '#d8d8d8', label: 'parts drawer' });
    yield;
    // front: glass showcase counter and register, a bin of bargains
    k.at(xi - 1.9, zf - 2.4, -Math.PI / 2);
    F.showcase(k, 2.2);
    yield;
    k.at(0, 0);
    F.register(k, xi - 1.9, 1.0, zf - 2.0, Math.PI / 2);
    yield;
    F.cardReader(k, xi - 1.85, 1.0, zf - 2.8);
    yield;
    k.at(-0.8, zf - 2.2);
    F.table(k, 1.2, 0.8, 0.8, { color: '#6a4a2a', messy: 1, lower: true });
    yield;
    tubes(k, st, [-W / 4, W / 4], H - 0.7);
    yield;
    lights(k, st, '#f4f2ea', 1.0, 1, 3);
    yield;
  },
};

const electronics: Layout = {
  style(r) {
    return {
      W: r.range(8, 11), D: r.range(13, 17), H: 3.0, ceil: 'drop',
      floor: r.chance(0.5) ? vct('#dedcd4', '#cfcdc4') : pbrS('floor_tiles', { color: '#d8d8d8', rough: 0.4 }),
      wall: paint(r.pick(['#f2f2f2', '#e6ecf2'])), env: COOL,
    };
  },
  *build(k, r, st) {
    const { W, D } = st;
    const xi = W / 2, zb = -D / 2;
    // left wall: white slatwall of accessories on hooks
    k.at(-xi + 0.01, -0.5, Math.PI / 2);
    F.pegWall(k, D - 3.5, 0.5, 2.4, { slat: true, color: '#f2f2f0' });
    yield;
    // right wall: glass showcases under a row of TVs
    const sLen = D - 5;
    for (let i = 0; i < Math.floor(sLen / 1.8); i++) {
      k.at(xi - 0.35, zb + 1.2 + 0.9 + i * 1.8, -Math.PI / 2);
      F.showcase(k, 1.75, { frame: '#d0d2d6', h: 1.0 });
      yield;
    }
    k.at(xi - 0.01, -0.5, -Math.PI / 2);
    F.tvWall(k, Math.floor((D - 4) / 1.5), 2.05, r.int(0, 50));
    yield;
    // back wall: shelving and the service counter
    k.at(-1, zb + 0.02);
    F.gondola(k, W - 4, { double: false, height: 2.0, shelves: 5, color: '#2a2b2e', strip: '#1565c0' });
    yield;
    // [audit] clear of the right-wall showcases (was 0.41 m between them)
    k.at(xi - 2.6, zb + 1.6);
    F.showcase(k, 1.8, { frame: '#2a2b2e' });
    yield;
    k.at(0, 0);
    F.register(k, xi - 1.7, 1.0, zb + 1.55, Math.PI);
    yield;
    // centre: demo tables
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++) {
        // [audit] two tables spread evenly between the slatwall and the showcases: aisles >= 1 m (was 0.55 m between them)
        const a0 = -xi + 0.6, a1 = xi - 1.0, gap = (a1 - a0 - 3.2) / 3;
        k.at(a0 + gap + 0.8 + i * (1.6 + gap), zb + 4.2 + j * 3.4);
        F.table(k, 1.6, 0.9, 0.9, { color: '#f4f4f4', legs: '#d0d0d0', mode: 'shelf', cloth: '#f4f4f4', messy: 0.05 });
        yield;
      }
    troffers(k, st);
    yield;
    lights(k, st, '#f4f8ff', 1.0, 1, 2);
    yield;
  },
};

const toys: Layout = {
  style(r) {
    return {
      stockroom: { side: -1, back: 1.0 }, W: r.range(10, 13), D: r.range(14, 18), H: 3.4, ceil: 'plain',
      floor: pbrS('floor_laminate', { color: '#e8d8c0', rough: 0.6 }), wall: paint(r.pick(['#fdf6e8', '#eaf6fd', '#fdeef4'])),
      env: { ...COOL, hemi: { sky: '#fff8f0', ground: '#8a7a6a', intensity: 0.6 }, exposure: 0.85 },
    };
  },
  *build(k, r, st, c) {
    const { W, D, H } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    // left wall: white cubbies, each a heap
    k.at(-xi + 0.43, -0.8, Math.PI / 2);
    F.binCabinet(k, Math.floor((D - 5) / 0.48), 4, { cell: 0.48, color: '#f6f6f2', y0: 0.3 });
    yield;
    // right wall: slatwall of boxed toys
    k.at(xi - 0.01, -0.5, -Math.PI / 2);
    F.pegWall(k, D - 4, 0.4, 2.5, { slat: true, color: r.pick(['#ffe8a0', '#cfe8ff', '#ffd0e0']) });
    yield;
    // back wall shelving
    k.at(0, zb + 0.02);
    F.gondola(k, W - 2, { double: false, height: 2.2, shelves: 6, color: '#ffffff', strip: c.color, messy: 0.25 });
    yield;
    // centre: colourful stepped tables and low gondolas
    const cols = ['#f2b705', '#e84a8a', '#2f9be0', '#3fbf6f', '#ff7a1a'];
    for (let i = 0; i < 2; i++) {
      k.at(-2.2 + i * 4.4 - 0.4, zb + 4.2, 0);
      F.tiered(k, 1.8, { color: cols[(i * 2) % cols.length] });
      yield;
      k.at(-2.2 + i * 4.4 - 0.4, zb + 4.2 - 1.9, Math.PI);
      F.tiered(k, 1.8, { color: cols[(i * 2 + 1) % cols.length] });
      yield;
    }
    for (let i = 0; i < 2; i++) {
      k.at(-1.6 + i * 3.2 - 0.4, zb + 8.6, Math.PI / 2);
      F.gondola(k, 2.6, { height: 1.4, shelves: 4, color: cols[(i + 2) % cols.length], strip: '#ffffff', messy: 0.3 });
      yield;
    }
    k.at(1.8, zf - 2.6, Math.PI);
    F.bodegaCounter(k, 2.2, r, { color: cols[r.int(0, cols.length - 1)], top: '#ffffff' });
    yield;
    tracks(k, st, [-D / 4, 0, D / 4], 5);
    yield;
    k.at(0, 0);
    for (let i = 0; i < 6; i++) F.trofferAt(k, -W / 4 + (i % 2) * (W / 2), H, -D / 3 + Math.floor(i / 2) * (D / 3), 'x');
    lights(k, st, '#fff6ea', 1.05, 1, 2);
    yield;
  },
};

const music: Layout = {
  style(r) {
    return {
      W: r.range(8, 11), D: r.range(15, 19), H: 3.8, ceil: 'exposed',
      floor: pbrS(r.pick(['floor_parquet', 'oak']), { color: '#8a6a50', rough: 0.6 }),
      wall: r.chance(0.5) ? pbrS('nyc_brick', { color: '#a08070' }) : paint(r.pick(['#3a2a2e', '#2a2f3a', '#5a2a22'])),
      env: { ...WARM, exposure: 1.0 },
    };
  },
  *build(k, r, st) {
    const { W, D } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    // guitar walls down both sides, amps on the floor below
    for (const s of [-1, 1]) {
      k.at(s * (xi - 0.01), -0.3, -s * Math.PI / 2);
      F.guitarWall(k, D - 4.5);
      yield;
      k.at(0, 0);
      for (let z = zb + 1.5; z < zf - 3.2; z += 0.75) F.amp(k, s * (xi - 0.2), z, r.range(0.8, 1.3), -s * Math.PI / 2);
    }
    // centre: risers with keyboards / drums / big pieces on rugs
    k.at(0, -1.5);
    F.rug(k, 3.2, D - 8, r.int(0, 20));
    yield;
    for (let j = 0; j < 3; j++) {
      k.at(-0.8 + (j % 2) * 1.6, zb + 3.2 + j * 2.6);
      F.plinth(k, 1.4, 1.2, 0.18, { color: '#1a1a1a' });
      yield;
    }
    // back: counter with accessories wall
    k.at(0, zb + 0.02);
    F.gondola(k, W - 1.2, { double: false, height: 2.2, shelves: 6, color: '#1c1c1c', strip: '#3a1f5c', messy: 0.3 });
    yield;
    k.at(1.2, zb + 2.0);
    F.showcase(k, 2.4, { frame: '#1c1c1c' });
    yield;
    k.at(0, 0);
    F.register(k, 2.0, 1.0, zb + 1.85, Math.PI);
    yield;
    k.at(-1.6, zf - 2.6);
    F.boxStack(k, r, 0.9, 0.5, 1.2);
    yield;
    tracks(k, st, [-D / 3, -D / 12, D / 6, D / 3 + 0.5], 5);
    yield;
    lights(k, st, '#ffd9a8', 0.85, 1, 3);
    yield;
  },
};

const kitchen: Layout = {
  style(r) {
    return {
      W: r.range(9, 12), D: r.range(16, 21), H: 3.3, ceil: r.chance(0.5) ? 'drop' : 'exposed', ceilColor: '#4a4c50',
      floor: pbrS('floor_concrete', { color: '#a8a8a4', rough: 0.55 }), wall: paint('#eef0ee'), env: COOL,
    };
  },
  *build(k, r, st, c) {
    const { W, D } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    // left wall: slatwall of utensils over a low shelf
    k.at(-xi + 0.02, -0.6, Math.PI / 2);
    F.gondola(k, D - 4.5, { double: false, height: 1.0, shelves: 3, color: '#c8cacd', strip: '#0f5c5c', messy: 0.3 });
    yield;
    k.at(-xi + 0.01, -0.6, Math.PI / 2);
    F.pegWall(k, D - 4.5, 1.1, 2.6, { slat: true, color: '#e6e6e2' });
    yield;
    // right wall and centre aisles: chrome wire racks
    k.at(xi - 0.32, -0.6, -Math.PI / 2);
    F.wireRack(k, D - 4.5, { d: 0.6 });
    yield;
    const nA = Math.max(1, Math.floor((W - 3.6) / 2.6));
    for (let i = 0; i < nA; i++) {
      const x = -xi + 2.4 + i * 2.6;
      for (const s of [-1, 1]) {
        for (const bay of retailBays(-1.2 - (D - 7) / 2, -1.2 + (D - 7) / 2, c.plan ?? 'aisles')) {
          k.at(x + s * 0.31, bay.center, (s * Math.PI) / 2);
          F.wireRack(k, bay.length, { d: 0.6, h: c.plan === 'islands' ? 1.25 : 1.9 });
          yield;
        }
      }
    }
    // back: stacked cartons
    for (let i = 0; i < 4; i++) {
      k.at(-xi + 1.0 + i * 1.2, zb + 0.45);
      F.boxStack(k, r, 1.0, 0.8, r.range(1.0, 2.0));
      yield;
    }
    k.at(xi - 2.2, zf - 2.0, Math.PI);
    F.bodegaCounter(k, 2.4, r, { color: '#2f3a44', top: '#c8cacd' });
    yield;
    if (st.ceil === 'drop') troffers(k, st);
    else tubes(k, st, [-W / 4, W / 4]);
    lights(k, st, '#f2f6ff', 1.0, 1, 3);
    yield;
  },
};

const lighting: Layout = {
  style(r) {
    return {
      W: r.range(10, 13), D: r.range(14, 18), H: 3.8, ceil: 'exposed', ceilColor: '#151515',
      floor: pbrS('floor_concrete', { color: '#8a8a88', rough: 0.35 }), wall: paint(r.pick(['#2a2a2c', '#3a3530', '#e8e4dc'])),
      env: { ...WARM, hemi: { sky: '#ffe9cc', ground: '#2a2420', intensity: 0.3 }, exposure: 1.05 },
    };
  },
  *build(k, r, st) {
    const { W, D, H } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    // ceiling grid of hanging lamps
    k.at(0, 0);
    for (let x = -xi + 1.5; x < xi - 1; x += 1.6) for (let z = zb + 1.5; z < zf - 2.5; z += 1.8) k.seg('ceil', x, H + 0.3, z, 1.2, 1.2, 1.6, { big: true, want: /chandelier|pendant|lantern|ceiling|hanging/i });
    // floor lamps on plinths, table lamps on tables along the walls
    for (let j = 0; j < 3; j++) {
      k.at(-xi + 1.0, zb + 2 + j * 3, Math.PI / 2);
      F.plinth(k, 1.2, 1.2, 0.12, { color: '#d8d2c4', want: /floor lamp|standing|lamp/i });
      yield;
      k.at(xi - 1.0, zb + 2 + j * 3, -Math.PI / 2);
      F.plinth(k, 1.2, 1.2, 0.12, { color: '#d8d2c4', want: /floor lamp|standing|lamp/i });
      yield;
    }
    for (let i = 0; i < 2; i++) {
      k.at(-1.2 + i * 2.4, -0.5);
      F.table(k, 1.6, 0.8, 0.75, { color: '#3a2a1e', mode: 'shelf', want: /lamp|light/i, messy: 0.05 });
      yield;
    }
    k.at(0, zb + 0.02);
    F.gondola(k, W - 2, { double: false, height: 2.2, shelves: 5, color: '#1c1c1c', strip: '#222222' });
    yield;
    k.at(xi - 2, zf - 2.2, Math.PI);
    F.bodegaCounter(k, 2.0, r, { color: '#1c1c1c', top: '#b8913a' });
    yield;
    k.at(0, 0);
    for (let x = -xi + 1.2; x < xi; x += 2.4) F.pendantAt(k, x, H - 0.8, zf - 1.2, H + 0.4, '#b8913a');
    lights(k, st, '#ffd9a8', 0.75, 1, 2);
    yield;
  },
};

const sports: Layout = {
  style(r) {
    return {
      W: r.range(10, 13), D: r.range(16, 20), H: 3.2, ceil: 'drop',
      floor: pbrS('floor_laminate', { color: '#c8b8a0', rough: 0.55 }), wall: paint(r.pick(['#eef2f6', '#f4f4f0'])), env: COOL,
    };
  },
  *build(k, r, st, c) {
    const { W, D } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    for (const s of [-1, 1]) {
      k.at(s * (xi - 0.01), -0.5, -s * Math.PI / 2);
      F.pegWall(k, D - 4.5, 0.35, 2.6, { slat: true, color: '#e8e8e4' });
      yield;
    }
    // [audit] gondolas stop 1 m short of the ball bins (was 0.65 m)
    const gz0 = zb + 2.6, gz1 = zf - 5.35;
    for (let i = 0; i < 2; i++) {
      k.at(-1.6 + i * 3.2, (gz0 + gz1) / 2, Math.PI / 2);
      F.gondola(k, gz1 - gz0, { height: 1.6, shelves: 4, color: '#2a2b2e', strip: c.color, messy: 0.25 });
      yield;
    }
    // ball bins
    for (let i = 0; i < 2; i++) {
      k.at(-1.6 + i * 3.2, zf - 3.8);
      F.table(k, 1.0, 1.0, 0.75, { color: '#3a3a3a', cloth: '#1565c0', messy: 1, want: /ball/i });
      yield;
    }
    k.at(0, zb + 0.6);
    for (let i = 0; i < 3; i++) {
      k.at(-2.8 + i * 2.8, zb + 1.0); // [audit] 1 m between the plinths (was 0.8 m)
      F.plinth(k, 1.8, 1.2, 0.15, { color: '#2a2b2e' });
      yield;
    }
    k.at(xi - 2.2, zf - 2.2, Math.PI);
    F.bodegaCounter(k, 2.2, r, { color: '#2a2b2e', top: '#e8e8e4' });
    yield;
    troffers(k, st);
    yield;
    lights(k, st, '#f4f8ff', 1.0, 1, 3);
    yield;
  },
};

const furniture: Layout = {
  style(r) {
    return {
      W: r.range(12, 15), D: r.range(16, 20), H: 3.2, ceil: 'drop',
      floor: pbrS(r.pick(['floor_laminate', 'floor_parquet']), { color: '#b07a50', rough: 0.85 }),
      wall: paint(r.pick(['#d98a3a', '#5a6470', '#e8e2d6', '#3d5a6a'])),
      env: { ...WARM, hemi: { sky: '#fff2e0', ground: '#5a4a3a', intensity: 0.5 }, exposure: 0.95 },
    };
  },
  *build(k, r, st) {
    const { W, D } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    // vignettes: a rug, a big piece, two side pieces, a lamp
    const vx = [-W / 4 - 0.3, W / 4 + 0.3], vz = [zb + 3.2, zb + 7.6, zb + 12.0];
    for (const x of vx)
      for (const z of vz) {
        if (z > zf - 3.5) continue;
        k.at(x, z);
        F.rug(k, 3.2, 2.6, r.int(0, 50));
        yield;
        k.seg('single', 0, 0, -0.1, 2.4, 1.1, 2.0, { big: true, want: /sofa|couch|bed|table|sideboard|cabinet/i });
        k.seg('single', -1.2, 0, 1.2, 0.9, 0.9, 1.6, { big: true, want: /chair|armchair|stool|ottoman/i }, Math.PI * 0.8);
        k.seg('single', 1.2, 0, 1.2, 0.9, 0.9, 1.6, { big: true, want: /chair|armchair|table|lamp/i }, -Math.PI * 0.8);
        k.col(0, 0, 3.2, 2.6);
      }
    k.at(0, zb + 0.02);
    F.gondola(k, W - 3, { double: false, height: 2.0, shelves: 4, depth: 0.5, color: '#3a2a1e', strip: '#3a2a1e', messy: 0.1 });
    yield;
    k.at(xi - 2, zf - 2.0, Math.PI);
    F.bodegaCounter(k, 1.8, r, { color: '#3a3a3a', top: '#e8e2d6' });
    yield;
    k.at(0, 0);
    const H = st.H;
    for (let x = -xi + 1.5; x < xi; x += 2.4) for (let z = zb + 1.5; z < zf - 1; z += 2.4) k.cyl(mat('#ffffff', { emissive: '#fff2dc', ei: 3 }), 0.08, 0.01, x, H - 0.012, z);
    tracks(k, st, vz.filter((z) => z < zf - 3.5), 4);
    yield;
    lights(k, st, '#ffe6c8', 0.9, 2, 2);
    yield;
  },
};

const antiques: Layout = {
  style(r) {
    return {
      W: r.range(7, 9.5), D: r.range(14, 18), H: 3.6, ceil: 'tin', tin: r.pick(['#8a5a32', '#d8cfb8', '#6a4a2a', '#efe6d0']),
      floor: pbrS('floor_parquet', { color: '#6a4a32', rough: 0.6 }), wall: paint(r.pick(['#4a1e1e', '#1e3a2e', '#3a2a1e', '#c8b89a'])), trim: '#2a1a10',
      env: { ...WARM, hemi: { sky: '#ffe2bc', ground: '#2a1e14', intensity: 0.35 }, exposure: 1.1 },
    };
  },
  *build(k, r, st) {
    const { W, D, H } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    for (const s of [-1, 1]) {
      k.at(s * (xi - 0.44), -0.8, -s * Math.PI / 2);
      F.tallWall(k, D - 5.5, 2.5, { shelves: 6, color: '#3a2414', pitch: 0.32 });
      yield;
    }
    // crowded middle: curio cabinets, old tables heaped with things, rugs
    for (let z = zb + 3; z < zf - 3; z += 3.6) {
      k.at(r.range(-0.3, 0.3), z, r.range(-0.08, 0.08));
      F.rug(k, Math.min(W - 2.6, 3.4), 2.6, r.int(0, 50));
      yield;
    }
    const spots = [[-1.2, zb + 2.6], [1.1, zb + 3.6], [-1.0, zb + 5.6], [1.3, zb + 6.8], [-1.2, zb + 8.8], [1.0, zb + 10.0]];
    for (const [i, [x, z]] of spots.entries()) {
      if (z > zf - 3.2) continue;
      k.at(x, z, r.range(-0.15, 0.15) + (i % 3 === 2 ? Math.PI / 2 : 0));
      if (i % 3 === 2) F.curio(k, 1.0, { pitch: 0.25 });
      else F.table(k, r.range(1.0, 1.6), r.range(0.7, 0.9), r.range(0.72, 0.8), { color: r.pick(['#4a2e1a', '#5a3a22', '#3a2414']), legs: '#3a2414', messy: 0.7, lower: r.chance(0.5), pitch: 0.3 });
      yield;
    }
    // back corners: a dresser and an armoire (open them: E)
    k.at(-xi + 0.9, zb + 0.55);
    F.drawerChest(k, 2, 3, { w: 1.2, h: 0.85, d: 0.5, wood: '#4a2e1a', label: 'dresser drawer' });
    yield;
    k.at(xi - 0.75, zb + 0.65);
    F.cupboard(k, 1.1, 2.0, 0.6, { label: 'armoire' });
    yield;
    // back: counter with an old brass register
    k.at(0.6, zb + 1.2);
    F.showcase(k, 2.0, { frame: '#3a2414' });
    yield;
    k.at(0, 0);
    F.register(k, 0.4, 1.0, zb + 0.95, Math.PI);
    yield;
    // chandeliers everywhere
    for (let i = 0; i < 7; i++) F.chandelierAt(k, r.range(-xi + 1.2, xi - 1.2), H - r.range(0.6, 1.1), zb + 1.8 + i * ((D - 4) / 7), H, r);
    lights(k, st, '#ffcf96', 0.9, 1, 3);
    yield;
  },
};

const stationery: Layout = {
  style(r) {
    return {
      W: r.range(7, 10), D: r.range(13, 17), H: 3.4, ceil: 'plain',
      floor: pbrS('floor_parquet', { color: '#a07a58', rough: 0.6 }), wall: paint(r.pick(['#efe6d6', '#e2e8e0'])),
      env: { ...WARM, exposure: 0.95 },
    };
  },
  *build(k, r, st, c) {
    const { W, D, H } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    for (const s of [-1, 1]) {
      k.at(s * (xi - 0.44), -0.6, -s * Math.PI / 2);
      F.tallWall(k, D - 4.5, 2.6, { shelves: 7, color: '#5a3a22', books: true });
      yield;
    }
    for (let j = 0; j < 3; j++) {
      k.at(0, zb + 2.6 + j * 2.8);
      F.table(k, 1.8, 0.9, 0.82, { color: '#5a3a22', legs: '#3a2414', messy: 0.3, mode: 'shelf' });
      yield;
    }
    k.at(0, zb + 0.02);
    F.gondola(k, W - 2, { double: false, height: 2.0, shelves: 5, color: '#5a3a22', strip: c.color, messy: 0.2 });
    yield;
    k.at(xi - 2.0, zf - 2.0, Math.PI);
    F.bodegaCounter(k, 2.0, r, { color: '#5a3a22', top: '#d8cfb8' });
    yield;
    k.at(0, 0);
    for (let z = zb + 2.6; z < zf - 2; z += 2.8) F.pendantAt(k, 0, H - 1.0, z, H, '#1d3b2e');
    lights(k, st, '#ffe2bc', 0.95, 1, 2);
    yield;
  },
};

/**
 * Clothing boutique (SoHo / Nolita boutiques, mid-price chains): white or bare-brick walls with wall rails of
 * shirts over pants, free-standing rails and folding tables down the middle, dress forms in the window line,
 * curtained fitting rooms at the back, a cash wrap to one side, warm track spots.
 */
const clothing: Layout = {
  style(r) {
    const brick = r.chance(0.4);
    return {
      W: r.range(7.5, 10), D: r.range(13, 17), H: r.range(3.2, 3.8), ceil: brick ? 'exposed' : 'plain', ceilColor: '#2a2a2a',
      // wide oak planks or polished concrete
      floor: r.chance(0.55) ? pbrS('oak', { color: r.pick(['#b8977a', '#d8c8b0', '#9a7656']) }) : pbrS('floor_concrete', { color: r.pick(['#a8a49c', '#bdb6aa']), rough: 0.3 }),
      wall: brick ? pbrS('nyc_brick', { color: '#c8b0a0' }) : paint(r.pick(['#f6f4ef', '#eef0f0', '#f3ece2'])),
      env: { ...WARM, hemi: { sky: '#fff6ea', ground: '#5a4a3a', intensity: 0.5 }, exposure: 0.95 },
    };
  },
  *build(k, r, st) {
    const { W, D, H } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    // wall rails: one side double-hung (shirts over folded pants), the other long-hang (coats, dresses);
    // folded stacks on a shelf above both
    const dbl = r.chance(0.5) ? -1 : 1;
    for (const s of [-1, 1]) {
      const len = D - 5.5;
      k.at(s * (xi - 0.02), zb + 2.2 + len / 2, -s * Math.PI / 2);
      A.garmentRack(k, len, r, s === dbl ? { double: true, wall: true, h: 1.5, shelf: H > 3.1 } : { wall: true, h: 1.8, shelf: H > 3.1 });
      yield;
    }
    // fitting rooms across the back
    k.at(-xi + 0.2 + 1.5, zb + 1.25);
    A.fittingRooms(k, 3, r);
    yield;
    // middle: round racks between a table of folded tees and a straight rail, aisles >= 1 m either side
    const cx = -0.5;
    const mid = ['round', 'table', 'round', 'rail', 'round', 'table'];
    for (let j = 0, z = zb + 3.6; z < zf - 4.2; j++, z += 2.2) {
      k.at(cx, z, 0);
      const f = mid[j % mid.length];
      if (f === 'round') A.roundRack(k, r);
      else if (f === 'table') A.foldTable(k, 1.6, 0.9, r);
      else A.garmentRack(k, 1.5, r, { cut: r.pick(['shirt', 'dress', 'coat'] as const) });
      yield;
    }
    // a full-length mirror on the left wall by the front
    k.at(-xi + 0.01, zf - 2.0, Math.PI / 2);
    A.mirror(k, r);
    // dress forms near the front, clear of the door
    for (const s of [-1, 1]) {
      k.at(s * (xi - 1.6), zf - 2.4, s * 0.4);
      A.mannequin(k, r);
      yield;
    }
    // cash wrap on the right toward the back
    k.at(xi - 1.95, zb + 3.6, -Math.PI / 2); // 0.95 m for the clerk between it and the wall rail
    A.cashWrap(k, 1.8, r);
    yield;
    // warm track spots: a run every ~2.5 m
    const rows: number[] = [];
    for (let z = zb + 2.5; z < zf - 1.5; z += 2.5) rows.push(z);
    tracks(k, st, rows, 6);
    lights(k, st, '#ffd9b0', 0.95, 1, 3);
    yield;
  },
};

/**
 * Café or diner. Café: espresso bar with machine and grinder at the back, lit pastry case, menu board above,
 * round tables with chairs, pendants. Diner: a long counter with stools, booths down one wall, chrome and red
 * vinyl, checkerboard floor, a menu board and pie case.
 */
const cafe: Layout = {
  style(r, name) {
    // the variant follows the sign (a New York "coffee shop" or luncheonette is a diner); no name: a coin flip
    const roll = r.chance(0.4);
    const diner = name ? /DINER|COFFEE SHOP|LUNCHEONETTE/i.test(name) : roll;
    return {
      W: r.range(7, 10), D: r.range(12, 16), H: diner ? 3.1 : r.range(3.2, 3.8), ceil: diner ? 'drop' : r.pick(['tin', 'exposed'] as const),
      tin: r.pick(['#efe9da', '#e8e2d0']), ceilColor: '#2a2622',
      floor: diner ? vct('#f1ede4', '#1c1c1c') : pbrS(r.pick(['floor_parquet', 'oak', 'floor_concrete']), { color: '#a07a58', rough: 0.8 }),
      wall: diner ? paint(r.pick(['#f4efe2', '#e8f0ee'])) : r.chance(0.5) ? pbrS('nyc_brick', { color: '#b89a88' }) : paint(r.pick(['#efe6d6', '#e2e8e0', '#2f3a33'])),
      env: diner ? COOL : { ...WARM, exposure: 0.95 },
      variant: diner ? 'diner' : 'cafe', trim: diner ? '#9a9a9a' : undefined,
    };
  },
  *build(k, r, st) {
    const { W, D, H } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    const diner = st.variant === 'diner';
    // the counter runs across the room near the back; the barista / cook works behind it
    const cz = zb + 2.3;
    // counter from the right, the pastry case in line at its left end (the customer end)
    const cLen = Math.min(W - 2.4 - 1.8, diner ? 6.0 : 4.2);
    k.at(xi - 1.0 - cLen / 2, cz, 0);
    A.espressoBar(k, cLen, r, { diner });
    yield;
    // back counter and menu board on the back wall: a diner's back-bar has the coffee urns and the shake mixer
    if (diner) {
      k.at(xi - 1.0 - cLen / 2, zb + 0.02);
      A.dinerBackBar(k, cLen, r);
    } else {
      k.at(xi - 1.0 - cLen / 2, zb + 0.35);
      F.gondola(k, cLen, { double: false, height: 1.0, shelves: 2, color: '#3a2e24', messy: 0.2 });
    }
    yield;
    k.at(xi - 1.0 - cLen / 2, zb + 0.02);
    F.menu(k, Math.min(cLen, 3.2), r.int(0, 999), H - 0.6);
    yield;
    // pastry / pie case at the customer end of the counter
    k.at(xi - 1.0 - cLen - 0.05 - 0.8, cz - 0.05);
    A.pastryCase(k, 1.6);
    yield;
    if (diner) {
      // stools along the counter, booths down the left wall
      k.at(xi - 1.0 - cLen / 2, cz + 0.72); // stools tucked against the counter front
      A.stools(k, Math.floor(cLen / 0.75), 0.75, r);
      yield;
      const boothZ: number[] = [];
      for (let z = cz + 2.0; z + 2.0 < zf - 1.6; z += 2.2) {
        k.at(-xi + 0.62, z, Math.PI / 2);
        A.booth(k, r);
        boothZ.push(z);
        yield;
      }
      // a pendant over each booth table
      k.at(0, 0);
      const shade = r.pick(['#b71c1c', '#e4e6ea', '#1f4e79']);
      for (const z of boothZ) F.pendantAt(k, -xi + 0.62 + 0.95, H - 0.95, z - 0.0, H, shade);
      for (let z = cz + 2.9; z < zf - 2.6; z += 2.6) {
        k.at(xi - 1.6, z);
        A.cafeTable(k, r, { square: true, seats: 4, diner: true });
        yield;
      }
    } else {
      // café tables in a loose grid, 1 m walkways
      const cols = Math.max(1, Math.floor((W - 1.2) / 2.6));
      for (let z = cz + 2.4; z < zf - 2.2; z += 2.6)
        for (let i = 0; i < cols; i++) {
          k.at(-xi + 0.6 + (W - 1.2) * ((i + 0.5) / cols), z);
          A.cafeTable(k, r);
          yield;
        }
    }
    // wall dressing: framed photos down both side walls, a neon sign by the counter
    const z0 = cz + 1.9, z1 = zf - 1.4;
    k.at(-xi + 0.005, (z0 + z1) / 2, Math.PI / 2);
    A.framedPhotos(k, z1 - z0, 1.7, r, { food: diner ? 0.35 : 0.2 });
    k.at(xi - 0.005, (z0 + 1.6 + z1) / 2, -Math.PI / 2);
    A.framedPhotos(k, z1 - z0 - 1.6, 1.7, r, { food: diner ? 0.35 : 0.2 });
    if (diner || r.chance(0.6)) {
      k.at(xi - 0.005, cz + 1.0, -Math.PI / 2);
      A.neonSign(k, r.pick(diner ? ['Pie & Coffee', 'Open 24 Hours', 'Eat', 'Diner'] : ['Coffee', 'Espresso', 'Fresh Pastry']), r.pick(['#ff4f8b', '#4fc3ff', '#ff6a2a', '#ffe14f']), 1.5, 2.05);
    }
    yield;
    k.at(0, 0);
    if (diner) troffers(k, st);
    else for (let x = -W / 4; x <= W / 4 + 0.01; x += W / 2) for (let z = cz + 2.4; z < zf - 1.5; z += 2.6) F.pendantAt(k, x, H - 1.1, z, H, r.pick(['#1d3b2e', '#1c1c1c', '#b08a5a']));
    lights(k, st, diner ? '#f4f8ff' : '#ffe2bc', diner ? 1.05 : 0.9, 1, 2);
    yield;
  },
};

const garden: Layout = {
  style(r) {
    return {
      W: r.range(8, 11), D: r.range(14, 18), H: 3.6, ceil: 'exposed', ceilColor: '#3a3028',
      floor: pbrS('floor_concrete', { color: '#9a948a', rough: 0.9 }), wall: pbrS('nyc_brick', { color: '#b8a898' }),
      env: { ...WARM, hemi: { sky: '#f4fff0', ground: '#4a4030', intensity: 0.55 }, exposure: 0.95 }, neon: false,
    };
  },
  *build(k, r, st) {
    const { W, D, H } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    // slatted tiered benches along the walls and in the middle
    for (const s of [-1, 1])
      for (let z = zb + 1.75; z < zf - 3.9; z += 2.3) {
        k.at(s * (xi - 1.2), z, -s * Math.PI / 2);
        F.tiered(k, 2.1, { color: '#8a6a44', slats: true, messy: 0.2 });
        yield;
      }
    for (let j = 0; j < 2; j++) {
      k.at(0, zb + 3.5 + j * 4);
      F.table(k, 2.2, 1.2, 0.75, { color: '#8a6a44', legs: '#3a3a3a', messy: 0.25, lower: true });
      yield;
    }
    k.at(0, zb + 0.32);
    F.wireRack(k, W - 2, { d: 0.6 });
    yield;
    k.at(-xi + 1.6, zf - 2.2, 0);
    F.plinth(k, 1.4, 1.4, 0.05, { color: '#7a7a76' });
    yield;
    k.at(xi - 2, zf - 1.8, Math.PI);
    F.bodegaCounter(k, 1.8, r, { color: '#5a4a32', top: '#8a6a44' });
    yield;
    k.at(0, 0);
    for (let x = -xi + 1.5; x < xi; x += 2.0) for (let z = zb + 1.5; z < zf - 1; z += 2.5) F.bulbAt(k, x, H - 0.6, z, H + 0.4);
    lights(k, st, '#ffe0b0', 1.0, 1, 3);
    yield;
  },
};

const models: Layout = {
  style(r) {
    return {
      W: r.range(9, 12), D: r.range(14, 18), H: 3.2, ceil: 'drop',
      floor: pbrS('floor_carpet', { color: '#4a5a6a', rough: 1 }), wall: paint(r.pick(['#e8e6e0', '#dfe4ea'])), env: COOL,
    };
  },
  *build(k, r, st) {
    const { W, D, H } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    for (const s of [-1, 1])
      for (let z = zb + 1.2; z < zf - 3.0; z += 1.25) {
        k.at(s * (xi - 0.47), z, -s * Math.PI / 2);
        F.curio(k, 1.2, { wood: '#2a2a2a', shelves: 5 });
        yield;
      }
    k.at(0, zb + 4.5);
    F.modelLayout(k, Math.min(4.5, W - 4), 2.4);
    yield;
    for (let i = 0; i < 2; i++) {
      k.at(-1.4 + i * 2.8, zb + 8.5);
      F.plinth(k, 1.4, 1.4, 0.6, { color: '#f2f2f0', mini: true });
      yield;
    }
    // aircraft hang from the ceiling
    k.at(0, 0);
    for (let i = 0; i < 3; i++) k.seg('ceil', -2 + i * 2, H, zb + 2.5 + i * 3, 1.6, 1.6, 1.0, { big: true, mini: true, want: /plane|aircraft|jet|helicopter|airship|blimp|biplane|glider|rocket|spaceship/i });
    k.at(0, zb + 0.02);
    F.gondola(k, W - 2, { double: false, height: 2.0, shelves: 5, color: '#2a2a2a', strip: '#1d3b5c', messy: 0.2 });
    yield;
    k.at(xi - 2, zf - 2.2, Math.PI);
    F.showcase(k, 2.0);
    yield;
    troffers(k, st);
    yield;
    lights(k, st, '#f4f8ff', 1.0, 1, 2);
    yield;
  },
};

const machines: Layout = {
  style(r) {
    return {
      W: r.range(10, 13), D: r.range(17, 22), H: 4.4, ceil: 'exposed', ceilColor: '#3a3c40',
      floor: pbrS('floor_concrete', { color: '#a0a09a', rough: 0.7 }), wall: pbrS('nyc_panel', { color: '#c8c8c4' }), env: COOL,
    };
  },
  *build(k, r, st) {
    const { W, D } = st;
    const xi = W / 2, zb = -D / 2, zf = D / 2;
    for (const s of [-1, 1]) {
      k.at(s * (xi - 0.55), -1, -s * Math.PI / 2);
      F.palletRack(k, D - 6, { h: 3.2, levels: 3 });
      yield;
    }
    for (let i = 0; i < 2; i++) {
      k.at(-1.3 + i * 2.6, -1.5, Math.PI / 2);
      F.wireRack(k, D - 9, { d: 0.6, h: 1.9 });
      yield;
    }
    k.at(0, zb + 0.43);
    F.binCabinet(k, Math.floor((W - 3) / 0.3), 7, { cell: 0.3, color: '#2f5f9a' });
    yield;
    k.at(xi - 2.2, zf - 2.2, Math.PI);
    F.bodegaCounter(k, 2.4, r, { color: '#3a3b3e', top: '#9a9c9e' });
    yield;
    tubes(k, st, [-W / 4, W / 4], st.H - 0.9);
    yield;
    lights(k, st, '#f2f6ff', 1.0, 1, 3);
    yield;
  },
};

export const LAYOUTS: Record<string, Layout> = { clothing, cafe, deli, pharmacy, hardware, electronics, toys, music, kitchen, lighting, sports, furniture, antiques, stationery, garden, models, machines };

/**
 * Every shop type with an interior layout. To add one: write a Layout above (style() + a *build()
 * generator yielding between fixtures), add it to LAYOUTS, give it pools in SHOPS (src/nyc.ts),
 * packaging kinds in filler.ts SHOP_KINDS and optionally library queries in shop.ts LIB_QUERIES.
 * Unknown types fall back to the deli layout.
 */
export const SHOP_TYPES = Object.keys(LAYOUTS);
