import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { gltf } from '../detail';

/**
 * The traffic fleet: detailed CC-BY car models (scripts/build_vehicles.mjs -> public/assets/vehicles/), each with a
 * near LOD (~30-75k tris) and a far LOD (~6k tris). On load every model is merged into a handful of meshes:
 * body paint (tintable clear-coat), glass, one per textured material and a few shared vertex-coloured buckets,
 * so a car costs ~4-10 draw calls near and the same few far. Geometry and materials are shared by all cars.
 */
export interface FleetModel {
  id: string;
  /** real length/width (m) for traffic spacing and colliders */
  len: number;
  wid: number;
  /** tyre radius (m), to cut the wheels out so they can spin */
  wheelR: number;
  /** body paint can be tinted */
  paint: boolean;
  /** fixed paint colour when the model is used as a cab */
  cab?: boolean;
}

export const FLEET: Record<string, FleetModel> = {
  taxi_cv: { id: 'taxi_cv', len: 5.38, wid: 2.0, wheelR: 0.34, paint: false },
  prius: { id: 'prius', len: 4.54, wid: 1.76, wheelR: 0.31, paint: true },
  accord: { id: 'accord', len: 4.93, wid: 1.85, wheelR: 0.33, paint: true },
  accord19: { id: 'accord19', len: 4.88, wid: 1.86, wheelR: 0.34, paint: true },
  charger: { id: 'charger', len: 5.08, wid: 1.9, wheelR: 0.36, paint: true },
  suburban: { id: 'suburban', len: 5.7, wid: 2.0, wheelR: 0.39, paint: true },
  escalade: { id: 'escalade', len: 5.14, wid: 2.05, wheelR: 0.4, paint: false },
  explorer: { id: 'explorer', len: 5.05, wid: 2.0, wheelR: 0.38, paint: true },
  sprinter: { id: 'sprinter', len: 5.9, wid: 2.0, wheelR: 0.35, paint: false },
};

/** NYC taxi yellow (Dupont M6284 "taxi yellow", close to Pantone 116) */
export const TAXI_YELLOW = '#f5b50c';

/** street car colours, weighted like a real US fleet: white, black, greys/silvers dominate */
export const PAINTS: { c: string; metal: number; w: number }[] = [
  { c: '#f2f2ef', metal: 0.05, w: 22 }, // white
  { c: '#0c0d0f', metal: 0.25, w: 20 }, // black
  { c: '#5a5e63', metal: 0.7, w: 14 }, // gunmetal grey
  { c: '#a9adb1', metal: 0.85, w: 14 }, // silver
  { c: '#1f3558', metal: 0.6, w: 8 }, // dark blue
  { c: '#7d1418', metal: 0.5, w: 7 }, // deep red
  { c: '#2e3b33', metal: 0.5, w: 3 }, // dark green
  { c: '#8a7a64', metal: 0.6, w: 3 }, // champagne
  { c: '#3b5f8c', metal: 0.6, w: 3 }, // mid blue
  { c: '#b9b3a6', metal: 0.4, w: 3 }, // pearl beige
];

const paintCache = new Map<string, THREE.MeshPhysicalMaterial>();
export function paintMat(color: string, metal = 0.4) {
  const key = `${color}|${metal}`;
  let m = paintCache.get(key);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({
      color,
      metalness: metal,
      roughness: 0.32 + (1 - metal) * 0.1,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      envMapIntensity: 1.2,
    });
    m.name = 'paint';
    paintCache.set(key, m);
  }
  return m;
}

let glassMat: THREE.MeshPhysicalMaterial | null = null;
export function carGlass() {
  return (glassMat ??= Object.assign(
    new THREE.MeshPhysicalMaterial({
      color: '#10161c',
      metalness: 0.1,
      roughness: 0.04,
      transparent: true,
      opacity: 0.86,
      envMapIntensity: 1.6,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
    }),
    { name: 'car-glass' },
  ));
}

/** shared vertex-coloured buckets for every untextured part */
const VC = {
  chrome: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 1, roughness: 0.22, name: 'car-chrome' }),
  rubber: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.88, name: 'car-rubber' }),
  plastic: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.5, name: 'car-plastic' }),
  lamp: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.15, emissive: '#000', name: 'car-lamp' }),
};

const sidedCache = new WeakMap<THREE.Material, THREE.Material>();
/** the double-sided twin of a shared material */
export function sided<T extends THREE.Material>(m: T, double: boolean): T {
  if (!double) return m;
  let d = sidedCache.get(m) as T | undefined;
  if (!d) {
    d = m.clone() as T;
    d.side = THREE.DoubleSide;
    sidedCache.set(m, d);
  }
  return d;
}

export interface Part {
  geo: THREE.BufferGeometry;
  /** 'paint' takes the car's colour; anything else is a ready material */
  mat: THREE.Material | 'paint';
  /** source was double-sided (inside-out panels are common in these models) */
  double: boolean;
}
export interface Wheel {
  /** wheel triangles (vertex-coloured), centred on the hub */
  geo: THREE.BufferGeometry;
  center: THREE.Vector3;
  r: number;
}
export interface Prepared {
  id: string;
  lod0: Part[];
  lod1: Part[];
  /** the four near-LOD wheels, cut out of the body so moving cars can spin them */
  wheels: Wheel[];
  /** the rear red lamp lenses, slightly proud of the body: lit while braking */
  brake: THREE.BufferGeometry | null;
}

const prepared = new Map<string, Promise<Prepared | null>>();
export function loadFleet(id: string): Promise<Prepared | null> {
  let p = prepared.get(id);
  if (!p) {
    const base = `${import.meta.env.BASE_URL}assets/vehicles/${id}`;
    p = Promise.all([gltf()!.loadAsync(`${base}.glb`), gltf()!.loadAsync(`${base}_lod1.glb`)])
      .then(([a, b]) => {
        const lod0 = prepare(a.scene, id);
        return { id, lod0, lod1: prepare(b.scene, id), wheels: cutWheels(lod0, FLEET[id]?.wheelR ?? 0), brake: brakeLenses(lod0) };
      })
      .catch((e) => {
        console.warn('vehicle', id, e);
        return null;
      });
    prepared.set(id, p);
  }
  return p;
}
/** already-loaded models, for synchronous use */
export const ready = new Map<string, Prepared>();
export function preloadFleet() {
  return Promise.all(Object.keys(FLEET).map((id) => loadFleet(id).then((p) => p && ready.set(id, p))));
}

const tmpC = new THREE.Color();
function toFloat(g: THREE.BufferGeometry) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = g.getAttribute(name);
    if (!a) continue;
    const n = a.count, s = a.itemSize;
    const arr = new Float32Array(n * s);
    for (let i = 0; i < n; i++) {
      arr[i * s] = a.getX(i);
      if (s > 1) arr[i * s + 1] = a.getY(i);
      if (s > 2) arr[i * s + 2] = a.getZ(i);
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, s));
  }
  if (g.index) out.setIndex(Array.from(g.index.array as ArrayLike<number>));
  else out.setIndex(Array.from({ length: out.getAttribute('position').count }, (_, i) => i));
  return out;
}

/**
 * Some exported bodies have normals pointing into the car (dark paint with chrome-like reflections). The winding is
 * right (those faces are visible), so flip every vertex normal that disagrees with its triangles' geometric normals.
 */
function fixInverted(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position'), nor = g.getAttribute('normal');
  const idx = g.index!.array;
  const acc = new Float32Array(pos.count * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < idx.length; i += 3) {
    const i0 = idx[i], i1 = idx[i + 1], i2 = idx[i + 2];
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1).sub(a);
    c.fromBufferAttribute(pos, i2).sub(a);
    b.cross(c);
    for (const v of [i0, i1, i2]) {
      acc[v * 3] += b.x;
      acc[v * 3 + 1] += b.y;
      acc[v * 3 + 2] += b.z;
    }
  }
  for (let i = 0; i < nor.count; i++)
    if (nor.getX(i) * acc[i * 3] + nor.getY(i) * acc[i * 3 + 1] + nor.getZ(i) * acc[i * 3 + 2] < 0) nor.setXYZ(i, -nor.getX(i), -nor.getY(i), -nor.getZ(i));
}

function prepare(root: THREE.Object3D, id: string): Part[] {
  root.updateMatrixWorld(true);
  const buckets = new Map<string, { mat: THREE.Material | 'paint'; geos: THREE.BufferGeometry[]; vc: boolean; double: boolean }>();
  const texMats = new Map<THREE.Material, THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshStandardMaterial;
    let g = toFloat(mesh.geometry);
    g.applyMatrix4(mesh.matrixWorld);
    if (!g.getAttribute('normal')) {
      // welded for simplification: rebuild normals keeping hard edges (creases over 35 degrees)
      g = toCreasedNormals(g, (35 * Math.PI) / 180);
      g.setIndex(Array.from({ length: g.getAttribute('position').count }, (_, i) => i));
    }
    else fixInverted(g);
    const n = g.getAttribute('position').count;
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    const name = src.name || '';
    const double = src.side === THREE.DoubleSide;
    let key: string;
    let mat: THREE.Material | 'paint';
    let vc = false;
    if (name === 'PAINT') {

      key = 'paint' + double;
      mat = 'paint';
    } else if (name === 'GLASS') {
      key = 'glass' + double;
      mat = sided(carGlass(), double);
    } else if (src.map) {
      key = src.uuid;
      let m = texMats.get(src);
      if (!m) {
        const chrome = /chrome|metal/i.test(name);
        m = new THREE.MeshStandardMaterial({
          map: src.map,
          color: src.color,
          metalness: chrome ? 0.9 : 0.1,
          roughness: chrome ? 0.3 : 0.5,
          transparent: src.transparent,
          opacity: src.opacity,
          alphaTest: src.alphaTest,
          side: src.side,
          name: `${id}:${name}`,
        });
        texMats.set(src, m);
      }
      mat = m;
    } else {
      // untextured: bucket by look, keep colour in vertices
      tmpC.copy(src.color);
      const lum = tmpC.r * 0.3 + tmpC.g * 0.59 + tmpC.b * 0.11;
      const sat = Math.max(tmpC.r, tmpC.g, tmpC.b) - Math.min(tmpC.r, tmpC.g, tmpC.b);
      const b =
        /chrome|silver|alu|metal|rim/i.test(name) || (src.metalness > 0.5 && lum > 0.2)
          ? 'chrome'
          : /light|lamp|brake|signal|phare|feu/i.test(name) || (sat > 0.5 && lum > 0.1)
            ? 'lamp'
            : lum < 0.03 || /tyre|tire|rubber|wheel/i.test(name)
              ? 'rubber'
              : 'plastic';
      key = b + double;
      mat = sided(VC[b as keyof typeof VC], double);
      vc = true;
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        c[i * 3] = tmpC.r;
        c[i * 3 + 1] = tmpC.g;
        c[i * 3 + 2] = tmpC.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    let bk = buckets.get(key);
    if (!bk) buckets.set(key, (bk = { mat, geos: [], vc, double }));
    bk.geos.push(g);
  });
  const parts: Part[] = [];
  for (const bk of buckets.values()) {
    const geo = mergeGeometries(bk.geos, false);
    if (!geo) continue;
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    parts.push({ geo, mat: bk.mat, double: bk.double });
  }
  return parts;
}

/**
 * Find the four wheels from the tyre rubber (low, at the corners) and move every non-paint triangle inside each
 * wheel's cylinder (tyre, rim, hub, brake) into its own vertex-coloured geometry centred on the hub.
 */
function cutWheels(parts: Part[], r: number): Wheel[] {
  if (!r) return [];
  let zmin = Infinity, zmax = -Infinity;
  for (const p of parts) {
    zmin = Math.min(zmin, p.geo.boundingBox!.min.z);
    zmax = Math.max(zmax, p.geo.boundingBox!.max.z);
  }
  const zc = (zmin + zmax) / 2;
  // the tyres are what touches the ground: one contact patch per corner gives the hub's x span and z
  const boxes = [0, 1, 2, 3].map(() => new THREE.Box3());
  const v = new THREE.Vector3();
  for (const p of parts) {
    if (p.mat === 'paint') continue;
    const pos = p.geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (v.y > 0.035 || Math.abs(v.x) < 0.4) continue;
      boxes[(v.x > 0 ? 1 : 0) + (v.z > zc ? 2 : 0)].expandByPoint(v);
    }
  }
  const wheels: { c: THREE.Vector3; r: number; x0: number; x1: number; tris: Map<Part, number[]> }[] = [];
  for (const b of boxes) {
    if (b.isEmpty() || b.max.z - b.min.z > r * 1.6) return [];
    wheels.push({ c: new THREE.Vector3((b.min.x + b.max.x) / 2, r, (b.min.z + b.max.z) / 2), r, x0: b.min.x - 0.04, x1: b.max.x + 0.04, tris: new Map() });
  }
  const inWheel = (w: (typeof wheels)[number], p: THREE.Vector3) =>
    p.x >= w.x0 && p.x <= w.x1 && (p.y - w.c.y) ** 2 + (p.z - w.c.z) ** 2 <= (w.r * 1.01) ** 2;
  const a = new THREE.Vector3(), b2 = new THREE.Vector3(), c2 = new THREE.Vector3();
  for (const part of parts) {
    if (part.mat === 'paint' || (part.mat as THREE.Material).name === 'car-glass') continue;
    const pos = part.geo.getAttribute('position');
    const idx = part.geo.index!.array;
    const keep: number[] = [];
    for (let i = 0; i < idx.length; i += 3) {
      a.fromBufferAttribute(pos, idx[i]);
      b2.fromBufferAttribute(pos, idx[i + 1]);
      c2.fromBufferAttribute(pos, idx[i + 2]);
      const w = wheels.find((w) => inWheel(w, a) && inWheel(w, b2) && inWheel(w, c2));
      if (w) {
        let t = w.tris.get(part);
        if (!t) w.tris.set(part, (t = []));
        t.push(idx[i], idx[i + 1], idx[i + 2]);
      } else keep.push(idx[i], idx[i + 1], idx[i + 2]);
    }
    if (keep.length !== idx.length) part.geo.setIndex(keep);
  }
  return wheels.map((w) => {
    const geos: THREE.BufferGeometry[] = [];
    for (const [part, tris] of w.tris) {
      const src = part.geo;
      const g = new THREE.BufferGeometry();
      const n = tris.length;
      const P = new Float32Array(n * 3), N = new Float32Array(n * 3), C = new Float32Array(n * 3);
      const col = src.getAttribute('color');
      const m = part.mat as THREE.MeshStandardMaterial;
      const base = m.color ? m.color.clone() : new THREE.Color(0.5, 0.5, 0.5);
      if (m.map) base.multiply(textureAverage(m.map));
      for (let k = 0; k < n; k++) {
        const i = tris[k];
        P[k * 3] = src.getAttribute('position').getX(i) - w.c.x;
        P[k * 3 + 1] = src.getAttribute('position').getY(i) - w.c.y;
        P[k * 3 + 2] = src.getAttribute('position').getZ(i) - w.c.z;
        N[k * 3] = src.getAttribute('normal').getX(i);
        N[k * 3 + 1] = src.getAttribute('normal').getY(i);
        N[k * 3 + 2] = src.getAttribute('normal').getZ(i);
        if (col) {
          C[k * 3] = col.getX(i);
          C[k * 3 + 1] = col.getY(i);
          C[k * 3 + 2] = col.getZ(i);
        } else base.toArray(C, k * 3);
      }
      g.setAttribute('position', new THREE.BufferAttribute(P, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
      g.setAttribute('color', new THREE.BufferAttribute(C, 3));
      geos.push(g);
    }
    const geo = mergeGeometries(geos, false) ?? new THREE.BufferGeometry();
    geo.computeBoundingSphere();
    return { geo, center: w.c, r: w.r };
  });
}
/** red vertex-coloured triangles in the last 0.7 m of the car, above the bumper: the tail/brake lamp lenses */
function brakeLenses(parts: Part[]): THREE.BufferGeometry | null {
  let zmax = -Infinity;
  for (const p of parts) zmax = Math.max(zmax, p.geo.boundingBox!.max.z);
  const P: number[] = [], N: number[] = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const nn = new THREE.Vector3();
  for (const part of parts) {
    const col = part.geo.getAttribute('color');
    if (!col || part.mat === 'paint') continue;
    const pos = part.geo.getAttribute('position'), nor = part.geo.getAttribute('normal');
    const idx = part.geo.index!.array;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i];
      if (!(col.getX(a) > 0.3 && col.getY(a) < 0.15 && col.getZ(a) < 0.15)) continue;
      let ok = true;
      for (let k = 0; k < 3; k++) {
        v[k].fromBufferAttribute(pos, idx[i + k]);
        if (v[k].z < zmax - 0.7 || v[k].y < 0.45) ok = false;
      }
      if (!ok) continue;
      for (let k = 0; k < 3; k++) {
        nn.fromBufferAttribute(nor, idx[i + k]);
        P.push(v[k].x + nn.x * 0.004, v[k].y + nn.y * 0.004, v[k].z + nn.z * 0.004);
        N.push(nn.x, nn.y, nn.z);
      }
    }
  }
  if (P.length < 9 * 4) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.computeBoundingSphere();
  return g;
}
/** lit brake lamps (shared; a car shows or hides its lens mesh) */
export const BRAKE_MAT = new THREE.MeshStandardMaterial({ color: '#ff2a1a', emissive: '#ff1a0a', emissiveIntensity: 3, roughness: 0.3, name: 'car-brake' });

const WHEEL_MAT =new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.45, side: THREE.DoubleSide, name: 'car-wheel' });

/** average colour of a texture (for the single-material distant LOD) */
const avgCache = new WeakMap<THREE.Texture, THREE.Color>();
function textureAverage(t: THREE.Texture): THREE.Color {
  let c = avgCache.get(t);
  if (!c) {
    c = new THREE.Color(0.5, 0.5, 0.5);
    try {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 1;
      const g = cv.getContext('2d')!;
      g.drawImage(t.image as CanvasImageSource, 0, 0, 1, 1);
      const d = g.getImageData(0, 0, 1, 1).data;
      c.setRGB(d[0] / 255, d[1] / 255, d[2] / 255, THREE.SRGBColorSpace);
    } catch {
      /* image not decodable here: keep grey */
    }
    avgCache.set(t, c);
  }
  return c;
}

/** the far-far LOD: the far parts merged into one vertex-coloured mesh with this car's paint baked in */
const LOD2_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.25, name: 'car-lod2' });
const lod2Cache = new Map<string, THREE.BufferGeometry>();
function lod2Geometry(p: Prepared, paint: THREE.Material): THREE.BufferGeometry {
  const key = `${p.id}|${paint.uuid}`;
  let geo = lod2Cache.get(key);
  if (!geo) {
    const geos: THREE.BufferGeometry[] = [];
    for (const part of p.lod1) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', part.geo.getAttribute('position'));
      g.setAttribute('normal', part.geo.getAttribute('normal'));
      g.setIndex(part.geo.index);
      const n = g.getAttribute('position').count;
      let col: THREE.BufferAttribute;
      const src = part.geo.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (src && part.mat !== 'paint') col = src;
      else {
        const m = (part.mat === 'paint' ? paint : part.mat) as THREE.MeshStandardMaterial;
        const c = m.color.clone();
        if (m.map) c.multiply(textureAverage(m.map));
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) c.toArray(arr, i * 3);
        col = new THREE.BufferAttribute(arr, 3);
      }
      g.setAttribute('color', col);
      geos.push(g);
    }
    geo = mergeGeometries(geos, false) ?? new THREE.BufferGeometry();
    geo.computeBoundingSphere();
    lod2Cache.set(key, geo);
  }
  return geo;
}

/** Build one car object: a THREE.LOD (near, far, one-draw-call far-far) sharing everything but the paint. */
export function fleetObject(p: Prepared, paint: THREE.Material, far = 26, farther = 70): THREE.LOD {
  const lod = new THREE.LOD();
  const level = (parts: Part[], shadow: boolean) => {
    const g = new THREE.Group();
    for (const part of parts) {
      const m = new THREE.Mesh(part.geo, part.mat === 'paint' ? sided(paint, part.double) : part.mat);
      m.castShadow = shadow;
      m.receiveShadow = false;
      m.userData.owned = false;
      g.add(m);
    }
    return g;
  };
  const near = level(p.lod0, true);
  const wheels: THREE.Object3D[] = [];
  for (const w of p.wheels) {
    const m = new THREE.Mesh(w.geo, WHEEL_MAT);
    m.position.copy(w.center);
    m.castShadow = true;
    m.userData.owned = false;
    near.add(m);
    wheels.push(m);
  }
  if (wheels.length) {
    lod.userData.wheels = wheels;
    lod.userData.wheelR = p.wheels[0].r;
  }
  lod.addLevel(near, 0);
  lod.addLevel(level(p.lod1, true), far);
  const m2 = new THREE.Mesh(lod2Geometry(p, paint), LOD2_MAT);
  m2.castShadow = true;
  m2.userData.owned = false;
  lod.addLevel(m2, farther);
  if (p.brake) {
    // not a LOD level: shown at every distance while the car brakes (Traffic toggles visible)
    const b = new THREE.Mesh(p.brake, BRAKE_MAT);
    b.visible = false;
    b.userData.owned = false;
    lod.add(b);
    lod.userData.brake = b;
  }
  return lod;
}
