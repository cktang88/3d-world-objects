import * as THREE from 'three';
import { Rng, hashN } from '../rng';
import { mat } from '../build';
import type { Portal, Rect } from '../level';
import { B, C, M, bake, lightFor, AX, SZ, AVE, ST } from './common';

/** Cars, cabs and buses, and the traffic that drives them. */
export const carCache = new Map<string, THREE.Group>();
export const CAR_COLORS = ['#1c1c1e', '#e8e8e8', '#7a8590', '#2a3f66', '#7a1d1d', '#3a4a3a', '#b8b8b8', '#4a3a2a'];
export function carMesh(kind: 'cab' | 'sedan' | 'bus', rng: Rng): THREE.Group {
  const color = kind === 'cab' ? '#f6c218' : kind === 'bus' ? '#e9edf2' : rng.pick(CAR_COLORS);
  const key = `${kind}:${color}`;
  const cached = carCache.get(key);
  if (cached) return cached.clone();
  const g = new THREE.Group();
  const body = mat(color, { rough: 0.35, metal: 0.4 });
  const glass = M.glassDark();
  const black = mat('#111', { rough: 0.8 });
  if (kind === 'bus') {
    B(g, body, 2.55, 2.4, 12, 0, 0.45, 0);
    B(g, glass, 2.6, 1.0, 10.5, 0, 1.55, 0.3, false);
    B(g, mat('#1e4fa3'), 2.6, 0.35, 12.02, 0, 0.9, 0, false);
    B(g, mat('#fff6d0', { emissive: '#fff2c0', ei: 0.8 }), 2.0, 0.4, 0.05, 0, 2.3, -6.0, false);
    for (const z of [-4, 4]) for (const x of [-1.2, 1.2]) {
      const w = C(g, black, 0.5, 0.3, x, 0, z);
      w.rotation.z = Math.PI / 2;
      w.position.y = 0.5;
    }
  } else {
    // body: an extruded side profile with rounded (bevelled) edges, nose toward -z
    const prof = (pts: [number, number][]) => {
      const sh = new THREE.Shape();
      pts.forEach(([x, y], i) => (i ? sh.lineTo(x, y) : sh.moveTo(x, y)));
      sh.closePath();
      return sh;
    };
    const extrude = (sh: THREE.Shape, width: number, bevel: number, m: THREE.Material) => {
      const geo = new THREE.ExtrudeGeometry(sh, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 8 });
      geo.translate(0, 0, -(width - bevel * 2) / 2);
      geo.rotateY(-Math.PI / 2); // profile x -> world z, nose toward -z
      const mesh = new THREE.Mesh(geo, m);
      mesh.castShadow = true;
      g.add(mesh);
      return mesh;
    };
    const L = 2.3;
    const bodyPts: [number, number][] = [
      [-L, 0.32], [-L - 0.04, 0.5], [-L + 0.05, 0.74], [-1.25, 0.86], [-0.62, 1.36], [0.72, 1.4], [1.35, 0.96], [L - 0.06, 0.9], [L + 0.02, 0.62], [L - 0.02, 0.32],
      [1.75, 0.32], [1.68, 0.55], [1.2, 0.62], [1.02, 0.42], [-1.05, 0.42], [-1.22, 0.62], [-1.7, 0.55], [-1.77, 0.32],
    ];
    extrude(prof(bodyPts), 1.8, 0.07, body);
    // glasshouse slightly wider than the body so it shows on the sides
    extrude(prof([[-1.18, 0.9], [-0.6, 1.32], [0.68, 1.36], [1.28, 0.95]]), 1.84, 0.02, glass);
    // bumpers, lights, plate, mirrors
    const chromeM = mat('#c9ccd0', { metal: 0.9, rough: 0.25 });
    B(g, black, 1.86, 0.18, 0.18, 0, 0.3, -L - 0.03);
    B(g, black, 1.86, 0.18, 0.18, 0, 0.3, L + 0.01);
    B(g, mat('#fff6d0', { emissive: '#fff2c0', ei: 0.9 }), 0.36, 0.12, 0.04, -0.62, 0.66, -L - 0.03, false);
    B(g, mat('#fff6d0', { emissive: '#fff2c0', ei: 0.9 }), 0.36, 0.12, 0.04, 0.62, 0.66, -L - 0.03, false);
    B(g, mat('#a01010', { emissive: '#ff2020', ei: 0.7 }), 0.4, 0.12, 0.04, -0.6, 0.72, L + 0.02, false);
    B(g, mat('#a01010', { emissive: '#ff2020', ei: 0.7 }), 0.4, 0.12, 0.04, 0.6, 0.72, L + 0.02, false);
    B(g, mat('#f2f2ee'), 0.5, 0.13, 0.02, 0, 0.42, L + 0.11, false);
    B(g, chromeM, 0.9, 0.14, 0.02, 0, 0.55, -L - 0.06, false);
    for (const sx of [-1, 1]) B(g, body, 0.18, 0.1, 0.12, sx * 0.98, 0.98, -0.95, false);
    // wheels: tyre + rim + hub
    const rim = mat('#b8bcc2', { metal: 0.85, rough: 0.3 });
    for (const z of [-1.4, 1.4]) for (const x of [-0.8, 0.8]) {
      const t = C(g, black, 0.34, 0.24, x, 0, z, true);
      t.rotation.z = Math.PI / 2;
      t.position.y = 0.34;
      const rr = C(g, rim, 0.2, 0.25, x + Math.sign(x) * 0.005, 0, z, false);
      rr.rotation.z = Math.PI / 2;
      rr.position.y = 0.34;
    }
    if (kind === 'cab') {
      // roof sign, checker stripe, medallion number
      B(g, mat('#ffffff', { emissive: '#fff4c0', ei: 0.7 }), 0.85, 0.3, 0.26, 0, 1.4, 0.0, false);
      B(g, black, 0.86, 0.04, 0.27, 0, 1.4, 0.0, false);
      for (let k = 0; k < 10; k++) for (const sx of [-1, 1]) B(g, k % 2 ? black : mat('#ffffff'), 0.02, 0.07, 0.36, sx * 0.915, 0.66, -1.6 + k * 0.36, false);
    }
  }
  const baked = bake(g);
  // these baked meshes are shared by every clone
  baked.traverse((o) => (o.userData.owned = false));
  carCache.set(key, baked);
  return baked.clone();
}

export interface Car {
  obj: THREE.Group;
  axis: 'x' | 'z';
  dir: number;
  line: number;
  t: number;
  v: number;
  vmax: number;
  len: number;
  wid: number;
  rect: Rect;
}

export class Traffic {
  cars: Car[] = [];
  portals: Portal[] = [];
  private rng: Rng;
  constructor(private group: THREE.Group, seed: number) {
    this.rng = new Rng(hashN(seed, 404));
  }
  rects() {
    return this.cars.map((c) => c.rect);
  }
  private place(c: Car, p: THREE.Vector3) {
    const r = this.rng;
    c.axis = r.chance(0.6) ? 'z' : 'x';
    if (c.axis === 'z') {
      const k = Math.round(p.x / AX - 0.5) + r.int(-1, 1);
      c.dir = k % 2 === 0 ? -1 : 1; // one-way avenues alternate
      c.line = (k + 0.5) * AX + r.pick([-3.6, 0, 3.6]);
      c.t = p.z - c.dir * r.range(60, 140);
    } else {
      const k = Math.round(p.z / SZ - 0.5) + r.int(-2, 2);
      c.dir = k % 2 === 0 ? 1 : -1;
      c.line = (k + 0.5) * SZ;
      c.t = p.x - c.dir * r.range(60, 140);
    }
    c.v = c.vmax;
    c.obj.rotation.y = c.axis === 'z' ? (c.dir > 0 ? Math.PI : 0) : c.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
  }
  update(dt: number, p: THREE.Vector3, time: number) {
    while (this.cars.length < 26) {
      const kind = this.rng.chance(0.08) ? 'bus' : this.rng.chance(0.55) ? 'cab' : 'sedan';
      const obj = carMesh(kind, this.rng);
      this.group.add(obj);
      const c: Car = { obj, axis: 'z', dir: 1, line: 0, t: 0, v: 0, vmax: this.rng.range(9, 14), len: kind === 'bus' ? 12 : 4.6, wid: kind === 'bus' ? 2.6 : 1.8, rect: { minX: 0, minZ: 0, maxX: 0, maxZ: 0 } };
      this.place(c, p);
      this.cars.push(c);
    }
    for (const c of this.cars) {
      const along = c.axis === 'x' ? p.x : p.z;
      const across = c.axis === 'x' ? p.z : p.x;
      if (Math.abs(c.t - along) > 170 || Math.abs(c.line - across) > 200) this.place(c, p);
      // red light: stop before the next intersection
      let target = c.vmax;
      const period = c.axis === 'z' ? SZ : AX;
      const halfCross = c.axis === 'z' ? ST / 2 : AVE / 2;
      const front = c.t + (c.dir * c.len) / 2;
      const k = c.dir > 0 ? Math.ceil((front - period / 2 + halfCross + 4) / period) : Math.floor((front - period / 2 - halfCross - 4) / period);
      const centre = (k + 0.5) * period;
      const stopAt = centre - c.dir * (halfCross + 4.2);
      const dist = (stopAt - front) * c.dir;
      if (lightFor(c.axis, time) !== 'g' && dist > -0.5 && dist < 30) target = Math.min(target, Math.max(0, (dist - 0.5) * 1.2));
      // follow the car ahead in the same lane
      for (const o of this.cars) {
        if (o === c || o.axis !== c.axis || o.dir !== c.dir || Math.abs(o.line - c.line) > 1) continue;
        const gap = (o.t - c.t) * c.dir - (o.len + c.len) / 2;
        if (gap > -1 && gap < 25) target = Math.min(target, Math.max(0, (gap - 2.5) * 1.0));
      }
      // don't run the player over
      const pg = (along - c.t) * c.dir - c.len / 2;
      if (Math.abs(across - c.line) < c.wid && pg > -1 && pg < 12) target = 0;
      c.v += (target - c.v) * Math.min(1, dt * (target < c.v ? 4 : 1.2));
      c.t += c.dir * c.v * dt;
      const x = c.axis === 'x' ? c.t : c.line, z = c.axis === 'x' ? c.line : c.t;
      c.obj.position.set(x, 0, z);
      const hx = (c.axis === 'x' ? c.len : c.wid) / 2, hz = (c.axis === 'x' ? c.wid : c.len) / 2;
      c.rect.minX = x - hx; c.rect.maxX = x + hx; c.rect.minZ = z - hz; c.rect.maxZ = z + hz;
    }
  }
}

// ---------------------------------------------------------------- pedestrians

