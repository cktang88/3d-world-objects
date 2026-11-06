import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng, hashN } from '../rng';
import { fixZFight } from '../zfix';
import { noWeather } from '../weather';

/**
 * Windows for NYC buildings: real openings with depth, instanced per block.
 *
 * Every window part is built in "window space": the opening spans x 0..w, y 0..h, the wall face
 * is z = 0 and +z points out to the street. Vertices carry an anchor (aAnchor, 0..1 of the opening)
 * plus an offset in metres (position), so one geometry fits every window size without stretching
 * lintels or sills: the vertex shader places them at aAnchor * aSize + position.
 *
 * The glass draws a fake room behind it (interior mapping), lit at night through `setNight`.
 */

// ---------------------------------------------------------------- night / shared uniforms

export const NIGHT = { value: 0 };
/** day-light level inside rooms (rooms are darker than the street) */
export const INDOOR_DAY = { value: 1 };
const nightHooks: ((f: number) => void)[] = [];
/** 0 = day, 1 = night: lights rooms behind windows, shop interiors and signs. */
export function setNight(f: number) {
  NIGHT.value = Math.max(0, Math.min(1, f));
  INDOOR_DAY.value = 1 - NIGHT.value;
  for (const h of nightHooks) h(NIGHT.value);
}
export function onNight(h: (f: number) => void) {
  nightHooks.push(h);
  h(NIGHT.value);
}

// ---------------------------------------------------------------- anchored geometry

type A = [number, number]; // [anchor 0..1, offset metres]
class AGeo {
  parts: THREE.BufferGeometry[] = [];
  /** a box between anchored corners */
  /** faces: which sides to keep, of 'px nx py ny pz nz' (default: all but the back, nz) */
  box(x0: A, x1: A, y0: A, y1: A, z0: number, z1: number, faces = 'px nx py ny pz') {
    let g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    if (faces !== 'all') {
      const keep = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((f) => faces.includes(f));
      const sub = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'uv'] as const) {
        const at = g.getAttribute(name) as THREE.BufferAttribute;
        const out: number[] = [];
        for (let f = 0; f < 6; f++) if (keep[f]) for (let k = 0; k < 6 * at.itemSize; k++) out.push(at.array[f * 6 * at.itemSize + k]);
        sub.setAttribute(name, new THREE.Float32BufferAttribute(out, at.itemSize));
      }
      g.dispose();
      g = sub;
    }
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const an = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const X = p.getX(i) < 0 ? x0 : x1, Y = p.getY(i) < 0 ? y0 : y1;
      an[i * 2] = X[0];
      an[i * 2 + 1] = Y[0];
      p.setXYZ(i, X[1], Y[1], p.getZ(i) < 0 ? z0 : z1);
    }
    g.setAttribute('aAnchor', new THREE.BufferAttribute(an, 2));
    this.parts.push(g);
    return this;
  }
  /** a quad facing +z between anchored corners, uv 0..1 */
  quad(x0: A, x1: A, y0: A, y1: A, z: number) {
    const g = new THREE.PlaneGeometry(1, 1).toNonIndexed();
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const an = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const X = p.getX(i) < 0 ? x0 : x1, Y = p.getY(i) < 0 ? y0 : y1;
      an[i * 2] = X[0];
      an[i * 2 + 1] = Y[0];
      p.setXYZ(i, X[1], Y[1], z);
    }
    g.setAttribute('aAnchor', new THREE.BufferAttribute(an, 2));
    this.parts.push(g);
    return this;
  }
  done() {
    const g = mergeGeometries(this.parts)!;
    this.parts.forEach((p) => p.dispose());
    return g;
  }
}
const L = (o = 0): A => [0, o];
const R = (o = 0): A => [1, o];
const H = (o = 0): A => [0.5, o];

/** how deep openings are set into the masonry */
export const REVEAL = 0.24;

export type TrimKind = 'stone' | 'hood' | 'flat' | 'arch' | 'none';
export type SashKind = 'dh' | 'case' | 'store' | 'none';

const geos = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry) {
  let g = geos.get(key);
  if (!g) geos.set(key, (g = make()));
  return g;
}

/** the inside faces of the opening (masonry) */
function revealGeo() {
  return geo('reveal', () => {
    const t = 0.05, z0 = -REVEAL - 0.02, z1 = -0.003;
    // only the inner faces of the opening are ever seen
    return new AGeo()
      .box(L(-t), L(0), L(-t), R(t), z0, z1, 'px')
      .box(R(0), R(t), L(-t), R(t), z0, z1, 'nx')
      .box(L(0), R(0), R(0), R(t), z0, z1, 'ny')
      .box(L(0), R(0), L(-t), L(0), z0, z1, 'py')
      .done();
  });
}

function trimGeo(kind: TrimKind) {
  return geo('trim:' + kind, () => {
    const a = new AGeo();
    if (kind === 'none') {
      a.box(L(-0.02), R(0.02), L(-0.04), L(0), -REVEAL, 0.03);
      return a.done();
    }
    // projecting stone sill on two little corbels
    a.box(L(-0.09), R(0.09), L(-0.1), L(0), -REVEAL + 0.04, 0.075);
    if (kind !== 'flat') {
      a.box(L(-0.02), L(0.1), L(-0.24), L(-0.1), -0.02, 0.05);
      a.box(R(-0.1), R(0.02), L(-0.24), L(-0.1), -0.02, 0.05);
    }
    if (kind === 'stone') {
      // flat lintel with a keystone
      a.box(L(-0.13), R(0.13), R(0), R(0.24), -0.02, 0.045);
      a.box(H(-0.09), H(0.09), R(-0.03), R(0.3), -0.02, 0.085);
    } else if (kind === 'hood') {
      // Italianate hood: architrave surround, frieze, projecting cornice cap on consoles
      a.box(L(-0.12), L(0), L(0), R(0), -0.02, 0.035);
      a.box(R(0), R(0.12), L(0), R(0), -0.02, 0.035);
      a.box(L(-0.12), R(0.12), R(0), R(0.2), -0.02, 0.045);
      a.box(L(-0.2), R(0.2), R(0.2), R(0.27), -0.02, 0.12);
      a.box(L(-0.25), R(0.25), R(0.27), R(0.33), -0.02, 0.15);
      a.box(L(-0.24), L(-0.12), R(-0.28), R(0.2), -0.02, 0.1);
      a.box(R(0.12), R(0.24), R(-0.28), R(0.2), -0.02, 0.1);
    } else if (kind === 'flat') {
      // soldier-course brick lintel, flush, picked out by colour
      a.box(L(-0.06), R(0.06), R(0), R(0.22), -0.02, 0.02);
    } else if (kind === 'arch') {
      // segmental arch: stepped voussoirs
      const n = 7;
      for (let i = 0; i < n; i++) {
        const u0 = i / n, u1 = (i + 1) / n;
        const lift = Math.sin(((i + 0.5) / n) * Math.PI) * 0.12;
        a.box([u0, i === 0 ? -0.1 : 0], [u1, i === n - 1 ? 0.1 : 0], R(lift), R(lift + 0.24), -0.02, 0.04);
      }
      a.box(H(-0.08), H(0.08), R(0.08), R(0.42), -0.02, 0.08);
    }
    return a.done();
  });
}

/** painted sash frames: double-hung (one over one), steel casements, or store mullions */
function sashGeo(kind: SashKind) {
  return geo('sash:' + kind, () => {
    const a = new AGeo();
    const zf = -REVEAL + 0.04; // frame plane
    // outer frame (blind stop) against the reveal
    a.box(L(0), L(0.06), L(0), R(0), zf - 0.02, zf + 0.05, 'px pz');
    a.box(R(-0.06), R(0), L(0), R(0), zf - 0.02, zf + 0.05, 'nx pz');
    a.box(L(0), R(0), R(-0.06), R(0), zf - 0.02, zf + 0.05, 'ny pz');
    a.box(L(0), R(0), L(0), L(0.05), zf - 0.02, zf + 0.06, 'py pz');
    if (kind === 'dh') {
      // upper sash (back) and lower sash (front), meeting at mid-height
      // stiles run the full height; top rail, meeting rails (the lower sash sits in front), bottom rail
      const zu = zf + 0.0, zl = zf + 0.045;
      a.box(L(0.06), L(0.11), L(0.05), R(-0.06), zu, zl + 0.035, 'px pz');
      a.box(R(-0.11), R(-0.06), L(0.05), R(-0.06), zu, zl + 0.035, 'nx pz');
      a.box(L(0.11), R(-0.11), R(-0.11), R(-0.06), zu, zu + 0.035, 'ny pz');
      a.box(L(0.11), R(-0.11), H(-0.02), H(0.045), zu, zl + 0.035, 'py ny pz');
      a.box(L(0.11), R(-0.11), L(0.05), L(0.13), zl, zl + 0.035, 'py pz');
    } else if (kind === 'case') {
      // tall loft window: centre mullion and a transom bar near the top
      a.box(H(-0.035), H(0.035), L(0.05), [0.78, 0], zf, zf + 0.05);
      a.box(L(0.06), R(-0.06), [0.78, -0.035], [0.78, 0.035], zf, zf + 0.05);
      a.box(L(0.06), R(-0.06), [0.4, -0.02], [0.4, 0.02], zf + 0.01, zf + 0.04);
    } else {
      a.box(L(0), R(0), [0.82, -0.03], [0.82, 0.03], zf, zf + 0.05);
    }
    return a.done();
  });
}

function glassGeo() {
  return geo('glass', () => new AGeo().quad(L(0.04), R(-0.04), L(0.04), R(-0.04), -REVEAL + 0.055).done());
}

/** a through-the-window air conditioner sitting on the sill of the lower sash */
export type AcKind = 'window' | 'big' | 'sleeve';
function acGeo(kind: AcKind) {
  if (kind === 'sleeve') {
    // through-the-wall unit in a metal sleeve under the window
    return geo('ac:sleeve', () => {
      const a = new AGeo();
      a.box(H(-0.36), H(0.36), L(-1.0), L(-0.55), -0.05, 0.05);
      for (let i = 0; i < 6; i++) a.box(H(-0.32), H(0.32), L(-0.97 + i * 0.065), L(-0.95 + i * 0.065), 0.05, 0.065);
      return a.done();
    });
  }
  return geo('ac:' + kind, () => {
    const a = new AGeo();
    const big = kind === 'big';
    const w = big ? 0.38 : 0.31, z0 = -REVEAL + 0.02, z1 = big ? 0.46 : 0.34;
    const top = big ? 0.5 : 0.42;
    a.box(H(-w), H(w), L(0.04), L(top), z0, z1);
    // a slightly raised cabinet top on the big units
    if (big) a.box(H(-w + 0.02), H(w - 0.02), L(top), L(top + 0.03), z0 + 0.05, z1 - 0.04);
    // front grille: raised louvres
    for (let i = 0; i < (big ? 6 : 5); i++) a.box(H(-w + 0.04), H(w - 0.04), L(0.1 + i * 0.065), L(0.125 + i * 0.065), z1, z1 + 0.012);
    // side accordion panels filling the rest of the opening
    a.box(L(0.06), H(-w), L(0.05), L(top), z0 + 0.04, z0 + 0.06);
    a.box(H(w), R(-0.06), L(0.05), L(top), z0 + 0.04, z0 + 0.06);
    // support bracket under the unit
    a.box(H(-w + 0.05), H(-w + 0.08), L(-0.25), L(0.04), 0.05, z1 - 0.05);
    a.box(H(w - 0.08), H(w - 0.05), L(-0.25), L(0.04), 0.05, z1 - 0.05);
    return a.done();
  });
}
/** a drip / rust stain running down the wall under an AC unit */
function stainGeo() {
  return geo('stain', () => new AGeo().quad(H(-0.16), H(0.16), L(-1.7), L(-0.08), 0.006).done());
}

// ---------------------------------------------------------------- materials

const anchorVertex = /* glsl */ `
attribute vec2 aAnchor;
#ifdef USE_INSTANCING
attribute vec2 aSize;
#else
attribute vec2 aSizeV;
#endif
`;
const anchorBegin = /* glsl */ `
#include <begin_vertex>
#ifdef USE_INSTANCING
transformed.xy += aAnchor * aSize;
#endif
`;
function anchored<T extends THREE.Material>(m: T, key: string): T {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = anchorVertex + sh.vertexShader.replace('#include <begin_vertex>', anchorBegin);
  };
  m.customProgramCacheKey = () => 'anchored:' + key;
  return m;
}
let stainM: THREE.MeshBasicMaterial | null = null;
// (anchored() is declared below; stainMat() is only called at build time)
function stainMat() {
  if (stainM) return stainM;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 256);
  // a dark streak, strongest under the unit and fading down the wall, with ragged drips
  for (let i = 0; i < 9; i++) {
    const x = 10 + Math.random() * 44, w = 4 + Math.random() * 10, len = 80 + Math.random() * 170;
    const gr = g.createLinearGradient(0, 0, 0, len);
    gr.addColorStop(0, 'rgba(40,28,18,0.55)');
    gr.addColorStop(1, 'rgba(40,28,18,0)');
    g.fillStyle = gr;
    g.fillRect(x, 0, w, len);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  // multiplied over the wall: white leaves it alone, the streaks darken it
  // [zfix] stains are decals on the wall: polygon offset so they never flicker with it
  stainM = anchored(new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true, fog: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }), 'stain');
  return stainM;
}
const depthMat = anchored(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), 'depth');

let mats: { reveal: THREE.MeshStandardMaterial; trim: THREE.MeshStandardMaterial; sash: THREE.MeshStandardMaterial; ac: THREE.MeshStandardMaterial; glass: THREE.MeshStandardMaterial } | null = null;
export function windowMats() {
  if (mats) return mats;
  mats = {
    reveal: anchored(new THREE.MeshStandardMaterial({ roughness: 0.95 }), 'reveal'),
    trim: anchored(new THREE.MeshStandardMaterial({ roughness: 0.85 }), 'trim'),
    sash: anchored(new THREE.MeshStandardMaterial({ roughness: 0.5 }), 'sash'),
    ac: anchored(new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.2 }), 'ac'),
    glass: roomMaterial(false),
  };
  return mats;
}

/**
 * Glass with a room behind it. The room is a box behind the opening (wider and taller than the
 * window); the view ray is intersected with it per pixel and the hit face is shaded procedurally:
 * wall paint, wooden floor, a ceiling with a lamp, a piece of furniture against the back wall,
 * blinds and curtains at the glass. For shops the back and side walls sample a shelf atlas.
 *
 * aInfo: x = random seed 0..1, y = lit at night (0/1), z = blind drop 0..1, w = curtains 0/1
 * aRoom: x = depth (m), y = shop atlas cell (shops only), z = brightness by day, w = muntins
 */
export function roomMaterial(shop: boolean, atlas?: THREE.Texture) {
  const m = new THREE.MeshStandardMaterial({ color: '#0b0d10', roughness: 0.04, metalness: shop ? 0.22 : 0.08, envMapIntensity: 1.6 });
  const uniforms = { uNight: NIGHT, uDay: INDOOR_DAY, uAtlas: { value: atlas ?? null } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader =
      anchorVertex +
      /* glsl */ `
#ifdef USE_INSTANCING
attribute vec4 aInfo;
attribute vec4 aRoom;
#else
attribute vec4 aInfoV;
attribute vec4 aRoomV;
#endif
varying vec3 vRo; varying vec3 vRd; varying vec4 vInfo; varying vec4 vRoomI; varying vec2 vSz; varying vec2 vPane;
` +
      sh.vertexShader.replace('#include <begin_vertex>', anchorBegin).replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
#ifdef USE_INSTANCING
  mat4 rm = modelMatrix * instanceMatrix; vec2 sz = aSize; vInfo = aInfo; vRoomI = aRoom;
#else
  mat4 rm = modelMatrix; vec2 sz = aSizeV; vInfo = aInfoV; vRoomI = aRoomV;
#endif
  vec3 wp = (rm * vec4(transformed, 1.0)).xyz;
  vec3 Nw = normalize((rm * vec4(objectNormal, 0.0)).xyz);
  vec3 Tw = normalize(cross(vec3(0.0, 1.0, 0.0), Nw));
  vec3 dw = wp - cameraPosition;
  vRd = vec3(dot(dw, Tw), dw.y, -dot(dw, Nw));
  vRo = vec3(aAnchor * sz, 0.0);
  vSz = sz;
  vPane = aAnchor;
`,
      );
    sh.fragmentShader =
      /* glsl */ `
uniform float uNight; uniform float uDay; uniform sampler2D uAtlas;
varying vec3 vRo; varying vec3 vRd; varying vec4 vInfo; varying vec4 vRoomI; varying vec2 vSz; varying vec2 vPane;
float h11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
vec3 atlas(float u, float v) {
${shop ? `float cell = vRoomI.y;
  return texture2D(uAtlas, vec2((mod(cell, 8.0) + clamp(u, 0.002, 0.998)) / 8.0, (floor(cell / 8.0) + clamp(v, 0.002, 0.998)) / 2.0)).rgb;` : 'return vec3(0.5);'}
}
vec3 roomShade(out float lampGlow) {
  vec3 d = vRd; d.z = max(d.z, 1e-4);
  float seed = vInfo.x;
  float depth = vRoomI.x;
  bool shop = ${shop ? 'true' : 'false'};
  // room extents around the opening
  float sideW = shop ? 0.3 : 1.2 + h11(seed + 3.0) * 1.5;
  vec3 lo = vec3(-sideW, shop ? -0.55 : -0.85, 0.0);
  vec3 hi = vec3(vSz.x + sideW, vSz.y + (shop ? 0.6 : 0.45), depth);
  vec3 inv = 1.0 / vec3(abs(d.x) < 1e-4 ? 1e-4 : d.x, abs(d.y) < 1e-4 ? 1e-4 : d.y, d.z);
  vec3 t1 = (lo - vRo) * inv, t2 = (hi - vRo) * inv;
  vec3 tf = max(t1, t2);
  float t = min(min(tf.x, tf.y), tf.z);
  vec3 p = vRo + d * t;
  vec3 c;
  float ao = 1.0;
  vec3 paint = mix(vec3(0.82, 0.76, 0.64), vec3(0.6, 0.66, 0.7), h11(seed + 1.0));
  paint = mix(paint, vec3(0.75, 0.45, 0.35), step(0.8, h11(seed + 9.0)));
  vec2 uvw;
  if (t == tf.z) {
    // back wall
    uvw = vec2((p.x - lo.x) / (hi.x - lo.x), (p.y - lo.y) / (hi.y - lo.y));
    if (shop) c = atlas(uvw.x, uvw.y);
    else {
      c = paint;
      // a sofa or a dresser against the wall, a picture above it
      float fx = (p.x - lo.x) / (hi.x - lo.x);
      float f0 = 0.15 + h11(seed + 5.0) * 0.35, f1 = f0 + 0.25 + h11(seed + 6.0) * 0.3;
      float fh = lo.y + 0.45 + h11(seed + 7.0) * 0.5;
      if (fx > f0 && fx < f1 && p.y < fh) c = mix(vec3(0.25, 0.18, 0.12), vec3(0.3, 0.32, 0.4), h11(seed + 8.0)) * (p.y > fh - 0.08 ? 1.25 : 0.9);
      float px = (f0 + f1) * 0.5;
      if (abs(fx - px) < 0.07 && abs(p.y - (fh + 0.75)) < 0.28) c = vec3(0.2, 0.25, 0.3) + 0.5 * vec3(h11(seed + 11.0), h11(seed + 12.0), h11(seed + 13.0));
    }
  } else if (t == tf.y) {
    if (d.y < 0.0) {
      // floor: shop tile or wooden boards
      if (shop) { vec2 q = floor(p.xz / 0.5); c = mix(vec3(0.75, 0.73, 0.68), vec3(0.55, 0.52, 0.48), mod(q.x + q.y, 2.0)); }
      else c = vec3(0.42, 0.28, 0.17) * (0.85 + 0.15 * sin(p.x * 40.0 + h11(floor(p.x * 6.0)) * 6.0));
    } else {
      // ceiling, with a lamp (or fluorescent strips in a shop)
      c = vec3(0.9, 0.88, 0.84);
      float lamp = shop ? smoothstep(0.12, 0.02, abs(fract(p.z / 1.6) - 0.5)) * step(0.3, fract(p.x / 1.8)) : smoothstep(0.35, 0.0, length(p.xz - vec2(vSz.x * 0.5, depth * 0.5)));
      lampGlow = lamp;
      c += lamp * 2.5;
    }
  } else {
    // side walls
    uvw = vec2(p.z / depth, (p.y - lo.y) / (hi.y - lo.y));
    if (shop) c = atlas(0.15 + uvw.x * 0.7, uvw.y) * 0.8;
    else c = paint * 0.8;
  }
  // soft shadowing into the room's corners and away from the window
  vec3 e = min(p - lo, hi - p);
  float corner = min(min(e.x, e.y), e.z);
  ao *= 0.55 + 0.45 * smoothstep(0.0, 0.6, corner);
  ao *= mix(1.0, 0.55, clamp(p.z / depth, 0.0, 1.0));
  return c * ao;
}
` + sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
  {
    float lampGlow = 0.0;
    vec3 room = roomShade(lampGlow);
    vec2 pu = vPane;
    float seed = vInfo.x;
    bool shopG = ${shop ? 'true' : 'false'};
    // blinds from the top, curtains at the sides
    float blind = vInfo.z;
    float cover = 0.0;
    vec3 coverC = vec3(0.85, 0.8, 0.7);
    if (1.0 - pu.y < blind) { cover = 1.0; coverC = mix(vec3(0.86, 0.84, 0.78), vec3(0.78, 0.7, 0.55), h11(seed + 21.0)) * (0.85 + 0.15 * step(0.5, fract(pu.y * vSz.y * 18.0))); }
    if (vInfo.w > 0.5) {
      float cw = 0.16 + 0.1 * h11(seed + 22.0);
      if (pu.x < cw || pu.x > 1.0 - cw) { cover = 1.0; coverC = mix(vec3(0.7, 0.2, 0.15), vec3(0.85, 0.8, 0.65), h11(seed + 23.0)) * (0.8 + 0.2 * sin(pu.x * vSz.x * 40.0)); }
    }
    room = mix(room, coverC, cover);
    // muntins painted on the glass (two-over-two, six-over-six)
    float mun = vRoomI.w;
    if (mun > 0.5) {
      vec2 g = abs(fract(pu * vec2(mun > 1.5 ? 3.0 : 2.0, 4.0)) - 0.5);
      if (min(1.0 - smoothstep(0.47, 0.49, g.x), 1.0 - smoothstep(0.47, 0.49, g.y)) < 0.5) room *= 0.15;
    }
    float lit = vInfo.y;
    float warm = h11(seed + 31.0);
    vec3 lampC = mix(mix(vec3(1.0, 0.72, 0.42), vec3(1.0, 0.85, 0.62), warm), vec3(0.8, 0.88, 1.0), step(0.82, warm));
    float dayK = uDay * vRoomI.z;
    float nightK = uNight * lit * (shopG ? 1.8 : 0.85);
    vec3 inside = room * (dayK + nightK * lampC) + lampGlow * nightK * lampC * 0.5;
    // grazing views mostly reflect (fresnel)
    float nv = clamp(abs(vRd.z) / length(vRd), 0.0, 1.0);
    float through = mix(0.25, 1.0, smoothstep(0.05, 0.6, nv));
    totalEmissiveRadiance += inside * through;
  }
`,
      );
  };
  m.customProgramCacheKey = () => 'room:' + (shop ? 'shop' : 'apt');
  // glass stays clear: no wet darkening or snow on the panes (weather.ts)
  noWeather(m);
  return m;
}

// ---------------------------------------------------------------- per-block batches

export interface WinSpec {
  /** world (block-local) matrix of the opening's bottom-left corner, +z out of the wall */
  m: THREE.Matrix4;
  w: number;
  h: number;
  trim: TrimKind;
  sash: SashKind;
  trimColor: THREE.Color;
  revealColor: THREE.Color;
  sashColor: THREE.Color;
  /** night lighting / blinds / curtains / muntins */
  lit: number;
  blind: number;
  curtains: number;
  muntins: number;
  depth: number;
  ac?: THREE.Color;
  acKind?: AcKind;
  /** drip stain on the wall below the unit */
  stain?: boolean;
  /** no glass (bricked up, louvre) */
  noGlass?: boolean;
}

/**
 * [zfix] the window kits (sashes, trims, AC units) have coplanar overlapping faces inside one kit (meeting rails,
 * frames on sashes): lifted apart once per kit geometry (src/zfix.ts), not per window. Returns a fixed copy.
 */
const kitCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
function kitFixed(g: THREE.BufferGeometry) {
  let f = kitCache.get(g);
  if (!f) {
    const mesh = new THREE.Mesh(g.clone(), new THREE.MeshBasicMaterial());
    fixZFight(mesh, { step: 0.002, minOverlap: 0.002 });
    f = mesh.geometry;
    kitCache.set(g, f);
    kitCache.set(f, f);
  }
  return f;
}

export class WindowBatch {
  list: WinSpec[] = [];
  add(s: WinSpec) {
    this.list.push(s);
  }
  /** `fine` receives the small parts (sashes, AC units) that are hidden on far blocks */
  build(parent: THREE.Object3D, fine: THREE.Object3D = parent) {
    if (!this.list.length) return;
    const M = windowMats();
    const make = (g: THREE.BufferGeometry, m: THREE.Material, items: WinSpec[], color: (s: WinSpec) => THREE.Color | null, shadow: boolean, extra?: (im: THREE.InstancedMesh, items: WinSpec[]) => void, to = parent) => {
      if (!items.length) return;
      g = kitFixed(g);
      const im = new THREE.InstancedMesh(g, m, items.length);
      const size = new Float32Array(items.length * 2);
      items.forEach((s, i) => {
        im.setMatrixAt(i, s.m);
        const c = color(s);
        if (c) im.setColorAt(i, c);
        size[i * 2] = s.w;
        size[i * 2 + 1] = s.h;
      });
      im.geometry = g.clone();
      im.geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 2));
      extra?.(im, items);
      im.castShadow = shadow;
      im.receiveShadow = true;
      if (shadow) im.customDepthMaterial = depthMat;
      im.computeBoundingSphere();
      im.userData.owned = true;
      to.add(im);
    };
    const L = this.list;
    make(revealGeo(), M.reveal, L, (s) => s.revealColor, false);
    for (const k of ['stone', 'hood', 'flat', 'arch', 'none'] as TrimKind[]) make(trimGeo(k), M.trim, L.filter((s) => s.trim === k), (s) => s.trimColor, false, undefined, fine);
    for (const k of ['dh', 'case', 'store'] as SashKind[]) make(sashGeo(k), M.sash, L.filter((s) => s.sash === k), (s) => s.sashColor, false, undefined, fine);
    for (const k of ['window', 'big', 'sleeve'] as AcKind[]) make(acGeo(k), M.ac, L.filter((s) => s.ac && (s.acKind ?? 'window') === k), (s) => s.ac!, false, undefined, fine);
    make(stainGeo(), stainMat(), L.filter((s) => s.ac && s.acKind !== 'sleeve' && s.stain), () => null, false, undefined, fine);
    const gl = L.filter((s) => !s.noGlass);
    make(glassGeo(), M.glass, gl, () => null, false, (im, items) => {
      const info = new Float32Array(items.length * 4), room = new Float32Array(items.length * 4);
      items.forEach((s, i) => {
        info.set([hashN(i, 7919, Math.round(s.m.elements[12] * 10)) / 2 ** 32, s.lit, s.blind, s.curtains], i * 4);
        room.set([s.depth, 0, 0.32, s.muntins], i * 4);
      });
      im.geometry.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
      im.geometry.setAttribute('aRoom', new THREE.InstancedBufferAttribute(room, 4));
    });
  }
}

/** pick per-window dressing from an rng */
export function dressWindow(rng: Rng, kind: 'apt' | 'office' | 'loft') {
  const blind = rng.chance(0.45) ? rng.pick([0.08, 0.2, 0.35, 0.5, 0.9]) : 0;
  return {
    lit: rng.chance(kind === 'office' ? 0.45 : 0.55) ? 1 : 0,
    blind,
    curtains: kind === 'apt' && rng.chance(0.3) ? 1 : 0,
    depth: kind === 'loft' ? rng.range(5, 9) : rng.range(3.2, 4.6),
  };
}
