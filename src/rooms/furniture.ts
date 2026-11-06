import * as THREE from 'three';
import type { Kit } from './kit';
import { M } from './mats';
import type { Rng } from '../rng';

/**
 * Procedural furniture and fixtures at real-world dimensions (see docs/research/interiors.md).
 * Every piece is drawn in the Kit's current frame with its back against local -z and its front
 * facing +z, centred on x, standing on y = 0. Each returns its footprint and the surfaces things
 * can be set on (local coordinates).
 */
export interface Top {
  x: number;
  z: number;
  y: number;
  w: number;
  d: number;
}
export interface Piece {
  w: number;
  d: number;
  h: number;
  tops: Top[];
  /** local positions of glowing lamp shades (for glow sprites / lights) */
  lamps?: THREE.Vector3[];
  /** closed compartments (centre of base, local; front toward +z) */
  boxes?: { kind: 'cabinet' | 'upper' | 'fridge' | 'dresser' | 'closet'; x: number; y: number; z: number; w: number; h: number; d: number; doors?: 'left' | 'right' | 'pair' }[];
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export function sofa(k: Kit, r: Rng, w: number, fabric: THREE.Material, legs: THREE.Material, accent: THREE.Material[]): Piece {
  const d = 0.92, arm = 0.17, seatH = 0.44;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(legs, 0.018, 0.025, 0.1, sx * (w / 2 - 0.08), 0, sz * (d / 2 - 0.08), 8);
  k.rbox(fabric, w, 0.22, d, 0.03, 0, 0.1, 0);
  // arms
  for (const sx of [-1, 1]) k.rbox(fabric, arm, 0.55, d, 0.06, sx * (w / 2 - arm / 2), 0.1, 0);
  // back
  k.rbox(fabric, w - 2 * arm + 0.02, 0.5, 0.2, 0.05, 0, 0.3, -d / 2 + 0.1);
  const n = w > 1.9 ? 3 : 2;
  const cw = (w - 2 * arm) / n;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + arm + cw * (i + 0.5);
    k.rbox(fabric, cw - 0.01, 0.13, d - 0.22, 0.05, x, 0.31, 0.1);
    // back cushions lean back a little
    k.push(x, seatH, -d / 2 + 0.27, 0);
    k.boxM(fabric, cw - 0.03, 0.42, 0.14, 0, 0.2, 0, new THREE.Euler(-0.16, 0, 0));
    k.pop();
  }
  // throw pillows at the arms, two deep on long sofas
  for (const sx of [-1, 1]) {
    if (!r.chance(0.9)) continue;
    const two = w > 2.0 && r.chance(0.7);
    k.push(sx * (w / 2 - arm - 0.24), seatH + 0.02, -d / 2 + 0.38, sx * -0.25);
    k.boxM(r.pick(accent), 0.46, 0.44, 0.13, 0, 0.21, -0.02, new THREE.Euler(-0.3, 0, sx * 0.08));
    if (two) k.boxM(r.pick(accent), 0.36, 0.34, 0.11, sx * -0.12, 0.17, 0.09, new THREE.Euler(-0.25, 0, sx * -0.1));
    k.pop();
  }
  // a throw folded over one arm
  if (r.chance(0.6)) {
    const sx = r.chance(0.5) ? -1 : 1;
    const t = r.pick(accent);
    k.box(t, arm + 0.05, 0.025, 0.55, sx * (w / 2 - arm / 2), 0.65, 0.08);
    k.box(t, 0.025, 0.4, 0.55, sx * (w / 2 + 0.012), 0.27, 0.08);
    k.box(t, 0.025, 0.25, 0.55, sx * (w / 2 - arm - 0.012), 0.42, 0.08);
  }
  return { w, d, h: 0.85, tops: [] };
}

export function armchair(k: Kit, fabric: THREE.Material, legs: THREE.Material): Piece {
  const w = 0.82, d = 0.84, arm = 0.15;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(legs, 0.016, 0.022, 0.12, sx * (w / 2 - 0.07), 0, sz * (d / 2 - 0.07), 8);
  k.rbox(fabric, w, 0.2, d, 0.03, 0, 0.12, 0);
  for (const sx of [-1, 1]) k.rbox(fabric, arm, 0.48, d, 0.06, sx * (w / 2 - arm / 2), 0.12, 0);
  k.rbox(fabric, w - 2 * arm, 0.12, d - 0.2, 0.05, 0, 0.32, 0.08);
  k.push(0, 0.32, -d / 2 + 0.12, 0);
  k.boxM(fabric, w - 0.02, 0.6, 0.18, 0, 0.3, 0, new THREE.Euler(-0.14, 0, 0));
  k.pop();
  return { w, d, h: 0.9, tops: [] };
}

export function coffeeTable(k: Kit, r: Rng, wood: THREE.Material, metal: THREE.Material, stone: THREE.Material): Piece {
  const kind = r.int(0, 2);
  if (kind === 0) {
    // round marble top on a brass base, as in reference 1
    const rad = 0.45, h = 0.42;
    k.cyl(stone, rad, rad, 0.03, 0, h - 0.03, 0, 32);
    k.cyl(metal, 0.03, 0.03, h - 0.03, 0, 0, 0, 10);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      k.push(Math.cos(a) * 0.17, 0.02, Math.sin(a) * 0.17, -a);
      k.box(metal, 0.36, 0.025, 0.03, 0, 0, 0);
      k.pop();
    }
    return { w: 0.9, d: 0.9, h, tops: [{ x: 0, z: 0, y: h, w: 0.6, d: 0.6 }] };
  }
  const w = r.range(1.0, 1.25), d = r.range(0.55, 0.65), h = 0.43;
  k.box(wood, w, 0.04, d, 0, h - 0.04, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(kind === 1 ? wood : metal, 0.045, h - 0.04, 0.045, sx * (w / 2 - 0.05), 0, sz * (d / 2 - 0.05));
  if (kind === 1) k.box(wood, w - 0.1, 0.025, d - 0.1, 0, 0.12, 0);
  return { w, d, h, tops: [{ x: 0, z: 0, y: h, w: w - 0.1, d: d - 0.1 }] };
}

export function sideTable(k: Kit, wood: THREE.Material, h = 0.56): Piece {
  const s = 0.45;
  k.box(wood, s, 0.035, s, 0, h - 0.035, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(wood, 0.035, h - 0.035, 0.035, sx * (s / 2 - 0.03), 0, sz * (s / 2 - 0.03));
  k.box(wood, s - 0.06, 0.02, s - 0.06, 0, 0.15, 0);
  return { w: s, d: s, h, tops: [{ x: 0, z: 0, y: h, w: s - 0.06, d: s - 0.06 }] };
}

export function tableLamp(k: Kit, r: Rng, x: number, y: number, z: number, shadeCol = '#efe2c6'): THREE.Vector3 {
  const kind = r.int(0, 2);
  const base = kind === 0 ? M.enamel(r.pick(['#2d4f6b', '#e8e2d4', '#6b7b5a', '#b0583a'])) : kind === 1 ? M.brass() : M.porcelain();
  if (kind === 1) {
    k.cyl(base, 0.07, 0.08, 0.02, x, y, z, 16);
    k.cyl(base, 0.012, 0.012, 0.4, x, y + 0.02, z, 8);
  } else {
    k.sphere(base, 0.1, x, y + 0.13, z, 1.3);
    k.cyl(base, 0.03, 0.05, 0.05, x, y, z, 12);
    k.cyl(M.brass(), 0.01, 0.01, 0.16, x, y + 0.25, z, 6);
  }
  k.unshadowed(() => k.cyl(M.shade(shadeCol), 0.12, 0.18, 0.24, x, y + 0.36, z, 20, true));
  return v(x, y + 0.45, z);
}

export function floorLamp(k: Kit, r: Rng): Piece {
  const metal = r.chance(0.5) ? M.brass() : M.black();
  k.cyl(metal, 0.15, 0.16, 0.025, 0, 0, 0, 20);
  k.cyl(metal, 0.012, 0.012, 1.42, 0, 0.025, 0, 8);
  k.unshadowed(() => k.cyl(M.shade(r.pick(['#efe2c6', '#e9e4da', '#1d1d1f'])), 0.17, 0.22, 0.28, 0, 1.38, 0, 20, true));
  return { w: 0.4, d: 0.4, h: 1.66, tops: [], lamps: [v(0, 1.5, 0)] };
}

export function tvConsole(k: Kit, r: Rng, wood: THREE.Material): Piece {
  const w = r.range(1.5, 1.8), d = 0.42, h = 0.5;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(M.black(), 0.03, 0.12, 0.03, sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06));
  k.box(wood, w, h - 0.12, d, 0, 0.12, 0);
  const n = 3;
  for (let i = 1; i < n; i++) k.box(M.black(), 0.006, h - 0.16, 0.005, -w / 2 + (w * i) / n, 0.14, d / 2);
  for (let i = 0; i < n; i++) k.box(M.brass(), 0.12, 0.012, 0.015, -w / 2 + (w * (i + 0.5)) / n, h - 0.08, d / 2 + 0.005);
  // the television on its foot
  const tw = r.range(1.1, 1.3), th = tw * 0.575;
  k.box(M.black(), 0.3, 0.015, 0.2, 0, h, -0.04);
  k.box(M.black(), 0.06, 0.08, 0.03, 0, h, -0.06);
  k.box(M.black(), tw, th, 0.035, 0, h + 0.06, -0.06);
  k.box(M.screen(), tw - 0.02, th - 0.02, 0.002, 0, h + 0.07, -0.042);
  return { w, d, h: h + 0.06 + th, tops: [{ x: -w / 2 + 0.22, z: 0.02, y: h, w: 0.32, d: d - 0.1 }, { x: w / 2 - 0.22, z: 0.02, y: h, w: 0.32, d: d - 0.1 }] };
}

export function bed(k: Kit, r: Rng, w: number, wood: THREE.Material, linen: THREE.Material, duvet: THREE.Material, throwM: THREE.Material, head: THREE.Material): Piece {
  const l = 2.1;
  // frame and legs
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(wood, 0.06, 0.12, 0.06, sx * (w / 2 - 0.05), 0, sz * (l / 2 - 0.05));
  k.box(wood, w, 0.2, l - 0.08, 0, 0.12, 0.04);
  // mattress
  k.rbox(linen, w - 0.04, 0.24, l - 0.14, 0.05, 0, 0.3, 0.06);
  // duvet over the lower two-thirds, draping down the sides
  const dl = l * 0.74;
  const dz = l / 2 - dl / 2 + 0.02;
  k.rbox(duvet, w + 0.06, 0.09, dl, 0.04, 0, 0.5, dz);
  for (const sx of [-1, 1]) k.box(duvet, 0.03, 0.3, dl, sx * (w / 2 + 0.03), 0.25, dz);
  k.box(duvet, w + 0.09, 0.3, 0.03, 0, 0.25, l / 2 + 0.035);
  // folded-back top edge
  k.rbox(linen, w + 0.04, 0.05, 0.28, 0.02, 0, 0.55, dz - dl / 2 + 0.14);
  // throw across the foot
  k.box(throwM, w + 0.1, 0.03, 0.45, 0, 0.59, l / 2 - 0.3);
  for (const sx of [-1, 1]) k.box(throwM, 0.025, 0.28, 0.45, sx * (w / 2 + 0.06), 0.32, l / 2 - 0.3);
  // pillows leaning on the headboard
  const np = w > 1.3 ? 2 : 1;
  for (let i = 0; i < np; i++) {
    const x = np === 1 ? 0 : (i - 0.5) * (w / 2);
    k.push(x, 0.54, -l / 2 + 0.24, 0);
    k.boxM(linen, Math.min(0.68, w / np - 0.06), 0.16, 0.4, 0, 0.1, 0, new THREE.Euler(-0.9, 0, 0));
    k.pop();
    if (r.chance(0.6)) {
      k.push(x, 0.56, -l / 2 + 0.42, 0);
      k.boxM(throwM, Math.min(0.42, w / np - 0.2), 0.32, 0.1, 0, 0.12, 0, new THREE.Euler(-0.35, 0, 0));
      k.pop();
    }
  }
  // upholstered headboard
  k.rbox(head, w + 0.12, 1.15, 0.08, 0.03, 0, 0, -l / 2 - 0.02);
  return { w: w + 0.12, d: l + 0.06, h: 1.15, tops: [] };
}

export function nightstand(k: Kit, wood: THREE.Material): Piece {
  const w = 0.5, d = 0.4, h = 0.58;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(wood, 0.035, 0.12, 0.035, sx * (w / 2 - 0.03), 0, sz * (d / 2 - 0.03));
  k.box(wood, w, h - 0.12, d, 0, 0.12, 0);
  k.box(M.black(), w - 0.04, 0.005, 0.004, 0, 0.42, d / 2);
  k.sphere(M.brass(), 0.015, 0, 0.49, d / 2 + 0.012);
  return { w, d, h, tops: [{ x: 0, z: 0, y: h, w: w - 0.06, d: d - 0.06 }] };
}

export function dresser(k: Kit, r: Rng, wood: THREE.Material): Piece {
  const w = r.range(1.0, 1.4), d = 0.5, h = 0.86;
  k.box(wood, w, 0.08, d - 0.04, 0, 0, -0.02);
  k.box(wood, w, h - 0.08, d, 0, 0.08, 0);
  k.box(wood, w + 0.03, 0.03, d + 0.02, 0, h - 0.03, 0);
  const rows = 3;
  for (let i = 0; i < rows; i++) {
    const y = 0.1 + ((h - 0.14) * (i + 0.5)) / rows;
    k.box(M.black(), w - 0.04, 0.005, 0.004, 0, 0.1 + ((h - 0.14) * i) / rows, d / 2);
    for (const sx of [-1, 1]) k.box(M.brass(), 0.1, 0.014, 0.018, sx * w * 0.25, y, d / 2 + 0.008);
  }
  return { w, d, h, tops: [{ x: 0, z: 0, y: h, w: w - 0.08, d: d - 0.1 }] };
}

export function bookcase(k: Kit, r: Rng, w: number, h: number, wood: THREE.Material, seed: number): Piece {
  const d = 0.34, t = 0.025;
  k.box(wood, t, h, d, -w / 2 + t / 2, 0, 0);
  k.box(wood, t, h, d, w / 2 - t / 2, 0, 0);
  k.box(wood, w, 0.08, d, 0, 0, 0);
  k.box(wood, w + 0.03, 0.04, d + 0.02, 0, h - 0.04, 0);
  k.box(M.matte('#3b3530'), w - 2 * t, h - 0.1, 0.01, 0, 0.06, -d / 2 + 0.006);
  const shelves = Math.max(3, Math.round((h - 0.12) / 0.36));
  const step = (h - 0.12) / shelves;
  const tops: Top[] = [];
  for (let i = 0; i < shelves; i++) {
    const y = 0.08 + i * step;
    if (i > 0) k.box(wood, w - 2 * t, 0.022, d - 0.02, 0, y - 0.011, 0.01);
    // books: a row of spines, sometimes with a gap for an object
    const gap = r.chance(0.35);
    const bw = gap ? (w - 2 * t) * r.range(0.45, 0.7) : w - 2 * t - 0.01;
    const bx = gap ? (r.chance(0.5) ? -1 : 1) * ((w - 2 * t - bw) / 2) : 0;
    const bh = Math.min(0.3, step - 0.05);
    k.at(bx, y + 0.011, 0.02, 0, () => {
      k.quad(M.spines(seed + i), bw, bh, 0, bh / 2, 0.1, 0, [bw, 1]);
      k.box(M.matte('#d8cfbd'), bw - 0.01, bh * 0.62, 0.2, 0, 0, -0.01);
    });
    if (gap) tops.push({ x: bx > 0 ? -(w - 2 * t) / 2 + (w - 2 * t - bw) / 2 : (w - 2 * t) / 2 - (w - 2 * t - bw) / 2, z: 0.02, y: y + 0.011, w: Math.max(0.1, w - 2 * t - bw - 0.04), d: d - 0.08 });
  }
  return { w, d, h, tops: [...tops, { x: 0, z: 0, y: h, w: w - 0.1, d: d - 0.1 }] };
}

export function desk(k: Kit, r: Rng, w: number, wood: THREE.Material, metal: THREE.Material): Piece {
  const d = 0.7, h = 0.75;
  k.box(wood, w, 0.03, d, 0, h - 0.03, 0);
  if (r.chance(0.5)) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(metal, 0.04, h - 0.03, 0.04, sx * (w / 2 - 0.05), 0, sz * (d / 2 - 0.05));
  } else {
    for (const sx of [-1, 1]) k.box(metal, 0.04, h - 0.03, d - 0.06, sx * (w / 2 - 0.04), 0, 0);
    k.box(metal, w - 0.1, 0.3, 0.02, 0, h - 0.33, -d / 2 + 0.06);
  }
  return { w, d, h, tops: [{ x: 0, z: 0, y: h, w: w - 0.06, d: d - 0.06 }] };
}

export function officeChair(k: Kit, seat: THREE.Material): Piece {
  const black = M.black();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    k.push(Math.sin(a) * 0.15, 0.05, Math.cos(a) * 0.15, a);
    k.box(black, 0.035, 0.03, 0.3, 0, 0, 0);
    k.pop();
    k.sphere(black, 0.025, Math.sin(a) * 0.29, 0.025, Math.cos(a) * 0.29);
  }
  k.cyl(M.chrome(), 0.022, 0.022, 0.36, 0, 0.06, 0, 8);
  k.rbox(seat, 0.5, 0.08, 0.48, 0.03, 0, 0.42, 0.02);
  k.box(black, 0.04, 0.3, 0.03, 0, 0.42, -0.24);
  k.push(0, 0.62, -0.25, 0);
  k.boxM(seat, 0.46, 0.5, 0.06, 0, 0.22, 0, new THREE.Euler(-0.08, 0, 0));
  k.pop();
  for (const sx of [-1, 1]) {
    k.box(black, 0.03, 0.2, 0.03, sx * 0.26, 0.48, 0.0);
    k.box(black, 0.06, 0.025, 0.24, sx * 0.26, 0.68, 0.02);
  }
  return { w: 0.62, d: 0.62, h: 1.1, tops: [] };
}

export function monitor(k: Kit, x: number, y: number, z: number, on: boolean, w = 0.6) {
  const h = w * 0.58;
  k.box(M.black(), 0.22, 0.012, 0.16, x, y, z - 0.04);
  k.box(M.black(), 0.04, 0.16, 0.02, x, y + 0.01, z - 0.07);
  k.box(M.black(), w, h, 0.025, x, y + 0.11, z - 0.05);
  k.box(on ? M.screenOn() : M.screen(), w - 0.02, h - 0.02, 0.002, x, y + 0.12, z - 0.037);
  // keyboard and mouse
  k.box(M.matte('#2a2a2c'), 0.44, 0.018, 0.14, x, y, z + 0.18);
  k.box(M.matte('#2a2a2c'), 0.06, 0.02, 0.1, x + 0.32, y, z + 0.18);
}

export function diningTable(k: Kit, r: Rng, w: number, d: number, wood: THREE.Material): Piece {
  const h = 0.75;
  k.box(wood, w, 0.04, d, 0, h - 0.04, 0);
  k.box(wood, w - 0.16, 0.08, d - 0.16, 0, h - 0.12, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(wood, 0.06, h - 0.04, 0.06, sx * (w / 2 - 0.08), 0, sz * (d / 2 - 0.08));
  void r;
  return { w, d, h, tops: [{ x: 0, z: 0, y: h, w: w - 0.1, d: d - 0.1 }] };
}

export function diningChair(k: Kit, wood: THREE.Material, seat: THREE.Material | null): Piece {
  const w = 0.44, d = 0.48;
  for (const sx of [-1, 1]) {
    k.box(wood, 0.035, 0.45, 0.035, sx * (w / 2 - 0.03), 0, d / 2 - 0.03);
    k.box(wood, 0.035, 0.92, 0.035, sx * (w / 2 - 0.03), 0, -d / 2 + 0.03);
  }
  k.box(seat ?? wood, w, 0.04, d, 0, 0.44, 0);
  for (let i = 0; i < 2; i++) k.box(wood, w - 0.05, 0.05, 0.02, 0, 0.66 + i * 0.18, -d / 2 + 0.03);
  return { w, d, h: 0.92, tops: [] };
}

export function radiator(k: Kit, len: number) {
  const m = M.radiator();
  const n = Math.max(6, Math.round(len / 0.065));
  const step = len / n;
  for (let i = 0; i < n; i++) {
    const x = -len / 2 + step * (i + 0.5);
    k.box(m, step * 0.62, 0.56, 0.16, x, 0.07, 0);
    k.box(m, step * 0.62, 0.05, 0.19, x, 0.58, 0);
  }
  k.rod(m, 0.025, len, 0, 0.12, 0, 'x', 8);
  k.rod(m, 0.025, len, 0, 0.6, 0, 'x', 8);
  for (const sx of [-1, 1]) k.box(m, 0.05, 0.07, 0.17, sx * (len / 2 - 0.03), 0, 0);
  // valve
  k.rod(M.chrome(), 0.02, 0.12, -len / 2 - 0.06, 0.12, 0, 'x', 8);
  k.cyl(M.black(), 0.03, 0.03, 0.05, -len / 2 - 0.1, 0.13, 0, 10);
}

export function fireplace(k: Kit, r: Rng, lit: boolean): Piece {
  const stone = r.chance(0.6) ? M.marble('#ffffff') : M.marble('#4b4a4a');
  const black = M.matte('#141312');
  const w = 1.55, h = 1.22, d = 0.26;
  // firebox surround (black slate) and opening
  k.box(M.matte('#1d1c1b'), 1.0, 0.95, 0.05, 0, 0, -d / 2 + 0.03);
  k.box(black, 0.74, 0.74, 0.3, 0, 0.02, -d / 2 - 0.12);
  // pilasters, frieze, shelf
  for (const sx of [-1, 1]) {
    k.box(stone, 0.24, 1.0, d, sx * (w / 2 - 0.15), 0, 0);
    k.box(stone, 0.28, 0.06, d + 0.03, sx * (w / 2 - 0.15), 0, 0);
  }
  k.box(stone, w - 0.06, 0.2, d, 0, 0.98, 0);
  k.box(stone, w + 0.1, 0.05, d + 0.1, 0, h - 0.05, 0.03);
  k.box(stone, w + 0.04, 0.03, d + 0.06, 0, h - 0.08, 0.02);
  // hearth
  k.box(stone, w + 0.15, 0.03, 0.5, 0, 0, d / 2 + 0.2);
  // grate and logs
  k.box(M.iron(), 0.5, 0.02, 0.2, 0, 0.12, -d / 2 - 0.05);
  for (let i = 0; i < 3; i++) k.rod(M.matte('#4a3424'), 0.045, 0.48, 0, 0.17 + (i === 2 ? 0.07 : 0), -d / 2 - 0.08 + (i - 1) * 0.07, 'x', 8);
  if (lit) k.box(M.fire(), 0.4, 0.12, 0.02, 0, 0.16, -d / 2 - 0.02);
  // overmantel mirror in a gilt frame
  const gilt = M.brass();
  k.box(gilt, 0.95, 1.05, 0.04, 0, h + 0.12, -d / 2 + 0.02);
  k.box(M.mirror(), 0.85, 0.95, 0.01, 0, h + 0.17, -d / 2 + 0.045);
  return { w: w + 0.15, d: d + 0.45, h, tops: [{ x: 0, z: 0.03, y: h, w: w - 0.1, d: d - 0.04 }] };
}

export function plant(k: Kit, r: Rng, h: number, small = false): Piece {
  const potR = small ? 0.08 : r.range(0.17, 0.24);
  const potH = small ? 0.12 : potR * r.range(1.2, 1.7);
  const pot = r.chance(0.5) ? M.terracotta() : M.enamel(r.pick(['#f1efe9', '#2b2d30', '#9aa59a', '#c9b79c']));
  k.cyl(pot, potR, potR * 0.78, potH, 0, 0, 0, 16);
  k.cyl(M.soil(), potR * 0.95, potR * 0.95, 0.01, 0, potH - 0.03, 0, 16);
  const leaves = small ? 9 : Math.round(16 + h * 14);
  const leaf = M.leaf();
  const geo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const stem = M.matte('#4a5a32');
  for (let i = 0; i < leaves; i++) {
    const t = small ? r.range(0.3, 1) : r.range(0.15, 1);
    const yaw = r.range(0, Math.PI * 2);
    const rad = (small ? 0.06 : 0.12 + 0.25 * Math.sin(t * Math.PI)) * r.range(0.5, 1.1);
    const y = potH + (h - potH) * t * 0.85;
    const x = Math.sin(yaw) * rad, z = Math.cos(yaw) * rad;
    if (!small && i % 3 === 0) k.boxM(stem, 0.012, y - potH + 0.05, 0.012, x * 0.5, potH + (y - potH) / 2, z * 0.5, new THREE.Euler(Math.atan2(z, 0.6) * 0.4, 0, -Math.atan2(x, 0.6) * 0.4));
    const s = (small ? 0.09 : r.range(0.18, 0.3)) * (1.1 - t * 0.3);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(r.range(0.5, 1.2), yaw, 0, 'YXZ')), new THREE.Vector3(s * 0.6, s, 1));
    k.add(geo, leaf, m, 'keep');
  }
  return { w: potR * 2.5, d: potR * 2.5, h, tops: [] };
}

/** a stack of 2-4 books lying flat, for coffee tables and shelves */
export function bookStack(k: Kit, r: Rng, x: number, y: number, z: number) {
  const n = r.int(2, 4);
  let yy = y;
  const rot = r.range(-0.3, 0.3);
  for (let i = 0; i < n; i++) {
    const w = r.range(0.2, 0.3), d = r.range(0.15, 0.22), t = r.range(0.02, 0.04);
    k.box(M.matte(r.pick(['#7b2d26', '#2c3e57', '#3d5a40', '#c9b48a', '#1f1f1f', '#d8d2c4', '#a8462f', '#30566b'])), w, t, d, x + r.range(-0.02, 0.02), yy, z + r.range(-0.02, 0.02), rot + r.range(-0.15, 0.15));
    yy += t;
  }
  return yy;
}

export function mug(k: Kit, r: Rng, x: number, y: number, z: number) {
  const m = M.enamel(r.pick(['#f4f1ea', '#2d4f6b', '#c4553a', '#e8c86a', '#3a3a3a']));
  k.cyl(m, 0.042, 0.04, 0.095, x, y, z, 12);
  k.cyl(M.matte('#2a1a10'), 0.036, 0.036, 0.004, x, y + 0.085, z, 12);
}

export function vase(k: Kit, r: Rng, x: number, y: number, z: number) {
  const m = M.enamel(r.pick(['#f4f1ea', '#2d4f6b', '#7a8a6a', '#c9b79c']));
  const h = r.range(0.18, 0.3);
  k.cyl(m, 0.04, 0.07, h * 0.7, x, y, z, 14);
  k.cyl(m, 0.05, 0.04, h * 0.3, x, y + h * 0.7, z, 14);
  // a few stems with leaves
  k.at(x, y + h * 0.6, z, r.range(0, 6), () => plantSprigs(k, r));
}
function plantSprigs(k: Kit, r: Rng) {
  const geo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  for (let i = 0; i < 7; i++) {
    const yaw = r.range(0, Math.PI * 2);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(0, r.range(0.05, 0.2), 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(r.range(0.2, 0.8), yaw, 0, 'YXZ')), new THREE.Vector3(0.07, 0.14, 1));
    k.add(geo, M.leaf(), m, 'keep');
  }
}

export function bowl(k: Kit, r: Rng, x: number, y: number, z: number) {
  const m = M.enamel(r.pick(['#f4f1ea', '#c9b79c', '#2d4f6b']));
  k.cyl(m, 0.12, 0.06, 0.07, x, y, z, 18);
  for (let i = 0; i < 3; i++) k.sphere(M.enamel(r.pick(['#c8321e', '#e8a020', '#8ab83a'])), 0.035, x + r.range(-0.05, 0.05), y + 0.07, z + r.range(-0.05, 0.05));
}

export function picture(k: Kit, mat: THREE.Material, w: number, h: number, x: number, y: number, z: number, frame: THREE.Material) {
  k.box(frame, w + 0.06, h + 0.06, 0.03, x, y - (h + 0.06) / 2, z);
  k.quad(mat, w, h, x, y, z + 0.0155);
}

// ------------------------------------------------------------------ kitchen

export interface KitchenOpts {
  len: number;
  /** cabinet door colour */
  cab: THREE.Material;
  counter: THREE.Material;
  splash: THREE.Material;
  fridgeAt: -1 | 1 | 0;
  rangeAt: number; // 0..1 along the run
  sinkAt: number;
  uppers: boolean;
  ceilingH: number;
}

/** one straight run of kitchen: base cabinets, counter, backsplash, wall cabinets, appliances */
export function kitchenRun(k: Kit, r: Rng, o: KitchenOpts): Piece {
  const d = 0.62, ch = 0.92;
  const L = o.len;
  const fridgeW = 0.78;
  let x0 = -L / 2, x1 = L / 2;
  const steel = M.steel();
  const boxes: NonNullable<Piece['boxes']> = [];
  if (o.fridgeAt !== 0 && L > 2.2) {
    const fx = o.fridgeAt < 0 ? -L / 2 + fridgeW / 2 : L / 2 - fridgeW / 2;
    // a hollow cabinet: the door is a separate leaf (Container) so it can swing open
    const fw = fridgeW - 0.02, fz = -d / 2 + 0.02;
    k.box(steel, fw, 1.78, 0.03, fx, 0, fz + 0.015);
    for (const sx of [-1, 1]) k.box(steel, 0.03, 1.78, 0.68, fx + sx * (fw / 2 - 0.015), 0, fz + 0.34);
    k.box(steel, fw, 0.05, 0.68, fx, 0, fz + 0.34);
    k.box(steel, fw, 0.05, 0.68, fx, 1.73, fz + 0.34);
    k.box(M.enamel('#f3f5f6'), fw - 0.06, 1.68, 0.01, fx, 0.05, fz + 0.035);
    boxes.push({ kind: 'fridge', x: fx, y: 0, z: fz + 0.34, w: fw, h: 1.78, d: 0.68, doors: o.fridgeAt < 0 ? 'left' : 'right' });
    k.box(M.black(), fridgeW - 0.03, 0.006, 0.01, fx, 1.18, -d / 2 + 0.74);
    for (const yy of [0.5, 1.35]) k.box(M.chrome(), 0.025, yy === 0.5 ? 0.5 : 0.35, 0.03, fx + (o.fridgeAt < 0 ? 0.32 : -0.32), yy, -d / 2 + 0.76);
    // cabinet over the fridge
    k.box(o.cab, fridgeW, Math.max(0.2, o.ceilingH - 0.12 - 1.86), 0.62, fx, 1.86, -d / 2 + 0.31);
    if (o.fridgeAt < 0) x0 += fridgeW;
    else x1 -= fridgeW;
  }
  const run = x1 - x0;
  const cx = (x0 + x1) / 2;
  // toe kick and carcass
  k.box(M.matte('#2a2724'), run, 0.1, d - 0.08, cx, 0, -0.04);
  k.box(o.cab, run, ch - 0.1 - 0.035, d - 0.02, cx, 0.1, -0.01);
  // counter
  k.box(o.counter, run + 0.02, 0.035, d + 0.03, cx, ch - 0.035, 0.015);
  // range and sink positions
  const rw = 0.76;
  const rx = THREE.MathUtils.clamp(x0 + run * o.rangeAt, x0 + rw / 2, x1 - rw / 2);
  let sx = THREE.MathUtils.clamp(x0 + run * o.sinkAt, x0 + 0.4, x1 - 0.4);
  if (Math.abs(sx - rx) < 0.9) sx = rx + (rx < cx ? 1 : -1) * 0.95;
  const hasRange = run > 1.4;
  const hasSink = run > 2.2 || !hasRange;
  // base cabinets either side of the range
  const baseSegs: [number, number][] = hasRange ? [[x0, rx - rw / 2], [rx + rw / 2, x1]] : [[x0, x1]];
  for (const [a, b] of baseSegs) if (b - a > 0.3) boxes.push({ kind: 'cabinet', x: (a + b) / 2, y: 0.1, z: -0.01, w: b - a, h: ch - 0.135, d: d - 0.02 });
  // doors: shaker panels every ~0.5 m, a drawer row on top
  const n = Math.max(1, Math.round(run / 0.5));
  const dw = run / n;
  for (let i = 0; i < n; i++) {
    const x = x0 + dw * (i + 0.5);
    if (hasRange && Math.abs(x - rx) < rw / 2) continue;
    // drawer front, door front with a recessed panel
    k.box(o.cab, dw - 0.006, 0.16, 0.02, x, ch - 0.035 - 0.18, d / 2);
    shaker(k, o.cab, dw - 0.006, 0.56, x, 0.12, d / 2);
    k.box(M.brass(), 0.12, 0.012, 0.02, x, ch - 0.035 - 0.1, d / 2 + 0.02);
    k.box(M.brass(), 0.012, 0.12, 0.02, x + (i % 2 ? -1 : 1) * (dw / 2 - 0.05), 0.55, d / 2 + 0.02);
  }
  if (hasRange) {
    k.box(steel, rw, ch - 0.02, d, rx, 0, 0);
    k.box(M.black(), rw - 0.04, 0.02, d - 0.06, rx, ch - 0.02, 0);
    k.box(M.black(), rw - 0.14, 0.42, 0.01, rx, 0.25, d / 2 + 0.005);
    k.box(steel, rw - 0.1, 0.02, 0.03, rx, 0.72, d / 2 + 0.02);
    for (const bx of [-0.18, 0.18]) for (const bz of [-0.13, 0.13]) {
      k.cyl(M.iron(), 0.1, 0.1, 0.012, rx + bx, ch, bz, 16);
      k.cyl(M.black(), 0.04, 0.04, 0.02, rx + bx, ch, bz, 10);
    }
    for (let i = 0; i < 4; i++) k.rod(M.black(), 0.022, 0.04, rx - 0.27 + i * 0.18, 0.8, d / 2 + 0.02, "z", 10);
    // a pot on a burner
    if (r.chance(0.7)) {
      k.cyl(steel, 0.11, 0.1, 0.14, rx - 0.18, ch + 0.012, 0.13, 16);
      k.cyl(M.black(), 0.012, 0.012, 0.03, rx - 0.18, ch + 0.15, 0.13, 6);
    }
    // hood
    k.box(steel, rw + 0.04, 0.12, 0.5, rx, 1.62, -d / 2 + 0.25);
    k.cyl(steel, 0.1, 0.22, 0.3, rx, 1.74, -d / 2 + 0.2, 4);
    k.box(steel, 0.26, o.ceilingH - 2.04, 0.22, rx, 2.04, -d / 2 + 0.14);
  }
  if (hasSink) {
    k.box(M.steel(), 0.56, 0.01, 0.4, sx, ch + 0.001, 0.02);
    k.box(M.matte('#5d6164'), 0.5, 0.004, 0.34, sx, ch + 0.012, 0.02);
    k.cyl(M.chrome(), 0.02, 0.025, 0.28, sx, ch, -0.24, 10);
    k.push(sx, ch + 0.28, -0.24, 0);
    k.boxM(M.chrome(), 0.025, 0.025, 0.2, 0, 0, 0.09, new THREE.Euler(0.3, 0, 0));
    k.pop();
  }
  // backsplash: subway tile from the counter up to the wall cabinets
  const splashTop = o.uppers ? 1.45 : 1.45;
  k.box(o.splash, run, splashTop - ch, 0.012, cx, ch, -d / 2 + 0.006);
  if (o.uppers) {
    const ud = 0.34, uy = 1.45, uh = Math.min(0.85, o.ceilingH - 0.15 - uy);
    const segs: [number, number][] = [];
    if (hasRange) {
      if (rx - rw / 2 - 0.05 - x0 > 0.3) segs.push([x0, rx - rw / 2 - 0.05]);
      if (x1 - (rx + rw / 2 + 0.05) > 0.3) segs.push([rx + rw / 2 + 0.05, x1]);
    } else segs.push([x0, x1]);
    for (const [a, b] of segs) {
      const w = b - a, m = (a + b) / 2;
      k.box(o.cab, w, uh, ud, m, uy, -d / 2 + ud / 2);
      boxes.push({ kind: 'upper', x: m, y: uy, z: -d / 2 + ud / 2, w, h: uh, d: ud });
      const nn = Math.max(1, Math.round(w / 0.45));
      for (let i = 0; i < nn; i++) {
        const x = a + (w * (i + 0.5)) / nn;
        shaker(k, o.cab, w / nn - 0.006, uh - 0.02, x, uy + 0.01, -d / 2 + ud + 0.01);
        k.box(M.brass(), 0.012, 0.1, 0.02, x + (i % 2 ? -1 : 1) * (w / nn / 2 - 0.04), uy + 0.04, -d / 2 + ud + 0.03);
      }
      // under-cabinet light strip
      k.box(M.diffuser(), w - 0.04, 0.006, 0.03, m, uy - 0.006, -d / 2 + ud - 0.06);
    }
  }
  const tops: Top[] = [];
  // free counter spans for clutter
  const blocked = [hasRange ? [rx - rw / 2, rx + rw / 2] : null, hasSink ? [sx - 0.3, sx + 0.3] : null].filter(Boolean) as number[][];
  let a = x0 + 0.05;
  const cuts = [...blocked].sort((p, q) => p[0] - q[0]);
  for (const [c0, c1] of [...cuts, [x1 - 0.05, x1]]) {
    if (c0 - a > 0.3) tops.push({ x: (a + c0) / 2, z: -0.05, y: ch, w: c0 - a - 0.04, d: d - 0.2 });
    a = Math.max(a, c1 + 0.02);
  }
  return { w: L, d, h: ch, tops, boxes };
}

/** a shaker door: flat recessed panel inside a proud frame of rails and stiles, base-centre at x,y on face z */
function shaker(k: Kit, m: THREE.Material, w: number, h: number, x: number, y: number, z: number) {
  const f = 0.065;
  k.box(m, w, h, 0.012, x, y, z);
  k.box(m, w, f, 0.022, x, y, z + 0.004);
  k.box(m, w, f, 0.022, x, y + h - f, z + 0.004);
  k.box(m, f, h - 2 * f, 0.022, x - w / 2 + f / 2, y + f, z + 0.004);
  k.box(m, f, h - 2 * f, 0.022, x + w / 2 - f / 2, y + f, z + 0.004);
}

/** a built-in closet: two panelled doors with knobs in a painted casing */
export function closet(k: Kit, w: number, h: number, paint: THREE.Material): Piece {
  const d = 0.62;
  // hollow carcass; the two doors are separate leaves (Container) so they swing open
  k.box(paint, w, h, 0.02, 0, 0, -d / 2 + 0.01);
  for (const sx of [-1, 1]) k.box(paint, 0.03, h, d, sx * (w / 2 - 0.015), 0, 0);
  k.box(paint, w, 0.06, d, 0, 0, 0);
  k.box(paint, w, 0.04, d, 0, h - 0.14, 0);
  k.box(paint, w + 0.1, 0.1, d + 0.04, 0, h - 0.1, 0.02);
  return { w, d, h, tops: [], boxes: [{ kind: 'closet', x: 0, y: 0.06, z: -0.012, w: w - 0.06, h: h - 0.2, d: d - 0.024, doors: 'pair' }] };
}

// ------------------------------------------------------------------ bathroom

export function clawfootTub(k: Kit): Piece {
  const L = 1.68, W = 0.76;
  const enamel = M.porcelain();
  const outer = M.enamel('#f3f1ec');
  k.rbox(outer, L - 0.06, 0.42, W - 0.06, 0.18, 0, 0.16, 0, 0, 3);
  k.rbox(enamel, L, 0.06, W, 0.03, 0, 0.56, 0, 0, 2);
  k.flat(M.enamel('#e4e6e6'), L - 0.16, W - 0.16, 0, 0.621, 0, 'world');
  k.rbox(M.enamel('#dfe3e4'), L - 0.2, 0.04, W - 0.2, 0.02, 0, 0.6, 0);
  const brass = M.brass();
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    k.sphere(brass, 0.05, sx * (L / 2 - 0.22), 0.06, sz * (W / 2 - 0.14), 1.4);
    k.cyl(brass, 0.03, 0.04, 0.03, sx * (L / 2 - 0.22), 0, sz * (W / 2 - 0.14), 10);
  }
  // faucet at the -x end
  k.cyl(M.chrome(), 0.015, 0.015, 0.25, -L / 2 + 0.08, 0.58, 0, 8);
  k.rod(M.chrome(), 0.018, 0.14, -L / 2 + 0.14, 0.82, 0, 'x', 8);
  for (const sz of [-0.07, 0.07]) k.sphere(M.chrome(), 0.025, -L / 2 + 0.08, 0.76, sz);
  return { w: L, d: W, h: 0.62, tops: [] };
}

export function pedestalSink(k: Kit, wallZ = -0.25): Piece {
  const p = M.porcelain();
  k.cyl(p, 0.09, 0.13, 0.72, 0, 0, -0.05, 18);
  k.rbox(p, 0.58, 0.16, 0.46, 0.06, 0, 0.7, 0);
  k.flat(M.enamel('#e7e9ea'), 0.42, 0.28, 0, 0.861, 0.03, 'world');
  k.cyl(M.chrome(), 0.018, 0.022, 0.16, 0, 0.86, -0.17, 10);
  k.rod(M.chrome(), 0.014, 0.1, 0, 0.99, -0.12, 'z', 8);
  for (const sx of [-0.1, 0.1]) k.sphere(M.chrome(), 0.022, sx, 0.9, -0.17);
  // medicine cabinet mirror above
  k.box(M.trim(), 0.62, 0.78, 0.12, 0, 1.15, wallZ + 0.06);
  k.box(M.mirror(), 0.56, 0.72, 0.006, 0, 1.18, wallZ + 0.123);
  // sconce
  k.box(M.chrome(), 0.08, 0.04, 0.12, 0, 1.98, wallZ + 0.06);
  k.cyl(M.bulb(), 0.04, 0.05, 0.12, 0, 1.86, wallZ + 0.11, 14);
  return { w: 0.62, d: 0.5, h: 0.86, tops: [] };
}

export function toilet(k: Kit): Piece {
  const p = M.porcelain();
  k.rbox(p, 0.24, 0.3, 0.36, 0.08, 0, 0, 0.06);
  k.rbox(p, 0.38, 0.12, 0.5, 0.15, 0, 0.28, 0.08);
  k.rbox(M.enamel('#fbfbf8'), 0.4, 0.03, 0.48, 0.12, 0, 0.4, 0.09);
  k.rbox(p, 0.48, 0.38, 0.19, 0.03, 0, 0.42, -0.2);
  k.rbox(p, 0.5, 0.04, 0.21, 0.015, 0, 0.8, -0.2);
  k.box(M.chrome(), 0.06, 0.015, 0.03, -0.17, 0.72, -0.1);
  return { w: 0.5, d: 0.72, h: 0.84, tops: [{ x: 0, z: -0.2, y: 0.84, w: 0.4, d: 0.14 }] };
}

export function towelBar(k: Kit, r: Rng, w = 0.6) {
  k.rod(M.chrome(), 0.012, w, 0, 1.1, 0.07, 'x', 8);
  for (const sx of [-1, 1]) k.box(M.chrome(), 0.03, 0.04, 0.07, sx * (w / 2), 1.08, 0.035);
  const towel = M.fabric(r.pick(['#f4f1ea', '#d9e4ea', '#e9d8c8', '#9fb3a8']));
  k.box(towel, w * 0.7, 0.55, 0.02, 0, 0.58, 0.085);
  k.box(towel, w * 0.7, 0.42, 0.02, 0, 0.7, 0.06);
}

// ------------------------------------------------------------------ doors and stairs

/** a panelled door leaf, hinge edge at local x = 0, extending to +x, centred on z */
export function doorLeaf(k: Kit, w: number, h: number, paint: THREE.Material) {
  const t = 0.044;
  k.box(paint, w, h, t, w / 2, 0, 0);
  // two tall panels and a short top panel, both faces
  for (const sz of [-1, 1]) {
    for (const [py, ph] of [[0.18, 1.12], [1.42, 0.5]] as const)
      for (const px of [0.27, 0.73]) k.box(paint, w * 0.36, ph, 0.01, w * px, py, sz * (t / 2 + 0.003));
    k.sphere(M.brass(), 0.03, w - 0.07, 1.0, sz * (t / 2 + 0.06));
    k.rod(M.brass(), 0.008, 0.06, w - 0.07, 1.0, sz * (t / 2 + 0.03), 'z', 6);
    k.box(M.brass(), 0.05, 0.14, 0.006, w - 0.07, 0.93, sz * (t / 2 + 0.003));
  }
  for (const y of [0.25, 1.75]) k.box(M.brass(), 0.012, 0.09, 0.05, 0, y, 0);
}

export function stair(k: Kit, len: number, wid: number, rise: number, wood: THREE.Material, riser: THREE.Material, rail: THREE.Material) {
  const steps = Math.round(rise / 0.19);
  const run = len / steps;
  for (let i = 0; i < steps; i++) {
    const h = ((i + 1) / steps) * rise;
    const x = -len / 2 + (i + 0.5) * run;
    k.box(riser, run, h - 0.03, wid, x, 0, 0);
    k.box(wood, run + 0.03, 0.03, wid + 0.02, x + 0.015, h - 0.03, 0.01);
  }
  // open-side stringer, balusters and handrail (on +z side)
  const ang = Math.atan2(rise, len);
  const sl = Math.hypot(rise, len);
  k.boxM(riser, sl, 0.25, 0.04, 0, rise / 2 - 0.05, wid / 2 + 0.02, new THREE.Euler(0, 0, ang));
  for (let i = 0; i < steps; i++) {
    const x = -len / 2 + (i + 0.5) * run;
    const y = ((i + 1) / steps) * rise;
    k.box(rail, 0.025, 0.9, 0.025, x, y, wid / 2 - 0.04);
  }
  k.boxM(wood, sl + 0.2, 0.06, 0.07, 0, rise / 2 + 0.92, wid / 2 - 0.04, new THREE.Euler(0, 0, ang));
  k.box(wood, 0.09, 1.0, 0.09, -len / 2 - 0.02, 0, wid / 2 - 0.04);
  k.sphere(wood, 0.06, -len / 2 - 0.02, 1.05, wid / 2 - 0.04);
}
