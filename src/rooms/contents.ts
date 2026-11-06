import * as THREE from 'three';
import { Kit } from './kit';
import { M } from './mats';
import { Rng } from '../rng';

/**
 * What is inside closed furniture, generated only when a container is opened.
 * Each generator works in the container's frame (front-centre base at the origin, front toward +z,
 * outer size w x h x d) and returns a group of merged meshes at real scale.
 */

const CLOTHES = ['#2f3d4f', '#e9e4da', '#8a3b3b', '#3d5a40', '#c9b48a', '#1f1f22', '#7b8a9a', '#d9c2a0', '#5a3a5e', '#f2f0ea'];

function done(k: Kit) {
  const g = new THREE.Group();
  k.finish(g, false);
  return g;
}

/** folded clothes stacked in each drawer row */
export function drawerContents(seed: number, w: number, h: number, d: number, rows: number, bottom = 0.1) {
  const r = new Rng(seed);
  const k = new Kit();
  const rowH = (h - bottom - 0.05) / rows;
  for (let i = 0; i < rows; i++) {
    const y = bottom + rowH * i + 0.02;
    const stacks = Math.max(1, Math.floor((w - 0.08) / 0.32));
    for (let s = 0; s < stacks; s++) {
      const x = -w / 2 + 0.06 + (s + 0.5) * ((w - 0.12) / stacks);
      const n = r.int(1, Math.max(1, Math.floor((rowH - 0.06) / 0.035)));
      const cd = Math.min(0.24, d - 0.1);
      for (let j = 0; j < n; j++) k.box(M.fabric(r.pick(CLOTHES)), 0.26 + r.range(-0.02, 0.01), 0.032, cd, x + r.range(-0.01, 0.01), y + j * 0.034, -d / 2 + 0.04 + cd / 2, r.range(-0.03, 0.03));
    }
    // socks and small things in front
    if (r.chance(0.5) && d > 0.36) for (let j = 0; j < 4; j++) k.sphere(M.fabric(r.pick(CLOTHES)), 0.035, r.range(-w / 2 + 0.1, w / 2 - 0.1), y + 0.022, d / 2 - 0.06, 0.6);
  }
  return done(k);
}

/** base kitchen cabinets: stacked plates, bowls, pots */
export function cabinetContents(seed: number, w: number, h: number, d: number) {
  const r = new Rng(seed);
  const k = new Kit();
  const shelfY = [0.14, 0.14 + (h - 0.3) / 2];
  for (const y of shelfY) {
    k.box(M.trim(), w - 0.04, 0.018, d - 0.1, 0, y - 0.018, -0.04);
    // items left to right, each only if it fits in the width
    let x = -w / 2 + 0.03;
    for (let tries = 0; tries < 8; tries++) {
      const kind = r.int(0, 2);
      const iw = kind === 0 ? 0.27 : kind === 1 ? 0.17 : 0.27;
      if (x + iw > w / 2 - 0.03) {
        if (tries > 3) break;
        continue;
      }
      const cx = x + iw / 2;
      if (kind === 0) {
        const n = r.int(4, 9);
        for (let i = 0; i < n; i++) k.cyl(M.porcelain(), 0.13, 0.11, 0.018, cx, y + i * 0.019, -0.1, 20);
      } else if (kind === 1) {
        for (let i = 0; i < 3; i++) k.cyl(M.enamel(r.pick(['#f4f1ea', '#2d4f6b', '#c9b79c'])), 0.08 - i * 0.004, 0.05, 0.07, cx, y + i * 0.03, -0.1, 16);
      } else {
        k.cyl(M.steel(), 0.12, 0.11, 0.15, cx, y, -0.08, 18);
      }
      x += iw + 0.03;
    }
  }
  return done(k);
}

/** wall cabinets: glasses and mugs on two shelves */
export function upperContents(seed: number, w: number, h: number, d: number) {
  const r = new Rng(seed);
  const k = new Kit();
  for (const y of [0.02, h / 2]) {
    if (y > 0.02) k.box(M.trim(), w - 0.04, 0.016, d - 0.06, 0, y - 0.016, -0.02);
    for (let x = -w / 2 + 0.08; x < w / 2 - 0.08; x += 0.1) {
      if (r.chance(0.5)) k.cyl(M.glass(), 0.035, 0.03, 0.12, x, y, -d / 2 + 0.1 + r.range(0, 0.1), 12);
      else {
        k.cyl(M.enamel(r.pick(['#f4f1ea', '#2d4f6b', '#c4553a', '#e8c86a'])), 0.042, 0.04, 0.095, x, y, -d / 2 + 0.12, 12);
      }
    }
  }
  return done(k);
}

/** the inside of a fridge: white liner, glass shelves, bottles, cartons, jars, fruit */
export function fridgeContents(seed: number, w: number, h: number, d: number) {
  const r = new Rng(seed);
  const k = new Kit();
  const liner = M.enamel('#f3f5f6');
  k.box(liner, w - 0.06, h - 0.1, 0.02, 0, 0.05, -d / 2 + 0.04);
  for (const sx of [-1, 1]) k.box(liner, 0.02, h - 0.1, d - 0.1, sx * (w / 2 - 0.04), 0.05, 0);
  const shelves = [0.35, 0.75, 1.1, 1.42];
  for (const y of shelves) {
    k.box(M.glass(), w - 0.1, 0.008, d - 0.15, 0, y, -0.02);
    let x = -w / 2 + 0.08;
    for (let tries = 0; tries < 12; tries++) {
      const kind = r.int(0, 4);
      const iw = [0.08, 0.09, 0.09, 0.32, 0.17][kind];
      if (x + iw > w / 2 - 0.06) continue;
      x += iw / 2;
      if (kind === 0) {
        // bottle
        k.cyl(M.enamel(r.pick(['#3d6b3d', '#a83a2a', '#e8e0c8', '#2a4a7a'])), 0.035, 0.035, 0.22, x, y + 0.008, -0.1, 12);
        k.cyl(M.black(), 0.013, 0.013, 0.04, x, y + 0.23, -0.1, 8);
      } else if (kind === 1) {
        // milk/juice carton
        k.box(M.enamel(r.pick(['#f4f2ec', '#f2c84a', '#e86a3a'])), 0.07, 0.2, 0.07, x, y + 0.008, -0.08);
      } else if (kind === 2) {
        // jars
        k.cyl(M.enamel(r.pick(['#c8321e', '#e8a020', '#7a4a2a'])), 0.04, 0.04, 0.1, x, y + 0.008, -0.12, 12);
        k.cyl(M.steel(), 0.042, 0.042, 0.02, x, y + 0.11, -0.12, 12);
      } else if (kind === 3) {
        // egg carton
        k.box(M.matte('#c9b8a0'), 0.3, 0.07, 0.11, x, y + 0.008, -0.08);
      } else {
        // fruit and vegetables in a bowl
        for (let i = 0; i < 4; i++) k.sphere(M.enamel(r.pick(['#c8321e', '#e8a020', '#8ab83a', '#e8d040'])), 0.035, x + r.range(-0.045, 0.045), y + 0.04, -0.1 + r.range(-0.05, 0.05));
      }
      x += iw / 2 + 0.02;
    }
  }
  // crisper drawers
  k.box(M.frosted(), w - 0.1, 0.2, d - 0.15, 0, 0.1, -0.02);
  return done(k);
}

/** a hanging closet: rod, coats and shirts on hangers, shoes below, boxes on the shelf */
export function closetContents(seed: number, w: number, h: number, d: number) {
  const r = new Rng(seed);
  const k = new Kit();
  const rodY = Math.min(h - 0.35, 1.8);
  k.rod(M.chrome(), 0.013, w - 0.06, 0, rodY, -d / 2 + 0.3, 'x', 8);
  k.box(M.trim(), w - 0.04, 0.02, d - 0.06, 0, rodY + 0.18, -0.02);
  for (let x = -w / 2 + 0.08; x < w / 2 - 0.06; x += r.range(0.05, 0.09)) {
    const long = r.chance(0.35);
    const len = long ? r.range(0.9, 1.15) : r.range(0.6, 0.75);
    const c = M.fabric(r.pick(CLOTHES));
    k.box(M.black(), 0.012, 0.02, 0.4, x, rodY - 0.05, -d / 2 + 0.3);
    k.box(c, 0.025, len, Math.min(0.48, d - 0.12), x, rodY - 0.06 - len, -d / 2 + 0.3);
  }
  for (let x = -w / 2 + 0.12; x < w / 2 - 0.12; x += 0.3) {
    const sh = M.leather(r.pick(['#2a1a10', '#5a3a28', '#1a1a1a', '#8a6a4a']));
    for (const dx of [-0.05, 0.05]) k.rbox(sh, 0.09, 0.08, 0.27, 0.03, x + dx, 0.02, -0.02);
  }
  const room = h - (rodY + 0.2) - 0.02;
  if (room > 0.1) for (let x = -w / 2 + 0.2; x < w / 2 - 0.2; x += 0.42) if (r.chance(0.7)) k.box(M.matte(r.pick(['#c9b8a0', '#e8e2d6', '#8a7a6a'])), 0.36, Math.min(room, r.range(0.15, 0.3)), d - 0.2, x, rodY + 0.2, -0.04);
  return done(k);
}
