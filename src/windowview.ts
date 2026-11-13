import * as THREE from 'three';
import type { Level, LevelDesc, Rect } from './level';
import { placementMatrix, type Doorway } from './seamless';
import { SPECS, type BType } from './rooms/vertical';

/**
 * The real city outside apartment windows.
 *
 * Interiors are built in their own frame (their windows had painted backdrops). main.ts tracks
 * each level's place in the city (door placements and floor changes); on entering a room with
 * windows, this renders the live city level (still alive in seamless.ts' cache) into a small
 * cubemap from the building's centre at the window's floor height, with the outdoor sky, sun,
 * fog and night windows (lighting.asOutdoor). Each face camera's near plane lies just past the
 * building's own facade on that side, so the building drops out and one capture serves windows
 * on every wall. One face per frame (6 frames), then the window planes sample it with a
 * parallax-correct box projection (the street box: the ground plane and the facades across the
 * street), so the view shifts as you move. Cached per building, floor and outdoor light; freed
 * when you leave the building. Per frame afterwards: one texture lookup per window pixel.
 */

// ---------------------------------------------------------------- a level's place in the city

/** entering through a door: the child's frame = the parent's x the door placement */
export function enterWorld(world: THREE.Matrix4 | null, door: Doorway | null, entry: Doorway | null) {
  return world && door && entry ? world.clone().multiply(placementMatrix(door, entry)) : null;
}
/**
 * Moving between floors of one building (stairs or lift): every floor level has its floor at y 0
 * and the same plan, so floor n's frame is the lobby's raised n storeys.
 */
export function floorWorld(world: THREE.Matrix4 | null, from: LevelDesc, to: LevelDesc) {
  if (!world || from.kind !== 'floor' || to.kind !== 'floor') return world;
  const H = SPECS[to.type as BType]?.H ?? 3.2;
  return world.clone().multiply(new THREE.Matrix4().makeTranslation(0, (to.floor - from.floor) * H, 0));
}

export interface Hullish {
  rect: Rect;
  /** roof height */
  top: number;
}
export interface Spot {
  /** capture point (city world) */
  pos: THREE.Vector3;
  /** near plane per cube face (+x, -x, +y, -y, +z, -z) */
  near: number[];
  /** parallax proxy: the street box around the building */
  boxMin: THREE.Vector3;
  boxMax: THREE.Vector3;
  hull: Hullish | null;
}

/** how far across the street the proxy box reaches (m): facade to facade of a side street ~18 m */
export const STREET = 16;
const PAST_FACADE = 0.35;

function rectDist(r: Rect, x: number, z: number) {
  const dx = Math.max(r.minX - x, 0, x - r.maxX), dz = Math.max(r.minZ - z, 0, z - r.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * Where to capture the view from a window at `win` (city world): the centre of the building it is
 * in (the hull containing it, else the nearest within 6 m) at the window's height, near planes
 * just past that building's facades, roof and (most of) its lower floors.
 */
export function captureSpot(win: THREE.Vector3, hulls: Hullish[], ground = 0): Spot {
  let hull: Hullish | null = null, best = 6;
  for (const h of hulls) {
    const d = rectDist(h.rect, win.x, win.z);
    if (d < best || (d === 0 && hull && rectArea(h.rect) < rectArea(hull.rect))) {
      best = d;
      hull = h;
    }
  }
  const y = win.y;
  if (!hull) {
    return {
      pos: win.clone(), near: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1], hull: null,
      boxMin: new THREE.Vector3(win.x - STREET, ground, win.z - STREET), boxMax: new THREE.Vector3(win.x + STREET, y + 400, win.z + STREET),
    };
  }
  const r = hull.rect;
  const cx = (r.minX + r.maxX) / 2, cz = (r.minZ + r.maxZ) / 2, hx = (r.maxX - r.minX) / 2, hz = (r.maxZ - r.minZ) / 2;
  return {
    pos: new THREE.Vector3(cx, y, cz),
    near: [hx + PAST_FACADE, hx + PAST_FACADE, Math.max(0.1, hull.top - y + PAST_FACADE), Math.max(0.1, y - ground - 0.6), hz + PAST_FACADE, hz + PAST_FACADE],
    boxMin: new THREE.Vector3(r.minX - STREET, ground, r.minZ - STREET),
    boxMax: new THREE.Vector3(r.maxX + STREET, y + 400, r.maxZ + STREET),
    hull,
  };
}
function rectArea(r: Rect) {
  return (r.maxX - r.minX) * (r.maxZ - r.minZ);
}

/** the window backdrops of a level (painted views; bathrooms' frosted ones have no map) */
export function windowMeshes(root: THREE.Object3D) {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    const mt = m.material as THREE.MeshStandardMaterial | undefined;
    if (m.isMesh && mt && !Array.isArray(mt) && mt.userData.windowView && mt.emissiveMap) out.push(m);
  });
  return out;
}

/** the centre of a level's window backdrops, in the level's frame (null: no windows) */
export function windowCentre(meshes: THREE.Mesh[]) {
  if (!meshes.length) return null;
  const b = new THREE.Box3();
  for (const m of meshes) {
    m.geometry.computeBoundingBox();
    m.updateWorldMatrix(true, false);
    b.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld));
  }
  return b.getCenter(new THREE.Vector3());
}

export interface ViewEntry {
  key: string;
  rt: { texture: THREE.Texture; dispose(): void };
  spot: Spot;
  /** faces rendered so far (6 = done) */
  faces: number;
}

/** captures by building / floor / outdoor light, least recently used first; dispose on evict */
export class ViewCache {
  map = new Map<string, ViewEntry>();
  constructor(public cap = 3) {}
  get(key: string) {
    const e = this.map.get(key);
    if (e) {
      this.map.delete(key);
      this.map.set(key, e);
    }
    return e ?? null;
  }
  add(e: ViewEntry) {
    this.map.set(e.key, e);
    while (this.map.size > this.cap) {
      const [k, old] = this.map.entries().next().value!;
      this.map.delete(k);
      old.rt.dispose();
    }
  }
  clear() {
    for (const e of this.map.values()) e.rt.dispose();
    this.map.clear();
  }
}

const VERT = /* glsl */ `
varying vec3 vPos;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPos = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FRAG = /* glsl */ `
uniform samplerCube uCube;
uniform mat4 uWorld;
uniform vec3 uCap, uBoxMin, uBoxMax;
uniform float uGain;
varying vec3 vPos;
void main() {
  // the view ray, in the city's frame
  vec3 o = (uWorld * vec4(vPos, 1.0)).xyz;
  vec3 c = (uWorld * vec4(cameraPosition, 1.0)).xyz;
  vec3 d = normalize(o - c);
  // box projection: where the ray leaves the street box, seen from the capture point
  vec3 o2 = clamp(o, uBoxMin + 0.01, uBoxMax - 0.01);
  vec3 tA = (uBoxMax - o2) / d, tB = (uBoxMin - o2) / d;
  vec3 tf = max(tA, tB);
  float t = min(min(tf.x, tf.y), tf.z);
  vec3 dir = o2 + d * t - uCap;
  gl_FragColor = vec4(textureCube(uCube, dir).rgb * uGain, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** the window-plane material for one capture (one per level; the level's dispose frees it) */
export function viewMaterial(e: ViewEntry, world: THREE.Matrix4, gain: number) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uCube: { value: e.rt.texture },
      uWorld: { value: world.clone() },
      uCap: { value: e.spot.pos.clone() },
      uBoxMin: { value: e.spot.boxMin.clone() },
      uBoxMax: { value: e.spot.boxMax.clone() },
      uGain: { value: gain },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: false,
  });
  m.name = 'window-view';
  m.userData.owned = true; // dispose.ts: freed with the level (not its texture: the cache owns that)
  m.userData.realView = true;
  return m;
}

export interface WindowViewOpts {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** run renders with the outdoor light (lighting.asOutdoor); false: no outdoor light yet */
  asOutdoor: (fn: () => void) => boolean;
  outdoorKey: () => string | null;
  /** outdoor exposure / the current (indoor) exposure */
  gain: () => number;
  size?: number;
  /** false: keep the painted backdrops */
  enabled?: boolean;
}
interface City {
  group: THREE.Object3D;
  hulls: Hullish[];
}

export class WindowViews {
  cache = new ViewCache(3);
  stats = { captures: 0, faces: 0, hits: 0, applied: 0, freed: 0, maxFaceMs: 0, lastSpot: null as THREE.Vector3 | null, lastWindow: null as THREE.Vector3 | null };
  private level: Level | null = null;
  private world: THREE.Matrix4 | null = null;
  private city: City | null = null;
  private pending: ViewEntry | null = null;
  private cam: THREE.CubeCamera | null = null;
  constructor(private o: WindowViewOpts) {}

  /** the active level and its place in the city (null: not in the city's frame, e.g. a museum) */
  setLevel(level: Level, world: THREE.Matrix4 | null, city: City | null) {
    if (level === this.level || this.o.enabled === false) return;
    this.level = level;
    this.world = world;
    this.city = city;
    this.pending = null;
    // on the street (or anywhere not in a building): the building's captures go
    if (!world || !city || level.group === city.group) {
      if (this.cache.map.size) this.stats.freed += this.cache.map.size;
      this.cache.clear();
      return;
    }
    const meshes = windowMeshes(level.group);
    const c = windowCentre(meshes);
    const okey = this.o.outdoorKey();
    if (!c || !okey) return;
    const win = c.applyMatrix4(world);
    const spot = captureSpot(win, city.hulls);
    this.stats.lastWindow = win.clone();
    this.stats.lastSpot = spot.pos.clone();
    const r = spot.hull?.rect;
    const key = `${r ? `${r.minX.toFixed(1)},${r.minZ.toFixed(1)}` : `${win.x.toFixed(0)},${win.z.toFixed(0)}`}|${win.y.toFixed(1)}|${okey}`;
    const hit = this.cache.get(key);
    if (hit && hit.faces === 6) {
      this.stats.hits++;
      this.apply(hit);
      return;
    }
    const size = this.o.size ?? 256;
    const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const e: ViewEntry = { key, rt, spot, faces: 0 };
    this.cache.add(e);
    this.pending = e;
    this.stats.captures++;
  }

  /** once a frame: render one face of a pending capture; the last one puts it on the windows */
  update() {
    const e = this.pending, city = this.city, level = this.level;
    if (!e || !city || !level) return;
    if (!this.cache.map.has(e.key)) return void (this.pending = null);
    const rt = e.rt as THREE.WebGLCubeRenderTarget;
    if (!this.cam) this.cam = new THREE.CubeCamera(0.1, 900, rt);
    const cam = this.cam;
    cam.renderTarget = rt;
    cam.position.copy(e.spot.pos);
    cam.updateMatrixWorld(true);
    const face = e.faces;
    const fc = cam.children[face] as THREE.PerspectiveCamera;
    fc.near = e.spot.near[face];
    fc.far = 900;
    fc.updateProjectionMatrix();
    const r = this.o.renderer, sc = this.o.scene;
    const added = !city.group.parent;
    const lights: THREE.Object3D[] = [];
    const t0 = performance.now();
    const ok = this.o.asOutdoor(() => {
      // the city in, its own lights out (the light count stays: no recompiles), the room far away
      if (added) sc.add(city.group);
      city.group.traverse((o) => {
        if ((o as THREE.Light).isLight && o.visible) {
          o.visible = false;
          lights.push(o);
        }
      });
      level.group.position.y -= 1e4;
      level.group.updateMatrixWorld(true);
      const prevRT = r.getRenderTarget(), prevFace = r.getActiveCubeFace(), prevAuto = r.shadowMap.autoUpdate, xr = r.xr.enabled;
      r.shadowMap.autoUpdate = false;
      r.xr.enabled = false;
      try {
        r.setRenderTarget(rt, face);
        r.clear();
        r.render(sc, fc);
      } finally {
        r.setRenderTarget(prevRT, prevFace);
        r.shadowMap.autoUpdate = prevAuto;
        r.xr.enabled = xr;
        level.group.position.y += 1e4;
        level.group.updateMatrixWorld(true);
        for (const l of lights) l.visible = true;
        if (added) sc.remove(city.group);
      }
    });
    if (!ok) return void (this.pending = null);
    e.faces++;
    this.stats.maxFaceMs = Math.max(this.stats.maxFaceMs, performance.now() - t0);
    this.stats.faces++;
    if (e.faces === 6) {
      this.pending = null;
      this.apply(e);
    }
  }

  private apply(e: ViewEntry) {
    if (!this.level || !this.world) return;
    const m = viewMaterial(e, this.world, this.o.gain());
    for (const mesh of windowMeshes(this.level.group)) mesh.material = m;
    this.stats.applied++;
  }

  dispose() {
    this.cache.clear();
    this.pending = null;
  }
}
