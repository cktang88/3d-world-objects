import * as THREE from 'three';
import { Rng } from '../rng';
import { mat, glow } from '../build';
import { surface } from '../pbr';
import { signTex } from '../textures';
import { B, C, M, SIG, CURB, unitSphere, streetName } from './common';

/** Street furniture: signals, name signs, lamp posts, trees, hydrants, subway entrances. */
export function signalPole(parent: THREE.Object3D, x: number, z: number, sx: number, sz: number) {
  const pole = M.pole();
  C(parent, pole, 0.1, 4.6, x, CURB, z);
  const head = (axis: 'x' | 'z', y: number) => {
    const g = new THREE.Group();
    B(g, mat('#e0b21a', { rough: 0.6 }), 0.36, 1.05, 0.3, 0, 0, 0);
    const [R, Y, G] = axis === 'z' ? [SIG.aveR, SIG.aveY, SIG.aveG] : [SIG.stR, SIG.stY, SIG.stG];
    const lamp = (m: THREE.Material, yy: number) => {
      const s = new THREE.Mesh(unitSphere, m);
      s.scale.set(0.22, 0.22, 0.08);
      s.position.set(0, yy, 0.16);
      g.add(s);
    };
    lamp(R, 0.85);
    lamp(Y, 0.53);
    lamp(G, 0.21);
    // face the approaching traffic of this axis
    g.rotation.y = axis === 'z' ? (sz > 0 ? 0 : Math.PI) : sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    g.position.set(x + (axis === 'x' ? 0 : -sx * 0.25), y, z + (axis === 'z' ? 0 : -sz * 0.25));
    parent.add(g);
  };
  head('z', 3.4);
  head('x', 3.4);
  // pedestrian signal
  B(parent, mat('#1a1a1a'), 0.3, 0.32, 0.22, x, 2.3, z - sz * 0.2, false);
}

export const nameSignCache = new Map<string, THREE.MeshStandardMaterial>();
export function nameSign(text: string, x: number, y: number, z: number, rotY: number) {
  let m = nameSignCache.get(text);
  if (!m) {
    const t = signTex(text, '#0d6b3a', '#ffffff');
    m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.4, side: THREE.DoubleSide });
    nameSignCache.set(text, m);
  }
  const g = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.36), m);
  g.userData.owned = true;
  g.position.set(x, y, z);
  g.rotation.y = rotY;
  return g;
}

export function lampPost(parent: THREE.Object3D, group: THREE.Group, x: number, z: number, axis: 'x' | 'z', side: number) {
  const pole = M.pole();
  C(parent, pole, 0.13, 0.9, x, CURB, z);
  C(parent, pole, 0.08, 8.2, x, CURB, z);
  // arm reaching over the road
  const ax = axis === 'z' ? side * 1.6 : 0, az = axis === 'x' ? side * 1.6 : 0;
  const arm = B(parent, pole, axis === 'z' ? 3.2 : 0.1, 0.1, axis === 'x' ? 3.2 : 0.1, x + ax / 2 + (axis === 'z' ? side * 0.8 : 0), 8.2, z + az / 2 + (axis === 'x' ? side * 0.8 : 0));
  void arm;
  const hx = x + (axis === 'z' ? side * 3.0 : 0), hz = z + (axis === 'x' ? side * 3.0 : 0);
  B(parent, mat('#5a5f5a', { metal: 0.4, rough: 0.5 }), axis === 'z' ? 0.9 : 0.4, 0.22, axis === 'x' ? 0.9 : 0.4, hx, 8.05, hz);
  B(parent, mat('#fff3d8', { emissive: '#ffe2b0', ei: 1 }), axis === 'z' ? 0.7 : 0.3, 0.04, axis === 'x' ? 0.7 : 0.3, hx, 8.02, hz, false);
  void group;
}

/** a lumpy, displaced leaf cluster (shared geometry, a few variants) */
export const leafGeos: THREE.BufferGeometry[] = [];
export function leafCluster(i: number) {
  if (!leafGeos.length) {
    for (let v = 0; v < 4; v++) {
      const g = new THREE.IcosahedronGeometry(0.5, 2);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const tmpv = new THREE.Vector3();
      for (let k = 0; k < pos.count; k++) {
        tmpv.fromBufferAttribute(pos, k);
        const n = Math.sin(tmpv.x * 13 + v) * Math.sin(tmpv.y * 11 + v * 2) * Math.sin(tmpv.z * 9 + v * 3);
        tmpv.multiplyScalar(1 + 0.22 * n + 0.08 * Math.sin(tmpv.x * 41 + tmpv.z * 37));
        pos.setXYZ(k, tmpv.x, tmpv.y, tmpv.z);
      }
      g.computeVertexNormals();
      leafGeos.push(g);
    }
  }
  return leafGeos[i % leafGeos.length];
}
export const LEAF_GREENS = ['#3f6b2a', '#4c7a30', '#5a8a36', '#36602a', '#6a9440', '#47722e'];

export function tree(parent: THREE.Object3D, x: number, z: number, rng: Rng) {
  // tree pit with a low iron guard
  B(parent, mat('#3b3027', { rough: 1 }), 1.2, 0.02, 1.2, x, CURB, z, false);
  for (const s of [-1, 1]) {
    B(parent, M.iron(), 1.25, 0.04, 0.04, x, CURB + 0.38, z + s * 0.6, false);
    B(parent, M.iron(), 0.04, 0.04, 1.25, x + s * 0.6, CURB + 0.38, z, false);
    for (const t of [-0.6, 0, 0.6]) {
      B(parent, M.iron(), 0.03, 0.4, 0.03, x + t, CURB, z + s * 0.6, false);
      B(parent, M.iron(), 0.03, 0.4, 0.03, x + s * 0.6, CURB, z + t, false);
    }
  }
  const bark = surface('tree_bark', [1, 1], { roughness: 1, normalScale: 1.5 });
  const h = rng.range(4.5, 7.5);
  const trunkH = h * rng.range(0.38, 0.5);
  // tapered trunk
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.17, trunkH, 10), bark);
  trunk.position.set(x, CURB + trunkH / 2, z);
  trunk.castShadow = true;
  parent.add(trunk);
  // limbs fanning out, each carrying a few leaf clusters
  const limbs = rng.int(4, 6);
  const crownR = h * rng.range(0.28, 0.36);
  for (let i = 0; i < limbs; i++) {
    const ang = (i / limbs) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const tilt = rng.range(0.45, 0.85);
    const len = h * rng.range(0.32, 0.45);
    const limb = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.075, len, 7), bark);
    const dir = new THREE.Vector3(Math.cos(ang) * Math.sin(tilt), Math.cos(tilt), Math.sin(ang) * Math.sin(tilt));
    limb.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const base = new THREE.Vector3(x, CURB + trunkH * rng.range(0.85, 1), z);
    limb.position.copy(base).addScaledVector(dir, len / 2);
    limb.castShadow = true;
    parent.add(limb);
    const tip = base.clone().addScaledVector(dir, len);
    const clusters = rng.int(2, 3);
    for (let c = 0; c < clusters; c++) {
      const leaf = new THREE.Mesh(leafCluster(rng.int(0, 3)), mat(rng.pick(LEAF_GREENS), { rough: 0.85 }));
      const rr = crownR * rng.range(0.45, 0.75);
      leaf.scale.set(rr * 2, rr * rng.range(1.5, 1.9), rr * 2);
      leaf.position.copy(tip).add(new THREE.Vector3(rng.range(-0.6, 0.6), rng.range(-0.3, 0.8), rng.range(-0.6, 0.6)));
      leaf.rotation.y = rng.range(0, 6.28);
      leaf.castShadow = true;
      parent.add(leaf);
    }
  }
  // crown top
  const top = new THREE.Mesh(leafCluster(rng.int(0, 3)), mat(rng.pick(LEAF_GREENS), { rough: 0.85 }));
  top.scale.set(crownR * 1.6, crownR * 1.3, crownR * 1.6);
  top.position.set(x, CURB + h - crownR * 0.4, z);
  top.castShadow = true;
  parent.add(top);
}

export function hydrant(parent: THREE.Object3D, x: number, z: number) {
  const m = mat(Math.abs(x + z) % 2 < 1 ? '#c4161c' : '#e0b21a', { rough: 0.5 });
  C(parent, m, 0.16, 0.65, x, CURB, z);
  C(parent, m, 0.2, 0.08, x, CURB + 0.65, z);
  const top = new THREE.Mesh(unitSphere, m);
  top.scale.setScalar(0.3);
  top.position.set(x, CURB + 0.76, z);
  parent.add(top);
  B(parent, m, 0.5, 0.1, 0.1, x, CURB + 0.42, z);
}

export function subway(parent: THREE.Object3D, group: THREE.Group, x: number, z: number, cz: number, rng: Rng) {
  const rail = mat('#1f4a2e', { metal: 0.5, rough: 0.5 });
  const w = 2.0, l = 5.0;
  // railings around a stair opening
  B(parent, rail, 0.06, 1.0, l, x - w / 2, CURB, z);
  B(parent, rail, 0.06, 1.0, l, x + w / 2, CURB, z);
  B(parent, rail, w, 1.0, 0.06, x, CURB, z - Math.sign(z) * l / 2);
  B(parent, mat('#0b0b0b'), w - 0.1, 0.02, l - 0.4, x, CURB + 0.005, z);
  for (let k = 0; k < 7; k++) B(parent, mat('#555'), w - 0.15, 0.04, 0.35, x, CURB - k * 0.02, z + Math.sign(z) * (l / 2 - 0.5 - k * 0.55), false);
  for (const sx of [-1, 1]) {
    C(parent, rail, 0.05, 2.3, x + (sx * w) / 2, CURB, z + Math.sign(z) * l / 2);
    const globe = new THREE.Mesh(unitSphere, mat('#6fe08a', { emissive: '#3aff7a', ei: 1.2 }));
    globe.scale.setScalar(0.32);
    globe.position.set(x + (sx * w) / 2, CURB + 2.45, z + Math.sign(z) * l / 2);
    parent.add(globe);
    group.add(glow('#5aff8a', 1.2, globe.position.x, globe.position.y, globe.position.z, 0.5));
  }
  const lines = rng.pick(['1 2 3', 'A C E', 'N Q R W', '4 5 6', 'B D F M', 'L']);
  const s = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.4), new THREE.MeshStandardMaterial({ map: signTex(`${streetName(cz)} · ${lines}`, '#111111', '#ffffff'), side: THREE.DoubleSide }));
  s.userData.owned = true;
  s.position.set(x, CURB + 1.3, z + Math.sign(z) * l / 2);
  group.add(s);
}

// ---------------------------------------------------------------- vehicles

