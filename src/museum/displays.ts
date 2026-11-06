import * as THREE from 'three';
import { mat } from '../build';
import { DATASET_LABEL } from '../remote';
import type { Rng } from '../rng';
import { Frame, shade, type MuseumBase } from './base';
import type { Measured } from './sizes';
import type { Barrier, Style } from './style';
import { textPlane, fmtDims, SANS, SERIF, type Line } from './text';

/**
 * Display furniture, sized from the real dimensions of what it holds (references in
 * docs/research/museum.md). Every display knows its footprint before it is built, so the
 * room can be planned around it. Local frame: +z is the display's front (towards visitors);
 * floor units are centred on the frame origin, wall units have their back on the wall at z=0.
 */

export interface Mats {
  plinth: THREE.Material;
  plinthAlt: THREE.Material;
  glass: THREE.Material;
  frame: THREE.Material;
  caseBase: THREE.Material;
  caseLight: THREE.Material;
  brass: THREE.Material;
  rope: THREE.Material;
  steel: THREE.Material;
  line: THREE.Material;
  shelf: THREE.Material;
  leather: THREE.Material;
  cable: THREE.Material;
  fixture: THREE.Material;
  lens: THREE.Material;
  wallWash: THREE.Material;
}

export function makeMats(st: Style, r: Rng): Mats {
  const p = st.plinth[r.int(0, st.plinth.length - 1)];
  const p2 = st.plinth[(st.plinth.indexOf(p) + 1) % st.plinth.length];
  return {
    plinth: mat(p, { rough: 0.75 }),
    plinthAlt: mat(p2, { rough: 0.7 }),
    glass: glassMat,
    frame: mat(st.caseFrame, { metal: 0.6, rough: 0.35 }),
    caseBase: mat(shade(st.caseFrame, st.dark ? 1.4 : 1), { rough: 0.6 }),
    caseLight: mat('#fff6e4', { emissive: '#fff4dc', ei: 2.2 }),
    brass: mat('#b8975a', { metal: 0.85, rough: 0.3 }),
    rope: mat('#6d1a22', { rough: 0.9 }),
    steel: mat('#9aa1a8', { metal: 0.8, rough: 0.35 }),
    line: mat('#e3b62a', { rough: 0.7 }),
    shelf: shelfGlass,
    leather: mat('#2c2622', { rough: 0.55 }),
    cable: mat('#3a3d40', { metal: 0.7, rough: 0.4 }),
    fixture: mat(st.dark ? '#151515' : '#202020', { metal: 0.5, rough: 0.4 }),
    lens: mat('#fff8e6', { emissive: '#fff4dc', ei: 3 }),
    wallWash: mat('#ffffff'),
  };
}

const glassMat = new THREE.MeshStandardMaterial({ color: '#e6f4ff', roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.1, depthWrite: false, envMapIntensity: 1.6 });
const shelfGlass = new THREE.MeshStandardMaterial({ color: '#cfe8e2', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.35, depthWrite: false });

export interface Ctx {
  lv: MuseumBase;
  st: Style;
  r: Rng;
  m: Mats;
  prio: () => number;
  labelBg: string;
  labelInk: string;
  labelSub: string;
}

export type Place = 'floor' | 'wall' | 'hang';
export interface Unit {
  type: string;
  place: Place;
  /** floor: footprint incl. barrier; wall: length along the wall, depth into the room */
  w: number;
  d: number;
  /** top of the display (or of the tallest thing on it) */
  h: number;
  items: Measured[];
  hero?: boolean;
  /** where light should land, local to the unit frame */
  focus: THREE.Vector3;
  /** radius of the light pool */
  glow: number;
  build(c: Ctx, f: Frame): void;
}

// ---------------------------------------------------------------- helpers

/** footprint along a run: the longer side runs along x */
export function along(m: Measured) {
  return m.real.x >= m.real.z ? { w: m.real.x, d: m.real.z, rot: 0 } : { w: m.real.z, d: m.real.x, rot: Math.PI / 2 };
}

function itemLines(c: Ctx, m: Measured, big: boolean): Line[] {
  const e = m.entry;
  return [
    { text: e.title, size: big ? 0.07 : 0.05, color: c.labelInk, weight: 700, font: SERIF },
    { text: e.author ? `by ${e.author}` : (DATASET_LABEL[e.ds] ?? e.ds), size: 0.034, color: c.labelSub, weight: 400, font: SANS },
    { text: fmtDims(m.real), size: 0.034, color: c.labelSub, weight: 500, font: SANS },
    { text: Math.abs(m.k - 1) > 0.01 ? 'actual size (corrected from the source)' : 'actual size', size: 0.028, color: c.labelSub, weight: 400, font: SANS },
  ];
}

/** a label panel: one object (full tombstone) or a numbered list */
export function labelPanel(c: Ctx, items: Measured[], w = 0.42, big = false) {
  if (items.length === 1) {
    const h = big ? 0.34 : 0.25;
    return textPlane(itemLines(c, items[0], big), w, h, c.labelBg, 1100, 'left');
  }
  const lines: Line[] = items.slice(0, 14).map((m, i) => ({ text: `${i + 1}. ${m.entry.title} — ${fmtDims(m.real)}`, size: 0.03, color: c.labelInk, weight: 500, font: SANS }));
  if (items.length > 14) lines.push({ text: `and ${items.length - 14} more`, size: 0.03, color: c.labelSub, weight: 400, font: SANS });
  return textPlane(lines, w, 0.06 + lines.length * 0.0385, c.labelBg, 1100, 'left');
}

function put(c: Ctx, o: THREE.Object3D, f: Frame, lx: number, ly: number, lz: number, rotY = 0, tilt = 0) {
  o.position.copy(f.point(lx, ly, lz));
  o.rotation.set(0, f.rot + rotY, 0);
  o.rotateX(-tilt);
  c.lv.group.add(o);
}

/** a free-standing reading desk with the label, at the front of a display */
function lectern(c: Ctx, f: Frame, lx: number, lz: number, items: Measured[], big = false) {
  const p = labelPanel(c, items, big ? 0.56 : 0.44, big);
  const h = (p.geometry as THREE.PlaneGeometry).parameters.height;
  c.lv.bx(c.m.fixture, 0.05, 0.86, 0.05, lx, 0, lz, f);
  c.lv.bx(c.m.fixture, 0.3, 0.02, 0.22, lx, 0, lz, f);
  c.lv.bx(c.m.caseBase, p.geometry ? (p.geometry as THREE.PlaneGeometry).parameters.width + 0.04 : 0.5, 0.02, h + 0.04, lx, 0.86, lz, f);
  put(c, p, f, lx, 0.9 + 0.012, lz, 0, Math.PI / 2 - 0.55);
  c.lv.col(f, lx, lz, 0.3, 0.3);
}

function barrier(c: Ctx, kind: Barrier, f: Frame, w: number, d: number) {
  const lv = c.lv;
  if (kind === 'edge') return;
  if (kind === 'line') {
    const t = 0.08;
    for (const s of [-1, 1]) {
      lv.bx(c.m.line, w, 0.004, t, 0, 0, (s * d) / 2, f);
      lv.bx(c.m.line, t, 0.004, d, (s * w) / 2, 0, 0, f);
    }
    return;
  }
  if (kind === 'glass') {
    const gh = 1.0;
    for (const s of [-1, 1]) {
      lv.bx(c.m.glass, w, gh, 0.02, 0, 0, (s * d) / 2, f);
      lv.bx(c.m.glass, 0.02, gh, d, (s * w) / 2, 0, 0, f);
      lv.bx(c.m.steel, w, 0.03, 0.05, 0, gh, (s * d) / 2, f);
      lv.bx(c.m.steel, 0.05, 0.03, d, (s * w) / 2, gh, 0, f);
    }
    return;
  }
  // posts around the rectangle, with ropes or rails between
  const pts: THREE.Vector2[] = [];
  const nx = Math.max(1, Math.ceil(w / 2.2)), nz = Math.max(1, Math.ceil(d / 2.2));
  for (let i = 0; i < nx; i++) pts.push(new THREE.Vector2(-w / 2 + (w * i) / nx, d / 2));
  for (let i = 0; i < nz; i++) pts.push(new THREE.Vector2(w / 2, d / 2 - (d * i) / nz));
  for (let i = 0; i < nx; i++) pts.push(new THREE.Vector2(w / 2 - (w * i) / nx, -d / 2));
  for (let i = 0; i < nz; i++) pts.push(new THREE.Vector2(-w / 2, -d / 2 + (d * i) / nz));
  const rope = kind === 'rope';
  const postH = rope ? 0.95 : 0.9;
  for (const p of pts) {
    if (rope) {
      lv.cy(c.m.brass, 0.028, postH, p.x, 0, p.y, f, true);
      lv.cy(c.m.brass, 0.14, 0.03, p.x, 0, p.y, f, true);
      lv.cy(c.m.brass, 0.045, 0.06, p.x, postH, p.y, f, true);
    } else lv.cy(c.m.steel, 0.025, postH, p.x, 0, p.y, f, true);
  }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (rope) {
      const n = 4;
      let prev = f.point(a.x, postH - 0.04, a.y);
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const sag = 0.16 * 4 * t * (1 - t);
        const q = f.point(a.x + (b.x - a.x) * t, postH - 0.04 - sag, a.y + (b.y - a.y) * t);
        lv.rod(c.m.rope, prev, q, 0.018);
        prev = q;
      }
    } else {
      lv.rod(c.m.steel, f.point(a.x, postH, a.y), f.point(b.x, postH, b.y), 0.022);
      lv.rod(c.m.steel, f.point(a.x, postH * 0.5, a.y), f.point(b.x, postH * 0.5, b.y), 0.012);
    }
  }
}

// ---------------------------------------------------------------- floor displays

/** Big things: on the floor or a low platform at full size, with a barrier round it. */
export function platform(c0: { st: Style; r: Rng }, m: Measured, hero: boolean, barrierKind: Barrier, angle = 0): Unit {
  const a = along(m);
  const big = Math.max(a.w, a.d);
  const st = c0.st;
  const ph = barrierKind === 'line' || st.outdoor ? (st.outdoor ? 0.12 : 0) : big > 8 ? 0.2 : st.arch === 'motor' ? 0.16 : 0.24;
  const margin = Math.min(1.6, Math.max(0.35, big * 0.12));
  const pw = a.w + margin * 2, pd = a.d + margin * 2;
  const bOff = barrierKind === 'edge' ? 0 : 0.45;
  const bw = pw + bOff * 2, bd = pd + bOff * 2;
  const cradle = st.arch === 'maritime' && m.real.y < big;
  const lift = cradle ? Math.min(0.6, 0.12 * m.real.y + 0.2) : 0;
  // turned platforms (motor halls) take up their rotated bounding box
  const cs = Math.abs(Math.cos(angle)), sn = Math.abs(Math.sin(angle));
  const fw = bw * cs + bd * sn, fd = bw * sn + bd * cs;
  return {
    type: 'platform', place: 'floor', w: fw, d: fd + 1.0, h: ph + lift + m.real.y, items: [m], hero,
    focus: new THREE.Vector3(0, ph + lift + m.real.y * 0.5, -0.5), glow: Math.max(pw, pd) * 0.62,
    build(c, f) {
      const lv = c.lv;
      const o = f.sub(0, -0.5, angle);
      if (ph > 0) {
        lv.bx(c.m.plinth, pw, ph, pd, 0, 0, 0, o);
        lv.bx(c.m.plinthAlt, pw + 0.04, 0.02, pd + 0.04, 0, ph - 0.02, 0, o);
      }
      if (cradle) {
        // two timber saddles under the hull
        for (const s of [-0.3, 0.3]) lv.bx(mat('#4a3626', { rough: 0.8 }), 0.25, lift, Math.max(0.2, a.d * 0.6), s * a.w, ph, 0, o);
      }
      lv.exhibit(m, o, 0, ph + lift, 0, a.rot, { prio: c.prio() });
      barrier(c, barrierKind, o, bw, bd);
      if (angle) {
        // a turned rectangle: cover it with a few axis-aligned boxes along its length
        const n = Math.max(2, Math.ceil(bw / Math.max(1, bd)));
        for (let i = 0; i < n; i++) lv.col(o, -bw / 2 + (bw * (i + 0.5)) / n, 0, bw / n + 0.1, bd + 0.1);
      } else lv.col(o, 0, 0, bw + 0.1, bd + 0.1);
      lectern(c, f, Math.min(fw / 2 - 0.3, 1.2), fd / 2 - 0.5 + 0.55 + 0.1, [m], hero);
    },
  };
}

/** One medium object on an open plinth (or a pedestal with a glass hood for small things). */
export function plinth(m: Measured, hood: boolean, hero: boolean, spin = 0): Unit {
  const a = along(m);
  const R = spin ? Math.hypot(a.w, a.d) : 0;
  const sw = (R || a.w) + (hood ? 0.22 : 0.3), sd = (R || a.d) + (hood ? 0.22 : 0.3);
  const ph = hood ? THREE.MathUtils.clamp(1.15 - m.real.y / 2, 0.55, 1.05) : THREE.MathUtils.clamp(0.95 - m.real.y * 0.55, 0.12, 0.9);
  const hh = m.real.y + 0.12;
  const W = Math.max(sw, 0.45), D = Math.max(sd, 0.45);
  const top = ph + (hood ? hh + 0.03 : m.real.y);
  return {
    type: hood ? 'hood' : 'plinth', place: 'floor', w: W + 0.6, d: D + 0.6, h: top, items: [m], hero,
    focus: new THREE.Vector3(0, ph + m.real.y / 2, 0), glow: Math.max(W, D) * 0.9 + 0.3,
    build(c, f) {
      const lv = c.lv;
      lv.bx(hero ? c.m.plinthAlt : c.m.plinth, W, ph, D, 0, 0, 0, f);
      lv.bx(c.m.fixture, W - 0.02, 0.04, D - 0.02, 0, 0, 0, f); // shadow gap
      if (hood) {
        lv.bx(c.m.glass, W - 0.02, hh, D - 0.02, 0, ph, 0, f);
        lv.bx(c.m.frame, W, 0.02, D, 0, ph + hh, 0, f);
      }
      lv.exhibit(m, f, 0, ph + 0.002, 0, a.rot, { prio: c.prio(), spin });
      lv.col(f, 0, 0, W + 0.12, D + 0.12);
      // label on the plinth front, or a lectern for very low plinths
      if (ph >= 0.5) {
        const p = labelPanel(c, [m], Math.min(0.42, W - 0.06), hero);
        put(c, p, f, 0, ph - 0.24, D / 2 + 0.003);
      } else lectern(c, f, W / 2 + 0.05, D / 2 + 0.25, [m], hero);
    },
  };
}

/** A landscape of plinths of different heights (MoMA / Vitra). */
export function cluster(items: Measured[], r: Rng, hood: boolean): Unit {
  const heights = r.shuffle([0.25, 0.55, 0.85, 1.05, 0.4, 0.7]);
  const parts = items.map((m, i) => {
    const a = along(m);
    const top = hood ? THREE.MathUtils.clamp(1.1 - m.real.y / 2, 0.45, 1.0) : Math.min(heights[i % heights.length], Math.max(0.12, 1.5 - m.real.y));
    return { m, a, W: Math.max(0.4, a.w + 0.28), D: Math.max(0.4, a.d + 0.28), ph: top, dz: (i % 2 ? -1 : 1) * 0.22 };
  });
  const gap = 0.12;
  const W = parts.reduce((s, p) => s + p.W, 0) + gap * (parts.length - 1);
  const D = Math.max(...parts.map((p) => p.D)) + 0.44;
  const h = Math.max(...parts.map((p) => p.ph + p.m.real.y + (hood ? 0.15 : 0)));
  return {
    type: 'cluster', place: 'floor', w: W + 0.6, d: D + 1.0, h, items,
    focus: new THREE.Vector3(0, 1.0, -0.3), glow: W * 0.6 + 0.4,
    build(c, f) {
      const lv = c.lv;
      const o = f.sub(0, -0.3);
      let x = -W / 2;
      for (const p of parts) {
        const cx = x + p.W / 2;
        lv.bx(c.m.plinth, p.W, p.ph, p.D, cx, 0, p.dz, o);
        if (hood) lv.bx(c.m.glass, p.W - 0.02, p.m.real.y + 0.1, p.D - 0.02, cx, p.ph, p.dz, o);
        lv.exhibit(p.m, o, cx, p.ph + 0.002, p.dz, p.a.rot, { prio: c.prio() });
        lv.col(o, cx, p.dz, p.W + 0.1, p.D + 0.1);
        x += p.W + gap;
      }
      lectern(c, f, W / 2 + 0.05, D / 2 + 0.1, items);
    },
  };
}

/** Stepped riser: medium things in tiers, tallest at the back (V&A furniture, Vitra chair wall). */
export function riser(items: Measured[], barrierKind: Barrier): Unit {
  const sorted = [...items].sort((a, b) => b.real.y - a.real.y);
  const nt = sorted.length >= 6 ? 3 : 2;
  const tiers: Measured[][] = Array.from({ length: nt }, () => []);
  sorted.forEach((m, i) => tiers[Math.min(nt - 1, Math.floor((i * nt) / sorted.length))].push(m));
  // tiers[0] = tallest = back (highest step)
  const gap = 0.25;
  const tierW = tiers.map((t) => t.reduce((s, m) => s + along(m).w, 0) + gap * (t.length + 1));
  const tierD = tiers.map((t) => Math.max(...t.map((m) => along(m).d)) + 0.35);
  const W = Math.max(...tierW);
  const D = tierD.reduce((s, d) => s + d, 0);
  const step = 0.3;
  const h = Math.max(...tiers.map((t, i) => (nt - i) * step + Math.max(...t.map((m) => m.real.y))));
  const bOff = barrierKind === 'edge' ? 0 : 0.5;
  return {
    type: 'riser', place: 'floor', w: W + bOff * 2 + 0.2, d: D + bOff + 1.0, h, items: sorted,
    focus: new THREE.Vector3(0, 0.9, -0.4), glow: W * 0.55 + 0.4,
    build(c, f) {
      const lv = c.lv;
      const o = f.sub(0, -0.4);
      let z = -D / 2;
      tiers.forEach((t, i) => {
        const y = (nt - i) * step;
        const td = tierD[i];
        lv.bx(c.m.plinth, W, y, td, 0, 0, z + td / 2, o);
        lv.bx(c.m.plinthAlt, W + 0.02, 0.02, 0.04, 0, y - 0.02, z + td - 0.02, o);
        // spread this tier's objects evenly
        const used = t.reduce((s, m) => s + along(m).w, 0);
        const g = (W - used) / (t.length + 1);
        let x = -W / 2 + g;
        for (const m of t) {
          const a = along(m);
          lv.exhibit(m, o, x + a.w / 2, y + 0.002, z + td / 2, a.rot, { prio: c.prio() });
          x += a.w + g;
        }
        z += td;
      });
      lv.col(o, 0, 0, W + 0.1, D + 0.1);
      if (bOff) {
        // a rope along the front only
        const bf = o.sub(0, D / 2 + bOff);
        const n = Math.max(1, Math.ceil(W / 2.2));
        let prev: THREE.Vector3 | null = null;
        for (let i = 0; i <= n; i++) {
          const x = -W / 2 + (W * i) / n;
          lv.cy(c.m.brass, 0.028, 0.95, x, 0, 0, bf, true);
          lv.cy(c.m.brass, 0.14, 0.03, x, 0, 0, bf, true);
          const p = bf.point(x, 0.9, 0);
          if (prev) {
            const mid = prev.clone().add(p).multiplyScalar(0.5);
            mid.y -= 0.12;
            lv.rod(c.m.rope, prev, mid, 0.018);
            lv.rod(c.m.rope, mid, p, 0.018);
          }
          prev = p;
        }
        lv.col(bf, 0, 0, W, 0.1);
      }
      lectern(c, f, W / 2 - 0.2, D / 2 - 0.4 + bOff + 0.45, sorted);
    },
  };
}

/** pack things into shelves of length `len`, tallest first; returns the shelves and what did not fit */
export function packShelves(items: Measured[], len: number, maxH: number, depth: number, gap = 0.08) {
  const sorted = [...items].sort((a, b) => b.real.y - a.real.y);
  const shelves: { h: number; items: { m: Measured; w: number; rot: number }[]; used: number }[] = [];
  const rest: Measured[] = [];
  let total = 0;
  for (const m of sorted) {
    const a = along(m);
    if (a.d > depth || a.w > len) {
      rest.push(m);
      continue;
    }
    let s = shelves[shelves.length - 1];
    if (!s || s.used + a.w + gap > len) {
      const sh = m.real.y + 0.1;
      if (total + sh > maxH) {
        rest.push(m);
        continue;
      }
      s = { h: sh, items: [], used: gap };
      shelves.push(s);
      total += sh;
    }
    s.items.push({ m, w: a.w, rot: a.rot });
    s.used += a.w + gap;
  }
  return { shelves, rest, total };
}

/** Tall free-standing glass tower with glass shelves, lit from the top (V&A Room 143). */
export function vitrine(items: Measured[], inner: number): { unit: Unit; rest: Measured[] } {
  const { shelves, rest } = packShelves(items, inner, 1.75, inner, 0.06);
  const used = shelves.flatMap((s) => s.items.map((i) => i.m));
  const W = inner + 0.12, base = 0.42, gh = 1.95;
  return {
    rest,
    unit: {
      type: 'vitrine', place: 'floor', w: W + 1.0, d: W + 1.0, h: base + gh + 0.12, items: used,
      focus: new THREE.Vector3(0, 1.3, 0), glow: W * 0.9,
      build(c, f) {
        const lv = c.lv;
        lv.bx(c.m.caseBase, W, base, W, 0, 0, 0, f);
        lv.bx(c.m.glass, W, gh, W, 0, base, 0, f);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) lv.bx(c.m.frame, 0.025, gh, 0.025, (sx * W) / 2, base, (sz * W) / 2, f);
        lv.bx(c.m.frame, W + 0.02, 0.12, W + 0.02, 0, base + gh, 0, f);
        lv.bx(c.m.caseLight, W * 0.7, 0.01, W * 0.7, 0, base + gh - 0.012, 0, f);
        // shelves bottom-up (the tallest objects at the bottom)
        let y = base + 0.02;
        for (const s of shelves) {
          if (y > base + 0.05) lv.bx(c.m.shelf, inner, 0.012, inner, 0, y - 0.012, 0, f);
          let x = -inner / 2 + (inner - (s.used - 0.06)) / 2 + 0.06;
          for (const it of s.items) {
            lv.exhibit(it.m, f, x + it.w / 2, y, 0, it.rot, { prio: c.prio() });
            x += it.w + 0.06;
          }
          y += s.h;
        }
        lv.col(f, 0, 0, W + 0.1, W + 0.1);
        const p = labelPanel(c, used, W - 0.04);
        put(c, p, f, 0, base - 0.05 - (p.geometry as THREE.PlaneGeometry).parameters.height / 2, W / 2 + 0.003);
        lv.pool(f.x, base + 0.003, f.z, W * 0.5, '#fff1d6', 0.25);
      },
    },
  };
}

/** Flat table case: a cabinet with a low glass hood, objects laid out in a grid (V&A "Glazes"). */
export function tableCase(items: Measured[], maxLen: number): { unit: Unit; rest: Measured[] } {
  const depth = 0.78, hoodH = 0.3;
  // rows across the depth, items along x
  const sorted = [...items].sort((a, b) => along(b).d - along(a).d);
  const rows: { d: number; items: { m: Measured; w: number; rot: number }[]; used: number }[] = [];
  const rest: Measured[] = [];
  let dz = 0;
  for (const m of sorted) {
    const a = along(m);
    if (m.real.y > hoodH - 0.04 || a.d > depth || a.w > maxLen) {
      rest.push(m);
      continue;
    }
    let r = rows.find((row) => row.used + a.w + 0.06 <= maxLen && a.d <= row.d + 0.001);
    if (!r) {
      if (dz + a.d + 0.06 > depth) {
        rest.push(m);
        continue;
      }
      r = { d: a.d, items: [], used: 0.06 };
      rows.push(r);
      dz += a.d + 0.06;
    }
    r.items.push({ m, w: a.w, rot: a.rot });
    r.used += a.w + 0.06;
  }
  const used = rows.flatMap((r) => r.items.map((i) => i.m));
  const L = Math.max(1.2, Math.min(maxLen, Math.max(...rows.map((r) => r.used), 0) + 0.1));
  const base = 0.86;
  return {
    rest,
    unit: {
      type: 'table', place: 'floor', w: L + 1.2, d: depth + 0.12 + 1.6, h: base + hoodH, items: used,
      focus: new THREE.Vector3(0, base, 0), glow: L * 0.55,
      build(c, f) {
        const lv = c.lv;
        const W = L + 0.12, D = depth + 0.12;
        lv.bx(c.m.caseBase, W - 0.1, base - 0.1, D - 0.1, 0, 0.1, 0, f);
        lv.bx(c.m.fixture, W - 0.2, 0.1, D - 0.2, 0, 0, 0, f);
        lv.bx(c.m.plinthAlt, W, 0.025, D, 0, base - 0.025, 0, f);
        lv.bx(c.m.glass, W, hoodH, D, 0, base, 0, f);
        lv.bx(c.m.frame, W + 0.01, 0.015, D + 0.01, 0, base + hoodH, 0, f);
        let z = -depth / 2 + 0.03;
        for (const r of rows) {
          let x = -L / 2 + (L - r.used) / 2 + 0.06;
          for (const it of r.items) {
            lv.exhibit(it.m, f, x + it.w / 2, base + 0.001, z + r.d / 2, it.rot, { prio: c.prio() });
            x += it.w + 0.06;
          }
          z += r.d + 0.06;
        }
        lv.col(f, 0, 0, W + 0.1, D + 0.1);
        const p = labelPanel(c, used, Math.min(0.9, W - 0.1));
        put(c, p, f, 0, base - 0.08 - (p.geometry as THREE.PlaneGeometry).parameters.height / 2, D / 2 - 0.045);
        lv.pool(f.x, base, f.z, Math.max(W, D) * 0.45, '#fff1d6', 0.22);
      },
    },
  };
}

/** A bench for the visitors (leather on a dark frame, after the V&A / Louvre). */
export function bench(): Unit {
  return {
    type: 'bench', place: 'floor', w: 2.4, d: 1.4, h: 1.25, items: [],
    focus: new THREE.Vector3(), glow: 0,
    build(c, f) {
      const lv = c.lv;
      lv.bx(c.m.fixture, 0.06, 0.38, 0.4, -0.75, 0, 0, f);
      lv.bx(c.m.fixture, 0.06, 0.38, 0.4, 0.75, 0, 0, f);
      lv.bx(c.m.leather, 1.8, 0.08, 0.5, 0, 0.38, 0, f);
      lv.col(f, 0, 0, 1.9, 0.6);
    },
  };
}

// ---------------------------------------------------------------- wall displays

/** Wall case: a cabinet base, glass front, glass shelves, light in the canopy (V&A ceramics). */
export function wallCase(items: Measured[], len: number, storage: boolean): { unit: Unit; rest: Measured[] } {
  const depth = storage ? 0.48 : 0.6;
  const base = storage ? 0.35 : 0.65;
  const gh = storage ? 2.25 : 1.75;
  const { shelves, rest } = packShelves(items, len - 0.1, gh - 0.1, depth - 0.1, storage ? 0.05 : 0.1);
  const used = shelves.flatMap((s) => s.items.map((i) => i.m));
  return {
    rest,
    unit: {
      type: storage ? 'storage' : 'wallcase', place: 'wall', w: len, d: depth, h: base + gh + 0.15, items: used,
      focus: new THREE.Vector3(0, base + gh / 2, depth / 2), glow: 0,
      build(c, f) {
        const lv = c.lv;
        const zc = depth / 2;
        lv.bx(c.m.caseBase, len, base, depth, 0, 0, zc, f);
        lv.bx(c.m.frame, len, 0.03, depth, 0, base, zc, f);
        lv.bx(c.m.glass, len, gh, 0.012, 0, base, depth, f);
        lv.bx(c.m.caseBase, len, gh, 0.02, 0, base, 0.01, f);
        for (const s of [-1, 1]) lv.bx(c.m.frame, 0.035, gh, depth, (s * len) / 2, base, zc, f);
        if (storage) for (let x = -len / 2 + 0.9; x < len / 2 - 0.3; x += 0.9) lv.bx(c.m.frame, 0.02, gh, 0.02, x, base, depth, f);
        lv.bx(c.m.frame, len + 0.02, 0.15, depth + 0.02, 0, base + gh, zc, f);
        lv.bx(c.m.caseLight, len - 0.1, 0.01, 0.12, 0, base + gh - 0.012, depth - 0.12, f);
        let y = base + 0.03;
        for (const s of shelves) {
          if (y > base + 0.06) {
            lv.bx(c.m.shelf, len - 0.08, 0.012, depth - 0.06, 0, y - 0.012, zc, f);
          }
          let x = -len / 2 + (len - s.used) / 2 + (storage ? 0.05 : 0.1);
          for (const it of s.items) {
            lv.exhibit(it.m, f, x + it.w / 2, y, zc, it.rot, { prio: c.prio() });
            x += it.w + (storage ? 0.05 : 0.1);
          }
          y += s.h;
        }
        lv.col(f, 0, zc, len, depth + 0.1);
        const p = labelPanel(c, used, Math.min(1.2, len - 0.2));
        const ph = (p.geometry as THREE.PlaneGeometry).parameters.height;
        put(c, p, f, 0, Math.max(0.12 + ph / 2, base - 0.08 - ph / 2), depth + 0.004);
        // the case throws a little light on the floor in front
        const fp = f.point(0, 0, depth + 0.5);
        lv.pool(fp.x, 0, fp.z, len * 0.45, '#fff1d6', 0.12);
      },
    },
  };
}

/** Flat things hung on the wall (Wallace Collection armoury, guitar walls), with a label beside. */
export function mount(m: Measured): Unit {
  // the thinnest horizontal axis goes into the wall
  const rot = m.real.x >= m.real.z ? 0 : Math.PI / 2;
  const w = Math.max(m.real.x, m.real.z), d = Math.min(m.real.x, m.real.z);
  const y0 = Math.max(0.45, 1.5 - m.real.y / 2);
  return {
    type: 'mount', place: 'wall', w: w + 0.75, d: d + 0.12, h: y0 + m.real.y, items: [m],
    focus: new THREE.Vector3(-0.2, y0 + m.real.y / 2, 0), glow: 0,
    build(c, f) {
      const lv = c.lv;
      const x0 = -0.25;
      lv.bx(c.m.fixture, 0.06, 0.06, 0.08, x0, y0 + m.real.y * 0.45, 0.04, f);
      lv.bx(c.m.plinthAlt, Math.min(w, 0.4), 0.04, d + 0.06, x0, y0 - 0.04, (d + 0.06) / 2, f);
      lv.exhibit(m, f, x0, y0, 0.06 + d / 2, rot, { prio: c.prio() });
      lv.col(f, x0, d / 2, w, d + 0.4);
      const p = labelPanel(c, [m], 0.3);
      put(c, p, f, x0 + w / 2 + 0.2, 1.25, 0.006);
      // a soft wash of light on the wall behind
      const wash = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), washMat());
      wash.scale.set(w + 0.8, m.real.y + 0.9, 1);
      put(c, wash, f, x0, y0 + m.real.y / 2, 0.004);
      wash.userData.owned = true;
    },
  };
}

let wash: THREE.MeshBasicMaterial | null = null;
function washMat() {
  if (wash) return wash;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d')!;
  const gr = g.createRadialGradient(64, 54, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,240,215,0.16)');
  gr.addColorStop(0.6, 'rgba(255,240,215,0.05)');
  gr.addColorStop(1, 'rgba(255,240,215,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  wash = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  return wash;
}

// ---------------------------------------------------------------- suspended

/** Aircraft hang from the roof on steel cables at real size (Udvar-Hazy, Science Museum Flight). */
export function hang(m: Measured, bank: number): Unit {
  // long axis along local z (the hall's length)
  const rot = m.real.x >= m.real.z ? Math.PI / 2 : 0;
  const L = Math.max(m.real.x, m.real.z), S = Math.min(m.real.x, m.real.z);
  return {
    type: 'hang', place: 'hang', w: S, d: L, h: m.real.y, items: [m],
    focus: new THREE.Vector3(0, m.real.y / 2, 0), glow: 0,
    build(c, f) {
      // f.y is the height of the object's base; cables run up to the ceiling (stored in focus.y by the planner)
      const lv = c.lv;
      const slot = lv.exhibit(m, f, 0, 0, 0, rot, { prio: c.prio() });
      slot.holder.rotation.z = bank;
      const top = (this as Unit & { ceiling?: number }).ceiling ?? f.y + 6;
      for (const [sx, sz] of [[-0.3, -0.3], [0.3, -0.3], [0, 0.35]]) {
        const p = f.point(sx * S, m.real.y * 0.7, sz * L);
        lv.rod(c.m.cable, p, new THREE.Vector3(p.x, top, p.z), 0.006);
      }
    },
  };
}
