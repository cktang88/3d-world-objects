import * as THREE from 'three';
import { B, C, M, bake, canvasTex, unitBox, unitCyl, unitSphere, avenueName, streetName, type Side } from './common';
import { mat } from '../build';
import { surface } from '../pbr';
import { facade, type FacadeStyle } from '../textures';
import { Rng, hashN } from '../rng';
import type { Portal, Rect } from '../level';
import { WindowBatch, dressWindow, REVEAL, type TrimKind, type SashKind } from './buildings-win';
import { ShopGlass, TextBatch, storefront } from './buildings-shop';
import { SW } from './common';

export { setNight } from './buildings-win';
export { SHOPS } from './buildings-shop';

/**
 * NYC buildings: brownstones, tenements, pre-war apartment houses, mid-rises, cast-iron lofts and
 * glass towers, built to the proportions in docs/research/nyc-architecture.md.
 *
 * Every facade is laid out in its own frame (u along the wall, y up, z out to the street) and its
 * wall is cut around real openings. Windows are instanced per block (buildings-win.ts); masonry,
 * cornices, stoops and fire escapes are merged by bake(). Small parts (brackets, dentils,
 * balusters, ladders, AC units, sashes) go to a separate "fine" group that is hidden on far blocks.
 */

export type BType = 'brownstone' | 'tenement' | 'prewar' | 'midrise' | 'tower' | 'castiron';

export interface BCtx {
  rng: Rng;
  group: THREE.Group;
  /** merged into a few meshes */
  stat: THREE.Group;
  /** merged separately: small details hidden at distance */
  fine: THREE.Group;
  colliders: Rect[];
  portals: Portal[];
  cx: number;
  cz: number;
  seed: number;
  doors: THREE.Vector3[];
  win: WindowBatch;
  shop: ShopGlass;
  text: TextBatch;
}

export function makeCtx(rng: Rng, group: THREE.Group, stat: THREE.Group, cx: number, cz: number, seed: number): BCtx {
  const fine = new THREE.Group();
  return { rng, group, stat, fine, colliders: [], portals: [], cx, cz, seed, doors: [], win: new WindowBatch(), shop: new ShopGlass(), text: new TextBatch() };
}

/** bake the block's buildings and add the instanced windows and shop glass */
export function finishBuildings(ctx: BCtx) {
  const fine = bake(ctx.fine);
  fine.name = 'fine';
  fine.userData.fine = true;
  ctx.win.build(ctx.group, fine);
  ctx.shop.build(ctx.group);
  ctx.text.build(ctx.group);
  ctx.group.add(fine);
  ctx.fine.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry !== unitBox && m.geometry !== unitCyl && m.geometry !== unitSphere) m.geometry.dispose();
  });
}

/** show or hide a block's small details (LOD) */
export function setBlockDetail(group: THREE.Object3D, on: boolean) {
  for (const c of group.children) if (c.userData.fine) c.visible = on;
}

// ---------------------------------------------------------------- materials

const FACADE_PBR: Partial<Record<FacadeStyle, string[]>> = {
  brick: ['nyc_brick', 'nyc_brick2'], prewar: ['nyc_brick', 'nyc_brick2'], brownstone: ['nyc_castiron'], castiron: ['nyc_castiron'], panel: ['nyc_panel'],
};
const TILE: [number, number] = [12, 12.8];
const facadeMats = new Map<string, THREE.MeshStandardMaterial>();
/** facades: real brick, brownstone and limestone, tinted per building (UVs in 12 m x 12.8 m units) */
function facadeMat(style: FacadeStyle, seed: number) {
  const pk = FACADE_PBR[style];
  if (pk) return surface(pk[seed % pk.length], TILE, { vertexColors: true, roughness: 1, normalScale: 1.4, envMapIntensity: 0.4 });
  const key = `${style}:${seed}`;
  let m = facadeMats.get(key);
  if (!m) {
    const fac = facade(style, '#d9d9d9', 0.12, seed + 40, { windows: true });
    m = new THREE.MeshStandardMaterial({ map: fac.map, vertexColors: true, roughness: 0.08, metalness: 0.75, envMapIntensity: 1.4 });
    facadeMats.set(key, m);
  }
  return m;
}
const stoneMat = () => surface('nyc_limestone', TILE, { vertexColors: true, roughness: 1, normalScale: 1.2, envMapIntensity: 0.4 });
const brownMat = () => surface('nyc_limestone', TILE, { vertexColors: true, roughness: 1, normalScale: 1.4, envMapIntensity: 0.4 });

function shade(hex: string, f: number) {
  return `#${new THREE.Color(hex).multiplyScalar(f).getHexString()}`;
}
/** a soft version of the wall colour, to tint photo textures without drowning them */
function softTint(hex: string, k = 0.35) {
  const c = new THREE.Color(hex);
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  c.multiplyScalar(0.55 / Math.max(l, 0.05));
  return `#${new THREE.Color(1, 1, 1).lerp(c, k).getHexString()}`;
}

/** a box with UVs in metres (for photo-textured stone), tinted through vertex colours */
function PB(parent: THREE.Object3D, m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, tint?: string, shadow = true) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++)
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / TILE[0], (uv.getY(i) * dims[f][1]) / TILE[1]);
    }
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y + h / 2, z);
  o.castShadow = shadow;
  if (tint) o.userData.tint = tint;
  parent.add(o);
  return o;
}

// ---------------------------------------------------------------- facade frames

const ROT: Record<Side, number> = { S: 0, N: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 };

interface Hole {
  u0: number;
  u1: number;
  y0: number;
  y1: number;
}

/** one wall of a building in its own frame: u along the wall (centred), y up, +z out */
export class Face {
  g = new THREE.Group();
  f = new THREE.Group();
  m = new THREE.Matrix4();
  len: number;
  holes: Hole[] = [];
  constructor(public ctx: BCtx, public r: Rect, public side: Side) {
    const alongX = side === 'N' || side === 'S';
    this.len = alongX ? r.maxX - r.minX : r.maxZ - r.minZ;
    const cx = (r.minX + r.maxX) / 2, cz = (r.minZ + r.maxZ) / 2;
    const p = side === 'N' ? new THREE.Vector3(cx, 0, r.minZ) : side === 'S' ? new THREE.Vector3(cx, 0, r.maxZ) : side === 'E' ? new THREE.Vector3(r.maxX, 0, cz) : new THREE.Vector3(r.minX, 0, cz);
    for (const g of [this.g, this.f]) {
      g.position.copy(p);
      g.rotation.y = ROT[side];
    }
    this.m.makeRotationY(ROT[side]).setPosition(p);
    ctx.stat.add(this.g);
    ctx.fine.add(this.f);
  }
  /** block-local point from face coordinates */
  at(u: number, y: number, z: number) {
    return new THREE.Vector3(u, y, z).applyMatrix4(this.m);
  }
  /** block-local axis-aligned rect around a face-local box */
  rectOf(u0: number, u1: number, z0: number, z1: number): Rect {
    const a = this.at(u0, 0, z0), b = this.at(u1, 0, z1);
    return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) };
  }
  /** an opening with an instanced window in it */
  window(u0: number, y0: number, w: number, h: number, o: { trim: TrimKind; sash: SashKind; trimColor: THREE.Color; revealColor: THREE.Color; sashColor: THREE.Color; kind: 'apt' | 'office' | 'loft'; ac?: number; muntins?: number }) {
    this.holes.push({ u0, u1: u0 + w, y0, y1: y0 + h });
    const rng = this.ctx.rng;
    const d = dressWindow(rng, o.kind);
    const hasAc = o.ac !== undefined && rng.chance(o.ac);
    const m = this.m.clone().multiply(new THREE.Matrix4().makeTranslation(u0, y0, 0));
    this.ctx.win.add({
      m, w, h, trim: o.trim, sash: o.sash, trimColor: o.trimColor, revealColor: o.revealColor, sashColor: o.sashColor,
      lit: d.lit, blind: hasAc ? Math.max(d.blind, 0.15) : d.blind, curtains: d.curtains, depth: d.depth, muntins: o.muntins ?? 0,
      ac: hasAc ? new THREE.Color(rng.pick(['#d9d6cc', '#c9c6bd', '#e6e3da', '#a9a8a2', '#cfc8b4'])) : undefined,
    });
  }
  /** cut an opening without a window (doors, storefronts) */
  cut(u0: number, u1: number, y0: number, y1: number) {
    this.holes.push({ u0, u1, y0, y1 });
  }
  /**
   * The wall between y0 and y1 with every opening cut out, as quads with UVs in metres.
   * With `course`, the wall is rusticated: banded blocks with deep horizontal joints.
   */
  wall(m: THREE.Material, y0: number, y1: number, tint?: string, course = 0) {
    const L = this.len / 2;
    const holes = this.holes.filter((h) => h.y1 > y0 && h.y0 < y1);
    const ys = new Set<number>([y0, y1]);
    for (const h of holes) {
      if (h.y0 > y0 && h.y0 < y1) ys.add(h.y0);
      if (h.y1 > y0 && h.y1 < y1) ys.add(h.y1);
    }
    if (course > 0) for (let y = y0 + course; y < y1 - 0.05; y += course) ys.add(+y.toFixed(4));
    const sorted = [...ys].sort((a, b) => a - b);
    const pos: number[] = [], uvs: number[] = [];
    const quad = (a: number, b: number, c: number, d: number, z: number) => {
      pos.push(a, c, z, b, c, z, b, d, z, a, c, z, b, d, z, a, d, z);
      const U = (u: number) => (u + L) / TILE[0], V = (y: number) => y / TILE[1];
      uvs.push(U(a), V(c), U(b), V(c), U(b), V(d), U(a), V(c), U(b), V(d), U(a), V(d));
    };
    for (let i = 0; i < sorted.length - 1; i++) {
      const s0 = sorted[i], s1 = sorted[i + 1];
      if (s1 - s0 < 1e-4) continue;
      const mid = (s0 + s1) / 2;
      const cuts = holes.filter((h) => h.y0 < mid && h.y1 > mid).sort((a, b) => a.u0 - b.u0);
      let u = -L;
      const segs: [number, number][] = [];
      for (const h of cuts) {
        if (h.u0 > u) segs.push([u, Math.min(h.u0, L)]);
        u = Math.max(u, h.u1);
      }
      if (u < L) segs.push([u, L]);
      for (const [a, b] of segs) {
        if (b - a < 1e-4) continue;
        if (course > 0) {
          // a rusticated course: the block sits proud, the joint below it is recessed
          const j = Math.min(0.035, (s1 - s0) * 0.3);
          quad(a, b, s0, s0 + j, 0);
          PB(this.g, m, b - a, s1 - s0 - j, 0.05, (a + b) / 2, s0 + j, 0.025, tint, false);
        } else quad(a, b, s0, s1, 0);
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.computeVertexNormals();
    // baked contact shadow: walls darken towards the pavement
    const col = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) col.fill(0.68 + 0.32 * Math.pow(Math.min(1, Math.max(0, pos[i + 1]) / 3), 0.6), i, i + 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const o = new THREE.Mesh(g, m);
    o.castShadow = true;
    if (tint) o.userData.tint = tint;
    o.userData.ao = true;
    this.g.add(o);
  }
  /** a horizontal band along the whole face */
  band(m: THREE.Material, y: number, h: number, out: number, extra = 0, fine = false, tint = '#e3dccb') {
    if (m.userData.pbr) return PB(fine ? this.f : this.g, m, this.len + extra * 2, h, out, 0, y, out / 2, tint, !fine);
    return B(fine ? this.f : this.g, m, this.len + extra * 2, h, out, 0, y, out / 2, !fine);
  }
}

/** n bays centred on the face: centres of each bay */
function bays(len: number, n: number, margin = 0) {
  const w = (len - margin * 2) / n;
  return Array.from({ length: n }, (_, i) => -len / 2 + margin + w * (i + 0.5));
}

// ---------------------------------------------------------------- cornices, bands, roofs

type CorniceKind = 'bracket' | 'modillion' | 'parapet' | 'deco';

/** a bracketed or modillioned cornice whose top is at y */
function cornice(F: Face, kind: CorniceKind, y: number, color: string, scale = 1, returns: [boolean, boolean] = [false, false]) {
  const cm = mat(color, { rough: 0.6, metal: 0.15 });
  const dk = mat(shade(color, 0.8), { rough: 0.7, metal: 0.1 });
  const s = scale;
  const L = F.len;
  if (kind === 'parapet') {
    // stone coping and a thin band under it
    F.band(cm, y - 0.12, 0.14, 0.12, 0.05);
    F.band(dk, y - 0.5, 0.12, 0.05);
    return;
  }
  if (kind === 'deco') {
    // stepped Art Deco crown: three shallow setbacks of stone
    F.band(cm, y - 0.6, 0.6, 0.06);
    F.band(cm, y - 0.3, 0.3, 0.12, -0.2);
    return;
  }
  const fh = (kind === 'bracket' ? 1.0 : 1.2) * s; // total height
  // frieze with recessed panels
  F.band(cm, y - fh, fh * 0.62, 0.07, 0.02);
  // bed moulding, corona and cymatium cap
  F.band(dk, y - fh * 0.38, fh * 0.1, 0.22 * s, 0.1);
  F.band(cm, y - fh * 0.28, fh * 0.2, 0.5 * s, 0.3 * s);
  F.band(cm, y - fh * 0.08, fh * 0.08, 0.58 * s, 0.34 * s);
  F.band(dk, y, 0.04, 0.6 * s, 0.36 * s);
  // brackets (consoles) or modillions carrying the corona
  const step = kind === 'bracket' ? 1.5 * s : 0.55 * s;
  const n = Math.max(2, Math.round(L / step));
  for (let i = 0; i <= n; i++) {
    const u = -L / 2 + 0.12 + ((L - 0.24) * i) / n;
    const end = i === 0 || i === n;
    if (kind === 'bracket') {
      const bw = (end ? 0.26 : 0.16) * s;
      B(F.f, cm, bw, fh * 0.62, 0.16 * s, u, y - fh * 0.9, 0.08 * s + 0.07, false);
      B(F.f, cm, bw, fh * 0.2, 0.32 * s, u, y - fh * 0.48, 0.16 * s + 0.07, false);
      B(F.f, cm, bw * 0.9, fh * 0.14, 0.26 * s, u, y - fh * 0.98, 0.13 * s + 0.04, false);
      if (!end && i < n) {
        // panel between brackets
        const pu = u + (L - 0.24) / n / 2;
        B(F.f, dk, (L - 0.24) / n - 0.5 * s, fh * 0.32, 0.02, pu, y - fh * 0.85, 0.08, false);
      }
    } else {
      B(F.f, cm, 0.12 * s, 0.14 * s, 0.42 * s, u, y - fh * 0.42, 0.21 * s + 0.06, false);
    }
  }
  // dentils under the corona
  if (kind === 'bracket' || kind === 'modillion') {
    const dn = Math.floor(L / (0.16 * s));
    for (let i = 0; i < dn; i++) B(F.f, dk, 0.08 * s, 0.1 * s, 0.11 * s, -L / 2 + 0.08 * s + i * 0.16 * s, y - fh * 0.38 - 0.1 * s, 0.13 + 0.05 * s, false);
  }
  // returns at exposed ends
  for (const [k, on] of returns.entries()) if (on) B(F.g, cm, 0.6 * s, fh * 0.3, 0.6 * s, (k ? 1 : -1) * (L / 2 + 0.25 * s), y - fh * 0.3, 0.3 * s);
}

function roof(parent: THREE.Object3D, r: Rect, y: number) {
  const g = new THREE.PlaneGeometry(r.maxX - r.minX, r.maxZ - r.minZ);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (r.maxX - r.minX), uv.getY(i) * (r.maxZ - r.minZ));
  const o = new THREE.Mesh(g, M.tar());
  o.rotation.x = -Math.PI / 2;
  o.position.set((r.minX + r.maxX) / 2, y, (r.minZ + r.maxZ) / 2);
  parent.add(o);
}

/** parapet walls around a roof, with coping */
function parapet(parent: THREE.Object3D, r: Rect, y: number, h: number, wallM: THREE.Material, copeM: THREE.Material) {
  const w = r.maxX - r.minX, d = r.maxZ - r.minZ, cx = (r.minX + r.maxX) / 2, cz = (r.minZ + r.maxZ) / 2, t = 0.3;
  B(parent, wallM, w, h, t, cx, y, r.minZ + t / 2);
  B(parent, wallM, w, h, t, cx, y, r.maxZ - t / 2);
  B(parent, wallM, t, h, d, r.minX + t / 2, y, cz);
  B(parent, wallM, t, h, d, r.maxX - t / 2, y, cz);
  B(parent, copeM, w + 0.06, 0.08, t + 0.08, cx, y + h, r.minZ + t / 2, false);
  B(parent, copeM, w + 0.06, 0.08, t + 0.08, cx, y + h, r.maxZ - t / 2, false);
  B(parent, copeM, t + 0.08, 0.08, d, r.minX + t / 2, y + h, cz, false);
  B(parent, copeM, t + 0.08, 0.08, d, r.maxX - t / 2, y + h, cz, false);
}

let staveTex: THREE.Texture | null = null;
function waterTowerMat() {
  staveTex ??= canvasTex(512, 256, (g) => {
    g.fillStyle = '#7d6c5a';
    g.fillRect(0, 0, 512, 256);
    for (let x = 0; x < 512; x += 16) {
      const l = 70 + Math.random() * 40;
      g.fillStyle = `rgb(${l + 30},${l + 18},${l + 5})`;
      g.fillRect(x + 1, 0, 14, 256);
      // weathering streaks running down
      g.fillStyle = 'rgba(40,30,20,0.25)';
      g.fillRect(x + 2 + Math.random() * 10, 0, 2, 120 + Math.random() * 136);
    }
    g.fillStyle = 'rgba(30,25,20,0.5)';
    for (let x = 0; x < 512; x += 16) g.fillRect(x, 0, 1.5, 256);
  }, true);
  return mat('#ffffff', { rough: 0.95, map: staveTex });
}

/** a timber water tank on a steel stand, with hoops, a conical roof and a ladder */
function waterTower(st: THREE.Object3D, fine: THREE.Object3D, x: number, y: number, z: number, rng: Rng) {
  const iron = M.iron();
  const r = rng.range(1.5, 2.1), th = rng.range(3.6, 4.6), legH = rng.range(2.4, 4.2);
  const n = rng.chance(0.5) ? 4 : 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.4;
    B(st, iron, 0.2, legH, 0.2, x + Math.cos(a) * r * 0.85, y, z + Math.sin(a) * r * 0.85);
  }
  // cross bracing and the steel deck
  for (const s of [-1, 1]) {
    const br = B(fine, iron, 0.05, Math.hypot(legH, r * 1.7), 0.05, x + s * r * 0.85 * 0.1, y + legH / 2 - Math.hypot(legH, r * 1.7) / 2, z);
    br.position.y = y + legH / 2;
    br.rotation.z = s * Math.atan2(r * 1.7, legH);
  }
  B(st, iron, r * 2.1, 0.25, 0.25, x, y + legH, z - r * 0.5);
  B(st, iron, r * 2.1, 0.25, 0.25, x, y + legH, z + r * 0.5);
  B(st, mat('#4a4038', { rough: 0.9 }), r * 2.2, 0.08, r * 2.2, x, y + legH + 0.25, z);
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.97, r, th, 28, 1, true), waterTowerMat());
  const uv = tank.geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 3);
  tank.position.set(x, y + legH + 0.33 + th / 2, z);
  tank.castShadow = true;
  st.add(tank);
  for (let k = 0; k < 6; k++) C(fine, iron, r * 1.005 + 0.012, 0.05, x, y + legH + 0.6 + (k * (th - 0.6)) / 5.2, z, false);
  const roofH = r * rng.range(0.45, 0.7);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 1.06, roofH, 28), mat(rng.pick(['#5a5048', '#3d3a36', '#6a5a4a']), { rough: 0.9 }));
  cone.position.set(x, y + legH + 0.33 + th + roofH / 2, z);
  cone.castShadow = true;
  st.add(cone);
  C(fine, iron, 0.06, 0.5, x, y + legH + 0.33 + th + roofH - 0.05, z, false);
  // ladder up the side
  const lx = x + r + 0.12;
  B(fine, iron, 0.04, legH + th + 0.4, 0.04, lx, y, z - 0.22, false);
  B(fine, iron, 0.04, legH + th + 0.4, 0.04, lx, y, z + 0.22, false);
  for (let k = 0.3; k < legH + th; k += 0.35) B(fine, iron, 0.03, 0.03, 0.44, lx, y + k, z, false);
}

/** rooftop stair bulkhead with a door */
function bulkhead(st: THREE.Object3D, x: number, y: number, z: number, wallM: THREE.Material, tint: string | undefined, rot: number) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = rot;
  PB(g, wallM, 2.6, 2.7, 3.2, 0, 0, 0, tint);
  B(g, mat('#6b6862', { rough: 0.9 }), 2.8, 0.1, 3.4, 0, 2.7, 0);
  B(g, mat('#3e4246', { rough: 0.5, metal: 0.4 }), 0.95, 2.05, 0.05, 0, 0, 1.6, false);
  st.add(g);
}

function chimneys(st: THREE.Object3D, fine: THREE.Object3D, r: Rect, y: number, rng: Rng, along: 'x' | 'z') {
  const n = rng.int(1, 3);
  const m = mat(rng.pick(['#7a3a2e', '#6b4434', '#8a5a44']), { rough: 0.95 });
  for (let i = 0; i < n; i++) {
    const t = rng.range(0.2, 0.8);
    const x = along === 'x' ? r.minX + 0.4 : r.minX + (r.maxX - r.minX) * t;
    const z = along === 'x' ? r.minZ + (r.maxZ - r.minZ) * t : r.minZ + 0.4;
    const h = rng.range(1.0, 2.0);
    B(st, m, 0.7, h, 1.1, x, y, z);
    B(st, mat('#5c5a56', { rough: 0.9 }), 0.8, 0.1, 1.2, x, y + h, z, false);
    for (const dz of [-0.25, 0.25]) C(fine, mat('#9a5a3c', { rough: 0.9 }), 0.1, 0.35, x + (along === 'x' ? 0 : dz), y + h + 0.1, z + (along === 'x' ? dz : 0), false);
  }
}

function rooftopClutter(st: THREE.Object3D, fine: THREE.Object3D, r: Rect, y: number, rng: Rng, n: number) {
  const metal = mat('#9a9c9e', { rough: 0.5, metal: 0.6 });
  for (let i = 0; i < n; i++) {
    const x = rng.range(r.minX + 1.5, r.maxX - 1.5), z = rng.range(r.minZ + 1.5, r.maxZ - 1.5);
    const k = rng.int(0, 2);
    if (k === 0) {
      // condenser unit with a fan grille
      B(st, mat('#c9c8c2', { rough: 0.6, metal: 0.3 }), 1.2, 0.9, 1.0, x, y, z);
      C(fine, mat('#2a2b2c', { rough: 0.6 }), 0.4, 0.02, x, y + 0.9, z, false);
    } else if (k === 1) {
      C(st, metal, 0.18, 1.2, x, y, z);
      C(fine, metal, 0.3, 0.25, x, y + 1.2, z, false);
    } else {
      // skylight
      B(st, mat('#5c5a56', { rough: 0.8 }), 1.4, 0.4, 1.0, x, y, z);
      const gl = B(st, M.glassDark(), 1.3, 0.05, 1.0, x, y + 0.45, z, false);
      gl.rotation.x = 0.25;
    }
  }
}

// ---------------------------------------------------------------- fire escapes

/**
 * An old-law tenement fire escape: a balcony at every floor above the ground, slatted floors,
 * railings with balusters, steep stairs running along the wall between balconies, a counter-
 * balanced drop ladder at the bottom and a gooseneck ladder to the roof.
 */
function fireEscape(F: Face, uc: number, w: number, levels: number[], top: number, color: string) {
  const iron = mat(color, { rough: 0.55, metal: 0.5 });
  const D = 1.1, rail = 0.95;
  const u0 = uc - w / 2, u1 = uc + w / 2;
  levels.forEach((y, i) => {
    // platform: frame + slats
    B(F.g, iron, w, 0.06, 0.06, uc, y - 0.06, D - 0.03);
    B(F.g, iron, 0.06, 0.06, D, u0 + 0.03, y - 0.06, D / 2);
    B(F.g, iron, 0.06, 0.06, D, u1 - 0.03, y - 0.06, D / 2);
    for (let k = 0; k < 7; k++) B(F.f, iron, w - 0.06, 0.025, 0.05, uc, y - 0.03, 0.1 + (k * (D - 0.2)) / 6, false);
    // railing: corner posts, top and mid rails, balusters
    for (const u of [u0 + 0.03, u1 - 0.03]) B(F.g, iron, 0.05, rail, 0.05, u, y, D - 0.03);
    B(F.g, iron, w, 0.05, 0.05, uc, y + rail, D - 0.03);
    B(F.g, iron, 0.05, 0.05, D, u0 + 0.03, y + rail, D / 2);
    B(F.g, iron, 0.05, 0.05, D, u1 - 0.03, y + rail, D / 2);
    B(F.f, iron, w, 0.03, 0.03, uc, y + 0.12, D - 0.03, false);
    for (let u = u0 + 0.13; u < u1 - 0.08; u += 0.12) B(F.f, iron, 0.018, rail - 0.1, 0.018, u, y + 0.1, D - 0.03, false);
    for (const uu of [u0 + 0.03, u1 - 0.03]) for (let z = 0.12; z < D - 0.08; z += 0.12) B(F.f, iron, 0.018, rail - 0.1, 0.018, uu, y + 0.1, z, false);
    // diagonal brackets into the wall
    for (const u of [u0 + 0.25, u1 - 0.25]) {
      const br = B(F.g, iron, 0.05, 1.3, 0.05, u, y - 0.9, 0.5);
      br.rotation.x = -0.75;
      br.position.set(u, y - 0.5, D * 0.42);
    }
    // stairs up to the next balcony, alternating direction
    if (i < levels.length - 1) {
      const fh = levels[i + 1] - y;
      const run = Math.min(w - 0.7, fh * 0.62);
      const dir = i % 2 ? -1 : 1;
      const sa = dir > 0 ? u0 + 0.25 : u1 - 0.25; // foot of the stair
      const len = Math.hypot(run, fh);
      const ang = Math.atan2(fh, run);
      for (const z of [0.38, 0.92]) {
        const s = B(F.g, iron, len, 0.12, 0.03, 0, 0, z);
        s.position.set(sa + (dir * run) / 2, y + fh / 2, z);
        s.rotation.z = dir * ang;
      }
      const steps = Math.round(fh / 0.24);
      for (let k = 1; k < steps; k++) B(F.f, iron, 0.14, 0.025, 0.54, sa + (dir * run * k) / steps, y + (fh * k) / steps, 0.65, false);
      // a stair handrail
      const hr = B(F.f, iron, len, 0.035, 0.035, 0, 0, 0.95, false);
      hr.position.set(sa + (dir * run) / 2, y + fh / 2 + 0.85, 0.95);
      hr.rotation.z = dir * ang;
    }
  });
  // drop ladder hanging from the lowest balcony, stowed
  const y0 = levels[0];
  const lu = u1 - 0.55;
  const lh = Math.min(3.0, y0 - 2.2);
  if (lh > 0.6) {
    for (const du of [-0.22, 0.22]) B(F.g, iron, 0.04, lh, 0.04, lu + du, y0 - lh + 0.9, D + 0.05);
    for (let k = 0.15; k < lh; k += 0.3) B(F.f, iron, 0.44, 0.025, 0.025, lu, y0 - lh + 0.9 + k, D + 0.05, false);
  }
  // gooseneck ladder over the parapet
  const yt = levels[levels.length - 1];
  const gu = u0 + 0.5;
  const gh = top - yt + 0.6;
  for (const du of [-0.2, 0.2]) {
    B(F.g, iron, 0.04, gh, 0.04, gu + du, yt, 0.25);
    B(F.g, iron, 0.04, 0.04, 0.45, gu + du, yt + gh - 0.02, 0.02);
  }
  for (let k = 0.3; k < gh; k += 0.3) B(F.f, iron, 0.4, 0.025, 0.025, gu, yt + k, 0.25, false);
}

// ---------------------------------------------------------------- residential entrances

/** brownstone stoop to the parlour floor: stone steps between solid cheek walls, iron rails */
function stoop(F: Face, uc: number, parlor: number, stoneM: THREE.Material, tint: string, rail: THREE.Material) {
  const n = Math.round(parlor / 0.19);
  const rise = parlor / n, tread = 0.3, w = 1.9, land = 1.1;
  const run = n * tread;
  // landing at the door, then the flight down towards the street
  PB(F.g, stoneM, w + 0.5, parlor, land, uc, 0, land / 2, tint);
  for (let k = 0; k < n; k++) {
    const hgt = parlor - (k + 1) * rise + rise;
    PB(F.g, stoneM, w, hgt, tread + 0.02, uc, 0, land + k * tread + tread / 2, tint);
    // nosing
    B(F.f, mat(shade(tint, 0.8), { rough: 0.9 }), w + 0.04, 0.03, 0.04, uc, hgt - 0.03, land + k * tread + 0.01, false);
  }
  // cheek walls with a sloped coping
  for (const s of [-1, 1]) {
    const x = uc + s * (w / 2 + 0.13);
    const cw = new THREE.Shape();
    cw.moveTo(0, 0);
    cw.lineTo(land + run + 0.3, 0);
    cw.lineTo(land + run + 0.3, 0.75);
    cw.lineTo(land, parlor + 0.45);
    cw.lineTo(0, parlor + 0.45);
    const g = new THREE.ExtrudeGeometry(cw, { depth: 0.26, bevelEnabled: false });
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / TILE[0], uv.getY(i) / TILE[1]);
    g.rotateY(-Math.PI / 2);
    g.translate(x + 0.13, 0, 0);
    const o = new THREE.Mesh(g, stoneM);
    o.castShadow = true;
    o.userData.tint = tint;
    F.g.add(o);
    // iron handrail on top: newel post with a ball at the foot, sloped rail, balusters
    const ang = Math.atan2(parlor - 0.3, run);
    const len = Math.hypot(run, parlor - 0.3);
    const hr = B(F.g, rail, 0.05, 0.05, len, x, 0, 0);
    hr.position.set(x, 0.75 + 0.85 + (parlor - 0.3) / 2, land + run / 2 + 0.15);
    hr.rotation.x = ang;
    B(F.g, rail, 0.05, 0.05, land, x, parlor + 0.45 + 0.85, land / 2);
    C(F.g, rail, 0.07, 0.95, x, 0.75, land + run + 0.12);
    C(F.f, rail, 0.1, 0.18, x, 0.75 + 0.95, land + run + 0.12, false);
    for (let t = 0.2; t < run; t += 0.14) {
      const yb = 0.75 + ((run - t) / run) * (parlor - 0.3);
      B(F.f, rail, 0.02, 0.85, 0.02, x, yb + 0.05 - 0.05, land + t, false);
    }
  }
}

/** recessed double door with a transom and a surround */
function doorway(F: Face, uc: number, y: number, w: number, h: number, frameColor: string, surround: 'hood' | 'stone' | 'plain' | 'brass', tint?: string) {
  F.cut(uc - w / 2, uc + w / 2, y, y + h);
  const depth = 0.55;
  const rev = mat(shade(frameColor, 0.6), { rough: 0.9 });
  // reveal of the doorway
  B(F.g, rev, 0.04, h, depth, uc - w / 2 - 0.02, y, -depth / 2, false);
  B(F.g, rev, 0.04, h, depth, uc + w / 2 + 0.02, y, -depth / 2, false);
  B(F.g, rev, w, 0.04, depth, uc, y + h - 0.02, -depth / 2, false);
  B(F.g, mat('#8a8478', { rough: 0.9 }), w, 0.04, depth, uc, y - 0.02, -depth / 2, false);
  // the doors and transom
  const doorM = mat(frameColor, { rough: 0.45, metal: surround === 'brass' ? 0.3 : 0 });
  const th = Math.min(0.55, h * 0.18);
  const dh = h - th;
  B(F.g, doorM, w, dh, 0.08, uc, y, -depth + 0.04);
  B(F.g, doorM, w, 0.1, 0.1, uc, y + dh, -depth + 0.05);
  B(F.g, mat('#ffe2a8', { emissive: '#ffcf7a', ei: 0.5, rough: 0.2 }), w - 0.1, th - 0.12, 0.02, uc, y + dh + 0.08, -depth + 0.02, false);
  const pan = mat(shade(frameColor, 0.75), { rough: 0.5 });
  for (const s of [-1, 1]) {
    const pu = uc + (s * w) / 4;
    if (surround === 'brass') B(F.g, mat('#cfd6da', { rough: 0.05, metal: 0.6 }), w / 2 - 0.2, dh - 0.5, 0.02, pu, y + 0.3, -depth + 0.085, false);
    else {
      B(F.f, pan, w / 2 - 0.22, dh * 0.42, 0.03, pu, y + dh * 0.5, -depth + 0.09, false);
      B(F.f, pan, w / 2 - 0.22, dh * 0.3, 0.03, pu, y + 0.15, -depth + 0.09, false);
    }
    B(F.f, mat('#c9a65a', { rough: 0.3, metal: 0.9 }), 0.03, 0.18, 0.05, uc + s * 0.07, y + 1.05, -depth + 0.1, false);
  }
  B(F.g, mat('#202020', { rough: 0.5 }), 0.02, dh, 0.09, uc, y, -depth + 0.045, false);
  // surround
  if (surround === 'hood') {
    const sm = brownMat();
    for (const s of [-1, 1]) {
      PB(F.g, sm, 0.26, h, 0.12, uc + s * (w / 2 + 0.13), y, 0.06, tint);
      PB(F.f, sm, 0.2, 0.55, 0.3, uc + s * (w / 2 + 0.16), y + h - 0.2, 0.15, tint, false);
    }
    PB(F.g, sm, w + 0.8, 0.3, 0.16, uc, y + h, 0.08, tint);
    PB(F.g, sm, w + 1.0, 0.12, 0.38, uc, y + h + 0.3, 0.19, tint);
  } else if (surround === 'stone') {
    const sm = stoneMat();
    for (const s of [-1, 1]) PB(F.g, sm, 0.3, h + 0.3, 0.1, uc + s * (w / 2 + 0.15), y, 0.05, '#e3dccb');
    PB(F.g, sm, w + 0.9, 0.4, 0.16, uc, y + h + 0.3, 0.08, '#e3dccb');
    PB(F.g, sm, w + 1.1, 0.1, 0.3, uc, y + h + 0.7, 0.15, '#e3dccb');
  } else if (surround === 'brass') {
    B(F.g, mat('#b08d4a', { rough: 0.3, metal: 0.9 }), w + 0.3, h + 0.15, 0.06, uc, y, 0.03, false);
  } else {
    B(F.g, mat(shade(frameColor, 1.1), { rough: 0.6 }), w + 0.4, 0.18, 0.2, uc, y + h + 0.05, 0.1);
  }
}

/** UWS apartment-house canopy from the door out to the kerb */
function canopy(F: Face, uc: number, color: string, len: number, text: string) {
  const cm = mat(color, { rough: 0.85 });
  const brass = mat('#b08d4a', { rough: 0.3, metal: 0.9 });
  const w = 1.9, y = 2.75;
  B(F.g, cm, w, 0.38, len, uc, y, len / 2);
  B(F.g, cm, w + 0.04, 0.05, len + 0.02, uc, y + 0.38, len / 2);
  for (const s of [-1, 1]) {
    C(F.f, brass, 0.03, y, uc + s * (w / 2 - 0.05), 0, len - 0.12, false);
    C(F.f, brass, 0.03, y, uc + s * (w / 2 - 0.05), 0, len * 0.5, false);
  }
  void text;
}

// ---------------------------------------------------------------- the buildings

const TRIM_STONE = ['#d9d1bf', '#cfc6b2', '#e4dccb', '#bfb5a0'];
const PAINT = ['#ece6da', '#1c1c1c', '#2f3b2f', '#6b3a2a', '#d8d0c0', '#40352c'];
const CORNICE_PAINT = ['#d8d2c4', '#8a8a84', '#3a3a38', '#b8ad94', '#5a6a5c', '#e8e2d2', '#7a5a44'];

export function building(ctx: BCtx, r: Rect, front: Side, type: BType, floors: number, store: boolean, cornerSides: [boolean, boolean]) {
  const { rng, stat, fine, colliders } = ctx;
  const style: FacadeStyle = { brownstone: 'brownstone', tenement: 'brick', prewar: 'prewar', midrise: rng.pick(['brick', 'brick', 'panel'] as const), tower: rng.pick(['glass', 'glass', 'panel'] as const), castiron: 'castiron' }[type] as FacadeStyle;
  const wall = {
    brownstone: rng.pick(['#6e4632', '#7a5038', '#5e3c2c', '#83604a']),
    tenement: rng.pick(['#8c3b2a', '#9a5a3c', '#a3683f', '#7a3a2e', '#b58a5a', '#6b4a3a', '#c9b08a']),
    prewar: rng.pick(['#b89d78', '#a8896a', '#9a5a3c', '#c9a982', '#8c4a34']),
    midrise: rng.pick(['#9a8c7c', '#b8b0a2', '#7d6b5a', '#a35a3c']),
    tower: rng.pick(['#7b8d9e', '#6d7f8c', '#8fa1ad', '#5b6670']),
    castiron: rng.pick(['#e2ddd0', '#c9cec9', '#d8ccb0', '#bfbfb8', '#a9b2a8']),
  }[type];
  const fm = facadeMat(style, rng.int(0, 2));
  const tint = FACADE_PBR[style] ? softTint(wall, type === 'castiron' ? 0.7 : type === 'brownstone' ? 0.8 : 0.35) : wall;
  const plain = mat(shade(wall, 0.82), { rough: 0.95 });
  const sides: Side[] = ['N', 'S', 'E', 'W'];
  const exposed = (s: Side) => s === front || (front === 'E' || front === 'W' ? (s === 'N' && cornerSides[0]) || (s === 'S' && cornerSides[1]) : false);
  const alongX = front === 'N' || front === 'S';
  const addrName = front === 'E' || front === 'W' ? avenueName(ctx.cx + (front === 'E' ? 0 : -1)) : streetName(ctx.cz + (front === 'S' ? 0 : -1));
  const addr = `${rng.int(1, 650)} ${addrName}`;

  if (type === 'tower') return tower(ctx, r, front, floors, fm, tint, addr);

  // ---- vertical layout
  const parlor = type === 'brownstone' ? rng.range(1.5, 1.9) : 0;
  const ground = type === 'brownstone' ? parlor : store ? (type === 'castiron' ? 4.6 : 4.3) : type === 'prewar' ? 4.4 : 3.5;
  const fh = type === 'castiron' ? 4.0 : type === 'brownstone' ? 3.3 : type === 'tenement' ? 3.05 : 3.15;
  // floor levels above the ground floor (brownstone: parlour floor is taller)
  const levels: number[] = [];
  let y = ground;
  for (let f = 1; f < floors; f++) {
    levels.push(y);
    y += type === 'brownstone' && f === 1 ? 4.0 : fh;
  }
  if (type === 'brownstone') levels.push(y), (y += fh * 0.92);
  const corniceH = type === 'prewar' ? 1.3 : type === 'castiron' ? 1.4 : type === 'midrise' ? 0.6 : 1.1;
  const h = y + corniceH * 0.6;

  // ---- colours
  const trimC = new THREE.Color(type === 'brownstone' ? shade(wall, 1.05) : type === 'castiron' ? shade(tint, 0.95) : rng.pick(TRIM_STONE));
  const revealC = new THREE.Color(type === 'castiron' ? shade(tint, 0.6) : shade(wall, 0.75));
  const sashC = new THREE.Color(rng.pick(type === 'brownstone' ? ['#2a1d16', '#e8e2d6', '#1d2a22', '#3a2a20'] : type === 'castiron' ? ['#1c1c1c', '#3a4a3a', '#e8e4da', '#5a3a2a'] : PAINT));
  const trim: TrimKind = type === 'brownstone' ? 'hood' : type === 'castiron' ? 'arch' : type === 'tenement' ? rng.pick(['stone', 'stone', 'arch', 'hood', 'flat'] as const) : type === 'prewar' ? rng.pick(['stone', 'flat', 'stone'] as const) : rng.pick(['flat', 'none'] as const);
  const sash: SashKind = type === 'castiron' ? 'case' : type === 'midrise' && style === 'panel' ? 'case' : 'dh';
  const kind = type === 'castiron' ? 'loft' : type === 'midrise' && style === 'panel' ? 'office' : 'apt';
  const acRate = type === 'tenement' ? 0.22 : type === 'prewar' ? 0.15 : type === 'midrise' ? 0.12 : type === 'brownstone' ? 0.08 : 0.04;
  const muntins = type === 'brownstone' && rng.chance(0.3) ? 1 : type === 'tenement' && rng.chance(0.15) ? 1 : 0;
  const winOpts = { trim, sash, trimColor: trimC, revealColor: revealC, sashColor: sashC, kind: kind as 'apt' | 'office' | 'loft', ac: acRate, muntins };

  for (const s of sides) {
    const isFront = s === front;
    if (!isFront && !exposed(s)) {
      // party wall: plain, it is mostly hidden by neighbours
      const Fp = new Face(ctx, r, s);
      Fp.wall(plain, 0, h);
      continue;
    }
    const F = new Face(ctx, r, s);
    const L = F.len;
    // ---- bays
    let n: number, ww: number, wh: number[];
    if (type === 'brownstone') {
      n = L > 6.6 ? 4 : 3;
      ww = 1.05;
    } else if (type === 'castiron') {
      n = Math.max(2, Math.round(L / 3.1));
      ww = L / n - 0.85;
    } else {
      n = Math.max(2, Math.round(L / (type === 'tenement' ? 1.95 : 2.3)));
      ww = type === 'tenement' ? 0.95 : 1.15;
      if (style === 'panel') ww = L / n - 0.6;
    }
    const centres = bays(L, n, type === 'castiron' ? 0.2 : 0.35);
    // floors with balconettes on pre-war fronts
    const balcony = new Set<number>(type === 'prewar' && isFront ? [1, levels.length - 3].filter(() => rng.chance(0.6)) : []);
    // ---- upper floor windows
    levels.forEach((ly, i) => {
      const top = i === levels.length - 1;
      let wy = ly + 0.8, whh = type === 'tenement' ? 1.75 : 1.8;
      if (type === 'brownstone') {
        if (i === 0) { wy = ly + 0.45; whh = 2.55; } else { wy = ly + 0.75; whh = top ? 1.6 : 1.95; }
      } else if (type === 'castiron') { wy = ly + 0.55; whh = fh - 1.15; }
      else if (style === 'panel') { wy = ly + 0.95; whh = 1.45; }
      for (const c of centres) {
        // brownstone parlour door bay
        if (type === 'brownstone' && i === 0 && isFront && c === centres[0]) continue;
        F.window(c - ww / 2, wy, ww, whh, { ...winOpts, trim: type === 'prewar' && top ? 'arch' : winOpts.trim });
        // pre-war balconettes: a stone shelf on brackets with an iron railing
        if (balcony.has(i)) {
          const bw = ww + 0.5;
          PB(F.g, stoneMat(), bw, 0.14, 0.5, c, wy - 0.2, 0.25, '#e3dccb');
          for (const s2 of [-1, 1]) B(F.f, mat('#d9d1bf', { rough: 0.85 }), 0.12, 0.3, 0.4, c + s2 * (bw / 2 - 0.12), wy - 0.5, 0.2, false);
          const iron = M.iron();
          B(F.f, iron, bw - 0.06, 0.04, 0.04, c, wy + 0.85, 0.47, false);
          B(F.f, iron, 0.04, 0.04, 0.45, c - bw / 2 + 0.05, wy + 0.85, 0.25, false);
          B(F.f, iron, 0.04, 0.04, 0.45, c + bw / 2 - 0.05, wy + 0.85, 0.25, false);
          for (let u = -bw / 2 + 0.05; u <= bw / 2 - 0.04; u += 0.11) B(F.f, iron, 0.018, 0.9, 0.018, c + u, wy - 0.06, 0.47, false);
        }
      }
    });
    wh = [];
    void wh;
    // ---- ground floor
    const groundTint = type === 'prewar' ? '#e3dccb' : tint;
    if (isFront && store) {
      // storefronts take the whole ground floor between piers
      const nS = Math.max(1, Math.min(3, Math.floor((L - 0.6) / 5.5)));
      const pier = 0.45;
      const span = (L - pier * 2) / nS;
      F.cut(-L / 2 + pier, L / 2 - pier, 0, ground - 0.55);
      for (let k = 0; k < nS; k++) {
        const s0 = -L / 2 + pier + span * k, s1 = s0 + span;
        storefront(ctx, F, s0 + (k ? 0.12 : 0), s1 - (k < nS - 1 ? 0.12 : 0), ground - 0.55, addr, type);
        if (k < nS - 1) PB(F.g, type === 'castiron' ? fm : stoneMat(), 0.3, ground - 0.55, 0.12, s1, 0, 0.06, type === 'castiron' ? tint : '#d8d0bf');
      }
      // storefront cornice over the shops
      const sc = mat(type === 'castiron' ? shade(tint, 1.0) : rng.pick(['#3a3a38', '#d8d2c4', '#5a4a3a', '#2e3b2e']), { rough: 0.6, metal: 0.2 });
      F.band(sc, ground - 0.58, 0.22, 0.22, 0.05);
      F.band(sc, ground - 0.36, 0.08, 0.3, 0.08);
      // piers at the ends of the shopfronts
      for (const s2 of [-1, 1]) PB(F.g, type === 'castiron' ? fm : stoneMat(), pier + 0.04, ground, 0.14, s2 * (L / 2 - pier / 2), 0, 0.07, type === 'castiron' ? tint : '#cfc6b3');
    } else if (isFront && type === 'brownstone') {
      // English basement with barred windows under a parlour floor reached by the stoop
      const du = centres[0];
      for (const c of centres) {
        if (c === du) continue;
        F.window(c - ww / 2, 0.3, ww, Math.min(1.05, parlor - 0.55), { ...winOpts, trim: 'flat', ac: 0 });
        for (let k = 1; k < 5; k++) B(F.f, M.iron(), 0.025, Math.min(1.05, parlor - 0.55), 0.025, c - ww / 2 + (k * ww) / 5, 0.3, 0.06, false);
      }
      // basement door under the stoop
      F.cut(du - 0.45, du + 0.45, 0, Math.min(1.9, parlor + 0.1) - 0.15);
      B(F.g, mat('#1e1a16', { rough: 0.6 }), 0.9, Math.min(1.9, parlor) - 0.15, 0.05, du, 0, -0.3, false);
      doorway(F, du, parlor, 1.35, 2.7, rng.pick(['#3b2414', '#2a1a10', '#1d1d1d', '#4a2c1a']), 'hood', tint);
      stoop(F, du, parlor, brownMat(), tint, M.iron());
      colliders.push(F.rectOf(du - 1.2, du + 1.2, 0, 1.1 + Math.round(parlor / 0.19) * 0.3 + 0.3));
      // areaway railing in front of the basement
      const ar = 1.6, au0 = du + 1.3, au1 = L / 2 - 0.05;
      if (au1 - au0 > 1) {
        B(F.g, M.iron(), au1 - au0, 0.04, 0.04, (au0 + au1) / 2, 1.0, ar);
        B(F.g, M.iron(), 0.04, 0.04, ar, au1, 1.0, ar / 2);
        B(F.g, mat('#5a5650', { rough: 0.9 }), au1 - au0, 0.15, 0.2, (au0 + au1) / 2, 0, ar);
        for (let u = au0; u < au1; u += 0.13) B(F.f, M.iron(), 0.02, 1.0, 0.02, u, 0.1, ar, false);
        for (let z = 0.1; z < ar; z += 0.13) B(F.f, M.iron(), 0.02, 1.0, 0.02, au1, 0.1, z, false);
        colliders.push(F.rectOf(au0, au1, 0, ar + 0.1));
      }
      portalDoor(ctx, F, du, 1.1 + Math.round(parlor / 0.19) * 0.3 + 0.5, alongX, addr, floors, 'brownstone', 'house');
    } else if (isFront) {
      // residential entrance on the ground floor, windows either side
      const du = type === 'tenement' ? centres[Math.floor(n / 2)] : 0;
      for (const c of centres) {
        if (Math.abs(c - du) < 1.0) continue;
        F.window(c - ww / 2, 0.9, ww, Math.min(1.9, ground - 1.4), { ...winOpts, ac: 0 });
      }
      const surround = type === 'prewar' ? 'brass' : type === 'midrise' ? 'plain' : rng.pick(['stone', 'plain'] as const);
      B(F.g, mat('#8f8b84', { rough: 0.9 }), 1.9, 0.16, 0.45, du, 0, 0.22);
      doorway(F, du, 0.16, 1.3, Math.min(2.7, ground - 0.5), rng.pick(['#2a2a2a', '#3b2414', '#1d2a22', '#5a3a2a']), surround);
      if (type === 'prewar' && rng.chance(0.75)) canopy(F, du, rng.pick(['#1d3b2e', '#5a1d1d', '#1d2a4a', '#2a2a2a']), 4.2, addr);
      portalDoor(ctx, F, du, 0.8, alongX, addr, floors, type, rng.pick(['apartment', 'apartment', 'office']));
    } else {
      // exposed corner side above the shops: windows on the ground floor too
      for (const c of centres) F.window(c - ww / 2, 1.0, ww, Math.min(1.9, ground - 1.4), { ...winOpts, ac: 0 });
    }
    // ---- walls: rusticated base for pre-war, cast-iron fronts, brick above
    const baseTop = type === 'prewar' ? (levels[1] ?? ground) : type === 'brownstone' ? levels[0] + 4.0 : ground;
    if (type === 'prewar') {
      F.wall(stoneMat(), store && isFront ? ground - 0.55 : 0, baseTop, '#e3dccb', 0.5);
      F.wall(fm, baseTop, h, tint);
      F.band(stoneMat(), baseTop - 0.05, 0.35, 0.12, 0.06);
    } else if (type === 'brownstone') {
      F.wall(brownMat(), 0, baseTop, shade(tint, 1.3), 0.42);
      F.wall(fm, baseTop, h, tint);
      F.band(brownMat(), baseTop - 0.02, 0.18, 0.1, 0.04, false, tint);
    } else {
      F.wall(fm, store && isFront ? ground - 0.55 : 0, h, tint);
    }
    void groundTint;
    // belt courses: sill bands (tenements, pre-war) and entablatures (cast iron)
    const bandM = type === 'castiron' ? mat(shade(tint, 1.02), { rough: 0.6 }) : mat(trimC.getStyle(), { rough: 0.85 });
    if (type === 'castiron') {
      // entablature at every floor line: architrave, frieze, projecting cornice ledge
      for (const ly of levels) {
        F.band(bandM, ly - 0.1, 0.42, 0.16, 0.05);
        F.band(bandM, ly + 0.32, 0.08, 0.32, 0.1);
      }
      // piers with half-columns, capitals and bases between every bay on every floor
      const colM = mat(shade(tint, 1.0), { rough: 0.55, metal: 0.1 });
      for (const ly of levels)
        for (let k = 0; k <= n; k++) {
          const u = -L / 2 + 0.2 + ((L - 0.4) * k) / n;
          PB(F.g, fm, 0.62, fh - 0.4, 0.1, u, ly + 0.4, 0.05, tint);
          C(F.g, colM, 0.21, fh - 1.05, u, ly + 0.62, 0.17);
          B(F.f, colM, 0.56, 0.24, 0.4, u, ly + fh - 0.45, 0.2, false);
          B(F.f, colM, 0.66, 0.08, 0.46, u, ly + fh - 0.21, 0.23, false);
          B(F.f, colM, 0.5, 0.22, 0.38, u, ly + 0.4, 0.19, false);
        }
    } else if (type === 'tenement' && rng.chance(0.6)) {
      for (const ly of levels) F.band(bandM, ly + 0.7, 0.1, 0.07, 0, true);
    } else if (type === 'prewar') {
      F.band(bandM, levels[levels.length - 1] - 0.1, 0.3, 0.1, 0.05);
      // brick quoins at the corners
      for (const s2 of [-1, 1]) for (let yy = baseTop; yy < h - 1.5; yy += 0.6) PB(F.g, stoneMat(), (yy / 0.6) % 2 < 1 ? 0.7 : 0.45, 0.3, 0.05, s2 * (L / 2 - 0.3), yy, 0.025, '#e3dccb', false);
    }
    // ---- cornice
    const cKind: CorniceKind = type === 'midrise' ? 'parapet' : type === 'prewar' ? (rng.chance(0.65) ? 'modillion' : 'deco') : 'bracket';
    const cColor = type === 'brownstone' ? rng.pick(['#3a2a20', '#2a2420', '#5a4a3a', shade(wall, 0.85)]) : type === 'prewar' ? '#d9d1bf' : type === 'castiron' ? shade(tint, 1.0) : rng.pick(CORNICE_PAINT);
    const ex: [boolean, boolean] = [false, false];
    cornice(F, cKind, h, cColor, type === 'castiron' ? 1.3 : type === 'prewar' ? 1.15 : type === 'brownstone' ? 0.85 : 1, ex);
    // ---- fire escape on the front
    if (isFront && (type === 'tenement' || type === 'castiron' || (type === 'midrise' && floors <= 8)) && levels.length >= 2 && rng.chance(type === 'castiron' ? 0.5 : 0.85)) {
      const fw = n >= 4 ? (centres[1] - centres[0]) * 2 + 0.6 : Math.min(L - 0.6, 3.6);
      const fu = n >= 4 ? (rng.chance(0.5) ? (centres[0] + centres[1]) / 2 : (centres[n - 2] + centres[n - 1]) / 2) : 0;
      fireEscape(F, fu, Math.min(fw, L - 0.4), levels.map((l) => l - 0.02), h, rng.pick(['#1c1d1f', '#1c1d1f', '#2a3a2e', '#3a2420']));
    }
  }

  // ---- roof
  const roofY = h - 0.9;
  roof(stat, r, roofY);
  parapet(stat, r, roofY, 1.0, plain, mat('#8a857c', { rough: 0.9 }));
  const along = alongX ? 'x' : 'z';
  if (type === 'brownstone' || type === 'tenement') chimneys(stat, fine, r, roofY, rng, along === 'x' ? 'x' : 'z');
  if (type !== 'brownstone' && rng.chance(0.6)) bulkhead(stat, (r.minX + r.maxX) / 2 + rng.range(-1, 1), roofY, (r.minZ + r.maxZ) / 2, fm, tint, ROT[front] + Math.PI);
  if ((type === 'tenement' || type === 'prewar' || type === 'midrise' || type === 'castiron') && floors >= 5 && rng.chance(type === 'prewar' ? 0.65 : 0.4)) {
    waterTower(stat, fine, (r.minX + r.maxX) / 2 + rng.range(-1, 1), roofY, (r.minZ + r.maxZ) / 2 + rng.range(-2, 2), rng);
  }
  rooftopClutter(stat, fine, r, roofY, rng, type === 'brownstone' ? rng.int(0, 1) : rng.int(1, 3));
  colliders.push({ ...r });
}

function portalDoor(ctx: BCtx, F: Face, u: number, out: number, alongX: boolean, addr: string, floors: number, type: BType, style: string) {
  const entry = F.at(u, 0, out);
  ctx.portals.push({
    box: new THREE.Box3().setFromCenterAndSize(entry.clone().setY(1.5), new THREE.Vector3(alongX ? 2.2 : 2.4, 3, alongX ? 2.4 : 2.2)),
    label: `Enter ${addr}`,
    sub: `${floors}-storey ${type === 'brownstone' ? 'brownstone' : type === 'tower' ? 'office tower' : type === 'castiron' ? 'cast-iron loft' : type === 'prewar' ? 'pre-war apartment house' : 'walk-up'}`,
    target: { kind: 'interior', seed: hashN(ctx.seed, Math.round(entry.x * 10), Math.round(entry.z * 10), 3), name: addr, style, floor: 0, floors: Math.min(floors, 40), biome: 'town' },
  });
  ctx.doors.push(F.at(u, 0, SW));
}

/** glass tower with setbacks: curtain wall, mullion fins, a double-height lobby and a crown */
function tower(ctx: BCtx, r: Rect, front: Side, floors: number, fm: THREE.Material, tint: string, addr: string) {
  const { rng, stat, colliders } = ctx;
  const sides: Side[] = ['N', 'S', 'E', 'W'];
  const lobby = 7.2;
  const h = lobby + floors * 3.6;
  const finM = mat(rng.pick(['#8a9096', '#b8bcc0', '#3a3e42', '#6a6258']), { rough: 0.35, metal: 0.8 });
  const stoneBase = mat(rng.pick(['#2a2c2e', '#8a8680', '#c9c4b8']), { rough: 0.4, metal: 0.1 });
  let rr = { ...r };
  let y = 0;
  const tiers = rng.int(1, 3);
  for (let t = 0; t < tiers; t++) {
    const th = t === tiers - 1 ? h - y : (h - y) * rng.range(0.45, 0.65);
    for (const s of sides) {
      const F = new Face(ctx, rr, s);
      const y0 = t === 0 ? lobby : y;
      F.wall(fm, y0, y + th, tint);
      // vertical mullion fins every 1.5 m and spandrel bands every floor
      const nf = Math.floor(F.len / 1.5);
      for (let k = 0; k <= nf; k++) B(k % 4 ? F.f : F.g, finM, 0.08, y + th - y0, k % 4 ? 0.12 : 0.3, -F.len / 2 + (k * F.len) / nf, y0, k % 4 ? 0.06 : 0.15, false);
      for (let yy = y0 + 3.6; yy < y + th - 0.5; yy += 3.6) B(F.f, finM, F.len, 0.12, 0.05, 0, yy - 0.06, 0.025, false);
      if (t === 0) {
        // lobby: tall glass between stone piers
        const np = Math.max(2, Math.round(F.len / 6));
        for (let k = 0; k <= np; k++) B(F.g, stoneBase, 0.9, lobby, 0.5, -F.len / 2 + 0.45 + ((F.len - 0.9) * k) / np, 0, 0.0);
        B(F.g, stoneBase, F.len, 0.9, 0.55, 0, lobby - 0.9, 0.02);
        for (let k = 0; k < np; k++) {
          const u0 = -F.len / 2 + 0.9 + ((F.len - 0.9) * k) / np, u1 = -F.len / 2 + ((F.len - 0.9) * (k + 1)) / np;
          ctx.win.add({
            m: F.m.clone().multiply(new THREE.Matrix4().makeTranslation(u0, 0.05, -0.25 + REVEAL)), w: u1 - u0, h: lobby - 1.0, trim: 'none', sash: 'store',
            trimColor: new THREE.Color('#888'), revealColor: new THREE.Color('#555'), sashColor: new THREE.Color('#3a3e42'), lit: 1, blind: 0, curtains: 0, depth: 12, muntins: 0,
          });
        }
        if (s === front) {
          // revolving door drum and a name on the canopy
          const dc = F.at(0, 0, 0.9);
          void dc;
          C(F.g, mat('#c9ccce', { rough: 0.1, metal: 0.9 }), 1.1, 2.6, 0, 0, 0.6);
          B(F.g, finM, 4.5, 0.25, 2.4, 0, 3.6, 1.2);
          portalDoor(ctx, F, 0, 1.6, front === 'N' || front === 'S', addr, floors, 'tower', 'office');
          colliders.push(F.rectOf(-1.2, 1.2, 0, 1.8));
        }
      }
    }
    roof(stat, rr, y + th);
    parapet(stat, rr, y + th, 1.2, finM, finM);
    rooftopClutter(stat, ctx.fine, rr, y + th, rng, 3);
    y += th;
    const inset = rng.range(2, 4);
    rr = { minX: rr.minX + inset, maxX: rr.maxX - inset, minZ: rr.minZ + inset, maxZ: rr.maxZ - inset };
    if (rr.maxX - rr.minX < 6 || rr.maxZ - rr.minZ < 6) break;
  }
  if (rng.chance(0.5)) C(stat, M.iron(), 0.12, rng.range(8, 20), (rr.minX + rr.maxX) / 2, y, (rr.minZ + rr.maxZ) / 2);
  colliders.push({ ...r });
}
