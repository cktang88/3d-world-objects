import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mat } from '../build';
import { surface } from '../pbr';

/** Shared NYC constants and helpers: grid dimensions, baking, primitive builders, materials, signals. */
export const AX = 120; // chunk size along x (avenue to avenue)
export const SZ = 64; // chunk size along z (street to street)
export const AVE = 16; // avenue roadway width
export const ST = 10; // street roadway width
export const SW = 4.5; // sidewalk width
export const BX = AX / 2 - AVE / 2; // 52: block half-size x (kerb)
export const BZ = SZ / 2 - ST / 2; // 27
export const LX = BX - SW; // 47.5: building line
export const LZ = BZ - SW; // 22.5
export const CURB = 0.15;
export const RX = 2;
export const RZ = 2;

export const AVENUES = ['York Av', '1 Av', '2 Av', '3 Av', 'Lexington Av', 'Park Av', 'Madison Av', '5 Av', '6 Av', 'Broadway', '7 Av', '8 Av', '9 Av', '10 Av', '11 Av', '12 Av'];
export function avenueName(i: number) {
  const n = AVENUES.length;
  return AVENUES[(((i + 7) % n) + n) % n];
}
export function streetName(i: number) {
  const n = 34 - i;
  return n > 0 ? `W ${n} St` : `${Math.abs(n) + 1} St`;
}

export const vcMats = new Map<string, THREE.MeshStandardMaterial>();
export function vcMat(rough: number, metal: number) {
  const key = `${rough}|${metal}`;
  let m = vcMats.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rough, metalness: metal });
    vcMats.set(key, m);
  }
  return m;
}

/**
 * Merge every static mesh under `src` into a handful of meshes. Plain-coloured
 * materials collapse into shared vertex-coloured ones; textured/emissive materials
 * keep their own bucket.
 */
export function bake(src: THREE.Object3D): THREE.Group {
  src.updateMatrixWorld(true);
  const buckets = new Map<string, { m: THREE.Material; shadow: boolean; geos: THREE.BufferGeometry[]; vc: boolean }>();
  const col = new THREE.Color();
  src.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const sm = mesh.material as THREE.MeshStandardMaterial;
    // photo-textured surfaces stream their maps in later: never collapse them into flat colours
    const plain = sm.isMeshStandardMaterial && !sm.map && !sm.userData.pbr && !sm.transparent && (sm.emissiveIntensity === 0 || sm.emissive.getHex() === 0);
    const keepColor = !!(sm.vertexColors && mesh.geometry.getAttribute('color'));
    let g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k) && !(keepColor && k === 'color')) g.deleteAttribute(k);
    const n = g.getAttribute('position').count;
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    let key: string;
    let material: THREE.Material = mesh.material;
    const tint = mesh.userData.tint as string | undefined;
    if (tint) {
      col.set(tint);
      const c = new Float32Array(n * 3);
      // a baked per-vertex shade (ambient occlusion) on the geometry multiplies the tint
      const ao = keepColor && mesh.userData.ao ? (g.getAttribute('color') as THREE.BufferAttribute) : null;
      for (let i = 0; i < n; i++) { const k = ao ? ao.getX(i) : 1; c[i * 3] = col.r * k; c[i * 3 + 1] = col.g * k; c[i * 3 + 2] = col.b * k; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      key = `${mesh.material.uuid}|${mesh.castShadow}`;
    } else if (plain) {
      const rough = Math.round(sm.roughness * 3) / 3, metal = Math.round(sm.metalness * 2) / 2;
      material = vcMat(rough, metal);
      if (!keepColor) {
        col.copy(sm.color);
        const c = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
        g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      }
      key = `vc|${rough}|${metal}|${mesh.castShadow}`;
    } else key = `${mesh.material.uuid}|${mesh.castShadow}`;
    let b = buckets.get(key);
    if (!b) {
      b = { m: material, shadow: mesh.castShadow, geos: [], vc: plain };
      buckets.set(key, b);
    }
    b.geos.push(g);
  });
  const out = new THREE.Group();
  for (const b of buckets.values()) {
    const merged = mergeGeometries(b.geos, false);
    b.geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, b.m);
    mesh.castShadow = b.shadow;
    mesh.receiveShadow = true;
    mesh.userData.owned = true;
    out.add(mesh);
  }
  return out;
}

export const unitBox = new THREE.BoxGeometry(1, 1, 1);
export const unitCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
export const unitSphere = new THREE.IcosahedronGeometry(0.5, 1);

export function B(parent: THREE.Object3D, m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, shadow = true) {
  const o = new THREE.Mesh(unitBox, m);
  o.scale.set(w, h, d);
  o.position.set(x, y + h / 2, z);
  o.castShadow = shadow;
  parent.add(o);
  return o;
}
export function C(parent: THREE.Object3D, m: THREE.Material, r: number, h: number, x: number, y: number, z: number, shadow = true) {
  const o = new THREE.Mesh(unitCyl, m);
  o.scale.set(r * 2, h, r * 2);
  o.position.set(x, y + h / 2, z);
  o.castShadow = shadow;
  parent.add(o);
  return o;
}

export type Side = 'N' | 'S' | 'E' | 'W';
export const NORMAL: Record<Side, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

/** A vertical wall quad along one side of a footprint, UVs in world units for facade tiling. */
/** neutral facade textures, tinted per building through vertex colours */
export function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = false) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export let sidewalkMat: THREE.MeshStandardMaterial | null = null;
export const M = {
  // plain concrete for open-space strips (block sidewalks use nyc/ground.ts)
  sidewalk: () => (sidewalkMat ??= surface('concrete', [3, 3], { roughness: 1 })),
  curb: () => mat('#8f8b84', { rough: 0.8 }),
  tar: () => surface('nyc_roof', [1, 1], { roughness: 1 }),
  iron: () => mat('#1c1d1f', { metal: 0.6, rough: 0.5 }),
  pole: () => mat('#3f4a42', { metal: 0.5, rough: 0.5 }),
  green: () => mat('#0f6b3a', { rough: 0.6 }),
  wood: () => mat('#6b4c34', { rough: 0.85 }),
  glassDark: () => mat('#1e2a33', { rough: 0.15, metal: 0.4 }),
  bark: () => mat('#4a3a2c', { rough: 1 }),
  leaf: () => mat('#4f7a34', { rough: 0.9 }),
  leaf2: () => mat('#5f8a3c', { rough: 0.9 }),
};

/** traffic signal lamps: shared materials, intensities driven every frame */
export const SIG = {
  aveR: new THREE.MeshStandardMaterial({ color: '#330000', emissive: '#ff2a1a' }),
  aveY: new THREE.MeshStandardMaterial({ color: '#332200', emissive: '#ffb21a' }),
  aveG: new THREE.MeshStandardMaterial({ color: '#002211', emissive: '#2aff8a' }),
  stR: new THREE.MeshStandardMaterial({ color: '#330000', emissive: '#ff2a1a' }),
  stY: new THREE.MeshStandardMaterial({ color: '#332200', emissive: '#ffb21a' }),
  stG: new THREE.MeshStandardMaterial({ color: '#002211', emissive: '#2aff8a' }),
};
export const CYCLE = 24;
/** 'g' | 'y' | 'r' for traffic moving along avenues (z) or streets (x) */
export function lightFor(axis: 'x' | 'z', time: number): 'g' | 'y' | 'r' {
  const t = time % CYCLE;
  if (axis === 'z') return t < 10 ? 'g' : t < 12.5 ? 'y' : 'r';
  return t < 12.5 ? 'r' : t < 22 ? 'g' : t < 24 ? 'y' : 'r';
}

// ---------------------------------------------------------------- the level

