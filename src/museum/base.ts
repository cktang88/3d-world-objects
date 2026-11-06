import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Env, Level, Portal, Rect } from '../level';
import { rect } from '../level';
import { loadRemote, animate, disposeModel, clearQueue, DATASET_LABEL, type RemoteModel } from '../remote';
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
    const m = new THREE.Mesh(unitPlane, poolMat(color, opacity));
    m.rotation.x = -Math.PI / 2;
    m.scale.set(r * 2, r * 2, 1);
    m.position.set(x, y + 0.006, z);
    m.renderOrder = 1;
    this.group.add(m);
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
      this.rigSpots.push(l);
      this.group.add(l, l.target);
    }
    for (let i = 0; i < MuseumBase.RIG_POINTS; i++) {
      const l = new THREE.PointLight('#fff1dc', 0, 10, 1.4);
      l.castShadow = false;
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

  /** a point light from the rig */
  point(at: THREE.Vector3, color: string, intensity: number, distance: number, decay = 1.4) {
    this.rig();
    if (this.points >= MuseumBase.RIG_POINTS) return null;
    const l = this.rigPoints[this.points++];
    l.color.set(color);
    l.intensity = intensity;
    l.distance = distance;
    l.decay = decay;
    l.position.copy(at);
    return l;
  }

  /** give the rig back (e.g. when a waiting room is replaced by the real one) */
  protected resetRig() {
    this.spots = this.points = 0;
    for (const l of [...this.rigSpots, ...this.rigPoints]) l.intensity = 0;
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
  exhibit(m: Measured, f: Frame, lx: number, ly: number, lz: number, rot = 0, opts: { prio?: number; spin?: number; label?: string; progressive?: boolean } = {}) {
    const at = f.point(lx, ly, lz);
    const holder = new THREE.Group();
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
    const got = m.model ? Promise.resolve(m.model) : m.load ? m.load() : loadRemote(e, { prio: opts.prio ?? 0, shadows: false });
    m.model = undefined; // hand over ownership
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
        holder.add(mod.object);
        trackForDetail(holder, mod.object, e.id, e.og, mod.size);
        holder.userData.baseScale = m.k;
        holder.userData.fade = 0;
        holder.scale.setScalar(m.k * 0.85);
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
