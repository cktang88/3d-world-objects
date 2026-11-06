import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Things pedestrians carry or walk with: shopping bags and handbags (hanging from the hand),
 * coffee cups, strollers and dogs on a leash. Each prop is one merged geometry with baked vertex
 * colours drawn with one shared material, so a prop costs one draw call (a dog: body + 4 legs).
 * All built in metres, +z forward, +y up.
 */
export const propVcMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });

function paint(g: THREE.BufferGeometry, c: string) {
  const geo = g.index ? g.toNonIndexed() : g;
  const col = new THREE.Color(c);
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.toArray(a, i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'color'].includes(k)) geo.deleteAttribute(k);
  return geo;
}
const xf = (g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)));
const cache = new Map<string, THREE.BufferGeometry>();
function cached(k: string, f: () => THREE.BufferGeometry) {
  let g = cache.get(k);
  if (!g) cache.set(k, (g = f()));
  return g;
}

/** a bag hanging from its handles at the origin (the grip) */
export function handBagGeo(kind: 'shopping' | 'handbag', color: string) {
  return cached(`bag|${kind}|${color}`, () => {
    if (kind === 'shopping') {
      // paper / boutique shopping bag with two rope handles
      const body = xf(new THREE.BoxGeometry(0.32, 0.36, 0.11), 0, -0.27, 0);
      const parts = [paint(body, color)];
      for (const s of [-1, 1]) parts.push(paint(xf(new THREE.TorusGeometry(0.055, 0.006, 4, 10, Math.PI), 0, -0.09, s * 0.03, 0, 0, 0, 1, 1.4, 1), '#1a1a1a'));
      return mergeGeometries(parts)!;
    }
    const body = xf(new RoundedBoxGeometry(0.3, 0.22, 0.12, 2, 0.03), 0, -0.21, 0);
    const handle = xf(new THREE.TorusGeometry(0.08, 0.009, 4, 12, Math.PI), 0, -0.1, 0, 0, 0, 0, 1, 1.1, 1);
    return mergeGeometries([paint(body, color), paint(handle, color)])!;
  });
}

/** a takeaway coffee cup, base at the origin */
export function coffeeGeo() {
  return cached('coffee', () => {
    const cup = new THREE.CylinderGeometry(0.043, 0.033, 0.13, 14);
    const sleeve = new THREE.CylinderGeometry(0.041, 0.037, 0.05, 14);
    const lid = new THREE.CylinderGeometry(0.046, 0.045, 0.015, 14);
    return mergeGeometries([paint(xf(cup, 0, 0.065, 0), '#f2f0ea'), paint(xf(sleeve, 0, 0.07, 0, 0, 0, 0, 1.03, 1, 1.03), '#8a5a34'), paint(xf(lid, 0, 0.135, 0), '#ece8e0')])!;
  });
}

/** a stroller, handlebar at the origin, pram ahead (+z) */
export function strollerGeo(fabric: string) {
  return cached(`stroller|${fabric}`, () => {
    const parts: THREE.BufferGeometry[] = [];
    const frame = '#18181a';
    const tube = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r = 0.012) => {
      const a = new THREE.Vector3(x0, y0, z0), b = new THREE.Vector3(x1, y1, z1);
      const g = new THREE.CylinderGeometry(r, r, a.distanceTo(b), 6);
      g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())));
      g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      parts.push(paint(g, frame));
    };
    tube(-0.24, 0, 0, 0.24, 0, 0, 0.016); // handlebar
    for (const s of [-1, 1]) {
      tube(s * 0.22, 0, 0, s * 0.22, -0.82, 0.32); // rear legs
      tube(s * 0.22, -0.45, 0.17, s * 0.2, -0.82, 0.78); // front legs
    }
    // seat bucket and hood
    parts.push(paint(xf(new RoundedBoxGeometry(0.4, 0.26, 0.5, 2, 0.06), 0, -0.47, 0.5, -0.15), fabric));
    parts.push(paint(xf(new THREE.SphereGeometry(0.22, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, -0.38, 0.32, -0.6, 0, 0, 1, 0.9, 1.2), fabric));
    for (const [x, z] of [[-0.22, 0.32], [0.22, 0.32], [-0.2, 0.78], [0.2, 0.78]])
      parts.push(paint(xf(new THREE.CylinderGeometry(0.085, 0.085, 0.035, 14), x, -0.83, z, 0, 0, Math.PI / 2), '#101010'));
    return mergeGeometries(parts)!;
  });
}

const DOG_COATS = ['#b5824a', '#1e1a18', '#e8e2d8', '#c9a060', '#7a7672', '#5a3a22'];
/** a medium dog (≈0.45 m at the shoulder): merged body + four swinging legs, a trot from speed */
export class Dog {
  root = new THREE.Group();
  private legs: THREE.Mesh[] = [];
  private tail: THREE.Object3D;
  private ph = Math.random() * 6;
  collar = new THREE.Vector3(0, 0.5, 0.3);
  constructor(coatIndex: number, scale = 1) {
    const coat = DOG_COATS[coatIndex % DOG_COATS.length];
    const body = cached(`dog|${coat}`, () => {
      const p: THREE.BufferGeometry[] = [];
      p.push(paint(xf(new THREE.CapsuleGeometry(0.115, 0.36, 4, 12), 0, 0.42, -0.02, Math.PI / 2, 0, 0, 1, 1, 1.05), coat));
      p.push(paint(xf(new THREE.SphereGeometry(0.13, 12, 10), 0, 0.44, 0.19, 0, 0, 0, 0.95, 1.05, 1), coat));
      p.push(paint(xf(new THREE.CylinderGeometry(0.06, 0.08, 0.2, 10), 0, 0.53, 0.28, 0.75), coat));
      p.push(paint(xf(new THREE.SphereGeometry(0.085, 12, 10), 0, 0.61, 0.35, 0, 0, 0, 0.9, 0.9, 1.1), coat));
      p.push(paint(xf(new THREE.CapsuleGeometry(0.038, 0.07, 3, 8), 0, 0.585, 0.44, Math.PI / 2), coat));
      p.push(paint(xf(new THREE.SphereGeometry(0.018, 6, 4), 0, 0.6, 0.495), '#0a0a0a'));
      for (const s of [-1, 1]) p.push(paint(xf(new THREE.ConeGeometry(0.03, 0.08, 6), s * 0.05, 0.69, 0.33, -0.2, 0, s * -0.3), coat));
      p.push(paint(xf(new THREE.TorusGeometry(0.065, 0.012, 4, 12), 0, 0.53, 0.29, 0.75 + Math.PI / 2), '#a8261e')); // collar
      return mergeGeometries(p)!;
    });
    const leg = cached(`dogleg|${coat}`, () => paint(xf(new THREE.CapsuleGeometry(0.032, 0.32, 3, 8), 0, -0.19, 0), coat));
    const tail = cached(`dogtail|${coat}`, () => paint(xf(new THREE.CapsuleGeometry(0.022, 0.2, 3, 6), 0, 0.12, 0), coat));
    this.root.add(new THREE.Mesh(body, propVcMat));
    for (const [x, z] of [[0.07, 0.19], [-0.07, 0.19], [0.07, -0.2], [-0.07, -0.2]]) {
      const m = new THREE.Mesh(leg, propVcMat);
      m.position.set(x, 0.4, z);
      this.root.add(m);
      this.legs.push(m);
    }
    const t = new THREE.Mesh(tail, propVcMat);
    t.position.set(0, 0.48, -0.25);
    t.rotation.x = -0.7;
    this.root.add(t);
    this.tail = t;
    this.root.scale.setScalar(scale);
    this.collar.multiplyScalar(scale);
    for (const o of this.root.children) o.castShadow = true;
  }
  /** speed in m/s; a trot: diagonal legs move together */
  update(dt: number, speed: number) {
    const s = Math.min(1, speed / 1.2);
    this.ph += dt * (speed > 0.05 ? 2.2 + speed * 4.5 : 0);
    const a = Math.sin(this.ph) * 0.55 * s;
    this.legs[0].rotation.x = a;
    this.legs[3].rotation.x = a;
    this.legs[1].rotation.x = -a;
    this.legs[2].rotation.x = -a;
    this.legs[0].parent!.position.y = Math.abs(Math.cos(this.ph)) * 0.015 * s;
    this.tail.rotation.z = Math.sin(this.ph * (speed > 0.05 ? 1 : 0) + performance.now() * 0.006) * 0.35;
  }
}
