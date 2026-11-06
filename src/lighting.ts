import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { FLAGS } from './flags';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Env } from './level';
import { skyTex } from './textures';
import { hashStr } from './rng';
import { sidewalkMat } from './nyc/common';

/**
 * Global lighting: image-based lighting from CC0 Poly Haven HDRIs, cascaded sun shadows,
 * time of day (day / golden hour / dusk / night), fog, bloom and colour grading.
 * See docs/research/lighting.md for the references this is tuned against.
 *
 * Other modules can read the night factor (0 = full day, 1 = full night) with getNight(),
 * or hook their materials in with litWindows() / wetSurface() / streetLightMarker().
 */

export type TimeOfDay = 'day' | 'golden' | 'dusk' | 'night';
export const TIMES: TimeOfDay[] = ['day', 'golden', 'dusk', 'night'];
export type Place = 'outdoor' | 'museum' | 'shop' | 'interior' | 'studio';
export type Quality = 'ultra' | 'high' | 'low';

export interface Preset {
  label: string;
  /** Poly Haven HDRI id (CC0) */
  hdri: string;
  /** rotate the HDRI so its sun lands at sunAz (true), or use sunAz/sunElev for the light as given */
  align: boolean;
  sunAz: number;
  sunElev: number;
  sunColor: string;
  sunIntensity: number;
  /** mean radiance of the upper sky after normalising the HDRI (scene units) */
  sky: number;
  /** clip HDRI pixels brighter than this many times the median sky (the sun is the directional light) */
  clampMul: number;
  /** saturation of the image-based light / background (tames very blue skies, sodium-yellow skylines) */
  envSat: number;
  exposure: number;
  /**
   * light bounced off sunlit facades into the street canyon (a hemisphere light: warm from below,
   * neutral from above), in place of the GI we don't have; keeps shade from going sky-blue
   */
  bounce: { sky: string; ground: string; intensity: number };
  /** exponential fog density (1/m), tinted from the HDRI horizon */
  fog: number;
  /** colour the HDRI-horizon fog colour is pulled towards, by fogTintMix */
  fogTint: string;
  fogTintMix: number;
  night: number;
  /** share of apartment windows lit */
  lit: number;
  /** street wetness 0..1 */
  wet: number;
  bloom: { strength: number; radius: number; threshold: number };
  grade: { gain: string; lift: string; sat: number; contrast: number; vignette: number };
}

export const PRESETS: Record<TimeOfDay, Preset> = {
  day: {
    label: 'Day', hdri: 'docklands_02', align: true, sunAz: 235, sunElev: 48, sunColor: '#fff1dd', sunIntensity: 6,
    sky: 0.6, clampMul: 12, envSat: 0.7, exposure: 0.58, bounce: { sky: '#dcd6cc', ground: '#b49478', intensity: 0.55 }, fog: 0.0012, fogTint: '#aab6c2', fogTintMix: 0, night: 0, lit: 0.04, wet: 0,
    bloom: { strength: 0.12, radius: 0.4, threshold: 3.0 },
    grade: { gain: '#fffaf4', lift: '#04060a', sat: 1.04, contrast: 1.04, vignette: 0.22 },
  },
  golden: {
    label: 'Golden hour', hdri: 'venice_sunset', align: true, sunAz: 250, sunElev: 8, sunColor: '#ffb067', sunIntensity: 5.5,
    sky: 0.55, clampMul: 10, envSat: 0.95, exposure: 0.8, bounce: { sky: '#d8c8b8', ground: '#c08860', intensity: 0.35 }, fog: 0.0022, fogTint: '#c8a890', fogTintMix: 0, night: 0.15, lit: 0.12, wet: 0,
    bloom: { strength: 0.2, radius: 0.5, threshold: 2.2 },
    grade: { gain: '#fff1e0', lift: '#060812', sat: 1.08, contrast: 1.06, vignette: 0.28 },
  },
  dusk: {
    label: 'Dusk (blue hour)', hdri: 'sunset_jhbcentral', align: true, sunAz: 250, sunElev: 5, sunColor: '#8fa2d8', sunIntensity: 0.45,
    sky: 0.12, clampMul: 30, envSat: 0.95, exposure: 1.3, bounce: { sky: '#8890a8', ground: '#6a5a50', intensity: 0.04 }, fog: 0.002, fogTint: '#6f7fa8', fogTintMix: 0.8, night: 0.75, lit: 0.3, wet: 0.35,
    bloom: { strength: 0.45, radius: 0.55, threshold: 1.0 },
    grade: { gain: '#f6f6ff', lift: '#06081a', sat: 1.08, contrast: 1.05, vignette: 0.32 },
  },
  night: {
    label: 'Night', hdri: 'shanghai_bund', align: false, sunAz: 140, sunElev: 50, sunColor: '#8ea4d6', sunIntensity: 0.12,
    sky: 0.04, clampMul: 400, envSat: 0.55, exposure: 1.35, bounce: { sky: '#404050', ground: '#4a3a2a', intensity: 0.03 }, fog: 0.0022, fogTint: '#2a2a3a', fogTintMix: 0.8, night: 1, lit: 0.36, wet: 0.8,
    bloom: { strength: 0.5, radius: 0.5, threshold: 0.8 },
    grade: { gain: '#fbfaff', lift: '#050712', sat: 1.12, contrast: 1.08, vignette: 0.38 },
  },
};

/**
 * Overcast sky (for src/weather.ts: setWeather({ overcast })): a soft, shadowless grey HDRI.
 * Blended over the time-of-day preset by daylight (it fades out towards night), keeping that
 * preset's night factor, lit windows and wetness.
 */
export const OVERCAST: Preset = {
  label: 'Overcast', hdri: 'potsdamer_platz', align: false, sunAz: 235, sunElev: 50, sunColor: '#e8ecf0', sunIntensity: 0.9,
  sky: 0.75, clampMul: 30, envSat: 0.55, exposure: 0.66, bounce: { sky: '#d0d2d4', ground: '#8a8478', intensity: 0.12 }, fog: 0.0024, fogTint: '#b4b8bc', fogTintMix: 0.5, night: 0, lit: 0.06, wet: 0,
  bloom: { strength: 0.08, radius: 0.4, threshold: 3.0 },
  grade: { gain: '#fbfcff', lift: '#05060a', sat: 0.94, contrast: 1.02, vignette: 0.2 },
};

const _ca = new THREE.Color(), _cb = new THREE.Color();
/**
 * Interpolate two presets (numbers linearly, #hex colours in linear RGB; other strings and
 * booleans switch at the midpoint). Used for smooth time-of-day / overcast transitions.
 */
export function blendPreset<T>(a: T, b: T, t: number): T {
  if (typeof a === 'number' && typeof b === 'number') return (a + (b - a) * t) as T;
  if (typeof a === 'string' && typeof b === 'string') {
    if (/^#[0-9a-f]{6}$/i.test(a) && /^#[0-9a-f]{6}$/i.test(b)) return ('#' + _ca.set(a).lerp(_cb.set(b), t).getHexString()) as T;
    return (t < 0.5 ? a : b) as T;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(a as object)) out[k] = blendPreset((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], t);
    return out as T;
  }
  if (a === undefined) return (t < 0.5 ? a : b) as T;
  if (b === undefined) return (t < 0.5 ? a : b) as T;
  return (t < 0.5 ? a : b) as T;
}

/** CC0 indoor HDRIs (Poly Haven) used as image-based light for each kind of interior */
export const INDOOR_HDRI: Record<Exclude<Place, 'outdoor' | 'studio'>, { hdri: string; mean: number }> = {
  museum: { hdri: 'sculpture_exhibition', mean: 0.75 },
  shop: { hdri: 'phone_shop', mean: 0.7 },
  interior: { hdri: 'lebombo', mean: 0.55 },
};

// ---------------------------------------------------------------- shared uniforms / hooks

const U = {
  night: { value: 0 },
  lit: { value: 0 },
  wet: { value: 0 },
  /** planar reflection of bright things (lit windows, signs, lamps, signals) for wet ground */
  reflTex: { value: null as THREE.Texture | null },
  reflMat: { value: new THREE.Matrix4() },
  reflOn: { value: 0 },
};
/** layer of the meshes that show in wet-ground reflections (emissive things; lighting.ts tags them) */
export const REFLECT_LAYER = 5;
/** shadow casters with a bounding radius of at least 0.8 m / 6 m (bounding-sphere radius) also sit on these layers: the middle / far cascades draw only them */
export const CASTER_MID = 6;
export const CASTER_FAR = 7;

// [hlod] cascade layer hook for nyc/hlod.ts: extra layers every cascade also renders, and an
// exclusive layer for the farthest cascade (the city proxies stand in for everything there).
// Kept here so it survives the cascades being rebuilt (quality / place changes).
const cascadeHook: { extra: number[]; farOnly: number | null } = { extra: [], farOnly: null };
let activeCsm: CSM | null = null;
/**
 * lighting.ts: the far cascade is proxy-only only while proxies are actually in the scene (the
 * NYC level); in labs, the studio or a city biome it keeps lighting's default (big casters), else
 * it would cast nothing at all there.
 */
let proxiesPresent = false;

// [perf] scene-graph changes anywhere (add / attach) queue the added subtrees, so per-frame work (CSM material
// wrapping, caster tagging, light and far-proxy lists) only looks at what is new instead of walking the scene
let pendingAdds: THREE.Object3D[] = [];
let pendingOverflow = false;
{
  const P = THREE.Object3D.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const k of ['add', 'attach']) {
    const f = P[k];
    P[k] = function (this: THREE.Object3D, ...a: unknown[]) {
      if (!pendingOverflow) {
        for (const o of a) if (o && (o as THREE.Object3D).isObject3D) pendingAdds.push(o as THREE.Object3D);
        if (pendingAdds.length > 50000) {
          pendingOverflow = true; // nobody is draining (no lighting running): fall back to a full scan later
          pendingAdds = [];
        }
      }
      return f.apply(this, a);
    };
  }
}
/** what traverseVisible would visit: visible itself and up the chain, and attached under `root` */
function drawn(o: THREE.Object3D, root: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === root) return true;
  }
  return false;
}
function applyCascadeHook(csm: CSM | null) {
  if (!csm) return;
  const n = csm.lights.length;
  csm.lights.forEach((l, i) => {
    const L = l.shadow.camera.layers;
    // lighting's defaults first (mid: casters >= 0.8 m, far: >= 6 m), then the hook on top
    if (i === 1) L.set(CASTER_MID);
    if (i === 2) L.set(CASTER_FAR);
    if (cascadeHook.farOnly !== null && proxiesPresent && i === n - 1 && n > 1) {
      L.set(cascadeHook.farOnly);
      return;
    }
    for (const e of cascadeHook.extra) L.enable(e);
  });
}
/**
 * three r170's WebGLShadowMap tests object layers against the MAIN camera, not the shadow camera,
 * so per-cascade layer masks (CASTER_MID / CASTER_FAR, the HLOD proxy layer) had no effect. While
 * the shadow maps render, each cascade light swaps its shadow camera's mask onto the main camera
 * (shadow.updateMatrices runs right before that light's scene traversal); the mask is restored
 * after the shadow pass, before the main pass draws its (already built) render list.
 */
let shadowMainCam: THREE.Camera | null = null;
let shadowMainMask = 1;
const wrappedShadowMaps = new WeakSet<object>();
const cascadeShadows = new WeakSet<object>();
const layerWrapped = new WeakSet<object>();
function layerAwareShadows(renderer: THREE.WebGLRenderer, csm: CSM) {
  for (const l of csm.lights) cascadeShadows.add(l.shadow);
  const sm = renderer.shadowMap as THREE.WebGLShadowMap & { render: (lights: THREE.Light[], scene: THREE.Object3D, camera: THREE.Camera) => void };
  if (wrappedShadowMaps.has(sm)) return;
  wrappedShadowMaps.add(sm);
  const prev = sm.render.bind(sm);
  sm.render = (lights, scene, camera) => {
    shadowMainMask = camera.layers.mask;
    shadowMainCam = camera;
    // every shadow light: cascades swap in their camera's mask, any other light the main mask
    for (const l of lights) {
      const sh = (l as THREE.DirectionalLight).shadow as THREE.LightShadow | undefined;
      if (!sh || layerWrapped.has(sh)) continue;
      layerWrapped.add(sh);
      const upd = sh.updateMatrices.bind(sh) as (...a: unknown[]) => void;
      (sh as unknown as { updateMatrices: (...a: unknown[]) => void }).updateMatrices = (...a: unknown[]) => {
        upd(...a);
        if (shadowMainCam) shadowMainCam.layers.mask = cascadeShadows.has(sh) ? sh.camera.layers.mask : shadowMainMask;
      };
    }
    try {
      prev(lights, scene, camera);
    } finally {
      camera.layers.mask = shadowMainMask;
      shadowMainCam = null;
    }
  };
}
/** [hlod] extra shadow layers for all cascades + an exclusive layer for the farthest one (null: lighting's default) */
export function setCascadeLayers(extra: number[], farOnly: number | null) {
  cascadeHook.extra = extra;
  cascadeHook.farOnly = farOnly;
  applyCascadeHook(activeCsm);
}
function tagCaster(m: THREE.Mesh) {
  const g = m.geometry;
  if (!g) return;
  if (!g.boundingSphere) g.computeBoundingSphere();
  const r = (g.boundingSphere?.radius ?? 0) * m.matrixWorld.getMaxScaleOnAxis();
  m.userData.casterR = r;
  // instanced/batched meshes span many objects: always keep them
  const many = (m as THREE.InstancedMesh).isInstancedMesh || (m as unknown as { isBatchedMesh?: boolean }).isBatchedMesh;
  if (many || r >= 0.8) m.layers.enable(CASTER_MID);
  if (many || r >= 6) m.layers.enable(CASTER_FAR);
}
let night = 0;
let tod: TimeOfDay = 'day';
const listeners: ((t: TimeOfDay, night: number) => void)[] = [];

/** 0 = full daylight, 1 = full night. Read it every frame or subscribe with onTimeChange. */
export function getNight() {
  return night;
}
export function getTimeOfDay() {
  return tod;
}
export function onTimeChange(fn: (t: TimeOfDay, night: number) => void) {
  listeners.push(fn);
}

/** An invisible marker under a street lamp head: lighting adds real light and a light pool there at night. */
export function streetLightMarker(x: number, y: number, z: number) {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  o.name = 'streetlight';
  o.userData.streetLight = true;
  return o;
}

/**
 * Instanced window glass: at dusk/night a hashed share of the panes glow with warm interior
 * light (a ceiling-lit gradient, some cooler TV/LED rooms). Chains any existing onBeforeCompile.
 */
export function litWindows(m: THREE.MeshStandardMaterial) {
  if (m.userData.litWindows) return m;
  m.userData.litWindows = true;
  const prev = m.onBeforeCompile.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.uniforms.uNight = U.night;
    sh.uniforms.uLit = U.lit;
    sh.vertexShader = 'varying vec3 vWinLit;\nvarying vec2 vWinUv;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 wip = instanceMatrix[3].xyz + modelMatrix[3].xyz;
#else
vec3 wip = modelMatrix[3].xyz;
#endif
float wh = fract(sin(dot(floor(wip * 2.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
float wh2 = fract(wh * 91.17 + 0.31);
vWinLit = vec3(wh, wh2, fract(wh2 * 13.7));
vWinUv = uv;`,
    );
    sh.fragmentShader = 'uniform float uNight;\nuniform float uLit;\nvarying vec3 vWinLit;\nvarying vec2 vWinUv;\n' + sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
{
  float on = step(vWinLit.x, uLit) * uNight;
  // warm incandescent / LED rooms, a few blue TV-lit ones; brighter towards the ceiling
  vec3 warm = mix(vec3(1.0, 0.45, 0.14), vec3(1.0, 0.7, 0.4), vWinLit.y);
  vec3 tint = vWinLit.z > 0.88 ? vec3(0.45, 0.6, 1.0) : warm;
  float grad = 0.55 + 0.45 * smoothstep(0.0, 1.0, vWinUv.y);
  float blind = vWinLit.z < 0.25 ? 0.55 : 1.0;
  totalEmissiveRadiance += tint * on * grad * blind * (0.18 + 0.5 * vWinLit.y);
  diffuseColor.rgb *= 1.0 - 0.7 * on;
}`,
    );
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => key() + '|litwin';
  m.needsUpdate = true;
  return m;
}

/**
 * Wet asphalt/paving: darker albedo and glossy puddles (world-space noise) as the night/rain
 * wetness rises, so street lights, signs and the sky reflect in the road.
 */
export function wetSurface(m: THREE.MeshStandardMaterial, amount = 1) {
  if (m.userData.wet) return m;
  m.userData.wet = true;
  const prev = m.onBeforeCompile.bind(m);
  const k = { value: amount };
  m.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.uniforms.uWet = U.wet;
    sh.uniforms.uWetK = k;
    sh.uniforms.uReflTex = U.reflTex;
    sh.uniforms.uReflMat = U.reflMat;
    sh.uniforms.uReflOn = U.reflOn;
    sh.vertexShader = 'varying vec3 vWetPos;\n' + sh.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
vWetPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
    );
    sh.fragmentShader = `uniform float uWet;\nuniform float uWetK;\nvarying vec3 vWetPos;
uniform sampler2D uReflTex;
uniform mat4 uReflMat;
uniform float uReflOn;
float wetHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wetNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wetHash(i), wetHash(i + vec2(1, 0)), u.x), mix(wetHash(i + vec2(0, 1)), wetHash(i + vec2(1, 1)), u.x), u.y);
}
` + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
float wetAmt = uWet * uWetK;
float puddle = smoothstep(0.45, 0.75, wetNoise(vWetPos.xz * 0.18) * 0.7 + wetNoise(vWetPos.xz * 0.9) * 0.3);
float wetMask = wetAmt * mix(0.55, 1.0, puddle);
diffuseColor.rgb *= 1.0 - 0.45 * wetMask;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, mix(0.32, 0.06, puddle), wetMask);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
normal = normalize(mix(normal, normalize(vNormal), wetAmt * puddle));`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
if (uReflOn > 0.5 && wetMask > 0.02) {
  // the mirrored bright things, smeared vertically on rough wet asphalt, sharp in puddles
  vec4 rc = uReflMat * vec4(vWetPos, 1.0);
  vec2 ruv = rc.xy / rc.w + normal.xz * 0.01;
  float smear = mix(0.022, 0.003, puddle);
  // per-pixel jitter between the taps (dithered, so the streak is smooth rather than dashed)
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
  vec3 rr = vec3(0.0);
  float wsum = 0.0;
  for (int k = -4; k <= 4; k++) {
    float o = float(k) + jit;
    float wk = 1.0 - abs(o) / 5.0;
    rr += texture2D(uReflTex, ruv + vec2(0.0, o * smear)).rgb * wk;
    wsum += wk;
  }
  rr /= wsum;
  float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 5.0);
  gl_FragColor.rgb += rr * wetMask * mix(0.35, 1.0, puddle) * (0.25 + 0.75 * fres);
}`);
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => key() + '|wet2';
  m.needsUpdate = true;
  return m;
}

// ---------------------------------------------------------------- weather hook

/**
 * Modifiers another module (src/weather.ts) can drive on top of the time-of-day preset.
 * Multipliers are relative to the preset; wet is a floor on the preset's own wetness.
 * Call setWeather({...}) whenever they change (cheap: no HDRI reload, no shader recompiles).
 */
export interface WeatherMods {
  /** 0 clear .. 1 overcast (informational; the multipliers below do the work) */
  cloud: number;
  sunMul: number;
  /** sky / environment light and background brightness */
  skyMul: number;
  /** fog density multiplier, and an optional colour the fog moves towards (fogMix 0..1) */
  fogMul: number;
  fogColor: string | null;
  fogMix: number;
  /** street wetness floor 0..1 */
  wet: number;
  /** 0..1: blend the sky, image-based light and grade towards the OVERCAST preset (daylight only) */
  overcast: number;
}
export const weather: WeatherMods = { cloud: 0, sunMul: 1, skyMul: 1, fogMul: 1, fogColor: null, fogMix: 0, wet: 0, overcast: 0 };
let rig: Lighting | null = null;
export function setWeather(w: Partial<WeatherMods>) {
  Object.assign(weather, w);
  rig?.applyWeather();
}

// ---------------------------------------------------------------- HDRI loading

interface Hdri {
  /** full-res equirect for the sky dome, rotated into the world frame */
  tex: THREE.DataTexture;
  /** PMREM (always ENV_SIZE, built from a 1024-wide copy) so every environment map shares one shader variant */
  env: THREE.Texture;
  /** sun direction (world frame after rotation), or null */
  sun: THREE.Vector3 | null;
  /** mean upper-sky radiance after clamping */
  skyMean: number;
  mean: number;
  horizon: THREE.Color;
}

const hdriCache = new Map<string, Promise<Hdri | null>>();

/**
 * Rotate an equirect about the vertical axis in place: a world direction with azimuth phi
 * (atan2(x, z), the sunAz convention) then shows what the image had at phi - alpha.
 * Baking the rotation into the pixels lets two HDRIs with different rotations blend.
 */
export function rotateEquirect(tex: THREE.DataTexture, alpha: number) {
  const img = tex.image as unknown as { data: Uint16Array; width: number; height: number };
  const { data, width: W, height: H } = img;
  const shift = Math.round((alpha / (Math.PI * 2)) * W);
  const k = ((shift % W) + W) % W;
  if (!k) return;
  const row = new Uint16Array(W * 4);
  for (let r = 0; r < H; r++) {
    const o = r * W * 4;
    row.set(data.subarray(o, o + W * 4));
    for (let c = 0; c < W; c++) {
      const src = ((c + k) % W) * 4;
      data[o + c * 4] = row[src];
      data[o + c * 4 + 1] = row[src + 1];
      data[o + c * 4 + 2] = row[src + 2];
      data[o + c * 4 + 3] = row[src + 3];
    }
  }
  tex.needsUpdate = true;
}

/** a box-filtered copy at most maxW wide (the PMREM is built from it, so its size is fixed) */
export function downsampleEquirect(tex: THREE.DataTexture, maxW: number): THREE.DataTexture {
  const img = tex.image as unknown as { data: Uint16Array; width: number; height: number };
  const f = Math.max(1, Math.round(img.width / maxW));
  if (f === 1) return tex;
  const W = Math.floor(img.width / f), H = Math.floor(img.height / f);
  const out = new Uint16Array(W * H * 4);
  const half = THREE.DataUtils.fromHalfFloat, toHalf = THREE.DataUtils.toHalfFloat;
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++)
      for (let k = 0; k < 4; k++) {
        let sum = 0;
        for (let y = 0; y < f; y++) for (let x = 0; x < f; x++) sum += half(img.data[((r * f + y) * img.width + c * f + x) * 4 + k]);
        out[(r * W + c) * 4 + k] = toHalf(sum / (f * f));
      }
  const t = new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  t.flipY = tex.flipY;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
/** ?notex=1 (fast testing): no HDRI downloads; outdoor uses the physical sky, indoor the RoomEnvironment */
const NO_HDRI = typeof location !== 'undefined' && /[?&](notex|nohdri)=?1?(&|$)/.test(location.search);

function dirFromPixel(c: number, r: number, W: number, H: number, out: THREE.Vector3) {
  const a = ((c + 0.5) / W - 0.5) * Math.PI * 2;
  const el = (0.5 - (r + 0.5) / H) * Math.PI;
  return out.set(Math.cos(el) * Math.cos(a), Math.sin(el), Math.cos(el) * Math.sin(a));
}

/**
 * Measure an equirect HDRI in place (exported for tests): median sky, sun direction, horizon
 * colour; clamps everything brighter than clampMul x median (the sun, which the directional light
 * supplies), desaturates by sat, and replaces non-finite pixels (Inf/NaN would turn the whole frame
 * black through PMREM and bloom) with the cap.
 */
export function analyse(tex: THREE.DataTexture, clampMul: number, sat = 1): Omit<Hdri, 'tex' | 'env'> {
  const img = tex.image as unknown as { data: Uint16Array; width: number; height: number };
  const { data, width: W, height: H } = img;
  const half = THREE.DataUtils.fromHalfFloat;
  const lum = new Float32Array(W * H);
  const BIG = 65504;
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    for (let k = 0; k < 3; k++) {
      const v = half(data[p + k]);
      if (!Number.isFinite(v) || v < 0) data[p + k] = THREE.DataUtils.toHalfFloat(Number.isNaN(v) || v < 0 ? 0 : BIG);
    }
    lum[i] = 0.2126 * half(data[p]) + 0.7152 * half(data[p + 1]) + 0.0722 * half(data[p + 2]);
  }
  // median of the upper sky
  const samples: number[] = [];
  for (let i = 0; i < (W * H) / 2; i += 7) samples.push(lum[i]);
  samples.sort((a, b) => a - b);
  const median = samples[samples.length >> 1] || 1e-4;
  // the sun: weighted centroid of the brightest upper-hemisphere pixels
  let max = 0, maxI = 0;
  for (let i = 0; i < (W * H) / 2; i++) if (lum[i] > max) { max = lum[i]; maxI = i; }
  let sun: THREE.Vector3 | null = null;
  const d = new THREE.Vector3();
  if (max > median * 40) {
    const mr = Math.floor(maxI / W), mc = maxI % W;
    const acc = new THREE.Vector3();
    const win = Math.ceil(H / 24);
    for (let r = Math.max(0, mr - win); r < Math.min(H / 2, mr + win); r++)
      for (let dc = -win; dc <= win; dc++) {
        const c = (mc + dc + W) % W;
        const l = lum[r * W + c];
        if (l > max * 0.3) acc.addScaledVector(dirFromPixel(c, r, W, H, d), l);
      }
    sun = acc.normalize();
  }
  // clamp the sun (and anything as bright) out of the image-based light: the directional light replaces it
  const cap = median * clampMul;
  let skySum = 0, skyN = 0, sum = 0;
  const hz = new THREE.Color(0, 0, 0);
  let hzN = 0;
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let r = 0; r < H; r++) {
    const el = (0.5 - (r + 0.5) / H) * 180;
    const w = Math.cos((el * Math.PI) / 180);
    for (let c = 0; c < W; c++) {
      const i = r * W + c, p = i * 4;
      let l = lum[i];
      if (l > cap || sat !== 1) {
        const s = l > cap ? cap / l : 1;
        const R = half(data[p]) * s, G = half(data[p + 1]) * s, Bc = half(data[p + 2]) * s;
        const L = l * s;
        data[p] = toHalf(L + (R - L) * sat);
        data[p + 1] = toHalf(L + (G - L) * sat);
        data[p + 2] = toHalf(L + (Bc - L) * sat);
        l = L;
      }
      sum += l * w;
      if (el > 0) { skySum += l * w; skyN += w; }
      if (el > 5 && el < 16 && (c & 3) === 0) {
        hz.r += half(data[p]); hz.g += half(data[p + 1]); hz.b += half(data[p + 2]);
        hzN++;
      }
    }
  }
  let totalW = 0;
  for (let r = 0; r < H; r++) totalW += Math.cos(((0.5 - (r + 0.5) / H) * Math.PI)) * W;
  hz.multiplyScalar(1 / Math.max(1, hzN));
  tex.needsUpdate = true;
  return { sun, skyMean: skySum / Math.max(1e-6, skyN), mean: sum / totalW, horizon: hz };
}

// ---------------------------------------------------------------- grading pass

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uSat: { value: 1 },
    uContrast: { value: 1 },
    uVignette: { value: 0.25 },
    uAspect: { value: 1.6 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `uniform sampler2D tDiffuse;
uniform vec3 uGain, uLift;
uniform float uSat, uContrast, uVignette, uAspect;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec3 col = c.rgb;
  col = col * uGain + uLift * (1.0 - col);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);
  // gentle S-curve around mid grey
  col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);
  vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
  col *= 1.0 - uVignette * smoothstep(0.25, 1.1, length(d));
  // a whisper of dither against banding in skies
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(col, c.a);
}`,
};

function vec3Of(hex: string, v: THREE.Vector3) {
  const c = new THREE.Color(hex);
  // colours in the grade are display-referred
  c.convertLinearToSRGB();
  return v.set(c.r, c.g, c.b);
}

// ---------------------------------------------------------------- the lighting rig

const LAMP_POOL = 8;
/** every environment map is a PMREM of this cube size (RoomEnvironment, physical sky, HDRIs) */
const ENV_SIZE = 256;
/** seconds for a time-of-day change */
export const TRANSITION_S = typeof location !== 'undefined' && /[?&]todsec=([\d.]+)/.test(location.search) ? Number(/[?&]todsec=([\d.]+)/.exec(location.search)![1]) : 4;

/**
 * The scene always holds exactly this many lights of each kind (levels' own lights plus dark
 * padding lights), and the 3 cascade lights stay in the scene everywhere, so going between the
 * street, shops, apartments and the museum never changes the shader variants (no recompiles).
 * A level needing more than this logs a warning (and does recompile).
 */
export const LIGHT_BUDGET = { point: 16, spot: 10, pointShadow: 1, spotShadow: 0 };
type LightKind = keyof typeof LIGHT_BUDGET;
/**
 * [museum] places with their own, smaller budget, set once on entering (one recompile there, none
 * between its rooms). The museum: museum/base.ts's rig (4 spots handed to the exhibits nearest the
 * visitor, a fill point and a preview point) plus seamless.ts's 2 preview points and vertical.ts's
 * lift light; no shadow lights,
 * and the sun's cascades are out of the scene (no sun indoors): every lit pixel of its close, full-
 * screen walls pays for 8 lights instead of 30 and samples no shadow maps.
 */
const PLACE_BUDGET: Partial<Record<Place, typeof LIGHT_BUDGET>> = { museum: { point: 5, spot: 4, pointShadow: 0, spotShadow: 0 } };

interface Src {
  name: string;
  h: Hdri;
  /** normalisation so the upper sky has the preset's radiance */
  scale: number;
  sun: THREE.Vector3;
}

const SkyDomeShader = {
  uniforms: {
    tA: { value: null as THREE.Texture | null }, tB: { value: null as THREE.Texture | null }, tC: { value: null as THREE.Texture | null },
    wA: { value: 0 }, wB: { value: 1 }, wC: { value: 0 },
    uFog: { value: new THREE.Color() },
  },
  vertexShader: /* glsl */ `varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`,
  fragmentShader: /* glsl */ `uniform sampler2D tA, tB, tC;
uniform float wA, wB, wC;
uniform vec3 uFog;
varying vec3 vDir;
#include <common>
vec2 eqUv(vec3 d) {
  d = normalize(d);
  return vec2(atan(d.z, d.x) * RECIPROCAL_PI2 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * RECIPROCAL_PI + 0.5);
}
void main() {
  vec2 uv = eqUv(vDir);
  vec3 c = vec3(0.0);
  if (wA > 0.0) c += texture2D(tA, uv).rgb * wA;
  if (wB > 0.0) c += texture2D(tB, uv).rgb * wB;
  if (wC > 0.0) c += texture2D(tC, uv).rgb * wC;
  // the HDRIs were shot at street level in other cities: below ~10 degrees their buildings would
  // show at the end of every avenue, so the low sky melts into the fog colour (Manhattan's haze)
  float el = normalize(vDir).y;
  c = mix(uFog, c, smoothstep(0.02, 0.2, el));
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
};

const EnvBlendShader = {
  uniforms: {
    eA: { value: null as THREE.Texture | null }, eB: { value: null as THREE.Texture | null }, eC: { value: null as THREE.Texture | null },
    wA: { value: 0 }, wB: { value: 1 }, wC: { value: 0 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `uniform sampler2D eA, eB, eC;
uniform float wA, wB, wC;
varying vec2 vUv;
void main() {
  vec4 c = vec4(0.0);
  if (wA > 0.0) c += texture2D(eA, vUv) * wA;
  if (wB > 0.0) c += texture2D(eB, vUv) * wB;
  if (wC > 0.0) c += texture2D(eC, vUv) * wC;
  gl_FragColor = c;
}`,
};

const smooth = (t: number) => t * t * (3 - 2 * t);
/**
 * three r170's CSMShader.lights_fragment_begin (installed globally by new CSM()) still calls
 * getPointShadow() without the shadowIntensity argument added in r169, so any point light that
 * casts shadows (interiors' follow light) fails to compile. Patch the installed chunk.
 */
function fixCsmChunk() {
  const c = THREE.ShaderChunk.lights_fragment_begin;
  const bad = 'getPointShadow( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowBias';
  if (c.includes(bad)) THREE.ShaderChunk.lights_fragment_begin = c.split(bad).join('getPointShadow( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowIntensity, pointLightShadow.shadowBias');
}
function dirOf(azDeg: number, elDeg: number) {
  const el = THREE.MathUtils.degToRad(elDeg), az = THREE.MathUtils.degToRad(azDeg);
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
}

export class Lighting {
  readonly grade = new ShaderPass(GradeShader);
  bloom: UnrealBloomPass | null = null;
  place: Place = 'studio';
  quality: Quality = 'ultra';
  /** for the HUD */
  status = '';
  /** resolves when the current HDRI is in place (the lab waits for it before screenshots) */
  ready: Promise<unknown> = Promise.resolve();

  private csm: CSM | null = null;
  private csmMats = new Set<THREE.Material>();
  private csmUniforms = { breaks: { value: [] as THREE.Vector2[] }, near: { value: 0.05 }, far: { value: 200 } };
  /** the cascades cast the sun's shadow (outdoors, or a level with a sun) */
  private sunOn = false;
  private sky = new Sky();
  private skyScene = new THREE.Scene();
  private skyForEnv = new Sky();
  private skyEnv: THREE.WebGLRenderTarget | null = null;
  private dome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private envRT: THREE.WebGLRenderTarget;
  private blendQuad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private blendCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private envKey = '';
  private env: Env | null = null;
  private sunDir = new THREE.Vector3(0.4, 0.8, 0.3);
  private lamps: THREE.SpotLight[] = [];
  private lampGroup = new THREE.Group();
  private pools: THREE.InstancedMesh;
  private markers: THREE.Object3D[] = [];
  private scanT = 0;
  private lampT = 0;
  private emissives = new Set<THREE.MeshStandardMaterial>();
  private loadToken = 0;
  private frame = 0;
  private csmWraps = 0;
  // [perf] cached scene scan for setupCsmMaterials
  private scanFrame = -1e9;
  private listed = new WeakSet<THREE.Object3D>();
  private scanWrap = true;
  private scanFar: number | null = null;
  private lightList: THREE.Light[] = [];
  private proxyList: THREE.Object3D[] = [];
  // time of day: the light is a blend from -> to over TRANSITION_S, the sky a crossfade srcA -> srcB
  private from: Preset = PRESETS.day;
  private to: Preset = PRESETS.day;
  private cur: Preset = PRESETS.day;
  private t = 1;
  private dur = 0;
  private srcA: Src | null = null;
  private srcB: Src | null = null;
  private srcC: Src | null = null;
  private sunFrom = new THREE.Vector3(0, 1, 0);
  private sunTo = new THREE.Vector3(0, 1, 0);
  private lastNight = -1;
  // fixed light budget
  private pads: Record<LightKind, THREE.Light[]> = { point: [], spot: [], pointShadow: [], spotShadow: [] };
  private padGroup = new THREE.Group();
  private warned = new Set<string>();
  private lightCount: Record<LightKind, number> = { point: 0, spot: 0, pointShadow: 0, spotShadow: 0 };
  // wet-ground planar reflections of the bright things (REFLECT_LAYER) at half resolution
  private reflCam = new THREE.PerspectiveCamera();
  private reflRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private pmrem: THREE.PMREMGenerator,
    /** kept dark: the cascades are the only sun (one shader variant everywhere) */
    sun: THREE.DirectionalLight,
    private hemi: THREE.HemisphereLight,
    private ambient: THREE.AmbientLight,
    private roomEnv: THREE.Texture,
  ) {
    for (const sk of [this.sky, this.skyForEnv]) {
      const u = sk.material.uniforms;
      u.turbidity.value = 5.5;
      u.rayleigh.value = 1.2;
      u.mieCoefficient.value = 0.004;
      u.mieDirectionalG.value = 0.82;
    }
    this.sky.visible = false;
    scene.add(this.sky);
    this.skyForEnv.scale.setScalar(1000);
    this.skyScene.add(this.skyForEnv);
    sun.visible = false;

    // the HDRI sky: a dome drawn first at the far plane (no depth write, so GTAO never sees it)
    const dm = new THREE.ShaderMaterial({ ...SkyDomeShader, uniforms: THREE.UniformsUtils.clone(SkyDomeShader.uniforms), side: THREE.BackSide, depthWrite: false, fog: false });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), dm);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1e6;
    this.dome.visible = false;
    this.dome.name = 'sky-dome';
    this.dome.onBeforeRender = (_r, _s, cam) => {
      this.dome.position.copy(cam.position);
      this.dome.scale.setScalar((cam as THREE.PerspectiveCamera).far * 0.5);
      this.dome.updateMatrixWorld();
    };
    scene.add(this.dome);
    // the blended environment map (same CubeUV layout as a PMREM of ENV_SIZE)
    this.envRT = new THREE.WebGLRenderTarget(3 * Math.max(ENV_SIZE, 16 * 7), 4 * ENV_SIZE, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace, depthBuffer: false,
      generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.envRT.texture.mapping = THREE.CubeUVReflectionMapping;
    this.envRT.texture.name = 'lighting.env';
    const bm = new THREE.ShaderMaterial({ ...EnvBlendShader, uniforms: THREE.UniformsUtils.clone(EnvBlendShader.uniforms), depthTest: false, depthWrite: false, toneMapped: false });
    this.blendQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bm);
    this.blendQuad.frustumCulled = false;

    // street lamps: a small pool of real spot lights near the viewer...
    for (let i = 0; i < LAMP_POOL; i++) {
      const s = new THREE.SpotLight('#ffe7c4', 0, 26, THREE.MathUtils.degToRad(62), 0.75, 1.6);
      s.position.set(0, -100, 0);
      s.target.position.set(0, -110, 0);
      this.lamps.push(s);
      this.lampGroup.add(s, s.target);
    }
    // ...and cheap additive light pools under every lamp further away
    const pt = poolTexture();
    const pm = new THREE.MeshBasicMaterial({ map: pt, color: '#ffd9a8', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const pg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.pools = new THREE.InstancedMesh(pg, pm, 600);
    this.pools.count = 0;
    this.pools.frustumCulled = false;
    this.pools.renderOrder = 2;
    this.lampGroup.add(this.pools);
    this.lampGroup.visible = false;
    scene.add(this.lampGroup);
    this.padGroup.name = 'light-budget-pads';
    scene.add(this.padGroup);
    scene.fog = new THREE.FogExp2('#000000', 0);
    this.grade.uniforms.uAspect.value = innerWidth / innerHeight;
    this.makeCsm();
    rig = this;
    // a lost GL context (out of GPU memory) shows as a black frame: make it visible in debug()
    renderer.domElement.addEventListener?.('webglcontextlost', () => (this.status = 'webgl context lost'));
  }

  /** weather changed: applied on the next update() (cheap, no reloads) */
  applyWeather() {
    if (this.place === 'outdoor') this.applyCurrent();
  }

  get time() {
    return tod;
  }
  /** the light settings in effect right now (mid-transition, with overcast blended in) */
  get preset() {
    return this.cur;
  }

  /** for screenshots / the console: window.__world.lighting.debug() */
  debug() {
    const lights = this.countLights();
    return {
      tod, place: this.place, night: +night.toFixed(3), env: this.envKey, status: this.status, t: +this.t.toFixed(2), csm: this.csm?.cascades ?? 0,
      csmMats: this.csmMats.size, csmWraps: this.csmWraps, frame: this.frame, programs: this.renderer.info.programs?.length ?? 0,
      lamps: this.markers.length, lights, sun: this.sunDir.toArray().map((v) => +v.toFixed(2)),
      envI: +this.scene.environmentIntensity.toFixed(3), exposure: +this.renderer.toneMappingExposure.toFixed(3),
    };
  }

  // ------------------------------------------------------------ public API

  setQuality(q: Quality) {
    const changed = q !== this.quality;
    this.quality = q;
    // real lamp lights near the viewer: each one costs every lit pixel, so fewer on lower settings
    const n = q === 'ultra' ? LAMP_POOL : q === 'high' ? 4 : 2;
    this.lamps.forEach((l, i) => (l.visible = i < n));
    if (changed || !this.csm) {
      this.disposeCsm();
      this.makeCsm();
    }
    if (this.place === 'outdoor') this.retarget(true);
  }

  cycle(dir = 1) {
    const i = TIMES.indexOf(tod);
    this.setTime(TIMES[(i + dir + TIMES.length) % TIMES.length]);
    return PRESETS[tod].label;
  }

  /** change the time of day; smooth over TRANSITION_S unless instant */
  setTime(t: TimeOfDay, instant = false) {
    tod = t;
    if (this.place === 'outdoor') this.retarget(instant);
  }

  /** a new level (or lab scene) */
  apply(env: Env, place: Place) {
    const wasOutdoor = this.place === 'outdoor';
    this.env = env;
    this.place = place;
    if (place === 'outdoor') {
      this.cascadesShown();
      this.lampGroup.visible = true;
      this.hemi.intensity = 0;
      this.ambient.intensity = 0;
      this.camera.far = 900;
      this.camera.updateProjectionMatrix();
      this.csm?.updateFrustums();
      this.sunOn = true;
      if (!wasOutdoor) this.retarget(true);
      return;
    }
    this.loadToken++;
    this.cascadesShown();
    this.lampGroup.visible = false;
    this.sky.visible = false;
    this.dome.visible = false;
    this.setNight(0, 0, 0);
    this.applyBasic(env);
    if (place !== 'studio') this.loadIndoor(place);
  }

  /** call once per frame before rendering, with the point the player/orbit camera is at */
  update(dt: number, focus: THREE.Vector3) {
    if (this.place === 'outdoor') {
      if (this.t < 1) {
        this.t = this.dur > 0 ? Math.min(1, this.t + dt / this.dur) : 1;
        this.applyCurrent();
      }
      this.scanT -= dt;
      if (this.scanT <= 0) {
        this.scanT = 0.5;
        this.scanMarkers();
      }
      this.lampT -= dt;
      if (this.lampT <= 0 && night > 0.05) {
        this.lampT = 0.2;
        this.placeLamps(focus);
      }
    }
    this.reflect();
    if (this.csm) {
      // ?shadows=0 / ?fast=1: no CSM shader patch (a much smaller program per material); one plain sun light
      this.setupCsmMaterials(FLAGS.shadows);
      this.frame++;
      if (this.sunOn) {
        this.camera.updateMatrixWorld();
        this.csm.update();
        // the near cascade re-renders every frame, the middle one on frames 1 mod 4, the far one on
        // frames 3 mod 4: never two wide cascades in one frame (no spikes), 1.5 shadow passes per
        // frame on average (15 Hz for the wide ones at 60 fps; they are texel-snapped, so static
        // shadows don't swim). A skipped cascade keeps its previous map and matching shadow matrix.
        const f = this.frame;
        this.csm.lights.forEach((l, i) => {
          l.shadow.autoUpdate = false;
          if (i === 0 || (i === 1 && f % 4 === 1) || (i === 2 && f % 4 === 3) || f < 2) l.shadow.needsUpdate = true;
        });
      } else for (const l of this.csm.lights) l.shadow.autoUpdate = false;
    }
    this.padLights();
    this.boostEmissives(dt);
  }

  resize() {
    this.grade.uniforms.uAspect.value = innerWidth / innerHeight;
    if (this.csm) this.csm.updateFrustums();
  }

  // ------------------------------------------------------------ wet-ground reflections

  /**
   * Render the emissive things (REFLECT_LAYER) mirrored in the ground plane y = 0 into a half-res
   * target; wetSurface() materials add it, smeared by roughness, where the street is wet. Only
   * outdoors, on ultra/high, when something is wet and there is something bright to reflect.
   */
  private reflect() {
    const on = this.place === 'outdoor' && this.quality !== 'low' && FLAGS.post && U.wet.value > 0.05 && (night > 0.1 || weather.wet > 0.05);
    U.reflOn.value = on ? 1 : 0;
    if (!on) return;
    const r = this.renderer, cam = this.camera;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, Math.round(size.x / 2)), h = Math.max(1, Math.round(size.y / 2));
    if (this.reflRT.width !== w || this.reflRT.height !== h) this.reflRT.setSize(w, h);
    cam.updateMatrixWorld();
    // mirror the camera in the ground plane (position, view direction, up)
    const rc = this.reflCam;
    rc.copy(cam, false);
    const p = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(cam.matrixWorld);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    p.y = -p.y;
    look.y = -look.y;
    up.y = -up.y;
    rc.position.copy(p);
    rc.up.copy(up);
    rc.lookAt(look);
    rc.updateMatrixWorld();
    rc.layers.set(REFLECT_LAYER);
    // texture matrix: world -> reflection uv
    U.reflMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);
    U.reflTex.value = this.reflRT.texture;
    const prevRT = r.getRenderTarget(), prevAuto = r.shadowMap.autoUpdate, prevBg = this.scene.background;
    r.shadowMap.autoUpdate = false;
    this.scene.background = null;
    const clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    r.setClearColor(0x000000, 1);
    r.setRenderTarget(this.reflRT);
    r.clear();
    r.render(this.scene, rc);
    r.setRenderTarget(prevRT);
    r.setClearColor(clear, alpha);
    r.shadowMap.autoUpdate = prevAuto;
    this.scene.background = prevBg;
  }

  // ------------------------------------------------------------ fixed light budget

  private kindOf(l: THREE.Light): LightKind | null {
    if ((l as THREE.PointLight).isPointLight) return l.castShadow ? 'pointShadow' : 'point';
    if ((l as THREE.SpotLight).isSpotLight) return l.castShadow ? 'spotShadow' : 'spot';
    return null;
  }

  private countLights() {
    const n: Record<LightKind, number> = { point: 0, spot: 0, pointShadow: 0, spotShadow: 0 };
    this.scene.traverseVisible((o) => {
      if (!(o as THREE.Light).isLight || o.parent === this.padGroup) return;
      const k = this.kindOf(o as THREE.Light);
      if (k) n[k]++;
    });
    return n;
  }

  /** top every kind of light up to LIGHT_BUDGET with dark padding lights (counts from this frame's scan) */
  private padLights() {
    const n = this.lightCount;
    const budget = PLACE_BUDGET[this.place] ?? LIGHT_BUDGET;
    for (const k of Object.keys(LIGHT_BUDGET) as LightKind[]) {
      const need = budget[k] - n[k];
      if (need < 0 && !this.warned.has(k + n[k])) {
        this.warned.add(k + n[k]);
        console.warn(`lighting: ${n[k]} ${k} lights in the scene, budget ${budget[k]} (shaders will recompile)`);
      }
      const pads = this.pads[k];
      while (pads.length < need) {
        const l = k.startsWith('point') ? new THREE.PointLight('#000000', 0, 0.01) : new THREE.SpotLight('#000000', 0, 0.01);
        l.position.set(0, -1e4, 0);
        if (k.endsWith('Shadow')) {
          l.castShadow = true;
          l.shadow.autoUpdate = false;
          l.shadow.needsUpdate = false;
          l.shadow.mapSize.set(16, 16);
        }
        l.name = `pad-${k}`;
        pads.push(l);
        this.padGroup.add(l);
      }
      pads.forEach((l, i) => (l.visible = i < need));
    }
  }

  // ------------------------------------------------------------ non-outdoor (studio / indoor)

  private applyBasic(env: Env) {
    this.scene.environment = this.roomEnv;
    this.envKey = 'room';
    this.scene.environmentIntensity = env.envIntensity;
    this.scene.background = skyTex(env.skyTop, env.skyBottom, env.stars, hashStr(env.skyTop));
    this.scene.backgroundIntensity = 1;
    // always exponential fog (density 0 = none) so materials keep one variant everywhere
    const fog = this.fog();
    if (env.fog) {
      fog.color.set(env.fog);
      fog.density = Math.sqrt(3) / Math.max(1, env.fogFar);
    } else fog.density = 0;
    this.hemi.color.set(env.hemi.sky);
    this.hemi.groundColor.set(env.hemi.ground);
    this.hemi.intensity = env.hemi.intensity;
    this.ambient.intensity = env.ambient;
    this.renderer.toneMappingExposure = env.exposure;
    this.sunOn = !!env.sun;
    if (env.sun) {
      const el = THREE.MathUtils.degToRad(env.sun.elev), az = THREE.MathUtils.degToRad(env.sun.azim);
      this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
      this.setSun(env.sun.color, env.sun.intensity);
    } else this.setSun('#000000', 0);
    this.camera.far = env.fog ? env.fogFar + 60 : 220;
    this.camera.updateProjectionMatrix();
    this.csm?.updateFrustums();
    this.setBloom({ strength: 0.28, radius: 0.5, threshold: 2.2 });
    this.setGrade({ gain: '#ffffff', lift: '#000000', sat: 1.02, contrast: 1.03, vignette: 0.22 });
  }

  private async loadIndoor(place: Exclude<Place, 'outdoor' | 'studio'>) {
    const spec = INDOOR_HDRI[place];
    const token = ++this.loadToken;
    const pr = this.hdri(spec.hdri, '1k', 1e9, 1, null);
    this.ready = pr;
    const h = await pr;
    if (!h || token !== this.loadToken || !this.env) return;
    if (!(h.mean > 1e-5 && Number.isFinite(h.mean))) return;
    this.scene.environment = h.env;
    this.envKey = spec.hdri;
    // normalise: the HDRI's mean radiance becomes spec.mean, scaled by the level's own envIntensity
    this.scene.environmentIntensity = (spec.mean / Math.max(1e-5, h.mean)) * this.env.envIntensity;
  }

  // ------------------------------------------------------------ outdoor: time of day

  /** HDRI download size: 2k (6 MB) only on ultra; the 1k (1.5 MB) one lights just as well (the PMREM is built at 1k either way) */
  private res() {
    return this.quality === 'ultra' ? '2k' : '1k';
  }

  /** (re)aim at the current time of day: load its HDRI, then blend to it */
  private retarget(instant: boolean) {
    const p = PRESETS[tod];
    const token = ++this.loadToken;
    this.status = `loading ${p.hdri}`;
    const pr = this.source(p);
    this.ready = pr;
    // overcast sky (weather), loaded on demand
    if (weather.overcast > 0 && !this.srcC) this.source(OVERCAST).then((s) => (this.srcC = s));
    pr.then((src) => {
      if (token !== this.loadToken || this.place !== 'outdoor') return;
      this.status = src ? '' : NO_HDRI ? 'no HDRI (notex)' : `HDRI unavailable: ${p.hdri}`;
      // freeze wherever we are now as the start of the blend
      this.from = this.cur;
      this.sunFrom.copy(this.sunDir);
      this.srcA = this.t < 0.5 && this.srcA ? this.srcA : this.srcB;
      this.srcB = src;
      if (!src || !this.srcA || instant) this.srcA = null;
      this.to = p;
      if (src) this.sunTo.copy(src.sun);
      else this.sunTo.copy(dirOf(p.sunAz, p.sunElev));
      this.t = instant ? 1 : 0;
      this.dur = instant ? 0 : TRANSITION_S;
      if (!src) this.physicalSky(this.sunTo);
      this.applyCurrent();
    });
  }

  /** load (cached) the HDRI for a preset and work out its scale and sun */
  private async source(p: Preset): Promise<Src | null> {
    const h = await this.hdri(p.hdri, this.res(), p.clampMul, p.envSat, p.align ? p.sunAz : null);
    if (!h || !(h.skyMean > 1e-5 && Number.isFinite(h.skyMean))) return null;
    const sun = p.align && h.sun ? dirOf(p.sunAz, Math.max(4, THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(h.sun.y, -1, 1))))) : dirOf(p.sunAz, p.sunElev);
    return { name: p.hdri, h, scale: p.sky / h.skyMean, sun };
  }

  /** apply the blended preset, sky and environment for the current transition state */
  private applyCurrent() {
    const e = smooth(this.t);
    const daylight = 1 - THREE.MathUtils.clamp(blendPreset(this.from.night, this.to.night, e) * 1.4, 0, 1);
    const o = this.srcC || NO_HDRI ? THREE.MathUtils.clamp(weather.overcast, 0, 1) * daylight : 0;
    if (weather.overcast > 0 && !this.srcC && !NO_HDRI) this.source(OVERCAST).then((s) => { this.srcC = s; this.applyCurrent(); });
    let p = blendPreset(this.from, this.to, e);
    if (o > 0) p = blendPreset(p, { ...OVERCAST, night: p.night, lit: p.lit, wet: p.wet, exposure: blendPreset(p.exposure, OVERCAST.exposure, 0.7) }, o);
    this.cur = p;
    const w = weather;
    // sun
    this.sunDir.copy(this.sunFrom).lerp(this.sunTo, e).normalize();
    this.setSun(p.sunColor, p.sunIntensity * w.sunMul);
    this.renderer.toneMappingExposure = p.exposure;
    this.hemi.color.set(p.bounce.sky);
    this.hemi.groundColor.set(p.bounce.ground);
    // bounce comes from sunlit walls: it fades with the sun under cloud, but sky light still bounces a little
    this.hemi.intensity = p.bounce.intensity * (0.35 + 0.65 * w.sunMul) * Math.min(1, w.skyMul);
    this.setBloom(p.bloom);
    this.setGrade(p.grade);
    this.setNight(p.night, p.lit, Math.max(p.wet, w.wet));
    // sky + image-based light: crossfade srcA -> srcB, overcast srcC on top
    const A = this.srcA, B = this.srcB, C = o > 0 ? this.srcC : null;
    const wa = A ? (1 - e) * (1 - o) : 0, wb = B ? (A ? e : 1) * (1 - o) : 0, wc = C ? o : 0;
    const fog = this.fog();
    if (B || C) {
      this.sky.visible = false;
      this.dome.visible = true;
      this.scene.background = null;
      const du = this.dome.material.uniforms, eu = this.blendQuad.material.uniforms;
      du.tA.value = A?.h.tex ?? null; du.tB.value = B?.h.tex ?? null; du.tC.value = C?.h.tex ?? null;
      du.wA.value = wa * (A?.scale ?? 0) * w.skyMul; du.wB.value = wb * (B?.scale ?? 0) * w.skyMul; du.wC.value = wc * (C?.scale ?? 0) * w.skyMul;
      eu.eA.value = A?.h.env ?? null; eu.eB.value = B?.h.env ?? null; eu.eC.value = C?.h.env ?? null;
      eu.wA.value = wa * (A?.scale ?? 0); eu.wB.value = wb * (B?.scale ?? 0); eu.wC.value = wc * (C?.scale ?? 0);
      const key = `${A?.name}:${eu.wA.value.toFixed(4)}|${B?.name}:${eu.wB.value.toFixed(4)}|${C?.name}:${eu.wC.value.toFixed(4)}`;
      if (key !== this.envKey) {
        this.envKey = key;
        const prev = this.renderer.getRenderTarget();
        const xr = this.renderer.xr.enabled;
        this.renderer.xr.enabled = false;
        this.renderer.setRenderTarget(this.envRT);
        this.renderer.render(this.blendQuad, this.blendCam);
        this.renderer.setRenderTarget(prev);
        this.renderer.xr.enabled = xr;
      }
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = w.skyMul;
      // atmospheric perspective: fog takes the colour of the HDRIs' own horizon
      const fc = new THREE.Color(0, 0, 0);
      for (const [s, wt] of [[A, wa], [B, wb], [C, wc]] as const) if (s && wt > 0) fc.add(s.h.horizon.clone().multiplyScalar(s.scale * wt));
      fc.lerp(new THREE.Color(p.fogTint).multiplyScalar(p.sky * 1.2), p.fogTintMix);
      fog.color.copy(fc).multiplyScalar(w.skyMul);
    } else {
      // physical sky fallback (no HDRI): already baked by physicalSky()
      this.dome.visible = false;
      this.scene.environmentIntensity = 0.55 * (1 - p.night * 0.95) * w.skyMul;
      fog.color.set(p.fogTint).multiplyScalar(w.skyMul * (1 - 0.9 * p.night));
    }
    fog.density = p.fog * w.fogMul;
    if (w.fogColor && w.fogMix > 0) fog.color.lerp(new THREE.Color(w.fogColor), w.fogMix);
    this.dome.material.uniforms.uFog.value.copy(fog.color);
  }

  private physicalSky(dir: THREE.Vector3) {
    const d = dir.clone();
    d.y = Math.max(d.y, 0.02);
    this.sky.material.uniforms.sunPosition.value.copy(d);
    this.skyForEnv.material.uniforms.sunPosition.value.copy(d);
    this.skyEnv?.dispose();
    this.skyEnv = this.pmrem.fromScene(this.skyScene as unknown as THREE.Scene, 0, 1, 2000);
    this.scene.environment = this.skyEnv.texture;
    this.envKey = 'physical';
    this.scene.background = null;
    this.dome.visible = false;
    this.sky.visible = true;
    this.sky.scale.setScalar(this.camera.far * 0.9);
  }

  private fog() {
    let f = this.scene.fog as THREE.FogExp2 | null;
    if (!f || !(f as THREE.FogExp2).isFogExp2) {
      f = new THREE.FogExp2('#000000', 0);
      this.scene.fog = f;
    }
    return f;
  }

  private hdri(name: string, res: string, clampMul: number, sat: number, alignAz: number | null): Promise<Hdri | null> {
    if (NO_HDRI) return Promise.resolve(null);
    const key = `${name}@${res}`;
    let pr = hdriCache.get(key);
    if (!pr) {
      const url = `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${res}/${name}_${res}.hdr`;
      pr = new RGBELoader()
        .setDataType(THREE.HalfFloatType)
        .loadAsync(url)
        .then((tex) => {
          const a = analyse(tex, clampMul, sat);
          // bake the rotation that puts the HDRI's sun at the light's azimuth into the pixels
          if (alignAz !== null && a.sun) {
            const alpha = THREE.MathUtils.degToRad(alignAz) - Math.atan2(a.sun.x, a.sun.z);
            rotateEquirect(tex, alpha);
            a.sun.applyAxisAngle(new THREE.Vector3(0, 1, 0), alpha);
          }
          tex.mapping = THREE.EquirectangularReflectionMapping;
          tex.colorSpace = THREE.LinearSRGBColorSpace;
          const small = downsampleEquirect(tex, ENV_SIZE * 4);
          const env = this.pmrem.fromEquirectangular(small).texture;
          if (small !== tex) small.dispose();
          return { tex, env, ...a };
        })
        .catch((e) => {
          console.warn('HDRI failed', name, e);
          return null;
        });
      hdriCache.set(key, pr);
    }
    return pr;
  }

  /** [museum] the cascade lights are in every shader except where the place has its own budget (no sun there) */
  private cascadesShown() {
    const off = !!PLACE_BUDGET[this.place];
    this.csm?.lights.forEach((l, i) => (l.visible = !off && (FLAGS.shadows || i === 0)));
  }

  private setSun(color: string, intensity: number) {
    if (!this.csm) return;
    this.csm.lightDirection.copy(this.sunDir).negate();
    for (const l of this.csm.lights) {
      l.color.set(color);
      l.intensity = intensity;
    }
  }

  private setNight(n: number, lit: number, wet: number) {
    night = n;
    U.night.value = n;
    U.lit.value = lit;
    U.wet.value = wet;
    if (n <= 0.05) for (const l of this.lamps) l.intensity = 0;
    (this.pools.material as THREE.MeshBasicMaterial).opacity = 0.7 * n;
    this.pools.visible = n > 0.05;
    if (Math.abs(n - this.lastNight) > 0.002 || (n !== this.lastNight && (n === 0 || n === 1))) {
      this.lastNight = n;
      for (const fn of listeners) fn(tod, n);
    }
  }

  private setBloom(b: { strength: number; radius: number; threshold: number }) {
    if (!this.bloom) return;
    this.bloom.strength = b.strength;
    this.bloom.radius = b.radius;
    this.bloom.threshold = b.threshold;
  }

  private setGrade(g: Preset['grade']) {
    const u = this.grade.uniforms;
    vec3Of(g.gain, u.uGain.value);
    vec3Of(g.lift, u.uLift.value);
    u.uSat.value = g.sat;
    u.uContrast.value = g.contrast;
    u.uVignette.value = g.vignette;
  }

  // ------------------------------------------------------------ cascaded shadows

  private makeCsm() {
    const q = this.quality;
    const csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: q === 'low' ? 2 : 3,
      maxFar: q === 'low' ? 160 : 230,
      mode: 'practical',
      shadowMapSize: q === 'low' ? 1024 : 2048,
      lightDirection: this.sunDir.clone().negate(),
      lightIntensity: 4,
      lightNear: 1,
      lightFar: 900,
      lightMargin: 300,
    });
    csm.fade = q !== 'low';
    // the wider cascades only draw casters big enough to matter at their distance (applyCascadeHook)
    fixCsmChunk();
    csm.lights.forEach((l, i) => {
      l.shadow.bias = -0.00025 * (i + 1);
      l.shadow.normalBias = [0.02, 0.06, 0.15][i] ?? 0.15;
      l.shadow.radius = 2;
      l.intensity = 0;
    });
    this.csm = csm;
    this.cascadesShown();
    activeCsm = csm; // [hlod]
    applyCascadeHook(csm); // [hlod]
    layerAwareShadows(this.renderer, csm); // per-cascade layer masks actually apply
    this.csmMats.clear();
    if (this.place === 'outdoor') this.applyCurrent();
  }

  private disposeCsm() {
    if (!this.csm) return;
    this.csm.remove();
    for (const l of this.csm.lights) l.shadow.map?.dispose();
    for (const m of this.csmMats) {
      if (m.defines) {
        delete m.defines.USE_CSM;
        delete m.defines.CSM_CASCADES;
        delete m.defines.CSM_FADE;
      }
      if (m.userData.csmPrev) m.onBeforeCompile = m.userData.csmPrev;
      delete m.userData.csmHook;
      delete m.userData.csmPrev;
      m.needsUpdate = true;
    }
    this.csmMats.clear();
    this.csm = null;
  }

  /** every lit material must know about the cascades (else each cascade light would light it fully) */
  private setupCsmMaterials(wrap = true) {
    const csm = this.csm!;
    const u = this.csmUniforms;
    csm.getExtendedBreaks(u.breaks.value);
    u.near.value = this.camera.near;
    u.far.value = Math.min(this.camera.far, csm.maxFar);
    const fade = csm.fade;
    // [perf] no per-frame walk of the whole scene: newly added subtrees are visited once (wrap materials, tag
    // casters, list lights and far-proxy casters); each frame re-checks only the listed lights' and proxies'
    // visibility (removed ones no longer reach the scene), so the light count and the LIGHT_BUDGET padding
    // stay exact frame by frame
    const farOnly = cascadeHook.farOnly;
    const visit = (o: THREE.Object3D) => {
      if ((o as THREE.Light).isLight) {
        if (o.parent !== this.padGroup && !this.listed.has(o)) {
          this.listed.add(o);
          this.lightList.push(o as THREE.Light);
        }
        return;
      }
      const mats = (o as THREE.Mesh).material;
      if ((o as THREE.Mesh).isMesh && o.castShadow && o.userData.casterR === undefined) tagCaster(o as THREE.Mesh);
      if (farOnly !== null && o.castShadow && o.layers.isEnabled(farOnly) && !this.listed.has(o)) {
        this.listed.add(o);
        this.proxyList.push(o);
      }
      if (!mats || !wrap) return;
      for (const m of Array.isArray(mats) ? mats : [mats]) {
        if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial && !(m as THREE.MeshLambertMaterial).isMeshLambertMaterial && !(m as THREE.MeshPhongMaterial).isMeshPhongMaterial) continue;
        if (m.userData.csmHook && m.onBeforeCompile === m.userData.csmHook && m.defines?.CSM_CASCADES === csm.cascades) continue;
        // (re)wrap: someone may have replaced onBeforeCompile since
        const prev = m.onBeforeCompile === m.userData.csmHook ? m.userData.csmPrev : m.onBeforeCompile;
        m.defines = m.defines ?? {};
        m.defines.USE_CSM = 1;
        m.defines.CSM_CASCADES = csm.cascades;
        if (fade) m.defines.CSM_FADE = '';
        else delete m.defines.CSM_FADE;
        const hook = function (this: THREE.Material, sh: THREE.WebGLProgramParametersWithUniforms, r: THREE.WebGLRenderer) {
          prev.call(this, sh, r);
          sh.uniforms.CSM_cascades = u.breaks;
          sh.uniforms.cameraNear = u.near;
          sh.uniforms.shadowFar = u.far;
        };
        m.userData.csmPrev = prev;
        m.userData.csmHook = hook;
        m.onBeforeCompile = hook;
        m.needsUpdate = true;
        this.csmMats.add(m);
        this.csmWraps++;
      }

    };
    if (pendingOverflow || this.frame - this.scanFrame >= 120 || this.scanWrap !== wrap || this.scanFar !== farOnly) {
      // full walk: at start, after a wrap/cascade-layer change, and every 120 frames as a safety net (materials
      // swapped on existing meshes are not seen by the add hook)
      pendingOverflow = false;
      pendingAdds = [];
      this.scanFrame = this.frame;
      this.scanWrap = wrap;
      this.scanFar = farOnly;
      this.lightList.length = 0;
      this.proxyList.length = 0;
      this.listed = new WeakSet();
      this.scene.traverse(visit);
    } else if (pendingAdds.length) {
      // lights/proxies removed since keep their list entry until the next full walk; drawn() skips them
      const list = pendingAdds;
      pendingAdds = [];
      for (const r of list) r.traverse(visit);
    }
    const n = this.lightCount;
    n.point = n.spot = n.pointShadow = n.spotShadow = 0;
    for (const l of this.lightList) {
      if (!drawn(l, this.scene)) continue;
      const k = this.kindOf(l);
      if (k) n[k]++;
    }
    const proxies = this.proxyList.some((o) => drawn(o, this.scene));
    if (proxies !== proxiesPresent) {
      proxiesPresent = proxies;
      applyCascadeHook(this.csm);
    }
  }

  // ------------------------------------------------------------ street lights and glowing things

  private scanMarkers() {
    // NYC sidewalks get a lighter version of the wet-road sheen
    if (sidewalkMat && !sidewalkMat.userData.wet) wetSurface(sidewalkMat, 0.55);
    const found: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (o.userData.streetLight) found.push(o);
      // bright things show in wet-ground reflections
      const mm = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if ((o as THREE.Mesh).isMesh && mm && !Array.isArray(mm) && (mm.userData?.litWindows || (mm.emissive && mm.emissiveIntensity > 0 && mm.emissive.getHex() !== 0)) && !o.layers.isEnabled(REFLECT_LAYER)) o.layers.enable(REFLECT_LAYER);
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && !Array.isArray(m) && m.isMeshStandardMaterial && !this.emissives.has(m) && m.emissive && (m.emissiveMap || m.emissive.getHex() === 0xffe2b0)) {
        m.userData.baseEI ??= m.emissiveIntensity;
        this.emissives.add(m);
      }
    });
    this.markers = found;
    const v = new THREE.Vector3();
    const mtx = new THREE.Matrix4();
    let n = 0;
    for (const mk of found) {
      if (n >= this.pools.instanceMatrix.count) break;
      mk.getWorldPosition(v);
      mtx.makeScale(11, 1, 11).setPosition(v.x, 0.02, v.z);
      this.pools.setMatrixAt(n++, mtx);
    }
    this.pools.count = n;
    this.pools.instanceMatrix.needsUpdate = true;
  }

  private placeLamps(focus: THREE.Vector3) {
    const v = new THREE.Vector3();
    const list = this.markers.map((m) => {
      m.getWorldPosition(v);
      return { p: v.clone(), d: v.distanceToSquared(focus) };
    });
    list.sort((a, b) => a.d - b.d);
    const I = 70 * night;
    const n = this.lamps.filter((l) => l.visible).length;
    this.lamps.forEach((l, i) => {
      const it = list[i];
      if (!it) {
        l.intensity = 0;
        return;
      }
      l.position.copy(it.p);
      l.target.position.set(it.p.x, 0, it.p.z);
      // fade the furthest pooled light so swapping lamps doesn't pop
      const fade = i < n - 1 ? 1 : 0.5;
      l.intensity = I * fade;
    });
  }

  private boostEmissives(_dt: number) {
    for (const m of this.emissives) {
      const base = m.userData.baseEI as number;
      const lamp = m.emissive.getHex() === 0xffe2b0;
      m.emissiveIntensity = base * (1 + night * (lamp ? 4 : 1.2));
    }
  }
}

function poolTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,0.55)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  gr.addColorStop(0.7, 'rgba(255,255,255,0.07)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
