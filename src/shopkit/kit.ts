import * as THREE from 'three';
import type { Rect } from '../level';
import { mat } from '../build';
import type { Surf } from './tex';

/**
 * Where products go. Everything is in world space.
 *  - shelf:  fronted rows on a shelf; p is the centre of the shelf's front edge, the shelf runs
 *            `len` along the right-hand vector and `depth` back from the front; `h` is the clearance
 *  - hang:   on hooks against a wall/pegboard; p is the bottom centre on the board's surface
 *  - pile:   heaped in a bin / on a table, jumbled; p as for shelf
 *  - stack:  cases stacked in a neat block on the floor; p as for shelf
 *  - single: one item standing in the area (showroom pieces)
 *  - ceil:   hanging from the ceiling (lamps); p is the ceiling point
 */
export interface Container {
  id: number;
  /** anchor at the front-centre of its base, +z out of the front (level coordinates) */
  obj: THREE.Group;
  /** outer width / height / depth */
  size: THREE.Vector3;
  /** glass-fronted: contents visible while closed (generated when near and facing) */
  glass: boolean;
  label: string;
  /** opaque containers: the part that moves */
  door?: THREE.Object3D;
  drawer?: THREE.Object3D;
  /** custom pose, t 0 closed .. 1 open (e.g. a pair of doors) */
  open?: (t: number) => void;
}
export type SegMode = 'shelf' | 'hang' | 'pile' | 'stack' | 'single' | 'ceil';
export interface Seg {
  p: THREE.Vector3;
  rot: number;
  len: number;
  depth: number;
  h: number;
  mode: SegMode;
  /** preferred products (title / entry match) */
  want?: RegExp;
  /** accepts items bigger than the area (shrunk only a little) */
  big?: boolean;
  /** 0..1: how untidy */
  messy?: number;
  maxRows?: number;
  /** one of each, at least this far apart (antiques, guitars on hooks) */
  pitch?: number;
  /** inside container n (kit.containers): stocked only when that container is generated */
  box?: number;
}

/** a flat quad whose UVs repeat a texture every `tile` metres */
export function quad(m: THREE.Material, w: number, h: number, tile: [number, number] = [w, h]) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / tile[0], (uv.getY(i) * h) / tile[1]);
  const mesh = new THREE.Mesh(g, m);
  mesh.userData.owned = true;
  mesh.receiveShadow = true;
  return mesh;
}

const surfMats = new Map<string, THREE.MeshStandardMaterial>();
/** a material for a canvas Surf, tinted, with its normal map */
export function surfMat(s: Surf, opts: { color?: string; rough?: number; metal?: number; ns?: number; emissive?: string; ei?: number } = {}) {
  const key = `${s.map.uuid}|${opts.color}|${opts.rough}|${opts.metal}|${opts.ns}|${opts.emissive}|${opts.ei}`;
  let m = surfMats.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: s.map, normalMap: s.normal ?? null, color: opts.color ?? '#ffffff', roughness: opts.rough ?? 0.85, metalness: opts.metal ?? 0 });
    if (s.normal) m.normalScale.setScalar(opts.ns ?? 1);
    if (opts.emissive) {
      m.emissive.set(opts.emissive);
      m.emissiveIntensity = opts.ei ?? 1;
      m.emissiveMap = s.map;
    }
    surfMats.set(key, m);
  }
  return m;
}

const basicMats = new Map<string, THREE.Material>();
/** unlit textured material (signs, screens, boards) */
export function lit(t: THREE.Texture, opts: { transparent?: boolean; tint?: string } = {}) {
  const key = `${t.uuid}|${opts.transparent}|${opts.tint}`;
  let m = basicMats.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ map: t, transparent: !!opts.transparent, color: opts.tint ?? '#ffffff', toneMapped: true });
    basicMats.set(key, m);
  }
  return m;
}
/** textured but lit by the scene (posters, packs on a rack) */
export function printed(t: THREE.Texture, opts: { transparent?: boolean; rough?: number; emissive?: number } = {}) {
  const key = `p|${t.uuid}|${opts.transparent}|${opts.rough}|${opts.emissive}`;
  let m = basicMats.get(key) as THREE.MeshStandardMaterial | undefined;
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: t, transparent: !!opts.transparent, roughness: opts.rough ?? 0.6 });
    if (opts.emissive) {
      m.emissive.set('#ffffff');
      m.emissiveMap = t;
      m.emissiveIntensity = opts.emissive;
    }
    basicMats.set(key, m);
  }
  return m;
}

let glassM: THREE.MeshPhysicalMaterial | null = null;
export function glass() {
  glassM ??= new THREE.MeshPhysicalMaterial({ color: '#dfe9ee', roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16, depthWrite: false, envMapIntensity: 1.2 });
  return glassM;
}

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
const unitSph = new THREE.SphereGeometry(0.5, 14, 10);

/**
 * Builds fixtures in a local frame (front faces +z) placed at (x, z) turned by rot, and
 * records the world-space colliders and product segments they make.
 */
export class Kit {
  /** static geometry, baked into a few meshes at the end */
  stat = new THREE.Group();
  /** things that must stay separate (transparent glass, lights) */
  live = new THREE.Group();
  cols: Rect[] = [];
  segs: Seg[] = [];
  lights: THREE.Light[] = [];
  private frame = new THREE.Group();
  private rot = 0;

  /** start a fixture at (x, z) facing rot (0 = +z) */
  at(x: number, z: number, rot = 0, y = 0) {
    this.frame = new THREE.Group();
    this.frame.position.set(x, y, z);
    this.frame.rotation.y = rot;
    this.frame.updateMatrix();
    this.frame.updateMatrixWorld(true);
    this.rot = rot;
    this.stat.add(this.frame);
    return this;
  }
  /** local -> world point */
  w(x: number, y: number, z: number) {
    return new THREE.Vector3(x, y, z).applyMatrix4(this.frame.matrix);
  }
  add(o: THREE.Object3D, live = false) {
    if (live) {
      // live objects are parented directly so they keep their own materials and order
      o.applyMatrix4(this.frame.matrix);
      this.live.add(o);
    } else this.frame.add(o);
    return o;
  }
  box(m: THREE.Material, w: number, h: number, d: number, x = 0, y = 0, z = 0, shadow = false) {
    const o = new THREE.Mesh(unitBox, m);
    o.scale.set(w, h, d);
    o.position.set(x, y + h / 2, z);
    o.castShadow = shadow;
    o.receiveShadow = true;
    this.frame.add(o);
    return o;
  }
  cyl(m: THREE.Material, r: number, h: number, x = 0, y = 0, z = 0, axis: 'y' | 'x' | 'z' = 'y') {
    const o = new THREE.Mesh(unitCyl, m);
    o.scale.set(r * 2, h, r * 2);
    o.position.set(x, y + (axis === 'y' ? h / 2 : 0), z);
    if (axis === 'x') o.rotation.z = Math.PI / 2;
    if (axis === 'z') o.rotation.x = Math.PI / 2;
    o.receiveShadow = true;
    this.frame.add(o);
    return o;
  }
  sph(m: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0) {
    const o = new THREE.Mesh(unitSph, m);
    o.scale.set(sx, sy, sz);
    o.position.set(x, y, z);
    this.frame.add(o);
    return o;
  }
  /** a textured quad facing +z (local), bottom-left anchored at its centre */
  face(m: THREE.Material, w: number, h: number, x: number, y: number, z: number, tile?: [number, number], ry = 0, live = false) {
    const q = quad(m, w, h, tile);
    q.position.set(x, y, z);
    q.rotation.y = ry;
    if (live) {
      q.updateMatrix();
      q.applyMatrix4(this.frame.matrix);
      this.live.add(q);
    } else this.frame.add(q);
    return q;
  }
  /** a collider for the local rect centred (x, z), w x d */
  col(x: number, z: number, w: number, d: number) {
    const a = this.w(x - w / 2, 0, z - d / 2), b = this.w(x + w / 2, 0, z + d / 2);
    this.cols.push({ minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) });
  }
  /** a product segment, local front-edge centre (x, y, z), facing local +z turned by r */
  seg(mode: SegMode, x: number, y: number, z: number, len: number, depth: number, h: number, more: Partial<Seg> = {}, r = 0) {
    this.segs.push({ p: this.w(x, y, z), rot: this.rot + r, len, depth, h, mode, ...more, ...(this.cur >= 0 ? { box: this.cur } : {}) });
  }
  /**
   * Containers (coolers, showcases, curio cabinets, deli cases, drawers, cupboards): the
   * segments made between openBox() and closeBox() belong to it, and its stock is only
   * generated on demand (lazy.ts registerContainer). (fx, fz): local front-centre of its base;
   * size along local x, y, z.
   */
  containers: Container[] = [];
  private cur = -1;
  openBox(fx: number, fz: number, sx: number, sy: number, sz: number, label: string, glass = true, fy = 0) {
    const obj = new THREE.Group();
    obj.position.set(fx, fy, fz);
    this.add(obj, true);
    obj.updateMatrix();
    this.containers.push({ id: this.containers.length, obj, size: new THREE.Vector3(sx, sy, sz), glass, label });
    this.cur = this.containers.length - 1;
    return this.containers[this.cur];
  }
  closeBox() {
    this.cur = -1;
  }
  light(l: THREE.Light, x: number, y: number, z: number) {
    l.position.copy(this.w(x, y, z));
    this.live.add(l);
    this.lights.push(l);
    return l;
  }
}

export const M = {
  steel: () => mat('#c9ccd0', { rough: 0.35, metal: 0.8 }),
  chrome: () => mat('#e4e6ea', { rough: 0.15, metal: 1 }),
  black: () => mat('#1c1d1f', { rough: 0.5, metal: 0.3 }),
  dark: () => mat('#2a2b2e', { rough: 0.6 }),
  white: () => mat('#f1f0ec', { rough: 0.5 }),
  cardboard: () => mat('#b08a5a', { rough: 0.9 }),
  emit: (c = '#ffffff', ei = 2) => mat('#ffffff', { emissive: c, ei }),
};
