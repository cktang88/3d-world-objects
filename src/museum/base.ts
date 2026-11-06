import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Env, Level, Portal, Rect } from '../level';
import { rect } from '../level';
import { loadRemote, animate, disposeModel, clearQueue, isRebuilt, DATASET_LABEL, type RemoteModel } from '../remote';
import { trackForDetail } from '../detail';
import type { Measured } from './sizes';
import { fmtDims } from './text';

// ---------------------------------------------------------------- frames & batching

/** A local frame on the floor: origin (x, z), turned by `rot` about Y. Local +z is the display's front. */
export class Frame {
  readonly m = new THREE.Matrix4();
  constructor(readonly x: number, readonly z: number, readonly rot = 0, readonly y = 0) {
    this.m.makeRotationY(rot).setPosition(x, y, z);
  }
  point(lx: number, ly: number, lz: number) {
    return new THREE.Vector3(lx, ly, lz).applyMatrix4(this.m);
  }
  /** world AABB of a local w x d rectangle centred at (lx, lz) */
  rect(lx: number, lz: number, w: number, d: number): Rect {
    const c = this.point(lx, 0, lz);
    const cs = Math.abs(Math.cos(this.rot)), sn = Math.abs(Math.sin(this.rot));
    return rect(c.x, c.z, w * cs + d * sn, w * sn + d * cs);
  }
  sub(lx: number, lz: number, rot = 0) {
    const p = this.point(lx, 0, lz);
    return new Frame(p.x, p.z, this.rot + rot, this.y);
  }
}
export const WORLD = new Frame(0, 0, 0);

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 18);
const unitCyl8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);

/** Collects static geometry per material and merges it: a whole room is a few dozen draw calls. */
class Batcher {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  add(mat: THREE.Material, geo: THREE.BufferGeometry, m: THREE.Matrix4) {
    const g = geo.index ? geo.clone() : geo.clone();
    g.applyMatrix4(m);
    let l = this.parts.get(mat);
    if (!l) this.parts.set(mat, (l = []));
    l.push(g);
  }
  flush(group: THREE.Group, shadows: boolean) {
    for (const [mat, list] of this.parts) {
      if (mat.userData.worldUV) for (const g of list) worldUV(g);
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.userData.owned = true;
      mesh.receiveShadow = true;
      mesh.castShadow = shadows && !(mat as THREE.MeshStandardMaterial).transparent;
      if ((mat as THREE.MeshStandardMaterial).transparent) mesh.renderOrder = 2;
      group.add(mesh);
    }
    this.parts.clear();
  }
}

/** UVs in metres from world position, projected along the dominant normal axis. */
function worldUV(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position'), n = g.getAttribute('normal'), uv = g.getAttribute('uv') as THREE.BufferAttribute;
  if (!uv) return;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    if (ay >= ax && ay >= az) uv.setXY(i, p.getX(i), p.getZ(i));
    else if (ax >= az) uv.setXY(i, p.getZ(i), p.getY(i));
    else uv.setXY(i, p.getX(i), p.getY(i));
  }
}

// ---------------------------------------------------------------- light pools

let poolTex: THREE.Texture | null = null;
function poolTexture() {
  if (poolTex) return poolTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  gr.addColorStop(0.8, 'rgba(255,255,255,0.12)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  poolTex = new THREE.CanvasTexture(c);
  return poolTex;
}
const poolMats = new Map<string, THREE.MeshBasicMaterial>();
function poolMat(color: string, opacity: number) {
  const k = `${color}|${opacity.toFixed(2)}`;
  let m = poolMats.get(k);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ map: poolTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, toneMapped: false });
    poolMats.set(k, m);
  }
  return m;
}
const unitPlane = new THREE.PlaneGeometry(1, 1);

// ---------------------------------------------------------------- exhibits

interface Slot {
  m: Measured;
  holder: THREE.Group;
  at: THREE.Vector3;
  model?: RemoteModel;
  spin: number;
  placeholder: THREE.Mesh;
  /** library scans: which detail is shown, and whether a swap is under way */
  q?: 'low' | 'full';
  swapping?: boolean;
}

/** full-detail scans (~150k faces, 2k textures) only for the nearest few */
const FULL_SCANS = 3;

const phMat = new THREE.MeshBasicMaterial({ color: '#ffe9b0', wireframe: true, transparent: true, opacity: 0.35 });
const phGeo = new THREE.IcosahedronGeometry(0.5, 1);

/**
 * Merge a static model's meshes by material, in the model's own frame: draw calls drop from one
 * per part to one per material. Geometry shared with a cache (userData.shared) is left alone and
 * copied; the model's own part geometries are disposed.
 */
export function mergeStatic(root: THREE.Object3D, moving: Set<THREE.Object3D> = new Set()) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const groups = new Map<string, { mat: THREE.Material | THREE.Material[]; geos: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>();
  const movingUnder = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (moving.has(p)) return true;
    return false;
  };
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.SkinnedMesh).isSkinnedMesh || Array.isArray(m.material) || movingUnder(m)) return;
    const g = m.geometry;
    const sig = Object.keys(g.attributes).sort().join(',') + (g.index ? '|i' : '|n');
    const key = `${matKey(m.material as THREE.Material)}|${g.getAttribute('color') ? 'c' : ''}`;
    void sig;
    let e = groups.get(key);
    if (!e) groups.set(key, (e = { mat: m.material, geos: [], meshes: [] }));
    const c = g.clone();
    c.applyMatrix4(inv.clone().multiply(m.matrixWorld));
    e.geos.push(c);
    e.meshes.push(m);
  });
  let total = 0;
  for (const e of groups.values()) total += e.meshes.length;
  if (total < 4 || groups.size >= total) {
    for (const e of groups.values()) for (const g of e.geos) g.dispose();
    return;
  }
  const out: THREE.Mesh[] = [];
  for (const e of groups.values()) {
    const merged = e.geos.length === 1 ? e.geos[0] : concatGeometries(e.geos);
    if (!merged) {
      for (const g of e.geos) g.dispose();
      return; // leave the model as it was
    }
    if (e.geos.length > 1) for (const g of e.geos) g.dispose();
    const mm = new THREE.Mesh(merged, e.mat);
    mm.castShadow = e.meshes[0].castShadow;
    mm.receiveShadow = e.meshes[0].receiveShadow;
    out.push(mm);
  }
  for (const e of groups.values()) for (const m of e.meshes) {
    if (!m.userData.shared) m.geometry.dispose();
    m.removeFromParent();
  }
  // the merged meshes sit in the model's frame; moving parts (and their nodes) stay where they are
  for (const m of out) root.add(m);
  root.updateMatrixWorld(true);
}

/**
 * Which way a model faces, relative to `want` (a horizontal axis in its own frame). No front is
 * recorded in the datasets, so it is read from the geometry: the detailed side of a thing (piano
 * keys, a screen, drawer fronts) carries far more vertices near its face than a flat back panel.
 * Counts the vertices in the outer 20% slab on the wanted side and on the opposite one.
 * 'flip' when the opposite side is clearly busier, 'keep' when the wanted side is, else 'guess'
 * (left as modelled).
 */
export function frontOf(root: THREE.Object3D, want: THREE.Vector3): 'keep' | 'flip' | 'guess' {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const axis = Math.abs(want.x) > Math.abs(want.z) ? 'x' : 'z';
  const sign = Math.sign(axis === 'x' ? want.x : want.z) || 1;
  const vals: number[] = [];
  const v = new THREE.Vector3();
  const mm = new THREE.Matrix4();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const p = m.geometry.getAttribute('position');
    if (!p) return;
    mm.multiplyMatrices(inv, m.matrixWorld);
    const step = Math.max(1, Math.floor(p.count / 4000));
    for (let i = 0; i < p.count; i += step) {
      v.fromBufferAttribute(p, i).applyMatrix4(mm);
      vals.push(axis === 'x' ? v.x : v.z);
    }
  });
  if (vals.length < 40) return 'guess';
  let lo = Infinity, hi = -Infinity;
  for (const x of vals) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  const band = (hi - lo) * 0.2;
  if (!(band > 1e-4)) return 'guess';
  let nHi = 0, nLo = 0;
  for (const x of vals) {
    if (x > hi - band) nHi++;
    if (x < lo + band) nLo++;
  }
  const wanted = sign > 0 ? nHi : nLo, other = sign > 0 ? nLo : nHi;
  if (other > wanted * 1.6 + 20) return 'flip';
  if (wanted > other * 1.6 + 20) return 'keep';
  return 'guess';
}

/** do an object's sorted dimensions have the proportions of `raw` (within 35%)? */
function proportionsMatch(o: THREE.Object3D, raw: THREE.Vector3) {
  const b = new THREE.Box3().setFromObject(o);
  if (b.isEmpty()) return true;
  const g = b.getSize(new THREE.Vector3());
  const a = [g.x, g.y, g.z], r = [raw.x, raw.y, raw.z];
  const ga = Math.max(...a), ra = Math.max(...r);
  if (!(ga > 0 && ra > 0)) return true;
  // per axis, as fractions of the largest dimension (the up axis must agree too)
  return a.every((v, i) => Math.abs(v / ga - r[i] / ra) < 0.35 * Math.max(r[i] / ra, 0.25));
}

export function easeOut(t: number) {
  return 1 - (1 - t) ** 3;
}

export function shade(hex: string, f: number) {
  return `#${new THREE.Color(hex).multiplyScalar(f).getHexString()}`;
}

export abstract class MuseumBase implements Level {
  abstract name: string;
  group = new THREE.Group();
  spawn = { pos: new THREE.Vector3(), yaw: 0 };
  env: Env = {
    skyTop: '#16130f', skyBottom: '#211c16', stars: false, fog: null, fogNear: 0, fogFar: 0, sun: null,
    hemi: { sky: '#fff6e8', ground: '#4a4036', intensity: 0.85 }, ambient: 0.12, envIntensity: 0.55, exposure: 1.0,
  };
  protected cols: Rect[] = [];
  protected ports: Portal[] = [];
  protected slots: Slot[] = [];
  protected alive = true;
  protected batch = new Batcher();
  protected spots = 0;
  protected maxSpots = 10;
  /** resolves when the room is built and every exhibit has arrived (for the lab) */
  ready: Promise<void> = Promise.resolve();
  /** the doorway you come in by, for seamless.ts (galleries: their south entrance) */
  doorway?: Level['doorway'];
  /** resolves when the room itself is built (exhibit models may still be streaming in); `ready` waits for those too */
  built: Promise<void>;
  protected markBuilt: () => void = () => {};
  private pendingLoads: Promise<unknown>[] = [];

  constructor() {
    this.rig();
    this.built = new Promise<void>((r) => (this.markBuilt = r));
  }

  colliders() {
    return this.cols;
  }
  portals() {
    return this.ports;
  }

  private tick = 0;
  /** how exhibits were turned to face the visitor: kept, flipped (both confident), or guessed */
  fronts = { keep: 0, flip: 0, guess: 0 };
  private fills = new Map<THREE.Mesh, { own: THREE.Material; fill: THREE.Material }>();
  /**
   * While seen through a doorway the room has no lights of its own (seamless.ts strips them), so its
   * shell and cases glow a little instead: an emissive copy of each merged material, swapped in.
   */
  private previewFill(on: boolean) {
    if (on && !this.fills.size) {
      for (const o of this.group.children) {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.userData.owned || m.userData.tex) continue;
        const own = m.material as THREE.MeshStandardMaterial;
        if (!own.isMeshStandardMaterial || own.transparent) continue;
        const fill = own.clone();
        fill.emissive = own.color.clone().multiplyScalar(this.fillLevel);
        if (own.map) fill.emissiveMap = own.map;
        fill.userData = { ...own.userData };
        this.fills.set(m, { own, fill });
      }
    }
    for (const [m, f] of this.fills) m.material = on ? f.fill : f.own;
  }
  /** how strongly the shell glows while previewed (dark rooms less) */
  protected fillLevel = 0.45;
  private outside = false;
  /**
   * Seen from outside (through another room's doorway, see seamless.ts: the player is in front of
   * this room's entrance, local z > 0), only what can be seen through the opening is drawn: exhibits,
   * labels and light pools in a cone through the doorway and within ~22 m of it. The room's shell
   * (a few merged meshes) always draws.
   */
  private cullOutside(player: THREE.Vector3) {
    const out = player.z > 0.2 && this.doorway !== undefined;
    if (!out && !this.outside) return;
    this.outside = out;
    this.previewFill(out);
    for (const o of this.group.children) {
      const m = o as THREE.Mesh;
      const detail = o.userData.baseScale !== undefined || o.userData.exhibit || o.userData.tex || (m.isMesh && (m.material as THREE.Material).blending === THREE.AdditiveBlending);
      if (!detail) continue;
      const p = o.position;
      o.visible = !out || (p.z > -22 && Math.abs(p.x) < Math.abs(p.z) * 0.75 + 2.5);
    }
  }
  /** the nearest few library scans within reach get their full-detail version; the rest stay low */
  private scanDetail(player: THREE.Vector3) {
    const scans = this.slots.filter((s) => s.m.loadQ && s.model && !s.swapping);
    if (!scans.length) return;
    const near = scans.map((s) => ({ s, d: s.at.distanceTo(player) })).sort((a, b) => a.d - b.d);
    near.forEach(({ s, d }, i) => {
      const want = i < FULL_SCANS && d < 7 ? 'full' : d > 11 || i >= FULL_SCANS + 2 ? 'low' : s.q;
      if (!want || want === s.q) return;
      s.swapping = true;
      s.m.loadQ!(want)
        .then((mod) => {
          s.swapping = false;
          if (!this.alive || !s.model) return;
          s.holder.remove(s.model.object);
          s.holder.add(mod.object);
          s.model = mod;
          s.q = want;
        })
        .catch(() => (s.swapping = false));
    });
  }

  update(dt: number, player: THREE.Vector3, time: number) {
    if (++this.tick % 30 === 0) this.scanDetail(player);
    if (this.tick % 15 === 0) this.cullOutside(player);
    for (const s of this.slots) {
      if (!s.model) {
        s.placeholder.rotation.y += dt;
        s.placeholder.rotation.x += dt * 0.6;
        continue;
      }
      if (s.spin) s.holder.rotation.y += dt * s.spin;
      if (s.model.animator && s.at.distanceToSquared(player) < 625) animate(s.model.animator, time);
      const f = s.holder.userData.fade as number | undefined;
      if (f !== undefined && f < 1) {
        const v = Math.min(1, f + dt * 2.5);
        s.holder.userData.fade = v;
        s.holder.scale.setScalar((s.holder.userData.baseScale as number) * (0.85 + 0.15 * easeOut(v)));
      }
    }
  }

  dispose() {
    this.alive = false;
    clearQueue();
    this.group.traverse((o) => {
      o.userData.disposed = true;
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData.owned) {
        m.geometry.dispose();
        (m.material as THREE.MeshBasicMaterial).map?.dispose();
      }
    });
    for (const s of this.slots) if (s.model) disposeModel(s.model.object);
    for (const f of this.fills.values()) f.fill.dispose();
  }

  /** wait for every exhibit queued so far */
  protected settle() {
    return Promise.allSettled(this.pendingLoads).then(() => undefined);
  }

  // ---- static geometry (merged at flush)

  bx(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, f: Frame = WORLD, rotY = 0) {
    const m = new THREE.Matrix4().makeRotationY(rotY).scale(new THREE.Vector3(w, h, d)).setPosition(x, y + h / 2, z);
    this.batch.add(mat, unitBox, f.m.clone().multiply(m));
  }
  cy(mat: THREE.Material, r: number, h: number, x: number, y: number, z: number, f: Frame = WORLD, lowpoly = false) {
    const m = new THREE.Matrix4().makeScale(r * 2, h, r * 2).setPosition(x, y + h / 2, z);
    this.batch.add(mat, lowpoly ? unitCyl8 : unitCyl, f.m.clone().multiply(m));
  }
  /** a rod between two world points */
  rod(mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, r: number, lowpoly = true) {
    const d = b.clone().sub(a);
    const len = d.length();
    if (len < 1e-4) return;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(r * 2, len, r * 2));
    this.batch.add(mat, lowpoly ? unitCyl8 : unitCyl, m);
  }
  geo(mat: THREE.Material, g: THREE.BufferGeometry, m: THREE.Matrix4) {
    this.batch.add(mat, g, m);
  }
  col(f: Frame, lx: number, lz: number, w: number, d: number) {
    this.cols.push(f.rect(lx, lz, w, d));
  }
  flush(shadows = false) {
    this.batch.flush(this.group, shadows);
  }

  // ---- light

  /** a pool of light on a surface (cheap: an additive decal) */
  pool(x: number, y: number, z: number, r: number, color = '#ffe7c2', opacity = 0.35) {
    // capped so a pool never blows out under bloom; merged with the room's other pools (one draw)
    const rr = Math.min(r, 3);
    const op = Math.min(opacity, 0.22);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y + 0.006, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2), new THREE.Vector3(rr * 2, rr * 2, 1));
    this.geo(poolMat(color, op), unitPlane, m);
  }

  /**
   * Every museum room carries the same light rig (RIG_SPOTS spotlights, RIG_POINTS point lights,
   * no shadows), unused ones dark: the light count never changes between rooms, so moving from
   * room to room never recompiles a shader.
   */
  static readonly RIG_SPOTS = 10;
  static readonly RIG_POINTS = 3;
  private rigSpots: THREE.SpotLight[] = [];
  private rigPoints: THREE.PointLight[] = [];
  private points = 0;
  private rig() {
    if (this.rigSpots.length) return;
    for (let i = 0; i < MuseumBase.RIG_SPOTS; i++) {
      const l = new THREE.SpotLight('#fff1dc', 0, 0, 0.4, 0.65, 2);
      l.castShadow = false;
      // parked far below until used: a preview (seamless.ts) lends its two shared lights to the
      // lights nearest the viewer, and an unused one must never be the nearest
      l.position.set(0, -1e4, 0);
      this.rigSpots.push(l);
      this.group.add(l, l.target);
    }
    for (let i = 0; i < MuseumBase.RIG_POINTS; i++) {
      const l = new THREE.PointLight('#fff1dc', 0, 10, 1.4);
      l.castShadow = false;
      l.position.set(0, -1e4, 0);
      this.rigPoints.push(l);
      this.group.add(l);
    }
  }

  /** a real spotlight from the rig, if the room's budget allows */
  spot(from: THREE.Vector3, to: THREE.Vector3, opts: { color?: string; boost?: number; angle?: number } = {}) {
    this.rig();
    if (this.spots >= Math.min(this.maxSpots, MuseumBase.RIG_SPOTS)) return false;
    const l = this.rigSpots[this.spots++];
    const d = from.distanceTo(to);
    l.color.set(opts.color ?? '#fff1dc');
    l.intensity = (opts.boost ?? 8) * d * d;
    l.angle = opts.angle ?? 0.38;
    l.position.copy(from);
    l.target.position.copy(to);
    return true;
  }

  /** a point light from the rig (the last one is kept for previewLight) */
  point(at: THREE.Vector3, color: string, intensity: number, distance: number, decay = 1.4) {
    this.rig();
    if (this.points >= MuseumBase.RIG_POINTS - 1) return null;
    const l = this.rigPoints[this.points++];
    l.color.set(color);
    l.intensity = intensity;
    l.distance = distance;
    l.decay = decay;
    l.position.copy(at);
    return l;
  }

  /**
   * The light that stands in for the whole room while it is seen through a doorway: dark inside
   * the room (intensity 0), but placed just inside the entrance with `userData.base` set, so it is
   * the light seamless.ts lends its shared preview light to.
   */
  previewLight(at: THREE.Vector3, color: string, base: number, distance: number) {
    this.rig();
    const l = this.rigPoints[MuseumBase.RIG_POINTS - 1];
    l.color.set(color);
    l.intensity = 0;
    l.userData.base = base;
    l.distance = distance;
    l.decay = 1.2;
    l.position.copy(at);
  }

  /** give the rig back (e.g. when a waiting room is replaced by the real one) */
  protected resetRig() {
    this.spots = this.points = 0;
    for (const l of [...this.rigSpots, ...this.rigPoints]) {
      l.intensity = 0;
      l.position.set(0, -1e4, 0);
      delete l.userData.base;
    }
  }

  /** a track-light can at `from` aimed at `to` (merged geometry; emissive lens) */
  fixture(from: THREE.Vector3, to: THREE.Vector3, body: THREE.Material, lens: THREE.Material, size = 1) {
    const dir = to.clone().sub(from).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
    const s = size;
    this.geo(body, unitCyl8, new THREE.Matrix4().compose(from.clone().addScaledVector(dir, 0.05 * s), q, new THREE.Vector3(0.11 * s, 0.2 * s, 0.11 * s)));
    this.geo(lens, unitCyl8, new THREE.Matrix4().compose(from.clone().addScaledVector(dir, 0.155 * s), q, new THREE.Vector3(0.09 * s, 0.01, 0.09 * s)));
    // stem up to the track
    this.geo(body, unitBox, new THREE.Matrix4().compose(from.clone().add(new THREE.Vector3(0, 0.07 * s, 0)), new THREE.Quaternion(), new THREE.Vector3(0.025, 0.14 * s, 0.025)));
  }

  // ---- exhibits

  /**
   * Show an object at its real size. (lx, ly, lz) in frame f is where its base centre goes;
   * `rot` turns it about Y. Never scaled down: the only scale applied is the realScale correction.
   */
  exhibit(m: Measured, f: Frame, lx: number, ly: number, lz: number, rot = 0, opts: { prio?: number; spin?: number; label?: string; progressive?: boolean; face?: boolean } = {}) {
    const at = f.point(lx, ly, lz);
    const holder = new THREE.Group();
    holder.userData.exhibit = true;
    holder.position.copy(at);
    holder.rotation.y = f.rot + rot;
    const placeholder = new THREE.Mesh(phGeo, phMat);
    const ph = Math.min(m.real.x, m.real.y, m.real.z, 0.4);
    placeholder.scale.setScalar(Math.max(0.03, ph));
    placeholder.position.y = Math.min(m.real.y / 2, 0.5);
    holder.add(placeholder);
    this.group.add(holder);
    const slot: Slot = { m, holder, at, spin: opts.spin ?? 0, placeholder };
    this.slots.push(slot);
    // the inspect box: the object's real bounds, turned
    const a = f.rot + rot, cs = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
    const R = slot.spin ? Math.hypot(m.real.x, m.real.z) / 2 : 0;
    const hw = R || (m.real.x * cs + m.real.z * sn) / 2, hd = R || (m.real.x * sn + m.real.z * cs) / 2;
    const e = m.entry;
    const bx = new THREE.Box3(new THREE.Vector3(at.x - hw, at.y, at.z - hd), new THREE.Vector3(at.x + hw, at.y + m.real.y, at.z + hd));
    // tiny things are hard to aim at: give them a slightly bigger target
    bx.expandByScalar(Math.max(0, 0.06 - Math.min(hw, hd, m.real.y / 2)));
    this.ports.push({
      box: bx,
      label: e.title,
      sub: `${fmtDims(m.real)} · ${DATASET_LABEL[e.ds] ?? e.ds}${e.author ? ` · by ${e.author}` : ''}${e.joints ? ` · ${e.joints} joint${e.joints > 1 ? 's' : ''}` : ''}${m.library ? ' · CC0, a real museum object' : ' — E for details & its program'}`,
      target: 'inspect',
      inspect: m.library ? undefined : e,
    });
    e.attribution = `${fmtDims(m.real)} · shown at actual size${Math.abs(m.k - 1) > 0.01 ? ' · rescaled from the source to a realistic size' : ''}`;
    const got0 = m.model ? Promise.resolve(m.model) : m.load ? m.load() : loadRemote(e, { prio: opts.prio ?? 0, shadows: false });
    m.model = undefined; // hand over ownership
    // a rebuilt GLB whose proportions are not the object's (another pose, a partial rebuild) is
    // replaced by the object built from its own USDA, which is what the room was planned for
    const got = m.library
      ? got0
      : got0.then((mod) => {
          if (!isRebuilt(e.id) || proportionsMatch(mod.object, m.raw)) return mod;
          disposeModel(mod.object);
          return loadRemote({ ...e, id: `${e.id}#usda` }, { prio: opts.prio ?? 0, shadows: false });
        });
    const p = got
      .then((mod) => {
        if (!this.alive) {
          disposeModel(mod.object);
          return;
        }
        // centre the base on the origin (rebuilt GLBs are not always)
        const b = new THREE.Box3().setFromObject(mod.object);
        if (Number.isFinite(b.min.y)) {
          const c = b.getCenter(new THREE.Vector3());
          if (Math.abs(c.x) > 1e-3 || Math.abs(c.z) > 1e-3 || Math.abs(b.min.y) > 1e-3) mod.object.position.sub(new THREE.Vector3(c.x, b.min.y, c.z));
        }
        holder.remove(placeholder);
        // face the visitor: the detailed side (keys, a display, doors) towards the display's front
        if (!m.library && !opts.spin && opts.face !== false) {
          const want = new THREE.Vector3(Math.sin(-rot), 0, Math.cos(-rot));
          const fr = frontOf(mod.object, want);
          this.fronts[fr]++;
          if (fr === 'flip') holder.rotation.y += Math.PI;
        }
        // one mesh per material: a sand3d piano is ~90 parts. Objects with many joints (88 piano keys)
        // stop moving; a few joints (a lid, a door) keep their moving parts separate.
        if (!m.library) {
          if (mod.animator && mod.animator.joints.length > 6) mod.animator = null;
          mergeStatic(mod.object, new Set(mod.animator?.joints.map((j) => j.node) ?? []));
        }
        holder.add(mod.object);
        trackForDetail(holder, mod.object, e.id, e.og, mod.size);
        // the room was planned for m.real: if the model that arrived has another raw size (a
        // rebuilt GLB in other units than the USDA the size was measured from), fit it to that
        const got = b.isEmpty() ? mod.size : b.getSize(new THREE.Vector3());
        const want = Math.max(m.raw.x, m.raw.y, m.raw.z), have = Math.max(got.x, got.y, got.z);
        const fix = have > 0 && want > 0 && Math.abs(Math.log(have / want)) > Math.log(1.25) ? want / have : 1;
        const k = m.k * fix;
        holder.userData.baseScale = k;
        holder.userData.fade = 0;
        holder.scale.setScalar(k * 0.85);
        slot.model = mod;
        slot.q = m.quality;
        e.attribution = `${fmtDims(m.real)} · shown at actual size${Math.abs(m.k - 1) > 0.01 ? ' · rescaled from the source to a realistic size' : ''} · ${mod.tris.toLocaleString()} triangles`;
      })
      .catch(() => {
        if (!this.alive) return;
        placeholder.material = new THREE.MeshBasicMaterial({ color: '#884444', wireframe: true });
      });
    this.pendingLoads.push(p);
    if (opts.progressive && m.loadQ) {
      // show the low-detail scan first, then swap in the full one and keep it (a hero)
      const loadQ = m.loadQ;
      m.loadQ = undefined;
      p.then(() => loadQ('full'))
        .then((mod) => {
          if (!this.alive || !slot.model) return;
          slot.holder.remove(slot.model.object);
          slot.holder.add(mod.object);
          slot.model = mod;
          slot.q = 'full';
        })
        .catch(() => {});
    }
    return slot;
  }
}

/** materials that look the same share a key (a GLB gives every part its own material instance) */
function matKey(m: THREE.Material) {
  const s = m as THREE.MeshStandardMaterial & { sheen?: number; transmission?: number; clearcoat?: number };
  if (!s.isMeshStandardMaterial) return m.uuid;
  const t = (x: THREE.Texture | null) => (x ? x.source.uuid : '');
  return [m.type, s.color.getHexString(), s.roughness.toFixed(2), s.metalness.toFixed(2), s.emissive.getHexString(), s.opacity.toFixed(2), s.transparent, s.side, t(s.map), t(s.normalMap), t(s.roughnessMap), t(s.metalnessMap), t(s.emissiveMap), t(s.alphaMap), s.vertexColors, s.transmission ?? 0, s.clearcoat ?? 0, s.sheen ?? 0, m.customProgramCacheKey?.() ?? ''].join('|');
}

/** position + normal (+ uv when all have it) of several geometries in one, indexed (robust where mergeGeometries refuses) */
function concatGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  const uv = geos.every((g) => g.getAttribute('uv'));
  const col = geos.every((g) => g.getAttribute('color')) ? geos[0].getAttribute('color').itemSize : 0;
  let nv = 0, ni = 0;
  for (const g of geos) {
    const p = g.getAttribute('position');
    if (!p) return null;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    nv += p.count;
    ni += g.index ? g.index.count : p.count;
  }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uvs = uv ? new Float32Array(nv * 2) : null;
  const cols = col ? new Float32Array(nv * col) : null;
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let v = 0, i = 0;
  for (const g of geos) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), t = g.getAttribute('uv'), c = g.getAttribute('color');
    for (let k = 0; k < p.count; k++) {
      pos[(v + k) * 3] = p.getX(k); pos[(v + k) * 3 + 1] = p.getY(k); pos[(v + k) * 3 + 2] = p.getZ(k);
      nrm[(v + k) * 3] = n.getX(k); nrm[(v + k) * 3 + 1] = n.getY(k); nrm[(v + k) * 3 + 2] = n.getZ(k);
      if (uvs && t) { uvs[(v + k) * 2] = t.getX(k); uvs[(v + k) * 2 + 1] = t.getY(k); }
      if (cols && c) for (let q = 0; q < col; q++) cols[(v + k) * col + q] = c.getComponent(k, q);
    }
    if (g.index) for (let k = 0; k < g.index.count; k++) idx[i++] = g.index.getX(k) + v;
    else for (let k = 0; k < p.count; k++) idx[i++] = v + k;
    v += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  if (uvs) out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (cols) out.setAttribute('color', new THREE.BufferAttribute(cols, col));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
