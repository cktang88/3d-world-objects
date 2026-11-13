import * as THREE from 'three';
import { AX, CURB, canvasTex } from './common';
import { MAP_BOUNDS, PIER_SHORE } from './districts';
import { getNight, onTimeChange } from '../lighting';
import { FLAGS } from '../flags';
import { Rng, hashN } from '../rng';
import { brownstoneMat } from './brownstone';

/**
 * [nbhd] The waterfront at real scale (docs/research/neighborhood-audit.md, Waterfront): the river as one
 * open water surface out to the far shore, the New Jersey / Queens skylines as a cheap impostor, and the
 * instanced kit the Hudson River Park esplanade and piers are dressed with (district-water.ts):
 *  - the river: two scrolling wave normal maps (fine chop + swell), low roughness so it mirrors the sky,
 *    lighter haze than the streets so the far shore reads (FogExp2 at 0.4 of the city's density);
 *  - far shores (1.2 km over the Hudson, 0.6 km over the East River): ~1500 boxes in one draw, palisade
 *    cliffs, Hoboken row houses, the Jersey City towers, Long Island City; windows light at night;
 *  - esplanade railing (posts, top and mid rails, pickets), granite coping, riprap toe, timber pile grid
 *    under pier decks, fender piles, bollards and cleats: InstancedMesh per chunk;
 *  - foam where the river meets the bulkhead and the piers.
 */

export const WATER_Y = -1.25;
/** world x of the Hudson bulkhead (the pier column's shore line) and of the East River's edge */
export const PIER_CX = MAP_BOUNDS.x0 + MAP_BOUNDS.w - 2;
export const HUDSON_X = PIER_CX * AX + PIER_SHORE;
export const EAST_X = (MAP_BOUNDS.x0 - 0.5) * AX;
/** is a world-x span of river drawn by the open river surface (so a chunk need not draw its own)? */
export function riverCovered(wx0: number, wx1: number) {
  return wx0 >= HUDSON_X - 0.01 || wx1 <= EAST_X + 0.01;
}
/** widths of the rivers to the far shore (m) */
export const HUDSON_W = 1250, EAST_W = 620;
/** the open river surface extends this far along z each way from its centre (re-centred as you walk) */
const SPAN_Z = 4000, SNAP = 500, TILE = 10;

const U = { time: { value: 0 }, night: { value: 0 }, fogK: { value: 0.4 } };
/** shared animation clock and night factor (Times Square screens use them too) */
export const WF_TIME = U.time, WF_NIGHT = U.night;
onTimeChange((_t, n) => (U.night.value = n));

/** lighter haze for open-water views: FogExp2 with `k` times the exponent */
function lightFog(sh: { fragmentShader: string }, k: number | string) {
  sh.fragmentShader = sh.fragmentShader.replace(
    '#include <fog_fragment>',
    `#ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp( - fogDensity * fogDensity * ${typeof k === 'number' ? k.toFixed(3) : k} * vFogDepth * vFogDepth );
      #else
        float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
      #endif
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
    #endif`,
  );
}

let waveTex: THREE.Texture | null = null;
/** tiling wave normal map: a sum of directional sines with integer wave numbers (seamless) */
function waveNormals() {
  if (waveTex) return waveTex;
  const N = 256;
  const waves: [number, number, number, number][] = [];
  const r = new Rng(77);
  for (let i = 0; i < 14; i++) {
    const kx = r.int(-9, 9), kz = r.int(2, 12) * (r.chance(0.5) ? 1 : -1);
    const k = Math.hypot(kx, kz);
    waves.push([kx, kz, 1 / Math.pow(k, 1.2), r.range(0, Math.PI * 2)]);
  }
  waveTex = canvasTex(N, N, (g) => {
    const img = g.createImageData(N, N);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let dx = 0, dz = 0;
        for (const [kx, kz, a, ph] of waves) {
          const c = Math.cos(((kx * x + kz * y) / N) * Math.PI * 2 + ph) * a * Math.PI * 2;
          dx += c * kx;
          dz += c * kz;
        }
        const n = new THREE.Vector3(-dx * 0.05, -dz * 0.05, 1).normalize();
        const i = (y * N + x) * 4;
        img.data[i] = (n.x * 0.5 + 0.5) * 255;
        img.data[i + 1] = (n.y * 0.5 + 0.5) * 255;
        img.data[i + 2] = (n.z * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    g.putImageData(img, 0, 0);
  }, true);
  waveTex.colorSpace = THREE.NoColorSpace;
  return waveTex;
}

let riverM: THREE.MeshStandardMaterial | null = null;
/** river water: dark green-grey, mirror-like, two scrolling wave scales, calmer normals in the distance */
export function riverMat() {
  if (riverM) return riverM;
  const m = new THREE.MeshStandardMaterial({ color: '#26373a', roughness: 0.1, metalness: 0.0, envMapIntensity: 1.0 });
  if (!FLAGS.notex) {
    m.normalMap = waveNormals();
    m.normalScale.set(0.26, 0.26);
  }
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWT = U.time;
    sh.fragmentShader = 'uniform float uWT;\n' + sh.fragmentShader.replace(
      'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
      `vec3 mapN = texture2D( normalMap, vNormalMapUv + vec2( uWT * 0.013, uWT * 0.005 ) ).xyz * 2.0 - 1.0;
      vec3 mapN2 = texture2D( normalMap, vNormalMapUv * 0.23 + vec2( -uWT * 0.0021, uWT * 0.0047 ) ).xyz * 2.0 - 1.0;
      float far = smoothstep( 40.0, 500.0, length( vViewPosition ) );
      mapN = vec3( ( mapN.xy * ( 1.0 - 0.6 * far ) + mapN2.xy * 1.2 ), mapN.z );`,
    );
    lightFog(sh, 0.4);
  };
  m.customProgramCacheKey = () => 'nbhd-river';
  m.name = 'river';
  riverM = m;
  return m;
}

/** a horizontal water rect in world-metre UVs (so neighbouring pieces line up) */
export function waterRect(x0: number, x1: number, z0: number, z1: number, ox = 0, oz = 0, y = WATER_Y) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, 1, 1);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute, uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + ox) / TILE, -(p.getZ(i) + oz) / TILE);
  const m = new THREE.Mesh(g, riverMat());
  m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------- far shores (impostor skyline)

type Zone = (z: number, r: Rng) => { h: number; w: number; d: number; gap: number; tone: string[] };
const BRICK = ['#8a5a48', '#9a6a52', '#7a4c3c', '#a88a70', '#b8a890', '#6e5446'];
const TOWER = ['#7d8c99', '#8fa1ad', '#6c7a86', '#a4adb2', '#5f6c74', '#b8b4a8'];
const CONCRETE = ['#a8a59c', '#bcb6aa', '#94918a', '#c8c2b4'];
/** New Jersey from the Hudson at midtown (z<0 north): Fort Lee / Edgewater towers, Weehawken on the palisades, Hoboken, Jersey City */
const JERSEY: Zone = (z, r) => {
  if (z < -1600) return { h: r.chance(0.25) ? r.range(60, 125) : r.range(12, 30), w: r.range(18, 40), d: r.range(18, 30), gap: r.range(4, 30), tone: r.chance(0.5) ? TOWER : CONCRETE };
  if (z < -150) return { h: r.chance(0.12) ? r.range(35, 70) : r.range(9, 24), w: r.range(10, 30), d: r.range(12, 22), gap: r.range(2, 18), tone: r.chance(0.6) ? BRICK : CONCRETE };
  if (z < 1300) return { h: r.chance(0.08) ? r.range(35, 60) : r.range(11, 18), w: r.range(6, 22), d: r.range(12, 18), gap: r.range(0.5, 6), tone: BRICK };
  return { h: r.chance(0.55) ? r.range(80, 240) : r.range(20, 60), w: r.range(22, 45), d: r.range(22, 40), gap: r.range(6, 30), tone: r.chance(0.7) ? TOWER : CONCRETE };
};
/** Queens / Brooklyn over the East River: Long Island City towers, Hunters Point, Greenpoint, Williamsburg */
const QUEENS: Zone = (z, r) => {
  if (z < -1400) return { h: r.chance(0.1) ? r.range(30, 60) : r.range(8, 20), w: r.range(12, 40), d: r.range(14, 30), gap: r.range(3, 25), tone: r.chance(0.5) ? CONCRETE : BRICK };
  if (z < 300) return { h: r.chance(0.5) ? r.range(70, 210) : r.range(15, 45), w: r.range(20, 40), d: r.range(20, 35), gap: r.range(5, 25), tone: r.chance(0.65) ? TOWER : CONCRETE };
  return { h: r.chance(0.15) ? r.range(50, 110) : r.range(9, 22), w: r.range(10, 30), d: r.range(12, 22), gap: r.range(1, 12), tone: BRICK };
};
/** the palisade cliff behind Weehawken and Edgewater (m above the river), 0 elsewhere */
function cliff(z: number) {
  if (z > -150) return 0;
  return 46 * Math.min(1, (-150 - z) / 250) + 6 * Math.sin(z * 0.004);
}

/** ~1500 boxes along a far shore: one geometry (position, normal, colour, facade uv, lit flag) */
function shoreGeometry(xEdge: number, dir: 1 | -1, zone: Zone, z0: number, z1: number, seed: number, cliffs: boolean) {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], uv: number[] = [], lit: number[] = [];
  const c = new THREE.Color();
  const quad = (a: number[], b: number[], cc: number[], d: number[], n: number[], u0: number, u1: number, l: number) => {
    for (const [p, u] of [[a, u0], [b, u1], [cc, u1], [a, u0], [cc, u1], [d, u0]] as [number[], number][]) {
      pos.push(p[0], p[1], p[2]);
      nor.push(n[0], n[1], n[2]);
      col.push(c.r, c.g, c.b);
      uv.push(u, p[1]);
      lit.push(l);
    }
  };
  const box = (x0: number, x1: number, za: number, zb: number, y0: number, y1: number, l: number) => {
    const W = x1 - x0, D = zb - za;
    quad([x0, y0, zb], [x1, y0, zb], [x1, y1, zb], [x0, y1, zb], [0, 0, 1], 0, W, l);
    quad([x1, y0, zb], [x1, y0, za], [x1, y1, za], [x1, y1, zb], [1, 0, 0], W, W + D, l);
    quad([x1, y0, za], [x0, y0, za], [x0, y1, za], [x1, y1, za], [0, 0, -1], 0, W, l);
    quad([x0, y0, za], [x0, y0, zb], [x0, y1, zb], [x0, y1, za], [-1, 0, 0], W, W + D, l);
    const tc = c.clone();
    c.multiplyScalar(0.7);
    quad([x0, y1, zb], [x1, y1, zb], [x1, y1, za], [x0, y1, za], [0, 1, 0], 0, 0, 0);
    c.copy(tc);
  };
  // a water apron out from the shore (the open river surface ends at the camera's far plane)
  c.set('#2f4145').convertSRGBToLinear();
  const wa = dir > 0 ? xEdge - 1200 : xEdge, wb = dir > 0 ? xEdge : xEdge + 1200;
  quad([wa, WATER_Y, z1], [wb, WATER_Y, z1], [wb, WATER_Y, z0], [wa, WATER_Y, z0], [0, 1, 0], 0, 0, 0);
  // the shore: a low bank / bulkhead along the water and the ground behind it
  c.set('#5d5f55').convertSRGBToLinear();
  const xa = dir > 0 ? xEdge : xEdge - 900, xb = dir > 0 ? xEdge + 900 : xEdge;
  box(xa, xb, z0, z1, WATER_Y - 1, 1.2, 0);
  // the palisade cliff face (grey-brown trap rock with green on top) behind the Jersey shore
  for (let z = Math.floor(z0 / 100) * 100; cliffs && z < z1; z += 100) {
    const h = cliff(z + 50);
    if (h < 2) continue;
    const xc = xEdge + dir * 180;
    c.set(z % 200 === 0 ? '#5a5248' : '#625a4e').convertSRGBToLinear();
    box(Math.min(xc, xc + dir * 600), Math.max(xc, xc + dir * 600), z, z + 100, 1, h, 0);
    c.set('#3f5a32').convertSRGBToLinear();
    box(Math.min(xc - dir * 25, xc), Math.max(xc - dir * 25, xc), z, z + 100, 1, h * 0.55, 0);
  }
  for (let seg = Math.floor(z0 / SNAP); seg * SNAP < z1; seg++) {
    const r = new Rng(hashN(seed, seg, 911));
    // rows of blocks running back from the water, avenues every ~80 m
    for (let row = 0; row < 7; row++) {
      const back = 25 + row * r.range(55, 80);
      let z = seg * SNAP + r.range(0, 10);
      while (z < (seg + 1) * SNAP) {
        const zn = zone(z, r);
        const w = Math.min(zn.w, (seg + 1) * SNAP - z);
        if (w < 4) break;
        const base = cliffs ? (back > 160 ? cliff(z) : 0) : 0;
        const x0 = xEdge + dir * back, x1 = x0 + dir * zn.d;
        c.set(r.pick(zn.tone)).convertSRGBToLinear().multiplyScalar(r.range(0.85, 1.1));
        box(Math.min(x0, x1), Math.max(x0, x1), z, z + w, base, base + zn.h * (row === 0 ? 1 : r.range(0.7, 1.15)), 1);
        z += w + zn.gap;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aLit', new THREE.Float32BufferAttribute(lit, 1));
  g.computeBoundingSphere();
  return g;
}

let shoreM: THREE.MeshStandardMaterial | null = null;
/** far facades: vertex colour, a procedural window grid (glass a touch darker by day, a share lit at night) */
function shoreMat() {
  if (shoreM) return shoreM;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, envMapIntensity: 0.5, depthWrite: false });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.night;
    sh.uniforms.uFogK = U.fogK;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLit;\nvarying float vLit;\nvarying vec2 vFac;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvLit = aLit;\nvFac = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nuniform float uFogK;\nvarying float vLit;\nvarying vec2 vFac;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec2 cell = floor( vFac / vec2( 3.0, 3.3 ) );
        vec2 f = fract( vFac / vec2( 3.0, 3.3 ) );
        float win = step( 0.25, f.x ) * step( f.x, 0.8 ) * step( 0.3, f.y ) * step( f.y, 0.85 ) * vLit * step( 4.0, vFac.y );
        diffuseColor.rgb *= 1.0 - 0.35 * win;
        float on = step( 0.62, fract( sin( dot( cell, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) );
        totalEmissiveRadiance += vec3( 1.0, 0.78, 0.5 ) * win * on * uNight * 1.6;`,
      );
    lightFog(sh, 'uFogK');
  };
  m.customProgramCacheKey = () => 'nbhd-shore';
  m.name = 'far-shore';
  shoreM = m;
  return m;
}

/**
 * The open rivers and their far shores, re-centred along z as the player walks (snapped to SNAP so the wave
 * UVs and the skyline never jump). Add `group` once to the level group and call update() every frame.
 * The far shores are a backdrop: drawn first without depth writes and scaled about the eye so they fit
 * inside the camera's far plane (same angles, same parallax for turning), their haze computed for the
 * true distance. Anything nearer simply draws over them.
 */
export class Waterfront {
  group = new THREE.Group();
  /** the far shores (scaled towards the eye every frame) */
  backdrop = new THREE.Group();
  private zc = NaN;
  private open = new THREE.Group();
  /** largest distance from the eye a backdrop point may land at (camera far is 900 m) */
  static FAR = 840;
  constructor() {
    this.group.name = 'waterfront-far';
    this.backdrop.name = 'waterfront-backdrop';
    this.group.add(this.open, this.backdrop);
  }
  update(time: number, eye: THREE.Vector3) {
    U.time.value = time;
    U.night.value = getNight();
    const zc = Math.round(eye.z / SNAP) * SNAP;
    if (zc !== this.zc) {
      this.zc = zc;
      for (const grp of [this.open, this.backdrop])
        for (const c of [...grp.children]) {
          grp.remove(c);
          (c as THREE.Mesh).geometry?.dispose();
        }
      const z0 = zc - SPAN_Z, z1 = zc + SPAN_Z;
      // the Hudson from the bulkhead out, the East River from Manhattan's edge out (to the camera's far plane)
      this.open.add(waterRect(HUDSON_X, HUDSON_X + 1000, z0, z1));
      this.open.add(waterRect(EAST_X - 1000, EAST_X, z0, z1));
      const nj = new THREE.Mesh(shoreGeometry(HUDSON_X + HUDSON_W, 1, JERSEY, z0, z1, 1, true), shoreMat());
      const qn = new THREE.Mesh(shoreGeometry(EAST_X - EAST_W, -1, QUEENS, z0, z1, 2, false), shoreMat());
      for (const m of [nj, qn]) {
        m.castShadow = false;
        m.receiveShadow = false;
        m.frustumCulled = false;
        m.renderOrder = -1e5;
        m.name = 'far-shore';
        this.backdrop.add(m);
      }
    }
    // scale the backdrop about the eye so its farthest point lands inside the far plane
    const dx = Math.max(Math.abs(HUDSON_X + HUDSON_W + 900 - eye.x), Math.abs(EAST_X - EAST_W - 900 - eye.x));
    const reach = Math.hypot(dx, SPAN_Z + Math.abs(eye.z - this.zc));
    const k = Math.min(1, Waterfront.FAR / reach);
    this.backdrop.scale.setScalar(k);
    this.backdrop.position.copy(eye).multiplyScalar(1 - k);
    U.fogK.value = 0.3 / (k * k);
  }
}

// ---------------------------------------------------------------- the esplanade and pier kit (instanced)

const geoCache = new Map<string, THREE.BufferGeometry>();
function cg(k: string, make: () => THREE.BufferGeometry) {
  let g = geoCache.get(k);
  if (!g) geoCache.set(k, (g = make()));
  return g;
}
function merged(parts: THREE.BufferGeometry[]) {
  const pos: number[] = [], nor: number[] = [];
  for (const p0 of parts) {
    const p = p0.index ? p0.toNonIndexed() : p0;
    pos.push(...(p.getAttribute('position').array as Float32Array));
    nor.push(...(p.getAttribute('normal').array as Float32Array));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return g;
}
const bx = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const cy = (r0: number, r1: number, h: number, x: number, y: number, z: number, n = 8) => new THREE.CylinderGeometry(r0, r1, h, n).translate(x, y, z);

/** one 2.4 m panel of the Hudson River Park / Battery esplanade railing along +x: post, top rail, mid rail, pickets */
export const RAIL_PANEL = 2.4;
function railPanel() {
  return cg('rail', () => {
    const P: THREE.BufferGeometry[] = [bx(0.09, 1.12, 0.09, 0, 0.56, 0), cy(0.065, 0.065, 0.06, 0, 1.15, 0), bx(RAIL_PANEL, 0.05, 0.11, RAIL_PANEL / 2, 1.07, 0), bx(RAIL_PANEL, 0.04, 0.04, RAIL_PANEL / 2, 0.18, 0), bx(RAIL_PANEL, 0.03, 0.03, RAIL_PANEL / 2, 0.92, 0)];
    for (let u = 0.12; u < RAIL_PANEL - 0.05; u += 0.12) P.push(bx(0.018, 0.88, 0.018, u, 0.62, 0));
    return merged(P);
  });
}
const postGeo = () => cg('post', () => merged([bx(0.09, 1.12, 0.09, 0, 0.56, 0), cy(0.065, 0.065, 0.06, 0, 1.15, 0)]));
/**
 * one 2.4 m panel of the Hudson River Park railing (ref: Hudson_River_Park_td_(2018-04-03)_08): brushed steel, a
 * square tapered post, a round top rail and four wavy pipe rails between them
 */
function hrpPanel() {
  return cg('rail-hrp', () => {
    const P: THREE.BufferGeometry[] = [bx(0.13, 0.12, 0.13, 0, 0.06, 0), bx(0.09, 1.0, 0.09, 0, 0.62, 0), bx(0.12, 0.05, 0.12, 0, 1.12, 0)];
    const top = new THREE.CylinderGeometry(0.045, 0.045, RAIL_PANEL, 8).rotateZ(Math.PI / 2).translate(RAIL_PANEL / 2, 1.08, 0);
    P.push(top);
    for (let k = 0; k < 4; k++) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        pts.push(new THREE.Vector3(t * RAIL_PANEL, 0.3 + k * 0.19 + Math.sin(t * Math.PI * 2 + k * 0.9) * 0.06, Math.sin(t * Math.PI) * 0.05));
      }
      P.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.022, 5, false));
    }
    return merged(P);
  });
}
/** a cast-iron mooring bollard (0.55 m) and a deck cleat */
const bollardGeo = () => cg('bollard', () => merged([cy(0.2, 0.24, 0.1, 0, 0.05, 0, 12), cy(0.14, 0.16, 0.42, 0, 0.31, 0, 12), cy(0.22, 0.17, 0.1, 0, 0.56, 0, 12)]));
const cleatGeo = () => cg('cleat', () => merged([bx(0.12, 0.08, 0.14, 0, 0.04, 0), bx(0.5, 0.06, 0.08, 0, 0.11, 0)]));
/** a riprap boulder (0.6–1.4 m once scaled): a dented icosahedron */
const rockGeo = () => cg('rock', () => {
  const g = new THREE.IcosahedronGeometry(0.5, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const r = new Rng(5);
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * r.range(0.8, 1.15), p.getY(i) * r.range(0.6, 0.9), p.getZ(i) * r.range(0.8, 1.15));
  g.computeVertexNormals();
  return merged([g]);
});
const pileGeo = () => cg('pile', () => merged([cy(0.17, 0.2, 1, 0, 0.5, 0, 7)]));

const unitGeo = () => cg('unit', () => merged([bx(1, 1, 1, 0, 0, 0)]));
/** a clump of blades: three crossed, tapering cards (base at 0, 1 m tall) */
const tuftGeo = () => cg('tuft', () => {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) parts.push(new THREE.ConeGeometry(0.35, 1, 4, 1, true).translate(0, 0.5, 0).rotateY((i * Math.PI) / 3).scale(1, 1, 0.25));
  return merged(parts);
});
const kitMats = {
  steelHrp: () => (kitHrp ??= new THREE.MeshStandardMaterial({ color: '#a3a8ab', roughness: 0.35, metalness: 0.75 })),
  steel: () => (kitSteel ??= new THREE.MeshStandardMaterial({ color: '#3b4140', roughness: 0.6, metalness: 0.4 })),
  tuft: () => (kitTuft ??= new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, side: THREE.DoubleSide })),
  iron: () => (kitIron ??= new THREE.MeshStandardMaterial({ color: '#1d2420', roughness: 0.5, metalness: 0.55 })),
  timber: () => (kitTimber ??= new THREE.MeshStandardMaterial({ color: '#4a3b2c', roughness: 0.95 })),
  rock: () => (kitRock ??= new THREE.MeshStandardMaterial({ color: '#6f6b64', roughness: 0.95, flatShading: true })),
};
let kitHrp: THREE.MeshStandardMaterial | null = null;
let kitSteel: THREE.MeshStandardMaterial | null = null, kitTuft: THREE.MeshStandardMaterial | null = null;
let kitIron: THREE.MeshStandardMaterial | null = null, kitTimber: THREE.MeshStandardMaterial | null = null, kitRock: THREE.MeshStandardMaterial | null = null;

let foamM: THREE.MeshStandardMaterial | null = null;
/** foam lace where the water meets a wall or pile: an alpha strip, scrolling */
function foamMat() {
  if (foamM) return foamM;
  const t = FLAGS.notex ? null : canvasTex(256, 64, (g) => {
    const r = new Rng(9);
    g.clearRect(0, 0, 256, 64);
    for (let i = 0; i < 420; i++) {
      const y = Math.pow(r.next(), 1.8) * 64;
      g.fillStyle = `rgba(255,255,255,${(0.75 * (1 - y / 64)).toFixed(2)})`;
      g.beginPath();
      g.ellipse(r.range(0, 256), y, r.range(2, 10), r.range(1, 3), 0, 0, Math.PI * 2);
      g.fill();
    }
  }, true);
  foamM = new THREE.MeshStandardMaterial({ color: '#e8eeec', roughness: 0.7, transparent: true, opacity: t ? 0.85 : 0.35, alphaMap: t, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  foamM.name = 'foam';
  foamM.onBeforeCompile = (sh) => {
    sh.uniforms.uWT = U.time;
    sh.fragmentShader = 'uniform float uWT;\n' + sh.fragmentShader.replace('#include <alphamap_fragment>', `#ifdef USE_ALPHAMAP
      diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv + vec2( uWT * 0.02, sin( uWT * 0.7 + vAlphaMapUv.x * 3.0 ) * 0.04 ) ).g;
    #endif`);
    lightFog(sh, 0.4);
  };
  foamM.customProgramCacheKey = () => 'nbhd-foam';
  return foamM;
}

/** collects one chunk's waterfront parts; flush() adds one InstancedMesh per kind and one foam mesh */
export class WaterKit {
  private inst = new Map<string, { geo: () => THREE.BufferGeometry; mat: () => THREE.Material; m: THREE.Matrix4[]; shadow: boolean; c: THREE.Color[] }>();
  private foamPos: number[] = [];
  private foamUv: number[] = [];
  private q = new THREE.Quaternion();
  private add(k: string, geo: () => THREE.BufferGeometry, m: () => THREE.Material, x: number, y: number, z: number, ry = 0, s: [number, number, number] = [1, 1, 1], shadow = true, color?: string) {
    let e = this.inst.get(k);
    if (!e) this.inst.set(k, (e = { geo, mat: m, m: [], shadow, c: [] }));
    if (color) e.c.push(new THREE.Color(color));
    this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    e.m.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), this.q.clone(), new THREE.Vector3(...s)));
  }
  /** esplanade railing along axis ax at c, from a0 to a1, standing at y */
  rail(ax: 'x' | 'z', c: number, a0: number, a1: number, y = CURB, style: 'picket' | 'hrp' = 'picket') {
    const [k, geo, m] = style === 'hrp' ? ['rail-hrp', hrpPanel, kitMats.steelHrp] as const : ['rail', railPanel, kitMats.iron] as const;
    const n = Math.max(1, Math.round((a1 - a0) / RAIL_PANEL));
    const step = (a1 - a0) / n;
    for (let i = 0; i < n; i++) {
      const a = a0 + i * step;
      // panels run along +x; along z they turn by -90°
      if (ax === 'x') this.add(k, geo, m, a, y, c, 0, [step / RAIL_PANEL, 1, 1]);
      else this.add(k, geo, m, c, y, a, -Math.PI / 2, [step / RAIL_PANEL, 1, 1]);
    }
    // the closing post
    if (ax === 'x') this.add('post', postGeo, kitMats.iron, a1, y, c);
    else this.add('post', postGeo, kitMats.iron, c, y, a1);
  }
  /** a steel box (stiffeners, posts): base at y */
  post(x: number, y: number, z: number, w: number, h: number, d: number) {
    this.add('steel', unitGeo, kitMats.steel, x, y + h / 2, z, 0, [w, h, d], false);
  }
  /** a tuft of grass or a perennial clump, h tall */
  tuft(x: number, y: number, z: number, h: number, color: string) {
    this.add('tuft', tuftGeo, kitMats.tuft, x, y, z, x * 7.3 + z, [h * 0.7, h, h * 0.7], false, color);
  }
  bollard(x: number, y: number, z: number) {
    this.add('bollard', bollardGeo, kitMats.iron, x, y, z);
  }
  cleat(x: number, y: number, z: number, ry: number) {
    this.add('cleat', cleatGeo, kitMats.iron, x, y, z, ry, [1, 1, 1], false);
  }
  /** a timber pile from below the water up to `top` */
  pile(x: number, z: number, top: number, r = 1) {
    this.add('pile', pileGeo, kitMats.timber, x, WATER_Y - 1.5, z, 0, [r, top - WATER_Y + 1.5, r], false);
  }
  /** riprap toe along a wall (ax, at c, from a0 to a1), piled into the water on side s */
  riprap(ax: 'x' | 'z', c: number, a0: number, a1: number, s: number, seed: number) {
    const r = new Rng(seed);
    for (let a = a0; a < a1; a += r.range(0.6, 1.1))
      for (let k = 0; k < 2; k++) {
        const off = s * (0.4 + k * 0.9 + r.range(-0.2, 0.2));
        const sc = r.range(0.9, 1.5) * (k ? 0.85 : 1);
        const y = WATER_Y + (k ? -0.25 : 0.05) + r.range(-0.1, 0.1);
        const [x, z] = ax === 'x' ? [a, c + off] : [c + off, a];
        this.add('rock', rockGeo, kitMats.rock, x, y, z, r.range(0, 6.28), [sc, sc * r.range(0.7, 1), sc], false);
      }
  }
  /** a foam strip along a straight edge of water (from (x0,z0) to (x1,z1)), w wide, on side n of the line */
  foam(x0: number, z0: number, x1: number, z1: number, nx: number, nz: number, w = 1.3) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.5) return;
    const y = WATER_Y + 0.015;
    const a = [x0, y, z0], b = [x1, y, z1], c = [x1 + nx * w, y, z1 + nz * w], d = [x0 + nx * w, y, z0 + nz * w];
    for (const p of [a, b, c, a, c, d]) this.foamPos.push(...p);
    const u1 = len / 6;
    this.foamUv.push(0, 0, u1, 0, u1, 1, 0, 0, u1, 1, 0, 1);
  }
  flush(group: THREE.Object3D) {
    for (const [k, e] of this.inst) {
      const im = new THREE.InstancedMesh(e.geo(), e.mat(), e.m.length);
      e.m.forEach((m, i) => im.setMatrixAt(i, m));
      if (e.c.length === e.m.length) e.c.forEach((c, i) => im.setColorAt(i, c));
      im.castShadow = e.shadow;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      im.name = `waterfront-${k}`;
      group.add(im);
    }
    if (this.foamPos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.foamPos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.foamUv, 2));
      g.computeVertexNormals();
      // the strips' winding varies: always face up
      const n = g.getAttribute('normal') as THREE.BufferAttribute;
      for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
      const mesh = new THREE.Mesh(g, foamMat());
      (mesh.material as THREE.Material).side = THREE.DoubleSide;
      mesh.renderOrder = 1;
      mesh.name = 'waterfront-foam';
      group.add(mesh);
    }
  }
  /** counts for qa */
  count(k: string) {
    return this.inst.get(k)?.m.length ?? 0;
  }
}

// ---------------------------------------------------------------- surfaces

let plankM: THREE.MeshStandardMaterial | null = null;
/** weathered timber pier decking: 15 cm boards running across the pier (texture: 4 m, boards along v) */
export function plankMat() {
  if (plankM) return plankM;
  const t = canvasTex(256, 256, (g) => {
    const r = new Rng(21);
    g.fillStyle = '#3a3026';
    g.fillRect(0, 0, 256, 256);
    const bw = 256 / 26;
    for (let i = 0; i < 26; i++) {
      const v = r.int(-16, 16);
      g.fillStyle = `rgb(${124 + v},${106 + v},${86 + v})`;
      g.fillRect(i * bw + 1.2, 0, bw - 2, 256);
      // butt joints, grain
      g.fillStyle = 'rgba(40,32,24,0.7)';
      g.fillRect(i * bw, r.range(0, 256), bw, 1.5);
      g.fillStyle = 'rgba(40,32,24,0.22)';
      for (let k = 0; k < 6; k++) g.fillRect(i * bw + r.range(1, bw - 1), r.range(0, 256), 0.7, r.range(10, 60));
    }
  }, true);
  plankM = new THREE.MeshStandardMaterial({ map: t, roughness: 0.92 });
  plankM.name = 'pier-planks';
  return plankM;
}
/** a deck rect with world-metre UVs, the texture tiling every 4 m */
export function deckRect(m: THREE.Material, x0: number, x1: number, z0: number, z1: number, y: number) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute, uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 4, -p.getZ(i) / 4);
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  mesh.userData.owned = true;
  return mesh;
}

let bikeM: THREE.MeshStandardMaterial | null = null;
/** the Hudson River Park bikeway: green-grey asphalt, double yellow centre line, white edge lines, bike symbols */
export function bikewayMat() {
  if (bikeM) return bikeM;
  const t = canvasTex(256, 1024, (g) => {
    const r = new Rng(31);
    g.fillStyle = '#56685c';
    g.fillRect(0, 0, 256, 1024);
    for (let i = 0; i < 2500; i++) {
      const v = r.int(60, 110);
      g.fillStyle = `rgba(${v},${v + 8},${v},0.35)`;
      g.fillRect(r.range(0, 256), r.range(0, 1024), 2, 2);
    }
    g.fillStyle = '#e8e4d6';
    g.fillRect(10, 0, 6, 1024);
    g.fillRect(240, 0, 6, 1024);
    g.fillStyle = '#e2b52a';
    for (let y = 0; y < 1024; y += 128) { g.fillRect(122, y, 4, 64); g.fillRect(130, y, 4, 64); }
    // bike symbols and arrows, one each way
    g.strokeStyle = '#e8e4d6';
    g.lineWidth = 5;
    for (const [cx, cy0, dir] of [[64, 300, -1], [192, 800, 1]] as [number, number, number][]) {
      for (const dy of [-26, 26]) { g.beginPath(); g.arc(cx, cy0 + dy, 18, 0, Math.PI * 2); g.stroke(); }
      g.beginPath(); g.moveTo(cx, cy0 - 26); g.lineTo(cx - 14, cy0 + 4); g.lineTo(cx, cy0 + 26); g.stroke();
      g.beginPath(); g.moveTo(cx - 10, cy0 + dir * 90); g.lineTo(cx, cy0 + dir * 110); g.lineTo(cx + 10, cy0 + dir * 90); g.moveTo(cx, cy0 + dir * 110); g.lineTo(cx, cy0 + dir * 60); g.stroke();
    }
  }, true);
  bikeM = new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 });
  bikeM.name = 'bikeway';
  return bikeM;
}
/** a strip along z (x0..x1 across, z0..z1 along) with the texture's width across it and `along` m per repeat */
export function stripZ(m: THREE.Material, x0: number, x1: number, z0: number, z1: number, y: number, along: number, flip = false) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute, uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const u = (p.getX(i) - x0) / (x1 - x0);
    uv.setXY(i, flip ? 1 - u : u, -p.getZ(i) / along);
  }
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  mesh.userData.owned = true;
  return mesh;
}

/** a granite bulkhead box (ashlar canvas tinted grey) with metre UVs */
export function graniteBox(w: number, h: number, d: number, x: number, y: number, z: number, tint = '#bdb8ae') {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++)
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / 12, (uv.getY(i) * dims[f][1]) / 12.8);
    }
  const o = new THREE.Mesh(g, brownstoneMat());
  o.position.set(x, y, z);
  o.userData.tint = tint;
  o.userData.owned = true;
  o.receiveShadow = true;
  return o;
}
