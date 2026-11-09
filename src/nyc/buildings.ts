import { fixZFight } from '../zfix';
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
import { buildingDesc } from '../rooms/vertical';

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

/**
 * A building's outline for occlusion culling and HLOD proxies (src/nyc/occlusion.ts, hlod.ts):
 * `rect` its footprint (block-local, like colliders), `h` the full height to the roof/cornice
 * (not water towers or masts), `top` the street-wall height (top of the lowest full-footprint mass,
 * below any setbacks), `side` the street front. `tiers` lists setback masses above it.
 */
export interface Hull {
  rect: Rect;
  h: number;
  top: number;
  side: Side;
  type: BType;
  tiers?: { rect: Rect; y0: number; y1: number }[];
  /** what the far-city proxy (hlod.ts) paints: the facade's own colour, trim, surface class and window rhythm */
  look?: HullLook;
}
export interface HullLook {
  wall: string;
  trim: string;
  /** masonry = punched windows, glass = curtain wall, panel = office panels with punched windows */
  kind: 'masonry' | 'glass' | 'panel';
  /** storey height, ground-floor (storefront/lobby) height, window bay width (m) */
  storey: number;
  ground: number;
  bay: number;
}

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
  /** style of the building being generated (storefronts read it) */
  style: BuildingStyle;
  /** one per building: footprint, full height, street-wall height (occlusion / HLOD contract) */
  hulls: Hull[];
  /** facade groups inside stat (their unit boxes are instanced by finishBuildings) */
  faceGroups: THREE.Object3D[];
}

export function makeCtx(rng: Rng, group: THREE.Group, stat: THREE.Group, cx: number, cz: number, seed: number): BCtx {
  const fine = new THREE.Group();
  return { rng, group, stat, fine, colliders: [], portals: [], cx, cz, seed, doors: [], win: new WindowBatch(), shop: new ShopGlass(), text: new TextBatch(), faceGroups: [], style: {}, hulls: [] };
}

/** bake the block's buildings and add the instanced windows and shop glass */
/**
 * Plain unit boxes and cylinders (brackets, dentils, balusters, rails, cornice bands...) become
 * instances instead of being merged: the same triangles in a fraction of the memory.
 */
const instMats = new Map<string, THREE.MeshStandardMaterial>();
const bars: Partial<Record<'x' | 'y' | 'z', THREE.BufferGeometry>> = {};
/** a unit box without its two end caps along `axis` (for balusters, rails, rungs) */
function openBar(axis: 'x' | 'y' | 'z') {
  if (bars[axis]) return bars[axis]!;
  const g = new THREE.BoxGeometry(1, 1, 1);
  const skip = { x: [0, 1], y: [2, 3], z: [4, 5] }[axis];
  const idx: number[] = [];
  const src = g.index!.array;
  for (let f = 0; f < 6; f++) if (!skip.includes(f)) for (let k = 0; k < 6; k++) idx.push(src[f * 6 + k]);
  g.setIndex(idx);
  return (bars[axis] = g);
}
function instanceUnits(roots: THREE.Object3D[], parent: THREE.Object3D, shadow: boolean) {
  if ((globalThis as { __keepUnits?: boolean }).__keepUnits) return; // tests: leave unit boxes as meshes (z-fight call-site scans)
  const buckets = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial; m: THREE.Matrix4[]; c: THREE.Color[]; cast: boolean }>();
  const dead: THREE.Mesh[] = [];
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (mesh.geometry !== unitBox && mesh.geometry !== unitCyl) || mesh.userData.tint) return;
      const sm = mesh.material as THREE.MeshStandardMaterial;
      if (!sm.isMeshStandardMaterial || sm.map || sm.userData.pbr || sm.transparent || (sm.emissive && sm.emissive.getHex() !== 0 && sm.emissiveIntensity > 0)) return;
      const rough = Math.round(sm.roughness * 2) / 2, metal = sm.metalness >= 0.4 ? 0.6 : 0;
      let gk = mesh.geometry === unitBox ? 'b' : 'c';
      if (gk === 'b') {
        const sc = mesh.scale;
        const thin = [sc.x < 0.06, sc.y < 0.06, sc.z < 0.06].filter(Boolean).length >= 2;
        if (thin) gk = sc.x >= sc.y && sc.x >= sc.z ? 'bx' : sc.y >= sc.z ? 'by' : 'bz';
      }
      // caster hygiene: only big parts (cornice bands, platforms, piers) cast shadows
      const sc = mesh.scale;
      const cast = shadow && mesh.castShadow && Math.max(sc.x, sc.y, sc.z) > 0.8 && Math.min(sc.x, sc.y, sc.z) > 0.05;
      const key = `${gk}|${rough}|${metal}|${cast}`;
      let b = buckets.get(key);
      if (!b) {
        let mm = instMats.get(`${rough}|${metal}`);
        if (!mm) instMats.set(`${rough}|${metal}`, (mm = new THREE.MeshStandardMaterial({ roughness: rough, metalness: metal })));
        buckets.set(key, (b = { geo: gk.length === 2 ? openBar(gk[1] as 'x' | 'y' | 'z') : mesh.geometry, mat: mm, m: [], c: [], cast }));
      }
      b.m.push(mesh.matrixWorld.clone());
      b.c.push(sm.color.clone());
      dead.push(mesh);
    });
  }
  for (const d of dead) d.parent?.remove(d);
  for (const b of buckets.values()) {
    const im = new THREE.InstancedMesh(b.geo, b.mat, b.m.length);
    b.m.forEach((m, i) => {
      im.setMatrixAt(i, m);
      im.setColorAt(i, b.c[i]);
    });
    im.castShadow = b.cast;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    parent.add(im);
  }
}

/** call before bake(stat): pulls the buildings' unit boxes out of stat into instances */
export function finishBuildings(ctx: BCtx) {
  const main = new THREE.Group();
  main.userData.owned = true;
  instanceUnits(ctx.faceGroups, main, true);
  ctx.group.add(main);
  const fine = new THREE.Group();
  instanceUnits([ctx.fine], fine, false);
  fine.add(bake(ctx.fine));
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
const brownMat = () => surface('nyc_castiron', TILE, { vertexColors: true, roughness: 1, normalScale: 1.4, envMapIntensity: 0.4 });

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
    ctx.faceGroups.push(this.g);
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
  /** a world box around a face-local box (portal triggers) */
  boxOf(u0: number, u1: number, z0: number, z1: number, y0: number, y1: number) {
    const r = this.rectOf(u0, u1, z0, z1);
    return new THREE.Box3(new THREE.Vector3(r.minX, y0, r.minZ), new THREE.Vector3(r.maxX, y1, r.maxZ));
  }
  /** player yaw looking out of this face, towards the street */
  yawOut() {
    const n = this.at(0, 0, 1).sub(this.at(0, 0, 0));
    return Math.atan2(-n.x, -n.z);
  }
  /** an opening with an instanced window in it */
  window(u0: number, y0: number, w: number, h: number, o: { trim: TrimKind; sash: SashKind; trimColor: THREE.Color; revealColor: THREE.Color; sashColor: THREE.Color; kind: 'apt' | 'office' | 'loft'; ac?: number; muntins?: number; sleeves?: number }) {
    this.holes.push({ u0, u1: u0 + w, y0, y1: y0 + h });
    const rng = this.ctx.rng;
    const d = dressWindow(rng, o.kind);
    const hasAc = o.ac !== undefined && rng.chance(o.ac);
    const m = this.m.clone().multiply(new THREE.Matrix4().makeTranslation(u0, y0, 0));
    this.ctx.win.add({
      m, w, h, trim: o.trim, sash: o.sash, trimColor: o.trimColor, revealColor: o.revealColor, sashColor: o.sashColor,
      lit: d.lit, blind: hasAc ? Math.max(d.blind, 0.15) : d.blind, curtains: d.curtains, depth: d.depth, muntins: o.muntins ?? 0,
      ac: hasAc ? new THREE.Color(rng.pick(['#d9d6cc', '#c9c6bd', '#e6e3da', '#a9a8a2', '#cfc8b4', '#8f9294', '#e9e6dc'])) : undefined,
      acKind: hasAc ? (o.sleeves && rng.chance(o.sleeves) ? 'sleeve' : rng.chance(0.35) ? 'big' : 'window') : undefined,
      stain: hasAc && rng.chance(0.45),
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
          PB(this.g, m, b - a, s1 - s0 - j, 0.05, (a + b) / 2, s0 + j, 0.034, tint, false); // [zfix] back 9 mm off the wall plane (stoops, door surrounds and sills put theirs at 0, bands at 5 mm)
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
    // [zfix] bands (cornices, belt courses) of neighbouring faces meet at the corners: on the side faces (E/W)
    // they sit 4 mm higher and 4 mm prouder, so their top/bottom faces and the front/back faces' end caps
    // never share a plane with them (they z-fought in a square at every corner)
    // and every band's back stands 5 mm off the wall plane, where rusticated blocks, piers and sills put theirs
    const k = this.side === 'E' || this.side === 'W' ? 0.004 : 0, b = 0.005, d = Math.max(0.01, out + k - b);
    if (m.userData.pbr) return PB(fine ? this.f : this.g, m, this.len + extra * 2, h, d, 0, y + k, b + d / 2, tint, !fine);
    return B(fine ? this.f : this.g, m, this.len + extra * 2, h, d, 0, y + k, b + d / 2, !fine);
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
    F.band(cm, y - 0.3, 0.31, 0.12, -0.2); // [zfix] top 1 cm over the lower step's
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
      B(F.f, cm, bw + 0.008, fh * 0.2 + 0.01, 0.32 * s, u, y - fh * 0.48, 0.16 * s + 0.07, false); // [zfix] 4 mm over and wider than the console
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

/**
 * parapet walls around a roof, with coping. [zfix] The walls stand 2 cm inside the facade planes (flush, their
 * faces z-fought the facade's top storey all round every building), and the side walls and copings stop
 * where the front/back ones begin, so no two faces overlap at the corners.
 */
function parapet(parent: THREE.Object3D, r: Rect, y: number, h: number, wallM: THREE.Material, copeM: THREE.Material) {
  const IN = 0.02;
  const r2 = { minX: r.minX + IN, maxX: r.maxX - IN, minZ: r.minZ + IN, maxZ: r.maxZ - IN };
  const w = r2.maxX - r2.minX, d = r2.maxZ - r2.minZ, cx = (r2.minX + r2.maxX) / 2, cz = (r2.minZ + r2.maxZ) / 2, t = 0.3, c = 0.04;
  B(parent, wallM, w, h, t, cx, y, r2.minZ + t / 2);
  B(parent, wallM, w, h, t, cx, y, r2.maxZ - t / 2);
  B(parent, wallM, t, h, d - 2 * t, r2.minX + t / 2, y, cz);
  B(parent, wallM, t, h, d - 2 * t, r2.maxX - t / 2, y, cz);
  B(parent, copeM, w + 2 * c, 0.08, t + 2 * c, cx, y + h, r2.minZ + t / 2, false);
  B(parent, copeM, w + 2 * c, 0.08, t + 2 * c, cx, y + h, r2.maxZ - t / 2, false);
  B(parent, copeM, t + 2 * c, 0.08, d - 2 * (t + c), r2.minX + t / 2, y + h, cz, false);
  B(parent, copeM, t + 2 * c, 0.08, d - 2 * (t + c), r2.maxX - t / 2, y + h, cz, false);
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
    // life on the balcony: potted plants, a folding chair, a milk crate
    const r = F.ctx.rng;
    if (r.chance(0.35)) {
      const pots = r.int(1, 4);
      for (let k = 0; k < pots; k++) {
        const pu = u0 + 0.3 + r.next() * (w - 0.6), pr = r.range(0.1, 0.18);
        C(F.f, mat(r.pick(['#a0522d', '#8a4a2a', '#6b6b6b', '#2a2a2a']), { rough: 0.9 }), pr, pr * 1.6, pu, y, D - 0.25, false);
        const leaf = new THREE.Mesh(unitSphere, mat(r.pick(['#4f7a34', '#5f8a3c', '#3f6a2c']), { rough: 0.9 }));
        leaf.scale.set(pr * 3, pr * 2.6, pr * 3);
        leaf.position.set(pu, y + pr * 1.6 + pr * 1.1, D - 0.25);
        F.f.add(leaf);
      }
    }
    if (r.chance(0.15)) {
      const cu = u0 + 0.5 + r.next() * (w - 1);
      const cm = mat(r.pick(['#3a6a9a', '#c4c0b4', '#2a2a2a', '#9a3a2a']), { rough: 0.6, metal: 0.3 });
      B(F.f, cm, 0.42, 0.04, 0.4, cu, y + 0.44, 0.55, false);
      B(F.f, cm, 0.42, 0.45, 0.04, cu, y + 0.46, 0.35, false);
      for (const dx of [-0.19, 0.19]) for (const dz of [0.37, 0.73]) B(F.f, cm, 0.025, 0.44, 0.025, cu + dx, y, dz, false);
    }
    if (r.chance(0.12)) B(F.f, mat(r.pick(['#1d5ca8', '#c4161c', '#2a7a3a']), { rough: 0.7 }), 0.33, 0.28, 0.33, u1 - 0.4, y, 0.3, false);
    // diagonal brackets into the wall
    for (const u of [u0 + 0.25, u1 - 0.25]) {
      const br = B(F.g, iron, 0.05, 1.3, 0.05, u, y - 0.9, 0.5);
      br.rotation.x = -0.75;
      br.position.set(u, y - 0.5, D * 0.42);
    }
    // stairs up to the next balcony, alternating direction
    if (i < levels.length - 1) {
      const fh = levels[i + 1] - y;
      const run = fireStairRun(w, fh);
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
/** steps of a stoop up to a parlour floor `parlor` m above the pavement */
export function stoopSteps(parlor: number) {
  const n = Math.round(parlor / 0.18);
  return { n, rise: parlor / n, tread: 0.28, land: 0.9, length: 0.9 + n * 0.28 };
}
/** horizontal run of a fire-escape stair between balconies fh apart on a w-wide escape (~60°) */
export function fireStairRun(w: number, fh: number) {
  return Math.min(w - 0.5, fh * 0.6);
}

function stoop(F: Face, uc: number, parlor: number, stoneM: THREE.Material, tint: string, rail: THREE.Material) {
  const { n, rise, tread, land } = stoopSteps(parlor);
  const w = 1.9;
  const run = n * tread;
  // landing at the door, then the flight down towards the street
  PB(F.g, stoneM, w + 0.5, parlor, land - 0.004, uc, 0, land / 2 + 0.002, tint); // [zfix] back 4 mm off the wall (cheek walls end there)
  for (let k = 0; k < n; k++) {
    const hgt = parlor - (k + 1) * rise + rise;
    PB(F.g, stoneM, w, hgt, tread + 0.02, uc, 0, land + k * tread + tread / 2, tint);
    // nosing
    B(F.f, mat(shade(tint, 0.8), { rough: 0.9 }), w + 0.04, 0.034, 0.036, uc, hgt - 0.03, land + k * tread + 0.014, false); // [zfix] top 4 mm over the tread, back 4 mm off the riser
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
function doorway(F: Face, uc: number, y: number, w: number, h: number, frameColor: string, surround: 'hood' | 'stone' | 'plain' | 'brass', tint?: string, number?: string) {
  F.cut(uc - w / 2, uc + w / 2, y, y + h);
  const depth = 0.55;
  // house number in gilt on the transom, an intercom panel and a lamp beside the door
  if (number) F.ctx.text.add(F.m, number, uc, y + h - Math.min(0.55, h * 0.18) / 2, -depth + 0.035, Math.min(0.3, h * 0.1), w - 0.2, '#d9b25a', 1, 'paint');
  const side = uc + w / 2 + (surround === 'hood' ? 0.42 : 0.3);
  B(F.f, mat('#9a9c9e', { rough: 0.3, metal: 0.8 }), 0.16, 0.3, 0.03, side, y + 1.2, 0.015, false);
  for (let k = 0; k < 4; k++) B(F.f, mat('#2a2a2a', { rough: 0.5 }), 0.03, 0.03, 0.01, side, y + 1.27 + k * 0.05, 0.033, false);
  if (surround !== 'hood') {
    B(F.f, mat('#1c1c1c', { rough: 0.5, metal: 0.5 }), 0.04, 0.04, 0.25, uc - w / 2 - 0.35, y + h - 0.2, 0.12, false);
    B(F.g, mat('#fff1d0', { emissive: '#ffd9a0', ei: 0.8, rough: 0.3 }), 0.16, 0.26, 0.16, uc - w / 2 - 0.35, y + h - 0.45, 0.25, false);
  }
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
    // glazed leaves (full glass in brass lobby doors, upper half in walk-ups, upper third in brownstones):
    // the hall behind shows through, and seamless.ts can preview the lobby
    const g0 = surround === 'brass' ? 0.3 : surround === 'hood' ? dh * 0.6 : dh * 0.48;
    const gw = w / 2 - 0.2, gh = dh - g0 - 0.18;
    F.ctx.shop.add(F.m.clone().multiply(new THREE.Matrix4().makeTranslation(pu - gw / 2, y + g0, -depth + 0.083)), gw, gh, 15, 4.5, 0.5 + s * 0.1, 1);
    if (surround !== 'brass') B(F.f, pan, w / 2 - 0.22, Math.min(dh * 0.3, g0 - 0.3), 0.03, pu, y + 0.15, -depth + 0.09, false);
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

/**
 * Style knobs a district (or anything else) can pass to building(); every field is optional and
 * falls back to the type's defaults.
 */
export interface BuildingStyle {
  /** facade colour (brick/stone/paint), tinting the photo texture */
  wall?: string;
  /** facade material family */
  material?: 'brick' | 'brownstone' | 'limestone' | 'castiron' | 'panel' | 'glass';
  /** window lintels/sills */
  trim?: TrimKind;
  /** cornice: bracketed (19th c.), modillioned (pre-war), Art Deco crown, or a plain parapet */
  cornice?: 'bracket' | 'modillion' | 'deco' | 'parapet';
  cornicePaint?: string;
  /** chances 0..1 */
  fireEscape?: number;
  waterTower?: number;
  acUnits?: number;
  /** storefronts: which SHOPS types to draw from, and how they dress */
  shops?: string[];
  gate?: number;
  awning?: number;
  signs?: ('board' | 'lightbox' | 'letters')[];
}

/**
 * One building. [zfix] Its parts are then de-flickered: coplanar overlapping faces (bands and cornices meeting at
 * corners, sills flush with walls, signs on facades) are lifted apart a few mm (src/zfix.ts), before the chunk bakes.
 */
export function building(ctx: BCtx, r: Rect, front: Side, type: BType, floors: number, store: boolean, cornerSides: [boolean, boolean], opts: BuildingStyle = {}) {
  const parents = [ctx.group, ctx.stat, ctx.fine];
  const n0 = parents.map((p) => p.children.length);
  buildingBody(ctx, r, front, type, floors, store, cornerSides, opts);
  const fresh = parents.flatMap((p, i) => p.children.slice(n0[i]));
  if (ZFIX_ON) fixZFight(fresh, { passes: 2 });
}
/** the per-building runtime z-fight pass: off by default (source fixes instead; it doubled block build time). ?zfix=1 or setZfix(true) */
export let ZFIX_ON = false;
export function setZfix(v: boolean) {
  ZFIX_ON = v;
}

function buildingBody(ctx: BCtx, r: Rect, front: Side, type: BType, floors: number, store: boolean, cornerSides: [boolean, boolean], opts: BuildingStyle = {}) {
  const { rng, stat, fine, colliders } = ctx;
  const matStyle: Record<NonNullable<BuildingStyle['material']>, FacadeStyle> = { brick: 'brick', brownstone: 'brownstone', limestone: 'prewar', castiron: 'castiron', panel: 'panel', glass: 'glass' };
  const style: FacadeStyle = opts.material ? matStyle[opts.material] : ({ brownstone: 'brownstone', tenement: 'brick', prewar: 'prewar', midrise: rng.pick(['brick', 'brick', 'panel'] as const), tower: rng.pick(['glass', 'glass', 'panel'] as const), castiron: 'castiron' }[type] as FacadeStyle);
  ctx.style = opts;
  let wall = {
    brownstone: rng.pick(['#6e4632', '#7a5038', '#5e3c2c', '#83604a']),
    tenement: rng.pick(['#8c3b2a', '#9a5a3c', '#a3683f', '#7a3a2e', '#b58a5a', '#6b4a3a', '#c9b08a']),
    prewar: rng.pick(['#b89d78', '#a8896a', '#9a5a3c', '#c9a982', '#8c4a34']),
    midrise: rng.pick(['#9a8c7c', '#b8b0a2', '#7d6b5a', '#a35a3c']),
    tower: rng.pick(['#7b8d9e', '#6d7f8c', '#8fa1ad', '#5b6670']),
    castiron: rng.pick(['#e2ddd0', '#c9cec9', '#d8ccb0', '#bfbfb8', '#a9b2a8']),
  }[type];
  if (opts.wall) wall = opts.wall;
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
  const parlor = type === 'brownstone' ? rng.range(1.4, 1.7) : 0;
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
  const trim: TrimKind = opts.trim ?? (type === 'brownstone' ? 'hood' : type === 'castiron' ? 'arch' : type === 'tenement' ? rng.pick(['stone', 'stone', 'arch', 'hood', 'flat'] as const) : type === 'prewar' ? rng.pick(['stone', 'flat', 'stone'] as const) : rng.pick(['flat', 'none'] as const));
  const sash: SashKind = type === 'castiron' ? 'case' : type === 'midrise' && style === 'panel' ? 'case' : 'dh';
  const kind = type === 'castiron' ? 'loft' : type === 'midrise' && style === 'panel' ? 'office' : 'apt';
  // window AC units: roughly one window in three or four on walk-ups and pre-war houses (references)
  const acRate = opts.acUnits ?? (type === 'tenement' ? 0.32 : type === 'prewar' ? 0.26 : type === 'midrise' ? 0.24 : type === 'brownstone' ? 0.12 : 0.08);
  const muntins = type === 'brownstone' && rng.chance(0.3) ? 1 : type === 'tenement' && rng.chance(0.15) ? 1 : 0;
  const winOpts = { trim, sash, trimColor: trimC, revealColor: revealC, sashColor: sashC, kind: kind as 'apt' | 'office' | 'loft', ac: acRate, muntins, sleeves: type === 'midrise' ? 0.45 : type === 'prewar' ? 0.25 : 0 };

  for (const s of sides) {
    const isFront = s === front;
    if (!isFront && !exposed(s)) {
      // party wall: common brick, seen above shorter neighbours; sometimes a faded painted ad
      const Fp = new Face(ctx, r, s);
      const pt = softTint(rng.pick(['#8c5a44', '#7a4a3a', '#9a7a62', '#6b5a4e']), 0.3);
      Fp.wall(facadeMat('brick', 1), 0, h, pt);
      if (h > 14 && s !== front && rng.chance(0.12) && Fp.len > 8) {
        const ad = rng.pick(['FURS · STORAGE', 'UNEEDA BISCUIT', 'OMEGA OIL', 'FLETCHER’S CASTORIA', 'HOTEL · ROOMS $2', 'PIANOS', 'COCA-COLA']);
        ctx.text.add(Fp.m, ad, 0, h - 3, 0.02, 1.4, Fp.len * 0.85, rng.pick(['#c9c0a8', '#b8a888', '#d8cfb8']), rng.pick([0, 1, 3]), 'paint');
      }
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
    const flowers = rng.chance(0.4);
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
        // flower boxes on brownstone parlour sills
        if (type === 'brownstone' && i === 0 && isFront && flowers) {
          B(F.g, mat(rng.pick(['#2a2a2a', '#5a3a22', '#1d3b2e']), { rough: 0.8 }), ww + 0.05, 0.25, 0.22, c, wy - 0.02, 0.22);
          for (let k = 0; k < 5; k++) B(F.f, mat(rng.pick(['#4f7a34', '#5f8a3c', '#c4304a', '#e8d24a', '#d86aa0']), { rough: 0.9 }), 0.22, rng.range(0.15, 0.3), 0.2, c - ww / 2 + 0.12 + (k * (ww - 0.2)) / 4, wy + 0.2, 0.22, false);
        }
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
      // the walk-up's own street door in a narrow bay at one end, shops in the rest
      const pier = 0.45;
      const walkup = type !== 'castiron' || rng.chance(0.5);
      const dbay = walkup ? 1.75 : 0;
      const dEnd = rng.chance(0.5) ? -1 : 1;
      let a0 = -L / 2 + pier, a1 = L / 2 - pier;
      if (walkup) {
        const du = dEnd < 0 ? a0 + dbay / 2 : a1 - dbay / 2;
        if (dEnd < 0) a0 += dbay + 0.3; else a1 -= dbay + 0.3;
        PB(F.g, type === 'castiron' ? fm : stoneMat(), 0.3, ground - 0.55, 0.12, dEnd < 0 ? a0 - 0.15 : a1 + 0.15, 0, 0.06, type === 'castiron' ? tint : '#d8d0bf');
        const stepM = mat('#8f8b84', { rough: 0.9 });
        B(F.g, stepM, dbay, 0.3, 0.32, du, 0, 0.16);
        doorway(F, du, 0.3, 1.15, Math.min(2.8, ground - 0.85), rng.pick(['#2a2a2a', '#3b2414', '#1d2a22', '#5a3a2a', '#6a6d70']), 'plain', undefined, addr.split(' ')[0]);
        F.cut(dEnd < 0 ? -L / 2 + pier : a1 + 0.3, dEnd < 0 ? a0 - 0.3 : L / 2 - pier, Math.min(2.8, ground - 0.85) + 0.3, ground - 0.55);
        // transom over the residential door: glazed panel lit from the hall
        ctx.shop.add(F.m.clone().multiply(new THREE.Matrix4().makeTranslation(du - dbay / 2 + 0.05, Math.min(2.8, ground - 0.85) + 0.35, -0.1)), dbay - 0.1, ground - 0.6 - Math.min(2.8, ground - 0.85) - 0.4, 15, 3, 0.3, 1);
        portalDoor(ctx, F, du, 0.8, alongX, addr, floors, type, rng.pick(['apartment', 'apartment', 'office']));
      }
      const nS = Math.max(1, Math.min(3, Math.floor((a1 - a0) / 5.0)));
      const span = (a1 - a0) / nS;
      F.cut(a0, a1, 0, ground - 0.55);
      for (let k = 0; k < nS; k++) {
        const s0 = a0 + span * k, s1 = s0 + span;
        storefront(ctx, F, s0 + (k ? 0.12 : 0), s1 - (k < nS - 1 ? 0.12 : 0), ground - 0.55, addr, type);
        if (k < nS - 1) PB(F.g, type === 'castiron' ? fm : stoneMat(), 0.3, ground - 0.55, 0.12, s1, 0, 0.06, type === 'castiron' ? tint : '#d8d0bf');
      }
      // storefront cornice over the shops
      const sc = mat(type === 'castiron' ? shade(tint, 1.0) : rng.pick(['#3a3a38', '#d8d2c4', '#5a4a3a', '#2e3b2e']), { rough: 0.6, metal: 0.2 });
      F.band(sc, ground - 0.58, 0.22, 0.22, 0.05);
      F.band(sc, ground - 0.36, 0.08, 0.3, 0.08);
      // piers at the ends of the shopfronts
      for (const s2 of [-1, 1]) PB(F.g, type === 'castiron' ? fm : stoneMat(), pier + 0.04, ground, 0.14, s2 * (L / 2 - pier / 2), 0, 0.071, type === 'castiron' ? tint : '#cfc6b3'); // [zfix] back 1 mm off the wall
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
      doorway(F, du, parlor, 1.35, 2.7, rng.pick(['#3b2414', '#2a1a10', '#1d1d1d', '#4a2c1a']), 'hood', tint, addr.split(' ')[0]);
      stoop(F, du, parlor, brownMat(), tint, M.iron());
      colliders.push(F.rectOf(du - 1.2, du + 1.2, 0, stoopSteps(parlor).length + 0.3));
      // areaway railing in front of the basement
      const ar = 1.6, au0 = du + 1.3, au1 = L / 2 - 0.05;
      if (au1 - au0 > 1) {
        B(F.g, M.iron(), au1 - au0, 0.04, 0.04, (au0 + au1) / 2, 1.0, ar);
        B(F.g, M.iron(), 0.04, 0.04, ar - 0.004, au1, 1.0, ar / 2 + 0.002); // [zfix] off the wall plane
        B(F.g, mat('#5a5650', { rough: 0.9 }), au1 - au0, 0.155, 0.2, (au0 + au1) / 2, 0, ar); // [zfix] 5 mm over the sidewalk plane
        for (let u = au0; u < au1; u += 0.13) B(F.f, M.iron(), 0.02, 1.0, 0.02, u, 0.1, ar, false);
        for (let z = 0.1; z < ar; z += 0.13) B(F.f, M.iron(), 0.02, 1.0, 0.02, au1, 0.1, z, false);
        colliders.push(F.rectOf(au0, au1, 0, ar + 0.1));
      }
      portalDoor(ctx, F, du, stoopSteps(parlor).length + 0.5, alongX, addr, floors, 'brownstone', 'house');
    } else if (isFront) {
      const grilles = type !== 'prewar' && rng.chance(0.6);
      // residential entrance on the ground floor, windows either side
      const du = type === 'tenement' ? centres[Math.floor(n / 2)] : 0;
      for (const c of centres) {
        if (Math.abs(c - du) < 1.0) continue;
        const gh = Math.min(1.9, ground - 1.4);
        F.window(c - ww / 2, 0.9, ww, gh, { ...winOpts, ac: 0 });
        // iron security grille over ground-floor windows
        if (grilles) {
          const iron = M.iron();
          for (let k = 0; k <= 5; k++) B(F.f, iron, 0.022, gh + 0.1, 0.022, c - ww / 2 + 0.04 + (k * (ww - 0.08)) / 5, 0.85, 0.12, false);
          for (const yy of [0.88, 0.9 + gh / 2, 0.92 + gh]) B(F.f, iron, ww + 0.1, 0.03, 0.03, c, yy, 0.12, false);
        }
      }
      const surround = type === 'prewar' ? 'brass' : type === 'midrise' ? 'plain' : rng.pick(['stone', 'plain'] as const);
      // two stone steps up from the pavement (which sits at y = 0.15)
      const stepM = mat(rng.pick(['#8f8b84', '#a29c90', '#6f6b66']), { rough: 0.9 });
      B(F.g, stepM, 2.0, 0.32, 0.36, du, 0, 0.18);
      B(F.g, stepM, 2.2, 0.17, 0.7, du, 0, 0.35);
      doorway(F, du, 0.32, 1.3, Math.min(2.7, ground - 0.7), rng.pick(['#2a2a2a', '#3b2414', '#1d2a22', '#5a3a2a']), surround, undefined, addr.split(' ')[0]);
      if (type === 'prewar' && rng.chance(0.75)) canopy(F, du, rng.pick(['#1d3b2e', '#5a1d1d', '#1d2a4a', '#2a2a2a']), 4.2, addr);
      portalDoor(ctx, F, du, 0.8, alongX, addr, floors, type, rng.pick(['apartment', 'apartment', 'office']));
    } else {
      // exposed corner side: corner shops wrap round onto the side street; windows beyond
      let wrap: [number, number] | null = null;
      if (store && L > 9) {
        const cx0 = (r.minX + r.maxX) / 2, cz0 = (r.minZ + r.maxZ) / 2;
        const fc = new THREE.Vector3(front === 'E' ? r.maxX : front === 'W' ? r.minX : cx0, 0, front === 'S' ? r.maxZ : front === 'N' ? r.minZ : cz0);
        const near = F.at(-L / 2, 0, 0).distanceTo(fc) < F.at(L / 2, 0, 0).distanceTo(fc) ? -1 : 1;
        const span = Math.min(L * 0.45, rng.range(5, 8));
        wrap = near < 0 ? [-L / 2 + 0.45, -L / 2 + 0.45 + span] : [L / 2 - 0.45 - span, L / 2 - 0.45];
        F.cut(wrap[0], wrap[1], 0, ground - 0.55);
        storefront(ctx, F, wrap[0], wrap[1], ground - 0.55, addr, type);
        const sc = mat(rng.pick(['#3a3a38', '#d8d2c4', '#5a4a3a']), { rough: 0.6, metal: 0.2 });
        B(F.g, sc, wrap[1] - wrap[0] + 0.3, 0.22, 0.22, (wrap[0] + wrap[1]) / 2, ground - 0.58, 0.11);
      }
      for (const c of centres) {
        if (wrap && c + ww / 2 > wrap[0] - 0.3 && c - ww / 2 < wrap[1] + 0.3) continue;
        F.window(c - ww / 2, 1.0, ww, Math.min(1.9, ground - 1.4), { ...winOpts, ac: 0 });
      }
    }
    // ---- walls: rusticated base for pre-war, cast-iron fronts, brick above
    const baseTop = type === 'prewar' ? (levels[1] ?? ground) : type === 'brownstone' ? levels[0] + 4.0 : ground;
    if (type === 'prewar') {
      F.wall(stoneMat(), store && isFront ? ground - 0.55 : 0, baseTop, '#e3dccb', 0.5);
      F.wall(fm, baseTop, h, tint);
      F.band(stoneMat(), baseTop - 0.05, 0.35, 0.12, 0.06);
    } else if (type === 'brownstone') {
      F.wall(brownMat(), 0, baseTop, shade(tint, 1.05), 0.42);
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
          // [zfix] end piers stay inside the lot (they overlapped the neighbour's at the party line)
          const u = -L / 2 + 0.32 + ((L - 0.64) * k) / n;
          PB(F.g, fm, 0.62, fh - 0.4, 0.1, u, ly + 0.4 + (F.side === 'E' || F.side === 'W' ? 0.004 : 0), 0.05, tint); // [zfix] corner piers of side faces 4 mm up
          C(F.g, colM, 0.21, fh - 1.05, u, ly + 0.62, 0.17);
          // [zfix] capitals and bases 3 mm off the wall, the base 4 mm above the pier's foot
          B(F.f, colM, 0.56, 0.24, 0.4, u, ly + fh - 0.45, 0.203, false);
          B(F.f, colM, 0.66, 0.08, 0.46, u, ly + fh - 0.21, 0.233, false);
          B(F.f, colM, 0.5, 0.22, 0.38, u, ly + 0.404, 0.193, false);
        }
    } else if (type === 'tenement' && rng.chance(0.6)) {
      for (const ly of levels) F.band(bandM, ly + 0.7, 0.1, 0.07, 0, true);
    } else if (type === 'prewar') {
      F.band(bandM, levels[levels.length - 1] - 0.1, 0.3, 0.1, 0.05);
      // brick quoins at the corners
      for (const s2 of [-1, 1]) for (let yy = baseTop; yy < h - 1.5; yy += 0.6) PB(F.g, stoneMat(), ((yy / 0.6) % 2 < 1 ? 0.7 : 0.45) + (F.side === 'E' || F.side === 'W' ? 0.04 : 0), 0.3, F.side === 'E' || F.side === 'W' ? 0.06 : 0.05, s2 * (L / 2 - 0.37), /* [zfix] inside the lot: neighbours' quoins overlapped */ yy + (F.side === 'E' || F.side === 'W' ? 0.004 : 0), F.side === 'E' || F.side === 'W' ? 0.031 : 0.026, '#e3dccb', false); // [zfix] side-face quoins 4 mm up (they cross at the corner)
    }
    // ---- cornice
    const cKind: CorniceKind = opts.cornice ?? (type === 'midrise' ? 'parapet' : type === 'prewar' ? (rng.chance(0.65) ? 'modillion' : 'deco') : 'bracket');
    const cColor = opts.cornicePaint ?? (type === 'brownstone' ? rng.pick(['#3a2a20', '#2a2420', '#5a4a3a', shade(wall, 0.85)]) : type === 'prewar' ? '#d9d1bf' : type === 'castiron' ? shade(tint, 1.0) : rng.pick(CORNICE_PAINT));
    const ex: [boolean, boolean] = [false, false];
    cornice(F, cKind, h, cColor, type === 'castiron' ? 1.3 : type === 'prewar' ? 1.15 : type === 'brownstone' ? 0.85 : 1, ex);
    // tenement name plate: a raised pediment over the cornice with the year (or name) in the frieze
    if (isFront && (type === 'tenement' || type === 'castiron') && rng.chance(0.45)) {
      const pm = mat(cColor, { rough: 0.6, metal: 0.15 });
      const pw = Math.min(L * 0.4, 3.2);
      B(F.g, pm, pw, 0.55, 0.5, 0, h, 0.15);
      B(F.g, pm, pw + 0.2, 0.08, 0.62, 0, h + 0.55, 0.2);
      B(F.f, pm, 0.5, 0.4, 0.3, 0, h + 0.63, 0.12, false);
      const label = rng.chance(0.6) ? String(rng.int(1868, 1912)) : rng.pick(['THE ROSALIND', 'ANNA', 'THE ELDORADO', 'KATHERINE', 'THE MARGARET', 'ESTELLE']);
      ctx.text.add(F.m, label, 0, h - (type === 'castiron' ? 1.3 : 1.0) * 0.72, 0.075, 0.3, Math.min(L * 0.5, 3.5), shade(cColor, 0.55), 1, 'paint');
    }
    // ---- fire escape on the front
    if (isFront && (type === 'tenement' || type === 'castiron' || (type === 'midrise' && floors <= 8)) && levels.length >= 2 && rng.chance(opts.fireEscape ?? (type === 'castiron' ? 0.5 : 0.85))) {
      const fw = n >= 4 ? (centres[1] - centres[0]) * 2 + 0.6 : Math.min(L - 0.6, 3.6);
      const fu = n >= 4 ? (rng.chance(0.5) ? (centres[0] + centres[1]) / 2 : (centres[n - 2] + centres[n - 1]) / 2) : 0;
      fireEscape(F, fu, Math.min(fw, L - 0.4), levels.map((l) => l - 0.02), h, rng.pick(['#1c1d1f', '#1c1d1f', '#232220', '#2b2420', '#2a3a2e', '#3a2420', '#4a2e22']));
    }
  }

  // ---- roof
  const roofY = h - 0.9;
  roof(stat, r, roofY);
  parapet(stat, r, roofY, 1.0, plain, mat('#8a857c', { rough: 0.9 }));
  const along = alongX ? 'x' : 'z';
  if (type === 'brownstone' || type === 'tenement') chimneys(stat, fine, r, roofY, rng, along === 'x' ? 'x' : 'z');
  if (type !== 'brownstone' && rng.chance(0.6)) bulkhead(stat, (r.minX + r.maxX) / 2 + rng.range(-1, 1), roofY, (r.minZ + r.maxZ) / 2, fm, tint, ROT[front] + Math.PI);
  if ((type === 'tenement' || type === 'prewar' || type === 'midrise' || type === 'castiron') && floors >= 5 && rng.chance(opts.waterTower ?? (type === 'prewar' ? 0.65 : 0.4))) {
    waterTower(stat, fine, (r.minX + r.maxX) / 2 + rng.range(-1, 1), roofY, (r.minZ + r.maxZ) / 2 + rng.range(-2, 2), rng);
  }
  rooftopClutter(stat, fine, r, roofY, rng, type === 'brownstone' ? rng.int(0, 1) : rng.int(1, 3));
  colliders.push({ ...r });
  // [hlod look] the proxy's facade colour, class and window rhythm
  const look: HullLook = { wall, trim: '#' + trimC.getHexString(), kind: style === 'glass' ? 'glass' : style === 'panel' ? 'panel' : 'masonry', storey: fh, ground, bay: type === 'castiron' ? 3.1 : type === 'tenement' ? 1.95 : type === 'brownstone' ? 2.2 : style === 'panel' ? 3.1 : 2.3 };
  ctx.hulls.push({ rect: { ...r }, h, top: roofY, side: front, type, look });
}

/** two entrance portals in each other's way (more than 0.3 m both ways) */
export function doorsOverlap(a: THREE.Box3, b: THREE.Box3, p?: { returnPos?: THREE.Vector3 }) {
  if (p && !p.returnPos) return false;
  return Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x) > 0.3 && Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z) > 0.3;
}

function portalDoor(ctx: BCtx, F: Face, u: number, out: number, _alongX: boolean, addr: string, floors: number, type: BType, style: string, glass?: { u0: number; u1: number; y1: number; z: number }) {
  const entry = F.at(u, 0, out);
  // a narrow building's street door can land on its own shop door: keep the shop's (qa: door portals do not overlap)
  if (ctx.portals.some((p) => doorsOverlap(p.box, F.boxOf(u - 1.1, u + 1.1, out - 1.2, out + 1.2, 0, 3), p))) return;
  ctx.portals.push({
    box: F.boxOf(u - 1.1, u + 1.1, out - 1.2, out + 1.2, 0, 3),
    returnPos: F.at(u, 0, out + 1.4),
    returnYaw: F.yawOut(),
    label: `Enter ${addr}`,
    sub: `${floors}-storey ${type === 'brownstone' ? 'brownstone' : type === 'tower' ? 'office tower' : type === 'castiron' ? 'cast-iron loft' : type === 'prewar' ? 'pre-war apartment house' : 'walk-up'}`,
    // vertical.ts hook: walk-ups, pre-war, office and loft buildings open onto their lobby (floors with stairs and lifts); brownstones keep their interior
    target: buildingDesc(type, style, hashN(ctx.seed, Math.round(entry.x * 10), Math.round(entry.z * 10), 3), addr, floors) ?? { kind: 'interior', seed: hashN(ctx.seed, Math.round(entry.x * 10), Math.round(entry.z * 10), 3), name: addr, style, floor: 0, floors: Math.min(floors, 40), biome: 'town' },
    // seamless.ts: the door in the facade (solid, so not seen through): E puts you just inside it
    door: glass
      ? (() => {
          // seamless.ts: the lobby glass is cut away and the prebuilt lobby (src/rooms/vertical.ts) shows behind it
          const r = F.rectOf(glass.u0, glass.u1, glass.z - 0.05, glass.z + 0.05);
          return { pos: F.at(u, 0, 0), yaw: F.yawOut() + Math.PI, see: true, hole: new THREE.Box3(new THREE.Vector3(r.minX, 0, r.minZ), new THREE.Vector3(r.maxX, glass.y1, r.maxZ)) };
        })()
      : { pos: F.at(u, 0, 0), yaw: F.yawOut() + Math.PI },
  });
  ctx.doors.push(F.at(u, 0, SW));
}

/**
 * A tower's double-height lobby front (references: Lever House, Seagram, 590 Madison): polished
 * granite piers, tall glass in slim steel mullions with a transom, the lit lobby behind (the
 * dedicated office interior shader, cuttable so seamless.ts shows the real lobby through
 * it), and on the front a revolving door (glass drum, steel canopy and floor ring, four glass
 * wings) with the building number in steel letters on the canopy.
 */
function towerLobby(ctx: BCtx, F: Face, isFront: boolean, lobby: number, finM: THREE.Material, addr: string, floors: number, front: Side) {
  const { rng, colliders } = ctx;
  const granite = surface('marble', [0.9, lobby], { color: rng.pick(['#3a3836', '#5a5652', '#2a2c2e', '#7a746c']), roughness: 0.18, envMapIntensity: 0.9 });
  const mull = mat('#3a3e42', { rough: 0.35, metal: 0.8 });
  const np = Math.max(2, Math.round(F.len / 6));
  // [zfix] piers stop under the lintel beam; side-face beams sit 4 mm higher (they cross at the corners)
  for (let k = 0; k <= np; k++) B(F.g, granite, 0.9, lobby - 0.9, 0.5, -F.len / 2 + 0.45 + ((F.len - 0.9) * k) / np, 0, 0.0);
  const bk = F.side === 'E' || F.side === 'W' ? 0.004 : 0;
  B(F.g, granite, F.len, 0.9, 0.55, 0, lobby - 0.9 + bk, 0.02 + bk);
  const gz = -0.25 + REVEAL;
  const transom = 3.4;
  const holeU: [number, number] = [Infinity, -Infinity];
  for (let k = 0; k < np; k++) {
    const u0 = -F.len / 2 + 0.9 + ((F.len - 0.9) * k) / np, u1 = -F.len / 2 + ((F.len - 0.9) * (k + 1)) / np;
    const bw = u1 - u0;
    // One double-height room behind the transom, rather than two stacked apartment halls.
    // Cell 16 selects the office lobby shader; cell 15 remains the residential entrance.
    ctx.shop.add(F.m.clone().multiply(new THREE.Matrix4().makeTranslation(u0, 0.05, gz)), bw, lobby - 0.95, 16, 9, 0.4 + k * 0.07, 1);
    holeU[0] = Math.min(holeU[0], u0);
    holeU[1] = Math.max(holeU[1], u1);
    // slim steel mullions every ~1.5 m, a transom bar, a sill
    const nm = Math.max(1, Math.round(bw / 1.5));
    for (let i = 1; i < nm; i++) B(F.f, mull, 0.06, lobby - 0.9, 0.14, u0 + (bw * i) / nm, 0, gz + 0.07, false);
    B(F.f, mull, bw, 0.1, 0.16, (u0 + u1) / 2, transom - 0.02, gz + 0.06, false);
    B(F.f, mull, bw, 0.06, 0.2, (u0 + u1) / 2, 0, gz + 0.08, false);
  }
  if (!isFront) return;
  // revolving door: glass drum half out of the facade, steel canopy and floor ring, four glass wings
  const R = 1.1, cz = 0.55, H = 2.4;
  const steel = mat('#b9bcbf', { rough: 0.25, metal: 0.9 });
  const glass = revolvingGlass();
  C(F.g, steel, R + 0.12, 0.32, 0, H, cz);
  C(F.f, mat('#5a5e62', { rough: 0.4, metal: 0.8 }), R + 0.04, 0.02, 0, 0, cz, false);
  for (const side of [-1, 1]) {
    // curved glass on the two sides, open front and back
    const a0 = side > 0 ? Math.PI * 0.22 : Math.PI * 1.22;
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, 20, 1, true, a0, Math.PI * 0.56), glass);
    drum.position.set(0, H / 2, cz);
    F.f.add(drum);
    for (const a of [a0, a0 + Math.PI * 0.56]) B(F.f, steel, 0.06, H, 0.06, Math.sin(a) * R, 0, cz + Math.cos(a) * R, false);
  }
  // wings at 45°, a steel post and push bars
  C(F.f, steel, 0.05, H, 0, 0, cz, false);
  for (const a of [Math.PI / 4, -Math.PI / 4]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(2 * R - 0.08, H - 0.1, 0.02), glass);
    wing.position.set(0, H / 2, cz);
    wing.rotation.y = a;
    F.f.add(wing);
    for (const y of [0.04, H - 0.06, 1.05]) {
      const bar = B(F.f, steel, 2 * R - 0.08, y === 1.05 ? 0.04 : 0.06, y === 1.05 ? 0.05 : 0.04, 0, y, cz, false);
      bar.rotation.y = a;
    }
  }
  // the building number in steel letters on the canopy face, and a name over the transom
  ctx.text.add(F.m, addr.split(' ')[0], 0, H + 0.08, cz + R + 0.13, 0.2, 1.6, '#e4e6e8', 0, 'paint');
  ctx.text.add(F.m, addr.toUpperCase(), 0, lobby - 0.62, 0.3, 0.32, Math.min(F.len * 0.5, 9), '#d8dadc', 0, 'paint');
  portalDoor(ctx, F, 0, 1.6, front === 'N' || front === 'S', addr, floors, 'tower', 'office', { u0: holeU[0], u1: holeU[1], y1: transom, z: gz });
  colliders.push(F.rectOf(-1.25, 1.25, 0, cz + R + 0.1));
}
let revGlass: THREE.MeshStandardMaterial | null = null;
const revolvingGlass = () => (revGlass ??= new THREE.MeshStandardMaterial({ color: '#cfdde2', roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));

/** glass tower with setbacks: curtain wall, mullion fins, a double-height lobby and a crown */
function tower(ctx: BCtx, r: Rect, front: Side, floors: number, fm: THREE.Material, tint: string, addr: string) {
  const { rng, stat, colliders } = ctx;
  const sides: Side[] = ['N', 'S', 'E', 'W'];
  const lobby = 7.2;
  const h = lobby + floors * 3.6;
  const finM = mat(rng.pick(['#8a9096', '#b8bcc0', '#3a3e42', '#6a6258']), { rough: 0.35, metal: 0.8 });
  rng.pick(['#2a2c2e', '#8a8680', '#c9c4b8']); // (the lobby stone: towerLobby picks its own; keeps the rng sequence)
  const curtain = rng.chance(0.6);
  const spandrelHex = rng.pick(['#2a3138', '#3a4048', '#1e2428', '#4a5058', '#5a5650']);
  const spandrel = mat(spandrelHex, { rough: 0.25, metal: 0.7 });
  const spandrelC = new THREE.Color(spandrelHex);
  const panelM = facadeMat('panel', rng.int(0, 2));
  const panelBase = rng.pick(['#b8b0a2', '#9a8c7c', '#c9c4b8', '#8a8680']);
  const panelTint = softTint(panelBase, 0.4);
  void fm;
  let rr = { ...r };
  let y = 0;
  const tiers = rng.int(1, 3);
  const hullTiers: { rect: Rect; y0: number; y1: number }[] = [];
  for (let t = 0; t < tiers; t++) {
    const th = t === tiers - 1 ? h - y : (h - y) * rng.range(0.45, 0.65);
    for (const s of sides) {
      const F = new Face(ctx, rr, s);
      const y0 = t === 0 ? lobby : y;
      // vertical mullion fins every 1.5 m and spandrel bands every floor
      const nf = Math.floor(F.len / 1.5);
      // office floors: tall glazing (curtain wall) or punched windows in panels, offices behind
      const bw = F.len / nf;
      for (let fy = lobby; fy + 3.6 <= y + th + 0.01; fy += 3.6) {
        if (fy < y0 - 0.01) continue;
        for (let k = 0; k < nf; k++) {
          const u = -F.len / 2 + bw * k + 0.06;
          if (curtain) F.window(u, fy + 0.25, bw - 0.12, 3.05, { trim: 'none', sash: 'none', trimColor: spandrelC, revealColor: spandrelC, sashColor: spandrelC, kind: 'office' });
          else F.window(u + 0.2, fy + 0.9, bw - 0.52, 1.9, { trim: 'none', sash: 'case', trimColor: spandrelC, revealColor: new THREE.Color(panelTint).multiplyScalar(0.6), sashColor: spandrelC, kind: 'office' });
        }
      }
      F.wall(curtain ? spandrel : panelM, y0, y + th, curtain ? undefined : panelTint);
      // [zfix] k < nf: each corner gets one fin (from the face where it is k = 0), not two crossing ones;
      // floor bands start 3 mm off the wall so their backs don't share the fins' plane
      for (let k = 0; k < nf; k++) B(k % 4 ? F.f : F.g, finM, 0.08, y + th - y0, k % 4 ? 0.12 : 0.3, -F.len / 2 + (k * F.len) / nf, y0, k % 4 ? 0.06 : 0.15, false);
      for (let yy = y0 + 3.6; yy < y + th - 0.5; yy += 3.6) B(F.f, finM, F.len, 0.12, 0.05, 0, yy - 0.06, 0.028, false);
      if (t === 0) towerLobby(ctx, F, s === front, lobby, finM, addr, floors, front);
    }
    hullTiers.push({ rect: { ...rr }, y0: y, y1: y + th });
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
  // [hlod look] curtain wall (spandrel glass) or punched office panels, 3.6 m floors over a 7.2 m lobby
  const look: HullLook = { wall: curtain ? spandrelHex : panelBase, trim: '#' + (finM as THREE.MeshStandardMaterial).color.getHexString(), kind: curtain ? 'glass' : 'panel', storey: 3.6, ground: lobby, bay: 1.5 };
  ctx.hulls.push({ rect: { ...r }, h: y, top: hullTiers[0].y1, side: front, type: 'tower', tiers: hullTiers, look });
}
