import * as THREE from 'three';
import { AX, SZ, BX, BZ, LX, LZ, SW, CURB } from './common';
import { wetSurface } from '../lighting';
import { Rng, hashN } from '../rng';

/**
 * NYC ground surfaces: sidewalk flags, granite curbs with ADA corner ramps, asphalt roadway,
 * painted markings and the flush street hardware (cellar doors, vault lights, subway grates,
 * utility covers, catch basins, steel plates). Research: docs/research/nyc-ground.md.
 *
 * Per chunk this is five draw calls: road, sidewalk (+ramps), curb, markings, fixtures.
 * Colour, wear and per-flag variation are computed in the shaders from world position, so
 * nothing tiles; the CC0 scans (public/assets/ground/*.webp, packed as luminance / roughness /
 * normal xy) only add the fine surface detail.
 *
 * Hooks used by nyc.ts: groundBase() (road, sidewalk, curb, ramps, markings) and
 * groundDetails() (flush fixtures, after the buildings so cellar doors avoid entrances).
 * streetprops.subway() finds the sidewalk / road planes by their PlaneGeometry size: both keep
 * the sizes BX*2 × BZ*2 and AX × SZ, and the shaders only use world position, so its cut works.
 */

// ---------------------------------------------------------------- layout (chunk-local metres)

/** sidewalk flag: 5 ft */
export const FLAG = 1.5;
/** kerb corner radius */
const CR = 1.0;
/** granite curb top width */
const CW = 0.18;
/** pedestrian ramp: centre from the corner along the kerb, clear width, run, side flare */
const RO = 2.2, RW = 1.4, RL = 1.8, RF = 0.4;
/** ramp bottom lip height above the road */
const RLIP = 0.02;
/** crosswalks: across the avenue (z band) and across the street (x band), as distances from the block corner */
const XW_IN = 3.6, XW_OUT = -0.5; // band from kerb-3.6 to kerb+0.5 along the kerb
/** stop bar: distance before the crosswalk, width */
const STOP_GAP = 0.3, STOP_W = 0.45;

/** true if a box (centre x,z, size w×d, chunk-local) touches a corner ramp — for props placement */
export function onRamp(x: number, z: number, w = 0, d = 0) {
  const ax = Math.abs(x), az = Math.abs(z);
  const dx = BX - ax, dz = BZ - az;
  const pad = 0.15;
  // avenue-side ramp: inset dx, along dz
  if (dx - w / 2 < RL + pad && Math.abs(dz - RO) < RW / 2 + RF + d / 2 + pad) return true;
  if (dz - d / 2 < RL + pad && Math.abs(dx - RO) < RW / 2 + RF + w / 2 + pad) return true;
  return false;
}

// ---------------------------------------------------------------- textures

const loader = new THREE.TextureLoader();
const U = {
  gCon: { value: new THREE.Texture() },
  gAsp: { value: new THREE.Texture() },
  gGra: { value: new THREE.Texture() },
  gSet: { value: new THREE.Texture() },
  gReady: { value: 0 },
  gWet: { value: 0 },
  gPuddle: { value: 0 },
  gSnow: { value: 0 },
};
/**
 * Weather hook (for weather.ts): write `.value` every frame (0..1). wet darkens and glosses every
 * ground surface, puddles fill the gutters, wheel ruts and low spots with mirror-flat water, snow
 * settles on top (thinner in the wheel tracks and on the walking line).
 */
export const groundWeather = { wet: U.gWet, puddles: U.gPuddle, snow: U.gSnow };
let texPromise: Promise<void> | null = null;
/** resolves when the ground scans have loaded */
export function groundReady() {
  if (texPromise) return texPromise;
  const base = `${import.meta.env.BASE_URL}assets/ground/`;
  const one = (name: string, key: keyof typeof U) =>
    new Promise<void>((res) => {
      loader.load(
        base + name,
        (t) => {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.colorSpace = THREE.NoColorSpace;
          t.anisotropy = 8;
          (U[key] as { value: THREE.Texture }).value = t;
          res();
        },
        undefined,
        () => res(),
      );
    });
  texPromise = Promise.all([one('concrete.webp', 'gCon'), one('asphalt.webp', 'gAsp'), one('granite.webp', 'gGra'), one('setts.webp', 'gSet')]).then(() => {
    U.gReady.value = 1;
  });
  return texPromise;
}

// ---------------------------------------------------------------- shaders

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);
const GLSL_CONST = `
#define G_AX ${f(AX)}
#define G_SZ ${f(SZ)}
#define G_BX ${f(BX)}
#define G_BZ ${f(BZ)}
#define G_SW ${f(SW)}
#define G_CR ${f(CR)}
#define G_CW ${f(CW)}
#define G_RO ${f(RO)}
#define G_RW ${f(RW)}
#define G_RL ${f(RL)}
#define G_RF ${f(RF)}
#define G_FLAG ${f(FLAG)}
`;

const GLSL_COMMON = /* glsl */ `
varying vec3 vGW;
varying vec3 vGN;
varying vec2 vGUv;
uniform float gReady;
uniform float gWet;
uniform float gPuddle;
uniform float gSnow;
float gH(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 gH2(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float gN(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3. - 2. * f);
  return mix(mix(gH(i), gH(i + vec2(1, 0)), u.x), mix(gH(i + vec2(0, 1)), gH(i + vec2(1, 1)), u.x), u.y);
}
float gFbm(vec2 p) { return gN(p) * .5 + gN(p * 2.03 + vec2(17.1, 3.3)) * .3 + gN(p * 4.11 + vec2(3.7, 9.1)) * .2; }
// a thin line of half width w (metres) at distance d, antialiased; fades out once thinner than a pixel
float gLine(float d, float w) { float fw = fwidth(d) + 1e-5; return (1. - smoothstep(w - fw, w + fw, d)) * min(1., w / fw); }
// weather on top of a surface: low = where water collects (0..1), clear = traffic/footfall that keeps snow off
void gWeather(inout vec3 alb, inout float rough, inout vec3 nW, float low, float clear) {
  if (gWet + gPuddle + gSnow < .001) return;
  vec2 w = vGW.xz;
  float pud = gPuddle * smoothstep(.62, .72, gFbm(w * .3 + 19.) * .55 + low * .6) * step(.97, vGN.y);
  alb *= 1. - .38 * gWet - .2 * pud;
  rough = mix(rough, .22, gWet * .75);
  rough = mix(rough, .02, pud);
  nW = normalize(mix(nW, vGN, max(pud, gWet * .5)));
  float sn = gSnow * smoothstep(.25, .6, gFbm(w * .9 + 5.) * .5 + gSnow * .7 - clear * .55) * smoothstep(.3, .9, vGN.y);
  alb = mix(alb, vec3(.78, .8, .83), sn);
  rough = mix(rough, .75, sn);
  nW = normalize(mix(nW, vGN, sn));
}
vec2 gChunk(vec2 w) { return floor(w / vec2(G_AX, G_SZ) + .5); }
// wheel tracks (x) and the oil strip down the lane centres (y), from world position
vec2 gLanes(vec2 w) {
  vec2 a = abs(w - gChunk(w) * vec2(G_AX, G_SZ));
  bool ave = a.x > G_BX, str = a.y > G_BZ;
  float ox = abs(a.x - G_AX * .5), oz = abs(a.y - G_SZ * .5);
  float tr = 0., oil = 0.;
  if (ave) {
    // one-way avenue: three 3.6 m lanes about the centre line, parking beyond 5.4 m
    tr = 1. - smoothstep(.1, .42, min(abs(ox - .85), min(abs(ox - 2.75), abs(ox - 4.45))));
    oil = 1. - smoothstep(.12, .55, min(ox, abs(ox - 3.6)));
  }
  if (str) {
    tr = max(tr, 1. - smoothstep(.1, .42, abs(oz - .85)));
    oil = max(oil, 1. - smoothstep(.12, .55, oz));
  }
  return vec2(tr, oil);
}
`;

const GLSL_SIDEWALK = /* glsl */ `
uniform sampler2D gCon;
void gEval(out vec3 alb, out float rough, out vec3 nW) {
  vec2 cid = gChunk(vGW.xz);
  vec2 lp = vGW.xz - cid * vec2(G_AX, G_SZ);
  vec2 d = vec2(G_BX, G_BZ) - abs(lp);
  bool ramp = vGN.y < .9995;
  // distance in from the kerb line, following the rounded corner
  vec2 cc = G_CR - d;
  float e = (d.x < G_CR && d.y < G_CR) ? G_CR - length(cc) : min(d.x, d.y);
  if (!ramp) {
    if (e < G_CW) discard; // under the curb top, and outside the corner radius
    float k1 = clamp((d.x - G_CW) / (G_RL - G_CW), 0., 1.);
    float k2 = clamp((d.y - G_CW) / (G_RL - G_CW), 0., 1.);
    if (d.x < G_RL && abs(d.y - G_RO) < G_RW * .5 + G_RF * (1. - k1)) discard;
    if (d.y < G_RL && abs(d.x - G_RO) < G_RW * .5 + G_RF * (1. - k2)) discard;
  }
  // 5 ft flags scored square to the kerb, counted in from the kerb lines
  vec2 q = step(0., lp);
  vec2 fd = d / G_FLAG;
  vec2 fid = floor(fd);
  vec2 fr = fract(fd);
  float jd = min(min(fr.x, 1. - fr.x), min(fr.y, 1. - fr.y)) * G_FLAG;
  jd = min(jd, abs(lp.x)); // where the mirrored grids meet mid-block
  vec2 ej = abs(fract(d / (4. * G_FLAG) + .5) - .5) * 4. * G_FLAG;
  float ejd = min(ej.x, ej.y);
  float seed = dot(cid, vec2(7.13, 3.71));
  vec2 key = fid + q * vec2(101.3, 57.9) + seed + (ramp ? 500. : 0.);
  float h1 = gH(key), h2 = gH(key + 31.7), h3 = gH(key + 63.1), h4 = gH(key + 97.3);
  // block style: standard grey, dark tinted (silicon-carbide) or sand-coloured concrete
  float st = gH(cid * 1.37 + .5);
  bool tinted = st < .16;
  vec3 base = tinted ? vec3(.085, .085, .09) : st < .24 ? vec3(.37, .31, .22) : vec3(.46, .43, .375);
  float tone = mix(.88, 1.06, h1);
  vec3 tint = vec3(1.);
  if (h2 < .1 || ramp) { tone = 1.1; tint = vec3(.98, 1., 1.03); }      // a replaced flag: newer, cleaner
  else if (h2 > .86) { tone *= .86; tint = vec3(1.05, 1., .92); }        // an old stained one
  vec4 t = mix(vec4(.5, .85, .5, .5), texture2D(gCon, vGW.xz / 4. + vec2(h3, h4) * 17.), gReady);
  alb = base * tint * tone * mix(1., t.r * 2., .7);
  // grime: large blotches, along the building line and the kerb
  float bd = length(max(vec2(G_SW) - d, 0.));
  alb *= .86 + .26 * gFbm(vGW.xz * .3);
  float nearB = 1. - smoothstep(0., .5, bd);
  float nearK = 1. - smoothstep(G_CW, G_CW + .6, e);
  alb *= 1. - .2 * nearB - .12 * nearK;
  float walk = smoothstep(.8, 1.6, bd) * smoothstep(.6, 1.6, e);
  rough = mix(.95, .8, walk * .7);
  rough = mix(rough, t.g, .3);
  // spills and drips
  float stn = clamp(smoothstep(.6, .8, gFbm(vGW.xz * .9 + 31.)) * (.45 + nearK + .6 * nearB), 0., 1.);
  alb *= 1. - .32 * stn;
  alb *= mix(vec3(1.), vec3(1.04, .97, .86), stn);
  rough = mix(rough, .7, stn * .5);
  // chewing gum: small dark discs, thickest at the corners and by the doors
  float C = .2;
  vec2 cell = floor(vGW.xz / C);
  float dens = .1 + .4 * nearB + .3 * (1. - smoothstep(0., 4., min(d.x, d.y)));
  if (gH(cell + 5.3) < dens) {
    vec2 c = (cell + .15 + .7 * gH2(cell)) * C;
    float rad = .007 + .011 * gH(cell + 9.1);
    float gum = gLine(length(vGW.xz - c), rad);
    alb = mix(alb, tinted ? vec3(.13) : vec3(.05, .048, .046), gum * .8);
    rough = mix(rough, .5, gum);
  }
  if (tinted) {
    // silicon carbide sparkle
    float sp = step(.985, gH(floor(vGW.xz * 300.)));
    rough = mix(rough, .25, sp);
  }
  // a hairline crack across some flags
  if (h4 < .22 && !ramp) {
    vec2 a0 = vec2(h1, 0.), b0 = vec2(h3, 1.);
    if (h2 > .5) { a0 = a0.yx; b0 = b0.yx; }
    vec2 p = fr + (vec2(gN(fr * 6. + h1 * 9.), gN(fr * 6. + 5. + h3 * 9.)) - .5) * .14;
    vec2 ab = b0 - a0;
    float tt = clamp(dot(p - a0, ab) / dot(ab, ab), 0., 1.);
    float crack = gLine(length(p - a0 - ab * tt) * G_FLAG, .0022);
    alb *= 1. - .75 * crack;
  }
  float groove = 0.;
  if (!ramp) {
    // scored joints (dirt-filled) and an asphalt-filled expansion joint every fourth flag
    float j = gLine(jd, .0045);
    float jx = gLine(ejd, .007);
    alb *= 1. - .55 * j;
    alb = mix(alb, vec3(.025), jx * .85);
    rough = mix(rough, 1., j);
    // chipped arrises: a slightly lighter, rougher band along some joints
    float chip = smoothstep(.72, .8, gN(vGW.xz * 4.)) * gLine(jd, .02);
    alb *= 1. + .12 * chip;
    groove = j;
  } else {
    // ramps are broom-finished across the slope
    float b = gN(vec2(dot(vGW.xz, vec2(1.)) * 30., 0.));
    alb *= .95 + .1 * b;
  }
  vec2 tn = (t.ba * 2. - 1.) * .9;
  vec2 tilt = (vec2(h3, h4) - .5) * .025; // flags settle unevenly: catches the light in the sheen
  nW = normalize(vGN + vec3(tn.x + tilt.x, 0., tn.y + tilt.y));
  gWeather(alb, rough, nW, nearK * .5 + groove * .3, walk * .6);
}
`;

const GLSL_ROAD = /* glsl */ `
uniform sampler2D gAsp;
uniform sampler2D gSet;
void gEval(out vec3 alb, out float rough, out vec3 nW) {
  vec2 w = vGW.xz;
  vec2 cid = gChunk(w);
  vec2 a = abs(w - cid * vec2(G_AX, G_SZ));
  bool ave = a.x > G_BX, str = a.y > G_BZ;
  // two rotated, differently scaled samples of the scan, blended by noise: it never tiles
  vec4 t1 = texture2D(gAsp, w / 2.08);
  vec4 t2 = texture2D(gAsp, mat2(.8, .6, -.6, .8) * w / 2.71 + .37);
  vec4 t = mix(vec4(.5, .7, .5, .5), mix(t1, t2, smoothstep(.3, .7, gN(w * .23))), gReady);
  alb = vec3(.08, .079, .08) * mix(1., t.r * 2., .95);
  rough = mix(.92, t.g, .35);
  vec2 tn = t.ba * 2. - 1.;
  float nk = 1.;
#ifdef G_COBBLE
  if (str && !ave) {
    // Belgian block: granite setts across the street
    vec4 s = mix(vec4(.5, .9, .5, .5), texture2D(gSet, w / 2.), gReady);
    alb = vec3(.085, .078, .07) * mix(1., s.r * 2., 1.1);
    rough = mix(.85, s.g, .6);
    tn = (s.ba * 2. - 1.) * 1.6;
  }
#endif
  // resurfacing campaigns: large tone shifts
  alb *= .8 + .4 * gFbm(w * .045 + 7.);
  vec2 ln = gLanes(w);
  alb *= 1. + .12 * ln.x;
  rough = mix(rough, .6, ln.x * .6);
  alb *= 1. - .4 * ln.y * smoothstep(.35, .75, gFbm(w * 1.3 + 3.));
  // oil drips under the parked cars
  {
    float ox = abs(a.x - G_AX * .5), oz = abs(a.y - G_SZ * .5);
    float pk = (ave && !str) ? 1. - smoothstep(.3, .9, abs(ox - 6.85)) : (str && !ave) ? 1. - smoothstep(.3, .9, abs(oz - 3.85)) : 0.;
    float drip = pk * smoothstep(.62, .8, gFbm(w * vec2(2.2, 2.2) + 41.));
    alb *= 1. - .45 * drip;
    rough = mix(rough, .45, drip);
  }
  // utility cuts: saw-cut rectangular patches, fresh black or old grey, often tar-sealed at the edge
  float seal = 0.;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 S = i == 0 ? vec2(5.3, 3.7) : i == 1 ? vec2(9.1, 6.3) : vec2(2.9, 15.);
    if (i == 2 && ave == false) S = S.yx;
    vec2 o = vec2(fi * 1.73, fi * 2.11);
    vec2 cell = floor((w + o) / S);
    float hp = gH(cell + fi * 13.1);
    if (hp < .26) {
      vec2 hs = S * (.16 + .3 * gH2(cell + 7.7 + fi));
      vec2 cen = (cell + .5) * S - o + (gH2(cell + 3.3) - .5) * (S - 2. * hs);
      vec2 q2 = abs(w - cen) - hs;
      float sd = max(q2.x, q2.y);
      if (sd < 0.) {
        if (hp < .12) { alb *= .62; rough = mix(rough, .82, .5); }
        else { alb *= 1.28; alb = mix(alb, alb * vec3(1.02, 1., .95), .5); }
        nk = .6;
      }
      seal = max(seal, gLine(abs(sd), .02) * step(.4, gH(cell + 1.9)));
    }
  }
  // crack sealant: meandering glossy black lines
  float cn = gFbm(w * .42 + 11.);
  seal = max(seal, gLine(abs(cn - .5) * 2.4, .009) * smoothstep(.6, .72, gN(w * .06 + 4.)));
  // gutter: grit, leaves and wet silt in the last half metre at the kerb
  float dk = (ave && str) ? length(max(a - vec2(G_BX, G_BZ), 0.)) : ave ? a.x - G_BX : a.y - G_BZ;
  float gut = 1. - smoothstep(.12, .6, dk + (gN(w * 2.) - .5) * .25);
  alb = mix(alb, alb * vec3(.8, .77, .72), gut * .8);
  // grit and litter specks
  vec2 gc = floor(w * 22.);
  float sp = gH(gc + 3.);
  float dotm = gLine(length(w - (gc + .2 + .6 * gH2(gc)) / 22.), .004 + .007 * gH(gc + 8.)) * step(.5, sp);
  alb *= 1. + gut * dotm * (sp > .8 ? 1.2 : -.6);
  rough = mix(rough, .72, gut * .5);
  alb = mix(alb, vec3(.012), seal * .92);
  rough = mix(rough, .5, seal);
  nW = normalize(vGN + vec3(tn.x, 0., tn.y) * .8 * nk * (1. - seal * .8));
  gWeather(alb, rough, nW, gut + ln.x * .35, ln.x + ln.y * .5);
}
`;

const GLSL_CURB = /* glsl */ `
uniform sampler2D gGra;
void gEval(out vec3 alb, out float rough, out vec3 nW) {
  vec2 cid = gChunk(vGW.xz);
  float u = vGUv.x, v = vGUv.y;
  float SL = 2.13;
  float stone = floor(u / SL);
  float hs = gH(vec2(stone, 3.) + cid * 3.1);
  float fu = fract(u / SL) * SL;
  vec4 t = mix(vec4(.5, .6, .5, .5), texture2D(gGra, vec2(u, v) / .8 + hs * 7.), gReady);
  alb = vec3(.27, .265, .26) * mix(.8, 1.12, hs) * mix(1., t.r * 2., .8);
  rough = mix(.7, t.g, .5);
  // the top outer arris: steel-faced kerb on some blocks, chipped granite on the rest
  float edge = smoothstep(${f(CW - 0.04)}, ${f(CW - 0.02)}, v) * (1. - smoothstep(${f(CW + 0.035)}, ${f(CW + 0.06)}, v));
  if (gH(cid * 2.7 + 1.) < .45) {
    vec3 steel = vec3(.045, .04, .036) + vec3(.07, .035, .012) * gN(vec2(u * 3., v * 30.));
    alb = mix(alb, steel, edge);
    rough = mix(rough, .4, edge);
  } else {
    float ch = smoothstep(.6, .7, gN(vec2(u * 6., 1.)));
    alb *= 1. - .35 * ch * edge;
    alb *= 1. + .15 * ch * edge;
  }
  // stone joints, grime low on the face and along the top
  alb *= 1. - .6 * gLine(min(fu, SL - fu), .004);
  alb *= mix(.6, 1., smoothstep(0., .1, vGW.y));
  alb *= .85 + .2 * gFbm(vec2(u * .7, v * 3.));
  vec2 tn = (t.ba * 2. - 1.) * .5;
  nW = normalize(vGN + vec3(tn.x, tn.y, 0.) * (1. - abs(vGN.y)) + vec3(tn.x, 0., tn.y) * abs(vGN.y));
  gWeather(alb, rough, nW, 0., 0.);
}
`;

function hook(m: THREE.MeshStandardMaterial, kind: string, body: string, defines: Record<string, string> = {}) {
  m.userData.pbr = true; // bake() keeps it in its own bucket
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    Object.assign((sh.defines ??= {}), defines);
    sh.vertexShader = 'varying vec3 vGW;\nvarying vec3 vGN;\nvarying vec2 vGUv;\n' + sh.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
vGW = (modelMatrix * vec4(transformed, 1.0)).xyz;
vGN = normalize(mat3(modelMatrix) * objectNormal);
vGUv = uv;`,
    );
    // our code goes *before* the includes, so wetSurface()'s additions (after them) still apply on top
    sh.fragmentShader = GLSL_CONST + GLSL_COMMON + body + sh.fragmentShader
      .replace('#include <color_fragment>', 'vec3 gAlb; float gRough; vec3 gNW;\ngEval(gAlb, gRough, gNW);\ndiffuseColor.rgb = gAlb;\n#include <color_fragment>')
      .replace('#include <roughnessmap_fragment>', '#define roughness gRough\n#include <roughnessmap_fragment>\n#undef roughness')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(gNW, 0.0)).xyz);\n#include <normal_fragment_maps>');
  };
  m.customProgramCacheKey = () => `nycground|${kind}|${Object.keys(defines).join(',')}`;
  return m;
}

const mats: Record<string, THREE.MeshStandardMaterial> = {};
export const GM = {
  sidewalk: () => (mats.sw ??= wetSurface(hook(new THREE.MeshStandardMaterial({ envMapIntensity: 0.35 }), 'sw', GLSL_SIDEWALK), 0.55)),
  road: () => (mats.rd ??= wetSurface(hook(new THREE.MeshStandardMaterial({ envMapIntensity: 0.6 }), 'rd', GLSL_ROAD))),
  cobbleRoad: () => (mats.rc ??= wetSurface(hook(new THREE.MeshStandardMaterial({ envMapIntensity: 0.6 }), 'rc', GLSL_ROAD, { G_COBBLE: '1' }))),
  curb: () => (mats.cb ??= wetSurface(hook(new THREE.MeshStandardMaterial({ envMapIntensity: 0.6 }), 'cb', GLSL_CURB), 0.5)),
  markings: () => (mats.mk ??= markingsMaterial()),
  fixtures: () => (mats.fx ??= fixturesMaterial()),
};

// ---------------------------------------------------------------- road markings

/** one canvas: a solid block for the lines and bars, and the elongated lane legends */
const MK_W = 1024, MK_H = 512;
const MK = {
  solid: [0, 0, 16, 16],
  BUS: [32, 0, 300, 512],
  ONLY: [352, 0, 400, 512],
  arrow: [784, 0, 220, 512],
} as const;
let markTex: THREE.CanvasTexture | null = null;
function markingsTexture() {
  if (markTex) return markTex;
  const c = document.createElement('canvas');
  c.width = MK_W;
  c.height = MK_H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 16, 16);
  const word = (s: string, r: readonly number[]) => {
    g.save();
    g.font = 'bold 120px "Arial Narrow", "Liberation Sans Narrow", Arial, sans-serif';
    const m = g.measureText(s);
    const sx = (r[2] - 12) / m.width;
    g.translate(r[0] + 6, r[1] + r[3] - 8);
    // the legend is stretched along the lane so drivers read it foreshortened
    g.scale(sx, (r[3] - 16) / 88);
    g.fillText(s, 0, 0);
    g.restore();
  };
  word('BUS', MK.BUS);
  word('ONLY', MK.ONLY);
  // straight-ahead arrow
  const [ax, ay, aw, ah] = MK.arrow;
  g.beginPath();
  g.moveTo(ax + aw / 2, ay + 6);
  g.lineTo(ax + aw - 10, ay + ah * 0.32);
  g.lineTo(ax + aw * 0.62, ay + ah * 0.32);
  g.lineTo(ax + aw * 0.62, ay + ah - 6);
  g.lineTo(ax + aw * 0.38, ay + ah - 6);
  g.lineTo(ax + aw * 0.38, ay + ah * 0.32);
  g.lineTo(ax + 10, ay + ah * 0.32);
  g.closePath();
  g.fill();
  markTex = new THREE.CanvasTexture(c);
  markTex.colorSpace = THREE.SRGBColorSpace;
  markTex.anisotropy = 8;
  return markTex;
}

function markingsMaterial() {
  const m = new THREE.MeshStandardMaterial({ map: markingsTexture(), vertexColors: true, transparent: true, depthWrite: false, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = 'varying vec3 vGW;\nvarying vec3 vGN;\nvarying vec2 vGUv;\n' + sh.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
vGW = (modelMatrix * vec4(transformed, 1.0)).xyz;
vGN = vec3(0., 1., 0.);
vGUv = uv;`,
    );
    sh.fragmentShader = GLSL_CONST + GLSL_COMMON + /* glsl */ `
float gWear() {
  vec2 w = vGW.xz;
  // thermoplastic crazes into plates
  vec2 p = w / .26;
  vec2 i = floor(p), fp = fract(p);
  float d1 = 8., d2 = 8.;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    float d = length(g + gH2(i + g) - fp);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  float craze = gLine((d2 - d1) * .26, .003) * smoothstep(.35, .6, gN(w * .8 + 2.));
  float tr = gLanes(w).x;
  float chip = max(smoothstep(.7, .75, gFbm(w * 5.3 + 5.)), smoothstep(.62, .7, gFbm(w * 2.7 + 9.)) * tr * .8);
  return (1. - craze * .8) * (1. - chip) * (.72 + .28 * gN(w * .6));
}
` + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.a *= gWear() * (1. - gSnow * .85);
diffuseColor.rgb *= .82 + .18 * gN(vGW.xz * 2.3);`);
  };
  m.customProgramCacheKey = () => 'nycground|mk';
  return wetSurface(m, 0.7);
}

class QuadBuf {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /**
   * Axis-aligned quad on the ground at height y: x0..x1, z0..z1 (chunk-local). `r` is a pixel rect
   * of a W×H canvas; `up` is the direction (+x,-x,+z,-z) the top of the texture region points to.
   */
  quad(x0: number, z0: number, x1: number, z1: number, y: number, r: readonly number[], W: number, H: number, up: 'x' | '-x' | 'z' | '-z' = '-z', c?: THREE.Color, yFn?: (x: number, z: number) => number) {
    const u0 = r[0] / W, u1 = (r[0] + r[2]) / W, vTop = 1 - r[1] / H, vBot = 1 - (r[1] + r[3]) / H;
    const corners: [number, number][] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    const b = this.pos.length / 3;
    for (const [x, z] of corners) {
      // texture coordinates by orientation: 'up' is where v grows
      let s: number, t: number;
      const fx = (x - x0) / (x1 - x0), fz = (z - z0) / (z1 - z0);
      if (up === '-z') { s = fx; t = 1 - fz; }
      else if (up === 'z') { s = 1 - fx; t = fz; }
      else if (up === 'x') { s = fz; t = fx; }
      else { s = 1 - fz; t = 1 - fx; }
      this.pos.push(x, yFn ? yFn(x, z) : y, z);
      this.nor.push(0, 1, 0);
      this.uv.push(u0 + (u1 - u0) * s, vBot + (vTop - vBot) * t);
      if (c) this.col.push(c.r, c.g, c.b);
    }
    this.idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    // flip any quad that faces down
    g.computeVertexNormals();
    const n = g.getAttribute('normal');
    const ix = g.index!.array as Uint32Array | Uint16Array;
    for (let i = 0; i < ix.length; i += 3) {
      if (n.getY(ix[i]) < 0) { const tmp = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = tmp; }
    }
    g.computeVertexNormals();
    return g;
  }
}

const WHITE = new THREE.Color('#e9e7df');
const BUSRED = new THREE.Color('#a24a3a');

/** One-way directions, matching vehicles.ts: avenue k (x = (k+0.5)·AX) and street k (z = (k+0.5)·SZ). */
const aveDir = (k: number) => (k % 2 === 0 ? -1 : 1);
const strDir = (k: number) => (k % 2 === 0 ? 1 : -1);
const busAve = (k: number) => hashN(k, 7311) % 3 === 0;

function markings(cx: number, cz: number) {
  const q = new QuadBuf();
  const Y = 0.004;
  const S = MK.solid, W = MK_W, H = MK_H;
  const xs = AX / 2, zs = SZ / 2;
  // crosswalks: high-visibility bars (0.6 m wide, 0.6 m gaps) centred on the roadway centre line
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    // across the avenue, in line with the street sidewalk: bars run along z
    const z0 = sz * (BZ - XW_IN), z1 = sz * (BZ - XW_OUT);
    for (let i = 0; ; i++) {
      const c = xs - (0.6 + 1.2 * i);
      if (c - 0.3 < BX + 0.35) break;
      q.quad(sx * (c - 0.3), Math.min(z0, z1), sx * (c + 0.3), Math.max(z0, z1), Y, S, W, H, '-z', WHITE);
    }
    // across the street: bars run along x
    const x0 = sx * (BX - XW_IN), x1 = sx * (BX - XW_OUT);
    for (let i = 0; ; i++) {
      const c = zs - (0.6 + 1.2 * i);
      if (c - 0.3 < BZ + 0.35) break;
      q.quad(Math.min(x0, x1), sz * (c - 0.3), Math.max(x0, x1), sz * (c + 0.3), Y, S, W, H, '-z', WHITE);
    }
  }
  // avenues: this chunk holds the east half of avenue k=cx-1 (x<0 side) and the west half of avenue k=cx
  for (const sx of [-1, 1]) {
    const k = sx > 0 ? cx : cx - 1;
    const dir = aveDir(k);
    const avx = sx * xs; // the avenue centre line
    // stop bar on the approach side of each intersection
    for (const sz of [-1, 1]) {
      if (dir !== sz) continue;
      const zb = sz * (BZ - XW_IN - STOP_GAP);
      q.quad(Math.min(sx * (BX + 0.3), avx), Math.min(zb, zb - sz * STOP_W), Math.max(sx * (BX + 0.3), avx), Math.max(zb, zb - sz * STOP_W), Y, S, W, H, '-z', WHITE);
    }
    // broken lane lines (3 m dash, 9 m gap) at 1.8 m and 5.4 m from the centre line, phased in world z
    const zA = -(BZ - XW_IN - STOP_GAP - STOP_W - 1), zB = -zA;
    const oz = cz * SZ;
    for (const off of [1.8, 5.4]) {
      const lx = avx - sx * off;
      for (let wz = Math.ceil((oz + zA) / 12) * 12; wz < oz + zB; wz += 12) {
        const a = Math.max(wz - oz, zA), b = Math.min(wz - oz + 3, zB);
        if (b > a) q.quad(lx - 0.06, a, lx + 0.06, b, Y, S, W, H, '-z', WHITE);
      }
    }
    // a red offset bus lane (1.8–5.4 m from the centre line) on the west side of some avenues
    if (sx > 0 && busAve(k)) {
      const l0 = avx - 5.34, l1 = avx - 1.86;
      q.quad(l0, zA, l1, zB, Y - 0.0005, S, W, H, '-z', BUSRED);
      // BUS / ONLY legends read in the direction of travel, near the far end of the block
      const lc = (l0 + l1) / 2;
      const zEnd = dir > 0 ? zB - 6 : zA + 6;
      const up = dir > 0 ? 'z' : '-z';
      const word = (zc: number, r: readonly number[], len: number, wd: number) => q.quad(lc - wd / 2, zc - len / 2, lc + wd / 2, zc + len / 2, Y + 0.0004, r, W, H, up, WHITE);
      word(zEnd, MK.ONLY, 2.6, 2.2);
      word(zEnd - dir * 3.6, MK.BUS, 2.6, 1.7);
    } else if (!busAve(k)) {
      // straight-ahead arrows before the stop bar (the centre lane straddles the chunk edge: drawn by the x>0 half)
      const zEnd = dir > 0 ? zB - 7 : zA + 7;
      for (const off of sx > 0 ? [0, 3.6] : [3.6]) q.quad(avx - sx * off - 0.45, zEnd - 2.2, avx - sx * off + 0.45, zEnd + 2.2, Y, MK.arrow, W, H, dir > 0 ? 'z' : '-z', WHITE);
    }
  }
  // streets: stop bars across this chunk's half of each one-way street
  for (const sz of [-1, 1]) {
    const k = sz > 0 ? cz : cz - 1;
    const dir = strDir(k);
    const stz = sz * zs;
    for (const sx of [-1, 1]) {
      if (dir !== sx) continue;
      const xb = sx * (BX - XW_IN - STOP_GAP);
      q.quad(Math.min(xb, xb - sx * STOP_W), Math.min(sz * (BZ + 0.3), stz), Math.max(xb, xb - sx * STOP_W), Math.max(sz * (BZ + 0.3), stz), Y, S, W, H, '-z', WHITE);
    }
  }
  const mesh = new THREE.Mesh(q.geometry(), GM.markings());
  mesh.receiveShadow = true;
  mesh.userData.owned = true;
  mesh.renderOrder = 1;
  return mesh;
}

// ---------------------------------------------------------------- curb and ramps

/** ramp centres along each corner's two kerbs, as (distance from corner) — same for every corner */
function curbHeight(t: number) {
  // t: distance along the straight kerb from the corner's tangent point (≥ 0), mirrored per corner
  const c = RO;
  const dd = Math.abs(t - c);
  if (dd <= RW / 2) return RLIP;
  if (dd >= RW / 2 + RF) return CURB;
  return RLIP + ((CURB - RLIP) * (dd - RW / 2)) / RF;
}

function curbGeometry() {
  // the kerb line as a rounded rectangle, walked counter-clockwise from (BX, 0)
  type P = { x: number; z: number; nx: number; nz: number; h: number };
  const pts: P[] = [];
  const corners: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  const breaks = (L: number) => {
    // sample distances along a straight from the corner: ramp breakpoints and every ~2 m
    const s = new Set<number>([0, L]);
    for (const v of [RO - RW / 2 - RF, RO - RW / 2, RO + RW / 2, RO + RW / 2 + RF]) if (v > 0 && v < L) s.add(v);
    for (let v = 2; v < L; v += 2) s.add(v);
    return [...s].sort((a, b) => a - b);
  };
  // straights: each side runs between two corners; distances from the nearer corner drive the ramp height
  const side = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number) => {
    const L = Math.hypot(bx - ax, bz - az);
    const ts = new Set<number>();
    for (const v of breaks(L / 2)) { ts.add(v); ts.add(L - v); }
    for (const t of [...ts].sort((a, b) => a - b)) {
      const k = t / L;
      pts.push({ x: ax + (bx - ax) * k, z: az + (bz - az) * k, nx, nz, h: curbHeight(Math.min(t, L - t) + CR) });
    }
  };
  const arc = (sx: number, sz: number, a0: number) => {
    const cxp = sx * (BX - CR), czp = sz * (BZ - CR);
    for (let i = 1; i < 8; i++) {
      const a = a0 + (i / 8) * (Math.PI / 2);
      pts.push({ x: cxp + Math.cos(a) * CR, z: czp + Math.sin(a) * CR, nx: Math.cos(a), nz: Math.sin(a), h: CURB });
    }
  };
  // east side (x=BX) from z=-(BZ-CR) to +(BZ-CR), then the NE corner arc, etc.
  side(BX, -(BZ - CR), BX, BZ - CR, 1, 0);
  arc(1, 1, 0);
  side(BX - CR, BZ, -(BX - CR), BZ, 0, 1);
  arc(-1, 1, Math.PI / 2);
  side(-BX, BZ - CR, -BX, -(BZ - CR), -1, 0);
  arc(-1, -1, Math.PI);
  side(-(BX - CR), -BZ, BX - CR, -BZ, 0, -1);
  arc(1, -1, (3 * Math.PI) / 2);
  void corners;
  // profile: top (inner edge → arris), small chamfer, vertical face to the road
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const n = pts.length;
  let s = 0;
  const sArr: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    sArr.push(s);
  }
  const total = s + Math.hypot(pts[0].x - pts[n - 1].x, pts[0].z - pts[n - 1].z);
  const strip = (prof: (p: P) => [number, number, number, number][]) => {
    // prof gives, for one path point, the cross-section vertices [offset outward, y, v]; consecutive ones form a strip
    const b = pos.length / 3;
    const per = prof(pts[0]).length;
    for (let i = 0; i <= n; i++) {
      const p = pts[i % n];
      const su = i === n ? total : sArr[i];
      for (const [o, y, v] of prof(p)) {
        pos.push(p.x + p.nx * o, y, p.z + p.nz * o);
        uv.push(su, v);
      }
    }
    for (let i = 0; i < n; i++) for (let k = 0; k < per - 1; k++) {
      const a = b + i * per + k, c = b + (i + 1) * per + k;
      idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  };
  strip((p) => [[-CW, p.h, 0, 0], [-0.012, p.h, CW - 0.012, 0]]);
  strip((p) => [[-0.012, p.h, CW - 0.012, 0], [0, p.h - 0.012, CW + 0.005, 0]]);
  strip((p) => [[0, p.h - 0.012, CW + 0.005, 0], [0, -0.01, CW + 0.017 + p.h, 0]]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make sure the top faces up (winding)
  const nrm = g.getAttribute('normal');
  if (nrm.getY(0) < 0) {
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

/** corner ramps (sidewalk material) and their tactile pads (fixtures atlas) */
function ramps(fix: QuadBuf) {
  const pos: number[] = [];
  const yAt = (dIn: number) => RLIP + ((CURB - RLIP) * Math.min(1, Math.max(0, (dIn - CW) / (RL - CW))));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    for (const ave of [true, false]) {
      // (d inset from the kerb, t along the kerb from the corner) → chunk-local x,z
      const P = (d: number, t: number, y: number): [number, number, number] => (ave ? [sx * (BX - d), y, sz * (BZ - t)] : [sx * (BX - t), y, sz * (BZ - d)]);
      const t0 = RO - RW / 2, t1 = RO + RW / 2;
      const tri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
        // wind upward
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const ny = uz * vx - ux * vz;
        void uy; void vy;
        if (ny >= 0) pos.push(...a, ...b, ...c);
        else pos.push(...a, ...c, ...b);
      };
      const A = P(CW, t0, RLIP), B = P(CW, t1, RLIP), C = P(RL, t1, CURB), D = P(RL, t0, CURB);
      tri(A, B, C);
      tri(A, C, D);
      // flares
      tri(P(CW, t0 - RF, CURB), A, D);
      tri(B, P(CW, t1 + RF, CURB), C);
      // the strip under the curb top inside the flares stays at sidewalk height: fill the gap to the curb
      // truncated-dome pad, 0.61 m deep at the foot of the ramp
      const d0 = CW + 0.03, d1 = CW + 0.03 + 0.61;
      const pa = P(d0, t0 + 0.07, 0), pb = P(d1, t1 - 0.07, 0);
      const yFn = (x: number, z: number) => yAt(ave ? BX - Math.abs(x) : BZ - Math.abs(z)) + 0.004;
      fix.quad(Math.min(pa[0], pb[0]), Math.min(pa[2], pb[2]), Math.max(pa[0], pb[0]), Math.max(pa[2], pb[2]), 0, FX.domes, FX_N, FX_N, ave ? (sx > 0 ? 'x' : '-x') : sz > 0 ? 'z' : '-z', undefined, yFn);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- flush fixtures atlas

/** atlas of cast-iron and steel street hardware, 4×4 tiles of 256 px */
const FX_N = 1024, T = 256;
const tile = (i: number, j: number, w = 1, h = 1) => [i * T + 2, j * T + 2, w * T - 4, h * T - 4] as const;
const FX = {
  cellar: tile(0, 0),
  grate: tile(1, 0),
  vault: tile(2, 0),
  coned: tile(3, 0),
  water: tile(0, 1),
  domes: tile(1, 1),
  basin: tile(2, 1),
  ecs: tile(3, 1),
  plate: tile(0, 2),
};
let fxTex: { map: THREE.Texture; normal: THREE.Texture; rm: THREE.Texture } | null = null;

function fixturesTextures() {
  if (fxTex) return fxTex;
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = c.height = FX_N;
    return c;
  };
  const cA = mk(), cH = mk(), cR = mk();
  const A = cA.getContext('2d')!, Hh = cH.getContext('2d')!, R = cR.getContext('2d')!;
  A.fillStyle = '#777';
  A.fillRect(0, 0, FX_N, FX_N);
  Hh.fillStyle = '#808080';
  Hh.fillRect(0, 0, FX_N, FX_N);
  // R: g = roughness, b = metalness
  R.fillStyle = 'rgb(0,200,0)';
  R.fillRect(0, 0, FX_N, FX_N);
  const rng = new Rng(4242);
  const rm = (r: number, m: number) => `rgb(0,${Math.round(r * 255)},${Math.round(m * 255)})`;
  const grey = (v: number) => `rgb(${v},${v},${v})`;
  /** run fn in the tile's metric frame: (0,0)-(wm,hm) metres */
  const inTile = (r: readonly number[], wm: number, hm: number, fn: (g: CanvasRenderingContext2D, layer: 'a' | 'h' | 'r') => void) => {
    for (const [g, layer] of [[A, 'a'], [Hh, 'h'], [R, 'r']] as const) {
      g.save();
      g.beginPath();
      g.rect(r[0], r[1], r[2], r[3]);
      g.clip();
      g.translate(r[0], r[1]);
      g.scale(r[2] / wm, r[3] / hm);
      fn(g, layer);
      g.restore();
    }
  };
  const speckle = (r: readonly number[], n: number, cols: string[], size: number) => {
    for (let i = 0; i < n; i++) {
      A.fillStyle = cols[i % cols.length];
      A.globalAlpha = 0.25 + 0.4 * rng.next();
      const s = size * (0.5 + rng.next());
      A.fillRect(r[0] + rng.next() * r[2], r[1] + rng.next() * r[3], s, s);
    }
    A.globalAlpha = 1;
  };
  const blotch = (r: readonly number[], n: number, col: string, rough: number, metal: number, size: number, alpha = 0.5) => {
    for (let i = 0; i < n; i++) {
      const x = r[0] + rng.next() * r[2], y = r[1] + rng.next() * r[3], s = size * (0.4 + rng.next());
      const gr = A.createRadialGradient(x, y, 0, x, y, s);
      gr.addColorStop(0, col);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      A.globalAlpha = alpha;
      A.fillStyle = gr;
      A.fillRect(x - s, y - s, 2 * s, 2 * s);
      R.globalAlpha = alpha;
      R.fillStyle = rm(rough, metal);
      R.beginPath();
      R.arc(x, y, s * 0.6, 0, Math.PI * 2);
      R.fill();
    }
    A.globalAlpha = 1;
    R.globalAlpha = 1;
  };

  // diamond-plate cellar door leaf 0.9 × 1.6 m: frame, tread, hinges, a ring handle
  inTile(FX.cellar, 0.9, 1.6, (g, l) => {
    g.fillStyle = l === 'a' ? '#5b5650' : l === 'h' ? grey(120) : rm(0.5, 0.75);
    g.fillRect(0, 0, 0.9, 1.6);
    for (let y = 0.04; y < 1.58; y += 0.035) for (let x = 0.04; x < 0.88; x += 0.035) {
      const flip = Math.round((x + y) / 0.035) % 2 === 0;
      g.save();
      g.translate(x, y);
      g.rotate(flip ? 0.6 : -0.6);
      g.fillStyle = l === 'a' ? '#6e6a63' : l === 'h' ? grey(190) : rm(0.35, 0.8);
      g.fillRect(-0.011, -0.003, 0.022, 0.006);
      g.restore();
    }
    g.strokeStyle = l === 'a' ? '#3a3632' : l === 'h' ? grey(150) : rm(0.6, 0.7);
    g.lineWidth = 0.035;
    g.strokeRect(0.0175, 0.0175, 0.865, 1.565);
    g.fillStyle = l === 'a' ? '#2d2a27' : l === 'h' ? grey(170) : rm(0.6, 0.7);
    for (const y of [0.25, 1.35]) g.fillRect(0.0, y - 0.06, 0.07, 0.12);
    g.beginPath();
    g.arc(0.78, 0.8, 0.05, 0, Math.PI * 2);
    g.lineWidth = 0.012;
    g.stroke();
  });
  blotch(FX.cellar, 14, '#6b3f22', 0.85, 0.2, 40, 0.55);
  speckle(FX.cellar, 400, ['#8d8880', '#3a342e'], 2);

  // subway ventilation grate panel 1.2 × 1.5 m: bars along the length every 2.5 cm, black void below
  inTile(FX.grate, 1.2, 1.5, (g, l) => {
    g.fillStyle = l === 'a' ? '#060606' : l === 'h' ? grey(20) : rm(1, 0);
    g.fillRect(0, 0, 1.2, 1.5);
    g.fillStyle = l === 'a' ? '#4f4c47' : l === 'h' ? grey(200) : rm(0.45, 0.85);
    for (let x = 0.035; x < 1.17; x += 0.025) g.fillRect(x, 0, 0.009, 1.5);
    for (let y = 0.05; y < 1.5; y += 0.1) g.fillRect(0, y, 1.2, 0.006);
    g.strokeStyle = g.fillStyle;
    g.lineWidth = 0.05;
    g.strokeRect(0.025, 0.025, 1.15, 1.45);
  });
  speckle(FX.grate, 300, ['#7a7064', '#2a2622'], 2);

  // vault lights 1 × 1 m: iron panel with round glass prisms (lavender with age), some replaced by concrete
  inTile(FX.vault, 1, 1, (g, l) => {
    g.fillStyle = l === 'a' ? '#3d3935' : l === 'h' ? grey(170) : rm(0.6, 0.6);
    g.fillRect(0, 0, 1, 1);
    const r2 = new Rng(77);
    for (let y = 0.06; y < 0.98; y += 0.098) for (let x = 0.06; x < 0.98; x += 0.098) {
      const broken = r2.next() < 0.12;
      g.beginPath();
      g.arc(x, y, 0.032, 0, Math.PI * 2);
      g.fillStyle = l === 'a' ? (broken ? '#8b877f' : r2.next() < 0.5 ? '#a99bb8' : '#9a92a0') : l === 'h' ? grey(broken ? 160 : 110) : broken ? rm(0.9, 0) : rm(0.12, 0);
      g.fill();
    }
  });
  speckle(FX.vault, 250, ['#6b6258', '#1e1b18'], 2);

  // Con Edison service box cover 0.6 × 0.9 m: rim, raised square grid, letters
  inTile(FX.coned, 0.6, 0.9, (g, l) => {
    g.fillStyle = l === 'a' ? '#3b3936' : l === 'h' ? grey(130) : rm(0.55, 0.7);
    g.fillRect(0, 0, 0.6, 0.9);
    g.fillStyle = l === 'a' ? '#4a4743' : l === 'h' ? grey(185) : rm(0.35, 0.8);
    for (let y = 0.05; y < 0.86; y += 0.04) for (let x = 0.05; x < 0.56; x += 0.04) g.fillRect(x, y, 0.025, 0.025);
    g.fillStyle = l === 'a' ? '#3b3936' : l === 'h' ? grey(130) : rm(0.55, 0.7);
    g.fillRect(0.12, 0.38, 0.36, 0.14);
    g.fillStyle = l === 'a' ? '#5a5650' : l === 'h' ? grey(200) : rm(0.3, 0.8);
    g.font = 'bold 0.08px Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText('CON ED', 0.3, 0.48);
    g.strokeStyle = l === 'a' ? '#2a2826' : l === 'h' ? grey(160) : rm(0.6, 0.6);
    g.lineWidth = 0.03;
    g.strokeRect(0.015, 0.015, 0.57, 0.87);
  });

  // round water-valve box cover 0.3 m, transparent outside the disc
  inTile(FX.water, 1, 1, (g, l) => {
    g.clearRect(0, 0, 1, 1);
    if (l === 'a') {
      g.fillStyle = 'rgba(0,0,0,0)';
    }
    g.beginPath();
    g.arc(0.5, 0.5, 0.48, 0, Math.PI * 2);
    g.fillStyle = l === 'a' ? '#36332f' : l === 'h' ? grey(140) : rm(0.5, 0.7);
    g.fill();
    g.fillStyle = l === 'a' ? '#57534d' : l === 'h' ? grey(200) : rm(0.3, 0.8);
    g.font = 'bold 0.2px Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText('WATER', 0.5, 0.57);
    g.lineWidth = 0.05;
    g.strokeStyle = g.fillStyle;
    g.beginPath();
    g.arc(0.5, 0.5, 0.42, 0, Math.PI * 2);
    g.stroke();
  });

  // detectable warning: safety-yellow truncated domes, 1.26 × 0.61 m, ~5 cm pitch
  inTile(FX.domes, 1.26, 0.61, (g, l) => {
    g.fillStyle = l === 'a' ? '#d6a51e' : l === 'h' ? grey(60) : rm(0.6, 0);
    g.fillRect(0, 0, 1.26, 0.61);
    for (let y = 0.03; y < 0.6; y += 0.05) for (let x = 0.03 + ((Math.round(y / 0.05) % 2) * 0.025); x < 1.24; x += 0.05) {
      g.beginPath();
      g.arc(x, y, 0.0115, 0, Math.PI * 2);
      g.fillStyle = l === 'a' ? '#e2b12a' : l === 'h' ? grey(230) : rm(0.45, 0);
      g.fill();
    }
  });
  blotch(FX.domes, 10, '#5e5446', 0.8, 0, 25, 0.5);

  // catch basin grate 0.6 × 0.9 m: cast iron bars across the flow, debris
  inTile(FX.basin, 0.6, 0.9, (g, l) => {
    g.fillStyle = l === 'a' ? '#070605' : l === 'h' ? grey(20) : rm(1, 0);
    g.fillRect(0, 0, 0.6, 0.9);
    g.fillStyle = l === 'a' ? '#34312d' : l === 'h' ? grey(190) : rm(0.55, 0.7);
    for (let y = 0.05; y < 0.86; y += 0.06) g.fillRect(0.04, y, 0.52, 0.03);
    g.fillRect(0.28, 0.04, 0.04, 0.82);
    g.lineWidth = 0.04;
    g.strokeStyle = g.fillStyle;
    g.strokeRect(0.02, 0.02, 0.56, 0.86);
  });
  blotch(FX.basin, 8, '#4a3d2c', 0.9, 0, 30, 0.6);

  // Empire City Subway / telecom hatch 0.9 × 0.9 m: diamond tread, letters
  inTile(FX.ecs, 0.9, 0.9, (g, l) => {
    g.fillStyle = l === 'a' ? '#3a3835' : l === 'h' ? grey(130) : rm(0.55, 0.7);
    g.fillRect(0, 0, 0.9, 0.9);
    g.fillStyle = l === 'a' ? '#4c4945' : l === 'h' ? grey(190) : rm(0.3, 0.8);
    for (let y = 0.04; y < 0.88; y += 0.045) for (let x = 0.04; x < 0.88; x += 0.045) {
      g.beginPath();
      g.moveTo(x, y - 0.015);
      g.lineTo(x + 0.012, y);
      g.lineTo(x, y + 0.015);
      g.lineTo(x - 0.012, y);
      g.fill();
    }
    g.fillStyle = l === 'a' ? '#3a3835' : l === 'h' ? grey(130) : rm(0.55, 0.7);
    g.fillRect(0.2, 0.38, 0.5, 0.15);
    g.fillStyle = l === 'a' ? '#5c5852' : l === 'h' ? grey(205) : rm(0.3, 0.8);
    g.font = 'bold 0.11px Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText('E.C.S.', 0.45, 0.495);
  });

  // steel road plate 1.5 × 2.4 m: dark mill scale, rust, polished tyre tracks, weld beads
  inTile(FX.plate, 1.5, 2.4, (g, l) => {
    g.fillStyle = l === 'a' ? '#2b2a28' : l === 'h' ? grey(128) : rm(0.45, 0.85);
    g.fillRect(0, 0, 1.5, 2.4);
    g.fillStyle = l === 'a' ? '#4a4844' : l === 'h' ? grey(128) : rm(0.25, 0.9);
    for (const x of [0.3, 1.1]) g.fillRect(x, 0, 0.25, 2.4);
    g.strokeStyle = l === 'a' ? '#1b1a19' : l === 'h' ? grey(170) : rm(0.6, 0.7);
    g.lineWidth = 0.02;
    g.strokeRect(0.01, 0.01, 1.48, 2.38);
  });
  blotch(FX.plate, 18, '#5e3a20', 0.85, 0.2, 35, 0.5);

  // height → normal map
  const hd = Hh.getImageData(0, 0, FX_N, FX_N).data;
  const nc = mk();
  const N = nc.getContext('2d')!;
  const out = N.createImageData(FX_N, FX_N);
  const hAt = (x: number, y: number) => hd[(Math.min(FX_N - 1, Math.max(0, y)) * FX_N + Math.min(FX_N - 1, Math.max(0, x))) * 4] / 255;
  const k = 3.0;
  for (let y = 0; y < FX_N; y++) for (let x = 0; x < FX_N; x++) {
    const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * k, dy = (hAt(x, y + 1) - hAt(x, y - 1)) * k;
    const l = Math.hypot(dx, dy, 1);
    const o = (y * FX_N + x) * 4;
    out.data[o] = ((-dx / l) * 0.5 + 0.5) * 255;
    out.data[o + 1] = ((dy / l) * 0.5 + 0.5) * 255; // canvas y down, texture v up
    out.data[o + 2] = (1 / l) * 255;
    out.data[o + 3] = 255;
  }
  N.putImageData(out, 0, 0);
  const tex = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  fxTex = { map: tex(cA, true), normal: tex(nc, false), rm: tex(cR, false) };
  return fxTex;
}

function fixturesMaterial() {
  const t = fixturesTextures();
  const m = new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normal, roughnessMap: t.rm, metalnessMap: t.rm, roughness: 1, metalness: 1, alphaTest: 0.5, envMapIntensity: 0.7, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  m.normalScale.set(1.2, 1.2);
  m.userData.pbr = true;
  return wetSurface(m, 0.6);
}

// ---------------------------------------------------------------- public hooks

export interface GroundOpts {
  /** chunk group (road, markings) and the static group that gets baked (sidewalk, curb, ramps) */
  group: THREE.Group;
  stat: THREE.Object3D;
  cx: number;
  cz: number;
  /** old loft district: more vault lights */
  village?: boolean;
  /** Belgian-block streets */
  cobble?: boolean;
}

let curbGeo: THREE.BufferGeometry | null = null;

/**
 * The chunk's ground: road plane (AX × SZ), sidewalk plane (BX*2 × BZ*2, at curb height), granite curb
 * with corner ramps, tactile pads and the painted markings. Call before anything that cuts the planes.
 */
export function groundBase(o: GroundOpts) {
  void groundReady();
  const road = new THREE.Mesh(new THREE.PlaneGeometry(AX, SZ), o.cobble ? GM.cobbleRoad() : GM.road());
  road.rotation.x = -Math.PI / 2;
  road.receiveShadow = true;
  road.userData.owned = true;
  o.group.add(road);
  const sw = new THREE.Mesh(new THREE.PlaneGeometry(BX * 2, BZ * 2), GM.sidewalk());
  sw.rotation.x = -Math.PI / 2;
  sw.position.y = CURB;
  sw.receiveShadow = true;
  o.stat.add(sw);
  const fix = new QuadBuf();
  const rm = new THREE.Mesh(ramps(fix), GM.sidewalk());
  rm.receiveShadow = true;
  o.stat.add(rm);
  curbGeo ??= curbGeometry();
  const cb = new THREE.Mesh(curbGeo, GM.curb());
  cb.receiveShadow = true;
  cb.castShadow = false;
  o.stat.add(cb);
  o.group.add(markings(o.cx, o.cz));
  // catch basins in the gutter, upstream of each crosswalk
  const rng = new Rng(hashN(o.cx, o.cz, 31337));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    if (rng.chance(0.6)) {
      const z = sz * (BZ - XW_IN - STOP_GAP - STOP_W - 1.0), x = sx * (BX + 0.05);
      fix.quad(Math.min(x, x + sx * 0.6), z - 0.45, Math.max(x, x + sx * 0.6), z + 0.45, 0.003, FX.basin, FX_N, FX_N, sx > 0 ? 'x' : '-x');
    }
    if (rng.chance(0.4)) {
      const x = sx * (BX - XW_IN - STOP_GAP - STOP_W - 1.0), z = sz * (BZ + 0.05);
      fix.quad(x - 0.45, Math.min(z, z + sz * 0.6), x + 0.45, Math.max(z, z + sz * 0.6), 0.003, FX.basin, FX_N, FX_N, sz > 0 ? 'z' : '-z');
    }
  }
  // a steel plate over a street excavation now and then
  if (rng.chance(0.3)) {
    if (rng.chance(0.5)) {
      const x = rng.range(-BX + 8, BX - 8), z = (rng.chance(0.5) ? 1 : -1) * (SZ / 2 - rng.range(0.8, 2.6));
      fix.quad(x - 1.2, z - 0.75, x + 1.2, z + 0.75, 0.012, FX.plate, FX_N, FX_N, 'x');
    } else {
      const z = rng.range(-BZ + 6, BZ - 6), x = (rng.chance(0.5) ? 1 : -1) * (AX / 2 - rng.range(1, 6));
      fix.quad(x - 0.75, z - 1.2, x + 0.75, z + 1.2, 0.012, FX.plate, FX_N, FX_N, '-z');
    }
  }
  // into the baked group: merges with groundDetails()' fixtures into one draw call
  o.stat.add(new THREE.Mesh(fix.geometry(), GM.fixtures()));
}

/**
 * Flush hardware on the sidewalk: diamond-plate cellar doors and vault lights against the
 * building line (away from entrances), subway vent grates on the avenues, utility covers.
 * Merged into the static group with one atlas material.
 */
export function groundDetails(o: GroundOpts & { doors: THREE.Vector3[]; seed?: number; showcase?: boolean }) {
  const rng = new Rng(hashN(o.cx, o.cz, o.seed ?? 0, 4711));
  const q = new QuadBuf();
  const Y = CURB + 0.003;
  const clearOfDoors = (x: number, z: number, r: number) => !o.doors.some((d) => Math.hypot(d.x - x, d.z - z) < r);
  const taken: { x0: number; x1: number; z0: number; z1: number }[] = [];
  const free = (x0: number, z0: number, x1: number, z1: number) => {
    if (taken.some((t) => x0 < t.x1 + 0.3 && x1 > t.x0 - 0.3 && z0 < t.z1 + 0.3 && z1 > t.z0 - 0.3)) return false;
    taken.push({ x0, x1, z0, z1 });
    return true;
  };
  if (o.showcase) {
    // the lab: one of everything near the NE corner
    for (const s of [-1, 1]) q.quad(Math.min(22, 22 + s * 0.9), LZ + 0.05, Math.max(22, 22 + s * 0.9), LZ + 1.65, Y, FX.cellar, FX_N, FX_N, s > 0 ? 'x' : '-x');
    for (let i = 0; i < 4; i++) q.quad(15 + i, LZ + 0.02, 16 + i, LZ + 1.02, Y, FX.vault, FX_N, FX_N, '-z');
    for (let i = 0; i < 4; i++) q.quad(BX - 2.45, 6 + i * 1.5, BX - 1.25, 7.5 + i * 1.5, Y, FX.grate, FX_N, FX_N, '-z');
    q.quad(40 - 0.45, BZ - 1.1, 40 + 0.45, BZ - 0.5, Y, FX.coned, FX_N, FX_N, 'x');
    q.quad(BX - 0.95, 18 - 0.15, BX - 0.65, 18 + 0.15, Y, FX.water, FX_N, FX_N, '-z');
    q.quad(36 - 0.45, BZ - 1.6, 36 + 0.45, BZ - 0.7, Y, FX.ecs, FX_N, FX_N, '-z');
    taken.push({ x0: -BX, x1: BX, z0: -BZ, z1: BZ });
  }
  // (cellar doors in front of shops come with the storefronts: buildings-shop.ts)
  // vault lights along the building line, mostly in the older loft districts
  if (rng.chance(o.village ? 0.6 : 0.2)) {
    const sz = rng.chance(0.5) ? 1 : -1;
    const n = rng.int(3, 6);
    const x0 = rng.range(-LX + 22, LX - 22 - n);
    if (clearOfDoors(x0 + n / 2, sz * LZ, n / 2 + 0.5) && free(x0, Math.min(sz * LZ, sz * (LZ + 1)), x0 + n, Math.max(sz * LZ, sz * (LZ + 1)))) {
      for (let i = 0; i < n; i++) q.quad(x0 + i, Math.min(sz * (LZ + 0.02), sz * (LZ + 1.02)), x0 + i + 1, Math.max(sz * (LZ + 0.02), sz * (LZ + 1.02)), Y, FX.vault, FX_N, FX_N, '-z');
    }
  }
  // subway ventilation grates on the avenue sidewalks, between the kerb furniture and the walkway
  for (const sx of [-1, 1]) {
    if (!rng.chance(0.5)) continue;
    const n = rng.int(2, 5);
    const z0 = rng.range(-14, 14 - n * 1.5);
    const xa = sx * (BX - 1.25), xb = sx * (BX - 2.45);
    if (!free(Math.min(xa, xb), z0, Math.max(xa, xb), z0 + n * 1.5)) continue;
    for (let i = 0; i < n; i++) q.quad(Math.min(xa, xb), z0 + i * 1.5, Math.max(xa, xb), z0 + (i + 1) * 1.5, Y, FX.grate, FX_N, FX_N, '-z');
  }
  // utility covers near the kerb
  const runs = [
    (t: number, d: number): [number, number, boolean] => [t, BZ - d, false],
    (t: number, d: number): [number, number, boolean] => [t, -(BZ - d), false],
    (t: number, d: number): [number, number, boolean] => [BX - d, t, true],
    (t: number, d: number): [number, number, boolean] => [-(BX - d), t, true],
  ];
  for (let k = rng.int(3, 6); k > 0; k--) {
    const r = rng.pick(runs);
    const az = r(0, 0)[2];
    const [x, z, alongZ] = r(rng.range(az ? -BZ + 5 : -BX + 6, az ? BZ - 5 : BX - 6), rng.range(0.5, 1.4));
    const kind = rng.next();
    if (onRamp(x, z, 1, 1)) continue;
    if (kind < 0.45) {
      const [w, d] = alongZ ? [0.6, 0.9] : [0.9, 0.6];
      if (free(x - w / 2, z - d / 2, x + w / 2, z + d / 2)) q.quad(x - w / 2, z - d / 2, x + w / 2, z + d / 2, Y, FX.coned, FX_N, FX_N, alongZ ? '-z' : 'x');
    } else if (kind < 0.8) {
      if (free(x - 0.15, z - 0.15, x + 0.15, z + 0.15)) q.quad(x - 0.15, z - 0.15, x + 0.15, z + 0.15, Y, FX.water, FX_N, FX_N, '-z');
    } else if (free(x - 0.45, z - 0.45, x + 0.45, z + 0.45)) q.quad(x - 0.45, z - 0.45, x + 0.45, z + 0.45, Y, FX.ecs, FX_N, FX_N, '-z');
  }
  if (!q.pos.length) return;
  o.stat.add(new THREE.Mesh(q.geometry(), GM.fixtures()));
}
