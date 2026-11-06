import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Env } from './level';
import { skyTex } from './textures';
import { hashStr } from './rng';

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

interface Preset {
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
  exposure: number;
  /** exponential fog density (1/m), tinted from the HDRI horizon */
  fog: number;
  fogTint?: string;
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
    sky: 0.6, clampMul: 12, exposure: 0.62, fog: 0.0012, night: 0, lit: 0.04, wet: 0,
    bloom: { strength: 0.12, radius: 0.4, threshold: 3.0 },
    grade: { gain: '#fffaf4', lift: '#04060a', sat: 1.04, contrast: 1.04, vignette: 0.22 },
  },
  golden: {
    label: 'Golden hour', hdri: 'venice_sunset', align: true, sunAz: 250, sunElev: 8, sunColor: '#ffb067', sunIntensity: 5.5,
    sky: 0.55, clampMul: 10, exposure: 0.8, fog: 0.0022, night: 0.15, lit: 0.12, wet: 0,
    bloom: { strength: 0.2, radius: 0.5, threshold: 2.2 },
    grade: { gain: '#fff1e0', lift: '#060812', sat: 1.08, contrast: 1.06, vignette: 0.28 },
  },
  dusk: {
    label: 'Dusk (blue hour)', hdri: 'sunset_jhbcentral', align: true, sunAz: 250, sunElev: 5, sunColor: '#8fa2d8', sunIntensity: 0.45,
    sky: 0.12, clampMul: 30, exposure: 1.3, fog: 0.002, fogTint: '#6f7fa8', night: 0.75, lit: 0.42, wet: 0.35,
    bloom: { strength: 0.45, radius: 0.55, threshold: 1.0 },
    grade: { gain: '#f6f6ff', lift: '#06081a', sat: 1.08, contrast: 1.05, vignette: 0.32 },
  },
  night: {
    label: 'Night', hdri: 'shanghai_bund', align: false, sunAz: 140, sunElev: 50, sunColor: '#8ea4d6', sunIntensity: 0.12,
    sky: 0.04, clampMul: 400, exposure: 1.35, fog: 0.0022, fogTint: '#2a2a3a', night: 1, lit: 0.36, wet: 0.8,
    bloom: { strength: 0.5, radius: 0.5, threshold: 0.8 },
    grade: { gain: '#fbfaff', lift: '#050712', sat: 1.12, contrast: 1.08, vignette: 0.38 },
  },
};

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
};
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
  vec3 warm = mix(vec3(1.0, 0.55, 0.22), vec3(1.0, 0.78, 0.5), vWinLit.y);
  vec3 tint = vWinLit.z > 0.88 ? vec3(0.45, 0.6, 1.0) : warm;
  float grad = 0.55 + 0.45 * smoothstep(0.0, 1.0, vWinUv.y);
  float blind = vWinLit.z < 0.25 ? 0.55 : 1.0;
  totalEmissiveRadiance += tint * on * grad * blind * (0.35 + 0.8 * vWinLit.y);
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
    sh.vertexShader = 'varying vec3 vWetPos;\n' + sh.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
vWetPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
    );
    sh.fragmentShader = `uniform float uWet;\nuniform float uWetK;\nvarying vec3 vWetPos;
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
normal = normalize(mix(normal, normalize(vNormal), wetAmt * puddle));`);
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => key() + '|wet';
  m.needsUpdate = true;
  return m;
}

// ---------------------------------------------------------------- HDRI loading

interface Hdri {
  tex: THREE.DataTexture;
  env: THREE.Texture;
  /** sun direction in the texture's own frame, or null */
  sun: THREE.Vector3 | null;
  /** mean upper-sky radiance after clamping */
  skyMean: number;
  mean: number;
  horizon: THREE.Color;
}

const hdriCache = new Map<string, Promise<Hdri | null>>();

function dirFromPixel(c: number, r: number, W: number, H: number, out: THREE.Vector3) {
  const a = ((c + 0.5) / W - 0.5) * Math.PI * 2;
  const el = (0.5 - (r + 0.5) / H) * Math.PI;
  return out.set(Math.cos(el) * Math.cos(a), Math.sin(el), Math.cos(el) * Math.sin(a));
}

function analyse(tex: THREE.DataTexture, clampMul: number): Omit<Hdri, 'tex' | 'env'> {
  const img = tex.image as unknown as { data: Uint16Array; width: number; height: number };
  const { data, width: W, height: H } = img;
  const half = THREE.DataUtils.fromHalfFloat;
  const lum = new Float32Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) lum[i] = 0.2126 * half(data[p]) + 0.7152 * half(data[p + 1]) + 0.0722 * half(data[p + 2]);
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
      if (l > cap) {
        const s = cap / l;
        data[p] = toHalf(half(data[p]) * s);
        data[p + 1] = toHalf(half(data[p + 1]) * s);
        data[p + 2] = toHalf(half(data[p + 2]) * s);
        l = cap;
      }
      sum += l * w;
      if (el > 0) { skySum += l * w; skyN += w; }
      if (el > 1 && el < 10 && (c & 3) === 0) {
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
  private sky = new Sky();
  private skyScene = new THREE.Scene();
  private skyForEnv = new Sky();
  private skyEnv: THREE.WebGLRenderTarget | null = null;
  private hdriKey = '';
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

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private pmrem: THREE.PMREMGenerator,
    /** the plain directional light used for non-outdoor scenes */
    private sun: THREE.DirectionalLight,
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
    this.grade.uniforms.uAspect.value = innerWidth / innerHeight;
  }

  get time() {
    return tod;
  }

  /** for screenshots / the console: window.__world.lighting.debug() */
  debug() {
    return {
      tod, place: this.place, night, hdri: this.hdriKey, status: this.status, csm: this.csm?.cascades ?? 0,
      csmMats: this.csmMats.size, lamps: this.markers.length, emissives: this.emissives.size,
      sun: this.sunDir.toArray().map((v) => +v.toFixed(2)), envI: +this.scene.environmentIntensity.toFixed(3),
      rot: +this.scene.environmentRotation.y.toFixed(2), exposure: this.renderer.toneMappingExposure,
    };
  }

  // ------------------------------------------------------------ public API

  setQuality(q: Quality) {
    this.quality = q;
    // real lamp lights near the viewer: each one costs every lit pixel, so fewer on lower settings
    const n = q === 'ultra' ? LAMP_POOL : q === 'high' ? 4 : 2;
    this.lamps.forEach((l, i) => (l.visible = i < n));
    if (this.csm) {
      this.disposeCsm();
      this.makeCsm();
    }
    if (this.place === 'outdoor') this.loadOutdoor();
  }

  cycle(dir = 1) {
    const i = TIMES.indexOf(tod);
    this.setTime(TIMES[(i + dir + TIMES.length) % TIMES.length]);
    return PRESETS[tod].label;
  }

  setTime(t: TimeOfDay) {
    tod = t;
    if (this.place === 'outdoor') this.applyOutdoor();
  }

  /** a new level (or lab scene) */
  apply(env: Env, place: Place) {
    this.env = env;
    this.place = place;
    this.scene.backgroundRotation.set(0, 0, 0);
    this.scene.environmentRotation.set(0, 0, 0);
    this.scene.backgroundIntensity = 1;
    if (place === 'outdoor') {
      this.applyOutdoor();
      return;
    }
    this.disposeCsm();
    this.lampGroup.visible = false;
    this.sky.visible = false;
    this.setNight(0, 0, 0);
    this.applyBasic(env);
    if (place !== 'studio') this.loadIndoor(place);
  }

  /** call once per frame before rendering, with the point the player/orbit camera is at */
  update(dt: number, focus: THREE.Vector3) {
    if (this.place === 'outdoor') {
      this.scanT -= dt;
      if (this.scanT <= 0) {
        this.scanT = 0.5;
        this.scanMarkers();
      }
      if (this.csm) {
        this.setupCsmMaterials();
        this.camera.updateMatrixWorld();
        this.csm.update();
      }
      this.lampT -= dt;
      if (this.lampT <= 0 && night > 0.05) {
        this.lampT = 0.2;
        this.placeLamps(focus);
      }
    } else if (this.sun.visible) {
      this.sun.position.copy(focus).addScaledVector(this.sunDir, 150);
      this.sun.target.position.copy(focus);
    }
    this.boostEmissives(dt);
  }

  resize() {
    this.grade.uniforms.uAspect.value = innerWidth / innerHeight;
    if (this.csm) this.csm.updateFrustums();
  }

  // ------------------------------------------------------------ non-outdoor (studio / indoor)

  private applyBasic(env: Env) {
    this.scene.environment = this.roomEnv;
    this.scene.background = skyTex(env.skyTop, env.skyBottom, env.stars, hashStr(env.skyTop));
    this.scene.fog = env.fog ? new THREE.Fog(env.fog, env.fogNear, env.fogFar) : null;
    this.hemi.color.set(env.hemi.sky);
    this.hemi.groundColor.set(env.hemi.ground);
    this.hemi.intensity = env.hemi.intensity;
    this.ambient.intensity = env.ambient;
    this.scene.environmentIntensity = env.envIntensity;
    this.renderer.toneMappingExposure = env.exposure;
    if (env.sun) {
      this.sun.visible = true;
      this.sun.color.set(env.sun.color);
      this.sun.intensity = env.sun.intensity;
      const el = THREE.MathUtils.degToRad(env.sun.elev), az = THREE.MathUtils.degToRad(env.sun.azim);
      this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    } else this.sun.visible = false;
    this.camera.far = env.fog ? env.fogFar + 60 : 220;
    this.camera.updateProjectionMatrix();
    this.setBloom({ strength: 0.28, radius: 0.5, threshold: 2.2 });
    this.setGrade({ gain: '#ffffff', lift: '#000000', sat: 1.02, contrast: 1.03, vignette: 0.22 });
  }

  private async loadIndoor(place: Exclude<Place, 'outdoor' | 'studio'>) {
    const spec = INDOOR_HDRI[place];
    const token = ++this.loadToken;
    const pr = this.hdri(spec.hdri, '1k', 1e9);
    this.ready = pr;
    const h = await pr;
    if (!h || token !== this.loadToken || !this.env) return;
    this.scene.environment = h.env;
    // normalise: the HDRI's mean radiance becomes spec.mean, scaled by the level's own envIntensity
    this.scene.environmentIntensity = (spec.mean / Math.max(1e-5, h.mean)) * this.env.envIntensity;
  }

  // ------------------------------------------------------------ outdoor

  private applyOutdoor() {
    const p = PRESETS[tod];
    this.sun.visible = false;
    this.hemi.intensity = 0;
    this.ambient.intensity = 0;
    if (!this.csm) this.makeCsm();
    this.lampGroup.visible = true;
    this.setNight(p.night, p.lit, p.wet);
    this.renderer.toneMappingExposure = p.exposure;
    this.camera.far = 900;
    this.camera.updateProjectionMatrix();
    this.csm?.updateFrustums();
    this.setBloom(p.bloom);
    this.setGrade(p.grade);
    // until the HDRI arrives: the physical sky
    if (!this.hdriKey.startsWith(p.hdri)) {
      this.setSunDir(p.sunAz, p.sunElev);
      this.physicalSky();
      this.scene.fog = new THREE.FogExp2(new THREE.Color(p.fogTint ?? '#aab6c2'), p.fog);
    }
    this.setSunLight(p);
    this.loadOutdoor();
  }

  private physicalSky() {
    const p = PRESETS[tod];
    const d = this.sunDir.clone();
    if (p.align === false) d.y = Math.max(d.y, 0.02);
    this.sky.material.uniforms.sunPosition.value.copy(d);
    this.skyForEnv.material.uniforms.sunPosition.value.copy(d);
    this.skyEnv?.dispose();
    this.skyEnv = this.pmrem.fromScene(this.skyScene as unknown as THREE.Scene, 0, 1, 2000);
    this.scene.environment = this.skyEnv.texture;
    this.scene.environmentIntensity = 0.55 * (1 - night * 0.95);
    this.scene.background = null;
    this.sky.visible = true;
    this.sky.scale.setScalar(this.camera.far * 0.9);
  }

  private async loadOutdoor() {
    const p = PRESETS[tod];
    const res = this.quality === 'low' ? '1k' : '2k';
    const key = `${p.hdri}@${res}`;
    const token = ++this.loadToken;
    this.status = `loading ${p.hdri}`;
    const pr = this.hdri(p.hdri, res, p.clampMul);
    this.ready = pr;
    const h = await pr;
    if (!h || token !== this.loadToken || this.place !== 'outdoor') return;
    this.status = '';
    this.hdriKey = key;
    const scale = p.sky / Math.max(1e-6, h.skyMean);
    // rotate the HDRI so its sun sits where the light comes from (keeps the street grid's shadows)
    let rot = 0;
    if (p.align && h.sun) {
      const want = THREE.MathUtils.degToRad(p.sunAz);
      const have = Math.atan2(h.sun.x, h.sun.z);
      rot = want - have;
      const el = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(h.sun.y, -1, 1)));
      this.setSunDir(p.sunAz, Math.max(4, el));
    } else this.setSunDir(p.sunAz, p.sunElev);
    this.setSunLight(p);
    this.scene.environmentRotation.set(0, rot, 0);
    this.scene.backgroundRotation.set(0, rot, 0);
    this.scene.environment = h.env;
    this.scene.environmentIntensity = scale;
    this.scene.background = h.tex;
    this.scene.backgroundIntensity = scale;
    this.sky.visible = false;
    // atmospheric perspective: fog takes the colour of the HDRI's own horizon
    const fc = h.horizon.clone().multiplyScalar(scale);
    if (p.fogTint) fc.lerp(new THREE.Color(p.fogTint).multiplyScalar(p.sky * 1.2), 0.8);
    this.scene.fog = new THREE.FogExp2(fc, p.fog);
  }

  private hdri(name: string, res: string, clampMul: number) {
    const key = `${name}@${res}`;
    let pr = hdriCache.get(key);
    if (!pr) {
      const url = `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${res}/${name}_${res}.hdr`;
      pr = new RGBELoader()
        .setDataType(THREE.HalfFloatType)
        .loadAsync(url)
        .then((tex) => {
          const a = analyse(tex, clampMul);
          tex.mapping = THREE.EquirectangularReflectionMapping;
          tex.colorSpace = THREE.LinearSRGBColorSpace;
          const env = this.pmrem.fromEquirectangular(tex).texture;
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

  private setSunDir(azDeg: number, elDeg: number) {
    const el = THREE.MathUtils.degToRad(elDeg), az = THREE.MathUtils.degToRad(azDeg);
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  }

  private setSunLight(p: Preset) {
    if (!this.csm) return;
    this.csm.lightDirection.copy(this.sunDir).negate();
    for (const l of this.csm.lights) {
      l.color.set(p.sunColor);
      l.intensity = p.sunIntensity;
    }
  }

  private setNight(n: number, lit: number, wet: number) {
    night = n;
    U.night.value = n;
    U.lit.value = lit;
    U.wet.value = wet;
    for (const l of this.lamps) l.intensity = 0;
    (this.pools.material as THREE.MeshBasicMaterial).opacity = 0.7 * n;
    this.pools.visible = n > 0.05;
    for (const fn of listeners) fn(tod, n);
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
      maxFar: q === 'low' ? 160 : 260,
      mode: 'practical',
      shadowMapSize: q === 'low' ? 1024 : 2048,
      lightDirection: this.sunDir.clone().negate(),
      lightIntensity: 4,
      lightNear: 1,
      lightFar: 900,
      lightMargin: 300,
    });
    csm.fade = q !== 'low';
    csm.lights.forEach((l, i) => {
      l.shadow.bias = -0.00025 * (i + 1);
      l.shadow.normalBias = [0.02, 0.06, 0.15][i] ?? 0.15;
      l.shadow.radius = 2;
    });
    this.csm = csm;
    this.csmMats.clear();
    this.setSunLight(PRESETS[tod]);
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
  private setupCsmMaterials() {
    const csm = this.csm!;
    const u = this.csmUniforms;
    csm.getExtendedBreaks(u.breaks.value);
    u.near.value = this.camera.near;
    u.far.value = Math.min(this.camera.far, csm.maxFar);
    const fade = csm.fade;
    // only what will be drawn this frame needs it (hidden things are wrapped when they show up)
    this.scene.traverseVisible((o) => {
      const mats = (o as THREE.Mesh).material;
      if (!mats) return;
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
      }
    });
  }

  // ------------------------------------------------------------ street lights and glowing things

  private scanMarkers() {
    const found: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (o.userData.streetLight) found.push(o);
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
      m.emissiveIntensity = base * (1 + night * (lamp ? 9 : 1.2));
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
