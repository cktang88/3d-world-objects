import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { AX, SZ, AVE, ST, SW, BX, BZ, LX, LZ, CURB, RX, RZ, avenueName, streetName, bake, unitBox, unitCyl, unitSphere, B, C, NORMAL, canvasTex, M, SIG, lightFor, type Side } from './nyc/common';
import { signalPole, nameSign, lampPost, tree, hydrant, subway } from './nyc/streetprops';
import { litWindows, wetSurface } from './lighting';
import { carMesh, Traffic } from './nyc/vehicles';
import { Pedestrians } from './nyc/people';
export { avenueName, streetName };
import { Rng, hashN } from './rng';
import { pickModel, spawn, normScale, type ModelEntry } from './assets';
import { mat, glow } from './build';
import { facade, signTex, type FacadeStyle } from './textures';
import { surface, pbr } from './pbr';
import type { Env, Level, LevelDesc, Portal, Rect } from './level';
import { disposeTree, rect } from './level';
import { BIOMES } from './biomes';

// Manhattan-ish proportions: long blocks east-west, short north-south

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
const facadeMats = new Map<string, THREE.MeshStandardMaterial>();
const FACADE_PBR: Partial<Record<FacadeStyle, string[]>> = {
  brick: ['nyc_brick', 'nyc_brick2'], prewar: ['nyc_limestone', 'nyc_brick'], brownstone: ['nyc_brownstone'], castiron: ['nyc_castiron'], panel: ['nyc_panel'],
};
/** facades: real brick, brownstone and limestone, tinted per building (wall UVs are in 12 m x 12.8 m units) */
function facadeMat(style: FacadeStyle, seed: number) {
  const pk = FACADE_PBR[style];
  if (pk) return surface(pk[seed % pk.length], [12, 12.8], { vertexColors: true, roughness: 1, normalScale: 1.4, envMapIntensity: 0.4 });
  const key = `${style}:${seed}`;
  let m = facadeMats.get(key);
  if (!m) {
    const glass = style === 'glass';
    // masonry walls carry no painted windows: real 3D windows are instanced on top
    const fac = facade(style, '#d9d9d9', 0.12, seed + 40, { windows: glass });
    m = new THREE.MeshStandardMaterial({
      map: fac.map,
      normalMap: glass ? null : fac.normal,
      normalScale: new THREE.Vector2(1.2, 1.2),
      vertexColors: true,
      roughness: glass ? 0.08 : 0.88,
      metalness: glass ? 0.75 : 0,
      envMapIntensity: glass ? 1.4 : 0.6,
    });
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
  const r = new Rng(hashN(seed % 4, type.length * 31 + type.charCodeAt(0)));
  const W = 1024, H = 768;
  t = canvasTex(W, H, (g) => {
    // warm interior falling off into depth
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#fff6e2');
    grad.addColorStop(0.6, '#e9cf9e');
    grad.addColorStop(1, '#8a6a44');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    // a smaller row of shelves further back in the shop
    g.globalAlpha = 0.45;
    for (let y = 120; y < H - 120; y += 90) {
      g.fillStyle = '#6b5136';
      g.fillRect(140, y, W - 280, 5);
      for (let x = 150; x < W - 150; x += 14 + r.int(0, 10)) {
        g.fillStyle = `hsl(${r.int(0, 360)},${r.int(30, 70)}%,${r.int(35, 70)}%)`;
        const h = 20 + r.int(0, 40);
        g.fillRect(x, y - h, 10 + r.int(0, 8), h);
      }
    }
    g.globalAlpha = 1;
    // front display shelves with products of different shapes
    const palette = ['#c0392b', '#27ae60', '#2980b9', '#f1c40f', '#e67e22', '#8e44ad', '#ecf0f1', '#2c3e50', '#16a085', '#d35400', '#7f8c8d'];
    for (let y = 230; y < H; y += 175) {
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(0, y + 10, W, 18);
      g.fillStyle = '#7a5a36';
      g.fillRect(0, y, W, 12);
      g.fillStyle = '#a07a4a';
      g.fillRect(0, y, W, 3);
      let x = 12;
      while (x < W - 40) {
        const kind = r.int(0, 2);
        const col = r.pick(palette);
        const w = kind === 0 ? 34 + r.int(0, 20) : kind === 1 ? 26 : 50 + r.int(0, 40);
        const h = kind === 0 ? 90 + r.int(0, 50) : kind === 1 ? 110 + r.int(0, 30) : 60 + r.int(0, 50);
        const n = r.int(2, 4);
        for (let k = 0; k < n && x < W - 40; k++) {
          const top = y - h;
          g.fillStyle = col;
          if (kind === 1) {
            // bottle
            g.beginPath();
            g.roundRect(x, top + 30, w, h - 30, 6);
            g.fill();
            g.fillRect(x + w * 0.35, top + 5, w * 0.3, 30);
            g.fillStyle = '#f5f0e6';
            g.fillRect(x + 2, top + 55, w - 4, 26);
          } else if (kind === 2) {
            // can or jar
            g.beginPath();
            g.roundRect(x, top, w, h, 10);
            g.fill();
            g.fillStyle = 'rgba(255,255,255,0.8)';
            g.fillRect(x + 4, top + h * 0.35, w - 8, h * 0.3);
          } else {
            // box with a label
            g.fillRect(x, top, w, h);
            g.fillStyle = 'rgba(255,255,255,0.85)';
            g.fillRect(x + 4, top + 10, w - 8, 14);
            g.fillStyle = 'rgba(0,0,0,0.25)';
            g.fillRect(x + w - 6, top, 6, h);
          }
          g.fillStyle = 'rgba(255,255,255,0.22)';
          g.fillRect(x + 3, top + 4, 4, h - 10);
          x += w + 4;
        }
        // price tag
        g.fillStyle = '#fffbe0';
        g.fillRect(x - 40, y + 14, 34, 16);
        g.fillStyle = '#c0392b';
        g.font = 'bold 12px system-ui';
        g.fillText('$' + r.int(1, 49) + '.' + r.pick(['99', '49', '29']), x - 38, y + 27);
        x += 10 + r.int(0, 20);
      }
    }
    if (r.chance(0.7)) {
      g.fillStyle = 'rgba(20,0,0,0.6)';
      g.beginPath();
      g.roundRect(W - 230, 30, 190, 70, 14);
      g.fill();
      g.strokeStyle = '#ff3b3b';
      g.lineWidth = 5;
      g.stroke();
      g.fillStyle = '#ff5050';
      g.font = 'bold 50px system-ui';
      g.fillText('OPEN', W - 200, 85);
    }
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.font = '18px system-ui';
    g.fillText(r.pick(['WE ACCEPT ALL MAJOR CREDIT CARDS', 'ATM INSIDE', 'OPEN 7 DAYS', 'EST. 1962', 'FREE DELIVERY']), 30, 40);
    // reflections on the glass
    const rg = g.createLinearGradient(0, 0, W, H);
    rg.addColorStop(0, 'rgba(255,255,255,0.28)');
    rg.addColorStop(0.35, 'rgba(255,255,255,0.0)');
    rg.addColorStop(0.55, 'rgba(255,255,255,0.12)');
    rg.addColorStop(0.62, 'rgba(255,255,255,0.0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, W, H);
    void type;
  });
  windowTexCache.set(key, t);
  return t;
}



// ---------------------------------------------------------------- materials

let roadMaterial: THREE.MeshStandardMaterial | null = null;
/** road markings from the canvas; surface relief and roughness from photo-scanned asphalt */
function roadMat() {
  if (roadMaterial) return roadMaterial;
  const m = new THREE.MeshStandardMaterial({ map: nycRoadTex(), roughness: 1 });
  roadMaterial = m;
  wetSurface(m); // lighting.ts: wet sheen at night
  const p = pbr('nyc_asphalt');
  p?.ready.then(() => {
    const rep = (t: THREE.Texture | null) => {
      if (!t) return null;
      const c = t.clone();
      c.repeat.set(AX / p.tile[0], SZ / p.tile[1]);
      c.needsUpdate = true;
      return c;
    };
    m.normalMap = rep(p.nor);
    m.normalScale.setScalar(1.3);
    m.roughnessMap = rep(p.arm);
    m.needsUpdate = true;
  });
  return m;
}
/** a soft version of the wall colour, to tint photo textures without drowning them */
function softTint(hex: string) {
  const c = new THREE.Color(hex);
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  c.multiplyScalar(0.55 / Math.max(l, 0.05));
  return `#${new THREE.Color(1, 1, 1).lerp(c, 0.35).getHexString()}`;
}
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
      skyTop: '#5d8cc4', skyBottom: '#e9dcc8', stars: false, fog: '#aab6c2', fogNear: 110, fogFar: 420,
      sun: { color: '#ffd9a8', intensity: 4.2, elev: 30, azim: 235 }, hemi: { sky: '#cfdcec', ground: '#5a5046', intensity: 0.9 },
      ambient: 0.05, envIntensity: 0.55, exposure: 0.62, physicalSky: true,
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
    const road = new THREE.Mesh(new THREE.PlaneGeometry(AX, SZ), roadMat());
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

    const ctx: Ctx = { rng, group, stat, colliders, portals, cx, cz, seed: hashN(this.seed, cx, cz, 5), doors: [], windows: [] };

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
    // every window in the block: two instanced draws
    if (ctx.windows.length) {
      const { frame, glass } = windowGeo();
      const fi = new THREE.InstancedMesh(frame, windowMats().frame, ctx.windows.length);
      const gi = new THREE.InstancedMesh(glass, windowMats().glass, ctx.windows.length);
      ctx.windows.forEach((w, i) => {
        fi.setMatrixAt(i, w.m);
        gi.setMatrixAt(i, w.m);
        fi.setColorAt(i, w.frame);
        gi.setColorAt(i, w.glass);
      });
      fi.receiveShadow = gi.receiveShadow = true;
      fi.castShadow = true;
      fi.computeBoundingSphere();
      gi.computeBoundingSphere();
      group.add(fi, gi);
    }
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
        for (const s of sides) {
          wallQuad(stat, fm, rr, s, y, y + th, 12, 14.4, FACADE_PBR[style] ? softTint(wall) : wall);
          if (style !== 'glass') addWindows(ctx, rr, s, style, Math.max(y, ground), Math.floor((th - (y < ground ? ground : 0)) / 3.6), 3.6, new THREE.Color('#2a2e33'));
        }
        roof(stat, rr, y + th);
        y += th;
        const inset = rng.range(2, 4);
        rr = { minX: rr.minX + inset, maxX: rr.maxX - inset, minZ: rr.minZ + inset, maxZ: rr.maxZ - inset };
        if (rr.maxX - rr.minX < 6 || rr.maxZ - rr.minZ < 6) break;
      }
      if (rng.chance(0.5)) C(stat, M.iron(), 0.12, rng.range(8, 20), (rr.minX + rr.maxX) / 2, y, (rr.minZ + rr.maxZ) / 2);
    } else {
      const frameCol = new THREE.Color(rng.pick(type === 'brownstone' ? ['#2a1d16', '#e8e2d6', '#1d2a22'] : type === 'castiron' ? ['#1c1c1c', '#3a4a3a', '#e8e4da'] : ['#ece6da', '#1c1c1c', '#2f3b2f', '#6b3a2a', '#d8d0c0']));
      for (const s of sides) {
        const isFront = s === front;
        if (isFront || exposed(s)) {
          wallQuad(stat, fm, r, s, isFront ? ground : 0, h, 12, 12.8, FACADE_PBR[style] ? softTint(wall) : wall);
          addWindows(ctx, r, s, style, isFront || store ? ground : 0.6, floors - (isFront || store ? 1 : 0), fh, frameCol);
        }
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

// ---------------------------------------------------------------- windows

const WIN: Partial<Record<FacadeStyle, { w: number; h: number; bay: number; sill: number }>> = {
  brick: { w: 1.05, h: 1.62, bay: 2.3, sill: 0.85 },
  brownstone: { w: 1.0, h: 2.15, bay: 1.95, sill: 0.6 },
  prewar: { w: 1.15, h: 1.7, bay: 2.5, sill: 0.85 },
  castiron: { w: 2.1, h: 2.5, bay: 3.0, sill: 0.45 },
  panel: { w: 2.5, h: 1.35, bay: 3.0, sill: 1.0 },
};
let winGeo: { frame: THREE.BufferGeometry; glass: THREE.BufferGeometry } | null = null;
/** a unit window (1 wide, 1 tall, wall at z=0): jambs, head, mullion + transom, sill, lintel */
function windowGeo() {
  if (winGeo) return winGeo;
  const parts: THREE.BufferGeometry[] = [];
  const bx = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(g);
  };
  bx(0.07, 1, 0.12, -0.465, 0.5, 0.05); // jambs
  bx(0.07, 1, 0.12, 0.465, 0.5, 0.05);
  bx(1, 0.07, 0.12, 0, 0.965, 0.05); // head
  bx(1, 0.05, 0.1, 0, 0.035, 0.05); // bottom rail
  bx(0.035, 1, 0.07, 0, 0.5, 0.05); // mullion
  bx(1, 0.04, 0.07, 0, 0.56, 0.05); // meeting rail
  bx(1.18, 0.06, 0.24, 0, -0.03, 0.11); // sill
  bx(1.22, 0.11, 0.1, 0, 1.06, 0.05); // lintel
  const frame = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  const glass = new THREE.PlaneGeometry(0.93, 0.93);
  glass.translate(0, 0.5, 0.012);
  winGeo = { frame, glass };
  return winGeo;
}
let winMats: { frame: THREE.MeshStandardMaterial; glass: THREE.MeshStandardMaterial } | null = null;
function windowMats() {
  winMats ??= {
    frame: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.55 }),
    // dark, mirror-like panes that pick up the sky
    glass: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.05, metalness: 0.92, envMapIntensity: 1.3 }),
  };
  litWindows(winMats.glass); // lighting.ts: some panes glow at dusk/night
  return winMats;
}
const GLASS_TINTS = ['#2c3a46', '#33414d', '#26313a', '#3a4752', '#4a4e52', '#5c5446', '#2a3640'];
function addWindows(ctx: Ctx, r: Rect, side: Side, style: FacadeStyle, y0: number, floors: number, fh: number, frame: THREE.Color) {
  const spec = WIN[style];
  if (!spec || floors <= 0) return;
  const alongX = side === 'N' || side === 'S';
  const len = alongX ? r.maxX - r.minX : r.maxZ - r.minZ;
  const n = Math.floor((len - 0.8) / spec.bay);
  if (n <= 0) return;
  const a0 = (alongX ? r.minX : r.minZ) + (len - n * spec.bay) / 2 + spec.bay / 2;
  const line = side === 'N' ? r.minZ : side === 'S' ? r.maxZ : side === 'E' ? r.maxX : r.minX;
  const [nx, nz] = NORMAL[side];
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), { S: 0, N: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 }[side]);
  const scale = new THREE.Vector3(spec.w, spec.h, 1);
  for (let f = 0; f < floors; f++) {
    const y = y0 + f * fh + spec.sill;
    for (let i = 0; i < n; i++) {
      const a = a0 + i * spec.bay;
      const pos = alongX ? new THREE.Vector3(a, y, line + nz * 0.01) : new THREE.Vector3(line + nx * 0.01, y, a);
      const m = new THREE.Matrix4().compose(pos, q, scale);
      const g = new THREE.Color(ctx.rng.pick(GLASS_TINTS));
      if (ctx.rng.chance(0.12)) g.set(ctx.rng.pick(['#8a7a5c', '#9a8f7a', '#7a6a6a'])); // drawn blinds
      ctx.windows.push({ m, frame, glass: g });
    }
  }
}
interface WinInst {
  m: THREE.Matrix4;
  frame: THREE.Color;
  glass: THREE.Color;
}
interface Ctx {
  windows: WinInst[];
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
  // UVs in metres so one shared roofing material tiles correctly everywhere
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (r.maxX - r.minX), uv.getY(i) * (r.maxZ - r.minZ));
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
