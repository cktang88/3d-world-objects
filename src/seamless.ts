import * as THREE from 'three';
import type { Level, LevelDesc, Portal, Rect } from './level';
import { finishBuilding } from './level';
import { queueHold } from './remote';

/**
 * Seamless doors: levels behind doors are built lazily *before* you reach them, shown through
 * the doorway, and entered without a fade. See docs/research/seamless.md.
 *
 *  - predictive prebuild: door portals within ~14 m that you face start building in the
 *    background, in time slices (Level.staging, a per-frame ms budget), at most a couple at once
 *  - an LRU cache of built levels: re-entering a shop or going back to the street is instant
 *  - previews: a prebuilt interior is placed in world space behind its street door (the level's
 *    entry doorway onto the portal's door) and drawn while you are near; the fake-interior glass
 *    of that storefront is cut away (cutHoles) so you see the real shop through the windows
 *  - walk-through: crossing the threshold of a previewed door swaps the active level in the same
 *    frame, moving the player into the interior's own frame (visually continuous); walking back
 *    out swaps back. Lighting blends its exposure instead of fading to black.
 */

const V = () => new THREE.Vector3();

// ---------------------------------------------------------------- keys and frames

export function descKey(d: LevelDesc): string {
  return JSON.stringify(d, (k, v) => (k === 'source' && v && typeof v === 'object' ? (v as { id?: string; title?: string }).id ?? (v as { title?: string }).title : v));
}

export interface Doorway {
  pos: THREE.Vector3;
  yaw: number;
}

/** facing direction (horizontal) of a player yaw */
export function facing(yaw: number, out = V()) {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}

/** the doorway of a portal in world space (explicit `door`, or an auto doorway's box + returnYaw) */
export function doorOf(p: Portal): (Doorway & { see?: boolean; hole?: THREE.Box3 }) | null {
  if (p.door) return p.door;
  if (p.auto && p.returnYaw !== undefined) {
    const c = p.box.getCenter(V());
    c.y = 0;
    // returnYaw faces back into the room you leave; walking through faces the other way
    return { pos: c, yaw: p.returnYaw + Math.PI };
  }
  return null;
}

/** a level's own entry doorway (Level.entry, or its 'back' portal) */
export function entryOf(lv: Level): Level['doorway'] | null {
  if (lv.doorway) return lv.doorway;
  const back = lv.portals().find((p) => p.target === 'back' && p.returnYaw !== undefined);
  if (!back) return null;
  const c = back.box.getCenter(V());
  c.y = 0;
  return { pos: c, yaw: back.returnYaw! };
}

/** child-level local -> parent world: the child's entry doorway lands on the parent's door */
export function placementMatrix(door: Doorway, entry: Doorway) {
  const m = new THREE.Matrix4().makeTranslation(door.pos.x, door.pos.y, door.pos.z);
  m.multiply(new THREE.Matrix4().makeRotationY(door.yaw - entry.yaw));
  m.multiply(new THREE.Matrix4().makeTranslation(-entry.pos.x, -entry.pos.y, -entry.pos.z));
  return m;
}

function rectApply(r: Rect, m: THREE.Matrix4): Rect {
  const a = V().set(r.minX, 0, r.minZ).applyMatrix4(m), b = V().set(r.maxX, 0, r.maxZ).applyMatrix4(m);
  return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) };
}
function overlap(a: Rect, b: Rect) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}
/** a minus b: up to four rects */
export function subtractRect(a: Rect, b: Rect): Rect[] {
  if (!overlap(a, b)) return [a];
  const out: Rect[] = [];
  if (a.minX < b.minX) out.push({ minX: a.minX, maxX: b.minX, minZ: a.minZ, maxZ: a.maxZ });
  if (a.maxX > b.maxX) out.push({ minX: b.maxX, maxX: a.maxX, minZ: a.minZ, maxZ: a.maxZ });
  const x0 = Math.max(a.minX, b.minX), x1 = Math.min(a.maxX, b.maxX);
  if (a.minZ < b.minZ) out.push({ minX: x0, maxX: x1, minZ: a.minZ, maxZ: b.minZ });
  if (a.maxZ > b.maxZ) out.push({ minX: x0, maxX: x1, minZ: b.maxZ, maxZ: a.maxZ });
  return out;
}

// ---------------------------------------------------------------- see-through glass

const HOLES = 2;
const holeU = {
  uHoleMin: { value: Array.from({ length: HOLES }, () => new THREE.Vector3(1e9, 1e9, 1e9)) },
  uHoleMax: { value: Array.from({ length: HOLES }, () => new THREE.Vector3(-1e9, -1e9, -1e9)) },
};
/**
 * Let a (fake-interior) glass material be cut away inside the world boxes seamless.ts sets, so
 * the real prebuilt interior behind it shows. Chains any existing onBeforeCompile.
 */
export function cutHoles<T extends THREE.Material>(m: T): T {
  if (m.userData.cutHoles) return m;
  m.userData.cutHoles = true;
  const prev = m.onBeforeCompile.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.uniforms.uHoleMin = holeU.uHoleMin;
    sh.uniforms.uHoleMax = holeU.uHoleMax;
    sh.vertexShader = 'varying vec3 vHoleW;\n' + sh.vertexShader.replace('#include <fog_vertex>', '#include <fog_vertex>\nvHoleW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = `uniform vec3 uHoleMin[${HOLES}];\nuniform vec3 uHoleMax[${HOLES}];\nvarying vec3 vHoleW;\n` + sh.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
for (int i = 0; i < ${HOLES}; i++) if (all(greaterThan(vHoleW, uHoleMin[i])) && all(lessThan(vHoleW, uHoleMax[i]))) discard;`,
    );
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => key() + '|holes';
  m.needsUpdate = true;
  return m;
}
function setHoles(boxes: THREE.Box3[]) {
  for (let i = 0; i < HOLES; i++) {
    const b = boxes[i];
    if (b) {
      holeU.uHoleMin.value[i].copy(b.min);
      holeU.uHoleMax.value[i].copy(b.max);
    } else {
      holeU.uHoleMin.value[i].setScalar(1e9);
      holeU.uHoleMax.value[i].setScalar(-1e9);
    }
  }
}

// ---------------------------------------------------------------- the cache

export type Builder = (desc: LevelDesc, staged: boolean) => Level;

export interface Slot {
  key: string;
  desc: LevelDesc;
  level: Level;
  ready: boolean;
  /** the level is still finishing itself asynchronously (GalleryLevel.built) */
  waiting: boolean;
  /** triangles drawn by its meshes (memory budget), measured when built */
  tris: number;
  /** ms spent constructing (sum of slices) */
  ms: number;
  used: number;
  /** child local -> parent world, while shown behind (or entered through) a door */
  placement: THREE.Matrix4 | null;
  inverse: THREE.Matrix4 | null;
  entry: Level['doorway'] | null;
  /** local footprint (union of its colliders) */
  foot: Rect | null;
  /** lights taken out while previewed (adding lights to the street would recompile every shader) */
  stripped: [THREE.Light, THREE.Object3D][];
  compiled: 'no' | 'pending' | 'yes';
  shown: boolean;
  /** the portal it was last placed at */
  portal: Portal | null;
}

export interface SeamlessStats {
  builds: number;
  hits: number;
  prebuilds: number;
  seamless: number;
  fades: number;
  evicted: number;
  lastBuildMs: number;
  maxSliceMs: number;
  log: string[];
}

export interface SeamlessOpts {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  build: Builder;
  /** levels kept besides the pinned ones */
  capacity?: number;
  /** ms of staged construction per frame */
  budget?: number;
  /** triangles the unpinned cached levels may hold together */
  triBudget?: number;
}

/** triangles a level's meshes hold (instanced meshes count every instance) */
export function countTris(o: THREE.Object3D) {
  let n = 0;
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry;
    const per = (g.index ? g.index.count : g.getAttribute('position')?.count ?? 0) / 3;
    n += per * ((c as THREE.InstancedMesh).isInstancedMesh ? (c as THREE.InstancedMesh).count : 1);
  });
  return n;
}

/** the lights that stand in for a previewed level's own (always in the scene: no recompiles) */
const POOL = 2;

const PREBUILD_KINDS = new Set(['interior', 'gallery', 'atrium']);

export class Seamless {
  slots = new Map<string, Slot>();
  stats: SeamlessStats = { builds: 0, hits: 0, prebuilds: 0, seamless: 0, fades: 0, evicted: 0, lastBuildMs: 0, maxSliceMs: 0, log: [] };
  enabled = true;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private builder: Builder;
  private capacity: number;
  budget: number;
  private queue: Slot[] = [];
  private tick = 0;
  private wanted = new Set<string>();
  private active: Slot | null = null;
  private pins = new Set<string>();
  private disarmed: Portal[] = [];
  private blend: { from: number; to: number; t: number } | null = null;
  private triBudget: number;
  private pool: THREE.PointLight[] = [];

  constructor(o: SeamlessOpts) {
    this.triBudget = o.triBudget ?? 6_000_000;
    for (let i = 0; i < POOL; i++) {
      const l = new THREE.PointLight('#ffffff', 0, 8, 2);
      l.name = 'seamless-preview-light';
      this.pool.push(l);
      o.scene.add(l);
    }
    this.scene = o.scene;
    this.camera = o.camera;
    this.renderer = o.renderer;
    this.builder = o.build;
    this.capacity = o.capacity ?? 3;
    this.budget = o.budget ?? 4;
  }

  private log(s: string) {
    this.stats.log.push(s);
    if (this.stats.log.length > 40) this.stats.log.shift();
    console.info('[seamless]', s);
  }

  /** is this level built and ready to switch to? */
  ready(desc: LevelDesc) {
    const s = this.slots.get(descKey(desc));
    return !!s && s.ready && !s.waiting;
  }
  slotOf(lv: Level) {
    for (const s of this.slots.values()) if (s.level === lv) return s;
    return null;
  }

  /** the level for desc, built now if needed (draining any staged construction) */
  take(desc: LevelDesc): Slot {
    const key = descKey(desc);
    let s = this.slots.get(key);
    if (s) {
      this.stats.hits++;
      if (!s.ready) {
        const t = performance.now();
        finishBuilding(s.level);
        s.ms += performance.now() - t;
        this.done(s);
      }
    } else {
      const t = performance.now();
      const lv = finishBuilding(this.builder(desc, false));
      s = this.slot(key, desc, lv);
      s.ms = performance.now() - t;
      this.done(s);
    }
    s.used = performance.now();
    this.queue = this.queue.filter((q) => q !== s);
    return s;
  }

  private slot(key: string, desc: LevelDesc, level: Level): Slot {
    const s: Slot = { key, desc, level, ready: false, waiting: false, tris: 0, ms: 0, used: performance.now(), placement: null, inverse: null, entry: null, foot: null, stripped: [], compiled: 'no', shown: false, portal: null };
    this.slots.set(key, s);
    this.stats.builds++;
    return s;
  }
  private done(s: Slot) {
    if (s.ready) return;
    s.ready = true;
    s.level.staging = undefined;
    const built = (s.level as { built?: Promise<void> }).built;
    if (built) {
      s.waiting = true;
      built.then(() => {
        s.waiting = false;
        s.tris = countTris(s.level.group);
      });
    }
    s.tris = countTris(s.level.group);
    this.stats.lastBuildMs = s.ms;
    this.log(`built ${s.key.slice(0, 90)} in ${s.ms.toFixed(1)} ms`);
    this.evict();
  }

  /**
   * Build desc now but without freezing the page: slices of ~40 ms with a yield between them
   * (the fade fallback; onProgress gets the number of slices so far for a HUD hint).
   */
  async buildNow(desc: LevelDesc, onProgress?: (n: number) => void): Promise<Slot> {
    const key = descKey(desc);
    if (!this.slots.has(key)) this.prebuild(desc);
    const s = this.slots.get(key)!;
    let n = 0;
    while (!s.ready && s.level.staging) {
      const t = performance.now();
      while (!s.ready && performance.now() - t < 40) {
        const a = performance.now();
        const r = s.level.staging.next();
        s.ms += performance.now() - a;
        if (r.done) {
          this.queue = this.queue.filter((q) => q !== s);
          this.done(s);
        }
      }
      onProgress?.(++n);
      if (!s.ready) await new Promise((r) => setTimeout(r, 0));
    }
    return this.take(desc);
  }

  /** start building in the background (staged when the level supports it) */
  prebuild(desc: LevelDesc) {
    const key = descKey(desc);
    if (this.slots.has(key)) return;
    const t = performance.now();
    const lv = this.builder(desc, true);
    const s = this.slot(key, desc, lv);
    s.ms = performance.now() - t;
    this.stats.maxSliceMs = Math.max(this.stats.maxSliceMs, s.ms);
    this.stats.prebuilds++;
    if (!lv.staging) this.done(s);
    else this.queue.push(s);
  }

  /** the level that is now being played (and the ones to keep alive with it) */
  setActive(s: Slot, keep: string[] = []) {
    if (s.shown) this.hidePreview(s);
    this.restore(s);
    s.level.group.position.set(0, 0, 0);
    s.level.group.quaternion.identity();
    s.level.group.updateMatrixWorld(true);
    this.active = s;
    for (const p of this.pool) p.intensity = 0;
    s.used = performance.now();
    this.pins = new Set([s.key, ...keep]);
    // previews belong to the level they were shown from
    for (const o of this.slots.values()) if (o !== s && o.shown) this.hidePreview(o);
    this.evict();
  }

  /** forget everything (a new game mode) */
  clear(except?: Level) {
    for (const s of [...this.slots.values()]) if (s.level !== except) this.drop(s);
    this.queue = [];
  }

  private drop(s: Slot) {
    if (s.shown) this.hidePreview(s);
    this.slots.delete(s.key);
    this.stats.evicted++;
    // a dropped level must not cancel the active level's queued model loads (remote.ts)
    queueHold.n++;
    try {
      s.level.dispose();
    } finally {
      queueHold.n--;
    }
    this.log(`evicted ${s.key.slice(0, 60)}`);
  }

  private evict() {
    const free = [...this.slots.values()].filter((s) => !this.pins.has(s.key) && !s.shown && !this.wanted.has(s.key));
    free.sort((a, b) => a.used - b.used);
    let tris = free.reduce((n, s) => n + s.tris, 0);
    while (free.length > this.capacity || (free.length > 1 && tris > this.triBudget)) {
      const s = free.shift()!;
      tris -= s.tris;
      this.drop(s);
    }
  }

  // ---------------------------------------------------------------- per frame

  /**
   * Once per frame with the active level: picks doors to prebuild, runs construction slices,
   * places previews. Returns a portal when the player has just walked through a previewed door.
   */
  update(dt: number, level: Level, player: THREE.Vector3): { enter?: Portal; exit?: boolean } {
    const t0 = performance.now();
    const out: { enter?: Portal; exit?: boolean } = {};
    if (this.blend) {
      this.blend.t = Math.min(1, this.blend.t + dt / 0.45);
      const e = this.blend.t * this.blend.t * (3 - 2 * this.blend.t);
      this.renderer.toneMappingExposure = this.blend.from + (this.blend.to - this.blend.from) * e;
      if (this.blend.t >= 1) this.blend = null;
    }
    if (!this.enabled) return out;
    // 1. what are we walking towards? (every few frames: portals lists can be long)
    if (this.tick++ % 6 === 0) this.choose(level, player);
    // 2. construction slices within the budget
    while (this.queue.length && performance.now() - t0 < this.budget) {
      const s = this.queue[0];
      const a = performance.now();
      const r = s.level.staging!.next();
      const ms = performance.now() - a;
      s.ms += ms;
      this.stats.maxSliceMs = Math.max(this.stats.maxSliceMs, ms);
      if (r.done) {
        this.queue.shift();
        this.done(s);
      }
    }
    // 3. previews behind street doors (they get their own update, in their frame: e.g. a shop
    // stocks the coolers you look into from the street)
    this.previews(level, player);
    for (const s of this.slots.values()) if (s.shown && s.inverse) s.level.update(dt, V().copy(player).applyMatrix4(s.inverse), performance.now() / 1000);
    // 4. walking through
    for (const s of this.slots.values()) {
      if (!s.shown || !s.inverse || !s.entry || !s.foot || !s.portal) continue;
      const l = V().copy(player).applyMatrix4(s.inverse);
      const ahead = V().copy(l).sub(s.entry.pos).dot(facing(s.entry.yaw));
      const f = s.foot;
      if (ahead > 0.35 && l.x > f.minX + 0.1 && l.x < f.maxX - 0.1 && l.z > f.minZ + 0.1 && l.z < f.maxZ - 0.1) out.enter = s.portal;
    }
    const a = this.active;
    if (a && a.inverse && a.entry && a.level === level && a.portal?.door?.see) {
      const d = V().copy(player).sub(a.entry.pos);
      const ahead = d.dot(facing(a.entry.yaw));
      const side = Math.abs(d.dot(facing(a.entry.yaw + Math.PI / 2)));
      if (ahead < -0.3 && side < 1.4) out.exit = true;
    }
    return out;
  }

  private choose(level: Level, player: THREE.Vector3) {
    const fwd = this.camera.getWorldDirection(V());
    fwd.y = 0;
    fwd.normalize();
    const c = V();
    const cands: { p: Portal; d: number }[] = [];
    for (const p of level.portals()) {
      if (typeof p.target !== 'object' || !PREBUILD_KINDS.has(p.target.kind)) continue;
      p.box.getCenter(c);
      c.y = player.y;
      const d = c.distanceTo(player);
      if (d > 14) continue;
      const dir = c.sub(player).normalize();
      if (d < 3 || dir.dot(fwd) > 0.5) cands.push({ p, d });
    }
    cands.sort((a, b) => a.d - b.d);
    this.wanted.clear();
    for (const { p } of cands.slice(0, 2)) {
      const desc = p.target as LevelDesc;
      this.wanted.add(descKey(desc));
      if (!this.slots.has(descKey(desc)) && this.queue.length < 2) this.prebuild(desc);
    }
    // turned away: drop half-built ones nobody wants any more
    for (const s of [...this.queue]) {
      if (this.wanted.has(s.key) || this.pins.has(s.key)) continue;
      this.queue = this.queue.filter((q) => q !== s);
      this.drop(s);
    }
  }

  private previews(level: Level, player: THREE.Vector3) {
    const show: { s: Slot; p: Portal; d: number }[] = [];
    for (const p of level.portals()) {
      if (!p.door?.see || typeof p.target !== 'object') continue;
      const s = this.slots.get(descKey(p.target));
      if (!s || !s.ready || s.waiting || s === this.active) continue;
      const d = p.door.pos.distanceTo(player);
      if (d < 11) show.push({ s, p, d });
    }
    show.sort((a, b) => a.d - b.d);
    const keep = new Set(show.slice(0, 2).map((x) => x.s));
    for (const s of this.slots.values()) if (s.shown && !keep.has(s)) this.hidePreview(s);
    const holes: THREE.Box3[] = [];
    for (const { s, p } of show.slice(0, 2)) {
      if (!s.shown) this.showPreview(s, p);
      if (s.shown && p.door?.hole) holes.push(this.holeFor(s, p));
    }
    setHoles(holes);
    this.lightPreview(show.find((x) => x.s.shown)?.s ?? null, player);
    void level;
  }

  /** light the nearest preview with the shared pool: its own lights nearest the viewer */
  private lightPreview(s: Slot | null, player: THREE.Vector3) {
    const cand: { l: THREE.Light; at: THREE.Vector3; d: number }[] = [];
    if (s) {
      for (const [l, parent] of s.stripped) {
        if (!(l as THREE.PointLight).isPointLight && !(l as THREE.SpotLight).isSpotLight) continue;
        const at = l.position.clone().applyMatrix4(parent.matrixWorld);
        cand.push({ l, at, d: at.distanceToSquared(player) });
      }
      cand.sort((a, b) => a.d - b.d);
    }
    this.pool.forEach((p, i) => {
      const c = cand[i];
      if (!c) {
        p.intensity = 0;
        return;
      }
      const src = c.l as THREE.PointLight;
      p.position.copy(c.at);
      p.color.copy(src.color);
      // the pool stands in for the whole grid: a little brighter than one of its lights
      p.intensity = (src.userData.base ?? src.intensity) * 1.6;
      p.distance = src.distance ? src.distance * 1.2 : 12;
      p.decay = src.decay;
    });
  }

  /** place slot s behind portal p of the active level (for carry()); false if it has no doorway */
  placeAt(s: Slot, p: Portal) {
    return this.place(s, p);
  }

  private place(s: Slot, p: Portal) {
    const door = doorOf(p);
    const entry = entryOf(s.level);
    if (!door || !entry) return false;
    s.entry = entry;
    s.portal = p;
    s.placement = placementMatrix(door, entry);
    s.inverse = s.placement.clone().invert();
    if (!s.foot) {
      const f: Rect = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      for (const r of s.level.colliders(entry.pos)) {
        f.minX = Math.min(f.minX, r.minX); f.maxX = Math.max(f.maxX, r.maxX);
        f.minZ = Math.min(f.minZ, r.minZ); f.maxZ = Math.max(f.maxZ, r.maxZ);
      }
      s.foot = Number.isFinite(f.minX) ? f : null;
    }
    return true;
  }

  private showPreview(s: Slot, p: Portal) {
    if (!this.place(s, p)) return;
    const g = s.level.group;
    if (!s.stripped.length) {
      g.traverse((o) => {
        if ((o as THREE.Light).isLight && o.parent) s.stripped.push([o as THREE.Light, o.parent]);
      });
      for (const [l] of s.stripped) l.removeFromParent();
    }
    for (const o of s.entry?.hide ?? []) o.visible = false;
    s.placement!.decompose(g.position, g.quaternion, g.scale);
    g.updateMatrixWorld(true);
    // compile its shaders off the main thread first (KHR_parallel_shader_compile), then show
    if (s.compiled === 'no') {
      s.compiled = 'pending';
      const t = performance.now();
      this.renderer.compileAsync(g, this.camera, this.scene).then(() => {
        s.compiled = 'yes';
        this.log(`compiled ${s.key.slice(0, 50)} in ${(performance.now() - t).toFixed(0)} ms (async)`);
      }, () => (s.compiled = 'yes'));
    }
    if (s.compiled !== 'yes') return;
    this.scene.add(g);
    s.shown = true;
  }

  private hidePreview(s: Slot) {
    s.level.group.removeFromParent();
    s.shown = false;
    setHoles([]);
  }

  /** put back what the preview took out */
  private restore(s: Slot) {
    for (const [l, parent] of s.stripped) parent.add(l);
    s.stripped = [];
    for (const o of s.entry?.hide ?? []) o.visible = true;
  }

  /** the glass to cut: the storefront's, but only as wide as the interior behind it */
  private holeFor(s: Slot, p: Portal) {
    const hole = p.door!.hole!.clone();
    if (s.foot && s.placement) {
      const w = rectApply(s.foot, s.placement);
      const f = facing(p.door!.yaw);
      if (Math.abs(f.z) > Math.abs(f.x)) {
        hole.min.x = Math.max(hole.min.x, w.minX);
        hole.max.x = Math.min(hole.max.x, w.maxX);
      } else {
        hole.min.z = Math.max(hole.min.z, w.minZ);
        hole.max.z = Math.min(hole.max.z, w.maxZ);
      }
    }
    return hole;
  }

  /** the active level's colliders, plus a walkable way into any previewed interior nearby */
  colliders(base: Rect[], player: THREE.Vector3): Rect[] {
    let out = base;
    for (const s of this.slots.values()) {
      if (!s.shown || !s.placement || !s.foot || !s.portal?.door) continue;
      const door = s.portal.door;
      if (door.pos.distanceTo(player) > 8) continue;
      const foot = rectApply(s.foot, s.placement);
      // the corridor from the pavement to the threshold
      const f = facing(door.yaw);
      const a = V().copy(door.pos).addScaledVector(f, -2.2), b = V().copy(door.pos).addScaledVector(f, 0.3);
      const side = facing(door.yaw + Math.PI / 2).multiplyScalar(0.6);
      const corr: Rect = {
        minX: Math.min(a.x, b.x) - Math.abs(side.x), maxX: Math.max(a.x, b.x) + Math.abs(side.x),
        minZ: Math.min(a.z, b.z) - Math.abs(side.z), maxZ: Math.max(a.z, b.z) + Math.abs(side.z),
      };
      const carved: Rect[] = [];
      for (const r of out) {
        if (!overlap(r, foot) && !overlap(r, corr)) {
          carved.push(r);
          continue;
        }
        for (const q of subtractRect(r, foot)) carved.push(...subtractRect(q, corr));
      }
      const local = V().copy(player).applyMatrix4(s.inverse!);
      for (const r of s.level.colliders(local)) carved.push(rectApply(r, s.placement));
      out = carved;
    }
    return out;
  }

  // ---------------------------------------------------------------- switching

  /**
   * Where the player stands in `to` after going through `s`'s door, in to's frame:
   * `dir` 'in' maps parent world -> child local, 'out' child local -> parent world.
   */
  carry(s: Slot, dir: 'in' | 'out', pos: THREE.Vector3, yaw: number) {
    if (!s.placement || !s.inverse || !s.entry) return null;
    const rot = new THREE.Euler().setFromRotationMatrix(s.placement, 'YXZ').y;
    const p = pos.clone().applyMatrix4(dir === 'in' ? s.inverse : s.placement);
    p.y = pos.y;
    const y = dir === 'in' ? yaw - rot : yaw + rot;
    if (dir === 'in') {
      // pressed E from the pavement: step just inside instead of standing in the void
      const ahead = V().copy(p).sub(s.entry.pos).dot(facing(s.entry.yaw));
      if (ahead < -0.2) p.copy(s.entry.pos).addScaledVector(facing(s.entry.yaw), 0.9);
    } else {
      const door = s.portal ? doorOf(s.portal) : null;
      if (door) {
        const ahead = V().copy(p).sub(door.pos).dot(facing(door.yaw));
        // still inside (pressed Q): step out onto the pavement
        if (ahead > -0.4) p.copy(door.pos).addScaledVector(facing(door.yaw), -1.3);
      }
    }
    return { pos: p, yaw: y };
  }

  /** auto portals the player stands in right after a seamless switch stay off until left */
  disarm(level: Level, feet: THREE.Vector3) {
    this.disarmed = level.portals().filter((p) => p.auto && p.box.containsPoint(feet));
  }
  armed(p: Portal, feet: THREE.Vector3) {
    if (!this.disarmed.includes(p)) return true;
    if (!p.box.containsPoint(feet)) this.disarmed = this.disarmed.filter((q) => q !== p);
    return false;
  }

  /** ease the tone-mapping exposure from the old level's value to the new one */
  blendFrom(exposure: number) {
    const to = this.renderer.toneMappingExposure;
    if (Math.abs(to - exposure) < 1e-3) return;
    this.blend = { from: exposure, to, t: 0 };
    this.renderer.toneMappingExposure = exposure;
  }

  /** for the HUD: how far along the build of desc is (0..1, 1 = ready, null = not started) */
  progress(desc: LevelDesc) {
    const s = this.slots.get(descKey(desc));
    if (!s) return null;
    return s.ready ? 1 : 0.5;
  }
}
