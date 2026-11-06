import * as THREE from 'three';
import { Rng, hashN } from '../rng';
import { mat } from '../build';
import { CURB, AX, SZ, AVE, ST } from './common';

/** Pedestrians walking the sidewalks. */
export const SKIN = ['#f1c9a5', '#d9a77e', '#a8714a', '#7a4a2a', '#5a3620', '#e8b996'];
export const CLOTH = ['#1c1c1e', '#2a3f66', '#7a1d1d', '#e8e8e8', '#4a5a3a', '#b8946a', '#5a2a5a', '#c46a2a', '#3a3a44', '#d6c8a8'];
export const pedGeo = {
  torso: new THREE.CapsuleGeometry(0.16, 0.36, 6, 14),
  hips: new THREE.CapsuleGeometry(0.15, 0.08, 6, 14),
  neck: new THREE.CylinderGeometry(0.05, 0.06, 0.1, 10),
  head: new THREE.SphereGeometry(0.105, 18, 14),
  hair: new THREE.SphereGeometry(0.112, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
  thigh: new THREE.CapsuleGeometry(0.07, 0.34, 4, 10),
  shin: new THREE.CapsuleGeometry(0.055, 0.34, 4, 10),
  shoe: new THREE.BoxGeometry(0.1, 0.07, 0.26),
  upperArm: new THREE.CapsuleGeometry(0.048, 0.24, 4, 10),
  forearm: new THREE.CapsuleGeometry(0.04, 0.22, 4, 10),
  hand: new THREE.SphereGeometry(0.045, 10, 8),
  bag: new THREE.BoxGeometry(0.08, 0.3, 0.36),
};
pedGeo.torso.scale(1.15, 1, 0.72); // shoulders wider than deep
pedGeo.hips.scale(1.1, 1, 0.75);
pedGeo.head.scale(0.92, 1.05, 1);
export interface Ped {
  g: THREE.Group;
  legs: THREE.Object3D[];
  arms: THREE.Object3D[];
  axis: 'x' | 'z';
  dir: number;
  line: number;
  t: number;
  v: number;
  ph: number;
}
export class Pedestrians {
  peds: Ped[] = [];
  private rng: Rng;
  constructor(private group: THREE.Group, seed: number) {
    this.rng = new Rng(hashN(seed, 909));
  }
  private make(): Ped {
    const r = this.rng;
    const g = new THREE.Group();
    const skin = mat(r.pick(SKIN), { rough: 0.6 });
    const top = mat(r.pick(CLOTH), { rough: 0.9 });
    const bottom = mat(r.pick(['#1c1c22', '#2a3550', '#3a3a40', '#4a3f35', '#20263a', '#6b6255']), { rough: 0.9 });
    const hairM = mat(r.pick(['#1a120c', '#3a2414', '#6b4a2a', '#c8a060', '#2a2a2a', '#8a8a8a']), { rough: 0.7 });
    const shoeM = mat(r.pick(['#111111', '#3a2618', '#e8e8e8', '#5a1d1d']), { rough: 0.5 });
    const h = r.range(0.92, 1.08);
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = g) => {
      const o = new THREE.Mesh(geo, m);
      o.position.set(x, y, z);
      parent.add(o);
      return o;
    };
    const torso = add(pedGeo.torso, top, 0, 1.3, 0);
    torso.castShadow = true;
    add(pedGeo.hips, bottom, 0, 0.98, 0);
    add(pedGeo.neck, skin, 0, 1.58, 0);
    add(pedGeo.head, skin, 0, 1.7, 0.01);
    add(pedGeo.hair, hairM, 0, 1.715, -0.005);
    if (r.chance(0.2)) {
      const cap = add(pedGeo.hair, mat(r.pick(CLOTH)), 0, 1.74, 0);
      cap.scale.set(1.05, 0.8, 1.05);
    }
    const legs: THREE.Object3D[] = [], arms: THREE.Object3D[] = [];
    for (const s of [-1, 1]) {
      // leg: hip joint -> thigh -> knee joint -> shin -> shoe
      const hip = new THREE.Group();
      hip.position.set(s * 0.09, 0.95, 0);
      add(pedGeo.thigh, bottom, 0, -0.22, 0, hip);
      const knee = new THREE.Group();
      knee.position.y = -0.46;
      hip.add(knee);
      add(pedGeo.shin, bottom, 0, -0.2, 0, knee);
      add(pedGeo.shoe, shoeM, 0, -0.44, 0.05, knee);
      hip.userData.knee = knee;
      g.add(hip);
      legs.push(hip);
      // arm: shoulder -> upper arm -> elbow -> forearm -> hand
      const sh = new THREE.Group();
      sh.position.set(s * 0.215, 1.47, 0);
      add(pedGeo.upperArm, top, 0, -0.15, 0, sh);
      const elbow = new THREE.Group();
      elbow.position.y = -0.3;
      sh.add(elbow);
      add(pedGeo.forearm, r.chance(0.5) ? skin : top, 0, -0.14, 0, elbow);
      add(pedGeo.hand, skin, 0, -0.3, 0, elbow);
      sh.userData.elbow = elbow;
      g.add(sh);
      arms.push(sh);
    }
    if (r.chance(0.3)) add(pedGeo.bag, mat(r.pick(['#3a2618', '#111', '#7a1d1d', '#2a3550'])), 0.26, 1.0, 0);
    g.scale.setScalar(h);
    this.group.add(g);
    return { g, legs, arms, axis: 'x', dir: 1, line: 0, t: 0, v: 1.4, ph: r.range(0, 6) };
  }
  private place(pd: Ped, p: THREE.Vector3, ahead: boolean) {
    const r = this.rng;
    pd.axis = r.chance(0.55) ? 'x' : 'z';
    pd.dir = r.chance(0.5) ? 1 : -1;
    if (pd.axis === 'x') {
      const k = Math.round(p.z / SZ - 0.5) + r.int(-1, 1);
      pd.line = (k + 0.5) * SZ + r.pick([-1, 1]) * (ST / 2 + r.range(1.0, 3.2));
      pd.t = p.x + (ahead ? r.range(-60, 60) : -pd.dir * r.range(40, 70));
    } else {
      const k = Math.round(p.x / AX - 0.5) + r.int(-1, 1);
      pd.line = (k + 0.5) * AX + r.pick([-1, 1]) * (AVE / 2 + r.range(1.0, 3.2));
      pd.t = p.z + (ahead ? r.range(-60, 60) : -pd.dir * r.range(40, 70));
    }
    pd.v = r.range(1.1, 1.7);
    pd.g.rotation.y = pd.axis === 'x' ? (pd.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : pd.dir > 0 ? 0 : Math.PI;
  }
  update(dt: number, p: THREE.Vector3) {
    while (this.peds.length < 36) {
      const pd = this.make();
      this.place(pd, p, true);
      this.peds.push(pd);
    }
    for (const pd of this.peds) {
      const along = pd.axis === 'x' ? p.x : p.z, across = pd.axis === 'x' ? p.z : p.x;
      if (Math.abs(pd.t - along) > 80 || Math.abs(pd.line - across) > 80) this.place(pd, p, false);
      // step around the player
      const dx = (pd.axis === 'x' ? pd.t : pd.line) - p.x, dz = (pd.axis === 'x' ? pd.line : pd.t) - p.z;
      const close = Math.hypot(dx, dz) < 1.2;
      const v = close ? 0 : pd.v;
      pd.t += pd.dir * v * dt;
      pd.ph += v * dt * 4.2;
      const s = Math.sin(pd.ph) * (v > 0 ? 0.5 : 0);
      pd.legs[0].rotation.x = s;
      pd.legs[1].rotation.x = -s;
      (pd.legs[0].userData.knee as THREE.Object3D).rotation.x = Math.max(0, -Math.cos(pd.ph)) * (v > 0 ? 0.9 : 0);
      (pd.legs[1].userData.knee as THREE.Object3D).rotation.x = Math.max(0, Math.cos(pd.ph)) * (v > 0 ? 0.9 : 0);
      pd.arms[0].rotation.x = -s * 0.7;
      pd.arms[1].rotation.x = s * 0.7;
      (pd.arms[0].userData.elbow as THREE.Object3D).rotation.x = -0.25 - Math.max(0, s) * 0.4;
      (pd.arms[1].userData.elbow as THREE.Object3D).rotation.x = -0.25 - Math.max(0, -s) * 0.4;
      pd.g.position.set(pd.axis === 'x' ? pd.t : pd.line, CURB + Math.abs(Math.cos(pd.ph)) * 0.03, pd.axis === 'x' ? pd.line : pd.t);
    }
  }
}

