import * as THREE from 'three';
import { groundWeather } from './nyc/ground';
import { setPeopleWeather } from './nyc/people';
import { getNight, getTimeOfDay, setWeather as setLightingWeather, type Lighting, type Quality } from './lighting';

/**
 * Dynamic weather: a cloud dome over the HDRI sky, clear / partly cloudy / overcast / light rain /
 * rain / fog / snow with slow transitions, GPU rain and snow around the camera, splashes, wet and
 * snow-covered surfaces, height fog and low cloud that swallows the tops of towers.
 * See docs/research/weather.md for the references and the design.
 *
 * Global hooks (no per-material work needed by other modules):
 *  - every MeshStandardMaterial / MeshPhysicalMaterial gets wetness (darker, glossier), rain
 *    ripples on up-facing wet ground and a snow cover on up-facing surfaces, through a patch of
 *    three's shared shader chunks + shared uniforms (`weatherUniforms`). Driven by uniforms only:
 *    changing the weather never compiles a shader. Opt a material out with noWeather(m).
 *  - everything with fog gets height fog and a low cloud layer (patched fog chunk).
 *  - wetness and snow only reach surfaces open to the sky: a top-down depth map around the
 *    camera ("sky exposure", re-rendered every few seconds) keeps rooms, arcades and the
 *    pavement under awnings dry. Rain and splashes use the same map.
 *
 * Read the state with getWeather() / onWeatherChange() (people: umbrellas and hoods).
 */

// ---------------------------------------------------------------- states

export type WeatherState = 'clear' | 'partly' | 'overcast' | 'lightrain' | 'rain' | 'fog' | 'snow';
export const WEATHER_STATES: WeatherState[] = ['clear', 'partly', 'overcast', 'lightrain', 'rain', 'fog', 'snow'];
export const WEATHER_LABEL: Record<WeatherState, string> = {
  clear: 'Clear', partly: 'Partly cloudy', overcast: 'Overcast', lightrain: 'Light rain', rain: 'Heavy rain', fog: 'Fog / low cloud', snow: 'Snow',
};

interface Params {
  /** cloud cover 0..1 */
  cloud: number;
  /** how thick / dark the cloud deck is (rain clouds) */
  dark: number;
  /** rain intensity 0..1 (1 = downpour) */
  rain: number;
  /** snowfall intensity 0..1 */
  snow: number;
  /** ground fog density (1/m) at street level, falling off with height */
  ground: number;
  /** multiplier on the time-of-day haze (exp2 fog) */
  haze: number;
  /** cloud base height (m): above it the fog is the cloud itself */
  base: number;
  /** density inside the low cloud (1/m) */
  inCloud: number;
  /** the sky is replaced by fog colour (0..1) */
  fogSky: number;
  /** wind at street level (m/s), drives rain slant and cloud drift */
  wind: number;
}

// clear: no procedural deck (the sky HDRI has its own clouds; a thin deck broke up into small grey
// flecks that read as debris flying in the sky; cdens() fades the deck in with cover)
const P: Record<WeatherState, Params> = {
  clear: { cloud: 0, dark: 0, rain: 0, snow: 0, ground: 0, haze: 1, base: 1200, inCloud: 0, fogSky: 0, wind: 2 },
  partly: { cloud: 0.48, dark: 0.1, rain: 0, snow: 0, ground: 0, haze: 1.1, base: 1200, inCloud: 0, fogSky: 0, wind: 3 },
  overcast: { cloud: 0.97, dark: 0.3, rain: 0, snow: 0, ground: 0.0004, haze: 1.6, base: 420, inCloud: 0.012, fogSky: 0.1, wind: 3 },
  lightrain: { cloud: 1, dark: 0.55, rain: 0.3, snow: 0, ground: 0.001, haze: 2.2, base: 260, inCloud: 0.02, fogSky: 0.25, wind: 3 },
  rain: { cloud: 1, dark: 0.85, rain: 1, snow: 0, ground: 0.0025, haze: 3, base: 170, inCloud: 0.03, fogSky: 0.45, wind: 5 },
  fog: { cloud: 1, dark: 0.25, rain: 0, snow: 0, ground: 0.011, haze: 2.5, base: 75, inCloud: 0.07, fogSky: 1, wind: 1 },
  snow: { cloud: 1, dark: 0.45, rain: 0, snow: 1, ground: 0.009, haze: 3.5, base: 220, inCloud: 0.028, fogSky: 0.6, wind: 2 },
};

/** random walk: where each state tends to go next (weights) and how long it lasts (minutes) */
const NEXT: Record<WeatherState, [WeatherState, number][]> = {
  clear: [['partly', 3], ['overcast', 1], ['fog', 0.3]],
  partly: [['clear', 2], ['overcast', 2], ['lightrain', 0.6]],
  overcast: [['partly', 1.5], ['lightrain', 2], ['snow', 0.6], ['fog', 0.6], ['clear', 0.3]],
  lightrain: [['rain', 1.5], ['overcast', 2], ['fog', 0.4]],
  rain: [['lightrain', 2], ['overcast', 1]],
  fog: [['overcast', 2], ['partly', 1], ['lightrain', 0.5]],
  snow: [['overcast', 2], ['lightrain', 0.3]],
};
const DWELL: Record<WeatherState, [number, number]> = {
  clear: [4, 9], partly: [3, 7], overcast: [3, 6], lightrain: [2, 5], rain: [1.5, 3.5], fog: [2, 5], snow: [3, 7],
};

export interface WeatherInfo {
  /** the state being moved towards (and, once the transition ends, the current one) */
  state: WeatherState;
  label: string;
  /** 0..1 progress of the transition into `state` */
  progress: number;
  cloud: number;
  /** current rain / snowfall intensity 0..1 */
  rain: number;
  snow: number;
  /** water on the ground 0..1 (lags the rain, dries slowly) */
  wetness: number;
  /** snow lying on up-facing surfaces 0..1 */
  snowCover: number;
  /** ground fog density (1/m) */
  fog: number;
  wind: number;
  /** suggestions for the people agent */
  umbrellas: number;
  hoods: number;
}

const info: WeatherInfo = {
  state: 'clear', label: WEATHER_LABEL.clear, progress: 1, cloud: 0, rain: 0, snow: 0, wetness: 0, snowCover: 0, fog: 0, wind: 2, umbrellas: 0, hoods: 0,
};
const listeners: ((w: WeatherInfo) => void)[] = [];
/** the live weather (read it every frame, it is updated in place) */
export function getWeather(): Readonly<WeatherInfo> {
  return info;
}
/** called when the target state changes (start of a transition) */
export function onWeatherChange(fn: (w: WeatherInfo) => void) {
  listeners.push(fn);
}

// ---------------------------------------------------------------- shared uniforms + shader chunk patches
// Values are plain objects, not THREE.Vector4 / Matrix4: three clones uniform values per material,
// but leaves plain objects (and the textures inside arrays) shared, so one write reaches every
// material without touching them.

const WX = { x: 0, y: 0, z: 0, w: 0 }; // wetness, snow cover, rain rate, on
const WX2 = { x: 0.0005, y: 0, z: 0, w: 0 }; // exposure bias (depth units), exposure map valid, time, -
const OCC_MAT = { elements: new Float32Array(16) };
const FOG_A = { x: 0, y: 1 / 60, z: 0, w: 0 }; // ground fog density, falloff (1/m), ground height
const FOG_B = { x: 1000, y: 0, z: 60, w: 0 }; // cloud base, density in cloud, ramp height
const VIEW = { x: 0, y: 0, z: 0, w: 0 }; // window views in interiors: cover, rain, snow, fog

let occRes = 1024;
const occRT = new THREE.WebGLRenderTarget(occRes, occRes, { depthBuffer: true, depthTexture: new THREE.DepthTexture(occRes, occRes) });
occRT.depthTexture!.type = THREE.UnsignedIntType;

/** shared weather uniforms (add them to a custom ShaderMaterial to use the chunks below) */
export const weatherUniforms = {
  wxState: { value: WX },
  wxState2: { value: WX2 },
  wxOccMat: { value: OCC_MAT },
  wxOcc: { value: [occRT.depthTexture] },
  wxFogA: { value: FOG_A },
  wxFogB: { value: FOG_B },
};

/** keep weather (wet / snow) off a material, e.g. glass, screens, water. Call before first render. */
export function noWeather(m: THREE.Material) {
  m.defines = { ...(m.defines ?? {}), WX_OFF: '' };
  m.needsUpdate = true;
  return m;
}

const SURF_PARS = /* glsl */ `
#ifndef WX_OFF
uniform vec4 wxState;
uniform vec4 wxState2;
uniform mat4 wxOccMat;
uniform sampler2D wxOcc[1];
float wxHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wxNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wxHash(i), wxHash(i + vec2(1, 0)), u.x), mix(wxHash(i + vec2(0, 1)), wxHash(i + vec2(1, 1)), u.x), u.y);
}
// 1 = open to the sky, 0 = under a roof / awning / inside (top-down depth map around the camera)
float wxExposure(vec3 p) {
  if (wxState2.y < 0.5) return 1.0;
  vec4 c = wxOccMat * vec4(p, 1.0);
  vec2 uv = c.xy * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  float d = texture2D(wxOcc[0], uv).x;
  float z = c.z * 0.5 + 0.5;
  return 1.0 - smoothstep(d + wxState2.x, d + 3.0 * wxState2.x, z);
}
// expanding rain rings, two staggered layers of one ring per cell
vec2 wxRipple(vec2 p, float t) {
  vec2 g = vec2(0.0);
  for (int k = 0; k < 2; k++) {
    vec2 q = p + float(k) * vec2(0.37, 0.71);
    vec2 i = floor(q), f = fract(q);
    float h = wxHash(i + float(k) * 17.0);
    vec2 c = vec2(wxHash(i + 3.1), wxHash(i + 7.7)) * 0.5 + 0.25;
    float ph = fract(t * 1.3 + h);
    vec2 d = f - c;
    float r = length(d);
    float x = r - ph * 0.42;
    g += d / max(r, 1e-3) * sin(x * 50.0) * exp(-x * x * 500.0) * (1.0 - ph);
  }
  return g;
}
#endif
`;

const SURF = /* glsl */ `
#if !defined(WX_OFF) && !defined(USE_SKINNING)
if (wxState.w > 0.5) {
  vec3 wxP = cameraPosition - (vec4(vViewPosition, 0.0) * viewMatrix).xyz;
  vec3 wxNg = normalize((vec4(nonPerturbedNormal, 0.0) * viewMatrix).xyz);
  float wxUp = smoothstep(0.35, 0.9, wxNg.y);
  // sample a little out along the normal: walls see the street in front of them, room walls see the ceiling
  float wxE = wxExposure(wxP + wxNg * vec3(0.45, 0.08, 0.45));
  #ifndef WX_NOWET
  float wxW = wxState.x * wxE * mix(0.45, 1.0, wxUp);
  float wxPor = clamp(roughnessFactor, 0.0, 1.0) * (1.0 - metalnessFactor);
  diffuseColor.rgb *= 1.0 - wxW * (0.1 + 0.4 * wxPor);
  roughnessFactor = mix(roughnessFactor, max(0.06, roughnessFactor * 0.28), wxW * mix(0.55, 1.0, wxUp));
  #endif
  float wxDist = length(vViewPosition);
  if (wxState.z > 0.01 && wxUp > 0.3 && wxDist < 30.0) {
    float k = wxState.z * wxE * wxUp * min(1.0, wxState.x * 1.5) * (1.0 - smoothstep(10.0, 30.0, wxDist));
    vec2 rp = wxRipple(wxP.xz * 3.0, wxState2.z) * k * 0.6;
    normal = normalize(normal + (viewMatrix * vec4(rp.x, 0.0, rp.y, 0.0)).xyz);
  }
  float wxS = wxState.y;
  #ifdef WX_NOSNOW
  wxS = 0.0;
  #endif
  if (wxS > 0.001) {
    float n = wxNoise(wxP.xz * 0.9) * 0.6 + wxNoise(wxP.xz * 4.3) * 0.3 + wxNoise(wxP.xz * 17.0) * 0.1;
    float slope = smoothstep(0.78 - 0.3 * wxS, 0.97 - 0.22 * wxS, wxNg.y);
    float m = slope * wxE * smoothstep(n - 0.08, n + 0.08, wxS * 1.2 - 0.05);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.87, 0.9), m);
    roughnessFactor = mix(roughnessFactor, 0.6, m);
    metalnessFactor = mix(metalnessFactor, 0.0, m);
    normal = normalize(mix(normal, (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz, m * 0.5));
    totalEmissiveRadiance *= 1.0 - m;
  }
}
#endif
`;

const FOG_PARS_V = /* glsl */ `
#ifdef USE_FOG
varying vec3 vWxFogW;
#endif
`;
const FOG_V = /* glsl */ `
#ifdef USE_FOG
vWxFogW = cameraPosition + (vec4(mvPosition.xyz, 0.0) * viewMatrix).xyz;
#endif
`;
const FOG_PARS_F = /* glsl */ `
#ifdef USE_FOG
varying vec3 vWxFogW;
uniform vec4 wxFogA;
uniform vec4 wxFogB;
// integral of the cloud-layer density ramp clamp((y - base) / ramp, 0, 1) from -inf to y
float wxRampInt(float y) {
  float t = y - wxFogB.x;
  float r = max(wxFogB.z, 1.0);
  return t <= 0.0 ? 0.0 : t < r ? t * t / (2.0 * r) : r * 0.5 + (t - r);
}
#endif
`;
const FOG_F = /* glsl */ `
#ifdef USE_FOG
{
  vec3 wxRd = vWxFogW - cameraPosition;
  float wxL = length(wxRd);
  float wxOd = 0.0;
  if (wxFogA.x > 0.0) {
    float b = wxFogA.y;
    float k = b * wxRd.y;
    float f = abs(k) > 1e-3 ? (1.0 - exp(-k)) / k : 1.0;
    wxOd += wxFogA.x * exp(-b * (cameraPosition.y - wxFogA.z)) * wxL * f;
  }
  if (wxFogB.y > 0.0) {
    float hi = max(cameraPosition.y, vWxFogW.y), lo = min(cameraPosition.y, vWxFogW.y);
    float span = hi - lo;
    float avg = span > 0.05 ? (wxRampInt(hi) - wxRampInt(lo)) / span : clamp((hi - wxFogB.x) / max(wxFogB.z, 1.0), 0.0, 1.0);
    wxOd += wxFogB.y * wxL * avg;
  }
  fogFactor = 1.0 - (1.0 - fogFactor) * exp(-wxOd);
}
#endif
`;

function patchChunks() {
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  if (C.lights_physical_pars_fragment.includes('wxExposure')) return; // HMR
  C.lights_physical_pars_fragment = SURF_PARS + C.lights_physical_pars_fragment;
  C.lights_physical_fragment = SURF + C.lights_physical_fragment;
  C.fog_pars_vertex += FOG_PARS_V;
  C.fog_vertex += FOG_V;
  C.fog_pars_fragment += FOG_PARS_F;
  // the fog factor is computed, then our height fog / low cloud is folded in, then applied
  C.fog_fragment = C.fog_fragment.replace('gl_FragColor.rgb = mix', FOG_F + '\n\tgl_FragColor.rgb = mix');
  const lib = THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, THREE.IUniform> }>;
  for (const k of Object.keys(lib)) {
    const u = lib[k].uniforms;
    if (u.fogColor) {
      u.wxFogA = weatherUniforms.wxFogA;
      u.wxFogB = weatherUniforms.wxFogB;
    }
  }
  for (const k of ['standard', 'physical']) {
    const u = lib[k].uniforms;
    u.wxState = weatherUniforms.wxState;
    u.wxState2 = weatherUniforms.wxState2;
    u.wxOccMat = weatherUniforms.wxOccMat;
    u.wxOcc = weatherUniforms.wxOcc;
  }
  const fogLib = THREE.UniformsLib.fog as unknown as Record<string, THREE.IUniform>;
  fogLib.wxFogA = weatherUniforms.wxFogA;
  fogLib.wxFogB = weatherUniforms.wxFogB;
}
patchChunks();

// ---------------------------------------------------------------- cloud noise (shared by GPU and CPU)

const NOISE = 128;
const noiseData = (() => {
  // tileable value noise, 32 cells across, quintic interpolation (smooth enough to fbm without grid lines)
  const out = new Uint8Array(NOISE * NOISE * 4);
  const cells = 32, cs = NOISE / cells;
  let s = 1234567;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const grids = [0, 1].map(() => Float32Array.from({ length: cells * cells }, rnd));
  const q = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let y = 0; y < NOISE; y++)
    for (let x = 0; x < NOISE; x++) {
      const gx = x / cs, gy = y / cs;
      const ix = Math.floor(gx), iy = Math.floor(gy);
      const fx = q(gx - ix), fy = q(gy - iy);
      for (let ch = 0; ch < 2; ch++) {
        const g = grids[ch];
        const at = (a: number, b: number) => g[((b + cells) % cells) * cells + ((a + cells) % cells)];
        const v = (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
        out[(y * NOISE + x) * 4 + ch] = Math.round(v * 255);
      }
      out[(y * NOISE + x) * 4 + 3] = 255;
    }
  return out;
})();
const noiseTex = new THREE.DataTexture(noiseData, NOISE, NOISE, THREE.RGBAFormat);
noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
noiseTex.magFilter = THREE.LinearFilter;
noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
noiseTex.generateMipmaps = true;
noiseTex.needsUpdate = true;

function noiseAt(u: number, v: number) {
  const x = u * NOISE - 0.5, y = v * NOISE - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const at = (a: number, b: number) => noiseData[((((b % NOISE) + NOISE) % NOISE) * NOISE + (((a % NOISE) + NOISE) % NOISE)) * 4] / 255;
  return (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
}
/** same fbm as cfbm() in the cloud shader */
function cfbmCpu(px: number, py: number) {
  let s = 0, a = 0.5;
  for (let i = 0; i < 5; i++) {
    s += a * noiseAt(px, py);
    const x = 0.8 * px + 0.6 * py, y = -0.6 * px + 0.8 * py;
    px = x * 2.03 + 0.17;
    py = y * 2.03 + 0.17;
    a *= 0.5;
  }
  return s / 0.96875;
}

const CLOUD_H = 1500; // m, the cloud deck
const CLOUD_SCALE = 5000; // m per noise tile

const CLOUD_GLSL = /* glsl */ `
uniform sampler2D tNoise;
uniform vec4 uCloud;   // cover, darkness, offset x, offset z (noise units)
uniform vec4 uCloud2;  // camera x, camera z, fog over the whole sky, horizon fill
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uAmb;
uniform vec3 uHaze;
uniform vec3 uGlow;
float cfbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * texture2D(tNoise, p).r;
    p = mat2(0.8, -0.6, 0.6, 0.8) * p * 2.03 + 0.17;
    a *= 0.5;
  }
  return s / 0.96875;
}
float cdens(float n, float cov) {
  float th = mix(0.74, 0.2, cov);
  // (x cover: at low cover only the noise's highest peaks would pass, small grey flecks like debris)
  return max(smoothstep(th, th + 0.16, n), smoothstep(0.8, 1.0, cov) * 0.9) * smoothstep(0.0, 0.3, cov);
}
// cloud radiance (not premultiplied) + coverage for a view direction (world space); hz = how much
// of the result is haze (uHaze), mixed in by the caller like three's fog (after tone mapping on screen)
vec4 clouds(vec3 dir, out float hz) {
  float cov = uCloud.x, dark = uCloud.y;
  float dy = max(dir.y, 0.035);
  vec2 wp = uCloud2.xy + dir.xz * (${CLOUD_H.toFixed(1)} / dy);
  vec2 p = wp / ${CLOUD_SCALE.toFixed(1)} + uCloud.zw;
  float n = cfbm(p);
  float d = cdens(n, cov);
  // self shadowing: more cloud towards the sun = this side is in the cloud's own shade
  vec2 toSun = normalize(uSunDir.xz + 1e-4) * 0.012;
  float n2 = cfbm(p + toSun);
  float lit = clamp(0.55 + (n - n2) * 9.0, 0.0, 1.0);
  float thick = clamp((n - mix(0.74, 0.2, cov)) * 3.0, 0.0, 1.0);
  float mu = dot(dir, uSunDir);
  float silver = pow(max(mu, 0.0), 12.0) * (1.0 - thick) * 3.0 + pow(max(mu, 0.0), 3.0) * 0.4;
  float sunVis = (1.0 - dark) * smoothstep(-0.05, 0.1, uSunDir.y) * (1.0 - 0.75 * smoothstep(0.85, 1.0, cov));
  vec3 base = uAmb * mix(1.1, 0.74, thick * (0.75 - 0.35 * cov)) * mix(1.0, 0.45, dark);
  vec3 col = base * (0.85 + 0.25 * lit) + uSunCol * sunVis * (lit * 0.6 + silver) * (0.35 + 0.65 * (1.0 - cov));
  col += uGlow * (0.6 + 0.4 * thick);
  // towards the horizon the deck thins into haze
  float h = smoothstep(0.0, 0.3, dir.y);
  // (below dy's clamp at 0.035 the deck's noise would smear into vertical streaks: no cloud there)
  float a = d * smoothstep(0.035, 0.1, dir.y);
  hz = 0.65 * (1.0 - h);
  // overcast / fog: also fill below the horizon so the HDRI's own skyline fades into the grey
  float A = max(max(a, uCloud2.w * smoothstep(-0.25, 0.0, dir.y)), uCloud2.z);
  hz = max(hz, 1.0 - smoothstep(-0.02, 0.08, dir.y));
  hz = max(hz, uCloud2.z);
  hz = max(hz, 1.0 - a / max(A, 1e-4));
  return vec4(col, A);
}
`;

// ---------------------------------------------------------------- the weather system

const COUNTS: Record<Quality, { drops: number; splashes: number; occ: number; occSize: number }> = {
  ultra: { drops: 20000, splashes: 1600, occ: 1024, occSize: 160 },
  high: { drops: 11000, splashes: 900, occ: 1024, occSize: 160 },
  low: { drops: 4500, splashes: 350, occ: 512, occSize: 128 },
};
const OCC_TOP = 520, OCC_NEAR = 1, OCC_FAR = 760;

function lerpParams(a: Params, b: Params, t: number, out: Params) {
  for (const k of Object.keys(a) as (keyof Params)[]) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

function quadGeometry(n: number, horizontal: boolean) {
  const g = new THREE.BufferGeometry();
  const seed = new Float32Array(n * 16), corner = new Float32Array(n * 8), pos = new Float32Array(n * 12);
  const idx = new Uint32Array(n * 6);
  let s = 987654321;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const C = horizontal ? [-1, -1, 1, -1, 1, 1, -1, 1] : [-1, 0, 1, 0, 1, 1, -1, 1];
  for (let i = 0; i < n; i++) {
    const r = [rnd(), rnd(), rnd(), rnd()];
    for (let v = 0; v < 4; v++) {
      seed.set(r, (i * 4 + v) * 4);
      corner[(i * 4 + v) * 2] = C[v * 2];
      corner[(i * 4 + v) * 2 + 1] = C[v * 2 + 1];
    }
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

const OCC_SAMPLE = /* glsl */ `
uniform mat4 uOccMat;
uniform sampler2D uOcc;
uniform vec4 uOccInfo; // valid, bias, top, far-near
// world height of the top-most surface at xz (-1e4 if unknown)
float occTop(vec2 xz) {
  if (uOccInfo.x < 0.5) return -1e4;
  vec4 c = uOccMat * vec4(xz.x, 0.0, xz.y, 1.0);
  vec2 uv = c.xy * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -1e4;
  float d = texture2D(uOcc, uv).x;
  return uOccInfo.z - (${OCC_NEAR.toFixed(1)} + d * uOccInfo.w);
}
`;

const PRECIP_V = /* glsl */ `
attribute vec4 aSeed;
attribute vec2 aCorner;
uniform vec3 uCam;
uniform vec3 uBox;
uniform vec4 uMotion; // time, fall speed, streak seconds, snow 0..1
uniform vec2 uWind;
uniform float uCount;
uniform float uPx; // metres per pixel at 1 m
varying vec2 vC;
varying float vA;
${OCC_SAMPLE}
void main() {
  float t = uMotion.x, snow = uMotion.w;
  vec3 size = uBox * 2.0;
  float sp = uMotion.y * mix(0.85 + 0.3 * aSeed.w, 0.6 + 0.8 * aSeed.w, snow);
  vec3 vel = vec3(uWind.x, -sp, uWind.y);
  vec3 p = aSeed.xyz * size + vel * (t + aSeed.w * 37.0);
  p.x += snow * sin(t * 1.3 + aSeed.w * 40.0) * 0.4;
  p.z += snow * cos(t * 1.1 + aSeed.x * 30.0) * 0.4;
  vec3 rel = mod(p - uCam + uBox, size) - uBox;
  vec3 wp = uCam + rel;
  float dist = length(rel);
  float vis = step(aSeed.w * 0.9999, uCount);
  vis *= 1.0 - smoothstep(uBox.x * 0.6, uBox.x, length(rel.xz));
  vis *= smoothstep(0.25, 1.2, dist);
  // sheltered by a roof, awning or the like: the drop is not there
  if (wp.y < occTop(wp.xz) - 0.05) vis = 0.0;
  vec3 a = (viewMatrix * vec4(wp, 1.0)).xyz;
  vec3 pos;
  if (snow > 0.5) {
    float w = 0.01 + 0.012 * aSeed.y + dist * 0.002;
    pos = a + vec3(aCorner.x, aCorner.y * 2.0 - 1.0, 0.0) * w;
  } else {
    vec3 b = (viewMatrix * vec4(wp - vel * uMotion.z, 1.0)).xyz;
    vec3 ax = b - a;
    vec3 side = normalize(cross(ax, a) + vec3(1e-5, 0.0, 0.0));
    // at least ~1.3 px wide; thinner-than-a-pixel drops fade instead of vanishing
    float w0 = 0.0025 + dist * 0.0008;
    float w = max(w0, 1.3 * uPx * dist);
    vis *= clamp(w0 / w * 1.6, 0.3, 1.0);
    pos = mix(a, b, aCorner.y) + side * aCorner.x * w;
  }
  vC = aCorner;
  vA = vis;
  if (vis <= 0.0) pos = vec3(0.0, 0.0, 1.0); // collapsed behind the camera
  gl_Position = projectionMatrix * vec4(pos, 1.0);
}
`;
const PRECIP_F = /* glsl */ `
uniform vec3 uColor;
uniform vec4 uMotion;
uniform float uOpacity;
varying vec2 vC;
varying float vA;
void main() {
  float a;
  if (uMotion.w > 0.5) a = 1.0 - smoothstep(0.25, 1.0, length(vec2(vC.x, vC.y * 2.0 - 1.0)));
  else a = (1.0 - abs(vC.x)) * smoothstep(0.0, 0.35, vC.y) * (1.0 - smoothstep(0.75, 1.0, vC.y));
  a *= vA * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SPLASH_V = /* glsl */ `
attribute vec4 aSeed;
attribute vec2 aCorner;
uniform vec3 uCam;
uniform vec4 uSplash; // time, radius, count fraction, rate
uniform float uDrip;  // share of slots that are drips off awnings / ledges / fire escapes (0..1)
varying vec2 vC;
varying float vPh;
varying float vDrip;
${OCC_SAMPLE}
vec2 h22(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
void main() {
  vDrip = 0.0;
  if (aSeed.z < 0.25) {
    // drips: fall from the edge of something overhead (a step down in the exposure map)
    float cyc = uSplash.x * (0.7 + 0.6 * aSeed.y) + aSeed.w * 10.0;
    float k = floor(cyc), ph = fract(cyc);
    vec2 h = h22(aSeed.xy * 53.1 + floor(k / 5.0) * 0.731); // the same spot drips a few times
    float an = h.y * 6.2831853;
    vec2 xz = uCam.xz + vec2(cos(an), sin(an)) * 11.0 * sqrt(h.x);
    float hc = occTop(xz);
    vec2 best = xz;
    float lo = hc;
    for (int i = 0; i < 4; i++) {
      float a = float(i) * 1.5707963;
      vec2 q = xz + vec2(cos(a), sin(a)) * 0.5;
      float t = occTop(q);
      if (t < lo) { lo = t; best = q; }
    }
    float drop = hc - lo;
    float ok = step(1.5, drop) * step(drop, 14.0) * step(aSeed.w, uDrip) * step(-1e3, lo);
    float T = sqrt(2.0 * drop / 9.8);
    float y = hc - 0.05 - 4.9 * (ph * T) * (ph * T);
    vec3 wp = vec3(best.x, y, best.y);
    // a short vertical streak facing the camera
    vec3 a0 = (viewMatrix * vec4(wp, 1.0)).xyz;
    vec3 a1 = (viewMatrix * vec4(wp + vec3(0.0, 0.05 + 0.25 * ph, 0.0), 1.0)).xyz;
    vec3 side = normalize(cross(a1 - a0, a0) + vec3(1e-5, 0.0, 0.0));
    float w = max(0.004, 0.003 * length(a0));
    vec3 pos = mix(a0, a1, aCorner.y * 0.5 + 0.5) + side * aCorner.x * w;
    vC = aCorner;
    vPh = ok > 0.0 ? 0.0 : 2.0;
    vDrip = 1.0;
    gl_Position = projectionMatrix * vec4(pos, 1.0);
    if (ok <= 0.0) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    return;
  }
  float cyc = uSplash.x * uSplash.w * (0.8 + 0.4 * aSeed.z) + aSeed.w * 10.0;
  float k = floor(cyc), ph = fract(cyc);
  vec2 h = h22(aSeed.xy * 91.7 + k * 0.137);
  // denser near the viewer
  float r = uSplash.y * sqrt(h.x);
  float an = h.y * 6.2831853;
  vec2 xz = uCam.xz + vec2(cos(an), sin(an)) * r;
  float y = occTop(xz);
  float vis = step(aSeed.w * 0.9999, uSplash.z) * step(-1e3, y);
  float s = mix(0.025, 0.11, sqrt(ph)) * (0.7 + 0.6 * aSeed.y);
  vec3 wp = vec3(xz.x + aCorner.x * s, y + 0.015, xz.y + aCorner.y * s);
  vC = aCorner;
  vPh = vis > 0.0 ? ph : 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (vis <= 0.0) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}
`;
const SPLASH_F = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vC;
varying float vPh;
varying float vDrip;
void main() {
  if (vPh > 1.0) discard;
  if (vDrip > 0.5) {
    float da = (1.0 - abs(vC.x)) * uOpacity * 1.4;
    gl_FragColor = vec4(uColor, da);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }
  float r = length(vC);
  float ring = 1.0 - smoothstep(0.0, 0.2, abs(r - 0.75));
  float core = (1.0 - smoothstep(0.0, 0.35, r)) * (1.0 - smoothstep(0.0, 0.35, vPh));
  float a = (ring * 0.8 + core) * (1.0 - vPh) * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const DOME_V = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w * 0.99999;
}
`;
const DOME_F = /* glsl */ `
varying vec3 vDir;
uniform vec3 uHazeOut;
${CLOUD_GLSL}
void main() {
  float hz;
  vec4 c = clouds(normalize(vDir), hz);
  if (c.a < 0.002) discard;
  gl_FragColor = c;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // haze is mixed in exactly like three's fog_fragment (after tone mapping when drawing to screen)
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uHazeOut, hz);
}
`;


const WINDOW_VIEW = /* glsl */ `
#ifdef USE_EMISSIVEMAP
{
  vec2 vu = vEmissiveMapUv;
  vec3 e = totalEmissiveRadiance;
  float l = dot(e, vec3(0.2126, 0.7152, 0.0722));
  float cov = wxView.x;
  // sky strip at the top of the view turns grey, everything greys and darkens under cloud
  float sky = smoothstep(0.01, 0.08, e.b - e.r) * smoothstep(0.5, 0.75, vu.y);
  e = mix(e, vec3(l), 0.55 * cov);
  e *= 1.0 - 0.3 * cov;
  e = mix(e, vec3(0.62, 0.64, 0.67) * (1.0 - 0.45 * wxView.y), sky * cov);
  // fog: a veil across the street
  e = mix(e, vec3(0.55, 0.57, 0.6), wxView.w);
  // rain streaks
  float col = floor(vu.x * 110.0);
  float hcol = fract(sin(col * 12.9898) * 43758.5453);
  float s = fract(vu.y * 2.0 + wxState2.z * (2.2 + hcol) + hcol * 7.0);
  e += vec3(0.5) * wxView.y * step(0.55, hcol) * smoothstep(0.9, 0.97, s) * (1.0 - smoothstep(0.97, 1.0, s));
  // snow flakes
  vec2 g = vec2(vu.x * 26.0, vu.y * 26.0 + wxState2.z * 1.2);
  vec2 gi = floor(g), gf = fract(g);
  vec2 c = vec2(fract(sin(dot(gi, vec2(12.9898, 78.233))) * 43758.5453), fract(sin(dot(gi, vec2(39.3468, 11.135))) * 24634.6345));
  c.x += 0.15 * sin(wxState2.z + c.y * 6.0);
  e += vec3(0.9) * wxView.z * (1.0 - smoothstep(0.04, 0.12, length(gf - c)));
  totalEmissiveRadiance = e;
}
#endif
`;

export class Weather {
  /** for the HUD */
  readonly info = info;
  private group = new THREE.Group();
  private dome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private precip: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private splash: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private cloudU: Record<string, THREE.IUniform>;
  private occCam = new THREE.OrthographicCamera(-80, 80, 80, -80, OCC_NEAR, OCC_FAR);
  private occOverride = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  private occCenter = new THREE.Vector2(1e9, 1e9);
  private occT = 0;
  private occInfo = new THREE.Vector4(0, 0, OCC_TOP, OCC_FAR - OCC_NEAR);
  private occMat4 = new THREE.Matrix4();

  private counts = COUNTS.ultra;
  // state machine
  private from: Params = { ...P.clear };
  private to: Params = { ...P.clear };
  private cur: Params = { ...P.clear };
  private target: WeatherState = 'clear';
  private tTrans = 1;
  private dur = 1;
  private dwell = 300;
  private auto = true;
  private time = 0;
  private wind = new THREE.Vector2(1, 0.3);
  private cloudOff = new THREE.Vector2(0.37, 0.61);
  private sunOcc = 0;
  private sunDir = new THREE.Vector3(0.4, 0.8, 0.3);
  private csmLights: THREE.DirectionalLight[] = [];
  private scanT = 0;
  private viewMats = new Set<THREE.Material>();
  private farBase = 0;
  private lastMods = '';
  /** jump low-passed values to their targets on the next update (instant set) */
  private snap = true;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private lighting: Lighting,
  ) {
    this.cloudU = {
      tNoise: { value: noiseTex },
      uCloud: { value: new THREE.Vector4(0, 0, 0, 0) },
      uCloud2: { value: new THREE.Vector4(0, 0, 0, 0) },
      uSunDir: { value: this.sunDir },
      uSunCol: { value: new THREE.Color() },
      uAmb: { value: new THREE.Color() },
      uHaze: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
    };
    // opacity < 0.6 + transparent: main.ts keeps these out of GTAO's depth/normal pass
    const dm = new THREE.ShaderMaterial({ uniforms: { ...this.cloudU, uHazeOut: { value: new THREE.Color() } }, vertexShader: DOME_V, fragmentShader: DOME_F, side: THREE.BackSide, transparent: true, depthWrite: false, opacity: 0.5 });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), dm);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    this.dome.onBeforeRender = (r, _s, cam) => {
      // the fog colour as three hands it to fog_fragment (display space when drawing straight to screen)
      const out = dm.uniforms.uHazeOut.value as THREE.Color;
      out.copy(this.cloudU.uHaze.value as THREE.Color);
      if (r.getRenderTarget() === null && r.outputColorSpace === THREE.SRGBColorSpace) out.convertLinearToSRGB();
      this.dome.position.copy(cam.position);
      this.dome.updateMatrixWorld();
    };
    const occU = {
      uOccMat: { value: this.occMat4 },
      uOcc: { value: occRT.depthTexture },
      uOccInfo: { value: this.occInfo },
      uCam: { value: new THREE.Vector3() },
    };
    const pm = new THREE.ShaderMaterial({
      uniforms: {
        ...occU,
        uBox: { value: new THREE.Vector3(14, 10, 14) },
        uMotion: { value: new THREE.Vector4() },
        uWind: { value: new THREE.Vector2() },
        uCount: { value: 0 },
        uPx: { value: 0.001 },
        uColor: { value: new THREE.Color() },
        uOpacity: { value: 0.5 },
      },
      vertexShader: PRECIP_V, fragmentShader: PRECIP_F, side: THREE.DoubleSide, transparent: true, depthWrite: false, opacity: 0.5,
    });
    this.precip = new THREE.Mesh(quadGeometry(COUNTS.ultra.drops, false), pm);
    this.precip.frustumCulled = false;
    const sm = new THREE.ShaderMaterial({
      uniforms: { ...occU, uSplash: { value: new THREE.Vector4() }, uDrip: { value: 0 }, uColor: { value: new THREE.Color() }, uOpacity: { value: 0.5 } },
      vertexShader: SPLASH_V, fragmentShader: SPLASH_F, side: THREE.DoubleSide, transparent: true, depthWrite: false, opacity: 0.5,
    });
    this.splash = new THREE.Mesh(quadGeometry(COUNTS.ultra.splashes, true), sm);
    this.splash.frustumCulled = false;
    this.group.add(this.dome, this.precip, this.splash);
    this.group.name = 'weather';
    this.group.userData.noOcclude = true;


    // compile the particle / dome / composite shaders up front: weather changes never compile anything
    try {
      const tmp = new THREE.Scene();
      const vis = [this.dome, this.precip, this.splash].map((o) => o.visible);
      tmp.add(this.group);
      renderer.compile(tmp, camera);
      scene.add(this.group);
      [this.dome, this.precip, this.splash].forEach((o, i) => (o.visible = vis[i]));
    } catch (e) {
      console.warn('weather: precompile failed', e);
      scene.add(this.group);
    }
    this.occCam.up.set(0, 0, -1);
    this.setQuality(lighting.quality);

    const p = new URLSearchParams(location.search).get('weather');
    const alias: Record<string, WeatherState> = { cloudy: 'overcast', drizzle: 'lightrain', storm: 'rain', heavyrain: 'rain', mist: 'fog', sun: 'clear', sunny: 'clear' };
    const st = (p && ((WEATHER_STATES as string[]).includes(p) ? (p as WeatherState) : alias[p])) || null;
    if (st) {
      this.auto = false;
      this.set(st, 0);
    } else this.set(p === 'random' ? this.pickNext('clear') : 'clear', 0);
  }

  // ------------------------------------------------------------ public API

  get state() {
    return this.target;
  }

  /** go to a state over `seconds` (0 = at once, with matching wetness / snow on the ground) */
  set(s: WeatherState, seconds = 90) {
    this.from = { ...this.cur };
    this.to = { ...P[s] };
    this.target = s;
    this.dur = Math.max(0.001, seconds);
    this.tTrans = seconds <= 0 ? 1 : 0;
    const [a, b] = DWELL[s];
    this.dwell = 60 * (a + Math.random() * (b - a)) + seconds;
    if (seconds <= 0) {
      lerpParams(this.to, this.to, 1, this.cur);
      info.wetness = s === 'rain' ? 1 : s === 'lightrain' ? 0.75 : s === 'snow' ? 0.35 : s === 'fog' ? 0.25 : 0;
      info.snowCover = s === 'snow' ? 0.85 : 0;
      this.snap = true;
    }
    info.state = s;
    info.label = WEATHER_LABEL[s];
    for (const fn of listeners) fn(info);
  }

  /** Y key: next state (quick transition); the random walk carries on from there */
  cycle(dir = 1) {
    const i = WEATHER_STATES.indexOf(this.target);
    const s = WEATHER_STATES[(i + dir + WEATHER_STATES.length) % WEATHER_STATES.length];
    this.set(s, 6);
    return WEATHER_LABEL[s];
  }

  /** stop / resume the random walk */
  setAuto(on: boolean) {
    this.auto = on;
  }

  setQuality(q: Quality) {

    this.counts = COUNTS[q];
    if (occRes !== this.counts.occ) {
      occRes = this.counts.occ;
      occRT.setSize(occRes, occRes);
      this.occInfo.x = 0;
      WX2.y = 0;
    }
    this.occCenter.set(1e9, 1e9);
  }

  debug() {
    return {
      state: this.target, progress: +this.tTrans.toFixed(2), auto: this.auto, cur: Object.fromEntries(Object.entries(this.cur).map(([k, v]) => [k, +v.toFixed(4)])),
      wet: +info.wetness.toFixed(2), snowCover: +info.snowCover.toFixed(2), sunOcc: +this.sunOcc.toFixed(2), occ: this.occInfo.x,
      far: this.camera.far,
    };
  }

  // ------------------------------------------------------------ per frame

  update(dt: number, focus: THREE.Vector3) {
    this.time += dt;
    WX2.z = this.time;
    this.step(dt);
    const outdoor = this.lighting.place === 'outdoor';
    this.group.visible = outdoor;
    const c = this.cur;

    // accumulation on the ground
    const wetT = Math.max(c.rain > 0.02 ? 0.6 + 0.4 * c.rain : 0, c.snow * 0.35, c.ground > 0.005 ? 0.25 : 0);
    info.wetness += (wetT - info.wetness) * Math.min(1, dt * (wetT > info.wetness ? 0.04 + 0.08 * c.rain : 1 / 240));
    const snowT = c.snow > 0.05 ? 0.4 + 0.6 * c.snow : 0;
    info.snowCover += (snowT - info.snowCover) * Math.min(1, dt * (snowT > info.snowCover ? 1 / 150 : 1 / 600));
    Object.assign(info, { cloud: c.cloud, rain: c.rain, snow: c.snow, fog: c.ground, wind: c.wind, progress: this.tTrans });
    info.umbrellas = Math.min(1, c.rain * 1.6 + c.snow * 0.3);
    info.hoods = Math.min(1, c.rain * 0.6 + c.snow * 0.8);
    // nyc/people.ts: umbrellas / hoods / hurrying (quantised: it rebuilds props on change)
    const q = (x: number) => Math.round(Math.min(1, x) * 10) / 10;
    setPeopleWeather({ rain: q(c.rain * 1.6), snow: q(c.snow) });

    // wind and cloud drift
    const ang = this.time * 0.01;
    this.wind.set(Math.cos(ang), Math.sin(ang * 0.7) * 0.5 + 0.3).normalize().multiplyScalar(c.wind);
    this.cloudOff.addScaledVector(this.wind, (dt * 4) / CLOUD_SCALE);

    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = 1;
      this.scan();
    }

    if (!outdoor) {
      WX.w = 0;
      groundWeather.wet.value = groundWeather.puddles.value = groundWeather.snow.value = 0;
      FOG_A.x = 0;
      FOG_B.y = 0;
      VIEW.x = c.cloud;
      VIEW.y = c.rain;
      VIEW.z = c.snow;
      VIEW.w = Math.min(0.85, c.ground * 40);
      return;
    }

    this.updateSun(dt);
    this.updateLighting();
    this.updateCloudUniforms(focus);

    // surfaces
    WX.x = info.wetness;
    WX.y = info.snowCover;
    WX.z = c.rain;
    WX.w = info.wetness > 0.01 || info.snowCover > 0.005 ? 1 : 0;
    // nyc/ground.ts: its own wet / puddle / snow shading for road, pavement and kerbs
    groundWeather.wet.value = info.wetness;
    groundWeather.puddles.value = Math.min(1, info.wetness * (0.4 + 0.8 * c.rain));
    groundWeather.snow.value = info.snowCover;

    // height fog and low cloud
    FOG_A.x = c.ground;
    FOG_A.y = 1 / 45;
    FOG_A.z = 0;
    FOG_B.x = c.base;
    FOG_B.y = c.inCloud;
    FOG_B.z = 50;

    this.updateFar();
    this.updateOcclusion(dt, focus);
    this.updateParticles(dt);
  }

  private pickNext(s: WeatherState): WeatherState {
    const opts = NEXT[s];
    let r = Math.random() * opts.reduce((a, o) => a + o[1], 0);
    for (const [st, w] of opts) if ((r -= w) <= 0) return st;
    return opts[0][0];
  }

  private step(dt: number) {
    if (this.tTrans < 1) {
      this.tTrans = Math.min(1, this.tTrans + dt / this.dur);
      const t = this.tTrans * this.tTrans * (3 - 2 * this.tTrans);
      lerpParams(this.from, this.to, t, this.cur);
      // rain / snow start late and stop early: clouds come first
      const lag = (x: number, a: number, b: number) => (b > a ? a + (b - a) * Math.max(0, (t - 0.5) * 2) : a + (b - a) * Math.min(1, t * 2));
      this.cur.rain = lag(0, this.from.rain, this.to.rain);
      this.cur.snow = lag(0, this.from.snow, this.to.snow);
    }
    if (this.auto) {
      this.dwell -= dt;
      if (this.dwell <= 0) this.set(this.pickNext(this.target), 60 + Math.random() * 120);
    }
  }

  /** CSM sun lights (direction, and shadow softening under cloud) */
  private scan() {
    const found: THREE.DirectionalLight[] = [];
    this.scene.traverse((o) => {
      if ((o as THREE.DirectionalLight).isDirectionalLight && o.parent === this.scene && (o as THREE.DirectionalLight).castShadow) found.push(o as THREE.DirectionalLight);
      if (this.lighting.place !== 'outdoor') {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && !Array.isArray(m) && m.userData.windowView && !this.viewMats.has(m)) this.hookView(m);
      }
    });
    // road / pavement / kerbs (lighting.wetSurface, nyc/ground.ts) do their own wet, puddles and
    // snow (ruts, walking lines) from groundWeather: only ripples + shelter from us
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !Array.isArray(m) && m.userData.wet && !(m.defines && 'WX_NOWET' in m.defines)) {
        m.defines = { ...(m.defines ?? {}), WX_NOWET: '', WX_NOSNOW: '' };
        m.needsUpdate = true;
      }
    });
    this.csmLights = found;
  }

  private hookView(m: THREE.MeshStandardMaterial) {
    this.viewMats.add(m);
    const prev = m.onBeforeCompile.bind(m);
    m.onBeforeCompile = (sh, r) => {
      prev(sh, r);
      sh.uniforms.wxView = { value: VIEW };
      sh.uniforms.wxState2 = weatherUniforms.wxState2;
      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {', '#ifdef WX_OFF\nuniform vec4 wxState2;\n#endif\nuniform vec4 wxView;\nvoid main() {')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + WINDOW_VIEW);
    };
    const key = m.customProgramCacheKey.bind(m);
    m.customProgramCacheKey = () => key() + '|wxview';
    // window views do not need the outdoor surface code (it would never run inside anyway)
    m.defines = { ...(m.defines ?? {}), WX_OFF: '' };
    m.needsUpdate = true;
  }

  private updateSun(dt: number) {
    const l = this.csmLights[0];
    if (l) this.sunDir.subVectors(l.position, l.target.position).normalize();
    // how much cloud is between us and the sun (same noise as the shader)
    const c = this.cur;
    const dy = Math.max(this.sunDir.y, 0.035);
    const k = CLOUD_H / dy / CLOUD_SCALE;
    const cx = this.camera.position.x / CLOUD_SCALE + this.sunDir.x * k + this.cloudOff.x;
    const cz = this.camera.position.z / CLOUD_SCALE + this.sunDir.z * k + this.cloudOff.y;
    const n = cfbmCpu(cx, cz);
    const th = 0.74 + (0.2 - 0.74) * c.cloud;
    const s = (x: number) => Math.min(1, Math.max(0, x));
    const sm = (a: number, b: number, x: number) => {
      const t = s((x - a) / (b - a));
      return t * t * (3 - 2 * t);
    };
    const d = Math.max(sm(th, th + 0.16, n), sm(0.8, 1, c.cloud) * 0.9) * sm(0, 0.3, c.cloud);
    const thick = s((n - th) * 3);
    const occ = Math.min(1, d * (0.55 + 0.45 * thick) + sm(0.8, 1, c.cloud) * 0.6 + c.dark * 0.3 + c.ground * 20);
    this.sunOcc += (Math.min(0.985, occ) - this.sunOcc) * (this.snap ? 1 : Math.min(1, dt * 1.5));
    this.snap = false;
  }

  private updateLighting() {
    const c = this.cur;
    const night = getNight();
    const occ = this.sunOcc;
    // lighting crossfades sky + env to its grey overcast HDRI; rain clouds dim it a little more
    const skyMul = 1 + 0.1 * c.cloud * (1 - night) - 0.25 * c.dark;
    const s = THREE.MathUtils.clamp((c.cloud - 0.55) / 0.4, 0, 1);
    const overcast = Math.max(s * s * (3 - 2 * s), c.fogSky);
    const cloudCol = this.cloudBase();
    const fogMix = Math.min(1, 0.25 + 0.6 * c.cloud + 0.3 * c.fogSky) * Math.min(1, c.cloud * 1.5 + c.fogSky);
    const mods = {
      cloud: c.cloud,
      sunMul: 1 - occ,
      skyMul,
      fogMul: c.haze,
      fogColor: '#' + cloudCol.clone().multiplyScalar(0.92).getHexString(),
      fogMix,
      wet: info.wetness,
      overcast: +overcast.toFixed(3),
    };
    const key = JSON.stringify(mods);
    if (key !== this.lastMods) {
      this.lastMods = key;
      setLightingWeather(mods);
    }
    for (const l of this.csmLights) l.shadow.intensity = 1 - 0.55 * Math.min(1, occ * 1.4);
  }

  /** colour of the cloud deck's underside in scene units (also the fog colour under cloud) */
  private cloudBase() {
    const c = this.cur;
    const tod = getTimeOfDay();
    const pre = this.lighting.preset;
    const night = getNight();
    const amb = new THREE.Color(0.82, 0.85, 0.9).multiplyScalar(pre.sky * 1.6);
    if (tod === 'golden') amb.lerp(new THREE.Color(pre.sunColor).multiplyScalar(pre.sky), 0.25);
    amb.lerp(new THREE.Color(pre.fogTint).multiplyScalar(pre.sky * 2), 0.6 * pre.fogTintMix);
    amb.multiplyScalar(1 - 0.5 * c.dark);
    // city light on the clouds at night: NYC's low cloud glows orange-brown
    amb.add(new THREE.Color(0.55, 0.36, 0.24).multiplyScalar(0.06 * night * c.cloud));
    return amb;
  }

  private updateCloudUniforms(focus: THREE.Vector3) {
    const c = this.cur;
    const u = this.cloudU;
    const pre = this.lighting.preset;
    const night = getNight();
    u.uCloud.value.set(c.cloud, c.dark, this.cloudOff.x, this.cloudOff.y);
    u.uCloud2.value.set(focus.x, focus.z, c.fogSky, Math.max(0, (c.cloud - 0.85) / 0.15) * 0.85);
    (u.uSunCol.value as THREE.Color).set(pre.sunColor).multiplyScalar(pre.sunIntensity * 0.16);
    const amb = this.cloudBase();
    (u.uAmb.value as THREE.Color).copy(amb);
    const fog = this.scene.fog as THREE.FogExp2 | null;
    (u.uHaze.value as THREE.Color).copy(fog ? fog.color : amb);
    (u.uGlow.value as THREE.Color).setRGB(0.5, 0.3, 0.18).multiplyScalar(0.05 * night * c.cloud);
  }

  /** thick fog: the far plane comes in to where nothing is left to see */
  private updateFar() {
    const fog = this.scene.fog as THREE.FogExp2 | null;
    const dens = fog && (fog as THREE.FogExp2).isFogExp2 ? fog.density : 0;
    const g = this.cur.ground;
    // optical depth 5.5 (99.6 % fog) along the street
    let far = 900;
    if (g > 0.0005 || dens > 0.004) {
      for (let d = 200; d < 900; d += 20) {
        const od = (dens * d) ** 2 + g * d;
        if (od > 5.5) {
          far = d;
          break;
        }
      }
    }
    if (!this.farBase) this.farBase = this.camera.far;
    const want = Math.max(320, Math.min(this.farBase, far));
    if (Math.abs(this.camera.far - want) > 10) {
      this.camera.far = want;
      this.camera.updateProjectionMatrix();
    }
  }

  // ------------------------------------------------------------ sky exposure map

  private updateOcclusion(dt: number, focus: THREE.Vector3) {
    this.occT -= dt;
    const S = this.counts.occSize;
    const moved = Math.max(Math.abs(focus.x - this.occCenter.x), Math.abs(focus.z - this.occCenter.y));
    const need = WX.w > 0 || this.cur.rain > 0.01 || this.cur.snow > 0.01;
    if (!need || (moved < S / 8 && this.occT > 0)) return;
    this.occT = 3;
    const texel = S / occRes;
    const snap = texel * 8;
    const cx = Math.round(focus.x / snap) * snap, cz = Math.round(focus.z / snap) * snap;
    this.occCenter.set(cx, cz);
    const cam = this.occCam;
    cam.left = cam.bottom = -S / 2;
    cam.right = cam.top = S / 2;
    cam.position.set(cx, OCC_TOP, cz);
    cam.lookAt(cx, 0, cz);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    const r = this.renderer, sc = this.scene;
    const prev = { rt: r.getRenderTarget(), bg: sc.background, ov: sc.overrideMaterial, au: r.shadowMap.autoUpdate, nu: r.shadowMap.needsUpdate, fog: sc.fog };
    const hidden: THREE.Object3D[] = [];
    // skies, domes and decals (no depth write) are not roofs
    for (const o of sc.children) {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (o.visible && ((o as unknown as { isSky?: boolean }).isSky || o.userData.noOcclude || (m && !Array.isArray(m) && !m.depthWrite))) hidden.push(o);
    }
    hidden.forEach((o) => (o.visible = false));
    sc.background = null;
    sc.fog = null;
    sc.overrideMaterial = this.occOverride;
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = false;
    r.setRenderTarget(occRT);
    r.clear(true, true, false);
    r.render(sc, cam);
    r.setRenderTarget(prev.rt);
    r.shadowMap.autoUpdate = prev.au;
    r.shadowMap.needsUpdate = prev.nu;
    sc.overrideMaterial = prev.ov;
    sc.background = prev.bg;
    sc.fog = prev.fog;
    hidden.forEach((o) => (o.visible = true));

    this.occMat4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    OCC_MAT.elements.set(this.occMat4.elements);
    WX2.x = 0.25 / (OCC_FAR - OCC_NEAR);
    WX2.y = 1;
    this.occInfo.set(1, 0, OCC_TOP, OCC_FAR - OCC_NEAR);
  }

  // ------------------------------------------------------------ rain, snow, splashes

  private updateParticles(_dt: number) {
    const c = this.cur;
    const pm = this.precip.material.uniforms;
    const amount = Math.max(c.rain, c.snow);
    const snow = c.snow > c.rain ? 1 : 0;
    this.precip.visible = amount > 0.005;
    const n = this.counts.drops;
    const active = Math.round(n * Math.min(1, snow ? amount : amount ** 0.8));
    this.precip.geometry.setDrawRange(0, active * 6);
    pm.uCount.value = 1; // the draw range already limits the count
    pm.uCam.value.copy(this.camera.position);
    const hPx = this.renderer.domElement.height || 1080;
    pm.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / hPx;
    pm.uMotion.value.set(this.time, snow ? 1.1 : 9.5, 1 / 30, snow);
    const w = snow ? this.wind.clone().multiplyScalar(0.6) : this.wind.clone().multiplyScalar(0.35);
    pm.uWind.value.copy(w);
    (pm.uBox.value as THREE.Vector3).set(snow ? 15 : 13, snow ? 10 : 9, snow ? 15 : 13);
    const fog = this.scene.fog as THREE.FogExp2 | null;
    const base = fog ? fog.color.clone() : new THREE.Color(0.5, 0.5, 0.5);
    const night = getNight();
    // rain reads as light against dark facades; at night it catches lamp and sign light
    (pm.uColor.value as THREE.Color).copy(base).multiplyScalar(snow ? 1.6 : 1.3).add(new THREE.Color(0.9, 0.8, 0.65).multiplyScalar(0.06 * night));
    pm.uOpacity.value = snow ? 0.95 : 0.45 + 0.3 * c.rain;

    const su = this.splash.material.uniforms;
    // drips keep going for a while after the rain stops
    const drip = Math.min(1, Math.max(c.rain * 1.5, (info.wetness - 0.3) * 1.2));
    this.splash.visible = (c.rain > 0.02 || drip > 0.02) && this.occInfo.x > 0;
    this.splash.geometry.setDrawRange(0, Math.round(this.counts.splashes * Math.min(1, Math.max(c.rain, drip))) * 6);
    su.uDrip.value = drip;
    su.uCam.value.copy(this.camera.position);
    su.uSplash.value.set(this.time, 12, c.rain > 0.02 ? 1 : 0, 2.4);
    (su.uColor.value as THREE.Color).copy(base).multiplyScalar(1.5);
    su.uOpacity.value = 0.45;
  }
}
