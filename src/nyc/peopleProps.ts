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
    // a city stroller with its bassinet (UPPAbaby Vista / Bugaboo Fox proportions): handlebar ~1.0 m up and
    // 0.55 m wide; aluminium frame folding at the hinge hubs halfway down; rear wheels Ø 0.30 m on a 0.58 m
    // track, front swivel wheels Ø 0.20 m; the bassinet 0.80 x 0.40 m with its hood over the baby's head
    // (the parent's end), a blanket and a basket under the seat. Origin: the handlebar, held 1.0 m up
    // (people.ts); +z forward, the ground at y = -1.0.
    const parts: THREE.BufferGeometry[] = [];
    const alu = '#b9bdc2', black = '#141416', foam = '#202022', rubber = '#0d0d0e', hub = '#8c9096';
    const lining = '#ece6da', skin = '#e2b49a';
    const tube = (a: THREE.Vector3Tuple, b: THREE.Vector3Tuple, r: number, c: string, seg = 6) => {
      const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
      const g = new THREE.CylinderGeometry(r, r, A.distanceTo(B), seg, 1, true);
      g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize())));
      g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
      parts.push(paint(g, c));
    };
    const wheel = (x: number, y: number, z: number, R: number, w: number) => {
      // tyre (a torus) round a hub disc
      parts.push(paint(xf(new THREE.TorusGeometry(R - w * 0.35, w * 0.45, 4, 10), x, y, z, 0, Math.PI / 2, 0), rubber));
      parts.push(paint(xf(new THREE.CylinderGeometry(R * 0.62, R * 0.62, w * 0.5, 8, 1, true), x, y, z, 0, 0, Math.PI / 2), hub));
    };
    // handlebar: a foam-covered bar with aluminium ends curving down into the frame
    tube([-0.24, 0, 0], [0.24, 0, 0], 0.019, foam, 8);
    for (const s of [-1, 1]) {
      tube([s * 0.24, 0, 0], [s * 0.27, -0.06, 0.03], 0.013, alu);
      // the rear leg: handlebar to the hinge hub, on to the rear axle
      tube([s * 0.27, -0.06, 0.03], [s * 0.27, -0.46, 0.2], 0.013, alu);
      tube([s * 0.27, -0.46, 0.2], [s * 0.27, -0.85, 0.3], 0.013, alu);
      // the front leg: from the hinge hub down and forward to the swivel fork
      tube([s * 0.27, -0.46, 0.2], [s * 0.22, -0.8, 0.86], 0.013, alu);
      tube([s * 0.22, -0.8, 0.86], [s * 0.22, -0.9, 0.9], 0.011, black);
      // fold joint: a black hub where the legs meet
      parts.push(paint(xf(new THREE.CylinderGeometry(0.035, 0.035, 0.04, 8), s * 0.27, -0.46, 0.2, 0, 0, Math.PI / 2), black));
      // bassinet adapters on the frame
      parts.push(paint(xf(new THREE.BoxGeometry(0.03, 0.06, 0.05), s * 0.25, -0.43, 0.23), black));
      wheel(s * 0.29, -0.85, 0.3, 0.15, 0.05);
      wheel(s * 0.22, -0.9, 0.92, 0.1, 0.04);
    }
    // rear axle and the basket under the seat (a dark mesh tub on a frame)
    tube([-0.29, -0.85, 0.3], [0.29, -0.85, 0.3], 0.01, alu);
    parts.push(paint(xf(new RoundedBoxGeometry(0.42, 0.16, 0.42, 1, 0.04), 0, -0.72, 0.52), '#2a2a2c'));
    parts.push(paint(xf(new THREE.BoxGeometry(0.36, 0.02, 0.36), 0, -0.63, 0.52), '#1a1a1c'));
    // the bassinet: a padded fabric tub, its rim, the lining and a blanket with the baby's head showing
    const zb = 0.52, yb = -0.36;
    parts.push(paint(xf(new RoundedBoxGeometry(0.42, 0.24, 0.8, 2, 0.09), 0, yb, zb), fabric));
    parts.push(paint(xf(new THREE.BoxGeometry(0.36, 0.03, 0.72), 0, yb + 0.11, zb), lining));
    parts.push(paint(xf(new RoundedBoxGeometry(0.32, 0.05, 0.42, 1, 0.02), 0, yb + 0.12, zb + 0.12), '#c9d8e6')); // blanket
    parts.push(paint(xf(new THREE.SphereGeometry(0.06, 8, 6), 0, yb + 0.15, zb - 0.16), skin));
    parts.push(paint(xf(new THREE.SphereGeometry(0.063, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2), 0, yb + 0.15, zb - 0.17, -0.5), '#efe8dc')); // a knit cap
    // the hood: a quarter shell of fabric over the head end, with a dark visor edge
    parts.push(paint(xf(new THREE.SphereGeometry(0.22, 10, 5, 0, Math.PI, 0, Math.PI / 2), 0, yb + 0.1, zb - 0.22, 0, Math.PI, 0, 0.98, 1.0, 1.15), fabric));
    tube([-0.2, yb + 0.1, zb - 0.22], [0.2, yb + 0.1, zb - 0.22], 0.01, black);
    parts.push(paint(xf(new THREE.TorusGeometry(0.215, 0.012, 3, 10, Math.PI), 0, yb + 0.1, zb - 0.22, 0, 0, 0), black));
    // the carry handle folded down along the side
    tube([-0.21, yb + 0.12, zb - 0.1], [-0.21, yb + 0.12, zb + 0.25], 0.008, black);
    tube([0.21, yb + 0.12, zb - 0.1], [0.21, yb + 0.12, zb + 0.25], 0.008, black);
    return mergeGeometries(parts)!;
  });
}

const DOG_COATS = ['#b5824a', '#1e1a18', '#e8e2d8', '#c9a060', '#7a7672', '#5a3a22'];
/** a medium dog (≈0.45 m at the shoulder): merged body + four swinging legs, a trot from speed */
export class Dog {
  root = Object.assign(new THREE.Group(), { name: 'dog' });
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

/** an open umbrella, grip at the origin: 8-panel canopy (r ≈ 0.5 m) about 0.6 m above the grip */
export function umbrellaGeo(color: string) {
  return cached(`umbrella|${color}`, () => {
    const parts: THREE.BufferGeometry[] = [];
    const canopy = new THREE.ConeGeometry(0.52, 0.24, 8, 1, true);
    canopy.translate(0, 0.62, 0);
    parts.push(paint(canopy, color));
    parts.push(paint(xf(new THREE.CylinderGeometry(0.008, 0.008, 0.76, 6), 0, 0.38, 0), '#2a2a2a'));
    parts.push(paint(xf(new THREE.TorusGeometry(0.03, 0.008, 4, 8, Math.PI), 0, -0.01, 0, 0, Math.PI / 2, Math.PI), '#1a1a1a'));
    parts.push(paint(xf(new THREE.SphereGeometry(0.012, 6, 4), 0, 0.76, 0), '#3a3a3a'));
    return mergeGeometries(parts)!;
  });
}
