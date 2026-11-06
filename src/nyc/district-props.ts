import * as THREE from 'three';
import { mat } from '../build';
import { Rng } from '../rng';
import { kit, place, PM } from './streetprops';
import { flat } from './district-tex';

/**
 * Procedural props shared by the districts: Central Park settees, iron hoop fences, chain-link
 * fences with posts, stone walls, schist outcrops, market stall frames, jersey barriers.
 * All are kits (per-material merged, baked into the chunk).
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
function rodGeo(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 6) {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r, r, d.length(), seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize()));
  const c = a.clone().add(b).multiplyScalar(0.5);
  g.translate(c.x, c.y, c.z);
  return g;
}

/** Central Park "settee": cast-iron ends, green-stained wooden slats, 1.8 m (faces +z) */
export function parkBench(parent: THREE.Object3D, x: number, y: number, z: number, ry: number) {
  const parts = kit('cp-settee', (k) => {
    const iron = PM.black();
    const wood = mat('#4c5a3a', { rough: 0.8 });
    const L = 1.8;
    for (const sx of [-1, 1]) {
      const ex = (sx * L) / 2 - sx * 0.08;
      // legs, arm and back post of the cast end
      k.add(new THREE.BoxGeometry(0.05, 0.45, 0.05), iron, ex, 0.225, 0.2);
      k.add(new THREE.BoxGeometry(0.05, 0.45, 0.05), iron, ex, 0.225, -0.18);
      k.add(new THREE.BoxGeometry(0.05, 0.05, 0.5), iron, ex, 0.43, 0.01);
      k.add(new THREE.BoxGeometry(0.05, 0.5, 0.05), iron, ex, 0.68, -0.24, 0.18);
      k.add(new THREE.BoxGeometry(0.045, 0.045, 0.42), iron, ex, 0.66, 0.05);
    }
    for (let i = 0; i < 4; i++) k.add(new THREE.BoxGeometry(L, 0.03, 0.09), wood, 0, 0.46, 0.2 - i * 0.11);
    for (let i = 0; i < 3; i++) k.add(new THREE.BoxGeometry(L, 0.09, 0.03), wood, 0, 0.6 + i * 0.13, -0.24 - i * 0.025, -0.18);
  });
  place(parent, parts, x, y, z, ry);
}

/** low iron hoop fence (Central Park lawns): 0.6 m posts, arched hoops, from a to b */
export function hoopFence(parent: THREE.Object3D, x0: number, z0: number, x1: number, z1: number, y = 0) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / 2));
  const parts = kit(`hoop-${len.toFixed(1)}`, (k) => {
    const iron = PM.black();
    const seg = len / n;
    for (let i = 0; i <= n; i++) k.add(new THREE.CylinderGeometry(0.025, 0.025, 0.65, 6), iron, -len / 2 + i * seg, 0.325, 0);
    for (let i = 0; i < n; i++) {
      const cx = -len / 2 + (i + 0.5) * seg;
      const arc = new THREE.TorusGeometry(seg / 2, 0.012, 4, 12, Math.PI);
      k.add(arc, iron, cx, 0.12, 0);
      k.add(new THREE.BoxGeometry(seg, 0.02, 0.02), iron, cx, 0.6, 0);
    }
  });
  place(parent, parts, (x0 + x1) / 2, y, (z0 + z1) / 2, -Math.atan2(z1 - z0, x1 - x0));
}

/** chain-link fence, `h` high, galvanised posts every 3 m, from a to b */
export function chainFence(parent: THREE.Object3D, x0: number, z0: number, x1: number, z1: number, h = 2.4, y = 0) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / 3));
  const parts = kit(`chain-${len.toFixed(1)}-${h}`, (k) => {
    const galv = PM.galv();
    for (let i = 0; i <= n; i++) k.add(new THREE.CylinderGeometry(0.035, 0.035, h, 6), galv, -len / 2 + (i * len) / n, h / 2, 0);
    k.add(rodGeo(V(-len / 2, h - 0.03, 0), V(len / 2, h - 0.03, 0), 0.025), galv);
    k.add(new THREE.PlaneGeometry(len, h - 0.05), chainMesh(), 0, (h - 0.05) / 2, 0, 0, 0, 0, 1, false);
  });
  place(parent, parts, (x0 + x1) / 2, y, (z0 + z1) / 2, -Math.atan2(z1 - z0, x1 - x0));
}
let chainM: THREE.MeshStandardMaterial | null = null;
function chainMesh() {
  if (chainM) return chainM;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(170,175,178,1)';
  g.lineWidth = 3;
  for (let i = -64; i < 128; i += 16) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 64, 64); g.stroke();
    g.beginPath(); g.moveTo(i + 64, 0); g.lineTo(i, 64); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 1);
  chainM = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.5, transparent: false, side: THREE.DoubleSide, metalness: 0.7, roughness: 0.5 });
  chainM.map!.repeat.set(12, 6);
  return chainM;
}

/** Central Park perimeter wall: rough stone, 0.9 m, coping on top */
export function stoneWall(parent: THREE.Object3D, x0: number, z0: number, x1: number, z1: number, y = 0, h = 0.9) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const g = new THREE.Group();
  g.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
  g.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(len, h, 0.55), flat('#8a8173', 0.95));
  wall.position.y = h / 2;
  wall.userData.owned = true;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(len + 0.1, 0.12, 0.7), flat('#a39b8c', 0.9));
  cap.position.y = h + 0.06;
  cap.userData.owned = true;
  wall.castShadow = cap.castShadow = true;
  g.add(wall, cap);
  parent.add(g);
}

/** Manhattan schist outcrop: a low lumpy grey rock with glacial striations */
export function rock(parent: THREE.Object3D, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry: number, seed: number) {
  const r = new Rng(seed);
  const g = new THREE.IcosahedronGeometry(1, 3);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const ph = [r.range(0, 6), r.range(0, 6), r.range(0, 6)];
  for (let i = 0; i < p.count; i++) {
    const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const n = 1 + 0.18 * Math.sin(vx * 3.1 + ph[0]) * Math.cos(vz * 2.7 + ph[1]) + 0.08 * Math.sin(vy * 7 + vx * 5 + ph[2]);
    p.setXYZ(i, vx * n, Math.max(-0.3, vy * n), vz * n);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, flat('#5f5d58', 0.85));
  m.scale.set(sx, sy, sz);
  m.position.set(x, y - sy * 0.25, z);
  m.rotation.y = ry;
  m.castShadow = m.receiveShadow = true;
  m.userData.owned = true;
  parent.add(m);
}

/** a green-canvas market stall: steel frame, canopy, folding table (faces +z) */
export function stall(parent: THREE.Object3D, x: number, y: number, z: number, ry: number, color: string, w = 3, d = 2) {
  const parts = kit(`stall-${color}-${w}-${d}`, (k) => {
    const steel = PM.galv();
    const canvas = mat(color, { rough: 0.9 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add(new THREE.CylinderGeometry(0.025, 0.025, 2.4, 6), steel, (sx * w) / 2, 1.2, (sz * d) / 2);
    // pitched canopy
    const roof = new THREE.BoxGeometry(w + 0.2, 0.03, d / 2 + 0.25);
    k.add(roof, canvas, 0, 2.5, d / 4, 0.2);
    k.add(roof, canvas, 0, 2.5, -d / 4, -0.2);
    k.add(new THREE.BoxGeometry(w + 0.2, 0.25, 0.02), canvas, 0, 2.3, d / 2 + 0.12);
    // table
    k.add(new THREE.BoxGeometry(w - 0.1, 0.04, 0.9), mat('#c9c3b5', { rough: 0.8 }), 0, 0.78, d / 2 - 0.5);
    k.add(new THREE.BoxGeometry(w - 0.1, 0.7, 0.02), mat('#6a6a64', { rough: 0.8 }), 0, 0.42, d / 2 - 0.06);
    for (const sx of [-1, 1]) k.add(new THREE.BoxGeometry(0.03, 0.78, 0.8), steel, sx * (w / 2 - 0.2), 0.39, d / 2 - 0.5);
  });
  place(parent, parts, x, y, z, ry);
}

/** concrete jersey barrier, 3 m */
export function jersey(parent: THREE.Object3D, x: number, y: number, z: number, ry: number) {
  const parts = kit('jersey', (k) => {
    const sh = new THREE.Shape([V(-0.3, 0, 0), V(0.3, 0, 0), V(0.3, 0.08, 0), V(0.18, 0.33, 0), V(0.1, 0.81, 0), V(-0.1, 0.81, 0), V(-0.18, 0.33, 0), V(-0.3, 0.08, 0)].map((v) => new THREE.Vector2(v.x, v.y)));
    const g = new THREE.ExtrudeGeometry(sh, { depth: 3, bevelEnabled: false });
    g.translate(0, 0, -1.5);
    k.add(g, mat('#b3aea4', { rough: 0.95 }), 0, 0, 0, 0, Math.PI / 2);
  });
  place(parent, parts, x, y, z, ry);
}
