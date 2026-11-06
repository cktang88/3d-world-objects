import * as THREE from 'three';
import type { Level, Rect } from './level';
import { disposeTree } from './level';
import type { Animator } from './remote';

/**
 * Lazy insides, at every level of nesting (docs/research/seamless.md):
 *
 *  - CellGraph: a building's rooms are cells and their doorways portals. Only the room you are in
 *    and rooms seen through doorways (doorway rectangles tested against the view, recursively,
 *    narrowing the screen rect each time) are drawn. Cells may be generated lazily: a cell's
 *    `generate()` runs (in time slices) once its doorway comes into view or you get close.
 *  - Containers: dressers, wardrobes, cabinets, fridges, store freezers. Their contents do not
 *    exist until opened (E), or, for glass-door ones, until you are near and facing them.
 *    Opening animates (a door, a drawer, or a sand3d joint) and generates the contents in time
 *    slices; closing hides them; a small LRU keeps recent contents, older ones are disposed.
 *
 * main.ts calls `lazy.update(dt, camera, level)` every frame, `lazy.aim(...)` for the E prompt and
 * `lazy.toggle(c)` on E.
 */

const V = () => new THREE.Vector3();

// ---------------------------------------------------------------- time slices

type Gen = THREE.Object3D | Promise<THREE.Object3D> | Iterator<unknown, THREE.Object3D>;
function isIter(g: unknown): g is Iterator<unknown, THREE.Object3D> {
  return !!g && typeof (g as Iterator<unknown>).next === 'function' && !(g as THREE.Object3D).isObject3D;
}

// ---------------------------------------------------------------- containers

export interface ContainerSpec {
  /** what it is, for the prompt ("Open the dresser") */
  label?: string;
  /** outer w/h/d; obj is at its front-centre base with +z out of the front (default: obj's bounds) */
  size?: THREE.Vector3;
  /** make the contents (only called when needed); may return a promise or a generator (one slice per next()) */
  generate(): Gen;
  /** pose the door/drawer: t = 0 closed .. 1 open. Default: `door` swings, `drawer` slides, or the contents slide out */
  open?(t: number): void;
  /** a door leaf to swing open about its own origin (local y) */
  door?: THREE.Object3D;
  /** a drawer to slide out along obj's +z */
  drawer?: THREE.Object3D;
  /** draw the door/drawer only while it is open (it is added to a model that has its own fronts) */
  hideClosed?: boolean;
  /** shown only while open: e.g. the dark empty slot over the model's own closed front */
  slot?: THREE.Object3D;
  /**
   * expensive set-up done only when wanted (lazy-furniture.ts: cutting a library model's openings):
   * started when you come within 4 m facing it (it then runs in idle slices; null until it is done),
   * finished at once on the first E (`now`). It may replace this container with others (returned,
   * already registered); null while it can't run yet (model still loading) or is still running.
   */
  prepare?: (now?: boolean) => LazyContainer[] | null;
  /** contents can't be seen while shut (default true). False (glass coolers, display cases): generated when near and facing */
  closedOpaque?: boolean;
}

/** how far a drawer slides out, as a share of its depth (stays in its runners) */
export const DRAWER_TRAVEL = 0.8;

export class LazyContainer {
  open = false;
  /** its prepare() has run */
  prepared = false;
  t = 0;
  contents: THREE.Object3D | null = null;
  private job: Iterator<unknown, THREE.Object3D> | null = null;
  private pending = false;
  used = 0;
  box = new THREE.Box3();
  constructor(public obj: THREE.Object3D, public spec: ContainerSpec) {}

  get label() {
    return this.spec.label ?? 'container';
  }
  get opaque() {
    return this.spec.closedOpaque !== false;
  }
  worldBox() {
    const s = this.spec.size;
    if (s) {
      this.box.min.set(-s.x / 2, 0, -s.z);
      this.box.max.set(s.x / 2, s.y, 0.02);
      this.box.applyMatrix4(this.obj.matrixWorld);
    } else this.box.setFromObject(this.obj);
    return this.box;
  }
  /** start making the contents (no-op if made or in progress) */
  ensure() {
    if (this.contents || this.job || this.pending) return;
    const g = this.spec.generate();
    if (isIter(g)) this.job = g;
    else if (g instanceof Promise) {
      this.pending = true;
      g.then((o) => this.attach(o), () => undefined).finally(() => (this.pending = false));
    } else this.attach(g);
  }
  /** one slice; true while there is more to do */
  step() {
    if (!this.job) return false;
    const r = this.job.next();
    if (r.done) {
      this.job = null;
      if (r.value) this.attach(r.value);
      return false;
    }
    return true;
  }
  get busy() {
    return !!this.job;
  }
  private attach(o: THREE.Object3D) {
    if (this.obj.userData.disposed) return disposeTree(o);
    this.contents = o;
    this.obj.add(o);
    o.userData.restZ = o.position.z;
    this.pose();
  }
  pose() {
    const t = this.t;
    const e = t * t * (3 - 2 * t);
    if (this.spec.open) this.spec.open(e);
    else if (this.spec.door) this.spec.door.rotation.y = -1.85 * e;
    else if (this.spec.drawer) this.spec.drawer.position.z = e * DRAWER_TRAVEL * (this.spec.size?.z ?? 0.4);
    if (this.spec.hideClosed) for (const m of [this.spec.door, this.spec.drawer]) if (m) m.visible = t > 0.001;
    if (this.spec.slot) this.spec.slot.visible = t > 0.001;
    if (this.contents) {
      // no moving part we know of: present the contents by sliding them out of the front
      if (!this.spec.open && !this.spec.door) this.contents.position.z = (this.contents.userData.restZ as number) + e * DRAWER_TRAVEL * (this.spec.size?.z ?? 0.4);
      this.contents.visible = !this.opaque || t > 0.02;
    }
  }
  drop() {
    if (!this.contents) return;
    this.contents.removeFromParent();
    disposeTree(this.contents);
    this.contents = null;
  }
}

/** a sand3d object's revolute/prismatic joints as an open(t) pose (remote.ts Animator) */
export function jointOpener(a: Animator): (t: number) => void {
  const m = new THREE.Matrix4(), tr = new THREE.Matrix4(), rot = new THREE.Matrix4();
  return (t: number) => {
    for (const j of a.joints) {
      const { joint } = j;
      j.node.matrixAutoUpdate = false;
      if (joint.kind === 'revolute') {
        const lo = Number.isFinite(joint.lower) ? joint.lower : 0;
        const hi = Number.isFinite(joint.upper) ? joint.upper : 100;
        // open = the limit furthest from zero
        const deg = (Math.abs(hi) >= Math.abs(lo) ? hi : lo) * t;
        rot.makeRotationAxis(j.axis, THREE.MathUtils.degToRad(deg));
        tr.makeTranslation(j.pivot.x, j.pivot.y, j.pivot.z);
        m.copy(j.rest).multiply(tr).multiply(rot).multiply(tr.makeTranslation(-j.pivot.x, -j.pivot.y, -j.pivot.z));
      } else {
        const lo = Number.isFinite(joint.lower) ? joint.lower : 0;
        const hi = Number.isFinite(joint.upper) ? joint.upper : 0.3;
        const d = (Math.abs(hi) >= Math.abs(lo) ? hi : lo) * t;
        m.copy(j.rest).multiply(tr.makeTranslation(j.axis.x * d, j.axis.y * d, j.axis.z * d));
      }
      j.node.matrix.copy(m);
    }
  };
}

const registry = new Set<LazyContainer>();

/** register an openable thing; its contents are generated only when needed */
let registered = 0;
export function registerContainer(obj: THREE.Object3D, spec: ContainerSpec) {
  // Lazy.update forgets containers of disposed levels every frame; this also does when nothing updates
  // (levels prebuilt and evicted in the background keep registering)
  if (++registered % 256 === 0) for (const o of registry) if (o.obj.userData.disposed) { o.drop(); registry.delete(o); }
  const c = new LazyContainer(obj, spec);
  registry.add(c);
  return c;
}

function under(o: THREE.Object3D, root: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === root) return true;
  return false;
}

/** register an InteriorLevel-style container ({ kind, obj, size, generate, ... }) */
export function adoptContainer(c: ContainerLike) {
  // only containers with an anchor object (ShopLevel's glass coolers stock themselves in update())
  if (!(c.obj as THREE.Object3D | undefined)?.isObject3D) return null;
  return registerContainer(c.obj, { label: c.label ?? NAMES[c.kind] ?? c.kind, size: c.size, generate: c.generate, door: c.door, drawer: c.drawer, open: c.open, closedOpaque: c.closedOpaque, hideClosed: c.hideClosed, slot: c.slot, prepare: c.prepare });
}

/** InteriorLevel-style containers ({ kind, obj, size, generate }) adopted automatically */
export interface ContainerLike {
  kind: string;
  obj: THREE.Group;
  size: THREE.Vector3;
  generate: () => Gen;
  door?: THREE.Object3D;
  drawer?: THREE.Object3D;
  open?: (t: number) => void;
  closedOpaque?: boolean;
  hideClosed?: boolean;
  slot?: THREE.Object3D;
  prepare?: (now?: boolean) => LazyContainer[] | null;
  label?: string;
}
const NAMES: Record<string, string> = { dresser: 'dresser', nightstand: 'nightstand drawer', cabinet: 'cabinet', upper: 'cupboard', fridge: 'fridge', closet: 'closet', cooler: 'cooler', freezer: 'freezer' };

// ---------------------------------------------------------------- cells

export interface CellDoor {
  x: number;
  z: number;
  width: number;
  height: number;
  /** 'x': the doorway lies in the plane x = const (spans z); 'z': in z = const (spans x) */
  axis: 'x' | 'z';
  /** the cell on the other side (matched with the graph's key), or 'exit' */
  to: unknown;
}
export interface CellLike {
  group: THREE.Object3D;
  bounds: Rect;
  doors: CellDoor[];
  /** optional: fill the cell lazily (once), when its doorway comes into view or you get close */
  generate?: () => void | Iterator<unknown>;
  room?: unknown;
}

interface Clip {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class CellGraph {
  /** cells drawn last update */
  visible = new Set<CellLike>();
  stats = { cells: 0, visible: 0 };
  private byKey = new Map<unknown, CellLike>();
  private jobs: Iterator<unknown>[] = [];
  private started = new Set<CellLike>();

  constructor(public cells: CellLike[], key: (c: CellLike) => unknown = (c) => c.room ?? c) {
    for (const c of cells) this.byKey.set(key(c), c);
    this.stats.cells = cells.length;
  }

  private at(p: THREE.Vector3) {
    let best: CellLike | null = null, bd = Infinity;
    for (const c of this.cells) {
      const b = c.bounds;
      const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX), dz = Math.max(b.minZ - p.z, 0, p.z - b.maxZ);
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  /** `local`: the camera's position in the cells' frame (= world when the level is active) */
  update(camera: THREE.PerspectiveCamera, toLocal?: THREE.Matrix4, budgetMs = 2) {
    camera.updateMatrixWorld();
    const eye = V().setFromMatrixPosition(camera.matrixWorld);
    if (toLocal) eye.applyMatrix4(toLocal);
    const here = this.at(eye);
    if (!here) return;
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (toLocal) vp.multiply(toLocal.clone().invert());
    const seen = new Set<CellLike>([here]);
    const walk = (cell: CellLike, clip: Clip, depth: number, from: CellLike | null) => {
      for (const d of cell.doors) {
        const next = d.to === 'exit' ? null : this.byKey.get(d.to);
        if (!next || next === from) continue;
        const near = Math.hypot(eye.x - d.x, eye.z - d.z) < 1.2;
        const r = near ? clip : this.project(d, vp, clip);
        if (!r) continue;
        seen.add(next);
        if (depth < 3) walk(next, r, depth + 1, cell);
      }
    };
    walk(here, { x0: -1, y0: -1, x1: 1, y1: 1 }, 0, null);
    for (const c of this.cells) c.group.visible = seen.has(c);
    this.visible = seen;
    this.stats.visible = seen.size;
    // lazy cells: start the ones in view, then the ones close by
    for (const c of this.cells) {
      if (!c.generate || this.started.has(c)) continue;
      const b = c.bounds;
      const dx = Math.max(b.minX - eye.x, 0, eye.x - b.maxX), dz = Math.max(b.minZ - eye.z, 0, eye.z - b.maxZ);
      if (seen.has(c) || Math.hypot(dx, dz) < 4) {
        this.started.add(c);
        const g = c.generate();
        if (g && typeof (g as Iterator<unknown>).next === 'function') this.jobs.push(g as Iterator<unknown>);
      }
    }
    const t0 = performance.now();
    while (this.jobs.length && performance.now() - t0 < budgetMs) if (this.jobs[0].next().done) this.jobs.shift();
  }

  /** screen rect of a doorway, clipped to clip (null if hidden) */
  private project(d: CellDoor, vp: THREE.Matrix4, clip: Clip): Clip | null {
    const h = d.width / 2;
    const pts = d.axis === 'x'
      ? [[d.x, 0, d.z - h], [d.x, 0, d.z + h], [d.x, d.height, d.z - h], [d.x, d.height, d.z + h]]
      : [[d.x - h, 0, d.z], [d.x + h, 0, d.z], [d.x - h, d.height, d.z], [d.x + h, d.height, d.z]];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = 0;
    const v4 = new THREE.Vector4();
    for (let i = 0; i < 4; i++) {
      v4.set(pts[i][0], pts[i][1], pts[i][2], 1).applyMatrix4(vp);
      if (v4.w <= 0.05) {
        behind++;
        continue;
      }
      const x = v4.x / v4.w, y = v4.y / v4.w;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (behind === 4) return null;
    // a doorway straddling the camera plane: conservatively everything
    if (behind) return clip;
    const r = { x0: Math.max(x0, clip.x0), y0: Math.max(y0, clip.y0), x1: Math.min(x1, clip.x1), y1: Math.min(y1, clip.y1) };
    return r.x0 < r.x1 && r.y0 < r.y1 ? r : null;
  }
}

// ---------------------------------------------------------------- the manager main.ts drives

export class Lazy {
  /** contents kept besides the open ones */
  capacity = 16;
  budget = 3;
  stats = { generated: 0, open: 0, cellsVisible: 0, cells: 0 };
  private graphs = new WeakMap<Level, CellGraph | null>();
  private adopted = new WeakSet<Level>();
  private tick = 0;

  update(dt: number, camera: THREE.PerspectiveCamera, level: Level) {
    // rooms
    let g = this.graphs.get(level);
    if (g === undefined) {
      const cells = (level as unknown as { cells?: CellLike[] }).cells;
      g = cells?.length ? new CellGraph(cells) : null;
      this.graphs.set(level, g);
    }
    if (g) {
      g.update(camera);
      this.stats.cellsVisible = g.stats.visible;
      this.stats.cells = g.stats.cells;
    }
    // containers the level made (InteriorLevel.containers, ShopLevel.containers ...)
    if (!this.adopted.has(level)) {
      this.adopted.add(level);
      const list = (level as unknown as { containers?: ContainerLike[] }).containers;
      // a level adding containers later (a library model's drawers refitted once it loads) registers them itself
      level.group.userData.containersAdopted = true;
      for (const c of list ?? []) adoptContainer(c);
    }
    const t0 = performance.now();
    const fwd = camera.getWorldDirection(V());
    const eye = camera.position;
    const glassCheck = this.tick++ % 10 === 0;
    let open = 0;
    for (const c of registry) {
      if (c.obj.userData.disposed) {
        c.drop();
        registry.delete(c);
        continue;
      }
      if (!under(c.obj, level.group)) continue;
      const target = c.open ? 1 : 0;
      if (c.t !== target) {
        c.t = target > c.t ? Math.min(1, c.t + dt * 2.6) : Math.max(0, c.t - dt * 2.6);
        c.pose();
      }
      if (c.open) open++;
      // glass fronts: make the contents when near and facing
      if (glassCheck && !c.opaque && !c.contents) {
        const p = c.worldBox().getCenter(V());
        const d = p.distanceTo(eye);
        if (d < 7 && p.sub(eye).normalize().dot(fwd) > 0.6) c.ensure();
      }
      if (c.busy && performance.now() - t0 < this.budget) while (c.step() && performance.now() - t0 < this.budget);
      // set-up that waits for you to come close and look (e.g. cutting a piece's openings)
      if (glassCheck && c.spec.prepare && !c.prepared) {
        const p = c.worldBox().getCenter(V());
        if (p.distanceTo(eye) < 4 && p.clone().sub(eye).normalize().dot(fwd) > 0.5 && c.spec.prepare()) c.prepared = true;
      }
    }
    this.stats.open = open;
    // forget the oldest closed contents
    const kept = [...registry].filter((c) => c.contents && !c.open && c.opaque && c.t === 0).sort((a, b) => a.used - b.used);
    while (kept.length > this.capacity) kept.shift()!.drop();
  }

  /** the container the ray points at within reach (for the E prompt) */
  aim(ray: THREE.Ray, reach: number, level: Level): { c: LazyContainer; d: number } | null {
    let best: { c: LazyContainer; d: number } | null = null;
    const hit = V();
    for (const c of registry) {
      if (c.obj.userData.disposed || !under(c.obj, level.group)) continue;
      const b = c.worldBox();
      if (b.distanceToPoint(ray.origin) > reach) continue;
      if (!ray.intersectBox(b, hit)) continue;
      const d = hit.distanceTo(ray.origin);
      if (d <= reach && (!best || d < best.d)) best = { c, d };
    }
    return best;
  }

  toggle(c: LazyContainer) {
    // not set up yet: do it now and open what replaced this container, the one nearest to it
    if (c.spec.prepare && !c.prepared) {
      const made = c.spec.prepare(true);
      c.prepared = !!made;
      if (made?.length) {
        const at = c.worldBox().getCenter(V());
        c = made.reduce((a, b) => (a.worldBox().getCenter(V()).distanceTo(at) <= b.worldBox().getCenter(V()).distanceTo(at) ? a : b));
      }
    }
    c.open = !c.open;
    c.used = performance.now();
    if (c.open) {
      if (!c.contents) this.stats.generated++;
      c.ensure();
    }
  }
}
