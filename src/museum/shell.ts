import * as THREE from 'three';
import { mat } from '../build';
import { surface } from '../pbr';
import type { LevelDesc } from '../level';
import { rect } from '../level';
import { shade, WORLD, type MuseumBase } from './base';
import type { Door, Plan, Wall } from './plan';
import type { Floor, Style } from './style';
import { textPlane, SANS, SERIF } from './text';

const T = 0.3;
const CORR = 2.4;

export function floorMaterial(k: Floor): THREE.Material {
  switch (k) {
    case 'parquet': return surface('floor_parquet', [1, 1], { roughness: 0.75, normalScale: 0.8 });
    case 'marble': return surface('floor_marble', [1, 1], { roughness: 0.5, normalScale: 0.5 });
    case 'concrete': return surface('floor_concrete', [1, 1], { roughness: 0.55, normalScale: 0.6, color: '#c9c9c6' });
    case 'oak': return surface('floor_laminate', [1, 1], { roughness: 0.6, normalScale: 0.6, color: '#efe6d8' });
    case 'tiles': return surface('floor_tiles', [1, 1], { roughness: 0.6, normalScale: 0.5 });
    case 'carpet': return surface('floor_carpet', [1, 1], { roughness: 1, normalScale: 0.6, color: '#4a3a33' });
    case 'terrazzo': return surface('floor_marble', [1, 1], { roughness: 0.45, normalScale: 0.4, color: '#d9d6cf' });
    case 'lawn': return mat('#5f7d3c', { rough: 1 });
  }
}

/** a horizontal plane with UVs in metres */
function floorPlane(m: THREE.Material, w: number, d: number, x: number, y: number, z: number) {
  const g = new THREE.PlaneGeometry(w, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w + x, uv.getY(i) * d - z);
  const mesh = new THREE.Mesh(g, m);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, y, z);
  mesh.receiveShadow = true;
  mesh.userData.owned = true;
  return mesh;
}

export interface ShellOpts {
  title: string;
  sub: string;
  words: string[];
  intro: string;
}

export function buildShell(lv: MuseumBase, p: Plan, st: Style) {
  const { W, D, Hw } = p;
  const g = lv.group;
  const dark = st.dark;
  const wallM = st.arch === 'machine' && p.wallColor === '#8c5a44' ? brick() : st.outdoor && st.arch === 'openair' ? brick() : mat(p.wallColor, { rough: 0.92 });
  const trim = mat(st.trim, { rough: 0.6 });
  // floor
  g.add(floorPlane(floorMaterial(p.floorKind), W, D, 0, 0, -D / 2));
  if (st.arch === 'openair') {
    // gravel paths: a ring and a cross axis
    const gravel = surface('nyc_sidewalk', [1, 1], { roughness: 1, color: '#d8ccb4' });
    g.add(floorPlane(gravel, 3, D, 0, 0.004, -D / 2));
    g.add(floorPlane(gravel, W, 3, 0, 0.005, -2.2));
  }

  // walls: outside the room's boundary, so the inside is exactly W x D
  const wallH = st.arch === 'openair' ? 3.4 : Hw;
  const walls: Record<Wall, { axis: 'x' | 'z'; c: number; a0: number; a1: number; out: number }> = {
    N: { axis: 'z', c: -D, a0: -W / 2 - T, a1: W / 2 + T, out: -1 },
    S: { axis: 'z', c: 0, a0: -W / 2 - T, a1: W / 2 + T, out: 1 },
    W: { axis: 'x', c: -W / 2, a0: -D, a1: 0, out: -1 },
    E: { axis: 'x', c: W / 2, a0: -D, a1: 0, out: 1 },
  };
  for (const [k, wl] of Object.entries(walls) as [Wall, (typeof walls)['N']][]) {
    const ds = p.doors.filter((d) => d.wall === k).sort((a, b) => a.at - b.at);
    const cc = wl.c + (wl.out * T) / 2;
    const seg = (s0: number, s1: number, y0: number, y1: number) => {
      if (s1 - s0 < 0.01 || y1 - y0 < 0.01) return;
      if (wl.axis === 'z') lv.bx(wallM, s1 - s0, y1 - y0, T, (s0 + s1) / 2, y0, cc);
      else lv.bx(wallM, T, y1 - y0, s1 - s0, cc, y0, (s0 + s1) / 2);
    };
    let cur = wl.a0;
    let c0 = wl.a0;
    for (const d of ds) {
      seg(cur, d.at - d.w / 2, 0, wallH);
      seg(d.at - d.w / 2, d.at + d.w / 2, d.h, wallH);
      cur = d.at + d.w / 2;
      wallCol(lv, wl.axis, cc, c0, d.at - d.w / 2);
      c0 = d.at + d.w / 2;
      doorFrame(lv, wl.axis, wl.c, wl.out, d, trim, st);
      corridor(lv, wl.axis, wl.c, wl.out, d, st);
    }
    seg(cur, wl.a1, 0, wallH);
    wallCol(lv, wl.axis, cc, c0, wl.a1);
    // skirting, dado rail and cornice (period), a shadow gap (white cube)
    const run = (y: number, h: number, depth: number, m: THREE.Material) => {
      const len = wl.a1 - wl.a0 - 2 * T;
      const mid = (wl.a0 + wl.a1) / 2;
      const off = wl.c - (wl.out * depth) / 2;
      if (wl.axis === 'z') lv.bx(m, len, h, depth, mid, y, off);
      else lv.bx(m, depth, h, len + (k === 'W' || k === 'E' ? 2 * T : 0), off, y, mid);
    };
    if (st.arch === 'openair') {
      lv.bx(mat('#b8ab95', { rough: 0.8 }), wl.axis === 'z' ? wl.a1 - wl.a0 : T + 0.14, 0.14, wl.axis === 'z' ? T + 0.14 : wl.a1 - wl.a0, wl.axis === 'z' ? (wl.a0 + wl.a1) / 2 : cc, wallH, wl.axis === 'z' ? cc : (wl.a0 + wl.a1) / 2);
      continue;
    }
    if (st.arch === 'whitecube') run(0, 0.04, 0.012, mat('#1a1a1a'));
    else run(0, 0.16, 0.025, dark ? mat(shade(p.wallColor, 0.6)) : trim);
    if (st.arch === 'period') {
      run(0.95, 0.06, 0.03, trim);
      run(Hw - 0.35, 0.35, 0.12, trim);
    }
    if (st.arch === 'study' || st.arch === 'machine') run(Hw - 0.25, 0.25, 0.08, trim);
  }

  // ceilings
  ceilingOf(lv, p, st);
  if (st.arch === 'openair') parkTrees(lv, p);
}

/** trees along the park wall, clear of the gateways */
function parkTrees(lv: MuseumBase, p: Plan) {
  const { W, D } = p;
  const bark = mat('#5a4636', { rough: 1 });
  const leaves = [mat('#4f6b33', { rough: 1 }), mat('#3f5a2a', { rough: 1 }), mat('#5d7a3a', { rough: 1 })];
  const ico = new THREE.IcosahedronGeometry(1, 1);
  let k = 0;
  const tree = (x: number, z: number) => {
    k++;
    const s = 0.8 + ((k * 37) % 10) / 20;
    lv.cy(bark, 0.18 * s, 3.2 * s, x, 0, z, WORLD, true);
    for (let i = 0; i < 3; i++) {
      const a = k * 1.7 + i * 2.1;
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x + Math.cos(a) * 0.8 * s, (3.6 + i * 0.7) * s, z + Math.sin(a) * 0.8 * s), new THREE.Quaternion(), new THREE.Vector3(1.7, 1.5, 1.7).multiplyScalar(s * (1.1 - i * 0.15)));
      lv.geo(leaves[(k + i) % 3], ico, m);
    }
    (lv as unknown as { cols: ReturnType<typeof rect>[] }).cols.push(rect(x, z, 0.5, 0.5));
  };
  const clear = (wall: Wall, s: number) => !p.doors.some((d) => d.wall === wall && Math.abs(d.at - s) < d.w / 2 + 3) && !(wall === 'S' && Math.abs(s) < 6);
  for (let x = -W / 2 + 2.5; x <= W / 2 - 2.5; x += 8) {
    if (clear('N', x)) tree(x, -D + 2.2);
    if (clear('S', x)) tree(x, -2.2);
  }
  for (let z = -D + 8; z <= -8; z += 8) {
    if (clear('W', z)) tree(-W / 2 + 2.2, z);
    if (clear('E', z)) tree(W / 2 - 2.2, z);
  }
}

function brick() {
  const m = surface('nyc_brick', [1, 1], { roughness: 0.9, color: '#c9a48f' });
  m.userData.worldUV = true;
  return m;
}

function wallCol(lv: MuseumBase, axis: 'x' | 'z', c: number, a0: number, a1: number) {
  if (a1 - a0 < 0.01) return;
  (lv as unknown as { cols: ReturnType<typeof rect>[] }).cols.push(axis === 'z' ? rect((a0 + a1) / 2, c, a1 - a0, 0.5) : rect(c, (a0 + a1) / 2, 0.5, a1 - a0));
}

function doorFrame(lv: MuseumBase, axis: 'x' | 'z', c: number, out: number, d: Door, trim: THREE.Material, st: Style) {
  const fw = st.arch === 'period' ? 0.22 : st.arch === 'whitecube' ? 0.0 : 0.12;
  if (!fw) return;
  const cc = c + (out * T) / 2;
  const depth = T + 0.08;
  for (const s of [-1, 1]) {
    const o = d.at + s * (d.w / 2 + fw / 2);
    if (axis === 'z') lv.bx(trim, fw, d.h, depth, o, 0, cc);
    else lv.bx(trim, depth, d.h, fw, cc, 0, o);
  }
  if (axis === 'z') lv.bx(trim, d.w + 2 * fw, fw * 1.2, depth, d.at, d.h, cc);
  else lv.bx(trim, depth, fw * 1.2, d.w + 2 * fw, cc, d.h, d.at);
  if (st.arch === 'period') {
    // a pediment-ish cornice over the door
    if (axis === 'z') lv.bx(trim, d.w + 2 * fw + 0.3, 0.12, depth + 0.1, d.at, d.h + fw * 1.2, cc);
    else lv.bx(trim, depth + 0.1, 0.12, d.w + 2 * fw + 0.3, cc, d.h + fw * 1.2, d.at);
  }
}

/** a short passage beyond a doorway (you walk into it to go on) */
function corridor(lv: MuseumBase, axis: 'x' | 'z', c: number, out: number, d: Door, st: Style) {
  const m = st.arch === 'openair' ? mat('#3c4a2e', { rough: 1 }) : mat('#14110d', { rough: 1 });
  const cc = c + out * (T + CORR / 2);
  const end = c + out * (T + CORR);
  if (axis === 'z') {
    lv.bx(m, 0.1, d.h, CORR, d.at - d.w / 2 - 0.05, 0, cc);
    lv.bx(m, 0.1, d.h, CORR, d.at + d.w / 2 + 0.05, 0, cc);
    lv.bx(m, d.w + 0.2, 0.1, CORR, d.at, d.h, cc);
    lv.bx(m, d.w + 0.2, d.h, 0.1, d.at, 0, end);
    lv.bx(m, d.w + 0.2, 0.01, CORR + T, d.at, 0, c + (out * (T + CORR)) / 2);
    pushCols(lv, rect(d.at, end, d.w + 0.4, 0.3), rect(d.at - d.w / 2 - 0.1, cc, 0.2, CORR), rect(d.at + d.w / 2 + 0.1, cc, 0.2, CORR));
  } else {
    lv.bx(m, CORR, d.h, 0.1, cc, 0, d.at - d.w / 2 - 0.05);
    lv.bx(m, CORR, d.h, 0.1, cc, 0, d.at + d.w / 2 + 0.05);
    lv.bx(m, CORR, 0.1, d.w + 0.2, cc, d.h, d.at);
    lv.bx(m, 0.1, d.h, d.w + 0.2, end, 0, d.at);
    lv.bx(m, CORR + T, 0.01, d.w + 0.2, c + (out * (T + CORR)) / 2, 0, d.at);
    pushCols(lv, rect(end, d.at, 0.3, d.w + 0.4), rect(cc, d.at - d.w / 2 - 0.1, CORR, 0.2), rect(cc, d.at + d.w / 2 + 0.1, CORR, 0.2));
  }
}

function pushCols(lv: MuseumBase, ...r: ReturnType<typeof rect>[]) {
  (lv as unknown as { cols: ReturnType<typeof rect>[] }).cols.push(...r);
}

/** the walk-through trigger inside a door's corridor, and where to stand when you come back */
export function doorPortal(lv: MuseumBase, d: Door, W: number, D: number, label: string, sub: string, target: LevelDesc | 'back') {
  let bx: THREE.Box3, ret: THREE.Vector3, yaw: number;
  const a = T + 0.5, b = T + CORR;
  if (d.wall === 'N') {
    bx = new THREE.Box3(new THREE.Vector3(d.at - d.w / 2, 0, -D - b), new THREE.Vector3(d.at + d.w / 2, d.h, -D - a));
    ret = new THREE.Vector3(d.at, 0, -D + 1.6);
    yaw = Math.PI;
  } else if (d.wall === 'S') {
    bx = new THREE.Box3(new THREE.Vector3(d.at - d.w / 2, 0, a), new THREE.Vector3(d.at + d.w / 2, d.h, b));
    ret = new THREE.Vector3(d.at, 0, -1.6);
    yaw = 0;
  } else if (d.wall === 'W') {
    bx = new THREE.Box3(new THREE.Vector3(-W / 2 - b, 0, d.at - d.w / 2), new THREE.Vector3(-W / 2 - a, d.h, d.at + d.w / 2));
    ret = new THREE.Vector3(-W / 2 + 1.6, 0, d.at);
    yaw = -Math.PI / 2;
  } else {
    bx = new THREE.Box3(new THREE.Vector3(W / 2 + a, 0, d.at - d.w / 2), new THREE.Vector3(W / 2 + b, d.h, d.at + d.w / 2));
    ret = new THREE.Vector3(W / 2 - 1.6, 0, d.at);
    yaw = Math.PI / 2;
  }
  lv.portals().push({ box: bx, label, sub, target, auto: true, returnPos: ret, returnYaw: yaw });
}

/** a sign above a doorway, readable from inside the room */
export function doorSign(lv: MuseumBase, d: Door, W: number, D: number, top: string, main: string, bg: string, ink = '#fff') {
  const s = textPlane([{ text: top, size: 0.1, color: shade(ink, 0.8), weight: 500, font: SANS }, { text: main, size: 0.22, color: ink, font: SERIF }], Math.max(3.0, d.w + 1.0), 0.66, bg);
  const off = 0.02;
  const y = d.h + 0.6;
  if (d.wall === 'N') s.position.set(d.at, y, -D + off);
  else if (d.wall === 'S') {
    s.position.set(d.at, y, -off);
    s.rotation.y = Math.PI;
  } else if (d.wall === 'W') {
    s.position.set(-W / 2 + off, y, d.at);
    s.rotation.y = Math.PI / 2;
  } else {
    s.position.set(W / 2 - off, y, d.at);
    s.rotation.y = -Math.PI / 2;
  }
  lv.group.add(s);
}

// ---------------------------------------------------------------- ceilings

function ceilingOf(lv: MuseumBase, p: Plan, st: Style) {
  const { W, D, H, Hw } = p;
  const g = lv.group;
  const ceilM = mat(st.dark ? '#1b1a19' : '#f3f1ec', { rough: 1 });
  const cz = -D / 2;
  const glazing = mat('#eef4fa', { emissive: '#f2f6ff', ei: st.dark ? 0.4 : 1.25 });
  switch (p.ceiling) {
    case 'open':
      return;
    case 'flat': {
      g.add(flatCeil(ceilM, W, D, H, cz));
      // recessed downlights
      const lens = mat('#fff8ea', { emissive: '#fff6e6', ei: 2 });
      for (let x = -W / 2 + 2; x < W / 2 - 1; x += 3) for (let z = -D + 2; z < -1; z += 3) lv.cy(lens, 0.08, 0.01, x, H - 0.012, z, WORLD, true);
      return;
    }
    case 'coffer': {
      g.add(flatCeil(ceilM, W, D, H, cz));
      const beam = mat(st.dark ? '#262321' : '#ece6da', { rough: 0.9 });
      const s = 2.4;
      for (let x = -W / 2 + s; x < W / 2 - 0.5; x += s) lv.bx(beam, 0.28, 0.38, D, x, H - 0.38, cz);
      for (let z = -D + s; z < -0.5; z += s) lv.bx(beam, W, 0.38, 0.28, 0, H - 0.38, z);
      lv.bx(beam, W, 0.5, 0.4, 0, H - 0.5, -D + 0.2);
      lv.bx(beam, W, 0.5, 0.4, 0, H - 0.5, -0.2);
      return;
    }
    case 'lantern': {
      // a long glazed roof lantern over the middle (V&A Room 143)
      const lw = Math.min(W * 0.5, 6), ld = D - 3;
      const side = (W - lw) / 2;
      const flat = mat(st.dark ? '#1b1a19' : '#f3f1ec', { rough: 1 });
      lv.bx(flat, side, 0.3, D, -W / 2 + side / 2, H, cz);
      lv.bx(flat, side, 0.3, D, W / 2 - side / 2, H, cz);
      lv.bx(flat, lw, 0.3, 1.5, 0, H, -D + 0.75);
      lv.bx(flat, lw, 0.3, 1.5, 0, H, -0.75);
      const up = 1.4;
      for (const s of [-1, 1]) lv.bx(flat, 0.2, up, ld, (s * (lw + 0.2)) / 2, H, cz);
      // glazing with ribs
      lv.bx(glazing, lw, 0.05, ld, 0, H + up, cz);
      const rib = mat('#d9d6cf', { rough: 0.7 });
      for (let z = -D + 1.5; z <= -1.5; z += 1.2) lv.bx(rib, lw, 0.14, 0.08, 0, H + up - 0.14, z);
      lv.bx(rib, 0.1, 0.14, ld, 0, H + up - 0.14, cz);
      return;
    }
    case 'truss': {
      // a roof above steel trusses spanning the width; clerestory light along the top of the walls
      const roof = mat(st.dark ? '#1e1f21' : '#d9dadb', { rough: 0.9 });
      lv.bx(roof, W + 0.6, 0.2, D + 0.6, 0, H + 1.6, cz);
      for (const s of [-1, 1]) lv.bx(st.dark ? mat('#2a2c2e') : glazing, 0.1, 1.6, D, (s * W) / 2 + s * 0.2, H, cz);
      lv.bx(st.dark ? mat('#2a2c2e') : glazing, W, 1.6, 0.1, 0, H, -D - 0.2);
      lv.bx(st.dark ? mat('#2a2c2e') : glazing, W, 1.6, 0.1, 0, H, 0.2);
      const steel = mat(st.dark ? '#3a3d40' : '#e8eaec', { metal: 0.5, rough: 0.5 });
      const bays = Math.max(2, Math.round(D / 6));
      for (let i = 1; i < bays; i++) {
        const z = -D + (D * i) / bays;
        lv.bx(steel, W, 0.18, 0.18, 0, H, z);
        lv.bx(steel, W, 0.18, 0.18, 0, H + 1.4, z);
        const n = Math.max(4, Math.round(W / 1.6));
        for (let k = 0; k <= n; k++) {
          const x = -W / 2 + (W * k) / n;
          lv.rod(steel, new THREE.Vector3(x, H, z), new THREE.Vector3(x, H + 1.5, z), 0.05);
          if (k < n) lv.rod(steel, new THREE.Vector3(x, k % 2 ? H : H + 1.5, z), new THREE.Vector3(-W / 2 + (W * (k + 1)) / n, k % 2 ? H + 1.5 : H, z), 0.04);
        }
      }
      return;
    }
    case 'vault': {
      // a barrel vault of white steel ribs (Udvar-Hazy), with a skylight strip along the crown
      const R = W / 2;
      const ky = (H - Hw) / R;
      const shell = new THREE.CylinderGeometry(R, R, D, 48, 1, true, -Math.PI / 2, Math.PI);
      const vm = new THREE.MeshStandardMaterial({ color: '#e9ecef', roughness: 0.85, side: THREE.BackSide });
      const v = new THREE.Mesh(shell, vm);
      v.rotation.x = Math.PI / 2;
      v.scale.set(1, 1, ky);
      v.position.set(0, Hw, cz);
      v.userData.owned = true;
      g.add(v);
      // end walls (half ellipses)
      const half = new THREE.CircleGeometry(R, 48, 0, Math.PI);
      for (const z of [-D, 0]) {
        const e = new THREE.Mesh(half, mat('#dfe3e6', { rough: 0.9 }));
        e.scale.set(1, ky, 1);
        e.position.set(0, Hw, z);
        if (z === 0) e.rotation.y = Math.PI;
        e.userData.owned = true;
        g.add(e);
      }
      const rib = mat('#f6f7f8', { metal: 0.4, rough: 0.5 });
      const torus = new THREE.TorusGeometry(R - 0.15, 0.12, 6, 40, Math.PI);
      for (let z = -D + 4; z < -1; z += 5) {
        const m = new THREE.Matrix4().makeTranslation(0, Hw, z).multiply(new THREE.Matrix4().makeScale(1, ky, 1));
        lv.geo(rib, torus, m);
      }
      lv.bx(glazing, Math.min(3, W * 0.12), 0.06, D, 0, H - 0.15, cz);
      for (const s of [-1, 1]) lv.bx(glazing, 0.6, 0.06, D, s * R * 0.62, Hw + ky * R * 0.78 - 0.1, cz);
      return;
    }
    case 'glass': {
      // pitched glass roof on white ribs (Kew Palm House)
      const rise = Math.min(4, W * 0.25);
      const glass = new THREE.MeshStandardMaterial({ color: '#dfeff5', roughness: 0.05, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
      const white = mat('#f7f7f5', { rough: 0.5 });
      const slope = Math.hypot(W / 2, rise);
      const ang = Math.atan2(rise, W / 2);
      for (const s of [-1, 1]) {
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(slope, D), glass);
        pane.rotation.set(-Math.PI / 2, 0, 0);
        pane.rotateY(s * ang * -1);
        pane.position.set((s * W) / 4, H + rise / 2, cz);
        pane.userData.owned = true;
        pane.renderOrder = 3;
        g.add(pane);
      }
      for (let z = -D; z <= 0.01; z += 2) {
        lv.rod(white, new THREE.Vector3(-W / 2, H, z), new THREE.Vector3(0, H + rise, z), 0.05);
        lv.rod(white, new THREE.Vector3(W / 2, H, z), new THREE.Vector3(0, H + rise, z), 0.05);
      }
      lv.bx(white, 0.15, 0.15, D, 0, H + rise - 0.1, cz);
      return;
    }
  }
}

function flatCeil(m: THREE.Material, W: number, D: number, H: number, cz: number) {
  const c = new THREE.Mesh(new THREE.PlaneGeometry(W + 2 * T, D + 2 * T), m);
  c.rotation.x = Math.PI / 2;
  c.position.set(0, H, cz);
  c.userData.owned = true;
  return c;
}
