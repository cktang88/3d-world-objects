import * as THREE from 'three';
import { mat } from '../build';
import { Rng } from '../rng';
import { Kit, M, glass, lit, printed, surfMat, type Seg } from './kit';
import { rugTex, cigRack, lottoTickets, menuBoard, pegboard, priceStrip, slatwall, textTex, troffer, screenTex, bookSpines, layoutTex } from './tex';

/**
 * Store fixtures, each built at the kit's current frame (kit.at(x, z, rot) first):
 * local +z is the customer side, local x runs along the fixture.
 */

export const DRINK = /\b(bottle|can|soda|cola|beer|wine|juice|water|milk|drink|beverage|energy|coke|pepsi|sprite|lemonade|tea|coffee|carton|champagne|whiskey|vodka|liquor|ale|lager|yogurt|soup)/i;

export interface GondolaOpts {
  height?: number;
  shelves?: number;
  double?: boolean;
  depth?: number;
  color?: string;
  strip?: string;
  /** upper part pegboard with hang segments */
  peg?: string;
  want?: RegExp;
  messy?: number;
  maxRows?: number;
  header?: THREE.Texture;
  base?: number;
}

/** Shelving run (gondola, or wall shelving if !double): kick-plate deck, back panel, shelves with price strips. */
export function gondola(k: Kit, len: number, o: GondolaOpts = {}) {
  const H = o.height ?? 1.8, n = o.shelves ?? 5, dbl = o.double ?? true, d = o.depth ?? 0.45;
  const body = mat(o.color ?? '#e9e9e6', { rough: 0.45, metal: 0.3 });
  const strip = printed(priceStrip(o.strip ?? '#d02a24'), { rough: 0.5 });
  const sides = dbl ? [1, -1] : [1];
  const back = 0.04;
  // uprights and back panel
  k.box(body, len, H, back, 0, 0, 0);
  for (const x of [-len / 2, len / 2]) k.box(body, 0.05, H, dbl ? 2 * d + back : d + back, x, 0, dbl ? 0 : d / 2);
  const base = o.base ?? 0.14;
  const pegTop = o.peg ? H - 0.05 : 0;
  const pegBot = o.peg ? Math.max(base + 0.5, H * 0.45) : 0;
  for (const s of sides) {
    const zc = s * (back / 2 + d / 2);
    // base deck with kick plate
    k.box(body, len, base, d, 0, 0, zc);
    k.box(mat('#2a2a2a', { rough: 0.6 }), len, 0.1, 0.01, 0, 0.02, s * (back / 2 + d) + s * 0.005);
    if (o.peg) {
      const pm = surfMat(pegboard(o.peg), { rough: 0.9 });
      k.face(pm, len, pegTop - pegBot, 0, (pegTop + pegBot) / 2, s * (back / 2 + 0.002), [0.1016, 0.1016], s > 0 ? 0 : Math.PI);
      k.seg('hang', 0, pegBot + 0.04, s * (back / 2 + 0.005), len - 0.06, 0.32, pegTop - pegBot - 0.08, { want: o.want, messy: o.messy }, s > 0 ? 0 : Math.PI);
    }
    const top = o.peg ? pegBot : H;
    const levels: number[] = [base];
    const m = o.peg ? Math.max(1, Math.round(n * (pegBot / H))) : n;
    for (let i = 1; i < m; i++) levels.push(base + ((top - base - 0.12) * i) / (m - 1 || 1));
    if (!o.peg && m > 1) levels[levels.length - 1] = top - 0.32;
    levels.forEach((y, i) => {
      const fz = s * (back / 2 + d);
      if (i > 0) {
        k.box(body, len - 0.02, 0.025, d - 0.02, 0, y - 0.025, zc);
        // price channel on the shelf edge
        k.face(strip, len - 0.02, 0.04, 0, y - 0.02, fz + s * 0.006, [1.2, 0.04], s > 0 ? 0 : Math.PI);
      } else k.face(strip, len - 0.02, 0.04, 0, base - 0.03, fz + s * 0.006, [1.2, 0.04], s > 0 ? 0 : Math.PI);
      const next = i + 1 < levels.length ? levels[i + 1] - 0.03 : top - 0.02;
      k.seg('shelf', 0, y, fz - s * 0.02, len - 0.06, d - 0.04, Math.max(0.12, next - y - 0.03), { want: o.want, messy: o.messy, maxRows: o.maxRows }, s > 0 ? 0 : Math.PI);
    });
  }
  if (!o.peg) k.box(body, len, 0.03, dbl ? 2 * d + back : d + back, 0, H - 0.03, dbl ? 0 : d / 2);
  if (o.header) for (const s of sides) k.face(lit(o.header), Math.min(len, 1.6), 0.32, 0, H + 0.2, s * 0.03, undefined, s > 0 ? 0 : Math.PI);
  k.col(0, dbl ? 0 : d / 2, len + 0.05, (dbl ? 2 * d + back : d + back) + 0.05);
}

/** Endcap: a short shelving face at the end of a gondola, often overstocked with one product. */
export function endcap(k: Kit, w: number, o: GondolaOpts = {}) {
  gondola(k, w, { ...o, double: false, depth: o.depth ?? 0.4, shelves: o.shelves ?? 4, maxRows: 4 });
}

/** Glass-door reach-in cooler bank: lit inside, bottles fronted deep behind each door. */
export function cooler(k: Kit, doors: number, o: { frame?: string; header?: string; headerColor?: string; want?: RegExp } = {}) {
  const dw = 0.76, H = 2.15, D = 0.85, len = doors * dw;
  const frame = mat(o.frame ?? '#1b1c1e', { rough: 0.4, metal: 0.5 });
  const inner = mat('#f4f6f8', { rough: 0.4, emissive: '#eef4ff', ei: 0.35 });
  const wire = mat('#9aa0a6', { rough: 0.4, metal: 0.7 });
  const led = M.emit('#f4f8ff', 3.2);
  // box: back is at z = -D, glass front at z = 0
  k.box(frame, len + 0.1, 0.16, D, 0, 0, -D / 2);
  k.box(inner, len, H - 0.16, 0.04, 0, 0.16, -D + 0.02);
  k.box(frame, 0.05, H, D, -len / 2 - 0.025, 0, -D / 2);
  k.box(frame, 0.05, H, D, len / 2 + 0.025, 0, -D / 2);
  k.box(frame, len + 0.1, 0.5, D, 0, H, -D / 2);
  k.box(inner, len, 0.02, D - 0.1, 0, H - 0.02, -D / 2);
  // header panel
  const ht = textTex(o.header ?? 'COLD DRINKS', o.headerColor ?? '#c62828', '#ffffff', { w: 1024, h: 128, font: 'bold 76px system-ui, sans-serif' });
  k.face(lit(ht), len, 0.36, 0, H + 0.25, 0.005, undefined);
  const levels = [0.18, 0.56, 0.92, 1.28, 1.64];
  for (let i = 0; i < doors; i++) {
    const x = -len / 2 + dw * (i + 0.5);
    for (const [j, y] of levels.entries()) {
      if (j > 0) k.box(wire, dw - 0.04, 0.02, D - 0.12, x, y - 0.02, -D / 2 - 0.03);
      const top = j + 1 < levels.length ? levels[j + 1] - 0.03 : H - 0.06;
      k.seg('shelf', x, y, -0.1, dw - 0.08, D - 0.2, top - y - 0.02, { want: o.want ?? DRINK, maxRows: 5 });
    }
    // mullion with its LED strip
    const mx = -len / 2 + dw * i;
    if (i > 0) k.box(frame, 0.05, H - 0.16, 0.06, mx, 0.16, -0.01);
    k.box(led, 0.012, H - 0.3, 0.012, mx + 0.04, 0.22, -0.06);
    k.box(led, 0.012, H - 0.3, 0.012, mx + dw - 0.04, 0.22, -0.06);
    // door: frame, glass, handle
    k.box(frame, dw - 0.02, 0.05, 0.05, x, 0.16, 0.01);
    k.box(frame, dw - 0.02, 0.05, 0.05, x, H - 0.05, 0.01);
    k.box(M.chrome(), 0.025, 0.9, 0.03, x + (i % 2 ? -1 : 1) * (dw / 2 - 0.08), 0.75, 0.06);
    k.face(glass(), dw - 0.06, H - 0.26, x, 0.16 + (H - 0.26) / 2 + 0.05, 0.012, undefined, 0, true);
  }
  k.col(0, -D / 2, len + 0.12, D + 0.1);
}

/** Bodega checkout counter (local +z: customer side) with register, card reader, lotto, candy. */
export function bodegaCounter(k: Kit, len: number, r: Rng, o: { color?: string; top?: string } = {}) {
  const body = mat(o.color ?? '#7a1d1d', { rough: 0.55 });
  const top = mat(o.top ?? '#e6e1d6', { rough: 0.35 });
  const D = 0.65, Hc = 1.02;
  k.box(mat('#202020'), len - 0.05, 0.1, D - 0.1, 0, 0, -0.05);
  k.box(body, len, Hc - 0.14, D, 0, 0.1, 0);
  k.box(top, len + 0.06, 0.04, D + 0.1, 0, Hc - 0.04, 0.02);
  // scratched-up front: a band of sticker ads
  k.face(printed(textTex('LOTTO  •  EBT ACCEPTED  •  ATM INSIDE', '#1e3f8a', '#ffffff', { w: 1024, h: 64 })), len * 0.9, 0.12, 0, 0.75, D / 2 + 0.003);
  register(k, -len / 2 + 0.45, Hc, -0.05, Math.PI);
  cardReader(k, -len / 2 + 0.9, Hc, 0.18);
  lotto(k, len / 2 - 0.45, Hc, -0.1);
  // impulse buys on the counter front edge: candy and gum bins
  for (let i = 0; i < 3; i++) {
    const x = -len / 2 + 1.3 + i * 0.36;
    if (x > len / 2 - 0.8) break;
    k.box(mat(r.pick(['#d32f2f', '#1565c0', '#2e7d32', '#f9a825']), { rough: 0.5 }), 0.32, 0.06, 0.2, x, Hc, 0.18);
    k.seg('pile', x, Hc + 0.06, 0.28, 0.3, 0.2, 0.12, { messy: 1 });
  }
  // the clerk side: a raised shelf for bags
  k.box(mat('#3a3a3a'), len - 0.1, 0.02, 0.3, 0, 0.55, -0.15);
  k.col(0, 0, len + 0.06, D + 0.1);
}

/** POS register: base, cash drawer, keyboard, pole display facing the customer. */
export function register(k: Kit, x: number, y: number, z: number, ry = 0) {
  const b = M.black();
  const g = new THREE.Group();
  const add = (m: THREE.Material, w: number, h: number, d: number, px: number, py: number, pz: number, rx = 0) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(px, py + h / 2, pz);
    o.rotation.x = rx;
    g.add(o);
    return o;
  };
  add(b, 0.42, 0.1, 0.42, 0, 0, 0); // cash drawer
  add(mat('#2a2a2a', { rough: 0.4 }), 0.36, 0.04, 0.16, 0, 0.1, 0.1, -0.15); // keypad
  add(b, 0.05, 0.22, 0.05, 0, 0.1, -0.12); // pole
  add(b, 0.32, 0.22, 0.04, 0, 0.3, -0.1, 0.25); // operator screen
  add(mat('#0a1a2a', { emissive: '#4fa3ff', ei: 0.9 }), 0.28, 0.17, 0.005, 0, 0.325, -0.075, 0.25);
  add(b, 0.18, 0.06, 0.04, 0, 0.54, -0.12); // customer pole display
  add(mat('#001a08', { emissive: '#39ff88', ei: 1.4 }), 0.16, 0.035, 0.005, 0, 0.552, -0.142);
  add(mat('#d0d0d0', { rough: 0.5 }), 0.14, 0.12, 0.16, 0.26, 0, 0.04); // receipt printer
  g.position.set(x, y, z);
  g.rotation.y = ry;
  k.add(g);
}

export function cardReader(k: Kit, x: number, y: number, z: number) {
  k.box(M.dark(), 0.1, 0.12, 0.08, x, y, z);
  k.box(M.black(), 0.09, 0.16, 0.04, x, y + 0.1, z + 0.01).rotation.x = -0.4;
  k.box(mat('#0a0a0a', { emissive: '#7fd0ff', ei: 0.8 }), 0.07, 0.06, 0.005, x, y + 0.17, z + 0.045).rotation.x = -0.4;
}

/** Plexi scratch-off ticket dispenser. */
export function lotto(k: Kit, x: number, y: number, z: number) {
  k.box(mat('#d8e4ee', { rough: 0.1 }), 0.5, 0.36, 0.14, x, y, z);
  k.face(printed(lottoTickets(), { emissive: 0.25 }), 0.48, 0.34, x, y + 0.18, z + 0.072);
  k.face(lit(textTex('LOTTO', '#e53935', '#ffffff', { w: 256, h: 64 })), 0.4, 0.1, x, y + 0.42, z + 0.07);
}

/** Back bar behind a bodega counter: cigarette rack above, shelves of sundries below. */
export function backBar(k: Kit, len: number) {
  const body = mat('#2a2a2c', { rough: 0.5 });
  k.box(body, len, 0.95, 0.4, 0, 0, -0.2);
  k.box(mat('#d8d2c4', { rough: 0.4 }), len, 0.03, 0.42, 0, 0.95, -0.2);
  k.seg('shelf', 0, 0.98, -0.02, len - 0.1, 0.36, 0.3, { messy: 0.6 });
  k.box(body, len, 1.0, 0.18, 0, 1.3, -0.09);
  k.face(printed(cigRack(), { emissive: 0.15 }), len - 0.06, 0.94, 0, 1.8, 0.005, [len - 0.06, 0.94]);
  k.face(lit(textTex('TOBACCO  •  MUST BE 21', '#111111', '#f5f5f5', { w: 1024, h: 96 })), len, 0.14, 0, 2.38, 0.005);
  k.seg('shelf', 0, 2.48, -0.02, len - 0.1, 0.3, 0.32, { messy: 0.3 });
  k.box(body, len, 0.03, 0.32, 0, 2.45, -0.16);
  k.col(0, -0.2, len, 0.45);
}

/** Refrigerated deli case: lit interior, angled glass front, stainless top. */
export function deliCase(k: Kit, len: number, o: { want?: RegExp } = {}) {
  const D = 0.95, H = 1.25;
  const ss = M.steel();
  k.box(mat('#efefea', { rough: 0.4 }), len, 0.75, D, 0, 0, 0);
  k.box(mat('#3a3a3a'), len, 0.06, 0.02, 0, 0.62, D / 2 + 0.005);
  k.box(mat('#f5f5f0', { emissive: '#fff8ec', ei: 0.5 }), len - 0.06, 0.02, D - 0.25, 0, 0.75, -0.05);
  k.seg('pile', 0, 0.77, D / 2 - 0.2, len - 0.2, D - 0.45, 0.22, { want: o.want ?? /meat|ham|cheese|salami|sausage|bacon|chicken|turkey|steak|fish|salad|bread|bagel|cake|pie|donut|sandwich|burger|pizza/i, messy: 0.4 });
  k.box(ss, len, 0.04, 0.45, 0, H, -D / 2 + 0.22);
  for (const x of [-len / 2, len / 2]) k.box(ss, 0.04, H - 0.75, D, x, 0.75, 0);
  k.box(M.emit('#fff4e0', 2.2), len - 0.1, 0.015, 0.03, 0, H - 0.02, -0.1);
  // curved front glass approximated by an angled pane
  const pane = k.face(glass(), len - 0.04, 0.62, 0, 0.75 + 0.27, D / 2 - 0.18, undefined, 0, true);
  pane.rotation.x = -0.45;
  k.col(0, 0, len + 0.05, D + 0.05);
}

/** Back counter with a meat slicer, a grill and paper rolls. */
export function deliBack(k: Kit, len: number) {
  const ss = M.steel();
  k.box(ss, len, 0.9, 0.7, 0, 0, -0.35);
  // slicer
  const sx = -len / 2 + 0.5;
  k.box(mat('#d9d9d6', { rough: 0.3, metal: 0.6 }), 0.45, 0.12, 0.4, sx, 0.9, -0.35);
  k.cyl(mat('#e6e8ea', { rough: 0.15, metal: 1 }), 0.15, 0.02, sx, 1.17, -0.42, 'z').rotation.set(Math.PI / 2, 0, 0.35);
  k.box(mat('#d9d9d6', { rough: 0.3, metal: 0.6 }), 0.1, 0.25, 0.1, sx + 0.12, 0.9, -0.48);
  // flat-top grill
  k.box(mat('#2a2a2a', { rough: 0.3, metal: 0.8 }), 0.9, 0.08, 0.6, len / 2 - 0.6, 0.9, -0.35);
  k.box(ss, 0.9, 0.25, 0.05, len / 2 - 0.6, 0.9, -0.62);
  // paper rolls, squeeze bottles
  for (let i = 0; i < 3; i++) k.cyl(mat(['#f2f2f2', '#c8a26a', '#e53935'][i]), 0.035, 0.2, -0.2 + i * 0.09, 0.9, -0.55);
  k.col(0, -0.35, len, 0.75);
}

/** Overhead menu board on the back wall. */
export function menu(k: Kit, w: number, seed: number, y = 2.2) {
  k.box(M.black(), w + 0.06, 0.62, 0.05, 0, y - 0.31, 0.025);
  k.face(lit(menuBoard(seed)), w, w / 4 > 0.58 ? 0.58 : w / 4, 0, y, 0.052);
}

/** Pegboard (or slatwall) wall panel with hang segments, split in columns. */
export function pegWall(k: Kit, len: number, y0: number, y1: number, o: { color?: string; slat?: boolean; want?: RegExp; cols?: number } = {}) {
  const s = o.slat ? slatwall(o.color ?? '#e9e6df') : pegboard(o.color ?? '#a87b4f');
  k.face(surfMat(s, { rough: 0.85 }), len, y1 - y0, 0, (y0 + y1) / 2, 0.012, s.tile);
  k.box(mat('#3a2a1a'), len, 0.04, 0.03, 0, y1, 0.01);
  const n = o.cols ?? Math.max(1, Math.round(len / 1.2));
  for (let i = 0; i < n; i++) {
    const x = -len / 2 + (len * (i + 0.5)) / n;
    k.seg('hang', x, y0 + 0.08, 0.02, len / n - 0.08, 0.35, y1 - y0 - 0.16, { want: o.want });
  }
}

/** Wooden pigeonhole cabinet of open bins (nuts and bolts, parts): each bin a little pile. */
export function binCabinet(k: Kit, cols: number, rows: number, o: { cell?: number; color?: string; y0?: number } = {}) {
  const c = o.cell ?? 0.3, w = cols * c, h = rows * c * 0.75, y0 = o.y0 ?? 0.1;
  const wood = mat(o.color ?? '#8a5a32', { rough: 0.7 });
  k.box(wood, w + 0.04, y0, 0.42, 0, 0, -0.21);
  k.box(wood, w + 0.04, h + 0.04, 0.03, 0, y0, -0.41);
  for (let i = 0; i <= cols; i++) k.box(wood, 0.02, h, 0.4, -w / 2 + i * c, y0, -0.2);
  for (let j = 0; j <= rows; j++) k.box(wood, w, 0.02, 0.4, 0, y0 + j * c * 0.75, -0.2);
  const tag = mat('#f4efe0', { rough: 0.8 });
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const x = -w / 2 + c * (i + 0.5), y = y0 + j * c * 0.75 + 0.02;
      k.box(wood, c - 0.02, 0.07, 0.015, x, y, -0.005);
      k.box(tag, 0.08, 0.035, 0.004, x, y + 0.02, 0.004);
      k.seg('pile', x, y, -0.03, c - 0.05, 0.33, c * 0.75 - 0.06, { messy: 1, maxRows: 3 });
    }
  k.col(0, -0.21, w + 0.06, 0.45);
}

/** A display table (optionally with a lower shelf), products piled / arranged on top. */
export function table(k: Kit, w: number, d: number, h: number, o: { color?: string; legs?: string; lower?: boolean; messy?: number; mode?: 'pile' | 'shelf' | 'single'; want?: RegExp; big?: boolean; cloth?: string; pitch?: number } = {}) {
  const top = mat(o.color ?? '#8a6a4a', { rough: 0.6 });
  const leg = mat(o.legs ?? '#2a2a2a', { rough: 0.5, metal: 0.4 });
  k.box(top, w, 0.04, d, 0, h - 0.04, 0);
  if (o.cloth) k.box(mat(o.cloth, { rough: 0.95 }), w + 0.02, h - 0.06, d + 0.02, 0, 0.02, 0);
  else for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(leg, 0.04, h - 0.04, 0.04, x * (w / 2 - 0.05), 0, z * (d / 2 - 0.05));
  if (o.lower && !o.cloth) {
    k.box(top, w - 0.06, 0.03, d - 0.06, 0, 0.18, 0);
    k.seg(o.mode === 'single' ? 'pile' : (o.mode ?? 'pile'), 0, 0.21, d / 2 - 0.05, w - 0.15, d - 0.15, h - 0.3, { messy: o.messy ?? 0.5, pitch: o.pitch });
  }
  k.seg(o.mode ?? 'pile', 0, h, d / 2 - 0.04, w - 0.1, d - 0.08, 0.6, { messy: o.messy ?? 0.5, want: o.want, big: o.big, pitch: o.pitch });
  k.col(0, 0, w + 0.05, d + 0.05);
}

/** Stepped display (toys, plants): three tiers rising to the back. */
export function tiered(k: Kit, w: number, o: { color?: string; slats?: boolean; want?: RegExp; messy?: number } = {}) {
  const m = mat(o.color ?? '#f2b705', { rough: 0.55 });
  const steps = [[0.35, 0.0], [0.65, -0.38], [0.95, -0.76]];
  for (const [h, z] of steps) {
    if (o.slats) {
      for (let i = 0; i < 4; i++) k.box(m, w, 0.03, 0.07, 0, h - 0.03, z + 0.15 - i * 0.1);
      for (const x of [-w / 2 + 0.05, w / 2 - 0.05]) k.box(mat('#4a3a2a'), 0.05, h - 0.03, 0.05, x, 0, z);
    } else k.box(m, w, h, 0.38, 0, 0, z);
    k.seg('shelf', 0, h, z + 0.17, w - 0.08, 0.34, 0.6, { messy: o.messy ?? 0.3, want: o.want, maxRows: 1 });
  }
  k.col(0, -0.38, w + 0.05, 1.18);
}

/** Glass showcase counter: lit, two glass shelves of goods. */
export function showcase(k: Kit, len: number, o: { frame?: string; h?: number } = {}) {
  const H = o.h ?? 1.0, D = 0.6;
  const fr = mat(o.frame ?? '#2a2a2a', { rough: 0.4, metal: 0.5 });
  k.box(fr, len, 0.2, D, 0, 0, 0);
  k.box(mat('#f0f0ee', { rough: 0.5 }), len - 0.04, 0.01, D - 0.04, 0, 0.2, 0);
  k.box(fr, len, 0.03, D, 0, H - 0.03, 0);
  for (const x of [-len / 2, len / 2]) k.box(fr, 0.03, H - 0.2, D, x, 0.2, 0);
  k.box(M.emit('#f8fbff', 2.5), len - 0.08, 0.01, 0.02, 0, H - 0.05, -D / 2 + 0.06);
  k.box(glass(), len - 0.06, 0.008, D - 0.08, 0, 0.6, 0);
  k.seg('shelf', 0, 0.21, D / 2 - 0.06, len - 0.1, D - 0.12, 0.36, { messy: 0.4, maxRows: 2 });
  k.seg('shelf', 0, 0.61, D / 2 - 0.06, len - 0.1, D - 0.12, H - 0.68, { messy: 0.3, maxRows: 2 });
  k.face(glass(), len - 0.04, H - 0.23, 0, 0.2 + (H - 0.23) / 2, D / 2, undefined, 0, true);
  const topGlass = k.face(glass(), len - 0.04, D - 0.04, 0, H - 0.02, 0, undefined, 0, true);
  topGlass.rotation.x = -Math.PI / 2;
  k.col(0, 0, len + 0.04, D + 0.04);
}

/** Tall glass curio cabinet (antiques, models). */
export function curio(k: Kit, w: number, o: { wood?: string; shelves?: number; pitch?: number } = {}) {
  const H = 1.95, D = 0.45, n = o.shelves ?? 4;
  const wood = mat(o.wood ?? '#4a2e1a', { rough: 0.5 });
  k.box(wood, w, 0.12, D, 0, 0, -D / 2);
  k.box(wood, w, 0.08, D, 0, H - 0.08, -D / 2);
  k.box(wood, w, H, 0.02, 0, 0, -D + 0.01);
  for (const x of [-w / 2, w / 2]) k.box(wood, 0.04, H, D, x, 0, -D / 2);
  for (let i = 0; i < n; i++) {
    const y = 0.12 + (i * (H - 0.25)) / n;
    if (i > 0) k.box(glass(), w - 0.06, 0.008, D - 0.04, 0, y, -D / 2);
    k.seg('shelf', 0, y + 0.01, -0.04, w - 0.08, D - 0.08, (H - 0.25) / n - 0.04, { messy: 0.5, maxRows: 2, pitch: o.pitch });
  }
  k.box(M.emit('#fff1d6', 1.5), w - 0.1, 0.01, 0.02, 0, H - 0.1, -0.08);
  k.face(glass(), w - 0.04, H - 0.2, 0, H / 2, 0.003, undefined, 0, true);
  k.col(0, -D / 2, w + 0.04, D + 0.04);
}

/** Floor-to-ceiling wall shelving with a rolling library ladder on a rail. */
export function tallWall(k: Kit, len: number, H: number, o: { color?: string; shelves?: number; ladder?: boolean; books?: boolean; pitch?: number } = {}) {
  const wood = mat(o.color ?? '#6a4a2a', { rough: 0.6 });
  const D = 0.42, n = o.shelves ?? 7;
  k.box(wood, len, H, 0.02, 0, 0, -D + 0.01);
  const bays = Math.max(1, Math.round(len / 0.9));
  for (let i = 0; i <= bays; i++) k.box(wood, 0.03, H, D, -len / 2 + (len * i) / bays, 0, -D / 2);
  for (let j = 0; j < n; j++) {
    const y = 0.1 + (j * (H - 0.2)) / n;
    k.box(wood, len, 0.03, D, 0, y - 0.03, -D / 2);
    if (o.books && j % 2 === 1) {
      const s = bookSpines(j * 7 + len * 10);
      k.face(surfMat(s, { rough: 0.8 }), len - 0.04, (H - 0.2) / n - 0.06, 0, y + ((H - 0.2) / n - 0.06) / 2, -D + 0.03, [1.2, (H - 0.2) / n - 0.06]);
    } else
      for (let i = 0; i < bays; i++) {
        const x = -len / 2 + (len * (i + 0.5)) / bays;
        k.seg('shelf', x, y, -0.03, len / bays - 0.06, D - 0.06, (H - 0.2) / n - 0.06, { messy: 0.5, maxRows: 2, pitch: o.pitch });
      }
  }
  k.box(wood, len, 0.05, D, 0, H - 0.05, -D / 2);
  if (o.ladder) {
    // rail and ladder leaning out from it
    k.cyl(M.chrome(), 0.015, len, 0, H - 0.35, 0.05, 'x');
    const lx = -len / 4;
    const lad = mat('#5a3a1e', { rough: 0.5 });
    for (const sx of [-0.22, 0.22]) {
      const rail = k.box(lad, 0.05, H - 0.3, 0.04, lx + sx, 0, 0.45);
      rail.rotation.x = -0.16;
      rail.position.z = 0.25;
    }
    for (let i = 1; i < 10; i++) {
      const y = (i * (H - 0.4)) / 10;
      const rung = k.box(lad, 0.44, 0.03, 0.08, lx, y, 0.45 - y * 0.16);
      void rung;
    }
  }
  k.col(0, -D / 2, len, D + 0.05);
}

/** Chrome wire shelving unit (restaurant supply). */
export function wireRack(k: Kit, len: number, o: { h?: number; shelves?: number; d?: number; double?: boolean } = {}) {
  const H = o.h ?? 2.0, n = o.shelves ?? 5, D = o.d ?? 0.6;
  const c = M.chrome();
  for (const x of [-len / 2 + 0.02, len / 2 - 0.02]) for (const z of [-D / 2 + 0.02, D / 2 - 0.02]) k.cyl(c, 0.014, H, x, 0, z);
  for (let j = 0; j < n; j++) {
    const y = 0.15 + (j * (H - 0.25)) / (n - 1);
    k.box(mat('#c8cacd', { rough: 0.3, metal: 0.9 }), len, 0.025, D, 0, y - 0.025, 0);
    if (j < n - 1 || H < 1.9) k.seg('shelf', 0, y, D / 2 - 0.03, len - 0.06, D - 0.06, (H - 0.25) / (n - 1) - 0.05, { messy: 0.35, maxRows: 3 });
  }
  k.col(0, 0, len + 0.04, D + 0.04);
}

/** Heavy pallet racking: blue uprights, orange beams. */
export function palletRack(k: Kit, len: number, o: { h?: number; levels?: number } = {}) {
  const H = o.h ?? 3.0, n = o.levels ?? 3, D = 1.0;
  const up = mat('#1f4fa0', { rough: 0.5, metal: 0.4 }), beam = mat('#e86a10', { rough: 0.5, metal: 0.3 });
  const bays = Math.max(1, Math.round(len / 2.4));
  for (let i = 0; i <= bays; i++) for (const z of [-D / 2, D / 2]) k.box(up, 0.08, H, 0.08, -len / 2 + (len * i) / bays, 0, z);
  for (let j = 0; j < n; j++) {
    const y = 0.15 + (j * (H - 0.3)) / n;
    for (const z of [-D / 2, D / 2]) k.box(beam, len, 0.1, 0.05, 0, y - 0.1, z);
    k.box(mat('#8a8a80', { rough: 0.7 }), len, 0.02, D, 0, y, 0);
    for (let i = 0; i < bays; i++) k.seg('shelf', -len / 2 + (len * (i + 0.5)) / bays, y + 0.02, D / 2 - 0.05, len / bays - 0.1, D - 0.1, (H - 0.3) / n - 0.15, { messy: 0.2, big: true, maxRows: 2 });
  }
  k.col(0, 0, len + 0.1, D + 0.1);
}

/** Guitar wall: two staggered rows of hooks on a dark slatwall. */
export function guitarWall(k: Kit, len: number, o: { color?: string; want?: RegExp } = {}) {
  const s = slatwall(o.color ?? '#2a2622');
  k.face(surfMat(s, { rough: 0.8 }), len, 2.6, 0, 1.4, 0.012, s.tile);
  const want = o.want ?? /guitar|bass|ukulele|violin|banjo|mandolin|cello|viola|fiddle|harp|lute|sitar/i;
  const n = Math.max(1, Math.floor(len / 0.5));
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < n - row; i++) {
      const x = -len / 2 + (len * (i + 0.5 + row * 0.5)) / n;
      k.box(M.chrome(), 0.02, 0.02, 0.12, x, row ? 2.55 : 1.55, 0.07);
    }
    k.seg('hang', 0, row ? 1.62 : 0.5, 0.02, len - 0.1, 0.25, 1.05, { want, big: true, messy: 0.1, pitch: 0.46 });
  }
}

/** Combo amp: tolex box, grille cloth, control strip. */
export function amp(k: Kit, x: number, z: number, s: number, ry = 0) {
  const g = new THREE.Group();
  const b = (m: THREE.Material, w: number, h: number, d: number, px: number, py: number, pz: number) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(px, py + h / 2, pz);
    g.add(o);
  };
  b(mat('#151515', { rough: 0.85 }), 0.6 * s, 0.5 * s, 0.28 * s, 0, 0, 0);
  b(mat('#3a3328', { rough: 1 }), 0.54 * s, 0.34 * s, 0.01, 0, 0.04 * s, 0.14 * s);
  b(mat('#c9a86a', { rough: 0.3, metal: 0.8 }), 0.54 * s, 0.07 * s, 0.01, 0, 0.4 * s, 0.14 * s);
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  k.add(g);
}

/** Wall-mounted TVs showing demo loops. */
export function tvWall(k: Kit, n: number, y: number, seed: number) {
  for (let i = 0; i < n; i++) {
    const w = 0.9 + ((seed + i) % 3) * 0.25, h = w * 0.5625;
    const x = (i - (n - 1) / 2) * 1.5;
    k.box(M.black(), w + 0.03, h + 0.03, 0.04, x, y - h / 2, 0.03);
    k.face(lit(screenTex(seed * 10 + i)), w, h, x, y, 0.052);
  }
}

/** Platform for showroom pieces (one product standing on it). */
export function plinth(k: Kit, w: number, d: number, h: number, o: { color?: string; want?: RegExp } = {}) {
  k.box(mat(o.color ?? '#f2efe8', { rough: 0.45 }), w, h, d, 0, 0, 0);
  k.seg('single', 0, h, d / 2, w - 0.1, d - 0.1, 2.0, { big: true, want: o.want });
  k.col(0, 0, w + 0.05, d + 0.05);
}

export function rug(k: Kit, w: number, d: number, seed: number) {
  const m = new THREE.MeshStandardMaterial({ map: rugTex(seed % 8), roughness: 1 });
  const q = k.face(m, w, d, 0, 0.006, 0);
  q.rotation.x = -Math.PI / 2;
}

/** Stack of cardboard boxes / shrink-wrapped cases. */
export function boxStack(k: Kit, r: Rng, w: number, d: number, maxH: number, o: { water?: boolean } = {}) {
  const cb = [mat('#b08a5a', { rough: 0.9 }), mat('#a07a4a', { rough: 0.9 }), mat('#c29a68', { rough: 0.9 })];
  const wtr = [mat('#2a7fc0', { rough: 0.4 }), mat('#3d8fd0', { rough: 0.35 })];
  let y = 0;
  while (y < maxH - 0.2) {
    const bh = o.water ? 0.26 : r.range(0.25, 0.45);
    const nx = Math.max(1, Math.round(w / (o.water ? 0.4 : r.range(0.35, 0.6))));
    for (let i = 0; i < nx; i++) {
      if (y > 0 && r.chance(0.2)) continue;
      const bw = w / nx - 0.02;
      const b = k.box(r.pick(o.water ? wtr : cb), bw, bh, d - r.range(0, 0.1), -w / 2 + (w * (i + 0.5)) / nx + r.range(-0.03, 0.03), y, r.range(-0.03, 0.03));
      b.rotation.y = r.range(-0.06, 0.06);
    }
    y += bh;
  }
  k.col(0, 0, w + 0.05, d + 0.05);
}

/** ATM kiosk. */
export function atm(k: Kit) {
  k.box(mat('#3a3d42', { rough: 0.4, metal: 0.5 }), 0.55, 1.5, 0.5, 0, 0, 0);
  k.box(mat('#202226'), 0.5, 0.4, 0.05, 0, 1.0, 0.25).rotation.x = -0.2;
  k.face(lit(screenTex(901)), 0.3, 0.22, 0, 1.25, 0.285);
  k.face(lit(textTex('ATM', '#1565c0', '#ffffff', { w: 256, h: 96 })), 0.5, 0.18, 0, 1.6, 0.252);
  k.col(0, 0, 0.6, 0.55);
}

/** Bodega cat: an orange tabby (or tuxedo) loafing or sitting. */
export function cat(k: Kit, x: number, y: number, z: number, ry: number, r: Rng) {
  const fur = mat(r.pick(['#d98c3a', '#c47a2c', '#3a3530', '#8a8580']), { rough: 1 });
  const white = mat('#f2efe8', { rough: 1 });
  const g = new THREE.Group();
  const s = (m: THREE.Material, sx: number, sy: number, sz: number, px: number, py: number, pz: number) => {
    const o = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), m);
    o.scale.set(sx, sy, sz);
    o.position.set(px, py, pz);
    g.add(o);
    return o;
  };
  const sitting = r.chance(0.5);
  if (sitting) {
    s(fur, 0.2, 0.26, 0.26, 0, 0.13, 0);
    s(white, 0.12, 0.16, 0.1, 0, 0.16, 0.1);
    s(fur, 0.15, 0.14, 0.14, 0, 0.32, 0.06);
    s(white, 0.07, 0.05, 0.05, 0, 0.3, 0.13);
    for (const sx of [-0.045, 0.045]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.06, 8), fur);
      ear.position.set(sx, 0.4, 0.05);
      g.add(ear);
      s(white, 0.04, 0.03, 0.06, sx, 0.02, 0.12);
      s(mat('#c9d84a', { rough: 0.2, emissive: '#2a3000', ei: 0.4 }), 0.022, 0.018, 0.01, sx * 0.8, 0.335, 0.125);
    }
    const tail = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.025, 8, 16, Math.PI * 1.1), fur);
    tail.rotation.x = Math.PI / 2;
    tail.position.set(0, 0.02, 0.0);
    g.add(tail);
  } else {
    // loaf: body, head tucked in, paws under
    s(fur, 0.22, 0.17, 0.38, 0, 0.085, 0);
    s(fur, 0.14, 0.13, 0.13, 0, 0.17, 0.17);
    s(white, 0.07, 0.05, 0.05, 0, 0.15, 0.23);
    for (const sx of [-0.045, 0.045]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.06, 8), fur);
      ear.position.set(sx, 0.25, 0.16);
      g.add(ear);
      s(mat('#c9d84a', { rough: 0.2, emissive: '#2a3000', ei: 0.4 }), 0.022, 0.012, 0.01, sx * 0.8, 0.185, 0.235);
    }
    const tail = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.024, 8, 16, Math.PI * 0.9), fur);
    tail.rotation.set(Math.PI / 2, 0, Math.PI * 0.4);
    tail.position.set(0.02, 0.025, -0.08);
    g.add(tail);
  }
  g.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).castShadow = true) : null));
  g.position.set(x, y, z);
  g.rotation.y = ry;
  k.add(g);
}

// ---------------------------------------------------------------- lighting fixtures

/** 2x4 lay-in troffer flush with a drop ceiling. */
export function trofferAt(k: Kit, x: number, y: number, z: number, along: 'x' | 'z' = 'z') {
  const q = k.face(printed(troffer(), { emissive: 2.4 }), along === 'z' ? 0.6 : 1.2, along === 'z' ? 1.2 : 0.6, x, y - 0.005, z);
  q.rotation.x = Math.PI / 2;
}
/** Hanging 2-tube fluorescent strip on chains / rods. */
export function tubeAt(k: Kit, x: number, y: number, z: number, len: number, ceil: number, along: 'x' | 'z' = 'z') {
  const lx = along === 'x' ? len : 0.22, lz = along === 'z' ? len : 0.22;
  k.box(mat('#e8e8e4', { rough: 0.4, metal: 0.3 }), lx, 0.06, lz, x, y, z);
  const tubeM = M.emit('#f2f7ff', 3.0);
  for (const o of [-0.05, 0.05]) k.box(tubeM, along === 'x' ? len - 0.05 : 0.035, 0.035, along === 'z' ? len - 0.05 : 0.035, x + (along === 'z' ? o : 0), y - 0.035, z + (along === 'x' ? o : 0));
  for (const e of [-len / 2 + 0.2, len / 2 - 0.2]) k.box(M.dark(), 0.01, ceil - y - 0.06, 0.01, x + (along === 'x' ? e : 0), y + 0.06, z + (along === 'z' ? e : 0));
}
/** Track light: a rail with cans pointed down-ish. */
export function trackAt(k: Kit, x: number, y: number, z: number, len: number, cans: number, along: 'x' | 'z' = 'x', color = '#1a1a1a') {
  const m = mat(color, { rough: 0.4, metal: 0.4 });
  k.box(m, along === 'x' ? len : 0.04, 0.03, along === 'z' ? len : 0.04, x, y - 0.03, z);
  for (let i = 0; i < cans; i++) {
    const t = -len / 2 + (len * (i + 0.5)) / cans;
    const cx = x + (along === 'x' ? t : 0), cz = z + (along === 'z' ? t : 0);
    k.box(m, 0.02, 0.08, 0.02, cx, y - 0.11, cz);
    const can = k.cyl(m, 0.05, 0.16, cx, y - 0.2, cz, 'z');
    can.rotation.x = Math.PI / 2 + (i % 2 ? 0.5 : -0.5);
    k.cyl(M.emit('#fff2d8', 4), 0.04, 0.005, cx, y - 0.29, cz);
  }
}
/** Pendant: cone shade and a glowing bulb. */
export function pendantAt(k: Kit, x: number, y: number, z: number, ceil: number, color = '#1d3b2e') {
  k.box(M.dark(), 0.008, ceil - y, 0.008, x, y, z);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.2, 20, 1, true), mat(color, { rough: 0.4, metal: 0.4 }));
  shade.position.set(x, y - 0.08, z);
  k.add(shade);
  k.sph(M.emit('#ffe2b0', 4), 0.09, 0.09, 0.09, x, y - 0.17, z);
}
/** Bare bulb on a cord. */
export function bulbAt(k: Kit, x: number, y: number, z: number, ceil: number) {
  k.box(M.black(), 0.006, ceil - y, 0.006, x, y, z);
  k.sph(M.emit('#ffd59a', 5), 0.07, 0.09, 0.07, x, y - 0.03, z);
}
/** Brass chandelier with candle bulbs and crystal drops. */
export function chandelierAt(k: Kit, x: number, y: number, z: number, ceil: number, r: Rng) {
  const brass = mat('#b8913a', { rough: 0.3, metal: 0.9 });
  const crystal = mat('#f4f8ff', { rough: 0.05, emissive: '#fff4e0', ei: 0.3 });
  k.box(brass, 0.012, ceil - y - 0.2, 0.012, x, y + 0.2, z);
  const rad = r.range(0.25, 0.4);
  k.sph(brass, 0.12, 0.2, 0.12, x, y + 0.05, z);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(rad, 0.012, 6, 24), brass);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(x, y, z);
  k.add(ring);
  const arms = r.int(5, 8);
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2;
    const cx = x + Math.cos(a) * rad, cz = z + Math.sin(a) * rad;
    k.cyl(M.white(), 0.012, 0.08, cx, y + 0.01, cz);
    k.sph(M.emit('#ffd9a0', 5), 0.025, 0.04, 0.025, cx, y + 0.11, cz);
    k.sph(crystal, 0.025, 0.05, 0.025, x + Math.cos(a + 0.3) * rad * 0.8, y - 0.08, z + Math.sin(a + 0.3) * rad * 0.8);
  }
}

/** Hanging double-sided sign (aisle numbers, departments). */
export function hangSign(k: Kit, t: THREE.Texture, w: number, h: number, x: number, y: number, z: number, ceil: number, ry = 0) {
  for (const s of [0, Math.PI]) {
    const q = k.face(lit(t), w, h, x + Math.sin(ry + s) * 0.006, y, z + Math.cos(ry + s) * 0.006, undefined, ry + s);
    void q;
  }
  for (const e of [-w / 2 + 0.05, w / 2 - 0.05]) k.box(M.dark(), 0.006, ceil - y - h / 2, 0.006, x + Math.cos(ry) * e, y + h / 2, z - Math.sin(ry) * e);
}

export function modelLayout(k: Kit, w: number, d: number) {
  k.box(mat('#3a2a1e', { rough: 0.6 }), w, 0.85, d, 0, 0, 0);
  const q = k.face(printed(layoutTex(), { rough: 0.95 }), w - 0.04, d - 0.04, 0, 0.852, 0);
  q.rotation.x = -Math.PI / 2;
  k.seg('pile', 0, 0.86, d / 2 - 0.1, w - 0.4, d - 0.4, 0.3, { messy: 0.2, want: /train|locomotive|wagon|tram|car|truck|bus|house|tree|station/i });
  k.col(0, 0, w + 0.05, d + 0.05);
}

export type { Seg };
