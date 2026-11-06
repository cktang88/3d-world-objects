import * as THREE from 'three';
import { FLAGS } from '../flags';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { gltf } from '../detail';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { getNight } from '../lighting';

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
  lod2: Part[];
  /** the four near-LOD wheels, cut out of the body so moving cars can spin them */
  wheels: Wheel[];
  /** the rear red lamp lenses, slightly proud of the body: lit while braking */
  brake: THREE.BufferGeometry | null;
  /** the near LOD (lod0, wheels, brake) has loaded */
  nearReady: boolean;
  /** head/tail lamp glow cards (front white, rear red) and the front/rear z of the body */
  lamps?: { headGeo: THREE.BufferGeometry; tailGeo: THREE.BufferGeometry; front: number; rear: number };
}

// Loading order: every model's far LOD, then every mid LOD, then the near LODs. Cars swap their stand-in for
// the instanced mid/far as soon as their model's small files are in; the near meshes follow (nearReady).
const files = new Map<string, Promise<{ scene: THREE.Object3D }>>();
function file(id: string, lod: 0 | 1 | 2) {
  const url = `${import.meta.env.BASE_URL}assets/vehicles/${id}${lod ? '_lod' + lod : ''}.glb`;
  let f = files.get(url);
  if (!f) files.set(url, (f = lod ? liteFile(`${id}_lod${lod}`, url) : gltf()!.loadAsync(url)));
  return f;
}

/**
 * The mid and far LODs only ever use a texture's average colour (merged(): vertex colours), so they are parsed
 * without decoding a single image: the averages come precomputed (public/assets/vehicles/avg.json, built by
 * scripts/vehicle_avg.py) and each texture is an empty stand-in carrying its colour. Decoding the models'
 * little webp images had to queue behind the whole city's textures: the textured models (taxi, Charger,
 * Suburban, Sprinter) appeared a minute after their files had arrived. The near LOD still loads every image.
 */
let avgP: Promise<Record<string, number[][]>> | null = null;
const avgs = () =>
  (avgP ??= fetch(`${import.meta.env.BASE_URL}assets/vehicles/avg.json`)
    .then((r): Promise<Record<string, number[][]>> | Record<string, number[][]> => (r.ok ? r.json() : {}))
    .catch(() => ({}) as Record<string, number[][]>));
let lite: GLTFLoader | null = null;
function liteLoader() {
  if (!lite) {
    lite = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    // replaces the built-in EXT_texture_webp handler (same name): no image fetch, no decode
    lite.register((parser) => ({
      name: 'EXT_texture_webp',
      loadTexture(index: number) {
        const def = parser.json.textures[index];
        const t = new THREE.Texture();
        t.userData.src = def.extensions?.EXT_texture_webp?.source ?? def.source;
        return Promise.resolve(t);
      },
    }) as unknown as import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoaderPlugin);
  }
  return lite;
}
function liteFile(key: string, url: string): Promise<{ scene: THREE.Object3D }> {
  return avgs().then((all) => {
    const list = all[key];
    // no precomputed colours for this file: the normal loader (decodes its images)
    if (!list || typeof fetch === 'undefined') return gltf()!.loadAsync(url);
    return liteLoader().loadAsync(url).then((g) => {
      g.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m?.map && m.map.userData.src !== undefined) m.map.userData.avg = list[m.map.userData.src];
      });
      return g;
    });
  });
}
const prepared = new Map<string, Promise<Prepared | null>>();
/** load timings per model (ms since page start): requested, files parsed, prepared (for QA / the e2e timing check) */
export const fleetTimings: Record<string, { req: number; files?: number; prep?: number; prepMs?: number; dressed?: number }> = {};
if (typeof window !== 'undefined') (window as unknown as { __fleetTimings: typeof fleetTimings }).__fleetTimings = fleetTimings;
/** a model's mid and far LODs (enough to draw it beyond FLEET_LOD.NEAR) */
export function loadFleet(id: string): Promise<Prepared | null> {
  let p = prepared.get(id);
  if (!p) {
    const tm = (fleetTimings[id] = { req: Math.round(performance.now()) } as (typeof fleetTimings)[string]);
    p = Promise.all([file(id, 1), file(id, 2)])
      .then(([b, c]) => {
        tm.files = Math.round(performance.now());
        const lod1 = prepare(b.scene, id);
        const out = { id, lod0: [], lod1, lod2: prepare(c.scene, id), wheels: [], brake: null, lamps: lampCards(lod1), nearReady: false } as Prepared;
        tm.prep = Math.round(performance.now());
        tm.prepMs = tm.prep - tm.files;
        return out;
      })
      .catch((e) => {
        console.warn('vehicle', id, e);
        return null;
      });
    prepared.set(id, p);
  }
  return p;
}
const nearP = new Map<string, Promise<Prepared | null>>();
/** add the near LOD (with its cut-out wheels and brake lenses) to a loaded model */
export function loadNear(id: string): Promise<Prepared | null> {
  let n = nearP.get(id);
  if (!n) {
    n = loadFleet(id).then((p) =>
      !p
        ? null
        : file(id, 0)
            .then((a) => {
              const lod0 = prepare(a.scene, id);
              p.wheels = cutWheels(lod0, FLEET[id]?.wheelR ?? 0);
              p.brake = brakeLenses(lod0);
              p.lod0 = lod0;
              p.nearReady = true;
              return p;
            })
            .catch((e) => {
              console.warn('vehicle near', id, e);
              return null;
            }),
    );
    nearP.set(id, n);
  }
  return n;
}
/** already-loaded models (mid/far at least), for synchronous use */
export const ready = new Map<string, Prepared>();
/** request every far LOD, then every mid LOD; resolves when all models can be drawn at a distance */
export function preloadFleet() {
  const ids = Object.keys(FLEET);
  for (const id of ids) file(id, 2);
  for (const id of ids) file(id, 1);
  return Promise.all(ids.map((id) => loadFleet(id).then((p) => p && ready.set(id, p))));
}
/** everything, near LODs included (labs) */
export async function preloadAll() {
  await preloadFleet();
  await Promise.all(Object.keys(FLEET).map(loadNear));
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
  // a tyre that floats a few mm (no contact points): mirror its partner on the other side
  for (let i = 0; i < 4; i++) {
    const o = boxes[i ^ 1];
    if (boxes[i].isEmpty() && !o.isEmpty()) boxes[i].set(new THREE.Vector3(-o.max.x, o.min.y, o.min.z), new THREE.Vector3(-o.min.x, o.max.y, o.max.z));
  }
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
// keyed by the image: GLTF clones share one image across many textures, and each drawImage of a
// full-size image down to 1x1 costs ~100+ ms in software rendering (it was 30% of a lab's load)
const avgCache = new WeakMap<object, THREE.Color>();
const WHITE = new THREE.Color(1, 1, 1);
function textureAverage(t: THREE.Texture): THREE.Color {
  // mid/far LOD textures carry their precomputed average (liteFile) and have no image at all
  const pre = t.userData.avg as number[] | undefined;
  if (pre) return new THREE.Color().setRGB(pre[0], pre[1], pre[2], THREE.SRGBColorSpace);
  // ?notex=1 strips the maps anyway, so the flat colour is the material colour alone
  if (FLAGS.notex) return WHITE;
  const key = (t.image as object | null) ?? t;
  let c = avgCache.get(key);
  if (!c) {
    c = new THREE.Color(0.5, 0.5, 0.5);
    try {
      const cv = document.createElement('canvas');
      // atlases are mostly dark trim: average the brighter half of a 16x16 thumbnail (the body colour)
      cv.width = cv.height = 16;
      const g = cv.getContext('2d')!;
      g.drawImage(t.image as CanvasImageSource, 0, 0, 16, 16);
      const d = g.getImageData(0, 0, 16, 16).data;
      const px: number[][] = [];
      for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2], d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11]);
      px.sort((a, b) => b[3] - a[3]);
      const top = px.slice(0, Math.max(1, px.length >> 1));
      const avg = [0, 1, 2].map((k) => top.reduce((s, q) => s + q[k], 0) / top.length / 255);
      c.setRGB(avg[0], avg[1], avg[2], THREE.SRGBColorSpace);
    } catch {
      /* image not decodable here: keep grey */
    }
    avgCache.set(key, c);
  }
  return c;
}


// ---------------------------------------------------------------- merged LOD geometry (shared by every car of a model)

const mergedCache = new Map<string, THREE.BufferGeometry | null>();
/**
 * One LOD's parts merged into a single geometry: `paint` = only the paint parts (positions + normals; the car's
 * colour comes from the instance), otherwise every other part with its colour in the vertices (textured parts
 * take their texture's average colour, glass its tint).
 */
function merged(p: Prepared, level: 1 | 2, paint: boolean): THREE.BufferGeometry | null {
  const key = `${p.id}|${level}|${paint}`;
  if (!mergedCache.has(key)) {
    const geos: THREE.BufferGeometry[] = [];
    for (const part of level === 1 ? p.lod1 : p.lod2) {
      if ((part.mat === 'paint') !== paint) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', part.geo.getAttribute('position'));
      g.setAttribute('normal', part.geo.getAttribute('normal'));
      g.setIndex(part.geo.index);
      if (!paint) {
        const n = g.getAttribute('position').count;
        let col = part.geo.getAttribute('color') as THREE.BufferAttribute | undefined;
        if (!col) {
          const m = part.mat as THREE.MeshStandardMaterial;
          const c = m.color.clone();
          if (m.map) c.multiply(textureAverage(m.map));
          const arr = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) c.toArray(arr, i * 3);
          col = new THREE.BufferAttribute(arr, 3);
        }
        g.setAttribute('color', col);
      }
      geos.push(g);
    }
    const geo = geos.length ? mergeGeometries(geos, false) : null;
    geo?.computeBoundingSphere();
    mergedCache.set(key, geo);
  }
  return mergedCache.get(key)!;
}

// ---------------------------------------------------------------- lamps (night head/tail lights, brake lights)

/** a soft round glow, for lamp cards and the headlight pool */
let glowTex: THREE.Texture | null = null;
function glow() {
  if (glowTex) return glowTex;
  if (typeof document === 'undefined') return (glowTex = new THREE.Texture());
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  gr.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}
const lampMat = (color: string) =>
  new THREE.MeshBasicMaterial({ color, map: glow(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
/** headlights: one shared material, brightness follows the night */
export const HEAD_MAT = lampMat('#fff2dc');
/** tail/brake lights: per-instance colour = brightness (dim tail at night, bright when braking) */
export const TAIL_MAT = lampMat('#ffffff');
const POOL_MAT = new THREE.MeshBasicMaterial({ color: '#ffe9c4', map: null, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
let poolG: THREE.BufferGeometry | null = null;
function poolGeo() {
  if (!poolG) {
    poolG = new THREE.PlaneGeometry(3.6, 9.5, 1, 1);
    poolG.rotateX(-Math.PI / 2);
    POOL_MAT.map = glow();
  }
  return poolG;
}

/**
 * Glow cards where the lamps are: headlights just under the bonnet line at the front corners, tail lights at
 * boot-lid / tailgate height at the rear corners (found from the mid LOD's shape).
 */
function lampCards(parts: Part[]) {
  const box = new THREE.Box3();
  for (const p of parts) box.union(p.geo.boundingBox!);
  const zf = box.min.z, zr = box.max.z, hw = (box.max.x - box.min.x) / 2, H = box.max.y;
  let topF = 0, topR = 0;
  const v = new THREE.Vector3();
  for (const p of parts) {
    const pos = p.geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (Math.abs(v.x) > hw * 0.8) continue;
      if (v.z < zf + 0.3) topF = Math.max(topF, v.y);
      if (v.z > zr - 0.3) topR = Math.max(topR, v.y);
    }
  }
  const yF = Math.min(topF - 0.12, 1.15), yR = Math.min(topR - 0.15, 0.62 * H, 1.15);
  const card = (w: number, h: number, x: number, y: number, z: number, faceZ: number) => {
    const g = new THREE.PlaneGeometry(w, h);
    if (faceZ < 0) g.rotateY(Math.PI);
    g.translate(x, y, z);
    return g;
  };
  const xF = hw - 0.33, xR = hw - 0.22;
  const headGeo = mergeGeometries([card(0.42, 0.26, -xF, yF, zf - 0.02, -1), card(0.42, 0.26, xF, yF, zf - 0.02, -1)])!;
  const tailGeo = mergeGeometries([card(0.42, 0.26, -xR, yR, zr + 0.02, 1), card(0.42, 0.26, xR, yR, zr + 0.02, 1)])!;
  headGeo.computeBoundingSphere();
  tailGeo.computeBoundingSphere();
  return { headGeo, tailGeo, front: zf, rear: zr };
}

// ---------------------------------------------------------------- one car's near LOD

/**
 * The near LOD of one car (full parts, cut-out wheels), plus its brake-lamp lenses. Geometry and materials are
 * shared; only the paint material is the car's own (shared by every car of that colour).
 */
const stillCache = new Map<string, THREE.BufferGeometry | null>();
function staticWheels(p: Prepared) {
  if (!stillCache.has(p.id)) {
    const geos = p.wheels.map((w) => w.geo.clone().translate(w.center.x, w.center.y, w.center.z));
    stillCache.set(p.id, geos.length ? mergeGeometries(geos, false) : null);
  }
  return stillCache.get(p.id)!;
}

const footprints = new Map<string, { len: number; wid: number; cx: number; cz: number }>();
/**
 * The ground footprint of a fleet model as it is drawn (car frame, nose toward -z): length, width with the
 * mirrors, and the centre's offset from the car's origin. From the loaded LODs; the FLEET entry until then.
 * Traffic rects (pedestrian avoidance, player collision) use this, so what you see is what is avoided.
 */
export function footprintOf(id: string) {
  let f = footprints.get(id);
  if (f) return f;
  const p = ready.get(id);
  const spec = FLEET[id];
  if (!p?.lod1.length) return { len: spec?.len ?? 4.8, wid: spec?.wid ?? 1.9, cx: 0, cz: 0 };
  // the larger of the near and mid LODs (a simplified mid LOD may have lost the mirrors)
  const b = new THREE.Box3();
  for (const part of p.nearReady ? [...p.lod1, ...p.lod0] : p.lod1) {
    part.geo.computeBoundingBox();
    b.union(part.geo.boundingBox!);
  }
  f = { len: b.max.z - b.min.z, wid: b.max.x - b.min.x, cx: (b.max.x + b.min.x) / 2, cz: (b.max.z + b.min.z) / 2 };
  if (p.nearReady) footprints.set(id, f);
  return f;
}

export function nearObject(p: Prepared, paint: THREE.Material) {
  const near = new THREE.Group();
  for (const part of p.lod0) {
    const m = new THREE.Mesh(part.geo, part.mat === 'paint' ? sided(paint, part.double) : part.mat);
    // shadows come from the instanced mid-LOD proxy (FleetInstances), not these 25-60k triangles per cascade
    m.castShadow = false;
    m.userData.owned = false;
    near.add(m);
  }
  // night: headlight pool on the road ahead (additive, near cars only; no real light)
  const pool = new THREE.Mesh(poolGeo(), POOL_MAT);
  pool.position.set(0, 0.03, (p.lamps?.front ?? -2.4) - 4.6);
  pool.renderOrder = 2;
  pool.userData.owned = false;
  pool.userData.pool = true;
  near.add(pool);
  // wheels: one merged mesh while the car stands (parked cars), four spinning ones for traffic (userData.spin)
  const wheels: THREE.Object3D[] = [];
  const spinGroup = new THREE.Group();
  spinGroup.visible = false;
  for (const w of p.wheels) {
    const m = new THREE.Mesh(w.geo, WHEEL_MAT);
    m.position.copy(w.center);
    m.castShadow = false;
    m.userData.owned = false;
    spinGroup.add(m);
    wheels.push(m);
  }
  near.add(spinGroup);
  const still = staticWheels(p);
  if (still) {
    const m = new THREE.Mesh(still, WHEEL_MAT);
    m.userData.owned = false;
    near.add(m);
    near.userData.wheelsStill = m;
  }
  near.userData.wheelsSpin = spinGroup;
  let brake: THREE.Mesh | null = null;
  if (p.brake) {
    brake = new THREE.Mesh(p.brake, BRAKE_MAT);
    brake.visible = false;
    brake.userData.owned = false;
  }
  return { near, wheels, wheelR: p.wheels[0]?.r ?? 0.33, brake };
}

// ---------------------------------------------------------------- instanced mid/far LODs

/** distances (m): near LOD inside NEAR, instanced mid LOD to MID (with shadows), instanced far LOD beyond */
export const FLEET_LOD = { NEAR: 12, MID: 40, SHADOW: 25 };
/** which representation a car (whose model has loaded) uses at distance d; 'near' only once its near file is in */
export function fleetLevel(d: number, nearLoaded: boolean): 'near' | 'mid' | 'far' {
  return d < FLEET_LOD.NEAR && nearLoaded ? 'near' : d < FLEET_LOD.MID ? 'mid' : 'far';
}

const MID_PAINT = new THREE.MeshPhysicalMaterial({ color: '#fff', metalness: 0.45, roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.08, side: THREE.DoubleSide, name: 'car-mid-paint' });
const MID_REST = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.3, side: THREE.DoubleSide, name: 'car-mid' });
const FAR_PAINT = new THREE.MeshStandardMaterial({ color: '#fff', metalness: 0.4, roughness: 0.35, side: THREE.DoubleSide, name: 'car-far-paint' });
const FAR_REST = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.25, side: THREE.DoubleSide, name: 'car-far' });

const SHADOW_ONLY = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, name: 'car-shadow-proxy' });
const TAIL_C = new THREE.Color();

interface Entry {
  obj: THREE.Object3D;
  id: string;
  color: THREE.Color;
  /** null until the model's near LOD has loaded: the car stays on the instanced mid LOD up close */
  near: THREE.Object3D | null;
}
/** a growable InstancedMesh for one (model, level, paint|rest) */
class Batch {
  mesh: THREE.InstancedMesh | null = null;
  n = 0;
  constructor(
    private root: THREE.Group,
    private geo: THREE.BufferGeometry,
    private mat: THREE.Material,
    private shadow: boolean,
    private colored: boolean,
  ) {}
  begin() {
    this.n = 0;
  }
  push(m: THREE.Matrix4, c: THREE.Color) {
    if (!this.mesh || this.n >= this.mesh.instanceMatrix.count) {
      const cap = Math.max(16, (this.mesh?.instanceMatrix.count ?? 8) * 2);
      const next = new THREE.InstancedMesh(this.geo, this.mat, cap);
      next.frustumCulled = false; // instances span the whole neighbourhood; the GPU culls the few off-screen
      next.castShadow = this.shadow;
      next.userData.owned = false;
      if (this.mesh) {
        next.instanceMatrix.array.set(this.mesh.instanceMatrix.array);
        if (this.colored && this.mesh.instanceColor) {
          next.setColorAt(0, c); // allocates the colour buffer
          next.instanceColor!.array.set(this.mesh.instanceColor.array);
        }
        this.root.remove(this.mesh);
        this.mesh.dispose();
      }
      this.mesh = next;
      this.root.add(next);
    }
    this.mesh.setMatrixAt(this.n, m);
    if (this.colored) this.mesh.setColorAt(this.n, c);
    this.n++;
  }
  end() {
    if (!this.mesh) return;
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/**
 * Every fleet car's mid and far LODs, drawn as one InstancedMesh per (model, level, paint/rest): all parked and
 * moving cars of a model cost 2-4 draw calls together. Cars register once loaded; each frame update() puts the
 * cars inside NEAR on their own near-LOD meshes and the rest into the instance buffers. Cars that leave the
 * scene (chunk unloaded) are dropped.
 */
export class FleetInstances {
  root = new THREE.Group();
  private cars = new Set<Entry>();
  private batches = new Map<string, Record<'midP' | 'midR' | 'farP' | 'farR' | 'shP' | 'shR' | 'head' | 'tail', Batch | null>>();
  constructor() {
    this.root.name = 'fleet-instances';
  }
  register(obj: THREE.Object3D, id: string, color: THREE.Color, near: THREE.Object3D | null) {
    const e: Entry = { obj, id, color, near };
    this.cars.add(e);
    return e;
  }
  private set(id: string) {
    let b = this.batches.get(id);
    if (!b) {
      const p = ready.get(id)!;
      const mk = (level: 1 | 2, paint: boolean) => {
        const g = merged(p, level, paint);
        // mid instances cast no shadow themselves: cars within SHADOW cast through the depth-only proxies
        return g ? new Batch(this.root, g, level === 1 ? (paint ? MID_PAINT : MID_REST) : paint ? FAR_PAINT : FAR_REST, false, paint) : null;
      };
      // shadow proxies: near cars cast their shadow from the mid LOD (drawn depth-only, invisible in the main pass)
      const sh = (paint: boolean) => {
        const g = merged(p, 1, paint);
        return g ? new Batch(this.root, g, SHADOW_ONLY, true, false) : null;
      };
      const lamp = (g: THREE.BufferGeometry | undefined, m: THREE.Material, colored: boolean) => (g ? new Batch(this.root, g, m, false, colored) : null);
      b = {
        midP: mk(1, true), midR: mk(1, false), farP: mk(2, true), farR: mk(2, false),
        shP: sh(true), shR: sh(false),
        head: lamp(p.lamps?.headGeo, HEAD_MAT, false), tail: lamp(p.lamps?.tailGeo, TAIL_MAT, true),
      };
      this.batches.set(id, b);
    }
    return b;
  }
  /** stats for labs/QA: cars by level */
  census = { near: 0, mid: 0, far: 0 };
  update(eye: THREE.Vector3) {
    for (const b of this.batches.values()) for (const x of Object.values(b)) x?.begin();
    const c = { near: 0, mid: 0, far: 0 };
    const pos = new THREE.Vector3();
    const night = getNight();
    const lit = night > 0.05;
    HEAD_MAT.color.setRGB(1, 0.95, 0.86).multiplyScalar(2.2 * night);
    POOL_MAT.opacity = 0.32 * night;
    POOL_MAT.visible = lit;
    for (const e of this.cars) {
      let top: THREE.Object3D = e.obj;
      while (top.parent) top = top.parent;
      if (!(top as THREE.Scene).isScene) {
        this.cars.delete(e);
        continue;
      }
      e.obj.updateWorldMatrix(true, false);
      pos.setFromMatrixPosition(e.obj.matrixWorld);
      const d = pos.distanceTo(eye);
      const level = fleetLevel(d, !!e.near);
      const isNear = level === 'near';
      if (e.near) e.near.visible = isNear;
      if (isNear && e.near) {
        const spin = !!e.obj.userData.spin;
        if (e.near.userData.wheelsSpin) e.near.userData.wheelsSpin.visible = spin;
        if (e.near.userData.wheelsStill) e.near.userData.wheelsStill.visible = !spin;
      }
      const b = this.set(e.id);
      // lamps for every car, near or not: headlights + tail lights at night, brake lights when braking
      if (lit) b.head?.push(e.obj.matrixWorld, e.color);
      const tail = (lit ? 1.6 * night : 0) + (e.obj.userData.braking ? 2.4 : 0);
      if (tail > 0.02) b.tail?.push(e.obj.matrixWorld, TAIL_C.setRGB(tail, tail * 0.06, tail * 0.03));
      if (d < FLEET_LOD.SHADOW) {
        b.shP?.push(e.obj.matrixWorld, e.color);
        b.shR?.push(e.obj.matrixWorld, e.color);
      }
      if (isNear) {
        c.near++;
        continue;
      }
      if (level === 'mid') {
        b.midP?.push(e.obj.matrixWorld, e.color);
        b.midR?.push(e.obj.matrixWorld, e.color);
        c.mid++;
      } else {
        b.farP?.push(e.obj.matrixWorld, e.color);
        b.farR?.push(e.obj.matrixWorld, e.color);
        c.far++;
      }
    }
    for (const b of this.batches.values()) for (const x of Object.values(b)) x?.end();
    this.census = c;
  }
}
/** the one shared instance manager (its root goes into the active level; see Traffic) */
export const fleetInstances = new FleetInstances();
