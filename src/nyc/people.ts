import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { gltf } from '../detail';
import { FarCrowd } from './peopleFar';
import { Dog, coffeeGeo, handBagGeo, propVcMat, strollerGeo, umbrellaGeo } from './peopleProps';
import { Rng, hashN } from '../rng';
import { CURB, AX, SZ, AVE, ST, SW, CYCLE, lightFor } from './common';
import { walkable } from './districts'; // [districts]
import type { Rect } from '../level';
import { GROUND } from './ground';

/**
 * Pedestrians: skinned, animated people on the sidewalks.
 *
 * Bodies, hair and animations are Quaternius' CC0 "Universal Base Characters" and "Universal
 * Animation Library" (built into public/assets/people/ by scripts/build-people.mjs). Clothing is
 * painted onto the body in the shader from the bind-pose position (shirt/coat, trousers, shoes),
 * with the cloth regions pushed out along the normal so jackets read as a layer over the body.
 * Research: docs/research/people.md.
 */

type Gender = 'male' | 'female';

/** body-space landmarks of each base mesh in its T-pose (metres, +z forward) */
const BODY: Record<Gender, { waist: number; neck: number; shoulderX: number; wristX: number; elbowX: number; ankle: number; knee: number; height: number; armY: number; armZ: number; legX: number; legZ: number }> = {
  male: { waist: 1.0, neck: 1.505, shoulderX: 0.2, wristX: 0.675, elbowX: 0.46, ankle: 0.115, knee: 0.54, height: 1.83, armY: 1.455, armZ: -0.065, legX: 0.114, legZ: -0.036 },
  female: { waist: 0.985, neck: 1.47, shoulderX: 0.15, wristX: 0.61, elbowX: 0.39, ankle: 0.105, knee: 0.53, height: 1.74, armY: 1.418, armZ: -0.054, legX: 0.111, legZ: -0.045 },
};

// ---------------------------------------------------------------- wardrobe (from the reference photos)
const SKIN_TINT = ['#ffffff', '#f4e2d4', '#e6c4a6', '#c99a74', '#a8734e', '#7d5236', '#5c3a26'];
const HAIR = ['#14100c', '#1c1410', '#2a1c12', '#3d2a1a', '#5a3d24', '#8a6a44', '#b89868', '#6b6b6b', '#a8a8a4'];
const COAT = ['#151517', '#1b1d22', '#22262e', '#1d2433', '#2b2f36', '#3a3f45', '#4a4238', '#5b4a36', '#8a6c4a', '#a8865c', '#3b4232', '#4a1f22', '#6b6e72'];
const PUFFER = ['#121214', '#1a1c22', '#1c2638', '#2f3a2a', '#5a1a1c', '#7a7f86', '#c8c4ba', '#1f3d5a'];
const SHIRT = ['#e8e6e0', '#d8d4cc', '#9aa0a8', '#2a2c30', '#6b7a8c', '#a83a32', '#3a5a7a', '#c8b48c', '#7a8a6a', '#e0c0b8'];
const JEANS = ['#1e2a40', '#26344e', '#34486a', '#4a6488', '#6a84a8', '#1a1a1e', '#2a2a30'];
const TROUSERS = ['#1a1a1c', '#2a2c30', '#3a3c42', '#4a4a50', '#5a5040', '#8a7a5a', '#b0a080', '#2a3040'];
const SHOES = ['#121212', '#1a1a1a', '#2a1a12', '#4a2e1c', '#e8e8e4', '#d8d8d4', '#3a3a3e', '#7a5a3a'];

interface Outfit {
  top: string;
  inner: string;
  /** 0 tee, 1 sweater / long sleeve, 2 puffer, 3 open coat, 4 hoodie */
  topStyle: number;
  bottom: string;
  /** 0 jeans, 1 trousers, 2 shorts, 3 leggings */
  bottomStyle: number;
  shoe: string;
  sole: string;
  skin: string;
  hair: string;
  /** knee-length coat skirt (open coats only): extra length below the knee, or -1 */
  coatLen: number;
  /** body type: 0 slim, 1 average, 2 heavier */
  build: number;
}

/** 'cold' (late autumn to early spring: puffers, long coats, beanies) or 'mild' (tees, light
 *  jackets and blazers, shorts). Set with setPeopleSeason() before the crowd spawns, or ?season=mild. */
export type Season = 'cold' | 'mild';
let season: Season = (() => {
  try {
    return new URLSearchParams(location.search).get('season') === 'mild' ? 'mild' : 'cold';
  } catch {
    return 'cold';
  }
})();
/** Rain / snow as the pedestrians see it (0..1 each). src/weather.ts (or anything else) calls
 *  setPeopleWeather(); ?weather=rain|snow sets it for testing. */
export interface PeopleWeather {
  rain: number;
  snow: number;
}
export const peopleWeather: PeopleWeather = (() => {
  try {
    const w = new URLSearchParams(location.search).get('weather');
    return { rain: w === 'rain' ? 1 : 0, snow: w === 'snow' ? 1 : 0 };
  } catch {
    return { rain: 0, snow: 0 };
  }
})();
let weatherVersion = 0;
export function setPeopleWeather(w: Partial<PeopleWeather>) {
  if ((w.rain ?? peopleWeather.rain) === peopleWeather.rain && (w.snow ?? peopleWeather.snow) === peopleWeather.snow) return;
  Object.assign(peopleWeather, w);
  weatherVersion++;
}
export function setPeopleSeason(s: Season) {
  season = s;
}
export function peopleSeason() {
  return season;
}
const SUMMER = ['#f2f0ea', '#e6e2d6', '#c9d6e3', '#9cb4cc', '#2a2c30', '#d8b4a0', '#8fa58a', '#e8d9a8', '#b03a3a', '#3a6a9a', '#f0c8c8', '#5a5a60'];

function pickOutfit(r: Rng, gender: Gender): Outfit {
  const mild = season === 'mild';
  const topStyle = mild ? r.pick([0, 0, 0, 0, 1, 1, 3, 4]) : r.pick([0, 1, 1, 2, 2, 3, 3, 3, 4]);
  const top = topStyle === 2 ? r.pick(PUFFER) : topStyle === 3 ? r.pick(COAT) : topStyle === 4 ? r.pick([...COAT, '#7a7f86', '#8a2a2a']) : r.pick(mild ? SUMMER : SHIRT);
  const bottomStyle = mild
    ? gender === 'female' ? r.pick([0, 0, 1, 2, 3]) : r.pick([0, 0, 1, 1, 2, 2])
    : gender === 'female' ? r.pick([0, 0, 1, 3, 3]) : r.pick([0, 0, 0, 1, 1, topStyle === 0 ? 2 : 1]);
  // re-pick trousers that would read as a onesie with the top (same hue and brightness)
  const near = (a: string, b: string) => {
    const ca = new THREE.Color(a), cb = new THREE.Color(b);
    return Math.abs(ca.r - cb.r) + Math.abs(ca.g - cb.g) + Math.abs(ca.b - cb.b) < 0.12;
  };
  let bottom = '';
  for (let i = 0; i < 6 && (!bottom || near(bottom, top)); i++)
    bottom = bottomStyle === 0 ? r.pick(JEANS) : bottomStyle === 3 ? r.pick(['#111113', '#18181a', '#2a2a2e']) : r.pick(TROUSERS);
  const shoe = r.pick(SHOES);
  const light = shoe === '#e8e8e4' || shoe === '#d8d8d4';
  return {
    top, topStyle, bottom, bottomStyle, shoe,
    inner: r.pick(SHIRT),
    sole: light || r.chance(0.4) ? '#ecebe6' : '#1a1a1a',
    skin: r.pick(SKIN_TINT),
    hair: r.pick(HAIR),
    build: r.pick([0, 0, 0, 1, 1, 1, 1, 2, 2, 2]),
    coatLen: topStyle === 3 && !mild && r.chance(0.65) ? r.pick([0.0, 0.08, 0.15]) : -1,
  };
}

// ---------------------------------------------------------------- shader: clothes painted on the skinned body
const REGION_GLSL = /* glsl */ `
uniform mat4 uGeo, uGeoInv;
uniform float uGeoScale;
uniform vec4 uSlimA; // arm thickness factor, arm axis y, arm axis z, shoulder |x|
uniform vec4 uSlimB; // leg thickness factor, leg axis |x|, shoulder pull-in (m), leg axis z
uniform vec4 uSlimC; // (unused), neck y
uniform vec4 uShape;  // arm radius at the shoulder, thigh radius, hip half-width, smoothing on bare skin
uniform vec4 uShape2; // chest half-width, hip half-depth, chest half-depth
uniform vec4 uB2;     // wrist |x|
uniform vec4 uCut;   // waist y, neckline y, sleeve end |x|, trouser hem y
uniform vec4 uBody;  // shoulder |x|, ankle y, jacket bottom y, top style
uniform vec4 uInfl;  // top, bottom, shoes, bottom style
// 0 skin, 1 top, 2 bottom, 3 shoes
float pedRegion(vec3 p) {
  float ax = abs(p.x);
  if (ax > uBody.x && p.y > uCut.x + 0.25) return ax < uCut.z ? 1.0 : 0.0;   // arm (T-pose)
  if (p.y < uBody.y) return 3.0;
  float neck = uCut.y - (uBody.w > 2.5 && uBody.w < 3.5 ? 0.07 : 0.035) * smoothstep(0.0, 0.07, p.z) * (1.0 - smoothstep(0.05, 0.1, ax)) + 0.6 * max(0.0, ax - 0.07);
  if (p.y > uCut.x) return p.y < neck ? 1.0 : 0.0;
  if (p.y > uBody.z && ax < 0.24 && uBody.w > 1.5) return 1.0;               // jacket hangs over the hips
  return p.y > uCut.w ? 2.0 : 0.0;
}
`;

function bodyMaterial(base: THREE.MeshStandardMaterial, o: Outfit, g: Gender, geo: THREE.Matrix4, geoScale: number, r: Rng) {
  const m = base.clone();
  // ordinary proportions (m): arm radius at the shoulder, thigh radius, hip half-width, chest
  // half-width, hip half-depth, chest half-depth; scaled per body type (slim / average / heavier)
  const base6 = g === 'male' ? [0.05, 0.083, 0.165, 0.168, 0.108, 0.118] : [0.044, 0.086, 0.178, 0.148, 0.112, 0.122];
  const mul = o.build === 0 ? [0.9, 0.92, 0.93, 0.92, 0.9, 0.9] : o.build === 2 ? [1.15, 1.1, 1.12, 1.1, 1.32, 1.22] : [1, 1, 1, 1, 1, 1];
  const sh = base6.map((v, i) => v * mul[i]);
  const j = () => r.range(0.96, 1.04);
  // soften the sculpted muscle relief of the skin (women most)
  m.normalScale.multiplyScalar(g === 'female' ? 0.3 : 0.6);
  const b = BODY[g];
  const sleeve = o.topStyle === 0 ? b.shoulderX + 0.13 : b.wristX - 0.035;
  const hem = o.bottomStyle === 2 ? b.knee + 0.07 : b.ankle;
  const neck = b.neck + (o.topStyle === 2 || o.topStyle === 4 ? 0.035 : o.topStyle === 3 ? 0.02 : 0);
  const infl = [[0.006, 0.014, 0.034, 0.02, 0.018][o.topStyle], [0.007, 0.008, 0.007, 0.002][o.bottomStyle], 0.02];
  const u = {
    uGeo: { value: geo },
    uGeoScale: { value: geoScale },
    uGeoInv: { value: geo.clone().invert() },
    uSlimA: { value: new THREE.Vector4(g === 'female' ? r.range(0.7, 0.8) : r.range(0.74, 0.88), b.armY, b.armZ, b.shoulderX) },
    uSlimB: { value: new THREE.Vector4(0, b.legX, g === 'male' ? r.range(0.03, 0.05) : r.range(0.0, 0.012), b.legZ) },
    uSlimC: { value: new THREE.Vector4(0, b.neck, 0, 0) },
    uShape: { value: new THREE.Vector4(sh[0] * j(), sh[1] * j(), sh[2] * j(), 0.65) },
    uShape2: { value: new THREE.Vector4(sh[3] * j(), sh[4] * j(), sh[5] * j(), 0) },
    uB2: { value: new THREE.Vector4(b.wristX, 0, 0, 0) },
    uCut: { value: new THREE.Vector4(b.waist, neck, sleeve, hem) },
    uBody: { value: new THREE.Vector4(b.shoulderX, b.ankle, o.topStyle === 2 ? b.waist - 0.1 : b.waist - 0.06, o.topStyle) },
    uInfl: { value: new THREE.Vector4(infl[0], infl[1], infl[2], o.bottomStyle) },
    uTop: { value: new THREE.Color(o.top) },
    uInner: { value: new THREE.Color(o.inner) },
    uBottom: { value: new THREE.Color(o.bottom) },
    uShoe: { value: new THREE.Color(o.shoe) },
    uSole: { value: new THREE.Color(o.sole) },
    uSkin: { value: new THREE.Color(o.skin) },
  };
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\n${REGION_GLSL}\nvarying vec3 vBody;`)
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        // ---- pedestrian shape, in bind (body) space before skinning. The base meshes are
        // bodybuilders: limbs become smooth tubes and the torso a smooth ellipse of ordinary
        // proportions (per body type), fully under clothes and partly on bare skin, and the
        // normals follow the smoothed shape so no muscle relief shows through.
        vBody = (uGeo * vec4(position, 1.0)).xyz;
        vec3 bp = vBody;
        vec3 bn = normalize(mat3(uGeo) * objectNormal);
        float bax = abs(bp.x);
        float pr = pedRegion(vBody);
        float clothed = (pr > 0.5 && pr < 2.5) ? 1.0 : 0.0;
        float k = mix(uShape.w, 1.0, clothed);
        float waist = uCut.x, neckY = uSlimC.y;
        float wa = smoothstep(uSlimA.w - 0.03, uSlimA.w + 0.06, bax) * smoothstep(waist + 0.15, waist + 0.25, bp.y);
        float wl = (1.0 - smoothstep(waist - 0.16, waist - 0.04, bp.y)) * step(uBody.y + 0.01, bp.y);
        // up to the neck line on the shoulders (trapezius / deltoid tops), stopping short at the neck column
        float top = mix(neckY - 0.01, neckY + 0.05, smoothstep(0.06, 0.11, bax));
        float wt = (1.0 - wa) * (1.0 - wl) * smoothstep(waist - 0.22, waist - 0.06, bp.y) * (1.0 - smoothstep(top - 0.07, top, bp.y));
        // arms: a tube around the T-pose arm axis, tapering to the wrist (hands untouched)
        {
          float f = smoothstep(uSlimA.w, uB2.x, bax);
          float rt = mix(uShape.x, uShape.x * 0.62, f);
          vec2 d = bp.yz - uSlimA.yz;
          vec2 dir = d / max(length(d), 1e-4);
          float kk = wa * k * (1.0 - smoothstep(uB2.x - 0.05, uB2.x - 0.01, bax));
          bp.yz = mix(bp.yz, uSlimA.yz + dir * rt, kk);
          bn = normalize(mix(bn, vec3(0.0, dir), kk));
        }
        // legs: a tube around each leg axis, thigh to ankle
        {
          vec2 lc = vec2(sign(bp.x) * uSlimB.y, uSlimB.w);
          float f = smoothstep(waist - 0.1, uBody.y + 0.05, bp.y);
          float rt = mix(uShape.y, uShape.y * 0.55, f);
          vec2 d = bp.xz - lc;
          vec2 dir = d / max(length(d), 1e-4);
          float kk = wl * k * smoothstep(0.0, 0.05, bax);
          bp.xz = mix(bp.xz, lc + dir * rt, kk);
          bn = normalize(mix(bn, vec3(dir.x, 0.0, dir.y), kk));
        }
        // torso: an ellipse from the hips to the chest
        {
          float hgt = smoothstep(waist - 0.1, waist + 0.3, bp.y);
          vec2 R = vec2(mix(uShape.z, uShape2.x, hgt), mix(uShape2.y, uShape2.z, hgt));
          // shoulders slope in towards the neck
          R.x *= 1.0 - 0.3 * smoothstep(neckY - 0.12, neckY + 0.04, bp.y);
          R.y *= 1.0 - 0.25 * smoothstep(neckY - 0.1, neckY + 0.04, bp.y);
          vec2 c = vec2(0.0, -0.02);
          vec2 e = (bp.xz - c) / R;
          vec2 dir = e / max(length(e), 1e-4);
          float kk = wt * k;
          bp.xz = mix(bp.xz, c + dir * R, kk);
          vec2 nn = normalize(dir / R);
          bn = normalize(mix(bn, vec3(nn.x, 0.0, nn.y), kk));
        }
        // narrower shoulders: arms move in a little
        bp.x -= sign(bp.x) * uSlimB.z * smoothstep(0.04, uSlimA.w + 0.04, bax) * smoothstep(waist + 0.05, waist + 0.2, bp.y);
        // thinner neck and lower trapezius
        float wn = smoothstep(neckY - 0.14, neckY - 0.06, bp.y) * (1.0 - smoothstep(neckY + 0.03, neckY + 0.1, bp.y)) * (1.0 - smoothstep(0.07, 0.12, bax));
        bp.xz = vec2(0.0, -0.035) + (bp.xz - vec2(0.0, -0.035)) * mix(1.0, 0.86, wn);
        bp.y -= 0.03 * smoothstep(neckY - 0.16, neckY - 0.04, bp.y) * smoothstep(0.05, 0.1, bax) * (1.0 - smoothstep(uSlimA.w - 0.02, uSlimA.w + 0.04, bax)) * (1.0 - smoothstep(neckY, neckY + 0.06, bp.y));
        // bare feet shrink inside the shoe meshes riding the foot bones
        float wf = 1.0 - smoothstep(uBody.y - 0.03, uBody.y + 0.005, bp.y);
        vec3 fc = vec3(sign(bp.x) * uSlimB.y, 0.045, 0.0);
        bp = mix(bp, fc + (bp - fc) * vec3(0.75, 0.8, 0.85), wf);
        // clothing bulk along the smoothed normal
        float inf = pr == 1.0 ? uInfl.x : pr == 2.0 ? uInfl.y : pr == 3.0 ? uInfl.z : 0.0;
        bp += bn * inf;
        vec3 pedPos = (uGeoInv * vec4(bp, 1.0)).xyz;
        objectNormal = normalize(mat3(uGeoInv) * bn);`,
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = pedPos;');
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${REGION_GLSL}\nvarying vec3 vBody;
        uniform vec3 uTop, uInner, uBottom, uShoe, uSole, uSkin;
        float pedHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float pedNoise(vec3 x) {
          vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(pedHash(i), pedHash(i + vec3(1,0,0)), f.x), mix(pedHash(i + vec3(0,1,0)), pedHash(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(pedHash(i + vec3(0,0,1)), pedHash(i + vec3(1,0,1)), f.x), mix(pedHash(i + vec3(0,1,1)), pedHash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float pr = pedRegion(vBody);
        float cloth = pr > 0.5 ? 1.0 : 0.0;
        float clothRough = 0.88;
        if (pr < 0.5) {
          // skin: the tint, a little blotchy variation, warmer cheeks / nose / ears
          diffuseColor.rgb *= uSkin * (0.95 + 0.1 * pedNoise(vBody * 28.0));
          float face = smoothstep(0.03, 0.09, vBody.z) * smoothstep(uSlimC.y + 0.06, uSlimC.y + 0.12, vBody.y) * (1.0 - smoothstep(uSlimC.y + 0.19, uSlimC.y + 0.25, vBody.y));
          diffuseColor.rgb *= mix(vec3(1.0), vec3(1.06, 0.95, 0.92), face * 0.7);
        }
        else {
          vec3 c = pr == 1.0 ? uTop : pr == 2.0 ? uBottom : uShoe;
          float st = uBody.w;
          float ax = abs(vBody.x);
          if (pr == 1.0) {
            bool arm = ax > uBody.x && vBody.y > uCut.x + 0.25;
            if (st > 1.5 && st < 2.5) {            // puffer: quilted baffles, satin nylon
              float q = arm ? ax * 11.0 : vBody.y * 9.0;
              float d = abs(fract(q) - 0.5) * 2.0;
              c *= 0.72 + 0.32 * smoothstep(0.0, 0.55, d);
              clothRough = 0.42;
            } else if (st > 2.5 && st < 3.5) {     // open coat: shirt shows down the front
              if (!arm && vBody.z > 0.02 && ax < 0.012 + 0.055 * smoothstep(uCut.x + 0.18, uCut.y, vBody.y) && vBody.y > uCut.x + 0.12) c = uInner;
              else if (!arm && vBody.z > 0.02 && ax < 0.008) c *= 0.6;   // closure line
              if (!arm && vBody.y < uCut.x + 0.02 && vBody.y > uCut.x - 0.01) c *= 0.7;
              clothRough = 0.8;
            } else if (st > 3.5) {                  // hoodie: kangaroo pocket seam + hood bulk at the neck
              if (!arm && vBody.z > 0.06 && vBody.y > uCut.x + 0.05 && vBody.y < uCut.x + 0.2 && ax < 0.13) c *= 0.88;
            }
            if (arm && ax > uCut.z - 0.03) c *= 0.85;                      // cuffs
            if (!arm && vBody.y < uBody.z + 0.035 && vBody.y > uBody.z - 0.04) c *= 0.85;   // hem band
          } else if (pr == 2.0) {
            float bs = uInfl.w;
            if (vBody.y > uCut.x - 0.04) c *= bs > 2.5 ? 0.9 : 0.55;      // waistband / belt
            if (bs < 0.5) {                          // denim: twill + fading on the thighs
              c *= 0.92 + 0.12 * pedNoise(vec3(vBody.x * 90.0 + vBody.y * 90.0, vBody.y * 6.0, vBody.z * 90.0));
              c *= 1.0 + 0.22 * smoothstep(0.2, 0.0, abs(vBody.y - 0.72)) * step(0.0, vBody.z);
            }
            if (bs > 2.5) clothRough = 0.6;
          } else {
            if (vBody.y < 0.028) c = uSole;
            clothRough = 0.55;
          }
          c *= 0.93 + 0.1 * pedNoise(vBody * 60.0);
          diffuseColor.rgb = c;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, clothRough, cloth);')
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nvec3 pedGeoNormal = normal;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(mix(normal, pedGeoNormal, cloth));');
  };
  m.customProgramCacheKey = () => 'ped-body-v6';
  return m;
}

// ---------------------------------------------------------------- assets
interface BodyAsset {
  scene: THREE.Object3D;
  base: THREE.MeshStandardMaterial;
  hairBase: THREE.MeshStandardMaterial;
  geo: THREE.Matrix4;
  geoInv: THREE.Matrix4;
  geoScale: number;
  /** inverse bind-pose world matrix of each bone, to attach props built in body space */
  bindInv: Map<string, THREE.Matrix4>;
  clips: Map<string, THREE.AnimationClip>;
}
interface PeopleAssets {
  body: Record<Gender, BodyAsset>;
  hair: Map<string, { geo: THREE.BufferGeometry; matrix: THREE.Matrix4; mat: THREE.MeshStandardMaterial }>;
}
let assetsP: Promise<PeopleAssets> | null = null;

export function loadPeopleAssets(): Promise<PeopleAssets> {
  if (assetsP) return assetsP;
  const base = `${import.meta.env.BASE_URL}assets/people/`;
  const load = (f: string) => gltf()!.loadAsync(base + f);
  assetsP = Promise.all([load('male.glb'), load('female.glb'), load('hair.glb'), load('anims.glb')]).then(([male, female, hair, anims]) => {
    anims.scene.updateMatrixWorld(true);
    const animPelvis = anims.scene.getObjectByName('pelvis')!.position.clone();
    const body = {} as Record<Gender, BodyAsset>;
    for (const [g, gl] of [['male', male], ['female', female]] as const) {
      const scene = gl.scene;
      scene.updateMatrixWorld(true);
      let skinned: THREE.SkinnedMesh | null = null, hairBase: THREE.MeshStandardMaterial | null = null;
      scene.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (!m.isSkinnedMesh) return;
        const mat = m.material as THREE.MeshStandardMaterial;
        if (/Superhero/i.test(mat.name) && !/Body_LOD/.test(m.name)) skinned = m;
        if (/Hair/i.test(mat.name)) hairBase = mat;
      });
      const sk = skinned as unknown as THREE.SkinnedMesh;
      // geometry -> body space at the bind pose. Quantization (meshopt) is folded into the inverse
      // bind matrices for skinned meshes, so go through the skin rather than the node transform.
      const b0 = sk.skeleton.bones[0];
      const geo = sk.matrixWorld.clone().multiply(sk.bindMatrixInverse).multiply(b0.matrixWorld).multiply(sk.skeleton.boneInverses[0]).multiply(sk.bindMatrix);
      const geoScale = new THREE.Vector3().setFromMatrixScale(geo).x;
      const bindInv = new Map<string, THREE.Matrix4>();
      scene.traverse((o) => {
        if ((o as THREE.Bone).isBone) bindInv.set(o.name, o.matrixWorld.clone().invert());
      });
      // the clips were authored on the UAL mannequin: shift the pelvis track to this body's hip height
      const pelvis = scene.getObjectByName('pelvis')!.position;
      const d = pelvis.clone().sub(animPelvis);
      const clips = new Map<string, THREE.AnimationClip>();
      for (const c of anims.animations) {
        const cc = c.clone();
        for (const t of cc.tracks) {
          if (t.name === 'pelvis.position') {
            const v = t.values;
            for (let i = 0; i < v.length; i += 3) {
              v[i] += d.x;
              v[i + 1] += d.y;
              v[i + 2] += d.z;
            }
          }
        }
        cc.tracks = cc.tracks.filter((t) => !/^root\./.test(t.name));
        clips.set(c.name, cc);
      }
      body[g] = { scene, base: sk.material as THREE.MeshStandardMaterial, hairBase: hairBase!, geo, geoInv: geo.clone().invert(), geoScale, bindInv, clips };
    }
    const hairMap: PeopleAssets['hair'] = new Map();
    hair.scene.updateMatrixWorld(true);
    hair.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      let name = m.name;
      for (let p: THREE.Object3D | null = m; p; p = p.parent) if (/^Hair_/.test(p.name)) name = p.name;
      hairMap.set(name, { geo: m.geometry, matrix: m.matrixWorld.clone(), mat: m.material as THREE.MeshStandardMaterial });
    });
    return { body, hair: hairMap };
  });
  return assetsP;
}

// ---------------------------------------------------------------- props
const propGeo = {
  backpack: new RoundedBoxGeometry(0.3, 0.42, 0.15, 3, 0.045),
  strap: new THREE.BoxGeometry(0.045, 0.2, 0.012),
  crossbody: new RoundedBoxGeometry(0.22, 0.16, 0.07, 2, 0.02),
  tote: new RoundedBoxGeometry(0.36, 0.34, 0.1, 2, 0.015),
  phone: new RoundedBoxGeometry(0.075, 0.155, 0.009, 2, 0.006),
  beanie: knitBeanie(),
  cap: baseballCap(),
  hood: new THREE.SphereGeometry(0.13, 18, 10, Math.PI, Math.PI, 0, Math.PI * 0.62),
  // a raised hood: a shell over the head, open at the face (+z)
  hoodUp: new THREE.SphereGeometry(0.13, 18, 10, Math.PI / 2 + 0.55, Math.PI * 2 - 1.1, 0, Math.PI * 0.62),
  scarf: new THREE.TorusGeometry(0.075, 0.032, 8, 18).rotateX(Math.PI / 2),
};
/** a sneaker / boot: low toe box, higher heel collar, separate sole; colours baked into vertex
 *  colours so one shoe is one draw call. Built around the origin, toe toward +z. */
const shoeGeos = new Map<string, THREE.BufferGeometry>();
function shoeGeo(upper: string, sole: string, len: number, boot: boolean) {
  const k = `${upper}|${sole}|${len}|${boot}`;
  let g = shoeGeos.get(k);
  if (g) return g;
  const up = new THREE.SphereGeometry(1, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = up.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const zz = z * len * 0.5;
    const front = THREE.MathUtils.smoothstep(zz, -0.04, len * 0.45);
    const h = boot ? THREE.MathUtils.lerp(0.17, 0.07, front) : THREE.MathUtils.lerp(0.105, 0.055, front);
    p.setXYZ(i, x * 0.05 * (1 - 0.15 * Math.max(0, -z)), 0.02 + y * h, zz);
  }
  up.computeVertexNormals();
  const so = new RoundedBoxGeometry(0.104, 0.026, len + 0.012, 2, 0.01);
  so.translate(0, 0.013, 0);
  const paint = (geo: THREE.BufferGeometry, c: string) => {
    const col = new THREE.Color(c);
    const n = geo.attributes.position.count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.toArray(a, i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return geo;
  };
  g = mergeGeometries([paint(up.toNonIndexed(), upper), paint(so.index ? so.toNonIndexed() : so, sole)])!;
  shoeGeos.set(k, g);
  return g;
}
const UMBRELLA = ['#111113', '#111113', '#111113', '#16161a', '#1c2638', '#5a1a1c', '#1f3d5a', '#2f3a2a', '#c8282e', '#e8d23a', '#3a3a3e'];
const SNOWHAT = ['#151515', '#2a2a2e', '#4a1f22', '#c8c4ba', '#1f3d5a', '#5a5a5a', '#8a6c4a', '#b03a3a'];
const SCARF = ['#7a1d1d', '#2a2c30', '#c8b48c', '#1f3d5a', '#3b4232', '#8a8a86', '#b8282e', '#e0d8c8'];
const umbrellaMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide });
const clothMats2 = new Map<string, THREE.MeshStandardMaterial>();
function clothMatFor(c: THREE.Color) {
  const k = c.getHexString();
  let m = clothMats2.get(k);
  if (!m) clothMats2.set(k, (m = new THREE.MeshStandardMaterial({ color: c.clone(), roughness: 0.85, side: THREE.DoubleSide })));
  return m;
}
const leashMat = new THREE.LineBasicMaterial({ color: '#1a1a1a' });

/** the lower half of a long coat: an elliptical skirt from the waist to below the knee, skinned
 *  to pelvis + both thighs so it swings with the legs and stretches between them */
const skirtGeos = new Map<string, THREE.BufferGeometry>();
function coatSkirtGeo(g: Gender, len: number) {
  const k = `${g}|${len}`;
  let geo = skirtGeos.get(k);
  if (geo) return geo;
  const b = BODY[g];
  const top = b.waist - 0.02, bot = b.knee - len;
  const seg = 20, rows = 6;
  const pos: number[] = [], idx: number[] = [], si: number[] = [], sw: number[] = [];
  const [rx0, rz0, rx1, rz1, cz] = g === 'male' ? [0.19, 0.155, 0.25, 0.22, -0.035] : [0.195, 0.16, 0.255, 0.225, -0.04];
  for (let j = 0; j <= rows; j++) {
    const h = j / rows;
    const y = THREE.MathUtils.lerp(top, bot, h);
    const ease = Math.sin((h * Math.PI) / 2);
    const rx = THREE.MathUtils.lerp(rx0, rx1, ease), rz = THREE.MathUtils.lerp(rz0, rz1, ease);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const x = Math.sin(a) * rx, z = cz + Math.cos(a) * rz;
      pos.push(x, y, z);
      // bones: 0 pelvis, 1 thigh_l (+x), 2 thigh_r (-x)
      const pw = Math.pow(1 - h, 2.5);
      const left = THREE.MathUtils.clamp(0.5 + (x / rx) * 0.9, 0, 1);
      si.push(0, 1, 2, 0);
      sw.push(pw, (1 - pw) * left, (1 - pw) * (1 - left), 0);
    }
  }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, c = a + seg + 1;
      idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  skirtGeos.set(k, geo);
  return geo;
}
/** screen-door crossfade: discard where the 4x4 Bayer threshold is above the fade value (the
 *  far crowd keeps exactly the complementary pixels) */
export const BAYER_GLSL = /* glsl */ `
float pedBayer(vec2 p) {
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0;
}`;
const dithered = new WeakSet<THREE.Material>();
function addDither(mat: THREE.Material, fade: { value: number }) {
  if (dithered.has(mat) || !(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
  dithered.add(mat);
  const prev = mat.onBeforeCompile.bind(mat);
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (s, r) => {
    prev(s, r);
    s.uniforms.uPedFade = fade;
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uPedFade;\n${BAYER_GLSL}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (uPedFade < 1.0 && pedBayer(gl_FragCoord.xy) > uPedFade) discard;');
  };
  mat.customProgramCacheKey = () => prevKey() + '|pedfade';
  mat.needsUpdate = true;
}
interface RigidPart {
  geo: THREE.BufferGeometry;
  bone: string;
  /** body (bind-pose) space placement */
  m: THREE.Matrix4;
  /** flat colour, unless the geometry has vertex colours */
  color?: string;
}
const propsMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
/** one skinned geometry from rigid parts (100 % on their bone) plus an optional coat skirt
 *  (whose skinIndex 0/1/2 = pelvis/thigh_l/thigh_r); vertices in body space */
function mergeParts(parts: RigidPart[], names: string[], skirt: THREE.BufferGeometry | null, skirtColor: string) {
  const out: THREE.BufferGeometry[] = [];
  const prep = (src: THREE.BufferGeometry, color: string | undefined) => {
    const g = src.index ? src.toNonIndexed() : src.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'skinIndex', 'skinWeight'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    if (!g.attributes.color) {
      const c = new THREE.Color(color ?? '#808080'), a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) c.toArray(a, i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    }
    return g;
  };
  for (const p of parts) {
    const g = prep(p.geo, p.color);
    g.applyMatrix4(p.m);
    const n = g.attributes.position.count, bi = names.indexOf(p.bone);
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      si[i * 4] = bi;
      sw[i * 4] = 1;
    }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    out.push(g);
  }
  if (skirt) {
    const g = prep(skirt, skirtColor);
    const map = ['pelvis', 'thigh_l', 'thigh_r'].map((n) => names.indexOf(n));
    const si = g.attributes.skinIndex as THREE.BufferAttribute;
    const nsi = new Uint16Array(si.count * 4);
    for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) nsi[i * 4 + k] = map[si.getComponent(i, k)] ?? 0;
    g.setAttribute('skinIndex', new THREE.BufferAttribute(nsi, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array((g.attributes.skinWeight as THREE.BufferAttribute).array), 4));
    out.push(g);
  }
  if (!out.length) {
    // nothing to carry: an empty geometry with the right attributes
    const g = new THREE.BufferGeometry();
    for (const [k, n] of [['position', 3], ['normal', 3], ['color', 3], ['skinWeight', 4]] as const) g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(0), n));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(0), 4));
    return g;
  }
  return mergeGeometries(out)!;
}
/** lathe a (radius, height) profile around y with radial ribs: `ribs` bumps of `amp` (fraction of r) */
function lathe(profile: [number, number][], seg: number, ribs = 0, amp = 0) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(pts, seg);
  if (ribs) {
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const a = Math.atan2(z, x), k = 1 + amp * Math.cos(a * ribs);
      p.setX(i, x * k);
      p.setZ(i, z * k);
    }
  }
  g.computeVertexNormals();
  return g;
}
/** a snug knit beanie, rim at the origin (unit-ish: radius 1 at the rim, ~1.3 tall), with a
 *  folded, ribbed cuff and a slight slouch toward the back */
function knitBeanie() {
  const body = lathe([[1.0, 0], [1.01, 0.3], [0.99, 0.55], [0.93, 0.8], [0.8, 1.02], [0.6, 1.18], [0.34, 1.28], [0.0, 1.31]], 40, 40, 0.012);
  // slouch: the crown drifts back
  const p = body.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) - 0.12 * Math.max(0, p.getY(i) - 0.6) ** 2);
  body.computeVertexNormals();
  const cuff = lathe([[0.99, -0.04], [1.075, -0.02], [1.09, 0.2], [1.075, 0.4], [1.0, 0.43]], 40, 40, 0.03);
  return mergeGeometries([body.toNonIndexed(), cuff.toNonIndexed()])!;
}
/** a baseball cap: a low crown (rim at the origin) and a curved brim to the front (+z) */
function baseballCap() {
  const crown = lathe([[1.0, 0], [1.0, 0.35], [0.92, 0.65], [0.72, 0.9], [0.4, 1.04], [0.0, 1.08]], 32);
  const brim = new THREE.CircleGeometry(0.95, 20, 0, Math.PI);
  brim.rotateX(-Math.PI / 2);
  const bp = brim.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < bp.count; i++) {
    const x = bp.getX(i), z = -bp.getZ(i);
    bp.setXYZ(i, x * 0.95, 0.06 - 0.25 * x * x - 0.1 * z, 0.82 + z * 0.85);
  }
  brim.computeVertexNormals();
  return mergeGeometries([crown.toNonIndexed(), brim.toNonIndexed()])!;
}
/** where a hat sits: rim centre (body space), rim half-width / half-depth, tilt (front up) */
const HAT_FIT: Record<Gender, { y: number; z: number; rx: number; rz: number }> = {
  male: { y: 1.738, z: -0.014, rx: 0.087, rz: 0.104 },
  female: { y: 1.684, z: -0.014, rx: 0.083, rz: 0.1 },
};
function hatMatrix(g: Gender, kind: 'beanie' | 'cap') {
  const f = HAT_FIT[g];
  const h = kind === 'beanie' ? 0.085 : 0.075;
  return new THREE.Matrix4()
    .compose(new THREE.Vector3(0, f.y, f.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(kind === 'beanie' ? -0.32 : -0.18, 0, 0)), new THREE.Vector3(1, 1, 1))
    .multiply(new THREE.Matrix4().makeScale(f.rx, h, f.rz));
}
const propMats = new Map<string, THREE.MeshStandardMaterial>();
function propMat(color: string, rough = 0.8) {
  const k = `${color}|${rough}`;
  let m = propMats.get(k);
  if (!m) propMats.set(k, (m = new THREE.MeshStandardMaterial({ color, roughness: rough })));
  return m;
}
/** iris tints (multiplying the brown eye texture): the stock eyes read as glowing pale discs */
const EYES = ['#8a7468', '#6e5a50', '#5a4a44', '#8a7468', '#7a8494', '#7a8a72'];
const eyeMats = new Map<string, THREE.MeshStandardMaterial>();
function eyeMat(base: THREE.MeshStandardMaterial, i: number) {
  const k = `${base.uuid}|${i}`;
  let m = eyeMats.get(k);
  if (!m) {
    m = base.clone();
    m.color.set(EYES[i]);
    m.roughness = 0.3;
    m.envMapIntensity = 0.5;
    eyeMats.set(k, m);
  }
  return m;
}
const hairMats = new Map<string, THREE.MeshStandardMaterial>();
function hairMat(base: THREE.MeshStandardMaterial, color: string) {
  const k = `${base.uuid}|${color}`;
  let m = hairMats.get(k);
  if (!m) {
    m = base.clone();
    m.color.set(color);
    m.roughness = 0.75;
    hairMats.set(k, m);
  }
  return m;
}

// ---------------------------------------------------------------- one person
export type Activity = 'walk' | 'idle' | 'phone' | 'talk';
export class Person {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions = new Map<string, THREE.AnimationAction>();
  bones = new Map<string, THREE.Bone>();
  meshes: THREE.Mesh[] = [];
  activity: Activity = 'walk';
  private phone: THREE.Object3D | null = null;
  private lodMesh: THREE.Mesh | null = null;
  private fullMesh: THREE.Mesh | null = null;
  private faceMeshes: THREE.Mesh[] = [];
  /** small parts hidden on far people (shoes, straps, cups...) */
  private detail: THREE.Object3D[] = [];
  private lod = 0;
  /** 0: full body; 1: ~2.5k-triangle body, no eyes/brows */
  setLod(l: number) {
    if (l === this.lod || !this.lodMesh || !this.fullMesh) return;
    this.lod = l;
    this.lodMesh.visible = l === 1;
    this.fullMesh.visible = l === 0;
    for (const m of this.faceMeshes) m.visible = l === 0;
    for (const m of this.detail) m.visible = l === 0;
  }
  constructor(public assets: PeopleAssets, r: Rng, public gender: Gender = r.chance(0.5) ? 'male' : 'female') {
    const A = assets.body[gender];
    const model = skeletonClone(A.scene);
    this.root = new THREE.Group();
    this.root.add(model);
    const o = pickOutfit(r, gender);
    this.slow = r.chance(0.1);
    this.walkSpeed = this.slow ? r.range(0.8, 1.0) : r.range(1.15, 1.5);
    if (this.slow) o.hair = r.pick(['#8a8a86', '#b0aea8', '#d0cec8', '#6b6b6b']);
    const hm = hairMat(A.hairBase, o.hair);
    const bm = bodyMaterial(A.base, o, gender, A.geo, A.geoScale, r);
    model.traverse((x) => {
      if ((x as THREE.Bone).isBone) this.bones.set(x.name, x as THREE.Bone);
      const m = x as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      const name = (m.material as THREE.Material).name;
      if (/Superhero/i.test(name)) m.material = bm;
      else if (/Hair/i.test(name)) m.material = hm;
      else if (/Eye/i.test(name)) m.material = eyeMat(m.material as THREE.MeshStandardMaterial, r.int(0, EYES.length - 1));
      if (/Body_LOD/.test(m.name)) {
        this.lodMesh = m;
        m.visible = false;
      } else if (/Superhero/i.test(name)) this.fullMesh = m;
      else this.faceMeshes.push(m);
      // a fixed, generous bounds: the lazily computed skinned bounds can be taken mid-update
      m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.3);
      this.meshes.push(m);
    });
    // hair (static meshes riding the head bone)
    const styles = gender === 'male' ? ['Hair_SimpleParted', 'Hair_SimpleParted', 'Hair_Buzzed', 'Hair_Buzzed', ''] : ['Hair_Long', 'Hair_Long', 'Hair_Buns', 'Hair_BuzzedFemale'];
    const style = r.pick(styles);
    const head = this.bones.get('Head')!;
    const attach = (bone: string, obj: THREE.Object3D, bodyMatrix: THREE.Matrix4) => {
      obj.matrixAutoUpdate = false;
      obj.matrix.multiplyMatrices(A.bindInv.get(bone)!, bodyMatrix);
      this.bones.get(bone)!.add(obj);
      if ((obj as THREE.Mesh).isMesh) this.meshes.push(obj as THREE.Mesh);
      return obj;
    };
    const hat = r.chance(season === 'mild' ? 0.15 : 0.28);
    this.hasHat = hat;
    this.weatherRoll = r.next();
    this.bindInvOf = (bone) => A.bindInv.get(bone)!;
    if (style && !hat) {
      const h = assets.hair.get(style);
      if (h) this.hairMesh = attach('Head', new THREE.Mesh(h.geo, hm), h.matrix) as THREE.Mesh;
      this.longHair = style === 'Hair_Long';
    }
    if (gender === 'male' && r.chance(0.25)) {
      const h = assets.hair.get('Hair_Beard');
      if (h) attach('Head', new THREE.Mesh(h.geo, hm), h.matrix);
    }
    void head;
    const b = BODY[gender];
    const at = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
      new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
    // far-crowd look (painted hair: -1 bald, 0 short / hat, 1 long)
    const b0 = BODY[gender];
    this.far = {
      top: new THREE.Color(o.top), bottom: new THREE.Color(o.bottom), shoe: new THREE.Color(o.shoe), skin: new THREE.Color(o.skin), hair: new THREE.Color(o.hair),
      style: new THREE.Vector4(o.topStyle, o.topStyle === 0 ? b0.shoulderX + 0.13 : b0.wristX - 0.035, o.bottomStyle === 2 ? b0.knee + 0.07 : b0.ankle, hat ? 0 : style === 'Hair_Long' ? 1 : style ? 0 : -1),
      coat: o.coatLen >= 0 ? b0.knee - o.coatLen : -1,
    };
    // rigid props (hat, bags, hood, shoes) and the coat skirt are merged into ONE skinned mesh
    // per person: rigid parts are weighted 100 % to their bone, the skirt keeps its blend
    const parts: RigidPart[] = [];
    if (hat) {
      // cold: mostly knit beanies, some caps; mild: mostly caps
      const cap = r.chance(season === 'mild' ? 0.85 : 0.35);
      const hc = cap ? r.pick(['#151515', '#1f3d5a', '#2a2c30', '#e8e6e0', '#7a1d1d', '#3b4232', '#c8b48c']) : r.pick(['#151515', '#2a2a2e', '#4a1f22', '#c8c4ba', '#1f3d5a', '#5a5a5a', '#8a6c4a', '#b03a3a']);
      this.far.hair.set(hc);
      parts.push({ geo: cap ? propGeo.cap : propGeo.beanie, bone: 'Head', m: hatMatrix(gender, cap ? 'cap' : 'beanie'), color: hc });
    }
    // bags
    const bagRoll = r.next();
    const sp = gender === 'male' ? 1.25 : 1.22;
    if (bagRoll < 0.22) {
      const bc = r.pick(['#151517', '#22262e', '#3a3f45', '#2f3a2a', '#5a1a1c', '#1f3d5a']);
      parts.push({ geo: propGeo.backpack, bone: 'spine_03', m: at(0, sp - 0.04, -0.2 - (o.topStyle === 2 ? 0.03 : 0)), color: bc });
      for (const s of [-1, 1]) parts.push({ geo: propGeo.strap, bone: 'spine_03', m: at(s * 0.1, sp + 0.17, 0.075 + (o.topStyle === 2 ? 0.03 : 0), -0.5, 0, 0), color: bc });
    } else if (bagRoll < 0.4) {
      const bc = r.pick(['#151517', '#3a2416', '#5a3a22', '#7a1d1d', '#c8b48c', '#2a2c30']);
      parts.push({ geo: propGeo.crossbody, bone: 'pelvis', m: at(-0.19, b.waist - 0.04, 0.02, 0, -Math.PI / 2 + 0.25, 0), color: bc });
    }
    // hoods lying on the upper back (hoodies, most puffers)
    this.hood = o.topStyle === 4 || (o.topStyle === 2 && r.chance(0.6));
    if (this.hood) parts.push({ geo: propGeo.hood, bone: 'spine_03', m: at(0, b.neck - 0.03, -0.075, -0.35, 0, 0).multiply(new THREE.Matrix4().makeScale(1.05, 0.62, 0.8)), color: o.top });
    // shoes (the bare feet are shrunk inside them in the shader)
    const dark = !/^#[de]/.test(o.shoe);
    const sg = shoeGeo(o.shoe, o.sole, gender === 'male' ? 0.285 : 0.255, dark && r.chance(0.3));
    for (const [s, bone] of [[1, 'foot_l'], [-1, 'foot_r']] as const) parts.push({ geo: sg, bone, m: at(s * b.legX, 0, gender === 'male' ? 0.02 : 0.025) });
    // long coats (most of the open coats in the reference photos reach the knee)
    const skirt = o.coatLen >= 0 ? coatSkirtGeo(gender, o.coatLen) : null;
    {
      // shares the body's skeleton (no extra bone update / texture): vertices go into the body
      // geometry's space and the bone indices are the body skin's
      const body = this.fullMesh as THREE.SkinnedMesh;
      const names = body.skeleton.bones.map((bn) => bn.name);
      const geo = mergeParts(parts, names, skirt, o.top);
      geo.applyMatrix4(A.geoInv);
      const pm = new THREE.SkinnedMesh(geo, propsMat);
      pm.matrix.copy(body.matrix);
      pm.matrix.decompose(pm.position, pm.quaternion, pm.scale);
      body.parent!.add(pm);
      pm.bind(body.skeleton, body.bindMatrix);
      pm.boundingSphere = body.boundingSphere!.clone();
      pm.name = 'props';
      this.meshes.push(pm);
    }
    // root scale: base meshes are tall; real NYC adults ~1.76 m (men) / 1.62 m (women)
    const target = gender === 'male' ? 1.76 * r.range(0.94, 1.06) : 1.66 * r.range(0.95, 1.05);
    model.scale.setScalar(target / b.height);
    if (r.chance(0.3)) this.walkClip = 'Walk_Formal_Loop';
    this.twoHands = r.chance(0.3);
    this.mixer = new THREE.AnimationMixer(model);
    for (const [name, clip] of A.clips) this.actions.set(name, this.mixer.clipAction(clip));
    // a phone, shown for phone-users
    this.phone = attach('hand_r', new THREE.Mesh(propGeo.phone, propMat('#0c0c0e', 0.25)), at(-b.wristX - 0.075, b.armY - 0.035, b.armZ + 0.02, Math.PI / 2, 0, Math.PI / 2));
    this.phone.visible = false;
    // things carried or walked with (one each): stroller, dog, coffee, a bag in the hand
    const carry = r.next();
    const holder = (bone: string, x: number, y: number, z: number) => {
      // a grip point on the hand whose orientation is kept upright every frame
      const h = new THREE.Object3D();
      new THREE.Matrix4().multiplyMatrices(A.bindInv.get(bone)!, at(x, y, z)).decompose(h.position, h.quaternion, h.scale);
      this.bones.get(bone)!.add(h);
      return h;
    };
    if (carry < 0.03 && !this.slow) {
      // pushing a stroller: both hands on the bar, slower
      this.noPhone = true;
      this.walkSpeed = Math.min(this.walkSpeed, r.range(0.95, 1.15));
      const st = new THREE.Mesh(strollerGeo(r.pick(['#1d2433', '#2a2c30', '#3b4232', '#151517', '#6b6e72'])), propVcMat);
      st.position.set(0, 1.0, 0.5);
      st.castShadow = true;
      this.root.add(st);
      this.meshes.push(st);
      this.pose = (p) => {
        p.aim('upperarm_r', 'lowerarm_r', _v3.set(0.05, -0.75, 0.55));
        p.aim('lowerarm_r', 'hand_r', _v3.set(0.12, 0.05, 1));
        p.aim('upperarm_l', 'lowerarm_l', _v3.set(-0.05, -0.75, 0.55));
        p.aim('lowerarm_l', 'hand_l', _v3.set(-0.12, 0.05, 1));
      };
    } else if (carry < 0.075) {
      // walking a dog on a leash held in the left hand
      this.noPhone = true;
      this.walkSpeed = Math.min(this.walkSpeed, r.range(1.0, 1.25));
      const dog = new Dog(r.int(0, 5), r.range(0.75, 1.15));
      const dh = new THREE.Group();
      dh.position.set(0.45, 0, 1.0);
      dh.add(dog.root);
      this.root.add(dh);
      this.dog = dog;
      const grip = holder('hand_l', b.wristX + 0.06, b.armY - 0.03, b.armZ);
      const leash = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * 3), 3)), leashMat);
      leash.frustumCulled = false;
      this.root.add(leash);
      const pa = leash.geometry.attributes.position as THREE.BufferAttribute;
      const h = new THREE.Vector3(), c = new THREE.Vector3();
      this.pose = (p) => {
        grip.getWorldPosition(h);
        p.root.worldToLocal(h);
        c.copy(dog.collar).add(dh.position);
        for (let i = 0; i <= 8; i++) {
          const f = i / 8;
          pa.setXYZ(i, h.x + (c.x - h.x) * f, h.y + (c.y - h.y) * f - Math.sin(f * Math.PI) * 0.12, h.z + (c.z - h.z) * f);
        }
        pa.needsUpdate = true;
      };
    } else if (carry < 0.19) {
      // a takeaway coffee in the left hand, forearm up
      const grip = holder('hand_l', b.wristX + 0.075, b.armY - 0.02, b.armZ + 0.045);
      const cup = new THREE.Mesh(coffeeGeo(), propVcMat);
      cup.position.y = -0.05;
      grip.add(cup);
      this.meshes.push(cup);
      this.detail.push(cup);
      this.pose = (p) => {
        p.aim('upperarm_l', 'lowerarm_l', _v3.set(-0.1, -1, 0.08));
        p.aim('lowerarm_l', 'hand_l', _v3.set(-0.25, 0.3, 1));
        p.upright(grip);
      };
    } else if (carry < 0.36) {
      // a shopping bag or handbag hanging from the left hand
      const kind = r.chance(0.55) ? 'shopping' : 'handbag';
      const col = kind === 'shopping' ? r.pick(['#f2efe6', '#1a1a1a', '#c8a878', '#b8282e', '#e8e0d0', '#2a4a7a']) : r.pick(['#151517', '#3a2416', '#5a3a22', '#7a1d1d', '#c8b48c']);
      const grip = holder('hand_l', b.wristX + 0.06, b.armY - 0.03, b.armZ);
      const bag = new THREE.Mesh(handBagGeo(kind, col), propVcMat);
      grip.add(bag);
      this.meshes.push(bag);
      this.pose = (p) => p.upright(grip);
    }
    this.setActivity('walk', r.range(0, 10));
    // frozen frames (animation skipped for distance, or off screen): no matrix-world walk over the
    // 65 bones and props, no bone-matrix recompute / bone-texture upload
    const self = this;
    const baseUpdate = THREE.Object3D.prototype.updateMatrixWorld;
    this.root.updateMatrixWorld = function (force?: boolean) {
      if (self.frozen) return;
      baseUpdate.call(this, force);
    };
    addDither(bm, this.fadeU);
    const skels = new Set<THREE.Skeleton>();
    this.root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skels.add((o as THREE.SkinnedMesh).skeleton);
    });
    for (const sk of skels) {
      const orig = sk.update.bind(sk);
      let ready = false;
      sk.update = () => {
        if (self.frozen && ready) return;
        orig();
        ready = true;
        Person.skeletonUpdates++;
      };
    }
  }
  far!: { top: THREE.Color; bottom: THREE.Color; shoe: THREE.Color; skin: THREE.Color; hair: THREE.Color; style: THREE.Vector4; coat: number };
  /** the far crowd's animation state: clip 0 walk / 1 idle, phase 0..1 */
  vatClip = 0;
  vatPhase = Math.random();
  /** advance the far-crowd clock (instead of the mixer) */
  farStep(dt: number) {
    const walking = this.activity === 'walk' && this.speed > 0.05;
    const clip = walking ? 0 : 1;
    if (clip !== this.vatClip) {
      this.vatClip = clip;
      this.vatPhase = Math.random();
    }
    const dur = this.actions.get(walking ? this.walkClip : 'Idle_Loop')!.getClip().duration;
    const rate = walking ? this.actions.get(this.walkClip)!.timeScale : 1;
    this.vatPhase = (this.vatPhase + (dt * rate) / dur) % 1;
  }
  /** entering / leaving the far crowd: carry the animation phase across */
  syncFromFar() {
    const a = this.actions.get(this.activity === 'walk' ? this.walkClip : this.activity === 'talk' ? 'Idle_Talking_Loop' : 'Idle_Loop');
    if (a) a.time = this.vatPhase * a.getClip().duration;
  }
  syncToFar() {
    const walking = this.activity === 'walk' && this.speed > 0.05;
    const a = this.actions.get(walking ? this.walkClip : 'Idle_Loop');
    this.vatClip = walking ? 0 : 1;
    if (a) this.vatPhase = (a.time / a.getClip().duration) % 1;
  }
  get scaleH() {
    return this.model().scale.x;
  }
  /** the crossfade uniform shared by this person's (dithered) materials */
  private fadeU = { value: 1 };
  private fadeReady = false;
  /** 1 = solid; below 1 the near person dithers out (crossfade with the far crowd) */
  get fade() {
    return this.fadeU.value;
  }
  set fade(v: number) {
    if (v < 1 && !this.fadeReady) {
      // first crossfade: give this person its own dithered copies of the shared materials
      this.fadeReady = true;
      const copies = new Map<THREE.Material, THREE.Material>();
      this.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || Array.isArray(m.material)) return;
        if (dithered.has(m.material)) return;
        let c = copies.get(m.material);
        if (!c) {
          c = m.material.clone();
          addDither(c, this.fadeU);
          copies.set(m.material, c);
        }
        m.material = c;
      });
    }
    this.fadeU.value = v;
  }
  /** wears a hood (raised in the rain) */
  hood = false;
  /** this frame: keep last frame's pose and matrices */
  frozen = false;
  /** skeleton updates performed (all people), for perf readouts */
  static skeletonUpdates = 0;
  hasHat = false;
  longHair = false;
  hairMesh: THREE.Mesh | null = null;
  /** fixed per person: decides umbrella / hood / hat / scarf in bad weather */
  weatherRoll = 0;
  umbrella: THREE.Object3D | null = null;
  umbrellaOn = false;
  private weatherProps: { hoodUp?: THREE.Object3D; beanie?: THREE.Object3D; scarf?: THREE.Object3D } = {};
  private bindInvOf: (bone: string) => THREE.Matrix4 = () => new THREE.Matrix4();
  /** walking speed multiplier from the weather (rain: hurry, snow: careful) */
  weatherSpeed = 1;
  /** dress for the weather: umbrellas and raised hoods in rain, hats and scarves in snow */
  applyWeather(w: PeopleWeather) {
    const rain = w.rain > 0.25, snow = w.snow > 0.25;
    const b = BODY[this.gender];
    const at = (x: number, y: number, z: number, rx = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, 0)), new THREE.Vector3(1, 1, 1));
    const put = (bone: string, obj: THREE.Mesh, m: THREE.Matrix4) => {
      obj.matrixAutoUpdate = false;
      obj.matrix.multiplyMatrices(this.bindInvOf(bone), m);
      this.bones.get(bone)!.add(obj);
      this.meshes.push(obj);
      obj.castShadow = !!this.shadowOn;
      return obj;
    };
    const headTop = this.gender === 'male' ? 1.712 : 1.655;
    // umbrella: 65 % of people with a free right hand
    const wantUmbrella = rain && this.weatherRoll < 0.65 && !this.noPhone;
    if (wantUmbrella && !this.umbrella) {
      const holder = new THREE.Object3D();
      new THREE.Matrix4().multiplyMatrices(this.bindInvOf('hand_r'), at(-b.wristX - 0.07, b.armY - 0.02, b.armZ + 0.02)).decompose(holder.position, holder.quaternion, holder.scale);
      this.bones.get('hand_r')!.add(holder);
      const u = new THREE.Mesh(umbrellaGeo(UMBRELLA[Math.floor(this.weatherRoll * 97) % UMBRELLA.length]), umbrellaMat);
      u.castShadow = true;
      holder.add(u);
      this.meshes.push(u);
      this.umbrella = holder;
    }
    this.umbrellaOn = wantUmbrella;
    if (this.umbrella) this.umbrella.visible = wantUmbrella;
    // hood up when it rains or snows and there is no umbrella
    const hoodUp = (rain || snow) && this.hood && !wantUmbrella;
    if (hoodUp && !this.weatherProps.hoodUp) {
      const m = new THREE.Mesh(propGeo.hoodUp, clothMatFor(this.far.top));
      this.weatherProps.hoodUp = put('Head', m, at(0, headTop - 0.07, -0.02).multiply(new THREE.Matrix4().makeScale(1.05, 1.12, 1.12)));
    }
    if (this.weatherProps.hoodUp) this.weatherProps.hoodUp.visible = hoodUp;
    // snow: beanies on most bare heads, scarves
    const beanie = snow && !this.hasHat && !hoodUp && this.weatherRoll > 0.25;
    if (beanie && !this.weatherProps.beanie) {
      const col = SNOWHAT[Math.floor(this.weatherRoll * 131) % SNOWHAT.length];
      const m = new THREE.Mesh(propGeo.beanie, propMat(col, 0.95));
      this.weatherProps.beanie = put('Head', m, hatMatrix(this.gender, 'beanie'));
    }
    if (this.weatherProps.beanie) this.weatherProps.beanie.visible = beanie;
    if (this.hairMesh && !this.longHair) this.hairMesh.visible = !beanie && !hoodUp;
    const scarf = snow && this.weatherRoll > 0.4;
    if (scarf && !this.weatherProps.scarf) {
      const col = SCARF[Math.floor(this.weatherRoll * 173) % SCARF.length];
      this.weatherProps.scarf = put('neck_01', new THREE.Mesh(propGeo.scarf, propMat(col, 0.95)), at(0, b.neck - 0.02, -0.02).multiply(new THREE.Matrix4().makeScale(1, 1, 1.05)));
    }
    if (this.weatherProps.scarf) this.weatherProps.scarf.visible = scarf;
    this.weatherSpeed = rain ? 1.12 : snow ? 0.88 : 1;
  }
  /** pushes a stroller or walks a dog: never stops to look at a phone */
  noPhone = false;
  dog: Dog | null = null;
  /** current walking speed (m/s), 0 when standing */
  speed = 0;
  setActivity(a: Activity, phase = 0) {
    if (a === 'phone' && this.noPhone) a = 'idle';
    this.activity = a;
    if (a !== 'walk') this.speed = 0;
    const clip = a === 'walk' ? this.walkClip : a === 'talk' ? 'Idle_Talking_Loop' : 'Idle_Loop';
    for (const [n, act] of this.actions) {
      if (n === clip) {
        if (!act.isRunning()) {
          act.reset().play();
          act.time = phase % act.getClip().duration;
        }
      } else act.stop();
    }
    if (this.phone) this.phone.visible = a === 'phone';
  }
  /** walking speed in m/s drives the cadence (clip walks ~0.98 m/s) */
  setSpeed(v: number) {
    this.speed = this.activity === 'walk' ? v : 0;
    const w = this.actions.get(this.walkClip);
    if (w) w.timeScale = Math.max(0.5, v / (0.98 * this.model().scale.x * (BODY[this.gender].height / 1.83)));
  }
  private model() {
    return this.root.children[0];
  }
  shadowOn: boolean | null = null;
  setShadows(on: boolean) {
    if (on === this.shadowOn) return;
    this.shadowOn = on;
    for (const m of this.meshes) m.castShadow = on;
  }
  update(dt: number) {
    this.mixer.update(dt);
    this.dog?.update(dt, this.speed);
    const phone = this.activity === 'phone';
    if (!phone && !this.slow && !this.pose && !this.umbrellaOn) return;
    this.model().updateMatrixWorld(true);
    this.rq.copy(this.model().getWorldQuaternion(_q0));
    if (this.slow) {
      // older people: a slight stoop, head carried forward
      this.turn('spine_02', 0.08);
      this.turn('neck_01', 0.1);
    }
    if (phone) this.phonePose();
    this.pose?.(this);
    if (this.umbrellaOn && !phone) {
      // umbrella held up in the right hand, a little ahead of the head
      this.aim('upperarm_r', 'lowerarm_r', _v3.set(-0.05, -0.55, 0.5));
      this.aim('lowerarm_r', 'hand_r', _v3.set(0.25, 0.95, 0.05));
      this.upright(this.umbrella!);
    }
  }
  twoHands = false;
  walkClip = 'Walk_Loop';
  /** older person: slower gait and a stoop */
  slow = false;
  /** preferred walking speed (m/s) */
  walkSpeed = 1.3;
  /** extra per-frame pose (carrying a cup, pushing a stroller...) run after the animation */
  pose: ((p: Person) => void) | null = null;
  private rq = new THREE.Quaternion();
  /** rotate a bone so the direction to its child points along `dir` (model space, +z forward) */
  aim(bone: string, child: string, dir: THREE.Vector3) {
    const b = this.bones.get(bone), c = this.bones.get(child);
    if (!b || !c || !b.parent) return;
    const from = c.getWorldPosition(_v1).sub(b.getWorldPosition(_v0)).normalize();
    const to = _v2.copy(dir).normalize().applyQuaternion(this.rq);
    const world = b.getWorldQuaternion(_q2).premultiply(_q1.setFromUnitVectors(from, to));
    b.quaternion.copy(b.parent.getWorldQuaternion(_q3).invert().multiply(world));
    b.updateMatrixWorld(true);
  }
  /** bend a bone forward (about the model's right axis) */
  turn(bone: string, ang: number) {
    const b = this.bones.get(bone);
    if (!b || !b.parent) return;
    const ax = _v2.set(1, 0, 0).applyQuaternion(this.rq);
    const world = b.getWorldQuaternion(_q2).premultiply(_q1.setFromAxisAngle(ax, ang));
    b.quaternion.copy(b.parent.getWorldQuaternion(_q3).invert().multiply(world));
    b.updateMatrixWorld(true);
  }
  /** keep a carried object hanging plumb under (or upright in) the hand, facing forward */
  upright(o: THREE.Object3D) {
    const parent = o.parent;
    if (!parent) return;
    o.quaternion.copy(parent.getWorldQuaternion(_q2).invert().multiply(this.rq));
  }
  /** hold the phone up in front of the chest and look down at it (aimed in world space, so it
   *  does not depend on the rig's local bone axes) */
  private phonePose() {
    // the model faces +z; its right side is -x
    this.aim('upperarm_r', 'lowerarm_r', _v3.set(0.12, -1, 0.18));
    this.aim('lowerarm_r', 'hand_r', _v3.set(0.45, 0.8, 0.6));
    if (this.twoHands) {
      this.aim('upperarm_l', 'lowerarm_l', _v3.set(-0.12, -1, 0.18));
      this.aim('lowerarm_l', 'hand_l', _v3.set(-0.45, 0.8, 0.6));
    }
    this.turn('neck_01', 0.25);
    this.turn('Head', 0.3);
  }
}
const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();

// ---------------------------------------------------------------- the crowd
type State = 'walk' | 'kerb' | 'stand';
interface Ped {
  p: Person;
  /** walking direction axis and sign */
  axis: 'x' | 'z';
  dir: number;
  /** centre line of the road this sidewalk runs along, and which side of it (+1 / -1) */
  c: number;
  s: number;
  /** distance in from the kerb; line = c + s * (roadHalf + inSw) */
  line: number;
  /** position along the axis */
  t: number;
  v: number;
  /** speed this frame */
  v0: number;
  /** sidestep offset across the walking line */
  off: number;
  state: State;
  /** stand: seconds left; kerb: reaction delay once the walk phase starts */
  wait: number;
  /** how far back from the kerb this person waits (0.5–1.5 m) */
  wd: number;
  tick: number;
  acc: number;
  yaw: number;
  /** a companion: walks beside this person, or stands facing them talking */
  buddy?: Ped;
  /** distance to the player this frame */
  dist: number;
  /** drawn by the far crowd */
  far?: boolean;
  /** simulated position / facing; copied to the rendered person on its animation frames */
  pos: THREE.Vector3;
  rot: number;
  /** set on the companion: the person it follows */
  lead?: Ped;
}
/** ?quality=low: a smaller crowd that switches to the far crowd sooner */
const LOWQ = (() => {
  try {
    return new URLSearchParams(location.search).get('quality') === 'low';
  } catch {
    return false;
  }
})();
/** crowd size; ?people=N overrides (0 turns pedestrians off, for perf comparisons) */
const COUNT = (() => {
  try {
    const n = new URLSearchParams(location.search).get('people');
    return n !== null && isFinite(Number(n)) ? Number(n) : LOWQ ? 70 : 110;
  } catch {
    return 110;
  }
})();
const SHADOWS = 20;
/** switch to / from the VAT far crowd (hysteresis) */
const FAR_IN = LOWQ ? 22 : 32, FAR_OUT = LOWQ ? 18 : 28;
/** ?pfreeze=0 disables culling / frozen frames (for before/after perf comparisons) */
const FREEZE = (() => {
  try {
    return new URLSearchParams(location.search).get('pfreeze') !== '0';
  } catch {
    return true;
  }
})();
/** ?pfar=0 keeps everyone as skinned people (no VAT far crowd) */
const FAR = FREEZE && (() => {
  try {
    return new URLSearchParams(location.search).get('pfar') !== '0';
  } catch {
    return true;
  }
})();
const yawOf = (axis: 'x' | 'z', dir: number) => (axis === 'x' ? (dir > 0 ? Math.PI / 2 : -Math.PI / 2) : dir > 0 ? 0 : Math.PI);
/** walking along x crosses avenues, along z crosses streets */
const crossPeriod = (axis: 'x' | 'z') => (axis === 'x' ? AX : SZ);
const crossHalf = (axis: 'x' | 'z') => (axis === 'x' ? AVE : ST) / 2;
/** the half-width of the road a sidewalk line runs along */
const sideHalf = (axis: 'x' | 'z') => (axis === 'x' ? ST : AVE) / 2;
/** Walk signal: crossing an avenue (walking along x) goes with the street traffic and vice
 *  versa. Only start in the first part of the green so nobody is caught mid-road. */
function walkSignal(axis: 'x' | 'z', time: number, needed: number) {
  const ph = ((time % CYCLE) + CYCLE) % CYCLE;
  if (lightFor(axis, time) !== 'g') return false;
  // the cross traffic gets green at the end of this phase's yellow: only start if the crossing
  // (at crossing speed, plus a margin) is done by then
  return untilRed(axis, ph) >= needed;
}
/** seconds from phase time ph until the light along `axis` turns red (scanned once from lightFor) */
const redTable = new Map<string, Float32Array>();
function untilRed(axis: 'x' | 'z', ph: number) {
  let tab = redTable.get(axis);
  if (!tab) {
    const n = Math.ceil(CYCLE * 4);
    tab = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let k = 0;
      while (k < n && lightFor(axis, (i + k) / 4) !== 'r') k++;
      tab[i] = k / 4;
    }
    redTable.set(axis, tab);
  }
  return tab[Math.floor(ph * 4) % tab.length];
}
/** people hurry across: at least 1.5 m/s in the roadway */
const crossSpeed = (v: number) => Math.max(v * 1.3, 1.5);

/** colliders bucketed in 4 m cells, rebuilt when the level hands over a new list */
class ColliderGrid {
  private cells = new Map<number, Rect[]>();
  src: Rect[] | null = null;
  set(list: Rect[]) {
    if (list === this.src) return;
    this.src = list;
    this.cells.clear();
    for (const r of list) {
      if (r.maxX - r.minX > 40 || r.maxZ - r.minZ > 40) continue; // whole buildings: never on a sidewalk line
      for (let ix = Math.floor(r.minX / 4); ix <= Math.floor(r.maxX / 4); ix++)
        for (let iz = Math.floor(r.minZ / 4); iz <= Math.floor(r.maxZ / 4); iz++) {
          const k = ix * 100003 + iz;
          let a = this.cells.get(k);
          if (!a) this.cells.set(k, (a = []));
          a.push(r);
        }
    }
  }
  /** rects overlapping an axis-aligned box */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: Rect[]) {
    out.length = 0;
    for (let ix = Math.floor(minX / 4); ix <= Math.floor(maxX / 4); ix++)
      for (let iz = Math.floor(minZ / 4); iz <= Math.floor(maxZ / 4); iz++) {
        const a = this.cells.get(ix * 100003 + iz);
        if (!a) continue;
        for (const r of a) if (r.maxX > minX && r.minX < maxX && r.maxZ > minZ && r.minZ < maxZ && !out.includes(r)) out.push(r);
      }
    return out;
  }
}
const _rects: Rect[] = [];
const _sphere = new THREE.Sphere();
const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _m4 = new THREE.Matrix4();

export class Pedestrians {
  peds: Ped[] = [];
  private rng: Rng;
  private assets: PeopleAssets | null = null;
  private frame = 0;
  private clock = 0;
  private grid = new ColliderGrid();
  constructor(private group: THREE.Group, seed: number) {
    this.rng = new Rng(hashN(seed, 909));
    loadPeopleAssets()
      .then((a) => (this.assets = a))
      .catch((e) => console.warn('people assets failed to load', e));
  }
  /** keep the walking line on the sidewalk: 0.35 m off the kerb, 0.45 m off the shopfronts */
  private clampLine(pd: Ped, l: number) {
    const h = sideHalf(pd.axis);
    const a = pd.c + pd.s * (h + 0.35), b = pd.c + pd.s * (h + SW - 0.45);
    return THREE.MathUtils.clamp(l, Math.min(a, b), Math.max(a, b));
  }
  private blocked(pd: Ped, t: number, line: number, r = 0.32) {
    const x = pd.axis === 'x' ? t : line, z = pd.axis === 'x' ? line : t;
    return this.grid.query(x - r, z - r, x + r, z + r, _rects).length > 0;
  }
  private place(pd: Ped, p: THREE.Vector3, ahead: boolean) {
    const r = this.rng;
    // avenues carry more people than side streets
    pd.axis = r.chance(0.6) ? 'z' : 'x';
    pd.dir = r.chance(0.5) ? 1 : -1;
    pd.off = 0;
    // a stroller or a dog out front needs more room before the kerb
    pd.wd = pd.p.noPhone ? r.range(1.5, 2.0) : r.range(0.5, 1.2);
    const along = pd.axis === 'x' ? p.x : p.z, across = pd.axis === 'x' ? p.z : p.x;
    const P2 = pd.axis === 'x' ? SZ : AX; // spacing of the parallel roads
    const k = Math.round(across / P2 - 0.5) + (r.chance(0.6) ? 0 : r.int(-1, 1));
    pd.c = (k + 0.5) * P2;
    pd.s = r.chance(0.5) ? 1 : -1;
    const inSw = pd.buddy ? r.range(1.0, SW - 1.5) : r.range(0.6, SW - 0.7);
    pd.line = this.clampLine(pd, pd.c + pd.s * (sideHalf(pd.axis) + inSw));
    // half of them start near a corner, where Midtown sidewalks are busiest
    const CP = crossPeriod(pd.axis), ch = crossHalf(pd.axis);
    if (ahead) {
      pd.t = along + r.range(-50, 50);
      if (r.chance(0.5)) {
        const kc = Math.round(pd.t / CP - 0.5);
        pd.t = (kc + 0.5) * CP + r.pick([-1, 1]) * (ch + r.range(0.5, 14));
      }
    } else pd.t = along - pd.dir * r.range(40, 60);
    {
      // never start in a roadway: step back onto the sidewalk before it
      const kc = Math.round(pd.t / CP - 0.5), cc = (kc + 0.5) * CP;
      if (Math.abs(pd.t - cc) < ch + 0.3) pd.t = cc - pd.dir * (ch + r.range(0.5, 3));
    }
    pd.v = pd.p.walkSpeed * r.range(0.9, 1.1);
    pd.yaw = yawOf(pd.axis, pd.dir);
    // keep the view in front of the player clear at load: nobody spawns within 6 m of them
    if (Math.abs(pd.line - across) < 6 && Math.abs(pd.t - along) < 6) {
      const sgn = pd.t >= along ? 1 : -1;
      pd.t = along + sgn * r.range(6, 12);
      const kc = Math.round(pd.t / CP - 0.5), cc = (kc + 0.5) * CP;
      if (Math.abs(pd.t - cc) < ch + 0.3) pd.t = cc + sgn * (ch + r.range(0.5, 3));
    }
    // never start inside a newsstand, tree pit or stoop
    for (let i = 0; i < 6 && this.blocked(pd, pd.t, pd.line); i++) pd.line = this.clampLine(pd, pd.line + r.range(-1.2, 1.2));
    pd.state = 'walk';
    pd.wait = 0;
    if (ahead && r.chance(peopleWeather.rain > 0.25 ? 0.03 : 0.12) && !pd.p.slow) {
      // loiterers: on the phone or chatting near the shopfronts
      pd.state = 'stand';
      pd.wait = r.range(8, 40) + (pd.buddy ? 20 : 0);
      pd.line = this.clampLine(pd, pd.c + pd.s * (sideHalf(pd.axis) + SW - 0.9));
      if (!pd.buddy) pd.yaw += pd.s * (pd.axis === 'x' ? 1 : -1) * pd.dir * r.range(0.6, 1.4);
      pd.p.setActivity(pd.buddy ? 'talk' : r.chance(0.6) ? 'phone' : 'idle', r.range(0, 5));
    } else {
      pd.p.setActivity('walk', r.range(0, 5));
      pd.p.setSpeed(pd.v);
    }
    for (let i = 0; i < 6 && pd.state === 'stand' && this.blocked(pd, pd.t, pd.line, 0.45); i++) pd.t += r.range(-2, 2);
    pd.rot = pd.yaw;
  }
  update(dt: number, p: THREE.Vector3, time?: number, colliders?: Rect[]) {
    if (!this.assets) return;
    this.frame++;
    this.clock = time ?? this.clock + dt;
    if (colliders) this.grid.set(colliders);
    if (this.weatherSeen !== weatherVersion) {
      this.weatherSeen = weatherVersion;
      for (const pd of this.peds) pd.p.applyWeather(peopleWeather);
    }
    // spawn a few per frame so building the skinned clones does not hitch one frame
    for (let n = 0; n < 8 && this.peds.length < COUNT; n++) {
      const person = new Person(this.assets, this.rng);
      person.applyWeather(peopleWeather);
      this.group.add(person.root);
      const pd: Ped = { p: person, axis: 'x', dir: 1, c: 0, s: 1, line: 0, t: 0, v: 1.3, v0: 0, off: 0, state: 'walk', wait: 0, wd: 1, tick: this.peds.length, acc: 0, yaw: 0, dist: 0, pos: new THREE.Vector3(), rot: 0 };
      // about one in five people is out with a companion
      const prev = this.peds[this.peds.length - 1];
      if (prev && !prev.lead && !prev.buddy && !prev.p.slow && this.rng.chance(0.25)) {
        pd.lead = prev;
        prev.buddy = pd;
        this.place(prev, p, true);
      } else this.place(pd, p, true);
      this.peds.push(pd);
    }
    for (const pd of this.peds) {
      if (pd.lead) continue;
      const along = pd.axis === 'x' ? p.x : p.z, across = pd.axis === 'x' ? p.z : p.x;
      if (Math.abs(pd.t - along) > 80 || Math.abs(pd.line - across) > 80) this.place(pd, p, false);
      // [districts] no walking on the river or across the airport: re-place, or turn back at the edge
      for (let i = 0; i < 6 && !walkable(pd.axis === 'x' ? pd.t : pd.line, pd.axis === 'x' ? pd.line : pd.t); i++) this.place(pd, p, i > 0);
      if (pd.state === 'walk' && !walkable(pd.axis === 'x' ? pd.t + pd.dir * 1.5 : pd.line, pd.axis === 'x' ? pd.line : pd.t + pd.dir * 1.5)) {
        pd.dir = -pd.dir;
        pd.yaw = yawOf(pd.axis, pd.dir);
      }
      if (pd.state === 'stand') {
        pd.wait -= dt;
        if (pd.wait <= 0) {
          pd.state = 'walk';
          pd.yaw = yawOf(pd.axis, pd.dir);
          pd.p.setActivity('walk', 0);
        }
      } else this.walk(pd, dt, along, across);
      const lineNow = pd.line + pd.off;
      pd.pos.set(pd.axis === 'x' ? pd.t : lineNow, this.groundAt(pd), pd.axis === 'x' ? lineNow : pd.t);
      pd.rot = pd.yaw;
      if (pd.buddy) this.follow(pd.buddy, pd);
    }
    const cam = this.updateFrustum();
    if (!this.farCrowd && FAR && this.assets && this.peds.length >= COUNT) {
      const A = this.assets.body;
      this.farCrowd = new FarCrowd(this.group, { male: A.male, female: A.female }, BODY, COUNT);
    }
    if (this.farCrowd && !this.farCrowd.ready) {
      // bake the VAT a few ms per frame; until it is ready everyone stays a skinned person
      const t0 = performance.now();
      this.farCrowd.pump(4);
      this.bakeMs += performance.now() - t0;
      (globalThis as unknown as { __peopleBakeMs: number }).__peopleBakeMs = Math.round(this.bakeMs);
    }
    const far = this.farCrowd?.ready ? this.farCrowd : null;
    far?.begin();
    for (const pd of this.peds) {
      // LOD: animate near people every frame, far ones every 2nd / 4th frame, off-screen ones not
      // at all (they keep their last pose and matrices and are hidden)
      const d = Math.hypot(pd.pos.x - p.x, pd.pos.z - p.z);
      pd.dist = d;
      const r = pd.p.root;
      pd.acc = Math.min(pd.acc + dt, 4);
      _sphere.center.set(pd.pos.x, pd.pos.y + 0.9, pd.pos.z).applyMatrix4(this.group.matrixWorld);
      _sphere.radius = pd.p.noPhone ? 2.2 : 1.4;
      const seen = !FREEZE || d < 6 || !cam || this.frustum.intersectsSphere(_sphere);
      // beyond ~30 m: one instance of the VAT far crowd instead of a skinned person. Between
      // FAR_OUT and FAR_IN both are drawn with complementary screen-door dither patterns.
      const fadeNear = far ? 1 - THREE.MathUtils.smoothstep(d, FAR_OUT, FAR_IN) : 1;
      if (fadeNear < 1) {
        const farOnly = fadeNear <= 0;
        if (farOnly) {
          if (!pd.far) {
            pd.far = true;
            pd.p.syncToFar();
          }
          r.visible = false;
          pd.p.frozen = true;
          pd.p.farStep(dt);
        } else if (!pd.far) pd.p.syncToFar(); // in the band the near person leads the phase
        else pd.p.farStep(dt);
        if (seen) {
          const f = pd.p.far;
          _q.setFromAxisAngle(_up, pd.rot);
          _s.setScalar(pd.p.scaleH);
          far!.add(pd.p.gender === 'female', { matrix: _m4.compose(pd.pos, _q, _s), clip: pd.p.vatClip, phase: pd.p.vatPhase, fade: fadeNear, top: f.top, bottom: f.bottom, shoe: f.shoe, skin: f.skin, hair: f.hair, style: f.style, coat: f.coat });
        }
        if (farOnly) continue;
      }
      pd.p.fade = fadeNear;
      if (pd.far) {
        pd.far = false;
        pd.p.syncFromFar();
        r.visible = false; // forces a full update below
      }
      if (!seen) {
        r.visible = false;
        pd.p.frozen = true;
        continue;
      }
      const every = d < 25 ? 1 : d < 50 ? 2 : 4;
      if (!FREEZE) {
        // the previous behaviour: matrices every frame, the mixer every Nth frame
        r.position.copy(pd.pos);
        r.rotation.y = pd.rot;
        if ((this.frame + pd.tick) % every === 0) {
          pd.p.update(pd.acc);
          pd.acc = 0;
        }
      } else if (!r.visible || (this.frame + pd.tick) % every === 0) {
        r.visible = true;
        pd.p.frozen = false;
        r.position.copy(pd.pos);
        r.rotation.y = pd.rot;
        pd.p.update(pd.acc);
        pd.acc = 0;
      } else pd.p.frozen = true;
      pd.p.setLod(d < 22 ? 0 : 1);
    }
    far?.end();
    // shadows only for the nearest SHADOWS people (skinned shadow casters cost a full skinning pass)
    const order = this.order;
    order.length = 0;
    for (const pd of this.peds) order.push(pd);
    order.sort((a, b) => a.dist - b.dist);
    order.forEach((pd, i) => pd.p.setShadows(i < SHADOWS && pd.dist < 30));
  }
  private order: Ped[] = [];
  private farCrowd: FarCrowd | null = null;
  private weatherSeen = 0;
  private bakeMs = 0;
  /** finish any pending far-crowd bake now (lab / loading screens) */
  warmUp() {
    if (this.farCrowd && !this.farCrowd.ready) {
      const t0 = performance.now();
      this.farCrowd.pump(1e9);
      this.bakeMs += performance.now() - t0;
      (globalThis as unknown as { __peopleBakeMs: number }).__peopleBakeMs = Math.round(this.bakeMs);
    }
  }
  private frustum = new THREE.Frustum();
  private probeCam: THREE.Camera | null = null;
  private probe: THREE.Mesh | null = null;
  /** frustum of the camera that drew us last frame, caught by an empty always-drawn probe mesh */
  private updateFrustum() {
    if (!this.probe) {
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
      g.setDrawRange(0, 0);
      this.probe = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
      this.probe.frustumCulled = false;
      this.probe.onBeforeRender = (_r, _s, c) => (this.probeCam = c);
      this.group.add(this.probe);
    }
    const c = this.probeCam;
    if (!c) return null;
    _m4.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(_m4);
    return c;
  }
  /** distance to the next kerb ahead */
  private nearKerb(pd: Ped) {
    const CP = crossPeriod(pd.axis), ch = crossHalf(pd.axis);
    const u = pd.t / CP - 0.5;
    const kNext = pd.dir > 0 ? Math.floor(u) + 1 : Math.ceil(u) - 1;
    return ((kNext + 0.5) * CP - pd.dir * ch - pd.t) * pd.dir;
  }
  /** on the sidewalk the feet stand on the kerb height; in the roadway, on the asphalt */
  private groundAt(pd: Ped) {
    const CP = crossPeriod(pd.axis), ch = crossHalf(pd.axis);
    const u = pd.t / CP - 0.5;
    // step down / up the kerb over a short stride instead of snapping
    const e = Math.abs(pd.t - (Math.round(u) + 0.5) * CP) - ch;
    const step = CURB * THREE.MathUtils.smoothstep(e, -0.18, 0.35);
    // the corner pedestrian ramps (src/nyc/ground.ts): RO from the corner along the kerb, RW wide
    // (+ RF flares), rising from a RLIP lip at the kerb to the sidewalk over RL
    const lo = Math.abs(pd.line + pd.off - pd.c) - sideHalf(pd.axis);
    const w = 1 - THREE.MathUtils.smoothstep(Math.abs(lo - GROUND.RO), GROUND.RW / 2, GROUND.RW / 2 + GROUND.RF);
    if (w <= 0 || e > GROUND.RL + 0.2) return step;
    const ramp = e <= 0 ? THREE.MathUtils.lerp(0, GROUND.RLIP, THREE.MathUtils.smoothstep(e, -0.1, 0)) : GROUND.RLIP + (CURB - GROUND.RLIP) * Math.min(1, e / GROUND.RL);
    return THREE.MathUtils.lerp(step, ramp, w);
  }
  private walk(pd: Ped, dt: number, along: number, across: number) {
    const CP = crossPeriod(pd.axis), ch = crossHalf(pd.axis);
    const u = pd.t / CP - 0.5;
    const inRoad = Math.abs(pd.t - (Math.round(u) + 0.5) * CP) < ch;
    let v = pd.v * pd.p.weatherSpeed;
    if (inRoad) v = Math.max(v, crossSpeed(pd.v));
    let queue = false;
    if (!inRoad) {
      // the next kerb ahead, and the crossing signal
      const kNext = pd.dir > 0 ? Math.floor(u) + 1 : Math.ceil(u) - 1;
      const kerb = (kNext + 0.5) * CP - pd.dir * ch;
      const dist = (kerb - pd.t) * pd.dir;
      const go = walkSignal(pd.axis, this.clock, (2 * ch) / crossSpeed(pd.v) + 1.5);
      if (pd.state === 'kerb') {
        if (go) {
          pd.wait -= dt;
          if (pd.wait <= 0) {
            pd.state = 'walk';
            pd.p.setActivity('walk', this.rng.range(0, 1));
          }
        }
        if (pd.state === 'kerb') {
          pd.v0 = 0;
          return;
        }
      } else if (!go && dist < pd.wd + 2.5 && dist > -0.05) {
        // slow down into the waiting cluster; stop pd.wd back from the kerb
        queue = true;
        v *= THREE.MathUtils.clamp((dist - pd.wd) / 2.5, 0, 1);
        if (dist - pd.wd < 0.05) {
          pd.state = 'kerb';
          pd.wait = this.rng.range(0.2, 1.4); // reaction time once WALK shows
          pd.p.setActivity(this.rng.chance(0.4) ? 'phone' : 'idle', this.rng.range(0, 3));
          pd.v0 = 0;
          return;
        }
      }
    }
    // pass the player and oncoming people (keep right), go around street furniture
    let target = 0;
    const right = (pd.axis === 'x' ? 1 : -1) * pd.dir;
    const avoid = (oa: number, oc: number, oncoming: boolean) => {
      const ahead = (oa - pd.t) * pd.dir;
      const lat = oc - (pd.line + pd.off);
      if (ahead > -0.3 && ahead < 3.5 && Math.abs(lat) < 0.9) {
        const away = oncoming ? right : lat > 0 ? -1 : 1;
        target = THREE.MathUtils.clamp(pd.off + away * (1.0 - Math.abs(lat)), -1.4, 1.4);
        if (ahead < 0.9) v *= oncoming ? 0.7 : 0.4;
      }
    };
    avoid(along, across, false);
    for (const o of this.peds) {
      if (o === pd || o === pd.buddy || o.lead || o.axis !== pd.axis) continue;
      if (Math.abs(o.line + o.off - pd.line - pd.off) > 1.5 || Math.abs(o.t - pd.t) > 3.5) continue;
      avoid(o.t, o.line + o.off, o.state === 'walk' && o.dir !== pd.dir);
    }
    if (!inRoad) {
      // street furniture straight ahead: step to whichever side of it keeps us on the sidewalk
      const l = pd.line + target;
      const a0 = pd.t, a1 = pd.t + pd.dir * 2.2;
      const r = 0.34;
      const [minA, maxA] = a0 < a1 ? [a0, a1] : [a1, a0];
      const hits = pd.axis === 'x' ? this.grid.query(minA, l - r, maxA, l + r, _rects) : this.grid.query(l - r, minA, l + r, maxA, _rects);
      if (hits.length) {
        let lo = Infinity, hi = -Infinity;
        for (const h of hits) {
          lo = Math.min(lo, pd.axis === 'x' ? h.minZ : h.minX);
          hi = Math.max(hi, pd.axis === 'x' ? h.maxZ : h.maxX);
        }
        const opts = [lo - r - 0.05, hi + r + 0.05].filter((x) => Math.abs(this.clampLine(pd, x) - x) < 0.01);
        if (opts.length) target = opts.sort((x, y) => Math.abs(x - l) - Math.abs(y - l))[0] - pd.line;
        else v *= 0.3;
      }
    }
    target = this.clampLine(pd, pd.line + target) - pd.line;
    if (inRoad || (pd.state === 'walk' && v > 0 && this.nearKerb(pd) < 3)) {
      // on the crosswalk: keep within the painted band (0.4–3.4 m in from the kerb line). While
      // queueing, keep to its outer part so the cluster waiting to cross the other road (which
      // stands within 1.2 m of its own kerb) stays a separate group at the corner.
      const h = sideHalf(pd.axis);
      const a = pd.c + pd.s * (h + (queue ? 1.5 : 0.6)), b = pd.c + pd.s * (h + 3.2);
      target = THREE.MathUtils.clamp(pd.line + target, Math.min(a, b), Math.max(a, b)) - pd.line;
    }
    pd.off += THREE.MathUtils.clamp(target - pd.off, -1.1 * dt, 1.1 * dt);
    pd.t += pd.dir * v * dt;
    pd.v0 = v;
    pd.p.setSpeed(Math.max(v, 0.3));
    const turn = THREE.MathUtils.clamp((target - pd.off) * 0.6, -0.4, 0.4) * (pd.axis === 'x' ? -1 : 1) * pd.dir;
    pd.yaw = yawOf(pd.axis, pd.dir) + turn;
  }
  /** companions walk shoulder to shoulder, or stand facing the leader while talking */
  private follow(f: Ped, l: Ped) {
    const lp = l.pos;
    f.axis = l.axis;
    f.dir = l.dir;
    f.c = l.c;
    f.s = l.s;
    // work in (along, across) sidewalk coordinates so the companion stays on the sidewalk
    const la = l.axis === 'x' ? lp.x : lp.z, lc = l.axis === 'x' ? lp.z : lp.x;
    const leftSign = (l.axis === 'x' ? -1 : 1) * l.dir;
    let fa = la, fc = lc;
    const talk = l.state === 'stand';
    if (talk) fa = la + l.dir * 0.95; // face to face along the sidewalk
    else {
      fc = lc + leftSign * 0.62; // shoulder to shoulder, on the leader's left if there is room
      if (Math.abs(this.clampLine(l, fc) - fc) > 0.01) fc = lc - leftSign * 0.62;
      fc = this.clampLine(l, fc);
    }
    f.pos.set(l.axis === 'x' ? fa : fc, lp.y, l.axis === 'x' ? fc : fa);
    if (talk || l.v0 < 0.05) {
      if (f.p.activity === 'walk') f.p.setActivity(talk ? 'talk' : 'idle', 1.3);
      f.rot = talk ? yawOf(l.axis, -l.dir) : l.yaw;
    } else {
      if (f.p.activity !== 'walk') f.p.setActivity('walk', 0.3);
      f.p.setSpeed(l.v0);
      f.rot = l.yaw;
    }
  }
}
