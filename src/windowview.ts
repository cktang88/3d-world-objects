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
    if (m.isMesh && mt && !Array.isArray(mt) && mt.userData.windowView && (mt.emissiveMap || mt.userData.viewPlane)) out.push(m);
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
uniform vec3 uCap, uBoxMin, uBoxMax, uGradeGain, uGradeLift;
uniform float uGain, uSat, uContrast, uNight;
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
  vec3 sky = textureCube(uCube, dir).rgb;
  // night: blue-dominant pixels (the sky, and facades and street under the night sky's blue
  // fog and light; it was a royal-blue wall) at 0.4x and towards a neutral navy, before tone
  // mapping; warm things (sodium lamps, lit windows) are not blue-dominant: kept
  float sl = dot(sky, vec3(0.2126, 0.7152, 0.0722));
  float blue = (sky.b - max(sky.r, sky.g)) / max(sl, 1e-4);
  float ks = uNight * smoothstep(0.05, 0.4, blue);
  // (the captured night sky can be far past the tone curve's knee: a scale alone still clips to
  // royal blue, so after tone mapping it is replaced by a bounded dark navy: see below)
  gl_FragColor = vec4(sky * uGain, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // the street's colour grade (gain / lift, saturation, contrast) on display values, as the grade
  // pass does on screen (in linear light its lift and S-curve crushed a night sky into saturated
  // blue). At night the blue gain and the saturation are held back further: a dark navy sky,
  // the sodium lamps stay warm
  vec3 gg = mix(uGradeGain, vec3(dot(uGradeGain, vec3(0.3333))), 0.7 * uNight);
  vec3 col = clamp(gl_FragColor.rgb, 0.0, 1.0);
  // the night grade's lift is blue: added to every dark pixel it made the whole view a uniform
  // royal blue (the screen adds it over a darker, post-processed image); neutral and halved at night
  vec3 gl = mix(uGradeLift, vec3(dot(uGradeLift, vec3(0.3333))), 0.85 * uNight) * mix(1.0, 0.5, uNight);
  col = col * gg + gl * (1.0 - col);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat * mix(1.0, 0.55, uNight));
  gl_FragColor.rgb = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);
  // night sky -> a bounded dark navy, sRGB ~20 / 25 / 52 (linear here, converted the way this pass
  // outputs: sRGB on screen, linear into post), last so the grade's contrast cannot crush it
  // and a dark night sky of any hue (above the horizon, dim: not a lamp or a lit window) is lifted
  // to the same navy, lighter and a little warmer towards the horizon (the city's light haze)
  float up = normalize(dir).y;
  float kd = uNight * smoothstep(-0.02, 0.08, up) * (1.0 - smoothstep(0.03, 0.25, sl * uGain));
  vec3 navy = mix(vec3(0.022, 0.020, 0.030), vec3(0.0125, 0.0135, 0.034), smoothstep(0.0, 0.45, up));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, linearToOutputTexel(vec4(navy * (1.0 + 0.3 * smoothstep(0.0, 4.0, sl)), 1.0)).rgb, max(ks, kd));
}`;

export interface Grade {
  gain: THREE.Vector3;
  lift: THREE.Vector3;
  sat: number;
  contrast: number;
  /** 0 day .. 1 night */
  night?: number;
}

/** the window-plane material for one capture (one per level; the level's dispose frees it) */
export function viewMaterial(e: ViewEntry, world: THREE.Matrix4, gain: number, grade: Grade | null) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uCube: { value: e.rt.texture },
      uWorld: { value: world.clone() },
      uCap: { value: e.spot.pos.clone() },
      uBoxMin: { value: e.spot.boxMin.clone() },
      uBoxMax: { value: e.spot.boxMax.clone() },
      uGain: { value: gain },
      uGradeGain: { value: grade?.gain.clone() ?? new THREE.Vector3(1, 1, 1) },
      uGradeLift: { value: grade?.lift.clone() ?? new THREE.Vector3() },
      uSat: { value: grade?.sat ?? 1 },
      uContrast: { value: grade?.contrast ?? 1 },
      uNight: { value: grade?.night ?? 0 },
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
  asOutdoor: (fn: () => void, fogMul: number) => boolean;
  outdoorKey: () => string | null;
  /** outdoor exposure / the current (indoor) exposure */
  gain: () => number;
  /** the street's colour grade */
  grade?: () => Grade | null;
  /** the time of day / weather changed while indoors, and the outdoor light to recompute it */
  stale?: () => boolean;
  refresh?: () => Promise<boolean>;
  /** a capture needs the city level and it is gone: build it (it arrives in a later update) */
  needCity?: () => void;
  /** a capture is done: the city level may go (memory) */
  release?: () => void;
  size?: number;
  /** false: keep the painted backdrops */
  enabled?: boolean;
}
export interface City {
  group: THREE.Object3D;
  hulls: Hullish[];
  /** streamed at the building after a rebuild (Level.update) */
  level?: Pick<Level, 'update'>;
}
/** fog for the near range of a capture: the street across reads crisp; far towers still fade */
export const CAPTURE_FOG = 0.35;
/** frames the city streams at the building after it was rebuilt for a recapture */
const WARM = 30;
/** at most one outdoor-light refresh (and recapture) this often */
const REFRESH_MS = 20000;

export class WindowViews {
  cache = new ViewCache(3);
  stats = { captures: 0, faces: 0, hits: 0, applied: 0, freed: 0, maxFaceMs: 0, refreshes: 0, rebuilds: 0, releases: 0, lastSpot: null as THREE.Vector3 | null, lastWindow: null as THREE.Vector3 | null };
  private level: Level | null = null;
  private world: THREE.Matrix4 | null = null;
  private meshes: THREE.Mesh[] = [];
  private local: THREE.Vector3 | null = null;
  private hulls: Hullish[] | null = null;
  private applied: string | null = null;
  private pending: ViewEntry | null = null;
  private warm = 0;
  private asked = false;
  private refreshing = false;
  private tick = 0;
  private mat: THREE.Material | null = null;
  private lastRefresh = -1e9;
  private cam: THREE.CubeCamera | null = null;
  constructor(private o: WindowViewOpts) {}

  /** the active level and its place in the city (null: not in the city's frame); street: on the city level itself */
  setLevel(level: Level, world: THREE.Matrix4 | null, street = false) {
    if (level === this.level || this.o.enabled === false) return;
    this.level = level;
    this.world = world;
    this.pending = null;
    this.applied = null;
    this.asked = false;
    this.meshes = [];
    this.local = null;
    this.mat = null;
    // on the street (or anywhere not in the city): the building's captures go
    if (!world || street) {
      if (this.cache.map.size) this.stats.freed += this.cache.map.size;
      this.cache.clear();
      if (street) this.hulls = null;
      return;
    }
    this.meshes = windowMeshes(level.group);
    this.local = windowCentre(this.meshes);
  }

  /** the capture this room wants now (null: no windows, or nothing known yet) */
  private memo: { okey: string; hulls: Hullish[]; level: Level; w: { key: string; spot: Spot; win: THREE.Vector3 } } | null = null;
  private want() {
    const okey = this.o.outdoorKey();
    if (!this.local || !this.world || !okey || !this.hulls) return null;
    const m = this.memo;
    if (m && m.okey === okey && m.hulls === this.hulls && m.level === this.level) return m.w;
    const w = this.want0(okey);
    this.memo = { okey, hulls: this.hulls, level: this.level!, w };
    return w;
  }
  private want0(okey: string) {
    const win = this.local!.clone().applyMatrix4(this.world!);
    const spot = captureSpot(win, this.hulls!);
    const r = spot.hull?.rect;
    const key = `${r ? `${r.minX.toFixed(1)},${r.minZ.toFixed(1)}` : `${win.x.toFixed(0)},${win.z.toFixed(0)}`}|${win.y.toFixed(1)}|${okey}`;
    return { key, spot, win };
  }
  /** once a frame (city: the live city level, or null when it is not built) */
  update(city: City | null = null) {
    if (!this.level || !this.world || this.o.enabled === false) return;
    // rooms are built in stages and cells lazily: backdrops that appear later get the view too
    if (++this.tick % 30 === 0) {
      const more = windowMeshes(this.level.group);
      if (more.length) {
        this.meshes.push(...more.filter((m) => !this.meshes.includes(m)));
        if (!this.local) this.local = windowCentre(this.meshes);
        if (this.mat) for (const m of more) m.material = this.mat;
      }
    }
    if (!this.local) return;
    if (city) this.hulls = city.hulls;
    // time of day / weather changed while indoors: recompute the outdoor light first
    if (this.o.stale?.()) {
      if (!this.refreshing && this.o.refresh && performance.now() - this.lastRefresh > REFRESH_MS) {
        this.lastRefresh = performance.now();
        this.refreshing = true;
        this.stats.refreshes++;
        this.o.refresh().finally(() => (this.refreshing = false));
      }
      return;
    }
    if (!this.hulls && !city) return this.ask();
    const w = this.want();
    if (!w || w.key === this.applied) return;
    const hit = this.cache.get(w.key);
    if (hit && hit.faces === 6) {
      this.stats.hits++;
      this.apply(hit);
      return;
    }
    if (!this.pending || this.pending.key !== w.key || !this.cache.map.has(w.key)) {
      if (this.pending && this.cache.map.has(this.pending.key) && this.pending.faces < 6) {
        this.cache.map.get(this.pending.key)!.rt.dispose();
        this.cache.map.delete(this.pending.key);
      }
      const size = this.o.size ?? 256;
      const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      this.pending = { key: w.key, rt, spot: w.spot, faces: 0 };
      this.cache.add(this.pending);
      this.stats.captures++;
      this.stats.lastWindow = w.win.clone();
      this.stats.lastSpot = w.spot.pos.clone();
    }
    if (!city) return this.ask();
    if (this.warm > 0) {
      // a rebuilt city streams the blocks around the building before it is captured
      this.warm--;
      city.level?.update(1 / 30, _p.copy(this.pending.spot.pos).setY(0), performance.now() / 1000);
      return;
    }
    this.face(this.pending, city, this.level);
  }

  private ask() {
    if (this.asked || !this.o.needCity) return;
    this.asked = true;
    this.warm = WARM;
    this.stats.rebuilds++;
    this.o.needCity();
  }

  private face(e: ViewEntry, city: City, level: Level) {
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
    }, CAPTURE_FOG * (1 - 0.6 * (this.o.grade?.()?.night ?? 0))); // night fog is the sky's blue: less of it
    if (!ok) return;
    e.faces++;
    this.stats.maxFaceMs = Math.max(this.stats.maxFaceMs, performance.now() - t0);
    this.stats.faces++;
    if (e.faces === 6) {
      this.pending = null;
      this.apply(e);
      this.asked = false;
      this.stats.releases++;
      this.o.release?.();
    }
  }

  private apply(e: ViewEntry) {
    if (!this.level || !this.world) return;
    const m = viewMaterial(e, this.world, this.o.gain(), this.o.grade?.() ?? null);
    for (const mesh of this.meshes) {
      const old = mesh.material as THREE.Material;
      if (old.userData.realView) old.dispose(); // an earlier capture of this room (time of day changed)
      mesh.material = m;
    }
    this.mat = m;
    this.applied = e.key;
    this.stats.applied++;
  }

  dispose() {
    this.cache.clear();
    this.pending = null;
  }
}
const _p = new THREE.Vector3();
