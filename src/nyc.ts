import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng, hashN } from './rng';
import { pickModel, spawn, normScale, type ModelEntry } from './assets';
import { mat, glow } from './build';
import { facade, concreteTex, signTex, type FacadeStyle } from './textures';
import type { Env, Level, LevelDesc, Portal, Rect } from './level';
import { disposeTree, rect } from './level';
import { BIOMES } from './biomes';

// Manhattan-ish proportions: long blocks east-west, short north-south
const AX = 120; // chunk size along x (avenue to avenue)
const SZ = 64; // chunk size along z (street to street)
const AVE = 16; // avenue roadway width
const ST = 10; // street roadway width
const SW = 4.5; // sidewalk width
const BX = AX / 2 - AVE / 2; // 52: block half-size x (kerb)
const BZ = SZ / 2 - ST / 2; // 27
const LX = BX - SW; // 47.5: building line
const LZ = BZ - SW; // 22.5
const CURB = 0.15;
const RX = 2;
const RZ = 2;

const AVENUES = ['York Av', '1 Av', '2 Av', '3 Av', 'Lexington Av', 'Park Av', 'Madison Av', '5 Av', '6 Av', 'Broadway', '7 Av', '8 Av', '9 Av', '10 Av', '11 Av', '12 Av'];
export function avenueName(i: number) {
  const n = AVENUES.length;
  return AVENUES[(((i + 7) % n) + n) % n];
}
export function streetName(i: number) {
  const n = 34 - i;
  return n > 0 ? `W ${n} St` : `${Math.abs(n) + 1} St`;
}

export const SHOPS: { type: string; names: string[]; pools: string[]; colors: string[] }[] = [
  { type: 'deli', names: ['DELI & GROCERY', 'BODEGA', 'GOURMET DELI', '24HR DELI'], pools: ['food and drink', 'packaging', 'simready:food and drink', 'simready:packaging'], colors: ['#1d5c2e', '#a3201d', '#1e3f8a'] },
  { type: 'hardware', names: ['HARDWARE', 'TOOLS & SUPPLY', 'LOCKSMITH & HARDWARE'], pools: ['hand tool', 'fastener or hardware', 'power tool', 'simready:hand tool'], colors: ['#b5401c', '#2b2b2b'] },
  { type: 'electronics', names: ['ELECTRONICS', 'CAMERAS & PHONES', 'RADIO SHACKLE', 'COMPUTERS'], pools: ['electronics', 'simready:electronics'], colors: ['#14306b', '#111111'] },
  { type: 'toys', names: ['TOYS & GAMES', 'HOBBY SHOP', 'GAME STOP-N-GO'], pools: ['toy or game', 'simready:toy or game'], colors: ['#d6332a', '#1f8a3a', '#f0b400'] },
  { type: 'music', names: ['MUSIC', 'GUITAR CENTER', 'INSTRUMENTS'], pools: ['musical instrument'], colors: ['#3a1f5c', '#111111'] },
  { type: 'kitchen', names: ['KITCHEN SUPPLY', 'HOUSEWARES', 'RESTAURANT SUPPLY'], pools: ['cookware', 'kitchen appliance', 'tableware', 'simready:cookware', 'simready:tableware'], colors: ['#0f5c5c', '#7a1d1d'] },
  { type: 'lighting', names: ['LIGHTING', 'LAMPS', 'LIGHT & DESIGN'], pools: ['lighting', 'simready:lighting'], colors: ['#222222', '#5c4a1d'] },
  { type: 'sports', names: ['SPORTS', 'ATHLETIC', 'BIKES & BOARDS'], pools: ['sports equipment', 'simready:sports equipment'], colors: ['#14306b', '#c4161c'] },
  { type: 'pharmacy', names: ['PHARMACY', 'DRUGS & COSMETICS', 'CHEMIST'], pools: ['medical or personal care', 'simready:medical or personal care'], colors: ['#c4161c', '#0b5ea8'] },
  { type: 'furniture', names: ['FURNITURE', 'HOME & DECOR', 'MODERN HOME'], pools: ['furniture', 'simready:furniture', 'simready:decor'], colors: ['#3b3b3b', '#6b4a2e'] },
  { type: 'antiques', names: ['ANTIQUES', 'CURIOSITIES', 'THRIFT', 'PAWN SHOP'], pools: ['weapon or armour', 'measuring instrument', 'container', 'animal gear'], colors: ['#5c3b1d', '#1d3b2e'] },
  { type: 'stationery', names: ['BOOKS & STATIONERY', 'PAPER & PENS', 'OFFICE SUPPLY'], pools: ['stationery', 'simready:stationery'], colors: ['#1d2f5c', '#5c1d3b'] },
  { type: 'garden', names: ['FLOWERS & GARDEN', 'PLANT SHOP'], pools: ['garden or outdoor'], colors: ['#2e6b2e', '#6b2e5c'] },
  { type: 'models', names: ['MODEL TRAINS & PLANES', 'HOBBY MODELS'], pools: ['vehicle', 'aircraft or spacecraft', 'watercraft'], colors: ['#1d3b5c', '#5c1d1d'] },
  { type: 'machines', names: ['MACHINE PARTS', 'INDUSTRIAL SUPPLY', 'BEARINGS & GEARS'], pools: ['cad', 'machine or industrial', 'automate', 'articraft'], colors: ['#3b3b3b', '#1d4a5c'] },
];
const PREFIX = ['JOE’S', 'LUCKY', 'NEW', 'BIG APPLE', 'EMPIRE', 'MIDTOWN', 'RAY’S', 'GOLDEN', 'ACE', 'METRO', 'PARK', 'CITY', 'BROADWAY', 'LIBERTY', 'STAR', 'UNION'];

// ---------------------------------------------------------------- static geometry baking

/** shared vertex-coloured materials, bucketed by roughness/metalness */
const vcMats = new Map<string, THREE.MeshStandardMaterial>();
function vcMat(rough: number, metal: number) {
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
function bake(src: THREE.Object3D): THREE.Group {
  src.updateMatrixWorld(true);
  const buckets = new Map<string, { m: THREE.Material; shadow: boolean; geos: THREE.BufferGeometry[]; vc: boolean }>();
  const col = new THREE.Color();
  src.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const sm = mesh.material as THREE.MeshStandardMaterial;
    const plain = sm.isMeshStandardMaterial && !sm.map && !sm.transparent && (sm.emissiveIntensity === 0 || sm.emissive.getHex() === 0);
    let g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    const n = g.getAttribute('position').count;
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    let key: string;
    let material: THREE.Material = mesh.material;
    const tint = mesh.userData.tint as string | undefined;
    if (tint) {
      col.set(tint);
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      key = `${mesh.material.uuid}|${mesh.castShadow}`;
    } else if (plain) {
      const rough = Math.round(sm.roughness * 3) / 3, metal = Math.round(sm.metalness * 2) / 2;
      material = vcMat(rough, metal);
      col.copy(sm.color);
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
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

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
const unitSphere = new THREE.IcosahedronGeometry(0.5, 1);

function B(parent: THREE.Object3D, m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, shadow = true) {
  const o = new THREE.Mesh(unitBox, m);
  o.scale.set(w, h, d);
  o.position.set(x, y + h / 2, z);
  o.castShadow = shadow;
  parent.add(o);
  return o;
}
function C(parent: THREE.Object3D, m: THREE.Material, r: number, h: number, x: number, y: number, z: number, shadow = true) {
  const o = new THREE.Mesh(unitCyl, m);
  o.scale.set(r * 2, h, r * 2);
  o.position.set(x, y + h / 2, z);
  o.castShadow = shadow;
  parent.add(o);
  return o;
}

type Side = 'N' | 'S' | 'E' | 'W';
const NORMAL: Record<Side, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

/** A vertical wall quad along one side of a footprint, UVs in world units for facade tiling. */
/** neutral facade textures, tinted per building through vertex colours */
const facadeMats = new Map<string, THREE.MeshStandardMaterial>();
function facadeMat(style: FacadeStyle, seed: number) {
  const key = `${style}:${seed}`;
  let m = facadeMats.get(key);
  if (!m) {
    const fac = facade(style, '#d9d9d9', 0.12, seed + 40);
    m = new THREE.MeshStandardMaterial({ map: fac.map, vertexColors: true, roughness: style === 'glass' ? 0.2 : 0.85, metalness: style === 'glass' ? 0.4 : 0 });
    facadeMats.set(key, m);
  }
  return m;
}

function wallQuad(parent: THREE.Object3D, m: THREE.Material, r: Rect, side: Side, y0: number, y1: number, tileW = 12, tileH = 12.8, tint?: string) {
  const alongX = side === 'N' || side === 'S';
  const len = alongX ? r.maxX - r.minX : r.maxZ - r.minZ;
  const h = y1 - y0;
  const g = new THREE.PlaneGeometry(len, h);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * len) / tileW, (uv.getY(i) * h) / tileH + y0 / tileH);
  const o = new THREE.Mesh(g, m);
  o.castShadow = true;
  const cx = (r.minX + r.maxX) / 2, cz = (r.minZ + r.maxZ) / 2;
  if (side === 'N') o.position.set(cx, y0 + h / 2, r.minZ);
  if (side === 'S') o.position.set(cx, y0 + h / 2, r.maxZ);
  if (side === 'E') o.position.set(r.maxX, y0 + h / 2, cz);
  if (side === 'W') o.position.set(r.minX, y0 + h / 2, cz);
  o.rotation.y = { S: 0, N: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 }[side];
  if (tint) o.userData.tint = tint;
  parent.add(o);
  return o;
}

// ---------------------------------------------------------------- textures

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = false) {
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

let roadTexCache: THREE.Texture | null = null;
function nycRoadTex() {
  if (roadTexCache) return roadTexCache;
  const P = 10; // px per metre
  roadTexCache = canvasTex(AX * P, SZ * P, (g) => {
    const W = AX * P, H = SZ * P;
    g.fillStyle = '#3d3e41';
    g.fillRect(0, 0, W, H);
    const img = g.getImageData(0, 0, W, H);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 22;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    // patches and manholes
    for (let i = 0; i < 30; i++) {
      g.fillStyle = `rgba(${Math.random() < 0.5 ? '20,20,22' : '80,80,84'},0.35)`;
      g.fillRect(Math.random() * W, Math.random() * H, 20 + Math.random() * 60, 10 + Math.random() * 40);
    }
    g.fillStyle = '#26272a';
    for (const [x, y] of [[4, 20], [116, 44], [30, 2.5], [90, 61.5]]) {
      g.beginPath();
      g.arc(x * P, y * P, 0.45 * P, 0, Math.PI * 2);
      g.fill();
    }
    // avenue lane lines (avenue halves at x=0..8 and 112..120); streets at z=0..5 and 59..64
    g.fillStyle = 'rgba(235,235,235,0.85)';
    for (let z = ST / 2 + 1; z < SZ - ST / 2 - 1; z += 6) {
      for (const x of [0, 4.2, AX - 4.2, AX]) g.fillRect(x * P - 1.2, z * P, 2.4, 3 * P);
    }
    for (let x = AVE / 2 + 1; x < AX - AVE / 2 - 1; x += 6) {
      for (const y of [0, SZ]) g.fillRect(x * P, y * P - 1.2, 3 * P, 2.4);
    }
    // crosswalks: across the avenue near the corners, and across the street
    g.fillStyle = 'rgba(240,240,240,0.92)';
    for (const z0 of [ST / 2 + 0.4, SZ - ST / 2 - 3.4]) {
      for (const xs of [[0, AVE / 2], [AX - AVE / 2, AX]]) {
        for (let x = xs[0] + 0.3; x < xs[1] - 0.2; x += 1.2) g.fillRect(x * P, z0 * P, 0.6 * P, 3 * P);
      }
    }
    for (const x0 of [AVE / 2 + 0.4, AX - AVE / 2 - 3.4]) {
      for (const zs of [[0, ST / 2], [SZ - ST / 2, SZ]]) {
        for (let z = zs[0] + 0.3; z < zs[1] - 0.2; z += 1.2) g.fillRect(x0 * P, z * P, 3 * P, 0.6 * P);
      }
    }
    // stop bars
    for (const z0 of [ST / 2 + 3.9, SZ - ST / 2 - 4.3]) for (const xs of [[0.3, AVE / 2], [AX - AVE / 2, AX - 0.3]]) g.fillRect(xs[0] * P, z0 * P, (xs[1] - xs[0]) * P, 0.4 * P);
  });
  return roadTexCache;
}

const windowTexCache = new Map<string, THREE.Texture>();
const windowMatCache = new Map<string, THREE.MeshStandardMaterial>();
function shopWindowMat(type: string, seed: number) {
  const key = `${type}:${seed % 4}`;
  let m = windowMatCache.get(key);
  if (!m) {
    const t = shopWindowTex(type, seed);
    m = new THREE.MeshStandardMaterial({ map: t, emissive: '#ffffff', emissiveMap: t, emissiveIntensity: 0.55, roughness: 0.1, metalness: 0.3 });
    windowMatCache.set(key, m);
  }
  return m;
}
function shopWindowTex(type: string, seed: number) {
  const key = `${type}:${seed % 4}`;
  let t = windowTexCache.get(key);
  if (t) return t;
  const r = new Rng(seed);
  t = canvasTex(256, 192, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, 192);
    grad.addColorStop(0, '#fff3d6');
    grad.addColorStop(1, '#c9a46a');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 192);
    const cols = ['#d33', '#3a3', '#36c', '#fc3', '#f80', '#a3c', '#fff', '#333', '#0aa'];
    for (let y = 40; y < 190; y += 38) {
      g.fillStyle = '#7a5a36';
      g.fillRect(0, y, 256, 4);
      for (let x = 6; x < 250; x += 10 + r.int(0, 10)) {
        g.fillStyle = r.pick(cols);
        const h = 8 + r.int(0, 22);
        g.fillRect(x, y - h, 6 + r.int(0, 8), h);
      }
    }
    if (r.chance(0.6)) {
      g.fillStyle = '#ff2a2a';
      g.font = 'bold 26px system-ui';
      g.fillText('OPEN', 170, 30);
    }
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.beginPath();
    g.moveTo(0, 0); g.lineTo(90, 0); g.lineTo(0, 120);
    g.fill();
    void type;
  });
  windowTexCache.set(key, t);
  return t;
}

const sidewalkTex = (() => {
  let t: THREE.Texture | null = null;
  return () => {
    if (t) return t;
    t = concreteTex('#b9b5ad', 96).clone();
    t.needsUpdate = true;
    return t;
  };
})();

// ---------------------------------------------------------------- materials

const M = {
  sidewalk: () => mat('#ffffff', { map: sidewalkTex(), rough: 0.9 }),
  curb: () => mat('#8f8b84', { rough: 0.8 }),
  tar: () => mat('#3a3836', { rough: 0.95 }),
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
const SIG = {
  aveR: new THREE.MeshStandardMaterial({ color: '#330000', emissive: '#ff2a1a' }),
  aveY: new THREE.MeshStandardMaterial({ color: '#332200', emissive: '#ffb21a' }),
  aveG: new THREE.MeshStandardMaterial({ color: '#002211', emissive: '#2aff8a' }),
  stR: new THREE.MeshStandardMaterial({ color: '#330000', emissive: '#ff2a1a' }),
  stY: new THREE.MeshStandardMaterial({ color: '#332200', emissive: '#ffb21a' }),
  stG: new THREE.MeshStandardMaterial({ color: '#002211', emissive: '#2aff8a' }),
};
const CYCLE = 24;
/** 'g' | 'y' | 'r' for traffic moving along avenues (z) or streets (x) */
function lightFor(axis: 'x' | 'z', time: number): 'g' | 'y' | 'r' {
  const t = time % CYCLE;
  if (axis === 'z') return t < 10 ? 'g' : t < 12.5 ? 'y' : 'r';
  return t < 12.5 ? 'r' : t < 22 ? 'g' : t < 24 ? 'y' : 'r';
}

// ---------------------------------------------------------------- the level

interface Chunk {
  group: THREE.Group;
  colliders: Rect[];
  portals: Portal[];
}

export class NycLevel implements Level {
  name: string;
  group = new THREE.Group();
  spawn = { pos: new THREE.Vector3(BX - 2.6, 0, BZ - 3.2), yaw: 0.1 };
  env: Env;
  private chunks = new Map<string, Chunk>();
  private seed: number;
  private nearPortals: Portal[] = [];
  private nearCols: Rect[] = [];
  private lastKey = '';
  private traffic: Traffic;
  private peds: Pedestrians;
  private steam: THREE.Sprite[] = [];

  constructor(desc: Extract<LevelDesc, { kind: 'nyc' }>) {
    this.seed = desc.seed;
    this.name = desc.name;
    const b = BIOMES.metropolis;
    this.env = {
      skyTop: '#5d8cc4', skyBottom: '#e9dcc8', stars: false, fog: '#d9d2c6', fogNear: 80, fogFar: 300,
      sun: { color: '#ffdcae', intensity: 2.8, elev: 28, azim: 235 }, hemi: { sky: '#d8e4f2', ground: '#6b6052', intensity: 0.85 },
      ambient: 0.1, envIntensity: 0.5, exposure: 1.0,
    };
    void b;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) this.ensure(dx, dz);
    this.refresh(0, 0);
    this.traffic = new Traffic(this.group, this.seed);
    this.peds = new Pedestrians(this.group, this.seed);
  }

  colliders() {
    return this.nearCols.concat(this.traffic.rects());
  }
  portals() {
    return this.nearPortals.concat(this.traffic.portals);
  }

  update(dt: number, p: THREE.Vector3, time: number) {
    const cx = Math.round(p.x / AX), cz = Math.round(p.z / SZ);
    let built = 0;
    for (let ring = 0; ring <= Math.max(RX, RZ) && built < 1; ring++) {
      for (let dz = -Math.min(ring, RZ); dz <= Math.min(ring, RZ) && built < 1; dz++)
        for (let dx = -Math.min(ring, RX); dx <= Math.min(ring, RX) && built < 1; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          if (this.ensure(cx + dx, cz + dz)) built++;
        }
    }
    for (const [k, ch] of this.chunks) {
      const [x, z] = k.split(',').map(Number);
      if (Math.abs(x - cx) > RX + 1 || Math.abs(z - cz) > RZ + 1) {
        this.group.remove(ch.group);
        disposeTree(ch.group);
        this.chunks.delete(k);
      }
    }
    const key = `${cx},${cz},${this.chunks.size}`;
    if (key !== this.lastKey) this.refresh(cx, cz);
    this.lastKey = key;
    // signals
    for (const [axis, r, y, g] of [['z', SIG.aveR, SIG.aveY, SIG.aveG], ['x', SIG.stR, SIG.stY, SIG.stG]] as const) {
      const l = lightFor(axis, time);
      r.emissiveIntensity = l === 'r' ? 3 : 0.05;
      y.emissiveIntensity = l === 'y' ? 3 : 0.05;
      g.emissiveIntensity = l === 'g' ? 3 : 0.05;
    }
    this.traffic.update(dt, p, time);
    this.peds.update(dt, p);
    for (const s of this.steam) {
      const ph = ((time * 0.35 + s.userData.ph) % 1);
      s.position.y = s.userData.y + ph * 5;
      s.scale.setScalar(1 + ph * 3);
      (s.material as THREE.SpriteMaterial).opacity = 0.45 * (1 - ph);
    }
  }

  dispose() {
    disposeTree(this.group);
  }

  private refresh(cx: number, cz: number) {
    this.nearPortals = [];
    this.nearCols = [];
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const ch = this.chunks.get(`${cx + dx},${cz + dz}`);
        if (ch) {
          this.nearPortals.push(...ch.portals);
          this.nearCols.push(...ch.colliders);
        }
      }
  }

  private ensure(cx: number, cz: number) {
    const k = `${cx},${cz}`;
    if (this.chunks.has(k)) return false;
    const ch = this.block(cx, cz);
    const ox = cx * AX, oz = cz * SZ;
    ch.group.position.set(ox, 0, oz);
    for (const c of ch.colliders) { c.minX += ox; c.maxX += ox; c.minZ += oz; c.maxZ += oz; }
    for (const p of ch.portals) {
      p.box.translate(new THREE.Vector3(ox, 0, oz));
      p.returnPos?.add(new THREE.Vector3(ox, 0, oz));
    }
    this.group.add(ch.group);
    this.chunks.set(k, ch);
    return true;
  }

  // ------------------------------------------------------------ one block

  private block(cx: number, cz: number): Chunk {
    const rng = new Rng(hashN(this.seed, cx, cz));
    const group = new THREE.Group();
    const stat = new THREE.Group(); // merged at the end
    const colliders: Rect[] = [];
    const portals: Portal[] = [];
    // district character: smooth-ish noise across the grid
    const tower = 0.5 + 0.5 * Math.sin(cx * 0.9 + this.seed * 0.001) * Math.cos(cz * 0.37 + 1.3);
    const village = tower < 0.35;

    // road + sidewalk
    const road = new THREE.Mesh(new THREE.PlaneGeometry(AX, SZ), mat('#ffffff', { map: nycRoadTex(), rough: 0.92 }));
    road.rotation.x = -Math.PI / 2;
    road.receiveShadow = true;
    road.userData.owned = true;
    group.add(road);
    const sw = new THREE.PlaneGeometry(BX * 2, BZ * 2);
    const uv = sw.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * BX * 2) / 3, (uv.getY(i) * BZ * 2) / 3);
    const swm = new THREE.Mesh(sw, M.sidewalk());
    swm.rotation.x = -Math.PI / 2;
    swm.position.y = CURB;
    stat.add(swm);
    const curb = M.curb();
    B(stat, curb, BX * 2, CURB, 0.25, 0, 0, -BZ + 0.125, false);
    B(stat, curb, BX * 2, CURB, 0.25, 0, 0, BZ - 0.125, false);
    B(stat, curb, 0.25, CURB, BZ * 2, -BX + 0.125, 0, 0, false);
    B(stat, curb, 0.25, CURB, BZ * 2, BX - 0.125, 0, 0, false);
    // the hidden backyard core of the block
    B(stat, mat('#5a564f'), LX * 2 - 1, 2.5, LZ * 2 - 1, 0, 0, 0, false);

    const ctx: Ctx = { rng, group, stat, colliders, portals, cx, cz, seed: hashN(this.seed, cx, cz, 5), doors: [] };

    // avenue frontage: both ends of the block
    for (const end of [-1, 1]) {
      const x0 = end < 0 ? -LX : LX - 20;
      const x1 = end < 0 ? -LX + 20 : LX;
      const side: Side = end < 0 ? 'W' : 'E';
      const big = tower > 0.62 && rng.chance(0.7);
      if (big) {
        this.building(ctx, { minX: x0, maxX: x1, minZ: -LZ, maxZ: LZ }, side, 'tower', rng.int(22, 48), true, [true, true]);
      } else {
        const n = rng.int(2, 3);
        const cuts = [-LZ];
        for (let i = 1; i < n; i++) cuts.push(-LZ + (i * 2 * LZ) / n + rng.range(-3, 3));
        cuts.push(LZ);
        for (let i = 0; i < n; i++) {
          const type = tower > 0.45 ? rng.pick(['prewar', 'prewar', 'midrise'] as const) : rng.pick(['tenement', 'prewar', 'midrise'] as const);
          const floors = type === 'prewar' ? rng.int(9, 18) : type === 'midrise' ? rng.int(6, 12) : rng.int(5, 6);
          this.building(ctx, { minX: x0, maxX: x1, minZ: cuts[i], maxZ: cuts[i + 1] }, side, type, floors, true, [i === 0, i === n - 1]);
        }
      }
    }
    // mid-block rows facing the streets
    for (const row of [-1, 1]) {
      const side: Side = row < 0 ? 'N' : 'S';
      let x = -LX + 20;
      while (x < LX - 20 - 3) {
        const type = village ? rng.pick(['brownstone', 'brownstone', 'brownstone', 'tenement'] as const) : tower > 0.6 ? rng.pick(['midrise', 'tenement', 'prewar', 'castiron'] as const) : rng.pick(['tenement', 'tenement', 'brownstone', 'castiron', 'midrise'] as const);
        let w = type === 'brownstone' ? rng.range(5.5, 7) : type === 'castiron' ? rng.range(9, 14) : rng.range(7, 10);
        if (x + w > LX - 20 - 3) w = LX - 20 - x;
        const depth = rng.range(14, 19);
        const r: Rect = row < 0 ? { minX: x, maxX: x + w, minZ: -LZ, maxZ: -LZ + depth } : { minX: x, maxX: x + w, minZ: LZ - depth, maxZ: LZ };
        const floors = type === 'brownstone' ? rng.int(3, 5) : type === 'tenement' ? rng.int(4, 6) : type === 'castiron' ? rng.int(5, 7) : type === 'prewar' ? rng.int(9, 14) : rng.int(7, 12);
        const store = type !== 'brownstone' && rng.chance(type === 'tenement' ? 0.6 : 0.75);
        this.building(ctx, r, side, type, floors, store, [false, false]);
        x += w;
      }
    }
    this.street(ctx, village, tower);

    // merge everything static into a few meshes
    const baked = bake(stat);
    group.add(baked);
    // dispose the per-building geometries that were merged
    stat.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry !== unitBox && m.geometry !== unitCyl && m.geometry !== unitSphere) m.geometry.dispose();
    });
    return { group, colliders, portals };
  }

  // ------------------------------------------------------------ buildings

  private building(ctx: Ctx, r: Rect, front: Side, type: BType, floors: number, store: boolean, cornerSides: [boolean, boolean]) {
    const { rng, stat, colliders } = ctx;
    const style: FacadeStyle = { brownstone: 'brownstone', tenement: 'brick', prewar: 'prewar', midrise: rng.pick(['brick', 'panel', 'prewar'] as const), tower: rng.pick(['glass', 'glass', 'panel'] as const), castiron: 'castiron' }[type] as FacadeStyle;
    const wall = {
      brownstone: rng.pick(['#6e4632', '#7a5038', '#5e3c2c', '#83604a']),
      tenement: rng.pick(['#8c3b2a', '#9a5a3c', '#a3683f', '#7a3a2e', '#b58a5a', '#6b4a3a']),
      prewar: rng.pick(['#c9b28c', '#b89d78', '#d6c4a2', '#a8896a']),
      midrise: rng.pick(['#9a8c7c', '#b8b0a2', '#7d6b5a', '#a35a3c']),
      tower: rng.pick(['#7b8d9e', '#6d7f8c', '#8fa1ad', '#5b6670']),
      castiron: rng.pick(['#d4d0c6', '#c2c9c4', '#cfc2a8', '#b8b8b0']),
    }[type];
    const fm = facadeMat(style, rng.int(0, 2));
    const plain = mat(shade(wall, 0.82), { rough: 0.95 });
    const ground = store || type === 'tower' ? 4.6 : type === 'brownstone' ? 1.6 : 3.4;
    const fh = 3.3;
    let h = ground + (floors - 1) * fh;
    if (type === 'tower') h = ground + floors * 3.6;

    const sides: Side[] = ['N', 'S', 'E', 'W'];
    const exposed = (s: Side) => s === front || (front === 'E' || front === 'W' ? (s === 'N' && cornerSides[0]) || (s === 'S' && cornerSides[1]) : false);
    // tower: setbacks
    if (type === 'tower') {
      let rr = { ...r };
      let y = 0;
      const tiers = rng.int(1, 3);
      for (let t = 0; t < tiers; t++) {
        const th = t === tiers - 1 ? h - y : (h - y) * rng.range(0.45, 0.65);
        for (const s of sides) wallQuad(stat, fm, rr, s, y, y + th, 12, 14.4, wall);
        roof(stat, rr, y + th);
        y += th;
        const inset = rng.range(2, 4);
        rr = { minX: rr.minX + inset, maxX: rr.maxX - inset, minZ: rr.minZ + inset, maxZ: rr.maxZ - inset };
        if (rr.maxX - rr.minX < 6 || rr.maxZ - rr.minZ < 6) break;
      }
      if (rng.chance(0.5)) C(stat, M.iron(), 0.12, rng.range(8, 20), (rr.minX + rr.maxX) / 2, y, (rr.minZ + rr.maxZ) / 2);
    } else {
      for (const s of sides) {
        const isFront = s === front;
        if (isFront || exposed(s)) wallQuad(stat, fm, r, s, isFront ? ground : 0, h, 12, 12.8, wall);
        else wallQuad(stat, plain, r, s, 0, h);
        if (isFront) wallQuad(stat, mat(shade(wall, type === 'brownstone' ? 0.75 : 0.45), { rough: 0.8 }), r, s, 0, ground, 3, 3);
      }
      roof(stat, r, h);
      // cornice along the front (and exposed sides)
      const cm = mat(type === 'brownstone' ? '#3a2a20' : type === 'castiron' ? '#e8e4da' : shade(wall, 1.25), { rough: 0.7 });
      for (const s of sides) if (s === front || exposed(s)) ledge(stat, cm, r, s, h - 0.6, 0.6, 0.55);
      if (store || type === 'castiron') for (const s of sides) if (s === front || exposed(s)) ledge(stat, cm, r, s, ground - 0.25, 0.25, 0.2);
      // rooftop: parapet, water tower, bulkheads
      const pm = mat(shade(wall, 0.7), { rough: 0.9 });
      for (const s of sides) ledge(stat, pm, r, s, h, 0.9, -0.15);
      if ((type === 'tenement' || type === 'prewar' || type === 'midrise') && rng.chance(0.45)) waterTower(stat, (r.minX + r.maxX) / 2 + rng.range(-1, 1), h, (r.minZ + r.maxZ) / 2 + rng.range(-1, 1));
      if (rng.chance(0.5)) B(stat, mat('#7a756c'), 2.4, 2.4, 2.4, (r.minX + r.maxX) / 2, h, (r.minZ + r.maxZ) / 2 + 1);
      if ((type === 'tenement' || (type === 'midrise' && floors <= 8)) && rng.chance(0.75)) fireEscape(stat, r, front, ground, floors, fh, rng);
    }
    colliders.push({ ...r });

    // ---- the front at street level
    const [nx, nz] = NORMAL[front];
    const alongX = front === 'N' || front === 'S';
    const a0 = alongX ? r.minX : r.minZ, a1 = alongX ? r.maxX : r.maxZ;
    const lineC = front === 'N' ? r.minZ : front === 'S' ? r.maxZ : front === 'E' ? r.maxX : r.minX;
    const P = (along: number, out: number) => (alongX ? new THREE.Vector3(along, 0, lineC + nz * out) : new THREE.Vector3(lineC + nx * out, 0, along));
    const rot = { S: 0, N: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 }[front];
    const addr = `${rng.int(1, 650)} ${front === 'E' || front === 'W' ? avenueName(ctx.cx + (front === 'E' ? 0 : -1)) : streetName(ctx.cz + (front === 'S' ? 0 : -1))}`;

    if (store) {
      const n = Math.max(1, Math.min(3, Math.floor((a1 - a0) / 6.5)));
      for (let i = 0; i < n; i++) {
        const s0 = a0 + ((a1 - a0) * i) / n, s1 = a0 + ((a1 - a0) * (i + 1)) / n;
        this.storefront(ctx, s0, s1, P, rot, front, ground, addr);
      }
    } else {
      const doorAt = a0 + (a1 - a0) * (type === 'brownstone' ? 0.3 : 0.5);
      const g = new THREE.Group();
      const raise = type === 'brownstone' ? 1.6 : 0.15;
      const doorM = mat(type === 'brownstone' ? '#2e1e14' : '#3a3f44', { rough: 0.5 });
      B(g, mat('#e9e2d2'), 1.9, 2.9, 0.25, 0, raise, 0.02);
      B(g, doorM, 1.4, 2.5, 0.3, 0, raise, 0.03, false);
      B(g, mat('#ffe2a8', { emissive: '#ffd27a', ei: 0.6 }), 1.4, 0.35, 0.31, 0, raise + 2.5, 0.03, false);
      if (type === 'brownstone') {
        // the stoop
        const stoneM = mat(shade(wall, 0.9), { rough: 0.9 });
        for (let k = 0; k < 8; k++) B(g, stoneM, 2.0, (k + 1) * 0.2, 0.32, 0, 0, 0.2 + (8 - k) * 0.32);
        B(g, M.iron(), 0.05, 1.0, 2.9, -1.0, 1.0, 1.6, false).rotation.x = -0.5;
        B(g, M.iron(), 0.05, 1.0, 2.9, 1.0, 1.0, 1.6, false).rotation.x = -0.5;
        B(g, M.iron(), 0.05, 0.9, 0.05, -1.0, 0.15, 3.0, false);
        B(g, M.iron(), 0.05, 0.9, 0.05, 1.0, 0.15, 3.0, false);
      } else {
        B(g, mat('#2b2b2b'), 2.6, 0.12, 1.2, 0, 3.1, 0.6);
      }
      const at = P(doorAt, 0);
      g.position.copy(at);
      g.rotation.y = rot;
      stat.add(g);
      if (type === 'brownstone') colliders.push(rectAround(P(doorAt, 1.6), alongX ? 2.1 : 2.9, alongX ? 2.9 : 2.1));
      const entry = P(doorAt, type === 'brownstone' ? 3.6 : 0.8);
      const style2 = type === 'brownstone' ? 'house' : type === 'tower' ? 'office' : rng.pick(['apartment', 'apartment', 'house', 'office']);
      ctx.portals.push({
        box: new THREE.Box3().setFromCenterAndSize(entry.clone().setY(1.5), new THREE.Vector3(alongX ? 2.2 : 2.4, 3, alongX ? 2.4 : 2.2)),
        label: `Enter ${addr}`,
        sub: `${floors}-storey ${type === 'brownstone' ? 'brownstone' : type === 'tower' ? 'office tower' : type === 'castiron' ? 'cast-iron loft' : 'walk-up'}`,
        target: { kind: 'interior', seed: hashN(ctx.seed, Math.round(doorAt * 10), 3), name: addr, style: style2, floor: 0, floors: Math.min(floors, 40), biome: 'town' },
      });
      ctx.doors.push(P(doorAt, SW));
    }
    void ctx;
  }

  private storefront(ctx: Ctx, s0: number, s1: number, P: (a: number, o: number) => THREE.Vector3, rot: number, front: Side, ground: number, addr: string) {
    const { rng, stat, group } = ctx;
    const shop = rng.pick(SHOPS);
    const name = `${rng.chance(0.5) ? rng.pick(PREFIX) + ' ' : ''}${rng.pick(shop.names)}`;
    const color = rng.pick(shop.colors);
    const w = s1 - s0;
    const mid = (s0 + s1) / 2;
    const g = new THREE.Group();
    const frameM = mat(rng.pick(['#1c1c1c', '#2e3b2e', '#4a2a1e', '#d8d2c4', color]), { rough: 0.5, metal: 0.2 });
    // pilasters
    B(g, frameM, 0.35, ground - 0.3, 0.3, -w / 2 + 0.18, 0, 0.1);
    B(g, frameM, 0.35, ground - 0.3, 0.3, w / 2 - 0.18, 0, 0.1);
    // sign band
    const signT = signTex(name, color, '#f7f1e3');
    const signM = new THREE.MeshStandardMaterial({ map: signT, roughness: 0.6, emissive: '#ffffff', emissiveMap: signT, emissiveIntensity: 0.25 });
    B(g, frameM, w - 0.3, 0.85, 0.25, 0, ground - 0.85, 0.18);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.4, 0.78), signM);
    sign.position.set(0, ground - 0.85 + 0.42, 0.31);
    sign.userData.owned = true;
    group.add(placeLocal(sign, P(mid, 0), rot));
    // windows either side of the door
    const doorW = 1.3;
    const doorX = rng.chance(0.5) ? 0 : (rng.chance(0.5) ? -1 : 1) * (w / 2 - 1.4);
    const winM = shopWindowMat(shop.type, rng.int(0, 99));
    const wy = 0.6, wh = ground - 1.55;
    const segs: [number, number][] = [[-w / 2 + 0.35, doorX - doorW / 2 - 0.1], [doorX + doorW / 2 + 0.1, w / 2 - 0.35]];
    for (const [a, b] of segs) {
      if (b - a < 0.4) continue;
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(b - a, wh), winM);
      pane.position.set((a + b) / 2, wy + wh / 2, 0.06);
      g.add(pane);
      B(g, frameM, b - a + 0.1, wy, 0.2, (a + b) / 2, 0, 0.05);
      B(g, frameM, 0.06, wh, 0.08, (a + b) / 2, wy, 0.1, false);
    }
    // door
    B(g, mat('#202428', { rough: 0.2, metal: 0.5 }), doorW, 2.5, 0.12, doorX, 0, 0.04, false);
    B(g, mat('#c9c2b0', { metal: 0.8, rough: 0.3 }), 0.05, 0.6, 0.06, doorX + 0.45, 1.0, 0.13, false);
    // awning
    if (rng.chance(0.65)) {
      const aw = B(g, mat(color, { rough: 0.85 }), w - 0.4, 0.08, 1.5, 0, ground - 1.05, 0.75);
      aw.rotation.x = 0.32;
      B(g, mat(color, { rough: 0.85 }), w - 0.4, 0.35, 0.04, 0, ground - 1.55, 1.48, false);
    }
    g.position.copy(P(mid, 0));
    g.rotation.y = rot;
    stat.add(g);
    // portal into the shop
    const along = mid + doorX * dirSign(front);
    const ent = P(along, 0.7);
    const alongX = front === 'N' || front === 'S';
    ctx.portals.push({
      box: new THREE.Box3().setFromCenterAndSize(ent.clone().setY(1.4), new THREE.Vector3(alongX ? 1.8 : 1.6, 2.8, alongX ? 1.6 : 1.8)),
      label: `Enter ${titleCaseName(name)}`,
      sub: `${addr} · stocked with sand3d ${shop.type === 'machines' ? 'machine parts' : shop.pools[0]}`,
      target: { kind: 'interior', seed: hashN(ctx.seed, Math.round(along * 10), 11), name: titleCaseName(name), style: 'store', floor: 0, floors: 1, biome: 'metropolis', shop: shop.type },
    });
    ctx.doors.push(P(along, SW));
  }

  // ------------------------------------------------------------ street furniture

  private street(ctx: Ctx, village: boolean, tower: number) {
    const { rng, stat, group, colliders } = ctx;
    const edgeX = BX - 0.7, edgeZ = BZ - 0.7;
    const near = (x: number, z: number, d = 2.2) => ctx.doors.some((p) => Math.hypot(p.x - x, p.z - z) < d);

    // corners: traffic signals, name signs, sometimes a subway entrance
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx * (BX - 0.9), z = sz * (BZ - 0.9);
      signalPole(stat, x, z, sx, sz);
      colliders.push(rect(x, z, 0.5, 0.5));
      const ave = avenueName(ctx.cx + (sx > 0 ? 0 : -1));
      const st = streetName(ctx.cz + (sz > 0 ? 0 : -1));
      group.add(nameSign(st, x, 3.6, z, 0));
      group.add(nameSign(ave, x, 3.9, z, Math.PI / 2));
      if (rng.chance(0.08)) {
        // a corner trash can and a mailbox
        B(stat, mat('#1d5c3a', { rough: 0.7 }), 0.6, 0.95, 0.6, x - sx * 1.6, CURB, z - sz * 0.8);
      }
    }
    if (rng.chance(0.35)) {
      const sx = rng.chance(0.5) ? -1 : 1, sz = rng.chance(0.5) ? -1 : 1;
      subway(stat, group, sx * (BX - 2.2), sz * (BZ - 9), ctx.cz, rng);
      colliders.push(rect(sx * (BX - 2.2), sz * (BZ - 9), 2.2, 5.4));
    }

    // along the four kerbs
    const runs: { axis: 'x' | 'z'; c: number; from: number; to: number; ave: boolean }[] = [
      { axis: 'x', c: -edgeZ, from: -BX + 4, to: BX - 4, ave: false },
      { axis: 'x', c: edgeZ, from: -BX + 4, to: BX - 4, ave: false },
      { axis: 'z', c: -edgeX, from: -BZ + 4, to: BZ - 4, ave: true },
      { axis: 'z', c: edgeX, from: -BZ + 4, to: BZ - 4, ave: true },
    ];
    for (const run of runs) {
      const P = (t: number) => (run.axis === 'x' ? [t, run.c] : [run.c, t]) as [number, number];
      // street lights
      for (let t = run.from + 3; t < run.to; t += 26) {
        const [x, z] = P(t);
        if (near(x, z)) continue;
        lampPost(stat, group, x, z, run.axis, run.c > 0 ? 1 : -1);
        colliders.push(rect(x, z, 0.4, 0.4));
      }
      // street trees
      if (!run.ave && (village || tower < 0.6)) {
        for (let t = run.from + 9; t < run.to - 3; t += rng.range(8, 11)) {
          const [x, z] = P(t);
          if (near(x, z, 2.6)) continue;
          tree(stat, x, z, rng);
          colliders.push(rect(x, z, 0.5, 0.5));
        }
      }
      // hydrant, newspaper boxes, steam pipe
      {
        const [x, z] = P(rng.range(run.from + 4, run.to - 4));
        if (!near(x, z)) {
          hydrant(stat, x, z);
          colliders.push(rect(x, z, 0.4, 0.4));
        }
      }
      if (rng.chance(0.4)) {
        const [x, z] = P(rng.range(run.from + 2, run.to - 2));
        if (!near(x, z)) for (let k = 0; k < 3; k++) {
          const ox = run.axis === 'x' ? k * 0.55 : 0, oz = run.axis === 'z' ? k * 0.55 : 0;
          B(stat, mat(['#c4161c', '#1e4fa3', '#f0b400'][k], { rough: 0.6 }), 0.45, 1.05, 0.45, x + ox, CURB, z + oz);
        }
      }
      if (run.ave && rng.chance(0.35)) {
        // steam stack in the avenue
        const [x, z] = P(rng.range(run.from, run.to));
        const ax = run.axis === 'z' ? x + Math.sign(x) * 3.5 : x;
        const az = run.axis === 'x' ? z + Math.sign(z) * 3 : z;
        const sm = mat('#f07a1e', { rough: 0.6 });
        const wm = mat('#f2f2f2', { rough: 0.6 });
        for (let k = 0; k < 6; k++) C(stat, k % 2 ? wm : sm, 0.35, 0.5, ax, k * 0.5, az);
        colliders.push(rect(ax, az, 0.8, 0.8));
        for (let k = 0; k < 3; k++) {
          const s = glow('#ffffff', 1.5, ax, 3, az, 0.4);
          (s.material as THREE.SpriteMaterial).blending = THREE.NormalBlending;
          s.material = (s.material as THREE.SpriteMaterial).clone();
          s.userData.ph = k / 3;
          s.userData.y = 3;
          group.add(s);
          this.steam.push(s);
        }
      }
      // parked cars on streets (and sand3d vehicles you can shrink into)
      const lane = run.axis === 'x' ? (BZ + 1.15) * Math.sign(run.c) : (BX + 1.15) * Math.sign(run.c);
      for (let t = run.from + 4; t < run.to - 4; t += rng.range(6.5, 9)) {
        if (!rng.chance(run.ave ? 0.35 : 0.55)) continue;
        const x = run.axis === 'x' ? t : lane;
        const z = run.axis === 'x' ? lane : t;
        if (rng.chance(0.18)) {
          const e = pickModel('vehicle', rng);
          if (e && Math.max(e.size[0], e.size[2]) * normScale(e) < 7) {
            this.parkedModel(ctx, e, x, z, run.axis);
            t += 2;
            continue;
          }
        }
        const car = carMesh(rng.chance(0.15) ? 'cab' : 'sedan', rng);
        car.position.set(x, 0, z);
        car.rotation.y = (run.axis === 'x' ? Math.PI / 2 : 0) + (rng.chance(0.5) ? Math.PI : 0);
        stat.add(car);
        colliders.push(run.axis === 'x' ? rect(x, z, 4.6, 1.9) : rect(x, z, 1.9, 4.6));
      }
    }
    // a few sand3d props on the sidewalks (benches, planters, statues) — all enterable worlds
    for (let i = 0; i < 3; i++) {
      const run = rng.pick(runs);
      const t = rng.range(run.from + 3, run.to - 3);
      const x = run.axis === 'x' ? t : run.c - Math.sign(run.c) * 0.6;
      const z = run.axis === 'x' ? run.c - Math.sign(run.c) * 0.6 : t;
      if (near(x, z, 3)) continue;
      const role = rng.pick(['bench', 'streetprop', 'plant']);
      const e = pickModel(role, rng);
      if (!e) continue;
      const s = normScale(e);
      const sp = spawn(e, s);
      if (Math.max(sp.size.x, sp.size.z) > 2.6) continue;
      sp.obj.position.set(x, CURB, z);
      sp.obj.rotation.y = run.axis === 'x' ? 0 : Math.PI / 2;
      group.add(sp.obj);
      colliders.push(rect(x, z, Math.min(sp.size.x, 1.2), Math.min(sp.size.z, 1.2)));
      ctx.portals.push(objectPortal(e, x, z, sp.size, ctx.seed + i));
    }
  }

  private parkedModel(ctx: Ctx, e: ModelEntry, x: number, z: number, axis: 'x' | 'z') {
    const sp = spawn(e);
    const longX = sp.size.x >= sp.size.z;
    const rot = axis === 'x' ? (longX ? 0 : Math.PI / 2) : longX ? Math.PI / 2 : 0;
    sp.obj.position.set(x, 0, z);
    sp.obj.rotation.y = rot;
    ctx.group.add(sp.obj);
    const L = Math.max(sp.size.x, sp.size.z), Wd = Math.min(sp.size.x, sp.size.z);
    ctx.colliders.push(axis === 'x' ? rect(x, z, L, Wd) : rect(x, z, Wd, L));
    ctx.portals.push(objectPortal(e, x, z, new THREE.Vector3(axis === 'x' ? L : Wd, sp.size.y, axis === 'x' ? Wd : L), ctx.seed + Math.round(x * 7)));
  }
}

type BType = 'brownstone' | 'tenement' | 'prewar' | 'midrise' | 'tower' | 'castiron';
interface Ctx {
  rng: Rng;
  group: THREE.Group;
  stat: THREE.Group;
  colliders: Rect[];
  portals: Portal[];
  cx: number;
  cz: number;
  seed: number;
  doors: THREE.Vector3[];
}

function objectPortal(e: ModelEntry, x: number, z: number, size: THREE.Vector3, seed: number): Portal {
  const r = new Rng(hashN(seed, 77));
  const biomes = ['town', 'toyland', 'candy', 'neon', 'snow', 'desert', 'circuit', 'metropolis'];
  return {
    box: new THREE.Box3(new THREE.Vector3(x - size.x / 2 - 0.15, 0, z - size.z / 2 - 0.15), new THREE.Vector3(x + size.x / 2 + 0.15, size.y + 0.2, z + size.z / 2 + 0.15)),
    label: `Shrink into “${e.title}”`,
    sub: `${e.role} · by ${e.author ?? 'unknown'} — a whole world inside`,
    target: { kind: 'city', seed: r.int(0, 2 ** 31), biome: r.pick(biomes), name: `Inside “${e.title}”`, source: e, sourceScale: Math.max(size.x, size.y, size.z) },
    shrink: Math.max(size.x, size.y, size.z),
  };
}

function dirSign(front: Side) {
  // local +x of a front-facing group maps to world +along for S/E, -along for N/W
  return front === 'N' || front === 'E' ? -1 : 1;
}

function titleCaseName(s: string) {
  return s.toLowerCase().replace(/(^|[\s&-])(\w)/g, (_, a, b) => a + b.toUpperCase());
}

function shade(hex: string, f: number) {
  return `#${new THREE.Color(hex).multiplyScalar(f).getHexString()}`;
}

function rectAround(p: THREE.Vector3, w: number, d: number): Rect {
  return rect(p.x, p.z, w, d);
}

function placeLocal(o: THREE.Object3D, at: THREE.Vector3, rot: number) {
  const g = new THREE.Group();
  g.position.copy(at);
  g.rotation.y = rot;
  g.add(o);
  return g;
}

function roof(parent: THREE.Object3D, r: Rect, y: number) {
  const g = new THREE.PlaneGeometry(r.maxX - r.minX, r.maxZ - r.minZ);
  const o = new THREE.Mesh(g, M.tar());
  o.rotation.x = -Math.PI / 2;
  o.position.set((r.minX + r.maxX) / 2, y, (r.minZ + r.maxZ) / 2);
  parent.add(o);
}

/** horizontal band along one side: cornices, parapets, belt courses */
function ledge(parent: THREE.Object3D, m: THREE.Material, r: Rect, s: Side, y: number, h: number, out: number) {
  const alongX = s === 'N' || s === 'S';
  const len = (alongX ? r.maxX - r.minX : r.maxZ - r.minZ) + Math.max(0, out) * 2;
  const d = Math.abs(out) + 0.25;
  const off = out >= 0 ? out / 2 : out / 2 - 0.12;
  if (s === 'N') B(parent, m, len, h, d, (r.minX + r.maxX) / 2, y, r.minZ - off);
  if (s === 'S') B(parent, m, len, h, d, (r.minX + r.maxX) / 2, y, r.maxZ + off);
  if (s === 'E') B(parent, m, d, h, len, r.maxX + off, y, (r.minZ + r.maxZ) / 2);
  if (s === 'W') B(parent, m, d, h, len, r.minX - off, y, (r.minZ + r.maxZ) / 2);
}

function waterTower(parent: THREE.Object3D, x: number, y: number, z: number) {
  const w = M.wood(), iron = M.iron();
  for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) B(parent, iron, 0.15, 2.4, 0.15, x + lx, y, z + lz);
  B(parent, iron, 2.4, 0.15, 2.4, x, y + 2.3, z);
  C(parent, w, 1.4, 3.4, x, y + 2.4, z);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(1.55, 1.3, 12), w);
  cone.position.set(x, y + 2.4 + 3.4 + 0.65, z);
  cone.castShadow = true;
  parent.add(cone);
  for (let k = 0; k < 3; k++) C(parent, iron, 1.43, 0.06, x, y + 2.8 + k * 1.1, z, false);
}

function fireEscape(parent: THREE.Object3D, r: Rect, front: Side, ground: number, floors: number, fh: number, rng: Rng) {
  const iron = M.iron();
  const alongX = front === 'N' || front === 'S';
  const len = alongX ? r.maxX - r.minX : r.maxZ - r.minZ;
  const w = Math.min(len - 1, rng.range(3.5, 6));
  const c = alongX ? (r.minX + r.maxX) / 2 : (r.minZ + r.maxZ) / 2;
  const [nx, nz] = NORMAL[front];
  const line = front === 'N' ? r.minZ : front === 'S' ? r.maxZ : front === 'E' ? r.maxX : r.minX;
  const g = new THREE.Group();
  for (let f = 1; f < floors; f++) {
    const y = ground + (f - 1) * fh - 0.1;
    B(g, iron, w, 0.06, 1.1, 0, y, 0.55, true);
    B(g, iron, w, 0.05, 0.05, 0, y + 1.0, 1.08, false);
    B(g, iron, w, 0.04, 0.04, 0, y + 0.5, 1.08, false);
    for (let k = 0; k <= 6; k++) B(g, iron, 0.03, 1.0, 0.03, -w / 2 + (k * w) / 6, y, 1.08, false);
    if (f < floors - 1) {
      const lad = B(g, iron, 0.55, 0.05, Math.hypot(w * 0.6, fh), (f % 2 ? 1 : -1) * w * 0.05, y + fh / 2, 0.8, false);
      lad.rotation.set(0, 0, 0);
      lad.rotation.z = 0;
      lad.scale.set(Math.hypot(w * 0.6, fh), 0.05, 0.5);
      lad.rotation.z = (f % 2 ? 1 : -1) * Math.atan2(fh, w * 0.6);
    }
  }
  g.position.set(alongX ? c : line + nx * 0.01, 0, alongX ? line + nz * 0.01 : c);
  g.rotation.y = { S: 0, N: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 }[front];
  parent.add(g);
}

function signalPole(parent: THREE.Object3D, x: number, z: number, sx: number, sz: number) {
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

const nameSignCache = new Map<string, THREE.MeshStandardMaterial>();
function nameSign(text: string, x: number, y: number, z: number, rotY: number) {
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

function lampPost(parent: THREE.Object3D, group: THREE.Group, x: number, z: number, axis: 'x' | 'z', side: number) {
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

function tree(parent: THREE.Object3D, x: number, z: number, rng: Rng) {
  B(parent, mat('#3b3027', { rough: 1 }), 1.2, 0.02, 1.2, x, CURB, z, false);
  B(parent, M.iron(), 1.25, 0.25, 0.04, x, CURB, z - 0.6, false);
  B(parent, M.iron(), 1.25, 0.25, 0.04, x, CURB, z + 0.6, false);
  const h = rng.range(3.5, 5.5);
  C(parent, M.bark(), 0.13, h, x, CURB, z);
  const n = rng.int(4, 6);
  for (let i = 0; i < n; i++) {
    const s = new THREE.Mesh(unitSphere, i % 2 ? M.leaf() : M.leaf2());
    const r = rng.range(1.3, 2.1);
    s.scale.set(r * 1.2, r, r * 1.2);
    s.position.set(x + rng.range(-1, 1), CURB + h + rng.range(-0.3, 1.4), z + rng.range(-1, 1));
    s.castShadow = true;
    parent.add(s);
  }
}

function hydrant(parent: THREE.Object3D, x: number, z: number) {
  const m = mat(Math.abs(x + z) % 2 < 1 ? '#c4161c' : '#e0b21a', { rough: 0.5 });
  C(parent, m, 0.16, 0.65, x, CURB, z);
  C(parent, m, 0.2, 0.08, x, CURB + 0.65, z);
  const top = new THREE.Mesh(unitSphere, m);
  top.scale.setScalar(0.3);
  top.position.set(x, CURB + 0.76, z);
  parent.add(top);
  B(parent, m, 0.5, 0.1, 0.1, x, CURB + 0.42, z);
}

function subway(parent: THREE.Object3D, group: THREE.Group, x: number, z: number, cz: number, rng: Rng) {
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

const carCache = new Map<string, THREE.Group>();
const CAR_COLORS = ['#1c1c1e', '#e8e8e8', '#7a8590', '#2a3f66', '#7a1d1d', '#3a4a3a', '#b8b8b8', '#4a3a2a'];
function carMesh(kind: 'cab' | 'sedan' | 'bus', rng: Rng): THREE.Group {
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
    B(g, body, 1.8, 0.7, 4.6, 0, 0.35, 0);
    B(g, glass, 1.6, 0.55, 2.4, 0, 1.05, 0.15, false);
    B(g, body, 1.62, 0.06, 2.0, 0, 1.6, 0.2, false);
    B(g, mat('#fff6d0', { emissive: '#fff2c0', ei: 0.8 }), 1.4, 0.12, 0.04, 0, 0.75, -2.31, false);
    B(g, mat('#a01010', { emissive: '#ff2020', ei: 0.6 }), 1.4, 0.12, 0.04, 0, 0.75, 2.31, false);
    for (const z of [-1.45, 1.45]) for (const x of [-0.85, 0.85]) {
      const w = C(g, black, 0.33, 0.24, x, 0, z, false);
      w.rotation.z = Math.PI / 2;
      w.position.y = 0.33;
    }
    if (kind === 'cab') {
      B(g, mat('#ffffff', { emissive: '#fff4c0', ei: 0.6 }), 0.8, 0.28, 0.25, 0, 1.66, 0.2, false);
      B(g, black, 1.82, 0.1, 1.2, 0, 0.62, 0.3, false);
    }
  }
  const baked = bake(g);
  // these baked meshes are shared by every clone
  baked.traverse((o) => (o.userData.owned = false));
  carCache.set(key, baked);
  return baked.clone();
}

interface Car {
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

class Traffic {
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

const SKIN = ['#f1c9a5', '#d9a77e', '#a8714a', '#7a4a2a', '#5a3620', '#e8b996'];
const CLOTH = ['#1c1c1e', '#2a3f66', '#7a1d1d', '#e8e8e8', '#4a5a3a', '#b8946a', '#5a2a5a', '#c46a2a', '#3a3a44', '#d6c8a8'];
const pedGeo = {
  torso: new THREE.CylinderGeometry(0.2, 0.17, 0.62, 8),
  head: new THREE.IcosahedronGeometry(0.12, 1),
  limb: new THREE.BoxGeometry(0.12, 0.8, 0.13),
  arm: new THREE.BoxGeometry(0.09, 0.62, 0.09),
};
interface Ped {
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
class Pedestrians {
  peds: Ped[] = [];
  private rng: Rng;
  constructor(private group: THREE.Group, seed: number) {
    this.rng = new Rng(hashN(seed, 909));
  }
  private make(): Ped {
    const r = this.rng;
    const g = new THREE.Group();
    const skin = mat(r.pick(SKIN), { rough: 0.7 });
    const top = mat(r.pick(CLOTH), { rough: 0.85 });
    const bottom = mat(r.pick(CLOTH), { rough: 0.85 });
    const h = r.range(0.92, 1.08);
    const torso = new THREE.Mesh(pedGeo.torso, top);
    torso.position.y = 1.15;
    const head = new THREE.Mesh(pedGeo.head, skin);
    head.position.y = 1.6;
    g.add(torso, head);
    if (r.chance(0.3)) {
      const hat = new THREE.Mesh(pedGeo.head, mat(r.pick(CLOTH)));
      hat.scale.set(1.05, 0.5, 1.05);
      hat.position.y = 1.67;
      g.add(hat);
    }
    const legs: THREE.Object3D[] = [], arms: THREE.Object3D[] = [];
    for (const s of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(s * 0.09, 0.84, 0);
      const leg = new THREE.Mesh(pedGeo.limb, bottom);
      leg.position.y = -0.4;
      hip.add(leg);
      g.add(hip);
      legs.push(hip);
      const sh = new THREE.Group();
      sh.position.set(s * 0.25, 1.42, 0);
      const arm = new THREE.Mesh(pedGeo.arm, top);
      arm.position.y = -0.3;
      sh.add(arm);
      g.add(sh);
      arms.push(sh);
    }
    g.scale.setScalar(h);
    torso.castShadow = true;
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
      pd.arms[0].rotation.x = -s * 0.8;
      pd.arms[1].rotation.x = s * 0.8;
      pd.g.position.set(pd.axis === 'x' ? pd.t : pd.line, CURB + Math.abs(Math.cos(pd.ph)) * 0.03, pd.axis === 'x' ? pd.line : pd.t);
    }
  }
}
